// R10 P1-2 + P1-3 — the one-shot `normalize-project-names` cleanup, which runs inside
// ensureDb on every hook event until it completes.
//
// P1-2: after the exact-suffix lookup missed, it fell back to a DISTINCTIVE-TOKEN
// SUBSTRING match — any >=5-char token of the short name matched anywhere inside any
// canonical name. A project whose cwd is a filesystem root (`/workspace` -> `workspace`,
// the ordinary devcontainer shape, which project-utils.mjs:109-120 already recognises as
// legitimate) was therefore renamed into an unrelated project across all eight
// project-scoped tables. There is no snapshot and the sentinel means it never re-runs, so
// the original name is simply gone.
//
// P1-3: three of those eight tables have a PRIMARY KEY containing `project`. A bare
// UPDATE on them throws on conflict, and the whole cleanup ran in ONE transaction with the
// sentinel written only on success — so a single collision rolled back every project's
// rename and the entire scan replayed on the next DB open, forever.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { runDeferredCleanups } from '../schema.mjs';

const CLEANUP = 'normalize-project-names';

function rearm(db) {
  db.prepare('DELETE FROM migration_cleanups WHERE name = ?').run(CLEANUP);
}
function ran(db) {
  return !!db.prepare('SELECT 1 FROM migration_cleanups WHERE name = ?').get(CLEANUP);
}
function obsCounts(db) {
  return db.prepare('SELECT project, COUNT(*) c FROM observations GROUP BY project ORDER BY project').all();
}
function addObs(db, project, n) {
  const stmt = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
     VALUES ('ms-1', ?, 'change', 't', 'n', datetime('now'), ?)`,
  );
  for (let i = 0; i < n; i++) stmt.run(project, Date.now() - i);
}
function addSdkSession(db, project, id) {
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
     VALUES (?, ?, ?, datetime('now'), ?)`,
  ).run(id, `ms-${id}`, project, Date.now());
}

describe('R10 P1-2 — a root-directory project is not absorbed by a token substring', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    // initSchema re-enables foreign_keys; these fixtures insert observations without a
    // parent sdk_sessions row on purpose, because the cleanup under test keys on the
    // `project` column alone.
    db.pragma('foreign_keys = OFF');
  });
  afterEach(() => db.close());

  it('keeps `workspace` and `workspaces--repo` as two projects', () => {
    addObs(db, 'workspace', 3);
    addObs(db, 'workspaces--repo', 5);
    addSdkSession(db, 'workspace', 'cc-1');
    rearm(db);
    runDeferredCleanups(db);

    expect(obsCounts(db)).toEqual([
      { project: 'workspace', c: 3 },
      { project: 'workspaces--repo', c: 5 },
    ]);
    expect(ran(db), 'the cleanup must still complete and set its sentinel').toBe(true);
  });

  it('still merges the legacy shape the cleanup exists for: `mem` into `projects--mem`', () => {
    addObs(db, 'mem', 2);
    addObs(db, 'projects--mem', 4);
    rearm(db);
    runDeferredCleanups(db);
    expect(obsCounts(db)).toEqual([{ project: 'projects--mem', c: 6 }]);
  });

  it('renames every project-scoped table on that legitimate merge', () => {
    addObs(db, 'mem', 1);
    addObs(db, 'projects--mem', 1);
    addSdkSession(db, 'mem', 'cc-a');
    db.prepare(
      `INSERT INTO deferred_work (project, title, priority, status, created_at_epoch) VALUES (?, 'x', 2, 'open', ?)`,
    ).run('mem', Date.now());
    rearm(db);
    runDeferredCleanups(db);
    expect(db.prepare('SELECT project FROM sdk_sessions').all()).toEqual([{ project: 'projects--mem' }]);
    expect(db.prepare('SELECT project FROM deferred_work').all()).toEqual([{ project: 'projects--mem' }]);
  });
});

describe('R10 P1-3 — a primary-key collision does not stall the cleanup forever', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    // initSchema re-enables foreign_keys; these fixtures insert observations without a
    // parent sdk_sessions row on purpose, because the cleanup under test keys on the
    // `project` column alone.
    db.pragma('foreign_keys = OFF');
  });
  afterEach(() => db.close());

  function seedCollision() {
    // Same CC session id recorded under both names — the shape an in-session plugin
    // upgrade produces. session_handoffs PK is (project, type, session_id).
    addObs(db, 'mem', 2);
    addObs(db, 'projects--mem', 3);
    const h = db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
       VALUES (?, 'exit', 'cc-dup', ?, ?)`,
    );
    h.run('mem', 'from the short name', Date.now());
    h.run('projects--mem', 'from the canonical name', Date.now());
    db.prepare(
      `INSERT INTO citation_log (project, memory_session_id, injected_n, cited_n) VALUES (?, 'ms-dup', 1, 1)`,
    ).run('mem');
    db.prepare(
      `INSERT INTO citation_log (project, memory_session_id, injected_n, cited_n) VALUES (?, 'ms-dup', 2, 2)`,
    ).run('projects--mem');
  }

  it('completes on the FIRST run and sets its sentinel', () => {
    seedCollision();
    rearm(db);
    runDeferredCleanups(db);
    expect(ran(db), 'the sentinel was left unset, so this rescans on every DB open').toBe(true);
    expect(obsCounts(db), 'the observations rename was rolled back by the collision').toEqual([
      { project: 'projects--mem', c: 5 },
    ]);
  });

  it('keeps the canonical row on collision rather than dropping it', () => {
    seedCollision();
    rearm(db);
    runDeferredCleanups(db);
    const rows = db
      .prepare(`SELECT project, working_on FROM session_handoffs WHERE session_id = 'cc-dup'`)
      .all();
    expect(rows).toContainEqual({ project: 'projects--mem', working_on: 'from the canonical name' });
    const cit = db
      .prepare(`SELECT project, cited_n FROM citation_log WHERE memory_session_id='ms-dup'`)
      .all();
    expect(cit).toContainEqual({ project: 'projects--mem', cited_n: 2 });
  });

  it('one project colliding does not block an unrelated project rename', () => {
    seedCollision();
    addObs(db, 'other', 2);
    addObs(db, 'group--other', 1);
    rearm(db);
    runDeferredCleanups(db);
    expect(
      db.prepare(`SELECT COUNT(*) c FROM observations WHERE project = 'group--other'`).get().c,
      'the unrelated rename was rolled back with the colliding one',
    ).toBe(3);
  });
});
