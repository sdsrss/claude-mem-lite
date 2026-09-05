// Task 6 (offline benchmark, 2026-07-05): per-surface candidate replay — re-run the
// ACTUAL ranker seams (searchByFts via nowT/epochTo, rankImperativeCandidates via
// epochTo) at a virtual clock/snapshot and split the result into `shown` (what the
// live hook would have injected) vs `nearMiss` (candidates just below the cutoff).
//
// NOTE: observations.memory_session_id is NOT NULL with an FK to sdk_sessions
// (schema.mjs) — insertSession() must run first (known gotcha, carried from Tasks
// 1-2's own tests: tests/adoption-imperative-rank.test.mjs, tests/adoption-searchbyfts-
// snapshot.test.mjs). The plan's original seed() snippet omits this and fails the
// NOT NULL constraint.
import { describe, it, expect } from 'vitest';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { searchByFts } from '../scripts/user-prompt-search.js';
import { replayCandidates, splitShownNearMiss } from '../benchmark/adoption-rankers.mjs';

// Synthetic candidates for splitShownNearMiss — no DB, no FTS. Ids are letters so
// assertions read as "which candidates" rather than opaque indices.
function mkCand(runningVars) {
  return runningVars.map((runningVar, i) => ({
    id: String.fromCharCode(97 + i), // a, b, c, ...
    text: `cand-${i}`,
    runningVar,
  }));
}

describe('splitShownNearMiss (pure, synthetic candidates)', () => {
  it('straddles the floor and hits the cap: passing candidates split shown/near-miss at the floor', () => {
    const cand = mkCand([90, 70, 55, 40, 30]);
    const { shown, nearMiss } = splitShownNearMiss(cand, { floor: 50, cap: 3, m: 3 });
    expect(shown.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(nearMiss.map((c) => c.id)).toEqual(['d', 'e']);
  });

  it('exceeds the cap: more candidates pass the floor than `cap` allows, so shown truncates at cap and near-miss picks up the next m', () => {
    const cand = mkCand([95, 90, 85, 80, 75, 70]); // all >= floor
    const { shown, nearMiss } = splitShownNearMiss(cand, { floor: 50, cap: 3, m: 3 });
    expect(shown).toHaveLength(3);
    expect(shown.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(nearMiss.map((c) => c.id)).toEqual(['d', 'e', 'f']);
  });

  it('all below floor: shown is empty and near-miss is the first m candidates', () => {
    const cand = mkCand([40, 35, 30, 25, 20]);
    const { shown, nearMiss } = splitShownNearMiss(cand, { floor: 50, cap: 3, m: 3 });
    expect(shown).toEqual([]);
    expect(nearMiss.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });
});

function seed(db, rows) {
  insertSession(db, { id: 'mem-s1', project: 'p' });
  const ins = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, lesson_learned, importance, created_at, created_at_epoch)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows)
    ins.run(
      'mem-s1',
      'p',
      'bugfix',
      r.title,
      r.lesson,
      r.importance ?? 2,
      new Date(r.epoch).toISOString(),
      r.epoch,
    );
}

describe('replayCandidates', () => {
  it('imperative: shown=[argmax], near-miss=next by score', () => {
    const db = createTestDb();
    seed(db, [
      {
        title: 'rrfAccumulate',
        lesson: 'call rrfAccumulate for merge',
        importance: 3,
        epoch: 1_700_000_000_000,
      },
      {
        title: 'merge helper',
        lesson: 'the merge helper needs rrfAccumulate too',
        importance: 1,
        epoch: 1_700_000_100_000,
      },
    ]);
    const ev = { ts: 1_750_000_000_000, query: 'fix rrfAccumulate merge', surface: 'imperative' };
    const { shown, nearMiss } = replayCandidates('imperative', db, ev, { m: 3, project: 'p' });
    expect(shown).toHaveLength(1);
    expect(shown[0].text).toMatch(/rrfAccumulate/);
    expect(shown[0].runningVar).toBeGreaterThan(nearMiss[0]?.runningVar ?? -Infinity);
  });

  it('subagent surface shares the imperative ranker (alias dispatch)', () => {
    const db = createTestDb();
    seed(db, [
      {
        title: 'rrfAccumulate',
        lesson: 'call rrfAccumulate for merge',
        importance: 3,
        epoch: 1_700_000_000_000,
      },
    ]);
    const ev = { ts: 1_750_000_000_000, query: 'fix rrfAccumulate merge', surface: 'subagent' };
    const { shown } = replayCandidates('subagent', db, ev, { m: 3, project: 'p' });
    expect(shown).toHaveLength(1);
    expect(shown[0].text).toMatch(/rrfAccumulate/);
  });

  it('ups-fts: dispatches to searchByFts with the documented args and buckets by the 50 floor', () => {
    const db = createTestDb();
    seed(db, [
      {
        title: 'rrfAccumulate merge dedup',
        lesson: 'use rrfAccumulate for the merge dedup path',
        importance: 3,
        epoch: 1_749_000_000_000,
      },
      {
        title: 'unrelated topic entirely',
        lesson: 'nothing to do with any of this at all',
        importance: 1,
        epoch: 1_749_000_100_000,
      },
    ]);
    const ev = { ts: 1_750_000_000_000, query: 'rrfAccumulate merge dedup', surface: 'ups-fts' };
    const { shown, nearMiss } = replayCandidates('ups-fts', db, ev, { m: 3, project: 'p' });

    // Ground truth: the exact seam call replayCandidates must delegate to (Task 1 signature).
    const { rows } = searchByFts(db, ev.query, 'p', 3 + 3, null, { nowT: ev.ts, epochTo: ev.ts });
    const rawIds = rows.map((r) => String(r.id));

    // Wiring proof: relevance is sorted strongest-first and always same-signed (ORDER BY
    // relevance ASC over uniformly-negative composite scores — scripts/user-prompt-search.js),
    // so |relevance| is non-increasing across `rows`. A single floor split therefore always
    // partitions into a "shown" prefix + "near-miss" suffix — concatenating them back must
    // reproduce the exact raw id order regardless of where the 50-floor cut lands.
    expect([...shown, ...nearMiss].map((c) => c.id)).toEqual(rawIds);
    expect(shown.every((c) => c.runningVar >= 50)).toBe(true);
    expect(nearMiss.every((c) => c.runningVar < 50)).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(3);
    // text assembly per spec: title + ' ' + lesson_learned.
    expect(shown[0]?.text ?? nearMiss[0]?.text).toMatch(/rrfAccumulate/);
  });
});
