import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';

describe('initSchema self-heal — version-vs-columns mismatch (D#22)', () => {
  // The self-heal sentinel is LATEST_MIGRATION_COLUMN, which moved to
  // observations.scope in v44 (D#78 P3). It is NOT indexed, so DROP COLUMN
  // works directly (unlike the v37 cc_session_id sentinel, which needed its
  // index dropped first). This test intentionally tracks whatever the current
  // sentinel column is — update it in lockstep when LATEST_MIGRATION_COLUMN moves.
  it('falls through to migration re-apply when schema_version matches but latest sentinel column is missing', () => {
    const db = new Database(':memory:');
    initSchema(db); // clean init — DB at CURRENT_SCHEMA_VERSION with all columns
    // Simulate the half-migrated state observed in dev during v2.74.0 release:
    // version row reads CURRENT but the latest migration's column is missing.
    db.exec('ALTER TABLE observations DROP COLUMN scope');
    expect(db.prepare("SELECT name FROM pragma_table_info('observations') WHERE name='scope'").all()).toEqual(
      [],
    );
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(CURRENT_SCHEMA_VERSION);

    initSchema(db); // expected: detects missing column, re-runs migrations idempotently

    expect(db.prepare("SELECT name FROM pragma_table_info('observations') WHERE name='scope'").get()).toEqual(
      { name: 'scope' },
    );
    db.close();
  });

  it('fast-path stays a no-op when both version and sentinel column are present', () => {
    const db = new Database(':memory:');
    initSchema(db);
    initSchema(db); // second call — should be cheap, no errors
    // Sentinel column still intact, version still pinned.
    expect(db.prepare("SELECT name FROM pragma_table_info('observations') WHERE name='scope'").get()).toEqual(
      { name: 'scope' },
    );
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  // Review D#78: sentinel is plural since v44 — v43 (observation_files) and
  // v44 (observations) touch different tables, and a restore-from-old-backup
  // can resurrect ONE table's pre-migration shape while the version row and
  // the other table stay current. Both representatives must trip the fall-through.
  it('falls through when the OTHER batch table (observation_files) lost its sentinel column', () => {
    const db = new Database(':memory:');
    initSchema(db);
    db.exec('ALTER TABLE observation_files DROP COLUMN last_cited_session_id');

    initSchema(db); // version matches, but the v43 representative is missing

    expect(
      db
        .prepare("SELECT name FROM pragma_table_info('observation_files') WHERE name='last_cited_session_id'")
        .get(),
    ).toEqual({ name: 'last_cited_session_id' });
    db.close();
  });

  // D#78 hazard pinned live (2026-07-14): dev-mode hooks migrate the real DB
  // BETWEEN working-tree edits, so a DB can legitimately sit at an intermediate
  // version (v43: edge columns present, scope absent). A multi-table batch under
  // ONE version number left that hole invisible to the single sentinel — hence
  // one version per batch. This test freezes the recovery path: a v43-shaped DB
  // must gain observations.scope on the next initSchema.
  it('upgrades a v43-shaped DB (edge columns, no scope) to v44 with scope', () => {
    const db = new Database(':memory:');
    initSchema(db); // v44 clean
    db.exec('ALTER TABLE observations DROP COLUMN scope');
    db.prepare('UPDATE schema_version SET version = 43').run();

    initSchema(db);

    expect(db.prepare("SELECT name FROM pragma_table_info('observations') WHERE name='scope'").get()).toEqual(
      { name: 'scope' },
    );
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });
});
