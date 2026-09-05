#!/usr/bin/env node
// cjk-straddle-prevalence.mjs — READ-ONLY prevalence probe for D#31.
//
// QUESTION: how often does the CJK "straddle bigram" leak (nlp.mjs isCjkNoiseBigram
// keeps one-stop-char bigrams like 的全 / 么是) actually reach a real query's
// required/FTS set? The leak can ONLY bite when the bigram fallback path engages,
// and that path is short-circuited whenever ANY dictionary keyword matches
// (cjkPrecisionOk: required falls to bigrams only when extractCjkKeywords()==[]).
// So the leak's ceiling = "CJK queries with ZERO dictionary keyword match".
//
// This probe measures that ceiling on the real user_prompts corpus BEFORE anyone
// invests in a labelled recall benchmark or a position-aware straddle filter.
// It mutates nothing.
//
//   node benchmark/cjk-straddle-prevalence.mjs              # report
//   node benchmark/cjk-straddle-prevalence.mjs --examples=20
//   node benchmark/cjk-straddle-prevalence.mjs --json

import { openDb } from '../hook-shared.mjs';
import { extractCjkKeywords, cjkBigrams } from '../nlp.mjs';
import { CJK_STOP_WORDS } from './../stop-words.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const JSON_MODE = !!args.json;
const N_EX = parseInt(args.examples || '12', 10);

const CJK_RE = /[一-鿿㐀-䶿]/g;
const hasCjk2 = (s) => (s.match(CJK_RE) || []).length >= 2;

// Mirror nlp.mjs isCjkNoiseBigram (kept local so the probe is self-contained
// and independent of that fn's non-exported status).
function isNoiseBigram(bg) {
  if (CJK_STOP_WORDS.has(bg)) return true;
  return bg.length === 2 && CJK_STOP_WORDS.has(bg[0]) && CJK_STOP_WORDS.has(bg[1]);
}
// A "straddle suspect": survived the noise filter but has EXACTLY one stop char
// at an edge (的全 starts with 的; 么是 ends with 是). Real compounds (有效) can
// also land here — this is an UPPER bound on artifacts, not an exact count.
function isStraddleSuspect(bg) {
  if (bg.length !== 2 || isNoiseBigram(bg)) return false;
  const a = CJK_STOP_WORDS.has(bg[0]),
    b = CJK_STOP_WORDS.has(bg[1]);
  return (a && !b) || (!a && b);
}

const db = openDb();
const rows = db.prepare('SELECT DISTINCT prompt_text FROM user_prompts WHERE prompt_text IS NOT NULL').all();
db.close();

let totalCjk = 0; // queries with ≥2 CJK chars
let bigramPathEngaged = 0; // ZERO dictionary keyword match → bigram fallback (the ceiling)
let withStraddle = 0; // engaged AND ≥1 straddle-suspect bigram in required set
const straddleExamples = [];

for (const { prompt_text: q } of rows) {
  if (!q || !hasCjk2(q)) continue;
  totalCjk++;
  const keywords = extractCjkKeywords(q);
  if (keywords.length > 0) continue; // dictionary rescued it — leak can't bite
  bigramPathEngaged++;
  const required = cjkBigrams(q)
    .split(' ')
    .filter((b) => b && !isNoiseBigram(b));
  const suspects = required.filter(isStraddleSuspect);
  if (suspects.length > 0) {
    withStraddle++;
    if (straddleExamples.length < N_EX) {
      straddleExamples.push({ q: q.slice(0, 60), required, suspects });
    }
  }
}

const pct = (n, d) => (d === 0 ? '  n/a' : ((100 * n) / d).toFixed(1) + '%');

if (JSON_MODE) {
  console.log(
    JSON.stringify(
      {
        corpus: rows.length,
        totalCjk,
        bigramPathEngaged,
        withStraddle,
        bigramPathEngagedPctOfCjk: totalCjk ? bigramPathEngaged / totalCjk : null,
        withStraddlePctOfCjk: totalCjk ? withStraddle / totalCjk : null,
        examples: straddleExamples,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log('D#31 — CJK straddle-bigram PREVALENCE probe (READ-ONLY, user_prompts corpus)\n');
console.log(`  distinct prompts scanned ............ ${rows.length}`);
console.log(`  with ≥2 CJK chars ................... ${totalCjk}  (${pct(totalCjk, rows.length)} of corpus)`);
console.log(
  `  bigram path ENGAGED (0 dict kw) ..... ${bigramPathEngaged}  (${pct(bigramPathEngaged, totalCjk)} of CJK)  ← leak ceiling`,
);
console.log(
  `  …of those, ≥1 straddle SUSPECT ...... ${withStraddle}  (${pct(withStraddle, totalCjk)} of CJK)  ← upper bound on real bite`,
);
console.log('');
console.log('  NOTE: straddle SUSPECT over-counts — genuine one-stop-char compounds (有效/目的)');
console.log('        land in the same bucket. The true artifact rate is ≤ this number.\n');

if (straddleExamples.length) {
  console.log(`  examples (q → required set, suspects marked):`);
  for (const e of straddleExamples) {
    console.log(`   • "${e.q}"`);
    console.log(`       required=[${e.required.join(' ')}]  suspect=[${e.suspects.join(' ')}]`);
  }
  console.log('');
}

console.log('READING:');
console.log('  • If "bigram path engaged" is a tiny fraction of CJK queries, D#31 cannot');
console.log('    meaningfully move recall — the dictionary path already rescues the rest.');
console.log('    → expand CJK_COMPOUNDS (upstream, #8259 principle); skip the benchmark + filter.');
console.log('  • If it is a LARGE fraction, the labelled recall benchmark is justified before');
console.log('    touching isCjkNoiseBigram, because precision/recall trades need a measured oracle.');
