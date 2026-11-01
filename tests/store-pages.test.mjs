// D#593: checkStorePages, the page check every index rebuild runs first (lib/store-pages.mjs).
//
// An index rebuild frees pages and allocates new ones, so on a store whose freelist lists a page a
// table still uses, the rebuild writes the new index over that table's rows (D#591, v6.30.9 r1). The
// first attempt read the freelist through serialize(), which fails on any store of 2 GiB or more, on a
// read-write handle whose close checkpoints the log (v6.30.9 r1b). This one reads page 1 and the trunk
// pages from the files, as the check's own read transaction sees them, and works on a read-only handle.
//
// SQLite's integrity check cannot be the check on its own: in SQLite 3.53.4 it skips the freelist and
// the unused-page scan whenever a virtual table comes first in its schema walk, which is the case on a
// VACUUMed store and on every VACUUM INTO snapshot (the 'vacuum' cases below read 'ok' there).

import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStorePages } from '../lib/store-pages.mjs';
import * as schema from '../schema.mjs';
import {
  makeFixtureTracker,
  writeCrossLinkedStore,
  writeStorePastLockPage,
  writeStoreSnapshot,
  writeStoreWithReservedBytes,
} from './test-helpers.mjs';

const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());
const dataDir = () => fixtures.track(mkdtempSync(join(tmpdir(), 'cml-pages-')));
const storeIn = (dir) => join(dir, 'claude-mem-lite.db');
/** sha1 of the main file and its log together (a missing log reads as an empty one). */
const sha = (path) => {
  const h = createHash('sha1').update(readFileSync(path));
  if (existsSync(`${path}-wal`)) h.update(readFileSync(`${path}-wal`));
  return h.digest('hex');
};

/** The rows SQLite's own integrity check returns, from a copy. */
const integrityRows = (path) => {
  const copy = join(dataDir(), 'premise.db');
  copyFileSync(path, copy);
  if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
  const db = new Database(copy, { readonly: true });
  try {
    return db.prepare('PRAGMA integrity_check(10)').pluck().all();
  } finally {
    db.close();
  }
};

/** checkStorePages on a fresh read-only handle to `path`, the way doctor and fts-check rebuild run it. */
const gate = (path, prepare) => {
  const db = new Database(path, { readonly: true });
  try {
    prepare?.(db);
    return checkStorePages(db);
  } finally {
    db.close();
  }
};

/** Rewrites the store's file image, after the last handle on it has closed. */
const editImage = (path, edit) => {
  const image = readFileSync(path);
  const pageSize = image.readUInt16BE(16) === 1 ? 65536 : image.readUInt16BE(16);
  edit(image, { pageSize, trunkAt: (image.readUInt32BE(32) - 1) * pageSize });
  writeFileSync(path, image);
};

const healthy = () => writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false });

describe('checkStorePages passes the stores a rebuild may write into', () => {
  it('a live store with a freelist', () => {
    expect(gate(healthy().path)).toEqual({ state: 'ok', lines: [], more: 0 });
  });

  it('a VACUUMed store with a freelist', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false, vacuum: true });
    expect(gate(path)).toMatchObject({ state: 'ok' });
  });

  it('a VACUUM INTO snapshot', () => {
    expect(gate(writeStoreSnapshot(join(dataDir(), 'snap.db'), { observations: 40 }))).toMatchObject({
      state: 'ok',
    });
  });

  it('a store whose only damage is an ordinary index, which REINDEX repairs', () => {
    const path = writeStoreSnapshot(join(dataDir(), 'snap.db'), { damage: 'index' });
    expect(integrityRows(path).join('\n'), 'premise: integrity_check fails').toMatch(/missing from index/);
    expect(gate(path)).toMatchObject({ state: 'ok' });
  });

  it('a store whose only damage is the search index', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0 });
    const db = new Database(path);
    try {
      expect(schema.checkFTSIntegrity(db).healthy, 'premise: FTS5 check fails').toBe(false);
    } finally {
      db.close();
    }
    expect(gate(path)).toMatchObject({ state: 'ok' });
  });

  // The freelist the check reads comes from the log, not the main file, for everything another
  // connection committed after the last checkpoint: here a freelist made and partly reused.
  it('a store whose log holds pages another connection has not checkpointed', () => {
    const { path } = healthy();
    const writer = new Database(path);
    try {
      writer.pragma('wal_autocheckpoint = 0');
      writer.exec('CREATE TABLE junk2 (x)');
      const put = writer.prepare('INSERT INTO junk2 VALUES (?)');
      writer.transaction(() => {
        for (let i = 0; i < 80; i++) put.run('j'.repeat(1000));
      })();
      writer.exec('DROP TABLE junk2');
      writer.prepare('DELETE FROM observations WHERE id % 3 = 0').run();
      expect(readFileSync(`${path}-wal`).length, 'premise: the log holds frames').toBeGreaterThan(100_000);
      expect(gate(path)).toMatchObject({ state: 'ok' });
      // The writer's own connection, the way mem_fts_check runs it.
      expect(checkStorePages(writer)).toMatchObject({ state: 'ok' });
    } finally {
      writer.close();
    }
  });

  // SQLite names the log after the store's real path, so a store reached through a symlink has its
  // log beside the target: a check that looked beside the link would find no log index at all.
  it('a store reached through a symlink, with its log beside the target', () => {
    const { path } = healthy();
    const link = join(dataDir(), 'claude-mem-lite.db');
    symlinkSync(path, link);
    const writer = new Database(link);
    try {
      writer.pragma('wal_autocheckpoint = 0');
      writer.prepare('DELETE FROM observations WHERE id % 2 = 0').run();
      expect(
        existsSync(`${path}-wal`) && !existsSync(`${link}-wal`),
        'premise: the log is beside the target',
      ).toBe(true);
      expect(gate(link)).toMatchObject({ state: 'ok' });
    } finally {
      writer.close();
    }
  });

  // A rollback-journal store has no log index: its read transaction's lock alone holds the state.
  it('a store in rollback-journal mode, sound and cross-linked', () => {
    const sound = healthy().path;
    const linked = writeCrossLinkedStore(storeIn(dataDir()), { ftsDamage: false });
    for (const p of [sound, linked.path]) {
      const db = new Database(p);
      db.pragma('journal_mode = DELETE');
      db.close();
      expect(readFileSync(p)[18], 'premise: a rollback-journal header').toBe(1);
    }
    expect(gate(sound)).toMatchObject({ state: 'ok' });
    expect(gate(linked.path).lines).toContain(
      `page ${linked.linked[0]}: in the freelist and in observations`,
    );
  });

  for (const mode of ['FULL', 'INCREMENTAL']) {
    it(`an auto_vacuum=${mode} store, whose pointer-map pages are in use`, () => {
      const path = storeIn(dataDir());
      const db = new Database(path);
      try {
        db.pragma(`auto_vacuum = ${mode}`);
        db.pragma('journal_mode = WAL');
        db.exec('CREATE TABLE t (x); CREATE TABLE junk (x)');
        const put = db.prepare('INSERT INTO junk VALUES (?)');
        db.transaction(() => {
          for (let i = 0; i < 300; i++) put.run('j'.repeat(1500));
        })();
        db.prepare('INSERT INTO t VALUES (?)').run('kept');
        db.exec('DROP TABLE junk');
        db.pragma('wal_checkpoint(TRUNCATE)');
        expect(db.pragma('auto_vacuum', { simple: true }), 'premise').toBe(mode === 'FULL' ? 1 : 2);
      } finally {
        db.close();
      }
      expect(integrityRows(path), 'premise: SQLite reads it as sound').toEqual(['ok']);
      expect(gate(path)).toMatchObject({ state: 'ok' });
    });
  }

  it('a store whose pages keep reserved bytes', () => {
    const path = writeStoreWithReservedBytes(storeIn(dataDir()));
    expect(integrityRows(path), 'premise').toEqual(['ok']);
    expect(gate(path)).toMatchObject({ state: 'ok' });
  });

  for (const pageSize of [4096, 65536]) {
    it(`a store of ${pageSize}-byte pages that runs past the lock-byte page`, () => {
      const { path, lockPage, pages } = writeStorePastLockPage(storeIn(dataDir()), { pageSize });
      expect(pages, 'premise: the store runs past the lock-byte page').toBeGreaterThan(lockPage);
      // In place, read-only: a copy of the sparse file could write out the whole gigabyte.
      const db = new Database(path, { readonly: true });
      try {
        expect(db.prepare('PRAGMA integrity_check(10)').pluck().all(), 'premise').toEqual(['ok']);
      } finally {
        db.close();
      }
      expect(gate(path)).toMatchObject({ state: 'ok' });
    });
  }
});

describe('checkStorePages finds page-level damage', () => {
  it('a VACUUMed store whose freelist lists a live leaf, which the integrity check reads as ok', () => {
    const { path, linked } = writeCrossLinkedStore(storeIn(dataDir()), { vacuum: true, ftsDamage: false });
    expect(integrityRows(path), 'premise: the integrity check misses it').toEqual(['ok']);
    const r = gate(path);
    expect(r.state).toBe('damaged');
    expect(r.lines).toContain(`page ${linked[0]}: in the freelist and in observations`);
  });

  it('the same on a store never VACUUMed, where the integrity check sees it too', () => {
    const { path, linked } = writeCrossLinkedStore(storeIn(dataDir()), { ftsDamage: false });
    expect(integrityRows(path).join('\n'), 'premise').toMatch(
      new RegExp(`2nd reference to page ${linked[0]}`),
    );
    const r = gate(path);
    expect(r.state).toBe('damaged');
    expect(r.lines).toContain(`page ${linked[0]}: in the freelist and in observations`);
  });

  // The damage is only in a log frame; a read-only check reads it there and writes nothing, where a
  // read-write handle's close checkpoints it into the main file (v6.30.9 r1b defects P1-1).
  for (const vacuum of [false, true]) {
    it(`a freelist that lists a live leaf only in the log${vacuum ? ', VACUUMed' : ''}, read without a write`, () => {
      const { path, linked } = writeCrossLinkedStore(storeIn(dataDir()), {
        inLog: true,
        vacuum,
        ftsDamage: false,
      });
      const before = sha(path);
      const r = gate(path);
      expect(r.state).toBe('damaged');
      expect(r.lines).toContain(`page ${linked[0]}: in the freelist and in observations`);
      expect(sha(path), 'the check wrote to the store or its log').toBe(before);
    });
  }

  it("a leaf page whose cell pointers are garbled (SQLite's own check)", () => {
    const r = gate(writeStoreSnapshot(join(dataDir(), 'snap.db'), { damage: 'page' }));
    expect(r.state).toBe('damaged');
    expect(r.lines.join('\n')).toMatch(/^Tree \d+ page \d+/m);
  });

  // SQLite's check throws here instead of returning its rows: the throw is the finding.
  it('a leaf whose page type is garbled, where the check throws', () => {
    const { path } = healthy();
    const db = new Database(path, { readonly: true });
    const leaf = db
      .prepare(
        "SELECT pageno FROM dbstat WHERE name = 'observations' AND pagetype = 'leaf' ORDER BY pageno LIMIT 1",
      )
      .pluck()
      .get();
    db.close();
    editImage(path, (image, { pageSize }) => {
      image[(leaf - 1) * pageSize] = 0;
    });
    expect(gate(path)).toMatchObject({ state: 'damaged', lines: ['database disk image is malformed'] });
  });

  it('a page that nothing uses', () => {
    const { path } = healthy();
    let dropped;
    editImage(path, (image, { trunkAt }) => {
      const n = image.readUInt32BE(trunkAt + 4);
      dropped = image.readUInt32BE(trunkAt + 8 + 4 * (n - 1));
      image.writeUInt32BE(n - 1, trunkAt + 4);
      image.writeUInt32BE(image.readUInt32BE(36) - 1, 36);
    });
    expect(gate(path)).toMatchObject({ state: 'damaged', lines: [`page ${dropped}: never used`] });
  });

  it('a freelist that holds fewer pages than the header says', () => {
    const { path } = healthy();
    editImage(path, (image) => image.writeUInt32BE(image.readUInt32BE(36) + 1, 36));
    const r = gate(path);
    expect(r.state).toBe('damaged');
    expect(r.lines.join('\n')).toMatch(/^the freelist: \d+ pages listed, the header says \d+$/m);
  });

  it('a freelist that lists a page past the end of the file', () => {
    const { path } = healthy();
    editImage(path, (image, { pageSize, trunkAt }) => {
      image.writeUInt32BE(image.length / pageSize + 5, trunkAt + 8);
    });
    const r = gate(path);
    expect(r.state).toBe('damaged');
    expect(r.lines.join('\n')).toMatch(/^the freelist: invalid page number \d+$/m);
  });

  it('a freelist trunk page that lists more pages than a page can hold', () => {
    const { path } = healthy();
    let trunk;
    editImage(path, (image, { trunkAt }) => {
      trunk = image.readUInt32BE(32);
      image.writeUInt32BE(0x00ffffff, trunkAt + 4);
    });
    expect(gate(path).lines).toContain(`the freelist: trunk page ${trunk} lists 16777215 pages`);
  });

  // The limit is set by the usable part of a page, not the whole page: between the two, only this
  // check's own line names the trunk page (SQLite's freelist check words it differently).
  it('a trunk page over the limit of the usable part of a page with reserved bytes', () => {
    const path = writeStoreWithReservedBytes(storeIn(dataDir()), { reserved: 32 });
    let trunk;
    let over;
    editImage(path, (image, { pageSize, trunkAt }) => {
      trunk = image.readUInt32BE(32);
      over = (pageSize - 32) / 4 - 1;
      expect(over, 'premise: within the whole page').toBeLessThanOrEqual(pageSize / 4 - 2);
      image.writeUInt32BE(over, trunkAt + 4);
    });
    expect(gate(path).lines).toContain(`the freelist: trunk page ${trunk} lists ${over} pages`);
  });

  // Two trees on the same pages: SQLite checks one table at a time here, so only the check's own
  // count of every page sees it.
  it('two tables on the same pages', () => {
    const { path } = healthy();
    const db = new Database(path);
    try {
      db.exec('CREATE TABLE twin_a (x); CREATE TABLE twin_b (x)');
      db.prepare('INSERT INTO twin_a VALUES (?)').run('a'.repeat(5000));
      db.unsafeMode(true);
      db.pragma('writable_schema = ON');
      db.exec(
        "UPDATE sqlite_master SET rootpage = (SELECT rootpage FROM sqlite_master WHERE name = 'twin_a') WHERE name = 'twin_b'",
      );
    } finally {
      db.close();
    }
    expect(gate(path).lines.join('\n')).toMatch(/^page \d+: in twin_a and in twin_b$/m);
  });
});

describe('checkStorePages reads the freelist from the state its own transaction sees', () => {
  /** Runs `between` the first time the check asks SQLite for the page count, after it has pinned its read. */
  const atPageCount = (between) => (db) => {
    const pragma = db.pragma.bind(db);
    let fired = 0;
    db.pragma = (sql, ...rest) => {
      if (fired === 0 && sql === 'page_count') {
        fired++;
        between();
      }
      return pragma(sql, ...rest);
    };
    return () => fired;
  };

  // A commit after the pin moves pages between the freelist and a new table: read from the newest
  // frames, the freelist and the trees would come from two states of the store.
  it('a commit after its read began is not read', () => {
    const { path } = healthy();
    const writer = new Database(path);
    let wrote = 0;
    try {
      writer.pragma('wal_autocheckpoint = 0');
      const r = gate(path, (db) => {
        atPageCount(() => {
          writer.exec('CREATE TABLE late (x); INSERT INTO late VALUES (randomblob(20000))');
          wrote++;
        })(db);
      });
      expect(wrote, 'premise: the write landed inside the check').toBe(1);
      expect(r).toMatchObject({ state: 'ok' });
    } finally {
      writer.close();
    }
  });

  // Every frame already in the main file: the reader may hold read lock 0 and read the main file alone,
  // while a writer restarts the log over the old frames.
  it('a log restarted over its frames while it reads', () => {
    const { path } = healthy();
    const writer = new Database(path);
    try {
      writer.pragma('wal_autocheckpoint = 0');
      writer.prepare('DELETE FROM observations WHERE id % 5 = 0').run();
      const [{ busy, log, checkpointed }] = writer.pragma('wal_checkpoint(PASSIVE)');
      expect(
        { busy, all: log === checkpointed && log > 0 },
        'premise: every frame is in the main file',
      ).toEqual({
        busy: 0,
        all: true,
      });
      const salt = () => readFileSync(`${path}-wal`).subarray(16, 24).toString('hex');
      const before = salt();
      let after = null;
      const r = gate(path, (db) => {
        atPageCount(() => {
          writer.exec('CREATE TABLE late (x); INSERT INTO late VALUES (randomblob(20000))');
          after = salt();
        })(db);
      });
      expect(after, 'premise: the writer restarted the log (new salt)').not.toBe(before);
      expect(r).toMatchObject({ state: 'ok' });
    } finally {
      writer.close();
    }
  });

  // The defences behind the pin: a read that is not the transaction's is "not checked", never a
  // verdict. Faked by writing to the files under SQLite after the pin, which no SQLite writer does.
  describe('a file read that disagrees with the transaction', () => {
    const tamper = (path, file, at, bytes) => {
      const fd = openSync(file, 'r+');
      try {
        writeSync(fd, Buffer.from(bytes), 0, bytes.length, at);
      } finally {
        closeSync(fd);
      }
    };
    it("page 1's header against SQLite's", () => {
      const { path } = healthy();
      const r = gate(path, (db) => atPageCount(() => tamper(path, path, 36, [0, 0, 0x7f, 0x7f]))(db));
      expect(r).toMatchObject({ state: 'unchecked' });
      expect(r.error).toMatch(/^page 1 reads freelist_count \d+, SQLite \d+$/);
    });
    for (const [what, at, re] of [
      ['the log header', 16, /^the log does not match its index$/],
      ['a log frame', 32 + 8, /^log frame 1 does not match its index$/],
    ]) {
      it(`${what}'s salt against the log index`, () => {
        const { path } = healthy();
        const writer = new Database(path);
        try {
          writer.pragma('wal_autocheckpoint = 0');
          writer.prepare('DELETE FROM observations WHERE id % 4 = 0').run();
          const r = gate(path, (db) =>
            atPageCount(() => tamper(path, `${path}-wal`, at, [1, 2, 3, 4, 5, 6, 7, 8]))(db),
          );
          expect(r).toMatchObject({ state: 'unchecked' });
          expect(r.error).toMatch(re);
        } finally {
          writer.close();
        }
      });
    }
  });

  // The same restart, when the frames were not all in the main file as the check began but a
  // checkpoint copied the rest just before its read transaction started: the reader then holds read
  // lock 0, so whether to read the log is decided by nBackfill as the transaction sees it.
  it('a checkpoint just before its read began, then a log restart while it reads', () => {
    const { path } = healthy();
    const writer = new Database(path);
    try {
      writer.pragma('wal_autocheckpoint = 0');
      writer.prepare('DELETE FROM observations WHERE id % 5 = 0').run();
      const salt = () => readFileSync(`${path}-wal`).subarray(16, 24).toString('hex');
      const before = salt();
      let checkpointed = null;
      let after = null;
      const r = gate(path, (db) => {
        const exec = db.exec.bind(db);
        db.exec = (sql) => {
          if (sql === 'BEGIN' && checkpointed === null) {
            const [{ busy, log, checkpointed: done }] = writer.pragma('wal_checkpoint(PASSIVE)');
            checkpointed = busy === 0 && log === done && log > 0;
          }
          return exec(sql);
        };
        atPageCount(() => {
          writer.exec('CREATE TABLE late (x); INSERT INTO late VALUES (randomblob(20000))');
          after = salt();
        })(db);
      });
      expect(checkpointed, 'premise: every frame reached the main file just before BEGIN').toBe(true);
      expect(after, 'premise: the writer restarted the log (new salt)').not.toBe(before);
      expect(r).toMatchObject({ state: 'ok' });
    } finally {
      writer.close();
    }
  });

  it('says it could not check when every try is overtaken by a commit', () => {
    const { path } = healthy();
    const writer = new Database(path);
    try {
      writer.exec('CREATE TABLE ticks (n)');
      const tick = writer.prepare('INSERT INTO ticks VALUES (1)');
      let commits = 0;
      const r = gate(path, (db) => {
        const exec = db.exec.bind(db);
        db.exec = (sql) => {
          if (sql === 'BEGIN') {
            tick.run();
            commits++;
          }
          return exec(sql);
        };
      });
      expect(r).toMatchObject({ state: 'unchecked', code: 'SQLITE_BUSY' });
      expect(r.error).toMatch(/kept changing/);
      expect(commits, 'premise: each try was overtaken').toBeGreaterThan(1);
    } finally {
      writer.close();
    }
  });

  it('tries again when one try is overtaken', () => {
    const { path } = healthy();
    const writer = new Database(path);
    try {
      writer.exec('CREATE TABLE ticks (n)');
      const tick = writer.prepare('INSERT INTO ticks VALUES (1)');
      let begins = 0;
      const r = gate(path, (db) => {
        const exec = db.exec.bind(db);
        db.exec = (sql) => {
          if (sql === 'BEGIN' && begins++ === 0) tick.run();
          return exec(sql);
        };
      });
      expect(begins, 'premise: a second try ran').toBe(2);
      expect(r).toMatchObject({ state: 'ok' });
    } finally {
      writer.close();
    }
  });
});

describe('checkStorePages says it could not check, rather than passing', () => {
  it('an in-memory database', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE t (x)');
      expect(checkStorePages(db)).toMatchObject({
        state: 'unchecked',
        error: 'an in-memory database has no file to read',
      });
    } finally {
      db.close();
    }
  });

  it('a connection inside a transaction, which it leaves to its caller', () => {
    const { path } = healthy();
    const db = new Database(path);
    try {
      db.exec('BEGIN');
      db.prepare('SELECT 1 FROM observations LIMIT 1').get();
      expect(checkStorePages(db)).toMatchObject({ state: 'unchecked' });
      expect(db.inTransaction, "the caller's transaction is still open").toBe(true);
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  });

  it('ends its own transaction whatever it found', () => {
    const { path } = writeCrossLinkedStore(storeIn(dataDir()), { ftsDamage: false });
    const db = new Database(path, { readonly: true });
    try {
      expect(checkStorePages(db).state).toBe('damaged');
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  });
});
