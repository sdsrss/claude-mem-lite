// claude-mem-lite: Cross-session handoff extraction, detection, and injection
// Extracted for testability — hook.mjs has module-level side effects

import { basename } from 'path';
import {
  truncate,
  normalizeInline,
  extractMatchKeywords,
  tokenizeHandoff,
  isSpecificTerm,
  scrubSecrets,
  LOW_SIGNAL_TITLE,
  EDIT_TOOLS,
  isMetaTriggerPrompt,
  notLowSignalTitleClause,
  safeText,
} from './utils.mjs';
import { scrubRecord, scrubFilePath, scrubFilePaths } from './lib/scrub-record.mjs';
import {
  HANDOFF_EXPIRY_CLEAR,
  HANDOFF_EXPIRY_EXIT,
  HANDOFF_ANCHOR_MAX_AGE,
  HANDOFF_MATCH_THRESHOLD,
  CONTINUE_KEYWORDS,
  UNCONSUMED_HANDOFF_SQL,
} from './hook-shared.mjs';
// T10d: import the whole module (not a named export) so tests can spy on
// gitStateModule.readGitState via vi.spyOn. Named-import bindings are
// immutable in ESM and cannot be mocked after the fact.
import * as gitStateModule from './lib/git-state.mjs';
import * as taskReaderModule from './lib/task-reader.mjs';
// Namespace import for the same reason as the two above: ESM named bindings are immutable,
// so a named import could not be spied on in tests.
import * as pausedReaderModule from './lib/paused-reader.mjs';
import { liveObsFilterSql } from './lib/inject-search-core.mjs';

/**
 * Build and save a handoff snapshot to session_handoffs table.
 * Called synchronously during handleStop (/exit) or handleSessionStart (/clear).
 *
 * Dual id: `sessionId` is the mem-internal id that user_prompts / observations
 * were written with (handleUserPrompt uses getSessionId()) — it drives all
 * DB lookups. `scopeSessionId` is the CC UUID from hook stdin used to scope
 * the stored row so parallel CC sessions don't clobber each other. When
 * `scopeSessionId` is null/undefined, `sessionId` is used for both (legacy).
 *
 * @param {Database} db Opened main database
 * @param {string} sessionId Mem-internal session id (query key)
 * @param {string} project Project identifier
 * @param {'clear'|'exit'} type Handoff type
 * @param {object|null} episodeSnapshot Episode buffer captured before flushing
 * @param {string|null} [scopeSessionId=null] CC UUID for session_handoffs.session_id column
 */
export function buildAndSaveHandoff(db, sessionId, project, type, episodeSnapshot, scopeSessionId = null) {
  // 1. Working objective — from user prompts.
  // D#26: getSessionId() is project-scoped, so multiple CC sessions in one project
  // share `content_session_id`. When a genuine CC scope is passed (scopeSessionId is
  // the CC UUID, i.e. differs from the mem-internal sessionId), filter to THIS CC
  // session's prompts so working_on doesn't merge concurrent/sequential sessions.
  // `OR cc_session_id IS NULL` keeps legacy rows + non-CC/no-stdin invocations. When
  // scopeSessionId is absent or == sessionId (legacy/test/no-stdin), fall back to the
  // unfiltered query (identical to pre-D#26 behavior).
  const ccScope = scopeSessionId && scopeSessionId !== sessionId ? scopeSessionId : null;
  const unscopedPrompts = () =>
    db
      .prepare(
        `
        SELECT prompt_text FROM user_prompts
        WHERE content_session_id = ?
        ORDER BY prompt_number ASC LIMIT 5
      `,
      )
      .all(sessionId);
  let prompts = ccScope
    ? db
        .prepare(
          `
        SELECT prompt_text FROM user_prompts
        WHERE content_session_id = ? AND (cc_session_id = ? OR cc_session_id IS NULL)
        ORDER BY prompt_number ASC LIMIT 5
      `,
        )
        .all(sessionId, ccScope)
    : unscopedPrompts();
  // R10-P1-1: on the /clear path the scope is the NEW session's CC id while the prompts
  // being handed off belong to the OLD one, and the host rotates that id across /clear
  // (measured 12/12 on real transcripts, 2026-09-07) — so the scoped query returns 0 and
  // the whole handoff was silently skipped. Fall back to the unscoped set when, and only
  // when, the scoped one is EMPTY: D#26 exists to stop two live sessions being MERGED into
  // one working_on, and there is nothing to merge with when this session contributed no
  // prompts. The alternative at that point is not a cleaner row, it is no row at all.
  if (ccScope && prompts.length === 0) prompts = unscopedPrompts();
  if (prompts.length === 0) return; // Empty session — nothing to hand off

  // Filter prompts whose only content is workflow/control language ("继续",
  // "提交代码", "/exit", etc.). Storing them verbatim into working_on creates
  // self-referential handoffs ("Working On: 继续前面的工作") that point at the
  // trigger instead of the subject. When ALL prompts are meta, fall back to
  // the project's most recent importance≥3 non-low-signal observation as the
  // carry-forward anchor — that's the closest durable signal of "what was
  // being worked on at a higher level than this session".
  const subjectPrompts = prompts.filter((p) => !isMetaTriggerPrompt(p.prompt_text));
  const sourcePrompts = subjectPrompts.length > 0 ? subjectPrompts : prompts;

  // Scrub BEFORE truncate. A secret straddling the 200-char cut is shortened below the
  // length floor its own pattern requires, stops matching entirely, and the retained head is
  // then stored verbatim — the exact failure the persistence-boundary comment below
  // prescribes against, in the three call sites that sit above it.
  //
  // Measured 2026-09-22 on this machine, one fixture set for every number below (the first
  // draft used two probes with two different `xoxb-` tokens, so its denominator and its
  // table described different fixtures): five credential families, the cut walked through
  // the token one character at a time, 244 cut points. Under truncate-then-scrub **38** cut
  // points leak ≥12 characters (33 leak ≥13); under this order, 0. FIXED-LENGTH families are
  // the worst case, because a short read matches nothing at all rather than matching less —
  // longest head the old order still stored, minus the prefix:
  //
  //   ghp_ + 36          29 of 36 entropy chars
  //   AKIA + 16          15 of 16
  //   xoxb- (12-12-24)    9 of 50
  //   password= + 32      4 of 32   (the appended `…` counts toward the `{6,}` value class)
  //   sk-ant-api03- + 80  1 of 80   (the `ant` alternation lets `api03-AA` satisfy `{8,}`)
  //
  // The variable-length row is the contrast case and it is 1, not 0. The destination is not
  // a log line: this column is persisted and replayed into a later session's prompt by both
  // renderers.
  //
  // `working_on` is consequently the one column scrubbed TWICE — here, and again at the
  // persistence boundary via scrubRecord, which stays as-is because `completed` and
  // `unfinished` do NOT come from prompts: `completed` is a stored-row query (:218), and
  // `unfinished` is the in-memory episode snapshot or the on-disk task list under
  // `~/.claude/tasks/`, with observation narrative appended (:246-:289). An earlier draft of
  // this sentence said both "reach that call from STORED ROWS", which is the load-bearing
  // half of why those two columns were left alone, and it was wrong about `unfinished`.
  // scrubSecrets is a fixpoint on its own output for every family that reaches this path;
  // that property is pinned in tests/handoff-working-on-scrub-order.test.mjs rather than
  // assumed here, since D#46 is open on idempotence by CONTRACT.
  // `normalizeInline` FIRST, and it is not cosmetic. `truncate` used to run before
  // `scrubSecrets` and collapsed newlines on the way; moving the scrub earlier handed it raw
  // newlines, which flips every line-start credential noun from the scrubber's prose arm to
  // its config arm and irreversibly redacts ordinary English. That corruption is recorded at
  // secret-scrub.mjs:45-57 as one a prior pre-tag review already undone once. See
  // normalizeInline's own docblock for the measured grid. The scrubber now sees exactly the
  // one-line shape it saw before the reorder; only the LENGTH cut moved.
  //
  // Dedup keys on the SCRUBBED line, deliberately, and this is a behaviour change from the
  // pre-reorder code: two prompts differing only in their credential both render as
  // `deploy with key ***`, and keying on the raw text would replay that identical sentence
  // twice. The key is what the resuming session is actually shown. Pinned by a case.
  const seen = new Set();
  const safePromptLines = [];
  for (const p of sourcePrompts) {
    const line = truncate(scrubSecrets(normalizeInline(p.prompt_text)), 200);
    if (seen.has(line)) continue;
    seen.add(line);
    safePromptLines.push(line);
  }
  let workingOn = safePromptLines.join(' → ');

  if (subjectPrompts.length === 0) {
    const fallback = db
      .prepare(
        `
      SELECT title FROM observations
      WHERE project = ? AND ${liveObsFilterSql('')}
        AND COALESCE(importance, 1) >= 3
        AND ${notLowSignalTitleClause('')}
      ORDER BY created_at_epoch DESC, id DESC LIMIT 1
    `,
      )
      .get(project);
    if (fallback?.title) {
      // Same order as the prompt arm above. Titles are scrubbed on write TODAY, so this is
      // defense-in-depth for rows that predate that — which is not hypothetical: D#49 still
      // has three bare credential-shaped values backfilled in a sibling column.
      workingOn = `(carry-forward subject) ${truncate(scrubSecrets(normalizeInline(fallback.title)), 180)}`;
    }
  }

  // D#28 (completes D#26): observations carry the project-scoped memory_session_id, shared by
  // parallel/sequential same-project CC sessions. Lower-bound the observation queries below to
  // THIS CC session's start (earliest prompt epoch for ccScope) so Completed / Key Files / Key
  // Decisions stop merging a prior session's work — the observation-side complement of
  // working_on's cc-scoping. When ccScope is absent or its session has no prompts (MIN→null),
  // ccWindowStart stays null and the queries run unscoped (pre-D#28 behavior). Residual: truly
  // concurrent same-project sessions whose windows overlap can still co-attribute a few rows.
  let ccWindowStart = null;
  if (ccScope) {
    const w = db
      .prepare(
        `
      SELECT MIN(created_at_epoch) AS startEpoch FROM user_prompts
      WHERE content_session_id = ? AND cc_session_id = ?
    `,
      )
      .get(sessionId, ccScope);
    if (typeof w?.startEpoch === 'number') ccWindowStart = w.startEpoch;
  }
  // Fall back to THIS MEM SESSION's own start when the CC window is unavailable, rather
  // than running unbounded.
  //
  // `ccWindowStart` is null by construction on the /clear path: the host rotates the CC id
  // across /clear (measured 12/12, see the note above), so the scope passed here belongs to
  // the NEW session and has no prompts, and MIN over zero rows is null. Before the
  // namespace widening the id predicate still bounded the pool to one session; after it,
  // `OR project = ?` with no window pulled the project's entire recent history — a
  // month-old decision from a different session was reported as this one's Completed AND
  // replayed as standing Key Decisions. Found by the pre-ship defect lens, reproduced
  // end-to-end, and invisible to the suite because every control case passed an
  // `exit`-shaped scope that HAS prompts.
  if (ccWindowStart === null) {
    const w = db
      .prepare(`SELECT MIN(created_at_epoch) AS startEpoch FROM user_prompts WHERE content_session_id = ?`)
      .get(sessionId);
    if (typeof w?.startEpoch === 'number') ccWindowStart = w.startEpoch;
  }
  const obsWindowClause = ccWindowStart !== null ? 'AND created_at_epoch >= ?' : '';
  const obsWindowParams = ccWindowStart !== null ? [ccWindowStart] : [];

  // 2. Completed — from observations (include narrative for richer handoff)
  //
  // `compressed_into` ONLY, deliberately — not a half-written liveObsFilterSql. Audit
  // 2026-08-14 F4 ruled on exactly this line: `completed` is the session's own history, and a
  // decision a later save overturned still happened, so erasing it here would misreport the
  // session. Only key_decisions (:242) is re-presented to a LATER session as standing policy,
  // and that one does filter superseded_at. The scope guard is the third case of "F4 — handoff
  // key_decisions excludes a retracted decision" in tests/audit-silent-20260814.test.mjs.
  // Audit R8 §11.3 proposed adding the filter here from a repo-wide regex sweep of the
  // predicate shape; it was rejected on this reasoning, and the guard catches it.
  // `(memory_session_id = ? OR project = ?)`, not the bare id equality this shipped with.
  // The id side alone is unreachable for the rows that matter: the hook mints
  // `hook-<project>-<uuid8>` (hook-shared.mjs) and hands it here, while every explicit
  // mem_save writes `manual-<project>` (lib/save-observation.mjs). Disjoint prefixes, so
  // the join could not match a saved lesson at all. Measured on the live DB 2026-09-21:
  // 101 of 105 observations sat in the `manual-` namespace and all 17 stored handoff rows
  // carried `completed` = 0 bytes.
  //
  // The widening does NOT give back what D#28 bought: isolation is the TIME WINDOW's job
  // (`obsWindowClause`, lower-bounded at this CC session's first prompt), and it still
  // excludes a prior session's rows — pinned by the control case in
  // tests/handoff-payload-reach.test.mjs. The id side is kept as an OR so every row that
  // matched before still matches (project names have been renormalized before, see the
  // `normalize-project-names` migration in schema.mjs, and a row can carry the old name).
  // The earlier citation here and in the commit body pointed at schema.mjs:1127, which is
  // inside the observation_files backfill — the right fact, the wrong line.
  const completed = db
    .prepare(
      `
    SELECT title, type, narrative FROM observations
    WHERE (memory_session_id = ? OR project = ?) AND COALESCE(compressed_into, 0) = 0 ${obsWindowClause}
    ORDER BY created_at_epoch DESC, id DESC LIMIT 15
  `,
    )
    .all(sessionId, project, ...obsWindowParams);

  // 3. Recent activity — episode snapshot + full session edit history from narratives.
  // Keep only entries that represent in-flight work (file edits) or outright failures
  // (errors). Successful Bash commands flag isSignificant=true via bash-utils when they
  // match git/test/build/deploy patterns, but a succeeded `git push` is COMPLETED, not
  // pending — including it surfaced release-pipeline commands as "Unfinished" on resume.
  let unfinished = '';
  if (episodeSnapshot?.entries) {
    const seenDescs = new Set();
    const pendingDescs = episodeSnapshot.entries
      .filter((e) => e.isError || EDIT_TOOLS.has(e.tool))
      .map((e) => e.desc)
      .filter((d) => {
        if (seenDescs.has(d)) return false;
        seenDescs.add(d);
        return true;
      });
    if (pendingDescs.length > 0) unfinished = pendingDescs.join('; ');
  }

  // T10d: TaskList-sourced Unfinished. When no episode pending entries exist,
  // prefer the structured signal from ~/.claude/tasks/<list>/*.json over the
  // narrative-only fallback — a user-maintained task list is a stronger signal
  // than a session with no recent tool activity. When the episode already has
  // pending entries, those stay (they're fresher than the task file).
  if (!unfinished) {
    try {
      const tasks = taskReaderModule.readProjectTasks({ projectPath: process.cwd() });
      if (tasks.length > 0) {
        // Join with the ENTRY separator ('; '), NOT '\n': extractUnfinishedSummary
        // and renderHandoffFromRow split pending work on UNFINISHED_ENTRY_SEP, so a
        // '\n'-join collapsed the whole task list into one unreadable multi-line bullet.
        unfinished = tasks
          .slice(0, 5)
          .map((t) => `[${t.status}] ${t.title}`)
          .join(UNFINISHED_ENTRY_SEP);
      }
    } catch {
      /* task reader is best-effort; never block handoff */
    }
  }

  // Enrich unfinished with full session edit history from observation narratives.
  // Since handoff is UPSERT (max 2 rows per project), storing more data is free.
  // Always use \n---\n separator so extractUnfinishedSummary can distinguish
  // pending work (before separator) from narrative history (after separator).
  const narratives = completed.filter((c) => c.narrative).map((c) => c.narrative);
  if (narratives.length > 0) {
    const editHistory = narratives.join('\n');
    unfinished += '\n---\n' + editHistory;
  }

  // 4. Key files — from episode snapshot + observations
  const fileSet = new Set();
  // Ask the BASENAME for an extension, rather than asking the string for a separator.
  // The separator test answered "does this look like a path", which is a different
  // question and got both halves wrong.
  //
  // key_files is built from TWO sources — the episode buffer on disk (`episodeSnapshot
  // .files`) and `observations.files_modified` — and the measurement covered only the
  // second, so quote it for only that half: over all 218 non-null files_modified entries
  // on the live DB 2026-09-21, 59 (27%) were repo-root filenames like `hook.mjs`, rejected
  // for having no `/`. That is the dropped-file half, and it reproduces.
  //
  // The directory half comes from the EPISODE BUFFER, which that measurement never read:
  // `~/.claude-mem-lite/runtime/ep-<project>.json` carries entries like
  // `/home/ai/dev/loop-testing`, byte-for-byte the key_files of the matching handoff row.
  // `Key Files: claude-mem-lite` in a real injection came from there, NOT from
  // files_modified — no entry in that column equals a project directory. The three
  // extensionless slash-bearing values it does hold are one executable
  // (`claude-plugin/bin/code-graph-mcp`) and two `/var/tmp` scratch dirs, and the
  // executable is an instance of the named cost below rather than evidence for this
  // defect. Corrected by the pre-ship claims lens; the fix is unaffected because
  // isValidFile gates both sources.
  //
  // Named cost, and it is wider than "Makefile, LICENSE" — the pre-ship review diffed old
  // against new over a plausible path set and the drop list is two classes: (a) every
  // extensionless file, which includes the ones under `bin/` and `scripts/` that are
  // executables rather than docs (this repo tracks `.githooks/pre-commit`), and (b) any
  // extension longer than 10 characters, so `.env` qualifies but `.editorconfig` does not.
  // The alternative to the whole rule is a hand-drawn list of extensionless filenames. The
  // alternative is a hand-drawn list of extensionless filenames, and a hand-drawn class is
  // the shape that has been rejected three times in this repo for rejecting real cases.
  // Residual, equally named: a directory that happens to end in `.something` still passes.
  // The dot may lead the basename, so `.env` and `.env.example` qualify.
  const FILE_BASENAME_RE = /\.[A-Za-z0-9_+-]{1,10}$/;
  const isValidFile = (f) =>
    f &&
    f.length > 2 &&
    FILE_BASENAME_RE.test(basename(f)) &&
    !f.startsWith('/dev/') &&
    !f.startsWith('/proc/') &&
    !f.startsWith('/tmp/');
  if (episodeSnapshot?.files) episodeSnapshot.files.filter(isValidFile).forEach((f) => fileSet.add(f));
  // Same namespace widening as `completed` above — see the reasoning there. Measured
  // 2026-09-21: 8 of the 17 live handoff rows stored key_files as the empty array.
  //
  // The cap counts rows that CONTRIBUTE a new file (D#67, the D#40 shape). This read was
  // `LIMIT 10` → isValidFile, so rows the filter empties ('[]', directories, /tmp paths)
  // could use up the window. A latent defect: the v6.13.2 pre-ship claims review replayed
  // the live DB 2026-09-26 with this read's own WHERE and window, and 0 of 45 stored
  // handoffs and 0 of 310 sessions lost a file (the largest window held 11 rows).
  // Streaming keeps the filter exactly as it was.
  let contributing = 0;
  for (const row of db
    .prepare(
      `
    SELECT files_modified FROM observations
    WHERE (memory_session_id = ? OR project = ?) AND files_modified IS NOT NULL ${obsWindowClause}
    ORDER BY created_at_epoch DESC, id DESC
  `,
    )
    .iterate(sessionId, project, ...obsWindowParams)) {
    let files;
    try {
      files = JSON.parse(row.files_modified);
    } catch {
      continue;
    }
    const valid = Array.isArray(files) ? files.filter(isValidFile) : [];
    const before = fileSet.size;
    valid.forEach((f) => fileSet.add(f));
    // A row that only repeats a listed file (the common case: one file edited again and
    // again) contributes nothing either (v6.13.2 pre-ship defect review P3-7).
    if (fileSet.size === before) continue;
    if (++contributing === 10) break;
  }

  // 5. Key decisions — high importance observations (skip low-signal degraded titles).
  //
  // superseded_at IS NULL, unlike `completed` and `files_modified` above: those two are
  // the session's own history ("what happened here"), where an overturned decision still
  // happened and erasing it would misreport the session. key_decisions is different — it
  // is replayed to the NEXT session under "## Key Decisions" as standing policy, so a
  // retracted decision rendered there is indistinguishable from live policy. The
  // carry-forward fallback at the top of this function already filters the same column;
  // this is the sibling that did not.
  // Same namespace widening as `completed` above — see the reasoning there. This is the
  // field the widening exists for: a `decision` / `bugfix` lesson is written by mem_save,
  // which is exactly the namespace the id equality could not reach, and all 17 live rows
  // carried key_decisions = 0 bytes. The liveness predicate stays the FULL one (this field
  // is replayed to a later session as standing policy — see the note above).
  // `type` alongside the title: the render drops the duplicate copy of each decision from
  // `## Completed`, so this section is the only place those entries still appear and it has
  // to carry the `[bugfix]` / `[decision]` tag that Completed was providing. The only
  // production reader of session_handoffs.key_decisions is this file's own renderer
  // (session_summaries.key_decisions is a different column, a JSON array from Haiku), and
  // every existing assertion on it is a substring/regex match on the title, so the added
  // prefix is not a contract change for them.
  //
  // The cap applies AFTER the low-signal filter (D#40). This read was `LIMIT 10` → filter →
  // slice(0, 5), which made the SQL limit a reachability bound: six low-signal rows among the
  // newest ten evicted older real decisions the section had room for, and two writers raise
  // importance without reading the title, so such rows do reach this pool. Streaming and
  // stopping at five keeps the JS filter exactly as it was (the SQL NOT LIKE twin is
  // case-insensitive, so swapping it in would also change WHICH titles count as noise).
  const decisions = [];
  for (const d of db
    .prepare(
      `
    SELECT title, type FROM observations
    WHERE (memory_session_id = ? OR project = ?) AND COALESCE(importance, 1) >= 2
      AND ${liveObsFilterSql('')} ${obsWindowClause}
    ORDER BY created_at_epoch DESC, id DESC
  `,
    )
    .iterate(sessionId, project, ...obsWindowParams)) {
    if (!d.title || LOW_SIGNAL_TITLE.test(d.title)) continue;
    decisions.push(d);
    if (decisions.length === 5) break;
  }

  // 5b. Next steps — the remaining work a paused note spells out, which is the only
  // next-step source in this system that a human wrote down on purpose. Deliberately not
  // folded into `unfinished`: that field renders as "Recent activity" and mixes in-flight
  // edits with surfaced errors, so a hand-written remaining-work list would be mislabelled.
  //
  // Deliberately NOT sourced from deferred_work, even though it is the other project-scoped
  // durable queue: those rows are already delivered at SessionStart by the `### Deferred
  // Work` block in hook-context.mjs, inside `<claude-mem-context>` — NOT by
  // lib/startup-dashboard.mjs, which contains no reference to the table (the claims lens
  // corrected that attribution). It renders the top 5 open rows by priority, so "already
  // delivered" is true of the head of the queue rather than all of it; 12 were open on
  // 2026-09-21. Adding them here would double-inject that head. Nothing delivers the
  // paused note.
  let nextSteps = null;
  try {
    // No explicit projectPath: the reader defaults to cwd, and neutralises that default
    // under the test guard so no suite writes this repo's own paused note into its rows.
    const note = pausedReaderModule.readPausedNote();
    if (note) {
      // Scrub per ELEMENT before stringify, never the JSON string — letting scrubSecrets
      // rewrite the serialized form risks breaking the downstream JSON.parse. Same rule
      // key_files follows below.
      nextSteps = JSON.stringify({
        // scrubFilePath, not scrubSecrets: this field is a filesystem PATH, and many of
        // the secret patterns carry a value class that does not exclude `/` (count and
        // population: lib/scrub-record.mjs), so a whole-path scrub eats the separator and
        // destroys the filename. That is the named
        // mechanism this repo grew for exactly this shape; the prose fields below are prose
        // and correctly take the plain scrub.
        file: scrubFilePath(String(note.file)),
        title: scrubSecrets(String(note.title)),
        items: note.items.map((i) => scrubSecrets(String(i))),
      });
    }
  } catch {
    /* best-effort, like the task reader above — never block the handoff */
  }

  // 6. Match keywords.
  //
  // Scrubbed at the DERIVATION, and the scrubbed file array is derived ONCE and feeds both
  // sinks (here and key_files below) — the shape hook-llm.mjs uses where one path array
  // reaches two columns. lib/scrub-record.mjs excludes match_keywords from scrubRecord, and
  // the reason it recorded — "built from tokenizeHandoff() output (alphanumeric tokens
  // only), so secrets cannot survive the upstream tokenizer" — does not hold on either arm:
  // the FILE arm never reaches the tokenizer (it takes basename-minus-extension straight off
  // this set, which holds RAW paths), and the tokenizer SPLITS a secret from its keyword
  // rather than removing it, so `token=ghp_…` contributes `ghp_…` as a term of its own.
  //
  // Exposure, measured rather than asserted: nothing renders this column and no export face
  // reads the table — `EXPORT_COLUMNS` is observations-only and `session_handoffs` has zero
  // occurrences in server.mjs and the CLI. So this is local-DB-at-rest, with no egress path.
  // A credential in a stored column is still worth removing; it is not a disclosure. (The
  // sentence this replaces claimed egress through `export` and was false — a replacement
  // justification written while retracting another one, unverified, which is this repo's
  // signature recurrence. Pre-ship claims lens.)
  //
  // Per ELEMENT, then join — never scrub the concatenation. A credential noun ending one
  // element and a `=`/`:` opening the next form a match that exists in NEITHER, and the
  // derived term set then loses a word both columns keep (measured: `zebrafish`). Same rule
  // next_steps and key_files already follow, and the same rule the truncation note below
  // states. NOT identity on ordinary prose, which an earlier draft of this comment claimed:
  // `api_key: handling` loses `handling` (5 of 6 ordinary developer prompts in a directed
  // grid lose exactly one term). What is true, and is the actual justification, is that the
  // term set now AGREES with what the resuming session is shown — `working_on` / `completed`
  // / `unfinished` lose the same word through scrubRecord below.
  //
  // SUPERSEDED 2026-09-21, and the correction is load-bearing rather than cosmetic. This
  // block used to end "No value is scrubbed twice: these elements and the columns below are
  // separate derivations from one raw source, each scrubbed once, which is the distinction
  // D#46 is open about." That still holds for `completed` and `unfinished`. It is now FALSE
  // for `workingOn`, which arrives here ALREADY scrubbed, because the prompt arm above had
  // to scrub before truncating to stop a boundary-straddling secret from being stored as a
  // verbatim head.
  //
  // The chain depth is TWO, on each of the two derivations, and it is worth spelling out
  // because a draft of this block said "twice on this derivation and a third time through
  // scrubRecord" — which counts one value as three and no value is:
  //   match_keywords : prompt arm -> the `allText` map below            = 2
  //   working_on     : prompt arm -> scrubRecord at the INSERT          = 2
  // Idempotence is therefore a property this file now DEPENDS on rather than merely
  // tolerates — measured and pinned in tests/handoff-working-on-scrub-order.test.mjs, not
  // asserted here. D#46 stays open on idempotence by CONTRACT; what is closed is
  // idempotence for the eleven families that test pins.
  const safeFiles = scrubFilePaths([...fileSet]);
  // The nullish guard mirrors what join() already did with a nullish element. Without it
  // String(undefined) would put the literal token "undefined" into the term set — a behaviour
  // change smuggled in by the per-element rewrite rather than chosen.
  const allText = [workingOn, ...completed.map((c) => c.title).filter(Boolean), unfinished]
    .map((t) => (t === null || t === undefined ? '' : scrubSecrets(String(t))))
    .join(' ');
  const keywords = extractMatchKeywords(allText, safeFiles);

  // T10d: capture HEAD sha so detectContinuationIntent can anchor on it later.
  // Best-effort — failures (non-git dir, missing binary, timeout) yield null.
  let gitShaAtHandoff = null;
  let gitBranch = null;
  let gitDirtyCount = null;
  try {
    const st = gitStateModule.readGitState({ cwd: process.cwd() });
    gitShaAtHandoff = st.headSha || null;
    gitBranch = st.branch || null;
    // 0 and NULL are different answers here: "measured, and the tree is clean" versus "no
    // measurement happened". readGitState returns an empty `changed` for BOTH a clean repo
    // and a directory that is not a repo at all, so the sha/branch decide which one it was.
    // Collapsing them would let a handoff written outside a repo claim a clean tree.
    gitDirtyCount = st.headSha || st.branch ? st.changed.length : null;
  } catch {
    /* swallow — handoff must still persist */
  }

  // UPSERT keyed on (project, type, session_id) — parallel sessions coexist.
  // Same session re-writing its own handoff (e.g. repeated /clear) updates in place.
  // `scopeSessionId` (CC UUID) tags the row for parallel scoping; falls back to
  // the mem-internal `sessionId` when the caller didn't supply one (tests + legacy).
  const storedSessionId = scopeSessionId || sessionId;
  // Defense-in-depth: aggregates are built from already-stored rows + raw
  // session memory; scrub at the persistence boundary regardless of source.
  // Order matters: scrub raw values BEFORE truncation, so a secret straddling
  // the truncation boundary doesn't fall below scrubSecrets's regex length
  // floors. JSON-stringified fields (key_files) are pre-scrubbed at the
  // element level before stringify — letting scrubSecrets rewrite the JSON
  // string would risk breaking downstream JSON.parse.
  const safe = scrubRecord('session_handoffs', {
    working_on: workingOn,
    completed: completed.map((c) => `[${c.type}] ${c.title}`).join('\n'),
    unfinished,
    key_decisions: decisions.map((d) => `[${d.type}] ${d.title}`).join('\n'),
    match_keywords: keywords,
  });
  // scrubFilePath, not scrubSecrets — the same correction next_steps.file took above, and
  // key_files was the last of the six path columns still taking the whole-string form. It
  // was already element-wise, which is what made it look compliant with this module's
  // prescription; the function was the wrong one. Many SECRET_PATTERNS have a value class
  // that does not exclude `/` (count and population: lib/scrub-record.mjs), so a whole-path
  // match eats the separator and the filename
  // with it, and the renderer below emits `basename(f)` — `## Key Files` read `password=***`
  // where the file was `notes.mjs`. Worse than a wrong name: fileSet is keyed on the RAW
  // path, so two files under one credential-bearing directory survive dedup and then
  // collapse onto the identical stored string.
  // `safeFiles` was derived at the keywords block above, so both sinks see one scrubbed
  // array rather than two independent scrubs of the same paths. Slicing after the map is
  // equivalent to mapping after the slice (per-element, order-preserving) and keeps the
  // keyword arm on the FULL set, which is what it read before.
  const safeKeyFiles = JSON.stringify(safeFiles.slice(0, 20));
  // The UPSERT below resets `consumed_at`. Rewriting a handoff makes it fresh again, so it
  // must become injectable again: the DELETE that consumeHandoff replaced did this
  // implicitly (row gone, next build INSERTed a new one), while the UPSERT reuses the row.
  // Without the reset, a session whose handoff was consumed by a sibling stays permanently
  // invisible to injection however much work it does afterwards. Pre-ship defect lens.
  //
  // This prose lives here and not in the SQL because a backtick inside a SQL comment inside
  // a template literal ends the literal — the same defect this repo shipped at v6.9.1, and
  // it recurred right here while writing this fix.
  db.prepare(
    `
    INSERT INTO session_handoffs (project, type, session_id, working_on, completed, unfinished, key_files, key_decisions, match_keywords, created_at_epoch, git_sha_at_handoff, git_branch, git_dirty_count, next_steps)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, type, session_id) DO UPDATE SET
      working_on = excluded.working_on,
      completed = excluded.completed,
      unfinished = excluded.unfinished,
      key_files = excluded.key_files,
      key_decisions = excluded.key_decisions,
      match_keywords = excluded.match_keywords,
      created_at_epoch = excluded.created_at_epoch,
      git_sha_at_handoff = excluded.git_sha_at_handoff,
      git_branch = excluded.git_branch,
      git_dirty_count = excluded.git_dirty_count,
      next_steps = excluded.next_steps,
      consumed_at = NULL
  `,
  ).run(
    project,
    type,
    storedSessionId,
    truncate(safe.working_on, 1000),
    safe.completed,
    safe.unfinished.length > 3000
      ? Array.from(safe.unfinished).slice(0, 2999).join('') + '…'
      : safe.unfinished,
    safeKeyFiles,
    safe.key_decisions,
    safe.match_keywords,
    Date.now(),
    gitShaAtHandoff,
    gitBranch,
    gitDirtyCount,
    nextSteps,
  );
}

/**
 * Detect if user's prompt indicates continuation of previous work.
 * Stage 0: Non-expired clear handoff + short prompt → auto-continue.
 * Stage 1: Explicit keyword match (zero false positives).
 * Stage 2: FTS5-style term overlap with handoff keywords.
 *
 * Session scoping (currentCcSessionId): when provided, clear handoffs from a
 * DIFFERENT session are excluded from Stage 0 auto-match and from the general
 * pool (prevents cross-session bleed when running parallel sessions for the
 * same project — see docs/bug.txt). When null, legacy behavior is preserved.
 *
 * @param {Database} db Opened main database
 * @param {string} promptText User's prompt text
 * @param {string} project Project identifier
 * @param {string|null} [currentCcSessionId=null] Claude Code session id for scoping
 * @returns {boolean}
 */
export function detectContinuationIntent(db, promptText, project, currentCcSessionId = null) {
  // Input guard: empty / whitespace / single-char prompts never trigger auto-injection.
  // The bug was a single-char 'a' + fresh clear handoff → Stage 0 auto-match.
  if (!promptText || typeof promptText !== 'string') return false;
  if (promptText.trim().length < 2) return false;

  // T10d Stage -1: Git-commit anchor — current HEAD == a stored
  // git_sha_at_handoff ⇒ working tree hasn't moved since the handoff.
  //
  // Age cap (HANDOFF_ANCHOR_MAX_AGE = 72h) prevents stale HEAD from
  // auto-continuing weeks-old context. For older anchors, the rest of the
  // pipeline (Stage 0/1/2) still evaluates normally.
  try {
    const currentSha = gitStateModule.readGitState({ cwd: process.cwd() }).headSha;
    if (currentSha) {
      // Scope like Stage 2: an 'exit' anchor is cross-session (resume after /exit), but a 'clear'
      // anchor is same-session only — else a parallel same-project session at the same commit
      // would hijack (and then delete) another session's clear handoff.
      const anchor = currentCcSessionId
        ? db
            .prepare(
              `
            SELECT created_at_epoch, match_keywords FROM session_handoffs
            WHERE project = ? AND git_sha_at_handoff = ? AND (type = 'exit' OR session_id = ?)
              AND ${UNCONSUMED_HANDOFF_SQL}
            ORDER BY created_at_epoch DESC LIMIT 1
          `,
            )
            .get(project, currentSha, currentCcSessionId)
        : db
            .prepare(
              `
            SELECT created_at_epoch, match_keywords FROM session_handoffs
            WHERE project = ? AND git_sha_at_handoff = ? AND ${UNCONSUMED_HANDOFF_SQL}
            ORDER BY created_at_epoch DESC LIMIT 1
          `,
            )
            .get(project, currentSha);
      if (anchor && Date.now() - anchor.created_at_epoch <= HANDOFF_ANCHOR_MAX_AGE) {
        // Unmoved HEAD is a strong resume signal, but must not hijack a NEW task typed at the
        // same commit: gate long prompts on keyword overlap (mirror Stage 0). Short prompts
        // (resume nudges) auto-continue.
        if (promptText.length < 40) return true;
        const hTokens = anchor.match_keywords ? new Set(tokenizeHandoff(anchor.match_keywords)) : null;
        if (!hTokens || tokenizeHandoff(promptText).some((t) => hTokens.has(t))) return true;
        // long prompt with zero keyword overlap → fall through to Stage 0/1/2
      }
    }
  } catch {
    /* git/DB failure must not break the rest of the pipeline */
  }

  // Stage 0: Non-expired 'clear' handoff — assume continuation unless long unrelated prompt.
  // Session scoping: with currentCcSessionId, only your OWN clear handoff qualifies.
  const clearHandoff = currentCcSessionId
    ? db
        .prepare(
          `
        SELECT created_at_epoch, match_keywords FROM session_handoffs
        WHERE project = ? AND type = 'clear' AND session_id = ? AND ${UNCONSUMED_HANDOFF_SQL}
        ORDER BY created_at_epoch DESC LIMIT 1
      `,
        )
        .get(project, currentCcSessionId)
    : db
        .prepare(
          `
        SELECT created_at_epoch, match_keywords FROM session_handoffs
        WHERE project = ? AND type = 'clear' AND ${UNCONSUMED_HANDOFF_SQL}
        ORDER BY created_at_epoch DESC LIMIT 1
      `,
        )
        .get(project);

  if (clearHandoff && Date.now() - clearHandoff.created_at_epoch <= HANDOFF_EXPIRY_CLEAR) {
    const pTokens = tokenizeHandoff(promptText);
    const hTokens = clearHandoff.match_keywords
      ? new Set(tokenizeHandoff(clearHandoff.match_keywords))
      : null;
    const hasOverlap = hTokens && pTokens.some((t) => hTokens.has(t));
    if (promptText.length < 40) {
      // Short prompts: session-scoped clear = same user/context, auto-continue.
      // Unscoped (legacy / no session_id in hook input) requires an explicit
      // continuation keyword or keyword overlap to avoid cross-session noise.
      if (currentCcSessionId) return true;
      if (CONTINUE_KEYWORDS.test(promptText)) return true;
      if (hasOverlap) return true;
      // Fall through
    } else {
      // Long prompts: check keyword overlap to confirm same-task intent
      if (!clearHandoff.match_keywords) return true; // no keywords stored, can't verify
      if (hasOverlap) return true;
      // Long prompt with zero keyword overlap → likely new task, fall through
    }
  }

  // Stage 1: Explicit keyword match — always works, even without handoff
  if (CONTINUE_KEYWORDS.test(promptText)) return true;

  // Stage 2: FTS5-style term overlap with handoff keywords.
  // Session scoping: exit handoffs from OTHER sessions are still candidates (you may
  // be resuming a previous session), but clear handoffs must be same-session.
  const handoffs = currentCcSessionId
    ? db
        .prepare(
          `
        SELECT type, match_keywords, created_at_epoch FROM session_handoffs
        WHERE project = ?
          AND ((type = 'clear' AND session_id = ?) OR type = 'exit')
          AND ${UNCONSUMED_HANDOFF_SQL}
        ORDER BY created_at_epoch DESC
      `,
        )
        .all(project, currentCcSessionId)
    : db
        .prepare(
          `
        SELECT type, match_keywords, created_at_epoch FROM session_handoffs
        WHERE project = ? AND ${UNCONSUMED_HANDOFF_SQL} ORDER BY created_at_epoch DESC
      `,
        )
        .all(project);
  if (handoffs.length === 0) return false;

  // Filter expired handoffs
  const now = Date.now();
  const validHandoffs = handoffs.filter((h) => {
    const age = now - h.created_at_epoch;
    const maxAge = h.type === 'clear' ? HANDOFF_EXPIRY_CLEAR : HANDOFF_EXPIRY_EXIT;
    return age <= maxAge;
  });
  if (validHandoffs.length === 0) return false;

  // Use the most recent valid handoff for keyword matching
  const handoff = validHandoffs[0];
  const promptTokens = tokenizeHandoff(promptText);
  const handoffTokens = new Set(tokenizeHandoff(handoff.match_keywords));

  let score = 0;
  for (const token of promptTokens) {
    if (handoffTokens.has(token)) {
      score += isSpecificTerm(token) ? 2 : 1;
    }
  }

  return score >= HANDOFF_MATCH_THRESHOLD;
}

/**
 * Render handoff injection text for stdout.
 * Reads the most recent handoff + optional session summary.
 *
 * Session scoping (currentCcSessionId): when provided,
 *   - clear handoffs: only from the CURRENT session (you continue your own /clear)
 *   - exit handoffs:  only from OTHER sessions (you resume a previous exit)
 * When null, legacy behavior (most-recent handoff regardless of session).
 *
 * @param {Database} db Opened main database
 * @param {string} project Project identifier
 * @param {string|null} [currentCcSessionId=null] Claude Code session id for scoping
 * @returns {string|null} Injection text or null if no handoff
 */
export function pickHandoffToInject(db, project, currentCcSessionId = null) {
  const now = Date.now();
  // Fetch recent handoffs and find the most recent non-expired one.
  // A newer but expired 'clear' handoff must not shadow a still-valid 'exit' handoff.
  // No id tiebreaker on this or the Stage -1/0/2 reads above, on purpose: session_handoffs has
  // no id column, and its rowid is not recency because the writer is an UPSERT that keeps the
  // row's original rowid. `rowid DESC` would therefore pick the older write whenever a tie
  // involves a row rewritten after the other was first inserted. A correct tiebreak needs a
  // column; see findings.md, the created_at_epoch tie bullet.
  const handoffs = currentCcSessionId
    ? db
        .prepare(
          `
        SELECT * FROM session_handoffs
        WHERE project = ?
          AND ((type = 'clear' AND session_id = ?) OR (type = 'exit' AND session_id != ?))
          AND ${UNCONSUMED_HANDOFF_SQL}
        ORDER BY created_at_epoch DESC LIMIT 5
      `,
        )
        .all(project, currentCcSessionId, currentCcSessionId)
    : db
        .prepare(
          `
        SELECT * FROM session_handoffs
        WHERE project = ? AND ${UNCONSUMED_HANDOFF_SQL} ORDER BY created_at_epoch DESC LIMIT 5
      `,
        )
        .all(project);
  return (
    handoffs.find((h) => {
      const age = now - h.created_at_epoch;
      const maxAge = h.type === 'clear' ? HANDOFF_EXPIRY_CLEAR : HANDOFF_EXPIRY_EXIT;
      return age <= maxAge;
    }) || null
  );
}

/**
 * Mark one handoff row as delivered.
 *
 * Replaces the DELETE that used to follow injection. Two things that DELETE cost: a handoff
 * injected at a moment the model could not act on it was gone for good, and the row behind a
 * bad injection no longer existed by the time anyone went looking for it. Marking keeps the
 * row until the existing age-based GC in hook.mjs's auto-maintain reaps it, so retention is
 * unchanged in the limit — only the window in which it can be read back grows.
 *
 * Scoped to the exact PK so a parallel session's handoff is untouched (the DELETE this
 * replaces already had that property, and pre-v2.46 not having it made the DB forgetful).
 *
 * @param {Database} db Opened main database
 * @param {{project: string, type: string, session_id: string}} handoff Row from pickHandoffToInject
 * @param {number} [now=Date.now()] Injected for tests
 * @returns {number} Rows changed (0 when a concurrent session consumed it first)
 */
export function consumeHandoff(db, handoff, now = Date.now()) {
  if (!handoff) return 0;
  // `consumed_at IS NULL` in the WHERE, not just the SET: two sessions can race to inject
  // the same exit handoff, and the first stamp is the one that should stand.
  const res = db
    .prepare(
      `UPDATE session_handoffs SET consumed_at = ?
       WHERE project = ? AND type = ? AND session_id = ? AND ${UNCONSUMED_HANDOFF_SQL}`,
    )
    .run(now, handoff.project, handoff.type, handoff.session_id);
  return res.changes;
}

export function renderHandoffInjection(db, project, currentCcSessionId = null) {
  const handoff = pickHandoffToInject(db, project, currentCcSessionId);
  if (!handoff) return null;
  return renderHandoffFromRow(handoff, db, project);
}

// `safeText` — the ATX-marker + authority-tag defang this renderer has applied since a real
// injection came back carrying `## ` of its own — moved to format-utils.mjs 2026-09-21. It
// was private here while hook-context's `### Working State (from /clear)` replayed the SAME
// three session_handoffs columns with only the tag half of the treatment, so the two surfaces
// had drifted apart by a whole defence. One home now; see the docblock there for why it must
// be applied per FIELD and never to an assembled block.

// `[bugfix] title` → `title`. Both `completed` and `key_decisions` store the observation
// type this way; the bracket run is length-capped so a title that merely opens with a
// bracket ("[WIP] ..." is not a type) is not silently truncated to nothing.
const TYPE_PREFIX_RE = /^\[[^\]]{1,20}\]\s*/;
const titleOf = (line) => line.replace(TYPE_PREFIX_RE, '').trim();

function renderHandoffFromRow(handoff, db, project) {
  const ageSec = Math.round((Date.now() - handoff.created_at_epoch) / 1000);
  const ageStr =
    ageSec < 60
      ? `${ageSec}s`
      : ageSec < 3600
        ? `${Math.round(ageSec / 60)}m`
        : ageSec < 86400
          ? `${Math.round(ageSec / 3600)}h`
          : `${Math.round(ageSec / 86400)}d`;

  // Framing header: `UserPromptSubmit` hook writes this block to stdout, which
  // Claude Code surfaces alongside the real user prompt. Without an explicit
  // "this is not a new message" marker, models can misread `## Working On <text>`
  // as a fresh user utterance and either answer the old task or end the turn.
  // The `[mem]` prefix mirrors the SessionStart dashboard convention; `origin`
  // on the tag gives programmatic callers a stable anchor.
  const lines = [
    `[mem] Resumed context from previous session (${handoff.type}, age ${ageStr}) — system-injected, NOT a new user message:`,
    `<session-handoff source="${handoff.type}" age="${ageStr}" origin="hook-injected">`,
  ];

  // Defang delimiter tags in the free-text fields ONLY — never the structural
  // <session-handoff> tags in `lines`, or the block would lose its own framing. A
  // user prompt or edit snippet carrying a literal </session-handoff> would otherwise
  // close the block early and the rest would read as a real user message.
  if (handoff.working_on) {
    lines.push('## Working On', safeText(handoff.working_on), '');
  }

  // Tree state. The sha has been stored since v25 but was only ever an INPUT to the
  // continuation anchor — it was never shown, so a resumed session opened by running
  // `git status` / `git rev-parse` to find out where it stood. Rendered right after the
  // objective, because "which branch, and is the tree dirty" is the next question after
  // "what was I doing". Branch names are defanged for the same reason key_files basenames
  // are: git ref names admit angle brackets, and this text is replayed into the prompt.
  // A 7-char sha cannot carry a complete tag, so it is sliced rather than scrubbed.
  const treeBits = [];
  if (handoff.git_branch) treeBits.push(`branch ${safeText(handoff.git_branch)}`);
  if (handoff.git_sha_at_handoff) treeBits.push(`@ ${String(handoff.git_sha_at_handoff).slice(0, 7)}`);
  if (typeof handoff.git_dirty_count === 'number') {
    // NULL stays silent: a row written before this shipped, or written outside a repo, has
    // no measurement, and "clean" would be a claim nobody made.
    treeBits.push(handoff.git_dirty_count === 0 ? 'clean' : `${handoff.git_dirty_count} uncommitted file(s)`);
  }
  if (treeBits.length > 0) lines.push('## Tree state', treeBits.join(' · '), '');

  // Key Decisions is computed here, before Completed renders, because Completed is deduped
  // against it. Measured on the live corpus 2026-09-21 with the real predicates, population
  // = every project with observations: 35 of 35 rendered Key Decisions lines were
  // byte-identical to a Completed line, in all 8 projects. The overlap only became visible
  // once the payload fix landed — before that both sections were empty.
  //
  // One-directional on purpose, and this is the F4 ruling rather than a preference:
  // `completed` is the session's OWN HISTORY, `key_decisions` is standing policy replayed to
  // a LATER session, which is why only the latter filters superseded_at. So the line to drop
  // is the duplicate in history, and the one case where the two genuinely differ — a
  // retracted decision, absent from key_decisions — is exactly the case where nothing is
  // dropped and the history keeps it. Render-time only: the stored row is untouched, so all
  // three F4 guards in tests/audit-silent-20260814.test.mjs still read what they pinned.
  const decisionLines = handoff.key_decisions
    ? safeText(handoff.key_decisions)
        .split('\n')
        .filter((l) => l.trim())
    : [];
  // Match on the WHOLE line. Matching on the stripped title collapsed two DIFFERENT
  // observations that share a title but not a type — `[change] 更新测试` vanished from
  // Completed because `[decision] 更新测试` was standing policy — and that false match was
  // permanent while the thing it accommodated is not. Pre-ship defect lens.
  const decisionWhole = new Set(decisionLines);
  // The accommodation, scoped to the rows that actually need it: a row written before
  // key_decisions carried the `[type]` prefix holds a bare title, so only those get the
  // looser title-only match. They age out at the handoff's own expiry.
  const legacyTitles = new Set(decisionLines.filter((l) => !TYPE_PREFIX_RE.test(l)).map((l) => titleOf(l)));
  const isDuplicateOfDecision = (line) => decisionWhole.has(line) || legacyTitles.has(titleOf(line));

  if (handoff.completed) {
    const kept = safeText(handoff.completed)
      .split('\n')
      .filter((l) => l.trim() && !isDuplicateOfDecision(l));
    // An empty `## Completed` header is worse than no header — TWO of the eight measured
    // projects had a session whose entire history was its decisions (dev--daagu and
    // scratchpad--loop-smoke; the next closest keeps 2 lines). The commit body and an
    // earlier draft of this comment said three; re-derived at both the 105- and
    // 107-observation corpus states it is two. No type tags are lost with the header:
    // key_decisions carries them now too.
    if (kept.length > 0) lines.push('## Completed', ...kept.map((l) => `- ${l}`), '');
  }
  if (handoff.unfinished) {
    // Extract only the pending-work portion (before narrative history separator).
    // Header: "Recent activity" rather than "Unfinished" — the list mixes in-flight
    // edits with surfaced errors, and calling a completed edit "unfinished" is a
    // completeness claim the episode buffer can't support.
    const pending = extractUnfinishedSummary(handoff.unfinished);
    if (pending) {
      lines.push(
        '## Recent activity',
        ...safeText(pending)
          .split('; ')
          .map((l) => `- ${l}`),
        '',
      );
    }
  }
  if (handoff.key_files) {
    try {
      const files = JSON.parse(handoff.key_files);
      // Defang basenames too: a filename on disk can contain a literal authority tag
      // (Linux allows almost any char but '/'), and this is the one field in this block
      // that was rendered raw while working_on/unfinished/key_decisions all neutralize.
      if (files.length > 0)
        lines.push('## Key Files', safeText(files.map((f) => basename(f)).join(', ')), '');
    } catch {}
  }
  // Next steps, from the project's newest paused note. Placed after Key Files and before
  // Key Decisions: it is the most actionable block here, and it cites its own source file
  // so the resuming session can open the full note instead of trusting this summary.
  // Defanged like every other free-text field — the note is repo text, replayed verbatim
  // into the prompt, and a literal closer would end the block early.
  if (handoff.next_steps) {
    try {
      const note = JSON.parse(handoff.next_steps);
      if (Array.isArray(note?.items) && note.items.length > 0) {
        lines.push('## Next steps');
        const from = note.file ? ` (from ${safeText(String(note.file))})` : '';
        if (note.title) lines.push(`${safeText(String(note.title))}${from}`);
        else if (from) lines.push(from.trim());
        for (const item of note.items) lines.push(`- ${safeText(String(item))}`);
        lines.push('');
      }
    } catch {
      /* malformed JSON — skip, same as key_files */
    }
  }

  if (decisionLines.length > 0) {
    lines.push('## Key Decisions', ...decisionLines.map((l) => `- ${l}`), '');
  }

  lines.push('</session-handoff>');

  // Append session summary if available (long-gap enrichment).
  // session_summaries is keyed by the mem-internal memory_session_id, but in production
  // session_handoffs.session_id holds the Claude Code UUID (the scope tag) — the two id
  // namespaces never match, so the exact lookup returned nothing and this block was always
  // dropped on a real resume. There is no bridge column (the CC-UUID lives on user_prompts,
  // not on sdk_sessions/session_summaries), so: try the exact id match first (correct when
  // ids align — legacy rows + tests), then fall back to the most-recent summary for the
  // project, which at resume time is the summary from the session that wrote this handoff.
  try {
    let summary = db
      .prepare(
        `
      SELECT completed, next_steps, remaining_items FROM session_summaries
      WHERE memory_session_id = ? AND project = ?
      ORDER BY created_at_epoch DESC, id DESC LIMIT 1
    `,
      )
      .get(handoff.session_id, project);
    if (!summary) {
      // Pick the project summary CLOSEST IN TIME to this handoff, not merely the newest:
      // a handoff and its own session's summary are written within ms of each other at
      // session end, so nearest-timestamp recovers the right session even when a different
      // session later wrote a newer summary for the same project (concurrent/interleaved use).
      summary = db
        .prepare(
          `
        SELECT completed, next_steps, remaining_items FROM session_summaries
        WHERE project = ?
        ORDER BY ABS(created_at_epoch - ?) ASC, id DESC LIMIT 1
      `,
        )
        .get(project, handoff.created_at_epoch ?? 0);
    }
    if (summary && (summary.completed || summary.next_steps || summary.remaining_items)) {
      lines.push('');
      lines.push('<session-summary source="haiku">');
      // Defang: these come from session_summaries, populated by Haiku OR by
      // extractStructuredSummary over the assistant transcript tail — replayed text that can
      // carry tool-XML / forged authority tags, same class as working_on above (audit MED-4).
      if (summary.completed) lines.push(safeText(summary.completed));
      if (summary.remaining_items) lines.push(`Remaining: ${safeText(summary.remaining_items)}`);
      if (summary.next_steps) lines.push(`Next steps: ${safeText(summary.next_steps)}`);
      lines.push('</session-summary>');
    }
  } catch {}

  return lines.join('\n');
}

// Separator used by buildAndSaveHandoff to join pending entries with narrative history.
const UNFINISHED_NARRATIVE_SEP = '\n---\n';
const UNFINISHED_ENTRY_SEP = '; ';

/**
 * Extract the pending-work portion of the unfinished field (before narrative history).
 * @param {string} unfinished Raw unfinished text from session_handoffs
 * @param {number} [maxItems=3] Max number of pending entries to return
 * @returns {string} Pending work summary (empty string if none)
 */
export function extractUnfinishedSummary(unfinished, maxItems = 3) {
  if (!unfinished) return '';
  const pending = unfinished.split(UNFINISHED_NARRATIVE_SEP)[0];
  if (maxItems > 0) {
    return pending.split(UNFINISHED_ENTRY_SEP).slice(0, maxItems).join(UNFINISHED_ENTRY_SEP);
  }
  return pending;
}
