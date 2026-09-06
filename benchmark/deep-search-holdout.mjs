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
// no basis to return. The single-query baseline returns 1-2 rows on the same
// negatives — the union across four paraphrase variants is what fills the page,
// and RRF fuses by RANK, so no magnitude signal survives into the merge for a
// downstream floor to act on.
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
import { deepSearch } from '../deep-search.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

const readFixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

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
      });
    } finally {
      db.close();
    }
  }

  const total = perQuery.reduce((a, p) => a + p.fp, 0);
  return {
    perQuery,
    total,
    meanFp: perQuery.length ? total / perQuery.length : 0,
    floodedQueries: perQuery.filter((p) => p.fp >= 5).length,
    limit,
  };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const res = await runHoldout();
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log('\n─── Deep-search holdout (precision arm) ───');
  console.log('  Negatives are the suite queries asked of a corpus with their own');
  console.log('  relevant rows deleted. Correct answer for every query: 0 rows.\n');
  console.log('   FP@' + res.limit + '  held  vars  query');
  for (const p of res.perQuery) {
    console.log(
      '   ' + String(p.fp).padStart(4),
      String(p.held).padStart(5),
      String(p.variants).padStart(5),
      ' ' + p.id + ' — ' + p.query.slice(0, 46),
    );
  }
  console.log(
    `\n  mean FP@${res.limit} = ${res.meanFp.toFixed(2)}   queries with >=5 FP: ${res.floodedQueries}/${res.perQuery.length}`,
  );
  console.log('  (0.00 would mean deep search never answers a question the corpus cannot answer)\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
