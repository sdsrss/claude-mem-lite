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
