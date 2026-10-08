// A read-only mount (EROFS) over one directory, simulated where it differs from a directory the
// user cannot write (EACCES) for a closed WAL store (D#295). Measured 2026-10-08 on a kernel
// read-only mount (an unprivileged FUSE mount -o ro) and with an LD_PRELOAD shim over SQLite's own
// open64/access calls: with every other rule equal, the errno alone decides SQLite's answer. EACCES
// gives SQLITE_READONLY_DIRECTORY "attempt to write a readonly database"; EROFS gives SQLITE_CANTOPEN
// "unable to open database file" (SQLite retries the -wal read-only and finds none).
//
// The test makes the directory unwritable for real, so every write fails, and loads this through
// NODE_OPTIONS into every node process, which then reports what the kernel would on a read-only
// mount:
//   - accessSync on a path under the dir throws EROFS where it threw EACCES;
//   - a SqliteError SQLITE_READONLY_DIRECTORY on a database under the dir becomes SQLITE_CANTOPEN.
// CML_EROFS_SIM_DIR names the dir; CML_EROFS_SIM_REQUIRE_FROM a package.json to load better-sqlite3 by.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import { resolve, sep } from 'node:path';

const DIR = process.env.CML_EROFS_SIM_DIR;
if (DIR) {
  const root = resolve(DIR);
  const under = (p) => {
    const r = resolve(String(p));
    return r === root || r.startsWith(root + sep);
  };

  const realAccessSync = fs.accessSync;
  fs.accessSync = function accessSync(p, mode) {
    try {
      return realAccessSync.call(this, p, mode);
    } catch (e) {
      if (e?.code !== 'EACCES' || !under(p)) throw e;
      throw Object.assign(new Error(`EROFS: read-only file system, access '${p}'`), {
        code: 'EROFS',
        errno: -30,
        syscall: 'access',
        path: String(p),
      });
    }
  };
  syncBuiltinESMExports();

  const Database = createRequire(process.env.CML_EROFS_SIM_REQUIRE_FROM)('better-sqlite3');
  const swap = (db, e) =>
    e?.code === 'SQLITE_READONLY_DIRECTORY' && db && under(db.name)
      ? new Database.SqliteError('unable to open database file', 'SQLITE_CANTOPEN')
      : e;
  const wrap = (proto, name, dbOf) => {
    const orig = proto[name];
    proto[name] = function (...args) {
      try {
        return orig.apply(this, args);
      } catch (e) {
        throw swap(dbOf(this), e);
      }
    };
  };
  let statementWrapped = false;
  for (const name of ['exec', 'pragma']) wrap(Database.prototype, name, (db) => db);
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (...args) {
    let stmt;
    try {
      stmt = prepare.apply(this, args);
    } catch (e) {
      throw swap(this, e);
    }
    if (!statementWrapped) {
      statementWrapped = true;
      const proto = Object.getPrototypeOf(stmt);
      for (const name of ['get', 'all', 'run', 'iterate']) wrap(proto, name, (s) => s.database);
    }
    return stmt;
  };
}
