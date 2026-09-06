// R10 P2-9 — which cached plugin version is the LIVE one?
//
// detectInstallShape answered with CLAUDE_PLUGIN_ROOT, else the newest cache directory.
// That is right inside a hook (Claude Code sets the env var) and wrong everywhere else:
// `claude-mem-lite self-update`, `doctor`, `status` and `rebuild-binding` all run from a
// terminal, where the env var is unset. Claude Code records the truth in
// ~/.claude/plugins/installed_plugins.json, and nothing read it.
//
// Two consequences, one of them destructive. prunePluginCache keeps the newest N and
// skips "the running one" — with the wrong answer for running, it removed the version the
// user's sessions actually load, which is exactly the failure A20260905-R5-Q1 fixed for
// the hook path and left open for the terminal path. And doctor / status / rebuild-binding
// were all handed the same wrong version to grade and repair.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectInstallShape } from '../lib/install-shape.mjs';

let home;
const CACHE = ['.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite'];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-activever-'));
});
afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function seedVersions(versions) {
  for (const v of versions) {
    const root = join(home, ...CACHE, v);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'launch.mjs'), '// launcher');
  }
}

function seedInstalledPlugins(version) {
  const dir = join(home, '.claude', 'plugins');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'claude-mem-lite@sdsrss': [
          {
            scope: 'user',
            installPath: join(home, ...CACHE, version),
            version,
            installedAt: '2026-09-05T14:40:58.592Z',
          },
        ],
        'other@elsewhere': [{ scope: 'user', installPath: '/nope', version: '1.0.0' }],
      },
    }),
  );
}

const shape = (extra = {}) => detectInstallShape({ home, pluginRoot: undefined, ...extra });

describe('R10 P2-9 — the active plugin version comes from what Claude Code recorded', () => {
  it('premise: four versions are cached and the newest is NOT the installed one', () => {
    seedVersions(['3.95.0', '3.96.0', '3.97.0', '3.98.0']);
    seedInstalledPlugins('3.95.0');
    expect(shape().pluginVersions.map((v) => v.version)).toEqual(['3.98.0', '3.97.0', '3.96.0', '3.95.0']);
  });

  it('with no CLAUDE_PLUGIN_ROOT, installed_plugins.json decides', () => {
    seedVersions(['3.95.0', '3.96.0', '3.97.0', '3.98.0']);
    seedInstalledPlugins('3.95.0');
    expect(shape().activePluginVersion.version).toBe('3.95.0');
  });

  it('CLAUDE_PLUGIN_ROOT still wins — it is the process we are actually inside', () => {
    seedVersions(['3.95.0', '3.98.0']);
    seedInstalledPlugins('3.95.0');
    const root = join(home, ...CACHE, '3.98.0');
    expect(shape({ pluginRoot: root }).activePluginVersion.version).toBe('3.98.0');
  });

  it('falls back to the newest when installed_plugins.json is absent', () => {
    seedVersions(['3.95.0', '3.98.0']);
    expect(shape().activePluginVersion.version).toBe('3.98.0');
  });

  it('falls back to the newest when the file is unparseable or names a missing dir', () => {
    seedVersions(['3.95.0', '3.98.0']);
    const dir = join(home, '.claude', 'plugins');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'installed_plugins.json'), '{ not json');
    expect(shape().activePluginVersion.version).toBe('3.98.0');

    seedInstalledPlugins('9.9.9'); // recorded, but no such cache dir
    expect(shape().activePluginVersion.version).toBe('3.98.0');
  });

  it('ignores other plugins entries', () => {
    seedVersions(['3.95.0', '3.98.0']);
    const dir = join(home, '.claude', 'plugins');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'other@elsewhere': [{ installPath: '/nope' }] } }),
    );
    expect(shape().activePluginVersion.version).toBe('3.98.0');
  });

  it('returns null when no versions are cached at all', () => {
    seedInstalledPlugins('3.95.0');
    expect(shape().activePluginVersion).toBeNull();
  });
});

// The destructive consumer. prunePluginCache keeps the newest N and skips "the running
// one"; with the wrong answer for running it rm -rf'd the tree the user's sessions load.
// A20260905-R5-Q1 closed this for the hook path (CLAUDE_PLUGIN_ROOT is set there) and left
// the terminal path — self-update, which is where prune actually runs — wide open.
describe('R10 P2-9 — prunePluginCache never deletes the recorded live version', () => {
  it('keeps it even when it is not among the newest three and no env var is set', async () => {
    seedVersions(['3.95.0', '3.96.0', '3.97.0', '3.98.0', '3.99.0']);
    seedInstalledPlugins('3.95.0');
    const savedHome = process.env.HOME;
    const savedRoot = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.HOME = home;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const { prunePluginCache } = await import('../hook-update.mjs');
      const removed = prunePluginCache();
      const { existsSync } = await import('fs');
      expect(
        existsSync(join(home, ...CACHE, '3.95.0')),
        'prune deleted the version installed_plugins.json says is live',
      ).toBe(true);
      expect(removed, 'premise: prune must actually have removed something').toBeGreaterThan(0);
      expect(existsSync(join(home, ...CACHE, '3.96.0'))).toBe(false);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = savedRoot;
    }
  });
});
