// tfidf.mjs — tokenization + Porter stemming.
//
// NAME IS HISTORICAL. This module was the TF-IDF vector search engine (vocabulary, vectors,
// cosine similarity, vector search, RRF merge). Phase-1 (v3.17.0, 2026-06-27) gated that arm
// off; Phase-2 removed it. What is left is the text-normalization half, which was never part
// of the vector arm and has live consumers on the DEFAULT retrieval path:
//   - porterStem  -> search-scoring.mjs (PRF term extraction)
//   - tokenize    -> benchmark/adoption-cosine.mjs
// RRF_K moved to lib/rrf.mjs, its actual home. See tests/vector-arm-removed.test.mjs for the
// removal contract and tasks/specs/vector-arm-removal.md for the measurements behind it.

import { cjkBigrams } from './utils.mjs';

// ─── Porter Stemmer ──────────────────────────────────────────────────────────
// Minimal Porter stemmer (1980). It used to normalize tokens for the TF-IDF vocabulary,
// where query and document were both stemmed so the vector arm stayed internally
// consistent; with that arm gone the surviving consumer is extractPRFTerms.
// NOTE: this does NOT align with the FTS5 side — observations_fts uses FTS5's DEFAULT
// unicode61 tokenizer (no stemming). Anything that stems a term and then feeds it into an
// FTS5 MATCH must emit a SURFACE form, not a stem, or it matches nothing (see
// extractPRFTerms in search-scoring.mjs, audit P2-24 2026-07-24). That hazard is now the
// ONLY reason this stemmer is here, so it is the thing to preserve if it ever moves.

const step2map = {
  ational: 'ate',
  tional: 'tion',
  enci: 'ence',
  anci: 'ance',
  izer: 'ize',
  abli: 'able',
  alli: 'al',
  entli: 'ent',
  eli: 'e',
  ousli: 'ous',
  ization: 'ize',
  ation: 'ate',
  ator: 'ate',
  alism: 'al',
  iveness: 'ive',
  fulness: 'ful',
  ousness: 'ous',
  aliti: 'al',
  iviti: 'ive',
  biliti: 'ble',
  logi: 'log',
};
const step3map = {
  icate: 'ic',
  ative: '',
  alize: 'al',
  iciti: 'ic',
  ical: 'ic',
  ful: '',
  ness: '',
};

function consonant(word, i) {
  const c = word[i];
  if (/[aeiou]/.test(c)) return false;
  if (c === 'y') return i === 0 || !/[aeiou]/.test(word[i - 1]);
  return true;
}

function measure(word) {
  let m = 0,
    prev = true; // start assuming consonant context
  for (let i = 0; i < word.length; i++) {
    const c = consonant(word, i);
    if (!c && prev) m++;
    prev = c;
  }
  return m;
}

function hasVowel(word) {
  for (let i = 0; i < word.length; i++) if (!consonant(word, i)) return true;
  return false;
}

function endsDouble(word) {
  const l = word.length;
  return l >= 2 && word[l - 1] === word[l - 2] && consonant(word, l - 1);
}

function cvc(word) {
  const l = word.length;
  return (
    l >= 3 &&
    consonant(word, l - 1) &&
    !consonant(word, l - 2) &&
    consonant(word, l - 3) &&
    !/[wxy]/.test(word[l - 1])
  );
}

export function porterStem(w) {
  if (w.length <= 2) return w;
  let word = w;

  // Step 1a
  if (word.endsWith('sses')) word = word.slice(0, -2);
  else if (word.endsWith('ies')) word = word.slice(0, -2);
  else if (!word.endsWith('ss') && word.endsWith('s')) word = word.slice(0, -1);

  // Step 1b
  let step1b2 = false;
  if (word.endsWith('eed')) {
    if (measure(word.slice(0, -3)) > 0) word = word.slice(0, -1);
  } else if (word.endsWith('ed') && hasVowel(word.slice(0, -2))) {
    word = word.slice(0, -2);
    step1b2 = true;
  } else if (word.endsWith('ing') && hasVowel(word.slice(0, -3))) {
    word = word.slice(0, -3);
    step1b2 = true;
  }
  if (step1b2) {
    if (word.endsWith('at') || word.endsWith('bl') || word.endsWith('iz')) word += 'e';
    else if (endsDouble(word) && !/[lsz]/.test(word[word.length - 1])) word = word.slice(0, -1);
    else if (measure(word) === 1 && cvc(word)) word += 'e';
  }

  // Step 1c
  if (word.endsWith('y') && hasVowel(word.slice(0, -1))) {
    word = word.slice(0, -1) + 'i';
  }

  // Step 2
  for (const [suffix, repl] of Object.entries(step2map)) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (measure(stem) > 0) word = stem + repl;
      break;
    }
  }

  // Step 3
  for (const [suffix, repl] of Object.entries(step3map)) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (measure(stem) > 0) word = stem + repl;
      break;
    }
  }

  // Step 4
  const step4suffixes = [
    'al',
    'ance',
    'ence',
    'er',
    'ic',
    'able',
    'ible',
    'ant',
    'ement',
    'ment',
    'ent',
    'ion',
    'ou',
    'ism',
    'ate',
    'iti',
    'ous',
    'ive',
    'ize',
  ];
  for (const suffix of step4suffixes) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (measure(stem) > 1) {
        if (suffix === 'ion' && stem.length > 0 && /[st]$/.test(stem)) word = stem;
        else if (suffix !== 'ion') word = stem;
      }
      break;
    }
  }

  // Step 5a
  if (word.endsWith('e')) {
    const stem = word.slice(0, -1);
    if (measure(stem) > 1 || (measure(stem) === 1 && !cvc(stem))) word = stem;
  }

  // Step 5b
  if (measure(word) > 1 && endsDouble(word) && word.endsWith('l')) {
    word = word.slice(0, -1);
  }

  return word;
}

// ─── Tokenization ───────────────────────────────────────────────────────────

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * Tokenize text into stemmed terms.
 * ASCII: lowercase + split + Porter stem.
 * CJK: reuse cjkBigrams() for consistency with FTS5.
 *
 * Built for the TF-IDF vocabulary, which is gone; the surviving consumer is
 * benchmark/adoption-cosine.mjs, which builds its own bags. The "aligned with FTS5's
 * porter tokenizer" claim the old docblock made here is NOT true and was already
 * contradicted by the stemmer's own note above — observations_fts uses unicode61 with no
 * stemming, so these terms are stems and FTS5's are surface forms.
 */
export function tokenize(text) {
  if (!text) return [];
  text = String(text).toLowerCase();

  const tokens = [];

  // Split into ASCII and CJK segments
  const parts = text.split(/([\u4e00-\u9fff\u3400-\u4dbf]+)/);
  for (const part of parts) {
    if (CJK_RANGE.test(part)) {
      // CJK: use bigrams for consistency with FTS5 indexing
      const bigrams = cjkBigrams(part);
      if (bigrams) {
        for (const t of bigrams.split(/\s+/)) {
          if (t.length >= 2) tokens.push(t);
        }
      }
    } else {
      // ASCII: split on non-alphanumeric, then Porter stem
      for (const t of part.split(/[^a-z0-9]+/)) {
        if (t.length >= 2) tokens.push(porterStem(t));
      }
    }
  }

  return tokens;
}
