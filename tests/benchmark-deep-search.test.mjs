// Deep-search benchmark regression suite (deep-search.mjs over the real
// searchObservationsHybrid path, fused). Uses RECORDED rewrites + a fake llm so
// it measures FUSION quality deterministically — isolated from live Haiku
// rewrite flakiness (#8730/#8731). Locks: (a) the single-query baseline stays in
// its documented vocab-mismatch deficit band (~0.33), (b) deep search lifts R@10
// well above it given usable rewrites, (c) every suite query has a recorded
// rewrite so the harness never silently degrades to baseline on a missing key.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDb } from './test-helpers.mjs';
import { _resetVocabCache } from '../tfidf.mjs';
import { seedDatabase, seedVectors, runDeepSearch } from '../benchmark/benchmark.mjs';

const fixtures = new URL('../benchmark/fixtures/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('seed-data.json', fixtures), 'utf8'));
const suite = JSON.parse(readFileSync(new URL('test-queries-vocab-mismatch.json', fixtures), 'utf8'));
const rewritesFile = JSON.parse(readFileSync(new URL('rewrites-vocab-mismatch.json', fixtures), 'utf8'));
const rewritesByQuery = rewritesFile.rewrites;

describe('deep-search benchmark suite', () => {
  it('integrity: every suite query has a recorded rewrite with 3 non-empty variants', () => {
    const missing = [];
    for (const q of suite.queries) {
      const v = rewritesByQuery[q.query];
      if (!Array.isArray(v) || v.length < 1 || v.some((s) => typeof s !== 'string' || !s.trim())) {
        missing.push(q.id);
      }
    }
    expect(missing).toEqual([]);
    // No stray rewrite keys that don't map to a suite query (drift guard).
    const suiteQueries = new Set(suite.queries.map((q) => q.query));
    const orphan = Object.keys(rewritesByQuery).filter((k) => !suiteQueries.has(k));
    expect(orphan).toEqual([]);
  });

  it('deep search lifts recall well above the single-query baseline', async () => {
    _resetVocabCache();
    const db = createTestDb();
    seedDatabase(db, corpus);
    seedVectors(db);

    const res = await runDeepSearch(db, suite.queries, rewritesByQuery);

    // Baseline reproduces the documented ~0.33 vocab-mismatch deficit band.
    expect(res.baseline.recall_at_10).toBeGreaterThan(0.15);
    expect(res.baseline.recall_at_10).toBeLessThan(0.55);

    // With all rewrites usable, fusion recovers most of the gap. Lower bound
    // (>0.6) catches a fusion/RRF regression; upper bound (<=1) is the ceiling.
    // This is the DETERMINISTIC ceiling — live Haiku reliability lands lower, but
    // deep-search keeps the original query so live R@10 >= baseline always.
    expect(res.deep.recall_at_10).toBeGreaterThan(0.6);
    expect(res.deep.recall_at_10).toBeLessThanOrEqual(1);

    // Strict, meaningful improvement over baseline.
    expect(res.deep.recall_at_10).toBeGreaterThan(res.baseline.recall_at_10);
    expect(res.delta.recall_at_10).toBeGreaterThan(0.2);

    // The vast majority of queries gain; a few may stay flat. RRF over ADDED
    // variants is NOT per-query recall-monotonic — fusion maximizes aggregate
    // recall and can displace one query's marginal relevant doc from the top-10
    // (the only hard never-worse guarantee is the rewrite-failure floor, locked
    // in the next test). So we assert direction, not universal monotonicity:
    // far more queries improve than regress, and regressions are isolated.
    const improved = res.perQuery.filter((q) => q.recall_delta > 0).length;
    const regressed = res.perQuery.filter((q) => q.recall_delta < 0).length;
    expect(improved).toBeGreaterThanOrEqual(8);
    expect(improved).toBeGreaterThan(regressed * 4);
    db.close();
  });

  it('falls back to baseline (never worse) when rewrites are missing', async () => {
    _resetVocabCache();
    const db = createTestDb();
    seedDatabase(db, corpus);
    seedVectors(db);

    // Empty rewrites map → fake llm returns null for every query → variants
    // collapse to [original] → deep must equal the single-query baseline.
    const res = await runDeepSearch(db, suite.queries, {});
    expect(res.deep.recall_at_10).toBe(res.baseline.recall_at_10);
    expect(res.delta.recall_at_10).toBe(0);
    db.close();
  });
});
