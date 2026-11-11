// Tests for lib/db-backup.mjs — pre-maintenance VACUUM INTO snapshots (audit MED-2).
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  openSync,
  writeSync,
  writeFileSync,
  closeSync,
  chmodSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initSchema } from '../schema.mjs';
import { snapshotDb } from '../lib/db-backup.mjs';

describe('snapshotDb', () => {
  const dirs = [];
  function fileDb() {
    const d = mkdtempSync(join(tmpdir(), 'dbbak-'));
    dirs.push(d);
    const p = join(d, 'mem.db');
    const db = new Database(p);
    db.pragma('journal_mode = WAL'); // mirror production — VACUUM INTO must work in WAL
    initSchema(db);
    return { db, p, d };
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('writes a VACUUM INTO snapshot next to the DB and it is a valid copy', () => {
    const { db, d } = fileDb();
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES ('s','s','p','now',0,'active')`,
    ).run();
    const out = snapshotDb(db, { tag: 'pre-maintain' });
    expect(out).toBeTruthy();
    expect(existsSync(out)).toBe(true);
    expect(readdirSync(d).filter((n) => n.includes('.pre-maintain-')).length).toBe(1);
    // The snapshot is a real, openable DB carrying the schema + the row.
    const snap = new Database(out, { readonly: true });
    expect(
      snap.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='observations'`).get(),
    ).toBeTruthy();
    expect(snap.prepare(`SELECT COUNT(*) c FROM sdk_sessions`).get().c).toBe(1);
    snap.close();
    db.close();
  });

  // converge R28 (E2E 2026-11-10): the store is chmod 0600 but VACUUM INTO created its copy with
  // the process umask (0644 here), so under a CLAUDE_MEM_DIR that already existed as 0755 every
  // other local user could read the pre-delete snapshot of a memory the user had just deleted.
  it.skipIf(process.platform === 'win32')('writes the snapshot owner-only, whatever the umask', () => {
    const { db, d } = fileDb();
    chmodSync(d, 0o755);
    const prev = process.umask(0o022);
    let out;
    try {
      out = snapshotDb(db, { tag: 'pre-delete' });
    } finally {
      process.umask(prev);
    }
    expect(out).toBeTruthy();
    expect(statSync(out).mode & 0o777).toBe(0o600);
    db.close();
  });

  it('prunes to the newest `retain` snapshots', () => {
    const { db, d } = fileDb();
    for (let i = 0; i < 5; i++) snapshotDb(db, { tag: 't', retain: 3 });
    expect(readdirSync(d).filter((n) => n.includes('.t-') && n.endsWith('.bak')).length).toBe(3);
    db.close();
  });

  it('returns null for an in-memory DB (no-op in tests)', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(snapshotDb(db)).toBeNull();
    db.close();
  });

  // D#551: on a damaged store VACUUM INTO creates its target and then fails, and a 0-byte
  // `.bak` was left as the newest "snapshot" for a restore command to name.
  it('leaves no file behind when VACUUM INTO fails on a damaged store', () => {
    const { db, p, d } = fileDb();
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES ('s','s','p','now',0,'active')`,
    ).run();
    const ins = db.prepare(
      `INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch) VALUES ('s','p','','discovery',?,'now',?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) ins.run(`row ${i} ${'x'.repeat(80)}`, i);
    })();
    db.close();
    const size = statSync(p).size;
    const fd = openSync(p, 'r+');
    for (const at of [0.3, 0.5, 0.7]) writeSync(fd, Buffer.alloc(64, 0x41), 0, 64, Math.floor(size * at));
    closeSync(fd);
    const damaged = new Database(p);
    try {
      expect(snapshotDb(damaged, { tag: 'pre-delete' }), 'premise: the snapshot fails').toBeNull();
      expect(readdirSync(d).filter((n) => n.endsWith('.bak'))).toEqual([]);
    } finally {
      damaged.close();
    }
  });

  it('keeps a file that was already at the target name when VACUUM INTO refuses it', () => {
    const { db, p } = fileDb();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const at = new Date('2026-01-02T03:04:05.678Z');
      vi.setSystemTime(at);
      const stamp = at.toISOString().replace(/[:.]/g, '-');
      // The per-process sequence number is not exported, so every value it can have here is taken.
      const taken = Array.from({ length: 50 }, (_, i) => `${p}.pre-delete-${stamp}-${process.pid}-${i}.bak`);
      for (const f of taken) writeFileSync(f, 'not ours');
      expect(
        snapshotDb(db, { tag: 'pre-delete' }),
        'premise: VACUUM INTO refuses a non-empty target',
      ).toBeNull();
      for (const f of taken) expect(readFileSync(f, 'utf8')).toBe('not ours');
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });

  it('returns null (does not throw) when the target dir is gone', () => {
    const { db, d } = fileDb();
    rmSync(d, { recursive: true, force: true }); // dir vanishes under the DB
    dirs.splice(0); // already removed
    expect(() => snapshotDb(db)).not.toThrow();
    expect(snapshotDb(db)).toBeNull();
    db.close();
  });
});
