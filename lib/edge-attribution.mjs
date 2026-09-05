// P1 (D#78): per-(obs, file) edge attribution for pre-tool-recall injections.
//
// pre-tool-recall triggers purely on file-edge matches (observation_files),
// but 89% of lessons never mention their attached file — the edges record
// "touched during the episode", not "about this file". A mis-bound edge (the
// environment-gotcha-on-unrelated-file class from D#65) therefore re-fires on
// every future session. This module gives each edge its own hit/miss record so
// P2 can stop firing edges with a consecutive-miss streak, WITHOUT touching
// the per-obs decay counters on observations (#8641: separate policies — an
// edge going quiet must not bury the lesson on other injection surfaces).
//
// Wiring: pre-tool-recall.js records { filePath → obsIds } in the session
// cooldown file; hook.mjs handleStop reads it back (readPreRecallFileEdges),
// unions the same citedMain set the per-obs decay uses, and calls
// resolveEdgeAttribution inside the same text-floor-gated block.

import { readFileSync, existsSync } from 'fs';
import { debugCatch } from '../utils.mjs';
import { fileMatchClause, fileMatchParams } from './file-edge-match.mjs';
import { cooldownPathFor } from './cooldown-path.mjs';

// Path scheme comes from lib/cooldown-path.mjs. This copy was the untested one of the
// three, and its drift zeros Stop-side attribution without a single error (ARCH-2).
const cooldownFileFor = cooldownPathFor;

/**
 * Read the session cooldown file and return the file→obsIds edge list for
 * attribution. Entries without a non-empty obsIds array (legacy bare-number
 * entries, no-lesson files, event-only injections) are skipped.
 *
 * @param {string} runtimeDir
 * @param {string|null|undefined} ccSessionId Claude Code session id (cooldown file key)
 * @returns {Array<{filePath: string, obsIds: number[]}>}
 */
export function readPreRecallFileEdges(runtimeDir, ccSessionId) {
  if (!runtimeDir || !ccSessionId) return [];
  const file = cooldownFileFor(runtimeDir, ccSessionId);
  if (!existsSync(file)) return [];
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const edges = [];
  for (const [filePath, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.obsIds)) continue;
    const obsIds = entry.obsIds.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 1e7);
    if (obsIds.length === 0) continue;
    edges.push({ filePath, obsIds });
  }
  return edges;
}

/**
 * Resolve one session's pre-tool file-edge injections as hit (cited) or miss
 * (uncited), updating the per-edge counters on observation_files.
 *
 * Edge matching uses the SAME predicate as pre-tool-recall's trigger query —
 * lib/file-edge-match.mjs is the shared source — so attribution lands exactly
 * on the edges that caused (or would cause) the injection.
 *
 * Semantics mirror applyCitationDecay's split idempotency keys:
 * - miss: guarded on last_resolved_session_id — never double-streaks a session.
 * - hit:  guarded on last_cited_session_id — a citation landing in a LATER
 *   turn of the same session still resets the streak (undoes that session's
 *   miss) without re-counting inject_count.
 * - MEM_DISABLE_CITATION_DECAY=1 disables all writes (same kill switch as the
 *   per-obs loop — edge attribution is part of the decay feedback family).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Array<{filePath: string, obsIds: number[]}>} fileEdges
 * @param {Set<number>|Iterable<number>} citedIds
 * @param {string} sessionId — the CLAUDE CODE session id (the cooldown file's
 *   own key), NOT the memory session id: memory sessions rotate on /clear /
 *   resume / 12h expiry while the cooldown file lives for the whole CC
 *   session, so a rotating key would re-resolve the same injection as a fresh
 *   miss after every rotation (review D#78 — 2 rotations ≈ a full K=3 streak
 *   from ONE real injection).
 * @param {{mainInjectedIds?: Set<number>}} [opts] — when mainInjectedIds is
 *   given, only obsIds present in it (or in citedIds) are resolved. The
 *   cooldown file has no sidechain marker, so subagent-triggered injections
 *   land in it too; gating on the main-thread injected set mirrors the
 *   per-obs loop's mainOnly discipline (hook.mjs:625) — an obs injected only
 *   inside a subagent must not accrue misses it can never repay.
 * @returns {{hits: number, misses: number, touchedEdges: number}}
 */
export function resolveEdgeAttribution(db, project, fileEdges, citedIds, sessionId, opts = {}) {
  const empty = { hits: 0, misses: 0, touchedEdges: 0 };
  if (process.env.MEM_DISABLE_CITATION_DECAY === '1') return empty;
  if (!db || !project || !sessionId) return empty;
  if (!Array.isArray(fileEdges) || fileEdges.length === 0) return empty;
  const cited = citedIds instanceof Set ? citedIds : new Set(citedIds || []);
  const mainInjected = opts.mainInjectedIds instanceof Set ? opts.mainInjectedIds : null;

  const selectEdges = db.prepare(`
    SELECT of2.rowid AS edge_rowid,
           of2.miss_streak,
           of2.last_resolved_session_id,
           of2.last_cited_session_id
      FROM observation_files of2
      JOIN observations o ON o.id = of2.obs_id
     WHERE of2.obs_id = ?
       AND o.project = ?
       AND ${fileMatchClause('of2')}
  `);
  const updateHit = db.prepare(`
    UPDATE observation_files
       SET miss_streak = 0,
           inject_count = inject_count + ?,
           last_cited_session_id = ?,
           last_resolved_session_id = ?
     WHERE rowid = ?
  `);
  const updateMiss = db.prepare(`
    UPDATE observation_files
       SET miss_streak = miss_streak + 1,
           inject_count = inject_count + 1,
           last_resolved_session_id = ?
     WHERE rowid = ?
  `);

  let hits = 0,
    misses = 0,
    touchedEdges = 0;
  const txn = db.transaction(() => {
    for (const { filePath, obsIds } of fileEdges) {
      if (!filePath || !Array.isArray(obsIds)) continue;
      const fileParams = fileMatchParams(filePath);
      for (const obsId of obsIds) {
        // Sidechain gate: skip obs the main thread never saw injected or cited
        // (see opts.mainInjectedIds in the JSDoc above).
        if (mainInjected && !mainInjected.has(obsId) && !cited.has(obsId)) continue;
        let rows;
        try {
          rows = selectEdges.all(obsId, project, ...fileParams);
        } catch (e) {
          debugCatch(e, `resolveEdgeAttribution-select-${obsId}`);
          continue;
        }
        for (const row of rows) {
          if (cited.has(obsId)) {
            if (row.last_cited_session_id === sessionId) continue; // already credited
            // First resolution this session counts the injection; a cross-turn
            // late cite (already resolved as miss) only flips the verdict.
            const first = row.last_resolved_session_id !== sessionId;
            updateHit.run(first ? 1 : 0, sessionId, sessionId, row.edge_rowid);
            hits++;
            touchedEdges++;
          } else {
            if (row.last_resolved_session_id === sessionId) continue; // idempotent
            updateMiss.run(sessionId, row.edge_rowid);
            misses++;
            touchedEdges++;
          }
        }
      }
    }
  });
  try {
    txn();
  } catch (e) {
    debugCatch(e, 'resolveEdgeAttribution-txn');
    return empty;
  }
  return { hits, misses, touchedEdges };
}
