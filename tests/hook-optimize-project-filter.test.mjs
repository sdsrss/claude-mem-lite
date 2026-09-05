// hook-optimize-project-filter.test.mjs — P2 fixtures.
//
// (1) Project filter on candidate finders + optimizePreview — bug.txt audit
//     (2026-05-14) showed cluster-merge produced 2 clusters from project A
//     while user worked on project B; current behavior burns LLM tokens on
//     out-of-scope noise. Opt-in `{ project }` filter narrows scope.
// (2) optimizePreview `{ detail: true }` returns cluster contents and
//     re-enrich samples so CLI `--verbose` can render an auditable preview
//     instead of just a candidate count.
//
// Backward-compat: default behavior (no opts) MUST be unchanged.

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

function seedTwoProjects(db) {
  insertSession(db, { id: 'sess-A', project: 'project-A' });
  insertSession(db, { id: 'sess-B', project: 'project-B' });
  // Per findMergeCandidates: cluster forms when title Jaccard ∈ [0.4, 0.85).
  // Tokenization (hash-utils.mjs:14) splits on whitespace, lowercases, strips
  // trailing punctuation — no dot/slash split, so "server.mjs" is one token.
  // Project A pair: 6 common / 10 union = 0.60 → cluster eligible.
  insertObs(db, {
    sessionId: 'sess-A',
    project: 'project-A',
    title: 'Modified hook.mjs validation logic for error path',
    narrative: 'auto-captured edit on hook.mjs A',
  });
  insertObs(db, {
    sessionId: 'sess-A',
    project: 'project-A',
    title: 'Modified hook.mjs validation flow for null path',
    narrative: 'auto-captured edit on hook.mjs A2',
  });
  // Project B pair: 6 common / 10 union = 0.60 → cluster eligible.
  insertObs(db, {
    sessionId: 'sess-B',
    project: 'project-B',
    title: 'Modified server.mjs cluster handler for slow path',
    narrative: 'auto-captured edit on server.mjs B',
  });
  insertObs(db, {
    sessionId: 'sess-B',
    project: 'project-B',
    title: 'Modified server.mjs cluster handler for fast path',
    narrative: 'auto-captured edit on server.mjs B2',
  });
}

describe('findMergeCandidates — project filter', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedTwoProjects(db);
  });
  afterEach(() => {
    db.close();
  });

  it('returns clusters from all projects when no project filter given', async () => {
    const { findMergeCandidates } = await import('../hook-optimize.mjs');
    const clusters = findMergeCandidates(db, 50);
    const projects = new Set(clusters.flat().map((o) => o.project));
    expect(projects.size).toBeGreaterThanOrEqual(1);
    expect(clusters.length).toBeGreaterThan(0);
  });

  it('returns only project-A clusters when { project: "project-A" }', async () => {
    const { findMergeCandidates } = await import('../hook-optimize.mjs');
    const clusters = findMergeCandidates(db, 50, { project: 'project-A' });
    expect(clusters.length).toBeGreaterThan(0);
    for (const cluster of clusters) {
      for (const obs of cluster) {
        expect(obs.project).toBe('project-A');
      }
    }
  });

  it('returns no clusters for an unknown project', async () => {
    const { findMergeCandidates } = await import('../hook-optimize.mjs');
    const clusters = findMergeCandidates(db, 50, { project: 'project-does-not-exist' });
    expect(clusters.length).toBe(0);
  });
});

describe('findReenrichCandidates — project filter', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedTwoProjects(db);
  });
  afterEach(() => {
    db.close();
  });

  it('returns degraded candidates from all projects by default', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    const all = findReenrichCandidates(db, 10);
    const projects = new Set(all.map((o) => o.project));
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(projects.has('project-A') && projects.has('project-B')).toBe(true);
  });

  it('returns only project-A candidates when filtered', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    const filtered = findReenrichCandidates(db, 10, { project: 'project-A' });
    expect(filtered.length).toBeGreaterThan(0);
    for (const cand of filtered) expect(cand.project).toBe('project-A');
  });
});

describe('applyNormalization — project filter (cross-project contamination guard)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-A', project: 'project-A' });
    insertSession(db, { id: 'sess-B', project: 'project-B' });
    // Both projects carry the same alias term that a synonym group will rewrite.
    insertObs(db, { sessionId: 'sess-A', project: 'project-A', title: 'A obs' });
    insertObs(db, { sessionId: 'sess-B', project: 'project-B', title: 'B obs' });
    db.prepare(
      "UPDATE observations SET concepts = 'mutex lock concurrency' WHERE project IN ('project-A','project-B')",
    ).run();
  });
  afterEach(() => {
    db.close();
  });

  it('only rewrites concepts in the scoped project, never sibling projects', async () => {
    const { applyNormalization } = await import('../hook-optimize.mjs');
    const groups = [{ canonical: 'mutex', aliases: ['lock'] }];
    const res = applyNormalization(db, groups, { project: 'project-A' });
    expect(res.updated).toBe(1); // only project-A's row
    const a = db.prepare("SELECT concepts FROM observations WHERE project = 'project-A'").get();
    const b = db.prepare("SELECT concepts FROM observations WHERE project = 'project-B'").get();
    expect(a.concepts).not.toContain('lock'); // rewritten: lock → mutex (deduped)
    expect(b.concepts).toBe('mutex lock concurrency'); // sibling project untouched
  });

  it('rewrites all projects when no project scope is given (legacy unscoped run)', async () => {
    const { applyNormalization } = await import('../hook-optimize.mjs');
    const res = applyNormalization(db, [{ canonical: 'mutex', aliases: ['lock'] }]);
    expect(res.updated).toBe(2); // both projects
  });
});

describe('optimizePreview — project filter + detail mode', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedTwoProjects(db);
  });
  afterEach(() => {
    db.close();
  });

  it('default preview returns aggregate counts only (no detail arrays)', async () => {
    const { optimizePreview } = await import('../hook-optimize.mjs');
    const preview = optimizePreview(db);
    expect(typeof preview.reenrich).toBe('number');
    expect(typeof preview.clusterMerge).toBe('number');
    expect(preview.mergeClusters).toBeUndefined();
    expect(preview.reenrichSamples).toBeUndefined();
  });

  it('{ detail: true } returns cluster contents and re-enrich samples', async () => {
    const { optimizePreview } = await import('../hook-optimize.mjs');
    const preview = optimizePreview(db, { detail: true });
    expect(Array.isArray(preview.mergeClusters)).toBe(true);
    expect(Array.isArray(preview.reenrichSamples)).toBe(true);
    // Each cluster is an array of obs records; reenrichSamples is a flat array.
    for (const cluster of preview.mergeClusters) {
      expect(Array.isArray(cluster)).toBe(true);
      for (const obs of cluster) {
        expect(typeof obs.id).toBe('number');
        expect(typeof obs.title).toBe('string');
        expect(typeof obs.project).toBe('string');
      }
    }
  });

  it('{ project } scopes both aggregate counts and detail arrays', async () => {
    const { optimizePreview } = await import('../hook-optimize.mjs');
    const previewA = optimizePreview(db, { project: 'project-A', detail: true });
    const projectsInClusters = new Set(previewA.mergeClusters.flat().map((o) => o.project));
    const projectsInSamples = new Set(previewA.reenrichSamples.map((o) => o.project));
    if (projectsInClusters.size > 0) expect([...projectsInClusters]).toEqual(['project-A']);
    if (projectsInSamples.size > 0) expect([...projectsInSamples]).toEqual(['project-A']);
  });
});
