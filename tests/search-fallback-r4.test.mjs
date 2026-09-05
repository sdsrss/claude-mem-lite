// R4 E2E audit — two retrieval-core defects:
//   MED (fix 10) — the MCP type-list fallback (obs_type set + 0 FTS matches → list
//     recent of that type) dropped the low-signal title filter every FTS path applies,
//     so degraded titles ("Modified X", "Error: …") led the results — worst for
//     obs_type='change', the noise band.
//   LOW (fix 14) — the ranking lesson-boost fired on lesson_learned='none' (Haiku's
//     default / legacy value the codebase GCs), diverging from the canonical
//     `NOT IN ('', 'none')` predicate used at ~8 sites → junk rows got a 1.3× boost.
import { describe, it, expect } from 'vitest';
import { handleSearchForTest } from '../server.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

describe('R4 fix 10 — type-list fallback filters low-signal titles', () => {
  function seed() {
    const db = createTestDb();
    insertSession(db, { id: 's', project: 'p', memoryId: 's' });
    insertObs(db, { sessionId: 's', project: 'p', type: 'change', title: 'Modified cli.mjs', narrative: '' }); // id 1 — low-signal
    insertObs(db, {
      sessionId: 's',
      project: 'p',
      type: 'change',
      title: 'Investigated the token refresh race',
      narrative: 'real body',
    }); // id 2 — normal
    return db;
  }

  it('a no-FTS-match query + obs_type falls back to type-listing with low-signal filtered out', async () => {
    const db = seed();
    const res = await handleSearchForTest(
      db,
      { query: 'zzznomatchqqqxyz', obs_type: 'change', deep: false },
      {},
    );
    const ids = (res.results || []).map((r) => r.id);
    db.close();
    expect(ids).toContain(2); // fallback fired → the normal change surfaced
    expect(ids).not.toContain(1); // the low-signal "Modified cli.mjs" no longer leads it
  });

  it('include_noise=true still surfaces the low-signal row (opt-out preserved)', async () => {
    const db = seed();
    const res = await handleSearchForTest(
      db,
      { query: 'zzznomatchqqqxyz', obs_type: 'change', deep: false, include_noise: true },
      {},
    );
    const ids = (res.results || []).map((r) => r.id);
    db.close();
    expect(ids).toContain(1); // explicit opt-in brings the degraded-title row back
  });
});

describe('R4 fix 14 — lesson_learned="none" does not earn the ranking boost', () => {
  it('a "none"-lesson row ranks the same as a NULL-lesson row (no phantom boost)', async () => {
    const db = createTestDb();
    insertSession(db, { id: 's', project: 'p', memoryId: 's' });
    // Identical rows except lesson: one NULL, one the literal 'none'.
    insertObs(db, {
      sessionId: 's',
      project: 'p',
      type: 'discovery',
      title: 'kubernetes scheduling deep dive',
      narrative: 'kubernetes scheduling',
      lessonLearned: null,
    });
    insertObs(db, {
      sessionId: 's',
      project: 'p',
      type: 'discovery',
      title: 'kubernetes scheduling deep dive',
      narrative: 'kubernetes scheduling',
      lessonLearned: 'none',
    });
    const res = await handleSearchForTest(db, { query: 'kubernetes', deep: false }, {});
    const byId = new Map((res.results || []).map((r) => [r.id, r]));
    db.close();
    const a = byId.get(1),
      b = byId.get(2);
    expect(a && b).toBeTruthy();
    // Scores are negative (negative_BM25 × positive multipliers); more-negative ranks first.
    // With the boost removed for 'none', the two rows differ only by a tiny second-order
    // BM25 perturbation (the literal 'none' token in the lesson_learned FTS column) —
    // NOT the 1.3× boost (~0.25 differential), which the pre-fix code applied.
    expect(typeof a.score === 'number' && typeof b.score === 'number').toBe(true);
    expect(Math.abs(a.score - b.score)).toBeLessThan(0.05);
  });

  it('a row with a REAL lesson still earns the boost (no regression)', async () => {
    const db = createTestDb();
    insertSession(db, { id: 's', project: 'p', memoryId: 's' });
    insertObs(db, {
      sessionId: 's',
      project: 'p',
      type: 'discovery',
      title: 'kubernetes scheduling deep dive',
      narrative: 'kubernetes scheduling',
      lessonLearned: null,
    });
    insertObs(db, {
      sessionId: 's',
      project: 'p',
      type: 'discovery',
      title: 'kubernetes scheduling deep dive',
      narrative: 'kubernetes scheduling',
      lessonLearned: 'always drain connections before rescheduling pods',
    });
    const res = await handleSearchForTest(db, { query: 'kubernetes', deep: false }, {});
    const byId = new Map((res.results || []).map((r) => [r.id, r]));
    db.close();
    const a = byId.get(1),
      c = byId.get(2);
    expect(a && c).toBeTruthy();
    // More-negative = ranked higher; the real-lesson row keeps its 1.3× boost, so its
    // score is strictly more negative than the lesson-less row's.
    expect(c.score).toBeLessThan(a.score);
  });
});
