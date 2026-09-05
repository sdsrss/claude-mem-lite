// tests/patha-exclude-report.test.mjs — the reader for D#216's meter.
//
// The meter (lib/patha-exclude-meter.mjs) has shipped with no consumer at all: nothing
// under mem-cli / lib / benchmark / scripts filters on `patha_exclude`, so the rows
// accumulate and nobody reads them (the defer's NICE-11). This is that reader, and the
// checks below are the ones its OWN failure modes call for:
//
//   • The schema CHANGED mid-stream. Rows written before the pre-tag B5 fix carry no
//     `markerCoercibleStrings` key and their `inert` was computed on the wrong rule
//     ("any string present"), which over-counts. Folding those into the same column as
//     post-fix rows is the "two calibers in one number" error this repo keeps paying for,
//     so they get their own bucket and leave the denominator.
//   • `armB: 'error'` rows deliberately carry NO `net` / `setChanged` — the meter leaves
//     them undefined precisely so a failed arm cannot read as a measured zero. A reader
//     that `?? 0`s them re-introduces exactly the defect the meter avoided.
//   • A corpus in which the defect's population never occurred must report that, not
//     "no harm". `suppressed` summing to zero over prompts whose exclude was never inert
//     is a statement about the sample, not about the repair.
//
// D#207: paths built with join(), never `new URL('../X.mjs', import.meta.url)` — the URL
// form drops the named module out of knip's unused-export report entirely.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PATHA_EXCLUDE_EVENT,
  classifyMarkerRegime,
  aggregatePathAExclude,
  formatPathAReport,
  readPathARows,
  assertCanSeeSuppression,
  assertErrorArmIsNotAZero,
  parseDaysArg,
} from '../benchmark/patha-exclude-report.mjs';

/** A post-B5 row with sane defaults; override what a case is about. */
const row = (o = {}) => ({
  ts: '2026-09-02T12:00:00.000Z',
  event: PATHA_EXCLUDE_EVENT,
  markerTotal: 1,
  markerStrings: 0,
  markerNumbers: 1,
  markerCoercible: 1,
  markerCoercibleStrings: 0,
  inert: false,
  emitted: 2,
  suppressed: 0,
  suppressedIds: [],
  imperativeArm: 'off',
  armB: 'ok',
  delivered: 2,
  refilledIds: [],
  refilled: 0,
  net: 0,
  setChanged: false,
  ...o,
});

describe('classifyMarkerRegime', () => {
  it('buckets a pre-B5 row as legacy on the ABSENCE of markerCoercibleStrings', () => {
    // The distinguishing feature is the missing key, not any value: such a row's `inert`
    // was computed as `markerStrings > 0`, which counts P/D/E-only markers as inert.
    const legacy = { markerTotal: 1, markerStrings: 1, markerNumbers: 0, markerCoercible: 0, inert: true };
    expect(classifyMarkerRegime(legacy)).toBe('legacy');
  });

  it('does NOT call a P/D/E-only marker inert, even though it carries a string', () => {
    // Review finding B5: a marker holding nothing that could ever have been excluded is
    // not an inert exclude — counting it inflates the denominator this column exists to
    // keep honest. `inert: false` in the row is what the shipped meter now writes.
    expect(
      classifyMarkerRegime(
        row({ markerStrings: 1, markerNumbers: 0, markerCoercible: 0, markerCoercibleStrings: 0 }),
      ),
    ).toBe('nothing-excludable');
  });

  it('calls a marker inert when a coercible id arrived as a string', () => {
    expect(
      classifyMarkerRegime(
        row({ markerStrings: 1, markerNumbers: 0, markerCoercible: 1, markerCoercibleStrings: 1 }),
      ),
    ).toBe('inert');
  });

  it('calls an all-numeric marker with excludable ids working', () => {
    expect(
      classifyMarkerRegime(
        row({ markerStrings: 0, markerNumbers: 3, markerCoercible: 3, markerCoercibleStrings: 0 }),
      ),
    ).toBe('working');
  });

  it('keys inert on markerCoercibleStrings, not on the row is own inert field', () => {
    // Defence against a reader that trusts a stale/mis-computed boolean over the counts.
    expect(classifyMarkerRegime(row({ markerCoercible: 1, markerCoercibleStrings: 1, inert: false }))).toBe(
      'inert',
    );
    expect(classifyMarkerRegime(row({ markerCoercible: 0, markerCoercibleStrings: 0, inert: true }))).toBe(
      'nothing-excludable',
    );
  });
});

describe('aggregatePathAExclude', () => {
  it('keeps legacy rows out of the marker-regime denominator', () => {
    const legacy = {
      markerTotal: 1,
      markerStrings: 1,
      markerCoercible: 0,
      inert: true,
      armB: 'ok',
      emitted: 0,
      suppressed: 0,
      refilled: 0,
      net: 0,
    };
    const agg = aggregatePathAExclude([legacy, row(), row()]);
    expect(agg.total).toBe(3);
    expect(agg.legacy).toBe(1);
    expect(agg.regimeTotal).toBe(2);
    expect(agg.regime.working).toBe(2);
    expect(agg.regime.inert).toBe(0);
  });

  it('counts an armB error WITHOUT letting it read as a measured zero', () => {
    const agg = aggregatePathAExclude([
      row({
        armB: 'error',
        armBError: 'boom',
        delivered: undefined,
        refilled: undefined,
        net: undefined,
        setChanged: undefined,
      }),
      row({ suppressed: 1, suppressedIds: [7], refilled: 1, refilledIds: [9], net: 0, setChanged: true }),
    ]);
    expect(agg.armB.error).toBe(1);
    expect(agg.armB.ok).toBe(1);
    // The error row must not enlarge the measured population: one ok prompt, and it changed.
    expect(agg.okPrompts).toBe(1);
    expect(agg.setChangedPrompts).toBe(1);
    expect(agg.netRows).toBe(0);
  });

  it('counts a skipped arm separately from an errored one', () => {
    const agg = aggregatePathAExclude([
      row({
        armB: 'skipped',
        delivered: undefined,
        refilled: undefined,
        net: undefined,
        setChanged: undefined,
      }),
    ]);
    expect(agg.armB.skipped).toBe(1);
    expect(agg.armB.error).toBe(0);
    expect(agg.okPrompts).toBe(0);
  });

  it('reports refill as rows-refilled over rows-freed, plus the pure-loss prompt count', () => {
    const agg = aggregatePathAExclude([
      row({ suppressed: 2, suppressedIds: [1, 2], refilled: 1, refilledIds: [3], net: -1, setChanged: true }),
      row({ suppressed: 1, suppressedIds: [4], refilled: 0, refilledIds: [], net: -1, setChanged: true }),
      row(),
    ]);
    expect(agg.suppressedRows).toBe(3);
    expect(agg.refilledRows).toBe(1);
    expect(agg.suppressedPrompts).toBe(2);
    expect(agg.pureLossPrompts).toBe(1);
    expect(agg.refillRatio).toBeCloseTo(1 / 3, 6);
    expect(agg.netRows).toBe(-2);
    expect(agg.verdict).toBe('DECIDABLE');
  });

  it('refuses to compute a refill ratio when nothing was ever freed', () => {
    // A ratio over an empty denominator is the shape that gets quoted as "0% refilled".
    const agg = aggregatePathAExclude([row(), row()]);
    expect(agg.suppressedRows).toBe(0);
    expect(agg.refillRatio).toBeNull();
    expect(agg.verdict).toBe('NO-POPULATION');
  });

  it('reports SKIP, not a zero, on an empty corpus', () => {
    const agg = aggregatePathAExclude([]);
    expect(agg.total).toBe(0);
    expect(agg.verdict).toBe('SKIP');
    expect(agg.refillRatio).toBeNull();
  });

  it('tracks the imperative face is arm and whether its gate ever opened', () => {
    const agg = aggregatePathAExclude([
      row({ imperativeArm: 'off' }),
      row({ imperativeArm: 'on', imperativeBefore: null, imperativeAfter: null, imperativeChanged: false }),
      row({ imperativeArm: 'on', imperativeBefore: 8641, imperativeAfter: 8641, imperativeChanged: false }),
      row({ imperativeArm: 'on', imperativeBefore: 8641, imperativeAfter: 42, imperativeChanged: true }),
    ]);
    expect(agg.imperative.off).toBe(1);
    expect(agg.imperative.on).toBe(3);
    // `on` with a null pick means the flag was set but the gate never selected anything —
    // reporting only `on` would read as three measured comparisons when there were two.
    expect(agg.imperative.gateOpen).toBe(2);
    expect(agg.imperative.changed).toBe(1);
  });
});

describe('formatPathAReport', () => {
  it('says why there is nothing to read when metrics are off', () => {
    const text = formatPathAReport(aggregatePathAExclude([]), { days: 7, metricsEnabled: false });
    expect(text).toMatch(/SKIP/);
    expect(text).toMatch(/CLAUDE_MEM_METRICS/);
  });

  it('distinguishes metrics-on-but-empty from metrics-off', () => {
    const text = formatPathAReport(aggregatePathAExclude([]), { days: 7, metricsEnabled: true });
    expect(text).toMatch(/SKIP/);
    expect(text).not.toMatch(/CLAUDE_MEM_METRICS/);
  });

  it('states the population was not observed rather than claiming the repair is harmless', () => {
    const text = formatPathAReport(aggregatePathAExclude([row(), row()]), { days: 7, metricsEnabled: true });
    expect(text).toMatch(/NO-POPULATION/);
    // Pinned on the caveat SENTENCE, not on the words. A first version asserted
    // /NO-POPULATION/ + /inert/ + /sample/i, all three of which are satisfied by the
    // verdict header and the regime table — deleting the caveat's lead-in left it green.
    // An assertion another line can satisfy is not an assertion about this line.
    expect(text).toMatch(/statement about the sample, not about the repair/);
    expect(text).toMatch(/no refill ratio to quote/);
  });

  it('leads the decidable case with the refill columns D#216 turns on', () => {
    const agg = aggregatePathAExclude([
      row({ suppressed: 2, suppressedIds: [1, 2], refilled: 1, refilledIds: [3], net: -1, setChanged: true }),
    ]);
    const text = formatPathAReport(agg, { days: 7, metricsEnabled: true });
    expect(text).toMatch(/DECIDABLE/);
    expect(text).toMatch(/refilled/);
    expect(text).toMatch(/pure loss/i);
  });

  it('surfaces the legacy-row count instead of hiding it', () => {
    const legacy = {
      markerTotal: 1,
      markerStrings: 1,
      markerCoercible: 0,
      inert: true,
      armB: 'ok',
      emitted: 0,
      suppressed: 0,
      refilled: 0,
      net: 0,
    };
    const text = formatPathAReport(aggregatePathAExclude([legacy, row()]), { days: 7, metricsEnabled: true });
    expect(text).toMatch(/legacy/i);
  });
});

describe('readPathARows', () => {
  it('returns only patha_exclude rows from the metrics shards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patha-report-'));
    try {
      const mdir = join(dir, 'metrics');
      mkdirSync(mdir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(
        join(mdir, `${today}.jsonl`),
        [
          JSON.stringify({ ts: '2026-09-02T00:00:00.000Z', event: 'inject', n: 1 }),
          JSON.stringify(row({ ts: '2026-09-02T00:00:01.000Z' })),
          'not json at all',
          JSON.stringify({ ts: '2026-09-02T00:00:02.000Z', event: 'search', durationMs: 4 }),
        ].join('\n') + '\n',
      );
      const rows = readPathARows(dir, 7);
      expect(rows).toHaveLength(1);
      expect(rows[0].event).toBe(PATHA_EXCLUDE_EVENT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array when the metrics dir does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patha-report-empty-'));
    try {
      expect(readPathARows(dir, 7)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The self-checks main() runs. Each is driven with a DELIBERATELY BROKEN aggregator and
// watched to throw: a guard exercised only through the live corpus is a guard nobody has
// seen fire, and on this machine's corpus (suppressed === 0 everywhere) it never would.
describe('self-checks', () => {
  it('assertCanSeeSuppression passes the real aggregator', () => {
    expect(() => assertCanSeeSuppression(aggregatePathAExclude)).not.toThrow();
  });

  it('assertCanSeeSuppression fires on an aggregator that drops suppression', () => {
    const blind = (rows) => ({
      ...aggregatePathAExclude(rows),
      suppressedRows: 0,
      refilledRows: 0,
      refillRatio: null,
      verdict: 'NO-POPULATION',
    });
    expect(() => assertCanSeeSuppression(blind)).toThrow(/suppress/i);
  });

  it('assertErrorArmIsNotAZero passes the real aggregator', () => {
    expect(() => assertErrorArmIsNotAZero(aggregatePathAExclude)).not.toThrow();
  });

  it('assertErrorArmIsNotAZero fires on an aggregator that counts an error row as an ok zero', () => {
    const sloppy = (rows) => {
      const a = aggregatePathAExclude(rows);
      return { ...a, okPrompts: rows.length };
    };
    expect(() => assertErrorArmIsNotAZero(sloppy)).toThrow(/error/i);
  });
});

describe('--days cannot silently answer a different question than it was asked', () => {
  // Review N8. `parseInt('0')` is 0, which is FALSY, so the original
  // `Math.max(1, parseInt(v, 10) || DEFAULT)` sent `--days 0` to the 7-day default while
  // the report header printed `last 0d`. The clamp that looks like it covers this was
  // unreachable for 0 — only negatives ever reached it.
  it('honours 0 by clamping to 1, instead of falling through to the default', () => {
    expect(parseDaysArg(['node', 'x', '--days', '0'], 7)).toBe(1);
  });

  it('clamps negatives to 1 as well', () => {
    expect(parseDaysArg(['node', 'x', '--days', '-3'], 7)).toBe(1);
  });

  it('passes real values through untouched', () => {
    expect(parseDaysArg(['node', 'x', '--days', '30'], 7)).toBe(30);
    expect(parseDaysArg(['node', 'x', '--days', '1'], 7)).toBe(1);
  });

  it('falls back to the default only for a genuinely absent or non-numeric argument', () => {
    // The distinction the bug erased: "you gave me nothing" and "you gave me a number I
    // do not like" are different, and only the first should silently become 7.
    expect(parseDaysArg(['node', 'x'], 7)).toBe(7);
    expect(parseDaysArg(['node', 'x', '--days'], 7)).toBe(7);
    expect(parseDaysArg(['node', 'x', '--days', 'abc'], 7)).toBe(7);
    expect(parseDaysArg(['node', 'x', '--json'], 7)).toBe(7);
  });
});
