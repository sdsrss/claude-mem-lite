import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';

describe('schema v32 — citation-decay columns', () => {
  it('adds uncited_streak / cited_count / last_decided_session_id with safe defaults', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const cols = db
      .prepare('PRAGMA table_info(observations)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('uncited_streak');
    expect(cols).toContain('cited_count');
    expect(cols).toContain('last_decided_session_id');
    // Sanity: defaults are 0/0/NULL
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
    const row = db
      .prepare('SELECT uncited_streak, cited_count, last_decided_session_id FROM observations LIMIT 1')
      .get();
    expect(row.uncited_streak).toBe(0);
    expect(row.cited_count).toBe(0);
    expect(row.last_decided_session_id).toBeNull();
    db.close();
  });

  it('CURRENT_SCHEMA_VERSION is at v32 or newer', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(32);
  });
});
