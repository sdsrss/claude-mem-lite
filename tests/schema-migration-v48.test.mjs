import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

// v48 (R11-B-P1-1): observations.last_access_session_id — the access channel's
// per-session idempotency key, and the THIRD per-row session key on this table.
//
// This file exists because the pre-ship review found the highest-risk change in the
// round shipping with nothing that could say NO about it. Every other recent migration
// that added a sentinel has one (v41, v45, and v46 inside decay-first-cite-snapshot),
// and `tests/schema-self-heal.test.mjs` explicitly asks to be updated "in lockstep when
// LATEST_MIGRATION_COLUMN moves" — it was not, so the sentinel it drives is two versions
// stale. Both holes are closed here rather than argued about.
//
// The two arms below are the two ways this migration can silently not happen. Neither is
// hypothetical in this repo: v43 deliberately puts its ALTERs in the initSchema body
// rather than MIGRATIONS[] (they touch a table that does not exist yet on a fresh DB),
// so "add the ALTER in the wrong place" is a live footgun, and v45's own test file
// records a version-stamped-without-the-DDL hole observed during development.
describe('schema v48 — the access-channel session key', () => {
  const hasCol = (db, table, col) =>
    db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info(?) WHERE name = ?`).get(table, col).c === 1;
  const version = (db) => db.prepare('SELECT version FROM schema_version LIMIT 1').get().version;

  it('fresh init carries the column, nullable, defaulting to NULL', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    const meta = (name) =>
      db
        .prepare(
          `SELECT type, "notnull", dflt_value, pk FROM pragma_table_info('observations') WHERE name = ?`,
        )
        .get(name);
    const col = meta('last_access_session_id');
    expect(col).toBeTruthy();
    // Asserted as PARITY with the two keys it joins rather than against hardcoded
    // literals: this column is the third of a set, and the property that matters is that
    // it behaves like the other two. (`dflt_value` reads back as the string 'NULL' —
    // the recorded default EXPRESSION, not a JS null. Both siblings read the same.)
    expect(col).toEqual(meta('last_cited_session_id'));
    expect(col).toEqual(meta('last_decided_session_id'));
    // And the property that parity alone would not pin: nullable, so a legacy row reads
    // NULL and is credited exactly once more, on its next citation, then stamps. NOT NULL
    // or a non-null default would make every pre-migration row look already-credited.
    expect(col.notnull).toBe(0);
    db.close();
  });

  it('upgrades a v47 database and moves no data (the ALTER is reachable from v47)', () => {
    const db = createTestDb();
    insertSession(db, { id: 's', project: 'p', memoryId: 's' });
    insertObs(db, {
      sessionId: 's',
      project: 'p',
      type: 'bugfix',
      title: 'pre-existing row',
      accessCount: 7,
    });

    // Rewind to a genuine v47 shape: drop the column, put the version row back.
    db.exec('ALTER TABLE observations DROP COLUMN last_access_session_id');
    db.prepare('UPDATE schema_version SET version = 47').run();
    expect(hasCol(db, 'observations', 'last_access_session_id')).toBe(false); // premise

    initSchema(db);

    expect(hasCol(db, 'observations', 'last_access_session_id')).toBe(true);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    const row = db.prepare('SELECT access_count, title, last_access_session_id FROM observations').get();
    expect(row.access_count).toBe(7); // the counter is NOT reset by the migration
    expect(row.title).toBe('pre-existing row');
    expect(row.last_access_session_id).toBeNull();
    db.close();
  });

  it('self-heals a half-migrated DB whose version row already says it is current', () => {
    // The hole the sentinel exists for: the version row is stamped but the ALTER is not
    // on disk (interrupted migration, restore from an older backup, a peer on a newer
    // build). Without an entry in LATEST_MIGRATION_COLUMNS the fast path returns forever
    // and the column can never appear.
    const db = new Database(':memory:');
    initSchema(db);
    db.exec('ALTER TABLE observations DROP COLUMN last_access_session_id');
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION); // premise: version says done
    expect(hasCol(db, 'observations', 'last_access_session_id')).toBe(false); // but it is not

    initSchema(db);

    expect(hasCol(db, 'observations', 'last_access_session_id')).toBe(true);
    db.close();
  });

  it('is registered as a sentinel, so the fast path cannot skip past a missing column', () => {
    // Behavioural rather than textual: the previous case proves self-heal happens, this
    // one proves it happens BECAUSE the column is a sentinel. Drop only the v48 column
    // and leave every older sentinel in place — if this entry were missing from
    // LATEST_MIGRATION_COLUMNS the fast path would return and the column would stay gone.
    const db = new Database(':memory:');
    initSchema(db);
    expect(hasCol(db, 'observations', 'scope')).toBe(true); // v44 sentinel still present
    db.exec('ALTER TABLE observations DROP COLUMN last_access_session_id');
    initSchema(db);
    expect(hasCol(db, 'observations', 'last_access_session_id')).toBe(true);
    db.close();
  });

  it('re-running initSchema on a migrated DB is a no-op', () => {
    const db = new Database(':memory:');
    initSchema(db);
    initSchema(db);
    initSchema(db);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM pragma_table_info('observations') WHERE name = 'last_access_session_id'`,
        )
        .get().c,
    ).toBe(1); // exactly one, not a duplicated column
    db.close();
  });
});
