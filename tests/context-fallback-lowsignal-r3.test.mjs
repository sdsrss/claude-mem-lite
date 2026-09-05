// R3 T-M1 (MED): when the current project is thin (<3 obs) the SessionStart Recent
// table falls back to the cross-project pool (fallbackObs). That query lacked the
// low-signal title filter its sibling obsPool has, so `Modified X` / `Error: …` /
// `npx …` noise from OTHER projects leaked in — and, being freshest, led the table.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { buildSessionContextLines } from '../hook-context.mjs';

describe('SessionStart Recent must not leak cross-project low-signal noise (R3 T-M1)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-cur', project: 'curproj' });
    insertSession(db, { id: 'sess-other', project: 'otherproj' });
  });
  afterEach(() => {
    db.close();
  });

  it('fallbackObs excludes low-signal-titled rows from other projects', () => {
    // current project thin (<3 obs) → Recent falls back to the cross-project pool
    insertObs(db, {
      sessionId: 'sess-cur',
      project: 'curproj',
      type: 'decision',
      title: 'Chose RRF over union-by-max for hybrid merge',
      importance: 2,
    });
    insertObs(db, {
      sessionId: 'sess-cur',
      project: 'curproj',
      type: 'bugfix',
      title: 'Fixed FTS5 trigger corruption on bulk update',
      importance: 2,
    });

    // another project's fresh but low-signal noise (sorts to the TOP by recency)
    insertObs(db, {
      sessionId: 'sess-other',
      project: 'otherproj',
      type: 'change',
      title: 'Modified webpack.config.js',
      importance: 1,
    });
    insertObs(db, {
      sessionId: 'sess-other',
      project: 'otherproj',
      type: 'bugfix',
      title: 'Error: ENOENT no such file build/out.js',
      importance: 1,
    });
    insertObs(db, {
      sessionId: 'sess-other',
      project: 'otherproj',
      type: 'change',
      title: 'npx eslint . --fix',
      importance: 1,
    });

    const lines = buildSessionContextLines(db, 'curproj'); // returns a joined string

    expect(lines, 'real current-project memory survives').toContain('Chose RRF over union-by-max');
    expect(lines, 'low-signal cross-project noise must not leak').not.toContain('Modified webpack.config.js');
    expect(lines).not.toContain('npx eslint');
    expect(lines).not.toContain('ENOENT');
  });
});
