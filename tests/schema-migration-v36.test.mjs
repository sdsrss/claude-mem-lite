import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';

// v36: events_fts_au narrowed from `AFTER UPDATE ON events` (fires on ANY row
// update — importance / accessed_count / citation-decay bumps thrashed the FTS
// index and reintroduced the v27-fixed SQLITE_CORRUPT_VTAB blast radius) to the
// scoped `AFTER UPDATE OF title, body` form used by every other FTS table.
describe('schema v36 — events_fts_au scoped to title, body', () => {
  const SCOPED = /AFTER\s+UPDATE\s+OF\s+title\s*,\s*body/i;

  it('fresh DB creates events_fts_au scoped to title, body', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='events_fts_au'`)
      .get();
    expect(row).toBeTruthy();
    expect(SCOPED.test(row.sql)).toBe(true);
    db.close();
  });

  it('replaces a legacy broad events_fts_au with the scoped form on re-init', () => {
    const db = new Database(':memory:');
    initSchema(db);
    // Simulate a pre-v36 DB: swap in the legacy broad trigger and roll the
    // version back so initSchema re-runs the migration pass.
    db.exec(`DROP TRIGGER IF EXISTS events_fts_au`);
    db.exec(`
      CREATE TRIGGER events_fts_au AFTER UPDATE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, title, body, event_type, project)
        VALUES ('delete', old.id, COALESCE(old.title,''), COALESCE(old.body,''), old.event_type, old.project);
        INSERT INTO events_fts(rowid, title, body, event_type, project)
        VALUES (new.id, COALESCE(new.title,''), COALESCE(new.body,''), new.event_type, new.project);
      END;
    `);
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION - 1);

    initSchema(db);

    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='events_fts_au'`)
      .get();
    expect(SCOPED.test(row.sql)).toBe(true);
    db.close();
  });

  it('title/body updates still resync events_fts (scoped trigger fires on indexed columns)', () => {
    const db = new Database(':memory:');
    initSchema(db);
    db.prepare(
      `INSERT INTO events (project, event_type, title, body, created_at_epoch)
       VALUES ('p', 'bugfix', 'alpha term', 'gamma body', 1)`,
    ).run();

    expect(db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH 'alpha'`).all().length).toBe(1);

    db.prepare(`UPDATE events SET title = 'beta term' WHERE project = 'p'`).run();
    expect(db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH 'alpha'`).all().length).toBe(0);
    expect(db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH 'beta'`).all().length).toBe(1);

    db.prepare(`UPDATE events SET body = 'delta body' WHERE project = 'p'`).run();
    expect(db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH 'gamma'`).all().length).toBe(0);
    expect(db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH 'delta'`).all().length).toBe(1);
    db.close();
  });

  it('non-indexed updates leave events_fts integrity intact', () => {
    const db = new Database(':memory:');
    initSchema(db);
    db.prepare(
      `INSERT INTO events (project, event_type, title, body, importance, created_at_epoch)
       VALUES ('p', 'bugfix', 'hello world', 'some body', 1, 1)`,
    ).run();

    // Citation-decay / access-count style bumps on non-FTS columns.
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `UPDATE events SET importance = importance + 1, accessed_count = accessed_count + 1 WHERE project = 'p'`,
      ).run();
    }

    // External-content FTS5 integrity check must pass and the row still matches once.
    expect(() => db.exec(`INSERT INTO events_fts(events_fts) VALUES('integrity-check')`)).not.toThrow();
    expect(db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH 'hello'`).all().length).toBe(1);
    db.close();
  });

  it('CURRENT_SCHEMA_VERSION is at v36 or newer', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(36);
  });
});
