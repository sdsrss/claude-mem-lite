// Property-based tests using fast-check
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import {
  sanitizeFtsQuery,
  scrubSecrets,
  computeMinHash,
  estimateJaccardFromMinHash,
  jaccardSimilarity,
  estimateTokens,
  clampImportance,
} from '../utils.mjs';

// ─── sanitizeFtsQuery ───────────────────────────────────────────────────────

describe('sanitizeFtsQuery properties', () => {
  it('output is always valid FTS5 (never throws on MATCH)', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);

    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), (input) => {
        const result = sanitizeFtsQuery(input);
        if (result === null) return true;
        // Should not throw when used in FTS5 MATCH
        try {
          db.prepare('SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?').all(result);
          return true;
        } catch {
          return false;
        }
      }),
      { numRuns: 200 },
    );

    db.close();
  });

  // Round3-P1: fc.string only emits up to charCode 126, so the fuzz above never
  // reaches NUL / C0 control chars. A NUL survived tokenization, got phrase-quoted,
  // and terminated SQLite's C string mid-phrase → FTS5 "unterminated string" throw,
  // breaking the "never throws on MATCH" invariant (and silently zeroing recall).
  it('never throws on MATCH for NUL / control chars (fc.string cannot reach these)', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    const NUL = String.fromCharCode(0);
    const inputs = [`fix${NUL}bug${NUL}crash search`, 'a\x01b\x07c term', `${NUL}`, 'x\x1fy', '\x00\x00\x00'];
    for (const input of inputs) {
      const result = sanitizeFtsQuery(input);
      if (result === null) continue;
      expect(
        () => db.prepare('SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?').all(result),
        `NUL/control input ${JSON.stringify(input)} must not throw on MATCH`,
      ).not.toThrow();
    }
    db.close();
  });

  it('returns null or non-empty string', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (input) => {
        const result = sanitizeFtsQuery(input);
        return result === null || (typeof result === 'string' && result.length > 0);
      }),
      { numRuns: 500 },
    );
  });
});

// ─── scrubSecrets ───────────────────────────────────────────────────────────

describe('scrubSecrets properties', () => {
  // This used to assert `scrub(scrub(x)) === scrub(x)` over `fc.string({maxLength:1000})`.
  // Both halves were wrong. The property is FALSE, and the test could not have seen that:
  // measured 0 of 100,000 draws from that generator are changed by the scrubber AT ALL, so
  // it asserted `x === x` on strings that never reach the substitution path. A ruler that
  // cannot say NO is not a ruler.
  //
  // The mechanism is ARRAY ORDER. A length-floored rule sits EARLIER in SECRET_PATTERNS than
  // a rewrite whose replacement is LONGER than what it replaces, so a span can be under the
  // floor on pass 1 and over it on pass 2:
  //   `AccountKey=…{16,}` (consumer) runs before `https://u:p@` → `https://***:***@` (grower,
  //   12 chars → 16). `AccountKey=https://a:b@h` declines at 12, then fires on the next pass.
  // A second, independent shape: a replacement destroys the letter that the prose lookbehind
  // `(?<![A-Za-z][ \t])` keys on, so `--token ghp_… secret: v` is prose on pass 1 and config
  // on pass 2.
  //
  // Pinned rather than fixed: making the scrubber idempotent means reordering the pattern
  // table, which changes what it catches and owes a re-measured pass over the corpus (D#46).
  // Until then, callers must not assume it — see `importedObsTitle`, where the dedup key was
  // resting on exactly this.
  const NON_IDEMPOTENT = [
    'Bash: AccountKey=https://a:b@h',
    'Bash: curl "?sig=https://a:b@h"',
    'AccountKey=-?postgres://@&',
    'Bash: deploy --token ghp_1234567890abcdefghijk secret: hunter2correct',
  ];

  it('is NOT idempotent, and these are the shapes that prove it', () => {
    for (const input of NON_IDEMPOTENT) {
      const once = scrubSecrets(input);
      const twice = scrubSecrets(once);
      // Premise: the fixture must still reach the substitution path at all. A pattern edit
      // that stops scrubbing these would otherwise turn the case below into `x === x`.
      expect(once, `fixture no longer scrubbed at all: ${input}`).not.toBe(input);
      expect(twice, `scrubSecrets became idempotent for: ${input}`).not.toBe(once);
    }
  });

  it('the generator the old idempotence test used never reaches the substitution path', () => {
    // The reason the false property went unnoticed for as long as it did. Kept as a case so
    // nobody re-adds a property test over a generator that cannot produce a credential.
    const samples = fc.sample(fc.string({ maxLength: 1000 }), 2000);
    const touched = samples.filter((s) => scrubSecrets(s) !== s);
    expect(touched, `generator now reaches the scrubber (${touched.length}/2000)`).toHaveLength(0);
  });

  it('preserves non-secret text unchanged', () => {
    // Generate strings that cannot match any secret pattern
    const safeChars = 'abcdefghijklmnopqrstuvwxyz 0123456789';
    const safeArb = fc.string({ minLength: 1, maxLength: 200 }).map((s) =>
      Array.from(s)
        .map((c) => safeChars[c.charCodeAt(0) % safeChars.length])
        .join(''),
    );

    fc.assert(
      fc.property(safeArb, (input) => {
        return scrubSecrets(input) === input;
      }),
      { numRuns: 200 },
    );
  });
});

// ─── computeMinHash ─────────────────────────────────────────────────────────

describe('computeMinHash properties', () => {
  it('is deterministic: same input produces same output', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 20, maxLength: 500 }), (input) => {
        const sig1 = computeMinHash(input);
        const sig2 = computeMinHash(input);
        return sig1 === sig2;
      }),
      { numRuns: 200 },
    );
  });
});

// ─── estimateJaccardFromMinHash ─────────────────────────────────────────────

describe('estimateJaccardFromMinHash properties', () => {
  it('is symmetric: f(a,b) === f(b,a)', () => {
    // Generate meaningful text to get non-null signatures
    const textArb = fc
      .array(fc.lorem({ maxCount: 5 }), { minLength: 3, maxLength: 10 })
      .map((words) => words.join(' '));

    fc.assert(
      fc.property(textArb, textArb, (a, b) => {
        const sigA = computeMinHash(a);
        const sigB = computeMinHash(b);
        if (!sigA || !sigB) return true; // skip short texts
        return estimateJaccardFromMinHash(sigA, sigB) === estimateJaccardFromMinHash(sigB, sigA);
      }),
      { numRuns: 100 },
    );
  });

  it('is bounded [0, 1]', () => {
    const textArb = fc
      .array(fc.lorem({ maxCount: 5 }), { minLength: 3, maxLength: 10 })
      .map((words) => words.join(' '));

    fc.assert(
      fc.property(textArb, textArb, (a, b) => {
        const sigA = computeMinHash(a);
        const sigB = computeMinHash(b);
        if (!sigA || !sigB) return true;
        const similarity = estimateJaccardFromMinHash(sigA, sigB);
        return similarity >= 0 && similarity <= 1;
      }),
      { numRuns: 100 },
    );
  });

  it('identity: f(sig, sig) === 1.0', () => {
    const textArb = fc
      .array(fc.lorem({ maxCount: 5 }), { minLength: 3, maxLength: 10 })
      .map((words) => words.join(' '));

    fc.assert(
      fc.property(textArb, (text) => {
        const sig = computeMinHash(text);
        if (!sig) return true;
        return estimateJaccardFromMinHash(sig, sig) === 1.0;
      }),
      { numRuns: 100 },
    );
  });
});

// ─── jaccardSimilarity ──────────────────────────────────────────────────────

describe('jaccardSimilarity properties', () => {
  it('is symmetric', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        return jaccardSimilarity(a, b) === jaccardSimilarity(b, a);
      }),
      { numRuns: 300 },
    );
  });

  it('is bounded [0, 1]', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const sim = jaccardSimilarity(a, b);
        return sim >= 0 && sim <= 1;
      }),
      { numRuns: 300 },
    );
  });

  it('identity: f(s, s) === 1.0 for non-empty strings with words', () => {
    fc.assert(
      fc.property(
        fc.array(fc.lorem({ maxCount: 1 }), { minLength: 1, maxLength: 5 }).map((w) => w.join(' ')),
        (s) => {
          return jaccardSimilarity(s, s) === 1.0;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── estimateTokens ─────────────────────────────────────────────────────────

describe('estimateTokens properties', () => {
  it('returns positive value for non-empty input', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (text) => {
        return estimateTokens(text) > 0;
      }),
      { numRuns: 300 },
    );
  });
});

// ─── clampImportance ────────────────────────────────────────────────────────

describe('clampImportance properties', () => {
  it('always returns 1, 2, or 3', () => {
    fc.assert(
      fc.property(fc.anything(), (val) => {
        const result = clampImportance(val);
        return [1, 2, 3].includes(result);
      }),
      { numRuns: 500 },
    );
  });
});
