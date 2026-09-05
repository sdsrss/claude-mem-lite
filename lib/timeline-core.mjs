// Shared "timeline around an anchor" core.
//
// Single source of truth for cmdTimeline (CLI) and mem_timeline (MCP). Pre-
// extraction the anchor-resolution ladder (P#/S# token → nearest obs,
// bare int → obs with compressed_into re-anchor → prompt/session fallback),
// the query-anchor wrapper around findFtsAnchor, and the before/after window
// queries were copy-pasted across both and kept in sync by hand-written
// "aligned with" comments — the same drift vector compress-core (ARCH-1) and
// recall-core were extracted to close. Call sites keep what legitimately
// differs: argument parsing, output rendering (CLI relativeTime text / JSON vs
// MCP fmtDate lines), and error-message dialect (formatAnchorError owns both
// dialects so the wording cannot drift independently).

import { parseIdToken } from './id-routing.mjs';
import { findFtsAnchor } from '../search-engine.mjs';
import { sanitizeFtsQuery } from '../utils.mjs';
import { liveObsFilterSql } from './inject-search-core.mjs';

const TIMELINE_COLS = 'id, type, title, subtitle, project, created_at, created_at_epoch';

/** Nearest live (non-compressed, non-superseded) observation to `epoch`. */
function nearestObservation(db, epoch, project) {
  return db
    .prepare(
      `
    SELECT id FROM observations
    WHERE ${liveObsFilterSql('')} ${project ? 'AND project = ?' : ''}
    ORDER BY ABS(created_at_epoch - ?) ASC LIMIT 1
  `,
    )
    .get(...(project ? [project, epoch] : [epoch]));
}

/**
 * Resolve a raw anchor token (number, "N", "#N", "P#N", "S#N") to an
 * observation id. Prompt/session anchors resolve to the nearest-in-time
 * observation so before/after semantics still apply; compressed observations
 * re-anchor to their live parent (negative sentinels error — no canonical
 * parent); bare ints that miss observations fall back to prompt, then session.
 *
 * @returns {{ ok: true, anchorId: number, anchorNote: string|null }
 *         | { ok: false, error: object }}  — render error via formatAnchorError
 */
export function resolveAnchorToken(db, rawAnchor, { project = null } = {}) {
  const parsed = parseIdToken(rawAnchor);
  if (!parsed) {
    return { ok: false, error: { code: 'invalid-token', raw: rawAnchor } };
  }

  if (parsed.source === 'prompt' || parsed.source === 'session') {
    const srcTable = parsed.source === 'prompt' ? 'user_prompts' : 'session_summaries';
    const srcPrefix = parsed.source === 'prompt' ? 'P#' : 'S#';
    const srcName = parsed.source === 'prompt' ? 'Prompt' : 'Session';
    const row = db.prepare(`SELECT created_at_epoch FROM ${srcTable} WHERE id = ?`).get(parsed.id);
    if (!row)
      return {
        ok: false,
        error: { code: 'source-not-found', name: srcName, prefix: srcPrefix, id: parsed.id },
      };
    const nearest = nearestObservation(db, row.created_at_epoch, project);
    if (!nearest) return { ok: false, error: { code: 'no-obs-near', prefix: srcPrefix, id: parsed.id } };
    return {
      ok: true,
      anchorId: nearest.id,
      anchorNote: `(anchored to #${nearest.id}, closest obs to ${srcPrefix}${parsed.id})`,
    };
  }

  // Events are the canonical event-typed store (E#N in mem_search output). They have no
  // place in the obs-centric before/after window, so — like prompt/session — anchor to the
  // nearest observation by epoch. Without this explicit branch an E#N token would fall through
  // to the bare-int obs lookup below and silently resolve to the COLLIDING observation id.
  if (parsed.source === 'event') {
    const row = db.prepare('SELECT created_at_epoch FROM events WHERE id = ?').get(parsed.id);
    if (!row)
      return { ok: false, error: { code: 'source-not-found', name: 'Event', prefix: 'E#', id: parsed.id } };
    const nearest = nearestObservation(db, row.created_at_epoch, project);
    if (!nearest) return { ok: false, error: { code: 'no-obs-near', prefix: 'E#', id: parsed.id } };
    return {
      ok: true,
      anchorId: nearest.id,
      anchorNote: `(anchored to #${nearest.id}, closest obs to E#${parsed.id})`,
    };
  }

  // Bare "#N" or "N" — observation first. Route compressed obs to its live
  // parent so the window (which filters compressed) isn't shown around a dead
  // record; negative sentinels (-1 dropped, -2 pending purge) have no parent.
  const obsRow = db
    .prepare('SELECT compressed_into, superseded_at, superseded_by FROM observations WHERE id = ?')
    .get(parsed.id);
  if (obsRow) {
    const ci = obsRow.compressed_into;
    if (ci && ci > 0) {
      return {
        ok: true,
        anchorId: ci,
        anchorNote: `(anchored to #${ci}, #${parsed.id} was compressed into it)`,
      };
    }
    if (ci && ci < 0) {
      return { ok: false, error: { code: 'compressed-pruned', id: parsed.id } };
    }
    // Superseded obs → hop to its live successor, mirroring compressed→parent. A
    // superseded row is dropped from every other read path (and from the before/after
    // window legs below), so anchoring ON it would surface a dead record. superseded_by
    // is polymorphic: a numeric obs id for explicit supersession (save-observation), or a
    // string marker ('auto-dedup'/'auto-dedup-fuzzy') for hook auto-dedup — only the
    // numeric case has a successor to redirect to, so guard on `typeof … number` (not
    // `> 0`, which a string sentinel would silently pass as NaN→false anyway but reads wrong).
    if (
      obsRow.superseded_at !== null &&
      typeof obsRow.superseded_by === 'number' &&
      obsRow.superseded_by > 0
    ) {
      return {
        ok: true,
        anchorId: obsRow.superseded_by,
        anchorNote: `(anchored to #${obsRow.superseded_by}, #${parsed.id} was superseded by it)`,
      };
    }
    return { ok: true, anchorId: parsed.id, anchorNote: null };
  }

  // Fall back to user_prompts then session_summaries so pasted P#/S# ids still
  // work when the prefix is omitted — matches prefix-aware routing in search/probe.
  const promptRow = db.prepare('SELECT created_at_epoch FROM user_prompts WHERE id = ?').get(parsed.id);
  const sessionRow = promptRow
    ? null
    : db.prepare('SELECT created_at_epoch FROM session_summaries WHERE id = ?').get(parsed.id);
  const hit = promptRow
    ? { row: promptRow, prefix: 'P#', name: 'prompt' }
    : sessionRow
      ? { row: sessionRow, prefix: 'S#', name: 'session' }
      : null;
  if (!hit) return { ok: false, error: { code: 'id-not-found', id: parsed.id } };
  const nearest = nearestObservation(db, hit.row.created_at_epoch, project);
  if (!nearest)
    return {
      ok: false,
      error: { code: 'no-obs-near', prefix: hit.prefix, id: parsed.id, srcName: hit.name },
    };
  return {
    ok: true,
    anchorId: nearest.id,
    anchorNote: `(anchored to #${nearest.id}, closest obs to ${hit.prefix}${parsed.id})`,
  };
}

/**
 * Render a resolveAnchorToken error in either caller dialect. Owning BOTH
 * renderings here is deliberate: the strings are regression-anchored on each
 * side (tests/cli.test.mjs, tests/server.test.mjs) and previously drifted only
 * in prefix/period; one table keeps the divergence explicit and frozen.
 *
 * cli: "[mem] "-prefixed, no trailing period, flag spelled "--anchor".
 * mcp: bare sentence with trailing period.
 */
export function formatAnchorError(error, dialect) {
  const cli = dialect === 'cli';
  switch (error.code) {
    case 'invalid-token':
      return cli
        ? `[mem] Invalid --anchor "${error.raw}". Expected N, #N, P#N, or S#N.`
        : `Invalid anchor "${error.raw}". Expected N, #N, P#N, or S#N.`;
    case 'source-not-found':
      return cli
        ? `[mem] ${error.name} ${error.prefix}${error.id} not found`
        : `${error.name} ${error.prefix}${error.id} not found.`;
    case 'no-obs-near': {
      const suffix = error.srcName ? ` (${error.srcName})` : '';
      return cli
        ? `[mem] No observations near ${error.prefix}${error.id}${suffix}`
        : `No observations near ${error.prefix}${error.id}${suffix}.`;
    }
    case 'compressed-pruned':
      return cli
        ? `[mem] Observation #${error.id} was compressed and pruned; no canonical anchor available`
        : `Observation #${error.id} was compressed and pruned; no canonical anchor available.`;
    case 'id-not-found':
      return cli
        ? `[mem] Observation, prompt, or session with id ${error.id} not found`
        : `Observation, prompt, or session with id ${error.id} not found.`;
    default:
      return cli ? `[mem] Anchor resolution failed` : 'Anchor resolution failed.';
  }
}

/**
 * Query-based anchor: route through shared findFtsAnchor so CLI
 * `timeline --query` and MCP mem_timeline keep identical AND→OR fallback
 * semantics (#8217). Returns null when the query sanitizes to nothing or
 * matches no row; anchorNote is set only when the OR relaxation fired.
 */
export function resolveQueryAnchor(db, queryStr, { project = null } = {}) {
  const ftsQuery = sanitizeFtsQuery(queryStr);
  const found = findFtsAnchor(db, { ftsQuery, project });
  if (!found) return null;
  return {
    anchorId: found.id,
    anchorNote: found.relaxed ? `(query "${queryStr}" relaxed AND→OR — no row matched all terms)` : null,
  };
}

/** No-anchor fallback: most recent live (non-compressed, non-superseded) obs, newest first. */
export function fetchRecentTimeline(db, { project = null, limit }) {
  // A superseded row must not lead the "most recent" timeline — same live-row
  // invariant as the before/after window legs (fetchTimelineWindow).
  const liveFilter = liveObsFilterSql('');
  const where = project ? `WHERE ${liveFilter} AND project = ?` : `WHERE ${liveFilter}`;
  const params = project ? [project, limit] : [limit];
  return db
    .prepare(
      `
    SELECT ${TIMELINE_COLS}
    FROM observations ${where}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `,
    )
    .all(...params);
}

/**
 * Fetch the before/after window around a resolved anchor id. Bumps the
 * anchor's access_count (read-path popularity signal), and auto-scopes to the
 * anchor's project when the caller didn't pass one — "timeline around #N"
 * means same-project context, not cross-project time-bleed.
 *
 * @returns {null | { anchor, beforeRows, afterRows, effectiveProject }}
 *   null when the anchor row vanished (e.g. deleted between resolve and fetch).
 *   beforeRows are CHRONOLOGICAL (oldest→newest) — callers no longer reverse.
 */
export function fetchTimelineWindow(db, anchorId, { before, after, project = null }) {
  const anchorRow = db
    .prepare('SELECT created_at_epoch, project FROM observations WHERE id = ?')
    .get(anchorId);
  if (!anchorRow) return null;

  try {
    db.prepare(
      'UPDATE observations SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id = ?',
    ).run(Date.now(), anchorId);
  } catch {
    /* non-critical: FTS5 trigger may fail on corrupted index */
  }

  const effectiveProject = project || anchorRow.project;
  const projectFilter = effectiveProject ? 'AND project = ?' : '';
  const baseParams = effectiveProject ? [effectiveProject] : [];

  const beforeRows = db
    .prepare(
      `
    SELECT ${TIMELINE_COLS}
    FROM observations
    WHERE created_at_epoch < ? AND ${liveObsFilterSql('')} ${projectFilter}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `,
    )
    .all(anchorRow.created_at_epoch, ...baseParams, before)
    .reverse();

  const afterRows = db
    .prepare(
      `
    SELECT ${TIMELINE_COLS}
    FROM observations
    WHERE created_at_epoch > ? AND ${liveObsFilterSql('')} ${projectFilter}
    ORDER BY created_at_epoch ASC
    LIMIT ?
  `,
    )
    .all(anchorRow.created_at_epoch, ...baseParams, after);

  const anchor = db.prepare(`SELECT ${TIMELINE_COLS} FROM observations WHERE id = ?`).get(anchorId);

  return { anchor, beforeRows, afterRows, effectiveProject };
}
