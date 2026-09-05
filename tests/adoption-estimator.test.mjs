import { describe, it, expect } from 'vitest';
import { localLinearRdd, clusterBootstrap, mde } from '../benchmark/adoption-estimator.mjs';

describe('adoption-estimator', () => {
  it('localLinearRdd recovers a known jump above a linear gradient', () => {
    // y = 0.001*x on both sides, +0.2 jump for shown (x>=50)
    const pts = [];
    for (let x = 40; x < 50; x++) pts.push({ x, y: 0.001 * x, shown: false });
    for (let x = 50; x < 60; x++) pts.push({ x, y: 0.001 * x + 0.2, shown: true });
    const { jump } = localLinearRdd(pts, 50);
    expect(jump).toBeCloseTo(0.2, 2);
  });

  it('clusterBootstrap CI includes 0 for a null effect, excludes it for a strong one', () => {
    const nullRows = Array.from({ length: 40 }, (_, i) => ({
      sessionId: `s${i % 8}`,
      value: i % 2 ? 0.05 : -0.05,
    }));
    const nullCi = clusterBootstrap(nullRows, { seedTerms: 'null' }).ci95;
    expect(nullCi[0]).toBeLessThanOrEqual(0);
    expect(nullCi[1]).toBeGreaterThanOrEqual(0);
    const posRows = Array.from({ length: 40 }, (_, i) => ({ sessionId: `s${i % 8}`, value: 0.3 }));
    const posCi = clusterBootstrap(posRows, { seedTerms: 'pos' }).ci95;
    expect(posCi[0]).toBeGreaterThan(0);
  });

  it('mde shrinks with n', () => {
    expect(mde(400, 0.2, {})).toBeLessThan(mde(25, 0.2, {}));
  });

  it('mde default case matches the pinned z-table exactly', () => {
    const expected = ((1.9599639845 + 0.8416212336) * 0.2) / Math.sqrt(100);
    expect(mde(100, 0.2, {})).toBeCloseTo(expected, 10);
  });

  it('mde throws on an unsupported power quantile instead of silently reusing a nearby z', () => {
    expect(() => mde(100, 0.2, { power: 0.83 })).toThrow(/unsupported normal quantile/);
  });

  it('localLinearRdd falls back to a plain mean-difference when a side has < 2 distinct x', () => {
    // treated: single observation (distinct(treated) === 1 < 2) -> triggers the top-level fallback guard.
    // control: 10 points with real variance and a non-zero slope (y = 0.01*(x-10)) -> a perfect
    // line, so it is NOT degenerate and its true OLS intercept-at-cutoff differs from its plain mean.
    // This makes the fixture discriminating: the fallback branch and the OLS branch produce
    // DIFFERENT numbers, so the test can tell them apart (a fixture where both branches agree
    // would pass even if the top-level guard were deleted).
    const cutoff = 10;
    const pts = [{ x: 12, y: 0.5, shown: true }];
    for (let x = 10; x < 20; x++) pts.push({ x, y: 0.01 * (x - 10), shown: false });
    const { jump, nTreated, nControl } = localLinearRdd(pts, cutoff);
    // fallback (correct): meanY(treated)=0.5 - meanY(control)=0.045 = 0.455.
    // If the guard were broken and OLS ran instead, olsLine(control).a (the fitted value at the
    // cutoff, x-cutoff=0) would be 0.01*10 - 0.1 = 0, giving 0.5 - 0 = 0.5 -- a DIFFERENT number.
    expect(jump).toBeCloseTo(0.455, 10);
    expect(nTreated).toBe(1);
    expect(nControl).toBe(10);
  });
});
