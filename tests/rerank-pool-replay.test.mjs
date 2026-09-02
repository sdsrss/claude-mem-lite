// benchmark/rerank-pool-replay.mjs — the ruler for the `fyi` face's pool bounds.
//
// D#190. Both CHANGELOG and CLAUDE.md justify believing this ruler with the sentence
// "four self-checks, each verified able to fail", and v3.85.1's headline RULER note
// sells the nonEmptyToEmpty counterexample gate specifically. Those claims were true
// when written — the pre-tag review mutated each one and watched it fire — and nothing
// whatsoever kept them true: no file under tests/ imported this module, so the twin
// patch guard, the read-only assertion, the determinism check and the counterexample
// gate could all be deleted in one edit with 5337 cases still green. This project has
// the receipt: benchmark/citation-live-replay.mjs got its guard AFTER v3.82.0 found two
// of its self-checks removable from main() with a fully green suite.
//
// So: every check is driven here with synthetic inputs and watched to FAIL. A guard
// exercised only through the live corpus is a guard nobody has seen fire — and on a
// machine whose corpus happens to satisfy it, it never will.
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  patchConst,
  writeTwin,
  callArm,
  assertNoMetricWrite,
  metricShardPath,
  metricsDirSize,
  runLevelGrowth,
  assertCannotWrite,
  assertRulerCanSayNo,
  compare,
  costCompare,
  monotonicityState,
  counterexampleGate,
  validatePoolArg,
  MONOTONICITY_NOTE,
} from '../benchmark/rerank-pool-replay.mjs';
import { recordMetric } from '../lib/metrics.mjs';

// D#207: built with join(), never `new URL('../X.mjs', import.meta.url)` — the URL form
// makes knip drop the named module out of its unused-export report entirely, and this
// file naming hook-memory.mjs that way was one half of that blind spot.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// `compare` only ever hands `db` through to the two arms, so the arms here are plain
// functions over a table of canned answers and the handle is never touched.
const DB = null;
const arm = (table) => (_db, text) => (table[text] || []).map((id) => ({ id }));
const prompts = (...texts) => texts.map((text) => ({ text, project: 'p' }));

describe('self-check 1: the twin patch must apply, and must differ from shipped', () => {
  it('rewrites the declaration it was pointed at', () => {
    const { out, previous } = patchConst('const RERANK_POOL_SAME_PROJECT = 30;\n', 'RERANK_POOL_SAME_PROJECT', 10);
    expect(previous).toBe(30);
    expect(out).toContain('const RERANK_POOL_SAME_PROJECT = 10;');
  });

  it('THROWS when the anchor is gone (constant renamed) — not when the edit is a no-op', () => {
    // The distinction this guard was rewritten for: holding one pool at its shipped
    // value while sweeping the other is a legitimate no-op replacement, and the first
    // version reported it as "constant not found" — a true failure with a false cause,
    // which sends the reader to the wrong file.
    expect(() => patchConst('const SOMETHING_ELSE = 30;\n', 'RERANK_POOL_SAME_PROJECT', 10))
      .toThrow(/not found in hook-memory\.mjs/);
    expect(() => patchConst('const RERANK_POOL_SAME_PROJECT = 30;\n', 'RERANK_POOL_SAME_PROJECT', 30))
      .not.toThrow();
  });

  it('THROWS when the twin would be identical to shipped in BOTH arms', () => {
    // A twin that failed to differ compares the shipped module against itself and
    // reports a reassuring 0% — the exact failure this whole file exists to prevent.
    // The values come from hook-memory.mjs itself, so this stays true across re-tunes.
    const src = readFileSync(join(REPO, 'hook-memory.mjs'), 'utf8');
    const same = Number(/const RERANK_POOL_SAME_PROJECT = (\d+);/.exec(src)[1]);
    const cross = Number(/const RERANK_POOL_CROSS_PROJECT = (\d+);/.exec(src)[1]);
    expect(() => writeTwin(same, cross)).toThrow(/twin is identical to shipped/);
    // and a genuinely different twin does NOT throw — otherwise the case above passes
    // for any reason at all
    expect(() => writeTwin(same, cross + 1)).not.toThrow();
    rmSync(join(REPO, '.tmp-rerank-pool-twin.mjs'), { force: true });
  });
});

describe('self-check 2: the handle must reject a write', () => {
  it('THROWS on a writable handle — the contamination case', () => {
    // searchRelevantMemories bumps injection_count on every row it returns, so a
    // writable handle would permanently move the very noise signal being measured AND
    // let arm A's writes change arm B's scores.
    const db = new Database(':memory:');
    db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, injection_count INTEGER)');
    expect(() => assertCannotWrite(db)).toThrow(/accepted a write/);
    db.close();
  });

  it('passes on a genuinely read-only handle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rerank-pool-ro-'));
    const path = join(dir, 'ro.db');
    const w = new Database(path);
    w.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, injection_count INTEGER)');
    w.close();
    const ro = new Database(path, { readonly: true });
    expect(() => assertCannotWrite(ro)).not.toThrow();
    ro.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('self-check 3: shipped-vs-shipped must report zero', () => {
  it('passes for a deterministic arm', () => {
    const a = arm({ q1: [1, 2], q2: [3] });
    expect(() => assertRulerCanSayNo(DB, prompts('q1', 'q2'), a)).not.toThrow();
  });

  it('THROWS for a non-deterministic arm — the leaked-write / stateful-module case', () => {
    // If the same module compared against itself disagrees, every other number the
    // replay prints is noise, not a pool effect.
    let call = 0;
    const flaky = () => (call++ % 2 === 0 ? [{ id: 1 }] : [{ id: 2 }]);
    expect(() => assertRulerCanSayNo(DB, prompts('q1', 'q2'), flaky))
      .toThrow(/not deterministic/);
  });
});

describe('self-check 4: the nonEmptyToEmpty counterexample gate', () => {
  it('counts a prompt that injects under the NARROW arm and nothing under the WIDE one', () => {
    // A constructed non-prefix corpus: q2's wide arm returns nothing while its narrow
    // arm returns a row. Without such a case the gate can only ever be observed at 0,
    // which is indistinguishable from a gate that cannot count.
    const r = compare(DB, prompts('q1', 'q2'),
      arm({ q1: [1], q2: [7] }),      // narrow
      arm({ q1: [1, 2], q2: [] }));   // wide
    expect(r.nonEmptyToEmpty).toBe(1);
    expect(counterexampleGate('subset', r.nonEmptyToEmpty)).toBe(true);
  });

  it('is NOT satisfied by the empty-count comparison it is often confused with', () => {
    // `emptyWide <= emptyNarrow` does not establish monotonicity: two prompts moving
    // OFF empty hide one moving ONTO it. Here 2 move off, 1 moves on, so the aggregate
    // improves while a real counterexample exists.
    const r = compare(DB, prompts('a', 'b', 'c'),
      arm({ a: [], b: [], c: [9] }),
      arm({ a: [1], b: [2], c: [] }));
    expect(r.emptyWide).toBeLessThan(r.emptyNarrow);   // the reassuring aggregate
    expect(r.nonEmptyToEmpty).toBe(1);                 // the refutation it hides
  });

  it('reports zero when the wide arm really is a superset', () => {
    const r = compare(DB, prompts('q1', 'q2'),
      arm({ q1: [1], q2: [] }),
      arm({ q1: [1, 2], q2: [5] }));
    expect(r.nonEmptyToEmpty).toBe(0);
    expect(counterexampleGate('subset', r.nonEmptyToEmpty)).toBe(false);
  });
});

describe('monotonicity has THREE states, and only one of them is a test', () => {
  const shipped = { same: 30, cross: 15 };
  it('classifies subset / superset / mixed', () => {
    expect(monotonicityState({ baselineSame: 10, baselineCross: 5 }, shipped)).toBe('subset');
    expect(monotonicityState({ baselineSame: 30, baselineCross: 50 }, shipped)).toBe('superset');
    expect(monotonicityState({ baselineSame: 10, baselineCross: 50 }, shipped)).toBe('mixed');
  });

  it('suppresses the gate in BOTH non-subset states', () => {
    // 51 real counterexamples appear under a mixed config on the whole corpus.
    // Suppressing there is correct; labelling them "twin is wider" was not.
    expect(counterexampleGate('superset', 51)).toBe(false);
    expect(counterexampleGate('mixed', 51)).toBe(false);
  });

  it('gives mixed its own note rather than borrowing the superset one', () => {
    expect(MONOTONICITY_NOTE.mixed).not.toBe(MONOTONICITY_NOTE.superset);
    expect(MONOTONICITY_NOTE.mixed).toMatch(/narrower in one arm and wider in the other/);
    expect(MONOTONICITY_NOTE.subset).toMatch(/exits 1 if > 0/);
  });
});

describe('argument validation: the NaN hole', () => {
  it('rejects everything that produces a NaN pool', () => {
    // `LIMIT NaN` returns no rows, so the narrow arm delivers zero and the run reports
    // "100% of retrieving prompts changed set" — a complete, exit-0, conclusive-LOOKING
    // report whose every number is meaningless.
    for (const bad of [Number('foo'), Number(''), 0, -1, 1.5, Infinity]) {
      expect(validatePoolArg(bad), `accepted ${bad}`).toBe(false);
    }
    for (const good of [1, 5, 30, 5000]) expect(validatePoolArg(good)).toBe(true);
  });
});

describe('costCompare refuses to report a ratio it cannot measure', () => {
  it('THROWS when every timed call throws', () => {
    const boom = () => { throw new Error('nope'); };
    expect(() => costCompare(DB, prompts('q1'), boom, boom))
      .toThrow(/no cost measurement exists/);
  });

  it('commits both arms or neither — a throwing wide arm leaves no orphan narrow time', () => {
    // The bias review N7 caught: incrementing the denominator after both calls left the
    // narrow arm's time in the numerator with no matching denominator.
    const good = arm({ q1: [1], q2: [2] });
    const halfBroken = (_db, text) => { if (text === 'q2') throw new Error('nope'); return [{ id: 1 }]; };
    const c = costCompare(DB, prompts('q1', 'q2'), good, halfBroken);
    expect(c.threw).toBe(2);   // q2 throws on both passes
    expect(c.n).toBe(2);       // q1 commits on both passes
    expect(Number.isFinite(c.ratio)).toBe(true);
  });
});

// ─── self-check 5: the SECOND sink ────────────────────────────────────────────
//
// v3.90.0's release note is titled "the ruler ran at the read, then wrote to the thing it
// was measuring", and it fixed that shape in lib/patha-exclude-meter.mjs. The same shape
// was alive in THIS file the whole time and the guard above could not see it: a readonly
// database handle blocks the `injection_count` UPDATE and says nothing about
// `recordMetric`'s appendFileSync. A whole-corpus run with CLAUDE_MEM_METRICS=1 appended
// ~1.5M `inject` rows in one day. The four checks pinned below this line all existed; the
// sink they did not cover is the one that fired.
describe('self-check 5: the metric sink is shut, and the guard can see it open', () => {
  const withTmp = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'rerank-sink-test-'));
    try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('callArm passes the shipped counterfactual option — the whole fix, in one place', () => {
    let seen;
    callArm((...args) => { seen = args; return []; }, 'DB', 'text', 'proj');
    expect(seen[4]).toEqual({ counterfactual: true });
  });

  it('passes when the probe reaches the emit path and writes nothing', () => {
    withTmp((dir) => {
      expect(() => assertNoMetricWrite(metricShardPath(dir), () => true)).not.toThrow();
    });
  });

  it('THROWS when the probe appends a metric row — the guard can see the harm', () => {
    // The mutation this exists for is deleting `{ counterfactual: true }` from callArm.
    // That cannot be simulated without a live corpus, so the probe stands in for it by
    // doing what an unflagged call does: appending one row to the watched shard. If the
    // guard silently watched the wrong filename (its other failure mode) this stays green
    // for the wrong reason — which is why the shard name comes from recordMetric itself.
    withTmp((dir) => {
      expect(() => assertNoMetricWrite(metricShardPath(dir), () => {
        recordMetric(dir, { event: 'inject', durationMs: 1 });
        return true;
      })).toThrow(/grew .*bytes/);
    });
  });

  it('THROWS when the probe never reached the metric block — no vacuous pass', () => {
    // searchRelevantMemories returns above its metric block for short prompts and for
    // queries that sanitize to nothing. A probe on one of those writes nothing whatever
    // the flag says, so "the shard did not grow" would certify a sink never approached.
    withTmp((dir) => {
      expect(() => assertNoMetricWrite(metricShardPath(dir), () => false)).toThrow(/never reached the metric block/);
    });
  });

  it('leaves CLAUDE_MEM_METRICS exactly as it found it, on both paths', () => {
    // The guard forces the sink ON so it cannot pass merely because metrics are disabled.
    // Leaking that into the rest of the process would turn the sink on for every later
    // call in the same run — the guard would then have created the condition it prevents.
    const original = process.env.CLAUDE_MEM_METRICS;
    try {
      delete process.env.CLAUDE_MEM_METRICS;
      withTmp((dir) => assertNoMetricWrite(metricShardPath(dir), () => true));
      expect('CLAUDE_MEM_METRICS' in process.env).toBe(false);

      process.env.CLAUDE_MEM_METRICS = '0';
      withTmp((dir) => {
        expect(() => assertNoMetricWrite(metricShardPath(dir), () => false)).toThrow();  // throwing path
      });
      expect(process.env.CLAUDE_MEM_METRICS).toBe('0');
    } finally {
      if (original === undefined) delete process.env.CLAUDE_MEM_METRICS;
      else process.env.CLAUDE_MEM_METRICS = original;
    }
  });

  it('the shard name is never derived here — it is read back off recordMetric', () => {
    // Review N2: the "watch a self-derived filename" mutation only kills if the derived
    // name is WRONG. A mutation that re-derived the CORRECT convention by hand would
    // survive every behavioural case while genuinely weakening the guard, because the
    // property is "the convention is never copied" — a property of the SOURCE. So pin it
    // there. (The mutation that was run used the literal `zzz-wrong.jsonl`, which is why
    // it killed; that is a weaker fact than this assertion.)
    const src = readFileSync(join(REPO, 'benchmark/rerank-pool-replay.mjs'), 'utf8');
    const body = src.slice(src.indexOf('export function metricShardPath'),
      src.indexOf('export function metricsDirSize'));
    expect(body).toContain('recordMetric(tmp');
    for (const forbidden of ['toISOString', 'getFullYear', 'getMonth', 'padStart', 'slice(0, 10)', 'slice(0,10)']) {
      expect(body, `metricShardPath derives the date itself via ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('metricShardPath names the file recordMetric actually writes', () => {
    withTmp((dir) => {
      const shard = metricShardPath(dir);
      const prev = process.env.CLAUDE_MEM_METRICS;
      process.env.CLAUDE_MEM_METRICS = '1';
      try { recordMetric(dir, { event: 'inject' }); }
      finally { if (prev === undefined) delete process.env.CLAUDE_MEM_METRICS; else process.env.CLAUDE_MEM_METRICS = prev; }
      // If this ever fails, the guard has been watching a file nothing writes — the exact
      // vacuous pass the throwaway-dir design exists to prevent.
      expect(existsSync(shard)).toBe(true);
      expect(statSync(shard).size).toBeGreaterThan(0);
    });
  });

  it('metricShardPath does not leak CLAUDE_MEM_METRICS when mkdtemp throws', () => {
    // Review S2: the first version wrote the env var BEFORE mkdtempSync, so a throwing
    // mkdtemp (TMPDIR gone, ENOSPC, EACCES) skipped the finally and left ='1' set for the
    // rest of the process — the guard creating the condition its own comment warns about.
    const original = process.env.CLAUDE_MEM_METRICS;
    const originalTmp = process.env.TMPDIR;
    try {
      delete process.env.CLAUDE_MEM_METRICS;
      process.env.TMPDIR = join(REPO, 'no', 'such', 'dir', 'anywhere');
      for (const fn of [() => metricShardPath('/nope'), () => assertNoMetricWrite('/nope/x.jsonl', () => true)]) {
        try { fn(); } catch { /* expected: ENOENT from mkdtemp */ }
        expect('CLAUDE_MEM_METRICS' in process.env).toBe(false);
      }
    } finally {
      if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
      if (original === undefined) delete process.env.CLAUDE_MEM_METRICS; else process.env.CLAUDE_MEM_METRICS = original;
    }
  });

  it('the RUN-level gate sees growth the helper-level probe structurally cannot', () => {
    // Review S1, and the reason this gate exists at all. `assertNoMetricWrite` proves that
    // `callArm` is clean; that every invocation GOES through callArm was left to a source
    // regex, and four bypasses defeat it (aliasing the handle, `.call()`, aliasing the fn
    // inside the timer, a new exported helper). One of them, replayed over 300 real
    // prompts, appended 992 metric rows with the suite green and the run exiting 0. A
    // whole-directory before/after cannot be defeated by call form.
    withTmp((dir) => {
      const before = metricsDirSize(dir);
      expect(before).toBe(0);                       // premise: nothing there yet
      expect(runLevelGrowth(dir, before)).toBe(0);  // and the gate agrees
      const prev = process.env.CLAUDE_MEM_METRICS;
      process.env.CLAUDE_MEM_METRICS = '1';
      try { recordMetric(dir, { event: 'inject', durationMs: 1 }); }
      finally { if (prev === undefined) delete process.env.CLAUDE_MEM_METRICS; else process.env.CLAUDE_MEM_METRICS = prev; }
      expect(runLevelGrowth(dir, before)).toBeGreaterThan(0);
    });
  });

  it('metricsDirSize counts every shard, not just today - the day-rollover hole', () => {
    // Review N7: a run started at 23:59 writes into TOMORROW's shard, so a one-shard
    // baseline misses every row of it. Summing the directory closes that by construction.
    withTmp((dir) => {
      mkdirSync(join(dir, 'metrics'), { recursive: true });
      writeFileSync(join(dir, 'metrics', '2026-09-01.jsonl'), 'a\n');
      const before = metricsDirSize(dir);
      writeFileSync(join(dir, 'metrics', '2026-09-02.jsonl'), 'bbbb\n');
      expect(runLevelGrowth(dir, before)).toBe(5);
    });
  });

  it('every arm invocation in the benchmark goes through callArm', () => {
    // The guard runs its probe through callArm, so a call site that bypassed callArm
    // would keep the guard green while writing on every prompt — a guard testing a proxy
    // instead of the harm. This is a text check over ONE file and is only that: it pins
    // the call form, not the semantics, which is what the cases above are for.
    const src = readFileSync(join(REPO, 'benchmark/rerank-pool-replay.mjs'), 'utf8');
    expect(src.match(/\b(?:narrow|wide)\(\s*db\b/g)).toBe(null);
    expect(src.match(/\bfn\(\s*db\b/g)).toHaveLength(1);   // callArm's own body, and only it
  });
});
