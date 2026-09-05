#!/usr/bin/env node
// Denoising A/B tradeoff harness.
//
// WHY THIS EXISTS — denoising levers (synonym gates, OR-fallback floors, signal
// gates, coverage thresholds) shift PRECISION and RECALL in OPPOSITE directions,
// and on DIFFERENT query populations:
//   • precision_hard_negatives (test-queries.json)        — precision-stressed
//   • vocab_mismatch_paraphrase (test-queries-vocab-mismatch.json) — recall-stressed
// The standing benchmark + ci-gate run only the first suite; the paraphrase suite
// lives in a separate recall-band test. So a lever that "improves precision" on
// suite 1 while cratering recall on suite 2 looks like a clean win on one screen
// and a mysterious regression on another. That split is how an OR-BM25 floor got
// shipped-then-reverted (2026-06-29): the precision upside and the recall downside
// were never weighed on the same screen.
//
// This harness runs BOTH suites on the production-hybrid path and reports one
// precision↔recall snapshot, A/B-comparable across a change. Workflow to evaluate
// a SEARCH-PATH denoising change (env-gated OR raw code edit) BEFORE shipping it
// (see SCOPE below — UserPromptSubmit/PreToolUse injection levers are NOT covered):
//
//   node benchmark/denoise-ab.mjs --save /tmp/before.json   # control (change off)
//   …apply the denoising change (flip a default-off flag, or edit code)…
//   node benchmark/denoise-ab.mjs --compare /tmp/before.json # treatment → verdict
//
// The verdict makes the tradeoff falsifiable: REJECT (recall regression, no gain),
// TRADEOFF (precision up / recall down — a human judges worth), NET-POSITIVE, or
// NEUTRAL. Dev tooling only — not shipped in SOURCE_FILES, no release impact.
//
// SCOPE — what runSnapshot actually exercises: searchProductionHybrid →
// searchObservationsHybrid (search-engine.mjs), i.e. the CLI/MCP SEARCH path. That
// covers query-construction + ranking levers: sanitizeFtsQuery synonym expansion,
// the AND→OR relaxation, and FULL_SCORE's decay/type/importance multipliers. It does
// NOT execute the UserPromptSubmit hook (scripts/user-prompt-search.js) or PreToolUse
// recall (scripts/pre-tool-recall.js). The INJECTION-decision levers that live only
// there — TOP_REL_FLOOR, OR_TOP_BM25_FLOOR, REQUIRE_EXPLICIT_SIGNAL, and the
// cite_factor multiplier (scoring-sql.mjs::citeFactorClause, absent from
// search-engine.mjs) — are therefore INVISIBLE to this harness: editing one and
// re-running reports NEUTRAL (all Δ=0) no matter its true effect (verified 2026-06-29
// by flipping the OR_TOP_BM25_FLOOR row-selection — zero metric movement). Evaluate
// those on the UPS/PTR path directly; cite_factor additionally needs a corpus with
// real citation history (cited_count / uncited_streak), which the fixtures lack.
// The events/cross-source MERGE face is likewise outside the metric suites, but as
// of G16 it is DIRECTION-covered by behavioral probes (events-pipeline-probes.mjs
// drives the real coreRunSearchPipeline; cross-source-probes.mjs the banding math) —
// a break there reads PROBE-FAIL, not NEUTRAL. Ranking-quality DELTAS on events
// remain unscored (no events metric suite).

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestDb } from '../tests/test-helpers.mjs';
import { seedDatabase, seedVectors, runBenchmark } from './benchmark.mjs';
import { runScriptGuard, MULTISCRIPT_FIXTURES } from './multiscript-guard.mjs';
import { runCrossSourceProbes } from './cross-source-probes.mjs';
import { runDeferredProbes } from './deferred-probes.mjs';
import { runEventsPipelineProbes } from './events-pipeline-probes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

// The two query populations a denoising lever pulls in opposite directions,
// plus the CJK/mixed-script face the ASCII suites were structurally blind to
// (G5, roadmap 2026-07-18 — "A/B NEUTRAL ≠ safe" bit twice on this face).
export const SUITES = [
  { name: 'precision_hard_negatives', file: 'test-queries.json' },
  { name: 'vocab_mismatch_paraphrase', file: 'test-queries-vocab-mismatch.json' },
  { name: 'cjk_mixed', file: 'test-queries-cjk.json' },
];

/**
 * Seed every corpus the suites score against (main ASCII + CJK) into one DB,
 * then build vectors over the union. Single entry point for main() and tests —
 * a suite whose corpus is missing scores 0 recall and reads as a regression.
 *
 * ONE-TIME BASELINE STEP (v3.51.0): the CJK docs legitimately share vocabulary
 * with ASCII queries (kafka/docker/redis), so union seeding shifts the ASCII
 * precision-suite absolutes (measured: P@10 0.860→0.828, MRR 0.961→0.922;
 * vocab-mismatch R@10 unchanged at 0.341). Within-version before/after deltas
 * are unaffected — control and treatment score the same corpus. Snapshots saved
 * BEFORE v3.51.0 are stale: re-save the control after upgrading, do not read
 * the corpus step as a lever regression.
 *
 * SECOND BASELINE STEP (G15): six ENGLISH-only docs (90211-90216) joined the CJK
 * corpus for the cjk_xlang face (Chinese query → English doc via the synonym
 * bridge; suite n 12→15). Measured shift vs the pre-G15 control: all |Δ| < 0.02
 * (largest: precision MRR −0.017 — corpus-IDF noise below 1/n resolution).
 * Teeth: reverting the synonyms.mjs bridge drops cjk_xlang R@10 1.0 → 0.333,
 * so a future bridge regression reads as a suite REJECT, not NEUTRAL.
 */
export function seedAllFixtures(db) {
  for (const f of ['seed-data.json', 'seed-data-cjk.json']) {
    seedDatabase(db, JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')));
  }
  seedVectors(db);
}

/**
 * Fold behavioral-probe failures into the tradeoff verdict. The metric suites
 * can read NEUTRAL while an entire face (a script, a source, the deferred
 * trailer) silently breaks — a probe failure must therefore override NEUTRAL
 * on the same screen.
 * @param {string} verdict summarizeTradeoff verdict
 * @param {string[]} failures probe failure labels (empty → verdict unchanged)
 */
export function composeVerdict(verdict, failures) {
  if (!failures || failures.length === 0) return verdict;
  return `PROBE-FAIL(${failures.length}) — ${failures.join(', ')} | metric verdict: ${verdict}`;
}

const METRICS = ['recall_at_10', 'precision_at_10', 'ndcg_at_10', 'mrr_at_10'];

function loadQueries(file) {
  const j = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
  return Array.isArray(j) ? j : j.queries;
}

function round(n) {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Run both suites on the given DB and capture the four ranking metrics (+ per
 * category breakdown) for each. The caller seeds the DB first so the same corpus
 * is reused across control/treatment runs.
 * @returns {Object} { [suiteName]: {recall_at_10, precision_at_10, ndcg_at_10, mrr_at_10, byCategory} }
 */
export function runSnapshot(db, { mode = 'production_hybrid' } = {}) {
  const out = {};
  for (const s of SUITES) {
    const queries = loadQueries(s.file);
    const r = runBenchmark(db, queries, mode);
    out[s.name] = {
      recall_at_10: r.metrics.recall_at_10,
      precision_at_10: r.metrics.precision_at_10,
      ndcg_at_10: r.metrics.ndcg_at_10,
      mrr_at_10: r.metrics.mrr_at_10,
      // Query count so summarizeTradeoff can disclose the single-query resolution
      // (1/n) — a mean-of-per-query metric cannot resolve a move smaller than that.
      n: queries.length,
      byCategory: r.byCategory,
    };
  }
  return out;
}

/**
 * Compare two snapshots and classify the precision↔recall tradeoff. Pure — no DB.
 * A metric move ≥ +threshold is a gain; ≤ −threshold is a regression. The verdict
 * separates the case that bit us (recall regression with NO compensating gain →
 * REJECT) from a genuine precision/recall TRADEOFF a human must judge.
 * @returns {{suites:Array, gains:string[], regressions:string[], verdict:string}}
 */
export function summarizeTradeoff(before, after, { threshold = 0.02 } = {}) {
  const suites = [];
  const gains = [];
  const regressions = [];
  const underResolved = [];
  for (const name of Object.keys(after)) {
    if (!before[name]) continue;
    const deltas = { name };
    for (const m of METRICS) {
      const d = round((after[name][m] ?? 0) - (before[name][m] ?? 0));
      deltas[m] = d;
      if (d >= threshold) gains.push(`${name}.${m} +${d}`);
      else if (d <= -threshold) regressions.push(`${name}.${m} ${d}`);
    }
    // Single-query resolution: the mean-of-per-query metrics can only resolve a
    // move of at least 1/n. If that floor is ABOVE the verdict threshold, a
    // sub-threshold Δ is unresolvable noise — "NEUTRAL" there means "too few
    // queries to tell", NOT "safe" (the "A/B NEUTRAL ≠ safe" trap).
    const n = after[name].n ?? before[name].n ?? null;
    const resolution = n ? round(1 / n) : null;
    deltas.n = n;
    deltas.resolution = resolution;
    if (resolution !== null && resolution > threshold) underResolved.push(name);
    suites.push(deltas);
  }
  let verdict;
  if (regressions.length && !gains.length) {
    verdict = `REJECT — regression(s) with no compensating gain: ${regressions.join('; ')}`;
  } else if (regressions.length && gains.length) {
    verdict = `TRADEOFF (judge worth) — gains: ${gains.join('; ')} | regressions: ${regressions.join('; ')}`;
  } else if (gains.length) {
    verdict = `NET-POSITIVE — ${gains.join('; ')}`;
  } else {
    verdict = `NEUTRAL — all |Δ| < ${threshold}`;
  }
  if (underResolved.length) {
    const detail = underResolved
      .map((nm) => `${nm} 1/n=${suites.find((s) => s.name === nm).resolution}`)
      .join('; ');
    verdict += ` [under-resolved: ${detail} > threshold ${threshold} — a sub-1/n Δ is unresolvable; NEUTRAL≠safe, pair with a behavioral probe]`;
  }
  return { suites, gains, regressions, underResolved, verdict };
}

function fmtSnapshot(snap) {
  const lines = [];
  for (const s of SUITES) {
    const m = snap[s.name];
    if (!m) continue;
    lines.push(
      `  ${s.name.padEnd(28)} R@10=${m.recall_at_10.toFixed(3)}  P@10=${m.precision_at_10.toFixed(3)}  nDCG=${m.ndcg_at_10.toFixed(3)}  MRR=${m.mrr_at_10.toFixed(3)}`,
    );
  }
  return lines.join('\n');
}

function fmtDelta(d) {
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(3)}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : null;
  };
  const savePath = get('--save');
  const comparePath = get('--compare');
  const mode = get('--mode') || 'production_hybrid';

  const db = createTestDb();
  seedAllFixtures(db);
  const snap = runSnapshot(db, { mode });

  // Behavioral probes on the SAME screen (G5): faces the ranking-delta suites
  // cannot see. Multi-script guard — a char-class/tokenizer change that zeroes an
  // entire script produces no candidates, hence no ranking delta. Cross-source
  // probes — the single-hit clamp/band and 0-score invariants live in the
  // cross-source merge the obs-only suites never execute. Deferred probes — the
  // search-trailer leg (v3.50.0) is likewise outside the metric path.
  seedDatabase(db, { observations: MULTISCRIPT_FIXTURES.corpus });
  const guard = runScriptGuard(db);
  const crossProbes = runCrossSourceProbes();
  const deferredProbes = runDeferredProbes(db);
  db.close();
  // G16: events end-to-end probes drive the REAL coreRunSearchPipeline (FTS
  // query construction → shapeEvent → cross-source merge) over their own seeded
  // corpus — the face the obs-only suites AND the isolated cross-source probes
  // both miss (07-17 audit MED-2, second half).
  const eventsProbes = await runEventsPipelineProbes();

  const probeFailures = [
    ...guard.filter((g) => !g.found).map((g) => `multiscript:${g.script}`),
    ...crossProbes.filter((p) => !p.pass).map((p) => `cross-source:${p.name}`),
    ...deferredProbes.filter((p) => !p.pass).map((p) => `deferred:${p.kind}:"${p.query}"`),
    ...eventsProbes.filter((p) => !p.pass).map((p) => `events:${p.name}`),
  ];

  console.error(`\n─── Denoise A/B snapshot (${mode}, ${SUITES.length} suites) ───`);
  console.error(fmtSnapshot(snap));

  console.error('\n─── Behavioral probes (multiscript / cross-source / deferred / events) ───');
  console.error(`  ${guard.map((g) => `${g.script}${g.found ? '✓' : '✗ZERO'}`).join('  ')}`);
  console.error(
    `  cross-source: ${crossProbes.filter((p) => p.pass).length}/${crossProbes.length} ✓   deferred: ${deferredProbes.filter((p) => p.pass).length}/${deferredProbes.length} ✓   events-pipeline: ${eventsProbes.filter((p) => p.pass).length}/${eventsProbes.length} ✓`,
  );
  if (probeFailures.length) {
    console.error(
      `  ⚠ PROBE-FAIL — ${probeFailures.join(', ')} — a face regression the ranking suites cannot see.`,
    );
    process.exitCode = 1;
  }

  if (comparePath) {
    const before = JSON.parse(readFileSync(comparePath, 'utf8'));
    const { suites, verdict } = summarizeTradeoff(before, snap);
    console.error(`\n─── Δ vs ${comparePath} ───`);
    for (const d of suites) {
      console.error(
        `  ${d.name.padEnd(28)} ΔR@10=${fmtDelta(d.recall_at_10)}  ΔP@10=${fmtDelta(d.precision_at_10)}  ΔnDCG=${fmtDelta(d.ndcg_at_10)}  ΔMRR=${fmtDelta(d.mrr_at_10)}`,
      );
    }
    console.error(`\n  VERDICT: ${composeVerdict(verdict, probeFailures)}\n`);
  }

  if (savePath) {
    writeFileSync(savePath, JSON.stringify(snap, null, 2));
    console.error(`\nSaved snapshot → ${savePath}\n`);
  }

  // JSON on stdout for scripting (logs go to stderr above).
  console.log(JSON.stringify(snap));
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url).includes(process.argv[1].replace(/\.mjs$/, ''));
if (isMain) main();
