// P7: the benchmark's production_hybrid scenario drives the REAL
// searchObservationsHybrid (FTS + TF-IDF vector + RRF), not the file-local
// FTS-only search. These tests pin that the vector arm is actually seeded and
// exercised, and that the constant sweep runs over the real path.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { _resetVocabCache } from '../tfidf.mjs';
import { seedDatabase, seedVectors, runBenchmark, runVectorSweep } from '../benchmark/benchmark.mjs';
import { OBS_BM25 } from '../scoring-sql.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Small synthetic corpus: two topical clusters with shared vocabulary (df>=2 so a
// vocabulary builds) plus an off-topic distractor.
function makeSeed() {
  const mk = (id, title, narrative) => ({
    id,
    session_id: 's1',
    project: 'proj-a',
    text: `${title} ${narrative}`,
    type: 'bugfix',
    title,
    narrative,
    facts: '',
    concepts: '',
    files_modified: '[]',
    importance: 2,
    epoch_offset_days: -1,
  });
  return {
    observations: [
      mk(1, 'auth token refresh bug', 'fix the authentication token expiry during login session'),
      mk(2, 'auth session logout', 'authentication session broken after logout, token cleared'),
      mk(3, 'auth login redirect', 'authentication login redirect loops on expired token'),
      mk(4, 'database migration script', 'update database schema add user table columns index'),
      mk(5, 'database query slow', 'optimize database query performance on large table scan'),
    ],
    sessions: [],
  };
}

const QUERIES = [
  {
    id: 'q-auth',
    query: 'authentication token login',
    relevant_ids: [1, 2, 3],
    project: 'proj-a',
    category: 'std',
  },
  { id: 'q-db', query: 'database table query', relevant_ids: [4, 5], project: 'proj-a', category: 'std' },
];

describe('benchmark production_hybrid scenario (P7)', () => {
  it('seedVectors populates observation_vectors for the seeded corpus', () => {
    _resetVocabCache();
    const db = createTestDb();
    seedDatabase(db, makeSeed());
    const before = db.prepare('SELECT COUNT(*) AS c FROM observation_vectors').get().c;
    expect(before).toBe(0);

    const seeded = seedVectors(db);
    expect(seeded.vectors).toBeGreaterThan(0);
    expect(seeded.vocabVersion).toBeTruthy();
    const after = db.prepare('SELECT COUNT(*) AS c FROM observation_vectors').get().c;
    expect(after).toBe(seeded.vectors);
    db.close();
  });

  it('runBenchmark("production_hybrid") retrieves relevant obs over the real path', () => {
    _resetVocabCache();
    const db = createTestDb();
    seedDatabase(db, makeSeed());
    seedVectors(db);

    const results = runBenchmark(db, QUERIES, 'production_hybrid');
    // The real hybrid path should recall the topical clusters well above zero.
    expect(results.metrics.recall_at_10).toBeGreaterThan(0.5);
    expect(results.metrics.mrr_at_10).toBeGreaterThan(0);
    // It actually returned ids (not an empty/broken path).
    expect(results.perQuery.every((q) => q.result_ids.length > 0)).toBe(true);
    db.close();
  });

  it('runVectorSweep covers the pinned defaults and reports whether they win', () => {
    _resetVocabCache();
    const db = createTestDb();
    seedDatabase(db, makeSeed());
    seedVectors(db);

    const sweep = runVectorSweep(db, QUERIES, { dims: [256, 512], minCosines: [0.05], rrfKs: [60] });
    // Pinned default config (512/0.05/60) must be one of the swept rows.
    expect(sweep.rows.some((r) => r.dim === 512 && r.minCosine === 0.05 && r.rrfK === 60)).toBe(true);
    expect(sweep.pinned).toEqual({ dim: 512, minCosine: 0.05, rrfK: 60 });
    expect(typeof sweep.pinnedIsBest).toBe('boolean');
    expect(sweep.best).toBeTruthy();
    db.close();
  });
});

// FIX 1: the benchmark's FTS modes must score with the SAME BM25 weight
// expression production uses (scoring-sql.mjs OBS_BM25), not a hardcoded literal.
// The old literal carried only 7 weights, omitting the 8th column
// (search_aliases) which then fell back to FTS5's default weight 1.0 instead of
// production's 5.0 — so an ablation/matrix/ci-gate run scored a stale formula and
// a search_aliases-weight change passed the gate invisibly.
describe('benchmark BM25 parity with production OBS_BM25 (FIX 1)', () => {
  const BENCH_PATH = join(__dirname, '..', 'benchmark', 'benchmark.mjs');
  const source = readFileSync(BENCH_PATH, 'utf8');

  it('imports OBS_BM25 from scoring-sql.mjs', () => {
    expect(source).toMatch(/import\s*\{[^}]*\bOBS_BM25\b[^}]*\}\s*from\s*['"]\.\.\/scoring-sql\.mjs['"]/);
  });

  it('uses the imported constant, not an inline bm25(observations_fts, ...) literal', () => {
    expect(source).toMatch(/baseBm25\s*=\s*OBS_BM25/);
    // No hardcoded bm25(observations_fts, <numbers>) weight literal remains.
    expect(source).not.toMatch(/bm25\(observations_fts\s*,\s*\d/);
  });

  it('OBS_BM25 carries one weight per FTS column (search_aliases is weighted, not defaulted)', () => {
    // 8 FTS columns: title, subtitle, narrative, text, facts, concepts,
    // lesson_learned, search_aliases → 8 numeric weights after the table name.
    const weights = OBS_BM25.replace(/^bm25\(observations_fts,\s*/, '')
      .replace(/\)\s*$/, '')
      .split(',');
    expect(weights.length).toBe(8);
    // The 8th weight (search_aliases) must be the production value 5, not 1.
    expect(weights[7].trim()).toBe('5');
  });

  it('benchmark FTS modes retrieve a token that lives ONLY in search_aliases', () => {
    _resetVocabCache();
    const db = createTestDb();
    // Seed a couple of normal rows so the FTS table is non-trivial.
    seedDatabase(db, {
      observations: [
        {
          id: 1,
          session_id: 's1',
          project: 'proj-a',
          text: 'docker compose setup',
          type: 'change',
          title: 'docker compose',
          narrative: 'set up docker compose',
          facts: '',
          concepts: '',
          files_modified: '[]',
          importance: 2,
          epoch_offset_days: -1,
        },
      ],
      sessions: [],
    });
    // One row whose distinctive token ('zqfftsalias') appears ONLY in search_aliases.
    insertSession(db, { id: 's2', project: 'proj-a' });
    db.prepare(
      `
      INSERT INTO observations
        (id, memory_session_id, project, text, type, title, narrative, search_aliases,
         created_at, created_at_epoch, importance)
      VALUES (99, 's2', 'proj-a', 'unrelated body', 'change', 'unrelated title',
              'unrelated narrative', 'zqfftsalias', '2026-01-01', ?, 2)
    `,
    ).run(Date.now());

    // bm25_only mode goes through the benchmark's FTS searchObservations (now
    // OBS_BM25-weighted). The alias-only token must be retrievable → proves the
    // search_aliases column is FTS-indexed and inside the benchmark's match path.
    const res = runBenchmark(
      db,
      [{ id: 'qa', query: 'zqfftsalias', relevant_ids: [99], project: 'proj-a', category: 'std' }],
      'bm25_only',
    );
    expect(res.perQuery[0].result_ids).toContain(99);
    db.close();
  });
});
