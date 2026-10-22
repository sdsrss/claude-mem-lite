// lib/db-salvage.mjs — read the rows SQLite can still give back from a damaged store into a fresh
// file, and account, table by table, for the rows it could not (D#546). This is repair-db's read
// side; lib/db-repair.mjs decides what to do with the result and writes it back.
//
// TWO SOURCES. The store as found (main file + log) is read first, read-only. When it loses rows and
// its log is not empty, the main file alone (a byte copy, without the log) is read too, and its rows
// fill in the ones the store as found could not give back: a damaged log frame can hide most of a
// table the main file still holds (round-2 defects F2: 21 of 1,495 observations kept while the main
// file alone read 1,195). Those rows are the version of the last checkpoint, so what the log changed
// in them, or deleted, is undone; the account counts them.
//
// HOW A TABLE IS READ. Forward by rowid. When a read stops on a damaged page, the next rowid a seek
// can reach is found (`rowid > x` for growing x, then a binary search back), every rowid in between
// is looked up on its own, and the scan goes on from there: a seek that does not cross the damaged
// page reads on, so the rows between
// two damaged pages are read without an index. Then every rowid an index lists that no read
// returned is looked up.
//
// WHAT NO READ SEES. A page whose cell count is damaged drops rows from every read, without an error
// (round-2 defects F1: deferred_work 40 → 20, no line). So each table's own pages are checked
// (`PRAGMA integrity_check(<table>)`), and a table whose pages fail is reported as damaged: rows on
// those pages may be missing, or hold damaged values. Problems SQLite places on one of the table's
// indexes do not count: the fresh file rebuilds every index.

import Database from 'better-sqlite3';
import { closeSync, copyFileSync, existsSync, openSync, readSync, rmSync } from 'node:fs';
import { CURRENT_SCHEMA_VERSION, initSchema, rebuildFTS } from '../schema.mjs';

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const message = (e) => String(e?.message ?? e);
const MIN_ROWID = -(2n ** 63n);
const MAX_ROWID = 2n ** 63n - 1n;
/** Rowids looked up one by one inside one stretch a scan could not cross; past it, the two ends. */
const LOOKUP_CAP = 65536n;
/** Damaged stretches read past in one table before the read gives up on the rest of it. */
const GAP_CAP = 10000;
/** Row ids kept per list in an account (the count is always kept). */
const LIST_CAP = 50;

// integrity_check's row-against-index cross-checks: they follow damage on either side.
const AGREEMENT_RE =
  /^(row \d+ missing from index|wrong # of entries in index|non-unique entry in UNIQUE index|NULL value in|NUMERIC value in|TEXT value in|CHECK constraint failed|malformed inverted index)/;

/**
 * The tables of a handle, from its parsed schema rather than a scan of sqlite_master: under
 * writable_schema a damaged sqlite_master page makes the scan throw while every table SQLite parsed
 * still reads (round-2 claims F1, on the `✗ Database` plants of the 869-plant set).
 */
function listTables(db) {
  const rows = db.prepare(`SELECT name, type FROM pragma_table_list WHERE schema = 'main'`).all();
  return {
    ordinary: rows
      .filter((r) => r.type === 'table' && (r.name === 'sqlite_sequence' || !r.name.startsWith('sqlite_')))
      .map((r) => r.name),
    virtual: rows.filter((r) => r.type === 'virtual').map((r) => r.name),
    shadow: rows.filter((r) => r.type === 'shadow').map((r) => r.name),
  };
}

/**
 * A store read-only; when its schema will not parse, again with writable_schema, under which SQLite
 * skips the sqlite_master rows it cannot parse.
 * @returns {{db: Database, writableSchema: boolean, tables: {ordinary: string[], virtual: string[]}} | {error: Error}}
 */
function openSource(path) {
  let first;
  for (const writableSchema of [false, true]) {
    let db;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
      if (writableSchema) {
        db.unsafeMode(true);
        db.pragma('writable_schema = ON');
      }
      return { db, writableSchema, tables: listTables(db) };
    } catch (e) {
      try {
        db?.close();
      } catch {
        /* read-only */
      }
      first ??= e;
    }
  }
  return { error: first };
}

/** The page size in a database file's header (the backup API cannot write across page sizes). */
function headerPageSize(path) {
  const buf = Buffer.alloc(2);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, 2, 16);
  } finally {
    closeSync(fd);
  }
  const v = buf.readUInt16BE(0);
  const size = v === 1 ? 65536 : v;
  return size >= 512 && size <= 65536 && (size & (size - 1)) === 0 ? size : 4096;
}

const readVersion = (db) => {
  try {
    return db.prepare('SELECT version FROM schema_version LIMIT 1').pluck().get() ?? null;
  } catch {
    return null;
  }
};
const columnsOf = (db, t) => {
  try {
    return db.prepare('SELECT name, type, pk FROM pragma_table_info(?)').all(t);
  } catch {
    return [];
  }
};
const statementOf = (db, type, name) => {
  try {
    return (
      db.prepare(`SELECT sql FROM sqlite_master WHERE type = ? AND name = ?`).pluck().get(type, name) ?? null
    );
  } catch {
    return null;
  }
};

/** Every page of one b-tree, as far as dbstat can walk it, its root first; `complete` when the walk ended. */
function pagesOf(db, name) {
  const pages = [];
  try {
    for (const p of db.prepare('SELECT pageno FROM dbstat WHERE name = ?').pluck().iterate(name))
      pages.push(p);
  } catch {
    return { pages, complete: false };
  }
  return { pages, complete: true };
}

/**
 * Whether a table's own pages fail integrity_check: `damage`, the first such problem, or null. A
 * problem SQLite places on one of the table's indexes, or on a page outside the table's own tree
 * when that tree walks to its end, does not count, nor does a row-against-index mismatch: the fresh
 * file rebuilds every index from the rows. A check that stopped before naming any page counts.
 * SQLite checks the table's own tree before its indexes (pragma.c lists its root first), so a
 * problem of the table's comes before the check's 100-problem limit. `disagreeing`: the rowids
 * whose values disagree with an index of the table ("row N missing from index"), as far as the
 * limit lets the check list them: a damaged page can garble a row's values and keep its rowid.
 * @returns {{damage: string|null, disagreeing: string[]}}
 */
function tableDamage(db, table) {
  const problems = [];
  let threw = null;
  try {
    // The per-table form can return several problems in one row, a line each.
    for (const r of db
      .prepare(`PRAGMA integrity_check(${q(table)})`)
      .pluck()
      .iterate()) {
      problems.push(
        ...String(r)
          .replace(/^\*\*\* in database \w+ \*\*\*\s*/, '')
          .split('\n'),
      );
    }
  } catch (e) {
    threw = e;
  }
  const disagreeing = [
    ...new Set(problems.map((p) => /^row (\d+) missing from index/.exec(p)?.[1]).filter(Boolean)),
  ];
  return { damage: damageOf(db, table, problems, threw), disagreeing };
}

function damageOf(db, table, problems, threw) {
  if (!threw && problems.length === 1 && problems[0] === 'ok') return null;
  const structural = problems.filter((p) => !AGREEMENT_RE.test(p));
  const agreement = problems.filter((p) => AGREEMENT_RE.test(p));
  // A message names a b-tree by its root ("Tree R page P: ...") or only a page ("Multiple uses for
  // byte B of page P"); dbstat cannot walk past a damaged page, so an index's pages are not all known.
  const own = pagesOf(db, table);
  const ownPages = new Set(own.pages);
  const indexRoot = new Map();
  const indexPage = new Map();
  const broken = new Set();
  let indexes = [];
  try {
    indexes = db.prepare('SELECT name FROM pragma_index_list(?)').pluck().all(table);
  } catch {
    /* none known */
  }
  for (const ix of indexes) {
    const walk = pagesOf(db, ix);
    if (walk.pages.length > 0) indexRoot.set(walk.pages[0], ix);
    for (const pg of walk.pages) indexPage.set(pg, ix);
    if (!walk.complete) broken.add(ix);
  }
  for (const p of structural) {
    const tree = /^Tree (\d+) page (\d+)/.exec(p);
    const page = tree ? Number(tree[2]) : Number(/\bpage (\d+)/.exec(p)?.[1]);
    if ((tree && Number(tree[1]) === own.pages[0]) || ownPages.has(page)) return p;
    if (tree && indexRoot.has(Number(tree[1]))) {
      broken.add(indexRoot.get(Number(tree[1])));
      continue;
    }
    if (!tree && indexPage.has(page)) {
      broken.add(indexPage.get(page));
      continue;
    }
    if (own.complete && own.pages.length > 0 && Number.isInteger(page)) continue;
    return p;
  }
  // A row/index mismatch on an index whose own structure is sound is the table's: a page that
  // lost a write is valid, and shows only there (the round-3 defects review: a damaged index of
  // the same table silenced it, and 23 rows went unnamed). A mismatch that names no index (a NULL
  // or CHECK violation) is the table's too.
  for (const p of agreement) {
    const ix = /index (\S+)$/.exec(p)?.[1];
    if (!ix || !broken.has(ix)) return p;
  }
  if (structural.length === 0 && agreement.length === 0)
    return threw ? message(threw) : 'integrity_check failed';
  return null;
}

/**
 * The smallest rowid above `after` from which a seek reads without an error, and the first rowid it
 * reads (null: none past it); null when no seek up to the largest rowid reads. The step doubles
 * from -1 when the search starts below it: a table's rowids are small positive numbers, and a step
 * doubled from far below zero leaps over all of them at once (the round-3 defects review: 239
 * intact rows of one table skipped when its first and last paths were both damaged).
 */
function nextReadable(seek, after) {
  const tryAt = (x) => {
    try {
      return { first: seek.get(x)?.[0] ?? null };
    } catch {
      return null;
    }
  };
  let bad = after < -1n ? -1n : after;
  let good;
  let hit;
  for (let d = 1n; ; d *= 2n) {
    const x = bad + d > MAX_ROWID ? MAX_ROWID : bad + d;
    hit = tryAt(x);
    if (hit) {
      good = x;
      break;
    }
    if (x === MAX_ROWID) return null;
    bad = x;
  }
  while (good - bad > 1n) {
    const mid = bad + (good - bad) / 2n;
    const h = tryAt(mid);
    if (h) {
      good = mid;
      hit = h;
    } else bad = mid;
  }
  return { at: good, first: hit.first };
}

/**
 * Read one table of one source, handing each row (rowid first, as BigInt-safe values) to `take`,
 * which says whether the row is now in the fresh file. Returns the stretches no scan crossed and
 * the rowids an index lists that no read returned.
 */
function readTable(db, table, cols, take) {
  const sel = `SELECT rowid${cols.length ? ', ' : ''}${cols.map(q).join(', ')} FROM ${q(table)}`;
  const prep = (sql) => db.prepare(sql).raw(true).safeIntegers(true);
  const byId = prep(`${sel} WHERE rowid = ?`);
  // A seek reads what the scan reads: a row whose rowid reads and whose values do not stops a
  // scan, and a seek that read only rowids would stop on it again and again.
  const all = prep(`${sel} ORDER BY rowid`);
  const above = prep(`${sel} WHERE rowid > ? ORDER BY rowid`);
  const seek = prep(`${sel} WHERE rowid > ? ORDER BY rowid LIMIT 1`);
  const downFrom = prep(`${sel} WHERE rowid <= ? ORDER BY rowid DESC`);
  const fromEnd = prep(`${sel} ORDER BY rowid DESC`);
  const gaps = [];
  let gapCount = 0;
  // Rowids whose row is in the fresh file. A row that could not be written is not one of them: a
  // damaged page can hand back a garbage cell under a real row's rowid, and the lookup of that
  // rowid can still return the real row (round-2 sweeps, first cell pointers damaged).
  const got = new Set();
  const refused = new Set();
  const hand = (row) => {
    if (got.has(row[0])) return;
    if (take(row)) {
      got.add(row[0]);
      refused.delete(row[0]);
    } else refused.add(row[0]);
  };
  const looked = new Set();
  const lookUp = (id) => {
    if (got.has(id)) return true;
    if (looked.has(id)) return false;
    looked.add(id);
    try {
      const row = byId.get(id);
      if (row) {
        hand(row);
        return got.has(row[0]);
      }
    } catch {
      /* unreadable */
    }
    return false;
  };
  // In rowid order, stepping past each damaged stretch.
  const stretches = [];
  let from = null;
  for (let n = 0; ; n++) {
    let prev = null;
    let last = null;
    try {
      for (const row of from === null ? all.iterate() : above.iterate(from)) {
        hand(row);
        prev = last;
        last = row[0];
      }
      break;
    } catch (e) {
      // Restart past the last rowid read, unless it leapt past the one before it by more than a
      // stretch (a garbage cell can carry any rowid), and never behind where this scan began.
      let at = last;
      if (at !== null && prev !== null && at - prev > LOOKUP_CAP) at = prev;
      if (from !== null && (at === null || at < from)) at = from;
      const after = at ?? MIN_ROWID - 1n;
      const next = n < GAP_CAP ? nextReadable(seek, after) : null;
      // Every rowid the scan could not reach, one by one, when there are not too many; else the
      // ones next to what was read on either side, where a table's ids sit.
      const end = next ? next.at : MAX_ROWID;
      const whole = end - after <= LOOKUP_CAP;
      if (whole) for (let id = after + 1n; id <= end; id++) lookUp(id);
      else {
        for (let id = after + 1n; id <= after + LOOKUP_CAP / 2n; id++) lookUp(id);
        for (let id = end - LOOKUP_CAP / 2n + 1n; id <= end; id++) lookUp(id);
      }
      stretches.push({ after, top: next ? next.at : null });
      gapCount++;
      if (gaps.length < LIST_CAP)
        gaps.push({
          after: at === null ? null : String(at),
          before: next && next.first !== null ? String(next.first) : null,
          lookedUp: whole,
          error: message(e),
        });
      if (!next || next.first === null) break;
      from = next.at;
    }
  }
  // Each stretch read again from its upper end down: the cells of a damaged leaf past its bad cell
  // read from that side.
  for (const { after, top } of stretches) {
    try {
      for (const row of top === null ? fromEnd.iterate() : downFrom.iterate(top)) {
        if (row[0] <= after) break;
        hand(row);
      }
    } catch {
      /* down to the bad cell */
    }
  }
  // A row a scan read and the fresh file refused, looked up on its own.
  for (const id of [...refused]) lookUp(id);
  // Rowids an index lists that no read returned. A partial index is read under its own WHERE.
  const missing = [];
  let indexes = [];
  try {
    indexes = db.prepare('SELECT name, partial FROM pragma_index_list(?)').all(table);
  } catch {
    /* none known */
  }
  const pending = new Set();
  for (const ix of indexes) {
    let where = '';
    if (ix.partial) {
      const m = /\bWHERE\b([\s\S]*)$/i.exec(statementOf(db, 'index', ix.name) ?? '');
      if (!m) continue;
      where = ` WHERE ${m[1]}`;
    }
    let ids;
    try {
      ids = db
        .prepare(`SELECT rowid FROM ${q(table)} INDEXED BY ${q(ix.name)}${where}`)
        .pluck()
        .safeIntegers(true);
    } catch {
      continue;
    }
    try {
      for (const id of ids.iterate()) if (!got.has(id)) pending.add(id);
    } catch {
      /* a damaged index: the rowids it gave before the throw still count */
    }
  }
  for (const id of pending) if (!lookUp(id) && !refused.has(id)) missing.push(id);
  missing.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { gaps, gapCount, stretches, missing: missing.map(String) };
}

/**
 * The tables sqlite_master lists, read the way a table is (past a damaged page), so that a table
 * whose definition SQLite cannot parse is still named. `complete` is false when a page of it could
 * not be read: a table listed there is not known.
 */
function masterTables(db) {
  const names = new Set();
  let res;
  try {
    res = readTable(db, 'sqlite_master', ['type', 'name'], (row) => {
      if (row[1] === 'table') names.add(String(row[2]));
    });
  } catch {
    return { names, complete: false };
  }
  return { names, complete: res.gaps.length === 0 };
}

/**
 * The fresh file, built by this version's initSchema at `pageSize`. Its triggers are dropped for the
 * copy and replayed after it: sdk_sessions' id-mix check RAISEs on rows written before it existed,
 * and the FTS sync triggers would index rows the rebuild indexes again.
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
    return { db, triggers, ...listTables(db) };
  } catch (e) {
    db.close();
    throw e;
  }
}

/**
 * A table this version does not create (one the product makes on first use, like the search
 * telemetry tables), made in the fresh file from the old file's statements, or, when SQLite cannot
 * read its statement, from its columns. Its indexes and triggers follow when they can be read.
 */
function createLikeOld(old, fresh, table, triggers) {
  const sql = statementOf(old, 'table', table);
  if (sql) fresh.exec(sql);
  else {
    const cols = columnsOf(old, table);
    if (cols.length === 0) throw new Error('its columns cannot be read');
    fresh.exec(
      `CREATE TABLE ${q(table)} (${cols.map((c) => `${q(c.name)} ${c.type || ''}`.trim()).join(', ')})`,
    );
  }
  let extra = [];
  try {
    extra = old
      .prepare(
        `SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = ? AND sql IS NOT NULL`,
      )
      .all(table);
  } catch {
    /* the table's rows are what matters */
  }
  for (const x of extra) {
    if (x.type === 'trigger') triggers.push({ name: x.name, sql: x.sql });
    else {
      try {
        fresh.exec(x.sql);
      } catch {
        /* an index the fresh file can do without */
      }
    }
  }
}

const emptyAccount = () => ({
  read: 0,
  written: 0,
  fromMain: 0,
  notWritten: [],
  notWrittenCount: 0,
  firstFailure: null,
  gaps: [],
  missing: [],
  damaged: null,
  unreadable: null,
  logUnreadable: null,
  transplanted: null,
  definitionDiffers: false,
  disagreeing: [],
  replaced: [],
  mainRead: false,
  mainDamaged: null,
  mainUnreadable: null,
  droppedColumns: [],
  superseded: 0,
});

/**
 * Read `storePath` into a fresh file at `freshPath` built by this version's initSchema.
 *
 * @param {string} storePath the store as found (opened read-only)
 * @param {string} freshPath where the fresh file is built (must not exist)
 * @param {object} [opts]
 * @param {() => string|null} [opts.mainAlone] a byte copy of the store's main file without its log,
 *   made on first call; null when the log is empty (the main file alone is then the store)
 * @param {object} [opts.scratch] path of a private scratch file named by a suffix (removed after)
 * @param {Map<string, string[]>} [opts.firstUse] column lists of tables the product makes on first
 *   use, which judge their definitions as this version's schema judges its own tables
 * @returns {object} `{ok: true, tables, skipped, sources}` or `{ok: false, reason, ...}` with reason
 *   `unreadable` (no source opens, or no observation reads), `version`, `columns`, `create`, `write`
 *   (no row of a table that read rows could be written) or `unsound` (the fresh file failed its own
 *   checks). The fresh file is closed either way; the caller removes it unless the result is ok.
 */
export function salvage(
  storePath,
  freshPath,
  { mainAlone = () => null, scratch = (s) => `${freshPath}.${s}`, firstUse = new Map() } = {},
) {
  const handles = [];
  const made = [];
  const scratchPath = (s) => {
    const p = scratch(s);
    made.push(p);
    return p;
  };
  try {
    return salvageOpen(storePath, freshPath, mainAlone, scratchPath, firstUse, handles);
  } finally {
    for (const db of handles) {
      try {
        db.close();
      } catch {
        /* discarding it */
      }
    }
    for (const p of made)
      for (const ext of ['', '-wal', '-shm', '-journal']) rmSync(p + ext, { force: true });
  }
}

/**
 * A private copy of the store with its log, in which the given tables' definitions are replaced
 * by the ones the main file alone holds, opened read-only; null when that cannot be done. A
 * damaged sqlite_master page can lose or garble a table's definition while its rows read fine
 * (p10-v5 of the 869: two columns gone from observations, every later column shifted).
 */
function transplant(storePath, copyPath, defs) {
  copyFileSync(storePath, copyPath);
  if (existsSync(`${storePath}-wal`)) copyFileSync(`${storePath}-wal`, `${copyPath}-wal`);
  const done = [];
  let db;
  try {
    db = new Database(copyPath, { fileMustExist: true });
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    const set = db.prepare(`UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?`);
    for (const [t, sql] of defs) {
      try {
        if (set.run(sql, t).changes === 1) done.push(t);
      } catch {
        /* its row is on a page that cannot be written */
      }
    }
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* a copy */
    }
  }
  if (done.length === 0) return null;
  const src = openSource(copyPath);
  return src.db ? { src, done } : null;
}

function salvageOpen(storePath, freshPath, mainAlone, scratchPath, firstUse, handles) {
  const logSrc = openSource(storePath);
  if (logSrc.db) handles.push(logSrc.db);
  let mainSrc;
  const openMain = () => {
    if (mainSrc !== undefined) return mainSrc;
    const path = mainAlone();
    mainSrc = path ? openSource(path) : null;
    if (mainSrc?.db) handles.push(mainSrc.db);
    return mainSrc;
  };

  // The main file alone, whenever there is a log: its definitions judge the log's.
  openMain();
  // The version, from whichever source reads it; the store as found first.
  let version = logSrc.db ? readVersion(logSrc.db) : null;
  if (version === null && openMain()?.db) version = readVersion(mainSrc.db);
  if (version !== null && version !== CURRENT_SCHEMA_VERSION)
    return { ok: false, reason: 'version', version };
  if (!logSrc.db && !openMain()?.db) {
    return { ok: false, reason: 'unreadable', error: logSrc.error ?? mainSrc?.error };
  }

  const built = createFresh(freshPath, headerPageSize(storePath));
  const fresh = built.db;
  handles.push(fresh);
  const triggers = [...built.triggers];
  const freshCols = new Map(built.ordinary.map((t) => [t, new Set(columnsOf(fresh, t).map((c) => c.name))]));
  // A virtual table's shadow tables read as tables of their own when its definition is lost, and
  // a damaged name no longer starts with its table's (p13-v8: `usAAAAAAAAts_fts_config`). This
  // version rebuilds its own search indexes; none of these hold rows of their own.
  const isShadow = (t) =>
    built.virtual.some((v) => t === v || t.startsWith(`${v}_`)) ||
    /_fts\w*_(data|idx|docsize|config|content)$/.test(t);
  // A search index's internal table whose name damage garbled past the pattern above, known by its
  // columns (the round-3 defects review: `observations_f\x1c~_data` copied in, or refusing).
  const SHADOW_SHAPES = ['id,block', 'segid,term,pgno', 'id,sz', 'id,sz,origin', 'k,v'];
  const shadowShaped = (src, t) =>
    !freshCols.has(t) &&
    /_(data|idx|docsize|config|content)$/.test(t) &&
    SHADOW_SHAPES.includes(
      columnsOf(src.db, t)
        .map((c) => c.name)
        .join(','),
    );
  const candidates = (src) =>
    src?.db
      ? src.tables.ordinary.filter(
          (t) => t !== 'schema_version' && t !== 'sqlite_sequence' && !isShadow(t) && !shadowShaped(src, t),
        )
      : [];
  // Which definition a table is read through. A damaged sqlite_master page can garble one SQLite
  // still parses (p10-v5: two columns gone; the round-3 claims review: a column renamed, two
  // swapped), and reading through it shifts values into the wrong columns. The referee is this
  // version's column list (its schema, and the tables the product makes on first use): the log's
  // definition is kept when it matches, else the main file's when that matches. With no referee, a
  // log whose columns extend the main file's (an ALTER TABLE in the log) keeps its own, one whose
  // columns the main file's extend gives way, and any other difference is read with the log's and
  // named. 'none': the log's is garbled and nothing better exists.
  const referee = new Map([
    ...firstUse,
    ...built.ordinary.map((t) => [t, columnsOf(fresh, t).map((c) => c.name)]),
  ]);
  const namesOf = (src, t) => (src?.db ? columnsOf(src.db, t).map((c) => c.name) : []);
  const same = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);
  const sameSet = (a, b) => a.length === b.length && a.every((c) => b.includes(c));
  const startsWith = (longer, head) => head.length <= longer.length && head.every((c, i) => c === longer[i]);
  const definitionFor = (t) => {
    const a = namesOf(logSrc, t);
    const b = mainSrc?.db && mainSrc.tables.ordinary.includes(t) ? namesOf(mainSrc, t) : null;
    const ref = referee.get(t);
    if (ref) {
      if (same(a, ref)) return 'log';
      if (b && same(b, ref)) return 'main';
      if (sameSet(a, ref) && (!b || same(a, b))) return 'log';
      if (b && sameSet(b, ref) && !sameSet(a, ref)) return 'main';
      return sameSet(a, ref) ? 'differs' : 'none';
    }
    if (!b || same(a, b) || startsWith(a, b)) return 'log';
    if (startsWith(b, a)) return 'main';
    return 'differs';
  };
  /** The main file's definition can stand in for the log's: it matches the referee, or has none. */
  const mainUsable = (t) => {
    const ref = referee.get(t);
    return !ref || sameSet(namesOf(mainSrc, t), ref);
  };
  // A store whose parsed schema holds none of this version's tables is not read with its log.
  if (logSrc.db && !candidates(logSrc).some((t) => freshCols.has(t))) {
    logSrc.error = new Error('its schema cannot be read');
    logSrc.db = null;
  }
  // Tables sqlite_master lists whose definition SQLite could not parse: their rows cannot be read
  // from that source.
  const unparsed = (src) => {
    if (!src?.db || !src.writableSchema) return { names: [], complete: true };
    const listed = new Set([...src.tables.ordinary, ...src.tables.virtual, ...src.tables.shadow]);
    const m = masterTables(src.db);
    return {
      names: [...m.names].filter((t) => !listed.has(t) && !t.startsWith('sqlite_') && !isShadow(t)),
      complete: m.complete,
    };
  };

  // With no version to go by, a column set that differs from this version's means another schema:
  // a newer one would lose its columns in the copy, an older one would skip a migration.
  if (version === null) {
    for (const src of [logSrc, mainSrc]) {
      for (const t of candidates(src)) {
        const want = freshCols.get(t);
        if (!want) continue;
        const have = columnsOf(src.db, t).map((c) => c.name);
        const extra = have.filter((c) => !want.has(c));
        const lacking = [...want].filter((c) => !have.includes(c));
        if (extra.length > 0 || lacking.length > 0)
          return { ok: false, reason: 'columns', table: t, extra, lacking };
      }
    }
  }

  fresh.exec('BEGIN');
  const tables = {};
  const skipped = [];
  const state = new Map();
  const stateOf = (t) => {
    if (!state.has(t)) {
      tables[t] = emptyAccount();
      state.set(t, { acc: tables[t], have: new Set(), failed: new Map(), cleared: false });
    }
    return state.get(t);
  };
  /** Make table t in the fresh file when this version does not create it; true, or the error. */
  const ensureTable = (src, t) => {
    if (freshCols.has(t)) return true;
    try {
      createLikeOld(src.db, fresh, t, triggers);
    } catch (e) {
      return e;
    }
    freshCols.set(t, new Set(columnsOf(fresh, t).map((c) => c.name)));
    return true;
  };

  /** The columns a source's table and the fresh file's both have, and an insert keeping rowids. */
  const rowWriter = (src, t) => {
    const oldCols = columnsOf(src.db, t);
    const want = freshCols.get(t);
    const cols = oldCols.map((c) => c.name).filter((n) => want.has(n));
    const pk = oldCols.filter((c) => c.pk > 0);
    const alias = pk.length === 1 && /^integer$/i.test(pk[0].type) && cols.includes(pk[0].name);
    const target = [...(alias ? [] : ['rowid']), ...cols.map(q)];
    const insert = fresh.prepare(
      `INSERT INTO ${q(t)} (${target.join(', ')}) VALUES (${target.map(() => '?').join(', ')})`,
    );
    return { oldCols, cols, alias, insert };
  };

  /** Copy the rows of table t that the fresh file does not hold yet from one source. */
  const copyFrom = (src, t, fromMain) => {
    const st = stateOf(t);
    const { acc } = st;
    if (columnsOf(src.db, t).length === 0) return { unreadable: 'its definition cannot be read' };
    if (!st.cleared) {
      fresh.exec(`DELETE FROM ${q(t)}`);
      st.cleared = true;
    }
    const { oldCols, cols, alias, insert } = rowWriter(src, t);
    const want = freshCols.get(t);
    for (const c of oldCols)
      if (!want.has(c.name) && !acc.droppedColumns.includes(c.name)) acc.droppedColumns.push(c.name);
    const hadRows = st.have.size > 0;
    const take = (row) => {
      const id = row[0];
      if (st.have.has(id)) return true;
      if (fromMain && st.want && !st.want(id)) return true;
      if (!st.failed.has(id)) acc.read++;
      try {
        insert.run(alias ? row.slice(1) : row);
      } catch (e) {
        // A main-file row the store as found already holds under another rowid (a unique key) is
        // that row's older version, not a lost one.
        if (fromMain && hadRows && /^SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)/.test(e?.code ?? ''))
          acc.superseded++;
        else if (!st.failed.has(id)) st.failed.set(id, message(e));
        return false;
      }
      st.have.add(id);
      st.failed.delete(id);
      acc.written++;
      if (fromMain) acc.fromMain++;
      return true;
    };
    const { damage: damaged, disagreeing } = tableDamage(src.db, t);
    try {
      return { ...readTable(src.db, t, cols, take), damaged, disagreeing };
    } catch (e) {
      return { unreadable: message(e), damaged, disagreeing };
    }
  };

  // 1. The store as found.
  const order = [...built.ordinary.filter((t) => t !== 'schema_version' && t !== 'sqlite_sequence')];
  for (const t of candidates(logSrc)) if (!order.includes(t)) order.push(t);
  const logUnparsed = unparsed(logSrc);
  for (const t of logUnparsed.names) if (!order.includes(t)) order.push(t);
  const inLog = new Set(candidates(logSrc));
  for (const t of order) {
    const { acc } = stateOf(t);
    if (!inLog.has(t)) {
      acc.unreadable = !logSrc.db
        ? message(logSrc.error)
        : logUnparsed.names.includes(t)
          ? 'its definition does not parse'
          : 'its definition cannot be read';
      acc.logUnreadable = acc.unreadable;
      continue;
    }
    const def = definitionFor(t);
    if (def === 'main' || def === 'none') {
      acc.unreadable = referee.has(t)
        ? "its definition reads differently from this version's"
        : 'its definition reads differently from the one the database file holds';
      acc.logUnreadable = acc.unreadable;
      continue;
    }
    if (def === 'differs') acc.definitionDiffers = true;
    const made = ensureTable(logSrc, t);
    if (made !== true) {
      skipped.push({ table: t, why: `it could not be made in the fresh file (${message(made)})` });
      continue;
    }
    const r = copyFrom(logSrc, t, false);
    stateOf(t).stretches = r.stretches ?? [];
    acc.gaps = r.gaps ?? [];
    acc.missing = r.missing ?? [];
    acc.damaged = r.damaged ?? null;
    acc.disagreeing = r.disagreeing ?? [];
    if (r.unreadable) {
      acc.unreadable = r.unreadable;
      acc.logUnreadable = r.unreadable;
    }
  }
  // 1b. Tables whose definition the store as found lost or garbled: read with its log through the
  // definition the main file alone holds.
  const garbled = order.filter(
    (t) =>
      tables[t]?.logUnreadable &&
      /^its definition (does not parse|reads differently)/.test(tables[t].logUnreadable),
  );
  if (logSrc.db && garbled.length > 0 && mainSrc?.db) {
    const defs = garbled
      .filter((t) => mainSrc.tables.ordinary.includes(t) && mainUsable(t))
      .map((t) => [t, statementOf(mainSrc.db, 'table', t)])
      .filter(([, sql]) => sql);
    const fixed = defs.length > 0 ? transplant(storePath, scratchPath('log'), defs) : null;
    if (fixed) {
      handles.push(fixed.src.db);
      for (const t of fixed.done) {
        if (!fixed.src.tables.ordinary.includes(t) || !same(namesOf(fixed.src, t), namesOf(mainSrc, t)))
          continue;
        // A table this version does not create is made from the definition read through.
        const made = ensureTable(fixed.src, t);
        if (made !== true) {
          skipped.push({ table: t, why: `it could not be made in the fresh file (${message(made)})` });
          continue;
        }
        const { acc } = stateOf(t);
        const r = copyFrom(fixed.src, t, false);
        acc.transplanted = acc.logUnreadable;
        acc.unreadable = r.unreadable ?? null;
        acc.logUnreadable = r.unreadable ?? null;
        acc.gaps = r.gaps ?? [];
        acc.missing = r.missing ?? [];
        acc.damaged = r.damaged ?? null;
        acc.disagreeing = r.disagreeing ?? [];
      }
    }
  }
  const lost = (t) => {
    const st = state.get(t);
    if (!st) return true;
    const a = st.acc;
    return Boolean(
      a.unreadable || a.damaged || a.gaps.length > 0 || a.missing.length > 0 || st.failed.size > 0,
    );
  };

  // 2. The main file alone, for what the store as found lost.
  const main = order.some(lost) ? openMain() : null;
  if (main?.db) {
    for (const t of candidates(main)) if (!order.includes(t)) order.push(t);
    const inMain = new Set(candidates(main));
    for (const t of order) {
      if (!lost(t) || !inMain.has(t)) continue;
      const st = stateOf(t);
      const { acc, have } = st;
      // The main file's definition is judged as the log's is: read through a garbled one, every
      // row of the table fails or shifts (the round-3 defects review: one garbled column refused
      // the whole store).
      if (!mainUsable(t)) {
        acc.mainUnreadable = "its definition reads differently from this version's";
        continue;
      }
      // What the log could not give back: its stretches, the rowids an index lists, the rows the
      // fresh file refused. Every other rowid the main file holds and the log does not was
      // deleted by the log (the round-3 defects review: one damaged page brought back every row
      // the log deleted anywhere in the table). With no such evidence of where the loss is (a
      // damaged page that drops rows silently, in a table no index covers), every rowid.
      const ids = new Set([...acc.missing.map((id) => BigInt(id)), ...st.failed.keys()]);
      const stretches = st.stretches ?? [];
      st.want =
        acc.logUnreadable || (stretches.length === 0 && ids.size === 0)
          ? null
          : (id) => ids.has(id) || stretches.some((x) => id > x.after && (x.top === null || id <= x.top));
      const made = ensureTable(main, t);
      if (made !== true) {
        skipped.push({ table: t, why: `it could not be made in the fresh file (${message(made)})` });
        continue;
      }
      acc.mainRead = true;
      const r = copyFrom(main, t, true);
      if (acc.logUnreadable) {
        // Every row of it came from the main file alone: its reads are the account.
        acc.unreadable = r.unreadable ?? null;
        acc.gaps = r.gaps ?? [];
        acc.missing = r.missing ?? [];
        acc.damaged = r.damaged ?? null;
      } else {
        acc.mainDamaged = r.damaged ?? null;
        if (r.unreadable) acc.mainUnreadable = r.unreadable;
      }
      // A rowid the main file gave back is no longer missing.
      acc.missing = acc.missing.filter((id) => !have.has(BigInt(id)));
    }
  }
  // 2b. Rows whose values disagree with the table's own indexes in the store with its log, when its
  // pages are damaged: a damaged page can garble a row's values and keep its rowid, and the main
  // file alone may hold the row intact (round-3 claims review: 25 of 2,769 plants kept the garbled
  // copy). The main file's copy is kept instead when it agrees with that file's indexes.
  if (mainSrc?.db) {
    for (const t of order) {
      const st = state.get(t);
      const acc = st?.acc;
      if (!acc?.damaged || acc.disagreeing.length === 0 || acc.logUnreadable) continue;
      if (!mainSrc.tables.ordinary.includes(t) || !mainUsable(t)) continue;
      const theirs = new Set(tableDamage(mainSrc.db, t).disagreeing);
      const w = rowWriter(mainSrc, t);
      const byId = mainSrc.db
        .prepare(
          `SELECT rowid${w.cols.length ? ', ' : ''}${w.cols.map(q).join(', ')} FROM ${q(t)} WHERE rowid = ?`,
        )
        .raw(true)
        .safeIntegers(true);
      const drop = fresh.prepare(`DELETE FROM ${q(t)} WHERE rowid = ?`);
      for (const id of acc.disagreeing) {
        if (theirs.has(id)) continue;
        let row;
        try {
          row = byId.get(BigInt(id));
        } catch {
          row = undefined;
        }
        if (!row) continue;
        const had = st.have.has(row[0]);
        fresh.exec('SAVEPOINT keep_main');
        try {
          drop.run(row[0]);
          w.insert.run(w.alias ? row.slice(1) : row);
          fresh.exec('RELEASE keep_main');
        } catch {
          fresh.exec('ROLLBACK TO keep_main');
          fresh.exec('RELEASE keep_main');
          continue;
        }
        acc.replaced.push(id);
        if (!had) {
          st.have.add(row[0]);
          st.failed.delete(row[0]);
          acc.written++;
        }
      }
    }
  }
  for (const st of state.values()) {
    const { acc } = st;
    acc.notWrittenCount = st.failed.size;
    acc.notWritten = [...st.failed].slice(0, LIST_CAP).map(([id, why]) => ({ id: String(id), why }));
    acc.firstFailure = acc.notWritten[0]?.why ?? null;
    // An index that lists a rowid the table never had is damage of the index, not a lost row.
    if (!acc.damaged && !acc.mainDamaged) acc.missing = [];
    if (acc.unreadable && acc.written > 0) acc.unreadable = null;
  }
  // Virtual tables this version does not create are not copied, nor the internal tables of a
  // search index whose name damage garbled.
  for (const src of [logSrc, main]) {
    if (!src?.db) continue;
    for (const t of src.tables.ordinary) {
      if (shadowShaped(src, t) && !skipped.some((x) => x.table === t)) {
        skipped.push({
          table: t,
          why: 'the internal table of a search index, under a damaged name; not copied',
        });
      }
    }
    for (const v of src.tables.virtual) {
      if (!built.virtual.includes(v) && !skipped.some((x) => x.table === v)) {
        skipped.push({ table: v, why: 'a virtual table this version does not create; not copied' });
      }
    }
  }

  // 3. sqlite_sequence last, replaced by the old rows (same rowids, so it reads back equal), each seq
  // raised to at least what the copied rows set: an id must never be handed out twice.
  const seqAcc = (tables.sqlite_sequence = emptyAccount());
  let seqRows = null;
  for (const src of [logSrc, main]) {
    if (!src?.db) continue;
    try {
      seqRows = src.db
        .prepare('SELECT rowid, name, seq FROM sqlite_sequence ORDER BY rowid')
        .raw(true)
        .safeIntegers(true)
        .all();
      if (src === main) seqAcc.fromMain = seqRows.length;
      seqAcc.unreadable = null;
      break;
    } catch (e) {
      seqAcc.unreadable ??= message(e);
    }
  }
  if (seqRows) {
    const floor = new Map(
      fresh.prepare('SELECT name, seq FROM sqlite_sequence').raw(true).safeIntegers(true).all(),
    );
    fresh.exec('DELETE FROM sqlite_sequence');
    const insert = fresh.prepare('INSERT INTO sqlite_sequence (rowid, name, seq) VALUES (?, ?, ?)');
    const append = fresh.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
    // One counter per table, the highest read: a damaged page can hand one row back twice
    // (the round-3 claims review: "UNIQUE constraint failed: sqlite_sequence.rowid" stopped the repair).
    const counters = new Map();
    for (const [rowid, name, seq] of seqRows) {
      seqAcc.read++;
      const had = counters.get(name);
      if (!had) counters.set(name, { rowid, seq });
      else if (seq > had.seq) had.seq = seq;
    }
    const usedRowids = new Set();
    for (const [name, { rowid, seq }] of counters) {
      const min = floor.get(name);
      floor.delete(name);
      const value = min !== undefined && min > seq ? min : seq;
      if (usedRowids.has(rowid)) append.run(name, value);
      else insert.run(rowid, name, value);
      usedRowids.add(rowid);
      seqAcc.written++;
    }
    for (const [name, seq] of floor) append.run(name, seq);
  }
  fresh.exec('COMMIT');

  // 4. Refusals: observations none of which could be written, more than one and all for the same
  // reason (a schema read wrong, not a damaged row), and a store with no observation SQLite can
  // give back. Another table lost that way is named, not a reason to leave the store damaged.
  const obsState = state.get('observations');
  if (obsState) {
    const why = [...obsState.failed.values()];
    if (obsState.acc.written === 0 && why.length > 1 && why.every((w) => w === why[0])) {
      return { ok: false, reason: 'write', table: 'observations', tables };
    }
  }
  const obs = tables.observations;
  if (obs && obs.written === 0 && lost('observations')) {
    const why = obs.unreadable ?? obs.damaged ?? obs.gaps[0]?.error ?? 'damaged pages';
    return {
      ok: false,
      reason: 'unreadable',
      error: new Error(`no observation could be read (${why})`),
      tables,
    };
  }

  // 5. Triggers, search indexes, and the fresh file's own check.
  for (const t of triggers) fresh.exec(t.sql);
  const fts = rebuildFTS(fresh);
  const problems = [...fts.errors];
  try {
    const rows = fresh.prepare('PRAGMA integrity_check').pluck().all();
    if (!(rows.length === 1 && rows[0] === 'ok')) problems.push(...rows);
  } catch (e) {
    problems.push(message(e));
  }
  if (problems.length > 0) return { ok: false, reason: 'unsound', problems };
  fresh.pragma('wal_checkpoint(TRUNCATE)');
  const describe = (src) =>
    src === null || src === undefined
      ? null
      : src.db
        ? { writableSchema: src.writableSchema }
        : { error: message(src.error) };
  const sourcesOut = { log: describe(logSrc), main: describe(main) };
  if (!logUnparsed.complete) sourcesOut.log.masterIncomplete = true;
  return { ok: true, tables, skipped, sources: sourcesOut };
}
