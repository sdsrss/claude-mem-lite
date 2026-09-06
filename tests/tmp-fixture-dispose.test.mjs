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
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { disposeFixtureDir } from './test-helpers.mjs';

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
