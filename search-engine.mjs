// Shared observation-search engine — the single source of truth for
// hybrid FTS5 + vector ranking, OR fallback, concept/PRF expansion, and
// RRF merge. Both server.mjs (mem_search MCP tool) and mem-cli.mjs (search CLI)
// import these helpers so identical queries return identical candidate sets
// and rankings. See #8198 / #8212 for the prior paired-path divergence this
// module exists to eliminate.

import {
  OBS_BM25,
  TYPE_QUALITY_CASE,
  DEFAULT_DECAY_HALF_LIFE_MS,
  notLowSignalTitleClause,
  LOW_SIGNAL_TITLE,
  relaxFtsQueryToOr,
  debugLog,
  debugCatch,
  estimateTokens,
  noisePenaltyClause,
} from './utils.mjs';
import { citeFactorClause } from './scoring-sql.mjs';
import { getVocabulary, computeVector, vectorSearch, rrfMerge, vectorsEnabled } from './tfidf.mjs';
import { extractPRFTerms, expandQueryByConcepts } from './search-scoring.mjs';
import { liveObsFilterSql, recencyDecaySql } from './lib/inject-search-core.mjs';

// Scoring expressions — full adds project boost + access bonus; simple is for
// expansion paths where boost would over-amplify already-loose matches.
// `MAX(0, now - ts)` clamps the recency age to >= 0: a far-FUTURE created_at/last_accessed
// (reachable via restore/import-jsonl, which accept arbitrary epochs) otherwise made the
// exponent large-positive → EXP overflowed to +Infinity → score -Infinity → that row sorted
// #1 for any match AND JSON.stringify emitted `"score": null` (numeric-contract break). A
// future row now reads as age 0 = max (finite) recency, not Infinity.
// M-3 (audit 2026-08-14): cite/noise behavior factors joined FULL_SCORE — they had
// shipped for months on every AUTO surface (UPS / pre-tool-recall / hook-memory)
// while the EXPLICIT surfaces (mem_search / CLI search) discarded the accumulated
// citation + noise signal (the mirror image of "guards wired on the auto face,
// missing on the explicit face"). Both factors are hard-bounded (cite ∈ [0.4, 3.0],
// noise ∈ {0.2, 0.5, 1.0}), so they reorder, never dominate. algo-F6 note: the
// access-count LN bonus below stays — noisePenalty uses access_count only inside a
// ratio GUARD (never as a bonus) and citeFactor reads cited/uncited columns, so no
// term is counted twice as a reward. Denoise A/B 2026-08-16: NEUTRAL (suite rows
// carry zero cite/noise state); the behavioral pin lives in
// tests/audit-fixes-20260816.test.mjs (M-3).
const FULL_SCORE = `${OBS_BM25}
  * ${recencyDecaySql({ tsExpr: 'MAX(o.created_at_epoch, COALESCE(o.last_accessed_at, o.created_at_epoch))' })}
  * ${TYPE_QUALITY_CASE}
  * (CASE WHEN ? IS NOT NULL AND o.project = ? THEN 2.0 ELSE 1.0 END)
  * (0.5 + 0.5 * COALESCE(o.importance, 1))
  * (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0)))
  * (1.0 + 0.3 * (o.lesson_learned IS NOT NULL AND o.lesson_learned NOT IN ('', 'none')))
  * ${noisePenaltyClause('o')}
  * ${citeFactorClause('o')}`;

// D#121: noisePenalty joins SIMPLE (an entrenched-noise row demoted 0.2× on every
// direct surface re-entered concept/PRF expansion at full magnitude); citeFactor
// stays OUT deliberately — it can amplify 3×, and SIMPLE exists precisely to avoid
// amplifying already-loose expansion matches. Noise only shrinks: safe direction.
const SIMPLE_SCORE = `${OBS_BM25}
  * ${recencyDecaySql({ tsExpr: 'MAX(o.created_at_epoch, COALESCE(o.last_accessed_at, o.created_at_epoch))' })}
  * ${TYPE_QUALITY_CASE}
  * (0.5 + 0.5 * COALESCE(o.importance, 1))
  * (1.0 + 0.3 * (o.lesson_learned IS NOT NULL AND o.lesson_learned NOT IN ('', 'none')))
  * ${noisePenaltyClause('o')}`;

// Shared column set for fetching an observation surfaced by the vector arm — used by BOTH
// the RRF-merge branch (FTS also had results) and the FTS-empty fallback branch. Single
// source so the two can't drift. v3.42 F4: the fallback branch's SELECT had dropped
// lesson_learned while its RRF twin kept it, so a vector-only hit returned
// lesson_learned: undefined — losing the lesson content AND the 1.5× lesson scoring boost
// downstream. Both branches build `{ …, date: obs.created_at, lesson_learned: obs.lesson_learned }`
// so the SELECT must carry created_at + lesson_learned.
export const VEC_HIT_OBS_COLS =
  'id, type, title, subtitle, project, created_at, created_at_epoch, importance, files_modified, branch, lesson_learned';

export function buildObsFtsQuery(scoring, { multiplier, withSnippet, withOffset, includeNoise } = {}) {
  const scoreExpr = scoring === 'full' ? FULL_SCORE : SIMPLE_SCORE;
  const mult = multiplier ? ` * ${multiplier}` : '';
  const lowSignalClause = includeNoise ? '' : `AND ${notLowSignalTitleClause('o')}`;
  return `
    SELECT o.id, o.type, o.title, o.subtitle, o.project, o.created_at, o.created_at_epoch, o.importance,
           o.files_modified, o.lesson_learned,
           ${withSnippet ? "snippet(observations_fts, 2, '»', '«', '…', 10) as match_snippet," : ''}
           ${scoreExpr}${mult} as score
    FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE observations_fts MATCH ?
      AND ${liveObsFilterSql('o')}
      AND (? IS NULL OR o.project = ?)
      AND (? IS NULL OR o.type = ?)
      AND (? IS NULL OR o.created_at_epoch >= ?)
      AND (? IS NULL OR o.created_at_epoch <= ?)
      AND (? IS NULL OR COALESCE(o.importance, 1) >= ?)
      AND (? IS NULL OR o.branch = ?)
      ${lowSignalClause}
    ORDER BY score
    LIMIT ?${withOffset ? ' OFFSET ?' : ''}`;
}

export function buildObsFtsParams({ now, projectBoost, ftsQuery, args, epochFrom, epochTo, limit, offset }) {
  const params = [now];
  if (projectBoost !== undefined) params.push(projectBoost, projectBoost);
  params.push(
    ftsQuery,
    args.project ?? null,
    args.project ?? null,
    args.obs_type ?? null,
    args.obs_type ?? null,
    epochFrom,
    epochFrom,
    epochTo,
    epochTo,
    args.importance ?? null,
    args.importance ?? null,
    args.branch ?? null,
    args.branch ?? null,
    limit,
  );
  if (offset !== undefined) params.push(offset);
  return params;
}

// --- True match-count helpers (limit/offset-invariant search totals) ----------
// The search path over-fetches per source — perSourceLimit = max(limit*3,
// offset+limit+10) — and historically reported `total = results.length`. That made
// "Found N of M" and the JSON `total` field grow with --limit/--offset, breaking
// the documented pagination contract (a query's population must not change when you
// page through it). These COUNT(*) helpers mirror each source's MATCH + filters
// exactly, so `total` reflects the real population independent of paging. Shared by
// CLI and MCP per the paired-path single-source-of-truth rule (#8217).
//
// Known approximation: post-SQL filters that DROP rows after the query (CJK
// precision gate on prompts, --tier on obs) are not reflected here, so those niche
// queries may overcount. Callers clamp total to >= page size, so it never
// understates the rows actually shown.
export function countObsFtsMatches(
  db,
  { ftsQuery, args = {}, epochFrom = null, epochTo = null, includeNoise = false },
) {
  if (!ftsQuery) return 0;
  const lowSignalClause = includeNoise ? '' : `AND ${notLowSignalTitleClause('o')}`;
  try {
    const row = db
      .prepare(
        `
      SELECT COUNT(*) as c
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
        AND ${liveObsFilterSql('o')}
        AND (? IS NULL OR o.project = ?)
        AND (? IS NULL OR o.type = ?)
        AND (? IS NULL OR o.created_at_epoch >= ?)
        AND (? IS NULL OR o.created_at_epoch <= ?)
        AND (? IS NULL OR COALESCE(o.importance, 1) >= ?)
        AND (? IS NULL OR o.branch = ?)
        ${lowSignalClause}
    `,
      )
      .get(
        ftsQuery,
        args.project ?? null,
        args.project ?? null,
        args.obs_type ?? null,
        args.obs_type ?? null,
        epochFrom,
        epochFrom,
        epochTo,
        epochTo,
        args.importance ?? null,
        args.importance ?? null,
        args.branch ?? null,
        args.branch ?? null,
      );
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export function countSessionFtsMatches(db, { ftsQuery, project = null, epochFrom = null, epochTo = null }) {
  if (!ftsQuery) return 0;
  try {
    const wheres = ['session_summaries_fts MATCH ?'];
    const params = [ftsQuery];
    if (project) {
      wheres.push('s.project = ?');
      params.push(project);
    }
    if (epochFrom) {
      wheres.push('s.created_at_epoch >= ?');
      params.push(epochFrom);
    }
    if (epochTo) {
      wheres.push('s.created_at_epoch <= ?');
      params.push(epochTo);
    }
    const row = db
      .prepare(
        `
      SELECT COUNT(*) as c
      FROM session_summaries_fts
      JOIN session_summaries s ON session_summaries_fts.rowid = s.id
      WHERE ${wheres.join(' AND ')}
    `,
      )
      .get(...params);
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export function countPromptFtsMatches(db, { ftsQuery, project = null, epochFrom = null, epochTo = null }) {
  if (!ftsQuery) return 0;
  try {
    const wheres = ['user_prompts_fts MATCH ?', "p.prompt_text NOT LIKE '<task-notification>%'"];
    const params = [ftsQuery];
    if (project) {
      wheres.push('s.project = ?');
      params.push(project);
    }
    if (epochFrom) {
      wheres.push('p.created_at_epoch >= ?');
      params.push(epochFrom);
    }
    if (epochTo) {
      wheres.push('p.created_at_epoch <= ?');
      params.push(epochTo);
    }
    const row = db
      .prepare(
        `
      SELECT COUNT(*) as c
      FROM user_prompts_fts
      JOIN user_prompts p ON user_prompts_fts.rowid = p.id
      JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE ${wheres.join(' AND ')}
    `,
      )
      .get(...params);
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export function countEventFtsMatches(
  db,
  { ftsQuery, project = null, epochFrom = null, epochTo = null, eventType = null, importance = null },
) {
  if (!ftsQuery) return 0;
  try {
    const wheres = ['events_fts MATCH ?', 'e.superseded_at_epoch IS NULL'];
    const params = [ftsQuery];
    if (project) {
      wheres.push('e.project = ?');
      params.push(project);
    }
    if (epochFrom) {
      wheres.push('e.created_at_epoch >= ?');
      params.push(epochFrom);
    }
    if (epochTo) {
      wheres.push('e.created_at_epoch <= ?');
      params.push(epochTo);
    }
    // D#76: keep the count in lockstep with searchEventsFts's event_type/importance filters,
    // else the "N of M" population diverges from the rows actually shown.
    if (eventType) {
      wheres.push('e.event_type = ?');
      params.push(eventType);
    }
    if (importance) {
      wheres.push('COALESCE(e.importance, 1) >= ?');
      params.push(importance);
    }
    const row = db
      .prepare(
        `
      SELECT COUNT(*) as c
      FROM events_fts
      JOIN events e ON events_fts.rowid = e.id
      WHERE ${wheres.join(' AND ')}
    `,
      )
      .get(...params);
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Sum true match counts across the sources that contribute to a cross-source (or
 * source-restricted) search. `obsFtsQuery` lets callers pass the OR-relaxed query
 * when obs AND→OR fallback fired (the displayed obs rows came from the OR query).
 * @returns {number} population count, limit/offset-invariant
 */
export function countSearchTotal(
  db,
  {
    effectiveSource = null,
    ftsQuery,
    obsFtsQuery = null,
    args = {},
    project = null,
    epochFrom = null,
    epochTo = null,
    includeNoise = false,
    obsTypeScoped = false,
  },
) {
  let total = 0;
  if (!effectiveSource || effectiveSource === 'observations') {
    total += countObsFtsMatches(db, {
      ftsQuery: obsFtsQuery || ftsQuery,
      args,
      epochFrom,
      epochTo,
      includeNoise,
    });
  }
  // D#76: obsTypeScoped (obs_type given, no branch/tier) counts obs + type-filtered events only —
  // sessions/prompts have no type column, so they are excluded from both the results and the count.
  if (!obsTypeScoped && (!effectiveSource || effectiveSource === 'sessions')) {
    total += countSessionFtsMatches(db, { ftsQuery, project, epochFrom, epochTo });
  }
  if (!obsTypeScoped && (!effectiveSource || effectiveSource === 'prompts')) {
    total += countPromptFtsMatches(db, { ftsQuery, project, epochFrom, epochTo });
  }
  if (!effectiveSource || effectiveSource === 'events') {
    total += countEventFtsMatches(db, {
      ftsQuery,
      project,
      epochFrom,
      epochTo,
      eventType: args.obs_type || null,
      importance: args.importance || null,
    });
  }
  return total;
}

export function ftsRowToResult(r, { scoreMultiplier, snippet } = {}) {
  return {
    source: 'obs',
    id: r.id,
    type: r.type,
    title: r.title,
    subtitle: r.subtitle,
    // `date` is the legacy key the MCP paired-search path reads; `created_at` aligns the
    // obs row shape with the session/prompt rows the CLI interleaves in the same results
    // array (cmdSearch reads r.created_at uniformly) and with recent/recall output. Both
    // hold the same ISO string — keep both so neither consumer breaks.
    project: r.project,
    date: r.created_at,
    created_at: r.created_at,
    created_at_epoch: r.created_at_epoch,
    score: scoreMultiplier ? r.score * scoreMultiplier : r.score,
    files_modified: r.files_modified,
    importance: r.importance,
    lesson_learned: r.lesson_learned,
    snippet: snippet ? r.match_snippet || '' : '',
  };
}

// Per-result estimate of the token cost to fetch the FULL body via mem_get, surfaced as the
// `~Nt` hint in search output so the agent can budget the 3-layer protocol (search → timeline →
// get) before paying to expand any ID. Adopted from thedotmack/claude-mem's token-cost column
// (reference_claude_mem_comparison) — the one genuinely portable idea from that analysis.
//
// Layer-1 search deliberately omits narrative/facts (that's what keeps the index light), so the
// heavy obs fields are batch-fetched by id HERE rather than carried on every result. The source
// key is read as `source || _source` because the two render paths disagree (#8654): MCP sets
// `source`+`text`, CLI sets `_source`+`prompt_text`. estimateTokens floors at 1, so a missing row
// or empty body yields 1 — never 0/NaN.
export function attachBodyTokens(db, results) {
  if (!Array.isArray(results) || results.length === 0) return results;
  const obsIds = results
    .filter((r) => (r.source || r._source) === 'obs' && Number.isInteger(r.id))
    .map((r) => r.id);
  const bodyById = new Map();
  if (obsIds.length > 0) {
    try {
      const ph = obsIds.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT id, narrative, facts, text FROM observations WHERE id IN (${ph})`)
        .all(...obsIds);
      for (const row of rows) bodyById.set(row.id, row);
    } catch (e) {
      debugCatch(e, 'attachBodyTokens');
    }
  }
  for (const r of results) {
    const src = r.source || r._source;
    let parts;
    if (src === 'obs') {
      const row = bodyById.get(r.id) || {};
      parts = [r.title, r.subtitle, r.lesson_learned, row.narrative, row.facts, row.text];
    } else if (src === 'session') {
      parts = [r.request, r.completed, r.working_on];
    } else if (src === 'event') {
      parts = [r.title, r.lesson_learned]; // events carry title + body(=lesson_learned) on the row
    } else {
      parts = [r.text, r.prompt_text];
    }
    r.bodyTokens = estimateTokens(parts.filter(Boolean).join(' '));
  }
  return results;
}

function expandObsByConceptCo(db, ctx, now, existingIds, results, includeNoise = false) {
  const { ftsQuery, args, epochFrom, epochTo, limit } = ctx;
  if (results.length >= Math.ceil(limit / 2)) return;
  const expanded = expandQueryByConcepts(db, ftsQuery, args.project);
  if (expanded.length === 0) return;
  const expansionFts = expanded.map((c) => `"${c.replace(/"/g, '""')}"`).join(' OR ');
  try {
    const expRows = db
      .prepare(buildObsFtsQuery('simple', { includeNoise }))
      .all(...buildObsFtsParams({ now, ftsQuery: expansionFts, args, epochFrom, epochTo, limit }));
    for (const r of expRows) {
      if (!existingIds.has(r.id)) {
        existingIds.add(r.id);
        results.push(ftsRowToResult(r, { scoreMultiplier: 0.7 }));
      }
    }
  } catch (e) {
    debugLog('WARN', 'search-engine', `concept expansion error: ${e.message}`);
  }
}

function expandObsByPRF(db, ctx, now, primaryCount, existingIds, results, includeNoise = false) {
  const { ftsQuery, args, epochFrom, epochTo, limit } = ctx;
  if (primaryCount < 3) return;
  // effectiveFtsQuery = the query that actually matched (OR-relaxed when the strict
  // AND missed and the fallback rescued rows — M-2). The strict query here returned
  // zero top docs in that case, silently disabling PRF where it helps most.
  const seedQuery = ctx.effectiveFtsQuery || ftsQuery;
  const topResults = db
    .prepare(
      `
    SELECT o.title, o.narrative FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE observations_fts MATCH ? AND ${liveObsFilterSql('o')}
      AND (? IS NULL OR o.project = ?)
    ORDER BY ${OBS_BM25}
    LIMIT 8
  `,
    )
    .all(seedQuery, args.project ?? null, args.project ?? null);
  const prfTerms = extractPRFTerms(topResults, ftsQuery);
  if (prfTerms.length === 0) return;
  const prfFts = prfTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  try {
    const prfRows = db
      .prepare(buildObsFtsQuery('simple', { includeNoise }))
      .all(...buildObsFtsParams({ now, ftsQuery: prfFts, args, epochFrom, epochTo, limit }));
    for (const r of prfRows) {
      if (!existingIds.has(r.id)) {
        existingIds.add(r.id);
        results.push(ftsRowToResult(r, { scoreMultiplier: 0.6 }));
      }
    }
  } catch (e) {
    debugLog('WARN', 'search-engine', `PRF expansion error: ${e.message}`);
  }
}

/**
 * Hybrid observation search — single source of truth for FTS + vector + RRF.
 *
 * Pipeline (paired-path with mem-cli.mjs cmdSearch via this module):
 *   1. FTS5 BM25 query (full scoring)
 *   2. OR fallback when AND returned 0 → sets ctx.orFallbackFired
 *   3. Concept co-occurrence expansion (when results sparse)
 *   4. PRF (pseudo-relevance feedback) expansion
 *   5. Vector search + RRF merge (re-ranks all results when both modes have hits)
 *   6. Vector-only fallback (when FTS5 found nothing)
 *
 * @param {Database} db - better-sqlite3 instance
 * @param {object} ctx - { ftsQuery, args, epochFrom, epochTo, perSourceLimit,
 *                         perSourceOffset, currentProject, limit, orFallbackFired }
 * @returns {Array} list of result objects (mutated ctx may set orFallbackFired)
 */
/**
 * Resolve `timeline --query "..."` / mem_timeline auto-anchor to a single
 * observation id. Shared between mem-cli.mjs cmdTimeline and server.mjs
 * mem_timeline so both surfaces use identical AND→OR fallback semantics
 * (paired-path discipline per #8217).
 *
 * Pipeline:
 *   1. FTS5 MATCH with the sanitized query (AND-by-default), recency-weighted
 *   2. If AND returns 0 → relaxFtsQueryToOr fallback (mirrors searchObservationsHybrid)
 *
 * Always skips compressed AND superseded rows — paired with searchObservationsHybrid /
 * buildObsFtsQuery so `timeline --query` / mem_timeline never anchor on a memory that
 * search itself hides (an anchor on a replaced row strands navigation on stale content).
 *
 * @param {Database} db
 * @param {object} opts
 * @param {string|null} opts.ftsQuery  pre-sanitized FTS5 query
 * @param {string|null} [opts.project] restrict to this project (boost-by-membership; null = no filter)
 * @param {number} [opts.nowT]         Date.now() override (for deterministic tests)
 * @param {number} [opts.halfLifeMs]   recency half-life (default DEFAULT_DECAY_HALF_LIFE_MS)
 * @returns {{id:number, relaxed:boolean}|null}  `relaxed:true` when AND returned 0 and OR rescued —
 *   callers should surface a "(relaxed AND→OR)" hint to mirror search transparency.
 */
export function findFtsAnchor(
  db,
  { ftsQuery, project = null, nowT = null, halfLifeMs = DEFAULT_DECAY_HALF_LIFE_MS } = {},
) {
  if (!ftsQuery) return null;
  const now = nowT ?? Date.now();
  const sql = `
    SELECT o.id FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE observations_fts MATCH ?
      AND (? IS NULL OR o.project = ?)
      AND ${liveObsFilterSql('o')}
    ORDER BY ${OBS_BM25}
      * ${recencyDecaySql({ tsExpr: 'o.created_at_epoch', halfLifeSql: `${halfLifeMs}.0` })}
    LIMIT 1
  `;
  const stmt = db.prepare(sql);
  try {
    const m = stmt.get(ftsQuery, project, project, now);
    if (m) return { id: m.id, relaxed: false };
  } catch (e) {
    debugCatch(e, 'findFtsAnchor-and');
  }
  const orQuery = relaxFtsQueryToOr(ftsQuery);
  if (orQuery && orQuery !== ftsQuery) {
    try {
      const m = stmt.get(orQuery, project, project, now);
      if (m) return { id: m.id, relaxed: true };
    } catch (e) {
      debugCatch(e, 'findFtsAnchor-or');
    }
  }
  return null;
}

export function searchObservationsHybrid(db, ctx) {
  const { ftsQuery, args, epochFrom, epochTo, perSourceLimit, perSourceOffset, currentProject, limit } = ctx;
  const results = [];
  const includeNoise = args.include_noise === true;

  if (!ftsQuery) {
    const params = [];
    const wheres = [liveObsFilterSql('')];
    if (args.project) {
      wheres.push('project = ?');
      params.push(args.project);
    }
    if (args.obs_type) {
      wheres.push('type = ?');
      params.push(args.obs_type);
    }
    if (epochFrom !== null) {
      wheres.push('created_at_epoch >= ?');
      params.push(epochFrom);
    }
    if (epochTo !== null) {
      wheres.push('created_at_epoch <= ?');
      params.push(epochTo);
    }
    if (args.importance) {
      wheres.push('COALESCE(importance, 1) >= ?');
      params.push(args.importance);
    }
    if (args.branch) {
      wheres.push('branch = ?');
      params.push(args.branch);
    }
    const where = `WHERE ${wheres.join(' AND ')}`;
    params.push(perSourceLimit, perSourceOffset);
    const rows = db
      .prepare(
        `
      SELECT id, type, title, subtitle, project, created_at, created_at_epoch, files_modified, importance, lesson_learned
      FROM observations ${where}
      ORDER BY created_at_epoch DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(...params);
    for (const r of rows) {
      results.push({
        source: 'obs',
        id: r.id,
        type: r.type,
        title: r.title,
        subtitle: r.subtitle,
        project: r.project,
        date: r.created_at,
        created_at_epoch: r.created_at_epoch,
        files_modified: r.files_modified,
        importance: r.importance,
        lesson_learned: r.lesson_learned,
      });
    }
    return results;
  }

  const now = Date.now();
  const projectBoost = args.project ? null : currentProject;

  const rows = db
    .prepare(buildObsFtsQuery('full', { withSnippet: true, withOffset: true, includeNoise }))
    .all(
      ...buildObsFtsParams({
        now,
        projectBoost,
        ftsQuery,
        args,
        epochFrom,
        epochTo,
        limit: perSourceLimit,
        offset: perSourceOffset,
      }),
    );
  for (const r of rows) results.push(ftsRowToResult(r, { snippet: true }));

  // OR fallback — must run BEFORE vector merge so orFallbackFired reflects FTS-only state.
  if (rows.length === 0) {
    const orQuery = relaxFtsQueryToOr(ftsQuery);
    if (orQuery) {
      try {
        const orRows = db
          .prepare(
            buildObsFtsQuery('full', { multiplier: 0.5, withSnippet: true, withOffset: true, includeNoise }),
          )
          .all(
            ...buildObsFtsParams({
              now,
              projectBoost,
              ftsQuery: orQuery,
              args,
              epochFrom,
              epochTo,
              limit: perSourceLimit,
              offset: perSourceOffset,
            }),
          );
        if (orRows.length > 0) {
          ctx.orFallbackFired = true;
          // M-2: PRF's top-doc probe re-queries FTS itself — with the strict-AND
          // query it reads 0 docs in exactly the OR-rescue case, keeping PRF inert.
          // Record the query that actually produced the evidence rows.
          ctx.effectiveFtsQuery = orQuery;
        }
        for (const r of orRows) results.push(ftsRowToResult(r, { snippet: true }));
      } catch (e) {
        debugCatch(e, 'searchObservationsHybrid-or-fallback');
      }
    }
  }

  // Two-phase query expansion (only when well below limit). Gate on results.length,
  // NOT rows.length (M-2, audit 2026-08-14): `rows` is the strict-AND set only, so
  // when strict-AND missed and the OR fallback rescued a few rows — exactly the
  // vocab-mismatch shape where expansion helps most — the old gate read rows.length
  // === 0 and skipped concept/PRF expansion entirely. PRF likewise seeds from the
  // rescued rows now (they are the only relevance evidence available).
  if (results.length > 0 && results.length < Math.ceil(limit / 2)) {
    const existingIds = new Set(results.map((r) => r.id));
    // D#122 ②: capture the PRIMARY count before concept expansion mutates
    // `results` — PRF's >=3 gate is meant to read direct-match evidence, not
    // rows the concept pass just added.
    const primaryCount = results.length;
    expandObsByConceptCo(db, ctx, now, existingIds, results, includeNoise);
    expandObsByPRF(db, ctx, now, primaryCount, existingIds, results, includeNoise);
  }

  // Vector search + RRF hybrid merge
  try {
    if (!vectorsEnabled()) return results; // Phase-1: vector arm disabled → BM25-only path (audit 2026-06-27)
    const vocab = getVocabulary(db);
    if (!vocab) return results;
    const queryText = ftsQuery.replace(/['"()]/g, ' ');
    const queryVec = computeVector(queryText, vocab);
    if (!queryVec) return results;
    const vecResults = vectorSearch(db, queryVec, {
      project: args.project ?? null,
      type: args.obs_type ?? null,
      vocabVersion: vocab.version,
      minCosine: ctx.minCosine, // undefined → MIN_COSINE_SIMILARITY (benchmark sweep override)
    });
    if (vecResults.length === 0) return results;

    // Prepared ONCE for both arms below. better-sqlite3 does not cache statements, so
    // the `db.prepare()` this replaces recompiled the same SQL per vector hit — up to
    // VECTOR_SCAN_LIMIT (500, tfidf.mjs) compilations per hybrid search, on the
    // retrieval path. The two arms are mutually exclusive, so one statement serves both.
    const vecHitObs = db.prepare(`SELECT ${VEC_HIT_OBS_COLS} FROM observations WHERE id = ?`);

    if (results.length > 0) {
      // RRF fuses by RANK (array index), so the BM25 side must already be in
      // composite-score order. `results` here is [full-FTS sorted, …concept ×0.7,
      // …PRF ×0.6] with augmentation rows APPENDED, so its index order is only
      // BM25-rank for the first block — a downweighted PRF row at the tail would be
      // handed to RRF as a worse rank than its score warrants, and a strong one as
      // better. Sort by the calibrated composite score (negative = more relevant)
      // first so index == composite rank and the type-quality/decay/cite multipliers
      // actually shape the fused ranking instead of being discarded by insertion order.
      results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
      const rrfRanking = rrfMerge(results, vecResults, ctx.rrfK); // undefined → RRF_K
      const resultMap = new Map(results.map((r) => [r.id, r]));
      for (const vr of vecResults) {
        if (!resultMap.has(vr.id)) {
          const obs = vecHitObs.get(vr.id);
          if (!obs) continue;
          if (epochFrom !== null && obs.created_at_epoch < epochFrom) continue;
          if (epochTo !== null && obs.created_at_epoch > epochTo) continue;
          if (args.importance && (obs.importance ?? 1) < args.importance) continue;
          if (args.branch && obs.branch !== args.branch) continue;
          if (!includeNoise && obs.title && LOW_SIGNAL_TITLE.test(obs.title)) continue;
          resultMap.set(vr.id, {
            source: 'obs',
            id: obs.id,
            type: obs.type,
            title: obs.title,
            subtitle: obs.subtitle,
            project: obs.project,
            date: obs.created_at,
            created_at: obs.created_at,
            created_at_epoch: obs.created_at_epoch,
            importance: obs.importance,
            files_modified: obs.files_modified,
            lesson_learned: obs.lesson_learned,
            snippet: '',
          });
        }
      }
      // The WHOLE obs leg is now on the RRF scale (score = -rrfScore ≈ 1/(60+rank)), not
      // BM25 — tag every row so cross-source lone-hit banding treats it correctly (P2-12).
      const reordered = rrfRanking
        .filter((rr) => resultMap.has(rr.id))
        .map((rr) => ({ ...resultMap.get(rr.id), score: -rr.rrfScore, scoreScale: 'vector' }));
      results.length = 0;
      results.push(...reordered);
    } else {
      // FTS5 found nothing but vector found results
      for (const vr of vecResults) {
        const obs = vecHitObs.get(vr.id);
        if (!obs) continue;
        if (epochFrom !== null && obs.created_at_epoch < epochFrom) continue;
        if (epochTo !== null && obs.created_at_epoch > epochTo) continue;
        if (args.importance && (obs.importance ?? 1) < args.importance) continue;
        if (args.branch && obs.branch !== args.branch) continue;
        if (!includeNoise && obs.title && LOW_SIGNAL_TITLE.test(obs.title)) continue;
        // Raw cosine similarity scale (≈0.1-1), also not BM25-comparable → tag it (P2-12).
        results.push({
          source: 'obs',
          id: obs.id,
          type: obs.type,
          title: obs.title,
          subtitle: obs.subtitle,
          project: obs.project,
          date: obs.created_at,
          created_at: obs.created_at,
          created_at_epoch: obs.created_at_epoch,
          importance: obs.importance,
          files_modified: obs.files_modified,
          lesson_learned: obs.lesson_learned,
          score: -vr.similarity,
          snippet: '',
          scoreScale: 'vector',
        });
      }
    }
  } catch (e) {
    debugCatch(e, 'searchObservationsHybrid-vector');
  }

  return results;
}
