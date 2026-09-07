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
  AMBIGUOUS,
  RELATED,
  UNRELATED,
  classify,
  clusterCohesion,
  rotateCluster,
  runArm,
  runArmRepeated,
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

// ─── The ambiguous arm (D#13) ────────────────────────────────────────────────
//
// The two original arms answer an EASY question: their clusters are separated by design
// (cohesion 0.1124 vs 0.0051), so "veto 100% / false-refusal 0%" says the veto handles the
// CLEAR case. It says nothing about a cluster that is partly one story — which is the
// population the 14-day fallback actually produces on a busy repo.
//
// An ambiguous cluster has NO ground truth, so it cannot produce a rate, and this arm
// deliberately does not report one. What it CAN report is whether the veto is decisive or a
// coin flip: the same corpus compressing differently on two consecutive nights is a worse
// property than either verdict.
describe('compress-veto-rate ambiguous arm (D#13)', () => {
  const constantJudge = (v) => async () => v;
  // The arm hands the judge a rotated COPY of each cluster, so identity comparison does not
  // work. Membership does, and it is the property rotation preserves.
  const titlesOf = (c) =>
    c
      .map((o) => o.title)
      .sort()
      .join('|');
  const isCluster = (c, i) => titlesOf(c) === titlesOf(AMBIGUOUS[i]);

  it('reports per-cluster verdicts and no rate, because there is no ground truth', async () => {
    const arm = await runArmRepeated(AMBIGUOUS, constantJudge('refuse'), 3);
    // The absence is the design. A `refuseRate` here would invite exactly the reading
    // D#13 says the arm cannot support.
    expect(arm).not.toHaveProperty('refuseRate');
    expect(arm.clusters).toHaveLength(AMBIGUOUS.length);
    for (const c of arm.clusters) expect(c.verdicts).toEqual(['refuse', 'refuse', 'refuse']);
  });

  it('asks each cluster reps times, not once', async () => {
    let calls = 0;
    await runArmRepeated(
      AMBIGUOUS,
      async () => {
        calls++;
        return 'compress';
      },
      4,
    );
    expect(calls).toBe(AMBIGUOUS.length * 4);
  });

  it('separates a decisive cluster from a coin-flip one', async () => {
    // Cluster 0 flips 2:1, every other cluster is unanimous. Stability is the MODAL
    // fraction, so the flipping cluster must read 2/3 and the rest 1.
    //
    // Identified by MEMBERSHIP, not by array identity: the arm hands the judge a ROTATED
    // COPY (see runArmRepeated), so `cluster === AMBIGUOUS[0]` is false by design.
    const seq = ['refuse', 'compress', 'refuse'];
    let i = 0;
    const arm = await runArmRepeated(
      AMBIGUOUS,
      async (cluster) => (isCluster(cluster, 0) ? seq[i++] : 'compress'),
      3,
    );
    expect(arm.clusters[0].stability).toBeCloseTo(2 / 3, 10);
    expect(arm.clusters[0].unanimous).toBe(false);
    expect(arm.clusters[0].modal).toBe('refuse');
    for (const c of arm.clusters.slice(1)) {
      expect(c.stability).toBe(1);
      expect(c.unanimous).toBe(true);
    }
    expect(arm.flipped).toBe(1);
    expect(arm.unanimousDecided).toBe(AMBIGUOUS.length - 1);
  });

  it('keeps errors out of the stability denominator', async () => {
    // refuse/refuse/error is a cluster that decided twice and agreed twice — stable, on a
    // denominator of 2. Counting the error either way would make a dead key read as
    // instability (or as agreement), the same three-way hazard the rate arm is built around.
    const seq = ['refuse', 'refuse', 'error'];
    let i = 0;
    const arm = await runArmRepeated(AMBIGUOUS.slice(0, 1), async () => seq[i++], 3);
    expect(arm.clusters[0].decided).toBe(2);
    expect(arm.clusters[0].error).toBe(1);
    expect(arm.clusters[0].stability).toBe(1);
    expect(arm.error).toBe(1);
  });

  it('reports no stability at all for a cluster that never decided', async () => {
    // All-error must not read as "perfectly stable". Same failure mode as an all-error
    // rate reading 100%.
    const arm = await runArmRepeated(AMBIGUOUS.slice(0, 1), constantJudge('error'), 3);
    expect(arm.clusters[0].stability).toBeNull();
    expect(arm.clusters[0].unanimous).toBe(false);
    expect(arm.meanStability).toBeNull();
  });

  it('excludes undecided clusters from meanStability rather than scoring them zero', async () => {
    // Two clusters: one unanimous, one all-error. The mean is 1 over the single cluster
    // that produced a verdict — not 0.5.
    const arm = await runArmRepeated(
      AMBIGUOUS.slice(0, 2),
      async (cluster) => (isCluster(cluster, 0) ? 'refuse' : 'error'),
      3,
    );
    expect(arm.meanStability).toBe(1);
  });

  it('varies member ORDER across reps, because temperature is pinned to 0', async () => {
    // The reason the arm exists in this shape. Repeating an identical prompt at
    // DEFAULT_LLM_TEMPERATURE = 0 measures almost nothing, so each rep rotates the cluster.
    // Order is a variation PRODUCTION exhibits: the pools order by created_at_epoch DESC
    // with no tiebreaker (D#9), so which member sorts first is arbitrary on same-era rows.
    const seen = [];
    const arm = await runArmRepeated(
      AMBIGUOUS.slice(0, 1),
      async (cluster) => {
        seen.push(cluster.map((o) => o.title).join(' > '));
        return 'refuse';
      },
      3,
    );
    expect(new Set(seen).size).toBe(3);
    expect(arm.minDistinctOrders).toBe(3);
    expect(arm.permuted).toBe(true);
    // Membership is preserved — a rotation, not a resample.
    for (const order of seen) {
      expect(order.split(' > ').sort()).toEqual(AMBIGUOUS[0].map((o) => o.title).sort());
    }
  });

  it('can be put into the degenerate mode, which is how the premise check can fail', async () => {
    // If the permutation were ever a no-op the stability numbers would be tautological.
    // `permute: false` is that state, and it reports itself rather than looking identical.
    const arm = await runArmRepeated(AMBIGUOUS, constantJudge('refuse'), 3, { permute: false });
    expect(arm.minDistinctOrders).toBe(1);
    expect(arm.permuted).toBe(false);
  });

  it('rotates without mutating the caller’s cluster', () => {
    const before = AMBIGUOUS[0].map((o) => o.title);
    const rot = rotateCluster(AMBIGUOUS[0], 1);
    expect(rot[0]).toBe(AMBIGUOUS[0][1]);
    expect(rot[rot.length - 1]).toBe(AMBIGUOUS[0][0]);
    expect(AMBIGUOUS[0].map((o) => o.title)).toEqual(before);
    // A full turn is the identity.
    expect(rotateCluster(AMBIGUOUS[0], AMBIGUOUS[0].length).map((o) => o.title)).toEqual(before);
  });

  it('sits between the other two arms in lexical cohesion, which is its premise', () => {
    // The fixture claims to be "partly one story". If it were as disjoint as UNRELATED the
    // arm would just be a second copy of the easy question; if it were as cohesive as
    // RELATED it would be a second copy of the other easy question.
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const rel = mean(RELATED.map(clusterCohesion));
    const amb = mean(AMBIGUOUS.map(clusterCohesion));
    const unrel = mean(UNRELATED.map(clusterCohesion));
    expect(amb).toBeGreaterThan(unrel);
    expect(amb).toBeLessThan(rel);
  });

  it('carries the same three clusters-of-three shape as the other arms', () => {
    expect(AMBIGUOUS).toHaveLength(6);
    for (const c of AMBIGUOUS) {
      expect(c).toHaveLength(3);
      for (const o of c) {
        expect(typeof o.title).toBe('string');
        expect(typeof o.narrative).toBe('string');
        expect(o.title.length).toBeGreaterThan(0);
      }
    }
  });
});
