// claude-mem-lite shared database schema and initialization
// Used by both server.mjs (MCP process) and hook.mjs (hook process)
// Ensures DB + tables exist regardless of which process starts first

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, chmodSync } from 'fs';
import { OBS_FTS_COLUMNS, debugCatch } from './utils.mjs';
import { resolveDataDir } from './lib/resolve-data-dir.mjs';

// DATA location — DB, managed resources, registry DB, runtime/. Honors
// CLAUDE_MEM_DIR so users can relocate state to a larger/faster volume.
export const DB_DIR = resolveDataDir(process.env.CLAUDE_MEM_DIR);
export const DB_PATH = join(DB_DIR, 'claude-mem-lite.db');
export const REGISTRY_DB_PATH = join(DB_DIR, 'resource-registry.db');
// CODE / install location — server.mjs, hook.mjs, cli.mjs, package.json live
// here. ALWAYS homedir-rooted: Claude Code's settings.json + MCP registration
// bake ABSOLUTE paths to server.mjs/hooks, so the code must NOT follow the
// CLAUDE_MEM_DIR relocation env var (mirrors install.mjs INSTALL_DIR). Equals
// DB_DIR when CLAUDE_MEM_DIR is unset — the common, non-relocated case.
export const CODE_DIR = join(homedir(), '.claude-mem-lite');

// Increment when schema changes (tables, columns, indexes, FTS, migrations)
//
// v27 (v2.41): observations_au / session_summaries_au / user_prompts_au
// triggers scoped to FTS-indexed columns via `AFTER UPDATE OF <cols>`. Before
// v27 the _au triggers fired on ANY row UPDATE — access_count / injection_count
// / last_accessed_at bumps (#8100 separation notwithstanding) caused wasted
// FTS delete+reinsert cycles and amplified SQLITE_CORRUPT_VTAB blast radius
// (project_non_obvious.md). Migration drops the old triggers once and lets
// ensureFTS recreate them with the scoped form.
//
// v28 (v2.47): observation_vectors orphan + stale-vocab cleanup. Live DBs had
// 2839/6429 (44%) orphaned rows (historic deletes during FK-OFF migrations)
// and 3282/6429 (51%) stale-vocab rows (rebuildVocabulary never pruned old
// versions before v2.47). Idempotent one-shot DELETE on ensureDb.
//
// v29 (v2.57.x): (1) sdk_sessions_id_invariant trigger guarding the v2.33.1
// mix pattern (memory_session_id and content_session_id must not be the same
// non-null value — they're different ID schemes). (2) lesson_retry_stats
// aggregate table tracking how often hook-llm.mjs retry path actually
// recovers a lesson (vs being a wasted Haiku call). Both purely additive.
//
// v30 (v2.57.x patch): trigger body fix — UUID-shape gate so test fixtures
// using short literal IDs ('sess-1') don't trigger. Initial v29 trigger
// fired on any equal non-null pair, breaking 60+ test scaffolds that write
// the same literal to both columns by helper convention. v30 forces
// DROP+CREATE so DBs that picked up the strict v29 trigger get the UUID-
// gated body. Required because `CREATE TRIGGER IF NOT EXISTS` is a no-op
// when the trigger already exists, even with a different body.
// v31 (v2.70.0): deferred_work table — first-class carry-forward surface.
// Decoupled from observations: different decay semantics (no time decay; older
// items rank HIGHER as tech debt accumulates), different lifecycle (mutable
// status open→done|dropped vs immutable obs). Closure tied to obs via
// closed_by_obs_id FK with ON DELETE SET NULL (audit trail preserved).
// v32 (v2.73.2): citation-decay columns on observations — uncited_streak,
// cited_count, last_decided_session_id. Stop hook resolves injected obs as
// cited|uncited; 3 consecutive uncited → importance -1 (floor 0); 1 cited → +1
// (cap 3). last_decided_session_id makes Stop idempotent across multi-fire.
// v35 (v2.87.0): no DDL — version bumped only to force one full migration pass on
// existing DBs, which runs the one-shot observation_files orphan cleanup (and
// re-runs the v28 observation_vectors cleanup) to clear the backlog leaked while
// the warm-start fast-path left foreign_keys OFF. LATEST_MIGRATION_COLUMN is
// unchanged (no new column) — decay_seen_count still exists at v35.
// v36 (v2.89.0): no DDL — narrows events_fts_au to `AFTER UPDATE OF title, body`.
// The events FTS triggers (v2.31) were hand-written inline and inherited the
// pre-v27 broad `AFTER UPDATE ON events` form, so every importance / accessed_count
// / citation-decay bump thrashed events_fts (delete+reinsert) and reintroduced the
// SQLITE_CORRUPT_VTAB blast radius v27 fixed for the other FTS tables. Version
// bumped to force one migration pass; the conditional drop below replaces the
// legacy trigger on existing DBs. LATEST_MIGRATION_COLUMN unchanged (no new column).
// v37 (D#26): adds user_prompts.cc_session_id (additive, nullable). LATEST_MIGRATION_COLUMN
// MOVES to it so the half-migrated-DB self-heal fast-path covers the new column.
// v38 (R1): citation_log table — per-session invocation→cite funnel telemetry. One
// accumulating row per resolved session (injected_n / cited_n), written by
// recordCitationFunnel from applyCitationDecay's touched/promoted at Stop. Turns the
// per-obs cite counters (lifetime-cumulative) into a trendable per-session series so
// `citation-stats` can answer "is memory invocation effectiveness rising or falling".
// New TABLE (not a column) reached via CORE_SCHEMA's CREATE TABLE IF NOT EXISTS on the
// forced migration pass; LATEST_MIGRATION_COLUMN unchanged (no new column) — same
// pattern as v35/v36.
// v39 (audit P1-5): migration_cleanups table — a sentinel registry that makes the
// one-shot DATA cleanups (orphan deletes, project-name normalization) RETRYABLE.
// They previously ran inside the version-gated migration body and were swallowed
// on failure AFTER the version stamp committed, so a failed cleanup could never
// re-run (the fast-path then skipped the whole body). They now run via
// runDeferredCleanups() on every ensureDb, each gated by a done-marker row: a
// failure leaves the marker unset and retries on the next open. New TABLE via
// CORE_SCHEMA on the forced pass; LATEST_MIGRATION_COLUMN unchanged (no new
// column) — same pattern as v35/v36/v38.
// v40 (round-5 audit HIGH): forces one migration pass so the now column-aware ensureFTS
// widens any STALE FTS table on existing DBs. Early-adopter stores created before a column
// was added to an FTS list (session_summaries_fts predates `remaining_items`, v2.2.0) carried
// a narrow FTS table forever — the old ensureFTS only created a table when absent, never
// widened it — while its triggers were rebuilt with the current wider column list, so every
// session_summaries UPDATE threw "no column named remaining_items" and was silently swallowed
// (Haiku summary enrichment lost every session). Pure index reheal (no data migration, no
// column drop); idempotent. New behavior via the forced pass; LATEST_MIGRATION_COLUMN
// unchanged (no new column) — same pattern as v35/v36/v38/v39.
// v41 (cross-turn late-citation): adds observations.last_cited_session_id (additive,
// nullable) — the promote idempotency key, split from last_decided_session_id so a
// citation landing in a LATER turn of the same session can still upgrade a
// previously-uncited obs (see applyCitationDecay). REAL new column, so unlike v38-v40
// this DOES advance LATEST_MIGRATION_COLUMN (→ observations.last_cited_session_id);
// existing DBs reach the ALTER because version 40 != 41 falls through the fast-path.
// v42 (events_fts self-heal): events_fts was the one FTS table outside ensureFTS's
// column-aware recreation (its DDL is non-standard — UNINDEXED cols + custom tokenizer +
// events_fts_* trigger names — so it can't use the generic ensureFTS). Adds a dedicated
// ensureEventsFTS run in the migration body so a future events column addition self-heals
// instead of leaving a stale narrow index whose (wider) triggers throw "no column" and
// silently drop event writes. NO new column, so LATEST_MIGRATION_COLUMN is unchanged — the
// forced pass alone carries it (same pattern as v35/v36/v38/v39/v40); existing DBs run it
// because version 41 != 42 falls through the fast-path.
// v43 (D#78 edge attribution): adds 4 columns to observation_files so each
// (obs, file) trigger edge carries its own injection/citation record —
// inject_count, miss_streak, last_resolved_session_id, last_cited_session_id.
// Per-EDGE policy, deliberately separate from the per-obs decay counters on
// observations (#8641: the two encode different policies — an edge that stops
// firing must not bury the lesson on other surfaces). The ALTERs live NEXT TO
// the observation_files CREATE (initSchema body), NOT in MIGRATIONS[] — that
// array runs before the table exists on fresh DBs.
// v44 (D#78 P3 scope label): observations.scope (file|module|project|
// environment, NULL for legacy/manual rows) — where a lesson APPLIES,
// decoupled from which files the episode touched. SEPARATE version from v43
// on purpose: dev-mode hooks migrate the live DB between working-tree edits,
// and a two-table batch under ONE version left a real DB at "43 with edge
// columns, without scope" that the single sentinel could not detect (observed
// 2026-07-14 on this machine's own DB). One version per migration batch keeps
// the version number itself the detector. LATEST_MIGRATION_COLUMN advances to
// observations.scope.
// v45 (per-surface funnel): citation_surface_log — the same invocation→cite
// funnel as citation_log (v38) but split by INJECTION FACE. citation_log answers
// "is effectiveness rising or falling" for a project; it cannot answer "which
// face is burning the budget", because hook.mjs unions all four
// query-conditioned faces (pre-tool-recall / UserPromptSubmit <memory-context> /
// PostToolUse error-recall / user-prompt-search FYI) before anything is
// recorded. Without per-face cite-rate there is no evidence to aim any
// precision lever at, which is what gated D#44 and D#129's remaining legs.
// The two tables are NOT comparable in either direction and the readers say so
// out loud: an obs carried by two faces is counted in both rows (pushes the
// surface sum UP), while cite-back signals join citation_log's denominator
// without belonging to any face and without the mainOnly filter (pushes the
// aggregate UP). Neither is a partition of the other.
// Keyed on the CC session id, NOT the memory session id — see the DDL comment.
// The column was renamed memory_session_id -> session_id BEFORE v45 ever
// shipped (pre-tag review), so no released database carries the old shape and
// no rename migration exists; the sentinel stays on `surface`, which is a
// table-presence check either way.
// New TABLE (not a column) reached via CORE_SCHEMA's CREATE TABLE IF NOT EXISTS
// on the forced migration pass. UNLIKE v38/v39 this DOES register a sentinel
// (citation_surface_log.surface) in LATEST_MIGRATION_COLUMNS: a table that only
// the forced pass can create is unreachable forever once the version row says
// "done", which is not a hypothetical — see the note there.
// v47: two additive indexes (P2-11 + ALGO-7). The bump is LOAD-BEARING, not bookkeeping:
// `initSchema`'s fast path returns before the `CREATE INDEX IF NOT EXISTS` block, so on
// every existing install at v46 a new index there would simply never be created. Same trap
// the FTS5 migration hit — a DDL change that is not reachable from the version the DB
// already reports is a no-op with a convincing diff.
export const CURRENT_SCHEMA_VERSION = 47;

// Sentinel columns for the LATEST migration set(s). The fast-path uses these
// to self-heal half-migrated DBs — schema_version bumped but column ALTERs
// rolled back (observed once in dev during v2.74.0). Update the list when
// adding a new migration batch. Plural since v44 (review D#78): v43 and v44
// touch DIFFERENT tables, and a restore-from-old-backup can resurrect one
// table's pre-migration shape while the version row and the other table stay
// current — a single sentinel can't see that hole, so every recent batch
// keeps a representative column here until it is ancient enough to retire.
// A new TABLE needs an entry here just as much as a new COLUMN does, and v38/v39
// not having one is a latent hole, not a precedent: CORE_SCHEMA is reached ONLY
// on the forced pass, so if anything stamps the version without running it (a
// half-applied dev tree, an interrupted migration, a peer on a newer build), the
// fast-path returns forever and the table can never appear. Observed live during
// v45 development — the version bump and the CREATE landed in two edits, a hook
// fired between them, and the DB sat at v45 with no citation_surface_log while
// every reader silently swallowed "no such table" as "no data yet".
// pragma_table_info on a missing table returns zero rows (it does not throw), so
// naming any column of the new table is a table-presence check.
const LATEST_MIGRATION_COLUMNS = [
  { table: 'observations', column: 'decay_seen_at_first_cite' },   // v46
  { table: 'citation_surface_log', column: 'surface' },            // v45
  { table: 'observations', column: 'scope' },                      // v44
  { table: 'observation_files', column: 'last_cited_session_id' }, // v43
];

function hasLatestMigrationColumn(db) {
  try {
    const stmt = db.prepare(
      `SELECT 1 AS present FROM pragma_table_info(?) WHERE name = ?`
    );
    return LATEST_MIGRATION_COLUMNS.every(({ table, column }) => Boolean(stmt.get(table, column)));
  } catch {
    return false; // table itself missing → caller falls through to CORE_SCHEMA
  }
}

const CORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sdk_sessions (
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
  );

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    text TEXT,
    type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')), -- keep in sync with lib/obs-types.mjs OBS_TYPES (locked by tests/obs-types-invariant.test.mjs)
    title TEXT,
    subtitle TEXT,
    facts TEXT,
    narrative TEXT,
    concepts TEXT,
    files_read TEXT,
    files_modified TEXT,
    prompt_number INTEGER,
    discovery_tokens INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
  );

  CREATE TABLE IF NOT EXISTS session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    request TEXT,
    investigated TEXT,
    learned TEXT,
    completed TEXT,
    next_steps TEXT,
    files_read TEXT,
    files_edited TEXT,
    notes TEXT,
    prompt_number INTEGER,
    discovery_tokens INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT NOT NULL,
    prompt_text TEXT,
    prompt_number INTEGER,
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE ON UPDATE CASCADE
  );

  CREATE TABLE IF NOT EXISTS session_handoffs (
    project TEXT NOT NULL,
    type TEXT NOT NULL,
    session_id TEXT NOT NULL,
    working_on TEXT,
    completed TEXT,
    unfinished TEXT,
    key_files TEXT,
    key_decisions TEXT,
    match_keywords TEXT,
    created_at_epoch INTEGER,
    PRIMARY KEY (project, type, session_id)
  );

  CREATE TABLE IF NOT EXISTS citation_log (
    project TEXT NOT NULL,
    memory_session_id TEXT NOT NULL,
    resolved_at INTEGER,
    injected_n INTEGER NOT NULL DEFAULT 0,
    cited_n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project, memory_session_id)
  );

  -- v45: per-INJECTION-FACE twin of citation_log. One row per
  -- (project, session, surface); the surface column is one of the
  -- CITATION_SURFACES enum in lib/citation-tracker.mjs
  -- (pretool | ups | error_recall | fyi | task_imperative | keyctx | subagent). The column is plain
  -- TEXT with no CHECK: the JS enum is the gate (recordCitationSurfaces drops unknown
  -- labels), which is why adding a face needs no migration.
  --
  -- session_id is the CLAUDE CODE session id, NOT the memory session id that
  -- keys citation_log. The two tables therefore do NOT join, on purpose. The
  -- memory session id lives in one file per PROJECT (hook-shared session-<project>,
  -- 12h), so two concurrent CC sessions in one project share it -- which is
  -- survivable for citation_log because that table ACCUMULATES deltas, and
  -- destructive here because this one OVERWRITES: the second session's Stop
  -- would erase the first's counts. Same reasoning that moved applyCitationDecay
  -- onto the CC session id in D#60.
  --
  -- Overwrite (not accumulate) is correct for this table because its source --
  -- ONE CC session's transcript -- only ever grows, so a Stop re-fire recomputes
  -- the same-or-larger sets: idempotent by construction, and a cross-turn late
  -- citation raises cited_n without touching injected_n.
  CREATE TABLE IF NOT EXISTS citation_surface_log (
    project TEXT NOT NULL,
    session_id TEXT NOT NULL,
    surface TEXT NOT NULL,
    resolved_at INTEGER,
    injected_n INTEGER NOT NULL DEFAULT 0,
    cited_n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project, session_id, surface)
  );

  CREATE TABLE IF NOT EXISTS migration_cleanups (
    name TEXT PRIMARY KEY,
    done_at_epoch INTEGER NOT NULL
  );
`;

// Column migrations (idempotent — only swallow "duplicate column" errors)
const MIGRATIONS = [
  'ALTER TABLE observations ADD COLUMN importance INTEGER DEFAULT 1',
  'ALTER TABLE observations ADD COLUMN related_ids TEXT DEFAULT \'[]\'',
  'ALTER TABLE observations ADD COLUMN minhash_sig TEXT',
  'ALTER TABLE observations ADD COLUMN access_count INTEGER DEFAULT 0',
  'ALTER TABLE observations ADD COLUMN compressed_into INTEGER DEFAULT NULL',
  'ALTER TABLE session_summaries ADD COLUMN remaining_items TEXT',
  'ALTER TABLE observations ADD COLUMN lesson_learned TEXT DEFAULT NULL',
  'ALTER TABLE observations ADD COLUMN search_aliases TEXT DEFAULT NULL',
  'ALTER TABLE session_summaries ADD COLUMN lessons TEXT DEFAULT NULL',
  'ALTER TABLE session_summaries ADD COLUMN key_decisions TEXT DEFAULT NULL',
  'ALTER TABLE observations ADD COLUMN branch TEXT DEFAULT NULL',
  'ALTER TABLE observations ADD COLUMN superseded_at INTEGER DEFAULT NULL',
  'ALTER TABLE observations ADD COLUMN superseded_by INTEGER DEFAULT NULL',
  'ALTER TABLE observations ADD COLUMN last_accessed_at INTEGER DEFAULT NULL',
  'ALTER TABLE observations ADD COLUMN optimized_at INTEGER DEFAULT NULL',
  // v26 (P0 injection-noise): per-obs injection tracking for noise-ratio
  // penalty. injection_count bumps only on UserPromptSubmit / hook-memory
  // auto-injection (not on explicit recall/get/timeline — those keep bumping
  // access_count). Pair with access_count to compute noise ratio: high
  // injection_count + low access_count = low-signal, deprioritize.
  'ALTER TABLE observations ADD COLUMN injection_count INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE observations ADD COLUMN last_injected_at INTEGER DEFAULT NULL',
  // v32 (citation-decay): per-obs feedback loop for pre-tool-recall injection
  // pool. Stop hook resolves each session's injected IDs as cited|uncited.
  // 3 consecutive uncited sessions → importance -1 (floor 0). 1 cited session →
  // importance +1 (cap 3). last_decided_session_id makes Stop idempotent across
  // multi-fire scenarios (Claude may fire Stop more than once per session).
  'ALTER TABLE observations ADD COLUMN uncited_streak INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE observations ADD COLUMN cited_count INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE observations ADD COLUMN last_decided_session_id TEXT DEFAULT NULL',
  // v33 (citation-decay telemetry): timestamp of the most recent demote event.
  // Powers `claude-mem-lite citation-stats`'s "Recently demoted" section.
  // Set in applyCitationDecay's demote branch when streak hits threshold.
  // Single-shot (only the latest demote is preserved); use a decay_log table
  // if historical trend is ever needed.
  'ALTER TABLE observations ADD COLUMN demoted_at INTEGER DEFAULT NULL',
  // v34 (citation-decay denominator fix): per-obs counter of decay-loop
  // resolutions (cited + uncited paths). Used by citation-stats as the
  // denominator for "cite rate" — bumped only by applyCitationDecay, so it
  // doesn't get polluted by UserPromptSubmit / hook-memory injections that
  // share the unrelated injection_count column. Same-source numerator
  // (cited_count) + same-source denominator = meaningful ratio.
  'ALTER TABLE observations ADD COLUMN decay_seen_count INTEGER NOT NULL DEFAULT 0',
  // v37 (D#26 — parallel-session handoff content scoping): the Claude-Code session
  // UUID per user prompt. handleUserPrompt writes hookData.session_id here so
  // buildAndSaveHandoff can scope working_on to ONE CC session — concurrent (and
  // within-12h-TTL sequential) same-project sessions previously merged each other's
  // prompts because getSessionId() is project-scoped (no CC-UUID component). Nullable:
  // legacy rows + non-CC/no-stdin invocations read back NULL and the handoff falls
  // back to its legacy unfiltered query.
  'ALTER TABLE user_prompts ADD COLUMN cc_session_id TEXT DEFAULT NULL',
  // v41 (cross-turn late-citation): promote-idempotency key, split from
  // last_decided_session_id. applyCitationDecay guards the cited/promote branch on
  // THIS column so a citation in a LATER turn of the same session can still upgrade a
  // previously-uncited obs; the uncited/streak branch stays guarded on
  // last_decided_session_id (so it never double-streaks within a session). Nullable:
  // legacy rows read NULL and behave exactly as before until their first same-session
  // late cite.
  'ALTER TABLE observations ADD COLUMN last_cited_session_id TEXT DEFAULT NULL',
  // v44 (D#78 P3): lesson applicability scope — file | module | project |
  // environment, validated by lib/observation-write normalizeScope; NULL for
  // legacy rows / manual saves / events. CLAUDE_MEM_SCOPE_FILTER=1 (opt-in)
  // makes pre-tool-recall skip environment-scoped rows on file-triggered
  // injection; NULL always passes the filter.
  'ALTER TABLE observations ADD COLUMN scope TEXT DEFAULT NULL',
  // v46 (D#159): decay_seen_count AS IT STOOD when this observation was cited for
  // the FIRST time. The lifetime counters already on the row cannot answer the
  // question the "stop injecting a long-uncited memory" gate needs: measured
  // 2026-08-22, a candidate gate of `decay_seen >= 20 AND cited_count = 0` matched
  // 631 rows, while 331 of the 510 rows that HAVE been cited also carry a lifetime
  // decay_seen >= 20 — whether those crossed 20 before or after their first citation
  // is unrecoverable from cumulative counters, so the gate's false-kill rate is not
  // computable. This column makes it computable going forward.
  //
  // NULLABLE ON PURPOSE, and NULL is not 0: NULL means "never cited", 1 means "cited
  // on its very first decay resolution". A DEFAULT 0 would merge those two states and
  // destroy the distinction the column exists to record. Legacy rows stay NULL — they
  // are not evidence of anything and must not be read as first-cite-at-0.
  'ALTER TABLE observations ADD COLUMN decay_seen_at_first_cite INTEGER DEFAULT NULL',
];

/**
 * Apply full schema (tables, migrations, indexes, FTS5) to an opened DB instance.
 * Single source of truth for all schema setup — used by ensureDb() and tests.
 * The DB should have foreign_keys OFF before calling (enabled after dedup migration).
 */
export function initSchema(db) {
  // Fast path: skip all migrations if schema is already at current version.
  // Forward-incompat guard: if persisted version is NEWER than this build's
  // CURRENT_SCHEMA_VERSION, a newer claude-mem-lite wrote it; the current
  // (older) binary would silently re-apply old migrations over a newer layout.
  // Throw loudly instead — `claude-mem-lite doctor` / reinstall is the path.
  try {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
    if (row && typeof row.version === 'number') {
      // Self-heal: version-row says CURRENT but latest migration column may be
      // absent (rolled back / never applied). Fall through to migration apply
      // when the sentinel is missing — duplicates are caught in the loop.
      if (row.version === CURRENT_SCHEMA_VERSION && hasLatestMigrationColumn(db)) {
        // Warm-start post-condition: ensureDb() opened this handle with
        // foreign_keys=OFF (early migrations require cascade disabled). The full
        // migration path re-enables it at the end; this fast-path return must
        // match that post-condition, else every DELETE on the returned handle
        // skips ON DELETE CASCADE and silently orphans junction rows. Safe here:
        // no transaction is open yet (BEGIN IMMEDIATE is below).
        db.pragma('foreign_keys = ON');
        return db;
      }
      if (row.version > CURRENT_SCHEMA_VERSION) {
        throw new Error(
          `DB schema is v${row.version} but this claude-mem-lite binary supports up to v${CURRENT_SCHEMA_VERSION}. ` +
          `A newer version wrote this DB; upgrade claude-mem-lite (npm i -g claude-mem-lite@latest) or point CLAUDE_MEM_DIR to a fresh directory.`
        );
      }
    }
  } catch (e) {
    // schema_version table absent = first init — proceed to create it.
    // Real forward-incompat throw above must propagate.
    if (e.message?.startsWith('DB schema is v')) throw e;
  }

  // Concurrent-init guard: serialize schema setup against peer processes via
  // BEGIN IMMEDIATE (busy_timeout=3000 from ensureDb makes peers wait). Required
  // because the sdk_sessions_id_mix_check_{ai,au} migration uses DROP+CREATE
  // without IF NOT EXISTS to update the trigger body, which races at cold-start.
  // Re-check schema_version under the lock — a peer may have completed init
  // while we were blocked. Connection close auto-rollbacks if body throws.
  db.exec('BEGIN IMMEDIATE');
  try {
    const underlock = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
    if (underlock && underlock.version === CURRENT_SCHEMA_VERSION && hasLatestMigrationColumn(db)) {
      db.exec('COMMIT');
      // COMMIT closed the transaction, so this PRAGMA takes effect (no-op inside a txn).
      // Same FK post-condition as the fast-path above: a peer completed init while we
      // were blocked, so we skip migrations and must still restore cascade enforcement.
      db.pragma('foreign_keys = ON');
      return db;
    }
  } catch { /* table absent — proceed */ }

  // Create core tables
  db.exec(CORE_SCHEMA);

  // Run column migrations
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) {
      if (!e.message?.includes('duplicate column name')) throw e;
    }
  }

  // session_handoffs PK widen: (project, type) → (project, type, session_id)
  // Old PK assumed one session per project, causing cross-session handoff overwrite
  // (see docs/bug.txt). Rebuild table if still on old PK. Idempotent.
  try {
    const handoffDdl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='session_handoffs'`).get();
    const oldPk = handoffDdl && /PRIMARY KEY\s*\(\s*project\s*,\s*type\s*\)/i.test(handoffDdl.sql);
    if (oldPk) {
      const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE session_handoffs_new (
            project TEXT NOT NULL,
            type TEXT NOT NULL,
            session_id TEXT NOT NULL,
            working_on TEXT,
            completed TEXT,
            unfinished TEXT,
            key_files TEXT,
            key_decisions TEXT,
            match_keywords TEXT,
            created_at_epoch INTEGER,
            PRIMARY KEY (project, type, session_id)
          )
        `);
        db.exec(`
          INSERT INTO session_handoffs_new
            (project, type, session_id, working_on, completed, unfinished, key_files, key_decisions, match_keywords, created_at_epoch)
          SELECT project, type, session_id, working_on, completed, unfinished, key_files, key_decisions, match_keywords, created_at_epoch
          FROM session_handoffs
        `);
        db.exec(`DROP TABLE session_handoffs`);
        db.exec(`ALTER TABLE session_handoffs_new RENAME TO session_handoffs`);
      });
      rebuild();
    }
  } catch { /* non-critical — next open retries */ }

  // v25 (T10d): commit-anchored continuation — store HEAD sha at handoff time
  // so detectContinuationIntent can auto-confirm continuation when the working
  // tree hasn't moved since /exit or /clear. Runs AFTER the PK-widen rebuild
  // above so the new column is not clobbered by the DROP+CREATE path.
  try {
    const handoffCols = db.prepare(`PRAGMA table_info(session_handoffs)`).all().map(c => c.name);
    if (!handoffCols.includes('git_sha_at_handoff')) {
      db.exec(`ALTER TABLE session_handoffs ADD COLUMN git_sha_at_handoff TEXT DEFAULT NULL`);
    }
  } catch { /* non-critical — migration retries on next open */ }

  // Dedup migration: ensure memory_session_id is unique, then enable FK
  const hasIdx = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_sess_memory_sid'`).get();
  if (!hasIdx) {
    const dupes = db.prepare(`
      SELECT memory_session_id, COUNT(*) as cnt
      FROM sdk_sessions
      WHERE memory_session_id IS NOT NULL
      GROUP BY memory_session_id HAVING cnt > 1
    `).all();

    // Atomic: dedup + create unique index in one transaction
    const dedupAndIndex = db.transaction(() => {
      for (const { memory_session_id } of dupes) {
        const rows = db.prepare(`
          SELECT s.id FROM sdk_sessions s
          WHERE s.memory_session_id = ?
          ORDER BY s.id ASC
        `).all(memory_session_id);
        for (let i = 1; i < rows.length; i++) {
          db.prepare('DELETE FROM sdk_sessions WHERE id = ?').run(rows[i].id);
        }
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sess_memory_sid ON sdk_sessions(memory_session_id)`);
    });
    dedupAndIndex();
  }

  // Performance indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_epoch_project ON observations(created_at_epoch DESC, project)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sess_sum_epoch ON session_summaries(created_at_epoch DESC, project)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_project_epoch_minhash ON observations(project, created_at_epoch DESC) WHERE minhash_sig IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(content_session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_prompts_cc ON user_prompts(cc_session_id) WHERE cc_session_id IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_superseded ON observations(superseded_at) WHERE superseded_at IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_branch ON observations(branch) WHERE branch IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sdk_sessions(project)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_not_compressed ON observations(created_at_epoch DESC) WHERE COALESCE(compressed_into, 0) = 0`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_handoffs_project_time ON session_handoffs(project, type, created_at_epoch DESC)`);
  // v47 (audit 2026-09-02 P2-11 + the previous round's ALGO-7), one additive migration for
  // both. Additive only: new indexes on existing columns, no table rewrite, no data move.
  //
  // The first was the ONLY genuine full table scan in the 30 statements the audit ran
  // through EXPLAIN QUERY PLAN. Stop and SessionStart both probe "does a summary exist for
  // this memory session?", `session_summaries` is 10,160 rows here, and the cost grows
  // linearly with the table for a question asked on every hook event.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sess_sum_memory_session ON session_summaries(memory_session_id)`);
  // The second narrows the live-row scan the injection faces run per project. Partial on the
  // same predicate `liveObsFilterSql` uses, so the index covers exactly the rows those
  // queries can return.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_project_live ON observations(project, created_at_epoch DESC) WHERE superseded_at IS NULL AND COALESCE(compressed_into, 0) = 0`);

  // FTS5 migration: recreate observations_fts when columns are missing (one-time)
  // Detect old FTS5 table missing lesson_learned or search_aliases and recreate with full column set
  let obsFtsRecreated = false;
  try {
    const ftsDdl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='observations_fts'`).get();
    if (ftsDdl && (!ftsDdl.sql.includes('lesson_learned') || !ftsDdl.sql.includes('search_aliases'))) {
      db.exec(`DROP TRIGGER IF EXISTS observations_ai`);
      db.exec(`DROP TRIGGER IF EXISTS observations_ad`);
      db.exec(`DROP TRIGGER IF EXISTS observations_au`);
      db.exec(`DROP TABLE IF EXISTS observations_fts`);
      obsFtsRecreated = true;
    }
  } catch { /* non-critical — ensureFTS will create if missing */ }

  // v27 migration: drop legacy _au triggers that fire on ANY row UPDATE so
  // ensureFTS reinstates them with `AFTER UPDATE OF <fts_cols>`. Trigger fires
  // only when FTS-indexed columns change after this migration — access_count
  // / injection_count / last_accessed_at bumps no longer thrash the FTS index.
  // Conditional per #7647: only drop when the stored DDL lacks the scoped
  // `UPDATE OF` clause (handles re-run + fresh-DB cases).
  for (const [trg, tbl] of [
    ['observations_au',      'observations'],
    ['session_summaries_au', 'session_summaries'],
    ['user_prompts_au',      'user_prompts'],
  ]) {
    try {
      const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?`).get(trg);
      if (row && row.sql && !/\bAFTER\s+UPDATE\s+OF\s+/i.test(row.sql)) {
        db.exec(`DROP TRIGGER IF EXISTS ${tbl}_au`);
      }
    } catch { /* non-critical — ensureFTS will recreate */ }
  }

  // FTS5 full-text search tables + triggers (idempotent)
  ensureFTS(db, 'observations_fts', 'observations', OBS_FTS_COLUMNS);
  ensureFTS(db, 'session_summaries_fts', 'session_summaries', ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes', 'remaining_items']);
  ensureFTS(db, 'user_prompts_fts', 'user_prompts', ['prompt_text']);

  // Rebuild FTS5 if we just recreated it above (the new index is empty and must be
  // populated from the content table). The old emptiness probe — `SELECT COUNT(*) FROM
  // observations_fts` — was DEAD: for an external-content FTS5 table, COUNT reads the
  // CONTENT table (observations), not the index, so `ftsCount === 0` was only ever true
  // on an empty DB (where needsRebuild>0 is false). The rebuild therefore never fired and
  // full-text search silently returned 0 rows after the column-mismatch migration. Gate
  // on the recreation flag instead, which is the only path that leaves the index empty.
  if (obsFtsRecreated) {
    try {
      const cnt = db.prepare(`SELECT COUNT(*) as cnt FROM observations`).get();
      if (cnt.cnt > 0) db.exec(`INSERT INTO observations_fts(observations_fts) VALUES('rebuild')`);
    } catch { /* non-critical */ }
  }

  // v36 migration: narrow events_fts_au like the v27 fix above. The events FTS
  // triggers were hand-written inline (below) rather than via ensureFTS, so
  // events_fts_au inherited the broad `AFTER UPDATE ON events` form and fires on
  // every non-indexed bump (importance / accessed_count / citation-decay). Drop
  // the legacy trigger when its stored DDL lacks the scoped `UPDATE OF` clause so
  // the CREATE TRIGGER IF NOT EXISTS below reinstates the scoped form (handles
  // re-run + fresh-DB: undefined row on a fresh DB is a no-op).
  try {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='events_fts_au'`).get();
    if (row && row.sql && !/\bAFTER\s+UPDATE\s+OF\s+/i.test(row.sql)) {
      db.exec(`DROP TRIGGER IF EXISTS events_fts_au`);
    }
  } catch { /* non-critical — recreated below */ }

  // ─── v2.31 T6: events table + FTS5 (activity namespace) ───────────────────
  // Independent namespace for bugfix/lesson/bug/discovery/refactor/feature/
  // observation/decision types. Isolated from observations to avoid polluting
  // memdir semantics. Additive-only migration — safe to re-run.
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      project              TEXT NOT NULL,
      event_type           TEXT NOT NULL CHECK(event_type IN
                             ('bugfix','lesson','bug','discovery','refactor','feature','observation','decision')),
      title                TEXT NOT NULL,
      body                 TEXT,
      file_paths           TEXT,
      git_sha              TEXT,
      importance           INTEGER NOT NULL DEFAULT 1,
      created_at_epoch     INTEGER NOT NULL,
      accessed_count       INTEGER NOT NULL DEFAULT 0,
      last_accessed_epoch  INTEGER,
      superseded_at_epoch  INTEGER,
      superseded_by_id     INTEGER REFERENCES events(id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project);
    CREATE INDEX IF NOT EXISTS idx_events_type    ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at_epoch DESC);
    -- T7 compound: supports recentEvents() ORDER BY created_at_epoch DESC filtered by project (index-only sort, avoids temp B-tree).
    CREATE INDEX IF NOT EXISTS idx_events_project_created
      ON events(project, created_at_epoch DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      title, body, event_type UNINDEXED, project UNINDEXED,
      content='events', content_rowid='id',
      tokenize="unicode61 remove_diacritics 2 tokenchars '_-'"
    );

    CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, title, body, event_type, project)
      VALUES (new.id, COALESCE(new.title,''), COALESCE(new.body,''), new.event_type, new.project);
    END;

    CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, title, body, event_type, project)
      VALUES ('delete', old.id, COALESCE(old.title,''), COALESCE(old.body,''), old.event_type, old.project);
    END;

    -- v36: scoped to title, body (the FTS-indexed columns) so non-indexed bumps
    -- (importance / accessed_count / citation-decay) no longer thrash events_fts.
    CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE OF title, body ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, title, body, event_type, project)
      VALUES ('delete', old.id, COALESCE(old.title,''), COALESCE(old.body,''), old.event_type, old.project);
      INSERT INTO events_fts(rowid, title, body, event_type, project)
      VALUES (new.id, COALESCE(new.title,''), COALESCE(new.body,''), new.event_type, new.project);
    END;
  `);

  // v42: column-aware self-heal for events_fts (the one FTS table the generic ensureFTS can't
  // manage — UNINDEXED cols + custom tokenizer + events_fts_* triggers). The CREATE ... IF NOT
  // EXISTS above never widens a drifted (older, narrower) events_fts; this drops+recreates it on
  // column drift and repopulates. No-op on a healthy DB.
  ensureEventsFTS(db);

  // Observation files junction table for normalized file lookups (replaces LIKE scans on files_modified JSON)
  db.exec(`
    CREATE TABLE IF NOT EXISTS observation_files (
      obs_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      inject_count INTEGER NOT NULL DEFAULT 0,
      miss_streak INTEGER NOT NULL DEFAULT 0,
      last_resolved_session_id TEXT DEFAULT NULL,
      last_cited_session_id TEXT DEFAULT NULL,
      UNIQUE(obs_id, filename)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obsfiles_filename ON observation_files(filename)`);
  // v43 (D#78): per-edge attribution columns for DBs whose observation_files
  // predates them — CREATE IF NOT EXISTS above is a no-op on those (gotcha #1),
  // so each column gets its own idempotent ALTER (swallow duplicate-column only,
  // same discipline as MIGRATIONS[]). Fresh DBs hit the duplicate branch.
  for (const sql of [
    'ALTER TABLE observation_files ADD COLUMN inject_count INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE observation_files ADD COLUMN miss_streak INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE observation_files ADD COLUMN last_resolved_session_id TEXT DEFAULT NULL',
    'ALTER TABLE observation_files ADD COLUMN last_cited_session_id TEXT DEFAULT NULL',
  ]) {
    try { db.exec(sql); } catch (e) {
      if (!e.message?.includes('duplicate column name')) throw e;
    }
  }

  // Data migration: populate observation_files from existing observations.files_modified JSON
  // Only runs once: when observation_files is empty but observations has rows with files_modified
  try {
    const obsFilesCount = db.prepare('SELECT COUNT(*) as c FROM observation_files').get().c;
    if (obsFilesCount === 0) {
      const obsWithFiles = db.prepare(
        `SELECT id, files_modified FROM observations WHERE files_modified IS NOT NULL AND files_modified != '[]'`
      ).all();
      if (obsWithFiles.length > 0) {
        const migrateFiles = db.transaction(() => {
          const insertFile = db.prepare('INSERT OR IGNORE INTO observation_files (obs_id, filename) VALUES (?, ?)');
          for (const row of obsWithFiles) {
            try {
              const files = JSON.parse(row.files_modified);
              if (Array.isArray(files)) {
                for (const f of files) {
                  if (typeof f === 'string' && f.length > 0) {
                    insertFile.run(row.id, f);
                  }
                }
              }
            } catch { /* skip malformed JSON */ }
          }
        });
        migrateFiles();
      }
    }
  } catch { /* non-critical — migration can retry on next open */ }

  // observation_files orphan cleanup moved to runDeferredCleanups() (audit P1-5):
  // it now runs retryably outside the version fast-path. See DEFERRED_CLEANUPS.

  // Observation vectors table for TF-IDF vector search
  db.exec(`
    CREATE TABLE IF NOT EXISTS observation_vectors (
      observation_id INTEGER PRIMARY KEY,
      vector BLOB NOT NULL,
      vocab_version TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_vectors_version ON observation_vectors(vocab_version)`);

  // observation_vectors orphan cleanup moved to runDeferredCleanups() (audit P1-5).

  // Persisted vocabulary for stable TF-IDF vector indexing
  db.exec(`
    CREATE TABLE IF NOT EXISTS vocab_state (
      term TEXT NOT NULL,
      term_index INTEGER NOT NULL,
      idf REAL NOT NULL,
      version TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_vocab_state_version ON vocab_state(version)');

  // Project-name normalization moved to runDeferredCleanups() (audit P1-5) — it
  // now retries on a later open if it fails, instead of being lost behind the
  // version fast-path. See DEFERRED_CLEANUPS.

  // ─── v29 (v2.57.x): session-id mix invariant + lesson-retry stats ─────────
  //
  // (B1) sdk_sessions_id_mix_check trigger — guards the v2.33.1 bug pattern
  // where memory_session_id and content_session_id were silently the same
  // value because a caller passed the wrong ID type. The two columns hold
  // *different* ID schemes (mem-internal `hook-<project>-<hash>` vs Claude
  // Code UUID); they should never be equal non-null in production.
  //
  // Trigger fires only when both values look like CC UUIDs (length 36 +
  // hyphenated 8-4-4-4-12 LIKE pattern). This is the v2.33.1 fingerprint —
  // a CC UUID accidentally written into BOTH columns. Test fixtures use
  // short literal strings ('sess-1') for which neither column holds a UUID,
  // so the trigger correctly bypasses them; the audit function below reports
  // any mix regardless for diagnostic completeness.
  //
  // DROP+CREATE pattern (not IF NOT EXISTS) so v29 DBs that captured the
  // initial strict trigger body get the UUID-gated v30 body on next init.
  // Cheap — triggers are metadata-only DDL; this runs once per schema
  // version bump (gated by the fast-path schema_version check above).
  db.exec(`
    DROP TRIGGER IF EXISTS sdk_sessions_id_mix_check_ai;
    DROP TRIGGER IF EXISTS sdk_sessions_id_mix_check_au;
    CREATE TRIGGER sdk_sessions_id_mix_check_ai
      BEFORE INSERT ON sdk_sessions
      WHEN NEW.memory_session_id IS NOT NULL
        AND NEW.memory_session_id = NEW.content_session_id
        AND length(NEW.memory_session_id) = 36
        AND NEW.memory_session_id LIKE '________-____-____-____-____________'
      BEGIN
        SELECT RAISE(ABORT, 'sdk_sessions invariant: memory_session_id and content_session_id must not hold the same UUID value (v2.33.1 mix pattern)');
      END;
    CREATE TRIGGER sdk_sessions_id_mix_check_au
      BEFORE UPDATE ON sdk_sessions
      WHEN NEW.memory_session_id IS NOT NULL
        AND NEW.memory_session_id = NEW.content_session_id
        AND length(NEW.memory_session_id) = 36
        AND NEW.memory_session_id LIKE '________-____-____-____-____________'
      BEGIN
        SELECT RAISE(ABORT, 'sdk_sessions invariant: memory_session_id and content_session_id must not hold the same UUID value (v2.33.1 mix pattern)');
      END;
  `);

  // (B2) lesson_retry_stats — daily aggregate of hook-llm.mjs retry path
  // outcomes. attempts = times the bugfix/decision retry prompt was issued;
  // recovered = times the retry actually returned a non-low-signal lesson.
  // Used by `claude-mem-lite stats --retry` to answer "is the extra Haiku
  // call paying off?" — if recovered/attempts < 0.1 over a long window,
  // delete the retry path and save one LLM call per bugfix/decision.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lesson_retry_stats (
      date_bucket TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      recovered INTEGER NOT NULL DEFAULT 0
    )
  `);

  // ─── v31 (v2.70.0): deferred_work — carry-forward TODOs ─────────────────────
  // Independent table because decay semantics are inverted (older = higher
  // priority signal) and lifecycle is mutable (status flips). Project-scoped
  // queries; no FTS5 (per-project N expected ≪ 100). Idempotent migration.
  db.exec(`
    CREATE TABLE IF NOT EXISTS deferred_work (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      project           TEXT    NOT NULL,
      title             TEXT    NOT NULL,
      detail            TEXT,
      priority          INTEGER NOT NULL DEFAULT 2,
      status            TEXT    NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','dropped')),
      created_at_epoch  INTEGER NOT NULL,
      closed_at_epoch   INTEGER,
      closed_by_obs_id  INTEGER REFERENCES observations(id) ON DELETE SET NULL,
      drop_reason       TEXT,
      source_session_id TEXT,
      source_prompt_id  INTEGER REFERENCES user_prompts(id) ON DELETE SET NULL,
      files             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deferred_open
      ON deferred_work(project, priority DESC, created_at_epoch ASC)
      WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_deferred_closed_by
      ON deferred_work(closed_by_obs_id) WHERE closed_by_obs_id IS NOT NULL;
  `);

  // Record schema version for fast-path on subsequent calls
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  db.transaction(() => {
    db.exec('DELETE FROM schema_version');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
  })();

  db.exec('COMMIT');
  // PRAGMA foreign_keys must run OUTSIDE the transaction (no-op inside).
  db.pragma('foreign_keys = ON');

  return db;
}

// ─── Session-consistency audit (B1) ─────────────────────────────────────────
//
// Used by `claude-mem-lite doctor --session-audit` to surface dangling state
// that the schema invariant trigger only catches at insert/update time. The
// trigger is a forward-protection; this function detects historical drift.
//
// Returns shape: {
//   id_mix_uuid_shape:  rows where both columns hold the same UUID-shaped value
//                       (the v2.33.1 production fingerprint — alarming),
//   id_mix_other:       rows where both columns equal but NOT UUID-shaped
//                       (typically test-fixture scaffold convention — informational),
//   missing_mem_id:     sdk_sessions rows where memory_session_id IS NULL after grace,
//   orphan_obs:         observations.memory_session_id values not in sdk_sessions,
//   healthy:            true when id_mix_uuid_shape + missing_mem_id + orphan_obs == 0;
//                       id_mix_other does NOT drive healthy=false, mirroring the
//                       trigger's UUID-shape gate so doctor doesn't misfire on DBs
//                       contaminated with test-fixture-style literal IDs.
// }
//
// Post-review fix (Important #5): split id_mix to avoid false-positive doctor
// failures on DBs that contain test fixtures or any 'sess-1'-style literal
// equality. The trigger only fires for UUID-shaped equality (the actual bug
// fingerprint); the audit now mirrors that policy for the exit-code-driving
// metric while still surfacing the broader count for diagnostic transparency.
export function auditSessionConsistency(db, { graceMinutes = 5 } = {}) {
  const cutoff = Date.now() - graceMinutes * 60_000;
  // UUID-shape gate mirrors the v30 trigger — same length=36 + LIKE pattern.
  const UUID_LIKE = '________-____-____-____-____________';
  const idMixUuidShape = db.prepare(`
    SELECT COUNT(*) AS c FROM sdk_sessions
    WHERE memory_session_id IS NOT NULL
      AND memory_session_id = content_session_id
      AND length(memory_session_id) = 36
      AND memory_session_id LIKE ?
  `).get(UUID_LIKE).c;
  const idMixOther = db.prepare(`
    SELECT COUNT(*) AS c FROM sdk_sessions
    WHERE memory_session_id IS NOT NULL
      AND memory_session_id = content_session_id
      AND NOT (length(memory_session_id) = 36 AND memory_session_id LIKE ?)
  `).get(UUID_LIKE).c;
  const missingMemId = db.prepare(`
    SELECT COUNT(*) AS c FROM sdk_sessions
    WHERE memory_session_id IS NULL
      AND started_at_epoch < ?
  `).get(cutoff).c;
  const orphanObs = db.prepare(`
    SELECT COUNT(*) AS c FROM observations o
    WHERE NOT EXISTS (
      SELECT 1 FROM sdk_sessions s WHERE s.memory_session_id = o.memory_session_id
    )
  `).get().c;
  // Audit P3-14 backstop. `observations.importance` is INTEGER DEFAULT 1 but NULLABLE, and
  // the two maintenance faces disagree about what NULL means: decayAndMarkIdle reads
  // COALESCE(importance,1)=1 and queues the row for purge, runIdleCleanup reads a bare
  // `importance <= 1` which is NULL and skips it. lib/observation-write.mjs now coerces
  // nullish to 1 on both write cores, so no NEW row can be in that state; this counts the
  // ones that got in another way — an old version, a hand-edited DB, a restored dump.
  // Reported here rather than in its own command because `orphan_obs` above establishes
  // that this audit already covers observation-level integrity, not only sessions.
  const obsImportanceNull = db.prepare(
    'SELECT COUNT(*) AS c FROM observations WHERE importance IS NULL'
  ).get().c;
  return {
    id_mix_uuid_shape: idMixUuidShape,
    id_mix_other: idMixOther,
    missing_mem_id: missingMemId,
    orphan_obs: orphanObs,
    obs_importance_null: obsImportanceNull,
    healthy: idMixUuidShape === 0 && missingMemId === 0 && orphanObs === 0
      && obsImportanceNull === 0,
  };
}

// ─── Deferred one-shot cleanups (retryable) ─────────────────────────────────
// Idempotent DATA cleanups that must survive a transient failure. They run on
// EVERY ensureDb (after initSchema), each gated by a row in migration_cleanups:
// a cleanup that throws leaves its marker unset and retries on the next open —
// unlike the old version-gated body, where a swallowed failure committed
// alongside the version stamp and the fast-path then skipped it forever (P1-5).
const DEFERRED_CLEANUPS = [
  {
    // v35 (v2.87.0): orphaned observation_files. ON DELETE CASCADE didn't fire
    // while early warm-start handles ran with foreign_keys OFF, so junction rows
    // leaked. Idempotent (NOT IN is empty on a clean DB).
    name: 'orphan-observation-files',
    run: (db) => db.prepare(
      `DELETE FROM observation_files WHERE obs_id NOT IN (SELECT id FROM observations)`
    ).run(),
  },
  {
    // v28 (v2.47) P0-1: orphaned observation_vectors — same FK-OFF root cause.
    name: 'orphan-observation-vectors',
    run: (db) => db.prepare(
      `DELETE FROM observation_vectors WHERE observation_id NOT IN (SELECT id FROM observations)`
    ).run(),
  },
  {
    // Project-name normalization: migrate short names ("mem") to canonical
    // ("projects--mem"). Exact suffix match first, then distinctive-token
    // substring. Idempotent: only acts on remaining short-name records.
    name: 'normalize-project-names',
    run: (db) => {
      const shortProjects = db.prepare(`
        SELECT DISTINCT project FROM observations
        WHERE project NOT LIKE '%--_%' AND project != '' AND project IS NOT NULL
        UNION
        SELECT DISTINCT project FROM sdk_sessions
        WHERE project NOT LIKE '%--_%' AND project != '' AND project IS NOT NULL
      `).all();
      if (shortProjects.length === 0) return;
      const normalize = db.transaction(() => {
        for (const { project: shortName } of shortProjects) {
          let canonical = db.prepare(
            `SELECT project FROM observations WHERE project LIKE ? GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1`
          ).get(`%--${shortName}`);
          if (!canonical) {
            const tokens = shortName.split(/[-_.]/).filter(t => t.length >= 5);
            for (const token of tokens) {
              canonical = db.prepare(
                `SELECT project FROM observations WHERE project LIKE ? AND project LIKE '%--_%'
                 GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1`
              ).get(`%${token}%`);
              if (canonical) break;
            }
          }
          if (canonical) {
            // Rename the short project to canonical on EVERY project-scoped table.
            // Originally only the first three were rewritten, so a short-named
            // project's deferred TODOs (deferred_work), activity (events), citation
            // history (citation_log + v45 citation_surface_log), and /clear-/exit
            // handoffs (session_handoffs) were stranded on the old name — invisible to
            // every project-scoped query after normalization. All eight carry a
            // `project` column (verified).
            for (const table of ['observations', 'sdk_sessions', 'session_summaries',
                                 'session_handoffs', 'citation_log', 'citation_surface_log',
                                 'events', 'deferred_work']) {
              db.prepare(`UPDATE ${table} SET project = ? WHERE project = ?`).run(canonical.project, shortName);
            }
          }
        }
      });
      normalize();
    },
  },
];

/**
 * Run registered one-shot data cleanups that haven't completed yet. Each is
 * gated by a row in migration_cleanups, so a transient failure retries on the
 * next open instead of being silently lost behind the schema-version fast-path
 * (audit P1-5). Best-effort: never throws — callers open the DB regardless.
 */
export function runDeferredCleanups(db) {
  let done;
  try {
    done = new Set(db.prepare('SELECT name FROM migration_cleanups').all().map(r => r.name));
  } catch {
    return; // table not present yet (pre-migration open) — nothing to do
  }
  const mark = db.prepare('INSERT OR IGNORE INTO migration_cleanups (name, done_at_epoch) VALUES (?, ?)');
  for (const { name, run } of DEFERRED_CLEANUPS) {
    if (done.has(name)) continue;
    try {
      run(db);
      mark.run(name, Date.now());
    } catch (e) {
      // Leave the marker unset → retried next open. Surface for observability.
      debugCatch(e, `deferred-cleanup:${name}`);
    }
  }
}

/**
 * Ensure DB directory, database file, and all tables exist.
 * Safe to call from any process (hook or server). Idempotent.
 * Returns an opened Database instance with WAL + busy_timeout configured.
 */
export function ensureDb() {
  // Auto-migrate unhidden dir (~/claude-mem-lite/ → ~/.claude-mem-lite/)
  // Check DB_PATH (not DB_DIR) because hook-shared.mjs module-level init may create DB_DIR early
  const oldUnhidden = join(homedir(), 'claude-mem-lite');
  if (existsSync(oldUnhidden) && !existsSync(DB_PATH)) {
    // Remove DB_DIR only if it has no user data (no .db files)
    if (existsSync(DB_DIR)) {
      try {
        const hasDbFiles = readdirSync(DB_DIR).some(f => f.endsWith('.db'));
        if (!hasDbFiles) rmSync(DB_DIR, { recursive: true, force: true });
      } catch {}
    }
    if (!existsSync(DB_DIR)) renameSync(oldUnhidden, DB_DIR);
  }

  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });

  // Auto-migrate old filename in same directory (claude-mem.db → claude-mem-lite.db)
  const oldPath = join(DB_DIR, 'claude-mem.db');
  if (!existsSync(DB_PATH) && existsSync(oldPath)) {
    renameSync(oldPath, DB_PATH);
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(oldPath + ext)) try { renameSync(oldPath + ext, DB_PATH + ext); } catch {}
    }
  }

  const db = new Database(DB_PATH);
  try { chmodSync(DB_PATH, 0o600); } catch {}
  db.pragma('journal_mode = WAL');
  // 5000ms matches the MCP server (server.mjs) — 3000ms wasn't enough under realistic
  // concurrency (parallel CLI saves + a long-running FTS rebuild can push individual
  // transactions past 3s, triggering SQLITE_BUSY on the third caller).
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = OFF'); // Enabled after dedup migration

  try {
    const ready = initSchema(db);
    // P1-5: sentinel-gated data cleanups must run on EVERY open (schema.mjs:766).
    // They were extracted out of initSchema into runDeferredCleanups but never
    // wired into a production opener — without this call they ran nowhere but
    // tests, silently halting orphan/normalize hygiene. Best-effort: never throws.
    runDeferredCleanups(ready);
    return ready;
  } catch (e) {
    try { db.close(); } catch {}
    throw e;
  }
}

/**
 * Whether an open/init error carries a genuine corruption signature. WAL-delete
 * recovery is ONLY safe for these: on a transient error (SQLITE_BUSY) or the
 * forward-version guard throw, deleting the WAL would discard committed-but-
 * uncheckpointed transactions — silent data loss.
 */
export function isDbCorruptionError(err) {
  return /SQLITE_CORRUPT|SQLITE_NOTADB|malformed|not a database|disk image/i
    .test(`${err?.code || ''} ${err?.message || ''}`);
}

/**
 * ensureDb with corruption-gated WAL recovery. Was inlined in server.mjs only,
 * so hooks (openDb → silent null) and the CLI (raw throw) stayed degraded on a
 * corrupt WAL until the next MCP server start. One shared implementation now
 * serves all three openers.
 *
 * Non-corruption failure → rethrows the original error, WAL/SHM left intact.
 * Corruption → deletes -wal/-shm, retries once; a still-failing retry rethrows
 * with `err.walRecoveryAttempted = true` so callers can word their fatal hint
 * accurately (recovery already tried vs WAL deliberately preserved).
 *
 * @param {{warn?: (msg: string) => void, info?: (msg: string) => void}} [opts]
 */
export function ensureDbWithWalRecovery({ warn, info } = {}) {
  try {
    return ensureDb();
  } catch (firstErr) {
    if (!isDbCorruptionError(firstErr)) throw firstErr;
    warn?.(`DB corruption detected, attempting WAL recovery: ${firstErr.message}`);
    try { rmSync(DB_PATH + '-wal', { force: true }); } catch { /* best-effort */ }
    try { rmSync(DB_PATH + '-shm', { force: true }); } catch { /* best-effort */ }
    try {
      const db = ensureDb();
      info?.('DB recovered after WAL cleanup');
      return db;
    } catch (retryErr) {
      try { retryErr.walRecoveryAttempted = true; } catch { /* frozen error — fine */ }
      throw retryErr;
    }
  }
}

/**
 * Create FTS5 virtual table + sync triggers for a content table.
 * Idempotent: skips if already exists. Exported for test helpers.
 */
/**
 * Rebuild all FTS5 indexes. Use after suspected index corruption (e.g. crash mid-trigger).
 * Safe to call at any time — rebuilds are idempotent.
 * @param {Database} db Opened database instance
 * @returns {{rebuilt: string[], errors: string[]}} Results per FTS table
 */
export function rebuildFTS(db) {
  const FTS_TABLES = ['observations_fts', 'session_summaries_fts', 'user_prompts_fts', 'events_fts'];
  const idRe = /^[a-z][a-z0-9_]*$/;
  const rebuilt = [];
  const errors = [];
  for (const fts of FTS_TABLES) {
    try {
      if (!idRe.test(fts)) { errors.push(`${fts}: invalid identifier`); continue; }
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(fts);
      if (!exists) { errors.push(`${fts}: not found`); continue; }
      db.exec(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`);
      rebuilt.push(fts);
    } catch (e) {
      errors.push(`${fts}: ${e.message}`);
    }
  }
  return { rebuilt, errors };
}

/**
 * Check FTS5 index integrity. Returns true if all indexes are healthy.
 * @param {Database} db Opened database instance
 * @returns {{healthy: boolean, details: string[]}}
 */
export function checkFTSIntegrity(db) {
  const FTS_TABLES = ['observations_fts', 'session_summaries_fts', 'user_prompts_fts', 'events_fts'];
  const idRe = /^[a-z][a-z0-9_]*$/;
  const details = [];
  let healthy = true;
  for (const fts of FTS_TABLES) {
    try {
      if (!idRe.test(fts)) { details.push(`${fts}: invalid identifier`); healthy = false; continue; }
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(fts);
      if (!exists) { details.push(`${fts}: missing`); healthy = false; continue; }
      db.exec(`INSERT INTO ${fts}(${fts}) VALUES('integrity-check')`);
      details.push(`${fts}: ok`);
    } catch (e) {
      details.push(`${fts}: CORRUPT (${e.message})`);
      healthy = false;
    }
  }
  return { healthy, details };
}

export function ensureFTS(db, ftsName, tableName, columns) {
  // Validate identifiers to prevent SQL injection (done upfront; both
  // branches below use these identifiers in string-interpolated SQL)
  const idRe = /^[a-z][a-z0-9_]*$/;
  if (!idRe.test(ftsName) || !idRe.test(tableName) || !columns.every(c => idRe.test(c))) {
    throw new Error(`Invalid identifier in ensureFTS: ${ftsName}, ${tableName}`);
  }

  const colList = columns.join(', ');
  const newVals = columns.map(c => `new.${c}`).join(', ');
  const oldVals = columns.map(c => `old.${c}`).join(', ');

  // Column-aware (re)creation. An existing FTS table is never silently reused when its
  // indexed-column set has drifted from `columns`. Root cause of a silent-write bug class:
  // a DB created before a column was added to an FTS list (session_summaries_fts predates
  // `remaining_items`, added v2.2.0) kept the OLD narrow table forever, because ensureFTS
  // only created the table when it was absent. The triggers below, however, are rebuilt
  // from the CURRENT (wider) column list, so every UPDATE fired a trigger that INSERTed
  // into a column the stale FTS table lacked and threw "no column named <X>", silently
  // failing the write (session-summary Haiku enrichment was discarded every session for the
  // early-adopter cohort, and the new column stayed unindexed). On drift, drop the triggers +
  // table and fall through to CREATE + repopulate. Generalizes the one-off observations_fts
  // guard in ensureDb so ALL three ensureFTS-managed tables self-heal on any column addition.
  const ftsRow = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(ftsName);
  let recreated = false;
  if (ftsRow) {
    let existingCols = [];
    try { existingCols = db.prepare(`PRAGMA table_info(${ftsName})`).all().map(c => c.name); } catch { /* unreadable → treat as drifted, recreate */ }
    const drifted = existingCols.length !== columns.length || columns.some(c => !existingCols.includes(c));
    if (drifted) {
      db.exec(`DROP TRIGGER IF EXISTS ${tableName}_ai`);
      db.exec(`DROP TRIGGER IF EXISTS ${tableName}_ad`);
      db.exec(`DROP TRIGGER IF EXISTS ${tableName}_au`);
      db.exec(`DROP TABLE IF EXISTS ${ftsName}`);
      recreated = true;
    }
  }
  if (!ftsRow || recreated) {
    db.exec(`CREATE VIRTUAL TABLE ${ftsName} USING fts5(${colList}, content='${tableName}', content_rowid='id')`);
  }

  // Triggers created / recreated independently of FTS table existence so that
  // schema migrations (e.g. v27 scope-to-FTS-columns) can drop the old _au
  // trigger and this function reinstates it with the current template on the
  // next ensureDb(). Per #7647: keep rebuild conditional — IF NOT EXISTS gates
  // writes when the current definition already matches.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${tableName}_ai AFTER INSERT ON ${tableName} BEGIN
      INSERT INTO ${ftsName}(rowid, ${colList}) VALUES (new.id, ${newVals});
    END;

    CREATE TRIGGER IF NOT EXISTS ${tableName}_ad AFTER DELETE ON ${tableName} BEGIN
      INSERT INTO ${ftsName}(${ftsName}, rowid, ${colList}) VALUES('delete', old.id, ${oldVals});
    END;

    -- v27: AFTER UPDATE OF <fts_cols> — trigger fires only when an FTS-indexed
    -- column changes. Prevents access_count / injection_count / last_accessed_at
    -- UPDATEs from firing wasteful FTS delete+reinsert (project_non_obvious.md).
    CREATE TRIGGER IF NOT EXISTS ${tableName}_au AFTER UPDATE OF ${colList} ON ${tableName} BEGIN
      INSERT INTO ${ftsName}(${ftsName}, rowid, ${colList}) VALUES('delete', old.id, ${oldVals});
      INSERT INTO ${ftsName}(rowid, ${colList}) VALUES (new.id, ${newVals});
    END;
  `);

  // Repopulate a freshly (re)created external-content FTS index from its content table.
  // An empty index otherwise returns 0 rows until each row is next written — and unlike
  // observations_fts (rebuilt via the obsFtsRecreated flag in ensureDb), session_summaries_fts
  // and user_prompts_fts have no other rebuild path, so a widened table must repopulate here.
  if (recreated) {
    try {
      const cnt = db.prepare(`SELECT COUNT(*) AS c FROM ${tableName}`).get();
      if (cnt.c > 0) db.exec(`INSERT INTO ${ftsName}(${ftsName}) VALUES('rebuild')`);
    } catch { /* non-critical — index repopulates lazily on next write */ }
  }
}

// Column-aware self-heal for events_fts — the events table's FTS index. events_fts is NOT
// managed by the generic ensureFTS() above because its DDL is non-standard: event_type and
// project are UNINDEXED, it uses a custom unicode61 tokenizer with '_-' tokenchars, and its
// triggers are named events_fts_* (not events_*). Routing it through ensureFTS would recreate
// it WITHOUT the UNINDEXED cols / tokenizer AND install a SECOND, differently-named trigger set
// (events_*) that double-writes the index. This dedicated guard mirrors ensureFTS's drift
// detection while preserving the exact events_fts DDL (schema.mjs events block) — closing the
// F8/P2-4 gap: events_fts was the one FTS table outside self-heal, so a future events column
// addition would leave a stale narrow index whose (wider) triggers throw "no column" and
// silently drop event writes. Idempotent: a no-op once the column set matches.
const EVENTS_FTS_COLUMNS = ['title', 'body', 'event_type', 'project']; // full set (drift check)
export function ensureEventsFTS(db) {
  const ftsRow = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='events_fts'`).get();
  let recreated = false;
  if (ftsRow) {
    let existingCols = [];
    try { existingCols = db.prepare(`PRAGMA table_info(events_fts)`).all().map(c => c.name); } catch { /* unreadable → recreate */ }
    const drifted = existingCols.length !== EVENTS_FTS_COLUMNS.length || EVENTS_FTS_COLUMNS.some(c => !existingCols.includes(c));
    if (drifted) {
      db.exec(`DROP TRIGGER IF EXISTS events_fts_ai`);
      db.exec(`DROP TRIGGER IF EXISTS events_fts_ad`);
      db.exec(`DROP TRIGGER IF EXISTS events_fts_au`);
      db.exec(`DROP TABLE IF EXISTS events_fts`);
      recreated = true;
    }
  }
  if (!ftsRow || recreated) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        title, body, event_type UNINDEXED, project UNINDEXED,
        content='events', content_rowid='id',
        tokenize="unicode61 remove_diacritics 2 tokenchars '_-'"
      );
    `);
  }
  // Triggers reinstated from the canonical template (INSERT all 4 columns; AFTER UPDATE OF the
  // two INDEXED columns only, so non-indexed bumps don't thrash the index). IF NOT EXISTS so an
  // unchanged definition is a no-op — byte-identical to the events block in initSchema.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, title, body, event_type, project)
      VALUES (new.id, COALESCE(new.title,''), COALESCE(new.body,''), new.event_type, new.project);
    END;
    CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, title, body, event_type, project)
      VALUES ('delete', old.id, COALESCE(old.title,''), COALESCE(old.body,''), old.event_type, old.project);
    END;
    CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE OF title, body ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, title, body, event_type, project)
      VALUES ('delete', old.id, COALESCE(old.title,''), COALESCE(old.body,''), old.event_type, old.project);
      INSERT INTO events_fts(rowid, title, body, event_type, project)
      VALUES (new.id, COALESCE(new.title,''), COALESCE(new.body,''), new.event_type, new.project);
    END;
  `);
  if (recreated) {
    try {
      const cnt = db.prepare(`SELECT COUNT(*) AS c FROM events`).get();
      if (cnt.c > 0) db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild')`);
    } catch { /* non-critical — index repopulates lazily on next write */ }
  }
}
