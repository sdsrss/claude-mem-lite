// Citation tracker (P4): scan Claude Code transcript for `#NN` observation-id
// citations in assistant text, then bulk-increment access_count for matched rows.
//
// Closes the loop on the CLAUDE.md "cite #NN" contract — before P4, citations
// were a one-way obligation with no measurable feedback. Now each honored
// citation bumps access_count, making contract compliance observable via
// mem_stats and preventing cited lessons from decaying into dead memory.
//
// FTS5 caveat (project_non_obvious.md): observations_au trigger fires on any
// column UPDATE including access_count. Per-row UPDATEs wrapped in try-catch
// to prevent SQLITE_CORRUPT_VTAB cascades from stopping the whole scan.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { debugCatch, debugLog } from '../utils.mjs';
import { keyContextIdsFileName } from './injected-ids.mjs';
import { readTranscriptEntries } from './transcript-scan.mjs';
// The emitter's own prefix — see SURFACE_MATCHERS.task_imperative. Importing it rather
// than re-typing the framing is what keeps emit and extract from becoming two lists.
import { TASK_IMPERATIVE_PREFIX } from './task-imperative.mjs';

import { DAY_MS } from './time-constants.mjs';
/**
 * The ONE caliber for an observation id appearing in text. Bounded to 1-7 digits to
 * skip URL fragments, markdown anchors, etc.
 *
 * Exported because the offline benchmarks re-derive production's numbers from the same
 * transcripts, and each had hand-copied its own: `benchmark/cite-recall.mjs` scanned
 * citations with `{2,6}` while its OWN injected denominator used `{1,7}`, and
 * `efficacy-observational.mjs` / `adoption-replay.mjs` had a third and fourth caliber
 * (`{2,6}` / `{2,7}`). A denominator wider than its numerator counts an id as
 * injected-never-cited that the numerator structurally cannot see, which biases the
 * measured cite-rate DOWN — and nothing errors when it happens.
 *
 * Measured live impact at the time this was unified (2026-08-24, 3692 rows, ids 1..10834):
 * exactly ZERO. The only ids outside `{2,6}` are four 1-digit rows, and all four have
 * injection_count = 0, so they never entered a denominator; there are no 7-digit ids.
 * This is a latent-class fix, not a correction to any published number — do not
 * re-attribute past readings to it.
 */
export const OBS_ID_DIGITS = '\\d{1,7}';

/**
 * A fresh global matcher for a bare `#NN` citation.
 *
 * Returned fresh per call rather than shared: a `/g` regex carries `lastIndex`, so one
 * exported instance reused by two scanners silently starts mid-string in whichever one
 * runs second.
 */
export function citationIdRe() {
  return new RegExp(`#(${OBS_ID_DIGITS})\\b`, 'g');
}

/**
 * Caliber for an id scraped from UNANCHORED text that is then treated as an INJECTED
 * (denominator) set.
 *
 * `citationIdRe()` above is a NUMERATOR caliber. On the numerator side a spurious `#1`
 * costs nothing, because a cited id only counts once it intersects an injected set that
 * WAS anchored — every injected-side extractor in this module matches a row shape
 * (`INJECTED_ROW_RE`, `FYI_LINE_ID_RE`, `UPS_ID_RE`, `SUBAGENT_INJECT_ID_RE`). On the
 * denominator side nothing anchors it, so a prose `#1` is a false positive by
 * construction — it inflates "injected, never cited" and biases the measured rate DOWN.
 *
 * The v3.80.0 pre-tag review caught this concretely: pointing
 * `benchmark/adoption-replay.mjs` at `citationIdRe()` pulled `#1` and `#2` out of a
 * subagent prompt discussing fixture rows ("with `#1` superseded by `#2` …") straight into
 * `injectedIds`, on a real transcript. Excluding 1-digit ids costs nothing measurable —
 * the four 1-digit rows in the live corpus have `injection_count = 0` — and removes the
 * commonest prose collision.
 *
 * This is a stopgap for a caliber symptom, NOT a fix for the cause. The cause is that
 * adoption-replay scrapes a whole prompt where it should match injected ROWS, the way
 * production does. Do not reach for this anywhere else; anchor instead.
 */
export function unanchoredInjectedIdRe() {
  return new RegExp('#(\\d{2,7})\\b', 'g');
}

// `#123` / `#45678` at a word boundary — matches the CLAUDE.md cite pattern.
const CITATION_RE = citationIdRe();

/**
 * Parse a Claude Code transcript .jsonl and extract unique observation IDs
 * cited inside assistant text blocks.
 *
 * @param {string} transcriptPath Path to transcript file (.jsonl)
 * @param {object} [opts] Options
 * @param {boolean} [opts.mainOnly=false] If true, skip transcript records where isSidechain === true
 * @returns {Set<number>} unique IDs referenced as `#NN` in assistant text
 */
export function extractCitationsFromTranscript(transcriptPath, opts = {}) {
  const { mainOnly = false } = opts;
  const ids = new Set();
  for (const entry of readTranscriptEntries(transcriptPath)) {
    // Claude Code transcript: one JSON per line with type='assistant' | 'user' | ...
    if (entry.type !== 'assistant' || !entry.message) continue;
    // Citation-decay loop scopes citation signal to main-thread text only —
    // subagent dispatches run their own session context the parent can't
    // reasonably be held accountable for. Default off preserves the broader
    // access_count-bump semantics of existing callers (P4 bumpCitationAccess).
    if (mainOnly && entry.isSidechain === true) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      CITATION_RE.lastIndex = 0;
      let m;
      while ((m = CITATION_RE.exec(block.text))) {
        const id = Number(m[1]);
        if (Number.isInteger(id) && id > 0 && id < 1e7) ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * D#179 prerequisite measurement: split each cited id into the responses that
 * ACTED while naming it and the responses that only TALKED about it.
 *
 * `applyCitationDecay` promotes on any `#NN` in assistant text, so writing a release
 * note, an audit, or a review that discusses a memory promotes that memory — including,
 * self-referentially, a note observing that the memory is about to be evicted. Nothing
 * downstream distinguishes "changed the code this lesson describes" from "mentioned the
 * lesson's number". This function supplies the discriminator the deferred item asks for
 * so the size of the contamination can be counted before anything is redesigned.
 *
 * The unit is a RESPONSE, keyed by `requestId` — one model turn, whose entries carry
 * thinking / text / tool_use blocks under a shared id. That granularity is the point:
 * a whole user-to-user exchange almost always contains some tool call, so bounding on
 * user messages would classify nearly everything as "applied" and measure nothing.
 *
 * The key falls back `requestId || message.id || uuid`. In practice `message.id` carries
 * every real Claude Code assistant entry that lacks a requestId, and it is still a
 * per-response key, so the uuid arm is close to unreachable in production and exists only
 * so a keyless entry is never merged into a shared bucket. What must NOT happen is any
 * grouping coarser than one response: one tool call anywhere in a coarser bucket would
 * mark every id in it as acted on, and the measurement would report no contamination on
 * any coding session. (The pre-tag review pointed out that the earlier version of this
 * sentence named only the uuid arm, and that the one test for it constructs a shape
 * production never emits.)
 *
 * Returns a Map keyed by id: `{ withTool, textOnly }` response counts. An id is a pure
 * MENTION when `withTool === 0`.
 *
 * NEITHER SIDE IS A BOUND, and an earlier draft of this comment claimed one. The proxy
 * errs in both directions: naming an id in a response that also calls a tool is only
 * co-occurrence, not evidence the lesson was followed (over-counts `withTool`); and an
 * agent that acts in one response and cites the lesson in a later summary response gets
 * classified pure-mention despite having applied it (over-counts `textOnly`). Use the
 * split to size the question, not to settle it.
 *
 * @param {string} transcriptPath
 * @param {object} [opts]
 * @param {boolean} [opts.mainOnly=true] skip sidechain (subagent) records
 * @returns {Map<number, {withTool: number, textOnly: number}>}
 */
export function classifyCitationContext(transcriptPath, opts = {}) {
  const { mainOnly = true } = opts;
  // requestId -> { ids:Set<number>, tool:boolean }
  const responses = new Map();
  for (const entry of readTranscriptEntries(transcriptPath)) {
    if (entry.type !== 'assistant' || !entry.message) continue;
    if (mainOnly && entry.isSidechain === true) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    const key = entry.requestId || entry.message.id || entry.uuid;
    if (!key) continue;
    let r = responses.get(key);
    if (!r) {
      r = { ids: new Set(), tool: false };
      responses.set(key, r);
    }
    for (const block of content) {
      if (block.type === 'tool_use') {
        r.tool = true;
        continue;
      }
      // Only `text` blocks count as citing. `thinking` is deliberately excluded:
      // extractCitationsFromTranscript scores text only, and the whole point is to
      // classify the same numerator the decay loop acts on, not a wider one.
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      CITATION_RE.lastIndex = 0;
      let m;
      while ((m = CITATION_RE.exec(block.text))) {
        const id = Number(m[1]);
        if (Number.isInteger(id) && id > 0 && id < 1e7) r.ids.add(id);
      }
    }
  }
  const out = new Map();
  for (const { ids, tool } of responses.values()) {
    for (const id of ids) {
      let e = out.get(id);
      if (!e) {
        e = { withTool: 0, textOnly: 0 };
        out.set(id, e);
      }
      if (tool) e.withTool++;
      else e.textOnly++;
    }
  }
  return out;
}

/**
 * Compute cite-recall stats for one transcript: how many of the `#NN`
 * references that surfaced in non-assistant content (hook injections, system
 * reminders, tool_result blocks) the assistant actually cited back. Used to
 * power SessionStart feedback when prior-session compliance is low.
 *
 * Definition: ratio = |injected ∩ cited| / |injected|.
 * `injected` is intentionally over-inclusive — it captures any `#NN` that was
 * visible to the model in non-assistant content. User-pasted IDs leak into
 * this set; the SessionStart consumer mitigates with a min-volume floor.
 *
 * @param {string} transcriptPath
 * @returns {{injected: number, cited: number, recalled: number, ratio: number}}
 *   Returns zeros if transcript is missing or empty.
 */
export function computeCiteRecall(transcriptPath) {
  const injected = new Set();
  const cited = new Set();

  for (const entry of readTranscriptEntries(transcriptPath)) {
    const target = entry.type === 'assistant' ? cited : injected;
    // Walk every text-bearing surface the transcript carries: top-level content,
    // nested message content (assistant/user blocks), and tool_result-style
    // entries that hide hook injections inside system-reminders.
    const surfaces = [];
    if (typeof entry.content === 'string') surfaces.push(entry.content);
    if (Array.isArray(entry.content)) surfaces.push(...entry.content);
    if (entry.message?.content) {
      if (typeof entry.message.content === 'string') surfaces.push(entry.message.content);
      else if (Array.isArray(entry.message.content)) surfaces.push(...entry.message.content);
    }
    for (const s of surfaces) {
      let text = '';
      if (typeof s === 'string') text = s;
      else if (s && typeof s === 'object') {
        if (typeof s.text === 'string') text = s.text;
        else if (typeof s.content === 'string') text = s.content;
      }
      if (!text) continue;
      CITATION_RE.lastIndex = 0;
      let m;
      while ((m = CITATION_RE.exec(text))) {
        const id = Number(m[1]);
        if (Number.isInteger(id) && id > 0 && id < 1e7) target.add(id);
      }
    }
  }

  let recalled = 0;
  for (const id of injected) if (cited.has(id)) recalled++;
  const ratio = injected.size > 0 ? recalled / injected.size : 0;
  return { injected: injected.size, cited: cited.size, recalled, ratio };
}

/**
 * Observation ids the USER typed in their own messages this session.
 *
 * Half of the relevance gate bumpCitationAccess takes (audit FLOW-2). Someone writing
 * `look at #10716` is naming that memory deliberately, which is at least as strong a
 * relevance signal as an automatic injection — dropping it would have been the cost of
 * the narrower "injected only" gate.
 *
 * Hook injections ride the `attachment` channel (see eachHookAttachment), not user
 * message text, so this reads a different stream than the surface extractors do. It does
 * not filter injected content out of the result: the only consumer unions this with the
 * injected set, where a duplicate is free.
 *
 * `tool_result` blocks are program output echoed back inside a user turn — not something
 * the user wrote — so only `text` blocks count.
 *
 * @param {string|null|undefined} transcriptPath
 * @param {{mainOnly?: boolean}} [opts]
 * @returns {Set<number>}
 */
export function extractUserTypedIds(transcriptPath, opts = {}) {
  const { mainOnly = false } = opts;
  const ids = new Set();
  for (const entry of readTranscriptEntries(transcriptPath)) {
    if (entry.type !== 'user' || !entry.message) continue;
    if (mainOnly && entry.isSidechain === true) continue;
    const content = entry.message.content;
    const blocks =
      typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      CITATION_RE.lastIndex = 0;
      let m;
      while ((m = CITATION_RE.exec(block.text))) addObsId(ids, m[1]);
    }
  }
  return ids;
}

/**
 * The set of ids this session actually put in front of the model, across ALL SEVEN faces.
 *
 * This is the population `bumpCitationAccess` credits against, and it lives here rather
 * than inline at the call site because getting it from `extractAllInjected` alone is
 * wrong in a way nothing would have caught. That helper unions the five faces with a hook
 * attachment to walk; the two it omits are NON_ATTACHMENT_SURFACES, and each is omitted
 * for a reason that does not apply to the promotion channel:
 *
 *   * `keyctx` — kept out of extractAllInjected because an unconditional SessionStart
 *     render is no evidence for the decay DENOMINATOR. `extractInjectedFromKeyContext`'s
 *     docblock then names this exact caller: "Callers must therefore intersect with the
 *     cited set (see handleStop) so a CITED Key Context row is credited while an uncited
 *     one is left alone." Dropping it inverts that contract — and does so INVISIBLY on an
 *     adopted project, where the marker is empty by construction. The loss lands on a
 *     non-adopted project, the default for a new install, where that block is the most
 *     prominent injection surface there is.
 *   * `subagent` — a lesson handed to a dispatched agent was still shown by this session.
 *
 * Derived from CITATION_SURFACES rather than re-enumerated, so a new face cannot be added
 * to the store and silently miss this gate (`assertRelevanceCoversAllFaces` binds it).
 *
 * @param {object} ctx
 * @param {string|null|undefined} ctx.transcriptPath
 * @param {string} [ctx.runtimeDir]
 * @param {string} [ctx.project]
 * @param {string|null} [ctx.sessionId]
 * @param {Iterable<number>} [ctx.subagentInjected] Already-collected subagent ids
 *        (collectSubagentSurface parses sidechains and evicts the transcript memo, so the
 *        caller runs it once and hands the result in rather than paying for it twice).
 * @returns {Set<number>}
 */
export function buildCitationRelevanceSet({
  transcriptPath,
  runtimeDir,
  project,
  sessionId = null,
  subagentInjected = [],
} = {}) {
  const out = new Set();
  for (const id of extractAllInjected(transcriptPath)) out.add(id); // 5 attachment faces
  if (runtimeDir && project) {
    for (const id of extractInjectedFromKeyContext({ runtimeDir, project, sessionId })) out.add(id);
  }
  for (const id of subagentInjected) out.add(id);
  for (const id of extractUserTypedIds(transcriptPath)) out.add(id); // the user named it
  return out;
}

/**
 * Every face in CITATION_SURFACES must have a source in buildCitationRelevanceSet.
 *
 * Structural, because the behavioural version cannot exist: the faces are read off
 * different streams (attachments, a runtime marker, sidechain files, user text), so no one
 * fixture drives all seven. Throws rather than returns, so a face added without a source
 * fails loudly at test time instead of quietly losing its promotion channel.
 *
 * @param {ReadonlyArray<string>} [sourced] Faces the builder reads, for the test to pass in.
 */
export function assertRelevanceCoversAllFaces(sourced) {
  const covered = new Set(sourced ?? [...ATTACHMENT_SURFACES, ...NON_ATTACHMENT_SURFACES]);
  const missing = CITATION_SURFACES.filter((f) => !covered.has(f));
  if (missing.length) {
    throw new Error(
      `buildCitationRelevanceSet has no source for face(s): ${missing.join(', ')} — ` +
        'a face with no source here loses its access-count promotion channel silently.',
    );
  }
  return true;
}

/**
 * Increment `access_count` (and `last_accessed_at`) for each cited observation
 * that belongs to `project` AND is relevant to this session. Returns the count of
 * successful increments.
 *
 * `relevantIds` is REQUIRED, and it is the whole point (audit FLOW-2 / D#179).
 *
 * The cited set is "every `#NN` that appears in this session's assistant text", which
 * cannot tell a citation from a mention. In this repository — whose subject matter IS the
 * memory store — a session that writes a CHANGELOG or an audit report names dozens of ids
 * in prose, and each one was being credited with a use. Downstream that is not cosmetic:
 * `access_count > 3` promotes the row a tier via boostAccessed (maintain-core.mjs), so
 * discussing a memory made it more likely to be injected, and the same inflation fed the
 * cite-rate instrumentation that product decisions are read off. citation-tracker's own
 * notes record #10716 promoted by 21 mentions from the session that WROTE it.
 *
 * The gate is "did anything make this row relevant to this session" — injection did, and
 * the user naming an id in their own message did. An agent mentioning an id it just wrote
 * about did not. Deliberately NOT a context regex trying to separate "citing" from
 * "mentioning": that distinction is not enumerable, and trying was rejected up front.
 *
 * Passing no set is a no-op rather than an open gate: the caller must name the population
 * it is crediting, so a future call site cannot reopen this by omission. It says so in the
 * telemetry rather than failing silently.
 *
 * Superseded ids are redirected to their keeper first (FLOW-6), matching
 * applyCitationDecay and recordCitationSurfaces — this was the last access-side surface
 * still crediting a tombstone instead of the row that absorbed it. Both sets are
 * redirected, or a keeper id in one would not meet its superseded twin in the other.
 *
 * Per-row UPDATE in try-catch so a single FTS-corrupted row can't abort the
 * scan. Cross-project IDs are silently ignored by the WHERE clause.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Iterable<number>} ids  ids cited in this session's assistant text
 * @param {string} project
 * @param {Set<number>|Iterable<number>} relevantIds  ids injected this session, unioned
 *        with ids the user typed themselves. Required.
 * @returns {number} count of rows incremented
 */
export function bumpCitationAccess(db, ids, project, relevantIds, env = process.env) {
  if (!db || !ids || !project) return 0;
  // Revert path for the gate (CLAUDE_MEM_CITATION_RELEVANCE_GATE=off). It restores the
  // pre-v3.84.0 behaviour — every mention credited — including the missing-argument hole,
  // because a half-reverted gate is a third behaviour nobody has measured.
  const gateOff = String(env.CLAUDE_MEM_CITATION_RELEVANCE_GATE || '').toLowerCase() === 'off';
  if (!gateOff && (relevantIds === undefined || relevantIds === null)) {
    debugLog('WARN', 'bumpCitationAccess', 'no relevantIds passed — refusing to credit ungated mentions');
    return 0;
  }
  const cited = redirectSupersededIds(db, project, ids instanceof Set ? ids : new Set(ids));
  const allowed = redirectSupersededIds(
    db,
    project,
    relevantIds instanceof Set ? relevantIds : new Set(relevantIds ?? []),
  );
  // The superseded redirect is NOT part of the flag: it was a separate defect (FLOW-6,
  // crediting a tombstone instead of the row that absorbed it) with no upside to restore.
  const idList = gateOff ? [...cited] : [...cited].filter((id) => allowed.has(id));
  if (idList.length === 0) return 0;
  const stmt = db.prepare(`
    UPDATE observations SET access_count = access_count + 1, last_accessed_at = ?
    WHERE id = ? AND project = ?
  `);
  const now = Date.now();
  let n = 0;
  for (const id of idList) {
    try {
      const result = stmt.run(now, id, project);
      if (result.changes > 0) n++;
    } catch (e) {
      debugCatch(e, `bumpCitationAccess-id-${id}`);
    }
  }
  return n;
}

// Matches a pre-tool-recall / error-recall lesson line: `  #NN [type] body...`.
// Bounded type list mirrors observations.type CHECK + the events table's allowed
// event_type values these surfaces can emit.
const INJECTED_RE = new RegExp(
  `#(${OBS_ID_DIGITS})\\s+\\[(bugfix|decision|change|discovery|feature|refactor|lesson)\\]`,
  'g',
);
// Line-anchored variant: a genuine injected ROW begins (after its short indent) with
// `#NN [type]`. pre-tool-recall AND error-recall inline a lesson_learned body into the
// row; a body that quotes another obs ("same as #1234 [decision]") must NOT count as
// injected: that id would pollute the citation-decay denominator and falsely demote.
const INJECTED_ROW_RE = new RegExp('^\\s{0,6}' + INJECTED_RE.source);

// Add a numeric obs id to `set` if it parses to a sane in-range positive int.
function addObsId(set, raw) {
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0 && id < 1e7) set.add(id);
}

// Claude Code records a registered hook command (e.g. `node "${CLAUDE_PLUGIN_ROOT}/hook.mjs" user-prompt`)
// VERBATIM with the path quote-wrapped: `node "/abs/hook.mjs" user-prompt`. A
// naive `.includes('hook.mjs user-prompt')` then fails because the `"` sits
// between the path and the subcommand — this was the bug that made the entire
// UserPromptSubmit injection surface invisible to citation-decay in every real
// install (tests only ever used unquoted commands, so it was never caught).
// Strip shell quotes before substring-matching so command detection is robust to
// plugin-cache vs symlinked-install AND quoted vs unquoted path forms.
function normalizeHookCommand(command) {
  return (command || '').replace(/["']/g, '');
}

/**
 * Walk every `hook_success` attachment in a transcript, invoking `fn` with the
 * quote-normalized command and the injected text (JSON additionalContext
 * unwrapped when present, else raw stdout). Shared by all injection extractors
 * so command-matching + JSON-unwrap logic lives in exactly one place.
 *
 * @param {string|null|undefined} transcriptPath
 * @param {(ctx: {command: string, text: string}) => void} fn
 * @param {object} [opts]
 * @param {boolean} [opts.mainOnly=false] If true, skip attachments on sidechain
 *   (subagent) transcript records. Mirrors extractCitationsFromTranscript's
 *   mainOnly so the citation-decay injected DENOMINATOR uses the same thread
 *   filter as the cited NUMERATOR — an obs injected only inside a subagent must
 *   not enter the denominator, else it streak-demotes despite being used there.
 */
function eachHookAttachment(transcriptPath, fn, opts = {}) {
  const { mainOnly = false } = opts;
  for (const entry of readTranscriptEntries(transcriptPath)) {
    if (entry.type !== 'attachment') continue;
    if (mainOnly && entry.isSidechain === true) continue;
    const att = entry.attachment;
    if (!att || att.type !== 'hook_success') continue;
    const stdout = att.stdout || '';
    if (!stdout) continue;
    // stdout is JSON wrapping additionalContext OR raw text (triggerErrorRecall
    // and the <memory-context> block write raw). Try JSON first, fall back to raw.
    let text = stdout;
    try {
      const parsed = JSON.parse(stdout);
      text = parsed?.hookSpecificOutput?.additionalContext || stdout;
    } catch {}
    fn({ command: normalizeHookCommand(att.command), text });
  }
}

// v34.x: UserPromptSubmit injection extractor. hook.mjs handleUserPrompt emits
// formatMemoryLine `- [type] title | Lesson: X (#NN)[ [verify-before-use]]`,
// which INJECTED_RE (anchored on `#NN [type]`) never matched — leaving this
// injection surface invisible to applyCitationDecay. The extractors are disjoint
// by design: PTR has `[type]` AFTER `#NN`, UPS has `(#NN)` at end-of-line.
//
// Line-scan with `- [` prefix gate so a lesson body containing a back-reference
// like "see (#999)" doesn't pollute the injected set (would streak-uncite an
// obs we never actually displayed as a top-level entry).
const UPS_LINE_PREFIX = '- [';
const UPS_ID_RE = new RegExp(`\\(#(${OBS_ID_DIGITS})\\)`, 'g');
// Quote-normalized (see normalizeHookCommand): real recorded command is
// `node "/abs/hook.mjs" user-prompt` → normalized to `node /abs/hook.mjs user-prompt`.
const UPS_COMMAND_SUFFIX = 'hook.mjs user-prompt';

// user-prompt-search.js formatResults emits `[mem] FYI — Related memories ...`
// then one `#NN <icon> title` row per obs (raw stdout, line-leading id). Distinct
// from the `<memory-context>` block (hook.mjs) — the two UPS injectors dedup obs
// by id at inject time, so they carry DISJOINT obs sets; both must be extracted
// or the FYI-carried (highest-importance keyContext) obs never reach decay.
const FYI_HEADER = '[mem] FYI — Related memories';
// Anchored at line start so `P#NN` past-question rows (user_prompts, different id
// space) and any `#NN` inside lesson text are NOT matched.
const FYI_LINE_ID_RE = new RegExp(`^#(${OBS_ID_DIGITS})\\s`);

/**
 * The injection FACES memory can reach the model through, as stored in
 * `citation_surface_log.surface` (schema v45). The first five are
 * query-conditioned — a row appears there because it MATCHED something — and
 * are the ones that feed the citation-decay denominator via extractAllInjected.
 * `keyctx` is the odd one out: an unconditional SessionStart render, recorded
 * for VISIBILITY only and promotion-only in the decay loop (see
 * extractInjectedFromKeyContext).
 *
 * `task_imperative` (v3.76) rides the SAME attachment as `ups` — one
 * `hook.mjs user-prompt` invocation writes the `<memory-context>` block and then the
 * imperative line — which is how it stayed unmetered since v3.23 while being a live
 * injection: the `ups` matcher gates on `<memory-context` and collects only `- [` rows.
 * The two faces therefore OVERLAP on attachments but never on ids.
 * `subagent` (v3.77, D#152) is the second one: pre-agent-inject.js appends the
 * memory block to a DISPATCHED subagent's task prompt via PreToolUse
 * `updatedInput`, and Claude Code writes that turn to
 * `<session>/subagents/agent-*.jsonl` — never to the parent transcript. See
 * NON_ATTACHMENT_SURFACES.
 * @type {ReadonlyArray<'pretool'|'ups'|'error_recall'|'fyi'|'task_imperative'|'keyctx'|'subagent'>}
 */
export const CITATION_SURFACES = [
  'pretool',
  'ups',
  'error_recall',
  'fyi',
  'task_imperative',
  'keyctx',
  'subagent',
];

// Single source of truth for "which attachment belongs to which face, and how
// its ids are read off". Both the per-face extractors below AND the one-pass
// extractInjectedBySurface dispatch through this table, so a face can never be
// taught to one path and forgotten on the other — the shape of miss that let
// UserPromptSubmit go unmetered for a whole minor version (v34.x) and that
// #10379 records as the repeat offender.
const SURFACE_MATCHERS = {
  pretool: {
    // Tighter than `computeCiteRecall`'s over-inclusive "any #NN in
    // non-assistant text" — only counts IDs the agent actually saw from us,
    // not user-pasted references or unrelated #NN tokens in tool output.
    accepts: ({ command }) => command.includes('pre-tool-recall'),
    collect: (text, add) => {
      for (const line of text.split('\n')) {
        const m = INJECTED_ROW_RE.exec(line);
        if (m) add(m[1]);
      }
    },
  },
  ups: {
    // The `<memory-context>` block emitted by hook.mjs handleUserPrompt.
    // Disjoint from pre-tool-recall by construction: PTR has `[type]` AFTER
    // `#NN`, UPS has `(#NN)` at end-of-line.
    accepts: ({ command, text }) => command.includes(UPS_COMMAND_SUFFIX) && text.includes('<memory-context'),
    collect: (text, add) => {
      for (const memLine of text.split('\n')) {
        if (!memLine.startsWith(UPS_LINE_PREFIX)) continue;
        // Take the LAST (#NN) on the line — formatMemoryLine puts the obs id
        // in trailing parens, possibly followed by ` [verify-before-use]`. Any
        // earlier (#NN) refs are inside title/lesson text.
        const matches = [...memLine.matchAll(UPS_ID_RE)];
        if (matches.length === 0) continue;
        add(matches[matches.length - 1][1]);
      }
    },
  },
  error_recall: {
    // hook.mjs triggerErrorRecall → `[claude-mem-lite] Related memories found
    // for this error:` followed by `  #NN [type] title` lines, delivered via
    // post-tool-use.sh. High-volume surface that NO extractor matched before
    // v3.47 — error-recall'd obs accrued injection_count but never reached
    // applyCitationDecay, so they could neither promote nor demote.
    accepts: ({ command, text }) =>
      command.includes('post-tool-use') && text.includes('Related memories found for this error'),
    collect: (text, add) => {
      // Per-line anchored: match only a row that STARTS with `#NN [type]` (after its
      // indent), NOT every such token in the block. The inlined lesson body (v3.16.x)
      // can quote another obs id, which must not enter the injected set; the trailing
      // `Use mem_get(ids=[...])` line (bare numbers) is excluded too.
      for (const line of text.split('\n')) {
        const m = INJECTED_ROW_RE.exec(line);
        if (m) add(m[1]);
      }
    },
  },
  fyi: {
    accepts: ({ command, text }) => command.includes('user-prompt-search') && text.includes(FYI_HEADER),
    collect: (text, add) => {
      for (const fyiLine of text.split('\n')) {
        const m = FYI_LINE_ID_RE.exec(fyiLine);
        if (m) add(m[1]);
      }
    },
  },
  task_imperative: {
    // Same hook entry as `ups`, different row. Gating on the emitter's own exported
    // prefix (not a copy of the wording) keeps the meter tied to the framing; gating on
    // the COMMAND too means a transcript that merely quotes the framing — a review of
    // this code, say — is not counted as an injection.
    accepts: ({ command, text }) =>
      command.includes(UPS_COMMAND_SUFFIX) && text.includes(TASK_IMPERATIVE_PREFIX),
    collect: (text, add) => {
      for (const line of text.split('\n')) {
        if (!line.startsWith(TASK_IMPERATIVE_PREFIX)) continue;
        // Trailing `(#NN)` is this lesson's own id; earlier ones are cross-references
        // inside the body (#8850 — an inlined lesson body must not pollute the set).
        const matches = [...line.matchAll(UPS_ID_RE)];
        if (matches.length === 0) continue;
        add(matches[matches.length - 1][1]);
      }
    },
  },
};

// The query-conditioned faces, in citation_surface_log label order. keyctx is
// absent on purpose: it has no hook attachment to walk.
const ATTACHMENT_SURFACES = Object.keys(SURFACE_MATCHERS);

/**
 * Split a transcript's injections by FACE in ONE walk.
 *
 * This is the primitive; `extractAllInjected` is its union. Pre-v45 each face
 * re-read and re-parsed the whole transcript (4 walks per Stop) AND the union
 * was a separate list that had to be kept in sync by hand — this collapses both
 * problems into the SURFACE_MATCHERS table.
 *
 * @param {string|null|undefined} transcriptPath
 * @param {{mainOnly?: boolean}} [opts]
 * @returns {{pretool: Set<number>, ups: Set<number>, error_recall: Set<number>, fyi: Set<number>}}
 *   Always all four keys, always Sets (empty on missing/unreadable transcript).
 */
export function extractInjectedBySurface(transcriptPath, opts = {}) {
  const out = {};
  for (const face of ATTACHMENT_SURFACES) out[face] = new Set();
  eachHookAttachment(
    transcriptPath,
    (ctx) => {
      for (const face of ATTACHMENT_SURFACES) {
        const matcher = SURFACE_MATCHERS[face];
        if (!matcher.accepts(ctx)) continue;
        const target = out[face];
        matcher.collect(ctx.text, (raw) => addObsId(target, raw));
      }
    },
    opts,
  );
  return out;
}

/**
 * Per-face count of how many DISTINCT hook attachments injected each id (D#193).
 *
 * `extractInjectedBySurface` returns Sets, which is right for every consumer that asks
 * "was this id injected" — and useless for the one question the path-A exclude set exists
 * to answer, which is "was it injected AGAIN". This is the same walk and the same
 * SURFACE_MATCHERS table, deliberately not a second copy of either: the repo's standing
 * defect here is a ruler that re-implements the shipped extractor and then measures its
 * own twin (`benchmark/cite-recall.mjs`'s hand-copied markers, v3.81.0).
 *
 * Counting is per ATTACHMENT, not per occurrence within one: one block listing `#42`
 * twice is one injection of #42, and the exclude set would not have suppressed it.
 *
 * @param {string|null|undefined} transcriptPath
 * @param {{mainOnly?: boolean}} [opts]
 * @returns {Record<string, Map<number, number>>} face -> (id -> attachments carrying it)
 */
export function countInjectedBySurface(transcriptPath, opts = {}) {
  const out = {};
  for (const face of ATTACHMENT_SURFACES) out[face] = new Map();
  eachHookAttachment(
    transcriptPath,
    (ctx) => {
      for (const face of ATTACHMENT_SURFACES) {
        const matcher = SURFACE_MATCHERS[face];
        if (!matcher.accepts(ctx)) continue;
        // Per-attachment set first, so two mentions inside ONE block count once.
        const here = new Set();
        matcher.collect(ctx.text, (raw) => addObsId(here, raw));
        for (const id of here) out[face].set(id, (out[face].get(id) || 0) + 1);
      }
    },
    opts,
  );
  return out;
}

// Per-face extractors: thin wrappers over the shared table, kept as named
// exports because callers and tests address individual faces.
function extractOneSurface(face, transcriptPath, opts) {
  return extractInjectedBySurface(transcriptPath, opts)[face];
}

/**
 * Extract observation IDs injected by pre-tool-recall hook in this transcript.
 * @param {string|null|undefined} transcriptPath
 * @returns {Set<number>} unique injected IDs (empty set on missing path/file)
 */
export function extractInjectedFromPreToolUse(transcriptPath, opts = {}) {
  return extractOneSurface('pretool', transcriptPath, opts);
}

/**
 * Extract observation IDs injected by the UserPromptSubmit `<memory-context>`
 * block (hook.mjs handleUserPrompt).
 * @param {string|null|undefined} transcriptPath
 * @returns {Set<number>}
 */
export function extractInjectedFromUserPromptSubmit(transcriptPath, opts = {}) {
  return extractOneSurface('ups', transcriptPath, opts);
}

/**
 * Extract observation IDs injected by the PostToolUse error-recall hint.
 * @param {string|null|undefined} transcriptPath
 * @returns {Set<number>}
 */
export function extractInjectedFromErrorRecall(transcriptPath, opts = {}) {
  return extractOneSurface('error_recall', transcriptPath, opts);
}

/**
 * Extract observation IDs injected by the user-prompt-search.js `[mem] FYI —
 * Related memories` block.
 * @param {string|null|undefined} transcriptPath
 * @returns {Set<number>}
 */
export function extractInjectedFromFyi(transcriptPath, opts = {}) {
  return extractOneSurface('fyi', transcriptPath, opts);
}

/**
 * Extract observation IDs rendered into the SessionStart / PreCompact
 * `<claude-mem-context>` File Lessons + Key Context sections (D#124).
 *
 * The odd one out among the extractors: this surface leaves no hook attachment
 * in the transcript — the block is written straight to stdout at SessionStart —
 * so there is nothing to parse. It reads the per-session marker instead, the
 * same file handleUserPrompt uses as its exclude-set, which by construction
 * lists what was ACTUALLY rendered (empty on quiet/adopted projects where the
 * sections never appear).
 *
 * Session-gated: a marker whose recorded session differs from the caller's is
 * another window's render and must not be attributed to this session.
 *
 * PROMOTION-ONLY (v3.66.1). Deliberately NOT part of extractAllInjected: the
 * other four faces are query-conditioned — a row appears there because it
 * MATCHED something, so its absence from the cited set is evidence it was not
 * useful. A Key Context render is unconditional and re-renders the same fixed
 * top-10 every session, so an uncited render is evidence of nothing but elapsed
 * time. Feeding these ids into the decay DENOMINATOR made the block consume
 * itself: keyObs gates on `importance >= 2` (hook-context.mjs), and a demotion
 * takes the common importance-2 row to 1, dropping it out of Key Context
 * permanently after 3 uncited sessions — each departure promoting the next row
 * into the same grinder. Callers must therefore intersect with the cited set
 * (see handleStop) so a CITED Key Context row is credited while an uncited one
 * is left alone.
 *
 * @param {object} [ctx]
 * @param {string} [ctx.runtimeDir]
 * @param {string} [ctx.project]
 * @param {string|null} [ctx.sessionId]
 * @returns {Set<number>}
 */
export function extractInjectedFromKeyContext({ runtimeDir, project, sessionId = null } = {}) {
  const ids = new Set();
  if (!runtimeDir || !project) return ids;
  try {
    const raw = readFileSync(join(runtimeDir, keyContextIdsFileName(project, sessionId)), 'utf8');
    const parsed = JSON.parse(raw);
    if (sessionId && parsed?.session && parsed.session !== sessionId) return ids;
    for (const id of Array.isArray(parsed?.ids) ? parsed.ids : []) addObsId(ids, id);
  } catch {
    /* no marker / torn write → nothing was rendered, fail open */
  }
  return ids;
}

/**
 * Union of the QUERY-CONDITIONED injection surfaces for a transcript:
 * pre-tool-recall + UserPromptSubmit `<memory-context>` + PostToolUse
 * error-recall + the user-prompt-search FYI block. Single integration point the
 * Stop handler calls for the decay DENOMINATOR.
 *
 * Key Context is intentionally absent (v3.66.1 — it was unioned here for one
 * release): every face above appears because a row matched something, so an
 * uncited appearance carries relevance information. An unconditional
 * SessionStart render does not. Callers wanting the Key Context ids ask
 * `extractInjectedFromKeyContext` directly and use them promotion-only.
 *
 * @param {string|null|undefined} transcriptPath
 * @param {object} [opts]
 * @param {boolean} [opts.mainOnly=false] Skip sidechain-injected IDs. The
 *   citation-decay caller passes true so the injected denominator matches the
 *   mainOnly cited numerator; the P4 access-bump caller omits it (broader).
 * @returns {Set<number>}
 */
export function extractAllInjected(transcriptPath, opts = {}) {
  return unionSurfaces(extractInjectedBySurface(transcriptPath, opts));
}

/**
 * Faces that are METERED (a citation_surface_log row) but deliberately kept OUT of the
 * citation-decay denominator, with the reason each is here. Membership is a decision,
 * never a default: `unionSurfaces` still walks every SURFACE_MATCHERS key, and a test
 * requires each face to be either in the union or listed here — so a face added later
 * cannot slip out of the denominator by being forgotten, only by being argued for.
 *
 * EMPTY since 2026-08-25, by decision rather than by default. `task_imperative` was its
 * only member; the history is kept because the exit criterion is the reusable part.
 *
 * - `task_imperative` (v3.76 -> admitted 2026-08-25): it was excluded on a stated
 *   condition — "if the imperative framing under-performs, the penalty lands on the
 *   LESSONS it carried (imperativePick selects high-value ones) rather than on the
 *   framing" — with the instruction to read the rate first. THE RATE WAS READ AND THE
 *   CONDITION IS NOT MET. Over the live 1113-transcript corpus: 44.1% (15/34), against
 *   pretool 38.3% (521/1362), fyi 10.9%, ups 8.4%, error_recall 6.2%.
 *
 *   citation_surface_log alone would NOT have supported this — it held n=8 over 2.1 days,
 *   because the FLAG had been parked for weeks while the METER had only run since v3.76.
 *   Re-deriving the rate by walking live transcripts with the shipped extractors turned
 *   n=8 into n=34. Worth keeping as a habit: when a face's row count looks too small to
 *   decide on, check whether the meter is younger than the behaviour before concluding
 *   there is no data.
 *
 *   Two caveats travel with the number. n=34, so its CI overlaps pretool's: "does not
 *   under-perform" is established, "leads" is not. And imperativePick returns a single
 *   top-ranked lesson, so this is a top-1 pick measured against faces that inject bulk
 *   lists — a confound in this face's favour that no amount of n removes.
 *
 *   Measured blast radius, same-corpus one-pass A/B (4-face union vs 5-face union in the
 *   SAME walk — never by subtracting two counts taken at different times): 22 new
 *   (session,id) rows = +0.90% of the denominator across 17 sessions, 9 of the 22 cited
 *   (40.9%).
 *
 *   COUNT THE STREAK ON THE RIGHT UNIT. The first version of this note said "zero of them
 *   uncited across the >=3 sessions UNCITED_STREAK_THRESHOLD requires, so no demotions" —
 *   measured on marginal sessions only, which is NOT the unit applyCitationDecay uses.
 *   `uncited_streak` is per-OBSERVATION and is driven by every face at once, so the real
 *   question is whether a marginal uncited resolution lands on a row the other four faces
 *   have already walked to 2. It does: 13 of the 22 marginal pairs are uncited, and of the
 *   16 distinct observations behind them FIVE sit at uncited_streak = 2 today — four of
 *   those (#8847, #8948, #10251, #10527) are ids this flip newly resolves as uncited, i.e.
 *   one imperative-only silent session from demotion. #8847 is imp=3 with cited_count=56.
 *   The product's own CLI calls that state "Active decay queue (uncited_streak >= 2, next
 *   miss -> demote)"; a release note claiming three sessions of margin contradicted it.
 *
 *   THE RESIDUAL RISK — CLOSED 2026-08-25, in rankImperativeCandidates rather than here.
 *   All 22 marginal rows are importance=3, and the pool took `LIMIT 50` ordered by
 *   importance DESC, so in the five largest projects (projects--mem 327, code-graph-mcp
 *   121, ubuntu-sec 56, daagu 53, agentsmd 51 — counted with the pool's OWN
 *   `liveObsFilterSql`, which is the only count that means anything here) the imp=3
 *   population alone exceeded the limit: a demotion 3->2 EVICTED a lesson from this face's
 *   candidate pool rather than down-ranking it — a feedback loop the four original
 *   denominator faces do not have, because they select on FTS relevance.
 *
 *   Measuring it turned up a bigger fact than the one filed. The limit sits in SQL,
 *   BEFORE the identifier-overlap filter, so it was never a ranking bound at all: the
 *   face could only ever pick from the 50 newest `importance >= 2` rows, which made every
 *   importance=2 lesson in those five projects unreachable no matter how well it matched.
 *   Replaying 373 real prompts against their own project's corpus
 *   (`benchmark/imperative-pool-replay.mjs`), the cap destroyed 7 of 85 picks outright and
 *   changed the top-1 in 3 of 78. The bound is now IMPERATIVE_POOL_BACKSTOP = 5000,
 *   documented there as an OOM backstop and not a relevance gate.
 *
 *   The demotion half of that paragraph is now MOOT rather than merely improved:
 *   D#179/D#198 stopped this loop writing `importance` at all, so neither a 3->2 nor a
 *   2->1 walk can happen through decay and the pool gate `>= 2` is no longer something
 *   citations move a row across. The widening still matters on its own terms — it is
 *   what makes importance=2 rows reachable by this face — but the eviction risk it used
 *   to carry is gone with the writes. `subagent` shares that pool. Still open in D#172:
 *   admitting `subagent` to the denominator, which is a separate decision needing the
 *   receiver-attributed cites merged asymmetrically.
 */
const DECAY_EXCLUDED_SURFACES = new Set();

/** @type {ReadonlyArray<string>} faces that DO feed the decay denominator. */
export const DECAY_DENOMINATOR_SURFACES = ATTACHMENT_SURFACES.filter((f) => !DECAY_EXCLUDED_SURFACES.has(f));

/**
 * Faces that leave NO hook attachment in the parent transcript. Because
 * DECAY_DENOMINATOR_SURFACES is derived from ATTACHMENT_SURFACES, these can
 * never enter the decay denominator by the derivation — they enter only if a
 * call site unions them in deliberately. That silence is the danger, so each is
 * named here with the reason it stays out:
 *
 * - `keyctx` (D#124): the SessionStart Key Context block re-renders the same
 *   fixed top-10 unconditionally, so an uncited render says nothing about
 *   relevance. handleStop feeds its ids in PROMOTION-ONLY — cited ones join the
 *   decay set, ignored ones never do. v3.66.0 fed them as a bare denominator
 *   and the block ate its own contents.
 * - `subagent` (D#152): the injection lands in a dispatched subagent's PROMPT
 *   and its cite signal lands in that subagent's OWN transcript, so it is not
 *   commensurable with `citedMain` — scoring it there would mark every
 *   subagent-only injection uncited by construction. Metered first (this is the
 *   whole point of D#152: the face's cite-rate is unknown), decided second.
 *   DECIDED 2026-08-25 (D#177, below): it IS in the decay loop now. It stays listed
 *   here because this constant answers "which faces leave no attachment", a fact
 *   about the transport — and that is exactly why its admission had to be wired at
 *   the call site instead of riding the DECAY_DENOMINATOR_SURFACES derivation.
 *
 *   D#164 read it (2026-08-25, 30 live sessions): 25.0% (12/48) on the house
 *   id-level caliber — above fyi (10.9%) and error_recall (6.2%), both of which
 *   ARE in the denominator, so "it performs badly" is not available as a reason
 *   to keep it out. The two costs that ARE measured: (1) admitting it means
 *   feeding its receiver-attributed cites alongside `citedMain`, which would flip
 *   3 main-face (session,id) pairs from demote to promote on a cite the main thread
 *   never made — 3 of the 1064 such pairs inside the 30 subagent-bearing sessions
 *   sampled (0.28%), or 3 of 1935 (0.16%) if you widen to every subagent-bearing
 *   session in the corpus; state which denominator you mean, the phrase "main-face
 *   ids" alone does not pin it; (2) the 33 rows it would newly add cite at 15.2% and are
 *   94% importance=3. That second cost was the LIMIT-50 eviction loop described under
 *   `task_imperative` above, shared because both faces select through
 *   rankImperativeCandidates — CLOSED 2026-08-25 by raising that pool's bound out of
 *   relevance range, so it is no longer an argument against admitting this face. Three
 *   of those 33 would still demote over that corpus, as down-ranks rather than evictions.
 *
 *   Its sibling was admitted on 2026-08-25; this one deliberately was NOT, and the
 *   difference is not the rate. task_imperative needed one line and no change to
 *   `citedMain`; this face needs the receiver-attributed cites merged in
 *   asymmetrically, and its numerator only became trustworthy on 2026-08-25 (see
 *   collectSubagentSurface — it credited cross-agent citations until then). Letting
 *   one release separate them also means the eviction loop they share is observed
 *   on one face before it acts on two. Tracked in D#172.
 *
 *   D#177 — ADMITTED (2026-08-25, v3.83.0). The asymmetric merge lives in hook.mjs
 *   handleStop, on by default with `CLAUDE_MEM_SUBAGENT_DECAY=0` as the off switch:
 *   `sub.injected` widens the denominator and `sub.cited` — already the per-file
 *   intersection with what the subagent surface itself injected — widens the numerator,
 *   in the same breath. This constant stays as it is either way: it describes which
 *   faces leave no ATTACHMENT, which is a fact about the transport, not about the
 *   denominator. Admission happens at the call site precisely because it cannot ride
 *   the `DECAY_DENOMINATOR_SURFACES` derivation without the cites travelling with it.
 *
 *   Re-measured on the 1122-transcript corpus (benchmark/citation-live-replay.mjs):
 *   the face reads 25.5% (14/55). Cost of the merge, same walk: 33 marginal (session,id)
 *   pairs join the denominator at 21.2% cited; behind the uncited ones sit 21 distinct
 *   observations, FIVE at uncited_streak = 2, each one demotion away from moving.
 *
 *   FOUR of the five are 3->2 down-ranks (#8597, #8847 with cited_count 56, #8948,
 *   #10246). THE FIFTH WAS AN EVICTION and the first draft of this note said there were
 *   none: at 2026-08-25 18:00Z, #10716 sat at importance = 2, so its next miss would take
 *   it to the floor of 1 (`IMPORTANCE_FLOOR`, a constant this loop no longer has — see the
 *   correction two paragraphs down) — under the `COALESCE(importance, 1) >= 2` gate in
 *   rankImperativeCandidates, which is the candidate pool of the very face being
 *   admitted. IMPERATIVE_POOL_BACKSTOP closed the 3->2 eviction in v3.82.0 and 2->1 was
 *   always documented as still evicting; writing "down-ranks, not evictions" required
 *   assuming the marginal population was all importance = 3, which one query refutes.
 *   Count it before repeating it.
 *
 *   THAT ROW WAS NO LONGER IN THAT STATE, AND AT THE TIME THE REASON WAS THIS LOOP (D#179).
 *   #10716 read importance 3 / uncited_streak 0 / demoted_at cleared, promoted by the
 *   session that WROTE THIS PARAGRAPH: `#10716` occurs 21 times in that session's assistant
 *   text, extractCitationsFromTranscript scans assistant text for `#NN`, and at that time
 *   applyCitationDecay raised `importance` on a hit. Discussing a memory was
 *   indistinguishable from applying it.
 *
 *   CORRECTED (v3.88.0, D#179/D#198): that mechanism is gone. Neither branch of this loop
 *   writes `importance` any more, so citing a row cannot promote it HERE and the specific
 *   self-promotion described above can no longer occur. Two things still hold and are the
 *   reason the paragraph is kept rather than deleted. The general warning stands — anything
 *   in this file quoting live decay STATE is perturbed by being written down, since the
 *   loop still writes `cited_count`, `uncited_streak`, `demoted_at` and the session
 *   columns on a citation — so quote it with a timestamp and prefer the structural claim
 *   (the marginal population is not all importance = 3) to the row that demonstrated it.
 *   And a citation can still reach `importance` by a SECOND path this loop does not own:
 *   `bumpCitationAccess` credits `access_count`, and the `boost` maintain op raises
 *   `importance` by 1 above `access_count > 3` (D#206, open).
 *
 *   Cross-crediting — a main-face id the main thread never cited but a subagent did — is
 *   3 pairs. The denominator giving 0.25% is DISTINCT (session,id) across the five decay
 *   faces inside subagent-bearing sessions (1181); 0.11% is that same caliber corpus-wide
 *   (2738). The per-face sums for the same populations are 1241 and 2878 — say which one
 *   you mean, because quoting one ratio against the other denominator is the exact error
 *   this sentence exists to prevent.
 *
 * A member here that the Stop path stops feeding becomes an all-zero face, not
 * a silently-demoting one — which is the failure mode worth keeping.
 * @type {ReadonlyArray<string>}
 */
export const NON_ATTACHMENT_SURFACES = ['keyctx', 'subagent'];

/**
 * Flatten a per-face breakdown into the single injected set the decay loop
 * takes. Derived — NOT a second hand-maintained face list — so adding a face to
 * SURFACE_MATCHERS automatically widens the denominator (v45; the pre-v45 union
 * enumerated the faces a second time and that is exactly how a face goes
 * unmetered), unless that face is argued into DECAY_EXCLUDED_SURFACES above.
 *
 * @param {Record<string, Set<number>>} bySurface
 * @returns {Set<number>}
 */
export function unionSurfaces(bySurface) {
  const out = new Set();
  for (const face of DECAY_DENOMINATOR_SURFACES) {
    for (const id of bySurface?.[face] || []) out.add(id);
  }
  return out;
}

/**
 * Cite-recall over ONE transcript file, using the SAME methodology as the
 * citation-decay loop: injected = extractAllInjected (OUR hook injections only),
 * cited = #NN in assistant text, ratio = |injected ∩ cited| / |injected|.
 *
 * Thread is keyed by FILE LOCATION, not the isSidechain field. Claude Code writes
 * each subagent's turns to a SEPARATE file (<session>/subagents/agent-*.jsonl),
 * NOT inline in the parent transcript (verified empirically: 0 isSidechain records
 * across 60 parent transcripts; the subagent files carry isSidechain=true). So a
 * whole subagent file IS the sidechain — aggregateProjectCiteRecall splits by path.
 *
 * @param {string} transcriptPath
 * @returns {{injected: number, cited: number, recalled: number, ratio: number}}
 */
// pre-agent-inject.js (CLAUDE_MEM_SUBAGENT_INJECT) APPENDS formatSubagentContext to a
// dispatched subagent's task prompt via PreToolUse updatedInput — a PROMPT-embedded
// injection, NOT a hook attachment. extractAllInjected (the attachment path) misses it,
// so the sidechain instrument read a false 0 ("subagents memory-blind") even while the
// dispatch surface was live. The block is `[Project memory — surfaced by your operator's
// claude-mem-lite ...]` followed by a `  #NN — <lesson>.` tag line.
const SUBAGENT_INJECT_MARKER = /surfaced by your operator's claude-mem-lite/;
// Row-anchored to the `#NN — ` tag so a #NN quoted inside the lesson body does NOT enter
// the injected set — same discipline as INJECTED_ROW_RE for the attachment surfaces.
const SUBAGENT_INJECT_ID_RE = new RegExp(`^\\s{0,4}#(${OBS_ID_DIGITS})\\s+—`);

/**
 * Extract observation ids injected into a subagent's PROMPT by pre-agent-inject.js
 * (formatSubagentContext). Only the `#NN — ` tag line counts; a body cross-reference is
 * ignored. Returns numeric ids.
 *
 * TYPE-GATED (audit R7 P1-1). Without `entry.type === 'user'` this scanned assistant text
 * too, so a subagent that merely QUOTED the block — reviewing this code, summarizing what it
 * was handed — had those ids counted as injected; and since collectSubagentSurface takes a
 * per-file `seen ∩ said` intersection, the same quotation credited them as cited, reading
 * 100% on one self-reference. SURFACE_MATCHERS.task_imperative defends the identical shape by
 * also gating on the command, for the reason stated in its docblock; this face had nothing.
 * That mattered beyond metering: `sub.injected` is a citation-decay ENTRY gate (hook.mjs) and
 * an allow-list for bumpCitationAccess → access_count → the `boost` op → importance.
 *
 * The gate value is MEASURED, not assumed (2026-09-05, 11 real subagent transcripts): the
 * dispatched task prompt is the FIRST entry of each subagent file and carries `type='user'`,
 * `role='user'`, `isSidechain=true`; the corpus holds assistant ×1036 / attachment ×973 /
 * user ×668. `tool_result` blocks ride a user entry too, but carry `content` rather than
 * `text`, so the `x?.text` map below already contributes nothing for them — same reasoning
 * extractUserTypedIds states for its own scan.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {Set<number>}
 */
export function extractInjectedFromSubagentPrompt(transcriptPath) {
  const ids = new Set();
  for (const entry of readTranscriptEntries(transcriptPath)) {
    if (entry.type !== 'user') continue;
    const c = entry.message?.content;
    const text =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n')
          : '';
    if (!text || !SUBAGENT_INJECT_MARKER.test(text)) continue;
    for (const bl of text.split('\n')) {
      const m = SUBAGENT_INJECT_ID_RE.exec(bl);
      if (m) addObsId(ids, m[1]);
    }
  }
  return ids;
}

/**
 * Locate the sidechain (subagent) transcripts belonging to ONE session, given
 * that session's main transcript path. Claude Code lays them out as
 * `<dir>/<sessionId>.jsonl` + `<dir>/<sessionId>/subagents/agent-<name>-<hash>.jsonl`,
 * so the directory is derived from the parent path — no directory scan, no
 * dependence on the CC session id being available at the call site.
 *
 * Two search shapes that look right and silently return nothing (#10801, and the
 * reason D#152 sat blocked): the files are NOT at the transcript directory's top
 * level, and grepping the PARENT transcript for `isSidechain` finds 0 records —
 * the flag lives inside the subagent files themselves.
 *
 * @param {string|null|undefined} transcriptPath main-thread transcript (.jsonl)
 * @returns {string[]} absolute paths, empty when the session dispatched no subagents
 */
export function findSubagentTranscripts(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return [];
  if (!transcriptPath.endsWith('.jsonl')) return [];
  const dir = join(transcriptPath.slice(0, -'.jsonl'.length), 'subagents');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => join(dir, n))
    .sort();
}

/**
 * Read the `subagent` face for ONE session: ids injected into dispatched
 * subagents' prompts, and the ids those subagents actually cited.
 *
 * `cited` is read from the SUBAGENT transcripts, not the parent — a lesson
 * handed to a subagent is cited (or not) in that subagent's own text, and
 * scoring it against the main thread would report 0% by construction. That is
 * also why the Stop path records this face in its own recordCitationSurfaces
 * call: one call carries one `cited` set for every face in it.
 *
 * UNIT — read this before reading the rate it produces (D#164 settled the first
 * half of it; the second half is still a live caveat).
 *
 * `injected` is unioned by id across the session's sidechain files, which is the
 * house caliber: every other face also counts an obs once per session no matter
 * how many times it was injected. `cited` is NOT unioned — an id is credited only
 * when the agent that RECEIVED it is the agent that cited it. This face is the
 * only one where injection and citation can land in different contexts, so the
 * union form silently counted "agent A was handed it, agent B mentioned it" as
 * adoption. Measured over 30 live sessions before the attribution was added:
 * 13/48 unioned vs 12/48 receiver-attributed.
 *
 * What is still biased HIGH: an id handed to three agents and cited by one counts
 * as one full hit rather than a third, because the id-level denominator collapses
 * the three dispatches into one. On the same corpus that is 48 ids over 82
 * (dispatch, id) PAIRS — not 82 files: the sessions hold ~268 sidechain transcripts and
 * most carry no injection — i.e. 25.0% id-level against 14.6% per-dispatch. Opportunity-level
 * accounting would need a denominator shape citation_surface_log does not have
 * (its key is (project, session, surface)), and changing that would put this face
 * on a different ruler from the other six — so the id-level number is the one
 * that is comparable to pretool/ups/fyi, and the per-dispatch number is the one
 * to quote when asking "does a dispatched agent use what it was handed".
 *
 * @param {string|null|undefined} transcriptPath main-thread transcript (.jsonl)
 * @returns {{injected: Set<number>, cited: Set<number>, files: number}}
 *   `cited` is always a subset of `injected`.
 */
export function collectSubagentSurface(transcriptPath) {
  const injected = new Set();
  const cited = new Set();
  let files = 0;
  for (const p of findSubagentTranscripts(transcriptPath)) {
    files++;
    // Per-file intersection, not two unions: the pairing is the whole point.
    const seen = extractInjectedFromSubagentPrompt(p);
    const said = extractCitationsFromTranscript(p);
    for (const id of seen) {
      injected.add(id);
      if (said.has(id)) cited.add(id);
    }
  }
  return { injected, cited, files };
}

export function computeThreadCiteRecall(transcriptPath) {
  const injected = extractAllInjected(transcriptPath);
  // Subagent files carry NO hook-attachment injection; pre-agent-inject.js injects into
  // the PROMPT (updatedInput). Fold that in so sidechain recall isn't a false 0. On a
  // main transcript this marker is absent → no-op.
  for (const id of extractInjectedFromSubagentPrompt(transcriptPath)) injected.add(id);
  const cited = extractCitationsFromTranscript(transcriptPath);
  let recalled = 0;
  for (const id of injected) if (cited.has(id)) recalled++;
  return {
    injected: injected.size,
    cited: cited.size,
    recalled,
    ratio: injected.size > 0 ? recalled / injected.size : 0,
  };
}

/**
 * Aggregate cite-recall across a project's transcripts, split MAIN vs SIDECHAIN
 * by file location. `txDir` = ~/.claude/projects/<encoded>/. Main = the top-level
 * <session>.jsonl files; sidechain = every <session>/subagents/agent-*.jsonl.
 * Descends ONE level into the literal `subagents` subdir only — no unbounded
 * recursion. mtime-gated by `cutoff` (epoch ms; 0 = no window).
 *
 * @param {string} txDir
 * @param {{cutoff?: number}} [opts]
 * @returns {{main: {injected:number,recalled:number,files:number}, sidechain: {injected:number,recalled:number,files:number,withInjections:number}}}
 */
export function aggregateProjectCiteRecall(txDir, { cutoff = 0 } = {}) {
  const main = { injected: 0, recalled: 0, files: 0 };
  const sidechain = { injected: 0, recalled: 0, files: 0, withInjections: 0 };
  const within = (p) => {
    try {
      return statSync(p).mtimeMs >= cutoff;
    } catch {
      return false;
    }
  };
  let entries;
  try {
    entries = readdirSync(txDir, { withFileTypes: true });
  } catch {
    return { main, sidechain };
  }
  for (const ent of entries) {
    const full = join(txDir, ent.name);
    if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      if (!within(full)) continue;
      const r = computeThreadCiteRecall(full);
      main.injected += r.injected;
      main.recalled += r.recalled;
      main.files++;
    } else if (ent.isDirectory()) {
      let subFiles;
      try {
        subFiles = readdirSync(join(full, 'subagents'));
      } catch {
        continue;
      }
      for (const sf of subFiles) {
        if (!sf.endsWith('.jsonl')) continue;
        const sp = join(full, 'subagents', sf);
        if (!within(sp)) continue;
        const r = computeThreadCiteRecall(sp);
        sidechain.injected += r.injected;
        sidechain.recalled += r.recalled;
        sidechain.files++;
        if (r.injected > 0) sidechain.withInjections++;
      }
    }
  }
  return { main, sidechain };
}

/**
 * True iff the transcript contains at least one non-whitespace text block from
 * a main-thread assistant turn. Gates the citation-decay loop so a tool-only
 * Stop doesn't lock an injection as "uncited" before the model has had a
 * chance to produce user-facing text. Per CLAUDE.md the cite contract is
 * "NEXT time you produce user-facing text" — not "same turn." Without this
 * gate, a turn that ends on tool_use sees applyCitationDecay run, set
 * last_decided_session_id, and freeze the verdict at uncited even though a
 * later turn in the same session would have cited correctly.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {boolean}
 */
export function hasMainThreadAssistantText(transcriptPath) {
  // Reverse-iterate so a turn that just produced text returns true on the FIRST entry
  // examined instead of walking the whole transcript; the pathological case (no text
  // anywhere) still walks everything, which is the degenerate state we want false for.
  // v2.80 polish. The short-circuit is now over an already-parsed array rather than over
  // JSON.parse calls, so it saves iteration rather than parsing — the parse is shared
  // with the other seven scanners of the same file (audit P2-8).
  const entries = readTranscriptEntries(transcriptPath);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'assistant' || !entry.message) continue;
    if (entry.isSidechain === true) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      if (block.text.trim().length > 0) return true;
    }
  }
  return false;
}

// IMPORTANCE_CAP (3) and IMPORTANCE_FLOOR (1) lived here until D#179/D#198 took
// `importance` out of this loop entirely; both are gone rather than kept unused.
// The reasoning behind the FLOOR is preserved because it is the sharpest statement
// of why decay must not move this column at all: both passive injection surfaces
// exclude importance 0 (pre-tool-recall.js requires >= 2, user-prompt-search.js
// requires >= 1), so a row demoted to 0 could never be re-injected -> never
// re-cited -> never recover. The floor bounded that one-way burial at the bottom
// of the scale; it could do nothing about the same mechanism one step up, where
// a 3 -> 2 evicts a row from the `>= 3` tier arm of the Key Context pool. Genuine
// noise still sinks via maintain's PENDING_PURGE pipeline, which keys on
// compressed_into (not importance) over injection_count = 0 rows.
const UNCITED_STREAK_THRESHOLD = 3;

// The adoption-rate gate (P5 ②) lived here, with computeCitationAdoption feeding
// it and a streak CAP as its other half. All three are gone — D#204.
//
// It suppressed the demote branch in a project whose cite-rate was ~0 over enough
// resolutions, on the reasoning that such a project has not adopted the `#NN`
// convention and a demotion there is a false negative it could never earn back.
// That reasoning was entirely about `importance`, which D#179 removed from this
// loop. What was left behind was inverted: the suppressed path capped
// uncited_streak at threshold-1 and so never returned to 0 without a citation,
// pinning those projects' rows at citeFactor 0.5x permanently, while an adopting
// project's rolled back to 1.0x every third resolution. The gate written to be
// gentler on non-adopting projects had become the only thing punishing them.
//
// The cap's stated purpose — keep the streak from climbing unbounded into the
// citeFactor floor — is served by the rollover itself, and served better, since
// the rollover also recovers. One path for every project.
//
// CLAUDE_MEM_CITATION_ADOPTION_THRESHOLD tuned the gate. It is now inert, and
// warned about rather than silently ignored (see applyCitationDecay): a setting
// that is accepted but means nothing is worse than one that is unsupported.
let adoptionThresholdWarned = false;

/**
 * D#61: a lesson injected live and then superseded mid-session (auto-dedup /
 * `supersedes=` save) leaves its citation crediting NOBODY — every consumer
 * excludes superseded rows by design, so the keeper that now carries the lesson
 * goes uncredited. Redirect such ids to their NUMERIC superseded_by keeper (one
 * hop; superseded_by is polymorphic — the typeof guard mirrors timeline-core).
 *
 * Returns a COPY: callers own their input sets. Shared by the per-obs decay loop
 * and the per-surface funnel so the two can't disagree about who gets credit —
 * the superseded invariant has been reopened once per surface that forgot it.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Set<number>|Iterable<number>} ids
 * @returns {Set<number>}
 */
export function redirectSupersededIds(db, project, ids) {
  const src = ids instanceof Set ? ids : new Set(ids || []);
  const out = new Set();
  // Both bail-outs copy: returning `src` would hand back the CALLER'S own Set
  // on the very paths that skip the redirect, quietly breaking the contract one
  // line below this and making a future caller's mutation action-at-a-distance.
  if (!db || !project) return new Set(src);
  let stmt;
  try {
    stmt = db.prepare(
      'SELECT superseded_by FROM observations WHERE id = ? AND project = ? AND superseded_at IS NOT NULL',
    );
  } catch (e) {
    debugCatch(e, 'redirectSupersededIds-prepare');
    return new Set(src);
  }
  for (const id of src) {
    const r = stmt.get(id, project);
    if (
      r &&
      typeof r.superseded_by === 'number' &&
      Number.isInteger(r.superseded_by) &&
      r.superseded_by > 0 &&
      r.superseded_by !== id
    ) {
      out.add(r.superseded_by);
    } else {
      out.add(id);
    }
  }
  return out;
}

/**
 * Apply the citation-feedback loop for one session: for each injected obs id,
 * decide cited vs uncited and mutate importance/streak/cited_count per spec.
 *
 * - cited: cited_count += 1, streak = 0, demoted_at cleared.
 * - uncited: streak += 1; if it reaches 3, streak = 0 and demoted_at is stamped.
 *
 * D#179 / D#198 — THIS LOOP NO LONGER WRITES `importance`, on any branch.
 * `importance` was carrying two jobs at once: a relevance prior AND a
 * pool-admission gate. Every injection surface gates on it — `>= 1` or `>= 2` on
 * the prompt faces, and hook-context's Key Context tier arms use `>= 1 / >= 2 /
 * >= 3` — so a decay-driven 3 -> 2 was not a down-rank, it removed the row from
 * the candidate POPULATION. That is the D#172 shape, confirmed on the imperative
 * pool (v3.82.0) and then on the Key Context pool, where 45 of ~106 pool rows sat
 * in the band where one demotion is an eviction (D#198).
 *
 * The ranking half of the loop is unaffected and was never the problem:
 * cited_count and uncited_streak still feed citeFactorClause, a BOUNDED
 * [0.4, 3.0] pure multiplier. So the feedback loop still responds to observed
 * agent behaviour — it just does so by re-ranking within the population instead
 * of by changing who is in it. Given that no available signal separates "acted on
 * this lesson" from "wrote about this lesson" (D#179; a release-note session
 * promotes exactly the rows it discusses, and the mention/application split
 * measured on the live corpus is not a bound in either direction), a bounded rank
 * shift is the right cost for a mis-read citation. An eviction is not.
 *
 * NOT covered by this change, and stated so nobody reads it as "citations can no
 * longer move importance": `bumpCitationAccess` credits `access_count`, and the
 * `boost` maintain op lifts `importance + 1` above `access_count > 3`. That is a
 * SECOND, independent citation -> importance path (obs #10911, D#206).
 *
 * Scope it correctly — an earlier version of this paragraph said "for any `#NN` in
 * assistant text", which has been false since v3.84.0 (f9a9eae). The credit is gated
 * on `buildCitationRelevanceSet`: the id must have been injected on one of the five
 * attachment faces, or by Key Context, or into a subagent, or typed by the user. A
 * bare mention of an id you were never shown credits nothing, and the revert switch
 * is CLAUDE_MEM_CITATION_RELEVANCE_GATE=off. What the gate does NOT ask is whether
 * you acted on the lesson — an injected id named only in prose is still credited —
 * which is why the path is open rather than closed.
 *
 * Measured before deciding to leave it (2026-09-02, live DB + 98 transcripts): 52
 * rows are currently boost-eligible; 25 of them are cited nowhere in the corpus, and
 * at most 3 could have crossed `access_count > 3` on citations even under an upper
 * bound that ignores the gate entirely. So the path is real and its effect is small.
 * It is untouched here because `access_count` has other writers (explicit recall /
 * get / timeline) and is also an input to noisePenaltyClause, so changing it is a
 * different decision with a different blast radius.
 * - per-(session, obs) idempotent via last_decided_session_id; re-running for
 *   the same session is a no-op (Stop hook may fire more than once).
 * - cross-project IDs are silently ignored by the WHERE clause.
 * - MEM_DISABLE_CITATION_DECAY=1 disables all writes; returns zeros.
 *
 * CONSTRUCT-VALIDITY ASSUMPTION (P5): a "citation" is operationally two signals,
 * neither of which is ground-truth behavioral impact:
 *   1. the literal `#NN` token appears in main-thread assistant text (citedIds), and
 *   2. (cite-back) the agent edited a file a prior lesson #NN had warned about —
 *      unioned into citedIds by the Stop handler before this call.
 * Signal 2 was added because signal 1 alone penalizes projects that act on a
 * lesson without typing its id. Even so, both are proxies, and nothing available
 * separates "acted on this lesson" from "wrote about this lesson".
 *
 * That imprecision used to be answered with a per-project adoption gate that
 * suppressed demotion where the cite-rate was ~0. It is gone (D#204), because the
 * cost it was insuring against — losing `importance`, i.e. dropping out of the
 * candidate pool — is gone too (D#179). What the proxies can still get wrong is
 * bounded on its own: a mis-read citation moves citeFactorClause within
 * [0.4, 3.0] and nothing else. The uncited streak rolls over at
 * UNCITED_STREAK_THRESHOLD in every project, so a lesson in a project that never
 * types `#NN` is not driven monotonically downward — it oscillates and recovers.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Set<number>|Iterable<number>} injectedIds
 * @param {Set<number>|Iterable<number>} citedIds
 * @param {string} sessionId — memory_session_id of the session being resolved
 * @returns {{promoted: number, demoted: number, touched: number}}
 */
export function applyCitationDecay(db, project, injectedIds, citedIds, sessionId) {
  const empty = { promoted: 0, demoted: 0, touched: 0 };
  if (process.env.MEM_DISABLE_CITATION_DECAY === '1') return empty;
  if (!db || !project || !sessionId) return empty;
  let injected = injectedIds instanceof Set ? injectedIds : new Set(injectedIds || []);
  if (injected.size === 0) return empty;
  let cited = citedIds instanceof Set ? citedIds : new Set(citedIds || []);

  injected = redirectSupersededIds(db, project, injected);
  cited = redirectSupersededIds(db, project, cited);

  // D#204: the adoption gate is gone. Its env override is still READ, once, only
  // to say out loud that it no longer does anything — the alternative is a
  // setting a user can configure and watch have no effect.
  if (!adoptionThresholdWarned && process.env.CLAUDE_MEM_CITATION_ADOPTION_THRESHOLD !== undefined) {
    adoptionThresholdWarned = true;
    try {
      process.stderr.write(
        '[claude-mem-lite] CLAUDE_MEM_CITATION_ADOPTION_THRESHOLD is set but no longer has any effect — ' +
          'the citation-decay adoption gate was removed (D#204). Unset it.\n',
      );
    } catch (e) {
      debugCatch(e, 'adoption-threshold-warn');
    }
  }

  const selectStmt = db.prepare(
    // superseded_at IS NULL: mirror the 4 injection SELECTs so a row superseded
    // mid-session (injected live, then auto-dedup supersedes it before this
    // decay resolves) is not decayed/streaked/mutated — defense-in-depth parity.
    'SELECT id, importance, uncited_streak, last_decided_session_id, last_cited_session_id FROM observations WHERE id = ? AND project = ? AND superseded_at IS NULL',
  );
  // decay_seen_count (v34) bumps on every resolution branch — gives
  // citation-stats a denominator that's same-source as cited_count, so the
  // ratio actually means "cite-rate" instead of mixing decay + UserPromptSubmit.
  // Promote also stamps last_cited_session_id (v41 promote-idempotency key) so a
  // same-session re-fire is a no-op. decay_seen_count is bumped by a PARAM, not a
  // literal +1: a FIRST resolution counts the obs into the denominator (1); a
  // cross-turn LATE upgrade of an already-resolved obs must NOT re-count it (0), else
  // cite-rate reads N/2 for a single injected-then-cited obs instead of N/1.
  // v46 (D#159): stamp decay_seen_at_first_cite on the FIRST citation only.
  //
  // `cited_count = 0` is evaluated against the row's PRE-UPDATE state (SQLite reads
  // the old values on the right-hand side of every SET), so it identifies the first
  // promote even though the same statement increments the counter. Once set, the
  // CASE re-writes the column to itself and later citations cannot move it.
  //
  // The stamped value INCLUDES this resolution (`decay_seen_count + @seenInc`), i.e.
  // "this memory was cited on the Nth time the decay loop saw it" — so 1 means cited
  // immediately, and a large N means it was injected-and-ignored N-1 times first.
  // That is exactly the quantity a future "stop injecting after K silent decays"
  // gate must be validated against.
  //
  // NAMED parameters: this statement now binds the same value twice, and a positional
  // list would silently renumber if a clause were ever reordered.
  const updatePromote = db.prepare(`
    UPDATE observations
       SET cited_count = cited_count + 1,
           uncited_streak = 0,
           demoted_at = NULL,
           last_decided_session_id = @session,
           last_cited_session_id = @session,
           decay_seen_count = decay_seen_count + @seenInc,
           decay_seen_at_first_cite = CASE
             WHEN COALESCE(cited_count, 0) = 0 THEN decay_seen_count + @seenInc
             ELSE decay_seen_at_first_cite
           END
     WHERE id = @id
  `);
  const updateStreakOnly = db.prepare(`
    UPDATE observations
       SET uncited_streak = uncited_streak + 1,
           last_decided_session_id = ?,
           decay_seen_count = decay_seen_count + 1
     WHERE id = ?
  `);
  // D#179/D#198: this branch no longer touches `importance`. It is the STREAK
  // ROLLOVER: at UNCITED_STREAK_THRESHOLD the streak resets to 0 and the moment
  // is stamped in demoted_at. The name and the returned `demoted` counter are
  // kept because both are load-bearing for callers and citation-stats; what
  // changed is that the rollover is now a bookkeeping event, not a change of
  // population membership. Resetting the streak (rather than pinning it) is what
  // holds citeFactorClause's documented [0, threshold-1] steady state.
  const updateDemote = db.prepare(`
    UPDATE observations
       SET uncited_streak = 0,
           last_decided_session_id = ?,
           demoted_at = ?,
           decay_seen_count = decay_seen_count + 1
     WHERE id = ?
  `);

  let promoted = 0,
    demoted = 0,
    touched = 0;
  const txn = db.transaction(() => {
    for (const id of injected) {
      const row = selectStmt.get(id, project);
      if (!row) continue; // cross-project or deleted
      const decidedThisSession = row.last_decided_session_id === sessionId;

      if (cited.has(id)) {
        // Promote path — idempotent on last_cited_session_id, NOT last_decided. This is
        // what lets a citation in a LATER turn upgrade an obs this session already
        // resolved as uncited: the contract is "cite NEXT time you produce user-visible
        // text," which may be several turns after injection. A promote resets
        // uncited_streak and lifts importance, so a same-session demotion that fired at
        // an earlier turn is naturally undone. Re-firing after the promote is a no-op.
        if (row.last_cited_session_id === sessionId) continue; // already promoted this session
        // touched/decay_seen only on the FIRST resolution — a late upgrade re-decides an
        // obs already in the injected denominator, so re-counting it would inflate both
        // decay_seen_count and the funnel's injected_n (cite-rate would read N/2, not N/1).
        const firstResolution = !decidedThisSession;
        updatePromote.run({
          session: sessionId,
          seenInc: firstResolution ? 1 : 0,
          id,
        });
        promoted++;
        if (firstResolution) touched++;
      } else {
        // Uncited path — idempotent on last_decided_session_id (unchanged): don't
        // re-streak an obs already resolved this session.
        if (decidedThisSession) continue;
        touched++;
        const nextStreak = (row.uncited_streak || 0) + 1;
        // D#204: one path for every project. The rollover both bounds the streak
        // (so citeFactorClause cannot sink toward its floor) and lets it recover
        // to 0 without requiring a citation.
        if (nextStreak >= UNCITED_STREAK_THRESHOLD) {
          updateDemote.run(sessionId, Date.now(), id);
          demoted++;
        } else {
          updateStreakOnly.run(sessionId, id);
        }
      }
    }
  });
  // IMMEDIATE (not the default DEFERRED): this txn reads each obs then writes it.
  // Under concurrent same-project Stop hooks a DEFERRED txn pins a read snapshot
  // first, and the second session's write then hits SQLITE_BUSY_SNAPSHOT — a
  // snapshot-upgrade conflict busy_timeout cannot resolve — silently dropping the
  // whole decay pass (promotes/demotes/streak + the paired funnel deltas). Taking
  // the write lock up front lets busy_timeout actually serialize the two sessions.
  try {
    txn.immediate();
  } catch (e) {
    debugCatch(e, 'applyCitationDecay-txn');
    return empty;
  }
  return { promoted, demoted, touched };
}

/**
 * R1 — persist one accumulating per-session row of the invocation→cite funnel.
 * Fed by applyCitationDecay's return: `injectedDelta` = obs RESOLVED this Stop
 * (touched), `citedDelta` = obs CITED this Stop (promoted). Idempotent against
 * Stop multi-fire by construction — a pure re-fire re-resolves nothing (touched=0
 * AND promoted=0), so the (0,0) gate below skips it. A later turn that resolves NEW
 * injections (touched>0) OR lands a cross-turn LATE citation (touched=0, promoted>0)
 * accumulates onto the same (project, session) row — the numerator must accrue even
 * when the denominator doesn't, so the gate skips only when BOTH deltas are 0.
 *
 * Unlike the per-obs cited_count/decay_seen_count counters (lifetime-cumulative,
 * session breakdown lost), this preserves the per-session series that
 * computeCitationFunnelTrend reads back as a trend. Telemetry only — every write
 * is wrapped so a citation_log failure can never break the Stop handler.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {string} sessionId — memory_session_id of the resolved session
 * @param {number} injectedDelta — obs resolved this run (applyCitationDecay.touched)
 * @param {number} citedDelta — obs cited this run (applyCitationDecay.promoted)
 */
export function recordCitationFunnel(db, project, sessionId, injectedDelta, citedDelta) {
  if (!db || !project || !sessionId) return;
  const inj = Number(injectedDelta) || 0;
  const cited = Math.max(0, Number(citedDelta) || 0);
  // Skip only when BOTH deltas are 0: a pure cross-turn late upgrade contributes
  // injectedDelta=0 (the obs was already counted at its first resolution) but
  // citedDelta>0, and that numerator must still fold onto the existing session row
  // (a late upgrade always has a prior first-resolution row). Pre-v41 the `inj<=0`
  // gate silently dropped it, under-counting cites in the funnel.
  if (inj <= 0 && cited <= 0) return; // nothing resolved this run → no row noise
  try {
    db.prepare(
      `
      INSERT INTO citation_log (project, memory_session_id, resolved_at, injected_n, cited_n)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project, memory_session_id) DO UPDATE SET
        injected_n = injected_n + excluded.injected_n,
        cited_n = cited_n + excluded.cited_n,
        resolved_at = excluded.resolved_at
    `,
    ).run(project, sessionId, Date.now(), inj, cited);
  } catch (e) {
    debugCatch(e, 'recordCitationFunnel');
  }
}

/**
 * v45 — persist this session's invocation→cite funnel split by INJECTION FACE.
 *
 * The aggregate twin (recordCitationFunnel) accumulates deltas because its
 * source is applyCitationDecay's per-run return. This one OVERWRITES, because
 * its source is the transcript, which only ever grows: recomputing after a Stop
 * re-fire yields the same-or-larger sets, so overwrite is idempotent by
 * construction AND lets a cross-turn late citation raise cited_n without
 * double-counting injected_n. No per-obs state, no idempotency key needed.
 *
 * NOT A PARTITION, and NOT comparable to citation_log in either direction.
 * Upward: an obs carried by two faces is counted in BOTH rows. Downward: the
 * Stop handler unions cite-back signals into the aggregate denominator AFTER
 * taking this breakdown, and those ids belong to no face (and skip the mainOnly
 * filter), so citation_log can exceed the surface sum too. A per-face view
 * answers "which face earns its budget", not "how was the budget divided".
 *
 * Ids are filtered to observations that actually exist in this project and are
 * not superseded (redirected to their keeper first), mirroring the decay loop's
 * SELECT — so a cross-project id, a deleted row, or an events-table id can't
 * inflate a face's denominator.
 *
 * Telemetry only: every write is wrapped, and a failure here can never break the
 * Stop handler.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {string} sessionId — the CLAUDE CODE session id, NOT the memory
 *   session id citation_log uses. Overwrite semantics make the key choice
 *   load-bearing: the memory session id is one file per PROJECT, so two
 *   concurrent CC sessions in one project share it and the second Stop would
 *   erase the first's counts. citation_log survives that only because it
 *   accumulates. Same reasoning as D#60 for applyCitationDecay.
 * @param {Record<string, Set<number>|Iterable<number>>} surfaceSets — keys must
 *   be CITATION_SURFACES members; unknown labels are dropped, not written.
 * @param {Set<number>|Iterable<number>} citedIds — this session's cited set
 *   (same one the decay loop uses)
 * @returns {Record<string, {injected: number, cited: number}>} what was written
 */
export function recordCitationSurfaces(db, project, sessionId, surfaceSets, citedIds) {
  const written = {};
  if (!db || !project || !sessionId || !surfaceSets || typeof surfaceSets !== 'object') return written;
  try {
    const cited = redirectSupersededIds(
      db,
      project,
      citedIds instanceof Set ? citedIds : new Set(citedIds || []),
    );
    const liveStmt = db.prepare(
      'SELECT 1 AS ok FROM observations WHERE id = ? AND project = ? AND superseded_at IS NULL',
    );
    const upsert = db.prepare(`
      INSERT INTO citation_surface_log (project, session_id, surface, resolved_at, injected_n, cited_n)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, session_id, surface) DO UPDATE SET
        injected_n = excluded.injected_n,
        cited_n = excluded.cited_n,
        resolved_at = excluded.resolved_at
    `);
    const now = Date.now();
    const rows = [];
    for (const [surface, rawIds] of Object.entries(surfaceSets)) {
      if (!CITATION_SURFACES.includes(surface)) continue; // unknown label → unqueryable row
      const ids = redirectSupersededIds(db, project, rawIds instanceof Set ? rawIds : new Set(rawIds || []));
      let injected = 0,
        citedN = 0;
      for (const id of ids) {
        if (!liveStmt.get(id, project)) continue;
        injected++;
        if (cited.has(id)) citedN++;
      }
      if (injected === 0) continue; // empty face → no telemetry noise
      rows.push([surface, injected, citedN]);
      written[surface] = { injected, cited: citedN };
    }
    if (rows.length === 0) return written;
    const txn = db.transaction(() => {
      for (const [surface, injected, citedN] of rows) {
        upsert.run(project, sessionId, surface, now, injected, citedN);
      }
    });
    txn();
  } catch (e) {
    debugCatch(e, 'recordCitationSurfaces');
  }
  return written;
}

/**
 * v45 — read citation_surface_log back as a per-face cite-rate leaderboard for
 * the window, highest injection volume first (the face spending the most budget
 * is the one worth aiming a lever at).
 *
 * `unavailable` is set — and ONLY set — when the read could not run (no handle,
 * missing table, unreadable DB). An empty window leaves it undefined. Without
 * this split both render as `surfaces: []`, which is exactly how a table that was
 * never created reads as "no data yet" for as long as the surface stays unmetered
 * (#10650): the reader swallows `no such table` into the debug log, and the only
 * caller-visible signal is a shape identical to the benign case.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{days?: number, project?: string|null}} [opts]
 * @returns {{window_days: number, surfaces: Array<{surface: string, injected: number, cited: number, rate: number, sessions: number}>, unavailable?: string}}
 */
export function computeSurfaceFunnel(db, { days = 7, project = null } = {}) {
  const empty = { window_days: days, surfaces: [] };
  if (!db) return { ...empty, unavailable: 'no database handle' };
  try {
    const windowStart = Date.now() - days * DAY_MS;
    const params = project ? [windowStart, project] : [windowStart];
    const rows = db
      .prepare(
        `
      SELECT surface,
             COALESCE(SUM(injected_n), 0)   AS injected,
             COALESCE(SUM(cited_n), 0)      AS cited,
             -- DISTINCT, not COUNT(*): rows are keyed (project, session,
             -- surface), so an unfiltered COUNT(*) counts project-sessions and
             -- over-reports "over N sessions" whenever a session spans projects.
             COUNT(DISTINCT session_id)     AS sessions
        FROM citation_surface_log
       WHERE resolved_at >= ? ${project ? 'AND project = ?' : ''}
    GROUP BY surface
    ORDER BY injected DESC, surface ASC
    `,
      )
      .all(...params);
    return {
      window_days: days,
      surfaces: rows.map((r) => ({ ...r, rate: r.injected > 0 ? r.cited / r.injected : 0 })),
    };
  } catch (e) {
    debugCatch(e, 'computeSurfaceFunnel');
    return { ...empty, unavailable: e?.message || 'query failed' };
  }
}

/**
 * R1 — read the per-session invocation→cite funnel as a windowed trend.
 * `window` aggregates [now-days, now]; `prior` aggregates [now-2*days, now-days)
 * so `delta_pt` shows whether invocation effectiveness is rising or falling.
 * `sessions` is the most-recent `limit` rows (per-session rate for the table view).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{days?: number, limit?: number, project?: string|null}} [opts]
 * @returns {{window_days: number, sessions: Array, window: {injected:number,cited:number,rate:number}, prior: {injected:number,cited:number,rate:number}, delta_pt: number|null}}
 */
export function computeCitationFunnelTrend(db, { days = 7, limit = 10, project = null } = {}) {
  const rate = (cited, inj) => (inj > 0 ? cited / inj : 0);
  const empty = {
    window_days: days,
    sessions: [],
    window: { injected: 0, cited: 0, rate: 0 },
    prior: { injected: 0, cited: 0, rate: 0 },
    delta_pt: null,
  };
  if (!db) return empty;
  try {
    const now = Date.now();
    const windowStart = now - days * DAY_MS;
    const priorStart = now - 2 * days * DAY_MS;
    const projClause = project ? 'AND project = ?' : '';

    const sessions = db
      .prepare(
        `
      SELECT project, memory_session_id, resolved_at, injected_n, cited_n
        FROM citation_log
       WHERE 1=1 ${projClause}
    ORDER BY resolved_at DESC
       LIMIT ?
    `,
      )
      .all(...(project ? [project, limit] : [limit]))
      .map((r) => ({ ...r, rate: rate(r.cited_n, r.injected_n) }));

    const agg = (fromTs, toTs) => {
      const params = toTs === null ? [fromTs] : [fromTs, toTs];
      if (project) params.push(project);
      const upper = toTs === null ? '' : 'AND resolved_at < ?';
      const row = db
        .prepare(
          `
        SELECT COALESCE(SUM(injected_n), 0) AS injected, COALESCE(SUM(cited_n), 0) AS cited
          FROM citation_log
         WHERE resolved_at >= ? ${upper} ${projClause}
      `,
        )
        .get(...params);
      return { injected: row.injected, cited: row.cited, rate: rate(row.cited, row.injected) };
    };

    const windowAgg = agg(windowStart, null);
    const priorAgg = agg(priorStart, windowStart);
    const delta_pt =
      priorAgg.injected > 0 ? Number(((windowAgg.rate - priorAgg.rate) * 100).toFixed(1)) : null;

    return { window_days: days, sessions, window: windowAgg, prior: priorAgg, delta_pt };
  } catch (e) {
    debugCatch(e, 'computeCitationFunnelTrend');
    return empty;
  }
}
