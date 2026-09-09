// Regression pins for the R11 audit residue (docs/audits/20260907-113002.md),
// fixed 2026-09-08 after v6.5.0 shipped the three P1s and left these behind.
//
//   A-P2-1 (D#18)  concept co-occurrence expansion seeded from the STRICT query, so it
//                  was inert on exactly the AND→OR rescue path both expansion stages
//                  exist for. Its sibling expandObsByPRF was fixed by M-2 and this one
//                  was not — the asymmetry is the whole finding.
//   A-P3-3         reRankWithContext's "files touched in the last 2h" probe had no
//                  liveness predicate, so compressed and superseded observations kept
//                  injecting filenames into the active-file set that grants a boost.
//
// Every case names, in a comment, the input that made it fail pre-fix.

import { describe, it, expect } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { reRankWithContext } from '../search-scoring.mjs';

// ─── A-P2-1 / D#18 ────────────────────────────────────────────────────────────
// RETRACTION (pre-ship review, 2026-09-09). The commit that shipped this fix claimed
// "13 of 57 fixture queries execute the branch, so denoise-ab is NOT blind here". That is
// a FALSE CONJUNCTION built from two true parts: 13 of 57 queries do fire the AND→OR
// fallback, and for all 13 the concept list does change from [] to non-empty — but those
// 13 each recover 6-60 rows, every one of them past the expansion gate
// (`results.length < ceil(limit/2)` = 5), so expandObsByConceptCo never runs on them. The
// intersection of "OR fallback fired" and "expansion gate open" over the corpus is 0/57,
// measured twice independently. denoise-ab's Δ = 0.000 was therefore structural, and this
// change is ZERO-MEASURED by that harness. The case below is its only evidence — which is
// why it asserts behaviour and is mutation-verified, not why the A/B was reassuring.
// Generalisable: a reach probe must measure the branch EXECUTING, not the conditions that
// would let it.

describe('R11 A-P2-1 — concept expansion fires when only the OR fallback matched', () => {
  // FAILS IF: expandObsByConceptCo's seed reverts to ctx.ftsQuery. The strict AND
  // returns zero rows by definition on this fixture, expandQueryByConcepts reads zero
  // top docs, returns [], and the concept-only row never enters the result set.
  //
  // This is the twin of the M-2 PRF probe in audit-fixes-20260816.test.mjs. The two
  // stages must stay byte-identical in how they pick their seed; that they had drifted
  // apart is what R11 found.
  it('a row reachable only via concept co-occurrence surfaces in the OR-rescue band', async () => {
    const { sanitizeFtsQuery } = await import('../utils.mjs');
    const { searchObservationsHybrid } = await import('../search-engine.mjs');
    const db = createTestDb();
    insertSession(db, { id: 'r11-s', project: 'p' });

    // Three rescue docs: each matches 'zebra' (one of two query terms) and none matches
    // the strict AND. Titles and narratives share NO content word beyond 'zebra' itself,
    // so extractPRFTerms finds no recurring stem and the PRF stage stays out of this
    // probe — the concept column is the only channel to the target.
    const rescue = [
      { title: 'zebra alpha', narrative: 'overnight backlog observed' },
      { title: 'zebra bravo', narrative: 'latency rising steadily' },
      { title: 'zebra charlie', narrative: 'alerts firing loudly' },
    ];
    for (const r of rescue) {
      const id = Number(
        insertObs(db, { sessionId: 'r11-s', project: 'p', type: 'bugfix', ...r }).lastInsertRowid,
      );
      // insertObs writes concepts as '', and concepts is FTS-indexed (OBS_FTS_COLUMNS),
      // so this UPDATE fires the _au trigger and reaches the index.
      db.prepare('UPDATE observations SET concepts = ? WHERE id = ?').run('sidecarmesh', id);
    }

    // Expansion-only target: carries the shared concept, NEITHER query term, and no
    // word from any rescue doc.
    const targetId = Number(
      insertObs(db, {
        sessionId: 'r11-s',
        project: 'p',
        type: 'bugfix',
        title: 'sidecarmesh handshake teardown',
        narrative: 'the sidecarmesh proxy drops its peer during teardown',
      }).lastInsertRowid,
    );

    const ctx = {
      ftsQuery: sanitizeFtsQuery('zebra quokka'), // strict AND: zero hits
      args: {},
      epochFrom: null,
      epochTo: null,
      perSourceLimit: 10,
      perSourceOffset: 0,
      currentProject: 'p',
      limit: 10,
    };
    const results = searchObservationsHybrid(db, ctx);

    expect(ctx.orFallbackFired, 'precondition: the OR fallback must have rescued rows').toBe(true);
    expect(ctx.effectiveFtsQuery, 'precondition: the rescue query must be recorded on ctx').toBeTruthy();
    expect(
      results.map((r) => r.id),
      'concept-expansion row missing — expandObsByConceptCo is seeding from the strict query again',
    ).toContain(targetId);
    db.close();
  });
});

// ─── A-P3-3 ───────────────────────────────────────────────────────────────────
// denoise-ab is STRUCTURALLY BLIND here: benchmark.mjs:152 says reRankWithContext is
// intentionally not mirrored in searchProductionHybrid, so an A/B NEUTRAL from that
// harness says nothing about this change (doctrine rule 9). These probes are the
// load-bearing evidence.

describe('R11 A-P3-3 — the active-file probe only counts LIVE observations', () => {
  // FAILS IF: liveObsFilterSql is dropped from the recentFiles query. The tombstoned
  // row is then the sole occupant of the 2h window, activeFiles becomes
  // {'src/ghost.mjs'}, and the old result row matching that filename gets the exact-hit
  // boost — a ranking bonus paid out by a row no retrieval surface will ever return.
  it('a superseded row does not put its filename into the active-file set', () => {
    const db = createTestDb();
    insertSession(db, { id: 'p3-s', memoryId: 'p3-s', project: 'p' });

    // The only row inside the 2h window, and it is a tombstone.
    insertObs(db, {
      sessionId: 'p3-s',
      project: 'p',
      title: 'corrected away',
      filesModified: '["src/ghost.mjs"]',
      epochOffset: -1000,
      supersededAt: new Date().toISOString(),
    });
    // Result row: same file, but created outside the window so it cannot seed the set.
    const r = insertObs(db, {
      sessionId: 'p3-s',
      project: 'p',
      title: 'ghost result',
      filesModified: '["src/ghost.mjs"]',
      epochOffset: -3 * 3600000,
    });

    const results = [{ source: 'obs', id: Number(r.lastInsertRowid), score: -5.0 }];
    reRankWithContext(db, results, 'p');
    expect(results[0].score, 'a tombstoned row is still granting a recency boost').toBe(-5.0);
    db.close();
  });

  // Positive control — the guard above must be able to say NO in both directions. If a
  // future edit filters too hard (or the junction join breaks), this goes red instead of
  // the feature silently becoming a no-op that the case above would happily pass.
  it('a live row in the same position still produces the boost', () => {
    const db = createTestDb();
    insertSession(db, { id: 'p3-s2', memoryId: 'p3-s2', project: 'p' });

    insertObs(db, {
      sessionId: 'p3-s2',
      project: 'p',
      title: 'still live',
      filesModified: '["src/ghost.mjs"]',
      epochOffset: -1000,
    });
    const r = insertObs(db, {
      sessionId: 'p3-s2',
      project: 'p',
      title: 'ghost result',
      filesModified: '["src/ghost.mjs"]',
      epochOffset: -3 * 3600000,
    });

    const results = [{ source: 'obs', id: Number(r.lastInsertRowid), score: -5.0 }];
    reRankWithContext(db, results, 'p');
    expect(results[0].score, 'the live-row boost was filtered away too').toBeLessThan(-5.0);
    db.close();
  });

  // The compressed half of liveObsFilterSql cannot fire inside a 2h window on its own:
  // every automatic compressed_into writer gates on created_at_epoch < cutoff with a
  // 14-day floor (runIdleCleanup's four thresholds, findMergeCandidates, and
  // findSmartCompressCandidates at 30d). Only an explicit `compress` reaches a fresh
  // row, and there the user has said the row is folded into a summary. Pinned so the
  // claim in the commit message stays checkable.
  it('a compressed row is excluded too', () => {
    const db = createTestDb();
    insertSession(db, { id: 'p3-s3', memoryId: 'p3-s3', project: 'p' });

    insertObs(db, {
      sessionId: 'p3-s3',
      project: 'p',
      title: 'folded into a summary',
      filesModified: '["src/ghost.mjs"]',
      epochOffset: -1000,
      compressedInto: 9999,
    });
    const r = insertObs(db, {
      sessionId: 'p3-s3',
      project: 'p',
      title: 'ghost result',
      filesModified: '["src/ghost.mjs"]',
      epochOffset: -3 * 3600000,
    });

    const results = [{ source: 'obs', id: Number(r.lastInsertRowid), score: -5.0 }];
    reRankWithContext(db, results, 'p');
    expect(results[0].score, 'a compressed row is still granting a recency boost').toBe(-5.0);
    db.close();
  });
});

// ─── D#21 — pagination stability through a pool-sensitive assembly path ───────
// Removing the TF-IDF vector arm deleted tests/cli.test.mjs's two
// "CLI search pagination stability (hybrid FTS+vector RRF)" cases along with it: they
// asserted on `vecCount > 0` and could not be re-pointed. The unit-level guard on
// computePerSourceWindow's offset-independence survived (tests/search-core.test.mjs), but
// the layer above it — "a paged search whose result set was ASSEMBLED by a stage that
// re-adds rows an SQL OFFSET already skipped" — has had no integration guard since. The
// cli-e2e case is FTS-only by its own comment.
//
// The property under test is the one D#30 established: every source fetches from offset 0
// and the caller slices exactly once post-merge, so pages must partition the result set.
// The concept/PRF expansion stages are the pool-sensitive part that is still shipped.

describe('D#21 — paging partitions a result set built by the expansion stages', () => {
  it('two pages are disjoint and equal one double-length page', async () => {
    const { sanitizeFtsQuery } = await import('../utils.mjs');
    const { handleSearchForTest } = await import('../server.mjs');
    const db = createTestDb();
    insertSession(db, { id: 'd21-s', project: 'd21' });

    // TWO direct hits, because expandQueryByConcepts only promotes a concept seen in at
    // least two of the seed documents — with one hit the stage runs and finds nothing, and
    // the fixture would be measuring the wrong absence. They also keep the strict pool
    // below ceil(limit/2) so the expansion stages run at all. The five rows below carry
    // only the shared concept, so they can enter ONLY through concept co-occurrence — the
    // stage that re-adds rows independently of any SQL offset.
    for (const n of ['one', 'two']) {
      const direct = Number(
        insertObs(db, {
          sessionId: 'd21-s',
          project: 'd21',
          type: 'bugfix',
          title: `quokka stall observed ${n}`,
          narrative: `the quokka stalls under load ${n}`,
        }).lastInsertRowid,
      );
      db.prepare('UPDATE observations SET concepts = ? WHERE id = ?').run('sidecarmesh', direct);
    }
    const expansionIds = [];
    for (let i = 0; i < 5; i++) {
      const id = Number(
        insertObs(db, {
          sessionId: 'd21-s',
          project: 'd21',
          type: 'bugfix',
          title: `sidecarmesh teardown ${i}`,
          narrative: `the sidecarmesh proxy drops peer ${i} during teardown`,
        }).lastInsertRowid,
      );
      db.prepare('UPDATE observations SET concepts = ? WHERE id = ?').run('sidecarmesh', id);
      expansionIds.push(id);
    }

    const page = async (offset, limit) =>
      (await handleSearchForTest(db, { query: 'quokka', project: 'd21', limit, offset }, {})).results.map(
        (r) => r.id,
      );

    // Both limits must sit on the SAME side of the expansion gate — it reads
    // `results.length < ceil(limit/2)`, so limit 3 against a 2-row strict pool turns the
    // stage OFF and the two reads would be comparing different assemblies rather than
    // different pages of one. 6 and 12 both leave it on, and computePerSourceWindow floors
    // both at MIN_FUSION_POOL = 60, so the candidate pool is identical too.
    const whole = await page(0, 12);
    expect(
      whole.length,
      'premise: the expansion stages must have produced more than one page',
    ).toBeGreaterThan(3);
    // Some expansion-only row must be in the page — not a specific one: which of the five
    // survives the limit is a ranking question this case has no business pinning.
    expect(
      whole.filter((id) => expansionIds.includes(id)).length,
      'premise: no expansion-only row reached the page, so the stage under test never ran',
    ).toBeGreaterThan(0);

    const first = await page(0, 6);
    const second = await page(6, 6);
    // Disjoint: a pool that grew with the offset would re-rank the prefix and repeat rows.
    expect(
      first.filter((id) => second.includes(id)),
      'pages overlap',
    ).toEqual([]);
    // And together they are the same set, in the same order, as one un-paged read.
    expect([...first, ...second]).toEqual(whole);
    void sanitizeFtsQuery;
    db.close();
  });
});
