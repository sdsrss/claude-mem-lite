// Unit tests for benchmark holdout split + per-multiplier ablation modes.
// Covers the contract guarantees the rest of the benchmark relies on:
//   1. splitFixture is deterministic for a given seed (same input → same partition)
//   2. ratio is honored (within rounding)
//   3. train ∪ eval == input, no overlap
//   4. ablation modes return real result rows (formula stays valid SQL)

import { describe, it, expect } from 'vitest';
import { splitFixture, runBenchmark, seedDatabase } from '../benchmark/benchmark.mjs';
import { createTestDb } from './test-helpers.mjs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('splitFixture', () => {
  const sample = Array.from({ length: 30 }, (_, i) => ({
    id: `q${i}`,
    query: `query ${i}`,
    relevant_ids: [i],
  }));

  it('is deterministic for a given seed', () => {
    const a = splitFixture(sample, 0.3, 42);
    const b = splitFixture(sample, 0.3, 42);
    expect(a.eval.map((q) => q.id)).toEqual(b.eval.map((q) => q.id));
    expect(a.train.map((q) => q.id)).toEqual(b.train.map((q) => q.id));
  });

  it('produces different splits for different seeds', () => {
    const a = splitFixture(sample, 0.3, 1);
    const b = splitFixture(sample, 0.3, 2);
    // With 30 items and a different seed, the eval sets should not match.
    const aIds = a.eval.map((q) => q.id).join(',');
    const bIds = b.eval.map((q) => q.id).join(',');
    expect(aIds).not.toEqual(bIds);
  });

  it('honors the ratio (within rounding)', () => {
    const { eval: ev, train } = splitFixture(sample, 0.3, 42);
    expect(ev.length).toBe(9); // round(30 * 0.3) = 9
    expect(train.length).toBe(21);
  });

  it('train ∪ eval covers every input with no overlap', () => {
    const { eval: ev, train } = splitFixture(sample, 0.3, 42);
    const all = new Set([...ev.map((q) => q.id), ...train.map((q) => q.id)]);
    expect(all.size).toBe(30); // no duplicates
    expect(ev.every((e) => !train.includes(e))).toBe(true);
  });

  it('handles tiny inputs without crashing (eval ≥ 1)', () => {
    const tiny = [
      { id: 'a', query: 'a', relevant_ids: [1] },
      { id: 'b', query: 'b', relevant_ids: [2] },
    ];
    const { eval: ev, train } = splitFixture(tiny, 0.3, 7);
    expect(ev.length + train.length).toBe(2);
    expect(ev.length).toBeGreaterThanOrEqual(1);
  });
});

describe('benchmark ablation modes', () => {
  it('all per-multiplier modes execute valid SQL and return rows', () => {
    const seedPath = join(__dirname, '..', 'benchmark', 'fixtures', 'seed-data.json');
    const queriesPath = join(__dirname, '..', 'benchmark', 'fixtures', 'test-queries.json');
    const seedData = JSON.parse(readFileSync(seedPath, 'utf-8'));
    const queryData = JSON.parse(readFileSync(queriesPath, 'utf-8'));

    const db = createTestDb();
    seedDatabase(db, seedData);
    // One query is enough to exercise the SQL path for each mode.
    const queries = queryData.queries.slice(0, 1);

    for (const mode of ['no_decay', 'no_type', 'no_project', 'no_importance', 'no_access', 'no_lesson']) {
      const r = runBenchmark(db, queries, mode);
      expect(r.metrics.recall_at_10).toBeTypeOf('number');
      expect(r.mode).toBe(mode);
    }
    db.close();
  });
});
