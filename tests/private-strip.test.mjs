import { describe, it, expect } from 'vitest';
import { stripPrivate } from '../lib/private-strip.mjs';

describe('stripPrivate', () => {
  it('replaces a single well-formed block with [redacted]', () => {
    expect(stripPrivate('foo <private>secret</private> bar')).toBe('foo [redacted] bar');
  });

  it('replaces multiple blocks independently (non-greedy)', () => {
    expect(stripPrivate('a <private>x</private> b <private>y</private> c')).toBe(
      'a [redacted] b [redacted] c',
    );
  });

  it('handles multiline content inside the block', () => {
    expect(stripPrivate('pre\n<private>line1\nline2\nline3</private>\npost')).toBe('pre\n[redacted]\npost');
  });

  it('is case-insensitive on the tag name', () => {
    expect(stripPrivate('<PRIVATE>x</PRIVATE>')).toBe('[redacted]');
    expect(stripPrivate('<Private>x</Private>')).toBe('[redacted]');
    expect(stripPrivate('<private>x</PRIVATE>')).toBe('[redacted]');
  });

  it('replaces empty block', () => {
    expect(stripPrivate('a<private></private>b')).toBe('a[redacted]b');
  });

  it('leaves unclosed open tag intact (user may be mid-typing)', () => {
    expect(stripPrivate('hello <private>not closed yet')).toBe('hello <private>not closed yet');
  });

  it('leaves stray closing tag intact', () => {
    expect(stripPrivate('hello </private> tail')).toBe('hello </private> tail');
  });

  it('leaves text without any tag unchanged (fast path)', () => {
    const plain = 'just a normal user prompt about pagination cursors';
    expect(stripPrivate(plain)).toBe(plain);
  });

  it('non-string input passes through unchanged', () => {
    expect(stripPrivate(undefined)).toBe(undefined);
    expect(stripPrivate(null)).toBe(null);
    expect(stripPrivate(42)).toBe(42);
  });

  it('empty string returns empty string', () => {
    expect(stripPrivate('')).toBe('');
  });

  it('block at the very start of the string', () => {
    expect(stripPrivate('<private>X</private> rest')).toBe('[redacted] rest');
  });

  it('block at the very end of the string', () => {
    expect(stripPrivate('prefix <private>X</private>')).toBe('prefix [redacted]');
  });

  it('two adjacent blocks with no separator', () => {
    expect(stripPrivate('<private>a</private><private>b</private>')).toBe('[redacted][redacted]');
  });

  it('preserves surrounding punctuation around the block', () => {
    expect(stripPrivate('Compare X with <private>token123</private>.')).toBe('Compare X with [redacted].');
  });
});

// ── SEC-1 (2026-08-29 audit): the block regex was quadratic on opener-dense input ──
//
// The rewrite is a semantics-preserving change to a redaction primitive, so the guard has
// two halves: a differential oracle against the ORIGINAL regex (the rewrite may not change
// what gets redacted) and a timing bound (the reason it was rewritten).
describe('stripPrivate — linearity and semantic equivalence', () => {
  /** The exact expression stripPrivate used before the rewrite. */
  function legacyStripPrivate(text) {
    if (typeof text !== 'string') return text;
    if (!text.includes('<')) return text;
    return text.replace(/<private>([\s\S]*?)<\/private>/gi, '[redacted]');
  }

  it('agrees with the original regex on adversarial and nested tag arrangements', () => {
    const cases = [
      '<private>a<private>b</private>', // earliest opener claims the close
      '<private>a</private></private><private>b</private>', // stray close between blocks
      '<private></private></private>',
      '</private><private>x</private>',
      '<private>x</PRIVATE>y<PRIVATE>z</private>', // mixed case on both ends
      '<private><private><private>x</private>',
      '<private>x</private><private>', // trailing unclosed opener
      'no tags at all',
      '<notprivate>x</notprivate>',
      '<private/>x</private>', // self-closing form matches neither tag
      '<private >x</private>', // space before `>` is not a tag
      '',
      '<',
    ];
    for (const c of cases) {
      expect(stripPrivate(c), `input: ${JSON.stringify(c)}`).toBe(legacyStripPrivate(c));
    }
  });

  it('agrees with the original regex across randomized tag soup', () => {
    // Deterministic PRNG so a failure is reproducible from the seed alone.
    let seed = 0x5eed1234;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pieces = ['<private>', '</private>', '<PRIVATE>', '</Private>', 'a', ' ', '\n', '<', '>', 'xy'];
    for (let iter = 0; iter < 500; iter++) {
      let s = '';
      const n = 1 + Math.floor(rnd() * 12);
      for (let i = 0; i < n; i++) s += pieces[Math.floor(rnd() * pieces.length)];
      expect(stripPrivate(s), `iter=${iter} input: ${JSON.stringify(s)}`).toBe(legacyStripPrivate(s));
    }
  });

  it('stays linear on opener-dense input that made the old regex quadratic', () => {
    // Both shapes measured 456-891ms before the rewrite. The second one exists because it
    // defeats the naive fix ("bail out when there is no closing tag") — it HAS one.
    const inputs = [
      '<private>'.repeat(28000), // ~252KB, the hook stdin cap
      '</private>' + '<private>'.repeat(28000),
    ];
    for (const input of inputs) {
      const started = process.hrtime.bigint();
      const out = stripPrivate(input);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // Unchanged output: neither shape contains a well-formed block.
      expect(out).toBe(input);
      expect(ms, `stripPrivate took ${ms.toFixed(1)}ms on ${input.length} bytes`).toBeLessThan(120);
    }
  });
});
