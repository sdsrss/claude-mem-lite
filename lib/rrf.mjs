// lib/rrf.mjs — Reciprocal Rank Fusion core (single source of truth, D#42).
//
// Both tfidf.rrfMerge (2-list, minimal { id, rrfScore } output) and
// deep-search.rrfFuseN (N-list, full-row output with best-rank row selection)
// are thin shape-adapters over rrfAccumulate below. Keeping the scoring math in
// one dependency-free place prevents the two from silently drifting (different k
// or formula — the prior state where each had its own hand-written loop). Callers
// pass their own RRF_K default; 60 is the canonical value.

/**
 * Core Reciprocal Rank Fusion accumulator. For each id, sums 1/(k + rank + 1)
 * across every ranked list it appears in, and keeps the source row from the list
 * where the id ranked highest (lowest index) — query-dependent fields like an FTS
 * snippet then come from the best-ranked appearance. Callers that only need the id
 * ignore the row.
 *
 * @param {Array<Array<{id:any}>>} rankedLists one entry per ranked list; each list
 *   is ordered best-first. Non-array entries and rows with null/undefined id are skipped.
 * @param {number} [k=60] RRF constant.
 * @returns {Array<{ id:any, row:object, score:number }>} descending by fused score;
 *   ties preserve first-list-first insertion order (stable sort).
 */
export function rrfAccumulate(rankedLists, k = 60) {
  const scores = new Map();
  for (const list of rankedLists) {
    if (!Array.isArray(list)) continue;
    // A list is the accumulation unit: an id repeated within ONE list contributes a
    // single best-rank term, not one per occurrence. Without this, a list carrying a
    // duplicate id (e.g. a future caller that concatenates sub-result sets without
    // dedup) would inflate that id to a fake cross-ranker-consensus score.
    const seenInList = new Set();
    list.forEach((r, i) => {
      if (!r || r.id === undefined || r.id === null) return;
      if (seenInList.has(r.id)) return;
      seenInList.add(r.id);
      const add = 1 / (k + i + 1);
      const prev = scores.get(r.id);
      if (prev) {
        prev.score += add;
        if (i < prev.bestRank) {
          prev.row = r;
          prev.bestRank = i;
        }
      } else {
        scores.set(r.id, { row: r, score: add, bestRank: i });
      }
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ row, score }) => ({ id: row.id, row, score }));
}
