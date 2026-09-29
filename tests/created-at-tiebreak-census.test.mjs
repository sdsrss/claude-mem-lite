// N3 (session-history analysis r2 §4.3): the census of every `ORDER BY … created_at_epoch`
// in the shipped population found 27 clauses with no id tiebreaker whose table HAS an id.
// All now end on `id` in the clause's own direction; `tests/order-by-created-at-guard.test.mjs`
// pins the whole population structurally. These cases pin the DESC listings behaviourally,
// on the faces where a tie is plausible: observations and events are written in batches
// (an episode flush, a backfill), which is the tight-insert-loop shape D#9 measured at
// 272/300 same-millisecond. Not the live rate — a read-only probe on 2026-09-26 found 0 tie
// groups on this machine's DB; the cases build the tie.
//
// The damage is in the DIRECTION: on a tie SQLite returns ascending rowid, so a statement
// that says "newest first" hands back the OLDEST rows, and under a LIMIT the newest rows are
// the ones cut. Every fixture forces one epoch and asserts that premise before the order.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchRecent } from '../lib/recent-core.mjs';
import { fetchRecentTimeline, fetchTimelineWindow, resolveAnchorToken } from '../lib/timeline-core.mjs';
import { recentInjectableEvents } from '../lib/events-injection.mjs';
import { recentEvents, saveEvent } from '../lib/activity.mjs';
import { createTestDb, insertSession, insertObs, insertPrompt } from './test-helpers.mjs';

const TIED_EPOCH = 1_700_000_000_000;

describe('N3 — created_at_epoch DESC listings return the newest id first under a tie', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 's', project: 'p', memoryId: 's' });
  });
  afterEach(() => db.close());

  const seedTiedObs = (n, epoch = TIED_EPOCH) => {
    const ids = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        Number(
          insertObs(db, {
            sessionId: 's',
            project: 'p',
            type: 'bugfix',
            title: `tied observation ${i}`,
            narrative: 'a substantive body so no low-signal filter drops it',
            importance: 2,
          }).lastInsertRowid,
        ),
      );
    }
    db.prepare(`UPDATE observations SET created_at_epoch = ? WHERE id IN (${ids.join(',')})`).run(epoch);
    const distinct = db
      .prepare(
        `SELECT COUNT(DISTINCT created_at_epoch) AS c FROM observations WHERE id IN (${ids.join(',')})`,
      )
      .get().c;
    expect(distinct).toBe(1); // premise: the rows really are tied
    return ids;
  };

  const seedTiedEvents = (n) => {
    const ids = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        saveEvent(db, {
          project: 'p',
          event_type: 'lesson',
          title: `tied event ${i}`,
          body: 'a lesson body',
          importance: 3,
          created_at_epoch: TIED_EPOCH,
        }),
      );
    }
    expect(db.prepare('SELECT COUNT(DISTINCT created_at_epoch) AS c FROM events').get().c).toBe(1);
    return ids;
  };

  it('fetchRecent (mem_recent / `recent`) keeps the newest rows under the LIMIT', () => {
    const ids = seedTiedObs(5);
    const rows = fetchRecent(db, { project: 'p', limit: 3 });
    expect(rows.map((r) => r.id)).toEqual(ids.slice(-3).reverse());
  });

  it('fetchRecentTimeline (timeline with no anchor) leads with the newest row', () => {
    const ids = seedTiedObs(5);
    const rows = fetchRecentTimeline(db, { project: 'p', limit: 3 });
    expect(rows.map((r) => r.id)).toEqual(ids.slice(-3).reverse());
  });

  it("fetchTimelineWindow's before-leg takes the rows nearest the anchor, not the oldest", () => {
    const tied = seedTiedObs(5);
    const [anchorId] = seedTiedObs(1, TIED_EPOCH + 60_000);
    const { beforeRows, afterRows } = fetchTimelineWindow(db, anchorId, {
      before: 3,
      after: 3,
      project: 'p',
    });
    // Rendered chronologically (the leg is reversed after the query), so the three rows
    // nearest the anchor are the three highest ids, oldest of them first.
    expect(beforeRows.map((r) => r.id)).toEqual(tied.slice(-3));
    expect(afterRows).toEqual([]);
  });

  // The legs used to compare the epoch strictly (`< ?` / `> ?`), so a row sharing the
  // ANCHOR's epoch satisfied neither and vanished from the window. Both legs now compare
  // (created_at_epoch, id), the same total order they sort by.
  it.each([
    ['first', 0],
    ['middle', 2],
    ['last', 4],
  ])('fetchTimelineWindow shows every row tied with the anchor exactly once (anchor %s)', (_, at) => {
    const [older] = seedTiedObs(1, TIED_EPOCH - 60_000);
    const tied = seedTiedObs(5);
    const [newer] = seedTiedObs(1, TIED_EPOCH + 60_000);
    const anchorId = tied[at];
    const { anchor, beforeRows, afterRows } = fetchTimelineWindow(db, anchorId, {
      before: 10,
      after: 10,
      project: 'p',
    });
    expect(anchor.id).toBe(anchorId);
    expect(beforeRows.map((r) => r.id)).toEqual([older, ...tied.slice(0, at)]);
    expect(afterRows.map((r) => r.id)).toEqual([...tied.slice(at + 1), newer]);
  });

  it('fetchTimelineWindow legs stop at their LIMIT from the anchor outward inside a tie', () => {
    const tied = seedTiedObs(7);
    const { beforeRows, afterRows } = fetchTimelineWindow(db, tied[3], { before: 2, after: 2, project: 'p' });
    expect(beforeRows.map((r) => r.id)).toEqual([tied[1], tied[2]]);
    expect(afterRows.map((r) => r.id)).toEqual([tied[4], tied[5]]);
  });

  it('a P#N anchor resolves to the newest of the observations tied nearest it', () => {
    const ids = seedTiedObs(3);
    const promptId = Number(
      insertPrompt(db, { contentSessionId: 's', text: 'anchor prompt' }).lastInsertRowid,
    );
    db.prepare('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?').run(TIED_EPOCH, promptId);
    const res = resolveAnchorToken(db, `P#${promptId}`, { project: 'p' });
    expect(res.ok).toBe(true);
    expect(res.anchorId).toBe(ids[ids.length - 1]);
  });

  it('recentInjectableEvents (SessionStart events) keeps the newest events under the LIMIT', () => {
    const ids = seedTiedEvents(5);
    const rows = recentInjectableEvents(db, { project: 'p', limit: 3 });
    expect(rows.map((r) => r.id)).toEqual(ids.slice(-3).reverse());
  });

  it('recentEvents (`activity recent`) keeps the newest events under the LIMIT', () => {
    const ids = seedTiedEvents(5);
    const rows = recentEvents(db, { project: 'p', limit: 3 });
    expect(rows.map((r) => r.id)).toEqual(ids.slice(-3).reverse());
  });
});
