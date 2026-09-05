// Smoke tests: verify core DB operations work end-to-end
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

describe('smoke tests', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'smoke-sess', memoryId: 'smoke-sess' });
  });
  afterEach(() => {
    db.close();
  });

  it('DB initialization creates all tables', () => {
    const tables = db
      .prepare(
        `
      SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
    `,
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain('sdk_sessions');
    expect(tables).toContain('observations');
    expect(tables).toContain('session_summaries');
    expect(tables).toContain('user_prompts');
    expect(tables).toContain('observations_fts');
    expect(tables).toContain('session_summaries_fts');
    expect(tables).toContain('user_prompts_fts');
  });

  it('saves and reads back an observation', () => {
    const now = Date.now();
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, '', '', '[]', '[]', 1, ?, ?)
    `,
    ).run(
      'smoke-sess',
      'test',
      'body text',
      'discovery',
      'Smoke Title',
      'narrative text',
      new Date(now).toISOString(),
      now,
    );

    const obs = db.prepare("SELECT * FROM observations WHERE title = 'Smoke Title'").get();
    expect(obs).toBeDefined();
    expect(obs.text).toBe('body text');
    expect(obs.type).toBe('discovery');
    expect(obs.project).toBe('test');
  });

  it('FTS search finds saved observation', () => {
    insertObs(db, {
      sessionId: 'smoke-sess',
      title: 'unique smoke findable term',
      text: 'unique smoke findable term',
    });

    const rows = db
      .prepare(
        `
      SELECT o.id, o.title FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH '"smoke"'
    `,
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].title).toContain('smoke');
  });

  it('deleted observation is not found by FTS', () => {
    insertObs(db, { sessionId: 'smoke-sess', title: 'deletable smoke entry', text: 'deletable smoke entry' });
    const id = db.prepare("SELECT id FROM observations WHERE title = 'deletable smoke entry'").get().id;

    db.prepare('DELETE FROM observations WHERE id = ?').run(id);

    const rows = db
      .prepare(
        `
      SELECT rowid FROM observations_fts WHERE observations_fts MATCH '"deletable"'
    `,
      )
      .all();
    expect(rows.length).toBe(0);
  });

  it('mem_get by ID returns correct observation', () => {
    insertObs(db, { sessionId: 'smoke-sess', title: 'getbyid test obs' });
    const id = db.prepare("SELECT id FROM observations WHERE title = 'getbyid test obs'").get().id;

    const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    expect(obs).toBeDefined();
    expect(obs.title).toBe('getbyid test obs');
  });
});
