// Corpus-size normalization of the UPS absolute score floors.
//
// TOP_REL_FLOOR (50) and OR_TOP_BM25_FLOOR (30) gate a quantity that carries an
// FTS5 IDF term (≈ ln(N/df)), so the SAME row scores higher on a bigger index.
// Measured on one fixed query + target while padding the corpus with distinct
// filler (2026-08-13 dogfood): |bm25| 10.0 @ N=10 → 18.6 @ 40 → 24.2 @ 100 →
// 30.7 @ 300. The floors were calibrated at 584 obs, so on a new install they
// reject every hit — a realistic first-day corpus scored 0/8 injections.
//
// corpusFloorScale() restores scale-invariance by dividing the corpus's max
// attainable IDF — FTS5's `log((N - df + 0.5) / (df + 0.5))` at df=1 — by the
// reference corpus's, capped at 1. The cap is the safety property: established
// installs must be untouched.
//
// The 2026-08-17 e2e round replaced the first cut's ln(N+1)/ln(N_REF+1) ramp, which decayed far too
// slowly at small N and left a first-week corpus silent below ~5 rows. The
// end-to-end consequence is pinned in tests/ups-cold-start-injection.test.mjs;
// this suite covers the scale's structural properties only. Deliberately NOT
// asserted here: the closed form at any single N. Mirroring the formula in the test
// makes the test agree with whatever the code says, which is how the wrong ramp
// stayed green.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { corpusFloorScale } from '../scripts/user-prompt-search.js';

function dbWith(n) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT)');
  const ins = db.prepare('INSERT INTO observations (title) VALUES (?)');
  const many = db.transaction((count) => {
    for (let i = 0; i < count; i++) ins.run(`row ${i}`);
  });
  many(n);
  return db;
}

describe('corpusFloorScale', () => {
  let dbs = [];
  beforeEach(() => {
    dbs = [];
  });
  afterEach(() => {
    for (const d of dbs) {
      try {
        d.close();
      } catch {
        /* already closed */
      }
    }
  });
  const open = (n) => {
    const d = dbWith(n);
    dbs.push(d);
    return d;
  };

  it('is exactly 1.0 at and above the calibration corpus — established installs unchanged', () => {
    expect(corpusFloorScale(open(584))).toBe(1);
    expect(corpusFloorScale(open(1000))).toBe(1);
    expect(corpusFloorScale(open(3551))).toBe(1);
  });

  it('relaxes proportionally below the calibration corpus', () => {
    const s10 = corpusFloorScale(open(10));
    const s100 = corpusFloorScale(open(100));
    const s500 = corpusFloorScale(open(500));
    expect(s10).toBeLessThan(s100);
    expect(s100).toBeLessThan(s500);
    expect(s500).toBeLessThan(1);
    // The scaled OR floor must land strictly inside (0, 30) — relaxed, not removed.
    expect(30 * s10).toBeGreaterThan(0);
    expect(30 * s10).toBeLessThan(30);
    // Measured on the production write path: a topical hit on a 10-row corpus reaches
    // |bm25| ≈ 15.5. The scaled floor has to sit below that or the corpus is silent.
    // Independent of the closed form — re-derive the 15.5 (ramp table in
    // tests/ups-cold-start-injection.test.mjs) if the tokenizer or scoring changes.
    expect(30 * s10).toBeLessThan(15.5);
    // …and the same property at the small-N end, which is where the ramp SHAPE differs.
    // Measured on the production write path (ramp table in
    // tests/ups-cold-start-injection.test.mjs): a topical hit on a 3-row corpus reaches
    // |bm25| ≈ 5.1. The superseded ln(N+1)/ln(N_REF+1) ramp put the floor at 6.53 there
    // and silenced it; without this line the end-to-end suite is the only thing that
    // notices, and only at n=3 and n=4.
    const s3 = corpusFloorScale(open(3));
    expect(30 * s3).toBeLessThan(5.1);
  });

  it('returns 0 on an empty corpus — no floor, and nothing for it to gate', () => {
    // FTS5's max attainable IDF is 0 below two rows, so both floors collapse to 0.
    // Unreachable in effect: the two gates in main() are guarded by `ftsRows.length > 0`,
    // and an empty observations table produces no FTS rows. Asserted so a future change to
    // that guard is caught here. (This comment used to cite `ln(1)=0`, from the ramp that
    // v3.69.0 replaced.)
    const s = corpusFloorScale(open(0));
    expect(s).toBe(0);
    expect(Number.isFinite(s)).toBe(true);
  });

  it('treats a degenerate reference corpus as fully calibrated', async () => {
    // CLAUDE_MEM_UPS_FLOOR_REF_CORPUS=2 or 3 makes the REFERENCE's own max IDF 0 or near
    // it, so the ratio would divide by zero (or explode). The `!(refIdf > 0)` guard returns
    // 1 instead — same posture as the `FLOOR_REF_CORPUS <= 1` short-circuit. Deleting that
    // guard left the whole file green before this case existed.
    //
    // The cache-busting re-import below is now VESTIGIAL, and is kept only because it
    // is harmless: since v3.78.0 the implementation moved to lib/relevance-floor.mjs
    // and reads the reference corpus at CALL time, so setting the env would take effect
    // without any re-import. (It also would not work as advertised any more —
    // `?ref=2` re-executes this face, but its import of the lib module resolves to the
    // same cached instance, so `refTwo.corpusFloorScale` is the same function object.)
    // What still binds this case is the guard itself: both deleting `!(refIdf > 0)` and
    // re-freezing the reference at module load are killed by it.
    const saved = process.env.CLAUDE_MEM_UPS_FLOOR_REF_CORPUS;
    try {
      // Literal specifiers: Vite cannot analyse a template-literal dynamic import.
      //
      // The corpus size matters, twice over. The bounded `atRef` probe returns 1 as soon
      // as the corpus REACHES the reference, so the guard is only reachable BELOW it —
      // hence a 1-row corpus against REF=2. And the failure mode needs 0/0: with a large
      // corpus the ratio would be `maxIdf(c) / 0` = Infinity, and `Math.min(1, Infinity)`
      // is still 1, so the bug hides. At 0/0 it is NaN, which flows into
      // `TOP_REL_FLOOR * NaN` and makes every floor comparison false — both floors
      // silently off. That is the case worth pinning.
      process.env.CLAUDE_MEM_UPS_FLOOR_REF_CORPUS = '2';
      const refTwo = await import('../scripts/user-prompt-search.js?ref=2');
      const degenerate = refTwo.corpusFloorScale(open(1));
      expect(Number.isNaN(degenerate), 'scale went NaN — floors silently disabled').toBe(false);
      expect(degenerate, 'ref=2 with a 1-row corpus (0/0)').toBe(1);

      process.env.CLAUDE_MEM_UPS_FLOOR_REF_CORPUS = '3';
      const refThree = await import('../scripts/user-prompt-search.js?ref=3');
      expect(refThree.corpusFloorScale(open(10)), 'ref=3 (maxIdf near 0)').toBe(1);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_MEM_UPS_FLOOR_REF_CORPUS;
      else process.env.CLAUDE_MEM_UPS_FLOOR_REF_CORPUS = saved;
    }
  });

  it("fails safe to 1.0 (today's behavior) when the corpus probe throws", () => {
    const broken = {
      prepare() {
        throw new Error('no such table: observations');
      },
    };
    expect(corpusFloorScale(broken)).toBe(1);
  });

  it('never scans the whole table on a large corpus (bounded OFFSET probe)', () => {
    const db = open(2000);
    let sawCount = false;
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/count\(\*\)/i.test(sql)) sawCount = true;
      return realPrepare(sql);
    };
    expect(corpusFloorScale(db)).toBe(1);
    expect(sawCount, 'took the COUNT path on a large corpus').toBe(false);
  });
});
