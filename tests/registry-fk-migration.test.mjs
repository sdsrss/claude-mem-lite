// Regression tests for the 2026-06-22 audit P0 #1 + #4 (registry FK integrity).
//
//   #1 The "add 'github' to source CHECK" migration recreates the resources table
//      via `ALTER TABLE resources RENAME TO resources_old`. Under modern SQLite
//      (legacy_alter_table=0, the better-sqlite3 default) RENAME rewrites child-table
//      FK references, so invocations.resource_id became `REFERENCES resources_old`.
//      The subsequent `DROP TABLE resources_old` left that FK dangling → every
//      `INSERT INTO invocations` threw "no such table: resources_old" (silently, via
//      mem_use's try/catch) and dispatch telemetry died until the DB was deleted.
//      Fix: `PRAGMA legacy_alter_table=ON` around the rename so child FKs are kept.
//
//   #4 invocations.resource_id declared no ON DELETE action (NO ACTION), so deleting
//      a resource that had invocation history threw SQLITE_CONSTRAINT_FOREIGNKEY
//      (registry remove / mem_registry delete) or silently failed (dead-repo purge).
//      Fix: ON DELETE CASCADE in the schema + a rebuild migration for existing DBs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureRegistryDb, RESOURCES_SCHEMA, INVOCATIONS_SCHEMA, upsertResource } from '../registry.mjs';

// resources DDL as it existed BEFORE 'github' was added to the source CHECK.
const OLD_RESOURCES_SCHEMA = RESOURCES_SCHEMA.replace(
  "'preinstalled','user','github'",
  "'preinstalled','user'",
);
// invocations DDL as it existed BEFORE ON DELETE CASCADE was added (no-op pre-fix).
const OLD_INVOCATIONS_SCHEMA = INVOCATIONS_SCHEMA.replace(' ON DELETE CASCADE', '');
// invocations DDL as it existed when rejection_reason was a bare TEXT (added via
// `ALTER TABLE ... ADD COLUMN rejection_reason TEXT`, no CHECK) and the FK had no
// cascade — the shape that lets an out-of-whitelist rejection_reason value exist.
const OLD_INVOCATIONS_BARE = `CREATE TABLE invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL REFERENCES resources(id),
  session_id TEXT, trigger TEXT, tier INTEGER, recommended INTEGER DEFAULT 1,
  adopted INTEGER DEFAULT 0, outcome TEXT, score REAL,
  rejection_reason TEXT, created_at TEXT DEFAULT (datetime('now'))
);`;
const SAMPLE_RESOURCE = {
  name: 'bar',
  type: 'skill',
  status: 'active',
  source: 'user',
  local_path: '/y',
  repo_url: null,
  repo_stars: 0,
  file_hash: 'h',
  invocation_name: 'bar',
  intent_tags: '',
  domain_tags: '',
  action_type: '',
  trigger_patterns: '',
  capability_summary: '',
  input_type: '',
  output_type: '',
  prerequisites: '{}',
  keywords: '',
  tech_stack: '',
  use_cases: '',
  complexity: 'intermediate',
};

let dir, dbPath;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-regfk-'));
  dbPath = join(dir, 'resource-registry.db');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedOldDb({ resourcesSchema, invocationsSchema }) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(resourcesSchema);
  db.exec(invocationsSchema);
  db.prepare(
    `INSERT INTO resources (name, type, source, local_path) VALUES ('foo','skill','user','/x/foo')`,
  ).run();
  const rid = db.prepare(`SELECT id FROM resources WHERE name='foo'`).get().id;
  db.prepare(`INSERT INTO invocations (resource_id, trigger) VALUES (?, 'session_start')`).run(rid);
  db.close();
  return rid;
}

describe('registry source-CHECK migration keeps the invocations FK intact (audit #1)', () => {
  it('does NOT rewrite invocations.resource_id to resources_old or leave it dangling', () => {
    // invocations is already in final form, so ONLY the resources source-CHECK
    // migration fires — this isolates the #1 fix from the #4 rebuild.
    seedOldDb({ resourcesSchema: OLD_RESOURCES_SCHEMA, invocationsSchema: INVOCATIONS_SCHEMA });
    const db = ensureRegistryDb(dbPath);
    try {
      expect(db.pragma('foreign_key_check')).toEqual([]);
      const fk = db.pragma('foreign_key_list(invocations)')[0];
      expect(fk.table).toBe('resources');
      // mem_use's invocation-logging INSERT must still succeed post-migration.
      const rid = db.prepare(`SELECT id FROM resources WHERE name='foo'`).get().id;
      expect(() =>
        db.prepare(`INSERT INTO invocations (resource_id, trigger) VALUES (?, 'session_start')`).run(rid),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('is idempotent — a second ensureRegistryDb pass stays clean', () => {
    seedOldDb({ resourcesSchema: OLD_RESOURCES_SCHEMA, invocationsSchema: INVOCATIONS_SCHEMA });
    ensureRegistryDb(dbPath).close();
    const db = ensureRegistryDb(dbPath);
    try {
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('registry invocations ON DELETE CASCADE (audit #4)', () => {
  it('deleting a resource with invocation history cascades instead of throwing', () => {
    seedOldDb({ resourcesSchema: OLD_RESOURCES_SCHEMA, invocationsSchema: OLD_INVOCATIONS_SCHEMA });
    const db = ensureRegistryDb(dbPath);
    try {
      const rid = db.prepare(`SELECT id FROM resources WHERE name='foo'`).get().id;
      expect(db.prepare(`SELECT COUNT(*) c FROM invocations WHERE resource_id=?`).get(rid).c).toBeGreaterThan(
        0,
      );
      // the `registry remove` / mem_registry delete path:
      expect(() =>
        db.prepare(`DELETE FROM resources WHERE type=? AND name=?`).run('skill', 'foo'),
      ).not.toThrow();
      expect(db.prepare(`SELECT COUNT(*) c FROM invocations WHERE resource_id=?`).get(rid).c).toBe(0);
    } finally {
      db.close();
    }
  });
});

// Review HIGH-1: a table rebuild (RENAME→recreate→copy→DROP) silently dropped the
// table's OWN indexes — CREATE INDEX IF NOT EXISTS was skipped because the index
// names were still held by the *_old table. For resources this drops the UNIQUE
// idx_res_type_name that upsertResource's ON CONFLICT(type,name) depends on, so the
// whole registry write path threw until the next process re-ran ensureRegistryDb.
describe('registry source-CHECK rebuild preserves the resources indexes (review HIGH-1)', () => {
  it('keeps the UNIQUE idx_res_type_name so upsertResource ON CONFLICT works in the same process', () => {
    seedOldDb({ resourcesSchema: OLD_RESOURCES_SCHEMA, invocationsSchema: INVOCATIONS_SCHEMA });
    const db = ensureRegistryDb(dbPath);
    try {
      const idx = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='resources'`)
        .all()
        .map((r) => r.name);
      expect(idx).toContain('idx_res_type_name');
      expect(() => upsertResource(db, SAMPLE_RESOURCE)).not.toThrow();
      // a second upsert on the same (type,name) must hit ON CONFLICT, not duplicate
      expect(() => upsertResource(db, SAMPLE_RESOURCE)).not.toThrow();
      expect(db.prepare(`SELECT COUNT(*) c FROM resources WHERE type='skill' AND name='bar'`).get().c).toBe(
        1,
      );
    } finally {
      db.close();
    }
  });
});

// Review HIGH-2: the #4 rebuild copied ALL columns including the now-CHECK-constrained
// rejection_reason. An old DB where that column was a bare TEXT could hold a value
// outside the current whitelist; the copy then threw SQLITE_CONSTRAINT_CHECK, the txn
// rolled back, debugCatch swallowed it, and the FK was silently left WITHOUT cascade —
// so the bug #4 set out to fix persisted, forever (every retry re-fails).
describe('registry #4 rebuild tolerates legacy out-of-CHECK data (review HIGH-2)', () => {
  it('still applies ON DELETE CASCADE when a row holds an out-of-whitelist rejection_reason', () => {
    const seed = new Database(dbPath);
    seed.pragma('foreign_keys = ON');
    seed.exec(RESOURCES_SCHEMA); // current resources (has 'github') → only #4 fires
    seed.exec(OLD_INVOCATIONS_BARE);
    seed
      .prepare(`INSERT INTO resources (name,type,source,local_path) VALUES ('foo','skill','user','/x')`)
      .run();
    seed
      .prepare(
        `INSERT INTO invocations (resource_id,trigger,rejection_reason) VALUES (1,'session_start','legacy_value_not_in_whitelist')`,
      )
      .run();
    seed.close();

    const db = ensureRegistryDb(dbPath);
    try {
      // Pre-fix the copy threw SQLITE_CONSTRAINT_CHECK on the legacy value → rollback →
      // FK left without cascade. The fix omits rejection_reason from the copy, so:
      expect(
        /ON DELETE CASCADE/i.test(
          db.prepare(`SELECT sql FROM sqlite_master WHERE name='invocations'`).get().sql,
        ),
      ).toBe(true);
      // the invocation row survives, its out-of-CHECK rejection_reason dropped to NULL:
      const row = db.prepare(`SELECT resource_id, rejection_reason FROM invocations`).get();
      expect(row.resource_id).toBe(1);
      expect(row.rejection_reason).toBeNull();
      expect(db.pragma('foreign_key_check')).toEqual([]);
      // (the end-to-end DELETE→cascade path is covered by the sibling #4 test, which
      //  seeds via OLD_RESOURCES so the source-CHECK FTS rebuild keeps resources_fts in
      //  sync; here resources is hand-seeded before the FTS exists, an artifact unrelated
      //  to this fix.)
    } finally {
      db.close();
    }
  });
});
