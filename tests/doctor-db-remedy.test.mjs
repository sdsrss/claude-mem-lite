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
import { REPAIR_DB_COMMAND } from '../lib/db-unusable.mjs';
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
  // D#541: every failure of this family gets repair-db, which reads what SQLite still can and
  // prints the snapshot restore or set-aside itself when it cannot read the file at all.
  it('names repair-db, and the newest snapshot as the fallback', async () => {
    const { db } = withDb([
      'claude-mem-lite.db.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak',
      'claude-mem-lite.db.pre-maintain-2026-09-06T00-00-00-000Z-1-1.bak',
    ]);
    const out = await dbCheckRemedy(db, corrupt());
    expect(out).toContain(REPAIR_DB_COMMAND);
    expect(out).toContain('2026-09-06T00-00-00-000Z');
    expect(out).not.toContain('2026-09-01T00-00-00-000Z');
    expect(out).not.toMatch(/rm -f|\bcp\b|\bmv\b|\bln\b|&&/);
  });

  it('names repair-db without claiming a snapshot when there is none', async () => {
    const { db } = withDb();
    const out = await dbCheckRemedy(db, corrupt());
    expect(out).toContain(REPAIR_DB_COMMAND);
    expect(out).not.toMatch(/snapshot/i);
  });

  // The third outcome lives in repair-db's own fallback now; doctor must still not assert an
  // absence it never checked.
  it('claims no absence of snapshots when the directory cannot be read', async () => {
    const dir = dataDir();
    const notADir = join(dir, 'wall');
    writeFileSync(notADir, 'x');
    const out = await dbCheckRemedy(join(notADir, 'claude-mem-lite.db'), corrupt());
    expect(out).toContain(REPAIR_DB_COMMAND);
    expect(out).not.toMatch(/no backup snapshot/i);
  });

  it('hands a native-binding failure the binding repair chain, not a backup', async () => {
    const { db } = withDb();
    const err = new Error('Could not locate the bindings file. Tried:\n → build/Release/better_sqlite3.node');
    const out = await dbCheckRemedy(db, err);
    expect(out).toMatch(/npm rebuild better-sqlite3/);
    expect(out).not.toMatch(/backup snapshot/i);
  });

  it('invents no remedy for an error it cannot classify', async () => {
    // Control. A diagnostic that always prints a fix will eventually print the wrong one;
    // an unclassified failure keeps the bare message it had before.
    const { db } = withDb();
    expect(await dbCheckRemedy(db, new Error('EACCES: permission denied, open'))).toBeNull();
  });

  // A schema row SQLite cannot parse: repair-db, which reads past it (D#541), and the newest
  // snapshot named as the fallback; no shell line that moves or copies files.
  it('sends an unreadable schema to repair-db, naming the newest snapshot', async () => {
    const { db } = withDb([
      'claude-mem-lite.db.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak',
      'claude-mem-lite.db.pre-maintain-2026-09-06T00-00-00-000Z-1-1.bak',
    ]);
    const err = Object.assign(new Error('malformed database schema (idx_t_a) - incomplete input'), {
      code: 'SQLITE_CORRUPT',
    });
    const out = await dbCheckRemedy(db, err);
    expect(out).toContain(REPAIR_DB_COMMAND);
    expect(out).toContain('2026-09-06T00-00-00-000Z');
    expect(out).not.toMatch(/rm -f|\bcp\b|\bmv\b|&&/);
  });

  // D#534: repair-db writes into the store, under any session still holding it.
  it('says to close every Claude Code session before the command', async () => {
    const out = await dbCheckRemedy(withDb().db, corrupt());
    const at = out.indexOf('every Claude Code session is closed');
    expect(at).toBeGreaterThan(-1);
    expect(at, 'before the command').toBeLessThan(out.indexOf(REPAIR_DB_COMMAND));
  });

  it('accepts the other spellings SQLite uses for a damaged file', async () => {
    const { db } = withDb();
    for (const msg of ['database disk image is malformed', 'file is encrypted or is not a database']) {
      expect(await dbCheckRemedy(db, new Error(msg)), msg).toContain(REPAIR_DB_COMMAND);
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

  it('emits the repair-db remedy under the ✗ Database line', () => {
    const { dir } = withDb();
    const out = runDoctor(dir).stdout;
    // Premise: the check really did fail. Without this the remedy assertion could pass on
    // output where the database line never appeared at all.
    expect(out).toMatch(/Database: .*not a database|Database: .*malformed/);
    expect(out).toContain(REPAIR_DB_COMMAND);
  });

  it('names the newest snapshot as the fallback', () => {
    const { dir } = withDb([
      'claude-mem-lite.db.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak',
      'claude-mem-lite.db.pre-maintain-2026-09-06T00-00-00-000Z-1-1.bak',
    ]);
    const out = runDoctor(dir).stdout;
    expect(out).toMatch(/the newest of 2 backup snapshot\(s\)/);
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
    expect(out).not.toContain(REPAIR_DB_COMMAND);
    expect(out).not.toMatch(/Could not read .* to look for a backup snapshot/);
  });
});
