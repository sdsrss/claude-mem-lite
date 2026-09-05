import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, withLock, withLockAsync } from '../lib/proc-lock.mjs';

const dirs = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'proc-lock-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop(), { recursive: true, force: true });
    } catch {}
  }
});

describe('proc-lock', () => {
  it('acquires, blocks a second acquire, then re-acquires after release', () => {
    const lock = join(tmp(), 'x.lock');
    const release = acquireLock(lock);
    expect(release).toBeTypeOf('function');
    expect(existsSync(lock)).toBe(true);

    // A live peer holds it → second acquire fails.
    expect(acquireLock(lock)).toBeNull();

    release();
    expect(existsSync(lock)).toBe(false);

    const again = acquireLock(lock);
    expect(again).toBeTypeOf('function');
    again();
  });

  it('release is idempotent', () => {
    const lock = join(tmp(), 'x.lock');
    const release = acquireLock(lock);
    release();
    expect(() => release()).not.toThrow();
    expect(existsSync(lock)).toBe(false);
  });

  it('steals a stale lock (timestamp older than staleMs)', () => {
    const lock = join(tmp(), 'x.lock');
    // Holder recorded far in the past, but pid is OUR live pid so only ts can
    // make it stale — proves the ts path independently of the pid path.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: 1000 }));
    const release = acquireLock(lock, { staleMs: 60_000, now: () => 1_000_000 });
    expect(release).toBeTypeOf('function');
    release();
  });

  it('steals a lock whose holder pid is dead', () => {
    const lock = join(tmp(), 'x.lock');
    // pid 2^31-1 is effectively never a live process; ts is "now" so only the
    // dead-pid path can reclaim it.
    writeFileSync(lock, JSON.stringify({ pid: 2147483646, ts: Date.now() }));
    const release = acquireLock(lock);
    expect(release).toBeTypeOf('function');
    release();
  });

  it('does NOT steal a fresh lock held by a live pid', () => {
    const lock = join(tmp(), 'x.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    expect(acquireLock(lock)).toBeNull();
  });

  it('reclaims an unparseable lock file', () => {
    const lock = join(tmp(), 'x.lock');
    writeFileSync(lock, 'not json at all');
    const release = acquireLock(lock);
    expect(release).toBeTypeOf('function');
    release();
  });

  it('withLock runs fn while held and releases after', () => {
    const lock = join(tmp(), 'x.lock');
    let sawHeldDuringFn = null;
    const out = withLock(lock, () => {
      sawHeldDuringFn = acquireLock(lock); // should be null — we hold it
      return 42;
    });
    expect(out).toEqual({ acquired: true, result: 42 });
    expect(sawHeldDuringFn).toBeNull();
    expect(existsSync(lock)).toBe(false); // released
  });

  it('withLock no-ops (acquired:false) when a peer holds the lock', () => {
    const lock = join(tmp(), 'x.lock');
    const release = acquireLock(lock);
    const out = withLock(lock, () => {
      throw new Error('must not run');
    });
    expect(out).toEqual({ acquired: false });
    release();
  });

  it('withLock releases even when fn throws', () => {
    const lock = join(tmp(), 'x.lock');
    expect(() =>
      withLock(lock, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(lock)).toBe(false);
  });

  it('withLockAsync awaits fn and releases', async () => {
    const lock = join(tmp(), 'x.lock');
    const out = await withLockAsync(lock, async () => 'done');
    expect(out).toEqual({ acquired: true, result: 'done' });
    expect(existsSync(lock)).toBe(false);
  });
});
