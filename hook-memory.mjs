// claude-mem-lite — Semantic Memory Injection
// Search past observations for relevant memories to inject as context at user-prompt time.

import { sanitizeFtsQuery, relaxFtsQueryToOr, debugCatch, OBS_BM25 } from './utils.mjs';

const MAX_MEMORY_INJECTIONS = 3;
const MEMORY_LOOKBACK_MS = 60 * 86400000; // 60 days
// Aligned with TYPE_QUALITY_CASE: high-signal types > noisy types
// Bugfix lessons are still surfaced via the separate lesson_learned boost (1.5×)
const MEMORY_TYPE_BOOST = { decision: 1.5, discovery: 1.3, feature: 1.2, refactor: 1.0, change: 0.8, bugfix: 0.5 };

const FILE_RECALL_LOOKBACK_MS = 60 * 86400000; // 60 days
const MAX_FILE_RECALL = 2;

/**
 * Search for relevant past observations to inject as memory context.
 * Quality gates: importance>=1 (with 0.6x penalty), type-boosted, lesson-boosted, BM25-thresholded (adaptive: 0 for <5 obs, 1.5 otherwise).
 * @param {import('better-sqlite3').Database} db Memory database
 * @param {string} userPrompt User's prompt text
 * @param {string} project Current project
 * @param {number[]} excludeIds Observation IDs already in Key Context
 * @returns {object[]} Top memories (max 3) with {id, type, title, lesson_learned}
 */
export function searchRelevantMemories(db, userPrompt, project, excludeIds = []) {
  if (!db || !userPrompt || userPrompt.length < 5) return [];

  try {
    const ftsQuery = sanitizeFtsQuery(userPrompt);
    if (!ftsQuery) return [];

    const cutoff = Date.now() - MEMORY_LOOKBACK_MS;
    const excludeSet = new Set(excludeIds);

    // Phase 1: Same-project search (highest priority)
    const selectStmt = db.prepare(`
      SELECT o.id, o.type, o.title, o.importance, o.lesson_learned, o.project,
             ${OBS_BM25} as relevance
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project = ?
        AND o.importance >= 1
        AND o.created_at_epoch > ?
        AND COALESCE(o.compressed_into, 0) = 0
        AND o.superseded_at IS NULL
      ORDER BY ${OBS_BM25}
      LIMIT 10
    `);
    let rows = selectStmt.all(ftsQuery, project, cutoff);

    // OR fallback when AND returns nothing
    if (rows.length === 0) {
      const orQuery = relaxFtsQueryToOr(ftsQuery);
      if (orQuery) {
        try { rows = selectStmt.all(orQuery, project, cutoff); } catch {}
      }
    }

    // Phase 2: Cross-project search for high-value decisions/discoveries
    // These are transferable insights (debugging patterns, architectural reasons, gotchas)
    let crossRows = [];
    try {
      const crossStmt = db.prepare(`
        SELECT o.id, o.type, o.title, o.importance, o.lesson_learned, o.project,
               ${OBS_BM25} as relevance
        FROM observations_fts
        JOIN observations o ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ?
          AND o.project != ?
          AND o.type IN ('decision', 'discovery')
          AND o.importance >= 2
          AND o.created_at_epoch > ?
          AND COALESCE(o.compressed_into, 0) = 0
          AND o.superseded_at IS NULL
        ORDER BY ${OBS_BM25}
        LIMIT 5
      `);
      crossRows = crossStmt.all(ftsQuery, project, cutoff);
      if (crossRows.length === 0) {
        const orQuery = relaxFtsQueryToOr(ftsQuery);
        if (orQuery) {
          try { crossRows = crossStmt.all(orQuery, project, cutoff); } catch {}
        }
      }
    } catch (e) { debugCatch(e, 'crossProjectSearch'); }

    // Merge and score: same-project full weight, cross-project 0.7x
    const allRows = [...rows, ...crossRows];
    const scored = allRows
      .filter(r => !excludeSet.has(r.id))
      .map(r => {
        const crossProjectPenalty = r.project === project ? 1.0 : 0.7;
        return {
          ...r,
          score: Math.abs(r.relevance)
            * (MEMORY_TYPE_BOOST[r.type] || 1.0)
            * (r.lesson_learned ? 1.5 : 1.0)
            * (r.importance >= 2 ? 1.0 : 0.6)
            * crossProjectPenalty,
        };
      })
      .sort((a, b) => b.score - a.score);

    // Adaptive threshold: BM25 IDF collapses when corpus has <5 observations,
    // producing scores ~0.00001 even for exact matches. At 5+ obs, IDF provides
    // meaningful discrimination and the calibrated 1.5 threshold works well.
    const obsCount = db.prepare(
      'SELECT COUNT(*) as c FROM observations WHERE project = ? AND COALESCE(compressed_into, 0) = 0',
    ).get(project)?.c || 0;
    const threshold = obsCount < 5 ? 0 : 1.5;
    if (scored.length === 0 || scored[0].score < threshold) return [];

    // Update access_count for injected memories
    const result = scored.slice(0, MAX_MEMORY_INJECTIONS);
    const now = Date.now();
    const updateStmt = db.prepare('UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id = ?');
    for (const r of result) {
      updateStmt.run(now, r.id);
    }

    return result;
  } catch (e) {
    debugCatch(e, 'searchRelevantMemories');
    return [];
  }
}

/**
 * Recall observations related to a specific file being edited.
 * Useful for surfacing past bugfixes / decisions when revisiting a file.
 * @param {import('better-sqlite3').Database} db Memory database
 * @param {string} filePath File path (absolute or relative)
 * @param {string} project Current project
 * @returns {object[]} Up to MAX_FILE_RECALL observations with {id, type, title, importance, lesson_learned}
 */
export function recallForFile(db, filePath, project) {
  if (!db || !filePath) return [];
  try {
    const basename = filePath.split('/').pop();
    const cutoff = Date.now() - FILE_RECALL_LOOKBACK_MS;
    // Escape SQL LIKE wildcards in filename to prevent injection
    const escaped = basename.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const likePattern = `%${escaped}`;
    const rows = db.prepare(`
      SELECT DISTINCT o.id, o.type, o.title, o.importance, o.lesson_learned
      FROM observations o
      JOIN observation_files of2 ON of2.obs_id = o.id
      WHERE o.project = ?
        AND o.importance >= 2
        AND COALESCE(o.compressed_into, 0) = 0
        AND o.superseded_at IS NULL
        AND o.created_at_epoch > ?
        AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `).all(project, cutoff, filePath, likePattern, MAX_FILE_RECALL);
    const now = Date.now();
    const updateStmt = db.prepare('UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id = ?');
    for (const r of rows) updateStmt.run(now, r.id);
    return rows;
  } catch (e) {
    debugCatch(e, 'recallForFile');
    return [];
  }
}
