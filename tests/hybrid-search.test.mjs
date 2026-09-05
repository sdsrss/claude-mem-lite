import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import {
  buildVocabulary,
  computeVector,
  _resetVocabCache,
  VOCAB_DIM,
  vectorSearch,
  rrfMerge,
} from '../tfidf.mjs';

describe('observation_vectors table', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    _resetVocabCache();
  });
  afterEach(() => {
    db.close();
  });

  it('exists after initSchema', () => {
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='observation_vectors'")
      .get();
    expect(table).toBeDefined();
  });

  it('stores and retrieves Float32Array vectors', () => {
    insertObs(db, { title: 'test obs' });
    const obsId = db.prepare('SELECT id FROM observations LIMIT 1').get().id;

    const vec = new Float32Array(VOCAB_DIM);
    vec[0] = 1.5;
    vec[1] = -0.5;
    vec[100] = 0.999;

    db.prepare(
      'INSERT INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)',
    ).run(obsId, Buffer.from(vec.buffer), 'v1', Date.now());

    const row = db.prepare('SELECT vector FROM observation_vectors WHERE observation_id = ?').get(obsId);
    const restored = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
    expect(restored[0]).toBeCloseTo(1.5);
    expect(restored[1]).toBeCloseTo(-0.5);
    expect(restored[100]).toBeCloseTo(0.999);
  });

  it('CASCADE deletes vector when observation is deleted', () => {
    insertObs(db, { title: 'to delete' });
    const obsId = db.prepare("SELECT id FROM observations WHERE title = 'to delete'").get().id;

    const vec = new Float32Array(VOCAB_DIM);
    db.prepare(
      'INSERT INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)',
    ).run(obsId, Buffer.from(vec.buffer), 'v1', Date.now());

    expect(db.prepare('SELECT COUNT(*) as c FROM observation_vectors').get().c).toBe(1);
    db.prepare('DELETE FROM observations WHERE id = ?').run(obsId);
    expect(db.prepare('SELECT COUNT(*) as c FROM observation_vectors').get().c).toBe(0);
  });
});

describe('vector write helper', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    _resetVocabCache();
  });
  afterEach(() => {
    db.close();
  });

  it('can write and read back a computed vector', () => {
    // Need shared terms across docs for df>=2 vocabulary filter
    insertObs(db, { title: 'auth token fix', narrative: 'fix authentication issue with token' });
    insertObs(db, { title: 'auth token refresh', narrative: 'token authentication refresh fix' });
    insertObs(db, { title: 'database query', narrative: 'optimize SQL performance' });
    const vocab = buildVocabulary(db);

    const obsId = db.prepare("SELECT id FROM observations WHERE title = 'auth token fix'").get().id;
    const vec = computeVector('auth token fix authentication issue', vocab);
    expect(vec).not.toBeNull();

    db.prepare(
      'INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)',
    ).run(obsId, Buffer.from(vec.buffer), vocab.version, Date.now());

    const row = db
      .prepare('SELECT vector, vocab_version FROM observation_vectors WHERE observation_id = ?')
      .get(obsId);
    expect(row.vocab_version).toBe(vocab.version);
    const restored = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
    expect(restored.length).toBe(VOCAB_DIM);
  });
});

describe('buildVocabulary — dim override (P7 sweep knob)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    _resetVocabCache();
  });
  afterEach(() => {
    db.close();
  });

  it('caps the vocabulary at a custom dim and reports it', () => {
    // Enough shared terms (df>=2) that the unbounded vocab would exceed 3.
    const docs = [
      'authentication token refresh login session',
      'authentication token refresh logout session',
      'database migration schema column index',
      'database migration schema column table',
    ];
    docs.forEach((narrative, i) => insertObs(db, { title: `obs ${i}`, narrative }));

    const small = buildVocabulary(db, { dim: 3 });
    expect(small.dim).toBe(3);
    expect(small.terms.size).toBeLessThanOrEqual(3);

    _resetVocabCache();
    const full = buildVocabulary(db); // default VOCAB_DIM
    expect(full.dim).toBe(VOCAB_DIM);
    expect(full.terms.size).toBeGreaterThan(small.terms.size);
  });
});

describe('rrfMerge', () => {
  it('merges two ranked lists with correct RRF formula', () => {
    const bm25 = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const vector = [{ id: 2 }, { id: 4 }, { id: 1 }];
    const merged = rrfMerge(bm25, vector);
    expect(merged[0].id).toBe(2);
    const id1 = merged.find((r) => r.id === 1);
    const id4 = merged.find((r) => r.id === 4);
    expect(id1.rrfScore).toBeGreaterThan(id4.rrfScore);
  });

  it('handles empty inputs', () => {
    expect(rrfMerge([], [])).toEqual([]);
    expect(rrfMerge([{ id: 1 }], []).length).toBe(1);
  });

  it('RRF score formula is 1/(k+rank)', () => {
    const result = rrfMerge([{ id: 1 }], [{ id: 1 }], 60);
    expect(result[0].rrfScore).toBeCloseTo(2 / 61, 6);
  });
});

describe('vectorSearch', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    _resetVocabCache();
  });
  afterEach(() => {
    db.close();
  });

  it('finds similar observations by vector', () => {
    insertObs(db, {
      title: 'auth token refresh',
      narrative: 'fix the authentication token expiry bug in login',
    });
    insertObs(db, {
      title: 'database migration script',
      narrative: 'update database schema for new user table columns',
    });
    insertObs(db, {
      title: 'auth session fix',
      narrative: 'the authentication session was broken after logout',
    });

    const vocab = buildVocabulary(db);
    expect(vocab).not.toBeNull();

    const allObs = db.prepare('SELECT id, title, narrative FROM observations').all();
    for (const o of allObs) {
      const vec = computeVector(o.title + ' ' + o.narrative, vocab);
      if (vec) {
        db.prepare(
          'INSERT INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)',
        ).run(o.id, Buffer.from(vec.buffer), vocab.version, Date.now());
      }
    }

    const queryVec = computeVector('authentication problem', vocab);
    expect(queryVec).not.toBeNull();
    const results = vectorSearch(db, queryVec, { vocabVersion: vocab.version });

    expect(results.length).toBeGreaterThan(0);
    const dbObs = allObs.find((o) => o.title.includes('database'));
    const authResults = results.filter((r) => r.id !== dbObs.id);
    expect(authResults.length).toBeGreaterThanOrEqual(1);
  });

  it('honors a custom minCosine floor (P7 sweep knob)', () => {
    insertObs(db, {
      title: 'auth token refresh',
      narrative: 'fix the authentication token expiry bug in login',
    });
    insertObs(db, {
      title: 'database migration script',
      narrative: 'update database schema for new user table columns',
    });
    insertObs(db, {
      title: 'auth session fix',
      narrative: 'the authentication session was broken after logout',
    });

    const vocab = buildVocabulary(db);
    for (const o of db.prepare('SELECT id, title, narrative FROM observations').all()) {
      const vec = computeVector(o.title + ' ' + o.narrative, vocab);
      if (vec) {
        db.prepare(
          'INSERT INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)',
        ).run(o.id, Buffer.from(vec.buffer), vocab.version, Date.now());
      }
    }
    const queryVec = computeVector('authentication problem', vocab);
    const lax = vectorSearch(db, queryVec, { vocabVersion: vocab.version }); // default 0.05
    const strict = vectorSearch(db, queryVec, { vocabVersion: vocab.version, minCosine: 0.999 });
    expect(lax.length).toBeGreaterThan(0);
    // None of these short auth docs hit 0.999 cosine, so a near-1 floor prunes them all.
    expect(strict.length).toBeLessThan(lax.length);
  });

  it('excludes compressed observations', () => {
    insertObs(db, { title: 'active auth fix', narrative: 'authentication repair work for login system' });
    insertObs(db, {
      title: 'compressed auth fix',
      narrative: 'old authentication repair work for session',
      compressedInto: -1,
    });
    // Extra docs to ensure df>=2 for vocabulary building
    insertObs(db, { title: 'auth token update', narrative: 'authentication token refresh and repair logic' });
    insertObs(db, { title: 'login auth flow', narrative: 'authentication flow repair in login module' });

    const vocab = buildVocabulary(db);
    expect(vocab).not.toBeNull();

    const allObs = db.prepare('SELECT id, title, narrative FROM observations').all();
    for (const o of allObs) {
      const vec = computeVector(o.title + ' ' + o.narrative, vocab);
      if (vec) {
        db.prepare(
          'INSERT INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)',
        ).run(o.id, Buffer.from(vec.buffer), vocab.version, Date.now());
      }
    }

    const queryVec = computeVector('authentication', vocab);
    expect(queryVec).not.toBeNull();
    const results = vectorSearch(db, queryVec, { vocabVersion: vocab.version });

    const compressedObs = db.prepare('SELECT id FROM observations WHERE compressed_into IS NOT NULL').get();
    expect(results.every((r) => r.id !== compressedObs?.id)).toBe(true);
  });
});
