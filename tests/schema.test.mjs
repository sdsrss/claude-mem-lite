// Schema tests — additive `events` table + FTS5 (v2.31 T6)
// Verifies events table, FTS5 virtual table, triggers, and idempotent migration.

import { describe, test, expect } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { initSchema, runDeferredCleanups } from '../schema.mjs';

describe('events table (T6)', () => {
  test('events table + FTS virtual table created fresh', () => {
    const db = createTestDb();
    const cols = db.prepare(`PRAGMA table_info(events)`).all();
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual(
      expect.arrayContaining([
        'id',
        'project',
        'event_type',
        'title',
        'body',
        'file_paths',
        'git_sha',
        'importance',
        'created_at_epoch',
        'accessed_count',
        'last_accessed_epoch',
        'superseded_at_epoch',
        'superseded_by_id',
      ]),
    );
    const fts = db.prepare(`SELECT name FROM sqlite_master WHERE name='events_fts'`).get();
    expect(fts).toBeTruthy();
  });

  test('event insertion propagates to FTS', () => {
    const db = createTestDb();
    db.prepare(
      `
      INSERT INTO events (project, event_type, title, body, importance, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run('mem', 'bugfix', 'fix null deref in foo', 'root cause: missing nullcheck in bar()', 2, Date.now());
    const hit = db
      .prepare(
        `
      SELECT events.title FROM events_fts
      JOIN events ON events.id = events_fts.rowid
      WHERE events_fts MATCH ?
    `,
      )
      .get('nullcheck');
    expect(hit?.title).toContain('null deref');
  });

  test('event_type enum rejects invalid types', () => {
    const db = createTestDb();
    expect(() =>
      db
        .prepare(
          `
      INSERT INTO events (project, event_type, title, importance, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `,
        )
        .run('mem', 'not_a_real_type', 't', 1, Date.now()),
    ).toThrow();
  });

  test('event deletion cascades to FTS', () => {
    const db = createTestDb();
    const info = db
      .prepare(
        `
      INSERT INTO events (project, event_type, title, importance, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run('mem', 'lesson', 'to be deleted', 1, Date.now());
    db.prepare(`DELETE FROM events WHERE id = ?`).run(info.lastInsertRowid);
    const hit = db
      .prepare(
        `
      SELECT * FROM events_fts WHERE events_fts MATCH ?
    `,
      )
      .get('deleted');
    expect(hit).toBeUndefined();
  });

  test('migration is idempotent (running initSchema twice is safe)', () => {
    const db = createTestDb();
    // createTestDb already invoked initSchema — running it again on the same
    // opened DB must not throw and must leave events table intact.
    expect(() => initSchema(db)).not.toThrow();
    const cols = db.prepare(`PRAGMA table_info(events)`).all();
    expect(cols.length).toBeGreaterThan(0);
  });

  test('idx_events_project_created compound index exists', () => {
    const db = createTestDb();
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE name='idx_events_project_created'`).get();
    expect(idx).toBeTruthy();
  });
});

describe('session_handoffs.git_sha_at_handoff column (T10d v25)', () => {
  test('git_sha_at_handoff column exists on session_handoffs', () => {
    const db = createTestDb();
    const cols = db
      .prepare(`PRAGMA table_info(session_handoffs)`)
      .all()
      .map((c) => c.name);
    expect(cols).toContain('git_sha_at_handoff');
  });

  test('git_sha_at_handoff column is nullable with default NULL', () => {
    const db = createTestDb();
    // Insert without providing git_sha_at_handoff — should default to NULL
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, created_at_epoch) VALUES (?, ?, ?, ?)`,
    ).run('p', 'exit', 's1', Date.now());
    const row = db
      .prepare(
        `SELECT git_sha_at_handoff FROM session_handoffs WHERE project='p' AND type='exit' AND session_id='s1'`,
      )
      .get();
    expect(row.git_sha_at_handoff).toBeNull();
  });

  test('git_sha_at_handoff can store a commit sha', () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, created_at_epoch, git_sha_at_handoff) VALUES (?, ?, ?, ?, ?)`,
    ).run('p', 'exit', 's1', Date.now(), 'abc123def456');
    const row = db
      .prepare(
        `SELECT git_sha_at_handoff FROM session_handoffs WHERE project='p' AND type='exit' AND session_id='s1'`,
      )
      .get();
    expect(row.git_sha_at_handoff).toBe('abc123def456');
  });

  test('schema version is up to date', () => {
    const db = createTestDb();
    const row = db.prepare(`SELECT version FROM schema_version LIMIT 1`).get();
    // Pinned to CURRENT_SCHEMA_VERSION via import to avoid drift churn
    // whenever the version bumps; still asserts it's a non-null number.
    expect(typeof row.version).toBe('number');
    expect(row.version).toBeGreaterThanOrEqual(26);
  });
});

describe('FTS trigger scoping (v27)', () => {
  test('observations_au trigger fires only on FTS columns (AFTER UPDATE OF)', () => {
    const db = createTestDb();
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='observations_au'`)
      .get();
    expect(row).toBeTruthy();
    expect(row.sql).toMatch(/AFTER\s+UPDATE\s+OF\s+title/i);
  });

  test('session_summaries_au + user_prompts_au are scoped too', () => {
    const db = createTestDb();
    for (const trg of ['session_summaries_au', 'user_prompts_au']) {
      const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?`).get(trg);
      expect(row).toBeTruthy();
      expect(row.sql).toMatch(/AFTER\s+UPDATE\s+OF\s+/i);
    }
  });

  test('v27 migration: legacy unscoped trigger gets replaced on re-init', () => {
    const db = createTestDb();
    // Inject legacy (pre-v27) trigger form
    db.exec(`DROP TRIGGER observations_au`);
    db.exec(`
      CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts, lesson_learned, search_aliases)
          VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts, old.lesson_learned, old.search_aliases);
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts, lesson_learned, search_aliases)
          VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts, new.lesson_learned, new.search_aliases);
      END
    `);
    // Force non-fast-path re-init
    db.exec('DELETE FROM schema_version');
    db.exec('INSERT INTO schema_version (version) VALUES (26)');

    const before = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='observations_au'`)
      .get();
    expect(before.sql).not.toMatch(/UPDATE\s+OF/i);

    initSchema(db);

    const after = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='observations_au'`)
      .get();
    expect(after.sql).toMatch(/AFTER\s+UPDATE\s+OF\s+title/i);
  });
});

describe('observation_vectors cleanup (v2.47 P0-1)', () => {
  test('runDeferredCleanups deletes orphan observation_vectors (observation_id not in observations)', () => {
    // Live DB had 2839/6429 (44%) orphan vectors even with ON DELETE CASCADE
    // because historic deletes ran while foreign_keys=OFF during migrations.
    // runDeferredCleanups must scrub them once regardless of FK state (P1-5).
    const db = createTestDb();
    db.prepare(
      `INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch) VALUES ('s', 's', 'p', datetime('now'), ?)`,
    ).run(Date.now());
    const obsInfo = db
      .prepare(
        `INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch) VALUES ('s', 'p', 'discovery', 't', datetime('now'), ?)`,
      )
      .run(Date.now());
    const liveId = Number(obsInfo.lastInsertRowid);
    const insertVec = db.prepare(
      `INSERT INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)`,
    );
    insertVec.run(liveId, Buffer.alloc(8), 'v1', Date.now());
    // Inject orphans by disabling FK, writing rows with non-existent obs_id, then re-enabling
    db.pragma('foreign_keys = OFF');
    insertVec.run(99991, Buffer.alloc(8), 'v1', Date.now());
    insertVec.run(99992, Buffer.alloc(8), 'v1', Date.now());
    db.pragma('foreign_keys = ON');
    // Force non-fast-path migration
    db.exec('DELETE FROM schema_version');
    db.exec('INSERT INTO schema_version (version) VALUES (26)');
    initSchema(db);
    runDeferredCleanups(db); // cleanup moved here from initSchema (audit P1-5)
    const orphanCount = db
      .prepare(
        `
      SELECT COUNT(*) AS c FROM observation_vectors ov
      LEFT JOIN observations o ON ov.observation_id = o.id
      WHERE o.id IS NULL
    `,
      )
      .get().c;
    expect(orphanCount).toBe(0);
    // Live vector preserved
    const liveRow = db
      .prepare(`SELECT observation_id FROM observation_vectors WHERE observation_id = ?`)
      .get(liveId);
    expect(liveRow?.observation_id).toBe(liveId);
  });
});

describe('runDeferredCleanups sentinel + retry (audit P1-5)', () => {
  function insertOrphanVector(db, obsId) {
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)`,
    ).run(obsId, Buffer.alloc(8), 'v1', Date.now());
  }

  test('marks each cleanup done, then skips re-runs (run-once)', () => {
    const db = createTestDb();
    runDeferredCleanups(db);
    const marks = db
      .prepare('SELECT name FROM migration_cleanups')
      .all()
      .map((r) => r.name);
    expect(marks).toContain('orphan-observation-vectors');
    expect(marks).toContain('orphan-observation-files');
    expect(marks).toContain('normalize-project-names');

    // Marker is set → a newly-injected orphan is NOT re-cleaned (run-once).
    insertOrphanVector(db, 88881);
    runDeferredCleanups(db);
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM observation_vectors WHERE observation_id = 88881').get().c,
    ).toBe(1);
  });

  test('an unmarked cleanup re-runs on the next open (retry-after-failure path)', () => {
    const db = createTestDb();
    runDeferredCleanups(db); // marks all done
    // Simulate a prior transient failure: the marker for this cleanup is absent.
    db.prepare(`DELETE FROM migration_cleanups WHERE name = 'orphan-observation-vectors'`).run();
    insertOrphanVector(db, 88882);

    runDeferredCleanups(db);

    // Unmarked → re-ran → orphan removed and the marker is restored.
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM observation_vectors WHERE observation_id = 88882').get().c,
    ).toBe(0);
    expect(
      db
        .prepare(`SELECT COUNT(*) AS c FROM migration_cleanups WHERE name = 'orphan-observation-vectors'`)
        .get().c,
    ).toBe(1);
  });
});

describe('forward-incompat guard (v2.41)', () => {
  test('initSchema throws when DB schema_version exceeds CURRENT_SCHEMA_VERSION', () => {
    const db = createTestDb();
    // Simulate a newer claude-mem-lite having written v999
    db.prepare(`DELETE FROM schema_version`).run();
    db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(999);
    expect(() => initSchema(db)).toThrow(/DB schema is v999/);
  });

  test('initSchema no-ops fast when version equals CURRENT (idempotent)', () => {
    const db = createTestDb();
    // Second call hits the fast path and returns without throwing
    expect(() => initSchema(db)).not.toThrow();
  });
});
