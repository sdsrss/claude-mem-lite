// lib/browse-core.mjs — shared data collection for the CLI `browse` / MCP
// `mem_browse` twin (P2-12, audit 2026-08-14). The tier count + row queries were
// duplicated and had already drifted (the CLI SELECT carried `importance`, the
// MCP one had dropped it). Collection lives here with the superset column shape;
// each face keeps its own rendering (text dashboard vs --json vs MCP text).

import { TIER_CASE_SQL, tierSqlParams } from '../tier.mjs';
import { liveObsFilterSql } from './inject-search-core.mjs';

export const BROWSE_TIERS = ['working', 'active', 'archive'];
export const BROWSE_TIER_LABELS = {
  working: '🔴 Working Memory',
  active: '🟡 Active Memory',
  archive: '🔵 Archive',
};

/** Newest active memory_session_id for the project ('' when none) — the tier
 *  classifier's "current session" input, needed identically by both faces. */
export function getActiveMemorySessionId(db, project) {
  const row = db
    .prepare(
      "SELECT memory_session_id FROM sdk_sessions WHERE project = ? AND status = 'active' ORDER BY started_at_epoch DESC LIMIT 1",
    )
    .get(project);
  return row?.memory_session_id ?? '';
}

/**
 * Collect per-tier counts + rows for the memory dashboard.
 * Archive keeps its count but skips row fetch in the unfiltered view (both faces'
 * documented behavior — the archive tail is reachable via `browse --tier archive`).
 * @returns {{showTiers: string[], tierData: object, tierCounts: object, grandTotal: number}}
 */
export function collectBrowseTiers(db, { project, tierFilter, limit, now, currentSessionId }) {
  const ctx = { now, currentProject: project, currentSessionId };
  const params = tierSqlParams(ctx);
  const showTiers = tierFilter ? [tierFilter] : BROWSE_TIERS;

  const tierData = {};
  const tierCounts = {};
  let grandTotal = 0;

  for (const tier of showTiers) {
    const countRow = db
      .prepare(
        `
      SELECT COUNT(*) as c FROM (
        SELECT ${TIER_CASE_SQL} as tier FROM observations
        WHERE project = ? AND ${liveObsFilterSql('')}
      ) WHERE tier = ?
    `,
      )
      .get(...params, project, tier);
    const count = countRow?.c ?? 0;
    tierCounts[tier] = count;
    grandTotal += count;

    const skipRows = tier === 'archive' && !tierFilter;
    if (count === 0 || skipRows) {
      tierData[tier] = { count, rows: [] };
      continue;
    }

    const rows = db
      .prepare(
        `
      SELECT * FROM (
        SELECT id, type, title, importance, created_at, created_at_epoch, ${TIER_CASE_SQL} as tier
        FROM observations
        WHERE project = ? AND ${liveObsFilterSql('')}
      ) WHERE tier = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `,
      )
      .all(...params, project, tier, limit);
    tierData[tier] = { count, rows };
  }

  return { showTiers, tierData, tierCounts, grandTotal };
}
