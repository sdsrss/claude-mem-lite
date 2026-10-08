// lib/wal-open-blocked.mjs — a closed WAL store in a data dir this user cannot write (D#287, D#296).
//
// The store is WAL (schema.mjs), and even a read-only open has to create the -wal and -shm files
// beside the DB. In a directory SQLite cannot write, a store that was closed cleanly (so those
// files are gone) cannot be opened in place, and SQLite answers "attempt to write a readonly
// database", a message it uses for other faults too. doctor, status and every command that opens
// the DB through mem-cli say instead what is wrong and how to fix it, keyed on SQLite's code and the
// directory's own access error, never on the message.
//
// A leaf (node:fs and cli-path.mjs): mem-cli opens the DB on every command and must not load
// install.mjs to word one error.
import { accessSync, lstatSync, constants as fsConstants } from 'node:fs';
import { shellWord } from '../cli-path.mjs';

export const WAL_BLOCKED_WHY =
  'SQLite cannot open a WAL database without creating its -wal/-shm files beside it';

/**
 * The access error code for `dir` under `mode` (read, write and search by default), or null when
 * it is usable or absent.
 */
export function dirAccessError(dir, mode = fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK) {
  try {
    accessSync(dir, mode);
    return null;
  } catch (e) {
    return e.code === 'ENOENT' ? null : e.code || 'EACCES';
  }
}

/**
 * Whether an open of `dbPath` that failed with SQLite error `code` is that store, given its dir's
 * access error. A dir the user cannot write (EACCES) gives SQLITE_READONLY_DIRECTORY. A read-only
 * mount (EROFS) gives SQLITE_CANTOPEN "unable to open database file" instead: SQLite cannot create
 * the -wal, retries it read-only and finds none (D#295, measured on a kernel read-only mount).
 * CANTOPEN has other causes, so it counts only on a read-only mount with no -wal beside the DB.
 */
export function walOpenBlocked(code, dirDenied, dbPath) {
  if (!dirDenied) return false;
  if (code === 'SQLITE_READONLY_DIRECTORY') return true;
  return (
    code === 'SQLITE_CANTOPEN' && dirDenied === 'EROFS' && Boolean(dbPath) && !pathPresent(`${dbPath}-wal`)
  );
}

function pathPresent(p) {
  try {
    lstatSync(p);
    return true;
  } catch (e) {
    return e.code !== 'ENOENT';
  }
}

/**
 * The fix for a data dir this user cannot use, chosen by its access error. EROFS is the file
 * system, not the mode bits: accessSync(W_OK) on a read-only mount fails with it, and chmod cannot
 * help there (D#287).
 */
export const dataDirRemedy = (code, dir) =>
  code === 'EROFS'
    ? `the file system holding ${shellWord(dir)} is mounted read-only — remount it read-write`
    : `chmod u+rwx ${shellWord(dir)} (or chown it back to your user if a sudo run created it)`;
