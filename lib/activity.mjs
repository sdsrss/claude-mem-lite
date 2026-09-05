// lib/activity.mjs — activity namespace data layer (T7 v2.31)
// Pure functions over the events table. No I/O beyond the passed-in db handle.
//
// Activity events are NOT memdir-compatible types; they live here precisely
// so they don't pollute the L1 system-prompt memory section.

import { sanitizeFtsQuery } from '../utils.mjs';
import { scrubRecord } from './scrub-record.mjs';
import { saveObservation } from './save-observation.mjs';
// Pure title-only builder: this query runs on the EVENTS table, which has no
// lesson_learned column — the lesson-escape variant would be a SQL error here.
import { buildNotLowSignalSql } from './low-signal-patterns.mjs';
import { OBS_TYPE_SET } from './obs-types.mjs';

// Observation types (mirrors the observations.type enum) — events carry a wider
// set, so promotion maps the extras (lesson/bug/observation) onto valid obs types.
const OBS_TYPES = OBS_TYPE_SET;
const EVENT_TO_OBS_TYPE = { bug: 'bugfix', lesson: 'discovery', observation: 'discovery' };

/**
 * Canonical event_type enum — mirrors the events.event_type CHECK constraint.
 * Single source of truth for CLI validation, hook-llm (future T9), and any
 * other caller that needs to guard against invalid types before INSERT.
 * Order matches the DDL; frozen to prevent accidental mutation.
 */
export const EVENT_TYPES = Object.freeze([
  'bugfix',
  'lesson',
  'bug',
  'discovery',
  'refactor',
  'feature',
  'observation',
  'decision',
]);

/**
 * Insert one event. Returns the new id (Number cast from BigInt).
 *
 * @param {object} db better-sqlite3 handle
 * @param {object} params
 * @param {string} params.project
 * @param {string} params.event_type  one of the CHECK-constrained enum values
 * @param {string} params.title
 * @param {string|null} [params.body]
 * @param {string[]|null} [params.file_paths]  stored as JSON array
 * @param {string|null} [params.git_sha]
 * @param {number} [params.importance=1]
 * @param {number} [params.created_at_epoch=Date.now()]
 * @returns {number} lastInsertRowid
 */
export function saveEvent(
  db,
  {
    project,
    event_type,
    title,
    body = null,
    file_paths = null,
    git_sha = null,
    importance = 1,
    created_at_epoch = Date.now(),
  },
) {
  // Scrub secrets at the single write choke-point so BOTH the auto-capture
  // (persistHaikuSummary event branch, raw Haiku output) and the CLI /bug,/lesson
  // paths are covered — title/body otherwise land verbatim and are FTS-indexed,
  // searchable, and exportable (HIGH-2 at-rest leak).
  const safe = scrubRecord('events', { title, body });
  const info = db
    .prepare(
      `
    INSERT INTO events (project, event_type, title, body, file_paths, git_sha, importance, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      project,
      event_type,
      safe.title,
      safe.body,
      file_paths ? JSON.stringify(file_paths) : null,
      git_sha,
      importance,
      created_at_epoch,
    );
  return Number(info.lastInsertRowid);
}

/**
 * Fetch one event by id, bumping accessed_count + last_accessed_epoch.
 * Returns the row (access bump already applied) or undefined.
 */
export function getEvent(db, id) {
  db.prepare(
    `UPDATE events SET accessed_count = accessed_count + 1, last_accessed_epoch = ? WHERE id = ?`,
  ).run(Date.now(), id);
  return db.prepare(`SELECT * FROM events WHERE id = ?`).get(id);
}

/**
 * FTS5 search filtered by project (and optionally event_type).
 * Excludes superseded events. Returns up to `limit` rows ordered by FTS rank.
 */
export function searchEvents(db, query, { project, type = null, limit = 10 } = {}) {
  const q = sanitizeFtsQuery(query);
  if (!q) return [];
  const typeClause = type ? 'AND e.event_type = ?' : '';
  const sql = `
    SELECT e.*
    FROM events_fts
    JOIN events e ON e.id = events_fts.rowid
    WHERE events_fts MATCH ?
      AND e.project = ?
      AND e.superseded_at_epoch IS NULL
      ${typeClause}
    ORDER BY events_fts.rank
    LIMIT ?
  `;
  const params = type ? [q, project, type, limit] : [q, project, limit];
  return db.prepare(sql).all(...params);
}

/**
 * Most recent N events for a project (excluding superseded).
 * Uses idx_events_project_created (T6.1) — index-only sort, no temp B-tree.
 */
export function recentEvents(db, { project, type = null, limit = 20 } = {}) {
  const typeClause = type ? 'AND event_type = ?' : '';
  const sql = `
    SELECT * FROM events
    WHERE project = ? AND superseded_at_epoch IS NULL ${typeClause}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `;
  const params = type ? [project, type, limit] : [project, limit];
  return db.prepare(sql).all(...params);
}

/**
 * P2(b) one-time backfill: promote insight-bearing events (body present,
 * importance>=minImportance) into searchable observations. mem_search / passive
 * injection never read the events table, so explicit /bug /lesson history and
 * high-value auto-captured events were unfindable. Each promoted event is marked
 * with superseded_at_epoch ONLY (superseded_by_id is a self-FK → events(id), so an
 * observation id there fails the FK on the real DB — the marker alone gives
 * idempotency) so re-runs skip it. The source event row is kept (activity log
 * intact), just retired.
 *
 * @returns {{eligible:number, promoted:number, deduped:number, skipped:number}}
 */
export function promoteInsightEvents(
  db,
  { project = null, minImportance = 2, execute = false, limit = 5000 } = {},
) {
  const projClause = project ? 'AND project = ?' : '';
  // Exclude low-signal titles (Modified X / Error while … / Worked on X / raw tool
  // logs): those are the activity-log noise the events split was meant to contain,
  // so "lesson-bearing" must not sweep them into search. Same canonical clause the
  // re-enrich candidate query uses.
  const sql = `
    SELECT id, project, event_type, title, body, file_paths, importance, created_at_epoch
    FROM events
    WHERE body IS NOT NULL AND TRIM(body) != '' AND importance >= ?
      AND superseded_at_epoch IS NULL
      AND ${buildNotLowSignalSql('')}
      ${projClause}
    ORDER BY created_at_epoch DESC LIMIT ?
  `;
  const rows = project
    ? db.prepare(sql).all(minImportance, project, limit)
    : db.prepare(sql).all(minImportance, limit);
  if (!execute) return { eligible: rows.length, promoted: 0, deduped: 0, skipped: 0 };

  // Mark the source event promoted. Only `superseded_at_epoch` — NOT
  // superseded_by_id: that column is a self-FK (REFERENCES events(id)), so storing
  // an observation id there fails a FOREIGN KEY constraint on the real DB (the
  // :memory: test had FK enforcement off, which masked it). The marker alone gives
  // idempotency (superseded_at_epoch IS NULL selects unpromoted rows).
  const mark = db.prepare('UPDATE events SET superseded_at_epoch = ? WHERE id = ?');
  // Each event's (observation insert + mark) is one transaction so a failure can
  // never leave an orphan observation with an unmarked source event.
  const promoteOne = db.transaction((ev, type, files) => {
    const r = saveObservation(db, {
      content: ev.body,
      title: ev.title || undefined,
      type,
      importance: ev.importance,
      project: ev.project,
      files,
      // The event body IS the insight → also seed lesson_learned (capped like the
      // manual-save contract) so it lands in the high-weight FTS field.
      lesson_learned: ev.body.slice(0, 500),
      now: new Date(ev.created_at_epoch),
    });
    mark.run(Date.now(), ev.id);
    return r;
  });
  let promoted = 0;
  let deduped = 0;
  let skipped = 0;
  for (const ev of rows) {
    const type = OBS_TYPES.has(ev.event_type)
      ? ev.event_type
      : EVENT_TO_OBS_TYPE[ev.event_type] || 'discovery';
    let files = [];
    try {
      const p = JSON.parse(ev.file_paths || '[]');
      if (Array.isArray(p)) files = p;
    } catch {
      /* keep [] */
    }
    try {
      const r = promoteOne(ev, type, files);
      if (r.kind === 'saved') promoted++;
      else deduped++;
    } catch {
      skipped++;
    } // a single bad event must not abort the whole backfill
  }
  return { eligible: rows.length, promoted, deduped, skipped };
}
