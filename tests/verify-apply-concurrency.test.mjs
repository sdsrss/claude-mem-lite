// verify-apply against a writer in ANOTHER process. Both halves of verify-apply compare a row
// with a recorded state and then write over it, and the comparison is only worth anything if
// no other connection can commit between the two. That holds because the comparison runs
// inside the IMMEDIATE transaction that does the write: the other process's write lock makes
// it wait, and it then compares against what that process committed. Checked before the
// transaction, it reads the last committed state (WAL: the other writer's change is not
// visible yet), passes, waits for the lock, and writes over the change it never saw.
//
// A single connection cannot interleave like this (better-sqlite3 is synchronous), so a child
// process holds the write lock with an uncommitted change and commits after HOLD_MS. Each case
// asserts the premise that the two actually overlapped: the verify-apply call started before
// the child committed and returned after it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';
import {
  parseProposals,
  planVerifyApply,
  runVerifyApply,
  undoVerifyBackup,
} from '../lib/verify-apply-core.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOLD_MS = 600;
const P = 'test';
const ORIGINAL = 'The original narrative, as it was saved.';
const APPROVED = 'The approved correction.';
const CONCURRENT = 'Written by another process while verify-apply was waiting.';

// Takes the write lock, changes the row, says so, holds the lock, commits, prints when.
const CHILD = `
import Database from 'better-sqlite3';
const [dbPath, id, text, hold] = process.argv.slice(1);
const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
db.prepare('UPDATE observations SET narrative = ? WHERE id = ?').run(text, Number(id));
process.stdout.write('locked\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(hold));
db.exec('COMMIT');
process.stdout.write('committed ' + Date.now() + '\\n');
db.close();
`;

let dir;
let dbPath;
let db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-verify-conc-'));
  dbPath = join(dir, 'mem.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  // What openDb sets (schema.mjs); without it the parent would fail with SQLITE_BUSY at once.
  db.pragma('busy_timeout = 5000');
  initSchema(db);
  insertSession(db, { id: 'sess-1', project: P });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Start the child; resolves once it holds the lock, with `done` resolving to its commit time.
 * `done` is wrapped in an object on purpose: an async function returning a bare promise
 * flattens it, and the caller would then wait for the commit before starting — no overlap.
 */
async function holdLockAndWrite(id) {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', CHILD, dbPath, String(id), CONCURRENT, String(HOLD_MS)],
    {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve, reject) =>
    child.on('exit', (code) => {
      const m = /committed (\d+)/.exec(out);
      if (code !== 0 || !m) reject(new Error(`child failed (${code}): ${err}`));
      else resolve(Number(m[1]));
    }),
  );
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('locked\n')) resolve();
    });
    child.on('exit', () => reject(new Error(`child exited before locking: ${err}`)));
  });
  return { done };
}

function seed() {
  return Number(
    insertObs(db, { type: 'bugfix', importance: 2, title: 'A memory', narrative: ORIGINAL }).lastInsertRowid,
  );
}

function planEdit(id) {
  const { entries } = parseProposals([
    { id, action: 'edit', verdict: 'STALE', set: { narrative: APPROVED }, evidence: 'abc1234' },
  ]);
  const { plan, errors } = planVerifyApply(db, entries, { project: P });
  expect(errors).toEqual([]);
  return plan;
}

const narrative = (id) => db.prepare('SELECT narrative FROM observations WHERE id = ?').get(id).narrative;

describe('verify-apply does not write over a change another process commits while it waits', () => {
  it('--apply aborts, removes its backup, and leaves the other process’s write', async () => {
    const id = seed();
    const plan = planEdit(id);
    const backupDir = join(dir, 'backups');
    const { done: committed } = await holdLockAndWrite(id);
    const start = Date.now();
    let error = null;
    try {
      runVerifyApply(db, plan, { backupDir });
    } catch (e) {
      error = e;
    }
    const end = Date.now();
    const commitAt = await committed;
    expect(start).toBeLessThan(commitAt); // premise: it started while the lock was held…
    expect(end).toBeGreaterThanOrEqual(commitAt); // …and returned only after the commit
    expect(error?.message).toMatch(/changed since the backup was taken — aborted, nothing written/);
    expect(narrative(id)).toBe(CONCURRENT);
    expect(readdirSync(backupDir)).toEqual([]);
  });

  it('--undo refuses, writes nothing, and leaves the other process’s write', async () => {
    const id = seed();
    const backupDir = join(dir, 'backups');
    const { backupPath } = runVerifyApply(db, planEdit(id), { backupDir });
    expect(narrative(id)).toBe(APPROVED); // premise: the apply landed
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
    const { done: committed } = await holdLockAndWrite(id);
    const start = Date.now();
    const res = undoVerifyBackup(db, backup);
    const end = Date.now();
    const commitAt = await committed;
    expect(start).toBeLessThan(commitAt);
    expect(end).toBeGreaterThanOrEqual(commitAt);
    expect(res.restored).toEqual([]);
    expect(res.errors.join('\n')).toMatch(
      new RegExp(`#${id}: changed since the apply \\(narrative\\) — undo refused`),
    );
    expect(narrative(id)).toBe(CONCURRENT);
  });
});
