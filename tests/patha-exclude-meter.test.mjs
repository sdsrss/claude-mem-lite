// lib/patha-exclude-meter.mjs — the ruler for D#213.
//
// Every ruler in this repo that shipped without a test under `tests/` later turned out to
// have a self-check that could be deleted with a green suite (citation-live-replay in
// v3.82.0, rerank-pool-replay in D#190). This file exists so that does not happen a third
// time, and it drives each guarantee to FAIL rather than asserting the happy path:
//
//   - the coercion must DROP `E<id>` and must not smuggle NaN into the exclude set;
//   - every count column must come from its own input (a review found `delivered`,
//     `emitted` and `markerTotal` each replaceable by a constant with the file green);
//   - the recorded event name must be pinned to the LITERAL, not to the imported
//     constant — that comparison is a tautology, and renaming the constant orphaned
//     every recorded row with the whole suite green;
//   - `setChanged` must survive a one-for-one replacement, where `net` is 0;
//   - a failed arm B must be recorded as an error, never as "no difference";
//   - the gate must be able to say no (metrics off, empty marker, non-array marker).
//
// Arm B's ORDERING and side-effect freedom are not asserted here — they are properties of
// the caller, and they live in tests/patha-meter-counterfactual.test.mjs.
//
// Note on `inert`: it is per PROMPT, not a constant, and it is defined on ids that are
// coercible AND arrived as strings — not on "some string is present". A draft used the
// looser rule on the belief that only a PreToolUse emission can turn the union into
// strings; that is false (UPS writes `P<id>` and `D<id>` itself, and its deferred leg
// merges `prevIds.map(String)`), and under the loose rule a marker of nothing but those
// namespaces counted as inert while having nothing excludable at all. Both the working
// case and that shape are asserted below.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PATHA_EXCLUDE_EVENT,
  pathAMeterEnabled,
  markerTypeSplit,
  coerceMarkerIds,
  suppressedByWorkingExclude,
  inertMarkerIds,
  measurePathAExclude,
  recordPathAExclude,
} from '../lib/patha-exclude-meter.mjs';

const rows = (...ids) => ids.map((id) => ({ id }));

describe('markerTypeSplit — the defect is a type, so the type split is the primary column', () => {
  it('separates the string and number halves of one marker', () => {
    const s = markerTypeSplit(['1', '2', 3, null]);
    expect(s).toEqual({ total: 4, strings: 2, numbers: 1, other: 1 });
  });

  it('is empty-safe in both directions', () => {
    expect(markerTypeSplit([])).toEqual({ total: 0, strings: 0, numbers: 0, other: 0 });
    expect(markerTypeSplit(undefined)).toEqual({ total: 0, strings: 0, numbers: 0, other: 0 });
  });
});

describe('coerceMarkerIds — the repair, and the two holes a naive repair opens', () => {
  it('coerces the string ids the shipped comparison misses', () => {
    expect([...coerceMarkerIds(['1', '2', 3])]).toEqual([1, 2, 3]);
  });

  it('DROPS namespaced event ids instead of turning them into NaN', () => {
    const set = coerceMarkerIds(['E42', '7']);
    // The premise: 'E42' is a real marker shape (D#188), not a hypothetical.
    expect(set.has(42), 'E42 must not be read as observation 42').toBe(false);
    expect([...set].some(Number.isNaN), 'a NaN in an exclude set is a silent no-op').toBe(false);
    expect([...set]).toEqual([7]);
  });

  it('rejects values that cannot be a primary key', () => {
    expect([...coerceMarkerIds(['', ' ', '0', '-3', '1.5', 'abc', null, undefined, {}])]).toEqual([]);
    // '' and null both coerce to 0 under Number(); the guard is `> 0`, not truthiness,
    // and this case is what keeps that from being rewritten as `if (n)`.
    expect(Number('')).toBe(0);
  });
});

describe('inertMarkerIds — the predicate `inert` is defined on', () => {
  it('keeps only ids that are BOTH coercible and string-typed', () => {
    // Each of the four inputs is there to kill a different wrong rule:
    //   '7'  — the real case (a working exclude would have matched it)
    //   7    — a number: the exclude already works on it, so it is not evidence of inertness
    //   'P9' — a string, but another table's namespace: nothing excludable
    //   'x'  — a string that is not an id at all
    expect(inertMarkerIds(['7', 7, 'P9', 'x'])).toEqual([7]);
  });

  it('is empty for a marker of plain numbers and for a P/D/E-only marker alike', () => {
    expect(inertMarkerIds([1, 2, 3])).toEqual([]);
    expect(inertMarkerIds(['P1', 'D2', 'E3'])).toEqual([]);
    expect(inertMarkerIds(undefined)).toEqual([]);
  });
});

describe('suppressedByWorkingExclude — exact, because arm A is inert', () => {
  it('names only the delivered rows the marker actually holds', () => {
    // 99 is the decoy: it is delivered but NOT in the marker, so an implementation that
    // returns the whole delivered set — or the whole marker — fails here.
    expect(suppressedByWorkingExclude(['1', '2'], [1, 99])).toEqual([1]);
  });

  it('returns nothing when the two sets are disjoint', () => {
    expect(suppressedByWorkingExclude(['5'], [1, 2])).toEqual([]);
  });
});

describe('measurePathAExclude — both arms in one call', () => {
  it('reports every count column from its own inputs', () => {
    // The pre-tag correctness review killed five mutations here by surviving them:
    // `delivered`, `emitted` and `markerTotal` could each be replaced by a constant or by
    // the other arm's length with 17 cases green. Three of the columns any D#214 reading
    // will quote had no assertion that could fail.
    const r = measurePathAExclude({
      markerIds: ['1', '2', 3],
      emitted: rows(1, 2, 3, 4),
      after: { rows: rows(3, 4, 9) },
    });
    expect(r.markerTotal, 'markerTotal is the marker, not the delivered set').toBe(3);
    expect(r.emitted, 'emitted is arm A: 4 rows').toBe(4);
    expect(r.delivered, 'delivered is arm B: 3 rows — not a copy of emitted').toBe(3);
    expect(r.delivered).not.toBe(r.emitted);
    expect(r.net).toBe(-1);
  });

  it('reports inert per PROMPT, not as a constant', () => {
    const stringy = measurePathAExclude({ markerIds: ['1'], emitted: rows(1) });
    const numeric = measurePathAExclude({ markerIds: [1], emitted: rows(1) });
    expect(stringy.inert).toBe(true);
    // A marker still holding plain numbers compares correctly.
    expect(numeric.inert).toBe(false);
    // …and the suppression count is the same either way, which is why `inert` has to be
    // its own column: it is the denominator, not the effect.
    expect(stringy.suppressed).toBe(numeric.suppressed);
  });

  it('does NOT call a P/D/E-only marker inert — it had nothing excludable', () => {
    // The case the pre-tag claims review found (B5). `user-prompt-search.js` writes
    // `P<id>` (prompt corpus) and `D<id>` (deferred) itself, with no PreToolUse involved,
    // so a marker of nothing but other tables' namespaces is a real shape. Defining
    // inert as "some string is present" counts it, inflating the denominator in the
    // direction the column exists to prevent.
    const r = measurePathAExclude({ markerIds: ['P42', 'D7', 'E9'], emitted: rows(42, 7, 9) });
    expect(r.markerStrings, 'they ARE strings — that is why the naive rule catches them').toBe(3);
    expect(r.markerCoercible).toBe(0);
    expect(r.markerCoercibleStrings).toBe(0);
    expect(r.inert, 'nothing here could ever have been excluded').toBe(false);
    expect(r.suppressed, 'and no delivered row is suppressed either').toBe(0);
  });

  it('still calls a MIXED marker inert, on the coercible string alone', () => {
    const r = measurePathAExclude({ markerIds: ['P42', '7'], emitted: rows(7) });
    expect(r.markerCoercibleStrings).toBe(1);
    expect(r.inert).toBe(true);
    expect(r.suppressed).toBe(1);
  });

  it('a marker of plain numbers is not inert however many namespaced ids sit beside it', () => {
    const r = measurePathAExclude({ markerIds: [7, 'D3'], emitted: rows(7) });
    expect(r.inert).toBe(false);
    // The exclude worked, so arm A already dropped it — `suppressed` here is the count of
    // rows a working exclude WOULD drop, and 7 was delivered, so it is 1. The pairing to
    // watch when reading the data is `inert:false` with `suppressed>0`.
    expect(r.markerCoercible).toBe(1);
  });

  it('separates suppressed from refilled, and keeps setChanged alive when net is 0', () => {
    const r = measurePathAExclude({
      markerIds: ['1'],
      emitted: rows(1, 2),
      after: { rows: rows(2, 7) }, // 1 dropped, 7 pulled in from the pool: one-for-one
    });
    expect(r.suppressed).toBe(1);
    expect(r.suppressedIds).toEqual([1]);
    expect(r.refilled).toBe(1);
    expect(r.refilledIds).toEqual([7]);
    expect(r.net, 'a one-for-one replacement is net zero').toBe(0);
    expect(r.setChanged, 'net zero is not "nothing happened" — the delivered SET moved').toBe(true);
  });

  it('records a lost slot as a loss rather than as a refill', () => {
    const r = measurePathAExclude({ markerIds: ['1'], emitted: rows(1, 2), after: { rows: rows(2) } });
    expect(r.suppressed).toBe(1);
    expect(r.refilled).toBe(0);
    expect(r.net).toBe(-1);
    expect(r.setChanged).toBe(true);
  });

  it('marks a FAILED arm B as an error, not as no-difference', () => {
    const r = measurePathAExclude({
      markerIds: ['1'],
      emitted: rows(1),
      after: { error: 'db gone' },
    });
    expect(r.armB).toBe('error');
    expect(r.armBError).toContain('db gone');
    // The trap this asserts against: an arm that failed must not leave the row looking
    // like a measured zero.
    expect(r.net).toBeUndefined();
    expect(r.setChanged).toBeUndefined();
  });

  it('marks an absent arm B as skipped rather than reporting a delta it never took', () => {
    const r = measurePathAExclude({ markerIds: ['1'], emitted: rows(1) });
    expect(r.armB).toBe('skipped');
    expect(r.delivered).toBeUndefined();
  });

  it('declares the task_imperative face rather than omitting it', () => {
    const off = measurePathAExclude({ markerIds: ['1'], emitted: rows(1) });
    expect(off.imperativeArm, 'a face left out of the row reads as a face with no effect').toBe('off');
    expect('imperativeChanged' in off).toBe(false);

    const on = measurePathAExclude({
      markerIds: ['1'],
      emitted: rows(1),
      imperativeArm: 'on',
      imperativeBefore: 5,
      imperativeAfter: 9,
    });
    expect(on.imperativeChanged).toBe(true);
    const same = measurePathAExclude({
      markerIds: ['1'],
      emitted: rows(1),
      imperativeArm: 'on',
      imperativeBefore: 5,
      imperativeAfter: 5,
    });
    expect(same.imperativeChanged).toBe(false);
  });
});

describe('recordPathAExclude — the gate must be able to say no', () => {
  let dir;
  const prev = process.env.CLAUDE_MEM_METRICS;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patha-meter-'));
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_MEM_METRICS;
    else process.env.CLAUDE_MEM_METRICS = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing at all with metrics off — including the expensive arm', () => {
    delete process.env.CLAUDE_MEM_METRICS;
    expect(pathAMeterEnabled()).toBe(false);
    const out = recordPathAExclude(dir, {
      markerIds: ['1'],
      emitted: rows(1),
      after: { rows: rows() },
    });
    expect(out).toBeNull();
    expect(existsSync(join(dir, 'metrics'))).toBe(false);
  });

  it('does nothing when the marker was empty — no marker, no exclude, nothing to price', () => {
    process.env.CLAUDE_MEM_METRICS = '1';
    expect(recordPathAExclude(dir, { markerIds: [], after: { rows: rows() } })).toBeNull();
    // The guard has three clauses and each one must be able to fire on its own: a
    // review found that dropping `!Array.isArray(opts.markerIds)` survived the suite.
    expect(recordPathAExclude(dir, { markerIds: 'nope', after: { rows: rows() } })).toBeNull();
    expect(recordPathAExclude(dir, null)).toBeNull();
    expect(existsSync(join(dir, 'metrics')), 'no row may be written by any refused call').toBe(false);
  });

  it('appends one row carrying both arms when enabled', () => {
    process.env.CLAUDE_MEM_METRICS = '1';
    const out = recordPathAExclude(dir, {
      markerIds: ['1', 'E9'],
      emitted: rows(1, 2),
      after: { rows: rows(2, 7) },
    });
    expect(out).not.toBeNull();
    expect(out.suppressed).toBe(1);

    const files = readdirSync(join(dir, 'metrics'));
    expect(files.length).toBe(1);
    const line = readFileSync(join(dir, 'metrics', files[0]), 'utf8').trim();
    const row = JSON.parse(line);
    // The LITERAL, not the imported constant. Comparing the recorded value to the same
    // constant is a tautology: a review renamed PATHA_EXCLUDE_EVENT to 'MUTATED_EVENT'
    // and the whole suite stayed green, which would orphan every row ever recorded.
    expect(PATHA_EXCLUDE_EVENT).toBe('patha_exclude');
    expect(row.event).toBe('patha_exclude');
    expect(row.ts).toBeTruthy();
    expect(row.markerStrings).toBe(2);
    expect(row.markerCoercible, 'E9 is an event id and must not enter the exclude set').toBe(1);
    expect(row.suppressedIds).toEqual([1]);
    expect(row.refilledIds).toEqual([7]);
  });
});
