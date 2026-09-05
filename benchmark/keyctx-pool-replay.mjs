#!/usr/bin/env node
// benchmark/keyctx-pool-replay.mjs — the ruler for the SessionStart Key Context face's
// candidate-pool bounds (KEYCTX_POOL_OBS / KEYCTX_POOL_SESS in hook-context.mjs, D#192 —
// filed as D#189, re-scoped to obs-only after this ruler measured the two bounds apart).
//
// WHY IT IS ITS OWN FILE. This is the FIFTH surface of the D#172 shape — a SQL LIMIT
// sitting upstream of a JS relevance filter, so the LIMIT bounds REACHABILITY, not
// ranking. It is also the purest instance found so far: `rerank-pool-replay`'s face at
// least orders its pool by raw bm25, one factor of the final composite. Here both
// SELECTs order by `created_at_epoch DESC` alone, while the selector re-sorts by
// `valueDensity` = recency x typeQuality x impBoost x lessonBoost / sqrt(cost). Recency
// enters that product compressed into (1,2] by `1.0 + exp(...)`, against impBoost
// alone spanning 1.0-2.0 and typeQuality and lessonBoost multiplying on top — so the
// key the SQL sorts on is close to irrelevant to the final order.
//
// NOTHING ELSE CAN SEE THIS FACE. `benchmark/denoise-ab.mjs` drives search-engine.mjs
// (query -> document FTS); `rerank-pool-replay` drives hook-memory.mjs;
// `imperative-pool-replay` drives the identifier-overlap face. None of them imports
// hook-context.mjs, so a NEUTRAL verdict from any of them says nothing at all here.
//
// ITS ABSOLUTE NUMBERS ARE SNAPSHOTS. THE COMPARISON BETWEEN ARMS IS NOT.
// `selectWithTokenBudget` takes no clock: it calls `Date.now()`, derives adaptive time
// windows from it, and weights every candidate by recency. So a token count, a
// gained/displaced count, or a set size printed here is a fact about THIS MACHINE AT THIS
// MINUTE — v3.86.0 published `829 -> 1880` and `9 gained / 2 displaced` from this file,
// and hours later the same commands read `652 -> 1863` and `10 gained / 3 displaced`.
//
// AND NOT BECAUSE THE CORPUS GREW — that was the first, half-right diagnosis. The pools
// are SLIDING WINDOWS, so they DECAY with wall-clock even while the store gains rows.
// Measured on `projects--mem` the same evening: obsPool 113 -> 112 -> 108 across three
// runs while its live row count went 776 -> 777 with zero rows superseded. Growth cannot
// lower a count; a receding window can. The pre-tag claims review caught the drift and
// supplied this mechanism; the numbers were republished with a timestamp.
//
// What IS stable is the DIRECTION, because both arms run in one process microseconds
// apart against one database: which arm changes the observation selection, which one only
// adds summaries, and the sign and rough size of the token cost. Quote those. If you must
// quote an absolute, stamp it with the date and say it is a snapshot.
//
// THE UNIT IS A PROJECT, NOT A PROMPT, and that is the honest limitation. Key Context
// takes no query — it is (db, project, budget) — so the corpus is however many projects
// this machine has, and n is around a dozen. Read the per-project table, not the
// aggregate; a percentage over n=12 is a count wearing a disguise.
//
// SELECTION HERE IS NOT MONOTONE, and this ruler must not borrow rerank-pool-replay's
// superset argument. TWO stages downstream of the pool can DROP a row that a narrower
// pool would have selected, and `--why-displaced` says which, per row, instead of
// leaving the reader to assume:
//   • the type-diversity cap (max 3 per type) — the only live gate on this corpus;
//   • the token budget — does not bind here (651 of 2000 in the widest arm's largest
//     project), so a displacement attributed to it would be a surprise worth checking.
// There was a third, the file-overlap penalty, and D#197 deleted it rather than
// leaving it listed as a gate that never fires: its `continue` needed
// valueDensity < 0.001/0.7 against an analytic floor of 0.5 for `value` (a title
// costing >122k tokens; the live minimum measured 0.1147, 80x above the trigger), and
// the penalty it computed was never read by the ordering anyway.
// So `displaced` is expected to be non-zero and is reported as a first-class number
// rather than gated to zero. What IS gated: the ruler must be able to SEE displacement
// at all (a self-check drives a synthetic case and requires a non-zero count), and
// shipped-vs-shipped must report no difference.
//
// AN ARM CAN BE INERT WITHOUT BEING EQUAL. `writeTwin` throws only when BOTH bounds match
// shipped, so after v3.87.0 raised OBS to 200 the default invocation (200/10 vs 200/40)
// runs an obs arm that is identical by construction and reports `obs newly reachable: 0`
// with nothing to flag it — a reader takes that for "widening obs does nothing". Worse,
// any bound at or above the largest pool is the same arm as any other: 200 and 500 are
// indistinguishable here. Every mode that COMPARES two arms — the default replay,
// --why-displaced and --cost — prints an INERT notice when the twin equals shipped or when
// both bounds sit above the largest pool; --population takes no second arm and instead
// prints the largest pool outright. A null result and a comparison that could not have
// produced a non-null result are not the same finding.
//
// The notice is itself checked, because an annotation nothing can falsify is worse than
// none: mutating the pool-size input to 0 once made every run print INERT directly above a
// report showing two projects changing, with the whole suite green. assertInertConsistent
// throws on that contradiction, and main() refuses to start if any project cleared the row
// floor while the largest pool measured 0.
//
// USAGE
//   node benchmark/keyctx-pool-replay.mjs                 all projects, shipped vs a wide twin
//   node benchmark/keyctx-pool-replay.mjs --wide-obs 50 --wide-sess 10
//                                                        runs BACKWARDS (twin is narrower) —
//                                                        this is how the pre-v3.87.0 50/10
//                                                        baseline is re-derived
//   node benchmark/keyctx-pool-replay.mjs --population    pool sizes + truncation only
//   node benchmark/keyctx-pool-replay.mjs --population --ref-obs 50 --ref-sess 10
//                                                        truncation against a bound OTHER than
//                                                        shipped (the 3/11 figure quoted for
//                                                        the v3.87.0 decision is --ref-obs 50)
//   node benchmark/keyctx-pool-replay.mjs --why-displaced name the gained/displaced rows and
//                                                        the gate that dropped each one
//   node benchmark/keyctx-pool-replay.mjs --cost          per-call wall clock, arms alternated
//   node benchmark/keyctx-pool-replay.mjs --min-rows 20   project inclusion floor
//   node benchmark/keyctx-pool-replay.mjs --json

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { DB_DIR } from '../schema.mjs';
import { liveObsFilterSql } from '../lib/inject-search-core.mjs';
import { notLowSignalTitleClause } from '../utils.mjs';

// D#207: paths built with `join()`, never `new URL('../X.mjs', import.meta.url)`. That
// form makes knip drop the named module out of its unused-export report ENTIRELY — this
// file naming hook-context.mjs that way is why knip could not see it at all, which is
// what tests/knip-blindspot-guard.test.mjs was written to compensate for. Established by
// probe, both directions. tests/no-url-module-paths.test.mjs pins the rule for the class.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_PATH = join(REPO_ROOT, 'hook-context.mjs');
const SHIPPED_URL = pathToFileURL(SHIPPED_PATH);
// Repo root, not benchmark/, or hook-context's own './lib/...' specifiers resolve
// against the wrong directory.
const TWIN_PATH = join(REPO_ROOT, '.tmp-keyctx-pool-twin.mjs');
const TWIN_URL = pathToFileURL(TWIN_PATH);

const DEFAULT_WIDE_OBS = 200;
const DEFAULT_WIDE_SESS = 40;
const DEFAULT_MIN_ROWS = 20;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

/**
 * Patch a named constant in the shipped source. Matches the DECLARATION, so "the edit
 * changed nothing" and "the anchor is gone" stay distinguishable — holding one pool at
 * its shipped value while sweeping the other is legitimate, and a guard that reports it
 * as a missing constant sends the reader to the wrong file.
 */
export function patchConst(src, name, value) {
  // No `export` in the pattern: the bounds are module-private (D#207 — exporting them
  // bought nothing, since this patch works on TEXT, and cost two permanent entries in
  // knip's report once hook-context.mjs became visible to it). Same shape as
  // rerank-pool-replay.mjs's patchConst, which has always matched a bare `const`.
  const re = new RegExp(`const ${name} = (\\d+);`);
  const m = src.match(re);
  if (!m) throw new Error(`twin patch failed: ${name} not found in hook-context.mjs (renamed?)`);
  return { out: src.replace(re, `const ${name} = ${value};`), previous: Number(m[1]) };
}

export function writeTwin(obsLimit, sessLimit) {
  const src = readFileSync(SHIPPED_URL, 'utf8');
  const a = patchConst(src, 'KEYCTX_POOL_OBS', obsLimit);
  const b = patchConst(a.out, 'KEYCTX_POOL_SESS', sessLimit);
  if (a.previous === obsLimit && b.previous === sessLimit) {
    throw new Error(
      `twin is identical to shipped (${obsLimit}/${sessLimit}) — the comparison ` +
        'would report 0 differences for reasons that have nothing to do with the pools.',
    );
  }
  writeFileSync(TWIN_URL, b.out);
  return { obs: a.previous, sess: b.previous };
}

/**
 * Instrument the shipped selection loop so each candidate records WHICH gate dropped it.
 *
 * v3.87.0 published "both displaced rows lost their slot to the 3-per-type cap" from a
 * throwaway script that no longer existed by the time two reviewers tried to check it;
 * both had to rebuild it. The attribution reproduced, but a claim only its author can
 * re-derive is a claim on trust. Patching the shipped TEXT (rather than reimplementing the
 * loop) keeps the scoring formulas from drifting from production — same reasoning as the
 * twin.
 *
 * Every anchor is required. A silently-missed drop point would produce a complete-looking
 * report in which one gate simply never fires, which is indistinguishable from that gate
 * being inactive — the exact reading this mode exists to support.
 */
// The file-overlap penalty was a third entry here until D#197 deleted the block it
// anchored on. Removing the entry is not a loss of attribution coverage: that gate
// was unreachable (its `continue` needed a title costing >122k tokens; the live
// minimum valueDensity measured 80x above the trigger) AND its computed penalty was
// never read by the ordering, so it could never have explained a displacement. This
// list now holds only gates that can actually fire.
export const DROP_POINTS = [
  ['if (totalTokens + c.cost > budget) continue;', 'budget'],
  ['if (typeCount >= 3) continue;', 'typecap'],
];

export function patchDropPoints(src) {
  let out = src;
  for (const [anchor, label] of DROP_POINTS) {
    if (!out.includes(anchor)) {
      throw new Error(
        `drop-point anchor gone: ${label} ("${anchor}"). The selection loop ` +
          'moved; refusing to report an attribution over gates that may never fire.',
      );
    }
    out = out.replace(
      anchor,
      anchor.replace(
        /continue;$/,
        `{ globalThis.__KEYCTX_TRACE.push([c._kind, c.id, '${label}']); continue; }`,
      ),
    );
  }
  const sel = 'totalTokens += c.cost;';
  if (!out.includes(sel)) throw new Error('drop-point anchor gone: the selection commit');
  return out.replace(sel, `globalThis.__KEYCTX_TRACE.push([c._kind, c.id, 'SELECTED']); ${sel}`);
}

/**
 * The largest candidate pool across the walked projects. Any bound at or above it selects
 * the whole pool, so two such bounds are the SAME ARM however different the integers look.
 */
function largestObsPool(db, projects, computeAdaptiveWindows) {
  let max = 0;
  for (const { project } of projects) max = Math.max(max, poolSizes(db, project, computeAdaptiveWindows).obs);
  return max;
}

/**
 * Why a zero can be uninformative. Returns null when the comparison could genuinely have
 * moved, a message when it could not.
 */
export function inertNotice(shippedObs, wideObs, maxPool) {
  if (shippedObs === wideObs) {
    return (
      `obs arm is INERT: twin bound (${wideObs}) equals shipped. Any "0 newly reachable" ` +
      'below is arithmetic, not a measurement.'
    );
  }
  if (Math.min(shippedObs, wideObs) >= maxPool) {
    return (
      `obs arm is INERT: both bounds (${shippedObs}, ${wideObs}) are at or above the largest ` +
      `pool (${maxPool}), so both select every candidate. Widening past the pool cannot show ` +
      'an effect; use --wide-obs below ' +
      maxPool +
      ' to compare arms that differ.'
    );
  }
  return null;
}

/**
 * Cost sampling. Arms ALTERNATE across passes because pairing them in one process lets the
 * second reuse the first's warm pages — the bias documented for the sibling ruler, where
 * alternating cancelled about half of it. Absolutes from this mode are NOT quotable: the
 * sibling's own six-run spread moved 3.04 -> 1.80 ms/prompt on one machine while the ratio
 * held. Report the RATIO RANGE.
 */
export function summarizeCost(samples) {
  const ratios = samples.map((s) => s.wide / s.narrow);
  return {
    passes: samples.length,
    narrow: samples.map((s) => s.narrow),
    wide: samples.map((s) => s.wide),
    ratioMin: Math.min(...ratios),
    ratioMax: Math.max(...ratios),
  };
}

/**
 * selectWithTokenBudget only reads — but it is imported from a module that also owns
 * the CLAUDE.md cleanup path, and "it only reads today" is the kind of premise that
 * quietly stops being true. Proven, not promised.
 */
export function assertCannotWrite(db) {
  let wrote = false;
  try {
    db.prepare(
      'UPDATE observations SET injection_count = COALESCE(injection_count, 0) + 1 WHERE id = -1',
    ).run();
    wrote = true;
  } catch {
    /* expected: SQLITE_READONLY */
  }
  if (wrote) throw new Error('SELF-CHECK FAILED: the database handle accepted a write. Refusing to run.');
}

/** Projects with enough rows for the pool bound to be capable of biting. */
export function loadProjects(db, minRows) {
  return db
    .prepare(
      `
    SELECT project, COUNT(*) AS n FROM observations
    WHERE ${liveObsFilterSql('')}
    GROUP BY project HAVING n >= ? ORDER BY n DESC
  `,
    )
    .all(minRows);
}

/**
 * How large the candidate pool WOULD be with no LIMIT at all — D#192's Probe A,
 * re-derived here rather than quoted. The WHERE is a literal transcription of the
 * shipped one, and `computeAdaptiveWindows` is imported from the shipped module rather
 * than reimplemented, so the windows cannot drift from production.
 */
export function poolSizes(db, project, computeAdaptiveWindows) {
  const now = Date.now();
  const w = computeAdaptiveWindows(db, project);
  const obs = db
    .prepare(
      `
    SELECT COUNT(*) AS c FROM observations
    WHERE project = ? AND ${liveObsFilterSql('')} AND ${notLowSignalTitleClause('')}
      AND ((created_at_epoch > ? AND importance >= 1)
        OR (created_at_epoch > ? AND importance >= 2)
        OR (created_at_epoch > ? AND importance >= 3))
  `,
    )
    .get(project, now - w.tier1, now - w.tier2, now - w.tier3).c;
  const sess = db
    .prepare(
      `
    SELECT COUNT(*) AS c FROM session_summaries
    WHERE project = ? AND created_at_epoch > ?
  `,
    )
    .get(project, now - w.sessWindow).c;
  return { obs, sess };
}

/**
 * Replay both arms over every project.
 *
 * `displaced` is NOT gated to zero — see the header. It is reported because the three
 * non-monotone stages make it a real cost of widening, and a ruler that hid it would be
 * arguing for the change rather than pricing it.
 */
export function compare(db, projects, narrow, wide, budget) {
  let n = 0,
    threw = 0,
    changedObs = 0,
    changedBlock = 0,
    top1 = 0;
  let gained = 0,
    displaced = 0,
    sessGained = 0,
    sessDisplaced = 0;
  const rows = [];
  for (const { project } of projects) {
    let a, b;
    try {
      a = narrow(db, project, budget);
      b = wide(db, project, budget);
    } catch {
      threw++;
      continue;
    }
    n++;
    const ai = a.observations.map((o) => o.id),
      bi = b.observations.map((o) => o.id);
    // Summaries are INJECTED CONTENT too. A first version of this function scored only
    // `observations`, and the sess-only arm therefore printed "selection differs 0/11"
    // over a block that had grown by 1051 tokens of session summaries — a headline that
    // says "this change does nothing" about a change that more than doubles what
    // SessionStart emits. Both halves are counted, and the obs-only figure is kept
    // beside the block figure rather than replaced by it.
    const as = a.summaries.map((s) => s.id),
      bs = b.summaries.map((s) => s.id);
    const g = bi.filter((x) => !ai.includes(x)).length;
    const d = ai.filter((x) => !bi.includes(x)).length;
    gained += g;
    displaced += d;
    sessGained += bs.filter((x) => !as.includes(x)).length;
    sessDisplaced += as.filter((x) => !bs.includes(x)).length;
    const obsDiff = JSON.stringify(ai) !== JSON.stringify(bi);
    const sessDiff = JSON.stringify(as) !== JSON.stringify(bs);
    if (obsDiff) changedObs++;
    if (obsDiff || sessDiff) changedBlock++;
    if (ai[0] !== bi[0]) top1++;
    rows.push({
      project,
      narrowN: ai.length,
      wideN: bi.length,
      gained: g,
      displaced: d,
      narrowTokens: a.totalTokens,
      wideTokens: b.totalTokens,
      sessNarrow: as.length,
      sessWide: bs.length,
      changed: obsDiff || sessDiff,
    });
  }
  return {
    n,
    threw,
    changedObs,
    changedBlock,
    changed: changedBlock,
    top1,
    gained,
    displaced,
    sessGained,
    sessDisplaced,
    rows,
  };
}

/**
 * The ruler must be able to say NO: shipped compared against itself must report no
 * difference, or the replay is not deterministic and no delta it prints is
 * attributable to the pools.
 */
export function assertRulerCanSayNo(db, projects, wide, budget) {
  const { changed } = compare(db, projects, wide, wide, budget);
  if (changed !== 0) {
    throw new Error(
      `SELF-CHECK FAILED: shipped-vs-shipped reported ${changed} projects with a ` +
        'different selection. The replay is not deterministic. Refusing to report.',
    );
  }
}

/**
 * The ruler must also be able to say YES to the thing it is least likely to want to
 * see. `displaced` is the number that argues AGAINST widening; a counter that can only
 * ever print 0 would make the change look free. Driven with synthetic arms whose
 * selections genuinely differ, and required to be non-zero.
 */
// `cmp` is injectable ONLY so the guard's own failure path can be driven from a test.
// Without it the guard is unfalsifiable in-process: gutting its throw left the whole
// suite green (mutation M5), the same asymmetry its sibling assertRulerCanSayNo does
// not have — that one is pinned by a deliberately non-deterministic arm.
export function assertCanSeeDisplacement(cmp = compare) {
  const fake = (ids) => () => ({ observations: ids.map((id) => ({ id })), summaries: [], totalTokens: 0 });
  const r = cmp(null, [{ project: 'p' }], fake([1, 2]), fake([2, 3]), 0);
  if (r.displaced !== 1 || r.gained !== 1) {
    throw new Error(
      `SELF-CHECK FAILED: displacement counter reported gained=${r.gained} ` +
        `displaced=${r.displaced} on a case constructed to be 1/1. The number that would ` +
        'argue against widening cannot be trusted to appear.',
    );
  }
}

/**
 * The INERT notice is an annotation, and an annotation nothing can falsify is worse than
 * none. Mutating `largestObsPool` to return 0 made every run print "both bounds are at or
 * above the largest pool (0)" directly above a report showing 2 of 11 projects changing —
 * a guard added to stop null results being misread, itself lying in the one direction that
 * hides a real result. The whole suite stayed green, because `maxPool`'s wiring is not
 * reachable from a unit test. So the contradiction is checked at runtime instead.
 */
export function assertInertConsistent(notice, changedObs) {
  if (notice && changedObs > 0) {
    throw new Error(
      `SELF-CHECK FAILED: printed an INERT notice ("${notice}") and then found ` +
        `${changedObs} projects whose observation selection differs. Both cannot be true; the ` +
        'pool-size input to that notice is wrong. Refusing to report.',
    );
  }
}

/**
 * The trace backing --why-displaced must account for every candidate exactly once: the
 * selection loop either hits one of the three `continue`s or reaches the commit. A missing
 * or duplicated record would make a drop reason vanish or double-count, and that mode's
 * whole output is drop reasons.
 */
const TRACE_LABELS = new Set([...DROP_POINTS.map(([, l]) => l), 'SELECTED']);

export function assertTraceWellFormed(trace, where = 'trace') {
  if (!Array.isArray(trace) || trace.length === 0) {
    throw new Error(
      `SELF-CHECK FAILED: ${where} produced no records. The instrumentation did ` +
        'not run, so every drop reason below would be "not-in-pool" by default.',
    );
  }
  const seen = new Set();
  for (const [kind, id, label] of trace) {
    if (!TRACE_LABELS.has(label)) throw new Error(`SELF-CHECK FAILED: ${where} unknown label "${label}".`);
    const key = `${kind}:${id}`;
    if (seen.has(key)) {
      throw new Error(
        `SELF-CHECK FAILED: ${where} recorded ${key} twice. A candidate resolves ` +
          'through exactly one gate; a duplicate means the loop was re-entered or an anchor ' +
          'was patched into a path that runs more than once.',
      );
    }
    seen.add(key);
  }
  return seen.size;
}

export function runSelfChecks(db, projects, wide, budget) {
  assertCanSeeDisplacement();
  assertRulerCanSayNo(db, projects, wide, budget);
}

async function main() {
  const wideObs = Number(arg('--wide-obs', String(DEFAULT_WIDE_OBS)));
  const wideSess = Number(arg('--wide-sess', String(DEFAULT_WIDE_SESS)));
  const minRows = Number(arg('--min-rows', String(DEFAULT_MIN_ROWS)));
  const budget = Number(arg('--budget', '2000'));
  const asJson = has('--json');

  // A non-numeric bound writes `const KEYCTX_POOL_OBS = NaN;`, `LIMIT NaN` returns no
  // rows, and the run then prints a complete report in which one arm selected nothing —
  // a number that looks like a finding and is garbage. Same hole rerank-pool-replay had.
  for (const [flag, v] of [
    ['--wide-obs', wideObs],
    ['--wide-sess', wideSess],
    ['--min-rows', minRows],
    ['--budget', budget],
  ]) {
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`${flag} must be a positive integer, got "${arg(flag)}". Refusing to run.`);
    }
  }

  const db = new Database(process.env.CLAUDE_MEM_DB_PATH || join(DB_DIR, 'claude-mem-lite.db'), {
    readonly: true,
  });
  assertCannotWrite(db);

  const shipped = writeTwin(wideObs, wideSess);
  let narrow, wide, computeAdaptiveWindows;
  try {
    ({ selectWithTokenBudget: narrow, computeAdaptiveWindows } = await import(SHIPPED_URL.href));
    ({ selectWithTokenBudget: wide } = await import(`${TWIN_URL.href}?v=${Date.now()}`));
  } finally {
    try {
      unlinkSync(TWIN_URL);
    } catch {
      /* already gone */
    }
  }

  const projects = loadProjects(db, minRows);
  const maxPool = largestObsPool(db, projects, computeAdaptiveWindows);
  // A zero here would make inertNotice fire on every run, including runs that then report a
  // real difference. Cheap, and it is the input a unit test cannot reach.
  if (projects.length > 0 && maxPool <= 0) {
    throw new Error(
      `SELF-CHECK FAILED: ${projects.length} projects cleared the ${minRows}-row ` +
        'floor but the largest candidate pool measured 0. poolSizes disagrees with loadProjects.',
    );
  }

  if (has('--population')) {
    // Truncation is only meaningful against a STATED bound. Defaulting it to shipped made
    // the figure that justified v3.87.0 (3/11 against 50) unreproducible from this tool the
    // moment shipped became 200 — the reference has to be a parameter.
    const refObs = Number(arg('--ref-obs', String(shipped.obs)));
    const refSess = Number(arg('--ref-sess', String(shipped.sess)));
    for (const [flag, v] of [
      ['--ref-obs', refObs],
      ['--ref-sess', refSess],
    ]) {
      if (!Number.isInteger(v) || v < 1) throw new Error(`${flag} must be a positive integer.`);
    }
    const out = projects.map(({ project, n }) => ({
      project,
      live: n,
      ...poolSizes(db, project, computeAdaptiveWindows),
    }));
    if (asJson) {
      console.log(JSON.stringify({ refObs, refSess, maxPool, rows: out }, null, 2));
      return;
    }
    const ref =
      refObs === shipped.obs && refSess === shipped.sess
        ? `shipped LIMITs ${shipped.obs}/${shipped.sess}`
        : `reference bounds ${refObs}/${refSess} (shipped is ${shipped.obs}/${shipped.sess})`;
    console.log(`\n─── Key Context pool population (${ref}) ───`);
    console.log('  project                     live   obsPool  sessPool   truncated');
    for (const r of out) {
      const t =
        [r.obs > refObs ? 'obs' : null, r.sess > refSess ? 'sess' : null].filter(Boolean).join('+') || '—';
      console.log(
        `  ${r.project.padEnd(26)}${String(r.live).padStart(5)}${String(r.obs).padStart(10)}${String(r.sess).padStart(10)}   ${t}`,
      );
    }
    const to = out.filter((r) => r.obs > refObs).length;
    const ts = out.filter((r) => r.sess > refSess).length;
    console.log(`\n  obsPool  truncated by LIMIT ${refObs}:  ${to}/${out.length} projects`);
    console.log(`  sessPool truncated by LIMIT ${refSess}:  ${ts}/${out.length} projects`);
    console.log(`  largest obsPool: ${maxPool} — any bound at or above it selects the whole pool.`);
    return;
  }

  if (has('--why-displaced')) {
    const project = arg('--project', projects[0]?.project);
    const src = readFileSync(SHIPPED_URL, 'utf8');
    const arms = {};
    for (const [label, limit] of [
      ['narrow', shipped.obs],
      ['wide', wideObs],
    ]) {
      const patched = patchDropPoints(patchConst(src, 'KEYCTX_POOL_OBS', limit).out);
      const url = pathToFileURL(join(REPO_ROOT, `.tmp-keyctx-why-${limit}.mjs`));
      writeFileSync(url, patched);
      try {
        const m = await import(`${url.href}?v=${Date.now()}`);
        globalThis.__KEYCTX_TRACE = [];
        arms[label] = { sel: m.selectWithTokenBudget(db, project, budget), trace: globalThis.__KEYCTX_TRACE };
      } finally {
        try {
          unlinkSync(url);
        } catch {
          /* gone */
        }
      }
    }
    // Label by BOUND, never by "narrow"/"wide" prose. The documented way to re-derive the
    // pre-v3.87.0 baseline is `--wide-obs 50`, i.e. the twin is the NARROWER arm — and a
    // first version of this mode hard-coded headings assuming the opposite, so every line
    // contradicted its own data column (a row marked "unreachable at the narrower bound"
    // printed `typecap`, which means it was in the pool and a gate dropped it).
    for (const [k, set] of [
      ['narrow', arms.narrow],
      ['wide', arms.wide],
    ]) {
      assertTraceWellFormed(set.trace, `${k} arm`);
    }
    const loBound = Math.min(shipped.obs, wideObs),
      hiBound = Math.max(shipped.obs, wideObs);
    const loArm = shipped.obs <= wideObs ? arms.narrow : arms.wide;
    const hiArm = shipped.obs <= wideObs ? arms.wide : arms.narrow;
    const loIds = loArm.sel.observations.map((o) => o.id);
    const hiIds = hiArm.sel.observations.map((o) => o.id);
    const why = (trace, id) => (trace.find((t) => t[0] === 'obs' && t[1] === id) || [, , 'not-in-pool'])[2];
    const info = db.prepare(
      'SELECT id, type, importance, title, lesson_learned IS NOT NULL AS les FROM observations WHERE id = ?',
    );
    const stamp = new Date().toISOString();
    const rows = (ids) =>
      ids.map((id) => {
        const o = info.get(id);
        return {
          id,
          type: o?.type,
          importance: o?.importance,
          lesson: !!o?.les,
          [`at${loBound}`]: why(loArm.trace, id),
          [`at${hiBound}`]: why(hiArm.trace, id),
          title: o?.title,
        };
      });
    const gained = rows(hiIds.filter((x) => !loIds.includes(x)));
    const displaced = rows(loIds.filter((x) => !hiIds.includes(x)));
    const notice = inertNotice(shipped.obs, wideObs, maxPool);
    if (asJson) {
      console.log(
        JSON.stringify(
          { project, stamp, shipped, wideObs, loBound, hiBound, notice, gained, displaced },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`\n─── Why rows moved: ${project}, obs ${loBound} vs ${hiBound}, budget ${budget} ───`);
    console.log(`  measured ${stamp}   (shipped is ${shipped.obs}; twin is ${wideObs})`);
    // This is the only mode whose output IS a row list, so an empty one reads hardest as
    // "nothing moves" — it needs the notice more than the modes that already had it.
    if (notice) console.log(`\n  !! ${notice}`);
    for (const [label, set] of [
      [`ONLY IN THE ${hiBound}-ARM — unreachable under LIMIT ${loBound}`, gained],
      [
        `ONLY IN THE ${loBound}-ARM — kept at ${loBound}, dropped once the pool widened to ${hiBound}`,
        displaced,
      ],
    ]) {
      console.log(`\n  ${label} — ${set.length}:`);
      for (const r of set) {
        console.log(
          `    #${r.id} imp=${r.importance} type=${String(r.type).padEnd(9)} lesson=${r.lesson ? 'y' : 'n'}` +
            `  at${loBound}=${String(r[`at${loBound}`]).padEnd(12)} at${hiBound}=${r[`at${hiBound}`]}`,
        );
        console.log(`        "${String(r.title || '').slice(0, 86)}"`);
      }
    }
    console.log('\n  The pool admits importance>=2 only inside tier2 against importance>=3 inside');
    console.log('  tier3, so a single 3->2 demotion removes a row from the POPULATION rather than');
    console.log('  down-ranking it. applyCitationDecay used to rewrite that column at every Stop');
    console.log('  hook and no longer does (D#179/D#198), so the population is far steadier than');
    console.log('  it was — but this list is still an INSTANT, not a property: the selector reads');
    console.log('  Date.now() and weights every candidate by recency, and rows keep arriving.');
    return;
  }

  if (has('--cost')) {
    const iters = Number(arg('--iters', '200'));
    if (!Number.isInteger(iters) || iters < 1) throw new Error('--iters must be a positive integer.');
    const project = arg('--project', projects[0]?.project);
    const notice = inertNotice(shipped.obs, wideObs, maxPool);
    const time = (fn) => {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < iters; i++) fn(db, project, budget);
      return Number(process.hrtime.bigint() - t0) / 1e6 / iters;
    };
    // ALWAYS price the WIDER bound against the narrower one, whichever arm each happens to
    // be. The only non-inert way to run this mode is `--wide-obs 50`, where the twin is the
    // narrower side; a first version reported cost(twin)/cost(shipped) and therefore printed
    // 0.42x for a widening that costs ~2.4x — and `hook-context.mjs` says "re-derive with
    // --cost", so a reader following the instruction would have concluded it got faster.
    const loBound = Math.min(shipped.obs, wideObs),
      hiBound = Math.max(shipped.obs, wideObs);
    const loFn = shipped.obs <= wideObs ? narrow : wide;
    const hiFn = shipped.obs <= wideObs ? wide : narrow;
    time(loFn);
    time(hiFn); // warm
    const samples = [];
    for (const order of [
      ['narrow', 'wide'],
      ['wide', 'narrow'],
    ]) {
      const s = {};
      for (const k of order) s[k] = time(k === 'narrow' ? loFn : hiFn);
      samples.push(s);
    }
    // Determinism still has to hold in the mode that produces the most contested number —
    // v3.85.1's sibling defect was a --cost path that returned above its self-checks.
    runSelfChecks(db, projects, wide, budget);
    const sum = summarizeCost(samples);
    if (asJson) {
      console.log(JSON.stringify({ project, iters, loBound, hiBound, ...sum, notice }, null, 2));
      return;
    }
    console.log(`\n─── Key Context selection cost: ${project}, obs ${loBound} vs ${hiBound} ───`);
    console.log(`  ${iters} iterations/arm, ${sum.passes} passes with the arm order reversed, one process`);
    if (notice)
      console.log(
        `\n  ${notice.replace('Any "0 newly reachable" below is arithmetic, not a measurement.', 'The two arms are the same code path, so expect a ratio near 1.00x.')}`,
      );
    console.log(
      `\n  LIMIT ${String(loBound).padEnd(4)} ${sum.narrow.map((x) => x.toFixed(3)).join(' , ')} ms/call`,
    );
    console.log(
      `  LIMIT ${String(hiBound).padEnd(4)} ${sum.wide.map((x) => x.toFixed(3)).join(' , ')} ms/call`,
    );
    console.log(
      `  RATIO RANGE (cost of widening ${loBound} -> ${hiBound}): ${sum.ratioMin.toFixed(2)}x - ${sum.ratioMax.toFixed(2)}x`,
    );
    console.log("\n  QUOTE THE RATIO RANGE, NEVER THE ABSOLUTE ms. The sibling ruler's six runs on one");
    console.log('  machine spread 3.04 -> 1.80 ms/prompt while its ratio held; a reviewer re-measuring');
    console.log('  this face read both arms ~2.6x higher than its author did, with the ratio intact.');
    return;
  }

  runSelfChecks(db, projects, wide, budget);
  const inert = inertNotice(shipped.obs, wideObs, maxPool);
  if (inert) console.log(`\n  !! ${inert}`);
  const r = compare(db, projects, narrow, wide, budget);
  // Assert against THIS run's result, not a second compare() — the pools slide, so two
  // calls are two populations and a contradiction check across them proves nothing.
  assertInertConsistent(inert, r.changedObs);

  if (asJson) {
    console.log(JSON.stringify({ ...r, shipped, wideObs, wideSess, budget }, null, 2));
    return;
  }
  console.log(
    `\n─── Key Context pool replay: shipped ${shipped.obs}/${shipped.sess} vs ${wideObs}/${wideSess} (budget ${budget}) ───`,
  );
  console.log(`  projects replayed:       ${r.n}${r.threw ? `  (${r.threw} threw)` : ''}`);
  console.log(`  INJECTED BLOCK differs:  ${r.changedBlock}/${r.n}   (observations or summaries)`);
  console.log(`  observation set differs: ${r.changedObs}/${r.n}`);
  console.log(`  first observation differs: ${r.top1}/${r.n}`);
  console.log(`  obs newly reachable:     ${r.gained}    displaced: ${r.displaced}`);
  console.log(`  sess newly reachable:    ${r.sessGained}    displaced: ${r.sessDisplaced}`);
  console.log('\n  project                     obs n->n   +new  -lost   tokens n->n   sess n->n');
  for (const x of r.rows) {
    console.log(
      `  ${x.project.padEnd(26)}${String(x.narrowN).padStart(4)}->${String(x.wideN).padEnd(4)}` +
        `${String(x.gained).padStart(6)}${String(x.displaced).padStart(7)}` +
        `${String(x.narrowTokens).padStart(9)}->${String(x.wideTokens).padEnd(6)}` +
        `${String(x.sessNarrow).padStart(6)}->${x.sessWide}`,
    );
  }
  console.log(`\n  SNAPSHOT — measured ${new Date().toISOString()}. selectWithTokenBudget reads`);
  console.log('  Date.now() for its adaptive windows, so these pools SLIDE and decay with the');
  console.log('  wall clock even while the store grows — every ABSOLUTE above drifts, downward');
  console.log('  as often as up. Both arms ran in one process against one database, so the');
  console.log('  DIRECTION and the sign of the cost are what survives. Quote those; stamp any');
  console.log('  absolute you must quote with the timestamp above.');
  console.log('\n  `displaced` is REAL, not an artefact: the token budget and the 3-per-type');
  console.log('  diversity cap both make selection non-monotone, so a wider pool can evict a');
  console.log('  row a narrower one kept. Weigh both columns. (A third stage was listed here');
  console.log('  until D#197 showed the file-overlap penalty could never fire and deleted it.)');
  console.log('  n is the PROJECT COUNT — read the table, not a percentage over a dozen rows.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
