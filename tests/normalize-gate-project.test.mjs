// Regression (M-F3): the 7-day normalize gate is a single global file, but the normalize
// MUTATION is per-project (applyNormalization scopes to `project`). So `optimize --run
// --task normalize --project B` returned skipped(gate) for 7 days if ANY project had run
// normalize — B never got normalized that week. Fix: an explicit project bypasses the
// global gate (and does not advance it); only the unscoped whole-store run is rate-limited.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

describe('normalize gate is per-scope (M-F3)', () => {
  const savedEnv = process.env.CLAUDE_MEM_DIR;
  let dir;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_MEM_DIR;
    else process.env.CLAUDE_MEM_DIR = savedEnv;
    vi.resetModules();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('a recent global run gates the unscoped normalize but NOT a project-scoped one', async () => {
    dir = join(tmpdir(), `mem-normgate-${randomUUID().slice(0, 8)}`);
    process.env.CLAUDE_MEM_DIR = dir;
    vi.resetModules(); // force RUNTIME_DIR (hook-shared) to recompute from the temp env
    const { shouldRunNormalize } = await import('../hook-optimize.mjs');
    const { RUNTIME_DIR } = await import('../hook-shared.mjs');

    mkdirSync(RUNTIME_DIR, { recursive: true });
    // A whole-store normalize ran just now → the shared 7-day gate is CLOSED.
    writeFileSync(join(RUNTIME_DIR, 'last-normalize.json'), JSON.stringify({ epoch: Date.now() }));

    expect(shouldRunNormalize()).toBe(false); // unscoped: correctly gated
    expect(shouldRunNormalize('project-B')).toBe(true); // scoped: bypasses the global gate (was false pre-fix)
  });
});
