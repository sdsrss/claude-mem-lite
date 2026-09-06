// R10 P3-10 — computeMinHash strips everything outside [a-z0-9\s] before tokenizing, so a
// title or narrative written entirely in Chinese or Japanese produced zero tokens and
// returned null. A null signature means the row is invisible to the MinHash prefilter that
// findDuplicates and selectFuzzyDedupeIds run before Jaccard, so CJK-only rows could never
// be deduplicated against anything — silently, since a null signature is also what a
// legitimately-too-short text returns.
//
// The fix is deliberately confined to the rows that currently get NULL. Signatures are
// STORED, and estimateJaccardFromMinHash compares a stored signature against a freshly
// computed one — so changing the tokenization for rows that already have a signature would
// make the whole existing corpus incomparable with anything written afterwards, degrading
// dedup everywhere until a full rebuild. Every text that produces a signature today must
// produce the SAME bytes.

import { describe, it, expect } from 'vitest';
import { computeMinHash, estimateJaccardFromMinHash } from '../hash-utils.mjs';

describe('R10 P3-10 — CJK-only text gets a MinHash signature', () => {
  it('a pure-CJK title is no longer unsignable', () => {
    const sig = computeMinHash('检索管线的重排序阶段在向量臂关闭时静默退化');
    expect(sig, 'CJK-only text still returns null — invisible to the dedup prefilter').toBeTruthy();
    expect(sig).toHaveLength(64 * 8);
  });

  it('two near-identical CJK texts estimate high similarity', () => {
    const a = computeMinHash('检索管线的重排序阶段在向量臂关闭时静默退化');
    const b = computeMinHash('检索管线的重排序阶段在向量臂关闭时会静默退化');
    expect(estimateJaccardFromMinHash(a, b)).toBeGreaterThan(0.6);
  });

  it('two unrelated CJK texts do not', () => {
    const a = computeMinHash('检索管线的重排序阶段在向量臂关闭时静默退化');
    const b = computeMinHash('安装器在写入用户全局配置文件时丢失了权限位');
    expect(estimateJaccardFromMinHash(a, b)).toBeLessThan(0.3);
  });

  it('still returns null for genuinely too-short text', () => {
    expect(computeMinHash('')).toBeNull();
    expect(computeMinHash('a b')).toBeNull();
    expect(computeMinHash('检索')).toBeNull(); // one bigram is not three tokens
    expect(computeMinHash(null)).toBeNull();
    expect(computeMinHash(42)).toBeNull();
  });

  // The compatibility half. These are the cases that must not move, because their
  // signatures are already on disk.
  it('ASCII signatures are byte-identical to what the old tokenizer produced', () => {
    const cases = [
      'the pool limit sits upstream of the relevance filter',
      'Fix race in balance deduction causing double-spend',
      'install.mjs replaced settings.json with an empty object',
      'mixed 混合 content with enough ascii tokens to sign on its own',
    ];
    // Recomputed with the pre-fix tokenizer, inline, so this is a real oracle and not a
    // snapshot of the new behaviour.
    const legacy = (text, numHashes = 64) => {
      const tokens = text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2);
      if (tokens.length < 3) return null;
      const fnv1a = (s) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h >>> 0;
      };
      const mins = new Array(numHashes).fill(0xffffffff);
      for (const token of tokens) {
        for (let i = 0; i < numHashes; i++) {
          const v = fnv1a(`${i}-${token}`);
          if (v < mins[i]) mins[i] = v;
        }
      }
      return mins.map((v) => v.toString(16).padStart(8, '0')).join('');
    };
    for (const text of cases) {
      expect(legacy(text), `fixture "${text}" was unsignable before; it proves nothing`).toBeTruthy();
      expect(computeMinHash(text), `signature moved for: ${text}`).toBe(legacy(text));
    }
  });
});
