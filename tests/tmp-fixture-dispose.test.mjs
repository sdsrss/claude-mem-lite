// D#2. Guards `disposeFixtureDir` in tests/test-helpers.mjs.
//
// What the helper is for is written up at its definition; the short version is that the
// four leaking suites all HAD an afterEach, and the 11 dirs one run left behind came from
// disposing the wrong path (9) and from a detached worker recreating the data dir after a
// successful removal (2, sweeper-absorbed by adjudication).
//
// The reporting branch is the case worth guarding hardest: a bare `catch {}` is what let
// this run green for months, so the helper must stay loud.
//
// Each case can say NO: dropping `maxRetries` reds the first, dropping the `console.warn`
// reds the third, dropping the nullish guard reds the fourth. Mutation-verified against
// all four.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { disposeFixtureDir, makeFixtureTracker } from './test-helpers.mjs';

describe('disposeFixtureDir', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks rmSync to retry rather than accepting its zero-retry default', () => {
    // Defensive, not the fix for either measured cause: `force: true` suppresses ENOENT
    // only, and rmSync's default retry count is 0, so a fixture tree that is briefly busy
    // fails on the first pass with nothing to catch it. Pinned so the option cannot be
    // dropped as "unused" by someone reading only the two measured causes.
    const calls = [];
    const ok = disposeFixtureDir('/probe/never-touched', {
      rm: (p, o) => {
        calls.push([p, o]);
      },
    });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/probe/never-touched');
    expect(calls[0][1].recursive).toBe(true);
    expect(calls[0][1].force).toBe(true);
    expect(calls[0][1].maxRetries).toBeGreaterThanOrEqual(5);
    expect(calls[0][1].retryDelay).toBeGreaterThan(0);
  });

  it('removes a populated fixture tree for real', () => {
    const root = mkdtempSync(join(tmpdir(), 'mem-dispose-probe-'));
    mkdirSync(join(root, 'work', 'fresh'), { recursive: true });
    mkdirSync(join(root, '.claude-mem-lite', 'runtime'), { recursive: true });
    writeFileSync(join(root, '.claude-mem-lite', 'claude-mem-lite.db'), 'x'.repeat(1024));

    expect(existsSync(root)).toBe(true);
    expect(disposeFixtureDir(root)).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it('reports the directory it could not remove instead of swallowing the error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = disposeFixtureDir('/probe/undeletable', {
      rm: () => {
        const err = new Error('directory not empty');
        err.code = 'ENOTEMPTY';
        throw err;
      },
    });

    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0];
    expect(msg).toContain('/probe/undeletable');
    expect(msg).toContain('ENOTEMPTY');
  });

  it('is a no-op when the fixture variable was never assigned', () => {
    // A beforeEach that throws before its mkdtempSync leaves the variable undefined,
    // and the afterEach still runs. Passing that through to rmSync throws
    // ERR_INVALID_ARG_TYPE and masks the real failure.
    const calls = [];
    const rm = (p) => calls.push(p);

    expect(disposeFixtureDir(undefined, { rm })).toBe(true);
    expect(disposeFixtureDir(null, { rm })).toBe(true);
    expect(disposeFixtureDir('', { rm })).toBe(true);
    expect(calls).toEqual([]);
  });
});

// D#2, RECREATION half. `disposeFixtureDir` above serves the afterEach; this serves the
// afterAll, and the difference is not stylistic — measured 2026-09-07 on v5.3.0, the
// afterEach's rmSync threw zero times in 71 invocations and existsSync was false right
// after every one, yet 12 of those paths were back by the end of the file. Retrying the
// afterEach is the fix that measures zero; disposing again later is the one that works.
describe('makeFixtureTracker', () => {
  it('returns the tracked path so a creation call can be wrapped inline', () => {
    // `tmpHome = fixtures.track(mkdtempSync(...))` is the whole calling convention. A
    // tracker that swallowed its argument would silently hand every suite `undefined`.
    const fixtures = makeFixtureTracker();
    expect(fixtures.track('/probe/some-dir')).toBe('/probe/some-dir');
  });

  it('disposes a directory that was recreated after an earlier removal', () => {
    // The measured D#2 shape, reproduced without a subprocess: dispose, let something
    // recreate the data dir underneath, and the tracker must still clear it at file end.
    const fixtures = makeFixtureTracker();
    const root = mkdtempSync(join(tmpdir(), 'mem-tracker-probe-'));
    fixtures.track(root);

    disposeFixtureDir(root);
    expect(existsSync(root)).toBe(false);

    // A detached worker resolving its data dir against the HOME it was handed.
    mkdirSync(join(root, '.claude-mem-lite', 'runtime'), { recursive: true });
    writeFileSync(join(root, '.claude-mem-lite', 'claude-mem-lite.db'), 'x'.repeat(256));
    expect(existsSync(root)).toBe(true);

    expect(fixtures.disposeAll()).toBe(0);
    expect(existsSync(root)).toBe(false);
  });

  it('empties its list, so a second disposal pass cannot re-delete a reused path', () => {
    // `splice(0)` rather than a plain iteration. Without it the list grows across every
    // call and a later run of the same tracker would delete paths it no longer owns.
    const fixtures = makeFixtureTracker();
    const first = mkdtempSync(join(tmpdir(), 'mem-tracker-probe-'));
    fixtures.track(first);
    expect(fixtures.disposeAll()).toBe(0);

    // Recreate the SAME path and dispose again with nothing tracked: it must survive.
    mkdirSync(first, { recursive: true });
    expect(fixtures.disposeAll()).toBe(0);
    expect(existsSync(first)).toBe(true);
    rmSync(first, { recursive: true, force: true });
  });

  it('counts the directories it could not remove instead of reporting a clean sweep', () => {
    // Drives the real failure path — a parent with no write bit gives rmSync EACCES —
    // because a tracker that always returns 0 is indistinguishable from one that works.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parent = mkdtempSync(join(tmpdir(), 'mem-tracker-locked-'));
    const child = join(parent, 'child');
    mkdirSync(child, { recursive: true });
    const fixtures = makeFixtureTracker();
    fixtures.track(child);

    try {
      chmodSync(parent, 0o500); // r-x: child cannot be unlinked
      expect(fixtures.disposeAll()).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(child);
    } finally {
      chmodSync(parent, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // NOT guarded here, deliberately: `track`'s `if (dir)` nullish check. Removing it leaves
  // all of the above green, because `disposeFixtureDir` no-ops on nullish itself — so a
  // test for it can only ever pass, and mutation-verifying it proved exactly that (M5,
  // 2026-09-07). The behaviour is covered by this file's fourth `disposeFixtureDir` case.
  // Re-adding an assertion here buys a case count, not a check.
});
