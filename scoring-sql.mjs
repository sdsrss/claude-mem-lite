// scoring-sql.mjs — SQL constants for BM25 scoring and temporal decay.
// Extracted from utils.mjs for focused module boundaries.

import { buildNotLowSignalSql } from './lib/low-signal-patterns.mjs';

import { DAY_MS } from './lib/time-constants.mjs';
// ─── Why these multipliers exist (read before "simplifying" them) ────────────
//
// The recency-decay, type-quality, project-boost, importance, cite, and noise
// multipliers below encode PRODUCT PRIORS: recent / same-project / important /
// high-signal-type / frequently-cited memories are more relevant to the CURRENT
// dev session. A periodic audit tends to flag them as "0-lift dead weight" —
// resist that on benchmark evidence alone. Measured (audit ②, obs #8773):
//   * benchmark.mjs --matrix (micro-fixture, now models the full FULL_SCORE
//     chain): type-quality is the TOP contributor (drop-type ΔnDCG=0.0082,
//     ΔMRR=0.0166), decay +0.0043 nDCG, importance +0.0012; the chain lifts
//     hybrid over bm25_only by +0.0093 nDCG / +0.0166 MRR (net 0 queries hurt).
//     project, access and lesson read exactly 0 — but that is STRUCTURAL: the
//     fixture is single-project, access_count=0, and has 0 lesson_learned rows,
//     so it cannot vary those three axes.
//   * longmemeval.mjs --temporal (n=500, real dates): bit-identical to uniform —
//     LongMemEval-S windows (mean 27.9d, 74% <30d) are far shorter than these
//     half-lives, so decay moves no rank there either.
// Where a multiplier reads 0 it is a benchmark-MISMATCH artifact (the instrument
// can't vary that axis), NOT proven dead weight. Decision: KEEP them; do NOT
// delete on "0 lift". Guardrail: the ci-gate `hybrid_over_bm25 >= -0.05` floor
// (benchmark/ci-gate.mjs) covers the full modelled chain — D#121: cite + noise
// joined the matrix MULT_EXPR after M-3 put them in FULL_SCORE (fixture carries
// zero cite/noise state, so both read 0 by construction, same caveat as lesson;
// their real-SQL direction pins live in benchmark/events-pipeline-probes.mjs).
// Genuine validation of the prior-encoding axes needs a labeled real-dev-memory eval.

// ─── Type-Differentiated Recency Decay ──────────────────────────────────────

/** Recency half-life per observation type (in milliseconds) */
export const DECAY_HALF_LIFE_BY_TYPE = {
  decision: 90 * DAY_MS, // 90 days — architectural decisions persist
  discovery: 60 * DAY_MS, // 60 days — learned patterns last
  feature: 30 * DAY_MS, // 30 days — feature work is mid-range
  bugfix: 14 * DAY_MS, // 14 days — bugs are usually one-off
  refactor: 14 * DAY_MS, // 14 days — code cleanup
  change: 7 * DAY_MS, //  7 days — routine changes decay fast
};
export const DEFAULT_DECAY_HALF_LIFE_MS = 14 * DAY_MS;

// ─── BM25 Weight Constants ──────────────────────────────────────────────────
// Single source of truth for FTS5 BM25 weight expressions.
// Column order must match ensureFTS() calls in schema.mjs.

/** observations_fts BM25 weights: title=10, subtitle=5, narrative=5, text=3, facts=3, concepts=2, lesson_learned=8, search_aliases=5 */
export const OBS_BM25 = 'bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8, 5)';

/** session_summaries_fts BM25 weights: request=5, investigated=3, learned=3, completed=3, next_steps=2, notes=1, remaining_items=1 */
export const SESS_BM25 = 'bm25(session_summaries_fts, 5, 3, 3, 3, 2, 1, 1)';

/** events_fts BM25 weights: title=5, body=2 (event_type/project are UNINDEXED — weight irrelevant).
 *  Title-weighted like OBS/SESS so a title hit outranks a body-only hit. */
export const EVT_BM25 = 'bm25(events_fts, 5, 2)';

/** FTS5 columns for observations (must match BM25 weight order) */
export const OBS_FTS_COLUMNS = [
  'title',
  'subtitle',
  'narrative',
  'text',
  'facts',
  'concepts',
  'lesson_learned',
  'search_aliases',
];

/** SQL CASE for type-differentiated recency decay half-lives (milliseconds) */
export const TYPE_DECAY_CASE = `(
  CASE o.type
    WHEN 'decision'  THEN 7776000000.0
    WHEN 'discovery' THEN 5184000000.0
    WHEN 'feature'   THEN 2592000000.0
    WHEN 'bugfix'    THEN 1209600000.0
    WHEN 'refactor'  THEN 1209600000.0
    WHEN 'change'    THEN  604800000.0
    ELSE 1209600000.0
  END
)`;

/**
 * Type quality multiplier — promotes high-signal types (decisions, discoveries).
 * Weights calibrated from empirical avg access_count per type in production data:
 *   decision 6.05, discovery 3.32, bugfix 2.24, feature 2.04, change 0.93, refactor 0.54.
 * The old (pre-R2) table had bugfix=0.75 < change=0.8, inverted vs reality.
 * Applied as: BM25 × time_decay × TYPE_QUALITY × project_boost × importance
 */
export const TYPE_QUALITY = {
  decision: 1.5,
  discovery: 1.3,
  bugfix: 1.1,
  feature: 1.0,
  refactor: 0.6,
  change: 0.5,
};

/** Multiplier for a type not in the table (legacy rows, manual saves). */
export const TYPE_QUALITY_DEFAULT = 1.0;

/**
 * The SQL form, generated from TYPE_QUALITY rather than written beside it.
 * The table used to exist three times — here, hook-context.mjs, hook-memory.mjs — with
 * "aligned with scoring-sql.mjs (R2)" comments as the only thing keeping them equal
 * (audit 2026-08-22, P2-10). Values happened to agree; the next re-weighting is what the
 * copies were waiting for. Both JS consumers now import TYPE_QUALITY from here.
 */
export const TYPE_QUALITY_CASE = `(
  CASE o.type
${Object.entries(TYPE_QUALITY)
  .map(([t, w]) => `    WHEN '${t}' THEN ${w.toFixed(1)}`)
  .join('\n')}
    ELSE ${TYPE_QUALITY_DEFAULT.toFixed(1)}
  END
)`;

/**
 * Noise-ratio penalty: deprioritizes observations that get auto-injected often
 * but rarely "used" (cited via Stop-hook citation tracker, or explicitly
 * recalled/opened via pre-tool-recall / cmdRecall / cmdGet / cmdTimeline).
 *
 * Signal sources:
 *   - injection_count: bumped ONLY on UserPromptSubmit / hook-memory auto-inject
 *   - access_count: bumped on citation (c039352 P4), explicit recall, get, timeline
 *
 * Empirical thresholds (v2.47 recalibration — 2026-04-24 live projects--mem,
 * 3789 obs, baseline 10/20 never fired because max injection_count=9):
 *   • Legitimate heavy use (#5588 9/10=0.9, #7549 7/13=0.54): ratio≤3 ⇒ 1.0×
 *   • Early noise candidate (#3518 6/1=6.0): inj≥4 AND ratio>3 ⇒ 0.5× (tier-1)
 *   • Entrenched noise (inj≥8 AND ratio>5): 0.2× (tier-2)
 *
 * Old thresholds (v26→v2.46, inj≥10/≥20) were chosen as theoretical upper bounds
 * before injection_count accumulated 2 months of data — live distribution shows
 * 100% of rows stayed under 10 inject events. The recalibrated gates bite the
 * moderate-noise tier (first real data band) while still sparing ratio-clean
 * heavy-use rows (ratio gate is the primary precision signal).
 *
 * Applied as: BM25 × time_decay × TYPE_QUALITY × (0.5 + 0.5·importance) × NOISE_PENALTY
 * Note: multiplicative so ORDER BY relevance ASC (negative scores) still works —
 * penalty shrinks magnitude, making the row less preferable.
 *
 * @param {string} [alias='o'] Table alias for the observations row.
 * @returns {string} SQL CASE expression (already parenthesized).
 */
export function noisePenaltyClause(alias = 'o') {
  const a = alias ? `${alias}.` : '';
  return `(
    CASE
      WHEN COALESCE(${a}injection_count, 0) >= 8
        AND COALESCE(${a}injection_count, 0) > COALESCE(${a}access_count, 0) * 5
        THEN 0.2
      WHEN COALESCE(${a}injection_count, 0) >= 4
        AND COALESCE(${a}injection_count, 0) > COALESCE(${a}access_count, 0) * 3
        THEN 0.5
      ELSE 1.0
    END
  )`;
}

/**
 * SQL WHERE clause fragment excluding LOW_SIGNAL degraded titles — the fallback
 * titles hook-llm.mjs writes when Haiku summarization is unavailable or skipped
 * (e.g. "Modified X", "Worked on X", "Reviewed N files:", raw "Error: ..." logs).
 *
 * Empirical data: 544 such entries in production, 18 ever accessed (3.3% rate).
 * They are capped at importance=1 on write, but that alone doesn't keep them out
 * of FTS5 injection when BM25 scores are competitive. This clause removes them
 * from the candidate pool at the SQL level so real bugfixes/discoveries dominate.
 *
 * Mirrors LOW_SIGNAL_TITLE regex in utils.mjs — keep in sync.
 *
 * @param {string} [alias='o'] Table alias for the observations row. Use '' for unqualified.
 * @returns {string} SQL boolean expression (already parenthesized; safe to combine with AND/OR)
 */
// β refactor (#7877 applied): delegated to lib/low-signal-patterns.mjs.
// The SQL path (this), the regex path (utils.mjs::LOW_SIGNAL_TITLE), and the
// pre-tool-recall.js inline SQL now all derive from one authoritative
// pattern list. Previously hand-mirrored with "keep in sync" comments.
//
// lessonEscape (2026-07-24 audit P1, D#11): every consumer of THIS clause is an
// observations-table retrieval surface (search, recall, error-recall, context/
// handoff/UPS injection, optimize candidates), so all get the read-side lesson
// escape — a low-signal TITLE no longer hides a row with a real lesson_learned.
// Consumers that must stay title-only import buildNotLowSignalSql directly:
// events-table queries (lib/activity.mjs, pre-tool-recall.js events fallback —
// no lesson_learned column) and noise-title metrics (lib/stats-core.mjs,
// lib/stats-quality.mjs — they COUNT pattern-titled rows, not filter them).
export function notLowSignalTitleClause(alias = 'o') {
  return buildNotLowSignalSql(alias, { lessonEscape: true });
}

// ─── Cite-history factor (A1, v2.83) ────────────────────────────────────────
//
// Closes the citation-decay → ranking loop. The Stop hook citation-decay
// already maintains cited_count (Promote on cite) and uncited_streak (bump on
// uncited; reset on cite or rollover-at-3). Before A1, both columns affected
// only the importance ±1 dial — through `(0.5 + 0.5·importance)` that's a
// ≤2× swing and saturates fast. This factor lets ranking respond directly to
// observed agent behavior on the obs itself.
//
// D#179/D#198 made this factor the ONLY thing citation-decay feeds: that loop
// no longer writes `importance` at all. The reason is that importance is not a
// ranking dial — every injection surface gates candidacy on it, so moving it
// changed WHO IS IN the pool rather than where they ranked. This clause is the
// right home for the signal precisely because it is bounded and pure-ranking:
// a mis-read citation costs at most a 3.0× / 0.4× rank shift and can never
// evict a row. (A second, independent citation → importance path still exists
// via bumpCitationAccess → access_count → the `boost` maintain op; see obs
// #10911. It is out of this clause's scope and is NOT closed.)
//
// Formula: clamp(0.4, 3.0, 1 + 0.2·cited_count − 0.25·uncited_streak)
// Distribution:
//   cited=0, streak=0  → 1.0  (fresh obs, neutral)
//   cited=5, streak=0  → 2.0
//   cited≥10, streak=0 → 3.0  (capped — one viral obs can't dominate)
//   cited=0, streak=2  → 0.5
//   cited=0, streak=3+ → 0.4  (floored; citation-decay resets streak at 3
//                              after demoting importance, so steady-state
//                              streak is bounded by [0,2])
//
// Disjoint from noisePenaltyClause: noise penalty uses
// `injection_count vs access_count` (passive inject vs any access);
// cite_factor uses `cited_count vs uncited_streak` — same-source signal
// maintained only by the citation-decay loop. Both apply multiplicatively;
// order doesn't affect ORDER BY relevance ASC.
export const CITE_FACTOR_MIN = 0.4;
export const CITE_FACTOR_MAX = 3.0;
export const CITE_FACTOR_PER_CITE = 0.2;
export const CITE_FACTOR_PER_STREAK = 0.25;

export function citeFactorClause(alias = 'o') {
  const a = alias ? `${alias}.` : '';
  return `(
    MAX(${CITE_FACTOR_MIN},
      MIN(${CITE_FACTOR_MAX},
        1.0
          + ${CITE_FACTOR_PER_CITE} * COALESCE(${a}cited_count, 0)
          - ${CITE_FACTOR_PER_STREAK} * COALESCE(${a}uncited_streak, 0)
      )
    )
  )`;
}

export function citeFactorJs(row) {
  const cited = row && typeof row.cited_count === 'number' ? row.cited_count : 0;
  const streak = row && typeof row.uncited_streak === 'number' ? row.uncited_streak : 0;
  const raw = 1.0 + CITE_FACTOR_PER_CITE * cited - CITE_FACTOR_PER_STREAK * streak;
  return Math.max(CITE_FACTOR_MIN, Math.min(CITE_FACTOR_MAX, raw));
}
