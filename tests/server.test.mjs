import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { sanitizeFtsQuery, jaccardSimilarity, isoWeekKey } from '../utils.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { initSchema } from '../schema.mjs';
import { autoBoostIfNeeded, runIdleCleanup } from '../server-internals.mjs';

// ─── Dedup Migration ────────────────────────────────────────────────────────

describe('dedup migration', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('creates unique index when no duplicates exist', () => {
    // initSchema (called by createTestDb) already applies the dedup migration
    const hasIdx = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_sess_memory_sid'").get();
    expect(hasIdx).toBeDefined();

    // FK should be enabled after migration
    const fk = db.pragma('foreign_keys')[0];
    expect(fk.foreign_keys).toBe(1);

    // Can insert sessions with unique memory_session_ids
    insertSession(db, { id: 'a', memoryId: 'mem-a' });
    insertSession(db, { id: 'b', memoryId: 'mem-b' });
    const count = db.prepare("SELECT COUNT(*) as cnt FROM sdk_sessions").get();
    expect(count.cnt).toBe(2);
  });

  it('deduplicates sessions keeping oldest row', () => {
    // Create a pre-migration DB to test the dedup path
    const rawDb = new Database(':memory:');
    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('foreign_keys = OFF');

    // Create only sdk_sessions without unique index (simulating legacy DB)
    rawDb.exec(`CREATE TABLE IF NOT EXISTS sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL UNIQUE,
      memory_session_id TEXT,
      project TEXT NOT NULL,
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      worker_port INTEGER,
      prompt_counter INTEGER DEFAULT 0
    )`);

    // Insert duplicate memory_session_ids (allowed without unique index)
    insertSession(rawDb, { id: 'a', memoryId: 'dup-mem' });
    insertSession(rawDb, { id: 'b', memoryId: 'dup-mem' });
    insertSession(rawDb, { id: 'c', memoryId: 'dup-mem' });
    insertSession(rawDb, { id: 'unique', memoryId: 'unique-mem' });

    // Verify duplicates exist
    const dupes = rawDb.prepare(`
      SELECT memory_session_id, COUNT(*) as cnt FROM sdk_sessions
      WHERE memory_session_id IS NOT NULL GROUP BY memory_session_id HAVING cnt > 1
    `).all();
    expect(dupes.length).toBe(1);
    expect(dupes[0].cnt).toBe(3);

    // Run initSchema — should detect dupes, dedup, then create unique index
    initSchema(rawDb);

    // Verify: only 1 row per memory_session_id
    const remaining = rawDb.prepare("SELECT id, memory_session_id FROM sdk_sessions ORDER BY id").all();
    expect(remaining.length).toBe(2);
    expect(remaining[0].memory_session_id).toBe('dup-mem');
    expect(remaining[1].memory_session_id).toBe('unique-mem');

    // Unique index should now exist
    const hasIdx = rawDb.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_sess_memory_sid'").get();
    expect(hasIdx).toBeDefined();

    rawDb.close();
  });
});

// ─── FK enforcement ─────────────────────────────────────────────────────────

describe('FK enforcement after migration', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sess_memory_sid ON sdk_sessions(memory_session_id)");
    db.pragma('foreign_keys = ON');
  });
  afterEach(() => { db.close(); });

  it('allows inserting observation with valid session', () => {
    expect(() => insertObs(db, { sessionId: 'sess-1', title: 'valid' })).not.toThrow();
  });

  it('rejects observation with invalid session', () => {
    expect(() => insertObs(db, { sessionId: 'nonexistent', title: 'invalid' })).toThrow(/FOREIGN KEY/);
  });
});

// ─── mem_delete related_ids cleanup ─────────────────────────────────────────

describe('mem_delete related_ids cleanup', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('removes deleted IDs from other observations related_ids', () => {
    // Insert 3 observations with cross-references
    insertObs(db, { title: 'obs A', relatedIds: '[2, 3]' });       // id=1
    insertObs(db, { title: 'obs B', relatedIds: '[1, 3]' });       // id=2
    insertObs(db, { title: 'obs C', relatedIds: '[1, 2]' });       // id=3

    // Delete obs #2 — simulate mem_delete cleanup logic
    const deletedIds = new Set([2]);
    const referencing = db.prepare("SELECT id, related_ids FROM observations WHERE related_ids IS NOT NULL AND related_ids != '[]'").all();
    for (const r of referencing) {
      let ids;
      try { ids = JSON.parse(r.related_ids); } catch { continue; }
      if (!Array.isArray(ids)) continue;
      const filtered = ids.filter(id => !deletedIds.has(id));
      if (filtered.length !== ids.length) {
        db.prepare('UPDATE observations SET related_ids = ? WHERE id = ?').run(JSON.stringify(filtered), r.id);
      }
    }
    db.prepare('DELETE FROM observations WHERE id = 2').run();

    // Verify cleanup
    const obs1 = db.prepare('SELECT related_ids FROM observations WHERE id = 1').get();
    const obs3 = db.prepare('SELECT related_ids FROM observations WHERE id = 3').get();
    expect(JSON.parse(obs1.related_ids)).toEqual([3]);
    expect(JSON.parse(obs3.related_ids)).toEqual([1]);

    // Verify obs 2 is gone
    expect(db.prepare('SELECT 1 FROM observations WHERE id = 2').get()).toBeUndefined();
  });

  it('FTS5 trigger cleans up on delete', () => {
    insertObs(db, { title: 'unique searchable term', text: 'unique searchable term' });
    const id = db.prepare("SELECT id FROM observations WHERE title = 'unique searchable term'").get().id;

    // Verify FTS finds it
    const before = db.prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH '\"unique\"'").all();
    expect(before.length).toBe(1);

    // Delete
    db.prepare('DELETE FROM observations WHERE id = ?').run(id);

    // FTS should no longer find it
    const after = db.prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH '\"unique\"'").all();
    expect(after.length).toBe(0);
  });
});

// ─── mem_save dedup logic ───────────────────────────────────────────────────

describe('mem_save dedup via jaccardSimilarity', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('allows saving non-duplicate titles', () => {
    insertObs(db, { title: 'Fix authentication bug in login flow' });

    const recent = db.prepare("SELECT title FROM observations WHERE project = 'test' ORDER BY created_at_epoch DESC LIMIT 10").all();
    const newTitle = 'Add dark mode toggle to settings';
    const isDuplicate = recent.some(r => jaccardSimilarity(r.title, newTitle) > 0.7);
    expect(isDuplicate).toBe(false);
  });

  it('detects near-duplicate titles', () => {
    insertObs(db, { title: 'Fix authentication bug in login flow' });

    const recent = db.prepare("SELECT title FROM observations WHERE project = 'test' ORDER BY created_at_epoch DESC LIMIT 10").all();
    const newTitle = 'Fix authentication bug in the login flow';
    const isDuplicate = recent.some(r => jaccardSimilarity(r.title, newTitle) > 0.7);
    expect(isDuplicate).toBe(true);
  });
});

// ─── mem_save importance parameter ──────────────────────────────────────────

describe('mem_save importance', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-test', memoryId: 'manual-test' });
  });
  afterEach(() => { db.close(); });

  it('stores explicit importance value', () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, '', '', '[]', '[]', ?, ?, ?)
    `).run('manual-test', 'test', 'critical fix', 'bugfix', 'Critical security patch', 'critical fix', 3, new Date(now).toISOString(), now);

    const obs = db.prepare("SELECT importance FROM observations WHERE title = 'Critical security patch'").get();
    expect(obs.importance).toBe(3);
  });

  it('defaults importance to 1', () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, '', '', '[]', '[]', ?, ?, ?)
    `).run('manual-test', 'test', 'routine note', 'discovery', 'Simple note', 'routine note', 1, new Date(now).toISOString(), now);

    const obs = db.prepare("SELECT importance FROM observations WHERE title = 'Simple note'").get();
    expect(obs.importance).toBe(1);
  });
});

// ─── FTS5 search with sanitized queries ─────────────────────────────────────

describe('FTS5 search integration', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
    // Insert test observations
    insertObs(db, { title: 'webpack-dev-server configuration fix', text: 'webpack-dev-server configuration fix' });
    insertObs(db, { title: 'next-auth session handling', text: 'next-auth session handling' });
    insertObs(db, { title: 'simple react component', text: 'simple react component' });
  });
  afterEach(() => { db.close(); });

  it('finds hyphenated terms', () => {
    const fts = sanitizeFtsQuery('webpack-dev-server');
    const rows = db.prepare(`
      SELECT o.id, o.title FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
    `).all(fts);
    expect(rows.length).toBe(1);
    expect(rows[0].title).toContain('webpack-dev-server');
  });

  it('finds simple terms', () => {
    const fts = sanitizeFtsQuery('react component');
    const rows = db.prepare(`
      SELECT o.id, o.title FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
    `).all(fts);
    expect(rows.length).toBe(1);
    expect(rows[0].title).toContain('react');
  });

  it('returns empty for non-matching queries', () => {
    const fts = sanitizeFtsQuery('nonexistent term xyz');
    const rows = db.prepare(`
      SELECT o.id FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
    `).all(fts);
    expect(rows.length).toBe(0);
  });
});

// ─── date_to inclusive filter ────────────────────────────────────────────────

describe('date_to inclusive (YYYY-MM-DD covers full day)', () => {
  it('date-only date_to extends to end-of-day', () => {
    // "2026-02-10" should parse to 2026-02-10T23:59:59.999Z, not 00:00:00.000Z
    const dateTo = '2026-02-10';
    let epochTo = new Date(dateTo).getTime();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      epochTo += 86400000 - 1;
    }
    // An observation created at 3:45 PM on 2026-02-10 (epoch ~1770699921000) should be included
    const midDayEpoch = new Date('2026-02-10T15:45:00Z').getTime();
    expect(midDayEpoch).toBeLessThanOrEqual(epochTo);
    // But next day should NOT be included
    const nextDayEpoch = new Date('2026-02-11T00:00:00Z').getTime();
    expect(nextDayEpoch).toBeGreaterThan(epochTo);
  });

  it('ISO datetime date_to is NOT extended', () => {
    const dateTo = '2026-02-10T12:00:00Z';
    let epochTo = new Date(dateTo).getTime();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      epochTo += 86400000 - 1;
    }
    // Should remain as noon, not extended
    expect(epochTo).toBe(new Date('2026-02-10T12:00:00Z').getTime());
  });
});

// ─── WAL checkpoint ─────────────────────────────────────────────────────────

describe('WAL checkpoint', () => {
  it('PASSIVE checkpoint succeeds on in-memory DB', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    expect(() => db.pragma('wal_checkpoint(PASSIVE)')).not.toThrow();
    db.close();
  });
});

// ─── mem_get multi-source ───────────────────────────────────────────────────

describe('mem_get multi-source', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
    // Insert observation
    insertObs(db, { title: 'test observation' });
    // Insert session summary
    const now = new Date();
    db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '', ?, ?)
    `).run('sess-1', 'test', 'build feature X', 'explored codebase', 'found pattern', 'implemented feature', 'add tests', now.toISOString(), now.getTime());
    // Insert user prompt
    db.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run('sess-1', 'Help me build feature X', 1, now.toISOString(), now.getTime());
  });
  afterEach(() => { db.close(); });

  it('fetches observations by default', () => {
    const rows = db.prepare("SELECT * FROM observations WHERE id = 1").all();
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe('test observation');
  });

  it('fetches session summaries', () => {
    const rows = db.prepare("SELECT * FROM session_summaries WHERE id = 1").all();
    expect(rows.length).toBe(1);
    expect(rows[0].request).toBe('build feature X');
  });

  it('fetches user prompts', () => {
    const rows = db.prepare("SELECT * FROM user_prompts WHERE id = 1").all();
    expect(rows.length).toBe(1);
    expect(rows[0].prompt_text).toBe('Help me build feature X');
  });
});

// ─── Phase 1c: access_count ─────────────────────────────────────────────────

describe('access_count tracking', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('mem_get increments access_count', () => {
    insertObs(db, { title: 'test obs' });
    const id = db.prepare("SELECT id FROM observations WHERE title = 'test obs'").get().id;

    // Simulate mem_get: increment access_count
    const updateStmt = db.prepare('UPDATE observations SET access_count = COALESCE(access_count,0) + 1 WHERE id = ?');
    updateStmt.run(id);
    updateStmt.run(id);

    const obs = db.prepare('SELECT access_count FROM observations WHERE id = ?').get(id);
    expect(obs.access_count).toBe(2);
  });

  it('missing access_count defaults to 0', () => {
    insertObs(db, { title: 'old data' });
    const obs = db.prepare("SELECT access_count FROM observations WHERE title = 'old data'").get();
    expect(obs.access_count).toBe(0);
  });

  it('access_count boosts search ranking', () => {
    // Two observations with same text — one with high access_count
    insertObs(db, { title: 'database query optimization', text: 'database query optimization', accessCount: 50 });
    insertObs(db, { title: 'database query slow fix', text: 'database query slow fix', accessCount: 0 });

    const ftsQuery = '"database" "query"';
    const now = Date.now();
    const rows = db.prepare(`
      SELECT o.id, o.title, o.access_count,
             bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)
               * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
               * (0.5 + 0.5 * COALESCE(o.importance, 1))
               * (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0))) as score
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
      ORDER BY score
    `).all(now, ftsQuery);

    expect(rows.length).toBe(2);
    // The one with access_count=50 should have a better (more negative) score
    const highAccess = rows.find(r => r.access_count === 50);
    const lowAccess = rows.find(r => r.access_count === 0);
    expect(highAccess.score).toBeLessThan(lowAccess.score);
  });
});

// ─── Phase 2a: reRankWithContext ─────────────────────────────────────────────

describe('reRankWithContext', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('boosts file-overlapping results', () => {
    // Insert a recent observation editing auth.js
    insertObs(db, { title: 'recent auth edit', filesModified: '["auth.js"]', epochOffset: -1000 });
    // Insert two search results
    const results = [
      { source: 'obs', id: 100, title: 'bug in auth', score: -5.0, files_modified: '["auth.js"]', importance: 1 },
      { source: 'obs', id: 101, title: 'unrelated fix', score: -5.0, files_modified: '["utils.js"]', importance: 1 },
    ];

    // Simulate reRankWithContext logic
    const twoHoursAgo = Date.now() - 2 * 3600000;
    const recentObs = db.prepare(`
      SELECT files_modified FROM observations WHERE project = 'test' AND created_at_epoch > ?
    `).all(twoHoursAgo);

    const activeFiles = new Set();
    for (const r of recentObs) {
      try { for (const f of JSON.parse(r.files_modified || '[]')) activeFiles.add(f); } catch {}
    }

    for (const result of results) {
      let resultFiles;
      try { resultFiles = JSON.parse(result.files_modified || '[]'); } catch { continue; }
      const common = resultFiles.filter(f => activeFiles.has(f));
      const overlap = common.length / resultFiles.length;
      result.score *= (1.0 + 0.3 * overlap);
    }
    results.sort((a, b) => a.score - b.score);

    // auth.js result should be boosted (more negative)
    expect(results[0].id).toBe(100);
    expect(results[0].score).toBeLessThan(results[1].score);
  });

  it('handles no active files gracefully', () => {
    const results = [
      { source: 'obs', id: 100, title: 'test', score: -5.0, files_modified: '["foo.js"]', importance: 1 },
    ];
    // No recent observations → activeFiles is empty → no boost applied
    const twoHoursAgo = Date.now() - 2 * 3600000;
    const recentObs = db.prepare(`
      SELECT files_modified FROM observations WHERE project = 'test' AND created_at_epoch > ?
    `).all(twoHoursAgo);
    expect(recentObs.length).toBe(0);
    // Score unchanged
    expect(results[0].score).toBe(-5.0);
  });

  it('handles empty files_modified', () => {
    const results = [
      { source: 'obs', id: 100, title: 'test', score: -5.0, files_modified: '[]', importance: 1 },
    ];
    let files;
    try { files = JSON.parse(results[0].files_modified); } catch { files = []; }
    expect(files.length).toBe(0);
    // No crash, score unchanged
    expect(results[0].score).toBe(-5.0);
  });
});

// ─── Phase 2b: markSuperseded ────────────────────────────────────────────────

describe('markSuperseded', () => {
  it('marks older lower-importance obs as superseded', () => {
    const results = [
      { source: 'obs', id: 1, date: '2026-01-01', files_modified: '["auth.js"]', importance: 1 },
      { source: 'obs', id: 2, date: '2026-02-01', files_modified: '["auth.js"]', importance: 2 },
    ];

    // Simulate markSuperseded
    const fileMap = new Map();
    for (const r of results) {
      let files;
      try { files = JSON.parse(r.files_modified || '[]'); } catch { continue; }
      for (const f of files) {
        if (!fileMap.has(f)) fileMap.set(f, []);
        fileMap.get(f).push(r);
      }
    }
    for (const [, obsForFile] of fileMap) {
      if (obsForFile.length < 2) continue;
      obsForFile.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const newest = obsForFile[0];
      for (let i = 1; i < obsForFile.length; i++) {
        if ((obsForFile[i].importance ?? 1) <= (newest.importance ?? 1)) {
          obsForFile[i].superseded = true;
        }
      }
    }

    expect(results[0].superseded).toBe(true);  // old, imp=1 <= newest imp=2
    expect(results[1].superseded).toBeUndefined();  // newest
  });

  it('preserves high-importance old obs', () => {
    const results = [
      { source: 'obs', id: 1, date: '2026-01-01', files_modified: '["auth.js"]', importance: 3 },
      { source: 'obs', id: 2, date: '2026-02-01', files_modified: '["auth.js"]', importance: 1 },
    ];

    const fileMap = new Map();
    for (const r of results) {
      let files;
      try { files = JSON.parse(r.files_modified || '[]'); } catch { continue; }
      for (const f of files) {
        if (!fileMap.has(f)) fileMap.set(f, []);
        fileMap.get(f).push(r);
      }
    }
    for (const [, obsForFile] of fileMap) {
      if (obsForFile.length < 2) continue;
      obsForFile.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const newest = obsForFile[0];
      for (let i = 1; i < obsForFile.length; i++) {
        if ((obsForFile[i].importance ?? 1) <= (newest.importance ?? 1)) {
          obsForFile[i].superseded = true;
        }
      }
    }

    expect(results[0].superseded).toBeUndefined();  // imp=3 > newest imp=1
    expect(results[1].superseded).toBeUndefined();  // newest
  });

  it('handles obs without files', () => {
    const results = [
      { source: 'obs', id: 1, date: '2026-01-01', importance: 1 },
      { source: 'session', id: 2, date: '2026-02-01' },
    ];
    // No files_modified → no crash
    expect(() => {
      for (const r of results) {
        try { JSON.parse(r.files_modified || '[]'); } catch { /* skip */ }
      }
    }).not.toThrow();
  });
});

// ─── Phase 3a: Health metrics in mem_stats ──────────────────────────────────

describe('mem_stats health metrics', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('computes token estimate', () => {
    insertObs(db, { title: 'test observation', narrative: 'some narrative text here', text: 'extra text' });
    const result = db.prepare(`
      SELECT SUM(LENGTH(COALESCE(title,'')) + LENGTH(COALESCE(narrative,'')) + LENGTH(COALESCE(text,''))) / 4 as t
      FROM observations
    `).get();
    expect(result.t).toBeGreaterThan(0);
  });

  it('computes noise ratio', () => {
    // Insert old, low-value, never-accessed observation
    insertObs(db, { title: 'old noise', importance: 1, accessCount: 0, epochOffset: -32 * 86400000 });
    // Insert recent observation
    insertObs(db, { title: 'recent obs', importance: 2, epochOffset: 0 });

    const obsTotal = db.prepare('SELECT COUNT(*) as c FROM observations').get();
    const lowVal = db.prepare(`
      SELECT COUNT(*) as c FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0 AND created_at_epoch < ?
    `).get(Date.now() - 30 * 86400000);

    const noiseRatio = obsTotal.c > 0 ? lowVal.c / obsTotal.c : 0;
    expect(noiseRatio).toBeCloseTo(0.5, 1);  // 1 of 2 is noise
  });

  it('triggers warning at > 60% noise', () => {
    // Insert 7 old low-value + 3 recent = 70% noise
    for (let i = 0; i < 7; i++) {
      insertObs(db, { title: `old noise ${i}`, importance: 1, accessCount: 0, epochOffset: -(31 + i) * 86400000 });
    }
    for (let i = 0; i < 3; i++) {
      insertObs(db, { title: `recent ${i}`, importance: 2, epochOffset: 0 });
    }

    const obsTotal = db.prepare('SELECT COUNT(*) as c FROM observations').get();
    const lowVal = db.prepare(`
      SELECT COUNT(*) as c FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0 AND created_at_epoch < ?
    `).get(Date.now() - 30 * 86400000);

    const noiseRatio = obsTotal.c > 0 ? lowVal.c / obsTotal.c : 0;
    expect(noiseRatio).toBeGreaterThan(0.6);
  });
});

// ─── Phase 3b: mem_compress ─────────────────────────────────────────────────

describe('mem_compress', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('preview shows candidates', () => {
    // Seed 5 old low-value obs in same project/week
    for (let i = 0; i < 5; i++) {
      insertObs(db, { title: `old obs ${i}`, importance: 1, accessCount: 0, epochOffset: -(90 - i) * 86400000 });
    }

    const cutoff = Date.now() - 60 * 86400000;
    const candidates = db.prepare(`
      SELECT id FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0
        AND created_at_epoch < ? AND compressed_into IS NULL
    `).all(cutoff);

    expect(candidates.length).toBe(5);
  });

  it('creates weekly summaries', () => {
    // Seed 5 old low-value obs with same week
    for (let i = 0; i < 5; i++) {
      insertObs(db, { title: `old obs ${i}`, type: 'change', importance: 1, accessCount: 0, epochOffset: -(90 + i) * 86400000 });
    }

    const cutoff = Date.now() - 60 * 86400000;
    const candidates = db.prepare(`
      SELECT id, project, type, title, created_at, created_at_epoch FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0
        AND created_at_epoch < ? AND compressed_into IS NULL ORDER BY project, created_at_epoch
    `).all(cutoff);

    // Group by project + ISO week
    const groups = new Map();
    for (const c of candidates) {
      const d = new Date(c.created_at_epoch);
      const year = d.getFullYear();
      const jan1 = new Date(year, 0, 1);
      const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      const key = `${c.project}::${year}-W${String(weekNum).padStart(2, '0')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    const compressable = [...groups.entries()].filter(([, obs]) => obs.length >= 3);
    expect(compressable.length).toBeGreaterThanOrEqual(1);
  });

  it('marks originals with compressed_into', () => {
    insertObs(db, { title: 'will compress A', importance: 1, accessCount: 0, epochOffset: -90 * 86400000 });
    insertObs(db, { title: 'will compress B', importance: 1, accessCount: 0, epochOffset: -90 * 86400000 });

    // Simulate marking
    db.prepare('UPDATE observations SET compressed_into = 999 WHERE id = 1').run();
    const obs = db.prepare('SELECT compressed_into FROM observations WHERE id = 1').get();
    expect(obs.compressed_into).toBe(999);
  });

  it('compressed obs excluded from search', () => {
    insertObs(db, { title: 'visible searchable term', text: 'visible searchable term' });
    insertObs(db, { title: 'hidden searchable term', text: 'hidden searchable term', compressedInto: 99 });

    const rows = db.prepare(`
      SELECT o.id FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH '"searchable"'
        AND COALESCE(o.compressed_into, 0) = 0
    `).all();

    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(1);
  });

  it('skips small groups (< 3 obs)', () => {
    // Only 2 obs → should not be compressed
    insertObs(db, { title: 'small group A', importance: 1, accessCount: 0, epochOffset: -90 * 86400000 });
    insertObs(db, { title: 'small group B', importance: 1, accessCount: 0, epochOffset: -90 * 86400000 });

    const cutoff = Date.now() - 60 * 86400000;
    const candidates = db.prepare(`
      SELECT id, project, type, title, created_at, created_at_epoch FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0
        AND created_at_epoch < ? AND compressed_into IS NULL ORDER BY project, created_at_epoch
    `).all(cutoff);

    const groups = new Map();
    for (const c of candidates) {
      const d = new Date(c.created_at_epoch);
      const year = d.getFullYear();
      const jan1 = new Date(year, 0, 1);
      const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      const key = `${c.project}::${year}-W${String(weekNum).padStart(2, '0')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    const compressable = [...groups.entries()].filter(([, obs]) => obs.length >= 3);
    expect(compressable.length).toBe(0);
  });
});

// ─── PRF (Pseudo-Relevance Feedback) ─────────────────────────────────────────

describe('PRF document-level expansion', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('finds expanded results via shared terms in top matches', () => {
    // Seed observations that share vocabulary
    insertObs(db, { title: 'authentication token refresh bug', text: 'authentication token refresh', narrative: 'The session cookie expired causing token refresh failure' });
    insertObs(db, { title: 'session cookie handling fix', text: 'session cookie handling', narrative: 'Fixed session cookie not being set after authentication' });
    insertObs(db, { title: 'cookie expiry configuration', text: 'cookie expiry configuration', narrative: 'Updated cookie expiry to match session timeout settings' });

    // Primary search for "authentication" should find direct match
    const ftsQuery = sanitizeFtsQuery('authentication');
    const rows = db.prepare(`
      SELECT o.id, o.title FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ? AND COALESCE(o.compressed_into, 0) = 0
      ORDER BY bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)
      LIMIT 8
    `).all(ftsQuery);

    // Should find observations with "authentication" or its synonyms
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // "cookie" and "session" should be discriminative terms across these results
    const titles = rows.map(r => r.title);
    expect(titles.some(t => t.includes('authentication') || t.includes('session'))).toBe(true);
  });

  it('does not expand when no results exist', () => {
    const ftsQuery = sanitizeFtsQuery('nonexistent_term_xyz');
    const rows = db.prepare(`
      SELECT o.id FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ? AND COALESCE(o.compressed_into, 0) = 0
    `).all(ftsQuery);
    expect(rows.length).toBe(0);
  });
});

// ─── Adaptive Time Windows ───────────────────────────────────────────────────

describe('adaptive time windows logic', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('detects high velocity (>10 obs/day)', () => {
    // Insert 80 observations in the last 7 days (>11/day)
    for (let i = 0; i < 80; i++) {
      insertObs(db, { title: `high vel obs ${i}`, epochOffset: -i * 3600000 });
    }
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    const row = db.prepare(`
      SELECT COUNT(*) as c FROM observations
      WHERE project = 'test' AND created_at_epoch > ? AND COALESCE(compressed_into, 0) = 0
    `).get(sevenDaysAgo);
    const velocity = row.c / 7;
    expect(velocity).toBeGreaterThan(10);
  });

  it('detects low velocity (<3 obs/day)', () => {
    // Insert 5 observations in the last 7 days (<1/day)
    for (let i = 0; i < 5; i++) {
      insertObs(db, { title: `low vel obs ${i}`, epochOffset: -i * 86400000 });
    }
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    const row = db.prepare(`
      SELECT COUNT(*) as c FROM observations
      WHERE project = 'test' AND created_at_epoch > ? AND COALESCE(compressed_into, 0) = 0
    `).get(sevenDaysAgo);
    const velocity = row.c / 7;
    expect(velocity).toBeLessThan(3);
  });

  it('medium velocity uses default windows', () => {
    // Insert 35 observations in the last 7 days (5/day)
    for (let i = 0; i < 35; i++) {
      insertObs(db, { title: `med vel obs ${i}`, epochOffset: -i * 4 * 3600000 });
    }
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    const row = db.prepare(`
      SELECT COUNT(*) as c FROM observations
      WHERE project = 'test' AND created_at_epoch > ? AND COALESCE(compressed_into, 0) = 0
    `).get(sevenDaysAgo);
    const velocity = row.c / 7;
    expect(velocity).toBeGreaterThanOrEqual(3);
    expect(velocity).toBeLessThanOrEqual(10);
  });
});

// ─── SKIP_TOOLS sync: skip-tools.mjs ↔ post-tool-use.sh ────────────────────
// Full consistency test is in tests/skip-tools.test.mjs
// This test verifies hook.mjs imports from skip-tools.mjs (no inline definition)

describe('SKIP_TOOLS sync between hook.mjs and post-tool-use.sh', () => {
  it('hook.mjs uses skip-tools.mjs as source of truth', () => {
    const hookSrc = readFileSync(resolve('hook.mjs'), 'utf8');
    expect(hookSrc).toContain("from './skip-tools.mjs'");
    expect(hookSrc).not.toMatch(/^const SKIP_TOOLS\s*=\s*new Set\(/m);
  });
});

// ─── BM25 Scoring Formula ────────────────────────────────────────────────────

describe('BM25 scoring formula', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('recency decay: newer obs scores better', () => {
    insertObs(db, { title: 'recency test subject alpha', text: 'recency test subject alpha', epochOffset: -30 * 86400000 });
    insertObs(db, { title: 'recency test subject alpha', text: 'recency test subject alpha', epochOffset: -1000 });

    const now = Date.now();
    const rows = db.prepare(`
      SELECT o.id, o.created_at_epoch,
             bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)
               * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
               * (0.5 + 0.5 * COALESCE(o.importance, 1))
               * (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0))) as score
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH '"recency"'
      ORDER BY score
    `).all(now);
    expect(rows.length).toBe(2);
    // More recent should have better (more negative) score
    const newer = rows.find(r => r.created_at_epoch > now - 86400000);
    const older = rows.find(r => r.created_at_epoch < now - 86400000);
    expect(newer.score).toBeLessThan(older.score);
  });

  it('project boost: current project gets 2x', () => {
    insertObs(db, { title: 'projboost alpha test term', text: 'projboost alpha test term', project: 'myproject' });
    insertObs(db, { title: 'projboost alpha test term', text: 'projboost alpha test term', project: 'other' });

    const now = Date.now();
    const rows = db.prepare(`
      SELECT o.id, o.project,
             bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)
               * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
               * (CASE WHEN o.project = 'myproject' THEN 2.0 ELSE 1.0 END)
               * (0.5 + 0.5 * COALESCE(o.importance, 1)) as score
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH '"projboost"'
      ORDER BY score
    `).all(now);
    expect(rows.length).toBe(2);
    const boosted = rows.find(r => r.project === 'myproject');
    const notBoosted = rows.find(r => r.project === 'other');
    expect(boosted.score).toBeLessThan(notBoosted.score);
  });

  it('importance weight: higher importance scores better', () => {
    insertObs(db, { title: 'impweight unique test term', text: 'impweight unique test term', importance: 1 });
    insertObs(db, { title: 'impweight unique test term', text: 'impweight unique test term', importance: 3 });

    const now = Date.now();
    const rows = db.prepare(`
      SELECT o.id, o.importance,
             bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)
               * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
               * (0.5 + 0.5 * COALESCE(o.importance, 1)) as score
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH '"impweight"'
      ORDER BY score
    `).all(now);
    expect(rows.length).toBe(2);
    const highImp = rows.find(r => r.importance === 3);
    const lowImp = rows.find(r => r.importance === 1);
    expect(highImp.score).toBeLessThan(lowImp.score);
  });

  it('access_count boost: frequently accessed scores better', () => {
    insertObs(db, { title: 'accboost unique test term', text: 'accboost unique test term', accessCount: 0 });
    insertObs(db, { title: 'accboost unique test term', text: 'accboost unique test term', accessCount: 100 });

    const now = Date.now();
    const rows = db.prepare(`
      SELECT o.id, o.access_count,
             bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)
               * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
               * (0.5 + 0.5 * COALESCE(o.importance, 1))
               * (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0))) as score
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH '"accboost"'
      ORDER BY score
    `).all(now);
    expect(rows.length).toBe(2);
    const highAcc = rows.find(r => r.access_count === 100);
    const lowAcc = rows.find(r => r.access_count === 0);
    expect(highAcc.score).toBeLessThan(lowAcc.score);
  });

  it('BM25 base score is negative', () => {
    insertObs(db, { title: 'bm25base unique test term', text: 'bm25base unique test term' });

    const rows = db.prepare(`
      SELECT bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8) as raw_score
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH '"bm25base"'
    `).all();
    expect(rows.length).toBe(1);
    expect(rows[0].raw_score).toBeLessThan(0);
  });
});

// ─── mem_timeline ────────────────────────────────────────────────────────────

describe('mem_timeline', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('FTS auto-anchor finds matching observation', () => {
    insertObs(db, { title: 'timeline anchor target observation', text: 'timeline anchor target observation' });

    const ftsQuery = '"timeline" AND "anchor"';
    const now = Date.now();
    const row = db.prepare(`
      SELECT o.id FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
        AND COALESCE(o.compressed_into, 0) = 0
      ORDER BY bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)
        * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
      LIMIT 1
    `).get(ftsQuery, now);
    expect(row).toBeDefined();
    expect(row.id).toBeGreaterThan(0);
  });

  it('returns most recent when no anchor specified', () => {
    for (let i = 0; i < 5; i++) {
      insertObs(db, { title: `timeline obs ${i}`, epochOffset: -i * 86400000 });
    }
    const rows = db.prepare(`
      SELECT id, title FROM observations
      WHERE COALESCE(compressed_into, 0) = 0
      ORDER BY created_at_epoch DESC LIMIT 11
    `).all();
    expect(rows.length).toBe(5);
    expect(rows[0].title).toBe('timeline obs 0');
  });

  it('filters by project', () => {
    insertObs(db, { title: 'proj a obs', project: 'proj-a' });
    insertObs(db, { title: 'proj b obs', project: 'proj-b' });

    const rows = db.prepare(`
      SELECT id, title FROM observations
      WHERE COALESCE(compressed_into, 0) = 0 AND project = ?
      ORDER BY created_at_epoch DESC LIMIT 11
    `).all('proj-a');
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe('proj a obs');
  });

  it('handles non-existent anchor gracefully', () => {
    const row = db.prepare('SELECT created_at_epoch FROM observations WHERE id = ?').get(99999);
    expect(row).toBeUndefined();
  });
});

// ─── mem_compress full flow ─────────────────────────────────────────────────

describe('mem_compress full flow', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('preview returns correct count', () => {
    for (let i = 0; i < 5; i++) {
      insertObs(db, { title: `compress preview ${i}`, importance: 1, accessCount: 0, epochOffset: -90 * 86400000 });
    }
    const cutoff = Date.now() - 60 * 86400000;
    const candidates = db.prepare(`
      SELECT id FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0
        AND created_at_epoch < ? AND compressed_into IS NULL
    `).all(cutoff);
    expect(candidates.length).toBe(5);
  });

  it('creates summary observation with correct type', () => {
    // Create 4 old obs in same week
    for (let i = 0; i < 4; i++) {
      insertObs(db, { title: `compress target ${i}`, type: 'change', importance: 1, accessCount: 0, epochOffset: -90 * 86400000 + i * 1000 });
    }

    // Execute compression manually
    const cutoff = Date.now() - 60 * 86400000;
    const candidates = db.prepare(`
      SELECT id, project, type, title, created_at, created_at_epoch FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0
        AND created_at_epoch < ? AND compressed_into IS NULL ORDER BY project, created_at_epoch
    `).all(cutoff);

    const groups = new Map();
    for (const c of candidates) {
      const key = `${c.project}::${isoWeekKey(c.created_at_epoch)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    const compressable = [...groups.entries()].filter(([, obs]) => obs.length >= 3);
    expect(compressable.length).toBeGreaterThanOrEqual(1);

    // Create summary
    const [, obs] = compressable[0];
    const narrative = obs.map(o => `- ${o.title}`).join('\n');
    const now = new Date();

    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run('compress-test', 'compress-test', 'test', now.toISOString(), now.getTime());

    const result = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, ?, 'change', ?, '', ?, '', '', '[]', '[]', 2, ?, ?)
    `).run('compress-test', 'test', narrative, `Weekly summary: ${obs.length} change observations`, narrative, now.toISOString(), now.getTime());

    const summaryId = Number(result.lastInsertRowid);
    for (const o of obs) {
      db.prepare('UPDATE observations SET compressed_into = ? WHERE id = ?').run(summaryId, o.id);
    }

    // Verify summary exists
    const summary = db.prepare('SELECT * FROM observations WHERE id = ?').get(summaryId);
    expect(summary.type).toBe('change');
    expect(summary.importance).toBe(2);
    expect(summary.title).toContain('Weekly summary');
  });

  it('marks originals with compressed_into', () => {
    for (let i = 0; i < 3; i++) {
      insertObs(db, { title: `mark target ${i}`, importance: 1, accessCount: 0, epochOffset: -90 * 86400000 });
    }
    // Simulate marking
    db.prepare('UPDATE observations SET compressed_into = 999 WHERE id = 1').run();
    const obs = db.prepare('SELECT compressed_into FROM observations WHERE id = 1').get();
    expect(obs.compressed_into).toBe(999);
  });

  it('compressed obs are invisible to FTS search', () => {
    insertObs(db, { title: 'compressible searchable unique', text: 'compressible searchable unique' });
    db.prepare('UPDATE observations SET compressed_into = 100 WHERE id = 1').run();

    const rows = db.prepare(`
      SELECT o.id FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH '"compressible"'
        AND COALESCE(o.compressed_into, 0) = 0
    `).all();
    expect(rows.length).toBe(0);
  });

  it('skips groups with fewer than 3 observations', () => {
    insertObs(db, { title: 'small A', importance: 1, accessCount: 0, epochOffset: -90 * 86400000 });
    insertObs(db, { title: 'small B', importance: 1, accessCount: 0, epochOffset: -90 * 86400000 });

    const cutoff = Date.now() - 60 * 86400000;
    const candidates = db.prepare(`
      SELECT id, project, type, title, created_at, created_at_epoch FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0
        AND created_at_epoch < ? AND compressed_into IS NULL ORDER BY project, created_at_epoch
    `).all(cutoff);

    const groups = new Map();
    for (const c of candidates) {
      const key = `${c.project}::${isoWeekKey(c.created_at_epoch)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const compressable = [...groups.entries()].filter(([, obs]) => obs.length >= 3);
    expect(compressable.length).toBe(0);
  });

  it('preserves high-importance observations', () => {
    // High-importance obs should not be candidates
    for (let i = 0; i < 5; i++) {
      insertObs(db, { title: `important ${i}`, importance: 3, accessCount: 0, epochOffset: -90 * 86400000 });
    }
    const cutoff = Date.now() - 60 * 86400000;
    const candidates = db.prepare(`
      SELECT id FROM observations
      WHERE COALESCE(importance,1) = 1 AND COALESCE(access_count,0) = 0
        AND created_at_epoch < ? AND compressed_into IS NULL
    `).all(cutoff);
    expect(candidates.length).toBe(0);
  });
});

// ─── Cross-source merge ─────────────────────────────────────────────────────

describe('cross-source merge', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('FTS results sorted by score (more negative = better)', () => {
    const results = [
      { source: 'obs', id: 1, score: -3.0 },
      { source: 'session', id: 2, score: -8.0 },
      { source: 'obs', id: 3, score: -5.0 },
    ];
    results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    expect(results[0].score).toBe(-8.0);
    expect(results[2].score).toBe(-3.0);
  });

  it('non-FTS results sorted by date descending', () => {
    const results = [
      { source: 'obs', id: 1, dateEpoch: 1000 },
      { source: 'obs', id: 2, dateEpoch: 3000 },
      { source: 'obs', id: 3, dateEpoch: 2000 },
    ];
    results.sort((a, b) => (b.dateEpoch ?? 0) - (a.dateEpoch ?? 0));
    expect(results[0].dateEpoch).toBe(3000);
    expect(results[2].dateEpoch).toBe(1000);
  });

  it('cross-source interleaving by score', () => {
    const results = [
      { source: 'obs', id: 1, score: -2.0 },
      { source: 'session', id: 2, score: -5.0 },
      { source: 'prompt', id: 3, score: -3.0 },
    ];
    results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    expect(results.map(r => r.source)).toEqual(['session', 'prompt', 'obs']);
  });

  it('pagination: offset+limit slices correctly', () => {
    const results = Array.from({ length: 30 }, (_, i) => ({ id: i, score: -(30 - i) }));
    results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

    const page1 = results.slice(0, 10);
    const page2 = results.slice(10, 20);

    expect(page1.length).toBe(10);
    expect(page2.length).toBe(10);
    // No overlap
    const page1Ids = new Set(page1.map(r => r.id));
    for (const r of page2) {
      expect(page1Ids.has(r.id)).toBe(false);
    }
  });
});

// ─── Schema: lesson_learned and search_aliases ──────────────────────────────

describe('schema: lesson_learned and search_aliases', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('observations table has lesson_learned and search_aliases columns', () => {
    const cols = db.pragma('table_info(observations)').map(c => c.name);
    expect(cols).toContain('lesson_learned');
    expect(cols).toContain('search_aliases');
  });

  it('session_summaries table has lessons and key_decisions columns', () => {
    const cols = db.pragma('table_info(session_summaries)').map(c => c.name);
    expect(cols).toContain('lessons');
    expect(cols).toContain('key_decisions');
  });

  it('new columns default to null', () => {
    insertSession(db, { id: 'sess-schema', project: 'test' });
    insertObs(db, { sessionId: 'sess-schema', title: 'test defaults' });
    const row = db.prepare('SELECT lesson_learned, search_aliases FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.lesson_learned).toBeNull();
    expect(row.search_aliases).toBeNull();
  });

  it('insertObs can store lesson_learned and search_aliases', () => {
    insertSession(db, { id: 'sess-lesson', project: 'test' });
    insertObs(db, {
      sessionId: 'sess-lesson', title: 'test lesson',
      lessonLearned: 'Always use atomic writes',
      searchAliases: 'atomic rename TOCTOU'
    });
    const row = db.prepare('SELECT lesson_learned, search_aliases FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.lesson_learned).toBe('Always use atomic writes');
    expect(row.search_aliases).toBe('atomic rename TOCTOU');
  });
});

// ─── Auto-boost on access ────────────────────────────────────────────────────

describe('auto-boost on access', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('boosts importance to 2 when access_count reaches 2 and importance is 1', () => {
    insertSession(db, { id: 'sess-boost', project: 'test' });
    const result = insertObs(db, { sessionId: 'sess-boost', title: 'test boost', importance: 1, accessCount: 1 });
    const id = Number(result.lastInsertRowid);
    db.prepare('UPDATE observations SET access_count = access_count + 1 WHERE id = ?').run(id);
    autoBoostIfNeeded(db, [id]);
    const row = db.prepare('SELECT importance, access_count FROM observations WHERE id = ?').get(id);
    expect(row.access_count).toBe(2);
    expect(row.importance).toBe(2);
  });

  it('does not boost importance=2+ observations', () => {
    insertSession(db, { id: 'sess-boost2', project: 'test' });
    const result = insertObs(db, { sessionId: 'sess-boost2', title: 'already important', importance: 2, accessCount: 1 });
    const id = Number(result.lastInsertRowid);
    db.prepare('UPDATE observations SET access_count = access_count + 1 WHERE id = ?').run(id);
    autoBoostIfNeeded(db, [id]);
    const row = db.prepare('SELECT importance FROM observations WHERE id = ?').get(id);
    expect(row.importance).toBe(2);
  });
});

// ─── Type-differentiated decay ──────────────────────────────────────────────

describe('type-differentiated decay', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('decisions rank higher than changes at same age when both are 30 days old', () => {
    insertSession(db, { id: 'sess-decay', project: 'test' });
    insertObs(db, { sessionId: 'sess-decay', type: 'decision', title: 'auth architecture design choice', text: 'auth architecture design choice', importance: 2, epochOffset: -30 * 86400000 });
    insertObs(db, { sessionId: 'sess-decay', type: 'change', title: 'auth config update change', text: 'auth config update change', importance: 2, epochOffset: -30 * 86400000 });

    const now = Date.now();
    const rows = db.prepare(`
      SELECT o.id, o.type, o.title,
             bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)
               * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / (
                 CASE o.type
                   WHEN 'decision'  THEN 7776000000.0
                   WHEN 'discovery' THEN 5184000000.0
                   WHEN 'feature'   THEN 2592000000.0
                   WHEN 'bugfix'    THEN 1209600000.0
                   WHEN 'refactor'  THEN 1209600000.0
                   WHEN 'change'    THEN  604800000.0
                   ELSE 1209600000.0
                 END
               ))) as score
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH 'auth'
        AND COALESCE(o.compressed_into, 0) = 0
      ORDER BY score
    `).all(now);

    const decisionIdx = rows.findIndex(r => r.type === 'decision');
    const changeIdx = rows.findIndex(r => r.type === 'change');
    expect(decisionIdx).toBeLessThan(changeIdx);
  });
});

// ─── Type-aware idle cleanup ────────────────────────────────────────────────

describe('type-aware idle cleanup', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('does not mark decision observations as pending-purge at 30 days', () => {
    insertSession(db, { id: 'sess-idle', project: 'test' });
    const result = insertObs(db, {
      sessionId: 'sess-idle', type: 'decision',
      title: 'chose FTS5 over elasticsearch',
      importance: 1, accessCount: 0,
      epochOffset: -31 * 86400000
    });
    const id = Number(result.lastInsertRowid);
    runIdleCleanup(db);
    const row = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(id);
    expect(row.compressed_into).toBeNull();
  });

  it('marks decision observations as pending-purge at 90+ days', () => {
    insertSession(db, { id: 'sess-idle-dec90', project: 'test' });
    const result = insertObs(db, {
      sessionId: 'sess-idle-dec90', type: 'decision',
      title: 'old architecture decision',
      importance: 1, accessCount: 0,
      epochOffset: -91 * 86400000
    });
    const id = Number(result.lastInsertRowid);
    runIdleCleanup(db);
    const row = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(id);
    expect(row.compressed_into).toBe(-2);
  });

  it('marks change observations as pending-purge at 14+ days', () => {
    insertSession(db, { id: 'sess-idle2', project: 'test' });
    const result = insertObs(db, {
      sessionId: 'sess-idle2', type: 'change',
      title: 'updated readme',
      importance: 1, accessCount: 0,
      epochOffset: -15 * 86400000
    });
    const id = Number(result.lastInsertRowid);
    runIdleCleanup(db);
    const row = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(id);
    expect(row.compressed_into).toBe(-2);
  });

  it('does not mark change observations before 14 days', () => {
    insertSession(db, { id: 'sess-idle-recent', project: 'test' });
    const result = insertObs(db, {
      sessionId: 'sess-idle-recent', type: 'change',
      title: 'recent change',
      importance: 1, accessCount: 0,
      epochOffset: -10 * 86400000
    });
    const id = Number(result.lastInsertRowid);
    runIdleCleanup(db);
    const row = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(id);
    expect(row.compressed_into).toBeNull();
  });

  it('marks feature observations as pending-purge at 60+ days', () => {
    insertSession(db, { id: 'sess-idle-feat', project: 'test' });
    const result = insertObs(db, {
      sessionId: 'sess-idle-feat', type: 'feature',
      title: 'old feature obs',
      importance: 1, accessCount: 0,
      epochOffset: -61 * 86400000
    });
    const id = Number(result.lastInsertRowid);
    runIdleCleanup(db);
    const row = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(id);
    expect(row.compressed_into).toBe(-2);
  });

  it('marks bugfix observations as pending-purge at 30+ days', () => {
    insertSession(db, { id: 'sess-idle-bug', project: 'test' });
    const result = insertObs(db, {
      sessionId: 'sess-idle-bug', type: 'bugfix',
      title: 'old bugfix',
      importance: 1, accessCount: 0,
      epochOffset: -31 * 86400000
    });
    const id = Number(result.lastInsertRowid);
    runIdleCleanup(db);
    const row = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(id);
    expect(row.compressed_into).toBe(-2);
  });

  it('does not mark accessed or high-importance observations', () => {
    insertSession(db, { id: 'sess-idle3', project: 'test' });
    const r1 = insertObs(db, {
      sessionId: 'sess-idle3', type: 'change', title: 'accessed change',
      importance: 1, accessCount: 5, epochOffset: -30 * 86400000
    });
    const r2 = insertObs(db, {
      sessionId: 'sess-idle3', type: 'change', title: 'important change',
      importance: 2, accessCount: 0, epochOffset: -30 * 86400000
    });
    runIdleCleanup(db);
    const row1 = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(Number(r1.lastInsertRowid));
    const row2 = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(Number(r2.lastInsertRowid));
    // accessed change: importance=1, access_count=5 → not pending-purge, but auto-compressed
    expect(row1.compressed_into).toBe(-1);
    // important change: importance=2 → untouched
    expect(row2.compressed_into).toBeNull();
  });

  it('returns counts of marked and compressed observations', () => {
    insertSession(db, { id: 'sess-idle-count', project: 'test' });
    // Two old changes with no access → pending-purge
    insertObs(db, { sessionId: 'sess-idle-count', type: 'change', title: 'stale1', importance: 1, accessCount: 0, epochOffset: -20 * 86400000 });
    insertObs(db, { sessionId: 'sess-idle-count', type: 'change', title: 'stale2', importance: 1, accessCount: 0, epochOffset: -20 * 86400000 });
    // One old change with access → compressed
    insertObs(db, { sessionId: 'sess-idle-count', type: 'change', title: 'accessed', importance: 1, accessCount: 3, epochOffset: -20 * 86400000 });
    const result = runIdleCleanup(db);
    expect(result.marked).toBe(2);
    expect(result.compressed).toBe(1);
  });
});
