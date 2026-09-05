import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  symlinkSync,
  readlinkSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { clearPluginDisabledMarkerForDirectInstall, hasOtherMarketplacePlugins } from '../install.mjs';
import { initSchema } from '../schema.mjs';

const INSTALL_PATH = resolve('install.mjs');
const SETUP_PATH = resolve('scripts/setup.sh');

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-install-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runInstall(command, home, args = [], extraEnv = {}) {
  return execFileSync(process.execPath, [INSTALL_PATH, command, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function makeFakeClaudeBin(home) {
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, 'claude');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `STATE="${home}/.claude/mcp-state.txt"`,
      `mkdir -p "${home}/.claude"`,
      'touch "$STATE"',
      'if [[ "${1:-}" != "mcp" ]]; then',
      '  exit 0',
      'fi',
      'shift',
      'cmd="${1:-}"',
      'shift || true',
      'case "$cmd" in',
      '  add)',
      '    scope="user"',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      case "$1" in',
      '        -s) scope="$2"; shift 2 ;;',
      '        -t) shift 2 ;;',
      '        --) break ;;',
      '        *) if [[ -z "$name" && "$1" != -* ]]; then name="$1"; fi; shift ;;',
      '      esac',
      '    done',
      '    if [[ -n "$name" ]]; then',
      '      grep -v "^${scope}:${name}$" "$STATE" > "$STATE.tmp" || true',
      '      mv "$STATE.tmp" "$STATE"',
      '      printf \'%s:%s\\n\' "$scope" "$name" >> "$STATE"',
      '    fi',
      '    ;;',
      '  remove)',
      '    scope="user"',
      '    name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      case "$1" in',
      '        -s) scope="$2"; shift 2 ;;',
      '        *) if [[ -z "$name" && "$1" != -* ]]; then name="$1"; fi; shift ;;',
      '      esac',
      '    done',
      '    if [[ -n "$name" ]]; then',
      '      grep -v "^${scope}:${name}$" "$STATE" > "$STATE.tmp" || true',
      '      mv "$STATE.tmp" "$STATE"',
      '    fi',
      '    ;;',
      '  list)',
      '    while IFS= read -r line; do',
      '      [[ -n "$line" ]] || continue',
      '      name="${line#*:}"',
      '      printf \'%s: stdio\\n\' "$name"',
      '    done < "$STATE"',
      '    ;;',
      'esac',
      '',
    ].join('\n'),
  );
  execFileSync('chmod', ['+x', script]);
  return binDir;
}

describe('install lifecycle checks', () => {
  it('status reports stale plugin cache hooks.json when install.mjs path is active', () => {
    const home = makeTmpDir();
    try {
      const claudeDir = join(home, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify(
          {
            enabledPlugins: { 'claude-mem-lite@sdsrss': true },
            hooks: {
              SessionStart: [
                {
                  matcher: '*',
                  hooks: [
                    { type: 'command', command: `node "${home}/.claude-mem-lite/hook.mjs" session-start` },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
      );
      const cacheVerDir = join(claudeDir, 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '2.31.0');
      mkdirSync(join(cacheVerDir, 'hooks'), { recursive: true });
      writeFileSync(
        join(cacheVerDir, 'hooks', 'hooks.json'),
        JSON.stringify(
          {
            description: 'test',
            hooks: {
              UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'node foo.js' }] }],
            },
          },
          null,
          2,
        ),
      );

      const output = runInstall('status', home);
      expect(output).toMatch(/Plugin cache.*stale|stale.*cache|cache.*hooks\.json/i);
      expect(output).toContain('2.31.0');
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  it('status reports clean plugin cache when hooks.json is empty', () => {
    const home = makeTmpDir();
    try {
      const claudeDir = join(home, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify(
          {
            enabledPlugins: { 'claude-mem-lite@sdsrss': true },
            hooks: {
              SessionStart: [
                {
                  matcher: '*',
                  hooks: [
                    { type: 'command', command: `node "${home}/.claude-mem-lite/hook.mjs" session-start` },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
      );
      const cacheVerDir = join(claudeDir, 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '2.31.0');
      mkdirSync(join(cacheVerDir, 'hooks'), { recursive: true });
      writeFileSync(
        join(cacheVerDir, 'hooks', 'hooks.json'),
        JSON.stringify(
          {
            description: 'test',
            _note: 'cleared',
            hooks: {},
          },
          null,
          2,
        ),
      );

      const output = runInstall('status', home);
      expect(output).toMatch(/Plugin cache:.*no stale|no duplicate firing/i);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  it('status reports stale hooks when plugin is disabled', () => {
    const home = makeTmpDir();
    try {
      const claudeDir = join(home, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify(
          {
            enabledPlugins: { 'claude-mem-lite@sdsrss': false },
            hooks: {
              SessionStart: [
                {
                  matcher: '*',
                  hooks: [
                    { type: 'command', command: 'node "/tmp/.claude-mem-lite/hook.mjs" session-start' },
                  ],
                },
              ],
              PostToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    { type: 'command', command: 'bash "/tmp/.claude-mem-lite/scripts/post-tool-use.sh"' },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
      );

      const output = runInstall('status', home);
      expect(output).toContain('Plugin: disabled in settings');
      expect(output).toContain('Hooks: still configured in settings.json while plugin is disabled');
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  it('cleanup-hooks removes only claude-mem-lite hooks and preserves other settings', () => {
    const home = makeTmpDir();
    try {
      const claudeDir = join(home, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      const settingsPath = join(claudeDir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            enabledPlugins: { 'claude-mem-lite@sdsrss': false, 'other@vendor': true },
            hooks: {
              SessionStart: [
                {
                  matcher: '*',
                  hooks: [
                    { type: 'command', command: 'node "/tmp/.claude-mem-lite/hook.mjs" session-start' },
                  ],
                },
                {
                  matcher: '*',
                  hooks: [{ type: 'command', command: 'node "/tmp/other-plugin/hook.mjs" startup' }],
                },
              ],
              PostToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    { type: 'command', command: 'bash "/tmp/.claude-mem-lite/scripts/post-tool-use.sh"' },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
      );

      const output = runInstall('cleanup-hooks', home);
      expect(output).toContain('Removed 2 claude-mem-lite hook configurations');

      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(settings.enabledPlugins['claude-mem-lite@sdsrss']).toBe(false);
      expect(settings.enabledPlugins['other@vendor']).toBe(true);
      expect(settings.hooks.PostToolUse).toBeUndefined();
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('other-plugin');
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  it('direct install clears stale disabled plugin flag without touching other plugin flags', () => {
    const settings = {
      enabledPlugins: {
        'claude-mem-lite@sdsrss': false,
        'other@vendor': true,
      },
    };

    expect(clearPluginDisabledMarkerForDirectInstall(settings)).toBe(true);
    expect(settings.enabledPlugins['claude-mem-lite@sdsrss']).toBeUndefined();
    expect(settings.enabledPlugins['other@vendor']).toBe(true);
  });

  it('marketplace cleanup detection preserves shared publisher caches when other plugins remain', () => {
    expect(
      hasOtherMarketplacePlugins({
        plugins: {
          'claude-mem-lite@sdsrss': {},
          'other-tool@sdsrss': {},
        },
      }),
    ).toBe(true);

    expect(
      hasOtherMarketplacePlugins({
        plugins: {
          'claude-mem-lite@sdsrss': {},
          'other-tool@vendor': {},
        },
      }),
    ).toBe(false);
  });

  it('uninstall removes plugin registry and cache when no other marketplace plugins remain', () => {
    const home = makeTmpDir();
    try {
      const claudeDir = join(home, '.claude');
      const pluginsDir = join(claudeDir, 'plugins');
      const marketplaceDir = join(pluginsDir, 'marketplaces', 'sdsrss');
      const cacheDir = join(pluginsDir, 'cache', 'sdsrss');
      mkdirSync(marketplaceDir, { recursive: true });
      mkdirSync(cacheDir, { recursive: true });
      mkdirSync(join(home, '.claude-mem-lite'), { recursive: true });
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify(
          {
            enabledPlugins: { 'claude-mem-lite@sdsrss': true },
            extraKnownMarketplaces: { sdsrss: { url: 'https://example.com' } },
            hooks: {
              SessionStart: [
                {
                  matcher: '*',
                  hooks: [
                    { type: 'command', command: 'node "/tmp/.claude-mem-lite/hook.mjs" session-start' },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(pluginsDir, 'installed_plugins.json'),
        JSON.stringify(
          {
            plugins: { 'claude-mem-lite@sdsrss': [{ version: '2.10.0' }] },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(pluginsDir, 'known_marketplaces.json'),
        JSON.stringify(
          {
            sdsrss: { url: 'https://example.com' },
          },
          null,
          2,
        ),
      );

      const binDir = makeFakeClaudeBin(home);
      const output = runInstall('uninstall', home, ['--purge'], { PATH: `${binDir}:${process.env.PATH}` });
      expect(output).toContain('Removed from installed_plugins.json');
      expect(output).toContain('Marketplace directory removed');
      expect(output).toContain('Plugin cache removed');
      expect(output).toContain('Removed from known_marketplaces.json');
      expect(output).toContain('Data purged');

      const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
      expect(settings.enabledPlugins?.['claude-mem-lite@sdsrss']).toBeUndefined();
      expect(settings.extraKnownMarketplaces?.sdsrss).toBeUndefined();
      expect(settings.hooks?.SessionStart).toBeUndefined();
      expect(existsSync(marketplaceDir)).toBe(false);
      expect(existsSync(cacheDir)).toBe(false);
      expect(existsSync(join(home, '.claude-mem-lite'))).toBe(false);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  it('plugin setup clears stale MCP registrations and links dependencies from data dir', () => {
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const pluginRoot = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      const marketplaceDir = join(home, '.claude', 'plugins', 'marketplaces', 'sdsrss');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(pluginRoot, { recursive: true });
      mkdirSync(marketplaceDir, { recursive: true });
      symlinkSync(resolve('node_modules'), join(dataDir, 'node_modules'));

      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify(
          {
            mcpServers: { mem: { command: 'node', args: ['old-server.mjs'] } },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(marketplaceDir, '.mcp.json'),
        JSON.stringify(
          {
            mcpServers: { mem: { command: 'node', args: ['old-plugin-server.mjs'] } },
          },
          null,
          2,
        ),
      );

      const output = execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      expect(output).toBe('');
      expect(readlinkSync(join(pluginRoot, 'node_modules'))).toBe(join(dataDir, 'node_modules'));

      const claudeJson = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
      expect(claudeJson.mcpServers?.mem).toBeUndefined();

      // Marketplace .mcp.json must NOT be cleared — Claude Code copies it to cache on updates
      const marketplaceMcp = JSON.parse(readFileSync(join(marketplaceDir, '.mcp.json'), 'utf8'));
      expect(marketplaceMcp.mcpServers?.mem).toBeDefined();

      expect(existsSync(join(dataDir, 'runtime', '.mcp-dedup-v2.78'))).toBe(true);
      expect(existsSync(join(dataDir, 'runtime'))).toBe(true);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  it('plugin setup re-clears stale global mem even if an older migration marker already exists', () => {
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const pluginRoot = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      mkdirSync(pluginRoot, { recursive: true });
      symlinkSync(resolve('node_modules'), join(dataDir, 'node_modules'));

      writeFileSync(join(dataDir, 'runtime', '.mcp-dedup-v2.10'), 'done\n');
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify(
          {
            mcpServers: { mem: { command: 'node', args: ['old-server.mjs'] } },
          },
          null,
          2,
        ),
      );

      const output = execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      expect(output).toBe('');
      const claudeJson = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
      expect(claudeJson.mcpServers?.mem).toBeUndefined();
      expect(existsSync(join(dataDir, 'runtime', '.mcp-dedup-v2.10'))).toBe(true);
      expect(existsSync(join(dataDir, 'runtime', '.mcp-dedup-v2.78'))).toBe(true);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  it('plugin setup skips MCP cleanup once current marker exists (v2.79.1 gate)', () => {
    // Regression guard: pre-v2.79.1 the MCP_MIGRATION marker was touched but
    // never read, so cleanup re-ran `node -e ... parse ~/.claude.json ...` on
    // every SessionStart even when nothing had changed. v2.79.1 gates entry on
    // marker absence — a present marker means "already migrated, leave it".
    // If a user later runs `claude mcp add mem ...` themselves, the gate
    // intentionally lets it stand (next version-marker bump re-triggers).
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const pluginRoot = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      mkdirSync(pluginRoot, { recursive: true });
      symlinkSync(resolve('node_modules'), join(dataDir, 'node_modules'));

      // Marker for the CURRENT migration version already exists
      writeFileSync(join(dataDir, 'runtime', '.mcp-dedup-v2.78'), 'done\n');
      // User has a global "mem" entry — gate should NOT auto-purge it
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify(
          {
            mcpServers: { mem: { command: 'node', args: ['user-added.mjs'] } },
          },
          null,
          2,
        ),
      );

      execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const claudeJson = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
      // The user's intentionally-added entry survives — gate trusted the marker
      expect(claudeJson.mcpServers?.mem).toEqual({ command: 'node', args: ['user-added.mjs'] });
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  it('plugin setup prunes old cache versions keeping latest 3', () => {
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const cacheBase = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      const pluginRoot = join(cacheBase, '2.21.0');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      symlinkSync(resolve('node_modules'), join(dataDir, 'node_modules'));

      // Create 5 version dirs
      for (const v of ['1.0.0', '2.0.0', '2.10.0', '2.20.0', '2.21.0']) {
        mkdirSync(join(cacheBase, v), { recursive: true });
      }

      writeFileSync(join(home, '.claude.json'), JSON.stringify({}, null, 2));

      execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const remaining = readdirSync(cacheBase)
        .filter((n) => /^\d+\./.test(n))
        .sort();
      expect(remaining).toHaveLength(3);
      // Oldest 2 should be removed
      expect(remaining).not.toContain('1.0.0');
      expect(remaining).not.toContain('2.0.0');
      expect(remaining).toContain('2.21.0');
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  // A20260905-R5-Q1. The case above runs from the NEWEST cached version, which is the only
  // arrangement keep-latest-3 is safe in. Rollback inverts it: a bad release is withdrawn from
  // the marketplace, Claude Code drops back to an older cached version, and the three newer
  // dirs are still on disk — so CLAUDE_PLUGIN_ROOT, the tree these very hooks and the MCP
  // server import from, is outside the keep window. setup.sh step 8 rm -rf'd it mid-session.
  it('plugin setup never prunes the version dir it is RUNNING from (marketplace rollback)', () => {
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const cacheBase = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      // Running from the OLDEST of four — rank 4 of 4, outside keep-latest-3.
      const pluginRoot = join(cacheBase, '3.90.0');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      symlinkSync(resolve('node_modules'), join(dataDir, 'node_modules'));

      for (const v of ['3.90.0', '3.94.0', '3.95.0', '3.96.0']) {
        mkdirSync(join(cacheBase, v), { recursive: true });
      }
      // A file inside it: `rm -rf` on the dir is what the guard has to prevent, and an empty
      // dir that got recreated later by some other step would read as "survived".
      writeFileSync(join(pluginRoot, 'server.mjs'), '// running version\n');
      writeFileSync(join(home, '.claude.json'), JSON.stringify({}, null, 2));

      execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      expect(existsSync(join(pluginRoot, 'server.mjs'))).toBe(true);
      // Sparing the running root must not disable pruning: nothing else is protected, and
      // with only four dirs and one spared there is nothing left to remove, so assert the
      // shape rather than a count — all four survive precisely because rank 4 is in use.
      const remaining = readdirSync(cacheBase)
        .filter((n) => /^\d+\./.test(n))
        .sort();
      expect(remaining).toEqual(['3.90.0', '3.94.0', '3.95.0', '3.96.0']);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  // Control for the case above: with the running root safely inside the keep window, the
  // guard changes nothing and step 8 still prunes. Without this, "the dirs survived" is
  // equally consistent with a step 8 that stopped running at all.
  it('CONTROL: pruning still removes the surplus when the running root is inside keep-latest-3', () => {
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const cacheBase = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      const pluginRoot = join(cacheBase, '3.96.0');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      symlinkSync(resolve('node_modules'), join(dataDir, 'node_modules'));

      for (const v of ['3.90.0', '3.94.0', '3.95.0', '3.96.0']) {
        mkdirSync(join(cacheBase, v), { recursive: true });
      }
      writeFileSync(join(home, '.claude.json'), JSON.stringify({}, null, 2));

      execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const remaining = readdirSync(cacheBase)
        .filter((n) => /^\d+\./.test(n))
        .sort();
      expect(remaining).toEqual(['3.94.0', '3.95.0', '3.96.0']);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });
});

// ─── D#24: install layer honors CLAUDE_MEM_DIR for DATA ───────────────────────
// Pre-fix install.mjs hardcoded DATA_DIR=homedir for everything while the runtime
// (schema.mjs DB_DIR) honored CLAUDE_MEM_DIR — so under relocation the installer
// wrote the DB/managed/registry to homedir but the runtime read the relocated dir
// (preinstalled skills vanished, doctor read the wrong DB). Now DB/managed/registry/
// runtime follow MEM_DATA_DIR (env-aware) while plugin CODE stays at homedir.
describe('D#24 install layer honors CLAUDE_MEM_DIR for data', () => {
  function captureInstall(command, home, extraEnv = {}) {
    try {
      return runInstall(command, home, [], extraEnv);
    } catch (e) {
      // doctor exits non-zero when it finds issues (not installed in a fresh fake HOME)
      return (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
    }
  }

  it('doctor reads the relocated DB (CLAUDE_MEM_DIR ≠ HOME), not the homedir code dir', () => {
    const home = makeTmpDir();
    const dataDir = join(makeTmpDir(), 'relocated-mem');
    mkdirSync(dataDir, { recursive: true });
    const db = new Database(join(dataDir, 'claude-mem-lite.db'));
    initSchema(db); // creates observations_fts → doctor reports "FTS5 index: present"
    db.close();
    try {
      const out = captureInstall('doctor', home, { CLAUDE_MEM_DIR: dataDir });
      expect(out).toMatch(/FTS5 index: present/); // read the relocated DB's FTS table
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('control: with no CLAUDE_MEM_DIR and an empty HOME, doctor finds no DB', () => {
    const home = makeTmpDir();
    try {
      const out = captureInstall('doctor', home);
      expect(out).not.toMatch(/FTS5 index: present/); // no DB seeded at the homedir code dir
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });
});
