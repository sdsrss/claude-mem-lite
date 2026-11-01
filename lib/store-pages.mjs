// lib/store-pages.mjs — whether a store's pages are sound enough for an index rebuild to write into (D#593).
//
// A rebuild (FTS5 'rebuild', REINDEX) frees the old index pages and allocates new ones, so a page a
// table still uses that the freelist also lists, or that a second tree uses too, is handed to the new
// index and the rows on it are overwritten: 6.30.8's doctor did that on the D#546 regression set.
//
// SQLite's integrity check cannot be this check on its own: in SQLite 3.53.4 the whole-store check
// becomes a partial one, skipping the freelist and the unused-page scan, whenever a virtual table
// comes first in its schema walk (sqlite3.c, sqlite3BtreeIntegrityCheck: aRoot[0]==0), which is the
// case on VACUUMed stores and VACUUM INTO snapshots. So the check counts every page itself, and reads
// the freelist from the store's files: this SQLite has no sqlite_dbpage, and the first attempt's
// serialize() copy of the whole store failed on any store of 2 GiB or more (one allocation is capped
// at 2,147,483,391 bytes), so only page 1 and the freelist trunk pages are read.
//
// A leaf: node built-ins only, so the doctor and CLI faces that load it pull in nothing else.

import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { endianness } from 'node:os';

// The rows of an integrity check that come from SQLite's B-tree checker start with this; the rest
// are about index entries or constraints, which are not page damage.
const PAGE_CHECK_ROW = '*** in database ';
// A step that throws one of these has met the damage. VTAB and INDEX are an index's own damage.
const PAGE_DAMAGE_CODE_RE = /^SQLITE_(CORRUPT(?!_VTAB|_INDEX)|NOTADB)/;
// The page holding the lock bytes (file offset 1 GiB) belongs to no tree and is never free.
const LOCK_BYTE_OFFSET = 0x40000000;
const WAL_HEADER = 32;
const FRAME_HEADER = 24;
const WAL_INDEX_HEADER = 48;
// WalCkptInfo follows the two copies of the wal-index header; nBackfill is its first field.
const NBACKFILL_AT = 2 * WAL_INDEX_HEADER;
// The wal-index lives in shared memory, in the machine's byte order (wal.c).
const LITTLE_ENDIAN = endianness() === 'LE';
const PIN_TRIES = 5;

/** A step that could not run for another reason than damage: the check did not happen. */
class NotChecked extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = code;
  }
}

function pread(fd, length, position) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

const u32 = (buf, at) => (LITTLE_ENDIAN ? buf.readUInt32LE(at) : buf.readUInt32BE(at));

/** The wal-index header when both copies agree (they differ while a writer updates them), else null. */
function readWalIndexHeader(fd) {
  const buf = pread(fd, NBACKFILL_AT + 4, 0);
  if (buf.length < NBACKFILL_AT + 4) return null;
  const header = buf.subarray(0, WAL_INDEX_HEADER);
  if (!header.equals(buf.subarray(WAL_INDEX_HEADER, NBACKFILL_AT)) || header[12] === 0) return null;
  const szPage = LITTLE_ENDIAN ? header.readUInt16LE(14) : header.readUInt16BE(14);
  return {
    raw: Buffer.from(header),
    pageSize: szPage === 1 ? 65536 : szPage,
    mxFrame: u32(header, 16),
    // Copied byte for byte from the log header (walIndexRecover's memcpy), so compared as bytes.
    salt: Buffer.from(header.subarray(32, 40)),
    nBackfill: u32(buf, NBACKFILL_AT),
  };
}

/**
 * Opens the read transaction the check reads in, and pins which log frames it sees: SQLite reads the
 * wal-index header when a read transaction starts (walTryBeginRead), so when the header is byte for
 * byte the same just before BEGIN's first read and just after it, nothing was committed or restarted
 * between, and the transaction's snapshot ends at that header's mxFrame.
 *
 * When every frame is already in the main file (nBackfill >= mxFrame, read once the transaction has
 * begun: nBackfill only grows within one header's log, so a smaller one then was smaller at its start)
 * the reader may hold read lock 0,
 * which reads the main file alone and does not stop a writer from restarting the log over the frames;
 * the main file is then the snapshot, and a checkpoint cannot write to it while lock 0 is held. Otherwise
 * the reader holds a lock that stops a restart, and a checkpoint copies only frames within the snapshot.
 * Returns the frames to read (mxFrame 0: the main file alone). Leaves the transaction open.
 */
function beginPinnedRead(db, files) {
  const first = db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1');
  // A read first, so the connection has opened the log if there is one (and with it the -shm, after
  // recovering the log) before the journal mode is asked and the log index header is read.
  first.get();
  const mode = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
  if (mode !== 'wal') {
    // A rollback-journal store: the read transaction's shared lock keeps every writer from committing.
    db.exec('BEGIN');
    first.get();
    return { mxFrame: 0 };
  }
  let shm;
  try {
    shm = openSync(`${files}-shm`, 'r');
  } catch (e) {
    throw new NotChecked(`the log index could not be read (${e.code ?? e.message})`, e.code ?? null);
  }
  try {
    for (let i = 0; i < PIN_TRIES; i++) {
      const before = readWalIndexHeader(shm);
      db.exec('BEGIN');
      first.get();
      const after = readWalIndexHeader(shm);
      if (before && after && before.raw.equals(after.raw)) {
        // nBackfill as the transaction sees it: read after its first read. A checkpoint can finish
        // between the first header read and BEGIN, and then the reader takes read lock 0.
        return after.nBackfill >= after.mxFrame ? { mxFrame: 0 } : after;
      }
      db.exec('ROLLBACK');
    }
  } finally {
    closeSync(shm);
  }
  throw new NotChecked('the store kept changing while it was being checked', 'SQLITE_BUSY');
}

/**
 * Page images as the pinned transaction sees them: the newest of log frames 1..mxFrame for a page,
 * else the main file (zeros past its end, as SQLite reads them). Reads frame headers only, to map
 * page numbers to frames; a page is read when asked for.
 */
function openSnapshotPages(files, pageSize, wal) {
  const fds = [openSync(files, 'r')];
  const inLog = new Map();
  try {
    if (wal.mxFrame > 0) {
      fds.push(openSync(`${files}-wal`, 'r'));
      const log = fds[1];
      const header = pread(log, WAL_HEADER, 0);
      if (header.length < WAL_HEADER) throw new NotChecked('the log is shorter than its header');
      if (header.readUInt32BE(8) !== pageSize)
        throw new NotChecked('the log page size disagrees with the store');
      if (!header.subarray(16, 24).equals(wal.salt)) throw new NotChecked('the log does not match its index');
      const step = FRAME_HEADER + pageSize;
      for (let frame = 1; frame <= wal.mxFrame; frame++) {
        const at = WAL_HEADER + (frame - 1) * step;
        const f = pread(log, FRAME_HEADER, at);
        if (f.length < FRAME_HEADER) throw new NotChecked(`log frame ${frame} is past the end of the log`);
        if (!f.subarray(8, 16).equals(wal.salt))
          throw new NotChecked(`log frame ${frame} does not match its index`);
        inLog.set(f.readUInt32BE(0), at + FRAME_HEADER);
      }
    }
  } catch (e) {
    for (const fd of fds) closeSync(fd);
    throw e;
  }
  const mainSize = fstatSync(fds[0]).size;
  return {
    page(pageno) {
      const at = inLog.get(pageno);
      if (at !== undefined) return pread(fds[1], pageSize, at);
      const pos = (pageno - 1) * pageSize;
      const buf = Buffer.alloc(pageSize);
      if (pos < mainSize) pread(fds[0], Math.min(pageSize, mainSize - pos), pos).copy(buf);
      return buf;
    },
    close() {
      for (const fd of fds) closeSync(fd);
    },
  };
}

/** The pointer-map page that holds page `pageno`'s entry (sqlite3.c ptrmapPageno). */
function ptrmapPageno(usable, lockPage, pageno) {
  if (pageno < 2) return 0;
  const perMapPage = Math.floor(usable / 5) + 1;
  let ret = Math.floor((pageno - 2) / perMapPage) * perMapPage + 2;
  if (ret === lockPage) ret++;
  return ret;
}

/**
 * Whether the store's pages are sound enough for an index rebuild to write into. In one read
 * transaction:
 * 1. SQLite's B-tree check (`quick_check`) one table at a time, sqlite_schema first, whose check also
 *    walks the freelist. Only the checker's own rows count.
 * 2. Every page counted once: the lock-byte page, the pointer-map pages of an auto_vacuum store, the
 *    freelist (read from the store's files, as the transaction sees them), each tree's pages from
 *    dbstat. A page counted twice, a page number past the end, a trunk page listing more pages than
 *    it can hold, a freelist the header disagrees with, or a page nothing uses is damage.
 * Reads nothing from a connection's own transaction: one already open is an error (`unchecked`).
 * Memory: four bytes per page and one page at a time, whatever the store's size.
 * @param {import('better-sqlite3').Database} db a connection to a store on disk
 * @param {{max?: number}} [opts] at most `max` lines are kept, and `more` counts the rest
 * @returns {{state: 'ok'|'damaged'|'unchecked', lines: string[], more: number, error?: string,
 *   code?: string|null}} `unchecked`: a step failed for another reason than damage (`error`, `code`)
 */
export function checkStorePages(db, { max = 10 } = {}) {
  const lines = [];
  let began = false;
  let pages = null;
  try {
    if (db.memory) throw new NotChecked('an in-memory database has no file to read');
    if (db.inTransaction) throw new NotChecked('the connection is inside a transaction');
    // SQLite names the log after the store's real path, every symlink resolved (unixFullPathname).
    const files = realpathSync(db.name);
    began = true;
    const wal = beginPinnedRead(db, files);
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND rootpage > 0 ORDER BY name")
      .pluck()
      .all();
    for (const table of ['sqlite_schema', ...tables]) {
      const rows = db
        .prepare(`PRAGMA quick_check('${table.replace(/'/g, "''")}')`)
        .pluck()
        .all();
      for (const row of rows.map(String)) {
        if (row.startsWith(PAGE_CHECK_ROW)) lines.push(...row.split('\n').slice(1).filter(Boolean));
      }
    }
    const pageCount = db.pragma('page_count', { simple: true });
    const pageSize = db.pragma('page_size', { simple: true });
    if (wal.mxFrame > 0 && wal.pageSize !== pageSize)
      throw new NotChecked('the log index page size disagrees with the store');
    pages = openSnapshotPages(files, pageSize, wal);
    const page1 = pages.page(1);
    const headerPageSize = page1.readUInt16BE(16) === 1 ? 65536 : page1.readUInt16BE(16);
    if (headerPageSize !== pageSize) {
      throw new NotChecked(`page 1 reads a page size of ${headerPageSize}, SQLite ${pageSize}`);
    }
    const freelistCount = page1.readUInt32BE(36);
    // The read must be the transaction's: four header fields SQLite reports from the same snapshot.
    for (const [pragma, read] of [
      ['freelist_count', freelistCount],
      ['schema_version', page1.readUInt32BE(40)],
      ['user_version', page1.readInt32BE(60)],
      ['application_id', page1.readInt32BE(68)],
    ]) {
      const said = db.pragma(pragma, { simple: true });
      if (said !== read) throw new NotChecked(`page 1 reads ${pragma} ${read}, SQLite ${said}`);
    }
    const usable = pageSize - page1[20];
    const names = [''];
    const nameIds = new Map();
    const owner = new Uint32Array(pageCount + 1);
    const count = (pageno, by) => {
      if (!(pageno >= 1 && pageno <= pageCount)) {
        lines.push(`${by}: invalid page number ${pageno}`);
        return false;
      }
      if (owner[pageno] !== 0) {
        lines.push(`page ${pageno}: in ${names[owner[pageno]]} and in ${by}`);
        return false;
      }
      let id = nameIds.get(by);
      if (id === undefined) {
        id = names.push(by) - 1;
        nameIds.set(by, id);
      }
      owner[pageno] = id;
      return true;
    };
    const lockPage = Math.floor(LOCK_BYTE_OFFSET / pageSize) + 1;
    if (lockPage <= pageCount) count(lockPage, 'the lock-byte page');
    // Header offset 52, the largest root page, is non-zero only in auto_vacuum and incremental_vacuum
    // stores, whose pointer-map pages are in use.
    if (page1.readUInt32BE(52) !== 0) {
      for (let p = 2; p <= pageCount; p++)
        if (ptrmapPageno(usable, lockPage, p) === p) count(p, 'the pointer map');
    }
    let listed = 0;
    for (let trunk = page1.readUInt32BE(32); trunk !== 0;) {
      if (!count(trunk, 'the freelist')) break;
      listed++;
      const t = pages.page(trunk);
      const leaves = t.readUInt32BE(4);
      if (leaves > usable / 4 - 2) {
        lines.push(`the freelist: trunk page ${trunk} lists ${leaves} pages`);
        break;
      }
      for (let i = 0; i < leaves; i++) count(t.readUInt32BE(8 + 4 * i), 'the freelist');
      listed += leaves;
      trunk = t.readUInt32BE(0);
    }
    if (listed !== freelistCount)
      lines.push(`the freelist: ${listed} pages listed, the header says ${freelistCount}`);
    for (const [name, pageno] of db.prepare('SELECT name, pageno FROM dbstat').raw().iterate())
      count(pageno, name);
    for (let p = 1; p <= pageCount; p++) if (owner[p] === 0) lines.push(`page ${p}: never used`);
  } catch (e) {
    if (e instanceof NotChecked || !PAGE_DAMAGE_CODE_RE.test(e?.code ?? '')) {
      return {
        state: 'unchecked',
        lines: [],
        more: 0,
        error: String(e?.message ?? e),
        code: e?.code ?? null,
      };
    }
    lines.push(e.message);
  } finally {
    pages?.close();
    if (began && db.inTransaction) db.exec('ROLLBACK');
  }
  if (lines.length === 0) return { state: 'ok', lines, more: 0 };
  return { state: 'damaged', lines: lines.slice(0, max), more: Math.max(0, lines.length - max) };
}
