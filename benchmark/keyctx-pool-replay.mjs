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
// superset argument. Three stages downstream of the pool can DROP a row that a narrower
// pool would have selected:
//   • the token budget (a newly reachable, denser row consumes budget first);
//   • the type-diversity cap (max 3 per type);
//   • the file-overlap penalty (selection order changes which files are already taken).
// So `displaced` is expected to be non-zero and is reported as a first-class number
// rather than gated to zero. What IS gated: the ruler must be able to SEE displacement
// at all (a self-check drives a synthetic case and requires a non-zero count), and
// shipped-vs-shipped must report no difference.
//
// USAGE
//   node benchmark/keyctx-pool-replay.mjs                 all projects, 50/10 vs a wide twin
//   node benchmark/keyctx-pool-replay.mjs --wide-obs 200 --wide-sess 40
//   node benchmark/keyctx-pool-replay.mjs --population    pool sizes + truncation only
//   node benchmark/keyctx-pool-replay.mjs --min-rows 20   project inclusion floor
//   node benchmark/keyctx-pool-replay.mjs --json

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import Database from 'better-sqlite3';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { DB_DIR } from '../schema.mjs';
import { liveObsFilterSql } from '../lib/inject-search-core.mjs';
import { notLowSignalTitleClause } from '../utils.mjs';

const SHIPPED_URL = new URL('../hook-context.mjs', import.meta.url);
// Repo root, not benchmark/, or hook-context's own './lib/...' specifiers resolve
// against the wrong directory. Relative on purpose: tests/import-graph.test.mjs fails
// any absolute import specifier.
const TWIN_URL = new URL('../.tmp-keyctx-pool-twin.mjs', import.meta.url);

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
  const re = new RegExp(`export const ${name} = (\\d+);`);
  const m = src.match(re);
  if (!m) throw new Error(`twin patch failed: ${name} not found in hook-context.mjs (renamed?)`);
  return { out: src.replace(re, `export const ${name} = ${value};`), previous: Number(m[1]) };
}

export function writeTwin(obsLimit, sessLimit) {
  const src = readFileSync(SHIPPED_URL, 'utf8');
  const a = patchConst(src, 'KEYCTX_POOL_OBS', obsLimit);
  const b = patchConst(a.out, 'KEYCTX_POOL_SESS', sessLimit);
  if (a.previous === obsLimit && b.previous === sessLimit) {
    throw new Error(`twin is identical to shipped (${obsLimit}/${sessLimit}) — the comparison `
      + 'would report 0 differences for reasons that have nothing to do with the pools.');
  }
  writeFileSync(TWIN_URL, b.out);
  return { obs: a.previous, sess: b.previous };
}

/**
 * selectWithTokenBudget only reads — but it is imported from a module that also owns
 * the CLAUDE.md cleanup path, and "it only reads today" is the kind of premise that
 * quietly stops being true. Proven, not promised.
 */
export function assertCannotWrite(db) {
  let wrote = false;
  try {
    db.prepare('UPDATE observations SET injection_count = COALESCE(injection_count, 0) + 1 WHERE id = -1').run();
    wrote = true;
  } catch { /* expected: SQLITE_READONLY */ }
  if (wrote) throw new Error('SELF-CHECK FAILED: the database handle accepted a write. Refusing to run.');
}

/** Projects with enough rows for the pool bound to be capable of biting. */
export function loadProjects(db, minRows) {
  return db.prepare(`
    SELECT project, COUNT(*) AS n FROM observations
    WHERE ${liveObsFilterSql('')}
    GROUP BY project HAVING n >= ? ORDER BY n DESC
  `).all(minRows);
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
  const obs = db.prepare(`
    SELECT COUNT(*) AS c FROM observations
    WHERE project = ? AND ${liveObsFilterSql('')} AND ${notLowSignalTitleClause('')}
      AND ((created_at_epoch > ? AND importance >= 1)
        OR (created_at_epoch > ? AND importance >= 2)
        OR (created_at_epoch > ? AND importance >= 3))
  `).get(project, now - w.tier1, now - w.tier2, now - w.tier3).c;
  const sess = db.prepare(`
    SELECT COUNT(*) AS c FROM session_summaries
    WHERE project = ? AND created_at_epoch > ?
  `).get(project, now - w.sessWindow).c;
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
  let n = 0, threw = 0, changedObs = 0, changedBlock = 0, top1 = 0;
  let gained = 0, displaced = 0, sessGained = 0, sessDisplaced = 0;
  const rows = [];
  for (const { project } of projects) {
    let a, b;
    try { a = narrow(db, project, budget); b = wide(db, project, budget); } catch { threw++; continue; }
    n++;
    const ai = a.observations.map((o) => o.id), bi = b.observations.map((o) => o.id);
    // Summaries are INJECTED CONTENT too. A first version of this function scored only
    // `observations`, and the sess-only arm therefore printed "selection differs 0/11"
    // over a block that had grown by 1051 tokens of session summaries — a headline that
    // says "this change does nothing" about a change that more than doubles what
    // SessionStart emits. Both halves are counted, and the obs-only figure is kept
    // beside the block figure rather than replaced by it.
    const as = a.summaries.map((s) => s.id), bs = b.summaries.map((s) => s.id);
    const g = bi.filter((x) => !ai.includes(x)).length;
    const d = ai.filter((x) => !bi.includes(x)).length;
    gained += g; displaced += d;
    sessGained += bs.filter((x) => !as.includes(x)).length;
    sessDisplaced += as.filter((x) => !bs.includes(x)).length;
    const obsDiff = JSON.stringify(ai) !== JSON.stringify(bi);
    const sessDiff = JSON.stringify(as) !== JSON.stringify(bs);
    if (obsDiff) changedObs++;
    if (obsDiff || sessDiff) changedBlock++;
    if (ai[0] !== bi[0]) top1++;
    rows.push({
      project, narrowN: ai.length, wideN: bi.length, gained: g, displaced: d,
      narrowTokens: a.totalTokens, wideTokens: b.totalTokens,
      sessNarrow: as.length, sessWide: bs.length, changed: obsDiff || sessDiff,
    });
  }
  return { n, threw, changedObs, changedBlock, changed: changedBlock, top1, gained, displaced, sessGained, sessDisplaced, rows };
}

/**
 * The ruler must be able to say NO: shipped compared against itself must report no
 * difference, or the replay is not deterministic and no delta it prints is
 * attributable to the pools.
 */
export function assertRulerCanSayNo(db, projects, wide, budget) {
  const { changed } = compare(db, projects, wide, wide, budget);
  if (changed !== 0) {
    throw new Error(`SELF-CHECK FAILED: shipped-vs-shipped reported ${changed} projects with a `
      + 'different selection. The replay is not deterministic. Refusing to report.');
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
    throw new Error(`SELF-CHECK FAILED: displacement counter reported gained=${r.gained} `
      + `displaced=${r.displaced} on a case constructed to be 1/1. The number that would `
      + 'argue against widening cannot be trusted to appear.');
  }
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
  for (const [flag, v] of [['--wide-obs', wideObs], ['--wide-sess', wideSess],
    ['--min-rows', minRows], ['--budget', budget]]) {
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`${flag} must be a positive integer, got "${arg(flag)}". Refusing to run.`);
    }
  }

  const db = new Database(process.env.CLAUDE_MEM_DB_PATH || join(DB_DIR, 'claude-mem-lite.db'), { readonly: true });
  assertCannotWrite(db);

  const shipped = writeTwin(wideObs, wideSess);
  let narrow, wide, computeAdaptiveWindows;
  try {
    ({ selectWithTokenBudget: narrow, computeAdaptiveWindows } = await import(SHIPPED_URL.href));
    ({ selectWithTokenBudget: wide } = await import(`${TWIN_URL.href}?v=${Date.now()}`));
  } finally {
    try { unlinkSync(TWIN_URL); } catch { /* already gone */ }
  }

  const projects = loadProjects(db, minRows);

  if (has('--population')) {
    const out = projects.map(({ project, n }) => ({ project, live: n, ...poolSizes(db, project, computeAdaptiveWindows) }));
    if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }
    console.log(`\n─── Key Context pool population (shipped LIMITs ${shipped.obs}/${shipped.sess}) ───`);
    console.log('  project                     live   obsPool  sessPool   truncated');
    for (const r of out) {
      const t = [r.obs > shipped.obs ? 'obs' : null, r.sess > shipped.sess ? 'sess' : null].filter(Boolean).join('+') || '—';
      console.log(`  ${r.project.padEnd(26)}${String(r.live).padStart(5)}${String(r.obs).padStart(10)}${String(r.sess).padStart(10)}   ${t}`);
    }
    const to = out.filter((r) => r.obs > shipped.obs).length;
    const ts = out.filter((r) => r.sess > shipped.sess).length;
    console.log(`\n  obsPool  truncated by LIMIT ${shipped.obs}:  ${to}/${out.length} projects`);
    console.log(`  sessPool truncated by LIMIT ${shipped.sess}:  ${ts}/${out.length} projects`);
    return;
  }

  runSelfChecks(db, projects, wide, budget);
  const r = compare(db, projects, narrow, wide, budget);

  if (asJson) { console.log(JSON.stringify({ ...r, shipped, wideObs, wideSess, budget }, null, 2)); return; }
  console.log(`\n─── Key Context pool replay: shipped ${shipped.obs}/${shipped.sess} vs ${wideObs}/${wideSess} (budget ${budget}) ───`);
  console.log(`  projects replayed:       ${r.n}${r.threw ? `  (${r.threw} threw)` : ''}`);
  console.log(`  INJECTED BLOCK differs:  ${r.changedBlock}/${r.n}   (observations or summaries)`);
  console.log(`  observation set differs: ${r.changedObs}/${r.n}`);
  console.log(`  first observation differs: ${r.top1}/${r.n}`);
  console.log(`  obs newly reachable:     ${r.gained}    displaced: ${r.displaced}`);
  console.log(`  sess newly reachable:    ${r.sessGained}    displaced: ${r.sessDisplaced}`);
  console.log('\n  project                     obs n->n   +new  -lost   tokens n->n   sess n->n');
  for (const x of r.rows) {
    console.log(`  ${x.project.padEnd(26)}${String(x.narrowN).padStart(4)}->${String(x.wideN).padEnd(4)}`
      + `${String(x.gained).padStart(6)}${String(x.displaced).padStart(7)}`
      + `${String(x.narrowTokens).padStart(9)}->${String(x.wideTokens).padEnd(6)}`
      + `${String(x.sessNarrow).padStart(6)}->${x.sessWide}`);
  }
  console.log(`\n  SNAPSHOT — measured ${new Date().toISOString()}. selectWithTokenBudget reads`);
  console.log('  Date.now() for its adaptive windows, so these pools SLIDE and decay with the');
  console.log('  wall clock even while the store grows — every ABSOLUTE above drifts, downward');
  console.log('  as often as up. Both arms ran in one process against one database, so the');
  console.log('  DIRECTION and the sign of the cost are what survives. Quote those; stamp any');
  console.log('  absolute you must quote with the timestamp above.');
  console.log('\n  `displaced` is REAL, not an artefact: the token budget, the 3-per-type');
  console.log('  diversity cap and the file-overlap penalty all make selection non-monotone,');
  console.log('  so a wider pool can evict a row a narrower one kept. Weigh both columns.');
  console.log('  n is the PROJECT COUNT — read the table, not a percentage over a dozen rows.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
