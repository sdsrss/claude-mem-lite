// tests/lesson-bridge.test.mjs
import { describe, it, expect } from 'vitest';
import { buildBridgePrompt, bridgeLesson } from '../lib/lesson-bridge.mjs';

describe('buildBridgePrompt', () => {
  it('includes the lesson and hunk, and truncates each to its cap', () => {
    const lesson = 'L'.repeat(5000);
    const hunk = 'H'.repeat(5000);
    const p = buildBridgePrompt(lesson, hunk);
    expect(p).toMatch(/N\/A/); // the abstain instruction is present
    // Truncation by substring run — robust to boilerplate (asserting exact global
    // char counts would couple the test to the prompt wording and force the prompt
    // to avoid stray L/H chars; #plan-fix).
    expect(p).toContain('L'.repeat(600)); // lesson kept up to LESSON_MAX...
    expect(p).not.toContain('L'.repeat(601)); // ...and not one char more
    expect(p).toContain('H'.repeat(1200)); // hunk kept up to HUNK_MAX...
    expect(p).not.toContain('H'.repeat(1201)); // ...and not one char more
  });
  it('is a pure string with no thrown error on empty inputs', () => {
    expect(typeof buildBridgePrompt('', '')).toBe('string');
  });
});

describe('bridgeLesson (fail-open)', () => {
  const lesson = 'guard recoverChildrenOf against null parent';
  const hunk = 'function recoverChildrenOf(p) { return p.kids; }';

  it('returns { ok:true, check } on a one-line model answer', async () => {
    const r = await bridgeLesson({
      lesson,
      hunk,
      _callLLM: async () => 'null-check recoverChildrenOf before .kids',
    });
    expect(r.ok).toBe(true);
    expect(r.check).toBe('null-check recoverChildrenOf before .kids');
  });
  it('takes only the first line and caps at 200 chars', async () => {
    const r = await bridgeLesson({ lesson, hunk, _callLLM: async () => 'X'.repeat(500) + '\nsecond line' });
    expect(r.ok).toBe(true);
    expect(r.check.length).toBe(200);
    expect(r.check).not.toContain('second line');
  });
  it('returns { ok:false } on an N/A answer (case/spacing-insensitive)', async () => {
    expect((await bridgeLesson({ lesson, hunk, _callLLM: async () => '  n/a  ' })).ok).toBe(false);
    expect((await bridgeLesson({ lesson, hunk, _callLLM: async () => 'N/A' })).ok).toBe(false);
  });
  it('returns { ok:false } on empty output', async () => {
    expect((await bridgeLesson({ lesson, hunk, _callLLM: async () => '' })).ok).toBe(false);
  });
  it('returns { ok:false } and does NOT throw when callLLM throws (timeout/error)', async () => {
    const r = await bridgeLesson({
      lesson,
      hunk,
      _callLLM: async () => {
        throw new Error('ETIMEDOUT');
      },
    });
    expect(r.ok).toBe(false);
  });
});
