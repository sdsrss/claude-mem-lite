// Guards for benchmark/multiplier-discrimination.mjs — the ruler that answers
// "can this instrument observe each scoring multiplier at all", and for the
// project boost/filter separation in benchmark.mjs that its project arm needs.
//
// Why these exist: benchmark/ci-gate.mjs cannot say NO about the multipliers.
// Measured 2026-09-07 on `main` @ f25e8ae with two mutations applied to the real
// tree and reverted (checksums verified both ways):
//   * MULT_EXPR.importance neutered to a constant -> gate exit 0, all four
//     checks PASS, and `hybrid_over_bm25` went UP (R 0.0002 -> 0.0019) because
//     importance is a NEGATIVE contributor on the canonical fixture.
//   * MULT_EXPR.lesson's 0.3 changed to 0.5 -> gate output byte-identical, every
//     digit, because the fixture holds zero lesson_learned rows.
// The ruler caught both (DEAD and MISMATCH respectively). These tests keep it
// able to.

import { describe, it, expect } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import {
  ARMS,
  measureArm,
  seedArm,
  runDiscrimination,
  runSelfChecks,
} from '../benchmark/multiplier-discrimination.mjs';
import { searchObservations } from '../benchmark/benchmark.mjs';

describe('multiplier discrimination ruler', () => {
  it('reads MEASURED on every multiplier the shipped stack claims to apply', () => {
    const results = runDiscrimination();
    expect(results).toHaveLength(8);
    const bad = results.filter((r) => r.verdict !== 'MEASURED');
    // Naming the offenders rather than asserting a count — a count tells you
    // something broke, the name set tells you what (doctrine rule 4).
    expect(bad.map((r) => `${r.term}:${r.verdict}`)).toEqual([]);
  });

  it('recovers each multiplier ratio to the value the formula declares', () => {
    for (const r of runDiscrimination()) {
      expect(Math.abs(r.measuredRatio - r.expectedRatio)).toBeLessThan(1e-3 * r.expectedRatio);
    }
  });

  it('asserts its own premises: tied BM25, varied axis, unbiased tie-break', () => {
    for (const r of runDiscrimination()) {
      expect(r.axisVaried, `${r.term} axis`).toBe(true);
      expect(r.bm25Tied, `${r.term} bm25 gap ${r.maxBm25Gap}`).toBe(true);
      // An exact tie must split evenly, or every ablated arm inherits a
      // systematic tie-break and reads 1.0 instead of 0.5.
      expect(r.bm25Acc, `${r.term} tie-break`).toBe(0.5);
      expect(r.tieUnbiased).toBe(true);
    }
  });

  // ─── The ruler must be able to say NO ─────────────────────────────────────

  it('says DEAD when the term under test is present in BOTH arms', () => {
    // This is the mutation the ruler must survive: if it reports a multiplier
    // that is not actually being removed, every reading above is theatre.
    for (const arm of ARMS) {
      const r = measureArm(arm, { ablatedMode: 'hybrid' });
      expect(r.verdict, arm.term).toBe('DEAD');
      // Mirror the ruler's own RATIO_TOL rather than picking a tighter digit
      // count: the decay term reads wall-clock, so two same-mode runs a few ms
      // apart differ by ~1e-10. An assertion tighter than the instrument's
      // declared tolerance is asserting timing noise — it went red once here at
      // 9.3e-11 under full-suite load.
      expect(Math.abs(r.measuredRatio - 1), arm.term).toBeLessThan(1e-6);
      expect(r.hybridAcc).toBe(r.ablatedAcc);
    }
  });

  it('says BLIND — not DEAD — when the axis cannot vary', () => {
    // The distinction the canonical fixture gets wrong. It carries no
    // access_count, no lesson_learned and no cite/noise state, so those arms
    // read 0 there by construction; calling that "dead weight" is the
    // misreading scoring-sql.mjs warns about.
    for (const arm of ARMS) {
      const r = measureArm({ ...arm, preferred: arm.other, other: arm.other });
      expect(r.verdict.startsWith('BLIND'), `${arm.term} -> ${r.verdict}`).toBe(true);
      expect(r.verdict).not.toBe('DEAD');
    }
  });

  it('says MISMATCH when a multiplier magnitude stops matching its declaration', () => {
    for (const arm of ARMS) {
      const r = measureArm({ ...arm, expectedRatio: arm.expectedRatio * 0.5 });
      expect(r.verdict, arm.term).toBe('MISMATCH');
    }
  });

  it('--self-check drives all four families to failure and passes 32 checks', () => {
    const { passed, failed } = runSelfChecks();
    expect(failed).toEqual([]);
    expect(passed).toBe(ARMS.length * 4);
  });
});

describe('benchmark project boost is separate from the project filter', () => {
  // Mirrors search-engine.mjs:606 — `projectBoost = args.project ? null :
  // currentProject`. Behavioural, not a source-text scan: a `git revert` of the
  // fix restores the conflation, and a text guard on the new line would not
  // catch someone reintroducing it a different way.
  const seedTwoProjects = (db) => {
    const arm = ARMS.find((a) => a.term === 'project');
    return seedArm(db, arm, 2);
  };

  it('does NOT boost when a project filter is set — the boost would be rank-invariant there', () => {
    const db = createTestDb();
    try {
      const [pair] = seedTwoProjects(db);
      const opts = { mode: 'hybrid', limit: 10, project: 'probe--alpha' };
      const withChain = searchObservations(db, pair.nonce, opts);
      const withoutProjectTerm = searchObservations(db, pair.nonce, {
        ...opts,
        mode: 'no_project',
      });
      // The filter already restricted the set to that project, so applying the
      // 2.0 to every survivor changes no ranking — production disables it, and
      // so must the harness. Pre-fix these differed by exactly the 2.0 factor.
      expect(withChain).toHaveLength(1);
      // Relative, for the same wall-clock reason as the sibling test below.
      // Pre-fix these differed by exactly 2x, so the band is not load-bearing.
      expect(
        Math.abs(withChain[0].score - withoutProjectTerm[0].score) / Math.abs(withoutProjectTerm[0].score),
      ).toBeLessThan(1e-6);
    } finally {
      db.close();
    }
  });

  it('DOES boost when currentProject is set with no filter — the case production actually runs', () => {
    const db = createTestDb();
    try {
      const [pair] = seedTwoProjects(db);
      const opts = { mode: 'hybrid', limit: 10, currentProject: 'probe--alpha' };
      const boosted = searchObservations(db, pair.nonce, opts);
      const unboosted = searchObservations(db, pair.nonce, { ...opts, mode: 'no_project' });
      expect(boosted).toHaveLength(2);
      // Both rows survive, and the current-project one is pulled ahead.
      expect(boosted[0].id).toBe(pair.preferredId);
      const byId = (rows) => new Map(rows.map((r) => [r.id, r.score]));
      const b = byId(boosted);
      const u = byId(unboosted);
      // Relative tolerance, not a digit count: both chains carry the wall-clock
      // decay term and the two searches run a few ms apart, so the quotient
      // lands ~5e-10 off an exact 2.0. The failure this guards against is the
      // pre-fix value of 1.0 — a 100% error, nowhere near this band.
      const rel = (x, target) => Math.abs(x - target) / target;
      expect(rel(b.get(pair.preferredId) / u.get(pair.preferredId), 2.0)).toBeLessThan(1e-6);
      expect(rel(b.get(pair.otherId) / u.get(pair.otherId), 1.0)).toBeLessThan(1e-6);
    } finally {
      db.close();
    }
  });
});
