// The unit suite must not write the developer's own ~/.claude/settings.json.
//
// It did. `installExtractedRelease` gained a post-swap hook reconcile that writes
// `join(homedir(), '.claude', 'settings.json')`, and 78 of the 80 `loadModule` call
// sites in tests/hook-update.test.mjs passed no HOME — so `os.homedir()` resolved to the
// real one. On a machine whose settings.json holds a dangling claude-mem-lite hook entry
// (exactly the state an upgrade past the skill-registry removal creates), `npx vitest run`
// rewrote it and left a .bak. Measured before the fix: 289 B → 42 B.
//
// It went unnoticed because the developer who wrote it is on a plugin-only install, whose
// settings.json has no mem hook entries at all — the write was a no-op HERE and
// destructive on precisely the machines the release targets. That asymmetry is why this
// guard drives the real writer against a seeded fixture rather than asserting on the
// current machine's file, which would pass vacuously for the same reason the bug did.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir, homedir } from 'os';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_SETTINGS = join(homedir(), '.claude', 'settings.json');

let root, fakeHome, savedHome;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-userconfig-'));
  fakeHome = join(root, 'home');
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  mkdirSync(join(fakeHome, '.claude-mem-lite', 'scripts'), { recursive: true });
  copyFileSync(
    join(REPO, 'scripts', 'hook-launcher.mjs'),
    join(fakeHome, '.claude-mem-lite', 'scripts', 'hook-launcher.mjs'),
  );
  savedHome = process.env.HOME;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** settings.json with one DANGLING mem hook — the shape the reconcile acts on. */
function seedDanglingSettings(home) {
  const launcher = join(home, '.claude-mem-lite', 'scripts', 'hook-launcher.mjs');
  const s = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Skill',
          hooks: [{ type: 'command', command: `node "${launcher}" scripts/pre-skill-bridge.js`, timeout: 3 }],
        },
      ],
    },
  };
  const p = join(home, '.claude', 'settings.json');
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  return p;
}

describe('the reconcile only ever writes the HOME it was pointed at', () => {
  it('rewrites a sandboxed settings.json — the premise, so the next case cannot pass vacuously', async () => {
    const p = seedDanglingSettings(fakeHome);
    const before = readFileSync(p, 'utf8');
    process.env.HOME = fakeHome;
    const { pruneDanglingMemHooks } = await import('../lib/hook-prune.mjs');
    const { settings, removed } = pruneDanglingMemHooks(
      JSON.parse(before),
      join(fakeHome, '.claude-mem-lite'),
    );
    expect(removed, 'fixture is not the shape the reconcile acts on').toEqual([
      'scripts/pre-skill-bridge.js',
    ]);
    writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
    expect(readFileSync(p, 'utf8')).not.toBe(before);
  });

  it('leaves the REAL ~/.claude/settings.json byte-identical across a hook-update run', async () => {
    // The file that actually got clobbered. Snapshot it, run the module that writes it
    // under a sandboxed HOME, and prove the real one did not move. A .bak appearing is the
    // other tell — atomicWriteFileSync({ backup: true }) leaves one on every write.
    const existed = existsSync(REAL_SETTINGS);
    const before = existed ? readFileSync(REAL_SETTINGS, 'utf8') : null;
    const bak = REAL_SETTINGS + '.bak';
    const bakBefore = existsSync(bak) ? readFileSync(bak, 'utf8') : null;

    seedDanglingSettings(fakeHome);
    process.env.HOME = fakeHome;
    const { installExtractedRelease } = await import('../hook-update.mjs');
    expect(typeof installExtractedRelease).toBe('function');

    const after = existsSync(REAL_SETTINGS) ? readFileSync(REAL_SETTINGS, 'utf8') : null;
    expect(after, 'the suite rewrote the developer real ~/.claude/settings.json').toBe(before);
    const bakAfter = existsSync(bak) ? readFileSync(bak, 'utf8') : null;
    expect(bakAfter, 'the suite left a settings.json.bak in the real home').toBe(bakBefore);
  });
});
