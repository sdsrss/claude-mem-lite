// Shared test utilities for claude-mem-lite
// Single source of truth: uses initSchema — no DDL duplication

import Database from 'better-sqlite3';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { initSchema } from '../schema.mjs';
import { fileMatchClause, fileMatchParams } from '../lib/file-edge-match.mjs';

/**
 * Create an in-memory test database with full production schema + FTS5.
 * Uses initSchema() from schema.mjs — single source of truth.
 */
export function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  return initSchema(db);
}

/**
 * A backup snapshot the way lib/db-backup.mjs's snapshotDb writes one: VACUUM INTO of a WAL store
 * initSchema built, holding `observations` rows (D#558). `damage`:
 * - 'fts': the leaf rows of observations_fts_data deleted before the VACUUM, so the snapshot's
 *   search index is damaged and every observation is intact;
 * - 'index': one index on observations given a definition its entries do not match, so
 *   integrity_check fails on that index alone and REINDEX repairs it;
 * - 'fts-config': observations_fts_config's version set to 0, which FTS5 refuses to open and no
 *   rebuild repairs;
 * - 'lost-rows': all but 3 observations gone from the table while every ordinary index on it still
 *   lists all of them ("wrong # of entries in index idx_obs_epoch_project"); REINDEX makes it
 *   consistent and short. The rows go by a DELETE, so the FTS5 docsize table loses them too: the
 *   shape of an index that kept a delete's rows. The 73 short snapshots of the D#558 corpus lost
 *   theirs from the table, and their docsize still lists them (v6.30.8 r1 claims F11);
 * - 'page': the cell pointers of the observations table's first leaf page garbled;
 * - 'header': the 16-byte file header overwritten.
 * @param {string} path
 * @param {{observations?: number, damage?: 'fts'|'index'|'fts-config'|'lost-rows'|'page'|'header'|null}} [opts]
 * @returns {string} `path`
 */
export function writeStoreSnapshot(path, { observations = 12, damage = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cml-storefx-'));
  try {
    const live = new Database(join(dir, 'live.db'));
    live.pragma('journal_mode = WAL');
    live.pragma('foreign_keys = OFF');
    initSchema(live);
    live
      .prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
         VALUES ('c-s1', 's1', 'p', datetime('now'), 1)`,
      )
      .run();
    const insert = live.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
       VALUES ('s1', 'p', 'discovery', ?, ?, datetime('now'), ?)`,
    );
    for (let i = 0; i < observations; i++) {
      insert.run(`title ${i} alpha`, `narrative ${i} ${'x'.repeat(200)}`, 1_700_000_000_000 + i);
    }
    if (damage === 'fts') {
      live.unsafeMode(true);
      const n = live.prepare('DELETE FROM observations_fts_data WHERE id > 10').run().changes;
      if (n === 0) throw new Error('fixture did not damage anything: observations_fts_data had no leaf rows');
      live.unsafeMode(false);
    }
    live.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    live.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (damage === 'index' || damage === 'fts-config') {
    // On the snapshot itself, which VACUUM INTO writes in rollback mode, so nothing is left beside it.
    const db = new Database(path);
    db.unsafeMode(true);
    if (damage === 'index') {
      // An index whose definition no longer matches its entries: integrity_check reports rows
      // missing from it, and REINDEX rebuilds it from the table (the D#562a shape).
      const idx = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'observations' AND sql IS NOT NULL ORDER BY name LIMIT 1",
        )
        .pluck()
        .get();
      if (!idx) throw new Error('fixture found no index on observations');
      db.pragma('writable_schema = ON');
      db.prepare('UPDATE sqlite_master SET sql = ? WHERE name = ?').run(
        `CREATE INDEX ${idx} ON observations(title)`,
        idx,
      );
    } else {
      // "invalid fts5 file format (found 0, expected 4 or 5)", which no rebuild repairs (D#562b).
      const n = db.prepare("UPDATE observations_fts_config SET v = 0 WHERE k = 'version'").run().changes;
      if (n === 0)
        throw new Error('fixture did not damage anything: observations_fts_config had no version row');
    }
    db.close();
  }
  if (damage === 'lost-rows') {
    // The indexes leave the schema while the rows go, so nothing removes their entries.
    const db = new Database(path);
    db.unsafeMode(true);
    const idx = db
      .prepare(
        "SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'observations' AND sql IS NOT NULL",
      )
      .all();
    if (idx.length === 0) throw new Error('fixture found no index on observations');
    db.pragma('writable_schema = ON');
    db.prepare(
      "DELETE FROM sqlite_master WHERE type = 'index' AND tbl_name = 'observations' AND sql IS NOT NULL",
    ).run();
    db.close();
    const h = new Database(path);
    h.pragma('foreign_keys = OFF');
    if (h.prepare('DELETE FROM observations WHERE id > 3').run().changes === 0) {
      throw new Error('fixture removed no observation: ask for more than 3');
    }
    h.unsafeMode(true);
    h.pragma('writable_schema = ON');
    const put = h.prepare(
      'INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES (?, ?, ?, ?, ?)',
    );
    for (const r of idx) put.run(r.type, r.name, r.tbl_name, r.rootpage, r.sql);
    h.close();
  }
  if (damage === 'page' || damage === 'header') {
    const image = readFileSync(path);
    if (damage === 'header') {
      image.write('not a database!!', 0, 'latin1');
    } else {
      // The page number from dbstat on an in-memory copy of the image (a Buffer opens as a memdb),
      // so the snapshot file itself is never opened.
      const copy = Buffer.from(image);
      const mem = new Database(copy);
      const pageno = mem
        .prepare(
          "SELECT pageno FROM dbstat WHERE name = 'observations' AND pagetype = 'leaf' ORDER BY pageno LIMIT 1",
        )
        .pluck()
        .get();
      mem.close();
      if (!pageno) throw new Error('fixture found no leaf page of observations');
      const pageSize = image.readUInt16BE(16) === 1 ? 65536 : image.readUInt16BE(16);
      const at = (pageno - 1) * pageSize + (pageno === 1 ? 100 : 0);
      for (let i = at + 8; i < at + 40; i++) image[i] ^= 0xff;
    }
    writeFileSync(path, image);
  }
  return path;
}

/** The SQLite WAL checksum over `buf` (8-byte steps), continuing from `s0`, `s1` (wal.c walChecksumBytes). */
function walChecksum(buf, s0, s1, bigEndian) {
  for (let i = 0; i < buf.length; i += 8) {
    const a = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
    const b = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
    s0 = (s0 + a + s1) >>> 0;
    s1 = (s1 + b + s0) >>> 0;
  }
  return [s0, s1];
}

/**
 * Rewrites one page image of the log at `${path}-wal` (the newest frame holding `pageno`) and signs
 * the checksum chain again, so SQLite reads the edit as committed. `edit(page)` changes the Buffer.
 */
export function editLogPage(path, pageno, edit) {
  const wal = Buffer.from(readFileSync(`${path}-wal`));
  const bigEndian = wal.readUInt32BE(0) === 0x377f0683;
  const pageSize = wal.readUInt32BE(8);
  const frames = [];
  for (let at = 32; at + 24 + pageSize <= wal.length; at += 24 + pageSize) frames.push(at);
  const target = frames.filter((at) => wal.readUInt32BE(at) === pageno).pop();
  if (target === undefined) throw new Error(`fixture: page ${pageno} has no frame in the log`);
  edit(wal.subarray(target + 24, target + 24 + pageSize));
  let [s0, s1] = walChecksum(wal.subarray(0, 24), 0, 0, bigEndian);
  for (const at of frames) {
    [s0, s1] = walChecksum(wal.subarray(at, at + 8), s0, s1, bigEndian);
    [s0, s1] = walChecksum(wal.subarray(at + 24, at + 24 + pageSize), s0, s1, bigEndian);
    wal.writeUInt32BE(s0, at + 16);
    wal.writeUInt32BE(s1, at + 20);
  }
  writeFileSync(`${path}-wal`, wal);
  rmSync(`${path}-shm`, { force: true });
}

/**
 * A live store (WAL, initSchema) whose freelist lists `links` leaf pages the observations table
 * still uses: the page-level damage on which an index rebuild overwrites rows, because the rebuild
 * frees and allocates pages and the freelist hands it those leaves (D#591). `ftsDamage` deletes the
 * leaf rows of observations_fts_data first, so FTS5's own check fails and doctor goes on to rebuild.
 * `vacuum` VACUUMs the store before the freelist is made; SQLite 3.53.4's integrity check then
 * starts at a virtual table, skips the freelist and reads 'ok' on this store. `prepare(path)` runs
 * on the closed store before the damage is planted: the product's opener writes on its first open
 * of a store initSchema built, and on these pages any write can overwrite rows.
 * `inLog`: the freelist is made while another connection holds the log open, and the store is copied
 * with its log before any checkpoint, so the cross-link is only in a log frame and the main file on
 * its own is sound: a read-write handle's close then checkpoints the damage into the main file
 * (v6.30.9 r1b defects P1-1).
 * @param {string} path
 * @param {{observations?: number, links?: number, vacuum?: boolean, ftsDamage?: boolean, prepare?: (path: string) => void, inLog?: boolean}} [opts]
 * @returns {{path: string, truth: {id: number, title: string, narrative: string}[], linked: number[]}}
 */
export function writeCrossLinkedStore(
  path,
  { observations = 300, links = 1, vacuum = false, ftsDamage = true, prepare, inLog = false } = {},
) {
  // With inLog the store is built beside `path` and copied to it with its log.
  const build = inLog ? `${path}.build` : path;
  let db = new Database(build);
  let holder = null;
  let truth;
  let leaves;
  try {
    db.pragma('journal_mode = WAL');
    initSchema(db);
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
       VALUES ('c-s1', 's1', 'p', datetime('now'), 1)`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
       VALUES ('s1', 'p', 'discovery', ?, ?, datetime('now'), ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < observations; i++) {
        insert.run(`title ${i} alpha`, `narrative ${i} ${'x'.repeat(200)} w${i}`, 1_700_000_000_000 + i);
      }
    })();
    if (ftsDamage) {
      db.unsafeMode(true);
      if (db.prepare('DELETE FROM observations_fts_data WHERE id > 10').run().changes === 0) {
        throw new Error('fixture did not damage anything: observations_fts_data had no leaf rows');
      }
      db.unsafeMode(false);
    }
    if (vacuum) db.exec('VACUUM');
    if (prepare) {
      db.close();
      prepare(build);
      db = new Database(build);
    }
    if (inLog) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.pragma('wal_autocheckpoint = 0');
      // A second connection keeps the first one's close from checkpointing the log.
      holder = new Database(build, { readonly: true });
      holder.prepare('SELECT 1').get();
    }
    // A dropped table's pages are the freelist.
    db.exec('CREATE TABLE junk (x)');
    const junk = db.prepare('INSERT INTO junk VALUES (?)');
    db.transaction(() => {
      for (let i = 0; i < 60; i++) junk.run('j'.repeat(1000));
    })();
    db.exec('DROP TABLE junk');
    truth = db.prepare('SELECT id, title, narrative FROM observations ORDER BY id').all();
    leaves = db
      .prepare("SELECT pageno FROM dbstat WHERE name = 'observations' AND pagetype = 'leaf' ORDER BY pageno")
      .pluck()
      .all();
    if (inLog) {
      writeFileSync(path, readFileSync(build));
      writeFileSync(`${path}-wal`, readFileSync(`${build}-wal`));
    } else {
      db.pragma('wal_checkpoint(TRUNCATE)');
    }
  } finally {
    db.close();
    holder?.close();
  }
  if (inLog) {
    for (const f of [build, `${build}-wal`, `${build}-shm`]) rmSync(f, { force: true });
  }
  if (leaves.length < links + 2)
    throw new Error(`fixture needs ${links + 2} observations leaves, has ${leaves.length}`);
  const plant = (page, pageSize) => {
    if (page.readUInt32BE(4) < links) throw new Error('fixture freelist trunk lists too few pages');
    leaves.slice(2, 2 + links).forEach((pageno, k) => page.writeUInt32BE(pageno, 8 + 4 * k));
    return pageSize;
  };
  if (inLog) {
    // The freelist's first trunk page, as the log's newest page 1 names it.
    const wal = readFileSync(`${path}-wal`);
    const pageSize = wal.readUInt32BE(8);
    let page1 = null;
    for (let at = 32; at + 24 + pageSize <= wal.length; at += 24 + pageSize) {
      if (wal.readUInt32BE(at) === 1) page1 = wal.subarray(at + 24, at + 24 + pageSize);
    }
    if (!page1) throw new Error('fixture: the log holds no page 1');
    const trunk = page1.readUInt32BE(32);
    if (trunk === 0) throw new Error('fixture made no freelist');
    editLogPage(path, trunk, (page) => plant(page, pageSize));
  } else {
    const image = readFileSync(path);
    const pageSize = image.readUInt16BE(16) === 1 ? 65536 : image.readUInt16BE(16);
    const trunk = image.readUInt32BE(32);
    if (trunk === 0) throw new Error('fixture made no freelist');
    plant(image.subarray((trunk - 1) * pageSize, trunk * pageSize), pageSize);
    writeFileSync(path, image);
  }
  return { path, truth, linked: leaves.slice(2, 2 + links) };
}

/**
 * How many of `truth` read back from the store at `path` (its table, not an index) with the title
 * and narrative they were written with. Opens a copy, so the store and its log are not touched.
 * `mainOnly` reads the main file without its log.
 * @param {string} path
 * @param {{id: number, title: string, narrative: string}[]} truth
 * @param {{mainOnly?: boolean}} [opts]
 */
export function intactObservations(path, truth, { mainOnly = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cml-intact-'));
  try {
    const copy = join(dir, 'copy.db');
    writeFileSync(copy, readFileSync(path));
    if (!mainOnly && existsSync(`${path}-wal`)) writeFileSync(`${copy}-wal`, readFileSync(`${path}-wal`));
    const db = new Database(copy, { readonly: true });
    try {
      const get = db.prepare('SELECT title, narrative FROM observations NOT INDEXED WHERE id = ?');
      let intact = 0;
      for (const t of truth) {
        try {
          const r = get.get(t.id);
          if (r && r.title === t.title && r.narrative === t.narrative) intact++;
        } catch {
          /* a row that does not read is not intact */
        }
      }
      return intact;
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A sound WAL-mode store that runs past the lock-byte page (file offset 1 GiB), with every page after
 * its tables on the freelist: a sparse file, so it costs about a megabyte of disk. The lock-byte page
 * belongs to no tree and is never free, so a check that does not count it reads it as never used.
 * @param {string} path
 * @param {{pageSize?: number}} [opts]
 * @returns {{path: string, lockPage: number, pages: number}}
 */
export function writeStorePastLockPage(path, { pageSize = 4096 } = {}) {
  const db = new Database(path);
  try {
    db.pragma(`page_size = ${pageSize}`);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1), (2)');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  const image = Buffer.from(readFileSync(path));
  if ((image.readUInt16BE(16) === 1 ? 65536 : image.readUInt16BE(16)) !== pageSize) {
    throw new Error(`fixture: page size ${pageSize} was not applied`);
  }
  const used = image.length / pageSize;
  if (image.readUInt32BE(32) !== 0) throw new Error('fixture: expected no freelist yet');
  const lockPage = Math.floor(0x40000000 / pageSize) + 1;
  const pages = lockPage + 8;
  const perTrunk = (pageSize - image[20]) / 4 - 2;
  const free = [];
  for (let p = used + 1; p <= pages; p++) if (p !== lockPage) free.push(p);
  const fd = openSync(path, 'r+');
  try {
    ftruncateSync(fd, pages * pageSize);
    let firstTrunk = 0;
    // Trunks are written last to first so each can name the next.
    const trunks = [];
    for (let i = 0; i < free.length; i += perTrunk + 1) trunks.push(free.slice(i, i + perTrunk + 1));
    for (let k = trunks.length - 1; k >= 0; k--) {
      const [trunk, ...leaves] = trunks[k];
      const page = Buffer.alloc(pageSize);
      page.writeUInt32BE(firstTrunk, 0);
      page.writeUInt32BE(leaves.length, 4);
      leaves.forEach((p, i) => page.writeUInt32BE(p, 8 + 4 * i));
      writeSync(fd, page, 0, pageSize, (trunk - 1) * pageSize);
      firstTrunk = trunk;
    }
    image.writeUInt32BE(pages, 28);
    image.writeUInt32BE(firstTrunk, 32);
    image.writeUInt32BE(free.length, 36);
    // The size at offset 28 counts only while offset 92 equals the change counter at 24.
    image.writeUInt32BE(image.readUInt32BE(24), 92);
    writeSync(fd, image, 0, pageSize, 0);
  } finally {
    closeSync(fd);
  }
  return { path, lockPage, pages };
}

/**
 * A sound WAL-mode store whose pages keep `reserved` bytes at their end (file header offset 20), with
 * a freelist: SQLite's own API sets this only through a file control better-sqlite3 does not expose,
 * so the header of a fresh one-page file is edited before anything else is written, and VACUUM, which
 * keeps the reserve, lays the store out again.
 * @param {string} path
 * @param {{reserved?: number}} [opts]
 * @returns {string} `path`
 */
export function writeStoreWithReservedBytes(path, { reserved = 32 } = {}) {
  let db = new Database(path);
  db.pragma('user_version = 1');
  db.close();
  const image = Buffer.from(readFileSync(path));
  const pageSize = image.readUInt16BE(16) === 1 ? 65536 : image.readUInt16BE(16);
  image[20] = reserved;
  // Page 1's (empty) sqlite_schema leaf: its cell content area starts at the end of the usable part.
  image.writeUInt16BE(pageSize - reserved, 100 + 5);
  writeFileSync(path, image);
  db = new Database(path);
  try {
    db.exec('VACUUM');
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (x); CREATE TABLE junk (x)');
    const put = db.prepare('INSERT INTO junk VALUES (?)');
    db.transaction(() => {
      for (let i = 0; i < 40; i++) put.run('j'.repeat(1000));
    })();
    db.prepare('INSERT INTO t VALUES (?)').run('kept');
    db.exec('DROP TABLE junk');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  if (readFileSync(path)[20] !== reserved) throw new Error('fixture: the reserve did not survive VACUUM');
  return path;
}

export function insertSession(db, { id, project = 'test', memoryId = null }) {
  const now = new Date();
  db.prepare(
    `
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `,
  ).run(id, memoryId ?? id, project, now.toISOString(), now.getTime());
}

/**
 * Insert into user_prompts for tests that need to exercise the
 * prompts-table fallback path in user-prompt-search.js (v2.34.5+).
 * Matches the shape produced by hook-episode.mjs at runtime.
 */
export function insertPrompt(db, { contentSessionId = 'sess-1', text, promptNumber = 1, epochOffset = 0 }) {
  const now = Date.now() + epochOffset;
  const result = db
    .prepare(
      `
    INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `,
    )
    .run(contentSessionId, text, promptNumber, new Date(now).toISOString(), now);
  return result;
}

export function insertObs(
  db,
  {
    sessionId = 'sess-1',
    project = 'test',
    type = 'discovery',
    title,
    subtitle = '',
    text = '',
    narrative = '',
    importance = 1,
    relatedIds = '[]',
    epochOffset = 0,
    filesModified = '[]',
    accessCount = 0,
    compressedInto = null,
    lessonLearned = null,
    searchAliases = null,
    branch = null,
    supersededAt = null,
    supersededBy = null,
    lastAccessedAt = null,
    citedCount = 0,
    uncitedStreak = 0,
    injectionCount = 0,
  },
) {
  const now = Date.now() + epochOffset;
  const result = db
    .prepare(
      `
    INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, related_ids, access_count, compressed_into, lesson_learned, search_aliases, branch, superseded_at, superseded_by, last_accessed_at, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      sessionId,
      project,
      text,
      type,
      title,
      subtitle,
      narrative,
      filesModified,
      importance,
      relatedIds,
      accessCount,
      compressedInto,
      lessonLearned,
      searchAliases,
      branch,
      supersededAt,
      supersededBy,
      lastAccessedAt,
      new Date(now).toISOString(),
      now,
    );
  if (citedCount || uncitedStreak || injectionCount) {
    db.prepare(
      'UPDATE observations SET cited_count = ?, uncited_streak = ?, injection_count = ? WHERE id = ?',
    ).run(citedCount, uncitedStreak, injectionCount, Number(result.lastInsertRowid));
  }

  // Also populate observation_files junction table (mirrors saveObservation behavior)
  if (filesModified && filesModified !== '[]') {
    try {
      const files = JSON.parse(filesModified);
      if (Array.isArray(files)) {
        const obsId = Number(result.lastInsertRowid);
        const insertFile = db.prepare(
          'INSERT OR IGNORE INTO observation_files (obs_id, filename) VALUES (?, ?)',
        );
        for (const f of files) {
          if (typeof f === 'string' && f.length > 0) insertFile.run(obsId, f);
        }
      }
    } catch {
      /* skip malformed JSON */
    }
  }

  return result;
}

/**
 * Run the shipped (obs,file) EDGE-MATCH ARM ONLY — `fileMatchClause` /
 * `fileMatchParams` from lib/file-edge-match.mjs, the pair that
 * scripts/pre-tool-recall.js and lib/edge-attribution.mjs both build on —
 * plus a hand-copied `importance >= 2` gate.
 *
 * It is NOT the shipped injection query, and no caller should read it as one.
 * Everything else in scripts/pre-tool-recall.js is absent here: the
 * `liveObsFilterSql` superseded/compressed filter, the 60-day
 * `created_at_epoch` lookback, the `miss_streak` edge decay, the `scope`
 * filter, the lesson/type fallback, the lesson-first ORDER BY, the Read-1 /
 * Edit-2 LIMIT, the events leg, and the session cooldown. Those clauses are
 * guarded — by the subprocess cases in tests/pre-tool-recall.test.mjs, which
 * drive the real script — not by anything in this helper. The `importance`
 * column it selects is likewise helper-only: the shipped injection query never
 * returns it (D#163).
 *
 * Exists because several suites used to assert edge matching through
 * `recallForFile` (hook-memory.mjs), an in-process twin that had NO production
 * caller and was deleted 2026-08-22. The twin split basenames on either
 * separator while the shipped pair used host-native `basename`, so a real
 * Windows-payload gap sat unobserved behind six green tests. One helper here
 * keeps every caller on the shipped MATCH clause instead of re-deriving it per
 * suite — the twin-drift class this repo has re-opened repeatedly.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} filePath  edited file, either separator, any OS
 * @param {string} project
 * @param {{minImportance?: number}} [opts] `minImportance` re-derives (does not
 *   share) pre-tool-recall.js's `o.importance >= 2` gate; pass 0 to disable.
 * @returns {Array<{id:number,type:string,title:string,importance:number,lesson_learned:string|null}>}
 */
export function fileEdgeMatchOnly(db, filePath, project, { minImportance = 2 } = {}) {
  return db
    .prepare(
      `
    SELECT DISTINCT o.id, o.type, o.title, o.importance, o.lesson_learned
    FROM observations o
    JOIN observation_files of2 ON of2.obs_id = o.id
    WHERE o.project = ?
      AND COALESCE(o.importance, 1) >= ?
      AND ${fileMatchClause('of2')}
    ORDER BY o.created_at_epoch DESC
  `,
    )
    .all(project, minImportance, ...fileMatchParams(filePath));
}

/**
 * Wall-clock cap for a test waiting on a spawned subprocess (MAIN-2, surfaced during the
 * 2026-08-29 audit follow-up).
 *
 * Fourteen suites had independently copy-pasted a bare `5000`. That cap is not an
 * assertion about the product — hang protection is already owned by vitest's
 * `testTimeout: 20000` in vitest.config.mjs, and the inner timer exists only to fail with
 * a message that names WHICH round trip stalled instead of a generic test timeout. So the
 * cap's only job is to be loose enough never to fire on a machine that is merely busy.
 *
 * 5000 was not. Measured on this host: an MCP `initialize` round trip against a cold
 * `node server.mjs` (native binding load + schema init included) takes 635ms idle — a
 * 7.9x margin — and the cap still lost once in five full-suite runs, on 24 cores with 311
 * test files in flight. The failure was the spawn being starved of CPU, not a slow server,
 * which is the same "green depends on host load" defect class as the audit's MAIN-1 and
 * pollutes the same `tests green` release gate.
 *
 * 15s sits under the 20s testTimeout, so the specific inner error is still what a reader
 * sees, while a genuinely hung subprocess fails just as reliably — 10s later. Override
 * with MEM_TEST_SUBPROCESS_TIMEOUT_MS on a slower host.
 */
export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 15000;

/**
 * Resolution rule, exported separately so it can be asserted without re-importing this
 * module under a stubbed env (vite refuses a cache-busting query on a static specifier).
 * Anything not a positive finite number falls back — `''`, `'abc'`, `'0'` and `'-1'` all
 * coerce in ways that would otherwise produce a 0ms or NaN timer.
 */
export function resolveSubprocessTimeout(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SUBPROCESS_TIMEOUT_MS;
}

export const SUBPROCESS_TIMEOUT_MS = resolveSubprocessTimeout(process.env.MEM_TEST_SUBPROCESS_TIMEOUT_MS);

/**
 * Remove a `mkdtempSync` fixture directory: retried, and loud when it fails.
 *
 * D#2. One measured run of the four leaking suites left 11 dirs in /tmp — attributed by
 * NAME SET, not by subtracting counts: mem-cooldown 5, mem-usertyped 4, mem-ssenv 1,
 * mem-audit-t4-stop 1. Two distinct causes, and neither was "the test forgot an afterEach":
 *
 *   1. DETERMINISTIC (cooldown, usertyped — 9 of the 11, now 0). The afterEach removed the
 *      wrong path: one wrapped `mkdtempSync(...)` in `join(root, 'runtime')` and disposed
 *      only the child, the other built a fresh dir per helper call and kept no reference.
 *   2. RECREATION AFTER DISPOSAL (ssenv, t4-stop — 2 of the 11, still 2 by design).
 *      Removal SUCCEEDS, then a detached worker of the hook subprocess re-runs
 *      resolveDataDir against the HOME it was handed — the path just deleted — and
 *      recreates `.claude-mem-lite/runtime` plus a fresh 274KB DB. Identified by shape:
 *      the fixture's own subdirs (`work/`, `audit/`) never come back, only the data dir.
 *      lib/tmp-fixture-sweep.mjs absorbs this class via its `mem-` prefix (:24) and
 *      DEFAULT_FIXTURE_AGE_MS (:51) — NOT the R10 P2-18 comment at :40-45, which is about
 *      three unrelated prefixes; an earlier draft cited those lines in three places.
 *
 * `maxRetries` here is DEFENSIVE, not the fix for either cause above: Node documents it
 * as the remedy for ENOTEMPTY / EBUSY / EPERM / EMFILE / ENFILE, `force: true` covers only
 * ENOENT, and the default retry count is 0. No leak in this repo has been measured to that
 * errno — do not cite it as one.
 *
 * The bare `catch {}` these sites used is the reason the leak survived: a failure that
 * recurred on every run was indistinguishable from success. This reports instead.
 *
 * @param {string|undefined|null} dir absolute path; nullish is a no-op (a beforeEach that
 *   threw before assigning leaves the variable undefined, and the afterEach still runs).
 * @param {object} [opts]
 * @param {(p: string, o: object) => void} [opts.rm] injected remover, for this helper's
 *   own tests. Production callers pass nothing.
 * @returns {boolean} true when the directory is gone.
 */
export function disposeFixtureDir(dir, { rm = rmSync } = {}) {
  if (!dir) return true;
  try {
    rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    return true;
  } catch (err) {
    // Deliberately loud. A silent catch here is what hid D#2.
    console.warn(`[test-fixture] left ${dir} behind: ${err?.code || err?.message || err}`);
    return false;
  }
}

// Claude Code reads CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md, AGENTS.md and .claude/AGENTS.md
// from every directory above the session's, and so does the plugin's AGENTS.md logic
// (lib/local-steering.mjs). A fixture below one of them tests the machine, not the code:
// `npm test` puts TMPDIR under $HOME, so ~/.claude/CLAUDE.md sits above every fixture while the
// test's own HOME points elsewhere — 10 adopt tests failed in the pre-commit run on 2026-10-06
// and passed under a /tmp TMPDIR.
const INSTRUCTION_FILES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  join('.claude', 'CLAUDE.md'),
  'AGENTS.md',
  join('.claude', 'AGENTS.md'),
];

function instructionFileAbove(dir) {
  for (let d = resolve(dir); ;) {
    for (const name of INSTRUCTION_FILES) if (existsSync(join(d, name))) return join(d, name);
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * mkdtempSync under a directory with no Claude Code instruction file or AGENTS.md in it or above
 * it: os.tmpdir() when it qualifies, else /tmp. Throws naming the files in the way when neither
 * does — a failed premise, never a skip.
 * @param {string} prefix
 * @returns {string}
 */
export function mkdtempWithoutInstructionAncestors(prefix) {
  const inTheWay = [];
  for (const base of new Set([tmpdir(), '/tmp'])) {
    if (!existsSync(base)) continue;
    const hit = instructionFileAbove(base);
    if (!hit) return mkdtempSync(join(base, prefix));
    inTheWay.push(hit);
  }
  throw new Error(`no temp root without an instruction file above it: ${inTheWay.join(', ')}`);
}

/**
 * Collect fixture dirs and re-dispose them once, at the END of the test FILE.
 *
 * This is the RECREATION half of D#2, and it needs a different hook than the deterministic
 * half `disposeFixtureDir` above serves. Measured 2026-09-07 on `main` @ v5.3.0, whole
 * suite, attributed by NAME SET and then by instrumented creation site — not by subtracting
 * counts: one clean `npx vitest run` (360 files / 5730 passed, exit 0) left **30** of this
 * repo's fixture dirs in /tmp, plus one `ssr/` dir belonging to vite itself.
 * `tests/e2e.test.mjs` alone accounted for 13 of the 30, all from ONE creation site (its
 * top-level `beforeEach`), and the rest were integration-scenarios 5, adoption-replay 5, and
 * six suites leaking exactly 1 each.
 *
 * The mechanism is NOT a failed removal, so do not "fix" it by retrying the afterEach:
 * instrumenting the afterEach recorded 71 invocations, `rmSync` threw **zero** times, and
 * `existsSync` was **false** immediately after every one of them — yet 12 of those paths
 * existed again when the file finished. A detached worker of a hook subprocess re-runs
 * `resolveDataDir` against the HOME it was handed, which the test has since deleted, and
 * recreates it. The shape confirms it and is worth keeping as the diagnostic: a recreated
 * dir holds ONLY `.claude-mem-lite/` (db + `runtime/`), never the fixture's own subdirs —
 * `beforeEach` also makes `parent/testproj/`, and that never comes back.
 *
 * `afterAll` is late enough: the same instrumentation saw all 13 alive at that point. That
 * is the whole reason this exists rather than more retries. It does NOT replace
 * `lib/tmp-fixture-sweep.mjs` — a worker can still recreate a dir after `afterAll`, and the
 * 1h sweeper at the next run's globalSetup remains the backstop for that and for SIGKILL.
 * What it buys is that a clean run stops leaving residue behind at all, which is what makes
 * the CLAUDE.md §7 residue count usable as a gate: today a real leak is indistinguishable
 * from 30 dirs of expected background.
 *
 * Disposal is by IDENTITY — the list of paths this file created — never by prefix or mtime.
 * A run-scoped sweep keyed on "created after this run started" would delete a concurrently
 * running suite's in-flight fixtures, which is exactly the collateral-deletion risk
 * `lib/tmp-fixture-sweep.mjs` refuses to take (see its allowlist comment).
 *
 * Deliberately takes no vitest import: `benchmark/*.mjs`, `eslint.config.mjs` and
 * `hook-memory.mjs` all import this module outside a vitest context, so a top-level
 * `import { afterAll } from 'vitest'` here would break them. The caller registers the hook.
 *
 * @example
 *   const fixtures = makeFixtureTracker();
 *   afterAll(() => fixtures.disposeAll());
 *   beforeEach(() => { tmpHome = fixtures.track(makeTmpDir()); });
 *
 * @returns {{track: (dir: string) => string, disposeAll: () => number}} `track` returns its
 *   argument so it can wrap a creation call inline; `disposeAll` returns how many dirs it
 *   could not remove (0 when clean) and empties the list.
 */
export function makeFixtureTracker() {
  const dirs = [];
  return {
    track(dir) {
      if (dir) dirs.push(dir);
      return dir;
    },
    disposeAll() {
      let left = 0;
      for (const dir of dirs.splice(0)) {
        if (!disposeFixtureDir(dir)) left++;
      }
      return left;
    },
  };
}
