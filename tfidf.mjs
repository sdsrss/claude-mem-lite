// tfidf.mjs — TF-IDF vector search engine
// Pure JS implementation, zero external dependencies.
// Provides tokenization, vocabulary building, vector computation,
// cosine similarity, vector search, and RRF merging.

import { cjkBigrams } from './utils.mjs';
import { BASE_STOP_WORDS } from './stop-words.mjs';
import { createHash } from 'crypto';
import { rrfAccumulate } from './lib/rrf.mjs';
import { liveObsFilterSql } from './lib/inject-search-core.mjs';

export const VOCAB_DIM = 512;
// Fraction of the vocab dimension reserved for the highest-IDF (rarest) terms when the
// candidate set exceeds `dim` and must be truncated. df×idf ("information gain") ranking
// peaks at MID document-frequency, so a pure-IG cut drops the rare freq≈2 / high-IDF tail
// FIRST — but those are exactly the discriminative identifiers (a filename / proper noun in
// 2-3 memories) a high-precision query needs. The quota guarantees that tail a slot budget;
// the rest fill by IG. No effect when candidates <= dim (audit P2-11 2026-07-24).
const VOCAB_RARE_TERM_FRACTION = 0.25;
export const MIN_COSINE_SIMILARITY = 0.05;
export const VECTOR_SCAN_LIMIT = 500;
// Reciprocal Rank Fusion constant. Higher k flattens the rank-position weighting
// (BM25 and vector lists contribute more equally); lower k lets the top few ranks
// dominate. 60 is the de-facto RRF default and balances the two retrievers here.
export const RRF_K = 60;

// Phase-1 disable of the TF-IDF vector arm (memory-quality audit 2026-06-27).
// The arm reads ~0 benchmark lift (ci-gate hybrid_over_bm25 = 0), pays a
// computeVector on every observation write, only scans the most-recent
// VECTOR_SCAN_LIMIT rows (misses older memories), and drifted unnoticed for
// months. Default OFF. To re-enable: set CLAUDE_MEM_VECTORS=1 AND run
// `claude-mem-lite maintain execute --ops rebuild_vectors` to repopulate vectors for
// observations created while disabled — re-enabling WITHOUT a rebuild leaves a
// partially-populated index (the primary + enrich/compress/optimize write paths all
// stopped writing while off) → silently degraded hybrid recall until the next
// rebuild. Tables + code are retained pending Phase-2 removal. Read at call time (not
// import) so tests + the benchmark A/B can toggle it via env.
export function vectorsEnabled() {
  return process.env.CLAUDE_MEM_VECTORS === '1';
}

const VOCAB_STOP_WORDS = new Set([
  ...BASE_STOP_WORDS,
  'now',
  'only',
  'still',
  'here',
  'there',
  'up',
  'out',
  'am',
]);

// ─── Porter Stemmer ──────────────────────────────────────────────────────────
// Minimal Porter stemmer (1980). Used to normalize tokens for the TF-IDF vocabulary and
// vectors (query + doc are BOTH stemmed here, so the vector arm is internally consistent).
// NOTE: this does NOT align with the FTS5 side — observations_fts uses FTS5's DEFAULT
// unicode61 tokenizer (no stemming). Anything that stems a term and then feeds it into an
// FTS5 MATCH must emit a SURFACE form, not a stem, or it matches nothing (see
// extractPRFTerms in search-scoring.mjs, audit P2-24 2026-07-24).

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

function isNoiseTerm(term) {
  if (VOCAB_STOP_WORDS.has(term)) return true;
  if (/^\d+$/.test(term)) return true;
  return false;
}

// ─── Tokenization ───────────────────────────────────────────────────────────

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * Tokenize text into terms for TF-IDF.
 * ASCII: lowercase + split + Porter stem (aligned with FTS5's porter tokenizer).
 * CJK: reuse cjkBigrams() for consistency with FTS5.
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

// ─── Vocabulary ─────────────────────────────────────────────────────────────

let _vocabCache = null;

/** Reset vocabulary cache (for testing). */
export function _resetVocabCache() {
  _vocabCache = null;
}

/**
 * Canonical TF-IDF vector text for an observation ROW (snake_case DB fields). Single source for
 * EVERY (re)build path — save, enrich, rebuild_vectors, cluster-merge, compress, normalize — so
 * they encode the identical field set and can't drift (V-F1). Mirrors the FTS-searchable columns
 * incl. lesson_learned + search_aliases (finding #8). `concepts` may be an array or a string.
 */
export function vecTextForRow(row) {
  if (!row) return '';
  const concepts = Array.isArray(row.concepts) ? row.concepts.join(' ') : row.concepts || '';
  return [row.title || '', row.narrative || '', concepts, row.lesson_learned || '', row.search_aliases || '']
    .filter(Boolean)
    .join(' ');
}

/**
 * Build global vocabulary (IDF table) from all active observations.
 * @param {object} db - better-sqlite3 database
 * @returns {{ terms: Map<string, {index: number, idf: number}>, version: string, dim: number } | null}
 */
export function buildVocabulary(db, { dim = VOCAB_DIM } = {}) {
  const rows = db
    .prepare(
      `
    SELECT title, narrative, concepts, lesson_learned, search_aliases FROM observations
    WHERE ${liveObsFilterSql('')}
  `,
    )
    .all();

  const N = rows.length;
  if (N === 0) return null;

  // Count document frequency for each term
  const df = new Map();
  for (const row of rows) {
    // V-F2: include lesson_learned + search_aliases so terms living only there get a vocab
    // dimension (else computeVector silently drops them — the exact paraphrase-bridge terms
    // search_aliases exists to carry). Mirrors vecTextForRow's field set.
    const text = [
      row.title || '',
      row.narrative || '',
      row.concepts || '',
      row.lesson_learned || '',
      row.search_aliases || '',
    ].join(' ');
    const docTerms = new Set(tokenize(text));
    for (const term of docTerms) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  // Compute IDF; rank by information gain (df × idf) for balanced discriminativeness.
  const idf = (freq) => Math.log(1 + N / (1 + freq));
  const candidates = [...df.entries()]
    .filter(([term, freq]) => !isNoiseTerm(term) && freq >= 2)
    .map(([term, freq]) => ({ term, df: freq, idf: idf(freq), ig: freq * idf(freq) }));

  // SELECTION (which terms survive when candidates exceed `dim`): a pure df×idf cut drops
  // the rarest, highest-IDF terms first (IG peaks at mid-df), blinding the arm to the
  // discriminative tail. Reserve VOCAB_RARE_TERM_FRACTION of the budget for the highest-IDF
  // terms, fill the rest by IG (audit P2-11). No-op when candidates <= dim.
  let selected;
  if (candidates.length <= dim) {
    selected = candidates;
  } else {
    const igBudget = dim - Math.floor(dim * VOCAB_RARE_TERM_FRACTION);
    const pick = new Map();
    for (const e of [...candidates].sort((a, b) => b.ig - a.ig)) {
      if (pick.size >= igBudget) break;
      pick.set(e.term, e);
    }
    for (const e of [...candidates].sort((a, b) => b.idf - a.idf)) {
      if (pick.size >= dim) break;
      if (!pick.has(e.term)) pick.set(e.term, e);
    }
    selected = [...pick.values()];
  }

  // INDEX ORDERING is by IG desc. Index order is cosmetic for retrieval — cosine is
  // permutation-invariant as long as query + doc share this mapping — but keeping the
  // frequent workhorses at low indices preserves the historical slot layout.
  const sortedTerms = selected.sort((a, b) => b.ig - a.ig).slice(0, dim);

  // Build terms map with index and IDF
  const terms = new Map();
  sortedTerms.forEach((entry, index) => {
    terms.set(entry.term, { index, idf: entry.idf });
  });

  // Version hash for staleness detection
  const termList = sortedTerms.map((e) => e.term).join(',');
  const version = createHash('md5').update(termList).digest('hex').slice(0, 12);

  const vocab = { terms, version, dim };
  _vocabCache = vocab;
  return vocab;
}

/**
 * Rebuild vocabulary from corpus AND persist to vocab_state table.
 * @param {object} db - better-sqlite3 database
 * @returns {object|null} The new vocabulary
 */
export function rebuildVocabulary(db, opts) {
  const vocab = buildVocabulary(db, opts);
  if (!vocab) return null;

  const insertStmt = db.prepare(
    'INSERT INTO vocab_state (term, term_index, idf, version, created_at_epoch) VALUES (?, ?, ?, ?, ?)',
  );
  const now = Date.now();
  db.transaction(() => {
    db.prepare('DELETE FROM vocab_state').run();
    for (const [term, entry] of vocab.terms) {
      insertStmt.run(term, entry.index, entry.idf, vocab.version, now);
    }
    // v2.47 P0-1: drop observation_vectors from earlier vocab versions.
    // Without this, rebuildVocabulary compounded the stale set on every call
    // (live DB measured 3282/6429 = 51% stale). vectorSearch filters by
    // vocab_version at query time, so stale rows were dead storage.
    try {
      db.prepare('DELETE FROM observation_vectors WHERE vocab_version != ?').run(vocab.version);
    } catch {
      /* table missing on legacy DBs — non-critical */
    }
  })();

  _vocabCache = vocab;
  return vocab;
}

/**
 * Get cached vocabulary, load from DB, or rebuild from corpus.
 * @param {object} db - better-sqlite3 database
 * @returns {object|null} vocabulary
 */
export function getVocabulary(db) {
  // Phase-1 choke point: when the vector arm is disabled there is no vocabulary to
  // serve. Returning null here makes EVERY vector write/read path skip via its
  // existing `if (vocab)` guard — including the enrich (hook-llm), compress
  // (compress-core) and optimize (hook-optimize) write paths that don't go through
  // insertObservationVector — so no path can be "missed" and observation_vectors
  // stays uniformly stale (not half-populated) while disabled. computeVector is
  // null-safe, so even a caller that skips its guard no-ops rather than crashes.
  if (!vectorsEnabled()) return null;
  if (_vocabCache) return _vocabCache;

  // Try loading from persisted vocab_state
  try {
    const rows = db
      .prepare('SELECT term, term_index, idf, version FROM vocab_state ORDER BY term_index')
      .all();
    if (rows.length > 0) {
      const terms = new Map();
      for (const r of rows) {
        terms.set(r.term, { index: r.term_index, idf: r.idf });
      }
      const vocab = { terms, version: rows[0].version, dim: VOCAB_DIM };
      _vocabCache = vocab;
      return vocab;
    }
  } catch {
    /* table may not exist in old/test DBs */
  }

  // Fallback: compute and persist (first run)
  return rebuildVocabulary(db);
}

// ─── Vector Computation ─────────────────────────────────────────────────────

/**
 * Compute TF-IDF vector for a text string.
 * @returns {Float32Array | null} L2-normalized vector, or null if empty/no matching terms
 */
export function computeVector(text, vocab) {
  if (!vocab || !text) return null;

  const tokens = tokenize(text);
  if (tokens.length === 0) return null;

  // Compute term frequency
  const tf = new Map();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }

  // Build TF-IDF vector with sublinear TF: 1 + log(tf)
  const vec = new Float32Array(vocab.dim);
  let hasNonZero = false;
  for (const [term, freq] of tf) {
    const entry = vocab.terms.get(term);
    if (entry) {
      vec[entry.index] = (1 + Math.log(freq)) * entry.idf;
      hasNonZero = true;
    }
  }

  if (!hasNonZero) return null;

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;

  return vec;
}

// ─── Cosine Similarity ──────────────────────────────────────────────────────

/**
 * Dot product of two L2-normalized Float32Arrays = cosine similarity.
 */
export function cosineSimilarity(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

// ─── Vector Search ──────────────────────────────────────────────────────────

/**
 * Search observation_vectors by cosine similarity.
 * @param {object} db - better-sqlite3 database
 * @param {Float32Array} queryVec - query vector
 * @param {object} opts - { project?, type?, vocabVersion, limit? }
 * @returns {{ id: number, similarity: number }[]}
 */
const VECTOR_TIME_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const VECTOR_MIN_RESULTS = 50; // fallback to full scan if time-window yields fewer

export function vectorSearch(
  db,
  queryVec,
  { project, type, vocabVersion, limit = VECTOR_SCAN_LIMIT, minCosine = MIN_COSINE_SIMILARITY },
) {
  if (!queryVec) return [];

  const now = Date.now();

  const wheres = [liveObsFilterSql('o'), 'ov.vocab_version = ?'];
  const params = [vocabVersion];

  if (project) {
    wheres.push('o.project = ?');
    params.push(project);
  }
  if (type) {
    wheres.push('o.type = ?');
    params.push(type);
  }

  // Time-window prefilter: try 90 days first, fallback to full if too few results
  const timeWheres = [...wheres, 'o.created_at_epoch > ?'];
  const timeParams = [...params, now - VECTOR_TIME_WINDOW_MS, limit];

  let rows = db
    .prepare(
      `
    SELECT ov.observation_id, ov.vector
    FROM observation_vectors ov
    JOIN observations o ON ov.observation_id = o.id
    WHERE ${timeWheres.join(' AND ')}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `,
    )
    .all(...timeParams);

  // Fallback: if time-window yields too few, scan without time constraint
  if (rows.length < VECTOR_MIN_RESULTS) {
    const fallbackParams = [...params, limit];
    rows = db
      .prepare(
        `
      SELECT ov.observation_id, ov.vector
      FROM observation_vectors ov
      JOIN observations o ON ov.observation_id = o.id
      WHERE ${wheres.join(' AND ')}
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `,
      )
      .all(...fallbackParams);
  }

  const results = [];
  for (const row of rows) {
    const vec = new Float32Array(
      row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength),
    );
    const sim = cosineSimilarity(queryVec, vec);
    if (sim > minCosine) results.push({ id: row.observation_id, similarity: sim });
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, 20);
}

// ─── RRF Merge ──────────────────────────────────────────────────────────────

/**
 * Reciprocal Rank Fusion: merge two ranked result lists.
 * @param {{ id: number }[]} bm25Results - FTS5 results (ranked by position)
 * @param {{ id: number }[]} vectorResults - Vector results (ranked by position)
 * @param {number} k - RRF constant (default 60)
 * @returns {{ id: number, rrfScore: number }[]}
 */
export function rrfMerge(bm25Results, vectorResults, k = RRF_K) {
  // Thin 2-list adapter over the shared RRF core (lib/rrf.mjs). Emits the minimal
  // { id, rrfScore } shape this module's callers (search-engine.mjs) expect; the
  // accumulator's best-rank row tracking is irrelevant here and ignored.
  return rrfAccumulate([bm25Results, vectorResults], k).map(({ id, score }) => ({ id, rrfScore: score }));
}
