// lib/browse-core.mjs — shared data collection for the CLI `browse` / MCP
// `mem_browse` twin (P2-12, audit 2026-08-14). The tier count + row queries were
// duplicated and had already drifted (the CLI SELECT carried `importance`, the
// MCP one had dropped it). Collection lives here with the superset column shape;
// each face keeps its own rendering (text dashboard vs --json vs MCP text).

import { TIER_CASE_SQL, tierSqlParams } from '../tier.mjs';
import { liveObsFilterSql } from './inject-search-core.mjs';
import { HOOK_SESSION_ID_PREFIX } from './provenance.mjs';

export const BROWSE_TIERS = ['working', 'active', 'archive'];
export const BROWSE_TIER_LABELS = {
  working: '🔴 Working Memory',
  active: '🟡 Active Memory',
  archive: '🔵 Archive',
};

/** Newest active hook session id for the project ('' when none) — the tier classifier's
 *  "current session" input, needed identically by both faces. Only the hook's own sessions
 *  count: a writer's row (`manual-`, `compress-`, …) is inserted active on that writer's first
 *  write in a project and stays active until the 24h sweep, so taken as the current session it
 *  put all of that writer's rows, of any age, in the working tier (D#153).
 *  From a session's first Stop its own row is no longer active (Stop marks it completed on every
 *  turn and nothing marks it active again), so this is '' or another hook session of the project
 *  still marked active (a parallel one, or one that ended without a Stop); tier rule 2 holds for
 *  the session in progress only before its first reply, and rules 3-4 carry its rows of the last
 *  2 hours. Accepted (D#161): measured 2026-09-28, 1 row in this machine's database was one
 *  rule 2 alone would have kept in the working tier; hook sessions had written 12 of 238 rows. */
export function getActiveMemorySessionId(db, project) {
  const row = db
    .prepare(
      "SELECT memory_session_id FROM sdk_sessions WHERE project = ? AND status = 'active' AND memory_session_id LIKE ? ORDER BY started_at_epoch DESC LIMIT 1",
    )
    .get(project, `${HOOK_SESSION_ID_PREFIX}%`);
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
      ORDER BY created_at_epoch DESC, id DESC
      LIMIT ?
    `,
      )
      .all(...params, project, tier, limit);
    tierData[tier] = { count, rows };
  }

  return { showTiers, tierData, tierCounts, grandTotal };
}
