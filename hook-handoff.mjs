// claude-mem-lite: Cross-session handoff extraction, detection, and injection
// Extracted for testability — hook.mjs has module-level side effects

import { basename } from 'path';
import {
  truncate,
  extractMatchKeywords,
  tokenizeHandoff,
  isSpecificTerm,
  scrubSecrets,
  LOW_SIGNAL_TITLE,
  EDIT_TOOLS,
  isMetaTriggerPrompt,
  notLowSignalTitleClause,
  neutralizeContextDelimiters,
} from './utils.mjs';
import { scrubRecord } from './lib/scrub-record.mjs';
import {
  HANDOFF_EXPIRY_CLEAR,
  HANDOFF_EXPIRY_EXIT,
  HANDOFF_ANCHOR_MAX_AGE,
  HANDOFF_MATCH_THRESHOLD,
  CONTINUE_KEYWORDS,
} from './hook-shared.mjs';
// T10d: import the whole module (not a named export) so tests can spy on
// gitStateModule.readGitState via vi.spyOn. Named-import bindings are
// immutable in ESM and cannot be mocked after the fact.
import * as gitStateModule from './lib/git-state.mjs';
import * as taskReaderModule from './lib/task-reader.mjs';
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
  const prompts = ccScope
    ? db
        .prepare(
          `
        SELECT prompt_text FROM user_prompts
        WHERE content_session_id = ? AND (cc_session_id = ? OR cc_session_id IS NULL)
        ORDER BY prompt_number ASC LIMIT 5
      `,
        )
        .all(sessionId, ccScope)
    : db
        .prepare(
          `
        SELECT prompt_text FROM user_prompts
        WHERE content_session_id = ?
        ORDER BY prompt_number ASC LIMIT 5
      `,
        )
        .all(sessionId);
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

  const seen = new Set();
  const uniquePrompts = sourcePrompts.filter((p) => {
    const t = truncate(p.prompt_text, 200);
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  let workingOn = uniquePrompts.map((p) => truncate(p.prompt_text, 200)).join(' → ');

  if (subjectPrompts.length === 0) {
    const fallback = db
      .prepare(
        `
      SELECT title FROM observations
      WHERE project = ? AND ${liveObsFilterSql('')}
        AND COALESCE(importance, 1) >= 3
        AND ${notLowSignalTitleClause('')}
      ORDER BY created_at_epoch DESC LIMIT 1
    `,
      )
      .get(project);
    if (fallback?.title) {
      workingOn = `(carry-forward subject) ${truncate(fallback.title, 180)}`;
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
  const obsWindowClause = ccWindowStart !== null ? 'AND created_at_epoch >= ?' : '';
  const obsWindowParams = ccWindowStart !== null ? [ccWindowStart] : [];

  // 2. Completed — from observations (include narrative for richer handoff)
  const completed = db
    .prepare(
      `
    SELECT title, type, narrative FROM observations
    WHERE memory_session_id = ? AND COALESCE(compressed_into, 0) = 0 ${obsWindowClause}
    ORDER BY created_at_epoch DESC LIMIT 15
  `,
    )
    .all(sessionId, ...obsWindowParams);

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
  const isValidFile = (f) =>
    f &&
    f.length > 2 &&
    f.includes('/') &&
    f.indexOf('/', 1) !== -1 &&
    !f.startsWith('/dev/') &&
    !f.startsWith('/proc/') &&
    !f.startsWith('/tmp/');
  if (episodeSnapshot?.files) episodeSnapshot.files.filter(isValidFile).forEach((f) => fileSet.add(f));
  const obsFiles = db
    .prepare(
      `
    SELECT files_modified FROM observations
    WHERE memory_session_id = ? AND files_modified IS NOT NULL ${obsWindowClause}
    ORDER BY created_at_epoch DESC LIMIT 10
  `,
    )
    .all(sessionId, ...obsWindowParams);
  for (const row of obsFiles) {
    try {
      JSON.parse(row.files_modified)
        .filter(isValidFile)
        .forEach((f) => fileSet.add(f));
    } catch {}
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
  const decisions = db
    .prepare(
      `
    SELECT title FROM observations
    WHERE memory_session_id = ? AND COALESCE(importance, 1) >= 2
      AND ${liveObsFilterSql('')} ${obsWindowClause}
    ORDER BY created_at_epoch DESC LIMIT 10
  `,
    )
    .all(sessionId, ...obsWindowParams)
    .filter((d) => d.title && !LOW_SIGNAL_TITLE.test(d.title))
    .slice(0, 5);

  // 6. Match keywords
  const allText = [workingOn, ...completed.map((c) => c.title).filter(Boolean), unfinished].join(' ');
  const keywords = extractMatchKeywords(allText, [...fileSet]);

  // T10d: capture HEAD sha so detectContinuationIntent can anchor on it later.
  // Best-effort — failures (non-git dir, missing binary, timeout) yield null.
  let gitShaAtHandoff = null;
  try {
    gitShaAtHandoff = gitStateModule.readGitState({ cwd: process.cwd() }).headSha || null;
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
    key_decisions: decisions.map((d) => d.title).join('\n'),
    match_keywords: keywords,
  });
  const safeKeyFiles = JSON.stringify([...fileSet].slice(0, 20).map((f) => scrubSecrets(String(f))));
  db.prepare(
    `
    INSERT INTO session_handoffs (project, type, session_id, working_on, completed, unfinished, key_files, key_decisions, match_keywords, created_at_epoch, git_sha_at_handoff)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, type, session_id) DO UPDATE SET
      working_on = excluded.working_on,
      completed = excluded.completed,
      unfinished = excluded.unfinished,
      key_files = excluded.key_files,
      key_decisions = excluded.key_decisions,
      match_keywords = excluded.match_keywords,
      created_at_epoch = excluded.created_at_epoch,
      git_sha_at_handoff = excluded.git_sha_at_handoff
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
            ORDER BY created_at_epoch DESC LIMIT 1
          `,
            )
            .get(project, currentSha, currentCcSessionId)
        : db
            .prepare(
              `
            SELECT created_at_epoch, match_keywords FROM session_handoffs
            WHERE project = ? AND git_sha_at_handoff = ?
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
        WHERE project = ? AND type = 'clear' AND session_id = ?
        ORDER BY created_at_epoch DESC LIMIT 1
      `,
        )
        .get(project, currentCcSessionId)
    : db
        .prepare(
          `
        SELECT created_at_epoch, match_keywords FROM session_handoffs
        WHERE project = ? AND type = 'clear'
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
        ORDER BY created_at_epoch DESC
      `,
        )
        .all(project, currentCcSessionId)
    : db
        .prepare(
          `
        SELECT type, match_keywords, created_at_epoch FROM session_handoffs
        WHERE project = ? ORDER BY created_at_epoch DESC
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
  const handoffs = currentCcSessionId
    ? db
        .prepare(
          `
        SELECT * FROM session_handoffs
        WHERE project = ?
          AND ((type = 'clear' AND session_id = ?) OR (type = 'exit' AND session_id != ?))
        ORDER BY created_at_epoch DESC LIMIT 5
      `,
        )
        .all(project, currentCcSessionId, currentCcSessionId)
    : db
        .prepare(
          `
        SELECT * FROM session_handoffs
        WHERE project = ? ORDER BY created_at_epoch DESC LIMIT 5
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

export function renderHandoffInjection(db, project, currentCcSessionId = null) {
  const handoff = pickHandoffToInject(db, project, currentCcSessionId);
  if (!handoff) return null;
  return renderHandoffFromRow(handoff, db, project);
}

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
    lines.push('## Working On', neutralizeContextDelimiters(handoff.working_on), '');
  }
  if (handoff.completed) {
    lines.push(
      '## Completed',
      ...neutralizeContextDelimiters(handoff.completed)
        .split('\n')
        .map((l) => `- ${l}`),
      '',
    );
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
        ...neutralizeContextDelimiters(pending)
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
        lines.push('## Key Files', neutralizeContextDelimiters(files.map((f) => basename(f)).join(', ')), '');
    } catch {}
  }
  if (handoff.key_decisions) {
    lines.push(
      '## Key Decisions',
      ...neutralizeContextDelimiters(handoff.key_decisions)
        .split('\n')
        .map((l) => `- ${l}`),
      '',
    );
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
      ORDER BY created_at_epoch DESC LIMIT 1
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
        ORDER BY ABS(created_at_epoch - ?) ASC LIMIT 1
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
      if (summary.completed) lines.push(neutralizeContextDelimiters(summary.completed));
      if (summary.remaining_items)
        lines.push(`Remaining: ${neutralizeContextDelimiters(summary.remaining_items)}`);
      if (summary.next_steps) lines.push(`Next steps: ${neutralizeContextDelimiters(summary.next_steps)}`);
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
