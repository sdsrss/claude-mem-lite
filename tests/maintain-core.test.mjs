// Characterization tests for lib/maintain-core.mjs — the shared maintenance ops
// extracted from cmdMaintain (CLI), mem_maintain (MCP), and handleAutoMaintain
// (hook). Headline: decayAndMarkIdle protects injection_count>0, the clause that
// had drifted out of the MCP copy (mem_maintain used to decay/purge injected
// memories the CLI + hook preserve). The rest pin each op's exact mutation.

import { describe, test, expect } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { COMPRESSED_PENDING_PURGE } from '../utils.mjs';
import {
  cleanupBroken,
  decayAndMarkIdle,
  boostAccessed,
  demotePinned,
  mergeDuplicates,
  purgeStale,
  purgeStalePreview,
  recoverChildrenOf,
  recoverOrphanedChildren,
  recoverBuriedLessons,
  selectFuzzyDedupeIds,
  maintenanceStats,
  hardDeleteCandidateCount,
  sweepDeferredWorkOrphans,
} from '../lib/maintain-core.mjs';

const DAY = 86400000;
const OLD = -40 * DAY; // past the 30-day stale gate
const ctx = (staleAge) => ({ projectFilter: '', baseParams: [], staleAge, opCap: 1000 });
const get = (db, id, col) => db.prepare(`SELECT ${col} AS v FROM observations WHERE id = ?`).get(id).v;
const add = (db, o) =>
  Number(insertObs(db, { sessionId: 'sess-1', project: 'proj-a', epochOffset: OLD, ...o }).lastInsertRowid);

function freshDb() {
  const db = createTestDb();
  insertSession(db, { id: 'sess-1', project: 'proj-a' });
  return db;
}

describe('hardDeleteCandidateCount (MED-2 pre-maintenance snapshot guard)', () => {
  test('counts pending-purge and/or broken rows per selected ops; 0 when none', () => {
    const db = freshDb();
    add(db, { title: 'live' }); // neither
    add(db, { title: 'doomed', compressedInto: COMPRESSED_PENDING_PURGE }); // purge candidate
    add(db, { title: '', narrative: '' }); // broken candidate

    expect(hardDeleteCandidateCount(db, ctx(), { purge: true })).toBe(1);
    expect(hardDeleteCandidateCount(db, ctx(), { cleanup: true })).toBe(1);
    expect(hardDeleteCandidateCount(db, ctx(), { cleanup: true, purge: true })).toBe(2);
    expect(hardDeleteCandidateCount(db, ctx(), {})).toBe(0); // no destructive op selected
    db.close();
  });

  test('returns 0 on a clean DB (no snapshot taken for a no-op maintenance run)', () => {
    const db = freshDb();
    add(db, { title: 'healthy', narrative: 'fine' });
    expect(hardDeleteCandidateCount(db, ctx(), { cleanup: true, purge: true })).toBe(0);
    db.close();
  });
});

describe('recoverOrphanedChildren (self-heal legacy orphans — keeper deleted pre-recoverChildrenOf)', () => {
  test('resurfaces children whose keeper no longer exists; leaves valid keepers + negative sentinels alone', () => {
    const db = freshDb();
    const keeper = add(db, { title: 'live keeper' });
    const validChild = add(db, { title: 'valid child', compressedInto: keeper }); // keeper exists → stay hidden
    const orphan = add(db, { title: 'orphaned child', compressedInto: 88888 }); // keeper gone → resurface
    const autoMarked = add(db, { title: 'auto', compressedInto: -1 }); // COMPRESSED_AUTO sentinel
    const pendingPurge = add(db, { title: 'pending', compressedInto: COMPRESSED_PENDING_PURGE }); // -2 sentinel

    const recovered = recoverOrphanedChildren(db, ctx());

    expect(recovered).toBe(1); // only the orphan
    expect(get(db, orphan, 'compressed_into')).toBeNull(); // resurfaced to live
    expect(get(db, validChild, 'compressed_into')).toBe(keeper); // untouched (keeper exists)
    expect(get(db, autoMarked, 'compressed_into')).toBe(-1); // sentinel untouched
    expect(get(db, pendingPurge, 'compressed_into')).toBe(COMPRESSED_PENDING_PURGE); // sentinel untouched
    db.close();
  });

  test('is idempotent — a second pass recovers nothing', () => {
    const db = freshDb();
    add(db, { title: 'orphan', compressedInto: 77777 });
    expect(recoverOrphanedChildren(db, ctx())).toBe(1);
    expect(recoverOrphanedChildren(db, ctx())).toBe(0);
    db.close();
  });

  test('respects projectFilter (only recovers orphans in the scoped project)', () => {
    const db = freshDb();
    insertSession(db, { id: 'sess-b', project: 'proj-b' });
    add(db, { title: 'orphan a', compressedInto: 66666 }); // proj-a (add default)
    Number(
      insertObs(db, {
        sessionId: 'sess-b',
        project: 'proj-b',
        epochOffset: OLD,
        title: 'orphan b',
        compressedInto: 55555,
      }).lastInsertRowid,
    );
    const recovered = recoverOrphanedChildren(db, {
      projectFilter: 'AND project = ?',
      baseParams: ['proj-a'],
    });
    expect(recovered).toBe(1); // only the proj-a orphan
    db.close();
  });
});

describe('sweepDeferredWorkOrphans (P3-5: heal FK orphans left by FK-OFF deletes)', () => {
  // Insert a deferred_work row directly (no test-helper for this table). To reproduce the real
  // orphan end-state, dangling refs are written with foreign_keys OFF — mirroring the warm-start
  // fast-path under which the referenced obs was hard-deleted without the ON DELETE SET NULL
  // firing (createTestDb runs FK ON, which would otherwise reject a dangling ref at insert time).
  const addDefer = (db, o) => {
    db.pragma('foreign_keys = OFF');
    const id = Number(
      db
        .prepare(
          `
      INSERT INTO deferred_work (project, title, status, created_at_epoch, closed_at_epoch, closed_by_obs_id, source_prompt_id)
      VALUES (@project, @title, @status, @created_at_epoch, @closed_at_epoch, @closed_by_obs_id, @source_prompt_id)
    `,
        )
        .run({
          project: 'proj-a',
          title: 't',
          status: 'open',
          created_at_epoch: 1,
          closed_at_epoch: null,
          closed_by_obs_id: null,
          source_prompt_id: null,
          ...o,
        }).lastInsertRowid,
    );
    db.pragma('foreign_keys = ON');
    return id;
  };
  const defer = (db, id, col) => db.prepare(`SELECT ${col} AS v FROM deferred_work WHERE id = ?`).get(id).v;

  test('nulls a dangling closed_by_obs_id / source_prompt_id; keeps valid refs + status', () => {
    const db = freshDb();
    const liveObs = add(db, { title: 'live obs' });
    const valid = addDefer(db, { status: 'done', closed_at_epoch: 5, closed_by_obs_id: liveObs }); // obs exists → keep
    const orphanObs = addDefer(db, { status: 'done', closed_at_epoch: 6, closed_by_obs_id: 99999 }); // obs gone → null
    const orphanPrompt = addDefer(db, { source_prompt_id: 88888 }); // prompt gone → null

    const healed = sweepDeferredWorkOrphans(db, ctx());

    expect(healed).toBe(2); // two dangling refs
    expect(defer(db, orphanObs, 'closed_by_obs_id')).toBeNull(); // dangling ref dropped
    expect(defer(db, orphanObs, 'status')).toBe('done'); // closure NOT reopened
    expect(defer(db, orphanObs, 'closed_at_epoch')).toBe(6); // closed_at preserved
    expect(defer(db, orphanPrompt, 'source_prompt_id')).toBeNull();
    expect(defer(db, valid, 'closed_by_obs_id')).toBe(liveObs); // valid ref untouched
    db.close();
  });

  test('is idempotent — a second pass heals nothing', () => {
    const db = freshDb();
    addDefer(db, { closed_by_obs_id: 77777 });
    expect(sweepDeferredWorkOrphans(db, ctx())).toBe(1);
    expect(sweepDeferredWorkOrphans(db, ctx())).toBe(0);
    db.close();
  });

  test('respects projectFilter (only heals orphans in the scoped project)', () => {
    const db = freshDb();
    addDefer(db, { project: 'proj-a', closed_by_obs_id: 66666 });
    addDefer(db, { project: 'proj-b', closed_by_obs_id: 55555 });
    expect(sweepDeferredWorkOrphans(db, { projectFilter: 'AND project = ?', baseParams: ['proj-a'] })).toBe(
      1,
    );
    db.close();
  });
});

describe('recoverBuriedLessons (heal lesson rows citation-decay buried at importance 0)', () => {
  test('lifts a lesson-bearing imp-0 row to 1; leaves non-lesson imp-0 + higher-imp rows alone', () => {
    const db = freshDb();
    const buriedLesson = add(db, {
      title: 'buried',
      importance: 0,
      lessonLearned: 'root cause + fix',
      injectionCount: 5,
    });
    const buriedNoise = add(db, { title: 'noise', importance: 0, lessonLearned: null, injectionCount: 5 });
    const noneLesson = add(db, {
      title: 'none-str',
      importance: 0,
      lessonLearned: 'none',
      injectionCount: 5,
    });
    const liveLesson = add(db, { title: 'live', importance: 2, lessonLearned: 'still useful' });

    const healed = recoverBuriedLessons(db, ctx());

    expect(healed).toBe(1); // only the buried lesson row
    expect(get(db, buriedLesson, 'importance')).toBe(1);
    expect(get(db, buriedNoise, 'importance')).toBe(0); // non-lesson exhaust stays buried
    expect(get(db, noneLesson, 'importance')).toBe(0); // literal 'none' is not a lesson
    expect(get(db, liveLesson, 'importance')).toBe(2); // untouched
    db.close();
  });

  test('idempotent — a second pass heals nothing', () => {
    const db = freshDb();
    add(db, { title: 'buried', importance: 0, lessonLearned: 'fix', injectionCount: 3 });
    expect(recoverBuriedLessons(db, ctx())).toBe(1);
    expect(recoverBuriedLessons(db, ctx())).toBe(0);
    db.close();
  });

  test('never un-hides a compressed row (compressed_into set) even if it carries a lesson', () => {
    const db = freshDb();
    const hidden = add(db, {
      title: 'compressed',
      importance: 0,
      lessonLearned: 'fix',
      compressedInto: COMPRESSED_PENDING_PURGE,
    });
    expect(recoverBuriedLessons(db, ctx())).toBe(0);
    expect(get(db, hidden, 'importance')).toBe(0);
    db.close();
  });

  test('never lifts a superseded row (de-dup loser) back into injectability', () => {
    // auto-dedup sets superseded_at but leaves compressed_into=0, so the compressed guard
    // alone would miss it. The injection surfaces filter superseded_at IS NULL; this must too,
    // or a superseded duplicate gets re-injected via user-prompt-search after healing.
    const db = freshDb();
    const superseded = add(db, {
      title: 'de-dup loser',
      importance: 0,
      lessonLearned: 'fix',
      supersededAt: Date.now(),
    });
    expect(recoverBuriedLessons(db, ctx())).toBe(0);
    expect(get(db, superseded, 'importance')).toBe(0);
    db.close();
  });

  test('respects projectFilter — only heals the scoped project', () => {
    const db = freshDb();
    add(db, { title: 'lesson a', importance: 0, lessonLearned: 'fix', injectionCount: 2 }); // proj-a (add default)
    insertSession(db, { id: 'sess-b', project: 'proj-b' });
    Number(
      insertObs(db, {
        sessionId: 'sess-b',
        project: 'proj-b',
        title: 'lesson b',
        importance: 0,
        lessonLearned: 'fix',
        injectionCount: 2,
      }).lastInsertRowid,
    );
    const healed = recoverBuriedLessons(db, { projectFilter: 'AND project = ?', baseParams: ['proj-a'] });
    expect(healed).toBe(1); // only the proj-a lesson
    db.close();
  });
});

describe('recoverChildrenOf (shared hard-delete guard — CLI + MCP + maintain)', () => {
  test('resets compressed_into to NULL for rows pointing at the doomed keepers', () => {
    const db = freshDb();
    const keeper = add(db, { title: 'keeper' });
    const childA = add(db, { title: 'child A', compressedInto: keeper });
    const childB = add(db, { title: 'child B', compressedInto: keeper });
    const unrelated = add(db, { title: 'unrelated', compressedInto: 99999 });

    const recovered = recoverChildrenOf(db, [keeper]);

    expect(recovered).toBe(2);
    expect(get(db, childA, 'compressed_into')).toBeNull(); // resurfaced as live
    expect(get(db, childB, 'compressed_into')).toBeNull();
    expect(get(db, unrelated, 'compressed_into')).toBe(99999); // untouched
  });

  test('no-op (returns 0) when the id list is empty', () => {
    const db = freshDb();
    expect(recoverChildrenOf(db, [])).toBe(0);
  });

  test('does not recover (or count) a child that is itself in the delete set', () => {
    // `delete 1,2` where #2 was merged INTO #1: #2 must NOT be reported as recovered-to-live
    // because it is deleted in the same call. Only children that actually survive count.
    const db = freshDb();
    const keeper = add(db, { title: 'keeper' });
    const childInSet = add(db, { title: 'child also deleted', compressedInto: keeper });
    const childKept = add(db, { title: 'child that survives', compressedInto: keeper });

    // Recover for a delete of BOTH keeper and childInSet.
    const recovered = recoverChildrenOf(db, [keeper, childInSet]);
    expect(recovered).toBe(1); // only childKept, not childInSet
    expect(get(db, childKept, 'compressed_into')).toBeNull();
    expect(get(db, childInSet, 'compressed_into')).toBe(keeper); // untouched (it's being deleted)
  });
});

describe('decayAndMarkIdle (injection protection — the drift fix)', () => {
  test('protects injected rows; decays/marks only never-injected stale rows', () => {
    const db = freshDb();
    const A = add(db, { title: 'injected imp2', importance: 2, injectionCount: 8 }); // protected from decay
    const B = add(db, { title: 'stale imp3', importance: 3, injectionCount: 0 }); // decays 3->2
    const C = add(db, { title: 'injected imp1', importance: 1, injectionCount: 8 }); // protected from mark-idle
    const D = add(db, { title: 'idle imp1', importance: 1, injectionCount: 0 }); // marked pending-purge

    const { decayed, idleMarked } = decayAndMarkIdle(db, ctx(Date.now() - 30 * DAY));

    expect(decayed).toBe(1);
    expect(idleMarked).toBe(1);
    expect(get(db, A, 'importance')).toBe(2); // injection protected
    expect(get(db, B, 'importance')).toBe(2); // decayed 3->2
    expect(get(db, C, 'compressed_into')).toBeNull(); // injection protected
    expect(get(db, D, 'compressed_into')).toBe(COMPRESSED_PENDING_PURGE);
  });

  test('MED-1: marks only PRE-EXISTING imp-1 rows, NOT freshly-decayed imp-2 (per-tier grace)', () => {
    // Mark-idle runs BEFORE decay so a notable imp-2 row decays 2->1 this pass but is not
    // hidden as pending-purge until the NEXT pass. Pre-fix (decay-first) collapsed 2->1->pending
    // in one call, which — combined with purge running in the same maintain invocation — deleted
    // notable memories with zero grace (audit HIGH-1 root mechanism).
    const db = freshDb();
    const two = add(db, { title: 'stale imp2', importance: 2, injectionCount: 0 }); // decays 2->1 this pass
    const one = add(db, { title: 'stale imp1', importance: 1, injectionCount: 0 }); // marked pending this pass

    const { decayed, idleMarked } = decayAndMarkIdle(db, ctx(Date.now() - 30 * DAY));

    expect(decayed).toBe(1); // the imp-2 row stepped down
    expect(idleMarked).toBe(1); // ONLY the pre-existing imp-1, not the freshly-decayed one
    expect(get(db, two, 'importance')).toBe(1); // decayed 2->1
    expect(get(db, two, 'compressed_into')).toBeNull(); // NOT marked this pass (grace cycle)
    expect(get(db, one, 'compressed_into')).toBe(COMPRESSED_PENDING_PURGE);
  });

  test('v3.23: never marks a lesson-bearing imp-1 row idle — lessons are not auto-GC-able', () => {
    const db = freshDb();
    const noLesson = add(db, { title: 'idle no lesson', importance: 1, injectionCount: 0 });
    const withLesson = add(db, {
      title: 'idle but has lesson',
      importance: 1,
      injectionCount: 0,
      lessonLearned: 'strip the query string before parsing the branch name',
    });

    const { idleMarked } = decayAndMarkIdle(db, ctx(Date.now() - 30 * DAY));

    expect(idleMarked).toBe(1); // only the no-lesson row
    expect(get(db, noLesson, 'compressed_into')).toBe(COMPRESSED_PENDING_PURGE);
    expect(get(db, withLesson, 'compressed_into')).toBeNull(); // lesson protected from purge
  });
});

describe('maintenanceStats (scan preview must match what execute does)', () => {
  // Regression: the scan "Stale (>30d, imp=1, no access)" count omitted the
  // injection_count=0 guard that decayAndMarkIdle's mark-idle pass enforces
  // (v2.56.0 / #8614). So `maintain scan` over-counted stale by including
  // injected-but-decayed rows decay will NEVER mark idle — e.g. exactly the rows
  // `demote_pinned` just dropped to imp=1 (they keep inj>0). User sees "Stale: 2",
  // runs decay, gets "marked 0 idle" → the same scan↔execute drift #8614 fixed.
  test('stale count excludes injection-protected rows (parity with decay mark-idle)', () => {
    const db = freshDb();
    add(db, { title: 'idle never injected', importance: 1, injectionCount: 0 }); // decay marks idle → stale
    add(db, { title: 'idle but injected', importance: 1, injectionCount: 8 }); // decay PROTECTS → not stale

    const stats = maintenanceStats(db, ctx(Date.now() - 30 * DAY));
    expect(stats.stale).toBe(1); // only the never-injected row (was 2 pre-fix)

    // The parity claim itself: scan's stale count == rows decay actually marks idle.
    const { idleMarked } = decayAndMarkIdle(db, ctx(Date.now() - 30 * DAY));
    expect(idleMarked).toBe(stats.stale);
  });

  test('stale + broken counts exclude lesson-bearing rows (parity with the execute lesson guard)', () => {
    // Same #8614 drift class, missed for lesson_learned: decayAndMarkIdle (:188) and
    // cleanupBroken (:153) refuse to touch a lesson-bearing row ("lessons never auto-GC"),
    // but the scan stat counted them → "Stale: N"/"Broken: N" over-forecast what execute does.
    const db = freshDb();
    add(db, { title: 'stale plain', importance: 1, injectionCount: 0 }); // decay marks idle → stale
    add(db, { title: 'stale w/ lesson', importance: 1, injectionCount: 0, lessonLearned: 'keep me' }); // decay PROTECTS → not stale
    // importance:2 keeps these out of the stale bucket (imp=1) so they isolate the broken stat.
    add(db, { title: '', narrative: '', importance: 2 }); // cleanup deletes → broken
    add(db, { title: '', narrative: '', importance: 2, lessonLearned: 'synthesized lesson' }); // cleanup PROTECTS → not broken

    const stats = maintenanceStats(db, ctx(Date.now() - 30 * DAY));
    expect(stats.stale).toBe(1); // only the lesson-less stale row (was 2 pre-fix)
    expect(stats.broken).toBe(1); // only the lesson-less broken row (was 2 pre-fix)

    // Parity: scan forecast == what execute actually touches.
    expect(decayAndMarkIdle(db, ctx(Date.now() - 30 * DAY)).idleMarked).toBe(stats.stale);
    expect(cleanupBroken(db, ctx(0))).toBe(stats.broken);
  });
});

describe('execute ops', () => {
  test('cleanupBroken deletes only no-title/no-narrative rows', () => {
    const db = freshDb();
    const broken = add(db, { title: '', narrative: '' });
    const ok = add(db, { title: 'has title', narrative: '' });
    const deleted = cleanupBroken(db, ctx(0));
    expect(deleted).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM observations WHERE id = ?').get(broken).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM observations WHERE id = ?').get(ok).c).toBe(1);
  });

  test('boostAccessed raises importance of frequently-accessed rows', () => {
    const db = freshDb();
    const hot = add(db, { title: 'hot', importance: 1, accessCount: 5 });
    const cold = add(db, { title: 'cold', importance: 1, accessCount: 1 });
    expect(boostAccessed(db, ctx(0))).toBe(1);
    expect(get(db, hot, 'importance')).toBe(2);
    expect(get(db, cold, 'importance')).toBe(1);
  });

  // Lessonless fixture, so this covers the floor-1 arm only — the name says so since a
  // pre-tag review flagged the old one ('...to importance 1') as stating the whole rule.
  // The lesson-bearing arm that floors at 2 lives in tests/maintain-default-ops.test.mjs.
  test('demotePinned floors heavy-injection zero-citation LESSONLESS rows to importance 1', () => {
    const db = freshDb();
    const pinned = add(db, { title: 'pinned noise', importance: 3, injectionCount: 8, citedCount: 0 });
    const cited = add(db, { title: 'earns it', importance: 3, injectionCount: 8, citedCount: 2 });
    expect(demotePinned(db, ctx(0))).toBe(1);
    expect(get(db, pinned, 'importance')).toBe(1);
    expect(get(db, cited, 'importance')).toBe(3);
  });

  test('mergeDuplicates marks removeIds compressed into keepId', () => {
    const db = freshDb();
    const keep = add(db, { title: 'canonical' });
    const dup = add(db, { title: 'dup' });
    expect(mergeDuplicates(db, [[keep, dup]])).toBe(1);
    expect(get(db, dup, 'compressed_into')).toBe(keep);
    expect(get(db, keep, 'compressed_into')).toBeNull();
  });

  test('mergeDuplicates ignores self-merge (keepId===removeId) — must not orphan the row', () => {
    // A typo like `--merge-ids 5:5` previously set compressed_into=self, which hides
    // the row from every compressed_into=0 view (recent/search/browse) — silent data loss.
    const db = freshDb();
    const solo = add(db, { title: 'must survive self-merge' });
    expect(mergeDuplicates(db, [[solo, solo]])).toBe(0); // no-op, nothing merged
    expect(get(db, solo, 'compressed_into')).toBeNull(); // row stays live
    // Mixed group: self-ref skipped, real dup still merged.
    const keep = add(db, { title: 'keep' });
    const dup = add(db, { title: 'dup' });
    expect(mergeDuplicates(db, [[keep, keep, dup]])).toBe(1);
    expect(get(db, keep, 'compressed_into')).toBeNull();
    expect(get(db, dup, 'compressed_into')).toBe(keep);
  });

  // --- transitive-merge orphan prevention (data-loss bug class beyond direct self-merge) ---
  // The 1-line `removeId===keepId` guard only catches the DIRECT case. Chained, mutual,
  // and already-compressed-target merges still point a row at a HIDDEN keeper, which
  // vanishes from every compressed_into=0 view. The tool's own mem_maintain "dedup"
  // auto-suggests pairs that can form these chains, so this is reachable in normal use.
  // Invariant under test: no live row may end up compressed_into a non-live row.
  test('mergeDuplicates chain [[A,B],[B,C]] does not orphan C', () => {
    const db = freshDb();
    const A = add(db, { title: 'A keeper' });
    const B = add(db, { title: 'B dup of A' });
    const C = add(db, { title: 'C dup of B' });
    mergeDuplicates(db, [
      [A, B],
      [B, C],
    ]);
    // A survives live; B and C collapse DIRECTLY onto the single live keeper A.
    // Pre-fix C->B (the hidden middle): if B is later purgeStale-deleted, C's keeper
    // vanishes and C is unrecoverable. Direct C->A keeps C safe under later purges.
    expect(get(db, A, 'compressed_into')).toBeNull();
    expect(get(db, B, 'compressed_into')).toBe(A);
    expect(get(db, C, 'compressed_into')).toBe(A); // pre-fix: C->B (hidden middle)
  });

  test('mergeDuplicates mutual [[A,B],[B,A]] keeps exactly one live (no total loss)', () => {
    const db = freshDb();
    const A = add(db, { title: 'A' });
    const B = add(db, { title: 'B' });
    mergeDuplicates(db, [
      [A, B],
      [B, A],
    ]);
    const aLive = get(db, A, 'compressed_into') === null;
    const bLive = get(db, B, 'compressed_into') === null;
    expect(aLive !== bLive, 'exactly one of A/B must remain live').toBe(true); // pre-fix: BOTH hidden
    // the hidden one points at the live one
    if (aLive) expect(get(db, B, 'compressed_into')).toBe(A);
    else expect(get(db, A, 'compressed_into')).toBe(B);
  });

  test('mergeDuplicates does not merge into an already-compressed keeper (cross-call)', () => {
    const db = freshDb();
    const D = add(db, { title: 'D keeper' });
    const E = add(db, { title: 'E dup of D' });
    const F = add(db, { title: 'F dup of E' });
    mergeDuplicates(db, [[D, E]]); // E now hidden into D
    mergeDuplicates(db, [[E, F]]); // keeper E is hidden -> must NOT orphan F
    expect(get(db, F, 'compressed_into')).toBeNull(); // F stays live (pre-fix: F->E hidden)
  });

  test('purgeStale deletes pending-purge rows older than the cutoff; preview counts them', () => {
    const db = freshDb();
    const stale = add(db, { title: 'to purge', compressedInto: COMPRESSED_PENDING_PURGE });
    const cutoff = Date.now() - 30 * DAY;
    expect(purgeStalePreview(db, ctx(0), cutoff).candidates).toBe(1);
    expect(purgeStale(db, ctx(0), cutoff)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM observations WHERE id = ?').get(stale).c).toBe(0);
  });

  // --- hard-delete must not orphan a deleted keeper's children (compressed_into has no FK) ---
  const exists = (db, id) => db.prepare('SELECT COUNT(*) AS c FROM observations WHERE id = ?').get(id).c;

  test('purgeStale recovers children of a purged keeper instead of orphaning them', () => {
    const db = freshDb();
    // A keeper that absorbed a dup, later marked idle (compressed_into=PENDING_PURGE).
    const keeper = add(db, {
      title: 'idle keeper marked for purge',
      compressedInto: COMPRESSED_PENDING_PURGE,
    });
    const child = add(db, { title: 'dup merged into the keeper', compressedInto: keeper });
    expect(purgeStale(db, ctx(0), Date.now() - 30 * DAY)).toBe(1); // keeper deleted
    expect(exists(db, keeper)).toBe(0);
    expect(exists(db, child)).toBe(1); // child survives (pre-fix: orphaned)
    expect(get(db, child, 'compressed_into')).toBeNull(); // recovered: un-hidden, reachable again
  });

  test('cleanupBroken recovers children of a deleted empty keeper', () => {
    const db = freshDb();
    const emptyKeeper = add(db, { title: '', narrative: '' }); // empty-content but a cluster keeper
    const child = add(db, { title: 'dup merged into empty keeper', compressedInto: emptyKeeper });
    expect(cleanupBroken(db, ctx(0))).toBe(1); // empty keeper deleted
    expect(exists(db, emptyKeeper)).toBe(0);
    expect(exists(db, child)).toBe(1); // child survives (pre-fix: orphaned)
    expect(get(db, child, 'compressed_into')).toBeNull();
  });
});

// Audit 2026-06-22 P2 #8: the hook fuzzy-dedup pass compared TITLES only (a word-set
// metric), so distinct observations sharing a title token-set were auto-hidden. The
// pass now also requires body similarity. selectFuzzyDedupeIds is the extracted pure
// core so this is unit-testable without driving the whole SessionStart hook.
describe('selectFuzzyDedupeIds — title + body fuzzy dedup (audit #8)', () => {
  const row = (id, title, body, importance = 1) => ({ id, title, body, importance });

  // Both titles carry the IDENTICAL token set, just reordered → title Jaccard = 1.0
  // (clears the 0.95 floor). So the BODY comparison is the only thing that decides,
  // which is exactly what audit #8 added. (Using titles that differ by a token would
  // pass-for-the-wrong-reason: blocked on title, not body.)
  const TITLE_A = 'Fix auth bug login handler';
  const TITLE_B = 'Fix login handler auth bug';

  test('dedupes a genuine re-save: same title token-set AND near-identical body', () => {
    const rows = [
      row(1, TITLE_A, 'auth token was not refreshed on expiry so calls returned 401'),
      row(2, TITLE_B, 'auth token was not refreshed on expiry so calls returned 401 again'),
    ];
    expect(selectFuzzyDedupeIds(rows)).toEqual([2]);
  });

  test('does NOT dedupe same-title-token-set rows with DIFFERENT bodies (the fix)', () => {
    const rows = [
      row(1, TITLE_A, 'root cause was a missing await on the refresh call'),
      row(2, TITLE_B, 'root cause was an off-by-one in the retry backoff loop'),
    ];
    expect(selectFuzzyDedupeIds(rows)).toEqual([]);
  });

  test('dedupes when both bodies are empty (no body to differ)', () => {
    const rows = [row(1, 'Modified config json file', ''), row(2, 'Modified config json file', '')];
    expect(selectFuzzyDedupeIds(rows)).toEqual([2]);
  });

  test('does NOT dedupe when one row has a body and the other does not', () => {
    const rows = [
      row(1, 'Modified config json file', 'added the retry flag and bumped the timeout to thirty'),
      row(2, 'Modified config json file', ''),
    ];
    expect(selectFuzzyDedupeIds(rows)).toEqual([]);
  });

  test('keeps the higher-importance row and removes the lower-importance peer', () => {
    const rows = [
      row(1, 'Fix the auth bug in login', 'identical body text shared by both candidate rows', 1),
      row(2, 'Fix the auth bug in login', 'identical body text shared by both candidate rows', 3),
    ];
    expect(selectFuzzyDedupeIds(rows)).toEqual([1]);
  });
});
