// benchmark/patha-exclude-report.mjs — the reader for D#216's meter.
//
// `lib/patha-exclude-meter.mjs` shipped with no consumer: nothing under mem-cli, lib,
// benchmark or scripts filtered on the `patha_exclude` event, so `aggregateMetrics`
// showed `n=…` with no latency and every column had to be unpicked from raw JSONL by
// hand (the defer's NICE-11). Rows were already accumulating. This closes that half —
// it does not decide D#216, it makes D#216 decidable.
//
// WHAT THIS IS NOT. It is not a replay and it takes no measurement of its own: the two
// arms ran at the read, in one process against one database state, and this file only
// reads what they wrote. Every caliber question was settled there; the only ones left
// here are about how rows are POOLED, and there are three, each of which would otherwise
// produce a number that looks measured and is not:
//
//   1. THE SCHEMA CHANGED MID-STREAM. Rows written before the pre-tag B5 fix carry no
//      `markerCoercibleStrings` key, and their `inert` was computed on the rule that
//      version got wrong ("any string in the marker"), which counts a `P`/`D`/`E`-only
//      marker — a prompt with nothing excludable — as an inert exclude. Those rows are
//      not comparable with post-fix ones and cannot be recomputed, because the marker
//      ids themselves are not in the row. They get their own bucket and leave the
//      regime denominator. Detected on the ABSENCE of the key, not on any value.
//
//   2. `armB: 'error'` ROWS CARRY NO `net` AND NO `setChanged`. The meter leaves them
//      undefined on purpose, so that a failed arm cannot be read as "the repair changed
//      nothing" — a failure mode this repo has shipped. A reader that `?? 0`s them puts
//      the defect back. Only `armB === 'ok'` rows enter the measured population here.
//
//   3. A ZERO IN `suppressed` IS A FACT ABOUT THE SAMPLE. The defect's population is
//      prompts whose exclude was inert; on a corpus where that never happened, zero
//      suppression is not evidence the repair is harmless — it is evidence nothing was
//      observed. That is the `NO-POPULATION` verdict, kept distinct from `DECIDABLE`.
//
// WHICH COLUMN DECIDES. `refilled`, not `suppressed`. The ledger's open question is
// whether a slot freed by a working exclude gets refilled from the pool or is simply
// lost; a suppression count alone cannot answer it, and `net` alone cannot either
// (a one-for-one replacement is net zero while the delivered SET moved).
//
// This file reads no repo source as text, so it needs no path construction of its own —
// but the D#207 rule still applies to anything added later: build paths with join(), never
// `new URL('../X.mjs', import.meta.url)`, which drops the named module out of knip's
// unused-export report entirely.
import { pathToFileURL } from 'node:url';

import { readMetrics, DEFAULT_WINDOW_DAYS } from '../lib/metrics.mjs';
import { PATHA_EXCLUDE_EVENT } from '../lib/patha-exclude-meter.mjs';
import { DB_DIR } from '../schema.mjs';

export { PATHA_EXCLUDE_EVENT };

/**
 * Which marker regime a row was taken in.
 *
 * `legacy` is decided by the missing key, and the other three by the COUNTS rather than
 * by the row's own `inert` boolean — a reader that trusts the boolean inherits whatever
 * rule the writer held at the time, which is the exact thing that changed under it.
 *
 *   legacy             pre-B5 row; `inert` computed on the superseded rule
 *   inert              ≥1 id that could have been excluded arrived as a string
 *   working            the marker had excludable ids and all arrived as numbers
 *   nothing-excludable the marker held no observation id at all (P/D/E only, or empty)
 *
 * @param {object} row
 * @returns {'legacy'|'inert'|'working'|'nothing-excludable'}
 */
export function classifyMarkerRegime(row) {
  if (!row || typeof row.markerCoercibleStrings !== 'number') return 'legacy';
  if (row.markerCoercibleStrings > 0) return 'inert';
  if ((row.markerCoercible || 0) > 0) return 'working';
  return 'nothing-excludable';
}

/**
 * Pool rows into the columns D#216 turns on.
 *
 * `refillRatio` is rows-refilled over rows-freed and is NULL when nothing was freed —
 * a ratio over an empty denominator is the shape that gets quoted as "0% refilled".
 *
 * @param {object[]} rows
 * @returns {object}
 */
export function aggregatePathAExclude(rows) {
  const agg = {
    total: 0,
    legacy: 0,
    regimeTotal: 0,
    regime: { inert: 0, working: 0, 'nothing-excludable': 0 },
    armB: { ok: 0, skipped: 0, error: 0 },
    armBErrors: [],
    okPrompts: 0,
    setChangedPrompts: 0,
    suppressedPrompts: 0,
    suppressedRows: 0,
    refilledPrompts: 0,
    refilledRows: 0,
    pureLossPrompts: 0,
    netRows: 0,
    emittedRows: 0,
    refillRatio: null,
    imperative: { off: 0, on: 0, gateOpen: 0, changed: 0 },
    firstTs: null,
    lastTs: null,
    verdict: 'SKIP',
  };

  for (const row of rows || []) {
    agg.total++;
    if (row.ts) {
      if (!agg.firstTs || row.ts < agg.firstTs) agg.firstTs = row.ts;
      if (!agg.lastTs || row.ts > agg.lastTs) agg.lastTs = row.ts;
    }

    const regime = classifyMarkerRegime(row);
    if (regime === 'legacy') agg.legacy++;
    else { agg.regimeTotal++; agg.regime[regime]++; }

    if (row.imperativeArm === 'on') {
      agg.imperative.on++;
      // `on` with a null pick means the flag was set but the gate never selected
      // anything. Counting only `on` would read as a measured comparison where there
      // was nothing to compare — the same "did it fire" question `armB` answers.
      if (row.imperativeBefore !== null && row.imperativeBefore !== undefined) agg.imperative.gateOpen++;
      if (row.imperativeChanged) agg.imperative.changed++;
    } else {
      agg.imperative.off++;
    }

    if (row.armB === 'ok') {
      agg.armB.ok++;
    } else if (row.armB === 'error') {
      agg.armB.error++;
      if (row.armBError) agg.armBErrors.push(String(row.armBError));
      // Deliberately falls through to nothing: no `net`, no `setChanged`, no denominator.
      continue;
    } else {
      agg.armB.skipped++;
      continue;
    }

    // Measured population = arm-B-ok rows only.
    agg.okPrompts++;
    agg.emittedRows += row.emitted || 0;
    if (row.setChanged) agg.setChangedPrompts++;
    const suppressed = row.suppressed || 0;
    const refilled = row.refilled || 0;
    agg.suppressedRows += suppressed;
    agg.refilledRows += refilled;
    if (suppressed > 0) agg.suppressedPrompts++;
    if (refilled > 0) agg.refilledPrompts++;
    if (suppressed > 0 && refilled === 0) agg.pureLossPrompts++;
    agg.netRows += row.net || 0;
  }

  if (agg.suppressedRows > 0) {
    agg.refillRatio = agg.refilledRows / agg.suppressedRows;
    agg.verdict = 'DECIDABLE';
  } else if (agg.total > 0) {
    agg.verdict = 'NO-POPULATION';
  }
  return agg;
}

const pct = (n, d) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : '—');

/**
 * Human-readable report. `metricsEnabled` is passed in rather than read from the env so
 * an empty corpus can say WHICH empty it is: the sink switched off, or switched on and
 * nothing recorded yet. Those call for different next actions.
 * @param {object} agg
 * @param {{days?:number, metricsEnabled?:boolean}} [o]
 * @returns {string}
 */
export function formatPathAReport(agg, { days = DEFAULT_WINDOW_DAYS, metricsEnabled = false } = {}) {
  const L = [];
  L.push(`patha_exclude — D#216 reader · last ${days}d · verdict ${agg.verdict}`);

  if (agg.total === 0) {
    if (!metricsEnabled) {
      L.push('  SKIP: no rows, and CLAUDE_MEM_METRICS is not 1 — the meter never ran.');
      L.push('  Set CLAUDE_MEM_METRICS=1 and let UserPromptSubmit run for a few weeks.');
    } else {
      L.push('  SKIP: metering is on but no patha_exclude row landed in this window.');
      L.push('  The meter only fires when the cross-hook marker actually carried ids.');
    }
    return L.join('\n');
  }

  const span = agg.firstTs && agg.lastTs ? `${agg.firstTs.slice(0, 16)}Z → ${agg.lastTs.slice(0, 16)}Z` : '—';
  L.push(`  rows ${agg.total} · ${span}`);
  if (agg.legacy > 0) {
    L.push(`  legacy (pre-B5 schema, no markerCoercibleStrings): ${agg.legacy} — excluded from the regime split;`);
    L.push('    their `inert` was computed on the superseded rule and cannot be recomputed from the row.');
  }

  L.push('');
  L.push(`  Marker regime (n=${agg.regimeTotal}):`);
  L.push(`    inert  (a coercible id arrived as a string — the defect)   ${String(agg.regime.inert).padStart(5)}  ${pct(agg.regime.inert, agg.regimeTotal)}`);
  L.push(`    working (excludable ids, all numeric — exclude worked)     ${String(agg.regime.working).padStart(5)}  ${pct(agg.regime.working, agg.regimeTotal)}`);
  L.push(`    nothing-excludable (P/D/E only, or empty)                  ${String(agg.regime['nothing-excludable']).padStart(5)}  ${pct(agg.regime['nothing-excludable'], agg.regimeTotal)}`);

  L.push('');
  L.push(`  Arm B: ok ${agg.armB.ok} · skipped ${agg.armB.skipped} · error ${agg.armB.error}`);
  if (agg.armB.error > 0) {
    L.push('    error rows carry no net/setChanged by design and are OUT of the population below.');
    for (const e of agg.armBErrors.slice(0, 3)) L.push(`      ${e}`);
  }

  L.push('');
  L.push(`  Measured population (arm-B-ok prompts): ${agg.okPrompts} · delivered by arm A: ${agg.emittedRows} rows`);
  L.push(`    set changed        ${String(agg.setChangedPrompts).padStart(5)}  ${pct(agg.setChangedPrompts, agg.okPrompts)} of prompts`);
  L.push(`    rows freed         ${String(agg.suppressedRows).padStart(5)}  over ${agg.suppressedPrompts} prompt(s)`);
  L.push(`    rows refilled      ${String(agg.refilledRows).padStart(5)}  over ${agg.refilledPrompts} prompt(s)`);
  L.push(`    net delivered      ${(agg.netRows >= 0 ? '+' : '') + agg.netRows}`);

  L.push('');
  if (agg.verdict === 'DECIDABLE') {
    L.push('  DECISION COLUMN (D#216) — a freed slot is either refilled from the pool or lost:');
    L.push(`    refilled / freed   ${agg.refilledRows} / ${agg.suppressedRows}  = ${pct(agg.refilledRows, agg.suppressedRows)}`);
    L.push(`    pure loss          ${agg.pureLossPrompts} prompt(s) freed a slot and got nothing back`);
  } else {
    L.push('  NO-POPULATION: nothing was ever freed, so there is no refill ratio to quote.');
    L.push(`    This is a statement about the sample, not about the repair: ${agg.regime.inert} of ${agg.regimeTotal}`);
    L.push('    prompts were in the inert regime at all, and a working exclude can only drop a row');
    L.push('    that was both in the marker and in what arm A delivered.');
  }

  L.push('');
  const imp = agg.imperative;
  L.push(`  task_imperative face: arm on ${imp.on} / off ${imp.off} · gate opened ${imp.gateOpen} · pick changed ${imp.changed}`);
  if (imp.on > 0 && imp.gateOpen === 0) {
    L.push('    the flag was on but the gate never selected a lesson — no comparison was made.');
  }
  return L.join('\n');
}

/**
 * All `patha_exclude` rows in the window. Reuses `readMetrics` rather than re-walking
 * the shards: a second JSONL parser is a twin, and twins here drift.
 * @param {string} dbDir
 * @param {number} [days]
 * @returns {object[]}
 */
export function readPathARows(dbDir, days = DEFAULT_WINDOW_DAYS) {
  const out = [];
  for (const row of readMetrics(dbDir, days)) {
    if (row && row.event === PATHA_EXCLUDE_EVENT) out.push(row);
  }
  return out;
}

/**
 * Self-check: the aggregator must be able to REPORT suppression and refill. On this
 * machine's corpus every row has `suppressed: 0`, so an aggregator that silently
 * dropped those columns would look exactly like the real one — the `NO-POPULATION`
 * verdict would read as a finding rather than as a bug. Driven with synthetic rows.
 * @param {(rows:object[])=>object} aggregate
 */
export function assertCanSeeSuppression(aggregate) {
  const probe = aggregate([{
    event: PATHA_EXCLUDE_EVENT, markerTotal: 2, markerStrings: 2, markerNumbers: 0,
    markerCoercible: 2, markerCoercibleStrings: 2, inert: true,
    emitted: 3, suppressed: 2, suppressedIds: [11, 12],
    imperativeArm: 'off',
    armB: 'ok', delivered: 2, refilled: 1, refilledIds: [13], net: -1, setChanged: true,
  }]);
  if (probe.suppressedRows !== 2 || probe.refilledRows !== 1) {
    throw new Error(`self-check failed: aggregator cannot see suppression (got suppressedRows=${probe.suppressedRows}, refilledRows=${probe.refilledRows}, want 2/1)`);
  }
  if (probe.verdict !== 'DECIDABLE' || probe.refillRatio === null) {
    throw new Error(`self-check failed: suppression present but verdict=${probe.verdict}, refillRatio=${probe.refillRatio}`);
  }
}

/**
 * Self-check: an `armB: 'error'` row must not enter the measured population. The meter
 * omits `net`/`setChanged` on those rows precisely so a failed arm cannot read as a
 * measured zero, and that guarantee is only worth anything if the reader honours it.
 * @param {(rows:object[])=>object} aggregate
 */
export function assertErrorArmIsNotAZero(aggregate) {
  const probe = aggregate([{
    event: PATHA_EXCLUDE_EVENT, markerTotal: 1, markerStrings: 0, markerNumbers: 1,
    markerCoercible: 1, markerCoercibleStrings: 0, inert: false,
    emitted: 2, suppressed: 0, suppressedIds: [],
    imperativeArm: 'off', armB: 'error', armBError: 'probe',
  }]);
  if (probe.armB.error !== 1) {
    throw new Error(`self-check failed: error arm not counted (got ${probe.armB.error})`);
  }
  if (probe.okPrompts !== 0) {
    throw new Error(`self-check failed: an armB error row entered the measured population (okPrompts=${probe.okPrompts}, want 0)`);
  }
}

/**
 * `--days`, parsed so it cannot silently answer a different question than it was asked.
 *
 * The first version was `Math.max(1, parseInt(v, 10) || DEFAULT_WINDOW_DAYS)`. `parseInt('0')`
 * is 0, which is FALSY, so `--days 0` fell through to the default and reported a 7-day
 * window under a header that said `last 0d` — and the `Math.max(1, …)` clamp that looks
 * like it handles this was unreachable for 0, reachable only for negatives. A window
 * argument that quietly means something else is the shape this repo files under silent
 * narrowing; garbage still falls back to the default, but a NUMBER is always honoured.
 *
 * Exported because it lived inside `main()`, where nothing under tests/ can reach it —
 * the blind spot this file's own self-checks are guarded against.
 */
export function parseDaysArg(argv, fallback = DEFAULT_WINDOW_DAYS) {
  const i = argv.indexOf('--days');
  if (i === -1 || argv[i + 1] === undefined) return fallback;
  const n = parseInt(argv[i + 1], 10);
  return Number.isFinite(n) ? Math.max(1, n) : fallback;
}

function main() {
  assertCanSeeSuppression(aggregatePathAExclude);
  assertErrorArmIsNotAZero(aggregatePathAExclude);

  const days = parseDaysArg(process.argv);
  const asJson = process.argv.includes('--json');

  const rows = readPathARows(DB_DIR, days);
  const agg = aggregatePathAExclude(rows);
  if (asJson) {
    console.log(JSON.stringify({ dbDir: DB_DIR, days, ...agg }, null, 2));
  } else {
    console.log(formatPathAReport(agg, { days, metricsEnabled: process.env.CLAUDE_MEM_METRICS === '1' }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
