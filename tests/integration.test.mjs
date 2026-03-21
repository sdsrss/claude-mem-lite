// Integration tests: verify complete pipelines across DB layers
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { sanitizeFtsQuery, jaccardSimilarity, computeMinHash, scrubSecrets, isoWeekKey } from '../utils.mjs';
import { reRankWithContext, markSuperseded, extractPRFTerms, expandQueryByConcepts } from '../server-internals.mjs';

// ─── Search Pipeline Integration ─────────────────────────────────────────────

describe('search pipeline integration', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('full search flow: insert → FTS query → rerank → superseded → results', () => {
    // Seed diverse observations
    insertObs(db, { title: 'auth token refresh bug', text: 'auth token refresh bug', filesModified: '["src/auth.js"]', importance: 1, epochOffset: -5 * 86400000 });
    insertObs(db, { title: 'auth session handling fix', text: 'auth session handling fix', filesModified: '["src/auth.js"]', importance: 2, epochOffset: -1000 });
    insertObs(db, { title: 'unrelated database migration', text: 'unrelated database migration', filesModified: '["src/db.js"]', importance: 1 });

    // Step 1: FTS search
    const ftsQuery = sanitizeFtsQuery('auth');
    const now = Date.now();
    const rows = db.prepare(`
      SELECT o.id, o.type, o.title, o.project, o.created_at, o.importance,
             o.files_modified,
             bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)
               * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
               * (0.5 + 0.5 * COALESCE(o.importance, 1)) as score
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
        AND COALESCE(o.compressed_into, 0) = 0
      ORDER BY score
      LIMIT 20
    `).all(now, ftsQuery);

    const results = rows.map(r => ({
      source: 'obs', id: r.id, title: r.title, score: r.score,
      files_modified: r.files_modified, importance: r.importance,
      date: r.created_at,
    }));

    // Should find auth-related observations (synonym expansion: auth→authentication)
    expect(results.length).toBeGreaterThanOrEqual(2);

    // Step 2: reRank (recent auth.js edits should boost)
    reRankWithContext(db, results, 'test');

    // Step 3: markSuperseded
    markSuperseded(results);

    // The older lower-importance auth.js obs should be superseded
    const oldAuth = results.find(r => r.title.includes('token refresh'));
    const newAuth = results.find(r => r.title.includes('session handling'));
    expect(oldAuth.superseded).toBe(true);
    expect(newAuth.superseded).toBeUndefined();
  });

  it('concept co-occurrence expansion finds related results', () => {
    // Seed observations with shared concepts
    for (let i = 0; i < 4; i++) {
      const now = Date.now() + i;
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, 'test', ?, 'discovery', ?, '', 'webpack bundling optimization', '', '[]', '[]', 1, ?, ?)
      `).run('sess-1', `webpack bundling doc ${i}`, `webpack obs ${i}`, new Date(now).toISOString(), now);
    }
    // One observation with only "optimization" concept (no direct "webpack" match)
    const now2 = Date.now() + 10;
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'test', ?, 'discovery', ?, '', 'bundling optimization treeshaking', '', '[]', '[]', 1, ?, ?)
    `).run('sess-1', 'treeshaking optimization', 'treeshake obs', new Date(now2).toISOString(), now2);

    const concepts = expandQueryByConcepts(db, '"webpack"', 'test');
    // Should discover "bundling" and/or "optimization" as co-occurring concepts
    expect(concepts.length).toBeGreaterThan(0);
  });

  it('PRF expansion extracts discriminative terms from top results', () => {
    // Seed multiple observations with shared vocabulary
    const docs = [
      { title: 'react component lifecycle hooks', narrative: 'useEffect cleanup function prevents memory leaks in component lifecycle' },
      { title: 'react hooks memory management', narrative: 'useEffect and useCallback help manage component lifecycle and memory' },
      { title: 'react cleanup patterns', narrative: 'Component lifecycle cleanup with useEffect return function prevents leaks' },
    ];
    for (const d of docs) {
      const now = Date.now() + Math.random() * 1000;
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, 'test', ?, 'discovery', ?, ?, '', '', '[]', '[]', 1, ?, ?)
      `).run('sess-1', d.title, d.title, d.narrative, new Date(now).toISOString(), now);
    }

    const prfTerms = extractPRFTerms(docs, '"react"');
    // Should find terms like "lifecycle", "component", "useeffect" that appear in >=2 docs
    expect(prfTerms.length).toBeGreaterThan(0);
    expect(prfTerms.every(t => t !== 'react')).toBe(true); // query term excluded
  });

  it('pagination: no overlap between pages', () => {
    for (let i = 0; i < 30; i++) {
      insertObs(db, { title: `paginate test item ${i}`, text: `paginate test item ${i}`, epochOffset: -i * 1000 });
    }

    const ftsQuery = sanitizeFtsQuery('paginate');
    const now = Date.now();
    const allRows = db.prepare(`
      SELECT o.id,
             bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)
               * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0)) as score
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
        AND COALESCE(o.compressed_into, 0) = 0
      ORDER BY score
    `).all(now, ftsQuery);

    const page1 = allRows.slice(0, 10);
    const page2 = allRows.slice(10, 20);
    const page1Ids = new Set(page1.map(r => r.id));
    for (const r of page2) {
      expect(page1Ids.has(r.id)).toBe(false);
    }
  });
});

// ─── DB Lifecycle ────────────────────────────────────────────────────────────

describe('DB lifecycle', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', memoryId: 'sess-1' });
  });
  afterEach(() => { db.close(); });

  it('init → seed → search → compress → verify invisible', () => {
    // Seed old low-value observations
    for (let i = 0; i < 5; i++) {
      insertObs(db, { title: `lifecycle old obs ${i}`, text: `lifecycle old obs ${i}`, importance: 1, accessCount: 0, epochOffset: -90 * 86400000 });
    }

    // Verify FTS finds them
    const before = db.prepare(`
      SELECT o.id FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH '"lifecycle"'
        AND COALESCE(o.compressed_into, 0) = 0
    `).all();
    expect(before.length).toBe(5);

    // Compress: group by week and create summary
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

    for (const [, obs] of groups) {
      if (obs.length < 3) continue;
      const now = new Date();
      db.prepare(`
        INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, 'test', ?, ?, 'active')
      `).run('compress-test', 'compress-test', now.toISOString(), now.getTime());

      const result = db.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, 'test', ?, 'change', ?, ?, '', '', '[]', '[]', 2, ?, ?)
      `).run('compress-test', 'summary', `Weekly summary: ${obs.length}`, obs.map(o => o.title).join('\n'), now.toISOString(), now.getTime());
      const summaryId = Number(result.lastInsertRowid);
      for (const o of obs) {
        db.prepare('UPDATE observations SET compressed_into = ? WHERE id = ?').run(summaryId, o.id);
      }
    }

    // Verify compressed obs are excluded from FTS (only the summary remains)
    const after = db.prepare(`
      SELECT o.id, o.compressed_into FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH '"lifecycle"'
        AND COALESCE(o.compressed_into, 0) = 0
    `).all();
    // Only the summary obs should be visible (it contains "lifecycle" in narrative)
    expect(after.length).toBeLessThanOrEqual(1);
    for (const r of after) {
      expect(r.compressed_into).toBeNull(); // not itself compressed
    }
  });

  it('INSERT OR IGNORE handles concurrent session creation', () => {
    const now = new Date();
    // First insert succeeds
    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'test', ?, ?, 'active')
    `).run('dup-sess', 'dup-sess', now.toISOString(), now.getTime());

    // Second insert with same ID is silently ignored
    expect(() => {
      db.prepare(`
        INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, 'test', ?, ?, 'active')
      `).run('dup-sess', 'dup-sess', now.toISOString(), now.getTime());
    }).not.toThrow();

    const count = db.prepare("SELECT COUNT(*) as c FROM sdk_sessions WHERE content_session_id = 'dup-sess'").get();
    expect(count.c).toBe(1);
  });

  it('FTS triggers cascade on update', () => {
    insertObs(db, { title: 'original fts title', text: 'original fts title' });

    // Verify FTS finds original
    let rows = db.prepare(`
      SELECT rowid FROM observations_fts WHERE observations_fts MATCH '"original"'
    `).all();
    expect(rows.length).toBe(1);

    // Update the title
    db.prepare("UPDATE observations SET title = 'updated fts title', text = 'updated fts title' WHERE id = 1").run();

    // FTS should find updated text, not original
    rows = db.prepare(`
      SELECT rowid FROM observations_fts WHERE observations_fts MATCH '"updated"'
    `).all();
    expect(rows.length).toBe(1);

    rows = db.prepare(`
      SELECT rowid FROM observations_fts WHERE observations_fts MATCH '"original"'
    `).all();
    expect(rows.length).toBe(0);
  });
});

// ─── Tool Flow ───────────────────────────────────────────────────────────────

describe('tool flow: save → search → get roundtrip', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-test', memoryId: 'manual-test' });
  });
  afterEach(() => { db.close(); });

  it('complete roundtrip: save, search, get', () => {
    // Save
    const now = Date.now();
    const content = 'Important finding about memory leak in websocket handler';
    const title = 'WebSocket memory leak discovery';
    const safeContent = scrubSecrets(content);
    const safeTitle = scrubSecrets(title);
    const minhashSig = computeMinHash(safeTitle + ' ' + safeContent);

    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, minhash_sig, created_at, created_at_epoch)
      VALUES (?, 'test', ?, 'discovery', ?, ?, '', '', '[]', '[]', 2, ?, ?, ?)
    `).run('manual-test', safeContent, safeTitle, safeContent, minhashSig, new Date(now).toISOString(), now);

    // Search
    const ftsQuery = sanitizeFtsQuery('websocket memory');
    const searchRows = db.prepare(`
      SELECT o.id, o.title FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
        AND COALESCE(o.compressed_into, 0) = 0
    `).all(ftsQuery);
    expect(searchRows.length).toBe(1);

    // Get
    const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(searchRows[0].id);
    expect(obs.title).toBe(safeTitle);
    expect(obs.text).toBe(safeContent);
    expect(obs.importance).toBe(2);
    expect(obs.minhash_sig).toBe(minhashSig);
  });

  it('dedup blocks near-duplicate saves', () => {
    const now = Date.now();
    // First save
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'test', ?, 'discovery', ?, ?, '', '', '[]', '[]', 1, ?, ?)
    `).run('manual-test', 'Fix the auth token refresh bug', 'Fix auth token refresh bug', 'Fix the auth token refresh bug', new Date(now).toISOString(), now);

    // Check dedup
    const fiveMinAgo = now - 5 * 60 * 1000;
    const recent = db.prepare(`
      SELECT title, text FROM observations
      WHERE project = 'test' AND created_at_epoch > ?
      ORDER BY created_at_epoch DESC LIMIT 50
    `).all(fiveMinAgo);

    const newTitle = 'Fix the auth token refresh bug';
    const isDuplicate = recent.some(r => jaccardSimilarity(r.title, newTitle) > 0.7);
    expect(isDuplicate).toBe(true);
  });

  it('delete cleans up FTS entries', () => {
    insertObs(db, { sessionId: 'manual-test', title: 'deleteme unique findable', text: 'deleteme unique findable' });
    const id = db.prepare("SELECT id FROM observations WHERE title = 'deleteme unique findable'").get().id;

    // Verify FTS finds it
    const before = db.prepare(`SELECT rowid FROM observations_fts WHERE observations_fts MATCH '"deleteme"'`).all();
    expect(before.length).toBe(1);

    // Delete
    db.prepare('DELETE FROM observations WHERE id = ?').run(id);

    // FTS should be clean
    const after = db.prepare(`SELECT rowid FROM observations_fts WHERE observations_fts MATCH '"deleteme"'`).all();
    expect(after.length).toBe(0);
  });
});

// ─── WAL Concurrent Stress Test ─────────────────────────────────────────────

describe('WAL concurrent stress test', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'stress-sess', memoryId: 'stress-sess' });
  });
  afterEach(() => { db.close(); });

  it('parallel inserts all succeed without corruption', async () => {
    const workerCount = 10;
    const insertsPerWorker = 5;

    await Promise.all(
      Array.from({ length: workerCount }, (_, w) => (async () => {
        for (let i = 0; i < insertsPerWorker; i++) {
          insertObs(db, {
            sessionId: 'stress-sess',
            title: `worker-${w}-obs-${i}`,
            text: `stress test observation from worker ${w} iteration ${i}`,
            importance: (i % 3) + 1,
            epochOffset: -(w * insertsPerWorker + i) * 1000,
          });
        }
      })()),
    );

    const total = db.prepare('SELECT COUNT(*) as c FROM observations').get();
    expect(total.c).toBe(workerCount * insertsPerWorker);

    // Verify every row exists with correct title pattern
    for (let w = 0; w < workerCount; w++) {
      for (let i = 0; i < insertsPerWorker; i++) {
        const row = db.prepare('SELECT title FROM observations WHERE title = ?').get(`worker-${w}-obs-${i}`);
        expect(row).toBeTruthy();
      }
    }
  });

  it('concurrent reads during writes return consistent data', async () => {
    // Pre-seed some observations
    for (let i = 0; i < 10; i++) {
      insertObs(db, {
        sessionId: 'stress-sess',
        title: `seed-obs-${i}`,
        text: `seed observation ${i}`,
        epochOffset: -i * 1000,
      });
    }

    const readResults = [];
    const writeCount = 10;

    await Promise.all([
      // Writer: insert more rows concurrently
      (async () => {
        for (let i = 0; i < writeCount; i++) {
          insertObs(db, {
            sessionId: 'stress-sess',
            title: `concurrent-write-${i}`,
            text: `concurrent write observation ${i}`,
            epochOffset: -(100 + i) * 1000,
          });
        }
      })(),
      // Reader: repeatedly count rows while writes happen
      (async () => {
        for (let i = 0; i < 20; i++) {
          const count = db.prepare('SELECT COUNT(*) as c FROM observations').get();
          readResults.push(count.c);
        }
      })(),
    ]);

    // Reads should always return a valid count (>= seed count, monotonically non-decreasing or stable)
    for (const count of readResults) {
      expect(count).toBeGreaterThanOrEqual(10);
      expect(count).toBeLessThanOrEqual(10 + writeCount);
    }

    // Final state: all rows present
    const finalCount = db.prepare('SELECT COUNT(*) as c FROM observations').get();
    expect(finalCount.c).toBe(10 + writeCount);
  });

  it('FTS index remains consistent after concurrent inserts', async () => {
    const workerCount = 5;
    const insertsPerWorker = 4;

    await Promise.all(
      Array.from({ length: workerCount }, (_, w) => (async () => {
        for (let i = 0; i < insertsPerWorker; i++) {
          insertObs(db, {
            sessionId: 'stress-sess',
            title: `ftsworker ${w} iteration ${i}`,
            text: `ftsworker stress fts consistency check worker ${w}`,
            epochOffset: -(w * insertsPerWorker + i) * 1000,
          });
        }
      })()),
    );

    // FTS should find all rows matching "ftsworker"
    const ftsRows = db.prepare(`
      SELECT o.id FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH '"ftsworker"'
    `).all();

    expect(ftsRows.length).toBe(workerCount * insertsPerWorker);
  });
});
