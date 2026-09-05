// Unit tests for the experiment analysis core (experiment/lib/stats.mjs).
// This is the scientific heart of the value A/B: paired control-vs-treatment
// deltas, deterministic bootstrap CIs, and the falsifiable decision rule from
// the audit's provingExperiment. Pure functions — no I/O, no claude spawn.

import { describe, test, expect } from 'vitest';
import { pairedSummary, bootstrapCI, decideOutcome } from '../experiment/lib/stats.mjs';

describe('pairedSummary', () => {
  test('computes per-task treatment-minus-control deltas, averaged over trials', () => {
    const runs = [
      { taskId: 'A', arm: 'control', trial: 1, recurred: true, tokens: 1000, toolCalls: 10 },
      { taskId: 'A', arm: 'control', trial: 2, recurred: true, tokens: 1100, toolCalls: 12 },
      { taskId: 'A', arm: 'treatment', trial: 1, recurred: false, tokens: 1200, toolCalls: 8 },
      { taskId: 'A', arm: 'treatment', trial: 2, recurred: false, tokens: 1300, toolCalls: 8 },
    ];
    const s = pairedSummary(runs);
    expect(s.perTask).toHaveLength(1);
    const a = s.perTask[0];
    expect(a.taskId).toBe('A');
    expect(a.control.recurredRate).toBe(1.0);
    expect(a.treatment.recurredRate).toBe(0.0);
    expect(a.recurrenceDelta).toBe(-1.0);
    expect(a.tokenDelta).toBe(200); // 1250 - 1050
    expect(a.toolCallDelta).toBe(-3); // 8 - 11
  });

  test('captures the shuffled negative-control arm when present', () => {
    const runs = [
      { taskId: 'A', arm: 'control', trial: 1, recurred: true, tokens: 1000, toolCalls: 10 },
      { taskId: 'A', arm: 'treatment', trial: 1, recurred: false, tokens: 1100, toolCalls: 9 },
      { taskId: 'A', arm: 'shuffled', trial: 1, recurred: false, tokens: 1150, toolCalls: 9 },
    ];
    const s = pairedSummary(runs);
    expect(s.perTask[0].shuffled.recurredRate).toBe(0.0);
    expect(s.perTask[0].shuffledRecurrenceDelta).toBe(-1.0); // shuffled - control
  });

  test('drops a task that lacks a control or treatment arm (incomplete pair)', () => {
    const runs = [{ taskId: 'A', arm: 'treatment', trial: 1, recurred: false, tokens: 1, toolCalls: 1 }];
    const s = pairedSummary(runs);
    expect(s.perTask).toHaveLength(0);
    expect(s.dropped).toContain('A');
  });
});

describe('bootstrapCI', () => {
  test('is deterministic for a fixed seed and brackets the sample mean', () => {
    const values = [-1, -1, -1, 0, -1, -1];
    const ci = bootstrapCI(values, { seed: 42, iterations: 2000, alpha: 0.05 });
    expect(ci.mean).toBeCloseTo(-5 / 6, 6);
    expect(ci.lo).toBeLessThanOrEqual(ci.mean);
    expect(ci.hi).toBeGreaterThanOrEqual(ci.mean);
    const again = bootstrapCI(values, { seed: 42, iterations: 2000, alpha: 0.05 });
    expect(again).toEqual(ci);
  });

  test('empty input yields a null-ish CI rather than throwing', () => {
    const ci = bootstrapCI([], { seed: 1 });
    expect(ci.mean).toBeNull();
    expect(ci.lo).toBeNull();
    expect(ci.hi).toBeNull();
  });
});

describe('decideOutcome', () => {
  const shuffledNull = { recurrenceDeltaCI: { mean: -0.05, lo: -0.2, hi: 0.1 } };

  test('significant recurrence reduction at non-positive token cost → improves-outcomes', () => {
    const v = decideOutcome({
      recurrenceDeltaCI: { mean: -0.6, lo: -0.9, hi: -0.2 },
      tokenDeltaCI: { mean: -50, lo: -200, hi: -10 },
      shuffled: shuffledNull,
    });
    expect(v.verdict).toBe('improves-outcomes');
    expect(v.claimAllowed).toBe(true);
  });

  test('recurrence CI crosses zero → unproven (retrieval-only honest state)', () => {
    const v = decideOutcome({
      recurrenceDeltaCI: { mean: -0.1, lo: -0.4, hi: 0.2 },
      tokenDeltaCI: { mean: 100, lo: -50, hi: 250 },
      shuffled: shuffledNull,
    });
    expect(v.verdict).toBe('unproven');
    expect(v.claimAllowed).toBe(false);
  });

  test('recurrence reduced but tokens significantly higher → mixed', () => {
    const v = decideOutcome({
      recurrenceDeltaCI: { mean: -0.5, lo: -0.8, hi: -0.2 },
      tokenDeltaCI: { mean: 500, lo: 200, hi: 800 },
      shuffled: shuffledNull,
    });
    expect(v.verdict).toBe('mixed');
    expect(v.claimAllowed).toBe(false);
  });

  test('shuffled arm matches treatment effect → confounded, claim disallowed', () => {
    const v = decideOutcome({
      recurrenceDeltaCI: { mean: -0.5, lo: -0.8, hi: -0.2 },
      tokenDeltaCI: { mean: -10, lo: -100, hi: -1 },
      shuffled: { recurrenceDeltaCI: { mean: -0.45, lo: -0.75, hi: -0.15 } },
    });
    expect(v.confounded).toBe(true);
    expect(v.claimAllowed).toBe(false);
  });
});
