import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';

// v45 (per-surface funnel): citation_surface_log — the invocation→cite funnel
// split by injection FACE.
//
// The interesting case here is NOT "fresh init creates the table" but the
// version-stamped-without-the-table hole. CORE_SCHEMA runs ONLY on the forced
// migration pass; the fast-path returns as soon as the version row matches AND
// the sentinel columns are present. So a DB that reaches v45 by any route that
// skipped CORE_SCHEMA would never get the table — and because every reader
// wraps its query in a catch, the symptom is "0 rows", not an error. This was
// observed live during development (version bump and CREATE landed in separate
// edits, a hook fired in between), which is why v45 registers a sentinel where
// v38/v39 did not.
describe('schema v45 — per-surface citation funnel table', () => {
  const tableNames = (db) =>
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);

  it('fresh init creates citation_surface_log with its composite PK', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(tableNames(db)).toContain('citation_surface_log');
    const cols = db.prepare('PRAGMA table_info(citation_surface_log)').all();
    expect(cols.map((c) => c.name).sort()).toEqual([
      'cited_n',
      'injected_n',
      'project',
      'resolved_at',
      'session_id',
      'surface',
    ]);
    // (project, session_id, surface) is the upsert conflict target — a
    // narrower PK would make per-face rows overwrite each other.
    expect(
      cols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
    ).toEqual(['project', 'session_id', 'surface']);
    db.close();
  });

  it('CURRENT_SCHEMA_VERSION is at v45 or newer', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(45);
  });

  // The regression this version exists to prevent.
  it('self-heals a DB stamped CURRENT whose table is missing', () => {
    const db = new Database(':memory:');
    initSchema(db);
    // Simulate the observed hole: version row already says "done", table absent.
    db.exec('DROP TABLE citation_surface_log');
    expect(db.prepare('SELECT version FROM schema_version LIMIT 1').get().version).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(tableNames(db)).not.toContain('citation_surface_log');

    initSchema(db); // re-open must NOT take the fast path

    expect(tableNames(db)).toContain('citation_surface_log');
    db.close();
  });

  it('re-init is idempotent and preserves existing rows', () => {
    const db = new Database(':memory:');
    initSchema(db);
    db.prepare(
      `INSERT INTO citation_surface_log
                  (project, session_id, surface, resolved_at, injected_n, cited_n)
                VALUES ('p','s','pretool',1,7,2)`,
    ).run();
    expect(() => initSchema(db)).not.toThrow();
    const row = db.prepare('SELECT * FROM citation_surface_log').get();
    expect(row.injected_n).toBe(7);
    expect(row.cited_n).toBe(2);
    db.close();
  });
});
