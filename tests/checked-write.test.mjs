// D#593 attempt 3: a rebuild commits only when the store's structure reads sound inside the very
// transaction that wrote it. On a store whose freelist lists a live page, an index rebuild hands that
// page to the new index and overwrites its rows (D#591: 300 -> 287 intact); the rebuilt page then sits
// in two trees, which PRAGMA quick_check reports before COMMIT, even on a VACUUMed store whose check
// skips the freelist (lesson #1051).
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkedWrite, holdOpen } from '../lib/checked-write.mjs';
import { initSchema } from '../schema.mjs';
import { intactObservations, writeCrossLinkedStore } from './test-helpers.mjs';

const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'cml-checked-write-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});
const sha = (p) => createHash('sha1').update(readFileSync(p)).digest('hex');
const FTS = ['observations_fts', 'session_summaries_fts', 'user_prompts_fts', 'events_fts'];
const rebuildSteps = FTS.map((t) => ({ name: t, sql: `INSERT INTO ${t}(${t}) VALUES('rebuild')` }));

function soundStore() {
  const p = join(tempDir(), 'claude-mem-lite.db');
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  db.exec('CREATE TABLE side (x)');
  db.close();
  return p;
}

describe('checkedWrite', () => {
  it('commits every step on a sound store', () => {
    const db = new Database(soundStore());
    try {
      const r = checkedWrite(db, [...rebuildSteps, { name: 'side', sql: 'INSERT INTO side VALUES (1)' }]);
      expect(r).toMatchObject({ committed: true, check: 'ok', failedStep: null });
      expect(r.done).toEqual([...FTS, 'side']);
      expect(db.inTransaction).toBe(false);
      expect(db.prepare('SELECT count(*) AS n FROM side').get().n).toBe(1);
    } finally {
      db.close();
    }
  });

  for (const vacuum of [false, true]) {
    for (const inLog of [false, true]) {
      for (const links of [1, 3]) {
        it(`rolls back a rebuild on a cross-linked store (vacuum ${vacuum}, in log ${inLog}, links ${links})`, () => {
          const p = join(tempDir(), 'claude-mem-lite.db');
          const { truth } = writeCrossLinkedStore(p, { vacuum, inLog, links });
          // Premise: the same rebuild written directly loses rows on this shape.
          // The control starts from the same bytes, log included.
          const control = join(tempDir(), 'claude-mem-lite.db');
          for (const ext of ['', '-wal']) if (existsSync(p + ext)) copyFileSync(p + ext, control + ext);
          const c = new Database(control);
          for (const s of rebuildSteps) {
            try {
              c.exec(s.sql);
            } catch {
              /* the direct path keeps going, as rebuildFTS did */
            }
          }
          c.close();
          expect(intactObservations(control, truth)).toBeLessThan(truth.length);

          const holder = holdOpen(Database, p);
          const db = new Database(p);
          let r;
          try {
            r = checkedWrite(db, rebuildSteps);
          } finally {
            db.close();
            holder?.close();
          }
          expect(r.committed).toBe(false);
          expect(r.check).toBe('damaged');
          expect(r.done).toEqual([]);
          expect(intactObservations(p, truth)).toBe(truth.length);
          expect(intactObservations(p, truth, { mainOnly: true })).toBe(truth.length);
        });
      }
    }
  }

  it('reads a step that fails with corruption as damaged, not as unchecked', () => {
    // With three cross-links REINDEX itself throws SQLITE_CORRUPT after the FTS rebuilds ran: the
    // caller has to point at the snapshots, not at "try again".
    const p = join(tempDir(), 'claude-mem-lite.db');
    const { truth } = writeCrossLinkedStore(p, { links: 3 });
    const db = new Database(p);
    let r;
    try {
      r = checkedWrite(db, [...rebuildSteps, { name: 'indexes', sql: 'REINDEX' }]);
    } finally {
      db.close();
    }
    expect(r).toMatchObject({
      committed: false,
      check: 'damaged',
      failedStep: 'indexes',
      code: 'SQLITE_CORRUPT',
    });
    expect(intactObservations(p, truth)).toBe(truth.length);
  });

  it('stops at the first failing step and writes nothing', () => {
    const db = new Database(soundStore());
    try {
      const r = checkedWrite(db, [
        { name: 'first', sql: 'INSERT INTO side VALUES (1)' },
        { name: 'broken', sql: 'INSERT INTO no_such_table VALUES (1)' },
        { name: 'after', sql: 'INSERT INTO side VALUES (2)' },
      ]);
      // A failure of the store's own (here SQLITE_ERROR) is damage; only the environment's is not.
      expect(r).toMatchObject({ committed: false, failedStep: 'broken', check: 'damaged', done: [] });
      expect(r.error).toMatch(/no such table/);
      expect(db.prepare('SELECT count(*) AS n FROM side').get().n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('reads a step the environment failed (a full disk) as unchecked, not as damage', () => {
    const db = new Database(soundStore());
    try {
      db.pragma(`max_page_count = ${db.pragma('page_count', { simple: true })}`);
      const r = checkedWrite(db, [
        {
          name: 'fill',
          sql: 'INSERT INTO side SELECT hex(randomblob(4000)) FROM (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3)',
        },
      ]);
      expect(r).toMatchObject({
        committed: false,
        check: 'unchecked',
        failedStep: 'fill',
        code: 'SQLITE_FULL',
      });
    } finally {
      db.close();
    }
  });

  it('stops when a step ends the transaction, so nothing after it runs in autocommit', () => {
    // SQLITE_FULL / IOERR / BUSY / NOMEM can roll the whole transaction back by themselves; a step
    // that does it on purpose stands in for them.
    const db = new Database(soundStore());
    try {
      const r = checkedWrite(db, [
        { name: 'ends it', sql: 'ROLLBACK' },
        { name: 'after', sql: 'INSERT INTO side VALUES (1)' },
      ]);
      expect(r).toMatchObject({ committed: false, failedStep: 'ends it', check: 'unchecked' });
      expect(db.prepare('SELECT count(*) AS n FROM side').get().n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('does not report a commit that failed as committed', () => {
    // A deferred foreign key is checked at COMMIT, which then throws with every step done and the
    // structure sound.
    const db = new Database(soundStore());
    try {
      db.pragma('foreign_keys = ON');
      db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
      db.exec('CREATE TABLE child (pid REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)');
      const r = checkedWrite(db, [{ name: 'orphan', sql: 'INSERT INTO child VALUES (42)' }]);
      expect(r).toMatchObject({ committed: false, check: 'unchecked', code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
      expect(db.inTransaction).toBe(false);
      expect(db.prepare('SELECT count(*) AS n FROM child').get().n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('writes nothing when the handle is already inside a transaction', () => {
    const db = new Database(soundStore());
    try {
      db.exec('BEGIN');
      const r = checkedWrite(db, [{ name: 'side', sql: 'INSERT INTO side VALUES (1)' }]);
      expect(r).toMatchObject({ committed: false, check: 'unchecked', done: [] });
      expect(db.prepare('SELECT count(*) AS n FROM side').get().n).toBe(0);
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  });

  it('writes nothing when another connection holds the write lock', () => {
    const p = soundStore();
    const other = new Database(p);
    const db = new Database(p);
    try {
      other.exec('BEGIN IMMEDIATE');
      db.pragma('busy_timeout = 0');
      const r = checkedWrite(db, [{ name: 'side', sql: 'INSERT INTO side VALUES (1)' }]);
      expect(r).toMatchObject({ committed: false, check: 'unchecked', code: 'SQLITE_BUSY' });
      other.exec('ROLLBACK');
      expect(db.prepare('SELECT count(*) AS n FROM side').get().n).toBe(0);
    } finally {
      db.close();
      other.close();
    }
  });
});

describe('holdOpen', () => {
  // With the cross-link only in a log frame, a read-write handle that is the store's last connection
  // checkpoints that frame into the main file when it closes (v6.30.9 r1b defects P1-1), even after a
  // rollback. A read-only connection held across the close keeps it from being the last one.
  for (const held of [true, false]) {
    it(`${held ? 'keeps' : 'without it, does not keep'} the main file unchanged across a refused rebuild`, () => {
      const p = join(tempDir(), 'claude-mem-lite.db');
      writeCrossLinkedStore(p, { inLog: true });
      const before = sha(p);
      const holder = held ? holdOpen(Database, p) : null;
      const db = new Database(p);
      try {
        expect(checkedWrite(db, rebuildSteps).committed).toBe(false);
      } finally {
        db.close();
        holder?.close();
      }
      if (held) expect(sha(p)).toBe(before);
      else expect(sha(p)).not.toBe(before);
    });
  }

  it('returns null rather than throwing when the store cannot be opened', () => {
    expect(holdOpen(Database, join(tempDir(), 'missing', 'claude-mem-lite.db'))).toBeNull();
  });
});
