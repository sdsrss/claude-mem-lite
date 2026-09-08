// `doctor` printed `✗ Database: file is not a database` with no remedy, while every other
// ✗ on the same screen carried one (orphan hooks, hook self-heal, schema skew). The user is
// left with a red line and nowhere to go — and the remedy exists: this repo takes VACUUM
// INTO snapshots before every irreversible maintenance pass (lib/db-backup.mjs).
//
// Three outcomes, never two. "There is no snapshot" and "I could not read the directory"
// get different sentences, because a diagnostic that says "no backup exists" when it never
// looked ends the reader's search with a false fact.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dbCheckRemedy } from '../install.mjs';
import { readSnapshots } from '../lib/db-backup.mjs';
import { makeFixtureTracker } from './test-helpers.mjs';

const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

const corrupt = () => Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' });

function dataDir() {
  return fixtures.track(mkdtempSync(join(tmpdir(), 'cml-db-remedy-')));
}

function withDb(snapshotNames = []) {
  const dir = dataDir();
  const db = join(dir, 'claude-mem-lite.db');
  writeFileSync(db, 'not actually sqlite');
  let t = 1_700_000_000;
  for (const n of snapshotNames) {
    const p = join(dir, n);
    writeFileSync(p, 'snap');
    // Deterministic ordering: the newest snapshot is the one the remedy must name, and
    // two files written in the same millisecond would make "newest" arbitrary (D#9).
    utimesSync(p, t, t);
    t += 3600;
  }
  return { dir, db };
}

describe('readSnapshots separates empty from unreadable', () => {
  it('reports ok with an empty list when the directory has no snapshots', () => {
    const { db } = withDb();
    expect(readSnapshots(db)).toEqual({ ok: true, snapshots: [] });
  });

  it('reports NOT ok when the directory cannot be read', () => {
    const dir = dataDir();
    const notADir = join(dir, 'file-where-a-dir-should-be');
    writeFileSync(notADir, 'x');
    // ENOTDIR rather than a chmod: deterministic, and it still reproduces when the suite
    // runs as root.
    const r = readSnapshots(join(notADir, 'claude-mem-lite.db'));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ENOTDIR');
  });
});

describe('dbCheckRemedy', () => {
  it('names the newest snapshot when one exists', () => {
    const { db } = withDb([
      'claude-mem-lite.db.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak',
      'claude-mem-lite.db.pre-maintain-2026-09-06T00-00-00-000Z-1-1.bak',
    ]);
    const out = dbCheckRemedy(db, corrupt());
    expect(out).toContain('2026-09-06T00-00-00-000Z');
    expect(out).not.toContain('2026-09-01T00-00-00-000Z');
    expect(out).toContain('cp ');
    // The stale WAL/SHM must go first or the restored file is corrupted again by replay.
    expect(out).toContain('-wal');
    expect(out).toContain('-shm');
  });

  it('says so plainly when no snapshot exists, and does not offer a restore', () => {
    const { db } = withDb();
    const out = dbCheckRemedy(db, corrupt());
    expect(out).toMatch(/no backup snapshot/i);
    expect(out).not.toContain('cp ');
    expect(out).toContain('mv ');
  });

  it('distinguishes "could not look" from "there are none"', () => {
    const dir = dataDir();
    const notADir = join(dir, 'wall');
    writeFileSync(notADir, 'x');
    const out = dbCheckRemedy(join(notADir, 'claude-mem-lite.db'), corrupt());
    expect(out).toMatch(/could not read/i);
    expect(out).toContain('ENOTDIR');
    // The whole point of the third outcome: it must NOT assert the absence it never checked.
    expect(out).not.toMatch(/no backup snapshot/i);
  });

  it('hands a native-binding failure the binding repair chain, not a backup', () => {
    const { db } = withDb();
    const err = new Error('Could not locate the bindings file. Tried:\n → build/Release/better_sqlite3.node');
    const out = dbCheckRemedy(db, err);
    expect(out).toMatch(/npm rebuild better-sqlite3/);
    expect(out).not.toMatch(/backup snapshot/i);
  });

  it('invents no remedy for an error it cannot classify', () => {
    // Control. A diagnostic that always prints a fix will eventually print the wrong one;
    // an unclassified failure keeps the bare message it had before.
    const { db } = withDb();
    expect(dbCheckRemedy(db, new Error('EACCES: permission denied, open'))).toBeNull();
  });

  it('accepts the other spellings SQLite uses for a damaged file', () => {
    const { db } = withDb();
    for (const msg of ['database disk image is malformed', 'file is encrypted or is not a database']) {
      expect(dbCheckRemedy(db, new Error(msg)), msg).toMatch(/no backup snapshot/i);
    }
  });
});

// WIRING. The cases above prove the function; nothing above proves anyone calls it, and
// this repo has shipped exactly that gap more than once (doctor's UNKNOWN bash-hook arm had
// seven green unit cases and no caller). So drive the SHIPPED doctor over a corrupt file.
describe('doctor prints the remedy it computes', () => {
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  function runDoctor(dataDir) {
    // HOME is sandboxed: without it these assertions are graded against whatever plugin
    // cache the developer's machine holds, which is how an earlier doctor test failed its
    // own control (tests/schema-skew-wiring.test.mjs records that round).
    const home = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-db-remedy-home-')));
    return spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        MEM_NO_AUTO_ADOPT: '1',
      },
    });
  }

  it('emits the no-snapshot remedy under the ✗ Database line', () => {
    const { dir } = withDb();
    const out = runDoctor(dir).stdout;
    // Premise: the check really did fail. Without this the remedy assertion could pass on
    // output where the database line never appeared at all.
    expect(out).toMatch(/Database: .*not a database|Database: .*malformed/);
    expect(out).toMatch(/No backup snapshot exists beside the database/);
  });

  it('emits the restore remedy naming the newest snapshot', () => {
    const { dir } = withDb([
      'claude-mem-lite.db.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak',
      'claude-mem-lite.db.pre-maintain-2026-09-06T00-00-00-000Z-1-1.bak',
    ]);
    const out = runDoctor(dir).stdout;
    expect(out).toMatch(/Restore the newest of 2 backup snapshot\(s\)/);
    expect(out).toContain('2026-09-06T00-00-00-000Z');
  });

  it('says nothing extra when the database opens cleanly (control)', () => {
    const dir = dataDir();
    const out = runDoctor(dir).stdout;
    // No DB file at all → the "not found (will be created)" arm, which must not acquire a
    // corruption remedy. Guards the fix against over-reaching.
    //
    // Asserted against the remedy's OWN sentences, not the bare phrase "backup snapshot":
    // a healthy doctor already prints `Disk footprint: … 0 backup snapshot(s)`, and the
    // first draft of this control matched that unrelated line and failed. A control that
    // greps too widely reports the wrong thing as a regression.
    expect(out).toMatch(/Database: not found/);
    expect(out).not.toMatch(/No backup snapshot exists beside the database/);
    expect(out).not.toMatch(/Restore the newest of/);
    expect(out).not.toMatch(/Could not read .* to look for a backup snapshot/);
  });
});
