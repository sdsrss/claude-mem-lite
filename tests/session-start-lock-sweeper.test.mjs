// A20260905-R5-P1-1: the SessionStart lock sweeper deleted locks that live processes held.
//
// cleanStaleLockFiles() (hook.mjs) walks every `*.lock` in RUNTIME_DIR on every SessionStart.
// It used to compute `stale = age > STALE_LOCK_MS` and consult the holder's pid ONLY when the
// lock was younger than that — i.e. only for the locks it was going to keep anyway. So any
// lock older than 30s was unlinked regardless of who held it.
//
// `runtime/install.lock` (lib/proc-lock.mjs) is exactly such a lock, and its critical section
// is orders of magnitude longer than 30s: `install.mjs repair`, `install.mjs rebuild-binding`,
// hook-update.installExtractedRelease and scripts/launch.mjs all take it around an install
// write phase whose npm steps are capped at 60s (staging install) and 120s (smoke rebuild).
// A second Claude Code window booting inside that span swept the lock away, the next installer
// acquired it, and two processes renamed files into the same install dir — the torn
// mixed-version install (server vN + hook vN+1) proc-lock.mjs's header exists to prevent.
//
// Every case drives the REAL `hook.mjs session-start` in a subprocess against a mkdtemp data
// dir, and every "survived" assertion is paired with a decoy that must be swept in the same
// run — without it, survival is equally consistent with a sweeper that never executed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
// Imported, not re-typed: the sweeper's thresholds are the thing under test, so a local copy
// would keep these cases green through a change to either constant.
import { STALE_LOCK_MS, ABANDONED_LOCK_MS } from '../hook-shared.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOOK = join(REPO, 'hook.mjs');

// Above Linux's default pid_max, so process.kill(pid, 0) reports ESRCH — "provably dead".
const DEAD_PID = 0x7ffffffe;

let dataDir, runtimeDir, dbPath;

/**
 * Write a lock file and age both its recorded ts and its mtime. Both matter: the ts drives
 * the JSON branch, the mtime drives the unparseable fallback branch.
 */
function writeLock(name, { ageMs, pid }) {
  const p = join(runtimeDir, name);
  const payload = pid === undefined ? { ts: Date.now() - ageMs } : { pid, ts: Date.now() - ageMs };
  writeFileSync(p, JSON.stringify(payload));
  const aged = Math.floor((Date.now() - ageMs) / 1000);
  utimesSync(p, aged, aged);
  return p;
}

function runSessionStart() {
  return execFileSync(process.execPath, [HOOK, 'session-start'], {
    cwd: REPO,
    input: JSON.stringify({ session_id: 'sweeper-ss', source: 'startup', cwd: dataDir }),
    env: {
      ...process.env,
      CLAUDE_MEM_DIR: dataDir,
      CLAUDE_PROJECT_DIR: dataDir,
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
      CLAUDE_MEM_SKIP_COMPRESS: '1',
      CLAUDE_MEM_SKIP_OPTIMIZE: '1',
      CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
      CLAUDE_MEM_SKIP_SUMMARY: '1',
      MEM_NO_AUTO_ADOPT: '1',
    },
    stdio: 'pipe',
    timeout: 60_000,
    encoding: 'utf8',
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mem-sweeper-'));
  runtimeDir = join(dataDir, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  dbPath = join(dataDir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  initSchema(db);
  db.close();
});

afterEach(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('SessionStart lock sweeper — liveness before age', () => {
  it('keeps an install.lock older than STALE_LOCK_MS while its holder is alive', () => {
    // 31s: past the old unconditional-unlink threshold, nowhere near a real install's end.
    const live = writeLock('install.lock', { ageMs: STALE_LOCK_MS + 1000, pid: process.pid });
    // Same age, same directory, dead holder. If the sweeper did not run, this survives too
    // and the assertion above proves nothing.
    const decoy = writeLock('decoy.lock', { ageMs: STALE_LOCK_MS + 1000, pid: DEAD_PID });

    runSessionStart();

    expect(existsSync(decoy), 'sweeper did not run — the survival below proves nothing').toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it('still sweeps a lock whose holder is provably dead, at any age', () => {
    const young = writeLock('young-dead.lock', { ageMs: 1000, pid: DEAD_PID });
    const old = writeLock('old-dead.lock', { ageMs: STALE_LOCK_MS + 1000, pid: DEAD_PID });

    runSessionStart();

    expect(existsSync(young)).toBe(false);
    expect(existsSync(old)).toBe(false);
  });

  it('still sweeps an aged lock that records no usable pid', () => {
    // The pre-existing STALE_LOCK_MS path, unchanged: no pid to ask about.
    const noPid = writeLock('nopid.lock', { ageMs: STALE_LOCK_MS + 1000 });
    const young = writeLock('young-nopid.lock', { ageMs: 1000 });
    // Unparseable — falls through to the mtime branch.
    const garbagePath = join(runtimeDir, 'garbage.lock');
    writeFileSync(garbagePath, 'not json');
    const aged = Math.floor((Date.now() - STALE_LOCK_MS - 1000) / 1000);
    utimesSync(garbagePath, aged, aged);

    runSessionStart();

    expect(existsSync(noPid)).toBe(false);
    expect(existsSync(garbagePath)).toBe(false);
    expect(existsSync(young)).toBe(true);
  });

  it('ABANDONED_LOCK_MS still collects a live-pid lock that outlived any real critical section', () => {
    // Guards against the opposite failure: a leaked lock file whose pid was recycled onto an
    // unrelated live process must not pin the file forever. The backstop is longer than
    // proc-lock.mjs's own 5-min steal window, so it never decides anything the lock protocol
    // has not already conceded.
    const ancient = writeLock('ancient.lock', {
      ageMs: ABANDONED_LOCK_MS + 60_000,
      pid: process.pid,
    });
    const inside = writeLock('inside.lock', {
      ageMs: ABANDONED_LOCK_MS - 60_000,
      pid: process.pid,
    });

    runSessionStart();

    expect(existsSync(ancient)).toBe(false);
    expect(existsSync(inside)).toBe(true);
  });
});
