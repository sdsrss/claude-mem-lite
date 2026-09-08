// Audit 2026-09-02 P1-7: `handleLLMSummary` waited for `readdirSync(RUNTIME_DIR)` to hold no
// `ep-flush-*` file at all — a condition about the WHOLE MACHINE, checked by a worker that
// only cares about its own session's flushes.
//
// Two unbounded consequences, and the first is the expensive one: a single crashed
// llm-episode worker leaves a flush file nothing deletes, so from then on EVERY project's
// summary burns the full timeout on EVERY Stop until a maintain run sweeps it — and orphan
// cleanup sits behind a 24 h gate. The second: an unrelated project flushing while this
// summary waits extends the wait, for work this summary will never read.
//
// The fix is a defined set snapshotted at entry, filtered to files young enough to belong to
// a live worker. These cases drive the real `handleLLMSummary` and measure the thing that
// actually went wrong — elapsed time — rather than asserting on the shape of the filter.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let root;
let runtimeDir;

// The wait loop sleeps FIRST and checks AFTER (`await sleep(1000)` then filter,
// hook-llm.mjs:1343-1345), so it only ever moves in whole 1000 ms ticks: a file removed at
// 1.1 s is first observed gone on the SECOND tick, at ~2.0 s. Every bound below is stated in
// ticks for that reason — a bound placed between two adjacent ticks is a coin flip, not a
// test.
const POLL_MS = 1000;

/**
 * Timeout for the two cases that assert "did not burn the timeout", and the bound they use.
 *
 * These two used the 3 s default, which left them exactly ONE tick of margin: a correct run
 * lands at ~2 s and the ceiling was 3 s. Measured 2026-09-08 on an idle machine, 6/6 runs
 * read 2013-2018 ms — 982-987 ms of headroom. Delaying the removal timer by a single tick,
 * which is what a loaded runner does to a `setTimeout`, put 6/6 runs at 3013-3032 ms and
 * reproduced `expected 3022 to be less than 3000` — the failure that turned v6.0.0's Release
 * validate job red AFTER the tag had been pushed.
 *
 * 8 s with a 5-tick bound instead. A correct run still exits on tick 2, so the bound sits 3
 * ticks above the expected value; a dir-wide predicate waits on the latecomer for all 8,
 * so it sits 3 ticks below the broken one. Symmetric, and both halves are a tick count
 * rather than a tuned millisecond. Raising the timeout costs no suite time in the green
 * case — a correct run exits when ITS file clears, not when the timeout expires.
 */
const SLOW_TIMEOUT_S = 8;
const NOT_BURNED_MS = 5 * POLL_MS;

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'mem-flushwait-'));
  runtimeDir = join(root, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  process.env.CLAUDE_MEM_DIR = root;
  // 3s rather than the 15s default: every case here asserts on elapsed time, and the
  // difference between "waited" and "did not wait" has to be legible without a 15s test.
  process.env.CLAUDE_MEM_FLUSH_TIMEOUT = '3';
});

afterEach(() => {
  delete process.env.CLAUDE_MEM_FLUSH_TIMEOUT;
  delete process.env.CLAUDE_MEM_DIR;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Write a flush file and backdate it by `ageMs`. */
function flushFile(name, ageMs = 0) {
  const p = join(runtimeDir, name);
  writeFileSync(p, '{}');
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(p, t, t);
  }
  return p;
}

/** Import a fresh handleLLMSummary bound to this test's RUNTIME_DIR, and time one run. */
async function timeSummary() {
  const { handleLLMSummary } = await import('../hook-llm.mjs');
  const t0 = Date.now();
  await handleLLMSummary();
  return Date.now() - t0;
}

describe('handleLLMSummary flush wait', () => {
  it('does not wait at all when no flush file exists (premise)', async () => {
    // Establishes the floor the other cases are measured against. Without it, "the orphan
    // case returned fast" could equally mean the function bailed for an unrelated reason.
    expect(await timeSummary()).toBeLessThan(1000);
  });

  it('does not wait on an ORPHANED flush file left by a crashed worker', async () => {
    // The defect. This file is older than ORPHAN_EPISODE_AGE_MS (1h), so no live worker
    // owns it; the old predicate could not tell it from work in progress and burned the
    // whole timeout — on every project, every Stop, for up to a day.
    const orphan = flushFile('ep-flush-1-orphan.json', 2 * 60 * 60 * 1000);
    expect(existsSync(orphan), 'premise: the orphan file exists').toBe(true);
    expect(await timeSummary()).toBeLessThan(1000);
    // And it is left alone — reclaiming it is the orphan sweep's job, not this worker's.
    expect(existsSync(orphan), "the summary must not delete another worker's file").toBe(true);
  });

  it('DOES wait on a fresh flush file, then stops when it disappears', async () => {
    // The behaviour that must survive the fix: a real in-flight flush still blocks, or the
    // summary reads the DB before the episode worker has written to it.
    process.env.CLAUDE_MEM_FLUSH_TIMEOUT = String(SLOW_TIMEOUT_S);
    const fresh = flushFile('ep-flush-2-live.json');
    setTimeout(() => {
      try {
        rmSync(fresh);
      } catch {
        /* ignore */
      }
    }, 1200);
    const elapsed = await timeSummary();
    // Lower bound: it really waited. Removal is a tick in, so at least one tick must pass —
    // an implementation that skipped the wait entirely reads ~10 ms here.
    expect(elapsed).toBeGreaterThanOrEqual(POLL_MS);
    // Upper bound: it stopped when the file went, rather than burning SLOW_TIMEOUT_S.
    expect(elapsed).toBeLessThan(NOT_BURNED_MS);
  });

  it('ignores a flush file that appears AFTER it started waiting', async () => {
    // Another project's Stop, mid-wait. Under the old dir-wide predicate this extended the
    // wait for work this summary will never read. The set is snapshotted at entry, so a
    // latecomer is somebody else's.
    process.env.CLAUDE_MEM_FLUSH_TIMEOUT = String(SLOW_TIMEOUT_S);
    const fresh = flushFile('ep-flush-3-mine.json');
    setTimeout(() => {
      try {
        rmSync(fresh);
      } catch {
        /* ignore */
      }
    }, 1100);
    setTimeout(() => flushFile('ep-flush-4-someone-else.json'), 1150);
    const elapsed = await timeSummary();
    expect(elapsed).toBeLessThan(NOT_BURNED_MS);
    // Premise: the latecomer really is still on disk, so "finished early" is not just
    // "the file was gone anyway".
    expect(existsSync(join(runtimeDir, 'ep-flush-4-someone-else.json'))).toBe(true);
  });

  it('gives up after the timeout rather than hanging on a file that never clears', async () => {
    flushFile('ep-flush-5-stuck.json');
    const elapsed = await timeSummary();
    expect(elapsed).toBeGreaterThanOrEqual(3000);
    expect(elapsed).toBeLessThan(6000);
  });
});
