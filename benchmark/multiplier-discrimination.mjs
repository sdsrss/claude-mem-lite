#!/usr/bin/env node
// Multiplier discrimination ruler — CAN this instrument observe each scoring
// multiplier at all, and does the multiplier still have the magnitude it claims?
//
// WHY THIS EXISTS. `benchmark/ci-gate.mjs` gates the scoring stack on two matrix
// deltas, and neither can say NO about the multipliers (doctrine rule 5):
//
//   * `hybrid_over_bm25` has floor -0.05 and reads +0.0002 R@10 / +0.0055 nDCG on
//     the canonical fixture. Degrading the whole multiplier chain to pure BM25
//     moves it to 0.0000 — still 0.05 above the floor. The gate stays green.
//   * The eight per-term ablation deltas ARE computed by `--matrix` and are
//     gated by NOTHING. Measured 2026-09-07 on `main` @ f25e8ae: five of them
//     (`no_project`, `no_access`, `no_lesson`, `no_noise`, `no_cite`) are 0 on
//     all four metrics to the last digit, and `no_importance` is NEGATIVE
//     (R@10 -0.0017, nDCG -0.0019) — dropping importance scores BETTER there.
//
// The canonical fixture cannot fix this by growing. It is saturated: `bm25_only`
// alone reads R@10 0.8996 / P@10 0.9731 / nDCG 0.9728, so there is no headroom
// left for a multiplier to demonstrate lift in, and eight multipliers together
// buy +0.0002 R@10. An aggregate IR metric over an easy corpus is the wrong
// instrument for "is this multiplier wired up".
//
// THE CALIBER: TIED-BM25 PAIRS, one axis varied.
// Each arm builds N pairs of observations with BYTE-IDENTICAL indexed text that
// differ only in the column its multiplier reads, and a nonce query term that
// matches exactly that pair. Identical text and identical token length means
// FTS5 hands both rows the same BM25, so the whole score difference is the
// multiplier under test. That makes the reading exact rather than statistical:
//
//     score = bm25 * PROD(terms)          and bm25_A == bm25_B
//     => (scoreA/scoreB) under `hybrid`  /  (scoreA/scoreB) under `no_X`  ==  X_A / X_B
//
// So the ruler does not threshold a metric — it RECOVERS the multiplier's own
// ratio and compares it against the ratio the formula claims. A multiplier that
// has been neutered reads 1.000; one whose constant moved reads a different
// number than declared and is flagged MISMATCH.
//
// This is deliberately NOT hand-picked hard negatives (the trap
// benchmark/deep-search-holdout.mjs documents): nothing here is chosen by
// relevance judgement. Both rows of a pair are equally relevant by construction
// — the pair exists only to hold BM25 constant while one column moves.
//
// THREE PREMISES, asserted per arm, because a silent premise failure looks
// exactly like a working multiplier (or a dead one):
//   P1 axisVaried  — the two rows really differ on the target column. A fixture
//                    that cannot vary an axis must report BLIND, never DEAD.
//                    This is what the canonical fixture gets wrong: it carries
//                    no access_count, no lesson_learned and no cite/noise state
//                    at all, so those four arms are unmeasurable there.
//   P2 bm25Tied    — under `bm25_only` the pair's scores are equal to 1e-9. If
//                    they are not, the axis edit leaked into the indexed text
//                    and the arm is measuring lexical difference, not the
//                    multiplier. (`lesson_learned` is an FTS column with BM25
//                    weight 8 — this premise is why its arm uses two one-token
//                    values, 'cause' vs the literal 'none', rather than a lesson
//                    against NULL.)
//   P3 tieUnbiased — under `bm25_only` pairwise accuracy is 0.5. Pairs alternate
//                    which row gets the lower rowid, so an exact tie must split
//                    evenly. Without this, a tie-break that systematically
//                    favours the preferred row would make every ablated arm read
//                    1.0 and every multiplier look alive.
//
// VERDICTS
//   MEASURED — premises hold, the recovered ratio matches the declared one, and
//              removing the term collapses pairwise accuracy from 1.0 to 0.5.
//   MISMATCH — the multiplier is wired up but its magnitude is not what the
//              formula in this file declares. Someone changed a constant.
//   DEAD     — premises hold, the axis varies, and the term still moves nothing.
//   BLIND    — a premise failed; this instrument cannot speak about this term.
//
// Usage:
//   node benchmark/multiplier-discrimination.mjs [--json]
//   node benchmark/multiplier-discrimination.mjs --self-check   # drive it to failure
//
// Exit code: 0 for a plain run (it is a meter). `--self-check` exits 1 if any
// self-check fails, because a ruler that cannot be broken is not a ruler.

import { fileURLToPath } from 'node:url';
import { createTestDb } from '../tests/test-helpers.mjs';
import { searchObservations } from './benchmark.mjs';
import { TYPE_QUALITY, CITE_FACTOR_PER_CITE } from '../scoring-sql.mjs';

const DAY = 86400000;

/** Pairs per arm. Even, so an exact tie splits 50/50 under the id alternation. */
const PAIRS_PER_ARM = 12;

/** Scores are negative (BM25 returns negative, lower = better), so a ratio of
 *  A/B is positive and > 1 exactly when A outranks B. */
const RATIO_TOL = 1e-6;

// ─── Arms ───────────────────────────────────────────────────────────────────
//
// `expectedRatio` is the multiplier the formula claims for (preferred / other).
// Where the constant is exported it is imported rather than copied; where it is
// inline in benchmark.mjs's MULT_EXPR the literal is written here WITH its
// source expression, and a disagreement is reported as MISMATCH rather than
// silently passing — that is the point of comparing against a declared value.

export const ARMS = [
  {
    term: 'decay',
    ablated: 'no_decay',
    axis: 'created_at_epoch',
    // (1.0 + EXP(-0.693 * age / halfLife)); both rows are type 'bugfix', whose
    // half-life is 14d, so the ratio is fixed by the two ages alone.
    // preferred: age ~0  -> 1 + e^0        = 2.0
    // other:     age 90d -> 1 + e^-4.4571  = 1.011600...
    expectedRatio: 2.0 / (1.0 + Math.exp((-0.693 * 90 * DAY) / (14 * DAY))),
    why: 'recent outranks old',
    preferred: { createdOffsetDays: 0 },
    other: { createdOffsetDays: -90 },
    shared: { type: 'bugfix' },
  },
  {
    term: 'type',
    ablated: 'no_type',
    axis: 'type',
    // TYPE_QUALITY, imported. bugfix vs refactor is deliberate: they are the one
    // pair in the table that SHARES a decay half-life (both 14d in
    // TYPE_DECAY_CASE), so this arm cannot leak into the decay term. A
    // decision/change pair would have moved both multipliers at once.
    expectedRatio: TYPE_QUALITY.bugfix / TYPE_QUALITY.refactor,
    why: 'higher-signal type outranks lower',
    preferred: { type: 'bugfix' },
    other: { type: 'refactor' },
    shared: {},
  },
  {
    term: 'project',
    ablated: 'no_project',
    axis: 'project',
    // (CASE WHEN ? IS NOT NULL AND o.project = ? THEN 2.0 ELSE 1.0 END)
    expectedRatio: 2.0,
    why: 'current-project row outranks another project',
    preferred: { project: 'probe--alpha' },
    other: { project: 'probe--beta' },
    shared: {},
    // The boost project WITHOUT a filter — mirroring search-engine.mjs:606,
    // `projectBoost = args.project ? null : currentProject`. Passing it as a
    // filter instead (what this harness used to do for its one project-carrying
    // query) makes the boost a constant across the surviving rows and therefore
    // rank-invariant, which is why the matrix reads exactly 0 for this term.
    currentProject: 'probe--alpha',
  },
  {
    term: 'importance',
    ablated: 'no_importance',
    axis: 'importance',
    // (0.5 + 0.5 * COALESCE(o.importance, 1)):  imp 3 -> 2.0, imp 1 -> 1.0
    expectedRatio: (0.5 + 0.5 * 3) / (0.5 + 0.5 * 1),
    why: 'important outranks routine',
    preferred: { importance: 3 },
    other: { importance: 1 },
    shared: {},
  },
  {
    term: 'access',
    ablated: 'no_access',
    axis: 'access_count',
    // (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0)))
    // injection_count stays 0 on both rows so the noise term cannot read this
    // same column and confound the arm.
    expectedRatio: (1.0 + 0.1 * Math.log(1 + 148)) / (1.0 + 0.1 * Math.log(1 + 0)),
    why: 'frequently-accessed outranks never-accessed',
    preferred: { access_count: 148 },
    other: { access_count: 0 },
    shared: {},
  },
  {
    term: 'lesson',
    ablated: 'no_lesson',
    axis: 'lesson_learned',
    // (1.0 + 0.3 * (lesson_learned IS NOT NULL AND NOT IN ('', 'none')))
    // Both values are ONE token so the FTS doc lengths stay equal — see P2.
    expectedRatio: 1.3 / 1.0,
    why: 'a row carrying a lesson outranks one that does not',
    preferred: { lesson_learned: 'cause' },
    other: { lesson_learned: 'none' },
    shared: {},
  },
  {
    term: 'noise',
    ablated: 'no_noise',
    axis: 'injection_count',
    // noisePenaltyClause: injection >= 8 AND injection > access*5 -> 0.2
    // access_count is 0 on both rows, so the 'access' term reads 1.0 on both.
    expectedRatio: 1.0 / 0.2,
    why: 'a row injected 10 times and never used is penalised',
    preferred: { injection_count: 0 },
    other: { injection_count: 10 },
    shared: { access_count: 0 },
  },
  {
    term: 'cite',
    ablated: 'no_cite',
    axis: 'cited_count',
    // citeFactorClause: clamp(1 + 0.2*cited - 0.25*streak, 0.4, 3.0)
    expectedRatio: (1.0 + CITE_FACTOR_PER_CITE * 5) / 1.0,
    why: 'a cited row outranks an uncited one',
    preferred: { cited_count: 5 },
    other: { cited_count: 0 },
    shared: { uncited_streak: 0 },
  },
];

// ─── Corpus ─────────────────────────────────────────────────────────────────

const BASE = {
  project: 'probe--alpha',
  type: 'bugfix',
  importance: 1,
  access_count: 0,
  injection_count: 0,
  cited_count: 0,
  uncited_streak: 0,
  lesson_learned: null,
  createdOffsetDays: 0,
};

const INSERT_COLUMNS = [
  'id',
  'memory_session_id',
  'project',
  'text',
  'type',
  'title',
  'narrative',
  'concepts',
  'created_at',
  'created_at_epoch',
  'importance',
  'access_count',
  'lesson_learned',
  'injection_count',
  'cited_count',
  'uncited_streak',
];

/**
 * Build one arm's probe corpus into a fresh DB.
 *
 * Every pair shares a nonce token so a query for it returns exactly that pair,
 * and the two rows carry identical title / narrative / concepts / text. The
 * only intentional difference is the arm's axis column.
 *
 * Pair k alternates which row gets the LOWER rowid. Under an exact BM25 tie the
 * order SQLite returns is then split evenly between the two, which is what makes
 * the ablated arm read 0.5 instead of inheriting a systematic tie-break.
 *
 * @param {object} db      open better-sqlite3 handle
 * @param {object} arm     one ARMS entry
 * @param {number} nPairs  pair count (even)
 * @returns {Array<{nonce: string, preferredId: number, otherId: number}>}
 */
export function seedArm(db, arm, nPairs = PAIRS_PER_ARM) {
  const now = Date.now();
  const sessionId = `probe-${arm.term}`;
  db.prepare(
    `INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
     VALUES (?, ?, ?, ?, ?, 'completed')`,
  ).run(sessionId, sessionId, BASE.project, new Date(now).toISOString(), now);

  const insert = db.prepare(
    `INSERT INTO observations (${INSERT_COLUMNS.join(', ')})
     VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`,
  );

  const pairs = [];
  let nextId = 1;
  const tx = db.transaction(() => {
    for (let k = 0; k < nPairs; k++) {
      const nonce = `zqprobe${arm.term}${k}`;
      // Identical indexed content for both rows of the pair.
      const shared = {
        text: `${nonce} shared probe body text for the tied bm25 pair`,
        title: `probe pair ${k}`,
        narrative: 'identical narrative on both rows of the pair',
        concepts: 'probe,tied,pair',
      };
      const mk = (over) => ({ ...BASE, ...arm.shared, ...over, ...shared });
      const preferred = mk(arm.preferred);
      const other = mk(arm.other);

      // Alternate rowid order so an exact tie cannot systematically favour one side.
      const first = k % 2 === 0 ? preferred : other;
      const second = k % 2 === 0 ? other : preferred;
      const firstId = nextId++;
      const secondId = nextId++;

      for (const [id, row] of [
        [firstId, first],
        [secondId, second],
      ]) {
        const epoch = now + row.createdOffsetDays * DAY;
        insert.run(
          id,
          sessionId,
          row.project,
          row.text,
          row.type,
          row.title,
          row.narrative,
          row.concepts,
          new Date(epoch).toISOString(),
          epoch,
          row.importance,
          row.access_count,
          row.lesson_learned,
          row.injection_count,
          row.cited_count,
          row.uncited_streak,
        );
      }

      pairs.push({
        nonce,
        preferredId: k % 2 === 0 ? firstId : secondId,
        otherId: k % 2 === 0 ? secondId : firstId,
      });
    }
  });
  tx();
  return pairs;
}

// ─── Measurement ────────────────────────────────────────────────────────────

function scorePair(db, arm, pair, mode) {
  const rows = searchObservations(db, pair.nonce, {
    mode,
    limit: 10,
    currentProject: arm.currentProject ?? null,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    rows,
    preferred: byId.get(pair.preferredId),
    other: byId.get(pair.otherId),
    firstId: rows.length ? rows[0].id : null,
  };
}

/**
 * Measure one arm.
 *
 * @param {object} arm    one ARMS entry
 * @param {object} [opts]
 * @param {number} [opts.nPairs]
 * @param {string} [opts.hybridMode]  override the "full chain" arm (self-check)
 * @param {string} [opts.ablatedMode] override the "term removed" arm (self-check)
 * @returns {object} reading for this arm
 */
export function measureArm(arm, { nPairs = PAIRS_PER_ARM, hybridMode = 'hybrid', ablatedMode } = {}) {
  const db = createTestDb();
  try {
    const pairs = seedArm(db, arm, nPairs);
    const mode2 = ablatedMode ?? arm.ablated;

    // P1 — the axis really varies on disk. Read it back rather than trusting the
    // seed: a column the schema does not have would silently insert as NULL.
    const axisValues = new Set();
    for (const p of pairs) {
      for (const id of [p.preferredId, p.otherId]) {
        const v = db.prepare(`SELECT ${arm.axis} AS v FROM observations WHERE id = ?`).get(id);
        axisValues.add(String(v?.v));
      }
    }
    const axisVaried = axisValues.size >= 2;

    let hybridWins = 0;
    let ablatedWins = 0;
    let bm25Wins = 0;
    let maxBm25Gap = 0;
    const ratios = [];
    let complete = 0;

    for (const p of pairs) {
      const h = scorePair(db, arm, p, hybridMode);
      const a = scorePair(db, arm, p, mode2);
      const b = scorePair(db, arm, p, 'bm25_only');
      if (!h.preferred || !h.other || !a.preferred || !a.other || !b.preferred || !b.other) continue;
      complete++;

      // P2 — BM25 must tie, or the arm is measuring lexical difference.
      maxBm25Gap = Math.max(maxBm25Gap, Math.abs(b.preferred.score - b.other.score));

      if (h.firstId === p.preferredId) hybridWins++;
      if (a.firstId === p.preferredId) ablatedWins++;
      if (b.firstId === p.preferredId) bm25Wins++;

      // The recovered multiplier ratio. Both quotients are (preferred/other) of
      // the SAME product except for the one term, so the quotient of quotients
      // is exactly that term's ratio.
      const hq = h.preferred.score / h.other.score;
      const aq = a.preferred.score / a.other.score;
      if (Number.isFinite(hq) && Number.isFinite(aq) && aq !== 0) ratios.push(hq / aq);
    }

    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
    const measuredRatio = mean(ratios);
    const hybridAcc = complete ? hybridWins / complete : NaN;
    const ablatedAcc = complete ? ablatedWins / complete : NaN;
    const bm25Acc = complete ? bm25Wins / complete : NaN;

    const bm25Tied = maxBm25Gap < 1e-9;
    const tieUnbiased = Math.abs(bm25Acc - 0.5) < 1e-9;

    let verdict;
    if (!complete) verdict = 'BLIND (no complete pairs)';
    else if (!axisVaried) verdict = 'BLIND (axis constant)';
    else if (!bm25Tied) verdict = 'BLIND (bm25 not tied)';
    else if (!tieUnbiased) verdict = 'BLIND (tie-break biased)';
    else if (!Number.isFinite(measuredRatio) || Math.abs(measuredRatio - 1) < RATIO_TOL) verdict = 'DEAD';
    else if (Math.abs(measuredRatio - arm.expectedRatio) > 1e-3 * arm.expectedRatio) verdict = 'MISMATCH';
    else if (hybridAcc === 1 && Math.abs(ablatedAcc - 0.5) < 1e-9) verdict = 'MEASURED';
    else verdict = 'MISMATCH';

    return {
      term: arm.term,
      axis: arm.axis,
      why: arm.why,
      pairs: complete,
      axisVaried,
      bm25Tied,
      maxBm25Gap,
      tieUnbiased,
      bm25Acc,
      hybridAcc,
      ablatedAcc,
      measuredRatio,
      expectedRatio: arm.expectedRatio,
      verdict,
    };
  } finally {
    db.close();
  }
}

export function runDiscrimination({ nPairs = PAIRS_PER_ARM } = {}) {
  return ARMS.map((arm) => measureArm(arm, { nPairs }));
}

// ─── Self-check (doctrine rule 5: drive the ruler to failure) ───────────────

/**
 * Every check here must FAIL if the ruler stops being able to say NO.
 * @returns {{passed: number, failed: Array<string>}}
 */
export function runSelfChecks() {
  const failed = [];
  let passed = 0;
  const check = (name, ok, detail) => {
    if (ok) passed++;
    else failed.push(`${name}${detail ? ` — ${detail}` : ''}`);
  };

  // 1. Every arm must read MEASURED on the shipped scoring stack. An arm that
  //    cannot reach its own happy path is not evidence about anything.
  const base = runDiscrimination();
  for (const r of base) {
    check(
      `arm ${r.term} reads MEASURED`,
      r.verdict === 'MEASURED',
      `${r.verdict}, ratio ${r.measuredRatio?.toFixed(4)} vs expected ${r.expectedRatio?.toFixed(4)}`,
    );
  }

  // 2. THE NO. Compare the full chain against ITSELF: the term under test is
  //    present in both arms, so its recovered ratio must collapse to exactly 1
  //    and the verdict must be DEAD. If this ever reads MEASURED, the ruler is
  //    reporting a multiplier that is not there.
  for (const arm of ARMS) {
    const r = measureArm(arm, { ablatedMode: 'hybrid' });
    check(
      `arm ${arm.term} says DEAD when the term is in BOTH arms`,
      r.verdict === 'DEAD',
      `${r.verdict}, ratio ${r.measuredRatio}`,
    );
  }

  // 3. A constant axis must read BLIND, never DEAD. This is the distinction the
  //    canonical fixture gets wrong for access / lesson / noise / cite, and
  //    conflating them is how "0 lift" gets misread as "dead weight".
  for (const arm of ARMS) {
    const flat = { ...arm, preferred: arm.other, other: arm.other };
    const r = measureArm(flat);
    check(`arm ${arm.term} says BLIND when the axis does not vary`, r.verdict.startsWith('BLIND'), r.verdict);
  }

  // 4. A magnitude change must be caught, not absorbed. Halving the declared
  //    ratio has to produce MISMATCH — this is the check the ci-gate lacks
  //    entirely, and it is what would catch someone retuning TYPE_QUALITY or
  //    the cite constants without re-stamping the baseline.
  for (const arm of ARMS) {
    const skewed = { ...arm, expectedRatio: arm.expectedRatio * 0.5 };
    const r = measureArm(skewed);
    check(`arm ${arm.term} says MISMATCH on a wrong declared ratio`, r.verdict === 'MISMATCH', r.verdict);
  }

  return { passed, failed };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function fmt(x, digits = 4) {
  return Number.isFinite(x) ? x.toFixed(digits) : 'n/a';
}

function main() {
  if (process.argv.includes('--self-check')) {
    const { passed, failed } = runSelfChecks();
    console.log(`\n─── Multiplier discrimination — self-check ───`);
    console.log(`  passed: ${passed}`);
    if (failed.length) {
      console.log(`  FAILED: ${failed.length}`);
      for (const f of failed) console.log(`    ✗ ${f}`);
      process.exitCode = 1;
      return;
    }
    console.log('  All self-checks passed — the ruler can still say NO.\n');
    return;
  }

  const results = runDiscrimination();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), arms: results }, null, 2));
    return;
  }

  console.log('\n─── Multiplier discrimination ───');
  console.log('  Tied-BM25 pairs: both rows carry identical indexed text and differ');
  console.log('  only on the column the multiplier reads. The recovered ratio is the');
  console.log('  multiplier itself, not a metric it moved.\n');
  console.log('  term        axis               pairs  hybrid  ablated  ratio      declared   verdict');
  for (const r of results) {
    console.log(
      '  ' +
        r.term.padEnd(11) +
        r.axis.padEnd(18) +
        String(r.pairs).padStart(5) +
        '  ' +
        fmt(r.hybridAcc, 2).padStart(6) +
        '  ' +
        fmt(r.ablatedAcc, 2).padStart(7) +
        '  ' +
        fmt(r.measuredRatio).padStart(9) +
        '  ' +
        fmt(r.expectedRatio).padStart(9) +
        '   ' +
        r.verdict,
    );
  }
  const dead = results.filter((r) => r.verdict === 'DEAD');
  const blind = results.filter((r) => r.verdict.startsWith('BLIND'));
  const mismatch = results.filter((r) => r.verdict === 'MISMATCH');
  console.log(
    `\n  MEASURED ${results.length - dead.length - blind.length - mismatch.length}/${results.length}` +
      `   DEAD ${dead.length}   BLIND ${blind.length}   MISMATCH ${mismatch.length}`,
  );
  console.log('  hybrid 1.00 / ablated 0.50 is the signature of a live multiplier:');
  console.log('  removing it turns a decided ranking back into a coin flip.\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
