import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';

// Regression: when an old observations_fts predating the lesson_learned/search_aliases
// columns is recreated by the migration, the index is left empty and must be rebuilt
// from the content table. The old emptiness probe `SELECT COUNT(*) FROM observations_fts`
// reads the CONTENT table (external-content FTS5), not the index, so it never detected
// the empty index and the rebuild was dead code — full-text search silently returned 0.
describe('schema — observations_fts rebuild after column-mismatch recreation', () => {
  it('repopulates the FTS index so MATCH works after the recreation migration', () => {
    const db = new Database(':memory:');
    initSchema(db);

    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES ('s1', 's1', 'p', '2026-01-01', 1, 'active')`,
    ).run();
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch)
       VALUES ('s1', 'p', 'findme content body', 'discovery', 'findme title', '2026-01-01', 1)`,
    ).run();
    // Sanity: fresh-DB triggers indexed it.
    expect(
      db.prepare(`SELECT COUNT(*) c FROM observations_fts WHERE observations_fts MATCH 'findme'`).get().c,
    ).toBe(1);

    // Simulate a pre-migration DB: legacy 6-column FTS (no lesson_learned/search_aliases),
    // triggers dropped, version rolled back so initSchema re-runs the migration pass.
    db.exec(`DROP TRIGGER IF EXISTS observations_ai`);
    db.exec(`DROP TRIGGER IF EXISTS observations_ad`);
    db.exec(`DROP TRIGGER IF EXISTS observations_au`);
    db.exec(`DROP TABLE IF EXISTS observations_fts`);
    db.exec(
      `CREATE VIRTUAL TABLE observations_fts USING fts5(title, narrative, concepts, facts, text, type, content=observations, content_rowid=id)`,
    );
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION - 1);

    initSchema(db);

    // The migration must have recreated the 8-column FTS AND repopulated it.
    const ddl = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='observations_fts'`)
      .get();
    expect(ddl.sql).toContain('lesson_learned');
    expect(ddl.sql).toContain('search_aliases');
    expect(
      db.prepare(`SELECT COUNT(*) c FROM observations_fts WHERE observations_fts MATCH 'findme'`).get().c,
    ).toBe(1);
    db.close();
  });
});

// Round-5 HIGH: session_summaries_fts had NO recreation guard (only observations_fts did),
// so an early-adopter DB with a 6-column FTS table (predating `remaining_items`, v2.2.0) kept
// the narrow table forever while its triggers were rebuilt with 7 columns — every
// session_summaries UPDATE then threw "no column named remaining_items" and was silently
// swallowed, discarding Haiku summary enrichment every session. The fix makes ensureFTS
// column-aware so ALL managed FTS tables self-heal on a column addition.
describe('schema — session_summaries_fts widens on column drift (round-5 HIGH)', () => {
  it('widens a stale 6-col FTS to 7 cols so the enrichment UPDATE no longer throws', () => {
    const db = new Database(':memory:');
    initSchema(db);

    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES ('s1', 's1', 'p', '2026-01-01', 1, 'active')`,
    ).run();
    db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, created_at, created_at_epoch, request, remaining_items)
       VALUES ('s1', 'p', '2026-01-01', 1, 'initial request text', 'follow up alpha')`,
    ).run();
    const sid = db.prepare('SELECT id FROM session_summaries LIMIT 1').get().id;

    // Simulate the pre-v2.2.0 cohort: legacy 6-column FTS (no remaining_items), triggers
    // dropped, version rolled back so initSchema re-runs the migration pass (as the real
    // cohort does now that CURRENT_SCHEMA_VERSION bumped past their stamp).
    db.exec(`DROP TRIGGER IF EXISTS session_summaries_ai`);
    db.exec(`DROP TRIGGER IF EXISTS session_summaries_ad`);
    db.exec(`DROP TRIGGER IF EXISTS session_summaries_au`);
    db.exec(`DROP TABLE IF EXISTS session_summaries_fts`);
    db.exec(
      `CREATE VIRTUAL TABLE session_summaries_fts USING fts5(request, investigated, learned, completed, next_steps, notes, content=session_summaries, content_rowid=id)`,
    );
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION - 1);

    // Pre-fix sanity: the stale 6-col table lacks remaining_items.
    expect(
      db
        .prepare(`PRAGMA table_info(session_summaries_fts)`)
        .all()
        .map((c) => c.name),
    ).not.toContain('remaining_items');

    initSchema(db);

    // ensureFTS must have widened the FTS table to the full 7-column set.
    const cols = db
      .prepare(`PRAGMA table_info(session_summaries_fts)`)
      .all()
      .map((c) => c.name);
    expect(cols).toContain('remaining_items');
    expect(cols.length).toBe(7);

    // The production-shape enrichment UPDATE (the throw site at hook-llm.mjs) must now succeed.
    expect(() =>
      db
        .prepare(`UPDATE session_summaries SET request = ?, learned = ?, remaining_items = ? WHERE id = ?`)
        .run('enriched request', 'a lesson', 'follow up beta', sid),
    ).not.toThrow();

    // Repopulated + trigger-updated: the seeded row is searchable, incl. by the widened column.
    expect(
      db
        .prepare(`SELECT COUNT(*) c FROM session_summaries_fts WHERE session_summaries_fts MATCH 'enriched'`)
        .get().c,
    ).toBe(1);
    expect(
      db
        .prepare(`SELECT COUNT(*) c FROM session_summaries_fts WHERE session_summaries_fts MATCH 'beta'`)
        .get().c,
    ).toBe(1);
    db.close();
  });
});
