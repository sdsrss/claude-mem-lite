// Round-3 E2E audit fixes for hook-optimize.mjs:
//   L-H1 (HIGH): wide re-enrich must not silently downgrade importance / reclassify type
//   L-M1 (MED):  cluster-merge must preserve keeper concepts/facts/narrative on a partial LLM response
//   L-L1 (LOW):  distributeBudget must never allocate more than `total`
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));
vi.mock('../haiku-client.mjs', () => ({
  callModelJSONAsync: vi.fn(),
  // Real export consumed by hook-optimize's LLM call sites; a mock without it
  // throws before any branch under test runs.
  BG_LLM_TIMEOUT_MS: 45000,
}));
import { callModelJSONAsync } from '../haiku-client.mjs';

const LONG =
  'A concurrent-deduction race let two requests read the same balance and both deduct, double-spending; the fix serializes with SELECT ... FOR UPDATE row locking so the second waits.';

describe('re-enrich must not downgrade importance/type (R3 L-H1)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  it('preserves a user-set importance (3) and specific type (bugfix) when the LLM re-judges them down', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, {
      type: 'bugfix',
      importance: 3,
      title: 'Fix race in balance deduction causing double-spend',
      narrative: LONG,
    });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    // Re-enrich is an "add a lesson" pass; the LLM prompt defaults importance to 1 and may
    // re-guess type. It must not overwrite the stored importance/type downward.
    callModelJSONAsync.mockResolvedValue({
      type: 'change',
      importance: 1,
      title: 'Serialize balance deductions',
      narrative: 'Row locking serializes concurrent deductions.',
      lesson_learned: 'Money-mutating reads need SELECT ... FOR UPDATE, not a plain SELECT',
    });
    const result = await executeReenrich(db, 10, { scope: 'wide' });
    expect(result.processed).toBe(1);
    const obs = db.prepare('SELECT importance, type, lesson_learned FROM observations WHERE id = ?').get(id);
    expect(obs.lesson_learned).toContain('FOR UPDATE'); // enrichment did apply
    expect(obs.importance, 'must not downgrade importance 3→1').toBe(3);
    expect(obs.type, 'must not reclassify bugfix→change').toBe('bugfix');
  });

  it('still allows the LLM to UPGRADE importance (floor, not freeze)', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, { type: 'feature', importance: 1, title: 'Add CSV export to reports', narrative: LONG });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    callModelJSONAsync.mockResolvedValue({
      type: 'feature',
      importance: 3,
      title: 'Streaming CSV export for large reports',
      narrative: 'Paginated streaming exporter avoids OOM.',
      lesson_learned: 'Stream large exports; never build the whole CSV in memory',
    });
    await executeReenrich(db, 10, { scope: 'wide' });
    const obs = db.prepare('SELECT importance FROM observations WHERE id = ?').get(id);
    expect(obs.importance, 'LLM upgrade 1→3 must be honored').toBe(3);
  });
});

describe('cluster-merge preserve-on-empty for keeper metadata (R3 L-M1)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  it('keeps keeper concepts/facts/narrative when the LLM omits merged_concepts/facts/narrative', async () => {
    const { findMergeCandidates, executeMergeCluster } = await import('../hook-optimize.mjs');
    // titles share 4/6 tokens → jaccard 0.667 ∈ [MERGE_JACCARD_LOW 0.4, AUTO_MERGE 0.85) → cluster
    insertObs(db, {
      type: 'decision',
      importance: 2,
      title: 'alpha beta gamma delta keeper',
      narrative: 'keeper narrative that must survive the merge',
    });
    insertObs(db, {
      type: 'decision',
      importance: 1,
      title: 'alpha beta gamma delta other',
      narrative: 'other narrative',
    });
    const keeperId = db.prepare('SELECT id FROM observations ORDER BY id LIMIT 1').get().id;
    db.prepare(
      "UPDATE observations SET concepts = 'authentication jwt oauth refresh', facts = 'token TTL is 15m' WHERE id = ?",
    ).run(keeperId);

    const clusters = findMergeCandidates(db, 5);
    expect(clusters.length, 'the two similar rows must cluster').toBeGreaterThanOrEqual(1);
    // production path: findMergeCandidates must carry concepts/facts, else preserve reads undefined
    expect(clusters[0][0].concepts, 'findMergeCandidates must SELECT concepts').toBeDefined();
    expect(clusters[0][0].facts, 'findMergeCandidates must SELECT facts').toBeDefined();

    callModelJSONAsync.mockResolvedValue({
      should_merge: true,
      merged_title: 'alpha beta gamma delta merged',
      merged_lesson: 'oauth refresh tokens must rotate',
      // merged_concepts / merged_facts / merged_narrative omitted (common partial LLM shape)
    });
    const result = await executeMergeCluster(db, clusters[0]);
    expect(result.merged).toBe(true);

    const keeper = db
      .prepare('SELECT concepts, facts, narrative FROM observations WHERE id = ?')
      .get(keeperId);
    expect(keeper.concepts, 'keeper concepts must not be blanked').toContain('oauth');
    expect(keeper.facts, 'keeper facts must not be blanked').toContain('TTL');
    expect(keeper.narrative, 'keeper narrative must not be blanked').toContain('must survive');
  });
});

describe('distributeBudget never exceeds total (R3 L-L1)', () => {
  it('caps the sum at total for small budgets', async () => {
    const { distributeBudget } = await import('../hook-optimize.mjs');
    for (const total of [0, 1, 2, 3]) {
      const b = distributeBudget(total);
      const sum = b.reenrich + b.normalize + b.clusterMerge + b.smartCompress;
      expect(sum, `distributeBudget(${total}) sum=${sum} must be <= ${total}`).toBeLessThanOrEqual(total);
    }
  });
  it('still allocates a full, non-degenerate split for the normal budget', async () => {
    const { distributeBudget } = await import('../hook-optimize.mjs');
    const b = distributeBudget(15);
    const sum = b.reenrich + b.normalize + b.clusterMerge + b.smartCompress;
    expect(sum).toBeLessThanOrEqual(15);
    expect(b.reenrich).toBeGreaterThanOrEqual(1);
    expect(b.clusterMerge).toBeGreaterThanOrEqual(1);
    expect(b.smartCompress).toBeGreaterThanOrEqual(1);
  });
});
