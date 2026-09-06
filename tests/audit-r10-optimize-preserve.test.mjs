// R10 P1-4 + P2-2 + P3-3 — the three places the daily unattended `llm-optimize` run
// rewrote user data. All three ride the SAME background path: hook.mjs spawns
// 'llm-optimize' -> optimizeRun(db, { reenrichScope: 'wide' }), no human in the loop.
//
// P1-4: `wide` scope's whole job is lesson backfill. It also overwrote the title and
// truncated the narrative to 500 chars — on the "preserve-on-empty" branch too, so a row
// the LLM declined to rewrite still lost everything past character 500. The same UPDATE
// stamps optimized_at, which evicts the row from all three re-enrich pools forever, so the
// loss is permanent and there is no snapshot on this path (applyObsUpdate has one; this
// does not). The affected population is exactly the hand-written content: mem_save /
// mem_update --narrative / import-jsonl rows. hook-llm's own writes are already capped at
// 500, so they never noticed.
//
// P2-2: the weekly synonym normalize stamped optimized_at as a side effect of replacing a
// concept term, evicting the row from the lesson-backfill pool it had never visited.
// normalize does not need the stamp: its own re-run gate is a 7-day file timer, and the
// pass is idempotent because a canonicalized term no longer matches an alias.
//
// P3-3: the re-enrich UPDATE had no live-row guard, so a row superseded or compressed
// during the 45-second LLM round-trip was resurrected with stale content. The scopes
// branch above it already guards with `AND scope IS NULL`; FLOW-7 and the merge path
// already carry the filter. This one was missed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));
vi.mock('../haiku-client.mjs', () => ({
  callModelJSONAsync: vi.fn(),
  BG_LLM_TIMEOUT_MS: 45000,
}));
import { callModelJSONAsync } from '../haiku-client.mjs';

const COMPRESSED_AUTO = -1;

// A hand-written narrative well past the 500-char cut. Built from a repeated clause so the
// assertion can be "the exact original string", not "roughly this long".
const LONG_NARRATIVE = (
  'The pool LIMIT sits upstream of the JS-side relevance filter, which makes it a ' +
  'reachability bound rather than a ranking bound: a well-matching row below the cut is ' +
  'not down-ranked, it is unpickable. '
).repeat(9);

const LONG_TITLE = 'A SQL LIMIT upstream of a JS relevance filter is a reachability bound';

function seedWideCandidate(db, over = {}) {
  insertObs(db, {
    type: 'bugfix',
    importance: 2,
    title: LONG_TITLE,
    narrative: LONG_NARRATIVE,
    ...over,
  });
  return db.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
}

describe('R10 P1-4 — wide re-enrich backfills a lesson without rewriting content', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => db.close());

  it('premise: the row is a wide candidate and its narrative is past the 500-char cut', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    const row = seedWideCandidate(db);
    expect(LONG_NARRATIVE.length).toBeGreaterThan(500);
    expect(findReenrichCandidates(db, 10, { scope: 'wide' }).map((c) => c.id)).toContain(row.id);
  });

  it('preserves the full narrative and the title when the LLM returns an empty narrative', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    const row = seedWideCandidate(db);
    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      importance: 2,
      title: 'Limit is a reachability bound',
      narrative: '',
      concepts: ['sql', 'limit'],
      facts: ['the filter runs in JS'],
      lesson_learned: 'Count such populations with the pool own liveObsFilterSql',
      search_aliases: ['pool bound'],
    });
    const res = await executeReenrich(db, 5, { scope: 'wide' });
    expect(res.processed).toBe(1);

    const after = db.prepare('SELECT * FROM observations WHERE id = ?').get(row.id);
    expect(after.narrative, 'the narrative was truncated or replaced').toBe(LONG_NARRATIVE);
    expect(after.title, 'wide scope rewrote the title').toBe(LONG_TITLE);
    expect(after.lesson_learned, 'the lesson is what wide scope is FOR').toContain('liveObsFilterSql');
    expect(after.concepts).toContain('sql');
    expect(after.optimized_at).not.toBeNull();
  });

  it('preserves them even when the LLM returns a confident replacement narrative', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    const row = seedWideCandidate(db);
    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      importance: 2,
      title: 'Shorter title the model liked better',
      narrative: 'A LIMIT bounds reachability, not ranking.',
      concepts: ['sql'],
      facts: [],
      lesson_learned: 'anchor the count to the pool own filter',
      search_aliases: [],
    });
    await executeReenrich(db, 5, { scope: 'wide' });
    const after = db.prepare('SELECT * FROM observations WHERE id = ?').get(row.id);
    expect(after.narrative).toBe(LONG_NARRATIVE);
    expect(after.title).toBe(LONG_TITLE);
  });

  it('narrow scope still rewrites title and narrative — the behaviour that must NOT change', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    // A narrow candidate: all of concepts/facts/lesson/aliases empty.
    insertObs(db, { type: 'change', importance: 1, title: 'raw', narrative: 'short raw text' });
    const row = db.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    db.prepare(
      'UPDATE observations SET concepts=NULL, facts=NULL, lesson_learned=NULL, search_aliases=NULL, optimized_at=NULL WHERE id=?',
    ).run(row.id);
    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      importance: 2,
      title: 'A much better title',
      narrative: 'A much better narrative that explains the root cause.',
      concepts: ['a'],
      facts: ['b'],
      lesson_learned: 'c',
      search_aliases: ['d'],
    });
    await executeReenrich(db, 5, { scope: 'narrow' });
    const after = db.prepare('SELECT * FROM observations WHERE id = ?').get(row.id);
    expect(after.title).toBe('A much better title');
    expect(after.narrative).toBe('A much better narrative that explains the root cause.');
  });

  it('narrow scope keeps the stored narrative UNTRUNCATED when the LLM returns none', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, { type: 'change', importance: 1, title: 'raw', narrative: LONG_NARRATIVE });
    const row = db.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    db.prepare(
      'UPDATE observations SET concepts=NULL, facts=NULL, lesson_learned=NULL, search_aliases=NULL, optimized_at=NULL WHERE id=?',
    ).run(row.id);
    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      importance: 1,
      title: 'A better title',
      narrative: '',
      concepts: ['a'],
      facts: [],
      lesson_learned: 'c',
      search_aliases: [],
    });
    await executeReenrich(db, 5, { scope: 'narrow' });
    const after = db.prepare('SELECT * FROM observations WHERE id = ?').get(row.id);
    expect(after.narrative).toBe(LONG_NARRATIVE);
    expect(after.title, 'narrow may still improve the title').toBe('A better title');
  });
});

describe('R10 P2-2 — normalize must not evict a row from the lesson-backfill pool', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => db.close());

  it('leaves optimized_at NULL, so the row is still a wide candidate afterwards', async () => {
    const { applyNormalization, findReenrichCandidates } = await import('../hook-optimize.mjs');
    const row = seedWideCandidate(db);
    db.prepare('UPDATE observations SET concepts = ? WHERE id = ?').run('auth authentication', row.id);

    expect(
      findReenrichCandidates(db, 10, { scope: 'wide' }).map((c) => c.id),
      'premise: the row starts out wide-eligible',
    ).toContain(row.id);

    const res = applyNormalization(db, [{ canonical: 'authentication', aliases: ['auth'] }]);
    expect(res.updated, 'premise: normalize actually rewrote a concept term').toBe(1);

    const after = db.prepare('SELECT concepts, optimized_at FROM observations WHERE id = ?').get(row.id);
    expect(after.concepts, 'the canonicalization itself must still happen').toContain('authentication');
    expect(after.optimized_at, 'normalize stamped optimized_at').toBeNull();
    expect(
      findReenrichCandidates(db, 10, { scope: 'wide' }).map((c) => c.id),
      'the row was evicted from the wide pool by a synonym replacement',
    ).toContain(row.id);
  });
});

describe('R10 P3-3 — re-enrich must not write a row that died during the LLM round-trip', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => db.close());

  for (const [label, sql] of [
    ['superseded', 'UPDATE observations SET superseded_at = ? WHERE id = ?'],
    ['auto-compressed', `UPDATE observations SET compressed_into = ${COMPRESSED_AUTO} WHERE id = ?`],
  ]) {
    it(`skips a row ${label} mid-flight, leaving its content untouched`, async () => {
      const { executeReenrich } = await import('../hook-optimize.mjs');
      const row = seedWideCandidate(db);
      // The kill lands DURING the call, exactly as a concurrent hook would.
      callModelJSONAsync.mockImplementation(async () => {
        if (label === 'superseded') db.prepare(sql).run(Date.now(), row.id);
        else db.prepare(sql).run(row.id);
        return {
          type: 'bugfix',
          importance: 3,
          title: 'resurrected',
          narrative: 'resurrected',
          concepts: ['x'],
          facts: [],
          lesson_learned: 'this must not land',
          search_aliases: [],
        };
      });
      const res = await executeReenrich(db, 5, { scope: 'wide' });
      const after = db.prepare('SELECT * FROM observations WHERE id = ?').get(row.id);
      expect(after.lesson_learned, 'a dead row was rewritten').not.toBe('this must not land');
      expect(after.optimized_at, 'a dead row was stamped optimized_at').toBeNull();
      expect(res.skipped).toBe(1);
      expect(res.processed).toBe(0);
    });
  }
});
