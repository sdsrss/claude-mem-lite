import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';

describe('schema v34 — decay_seen_count denominator column', () => {
  it('adds observations.decay_seen_count as INTEGER NOT NULL DEFAULT 0', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const cols = db
      .prepare('PRAGMA table_info(observations)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('decay_seen_count');

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
    const row = db.prepare('SELECT decay_seen_count FROM observations LIMIT 1').get();
    expect(row.decay_seen_count).toBe(0);
    db.close();
  });

  it('CURRENT_SCHEMA_VERSION is at v34 or newer', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(34);
  });
});
