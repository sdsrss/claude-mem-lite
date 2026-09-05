// Tests for benchmark/denoise-ab.mjs — the denoising A/B tradeoff harness.
// Motivation: denoising levers shift PRECISION (hard-negative suite) and RECALL
// (vocab-mismatch paraphrase suite) in OPPOSITE directions. Evaluating one suite
// alone (as the standing tests did) hides the other side of the tradeoff — that
// is how an OR-BM25 floor "improved precision" while cratering paraphrase recall
// got shipped-then-reverted. This harness runs BOTH suites and reports the
// precision↔recall tradeoff in one snapshot, A/B-comparable across a change.
import { describe, it, expect } from 'vitest';
import { summarizeTradeoff, runSnapshot, SUITES } from '../benchmark/denoise-ab.mjs';
import { createTestDb } from './test-helpers.mjs';
import { seedDatabase, seedVectors } from '../benchmark/benchmark.mjs';
import { readFileSync } from 'fs';

describe('summarizeTradeoff (pure verdict logic)', () => {
  const before = {
    precision_hard_negatives: { recall_at_10: 0.9, precision_at_10: 0.86, ndcg_at_10: 0.97, mrr_at_10: 0.96 },
    vocab_mismatch_paraphrase: { recall_at_10: 0.33, precision_at_10: 0.2, ndcg_at_10: 0.3, mrr_at_10: 0.4 },
  };

  it('flags the OR-floor failure mode: recall regression with no compensating gain → REJECT', () => {
    // Treatment leaves the precision suite untouched but craters paraphrase recall
    // (exactly the reverted Item-2 OR-floor behaviour).
    const after = {
      precision_hard_negatives: {
        recall_at_10: 0.9,
        precision_at_10: 0.86,
        ndcg_at_10: 0.97,
        mrr_at_10: 0.96,
      },
      vocab_mismatch_paraphrase: {
        recall_at_10: 0.05,
        precision_at_10: 0.2,
        ndcg_at_10: 0.1,
        mrr_at_10: 0.15,
      },
    };
    const r = summarizeTradeoff(before, after);
    expect(r.regressions.length).toBeGreaterThan(0);
    expect(r.gains.length).toBe(0);
    expect(r.verdict).toMatch(/REJECT/);
    expect(r.verdict).toMatch(/vocab_mismatch_paraphrase\.recall_at_10/);
  });

  it('labels a precision gain with no regression as NET-POSITIVE', () => {
    const after = {
      precision_hard_negatives: {
        recall_at_10: 0.9,
        precision_at_10: 0.92,
        ndcg_at_10: 0.98,
        mrr_at_10: 0.96,
      },
      vocab_mismatch_paraphrase: {
        recall_at_10: 0.33,
        precision_at_10: 0.2,
        ndcg_at_10: 0.3,
        mrr_at_10: 0.4,
      },
    };
    const r = summarizeTradeoff(before, after);
    expect(r.gains.length).toBeGreaterThan(0);
    expect(r.regressions.length).toBe(0);
    expect(r.verdict).toMatch(/NET-POSITIVE/);
  });

  it('labels a precision-up / recall-down change as a TRADEOFF (judge worth)', () => {
    const after = {
      precision_hard_negatives: {
        recall_at_10: 0.9,
        precision_at_10: 0.92,
        ndcg_at_10: 0.98,
        mrr_at_10: 0.96,
      },
      vocab_mismatch_paraphrase: {
        recall_at_10: 0.2,
        precision_at_10: 0.2,
        ndcg_at_10: 0.22,
        mrr_at_10: 0.3,
      },
    };
    const r = summarizeTradeoff(before, after);
    expect(r.gains.length).toBeGreaterThan(0);
    expect(r.regressions.length).toBeGreaterThan(0);
    expect(r.verdict).toMatch(/TRADEOFF/);
  });

  it('labels sub-threshold noise as NEUTRAL', () => {
    const after = {
      precision_hard_negatives: {
        recall_at_10: 0.905,
        precision_at_10: 0.859,
        ndcg_at_10: 0.97,
        mrr_at_10: 0.96,
      },
      vocab_mismatch_paraphrase: {
        recall_at_10: 0.335,
        precision_at_10: 0.2,
        ndcg_at_10: 0.3,
        mrr_at_10: 0.4,
      },
    };
    const r = summarizeTradeoff(before, after, { threshold: 0.02 });
    expect(r.regressions.length).toBe(0);
    expect(r.gains.length).toBe(0);
    expect(r.verdict).toMatch(/NEUTRAL/);
  });

  // P0-c: statistical-resolution disclosure. A mean-of-per-query-scores metric can
  // only resolve moves ≥ 1/n (one query flipping). When the verdict threshold sits
  // BELOW that (vocab suite n=12 → 1/12=0.083 ≫ 0.02), a "NEUTRAL — all |Δ|<0.02"
  // is misleading: the harness cannot resolve a sub-0.083 move at all, so NEUTRAL is
  // "under-resolved", not "safe" — exactly the "A/B NEUTRAL ≠ safe" trap.
  it('discloses single-query resolution (1/n) per suite when snapshots carry n', () => {
    const withN = {
      precision_hard_negatives: { ...before.precision_hard_negatives, n: 30 },
      vocab_mismatch_paraphrase: { ...before.vocab_mismatch_paraphrase, n: 12 },
    };
    const r = summarizeTradeoff(withN, withN, { threshold: 0.02 });
    const vocab = r.suites.find((s) => s.name === 'vocab_mismatch_paraphrase');
    const prec = r.suites.find((s) => s.name === 'precision_hard_negatives');
    expect(vocab.resolution).toBeCloseTo(1 / 12, 4);
    expect(prec.resolution).toBeCloseTo(1 / 30, 4);
  });

  it('flags suites whose single-query resolution exceeds the threshold as under-resolved', () => {
    const withN = {
      precision_hard_negatives: { ...before.precision_hard_negatives, n: 30 }, // 1/30=0.033 > 0.02 → also under-resolved
      vocab_mismatch_paraphrase: { ...before.vocab_mismatch_paraphrase, n: 12 }, // 1/12=0.083 > 0.02
    };
    const r = summarizeTradeoff(withN, withN, { threshold: 0.02 });
    expect(r.underResolved).toContain('vocab_mismatch_paraphrase');
    expect(r.underResolved).toContain('precision_hard_negatives');
    expect(r.verdict).toMatch(/under-resolved|resolution/i);
  });

  it('omits resolution fields gracefully when snapshots lack n (back-compat)', () => {
    const r = summarizeTradeoff(before, before, { threshold: 0.02 });
    expect(r.underResolved).toEqual([]);
    expect(r.suites[0].resolution).toBeNull();
  });
});

describe('runSnapshot (integration over both suites)', () => {
  it('produces precision + recall metrics for both the precision and paraphrase suites', () => {
    const db = createTestDb();
    const corpus = JSON.parse(
      readFileSync(new URL('../benchmark/fixtures/seed-data.json', import.meta.url), 'utf8'),
    );
    seedDatabase(db, corpus);
    seedVectors(db);

    const snap = runSnapshot(db);
    // Both suites present, each with the four ranking metrics as finite numbers.
    for (const s of SUITES) {
      expect(snap[s.name]).toBeDefined();
      for (const m of ['recall_at_10', 'precision_at_10', 'ndcg_at_10', 'mrr_at_10']) {
        expect(Number.isFinite(snap[s.name][m]), `${s.name}.${m}`).toBe(true);
      }
    }
    // The paraphrase suite is the recall-stressed one; precision suite scores high.
    expect(snap.precision_hard_negatives.precision_at_10).toBeGreaterThan(0.5);
    // Each suite records its query count so summarizeTradeoff can disclose the
    // single-query resolution (1/n) of the mean-of-per-query metrics.
    for (const s of SUITES) {
      expect(Number.isInteger(snap[s.name].n), `${s.name}.n`).toBe(true);
      expect(snap[s.name].n).toBeGreaterThan(0);
    }
    db.close();
  });
});

// ─── G5 (roadmap 2026-07-18): CJK suite + cross-source/deferred probes ────────
// The three faces the ASCII-only suites were structurally blind to (07-17 audit).
// Each probe module takes an injectable fn so teeth-tests can replay the
// historical regression and prove the probe judges it non-NEUTRAL.

import { composeVerdict, seedAllFixtures } from '../benchmark/denoise-ab.mjs';
import { runCrossSourceProbes } from '../benchmark/cross-source-probes.mjs';
import { runDeferredProbes, DEFERRED_FIXTURES } from '../benchmark/deferred-probes.mjs';
import { searchProductionHybrid } from '../benchmark/benchmark.mjs';

describe('cjk_mixed suite (G5 ①)', () => {
  it('SUITES includes the cjk_mixed suite', () => {
    expect(SUITES.map((s) => s.name)).toContain('cjk_mixed');
  });

  it('runSnapshot over seedAllFixtures scores the CJK suite with real recall', () => {
    const db = createTestDb();
    seedAllFixtures(db);
    const snap = runSnapshot(db);
    expect(snap.cjk_mixed).toBeDefined();
    expect(snap.cjk_mixed.n).toBeGreaterThanOrEqual(10);
    // Floor locks the face open: a tokenizer/synonym change that zeroes CJK
    // drops this toward 0 and fails loudly (exact ranking moves are the A/B's job).
    expect(snap.cjk_mixed.recall_at_10).toBeGreaterThanOrEqual(0.5);
    db.close();
  });

  it('archaeology: no-space CJK+Latin query keeps the latin token (redis case)', () => {
    // v3.40 regression class: "redis缓存问题" dropped the "redis" token → the
    // redis doc became unreachable. Locked here as a named replay.
    const db = createTestDb();
    seedAllFixtures(db);
    const ids = searchProductionHybrid(db, 'redis缓存问题', { limit: 10 }).map((r) => r.id);
    expect(ids).toContain(90201);
    db.close();
  });
});

describe('cross-source direction probes (G5 ②)', () => {
  it('all probes pass on the current normalizeCrossSourceScores', () => {
    const results = runCrossSourceProbes();
    expect(results.length).toBeGreaterThanOrEqual(10);
    const failures = results.filter((p) => !p.pass);
    expect(failures.map((p) => p.name)).toEqual([]);
  });

  it('archaeology MED-5→bands: constant −0.5 lone clamp (v3.48) fails the band probes', () => {
    // Replay the v3.48 behavior: every lone hit → constant −0.5, magnitude-blind.
    const constantClamp = (results, sourceKey) => {
      for (const src of ['obs', 'session', 'prompt', 'event']) {
        const srcResults = results.filter((r) => r[sourceKey] === src && r.score);
        if (srcResults.length === 1) {
          srcResults[0].score = -0.5;
          continue;
        }
        const maxAbs = Math.max(0, ...srcResults.map((r) => Math.abs(r.score)));
        if (maxAbs > 0) for (const r of srcResults) r.score = r.score / maxAbs;
      }
    };
    const failures = runCrossSourceProbes({ normalize: constantClamp }).filter((p) => !p.pass);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.map((p) => p.name)).toContain('lone-strongest-ranks-first');
  });

  it('archaeology pre-MED-5: lone hit pinned to −1 fails the grazing probe', () => {
    const pinToMinus1 = (results, sourceKey) => {
      for (const src of ['obs', 'session', 'prompt', 'event']) {
        const srcResults = results.filter((r) => r[sourceKey] === src && r.score);
        const maxAbs = Math.max(0, ...srcResults.map((r) => Math.abs(r.score)));
        if (maxAbs > 0) for (const r of srcResults) r.score = r.score / maxAbs;
      }
    };
    const failures = runCrossSourceProbes({ normalize: pinToMinus1 }).filter((p) => !p.pass);
    expect(failures.map((p) => p.name)).toContain('lone-grazing-sinks');
  });
});

describe('deferred reachability probes (G5 ③)', () => {
  it('positives reach the planted item and negatives stay silent', () => {
    const db = createTestDb();
    const results = runDeferredProbes(db);
    expect(results.length).toBeGreaterThanOrEqual(10);
    expect(results.filter((p) => !p.pass).map((p) => `${p.kind}:${p.query}`)).toEqual([]);
    db.close();
  });

  it('teeth: a search that returns nothing fails every positive probe', () => {
    const db = createTestDb();
    const results = runDeferredProbes(db, { searchFn: () => [] });
    const positives = results.filter((p) => p.kind === 'positive');
    expect(positives.length).toBe(DEFERRED_FIXTURES.positives.length);
    expect(positives.every((p) => !p.pass)).toBe(true);
    db.close();
  });
});

describe('composeVerdict (probe → verdict folding)', () => {
  it('passes the base verdict through when no probe failed', () => {
    expect(composeVerdict('NEUTRAL — all |Δ| < 0.02', [])).toBe('NEUTRAL — all |Δ| < 0.02');
  });

  it('a probe failure makes the verdict non-NEUTRAL even at zero metric delta', () => {
    const v = composeVerdict('NEUTRAL — all |Δ| < 0.02', [
      'multiscript:cjk',
      'cross-source:lone-grazing-sinks',
    ]);
    expect(v).toMatch(/^PROBE-FAIL/);
    expect(v).toContain('lone-grazing-sinks');
    expect(v).toContain('NEUTRAL');
  });
});
