// Shared "most recent live observations" core for cmdRecent (CLI `recent`) and
// runRecent (MCP mem_recent).
//
// `recent` was the last retrieval command still hand-building its query on both
// surfaces: the live-rows filter (COALESCE(compressed_into,0)=0 AND superseded_at
// IS NULL), the optional project/type/since predicates, and the newest-first
// ORDER BY + LIMIT existed twice, kept in sync by nothing. That WHERE-clause class
// of drift has recurred three times (CHANGELOG v2.91.0 / v2.92.0 / v3.42.0), which
// is why search / timeline / recall were each extracted to a core
// (lib/search-core.mjs, lib/timeline-core.mjs, lib/recall-core.mjs). Same shape here:
// the data contract lives in this file, argument parsing and rendering stay per-surface.
//
// Columns are the SUPERSET of what the two renderers read (CLI wants `importance`,
// MCP wants `project`) — same convention as recall-core, so neither surface needs
// its own SELECT list.

import { liveObsFilterSql } from './inject-search-core.mjs';

const RECENT_COLS = 'id, type, title, subtitle, importance, project, created_at, created_at_epoch';

// Upper bound on rows a single `recent` call may pull, shared so the cap can't
// drift between surfaces. Pre-extraction this literal lived only in cmdRecent
// (where the positional [N] path had once skipped it entirely, letting
// `recent 999999` issue an uncapped full-table dump); mem_recent relied solely on
// its zod max(100). Clamping here means neither surface can regrow that footgun.
export const RECENT_MAX = 1000;

/**
 * Most recent live observations, newest first.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string|null} [opts.project]  Exact project key (already resolved by the caller).
 * @param {string|null} [opts.type]     Observation type (already validated by the caller).
 * @param {number|null} [opts.since]    Epoch-ms lower bound on created_at. Each surface
 *   parses its own duration flag (`--since` / `date_since`) because the error dialects
 *   differ (CLI fail() vs MCP throw); only the resolved bound crosses into the core.
 * @param {number} [opts.limit=10]      Clamped to [1, RECENT_MAX].
 * @returns {object[]} rows carrying RECENT_COLS
 */
export function fetchRecent(db, { project = null, type = null, since = null, limit = 10 } = {}) {
  const params = [];
  const wheres = [liveObsFilterSql('')];
  if (project) {
    wheres.push('project = ?');
    params.push(project);
  }
  if (type) {
    wheres.push('type = ?');
    params.push(type);
  }
  if (Number.isFinite(since)) {
    wheres.push('created_at_epoch >= ?');
    params.push(since);
  }

  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, RECENT_MAX) : 10;
  params.push(safeLimit);

  return db
    .prepare(
      `
    SELECT ${RECENT_COLS}
    FROM observations
    WHERE ${wheres.join(' AND ')}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `,
    )
    .all(...params);
}
