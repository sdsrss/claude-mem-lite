// Tests for the experiment arm config, DB seeding, and the trial assembler.
// buildEnv is pure; seedArmDb runs against a real temp DB (faithful seeding via
// the production saveObservation pipeline); runTrial is exercised with injected
// mocks so no real claude spawn / git checkout happens in CI.

import { describe, test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { ARMS, buildEnv } from '../experiment/lib/arms.mjs';
import { seedArmDb } from '../experiment/lib/seed-db.mjs';
import { runTrial } from '../experiment/lib/runner.mjs';

const TASK = {
  id: 'fk-cascade',
  project: 'projects--mem',
  prompt: 'Restore foreign_keys enforcement on the warm-start path.',
  files: ['schema.mjs'],
  capturedMemory: {
    type: 'bugfix',
    title: 'Warm-start fast-path left foreign_keys OFF',
    content: 'initSchema early returns skipped foreign_keys=ON so CASCADE never fired.',
    lesson_learned: 'Set pragma ON before every initSchema return path.',
    importance: 2,
  },
  regressionCheck: 'true',
};

describe('buildEnv', () => {
  test('control arm disables injection (no DB path) but keeps experiment isolation', () => {
    const env = buildEnv(ARMS.control, { dbPath: '/x/db', runtimeDir: '/x/rt' });
    expect(env.CLAUDE_MEM_DB_PATH).toBeUndefined();
    expect(env.MEM_DISABLE_CITATION_DECAY).toBe('1');
    expect(env.CLAUDE_MEM_SKIP_UPDATE).toBe('1');
  });

  test('treatment arm points the hooks at the seeded DB', () => {
    const env = buildEnv(ARMS.treatment, { dbPath: '/x/db', runtimeDir: '/x/rt' });
    expect(env.CLAUDE_MEM_DB_PATH).toBe('/x/db');
    expect(env.CLAUDE_MEM_RUNTIME_DIR).toBe('/x/rt');
  });
});

describe('seedArmDb', () => {
  test('treatment seeds exactly the captured memory; control seeds nothing', () => {
    const d = mkdtempSync(join(tmpdir(), 'exp-seed-'));
    try {
      const t = seedArmDb(join(d, 't.db'), ARMS.treatment, TASK, {});
      expect(t.seeded).toBe(1);
      const db = new Database(join(d, 't.db'), { readonly: true });
      expect(db.prepare('SELECT COUNT(*) AS c FROM observations').get().c).toBe(1);
      db.close();

      const c = seedArmDb(join(d, 'c.db'), ARMS.control, TASK, {});
      expect(c.seeded).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('shuffled seeds the irrelevant pool, count-matched to treatment', () => {
    const d = mkdtempSync(join(tmpdir(), 'exp-seed-'));
    try {
      const shuffledPool = [
        {
          type: 'discovery',
          title: 'unrelated CSS grid quirk',
          content: 'flexbox vs grid gap',
          importance: 1,
        },
        {
          type: 'discovery',
          title: 'unrelated webpack chunk',
          content: 'splitChunks cacheGroups',
          importance: 1,
        },
      ];
      const s = seedArmDb(join(d, 's.db'), ARMS.shuffled, TASK, { shuffledPool });
      expect(s.seeded).toBe(2);
      const db = new Database(join(d, 's.db'), { readonly: true });
      expect(db.prepare('SELECT COUNT(*) AS c FROM observations').get().c).toBe(2);
      db.close();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('runTrial', () => {
  test('assembles a RunResult from injected steps and wires the three metrics', async () => {
    let clock = 1000;
    const deps = {
      now: () => (clock += 50),
      prepareSandbox: async () => ({ cwd: '/sandbox', cleanup: async () => {} }),
      seedDb: async () => '/sandbox/mem.db',
      claudeRunner: async () => ({
        result: { usage: { input_tokens: 300, output_tokens: 100 } },
        events: [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] } }],
      }),
      runCheck: async () => ({ exitCode: 0 }),
    };
    const r = await runTrial({ task: TASK, arm: ARMS.treatment, trial: 1 }, deps);
    expect(r).toMatchObject({
      taskId: 'fk-cascade',
      arm: 'treatment',
      trial: 1,
      recurred: false,
      tokens: 400,
      toolCalls: 1,
    });
    expect(r.wallClockMs).toBeGreaterThan(0);
  });

  test('cleans up the sandbox even when the regression check reports recurrence', async () => {
    let cleaned = false;
    const deps = {
      now: () => 1,
      prepareSandbox: async () => ({
        cwd: '/s',
        cleanup: async () => {
          cleaned = true;
        },
      }),
      seedDb: async () => null,
      claudeRunner: async () => ({ result: {}, events: [] }),
      runCheck: async () => ({ exitCode: 1 }),
    };
    const r = await runTrial({ task: TASK, arm: ARMS.control, trial: 1 }, deps);
    expect(r.recurred).toBe(true);
    expect(cleaned).toBe(true);
  });
});
