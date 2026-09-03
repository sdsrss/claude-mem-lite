// claude-mem-lite: Resource registry database schema and CRUD operations
// Independent from schema.mjs (memory DB) — uses separate resource-registry.db

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { debugCatch, truncate } from './utils.mjs';

// ─── Schema ──────────────────────────────────────────────────────────────────

const RESOURCES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS resources (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL CHECK(type IN ('skill','agent')),
    status        TEXT NOT NULL DEFAULT 'active'
                  CHECK(status IN ('active','disabled','error','indexing')),
    source        TEXT NOT NULL CHECK(source IN ('preinstalled','user','github')),
    repo_url      TEXT,
    repo_stars    INTEGER DEFAULT 0,
    local_path    TEXT NOT NULL,
    file_hash     TEXT,
    parent_plugin TEXT,          -- unused, kept for schema compat
    invocation_name   TEXT DEFAULT '',
    intent_tags       TEXT DEFAULT '',
    domain_tags       TEXT DEFAULT '',
    action_type       TEXT DEFAULT '',
    trigger_patterns  TEXT DEFAULT '',
    capability_summary TEXT DEFAULT '',
    input_type    TEXT DEFAULT '',
    output_type   TEXT DEFAULT '',
    prerequisites TEXT DEFAULT '{}',
    keywords      TEXT DEFAULT '',
    tech_stack    TEXT DEFAULT '',
    use_cases     TEXT DEFAULT '',
    complexity    TEXT DEFAULT 'intermediate',
    category          TEXT,
    quality_tier      TEXT DEFAULT 'community',
    popularity_score  REAL DEFAULT 0,
    personal_score    REAL DEFAULT 0,
    recommend_count   INTEGER DEFAULT 0,
    adopt_count       INTEGER DEFAULT 0,
    weighted_adopt_sum REAL DEFAULT 0,
    success_count     INTEGER DEFAULT 0,
    silenced_until TEXT,
    cooldown_hours    INTEGER DEFAULT 0,
    recommendation_mode TEXT DEFAULT 'proactive',
    indexed_at    TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    enrichment_status TEXT DEFAULT NULL,
    enriched_at INTEGER DEFAULT NULL,
    repo_updated_at TEXT DEFAULT NULL,
    repo_forks INTEGER DEFAULT 0
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_res_type_name
    ON resources(type, name);

  CREATE INDEX IF NOT EXISTS idx_res_status
    ON resources(status) WHERE status = 'active';
`;

// Canonical FTS5 column order — all consumers must use this order.
// BM25 weights (positional): trigger_patterns(3), keywords(3), capability_summary(3),
//   intent_tags(2), use_cases(2), domain_tags(1), tech_stack(1), name(1)
//   — must match the bm25(resources_fts, 3,3,3,2,2,1,1,1) call in COMPOSITE_EXPR.
const FTS5_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS resources_fts USING fts5(
    trigger_patterns,
    keywords,
    capability_summary,
    intent_tags,
    use_cases,
    domain_tags,
    tech_stack,
    name,
    content=resources,
    content_rowid=id,
    tokenize='unicode61 remove_diacritics 2'
  );
`;

const TRIGGERS_SCHEMA = `
  CREATE TRIGGER IF NOT EXISTS res_fts_insert AFTER INSERT ON resources BEGIN
    INSERT INTO resources_fts(rowid, trigger_patterns, keywords, capability_summary,
      intent_tags, use_cases, domain_tags, tech_stack, name)
    VALUES (NEW.id, NEW.trigger_patterns, NEW.keywords, NEW.capability_summary,
      NEW.intent_tags, NEW.use_cases, NEW.domain_tags, NEW.tech_stack, NEW.name);
  END;

  CREATE TRIGGER IF NOT EXISTS res_fts_update AFTER UPDATE ON resources BEGIN
    INSERT INTO resources_fts(resources_fts, rowid, trigger_patterns, keywords,
      capability_summary, intent_tags, use_cases, domain_tags, tech_stack, name)
    VALUES ('delete', OLD.id, OLD.trigger_patterns, OLD.keywords, OLD.capability_summary,
      OLD.intent_tags, OLD.use_cases, OLD.domain_tags, OLD.tech_stack, OLD.name);
    INSERT INTO resources_fts(rowid, trigger_patterns, keywords, capability_summary,
      intent_tags, use_cases, domain_tags, tech_stack, name)
    VALUES (NEW.id, NEW.trigger_patterns, NEW.keywords, NEW.capability_summary,
      NEW.intent_tags, NEW.use_cases, NEW.domain_tags, NEW.tech_stack, NEW.name);
  END;

  CREATE TRIGGER IF NOT EXISTS res_fts_delete AFTER DELETE ON resources BEGIN
    INSERT INTO resources_fts(resources_fts, rowid, trigger_patterns, keywords,
      capability_summary, intent_tags, use_cases, domain_tags, tech_stack, name)
    VALUES ('delete', OLD.id, OLD.trigger_patterns, OLD.keywords, OLD.capability_summary,
      OLD.intent_tags, OLD.use_cases, OLD.domain_tags, OLD.tech_stack, OLD.name);
  END;
`;

const INVOCATIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS invocations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id   INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    session_id    TEXT,
    trigger       TEXT CHECK(trigger IN ('session_start','pre_tool_use','user_explicit','user_prompt')),
    tier          INTEGER CHECK(tier IN (1,2,3)),
    recommended   INTEGER DEFAULT 1,
    adopted       INTEGER DEFAULT 0,
    outcome       TEXT CHECK(outcome IN ('success','partial','failure','skipped','ignored') OR outcome IS NULL),
    score         REAL,
    rejection_reason TEXT CHECK(rejection_reason IN ('alternative','manual','context_switch','session_end','unknown','no_events','unclassified') OR rejection_reason IS NULL),
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_inv_resource
    ON invocations(resource_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_inv_session
    ON invocations(session_id);

  CREATE INDEX IF NOT EXISTS idx_inv_created_at
    ON invocations(created_at);
`;

// Canonical indexed-column list for resources_fts, in FTS5_SCHEMA order (see the BM25
// weight note above — order is load-bearing). Drift from this list triggers a rebuild.
const FTS5_COLUMNS = [
  'trigger_patterns', 'keywords', 'capability_summary', 'intent_tags',
  'use_cases', 'domain_tags', 'tech_stack', 'name',
];

const PREINSTALLED_SCHEMA = `
  CREATE TABLE IF NOT EXISTS preinstalled (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL CHECK(type IN ('skill','agent')),
    repo_url      TEXT NOT NULL,
    repo_path     TEXT DEFAULT '',
    stars         INTEGER DEFAULT 0,
    tags          TEXT DEFAULT '[]',
    enabled       INTEGER DEFAULT 1,
    cloned_at     TEXT,
    clone_hash    TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_pre_type_name
    ON preinstalled(type, name);
`;

// ─── Schema version ──────────────────────────────────────────────────────────

// Registry DB schema version. Tracked independently of schema.mjs's
// CURRENT_SCHEMA_VERSION — resource-registry.db is a separate file with its own
// migration history. v1 = the shape at the time version tracking was introduced; every
// pre-existing (un-versioned) registry in the wild ADOPTS v1 on first open, keeping its
// data. Bump when a migration below changes a layout an older binary would mis-handle.
export const REGISTRY_SCHEMA_VERSION = 1;

/**
 * Forward-incompatibility guard, mirroring initSchema's in schema.mjs. If a NEWER
 * claude-mem-lite wrote this registry, this (older) build re-applying its own migrations
 * over the newer layout corrupts it silently. Throw instead. MUST run before any DDL so
 * a newer DB is left untouched.
 * @param {Database} db
 */
function assertRegistryNotNewer(db) {
  let row;
  try {
    row = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
  } catch {
    return; // table absent = pre-version DB → adopted (stamped) at the end of init
  }
  if (row && typeof row.version === 'number' && row.version > REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `Registry DB schema is v${row.version} but this claude-mem-lite binary supports up to v${REGISTRY_SCHEMA_VERSION}. ` +
      `A newer version wrote this DB; upgrade claude-mem-lite (npm i -g claude-mem-lite@latest) or point CLAUDE_MEM_DIR to a fresh directory.`
    );
  }
}

/**
 * Column-drift self-heal for resources_fts. Deliberately NOT routed through the exported
 * ensureFTS in schema.mjs: that helper creates the index without this one's `tokenize=`
 * clause, and installs `<table>_ai/_ad/_au` triggers that would double-write alongside
 * the res_fts_* set here. Its drift check also compares column SETS, while resources_fts
 * is order-sensitive (registry-retriever's bm25(resources_fts, 3,3,3,2,2,1,1,1) weights
 * by position). Mirrors ensureEventsFTS in schema.mjs, which exists for the same reason.
 *
 * Without this, widening FTS5_SCHEMA leaves existing DBs on the NARROW index while
 * TRIGGERS_SCHEMA is re-exec'd from the wider list on every open — so every
 * `INSERT INTO resources` throws "no column named X" and the write is silently lost.
 * @param {Database} db
 * @returns {boolean} true if the index was recreated (caller must repopulate it)
 */
function ensureResourcesFts(db) {
  const ftsRow = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='resources_fts'`).get();
  let recreated = false;
  if (ftsRow) {
    let existingCols = [];
    try { existingCols = db.prepare(`PRAGMA table_info(resources_fts)`).all().map(c => c.name); }
    catch { /* unreadable → treat as drifted, recreate */ }
    // Element-wise so additions, removals AND reordering all count as drift.
    const drifted = existingCols.length !== FTS5_COLUMNS.length
      || FTS5_COLUMNS.some((c, i) => existingCols[i] !== c);
    if (drifted) {
      db.exec(`DROP TRIGGER IF EXISTS res_fts_insert`);
      db.exec(`DROP TRIGGER IF EXISTS res_fts_update`);
      db.exec(`DROP TRIGGER IF EXISTS res_fts_delete`);
      db.exec(`DROP TABLE IF EXISTS resources_fts`);
      recreated = true;
    }
  }
  if (!ftsRow || recreated) db.exec(FTS5_SCHEMA);
  return recreated;
}

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize registry database with all tables and FTS5.
 * Idempotent — safe to call multiple times.
 * @param {string} dbPath Path to resource-registry.db
 * @returns {Database} Opened database instance
 */
export function ensureRegistryDb(dbPath) {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // 5000ms to match the main DB: registry writes (install indexing rewriting
  // resources + resources_fts) race shadow-recommend writes + mem_registry reads
  // on the same file; 3000ms was insufficient under that concurrency (schema.mjs).
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Before ANY DDL: refuse a registry written by a newer client (see assertRegistryNotNewer).
  // Close the handle on the way out so the caller isn't left leaking an open file.
  try { assertRegistryNotNewer(db); } catch (e) { db.close(); throw e; }

  db.exec(RESOURCES_SCHEMA);

  // Migrate: add missing columns to resources (single PRAGMA call for all)
  try {
    const resCols = new Set(db.prepare("PRAGMA table_info(resources)").all().map(c => c.name));
    if (!resCols.has('invocation_name')) db.exec("ALTER TABLE resources ADD COLUMN invocation_name TEXT DEFAULT ''");
    if (!resCols.has('silenced_until')) db.exec("ALTER TABLE resources ADD COLUMN silenced_until TEXT");
    if (!resCols.has('cooldown_hours')) db.exec("ALTER TABLE resources ADD COLUMN cooldown_hours INTEGER DEFAULT 0");
    // recommendation_mode: 'proactive' (default, actively recommended), 'on_request' (only when explicitly asked)
    if (!resCols.has('recommendation_mode')) db.exec("ALTER TABLE resources ADD COLUMN recommendation_mode TEXT DEFAULT 'proactive'");
    // weighted_adopt_sum: continuous adoption score accumulator (vs binary adopt_count)
    if (!resCols.has('weighted_adopt_sum')) db.exec("ALTER TABLE resources ADD COLUMN weighted_adopt_sum REAL DEFAULT 0");
    // Phase 2: Registry optimization columns
    if (!resCols.has('category')) db.exec("ALTER TABLE resources ADD COLUMN category TEXT");
    if (!resCols.has('quality_tier')) db.exec("ALTER TABLE resources ADD COLUMN quality_tier TEXT DEFAULT 'community'");
    if (!resCols.has('popularity_score')) db.exec("ALTER TABLE resources ADD COLUMN popularity_score REAL DEFAULT 0");
    if (!resCols.has('personal_score')) db.exec("ALTER TABLE resources ADD COLUMN personal_score REAL DEFAULT 0");
    if (!resCols.has('enrichment_status')) db.exec("ALTER TABLE resources ADD COLUMN enrichment_status TEXT DEFAULT NULL");
    if (!resCols.has('enriched_at')) db.exec("ALTER TABLE resources ADD COLUMN enriched_at INTEGER DEFAULT NULL");
    if (!resCols.has('repo_updated_at')) db.exec("ALTER TABLE resources ADD COLUMN repo_updated_at TEXT DEFAULT NULL");
    if (!resCols.has('repo_forks')) db.exec("ALTER TABLE resources ADD COLUMN repo_forks INTEGER DEFAULT 0");
    // Auto-set quality_tier for installed preinstalled resources
    db.exec("UPDATE resources SET quality_tier = 'installed' WHERE source = 'preinstalled' AND quality_tier = 'community'");
  } catch (e) { debugCatch(e, 'resources-column-migration'); }

  // Migrate: add 'github' to source CHECK constraint (required for smart import)
  // Must disable FK checks during table recreation (RENAME triggers FK validation).
  // legacy_alter_table=ON is REQUIRED: under modern SQLite (the better-sqlite3
  // default) `ALTER TABLE resources RENAME TO resources_old` rewrites child-table FK
  // references, so invocations.resource_id would become `REFERENCES resources_old`
  // and the trailing DROP would leave it dangling — silently killing every future
  // `INSERT INTO invocations` (audit P0 #1). Legacy mode keeps child FKs pointing at
  // the original name, which the freshly-created `resources` table then satisfies.
  let resourcesRebuilt = false;
  try {
    const resSchema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='resources'`).get();
    if (resSchema?.sql && !resSchema.sql.includes("'github'")) {
      db.pragma('foreign_keys = OFF');
      db.pragma('legacy_alter_table = ON');
      try {
        db.transaction(() => {
          const hasOld = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='resources_old'`).get();
          if (hasOld) db.exec(`DROP TABLE resources_old`);
          // Drop FTS triggers first (reference resources table)
          db.exec(`DROP TRIGGER IF EXISTS res_fts_insert`);
          db.exec(`DROP TRIGGER IF EXISTS res_fts_update`);
          db.exec(`DROP TRIGGER IF EXISTS res_fts_delete`);
          db.exec(`ALTER TABLE resources RENAME TO resources_old`);
          db.exec(RESOURCES_SCHEMA);
          // Copy all existing data
          const cols = db.prepare("PRAGMA table_info(resources_old)").all().map(c => c.name);
          const newCols = new Set(db.prepare("PRAGMA table_info(resources)").all().map(c => c.name));
          const common = cols.filter(c => newCols.has(c)).join(', ');
          db.exec(`INSERT INTO resources (${common}) SELECT ${common} FROM resources_old`);
          db.exec(`DROP TABLE resources_old`);
          // Recreate the table's indexes: the CREATE INDEX IF NOT EXISTS inside
          // RESOURCES_SCHEMA above was SKIPPED while resources_old still held the
          // index names, so the rebuilt table had NONE — including the UNIQUE
          // idx_res_type_name that upsertResource's ON CONFLICT(type,name) requires
          // (review HIGH-1; pre-existing, closed here). Names are free post-DROP.
          db.exec(RESOURCES_SCHEMA);
        })();
      } finally {
        db.pragma('legacy_alter_table = OFF');
        db.pragma('foreign_keys = ON');
      }
      resourcesRebuilt = true;
    }
  } catch (e) { debugCatch(e, 'resources-source-check-migration'); }

  // FTS5: create if absent, or drop+recreate if the indexed columns have drifted from
  // FTS5_COLUMNS (a stale narrow index silently kills every resources write — audit P2-6).
  const ftsRecreated = ensureResourcesFts(db);
  // Triggers: always ensure (IF NOT EXISTS) — fixes DBs where FTS5 was created without
  // triggers, and reinstates the set ensureResourcesFts drops on drift.
  db.exec(TRIGGERS_SCHEMA);

  // The source-CHECK migration replaced the `resources` content table out from under
  // the external-content FTS index (content=resources), leaving resources_fts stale.
  // Rebuild it so a later DELETE's res_fts_delete trigger doesn't throw "database disk
  // image is malformed" against the mismatched index. Gated on the migration actually
  // having run so we don't rebuild on every open. A drift-recreated index needs the same
  // repopulation for the opposite reason: it starts EMPTY, so rows written before the
  // drift would be unreachable through search forever.
  if (resourcesRebuilt || ftsRecreated) {
    try { db.exec("INSERT INTO resources_fts(resources_fts) VALUES('rebuild')"); }
    catch (e) { debugCatch(e, 'resources-fts-rebuild-after-source-check'); }
  }

  db.exec(INVOCATIONS_SCHEMA);

  // Migrate invocations CHECK constraint: add 'user_prompt' trigger value
  // SQLite cannot ALTER CHECK constraints, so recreate table if needed
  try {
    const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='invocations'`).get();
    if (schema?.sql && !schema.sql.includes('user_prompt')) {
      db.transaction(() => {
        // Clean up leftover from previous failed migration attempt
        const hasOld = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='invocations_old'`).get();
        if (hasOld) db.exec(`DROP TABLE invocations_old`);
        db.exec(`ALTER TABLE invocations RENAME TO invocations_old`);
        db.exec(INVOCATIONS_SCHEMA);
        // Omit rejection_reason — column may not exist yet on old DBs; ADD COLUMN migration below handles it
          db.exec(`INSERT INTO invocations
          (id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at)
          SELECT id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at
          FROM invocations_old`);
        db.exec(`DROP TABLE invocations_old`);
      })();
    }
  } catch (e) { debugCatch(e, 'ensureRegistryDb-migration'); }

  // Migrate invocations CHECK constraint: add 'ignored' outcome value
  try {
    const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='invocations'`).get();
    if (schema?.sql && !schema.sql.includes("'ignored'")) {
      db.transaction(() => {
        const hasOld = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='invocations_old'`).get();
        if (hasOld) db.exec(`DROP TABLE invocations_old`);
        db.exec(`ALTER TABLE invocations RENAME TO invocations_old`);
        db.exec(INVOCATIONS_SCHEMA);
        // Omit rejection_reason — column may not exist yet on old DBs; ADD COLUMN migration below handles it
        db.exec(`INSERT INTO invocations
          (id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at)
          SELECT id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at
          FROM invocations_old`);
        db.exec(`DROP TABLE invocations_old`);
      })();
    }
  } catch (e) { debugCatch(e, 'ensureRegistryDb-ignored-migration'); }

  // Migrate: add rejection_reason column if missing
  try {
    const cols = db.prepare("PRAGMA table_info(invocations)").all();
    if (!cols.some(c => c.name === 'rejection_reason')) {
      db.exec("ALTER TABLE invocations ADD COLUMN rejection_reason TEXT");
    }
  } catch (e) { debugCatch(e, 'rejection_reason-migration'); }

  // Migrate: add ON DELETE CASCADE to invocations.resource_id (audit P0 #4). Old DBs
  // declared the FK with no ON DELETE action, so deleting a resource that had
  // invocation history threw SQLITE_CONSTRAINT_FOREIGNKEY (registry remove /
  // mem_registry delete) or silently no-op'd (dead-repo purge). SQLite can't ALTER an
  // FK, so rebuild the table. Renaming the CHILD table is safe (nothing references
  // invocations), so legacy_alter_table is not a concern here. Runs after the
  // rejection_reason ADD COLUMN so the column exists in both old and new tables.
  try {
    const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='invocations'`).get();
    if (schema?.sql && !/ON DELETE CASCADE/i.test(schema.sql)) {
      db.transaction(() => {
        const hasOld = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='invocations_old'`).get();
        if (hasOld) db.exec(`DROP TABLE invocations_old`);
        db.exec(`ALTER TABLE invocations RENAME TO invocations_old`);
        db.exec(INVOCATIONS_SCHEMA);
        // Omit rejection_reason from the copy (matching the CHECK migrations above):
        // it was historically a bare TEXT with NO CHECK, so an old row could hold a
        // value outside INVOCATIONS_SCHEMA's current rejection_reason CHECK whitelist.
        // Copying it would throw SQLITE_CONSTRAINT_CHECK → rollback → the FK is left
        // un-cascaded forever and every retry re-fails (review HIGH-2). The column is
        // never written at runtime, so copied rows get NULL — no data loss.
        db.exec(`INSERT INTO invocations
          (id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at)
          SELECT id, resource_id, session_id, trigger, tier, recommended, adopted, outcome, score, created_at
          FROM invocations_old`);
        db.exec(`DROP TABLE invocations_old`);
        // Recreate the table's indexes — the INVOCATIONS_SCHEMA CREATE INDEX above was
        // skipped while invocations_old held the names (review HIGH-1). Free post-DROP.
        db.exec(INVOCATIONS_SCHEMA);
      })();
    }
  } catch (e) { debugCatch(e, 'invocations-ondelete-cascade-migration'); }

  // (Removed the separate idx_invocations_resource_created migration — it was a column-
  // identical duplicate of idx_inv_resource (resource_id, created_at) in INVOCATIONS_SCHEMA.
  // It only ever survived because the rebuild migrations dropped idx_inv_resource; now that
  // the rebuilds recreate their indexes (review HIGH-1), the duplicate is pure dead weight.
  // Pre-existing DBs keep their old idx_invocations_resource_created; it's harmless.)

  db.exec(PREINSTALLED_SCHEMA);

  // Stamp the version LAST — only after every table + migration above succeeded. This is
  // also the ADOPTION path for pre-version DBs: they are stamped in place, never wiped or
  // refused. Rewritten each open so exactly one row exists and it reflects this build.
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  db.transaction(() => {
    db.exec('DELETE FROM schema_version');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(REGISTRY_SCHEMA_VERSION);
  })();

  return db;
}

// ─── Exported Schema (test-helpers.mjs, and scripts/index-managed.mjs since P1-16, which
// rebuilds resources_fts from scratch and used to carry its own copy of both blocks) ──

export { RESOURCES_SCHEMA, FTS5_SCHEMA, TRIGGERS_SCHEMA, INVOCATIONS_SCHEMA, PREINSTALLED_SCHEMA };

// ─── Resource CRUD ───────────────────────────────────────────────────────────

const UPSERT_SQL = `
  INSERT INTO resources (name, type, status, source, repo_url, repo_stars, local_path, file_hash,
    invocation_name, intent_tags, domain_tags, action_type, trigger_patterns, capability_summary,
    input_type, output_type, prerequisites, keywords, tech_stack, use_cases, complexity,
    indexed_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(type, name) DO UPDATE SET
    status=excluded.status, source=excluded.source,
    -- Preserve-on-empty (mirror the FTS text columns below): a PARTIAL re-upsert defaults
    -- repo_url/local_path to null/'' in the caller (import is the only edit path). Clobbering
    -- them ORPHANS the resource — mem_use/enrich read local_path (NOT NULL, so '' passes the
    -- constraint and silently breaks reads), and the scanner needs local_path to disable it.
    repo_url=CASE WHEN excluded.repo_url != '' THEN excluded.repo_url ELSE repo_url END,
    repo_stars=CASE WHEN excluded.repo_stars > 0 THEN excluded.repo_stars ELSE repo_stars END,
    local_path=CASE WHEN excluded.local_path != '' THEN excluded.local_path ELSE local_path END,
    file_hash=CASE WHEN excluded.file_hash IS NOT NULL AND excluded.file_hash != '' THEN excluded.file_hash ELSE file_hash END,
    invocation_name=CASE WHEN excluded.invocation_name != '' THEN excluded.invocation_name ELSE invocation_name END,
    -- Preserve-on-empty (mirror repo_stars/invocation_name above): a PARTIAL re-upsert --
    -- e.g. "registry import --name X --capability-summary ...", where mem-cli defaults every
    -- other flag to '' -- must NOT blank the FTS text columns and silently drop the resource
    -- out of search (import is the ONLY registry edit path; there is no update subcommand).
    -- Full upserts are unaffected: every field is non-empty, so the CASE picks excluded.
    intent_tags=CASE WHEN excluded.intent_tags != '' THEN excluded.intent_tags ELSE intent_tags END,
    domain_tags=CASE WHEN excluded.domain_tags != '' THEN excluded.domain_tags ELSE domain_tags END,
    action_type=CASE WHEN excluded.action_type != '' THEN excluded.action_type ELSE action_type END,
    trigger_patterns=CASE WHEN excluded.trigger_patterns != '' THEN excluded.trigger_patterns ELSE trigger_patterns END,
    capability_summary=CASE WHEN excluded.capability_summary != '' THEN excluded.capability_summary ELSE capability_summary END,
    input_type=CASE WHEN excluded.input_type != '' THEN excluded.input_type ELSE input_type END,
    output_type=CASE WHEN excluded.output_type != '' THEN excluded.output_type ELSE output_type END,
    -- Preserve-on-empty (same class as the FTS text columns above): a partial re-import
    -- omits prerequisites/complexity, so upsertResource supplies their DEFAULTS ('{}' /
    -- 'intermediate'). No CLI flag sets these (only a full re-index does), so treating the
    -- default as the "absent" sentinel is safe: a real re-index sends non-default values,
    -- which still overwrite; a metadata edit sends the default, which now preserves.
    prerequisites=CASE WHEN excluded.prerequisites NOT IN ('', '{}') THEN excluded.prerequisites ELSE prerequisites END,
    keywords=CASE WHEN excluded.keywords != '' THEN excluded.keywords ELSE keywords END,
    tech_stack=CASE WHEN excluded.tech_stack != '' THEN excluded.tech_stack ELSE tech_stack END,
    use_cases=CASE WHEN excluded.use_cases != '' THEN excluded.use_cases ELSE use_cases END,
    complexity=CASE WHEN excluded.complexity NOT IN ('', 'intermediate') THEN excluded.complexity ELSE complexity END,
    indexed_at=excluded.indexed_at, updated_at=datetime('now')
`;

/**
 * Insert or update a resource. Idempotent via UPSERT on (type, name).
 * @param {Database} db Registry database
 * @param {object} r Resource object
 * @returns {number} Resource ID
 */
export function upsertResource(db, r) {
  return db.transaction(() => {
    db.prepare(UPSERT_SQL).run(
      r.name, r.type, r.status || 'active', r.source || 'preinstalled',
      r.repo_url || null, r.repo_stars || 0, r.local_path,
      r.file_hash || null, r.invocation_name || '',
      r.intent_tags || '', r.domain_tags || '',
      r.action_type || '', r.trigger_patterns || '', r.capability_summary || '',
      r.input_type || '', r.output_type || '', r.prerequisites || '{}',
      r.keywords || '', r.tech_stack || '', r.use_cases || '', r.complexity || 'intermediate',
      r.indexed_at || null
    );
    const row = db.prepare('SELECT id FROM resources WHERE type = ? AND name = ?').get(r.type, r.name);
    return row?.id || 0;
  })();
}

// ─── P2-12: registry stats/list twin cores (audit 2026-08-14) ────────────────
// The five stats statements + the list row line were duplicated in mem-cli.mjs
// and server.mjs and had already drifted (truncate 50 vs 80; `adopt:null` on
// one face; the COALESCE ordering fix landed on the MCP face only). Data
// collection + row-line shape live here; faces keep their own headers/limits.

/**
 * Collect the five stat groups the `registry stats` twin renders.
 * @param {import('better-sqlite3').Database} rdb registry DB handle
 * @returns {{total:number, byType:Array<{type:string,c:number}>, topAdopted:object[], zeroAdopt:number, userAdded:number}}
 */
export function collectRegistryStats(rdb) {
  const total = rdb.prepare('SELECT COUNT(*) as c FROM resources WHERE status = ?').get('active');
  const byType = rdb.prepare('SELECT type, COUNT(*) as c FROM resources WHERE status = ? GROUP BY type').all('active');
  const topAdopted = rdb.prepare(
    'SELECT name, type, adopt_count, recommend_count FROM resources WHERE status = ? AND adopt_count > 0 ORDER BY adopt_count DESC LIMIT 10'
  ).all('active');
  const zeroAdopt = rdb.prepare(
    'SELECT COUNT(*) as c FROM resources WHERE status = ? AND recommend_count > 0 AND adopt_count = 0'
  ).get('active');
  const userAdded = rdb.prepare(
    "SELECT COUNT(*) as c FROM resources WHERE status = ? AND source = 'user'"
  ).get('active');
  return { total: total.c, byType, topAdopted, zeroAdopt: zeroAdopt.c, userAdded: userAdded.c };
}

/**
 * Ranked resource listing for the `registry list` twin: adoption first, then
 * recommendation, NULL counts coalesced (the un-coalesced face sorted NULLs
 * apart AND rendered "adopt:null").
 * @param {import('better-sqlite3').Database} rdb
 * @param {{type?: string}} [opts]
 * @returns {object[]}
 */
export function listResourcesRanked(rdb, { type } = {}) {
  const where = type ? 'WHERE type = ? AND status = ?' : 'WHERE status = ?';
  const params = type ? [type, 'active'] : ['active'];
  return rdb.prepare(`
    SELECT name, type, invocation_name, recommend_count, adopt_count, capability_summary
    FROM resources ${where}
    ORDER BY COALESCE(adopt_count, 0) DESC, COALESCE(recommend_count, 0) DESC, type, name
  `).all(...params);
}

/** One list row, shared shape: `S name (invocation) — rec:N adopt:N — summary…` (80-char summary cap).
 *  truncate(), not a hand-rolled slice (adversarial review 2026-08-16): the shared
 *  helper flattens newlines (this is a one-row-per-resource listing) and never
 *  splits a UTF-16 surrogate pair — a bare slice emitted lone surrogates. */
export function formatRegistryListLine(r) {
  return `${r.type === 'skill' ? 'S' : 'A'} ${r.name}${r.invocation_name ? ` (${r.invocation_name})` : ''} — rec:${r.recommend_count ?? 0} adopt:${r.adopt_count ?? 0} — ${truncate(r.capability_summary || '', 80)}`;
}
