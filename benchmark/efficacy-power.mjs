#!/usr/bin/env node
// efficacy-power.mjs — STEP 2 of the efficacy-validation design.
// Spec: docs/superpowers/specs/2026-06-05-memory-efficacy-validation-design.md §5
//
// Monte-Carlo power analysis for the A/C pilot. Tells us, BEFORE spending real
// Claude sessions, the minimum detectable effect at each (#commits, k) and the
// session cost, so step 3 never returns a number it has no power to interpret.
//
// DESIGN MODELLED (faithful to the spec):
//   - Replication unit = COMMIT (not run). k runs/arm estimate a commit's
//     per-arm pass-probability; the test is on the COMMIT-LEVEL paired
//     differences. Pooling runs as independent = pseudo-replication = inflated
//     power; we do NOT do that.
//   - Goldilocks screening ⇒ control pass-prob p_C ~ U[0.25,0.65] (bug
//     reintroduced 35–75% of the time without the lesson: real room to move).
//   - Heterogeneous effect: δ_i ~ N(meanδ, 0.10) truncated to [0, 1−p_C_i];
//     a fraction ZERO_FRAC of commits have δ_i=0 (lesson doesn't help there).
//   - Primary test: one-sample, ONE-SIDED t-test on the N per-commit
//     differences (H0: mean δ = 0), α=0.05. (Cluster-aware by construction:
//     commit means are the units.) Nonparametric would be more conservative;
//     t is the optimistic-but-standard reference.
//
// Output: power surface + the recommended pilot point + cost.
//   node benchmark/efficacy-power.mjs           # report
//   node benchmark/efficacy-power.mjs --json

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const JSON_MODE = !!args.json;

const SIMS = parseInt(args.sims || '5000', 10);
const ALPHA = 0.05;
const SD_DELTA = 0.1; // effect heterogeneity
const ZERO_FRAC = 0.3; // share of commits the lesson does nothing for
const PC_LO = 0.25,
  PC_HI = 0.65;
const COMMITS = [8, 10, 12, 16, 20];
const KS = [2, 3, 5, 8];
const MEAN_DELTAS = [0.1, 0.2, 0.3];

// seeded RNG (reproducible) — Mulberry32
let _s = 0x9e3779b9;
function rnd() {
  _s |= 0;
  _s = (_s + 0x6d2b79f5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss() {
  let u = 0,
    v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function binom(n, p) {
  let c = 0;
  for (let i = 0; i < n; i++) if (rnd() < p) c++;
  return c;
}

// one-sided (greater) one-sample t critical value via normal approx is too loose
// for small N; use a t-table for the df we actually use.
const T95 = { 7: 1.895, 9: 1.833, 11: 1.796, 15: 1.753, 19: 1.729 }; // df = N-1, one-sided .05
function tcrit(N) {
  return T95[N - 1] ?? 1.7;
}

function oneSidedTReject(diffs) {
  const N = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / N;
  const varr = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (N - 1);
  const se = Math.sqrt(varr / N);
  if (se === 0) return mean > 0; // degenerate: all-identical positive diffs
  return mean / se > tcrit(N);
}

function power(nCommits, k, meanDelta) {
  let rejects = 0;
  for (let s = 0; s < SIMS; s++) {
    const diffs = new Array(nCommits);
    for (let i = 0; i < nCommits; i++) {
      const pC = PC_LO + rnd() * (PC_HI - PC_LO);
      let delta = rnd() < ZERO_FRAC ? 0 : meanDelta + SD_DELTA * gauss();
      delta = Math.max(0, Math.min(1 - pC, delta));
      const pA = pC + delta;
      const passC = binom(k, pC) / k;
      const passA = binom(k, pA) / k;
      diffs[i] = passA - passC;
    }
    if (oneSidedTReject(diffs)) rejects++;
  }
  return rejects / SIMS;
}

const surface = {};
for (const md of MEAN_DELTAS) {
  surface[md] = {};
  for (const n of COMMITS) {
    surface[md][n] = {};
    for (const k of KS) surface[md][n][k] = power(n, k, md);
  }
}

if (JSON_MODE) {
  console.log(
    JSON.stringify({ params: { SIMS, ALPHA, SD_DELTA, ZERO_FRAC, PC_LO, PC_HI }, surface }, null, 2),
  );
  process.exit(0);
}

const pc = (x) => (100 * x).toFixed(0).padStart(3) + '%';
console.log('STEP 2 — Monte-Carlo power for the A/C efficacy pilot');
console.log(
  `sims=${SIMS}/cell · α=${ALPHA} one-sided · unit=COMMIT · p_C~U[${PC_LO},${PC_HI}] · δ~N(mean,${SD_DELTA}), ${ZERO_FRAC * 100}% null commits\n`,
);

for (const md of MEAN_DELTAS) {
  console.log(
    `── true mean effect = +${(100 * md).toFixed(0)}pp pass-rate (lesson avoids the bug this much more often) ──`,
  );
  console.log(
    '   commits\\k   ' +
      KS.map((k) => 'k=' + k)
        .map((s) => s.padStart(6))
        .join(''),
  );
  for (const n of COMMITS) {
    console.log(
      '   ' + String(n).padStart(7) + '     ' + KS.map((k) => pc(surface[md][n][k]).padStart(6)).join(''),
    );
  }
  console.log('');
}

// cost + recommendation
console.log('COST  sessions = commits × k × 2 arms:');
for (const n of [8, 12, 20])
  for (const k of [3, 5]) console.log(`   ${n} commits × k=${k} → ${n * k * 2} sessions`);
console.log('');
console.log(
  'NOTE: panel header "+Npp" is the effect AMONG commits the lesson helps; with ' +
    ZERO_FRAC * 100 +
    '% null',
);
console.log(
  '      commits the REALIZED average effect ≈ ' +
    (100 * (1 - ZERO_FRAC)).toFixed(0) +
    '% of that. Heterogeneity (sd=' +
    SD_DELTA +
    '),',
);
console.log(
  '      not per-commit noise, is the dominant variance — which is why only more COMMITS raise power.\n',
);
console.log('READING / RECOMMENDATION:');
console.log(
  '  • Pilot scale (8–12 commits) only reaches ≥80% power for LARGE effects (~+30pp); a real-but-modest',
);
console.log(
  '    +10–15pp effect will usually be MISSED at pilot scale — so a null pilot ≠ "system useless".',
);
console.log(
  '  • k buys little above k=3–5: per-commit noise is already small vs commit-to-commit heterogeneity,',
);
console.log('    which only more COMMITS reduce. Spend the session budget on commits, not on big k.');
console.log(
  '  • Recommended pilot point: 12 commits × k=3 (=72 sessions) — powered to confirm a LARGE effect and,',
);
console.log(
  '    just as valuably, to expose a clearly-positive per-commit pattern by eye even when the t-test is',
);
console.log(
  '    underpowered. Treat the pilot as a SEVERE TEST + effect-size *estimator*, not a powered hypothesis',
);
console.log('    test. If the per-commit deltas cluster near 0, that is a strong (if not p<.05) negative.');
console.log(
  '  • SOBERING: a powered confirmatory test of a MODEST realized effect (~+10–15pp) is out of reach at',
);
console.log(
  '    ANY realistic budget here — even 20 commits × k=8 (320 sessions) only ~35% power at +10pp. The',
);
console.log(
  '    binding limit is the scarce usable-commit count + commit heterogeneity, which sessions cannot buy',
);
console.log(
  '    past. A frequentist "p<0.05 it works" verdict is therefore NOT a deliverable this repo can yield.',
);
console.log(
  '  • LEVERS if more power is needed: (a) graded/continuous oracle instead of binary pass/fail (cuts',
);
console.log(
  '    per-run variance, biggest single lift); (b) widen corpus beyond this one repo. Both are step-4 scope.',
);
