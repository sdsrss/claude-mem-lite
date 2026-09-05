// v2.79 install-ergonomics regression tests:
//   1. setup.sh's deps-broken flag round-trip — present-deps path clears stale flag
//   2. collectOrphanHookPaths detects dead settings.json hook entries
//   3. doctor surfaces "Orphan hooks: N entries reference missing files"

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, copyFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { collectOrphanHookPaths } from '../install.mjs';

const INSTALL_PATH = resolve('install.mjs');
const SETUP_PATH = resolve('scripts/setup.sh');
const REPO_NODE_MODULES = resolve('node_modules');

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-ergon-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// v2.80 test hygiene: doctor-style tests inherit user env by default; an
// outer CLAUDE_PLUGIN_ROOT (e.g. running tests inside a plugin-mode harness)
// would change doctor's plugin-detection branch and break assumptions.
// Strip it explicitly per call so the test environment is hermetic.
function envWithoutPluginRoot(extra = {}) {
  const { CLAUDE_PLUGIN_ROOT: _stripped, ...rest } = process.env;
  return { ...rest, ...extra };
}

describe('setup.sh deps-broken flag round-trip (v2.79, binding-probe since D#6 fix)', () => {
  // v2.80: each test asserts existsSync(REPO_NODE_MODULES) at entry so the
  // symlink-from-data-dir path can't silently fall back to the slow
  // npm-install branch when the test runner lacks node_modules (test-only
  // Docker stage, etc.). A dangling symlink would otherwise exercise the
  // wrong code path and report a false pass.
  //
  // D#6 contract change: directory PRESENCE alone no longer clears the flag —
  // a PASSING binding probe (or a prior-probe ABI marker) does. npm >= 12
  // blocks lifecycle scripts, so `npm install` exits 0 with better-sqlite3
  // present but its native .node never compiled; the old presence-check
  // cleared .deps-broken on exactly that broken state (false green).
  // Fixtures get a hermetic node_modules: a real dir holding a symlink to the
  // repo's better-sqlite3 (working binding), so probe passes and the ABI
  // marker lands inside the fixture, never in the repo tree.
  function makeWorkingNodeModules(parentDir) {
    const nm = join(parentDir, 'node_modules');
    mkdirSync(nm, { recursive: true });
    symlinkSync(join(REPO_NODE_MODULES, 'better-sqlite3'), join(nm, 'better-sqlite3'));
    return nm;
  }

  it('clears stale .deps-broken when a WORKING binding arrives via the symlink path (bare-probe fallback, no lib/)', () => {
    expect(existsSync(REPO_NODE_MODULES)).toBe(true);
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const pluginRoot = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      mkdirSync(pluginRoot, { recursive: true });
      writeFileSync(join(pluginRoot, 'package.json'), '{"name":"fixture"}\n');

      // Seed a stale flag from a previous failing session
      const flag = join(dataDir, 'runtime', '.deps-broken');
      writeFileSync(flag, '{"ts":"old","reason":"prev"}\n');
      expect(existsSync(flag)).toBe(true);

      // Symlink path: deps live in DATA_DIR/node_modules, setup.sh symlinks into
      // pluginRoot. The probe entry point IS present but lib/ is not, so the
      // helper import fails and the bare-probe fallback runs — a half-installed
      // tree with a working binding. (Omitting the entry point entirely would
      // instead skip the probe and coast on setup.sh's binding_usable fallback,
      // testing nothing about bareProbe.)
      mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
      copyFileSync(
        resolve('scripts/binding-probe-cli.mjs'),
        join(pluginRoot, 'scripts', 'binding-probe-cli.mjs'),
      );
      makeWorkingNodeModules(dataDir);

      execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      expect(existsSync(flag)).toBe(false);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  it('clears stale .deps-broken when pluginRoot deps probe healthy (helper path), and stamps the ABI marker', () => {
    expect(existsSync(REPO_NODE_MODULES)).toBe(true);
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const pluginRoot = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      mkdirSync(join(pluginRoot, 'lib'), { recursive: true });
      mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
      writeFileSync(join(pluginRoot, 'package.json'), '{"name":"fixture"}\n');
      // The probe ENTRY POINT plus all three helpers: setup.sh delegates to
      // scripts/binding-probe-cli.mjs, and a fixture missing it silently falls
      // through to setup.sh's binding_usable fallback instead of testing the
      // probe at all.
      for (const f of ['binding-probe.mjs', 'proc-lock.mjs', 'resolve-data-dir.mjs']) {
        copyFileSync(resolve('lib', f), join(pluginRoot, 'lib', f));
      }
      copyFileSync(
        resolve('scripts/binding-probe-cli.mjs'),
        join(pluginRoot, 'scripts', 'binding-probe-cli.mjs'),
      );
      const nm = makeWorkingNodeModules(pluginRoot);

      const flag = join(dataDir, 'runtime', '.deps-broken');
      writeFileSync(flag, '{"ts":"old","reason":"prev"}\n');

      execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      expect(existsSync(flag)).toBe(false);
      // ABI-keyed marker certifies THIS node_modules tree; next SessionStart
      // takes the stat-only fast path.
      const abi = process.versions.modules;
      expect(existsSync(join(nm, `.mem-binding-ok-${abi}`))).toBe(true);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  // v3.60.1 regression: the false RED. The probe used to be an inline
  // `node --input-type=module -e` string that SIGSEGV'd in native teardown AFTER
  // a verified-good rebuild — exit 139 read as "still broken", so setup.sh wrote
  // .deps-broken over a healthy install and hook.mjs rendered a "hooks degraded"
  // banner into the session. Extracting the probe to a module removed that
  // trigger; setup.sh's binding_usable fallback makes the VERDICT independent of
  // the probe's exit code, so any future crash cannot resurrect the false red.
  // Simulated here by a probe that dies on SIGSEGV while the tree is healthy.
  it('a probe that crashes does not mark deps broken when the binding is actually usable', () => {
    expect(existsSync(REPO_NODE_MODULES)).toBe(true);
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const pluginRoot = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
      writeFileSync(join(pluginRoot, 'package.json'), '{"name":"fixture"}\n');
      const nm = makeWorkingNodeModules(pluginRoot);
      // Healthy tree, crashing probe: exactly the shape that produced the bug.
      writeFileSync(
        join(pluginRoot, 'scripts', 'binding-probe-cli.mjs'),
        'process.kill(process.pid, "SIGSEGV");\n',
      );

      const flag = join(dataDir, 'runtime', '.deps-broken');
      const out = execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000,
      });

      expect(existsSync(flag), '.deps-broken written despite a usable binding').toBe(false);
      expect(existsSync(join(nm, `.mem-binding-ok-${process.versions.modules}`))).toBe(true);
      // SessionStart stdout is a JSON envelope — a crashing child must not reach it.
      expect(out).toBe('');
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });

  // D#6 regression: the npm >= 12 false green. better-sqlite3 dir PRESENT but
  // unusable (no compiled binding) — pre-fix setup.sh called mark_deps_ok on
  // presence alone and every hook died silently with a green flag. Now the
  // probe fails, the flag is (re)written with the scripts-enabled rebuild as
  // the repair command, and no ABI marker is stamped.
  it('marks deps-broken (with allow-scripts rebuild repair) when better-sqlite3 is present but unusable', () => {
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const pluginRoot = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      mkdirSync(join(pluginRoot, 'lib'), { recursive: true });
      mkdirSync(join(pluginRoot, 'node_modules', 'better-sqlite3'), { recursive: true });
      writeFileSync(join(pluginRoot, 'package.json'), '{"name":"fixture"}\n');
      // The probe entry point AND all three helpers, so the test exercises the
      // REAL locked-rebuild path — not the bare-probe fallback, and not
      // setup.sh's binding_usable fallback (which is what an absent
      // scripts/binding-probe-cli.mjs silently degrades to).
      mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
      for (const f of ['binding-probe.mjs', 'proc-lock.mjs', 'resolve-data-dir.mjs']) {
        copyFileSync(resolve('lib', f), join(pluginRoot, 'lib', f));
      }
      copyFileSync(
        resolve('scripts/binding-probe-cli.mjs'),
        join(pluginRoot, 'scripts', 'binding-probe-cli.mjs'),
      );

      const flag = join(dataDir, 'runtime', '.deps-broken');

      execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000,
      });

      expect(existsSync(flag)).toBe(true);
      const written = JSON.parse(readFileSync(flag, 'utf8'));
      expect(written.reason).toContain('binding probe/rebuild failed');
      expect(written.repair).toContain('npm rebuild better-sqlite3 --dangerously-allow-all-scripts');
      expect(
        existsSync(join(pluginRoot, 'node_modules', `.mem-binding-ok-${process.versions.modules}`)),
      ).toBe(false);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  }, 60000);
});

describe('collectOrphanHookPaths (v2.79)', () => {
  it('returns empty for settings with no hooks', () => {
    expect(collectOrphanHookPaths({})).toEqual([]);
    expect(collectOrphanHookPaths({ hooks: {} })).toEqual([]);
  });

  it('returns empty for non-mem hooks even when paths are missing', () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'node "/no/such/other/hook.mjs"' }],
          },
        ],
      },
    };
    expect(collectOrphanHookPaths(settings)).toEqual([]);
  });

  it('flags mem hooks pointing at missing absolute paths', () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: 'node "/tmp/nonexistent-claude-mem-lite/hook.mjs" session-start' },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: 'bash "/tmp/nonexistent-claude-mem-lite/scripts/post-tool-use.sh"',
              },
            ],
          },
        ],
      },
    };
    const orphans = collectOrphanHookPaths(settings);
    expect(orphans).toContain('/tmp/nonexistent-claude-mem-lite/hook.mjs');
    expect(orphans).toContain('/tmp/nonexistent-claude-mem-lite/scripts/post-tool-use.sh');
  });

  it('ignores ${CLAUDE_PLUGIN_ROOT}-templated hooks (those are plugin-owned, runtime-resolved)', () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hook.mjs" session-start' }],
          },
        ],
      },
    };
    expect(collectOrphanHookPaths(settings)).toEqual([]);
  });

  it('skips hooks whose target path exists on disk', () => {
    // Use the install.mjs itself — we know it exists since the test is running.
    const real = INSTALL_PATH;
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: `node "${real}" session-start` }],
          },
        ],
      },
    };
    expect(collectOrphanHookPaths(settings)).toEqual([]);
  });

  it('picks the path-shaped quoted token even when an earlier non-path quoted token comes first (v2.80)', () => {
    // Footgun guard: wrapper commands like `bash -c "do stuff" "/real/path.sh"`
    // pre-v2.80 picked "do stuff", existsSync()'d false, and false-flagged
    // the wrapper as an orphan. v2.80 scans all quoted tokens and prefers
    // ones that look like a hook path; falls back to unquoted only if none qualify.
    // NOTE: the command string below is contrived to exercise the path-extractor
    // parser, NOT realistic hook execution (real `bash -c "..." "/...sh"` passes
    // the trailing arg as $0 to the inline script). The parser is what we test.
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command:
                  'bash -c "claude-mem-lite tracer; exec bash" "/tmp/nonexistent-claude-mem-lite/scripts/wrapped.sh"',
              },
            ],
          },
        ],
      },
    };
    const orphans = collectOrphanHookPaths(settings);
    expect(orphans).toEqual(['/tmp/nonexistent-claude-mem-lite/scripts/wrapped.sh']);
    expect(orphans).not.toContain('claude-mem-lite tracer; exec bash');
  });

  it('deduplicates repeated missing paths across hook events', () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: 'node "/tmp/nonexistent-claude-mem-lite/hook.mjs" session-start' },
            ],
          },
        ],
        Stop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'node "/tmp/nonexistent-claude-mem-lite/hook.mjs" stop' }],
          },
        ],
      },
    };
    const orphans = collectOrphanHookPaths(settings);
    expect(orphans.filter((p) => p === '/tmp/nonexistent-claude-mem-lite/hook.mjs')).toHaveLength(1);
  });
});

describe('doctor surfaces orphan hooks (v2.79)', () => {
  it('emits "Orphan hooks:" line with file count and repair hint', () => {
    const home = makeTmpDir();
    try {
      mkdirSync(join(home, '.claude'), { recursive: true });
      // Seed settings.json with mem hooks pointing at a non-existent install root
      writeFileSync(
        join(home, '.claude', 'settings.json'),
        JSON.stringify(
          {
            hooks: {
              SessionStart: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'command',
                      command: 'node "/tmp/nonexistent-claude-mem-lite-doctor/hook.mjs" session-start',
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
      );

      let output = '';
      try {
        output = execFileSync(process.execPath, [INSTALL_PATH, 'doctor'], {
          encoding: 'utf8',
          env: envWithoutPluginRoot({ HOME: home }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        // doctor exits non-zero on issues — capture stdout from the error object
        output = (e.stdout || '') + (e.stderr || '');
      }

      expect(output).toMatch(/Orphan hooks:.*settings\.json/);
      expect(output).toContain('/tmp/nonexistent-claude-mem-lite-doctor/hook.mjs');
      expect(output).toMatch(/Repair:.*install\.mjs uninstall/);
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    }
  });
});
