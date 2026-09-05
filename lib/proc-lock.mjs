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
// already exists it is stolen only when STALE (holder's timestamp older than
// staleMs, or the recorded pid is provably dead on this host). A live holder →
// acquire returns null and the caller no-ops (someone else is already doing the
// write). Release unlinks the file. Crash-safe: a crashed holder's lock ages
// out via staleMs so the next session reclaims it.

import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 5 min: comfortably longer than any install/update write phase (npm install in
// staging is timeout-capped at 60s) but short enough that a crashed holder does
// not block self-heal for long.
const DEFAULT_STALE_MS = 5 * 60 * 1000;

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
    if (typeof ts === 'number' && now() - ts > staleMs) return true;
    // Same-host fast reclaim: holder pid is gone. Cross-host (shared homedir)
    // the pid is meaningless, but ts-staleness above still reclaims it.
    if (typeof pid === 'number' && !pidAlive(pid)) return true;
    return false;
  } catch {
    return true; // unparseable / unreadable lock → treat as stale and reclaim
  }
}

function makeRelease(lockPath) {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    try {
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
 * @param {number} [opts.staleMs]  Age after which a held lock is stolen.
 * @param {() => number} [opts.now]  Clock injection seam (tests).
 * @returns {(() => void)|null}  A release() fn, or null if a live peer holds it.
 */
export function acquireLock(lockPath, { staleMs = DEFAULT_STALE_MS, now = Date.now } = {}) {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    /* best-effort */
  }
  const payload = JSON.stringify({ pid: process.pid, ts: now() });
  try {
    writeFileSync(lockPath, payload, { flag: 'wx' }); // O_EXCL — atomic create
    return makeRelease(lockPath);
  } catch (e) {
    if (e.code !== 'EEXIST') return null; // permission / fs error → fail closed
    if (!isStale(lockPath, staleMs, now)) return null; // live peer holds it
    // Stale: steal it. unlink + re-create exclusively; lose the race → null.
    try {
      unlinkSync(lockPath);
    } catch {
      /* raced */
    }
    try {
      writeFileSync(lockPath, payload, { flag: 'wx' });
      return makeRelease(lockPath);
    } catch {
      return null;
    }
  }
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
