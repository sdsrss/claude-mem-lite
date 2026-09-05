#!/usr/bin/env node
// LongMemEval benchmark adapter for claude-mem-lite.
//
// Measures our REAL production retrieval (FTS5/BM25 + TF-IDF + RRF, zero
// embeddings) against the LongMemEval long-term-memory benchmark, so we have a
// standardized recall number comparable to the field instead of only our local
// micro-benchmark. It reuses the existing benchmark seams (seedDatabase /
// seedVectors / searchProductionHybrid) — the only new thing here is the dataset
// adapter and the recall_any@k metric.
//
// HONEST FRAMING (read before quoting any number):
//   * We are a LEXICAL baseline. MemPalace's headline 96.6% R@5 is embedding
//     retrieval over verbatim text. On paraphrase-heavy categories
//     (single-session-preference, vocabulary-gap) cosine wins and pure lexical
//     overlap returns 0; synonym/CJK expansion only partially closes that. Report
//     per-type recall and DO NOT claim the embedding number.
//   * Corpus rule = USER TURNS ONLY by default, matching MemPalace's raw baseline
//     (their longmemeval_bench.py:188). A fact that lives only in an assistant
//     turn is intentionally NOT in the haystack. `--turns all` indexes both and is
//     NOT comparable to their raw number.
//   * Timestamps default to uniform (epoch_offset_days=0) so time-decay does not
//     skew retrieval — this isolates the pure retrieval signal. Pass --temporal
//     to date each session from its real haystack_dates relative to
//     question_date; the production type-decay multiplier then varies by age, so
//     the uniform-vs-temporal recall delta isolates decay's contribution.
//     CAVEAT: LongMemEval gold is NOT recency-correlated (the answer can sit in
//     any session), so a temporal delta measures decay against a recency-agnostic
//     relevance structure — it does NOT model real dev-memory, where recent work
//     is genuinely more relevant. A decay-hurts-recall result here is expected
//     benchmark mismatch, not evidence that decay is dead weight.
//   * Metric is recall_any@k ("is ANY gold session in top-k", binary, averaged) —
//     the LongMemEval headline metric, NOT benchmark.mjs's fractional
//     computeRecallAtK.
//
// Dataset is ~300 MB and NOT committed. Fetch it with
// `benchmark/datasets/download-longmemeval.sh`, then:
//   node benchmark/longmemeval.mjs benchmark/datasets/longmemeval_s_cleaned.json
//
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { pathToFileURL } from 'url';
import { createTestDb } from '../tests/test-helpers.mjs';
import { seedDatabase, seedVectors, searchProductionHybrid, computeNDCG, computeMRR } from './benchmark.mjs';

// ─── Corpus builder ──────────────────────────────────────────────────────────
//
// Each haystack session becomes ONE observation row. observations.id is an
// INTEGER primary key, but LongMemEval session ids are strings, so we key rows by
// an integer index and map back via idToSession. The session text lands in
// `narrative` + `text` (both FTS-indexed via OBS_FTS_COLUMNS) and `narrative`
// also feeds the TF-IDF vector arm, so both retrieval arms see the content.
// LongMemEval dates look like "2023/05/30 (Tue) 23:40". Strip the weekday paren
// so Date.parse accepts the "YYYY/MM/DD HH:MM" remainder. Returns epoch ms, or
// null on missing/unparseable input (caller falls back to offset 0). Timezone is
// irrelevant — only relative differences between session dates are used.
export function parseLmeDate(s) {
  if (!s || typeof s !== 'string') return null;
  const t = Date.parse(s.replace(/\s*\([A-Za-z]+\)\s*/, ' ').trim());
  return Number.isFinite(t) ? t : null;
}

export function buildCorpus(entry, { turns = 'user', temporal = false } = {}) {
  const sessions = entry.haystack_sessions || [];
  const sessionIds = entry.haystack_session_ids || [];
  const dates = entry.haystack_dates || [];
  // Temporal mode: date each session from its real haystack_dates relative to
  // question_date (the "now" the question is asked at), so created_at_epoch — and
  // therefore the production type-decay multiplier — varies by age instead of
  // being a constant 2.0. Sessions precede the question, so offsets are ≤0.
  // Uniform vs temporal differ ONLY in created_at_epoch, so any recall delta
  // isolates decay (type/project/importance are identical across both runs).
  const qNow = temporal ? parseLmeDate(entry.question_date) : null;
  const idToSession = new Map();
  const observations = [];

  for (let i = 0; i < sessions.length; i++) {
    const turnList = sessions[i] || [];
    const kept = turns === 'all' ? turnList : turnList.filter((t) => t.role === 'user');
    const docText = kept
      .map((t) => t.content)
      .join('\n')
      .trim();
    const intId = i + 1;
    const sid = sessionIds[i] ?? `idx-${i}`;
    idToSession.set(intId, sid);
    let offsetDays = 0;
    if (qNow !== null) {
      const d = parseLmeDate(dates[i]);
      if (d !== null) offsetDays = Math.min(0, (d - qNow) / 86400000);
    }
    observations.push({
      id: intId,
      session_id: `lme-${entry.question_id}`,
      project: 'lme',
      // observations.type has a CHECK constraint; all docs share one type so
      // TYPE_QUALITY is a constant multiplier with no within-corpus ranking
      // effect. With --temporal, the type-decay half-life (discovery=60d) is the
      // only metadata axis that varies, which is exactly what we want to isolate.
      type: 'discovery',
      title: docText.slice(0, 80),
      narrative: docText,
      text: docText,
      concepts: '',
      facts: '',
      files_modified: '[]',
      importance: 1,
      epoch_offset_days: offsetDays,
    });
  }

  return { data: { observations }, idToSession, goldIds: entry.answer_session_ids || [] };
}

// ─── Metric ──────────────────────────────────────────────────────────────────
//
// recall_any@k: 1 if at least one gold session id appears in the top-k retrieved
// ids, else 0. This is the LongMemEval headline definition (binary per question,
// averaged across questions). Differs from benchmark.mjs computeRecallAtK, which
// returns the FRACTION of gold ids retrieved — equal only when |gold| === 1.
export function recallAnyAtK(rankedIds, goldIds, k = 5) {
  if (!goldIds || goldIds.length === 0) return 0;
  const gold = new Set(goldIds);
  return rankedIds.slice(0, k).some((id) => gold.has(id)) ? 1 : 0;
}

// recall_frac@k (standard IR recall@k): the fraction of DISTINCT gold sessions that
// appear in the top-k retrieved ids, |gold ∩ top-k| / |gold|. Equals recallAnyAtK
// when |gold| === 1; on the multi-gold majority of LongMemEval-S (65% of questions)
// it is the STRICTER metric — any-hit needs just one gold session, this needs all of
// them for a perfect score. Reported alongside recall_any@k so the headline number
// can never be mistaken for the looser metric. Membership-tested against the gold set
// (not benchmark.mjs computeRecallAtK's positional count), so a gold id retrieved
// twice can never push the score above 1.
export function recallFractionalAtK(rankedIds, goldIds, k = 5) {
  if (!goldIds || goldIds.length === 0) return 0;
  const topK = new Set(rankedIds.slice(0, k));
  let hit = 0;
  for (const g of goldIds) if (topK.has(g)) hit++;
  return hit / goldIds.length;
}

// ─── Per-question evaluation ─────────────────────────────────────────────────
//
// Fresh in-memory DB per question (the haystack is question-scoped: ~53 sessions
// in the real set), seed both retrieval arms, run the production hybrid search,
// map result ids back to session ids, score recall_any@k.
export function evalEntry(entry, { turns = 'user', temporal = false, ks = [1, 5, 10], limit = 10 } = {}) {
  const { data, idToSession, goldIds } = buildCorpus(entry, { turns, temporal });
  const fetchN = Math.max(limit, ...ks);
  const db = createTestDb();
  let retrieved = [];
  try {
    seedDatabase(db, data);
    seedVectors(db); // build TF-IDF vocab + vectors so the RRF vector arm is live
    const rows = searchProductionHybrid(db, entry.question, { limit: fetchN, project: null });
    retrieved = rows.map((r) => idToSession.get(r.id)).filter(Boolean);
  } finally {
    db.close();
  }

  const ksOut = {};
  const ksFracOut = {};
  for (const k of ks) {
    ksOut[String(k)] = recallAnyAtK(retrieved, goldIds, k);
    ksFracOut[String(k)] = recallFractionalAtK(retrieved, goldIds, k);
  }
  const rankedObjs = retrieved.map((sid) => ({ id: sid }));
  return {
    question_id: entry.question_id,
    question_type: entry.question_type || 'unknown',
    ks: ksOut,
    ksFrac: ksFracOut,
    ndcg: computeNDCG(rankedObjs, goldIds, Math.max(...ks)),
    mrr: computeMRR(rankedObjs, goldIds),
    gold: goldIds,
    retrieved,
  };
}

// ─── Aggregation ─────────────────────────────────────────────────────────────
export function runLongMemEval(
  entries,
  { turns = 'user', temporal = false, ks = [1, 5, 10], limit = 10 } = {},
) {
  const perQuestion = entries.map((e) => evalEntry(e, { turns, temporal, ks, limit }));

  const meanRecall = (rows, field = 'ks') => {
    const out = {};
    for (const k of ks) {
      const key = String(k);
      out[key] = rows.length ? rows.reduce((s, r) => s + r[field][key], 0) / rows.length : 0;
    }
    return out;
  };
  const mean = (rows, sel) => (rows.length ? rows.reduce((s, r) => s + sel(r), 0) / rows.length : 0);

  const byType = {};
  for (const r of perQuestion) (byType[r.question_type] ||= []).push(r);
  const perType = {};
  for (const [t, rows] of Object.entries(byType)) {
    perType[t] = {
      n: rows.length,
      recallAny: meanRecall(rows),
      recallFrac: meanRecall(rows, 'ksFrac'),
      ndcg: mean(rows, (r) => r.ndcg),
      mrr: mean(rows, (r) => r.mrr),
    };
  }

  return {
    config: { turns, temporal, ks, limit },
    n: perQuestion.length,
    overall: {
      recallAny: meanRecall(perQuestion),
      recallFrac: meanRecall(perQuestion, 'ksFrac'),
      ndcg: mean(perQuestion, (r) => r.ndcg),
      mrr: mean(perQuestion, (r) => r.mrr),
    },
    perType,
    perQuestion,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
export function loadDataset(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(raw) ? raw : raw.questions || raw.data || [];
}

function parseArgs(args) {
  const opts = {
    turns: 'user',
    temporal: false,
    ks: [1, 5, 10],
    limit: 10,
    max: Infinity,
    out: null,
    dataset: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--turns') opts.turns = args[++i];
    else if (a === '--temporal') opts.temporal = true;
    else if (a === '--ks') opts.ks = args[++i].split(',').map(Number);
    else if (a === '--limit') opts.limit = Number(args[++i]);
    else if (a === '--max') opts.max = Number(args[++i]);
    else if (a === '--out') opts.out = args[++i];
    else if (!a.startsWith('--')) opts.dataset = a;
  }
  return opts;
}

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function main(argv) {
  const opts = parseArgs(argv.slice(2));
  if (!opts.dataset) {
    process.stderr.write(
      'Usage: node benchmark/longmemeval.mjs <dataset.json> [--turns user|all] [--temporal] [--ks 1,5,10] [--limit 10] [--max N] [--out results.jsonl]\n' +
        'Dataset is not committed (~300 MB). Fetch it first:\n' +
        '  bash benchmark/datasets/download-longmemeval.sh\n',
    );
    process.exit(1);
  }

  let entries = loadDataset(opts.dataset);
  if (Number.isFinite(opts.max)) entries = entries.slice(0, opts.max);
  process.stderr.write(
    `Running LongMemEval on ${entries.length} questions (turns=${opts.turns}${opts.temporal ? ', temporal' : ''}) …\n`,
  );

  const out = runLongMemEval(entries, {
    turns: opts.turns,
    temporal: opts.temporal,
    ks: opts.ks,
    limit: opts.limit,
  });

  const lines = [];
  lines.push(
    `\nLongMemEval — claude-mem-lite (lexical FTS5+TF-IDF+RRF, turns=${opts.turns}${opts.temporal ? ', temporal' : ''}, n=${out.n})`,
  );
  lines.push(
    `  recall_any@k:  ${opts.ks.map((k) => `@${k}=${fmtPct(out.overall.recallAny[String(k)])}`).join('  ')}   nDCG=${out.overall.ndcg.toFixed(3)}  MRR=${out.overall.mrr.toFixed(3)}`,
  );
  lines.push(
    `  recall_frac@k: ${opts.ks.map((k) => `@${k}=${fmtPct(out.overall.recallFrac[String(k)])}`).join('  ')}   (standard recall@k = |gold∩topk|/|gold|; stricter on the 65% multi-gold questions)`,
  );
  lines.push('  per question_type (any-hit / fractional):');
  for (const [t, s] of Object.entries(out.perType).sort()) {
    const any = opts.ks.map((k) => `@${k}=${fmtPct(s.recallAny[String(k)])}`).join(' ');
    const frac = opts.ks.map((k) => `@${k}=${fmtPct(s.recallFrac[String(k)])}`).join(' ');
    lines.push(`    ${t.padEnd(28)} n=${String(s.n).padStart(4)}  any[${any}]  frac[${frac}]`);
  }
  lines.push(
    '\n  NOTE: lexical baseline. recall_any@k is the LongMemEval headline (and what agentmemory / MemPalace report); recall_frac@k is the stricter standard recall@k. Neither is comparable to embedding R@5 on paraphrase categories. See file header.',
  );
  process.stdout.write(lines.join('\n') + '\n');

  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    const jsonl = out.perQuestion.map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(opts.out, jsonl + '\n');
    const summaryPath = opts.out.replace(/\.jsonl?$/, '') + '.summary.json';
    writeFileSync(
      summaryPath,
      JSON.stringify({ config: out.config, n: out.n, overall: out.overall, perType: out.perType }, null, 2),
    );
    process.stderr.write(`Wrote per-question results → ${opts.out}\n  summary → ${summaryPath}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
