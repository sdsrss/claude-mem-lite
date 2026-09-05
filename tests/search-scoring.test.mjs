// Unit tests for search-scoring.mjs (extracted from server.mjs for testability)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import {
  reRankWithContext,
  extractPRFTerms,
  expandQueryByConcepts,
  PRF_STOP_WORDS,
} from '../search-scoring.mjs';

// ─── reRankWithContext ──────────────────────────────────────────────────────

describe('reRankWithContext', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => {
    db.close();
  });

  it('boosts results with exact file match', () => {
    // Insert recent obs editing auth.js (active file — within 2h window)
    insertObs(db, { title: 'recent edit', filesModified: '["src/auth.js"]', epochOffset: -1000 });
    // Insert OLD result obs (outside 2h window so they don't contribute to active files)
    const r1 = insertObs(db, {
      title: 'auth result',
      filesModified: '["src/auth.js"]',
      epochOffset: -3 * 3600000,
    });
    const r2 = insertObs(db, {
      title: 'other result',
      filesModified: '["lib/other.js"]',
      epochOffset: -3 * 3600000,
    });

    const results = [
      { source: 'obs', id: Number(r1.lastInsertRowid), score: -5.0 },
      { source: 'obs', id: Number(r2.lastInsertRowid), score: -5.0 },
    ];
    reRankWithContext(db, results, 'test');

    // auth.js result should be boosted (more negative)
    expect(results[0].score).toBeLessThan(-5.0);
    // unrelated dir result should not be boosted
    expect(results[1].score).toBe(-5.0);
  });

  it('applies half-weight for directory-level matches', () => {
    // Active file: Button.js (within 2h window)
    insertObs(db, {
      title: 'recent edit',
      filesModified: '["src/components/Button.js"]',
      epochOffset: -1000,
    });
    // Result obs touches Modal.js (same dir, different file) — outside 2h window
    const r1 = insertObs(db, {
      title: 'modal result',
      filesModified: '["src/components/Modal.js"]',
      epochOffset: -3 * 3600000,
    });

    const results = [{ source: 'obs', id: Number(r1.lastInsertRowid), score: -5.0 }];
    reRankWithContext(db, results, 'test');

    // Should be boosted but less than exact match (half weight)
    expect(results[0].score).toBeLessThan(-5.0);
    const boost = results[0].score / -5.0;
    // 0.3 * 0.5 * (1/1) = 0.15 -> multiplier = 1.15
    expect(boost).toBeCloseTo(1.15, 1);
  });

  it('skips when no active files', () => {
    // No recent observations -> no active files
    const r1 = insertObs(db, { title: 'old obs', filesModified: '["foo.js"]', epochOffset: -3 * 3600000 });

    const results = [{ source: 'obs', id: Number(r1.lastInsertRowid), score: -5.0 }];
    reRankWithContext(db, results, 'test');
    expect(results[0].score).toBe(-5.0);
  });

  it('skips non-obs results', () => {
    insertObs(db, { title: 'recent', filesModified: '["foo.js"]', epochOffset: -1000 });

    const results = [{ source: 'session', id: 999, score: -5.0 }];
    reRankWithContext(db, results, 'test');
    expect(results[0].score).toBe(-5.0);
  });

  it('handles obs without observation_files entries gracefully', () => {
    insertObs(db, { title: 'recent', filesModified: '["foo.js"]', epochOffset: -1000 });
    // Result obs with no files
    const r1 = insertObs(db, { title: 'no files', filesModified: '[]', epochOffset: -5000 });

    const results = [{ source: 'obs', id: Number(r1.lastInsertRowid), score: -5.0 }];
    expect(() => reRankWithContext(db, results, 'test')).not.toThrow();
    expect(results[0].score).toBe(-5.0);
  });
});

// ─── extractPRFTerms ────────────────────────────────────────────────────────

describe('extractPRFTerms', () => {
  it('extracts discriminative terms from top results', () => {
    const results = [
      {
        title: 'authentication session handling',
        narrative: 'The authentication module handles session tokens securely',
      },
      {
        title: 'session token refresh logic',
        narrative: 'Session token refresh was broken in the authentication flow',
      },
      { title: 'token validation fix', narrative: 'Fixed token validation in authentication middleware' },
    ];
    const terms = extractPRFTerms(results, '"search"');
    expect(terms.length).toBeGreaterThan(0);
    // Should find terms that appear in >=2 docs
    for (const t of terms) {
      expect(t.length).toBeGreaterThan(3);
    }
  });

  it('excludes query terms', () => {
    const results = [
      {
        title: 'authentication fix applied',
        narrative: 'Fixed the authentication flow for authentication system',
      },
      { title: 'authentication token update', narrative: 'Updated authentication tokens for authentication' },
    ];
    const terms = extractPRFTerms(results, '"authentication"');
    expect(terms.every((t) => t !== 'authentication')).toBe(true);
  });

  it('respects limit parameter', () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      title: `common term1 term2 term3 term4 term5 doc${i}`,
      narrative: `narrative with term1 term2 term3 term4 term5 extra${i}`,
    }));
    const terms = extractPRFTerms(results, '"search"', 2);
    expect(terms.length).toBeLessThanOrEqual(2);
  });

  it('returns empty for empty results', () => {
    const terms = extractPRFTerms([], '"query"');
    expect(terms).toEqual([]);
  });

  it('filters PRF stop words', () => {
    const results = [
      { title: 'the code was changed', narrative: 'the file was updated with new changes' },
      { title: 'changed the file code', narrative: 'updated the code file changes' },
    ];
    const terms = extractPRFTerms(results, '"query"');
    for (const t of terms) {
      expect(PRF_STOP_WORDS.has(t)).toBe(false);
    }
  });

  it('requires >=2 document frequency', () => {
    const results = [
      { title: 'unique1234 in first doc', narrative: 'some content here' },
      { title: 'different content', narrative: 'other stuff entirely' },
    ];
    const terms = extractPRFTerms(results, '"query"');
    // unique1234 only appears in 1 doc, should not be extracted
    expect(terms.every((t) => t !== 'unique1234')).toBe(true);
  });
});

// ─── extractPRFTerms surface forms (audit P2-24 / P3-9, 2026-07-24) ──────────
// The PRF terms are fed back into `observations_fts MATCH` (search-engine.mjs), and
// that index uses FTS5's DEFAULT unicode61 tokenizer — NO porter stemming (verified:
// MATCH "cach" returns zero rows; only "caching"/"cache" match). So emitting a bare
// porter STEM ("cach") silently matches nothing and kills expansion recall. The stem is
// still used to BUCKET morphological variants for the ">= 2 docs" discriminativeness
// bar, but the SELECTED term must be a surface form that actually occurs in the index.

describe('extractPRFTerms surface forms', () => {
  const results = [
    {
      title: 'Implementing the caching layer',
      narrative: 'Implemented a caching mechanism for database queries',
    },
    {
      title: 'Cache implementation details',
      narrative: 'The implementation uses Redis for distributed caching',
    },
    { title: 'Testing caching behavior', narrative: 'Verified the caching implementation works correctly' },
  ];

  it('emits only surface forms that occur verbatim in the source docs (unstemmed index is matchable)', () => {
    const terms = extractPRFTerms(results, 'database query');
    expect(terms.length).toBeGreaterThan(0);
    const corpusTokens = new Set(
      results
        .map((r) => (r.title + ' ' + r.narrative).toLowerCase())
        .join(' ')
        .replace(/[^a-z0-9_-]/g, ' ')
        .split(/\s+/),
    );
    for (const t of terms) expect(corpusTokens.has(t)).toBe(true);
  });

  it('does NOT emit bare porter stems that the unicode61 index cannot match', () => {
    const terms = extractPRFTerms(results, 'database query');
    expect(terms).not.toContain('cach'); // porter stem of caching/cache → 0 FTS hits
    expect(terms).not.toContain('implement'); // porter stem of implementation/implementing → 0 FTS hits
  });

  it('still merges morphological variants so the family clears the >=2-doc bar', () => {
    const terms = extractPRFTerms(results, 'database query');
    // caching-family and/or implementation-family selected via their shared stem
    expect(terms.some((t) => t.startsWith('cach') || t.startsWith('implement'))).toBe(true);
  });
});

// ─── expandQueryByConcepts ──────────────────────────────────────────────────

describe('expandQueryByConcepts', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => {
    db.close();
  });

  it('discovers co-occurring concepts', () => {
    // Insert observations with shared concepts
    for (let i = 0; i < 3; i++) {
      const now = Date.now() + i;
      db.prepare(
        `
        INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, 'test', ?, 'discovery', ?, '', 'auth security tokens', '', '[]', '[]', 1, ?, ?)
      `,
      ).run('sess-1', `authentication text ${i}`, `auth obs ${i}`, new Date(now).toISOString(), now);
    }

    const concepts = expandQueryByConcepts(db, '"auth"', 'test');
    // "security" and "tokens" should co-occur with "auth"
    expect(concepts.length).toBeGreaterThan(0);
    expect(concepts.every((c) => c !== 'auth')).toBe(true);
  });

  it('excludes query terms from results', () => {
    for (let i = 0; i < 3; i++) {
      const now = Date.now() + i;
      db.prepare(
        `
        INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, 'test', ?, 'discovery', ?, '', 'database query optimization', '', '[]', '[]', 1, ?, ?)
      `,
      ).run('sess-1', `database text ${i}`, `db obs ${i}`, new Date(now).toISOString(), now);
    }

    const concepts = expandQueryByConcepts(db, '"database"', 'test');
    expect(concepts.every((c) => c !== 'database')).toBe(true);
  });

  it('respects project filter', () => {
    for (let i = 0; i < 3; i++) {
      const now = Date.now() + i;
      db.prepare(
        `
        INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, 'other-project', ?, 'discovery', ?, '', 'react hooks state', '', '[]', '[]', 1, ?, ?)
      `,
      ).run('sess-1', `react text ${i}`, `react obs ${i}`, new Date(now).toISOString(), now);
    }

    // Searching in 'test' project should not find 'other-project' observations
    const concepts = expandQueryByConcepts(db, '"react"', 'test');
    expect(concepts.length).toBe(0);
  });

  it('returns empty when no matches', () => {
    const concepts = expandQueryByConcepts(db, '"nonexistent_xyz"', 'test');
    expect(concepts).toEqual([]);
  });

  it('handles FTS5 errors gracefully', () => {
    // Invalid FTS query should not throw
    const concepts = expandQueryByConcepts(db, '""', 'test');
    expect(concepts).toEqual([]);
  });
});
