// lib/db-repair.mjs — copy the rows SQLite can still read into a fresh file, check it, and write it
// back into the store (D#541).
//
// WHY A COPY. A damaged page reaches the main file from any read-write close: the last connection
// to close a WAL store checkpoints first and checks no page, and hooks, the MCP server and doctor
// all close read-write. On the 116 WAL plants whose rows all read back but whose file failed
// integrity_check, the v6.30.3 experiment tried four repairs: VACUUM passed 18, DROP + recreate
// the FTS tables 0, writable_schema delete + VACUUM 59, and a fresh-file copy 114
// (docs/audits/20261021-v6.30.3-d533-d535-measurements.md, Q2).
//
// HOW IT READS. Read-only, so nothing goes into the damaged file before the copy is checked: a
// read-write close checkpoints a damaged log frame, and on 21 of the 869 plants that turned a main
// file which alone read 200 observations into one that read none (first pre-tag review). Each
// table is read forward by rowid, then backward from the end past a damaged page, and then every
// rowid a full index lists that was not read yet is looked up on its own: that reads the rows
// between two damaged pages, and finds the ones a damaged page drops without an error. When the
// store does not read at all with its log, the main file alone is read, from a copy.
//
// WHAT IT CHECKS. A copy that does not compare what it wrote with what it read can come out sound
// and empty: on one plant every observation read NULL in a column the fresh schema declares NOT
// NULL, all 241 inserts failed, and the result passed integrity_check and doctor. So one failed
// insert refuses the repair. Rows SQLite cannot give back are reported.
//
// HOW IT REPLACES. The store as found, main file and log, is first copied aside byte for byte.
// The checked file is then written INTO the store through SQLite's backup API, not renamed over
// it: a connection open across a rename keeps the old inode but names `<db>-wal` and `<db>-shm`
// after the path, and its next write corrupted the renamed-in store (first pre-tag review). Through
// the backup API every connection sees one database. It still runs only when SQLite's exclusive-
// lock probe finds no other connection (SQLITE_BUSY for one that has read, also from another PID
// namespace under bwrap --unshare-pid; a handle that has not read yet holds no lock and is not
// seen), inside install.lock, behind the hook barrier, and only if the store's files did not
// change since they were read.

import Database from 'better-sqlite3';
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { initSchema, rebuildFTS, CURRENT_SCHEMA_VERSION, hasLatestMigrationColumn } from '../schema.mjs';
import { takeLock } from './proc-lock.mjs';
import { dbUnusableRemedy, damagedAsidePath } from './db-unusable.mjs';
import { shellWord } from '../cli-path.mjs';

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const message = (e) => String(e?.message ?? e);

// SQLite could not open or check the file at all, which says nothing about its pages: a path, a
// permission, a lock, memory, a full disk, an I/O error. Every other SQLite error from opening or
// checking the store is damage, SQLITE_ERROR included: an FTS5 table whose stored options are
// damaged fails to connect with it ("invalid fts5 file format", "unrecognized option").
const NOT_DAMAGE_RE = /^SQLITE_(CANTOPEN|IOERR|BUSY|LOCKED|READONLY|PERM|AUTH|NOMEM|FULL)/;
const isDamage = (e) => /^SQLITE_/.test(e?.code ?? '') && !NOT_DAMAGE_RE.test(e.code);

/**
 * `PRAGMA integrity_check` on an open handle. The pragma yields its first problem rows and then
 * can THROW from the iterator (SQLITE_CORRUPT on a damaged b-tree page, measured 2026-10-21), so
 * it is iterated rather than `.all()`-ed, which would lose the rows read before the throw. A throw
 * that is damage, or that follows a problem row, is a failed check; any other throw before a row
 * (SQLITE_CANTOPEN, SQLITE_NOMEM) means the check did not run.
 * @param {import('better-sqlite3').Database} db
 * @param {number} [max] stop after this many problems
 * @returns {{ok: boolean, problems: string[], notChecked?: string}}
 */
export function readIntegrity(db, max = 100) {
  const rows = [];
  try {
    for (const row of db
      .prepare(`PRAGMA integrity_check(${Math.trunc(max)})`)
      .pluck()
      .iterate()) {
      rows.push(String(row));
    }
  } catch (e) {
    if (rows.length === 0 && !isDamage(e)) return { ok: false, problems: [], notChecked: message(e) };
    rows.push(message(e));
  }
  if (rows.length === 1 && rows[0] === 'ok') return { ok: true, problems: [] };
  return {
    ok: false,
    problems: rows.map((r) => r.replace(/^\*\*\* in database \w+ \*\*\*\s*/, '').replace(/\s*\n\s*/g, ' ')),
  };
}

/**
 * readIntegrity on a read-only handle of `dbPath`, classifying an open failure the same way.
 * @param {string} dbPath
 * @returns {{ok: boolean, problems: string[], notChecked?: string}}
 */
export function checkIntegrity(dbPath) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return readIntegrity(db);
  } catch (e) {
    return isDamage(e)
      ? { ok: false, problems: [message(e)] }
      : { ok: false, problems: [], notChecked: message(e) };
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing was written */
    }
  }
}

/** One line for a list of integrity problems: the first, and how many more. */
export function summarizeIntegrity(problems) {
  const first = problems[0] ?? 'no result';
  return problems.length > 1 ? `${first} (and ${problems.length - 1} more)` : first;
}

/**
 * Whether another connection, in any process, has `dbPath` open and has read from it. A read-write
 * connection in EXCLUSIVE locking mode must take the file's exclusive lock on its first
 * transaction, and a WAL connection that has read holds a shared one until it closes, so with no
 * wait this fails SQLITE_BUSY while such a connection exists. A connection that has opened the
 * file and not read it yet holds no lock and is not seen. Closing the probe, as the only
 * connection, checkpoints the log into the main file: call it only once the store as found has
 * been copied aside.
 * @param {string} dbPath
 * @returns {{acquired: true} | {acquired: false, busy: boolean, error: Error}}
 */
export function probeExclusive(dbPath) {
  let db;
  try {
    db = new Database(dbPath, { fileMustExist: true });
    db.pragma('busy_timeout = 0');
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
    return { acquired: true };
  } catch (e) {
    return { acquired: false, busy: /^SQLITE_(BUSY|LOCKED)/.test(e?.code ?? ''), error: e };
  } finally {
    try {
      db?.close();
    } catch {
      /* a close that cannot checkpoint leaves the log where it was */
    }
  }
}

/**
 * The store's tables: ordinary ones (sqlite_sequence included, SQLite's own statistics tables
 * not: they are rebuilt by the next ANALYZE) and virtual ones; a virtual table's shadow tables are
 * part of it, not ordinary tables.
 */
function storeTables(db) {
  const rows = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`).all();
  const virtual = rows.filter((r) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql ?? '')).map((r) => r.name);
  const ordinary = rows
    .map((r) => r.name)
    .filter(
      (n) =>
        (n === 'sqlite_sequence' || !n.startsWith('sqlite_')) &&
        !virtual.includes(n) &&
        !virtual.some((v) => n.startsWith(`${v}_`)),
    );
  return { ordinary, virtual };
}

/**
 * The old store, read-only. When its schema will not parse, again with `writable_schema = ON`,
 * under which SQLite skips a sqlite_master row it cannot parse: of the 46 plants where doctor
 * printed `✗ Database`, that read every table in full on 23 in one run (24 in a re-run), and the
 * same copy without it read no row on any of them.
 */
function openOld(dbPath) {
  const open = (writableSchema) => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      if (writableSchema) {
        db.unsafeMode(true);
        db.pragma('writable_schema = ON');
      }
      return { db, tables: storeTables(db), writableSchema };
    } catch (e) {
      db.close();
      throw e;
    }
  };
  try {
    return open(false);
  } catch (plain) {
    try {
      return open(true);
    } catch {
      throw plain;
    }
  }
}

/**
 * The fresh file, built by this version's initSchema at the old store's page size (the backup API
 * cannot write a WAL store of another page size). Its triggers are dropped for the copy and
 * replayed after it: sdk_sessions' id-mix check RAISEs on rows written before it existed, and the
 * FTS sync triggers would index rows the rebuild indexes again.
 */
function createFresh(path, pageSize) {
  const db = new Database(path);
  try {
    db.pragma(`page_size = ${Math.trunc(pageSize)}`);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    // initSchema ends with foreign_keys ON; the copy inserts children before their parents.
    db.pragma('foreign_keys = OFF');
    const triggers = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL`)
      .all();
    for (const t of triggers) db.exec(`DROP TRIGGER ${q(t.name)}`);
    const made = storeTables(db);
    return { db, triggers, tables: made.ordinary, virtual: made.virtual };
  } catch (e) {
    db.close();
    throw e;
  }
}

/**
 * A table this version does not create (one the product makes on first use, like the search
 * telemetry tables), made in the fresh file from the old file's own statements, its indexes with
 * it; its triggers join the replay list.
 */
function createLikeOld(old, fresh, table, triggers) {
  fresh.exec(
    old.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).pluck().get(table),
  );
  const indexes = old
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`)
    .pluck()
    .all(table);
  for (const sql of indexes) fresh.exec(sql);
  triggers.push(
    ...old
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql IS NOT NULL`,
      )
      .all(table),
  );
}

/**
 * Copy one table, rowids kept, the columns both schemas have. Forward by rowid until a read
 * fails, then backward from the end down to the last rowid read. Then every rowid a full index
 * lists that neither scan read is looked up on its own: a damaged page stops a scan but not a
 * lookup that does not cross it, and a page whose cell count is damaged drops rows from a scan
 * with no error at all. Values are read as BigInt so an integer past 2^53 is copied exactly.
 */
function copyTable(old, fresh, table) {
  const r = {
    read: 0,
    written: 0,
    failed: 0,
    firstFailure: null,
    gaps: [],
    missing: [],
    indexed: false,
    unreadable: null,
  };
  let oldCols;
  try {
    oldCols = old.prepare('SELECT name, type, pk FROM pragma_table_info(?)').all(table);
  } catch (e) {
    r.unreadable = message(e);
    return r;
  }
  if (oldCols.length === 0) {
    r.unreadable = 'not in the old file';
    return r;
  }
  const freshCols = new Set(fresh.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table));
  const cols = oldCols.map((c) => c.name).filter((n) => freshCols.has(n));
  const pk = oldCols.filter((c) => c.pk > 0);
  const alias = pk.length === 1 && /^integer$/i.test(pk[0].type) && cols.includes(pk[0].name);
  const select = `SELECT rowid, ${cols.map(q).join(', ')} FROM ${q(table)}`;
  const target = [...(alias ? [] : ['rowid']), ...cols.map(q)];
  // initSchema's own rows would collide with the copied ones.
  fresh.exec(`DELETE FROM ${q(table)}`);
  const insert = fresh.prepare(
    `INSERT INTO ${q(table)} (${target.join(', ')}) VALUES (${target.map(() => '?').join(', ')})`,
  );
  const copied = new Set();
  const take = (row) => {
    copied.add(row[0]);
    r.read++;
    try {
      insert.run(alias ? row.slice(1) : row);
      r.written++;
    } catch (e) {
      r.failed++;
      r.firstFailure ??= message(e);
    }
  };
  let last = null;
  try {
    for (const row of old.prepare(`${select} ORDER BY rowid`).raw(true).safeIntegers(true).iterate()) {
      take(row);
      last = row[0];
    }
  } catch (e) {
    let first = null;
    try {
      const tail =
        last === null
          ? old.prepare(`${select} ORDER BY rowid DESC`)
          : old.prepare(`${select} WHERE rowid > ? ORDER BY rowid DESC`);
      const args = last === null ? [] : [last];
      for (const row of tail
        .raw(true)
        .safeIntegers(true)
        .iterate(...args)) {
        take(row);
        first = row[0];
      }
    } catch {
      /* the gap ends where this scan stopped */
    }
    r.gaps.push({
      after: last === null ? null : Number(last),
      before: first === null ? null : Number(first),
      error: message(e),
    });
  }
  // A partial index cannot be scanned on its own ("no query solution") and is skipped.
  const pending = new Set();
  for (const name of old
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
    .pluck()
    .all(table)) {
    let ids;
    try {
      ids = old
        .prepare(`SELECT rowid FROM ${q(table)} INDEXED BY ${q(name)}`)
        .pluck()
        .safeIntegers(true);
    } catch {
      continue;
    }
    try {
      for (const id of ids.iterate()) if (!copied.has(id)) pending.add(id);
      r.indexed = true;
    } catch {
      /* a damaged index: the rowids it gave before the throw still count */
    }
  }
  const byId = old.prepare(`${select} WHERE rowid = ?`).raw(true).safeIntegers(true);
  for (const id of pending) {
    let row;
    try {
      row = byId.get(id);
    } catch {
      row = undefined;
    }
    if (row) take(row);
    else r.missing.push(Number(id));
  }
  r.missing.sort((a, b) => a - b);
  return r;
}

/**
 * sqlite_sequence last, replaced by the old rows (same rowids, so the table reads back equal),
 * each seq raised to at least what the copied rows set: an id must never be handed out twice.
 */
function copySequence(old, fresh) {
  const r = {
    read: 0,
    written: 0,
    failed: 0,
    firstFailure: null,
    gaps: [],
    missing: [],
    indexed: true,
    unreadable: null,
  };
  let rows;
  try {
    rows = old
      .prepare('SELECT rowid, name, seq FROM sqlite_sequence ORDER BY rowid')
      .raw(true)
      .safeIntegers(true)
      .all();
  } catch (e) {
    r.unreadable = message(e);
    return r;
  }
  const floor = new Map(
    fresh.prepare('SELECT name, seq FROM sqlite_sequence').raw(true).safeIntegers(true).all(),
  );
  fresh.exec('DELETE FROM sqlite_sequence');
  const insert = fresh.prepare('INSERT INTO sqlite_sequence (rowid, name, seq) VALUES (?, ?, ?)');
  for (const [rowid, name, seq] of rows) {
    r.read++;
    const min = floor.get(name);
    floor.delete(name);
    try {
      insert.run(rowid, name, min !== undefined && min > seq ? min : seq);
      r.written++;
    } catch (e) {
      r.failed++;
      r.firstFailure ??= message(e);
    }
  }
  const append = fresh.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
  for (const [name, seq] of floor) append.run(name, seq);
  return r;
}

/**
 * Read `source` and write a checked fresh file at `tmp`. Returns the per-table results, or why
 * not: `unreadable` (the store will not open, or no observation reads), `cannot-open` (not
 * damage), `version`, `columns`, `create` (a table of the old file could not be made), `write`
 * (a row read could not be written) or `unsound` (the fresh file failed its own checks). The
 * fresh file is closed, and removed unless the result is ok. `onOpened` runs once the old store
 * has been opened (or failed to open).
 */
function buildFresh(source, tmp, onOpened) {
  const h = { old: null, fresh: null };
  let result;
  try {
    result = copyIntoFresh(source, tmp, onOpened, h);
    return result;
  } finally {
    for (const db of [h.old, h.fresh]) {
      try {
        db?.close();
      } catch {
        /* discarding it */
      }
    }
    if (!result?.ok) removeFile(tmp);
  }
}

function copyIntoFresh(source, tmp, onOpened, h) {
  let opened;
  try {
    opened = openOld(source);
  } catch (e) {
    return isDamage(e) ? { reason: 'unreadable', error: e } : { reason: 'cannot-open', error: e };
  } finally {
    onOpened?.();
  }
  const old = (h.old = opened.db);
  let version = null;
  try {
    version = old.prepare('SELECT version FROM schema_version LIMIT 1').pluck().get() ?? null;
  } catch {
    /* unreadable: the columns decide below */
  }
  if (version !== null && version !== CURRENT_SCHEMA_VERSION) return { reason: 'version', version };
  if (version === null && !hasLatestMigrationColumn(old)) return { reason: 'columns' };

  const built = createFresh(tmp, old.pragma('page_size', { simple: true }));
  const fresh = (h.fresh = built.db);
  const triggers = [...built.triggers];
  fresh.exec('BEGIN');
  const skipped = [];
  for (const t of opened.tables.ordinary) {
    // The fresh file's own FTS tables rebuild their shadow tables; an old one whose definition no
    // longer reads as a virtual table leaves its shadow tables looking like tables of their own.
    if (built.tables.includes(t) || built.virtual.some((v) => t === v || t.startsWith(`${v}_`))) continue;
    // A definition SQLite cannot parse (skipped under writable_schema) has no readable rows.
    if (old.prepare('SELECT count(*) FROM pragma_table_info(?)').pluck().get(t) === 0) {
      skipped.push({ table: t, why: 'its definition does not parse, so none of its rows can be read' });
      continue;
    }
    try {
      createLikeOld(old, fresh, t, triggers);
    } catch (e) {
      fresh.exec('ROLLBACK');
      return { reason: 'create', table: t, error: e };
    }
  }
  const made = storeTables(fresh);
  for (const t of opened.tables.virtual) {
    if (!made.virtual.includes(t))
      skipped.push({ table: t, why: 'a virtual table this version does not create; not copied' });
  }
  const tables = {};
  for (const t of made.ordinary) {
    if (t === 'schema_version' || t === 'sqlite_sequence') continue;
    tables[t] = copyTable(old, fresh, t);
  }
  if (made.ordinary.includes('sqlite_sequence')) tables.sqlite_sequence = copySequence(old, fresh);
  fresh.exec('COMMIT');

  if (Object.values(tables).some((r) => r.failed > 0)) return { reason: 'write', tables };
  const obs = tables.observations;
  if (obs && obs.read === 0 && (obs.unreadable || obs.gaps.length > 0 || obs.missing.length > 0)) {
    const why = obs.unreadable ?? obs.gaps[0]?.error ?? 'damaged pages';
    return { reason: 'unreadable', error: new Error(`no observation could be read (${why})`) };
  }
  for (const t of triggers) fresh.exec(t.sql);
  const fts = rebuildFTS(fresh);
  const check = readIntegrity(fresh);
  if (fts.errors.length > 0 || !check.ok) {
    return {
      reason: 'unsound',
      problems: [...fts.errors, ...check.problems, ...(check.notChecked ? [check.notChecked] : [])],
    };
  }
  fresh.pragma('wal_checkpoint(TRUNCATE)');
  return { ok: true, tables, skipped, writableSchema: opened.writableSchema };
}

const fileStat = (p) => {
  try {
    const s = statSync(p);
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
};
/** The store's main file and log, as (inode, size, mtime): a write changes one of them. */
const storeState = (dbPath) => `${fileStat(dbPath)}|${fileStat(`${dbPath}-wal`)}`;
const sizeOf = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};
const removeFile = (p) => {
  for (const ext of ['', '-wal', '-shm', '-journal']) rmSync(p + ext, { force: true });
};
/** A byte copy, by reflink where the file system has one; never over an existing file. */
const copyAside = (from, to) =>
  copyFileSync(from, to, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);

const listIds = (ids) =>
  ids.length > 10 ? `${ids.slice(0, 10).join(', ')} and ${ids.length - 10} more` : ids.join(', ');

/**
 * The `repair-db` command. Returns what happened and the lines to print; the caller prints them.
 * @param {string} dbPath
 * @param {object} opts
 * @param {string} opts.lockPath install.lock
 * @param {(fn: () => any) => Promise<any>|any} [opts.swapGuard] runs the final check and the
 *   write-back (install.mjs passes its hook barrier)
 * @param {() => number} [opts.now]
 * @param {() => void} [opts.afterCopy] test seam: runs between the copy and the write-back
 * @returns {Promise<{outcome: 'healthy'|'repaired'|'refused', exitCode: number,
 *   lines: {level: 'ok'|'warn'|'fail'|'info', text: string}[], tables?: object, aside?: string}>}
 */
export async function repairDb(
  dbPath,
  { lockPath, swapGuard = (fn) => fn(), now = Date.now, afterCopy } = {},
) {
  const lines = [];
  const say = (level, text) => lines.push({ level, text });
  const end = (outcome, extra = {}) => ({
    outcome,
    exitCode: outcome === 'refused' ? 1 : 0,
    lines,
    ...extra,
  });

  if (!existsSync(dbPath)) {
    say('ok', `No database at ${dbPath} — nothing to repair (the next session creates one).`);
    return end('healthy');
  }
  const lock = takeLock(lockPath);
  if (!lock.release) {
    say(
      'fail',
      lock.error
        ? `install.lock cannot be taken — ${lock.error.dir} cannot be written (${lock.error.code}).`
        : 'Another install, update or repair holds install.lock — run repair-db again once it has finished.',
    );
    return end('refused');
  }
  try {
    return await repairLocked(dbPath, { say, end, swapGuard, now, afterCopy });
  } catch (e) {
    // A full disk mid-copy, a file system that refused a write: the temporary files go in the
    // finally below, and the store is written only by the backup, which commits or rolls back.
    say('fail', `repair-db stopped: ${message(e)}. Run doctor to see the state of the database.`);
    return end('refused');
  } finally {
    lock.release();
  }
}

async function repairLocked(dbPath, { say, end, swapGuard, now, afterCopy }) {
  // A symlinked path: SQLite names the log after the target, and the store lives there.
  const real = realpathSync(dbPath);
  const wal = `${real}-wal`;
  const shm = `${real}-shm`;
  // Only repair-db makes these names, and install.lock is held: one is left by an interrupted run.
  const prefix = `${basename(real)}.repair-`;
  for (const name of readdirSync(dirname(real))) {
    if (!name.startsWith(prefix)) continue;
    rmSync(join(dirname(real), name), { force: true });
    say('info', `Removed ${name}, left by an interrupted repair.`);
  }

  // Not damage: SQLite could not open or check the file at all.
  const refuseCannotOpen = (what) => {
    say(
      'fail',
      `Could not open ${dbPath}: ${what}. Nothing was written to the database; check the file's and its directory's ` +
        'permissions and free space — this is not damage repair-db can fix.',
    );
    return end('refused');
  };
  const refuseUnreadable = (err) => {
    say('fail', `SQLite cannot read ${dbPath}: ${message(err)}. Nothing was written to the database.`);
    const remedy = dbUnusableRemedy(real, err, { afterRepair: true, now });
    say(
      'info',
      remedy.command ? `${remedy.note} Once every Claude Code session is closed, run:` : remedy.note,
    );
    if (remedy.command) say('info', remedy.command);
    return end('refused');
  };

  const integrity = checkIntegrity(real);
  if (integrity.ok) {
    say('ok', `${dbPath} passes SQLite's integrity check — nothing to repair.`);
    return end('healthy');
  }
  if (integrity.notChecked) return refuseCannotOpen(integrity.notChecked);
  say('warn', `SQLite's integrity check fails: ${summarizeIntegrity(integrity.problems)}`);

  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const tmp = `${real}.repair-${stamp}.tmp`;
  let aside = null;
  let keepAside = false;
  let keepTmp = null;
  try {
    let seen = null;
    let built = buildFresh(real, tmp, () => {
      seen = storeState(real);
    });
    let mainOnly = null;
    // SQLite cannot open the store as a database at all: neither the lock probe nor the backup can
    // run on it, and a read-write open would only checkpoint the damaged log into the main file.
    const notADatabase = built.reason === 'unreadable' && built.error?.code === 'SQLITE_NOTADB';
    if (built.reason === 'unreadable' && sizeOf(wal) > 0) {
      // A damaged frame in the log can make the whole store unreadable while the main file alone
      // still reads (the next session's own recovery would drop the log for the same reason).
      const copy = `${real}.repair-${stamp}.main`;
      copyAside(real, copy);
      try {
        const again = buildFresh(copy, tmp);
        if (again.ok) {
          mainOnly = built.error;
          built = again;
        }
      } finally {
        removeFile(copy);
      }
    }
    if (built.reason === 'cannot-open') return refuseCannotOpen(message(built.error));
    if (built.reason === 'unreadable') return refuseUnreadable(built.error);
    if (built.reason === 'version') {
      say(
        'fail',
        `The database is at schema v${built.version} and this claude-mem-lite builds v${CURRENT_SCHEMA_VERSION}; ` +
          'a copy between them would drop columns or skip a migration. Nothing was written to the database.',
      );
      return end('refused');
    }
    if (built.reason === 'columns') {
      say(
        'fail',
        'The schema version cannot be read and the newest columns are missing, so a copy is not safe. Nothing was written to the database.',
      );
      return end('refused');
    }
    if (built.reason === 'create') {
      say(
        'fail',
        `${built.table}: the table could not be made in the fresh file (${message(built.error)}). Nothing was written to the database.`,
      );
      return end('refused');
    }
    if (built.reason === 'write') {
      for (const [t, r] of Object.entries(built.tables)) {
        if (r.failed > 0)
          say(
            'fail',
            `${t}: ${r.failed} of ${r.read} rows could not be written to the fresh file (${r.firstFailure}).`,
          );
      }
      say('info', 'Nothing was written to the database.');
      return end('refused', { tables: built.tables });
    }
    if (built.reason === 'unsound') {
      say(
        'fail',
        `The fresh file did not come out sound: ${built.problems.join('; ')}. Nothing was written to the database.`,
      );
      return end('refused');
    }
    const { tables } = built;

    afterCopy?.();
    const changed = () => {
      say(
        'fail',
        `${dbPath} changed while it was being read (a session wrote to it), so it was not replaced.`,
      );
      say(
        'info',
        'Close every Claude Code session, this one included, then run repair-db again from a terminal.',
      );
      return end('refused', { tables });
    };
    if (storeState(real) !== seen) return changed();
    // The store as found, before anything opens it read-write.
    aside = damagedAsidePath(real, now);
    copyAside(real, aside);
    // An empty log (the read-only handles above can leave one) holds nothing to keep.
    if (sizeOf(wal) > 0) copyAside(wal, `${aside}-wal`);
    if (storeState(real) !== seen) return changed();
    // The checked copy is left for the person to put in place; the store as found is kept.
    const leaveForHand = (why) => {
      keepAside = true;
      keepTmp = `${real}.repaired-${stamp}`;
      renameSync(tmp, keepTmp);
      say(
        'fail',
        `SQLite cannot write into ${dbPath} (${why}), so the checked copy was not written into it.`,
      );
      say(
        'info',
        `The checked copy is ${keepTmp}; the store as found is kept as ${aside}. Once every Claude Code ` +
          'session is closed, put the copy in place with:',
      );
      say('info', `rm -f ${shellWord(wal)} ${shellWord(shm)} && mv ${shellWord(keepTmp)} ${shellWord(real)}`);
      return end('refused', { tables, aside });
    };
    if (notADatabase) {
      say('info', 'Nothing was written to the database.');
      return leaveForHand(message(mainOnly));
    }

    const swap = await swapGuard(async () => {
      if (storeState(real) !== seen) return { changed: true };
      const probe = probeExclusive(real);
      if (!probe.acquired) return { probe };
      const source = new Database(tmp, { readonly: true, fileMustExist: true });
      try {
        await source.backup(real);
      } catch (e) {
        return { backupError: e };
      } finally {
        source.close();
      }
      return { replaced: true };
    });
    if (swap.changed) return changed();
    if (swap.probe?.busy) {
      say('fail', `Another process has ${dbPath} open, so it was not replaced.`);
      say(
        'info',
        'Close every Claude Code session, this one included, then run repair-db again from a terminal.',
      );
      return end('refused', { tables });
    }
    if (swap.probe && !isDamage(swap.probe.error)) return refuseCannotOpen(message(swap.probe.error));
    if (swap.probe || swap.backupError) return leaveForHand(message(swap.probe?.error ?? swap.backupError));
    keepAside = true;

    // The store now holds the checked copy; fold its log in and check it as it is.
    const live = new Database(real, { fileMustExist: true });
    let after;
    try {
      live.pragma('busy_timeout = 5000');
      after = readIntegrity(live);
      live.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      live.close();
    }

    if (mainOnly) {
      say(
        'warn',
        `SQLite could not read the database together with its log (${message(mainOnly)}); the rows were read ` +
          'from the database file alone, so what was saved only in the log is not in the repaired store.',
      );
    }
    if (built.writableSchema)
      say(
        'warn',
        'Its schema does not parse; it was read with writable_schema, which skips the rows it cannot parse.',
      );
    let copied = 0;
    for (const [t, r] of Object.entries(tables)) {
      copied += r.written;
      if (t === 'sqlite_sequence' && r.unreadable) {
        say(
          'warn',
          `sqlite_sequence: could not be read (${r.unreadable}); ids above the highest copied one may be handed out again.`,
        );
        continue;
      }
      if (r.unreadable)
        say('warn', `${t}: could not be read (${r.unreadable}); the repaired store has none of its rows.`);
      if (r.missing.length > 0) {
        say(
          'warn',
          `${t}: ${r.missing.length} row(s) an index lists could not be read (ids ${listIds(r.missing)}).`,
        );
      }
      if (!r.indexed) {
        for (const g of r.gaps) {
          const where = [
            g.after === null ? '' : `after id ${g.after}`,
            g.before === null ? '' : `before id ${g.before}`,
          ]
            .filter(Boolean)
            .join(' and ');
          say(
            'warn',
            `${t}: a damaged page stopped the read${where ? ` ${where}` : ''}; rows there that no index lists may be lost (${g.error}).`,
          );
        }
      }
    }
    for (const { table, why } of built.skipped) say('warn', `${table}: ${why}.`);
    say(
      'ok',
      `Copied ${copied} rows into a fresh file, checked it, rebuilt its search indexes, and wrote it into ${dbPath}.`,
    );
    if (!after.ok) {
      say(
        'fail',
        `The store does not pass integrity_check after the write: ${after.notChecked ?? summarizeIntegrity(after.problems)}`,
      );
    }
    const kept = existsSync(`${aside}-wal`)
      ? `${aside} and ${aside}-wal — delete them`
      : `${aside} — delete it`;
    say('ok', `The store as found is kept as ${kept} once you no longer need it.`);
    const undo = [
      `rm -f ${shellWord(wal)} ${shellWord(shm)}`,
      `cp ${shellWord(aside)} ${shellWord(real)}`,
      ...(existsSync(`${aside}-wal`) ? [`cp ${shellWord(`${aside}-wal`)} ${shellWord(wal)}`] : []),
    ].join(' && ');
    say(
      'info',
      `To go back to it (anything saved after this repair is lost), once every Claude Code session is closed: ${undo}`,
    );
    return end(after.ok ? 'repaired' : 'refused', { tables, aside });
  } finally {
    if (keepTmp === null) removeFile(tmp);
    if (aside && !keepAside) for (const p of [aside, `${aside}-wal`]) rmSync(p, { force: true });
  }
}
