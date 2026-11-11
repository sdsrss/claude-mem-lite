// D21 (R34): the A/B ruler that gates wiring the session's events into the summary.
// The gate must be able to say NO on every registered condition (doctrine rule 5).
import { describe, it, expect } from 'vitest';
import { gateD21, scoreVerdicts, turnReplies, judgeReplies } from '../benchmark/summary-events-ab.mjs';

describe('turnReplies', () => {
  const user = (text, ts, extra = {}) => ({
    type: 'user',
    timestamp: ts,
    message: { content: text },
    ...extra,
  });
  const asst = (text, ts, extra = {}) => ({
    type: 'assistant',
    timestamp: ts,
    message: { content: [{ type: 'text', text }] },
    ...extra,
  });
  const toolResult = (ts) => ({
    type: 'user',
    timestamp: ts,
    message: { content: [{ type: 'tool_result', content: 'ok' }] },
  });

  it("returns each human turn's last assistant text inside the window", () => {
    const entries = [
      user('before the window', '2026-11-11T00:00:00Z'),
      asst('old reply', '2026-11-11T00:00:01Z'),
      user('first', '2026-11-11T01:00:00Z'),
      asst('working', '2026-11-11T01:00:01Z'),
      toolResult('2026-11-11T01:00:02Z'),
      asst('turn 1 done', '2026-11-11T01:00:03Z'),
      asst('a subagent', '2026-11-11T01:00:04Z', { isSidechain: true }),
      user('<command-name>/clear</command-name>', '2026-11-11T01:30:00Z'),
      user('second', '2026-11-11T02:00:00Z'),
      asst('turn 2 done', '2026-11-11T02:00:01Z'),
    ];
    const from = Date.parse('2026-11-11T00:30:00Z');
    const to = Date.parse('2026-11-11T03:00:00Z');
    expect(turnReplies(entries, { from, to })).toEqual(['turn 1 done', 'turn 2 done']);
  });
});

describe('judgeReplies', () => {
  it('cuts a long reply to head + tail and keeps the first 4 and last 8 of many turns', () => {
    const long = 'h'.repeat(700) + 'm'.repeat(50) + 't'.repeat(300);
    const one = judgeReplies([long]).shown[0].reply;
    expect(one.startsWith('h'.repeat(700))).toBe(true);
    expect(one.endsWith('t'.repeat(300))).toBe(true);
    expect(one).toContain('50 chars omitted');
    const many = judgeReplies(Array.from({ length: 20 }, (_, i) => `r${i + 1}`));
    expect(many.turns).toBe(20);
    expect(many.shown.map((s) => s.turn)).toEqual([1, 2, 3, 4, 13, 14, 15, 16, 17, 18, 19, 20]);
  });
});

describe('gateD21 (registered 2026-11-11, before the first call)', () => {
  const pass = () => ({
    n: 30,
    agreement: { missed_done: 0.9, false_open: 0.9, unsupported: 0.9 },
    A: { usable: 30, missed_done: 10, false_open: 3, unsupported: 2 },
    B: { usable: 29, missed_done: 7, false_open: 4, unsupported: 3 },
  });

  it('ships when every condition holds', () => {
    expect(gateD21(pass())).toEqual({ ship: true, reasons: [] });
  });

  it.each([
    ['too small a gain', (g) => (g.B.missed_done = 8)],
    ['more done work written as open', (g) => (g.B.false_open = 5)],
    ['more unsupported claims', (g) => (g.B.unsupported = 4)],
    ['an arm with unusable replies', (g) => (g.B.usable = 27)],
    ['judges that do not agree', (g) => (g.agreement.unsupported = 0.69)],
    ['a missing agreement', (g) => delete g.agreement.false_open],
  ])('says NO on %s', (_name, mutate) => {
    const g = pass();
    mutate(g);
    const r = gateD21(g);
    expect(r.ship).toBe(false);
    expect(r.reasons).toHaveLength(1);
  });
});

describe('scoreVerdicts', () => {
  it('counts both-YES per arm, skips an item a judge did not answer validly, and reports agreement', () => {
    const key = { e1: { arm: 'A', item: 0 }, e2: { arm: 'B', item: 0 }, e3: { arm: 'B', item: 1 } };
    const v = (m, f, u) => ({ missed_done: m, false_open: f, unsupported: u });
    const a = { e1: v('YES', 'NO', 'NO'), e2: v('YES', 'YES', 'NO'), e3: v('maybe', 'NO', 'NO') };
    const b = { e1: v('YES', 'NO', 'YES'), e2: v('NO', 'YES', 'NO'), e3: v('NO', 'NO', 'NO') };
    const r = scoreVerdicts(key, a, b, { A: 1, B: 2 });
    expect(r.arms.A).toMatchObject({
      n: 1,
      judged: 1,
      missed_done: 1,
      false_open: 0,
      unsupported: 0,
      usable: 1,
    });
    expect(r.arms.B).toMatchObject({
      n: 2,
      judged: 1,
      missed_done: 0,
      false_open: 1,
      unsupported: 0,
      usable: 2,
    });
    expect(r.agreement).toEqual({ missed_done: 0.5, false_open: 1, unsupported: 0.5, n: 2 });
  });
});
