// Characterization tests for lib/compress-core.mjs — the shared core extracted
// from cmdCompress (CLI), mem_compress (MCP), and handleAutoCompress (hook),
// which had been hand-synchronized via "parity" comments and drifted (ARCH-1).
// These pin the behavior the three call sites must continue to produce.

import { describe, test, expect } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { COMPRESSED_AUTO } from '../utils.mjs';
import { selectCompressionCandidates, groupByProjectWeek, compressGroup } from '../lib/compress-core.mjs';

const DAY = 86400000;
const OLD = -100 * DAY; // comfortably past a 30-day cutoff

function seed(db) {
  insertSession(db, { id: 'sess-1', project: 'proj-a' });
}

describe('selectCompressionCandidates', () => {
  test('returns importance<=1 (incl. decay-floor imp=0), never-accessed, old, uncompressed observations', () => {
    const db = createTestDb();
    seed(db);
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj-a',
      title: 'keep me',
      importance: 1,
      epochOffset: OLD,
    });
    // imp=0 (citation-decay floor / LLM low-signal filter) is STRICTLY lower value than imp=1
    // and must be a candidate too — `= 1` (exact) left these immortal (audit imp=0 GC fix).
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj-a',
      title: 'floored imp0',
      importance: 0,
      epochOffset: OLD,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj-a',
      title: 'too important',
      importance: 2,
      epochOffset: OLD,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj-a',
      title: 'accessed',
      importance: 1,
      accessCount: 3,
      epochOffset: OLD,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj-a',
      title: 'too recent',
      importance: 1,
      epochOffset: 0,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj-a',
      title: 'already compressed',
      importance: 1,
      epochOffset: OLD,
      compressedInto: 999,
    });

    const cutoff = Date.now() - 30 * DAY;
    const got = selectCompressionCandidates(db, { cutoff });
    expect(got.map((r) => r.title).sort()).toEqual(['floored imp0', 'keep me']);
  });

  test('includeAutoMarked folds in auto-compressed (COMPRESSED_AUTO) rows', () => {
    const db = createTestDb();
    seed(db);
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj-a',
      title: 'fresh-null',
      importance: 1,
      epochOffset: OLD,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj-a',
      title: 'auto-marked',
      importance: 1,
      epochOffset: OLD,
      compressedInto: COMPRESSED_AUTO,
    });

    const cutoff = Date.now() - 30 * DAY;
    expect(selectCompressionCandidates(db, { cutoff }).length).toBe(1);
    expect(selectCompressionCandidates(db, { cutoff, includeAutoMarked: true }).length).toBe(2);
  });

  test('excludes rows carrying a real lesson_learned — folding into a title-only summary would discard it', () => {
    const db = createTestDb();
    seed(db);
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj-a',
      title: 'noise no lesson',
      importance: 1,
      epochOffset: OLD,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj-a',
      title: 'sentinel none',
      importance: 1,
      epochOffset: OLD,
      lessonLearned: 'none',
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj-a',
      title: 'has real lesson',
      importance: 1,
      epochOffset: OLD,
      lessonLearned: 'strip query string before parsing the branch name',
    });

    const cutoff = Date.now() - 30 * DAY;
    const got = selectCompressionCandidates(db, { cutoff })
      .map((r) => r.title)
      .sort();
    expect(got).toEqual(['noise no lesson', 'sentinel none']); // real-lesson row preserved; 'none' sentinel still compressible
  });
});

describe('groupByProjectWeek', () => {
  test('groups by project + ISO week and drops groups with fewer than 3', () => {
    const wk = Date.now() - 100 * DAY;
    const cands = [
      { id: 1, project: 'p', type: 'bugfix', title: 'a', created_at_epoch: wk },
      { id: 2, project: 'p', type: 'bugfix', title: 'b', created_at_epoch: wk + 1000 },
      { id: 3, project: 'p', type: 'change', title: 'c', created_at_epoch: wk + 2000 },
      { id: 4, project: 'q', type: 'bugfix', title: 'd', created_at_epoch: wk },
    ];
    const groups = groupByProjectWeek(cands);
    expect(groups.length).toBe(1);
    expect(groups[0][1].length).toBe(3);
  });
});

describe('compressGroup', () => {
  test('creates one importance-2 weekly summary and marks every source compressed into it', () => {
    const db = createTestDb();
    seed(db);
    const rows = ['x', 'y', 'z'].map((t) =>
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'proj-a',
        type: 'bugfix',
        title: t,
        importance: 1,
        epochOffset: OLD,
      }),
    );
    const obs = rows.map((r) =>
      db
        .prepare('SELECT id, project, type, title, created_at_epoch FROM observations WHERE id = ?')
        .get(Number(r.lastInsertRowid)),
    );

    const { summaryId, compressed } = compressGroup(db, 'proj-a', obs);
    expect(compressed).toBe(3);

    const summary = db.prepare('SELECT * FROM observations WHERE id = ?').get(summaryId);
    expect(summary.importance).toBe(2);
    expect(summary.type).toBe('bugfix'); // dominant
    expect(summary.title).toBe('Weekly summary: 3 bugfix observations');

    for (const o of obs) {
      expect(db.prepare('SELECT compressed_into AS c FROM observations WHERE id = ?').get(o.id).c).toBe(
        summaryId,
      );
    }
  });
});
