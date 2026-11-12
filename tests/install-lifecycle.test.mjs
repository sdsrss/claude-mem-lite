import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  symlinkSync,
  readlinkSync,
  chmodSync,
  lstatSync,
} from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import {
  clearPluginDisabledMarkerForDirectInstall,
  hasOtherMarketplacePlugins,
  projectScopedMemRegistrations,
} from '../install.mjs';
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
      // Realistic layout: Claude Code materializes versions under
      // cache/<marketplace>/<plugin>/<version>/, never straight into cache/<marketplace>/.
      // The flat directory this fixture used to create meant uninstall's own-plugin cache
      // branch was never exercised here, so the two deletes could not be told apart.
      mkdirSync(join(cacheDir, 'claude-mem-lite', '2.10.0'), { recursive: true });
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
      // TWO deletes, and they are different scopes: our own version cache goes
      // unconditionally, the marketplace-wide directory only when nothing else uses it.
      // On this fixture (no sibling plugin) both fire.
      expect(output).toContain('Plugin cache removed');
      expect(output).toContain('Marketplace cache directory removed');
      expect(existsSync(cacheDir)).toBe(false);
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

  // D#829 (D#811 retry; 6.33.0 pre-tag review, defects F9): with ~/.claude-mem-lite a symbolic
  // link, rmSync took the link alone, printed "Data purged" and "Done!", and the store stayed
  // behind it. The first fix removed the link and then let the relocated purge decide, and a
  // CLAUDE_MEM_DIR naming the link's target by another spelling ended in "Done!" with the store
  // left (r2 R2-1). Now a link means the purge removes nothing at all, the link included, and
  // says so; CLAUDE_MEM_DIR is not purged either, however it is spelled.
  const purgeWith = (home, memDir, nodeArgs = []) => {
    const env = { ...process.env, HOME: home, PATH: `${makeFakeClaudeBin(home)}:${process.env.PATH}` };
    delete env.CLAUDE_MEM_DIR;
    if (memDir !== undefined) env.CLAUDE_MEM_DIR = memDir;
    const r = spawnSync(process.execPath, [...nodeArgs, INSTALL_PATH, 'uninstall', '--purge'], {
      encoding: 'utf8',
      env,
    });
    return { output: r.stdout + r.stderr, status: r.status };
  };
  const files = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
      .sort();
  const seed = (dir, names) => {
    for (const f of names) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), 'x');
    }
  };
  // The output's lines: asserting one whole line pins its status mark and its end.
  const lines = (output) => output.split('\n');
  describe('uninstall --purge with ~/.claude-mem-lite a symbolic link', () => {
    const STORE = ['claude-mem-lite.db', 'server.mjs', 'my-notes.txt', 'runtime/session.json'];

    // Each shape: how the link is spelled, and the CLAUDE_MEM_DIR beside it (undefined = unset).
    const SHAPES = {
      'absolute link': (home) => ({ to: join(home, 'data', 'mem') }),
      'relative link, named as spelled': () => ({ to: join('data', 'mem') }),
      'CLAUDE_MEM_DIR = the target': (home) => ({
        to: join(home, 'data', 'mem'),
        mem: join(home, 'data', 'mem'),
      }),
      'CLAUDE_MEM_DIR = the link with a trailing slash': (home) => ({
        to: join(home, 'data', 'mem'),
        mem: join(home, '.claude-mem-lite') + '/',
      }),
      'CLAUDE_MEM_DIR = the link with /.': (home) => ({
        to: join(home, 'data', 'mem'),
        mem: join(home, '.claude-mem-lite') + '/.',
      }),
      'CLAUDE_MEM_DIR = a directory inside the target': (home) => ({
        to: join(home, 'data', 'mem'),
        mem: join(home, 'data', 'mem', 'sub'),
        extra: { 'data/mem/sub': ['claude-mem-lite.db'] },
      }),
      'CLAUDE_MEM_DIR = an unrelated directory': (home) => ({
        to: join(home, 'data', 'mem'),
        mem: join(home, 'other'),
        extra: { other: ['claude-mem-lite.db'] },
      }),
    };

    for (const [name, shape] of Object.entries(SHAPES)) {
      it(`removes nothing and does not say Done: ${name}`, () => {
        const home = makeTmpDir();
        try {
          const { to, mem, extra = {} } = shape(home);
          seed(join(home, 'data', 'mem'), STORE);
          for (const [dir, names] of Object.entries(extra)) seed(join(home, dir), names);
          symlinkSync(to, join(home, '.claude-mem-lite'));
          const before = files(join(home, 'data'));
          const others = mem && extra.other ? files(join(home, 'other')) : null;
          const { output, status } = purgeWith(home, mem);
          expect(lstatSync(join(home, '.claude-mem-lite')).isSymbolicLink()).toBe(true);
          expect(readlinkSync(join(home, '.claude-mem-lite'))).toBe(to);
          expect(files(join(home, 'data'))).toEqual(before);
          if (others) expect(files(join(home, 'other'))).toEqual(others);
          // The whole line, so a CLAUDE_MEM_DIR named when unset fails (review F5), and so does a
          // sentence appended after it or a success mark (D#836: review r2 R2-1, R2-3).
          expect(lines(output)).toContain(
            `  ⚠ ~/.claude-mem-lite is a link to ${to}. --purge does not delete through a link, so it removed nothing` +
              (mem === undefined ? '.' : ` (CLAUDE_MEM_DIR ${mem} included).`),
          );
          expect(output).not.toMatch(/Data purged|Relocated data purged|Done!/);
          expect(output).toContain('the purge is incomplete');
          expect(status).toBe(1);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });
    }

    it('a link to nothing, or to a file, stays, and the purge is not done', () => {
      const home = makeTmpDir();
      try {
        writeFileSync(join(home, 'notes.txt'), 'mine');
        for (const to of [join(home, 'gone'), join(home, 'notes.txt')]) {
          symlinkSync(to, join(home, '.claude-mem-lite'));
          const { output, status } = purgeWith(home);
          expect(readlinkSync(join(home, '.claude-mem-lite')), to).toBe(to);
          expect(lines(output), to).toContain(
            `  ⚠ ~/.claude-mem-lite is a link to ${to}. --purge does not delete through a link, so it removed nothing.`,
          );
          expect(output, to).not.toMatch(/Data purged|Done!/);
          expect(status, to).toBe(1);
          rmSync(join(home, '.claude-mem-lite'));
        }
        expect(readFileSync(join(home, 'notes.txt'), 'utf8')).toBe('mine');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  // D#815 (6.33.0 pre-tag claims F8): an entry of ~/.claude-mem-lite it may not remove threw out
  // of rmSync, uncaught, so the relocated CLAUDE_MEM_DIR was never reached and no line said what
  // was left. The failure is named, the purge is not done, and the relocated purge still runs.
  it('uninstall --purge names what it could not remove in ~/.claude-mem-lite and still purges CLAUDE_MEM_DIR', () => {
    const home = makeTmpDir();
    const locked = join(home, '.claude-mem-lite', 'locked');
    try {
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, 'inner.txt'), 'x');
      writeFileSync(join(home, '.claude-mem-lite', 'claude-mem-lite.db'), 'x');
      mkdirSync(join(home, 'reloc'));
      writeFileSync(join(home, 'reloc', 'claude-mem-lite.db'), 'x');
      chmodSync(locked, 0o555);
      const env = {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: join(home, 'reloc'),
        PATH: `${makeFakeClaudeBin(home)}:${process.env.PATH}`,
      };
      const r = spawnSync(process.execPath, [INSTALL_PATH, 'uninstall', '--purge'], {
        encoding: 'utf8',
        env,
      });
      const output = r.stdout + r.stderr;
      chmodSync(locked, 0o700);
      expect(lines(output)).toContain('  ⚠ Could not remove ~/.claude-mem-lite (EACCES).');
      expect(output).not.toMatch(/Data purged \(|Done!|^\s+at /m);
      expect(existsSync(join(locked, 'inner.txt'))).toBe(true);
      expect(existsSync(join(home, 'reloc', 'claude-mem-lite.db'))).toBe(false);
      expect(output).toContain('the purge is incomplete');
      expect(r.status).toBe(1);
    } finally {
      if (existsSync(locked)) chmodSync(locked, 0o700);
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The line names the code the removal failed with, not EACCES alone (D#836: review r2 R2-3). A
  // preload stands in for a removal that throws EBUSY, which no unprivileged fixture can produce.
  it('uninstall --purge names the code the removal of ~/.claude-mem-lite failed with', () => {
    const home = makeTmpDir();
    const dir = join(home, '.claude-mem-lite');
    try {
      seed(dir, ['claude-mem-lite.db', 'runtime/session.json']);
      const preload = join(home, 'rm-throws-ebusy.mjs');
      writeFileSync(
        preload,
        [
          "import fs from 'node:fs';",
          "import { syncBuiltinESMExports } from 'node:module';",
          'const real = fs.rmSync;',
          'fs.rmSync = (p, ...rest) => {',
          "  if (!String(p).endsWith('/.claude-mem-lite')) return real(p, ...rest);",
          "  throw Object.assign(new Error('EBUSY: resource busy or locked, rm'), { code: 'EBUSY' });",
          '};',
          'syncBuiltinESMExports();',
        ].join('\n'),
      );
      const { output, status } = purgeWith(home, undefined, ['--import', preload]);
      expect(output).toMatch(/claude-mem-lite uninstaller/); // the preload loaded and install ran
      expect(lines(output)).toContain('  ⚠ Could not remove ~/.claude-mem-lite (EBUSY).');
      expect(output).not.toMatch(/Data purged|Done!/);
      expect(output).toContain('the purge is incomplete');
      expect(status).toBe(1);
      expect(existsSync(join(dir, 'claude-mem-lite.db'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // D#835 (D#829 reviews r1 F2, r2 X1): two more ways the purge said "Data purged" and "Done!"
  // and exited 0 with the store left. A link INSIDE a real ~/.claude-mem-lite (the store, runtime/)
  // was unlinked and what it pointed to stayed; and rmSync returned normally with the directory
  // still there while another process deleted files in it (7 of 12 runs, tasks/d835/race.mjs).
  describe('uninstall --purge with data left behind ~/.claude-mem-lite', () => {
    const INNER = {
      'the store a link to a file elsewhere': (home) => ({
        links: { 'claude-mem-lite.db': join(home, 'ext', 'store.db') },
      }),
      'the store a relative link, named as spelled': () => ({
        links: { 'claude-mem-lite.db': join('..', 'ext', 'store.db') },
      }),
      'runtime/ a link to a directory elsewhere': (home) => ({
        links: { runtime: join(home, 'ext', 'rt') },
      }),
      'two links, both named': (home) => ({
        links: { 'claude-mem-lite.db': join(home, 'ext', 'store.db'), runtime: join(home, 'ext', 'rt') },
      }),
      'CLAUDE_MEM_DIR = an unrelated directory': (home) => ({
        links: { 'claude-mem-lite.db': join(home, 'ext', 'store.db') },
        mem: join(home, 'other'),
      }),
    };

    for (const [name, shape] of Object.entries(INNER)) {
      it(`removes nothing and does not say Done: ${name}`, () => {
        const home = makeTmpDir();
        const dir = join(home, '.claude-mem-lite');
        try {
          const { links, mem } = shape(home);
          seed(join(home, 'ext'), ['store.db', 'rt/session.json']);
          seed(dir, ['metrics/2026-11-12.jsonl', 'notes.txt']);
          if (mem) seed(mem, ['claude-mem-lite.db']);
          for (const [n, to] of Object.entries(links)) symlinkSync(to, join(dir, n));
          const before = { ext: files(join(home, 'ext')), dir: files(dir), mem: mem && files(mem) };
          const { output, status } = purgeWith(home, mem);
          for (const [n, to] of Object.entries(links)) {
            expect(lstatSync(join(dir, n)).isSymbolicLink(), n).toBe(true);
            expect(readlinkSync(join(dir, n)), n).toBe(to);
          }
          expect(files(join(home, 'ext'))).toEqual(before.ext);
          expect(files(dir)).toEqual(before.dir);
          if (mem) expect(files(mem)).toEqual(before.mem);
          const named = Object.keys(links)
            .sort()
            .map((n) => `~/.claude-mem-lite/${n} is a link to ${links[n]}`)
            .join(', ');
          expect(lines(output)).toContain(
            `  ⚠ ${named}. --purge does not delete through a link, so it removed nothing` +
              (mem === undefined ? '.' : ` (CLAUDE_MEM_DIR ${mem} included).`),
          );
          expect(output).not.toMatch(/Data purged|Relocated data purged|Done!/);
          expect(output).toContain('the purge is incomplete');
          expect(status).toBe(1);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });
    }

    // A dev install links its code into ~/.claude-mem-lite on purpose (deployCodeTree): those links
    // go, as before, and what they point to stays.
    it('removes the links a dev install makes, and not what they point to', () => {
      const home = makeTmpDir();
      const dir = join(home, '.claude-mem-lite');
      try {
        seed(join(home, 'repo'), ['cli.mjs', 'node_modules/x/index.js', 'scripts/setup.sh']);
        seed(dir, ['claude-mem-lite.db', 'runtime/session.json']);
        for (const n of ['cli.mjs', 'node_modules', 'scripts'])
          symlinkSync(join(home, 'repo', n), join(dir, n));
        const before = files(join(home, 'repo'));
        const { output, status } = purgeWith(home);
        expect(output).toContain('Data purged (~/.claude-mem-lite/)');
        expect(output).toContain('Done!');
        expect(status).toBe(0);
        expect(existsSync(dir)).toBe(false);
        expect(files(join(home, 'repo'))).toEqual(before);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    // The race itself cannot be scheduled in a test, so a preload makes rmSync do what it was
    // seen doing under it: return normally with part of the tree, the store included, still there.
    it('does not say Data purged when ~/.claude-mem-lite is still there after the removal returns', () => {
      const home = makeTmpDir();
      const dir = join(home, '.claude-mem-lite');
      try {
        seed(dir, ['claude-mem-lite.db', 'runtime/session.json', 'metrics/2026-11-12.jsonl']);
        const preload = join(home, 'rm-returns-early.mjs');
        writeFileSync(
          preload,
          [
            "import fs from 'node:fs';",
            "import { join } from 'node:path';",
            "import { syncBuiltinESMExports } from 'node:module';",
            'const real = fs.rmSync;',
            'fs.rmSync = (p, ...rest) => {',
            "  if (!String(p).endsWith('/.claude-mem-lite')) return real(p, ...rest);",
            "  for (const e of fs.readdirSync(p)) if (e !== 'claude-mem-lite.db') real(join(p, e), ...rest);",
            '};',
            'syncBuiltinESMExports();',
          ].join('\n'),
        );
        const { output, status } = purgeWith(home, undefined, ['--import', preload]);
        expect(output).toMatch(/claude-mem-lite uninstaller/); // the preload loaded and install ran
        expect(existsSync(join(dir, 'runtime'))).toBe(false); // and the stand-in removed something
        expect(lines(output)).toContain(
          '  ⚠ Could not remove ~/.claude-mem-lite: it was still there when the removal returned.',
        );
        expect(output).not.toMatch(/Data purged|Done!/);
        expect(output).toContain('the purge is incomplete');
        expect(status).toBe(1);
        expect(existsSync(join(dir, 'claude-mem-lite.db'))).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  // R32 E2E install F1 (P0): with CLAUDE_MEM_DIR relocated, --purge removed the WHOLE directory
  // once it held claude-mem-lite.db, so files a user keeps beside the store went with it. Only
  // what claude-mem-lite writes there is removed; anything else stays, and the output says so.
  describe('uninstall --purge with a relocated CLAUDE_MEM_DIR', () => {
    // Names claude-mem-lite really writes there, in the formats its writers use (R32 reviews:
    // the first cut matched top-level names only and took backups/, metrics/, errors/ whole; the
    // second took any `claude-mem-lite.db.*` and any `.update-backup-*`, user files included).
    const OURS = [
      'claude-mem-lite.db',
      'claude-mem-lite.db-wal',
      'claude-mem-lite.db-shm',
      'claude-mem-lite.db-journal',
      'claude-mem-lite.db.pre-delete-2026-11-11T00-00-00-000Z-1-1.bak',
      'claude-mem-lite.db.pre-delete-2026-11-11T00-00-00-000Z-1-1.bak-journal', // a killed VACUUM INTO
      'claude-mem-lite.db.legacy-backup-1700000000',
      'claude-mem-lite.db.legacy-backup-1700000000-wal',
      'claude-mem-lite.db.legacy-backup-1700000000-shm',
      'claude-mem-lite.db-wal.legacy-backup-1700000000000',
      'claude-mem-lite.db-shm.legacy-backup-1700000000000',
      'claude-mem-lite.db.corrupt-2026-11-11T00-00-00-000Z',
      'claude-mem-lite.db.corrupt-2026-11-11T00-00-00-000Z-wal',
      'claude-mem-lite.db.corrupt', // the set-aside name an earlier remedy told users to `mv` to
      'claude-mem.db',
      'claude-mem.db-wal',
      'resource-registry.db',
      'resource-registry.db-wal',
      'resource-registry.db-shm',
      'resource-registry.db-journal',
      'plugin_claude_mem_lite.md',
      'plugin_claude_mem_lite.md.tmp-4242',
      '.legacy-backup-copy-4242-1700000000',
      '.legacy-backup-copy-4242-1700000000-shm',
      '.legacy-backup-setup-4242-1700000000',
      '.legacy-backup-setup-4242-1700000000-wal',
      '.snapshot-check-4242-abc123/probe.db',
      '.update-staging-1700000000000-4242/hook.mjs',
      '.update-backup-1700000000000-4242/hook.mjs',
      '.update-backup-s2-1700000000000-4242/hook.mjs',
      'runtime/session.json',
      'runtime/hook-errors/2026-11-11.json',
      'managed/repos/superpowers/README.md', // resource clones from releases before 5.0.0
      'managed/skills/foo/SKILL.md',
      'metrics/2026-11-11.jsonl',
      'errors/2026-11-11.jsonl',
      'backups/verify-2026-11-11T00-00-00-000Z-a1b2c3.json',
      'backups/verify-2026-11-11T00-00-00-000Z-a1b2c3.json.tmp-4242',
    ];
    // A user's own files: several sit in directories that share the product's names, or carry
    // names that start like the product's. `before-upgrade.bak` is the hand-made copy
    // lib/db-backup.mjs names as one no sweep may take; `verify-settings.json` sits beside
    // verify-apply's backups and matched their pattern when it was looser than their writer's.
    const THEIRS = [
      'notes.txt',
      'taxes/2025.pdf',
      'backups/photos/wedding.jpg',
      'backups/old-laptop.tar',
      'backups/verify-passport.pdf',
      'backups/verify-settings.json',
      'claude-mem-lite.db.before-upgrade.bak',
      'metrics/q3-revenue.csv',
      'metrics/notes.jsonl',
      'metrics/2026-01-02.jsonl/inner.txt',
      'errors/notes.txt',
      'errors/my-log.jsonl',
      'claude-mem-lite.db-schema-notes.md',
      'claude-mem-lite.db.notes.txt',
      'claude-mem-lite.db.corrupt-notes.txt',
      'claude-mem-lite.db.mine/my-manual-copy.db',
      'claude-mem.dbx-thesis.tex',
      'claude-mem.db.old',
      '.update-backup-mine/f',
    ];
    const seed = (dir, files) => {
      for (const f of files) {
        mkdirSync(join(dir, f, '..'), { recursive: true });
        writeFileSync(join(dir, f), 'x');
      }
    };
    const purge = (home, dir, nodeArgs = []) => {
      const r = spawnSync(process.execPath, [...nodeArgs, INSTALL_PATH, 'uninstall', '--purge'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          CLAUDE_MEM_DIR: dir,
          PATH: `${makeFakeClaudeBin(home)}:${process.env.PATH}`,
        },
      });
      return { output: r.stdout + r.stderr, status: r.status };
    };
    const tree = (dir) =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
        .sort();

    // runtime/ and managed/ are its own, but it cannot tell every file inside them from one a
    // user put there; beside the user's files they stay, named, and the purge is not done
    // (R33 review H2: they went whole, a user's runtime/my-notes.txt with them).
    const WHOLE = OURS.filter((f) => /^(runtime|managed)\//.test(f));
    it("removes every file it wrote and none of the user's, and names what it kept", () => {
      const home = makeTmpDir();
      try {
        const dir = join(home, 'shared');
        seed(dir, [...OURS, ...THEIRS]);
        const { output, status } = purge(home, dir);
        expect(tree(dir)).toEqual([...THEIRS, ...WHOLE].sort());
        expect(output).toMatch(/[ ,]notes\.txt/);
        expect(output).toMatch(/backups\/photos/);
        expect(output).toMatch(/Left managed, runtime in /);
        expect(output).not.toMatch(/Relocated data purged|Done!/);
        expect(status).not.toBe(0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("keeps a user's files inside runtime/ when the directory holds files of theirs", () => {
      const home = makeTmpDir();
      try {
        const dir = join(home, 'work');
        const mine = ['metrics/q3-revenue.csv', 'runtime/my-notes.txt', 'runtime/my-service/config.yaml'];
        seed(dir, ['claude-mem-lite.db', 'claude-mem-lite.db-wal', 'runtime/session.json', ...mine]);
        const { output, status } = purge(home, dir);
        expect(tree(dir)).toEqual([...mine, 'runtime/session.json'].sort());
        expect(output).toMatch(/Left runtime in /);
        expect(output).not.toMatch(/Done!/);
        expect(status).not.toBe(0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('removes the directory when it held only claude-mem-lite files', () => {
      const home = makeTmpDir();
      try {
        const dir = join(home, 'mem');
        seed(dir, OURS);
        const { output } = purge(home, dir);
        expect(existsSync(dir)).toBe(false);
        expect(output).toContain(`Relocated data purged (${dir})`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    // One of its directory names as a link to somewhere else: listed, never followed.
    it('does not follow a symlink under one of its directory names', () => {
      const home = makeTmpDir();
      try {
        const dir = join(home, 'linked');
        const elsewhere = join(home, 'elsewhere');
        seed(dir, ['claude-mem-lite.db']);
        seed(elsewhere, ['2026-01-01.jsonl']);
        symlinkSync(elsewhere, join(dir, 'metrics'));
        const { output } = purge(home, dir);
        expect(tree(elsewhere)).toEqual(['2026-01-01.jsonl']);
        expect(output).toMatch(/metrics/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    // A directory that cannot be listed must not take the "nothing else is here" path, which
    // removes the directory; and a purge that did not happen is not reported as done.
    it('removes nothing when the directory cannot be listed', () => {
      const home = makeTmpDir();
      const dir = join(home, 'locked');
      try {
        seed(dir, ['claude-mem-lite.db', 'notes.txt']);
        chmodSync(dir, 0o300);
        const { output, status } = purge(home, dir);
        chmodSync(dir, 0o700);
        expect(tree(dir)).toEqual(['claude-mem-lite.db', 'notes.txt']);
        expect(output).toMatch(/Could not list/);
        expect(output).not.toMatch(/Relocated data purged|Done!/);
        expect(status).not.toBe(0);
      } finally {
        chmodSync(dir, 0o700);
        rmSync(home, { recursive: true, force: true });
      }
    });

    // existsSync() is false on EACCES too, so a store it could not even look for was reported
    // absent: "has no claude-mem-lite.db" (untrue), then "Done!" and exit 0 (R32 depth-2 review
    // M1). Three ways to be unable to look: the directory unreadable and unsearchable, readable
    // but not searchable, and its parent not searchable.
    it('does not report a store it could not look for as absent', () => {
      const home = makeTmpDir();
      const parent = join(home, 'p');
      const dir = join(parent, 'data');
      try {
        for (const [locked, mode] of [
          [dir, 0o000],
          [dir, 0o600],
          [parent, 0o000],
        ]) {
          seed(dir, ['claude-mem-lite.db', 'notes.txt']);
          chmodSync(locked, mode);
          const { output, status } = purge(home, dir);
          chmodSync(locked, 0o700);
          const shape = `${locked === dir ? 'data dir' : 'parent'} ${mode.toString(8)}`;
          expect(tree(dir), shape).toEqual(['claude-mem-lite.db', 'notes.txt']);
          expect(output, shape).toMatch(/Could not look for claude-mem-lite\.db/);
          expect(output, shape).not.toMatch(/has no claude-mem-lite\.db|Relocated data purged|Done!/);
          expect(status, shape).not.toBe(0);
        }
      } finally {
        for (const d of [parent, dir]) if (existsSync(d)) chmodSync(d, 0o700);
        rmSync(home, { recursive: true, force: true });
      }
    });

    // ...whereas a CLAUDE_MEM_DIR with no store in it (a mistyped one; or a file, where stat says
    // ENOTDIR) is not ours to touch: "left untouched", not a lookup that failed.
    it('leaves a CLAUDE_MEM_DIR with no store in it untouched and says why', () => {
      const home = makeTmpDir();
      try {
        const dir = join(home, 'mistyped');
        const file = join(home, 'not-a-dir');
        seed(dir, ['notes.txt', 'metrics/2026-11-11.jsonl']);
        writeFileSync(file, 'mine');
        for (const target of [dir, file]) {
          const { output, status } = purge(home, target);
          expect(output, target).toMatch(/has no claude-mem-lite\.db — left untouched/);
          expect(status, target).toBe(0);
        }
        expect(tree(dir)).toEqual(['metrics/2026-11-11.jsonl', 'notes.txt']);
        expect(readFileSync(file, 'utf8')).toBe('mine');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    // What is left after a failed unlink decides the report, not the error code alone. A shard a
    // live session pruned between the listing and the unlink (ENOENT) is gone, as wanted; a file
    // of its own that will not go (EPERM: on Linux an immutable file, or another user's in a
    // sticky dir) is a failure, not an entry it "does not recognise". Neither can be produced
    // here without root, so a preload makes unlink answer that way (R32 depth-2 review L3, L4).
    it('counts a shard pruned meanwhile as removed, and its own file it may not remove as a failure', () => {
      const home = makeTmpDir();
      try {
        const dir = join(home, 'live');
        seed(dir, ['claude-mem-lite.db', 'metrics/2026-01-01.jsonl', 'errors/2026-01-01.jsonl']);
        const preload = join(home, 'unlink-faults.mjs');
        writeFileSync(
          preload,
          [
            "import fs from 'node:fs';",
            "import { syncBuiltinESMExports } from 'node:module';",
            'const real = fs.unlinkSync;',
            'fs.unlinkSync = (p, ...rest) => {',
            "  if (String(p).endsWith('/metrics/2026-01-01.jsonl')) real(p);",
            "  if (String(p).endsWith('/errors/2026-01-01.jsonl'))",
            "    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });",
            '  return real(p, ...rest);',
            '};',
            'syncBuiltinESMExports();',
          ].join('\n'),
        );
        const { output, status } = purge(home, dir, ['--import', preload]);
        expect(output).toMatch(/claude-mem-lite uninstaller/); // the preload loaded and install ran
        expect(existsSync(join(dir, 'metrics'))).toBe(false);
        expect(output).not.toMatch(/metrics\/2026-01-01\.jsonl/);
        // the store stays while one of its own entries does: a re-run must still find it
        expect(tree(dir)).toEqual(['claude-mem-lite.db', 'errors/2026-01-01.jsonl']);
        expect(output).toMatch(/Could not remove[^\n]*errors\/2026-01-01\.jsonl \(EPERM\)/);
        expect(output).not.toMatch(/does not recognise[^\n]*errors/);
        expect(status).not.toBe(0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('says which of its own entries it could not remove, and does not claim the purge', () => {
      const home = makeTmpDir();
      const dir = join(home, 'stuck');
      const locked = [join(dir, 'runtime'), join(dir, 'errors'), join(dir, 'metrics')];
      try {
        seed(dir, [
          'claude-mem-lite.db',
          'runtime/install.lock',
          'errors/2026-11-11.jsonl',
          'metrics/2026-11-11.jsonl',
        ]);
        chmodSync(locked[0], 0o500); // its entries cannot be removed
        chmodSync(locked[1], 0o300); // it cannot be listed
        chmodSync(locked[2], 0o600); // listed, but neither unlink nor lstat can reach the shard
        const { output, status } = purge(home, dir);
        for (const d of locked) chmodSync(d, 0o700);
        expect(output).toMatch(/Could not remove[^\n]*runtime/);
        expect(output).toMatch(/Could not remove[^\n]*errors/);
        expect(output).toMatch(/Could not remove[^\n]*metrics\/2026-11-11\.jsonl \(EACCES\)/);
        expect(output).not.toMatch(/Relocated data purged|Done!/);
        expect(status).not.toBe(0);
        // R33 review M2: the first run removed the store, so the run the message asks for found
        // "no claude-mem-lite.db", left the rest and said Done!. The store now goes last.
        expect(tree(dir)).toContain('claude-mem-lite.db');
        expect(output).toMatch(/claude-mem-lite\.db stays until they go/);
        const again = purge(home, dir);
        expect(again.output).toMatch(/Done!/);
        expect(again.status).toBe(0);
        expect(existsSync(dir)).toBe(false);
      } finally {
        for (const d of locked) if (existsSync(d)) chmodSync(d, 0o700);
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  // A plain uninstall said "Data preserved (use --purge to remove)". True, and it named
  // the wrong half of what is left: on a real sandbox install the DB was 0.2MB while the
  // now-unreachable code and node_modules were 53MB — the symlink, hooks and MCP entry are
  // all gone, so nothing runs them, and nothing told the user they were still there.
  // Both numbers are reported now, and this asserts the SPLIT: a byte planted in the DB
  // must be counted as memory, a byte planted under node_modules must not.
  it('uninstall reports both halves of what it leaves behind, split correctly', () => {
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      mkdirSync(join(dataDir, 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), '{}');
      // 3 MiB of "memories" (DB + one snapshot, matching readSnapshots' prefix rule) and
      // 7 MiB of "rest" — distinct sizes so a swapped or merged number cannot read as pass.
      writeFileSync(join(dataDir, 'claude-mem-lite.db'), Buffer.alloc(2 * 1024 * 1024));
      writeFileSync(join(dataDir, 'claude-mem-lite.db.v1.bak'), Buffer.alloc(1024 * 1024));
      writeFileSync(join(dataDir, 'node_modules', 'pkg', 'big.bin'), Buffer.alloc(6 * 1024 * 1024));
      writeFileSync(join(dataDir, 'cli.mjs'), Buffer.alloc(1024 * 1024));

      const binDir = makeFakeClaudeBin(home);
      const output = runInstall('uninstall', home, [], { PATH: `${binDir}:${process.env.PATH}` });

      expect(output).toMatch(/Data preserved: memories in .*\.claude-mem-lite \(3\.0MB\)/);
      expect(output).toMatch(/Also kept: the installed code \+ node_modules under .* \(7\.0MB\)/);
      expect(output).toContain('`uninstall --purge` removes the directory, memories included');
      // The claim the message makes about the memories has to be true.
      expect(existsSync(join(dataDir, 'claude-mem-lite.db'))).toBe(true);
      expect(existsSync(join(dataDir, 'claude-mem-lite.db.v1.bak'))).toBe(true);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  // The probe must never be the thing that fails an uninstall: an unreadable or absent
  // data dir degrades to the short sentence, it does not throw. Driven by removing the
  // directory entirely, which is the shape a second uninstall run hits.
  it('uninstall still completes when there is nothing left to measure', () => {
    const home = makeTmpDir();
    try {
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), '{}');
      const binDir = makeFakeClaudeBin(home);
      const output = runInstall('uninstall', home, [], { PATH: `${binDir}:${process.env.PATH}` });
      expect(output).toContain('Done!');
      expect(output).toMatch(/Data preserved: memories in .* \(0\.0MB\)/);
      expect(output).not.toContain('Also kept:');
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  // `install` used to run `claude mcp remove -s project <name>` as part of "purge any
  // pre-existing registration before re-registering". That command edits `<cwd>/.mcp.json`,
  // which belongs to whatever repository the user is standing in — not to this installer.
  // Measured 2026-09-08: running the installer from a clone of THIS repo emptied the tracked
  // root `.mcp.json` (the plugin's own MCP manifest, and a RELEASE_SIGNED_FILES entry) with
  // no output saying so; the only thing that noticed was tests/plugin-manifest.test.mjs.
  //
  // The fake `claude` here implements that removal for real, so the case measures the
  // consequence (a rewritten project file) rather than only the argv. Both are asserted:
  // the argv, because that is the decision, and the file, because that is the harm.
  //
  // The 90 s budget is this case's own, not the global `testTimeout: 20000`, because it is
  // the only case in this file that runs a full `install` in a child process — it spends
  // ~5 s of real work where the next-slowest case here spends 417 ms. Measured 2026-09-22
  // on one box, same tree, six readings of THIS case: 4970 / 5122 / 5154 ms with the
  // machine otherwise idle, and 23958 / 29385 / 40908 ms while two other agent sessions
  // were running `npm test` concurrently. The spread is contention, not work: the arms that
  // read 5 s and 41 s were taken back-to-back minutes apart with no edit between them, so
  // neither number is the case's cost — 5 s is, and 41 s is what 5 s becomes on a busy box.
  //
  // It was 60 s first, sized to clear 40908 ms by 47%. That was one box's worst so far, and
  // pre-ship review beat it within the hour: this file's sibling case in
  // tests/doctor-survives-bad-settings.test.mjs read 67327 ms and timed out at 60 s once in
  // about 20 full-suite runs, at load average 11-14 with two reviewers' suites running. 90 s
  // is a budget seven other cases in this repo already carry, and clears that by 34%. It is
  // still a guess about the next busy box, not a bound, and it is not a ruler: no assertion
  // above is touched, and the budget still says NO, at ~18x the measured cost.
  //
  // The class is wider than this case and is NOT fixed here (D#25, D#50). How wide depends
  // on the counting rule, so here is one: files matching
  // `execFileSync\(process\.execPath|spawnSync\(process\.execPath|INSTALL_PATH` numbered 75
  // when this budget was added (76 once this release's doctor test landed), and 13 of them
  // give any case a literal `}, <ms>);` budget — 14 if a budget written as a named constant
  // counts. A broader rule found 96 and 19; either way most such files run on the global
  // 20 s. The
  // repo has also measured the other half of this — vitest.config.mjs records one IO-heavy
  // file running 14.4x slower on the CI runner than locally. This case passes on CI today,
  // so what is being bought here is local-contention headroom, not CI headroom.
  it('install never edits the project-scoped .mcp.json it is standing in', () => {
    const home = makeTmpDir();
    try {
      const projectDir = join(home, 'someones-repo');
      const binDir = join(home, 'bin');
      const logPath = join(home, 'claude-argv.log');
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      mkdirSync(join(home, '.claude-mem-lite'), { recursive: true });
      // Real node_modules, so install's better-sqlite3 check finds a working binding.
      symlinkSync(resolve('node_modules'), join(home, '.claude-mem-lite', 'node_modules'));

      const mcpPath = join(projectDir, '.mcp.json');
      const original = JSON.stringify(
        {
          mcpServers: { 'mem-lite': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs'] } },
        },
        null,
        2,
      );
      writeFileSync(mcpPath, original);

      const fakeClaude = join(binDir, 'claude');
      writeFileSync(
        fakeClaude,
        [
          '#!/usr/bin/env bash',
          `printf '%s\\n' "$*" >> "${logPath}"`,
          '# Implement `mcp remove -s project <name>` the way the real CLI does: edit ./.mcp.json',
          'if [[ "$1" == "mcp" && "$2" == "remove" && "$3" == "-s" && "$4" == "project" ]]; then',
          `  node -e 'const f=".mcp.json";const fs=require("fs");try{const d=JSON.parse(fs.readFileSync(f,"utf8"));delete d.mcpServers[process.argv[1]];fs.writeFileSync(f,JSON.stringify(d,null,2))}catch{}' "$5"`,
          'fi',
          'exit 0',
        ].join('\n'),
      );
      execFileSync('chmod', ['+x', fakeClaude]);
      // D#439: install's dependency step runs `npm install` in the sandbox HOME, which reached
      // the repo's own node_modules through the link above and, now and then, rebuilt
      // better-sqlite3 with node-gyp and timed out fetching headers from nodejs.org. A copy
      // install now removes that link first (R32: npm with `force` set writes through it), so
      // this npm stands in for the real one by providing the dependencies — linking the repo's,
      // without rebuilding anything.
      const fakeNpm = join(binDir, 'npm');
      writeFileSync(
        fakeNpm,
        `#!/usr/bin/env bash\n[ -e node_modules ] || ln -s ${JSON.stringify(resolve('node_modules'))} node_modules\nexit 0\n`,
      );
      execFileSync('chmod', ['+x', fakeNpm]);

      const output = execFileSync(process.execPath, [INSTALL_PATH, 'install'], {
        encoding: 'utf8',
        cwd: projectDir,
        env: { ...process.env, HOME: home, MEM_NO_AUTO_ADOPT: '1', PATH: `${binDir}:${process.env.PATH}` },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const argv = readFileSync(logPath, 'utf8');
      expect(argv, 'user scope is ours to purge').toContain('mcp remove -s user mem-lite');
      expect(argv, 'project scope is the repository owner’s').not.toContain('-s project');
      expect(readFileSync(mcpPath, 'utf8')).toBe(original);
      // Silence would be the other failure: the duplicate really does shadow the user-scope
      // registration inside this directory, so it has to be reported, just not removed.
      expect(output).toContain('at PROJECT scope');
      expect(output).toContain('.mcp.json');
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  }, 90000);

  // The predicate the warning is built from, driven directly so the shapes that must NOT
  // warn are pinned too — a warning that fires on every project would train the user to
  // ignore the one that matters.
  describe('projectScopedMemRegistrations', () => {
    const withMcpJson = (contents) => {
      const dir = makeTmpDir();
      if (contents !== null) writeFileSync(join(dir, '.mcp.json'), contents);
      return dir;
    };

    it('names both of our registrations and nothing else', () => {
      const dir = withMcpJson(
        JSON.stringify({ mcpServers: { mem: {}, 'mem-lite': {}, 'someone-elses': {} } }),
      );
      try {
        expect(projectScopedMemRegistrations(dir).names).toEqual(['mem', 'mem-lite']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('stays quiet for a project that registers other servers only', () => {
      const dir = withMcpJson(JSON.stringify({ mcpServers: { postgres: {}, github: {} } }));
      try {
        expect(projectScopedMemRegistrations(dir).names).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([
      ['no .mcp.json at all', null],
      ['unparseable JSON', '{ not json'],
      ['no mcpServers key', '{}'],
      // Two shapes, because they fail on DIFFERENT clauses and an earlier version of this
      // row used only the array — which `typeof [] === 'object'` let slide past the guard
      // into the membership filter, so the case was green without the guard ever firing.
      ['mcpServers is a scalar', '{"mcpServers": 3}'],
      ['mcpServers is an array', '{"mcpServers": []}'],
    ])('stays quiet and does not throw on %s', (_label, contents) => {
      const dir = withMcpJson(contents);
      try {
        expect(() => projectScopedMemRegistrations(dir)).not.toThrow();
        expect(projectScopedMemRegistrations(dir).names).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
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
            // A legacy (pre-v2.78) registration of OUR server — a `mem` that runs anything
            // else is the user's and must survive (tests/mcp-legacy-name-ownership.test.mjs).
            mcpServers: { mem: { command: 'node', args: [join(home, '.claude-mem-lite', 'server.mjs')] } },
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
            // A legacy (pre-v2.78) registration of OUR server — a `mem` that runs anything
            // else is the user's and must survive (tests/mcp-legacy-name-ownership.test.mjs).
            mcpServers: { mem: { command: 'node', args: [join(home, '.claude-mem-lite', 'server.mjs')] } },
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

  // D#176: with CLAUDE_CONFIG_DIR set, the plugin runs from <cfg>/plugins/cache and Claude Code
  // keeps .claude.json and settings.json in <cfg>. Step 8 pruned ~/.claude/plugins/cache, which is
  // then ANOTHER profile's cache, where CLAUDE_PLUGIN_ROOT protects nothing, and the MCP dedup
  // edited that profile's ~/.claude.json. Both must stay in the config dir this session uses.
  it('plugin setup under CLAUDE_CONFIG_DIR prunes and edits only the config dir, never ~/.claude', () => {
    const home = makeTmpDir();
    try {
      const cfg = join(home, 'cfg');
      const dataDir = join(home, '.claude-mem-lite');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      symlinkSync(resolve('node_modules'), join(dataDir, 'node_modules'));
      const cacheIn = (base) => join(base, 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      for (const base of [cfg, join(home, '.claude')]) {
        for (const v of ['3.90.0', '3.94.0', '3.95.0', '3.96.0'])
          mkdirSync(join(cacheIn(base), v), { recursive: true });
      }
      const ours = JSON.stringify({
        mcpServers: { 'mem-lite': { command: 'node', args: ['/x/server.mjs'] } },
      });
      writeFileSync(join(cfg, '.claude.json'), ours);
      writeFileSync(join(home, '.claude.json'), ours);

      execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          CLAUDE_CONFIG_DIR: cfg,
          CLAUDE_PLUGIN_ROOT: join(cacheIn(cfg), '3.96.0'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const versions = (base) =>
        readdirSync(cacheIn(base))
          .filter((n) => /^\d+\./.test(n))
          .sort();
      expect(versions(cfg)).toEqual(['3.94.0', '3.95.0', '3.96.0']);
      expect(versions(join(home, '.claude')), "another profile's cache was pruned").toEqual([
        '3.90.0',
        '3.94.0',
        '3.95.0',
        '3.96.0',
      ]);
      expect(
        JSON.parse(readFileSync(join(cfg, '.claude.json'), 'utf8')).mcpServers['mem-lite'],
      ).toBeUndefined();
      expect(
        readFileSync(join(home, '.claude.json'), 'utf8'),
        "another profile's .claude.json was edited",
      ).toBe(ours);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  // D#270: steps 7 and 9 edit and inspect the config home, but their one-shot markers sat in the
  // data dir, which every profile shares, so the first profile to start settled the question for
  // all of them: a second CLAUDE_CONFIG_DIR profile never got the MCP dedup or the residue warning.
  describe('setup.sh one-shot markers are per config home (D#270)', () => {
    const ours = JSON.stringify({ mcpServers: { 'mem-lite': { command: 'node', args: ['/x/server.mjs'] } } });
    const legacyHooks = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node ~/.claude-mem-lite/hook.mjs stop' }] }] },
    });
    function profileHome() {
      const home = makeTmpDir();
      const dataDir = join(home, '.claude-mem-lite');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      symlinkSync(resolve('node_modules'), join(dataDir, 'node_modules'));
      return home;
    }
    // A cfg that is not absolute here still gets its plugin root under ~/.claude, never the cwd.
    function runSetup(home, cfg, { cwd, env: extra = {} } = {}) {
      const base = cfg && isAbsolute(cfg) ? cfg : join(home, '.claude');
      const root = join(base, 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '6.24.0');
      mkdirSync(root, { recursive: true });
      const env = { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: root, ...extra };
      if (cfg) env.CLAUDE_CONFIG_DIR = cfg;
      return spawnSync('bash', [SETUP_PATH], { encoding: 'utf8', env, cwd });
    }

    // v6.30.1 delta review P3-4: for the default profile the fix named no config home, so a shell
    // carrying another profile's CLAUDE_CONFIG_DIR cleaned that profile instead.
    it("the default profile's fix command names its config home too", () => {
      const home = profileHome();
      try {
        const cfg = join(home, '.claude');
        mkdirSync(cfg, { recursive: true });
        writeFileSync(join(cfg, 'settings.json'), legacyHooks);
        const r = runSetup(home);
        expect(r.status, r.stderr).toBe(0);
        const root = join(cfg, 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '6.24.0');
        expect(r.stderr).toContain(`CLAUDE_CONFIG_DIR=${cfg} node ${root}/cli.mjs cleanup-hooks`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    // D#513(2): the warning matched `.claude-mem-lite/` as a substring, so a user's own hook kept
    // there was listed, and the cleanup-hooks it names leaves that hook in place. It now asks the
    // classifier cleanup-hooks uses.
    it("a user's own hook under the data dir gets no residue warning", () => {
      const home = profileHome();
      try {
        const cfg = join(home, '.claude');
        mkdirSync(cfg, { recursive: true });
        const own = (command) => ({ hooks: [{ type: 'command', command }] });
        writeFileSync(
          join(cfg, 'settings.json'),
          JSON.stringify({
            hooks: {
              Stop: [own('bash ~/.claude-mem-lite/my-backup.sh')],
              SessionEnd: [own(`bash "${join(home, '.claude-mem-lite', 'notify.sh')}"`)],
            },
          }),
        );
        const r = runSetup(home);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stderr).not.toContain('Legacy direct-install hooks');
        // Control: a stale hook of ours in the same file is still listed, and only its event.
        writeFileSync(
          join(cfg, 'settings.json'),
          JSON.stringify({
            hooks: {
              Stop: [own('bash ~/.claude-mem-lite/my-backup.sh')],
              PreCompact: [own('node ~/.claude-mem-lite/hook.mjs pre-compact')],
            },
          }),
        );
        for (const f of readdirSync(join(home, '.claude-mem-lite', 'runtime')))
          if (f.startsWith('.residue-warned')) rmSync(join(home, '.claude-mem-lite', 'runtime', f));
        const again = runSetup(home);
        expect(again.stderr).toContain('Legacy direct-install hooks');
        expect(again.stderr).toContain('Events with stale entries: PreCompact\n');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('a second profile gets its own MCP dedup and residue warning', () => {
      const home = profileHome();
      try {
        writeFileSync(join(home, '.claude.json'), ours);
        const first = runSetup(home);
        expect(first.status, first.stderr).toBe(0);
        expect(
          JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers['mem-lite'],
        ).toBeUndefined();

        const cfg = join(home, 'work-profile');
        mkdirSync(cfg, { recursive: true });
        writeFileSync(join(cfg, '.claude.json'), ours);
        writeFileSync(join(cfg, 'settings.json'), legacyHooks);
        const second = runSetup(home, cfg);
        expect(second.status, second.stderr).toBe(0);
        expect(
          JSON.parse(readFileSync(join(cfg, '.claude.json'), 'utf8')).mcpServers['mem-lite'],
          "the first profile's marker skipped this profile's dedup",
        ).toBeUndefined();
        expect(second.stderr, "the first profile's marker skipped this profile's warning").toContain(
          `Legacy direct-install hooks detected in ${join(cfg, 'settings.json')}`,
        );
        // The fix keeps the plugin: cleanup-hooks, by path. `uninstall` removes the plugin too, and a
        // plugin install puts no bare claude-mem-lite on PATH (D#501(3)).
        // And it names this profile's config home, which the user's shell may not carry (v6.30.1
        // pre-tag defects review: run without it, cleanup-hooks cleaned ~/.claude).
        const root = join(cfg, 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '6.24.0');
        expect(second.stderr).toContain(`CLAUDE_CONFIG_DIR=${cfg} node ${root}/cli.mjs cleanup-hooks`);
        expect(second.stderr).not.toMatch(/\buninstall\b/);

        // Still one-shot per home: a second start of the same profile does neither again.
        writeFileSync(join(cfg, '.claude.json'), ours);
        const again = runSetup(home, cfg);
        expect(readFileSync(join(cfg, '.claude.json'), 'utf8')).toBe(ours);
        expect(again.stderr).not.toContain('Legacy direct-install hooks');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    // D#269: setup.sh calls a value absolute exactly when Node's isAbsolute does on that platform
    // (bash keeps an inherited OSTYPE). The cwd holds `<value>/.claude.json`, which setup edits
    // only when it takes the value as absolute; otherwise it edits ~/.claude.json.
    it('edits the .claude.json of the config home Node would pick on that platform (D#269)', () => {
      for (const [ostype, value, absolute] of [
        ['linux-gnu', 'C:/cfg', false],
        ['msys', '\\\\srv\\cfg', true],
        ['msys', 'C:/cfg', true],
        ['cygwin', 'C:/cfg', true],
      ]) {
        const home = profileHome();
        const cwd = makeTmpDir();
        try {
          mkdirSync(join(cwd, value), { recursive: true });
          writeFileSync(join(cwd, value, '.claude.json'), ours);
          writeFileSync(join(home, '.claude.json'), ours);
          const r = runSetup(home, value, { cwd, env: { OSTYPE: ostype } });
          expect(r.status, r.stderr).toBe(0);
          const edited = (p) => JSON.parse(readFileSync(p, 'utf8')).mcpServers['mem-lite'] === undefined;
          expect(
            [edited(join(cwd, value, '.claude.json')), edited(join(home, '.claude.json'))],
            ostype,
          ).toEqual(absolute ? [true, false] : [false, true]);
        } finally {
          rmSync(home, { recursive: true, force: true });
          rmSync(cwd, { recursive: true, force: true });
        }
      }
    });

    // Post-release review: the keys compared path TEXT, so `~/.claude/` repeated the residue warning
    // for the default settings.json and gave ~/.claude/.claude.json a second dedup marker.
    it('another spelling of the same path reuses its marker', () => {
      const home = profileHome();
      try {
        const runtime = join(home, '.claude-mem-lite', 'runtime');
        writeFileSync(join(runtime, '.residue-warned-v2.55'), '');
        const cfg = join(home, '.claude');
        mkdirSync(cfg, { recursive: true });
        writeFileSync(join(cfg, 'settings.json'), legacyHooks);
        const dedupMarkers = () =>
          readdirSync(runtime)
            .filter((n) => n.startsWith('.mcp-dedup-'))
            .sort();
        expect(runSetup(home, cfg).status).toBe(0);
        const keyed = dedupMarkers();
        expect(keyed, 'premise: ~/.claude/.claude.json got its own marker').toHaveLength(1);
        for (const spelling of [`${cfg}/`, `${cfg}//`, `${home}/./.claude`]) {
          const r = runSetup(home, spelling);
          expect(r.status, r.stderr).toBe(0);
          expect(r.stderr, `${spelling}: the warning repeated for the default settings.json`).not.toContain(
            'Legacy direct-install hooks',
          );
        }
        expect(dedupMarkers(), 'a second marker for the same .claude.json').toEqual(keyed);

        // A non-default profile, keyed by its own hash: the same under a trailing slash, `/.` and a
        // symlink to it (delta review: the residue key once hashed the dir's parent plus its name).
        const work = join(home, 'work-profile');
        mkdirSync(work, { recursive: true });
        writeFileSync(join(work, 'settings.json'), legacyHooks);
        symlinkSync(work, join(home, 'work-link'));
        expect(runSetup(home, work).stderr, 'premise: the first run warns').toContain(
          'Legacy direct-install hooks',
        );
        for (const spelling of [`${work}/`, `${work}/.`, join(home, 'work-link')]) {
          expect(runSetup(home, spelling).stderr, `${spelling} re-ran the warning`).not.toContain(
            'Legacy direct-install hooks',
          );
        }
        expect(
          readdirSync(runtime).filter((n) => n.startsWith('.residue-warned-')),
          'one residue marker per settings.json',
        ).toHaveLength(2);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    // A marker is keyed by the file it gates, not by "is this ~/.claude": with CLAUDE_CONFIG_DIR
    // naming ~/.claude, settings.json is the default one but .claude.json moves into ~/.claude.
    it('CLAUDE_CONFIG_DIR=~/.claude: the settings.json marker every install has holds; .claude.json is a new file', () => {
      const home = profileHome();
      try {
        const runtime = join(home, '.claude-mem-lite', 'runtime');
        writeFileSync(join(runtime, '.mcp-dedup-v2.78'), '');
        writeFileSync(join(runtime, '.residue-warned-v2.55'), '');
        const cfg = join(home, '.claude');
        mkdirSync(cfg, { recursive: true });
        writeFileSync(join(cfg, 'settings.json'), legacyHooks);
        writeFileSync(join(cfg, '.claude.json'), ours);
        const r = runSetup(home, cfg);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stderr, 'the residue warning repeated for the same settings.json').not.toContain(
          'Legacy direct-install hooks',
        );
        expect(
          JSON.parse(readFileSync(join(cfg, '.claude.json'), 'utf8')).mcpServers['mem-lite'],
          '~/.claude/.claude.json was skipped on the marker of ~/.claude.json',
        ).toBeUndefined();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
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
    // Hold the PARENT: `join(makeTmpDir(), …)` discarded it, and the cleanup below removed
    // only the `relocated-mem` child — so every run of this file left one empty
    // /tmp/mem-install-* behind. (Found while auditing sandbox disposal for the R5 batch.)
    const dataRoot = makeTmpDir();
    const dataDir = join(dataRoot, 'relocated-mem');
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
        rmSync(dataRoot, { recursive: true, force: true }); // recursive → takes dataDir with it
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
