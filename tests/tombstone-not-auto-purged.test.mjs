// A superseded row may keep decaying, but must never be auto-marked for PURGE.
//
// P3-13 asked a semantic question the 2026-09-02 audit deliberately left open: should
// tombstones (superseded_at set, compressed_into still 0) go through automatic GC? The
// answer is per-op, and only two ops have a consequence. Measured on the live DB
// 2026-09-04 (3779 observations, 31 superseded, 19 of them live tombstones):
//
//   boostAccessed / demotePinned / decayAndMarkIdle's DECAY arm — write `importance`
//     only, and importance is inert on a row every read path already filters out via
//     liveObsFilterSql. Including or excluding tombstones there is a behavioural no-op,
//     so they are deliberately NOT changed (and their forecasts stay untouched with them).
//   cleanupBroken — hard-deletes content-free rows; a content-free tombstone carries
//     nothing but its redirect, and "broken" is true of it either way. Left alone.
//   decayAndMarkIdle's MARK-IDLE arm + search-scoring.runIdleCleanup's mark pass —
//     write COMPRESSED_PENDING_PURGE, which purgeStale then HARD-DELETES. That is the
//     one path with teeth, because deleting the row destroys `superseded_by`.
//
// 27 of those 31 superseded rows carry a usable `superseded_by`, and three functions in
// the Stop citation loop (applyCitationDecay / recordCitationSurfaces / bumpCitationAccess)
// route old ids through `redirectSupersededIds` to reach the successor. Purging the
// tombstone silently ends that: a `#NN` naming a corrected memory stops resolving.
//
// The precedent is in the same SQL statement. Lesson-bearing rows were exempted from
// mark-idle on exactly this reasoning — background machinery must not dispose of value it
// cannot regenerate, while an explicit `delete` still can. A tombstone's redirect is the
// same shape of value, and explicit `delete` still removes it.
//
// Exposure today is zero on all five ops, and that zero is NOT vacuous: all 19 live
// tombstones pass the `compressed_into = 0` conjunct, and it is the LATER conjuncts that
// exclude them — narrowly. One tombstone already sits at injection_count = 12 (past
// demotePinned's threshold of 8, held out only by cited_count), and 12 are above
// boostAccessed's access threshold, held out only by importance = 3. These are near
// misses, not impossibilities, which is why the guard goes in before the first hit.

import { describe, it, expect } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { COMPRESSED_PENDING_PURGE } from '../utils.mjs';
import { decayAndMarkIdle, maintenanceStats, purgeStale } from '../lib/maintain-core.mjs';
import { runIdleCleanup } from '../search-scoring.mjs';
import { redirectSupersededIds } from '../lib/citation-tracker.mjs';

const DAY = 86400000;
const OLD = -40 * DAY;
const PROJECT = 'proj-a';
const ctx = (staleAge) => ({ projectFilter: '', baseParams: [], staleAge, opCap: 1000 });
const get = (db, id, col) => db.prepare(`SELECT ${col} AS v FROM observations WHERE id = ?`).get(id).v;
const add = (db, o) => Number(insertObs(db,
  { sessionId: 'sess-1', project: PROJECT, epochOffset: OLD, ...o }).lastInsertRowid);

function freshDb() {
  const db = createTestDb();
  insertSession(db, { id: 'sess-1', project: PROJECT });
  return db;
}

/** Retire `id` exactly as the supersession path does: epoch-ms integer + successor. */
function retire(db, id, successor) {
  db.prepare('UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id = ?')
    .run(Date.now(), successor, id);
}

describe('decayAndMarkIdle: a tombstone is not auto-marked for purge', () => {
  it('marks the live row and leaves its identical retired twin alone', () => {
    const db = freshDb();
    const successor = add(db, { title: 'the correction that replaced it', importance: 2 });
    // Two rows in the SAME shape — every mark-idle conjunct satisfied. The only
    // difference is superseded_at, so whichever way this case goes is attributable
    // to that column and to nothing else.
    const live = add(db, { title: 'idle imp1 live', importance: 1, injectionCount: 0 });
    const tomb = add(db, { title: 'idle imp1 retired', importance: 1, injectionCount: 0 });
    retire(db, tomb, successor);

    const { idleMarked } = decayAndMarkIdle(db, ctx(Date.now() - 30 * DAY));

    // The live twin proves the fixture qualifies; without it, "the tombstone was not
    // marked" could equally mean the fixture never satisfied the predicate at all.
    expect(get(db, live, 'compressed_into'), 'fixture does not reach mark-idle at all')
      .toBe(COMPRESSED_PENDING_PURGE);
    expect(get(db, tomb, 'compressed_into'), 'a retired row was queued for hard delete').toBeNull();
    expect(idleMarked).toBe(1);
    db.close();
  });

  it('the scan forecast moves with it — stale still equals what execute marks', () => {
    // The invariant maintenanceStats' own docblock pins: a one-sided change here breaks
    // "forecast must equal execute" just as surely as leaving both wrong would.
    const db = freshDb();
    const successor = add(db, { title: 'successor', importance: 2 });
    add(db, { title: 'idle imp1 live', importance: 1, injectionCount: 0 });
    const tomb = add(db, { title: 'idle imp1 retired', importance: 1, injectionCount: 0 });
    retire(db, tomb, successor);

    const stats = maintenanceStats(db, ctx(Date.now() - 30 * DAY));
    expect(stats.stale, 'scan still forecasts the tombstone as stale').toBe(1);
    expect(decayAndMarkIdle(db, ctx(Date.now() - 30 * DAY)).idleMarked).toBe(stats.stale);
    db.close();
  });

  it('the DECAY arm is deliberately unchanged — a tombstone still steps down', () => {
    // Not an oversight. importance is inert on a row liveObsFilterSql already hides, so
    // exempting the decay arm would be churn with no behavioural difference — and would
    // then require its own forecast change for nothing. Pinned so the next sweep that
    // "finishes the job" has to argue with a test instead of with a comment.
    const db = freshDb();
    const successor = add(db, { title: 'successor', importance: 2 });
    const tomb = add(db, { title: 'retired imp3', importance: 3, injectionCount: 0 });
    retire(db, tomb, successor);

    decayAndMarkIdle(db, ctx(Date.now() - 30 * DAY));
    expect(get(db, tomb, 'importance'), 'decay arm changed behaviour on tombstones').toBe(2);
    db.close();
  });
});

describe('runIdleCleanup (MCP idle timer): the same exemption on the sibling writer', () => {
  it('marks the live row and leaves its identical retired twin alone', () => {
    // The guard-on-one-path shape this repo keeps paying for: this function is
    // decayAndMarkIdle's hand-written MCP twin and has been fixed one clause behind it
    // twice already (the lesson guard, then injection_count in audit P0-4).
    const db = freshDb();
    const successor = add(db, { title: 'successor', importance: 2, type: 'change' });
    const live = add(db, { title: 'stale change live', importance: 1, type: 'change', injectionCount: 0 });
    const tomb = add(db, { title: 'stale change retired', importance: 1, type: 'change', injectionCount: 0 });
    retire(db, tomb, successor);

    runIdleCleanup(db);

    expect(get(db, live, 'compressed_into'), 'fixture does not reach the mark pass at all')
      .toBe(COMPRESSED_PENDING_PURGE);
    // NOT `toBeNull()`. The invariant is "never queued for HARD DELETE", and this function
    // has a second pass that writes COMPRESSED_AUTO (-1) — which still claims the tombstone
    // and is deliberately left doing so. -1 is not deletable: purgeStale's WHERE names
    // COMPRESSED_PENDING_PURGE only, cleanupBroken requires compressed_into = 0, and
    // redirectSupersededIds reads no compressed_into at all. So the row stays hidden (it
    // already was, being retired) and its redirect survives. A first draft of this case
    // asserted null, which would have forced the exemption onto a pass that causes no harm.
    expect(get(db, tomb, 'compressed_into'), 'a retired row was queued for hard delete')
      .not.toBe(COMPRESSED_PENDING_PURGE);
    db.close();
  });
});

describe('why the exemption exists: purge is what destroys the redirect', () => {
  it('a retired row redirects to its successor, and stops once it is deleted', () => {
    const db = freshDb();
    const successor = add(db, { title: 'the correction', importance: 2 });
    const tomb = add(db, { title: 'the retired original', importance: 1, injectionCount: 0 });
    retire(db, tomb, successor);

    expect(redirectSupersededIds(db, PROJECT, [tomb]), 'redirect not working in the fixture')
      .toEqual(new Set([successor]));

    // MARKING is not the harm — redirectSupersededIds has no compressed_into filter, so a
    // pending-purge tombstone still redirects. DELETION is. This is what separates the two
    // PENDING_PURGE writers from the ops that only move importance.
    db.prepare('UPDATE observations SET compressed_into = ? WHERE id = ?')
      .run(COMPRESSED_PENDING_PURGE, tomb);
    expect(redirectSupersededIds(db, PROJECT, [tomb]),
      'marking alone already broke the redirect — the premise of the fix is wrong')
      .toEqual(new Set([successor]));

    expect(purgeStale(db, ctx(), Date.now())).toBe(1);
    expect(redirectSupersededIds(db, PROJECT, [tomb]),
      'the successor is somehow still reachable after the row was deleted')
      .toEqual(new Set([tomb]));
    db.close();
  });
});
