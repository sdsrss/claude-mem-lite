import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';

// v41 (cross-turn late-citation): observations.last_cited_session_id — the promote
// idempotency key, split out from last_decided_session_id so a citation that lands
// in a LATER turn of the same session can still upgrade a previously-uncited obs.
describe('schema v41 — cross-turn late-citation column', () => {
  it('fresh init adds observations.last_cited_session_id with NULL default', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const cols = db
      .prepare('PRAGMA table_info(observations)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('last_cited_session_id');
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
                VALUES ('s1','s1','p','2026-01-01',1,'active')`,
    ).run();
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
                VALUES ('s1','p','bugfix','t','2026-01-01',1)`,
    ).run();
    expect(
      db.prepare('SELECT last_cited_session_id FROM observations LIMIT 1').get().last_cited_session_id,
    ).toBeNull();
    db.close();
  });

  it('CURRENT_SCHEMA_VERSION is at v41 or newer', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(41);
  });

  it('upgrades a pre-v41 DB missing the column (adds it + re-stamps version)', () => {
    const db = new Database(':memory:');
    initSchema(db); // fresh → current with column
    // Simulate an early-adopter store: drop the column + roll the version back so the
    // fast-path can't short-circuit (version != CURRENT falls through to MIGRATIONS).
    db.exec('ALTER TABLE observations DROP COLUMN last_cited_session_id');
    db.prepare('UPDATE schema_version SET version = 40').run();
    expect(
      db
        .prepare('PRAGMA table_info(observations)')
        .all()
        .map((c) => c.name),
    ).not.toContain('last_cited_session_id');
    initSchema(db); // re-open → migration re-adds
    expect(
      db
        .prepare('PRAGMA table_info(observations)')
        .all()
        .map((c) => c.name),
    ).toContain('last_cited_session_id');
    expect(db.prepare('SELECT version FROM schema_version LIMIT 1').get().version).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    db.close();
  });

  it('re-init is idempotent (column present exactly once, no throw)', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
    const n = db
      .prepare('PRAGMA table_info(observations)')
      .all()
      .filter((c) => c.name === 'last_cited_session_id').length;
    expect(n).toBe(1);
    db.close();
  });
});
