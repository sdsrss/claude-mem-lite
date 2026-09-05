// P0 eval-coverage: non-Latin / multi-script retrieval guard for the benchmark
// harnesses. Motivation (2026-07-06 precision audit + the 2026-07-04 R1 HIGH):
// every benchmark fixture and the LongMemEval corpus are 100% ASCII/English, so a
// char-class / tokenizer / synonym-filter change that silently zeroes an entire
// non-Latin script (the emoji-filter allowlist regression: /[a-zA-Z0-9一-鿿]/
// dropped Cyrillic/Greek/Arabic/Hangul/Kana query text → all such search returned
// null) reads NEUTRAL on the A/B suites — "A/B NEUTRAL ≠ safe". These tests exercise
// the production query path (searchProductionHybrid → sanitizeFtsQuery) with one
// planted doc + query per script, so a re-introduction of that regression fails
// loudly instead of passing silently.
import { describe, it, expect } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { seedDatabase, searchProductionHybrid } from '../benchmark/benchmark.mjs';
import { runScriptGuard, MULTISCRIPT_FIXTURES } from '../benchmark/multiscript-guard.mjs';

// ─── P0-a: seedDatabase CJK fidelity ─────────────────────────────────────────
// The production write path stores `content + cjkBigrams(content)` in the FTS
// text column (lib/save-observation.mjs, hook-llm.mjs::buildFtsTextField), because
// this build's unicode61 tokenizer indexes a whole CJK run as ONE token while the
// query is reduced to overlapping bigrams. seedDatabase raw-inserted `text`, so a
// seeded CJK doc was a single un-queryable token — any CJK fixture built on it
// would measure a false zero (the #8826 trap: "build the corpus through the real
// save path before concluding a retrieval bug").
describe('seedDatabase CJK fidelity (mirrors production bigramming)', () => {
  it('makes a seeded CJK observation retrievable by a CJK query (among distractors)', () => {
    // Distractors matter: with a single-doc corpus the AND→OR relaxation surfaces
    // the lone candidate regardless of bigramming (a false pass). Real English
    // distractors force the CJK query to discriminate via the bigram index.
    const db = createTestDb();
    const distractor = (id, w) => ({
      id,
      project: 'mem',
      type: 'bugfix',
      title: `Fixed ${w} bug`,
      narrative: `Patched the ${w} handler`,
      text: `${w} handler patch fix`,
      concepts: w,
      facts: w,
      files_modified: '[]',
      importance: 2,
      epoch_offset_days: -1,
      session_id: 'sess-en',
    });
    // The CJK doc uses natural UNSEGMENTED text (no space-separated dict words that
    // would be findable without bigramming) — "死锁" is only reachable if
    // seedDatabase mirrors the production bigram index.
    seedDatabase(db, {
      observations: [
        {
          id: 9001,
          project: 'mem',
          type: 'bugfix',
          title: '数据库死锁修复',
          narrative: '修复了并发写入导致的数据库死锁问题',
          text: '数据库死锁问题排查并发事务回滚',
          concepts: '数据库死锁并发',
          facts: '死锁问题',
          files_modified: '[]',
          importance: 2,
          epoch_offset_days: -1,
          session_id: 'sess-cjk-1',
        },
        distractor(9010, 'auth'),
        distractor(9011, 'cache'),
        distractor(9012, 'router'),
        distractor(9013, 'parser'),
        distractor(9014, 'scheduler'),
      ],
    });
    const ids = searchProductionHybrid(db, '死锁').map((r) => r.id);
    expect(ids).toContain(9001);
    db.close();
  });

  it('leaves English seed text unchanged (cjkBigrams is empty for pure-Latin)', () => {
    const db = createTestDb();
    seedDatabase(db, {
      observations: [
        {
          id: 9002,
          project: 'mem',
          type: 'bugfix',
          title: 'Fixed race condition in scheduler',
          narrative: 'Added a mutex around the queue.',
          text: 'race condition mutex scheduler queue',
          concepts: 'concurrency',
          facts: 'mutex',
          files_modified: '[]',
          importance: 2,
          epoch_offset_days: -1,
          session_id: 'sess-en-1',
        },
      ],
    });
    const ids = searchProductionHybrid(db, 'race condition mutex').map((r) => r.id);
    expect(ids).toContain(9002);
    db.close();
  });
});

// ─── P0-b: multi-script retrieval guard ──────────────────────────────────────
describe('runScriptGuard (non-Latin regression gate)', () => {
  it('retrieves the planted doc for every covered script on current code', () => {
    const db = createTestDb();
    seedDatabase(db, { observations: MULTISCRIPT_FIXTURES.corpus });
    const report = runScriptGuard(db);
    db.close();

    // Every script must be covered and every planted doc retrievable. A char-class
    // regression that zeroes one script flips its `found` to false → this fails.
    expect(report.length).toBe(MULTISCRIPT_FIXTURES.queries.length);
    const failed = report.filter((r) => !r.found);
    expect(failed, `scripts returning zero results: ${failed.map((f) => f.script).join(', ')}`).toEqual([]);
  });

  it('has teeth: a query for absent content in a covered script reports found=false', () => {
    // Proves the guard discriminates found from not-found (not a tautology): seed the
    // corpus, then probe a well-formed CJK query whose content is NOT in any doc.
    const db = createTestDb();
    seedDatabase(db, { observations: MULTISCRIPT_FIXTURES.corpus });
    const report = runScriptGuard(db, {
      queries: [{ script: 'cjk-absent', query: '量子纠缠观测', expectId: 999999 }],
    });
    db.close();
    expect(report).toHaveLength(1);
    expect(report[0].found).toBe(false);
  });
});
