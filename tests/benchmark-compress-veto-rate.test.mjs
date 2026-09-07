// Guards for benchmark/compress-veto-rate.mjs — the ruler that answers whether D#10's
// `should_compress` veto actually fires, as opposed to merely existing.
//
// Why the ruler needed guarding at all: executeSmartCompressCluster returns
// `{ compressed: false }` for a REFUSAL and for a model error, a bad key, a timeout, or
// unparseable JSON alike. An instrument that read `compressed` would score a dead API key
// as a PERFECT veto — a flattering number from a blind ruler, which is the failure mode
// CLAUDE.md's doctrine rule 9 names. The three-way classification is the whole design, and
// these cases keep it.
//
// Everything here is network-free: the ruler's `main()` is guarded behind an argv check so
// importing it fires no model calls, and every case below drives the pure halves.
import { describe, it, expect } from 'vitest';
import {
  RELATED,
  UNRELATED,
  classify,
  clusterCohesion,
  runArm,
  runSelfChecks,
} from '../benchmark/compress-veto-rate.mjs';

describe('compress-veto-rate ruler (D#10)', () => {
  it('never counts a failed call as a veto', () => {
    // The one that matters. Each of these is a way the model call can come back empty,
    // and every one of them must be `error` — countable, and excluded from the rate.
    for (const bad of [null, undefined, 'not json', 42, false]) {
      expect(classify(bad), `classify(${JSON.stringify(bad)})`).toBe('error');
    }
  });

  it('mirrors the shipped fail-closed semantics', () => {
    // hook-optimize's check is `!parsed || !parsed.should_compress`, so an omitted verdict
    // refuses. If the ruler and the shipped path disagreed here, the measured rate would
    // describe a policy nobody ships.
    expect(classify({ title: 't' })).toBe('refuse');
    expect(classify({ should_compress: false, title: 't' })).toBe('refuse');
    expect(classify({ should_compress: true, title: 't' })).toBe('compress');
  });

  it('reports no rate at all when every call errored, rather than 100%', async () => {
    const arm = await runArm(UNRELATED, async () => 'error');
    expect(arm.refuseRate).toBeNull();
    expect(arm.error).toBe(UNRELATED.length);
    expect(arm.refuse).toBe(0);
  });

  it('distinguishes the two extremes', async () => {
    const allRefuse = await runArm(UNRELATED, async () => 'refuse');
    const allCompress = await runArm(UNRELATED, async () => 'compress');
    expect(allRefuse.refuseRate).toBe(1);
    expect(allCompress.refuseRate).toBe(0);
  });

  it('excludes errors from the denominator instead of counting them either way', async () => {
    // Four clusters: two refuse, one compress, one error. The rate is over DECIDED
    // clusters (2/3), not over all four — an error must not drag it up or down.
    const verdicts = ['refuse', 'refuse', 'compress', 'error'];
    let i = 0;
    const arm = await runArm(UNRELATED.slice(0, 4), async () => verdicts[i++]);
    expect(arm.refuseRate).toBeCloseTo(2 / 3, 10);
    expect(arm.error).toBe(1);
  });

  it('keeps the fixture arms separable, which is the population premise', () => {
    // A "unrelated" arm that quietly shared vocabulary would make a low veto rate say
    // nothing about the model. Asserted, not assumed.
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const rel = mean(RELATED.map(clusterCohesion));
    const unrel = mean(UNRELATED.map(clusterCohesion));
    expect(rel).toBeGreaterThan(unrel * 2);
    for (const c of UNRELATED) expect(clusterCohesion(c)).toBeLessThan(0.03);
  });

  it('runs its own self-checks green on this tree', async () => {
    const { failed } = await runSelfChecks();
    expect(failed.map((f) => f.name)).toEqual([]);
  });
});
