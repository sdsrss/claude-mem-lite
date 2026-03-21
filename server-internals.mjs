// claude-mem-lite server internal functions
// Extracted from server.mjs for testability (server.mjs has top-level side effects)

import { debugCatch, COMPRESSED_AUTO, COMPRESSED_PENDING_PURGE, OBS_BM25 } from './utils.mjs';

// ─── Search Re-ranking Helpers ────────────────────────────────────────────

/**
 * Re-rank search results by boosting scores for observations touching recently active files.
 * Mutates score fields on result objects in-place (BM25 negative scores).
 * @param {object} db better-sqlite3 database handle
 * @param {object[]} results Array of search result objects with source, score, files_modified
 * @param {string} project Current project name for scoping recent activity
 */
export function reRankWithContext(db, results, project) {
  if (!results || results.length === 0) return;
  // Get recently active files (last 2 hours, same project)
  const twoHoursAgo = Date.now() - 2 * 3600000;
  const recentObs = db.prepare(`
    SELECT files_modified FROM observations
    WHERE project = ? AND created_at_epoch > ?
    ORDER BY created_at_epoch DESC LIMIT 10
  `).all(project, twoHoursAgo);

  const activeFiles = new Set();
  for (const r of recentObs) {
    try {
      const files = JSON.parse(r.files_modified || '[]');
      for (const f of files) activeFiles.add(f);
    } catch (e) { debugCatch(e, 'reRankWithContext-parse'); }
  }
  if (activeFiles.size === 0) return;

  // Pre-compute active directories for directory-level matching
  const activeDirs = new Set();
  for (const f of activeFiles) {
    const lastSlash = f.lastIndexOf('/');
    if (lastSlash > 0) activeDirs.add(f.substring(0, lastSlash));
  }

  for (const result of results) {
    if (result.source !== 'obs' || !result.files_modified) continue;
    let resultFiles;
    try { resultFiles = JSON.parse(result.files_modified || '[]'); } catch (e) { debugCatch(e, 'reRankWithContext-resultFiles'); continue; }
    if (resultFiles.length === 0) continue;
    const exactMatches = resultFiles.filter(f => activeFiles.has(f)).length;
    // Directory-level: same parent dir but different file (half weight)
    const dirMatches = resultFiles.filter(f => {
      if (activeFiles.has(f)) return false; // already counted as exact
      const lastSlash = f.lastIndexOf('/');
      return lastSlash > 0 && activeDirs.has(f.substring(0, lastSlash));
    }).length;
    const fileOverlap = (exactMatches + 0.5 * dirMatches) / resultFiles.length;
    // BM25 scores are negative — multiply by >1 makes more negative = better rank
    if (result.score !== null && result.score !== undefined && fileOverlap > 0) {
      result.score *= (1.0 + 0.3 * fileOverlap);
    }
  }
  // Note: caller re-sorts the main results array after this — no sort needed here
}

/**
 * Mark older, lower-importance observations as superseded when multiple touch the same file.
 * Mutates result objects in-place by adding superseded=true flag.
 * @param {object[]} results Array of search result objects with source, files_modified, date, importance
 */
export function markSuperseded(results) {
  if (!results || results.length === 0) return;
  // Build map: file → [result objects], only for obs with files
  const fileMap = new Map();
  for (const r of results) {
    if (r.source !== 'obs' || !r.files_modified) continue;
    let files;
    try { files = JSON.parse(r.files_modified || '[]'); } catch (e) { debugCatch(e, 'markSuperseded-parse'); continue; }
    for (const f of files) {
      if (!fileMap.has(f)) fileMap.set(f, []);
      fileMap.get(f).push(r);
    }
  }
  // For each file with 2+ observations: mark older lower-importance as superseded
  for (const [, obsForFile] of fileMap) {
    if (obsForFile.length < 2) continue;
    obsForFile.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const newest = obsForFile[0];
    for (let i = 1; i < obsForFile.length; i++) {
      if ((obsForFile[i].importance ?? 1) <= (newest.importance ?? 1)) {
        obsForFile[i].superseded = true;
      }
    }
  }
}

// ─── Pseudo-Relevance Feedback (PRF) ────────────────────────────────────────
// Two-phase document-level expansion: extract discriminative terms from top
// results' full text (title + narrative), filter out query terms + stop words,
// use TF-IDF-style scoring to find terms that appear in many top results.

/** @type {Set<string>} Common words excluded from PRF term extraction */
export const PRF_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'was', 'were', 'been',
  'have', 'has', 'had', 'are', 'but', 'not', 'all', 'can', 'into', 'when',
  'which', 'their', 'will', 'would', 'could', 'should', 'also', 'than',
  'then', 'its', 'use', 'used', 'using', 'some', 'new', 'added', 'updated',
  'file', 'files', 'code', 'change', 'changed', 'changes',
]);

/**
 * Extract discriminative terms from top search results for pseudo-relevance feedback.
 * Selects terms that appear in 2+ top documents but aren't already in the query.
 * @param {object[]} results Top search result objects with title and narrative fields
 * @param {string} ftsQuery The original FTS5 query (terms are excluded from output)
 * @param {number} [limit=3] Maximum number of expansion terms to return
 * @returns {string[]} Array of discriminative terms for query expansion
 */
export function extractPRFTerms(results, ftsQuery, limit = 3) {
  // Extract query tokens for exclusion
  const queryTokens = new Set(
    ftsQuery.replace(/["()]/g, ' ').split(/\s+/)
      .map(t => t.toLowerCase())
      .filter(t => t.length > 1 && t !== 'or' && t !== 'and')
  );

  // Count term frequencies across top results' full text
  const termFreq = {};
  const docCount = Math.min(results.length, 8);
  for (let i = 0; i < docCount; i++) {
    const r = results[i];
    const text = ((r.title || '') + ' ' + (r.narrative || '')).toLowerCase();
    const tokens = text.replace(/[^a-z0-9_-]/g, ' ').split(/\s+/)
      .filter(t => t.length >= 3 && !PRF_STOP_WORDS.has(t) && !queryTokens.has(t));
    const seen = new Set();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      termFreq[t] = (termFreq[t] || 0) + 1;
    }
  }

  // Select terms appearing in >= 2 top docs (discriminative, not noise)
  return Object.entries(termFreq)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

// ─── Concept Co-occurrence Query Expansion ─────────────────────────────────
// "Poor man's word2vec": find concepts that frequently co-occur with query
// terms in existing observations, then use them to supplement sparse results.

/**
 * Expand a search query by finding co-occurring concepts in matching observations.
 * Acts as a "poor man's word2vec" for concept-based query expansion.
 * @param {object} db better-sqlite3 database handle
 * @param {string} ftsQuery The FTS5 query to find concept neighbors for
 * @param {string} [project] Optional project filter
 * @returns {string[]} Array of concept terms for query expansion (max 3)
 */
export function expandQueryByConcepts(db, ftsQuery, project) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT o.concepts FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ? AND COALESCE(o.compressed_into, 0) = 0
        AND (? IS NULL OR o.project = ?)
      ORDER BY ${OBS_BM25}
      LIMIT 20
    `).all(ftsQuery, project ?? null, project ?? null);
  } catch (e) { debugCatch(e, 'expandQueryByConcepts-fts'); return []; }

  if (rows.length === 0) return [];

  // Count concept frequencies across matched observations
  const freq = {};
  for (const row of rows) {
    for (const c of (row.concepts || '').split(/\s+/).filter(Boolean)) {
      const cl = c.toLowerCase();
      freq[cl] = (freq[cl] || 0) + 1;
    }
  }

  // Filter out terms already present in the query
  const queryTokens = new Set(
    ftsQuery.replace(/["()]/g, ' ').split(/\s+/)
      .map(t => t.toLowerCase())
      .filter(t => t.length > 1 && t !== 'or' && t !== 'and')
  );

  return Object.entries(freq)
    .filter(([c, count]) => count >= 2 && !queryTokens.has(c))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([concept]) => concept);
}

// ─── Auto-boost ─────────────────────────────────────────────────────────────

/**
 * Boost importance to 2 for observations that have been accessed multiple times
 * (access_count >= 2) but still have default importance (1).
 * Called after incrementing access_count in mem_get.
 * @param {object} db better-sqlite3 database handle
 * @param {number[]} ids Array of observation IDs to check
 */
export function autoBoostIfNeeded(db, ids) {
  if (!ids || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`
    UPDATE observations SET importance = 2
    WHERE id IN (${placeholders})
      AND COALESCE(importance, 1) = 1
      AND COALESCE(access_count, 0) >= 2
  `).run(...ids);
}

// ─── Idle Cleanup ────────────────────────────────────────────────────────────

/**
 * Run type-differentiated idle cleanup on stale observations.
 * Higher-value types (decision, discovery) survive longer than ephemeral types (change).
 * - Marks low-quality (importance<=1, never accessed) as pending-purge (COMPRESSED_PENDING_PURGE).
 * - Marks importance=1 accessed observations as auto-compressed (COMPRESSED_AUTO).
 * @param {object} db better-sqlite3 database handle
 * @returns {{ marked: number, compressed: number }}
 */
export function runIdleCleanup(db) {
  // SAFETY: type values are hardcoded constants, not user input
  const staleThresholds = [
    { types: "'decision','discovery'", days: 90 },
    { types: "'feature'", days: 60 },
    { types: "'bugfix','refactor'", days: 30 },
    { types: "'change'", days: 14 },
  ];

  let totalMarked = 0;
  let totalCompressed = 0;

  db.transaction(() => {
    for (const { types, days } of staleThresholds) {
      const cutoff = Date.now() - days * 86400000;

      const marked = db.prepare(`
        UPDATE observations SET compressed_into = ${COMPRESSED_PENDING_PURGE}
        WHERE importance <= 1 AND COALESCE(access_count, 0) = 0
          AND type IN (${types})
          AND created_at_epoch < ? AND COALESCE(compressed_into, 0) = 0
      `).run(cutoff);
      totalMarked += marked.changes;

      const compressed = db.prepare(`
        UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}
        WHERE COALESCE(compressed_into, 0) = 0 AND importance = 1
          AND type IN (${types})
          AND created_at_epoch < ?
      `).run(cutoff);
      totalCompressed += compressed.changes;
    }
  })();

  return { marked: totalMarked, compressed: totalCompressed };
}
