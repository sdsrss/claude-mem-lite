// benchmark/cutoff-reach-probe.mjs (proposal B3): counts what PreToolUse recall's 60-day cut
// removes, split by whether the edge is still in use. A probe that cannot say NO is not a probe
// (doctrine rule 5): the fresh-row case below must read zero while the old rows read non-zero.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { probeCutoffReach } from '../benchmark/cutoff-reach-probe.mjs';
import { PRETOOL_LOOKBACK_MS, DAY_MS } from '../lib/time-constants.mjs';

const NOW = Date.parse('2026-11-10T00:00:00Z');

describe('probeCutoffReach', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 's1', project: 'p' });
  });
  afterEach(() => db.close());

  // Edge states lib/edge-attribution.mjs can produce: a hit stamps last_cited_session_id and
  // resets miss_streak; a miss increments both counters; an edge never injected has neither.
  function obs({ ageDays, importance = 2, files = ['/r/a.mjs'], state = 'never' }) {
    const [inject, miss, cited] =
      state === 'hit'
        ? [2, 0, 'sess-x']
        : state === 'hitThenMiss'
          ? [5, 2, 'sess-x']
          : state === 'miss'
            ? [3, 3, null]
            : [0, 0, null];
    const { lastInsertRowid } = insertObs(db, {
      sessionId: 's1',
      project: 'p',
      title: `row ${ageDays}d`,
      importance,
      lessonLearned: 'a lesson',
      epochOffset: NOW - Date.now() - ageDays * DAY_MS,
    });
    const id = Number(lastInsertRowid);
    // Pin the timestamp exactly: insertObs adds its OWN Date.now() to epochOffset, so the row
    // lands a millisecond or two after NOW - ageDays whenever the clock ticks between the two
    // calls (CI, Node 26: '…00.001Z' vs '…00.000Z' on the firstBites assertion).
    db.prepare('UPDATE observations SET created_at_epoch = ? WHERE id = ?').run(NOW - ageDays * DAY_MS, id);
    for (const f of files) {
      db.prepare(
        'INSERT INTO observation_files (obs_id, filename, inject_count, miss_streak, last_cited_session_id) VALUES (?, ?, ?, ?, ?)',
      ).run(id, f, inject, miss, cited);
    }
    return id;
  }

  it('the window is the shipped one', () => {
    expect(PRETOOL_LOOKBACK_MS).toBe(60 * DAY_MS);
  });

  it('reads zero when every row is inside the window — the NO answer', () => {
    obs({ ageDays: 10, state: 'hit' });
    obs({ ageDays: 59, state: 'hit' });
    const r = probeCutoffReach(db, { now: NOW });
    expect(r.obsEdges.total).toBe(0);
    expect(r.obsEdges.inUse).toEqual([]);
    // first bite = oldest row + 60 days
    expect(r.firstBites).toBe(new Date(NOW - 59 * DAY_MS + PRETOOL_LOOKBACK_MS).toISOString());
  });

  it('splits removed edges into cited (in use) / missed / never injected, per edge', () => {
    const citedId = obs({ ageDays: 90, state: 'hit', files: ['/r/a.mjs', '/r/b.mjs'] });
    const reusedId = obs({ ageDays: 85, state: 'hitThenMiss' }); // cited once, passed over twice since
    obs({ ageDays: 80, state: 'miss' }); // shown three times, never cited: not in use
    obs({ ageDays: 70 }); // never injected: miss_streak 0 but NOT in use (review P2-1)
    obs({ ageDays: 75, importance: 1, state: 'hit' }); // below recall's importance floor
    obs({ ageDays: 5, state: 'hit' }); // inside the window
    const r = probeCutoffReach(db, { now: NOW });
    expect(r.obsEdges.total).toBe(5);
    expect(r.obsEdges.cited).toBe(3);
    expect(r.obsEdges.citedThenMissed).toBe(1);
    expect(r.obsEdges.missed).toBe(1);
    expect(r.obsEdges.neverInjected).toBe(1);
    expect(r.obsEdges.inUse.map((e) => e.id)).toEqual([citedId, citedId, reusedId]);
  });

  // D#353: B3 is decided on edges written on or after the regime boundary only, so the removed
  // edges split by their row's created_at at a given instant, each side with its own cited share.
  it('--split counts each side of an instant: edges, injected, cited', () => {
    obs({ ageDays: 100, state: 'hit' }); // before
    obs({ ageDays: 95, state: 'miss' }); // before
    obs({ ageDays: 70, state: 'hit', files: ['/r/a.mjs', '/r/b.mjs'] }); // after, 2 edges
    obs({ ageDays: 68, state: 'miss' }); // after
    obs({ ageDays: 65 }); // after, never injected
    const splitAt = NOW - 80 * DAY_MS;
    const r = probeCutoffReach(db, { now: NOW, splitAt });
    expect(r.obsEdges.split).toEqual({
      at: new Date(splitAt).toISOString(),
      before: { edges: 2, injected: 2, cited: 1 },
      after: { edges: 4, injected: 3, cited: 2 },
    });
    // The NO answer: nothing written after the instant has reached the cut yet.
    expect(probeCutoffReach(db, { now: NOW, splitAt: NOW - 50 * DAY_MS }).obsEdges.split.after).toEqual({
      edges: 0,
      injected: 0,
      cited: 0,
    });
    expect(probeCutoffReach(db, { now: NOW }).obsEdges.split).toBeUndefined();
  });

  it('a superseded row is not counted — liveObsFilterSql, as recall applies it', () => {
    const id = obs({ ageDays: 90, state: 'hit' });
    db.prepare('UPDATE observations SET superseded_at = ? WHERE id = ?').run(NOW, id);
    expect(probeCutoffReach(db, { now: NOW }).obsEdges.total).toBe(0);
  });
});
