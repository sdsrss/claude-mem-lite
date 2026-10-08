// lib/proc-lock.mjs — best-effort inter-process advisory lock (O_EXCL file).
//
// Why: multiple Claude Code sessions can fire SessionStart hooks (and their
// self-heal / auto-update write paths) at the same instant. install(),
// install.mjs repair, and hook-update.installExtractedRelease all rename source
// files into the live install dir; two of them interleaving produces a torn /
// mixed-version install (server vN + hook vN+1). The launcher's 6h cooldown
// only RATE-LIMITS re-spawns — it is not mutual exclusion (two processes can
// both observe "no recent attempt" and both spawn). This gives the write paths
// a real cross-process gate.
//
// Semantics: acquireLock() atomically creates the lock file with O_EXCL. If it
// already exists it is stolen only when STALE: the recorded pid is provably dead on
// this host, or the lock is older than LIVE_HOLDER_MAX_MS (staleMs when it records no
// pid). A live holder → acquire returns null and the caller no-ops (someone else is
// already doing the write). Release unlinks the file. Crash-safe: a crashed holder's
// pid is gone, so the next session reclaims its lock at once.

import {
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  renameSync,
  linkSync,
  lstatSync,
  accessSync,
  constants as fsConstants,
} from 'node:fs';
import { dirname } from 'node:path';
import { workerDirGone } from './worker-data-dir.mjs';

// The age bound for a lock whose holder cannot be checked: it records no pid. A holder that
// records one is reclaimed at once when the pid is gone, and otherwise waits for
// LIVE_HOLDER_MAX_MS below.
const DEFAULT_STALE_MS = 5 * 60 * 1000;

// Age past which a lock whose recorded pid is ALIVE is reclaimed anyway: by then that pid is
// taken to be recycled onto an unrelated process, or to belong to another host on a shared
// homedir. It is not a bound on the critical section, which has none: an update holds
// install.lock through npm install and a smoke gate that can rebuild the binding twice and from
// source (about 12 min in all), and a direct `install` runs npm with no timeout. staleMs used to
// apply to a live holder too, so the next entry took the lock after 5 min and replayed the
// running swap's journal (D#294). hook.mjs's lock sweeper spares a live holder for the same span.
export const LIVE_HOLDER_MAX_MS = 60 * 60 * 1000;

function pidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    // Signal 0 = existence check, no signal delivered. EPERM means the process
    // exists but is owned by another user (still "alive" for our purposes).
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function isStale(lockPath, staleMs, now) {
  try {
    const { pid, ts } = JSON.parse(readFileSync(lockPath, 'utf8'));
    const aged = (bound) => typeof ts === 'number' && now() - ts > bound;
    if (typeof pid !== 'number') return aged(staleMs);
    // Same-host fast reclaim: holder pid is gone. Cross-host (shared homedir) the pid is
    // meaningless, and a live-looking one is reclaimed by age below.
    if (!pidAlive(pid)) return true;
    return aged(Math.max(staleMs, LIVE_HOLDER_MAX_MS));
  } catch {
    return true; // unparseable / unreadable lock → treat as stale and reclaim
  }
}

/**
 * Create `lockPath` with `payload`, atomically and never visible EMPTY.
 * @returns {'ok'|'exists'|'error'}
 *
 * R10 P1-7, second defect. `writeFileSync(path, data, { flag: 'wx' })` is two syscalls:
 * O_CREAT|O_EXCL makes the file, the write fills it. A peer that reads in between gets an
 * empty string — and isStale() treats an unparseable lock as stale, by design, so it stole
 * a lock whose owner was mid-create and already believed it held it. Both then held it.
 * Instrumented under load: one stealer's `sampled` was literally "".
 *
 * Fix: fill a private temp first, then link() it into place. link() is atomic and fails
 * EEXIST exactly like O_EXCL, but the name only ever appears with its full contents. The
 * temp carries a `.lock` suffix so hook.mjs's sweeper reclaims it if we die in between.
 * Filesystems without hard links (some network / FAT mounts) fall back to the old form —
 * they keep the narrow window, which is still better than never acquiring a lock at all.
 *
 * A failure is returned as the errno, so a caller can say why the lock cannot be taken.
 */
function createExclusive(lockPath, payload) {
  const tmp = `${lockPath}.new-${process.pid}-${Math.random().toString(36).slice(2)}.lock`;
  try {
    writeFileSync(tmp, payload, { flag: 'wx' });
  } catch (e) {
    return { error: e.code || 'EIO' };
  }
  try {
    linkSync(tmp, lockPath);
    return 'ok';
  } catch (e) {
    if (e.code === 'EEXIST') return 'exists';
    // No hard-link support: fall back to the single-call form.
    try {
      writeFileSync(lockPath, payload, { flag: 'wx' });
      return 'ok';
    } catch (e2) {
      return e2.code === 'EEXIST' ? 'exists' : { error: e2.code || 'EIO' };
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
  }
}

function makeRelease(lockPath, payload) {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    try {
      // Only remove OUR OWN lock. A release that unlinks whatever is at the path can hand
      // the lock to a third process when a stale-steal has already replaced the file —
      // the same class of bug as the steal race below, one step later.
      if (readFileSync(lockPath, 'utf8') !== payload) return;
      unlinkSync(lockPath);
    } catch {
      /* already gone — fine */
    }
  };
}

/**
 * Try to acquire an advisory lock. Non-blocking.
 * @param {string} lockPath  Absolute path to the lock file.
 * @param {object} [opts]
 * @param {number} [opts.staleMs]  Age after which a lock that records no pid is stolen. A live pid
 *   holds it until LIVE_HOLDER_MAX_MS, or staleMs if that is longer.
 * @param {() => number} [opts.now]  Clock injection seam (tests).
 * @returns {(() => void)|null}  A release() fn, or null if a live peer holds it, the lock file
 *   could not be created, or this is a background worker whose lock directory was removed.
 */
export function acquireLock(lockPath, opts) {
  return takeLock(lockPath, opts).release || null;
}

/**
 * acquireLock, saying why when it does not take the lock. acquireLock's null stands both for a
 * live holder and for a lock file that cannot be created at all, and every installer read that
 * null as "another install is in progress": with a runtime dir a `sudo` run left root-owned, a
 * read-only data dir, a runtime link to nowhere or a full disk, every update skipped silently and
 * install exited 0 having done nothing (D#304, D#307). The errno here is the failed create's own,
 * so it holds for every cause, including the ones lockDirBlocked's access() check cannot predict
 * (a Windows ACL, ENOSPC).
 * @returns {{release: () => void} | {error: {dir: string, code: string}} | {}} {} when a live peer
 *   holds it, or this is a background worker whose lock directory was removed.
 */
export function takeLock(lockPath, { staleMs = DEFAULT_STALE_MS, now = Date.now } = {}) {
  const failed = (code) => ({ error: lockDirBlocked(lockPath) || { dir: dirname(lockPath), code } });
  // A background worker (auto-maintain takes its lock in the runtime dir) does not re-create a
  // directory removed while it ran (D#265). Not taking the lock is the caller's no-op path.
  if (workerDirGone(dirname(lockPath))) return {};
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    /* best-effort */
  }
  // `nonce` makes the payload identify THIS acquisition, not just this process: two
  // acquires from one pid inside the same millisecond would otherwise be indistinguishable,
  // and release() below compares payloads. isStale() and hook.mjs's lock sweeper read only
  // `pid` and `ts`, so the extra field is inert to both.
  const payload = JSON.stringify({
    pid: process.pid,
    ts: now(),
    nonce: Math.random().toString(36).slice(2),
  });
  const first = createExclusive(lockPath, payload);
  if (first === 'ok') return { release: makeRelease(lockPath, payload) };
  if (first.error) return failed(first.error); // permission / fs error → fail closed, and say why
  {
    let sampled;
    try {
      sampled = readFileSync(lockPath, 'utf8');
    } catch {
      // The file vanished between EEXIST and this read — a peer released, or a peer is
      // mid-steal. We have no bytes to verify against, so we must NOT enter the steal path:
      // it would move a peer's freshly created lock aside with nothing to compare it to,
      // which is the double-acquire this whole protocol exists to prevent. Just retry the
      // plain exclusive create once and take the answer.
      const again = createExclusive(lockPath, payload);
      if (again === 'ok') return { release: makeRelease(lockPath, payload) };
      return again.error ? failed(again.error) : {};
    }
    if (!isStale(lockPath, staleMs, now)) return {}; // live peer holds it
    // ── Stealing a stale lock (R10 P1-7) ──────────────────────────────────────────────
    // This used to be unlink-then-create, and the comment "lose the race → null" was only
    // true of the create. The losing interleave: A unlinks, A creates, B unlinks A's BRAND
    // NEW lock, B creates. Both hold it, and both then run installExtractedRelease's rename
    // loop over the same tree — the torn install this module exists to prevent. Measured on
    // the old code with two worker threads leaving an Atomics barrier together: 35 double
    // acquisitions in 200 rounds.
    //
    // Protocol now: rename the stale file to a private tombstone. rename is atomic and
    // single-winner, so a second stealer gets ENOENT and stands down. Then verify the
    // tombstone still holds the bytes we judged stale — if it does not, a peer stole and
    // re-created between our check and our rename, and what we just moved aside is THEIR
    // live lock. Put it back with link() (which refuses to clobber) and stand down.
    const tombstone = `${lockPath}.steal-${process.pid}-${Math.random().toString(36).slice(2)}.lock`;
    try {
      renameSync(lockPath, tombstone);
    } catch {
      return {}; // another stealer won the rename; it owns the re-create
    }
    let stolen = null;
    try {
      stolen = readFileSync(tombstone, 'utf8');
    } catch {
      /* unreadable — treat as ours to discard */
    }
    if (stolen !== null && stolen !== sampled) {
      try {
        linkSync(tombstone, lockPath); // EEXIST → someone already owns the path; leave it
      } catch {
        /* a third party holds it now */
      }
      try {
        unlinkSync(tombstone);
      } catch {
        /* best-effort */
      }
      return {};
    }
    try {
      unlinkSync(tombstone);
    } catch {
      /* best-effort — the .lock suffix keeps it sweepable either way */
    }
    const retaken = createExclusive(lockPath, payload);
    if (retaken === 'ok') return { release: makeRelease(lockPath, payload) };
    return retaken.error ? failed(retaken.error) : {};
  }
}

/**
 * Whether acquireLock would refuse `lockPath` now because a peer holds it. Read-only: it creates
 * nothing, so a command that must not write (`cleanup --dry-run`) or only reports (`doctor`) can
 * ask without taking the lock (D#297). A lock file that is there but cannot be read is held:
 * acquireLock cannot steal what it cannot read, so it refuses (pre-ship review P3-1). One whose
 * directory cannot be looked into is not known to be held by anyone; the caller names that
 * directory on its own.
 * @returns {boolean}
 */
export function lockHeld(lockPath, { staleMs = DEFAULT_STALE_MS, now = Date.now } = {}) {
  try {
    lstatSync(lockPath);
  } catch {
    return false;
  }
  try {
    readFileSync(lockPath);
  } catch (e) {
    return e.code !== 'ENOENT'; // released between the two calls: acquireLock would take it
  }
  return !isStale(lockPath, staleMs, now);
}

/**
 * Why acquireLock cannot create `lockPath` whoever holds it, or null when it can. acquireLock
 * answers null both for a live holder and for a lock file it cannot create at all, and every
 * caller read that null as "another install is in progress": with a runtime dir a `sudo` run left
 * root-owned, or a read-only data dir, every update skipped silently, install exited 0 having done
 * nothing, and cleanup named a lock that did not exist (D#304, D#307). This tells the two apart.
 * Read-only, like lockHeld: it creates nothing.
 *
 * The directory asked about is the lock's own, or, when that does not exist yet, the nearest one
 * that does: acquireLock creates the rest, so that is the one it has to write into.
 * @returns {{dir: string, code: string}|null}
 */
export function lockDirBlocked(lockPath) {
  let dir = dirname(lockPath);
  for (;;) {
    try {
      accessSync(dir, fsConstants.W_OK | fsConstants.X_OK);
      return null;
    } catch (e) {
      // A link to nowhere reads as absent, but nothing can be created under it (review P2-1).
      if (e.code === 'ENOENT' && isLink(dir)) return { dir, code: 'ENOENT' };
      // A directory under one that cannot be entered fails EACCES too: name the one to fix.
      if (e.code !== 'ENOENT') return unenterableAncestor(dir) || { dir, code: e.code || 'EACCES' };
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  }
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The ancestor of `dir` nearest the root that this user cannot enter, or null. */
function unenterableAncestor(dir) {
  const chain = [];
  for (let d = dirname(dir); ; d = dirname(d)) {
    chain.unshift(d);
    if (dirname(d) === d) break;
  }
  for (const d of chain) {
    try {
      accessSync(d, fsConstants.X_OK);
    } catch (e) {
      return e.code === 'ENOENT' ? null : { dir: d, code: e.code || 'EACCES' };
    }
  }
  return null;
}

/**
 * Run `fn` while holding the lock; release in a finally. No-op if not acquired.
 * @returns {{acquired: boolean, result?: any}}
 */
export function withLock(lockPath, fn, opts) {
  const release = acquireLock(lockPath, opts);
  if (!release) return { acquired: false };
  try {
    return { acquired: true, result: fn() };
  } finally {
    release();
  }
}

/** Async variant of withLock — awaits `fn`. */
export async function withLockAsync(lockPath, fn, opts) {
  const release = acquireLock(lockPath, opts);
  if (!release) return { acquired: false };
  try {
    return { acquired: true, result: await fn() };
  } finally {
    release();
  }
}
