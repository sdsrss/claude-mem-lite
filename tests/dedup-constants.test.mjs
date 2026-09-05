// Minimal regression coverage for lib/dedup-constants.mjs (baseline round 2026-09-02).
// These thresholds are consumed by save-observation, maintain-core, hook-llm,
// hook-optimize, mem-cli and server. Their documented ORDER is what makes the
// merge band [MERGE_JACCARD_LOW, AUTO_MERGE_THRESHOLD) and the "pre-filter is
// looser than the exact compare" property hold; a typo that flips two values
// would leave every importer green and silently change dedup behaviour.

import { describe, it, expect } from 'vitest';
import {
  DEDUP_JACCARD_THRESHOLD,
  AUTO_MERGE_THRESHOLD,
  MERGE_JACCARD_LOW,
  MINHASH_PRE_THRESHOLD,
  MINHASH_PREFILTER,
  FUZZY_DEDUP_THRESHOLD,
  FUZZY_BODY_THRESHOLD,
} from '../lib/dedup-constants.mjs';

const ALL = {
  DEDUP_JACCARD_THRESHOLD,
  AUTO_MERGE_THRESHOLD,
  MERGE_JACCARD_LOW,
  MINHASH_PRE_THRESHOLD,
  MINHASH_PREFILTER,
  FUZZY_DEDUP_THRESHOLD,
  FUZZY_BODY_THRESHOLD,
};

describe('dedup thresholds', () => {
  it('are all Jaccard-space numbers strictly inside (0, 1)', () => {
    for (const [name, v] of Object.entries(ALL)) {
      expect(typeof v, name).toBe('number');
      expect(v > 0 && v < 1, `${name}=${v}`).toBe(true);
    }
  });

  it('LLM merge-review band sits below the auto-merge cutoff', () => {
    expect(MERGE_JACCARD_LOW).toBeLessThan(AUTO_MERGE_THRESHOLD);
  });

  it('save-time near-duplicate cutoff is looser than auto-merge and stricter than the review floor', () => {
    expect(MERGE_JACCARD_LOW).toBeLessThan(DEDUP_JACCARD_THRESHOLD);
    expect(DEDUP_JACCARD_THRESHOLD).toBeLessThan(AUTO_MERGE_THRESHOLD);
  });

  it('MinHash pre-filters never exceed the exact threshold they guard', () => {
    // maintain scan: estimate < 0.5 skips the exact compare at 0.7
    expect(MINHASH_PRE_THRESHOLD).toBeLessThanOrEqual(DEDUP_JACCARD_THRESHOLD);
    // hook fuzzy pass: estimate < 0.7 skips the exact title compare at 0.95
    expect(MINHASH_PREFILTER).toBeLessThanOrEqual(FUZZY_DEDUP_THRESHOLD);
    // hot-path pre-filter is documented as stricter than the maintain one
    expect(MINHASH_PREFILTER).toBeGreaterThan(MINHASH_PRE_THRESHOLD);
  });

  it('the four values this file NAMES in prose are the ones that ship', () => {
    // The cases above pin ORDER, which is what the header claims — but the comments right
    // beside them assert VALUES ("the exact compare at 0.7", "the exact title compare at
    // 0.95"), and order alone does not bind those. The v3.92.0 review moved
    // DEDUP_JACCARD_THRESHOLD 0.7 → 0.68: every ordering held, the suite stayed green, and
    // two of this file's own comments became false. Since this file is the only
    // importer-independent record of these numbers, the four it names are bound here.
    // Deliberately NOT all seven: pinning a value is a decision to make changing it
    // deliberate, and the other three have no prose here that would go stale.
    expect(DEDUP_JACCARD_THRESHOLD).toBe(0.7);
    expect(FUZZY_DEDUP_THRESHOLD).toBe(0.95);
    expect(MINHASH_PRE_THRESHOLD).toBe(0.5);
    expect(MINHASH_PREFILTER).toBe(0.7);
  });

  it('inline fuzzy dedup is the strictest title cutoff and its body floor is softer', () => {
    expect(FUZZY_DEDUP_THRESHOLD).toBeGreaterThan(AUTO_MERGE_THRESHOLD);
    expect(FUZZY_BODY_THRESHOLD).toBeLessThan(FUZZY_DEDUP_THRESHOLD);
  });
});
