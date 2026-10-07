// D#251. checkForUpdate returns null both when it found nothing newer AND when it never
// looked (CLAUDE_MEM_SKIP_UPDATE set, or a development install), and manualUpdate read
// every null as "✓ Already up to date". A user who set the variable to silence the
// session-start notice, then ran `self-update`, was told they were current while nothing
// had been checked, and stayed on an old release. The README says the variable stops
// `self-update` too; the command has to say so as well.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'cli.mjs');

let home;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-selfupdate-'));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function selfUpdate(extraEnv) {
  return execFileSync(process.execPath, [CLI, 'self-update'], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_MEM_DIR: '',
      CLAUDE_PLUGIN_ROOT: '',
      MEM_NO_AUTO_ADOPT: '1',
      // Nothing here may reach GitHub: a dead proxy turns any attempt into a fast failure
      // instead of a real lookup.
      HTTPS_PROXY: 'http://127.0.0.1:1',
      HTTP_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: '',
      ...extraEnv,
    },
  });
}

describe('self-update says why it did not check', () => {
  it('names CLAUDE_MEM_SKIP_UPDATE instead of claiming the install is up to date', () => {
    const out = selfUpdate({ CLAUDE_MEM_SKIP_UPDATE: '1' });
    expect(out).not.toMatch(/up to date/i);
    expect(out).toMatch(/CLAUDE_MEM_SKIP_UPDATE/);
    expect(out).toMatch(/unset it/i);
  });

  it('names a development install instead of claiming it is up to date', () => {
    const dev = mkdtempSync(join(tmpdir(), 'mem-selfupdate-dev-'));
    try {
      // isDevMode's first signal: the code dir is a git checkout.
      mkdirSync(join(dev, '.claude-mem-lite', '.git'), { recursive: true });
      const out = selfUpdate({ HOME: dev });
      expect(out).not.toMatch(/up to date/i);
      expect(out).toMatch(/development install/);
    } finally {
      rmSync(dev, { recursive: true, force: true });
    }
  });

  it('prints the updater name in its banner, not the memory editor `update`', () => {
    const out = selfUpdate({ CLAUDE_MEM_SKIP_UPDATE: '1' });
    expect(out).toMatch(/^claude-mem-lite self-update$/m);
    expect(out).not.toMatch(/^claude-mem-lite update$/m);
  });
});
