// Corpus-size normalization for ABSOLUTE relevance floors.
//
// Extracted from scripts/user-prompt-search.js (v3.61.0) when a second injection
// face — error-recall — needed the same ramp. Two faces, one body: the project's
// "shared by two or more faces → lib/" rule, and specifically the rule that exists
// because absolute-floor logic re-typed per face is how v3.61.0 shipped a constant
// gating an IDF-bearing quantity and injected 0/8 on fresh installs.
//
// scripts/user-prompt-search.js re-exports corpusFloorScale so its own callers and
// tests (tests/ups-corpus-floor-scale.test.mjs) keep their import path.
//
// ONE DELIBERATE CHANGE ON EXTRACTION: the reference corpus is read at CALL time,
// not at module load. In production this is indistinguishable — a hook process reads
// a fixed environment — but it removes a trap for callers: a re-import with a
// cache-busting query string reloads the FACE, not this module, so a load-time
// constant here would have frozen at whatever the first import saw.

import { envNumber } from './env-number.mjs';

// Default reference corpus. Overridable per the historical UPS env name.
// Module-private: exported by habit in the first cut, and knip correctly flagged it —
// this project treats a new unused export as a defect to fix, not a baseline to carry.
const DEFAULT_FLOOR_REF_CORPUS = 584;

/**
 * The reference corpus the absolute floors are calibrated against.
 * @returns {number}
 */
function floorRefCorpus() {
  // min 0 and NOT min 2, which a first cut of this guard chose on the reasoning that
  // maxIdf is 0 below n=2 so the ramp would divide by zero. `corpusFloorScale` already
  // handles that: `ref <= 1` returns 1 and so does `!(refIdf > 0)`. A LOW reference is a
  // supported setting — it is the documented way to pin the ramp OFF, which two cases in
  // tests/user-prompt-search.test.mjs depend on — so min 2 turned a working knob into a
  // silent fallback to 584 and unfired both gates. The only thing being screened here is
  // the NaN that used to reach the comparison and make it silently false.
  return envNumber(process.env.CLAUDE_MEM_UPS_FLOOR_REF_CORPUS, {
    name: 'CLAUDE_MEM_UPS_FLOOR_REF_CORPUS',
    defaultValue: DEFAULT_FLOOR_REF_CORPUS,
    min: 0,
  });
}

/**
 * FTS5's IDF term for the best case a query can hit: a term appearing in exactly
 * one row (df=1) of an n-row index. SQLite computes
 * `log((n - df + 0.5) / (df + 0.5))`, so this is the ceiling any single-term bm25
 * contribution can reach at corpus size n — the quantity the absolute floors are
 * implicitly denominated in. Clamped at 0: below n=2 the formula goes negative,
 * which as a scale would flip the comparison rather than relax it.
 * @param {number} n Row count.
 * @returns {number} Max attainable IDF at this corpus size, ≥ 0.
 */
function maxIdf(n) {
  // n <= 1 makes the numerator non-positive → Math.log returns NaN or -Infinity, and
  // Math.max(0, NaN) is NaN, not 0. Short-circuit instead: a 0- or 1-row index has no
  // term that can discriminate, so the max attainable IDF is 0.
  if (!(n > 1)) return 0;
  return Math.max(0, Math.log((n - 1 + 0.5) / 1.5));
}

// ─── Why the ramp exists (v3.61.0 calibration history, moved with the code) ───
//
// The floors this scales are ABSOLUTE magnitudes (UPS: TOP_REL_FLOOR /
// OR_TOP_BM25_FLOOR; error-recall: ERROR_RECALL_BM25_FLOOR), but the quantity they
// gate is not scale-free: FTS5 bm25 carries an IDF term ≈ ln(N/df), so the SAME hit
// scores higher on a bigger index. Measured on one fixed query + one fixed target
// row, padding the corpus with distinct filler (2026-08-13 dogfood):
//
//   totalObs   10     40     100    300
//   top|bm25|  10.0   18.6   24.2   30.7      ← same row, same query
//
// The floors were calibrated at `projects--mem, 584 obs` (CHANGELOG v2.43.x /
// v2.34.3). Comparing a log-N quantity against that constant therefore does not
// mean "weak match" on a small index — it means "small index". A brand-new
// install measured 0/8 injections on a realistic first-day corpus (10 memories,
// 8 recall questions whose correct target ranked #1 in 4/5 scored cases): every
// one was dropped by the OR floor at |bm25| 3.8–15.2 < 30. The plugin is inert
// during exactly the window where a new user decides whether it earns its keep.
//
// Fix: scale the floors by the corpus's MAX ATTAINABLE IDF over the reference
// corpus's, capped at 1.0, so the SIGNAL↔NOISE separation the maintainer measured
// (signal ≥41, noise ≤22 at N_REF) is preserved proportionally at any N. At
// N ≥ N_REF the factor is exactly 1.0, so every established install keeps
// byte-identical behavior; only genuinely-new installs relax.
//
// 2026-08-17 e2e round — the ramp shape. The first cut used ln(N+1)/ln(N_REF+1), which has the
// right asymptotics but the wrong small-N behavior: FTS5's IDF term is
// `log((N - df + 0.5) / (df + 0.5))`, which is EXACTLY 0 at N=2/df=1 and stays far
// below ln(N+1) for the whole first-week window. Re-measured end-to-end through the
// production write path (lib/save-observation.mjs — a raw INSERT skips CJK bigram
// expansion and understates the corpus, which is how the first cut's ramp table was
// misread), 1 planted target + topically clustered filler, CJK prose prompt carrying
// no identifier for the bypass to rescue:
//
//   N              2     3     4     5     6    10    25    80
//   top|bm25|     0.0   5.1   7.0   9.5  11.4  15.5  22.2  30.3
//   ln ramp floor 5.2   6.5   7.6   8.4   9.2  11.3  15.3  20.7   ← DROP at N≤4
//   idf ramp floor 0.0  2.6   4.3   5.5   6.5   9.3  14.1  20.0   ← admits all
//
// The two ramps agree within 8% at N≥30 and within 2% at N≥200, so this re-shape is
// confined to the window it is meant to fix. Accepted tradeoff: on a ≤2-row corpus the
// scale is EXACTLY 0 (FTS5's max IDF is 0 there), which disables the set-level floors
// rather than lowering them, and just above that they are small; so the best lexical match
// is injected even when it is weak.
// That is the intended trade — the alternative measured behavior is total silence, and
// a 4-row corpus has no room to bury signal under noise. For UPS the upstream
// hasExplicitSignal gate, not these floors, is what suppresses noise prompts.
//
// N counts the WHOLE observations table, not the project: FTS5 computes IDF over
// the entire index and `o.project = ?` is a post-MATCH filter. Verified — a
// 2-row project on a 302-row install scores 31.5, matching the 300-row global
// baseline, not the 10-row one. So a new project on an established install is
// (correctly) unaffected by this ramp.

/**
 * Scale factor in [0, 1] for the absolute score floors, by total corpus size.
 *
 * Short-circuits with a bounded probe: if a row exists at offset N_REF-1 the
 * corpus is at or above the reference and the factor is 1.0 — no COUNT scan on
 * the large corpora where the answer is always 1.0 anyway.
 *
 * Note the ceiling: this only ever RELAXES a floor on a small corpus, never
 * tightens one on a large corpus. A face calibrated at or above the reference
 * therefore keeps its measured value everywhere, and a bigger index (higher IDF,
 * higher scores) makes the same floor comparatively more permissive — the safe
 * direction, since the failure this ramp exists to prevent is silence.
 *
 * @param {object} db Open better-sqlite3 handle.
 * @returns {number} Multiplier for an absolute score floor.
 */
export function corpusFloorScale(db) {
  const ref = floorRefCorpus();
  if (ref <= 1) return 1;
  try {
    const atRef = db.prepare('SELECT 1 FROM observations LIMIT 1 OFFSET ?').get(ref - 1);
    if (atRef) return 1;
    const { c = 0 } = db.prepare('SELECT count(*) AS c FROM observations').get() || {};
    const refIdf = maxIdf(ref);
    // Degenerate reference (CLAUDE_MEM_UPS_FLOOR_REF_CORPUS set to 2 or 3, where
    // maxIdf is 0 or near it): division would blow up or divide by zero. Treat the
    // floors as fully calibrated, matching the ref <= 1 guard above.
    if (!(refIdf > 0)) return 1;
    return Math.min(1, maxIdf(c) / refIdf);
  } catch {
    // Any probe failure → behave exactly as before the ramp existed.
    return 1;
  }
}
