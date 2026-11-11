// D20 (2026-11-11, option A): the DAILY unattended maintenance pass no longer runs normalize.
// One real sonnet call on a copy of the maintainer's store returned 21 synonym groups, about
// half of them not synonyms (`fmtDate <- date`, `CLAUDE.md <- CLAUDE.local.md`), and the pass
// wrote every one into observations.concepts with no record and no undo. The explicit
// `optimize --run --task normalize` stays: a person asked for it and sees what it changed.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { insertSession, insertObs } from './test-helpers.mjs';

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));

vi.mock('../haiku-client.mjs', () => ({
  callModelJSONAsync: vi.fn(),
  BG_LLM_TIMEOUT_MS: 45000,
}));

const NORMALIZE_SYSTEM = /^Analyze concept terms/;
// A wrong merge of the measured kind, offered to every normalize call.
const BAD_GROUP = { groups: [{ canonical: 'fmtDate', aliases: ['date'] }] };

describe('D20: the daily unattended pass does not normalize', () => {
  const saved = process.env.CLAUDE_MEM_DIR;
  let dir;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_MEM_DIR;
    else process.env.CLAUDE_MEM_DIR = saved;
    vi.resetModules();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function seed() {
    dir = join(tmpdir(), `mem-d20-${randomUUID().slice(0, 8)}`);
    process.env.CLAUDE_MEM_DIR = dir;
    vi.resetModules(); // DB_DIR and RUNTIME_DIR resolve from the env at import time
    const { ensureDb } = await import('../schema.mjs');
    const db = ensureDb();
    insertSession(db, { id: 'sess-1', project: 'p' });
    // Six distinct concept terms: normalize needs five before it calls the model.
    const concepts = ['date', 'fmtDate', 'parser', 'cache', 'retry', 'timeout'];
    for (const c of concepts) {
      const id = insertObs(db, { project: 'p', title: `row about ${c}`, narrative: 'n' });
      db.prepare('UPDATE observations SET concepts = ? WHERE id = ?').run(
        c,
        Number(id.lastInsertRowid ?? id),
      );
    }
    db.close();
    const { callModelJSONAsync } = await import('../haiku-client.mjs');
    callModelJSONAsync.mockReset();
    callModelJSONAsync.mockImplementation(async (prompt) =>
      NORMALIZE_SYSTEM.test(prompt?.system || '') ? BAD_GROUP : null,
    );
    return callModelJSONAsync;
  }

  it('sends no normalize prompt and leaves every concept as stored', async () => {
    const call = await seed();
    const { handleLLMOptimize } = await import('../hook-optimize.mjs');
    await handleLLMOptimize();

    const normalizeCalls = call.mock.calls.filter(([p]) => NORMALIZE_SYSTEM.test(p?.system || ''));
    expect(normalizeCalls).toHaveLength(0);
    const { ensureDb } = await import('../schema.mjs');
    const db = ensureDb();
    try {
      const row = db.prepare(`SELECT concepts FROM observations WHERE title = 'row about date'`).get();
      expect(row.concepts).toBe('date');
    } finally {
      db.close();
    }
  });

  it('PREMISE: the same store and mock DO get normalized when normalize is asked for', async () => {
    // Without this, a seed normalize would skip anyway (too few concepts, closed gate, a
    // prompt the matcher misses) makes the case above pass on the old code too.
    const call = await seed();
    const { optimizeRun } = await import('../hook-optimize.mjs');
    const { ensureDb } = await import('../schema.mjs');
    const db = ensureDb();
    try {
      await optimizeRun(db, { tasks: ['normalize'] });
      expect(call.mock.calls.some(([p]) => NORMALIZE_SYSTEM.test(p?.system || ''))).toBe(true);
      const row = db.prepare(`SELECT concepts FROM observations WHERE title = 'row about date'`).get();
      expect(row.concepts).toBe('fmtDate');
    } finally {
      db.close();
    }
  });

  it('runs exactly re-enrich (wide scope), cluster-merge and smart-compress', async () => {
    // The case above shows only that normalize is gone; this pins what stays (R34 review L5:
    // dropping cluster-merge, smart-compress or the wide scope passed the suite).
    const { DAILY_OPTIMIZE, distributeBudget } = await import('../hook-optimize.mjs');
    expect(DAILY_OPTIMIZE).toEqual({
      reenrichScope: 'wide',
      tasks: ['re-enrich', 'cluster-merge', 'smart-compress'],
    });
    // Budgets the three keep: distributeBudget's normalize share was nominal.
    expect(distributeBudget(15)).toMatchObject({ reenrich: 6, clusterMerge: 4, smartCompress: 4 });
  });
});
