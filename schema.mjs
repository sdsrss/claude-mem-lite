// claude-mem-lite shared database schema and initialization
// Used by both server.mjs (MCP process) and hook.mjs (hook process)
// Ensures DB + tables exist regardless of which process starts first

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, chmodSync } from 'fs';
import { OBS_FTS_COLUMNS } from './utils.mjs';

export const DB_DIR = process.env.CLAUDE_MEM_DIR || join(homedir(), '.claude-mem-lite');
export const DB_PATH = join(DB_DIR, 'claude-mem-lite.db');
export const REGISTRY_DB_PATH = join(DB_DIR, 'resource-registry.db');

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
    type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
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
    PRIMARY KEY (project, type)
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
];

/**
 * Apply full schema (tables, migrations, indexes, FTS5) to an opened DB instance.
 * Single source of truth for all schema setup — used by ensureDb() and tests.
 * The DB should have foreign_keys OFF before calling (enabled after dedup migration).
 */
export function initSchema(db) {
  // Create core tables
  db.exec(CORE_SCHEMA);

  // Run column migrations
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) {
      if (!e.message?.includes('duplicate column name')) throw e;
    }
  }

  // Dedup migration: ensure memory_session_id is unique, then enable FK
  const hasIdx = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_sess_memory_sid'`).get();
  if (!hasIdx) {
    const dupes = db.prepare(`
      SELECT memory_session_id, COUNT(*) as cnt
      FROM sdk_sessions
      WHERE memory_session_id IS NOT NULL
      GROUP BY memory_session_id HAVING cnt > 1
    `).all();

    if (dupes.length > 0) {
      const dedup = db.transaction(() => {
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
      });
      dedup();
    }

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sess_memory_sid ON sdk_sessions(memory_session_id)`);
  }
  db.pragma('foreign_keys = ON');

  // Performance indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_epoch_project ON observations(created_at_epoch DESC, project)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sess_sum_epoch ON session_summaries(created_at_epoch DESC, project)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_project_epoch_minhash ON observations(project, created_at_epoch DESC) WHERE minhash_sig IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(content_session_id)`);

  // FTS5 migration: add lesson_learned column to observations_fts (one-time)
  // Detect old FTS5 table missing lesson_learned and recreate with full column set
  try {
    const ftsDdl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='observations_fts'`).get();
    if (ftsDdl && !ftsDdl.sql.includes('lesson_learned')) {
      db.exec(`DROP TRIGGER IF EXISTS observations_ai`);
      db.exec(`DROP TRIGGER IF EXISTS observations_ad`);
      db.exec(`DROP TRIGGER IF EXISTS observations_au`);
      db.exec(`DROP TABLE IF EXISTS observations_fts`);
    }
  } catch { /* non-critical — ensureFTS will create if missing */ }

  // FTS5 full-text search tables + triggers (idempotent)
  ensureFTS(db, 'observations_fts', 'observations', OBS_FTS_COLUMNS);
  ensureFTS(db, 'session_summaries_fts', 'session_summaries', ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes', 'remaining_items']);
  ensureFTS(db, 'user_prompts_fts', 'user_prompts', ['prompt_text']);

  // Rebuild FTS5 if we just recreated it (migration populates from content table)
  try {
    const needsRebuild = db.prepare(`SELECT COUNT(*) as cnt FROM observations`).get();
    const ftsCount = db.prepare(`SELECT COUNT(*) as cnt FROM observations_fts`).get();
    if (needsRebuild.cnt > 0 && ftsCount.cnt === 0) {
      db.exec(`INSERT INTO observations_fts(observations_fts) VALUES('rebuild')`);
    }
  } catch { /* non-critical */ }

  // Project name normalization: migrate short names ("mem") to canonical form ("projects--mem")
  // Strategy: exact suffix match first, then substring match for package-name aliases
  // Idempotent: only runs when short-name records exist
  try {
    const shortProjects = db.prepare(`
      SELECT DISTINCT project FROM observations
      WHERE project NOT LIKE '%--_%' AND project != '' AND project IS NOT NULL
      UNION
      SELECT DISTINCT project FROM sdk_sessions
      WHERE project NOT LIKE '%--_%' AND project != '' AND project IS NOT NULL
    `).all();
    if (shortProjects.length > 0) {
      const normalize = db.transaction(() => {
        for (const { project: shortName } of shortProjects) {
          // Strategy 1: exact suffix match (e.g., "mem" → "projects--mem")
          let canonical = db.prepare(
            `SELECT project FROM observations WHERE project LIKE ? GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1`
          ).get(`%--${shortName}`);
          // Strategy 2: substring match for aliases (e.g., "claude-mem-lite" → match project containing "mem")
          // Extract the most distinctive token from the short name for fuzzy matching
          if (!canonical) {
            const tokens = shortName.split(/[-_.]/).filter(t => t.length >= 3);
            for (const token of tokens) {
              canonical = db.prepare(
                `SELECT project FROM observations WHERE project LIKE ? AND project LIKE '%--_%'
                 GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1`
              ).get(`%${token}%`);
              if (canonical) break;
            }
          }
          if (canonical) {
            for (const table of ['observations', 'sdk_sessions', 'session_summaries']) {
              db.prepare(`UPDATE ${table} SET project = ? WHERE project = ?`).run(canonical.project, shortName);
            }
          }
        }
      });
      normalize();
    }
  } catch { /* non-critical — normalization can retry on next open */ }

  return db;
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
  db.pragma('busy_timeout = 3000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = OFF'); // Enabled after dedup migration

  try {
    return initSchema(db);
  } catch (e) {
    try { db.close(); } catch {}
    throw e;
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
  const FTS_TABLES = ['observations_fts', 'session_summaries_fts', 'user_prompts_fts'];
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
  const FTS_TABLES = ['observations_fts', 'session_summaries_fts', 'user_prompts_fts'];
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
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(ftsName);
  if (exists) return;

  // Validate identifiers to prevent SQL injection
  const idRe = /^[a-z][a-z0-9_]*$/;
  if (!idRe.test(ftsName) || !idRe.test(tableName) || !columns.every(c => idRe.test(c))) {
    throw new Error(`Invalid identifier in ensureFTS: ${ftsName}, ${tableName}`);
  }

  const colList = columns.join(', ');
  const newVals = columns.map(c => `new.${c}`).join(', ');
  const oldVals = columns.map(c => `old.${c}`).join(', ');
  db.exec(`
    CREATE VIRTUAL TABLE ${ftsName} USING fts5(${colList}, content='${tableName}', content_rowid='id');

    CREATE TRIGGER ${tableName}_ai AFTER INSERT ON ${tableName} BEGIN
      INSERT INTO ${ftsName}(rowid, ${colList}) VALUES (new.id, ${newVals});
    END;

    CREATE TRIGGER ${tableName}_ad AFTER DELETE ON ${tableName} BEGIN
      INSERT INTO ${ftsName}(${ftsName}, rowid, ${colList}) VALUES('delete', old.id, ${oldVals});
    END;

    CREATE TRIGGER ${tableName}_au AFTER UPDATE ON ${tableName} BEGIN
      INSERT INTO ${ftsName}(${ftsName}, rowid, ${colList}) VALUES('delete', old.id, ${oldVals});
      INSERT INTO ${ftsName}(rowid, ${colList}) VALUES (new.id, ${newVals});
    END;
  `);
}
