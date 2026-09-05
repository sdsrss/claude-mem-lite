// Tests for observation_files junction table normalization
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs, fileEdgeMatchOnly } from './test-helpers.mjs';
import { saveObservation } from '../hook-llm.mjs';

// ─── Schema ─────────────────────────────────────────────────────────────────

describe('observation_files table schema', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('observation_files table exists after initSchema', () => {
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='observation_files'")
      .get();
    expect(table).toBeDefined();
  });

  it('observation_files has index on filename', () => {
    const idx = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_obsfiles_filename'")
      .get();
    expect(idx).toBeDefined();
  });

  it('observation_files enforces UNIQUE(obs_id, filename)', () => {
    insertSession(db, { id: 'sess-1' });
    // Insert with no files so insertObs doesn't auto-populate observation_files
    insertObs(db, { title: 'test', filesModified: '[]' });
    const obsId = db.prepare('SELECT id FROM observations LIMIT 1').get().id;

    db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(obsId, 'a.js');
    // Second insert with same pair should fail
    expect(() => {
      db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(obsId, 'a.js');
    }).toThrow();
  });

  it('CASCADE deletes observation_files when observation is deleted', () => {
    insertSession(db, { id: 'sess-1' });
    // insertObs auto-populates observation_files
    insertObs(db, { title: 'cascade test', filesModified: '["x.js"]' });
    const obsId = db.prepare('SELECT id FROM observations LIMIT 1').get().id;

    expect(db.prepare('SELECT COUNT(*) as c FROM observation_files').get().c).toBe(1);

    db.prepare('DELETE FROM observations WHERE id = ?').run(obsId);
    expect(db.prepare('SELECT COUNT(*) as c FROM observation_files').get().c).toBe(0);
  });
});

// ─── Data Migration ─────────────────────────────────────────────────────────

describe('observation_files data migration', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('insertObs populates observation_files from filesModified JSON', () => {
    insertSession(db, { id: 'sess-1' });
    insertObs(db, { title: 'obs with files', filesModified: '["src/a.js","src/b.js"]' });
    insertObs(db, { title: 'obs no files', filesModified: '[]' });
    insertObs(db, { title: 'obs single file', filesModified: '["c.js"]' });

    const rows = db.prepare('SELECT * FROM observation_files ORDER BY obs_id, filename').all();
    expect(rows.length).toBe(3); // a.js, b.js, c.js
    expect(rows.map((r) => r.filename)).toEqual(expect.arrayContaining(['src/a.js', 'src/b.js', 'c.js']));
  });
});

// ─── saveObservation writes to observation_files ────────────────────────────

describe('saveObservation populates observation_files', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'test-sess' });
  });
  afterEach(() => {
    db.close();
  });

  it('inserts file rows when saving an observation with files', () => {
    const obs = {
      type: 'change',
      title: 'edit two files',
      files: ['src/foo.js', 'src/bar.js'],
      filesRead: [],
      importance: 2,
    };
    const id = saveObservation(obs, 'test', 'test-sess', db);
    expect(id).not.toBeNull();

    const fileRows = db
      .prepare('SELECT filename FROM observation_files WHERE obs_id = ? ORDER BY filename')
      .all(id);
    expect(fileRows.map((r) => r.filename)).toEqual(['src/bar.js', 'src/foo.js']);
  });

  it('handles empty files array without error', () => {
    const obs = {
      type: 'discovery',
      title: 'no files observation',
      files: [],
      filesRead: [],
      importance: 1,
    };
    const id = saveObservation(obs, 'test', 'test-sess', db);
    expect(id).not.toBeNull();

    const fileRows = db.prepare('SELECT COUNT(*) as c FROM observation_files WHERE obs_id = ?').get(id);
    expect(fileRows.c).toBe(0);
  });
});

// ─── the shipped file-edge MATCH clause uses the observation_files JOIN ─────
// Scope note (D#163): these cases cover the match arm only. The rest of the
// PreToolUse injection query lives in tests/pre-tool-recall.test.mjs.

describe('shipped file-edge match clause uses observation_files', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => {
    db.close();
  });

  it('finds observation by exact filename match via observation_files', () => {
    // insertObs auto-populates observation_files
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix race in hook.mjs',
      importance: 2,
      filesModified: '["hook.mjs"]',
      epochOffset: -5 * 86400000,
    });

    const results = fileEdgeMatchOnly(db, 'hook.mjs', 'test');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toMatch(/hook\.mjs/);
  });

  it('finds observation by basename LIKE match via observation_files', () => {
    // insertObs auto-populates observation_files
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix in src/deep/file.mjs',
      importance: 2,
      filesModified: '["src/deep/file.mjs"]',
      epochOffset: -5 * 86400000,
    });

    // Search by just the basename path
    const results = fileEdgeMatchOnly(db, '/some/other/path/file.mjs', 'test');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
