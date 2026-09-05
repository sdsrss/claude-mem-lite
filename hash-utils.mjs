// claude-mem-lite: Hashing and similarity utilities
// Extracted from utils.mjs for focused responsibility

/**
 * Compute word-level Jaccard similarity between two strings.
 * @param {string} a First string
 * @param {string} b Second string
 * @returns {number} Similarity score between 0 and 1
 */
export function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;
  // Strip trailing punctuation from tokens to match MinHash normalization
  // (prevents "server.rs," ≠ "server.rs" dedup failures)
  const norm = (s) =>
    s
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[,;:!?]+$/, ''));
  const setA = new Set(norm(a));
  const setB = new Set(norm(b));
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ─── MinHash Signatures ──────────────────────────────────────────────────

// FNV-1a hash: fast, non-cryptographic, ~10x faster than SHA-256 for MinHash
function fnv1a(str) {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
    hash >>>= 0; // Keep as uint32
  }
  return hash;
}

/**
 * Compute a MinHash signature for approximate set similarity.
 * Returns null for texts with fewer than 3 tokens.
 * @param {string} text Input text to hash
 * @param {number} [numHashes=64] Number of hash functions
 * @returns {string|null} Hex-encoded MinHash signature or null
 */
export function computeMinHash(text, numHashes = 64) {
  if (!text || typeof text !== 'string') return null;
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
  // Require at least 3 tokens for meaningful signature (avoids high collision on short texts)
  if (tokens.length < 3) return null;

  const mins = new Array(numHashes).fill(0xffffffff);
  for (const token of tokens) {
    for (let i = 0; i < numHashes; i++) {
      const val = fnv1a(`${i}-${token}`);
      if (val < mins[i]) mins[i] = val;
    }
  }
  return mins.map((v) => v.toString(16).padStart(8, '0')).join('');
}

/**
 * Estimate Jaccard similarity from two MinHash signatures.
 * @param {string} sig1 First hex-encoded MinHash signature
 * @param {string} sig2 Second hex-encoded MinHash signature
 * @returns {number} Estimated Jaccard similarity between 0 and 1
 */
export function estimateJaccardFromMinHash(sig1, sig2) {
  if (!sig1 || !sig2) return 0;
  if (sig1.length !== sig2.length) return 0;
  const numHashes = sig1.length / 8;
  if (numHashes === 0) return 0;
  // NEGATIVE RESULT, kept so nobody re-proposes it (audit 2026-09-02 P2-13 suggested an
  // "allocation-free comparison"). `slice()` does allocate two 8-char strings per band, and
  // the caller is a full nested pair loop — ~125k pairs at the 500-row scan bound. A
  // charCodeAt inner loop was written and measured against this form over all 124,750 pairs
  // of a 500-title fixture: identical results (0 mismatches, so the rewrite was correct) and
  // NO time difference — 0.77× / 1.08× / 1.03× across three passes, i.e. the first pass was
  // slower and the rest were noise. V8 handles short slices well enough that the byte loop
  // buys nothing, and the whole pass is 0.6 ms.
  //
  // So the slice form stays: it is the more readable of two equally fast implementations,
  // and shipping the other would be churn with a performance claim behind it that the
  // measurement does not support.
  let matches = 0;
  for (let i = 0; i < numHashes; i++) {
    const offset = i * 8;
    if (sig1.slice(offset, offset + 8) === sig2.slice(offset, offset + 8)) matches++;
  }
  return matches / numHashes;
}
