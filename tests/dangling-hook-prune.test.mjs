// R9 review P1-1: removing a hook is not the same as adding one, and only the
// addition path was ever built.
//
// `configureHooks()` rewrites all seven events and strips stale mem entries first —
// but it has exactly ONE caller, `install()`. Auto-update never runs it. Meanwhile
// `buildSwitchablePaths` swaps `scripts/` wholesale, so an upgrade DELETES a hook
// script from disk while `~/.claude/settings.json` still points at it. Result on the
// npm channel after the v5.0.0 removal: every `Skill()` call fires
// `hook-launcher.mjs scripts/pre-skill-bridge.js`, which prints two lines and arms
// the broken-install marker for a file that is not coming back.
//
// Two halves, pinned separately:
//   1. `pruneDanglingMemHooks` — the reconciler the update path now runs.
//   2. `collectOrphanHookPaths` — doctor could not SEE the orphan, because it only
//      considered QUOTED tokens and the dead script is the launcher's unquoted
//      relative argument.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pruneDanglingMemHooks } from '../lib/hook-prune.mjs';
import { collectOrphanHookPaths } from '../install.mjs';

let root, installDir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-dangling-'));
  installDir = join(root, '.claude-mem-lite');
  mkdirSync(join(installDir, 'scripts'), { recursive: true });
  // The launcher itself exists; so does one live entry. The removed one does not.
  writeFileSync(join(installDir, 'scripts', 'hook-launcher.mjs'), '// launcher');
  writeFileSync(join(installDir, 'scripts', 'pre-tool-recall.js'), '// live entry');
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const launcher = () => join(installDir, 'scripts', 'hook-launcher.mjs');
const nodeHook = (entry) => `node "${launcher()}" ${entry}`;

const settingsWith = (extra = {}) => ({
  hooks: {
    PreToolUse: [
      {
        matcher: 'Edit|Write|NotebookEdit|Read',
        hooks: [{ type: 'command', command: nodeHook('scripts/pre-tool-recall.js'), timeout: 3 }],
      },
      {
        matcher: 'Skill',
        hooks: [{ type: 'command', command: nodeHook('scripts/pre-skill-bridge.js'), timeout: 3 }],
      },
    ],
    ...extra,
  },
});

describe('pruneDanglingMemHooks — the reconciler auto-update was missing', () => {
  it('drops the entry whose launcher argument no longer exists on disk', () => {
    const { settings, removed } = pruneDanglingMemHooks(settingsWith(), installDir);
    expect(removed).toEqual(['scripts/pre-skill-bridge.js']);
    const matchers = settings.hooks.PreToolUse.map((c) => c.matcher);
    expect(matchers).toEqual(['Edit|Write|NotebookEdit|Read']);
  });

  it('leaves a live entry alone — the whole point is not to unregister working hooks', () => {
    const { settings, removed } = pruneDanglingMemHooks(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Edit',
              hooks: [{ type: 'command', command: nodeHook('scripts/pre-tool-recall.js') }],
            },
          ],
        },
      },
      installDir,
    );
    expect(removed).toEqual([]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it("never touches a plugin-channel entry — hooks.json owns those, and its paths don't resolve here", () => {
    const pluginCmd = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-launcher.mjs" scripts/pre-skill-bridge.js';
    const { settings, removed } = pruneDanglingMemHooks(
      { hooks: { PreToolUse: [{ matcher: 'Skill', hooks: [{ type: 'command', command: pluginCmd }] }] } },
      installDir,
    );
    expect(removed).toEqual([]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it('leaves a NON-mem hook alone even when its target is missing — not ours to prune', () => {
    const foreign = {
      matcher: '*',
      hooks: [{ type: 'command', command: 'node "/opt/other-tool/run.js" scripts/gone.js' }],
    };
    const { settings, removed } = pruneDanglingMemHooks({ hooks: { PreToolUse: [foreign] } }, installDir);
    expect(removed).toEqual([]);
    expect(settings.hooks.PreToolUse).toEqual([foreign]);
  });

  it('drops the event key entirely when its last entry was dangling', () => {
    const only = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Skill',
            hooks: [{ type: 'command', command: nodeHook('scripts/pre-skill-bridge.js') }],
          },
        ],
      },
    };
    const { settings } = pruneDanglingMemHooks(only, installDir);
    expect(settings.hooks.PreToolUse ?? []).toEqual([]);
  });

  it('is a pure function — the caller decides whether to write', () => {
    const input = settingsWith();
    const before = JSON.stringify(input);
    pruneDanglingMemHooks(input, installDir);
    expect(JSON.stringify(input), 'input was mutated in place').toBe(before);
  });
});

describe('collectOrphanHookPaths sees the launcher entry argument', () => {
  // FAILS IF: the scanner goes back to considering only quoted tokens. The launcher
  // path IS quoted and DOES exist, so the old code found it, called the entry healthy,
  // and reported zero orphans while the real target was missing.
  it('reports the missing relative entry, not just the quoted launcher', () => {
    const orphans = collectOrphanHookPaths(settingsWith(), installDir);
    expect(orphans).toEqual([join(installDir, 'scripts', 'pre-skill-bridge.js')]);
  });

  it('stays silent when every entry resolves', () => {
    const live = {
      hooks: {
        PreToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: nodeHook('scripts/pre-tool-recall.js') }] },
        ],
      },
    };
    expect(collectOrphanHookPaths(live, installDir)).toEqual([]);
  });

  it('still reports a missing ABSOLUTE hook path (the pre-existing behaviour)', () => {
    const gone = join(installDir, 'scripts', 'never-existed.sh');
    const s = {
      hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `bash "${gone}"` }] }] },
    };
    expect(collectOrphanHookPaths(s, installDir)).toEqual([gone]);
  });
});
