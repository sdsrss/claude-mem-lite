// The non-LLM session summary — one shape, three callers.
//
// Audit 2026-08-22 P2-9. hook.mjs carried three hand-copied versions of "read this
// session's first prompt and its last few observation titles, scrub them, insert a
// session_summaries row": the Stop-time fast path, the SessionStart previous-session
// path, and the SessionStart /exit-restart fallback. They had already drifted — the
// 13-column INSERT was retyped each time, and the truncation limits split 600/600/400
// against 300/200. Copy-and-miss on exactly this kind of triplicate is what broke
// v3.35.2, and the comment in one of these blocks announcing "parity with the other"
// is the tell that parity was being maintained by hand.
//
// ONE ROW PER SESSION. Stop fires once per assistant TURN (the session file survives it
// since R10-P1-1), so every writer here runs many times against a session that already has
// a row. Each one therefore lands on the session's newest row (`newestSummaryId`) and only
// INSERTs when there is none: Stop refreshes the structural Done / Not done extract from the
// latest report (`refreshStructuredSummary`), SessionStart's /clear path fills the row's
// empty fields (`fillFastSummaryGaps`), and hook-llm.mjs's upgrade overwrites with the
// model's fields. Inserting instead left one live session with 37 rows in 65 minutes, which
// is 9 and 10 of the top ten session search hits for its own vocabulary.
//
// NOT collapsed in here: hook-llm.mjs's summary insert. That row is produced by the
// model and carries two more columns (lessons, key_decisions); it is a different
// record that happens to share a table, and merging it would mean inventing a shape
// that fits neither.
import { scrubRecord } from './scrub-record.mjs';
import { truncate } from '../format-utils.mjs';

/** Column list + placeholder row, written once. */
const INSERT_SQL = `
  INSERT INTO session_summaries
  (memory_session_id, project, request, investigated, learned, completed, next_steps,
   remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
  VALUES (?, ?, ?, '', '', ?, '', ?, '[]', '[]', ?, ?, ?)
`;

/**
 * Per-caller truncation limits. These are NOT unified on purpose: the Stop path stores
 * roughly twice what the two SessionStart paths do, and every one of these strings is
 * re-injected into a later session's context. Collapsing them to one number changes how
 * much text the product injects, which is a measurable behaviour change and not
 * something a refactor gets to decide. Passed explicitly so the difference is visible
 * at the call site instead of living in three retyped `truncate(...)` arguments.
 */
export const FAST_SUMMARY_LIMITS = {
  stop: { request: 200, completed: 600, remaining: 600, notes: 400 },
  sessionStart: { request: 200, completed: 300, remaining: 200, notes: 400 },
  exitRestart: { request: 200, completed: 300, remaining: 200, notes: 400 },
};

/**
 * The two reads every fast summary is built from: the session's opening prompt, and the
 * titles of its most recent observations.
 *
 * The observation filter is `compressed_into` ONLY, deliberately — it is NOT a half-written
 * `liveObsFilterSql` waiting to be completed. `completed` is the session's own history, and a
 * lesson a later save overturned still happened; dropping it here would misreport the session
 * that did the work. This is the same ruling audit 2026-08-14 F4 made for the sibling field
 * `session_handoffs.completed`, where the scope guard lives in
 * `tests/audit-silent-20260814.test.mjs`. Audit R8 §11.3 proposed adding `superseded_at IS
 * NULL` to both; both were rejected on this reasoning. The filter that DOES belong on a
 * superseded row is the one guarding standing policy re-presented to a later session
 * (`key_decisions`), not history.
 *
 * @returns {{request: string, completed: string}} raw (unscrubbed, untruncated) values
 */
export function readFastSummarySource(db, sessionId) {
  const firstPrompt = db
    .prepare(
      `
    SELECT prompt_text FROM user_prompts
    WHERE content_session_id = ?
    ORDER BY prompt_number ASC LIMIT 1
  `,
    )
    .get(sessionId);
  const recentObs = db
    .prepare(
      `
    SELECT title FROM observations
    WHERE memory_session_id = ? AND COALESCE(compressed_into, 0) = 0
    ORDER BY created_at_epoch DESC, id DESC LIMIT 5
  `,
    )
    .all(sessionId);
  return {
    request: firstPrompt?.prompt_text || '',
    completed: recentObs
      .map((o) => o.title)
      .filter(Boolean)
      .join('; '),
  };
}

/**
 * Scrub, truncate, insert. Raw values go into scrubRecord and truncation happens after,
 * at the bind site — a secret straddling the truncation boundary would otherwise fall
 * below scrubSecrets' length floors and survive into the row (privacy review, v3.x).
 * That ordering is the reason this function exists in one copy.
 *
 * @param {{request?: string, completed?: string, remaining?: string, notes?: string}} values raw
 * @param {{request: number, completed: number, remaining: number, notes: number}} limits
 */
export function insertFastSummary(db, { sessionId, project, values, limits, now }) {
  const safe = scrubRecord('session_summaries', {
    request: values.request || '',
    completed: values.completed || '',
    remaining_items: values.remaining || '',
    notes: values.notes || 'fast',
  });
  db.prepare(INSERT_SQL).run(
    sessionId,
    project,
    truncate(safe.request, limits.request),
    truncate(safe.completed, limits.completed),
    truncate(safe.remaining_items, limits.remaining),
    truncate(safe.notes, limits.notes),
    now.toISOString(),
    now.getTime(),
  );
}

/**
 * The session's summary row every later write lands on: its newest, by the same order Last
 * Session reads (`created_at_epoch DESC, id DESC`). Rows older than it exist only from before
 * one-row-per-session, or from two writers racing an empty session.
 *
 * @returns {number|null}
 */
export function newestSummaryId(db, sessionId) {
  const row = db
    .prepare(
      `
    SELECT id FROM session_summaries
    WHERE memory_session_id = ?
    ORDER BY created_at_epoch DESC, id DESC
    LIMIT 1
  `,
    )
    .get(sessionId);
  return row ? row.id : null;
}

/**
 * SessionStart's previous-session write when the session already has a row: fill the fields
 * that are empty, keep the ones that are not, and move the row to `now`.
 *
 * Existing content wins because it is either the model's upgrade or Stop's structural extract
 * of the agent's own report, and this path only has the opening prompt, the last observation
 * titles and the handoff's unfinished list. The timestamp moves because this runs at the
 * moment the previous session ended, which is what its own INSERT used to record, and Last
 * Session orders by it.
 */
export function fillFastSummaryGaps(db, { id, values, limits, now }) {
  const safe = scrubRecord('session_summaries', {
    request: values.request || '',
    completed: values.completed || '',
    remaining_items: values.remaining || '',
  });
  db.prepare(
    `
    UPDATE session_summaries
    SET request = CASE WHEN COALESCE(request, '') = '' THEN ? ELSE request END,
        completed = CASE WHEN COALESCE(completed, '') = '' THEN ? ELSE completed END,
        remaining_items = CASE WHEN COALESCE(remaining_items, '') = '' THEN ? ELSE remaining_items END,
        created_at = ?,
        created_at_epoch = ?
    WHERE id = ?
  `,
  ).run(
    truncate(safe.request, limits.request),
    truncate(safe.completed, limits.completed),
    truncate(safe.remaining_items, limits.remaining),
    now.toISOString(),
    now.getTime(),
    id,
  );
}

/**
 * Stop's write when the session already has a row and this turn's tail carries a Done or
 * Not done section: the latest report replaces the earlier one.
 *
 * `completed` is replaced only by a non-empty Done, so a tail that lists only what is left
 * keeps what was done. `remaining_items` is replaced even by an empty Not done: a report
 * with a Done and no Not done says nothing is left. Failed / Uncertain lines replace
 * `notes`; without them, notes left by an earlier report are reset to the 'fast' tag
 * rather than kept as if they described this one. The timestamp is not touched.
 *
 * @param {{completed?: string, remaining?: string, notes?: string}} values raw
 */
export function refreshStructuredSummary(db, { id, values, limits }) {
  const safe = scrubRecord('session_summaries', {
    completed: values.completed || '',
    remaining_items: values.remaining || '',
    notes: values.notes || '',
  });
  const completed = truncate(safe.completed, limits.completed);
  const notes = truncate(safe.notes, limits.notes);
  db.prepare(
    `
    UPDATE session_summaries
    SET completed = CASE WHEN ? <> '' THEN ? ELSE completed END,
        remaining_items = ?,
        notes = CASE WHEN ? <> '' THEN ? WHEN notes IN ('fast', 'llm', '') THEN notes ELSE 'fast' END
    WHERE id = ?
  `,
  ).run(completed, completed, truncate(safe.remaining_items, limits.remaining), notes, notes, id);
}
