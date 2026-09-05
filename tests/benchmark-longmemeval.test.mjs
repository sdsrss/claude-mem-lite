// Tests for the LongMemEval benchmark adapter (benchmark/longmemeval.mjs).
//
// These prove three things that make our number comparable to MemPalace's
// published LongMemEval R@5:
//   1. recall_any@k is computed as "is ANY gold session in top-k" (their headline
//      metric), NOT the fractional hits/relevant of computeRecallAtK.
//   2. The corpus is built user-turns-only by default — exactly MemPalace's raw
//      baseline rule (longmemeval_bench.py:188). The assistant content is excluded,
//      so a fact that lives only in an assistant turn is NOT in the haystack.
//   3. The adapter drives the REAL production hybrid path (FTS + TF-IDF + RRF) and
//      retrieves a lexically-obvious gold session.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  buildCorpus,
  parseLmeDate,
  recallAnyAtK,
  recallFractionalAtK,
  evalEntry,
  runLongMemEval,
} from '../benchmark/longmemeval.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE = JSON.parse(
  readFileSync(join(__dirname, '../benchmark/fixtures/longmemeval-sample.json'), 'utf8'),
);
const byId = (id) => SAMPLE.find((e) => e.question_id === id);

describe('recallAnyAtK', () => {
  it('is binary: 1 when any gold is in top-k, else 0', () => {
    expect(recallAnyAtK(['a', 'b', 'c'], ['b'], 5)).toBe(1);
    expect(recallAnyAtK(['a', 'b', 'c'], ['z'], 5)).toBe(0);
  });
  it('respects the k cutoff', () => {
    // gold 'c' sits at rank 3 — inside @5, outside @2.
    expect(recallAnyAtK(['a', 'b', 'c'], ['c'], 5)).toBe(1);
    expect(recallAnyAtK(['a', 'b', 'c'], ['c'], 2)).toBe(0);
  });
  it('is 0 for an empty gold set (no credit possible)', () => {
    expect(recallAnyAtK(['a', 'b'], [], 5)).toBe(0);
  });
});

describe('recallFractionalAtK', () => {
  it('equals any-hit when |gold| === 1', () => {
    expect(recallFractionalAtK(['a', 'b', 'c'], ['b'], 5)).toBe(1);
    expect(recallFractionalAtK(['a', 'b', 'c'], ['z'], 5)).toBe(0);
  });
  it('is the fraction of distinct gold sessions in top-k when |gold| > 1', () => {
    expect(recallFractionalAtK(['a', 'b', 'c'], ['a', 'b', 'z'], 5)).toBeCloseTo(2 / 3);
    expect(recallFractionalAtK(['a', 'b', 'c'], ['a', 'b', 'c'], 5)).toBe(1);
    expect(recallFractionalAtK(['a', 'b', 'c'], ['x', 'y'], 5)).toBe(0);
  });
  it('respects the k cutoff', () => {
    // gold 'c' at rank 3 is inside @5, outside @2; gold 'a' is at rank 1.
    expect(recallFractionalAtK(['a', 'b', 'c'], ['a', 'c'], 2)).toBe(1 / 2);
    expect(recallFractionalAtK(['a', 'b', 'c'], ['a', 'c'], 5)).toBe(1);
  });
  it('never exceeds 1 when a gold id is retrieved more than once', () => {
    expect(recallFractionalAtK(['a', 'a', 'b'], ['a', 'b'], 3)).toBe(1);
  });
  it('is 0 for an empty gold set', () => {
    expect(recallFractionalAtK(['a', 'b'], [], 5)).toBe(0);
  });
});

describe('buildCorpus — user-turns-only rule (MemPalace raw baseline)', () => {
  const entry = byId('q-assistant-codename');

  it('default (user mode) EXCLUDES assistant content from the haystack', () => {
    const { data, idToSession, goldIds } = buildCorpus(entry);
    expect(goldIds).toEqual(['s-cache']);
    // one observation per haystack session, integer ids mapped back to session ids
    expect(data.observations).toHaveLength(3);
    expect(idToSession.get(1)).toBe('s-cache');
    const goldDoc = data.observations.find((o) => idToSession.get(o.id) === 's-cache');
    // "Hermes" lives ONLY in the assistant turn → must not be indexed in user mode
    expect(goldDoc.narrative).not.toMatch(/Hermes/i);
    expect(goldDoc.narrative).toMatch(/help me think through/i);
  });

  it('all mode INCLUDES assistant content (the rule is load-bearing)', () => {
    const { data, idToSession } = buildCorpus(entry, { turns: 'all' });
    const goldDoc = data.observations.find((o) => idToSession.get(o.id) === 's-cache');
    expect(goldDoc.narrative).toMatch(/Hermes/i);
  });
});

describe('evalEntry — real production hybrid retrieval', () => {
  it('retrieves a lexically-obvious gold session at the top (recall_any@1 = 1)', () => {
    const r = evalEntry(byId('q-lexical-db'), { turns: 'user', ks: [1, 5, 10] });
    expect(r.question_id).toBe('q-lexical-db');
    expect(r.ks['1']).toBe(1);
    expect(r.ks['5']).toBe(1);
    expect(r.gold).toEqual(['s-analytics']);
    expect(r.retrieved).toContain('s-analytics');
  });

  it('does not credit an assistant-only fact under the user-turns-only rule', () => {
    // The codename "Hermes" / "caching layer codename" is only in the assistant turn,
    // so user-mode retrieval cannot surface it — this is the honest raw-baseline behavior.
    const r = evalEntry(byId('q-assistant-codename'), { turns: 'user', ks: [1, 5, 10] });
    expect(r.ks['5']).toBe(0);
  });
});

describe('parseLmeDate — LongMemEval date parsing', () => {
  it('parses the "YYYY/MM/DD (Day) HH:MM" format by stripping the weekday paren', () => {
    const a = parseLmeDate('2023/05/30 (Tue) 23:40');
    const b = parseLmeDate('2023/05/30 (Tue) 22:40');
    expect(Number.isFinite(a)).toBe(true);
    // one hour earlier → 3_600_000 ms less (sanity that HH:MM is honored)
    expect(a - b).toBe(3600000);
  });
  it('returns null on missing / unparseable input (caller falls back to offset 0)', () => {
    expect(parseLmeDate(null)).toBe(null);
    expect(parseLmeDate(undefined)).toBe(null);
    expect(parseLmeDate('')).toBe(null);
    expect(parseLmeDate('not a date')).toBe(null);
  });
});

describe('buildCorpus — temporal dating (--temporal ablation)', () => {
  // Sessions precede the question by 0 / ~15 / ~90 days. question_date is the "now".
  const datedEntry = {
    question_id: 'q-dated',
    question_date: '2023/05/30 (Tue) 12:00',
    haystack_session_ids: ['s-old', 's-mid', 's-new'],
    haystack_dates: ['2023/03/01 (Wed) 12:00', '2023/05/15 (Mon) 12:00', '2023/05/30 (Tue) 11:00'],
    haystack_sessions: [
      [{ role: 'user', content: 'old session about caching' }],
      [{ role: 'user', content: 'mid session about indexing' }],
      [{ role: 'user', content: 'new session about ranking' }],
    ],
    answer_session_ids: ['s-new'],
  };

  it('default (no temporal) keeps every session at offset 0 — preserves the uniform baseline', () => {
    const { data } = buildCorpus(datedEntry);
    expect(data.observations.map((o) => o.epoch_offset_days)).toEqual([0, 0, 0]);
  });

  it('temporal dates each session from haystack_dates relative to question_date (offsets ≤ 0, monotonic by age)', () => {
    const { data } = buildCorpus(datedEntry, { temporal: true });
    const [oldOff, midOff, newOff] = data.observations.map((o) => o.epoch_offset_days);
    // newest session is ~1h before the question → ~0; older sessions are progressively more negative
    expect(newOff).toBeGreaterThan(-1);
    expect(newOff).toBeLessThanOrEqual(0);
    expect(midOff).toBeLessThan(-10);
    expect(midOff).toBeGreaterThan(-20);
    expect(oldOff).toBeLessThan(-60);
    // strictly increasing toward the present — the property the decay multiplier reads
    expect(oldOff).toBeLessThan(midOff);
    expect(midOff).toBeLessThan(newOff);
  });

  it('temporal with no dates falls back to offset 0 (no crash on undated datasets)', () => {
    const undated = { ...datedEntry, haystack_dates: [], question_date: undefined };
    const { data } = buildCorpus(undated, { temporal: true });
    expect(data.observations.map((o) => o.epoch_offset_days)).toEqual([0, 0, 0]);
  });
});

describe('runLongMemEval — aggregation', () => {
  it('aggregates recall_any@{1,5,10} overall and per question_type', () => {
    const out = runLongMemEval(SAMPLE, { turns: 'user', ks: [1, 5, 10], limit: 10 });
    expect(out.n).toBe(3);
    expect(out.config.turns).toBe('user');
    for (const k of ['1', '5', '10']) {
      expect(out.overall.recallAny[k]).toBeGreaterThanOrEqual(0);
      expect(out.overall.recallAny[k]).toBeLessThanOrEqual(1);
    }
    // two lexical single-session-user questions are both found; the assistant-only one is not
    expect(out.overall.recallAny['5']).toBeCloseTo(2 / 3, 5);
    expect(out.perType['single-session-user'].recallAny['5']).toBe(1);
    expect(out.perType['single-session-assistant'].recallAny['5']).toBe(0);
    expect(out.perQuestion).toHaveLength(3);
  });
});
