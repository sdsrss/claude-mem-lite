// The arithmetic behind D#178's headline. benchmark/episode-flush-replay.mjs replays the
// SHIPPED episode batcher over real transcripts, so its batching cannot drift from
// production — but its accounting is its own, and the accounting is what gets quoted
// ("42.8% of collected reads destroyed", "×1.74 under the fix"). These cases pin it.
//
// The one bug this file exists to keep out is the one it already caught in review: a
// counterfactual that carries reads ACROSS projects. `reads-<project>.txt` is per project,
// so a carry-forward summed over one global flush list credits project A's reads to
// project B's next significant flush and inflates the recovered figure.
import { describe, it, expect } from 'vitest';
import {
  replayProject,
  aggregate,
  carryForward,
  assertRulerCanSayNo,
} from '../benchmark/episode-flush-replay.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-08-25T10:00:00.000Z');

/** A Bash entry with a benign response: no edit, no error, no path → insignificant. */
const bash = (ts, session = 's1') => ({
  kind: 'tool',
  ts,
  session,
  cwd: '/w/proj',
  tool: 'Bash',
  input: { command: 'echo hello from the harness' },
  response: 'hello from the harness\n',
});
/** A Write to a .sql file: rule 1 (edit) AND rule 3 (schema-ish path) → significant. */
const write = (ts, file = '/w/proj/alpha-schema.sql', session = 's1') => ({
  kind: 'tool',
  ts,
  session,
  cwd: '/w/proj',
  tool: 'Write',
  input: { file_path: file, content: 'CREATE TABLE t (id INTEGER);\n' },
  response: `File created successfully at: ${file}`,
});
const read = (ts, path) => ({ kind: 'read', ts, path, cwd: '/w/proj', session: 's1' });
const stop = (ts) => ({ kind: 'stop', ts, session: 's1', cwd: '/w/proj' });

describe('replayProject — an insignificant flush consumes the pending reads', () => {
  it('attributes the reads to the flush that swept them, not to the next one', () => {
    const { flushes } = replayProject(
      [
        read(T0, '/w/proj/a.mjs'),
        read(T0 + 1000, '/w/proj/b.mjs'),
        bash(T0 + 2000),
        stop(T0 + 3000), // flush 1: entries but insignificant → eats both reads
        write(T0 + 4000),
        stop(T0 + 5000), // flush 2: significant, and there is nothing left to attach
      ],
      'proj',
    );

    expect(flushes).toHaveLength(2);
    expect(flushes[0]).toMatchObject({ significant: false, readsConsumed: 2 });
    expect(flushes[1]).toMatchObject({ significant: true, readsConsumed: 0 });

    const t = aggregate(flushes);
    expect(t.readsDestroyed).toBe(2);
    expect(t.readsDelivered).toBe(0);
    expect(t.destroyedShare).toBe(1);
  });

  it('a Stop with no buffered episode consumes nothing — production returns before the collect', () => {
    const { flushes } = replayProject(
      [
        read(T0, '/w/proj/a.mjs'),
        stop(T0 + 1000), // no entries buffered → handleStop returns, reads untouched
        write(T0 + 2000),
        stop(T0 + 3000),
      ],
      'proj',
    );

    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toMatchObject({ significant: true, readsConsumed: 1 });
  });

  it('records the age of the reads a flush swept up', () => {
    const { flushes } = replayProject(
      [read(T0, '/w/proj/a.mjs'), bash(T0 + 10 * MIN), stop(T0 + 10 * MIN + 1000)],
      'proj',
    );
    expect(flushes[0].maxReadAgeMs).toBeGreaterThanOrEqual(10 * MIN);
  });
});

describe('carryForward — the counterfactual', () => {
  const insig = (ts, reads) => ({
    ts,
    significant: false,
    readsConsumed: reads,
    maxReadAgeMs: 0,
    cfAgeMs: 0,
    cfDelivered: 0,
  });
  // `reads` is what THIS flush swept up; `union` is the distinct set the counterfactual
  // holds when it delivers — smaller whenever a path was read in more than one window.
  const sig = (ts, reads, { union = reads, cfAgeMs = 0 } = {}) => ({
    ts,
    significant: true,
    readsConsumed: reads,
    maxReadAgeMs: 0,
    cfAgeMs,
    cfDelivered: union,
  });

  it('delivers the DISTINCT carried set, not the sum of per-flush counts', () => {
    // 3 + 2 + 1 = 6 occurrences, but only 4 distinct paths: two were read again in a
    // later window. Production collects with `new Set(...)`, so it writes 4.
    // A summing implementation returns 6 here — that is the whole point of the fixture,
    // and it is why the numbers differ (the shipped delivery multiple was 2.9% high
    // before this was fixed).
    const cf = carryForward([[insig(1, 3), insig(2, 2), sig(3, 1, { union: 4, cfAgeMs: 5 * MIN })]]);
    expect(cf.delivered).toBe(4);
    expect(cf.deliveredFlushes).toBe(1);
    expect(cf.medianCarriedAgeMs).toBe(5 * MIN);
  });

  it("does NOT carry one project's reads into another project's flush", () => {
    // Same rows, split across two projects: A's 3 reads have no significant flush of
    // their own, so they must be delivered NOWHERE — not to B's.
    const mixed = carryForward([[insig(1, 3)], [sig(2, 0, { union: 3 })]]);
    expect(mixed.delivered).toBe(0);
    expect(mixed.stillZero).toBe(1);
    // The same rows in ONE project would deliver — which is what makes the split the
    // discriminating variable rather than the row contents.
    expect(carryForward([[insig(1, 3), sig(2, 0, { union: 3 })]]).delivered).toBe(3);
  });
});

describe('assertRulerCanSayNo — the headline must be able to reach both ends', () => {
  const corpus = () =>
    new Map([
      [
        'proj',
        [
          read(T0, '/w/proj/a.mjs'),
          bash(T0 + 1000),
          stop(T0 + 2000),
          read(T0 + 3000, '/w/proj/b.mjs'),
          write(T0 + 4000),
          stop(T0 + 5000),
        ],
      ],
    ]);

  it('passes on a corpus where both arms move', () => {
    const { problems, allSig, noneSig } = assertRulerCanSayNo(corpus());
    expect(problems).toEqual([]);
    expect(allSig.destroyedShare).toBe(0);
    expect(noneSig.destroyedShare).toBe(1);
  });

  it('reports the vacuous case rather than a 0% finding when the corpus has no reads', () => {
    const noReads = new Map([['proj', [bash(T0), stop(T0 + 1000)]]]);
    expect(assertRulerCanSayNo(noReads).problems).toEqual(['no reads in corpus — the headline is vacuous']);
  });
});
