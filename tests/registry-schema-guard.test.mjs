// Regression tests for audit P2-6 (registry DB had no version guard / no FTS self-heal).
//
// The memory DB has had both protections for a while — schema.mjs:326-380 throws when a
// persisted schema_version is NEWER than the running build, and ensureFTS (schema.mjs:1057)
// drops+recreates an FTS index whose indexed-column set has drifted from the current list.
// ensureRegistryDb had neither, which left two live failure modes:
//
//   (a) A newer claude-mem-lite writes resource-registry.db; an older binary then opens it
//       and re-applies its own (older) migrations over the newer layout, silently.
//   (b) A future release widens resources_fts. Existing DBs keep the NARROW index, but
//       TRIGGERS_SCHEMA is re-exec'd from the CURRENT (wider) column list on every open, so
//       every `INSERT INTO resources` fires a trigger writing a column the index lacks →
//       "no such column: X" → the write is lost. Exactly the bug class ensureFTS fixed for
//       session_summaries_fts.
//
// Existing registry DBs in the wild predate the version table entirely; the first open must
// ADOPT them (stamp the current version, keep all data), never wipe or refuse.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ensureRegistryDb,
  REGISTRY_SCHEMA_VERSION,
  RESOURCES_SCHEMA,
  FTS5_SCHEMA,
  TRIGGERS_SCHEMA,
  INVOCATIONS_SCHEMA,
  PREINSTALLED_SCHEMA,
} from '../registry.mjs';

// resources_fts as it would look on a DB created BEFORE `name` joined the indexed columns.
// Stands in for any future column addition — the drift direction is what matters.
const NARROW_FTS5_SCHEMA = FTS5_SCHEMA.replace('    name,\n', '');

const INSERT_RESOURCE = `
  INSERT INTO resources (name, type, source, local_path, keywords, capability_summary)
  VALUES (?, 'skill', 'user', '/x', 'alpha beta', 'does a thing')
`;

let dir, dbPath;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-regver-'));
  dbPath = join(dir, 'resource-registry.db');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Seed an on-disk registry DB at the current schema, optionally with a narrowed FTS index. */
function seedDb({ ftsSchema = FTS5_SCHEMA, withTriggers = true, version = null } = {}) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(RESOURCES_SCHEMA);
  db.exec(ftsSchema);
  if (withTriggers) db.exec(TRIGGERS_SCHEMA);
  db.exec(INVOCATIONS_SCHEMA);
  db.exec(PREINSTALLED_SCHEMA);
  if (version !== null) {
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  }
  db.close();
}

describe('registry forward-incompatibility guard (audit P2-6)', () => {
  it('throws a clear upgrade message when the DB was written by a newer client', () => {
    // 9999 = a version no build will ever ship, so this asserts the guard, not the constant.
    seedDb({ version: 9999 });
    expect(() => ensureRegistryDb(dbPath)).toThrow(/registry DB schema is v9999/i);
    expect(() => ensureRegistryDb(dbPath)).toThrow(/upgrade claude-mem-lite/i);
  });

  it('does NOT run its migrations against a newer DB', () => {
    // Pre-guard, ensureRegistryDb would happily re-apply old migrations over a newer
    // layout. The throw must happen before any schema mutation: prove it by seeding a
    // marker table the old migrations would have had a chance to disturb, and checking
    // the DB is byte-for-byte untouched (same sqlite_master DDL set).
    seedDb({ version: 9999 });
    const before = new Database(dbPath);
    const ddlBefore = before.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all();
    before.close();

    expect(() => ensureRegistryDb(dbPath)).toThrow();

    const after = new Database(dbPath);
    const ddlAfter = after.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all();
    after.close();
    expect(ddlAfter).toEqual(ddlBefore);
  });

  it('opens normally when the persisted version equals the current one', () => {
    seedDb({ version: REGISTRY_SCHEMA_VERSION });
    const db = ensureRegistryDb(dbPath);
    try {
      expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(REGISTRY_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});

describe('registry version adoption for pre-version DBs (back-compat)', () => {
  it('adopts an existing un-versioned registry DB: stamps the version, keeps every row', () => {
    seedDb(); // no schema_version table at all — the shape of every DB in the wild today
    const seed = new Database(dbPath);
    seed.prepare(INSERT_RESOURCE).run('legacy-skill');
    seed.prepare(`INSERT INTO preinstalled (name, type, repo_url) VALUES ('p','skill','https://x')`).run();
    seed.close();

    const db = ensureRegistryDb(dbPath);
    try {
      expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(REGISTRY_SCHEMA_VERSION);
      // Adoption must never wipe: pre-existing rows survive untouched.
      expect(db.prepare(`SELECT COUNT(*) c FROM resources WHERE name='legacy-skill'`).get().c).toBe(1);
      expect(db.prepare(`SELECT COUNT(*) c FROM preinstalled`).get().c).toBe(1);
    } finally {
      db.close();
    }
  });

  it('stamps a brand-new DB and stays at exactly one version row across opens', () => {
    ensureRegistryDb(dbPath).close();
    ensureRegistryDb(dbPath).close();
    const db = ensureRegistryDb(dbPath);
    try {
      const rows = db.prepare('SELECT version FROM schema_version').all();
      expect(rows).toEqual([{ version: REGISTRY_SCHEMA_VERSION }]);
    } finally {
      db.close();
    }
  });
});

describe('resources_fts column-drift self-heal (audit P2-6)', () => {
  it('widens a stale narrow index so INSERT INTO resources still lands', () => {
    // Pre-fix: ensureRegistryDb saw resources_fts exist and skipped creation, then exec'd
    // TRIGGERS_SCHEMA from the wider column list. The insert trigger then wrote `name` into
    // an index without it → "no such column: name", and the resource write was lost.
    seedDb({ ftsSchema: NARROW_FTS5_SCHEMA });
    const db = ensureRegistryDb(dbPath);
    try {
      expect(() => db.prepare(INSERT_RESOURCE).run('widened')).not.toThrow();
      expect(db.prepare(`SELECT COUNT(*) c FROM resources WHERE name='widened'`).get().c).toBe(1);
      // and the row is actually reachable through FTS, on the newly indexed column
      const hit = db.prepare(`SELECT rowid FROM resources_fts WHERE resources_fts MATCH 'widened'`).all();
      expect(hit.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('repopulates the widened index from rows that predate the drift', () => {
    // Seeded without triggers: the wide TRIGGERS_SCHEMA cannot write to the narrow index
    // (that IS the defect), so the pre-drift row is only reachable if the recreated index
    // is rebuilt from the content table.
    seedDb({ ftsSchema: NARROW_FTS5_SCHEMA, withTriggers: false });
    const seed = new Database(dbPath);
    seed.prepare(INSERT_RESOURCE).run('preexisting');
    seed.close();

    const db = ensureRegistryDb(dbPath);
    try {
      const cols = db
        .prepare(`PRAGMA table_info(resources_fts)`)
        .all()
        .map((c) => c.name);
      expect(cols).toContain('name');
      // A recreated external-content index starts EMPTY; without a rebuild the old row
      // would be invisible to search forever.
      const hit = db.prepare(`SELECT rowid FROM resources_fts WHERE resources_fts MATCH 'preexisting'`).all();
      expect(hit.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('preserves the canonical FTS column ORDER (BM25 positional weights depend on it)', () => {
    // bm25(resources_fts, 3,3,3,2,2,1,1,1) in registry-retriever weights by POSITION, so a
    // reordered index silently mis-weights every search. Reorder counts as drift.
    const REORDERED = FTS5_SCHEMA.replace('    trigger_patterns,\n', '').replace(
      '    keywords,\n',
      '    keywords,\n    trigger_patterns,\n',
    );
    seedDb({ ftsSchema: REORDERED });
    const db = ensureRegistryDb(dbPath);
    try {
      const cols = db
        .prepare(`PRAGMA table_info(resources_fts)`)
        .all()
        .map((c) => c.name);
      expect(cols).toEqual([
        'trigger_patterns',
        'keywords',
        'capability_summary',
        'intent_tags',
        'use_cases',
        'domain_tags',
        'tech_stack',
        'name',
      ]);
    } finally {
      db.close();
    }
  });

  it('leaves a matching index alone — no needless drop/rebuild on every open', () => {
    seedDb();
    const seed = new Database(dbPath);
    seed.prepare(INSERT_RESOURCE).run('stable');
    seed.close();

    const db = ensureRegistryDb(dbPath);
    try {
      expect(db.prepare(`SELECT COUNT(*) c FROM resources`).get().c).toBe(1);
      const hit = db.prepare(`SELECT rowid FROM resources_fts WHERE resources_fts MATCH 'stable'`).all();
      expect(hit.length).toBe(1);
    } finally {
      db.close();
    }
  });
});
