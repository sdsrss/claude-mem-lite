// lib/inject-search-core.mjs — the retrieval-side shared core (P2-11, audit
// 2026-08-14; second cut D#123, 2026-08-16). Shared home for the three SQL
// atoms that kept drifting across hand-copied twins — first on the five
// injection-side surfaces, then extended across the remaining read surfaces
// (hook-context / hook-handoff / hook-optimize / mem-cli / search-scoring /
// tfidf / deep-search / recall-core / recent-core / timeline-core / stats-core /
// search-core incl. its sessions+events decay arms / maintain-core; the ledger
// test enforces the full list). Deliberate compressed-only singles (maintain
// UPDATE guards, stats noise-gauge counts, export tombstone toggles, session-own
// history) stay inline — see the ledger test's non-member notes:
//
//   * live-row filter        — the compressed+superseded pair whose omission was
//                              the superseded-invariant's recurring reopening
//                              (7th occurrence fixed in v3.63 H-1, write-side)
//   * clamped recency decay  — the MAX(0,…) age clamp (audit M-1: a far-future
//                              created_at from restore/import-jsonl EXP-overflowed
//                              and pinned that row #1; the fix reached
//                              search-engine but not the UPS/error-recall twins)
//   * injection relevance    — the full multiplicative chain incl. cite/noise
//                              behavior factors (audit M-3: wired on every auto
//                              surface, missing from the explicit-surface score)
//
// Each surface keeps its own deliberate pipeline composition (BM25-sort + JS
// scoring vs SQL full chain vs file-keyed sort — see #8786: per-surface
// asymmetries stay explicit); only the ATOMS are shared.
// tests/inject-search-core.test.mjs holds the ledger: consumer files must
// compose these builders, never re-inline copies (and the decay shape may not
// be hand-rolled anywhere, benchmark included).
//
// Lives under lib/ (not scripts/) so hook.mjs can statically import it without
// colliding with the installExtractedRelease scripts-dir rename (same constraint
// as lib/mem-override.mjs). Dependency-light by design: pre-tool-recall's
// standalone fast-path (#8447) already imports scoring-sql.mjs.

import {
  OBS_BM25,
  TYPE_DECAY_CASE,
  TYPE_QUALITY_CASE,
  noisePenaltyClause,
  citeFactorClause,
} from '../scoring-sql.mjs';

/**
 * Live-row filter: rows a model-facing retrieval surface may return. Excludes
 * compression tombstones (positive keeper ids AND -2 pending-purge) and
 * superseded rows (a retracted lesson must never outrank its correction).
 * @param {string} [alias='o'] table alias; '' for unqualified single-table queries
 * @returns {string} SQL boolean expression (no leading AND)
 */
export function liveObsFilterSql(alias = 'o') {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(${a}compressed_into, 0) = 0 AND ${a}superseded_at IS NULL`;
}

/**
 * Clamped recency-decay factor: (1 + EXP(-ln2 · age / halfLife)), age >= 0.
 * The MAX(0,…) clamp is the M-1 fix — restore/import-jsonl accept arbitrary
 * epochs, and an unclamped future timestamp makes the exponent large-positive →
 * EXP overflows to +Infinity → that row sorts #1 for every query (and its score
 * serializes as null). A future row reads as age 0 = max finite recency instead.
 * Binds one `?` placeholder: the caller passes `now` (epoch ms) at that position.
 * @param {object} opts
 * @param {string} opts.tsExpr - SQL expression for the row's reference timestamp
 *   (e.g. 'o.created_at_epoch', or the created/last-accessed MAX search-engine uses)
 * @param {string} [opts.halfLifeSql=TYPE_DECAY_CASE] - SQL expression for the
 *   half-life in ms (constant or per-type CASE; TYPE_DECAY_CASE assumes alias 'o')
 * @param {string} [opts.nowParam='?'] - placeholder text for `now`. Defaults to a
 *   POSITIONAL `?`, which makes the binding order depend on where this expression
 *   lands in the statement — moving it from ORDER BY into a SELECT list silently
 *   renumbers every other placeholder (observed 2026-08-24: the MATCH argument
 *   received a project name and FTS5 reported `no such column`). A caller that
 *   would rather not carry that coupling passes a NAMED placeholder such as
 *   '@now' and binds by object instead. better-sqlite3 does not allow mixing the
 *   two styles in one statement, so this is per-statement, all or nothing.
 * @returns {string} SQL numeric expression (parenthesized)
 */
export function recencyDecaySql({ tsExpr, halfLifeSql = TYPE_DECAY_CASE, nowParam = '?' }) {
  return `(1.0 + EXP(-0.693 * MAX(0, ${nowParam} - ${tsExpr}) / ${halfLifeSql}))`;
}

/**
 * Injection relevance: the full multiplicative chain the prompt-time injection
 * surface (UPS searchByFts) ranks by — BM25 × clamped type-decay × type-quality
 * × importance × noise penalty × cite factor. Alias is fixed to 'o' because
 * TYPE_DECAY_CASE / TYPE_QUALITY_CASE bake that alias in.
 * Binds one `?` placeholder (the decay `now`), first in parameter order.
 * @param {string} [alias='o'] must be 'o'
 * @returns {string} SQL numeric expression
 */
export function injectionRelevanceSql(alias = 'o') {
  if (alias !== 'o') throw new Error('injectionRelevanceSql: alias must be "o" (TYPE_*_CASE bake it in)');
  return `${OBS_BM25}
             * ${recencyDecaySql({ tsExpr: 'o.created_at_epoch' })}
             * ${TYPE_QUALITY_CASE}
             * (0.5 + 0.5 * COALESCE(o.importance, 1))
             * ${noisePenaltyClause('o')}
             * ${citeFactorClause('o')}`;
}
