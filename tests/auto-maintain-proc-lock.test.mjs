// FLOW-1 (2026-08-29 audit): the background maintenance family had no cross-process mutex.
//
// handleAutoMaintain is shaped read-gate → long work → write-gate. Two Claude Code windows
// booting either side of the 24h boundary both read "due" and both spawn a worker, and the
// overlap breaks an invariant decayAndMarkIdle documents in its own docblock: it marks
// idle rows BEFORE it decays, so that an imp-2 row cannot be decayed 2→1 and then hidden as
// COMPRESSED_PENDING_PURGE by the same pass (each importance tier is supposed to buy a
// grace cycle). Across two processes that ordering does not exist — worker A decays 2→1,
// worker B's mark-idle sees a qualifying imp-1 row and hides it, 37 days from a hard delete.
//
// Every case here is deterministic: the "peer is mid-pass" state is created by writing the
// lock file with THIS process's pid rather than by racing two workers, so nothing depends
// on scheduling. The control case in each pair is what makes the negative assertions mean
// something — without it, "the row was not marked" is equally consistent with a fixture
// that was never markable.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
// Imported, not re-typed: the previous version derived its own path from a literal, so
// renaming the constant in hook.mjs left this case green with the sweeper hazard fully
// reintroduced (pre-tag review S-4). Same "import it, don't copy it" rule the rest of this
// round applied to the cooldown path and the UPS caps. (hook.mjs is an entry point that
// exits on import, so the constant lives in hook-shared.mjs beside STALE_LOCK_MS — the
// sweeper policy it has to escape.)
import { AUTO_MAINTAIN_LOCK } from '../hook-shared.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOOK = join(REPO, 'hook.mjs');
const COMPRESSED_PENDING_PURGE = -2;
const PROJECT = 'work--flow1';

let dataDir, runtimeDir, dbPath, lockPath, gateFile;

/**
 * One decay-eligible observation: never accessed, never injected, no lesson, older than the
 * 30-day stale window. At importance 1 mark-idle hides it on the next pass — which is
 * exactly the state a peer worker's decay pass leaves behind when it takes an imp-2 row
 * down a tier. At importance 2 it takes two passes, and that gap is the invariant.
 */
function seedRow(importance = 1) {
  const db = new Database(dbPath);
  initSchema(db);
  const old = Date.now() - 45 * 86400000;
  db.prepare(
    'INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)' +
      " VALUES ('s1','s1',?,?,?,'active')",
  ).run(PROJECT, new Date(old).toISOString(), old);
  const id = db
    .prepare(
      'INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts,' +
        ' facts, files_read, files_modified, importance, related_ids, access_count, injection_count, created_at, created_at_epoch)' +
        " VALUES ('s1', ?, 'stale body', 'change', 'stale row', '', '', '', '', '[]', '[]', ?, '[]', 0, 0, ?, ?)",
    )
    .run(PROJECT, importance, new Date(old).toISOString(), old).lastInsertRowid;
  db.close();
  return id;
}

function compressedInto(id) {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(id);
  db.close();
  return row?.compressed_into ?? 0;
}

function importanceOf(id) {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT importance FROM observations WHERE id = ?').get(id);
  db.close();
  return row?.importance;
}

// Deliberately NO project argument: markAutoCompressibleIfDue returns early without one,
// which keeps decayAndMarkIdle the only writer of compressed_into in these fixtures. With
// a project passed, the 30-day "aged" marking claims the row first (COMPRESSED_AUTO, -1)
// and the assertions below would be reading a different mechanism than the one under test.
function runAutoMaintain() {
  return execFileSync(process.execPath, [HOOK, 'auto-maintain'], {
    cwd: REPO,
    env: {
      ...process.env,
      CLAUDE_MEM_DIR: dataDir,
      CLAUDE_MEM_SKIP_COMPRESS: '1',
      CLAUDE_MEM_SKIP_OPTIMIZE: '1',
      CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    },
    stdio: 'pipe',
    timeout: 60_000,
    encoding: 'utf8',
  });
}

/** Write the mutex as a LIVE holder — this process is alive by construction. */
function holdLock({ ageMs = 0, pid = process.pid } = {}) {
  writeFileSync(lockPath, JSON.stringify({ pid, ts: Date.now() - ageMs }));
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mem-flow1-'));
  runtimeDir = join(dataDir, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  dbPath = join(dataDir, 'claude-mem-lite.db');
  lockPath = join(runtimeDir, AUTO_MAINTAIN_LOCK);
  gateFile = join(runtimeDir, 'last-auto-maintain.json');
});

afterEach(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('auto-maintain — cross-process mutex', () => {
  it('CONTROL: with no peer holding the lock, the pass runs and hides the stale row', () => {
    const id = seedRow();
    runAutoMaintain();
    // This is the damage a second overlapping worker inflicts. Establishing that it
    // happens here is what makes the next case's negative assertion evidence.
    expect(compressedInto(id)).toBe(COMPRESSED_PENDING_PURGE);
    expect(existsSync(gateFile)).toBe(true);
  });

  it('a live peer holding the lock keeps a second worker out of the pass entirely', () => {
    const id = seedRow();
    holdLock();
    runAutoMaintain();
    expect(compressedInto(id)).toBe(0);
    // The 24h gate must not be stamped either — otherwise the worker that DID hold the
    // lock would find the gate fresh and skip its own pass.
    expect(existsSync(gateFile)).toBe(false);
    // The peer's lock is left for the peer to release, not stolen or deleted.
    expect(existsSync(lockPath)).toBe(true);
  });

  it('releases the lock on the way out, so back-to-back workers are not blocked', () => {
    const id = seedRow();
    runAutoMaintain();
    expect(existsSync(lockPath)).toBe(false);
    expect(compressedInto(id)).toBe(COMPRESSED_PENDING_PURGE);
  });

  it('reclaims a stale lock (aged out) instead of wedging maintenance forever', () => {
    const id = seedRow();
    holdLock({ ageMs: 20 * 60 * 1000 }); // older than the 10-minute staleMs
    runAutoMaintain();
    expect(compressedInto(id)).toBe(COMPRESSED_PENDING_PURGE);
    expect(existsSync(gateFile)).toBe(true);
  });

  it('reclaims a lock whose holder pid is dead, even when it is young', () => {
    const id = seedRow();
    // 0x7ffffffe: above Linux's default pid_max, so process.kill(pid, 0) reports ESRCH.
    holdLock({ ageMs: 0, pid: 0x7ffffffe });
    runAutoMaintain();
    expect(compressedInto(id)).toBe(COMPRESSED_PENDING_PURGE);
  });

  // ── The FLOW-1 damage itself, reproduced without racing anything ──
  //
  // Two overlapping workers both read the 24h gate as due. Sequentially that is: run a
  // pass, delete the gate the pass stamped, run another. The row's grace cycle — the whole
  // point of MED-1's mark-before-decay ordering — is what disappears.

  it('HAZARD: a second gate-clear pass hides an imp-2 row that one pass only demotes', () => {
    const id = seedRow(2);
    runAutoMaintain();
    // One pass is safe: MED-1's in-process ordering marks before it decays.
    expect(importanceOf(id)).toBe(1);
    expect(compressedInto(id)).toBe(0);

    rmSync(gateFile, { force: true }); // what "both workers saw due" produces
    runAutoMaintain();
    // Ordering gone: the row is now hidden from every read face, 37 days from hard delete.
    expect(compressedInto(id)).toBe(COMPRESSED_PENDING_PURGE);
  });

  it('the lock closes that window: the overlapping worker never reaches the pass', () => {
    const id = seedRow(2);
    runAutoMaintain();
    expect(importanceOf(id)).toBe(1);

    rmSync(gateFile, { force: true });
    holdLock(); // the peer is mid-pass, exactly as during a real overlap
    runAutoMaintain();
    expect(compressedInto(id)).toBe(0);
    expect(importanceOf(id)).toBe(1);
  });

  it('is not named *.lock, so the 30s SessionStart lock sweeper cannot strip it mid-pass', () => {
    // cleanStaleLockFiles() unlinks every `*.lock` in RUNTIME_DIR older than
    // STALE_LOCK_MS (30s) WITHOUT checking whether the holder is alive — a policy sized
    // for the episode lock's millisecond critical section. A maintenance pass is orders
    // of magnitude longer, so being swept would hand the exclusion back to the race.
    //
    // Behavioural, not a name assertion: age a live-held mutex past 30s, run the sweeper
    // by way of a real SessionStart, and require the mutex to survive. Renaming the file
    // to `auto-maintain.lock` reddens this.
    const db = new Database(dbPath);
    initSchema(db);
    db.close();
    holdLock({ ageMs: 5 * 60 * 1000 });
    const aged = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);
    utimesSync(lockPath, aged, aged);

    // A decoy under the swept policy proves the sweeper actually ran in this subprocess.
    const decoy = join(runtimeDir, 'decoy.lock');
    writeFileSync(decoy, JSON.stringify({ pid: process.pid, ts: Date.now() - 5 * 60 * 1000 }));
    utimesSync(decoy, aged, aged);

    execFileSync(process.execPath, [HOOK, 'session-start'], {
      cwd: REPO,
      input: JSON.stringify({ session_id: 'flow1-ss', source: 'startup', cwd: dataDir }),
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

    expect(existsSync(decoy), 'sweeper did not run — the survival below proves nothing').toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    // Bind the NAME as well as the behaviour: without this, renaming the constant renames
    // the fixture with it and the case stays green while the hazard is back.
    expect(AUTO_MAINTAIN_LOCK).not.toMatch(/\.lock$/);
  });
});
