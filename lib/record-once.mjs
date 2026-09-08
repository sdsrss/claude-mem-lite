// lib/record-once.mjs — "has this condition already been logged recently, for this project?"
//
// Extracted from lib/schema-skew.mjs when a SECOND unhealable DB-open family needed the same
// dedup (a database file that is not a database). Both callers run inside `openDb()`'s catch,
// where the contract is return-null-never-throw, and both log a multi-line stack trace on a
// condition that repeats on every single hook fire until a human intervenes — the shape that
// put >=648 identical lines in one day's runtime/hook-errors/ before the skew round.
//
// Copying the implementation instead would be this repo's named twin-drift class, on a
// function whose two hard properties (total, fails-toward-recording) were each paid for with
// a review round.
//
// TOTAL by contract — every path returns a boolean and nothing escapes. The first version of
// the skew dedup called `getSessionId()` from inside the catch, which is not a read: it MINTS
// and writes a session id, so an unwritable runtime dir turned `openDb()` itself into a
// thrower. Keep every filesystem call in this file inside its own try.
//
// FAILS TOWARD RECORDING — an unreadable or unwritable marker must never silence the log.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One hour. The condition persists until the user acts, so "record it once, ever" would be
 * defensible; an hour keeps the log's remaining job (when did this start, is it still
 * happening) answerable at <=24 lines/day/project.
 */
export const RELOG_INTERVAL_MS = 60 * 60 * 1000;

/**
 * @param {string} runtimeDir Where the marker lives.
 * @param {string} markerPrefix Distinguishes conditions; the project is appended to it.
 * @param {string} project Marker scope. PER PROJECT, deliberately: one shared marker keyed on
 *   a per-project value let two projects on one data dir overwrite each other's key, so every
 *   fire recorded again — measured at 8 fires / 2 projects → 8 records. Anything falsy
 *   collapses to one shared file, which is a worse dedup rather than a crash.
 * @param {string} key Re-record when this changes: new information is not the fault already
 *   logged.
 * @param {{now?: number, intervalMs?: number}} [opts]
 * @returns {boolean} true = write the log line now
 */
export function shouldRecordOnce(
  runtimeDir,
  markerPrefix,
  project,
  key,
  { now = Date.now(), intervalMs = RELOG_INTERVAL_MS } = {},
) {
  try {
    const scope = String(project || 'unscoped').replace(/[^A-Za-z0-9._-]/g, '_');
    const file = join(runtimeDir, markerPrefix + scope);
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'));
      if (prev.key === key && typeof prev.ts === 'number' && now - prev.ts < intervalMs) return false;
    } catch {
      /* absent, unreadable or corrupt → record */
    }
    try {
      // The dir may not exist yet: hook-shared creates RUNTIME_DIR at module scope, but the
      // `ups` face does not import it, so on a fresh data dir the first marker write failed
      // silently and the SECOND fire recorded again.
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ key, ts: now }), { mode: 0o600 });
    } catch {
      /* an unwritable marker must not suppress the record */
    }
    return true;
  } catch {
    return true;
  }
}
