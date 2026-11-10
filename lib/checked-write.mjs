// A write to the store that commits only when the store's structure reads sound inside the very
// transaction that made it (D#593, third attempt).
//
// Why: an index rebuild (FTS5 'rebuild' / 'optimize', REINDEX) frees and allocates pages. On a store
// whose freelist lists a page a table still uses, the new index is handed that page and overwrites
// its rows (D#591: 300 rows -> 287 intact; D#595: one optimize, 12 of 300). A check BEFORE the write
// cannot be trusted to see that freelist: SQLite 3.53.4's integrity check skips the freelist whenever
// a virtual table sorts first, as on every VACUUMed or restored store (lesson #1051), and reading the
// freelist from the files ourselves in a process that holds a connection drops that process's POSIX
// locks on close (attempt 2's P0). After the write the reused page sits in two trees, and
// PRAGMA quick_check run in the same transaction reports it, VACUUMed or not, before anything is
// committed. ROLLBACK then discards every page the write touched.
//
// Leaf module: no imports, so the opener's recovery path can use it without a load graph.

// A failure the environment caused (another writer, a full or failing disk, memory, permissions)
// says nothing about the store: 'unchecked'. Any other failure of these fixed statements on tables
// that exist (CORRUPT, NOTADB, an FTS5 config it cannot read, a UNIQUE index its table violates) is
// the store's own: 'damaged'. No code at all (not an SQLite error) is not evidence of damage.
const ENV_CODE_RE = /^SQLITE_(BUSY|LOCKED|FULL|IOERR|NOMEM|CANTOPEN|READONLY|INTERRUPT|PERM)/;
const classify = (code) => (typeof code !== 'string' || ENV_CODE_RE.test(code) ? 'unchecked' : 'damaged');

/**
 * Runs `steps` in one IMMEDIATE transaction and commits only when every step ran and PRAGMA
 * quick_check, in that transaction, reads 'ok'. Stops at the first step that throws (an error that
 * makes SQLite roll the transaction back, such as SQLITE_IOERR or SQLITE_FULL, throws from that
 * step), and at a step after which the transaction is gone without a throw, so that no later
 * statement commits on its own, unchecked.
 *
 * `check`: 'ok' (checked and committed); 'damaged' (the check reported damage, or a step or the check
 * failed for a reason of the store's own; nothing committed); 'unchecked' (the write could not be made
 * or checked for a reason outside the store: busy, a full or failing disk, memory, already in a
 * transaction, the transaction gone, the COMMIT failing; nothing committed).
 *
 * @param {import('better-sqlite3').Database} db read-write handle, not inside a transaction
 * @param {{name: string, sql: string}[]} steps
 * @returns {{committed: boolean, check: 'ok'|'damaged'|'unchecked', done: string[], lines: string[], failedStep: string|null, error: string|null, code: string|null}}
 */
export function checkedWrite(db, steps) {
  const refused = (fields) => ({
    committed: false,
    check: 'unchecked',
    done: [],
    lines: [],
    failedStep: null,
    error: null,
    code: null,
    ...fields,
  });
  // Inside a transaction already, BEGIN throws ("cannot start a transaction within a transaction").
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (e) {
    return refused({ error: e.message, code: e.code ?? null });
  }
  const done = [];
  try {
    for (const step of steps) {
      try {
        db.exec(step.sql);
      } catch (e) {
        const code = e.code ?? null;
        return refused({
          check: classify(code),
          failedStep: step.name,
          error: e.message,
          code,
        });
      }
      if (!db.inTransaction) {
        return refused({ failedStep: step.name, error: 'the transaction ended inside this step' });
      }
      done.push(step.name);
    }
    let lines;
    try {
      lines = db.pragma('quick_check(10)').map((r) => r.quick_check);
    } catch (e) {
      const code = e.code ?? null;
      return refused({
        check: classify(code),
        lines: [e.message],
        error: e.message,
        code,
      });
    }
    if (!(lines.length === 1 && lines[0] === 'ok')) return refused({ check: 'damaged', lines });
    try {
      db.exec('COMMIT');
    } catch (e) {
      return refused({ error: e.message, code: e.code ?? null });
    }
    return { committed: true, check: 'ok', done, lines: [], failedStep: null, error: null, code: null };
  } finally {
    if (db.inTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the connection is closing or the transaction already ended */
      }
    }
  }
}

/**
 * Opens a read-only connection to `path` and reads through it, so a read-write handle closed while it
 * is open is not the store's last connection and does not checkpoint the log into the main file
 * (with damage only in a log frame, that checkpoint writes it over the intact main-file page). Close
 * it after the read-write handle. Best-effort: null when the store cannot be opened read-only or
 * the read through it fails.
 * @param {typeof import('better-sqlite3')} Database the better-sqlite3 constructor (this module imports nothing)
 * @param {string} path
 * @returns {import('better-sqlite3').Database|null}
 */
export function holdOpen(Database, path) {
  let db = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return db;
  } catch {
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
    return null;
  }
}
