// tier.mjs — Virtual three-tier memory classification engine
// Computes tier (working/active/archive) from existing observation fields.
// No database dependencies — pure functions + SQL expression.

import { DECAY_HALF_LIFE_BY_TYPE } from './utils.mjs';

import { DAY_MS } from './lib/time-constants.mjs';
// ─── Constants ────────────────────────────────────────────────────────────────

const TWO_HOURS_MS = 2 * 3600000;

/** Active window = 2x decay half-life per type (ms) */
export const ACTIVE_WINDOWS = Object.fromEntries(
  Object.entries(DECAY_HALF_LIFE_BY_TYPE).map(([type, hl]) => [type, hl * 2]),
);
const DEFAULT_ACTIVE_WINDOW_MS = DECAY_HALF_LIFE_BY_TYPE.change * 2;

// ─── JavaScript Tier Classification ──────────────────────────────────────────

/**
 * Compute tier for a single observation row.
 * @param {object} obs - Row from observations table
 * @param {object} ctx - { now, currentProject, currentSessionId }
 * @returns {'working' | 'active' | 'archive'}
 */
export function computeTier(obs, ctx) {
  const { now, currentProject, currentSessionId } = ctx;

  // Rule 1: Archive if compressed or superseded
  if ((obs.compressed_into ?? 0) !== 0) return 'archive';
  if (obs.superseded_at !== null && obs.superseded_at !== undefined) return 'archive';

  // Rule 2: Working if same session
  if (currentSessionId && obs.memory_session_id === currentSessionId) return 'working';

  const twoHoursAgo = now - TWO_HOURS_MS;

  // Rule 3: Working if same project + high importance + recently accessed
  if (obs.project === currentProject && (obs.importance ?? 1) >= 2 && obs.last_accessed_at >= twoHoursAgo) {
    return 'working';
  }

  // Rule 4: Working if same project + recently created
  if (obs.project === currentProject && obs.created_at_epoch >= twoHoursAgo) {
    return 'working';
  }

  // Rule 5: Active if within type-specific window. Use `<=` so the exact-millisecond
  // window edge matches TIER_CASE_SQL (`created_at_epoch >= now - window`, i.e. inclusive).
  // The strict `<` here disagreed with the SQL classifier by one tier at the boundary,
  // despite both being documented as the same classifier.
  const activeWindow = ACTIVE_WINDOWS[obs.type] ?? DEFAULT_ACTIVE_WINDOW_MS;
  if (now - obs.created_at_epoch <= activeWindow) return 'active';

  // Rule 6: Archive (fallback)
  return 'archive';
}

// ─── SQL CASE Expression ────────────────────────────────────────────────────

/**
 * SQL CASE expression for inline tier computation.
 * Params: see tierSqlParams().
 */
export const TIER_CASE_SQL = `(CASE
  WHEN COALESCE(compressed_into, 0) != 0 THEN 'archive'
  WHEN superseded_at IS NOT NULL THEN 'archive'
  WHEN memory_session_id = ? THEN 'working'
  WHEN project = ? AND COALESCE(importance, 1) >= 2 AND last_accessed_at >= ? THEN 'working'
  WHEN project = ? AND created_at_epoch >= ? THEN 'working'
  WHEN type = 'decision'  AND created_at_epoch >= ? THEN 'active'
  WHEN type = 'discovery' AND created_at_epoch >= ? THEN 'active'
  WHEN type = 'feature'   AND created_at_epoch >= ? THEN 'active'
  WHEN type = 'bugfix'    AND created_at_epoch >= ? THEN 'active'
  WHEN type = 'refactor'  AND created_at_epoch >= ? THEN 'active'
  WHEN type = 'change'    AND created_at_epoch >= ? THEN 'active'
  -- Default-window fallthrough is for UNKNOWN/null types ONLY, mirroring
  -- computeTier's ACTIVE_WINDOWS[type] with a DEFAULT fallback (a KNOWN type
  -- never takes the fallback). Without the type guard, a known type whose window
  -- was configured SHORTER than the default would wrongly re-qualify as 'active'
  -- here after its own window expired — diverging from the JS classifier.
  -- The "type IS NULL" arm keeps null-type rows on the default window (JS parity).
  WHEN (type IS NULL OR type NOT IN ('decision','discovery','feature','bugfix','refactor','change'))
       AND created_at_epoch >= ? THEN 'active'
  ELSE 'archive'
END)`;

/**
 * Build params array for TIER_CASE_SQL.
 * @param {object} ctx - { now, currentProject, currentSessionId }
 * @returns {any[]}
 */
export function tierSqlParams(ctx) {
  const { now, currentProject, currentSessionId } = ctx;
  const twoHoursAgo = now - TWO_HOURS_MS;
  return [
    currentSessionId ?? '',
    currentProject ?? '',
    twoHoursAgo,
    currentProject ?? '',
    twoHoursAgo,
    now - ACTIVE_WINDOWS.decision,
    now - ACTIVE_WINDOWS.discovery,
    now - ACTIVE_WINDOWS.feature,
    now - ACTIVE_WINDOWS.bugfix,
    now - ACTIVE_WINDOWS.refactor,
    now - ACTIVE_WINDOWS.change,
    now - DEFAULT_ACTIVE_WINDOW_MS,
  ];
}

// ─── Relative Time Formatting ───────────────────────────────────────────────

/**
 * Format epoch as relative time string (e.g., "5min ago", "3d ago").
 * @param {number} epoch - Timestamp in milliseconds
 * @param {number} now - Current time in milliseconds
 * @returns {string}
 */
export function relativeTime(epoch, now) {
  // Clamp negative diffs: a future / clock-skewed epoch must not render as a
  // negative duration ("-7200s ago"). The first branch below (diff < 60000)
  // would otherwise fire on any negative diff and print Math.floor(diff/1000),
  // i.e. "-7200s ago" for a 2h-future timestamp. (cli/common.mjs's sibling
  // relativeTime handles this via an early `diff < 0` → "just now".)
  const diff = Math.max(0, now - epoch);
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}min ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 30 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
  return `${Math.floor(diff / (30 * DAY_MS))}mo ago`;
}
