// D19 (converge R31, user-chosen 2026-11-11): the session summary prompt can carry the session's
// final reply, so the model stops writing work the reply reports done into remaining_items /
// next_steps. This file pins the prompt builder and the A/B ruler's pure parts
// (benchmark/summary-reply-ab.mjs); the worker's wiring is tested in hook-llm.test.mjs.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildSessionSummaryPrompt,
  summaryReplyExcerpt,
  SUMMARY_REPLY_HEAD,
  SUMMARY_REPLY_TAIL,
} from '../hook-llm.mjs';
import { gateD19, scoreVerdicts, buildBlind, summaryUsable } from '../benchmark/summary-reply-ab.mjs';

const KEY = 'sk-ant-api03-' + 'Q7xZ'.repeat(10) + 'AbCd';
const base = {
  project: 'p',
  observations: [{ type: 'bugfix', title: 'Fixed the login redirect', narrative: 'n' }],
  userPrompts: ['fix the login bug'],
};

describe('buildSessionSummaryPrompt', () => {
  it('without a final reply carries no reply section and no reply rule', () => {
    const { system, user } = buildSessionSummaryPrompt(base);
    expect(system).not.toContain('Final reply');
    expect(user).not.toContain('Final reply');
    expect(user).toContain('1. [bugfix] Fixed the login redirect: n');
    expect(user).toContain('User requests: fix the login bug');
  });

  it('puts the final reply last in the user part and the rule in the system part', () => {
    const { system, user } = buildSessionSummaryPrompt({
      ...base,
      finalReply: 'All 12 tests pass; lesson saved.',
    });
    expect(user.endsWith('\n\nFinal reply:\nAll 12 tests pass; lesson saved.')).toBe(true);
    expect(system).toMatch(/Work it reports as done .* never list it in remaining_items or next_steps/);
    // The reply is captured content: it stays on the user side of the input guard.
    expect(system).not.toContain('All 12 tests pass');
  });

  it('without a final reply is the prompt shipped before D19, byte for byte', () => {
    // The hash was taken twice (2026-11-11): from this builder, and from the inline template at
    // a3a29a03 evaluated with the same input. A deliberate change to the prompt updates it, and
    // re-measures with benchmark/summary-reply-ab.mjs (R31 review L7).
    const { system, user } = buildSessionSummaryPrompt(base);
    expect(createHash('sha256').update(`${system}\u0000${user}`).digest('hex')).toBe(
      'd153b5a94774ecc16378d4067f600ac7fb2e279124dd881aa753e2ffa1b16726',
    );
  });

  it('a blank reply is treated as none', () => {
    expect(buildSessionSummaryPrompt({ ...base, finalReply: '  \n ' })).toEqual(
      buildSessionSummaryPrompt(base),
    );
  });
});

describe('summaryReplyExcerpt', () => {
  const limit = SUMMARY_REPLY_HEAD + SUMMARY_REPLY_TAIL;

  it('keeps a reply within the limit whole', () => {
    const r = 'x'.repeat(limit);
    expect(summaryReplyExcerpt(r)).toBe(r);
  });

  it('keeps the head and the tail of a longer one and names what it dropped', () => {
    const r = 'H'.repeat(SUMMARY_REPLY_HEAD) + 'M'.repeat(500) + 'T'.repeat(SUMMARY_REPLY_TAIL);
    const out = summaryReplyExcerpt(r);
    expect(out.startsWith('H'.repeat(SUMMARY_REPLY_HEAD) + '\n')).toBe(true);
    expect(out.endsWith('\n' + 'T'.repeat(SUMMARY_REPLY_TAIL))).toBe(true);
    expect(out).toContain('500 characters omitted');
    expect(out).not.toContain('M');
  });

  it('scrubs before it cuts, so a secret across the cut leaves no part behind', () => {
    const r = 'a'.repeat(SUMMARY_REPLY_HEAD - 20) + ' ' + KEY + ' ' + 'b'.repeat(2000);
    const out = summaryReplyExcerpt(r);
    expect(out).not.toContain('Q7xZQ7xZ');
    expect(out).not.toContain('sk-ant-api03');
  });

  it('cuts on code points', () => {
    const r = '😀'.repeat(limit + 10);
    const out = summaryReplyExcerpt(r);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(out).toContain('10 characters omitted');
  });
});

describe('summary-reply-ab ruler', () => {
  const pass = {
    A: { falseOpen: 8, missedOpen: 2, usable: 30 },
    B: { falseOpen: 3, missedOpen: 3, usable: 29 },
    agreement: { false_open: 0.8, missed_open: 0.75 },
  };

  it('the gate passes only when every pre-registered condition holds', () => {
    expect(gateD19(pass)).toEqual({ ship: true, reasons: [] });
  });

  it.each([
    [
      'too little reach',
      { A: { ...pass.A, falseOpen: 3 }, B: { ...pass.B, falseOpen: 0 } },
      /does not reach/,
    ],
    ['too small a drop', { B: { ...pass.B, falseOpen: 5 } }, /FO\(B\) = 5 > FO\(A\)\/2/],
    ['more missed open items', { B: { ...pass.B, missedOpen: 4 } }, /MO\(B\) = 4/],
    ['fewer usable replies', { B: { ...pass.B, usable: 28 } }, /usable\(B\) = 28/],
    ['judges disagree', { agreement: { false_open: 0.69, missed_open: 0.9 } }, /false_open agreement/],
  ])('says NO on %s', (_name, patch, reason) => {
    const g = gateD19({ ...pass, ...patch });
    expect(g.ship).toBe(false);
    expect(g.reasons.join('\n')).toMatch(reason);
  });

  it('counts an item only when both judges say YES, and measures agreement', () => {
    const key = { s1: { arm: 'A', item: 0 }, s2: { arm: 'B', item: 0 }, s3: { arm: 'A', item: 1 } };
    const a = {
      s1: { false_open: 'YES', missed_open: 'NO' },
      s2: { false_open: 'YES', missed_open: 'NONE_STATED' },
      s3: { false_open: 'NO', missed_open: 'YES' },
    };
    const b = {
      s1: { false_open: 'YES', missed_open: 'NO' },
      s2: { false_open: 'NO', missed_open: 'NONE_STATED' },
      s3: { false_open: 'NO', missed_open: 'YES' },
    };
    const { arms, agreement } = scoreVerdicts(key, a, b, { A: 2, B: 1 });
    expect(arms.A).toMatchObject({ n: 2, judged: 2, falseOpen: 1, missedOpen: 1, usable: 2 });
    expect(arms.B).toMatchObject({ n: 1, judged: 1, falseOpen: 0, missedOpen: 0, usable: 1 });
    expect(agreement).toEqual({ false_open: 2 / 3, missed_open: 1, n: 3 });
  });

  it('an invalid label leaves the item unjudged', () => {
    const key = { s1: { arm: 'A', item: 0 } };
    const v = { s1: { false_open: 'MAYBE', missed_open: 'NO' } };
    expect(scoreVerdicts(key, v, v, {}).arms.A.judged).toBe(0);
  });

  it('blind batches carry no arm, and the key covers every row once', () => {
    const dump = {
      items: [{ finalReply: 'r0' }, { finalReply: 'r1' }],
      rows: [
        { item: 0, arm: 'A', completed: 'c', remaining_items: '', next_steps: '' },
        { item: 0, arm: 'B', completed: 'c', remaining_items: '', next_steps: '' },
        { item: 1, arm: 'B', completed: 'c', remaining_items: 'x', next_steps: '' },
        { item: 1, arm: 'A', completed: 'c', remaining_items: 'y', next_steps: '' },
      ],
    };
    const { batches, key } = buildBlind(dump, { seed: 1, batches: 2 });
    const all = batches.flatMap((b) => b.a);
    expect(all.map((e) => e.id).sort()).toEqual(Object.keys(key).sort());
    expect(new Set(all.map((e) => e.id)).size).toBe(4);
    for (const e of all) expect(Object.keys(e).sort()).toEqual(['final_reply', 'id', 'summary']);
    for (const b of batches)
      expect([...b.b].sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual(
        [...b.a].sort((x, y) => (x.id < y.id ? -1 : 1)),
      );
    expect(Object.values(key).filter((k) => k.arm === 'A')).toHaveLength(2);
  });

  it("usable is the worker's write gate", () => {
    expect(summaryUsable(null)).toBe(false);
    expect(summaryUsable({ request: '', lessons: [''] })).toBe(false);
    expect(summaryUsable({ next_steps: ['run it'] })).toBe(true);
    expect(summaryUsable({ key_decisions: ['chose X because Y'] })).toBe(true);
  });
});
