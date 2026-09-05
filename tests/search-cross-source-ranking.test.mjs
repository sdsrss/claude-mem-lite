// Cross-source ranking probes through the REAL pipeline (audit 2026-07-17 MED-1 + MED-2).
//
// The A/B benchmarks (denoise-ab / longmemeval) drive the obs-only path and are
// structurally blind to cross-source merge behavior — a NEUTRAL verdict there is
// NOT evidence for levers on normalizeCrossSourceScores or the events leg. These
// probes are that evidence: they seed observations + events into a real schema and
// assert ranking DIRECTION through handleSearchForTest (the MCP seam over
// coreRunSearchPipeline), where the normalization actually runs.
//
// Two directions, one per historical bug:
//  - MED-5 (v3.48.0): an incidental lone event must NOT outrank a strong obs page.
//  - MED-1 (this audit): a lone event that IS the strongest raw match (events are
//    the canonical store for promoted bugfix/decision memories — low-cardinality,
//    so lone hits are the common case) must NOT be buried under weak obs matches.
import { describe, test, expect, beforeAll } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { handleSearchForTest } from '../server.mjs';

let db;

beforeAll(() => {
  db = createTestDb();
  insertSession(db, { id: 'xs-1', project: 'test' });
  const insE = db.prepare(`
    INSERT INTO events (project, event_type, title, body, importance, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Background corpora on BOTH legs. In a 1-2 row FTS table BM25's IDF term
  // collapses toward zero, so every raw magnitude is noise and the cross-source
  // ratio banding is meaningless — production tables hold thousands of rows on
  // each leg. 12 unrelated rows per table is enough to restore stable IDF.
  for (let i = 0; i < 12; i++) {
    insE.run(
      'test',
      'feature',
      `background event ${i} shipping widget ${i}`,
      `assorted release notes entry ${i} for the widget pipeline`,
      1,
      Date.now() - 50000 - i * 1000,
    );
    insertObs(db, {
      sessionId: 'xs-1',
      type: 'discovery',
      title: `background obs ${i} widget housekeeping`,
      text: `regular housekeeping entry ${i} covering widget chores and small tweaks`,
      importance: 1,
      epochOffset: -60000 - i * 1000,
    });
  }

  // ── Scenario A (MED-1): the best answer is ONE event; obs only graze the keyword.
  // Event: exact title hit on "zephyrlock" (EVT_BM25 title weight 5).
  insE.run(
    'test',
    'bugfix',
    'zephyrlock deadlock root cause and fix',
    'zephyrlock mutex ordering fixed by lock hierarchy',
    2,
    Date.now() - 1000,
  );
  // Obs: body-only incidental mentions (weak raw BM25), ≥2 rows so the source is
  // multi-hit and its best is pinned to -1 by within-source normalization.
  insertObs(db, {
    sessionId: 'xs-1',
    type: 'discovery',
    title: 'unrelated refactor notes',
    text: 'touched the queue near the zephyrlock call site',
    importance: 1,
    epochOffset: -2000,
  });
  insertObs(db, {
    sessionId: 'xs-1',
    type: 'discovery',
    title: 'weekly cleanup log',
    text: 'saw zephyrlock mentioned in a comment',
    importance: 1,
    epochOffset: -3000,
  });

  // ── Scenario B (MED-5 preserved): strong obs page; ONE incidental event.
  insertObs(db, {
    sessionId: 'xs-1',
    type: 'bugfix',
    title: 'quartzgate race fixed in scheduler',
    text: 'quartzgate race condition eliminated with barrier',
    importance: 3,
    epochOffset: -1500,
  });
  insertObs(db, {
    sessionId: 'xs-1',
    type: 'bugfix',
    title: 'quartzgate follow-up: barrier ordering',
    text: 'quartzgate barrier order hardened',
    importance: 2,
    epochOffset: -2500,
  });
  insE.run(
    'test',
    'refactor',
    'sprint retro notes',
    'one attendee mentioned quartzgate in passing',
    1,
    Date.now() - 3500,
  );
});

async function search(query) {
  const res = await handleSearchForTest(db, { query, deep: false }, {});
  return res.results.map((r) => ({ source: r.source, title: r.title, score: r.score }));
}

describe('cross-source ranking direction (real pipeline)', () => {
  test('MED-1: a lone strongest-raw event outranks weak multi-hit obs', async () => {
    const rows = await search('zephyrlock');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0].source).toBe('event'); // the exact-title event leads, not a grazing obs
  });

  test('MED-5 preserved: an incidental lone event stays below a strong obs page', async () => {
    const rows = await search('quartzgate');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0].source).toBe('obs'); // strong obs page leads
    const eventIdx = rows.findIndex((r) => r.source === 'event');
    expect(eventIdx).toBeGreaterThan(0); // the passing mention does not take the top slot
  });
});
