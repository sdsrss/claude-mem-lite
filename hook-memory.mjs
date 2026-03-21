// claude-mem-lite — Semantic Memory Injection
// Search past observations for relevant memories to inject as context at user-prompt time.

import { sanitizeFtsQuery, debugCatch, OBS_BM25 } from './utils.mjs';

const MAX_MEMORY_INJECTIONS = 3;
const MEMORY_LOOKBACK_MS = 60 * 86400000; // 60 days
const MEMORY_TYPE_BOOST = { bugfix: 1.5, decision: 1.3, discovery: 1.0, feature: 0.8, change: 0.5, refactor: 0.5 };

const FILE_RECALL_LOOKBACK_MS = 60 * 86400000; // 60 days
const MAX_FILE_RECALL = 2;

/**
 * Search for relevant past observations to inject as memory context.
 * Quality gates: importance>=1 (with 0.6x penalty), type-boosted, lesson-boosted, BM25-thresholded (>=1.5).
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
      ORDER BY ${OBS_BM25}
      LIMIT 10
    `);
    const rows = selectStmt.all(ftsQuery, project, cutoff);

    // Phase 2: Cross-project search for high-value decisions/discoveries
    // These are transferable insights (debugging patterns, architectural reasons, gotchas)
    let crossRows = [];
    try {
      crossRows = db.prepare(`
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
        ORDER BY ${OBS_BM25}
        LIMIT 5
      `).all(ftsQuery, project, cutoff);
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

    // Strict threshold: raised from 1.0 to 1.5 to compensate for wider pool
    if (scored.length === 0 || scored[0].score < 1.5) return [];

    // Update access_count for injected memories
    const result = scored.slice(0, MAX_MEMORY_INJECTIONS);
    const updateStmt = db.prepare('UPDATE observations SET access_count = COALESCE(access_count, 0) + 1 WHERE id = ?');
    for (const r of result) {
      updateStmt.run(r.id);
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
    // Match both full paths (/path/to/file.mjs) and basename-only entries ("file.mjs")
    // Two patterns avoid false positives: %/file.mjs"% won't match /webapp.mjs
    const pathPattern = `%/${escaped}"%`;
    const namePattern = `%"${escaped}"%`;
    const rows = db.prepare(`
      SELECT id, type, title, importance, lesson_learned
      FROM observations
      WHERE project = ?
        AND importance >= 2
        AND COALESCE(compressed_into, 0) = 0
        AND created_at_epoch > ?
        AND (files_modified LIKE ? ESCAPE '\\' OR files_modified LIKE ? ESCAPE '\\')
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(project, cutoff, pathPattern, namePattern, MAX_FILE_RECALL);
    const updateStmt = db.prepare('UPDATE observations SET access_count = COALESCE(access_count, 0) + 1 WHERE id = ?');
    for (const r of rows) updateStmt.run(r.id);
    return rows;
  } catch (e) {
    debugCatch(e, 'recallForFile');
    return [];
  }
}
