// lib/wal-open-blocked.mjs: which SQLite open failures are a closed WAL store in a data dir this
// user cannot write (D#287, D#296), and on a read-only mount (D#295). Measured on a kernel
// read-only mount: with every other rule equal, EACCES gives SQLITE_READONLY_DIRECTORY and EROFS
// gives SQLITE_CANTOPEN. CANTOPEN has other causes, so it counts only with EROFS, the database
// there, and no -shm file.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walOpenBlocked } from '../lib/wal-open-blocked.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function store({ db: withDb = true, wal = false, shm = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'wal-blocked-'));
  dirs.push(d);
  const db = join(d, 'claude-mem-lite.db');
  if (withDb) writeFileSync(db, '');
  if (wal) writeFileSync(`${db}-wal`, '');
  if (shm) writeFileSync(`${db}-shm`, '');
  return db;
}

describe('walOpenBlocked', () => {
  it('an unwritable dir (EACCES) answers SQLITE_READONLY_DIRECTORY', () => {
    expect(walOpenBlocked('SQLITE_READONLY_DIRECTORY', 'EACCES', store())).toBe(true);
    expect(walOpenBlocked('SQLITE_READONLY_DIRECTORY', 'EROFS', store())).toBe(true);
  });

  // Both measured on a kernel read-only mount, with the same answer and the same cause.
  it('a read-only mount (EROFS) answers SQLITE_CANTOPEN when the -shm is missing (D#295)', () => {
    expect(walOpenBlocked('SQLITE_CANTOPEN', 'EROFS', store())).toBe(true);
    expect(walOpenBlocked('SQLITE_CANTOPEN', 'EROFS', store({ wal: true }))).toBe(true);
  });

  // With -wal and -shm both there the store opens on a read-only mount (measured), and a missing
  // database is a different fault with the same code (pre-ship delta review F5).
  it('CANTOPEN is that store only on a read-only mount, with the DB there and no -shm', () => {
    expect(walOpenBlocked('SQLITE_CANTOPEN', 'EACCES', store())).toBe(false);
    expect(walOpenBlocked('SQLITE_CANTOPEN', 'EROFS', store({ wal: true, shm: true }))).toBe(false);
    expect(walOpenBlocked('SQLITE_CANTOPEN', 'EROFS', store({ db: false }))).toBe(false);
    expect(walOpenBlocked('SQLITE_CANTOPEN', 'EROFS')).toBe(false);
  });

  it('nothing is that store while the dir can be written', () => {
    expect(walOpenBlocked('SQLITE_READONLY_DIRECTORY', null, store())).toBe(false);
    expect(walOpenBlocked('SQLITE_CANTOPEN', null, store())).toBe(false);
  });
});
