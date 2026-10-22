// lib/db-repair.mjs — copy the rows SQLite can still read into a fresh file, check it, and write it
// back into the store (D#541, D#546). The read is lib/db-salvage.mjs; this file decides, writes
// back, and says what happened.
//
// WHY A COPY. A damaged page reaches the main file from any read-write close: the last connection
// to close a WAL store checkpoints first and checks no page, and hooks, the MCP server and doctor
// all close read-write. On the 116 WAL plants whose rows all read back but whose file failed
// integrity_check, the v6.30.3 experiment tried four repairs: VACUUM passed 18, DROP + recreate
// the FTS tables 0, writable_schema delete + VACUUM 59, and a fresh-file copy 114
// (docs/audits/20261021-v6.30.3-d533-d535-measurements.md, Q2).
//
// NOTHING READ-WRITE BEFORE THE WRITE. A read-write close checkpoints a damaged log frame into the
// main file: on 21 of 869 plants that turned a main file which alone read 200 observations into one
// that read none (first pre-tag review), and a lock probe that closed read-write did the same on
// every refusal after it (round-2 defects F4). So the store is read read-only; the lock probe runs
// in a child that is killed rather than closed, which writes nothing; and the write-back holds a
// read-only connection open, under which no other connection's close can checkpoint, so a backup
// that fails leaves the store as found.
//
// HOW IT REPLACES. The store as found, main file and log, is first copied aside byte for byte. The
// checked file is then written INTO the store through SQLite's backup API, not renamed over it: a
// connection open across a rename keeps the old inode but names `<db>-wal` and `<db>-shm` after the
// path, and its next write corrupted the renamed-in store (first pre-tag review). The backup's
// first step takes the store's write lock before it copies a page, and the store's files are
// compared there with what was read: a save committed after the read stops the write-back, and
// none can commit after it (round-2 defects F5).

import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { CURRENT_SCHEMA_VERSION } from '../schema.mjs';
import { takeLock } from './proc-lock.mjs';
import { dbUnusableRemedy, damagedAsidePath } from './db-unusable.mjs';
import { salvage } from './db-salvage.mjs';
import { shellWord } from '../cli-path.mjs';

const message = (e) => String(e?.message ?? e);

// SQLite could not open or check the file at all, which says nothing about its pages: a path, a
// permission, a lock, a full disk, an I/O error. Every other SQLite error from opening or checking
// the store is damage: SQLITE_ERROR included (an FTS5 table whose stored options are damaged fails
// to connect with it), and SQLITE_NOMEM, which integrity_check raises on damaged FTS5 data (round-2
// claims F6: 4 of 869 plants, every row readable).
const NOT_DAMAGE_RE = /^SQLITE_(CANTOPEN|IOERR|BUSY|LOCKED|READONLY|PERM|AUTH|FULL)/;
const isDamage = (e) => /^SQLITE_/.test(e?.code ?? '') && !NOT_DAMAGE_RE.test(e.code);

/**
 * `PRAGMA integrity_check` on an open handle, then a full read of each FTS5 table's first row,
 * which reads its content table through the columns its stored definition names: damage in that
 * definition passes integrity_check and fails every rebuild (p61-v10 of the 869-plant sweep). The
 * pragma yields its first problem rows and then can THROW from the iterator (SQLITE_CORRUPT on a
 * damaged b-tree page, measured 2026-10-21), so it is iterated rather than `.all()`-ed, which
 * would lose the rows read before the throw. A throw that is damage, or that follows a problem
 * row, is a failed check; any other throw before a row (SQLITE_CANTOPEN) means it did not run.
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
  if (rows.length === 1 && rows[0] === 'ok') {
    rows.length = 0;
    let fts;
    try {
      fts = db
        .prepare(`SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'virtual'`)
        .pluck()
        .all();
    } catch (e) {
      return isDamage(e)
        ? { ok: false, problems: [message(e)] }
        : { ok: false, problems: [], notChecked: message(e) };
    }
    for (const v of fts) {
      try {
        db.prepare(`SELECT * FROM "${v.replace(/"/g, '""')}" LIMIT 1`).all();
      } catch (e) {
        if (!isDamage(e)) return { ok: false, problems: [], notChecked: message(e) };
        rows.push(`${v}: ${message(e)}`);
      }
    }
    if (rows.length === 0) return { ok: true, problems: [] };
  }
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

const BETTER_SQLITE3 = createRequire(import.meta.url).resolve('better-sqlite3');
// Opens the store read-write in EXCLUSIVE locking mode, which keeps its log index in its own memory
// and must take the file's exclusive lock, reports, and is killed: a closing connection would
// checkpoint the log into the main file, a killed one writes nothing.
const PROBE_SRC = `
const Database = require(process.argv[1]);
let out;
try {
  const db = new Database(process.argv[2], { fileMustExist: true });
  db.pragma('busy_timeout = 0');
  db.pragma('locking_mode = EXCLUSIVE');
  db.exec('BEGIN EXCLUSIVE');
  out = { acquired: true };
} catch (e) {
  out = { acquired: false, code: e.code, message: e.message };
}
process.stdout.write(JSON.stringify(out), () => process.kill(process.pid, 'SIGKILL'));
`;

/**
 * Whether another connection, in any process, has `dbPath` open and has read from it: an exclusive
 * lock cannot be taken while one does (SQLITE_BUSY, also from another PID namespace under bwrap
 * --unshare-pid). A connection that has opened the file and not read it yet holds no lock and is
 * not seen. Writes nothing to the store: measured 2026-10-21, main file and log byte-identical
 * after it, with and without a holder (it may leave an empty log where there was none).
 * @param {string} dbPath
 * @returns {{acquired: true} | {acquired: false, busy: boolean, error: Error}}
 */
export function probeExclusive(dbPath) {
  const r = spawnSync(process.execPath, ['-e', PROBE_SRC, BETTER_SQLITE3, dbPath], {
    encoding: 'utf8',
    timeout: 30000,
  });
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    const error = new Error(
      `the lock check could not run (${r.error?.message ?? r.stderr?.trim() ?? r.signal})`,
    );
    return { acquired: false, busy: false, error };
  }
  if (out.acquired) return { acquired: true };
  const error = Object.assign(new Error(out.message), { code: out.code });
  return { acquired: false, busy: /^SQLITE_(BUSY|LOCKED)/.test(out.code ?? ''), error };
}

const fileStat = (p) => {
  try {
    const s = statSync(p);
    // An empty log holds nothing: the lock probe can leave one where there was none.
    return s.size === 0 ? 'empty' : `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return 'empty';
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

const listIds = (ids, total = ids.length) =>
  total > 10 ? `${ids.slice(0, 10).join(', ')} and ${total - 10} more` : ids.join(', ');
const MB = (n) => `${Math.ceil(n / 1048576)} MB`;

/**
 * The `repair-db` command. Returns what happened and the lines to print; the caller prints them.
 * @param {string} dbPath
 * @param {object} opts
 * @param {string} opts.lockPath install.lock
 * @param {(fn: () => any) => Promise<any>|any} [opts.swapGuard] runs the final check and the
 *   write-back (install.mjs passes its hook barrier)
 * @param {() => number} [opts.now]
 * @param {() => void} [opts.afterCopy] test seam: runs between the copy and the write-back
 * @param {(p: string) => number} [opts.freeBytes] test seam: free bytes of the directory holding p
 * @returns {Promise<{outcome: 'healthy'|'repaired'|'refused', exitCode: number,
 *   lines: {level: 'ok'|'warn'|'fail'|'info', text: string}[], tables?: object, aside?: string}>}
 */
export async function repairDb(
  dbPath,
  { lockPath, swapGuard = (fn) => fn(), now = Date.now, afterCopy, freeBytes = defaultFreeBytes } = {},
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
    return await repairLocked(dbPath, { say, end, swapGuard, now, afterCopy, freeBytes });
  } catch (e) {
    // A full disk mid-copy, a file system that refused a write: the temporary files go in the
    // finally of repairLocked, and the store is written only by the backup, which commits or rolls
    // back under the read-only guard.
    say('fail', `repair-db stopped: ${message(e)}. Run doctor to see the state of the database.`);
    return end('refused');
  } finally {
    lock.release();
  }
}

function defaultFreeBytes(p) {
  const s = statfsSync(dirname(p));
  return Number(s.bavail) * Number(s.bsize);
}

async function repairLocked(dbPath, { say, end, swapGuard, now, afterCopy, freeBytes }) {
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
  // The snapshot restore or set-aside, for a store repair-db cannot copy.
  const fallback = (err) => {
    const remedy = dbUnusableRemedy(real, err, { afterRepair: true, now });
    say(
      'info',
      remedy.command ? `${remedy.note} Once every Claude Code session is closed, run:` : remedy.note,
    );
    if (remedy.command) say('info', remedy.command);
    return end('refused');
  };
  const refuseUnreadable = (err) => {
    say('fail', `SQLite cannot read ${dbPath}: ${message(err)}. Nothing was written to the database.`);
    return fallback(err);
  };

  const integrity = checkIntegrity(real);
  if (integrity.ok) {
    say('ok', `${dbPath} passes SQLite's integrity check — nothing to repair.`);
    return end('healthy');
  }
  if (integrity.notChecked) return refuseCannotOpen(integrity.notChecked);
  say('warn', `SQLite's integrity check fails: ${summarizeIntegrity(integrity.problems)}`);

  // The fresh file, the store as found kept aside, and the backup's log of the fresh pages: each
  // about the store's size (peak measured at 4.0x on a 389 MB store, round-2 defects F9).
  const need = 3 * (sizeOf(real) + sizeOf(wal)) + 16 * 1048576;
  let free = null;
  try {
    free = freeBytes(real);
  } catch {
    /* unknown: let the copy find out */
  }
  if (free !== null && free < need) {
    say(
      'fail',
      `repair-db needs about ${MB(need)} free beside ${dbPath} (three copies of the store) and there is ${MB(free)}. ` +
        'Nothing was written to the database; free some space and run it again.',
    );
    return end('refused');
  }

  // One time for every file this run names, so they read as one run's (round-2 defects F10).
  const t0 = now();
  const stamp = new Date(t0).toISOString().replace(/[:.]/g, '-');
  const tmp = `${real}.repair-${stamp}.tmp`;
  const mainCopy = `${real}.repair-${stamp}.main`;
  let aside = null;
  let keepAside = false;
  let keepTmp = null;
  try {
    const seen = storeState(real);
    let built;
    try {
      built = salvage(real, tmp, {
        scratch: (s) => `${real}.repair-${stamp}.${s}`,
        mainAlone: () => {
          if (sizeOf(wal) === 0) return null;
          copyAside(real, mainCopy);
          return mainCopy;
        },
      });
    } finally {
      removeFile(mainCopy);
    }
    if (!built.ok) {
      if (built.reason === 'unreadable') {
        return isDamage(built.error) || !built.error?.code
          ? refuseUnreadable(built.error)
          : refuseCannotOpen(message(built.error));
      }
      if (built.reason === 'version') {
        say(
          'fail',
          `The database is at schema v${built.version} and this claude-mem-lite builds v${CURRENT_SCHEMA_VERSION}; ` +
            'a copy between them would drop columns or skip a migration. Nothing was written to the database. ' +
            'Run the repair-db of the claude-mem-lite that wrote it (the newest one installed).',
        );
        return end('refused');
      }
      if (built.reason === 'columns') {
        const what = [
          built.extra.length ? `has ${built.extra.join(', ')}, which this version does not` : '',
          built.lacking.length ? `lacks ${built.lacking.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' and ');
        say(
          'fail',
          `The schema version cannot be read, and ${built.table} ${what}: the database is from another version of ` +
            'claude-mem-lite, and a copy would drop columns or skip a migration. Nothing was written to the database.',
        );
        say('info', 'Run the repair-db of the newest claude-mem-lite installed. If that is this one:');
        return fallback(new Error('its schema is from another version'));
      }
      if (built.reason === 'create') {
        say(
          'fail',
          `${built.table}: the table could not be made in the fresh file (${message(built.error)}). Nothing was written to the database.`,
        );
        return end('refused');
      }
      if (built.reason === 'write') {
        const a = built.tables[built.table];
        say(
          'fail',
          `${built.table}: none of its ${a.read} rows could be written to the fresh file (${a.firstFailure}), so the ` +
            'database was read wrong rather than damaged in places. Nothing was written to the database.',
        );
        return fallback(new Error(`no row of ${built.table} could be written (${a.firstFailure})`));
      }
      say(
        'fail',
        `The fresh file did not come out sound: ${built.problems.join('; ')}. Nothing was written to the database.`,
      );
      return end('refused');
    }
    const { tables } = built;
    const logError = built.sources.log?.error ?? null;

    afterCopy?.();
    const changed = () => {
      say(
        'fail',
        `${dbPath} changed while it was being read (another process opened or wrote it), so it was not replaced.`,
      );
      say(
        'info',
        'Close every Claude Code session, this one included, then run repair-db again from a terminal.',
      );
      return end('refused', { tables });
    };
    if (storeState(real) !== seen) return changed();
    // The store as found, before anything opens it read-write.
    aside = damagedAsidePath(real, () => t0);
    copyAside(real, aside);
    const asideWal = sizeOf(wal) > 0 ? `${aside}-wal` : null;
    if (asideWal) copyAside(wal, asideWal);
    if (storeState(real) !== seen) return changed();
    const kept = asideWal ? `${aside} and ${asideWal}` : aside;

    // The checked copy is left for the person to put in place; the store as found is kept.
    const leaveForHand = (why) => {
      keepAside = true;
      keepTmp = `${real}.repaired-${stamp}`;
      renameSync(tmp, keepTmp);
      for (const ext of ['-wal', '-shm']) rmSync(tmp + ext, { force: true });
      say(
        'fail',
        `SQLite cannot write into ${dbPath} (${why}), so the checked copy was not written into it; the database is as it was.`,
      );
      if (logError) {
        say(
          'warn',
          `The checked copy was read from the database file without its log (${logError}): what was saved only in the log is not in it.`,
        );
      }
      say(
        'info',
        `The checked copy is ${keepTmp}; the store as found is kept as ${kept}. Once every Claude Code ` +
          'session is closed, put the copy in place with:',
      );
      say('info', `rm -f ${shellWord(wal)} ${shellWord(shm)} && mv ${shellWord(keepTmp)} ${shellWord(real)}`);
      return end('refused', { tables, aside });
    };
    // SQLite cannot open the store as a database at all: neither the lock probe nor the backup can run on it.
    if (/not a database/i.test(logError ?? '')) return leaveForHand(logError);

    const swap = await swapGuard(async () => {
      if (storeState(real) !== seen) return { changed: true };
      const probe = probeExclusive(real);
      if (!probe.acquired) return { probe };
      const source = new Database(tmp, { readonly: true, fileMustExist: true });
      // Held open across the write-back: while it holds the store, no connection's close can
      // checkpoint, so a backup that fails or stops leaves the store as found (frames it wrote
      // and did not commit are past the log's end, which no reader reads).
      let guard;
      try {
        guard = new Database(real, { readonly: true, fileMustExist: true });
        guard.pragma('schema_version');
      } catch (e) {
        guard?.close();
        source.close();
        return { guardError: e };
      }
      try {
        let first = true;
        const done = await source.backup(real, {
          progress: () => {
            // After the first step the backup holds the store's write lock and has copied nothing.
            if (first && storeState(real) !== seen)
              throw Object.assign(new Error('changed'), { changed: true });
            first = false;
            return 1000;
          },
        });
        // A first step that met another writer returns at once, having copied nothing.
        if (!done.totalPages) return { busy: true };
        return { replaced: true };
      } catch (e) {
        return e?.changed ? { changed: true } : { backupError: e };
      } finally {
        source.close();
        guard.close();
      }
    });
    if (swap.changed) return changed();
    if (swap.busy || swap.probe?.busy) {
      say(
        'fail',
        `Another process has ${dbPath} open, so it was not replaced. Nothing was written to the database.`,
      );
      say(
        'info',
        'Close every Claude Code session, this one included, then run repair-db again from a terminal.',
      );
      return end('refused', { tables });
    }
    const failure = swap.probe?.error ?? swap.guardError ?? swap.backupError;
    if (failure) {
      if (failure.code === 'SQLITE_FULL') {
        say(
          'fail',
          `The disk filled up while writing into ${dbPath}; the database is as it was. Free some space and run repair-db again.`,
        );
        return end('refused', { tables });
      }
      if (isDamage(failure)) return leaveForHand(message(failure));
      if (!swap.backupError) return refuseCannotOpen(message(failure));
      say(
        'fail',
        `Could not write into ${dbPath}: ${message(failure)}; the database is as it was. Check the file's and ` +
          "its directory's permissions and free space, then run repair-db again.",
      );
      return end('refused', { tables });
    }
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

    tableLines(built, say);
    let copied = 0;
    for (const a of Object.values(tables)) copied += a.written;
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
    say(
      'ok',
      `The store as found is kept as ${kept} — delete ${asideWal ? 'them' : 'it'} once you no longer need ${asideWal ? 'them' : 'it'}.`,
    );
    const undo = [
      `rm -f ${shellWord(wal)} ${shellWord(shm)}`,
      `cp ${shellWord(aside)} ${shellWord(real)}`,
      ...(asideWal ? [`cp ${shellWord(asideWal)} ${shellWord(wal)}`] : []),
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

/** What each table's account says, as lines: every row the repair may not hold is named here. */
function tableLines(built, say) {
  const { tables, sources, skipped } = built;
  if (sources.log?.error) {
    say(
      'warn',
      `SQLite could not read the database together with its log (${sources.log.error}); the rows were read from the ` +
        'database file alone, as of its last checkpoint: what was saved only in the log is not in the repaired store, ' +
        'and what the log changed or deleted is as it was before.',
    );
  } else if (sources.log?.writableSchema) {
    say(
      'warn',
      'Its schema does not parse; it was read with writable_schema, which skips the definitions it cannot parse.',
    );
  }
  if (sources.log?.masterIncomplete) {
    say(
      'warn',
      'Part of its list of tables could not be read: a table listed only there is not in the repaired store.',
    );
  }
  const viaMain = Object.entries(tables).filter(
    ([t, a]) => t !== 'sqlite_sequence' && a.logUnreadable && !(a.unreadable && a.written === 0),
  );
  if (viaMain.length > 0 && !sources.log?.error) {
    say(
      'warn',
      `SQLite could not read ${viaMain.length === 1 ? 'this table' : 'these tables'} with the log, so the rows are from ` +
        'the database file without it, as of its last checkpoint (what the log saved, changed or deleted there is not in ' +
        `them): ${viaMain.map(([t, a]) => `${t} (${a.written} rows; ${a.logUnreadable})`).join(', ')}.`,
    );
  }
  for (const [t, a] of Object.entries(tables)) {
    if (t === 'sqlite_sequence') {
      if (a.unreadable && a.written === 0) {
        say(
          'warn',
          `sqlite_sequence: could not be read (${a.unreadable}); ids above the highest copied one may be handed out again.`,
        );
      } else if (a.fromMain > 0 && !sources.log?.error) {
        say(
          'warn',
          'sqlite_sequence: read from the database file without its log; each id counter is at least the highest copied id.',
        );
      }
      continue;
    }
    if (a.unreadable && a.written === 0) {
      say('warn', `${t}: could not be read (${a.unreadable}); the repaired store has none of its rows.`);
      continue;
    }
    if (a.fromMain > 0 && !a.logUnreadable && !sources.log?.error) {
      say(
        'warn',
        `${t}: ${a.fromMain} row(s) SQLite could not read with the log were taken from the database file without it, as of ` +
          'its last checkpoint: what the log changed in them is not there, and a row the log deleted may be back.',
      );
    }
    if (a.transplanted) {
      say(
        'warn',
        `${t}: ${a.transplanted} in the database with its log; its rows were read with the definition the database file alone holds.`,
      );
    }
    const damage = a.damaged ?? a.mainDamaged ?? a.gaps[0]?.error ?? null;
    if (damage) {
      say(
        'warn',
        `${t}: some of its pages are damaged (${damage}), so rows on them may be missing, or hold damaged values.`,
      );
    }
    if (a.missing.length > 0) {
      say(
        'warn',
        `${t}: ${a.missing.length} row(s) an index lists could not be read (ids ${listIds(a.missing)}).`,
      );
    }
    if (a.notWrittenCount > 0) {
      say(
        'warn',
        `${t}: ${a.notWrittenCount} row(s) could not be written to the fresh file (${a.firstFailure}): ` +
          `ids ${listIds(
            a.notWritten.map((x) => x.id),
            a.notWrittenCount,
          )}.`,
      );
    }
    if (a.droppedColumns.length > 0) {
      say(
        'warn',
        `${t}: column(s) ${a.droppedColumns.join(', ')} are not in this version's schema; their values are only in the kept file.`,
      );
    }
  }
  for (const { table, why } of skipped) say('warn', `${table}: ${why}.`);
}
