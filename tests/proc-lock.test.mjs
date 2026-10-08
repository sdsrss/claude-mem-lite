import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  withLock,
  withLockAsync,
  LIVE_HOLDER_MAX_MS,
  lockDirBlocked,
  takeLock,
} from '../lib/proc-lock.mjs';

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

  it('steals a stale lock that records no pid (timestamp older than staleMs)', () => {
    const lock = join(tmp(), 'x.lock');
    // No pid, so only ts can make it stale — proves the ts path independently of the pid path.
    writeFileSync(lock, JSON.stringify({ ts: 1000 }));
    const release = acquireLock(lock, { staleMs: 60_000, now: () => 1_000_000 });
    expect(release).toBeTypeOf('function');
    release();
  });

  // D#294. An update holds install.lock through npm install (60 s) and its smoke gate (two
  // 120 s rebuilds, a 300 s source build, probes): about 12 minutes on a platform with no
  // prebuild, and a direct `install` runs npm with no timeout at all. The 5-min age steal took
  // the lock from that live holder, and the next entry replayed the running swap's journal.
  it('does NOT steal a lock whose holder is alive, however long past staleMs it has run (D#294)', () => {
    const lock = join(tmp(), 'x.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() - 6 * 60 * 1000 }));
    expect(acquireLock(lock)).toBeNull();
    writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() - 12 * 60 * 1000 }));
    expect(acquireLock(lock)).toBeNull();
    writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: 1000 }));
    expect(acquireLock(lock, { staleMs: 60_000, now: () => 1_000_000 })).toBeNull();
  });

  it('reclaims a live-pid lock past LIVE_HOLDER_MAX_MS: the pid may be recycled onto another process', () => {
    const lock = join(tmp(), 'x.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() - LIVE_HOLDER_MAX_MS - 60_000 }));
    const release = acquireLock(lock);
    expect(release).toBeTypeOf('function');
    release();
    // Premise: the bound is above the longest critical section a real holder runs, ~12 min.
    expect(LIVE_HOLDER_MAX_MS).toBeGreaterThan(30 * 60 * 1000);
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

// D#304, D#307. acquireLock answers null both for a live holder and for a lock it cannot create at
// all (a runtime dir a sudo run left root-owned, a read-only data dir), and every caller read null as
// "another install is in progress": updates skipped silently forever, install exited 0, cleanup
// named a lock that did not exist. lockDirBlocked is the read-only half that tells them apart.
describe('lockDirBlocked', () => {
  const asRoot = process.getuid?.() === 0;

  for (const mode of [0o555, 0o000])
    it.skipIf(asRoot)(`names a lock dir this user cannot write into (mode ${mode.toString(8)})`, () => {
      const rt = join(tmp(), 'runtime');
      mkdirSync(rt);
      chmodSync(rt, mode);
      try {
        const lock = join(rt, 'install.lock');
        expect(acquireLock(lock)).toBeNull(); // premise: acquire fails closed
        expect(lockDirBlocked(lock)).toEqual({ dir: rt, code: 'EACCES' });
      } finally {
        chmodSync(rt, 0o755);
      }
    });

  it('a lock dir that does not exist yet under a writable one is not blocked, and is not created', () => {
    const d = tmp();
    const lock = join(d, 'runtime', 'install.lock');
    expect(lockDirBlocked(lock)).toBeNull();
    expect(existsSync(join(d, 'runtime'))).toBe(false);
  });

  it.skipIf(asRoot)(
    'a missing lock dir under an unwritable one is blocked there: acquireLock cannot create it',
    () => {
      const d = tmp();
      chmodSync(d, 0o555);
      try {
        const lock = join(d, 'runtime', 'install.lock');
        expect(acquireLock(lock)).toBeNull(); // premise
        expect(lockDirBlocked(lock)).toEqual({ dir: d, code: 'EACCES' });
      } finally {
        chmodSync(d, 0o755);
      }
    },
  );

  it('a held lock in a writable dir is held, not blocked', () => {
    const lock = join(tmp(), 'install.lock');
    const release = acquireLock(lock);
    try {
      expect(lockDirBlocked(lock)).toBeNull();
    } finally {
      release();
    }
  });
});

// Review of D#304/D#307 (P2-1): an access() precheck predicts only the faults access() sees. A create
// that fails for any other reason (a dangling runtime link, a full disk, a Windows ACL access()
// does not read) still came back as a bare null, read as "held". takeLock reports the create's own
// errno; acquireLock keeps its release-or-null contract on top of it.
describe('takeLock', () => {
  const asRoot = process.getuid?.() === 0;

  it('takes a free lock, and reports a held one as held, not as an error', () => {
    const lock = join(tmp(), 'install.lock');
    const first = takeLock(lock);
    expect(typeof first.release).toBe('function');
    const second = takeLock(lock);
    expect(second.release).toBeUndefined();
    expect(second.error).toBeUndefined();
    first.release();
    expect(existsSync(lock)).toBe(false);
  });

  it.skipIf(asRoot)('reports the directory and errno of a create that fails', () => {
    const rt = join(tmp(), 'runtime');
    mkdirSync(rt);
    chmodSync(rt, 0o555);
    try {
      expect(takeLock(join(rt, 'install.lock'))).toEqual({ error: { dir: rt, code: 'EACCES' } });
    } finally {
      chmodSync(rt, 0o755);
    }
  });

  it('reports a lock dir that is a link to nowhere, which access() alone reads as absent', () => {
    const d = tmp();
    const rt = join(d, 'runtime');
    symlinkSync(join(d, 'gone', 'runtime'), rt);
    const lock = join(rt, 'install.lock');
    expect(takeLock(lock).error?.dir).toBe(rt);
    expect(lockDirBlocked(lock)).toEqual({ dir: rt, code: 'ENOENT' });
  });
});

describe('lockDirBlocked names the directory that has to change', () => {
  it.skipIf(process.getuid?.() === 0)('an ancestor that cannot be entered, not the lock dir under it', () => {
    const data = join(tmp(), 'data');
    mkdirSync(join(data, 'runtime'), { recursive: true });
    chmodSync(data, 0o000);
    try {
      expect(lockDirBlocked(join(data, 'runtime', 'install.lock'))).toEqual({ dir: data, code: 'EACCES' });
    } finally {
      chmodSync(data, 0o755);
    }
  });
});
