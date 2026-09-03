// Class-level guard for the "tombstone reached a WRITE path" invariant — audit
// 2026-09-02 P0-2 / P0-3 / P0-4 / P0-6.
//
// A superseded row keeps `compressed_into = 0`, so every predicate written as
// `COALESCE(compressed_into,0) = 0` alone ADMITS tombstones. Every read face filters
// `superseded_at IS NULL` (via liveObsFilterSql); the write faces had drifted apart, which
// is the same invariant this repo has re-broken ~10 times, each time on a NEW surface. So
// the cases below are grouped by SURFACE rather than by file: each one seeds a live row plus
// a tombstone and asserts the tombstone cannot be selected, nominated keeper, or written to.
//
// Every case here was verified to FAIL against the pre-fix predicate (see the audit report's
// per-item verification note) — a guard test that passes on the broken code is worse than no
// test, and this file's whole subject matter is guards that were assumed to exist.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { COMPRESSED_PENDING_PURGE, COMPRESSED_AUTO } from '../utils.mjs';

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));
vi.mock('../haiku-client.mjs', () => ({
  callModelJSONAsync: vi.fn(),
  BG_LLM_TIMEOUT_MS: 45000,
}));
import { callModelJSONAsync } from '../haiku-client.mjs';

const DAY = 86400000;
const TOMB = '2026-09-01T00:00:00.000Z';
const ctx = (staleAge) => ({ projectFilter: '', baseParams: [], staleAge, opCap: 1000 });
const col = (db, id, c) => db.prepare(`SELECT ${c} AS v FROM observations WHERE id = ?`).get(id).v;

function freshDb(project = 'proj-a') {
  const db = createTestDb();
  insertSession(db, { id: 'sess-1', project });
  return db;
}
const add = (db, o) => Number(insertObs(db, {
  sessionId: 'sess-1', project: 'proj-a', epochOffset: -40 * DAY, ...o,
}).lastInsertRowid);

// ─── P0-2 · maintain scan / mergeDuplicates ─────────────────────────────────

describe('P0-2 maintain dedup: a tombstone is neither a candidate nor a keeper', () => {
  it('findDuplicates does not pair a live row with a superseded near-duplicate', async () => {
    const { findDuplicates } = await import('../lib/maintain-core.mjs');
    const db = freshDb();
    const title = 'FTS5 rowid MATCH silently drops the rowid constraint';
    add(db, { title });
    add(db, { title: `${title} entirely`, supersededAt: TOMB });

    // Premise: the SAME pair IS reported once the tombstone is live — without this the
    // assertion below would also pass on a corpus where MinHash never matched at all.
    expect(findDuplicates(db, ctx())).toEqual([]);
    db.prepare('UPDATE observations SET superseded_at = NULL WHERE superseded_at IS NOT NULL').run();
    expect(findDuplicates(db, ctx()).length).toBe(1);
    db.close();
  });

  it('mergeDuplicates refuses a superseded keeper instead of burying the live row behind it', async () => {
    const { mergeDuplicates } = await import('../lib/maintain-core.mjs');
    const db = freshDb();
    const tombKeeper = add(db, { title: 'retracted conclusion', importance: 3, supersededAt: TOMB });
    const live = add(db, { title: 'retracted conclusion', importance: 1 });

    expect(mergeDuplicates(db, [[tombKeeper, live]])).toBe(0);
    expect(col(db, live, 'compressed_into')).toBeNull(); // still visible on every read face
    db.close();
  });

  it('mergeDuplicates will not point a live row at a live keeper that is itself a tombstone target', async () => {
    const { mergeDuplicates } = await import('../lib/maintain-core.mjs');
    const db = freshDb();
    const keeper = add(db, { title: 'keeper' });
    const child = add(db, { title: 'child' });
    // keeper is live at this point: the merge lands.
    expect(mergeDuplicates(db, [[keeper, child]])).toBe(1);
    // Now retract the keeper and try to attach a second child to it.
    db.prepare('UPDATE observations SET superseded_at = ? WHERE id = ?').run(TOMB, keeper);
    const child2 = add(db, { title: 'child2' });
    expect(mergeDuplicates(db, [[keeper, child2]])).toBe(0);
    expect(col(db, child2, 'compressed_into')).toBeNull();
    db.close();
  });
});

// ─── P0-3 · LLM optimize / compress candidate + write paths ─────────────────

describe('P0-3 compress candidates: tombstoned text is never re-summarized into a live row', () => {
  it('selectCompressionCandidates skips a superseded row that otherwise matches every clause', async () => {
    const { selectCompressionCandidates } = await import('../lib/compress-core.mjs');
    const db = freshDb();
    add(db, { title: 'live low-value', importance: 1, accessCount: 0 });
    const tomb = add(db, { title: 'retracted low-value', importance: 1, accessCount: 0, supersededAt: TOMB });

    const got = selectCompressionCandidates(db, { cutoff: Date.now() });
    expect(got.map(r => r.id)).not.toContain(tomb);
    expect(got.length).toBe(1); // premise: the live sibling IS a candidate
    db.close();
  });

  it('selectCompressionCandidates still admits COMPRESSED_AUTO rows (the guard is superseded-only)', async () => {
    const { selectCompressionCandidates } = await import('../lib/compress-core.mjs');
    const db = freshDb();
    const auto = add(db, { title: 'auto-marked', importance: 1, compressedInto: COMPRESSED_AUTO });
    const got = selectCompressionCandidates(db, { cutoff: Date.now(), includeAutoMarked: true });
    expect(got.map(r => r.id)).toContain(auto);
    db.close();
  });

  it('compressGroup does not re-point a row superseded after selection, and reports the real count', async () => {
    const { compressGroup } = await import('../lib/compress-core.mjs');
    const db = freshDb();
    const a = add(db, { title: 'a' }), b = add(db, { title: 'b' }), c = add(db, { title: 'c' });
    const obs = db.prepare('SELECT id, project, type, title, created_at, created_at_epoch FROM observations').all();
    // Simulate the window between selection and write.
    db.prepare('UPDATE observations SET superseded_at = ? WHERE id = ?').run(TOMB, c);

    const { summaryId, compressed } = compressGroup(db, 'proj-a', obs);
    expect(compressed).toBe(2);                              // NOT obs.length
    expect(col(db, a, 'compressed_into')).toBe(summaryId);
    expect(col(db, b, 'compressed_into')).toBe(summaryId);
    expect(col(db, c, 'compressed_into')).toBeNull();        // tombstone left alone
    db.close();
  });

  it('findSmartCompressCandidates skips a superseded row (auto-dedup losers match its predicate exactly)', async () => {
    const { findSmartCompressCandidates } = await import('../hook-optimize.mjs');
    const db = freshDb();
    add(db, { title: 'live', importance: 1, accessCount: 0 });
    const tomb = add(db, { title: 'dedup loser', importance: 1, accessCount: 0, supersededAt: TOMB });

    const got = findSmartCompressCandidates(db, 1);
    expect(got.map(r => r.id)).not.toContain(tomb);
    expect(got.length).toBe(1);
    db.close();
  });
});

describe('P0-3 cluster-merge: keeper liveness is re-checked after the Sonnet round-trip', () => {
  beforeEach(() => { callModelJSONAsync.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('aborts the merge when the keeper was superseded while the LLM call was in flight', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    const db = freshDb();
    const keeper = add(db, { title: 'cluster keeper', importance: 3, epochOffset: -1 * DAY });
    const member = add(db, { title: 'cluster member', importance: 1, epochOffset: -1 * DAY });
    const cluster = db.prepare('SELECT * FROM observations WHERE id IN (?,?)').all(keeper, member);

    // The concurrency this guard exists for: auto-dedup / `save --supersedes` lands during
    // the round-trip. Doing it INSIDE the mock is what makes this a race test rather than a
    // restatement of the candidate filter.
    callModelJSONAsync.mockImplementation(async () => {
      db.prepare('UPDATE observations SET superseded_at = ? WHERE id = ?').run(TOMB, keeper);
      return {
        should_merge: true, merged_title: 'merged', merged_narrative: 'n',
        merged_concepts: ['x'], merged_facts: ['y'], merged_lesson: 'z', importance: 2,
      };
    });

    const res = await executeMergeCluster(db, cluster);
    expect(res.merged).toBe(false);
    expect(col(db, member, 'compressed_into')).toBeNull();   // not buried behind a tombstone
    expect(col(db, keeper, 'title')).toBe('cluster keeper'); // keeper text not overwritten
    db.close();
  });

  it('merges normally when the keeper stays live (the guard is not a blanket refusal)', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    const db = freshDb();
    const keeper = add(db, { title: 'cluster keeper', importance: 3, epochOffset: -1 * DAY });
    const member = add(db, { title: 'cluster member', importance: 1, epochOffset: -1 * DAY });
    const cluster = db.prepare('SELECT * FROM observations WHERE id IN (?,?)').all(keeper, member);

    callModelJSONAsync.mockResolvedValue({
      should_merge: true, merged_title: 'merged', merged_narrative: 'n',
      merged_concepts: ['x'], merged_facts: ['y'], merged_lesson: 'z', importance: 2,
    });

    const res = await executeMergeCluster(db, cluster);
    expect(res.merged).toBe(true);
    expect(col(db, member, 'compressed_into')).toBe(keeper);
    db.close();
  });
});

// ─── P0-4 · MCP idle cleanup ────────────────────────────────────────────────

describe('P0-4 runIdleCleanup carries decayAndMarkIdle\'s injection_count guard', () => {
  it('leaves an injected-but-never-accessed row alone on BOTH of its UPDATEs', async () => {
    const { runIdleCleanup } = await import('../search-scoring.mjs');
    const db = freshDb();
    // imp<=1 + access 0 + old + no lesson: matches mark-idle AND auto-compress. The only
    // thing standing between it and disappearance is injection_count.
    const injected = add(db, { title: 'injected, never clicked', type: 'change', importance: 1, epochOffset: -200 * DAY, injectionCount: 7 });
    const bare = add(db, { title: 'never injected', type: 'change', importance: 1, epochOffset: -200 * DAY, injectionCount: 0 });

    runIdleCleanup(db);

    expect(col(db, injected, 'compressed_into')).toBeNull();
    // Premise: the sibling that differs ONLY in injection_count IS acted on, so the
    // assertion above is not passing because the op failed to fire at all.
    expect([COMPRESSED_PENDING_PURGE, COMPRESSED_AUTO]).toContain(col(db, bare, 'compressed_into'));
    db.close();
  });
});

// ─── P0-6 · hook-llm pre-saved retraction ───────────────────────────────────

describe('P0-6 pre-saved retraction: live guard + child recovery on all three sites', () => {
  it('leaves a superseded pre-saved row in place rather than hard-deleting it', async () => {
    const { retractPreSavedObs } = await import('../hook-llm.mjs');
    const db = freshDb();
    const row = add(db, { title: 'pre-saved', supersededAt: TOMB });
    expect(retractPreSavedObs(db, row, 'test')).toBe(false);
    expect(col(db, row, 'title')).toBe('pre-saved');
    db.close();
  });

  it('recovers children BEFORE deleting a live pre-saved row', async () => {
    const { retractPreSavedObs } = await import('../hook-llm.mjs');
    const db = freshDb();
    const row = add(db, { title: 'pre-saved keeper' });
    const child = add(db, { title: 'absorbed dup', compressedInto: row });

    expect(retractPreSavedObs(db, row, 'test')).toBe(true);
    expect(db.prepare('SELECT 1 FROM observations WHERE id = ?').get(row)).toBeUndefined();
    expect(col(db, child, 'compressed_into')).toBeNull(); // resurfaced, not dangling
    db.close();
  });

  it('leaves the children of a NOT-live row hidden — recovery is gated, not unconditional', async () => {
    const { retractPreSavedObs } = await import('../hook-llm.mjs');
    // The cell between the two cases above, and the one that was defective. The first cut
    // ran recoverChildrenOf unconditionally and put the live guard only on the DELETE, so
    // on this path the delete was a no-op while the children had ALREADY been un-hidden:
    // a dedup that legitimately folded #child into #row was silently undone, #row survived,
    // and the debug line still said "left in place" — true of #row, false of #child.
    // "not live -> not deleted" and "live -> children recovered" both passed throughout.
    const db = freshDb();
    const row = add(db, { title: 'pre-saved, since tombstoned', supersededAt: TOMB });
    const child = add(db, { title: 'absorbed dup', compressedInto: row });

    expect(retractPreSavedObs(db, row, 'test')).toBe(false);
    expect(col(db, row, 'title')).toBe('pre-saved, since tombstoned'); // premise: still there
    expect(col(db, child, 'compressed_into')).toBe(row);               // and still hidden
    db.close();
  });
});

// ─── mergeDuplicates: the removeId arm ──────────────────────────────────────

describe('mergeDuplicates does not write compressed_into onto a tombstone', () => {
  it('refuses a removeId that is itself superseded, and does not inflate the count', async () => {
    const { mergeDuplicates } = await import('../lib/maintain-core.mjs');
    // The file pins the KEEPER arm twice and left the CHILD arm untested: dropping
    // `AND liveObsFilterSql('')` from mergeStmt left all twelve cases green, because every
    // case seeded a superseded KEEPER and none ever seeded a superseded removeId.
    // The mutant writes compressed_into onto an already-superseded row — double-hiding it
    // past recoverOrphanedChildren's reach, the exact loss mergeDuplicates' own docblock
    // describes — and reports `merged: 1` to the user for a row it did not merge.
    const db = freshDb();
    const keeper = add(db, { title: 'live keeper' });
    const tomb = add(db, { title: 'already retracted', supersededAt: TOMB });

    expect(mergeDuplicates(db, [[keeper, tomb]])).toBe(0);
    expect(col(db, tomb, 'compressed_into')).toBeNull();

    // Premise: the same call DOES merge once the removeId is live, so the zero above is the
    // guard firing and not mergeDuplicates declining the pair for some unrelated reason.
    const live = add(db, { title: 'live duplicate' });
    expect(mergeDuplicates(db, [[keeper, live]])).toBe(1);
    expect(col(db, live, 'compressed_into')).toBe(keeper);
    db.close();
  });
});
