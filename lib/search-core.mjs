// Shared cross-source search core for cmdSearch (CLI) and mem_search (MCP).
//
// coreRunSearchPipeline (below) is the SINGLE orchestration body — deep /
// auto-escalation → per-source query (obs hybrid + sessions + prompts) →
// cross-source normalize+sort → context re-rank + supersede → tier filter →
// user sort → count+paginate. The two ~180-line bodies that cmdSearch and
// runSearchPipeline used to keep hand-synced via "paired-path" comments are
// gone (audit P1-2); each surface is now a thin adapter that parses/validates
// in and renders out. Cross-surface equivalence is enforced by
// tests/search-parity.test.mjs, not by comments.
//
// Surfaces legitimately differ on a few policy points; each is an explicit opt
// on coreRunSearchPipeline (obsTypeFallback / crossSourceEpochSortNoFts /
// rerankPolicy / recentListingNoFts / tolerateMissingFts / tierPosition …) so
// behavior is strictly preserved and any future convergence is a deliberate
// change, not an accident. Notable preserved asymmetries:
//   • CLI forces source=observations for --type/--tier/--importance/--branch;
//     MCP only forces it for obs_type. (effectiveSource is computed per-adapter.)
//   • CLI warns on inverted --from/--to ranges; MCP does not.
//   • CLI tolerates missing session/prompt FTS (pre-FTS legacy DBs); MCP does not.
//   • MCP lists-recent-by-type on a 0-match obs_type query; CLI does not (#8217).
//
// Result rows use one canonical `source` key; session/prompt rows carry dual
// keys (date=created_at, text=prompt_text, session=content_session_id) so each
// surface's renderer reads its own field names off a single row shape.

import { sanitizeFtsQuery, relaxFtsQueryToOr, SESS_BM25, EVT_BM25, DEFAULT_DECAY_HALF_LIFE_MS } from '../utils.mjs';
import { cjkPrecisionOk, extractCjkLikePatterns } from '../nlp.mjs';
import { computeTier } from '../tier.mjs';
import { countSearchTotal, attachBodyTokens } from '../search-engine.mjs';
import { notLowSignalTitleClause } from '../scoring-sql.mjs';
import { liveObsFilterSql, recencyDecaySql } from './inject-search-core.mjs';

import { DAY_MS } from './time-constants.mjs';
/** Sanitize a user query to FTS5 syntax; optionally force OR semantics. */
export function buildSearchFtsQuery(query, { or = false } = {}) {
  let ftsQuery = sanitizeFtsQuery(query);
  if (ftsQuery && or) ftsQuery = relaxFtsQueryToOr(ftsQuery) || ftsQuery;
  return ftsQuery;
}

// Relative-duration units for `--since`. Months/years intentionally omitted —
// they're calendar-ambiguous; absolute --from/--to cover longer windows.
const DURATION_UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: DAY_MS, w: 604800000 };

/**
 * Parse a relative duration like "7d", "24h", "90m", "2w", "30s" into ms.
 * Integer magnitude + single unit only (s/m/h/d/w, case-insensitive).
 * @returns {{ ok: true, ms: number } | { ok: false }}
 */
export function parseDuration(raw) {
  if (typeof raw !== 'string') return { ok: false };
  const m = raw.trim().match(/^(\d+)\s*([smhdw])$/i);
  if (!m) return { ok: false };
  const n = parseInt(m[1], 10);
  if (!Number.isInteger(n) || n <= 0) return { ok: false };
  return { ok: true, ms: n * DURATION_UNIT_MS[m[2].toLowerCase()] };
}

/**
 * Parse one from/to bound to epoch ms. A bare `YYYY-MM-DD` is the user's LOCAL
 * calendar day (created_at_epoch is Date.now() = local wall-clock), so it must be
 * built in local time — `new Date('YYYY-MM-DD')` parses as UTC midnight and shifts the
 * boundary by the tz offset (8h for the UTC+8 base), silently dropping early-morning
 * rows and leaking the next day's early hours. `endOfDay` extends a date-only bound to
 * 23:59:59.999 local (the inclusive `--to` day). Full ISO 8601 (with time/offset) is
 * parsed as-is, honoring any explicit zone. Out-of-range date-only strings return NaN so
 * the caller's isNaN guard rejects them (matches the old UTC parse's strict Invalid Date).
 */
function parseCalendarBound(raw, endOfDay) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number);
    const dt = endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
    // new Date(2026, 12, 45) silently rolls over; reject so 2026-13-45 fails like before.
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return NaN;
    return dt.getTime();
  }
  return new Date(raw).getTime();
}

/**
 * Parse from/to date bounds to epoch ms. Date-only `to` (YYYY-MM-DD) extends
 * to end-of-day so "to 2026-06-12" includes that day's rows. An optional
 * relative `sinceRaw` ("7d") sets the lower bound when no absolute `--from`
 * is given; an explicit `--from` always wins (it's the more specific signal).
 * @returns {{ ok: true, epochFrom: number|null, epochTo: number|null }
 *         | { ok: false, bad: 'from'|'to'|'since', value: string }}
 */
export function parseDateBounds(fromRaw, toRaw, sinceRaw = null, now = Date.now()) {
  let epochFrom = fromRaw ? parseCalendarBound(fromRaw, false) : null;
  const epochTo = toRaw ? parseCalendarBound(toRaw, true) : null;
  if (epochFrom !== null && isNaN(epochFrom)) return { ok: false, bad: 'from', value: fromRaw };
  if (epochTo !== null && isNaN(epochTo)) return { ok: false, bad: 'to', value: toRaw };
  if (sinceRaw) {
    const d = parseDuration(sinceRaw);
    if (!d.ok) return { ok: false, bad: 'since', value: sinceRaw };
    if (epochFrom === null) epochFrom = now - d.ms; // explicit --from takes precedence
  }
  return { ok: true, epochFrom, epochTo };
}

/**
 * Over-fetch window: every source fetches from offset 0 and the caller slices
 * [offset, offset+limit) exactly ONCE post-merge. Pushing OFFSET into the
 * per-source SQL double-applied it and gapped/overlapped pages, because the
 * obs hybrid path (AND→OR fallback / vector / concept stages) re-adds rows the
 * SQL OFFSET already skipped (#8217/#8638).
 *
 * D#30 re-audit (reopened): perSourceLimit MUST be offset-independent. The old
 * `offset + limit + 10` term grew the pool for deeper pages, and because RRF
 * fusion of FTS + vector ranks is candidate-pool-sensitive (an item present in
 * BOTH lists outranks one in a single list), a larger pool RE-RANKS the prefix —
 * so page(offset=0) and page(offset=N) sliced DIFFERENT orderings and overlapped
 * /gapped on the real (vector-populated) DB. #8642 missed this because its guard
 * test seeds no vectors (FTS-only is prefix-stable). The fix makes the pool a
 * function of `limit` only:
 *   - MIN_FUSION_POOL floor (= default limit 20 × the 3× buffer): every limit ≤ 20
 *     fuses ONE 60-candidate pool, so same-limit --offset pages are disjoint/stable
 *     and top-N is limit-stable (top-5 ⊂ top-10 ⊂ top-20). limit=20 offset=0 stays
 *     byte-identical to before (60) → no change on the benchmarked single-page path.
 *   - limit > 20 keeps limit*3 (the over-fetch buffer the fallback stages need).
 * Trade-off: pages beyond the pool now return empty instead of the (overlapping,
 * wrong) rows the offset-scaling used to surface — stability over deep reach.
 */
export const MIN_FUSION_POOL = 60;
// `offset` is kept in the signature: the pool is a REACHABILITY bound, so callers still
// pass an offset and the parameter documents that it is deliberately not applied.
// The directive must sit on the line IMMEDIATELY above the signature, and must not be a
// trailing `disable-line` — a formatter moves that onto the following line, where it no
// longer covers the signature and lint goes red (audit 2026-09-05 P1-3).
// eslint-disable-next-line no-unused-vars
export function computePerSourceWindow(limit, offset) {
  return { perSourceLimit: Math.max(limit * 3, MIN_FUSION_POOL), perSourceOffset: 0 };
}

/** obs-side total query: when the AND→OR fallback fired, count the OR set. */
export function effectiveObsFtsQuery(ftsQuery, orFallbackFired) {
  return orFallbackFired ? (relaxFtsQueryToOr(ftsQuery) || ftsQuery) : ftsQuery;
}

/**
 * Session FTS search with recency decay + same-project boost. Returns raw SQL
 * rows: { id, request, completed, project, created_at, created_at_epoch, score }.
 * `projectBoost` is the inferred current project, only applied when the caller
 * did NOT filter by project explicitly (pass null then).
 */
export function searchSessionsFts(db, { ftsQuery, project = null, projectBoost = null, epochFrom = null, epochTo = null, perSourceLimit, perSourceOffset = 0 }) {
  const wheres = ['session_summaries_fts MATCH ?'];
  const params = [Date.now(), projectBoost, projectBoost, ftsQuery];
  if (project) { wheres.push('s.project = ?'); params.push(project); }
  if (epochFrom !== null) { wheres.push('s.created_at_epoch >= ?'); params.push(epochFrom); }
  if (epochTo !== null) { wheres.push('s.created_at_epoch <= ?'); params.push(epochTo); }
  params.push(perSourceLimit, perSourceOffset);
  return db.prepare(`
    SELECT s.id, s.request, s.completed, s.project, s.created_at, s.created_at_epoch,
           ${SESS_BM25}
             * ${recencyDecaySql({ tsExpr: 's.created_at_epoch', halfLifeSql: `${DEFAULT_DECAY_HALF_LIFE_MS}.0` })}
             * (CASE WHEN ? IS NOT NULL AND s.project = ? THEN 2.0 ELSE 1.0 END) as score
    FROM session_summaries_fts
    JOIN session_summaries s ON session_summaries_fts.rowid = s.id
    WHERE ${wheres.join(' AND ')}
    ORDER BY score
    LIMIT ? OFFSET ?
  `).all(...params);
}

/**
 * Prompt FTS search with CJK precision gate + CJK LIKE fallback. Returns raw
 * SQL rows: { id, prompt_text, content_session_id, created_at,
 * created_at_epoch, score } (fallback rows carry score = 0).
 *
 * The precision gate applies to BOTH paths: unicode61 degrades CJK bigram
 * queries to single-char AND, and the LIKE fallback is an OR'd substring scan
 * — without the gate each re-admits the common-char noise band the other
 * dropped (that asymmetry was the actual leak source: FTS returned 0,
 * fallback filled 20).
 */
export function searchPromptsFts(db, { query, ftsQuery, project = null, epochFrom = null, epochTo = null, perSourceLimit, perSourceOffset = 0 }) {
  const wheres = ['user_prompts_fts MATCH ?', "p.prompt_text NOT LIKE '<task-notification>%'"];
  const params = [ftsQuery];
  if (project) { wheres.push('s.project = ?'); params.push(project); }
  if (epochFrom !== null) { wheres.push('p.created_at_epoch >= ?'); params.push(epochFrom); }
  if (epochTo !== null) { wheres.push('p.created_at_epoch <= ?'); params.push(epochTo); }
  params.push(perSourceLimit, perSourceOffset);
  const rows = db.prepare(`
    SELECT p.id, p.prompt_text, p.content_session_id, p.created_at, p.created_at_epoch,
           bm25(user_prompts_fts, 1) as score
    FROM user_prompts_fts
    JOIN user_prompts p ON user_prompts_fts.rowid = p.id
    JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
    WHERE ${wheres.join(' AND ')}
    ORDER BY score
    LIMIT ? OFFSET ?
  `).all(...params);
  const kept = query ? rows.filter((r) => cjkPrecisionOk(query, r.prompt_text)) : rows;
  if (kept.length > 0 || !query) return kept;

  // CJK LIKE fallback: FTS5 unicode61 can't tokenize CJK substrings in prompts
  const cjkPatterns = extractCjkLikePatterns(query);
  if (cjkPatterns.length === 0) return kept;
  const likeConds = cjkPatterns.map(() => 'p.prompt_text LIKE ?');
  const likeParams = cjkPatterns.map((p) => `%${p}%`);
  if (project) likeParams.push(project);
  if (epochFrom !== null) likeParams.push(epochFrom);
  if (epochTo !== null) likeParams.push(epochTo);
  likeParams.push(perSourceLimit, perSourceOffset);
  const fallbackRows = db.prepare(`
    SELECT p.id, p.prompt_text, p.content_session_id, p.created_at, p.created_at_epoch
    FROM user_prompts p
    JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
    WHERE (${likeConds.join(' OR ')})
      AND p.prompt_text NOT LIKE '<task-notification>%'
      ${project ? 'AND s.project = ?' : ''}
      ${epochFrom !== null ? 'AND p.created_at_epoch >= ?' : ''}
      ${epochTo !== null ? 'AND p.created_at_epoch <= ?' : ''}
    ORDER BY p.created_at_epoch DESC
    LIMIT ? OFFSET ?
  `).all(...likeParams);
  return fallbackRows
    .filter((r) => cjkPrecisionOk(query, r.prompt_text))
    .map((r) => ({ ...r, score: 0 }));
}

/**
 * Event FTS search (events table via events_fts) with recency decay + same-project boost —
 * the mirror of searchSessionsFts for the events source. Events are the CANONICAL store for
 * event-typed memories (persistHaikuSummary upgrade-deletes the pre-saved observations row and
 * inserts here), so without this leg the bugfix/feature/decision history is unreachable by
 * mem_search. Excludes superseded events (superseded_at_epoch); events has no low-signal/noise
 * column, so no noise gate (parity with searchEvents in lib/activity.mjs). Returns raw rows
 * { id, event_type, title, body, project, importance, file_paths, created_at_epoch, score }.
 */
export function searchEventsFts(db, { ftsQuery, project = null, projectBoost = null, epochFrom = null, epochTo = null, eventType = null, importance = null, perSourceLimit, perSourceOffset = 0 }) {
  const wheres = ['events_fts MATCH ?', 'e.superseded_at_epoch IS NULL'];
  const params = [Date.now(), projectBoost, projectBoost, ftsQuery];
  if (project) { wheres.push('e.project = ?'); params.push(project); }
  if (epochFrom !== null) { wheres.push('e.created_at_epoch >= ?'); params.push(epochFrom); }
  if (epochTo !== null) { wheres.push('e.created_at_epoch <= ?'); params.push(epochTo); }
  // D#76: event_type filter (obs_type maps here) + importance floor (events carry importance).
  if (eventType) { wheres.push('e.event_type = ?'); params.push(eventType); }
  if (importance) { wheres.push('COALESCE(e.importance, 1) >= ?'); params.push(importance); }
  params.push(perSourceLimit, perSourceOffset);
  return db.prepare(`
    SELECT e.id, e.event_type, e.title, e.body, e.project, e.importance, e.file_paths, e.created_at_epoch,
           ${EVT_BM25}
             * ${recencyDecaySql({ tsExpr: 'e.created_at_epoch', halfLifeSql: `${DEFAULT_DECAY_HALF_LIFE_MS}.0` })}
             * (CASE WHEN ? IS NOT NULL AND e.project = ? THEN 2.0 ELSE 1.0 END) as score
    FROM events_fts
    JOIN events e ON events_fts.rowid = e.id
    WHERE ${wheres.join(' AND ')}
    ORDER BY score
    LIMIT ? OFFSET ?
  `).all(...params);
}

// A lone match has no within-source spread to normalize against (MED-5, v3.48.0).
// A magnitude-blind constant (-0.5) fixed the dominating direction — an incidental
// lone hit no longer outranks a strongly-matched page — but buried the opposite,
// equally common shape (audit 2026-07-17 MED-1): events are the CANONICAL store for
// promoted bugfix/decision memories AND a low-cardinality source, so "the best
// answer is one strong event" is routine, and within-source max-normalization pins
// every multi-hit source's best to -1 regardless of absolute strength.
//
// Fix: band the lone hit by its raw magnitude RELATIVE to the global raw max across
// all scored rows — the cross-source signal the per-source normalization destroys.
// obs/event/session BM25 live on comparable scales (weighted bm25 × decay ×
// project-boost), so the ratio is meaningful there; small-scale sources (prompts,
// bm25 ≈ -1) can only be penalized by this comparison, never inflated — the safe
// direction.
// D#121 (2026-08-16): obs FULL_SCORE additionally carries citeFactor (0.4–3.0) ×
// noisePenalty (0.2–1.0) — behavior state events/sessions never have. A heavily-
// cited obs can therefore widen globalMaxAbs and demote a lone event's band: this
// is ACCEPTED direction (cite is genuine relevance evidence), and it is BOUNDED —
// citeFactor caps at 3.0, so a lone hit that was the raw max keeps ratio >= 1/3
// and never sinks below the -0.5 neutral mid; noise only shrinks obs (can only
// IMPROVE the lone hit's band). Real-SQL pins: benchmark/events-pipeline-probes.mjs
// (cite-widening-bounded-3x / decisive-lone-event-survives-max-cite / noise-shrink).
// Bands (ratio = |lone| / globalMaxAbs, first match wins):
//   ratio ≥ 1   → -1.05  the lone hit IS the strongest raw match anywhere: rank it
//                        strictly ahead of every normalized -1 (ties in raw
//                        strength resolve toward the lone hit — the [-1, 0] band
//                        convention is deliberately exceeded here)
//   ratio ≥ 0.5 → -0.75  comparable to the best: above neutral, below the leaders
//   ratio ≥ 0.1 → -0.5   the MED-5 neutral mid
//   ratio < 0.1 → -0.25  grazing match: sink it
// score === 0 rows are excluded from normalization entirely and keep their 0,
// sorting last in the ascending merge (audit L3: the old clamp promoted a lone
// 0-score row to the neutral mid). Two producers emit score 0 — the prompts CJK
// LIKE fallback AND the obs type-list fallback below (both zero-confidence, both
// gated so they never coexist with scored rows of their own source).
const SINGLE_MATCH_BANDS = [
  [1.0, -1.05],
  [0.5, -0.75],
  [0.1, -0.5],
  [0, -0.25],
];

/**
 * Normalize each source's BM25 scores to [-1, 0] before cross-source merge.
 * Prevents observations (BM25 can reach -40) from systematically outranking
 * sessions (-6) and prompts (-1) regardless of relevance. A source with a single
 * scored row is banded by its magnitude relative to the global raw max (see
 * SINGLE_MATCH_BANDS) — it has no within-source spread to normalize against.
 * Mutates `results` in place; callers re-sort afterwards.
 */
export function normalizeCrossSourceScores(results, sourceKey) {
  // scoreScale:'vector' rows (the obs leg when the vector arm is on — RRF-fused
  // ≈1/(60+rank) ≈ 0.02, or raw cosine ≈0.1-1) are NOT on the BM25 scale the lone-hit
  // banding below assumes. Exclude them from globalMaxAbs so the cross-source ratio stays
  // meaningful for BM25 sources, and band a lone vector hit neutrally rather than by an
  // incomparable (near-zero) ratio that would always sink it (audit P2-12 2026-07-24).
  const isVector = (r) => r.scoreScale === 'vector';
  const scored = results.filter((r) => r.score !== null && r.score !== undefined && r.score !== 0 && !isVector(r));
  const globalMaxAbs = scored.length ? Math.max(...scored.map((r) => Math.abs(r.score))) : 0;
  for (const src of ['obs', 'session', 'prompt', 'event']) {
    // score === 0 stays out: for multi-row sources 0/maxAbs would be 0 anyway, and a
    // lone 0-score row must not be banded upward. Two 0-score producers exist (G19
    // comment fix — "only the prompts LIKE fallback" was incomplete): the prompts CJK
    // LIKE fallback (never coexists with real prompt FTS hits) and the obs type-list
    // fallback (gated on results.length === 0, so it never coexists with ANY scored row).
    const srcResults = results.filter((r) => r[sourceKey] === src && r.score !== null && r.score !== undefined && r.score !== 0);
    if (srcResults.length === 0) continue;
    if (srcResults.length === 1) {
      if (isVector(srcResults[0])) {
        // Vector-scaled lone hit: no BM25-comparable magnitude to band by → neutral mid
        // (the MED-5 -0.5), neither sunk by a near-zero ratio nor inflated.
        srcResults[0].score = -0.5;
      } else {
        const ratio = globalMaxAbs > 0 ? Math.abs(srcResults[0].score) / globalMaxAbs : 0;
        srcResults[0].score = SINGLE_MATCH_BANDS.find(([floor]) => ratio >= floor)[1];
      }
      continue;
    }
    // Multi-row source (incl. a vector obs leg): within-source max-normalization pins the
    // best to -1 on the source's own scale, so no cross-source magnitude assumption applies.
    const maxAbs = Math.max(...srcResults.map((r) => Math.abs(r.score)));
    if (maxAbs > 0) {
      for (const r of srcResults) r.score = r.score / maxAbs;
    }
  }
}

/**
 * Apply the user-requested sort AFTER relevance scoring. 'relevance' is a
 * no-op — BM25 score order is already in place from the merge sort.
 */
export function applyUserSort(results, sort) {
  if (sort === 'time') {
    results.sort((a, b) => (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0));
  } else if (sort === 'importance') {
    results.sort((a, b) => (b.importance ?? 1) - (a.importance ?? 1) || (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0));
  }
}

/**
 * Tier post-filter: batch-lookup full obs rows and keep only those whose
 * computed tier matches. Non-obs rows pass through untouched. Classification
 * uses the explicitly-requested project when given — CWD-inferred fallback
 * breaks computeTier's "obs.project === currentProject" rules on
 * cross-project searches and silently drops valid rows.
 * @returns filtered array (input is not mutated)
 */
export function applyTierFilter(db, results, { tier, sourceKey, currentProject }) {
  const obsIds = results.filter((r) => r[sourceKey] === 'obs').map((r) => r.id);
  if (obsIds.length === 0) return results;
  const placeholders = obsIds.map(() => '?').join(',');
  const fullRows = db.prepare(
    `SELECT id, compressed_into, superseded_at, memory_session_id, project, importance, last_accessed_at, created_at_epoch, type FROM observations WHERE id IN (${placeholders})`
  ).all(...obsIds);
  const rowMap = new Map(fullRows.map((r) => [r.id, r]));
  const tierCtx = { now: Date.now(), currentProject, currentSessionId: '' };
  return results.filter((r) => {
    if (r[sourceKey] !== 'obs') return true;
    const full = rowMap.get(r.id);
    return full && computeTier(full, tierCtx) === tier;
  });
}

/**
 * Finalize a merged, scored result set into one page: compute the TRUE
 * (limit/offset-invariant) population, slice the requested page, and attach the
 * ~Nt fetch-cost hint. Single source of truth for the count+paginate+enrich tail
 * of cmdSearch (CLI) and runSearchPipeline (MCP) — exactly where #8635 drifted
 * (the over-fetch cap leaked into the reported total on BOTH sides independently).
 *
 * `total`: every source over-fetched from offset 0 (computePerSourceWindow), so
 * results.length is the over-fetched candidate pool, NOT the population —
 * countSearchTotal re-derives the real MATCH+filter count. Clamp to
 * >= results.length so vector/concept-augmented obs rows are never undercounted
 * (#8217/#8638). For deep (explicit or auto-escalated) the population IS the fused
 * variant set already in `results` (deepSearch is obs-only, capped at
 * perSourceLimit); countSearchTotal would instead count the ORIGINAL query's FTS
 * matches — wrong, and ~0 on the vocabulary-mismatch queries deep exists for (F1).
 *
 * Pagination always slices: single-source results can exceed SQL LIMIT via
 * expansion (concept co-occurrence / PRF / vector), and `offset` is applied
 * exactly ONCE here (the per-source SQL always saw offset 0).
 *
 * @returns {{ total: number, page: object[] }}
 */
export function finalizeSearchPage(db, results, {
  isDeep, offset, limit, effectiveSource, ftsQuery, orFallbackFired,
  project = null, obsType = null, importance = null, branch = null,
  epochFrom = null, epochTo = null, includeNoise = false, obsTypeScoped = false,
}) {
  const total = isDeep
    ? results.length
    : Math.max(countSearchTotal(db, {
      effectiveSource: effectiveSource || null,
      ftsQuery,
      obsFtsQuery: effectiveObsFtsQuery(ftsQuery, orFallbackFired),
      args: { project: project || null, obs_type: obsType || null, importance: importance || null, branch: branch || null },
      project: project || null,
      epochFrom, epochTo, includeNoise,
      obsTypeScoped,   // D#76: count obs + type-filtered events only (skip type-less sessions/prompts)
    }), results.length);
  const page = results.slice(offset, offset + limit);
  attachBodyTokens(db, page);
  return { total, page };
}

/**
 * Unified cross-source search orchestrator — single source of truth for the CLI
 * (cmdSearch) and MCP (mem_search) search bodies: deep / auto-escalation →
 * per-source query (obs hybrid + sessions + prompts) → cross-source
 * normalize+sort → context re-rank + supersede → tier post-filter → user sort →
 * count+paginate. The two surfaces legitimately differ on a handful of policy
 * points; each is a named opt so a future "fix" is a deliberate contract change,
 * not an accident (see the per-opt comments).
 *
 * The core does NO flag/schema parsing, NO stdout/stderr, NO formatting — adapters
 * validate+parse on the way in and render on the way out. Session/prompt rows
 * carry dual keys (`date`=created_at, `text`=prompt_text, `session`=content_session_id)
 * so both renderers read their own field names off one canonical row.
 *
 * #8743: `db` comes ONLY from `ctx.db` — there is no module-global fallback, so a
 * per-source leg can never silently query the wrong database.
 *
 * @returns {Promise<{ page:object[], total:number, preFinalizeCount:number, isDeep:boolean,
 *   escalated:boolean, escalatedObsCount:number, variants:object[]|null,
 *   reranked:boolean, orFallbackFired:boolean, effectiveSource:string|null, ftsQuery:string }>}
 */
export async function coreRunSearchPipeline(ctx, opts) {
  const {
    db, currentProject = null, env = process.env,
    searchObservationsHybrid, deepSearch, shouldEscalateToDeep,
    autoDeepLlmReady, reRankWithContext,
    llm = null, rerankLlm = undefined,
  } = ctx;
  const {
    query, ftsQuery, effectiveSource = null, deepMode = 'normal', rerank = false,
    limit, offset, project = null, obsType = null, importance = null, branch = null,
    includeNoise = false, epochFrom = null, epochTo = null, sort = 'relevance', tier = null,
    // ── surface policy (strict behavior-preservation; the two surfaces differ) ──
    obsTypeScoped = false,             // D#76: obs_type given (no branch/tier) ⇒ scope to obs+events (both carry the type
                                       //       vocabulary), NOT observations-only. Skips the type-less sessions/prompts legs
                                       //       and their counts; the events leg filters by event_type = obsType. Both surfaces.
    obsTypeFallback = false,           // A5: list-recent-by-type when 0 matches — MCP true, CLI false (#8217 removed it from CLI)
    crossSourceEpochSortNoFts = false, // A3: epoch-sort the cross-source set when no ftsQuery — MCP true, CLI false
    rerankPolicy = 'mcp',              // A4: re-rank/supersede gate + re-sort condition — 'mcp' | 'cli'
    rerankProject = null,              // reRankWithContext project — MCP currentProject, CLI project||inferProject()
    recentListingNoFts = false,        // session/prompt recent-listing when no ftsQuery (explicit --source) — MCP true, CLI false
    tolerateMissingFts = false,        // wrap session/prompt FTS in try/catch for pre-FTS legacy DBs — CLI true, MCP false
    tierPosition = 'late',             // tier filter vs re-rank ordering — MCP 'late' (after re-rank), CLI 'early' (in obs block)
    tierProject = null,                // applyTierFilter project — MCP project||currentProject, CLI project||inferProject()
  } = opts;

  const { perSourceLimit, perSourceOffset } = computePerSourceWindow(limit, offset);
  const isCrossSource = !effectiveSource;
  const results = [];
  let orFallbackFired = false;
  let deepVariants = null;
  let deepReranked = false;
  let isDeep = deepMode === 'deep';
  let escalated = false;
  let escalatedObsCount = 0;

  const obsCtx = {
    db, ftsQuery,
    args: { project, obs_type: obsType, importance, branch, include_noise: includeNoise },
    epochFrom, epochTo, perSourceLimit, perSourceOffset, currentProject, limit,
    orFallbackFired: false,
  };

  const runDeep = async ({ auto = false } = {}) => {
    const ds = await deepSearch(db, {
      query, project, type: obsType, importance, branch, includeNoise,
      epochFrom, epochTo, limit: perSourceLimit, currentProject,
    }, llm ? { llm, rerank: rerank && !auto, rerankLlm } : { auto, rerank: rerank && !auto, rerankLlm });
    deepVariants = ds.variants;
    deepReranked = ds.reranked;
    return ds.results;
  };

  // ── Observations (hybrid engine; deep / auto-escalation; obs rows already carry source:'obs') ──
  if (!effectiveSource || effectiveSource === 'observations') {
    if (deepMode === 'deep') {
      results.push(...await runDeep());
    } else {
      results.push(...searchObservationsHybrid(db, obsCtx));
      if (obsCtx.orFallbackFired) orFallbackFired = true;
      const obsCountBefore = results.filter((r) => r.source === 'obs').length;
      if (deepMode === 'auto' && autoDeepLlmReady(env, llm) &&
          shouldEscalateToDeep(results.filter((r) => r.source === 'obs'), obsCtx, { db, project })) {
        const deepRows = await runDeep({ auto: true });
        results.length = 0;
        results.push(...deepRows);
        isDeep = true;
        escalated = true;
        escalatedObsCount = obsCountBefore;
      }
    }
  }

  // ── Tier post-filter, CLI position: obs-only (tier forces observations), before re-rank ──
  if (tier && tierPosition === 'early') {
    const filtered = applyTierFilter(db, results, { tier, sourceKey: 'source', currentProject: tierProject });
    results.length = 0; results.push(...filtered);
  }

  // ── Sessions (FTS via shared helper; optional recent-listing when no ftsQuery) ──
  // D#74: `!isDeep || escalated` — auto-escalation replaces the obs leg with a deep fuse but must
  // NOT silently drop the cross-source complement (it did: escalated → isDeep → every leg below
  // skipped). Explicit deep=true (escalated stays false) still dives obs-only. D#76: obsTypeScoped
  // skips the type-less sessions/prompts legs (they can't honor an obs_type/event_type filter).
  if ((!effectiveSource || effectiveSource === 'sessions') && (!isDeep || escalated) && !obsTypeScoped) {
    const pushSessions = () => {
      if (ftsQuery) {
        const rows = searchSessionsFts(db, { ftsQuery, project, projectBoost: project ? null : currentProject, epochFrom, epochTo, perSourceLimit, perSourceOffset });
        for (const r of rows) results.push({ ...r, source: 'session', date: r.created_at });
      } else if (recentListingNoFts && effectiveSource === 'sessions') {
        const params = []; const wheres = [];
        if (project) { wheres.push('project = ?'); params.push(project); }
        if (epochFrom !== null) { wheres.push('created_at_epoch >= ?'); params.push(epochFrom); }
        if (epochTo !== null) { wheres.push('created_at_epoch <= ?'); params.push(epochTo); }
        const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
        params.push(perSourceLimit, perSourceOffset);
        const rows = db.prepare(`
          SELECT id, request, completed, project, created_at, created_at_epoch
          FROM session_summaries ${where}
          ORDER BY created_at_epoch DESC
          LIMIT ? OFFSET ?
        `).all(...params);
        for (const r of rows) results.push({ ...r, source: 'session', date: r.created_at });
      }
    };
    if (tolerateMissingFts) { try { pushSessions(); } catch { /* session FTS may not exist in older DBs */ } } else pushSessions();
  }

  // ── Prompts (FTS via shared helper incl. CJK gate; optional recent-listing) ──
  if ((!effectiveSource || effectiveSource === 'prompts') && (!isDeep || escalated) && !obsTypeScoped) {
    const pushPrompts = () => {
      if (ftsQuery) {
        const rows = searchPromptsFts(db, { query, ftsQuery, project, epochFrom, epochTo, perSourceLimit, perSourceOffset });
        for (const r of rows) results.push({ ...r, source: 'prompt', date: r.created_at, text: r.prompt_text, session: r.content_session_id });
      } else if (recentListingNoFts && effectiveSource === 'prompts') {
        const params = []; const wheres = [];
        if (project) { wheres.push('s.project = ?'); params.push(project); }
        if (epochFrom !== null) { wheres.push('p.created_at_epoch >= ?'); params.push(epochFrom); }
        if (epochTo !== null) { wheres.push('p.created_at_epoch <= ?'); params.push(epochTo); }
        const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
        params.push(perSourceLimit, perSourceOffset);
        const rows = db.prepare(`
          SELECT p.id, p.prompt_text, p.content_session_id, p.created_at, p.created_at_epoch
          FROM user_prompts p
          JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
          ${where}
          ORDER BY p.created_at_epoch DESC
          LIMIT ? OFFSET ?
        `).all(...params);
        for (const r of rows) results.push({ ...r, source: 'prompt', date: r.created_at, text: r.prompt_text, session: r.content_session_id });
      }
    };
    if (tolerateMissingFts) { try { pushPrompts(); } catch { /* prompt FTS may not exist in older DBs */ } } else pushPrompts();
  }

  // ── Events (FTS via shared helper; events are the CANONICAL event-typed store) ──
  // Runs on auto-escalation too (D#74) and participates in obsTypeScoped (D#76) — events carry the
  // same type vocabulary as observations, so an obs_type filter maps to e.event_type here.
  if ((!effectiveSource || effectiveSource === 'events') && (!isDeep || escalated)) {
    const toIso = (epoch) => (epoch ? new Date(epoch).toISOString() : null);
    // events has no created_at ISO column (only *_epoch) and no subtitle; body carries the
    // distilled lesson (persistHaikuSummary writes lesson_learned||narrative here), surfaced
    // as lesson_learned (obs parity) AND text (attachBodyTokens / CLI JSON body field).
    const shapeEvent = (r) => ({
      source: 'event', id: r.id, type: r.event_type, title: r.title,
      project: r.project, importance: r.importance, files_modified: r.file_paths,
      created_at_epoch: r.created_at_epoch, created_at: toIso(r.created_at_epoch), date: toIso(r.created_at_epoch),
      lesson_learned: r.body, text: r.body, score: r.score ?? 0, snippet: '',
    });
    const pushEvents = () => {
      if (ftsQuery) {
        // D#76: obsType maps to e.event_type (shared vocab); importance filters events too (they carry it).
        const rows = searchEventsFts(db, { ftsQuery, project, projectBoost: project ? null : currentProject, epochFrom, epochTo, eventType: obsType, importance, perSourceLimit, perSourceOffset });
        for (const r of rows) results.push(shapeEvent(r));
      } else if (recentListingNoFts && effectiveSource === 'events') {
        const params = []; const wheres = ['superseded_at_epoch IS NULL'];
        if (project) { wheres.push('project = ?'); params.push(project); }
        if (epochFrom !== null) { wheres.push('created_at_epoch >= ?'); params.push(epochFrom); }
        if (epochTo !== null) { wheres.push('created_at_epoch <= ?'); params.push(epochTo); }
        if (obsType) { wheres.push('event_type = ?'); params.push(obsType); }
        if (importance) { wheres.push('COALESCE(importance, 1) >= ?'); params.push(importance); }
        params.push(perSourceLimit, perSourceOffset);
        const rows = db.prepare(`
          SELECT id, event_type, title, body, project, importance, file_paths, created_at_epoch
          FROM events WHERE ${wheres.join(' AND ')}
          ORDER BY created_at_epoch DESC
          LIMIT ? OFFSET ?
        `).all(...params);
        for (const r of rows) results.push(shapeEvent(r));
      }
    };
    if (tolerateMissingFts) { try { pushEvents(); } catch { /* events_fts may not exist in older DBs */ } } else pushEvents();
  }

  // ── Type-list fallback (MCP): obs_type set + 0 matches → list recent of that type ──
  if (obsTypeFallback && results.length === 0 && obsType) {
    const typeWheres = [liveObsFilterSql(''), 'type = ?'];
    // Mirror the FTS path's low-signal filter (buildObsFtsQuery): this fallback is still a
    // SEARCH surface, so degraded titles ("Modified X", "Error: …") must not lead it —
    // acute for obs_type='change', the noise band. (The no-query recent-listing in
    // searchObservationsHybrid deliberately does NOT filter — it mirrors mem_recent.)
    if (!includeNoise) typeWheres.push(notLowSignalTitleClause(''));
    const typeParams = [obsType];
    if (project) { typeWheres.push('project = ?'); typeParams.push(project); }
    if (epochFrom !== null) { typeWheres.push('created_at_epoch >= ?'); typeParams.push(epochFrom); }
    if (epochTo !== null) { typeWheres.push('created_at_epoch <= ?'); typeParams.push(epochTo); }
    if (importance) { typeWheres.push('COALESCE(importance, 1) >= ?'); typeParams.push(importance); }
    typeParams.push(limit);
    const typeRows = db.prepare(`
      SELECT id, type, title, subtitle, project, created_at, importance, files_modified
      FROM observations WHERE ${typeWheres.join(' AND ')}
      ORDER BY created_at_epoch DESC LIMIT ?
    `).all(...typeParams);
    for (const r of typeRows) results.push({ source: 'obs', id: r.id, type: r.type, title: r.title, subtitle: r.subtitle, project: r.project, date: r.created_at, importance: r.importance, files_modified: r.files_modified, score: 0, snippet: '' });
  }

  // ── Cross-source normalize + sort ──
  if (isCrossSource && results.length > 0 && ftsQuery) normalizeCrossSourceScores(results, 'source');
  if (isCrossSource && results.length > 0) {
    if (ftsQuery) results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    else if (crossSourceEpochSortNoFts) results.sort((a, b) => (b.created_at_epoch ?? 0) - (a.created_at_epoch ?? 0));
  }

  // ── Context re-rank ──
  const hasObs = results.some((r) => r.source === 'obs');
  const rerankGate = rerankPolicy === 'mcp' ? ((ftsQuery || isDeep) && hasObs) : hasObs;
  if (rerankGate) {
    const doReRank = rerankPolicy === 'mcp' ? (ftsQuery && !deepReranked) : !deepReranked;
    if (doReRank) {
      // obsResults is only consumed by reRankWithContext — build it inside the gate so
      // the no-rerank path (deepReranked / MCP isDeep+!ftsQuery) skips the wasted filter.
      const obsResults = results.filter((r) => r.source === 'obs');
      reRankWithContext(db, obsResults, rerankProject);
    }
    // CLI single-source path must also re-sort when a context re-rank actually ran,
    // else reRankWithContext's score boost mutates scores but never reorders output
    // (audit #9). MCP branch unchanged. doReRank already implies a rerank happened.
    const doReSort = rerankPolicy === 'mcp' ? (ftsQuery && !deepReranked) : (isCrossSource || doReRank);
    if (doReSort) results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  }

  // ── Tier post-filter, MCP position: after re-rank, on the merged set ──
  if (tier && tierPosition === 'late') {
    const filtered = applyTierFilter(db, results, { tier, sourceKey: 'source', currentProject: tierProject });
    results.length = 0; results.push(...filtered);
  }

  // ── User-requested sort (after relevance scoring) ──
  applyUserSort(results, sort);

  // ── Count + paginate + ~Nt enrich. preFinalizeCount lets the CLI adapter
  //    distinguish "nothing matched" from "this page is empty" (its two messages). ──
  const preFinalizeCount = results.length;
  const { total, page } = finalizeSearchPage(db, results, {
    isDeep, offset, limit, effectiveSource, ftsQuery, orFallbackFired,
    project, obsType, importance, branch, epochFrom, epochTo, includeNoise, obsTypeScoped,
  });

  return {
    page, total, preFinalizeCount, isDeep, escalated, escalatedObsCount,
    variants: deepVariants, reranked: deepReranked, orFallbackFired, effectiveSource, ftsQuery,
  };
}
