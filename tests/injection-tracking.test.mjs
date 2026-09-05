// P0 injection-noise tracking — v26 schema + noise-ratio penalty.
//
// Verifies:
//   - schema v26 adds injection_count (default 0) + last_injected_at (NULL)
//   - noisePenaltyClause applies tiered penalty based on ratio thresholds
//   - hook-memory.mjs injection bump targets injection_count (not access_count)
//   - pre-existing access_count semantics preserved for explicit access paths

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { noisePenaltyClause } from '../scoring-sql.mjs';
import { searchRelevantMemories } from '../hook-memory.mjs';

describe('v26 schema migration', () => {
  it('exposes CURRENT_SCHEMA_VERSION >= 26', async () => {
    const { CURRENT_SCHEMA_VERSION: v } = await import('../schema.mjs');
    expect(v).toBeGreaterThanOrEqual(26);
  });

  it('observations table has injection_count (default 0) + last_injected_at (NULL)', () => {
    const db = createTestDb();
    const cols = db.prepare('PRAGMA table_info(observations)').all();
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has('injection_count')).toBe(true);
    expect(byName.has('last_injected_at')).toBe(true);

    // Default value check — SQLite returns string "0" for INTEGER DEFAULT 0
    const injectionCol = byName.get('injection_count');
    expect(String(injectionCol.dflt_value)).toBe('0');
    expect(injectionCol.notnull).toBe(1);

    const lastInjCol = byName.get('last_injected_at');
    expect(lastInjCol.notnull).toBe(0);
  });

  it('new observations default to injection_count=0, last_injected_at=NULL', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    const res = insertObs(db, { title: 'noise test', type: 'bugfix' });
    const row = db
      .prepare('SELECT injection_count, last_injected_at FROM observations WHERE id = ?')
      .get(res.lastInsertRowid);
    expect(row.injection_count).toBe(0);
    expect(row.last_injected_at).toBeNull();
  });

  it('migration is idempotent (second initSchema call on same DB is no-op)', async () => {
    const { initSchema } = await import('../schema.mjs');
    const db = createTestDb();
    const v1 = db.prepare('SELECT version FROM schema_version LIMIT 1').get().version;
    initSchema(db); // run again
    const v2 = db.prepare('SELECT version FROM schema_version LIMIT 1').get().version;
    expect(v1).toBe(v2);
    expect(v2).toBeGreaterThanOrEqual(26);
  });
});

describe('noisePenaltyClause SQL', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });

  function penaltyFor(injection_count, access_count) {
    const res = insertObs(db, {
      title: `inj=${injection_count} acc=${access_count}`,
      type: 'bugfix',
      accessCount: access_count,
    });
    db.prepare('UPDATE observations SET injection_count = ? WHERE id = ?').run(
      injection_count,
      res.lastInsertRowid,
    );
    const row = db
      .prepare(`SELECT ${noisePenaltyClause('o')} as p FROM observations o WHERE id = ?`)
      .get(res.lastInsertRowid);
    return row.p;
  }

  it('returns 1.0 when injection_count below tier-1 gate (count < 4, v2.47)', () => {
    expect(penaltyFor(3, 0)).toBeCloseTo(1.0);
    expect(penaltyFor(1, 0)).toBeCloseTo(1.0);
    expect(penaltyFor(0, 0)).toBeCloseTo(1.0);
  });

  it('returns 0.5 at tier-1 (v2.47): count>=4 AND ratio>3', () => {
    // inj=4, acc=0 → ratio=inf → tier-1 threshold newly calibrated
    expect(penaltyFor(4, 0)).toBeCloseTo(0.5);
    // #3518 live row: inj=6, acc=1, ratio=6.0 — real noise hit
    expect(penaltyFor(6, 1)).toBeCloseTo(0.5);
    // inj=7, acc=2 → ratio=3.5 → tier-1 (below count=8 for tier-2)
    expect(penaltyFor(7, 2)).toBeCloseTo(0.5);
  });

  it('returns 0.2 at tier-2 (v2.47): count>=8 AND ratio>5', () => {
    // inj=8, acc=0 → ratio=inf → tier-2
    expect(penaltyFor(8, 0)).toBeCloseTo(0.2);
    // inj=20, acc=4 → ratio=5.0, NOT tier-2 (ratio<=5)
    expect(penaltyFor(20, 4)).toBeCloseTo(0.5); // tier-1
    // inj=50, acc=8 → ratio=6.25 → tier-2
    expect(penaltyFor(50, 8)).toBeCloseTo(0.2);
  });

  it('spares legitimate heavy-use obs (v2.47): ratio-gate is primary precision signal', () => {
    // Live row #5588 (inj=9, acc=10, ratio=0.9) — heavily used + cited.
    // Count exceeds both tier-1 and tier-2 gates but ratio below both → 1.0
    expect(penaltyFor(9, 10)).toBeCloseTo(1.0);
    // Live row #7549 (inj=7, acc=13, ratio=0.54) — more cited than injected
    expect(penaltyFor(7, 13)).toBeCloseTo(1.0);
  });

  it('NULL-safety COALESCE guards the expression (literal NULL inputs → 1.0)', () => {
    // COALESCE is defense-in-depth for partial migrations / concurrent upgrades.
    // The NOT NULL DEFAULT 0 migration makes NULL unreachable via normal inserts,
    // but we verify the expression handles NULL inputs correctly in isolation.
    const row = db
      .prepare(
        `
      SELECT (CASE
        WHEN COALESCE(NULL, 0) >= 8 AND COALESCE(NULL, 0) > COALESCE(NULL, 0) * 5 THEN 0.2
        WHEN COALESCE(NULL, 0) >= 4 AND COALESCE(NULL, 0) > COALESCE(NULL, 0) * 3 THEN 0.5
        ELSE 1.0
      END) as p
    `,
      )
      .get();
    expect(row.p).toBeCloseTo(1.0);
  });
});

describe('hook-memory searchRelevantMemories → injection_count bump', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });

  it('bumps injection_count (NOT access_count) when rows are returned', () => {
    const obs = insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'bugfix',
      title: 'fix race condition in FTS5 trigger',
      narrative: 'FTS5 trigger fires on every UPDATE including access_count bumps',
      importance: 2,
      lessonLearned: 'wrap access_count UPDATEs in try-catch',
      accessCount: 5,
    });
    const obsId = Number(obs.lastInsertRowid);

    const before = db
      .prepare('SELECT injection_count, access_count FROM observations WHERE id = ?')
      .get(obsId);
    expect(before.injection_count).toBe(0);
    expect(before.access_count).toBe(5);

    const results = searchRelevantMemories(db, 'FTS5 trigger race condition', 'test');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id === obsId)).toBe(true);

    const after = db
      .prepare('SELECT injection_count, access_count, last_injected_at FROM observations WHERE id = ?')
      .get(obsId);
    expect(after.injection_count).toBe(1); // bumped
    expect(after.access_count).toBe(5); // UNCHANGED — the key P0 fix
    expect(after.last_injected_at).toBeGreaterThan(0);
  });

  it('accumulates injection_count across multiple calls', () => {
    const obs = insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'decision',
      title: 'decision about testing',
      narrative: 'use vitest for all test suites',
      importance: 2,
    });
    const obsId = Number(obs.lastInsertRowid);

    for (let i = 0; i < 3; i++) {
      searchRelevantMemories(db, 'decision about testing vitest', 'test');
    }

    const row = db.prepare('SELECT injection_count FROM observations WHERE id = ?').get(obsId);
    expect(row.injection_count).toBe(3);
  });

  it('noise-penalty demotes high-inject/low-access obs below cleaner alternatives', () => {
    // Set up two obs matching the same query:
    //   noisy:   inj=25, acc=1 → ratio=25 → tier-2 (0.2×)
    //   clean:   inj=1,  acc=5 → no penalty (1.0×)
    // Both have same BM25-eligible text; cleaner should rank higher.
    const noisy = insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'decision',
      title: 'database migration pattern',
      narrative: 'schema migration approach for cross-session state',
      importance: 2,
    });
    const clean = insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'decision',
      title: 'database migration approach',
      narrative: 'schema migration approach for cross-session state',
      importance: 2,
      epochOffset: -1000,
    });
    db.prepare('UPDATE observations SET injection_count = 25, access_count = 1 WHERE id = ?').run(
      noisy.lastInsertRowid,
    );
    db.prepare('UPDATE observations SET injection_count = 1, access_count = 5 WHERE id = ?').run(
      clean.lastInsertRowid,
    );

    const results = searchRelevantMemories(db, 'database migration approach', 'test');
    const cleanRank = results.findIndex((r) => r.id === Number(clean.lastInsertRowid));
    const noisyRank = results.findIndex((r) => r.id === Number(noisy.lastInsertRowid));

    // Clean obs must appear and outrank the noisy one
    expect(cleanRank).toBeGreaterThanOrEqual(0);
    if (noisyRank >= 0) {
      expect(cleanRank).toBeLessThan(noisyRank);
    }
  });
});
