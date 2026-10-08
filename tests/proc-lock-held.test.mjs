// lockHeld (lib/proc-lock.mjs) answers what acquireLock would do, without creating anything. A lock
// released between its lstat and its read must read as free, as acquireLock would then take it
// (pre-ship delta review N1). node:fs is wrapped so the release lands in exactly that gap.
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ctl = { releaseOnRead: null };
globalThis.__lockHeldCtl = ctl;
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    readFileSync(p, o) {
      const c = globalThis.__lockHeldCtl;
      if (c.releaseOnRead && String(p) === c.releaseOnRead) {
        c.releaseOnRead = null;
        real.unlinkSync(String(p)); // the holder releases right after lockHeld's lstat
      }
      return real.readFileSync(p, o);
    },
  };
});

const { lockHeld } = await import('../lib/proc-lock.mjs');
const dirs = [];
afterEach(() => {
  ctl.releaseOnRead = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('lockHeld', () => {
  it('a lock released between its lstat and its read is free', () => {
    const d = mkdtempSync(join(tmpdir(), 'lock-held-'));
    dirs.push(d);
    const lock = join(d, 'install.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    expect(lockHeld(lock)).toBe(true); // premise: a live holder is held
    ctl.releaseOnRead = lock;
    expect(lockHeld(lock)).toBe(false);
    expect(ctl.releaseOnRead).toBeNull(); // premise: the release landed in the gap
  });
});
