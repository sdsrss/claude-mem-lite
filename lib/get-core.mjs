// lib/get-core.mjs — shared core for the CLI `get` / MCP `mem_get` twin (P2-12,
// audit 2026-08-14). The 23-element OBS_FIELDS array was duplicated verbatim in
// mem-cli.mjs and server.mjs (the 16-vs-24-column export data-loss incident's
// precursor shape), and the session detail field sets had ALREADY diverged
// (MCP 13 fields vs CLI 6 — a `remaining_items` FTS hit was a dead end in the
// CLI detail view). Field sets + the access-bump fetch live here; each face
// keeps its own header/label rendering conventions.

import { autoBoostIfNeeded } from '../search-scoring.mjs';
import { COMPRESSED_AUTO, COMPRESSED_PENDING_PURGE } from '../utils.mjs';

/** Every observation column `get --fields` accepts, in render order. */
export const OBS_FIELDS = [
  'id',
  'type',
  'title',
  'subtitle',
  'narrative',
  'text',
  'facts',
  'concepts',
  'lesson_learned',
  'search_aliases',
  'files_read',
  'files_modified',
  'project',
  'created_at',
  'memory_session_id',
  'prompt_number',
  'importance',
  'related_ids',
  'access_count',
  'branch',
  'superseded_at',
  'superseded_by',
  // R10 P2-5: without this column the retraction notice below has nothing to read, and a
  // row that dedup merged or compression folded away renders as an ordinary live one.
  'compressed_into',
  'last_accessed_at',
];

/** Session-summary detail render set — the FULL set (both faces). The CLI's old
 *  6-field subset made notes/remaining_items/files_* searchable-but-unrenderable. */
export const SESSION_DETAIL_FIELDS = [
  'id',
  'request',
  'investigated',
  'learned',
  'completed',
  'next_steps',
  'remaining_items',
  'files_read',
  'files_edited',
  'notes',
  'project',
  'created_at',
  'memory_session_id',
  'prompt_number',
];

/** User-prompt detail render set. The CLI face rendered only prompt_text +
 *  content_session_id while MCP rendered prompt_number and created_at too — the same
 *  searchable-but-invisible shape SESSION_DETAIL_FIELDS was created to close, reopened on
 *  the prompt source (audit 2026-08-22, P2-6). */
export const PROMPT_DETAIL_FIELDS = [
  'id',
  'prompt_text',
  'content_session_id',
  'prompt_number',
  'created_at',
];

/** Event detail render set. `body` carries the distilled lesson persistHaikuSummary
 *  writes (lesson_learned || narrative). */
export const EVENT_DETAIL_FIELDS = [
  'id',
  'event_type',
  'title',
  'body',
  'project',
  'importance',
  'file_paths',
  'git_sha',
  'created_at',
];

/**
 * Fetch user-prompt detail rows, oldest-first.
 * No access bump: prompts are not ranked, so reading one is not a usage signal.
 */
export function fetchPromptDetail(db, ids) {
  const ph = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM user_prompts WHERE id IN (${ph}) ORDER BY created_at_epoch ASC`)
    .all(...ids);
}

/**
 * Fetch session-summary detail rows, oldest-first.
 *
 * Audit 2026-09-02 P2-4: the session leg was the one detail source with no shared fetch.
 * Its FIELD SET already came from `SESSION_DETAIL_FIELDS` here, so the twin was down to the
 * query itself — typed out in `mem-cli.mjs renderSessionRows` and in `server.mjs mem_get`.
 * A shared field list over two hand-copied SELECTs is the half-collapsed shape that lets a
 * `WHERE` clause drift while the columns stay in step.
 *
 * No access bump, matching `fetchPromptDetail`: session summaries are not ranked, so
 * reading one is not a usage signal.
 */
export function fetchSessionDetail(db, ids) {
  const ph = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM session_summaries WHERE id IN (${ph}) ORDER BY created_at_epoch ASC`)
    .all(...ids);
}

/**
 * Fetch event detail rows, oldest-first.
 *
 * The events table has no `created_at` ISO column — only `created_at_epoch`. Both faces
 * used to derive the ISO string themselves; deriving it once here means EVENT_DETAIL_FIELDS
 * can name `created_at` like every other field set and neither face special-cases it.
 */
export function fetchEventDetail(db, ids) {
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM events WHERE id IN (${ph}) ORDER BY created_at_epoch ASC`)
    .all(...ids);
  return rows.map((r) => ({
    ...r,
    created_at: r.created_at_epoch ? new Date(r.created_at_epoch).toISOString() : null,
  }));
}

/**
 * Fetch observation detail rows: bump access_count/last_accessed_at (reading a
 * detail IS an access signal — feeds noisePenalty's ratio guard), run the
 * auto-boost heuristic, and return rows oldest-first.
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} ids
 * @returns {object[]} full observation rows (SELECT *), created order
 */
export function supersededNotice(row) {
  if (!row) return null;
  if (!row.superseded_at) {
    // R10 P2-5: `superseded_at` is only ONE of the two ways a row stops being live.
    // liveObsFilterSql is `COALESCE(compressed_into,0) = 0 AND superseded_at IS NULL`, and
    // every list surface applies both — so a merged or compressed row is reachable only by
    // naming its id, which is exactly what a stale citation in a transcript does. `get`
    // rendered it with no marker at all, bumped its access_count, fed auto-boost, and let
    // mem_update write to it. Three states, three different instructions to the reader.
    const c = row.compressed_into;
    if (typeof c === 'number' && c > 0) {
      return `⚠ MERGED — folded into #${c}. Read #${c} instead; the fields below are the absorbed copy.`;
    }
    if (c === COMPRESSED_AUTO) {
      return '⚠ COMPRESSED — auto-hidden as low-value or summarized into a digest. Hidden from every search and list.';
    }
    if (c === COMPRESSED_PENDING_PURGE) {
      return '⚠ PENDING PURGE — queued for permanent deletion by the next purge_stale run. Hidden from every search and list.';
    }
    if (typeof c === 'number' && c < 0) {
      return '⚠ HIDDEN — this row is not live. Hidden from every search and list.';
    }
    return null;
  }
  // Every LIST surface (search / recent / timeline / browse / injection) filters
  // superseded rows out, so the only way to reach one is to name its id — which is
  // exactly what a stale citation in a transcript, a note, or an old handoff does.
  // Both detail faces render fields in OBS_FIELDS order, putting `lesson_learned`
  // near the top and `superseded_at` ~15 lines below it: a reader taking the first
  // actionable line away from `mem_get(1)` takes the RETRACTED advice and never
  // reaches the marker. Hoist it to the header so the retraction is read first.
  const by = typeof row.superseded_by === 'number' ? `#${row.superseded_by}` : null;
  return by
    ? `⚠ RETRACTED — superseded by ${by}. Read ${by} instead; the fields below are the withdrawn version.`
    : '⚠ RETRACTED — superseded (auto-dedup or merge). The fields below are the withdrawn version.';
}

export function fetchObsDetail(db, ids) {
  const ph = ids.map(() => '?').join(',');
  try {
    db.prepare(
      `UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id IN (${ph})`,
    ).run(Date.now(), ...ids);
    autoBoostIfNeeded(db, ids);
  } catch {
    /* non-critical: FTS5 trigger may fail on corrupted index */
  }
  return db
    .prepare(`SELECT * FROM observations WHERE id IN (${ph}) ORDER BY created_at_epoch ASC`)
    .all(...ids);
}
