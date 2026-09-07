#!/usr/bin/env node
// Deep-search PRECISION arm — the hard-negative ruler for deep-search.mjs.
//
// WHY THIS EXISTS. tests/benchmark-deep-search.test.mjs measures deep search's
// RECALL (R@10 / nDCG / MRR) and nothing else, so it is structurally blind to the
// only way this face can fail loudly (doctrine rule 9): returning a full page of
// confidently-formatted rows for a query the corpus cannot answer. That is not
// hypothetical — it is the shipped behaviour, and it is what this ruler measures.
//
// THE CALIBER: CROSS-DOMAIN HOLDOUT, not hand-picked negatives.
// A first cut asked five off-domain questions ("sourdough starter hydration
// ratio", "guitar pedal true bypass wiring") and compared their scores against
// the suite's. That population is chosen by the person hoping for a separation,
// and it produced one that did not survive: a hand-picked negative reached
// top|score| 34.5 while a real suite positive sat at 17.0.
//
// So the negatives here are the SUITE'S OWN QUERIES asked of a corpus with their
// relevant_ids DELETED. Same queries, same recorded rewrites, same engine, same
// corpus minus a handful of rows — the recall arm's caliber, with the answer
// removed. Every row that comes back is then a false positive by construction,
// no relevance judgement required. It is also the real user scenario: asking a
// memory store about something you never saved.
//
// MEASURED 2026-09-06, `main` @ 0cdc9b3, benchmark/fixtures/seed-data.json
// (200 obs), 12 suite queries, recorded rewrites:
//
//     mean FP@10 = 10.00      queries with >=5 FP: 12/12
//
// Deep search fills every one of its ten slots, on every query, with rows it has
// no basis to return. RRF fuses by RANK, so no magnitude signal survives into the
// merge for a downstream floor to act on.
//
// CORRECTION, measured 2026-09-07 on `main`, same fixture: this docblock used to
// say "the single-query baseline returns 1-2 rows on the same negatives", and that
// does not reproduce. The single-variant baseline (deepSearch with a no-rewrite
// llm, the same one runDeepSearch calls `baseline`) returns a mean of 9.42 of 10
// on these negatives, against deep's 10.00 — so the union across paraphrases adds
// about half a slot, it does not fill the page. The page was already full. The
// provenance of the 1-2 figure could not be established, so it is recorded as not
// reproducing rather than explained away (doctrine rule 10).
//
// D#8 — WHY THIS RULER CANNOT JUDGE THE `auto` POLICY, and neither can the recall
// arm. The `plain` and `auto?` columns exist to make that visible instead of
// re-derivable. Auto-escalation fires when the plain observation search returns
// fewer than AUTO_DEEP_MIN_RESULTS (3) rows. On this corpus the weakest query
// returns 5 and the mean is 21.42, at the pipeline's own window of
// max(limit*3, 60) — so the verdict is `no` on 12/12, and every number above
// describes EXPLICIT deep. The mechanism is that the escalation trigger is a
// COUNT while the AND->OR fallback's job is to make the count non-zero: it fires
// on 12/12 here and lifts each query over the floor. Auto can only fire where the
// OR search also comes back near-empty, and no fixture in this tree produces that.
// Pinned by tests/deep-search.test.mjs so a fixture that gains an escalating query
// goes red and reopens the question.
//
// THREE GATES WERE TESTED AGAINST BOTH ARMS AND REJECTED. Do not re-propose one
// without running this ruler AND the recall test:
//   1. Drop rewrite-variant lists whose search fired the AND->OR fallback.
//      Ruler said NO: deep R@10 0.7383 -> 0.3962, improved queries 10 -> 1. The
//      vocab-mismatch win IS OR-fallback on rewrites; the paraphrase usually does
//      not AND-match either.
//   2. Set-level absolute floor on the best |hybrid score| across variants.
//      Classes overlap: suite positives span 17.0..132.2, holdout negatives reach
//      34.5. A floor that clears the negatives cuts a third of the positives.
//   3. Cross-variant convergence (a row must appear in >=N variant lists).
//      Overlaps worse: on vm-7/vm-8/vm-12 the HOLDOUT arm scores at or above the
//      positive arm on maxAgree, on rows-in->=2-lists, and on top |score|.
//
// The signal analysis behind (2) and (3) says the discrimination is not available
// at this layer: with the right rows deleted, the engine returns the next-most-
// adjacent rows and they are indistinguishable by every quantity deepSearch can
// see. Closing this likely needs a signal the fusion does not currently have
// (a semantic score, or an abstain judgement), not a threshold over these ones.
//
// Usage:
//   node benchmark/deep-search-holdout.mjs [--json]
// Exit code is always 0 — this is a meter, not a gate. Compare runs by number.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestDb } from '../tests/test-helpers.mjs';
import { _resetVocabCache } from '../tfidf.mjs';
import { seedDatabase, seedVectors } from './benchmark.mjs';
import { deepSearch, shouldEscalateToDeep, AUTO_DEEP_MIN_RESULTS } from '../deep-search.mjs';
import { searchObservationsHybrid } from '../search-engine.mjs';
import { buildSearchFtsQuery, computePerSourceWindow } from '../lib/search-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

const readFixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

/**
 * The PLAIN observation search exactly as coreRunSearchPipeline runs it before deciding
 * whether to auto-escalate — same ctx shape, and the window from the shipped
 * `computePerSourceWindow`, which is `max(limit*3, 60)` and NOT deepSearch's internal
 * `max(limit, 20)`. The distinction matters because the escalation verdict is taken on
 * this UNSLICED row count (lib/search-core.mjs: `results.filter(r => r.source === 'obs')`,
 * before any slice to `limit`), so measuring the sliced page would understate it.
 *
 * @returns {{hits: number, orFallbackFired: boolean, ctx: object}}
 */
function plainObsSearch(db, q, limit) {
  const { perSourceLimit, perSourceOffset } = computePerSourceWindow(limit, 0);
  const ctx = {
    db,
    ftsQuery: buildSearchFtsQuery(q.query),
    args: {
      project: q.project ?? null,
      obs_type: q.type ?? null,
      importance: null,
      branch: null,
      include_noise: false,
    },
    epochFrom: null,
    epochTo: null,
    perSourceLimit,
    perSourceOffset,
    currentProject: q.project ?? null,
    limit,
    orFallbackFired: false,
  };
  const rows = searchObservationsHybrid(db, ctx);
  return { rows, hits: rows.length, orFallbackFired: ctx.orFallbackFired, ctx };
}

/**
 * Run the holdout precision arm.
 *
 * @param {object} [opts]
 * @param {object} [opts.corpus]   seed-data shape ({observations, sessions})
 * @param {object} [opts.suite]    {queries: [{id, query, project, type, relevant_ids}]}
 * @param {object} [opts.rewrites] query text -> string[] recorded variants
 * @param {number} [opts.limit=10] result cap per query (the FP@K K)
 * @returns {Promise<{perQuery: Array, meanFp: number, floodedQueries: number, total: number}>}
 */
export async function runHoldout({ corpus, suite, rewrites, limit = 10 } = {}) {
  corpus = corpus ?? readFixture('seed-data.json');
  suite = suite ?? readFixture('test-queries-vocab-mismatch.json');
  rewrites = rewrites ?? readFixture('rewrites-vocab-mismatch.json').rewrites;

  const perQuery = [];
  for (const q of suite.queries) {
    // The recorded rewrite for THIS query, resolved off the prompt's user slot —
    // same fake-llm contract as runDeepSearch, so a missing key degrades to
    // [original] rather than silently scoring a different pipeline.
    const fakeLlm = async (prompt) => {
      const text = ((prompt && prompt.user) || '').trim();
      const variants = rewrites[text];
      return Array.isArray(variants) && variants.length ? { variants } : null;
    };

    const held = new Set(q.relevant_ids ?? []);
    _resetVocabCache();
    const db = createTestDb();
    seedDatabase(db, { ...corpus, observations: corpus.observations.filter((o) => !held.has(o.id)) });
    seedVectors(db);
    try {
      // The escalation column (D#8). Measured BEFORE the deep run, on the same corpus,
      // because the shipped `auto` mode takes this verdict from the plain search and only
      // then pays for a rewrite. `wouldEscalate` uses the shipped predicate WITH `db`, so
      // it includes the corpus-size guard the pipeline applies -- not a re-implemented
      // `hits < 3`.
      const plain = plainObsSearch(db, q, limit);
      const wouldEscalate = shouldEscalateToDeep(plain.rows, plain.ctx, {
        db,
        project: q.project ?? null,
      });
      const { results, variants } = await deepSearch(
        db,
        { query: q.query, project: q.project, type: q.type, limit },
        { llm: fakeLlm },
      );
      // Nothing relevant remains in the corpus, so every returned row is a false
      // positive. No relevance judgement is made or needed.
      perQuery.push({
        id: q.id,
        query: q.query,
        held: held.size,
        variants: variants.length,
        fp: results.length,
        fpIds: results.map((r) => r.id),
        plainHits: plain.hits,
        plainOrFallback: plain.orFallbackFired,
        wouldEscalate,
      });
    } finally {
      db.close();
    }
  }

  const total = perQuery.reduce((a, p) => a + p.fp, 0);
  const plainTotal = perQuery.reduce((a, p) => a + p.plainHits, 0);
  return {
    perQuery,
    total,
    meanFp: perQuery.length ? total / perQuery.length : 0,
    floodedQueries: perQuery.filter((p) => p.fp >= 5).length,
    // D#8: how many of these queries the shipped `auto` mode would have escalated on its
    // own. If this is 0, every number above describes EXPLICIT deep and says nothing
    // about the auto policy (doctrine rule 9).
    escalatingQueries: perQuery.filter((p) => p.wouldEscalate).length,
    minPlainHits: perQuery.length ? Math.min(...perQuery.map((p) => p.plainHits)) : 0,
    meanPlainHits: perQuery.length ? plainTotal / perQuery.length : 0,
    orFallbackQueries: perQuery.filter((p) => p.plainOrFallback).length,
    escalationFloor: AUTO_DEEP_MIN_RESULTS,
    limit,
  };
}

/**
 * Self-checks (doctrine rule 5: a ruler must be able to say NO). Driven from main() so the
 * real run performs them, not just the unit test that imports them.
 * @param {object} res result of runHoldout
 */
export function runSelfChecks(res) {
  assertHoldoutRemovedRows(res);
  assertRewritesUsable(res);
  assertEscalationColumnIsTheShippedPredicate();
}

/** The holdout premise: if nothing was deleted, "every row is a false positive" is false. */
export function assertHoldoutRemovedRows(res) {
  const empty = res.perQuery.filter((p) => !p.held).map((p) => p.id);
  if (empty.length) {
    throw new Error(
      `holdout removed no rows for ${empty.join(', ')} — those queries carry no relevant_ids, ` +
        'so their FP count is not a false-positive count at all',
    );
  }
}

/** The rewrite premise: with no usable rewrite, deep collapses to baseline and FP means something else. */
export function assertRewritesUsable(res) {
  const degraded = res.perQuery.filter((p) => p.variants < 2).map((p) => p.id);
  if (degraded.length) {
    throw new Error(
      `no recorded rewrite for ${degraded.join(', ')} — deep degraded to the single-query ` +
        'baseline there, so this is not a measurement of deep search',
    );
  }
}

/**
 * The escalation column must be the SHIPPED FLOOR PREDICATE at the SHIPPED floor. A ruler
 * that re-implemented `hits < 3` would keep reading 0 after someone retuned the constant,
 * and the D#8 conclusion below would silently describe a policy that no longer ships.
 *
 * It is the floor predicate, NOT the whole production decision, and the difference is worth
 * stating rather than glossing: `lib/search-core.mjs` gates on
 * `deepMode === 'auto' && autoDeepLlmReady(env, llm) && shouldEscalateToDeep(...)`, and this
 * column omits the first two conjuncts. That direction is safe for the 0/N conclusion —
 * adding conjuncts can only lower an escalation count — but it means the column OVER-reports
 * relative to production, so never quote it as "production would escalate here".
 */
export function assertEscalationColumnIsTheShippedPredicate() {
  const rows = (n) => Array.from({ length: n }, () => ({ source: 'obs' }));
  const below = shouldEscalateToDeep(rows(AUTO_DEEP_MIN_RESULTS - 1), null, {});
  const at = shouldEscalateToDeep(rows(AUTO_DEEP_MIN_RESULTS), null, {});
  if (below !== true || at !== false) {
    throw new Error(
      `shouldEscalateToDeep does not switch at AUTO_DEEP_MIN_RESULTS=${AUTO_DEEP_MIN_RESULTS} ` +
        `(${AUTO_DEEP_MIN_RESULTS - 1} rows -> ${below}, ${AUTO_DEEP_MIN_RESULTS} rows -> ${at}); ` +
        'the escalation column no longer means what this ruler reports',
    );
  }
}

async function main() {
  const asJson = process.argv.includes('--json');
  const res = await runHoldout();
  runSelfChecks(res);
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log('\n─── Deep-search holdout (precision arm) ───');
  console.log('  Negatives are the suite queries asked of a corpus with their own');
  console.log('  relevant rows deleted. Correct answer for every query: 0 rows.\n');
  console.log('   FP@' + res.limit + '  held  vars  plain  or  auto?  query');
  for (const p of res.perQuery) {
    console.log(
      '   ' + String(p.fp).padStart(4),
      String(p.held).padStart(5),
      String(p.variants).padStart(5),
      String(p.plainHits).padStart(6),
      (p.plainOrFallback ? 'OR' : '  ').padStart(3),
      (p.wouldEscalate ? 'YES' : 'no').padStart(6),
      ' ' + p.id + ' — ' + p.query.slice(0, 40),
    );
  }
  console.log(
    `\n  mean FP@${res.limit} = ${res.meanFp.toFixed(2)}   queries with >=5 FP: ${res.floodedQueries}/${res.perQuery.length}`,
  );
  console.log('  (0.00 would mean deep search never answers a question the corpus cannot answer)');
  console.log(
    `\n  auto-escalation reach: ${res.escalatingQueries}/${res.perQuery.length} queries would escalate ` +
      `(floor ${res.escalationFloor} hits; observed min ${res.minPlainHits}, mean ${res.meanPlainHits.toFixed(2)})`,
  );
  console.log(
    `  AND->OR fallback fired on ${res.orFallbackQueries}/${res.perQuery.length} — that is what lifts the`,
  );
  console.log('  plain count over the floor, so the numbers above describe EXPLICIT deep. At 0/N this');
  console.log('  ruler cannot say anything about the auto policy (doctrine rule 9).\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
