// Tests for lib/db-backup.mjs — pre-maintenance VACUUM INTO snapshots (audit MED-2).
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
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

  it('returns null (does not throw) when the target dir is gone', () => {
    const { db, d } = fileDb();
    rmSync(d, { recursive: true, force: true }); // dir vanishes under the DB
    dirs.splice(0); // already removed
    expect(() => snapshotDb(db)).not.toThrow();
    expect(snapshotDb(db)).toBeNull();
    db.close();
  });
});
