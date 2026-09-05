// tests/adoption-imperative-rank.test.mjs
// Task 2 (offline benchmark, 2026-07-05): extract the FULL scored candidate list behind
// selectImperativeLesson's single top-1 pick, so the benchmark can inspect near-miss
// candidates just below the winner. Characterizes rankImperativeCandidates() and locks
// selectImperativeLesson() as its thin [0] wrapper (behavior-preserving refactor).
import { describe, it, expect } from 'vitest';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { selectImperativeLesson, rankImperativeCandidates } from '../hook-memory.mjs';

// NOTE: observations.memory_session_id is NOT NULL with an FK to sdk_sessions
// (schema.mjs) — insertSession() must run first (known gotcha, carried from Task 1).
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

describe('rankImperativeCandidates', () => {
  it('returns a score-sorted candidate list, argmax === selectImperativeLesson', () => {
    const db = createTestDb();
    seed(db, [
      {
        title: 'rrfAccumulate',
        lesson: 'call rrfAccumulate not manual merge',
        importance: 3,
        epoch: 1_700_000_000_000,
      },
      {
        title: 'recoverChildrenOf',
        lesson: 'call recoverChildrenOf before delete',
        importance: 2,
        epoch: 1_700_000_100_000,
      },
    ]);
    const prompt = 'I need to fix the rrfAccumulate merge path';
    const ranked = rankImperativeCandidates(db, prompt, 'p');
    expect(ranked.length).toBeGreaterThanOrEqual(1);
    expect(ranked[0].lesson_learned).toMatch(/rrfAccumulate/);
    expect(ranked.every((c) => c.overlap >= 1)).toBe(true);
    const winner = selectImperativeLesson(db, prompt, 'p');
    expect(winner).toEqual({ id: ranked[0].id, lesson_learned: ranked[0].lesson_learned });
  });

  it('epochTo filters out later rows', () => {
    const db = createTestDb();
    seed(db, [
      { title: 'rrfAccumulate', lesson: 'call rrfAccumulate', importance: 3, epoch: 1_900_000_000_000 },
    ]);
    expect(
      rankImperativeCandidates(db, 'rrfAccumulate merge', 'p', [], { epochTo: 1_800_000_000_000 }),
    ).toEqual([]);
  });

  // D#172 上闸. The pool's LIMIT is applied BEFORE the identifier-overlap filter, so
  // whatever it is set to is a hard reachability bound, not a ranking bound: a lesson
  // outside the window cannot be picked however well it matches. At LIMIT 50 that made
  // the face reachable only from the 50 newest importance>=2 rows, and in five real
  // projects the importance=3 population ALONE exceeds 50 (projects--mem 327,
  // code-graph-mcp 121 — counted with the pool's own liveObsFilterSql, not raw) — so
  // every importance=2 lesson there was structurally unreachable, and a decay demotion
  // 3->2 EVICTED a row from the pool rather than down-ranking it. Measured on 373 real
  // prompts paired to their own project's corpus by benchmark/imperative-pool-replay.mjs:
  // the cap destroyed 7 of 85 picks outright and changed the top-1 in 3 of 78.
  it('reaches a matching lesson buried under a filler population far past the old LIMIT 50', () => {
    const db = createTestDb();
    const rows = [];
    // 200 NEWER, higher-importance, NON-matching rows — 4x the old cap, so a bump to
    // 100 would not rescue this either. The point is that the bound stops being a
    // relevance gate at all, not that it moved.
    for (let i = 0; i < 200; i++) {
      rows.push({
        title: `filler${i}`,
        lesson: `unrelated advice number ${i}`,
        importance: 3,
        epoch: 1_700_001_000_000 + i,
      });
    }
    // The only row that matches the prompt — older AND lower importance, i.e. dead last
    // in the pool's ORDER BY, which is exactly where a decay demotion puts a row.
    rows.push({
      title: 'rrfAccumulate',
      lesson: 'call rrfAccumulate not manual merge',
      importance: 2,
      epoch: 1_700_000_000_000,
    });
    seed(db, rows);
    const ranked = rankImperativeCandidates(db, 'fix the rrfAccumulate merge path', 'p');
    expect(ranked).toHaveLength(1);
    expect(ranked[0].lesson_learned).toMatch(/rrfAccumulate/);
    expect(selectImperativeLesson(db, 'fix the rrfAccumulate merge path', 'p')).not.toBeNull();
  });

  it('does not let the enlarged pool change ordering: score still decides', () => {
    // Anti-tautology for the case above — raising the bound must widen REACHABILITY
    // without touching the ranking. Two matching rows, the better one buried deepest.
    const db = createTestDb();
    const rows = [];
    for (let i = 0; i < 120; i++) {
      rows.push({
        title: `filler${i}`,
        lesson: `unrelated advice number ${i}`,
        importance: 3,
        epoch: 1_700_001_000_000 + i,
      });
    }
    rows.push({
      title: 'weak',
      lesson: 'rrfAccumulate is involved',
      importance: 2,
      epoch: 1_700_000_500_000,
    });
    rows.push({
      title: 'strong',
      lesson: 'rrfAccumulate and rrfFuseN must agree',
      importance: 2,
      epoch: 1_700_000_000_000,
    });
    seed(db, rows);
    const ranked = rankImperativeCandidates(db, 'editing rrfAccumulate and rrfFuseN', 'p');
    expect(ranked).toHaveLength(2);
    // `strong` is the OLDEST row of the three thousand-odd — last in the pool order —
    // and still wins, because overlap (2) beats overlap (1).
    expect(ranked[0].lesson_learned).toBe('rrfAccumulate and rrfFuseN must agree');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('orders the pool TOTALLY, so a widened bound is a superset of a narrow one', () => {
    // The v3.82.0 widening argument needs the narrow pool to be a PREFIX of the wide one.
    // `ORDER BY importance DESC, created_at_epoch DESC` alone is not a total order, and
    // SQLite may sort a small LIMIT with a bounded top-N sorter and a large one with a
    // full sort — so rows tied on both keys could come back in different relative orders
    // at different bounds. The `id DESC` tiebreaker removes that freedom. Here every row
    // is deliberately tied on BOTH keys, which is the only shape that can expose it.
    const db = createTestDb();
    const rows = [];
    for (let i = 0; i < 6; i++) {
      rows.push({
        title: `t${i}`,
        lesson: 'rrfAccumulate needs care',
        importance: 2,
        epoch: 1_700_000_000_000,
      });
    }
    seed(db, rows);
    const ranked = rankImperativeCandidates(db, 'touching rrfAccumulate', 'p');
    expect(ranked).toHaveLength(6);
    // Every candidate ties on score, so the surviving order IS the pool order: strictly
    // descending id. Without the tiebreaker this is whatever the query planner returns.
    const ids = ranked.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(6);
  });

  // Beyond the brief: the whole point of this extraction is near-miss visibility — assert
  // BOTH overlapping candidates survive (not just the argmax), sorted score desc.
  it('keeps every overlapping candidate, sorted by score desc (near-miss visibility)', () => {
    const db = createTestDb();
    seed(db, [
      { title: 'a', lesson: 'touch rrfAccumulate carefully', importance: 2, epoch: 1_700_000_000_000 },
      {
        title: 'b',
        lesson: 'rrfAccumulate and rrfFuseN must agree',
        importance: 3,
        epoch: 1_700_000_100_000,
      },
    ]);
    const ranked = rankImperativeCandidates(db, 'editing rrfAccumulate today', 'p');
    expect(ranked.length).toBe(2);
    expect(ranked[0].lesson_learned).toBe('rrfAccumulate and rrfFuseN must agree');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[1].lesson_learned).toBe('touch rrfAccumulate carefully'); // near-miss, still present
  });
});
