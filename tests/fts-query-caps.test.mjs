// Audit 2026-08-22 P2-13. UserPromptSubmit runs sanitizeFtsQuery on every prompt the
// user sends, and only a 64KB BYTE guard stood upstream — a guard on what is read, not
// on what is computed. Measured cost of the sanitize alone: 0.8ms on a normal prompt,
// 6.2ms on a 64KB ASCII one, 31.8ms on a 64KB CJK one (extractCjkKeywords is O(len × dict)
// over an unsegmented run), all of it before the model sees the turn. With the caps:
// 0.2ms and 1.4ms respectively.
//
// The caps are OPT-IN per caller. An explicit `claude-mem-lite search` stays uncapped —
// a person who types a long query meant it. These cases hold both halves: the option
// works, and the automatic surface is the one passing it.
import { describe, it, expect } from 'vitest';
import { sanitizeFtsQuery } from '../nlp.mjs';
// Moved to lib/ups-query.mjs so BOTH hooks of the UserPromptSubmit event share one
// cap definition — v3.75.0 capped only the user-prompt-search.js face.
import { upsFtsQuery } from '../lib/ups-query.mjs';

const NORMAL = 'how do I fix the FTS5 tokenizer for CJK queries';
const longAscii = (n) => 'refactor parser widget cache invalidation module '.repeat(n);
const terms = (q) => (q ? q.split(/ AND | /).filter(Boolean).length : 0);

describe('sanitizeFtsQuery caps', () => {
  it('is unchanged with no options — the default stays uncapped', () => {
    const long = longAscii(400); // ~19k chars
    expect(sanitizeFtsQuery(long)).toBe(sanitizeFtsQuery(long, {}));
    expect(sanitizeFtsQuery(long, { maxChars: 0, maxTokens: 0 })).toBe(sanitizeFtsQuery(long));
  });

  it('leaves a normal-length query byte-identical when capped', () => {
    // The common path must not move. Every prompt goes through this.
    expect(sanitizeFtsQuery(NORMAL, { maxChars: 2000, maxTokens: 64 })).toBe(sanitizeFtsQuery(NORMAL));
  });

  it('maxTokens bounds the number of terms in the emitted query', () => {
    // Distinct words so the cap, not deduplication, is what limits the count.
    const many = Array.from({ length: 300 }, (_, i) => `widgetterm${i}`).join(' ');
    expect(terms(sanitizeFtsQuery(many))).toBeGreaterThan(100);
    expect(terms(sanitizeFtsQuery(many, { maxTokens: 64 }))).toBeLessThanOrEqual(64);
  });

  it('maxChars bounds the INPUT, which is what bounds CJK segmentation', () => {
    // A long CJK prompt can be a single unsegmented token, so a token cap alone would
    // not bound the dictionary walk over it — the character cap is what does.
    const cjk = '这个函数的缓存失效问题需要重构解析器模块并修复索引'.repeat(200);
    const capped = sanitizeFtsQuery(cjk, { maxChars: 2000 });
    const uncapped = sanitizeFtsQuery(cjk);
    expect(capped).toBeTruthy();
    expect(capped.length).toBeLessThanOrEqual(uncapped.length);
    // And the cap really is applied to the input: a term that exists only past the cut
    // must not survive into the query.
    const tail = `${'ab '.repeat(1200)}zzmarkerterm`;
    expect(sanitizeFtsQuery(tail)).toContain('zzmarkerterm');
    expect(sanitizeFtsQuery(tail, { maxChars: 2000 })).not.toContain('zzmarkerterm');
  });
});

describe('the UserPromptSubmit surface passes the caps', () => {
  // upsFtsQuery is the builder BOTH search paths in user-prompt-search.js call. Testing
  // sanitizeFtsQuery's option alone would prove the option works and say nothing about
  // whether the hook uses it.
  it('caps what the hook searches', () => {
    const tail = `${'ab '.repeat(1200)}zzmarkerterm`;
    expect(upsFtsQuery(tail)).not.toContain('zzmarkerterm');
    const many = Array.from({ length: 300 }, (_, i) => `widgetterm${i}`).join(' ');
    expect(terms(upsFtsQuery(many))).toBeLessThanOrEqual(64);
  });

  it('leaves a normal prompt exactly as the uncapped path would', () => {
    expect(upsFtsQuery(NORMAL)).toBe(sanitizeFtsQuery(NORMAL));
  });
});
