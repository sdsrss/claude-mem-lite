// Shared probe for "ID-not-found-in-requested-source" hints + shared token
// parser. Used by CLI (mem-cli.mjs, cli/common.mjs re-export) and MCP
// (server.mjs) so both paths stay aligned — parity per #8050.
//
// The formatter stays per-call-site because CLI and MCP surface format
// differently (stderr vs response text); only the SQL + token-parse layers
// are shared.

// ─── ID Token Parsing ────────────────────────────────────────────────────────

/**
 * Parse an ID token as it appears in search output or CLI positional args.
 * Accepts: `123`, `#123`, `P#123` / `p123` (prompt), `S#123` / `s123` (session),
 * `E#123` / `e123` (event — the canonical event-typed store surfaced as `E#N` by mem_search).
 * @param {unknown} raw
 * @returns {{ source: 'obs'|'session'|'prompt'|'event'|null, id: number } | null}
 *   source===null means no explicit prefix — caller picks default (typically 'obs').
 */
export function parseIdToken(raw) {
  const m = /^([EePpSs]?)#?(\d+)$/.exec(String(raw).trim());
  if (!m) return null;
  const p = m[1].toUpperCase();
  const id = parseInt(m[2], 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const source = p === 'P' ? 'prompt' : p === 'S' ? 'session' : p === 'E' ? 'event' : null;
  return { source, id };
}

/**
 * Group mixed ID tokens by source. Accepts bare ints, `#N`, `P#N`, `S#N`,
 * and raw strings — the same shapes parseIdToken handles. Used by CLI
 * cmdGet and MCP mem_get so both paths route paste-from-search tokens
 * consistently (closes the #8127 parity gap).
 *
 * An explicit source override (from `--source` or `args.source`) wins over
 * per-token prefixes. Un-prefixed tokens fall back to `defaultSource`.
 *
 * @param {Array<string|number>} tokens Mixed input — order preserved within each bucket.
 * @param {{explicit?: 'obs'|'session'|'prompt'|'event'|null, defaultSource?: 'obs'|'session'|'prompt'|'event'}} opts
 * @returns {{bySrc: {obs:number[], session:number[], prompt:number[], event:number[]}, invalid: string[]}}
 */
export function bucketIdTokens(tokens, { explicit = null, defaultSource = 'obs' } = {}) {
  const bySrc = { obs: [], session: [], prompt: [], event: [] };
  const invalid = [];
  for (const raw of tokens) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      bySrc[explicit || defaultSource].push(raw);
      continue;
    }
    const p = parseIdToken(raw);
    if (!p) {
      invalid.push(String(raw));
      continue;
    }
    const src = explicit || p.source || defaultSource;
    bySrc[src].push(p.id);
  }
  return { bySrc, invalid };
}

/**
 * Peel D#N deferred-work tokens off a mixed get-token list BEFORE bucketing.
 * D# is a get-only read surface: deferred rows live outside the observation
 * timeline, so they never enter bucketIdTokens' obs/session/prompt/event
 * buckets, are exempt from `source` forcing, and stay rejected by the
 * delete/timeline schemas. Requires the `#` (bare "D92" is prose, not a token).
 *
 * @param {Array<string|number>} tokens Mixed input
 * @returns {{deferredIds: number[], rest: Array<string|number>}} deferredIds
 *   deduped in input order; rest preserved for bucketIdTokens.
 */
export function splitDeferredTokens(tokens) {
  const deferredIds = [];
  const rest = [];
  for (const raw of tokens) {
    const m = typeof raw === 'string' ? /^[Dd]#(\d+)$/.exec(raw.trim()) : null;
    if (m) {
      const id = parseInt(m[1], 10);
      if (id > 0 && !deferredIds.includes(id)) deferredIds.push(id);
    } else {
      rest.push(raw);
    }
  }
  return { deferredIds, rest };
}

/**
 * Probe the observations / session_summaries / user_prompts tables for any
 * of the given numeric IDs, excluding the sources the caller already queried.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} ids Numeric IDs to probe (non-negative ints).
 * @param {Set<'obs'|'session'|'prompt'|'event'>} excludeSrcs Sources to skip.
 * @returns {{obs:number[], session:number[], prompt:number[], event:number[]}}
 */
export function probeOtherSources(db, ids, excludeSrcs) {
  const result = { obs: [], session: [], prompt: [], event: [] };
  if (!ids || ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(',');
  try {
    if (!excludeSrcs.has('obs')) {
      const hits = db.prepare(`SELECT id FROM observations WHERE id IN (${placeholders})`).all(...ids);
      result.obs = hits.map((r) => r.id);
    }
    if (!excludeSrcs.has('session')) {
      const hits = db.prepare(`SELECT id FROM session_summaries WHERE id IN (${placeholders})`).all(...ids);
      result.session = hits.map((r) => r.id);
    }
    if (!excludeSrcs.has('prompt')) {
      const hits = db.prepare(`SELECT id FROM user_prompts WHERE id IN (${placeholders})`).all(...ids);
      result.prompt = hits.map((r) => r.id);
    }
    if (!excludeSrcs.has('event')) {
      const hits = db.prepare(`SELECT id FROM events WHERE id IN (${placeholders})`).all(...ids);
      result.event = hits.map((r) => r.id);
    }
  } catch {
    /* best-effort hint; never block the caller */
  }
  return result;
}
