// D21 (R34): the A/B ruler that gates wiring the session's events into the summary.
// The gate must be able to say NO on every registered condition (doctrine rule 5).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { notLowSignalTitleClause } from '../utils.mjs';
import { readTranscriptEntries } from '../lib/transcript-scan.mjs';
import {
  gateD21,
  scoreVerdicts,
  judgeReplies,
  buildBlind,
  collectSessions,
  describeRows,
  splitBothYes,
  stopReplies,
} from '../benchmark/summary-events-ab.mjs';

// D#825: the ruler's replies are the ones the shipped Stop record would hold for the session.
describe('stopReplies', () => {
  const at = (m) => `2026-11-11T01:${String(m).padStart(2, '0')}:00Z`;
  const ms = (m) => Date.parse(at(m));
  const user = (content, m, extra = {}) => ({
    type: 'user',
    timestamp: at(m),
    message: { content },
    ...extra,
  });
  const asst = (text, m, extra = {}) => ({
    type: 'assistant',
    timestamp: at(m),
    message: { content: [{ type: 'text', text }] },
    ...extra,
  });
  const tool = (m) => ({
    type: 'user',
    timestamp: at(m),
    message: { content: [{ type: 'tool_result', content: 'ok' }] },
  });
  const session = (prompts, start = ms(0), end = Infinity) => ({ start, end, prompts: prompts.map(ms) });

  it('one reply per stored prompt: the last text before the turn ends', () => {
    const entries = [
      user('one', 1),
      asst('looking', 2),
      tool(3),
      asst('r1', 4),
      user('two', 5),
      asst('r2', 6),
    ];
    expect(stopReplies(entries, session([1, 5]))).toEqual(['r1', 'r2']);
  });

  it("a notice's turn stores no prompt, so its reply replaces the turn's", () => {
    const entries = [
      user('one', 1),
      asst('started the suite', 2),
      user('<task-notification>done</task-notification>', 3, { origin: { kind: 'task-notification' } }),
      asst('suite 12/12', 4),
    ];
    expect(stopReplies(entries, session([1]))).toEqual(['suite 12/12']);
  });

  it('a reply before the first stored prompt is its own turn, first', () => {
    const entries = [
      user('<task-notification>build done</task-notification>', 1),
      asst('the build passed', 2),
      user('next', 3),
      asst('r', 4),
    ];
    expect(stopReplies(entries, session([3]))).toEqual(['the build passed', 'r']);
  });

  it("Stops outside the session's span are another session's", () => {
    const entries = [
      user('before', 1),
      asst('old', 2),
      user('one', 10),
      asst('mine', 11),
      user('after', 20),
      asst('next', 21),
    ];
    expect(stopReplies(entries, session([10], ms(5), ms(20)))).toEqual(['mine']);
  });

  it('a compaction ends the turn: what follows is the next turn', () => {
    const entries = [
      user('one', 1),
      asst('mine', 2),
      { type: 'system', subtype: 'compact_boundary', timestamp: at(3) },
      user('summary', 3, { isCompactSummary: true }),
      asst('after compaction', 4),
    ];
    expect(stopReplies(entries, session([1], ms(0), ms(3)))).toEqual(['mine']);
  });

  it('a turn ended by an API error fires no Stop and records nothing', () => {
    const entries = [
      user('one', 1),
      asst('r1', 2),
      user('two', 3),
      asst('partial', 4),
      asst('API Error: Connection lost', 5, { isApiErrorMessage: true }),
      user('three', 6),
      asst('r3', 7),
    ];
    expect(stopReplies(entries, session([1, 3, 6]))).toEqual(['r1', 'r3']);
  });

  it("ignores a subagent's records, meta records and text-less assistant records", () => {
    const entries = [
      user('one', 1),
      asst('r1', 2),
      asst('sub', 3, { isSidechain: true }),
      user('caveat', 3, { isMeta: true }),
      { type: 'assistant', timestamp: at(4), message: { content: [{ type: 'tool_use' }] } },
    ];
    expect(stopReplies(entries, session([1]))).toEqual(['r1']);
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

describe('buildBlind', () => {
  it('gives judges no arm, the same ids in both orders, and a key that maps every id back', () => {
    const row = (item, arm) => ({
      item,
      arm,
      completed: `c${item}${arm}`,
      remaining_items: '',
      next_steps: '',
    });
    const dump = {
      items: [0, 1, 2].map((i) => ({ replies: { turns: 1, shown: [{ turn: 1, reply: `r${i}` }] } })),
      rows: [row(0, 'A'), row(0, 'B'), row(1, 'B'), row(1, 'A'), row(2, 'A'), row(2, 'B')],
    };
    const { batches, key } = buildBlind(dump, { seed: 7, batches: 2 });
    const seen = batches.flatMap((b) => b.a);
    expect(seen.map((e) => e.id).sort()).toEqual(Object.keys(key).sort());
    for (const b of batches) expect(b.b.map((e) => e.id).sort()).toEqual(b.a.map((e) => e.id).sort());
    for (const e of seen) {
      expect(Object.keys(e).sort()).toEqual(['id', 'replies', 'summary']);
      expect(Object.keys(e.summary).sort()).toEqual(['completed', 'next_steps', 'remaining_items']);
      const { arm, item } = key[e.id];
      expect(e.summary.completed).toBe(`c${item}${arm}`); // the key points at the row the judge saw
      expect(e.replies).toBe(dump.items[item].replies);
    }
  });
});

describe('collectSessions: the window is the session, not its first Stop (R34 review H1)', () => {
  it("counts events and turns after the session's one summary row, up to the next session", () => {
    const db = createTestDb();
    const projects = mkdtempSync(join(tmpdir(), 'd21-ab-'));
    try {
      const T0 = Date.parse('2026-11-01T00:00:00Z');
      const min = (m) => T0 + m * 60000;
      insertSession(db, { id: 'S', project: 'p' });
      insertSession(db, { id: 'N', project: 'p' });
      const started = db.prepare('UPDATE sdk_sessions SET started_at_epoch = ? WHERE content_session_id = ?');
      started.run(min(-1), 'S');
      started.run(min(65), 'N');
      const prompt = db.prepare(
        `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch, cc_session_id)
         VALUES (?, ?, ?, '', ?, ?)`,
      );
      prompt.run('S', 'first ask', 1, min(0), 'cc-S');
      prompt.run('S', 'second ask', 2, min(60), 'cc-S');
      prompt.run('N', 'next session', 1, min(66), 'cc-N'); // inside S's 10-minute grace
      db.prepare(
        `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, importance, created_at, created_at_epoch)
         VALUES ('S', 'p', '', 'decision', 'Designed the cache layer', '', 1, '', ?)`,
      ).run(min(1));
      // The one summary row, stamped by the FIRST Stop and never moved.
      db.prepare(
        `INSERT INTO session_summaries (memory_session_id, project, created_at, created_at_epoch) VALUES ('S', 'p', '', ?)`,
      ).run(min(5));
      const event = db.prepare(
        `INSERT INTO events (project, event_type, title, importance, created_at_epoch) VALUES ('p', 'bugfix', ?, 1, ?)`,
      );
      event.run('previous session, late', min(-1));
      event.run('turn 1 fix', min(2));
      event.run('turn 2 fix, after the summary row', min(62));
      event.run('after the grace', min(72));
      event.run('the next session', min(67)); // before S's grace ends, after N began
      mkdirSync(join(projects, 'proj'));
      const at = (m) => new Date(min(m)).toISOString();
      writeFileSync(
        join(projects, 'proj', 'cc-S.jsonl'),
        [
          { type: 'user', timestamp: at(0), message: { content: 'first ask' } },
          {
            type: 'assistant',
            timestamp: at(3),
            message: { content: [{ type: 'text', text: 'turn 1 done' }] },
          },
          { type: 'user', timestamp: at(60), message: { content: 'second ask' } },
          {
            type: 'assistant',
            timestamp: at(61),
            message: { content: [{ type: 'text', text: 'turn 2 done' }] },
          },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n'),
      );
      const pop = collectSessions(db, {
        days: 30,
        now: min(24 * 60),
        projectsDir: projects,
        notLowSignalTitleClause,
        readEntries: readTranscriptEntries,
      });
      expect(pop.items.map((i) => i.sid)).toEqual(['S']); // N has no summary row
      expect(pop.items[0].events.map((e) => e.title)).toEqual([
        'turn 2 fix, after the summary row',
        'turn 1 fix',
      ]);
      expect(pop.items[0].replies).toEqual(['turn 1 done', 'turn 2 done']);
    } finally {
      db.close();
      rmSync(projects, { recursive: true, force: true });
    }
  });
});

describe('gateD21 boundaries and completeness', () => {
  const base = () => ({
    n: 30,
    agreement: { missed_done: 0.7, false_open: 0.7, unsupported: 0.7 },
    A: { usable: 28, judged: 30, missed_done: 10, false_open: 3, unsupported: 2 },
    B: { usable: 28, judged: 30, missed_done: 7, false_open: 4, unsupported: 3 },
  });
  it('ships at exactly n-2 usable and exactly 0.70 agreement', () => {
    expect(gateD21(base()).ship).toBe(true);
  });
  it('says NO at n-3 usable, and when an item lacks two valid verdicts', () => {
    const a = base();
    a.A.usable = 27;
    expect(gateD21(a).ship).toBe(false);
    const b = base();
    b.B.judged = 29;
    expect(gateD21(b)).toEqual({ ship: false, reasons: ['judged(B) = 29 < 30'] });
  });
});

describe('buildBlind ids', () => {
  it('are shuffled, so an id says nothing about row order or arm', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      item: i >> 1,
      arm: i % 2 ? 'B' : 'A',
      completed: '',
    }));
    const dump = { items: Array.from({ length: 5 }, () => ({ replies: {} })), rows };
    const { key } = buildBlind(dump, { seed: 3, batches: 1 });
    const inRowOrder = Object.keys(key);
    expect(inRowOrder).not.toEqual([...inRowOrder].sort());
  });
});

describe('D22 arm C: scoring, descriptive rows and the split', () => {
  const Y = { missed_done: 'YES', false_open: 'NO', unsupported: 'NO' };
  const N = { missed_done: 'NO', false_open: 'NO', unsupported: 'NO' };

  it('scores arm C when the key holds it, and only the arms present', () => {
    const key = { e1: { arm: 'A', item: 0 }, e2: { arm: 'C', item: 0 } };
    const { arms } = scoreVerdicts(key, { e1: Y, e2: N }, { e1: Y, e2: N }, { A: 1, C: 1 });
    expect(Object.keys(arms)).toEqual(['A', 'C']);
    expect(arms.A.missed_done).toBe(1);
    expect(arms.C.missed_done).toBe(0);
    expect(arms.C.judged).toBe(1);
  });

  it('splits both-YES counts by turns and by the stored provenance', () => {
    const key = {
      e1: { arm: 'A', item: 0 },
      e2: { arm: 'C', item: 0 },
      e3: { arm: 'A', item: 1 },
      e4: { arm: 'C', item: 1 },
    };
    const v = { e1: Y, e2: N, e3: Y, e4: Y };
    const items = [
      { turns: 3, provenance: 'model' },
      { turns: 1, provenance: 'report' },
    ];
    const out = splitBothYes(key, v, v, items);
    expect(out.multi.A).toEqual({ n: 1, missed_done: 1, false_open: 0, unsupported: 0 });
    expect(out.multi.C.missed_done).toBe(0);
    expect(out.single.C.missed_done).toBe(1);
    expect(out['provenance:model'].A.missed_done).toBe(1);
    expect(out['provenance:report'].A.n).toBe(1);
    // one judge saying NO is not a hit
    expect(splitBothYes(key, v, { ...v, e1: N }, items).multi.A.missed_done).toBe(0);
  });

  it('describes each arm: usable, prompt size, completed size, median call time', () => {
    const rows = [
      { arm: 'A', usable: true, promptChars: 100, completedChars: 10, ms: 5 },
      { arm: 'A', usable: false, promptChars: 300, completedChars: 0, ms: 9 },
      { arm: 'C', usable: true, promptChars: 900, completedChars: 40, ms: 7 },
    ];
    expect(describeRows(rows, ['A', 'C'])).toEqual({
      usable: { A: 1, C: 1 },
      meanPromptChars: { A: 200, C: 900 },
      maxPromptChars: { A: 300, C: 900 },
      meanCompletedChars: { A: 5, C: 40 },
      medianMs: { A: 5, C: 7 },
    });
  });
});
