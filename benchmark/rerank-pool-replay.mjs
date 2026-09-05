#!/usr/bin/env node
// benchmark/rerank-pool-replay.mjs — the ruler for the `fyi` face's candidate-pool bounds
// (RERANK_POOL_SAME_PROJECT / RERANK_POOL_CROSS_PROJECT in hook-memory.mjs, audit ALGO-3).
//
// WHY THIS EXISTS AS A COMMITTED FILE. v3.85.0's first draft published five live-corpus
// numbers from a scratch script that was never committed, and the pre-tag claims review
// could not reproduce any of them. It turned out the harness was right and the SAMPLE
// PREDICATE was the whole difference — the draft sampled `LENGTH(prompt_text) BETWEEN 20
// AND 2000`, the reviewer sampled unfiltered, and on this corpus 1200-row samples of the
// same table span 11.9%–20.2% depending on which predicate you pick. A number nobody else
// can re-derive is not evidence, and a number whose sample predicate is a free parameter
// is barely better. Hence: DEFAULT IS THE WHOLE CORPUS, no sampling decision at all, and
// `--sample N` prints a warning saying so.
//
// WHAT IT MEASURES. `searchRelevantMemories` takes its candidate pool with
// `ORDER BY <raw bm25> LIMIT n` and then picks what to inject with a JS composite spanning
// 281× (type × lesson × importance × cross × OR × noise × cite). The LIMIT is therefore a
// REACHABILITY bound, not a ranking bound — D#172's shape. This replays every real user
// prompt through BOTH the shipped module and a twin with the pre-v3.85.0 pool values, and
// reports how often the injected set differs.
//
// USAGE
//   node benchmark/rerank-pool-replay.mjs                  whole corpus (the quotable number)
//   node benchmark/rerank-pool-replay.mjs --sample 1200    newest N prompts (a sampling decision)
//   node benchmark/rerank-pool-replay.mjs --baseline-same 10 --baseline-cross 5
//   node benchmark/rerank-pool-replay.mjs --cross-arm      cross-leg truncation rates only
//   node benchmark/rerank-pool-replay.mjs --cost           ms/prompt, both arms
//   node benchmark/rerank-pool-replay.mjs --json
//
// The default mode reports DELIVERED ROWS and a set-size histogram alongside the change
// rates. `MAX_MEMORY_INJECTIONS` is a per-set cap and the widening does not move it, but it
// does move the average FILL — quoting the unchanged cap without the delivered-row line
// reads as "no more rows are injected", which is not what happens.
//
// IT CANNOT POLLUTE WHAT IT MEASURES, and proves it rather than promising it — for BOTH
// sinks, which is the part this file got wrong until v3.91.0.
// (1) The corpus. `searchRelevantMemories` bumps `injection_count` on every row it returns
// — replaying it against the live DB would permanently move the very noise signal
// `noisePenaltyClause` reads, and arm A's bumps would change arm B's scores. The DB is
// opened `readonly`, so that UPDATE raises SQLITE_READONLY and is swallowed by the shipped
// line's own bare catch. `assertCannotWrite()` below executes the bump against the handle
// and FAILS THE RUN if it succeeds — a promise in a comment is not a guarantee.
// (2) The metrics. The same function also appends an `inject` row to
// `$DB_DIR/metrics/YYYY-MM-DD.jsonl`, and a readonly DATABASE handle does nothing about a
// file append. With CLAUDE_MEM_METRICS=1 a whole-corpus run wrote ~1.5M of them in a day
// against ~1.5k on a real day, and `doctor` then reported this replay's in-process timings
// as live injection latency. Every arm invocation now goes through `callArm()`, which
// passes the shipped `{ counterfactual: true }` option (it skips both side effects), and
// `assertNoMetricWrite()` proves the shard does not grow. Sentence (1) was true and read
// as if it covered the file; a guard is only as wide as the sinks it enumerates.

// D#190: until v3.86.0 nothing under tests/ imported this file, so every self-check
// described above could be deleted with a fully green suite — the same shape that let
// two of citation-live-replay.mjs's self-checks be removed from its main() undetected
// (v3.82.0). The checks are now exported and driven from tests/rerank-pool-replay.test.mjs
// with synthetic inputs, each one watched to FAIL. That is why they THROW rather than
// call process.exit: an exit code cannot be asserted in-process. main() catches and
// still exits 1 with the message on stderr, so the CLI contract is unchanged.

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdtempSync,
  readdirSync,
  statSync,
  rmSync,
  existsSync,
} from 'fs';
import Database from 'better-sqlite3';
import { DB_DIR } from '../schema.mjs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL, fileURLToPath } from 'url';
import { recordMetric } from '../lib/metrics.mjs';
import { upsFtsQuery } from '../lib/ups-query.mjs';
import { relaxFtsQueryToOr, notLowSignalTitleClause, OBS_BM25 } from '../utils.mjs';
import { liveObsFilterSql } from '../lib/inject-search-core.mjs';

// D#207: `join()`, never `new URL('../X.mjs', import.meta.url)` — that form makes knip
// drop the named module out of its unused-export report entirely, and this file naming
// hook-memory.mjs that way was one of the two causes of that blind spot.
// tests/no-url-module-paths.test.mjs pins the rule for the class.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_PATH = join(REPO_ROOT, 'hook-memory.mjs');
const SHIPPED_URL = pathToFileURL(SHIPPED_PATH);
// The twin has to sit at the REPO ROOT, not in benchmark/, or hook-memory's own relative
// imports ('./utils.mjs', './lib/...') resolve against the wrong directory.
const TWIN_PATH = join(REPO_ROOT, '.tmp-rerank-pool-twin.mjs');
const TWIN_URL = pathToFileURL(TWIN_PATH);

const DEFAULT_BASELINE_SAME = 10;
const DEFAULT_BASELINE_CROSS = 5;
const LOOKBACK_MS = 60 * 24 * 60 * 60 * 1000;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

/**
 * Build a twin of the shipped module with the two pool constants replaced.
 * Throws when either replacement is a no-op: a twin that silently failed to patch would
 * compare the shipped module against itself and report a reassuring 0% — the failure mode
 * this whole file exists to prevent.
 */
export function patchConst(src, name, value) {
  // Match on the DECLARATION, not on "did the text change". The first version of this
  // guard compared before/after strings, so holding one pool at its shipped value while
  // sweeping the other (`--baseline-same 30 --baseline-cross 50`) produced a no-op
  // replacement and the guard reported "constant not found" — a true failure with a false
  // cause. "The edit changed nothing" and "the anchor is gone" are different faults and a
  // guard that cannot tell them apart sends you to the wrong file.
  const re = new RegExp(`const ${name} = (\\d+);`);
  const m = src.match(re);
  if (!m) throw new Error(`twin patch failed: ${name} not found in hook-memory.mjs (renamed?)`);
  return { out: src.replace(re, `const ${name} = ${value};`), previous: Number(m[1]) };
}

export function writeTwin(sameLimit, crossLimit) {
  const src = readFileSync(SHIPPED_URL, 'utf8');
  const a = patchConst(src, 'RERANK_POOL_SAME_PROJECT', sameLimit);
  const b = patchConst(a.out, 'RERANK_POOL_CROSS_PROJECT', crossLimit);
  if (a.previous === sameLimit && b.previous === crossLimit) {
    throw new Error(
      `twin is identical to shipped (${sameLimit}/${crossLimit}) — the comparison ` +
        'would report 0% for reasons that have nothing to do with the pools. Pass a baseline ' +
        'that differs in at least one arm.',
    );
  }
  writeFileSync(TWIN_URL, b.out);
  return { same: a.previous, cross: b.previous };
}

/** Proves the handle cannot write, so the replay cannot move the signal it measures. */
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
  if (wrote) {
    throw new Error(
      'SELF-CHECK FAILED: the database handle accepted a write. Replaying ' +
        'searchRelevantMemories against a writable handle bumps injection_count on every ' +
        'returned row and permanently contaminates the noise signal. Refusing to run.',
    );
  }
}

/**
 * EVERY arm invocation in this file goes through here. Not a style choice: the guard
 * below probes the sink through this same function, so a probe that carried the flag
 * while a loop had lost it would be a guard testing a proxy instead of the harm.
 *
 * `counterfactual` is the shipped option that skips BOTH side effects — the
 * `injection_count` bump and the `inject` metric row. Two sinks, and only one of them
 * is a database.
 */
export function callArm(fn, db, text, project) {
  return fn(db, text, project, [], { counterfactual: true });
}

/**
 * THE SECOND SINK, and the one `assertCannotWrite` above is structurally unable to see.
 *
 * `searchRelevantMemories` writes twice per call: `UPDATE observations SET
 * injection_count` (a database write, blocked by the readonly handle) and
 * `recordMetric(DB_DIR, { event: 'inject' })` (an appendFileSync to
 * `$DB_DIR/metrics/YYYY-MM-DD.jsonl`, which a readonly *database* handle does nothing
 * about). Until v3.91.0 this file replayed the whole corpus through both arms with the
 * metric sink wide open: on a machine running with CLAUDE_MEM_METRICS=1 that appended
 * ~1.5M `inject` rows in a day — three orders of magnitude over a production day — and
 * `claude-mem-lite doctor` then reported the replay's in-process timings as if they were
 * live injection latency. The docblock at the top of this file said "IT CANNOT POLLUTE
 * THE CORPUS, and proves it rather than promising it"; that sentence was true of the
 * corpus and false of the metrics, because the proof only ever covered one sink.
 *
 * Liveness is why the throwaway dir exists. A guard that derives the shard filename
 * itself passes vacuously whenever the convention differs, and one that runs with the
 * sink disabled passes vacuously always — two of the three ways this check could look
 * green while seeing nothing. So: force the sink on, let `recordMetric` NAME the file in
 * a temp dir, and watch that same basename in the real one. Nothing is written to the
 * real dir to prove the detector works, because that would be the contamination it
 * exists to stop.
 *
 * The THIRD way is the probe call itself. `searchRelevantMemories` has three returns that
 * never call `_emit` — `!db || !userPrompt`, the length floor, and an empty FTS query. State
 * the invariant that way and not as "returns above the block": only the first two are
 * positionally above it, the third sits BELOW `_emit`'s definition inside the `try` and
 * simply never calls it, and the positional phrasing rots on any reorder. Either way a probe
 * on a two-word prompt writes nothing whatever the flag says, and the guard would certify a
 * sink it never approached. Hence `probe` must report whether it reached the emit path, and
 * a probe that did not fails the run rather than passing it. Returning rows is a SUFFICIENT
 * witness (that path emits), not a necessary one — the empty-result paths emit too — which
 * is the right direction for a guard.
 */
export function assertNoMetricWrite(shard, probe) {
  const tmp = mkdtempSync(join(tmpdir(), 'rerank-pool-sink-')); // BEFORE the env write:
  const prevEnv = process.env.CLAUDE_MEM_METRICS; // if mkdtemp throws (TMPDIR
  process.env.CLAUDE_MEM_METRICS = '1'; // gone, ENOSPC, EACCES) the
  try {
    // finally never runs and
    const size = () => (existsSync(shard) ? statSync(shard).size : 0); // '1' leaks into the
    const before = size(); // rest of the process — the
    const reached = probe(); // guard creating the very
    const after = size(); // condition it prevents.
    if (!reached) {
      throw new Error(
        'SELF-CHECK FAILED: the probe call never reached the metric block ' +
          '(searchRelevantMemories has three returns that never call _emit: a null guard, the ' +
          'length floor, and a query that sanitizes to nothing), so "the shard did not grow" ' +
          'says nothing about the flag. Refusing to run.',
      );
    }
    if (after !== before) {
      throw new Error(
        `SELF-CHECK FAILED: one replay call grew ${shard} by ${after - before} ` +
          'bytes. Either an arm invocation lost `{ counterfactual: true }` — in which case a ' +
          'whole-corpus run appends two metric rows per prompt and poisons the `inject` ' +
          'latency series this project reads from `doctor --metrics` — or a live hook wrote ' +
          'to the shard during the probe window. Check the tail of that file to tell them ' +
          'apart.',
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.CLAUDE_MEM_METRICS;
    else process.env.CLAUDE_MEM_METRICS = prevEnv;
  }
}

/**
 * Which file the guard above watches — and the convention is NEVER derived here. It is read
 * back off `recordMetric` itself, in a throwaway directory, so a change to the shard naming
 * cannot leave this file quietly watching a name nothing writes. That is why there is no
 * date formatting in this function, and why a test asserts on its source that there is none:
 * a mutation that re-derived the CORRECT convention by hand would survive a behavioural
 * case, so the property being pinned ("the convention is never copied") is a source property.
 */
export function metricShardPath(dbDir) {
  const tmp = mkdtempSync(join(tmpdir(), 'rerank-pool-name-'));
  const prevEnv = process.env.CLAUDE_MEM_METRICS;
  process.env.CLAUDE_MEM_METRICS = '1';
  try {
    recordMetric(tmp, { event: 'sink_liveness_probe' });
    const named = existsSync(join(tmp, 'metrics')) ? readdirSync(join(tmp, 'metrics')) : [];
    // No direct case drives this branch, and that is recorded rather than papered over:
    // it IS reachable and IS what fails when the sink is off — the mutation that removes
    // the `= '1'` above dies here, with this exact message and `named.length` 0. Live
    // code exercised indirectly, not the dead branch the D#197 precedent says to delete.
    if (named.length !== 1) {
      throw new Error(
        `SELF-CHECK FAILED: the metric sink named ${named.length} shards in a ` +
          'clean directory, so this guard does not know which file to watch and would pass ' +
          'without seeing anything. Refusing to run.',
      );
    }
    return join(dbDir, 'metrics', named[0]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.CLAUDE_MEM_METRICS;
    else process.env.CLAUDE_MEM_METRICS = prevEnv;
  }
}

/**
 * THE RUN-LEVEL GUARD, and the reason the probe above is not enough on its own.
 *
 * `assertNoMetricWrite` proves that `callArm` is clean. That every arm invocation GOES
 * through `callArm` was left to a source-text case, and the pre-tag review broke it in four
 * ways the text cannot see — aliasing the handle (`const d = db; narrow(d, …)`),
 * `narrow.call(null, db, …)`, aliasing the function inside `costCompare`'s timer, and a
 * newly added exported helper that calls an arm directly. Each survived the suite, and the
 * aliasing one, replayed over 300 real prompts, **appended 992 metric rows while the run
 * exited 0 and printed a complete report** — this release's own defect, reopened through a
 * form the regex does not match. So the guarantee is re-stated at the level that matters:
 * not "the helper carries the flag" but "THIS RUN wrote nothing".
 *
 * It measures the whole `metrics/` DIRECTORY, not the one shard, which also closes the
 * UTC-day-rollover hole (a long run started at 23:59 writes into tomorrow's shard, and a
 * one-shard baseline would miss every row of it).
 *
 * Registered on `process.on('exit')` rather than called before each `process.exit(0)`: it
 * then covers every exit path including modes not yet written, and it runs AFTER the report
 * has printed, so a false positive — a live hook writing during a multi-minute run, which
 * this cannot distinguish and says so — costs a scary message rather than the run's output.
 *
 * One stated limitation: with `CLAUDE_MEM_METRICS` unset, a bypassing call writes nothing,
 * so this passes. That is correct (no harm occurred) but it means the run-level guard is
 * silent about call FORM on a metrics-off machine; the probe, which forces the sink on for
 * its own duration, is what covers that case. The two are complementary, not redundant.
 */
export function metricsDirSize(dbDir) {
  const dir = join(dbDir, 'metrics');
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of readdirSync(dir)) {
    try {
      total += statSync(join(dir, f)).size;
    } catch {
      /* raced with a rotation */
    }
  }
  return total;
}

/** The gate itself, separated from its `process.on('exit')` registration so a test can watch it fire. */
export function runLevelGrowth(dbDir, before) {
  return metricsDirSize(dbDir) - before;
}

/**
 * Which direction, if any, monotonicity runs in — THREE states, not two. See the
 * counterexample gate below for why a MIXED config must suppress the gate without
 * borrowing the superset label.
 */
export function monotonicityState({ baselineSame, baselineCross }, shippedPools) {
  if (baselineSame <= shippedPools.same && baselineCross <= shippedPools.cross) return 'subset';
  if (baselineSame >= shippedPools.same && baselineCross >= shippedPools.cross) return 'superset';
  return 'mixed';
}

export const MONOTONICITY_NOTE = {
  subset: '(a counterexample to the superset argument; run exits 1 if > 0)',
  superset: '(twin is wider — monotonicity runs the other way, not a test)',
  mixed:
    '(twin is narrower in one arm and wider in the other — neither direction is monotone, so this number tests nothing)',
};

/** The gate itself, separated from its rendering so a test can watch it fire. */
export function counterexampleGate(state, nonEmptyToEmpty) {
  return state === 'subset' && nonEmptyToEmpty > 0;
}

/**
 * `Number('foo')` is NaN and every downstream guard waves it through — see the block
 * comment at the call site. Exported so the refusal is asserted, not assumed.
 */
export function validatePoolArg(v) {
  return Number.isInteger(v) && v >= 1;
}

function loadPrompts(db, sampleN) {
  const base = `
    SELECT up.prompt_text AS text, s.project AS project
    FROM user_prompts up
    JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
  `;
  if (!sampleN) return db.prepare(base).all();
  return db.prepare(`${base} ORDER BY up.created_at_epoch DESC LIMIT ?`).all(sampleN);
}

export function compare(db, prompts, narrow, wide) {
  let n = 0,
    threw = 0,
    changed = 0,
    top1 = 0,
    gained = 0,
    lost = 0;
  let emptyNarrow = 0,
    emptyWide = 0,
    bothEmpty = 0;
  // DELIVERED ROWS, not just changed sets. `MAX_MEMORY_INJECTIONS` is a PER-SET cap and it
  // did not move — but the average fill did, and a reader who only sees "the cap is still 3"
  // will read "no more rows are injected", which is false. The pre-tag claims review (S5)
  // found this stated only as the cap; the histogram is here so the volume consequence
  // cannot be quoted without its source. Index = set size (0..MAX_MEMORY_INJECTIONS).
  const sizesNarrow = [],
    sizesWide = [];
  let deliveredNarrow = 0,
    deliveredWide = 0;
  // The superset argument's counterexample. If the narrow arm injects and the wide arm
  // does not, the widening COST a prompt its injection and "monotone" is false — the one
  // observation that would refute the whole safety argument in hook-memory.mjs's docblock.
  // Counted rather than assumed, the way imperative-pool-replay.mjs attacks its own claim;
  // `emptyWide <= emptyNarrow` does NOT establish it, because two prompts moving off empty
  // can hide one moving onto it.
  let nonEmptyToEmpty = 0;
  const bump = (hist, k) => {
    hist[k] = (hist[k] || 0) + 1;
  };
  for (const { text, project } of prompts) {
    let a, b;
    try {
      a = callArm(narrow, db, text, project);
      b = callArm(wide, db, text, project);
    } catch {
      threw++;
      continue;
    }
    n++;
    const ai = a.map((r) => r.id),
      bi = b.map((r) => r.id);
    bump(sizesNarrow, ai.length);
    bump(sizesWide, bi.length);
    deliveredNarrow += ai.length;
    deliveredWide += bi.length;
    if (ai.length === 0) emptyNarrow++;
    if (bi.length === 0) emptyWide++;
    if (ai.length === 0 && bi.length === 0) bothEmpty++;
    if (ai.length > 0 && bi.length === 0) nonEmptyToEmpty++;
    if (JSON.stringify(ai) !== JSON.stringify(bi)) {
      changed++;
      if (ai[0] !== bi[0]) top1++;
      gained += bi.filter((x) => !ai.includes(x)).length;
      lost += ai.filter((x) => !bi.includes(x)).length;
    }
  }
  const fill = (h) =>
    Array.from({ length: Math.max(sizesNarrow.length, sizesWide.length) }, (_, i) => h[i] || 0);
  return {
    n,
    threw,
    changed,
    top1,
    gained,
    lost,
    emptyNarrow,
    emptyWide,
    bothEmpty,
    nonEmptyToEmpty,
    deliveredNarrow,
    deliveredWide,
    sizesNarrow: fill(sizesNarrow),
    sizesWide: fill(sizesWide),
  };
}

/**
 * What the widening COSTS, measured rather than asserted. The docblock this ruler backs
 * used to say "a 3x widening chosen where cost stays flat", with a parenthetical stating
 * that the pool is the expensive term — i.e. its own reasoning predicted the opposite of
 * its claim, and the claims review measured +15.7%. A cost claim about our own work needs
 * a number and a command that reproduces it.
 *
 * Ordering bias is real here — the first arm to touch a page pays for the read — so the
 * two passes run the arms in OPPOSITE order and the per-arm totals are summed across both.
 * Without that, whichever arm goes first reads slower and the ratio is an artefact of the
 * loop, not of the pool size.
 *
 * READ THE RATIO AS A RANGE, NOT AS A VALUE, AND NEVER QUOTE THE ABSOLUTE ms. The v3.85.1
 * pre-tag review measured this five ways over fifteen whole-corpus runs. Holding the arm
 * order fixed reads 1.054–1.065; this design (alternating) reads 1.058–1.102 across six
 * runs on one machine; measuring each arm alone in its own process — the closest caliber to
 * production, where the function is called once per prompt minutes apart — reads
 * 1.063–1.156. So pairing the arms per prompt DOES let the second call reuse the first's
 * pages and alternating cancels only about half of it: this is the lowest-VARIANCE caliber,
 * not the unbiased one.
 *
 * Even so, its own spread is comparable to the effect it measures. Same code, same corpus,
 * an hour apart: 1.078 then 1.102, with ms/prompt moving 3.04 -> 1.80. So a three-digit
 * value from this function is not a fact about the pools, and the number in
 * hook-memory.mjs's docblock is deliberately a range.
 *
 * Both arms are timed for a prompt or neither is (review N7): the first draft incremented
 * the denominator after both calls, so a throw in the wide arm left the narrow arm's time
 * in the numerator with no matching denominator — a bias in the same direction as the
 * understatement above, tiny at 1 throw in 11289 but pointing the wrong way.
 */
export function costCompare(db, prompts, narrow, wide) {
  const warm = prompts.slice(0, Math.min(200, prompts.length));
  for (const { text, project } of warm) {
    try {
      callArm(narrow, db, text, project);
      callArm(wide, db, text, project);
    } catch {
      /* ignore */
    }
  }
  let nsNarrow = 0,
    nsWide = 0,
    pairs = 0,
    threw = 0;
  const time = (fn, text, project) => {
    const t = process.hrtime.bigint();
    callArm(fn, db, text, project);
    return Number(process.hrtime.bigint() - t);
  };
  for (const pass of [0, 1]) {
    for (const { text, project } of prompts) {
      // Stage into locals and commit both arms together, so a throw in either one
      // contributes to neither numerator nor denominator.
      let dn, dw;
      try {
        if (pass === 0) {
          dn = time(narrow, text, project);
          dw = time(wide, text, project);
        } else {
          dw = time(wide, text, project);
          dn = time(narrow, text, project);
        }
      } catch {
        threw++;
        continue;
      }
      nsNarrow += dn;
      nsWide += dw;
      // Count PAIRS ACTUALLY COMMITTED, across both passes — not `prompts × 2`. The first
      // draft incremented only on pass 0 and divided by `n * 2`, which assumes the two
      // passes throw identically. They do here (the throws are deterministic), and the bias
      // cancels between the arms so the RATIO — the only figure quoted — was unaffected;
      // but a pass-1 throw was invisible in `threw`, and the per-arm ms were off by the
      // ratio of the two passes' completion counts.
      pairs++;
    }
  }
  if (pairs === 0) {
    throw new Error(
      'SELF-CHECK FAILED: every timed call threw — no cost measurement exists. ' +
        'Refusing to report NaN as a ratio.',
    );
  }
  const msNarrow = nsNarrow / 1e6 / pairs,
    msWide = nsWide / 1e6 / pairs;
  return {
    n: pairs,
    threw,
    msNarrow: +msNarrow.toFixed(4),
    msWide: +msWide.toFixed(4),
    ratio: +(msWide / msNarrow).toFixed(3),
  };
}

/**
 * The ruler must be able to say NO. Comparing the shipped module against ITSELF must
 * report zero changes; anything else means the replay is not deterministic (a leaked
 * write, a stateful module, an unstable sort) and every other number it prints is noise.
 */
export function assertRulerCanSayNo(db, prompts, wide) {
  const slice = prompts.slice(0, Math.min(200, prompts.length));
  const { changed } = compare(db, slice, wide, wide);
  if (changed !== 0) {
    throw new Error(
      `SELF-CHECK FAILED: shipped-vs-shipped reported ${changed} changed result ` +
        'sets over 200 prompts. The replay is not deterministic, so no delta it reports is ' +
        'attributable to the pool sizes. Refusing to report.',
    );
  }
}

/**
 * How often does the CROSS-PROJECT leg match more rows than its pool can hold?
 * Models the shipped leg including its OR fallback. Measuring the AND pass alone reports
 * this leg as firing on 5 of 1200 prompts and never truncating; the leg takes the OR
 * branch on the large majority of real prompts, where it matches up to 241 rows. The
 * first version of this measurement made exactly that mistake.
 */
function crossArmTruncation(db, prompts, poolSizes) {
  const cutoff = Date.now() - LOOKBACK_MS;
  const stmt = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT o.id
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project != ?
        AND o.type IN ('decision', 'discovery')
        AND o.importance >= 2
        AND o.created_at_epoch > ?
        AND ${liveObsFilterSql('o')}
        AND ${notLowSignalTitleClause('o')}
      ORDER BY ${OBS_BM25}
    )
  `);
  let n = 0,
    fired = 0,
    orFired = 0,
    max = 0;
  const over = new Map(poolSizes.map((p) => [p, 0]));
  for (const { text, project } of prompts) {
    const q = upsFtsQuery(text);
    if (!q) continue;
    let c;
    try {
      c = stmt.get(q, project, cutoff).c;
    } catch {
      continue;
    }
    if (c === 0) {
      const orQuery = relaxFtsQueryToOr(q);
      const cjk = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
      const ascii = (text.match(/[A-Za-z]/g) || []).length;
      const tokens = q.includes(' AND ')
        ? q.split(' AND ').length
        : q.split(/\s+/).filter((x) => x && !x.startsWith('(') && !x.endsWith(')')).length;
      if (orQuery && ((cjk > 0 && cjk >= ascii) || tokens <= 8)) {
        try {
          c = stmt.get(orQuery, project, cutoff).c;
          orFired++;
        } catch {
          /* ignore */
        }
      }
    }
    n++;
    if (c > 0) fired++;
    if (c > max) max = c;
    for (const p of poolSizes) if (c > p) over.set(p, over.get(p) + 1);
  }
  return { n, fired, orFired, max, over };
}

async function main() {
  const sampleN = arg('--sample') ? Number(arg('--sample')) : null;
  const baselineSame = Number(arg('--baseline-same', String(DEFAULT_BASELINE_SAME)));
  const baselineCross = Number(arg('--baseline-cross', String(DEFAULT_BASELINE_CROSS)));
  const asJson = has('--json');

  // A non-numeric pool argument used to produce a full, exit-0, conclusive-LOOKING report.
  // `Number('foo')` is NaN, `patchConst` faithfully writes `const RERANK_POOL_SAME_PROJECT =
  // NaN;`, the twin's identity guard passes (NaN !== 10), `LIMIT NaN` returns no rows so the
  // narrow arm delivers ZERO, and `NaN <= 30` is false — which silently switches OFF the
  // counterexample gate and mislabels it "twin is wider". The run then reports "100% of
  // retrieving prompts changed set", a number that looks like a finding and is garbage.
  // Every other self-check in this file exists to stop exactly that shape; NaN was the hole.
  for (const [flag, v] of [
    ['--baseline-same', baselineSame],
    ['--baseline-cross', baselineCross],
  ]) {
    if (!validatePoolArg(v)) {
      throw new Error(
        `${flag} must be a positive integer, got "${arg(flag)}". Refusing to run: ` +
          'a NaN pool produces a complete report whose every number is meaningless.',
      );
    }
  }

  const dbPath = process.env.CLAUDE_MEM_DB_PATH || join(DB_DIR, 'claude-mem-lite.db');
  const db = new Database(dbPath, { readonly: true });
  assertCannotWrite(db);

  const shippedPools = writeTwin(baselineSame, baselineCross);
  let wide, narrow;
  try {
    ({ searchRelevantMemories: wide } = await import(SHIPPED_URL.href));
    ({ searchRelevantMemories: narrow } = await import(`${TWIN_URL.href}?v=${Date.now()}`));
  } finally {
    try {
      unlinkSync(TWIN_URL);
    } catch {
      /* already gone */
    }
  }

  const prompts = loadPrompts(db, sampleN);

  // Both sinks, before any mode branches, and at TWO levels.
  //
  // (1) Run-level, registered first so it covers every exit path including the two modes
  //     that `process.exit(0)` and any mode added later. It fires after the report prints.
  // (2) Helper-level, through the same `callArm` every arm invocation uses, on real prompts
  //     until one reaches the emit path. The window is normally a couple of calls; it is
  //     bounded at 200 and is the whole loop only if none of the first 200 retrieve, so the
  //     "tight window" claim is about the typical case and the bound is the guarantee.
  const runBaseline = metricsDirSize(DB_DIR);
  process.on('exit', () => {
    const grew = runLevelGrowth(DB_DIR, runBaseline);
    if (grew <= 0) return;
    process.exitCode = 1;
    console.error(
      `\nSELF-CHECK FAILED: this run grew ${join(DB_DIR, 'metrics')} by ${grew} ` +
        'bytes. Every arm invocation is supposed to carry `{ counterfactual: true }`, which ' +
        'skips both the injection_count bump and the `inject` metric row. Either a call site ' +
        'stopped going through callArm() — a whole-corpus run then appends ~2 rows per prompt ' +
        'and poisons the series `doctor --metrics` reads — or a live hook wrote while this ' +
        'ran. Tail the shard: a replay shows a burst of `inject` rows, a hook shows one row. ' +
        'EVERY NUMBER PRINTED ABOVE STILL STANDS; what is compromised is the metrics sink.',
    );
  });

  if (prompts.length) {
    assertNoMetricWrite(metricShardPath(DB_DIR), () => {
      for (const { text, project } of prompts.slice(0, 200)) {
        let rows;
        try {
          rows = callArm(wide, db, text, project);
        } catch {
          continue;
        }
        if (rows.length) return true;
      }
      return false;
    });
  }
  if (sampleN) {
    console.error(
      `NOTE: --sample ${sampleN} is a sampling decision. On this corpus, 1200-row ` +
        'samples of the same table span 11.9%-20.2% depending on the predicate. The default ' +
        '(whole corpus) has no such free parameter — prefer it for anything you publish.',
    );
  }

  if (has('--cross-arm')) {
    const r = crossArmTruncation(db, prompts, [baselineCross, 15, 50]);
    const pct = (x) => (r.fired ? `${((100 * x) / r.fired).toFixed(1)}%` : 'n/a');
    if (asJson) {
      console.log(JSON.stringify({ ...r, over: Object.fromEntries(r.over) }, null, 2));
    } else {
      console.log(`\n─── cross-project leg truncation (n=${r.n}) ───`);
      console.log(
        `  leg fires (matched >0):            ${r.fired} (${((100 * r.fired) / r.n).toFixed(1)}%)   [OR fallback used on ${r.orFired}]`,
      );
      for (const [p, c] of r.over)
        console.log(`  matched more than ${String(p).padStart(3)} rows:       ${c} (${pct(c)} of firings)`);
      console.log(`  largest single match count:        ${r.max}`);
      console.log('\n  Read as a reachability bound, not as harm: the OR penalty (0.4x), the');
      console.log('  cross penalty (0.7x) and the adaptive threshold drop nearly all of these');
      console.log('  rows downstream. Price the harm with the default mode, not with this one.');
    }
    process.exit(0);
  }

  if (has('--cost')) {
    // Determinism check FIRST (review N8): the first draft exited above it, so the mode that
    // produced this release's most contested number was the only one that never verified the
    // replay is reproducible. A timing ratio over a non-deterministic replay is two different
    // workloads being compared, not two pool sizes.
    assertRulerCanSayNo(db, prompts, wide);
    const c = costCompare(db, prompts, narrow, wide);
    if (asJson) {
      console.log(
        JSON.stringify({ ...c, baselineSame, baselineCross, sample: sampleN || 'whole-corpus' }, null, 2),
      );
    } else {
      console.log(
        `\n─── cost: ${baselineSame}/${baselineCross} vs shipped (${c.n} timed pairs over 2 passes, arm order alternated${c.threw ? `; ${c.threw} threw` : ''}) ───`,
      );
      console.log(
        `  ${String(baselineSame).padStart(2)}/${String(baselineCross).padStart(2)} baseline:  ${c.msNarrow.toFixed(3)} ms/prompt`,
      );
      console.log(`  shipped:         ${c.msWide.toFixed(3)} ms/prompt`);
      console.log(
        `  ratio:           ${c.ratio.toFixed(3)}x  (${c.msWide >= c.msNarrow ? '+' : ''}${(100 * (c.msWide / c.msNarrow - 1)).toFixed(1)}%)`,
      );
      console.log('\n  The SELECT carries `narrative`, so the pool is the expensive term. This');
      console.log('  measures the whole function, not the SELECT alone: timing only the SELECT');
      console.log('  reports ~1.00x and misses the JS scoring the widened pool feeds.');
    }
    process.exit(0);
  }

  assertRulerCanSayNo(db, prompts, wide);
  const r = compare(db, prompts, narrow, wide);

  // Attack the superset argument instead of restating it. Only meaningful when the twin is
  // genuinely NARROWER in both arms — under a sweep like `--baseline-same 30
  // --baseline-cross 50` the twin is the wider one and monotonicity runs the other way, so
  // a counterexample there says nothing about the shipped direction.
  //
  // THREE states, not two. A MIXED config (`--baseline-same 10 --baseline-cross 50`: one arm
  // narrower, one wider) is neither a subset nor a superset, and it really does produce
  // counterexamples — 51 of them on the whole corpus. Suppressing the gate there is right,
  // but the first draft labelled them "twin is wider", which explains half the reason and
  // invites the reader to think the other half was checked. In a ruler whose whole design
  // principle is "say which population and which direction you measured", that label was the
  // one place it didn't.
  const state = monotonicityState({ baselineSame, baselineCross }, shippedPools);
  const monotonicityNote = MONOTONICITY_NOTE[state];
  if (counterexampleGate(state, r.nonEmptyToEmpty)) {
    throw new Error(
      `COUNTEREXAMPLE: ${r.nonEmptyToEmpty} of ${r.n} prompts inject under the ` +
        `${baselineSame}/${baselineCross} pools and inject NOTHING under the shipped ` +
        `${shippedPools.same}/${shippedPools.cross}. The wider pool is a superset, so this ` +
        "should be impossible — the monotonicity argument in hook-memory.mjs's RERANK_POOL_* " +
        'docblock does not hold as written. Investigate before quoting any number here.',
    );
  }

  const either = r.n - r.bothEmpty;
  const pctAll = (x) => `${((100 * x) / r.n).toFixed(1)}%`;
  const pctEither = (x) => (either ? `${((100 * x) / either).toFixed(1)}%` : 'n/a');

  if (asJson) {
    console.log(
      JSON.stringify(
        { ...r, either, baselineSame, baselineCross, sample: sampleN || 'whole-corpus' },
        null,
        2,
      ),
    );
  } else {
    console.log(`\n─── rerank pool replay: ${baselineSame}/${baselineCross} vs shipped ───`);
    console.log(`  prompts replayed:        ${r.n}${r.threw ? `  (${r.threw} threw)` : ''}`);
    console.log(`  both arms empty:         ${r.bothEmpty} (${pctAll(r.bothEmpty)})`);
    console.log(
      `  injected set differs:    ${r.changed} (${pctAll(r.changed)} of all, ${pctEither(r.changed)} of the ${either} that retrieve anything)`,
    );
    console.log(
      `  top-1 differs:           ${r.top1} (${pctAll(r.top1)} of all, ${pctEither(r.top1)} of ${either})`,
    );
    console.log(`  rows newly reachable:    ${r.gained}   displaced: ${r.lost}`);
    console.log(`  empty injections:        ${r.emptyNarrow} -> ${r.emptyWide}`);
    console.log(`  non-empty -> EMPTY:      ${r.nonEmptyToEmpty}   ${monotonicityNote}`);
    console.log(
      `  rows DELIVERED:          ${r.deliveredNarrow} -> ${r.deliveredWide} ` +
        `(${r.deliveredNarrow ? `${r.deliveredWide >= r.deliveredNarrow ? '+' : ''}${(100 * (r.deliveredWide / r.deliveredNarrow - 1)).toFixed(1)}%` : 'n/a'})`,
    );
    console.log(
      `  set-size histogram:      ${JSON.stringify(r.sizesNarrow)} -> ${JSON.stringify(r.sizesWide)}   [index = set size]`,
    );
    console.log('\n  The per-set cap (MAX_MEMORY_INJECTIONS) does not move. The average fill');
    console.log('  does — most of the extra rows come from under-filled sets reaching the cap,');
    console.log('  not from prompts moving off zero. Read both rows before quoting either.');
  }
}

// Only run when invoked as a script. Importing this file (tests/rerank-pool-replay.test.mjs)
// must not open the live DB, write a twin, or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
