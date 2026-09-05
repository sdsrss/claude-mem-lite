// Shared test utilities for claude-mem-lite
// Single source of truth: uses initSchema/registry schemas — no DDL duplication

import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import {
  RESOURCES_SCHEMA,
  FTS5_SCHEMA,
  TRIGGERS_SCHEMA,
  INVOCATIONS_SCHEMA,
  PREINSTALLED_SCHEMA,
} from '../registry.mjs';
import { fileMatchClause, fileMatchParams } from '../lib/file-edge-match.mjs';

/**
 * Create an in-memory test database with full production schema + FTS5.
 * Uses initSchema() from schema.mjs — single source of truth.
 */
export function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  return initSchema(db);
}

/**
 * Create an in-memory registry test database with full production schema.
 * Uses exported schemas from registry.mjs — single source of truth.
 */
export function createRegistryTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.pragma('foreign_keys = ON');
  db.exec(RESOURCES_SCHEMA);
  db.exec(FTS5_SCHEMA);
  db.exec(TRIGGERS_SCHEMA);
  db.exec(INVOCATIONS_SCHEMA);
  db.exec(PREINSTALLED_SCHEMA);
  return db;
}

export function insertSession(db, { id, project = 'test', memoryId = null }) {
  const now = new Date();
  db.prepare(
    `
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `,
  ).run(id, memoryId ?? id, project, now.toISOString(), now.getTime());
}

/**
 * Insert into user_prompts for tests that need to exercise the
 * prompts-table fallback path in user-prompt-search.js (v2.34.5+).
 * Matches the shape produced by hook-episode.mjs at runtime.
 */
export function insertPrompt(db, { contentSessionId = 'sess-1', text, promptNumber = 1, epochOffset = 0 }) {
  const now = Date.now() + epochOffset;
  const result = db
    .prepare(
      `
    INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `,
    )
    .run(contentSessionId, text, promptNumber, new Date(now).toISOString(), now);
  return result;
}

export function insertObs(
  db,
  {
    sessionId = 'sess-1',
    project = 'test',
    type = 'discovery',
    title,
    subtitle = '',
    text = '',
    narrative = '',
    importance = 1,
    relatedIds = '[]',
    epochOffset = 0,
    filesModified = '[]',
    accessCount = 0,
    compressedInto = null,
    lessonLearned = null,
    searchAliases = null,
    branch = null,
    supersededAt = null,
    supersededBy = null,
    lastAccessedAt = null,
    citedCount = 0,
    uncitedStreak = 0,
    injectionCount = 0,
  },
) {
  const now = Date.now() + epochOffset;
  const result = db
    .prepare(
      `
    INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, related_ids, access_count, compressed_into, lesson_learned, search_aliases, branch, superseded_at, superseded_by, last_accessed_at, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      sessionId,
      project,
      text,
      type,
      title,
      subtitle,
      narrative,
      filesModified,
      importance,
      relatedIds,
      accessCount,
      compressedInto,
      lessonLearned,
      searchAliases,
      branch,
      supersededAt,
      supersededBy,
      lastAccessedAt,
      new Date(now).toISOString(),
      now,
    );
  if (citedCount || uncitedStreak || injectionCount) {
    db.prepare(
      'UPDATE observations SET cited_count = ?, uncited_streak = ?, injection_count = ? WHERE id = ?',
    ).run(citedCount, uncitedStreak, injectionCount, Number(result.lastInsertRowid));
  }

  // Also populate observation_files junction table (mirrors saveObservation behavior)
  if (filesModified && filesModified !== '[]') {
    try {
      const files = JSON.parse(filesModified);
      if (Array.isArray(files)) {
        const obsId = Number(result.lastInsertRowid);
        const insertFile = db.prepare(
          'INSERT OR IGNORE INTO observation_files (obs_id, filename) VALUES (?, ?)',
        );
        for (const f of files) {
          if (typeof f === 'string' && f.length > 0) insertFile.run(obsId, f);
        }
      }
    } catch {
      /* skip malformed JSON */
    }
  }

  return result;
}

/**
 * Run the shipped (obs,file) EDGE-MATCH ARM ONLY — `fileMatchClause` /
 * `fileMatchParams` from lib/file-edge-match.mjs, the pair that
 * scripts/pre-tool-recall.js and lib/edge-attribution.mjs both build on —
 * plus a hand-copied `importance >= 2` gate.
 *
 * It is NOT the shipped injection query, and no caller should read it as one.
 * Everything else in scripts/pre-tool-recall.js is absent here: the
 * `liveObsFilterSql` superseded/compressed filter, the 60-day
 * `created_at_epoch` lookback, the `miss_streak` edge decay, the `scope`
 * filter, the lesson/type fallback, the lesson-first ORDER BY, the Read-1 /
 * Edit-2 LIMIT, the events leg, and the session cooldown. Those clauses are
 * guarded — by the subprocess cases in tests/pre-tool-recall.test.mjs, which
 * drive the real script — not by anything in this helper. The `importance`
 * column it selects is likewise helper-only: the shipped injection query never
 * returns it (D#163).
 *
 * Exists because several suites used to assert edge matching through
 * `recallForFile` (hook-memory.mjs), an in-process twin that had NO production
 * caller and was deleted 2026-08-22. The twin split basenames on either
 * separator while the shipped pair used host-native `basename`, so a real
 * Windows-payload gap sat unobserved behind six green tests. One helper here
 * keeps every caller on the shipped MATCH clause instead of re-deriving it per
 * suite — the twin-drift class this repo has re-opened repeatedly.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} filePath  edited file, either separator, any OS
 * @param {string} project
 * @param {{minImportance?: number}} [opts] `minImportance` re-derives (does not
 *   share) pre-tool-recall.js's `o.importance >= 2` gate; pass 0 to disable.
 * @returns {Array<{id:number,type:string,title:string,importance:number,lesson_learned:string|null}>}
 */
export function fileEdgeMatchOnly(db, filePath, project, { minImportance = 2 } = {}) {
  return db
    .prepare(
      `
    SELECT DISTINCT o.id, o.type, o.title, o.importance, o.lesson_learned
    FROM observations o
    JOIN observation_files of2 ON of2.obs_id = o.id
    WHERE o.project = ?
      AND COALESCE(o.importance, 1) >= ?
      AND ${fileMatchClause('of2')}
    ORDER BY o.created_at_epoch DESC
  `,
    )
    .all(project, minImportance, ...fileMatchParams(filePath));
}

/**
 * Wall-clock cap for a test waiting on a spawned subprocess (MAIN-2, surfaced during the
 * 2026-08-29 audit follow-up).
 *
 * Fourteen suites had independently copy-pasted a bare `5000`. That cap is not an
 * assertion about the product — hang protection is already owned by vitest's
 * `testTimeout: 20000` in vitest.config.mjs, and the inner timer exists only to fail with
 * a message that names WHICH round trip stalled instead of a generic test timeout. So the
 * cap's only job is to be loose enough never to fire on a machine that is merely busy.
 *
 * 5000 was not. Measured on this host: an MCP `initialize` round trip against a cold
 * `node server.mjs` (native binding load + schema init included) takes 635ms idle — a
 * 7.9x margin — and the cap still lost once in five full-suite runs, on 24 cores with 311
 * test files in flight. The failure was the spawn being starved of CPU, not a slow server,
 * which is the same "green depends on host load" defect class as the audit's MAIN-1 and
 * pollutes the same `tests green` release gate.
 *
 * 15s sits under the 20s testTimeout, so the specific inner error is still what a reader
 * sees, while a genuinely hung subprocess fails just as reliably — 10s later. Override
 * with MEM_TEST_SUBPROCESS_TIMEOUT_MS on a slower host.
 */
export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 15000;

/**
 * Resolution rule, exported separately so it can be asserted without re-importing this
 * module under a stubbed env (vite refuses a cache-busting query on a static specifier).
 * Anything not a positive finite number falls back — `''`, `'abc'`, `'0'` and `'-1'` all
 * coerce in ways that would otherwise produce a 0ms or NaN timer.
 */
export function resolveSubprocessTimeout(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SUBPROCESS_TIMEOUT_MS;
}

export const SUBPROCESS_TIMEOUT_MS = resolveSubprocessTimeout(process.env.MEM_TEST_SUBPROCESS_TIMEOUT_MS);
