// tests/scoring-paths-golden.test.mjs — golden drift-lock for the TWO independent
// observation-scoring paths that intentionally diverge:
//   Path A — passive injection: hook-memory.mjs::searchRelevantMemories (JS multiplier
//            chain applied over BM25-ordered rows; hook-memory.mjs:293).
//   Path B — explicit search:   search-engine.mjs::searchObservationsHybrid (FULL_SCORE
//            SQL multiplier chain; search-engine.mjs:19).
// The two share BM25 + the per-type weight table but DIFFER on purpose: importance
// (A binary 1.0/0.6, B linear 0.5+0.5·imp), and the cross-project / OR-fallback /
// noise / cite factors live ONLY on the injection path. Three reviewers confirmed both
// formulas correct as-is; this file pins each path's load-bearing multipliers and the
// intentional divergence so a later "just unify the two scorers" edit fails loudly
// instead of silently shifting one path's ranking.
//
// METHOD — ratio isolation. Seed two rows whose FTS-indexed content is byte-identical
// (so the BM25 component cancels EXACTLY) differing on ONE non-indexed axis; the score
// ratio then equals that axis's multiplier ratio, independent of the absolute BM25 value
// (robust to SQLite/corpus drift). Axes are all NON-FTS columns — type, importance,
// access_count, cited/uncited, injection_count, project. lesson_learned is itself an FTS
// column (BM25 weight 8) so its presence would move BM25; its 1.5×/1.3× bonus is therefore
// NOT ratio-testable via the real path and is intentionally not pinned here.
import { describe, it, expect } from 'vitest';
import { createTestDb, insertObs, insertSession } from './test-helpers.mjs';
import { searchRelevantMemories } from '../hook-memory.mjs';
import { searchObservationsHybrid } from '../search-engine.mjs';

const PROJECT = 'proj-golden';
// Distinctive nonsense token: single-term query → coverage filter skipped
// (COVERAGE_MIN_QUERY_TERMS=2), no synonym expansion, length ≥5 (non-CJK floor).
const TERM = 'zylphqax';
const SHARED = { project: PROJECT, type: 'feature', title: `${TERM} topic note`, importance: 1 };

// Fresh DB + the session row every observation FKs to (memory_session_id → sdk_sessions).
function freshDb() {
  const db = createTestDb();
  insertSession(db, { id: 'sess-1', project: PROJECT });
  return db;
}

// Seed two rows with identical FTS content, differing only by the given overrides.
function seedPair(db, baseOverrides, variantOverrides) {
  const baseId = Number(insertObs(db, { ...SHARED, ...baseOverrides }).lastInsertRowid);
  const variantId = Number(insertObs(db, { ...SHARED, ...variantOverrides }).lastInsertRowid);
  return { baseId, variantId };
}

// Path A — passive injection. Scores read from the return value (pre injection_count bump).
function injectScores(db) {
  const rows = searchRelevantMemories(db, TERM, PROJECT);
  return new Map(rows.map((r) => [r.id, r.score]));
}

// Path B — explicit search (FULL_SCORE). Scores are negative (BM25 ASC); ratio of two
// negatives is the positive multiplier ratio. projectFilter=null activates project boost.
function searchScores(db, { projectFilter = PROJECT, currentProject = PROJECT } = {}) {
  const rows = searchObservationsHybrid(db, {
    ftsQuery: TERM,
    args: { project: projectFilter },
    epochFrom: null,
    epochTo: null,
    perSourceLimit: 10,
    perSourceOffset: 0,
    currentProject,
    limit: 10,
  });
  return new Map(rows.map((r) => [r.id, r.score]));
}

const ratio = (m, variantId, baseId) => m.get(variantId) / m.get(baseId);

describe('Path A — passive injection scoring (hook-memory searchRelevantMemories)', () => {
  it('per-type weight: decision 1.5×, refactor 0.6×, change 0.5× vs feature 1.0×', () => {
    const db = freshDb();
    const decision = Number(insertObs(db, { ...SHARED, type: 'decision' }).lastInsertRowid);
    const refactor = Number(insertObs(db, { ...SHARED, type: 'refactor' }).lastInsertRowid);
    const feature = Number(insertObs(db, { ...SHARED, type: 'feature' }).lastInsertRowid);
    const m = injectScores(db);
    expect(ratio(m, decision, feature)).toBeCloseTo(1.5, 4);
    expect(ratio(m, refactor, feature)).toBeCloseTo(0.6, 4);
    db.close();
  });

  it('importance is BINARY: imp2/imp1 = 1.0/0.6, and imp3/imp2 = 1.0 (no rise past 2)', () => {
    const db = freshDb();
    const { baseId: imp1, variantId: imp2 } = seedPair(db, { importance: 1 }, { importance: 2 });
    const imp3 = Number(insertObs(db, { ...SHARED, importance: 3 }).lastInsertRowid);
    const m = injectScores(db);
    expect(ratio(m, imp2, imp1)).toBeCloseTo(1 / 0.6, 4);
    expect(ratio(m, imp3, imp2)).toBeCloseTo(1.0, 4); // binary cliff — 2 and 3 score equal
    db.close();
  });

  it('cite factor: cited_count=5 → 2.0×, uncited_streak=2 → 0.5×', () => {
    const db = freshDb();
    const { baseId, variantId: cited } = seedPair(db, {}, { citedCount: 5 });
    const streak = Number(insertObs(db, { ...SHARED, uncitedStreak: 2 }).lastInsertRowid);
    const m = injectScores(db);
    expect(ratio(m, cited, baseId)).toBeCloseTo(2.0, 4);
    expect(ratio(m, streak, baseId)).toBeCloseTo(0.5, 4);
    db.close();
  });

  it('noise penalty: injection_count≥8 (≫access) → 0.2×, ≥4 → 0.5×', () => {
    const db = freshDb();
    const clean = Number(insertObs(db, { ...SHARED }).lastInsertRowid);
    const tier1 = Number(insertObs(db, { ...SHARED, injectionCount: 4, accessCount: 0 }).lastInsertRowid);
    const tier2 = Number(insertObs(db, { ...SHARED, injectionCount: 8, accessCount: 0 }).lastInsertRowid);
    const m = injectScores(db);
    expect(ratio(m, tier1, clean)).toBeCloseTo(0.5, 4);
    expect(ratio(m, tier2, clean)).toBeCloseTo(0.2, 4);
    db.close();
  });

  it('recency is AGE-FLAT: a 30-day-old row scores ~1.0× a fresh one (no graded decay)', () => {
    // Path A has only a hard 60-day cutoff (MEMORY_LOOKBACK_MS), no exponential
    // decay term. Two rows of the same type within the window, differing only in
    // created_at_epoch, must score equal. This pins the intentional divergence
    // from Path B (which DOES decay) so a later "add decay to injection" or
    // "unify the scorers" edit fails loudly. created_at_epoch is non-FTS → testable.
    const db = freshDb();
    const { baseId: fresh, variantId: old } = seedPair(
      db,
      { epochOffset: 0 },
      { epochOffset: -30 * 86400000 },
    );
    const m = injectScores(db);
    expect(ratio(m, old, fresh)).toBeCloseTo(1.0, 3);
    db.close();
  });

  it('cross-project penalty defaults to 0.4× (NOT the stale "0.7" in the inline comment)', () => {
    const db = freshDb();
    // Both rows must be decision+imp2 so only the project axis varies: same-project full
    // weight vs cross-project transferable-decision discount.
    const same = Number(insertObs(db, { ...SHARED, type: 'decision', importance: 2 }).lastInsertRowid);
    const cross = Number(
      insertObs(db, { ...SHARED, type: 'decision', importance: 2, project: 'other-proj' }).lastInsertRowid,
    );
    const m = injectScores(db);
    expect(ratio(m, cross, same)).toBeCloseTo(0.4, 4);
    db.close();
  });
});

describe('Path B — explicit search scoring (searchObservationsHybrid FULL_SCORE)', () => {
  it('per-type quality: decision 1.5×, change 0.5× vs feature 1.0×', () => {
    const db = freshDb();
    const decision = Number(insertObs(db, { ...SHARED, type: 'decision' }).lastInsertRowid);
    const change = Number(insertObs(db, { ...SHARED, type: 'change' }).lastInsertRowid);
    const feature = Number(insertObs(db, { ...SHARED, type: 'feature' }).lastInsertRowid);
    const m = searchScores(db);
    expect(ratio(m, decision, feature)).toBeCloseTo(1.5, 3);
    expect(ratio(m, change, feature)).toBeCloseTo(0.5, 3);
    db.close();
  });

  it('importance is LINEAR: imp2/imp1 = 1.5, imp3/imp1 = 2.0 (0.5+0.5·imp)', () => {
    const db = freshDb();
    const { baseId: imp1, variantId: imp2 } = seedPair(db, { importance: 1 }, { importance: 2 });
    const imp3 = Number(insertObs(db, { ...SHARED, importance: 3 }).lastInsertRowid);
    const m = searchScores(db);
    expect(ratio(m, imp2, imp1)).toBeCloseTo(1.5, 4);
    expect(ratio(m, imp3, imp1)).toBeCloseTo(2.0, 4); // keeps rising — unlike Path A's cliff
    db.close();
  });

  it('access bonus: access_count=10 → 1 + 0.1·ln(11)', () => {
    const db = freshDb();
    const { baseId, variantId } = seedPair(db, { accessCount: 0 }, { accessCount: 10 });
    const m = searchScores(db);
    expect(ratio(m, variantId, baseId)).toBeCloseTo(1 + 0.1 * Math.log(11), 4);
    db.close();
  });

  it('recency decay: a feature row aged one half-life (30d) scores 0.75× a fresh one', () => {
    // Path B applies 1 + EXP(-0.693·age/halfLife); feature half-life = 30d
    // (DECAY_HALF_LIFE_BY_TYPE). Fresh row → 1+EXP(0)=2.0; one-half-life-old →
    // 1+EXP(-0.693)=1.5; ratio = 0.75. created_at_epoch is non-FTS so the BM25
    // component cancels. This pins the decay axis the ratio-isolation header had
    // left unguarded — a change to the half-life table or the decay constant now
    // fails here instead of silently shifting Path B ranking.
    const db = freshDb();
    const { baseId: fresh, variantId: aged } = seedPair(
      db,
      { epochOffset: 0 },
      { epochOffset: -30 * 86400000 },
    );
    const m = searchScores(db);
    expect(ratio(m, aged, fresh)).toBeCloseTo(0.75, 2);
    db.close();
  });

  it('project boost: same-project as currentProject = 2.0× a cross-project row', () => {
    const db = freshDb();
    const same = Number(insertObs(db, { ...SHARED }).lastInsertRowid);
    const cross = Number(insertObs(db, { ...SHARED, project: 'other-proj' }).lastInsertRowid);
    // projectFilter=null → projectBoost = currentProject = PROJECT (boost CASE active).
    const m = searchScores(db, { projectFilter: null, currentProject: PROJECT });
    expect(ratio(m, same, cross)).toBeCloseTo(2.0, 4);
    db.close();
  });
});

describe('intentional divergence between the two scoring paths', () => {
  it('importance handling differs: injection is binary (1/0.6), search is linear (1.5)', () => {
    // The single most likely "accidental unification" target. Same seed, both paths,
    // different ratio — this is by design, not a bug. If a future edit makes them equal,
    // one path's behavior silently changed; this assertion fails first.
    const dbA = freshDb();
    const a = seedPair(dbA, { importance: 1 }, { importance: 2 });
    const injRatio = ratio(injectScores(dbA), a.variantId, a.baseId);
    dbA.close();

    const dbB = freshDb();
    const b = seedPair(dbB, { importance: 1 }, { importance: 2 });
    const searchRatio = ratio(searchScores(dbB), b.variantId, b.baseId);
    dbB.close();

    expect(injRatio).toBeCloseTo(1 / 0.6, 4); // ≈1.6667 binary
    expect(searchRatio).toBeCloseTo(1.5, 4); // linear
    expect(injRatio).not.toBeCloseTo(searchRatio, 3);
  });
});
