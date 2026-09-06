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

import { writeFileSync, readFileSync, unlinkSync, mkdirSync, renameSync, linkSync } from 'node:fs';
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
  // `nonce` makes the payload identify THIS acquisition, not just this process: two
  // acquires from one pid inside the same millisecond would otherwise be indistinguishable,
  // and release() below compares payloads. isStale() and hook.mjs's lock sweeper read only
  // `pid` and `ts`, so the extra field is inert to both.
  const payload = JSON.stringify({
    pid: process.pid,
    ts: now(),
    nonce: Math.random().toString(36).slice(2),
  });
  try {
    writeFileSync(lockPath, payload, { flag: 'wx' }); // O_EXCL — atomic create
    return makeRelease(lockPath, payload);
  } catch (e) {
    if (e.code !== 'EEXIST') return null; // permission / fs error → fail closed
    let sampled;
    try {
      sampled = readFileSync(lockPath, 'utf8');
    } catch {
      // The file vanished between EEXIST and this read — a peer released, or a peer is
      // mid-steal. We have no bytes to verify against, so we must NOT enter the steal path:
      // it would move a peer's freshly created lock aside with nothing to compare it to,
      // which is the double-acquire this whole protocol exists to prevent. Just retry the
      // plain exclusive create once and take the answer.
      try {
        writeFileSync(lockPath, payload, { flag: 'wx' });
        return makeRelease(lockPath, payload);
      } catch {
        return null;
      }
    }
    if (!isStale(lockPath, staleMs, now)) return null; // live peer holds it
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
      return null; // another stealer won the rename; it owns the re-create
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
      return null;
    }
    try {
      unlinkSync(tombstone);
    } catch {
      /* best-effort — the .lock suffix keeps it sweepable either way */
    }
    try {
      writeFileSync(lockPath, payload, { flag: 'wx' });
      return makeRelease(lockPath, payload);
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
