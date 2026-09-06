// nlp.mjs -- FTS5 query building, synonym expansion, CJK tokenization.
// Extracted from utils.mjs for focused module boundaries.

import { BASE_STOP_WORDS, CJK_STOP_WORDS } from './stop-words.mjs';
import { SYNONYM_MAP, CJK_COMPOUNDS } from './synonyms.mjs';

// Re-export for backward compatibility (consumers import from nlp.mjs or utils.mjs)
export { SYNONYM_MAP, CJK_COMPOUNDS };

// ─── FTS5 Constants ──────────────────────────────────────────────────────────

const FTS5_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * True if a CJK bigram is pure grammatical noise that should not enter an FTS query
 * or the precision gate's `required` set. CJK_STOP_WORDS holds single-char particles
 * (的/了/是…) plus a few whole multi-char fillers (什么/怎么…); callers used to test a
 * 2-char bigram with a bare `CJK_STOP_WORDS.has(bg)`, which only caught the whole-filler
 * case — so a particle-pair bigram like `的了` / `了是` slipped through and (a) forced an
 * unsatisfiable AND term and (b) made an all-particle query's `required` set non-empty,
 * wrongly rejecting every candidate. We reject a bigram when it IS a known filler OR when
 * BOTH characters are single-char stop words. A bigram with only ONE stop char (有效, 目的)
 * is deliberately kept — those are real compounds, and distinguishing a boundary-straddle
 * (的全) from a genuine compound needs a dictionary/recall benchmark (deferred).
 */
function isCjkNoiseBigram(bg) {
  if (CJK_STOP_WORDS.has(bg)) return true;
  return bg.length === 2 && CJK_STOP_WORDS.has(bg[0]) && CJK_STOP_WORDS.has(bg[1]);
}

// Sort by length descending for greedy matching
const CJK_SORTED = [...CJK_COMPOUNDS].sort((a, b) => b.length - a.length);

/**
 * Generate search tokens from CJK text using dictionary-first tokenization.
 * Compound words are emitted whole; remaining chars use bigram fallback.
 * "修复了数据库崩溃" → "修复 数据库 崩溃" (3 clean tokens)
 * vs old bigram: "修复 复了 了数 数据 据库 库崩 崩溃" (7 noisy tokens)
 * @param {string} text Input text containing CJK characters
 * @returns {string} Space-separated tokens
 */
export function cjkBigrams(text) {
  if (!text) return '';
  const runs = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g) || [];
  const tokens = [];
  for (const run of runs) {
    let i = 0;
    while (i < run.length) {
      let matched = false;
      // Greedy dictionary match (longest first)
      for (const word of CJK_SORTED) {
        if (i + word.length <= run.length && run.slice(i, i + word.length) === word) {
          tokens.push(word);
          i += word.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Fallback: bigram for unknown compound
        if (i + 1 < run.length) {
          tokens.push(run[i] + run[i + 1]);
        }
        i++;
      }
    }
  }
  return [...new Set(tokens)].join(' ');
}

// ─── CJK Keyword Extraction ─────────────────────────────────────────────────

// Extract known CJK words (from SYNONYM_MAP) out of unsegmented CJK text.
// Greedy longest-match: "数据库的全文搜索" → ["数据库", "搜索"] (skips particles/unknown).
const _cjkSynonymKeys = [...SYNONYM_MAP.keys()]
  .filter((k) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(k))
  .sort((a, b) => b.length - a.length); // longest first

export function extractCjkSynonymTokens(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const key of _cjkSynonymKeys) {
      if (text.startsWith(key, i)) {
        found.push(key);
        i += key.length;
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }
  return found;
}

// Merged CJK dictionary: CJK_COMPOUNDS + CJK keys from SYNONYM_MAP — sorted longest first.
// Gives broadest coverage: "搜索" from SYNONYM_MAP + "函数" from CJK_COMPOUNDS.
const _cjkMergedKeys = [...new Set([...CJK_COMPOUNDS, ..._cjkSynonymKeys])].sort(
  (a, b) => b.length - a.length,
);

/**
 * Extract CJK keywords using merged dictionary (CJK_COMPOUNDS + SYNONYM_MAP keys).
 * Broader than either source alone. Filters CJK stop words.
 * "这个函数是做什么的" → ["函数"] (not noisy bigrams)
 * "修复数据库性能优化" → ["修复", "数据库", "性能", "优化"]
 * "之前修复的FTS搜索排序" → ["修复", "搜索", "排序"]
 */
export function extractCjkKeywords(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    if (!/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text[i])) {
      i++;
      continue;
    }
    let matched = false;
    for (const word of _cjkMergedKeys) {
      if (text.startsWith(word, i) && !CJK_STOP_WORDS.has(word)) {
        found.push(word);
        i += word.length;
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }
  return found;
}

/**
 * Extract CJK patterns suitable for SQL LIKE fallback when FTS5 fails on CJK text.
 * Uses dictionary extraction + bigram fallback for unmatched portions.
 * @param {string} query Raw query text
 * @returns {string[]} CJK patterns (≥2 chars each), empty if no CJK content
 */
export function extractCjkLikePatterns(query) {
  if (!query || !/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/.test(query)) return [];
  const keywords = extractCjkKeywords(query);
  // Bigrams for unmatched CJK portions \u2014 but only from pure-CJK whitespace tokens.
  // Mixed-script tokens (e.g. "xyzAbc\u4e0d\u5b58\u5728neverhit") behave as identifier-like
  // literals; LIKE-OR'ing the CJK-suffix bigrams matches unrelated docs containing
  // common fragments. Mirrors the FTS-side guard in sanitizeFtsQuery.
  let remainder = query;
  for (const w of keywords) remainder = remainder.split(w).join(' ');
  const pureCjkOnly = remainder
    .split(/\s+/)
    .filter((t) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(t) && !/[A-Za-z0-9]/.test(t))
    .join(' ');
  const bigrams = pureCjkOnly ? cjkBigrams(pureCjkOnly).split(' ').filter(Boolean) : [];
  return [...new Set([...keywords, ...bigrams])];
}

/**
 * Post-FTS precision filter for CJK queries.
 *
 * Background: this build's FTS5 unicode61 tokenizer indexes an entire CJK run
 * as ONE token (it does NOT split each CJK character). CJK text is made
 * searchable by the write path, which stores the content plus its space-
 * separated overlapping bigrams; a query is likewise reduced to bigrams. An
 * application-layer bigram query therefore matches via those stored bigrams,
 * and after the AND→OR fallback (relaxFtsQueryToOr) any document sharing even a
 * single query bigram becomes a hit — extremely permissive in Chinese prose,
 * where common bigrams recur across unrelated topics.
 *
 * Precision check: given the raw query and a candidate result's full text,
 * require that at least `threshold` fraction of the query's CJK bigrams
 * (or dictionary words, if any matched) appear as contiguous substrings in
 * the result. Non-CJK queries bypass this filter entirely.
 *
 * Applied only to the prompts/user-prompt path — observations have richer
 * rerank + low-signal filtering that already control noise there. Also,
 * obs-side synonym expansion ("查询"→"(查询 OR query OR search)") is a
 * legitimate recall mechanism that this filter would break.
 *
 * Threshold default 0.2 is tunable via `CLAUDE_MEM_CJK_PREC_MIN` env var.
 * Explicit threshold arg still overrides the env value — tests and in-code
 * callers with domain context stay authoritative.
 *
 * Default was tuned from 0.3 → 0.2 after a 20-query production-DB fixture
 * showed 0.3 over-rejected legitimate multi-bigram queries whose dict-
 * keyword coverage was incomplete (e.g. "同义词扩展" — neither compound
 * is in CJK_COMPOUNDS → 4 bigrams required, single-keyword match only
 * 25% < 30% rejected 19/20 real hits). At 0.2, pure-noise reduction stays
 * ≥85% on noise fixture while SIG-6 recall recovered to 100%.
 *
 * @param {string} query Raw query text
 * @param {string} text Candidate result text
 * @param {number} [threshold] Fraction of patterns that must match. If
 *   omitted, reads CLAUDE_MEM_CJK_PREC_MIN (default 0.2).
 * @returns {boolean}
 */
export function cjkPrecisionOk(query, text, threshold) {
  if (threshold === undefined) {
    const envVal = process.env.CLAUDE_MEM_CJK_PREC_MIN;
    const parsed = envVal ? parseFloat(envVal) : NaN;
    threshold = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.2;
  }
  if (!query || !text) return true;
  if (!/[一-鿿㐀-䶿]{2,}/.test(query)) return true;
  const keywords = extractCjkKeywords(query);
  const required =
    keywords.length > 0
      ? keywords
      : cjkBigrams(query)
          .split(' ')
          .filter((b) => b && !isCjkNoiseBigram(b));
  if (required.length === 0) return true;
  const hit = required.filter((w) => text.includes(w)).length;
  return hit / required.length >= threshold;
}

// ─── FTS5 Token Formatting ──────────────────────────────────────────────────

// Format a term for FTS5: quote if it contains spaces, hyphens, or special chars
function ftsToken(term) {
  // Bare tokens are safe if purely alphanumeric or CJK characters
  if (/^[a-zA-Z0-9\u4e00-\u9fff\u3400-\u4dbf]+$/.test(term)) return term;
  return `"${term.replace(/"/g, '""')}"`;
}

export function expandToken(token) {
  const synonyms = SYNONYM_MAP.get(token.toLowerCase());
  if (!synonyms || synonyms.size === 0) return ftsToken(token);
  // FTS5 OR group: (original OR synonym1 OR "multi word synonym")
  const parts = [ftsToken(token)];
  for (const syn of synonyms) {
    parts.push(ftsToken(syn));
  }
  return `(${parts.join(' OR ')})`;
}

// ─── Stop Words ──────────────────────────────────────────────────────────────

// Orphan stems left when apostrophe-splitting contractions ("I've"→"ve",
// "wouldn't"→"wouldn"). Non-words only — they'd otherwise survive as required
// AND terms and silently shrink recall. Ambiguous real words are intentionally
// excluded so legitimate queries for them still work: don/won/haven/can, and
// 're' ("re:"/regarding) — even though that leaves the they're/we're artifact,
// dropping a real word is the worse failure.
const CONTRACTION_FRAGMENTS = [
  've',
  'll',
  'doesn',
  'didn',
  'isn',
  'wasn',
  'aren',
  'weren',
  'wouldn',
  'couldn',
  'shouldn',
  'hasn',
  'hadn',
  'mustn',
  'needn',
  'mightn',
];

export const FTS_STOP_WORDS = new Set([...BASE_STOP_WORDS, ...CONTRACTION_FRAGMENTS]);

// ─── FTS5 Query Sanitization ─────────────────────────────────────────────────

/**
 * Sanitize and expand a user query into a valid FTS5 query string.
 * Strips special characters, expands synonyms, and joins with AND/space.
 *
 * Unbounded by default — an explicit `search` from a human should search what they
 * typed. The two caps exist for the AUTOMATIC surface (audit 2026-08-22 P2-13):
 * UserPromptSubmit runs this on every prompt the user sends, with only a 64KB byte
 * guard upstream, and cost grows with prompt length: 0.8ms on a normal prompt, 6.2ms
 * on a 64KB ASCII one, 31.8ms on a 64KB CJK one (extractCjkKeywords is O(len x dict)
 * over an unsegmented run). That is paid before the model sees the turn.
 *
 * @param {string} query Raw user search query
 * @param {object} [opts]
 * @param {number} [opts.maxChars] Truncate the raw query first (bounds CJK segmentation,
 *   which sees one huge token where ASCII sees many small ones).
 * @param {number} [opts.maxTokens] Keep at most this many meaningful terms, applied
 *   after stopword filtering and before expansion.
 * @returns {string|null} FTS5-safe query or null if empty
 */
export function sanitizeFtsQuery(query, opts = {}) {
  if (!query) return null;
  const { maxChars = 0, maxTokens = 0 } = opts;
  const cleaned = (maxChars > 0 ? String(query).slice(0, maxChars) : query)
    // Strip ASCII control chars / NUL FIRST. A NUL survives tokenization (it's not
    // \s), gets phrase-quoted by expandToken, and then terminates SQLite's C string
    // mid-phrase → FTS5 "unterminated string" throw, breaking the documented
    // "never throws on MATCH" invariant. The metachar class below doesn't cover them.
    // eslint-disable-next-line no-control-regex -- intentional: stripping control chars IS the fix
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    // Apostrophe variants → space, matching FTS5 unicode61's own tokenization
    // (it splits on apostrophe: "doesn't" is indexed as "doesn"+"t"). Without
    // this, a possessive/contraction ("sister's", "What's") would phrase-quote
    // to "sister s" (adjacency) and miss the bare-word mention ("my sister") in
    // the doc, and contraction stems never reach the stopword filter. Straight
    // ('), curly (' '), and modifier (ʼ) apostrophes all normalized.
    .replace(/['‘’ʼ]/g, ' ')
    .replace(/[{}()[\]^~*:"\\]/g, ' ')
    .replace(/(^|\s)-/g, '$1')
    .trim();
  if (!cleaned) return null;
  let tokens = cleaned
    .split(/\s+/)
    // Trim leading/trailing sentence punctuation (. , ? ! ; …) from each token.
    // Natural-language queries end in "?" and clauses in ",": left on, the final
    // (most salient) token rides as "bug?"/"month," which (a) misses the synonym
    // map → no OR-expansion, and (b) gets phrase-quoted as a literal by
    // expandToken. Edges only — internal dots/hyphens (cli.mjs, gardening-related)
    // are preserved so filenames/compounds still phrase-match.
    .map((t) => t.replace(/^[.,;:!?]+|[.,;:!?]+$/g, ''))
    .filter(
      (t) =>
        t &&
        !/^-+$/.test(t) &&
        !FTS5_KEYWORDS.has(t.toUpperCase()) &&
        !/^NEAR(\/\d*)?$/i.test(t) &&
        // Skip single ASCII-letter tokens — too noisy for FTS5 (CJK single chars handled separately below)
        !(t.length === 1 && /^[a-zA-Z]$/.test(t)) &&
        // Drop tokens with NO index-able character — emoji 💥, symbols ★☆✦, pure
        // punctuation. unicode61 strips those at index time, so ftsToken would phrase-quote
        // such a token ("💥") into a REQUIRED AND term that can never match → strict FTS
        // returns 0 (and a lone-emoji query has no OR recovery). Gate on any Unicode LETTER
        // or NUMBER (\p{L}/\p{N}), NOT an ASCII+Han allowlist: unicode61 indexes every
        // script's letters (Cyrillic / Greek / kana / Hangul / Thai / accented Latin …), so
        // an allowlist silently killed search for all non-Latin/non-Han scripts (round-5
        // review catch). Letters are kept; only true symbols/emoji/punctuation are dropped.
        /[\p{L}\p{N}]/u.test(t),
    );
  // Filter stop words (but keep all if filtering would empty the query)
  const filtered = tokens.filter((t) => !FTS_STOP_WORDS.has(t.toLowerCase()));
  if (filtered.length > 0) tokens = filtered;
  // Cap AFTER stopword filtering and BEFORE expansion: the terms kept are meaningful
  // ones, and everything downstream (CJK segmentation, synonym expansion, bigrams) is
  // per-token work that the cap therefore bounds too.
  if (maxTokens > 0 && tokens.length > maxTokens) tokens = tokens.slice(0, maxTokens);
  // Split unsegmented CJK tokens into known vocabulary words using CJK_COMPOUNDS dictionary.
  // Uses broader dictionary than synonym-only extraction for better recall.
  // e.g. "这个函数是做什么的" → ["函数"] (not noisy bigrams)
  const expandedTokens = [];
  let cjkExtracted = false;
  for (const t of tokens) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(t) && t.length > 2) {
      const cjkWords = extractCjkKeywords(t);
      if (cjkWords.length > 0) {
        expandedTokens.push(...cjkWords);
        cjkExtracted = true;
        // Preserve unmatched CJK portions as bigrams (don't silently drop them)
        const matched = new Set(cjkWords);
        let remainder = t;
        for (const w of matched) remainder = remainder.split(w).join(' ');
        const gapBigrams = cjkBigrams(remainder);
        if (gapBigrams) {
          for (const bg of gapBigrams.split(' ')) {
            if (bg && !isCjkNoiseBigram(bg) && !matched.has(bg)) expandedTokens.push(bg);
          }
        }
        // Preserve embedded Latin/English identifiers glued into the CJK token — e.g. the
        // "redis" in "redis缓存问题". extractCjkKeywords + cjkBigrams only see CJK runs, so
        // without this the Latin anchor (often the single most precise term — a proper noun
        // like redis/grafana/oauth with no CJK synonym) was dropped, zeroing recall on
        // whitespace-free mixed-script prompts. Mirrors the embedded-
        // English extraction. Lowercased for parity with the write-path unicode61 folding.
        for (const en of remainder.match(/[a-zA-Z]{2,}/g) || []) {
          const low = en.toLowerCase();
          if (!FTS_STOP_WORDS.has(low) && !expandedTokens.includes(low)) expandedTokens.push(low);
        }
        continue;
      }
      // No dictionary word matched. For a PURE-CJK run, pushing the whole
      // unsegmented token creates a required AND term that matches neither the
      // stored full-run token nor its overlapping bigrams: the write path stores
      // content + space-separated bigrams, so a run like "同义词扩展" is indexed
      // only as the longer whole-run token AND as 同义/义词/词扩/扩展 — never as
      // "同义词扩展" itself. The strict AND is thus unsatisfiable (strict FTS = 0);
      // only relaxFtsQueryToOr in the callers salvaged recall. Emit the non-noise
      // bigrams the index actually holds instead. Mixed-script tokens (latin+CJK,
      // e.g. "xyzAbc不存在") stay whole — the latin portion is a literal anchor and
      // bigramming the CJK suffix over-recalls (mirrors the bigram guard below).
      if (!/[A-Za-z0-9]/.test(t)) {
        const fallbackBigrams = cjkBigrams(t)
          .split(' ')
          .filter((bg) => bg && !isCjkNoiseBigram(bg));
        if (fallbackBigrams.length > 0) {
          expandedTokens.push(...fallbackBigrams);
          continue;
        }
      }
    }
    expandedTokens.push(t);
  }
  tokens = expandedTokens;
  if (tokens.length === 0) return null;
  // Replace single CJK character tokens with bigrams for better phrase matching.
  // Individual CJK chars ("系","统") are too noisy; bigrams ("系统") capture compound words.
  // Skip bigrams when CJK synonym extraction already produced meaningful tokens —
  // bigrams joined with AND would make the query too restrictive.
  // Also skip for mixed-script tokens (e.g. "xyzAbc不存在neverhit"): the latin portion
  // is already a strong literal anchor; bigramming the CJK suffix lets short fragments
  // like "存在" match alone after AND→OR fallback, exploding recall onto unrelated docs.
  let bigrams = null;
  if (!cjkExtracted) {
    const pureCjkTokens = tokens.filter((t) => /[一-鿿㐀-䶿]/.test(t) && !/[A-Za-z0-9]/.test(t));
    if (pureCjkTokens.length > 0) bigrams = cjkBigrams(pureCjkTokens.join(' '));
  }
  const bigramSet = new Set(bigrams ? bigrams.split(' ').filter((b) => b && !isCjkNoiseBigram(b)) : []);
  const hasBigrams = bigramSet.size > 0;
  const finalTokens = [];
  const seen = new Set();
  const rawTokensSeen = new Set(); // track raw tokens to prevent bigram duplicates
  for (const t of tokens) {
    // Skip single CJK characters when we have bigrams — they're subsumed by bigram tokens
    if (hasBigrams && /^[\u4e00-\u9fff\u3400-\u4dbf]$/.test(t)) continue;
    const expanded = expandToken(t);
    if (!seen.has(expanded)) {
      seen.add(expanded);
      rawTokensSeen.add(t);
      finalTokens.push(expanded);
    }
  }
  for (const bg of bigramSet) {
    if (!seen.has(bg) && !rawTokensSeen.has(bg)) {
      seen.add(bg);
      finalTokens.push(bg);
    }
  }
  if (finalTokens.length === 0) return null;
  // FTS5 requires explicit AND after parenthesized OR groups
  const hasGroup = finalTokens.some((e) => e.startsWith('('));
  return finalTokens.join(hasGroup ? ' AND ' : ' ');
}

/**
 * Relax an AND-joined FTS5 query to OR-joined for fallback search.
 * Only useful when the original query has multiple tokens (single-token queries
 * are already as relaxed as possible).
 * @param {string} ftsQuery Original AND-joined FTS5 query from sanitizeFtsQuery
 * @returns {string|null} OR-joined query, or null if relaxation wouldn't help
 */
export function relaxFtsQueryToOr(ftsQuery) {
  if (!ftsQuery) return null;
  // Replace AND joins with OR — handles both explicit " AND " and implicit space joins
  const orQuery = ftsQuery.replace(/ AND /g, ' OR ');
  // If no AND was present, tokens are space-joined (implicit AND); convert to OR
  if (orQuery === ftsQuery && !ftsQuery.includes(' OR ')) {
    const parts = ftsQuery.split(/\s+/);
    if (parts.length < 2) return null; // single token — OR won't help
    return parts.join(' OR ');
  }
  return orQuery !== ftsQuery ? orQuery : null;
}
