// Regression: warm-start fast-path must restore foreign_keys enforcement.
//
// Bug (pre-fix): ensureDb() opens the DB with `foreign_keys = OFF` (schema.mjs:749,
// because early migrations must run with cascade disabled) and then calls initSchema().
// On the COMMON warm-start path (DB already at CURRENT_SCHEMA_VERSION), initSchema()
// returns early via the fast-path (schema.mjs:215) WITHOUT ever reaching the
// `foreign_keys = ON` at the end of the full migration path. The returned handle
// therefore has FK enforcement OFF, so every subsequent DELETE skips ON DELETE CASCADE.
// Live DBs accumulated 6440/9569 (67%) orphaned observation_files rows as a result —
// the same failure class the v28 observation_vectors cleanup (schema.mjs:488) patched
// downstream without fixing the root cause.

import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, runDeferredCleanups, CURRENT_SCHEMA_VERSION } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';

// Initialize a fresh DB to CURRENT_SCHEMA_VERSION (full migration path), then simulate
// a second process opening the already-current DB exactly as ensureDb() does: set
// foreign_keys OFF, then re-run initSchema (which takes the warm-start fast-path).
function openWarmStart(db) {
  db.pragma('foreign_keys = OFF');
  return initSchema(db);
}

describe('schema warm-start FK enforcement (regression)', () => {
  test('initSchema warm-start fast-path returns a handle with foreign_keys ON', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    initSchema(db); // fresh DB → full migration path → ends FK ON

    openWarmStart(db); // already at CURRENT_SCHEMA_VERSION → fast-path return (schema.mjs:215)

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  test('deleting an observation cascades to observation_files via a warm-start handle', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    initSchema(db); // fresh → full path

    insertSession(db, { id: 'sess-1' });
    const obs = insertObs(db, {
      sessionId: 'sess-1',
      title: 'warm-start cascade probe',
      filesModified: JSON.stringify(['schema.mjs']),
    });
    const obsId = Number(obs.lastInsertRowid);
    expect(db.prepare('SELECT COUNT(*) AS c FROM observation_files WHERE obs_id = ?').get(obsId).c).toBe(1);

    openWarmStart(db); // common warm-start path — pre-fix leaves FK OFF on this handle

    db.prepare('DELETE FROM observations WHERE id = ?').run(obsId);

    // ON DELETE CASCADE must remove the junction row. Pre-fix (FK OFF) it lingers as an orphan.
    expect(db.prepare('SELECT COUNT(*) AS c FROM observation_files WHERE obs_id = ?').get(obsId).c).toBe(0);
  });
});

// Phase 2: forward-only FK fix above stops NEW orphans, but the backlog of rows
// leaked while FK was OFF (live DB: 6440/9569 observation_files, 143 observation_vectors)
// stays until cleaned. A one-shot cleanup, gated to the full migration path by a
// version bump, mirrors the existing v28 observation_vectors cleanup (schema.mjs:488).
describe('one-shot orphan junction cleanup on version-bump migration (regression)', () => {
  function currentDb() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    initSchema(db); // fresh → full path → DB at CURRENT_SCHEMA_VERSION
    return db;
  }

  // Roll schema_version back one step so the next initSchema takes the full
  // migration path (as a pre-bump live DB would), then re-run it.
  function reMigrate(db) {
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION - 1);
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    // Orphan cleanups moved out of initSchema into runDeferredCleanups, which
    // ensureDb() runs on every open (audit P1-5). Mirror that here.
    runDeferredCleanups(db);
  }

  test('re-migration deletes orphaned observation_files and keeps valid rows', () => {
    const db = currentDb();
    db.pragma('foreign_keys = OFF'); // permit inserting orphan junction rows directly

    insertSession(db, { id: 'sess-keep' });
    const valid = insertObs(db, {
      sessionId: 'sess-keep',
      title: 'keep me',
      filesModified: JSON.stringify(['keep.mjs']),
    });
    const validId = Number(valid.lastInsertRowid);

    const insOrphan = db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)');
    insOrphan.run(999001, 'orphan-a.mjs');
    insOrphan.run(999002, 'orphan-b.mjs');
    expect(db.prepare('SELECT COUNT(*) AS c FROM observation_files').get().c).toBe(3);

    reMigrate(db);

    expect(
      db.prepare('SELECT COUNT(*) AS c FROM observation_files WHERE obs_id IN (999001, 999002)').get().c,
    ).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM observation_files WHERE obs_id = ?').get(validId).c).toBe(1);
  });

  // Guards that bumping the schema version re-triggers the companion v28
  // observation_vectors cleanup, clearing post-v28 orphans on the same pass.
  test('re-migration deletes orphaned observation_vectors and keeps valid rows', () => {
    const db = currentDb();
    db.pragma('foreign_keys = OFF');

    insertSession(db, { id: 'sess-vec' });
    const valid = insertObs(db, { sessionId: 'sess-vec', title: 'vec keep' });
    const validId = Number(valid.lastInsertRowid);
    const insVec = db.prepare(
      'INSERT INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)',
    );
    insVec.run(validId, Buffer.from([1, 2, 3]), 'v-test', 1);
    insVec.run(999100, Buffer.from([4, 5, 6]), 'v-test', 1); // orphan
    expect(db.prepare('SELECT COUNT(*) AS c FROM observation_vectors').get().c).toBe(2);

    reMigrate(db);

    expect(
      db.prepare('SELECT COUNT(*) AS c FROM observation_vectors WHERE observation_id = 999100').get().c,
    ).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM observation_vectors WHERE observation_id = ?').get(validId).c,
    ).toBe(1);
  });
});
