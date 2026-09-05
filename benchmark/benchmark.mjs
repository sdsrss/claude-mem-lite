#!/usr/bin/env node
// Benchmark runner for claude-mem-lite search quality
// Uses the exact same BM25 scoring formula from server.mjs

import { readFileSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { sanitizeFtsQuery, estimateTokens, cjkBigrams } from '../utils.mjs';
import { searchObservationsHybrid } from '../search-engine.mjs';
import { computePerSourceWindow } from '../lib/search-core.mjs';
import { deepSearch } from '../deep-search.mjs';
import {
  computeVector,
  rebuildVocabulary,
  _resetVocabCache,
  VOCAB_DIM,
  MIN_COSINE_SIMILARITY,
  RRF_K,
} from '../tfidf.mjs';
import { OBS_BM25, TYPE_QUALITY_CASE, noisePenaltyClause, citeFactorClause } from '../scoring-sql.mjs';
import { recencyDecaySql, liveObsFilterSql } from '../lib/inject-search-core.mjs';
import { createTestDb } from '../tests/test-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Seed Database ──────────────────────────────────────────────────────────

export function seedDatabase(db, data) {
  const now = Date.now();

  // Create sessions first (referenced by observations via memory_session_id)
  const sessionIds = new Set();
  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'completed')
  `);

  // Collect all unique session_ids from observations
  for (const obs of data.observations) {
    if (!sessionIds.has(obs.session_id)) {
      sessionIds.add(obs.session_id);
      const epoch = now + obs.epoch_offset_days * 86400000;
      insertSession.run(obs.session_id, obs.session_id, obs.project, new Date(epoch).toISOString(), epoch);
    }
  }

  // Insert observations
  const insertObs = db.prepare(`
    INSERT INTO observations (id, memory_session_id, project, text, type, title, narrative, facts, concepts, files_modified,
      created_at, created_at_epoch, importance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const obsTransaction = db.transaction(() => {
    for (const obs of data.observations) {
      const epoch = now + obs.epoch_offset_days * 86400000;
      // Mirror the production write path (lib/save-observation.mjs, hook-llm.mjs::
      // buildFtsTextField): the indexed text = content + space-separated CJK
      // bigrams, because unicode61 indexes a whole CJK run as ONE token while the
      // query is reduced to bigrams. Raw-inserting `text` left seeded CJK a single
      // un-queryable token, so any CJK/multi-script fixture measured a false zero
      // (#8826: build the corpus through the real save path). cjkBigrams is '' for
      // pure-Latin text, so English fixtures are byte-identical.
      const baseText = obs.text || '';
      const bigrams = cjkBigrams(
        [obs.title, obs.narrative, baseText, obs.concepts].filter(Boolean).join(' '),
      );
      const ftsText = bigrams ? `${baseText} ${bigrams}` : baseText;
      insertObs.run(
        obs.id,
        obs.session_id,
        obs.project,
        ftsText,
        obs.type,
        obs.title,
        obs.narrative,
        obs.facts,
        obs.concepts,
        obs.files_modified,
        new Date(epoch).toISOString(),
        epoch,
        obs.importance,
      );
    }
  });
  obsTransaction();

  // Insert session summaries
  if (data.sessions && data.sessions.length > 0) {
    const insertSummary = db.prepare(`
      INSERT INTO session_summaries (id, memory_session_id, project, request, investigated, learned, completed, next_steps,
        created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const sessTransaction = db.transaction(() => {
      for (const sess of data.sessions) {
        const epoch = now + sess.epoch_offset_days * 86400000;
        // Ensure the session exists
        if (!sessionIds.has(sess.session_id)) {
          sessionIds.add(sess.session_id);
          insertSession.run(
            sess.session_id,
            sess.session_id,
            sess.project,
            new Date(epoch).toISOString(),
            epoch,
          );
        }
        insertSummary.run(
          sess.id,
          sess.session_id,
          sess.project,
          sess.request,
          sess.investigated,
          sess.learned,
          sess.completed,
          sess.next_steps,
          new Date(epoch).toISOString(),
          epoch,
        );
      }
    });
    sessTransaction();
  }

  return { observations: data.observations.length, sessions: (data.sessions || []).length };
}

// ─── Seed Vectors ───────────────────────────────────────────────────────────
//
// seedDatabase only fills observations/observations_fts — the FTS arm. The real
// production search (searchObservationsHybrid) ALSO runs a TF-IDF vector arm and
// RRF-merges the two; without observation_vectors that arm is dead and the
// k=60 / MIN_COSINE / VOCAB_DIM constants never get exercised on the real path.
// seedVectors builds the vocabulary from the seeded corpus and stores a vector
// per observation, exactly as the live save/compress paths do.
export function seedVectors(db, { dim } = {}) {
  _resetVocabCache();
  const vocab = rebuildVocabulary(db, dim ? { dim } : undefined);
  if (!vocab) return { vectors: 0, vocabVersion: null, dim: dim ?? VOCAB_DIM };

  const obs = db
    .prepare(
      `
    SELECT id, title, narrative, concepts FROM observations
    WHERE ${liveObsFilterSql('')}
  `,
    )
    .all();
  const ins = db.prepare(
    'INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)',
  );
  const now = Date.now();
  let n = 0;
  db.transaction(() => {
    for (const o of obs) {
      const vec = computeVector([o.title, o.narrative, o.concepts].filter(Boolean).join(' '), vocab);
      if (vec) {
        ins.run(o.id, Buffer.from(vec.buffer), vocab.version, now);
        n++;
      }
    }
  })();
  return { vectors: n, vocabVersion: vocab.version, dim: vocab.dim };
}

// production_hybrid: drive the REAL searchObservationsHybrid (FTS + vector + RRF),
// not this file's FTS-only `searchObservations`. q.project is passed as the boost
// (currentProject), mirroring the FTS 'hybrid' mode's project-boost semantics
// rather than a hard filter. minCosine / rrfK are sweep overrides (undefined →
// the production MIN_COSINE_SIMILARITY / RRF_K defaults). Requires seedVectors first.
// Exported so external benchmark adapters (e.g. longmemeval.mjs) drive the exact
// same production hybrid path instead of re-assembling ctx and drifting from it.
export function searchProductionHybrid(
  db,
  query,
  { limit = 10, project = null, obsType = null, minCosine, rrfK } = {},
) {
  const ftsQuery = sanitizeFtsQuery(query);
  // Fidelity: use the SAME candidate-pool window the production CLI/MCP path uses
  // (lib/search-core.mjs computePerSourceWindow) instead of a hardcoded max(limit,20).
  // Previously the benchmark fused a different pool than production, so longmemeval
  // could not observe a change to the production pool (e.g. the D#30 offset-independent
  // fix). offset is always 0 here (the benchmark never paginates).
  const { perSourceLimit, perSourceOffset } = computePerSourceWindow(limit, 0);
  const ctx = {
    ftsQuery,
    args: { obs_type: obsType ?? undefined },
    epochFrom: null,
    epochTo: null,
    perSourceLimit,
    perSourceOffset,
    currentProject: project,
    limit,
    minCosine,
    rrfK,
  };
  const rows = searchObservationsHybrid(db, ctx);
  // Fidelity note — reRankWithContext is INTENTIONALLY not mirrored here (it is the
  // one production post-fusion stage searchObservationsHybrid does not run; lib/
  // search-core.mjs:446 applies it after this call in the CLI/MCP path). It is a
  // file-activity recency booster: it boosts obs whose `observation_files` junction
  // rows match files touched in the last 2h of the SAME project, else early-returns
  // a no-op. The longmemeval corpus has NONE of that signal — seedDatabase never
  // writes observation_files and the adapter sets files_modified='[]', so the boost's
  // first query returns 0 rows and the stage is a *structural* identity on this
  // corpus (verified no-op, not an approximation). Sessions are conversations with no
  // file associations, so no realistic future corpus seeds that junction either —
  // mirroring the call would be dead code that never enters its body, unlike the
  // computePerSourceWindow pool coupling (#8799) which every query exercises. So this
  // gap is closed-by-construction, not deferred. (Score signs ARE compatible: the
  // hybrid path negates RRF/vector scores to "negative = better" — search-engine.mjs
  // :437/:450 — matching reRankWithContext's BM25 assumption, so wiring it would be
  // safe if the data ever existed; it doesn't.)
  return rows.slice(0, limit).map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    project: r.project,
    score: r.score ?? 0,
    importance: r.importance,
    // narrative isn't in the hybrid result shape; approximate injection size from
    // title + subtitle/lesson. Secondary metric, not used for ranking.
    tokens: estimateTokens((r.title || '') + ' ' + (r.subtitle || r.lesson_learned || '')),
  }));
}

// ─── Search (mirrors server.mjs BM25 query exactly) ────────────────────────
//
// Modes:
//   'hybrid'        — production scoring: BM25 × time-decay × type-quality ×
//                     project-boost × importance × access-bonus × lesson-boost.
//                     Mirrors search-engine.mjs FULL_SCORE (the full chain).
//   'bm25_only'     — strips all multipliers, pure BM25 ranking. Tests whether
//                     production multipliers add lift over raw FTS5.
//   'recency'       — no FTS, ORDER BY created_at_epoch DESC. Tests whether FTS
//                     retrieval adds anything over "newest-first" baseline.
//   'random'        — deterministic shuffle (seeded by query). Sanity floor —
//                     anything that doesn't beat random is broken.
//   'no_decay'      — drop time-decay; keep the rest. Per-term ablation: how
//                     much does the recency multiplier earn?
//   'no_type'       — drop TYPE_QUALITY_CASE; isolates type-quality lift. The
//                     fixture spans 5 types, so this one is genuinely measurable.
//   'no_project'    — drop project boost; isolates whether current-project bias
//                     is doing real work on the eval set.
//   'no_importance' — drop the (0.5+0.5*importance) multiplier.
//   'no_access'     — drop the (1+0.1*ln(1+access)) multiplier.
//   'no_lesson'     — drop the (1+0.3*lesson) boost. The fixture has 0
//                     lesson_learned rows, so this multiplier is a constant 1.0×
//                     there and reports 0 by construction (untestable here).
//   'no_noise'      — drop noisePenaltyClause. Like lesson, the fixture carries
//                     zero injection/access counters, so it reads 0 by
//                     construction — included so `hybrid` models the FULL_SCORE
//                     chain (D#121: cite+noise joined FULL_SCORE in v3.63 M-3 and
//                     the matrix/ci-gate floor silently covered a subset).
//   'no_cite'       — drop citeFactorClause. Same fixture caveat as no_noise.
//
// Per-term ablation modes were added to answer "do these multipliers earn their
// keep?" — the previous matrix only compared full-hybrid vs bm25_only, leaving
// per-multiplier contribution invisible. Each MODE_TERMS entry lists which
// multipliers stay in the formula; placeholder threading stays correct because
// each multiplier's parameters are appended in MULT_PARAMS order.

const MULT_EXPR = {
  // decay composes the real clamped shape (D#123): same MAX(created, last_accessed)
  // timestamp and per-type half-life as search-engine FULL_SCORE — the previous
  // hand-copy was unclamped, created-only, constant-half-life while the mode doc
  // above claims FULL_SCORE fidelity.
  decay: recencyDecaySql({
    tsExpr: 'MAX(o.created_at_epoch, COALESCE(o.last_accessed_at, o.created_at_epoch))',
  }),
  // type imports the real TYPE_QUALITY_CASE (no hardcoded copy — #8770); lesson
  // mirrors search-engine.mjs FULL_SCORE's inline boost (no exported constant —
  // keep in sync). Both added so `hybrid` mirrors the full production chain.
  type: TYPE_QUALITY_CASE,
  project: '(CASE WHEN ? IS NOT NULL AND o.project = ? THEN 2.0 ELSE 1.0 END)',
  importance: '(0.5 + 0.5 * COALESCE(o.importance, 1))',
  access: '(1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0)))',
  lesson: "(1.0 + 0.3 * (o.lesson_learned IS NOT NULL AND o.lesson_learned NOT IN ('', 'none')))",
  // noise/cite import the real clauses (no hardcoded copies) — D#121: FULL_SCORE
  // gained both in v3.63 M-3; without them here the matrix scored a stale chain.
  noise: noisePenaltyClause('o'),
  cite: citeFactorClause('o'),
};
const MULT_PARAMS = {
  decay: (now) => [now],
  type: () => [],
  project: (_now, project) => [project, project],
  importance: () => [],
  access: () => [],
  lesson: () => [],
  noise: () => [],
  cite: () => [],
};
// NOTE: decay must precede project in every term list so the bound params
// (decay → [now], project → [project, project]) stay aligned with the `?`
// placeholders. type/importance/access/lesson contribute no params.
const MODE_TERMS = {
  hybrid: ['decay', 'type', 'project', 'importance', 'access', 'lesson', 'noise', 'cite'],
  bm25_only: [],
  no_decay: ['type', 'project', 'importance', 'access', 'lesson', 'noise', 'cite'],
  no_type: ['decay', 'project', 'importance', 'access', 'lesson', 'noise', 'cite'],
  no_project: ['decay', 'type', 'importance', 'access', 'lesson', 'noise', 'cite'],
  no_importance: ['decay', 'type', 'project', 'access', 'lesson', 'noise', 'cite'],
  no_access: ['decay', 'type', 'project', 'importance', 'lesson', 'noise', 'cite'],
  no_lesson: ['decay', 'type', 'project', 'importance', 'access', 'noise', 'cite'],
  no_noise: ['decay', 'type', 'project', 'importance', 'access', 'lesson', 'cite'],
  no_cite: ['decay', 'type', 'project', 'importance', 'access', 'lesson', 'noise'],
};

function searchObservations(db, query, options = {}) {
  const mode = options.mode ?? 'hybrid';
  const limit = options.limit ?? 20;
  const project = options.project ?? null;
  const obsType = options.type ?? null;

  if (mode === 'random') return searchRandom(db, query, { limit, project, obsType });
  if (mode === 'recency') return searchRecency(db, { limit, project, obsType });
  if (mode === 'production_hybrid') return searchProductionHybrid(db, query, { limit, project, obsType });

  const terms = MODE_TERMS[mode];
  if (!terms) throw new Error(`Unknown benchmark mode: ${mode}`);

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  const now = Date.now();
  // Use the SAME BM25 weight expression production scoring uses (scoring-sql.mjs
  // OBS_BM25), not a hardcoded literal. The old literal carried only 7 weights
  // (omitting the search_aliases column, which then fell back to FTS5's default
  // weight of 1.0 instead of production's 5.0) — so the ablation/matrix/ci-gate
  // path scored a stale formula and a search_aliases-weight change passed the
  // gate invisibly. Importing the constant keeps the micro-bench faithful to
  // production by construction. On a fixture with no search_aliases data the
  // 8th weight is inert, so existing numbers are unchanged.
  const baseBm25 = OBS_BM25;
  const scoreExpr =
    terms.length === 0
      ? `${baseBm25} as score`
      : `${baseBm25} * ${terms.map((t) => MULT_EXPR[t]).join(' * ')} as score`;

  const scoreParams = terms.flatMap((t) => MULT_PARAMS[t](now, project));

  const sql = `
    SELECT o.id, o.type, o.title, o.subtitle, o.project, o.created_at, o.importance,
           o.files_modified, o.narrative, o.text,
           ${scoreExpr}
    FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE observations_fts MATCH ?
      AND COALESCE(o.compressed_into, 0) = 0
      AND (? IS NULL OR o.project = ?)
      AND (? IS NULL OR o.type = ?)
    ORDER BY score
    LIMIT ?
  `;
  const params = [...scoreParams, ftsQuery, project, project, obsType, obsType, limit];
  const rows = db.prepare(sql).all(...params);

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    project: r.project,
    score: r.score,
    importance: r.importance,
    tokens: estimateTokens((r.title || '') + ' ' + (r.narrative || '')),
  }));
}

function searchRecency(db, { limit, project, obsType }) {
  const rows = db
    .prepare(
      `
    SELECT o.id, o.type, o.title, o.subtitle, o.project, o.importance, o.narrative
    FROM observations o
    WHERE COALESCE(o.compressed_into, 0) = 0
      AND (? IS NULL OR o.project = ?)
      AND (? IS NULL OR o.type = ?)
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `,
    )
    .all(project, project, obsType, obsType, limit);
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    project: r.project,
    score: 0,
    importance: r.importance,
    tokens: estimateTokens((r.title || '') + ' ' + (r.narrative || '')),
  }));
}

function searchRandom(db, query, { limit, project, obsType }) {
  const rows = db
    .prepare(
      `
    SELECT o.id, o.type, o.title, o.project, o.importance, o.narrative
    FROM observations o
    WHERE COALESCE(o.compressed_into, 0) = 0
      AND (? IS NULL OR o.project = ?)
      AND (? IS NULL OR o.type = ?)
  `,
    )
    .all(project, project, obsType, obsType);
  // Deterministic shuffle: seed = hash(query) so repeated runs reproduce.
  let seed = 0;
  for (let i = 0; i < query.length; i++) seed = (seed * 31 + query.charCodeAt(i)) | 0;
  const shuffled = rows.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, limit).map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    project: r.project,
    score: 0,
    importance: r.importance,
    tokens: estimateTokens((r.title || '') + ' ' + (r.narrative || '')),
  }));
}

// ─── Metrics ────────────────────────────────────────────────────────────────

export function computeRecallAtK(results, relevantIds, k = 10) {
  if (!relevantIds || relevantIds.length === 0) return 0;
  const topK = results.slice(0, k).map((r) => r.id);
  const hits = topK.filter((id) => relevantIds.includes(id)).length;
  return hits / relevantIds.length;
}

export function computePrecisionAtK(results, relevantIds, k = 10) {
  const topK = results.slice(0, k);
  if (topK.length === 0) return 0;
  const hits = topK.filter((r) => relevantIds.includes(r.id)).length;
  return hits / topK.length;
}

export function computeNDCG(results, relevantIds, k = 10) {
  if (!relevantIds || relevantIds.length === 0) return 0;
  const topK = results.slice(0, k);

  // Compute DCG
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = relevantIds.includes(topK[i].id) ? 1 : 0;
    dcg += rel / Math.log2(i + 2); // i+2 because log2(1) = 0
  }

  // Compute ideal DCG (all relevant docs at top)
  const idealHits = Math.min(relevantIds.length, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

export function computeMRR(results, relevantIds) {
  if (!relevantIds || relevantIds.length === 0) return 0;
  for (let i = 0; i < results.length; i++) {
    if (relevantIds.includes(results[i].id)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

export function measureLatencyP95(db, queries, mode = 'hybrid') {
  const latencies = [];
  // Run each query 3 times to get stable measurements
  for (let run = 0; run < 3; run++) {
    for (const q of queries) {
      const start = performance.now();
      searchObservations(db, q.query, { project: q.project, type: q.type, mode });
      const elapsed = performance.now() - start;
      latencies.push(elapsed);
    }
  }
  latencies.sort((a, b) => a - b);
  const p95Index = Math.floor(latencies.length * 0.95);
  return latencies[p95Index] || latencies[latencies.length - 1] || 0;
}

// ─── Run Benchmark ──────────────────────────────────────────────────────────

export function runBenchmark(db, queries, mode = 'hybrid') {
  const results = {
    timestamp: new Date().toISOString(),
    mode,
    queryCount: queries.length,
    metrics: {
      recall_at_10: 0,
      precision_at_10: 0,
      ndcg_at_10: 0,
      mrr_at_10: 0,
      avg_tokens_injected: 0,
      p95_search_latency_ms: 0,
    },
    perQuery: [],
    byCategory: {},
  };

  let totalRecall = 0;
  let totalPrecision = 0;
  let totalNDCG = 0;
  let totalMRR = 0;
  let totalTokens = 0;

  // Category accumulators
  const catAccum = {};

  for (const q of queries) {
    const searchResults = searchObservations(db, q.query, {
      project: q.project,
      type: q.type,
      limit: 10,
      mode,
    });

    const recall = computeRecallAtK(searchResults, q.relevant_ids, 10);
    const precision = computePrecisionAtK(searchResults, q.relevant_ids, 10);
    const ndcg = computeNDCG(searchResults, q.relevant_ids, 10);
    const mrr = computeMRR(searchResults, q.relevant_ids);
    const tokens = searchResults.reduce((sum, r) => sum + r.tokens, 0);

    totalRecall += recall;
    totalPrecision += precision;
    totalNDCG += ndcg;
    totalMRR += mrr;
    totalTokens += tokens;

    // Track per-category
    const cat = q.category || 'standard';
    if (!catAccum[cat]) catAccum[cat] = { recall: 0, precision: 0, ndcg: 0, mrr: 0, count: 0 };
    catAccum[cat].recall += recall;
    catAccum[cat].precision += precision;
    catAccum[cat].ndcg += ndcg;
    catAccum[cat].mrr += mrr;
    catAccum[cat].count++;

    results.perQuery.push({
      id: q.id,
      query: q.query,
      category: cat,
      recall_at_10: round(recall),
      precision_at_10: round(precision),
      ndcg_at_10: round(ndcg),
      mrr: round(mrr),
      result_ids: searchResults.map((r) => r.id),
      relevant_ids: q.relevant_ids,
      tokens,
    });
  }

  const n = queries.length;
  results.metrics.recall_at_10 = round(totalRecall / n);
  results.metrics.precision_at_10 = round(totalPrecision / n);
  results.metrics.ndcg_at_10 = round(totalNDCG / n);
  results.metrics.mrr_at_10 = round(totalMRR / n);
  results.metrics.avg_tokens_injected = Math.round(totalTokens / n);
  results.metrics.p95_search_latency_ms = round(measureLatencyP95(db, queries, mode));

  // Per-category averages
  for (const [cat, acc] of Object.entries(catAccum)) {
    results.byCategory[cat] = {
      count: acc.count,
      recall_at_10: round(acc.recall / acc.count),
      precision_at_10: round(acc.precision / acc.count),
      ndcg_at_10: round(acc.ndcg / acc.count),
      mrr_at_10: round(acc.mrr / acc.count),
    };
  }

  return results;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}

// ─── Baseline Matrix ────────────────────────────────────────────────────────
//
// Runs the same query set across all four scoring modes. Surfaces the lift
// (or absence of lift) each layer adds: hybrid vs bm25_only isolates the
// contribution of production multipliers; bm25_only vs recency isolates
// FTS5 retrieval value; recency vs random isolates ordering value.
//
// Without this, the audit conclusion "no baseline" stands — every retrieval
// metric is unfalsifiable. With this, future scoring tuning has an evidence
// anchor: a tuning that doesn't beat bm25_only is overfitting; one that
// doesn't beat recency-only is broken.

const BASELINE_MODES = ['hybrid', 'bm25_only', 'recency', 'random'];
const ABLATION_MODES = [
  'no_decay',
  'no_type',
  'no_project',
  'no_importance',
  'no_access',
  'no_lesson',
  'no_noise',
  'no_cite',
];

/**
 * Deterministically partition a query fixture into train + eval splits so the
 * vocabulary built from `train` can be evaluated on truly held-out queries.
 * Without this, the benchmark trains and evaluates on the same set, inflating
 * metrics. Mulberry32 PRNG seeded by `seed` so partitions are reproducible.
 *
 * @param {Array}  queries      Full query fixture (each carries id + relevant_ids).
 * @param {number} [ratio=0.3]  Fraction reserved for eval split.
 * @param {number} [seed=42]    PRNG seed; same input → same split.
 * @returns {{ train: Array, eval: Array }}
 */
export function splitFixture(queries, ratio = 0.3, seed = 42) {
  const arr = queries.slice();
  let s = seed >>> 0;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    const j = Math.floor(r * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const evalCount = Math.max(1, Math.round(arr.length * ratio));
  return { eval: arr.slice(0, evalCount), train: arr.slice(evalCount) };
}

export function runBenchmarkMatrix(db, queries, options = {}) {
  const includeAblations = options.ablations !== false;
  const matrix = {
    timestamp: new Date().toISOString(),
    queryCount: queries.length,
    modes: {},
    deltas: {},
    perQueryDeltas: {},
  };
  // Lock the DB to read-only for the matrix run. searchObservations in this
  // file is currently SELECT-only, but server.mjs's production search bumps
  // access_count on read — if a future contributor wires that path here,
  // mode results would silently become order-dependent. `query_only=ON`
  // converts any accidental write into an error so the divergence surfaces.
  // Restored after the loop so this function plays nice with shared db.
  const wasQueryOnly = db.pragma('query_only', { simple: true });
  db.pragma('query_only = ON');
  try {
    const modes = includeAblations ? [...BASELINE_MODES, ...ABLATION_MODES] : BASELINE_MODES;
    for (const mode of modes) {
      matrix.modes[mode] = runBenchmark(db, queries, mode);
    }
  } finally {
    db.pragma(`query_only = ${wasQueryOnly ? 'ON' : 'OFF'}`);
  }
  // Lift over each lower tier (each delta tells you what that layer is buying).
  matrix.deltas.hybrid_over_bm25 = diffMetrics(matrix.modes.hybrid, matrix.modes.bm25_only);
  matrix.deltas.bm25_over_recency = diffMetrics(matrix.modes.bm25_only, matrix.modes.recency);
  matrix.deltas.recency_over_random = diffMetrics(matrix.modes.recency, matrix.modes.random);
  // Per-term ablation deltas: hybrid vs the single-multiplier-removed mode.
  // Positive Δ on a metric means dropping that multiplier hurts; near-zero
  // means it earns no measurable lift on this fixture and is a candidate for
  // removal (smaller surface, fewer SQL ops, identical quality).
  if (includeAblations) {
    for (const ab of ABLATION_MODES) {
      if (matrix.modes[ab]) {
        matrix.deltas[`hybrid_over_${ab}`] = diffMetrics(matrix.modes.hybrid, matrix.modes[ab]);
      }
    }
  }
  // Per-query Δ — surfaces WHICH queries gain from multipliers vs which are
  // multiplier-neutral. If hybrid_over_bm25 aggregate is 0, this answers
  // whether (a) all queries are individually 0-lift (multipliers are dead
  // weight on this corpus) or (b) some queries gain and some lose,
  // averaging to 0 (multipliers are noisy, possibly directionally wrong).
  // The delete-or-defend decision needs this granularity.
  matrix.perQueryDeltas.hybrid_over_bm25 = perQueryDelta(matrix.modes.hybrid, matrix.modes.bm25_only);
  matrix.perQueryDeltas.bm25_over_recency = perQueryDelta(matrix.modes.bm25_only, matrix.modes.recency);
  return matrix;
}

function diffMetrics(a, b) {
  const out = {};
  for (const k of ['recall_at_10', 'precision_at_10', 'ndcg_at_10', 'mrr_at_10']) {
    out[k] = round(a.metrics[k] - b.metrics[k]);
  }
  return out;
}

function perQueryDelta(higher, lower) {
  // Pair up by query id (perQuery arrays are ordered identically — same
  // input queries iterated in the same order across modes).
  const byId = new Map();
  for (const q of lower.perQuery) byId.set(q.id, q);
  const out = [];
  for (const hi of higher.perQuery) {
    const lo = byId.get(hi.id);
    if (!lo) continue;
    out.push({
      id: hi.id,
      query: hi.query,
      ndcg_delta: round(hi.ndcg_at_10 - lo.ndcg_at_10),
      mrr_delta: round(hi.mrr - lo.mrr),
      recall_delta: round(hi.recall_at_10 - lo.recall_at_10),
    });
  }
  // Sort by ndcg_delta DESC — biggest lifts first. Ties broken by mrr_delta.
  out.sort((a, b) => b.ndcg_delta - a.ndcg_delta || b.mrr_delta - a.mrr_delta);
  return out;
}

// Summarize per-query delta into bins: how many queries gained, lost, or stayed flat.
// Default threshold 0.001 sits one decimal above round()'s 0.0001 precision —
// any 4-decimal-rounded delta of 0.0001/0.0002 falls in `neutral`, which is
// the right behavior (sub-rounding deltas are noise, not signal). Threshold
// 0.001 represents "≥0.1% nDCG move" — the smallest difference reliably
// reproducible across runs on this fixture.
export function summarizePerQueryDelta(deltas, threshold = 0.001) {
  const bins = { gained: 0, neutral: 0, lost: 0 };
  for (const d of deltas) {
    if (d.ndcg_delta > threshold) bins.gained++;
    else if (d.ndcg_delta < -threshold) bins.lost++;
    else bins.neutral++;
  }
  return bins;
}

// ─── Vector Constant Sweep ──────────────────────────────────────────────────
//
// Sweeps VOCAB_DIM × MIN_COSINE × RRF_K over the REAL production_hybrid path to
// pin the empirical values. The current production defaults (512 / 0.05 / 60)
// are included as a row so the sweep both validates and locates them. dim
// requires a vocab rebuild + vector re-seed; minCosine/rrfK are query-time, so
// the dim loop is outermost.
const SWEEP_DIMS = [256, 512, 768];
const SWEEP_MIN_COSINE = [0.03, 0.05, 0.08];
const SWEEP_RRF_K = [40, 60, 80];

export function runVectorSweep(db, queries, opts = {}) {
  const dims = opts.dims || SWEEP_DIMS;
  const minCosines = opts.minCosines || SWEEP_MIN_COSINE;
  const rrfKs = opts.rrfKs || SWEEP_RRF_K;
  const rows = [];
  for (const dim of dims) {
    seedVectors(db, { dim });
    for (const minCosine of minCosines) {
      for (const rrfK of rrfKs) {
        let R = 0,
          P = 0,
          N = 0,
          M = 0;
        for (const q of queries) {
          const res = searchProductionHybrid(db, q.query, {
            limit: 10,
            project: q.project,
            obsType: q.type,
            minCosine,
            rrfK,
          });
          R += computeRecallAtK(res, q.relevant_ids, 10);
          P += computePrecisionAtK(res, q.relevant_ids, 10);
          N += computeNDCG(res, q.relevant_ids, 10);
          M += computeMRR(res, q.relevant_ids);
        }
        const n = queries.length;
        rows.push({
          dim,
          minCosine,
          rrfK,
          recall_at_10: round(R / n),
          precision_at_10: round(P / n),
          ndcg_at_10: round(N / n),
          mrr_at_10: round(M / n),
        });
      }
    }
  }
  // Best config by nDCG (ties → higher MRR). `pinnedIsBest` tells you whether the
  // current production defaults are already the sweep optimum on this fixture.
  const sorted = rows.slice().sort((a, b) => b.ndcg_at_10 - a.ndcg_at_10 || b.mrr_at_10 - a.mrr_at_10);
  const best = sorted[0];
  const pinned = { dim: VOCAB_DIM, minCosine: MIN_COSINE_SIMILARITY, rrfK: RRF_K };
  const pinnedIsBest =
    !!best && best.dim === pinned.dim && best.minCosine === pinned.minCosine && best.rrfK === pinned.rrfK;
  return { rows, best, pinned, pinnedIsBest };
}

// ─── Deep Search (LLM multi-query / HyDE) ─────────────────────────────────────
//
// Measures the production deep-search path (deep-search.mjs) on the
// vocabulary-mismatch fixture against the single-query production_hybrid
// baseline. Uses a fixture-backed FAKE llm (recorded rewrites) so the result is
// deterministic and CI-able — it isolates FUSION quality from live Haiku rewrite
// flakiness (#8730: don't let a flaky live-LLM into the gate; #8731: real Haiku
// returned 5/12 empty). deep-search keeps the original query as variant[0], so
// the live number lands between this ceiling and the single-query floor.
export async function runDeepSearch(db, queries, rewritesByQuery, { rrfK } = {}) {
  // Fake llm: resolve recorded rewrites by the query text carried in the user slot.
  const fakeLLM = async (prompt) => {
    const q = ((prompt && prompt.user) || '').trim();
    const variants = rewritesByQuery[q];
    return Array.isArray(variants) && variants.length ? { variants } : null;
  };

  let baseR = 0,
    baseNd = 0,
    baseMrr = 0;
  let deepR = 0,
    deepNd = 0,
    deepMrr = 0;
  const perQuery = [];
  // Baseline = the SAME deep-search pipeline forced to one query (no-rewrite llm),
  // so baseline and deep differ ONLY in variant count — never in project regime,
  // perSourceLimit, or row shape. The old searchProductionHybrid baseline put
  // `project` in the BOOST slot (currentProject) while deepSearch's buildHybridCtx
  // puts it in the FILTER slot (args.project, which also disables the boost — see
  // search-engine.mjs `projectBoost = args.project ? null : currentProject`).
  // Comparing the two would confound multi-query fusion with project filter-vs-boost
  // the moment a suite query carries a project (F14). Today's vocab-mismatch queries
  // pass project=null, so this changes no number — it is a structural guard that also
  // makes the rewrite-failure floor (deep == baseline) hold by construction.
  const noRewriteLlm = async () => null;
  for (const q of queries) {
    const { results: base } = await deepSearch(
      db,
      { query: q.query, project: q.project, type: q.type, limit: 10 },
      { llm: noRewriteLlm, rrfK },
    );
    const { results: deep, variants } = await deepSearch(
      db,
      { query: q.query, project: q.project, type: q.type, limit: 10 },
      { llm: fakeLLM, rrfK },
    );
    const bR = computeRecallAtK(base, q.relevant_ids, 10);
    const dR = computeRecallAtK(deep, q.relevant_ids, 10);
    baseR += bR;
    baseNd += computeNDCG(base, q.relevant_ids, 10);
    baseMrr += computeMRR(base, q.relevant_ids);
    deepR += dR;
    deepNd += computeNDCG(deep, q.relevant_ids, 10);
    deepMrr += computeMRR(deep, q.relevant_ids);
    perQuery.push({
      id: q.id,
      query: q.query,
      baseline_recall_at_10: round(bR),
      deep_recall_at_10: round(dR),
      recall_delta: round(dR - bR),
      variant_count: variants.length,
    });
  }
  const n = queries.length || 1;
  const baseline = {
    recall_at_10: round(baseR / n),
    ndcg_at_10: round(baseNd / n),
    mrr_at_10: round(baseMrr / n),
  };
  const deepM = {
    recall_at_10: round(deepR / n),
    ndcg_at_10: round(deepNd / n),
    mrr_at_10: round(deepMrr / n),
  };
  return {
    queryCount: queries.length,
    baseline,
    deep: deepM,
    delta: {
      recall_at_10: round(deepM.recall_at_10 - baseline.recall_at_10),
      ndcg_at_10: round(deepM.ndcg_at_10 - baseline.ndcg_at_10),
      mrr_at_10: round(deepM.mrr_at_10 - baseline.mrr_at_10),
    },
    perQuery,
  };
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────

async function main() {
  const seedPath = join(__dirname, 'fixtures', 'seed-data.json');
  // --queries <path>: run an alternate query fixture (path relative to benchmark/,
  // or absolute) instead of the default keyword set. Used by the isolated
  // vocab-mismatch suite so it never dilutes the main baseline / CI gate.
  const cliArgv = process.argv.slice(2);
  const qFlagIdx = cliArgv.indexOf('--queries');
  const queriesPath =
    qFlagIdx >= 0 && cliArgv[qFlagIdx + 1]
      ? isAbsolute(cliArgv[qFlagIdx + 1])
        ? cliArgv[qFlagIdx + 1]
        : join(__dirname, cliArgv[qFlagIdx + 1])
      : join(__dirname, 'fixtures', 'test-queries.json');

  const seedData = JSON.parse(readFileSync(seedPath, 'utf-8'));
  const queryData = JSON.parse(readFileSync(queriesPath, 'utf-8'));

  console.error('Creating benchmark database...');
  const db = createTestDb();

  console.error('Seeding database...');
  const counts = seedDatabase(db, seedData);
  console.error(`  Seeded ${counts.observations} observations, ${counts.sessions} sessions`);

  const args = new Set(process.argv.slice(2));
  const matrixMode = args.has('--matrix') || args.has('--baselines');
  const holdoutMode = args.has('--holdout');
  const productionHybridMode = args.has('--production-hybrid');
  const vectorSweepMode = args.has('--vector-sweep');
  const deepSearchMode = args.has('--deep-search');
  const ablations = !args.has('--no-ablations');

  // --deep-search: production deep-search (deep-search.mjs) vs single-query
  // baseline on the vocab-mismatch suite, using recorded rewrites (deterministic
  // fake llm). Defaults to the vocab-mismatch fixture (the set the rewrites file
  // matches) unless --queries overrode it; --rewrites overrides the rewrites path.
  if (deepSearchMode) {
    const dqPath =
      qFlagIdx >= 0 && cliArgv[qFlagIdx + 1]
        ? queriesPath
        : join(__dirname, 'fixtures', 'test-queries-vocab-mismatch.json');
    const rFlagIdx = cliArgv.indexOf('--rewrites');
    const rewritesPath =
      rFlagIdx >= 0 && cliArgv[rFlagIdx + 1]
        ? isAbsolute(cliArgv[rFlagIdx + 1])
          ? cliArgv[rFlagIdx + 1]
          : join(__dirname, cliArgv[rFlagIdx + 1])
        : join(__dirname, 'fixtures', 'rewrites-vocab-mismatch.json');
    const dQueries = JSON.parse(readFileSync(dqPath, 'utf8')).queries;
    const rewritesFile = JSON.parse(readFileSync(rewritesPath, 'utf8'));
    const rewritesByQuery = rewritesFile.rewrites || rewritesFile;

    const seeded = seedVectors(db);
    console.error(
      `Seeded ${seeded.vectors} observation vectors (vocab ${seeded.vocabVersion}, dim ${seeded.dim})`,
    );
    console.error('Running deep-search benchmark (recorded rewrites, deterministic fake llm)...');
    const res = await runDeepSearch(db, dQueries, rewritesByQuery);
    console.log(JSON.stringify(res, null, 2));
    console.error('\n─── Deep Search (LLM multi-query/HyDE, recorded rewrites) ───');
    console.error(
      `  baseline (single-query): R@10=${res.baseline.recall_at_10}  nDCG=${res.baseline.ndcg_at_10}  MRR=${res.baseline.mrr_at_10}`,
    );
    console.error(
      `  deep     (multi + RRF):  R@10=${res.deep.recall_at_10}  nDCG=${res.deep.ndcg_at_10}  MRR=${res.deep.mrr_at_10}`,
    );
    console.error(
      `  Δ:                       R@10=${res.delta.recall_at_10}  nDCG=${res.delta.ndcg_at_10}  MRR=${res.delta.mrr_at_10}`,
    );
    console.error(
      '  (deterministic ceiling — all rewrites usable. Live Haiku reliability is lower; deep-search keeps the',
    );
    console.error('   original query as variant[0], so the live number stays >= the single-query baseline.)');
    db.close();
    return;
  }

  // --vector-sweep: pin VOCAB_DIM × MIN_COSINE × RRF_K on the real hybrid path.
  if (vectorSweepMode) {
    console.error('Running vector constant sweep over the real searchObservationsHybrid path...');
    const sweep = runVectorSweep(db, queryData.queries);
    console.log(JSON.stringify(sweep, null, 2));
    console.error('\n─── Vector Sweep (real searchObservationsHybrid) ───');
    console.error(
      `  ${'dim'.padStart(5)} ${'minCos'.padStart(7)} ${'rrfK'.padStart(5)} ${'R@10'.padStart(7)} ${'P@10'.padStart(7)} ${'nDCG'.padStart(7)} ${'MRR'.padStart(7)}`,
    );
    for (const r of sweep.rows) {
      console.error(
        `  ${String(r.dim).padStart(5)} ${String(r.minCosine).padStart(7)} ${String(r.rrfK).padStart(5)} ${String(r.recall_at_10).padStart(7)} ${String(r.precision_at_10).padStart(7)} ${String(r.ndcg_at_10).padStart(7)} ${String(r.mrr_at_10).padStart(7)}`,
      );
    }
    console.error(
      `\n  Pinned defaults: dim=${sweep.pinned.dim} minCosine=${sweep.pinned.minCosine} rrfK=${sweep.pinned.rrfK}`,
    );
    console.error(
      `  Best on fixture: dim=${sweep.best.dim} minCosine=${sweep.best.minCosine} rrfK=${sweep.best.rrfK} (nDCG=${sweep.best.ndcg_at_10})`,
    );
    console.error(`  → pinned defaults ${sweep.pinnedIsBest ? 'ARE' : 'are NOT'} the fixture optimum`);
    db.close();
    return;
  }

  // --production-hybrid: run the eval over the real FTS+vector+RRF path.
  if (productionHybridMode) {
    const seeded = seedVectors(db);
    console.error(
      `Seeded ${seeded.vectors} observation vectors (vocab ${seeded.vocabVersion}, dim ${seeded.dim})`,
    );
    console.error('Running benchmark on the real searchObservationsHybrid path...');
    const results = runBenchmark(db, queryData.queries, 'production_hybrid');
    console.log(JSON.stringify(results, null, 2));
    console.error('\n─── production_hybrid (real path) ───');
    console.error(`  Recall@10:    ${results.metrics.recall_at_10}`);
    console.error(`  Precision@10: ${results.metrics.precision_at_10}`);
    console.error(`  nDCG@10:      ${results.metrics.ndcg_at_10}`);
    console.error(`  MRR@10:       ${results.metrics.mrr_at_10}`);
    console.error(`  P95 latency:  ${results.metrics.p95_search_latency_ms}ms`);
    db.close();
    return;
  }

  // --holdout splits the query fixture into train/eval (default 70/30,
  // deterministic seed) and runs the matrix on the eval split only. Closes the
  // overfitting hole where vocabulary built from seed-data was being scored on
  // the same set used to build it.
  let evalQueries = queryData.queries;
  let split = null;
  if (holdoutMode) {
    split = splitFixture(queryData.queries, 0.3, 42);
    evalQueries = split.eval;
    console.error(
      `Holdout mode: ${split.train.length} train (vocab build) / ${split.eval.length} eval queries`,
    );
  }

  if (matrixMode) {
    console.error(`Running benchmark matrix (hybrid + 3 baselines${ablations ? ' + 4 ablations' : ''})...`);
    const matrix = runBenchmarkMatrix(db, evalQueries, { ablations });
    if (split) matrix.holdout = { train: split.train.length, eval: split.eval.length, seed: 42, ratio: 0.3 };
    console.log(JSON.stringify(matrix, null, 2));

    console.error('\n─── Benchmark Matrix ───');
    const head = `  ${'mode'.padEnd(15)} ${'R@10'.padStart(7)} ${'P@10'.padStart(7)} ${'nDCG'.padStart(7)} ${'MRR'.padStart(7)} ${'p95ms'.padStart(7)}`;
    console.error(head);
    console.error(
      `  ${'-'.repeat(15)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(7)}`,
    );
    const allModes = ablations ? [...BASELINE_MODES, ...ABLATION_MODES] : BASELINE_MODES;
    for (const mode of allModes) {
      const m = matrix.modes[mode].metrics;
      console.error(
        `  ${mode.padEnd(15)} ${String(m.recall_at_10).padStart(7)} ${String(m.precision_at_10).padStart(7)} ${String(m.ndcg_at_10).padStart(7)} ${String(m.mrr_at_10).padStart(7)} ${String(m.p95_search_latency_ms).padStart(7)}`,
      );
    }
    console.error('\n─── Lift (Δ recall / Δ precision / Δ nDCG / Δ MRR) ───');
    const dh = matrix.deltas.hybrid_over_bm25;
    const db1 = matrix.deltas.bm25_over_recency;
    const dr = matrix.deltas.recency_over_random;
    console.error(
      `  hybrid    over bm25_only: R=${dh.recall_at_10} P=${dh.precision_at_10} nDCG=${dh.ndcg_at_10} MRR=${dh.mrr_at_10}`,
    );
    console.error(
      `  bm25_only over recency:   R=${db1.recall_at_10} P=${db1.precision_at_10} nDCG=${db1.ndcg_at_10} MRR=${db1.mrr_at_10}`,
    );
    console.error(
      `  recency   over random:    R=${dr.recall_at_10} P=${dr.precision_at_10} nDCG=${dr.ndcg_at_10} MRR=${dr.mrr_at_10}`,
    );
    console.error('\n  Read: positive Δ on each row = that layer is doing work. ≈0 = layer is dead weight.');

    // Per-query bin summary — answers "is the aggregate 0 because all queries
    // are 0, or because gains and losses cancel?". If `lost` > 0 anywhere,
    // multipliers are at least directionally noisy on those queries.
    const hbBins = summarizePerQueryDelta(matrix.perQueryDeltas.hybrid_over_bm25);
    const brBins = summarizePerQueryDelta(matrix.perQueryDeltas.bm25_over_recency);
    console.error('\n─── Per-query Δ bins (n=' + matrix.queryCount + ', threshold=±0.001 nDCG) ───');
    console.error(
      `  hybrid    over bm25_only: gained=${hbBins.gained}  neutral=${hbBins.neutral}  lost=${hbBins.lost}`,
    );
    console.error(
      `  bm25_only over recency:   gained=${brBins.gained}  neutral=${brBins.neutral}  lost=${brBins.lost}`,
    );
    if (hbBins.gained === 0 && hbBins.lost === 0) {
      console.error(
        '  → multipliers (decay/project/importance/access) flat on EVERY query — strong dead-weight signal',
      );
    } else if (hbBins.lost > hbBins.gained) {
      console.error(
        `  → multipliers HURT more queries (${hbBins.lost}) than they helped (${hbBins.gained}) — directionally wrong`,
      );
    } else if (hbBins.gained > 0) {
      console.error(
        `  → multipliers help ${hbBins.gained} query/ies — top lift: "${matrix.perQueryDeltas.hybrid_over_bm25[0].query}" (Δ=${matrix.perQueryDeltas.hybrid_over_bm25[0].ndcg_delta})`,
      );
    }

    // Per-multiplier ablation summary — answers "which of the 4 multipliers
    // earn their keep on this fixture?". Read positive Δ as "dropping this
    // multiplier hurt", ≈0 as "this multiplier was idle, candidate to remove".
    if (ablations) {
      console.error('\n─── Per-multiplier ablation (Δ hybrid over single-multiplier-removed) ───');
      for (const ab of ABLATION_MODES) {
        const d = matrix.deltas[`hybrid_over_${ab}`];
        if (!d) continue;
        const dropped = ab.replace(/^no_/, '');
        console.error(
          `  drop ${dropped.padEnd(11)} → ΔR=${d.recall_at_10}  ΔP=${d.precision_at_10}  ΔnDCG=${d.ndcg_at_10}  ΔMRR=${d.mrr_at_10}`,
        );
      }
      console.error('  Read: large positive Δ = this multiplier earns its keep. ≈0 = drop candidate.');
    }

    db.close();
    return;
  }

  console.error('Running benchmark...');
  const results = runBenchmark(db, queryData.queries);

  // Output JSON to stdout
  console.log(JSON.stringify(results, null, 2));

  // Summary to stderr
  console.error('\n─── Benchmark Results ───');
  console.error(`  Recall@10:       ${results.metrics.recall_at_10}`);
  console.error(`  Precision@10:    ${results.metrics.precision_at_10}`);
  console.error(`  nDCG@10:         ${results.metrics.ndcg_at_10}`);
  console.error(`  MRR@10:          ${results.metrics.mrr_at_10}`);
  console.error(`  Avg tokens:      ${results.metrics.avg_tokens_injected}`);
  console.error(`  P95 latency:     ${results.metrics.p95_search_latency_ms}ms`);
  console.error('  (run with --matrix for hybrid vs bm25_only / recency / random comparison)');

  // Per-category breakdown
  if (Object.keys(results.byCategory).length > 1) {
    console.error('\n─── By Category ───');
    for (const [cat, m] of Object.entries(results.byCategory)) {
      console.error(
        `  ${cat} (${m.count}q): R@10=${m.recall_at_10} P@10=${m.precision_at_10} nDCG=${m.ndcg_at_10} MRR=${m.mrr_at_10}`,
      );
    }
  }

  // Queries with zero recall
  const zeroRecall = results.perQuery.filter((q) => q.recall_at_10 === 0);
  if (zeroRecall.length > 0) {
    console.error(`\n  ⚠ ${zeroRecall.length} queries with zero recall:`);
    for (const q of zeroRecall) {
      console.error(
        `    - ${q.id}: "${q.query}" (expected: [${q.relevant_ids.join(',')}], got: [${q.result_ids.join(',')}])`,
      );
    }
  }

  db.close();
}

// Run if executed directly
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url).includes(process.argv[1].replace(/\.mjs$/, ''));
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
