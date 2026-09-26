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
// latest report (`refreshStructuredSummary`) or, without one, the observation titles
// (`refreshObservationTitles`), SessionStart's /clear-or-/compact path fills the row's gaps
// (`fillFastSummaryGaps`), and hook-llm.mjs's upgrade writes the model's fields except a
// report's Done / Not done. (The /exit-restart fallback in hook.mjs inserts only for a
// session with no row at all.) Inserting instead left one live session with 37 rows in 65 minutes, which
// is 9 and 10 of the top ten session search hits for its own vocabulary.
//
// Which writer wins a field depends on where the row's Done / Not done came from, and `notes`
// is the column that records it (see REPORT_NOTES): the assistant's own report beats the
// model's summary, which beats the last observation titles. Without that record a first-turn
// title fallback looked as authoritative as a report, and a report's "nothing left" looked
// like a gap to fill.
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
 * `notes` value of a row whose completed / remaining_items are the assistant's own Done /
 * Not done report without Failed / Uncertain lines (with them, `notes` holds those lines, which
 * mark a report just as well). The other values: 'fast' — no report, `completed` is the last
 * observation titles, a fallback; 'llm' (or '' on rows the model worker inserted) — the
 * model's summary. Nothing renders `notes`; FTS indexes it at weight 1, which is why the tag
 * is a single token nobody types.
 */
export const REPORT_NOTES = 'fastreport';

/** SQL predicate over an unqualified row: its Done / Not done are a report. */
export const HAS_REPORT_SQL = "COALESCE(notes, '') NOT IN ('fast', 'llm', '')";

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
 * SessionStart's previous-session write when the session already has a row. This path has
 * the opening prompt, the last observation titles and the handoff's unfinished list, so:
 *  - `request` is filled only when empty;
 *  - `completed` is REPLACED by fresh titles on a no-report row ('fast'), whose own
 *    `completed` is an older set of the same titles, and only filled when empty otherwise;
 *  - `remaining_items` is filled when empty, except on a report row, where '' is the report
 *    saying nothing is left.
 * The row moves to `now`: this runs at the moment the previous session ended, which is what
 * its own INSERT used to record, and Last Session orders by it.
 */
export function fillFastSummaryGaps(db, { id, values, limits, now }) {
  const safe = scrubRecord('session_summaries', {
    request: values.request || '',
    completed: values.completed || '',
    remaining_items: values.remaining || '',
  });
  const completed = truncate(safe.completed, limits.completed);
  db.prepare(
    `
    UPDATE session_summaries
    SET request = CASE WHEN COALESCE(request, '') = '' THEN ? ELSE request END,
        completed = CASE
          WHEN COALESCE(notes, '') = 'fast' AND ? <> '' THEN ?
          WHEN COALESCE(completed, '') = '' THEN ?
          ELSE completed END,
        remaining_items = CASE
          WHEN ${HAS_REPORT_SQL} THEN remaining_items
          WHEN COALESCE(remaining_items, '') = '' THEN ?
          ELSE remaining_items END,
        created_at = ?,
        created_at_epoch = ?
    WHERE id = ?
  `,
  ).run(
    truncate(safe.request, limits.request),
    completed,
    completed,
    completed,
    truncate(safe.remaining_items, limits.remaining),
    now.toISOString(),
    now.getTime(),
    id,
  );
}

/**
 * Stop's write on a turn whose tail carries no report, for a row that has never held one
 * ('fast'): its `completed` is the observation-title fallback, so the current titles replace
 * the earlier ones. A report or a model summary is left alone, and so is everything when
 * there are no titles. The timestamp is not touched.
 */
export function refreshObservationTitles(db, { id, completed, limits }) {
  const safe = scrubRecord('session_summaries', { completed: completed || '' });
  const value = truncate(safe.completed, limits.completed);
  if (!value) return;
  db.prepare(`UPDATE session_summaries SET completed = ? WHERE id = ? AND COALESCE(notes, '') = 'fast'`).run(
    value,
    id,
  );
}

/**
 * Stop's write when the session already has a row and this turn's tail carries a Done or
 * Not done section: the latest report replaces the earlier one.
 *
 * `completed` is replaced only by a non-empty Done, so a tail that lists only what is left
 * keeps what was done. `remaining_items` is replaced even by an empty Not done: a report
 * with a Done and no Not done says nothing is left. `notes` becomes this report's Failed /
 * Uncertain lines, or REPORT_NOTES without them, so the row is marked as holding a report
 * and an earlier report's lines are not kept as if they described this one. The timestamp is
 * not touched.
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
        notes = ?
    WHERE id = ?
  `,
  ).run(completed, completed, truncate(safe.remaining_items, limits.remaining), notes || REPORT_NOTES, id);
}
