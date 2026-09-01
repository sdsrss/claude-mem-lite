#!/usr/bin/env node
// Benchmark CI gate — runs benchmark and fails if metrics regress below baseline thresholds.
// Usage: node benchmark/ci-gate.mjs [--tolerance 0.05] [--strict]
//
// The absolute-metric check runs the PRODUCTION-HYBRID path
// (searchObservationsHybrid: FTS + TF-IDF vector + RRF) — the path real users
// hit via mem_search/recall — NOT the lexical FTS-only `searchObservations`.
// Gating the lexical path left months of vector-arm drift invisible while
// guarding a path nobody uses. baseline.json must therefore be captured from the
// SAME path: `node benchmark/benchmark.mjs --production-hybrid > benchmark/baseline.json`.
//
// Strict mode (--strict flag or CI_GATE_STRICT=1): a stale baseline FAILS the
// gate instead of merely warning. Use it in release/CI contexts where a stale
// baseline means the comparison is untrustworthy. Default (local runs) keeps the
// advisory-only behaviour for fast iteration.
//
// Exit codes: 0 = pass, 1 = regression detected (or stale baseline in strict mode)

import { readFileSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Reject unknown flags instead of ignoring them. A gate that silently accepts `-strict`
// or `--Strict` and runs in advisory mode is a gate that a one-character typo in a workflow
// turns off while CI still shows green — and the whole point of --strict is that a release
// must not pass on evidence the gate has judged unreliable. Measured before this guard:
// `--strict` exit 1, `-strict` exit 0, `--Strict` exit 0, all against the same stale
// baseline. Positional arguments are left alone (--tolerance/--baseline take values).
const KNOWN_FLAGS = new Set(['--strict', '--skip-matrix', '--tolerance', '--baseline']);
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('-')) continue;                       // a flag's value, or a stray positional
  if (KNOWN_FLAGS.has(a)) { if (a === '--tolerance' || a === '--baseline') i++; continue; }
  console.error(`Unknown option "${a}". Known: ${[...KNOWN_FLAGS].join(' ')}.\n`
    + '  Refusing to run: an unrecognised flag here reads as "the mode you asked for is off".');
  process.exit(1);
}

// Parse tolerance from CLI args (default: 5% relative regression allowed)
const toleranceIdx = process.argv.indexOf('--tolerance');
const tolerance = toleranceIdx !== -1 ? parseFloat(process.argv[toleranceIdx + 1]) : 0.05;

// Strict mode: a stale baseline becomes a hard failure instead of an advisory
// warning. Opt-in via --strict flag or CI_GATE_STRICT=1 so normal local runs are
// unaffected (backward-compatible). Honour the common truthy spellings.
const STRICT = process.argv.includes('--strict') ||
  /^(1|true|yes|on)$/i.test(String(process.env.CI_GATE_STRICT ?? '').trim());

// v2.41: stale baseline threshold. Baseline is load-bearing evidence; if it
// predates significant code changes, the comparison is misleading. 30 days —
// matches compress age_days and roughly one release cycle.
//
// v3.85.1: this is a HARD FAILURE in every shipped invocation. Both `publish.yml`
// and `ci.yml` (on push; PRs stay advisory so an outside contributor is never
// blocked by the calendar) pass `--strict`. Advisory-only is now the LOCAL mode:
// a plain `node benchmark/ci-gate.mjs` still warns and continues. The comment
// here used to say "does NOT fail the gate", which was true when written and
// became false the moment the workflows started passing --strict.
// Recapture: `node benchmark/benchmark.mjs --production-hybrid > benchmark/baseline.json`.
const BASELINE_STALE_AGE_DAYS = 30;
const DAY_MS = 86400000;

// Load baseline. The path is overridable (--baseline <file> / CI_GATE_BASELINE) so
// the stale-detection branches can be exercised against a fixture with a known
// timestamp. Without it, any test of the freshness logic has to lean on the
// committed baseline's real age — which decays into a red suite on a calendar
// rather than on a regression.
const baselineIdx = process.argv.indexOf('--baseline');
const baselineOverride = baselineIdx !== -1 ? process.argv[baselineIdx + 1] : process.env.CI_GATE_BASELINE;
const baselinePath = baselineOverride ? resolve(baselineOverride) : join(__dirname, 'baseline.json');
let baseline;
let baselineAgeDays = 0;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  // Prefer the timestamp recorded inside the baseline file; fall back to mtime.
  const baselineMs = baseline?.timestamp ? Date.parse(baseline.timestamp) : NaN;
  const refMs = Number.isFinite(baselineMs) ? baselineMs : statSync(baselinePath).mtimeMs;
  baselineAgeDays = Math.floor((Date.now() - refMs) / DAY_MS);
} catch {
  console.error('No baseline.json found — run benchmark first to create one.');
  process.exit(1);
}

// Stale-baseline handling. Default: advisory warning, gate continues. Strict
// (--strict / CI_GATE_STRICT=1): hard failure — recorded here and enforced in the
// final exit decision (after the run, so the metric/matrix report still prints).
let staleFailure = false;
if (baselineAgeDays >= BASELINE_STALE_AGE_DAYS) {
  if (STRICT) {
    staleFailure = true;
    console.error(
      `\n  ✗ STALE BASELINE (${baselineAgeDays}d old, threshold ${BASELINE_STALE_AGE_DAYS}d) — FAILING (strict mode).\n` +
      `    Recapture: node benchmark/benchmark.mjs --production-hybrid > benchmark/baseline.json`
    );
  } else {
    console.warn(
      `\n  ⚠ STALE BASELINE (${baselineAgeDays}d old, threshold ${BASELINE_STALE_AGE_DAYS}d).\n` +
      `    Recapture: node benchmark/benchmark.mjs --production-hybrid > benchmark/baseline.json\n` +
      `    Gate continues to run — this is advisory, not a failure (pass --strict to fail).`
    );
  }
}

// Run benchmark on the PRODUCTION-HYBRID path (the path users actually hit), JSON
// on stdout, logs on stderr. baseline.json is captured from this same path so
// baseline and gate measure the same thing.
let results;
try {
  const stdout = execSync('node benchmark/benchmark.mjs --production-hybrid', {
    cwd: join(__dirname, '..'),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  results = JSON.parse(stdout);
} catch (err) {
  console.error('Benchmark execution failed:', err.message);
  process.exit(1);
}

// Compare key metrics
const checks = [
  { name: 'Recall@10', key: 'recall_at_10' },
  { name: 'Precision@10', key: 'precision_at_10' },
  { name: 'nDCG@10', key: 'ndcg_at_10' },
  { name: 'MRR@10', key: 'mrr_at_10' },
];

const failures = [];
const passes = [];

for (const { name, key } of checks) {
  const base = baseline.metrics[key];
  const curr = results.metrics[key];
  const threshold = Math.max(0, base - tolerance);
  const diff = curr - base;
  const diffStr = diff >= 0 ? `+${diff.toFixed(4)}` : diff.toFixed(4);

  if (curr < threshold) {
    failures.push({ name, base, curr, threshold, diffStr });
  } else {
    passes.push({ name, base, curr, diffStr });
  }
}

// Latency check (allow 20x regression — CI runners have high variance vs local SSD)
const baseLat = baseline.metrics.p95_search_latency_ms;
const currLat = results.metrics.p95_search_latency_ms;
if (currLat > baseLat * 20) {
  failures.push({ name: 'P95 Latency', base: baseLat, curr: currLat, threshold: baseLat * 20, diffStr: `+${(currLat - baseLat).toFixed(4)}ms` });
} else {
  passes.push({ name: 'P95 Latency', base: baseLat, curr: currLat, diffStr: `${(currLat - baseLat).toFixed(4)}ms` });
}

// Report
console.log('\n── Benchmark CI Gate ──');
console.log(`Tolerance: ${(tolerance * 100).toFixed(1)}% | Baseline: ${baseline.timestamp}\n`);

for (const p of passes) {
  console.log(`  PASS  ${p.name}: ${p.curr} (baseline ${p.base}, ${p.diffStr})`);
}
for (const f of failures) {
  console.log(`  FAIL  ${f.name}: ${f.curr} < ${f.threshold} (baseline ${f.base}, ${f.diffStr})`);
}

// ── Matrix delta regression checks ─────────────────────────────────────────
// Beyond aggregate metric drift, gate the *layer-by-layer* lift the production
// scoring system claims to provide. The matrix exposes `bm25_over_recency`
// (FTS5 contribution) and `hybrid_over_bm25` (multiplier contribution) deltas.
// Without this section, a future change could silently turn FTS into a no-op
// (e.g. break OBS_BM25 weights to all 1s) while the aggregate Recall@10 stays
// roughly flat because `recency` accidentally surfaces similar IDs.
//
// Why the asymmetric thresholds:
//   - `bm25_over_recency` MUST stay positive — if FTS retrieval doesn't beat
//     "newest first", the whole scoring stack is broken. Hard floor.
//   - `hybrid_over_bm25` may be 0 on the canonical corpus (it currently is,
//     per 2026-05-09 audit — only 1/30 queries gain). We don't gate on it
//     being positive; we only gate on it not REGRESSING materially negative,
//     which would mean multipliers actively hurt.
//
// `--skip-matrix` env var skips this block (e.g. for quick iteration).
const SKIP_MATRIX = process.argv.includes('--skip-matrix') || process.env.SKIP_MATRIX === '1';
let matrixFailures = [];
let matrixPasses = [];

if (!SKIP_MATRIX) {
  let matrix;
  try {
    const stdout = execSync('node benchmark/benchmark.mjs --matrix', {
      cwd: join(__dirname, '..'),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    matrix = JSON.parse(stdout);
  } catch (err) {
    console.error('Matrix benchmark execution failed:', err.message);
    process.exit(1);
  }

  const matrixChecks = [
    {
      name: 'bm25_over_recency.recall',
      value: matrix.deltas.bm25_over_recency.recall_at_10,
      floor: 0.3,
      direction: 'positive',
      rationale: 'FTS5 must beat recency-only by ≥0.3 R@10 — anything less means BM25 weighting is broken',
    },
    {
      name: 'bm25_over_recency.ndcg',
      value: matrix.deltas.bm25_over_recency.ndcg_at_10,
      floor: 0.3,
      direction: 'positive',
      rationale: 'FTS5 nDCG lift over recency-only',
    },
    {
      name: 'hybrid_over_bm25.recall',
      value: matrix.deltas.hybrid_over_bm25.recall_at_10,
      floor: -0.05,
      direction: 'positive',
      rationale: 'Multipliers may add 0 lift but must not actively hurt by >0.05 R@10',
    },
    {
      name: 'hybrid_over_bm25.ndcg',
      value: matrix.deltas.hybrid_over_bm25.ndcg_at_10,
      floor: -0.05,
      direction: 'positive',
      rationale: 'Multipliers nDCG floor (currently ~0; allow modest negative drift)',
    },
  ];

  for (const c of matrixChecks) {
    if (c.value < c.floor) {
      matrixFailures.push(c);
    } else {
      matrixPasses.push(c);
    }
  }

  console.log('\n── Matrix Δ Gate ──');
  for (const p of matrixPasses) {
    console.log(`  PASS  ${p.name}: Δ=${p.value} (floor ${p.floor})`);
  }
  for (const f of matrixFailures) {
    console.log(`  FAIL  ${f.name}: Δ=${f.value} < ${f.floor}`);
    console.log(`        ${f.rationale}`);
  }
}

const totalFailures = failures.length + matrixFailures.length;
if (totalFailures > 0 || staleFailure) {
  if (totalFailures > 0) console.log(`\n  ${totalFailures} metric(s) regressed beyond tolerance.`);
  if (staleFailure) console.log('  Baseline is stale and --strict was set — failing.');
  process.exit(1);
} else {
  console.log('\n  All metrics + matrix deltas within tolerance.');
  process.exit(0);
}
