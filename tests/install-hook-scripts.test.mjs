// install-hook-scripts.test.mjs — Bug 1 regression
// install.mjs writes settings.json hook commands pointing at
// `~/.claude-mem-lite/scripts/pre-tool-recall.js` (and, until the skill-registry
// removal in 2026-09, `pre-skill-bridge.js`), but the non-dev copy block only
// copied 3 of the 5 scripts. The PreToolUse scripts went missing on every fresh
// install, so each Read/Skill tool call after install logged "Cannot find module"
// until the user manually patched settings.json or copied the files. Lock the full set in a single
// constant so adding a script + wiring its hook can't drift out of sync.

import { describe, it, expect } from 'vitest';
import { mkdirSync, existsSync, rmSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { HOOK_SCRIPT_FILES, copyHookScripts } from '../install.mjs';

const PROJECT_SCRIPTS = resolve('scripts');

describe('Bug 1: HOOK_SCRIPT_FILES manifest', () => {
  it('includes the PreToolUse script referenced by settings.json hooks', () => {
    expect(HOOK_SCRIPT_FILES).toContain('pre-tool-recall.js');
  });

  it('includes the 3 previously-copied scripts to preserve existing behavior', () => {
    expect(HOOK_SCRIPT_FILES).toContain('post-tool-use.sh');
    expect(HOOK_SCRIPT_FILES).toContain('user-prompt-search.js');
    expect(HOOK_SCRIPT_FILES).toContain('prompt-search-utils.mjs');
  });

  it('every name in the manifest exists in the project scripts/ directory', () => {
    for (const name of HOOK_SCRIPT_FILES) {
      expect(existsSync(join(PROJECT_SCRIPTS, name))).toBe(true);
    }
  });
});

describe('Bug 1: copyHookScripts behavior', () => {
  it('copies every HOOK_SCRIPT_FILES entry from src into dest', () => {
    const dest = join(tmpdir(), `mem-hooks-${randomUUID().slice(0, 8)}`);
    mkdirSync(dest, { recursive: true });
    try {
      copyHookScripts(PROJECT_SCRIPTS, dest);
      for (const name of HOOK_SCRIPT_FILES) {
        expect(existsSync(join(dest, name))).toBe(true);
      }
      // pre-tool-recall.js specifically — the bug we're fixing
      expect(existsSync(join(dest, 'pre-tool-recall.js'))).toBe(true);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('skips silently when a manifest entry does not exist in src', () => {
    const fakeSrc = join(tmpdir(), `mem-hooks-empty-${randomUUID().slice(0, 8)}`);
    const dest = join(tmpdir(), `mem-hooks-dest-${randomUUID().slice(0, 8)}`);
    mkdirSync(fakeSrc, { recursive: true });
    mkdirSync(dest, { recursive: true });
    try {
      // Should not throw even though src is empty
      expect(() => copyHookScripts(fakeSrc, dest)).not.toThrow();
      expect(readdirSync(dest)).toHaveLength(0);
    } finally {
      rmSync(fakeSrc, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
