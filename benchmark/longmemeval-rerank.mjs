#!/usr/bin/env node
// Phase 1 experiment: LLM rerank of top-K lexical candidates on LongMemEval.
//
// The diagnostic (benchmark/longmemeval.mjs --ks 1,5,10,20,50) showed our gap to
// embedding is a RANKING problem, not a recall problem: the gold session is in the
// top-50 candidate set ~98.6% of the time, but only 90.6% in the top-5
// (single-session-preference: 63.3%@5 vs 93.3%@50). An ORACLE reranker of the
// top-20 would therefore reach 97.8%@5 — above MemPalace's 96.6% embedding raw.
// This measures how much of that ceiling a real LLM reranker captures vs the
// lexical baseline, with the gold-in-top-K candidates ranked by an LLM reader.
//
// The LLM is injectable (deps.llm) so the harness logic is unit-tested with a
// deterministic stub; the default provider is the project's haiku-client
// (OpenRouter / Anthropic / CLI per detectMode). "Never worse than baseline" by
// construction: any LLM/parse failure falls back to the original candidate order.
import { writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { pathToFileURL } from 'url';
import { createTestDb } from '../tests/test-helpers.mjs';
import { seedDatabase, seedVectors, searchProductionHybrid } from './benchmark.mjs';
import { buildCorpus, recallAnyAtK, loadDataset } from './longmemeval.mjs';
// Rerank core is shared with the production deep-search rerank stage (rerank.mjs)
// so the lift measured here reflects the EXACT algorithm that ships.
import { llmRerankOrder, defaultRerankLLM as defaultLlm } from '../rerank.mjs';
// Re-export the pieces the harness's own tests import (tests/benchmark-longmemeval-rerank.test.mjs).
export { extractRanked, llmRerankOrder } from '../rerank.mjs';

export async function rerankEval(
  entry,
  { turns = 'user', topK = 20, ks = [1, 5, 10], llm = defaultLlm } = {},
) {
  const { data, idToSession, goldIds } = buildCorpus(entry, { turns });
  const idToText = new Map(data.observations.map((o) => [o.id, o.narrative]));
  const db = createTestDb();
  let baseRows;
  try {
    seedDatabase(db, data);
    seedVectors(db);
    baseRows = searchProductionHybrid(db, entry.question, { limit: Math.max(topK, ...ks), project: null });
  } finally {
    db.close();
  }
  const baseRanked = baseRows.map((r) => idToSession.get(r.id)).filter(Boolean);
  const cand = baseRows
    .slice(0, topK)
    .map((r) => ({ sid: idToSession.get(r.id), text: idToText.get(r.id) || '' }));
  const { order: rerankedTop, parsed } = await llmRerankOrder(entry.question, cand, llm);
  const finalRanked = [...rerankedTop, ...baseRanked.slice(topK)];
  const score = (ranked) => Object.fromEntries(ks.map((k) => [String(k), recallAnyAtK(ranked, goldIds, k)]));
  return {
    question_id: entry.question_id,
    question_type: entry.question_type || 'unknown',
    base: score(baseRanked),
    rerank: score(finalRanked),
    parsed,
    gold: goldIds,
  };
}

// Bounded-concurrency map (each task makes one ~slow LLM call).
async function pMap(items, fn, concurrency) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
      while (next < items.length) {
        const idx = next++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

export async function runRerankEval(
  entries,
  {
    turns = 'user',
    topK = 20,
    ks = [1, 5, 10],
    llm = defaultLlm,
    concurrency = 4,
    onProgress,
    onResult,
  } = {},
) {
  let done = 0;
  const per = await pMap(
    entries,
    async (e) => {
      const r = await rerankEval(e, { turns, topK, ks, llm });
      done += 1;
      if (onResult) onResult(r); // incremental: salvage partial results if the run is killed mid-way
      if (onProgress && (done % 50 === 0 || done === entries.length)) onProgress(done, entries.length);
      return r;
    },
    concurrency,
  );
  const mean = (rows, arm, k) =>
    rows.length ? rows.reduce((s, r) => s + r[arm][String(k)], 0) / rows.length : 0;
  const agg = (rows) => ({
    n: rows.length,
    base: Object.fromEntries(ks.map((k) => [String(k), mean(rows, 'base', k)])),
    rerank: Object.fromEntries(ks.map((k) => [String(k), mean(rows, 'rerank', k)])),
  });
  const byType = {};
  for (const r of per) (byType[r.question_type] ||= []).push(r);
  const perType = {};
  for (const [t, rows] of Object.entries(byType).sort()) perType[t] = agg(rows);
  const parseRate = per.length ? per.filter((r) => r.parsed).length / per.length : 0;
  return {
    config: { turns, topK, ks, concurrency },
    n: per.length,
    parseRate,
    overall: agg(per),
    perType,
    perQuestion: per,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(args) {
  const o = {
    turns: 'user',
    topK: 20,
    ks: [1, 5, 10],
    type: null,
    max: Infinity,
    concurrency: 4,
    out: null,
    dataset: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--turns') o.turns = args[++i];
    else if (a === '--topK') o.topK = Number(args[++i]);
    else if (a === '--ks') o.ks = args[++i].split(',').map(Number);
    else if (a === '--type') o.type = args[++i];
    else if (a === '--max') o.max = Number(args[++i]);
    else if (a === '--concurrency') o.concurrency = Number(args[++i]);
    else if (a === '--out') o.out = args[++i];
    else if (!a.startsWith('--')) o.dataset = a;
  }
  return o;
}
const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function main(argv) {
  const o = parseArgs(argv.slice(2));
  if (!o.dataset) {
    process.stderr.write(
      'Usage: node benchmark/longmemeval-rerank.mjs <dataset.json> [--type T] [--max N] [--topK 20] [--concurrency 4] [--out f.jsonl]\n',
    );
    process.exit(1);
  }
  let entries = loadDataset(o.dataset);
  if (o.type) entries = entries.filter((e) => e.question_type === o.type);
  if (Number.isFinite(o.max)) entries = entries.slice(0, o.max);
  process.stderr.write(
    `LLM rerank: ${entries.length} questions (type=${o.type || 'all'}, topK=${o.topK}, conc=${o.concurrency}) …\n`,
  );

  // Truncate the per-question file up front, then append each result as it lands
  // (incremental — a kill mid-run leaves the completed questions on disk to salvage).
  if (o.out) {
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(o.out, '');
  }
  const r = await runRerankEval(entries, {
    turns: o.turns,
    topK: o.topK,
    ks: o.ks,
    concurrency: o.concurrency,
    onProgress: (d, n) => process.stderr.write(`  ${d}/${n} done …\n`),
    onResult: o.out ? (rec) => appendFileSync(o.out, JSON.stringify(rec) + '\n') : undefined,
  });

  const out = [];
  out.push(
    `\nLongMemEval LLM-rerank (topK=${o.topK}, type=${o.type || 'all'}, n=${r.n}, JSON parse-rate=${pct(r.parseRate)})`,
  );
  const row = (label, s) =>
    `  ${label.padEnd(10)} ${o.ks.map((k) => `@${k}=${pct(s[String(k)])}`).join('  ')}`;
  out.push(row('baseline', r.overall.base));
  out.push(row('rerank', r.overall.rerank));
  out.push(`  Δ@5 = ${((r.overall.rerank['5'] - r.overall.base['5']) * 100).toFixed(1)} pts`);
  out.push('  per type (base → rerank @5):');
  for (const [t, s] of Object.entries(r.perType)) {
    out.push(`    ${t.padEnd(28)} n=${String(s.n).padStart(4)}  ${pct(s.base['5'])} → ${pct(s.rerank['5'])}`);
  }
  process.stdout.write(out.join('\n') + '\n');

  if (o.out) {
    // per-question jsonl already written incrementally via onResult; summary here.
    writeFileSync(
      o.out.replace(/\.jsonl?$/, '') + '.summary.json',
      JSON.stringify(
        { config: r.config, n: r.n, parseRate: r.parseRate, overall: r.overall, perType: r.perType },
        null,
        2,
      ),
    );
    process.stderr.write(`Wrote → ${o.out} (+ .summary.json)\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
