// Vocabulary-mismatch benchmark suite — locks the documented recall deficit and
// the ground-truth integrity of fixtures/test-queries-vocab-mismatch.json.
//
// This suite measures recall when the user's words differ from the memory's
// words (synonyms / natural-language descriptions). It MUST run on the
// production_hybrid path (FTS + TF-IDF vector + RRF + OR-fallback). The
// FTS-only path AND-joins multi-word NL queries and scores ~0 — a misleading
// artifact, NOT the real retrieval capability. See benchmark/benchmark.mjs:189.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDb } from './test-helpers.mjs';
import { _resetVocabCache } from '../tfidf.mjs';
import { seedDatabase, seedVectors, runBenchmark } from '../benchmark/benchmark.mjs';

const fixtures = new URL('../benchmark/fixtures/', import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('seed-data.json', fixtures), 'utf8'));
const suite = JSON.parse(readFileSync(new URL('test-queries-vocab-mismatch.json', fixtures), 'utf8'));

describe('vocab-mismatch benchmark suite', () => {
  it('ground-truth integrity: every relevant_id references a real corpus obs, both tiers present', () => {
    const ids = new Set(corpus.observations.map((o) => o.id));
    const bad = [];
    for (const q of suite.queries) {
      for (const id of q.relevant_ids) if (!ids.has(id)) bad.push(`${q.id}:${id}`);
    }
    expect(bad).toEqual([]);
    expect(suite.queries.length).toBeGreaterThanOrEqual(10);
    const cats = new Set(suite.queries.map((q) => q.category));
    expect(cats.has('vocab_mismatch_synonym')).toBe(true);
    expect(cats.has('vocab_mismatch_paraphrase')).toBe(true);
  });

  it('production_hybrid recalls the documented deficit band (rescued above 0, far below keyword)', () => {
    _resetVocabCache();
    const db = createTestDb();
    seedDatabase(db, corpus);
    seedVectors(db);

    const r = runBenchmark(db, suite.queries, 'production_hybrid');
    // Observed R@10 ~0.33 (2026-06): TF-IDF vector + OR-fallback rescue ~1/3 of
    // relevant memories; the remaining ~2/3 miss IS the vocabulary-mismatch gap
    // (keyword baseline on this corpus is ~0.90). The band guards two ways:
    //   lower (>0.15): catches a regression to ~0 — including accidentally
    //     running the FTS-only path, or the vector arm going dark.
    //   upper (<0.65): catches ground-truth drift or the gap silently closing
    //     (a real close is good — but then recapture the baseline deliberately).
    expect(r.metrics.recall_at_10).toBeGreaterThan(0.15);
    expect(r.metrics.recall_at_10).toBeLessThan(0.65);
    // The path actually returned ids for most queries (not a broken/empty path).
    const nonEmpty = r.perQuery.filter((q) => q.result_ids.length > 0).length;
    expect(nonEmpty).toBeGreaterThan(suite.queries.length / 2);
    db.close();
  });
});
