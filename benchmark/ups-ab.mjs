#!/usr/bin/env node
// UPS-path A/B harness for the identifier-exact-match floor-bypass.
//
// WHY THIS EXISTS — denoise-ab.mjs drives searchObservationsHybrid (the CLI/MCP
// SEARCH path) and CANNOT see UserPromptSubmit-hook levers (TOP_REL_FLOOR /
// OR_TOP_BM25_FLOOR / cite_factor / signal-gate) — a UPS-gate edit reads NEUTRAL there
// because the code never runs (see denoise-ab.mjs SCOPE note, verified 2026-06-29).
// This harness closes that gap: it drives the REAL scripts/user-prompt-search.js as a
// subprocess (exactly as the hook runs it) on a labeled query set, so a UPS-path lever
// is measured on the path it actually lives in.
//
// It runs BOTH arms in one invocation via the env flag — control = bypass OFF,
// treatment = bypass ON — so no save/compare round-trip is needed:
//
//   node benchmark/ups-ab.mjs                       # both arms + verdict
//   node benchmark/ups-ab.mjs --queries <file.json> # custom labeled set
//   node benchmark/ups-ab.mjs --json                # machine-readable
//
// Metrics (per arm):
//   positives      — recall: fraction of each query's expected obs that got injected,
//                    + hits: # of positives whose expected obs ALL surfaced.
//   hard_negatives — noise: TRUE off-topic FPs (#8858) — generic compound fields that
//                    collide across unrelated obs + signal-less prose (bypass must not fire).
//                    This is the precision cost the verdict reacts to.
//   topical_eager  — eager: on-identifier obs surfaced for a specific-identifier prompt that
//                    did NOT ask for recall. On-topic, not wrong; reported, NOT in the verdict
//                    (#8858: counting these as noise conflates eagerness with a true FP).
//
// Verdict (treatment vs control): NET-POSITIVE (recall up, precision flat) /
// TRADEOFF (both move) / REJECT (precision down, no recall gain) / NEUTRAL.
//
// Runs against the REAL DB (the labeled obs ids are live; see fixture _meta). Dev
// tooling only — not shipped in SOURCE_FILES, no release impact.

import { execFileSync } from 'child_process';
import { readFileSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { RUNTIME_DIR } from '../hook-shared.mjs';
import { inferProject } from '../utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'user-prompt-search.js');
const args = new Set(process.argv.slice(2));
const jsonOut = args.has('--json');

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const queryFile = argVal('--queries', join(__dirname, 'fixtures', 'ups-identifier-queries.json'));
const SUITE = JSON.parse(readFileSync(queryFile, 'utf8'));
const PROJECT = inferProject();
// D#120: the dedup marker is session-keyed (`.claude-mem-injected-<project>-<session>`),
// and this harness's synthetic session ids can collide across same-length prompts —
// clear every marker for the project so no run suppresses another.
const DEDUP_FILE_PREFIX = `.claude-mem-injected-${PROJECT}`;
function clearDedupFiles() {
  try {
    for (const name of readdirSync(RUNTIME_DIR)) {
      if (name.startsWith(DEDUP_FILE_PREFIX)) {
        try {
          rmSync(join(RUNTIME_DIR, name));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* runtime dir may not exist */
  }
}

// Inject ids the script surfaced for one prompt under one arm. Clears the per-project
// dedup cache first so back-to-back queries don't suppress each other (the cache
// regenerates on the next real hook fire — harmless to clear). Parses obs lines
// (^#NNN); ignores P#/S# (prompt/session) and all other output.
function injectedFor(prompt, bypass) {
  clearDedupFiles();
  let out = '';
  try {
    out = execFileSync('node', [SCRIPT], {
      input: JSON.stringify({ prompt, session_id: `ups-ab-${bypass}-${prompt.length}`, cwd: ROOT }),
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, CLAUDE_MEM_UPS_IDENTIFIER_BYPASS: bypass ? '1' : '0' },
    });
  } catch (e) {
    out = e.stdout || '';
  }
  const ids = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^#(\d+)\b/);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
}

function runArm(bypass) {
  const positives = SUITE.positives.map((q) => {
    const injected = injectedFor(q.query, bypass);
    const hit = q.expected_ids.every((id) => injected.includes(id));
    const recall = q.expected_ids.length
      ? q.expected_ids.filter((id) => injected.includes(id)).length / q.expected_ids.length
      : 1;
    return { query: q.query, expected: q.expected_ids, injected, hit, recall };
  });
  const negatives = SUITE.hard_negatives.map((q) => {
    const injected = injectedFor(q.query, bypass);
    const noise = injected.filter((id) => !q.expected_ids.includes(id));
    return { query: q.query, expected: q.expected_ids, injected, noise: noise.length };
  });
  // topical_eager: prompts naming a SPECIFIC identifier whose match is on-topic-but-unrequested
  // (#8858). Measured for visibility but NEVER folded into the verdict's precision cost — it is
  // eagerness, not a true off-topic false-positive.
  const topical = (SUITE.topical_eager || []).map((q) => {
    const injected = injectedFor(q.query, bypass);
    const eager = injected.filter((id) => !q.expected_ids.includes(id));
    return { query: q.query, expected: q.expected_ids, injected, eager: eager.length };
  });
  const pos_hits = positives.filter((p) => p.hit).length;
  const pos_recall = positives.reduce((s, p) => s + p.recall, 0) / (positives.length || 1);
  const neg_noise = negatives.reduce((s, n) => s + n.noise, 0);
  const neg_dirty = negatives.filter((n) => n.noise > 0).length;
  const eager_inj = topical.reduce((s, t) => s + t.eager, 0);
  const eager_dirty = topical.filter((t) => t.eager > 0).length;
  return {
    positives,
    negatives,
    topical,
    pos_hits,
    pos_recall,
    neg_noise,
    neg_dirty,
    eager_inj,
    eager_dirty,
  };
}

function pct(n) {
  return (100 * n).toFixed(0) + '%';
}

const control = runArm(false);
const treatment = runArm(true);

const recallGain = treatment.pos_hits - control.pos_hits;
const precisionCost = treatment.neg_noise - control.neg_noise;
let verdict;
if (recallGain > 0 && precisionCost <= 0) verdict = 'NET-POSITIVE';
else if (recallGain > 0 && precisionCost > 0) verdict = 'TRADEOFF (human judges worth)';
else if (recallGain <= 0 && precisionCost > 0) verdict = 'REJECT (precision down, no recall gain)';
else verdict = 'NEUTRAL (no movement)';

if (jsonOut) {
  console.log(
    JSON.stringify({ project: PROJECT, control, treatment, recallGain, precisionCost, verdict }, null, 2),
  );
} else {
  const P = SUITE.positives.length,
    N = SUITE.hard_negatives.length;
  console.error(
    `\n─── UPS identifier-bypass A/B (project=${PROJECT}, ${P} positives / ${N} hard-negatives) ───`,
  );
  console.error(`                    control (off)      treatment (on)`);
  console.error(
    `  positives hits    ${String(control.pos_hits).padStart(2)}/${P}  (recall ${pct(control.pos_recall)})      ${String(treatment.pos_hits).padStart(2)}/${P}  (recall ${pct(treatment.pos_recall)})`,
  );
  console.error(
    `  hard-neg noise    ${control.neg_noise} obs (${control.neg_dirty}/${N} dirty)        ${treatment.neg_noise} obs (${treatment.neg_dirty}/${N} dirty)   [TRUE off-topic FP]`,
  );
  const ET = (SUITE.topical_eager || []).length;
  if (ET)
    console.error(
      `  topical-eager     ${control.eager_inj} obs (${control.eager_dirty}/${ET} dirty)        ${treatment.eager_inj} obs (${treatment.eager_dirty}/${ET} dirty)   [on-topic, NOT in verdict]`,
    );
  console.error(
    `\n  Δ recall(hits) = ${recallGain >= 0 ? '+' : ''}${recallGain}   Δ precision(true-FP) = ${precisionCost >= 0 ? '+' : ''}${precisionCost}`,
  );
  console.error(`  VERDICT: ${verdict}`);
  console.error(`\n  Positives detail [✓=target surfaced]:`);
  for (let i = 0; i < control.positives.length; i++) {
    const c = control.positives[i],
      t = treatment.positives[i];
    const flip = !c.hit && t.hit ? '  ← RECOVERED' : c.hit && !t.hit ? '  ← LOST' : '';
    console.error(
      `    [${c.hit ? '✓' : '·'}→${t.hit ? '✓' : '·'}] exp #${c.expected.join(',')}  ctl=[${c.injected.join(',') || '—'}] trt=[${t.injected.join(',') || '—'}]${flip}`,
    );
  }
  console.error(`\n  Hard-negatives detail [noise = injected obs not expected]:`);
  for (let i = 0; i < control.negatives.length; i++) {
    const c = control.negatives[i],
      t = treatment.negatives[i];
    const flip = c.noise === 0 && t.noise > 0 ? '  ← NEW TRUE-FP' : '';
    console.error(
      `    [${c.noise}→${t.noise}] ctl=[${c.injected.join(',') || '—'}] trt=[${t.injected.join(',') || '—'}]  "${c.query.slice(0, 42)}"${flip}`,
    );
  }
  if (ET) {
    console.error(`\n  Topical-eager detail [eager = on-identifier obs surfaced, not a true FP]:`);
    for (let i = 0; i < control.topical.length; i++) {
      const c = control.topical[i],
        t = treatment.topical[i];
      const flip = c.eager === 0 && t.eager > 0 ? '  ← NEW EAGER' : '';
      console.error(
        `    [${c.eager}→${t.eager}] ctl=[${c.injected.join(',') || '—'}] trt=[${t.injected.join(',') || '—'}]  "${c.query.slice(0, 42)}"${flip}`,
      );
    }
  }
}
