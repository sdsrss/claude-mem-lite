// Guard for tests/setup-strip-git-env.mjs — both halves, because either alone is vacuous:
// the file must be WIRED (a setup file vitest never loads strips nothing) and it must
// STRIP (a wired no-op leaves an inherited GIT_DIR to turn the repo bare on the next
// worktree commit; reproduced 2026-09-26 on a sandbox repo: core.bare false → true).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vitestConfig from '../vitest.config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('GIT_* env strip for test workers', () => {
  it('is registered as a worker setup file', () => {
    expect(vitestConfig.test.setupFiles).toContain('./tests/setup-strip-git-env.mjs');
  });

  it('removes GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE inherited from a hook', () => {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        "await import('./tests/setup-strip-git-env.mjs'); console.log(JSON.stringify([process.env.GIT_DIR, process.env.GIT_INDEX_FILE, process.env.GIT_WORK_TREE, process.env.KEEP_ME]))",
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_DIR: '/x/.git/worktrees/w',
          GIT_INDEX_FILE: '/x/i',
          GIT_WORK_TREE: '/x',
          KEEP_ME: 'y',
        },
      },
    );
    expect(JSON.parse(out)).toEqual([null, null, null, 'y']);
  });

  it('this worker itself carries no GIT_DIR', () => {
    expect(process.env.GIT_DIR).toBeUndefined();
  });
});
