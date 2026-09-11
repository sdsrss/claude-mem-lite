// The junction backfill could only ever run on a database that had never stored a single
// file edge (R12 pre-ship review P3-3).
//
// `initSchema` carried a one-shot data migration gated on `COUNT(*) FROM observation_files
// === 0`. That reads as "run once", and it is — but the condition is not "has this backfill
// run", it is "has this database ever written an edge". Any store holding one real
// `mem_save` fails it forever, so observations imported before v6.7.2 — the release that
// taught `import-jsonl` to write edges at all — stayed permanently unreachable by file. A
// re-import does not repair them either: cross-run dedup skips the row before the edge write.
//
// The fix moves it to DEFERRED_CLEANUPS, whose marker answers the question actually being
// asked (`migration_cleanups.name`), retries on a later open if it throws, and needs no
// CURRENT_SCHEMA_VERSION bump — a bump would lock every older code home out of the database
// permanently, which is far too much to pay for a derived table.

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { runDeferredCleanups } from '../schema.mjs';
import { recallByFile } from '../lib/recall-core.mjs';

const BACKFILL = 'backfill-observation-files';
// initSchema re-enables foreign_keys, so observations need a real session to hang off.
const MEM_SESSION = 'mem-backfill-1';

let db;
let nextId = 0;

/** An observation row carrying `files_modified`, with no junction edge written for it. */
function insertObs(files, { project = 'proj' } = {}) {
  const id = ++nextId;
  const ts = new Date(1_760_000_000_000 + id * 1000).toISOString();
  db.prepare(
    `INSERT INTO observations (id, memory_session_id, project, text, type, title, files_modified, importance, created_at, created_at_epoch)
     VALUES (?, ?, ?, ?, 'change', ?, ?, 1, ?, ?)`,
  ).run(id, MEM_SESSION, project, 'body', `Edit: obs ${id}`, files, ts, Date.parse(ts));
  return id;
}

const edgesFor = (id) =>
  db
    .prepare('SELECT filename FROM observation_files WHERE obs_id = ? ORDER BY filename')
    .all(id)
    .map((r) => r.filename);

const junctionCount = () => db.prepare('SELECT COUNT(*) AS n FROM observation_files').get().n;

const markerSet = () =>
  db.prepare('SELECT COUNT(*) AS n FROM migration_cleanups WHERE name = ?').get(BACKFILL).n > 0;

describe('observation_files backfill runs on a database that already has edges', () => {
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-backfill-1', project: 'proj', memoryId: MEM_SESSION });
    nextId = 0;
  });

  it('premise: a fresh test DB has not run the deferred cleanups yet', () => {
    // initSchema does not call runDeferredCleanups — only ensureDb does (schema.mjs:1244).
    // If that ever changes, every case below would be measuring a pass that already ran.
    expect(markerSet(), 'the backfill marker was already set before the test acted').toBe(false);
  });

  it('backfills a row whose edge is missing even when the junction is NOT empty', () => {
    // The discriminating shape, and the one the old gate could not see: one observation with
    // an edge (so `COUNT(*) FROM observation_files !== 0`) and one without.
    const withEdge = insertObs(JSON.stringify(['/repo/saved.mjs']));
    db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(
      withEdge,
      '/repo/saved.mjs',
    );
    const imported = insertObs(JSON.stringify(['/repo/imported.mjs']));

    expect(junctionCount(), 'premise: the junction must be non-empty for this to test anything').toBe(1);
    expect(edgesFor(imported), 'premise: the imported row starts with no edge').toEqual([]);

    runDeferredCleanups(db);

    expect(edgesFor(imported)).toEqual(['/repo/imported.mjs']);
    expect(edgesFor(withEdge), 'the pre-existing edge must survive').toEqual(['/repo/saved.mjs']);
  });

  it('writes every path in the list, not just the first', () => {
    const id = insertObs(JSON.stringify(['/repo/a.mjs', '/repo/b.mjs']));
    runDeferredCleanups(db);
    expect(edgesFor(id)).toEqual(['/repo/a.mjs', '/repo/b.mjs']);
  });

  it('is idempotent: a second pass adds nothing and the marker stops the scan', () => {
    const id = insertObs(JSON.stringify(['/repo/a.mjs']));
    runDeferredCleanups(db);
    expect(markerSet(), 'a successful pass must mark itself done').toBe(true);
    const after = junctionCount();

    // A row that appears later is NOT backfilled — one-shot is the point, and the live
    // import path writes its own edges now. Asserted so the cost of the scan stays bounded.
    const later = insertObs(JSON.stringify(['/repo/later.mjs']));
    runDeferredCleanups(db);
    expect(junctionCount()).toBe(after);
    expect(edgesFor(later)).toEqual([]);
    expect(edgesFor(id)).toEqual(['/repo/a.mjs']);
  });

  it('a malformed files_modified does not cost the rows after it their edges', () => {
    insertObs('{not json');
    const good = insertObs(JSON.stringify(['/repo/good.mjs']));
    runDeferredCleanups(db);
    expect(edgesFor(good), 'one unparseable row aborted the whole pass').toEqual(['/repo/good.mjs']);
    expect(markerSet(), 'the pass must still complete and mark itself').toBe(true);
  });

  it('ignores non-string and empty entries rather than writing junk edges', () => {
    const id = insertObs(JSON.stringify(['/repo/real.mjs', '', null, 42, { path: '/x' }]));
    runDeferredCleanups(db);
    expect(edgesFor(id)).toEqual(['/repo/real.mjs']);
  });

  it('fills rows that have NO edge — it is not a reconciler for partial ones', () => {
    // Scope statement, and the only thing that makes the `NOT EXISTS` clause observable:
    // without it the pass would scan every row carrying files_modified on every store that
    // has never imported anything, which is the common case and the one that must cost
    // nothing. Both writers insert an observation's paths in one transaction, so a partial
    // edge set is not a shape either of them can produce.
    const id = insertObs(JSON.stringify(['/repo/a.mjs', '/repo/b.mjs']));
    db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(id, '/repo/a.mjs');
    runDeferredCleanups(db);
    expect(edgesFor(id)).toEqual(['/repo/a.mjs']);
  });

  it('leaves rows with no files_modified alone', () => {
    const empty = insertObs('[]');
    const nul = insertObs(null);
    runDeferredCleanups(db);
    expect(edgesFor(empty)).toEqual([]);
    expect(edgesFor(nul)).toEqual([]);
  });

  // The junction write is the mechanism; being findable by file is the point. And a fix that
  // makes a new population REACHABLE also enters it into a window with a LIMIT, so the two
  // questions have to be asked together — the previous round shipped the reachability half
  // and let a dozen importance-1 edits evict the importance-3 lesson about the same file.
  it('a backfilled row is recallable by file, and does not evict the lesson about that file', () => {
    const FILE = '/repo/hot.mjs';
    // The real lesson: highest importance, and OLDER than the noise, so nothing about this
    // assertion can be satisfied by recency alone.
    const lesson = insertObs(JSON.stringify([FILE]));
    db.prepare('UPDATE observations SET importance = 3, title = ?, lesson_learned = ? WHERE id = ?').run(
      'the lesson about hot.mjs',
      'do not do the thing',
      lesson,
    );
    const imported = [];
    for (let i = 0; i < 12; i++) imported.push(insertObs(JSON.stringify([FILE])));

    expect(junctionCount(), 'premise: nothing is reachable by file yet').toBe(0);
    runDeferredCleanups(db);

    const { rows } = recallByFile(db, FILE, { limit: 10, includeNoise: true });
    const ids = rows.map((r) => r.id);
    // The NEWEST import, not the oldest: 12 noise rows against a 10-row window means the
    // early ones are correctly out of frame. Asserting on `imported[0]` failed here and the
    // failure was the assertion's, not the code's — the window held [lesson, 13…5].
    expect(ids, 'no backfilled import is reachable by file').toContain(imported[imported.length - 1]);
    expect(ids, 'the importance-3 lesson was evicted by the rows this backfill made reachable').toContain(
      lesson,
    );
  });
});
