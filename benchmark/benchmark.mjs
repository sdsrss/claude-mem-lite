#!/usr/bin/env node
// Benchmark runner for claude-mem-lite search quality
// Uses the exact same BM25 scoring formula from server.mjs

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { sanitizeFtsQuery, estimateTokens } from '../utils.mjs';
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
      const epoch = now + (obs.epoch_offset_days * 86400000);
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
      const epoch = now + (obs.epoch_offset_days * 86400000);
      insertObs.run(
        obs.id, obs.session_id, obs.project, obs.text, obs.type,
        obs.title, obs.narrative, obs.facts, obs.concepts, obs.files_modified,
        new Date(epoch).toISOString(), epoch, obs.importance
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
        const epoch = now + (sess.epoch_offset_days * 86400000);
        // Ensure the session exists
        if (!sessionIds.has(sess.session_id)) {
          sessionIds.add(sess.session_id);
          insertSession.run(sess.session_id, sess.session_id, sess.project, new Date(epoch).toISOString(), epoch);
        }
        insertSummary.run(
          sess.id, sess.session_id, sess.project, sess.request,
          sess.investigated, sess.learned, sess.completed, sess.next_steps,
          new Date(epoch).toISOString(), epoch
        );
      }
    });
    sessTransaction();
  }

  return { observations: data.observations.length, sessions: (data.sessions || []).length };
}

// ─── Search (mirrors server.mjs BM25 query exactly) ────────────────────────

function searchObservations(db, query, options = {}) {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  const now = Date.now();
  const limit = options.limit ?? 20;
  const project = options.project ?? null;
  const obsType = options.type ?? null;

  const rows = db.prepare(`
    SELECT o.id, o.type, o.title, o.subtitle, o.project, o.created_at, o.importance,
           o.files_modified, o.narrative, o.text,
           bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)
             * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
             * (CASE WHEN ? IS NOT NULL AND o.project = ? THEN 2.0 ELSE 1.0 END)
             * (0.5 + 0.5 * COALESCE(o.importance, 1))
             * (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0))) as score
    FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE observations_fts MATCH ?
      AND COALESCE(o.compressed_into, 0) = 0
      AND (? IS NULL OR o.project = ?)
      AND (? IS NULL OR o.type = ?)
    ORDER BY score
    LIMIT ?
  `).all(
    now,
    project, project,
    ftsQuery,
    project, project,
    obsType, obsType,
    limit
  );

  return rows.map(r => ({
    id: r.id, type: r.type, title: r.title, project: r.project,
    score: r.score, importance: r.importance,
    tokens: estimateTokens((r.title || '') + ' ' + (r.narrative || ''))
  }));
}

// ─── Metrics ────────────────────────────────────────────────────────────────

export function computeRecallAtK(results, relevantIds, k = 10) {
  if (!relevantIds || relevantIds.length === 0) return 0;
  const topK = results.slice(0, k).map(r => r.id);
  const hits = topK.filter(id => relevantIds.includes(id)).length;
  return hits / relevantIds.length;
}

export function computePrecisionAtK(results, relevantIds, k = 10) {
  const topK = results.slice(0, k);
  if (topK.length === 0) return 0;
  const hits = topK.filter(r => relevantIds.includes(r.id)).length;
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

export function measureLatencyP95(db, queries) {
  const latencies = [];
  // Run each query 3 times to get stable measurements
  for (let run = 0; run < 3; run++) {
    for (const q of queries) {
      const start = performance.now();
      searchObservations(db, q.query, { project: q.project, type: q.type });
      const elapsed = performance.now() - start;
      latencies.push(elapsed);
    }
  }
  latencies.sort((a, b) => a - b);
  const p95Index = Math.floor(latencies.length * 0.95);
  return latencies[p95Index] || latencies[latencies.length - 1] || 0;
}

// ─── Run Benchmark ──────────────────────────────────────────────────────────

export function runBenchmark(db, queries) {
  const results = {
    timestamp: new Date().toISOString(),
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
      result_ids: searchResults.map(r => r.id),
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
  results.metrics.p95_search_latency_ms = round(measureLatencyP95(db, queries));

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

// ─── CLI Entry Point ────────────────────────────────────────────────────────

function main() {
  const seedPath = join(__dirname, 'fixtures', 'seed-data.json');
  const queriesPath = join(__dirname, 'fixtures', 'test-queries.json');

  const seedData = JSON.parse(readFileSync(seedPath, 'utf-8'));
  const queryData = JSON.parse(readFileSync(queriesPath, 'utf-8'));

  console.error('Creating benchmark database...');
  const db = createTestDb();

  console.error('Seeding database...');
  const counts = seedDatabase(db, seedData);
  console.error(`  Seeded ${counts.observations} observations, ${counts.sessions} sessions`);

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

  // Per-category breakdown
  if (Object.keys(results.byCategory).length > 1) {
    console.error('\n─── By Category ───');
    for (const [cat, m] of Object.entries(results.byCategory)) {
      console.error(`  ${cat} (${m.count}q): R@10=${m.recall_at_10} P@10=${m.precision_at_10} nDCG=${m.ndcg_at_10} MRR=${m.mrr_at_10}`);
    }
  }

  // Queries with zero recall
  const zeroRecall = results.perQuery.filter(q => q.recall_at_10 === 0);
  if (zeroRecall.length > 0) {
    console.error(`\n  ⚠ ${zeroRecall.length} queries with zero recall:`);
    for (const q of zeroRecall) {
      console.error(`    - ${q.id}: "${q.query}" (expected: [${q.relevant_ids.join(',')}], got: [${q.result_ids.join(',')}])`);
    }
  }

  db.close();
}

// Run if executed directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url).includes(process.argv[1].replace(/\.mjs$/, ''));
if (isMain) {
  main();
}
