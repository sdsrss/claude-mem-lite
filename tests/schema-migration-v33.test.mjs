import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';

describe('schema v33 — demoted_at telemetry column', () => {
  it('adds observations.demoted_at as nullable INTEGER (default NULL)', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const cols = db
      .prepare('PRAGMA table_info(observations)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('demoted_at');

    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('s1', 's1', 'p', '2026-01-01', 1, 'active')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
      VALUES ('s1', 'p', 'bugfix', 't', '2026-01-01', 1)
    `,
    ).run();
    const row = db.prepare('SELECT demoted_at FROM observations LIMIT 1').get();
    expect(row.demoted_at).toBeNull();
    db.close();
  });

  it('CURRENT_SCHEMA_VERSION is at v33 or newer', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(33);
  });
  // Note: kept "at v33 or newer" semantics — v34 added decay_seen_count without
  // touching demoted_at. Each migration test guards its own column existence.
});
