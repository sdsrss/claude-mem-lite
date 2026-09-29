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

  // Background corpora on BOTH legs, so these two scenarios measure the ratio bands
  // and not IDF. In a 1-2 row FTS table FTS5 clamps the IDF to 1e-6 and the raw
  // magnitude stops carrying match strength; that shape is real (a new per-project
  // store) and has its own scenario below (#36). 12 unrelated rows per table keep
  // the IDF informative here.
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

// #36: a new per-project store (CLAUDE_MEM_DIR set per project). The observations table holds
// two rows and the query term is in one of them, so FTS5's IDF is ln((2-1+0.5)/(1+0.5)) = 0,
// which FTS5 clamps to 1e-6. The lone obs hit's raw bm25 is then ~1e-6 while the events leg
// (14 rows, term in 5) scores near -1: the cross-source ratio is ~1e-6 and the band read it as
// a grazing match (-0.25), last behind every event. A clamped IDF says the term does not
// discriminate WITHIN that table; it says nothing about how well the row matches.
describe('#36: a lone obs hit whose IDF FTS5 clamped (real pipeline)', () => {
  let small;

  beforeAll(() => {
    small = createTestDb();
    insertSession(small, { id: 'manual-tiny', project: 'tiny' });
    insertObs(small, {
      sessionId: 'manual-tiny',
      project: 'tiny',
      type: 'feature',
      title: 'Tandoor import complete: 66 recipes, ingredients parsed',
      text: 'imported every tandoor recipe and checked the ingredient lines',
      importance: 3,
      epochOffset: -1000,
    });
    insertObs(small, {
      sessionId: 'manual-tiny',
      project: 'tiny',
      type: 'decision',
      title: 'Units normalised to grams before parsing',
      text: 'metric units only, conversion happens at import time',
      importance: 3,
      epochOffset: -2000,
    });
    const insE = small.prepare(`
      INSERT INTO events (project, event_type, title, body, importance, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < 14; i++) {
      const hit = i % 3 === 0; // 5 of 14 mention the term
      insE.run(
        'tiny',
        'discovery',
        hit ? `ran tandoor export step ${i}` : `edited parser module ${i}`,
        hit ? `tandoor api call ${i} returned recipes` : `adjusted unit table entry ${i}`,
        1,
        Date.now() - 5000 - i * 1000,
      );
    }
  });

  test('premise: FTS5 clamps the obs IDF, so the raw obs score is at the clamp scale', () => {
    const [row] = small
      .prepare(
        `SELECT bm25(observations_fts) AS s FROM observations_fts WHERE observations_fts MATCH 'tandoor'`,
      )
      .all();
    expect(Math.abs(row.s)).toBeLessThan(1e-5);
  });

  test('the lone clamped obs hit is not sunk below every event', async () => {
    const res = await handleSearchForTest(small, { query: 'tandoor', deep: false }, {});
    const rows = res.results.map((r) => ({ source: r.source, score: r.score }));
    expect(rows.filter((r) => r.source === 'event').length).toBe(5);
    const obs = rows.filter((r) => r.source === 'obs');
    expect(obs).toHaveLength(1);
    // Scored like the best row of any other source (-1), not as a grazing match (-0.25).
    expect(obs[0].score).toBe(-1);
    const lastEventIdx = rows.findLastIndex((r) => r.source === 'event');
    expect(rows.findIndex((r) => r.source === 'obs')).toBeLessThan(lastEventIdx);
  });
});
