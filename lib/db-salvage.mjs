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
// page reads on (2026-10-21: a scan stopped at 127, a seek past 150 read 151), so the rows between
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
 * still reads (round-2 claims F1: 8 of the 46 `✗ Database` plants, 241 observations each).
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
 * Whether a table's own pages fail integrity_check; the first such problem, or null. A problem SQLite
 * places on one of the table's indexes, or on a page outside the table's own tree when that tree
 * walks to its end, does not count, nor does a row-against-index mismatch: the fresh file rebuilds
 * every index from the rows. A check that stopped before naming any page counts. SQLite checks the
 * table's own tree before its indexes (pragma.c lists its root first), so a problem of the table's
 * comes before the check's 100-problem limit.
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
  if (!threw && problems.length === 1 && problems[0] === 'ok') return null;
  const structural = problems.filter((p) => !AGREEMENT_RE.test(p));
  if (structural.length === 0) return threw ? message(threw) : (problems[0] ?? 'integrity_check failed');
  // A message names a b-tree by its root ("Tree R page P: ...") or only a page ("Multiple uses for
  // byte B of page P"); dbstat cannot walk past a damaged page, so an index's pages are not all known.
  const own = pagesOf(db, table);
  const ownPages = new Set(own.pages);
  const indexRoots = new Set();
  let indexes = [];
  try {
    indexes = db.prepare('SELECT name FROM pragma_index_list(?)').pluck().all(table);
  } catch {
    /* none known */
  }
  for (const ix of indexes) {
    const root = pagesOf(db, ix).pages[0];
    if (root !== undefined) indexRoots.add(root);
  }
  for (const p of structural) {
    const tree = /^Tree (\d+) page (\d+)/.exec(p);
    const page = tree ? Number(tree[2]) : Number(/\bpage (\d+)/.exec(p)?.[1]);
    if ((tree && Number(tree[1]) === own.pages[0]) || ownPages.has(page)) return p;
    if (tree && indexRoots.has(Number(tree[1]))) continue;
    if (own.complete && own.pages.length > 0 && Number.isInteger(page)) continue;
    return p;
  }
  return null;
}

/**
 * The rowid nearest past `after` (above it, or below it for a descending read) from which a seek
 * reads without an error, and the first rowid it reads (null: none past it); null when no seek up
 * to the last rowid reads.
 */
function nextReadable(seek, after, desc) {
  const tryAt = (x) => {
    try {
      return { first: seek.get(x)?.[0] ?? null };
    } catch {
      return null;
    }
  };
  const limit = desc ? MIN_ROWID : MAX_ROWID;
  const past = (x, d) =>
    desc ? (x - d < MIN_ROWID ? MIN_ROWID : x - d) : x + d > MAX_ROWID ? MAX_ROWID : x + d;
  let bad = after;
  let good;
  let hit;
  for (let d = 1n; ; d *= 2n) {
    const x = past(bad, d);
    hit = tryAt(x);
    if (hit) {
      good = x;
      break;
    }
    if (x === limit) return null;
    bad = x;
  }
  for (;;) {
    const span = desc ? bad - good : good - bad;
    if (span <= 1n) break;
    const mid = desc ? bad - span / 2n : bad + span / 2n;
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
  const dir = {
    asc: {
      all: prep(`${sel} ORDER BY rowid`),
      beyond: prep(`${sel} WHERE rowid > ? ORDER BY rowid`),
      seek: prep(`${sel} WHERE rowid > ? ORDER BY rowid LIMIT 1`),
      edge: MIN_ROWID - 1n,
    },
    desc: {
      all: prep(`${sel} ORDER BY rowid DESC`),
      beyond: prep(`${sel} WHERE rowid < ? ORDER BY rowid DESC`),
      seek: prep(`${sel} WHERE rowid < ? ORDER BY rowid DESC LIMIT 1`),
      edge: MAX_ROWID + 1n,
    },
  };
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
  // One pass in rowid order, stepping past each damaged stretch. Returns whether it met one.
  const pass = (desc) => {
    const d = desc ? dir.desc : dir.asc;
    const behind = (a, b) => (desc ? a > b : a < b);
    let from = null;
    let met = false;
    for (let n = 0; ; n++) {
      let prev = null;
      let last = null;
      try {
        for (const row of from === null ? d.all.iterate() : d.beyond.iterate(from)) {
          hand(row);
          prev = last;
          last = row[0];
        }
        return met;
      } catch (e) {
        met = true;
        // Restart past the last rowid read, unless it leapt past the one before it by more than a
        // stretch (a garbage cell can carry any rowid), and never behind where this scan began.
        let at = last;
        if (at !== null && prev !== null && (desc ? prev - at : at - prev) > LOOKUP_CAP) at = prev;
        if (from !== null && (at === null || !behind(from, at))) at = from;
        const after = at ?? d.edge;
        const next = n < GAP_CAP ? nextReadable(d.seek, after, desc) : null;
        if (!desc) {
          // Every rowid the scan could not reach, one by one, when there are not too many; else
          // the ones next to what was read on either side, where a table's ids sit.
          const end = next ? next.at : MAX_ROWID;
          const whole = end - after <= LOOKUP_CAP;
          if (whole) for (let id = after + 1n; id <= end; id++) lookUp(id);
          else {
            for (let id = after + 1n; id <= after + LOOKUP_CAP / 2n; id++) lookUp(id);
            for (let id = end - LOOKUP_CAP / 2n + 1n; id <= end; id++) lookUp(id);
          }
          gapCount++;
          if (gaps.length < LIST_CAP)
            gaps.push({
              after: at === null ? null : String(at),
              before: next && next.first !== null ? String(next.first) : null,
              lookedUp: whole,
              error: message(e),
            });
        }
        if (!next || next.first === null) return met;
        from = next.at;
      }
    }
  };
  // The rows of a damaged leaf past its bad cell read from the other side.
  if (pass(false)) pass(true);
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
  return { gaps, gapCount, missing: missing.map(String) };
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
 * @returns {object} `{ok: true, tables, skipped, sources}` or `{ok: false, reason, ...}` with reason
 *   `unreadable` (no source opens, or no observation reads), `version`, `columns`, `create`, `write`
 *   (no row of a table that read rows could be written) or `unsound` (the fresh file failed its own
 *   checks). The fresh file is closed either way; the caller removes it unless the result is ok.
 */
export function salvage(
  storePath,
  freshPath,
  { mainAlone = () => null, scratch = (s) => `${freshPath}.${s}` } = {},
) {
  const handles = [];
  const made = [];
  const scratchPath = (s) => {
    const p = scratch(s);
    made.push(p);
    return p;
  };
  try {
    return salvageOpen(storePath, freshPath, mainAlone, scratchPath, handles);
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

function salvageOpen(storePath, freshPath, mainAlone, scratchPath, handles) {
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
  const candidates = (src) =>
    src?.db
      ? src.tables.ordinary.filter((t) => t !== 'schema_version' && t !== 'sqlite_sequence' && !isShadow(t))
      : [];
  // At this version a table's columns are this version's: a definition that reads otherwise was
  // damaged, and reading through it would shift values into the wrong columns.
  const defDiffers = (src, t) => {
    const want = freshCols.get(t);
    if (!want) return false;
    const have = columnsOf(src.db, t).map((c) => c.name);
    return have.length !== want.size || have.some((c) => !want.has(c));
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

  /** Copy the rows of table t that the fresh file does not hold yet from one source. */
  const copyFrom = (src, t, fromMain) => {
    const st = stateOf(t);
    const { acc } = st;
    const oldCols = columnsOf(src.db, t);
    if (oldCols.length === 0) return { unreadable: 'its definition cannot be read' };
    if (!st.cleared) {
      fresh.exec(`DELETE FROM ${q(t)}`);
      st.cleared = true;
    }
    const want = freshCols.get(t);
    const cols = oldCols.map((c) => c.name).filter((n) => want.has(n));
    for (const c of oldCols)
      if (!want.has(c.name) && !acc.droppedColumns.includes(c.name)) acc.droppedColumns.push(c.name);
    const pk = oldCols.filter((c) => c.pk > 0);
    const alias = pk.length === 1 && /^integer$/i.test(pk[0].type) && cols.includes(pk[0].name);
    const target = [...(alias ? [] : ['rowid']), ...cols.map(q)];
    const insert = fresh.prepare(
      `INSERT INTO ${q(t)} (${target.join(', ')}) VALUES (${target.map(() => '?').join(', ')})`,
    );
    const hadRows = st.have.size > 0;
    const take = (row) => {
      const id = row[0];
      if (st.have.has(id)) return true;
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
    const damaged = tableDamage(src.db, t);
    try {
      return { ...readTable(src.db, t, cols, take), damaged };
    } catch (e) {
      return { unreadable: message(e), damaged };
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
    if (defDiffers(logSrc, t)) {
      acc.unreadable = "its definition reads differently from this version's";
      acc.logUnreadable = acc.unreadable;
      continue;
    }
    const made = ensureTable(logSrc, t);
    if (made !== true) {
      fresh.exec('ROLLBACK');
      return { ok: false, reason: 'create', table: t, error: made };
    }
    const r = copyFrom(logSrc, t, false);
    acc.gaps = r.gaps ?? [];
    acc.missing = r.missing ?? [];
    acc.damaged = r.damaged ?? null;
    if (r.unreadable) {
      acc.unreadable = r.unreadable;
      acc.logUnreadable = r.unreadable;
    }
  }
  // 1b. Tables whose definition the store as found lost or garbled: read with its log through the
  // definition the main file alone holds.
  const garbled = order.filter(
    (t) =>
      freshCols.has(t) &&
      tables[t]?.logUnreadable &&
      /^its definition (does not parse|reads differently)/.test(tables[t].logUnreadable),
  );
  if (logSrc.db && garbled.length > 0 && openMain()?.db) {
    const defs = garbled
      .filter((t) => mainSrc.tables.ordinary.includes(t) && !defDiffers(mainSrc, t))
      .map((t) => [t, statementOf(mainSrc.db, 'table', t)])
      .filter(([, sql]) => sql);
    const fixed = defs.length > 0 ? transplant(storePath, scratchPath('log'), defs) : null;
    if (fixed) {
      handles.push(fixed.src.db);
      for (const t of fixed.done) {
        if (!fixed.src.tables.ordinary.includes(t) || defDiffers(fixed.src, t)) continue;
        const { acc } = stateOf(t);
        const r = copyFrom(fixed.src, t, false);
        acc.transplanted = acc.logUnreadable;
        acc.unreadable = r.unreadable ?? null;
        acc.logUnreadable = r.unreadable ?? null;
        acc.gaps = r.gaps ?? [];
        acc.missing = r.missing ?? [];
        acc.damaged = r.damaged ?? null;
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
      const { acc, have } = stateOf(t);
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
  for (const st of state.values()) {
    const { acc } = st;
    acc.notWrittenCount = st.failed.size;
    acc.notWritten = [...st.failed].slice(0, LIST_CAP).map(([id, why]) => ({ id: String(id), why }));
    acc.firstFailure = acc.notWritten[0]?.why ?? null;
    // An index that lists a rowid the table never had is damage of the index, not a lost row.
    if (!acc.damaged && !acc.mainDamaged) acc.missing = [];
    if (acc.unreadable && acc.written > 0) acc.unreadable = null;
  }
  // Virtual tables this version does not create are not copied.
  for (const src of [logSrc, main]) {
    if (!src?.db) continue;
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
    for (const [rowid, name, seq] of seqRows) {
      seqAcc.read++;
      const min = floor.get(name);
      floor.delete(name);
      insert.run(rowid, name, min !== undefined && min > seq ? min : seq);
      seqAcc.written++;
    }
    const append = fresh.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
    for (const [name, seq] of floor) append.run(name, seq);
  }
  fresh.exec('COMMIT');

  // 4. Refusals: a table none of whose rows could be written, more than one and all for the same
  // reason (a schema read wrong, not a damaged row: one garbled row of a one-row table is not that),
  // and a store with no observation SQLite can give back.
  for (const [t, st] of state) {
    const why = [...st.failed.values()];
    if (st.acc.written === 0 && why.length > 1 && why.every((w) => w === why[0])) {
      return { ok: false, reason: 'write', table: t, tables };
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
