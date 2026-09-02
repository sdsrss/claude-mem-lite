// lib/patha-exclude-meter.mjs — the ruler D#213 named as its only blocker.
//
// D#213 (which replaced D#212, which replaced D#193) is not open because the mechanism
// is unclear. The mechanism is settled by reading: `mergeCrossHookInjected` `.map(String)`s
// the whole marker union, `hook.mjs handleUserPrompt` pushes those ids into
// `pathAInjectedIds` as they arrive, and both consumers test `new Set(excludeIds).has(r.id)`
// against a NUMBER out of SQLite — so from the first PreToolUse emission in the window the
// exclude suppresses nothing. It is open because nobody can price the repair:
//
//   "reconstructing per-prompt exclude sets needs the marker file, which rotates after
//    DEDUP_STALE_MS and is never persisted"
//
// THIS MODULE DOES NOT SOLVE THAT BY PERSISTING THE MARKER. Recording `{project, session,
// ids, ts}` at write time — the route the ledger leaned toward — buys a corpus that still
// has to be replayed later, against a database that has drifted, by a harness that has to
// re-derive which rows the search would have returned. This project has a standing rule
// about exactly that shape ("never diff two runs taken at different times"), and three
// separate rulers here carry a warning earned by breaking it.
//
// So the measurement is taken WHERE AND WHEN THE READ HAPPENS, both arms in one process
// against one database state microseconds apart:
//
//   arm A (shipped)  — the exclude as it arrives: inert against every string id.
//   arm B (repaired) — the same call with the ids coerced to numbers.
//
// **ORDER AND SIDE EFFECTS ARE PART OF THE CONTRACT, and the caller owns both.** Arm B
// must run FIRST and must run with `counterfactual: true`. `searchRelevantMemories` is
// not a read: it bumps `injection_count` on every row it returns, and that column feeds
// `noisePenaltyClause`, `demotePinned`'s `injection_count >= N AND cited_count = 0`
// predicate, and the `injection_count = 0` GC gate. The first version of this module took
// a `rerun` CALLBACK, which invited the caller to run arm B wherever was convenient — and
// the convenient place, after the delivery, is the one place it is wrong. The pre-tag
// review reproduced both halves: rows never shown to anyone reached `injection_count = 1`,
// and a prompt whose honest answer was `suppressed 0 / refilled 0` reported
// `refilled: 1, setChanged: true`, purely because arm A's own bump pushed a row across the
// >= 4 noise gate before arm B scored the corpus. CLAUDE.md already carried this rule for
// `rerank-pool-replay` — this module quoted it and then broke it. `after` is therefore an
// already-computed result, not a callback: the caller owns the ordering, this file owns
// only the arithmetic.
//
// The difference between the two delivered sets is the price of the repair, per prompt,
// with no reconstruction and no drift. `refilled` is what the pool puts back into the
// freed slots — the direction the ledger calls unknown, and the reason a suppression
// count alone would not have settled anything.
//
// `suppressed` is EXACT rather than estimated. A draft justified that with "arm A's
// exclude is inert, so arm A's result IS the unexcluded search", which is unsound: arm A's
// exclude is inert only for the ids that arrive as strings, and on a marker of plain
// numbers it works. The conclusion survives on a different argument, which is the one to
// keep: an id arm A already excluded cannot appear in `emitted`, so `numeric ∩ emittedIds`
// reports the INCREMENTAL drop, which is exactly the quantity wanted. The row carries
// `markerNumbers` beside `markerStrings` so a reader can see which regime each prompt was
// in rather than having to trust this paragraph.
//
// COST AND GATING. Arm B is a second search on the UserPromptSubmit path, so it runs only
// when CLAUDE_MEM_METRICS=1 AND the marker actually carried ids. With metrics off (the
// default) nothing here executes and nothing is imported at cost — the module is pure ESM
// with no dependency beyond lib/metrics.mjs.
//
// WHAT THIS RULER CANNOT SEE, stated because a face omitted silently is how the citation
// replay shipped a wrong denominator: `task_imperative` is behind
// CLAUDE_MEM_TASK_IMPERATIVE and default OFF, so on a stock install its arm is recorded as
// `'off'` rather than dropped from the row. And this measures the `ups` face's own
// delivery only — it says nothing about whether the reader then cited what it got.

import { recordMetric } from './metrics.mjs';

/** Metric `event` name. Readers filter on this. */
export const PATHA_EXCLUDE_EVENT = 'patha_exclude';

/**
 * Mirrors lib/metrics.mjs's private `metricsEnabled`. Duplicated deliberately rather
 * than exported from there: this module must decide whether to run a SECOND SEARCH
 * before it calls recordMetric, and a sink that no-ops after the work is done would
 * make the expensive half unconditional.
 * @returns {boolean}
 */
export function pathAMeterEnabled() {
  return process.env.CLAUDE_MEM_METRICS === '1';
}

/**
 * How the marker's ids arrive, by JS type. The whole defect is a type, so the type
 * distribution is the first thing any reading of this metric needs.
 * @param {Array<number|string>} ids
 * @returns {{total:number, strings:number, numbers:number, other:number}}
 */
export function markerTypeSplit(ids) {
  const out = { total: 0, strings: 0, numbers: 0, other: 0 };
  for (const id of ids || []) {
    out.total++;
    if (typeof id === 'string') out.strings++;
    else if (typeof id === 'number') out.numbers++;
    else out.other++;
  }
  return out;
}

/**
 * The coercion the repair would apply, and no more than that.
 *
 * Event ids are namespaced `E<id>` in the marker (D#188) and are NOT observation ids.
 * `Number('E42')` is NaN, and a NaN in an exclude Set is not merely useless — it is a
 * second silent no-op wearing the costume of a fix. The `Number.isInteger` gate below
 * is what excludes them, and it is the ONLY thing that does: a first version of this
 * function carried an explicit `/^E/` skip above it, and mutating that line away left
 * all 17 cases green, because no input reaches it that the integer gate does not also
 * reject. Deleted rather than kept as a guard nobody can see fire (the D#197 precedent).
 * The behaviour is still pinned by a test — what is gone is the unreachable branch.
 *
 * Same reasoning for anything non-integral or non-positive: an exclude set is a set of
 * primary keys, so a value that cannot be one does not belong in it. The gate is
 * `Number.isInteger(n) && n > 0`, not truthiness — `Number('')` and `Number(null)` are
 * both 0, which `if (n)` would reject by accident and for the wrong reason.
 * @param {Array<number|string>} ids
 * @returns {Set<number>}
 */
export function coerceMarkerIds(ids) {
  const out = new Set();
  for (const raw of ids || []) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return out;
}

/**
 * Rows a numerically-comparing exclude would have removed from what arm A delivered.
 * Exact rather than estimated — see the header.
 * @param {Array<number|string>} markerIds
 * @param {number[]} emittedIds
 * @returns {number[]}
 */
export function suppressedByWorkingExclude(markerIds, emittedIds) {
  const numeric = coerceMarkerIds(markerIds);
  return (emittedIds || []).filter(id => numeric.has(id));
}

/**
 * Ids that are BOTH coercible to an observation id AND arrived as a string — i.e. the
 * ids the shipped comparison silently fails to match. This, not "any string is present",
 * is what makes a prompt's exclude inert.
 *
 * The distinction is load-bearing and a first version got it wrong. That version defined
 * inert as `markerTypeSplit().strings > 0`, on the belief — written into four files — that
 * UPS writes plain numbers and "only a PreToolUse emission inside the same window turns
 * the union into strings". That belief is FALSE, and the counterexamples are in UPS
 * itself: `scripts/user-prompt-search.js` writes `P<id>` on its prompt-fallback leg and
 * `D<id>` on its deferred leg, and the deferred leg merges `prevIds.map(String)`, which
 * stringifies whatever the file already held with no tool call involved.
 *
 * The consequence of the wrong definition ran in the opposite direction to the one the
 * design was defending against: a marker holding ONLY `P`/`D`/`E` ids was recorded
 * `inert: true` with `markerCoercible: 0` — a prompt whose exclude had nothing it could
 * ever have excluded, counted into the inert population. Found by the pre-tag claims
 * review (B5).
 * @param {Array<number|string>} ids
 * @returns {number[]}
 */
export function inertMarkerIds(ids) {
  const out = [];
  for (const raw of ids || []) {
    if (typeof raw !== 'string') continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}

/**
 * Run both arms and shape the metric row. Pure with respect to the store: every DB
 * access is the caller's `rerun` callback, so this is testable with no database and the
 * hot path keeps its own imports.
 *
 * `after` is arm B's ALREADY-COMPUTED outcome, not a callback. It was a callback in the
 * first version, which invited the caller to run arm B wherever was convenient — and the
 * convenient place (after the delivery) is the one place it is wrong, because arm A's
 * `injection_count` bump changes the corpus arm B then scores. The caller now owns the
 * ordering and this function owns only the arithmetic.
 *
 *   `after` absent          → armB: 'skipped'
 *   `{ rows: [...] }`       → armB: 'ok'
 *   `{ error: '<message>' }`→ armB: 'error', with `net`/`setChanged` left UNDEFINED
 *
 * A failed arm must never read as a measured zero — "Δ all-zero because it did not fire"
 * is a failure mode this repo has shipped before.
 *
 * @param {object} o
 * @param {Array<number|string>} o.markerIds  ids as `pathAInjectedIds` holds them
 * @param {Array<{id:number}>} o.emitted      arm A's delivered rows
 * @param {{rows?: Array<{id:number}>, error?: string}|null} [o.after]
 * @param {string} [o.imperativeArm]          'off' | 'on'
 * @param {number|null} [o.imperativeBefore]  arm A's pick id, when the flag is on
 * @param {number|null} [o.imperativeAfter]   arm B's pick id, when the flag is on
 * @returns {object} the metric payload (without `event`/`ts`)
 */
export function measurePathAExclude({
  markerIds, emitted, after,
  imperativeArm = 'off', imperativeBefore = null, imperativeAfter = null,
}) {
  const split = markerTypeSplit(markerIds);
  const numeric = coerceMarkerIds(markerIds);
  const inertStrings = inertMarkerIds(markerIds);
  const emittedIds = (emitted || []).map(r => r.id);
  // Through the exported helper, not a second copy of `emittedIds.filter(id =>
  // numeric.has(id))`. A first draft inlined it, which would have left the function the
  // metric row is built from and the function the tests assert on as two implementations
  // of one rule — the twin-drift class this repo pays for more often than any other.
  const suppressed = suppressedByWorkingExclude(markerIds, emittedIds);

  const row = {
    markerTotal: split.total,
    markerStrings: split.strings,
    markerNumbers: split.numbers,
    markerCoercible: numeric.size,
    // Ids that are coercible AND arrived as strings: what the shipped comparison fails
    // to match. `markerStrings` above counts every string INCLUDING `P`/`D`/`E`, which
    // are other tables' namespaces and were never observation ids to begin with.
    markerCoercibleStrings: inertStrings.length,
    // The shipped exclude is inert for THIS prompt exactly when at least one id it
    // COULD have matched arrives as a string — not merely when some string is present.
    // See inertMarkerIds: defining it on `strings > 0` counts a `P`/`D`/`E`-only marker
    // as inert although it had nothing excludable, inflating the very denominator this
    // column exists to keep honest.
    inert: inertStrings.length > 0,
    emitted: emittedIds.length,
    suppressed: suppressed.length,
    suppressedIds: suppressed,
    imperativeArm,
  };

  if (imperativeArm === 'on') {
    row.imperativeBefore = imperativeBefore;
    row.imperativeAfter = imperativeAfter;
    row.imperativeChanged = imperativeBefore !== imperativeAfter;
  }

  if (after && Array.isArray(after.rows)) {
    const afterIds = after.rows.map(r => r.id);
    row.armB = 'ok';
    row.delivered = afterIds.length;
    // The number the ledger says is unknown: slots freed by the exclude that the
    // pool refills with something else. `delivered - emitted` is the NET, and net
    // zero does not mean nothing happened — a suppressed row replaced one-for-one
    // reads as no change while the delivered SET is different.
    const before = new Set(emittedIds);
    row.refilledIds = afterIds.filter(id => !before.has(id));
    row.refilled = row.refilledIds.length;
    row.net = afterIds.length - emittedIds.length;
    row.setChanged = row.suppressed > 0 || row.refilled > 0;
  } else if (after && after.error) {
    // Never a measured zero: `net` and `setChanged` stay undefined so a reader cannot
    // mistake a failed arm for "the repair changed nothing".
    row.armB = 'error';
    row.armBError = String(after.error);
  } else {
    row.armB = 'skipped';
  }

  return row;
}

/**
 * Gate + measure + append. Returns the recorded payload, or null when it did not run,
 * so a caller (or a test) can tell "measured nothing" from "did not measure".
 * @returns {object|null}
 */
export function recordPathAExclude(dbDir, opts) {
  if (!pathAMeterEnabled()) return null;
  if (!opts || !Array.isArray(opts.markerIds) || opts.markerIds.length === 0) return null;
  const row = measurePathAExclude(opts);
  recordMetric(dbDir, { event: PATHA_EXCLUDE_EVENT, ...row });
  return row;
}
