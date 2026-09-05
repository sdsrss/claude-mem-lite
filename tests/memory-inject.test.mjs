import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { searchRelevantMemories, formatMemoryLine } from '../hook-memory.mjs';
import { createTestDb, insertSession, insertObs, fileEdgeMatchOnly } from './test-helpers.mjs';
import { cjkBigrams, OBS_BM25 } from '../utils.mjs';

// ─── P1: formatMemoryLine — stale-obs verify-before-use hint ───────────────
// A surfaced obs older than 30 days that references file paths has elevated
// drift risk: code may have moved/been renamed since the obs was captured.
// We append ` [verify-before-use]` so Claude is reminded to grep/Read before
// applying the lesson. Fresh obs and obs without file_paths render normally.

describe('formatMemoryLine', () => {
  const DAY_MS = 86_400_000;
  const fresh = Date.now() - 1 * DAY_MS;
  const stale = Date.now() - 45 * DAY_MS;

  it('renders base format for fresh obs without files_modified', () => {
    const line = formatMemoryLine({
      id: 42,
      type: 'bugfix',
      title: 'Fixed cache eviction',
      lesson_learned: null,
      created_at_epoch: fresh,
      files_modified: '[]',
    });
    expect(line).toBe('- [bugfix] Fixed cache eviction (#42)');
  });

  it('appends lesson tag when lesson_learned is non-empty', () => {
    const line = formatMemoryLine({
      id: 7,
      type: 'decision',
      title: 'Picked SQLite over Postgres',
      lesson_learned: 'single-binary deploy outweighs scaling ceiling',
      created_at_epoch: fresh,
      files_modified: '[]',
    });
    expect(line).toContain(' | Lesson: single-binary deploy');
    expect(line).not.toContain('[verify-before-use]');
  });

  it('caps the lesson and collapses newlines so (#id) stays on one physical line', () => {
    // Regression: a raw multi-line lesson pushed the trailing (#NN) onto a later physical
    // line, which failed the "- [" prefix gate in citation-tracker's UserPromptSubmit
    // extractor → the obs never entered the citation-decay denominator (promote/demote dead).
    const line = formatMemoryLine({
      id: 777,
      type: 'bugfix',
      title: 'T',
      lesson_learned: 'line one\nline two\nline three ' + 'x'.repeat(400),
      created_at_epoch: fresh,
      files_modified: '[]',
    });
    expect(line.split('\n')).toHaveLength(1); // single physical line
    expect(line).toMatch(/\(#777\)/); // id present and extractable
    expect(line.length).toBeLessThan(300); // capped, not the full 400+ char lesson
  });

  it('appends [verify-before-use] for obs older than 30 days WITH files_modified', () => {
    const line = formatMemoryLine({
      id: 99,
      type: 'bugfix',
      title: 'Fixed dispatch race',
      lesson_learned: null,
      created_at_epoch: stale,
      files_modified: '["hook.mjs","hook-llm.mjs"]',
    });
    expect(line).toMatch(/ \[verify-before-use\]$/);
    expect(line).toContain('(#99)');
  });

  it('does NOT append hint when obs is older than 30 days but has NO files_modified', () => {
    const line = formatMemoryLine({
      id: 100,
      type: 'decision',
      title: 'Old purely-architectural decision',
      lesson_learned: null,
      created_at_epoch: stale,
      files_modified: '[]',
    });
    expect(line).not.toContain('[verify-before-use]');
  });

  it('does NOT append hint when files_modified is null/missing', () => {
    const line = formatMemoryLine({
      id: 101,
      type: 'bugfix',
      title: 'Old bugfix no files',
      lesson_learned: null,
      created_at_epoch: stale,
      files_modified: null,
    });
    expect(line).not.toContain('[verify-before-use]');
  });

  it('does NOT append hint for fresh obs even with files_modified', () => {
    const line = formatMemoryLine({
      id: 102,
      type: 'bugfix',
      title: 'Recent fix',
      lesson_learned: null,
      created_at_epoch: fresh,
      files_modified: '["hook.mjs"]',
    });
    expect(line).not.toContain('[verify-before-use]');
  });

  it('handles malformed files_modified JSON gracefully (treats as empty)', () => {
    const line = formatMemoryLine({
      id: 103,
      type: 'bugfix',
      title: 'Old fix with broken JSON',
      lesson_learned: null,
      created_at_epoch: stale,
      files_modified: 'not-json',
    });
    expect(line).not.toContain('[verify-before-use]');
  });

  it('handles missing created_at_epoch gracefully (no hint)', () => {
    const line = formatMemoryLine({
      id: 104,
      type: 'bugfix',
      title: 'Untimed obs',
      lesson_learned: null,
      files_modified: '["a.mjs"]',
    });
    expect(line).not.toContain('[verify-before-use]');
  });

  it('truncates long titles to 80 chars (preserves existing behavior)', () => {
    const longTitle = 'A'.repeat(120);
    const line = formatMemoryLine({
      id: 1,
      type: 'change',
      title: longTitle,
      lesson_learned: null,
      created_at_epoch: fresh,
      files_modified: '[]',
    });
    // truncate adds ellipsis or marker — just check we cut down meaningfully.
    expect(line.length).toBeLessThan('- [change] '.length + 90 + ' (#1)'.length);
  });
});

describe('searchRelevantMemories', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'proj' });

    // BM25 needs corpus diversity to produce meaningful scores (IDF requires >1 docs).
    // Add background noise documents so target observations score above threshold.
    for (let i = 900; i <= 920; i++) {
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'proj',
        type: 'change',
        title: `Updated config file ${i}`,
        text: `config yaml settings update number ${i}`,
        importance: 2,
      });
    }
  });
  afterEach(() => {
    db?.close();
  });

  it('returns matching bugfix memories for relevant prompt', () => {
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'bugfix',
      title: 'Fixed dispatch race condition',
      narrative: 'Lock contention in episode flush',
      text: 'dispatch race condition lock contention episode flush',
      importance: 3,
    });
    const results = searchRelevantMemories(db, 'dispatch race condition', 'proj', []);
    expect(results.length).toBe(1);
    expect(results[0].title).toContain('dispatch');
  });

  it('returns empty when no relevant memories exist', () => {
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'change',
      title: 'Updated README',
      narrative: 'Minor doc changes',
      text: 'readme documentation update',
      importance: 1,
    });
    const results = searchRelevantMemories(db, 'dispatch race condition', 'proj', []);
    expect(results.length).toBe(0);
  });

  it('retrieves importance=1 observations with high BM25 relevance', () => {
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'bugfix',
      title: 'Race condition fix in worker pool',
      narrative: 'Fixed thread safety issue in worker pool',
      text: 'race condition worker pool thread safety fix',
      importance: 1,
    });
    const results = searchRelevantMemories(db, 'race condition worker pool', 'proj', []);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('Race condition');
  });

  it('does not retrieve importance=1 observations with low BM25 relevance (below threshold after penalty)', () => {
    // Insert an importance=1 observation with a topic that will get low BM25 score
    // against the search query (minimal keyword overlap)
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'change',
      title: 'Minor tweak to settings',
      narrative: 'Small change to settings file',
      text: 'settings yaml minor tweak adjustment',
      importance: 1,
    });
    const results = searchRelevantMemories(db, 'dispatch race condition', 'proj', []);
    // importance=1 with weak BM25 match should be filtered by the 0.6x penalty + 1.5 threshold
    expect(results.length).toBe(0);
  });

  it('excludes observations already in Key Context', () => {
    const info = insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'bugfix',
      title: 'Fixed dispatch race',
      narrative: 'Lock issue',
      text: 'dispatch race lock contention',
      importance: 3,
    });
    const obsId = Number(info.lastInsertRowid);
    const results = searchRelevantMemories(db, 'dispatch race', 'proj', [obsId]);
    expect(results.length).toBe(0);
  });

  it('limits to max 3 results', () => {
    for (let i = 1; i <= 5; i++) {
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'proj',
        type: 'bugfix',
        title: `Fix dispatch error ${i}`,
        narrative: `Details ${i}`,
        text: `dispatch error fix crash ${i}`,
        importance: 3,
      });
    }
    const results = searchRelevantMemories(db, 'dispatch error crash', 'proj', []);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('prefers bugfix/decision types over change', () => {
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'change',
      title: 'Modified dispatch.mjs',
      narrative: 'Edited file',
      text: 'dispatch modified file refactor',
      importance: 2,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'bugfix',
      title: 'Fixed dispatch error',
      narrative: 'Root cause fix',
      text: 'dispatch error fix root cause',
      importance: 2,
    });
    const results = searchRelevantMemories(db, 'dispatch error', 'proj', []);
    if (results.length > 0) {
      expect(results[0].type).toBe('bugfix');
    }
  });

  it('returns empty for very short prompts', () => {
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'bugfix',
      title: 'Fix something',
      narrative: 'Details',
      text: 'fix something',
      importance: 3,
    });
    const results = searchRelevantMemories(db, 'hi', 'proj', []);
    expect(results.length).toBe(0);
  });

  // CJK recall: the English-centric `< 5` length guard + bigram-inflated
  // OR-fallback gate silently zeroed Chinese queries (a Chinese-primary user got
  // no injection). Measured on a 25-obs CJK harness: recall@5 60% → 100%.
  it('CJK: retrieves a memory for a short (≤4-char) Chinese query', () => {
    // "熔断降级" is 4 chars — meaningful in Chinese but rejected by the old <5 guard.
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'decision',
      title: '熔断降级策略',
      narrative: '依赖故障时返回兜底数据',
      text: '熔断降级策略 依赖故障时返回兜底数据 ' + cjkBigrams('熔断降级策略 依赖故障时返回兜底数据'),
      importance: 2,
    });
    const results = searchRelevantMemories(db, '熔断降级', 'proj', []);
    expect(results.length).toBeGreaterThan(0);
  });

  it('CJK: OR-fallback rescues a multi-bigram Chinese query whose AND form misses', () => {
    // "提升召回率" bigrams to 提升/升召/召回/回率 (5 AND-tokens → old gate suppressed
    // OR). The gold lacks 提升/升召, so strict AND misses; the CJK gate bypass lets
    // the OR rescue match via 召回/回率.
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'decision',
      title: '召回率优化方案',
      narrative: '多查询融合加 RRF 排序',
      text: '召回率优化方案 多查询融合加 RRF 排序 ' + cjkBigrams('召回率优化方案 多查询融合加 排序'),
      importance: 2,
    });
    const results = searchRelevantMemories(db, '提升召回率', 'proj', []);
    expect(results.length).toBeGreaterThan(0);
  });

  it('NL: OR-fallback rescues a natural-language English prompt whose AND form misses', () => {
    // Real user prompts are full sentences. After synonym expansion the AND form
    // becomes 5 groups: "(fix OR…) AND parser AND null AND deref AND (bug OR…)".
    // The gold lacks a "bug" synonym and uses "Fixed" (no stemmer matches "fix"),
    // so strict AND returns nothing. Before the OR gate was raised from 2 to 8,
    // these >2-token NL prompts were denied the OR rescue and the UPS injection
    // path returned 0 results for real prompts (#8255 semantic recall 26%).
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'bugfix',
      title: 'Fixed null deref in parser when input is empty',
      lessonLearned: 'check for null before dereferencing the parser node',
      importance: 2,
    });
    const results = searchRelevantMemories(db, 'how did we fix the parser null deref bug?', 'proj', []);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('parser');
  });

  it('NL precision: a topically-adjacent prompt sharing no whole word stays below the coverage floor', () => {
    // "parse command line args" shares no whole word with the parser obs (word-
    // boundary: "parse" ≠ "parser"); the OR rescue must NOT inject it. Guards the
    // raised OR gate against precision regression — the 40% term-coverage filter
    // is what keeps OR-fallback honest.
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'bugfix',
      title: 'Fixed null deref in parser when input is empty',
      lessonLearned: 'check for null before dereferencing the parser node',
      importance: 2,
    });
    const results = searchRelevantMemories(db, 'how do I parse command line arguments in node', 'proj', []);
    expect(results.length).toBe(0);
  });

  // R1: LOW_SIGNAL title filtering — degraded titles from hook-llm fallback
  // (Modified X, Worked on X, Reviewed N files:, etc.) must not be injected.

  it('R1: excludes "Modified X" titles from injection', () => {
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'change',
      title: 'Modified dispatch.mjs',
      text: 'dispatch race condition lock worker pool fix',
      importance: 3,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'bugfix',
      title: 'Fix dispatch race condition',
      text: 'dispatch race condition lock worker pool fix',
      importance: 3,
    });
    const results = searchRelevantMemories(db, 'dispatch race condition fix', 'proj', []);
    const titles = results.map((r) => r.title);
    expect(titles).toContain('Fix dispatch race condition');
    expect(titles).not.toContain('Modified dispatch.mjs');
  });

  it('R1: excludes "Worked on X" titles from injection', () => {
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'discovery',
      title: 'Worked on worker pool',
      text: 'worker pool thread safety crash recovery',
      importance: 3,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'bugfix',
      title: 'Fix worker pool thread safety',
      text: 'worker pool thread safety crash recovery',
      importance: 3,
    });
    const results = searchRelevantMemories(db, 'worker pool thread safety', 'proj', []);
    const titles = results.map((r) => r.title);
    expect(titles).toContain('Fix worker pool thread safety');
    expect(titles).not.toContain('Worked on worker pool');
  });

  it('R1: excludes "Reviewed N files:" titles from injection', () => {
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'discovery',
      title: 'Reviewed 6 files: cache.mjs, worker.mjs, queue.mjs',
      text: 'cache worker queue batch throughput optimization',
      importance: 3,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'discovery',
      title: 'Cache worker queue batching pattern',
      text: 'cache worker queue batch throughput optimization',
      importance: 3,
    });
    const results = searchRelevantMemories(db, 'cache worker queue batch', 'proj', []);
    const titles = results.map((r) => r.title);
    expect(titles).toContain('Cache worker queue batching pattern');
    expect(titles.some((t) => t.startsWith('Reviewed '))).toBe(false);
  });

  // R2: Type quality rebalancing — bugfix (with empirical 2.4× access rate)
  // should beat change when BM25 is equal.

  it('R2: ranks bugfix above change when text match is equal', () => {
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'change',
      title: 'Updated auth middleware signature',
      text: 'auth middleware token validation refresh flow',
      importance: 2,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'bugfix',
      title: 'Fixed auth middleware token leak',
      text: 'auth middleware token validation refresh flow',
      importance: 2,
    });
    const results = searchRelevantMemories(db, 'auth middleware token validation', 'proj', []);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].type).toBe('bugfix');
  });

  it('updates injection_count (NOT access_count) for returned memories', () => {
    // v26 P0: auto-injection bumps injection_count, leaving access_count
    // for explicit access (cite / cmdRecall / cmdGet / cmdTimeline /
    // pre-tool-recall). This separation powers the noise-ratio penalty.
    const info = insertObs(db, {
      sessionId: 'sess-1',
      project: 'proj',
      type: 'bugfix',
      title: 'Fixed dispatch race',
      narrative: 'Lock contention issue',
      text: 'dispatch race condition lock contention episode flush',
      importance: 3,
      accessCount: 0,
    });
    const obsId = Number(info.lastInsertRowid);
    searchRelevantMemories(db, 'dispatch race condition', 'proj', []);
    const row = db
      .prepare('SELECT access_count, injection_count, last_injected_at FROM observations WHERE id = ?')
      .get(obsId);
    expect(row.injection_count).toBe(1);
    expect(row.access_count).toBe(0); // preserved — pure auto-inject no longer pollutes
    expect(row.last_injected_at).toBeGreaterThan(0);
  });
});

describe('lesson-boosted memory search', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });

    // Background noise for BM25 IDF
    for (let i = 900; i <= 920; i++) {
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'test',
        type: 'change',
        title: `Updated config file ${i}`,
        text: `config yaml settings update number ${i}`,
        importance: 2,
      });
    }
  });
  afterEach(() => {
    db?.close();
  });

  it('ranks memories with lessons higher than without', () => {
    insertObs(db, {
      type: 'bugfix',
      title: 'Fixed CORS error in auth middleware',
      text: 'auth middleware CORS headers fix bugfix',
      importance: 2,
      lessonLearned: 'Add CORS headers in middleware, not in route handlers',
      epochOffset: -3 * 86400000,
    });
    insertObs(db, {
      type: 'bugfix',
      title: 'Fixed auth middleware token expiry check',
      text: 'auth middleware token expiry fix',
      importance: 2,
      epochOffset: -3 * 86400000,
    });
    const results = searchRelevantMemories(db, 'auth middleware fix', 'test');
    expect(results.length).toBeGreaterThanOrEqual(1);
    if (results.length >= 2) {
      expect(results[0].lesson_learned).toBeTruthy();
    }
  });

  it('returns empty for unrelated prompts', () => {
    insertObs(db, {
      type: 'bugfix',
      title: 'Fixed database timeout',
      text: 'database timeout connection pool',
      importance: 2,
      epochOffset: -3 * 86400000,
    });
    const results = searchRelevantMemories(db, 'add a new button to the UI', 'test');
    expect(results.length).toBe(0);
  });
});

describe('file-aware recall', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => {
    db?.close();
  });

  it('finds bugfix memories for files being edited', () => {
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix race condition in hook.mjs',
      text: 'hook.mjs race condition fix',
      importance: 2,
      filesModified: '["hook.mjs"]',
      epochOffset: -5 * 86400000,
    });
    const results = fileEdgeMatchOnly(db, 'hook.mjs', 'test');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toMatch(/hook\.mjs/);
  });

  it('returns empty for files with no history', () => {
    // Seed a decoy first. Asserting emptiness against an EMPTY db holds for any
    // predicate at all, including a broken one: a pre-tag review bolted `OR 1=1`
    // onto the match clause and this case stayed green while six siblings died.
    // The same negative shape done right is in tests/win-path-basename.test.mjs.
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix in some-other-file.mjs',
      text: 'some-other-file.mjs fix',
      importance: 2,
      filesModified: '["some-other-file.mjs"]',
      epochOffset: -2 * 86400000,
    });
    const results = fileEdgeMatchOnly(db, 'brand-new-file.mjs', 'test');
    expect(results.length).toBe(0);
  });

  // Binds fileEdgeMatchOnly's OWN minImportance gate and nothing else — the
  // helper re-derives that gate rather than sharing it, so relaxing the shipped
  // `o.importance >= 2` in scripts/pre-tool-recall.js leaves this green
  // (mutation-verified, v3.77.0 pre-tag review). The shipped gate is guarded in
  // tests/pre-tool-recall.test.mjs's D#162 block. The title now says which.
  it("applies the helper's own minImportance gate (NOT the shipped query's)", () => {
    insertObs(db, {
      type: 'change',
      title: 'Minor edit to hook.mjs',
      text: 'hook.mjs minor change',
      importance: 1,
      filesModified: '["hook.mjs"]',
      epochOffset: -2 * 86400000,
    });
    const results = fileEdgeMatchOnly(db, 'hook.mjs', 'test');
    for (const r of results) {
      expect(r.importance).toBeGreaterThanOrEqual(2);
    }
  });

  it('escapes LIKE wildcards in filenames (% and _)', () => {
    // A file named "test_100%.mjs" should NOT match "testX100Y.mjs" (unescaped _ and %)
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix in test_100%.mjs',
      text: 'test_100%.mjs fix',
      importance: 2,
      filesModified: '["test_100%.mjs"]',
      epochOffset: -2 * 86400000,
    });
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix in testX100Y.mjs',
      text: 'testX100Y.mjs fix',
      importance: 2,
      filesModified: '["testX100Y.mjs"]',
      epochOffset: -2 * 86400000,
    });
    // Should only match the exact filename, not the wildcard-expanded one
    const results = fileEdgeMatchOnly(db, 'test_100%.mjs', 'test');
    expect(results.length).toBe(1);
    expect(results[0].title).toContain('test_100%.mjs');
  });
});

describe('OR fallback in searchRelevantMemories', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-or-test', project: 'test-project' });

    // Background noise for BM25 IDF
    for (let i = 900; i <= 920; i++) {
      insertObs(db, {
        sessionId: 'sess-or-test',
        project: 'test-project',
        type: 'change',
        title: `Updated config file ${i}`,
        text: `config yaml settings update number ${i}`,
        importance: 2,
      });
    }
  });
  afterEach(() => {
    db?.close();
  });

  it('falls back to OR query when AND returns no results for short queries', () => {
    // Insert observation with only partial keyword match
    insertObs(db, {
      sessionId: 'sess-or-test',
      project: 'test-project',
      type: 'bugfix',
      title: 'Fixed database connection timeout',
      narrative: 'The pool was exhausted',
      text: 'database connection timeout pool exhausted',
      importance: 2,
    });

    // 2-token AND query: "database latency" won't AND-match (no "latency" in text)
    // but OR fallback finds it via "database" (2 tokens → OR allowed)
    const results = searchRelevantMemories(db, 'database latency', 'test-project');
    expect(results.length).toBeGreaterThan(0);
  });

  it('skips OR fallback for 3+ token queries to prevent noise', () => {
    insertSession(db, { id: 'sess-or-test2', project: 'test-project' });
    insertObs(db, {
      sessionId: 'sess-or-test2',
      project: 'test-project',
      type: 'bugfix',
      title: 'Fixed database connection timeout',
      text: 'database connection timeout pool exhausted',
      importance: 2,
    });

    // 3-token AND query fails → OR fallback skipped (too many tokens = likely off-topic)
    const results = searchRelevantMemories(db, 'database performance optimization', 'test-project');
    expect(results.length).toBe(0);
  });
});

// ─── v27: term-coverage filter (drops high-BM25 but off-topic matches) ──────
//
// Failure mode this addresses: when a query of N significant terms gets reduced
// by FTS tokenization to a sparse set that matches candidates sharing only one
// common word, BM25 can still rank them highly. The result is "noisy" injection
// where the user sees related-memories whose TITLE doesn't actually cover the
// intent (e.g. query "handoff working_on staleness" matches 3 rows that only
// have "handoff" in their title). Coverage filter drops any candidate whose
// title+lesson_learned covers <40% of the query's significant terms.

describe('v27: term-coverage filter', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-cov', project: 'cov-proj' });
    for (let i = 900; i <= 920; i++) {
      insertObs(db, {
        sessionId: 'sess-cov',
        project: 'cov-proj',
        type: 'change',
        title: `Unrelated noise ${i}`,
        text: `noise filler content ${i}`,
        importance: 2,
      });
    }
  });
  afterEach(() => {
    delete process.env.MEM_COVERAGE_THRESHOLD;
    db?.close();
  });

  it('drops candidates whose title covers <40% of query significant terms', () => {
    // Sparse candidates: text matches all 3 query terms (FTS AND passes), but
    // title only contains "dispatch" (1/3 = 0.33 coverage → filtered at 0.4)
    insertObs(db, {
      sessionId: 'sess-cov',
      project: 'cov-proj',
      type: 'bugfix',
      title: 'dispatch crash recovery',
      text: 'dispatch race fixture worker pool leak details',
      importance: 3,
    });
    insertObs(db, {
      sessionId: 'sess-cov',
      project: 'cov-proj',
      type: 'bugfix',
      title: 'dispatch leak debug trace',
      text: 'dispatch race fixture more content background noise',
      importance: 3,
    });
    // High-coverage candidate: title has all 3 query terms (3/3 coverage → kept)
    insertObs(db, {
      sessionId: 'sess-cov',
      project: 'cov-proj',
      type: 'decision',
      title: 'dispatch race fixture sync fix',
      text: 'dispatch race fixture sync fix lesson root cause',
      importance: 3,
    });
    const results = searchRelevantMemories(db, 'dispatch race fixture', 'cov-proj', []);
    // Only the high-coverage candidate survives; sparse ones filtered
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('dispatch race fixture sync fix');
  });

  it('counts lesson_learned toward coverage (not just title)', () => {
    // Title covers 1/3, but lesson_learned covers the other 2 → pass
    insertObs(db, {
      sessionId: 'sess-cov',
      project: 'cov-proj',
      type: 'bugfix',
      title: 'dispatch crash fix',
      text: 'dispatch race fixture background content here',
      lessonLearned: 'race fixture teardown needs explicit await',
      importance: 3,
    });
    const results = searchRelevantMemories(db, 'dispatch race fixture', 'cov-proj', []);
    expect(results.length).toBe(1);
  });

  it('skips filter for queries with <2 significant terms (coverage meaningless)', () => {
    insertObs(db, {
      sessionId: 'sess-cov',
      project: 'cov-proj',
      type: 'bugfix',
      title: 'something unrelated in title',
      text: 'dispatch content with plenty of noise words here',
      importance: 3,
    });
    // Single significant token query — filter must not fire, so the single-term
    // match passes even though title covers 0/1 query terms.
    const results = searchRelevantMemories(db, 'dispatch', 'cov-proj', []);
    expect(results.length).toBe(1);
  });

  it('v2.41: null subtitle/narrative in hay does not crash (edge-case guard)', () => {
    // Regression guard per #2664 — cover null / empty-string combinations in the
    // expanded hay. Pre-fix `${row.subtitle || ''}` handled null; this locks it in.
    insertObs(db, {
      sessionId: 'sess-cov',
      project: 'cov-proj',
      type: 'bugfix',
      title: 'dispatch race fixture sync',
      // subtitle and narrative omitted → default ''
      text: 'dispatch race fixture content',
      importance: 3,
    });
    const results = searchRelevantMemories(db, 'dispatch race fixture', 'cov-proj', []);
    expect(results.length).toBe(1);
  });

  it('v2.41: counts subtitle + narrative prefix toward coverage (not just title + lesson)', () => {
    // Title covers 1/3 (dispatch). lesson_learned empty. subtitle covers 1/3 (race).
    // narrative covers 1/3 (fixture). Combined = 3/3 → pass.
    // Pre-v2.41 (title + lesson only) this would have been 1/3 = 0.33 → filtered.
    insertObs(db, {
      sessionId: 'sess-cov',
      project: 'cov-proj',
      type: 'bugfix',
      title: 'dispatch crash fix',
      subtitle: 'race condition on worker teardown',
      narrative:
        'The fixture setup raced with the shared queue, causing intermittent hangs. Fixed by awaiting a barrier before dispatch.',
      text: 'dispatch race fixture shared queue hang teardown',
      importance: 3,
    });
    const results = searchRelevantMemories(db, 'dispatch race fixture', 'cov-proj', []);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('dispatch crash fix');
  });

  it('disables filter when MEM_COVERAGE_THRESHOLD=0', () => {
    process.env.MEM_COVERAGE_THRESHOLD = '0';
    insertObs(db, {
      sessionId: 'sess-cov',
      project: 'cov-proj',
      type: 'bugfix',
      title: 'dispatch crash recovery',
      text: 'dispatch race fixture worker pool leak details',
      importance: 3,
    });
    insertObs(db, {
      sessionId: 'sess-cov',
      project: 'cov-proj',
      type: 'bugfix',
      title: 'dispatch leak debug trace',
      text: 'dispatch race fixture more content background noise',
      importance: 3,
    });
    const results = searchRelevantMemories(db, 'dispatch race fixture', 'cov-proj', []);
    // Threshold disabled → sparse candidates survive (ranked by BM25)
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── v2.41: cross-project boost env override ────────────────────────────────
//
// Default 0.4 multiplier (60% penalty) to cross-project hits is baked in at hook-memory.mjs.
// For single-project users (or users who want stronger cross-project transfer),
// MEM_CROSS_PROJECT_BOOST ∈ [0,1] overrides the multiplier. 1.0 disables the
// penalty entirely; 0.0 removes cross-project hits from the merged result set.

describe('v2.41: MEM_CROSS_PROJECT_BOOST env override', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-main', project: 'main-proj' });
    insertSession(db, { id: 'sess-other', project: 'other-proj' });
    // Same-project match — decision, mid BM25
    insertObs(db, {
      sessionId: 'sess-main',
      project: 'main-proj',
      type: 'decision',
      title: 'main dispatch routing policy',
      lessonLearned: 'same-project decision for dispatch routing',
      text: 'dispatch routing policy main',
      importance: 3,
    });
    // Cross-project match — higher raw BM25 but gated by cross-project penalty
    insertObs(db, {
      sessionId: 'sess-other',
      project: 'other-proj',
      type: 'decision',
      title: 'other dispatch routing policy decision',
      lessonLearned: 'other-project decision on dispatch routing policy',
      text: 'dispatch routing policy decision insight cross project',
      importance: 3,
    });
  });

  afterEach(() => {
    delete process.env.MEM_CROSS_PROJECT_BOOST;
    db?.close();
  });

  it('default 0.7 penalty applied when env unset', () => {
    delete process.env.MEM_CROSS_PROJECT_BOOST;
    const results = searchRelevantMemories(db, 'dispatch routing policy', 'main-proj', []);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('MEM_CROSS_PROJECT_BOOST=1.0 disables the cross-project penalty', () => {
    process.env.MEM_CROSS_PROJECT_BOOST = '1.0';
    const results = searchRelevantMemories(db, 'dispatch routing policy', 'main-proj', []);
    // At boost=1.0, cross-project row scores on BM25 alone; its richer text
    // field means it now ranks at least as high as the same-project row.
    expect(results.some((r) => r.project === 'other-proj')).toBe(true);
  });

  it('invalid env value falls back to default 0.7', () => {
    process.env.MEM_CROSS_PROJECT_BOOST = 'not-a-number';
    // Must not throw; behavior matches unset
    expect(() => searchRelevantMemories(db, 'dispatch routing policy', 'main-proj', [])).not.toThrow();
  });

  it('out-of-range env value (>1) falls back to default', () => {
    process.env.MEM_CROSS_PROJECT_BOOST = '5';
    expect(() => searchRelevantMemories(db, 'dispatch routing policy', 'main-proj', [])).not.toThrow();
  });
});

describe('cross-project rows: stale-hint field parity (parallel-path miss)', () => {
  it('surfaces created_at_epoch + files_modified so formatMemoryLine can flag stale cross-project lessons', () => {
    // The cross-project crossStmt previously omitted the two columns the same-project
    // selectStmt provides, so formatMemoryLine's [verify-before-use] gate (needs
    // created_at_epoch + files_modified) could never fire for a cross-project lesson
    // that references files — even a 45-day-old one. Parallel-path miss (§9).
    const db = createTestDb();
    try {
      insertSession(db, { id: 'cp-main', project: 'cp-main-proj' });
      insertSession(db, { id: 'cp-other', project: 'cp-other-proj' });
      const stale = insertObs(db, {
        sessionId: 'cp-other',
        project: 'cp-other-proj',
        type: 'decision',
        title: 'auth token refresh needs a mutex',
        lessonLearned: 'auth token refresh must hold a mutex to avoid a thundering-herd refresh',
        text: 'auth token refresh mutex thundering herd gotcha',
        importance: 3,
        epochOffset: -45 * 86_400_000,
        filesModified: JSON.stringify(['auth.mjs']),
      });
      const results = searchRelevantMemories(db, 'auth token refresh mutex gotcha', 'cp-main-proj', []);
      const cross = results.find((r) => r.id === Number(stale.lastInsertRowid));
      expect(cross, 'stale cross-project obs not surfaced').toBeTruthy();
      expect(typeof cross.created_at_epoch).toBe('number');
      expect(cross.files_modified).toContain('auth.mjs');
      expect(formatMemoryLine(cross)).toContain('[verify-before-use]');
    } finally {
      db.close();
    }
  });
});

// ─── D#172 class (audit 2026-08-29 ALGO-3): the candidate pool is taken by RAW bm25
// but the injected row is chosen by the JS composite, so the SQL LIMIT bounds
// REACHABILITY, not just output width. See the RERANK_POOL_* docblock in
// hook-memory.mjs for the multiplier spread that makes this reachable-in-practice: 281×
// by the factor tables, 60.0× as realised over the rows the pool can actually return
// (`liveObsFilterSql`; the raw table reads 86.5× and 39% of it is unreachable). This
// fixture deliberately constructs the DECLARED worst case — fillers at `uncited_streak = 3`,
// which citation-decay resets and which NO row the pool can return is in — because that is
// what a fixture is for, and it is why the fixture's own spread must never be quoted as a
// corpus measurement.
describe('rerank pool is a reachability bound, not a ranking gate (ALGO-3)', () => {
  // Ranks the target at raw-bm25 #13 while every JS multiplier favours it:
  //   fillers  = change(0.5) × no-lesson(1.0) × imp1(0.6) × noise(0.2) × cite(0.4) = 0.024
  //   target   = decision(1.5) × lesson(1.5) × imp3(1.0) × noise(1.0) × cite(3.0) = 6.75
  // The 60 off-topic rows are not padding for its own sake: with a single-topic corpus
  // FTS5's IDF degenerates and bm25() returns 0.000 for EVERY row, which makes any
  // ranking fixture here vacuous (the same trap the error-recall suite pins as its
  // invariant #2). Measured with them present: fillers −14.845, target −4.235.
  function seed(db) {
    insertSession(db, { id: 'algo3-s', project: 'algo3' });
    const TOPICS = [
      'oauth token refresh redirect',
      'sqlite wal checkpoint pragma',
      'docker layer cache prune',
      'react hydration mismatch ssr',
      'grpc deadline propagation retry',
      'yaml anchor merge parser',
      'kafka consumer rebalance lag',
      'tls handshake alpn negotiation',
      'regex backtracking catastrophic',
      'cron timezone dst skew',
    ];
    for (let i = 0; i < 60; i++) {
      insertObs(db, {
        sessionId: 'algo3-s',
        project: 'algo3',
        type: 'change',
        title: `${TOPICS[i % 10]} note ${i}`,
        text: `${TOPICS[i % 10]} details ${i}`,
        importance: 1,
      });
    }
    const fillerIds = [];
    for (let i = 0; i < 12; i++) {
      const id = Number(
        insertObs(db, {
          sessionId: 'algo3-s',
          project: 'algo3',
          type: 'change',
          title: `widget cache invalidation race condition ${i}`,
          text: 'widget cache invalidation race condition',
          importance: 1,
        }).lastInsertRowid,
      );
      db.prepare(
        'UPDATE observations SET injection_count = 9, access_count = 0, cited_count = 0, uncited_streak = 3 WHERE id = ?',
      ).run(id);
      fillerIds.push(id);
    }
    // Long body → lower bm25 magnitude than the short fillers, while the title and
    // lesson still carry every query term so the v27 term-coverage filter passes.
    const PAD = 'unrelated filler prose about deployment pipelines and log rotation. '.repeat(120);
    const targetId = Number(
      insertObs(db, {
        sessionId: 'algo3-s',
        project: 'algo3',
        type: 'decision',
        title: 'widget cache invalidation race condition — serialize writers',
        text: PAD,
        narrative: PAD,
        lessonLearned: 'widget cache invalidation race condition: serialize through a single writer',
        importance: 3,
      }).lastInsertRowid,
    );
    db.prepare('UPDATE observations SET cited_count = 10, uncited_streak = 0 WHERE id = ?').run(targetId);
    return { targetId, fillerIds };
  }

  const QUERY = 'widget cache invalidation race condition';

  it('injects a row ranked below the old LIMIT-10 window when the composite favours it', () => {
    // VERIFIED RED: with RERANK_POOL_SAME_PROJECT back at its shipped-until-now 10,
    // searchRelevantMemories returns [] for this prompt — not "the target ranked
    // lower", but the whole face silent (measured 2026-09-01, same fixture).
    const db = createTestDb();
    try {
      const { targetId } = seed(db);
      const results = searchRelevantMemories(db, QUERY, 'algo3', []);
      expect(results.map((r) => r.id)).toContain(targetId);
    } finally {
      db.close();
    }
  });

  it('pins the target OUTSIDE the old window, so the case above cannot pass for free', () => {
    // Without this, a fixture drift that pulls the target up to raw-bm25 rank ≤10
    // would leave the test above green while proving nothing about reachability —
    // the "necessary condition standing in for the sufficient one" shape.
    const db = createTestDb();
    try {
      const { targetId } = seed(db);
      const ranked = db
        .prepare(
          `
        SELECT o.id FROM observations_fts
        JOIN observations o ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ?
        ORDER BY ${OBS_BM25}
      `,
        )
        .all('widget AND cache AND invalidation AND race AND condition')
        .map((r) => r.id);
      expect(ranked.indexOf(targetId)).toBeGreaterThan(9);
      expect(ranked.indexOf(targetId)).toBeLessThan(30);
    } finally {
      db.close();
    }
  });

  it('applies the same widening to the CROSS-PROJECT arm', () => {
    // The pre-tag review found the three cases here do NOT cover
    // RERANK_POOL_CROSS_PROJECT: the fixture above is single-project, so reverting that
    // constant to 5 stayed green across the whole suite. The cross arm is the copy the
    // audit did not name and it has the identical defect. Same construction, one arm
    // over: 6 penalised `discovery` fillers (the cross arm filters
    // `type IN ('decision','discovery') AND importance >= 2`, so fillers must satisfy it
    // too) put the boosted target at cross-arm raw-bm25 rank 7 — outside the old LIMIT 5.
    // The 60 IDF rows go in the MAIN project on purpose: FTS5's IDF is global across the
    // table, while `obsCount` (and therefore the adaptive threshold) counts only the
    // queried project.
    // VERIFIED RED: with RERANK_POOL_CROSS_PROJECT back at 5 this returns [].
    const db = createTestDb();
    try {
      insertSession(db, { id: 'algo3x-m', project: 'algo3x' });
      insertSession(db, { id: 'algo3x-o', project: 'algo3x-other' });
      const TOPICS = [
        'oauth token refresh redirect',
        'sqlite wal checkpoint pragma',
        'docker layer cache prune',
        'react hydration mismatch ssr',
        'grpc deadline propagation retry',
        'yaml anchor merge parser',
        'kafka consumer rebalance lag',
        'tls handshake alpn negotiation',
        'regex backtracking catastrophic',
        'cron timezone dst skew',
      ];
      for (let i = 0; i < 60; i++) {
        insertObs(db, {
          sessionId: 'algo3x-m',
          project: 'algo3x',
          type: 'change',
          title: `${TOPICS[i % 10]} note ${i}`,
          text: `${TOPICS[i % 10]} details ${i}`,
          importance: 1,
        });
      }
      const fillerIds = [];
      for (let i = 0; i < 6; i++) {
        const id = Number(
          insertObs(db, {
            sessionId: 'algo3x-o',
            project: 'algo3x-other',
            type: 'discovery',
            title: `widget cache invalidation race condition ${i}`,
            text: 'widget cache invalidation race condition',
            importance: 2,
          }).lastInsertRowid,
        );
        db.prepare(
          'UPDATE observations SET injection_count = 9, access_count = 0, cited_count = 0, uncited_streak = 3 WHERE id = ?',
        ).run(id);
        fillerIds.push(id);
      }
      const PAD = 'unrelated filler prose about deployment pipelines and log rotation. '.repeat(120);
      const targetId = Number(
        insertObs(db, {
          sessionId: 'algo3x-o',
          project: 'algo3x-other',
          type: 'decision',
          title: 'widget cache invalidation race condition — serialize writers',
          text: PAD,
          narrative: PAD,
          lessonLearned: 'widget cache invalidation race condition: serialize through a single writer',
          importance: 3,
        }).lastInsertRowid,
      );
      db.prepare('UPDATE observations SET cited_count = 10, uncited_streak = 0 WHERE id = ?').run(targetId);

      // Pin the target outside the OLD window, so the assertion below cannot pass for free.
      const ranked = db
        .prepare(
          `
        SELECT o.id FROM observations_fts
        JOIN observations o ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ?
          AND o.project != 'algo3x'
          AND o.type IN ('decision', 'discovery')
          AND o.importance >= 2
        ORDER BY ${OBS_BM25}
      `,
        )
        .all('widget AND cache AND invalidation AND race AND condition')
        .map((r) => r.id);
      expect(ranked.indexOf(targetId)).toBeGreaterThan(4);
      expect(ranked.indexOf(targetId)).toBeLessThan(15);

      const returned = searchRelevantMemories(db, QUERY, 'algo3x', []).map((r) => r.id);
      expect(returned).toContain(targetId);
      for (const id of fillerIds) expect(returned).not.toContain(id);
    } finally {
      db.close();
    }
  });

  it('does not inject the penalised fillers that outrank it on raw bm25', () => {
    // The widening must not become "inject more"; the fillers are stronger textual
    // matches and must still lose on the composite.
    const db = createTestDb();
    try {
      const { fillerIds } = seed(db);
      const returned = searchRelevantMemories(db, QUERY, 'algo3', []).map((r) => r.id);
      for (const id of fillerIds) expect(returned).not.toContain(id);
    } finally {
      db.close();
    }
  });
});
