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
    ORDER BY created_at_epoch DESC LIMIT 5
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
