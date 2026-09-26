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

// ── Explicit-save provenance floor (2026-09-26, cocina "tandoor" audit) ──────
//
// Deliberately a SMALL, single-project corpus — the opposite setup from the suite
// above, which pads to 12 background rows per table specifically to keep BM25's
// IDF away from zero. This reproduces the real failure: a brand-new or small
// project's observations table has too few rows for IDF to discriminate at all,
// so an explicit mem_save that is the ONLY observation on-topic scores ~0 and
// SINGLE_MATCH_BANDS reads that as a grazing match — well behind a multi-hit
// auto-captured event leg that (being the higher-cardinality, auto-populated
// table) still has real IDF spread. Without the floor in normalizeCrossSourceScores,
// this test fails with the manual save buried behind every event.
describe('explicit-save floor on a near-zero-IDF (small) corpus', () => {
  let smallDb;

  beforeAll(() => {
    smallDb = createTestDb();
    insertSession(smallDb, { id: 'manual-cocina', project: 'cocina' });
    insertSession(smallDb, { id: 'auto-sess-1', project: 'cocina' });

    // The ONLY two observations in the whole store — real-shape near-zero-IDF corpus.
    insertObs(smallDb, {
      sessionId: 'manual-cocina', // explicit mem_save convention (isManualSave)
      project: 'cocina',
      type: 'feature',
      title: 'Import Tandoor completo: 66 recetas, 98.61% ingredientes bien',
      narrative: 'Tandoor import de las 66 recetas del vault Obsidian, verificado.',
      importance: 3,
      epochOffset: -1000,
    });
    insertObs(smallDb, {
      sessionId: 'auto-sess-1',
      project: 'cocina',
      type: 'bugfix',
      title: 'unrelated staple matching fix',
      narrative: 'no mention of the search term at all',
      importance: 2,
      epochOffset: -2000,
    });

    const insE = smallDb.prepare(`
      INSERT INTO events (project, event_type, title, body, importance, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const eventTitles = [
      'Fixed Tandoor ingredient-parser endpoint in recipe importer',
      'Fixed staple ingredient matching in Tandoor recipe imports',
      'Verified Tandoor integration in cocina import validation',
      'Spanish fractional cooking measurement parsing for Tandoor import',
      'Created Tandoor-Vault recipe bridge modules',
    ];
    eventTitles.forEach((title, i) => {
      insE.run('cocina', 'discovery', title, 'auto-captured episode body', 1, Date.now() - 3000 - i * 500);
    });
  });

  test('a matching explicit mem_save outranks auto-captured events on a tiny corpus', async () => {
    const res = await handleSearchForTest(smallDb, { query: 'tandoor', deep: false, limit: 10 }, {});
    const rows = res.results.map((r) => ({ source: r.source, id: r.id, title: r.title }));
    const eventRows = rows.filter((r) => r.source === 'event');
    expect(eventRows.length).toBeGreaterThanOrEqual(4); // real multi-hit auto competition present
    expect(rows[0].source).toBe('obs'); // the explicit save leads all of them
    expect(rows[0].title).toContain('66 recetas');
  });
});
