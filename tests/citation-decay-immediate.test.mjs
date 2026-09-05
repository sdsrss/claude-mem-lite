// MED-2 (full audit 2026-07-16): applyCitationDecay must open its decay
// transaction in IMMEDIATE mode so busy_timeout covers the write. A plain
// (DEFERRED) transaction reads a snapshot first, then writes; under concurrent
// same-project Stop hooks the second session's write hits SQLITE_BUSY_SNAPSHOT
// (a snapshot-upgrade conflict busy_timeout cannot resolve), the catch swallows
// it, and that session's whole decay pass (promotes/demotes/streak/funnel
// deltas) is silently lost. IMMEDIATE takes the write lock up front so
// busy_timeout=5000 actually applies.

import { describe, it, expect, afterEach } from 'vitest';
import { applyCitationDecay } from '../lib/citation-tracker.mjs';
import { createTestDb, insertObs, insertSession } from './test-helpers.mjs';

describe('applyCitationDecay transaction mode (MED-2)', () => {
  const cleanups = [];
  afterEach(() => {
    while (cleanups.length) {
      try {
        cleanups.pop()();
      } catch {
        /* ignore */
      }
    }
  });

  it('opens the decay transaction with .immediate(), not the default DEFERRED', () => {
    const db = createTestDb();
    cleanups.push(() => db.close());
    insertSession(db, { id: 'sess-1', project: 'p' });
    const r = insertObs(db, { project: 'p', title: 'lesson row', importance: 1, lessonLearned: 'x' });
    const id = Number(r.lastInsertRowid);

    // Spy on db.transaction to record which begin-mode the returned txn is
    // invoked with. better-sqlite3's transaction() returns a callable that also
    // carries .immediate()/.deferred()/.exclusive() variants.
    const realTransaction = db.transaction.bind(db);
    let usedImmediate = false;
    let usedDefault = false;
    db.transaction = (fn) => {
      const t = realTransaction(fn);
      const wrapped = (...a) => {
        usedDefault = true;
        return t(...a);
      };
      wrapped.immediate = (...a) => {
        usedImmediate = true;
        return t.immediate(...a);
      };
      wrapped.deferred = (...a) => t.deferred(...a);
      wrapped.exclusive = (...a) => t.exclusive(...a);
      return wrapped;
    };

    applyCitationDecay(db, 'p', [id], [id], 'sess-A');

    expect(usedImmediate).toBe(true);
    expect(usedDefault).toBe(false);
  });

  it('regression: normal (uncontended) promote still credits cited_count and resets streak', () => {
    const db = createTestDb();
    cleanups.push(() => db.close());
    insertSession(db, { id: 'sess-1', project: 'p' });
    const r = insertObs(db, {
      project: 'p',
      title: 'lesson',
      importance: 1,
      uncitedStreak: 2,
      lessonLearned: 'y',
    });
    const id = Number(r.lastInsertRowid);
    const res = applyCitationDecay(db, 'p', [id], [id], 'sess-A');
    expect(res.promoted).toBe(1);
    const row = db
      .prepare('SELECT importance, uncited_streak, cited_count FROM observations WHERE id = ?')
      .get(id);
    expect(row.importance).toBe(1); // D#179: untouched (seeded at 1)
    expect(row.uncited_streak).toBe(0);
    expect(row.cited_count).toBe(1);
  });
});
