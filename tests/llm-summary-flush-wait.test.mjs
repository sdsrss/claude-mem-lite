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
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
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
    expect(existsSync(orphan), 'the summary must not delete another worker\'s file').toBe(true);
  });

  it('DOES wait on a fresh flush file, then stops when it disappears', async () => {
    // The behaviour that must survive the fix: a real in-flight flush still blocks, or the
    // summary reads the DB before the episode worker has written to it.
    const fresh = flushFile('ep-flush-2-live.json');
    setTimeout(() => { try { rmSync(fresh); } catch { /* ignore */ } }, 1200);
    const elapsed = await timeSummary();
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(3000);
  });

  it('ignores a flush file that appears AFTER it started waiting', async () => {
    // Another project's Stop, mid-wait. Under the old dir-wide predicate this extended the
    // wait for work this summary will never read. The set is snapshotted at entry, so a
    // latecomer is somebody else's.
    const fresh = flushFile('ep-flush-3-mine.json');
    setTimeout(() => { try { rmSync(fresh); } catch { /* ignore */ } }, 1100);
    setTimeout(() => flushFile('ep-flush-4-someone-else.json'), 1150);
    const elapsed = await timeSummary();
    expect(elapsed).toBeLessThan(3000);
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
