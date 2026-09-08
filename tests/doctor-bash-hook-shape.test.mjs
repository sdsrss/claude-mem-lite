// The bash-hook check has to read whichever hook registration is LIVE, and there are two.
//
// Pre-ship review of the issue-#28 round (P1-1) found the first cut reading only
// `<PROJECT_DIR>/hooks/hooks.json` and, when that file was absent, printing a green
// `✓ Hook interpreter: no hook command needs bash`. That arm is not hypothetical: it is the
// npm / npx / `git clone` shape. `hooks/hooks.json` is in RELEASE_SIGNED_FILES but NOT in
// SOURCE_FILES (`source-files.mjs` — verified: `SOURCE_FILES.filter(f => f.startsWith('hooks/'))`
// is empty), so the installed copy under ~/.claude-mem-lite/ has no `hooks/` directory at
// all — while that same shape is the one that registers bash hooks through settings.json.
//
// So on the shape where two bash hooks really are live, doctor asserted there were none.
// That is worse than the silence the whole round exists to remove: a warning that never
// fires leaves a user searching, but a green line that says "nothing to look at" ends the
// search. It also falsified a SHIPPED promise — both READMEs tell the reader
// `claude-mem-lite doctor` reports a missing bash, and `claude-mem-lite` is the ~/.local/bin
// symlink pointing at exactly the copy with no manifest.
//
// The rule this encodes: THREE outcomes, never two. A count of zero is only reportable when
// a registration was actually read; "I could not find any registration" is its own answer and
// must not borrow zero's voice.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { resolveBashHookCount } from '../install.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

/** A dir holding hooks/hooks.json with the given command strings. */
function manifestDir(commands) {
  const root = mkdtempSync(join(tmpdir(), 'hookshape-'));
  dirs.push(root);
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: { SessionStart: [{ matcher: '*', hooks: commands.map((c) => ({ command: c })) }] },
    }),
  );
  return join(root, 'hooks', 'hooks.json');
}

const INSTALL_DIR = '/home/someone/.claude-mem-lite';

describe('resolveBashHookCount — the plugin shape (manifest present)', () => {
  it("counts the manifest's bash commands and names them", () => {
    const manifestPath = manifestDir([
      'bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh"',
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-launcher.mjs" hook.mjs stop',
      'bash "${CLAUDE_PLUGIN_ROOT}/scripts/post-tool-use.sh"',
    ]);
    const r = resolveBashHookCount({ manifestPath, settingsCommands: [], installDir: INSTALL_DIR });
    expect(r.count).toBe(2);
    expect(r.source).toBe('manifest');
    // Derived, not restated: the warning quotes these, so a hardcoded list would go stale
    // the way the "3 hook commands" wording did on the shape it fired on.
    expect(r.scripts).toEqual(['post-tool-use.sh', 'setup.sh']);
  });

  it('reports a real zero when the manifest is readable and has no bash command', () => {
    const manifestPath = manifestDir([
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-launcher.mjs" hook.mjs stop',
    ]);
    const r = resolveBashHookCount({ manifestPath, settingsCommands: [], installDir: INSTALL_DIR });
    expect(r.count).toBe(0);
    expect(r.source).toBe('manifest');
  });
});

describe('resolveBashHookCount — the npm/managed shape (no manifest, settings.json is live)', () => {
  it('P1-1: counts OUR bash commands out of settings.json instead of answering zero', () => {
    // The exact shape measured on a real `node install.mjs install`: no hooks/ dir, two bash
    // commands in settings.json naming scripts under the install dir.
    const r = resolveBashHookCount({
      manifestPath: join(tmpdir(), 'definitely-absent-hooks.json'),
      settingsCommands: [
        `node "${INSTALL_DIR}/scripts/hook-launcher.mjs" hook.mjs session-start`,
        `bash "${INSTALL_DIR}/scripts/pre-agent-inject.sh"`,
        `bash "${INSTALL_DIR}/scripts/post-tool-use.sh"`,
      ],
      installDir: INSTALL_DIR,
    });
    expect(r.count).toBe(2);
    expect(r.source).toBe('settings');
    expect(r.scripts).toEqual(['post-tool-use.sh', 'pre-agent-inject.sh']);
  });

  it("does not count another tool's bash hooks as ours", () => {
    const r = resolveBashHookCount({
      manifestPath: join(tmpdir(), 'definitely-absent-hooks.json'),
      settingsCommands: [
        `node "${INSTALL_DIR}/scripts/hook-launcher.mjs" hook.mjs stop`,
        'bash "/opt/some-other-plugin/prefilter.sh"',
      ],
      installDir: INSTALL_DIR,
    });
    expect(r.count).toBe(0);
    expect(r.source).toBe('settings');
  });

  it('answers UNKNOWN — not zero — when neither registration can be read', () => {
    // The defect's own shape. A settings.json that registers nothing of ours is not evidence
    // that no hook needs bash; it is evidence that we are looking in the wrong place.
    const r = resolveBashHookCount({
      manifestPath: join(tmpdir(), 'definitely-absent-hooks.json'),
      settingsCommands: ['node "/opt/unrelated/thing.mjs"'],
      installDir: INSTALL_DIR,
    });
    expect(r.count).toBeNull();
    expect(r.source).toBeNull();
  });

  it('answers UNKNOWN on a torn manifest rather than silently falling through to zero', () => {
    const root = mkdtempSync(join(tmpdir(), 'hookshape-torn-'));
    dirs.push(root);
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'hooks.json'), '{ not json');
    const r = resolveBashHookCount({
      manifestPath: join(root, 'hooks', 'hooks.json'),
      settingsCommands: [],
      installDir: INSTALL_DIR,
    });
    expect(r.count).toBeNull();
  });
});

describe('the shipped manifests still have the shape this check depends on', () => {
  it('TRIPWIRE: hooks/hooks.json is still absent from SOURCE_FILES', async () => {
    // If a later round ships the manifest into the data dir, the settings.json branch stops
    // being the live one for the npm shape and this whole fallback should be re-judged
    // rather than left running on a premise that changed.
    const { SOURCE_FILES } = await import('../source-files.mjs');
    expect(
      SOURCE_FILES.filter((f) => f.startsWith('hooks/')),
      "hooks/ now ships into the data dir — re-judge resolveBashHookCount's fallback",
    ).toEqual([]);
  });
});
