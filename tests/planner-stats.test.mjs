// Issue #41: nothing in the package ever ran ANALYZE, so no database carried planner
// statistics. Without sqlite_stat1 the planner drives `observations_fts JOIN observations`
// from idx_obs_project_live and evaluates the FTS5 MATCH once per candidate row. Measured
// 2026-10-07 on a synthetic 44k-row single-project corpus (generator not in the repo): one
// searchByFts (OR fallback) took 9.4 s stat-less and 13 ms once analyzed; the UserPromptSubmit
// hook's budget is 2 s. These cases pin the plan flip and the call sites, not the timing.
//
// refreshPlannerStats is SQLite's own recommendation (PRAGMA optimize=0x10002), run where
// the docs put it: on a long-lived connection's open (the MCP server), periodically (the
// daily auto-maintain worker) and after a bulk load (import-jsonl). These cases pin the
// helper's contract and each of the three call sites.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initSchema, refreshPlannerStats } from '../schema.mjs';
import { searchByFts } from '../scripts/user-prompt-search.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'demo';

let dataDir, dbPath;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mem-planner-stats-'));
  mkdirSync(join(dataDir, 'runtime'), { recursive: true });
  dbPath = join(dataDir, 'claude-mem-lite.db');
});

afterEach(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** A file DB with `n` live observations in one project and no planner statistics. */
function seedDb(n = 20) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  db.pragma('foreign_keys = OFF');
  const now = Date.now();
  const ins = db.prepare(
    'INSERT INTO observations (memory_session_id, project, type, title, subtitle, narrative, text, concepts,' +
      ' facts, files_read, files_modified, importance, created_at, created_at_epoch)' +
      " VALUES ('s1', ?, 'change', ?, '', ?, '', '', '', '[]', '[]', 2, ?, ?)",
  );
  for (let i = 0; i < n; i++) {
    const t = now - i * 3600000;
    ins.run(PROJECT, `Fix session name field ${i}`, `auth describe field ${i}`, new Date(t).toISOString(), t);
  }
  return db;
}

function hasStats(db, table = 'observations') {
  const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'").get();
  if (!t) return false;
  return Boolean(db.prepare('SELECT 1 FROM sqlite_stat1 WHERE tbl = ?').get(table));
}

function statsOnDisk() {
  const db = new Database(dbPath, { readonly: true });
  try {
    return hasStats(db);
  } finally {
    db.close();
  }
}

/** The first line of the plan searchByFts's own SQL gets, captured rather than re-typed. */
function searchPlanHead(db) {
  const calls = [];
  const realPrepare = db.prepare.bind(db);
  const spy = Object.create(db);
  spy.prepare = (sql) => {
    const stmt = realPrepare(sql);
    return {
      all: (...params) => {
        calls.push({ sql, params });
        return stmt.all(...params);
      },
    };
  };
  searchByFts(spy, 'fix the session name field in auth describe', PROJECT, 10, null);
  const ftsCall = calls.find((c) => c.sql.includes('observations_fts MATCH'));
  expect(ftsCall, 'searchByFts ran its FTS query').toBeTruthy();
  return realPrepare('EXPLAIN QUERY PLAN ' + ftsCall.sql).all(...ftsCall.params)[0].detail;
}

describe('refreshPlannerStats', () => {
  it('turns the stat-less plan (MATCH per observations row) into an FTS-driven join', () => {
    const db = seedDb();
    try {
      // Premise: without statistics the join is driven from observations. If a future SQLite
      // plans this well on its own, this line says so instead of the case passing vacuously.
      expect(hasStats(db)).toBe(false);
      expect(searchPlanHead(db)).toMatch(/SEARCH o USING INDEX idx_obs_project_live/);

      expect(refreshPlannerStats(db)).toBe(true);

      expect(hasStats(db)).toBe(true);
      expect(searchPlanHead(db)).toMatch(/^SCAN observations_fts VIRTUAL TABLE/);
    } finally {
      db.close();
    }
  });

  it('re-analyzes a table whose row count grew 10-fold since its statistics were taken', () => {
    // The 0x10000 bit: plain `PRAGMA optimize` on a fresh connection only analyzes tables
    // with NO statistics, so stats taken when the database was small would never refresh.
    const db = seedDb(20);
    try {
      expect(refreshPlannerStats(db)).toBe(true);
      const rowsInStats = () =>
        Number(
          db
            .prepare("SELECT stat FROM sqlite_stat1 WHERE tbl = 'observations' LIMIT 1")
            .get()
            .stat.split(' ')[0],
        );
      expect(rowsInStats()).toBe(20);
    } finally {
      db.close();
    }
    // Grow past 10x on a NEW connection, as the daily worker sees it.
    const grow = seedDb(230);
    grow.close();
    const fresh = new Database(dbPath);
    try {
      expect(refreshPlannerStats(fresh)).toBe(true);
      const stat = fresh
        .prepare("SELECT stat FROM sqlite_stat1 WHERE tbl = 'observations' LIMIT 1")
        .get().stat;
      expect(Number(stat.split(' ')[0])).toBe(250);
    } finally {
      fresh.close();
    }
  });

  it('returns false instead of throwing on a read-only connection', () => {
    seedDb().close();
    const ro = new Database(dbPath, { readonly: true });
    try {
      expect(refreshPlannerStats(ro)).toBe(false);
      expect(hasStats(ro)).toBe(false);
    } finally {
      ro.close();
    }
  });

  it('gives up after busyTimeoutMs when a writer holds the lock, and restores busy_timeout', () => {
    seedDb().close();
    const holder = new Database(dbPath);
    const db = new Database(dbPath);
    try {
      db.pragma('busy_timeout = 5000');
      holder.exec('BEGIN IMMEDIATE');
      const t0 = Date.now();
      expect(refreshPlannerStats(db, { busyTimeoutMs: 50 })).toBe(false);
      // Bounded by the 50 ms override, not the connection's own 5000 ms.
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
      holder.exec('ROLLBACK');
      // The next caller retries and succeeds once the lock is free.
      expect(refreshPlannerStats(db, { busyTimeoutMs: 50 })).toBe(true);
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(hasStats(db)).toBe(true);
    } finally {
      db.close();
      holder.close();
    }
  });
});

describe('planner statistics call sites', () => {
  const childEnv = () => ({
    ...process.env,
    CLAUDE_MEM_DIR: dataDir,
    CLAUDE_PROJECT_DIR: join(dataDir, 'proj'),
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    MEM_NO_AUTO_ADOPT: '1',
  });

  it('the daily auto-maintain worker leaves the database analyzed', () => {
    seedDb().close();
    expect(statsOnDisk()).toBe(false);
    execFileSync(process.execPath, [join(REPO, 'hook.mjs'), 'auto-maintain'], {
      cwd: REPO,
      env: childEnv(),
      stdio: 'pipe',
      timeout: 60_000,
    });
    expect(statsOnDisk()).toBe(true);
  });

  it('import-jsonl leaves the database analyzed after a load', () => {
    seedDb().close();
    expect(statsOnDisk()).toBe(false);
    const transcript = join(dataDir, 'load.jsonl');
    writeFileSync(
      transcript,
      [
        '{"type":"user","sessionId":"ps-1","timestamp":"2026-06-20T10:00:00.000Z","message":{"role":"user","content":"investigate the cache eviction policy"}}',
        '{"type":"assistant","sessionId":"ps-1","timestamp":"2026-06-20T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_p1","name":"Read","input":{"file_path":"/p/cache.mjs"}}]}}',
        '{"type":"user","sessionId":"ps-1","timestamp":"2026-06-20T10:00:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_p1","content":"file contents here"}]}}',
      ].join('\n') + '\n',
    );
    const stdout = execFileSync(
      process.execPath,
      [join(REPO, 'cli.mjs'), 'import-jsonl', transcript, '--project', PROJECT],
      { env: childEnv(), encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
    );
    expect(stdout).toContain('+1 prompts');
    expect(statsOnDisk()).toBe(true);
  });

  it('the MCP server analyzes the database when it opens it', async () => {
    seedDb().close();
    expect(statsOnDisk()).toBe(false);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'server.mjs')],
      env: { ...childEnv(), CLAUDE_MEM_AUTO_DEEP: '0' },
    });
    const client = new Client({ name: 'planner-stats-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      expect(statsOnDisk()).toBe(true);
    } finally {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
    }
  }, 20_000);
});
