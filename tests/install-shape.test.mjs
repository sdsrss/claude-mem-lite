// install-shape.test.mjs — the install layer must answer about the trees that
// actually RUN, not about one hardcoded directory.
//
// Field motivation (sandbox simulation, 2026-08-17): claude-mem-lite supports
// three code homes at once — the plugin cache (`/plugin install`), the managed
// dir `~/.claude-mem-lite` (`claude-mem-lite install`), and the npm-global
// package (`npm i -g`, which is where the shell CLI runs from). doctor probed
// exactly one of them, chosen by "which dir is install.mjs sitting in". That is
// right for install.mjs and wrong for a system health check: a plugin-only user
// got `✗ server.mjs: missing` on a healthy install, and a user whose
// ~/.claude-mem-lite binding was stale got `✓ better-sqlite3: verified` while
// the registered MCP server FATAL'd on startup and every hook silently no-op'd.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { detectInstallShape, listPluginCacheVersions, hasManagedCodeInstall } from '../lib/install-shape.mjs';

const REPO = resolve('.');
let home;

function tmp() {
  const d = join(tmpdir(), `mem-shape-${randomUUID().slice(0, 8)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * A directory that owns its OWN resolvable better-sqlite3.
 *
 * Deliberately NOT a symlink to the repo's node_modules: two independent
 * installs have two independent trees, and dedup keys on the binding's
 * realpath — a shared-symlink fixture would collapse every root into one and
 * make the multi-root assertions below pass or fail for the wrong reason. The
 * shim re-exports the repo's compiled module, so the probe really loads a
 * working Database while each root stays a distinct path.
 */
function withRealDeps(root) {
  const pkgDir = join(root, 'node_modules', 'better-sqlite3');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'claude-mem-lite', version: '9.9.9' }));
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version: '12.10.0', main: 'index.js' }),
  );
  writeFileSync(
    join(pkgDir, 'index.js'),
    `module.exports = require(${JSON.stringify(join(REPO, 'node_modules', 'better-sqlite3'))});\n`,
  );
  return root;
}

/** A directory whose better-sqlite3 is present but genuinely unloadable. */
function withBrokenDeps(root) {
  mkdirSync(join(root, 'node_modules', 'better-sqlite3'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'claude-mem-lite', version: '9.9.9' }));
  writeFileSync(
    join(root, 'node_modules', 'better-sqlite3', 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version: '0.0.0', main: 'index.js' }),
  );
  writeFileSync(
    join(root, 'node_modules', 'better-sqlite3', 'index.js'),
    'throw new Error("Could not locate the bindings file. Tried: fixture");\n',
  );
  return root;
}

function pluginCacheDir(h, version) {
  return join(h, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', version);
}

/** Minimum shape Claude Code leaves behind for a runnable plugin version. */
function makePluginVersion(h, version, { deps = 'real' } = {}) {
  const root = pluginCacheDir(h, version);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'launch.mjs'), '// launcher\n');
  writeFileSync(join(root, 'cli.mjs'), '// cli\n');
  if (deps === 'real') withRealDeps(root);
  else if (deps === 'broken') withBrokenDeps(root);
  else writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'claude-mem-lite', version }));
  return root;
}

function makeManagedInstall(h, { deps = 'real' } = {}) {
  const root = join(h, '.claude-mem-lite');
  mkdirSync(root, { recursive: true });
  for (const f of ['server.mjs', 'hook.mjs', 'cli.mjs', 'mem-cli.mjs'])
    writeFileSync(join(root, f), '// x\n');
  if (deps === 'real') withRealDeps(root);
  else if (deps === 'broken') withBrokenDeps(root);
  return root;
}

beforeEach(() => {
  home = tmp();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('hasManagedCodeInstall — is ~/.claude-mem-lite a CODE home, or only a data dir?', () => {
  it('is false for the plugin-only shape (setup.sh makes the data dir, never puts source in it)', () => {
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    writeFileSync(join(home, '.claude-mem-lite', 'claude-mem-lite.db'), '');
    expect(hasManagedCodeInstall(join(home, '.claude-mem-lite'))).toBe(false);
  });

  it('is true once install.mjs has deployed the entry points there', () => {
    makeManagedInstall(home);
    expect(hasManagedCodeInstall(join(home, '.claude-mem-lite'))).toBe(true);
  });

  it('is false on a half-written install (server.mjs alone is not a code home)', () => {
    const root = join(home, '.claude-mem-lite');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'server.mjs'), '// x\n');
    expect(hasManagedCodeInstall(root)).toBe(false);
  });
});

describe('listPluginCacheVersions', () => {
  it('returns nothing when the plugin was never installed', () => {
    expect(listPluginCacheVersions({ home })).toEqual([]);
  });

  it('lists runnable version dirs newest-first', () => {
    makePluginVersion(home, '3.68.0', { deps: 'none' });
    makePluginVersion(home, '3.69.1', { deps: 'none' });
    makePluginVersion(home, '3.7.0', { deps: 'none' });
    expect(listPluginCacheVersions({ home }).map((v) => v.version)).toEqual(['3.69.1', '3.68.0', '3.7.0']);
  });

  it('skips a torn version dir with no launcher (a half-pruned cache is not a runtime root)', () => {
    makePluginVersion(home, '3.69.1', { deps: 'none' });
    mkdirSync(pluginCacheDir(home, '3.60.0'), { recursive: true });
    expect(listPluginCacheVersions({ home }).map((v) => v.version)).toEqual(['3.69.1']);
  });

  it('ignores non-version entries in the cache dir', () => {
    makePluginVersion(home, '3.69.1', { deps: 'none' });
    mkdirSync(join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', 'scratch'), {
      recursive: true,
    });
    expect(listPluginCacheVersions({ home }).map((v) => v.version)).toEqual(['3.69.1']);
  });
});

describe('detectInstallShape — every tree a runtime surface resolves', () => {
  it('plugin-only: not managed, and the cache version is a runtime root', () => {
    makePluginVersion(home, '3.69.1');
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    const shape = detectInstallShape({
      home,
      projectDir: pluginCacheDir(home, '3.69.1'),
      installDir: join(home, '.claude-mem-lite'),
    });
    expect(shape.managed).toBe(false);
    expect(shape.pluginVersions.map((v) => v.version)).toEqual(['3.69.1']);
    expect(shape.runtimeRoots.map((r) => r.root)).toContain(pluginCacheDir(home, '3.69.1'));
  });

  it('npm-global + managed: BOTH the running CLI dir and ~/.claude-mem-lite are roots', () => {
    const npmGlobal = withRealDeps(join(home, 'npm-global', 'lib', 'node_modules', 'claude-mem-lite'));
    makeManagedInstall(home);
    const shape = detectInstallShape({
      home,
      projectDir: npmGlobal,
      installDir: join(home, '.claude-mem-lite'),
    });
    expect(shape.managed).toBe(true);
    const roots = shape.runtimeRoots.map((r) => r.root);
    expect(roots).toContain(npmGlobal);
    expect(roots).toContain(join(home, '.claude-mem-lite'));
  });

  it('the plugin cache is a root even when the CLI is invoked from the npm-global package', () => {
    const npmGlobal = withRealDeps(join(home, 'npm-global', 'lib', 'node_modules', 'claude-mem-lite'));
    makePluginVersion(home, '3.69.1');
    const shape = detectInstallShape({
      home,
      projectDir: npmGlobal,
      installDir: join(home, '.claude-mem-lite'),
    });
    expect(shape.runtimeRoots.map((r) => r.root)).toEqual(
      expect.arrayContaining([npmGlobal, pluginCacheDir(home, '3.69.1')]),
    );
  });

  it('an UNCERTIFIED dir with no better-sqlite3 is not a root (nothing runs from it)', () => {
    // projectDir here is an arbitrary cwd, not a code home this module vouched for.
    // Contrast with the certified-home cases below, which MUST be reported.
    const shape = detectInstallShape({
      home,
      projectDir: join(home, 'nowhere'),
      installDir: join(home, '.claude-mem-lite'),
    });
    expect(shape.runtimeRoots).toEqual([]);
  });

  it('a depless plugin cache version IS reported — the plugin runs from it', () => {
    makePluginVersion(home, '3.69.1', { deps: 'none' });
    const shape = detectInstallShape({
      home,
      projectDir: join(home, 'nowhere'),
      installDir: join(home, '.claude-mem-lite'),
    });
    expect(shape.runtimeRoots).toHaveLength(1);
    expect(shape.runtimeRoots[0].ownDeps).toBe(false);
  });

  // Pre-tag review (correctness lens, SHOULD-FIX 1): dropping a root because it has
  // no deps SILENCED a real failure. A managed code home whose node_modules was
  // deleted or whose npm install died after the file copy still runs every
  // settings.json hook and the registered MCP server; each fire throws
  // ERR_MODULE_NOT_FOUND, which is NOT in NATIVE_BINDING_PATTERNS, so no breakage
  // marker either. The pre-v3.70 code probed bindingHostDir() → INSTALL_DIR, failed,
  // and exited 1. Reporting nothing turned that into exit 0 — a verdict regression
  // introduced by this very refactor.
  it('reports a CERTIFIED code home whose deps are missing entirely, instead of dropping it', () => {
    const managed = join(home, '.claude-mem-lite');
    mkdirSync(managed, { recursive: true });
    for (const f of ['server.mjs', 'hook.mjs']) writeFileSync(join(managed, f), '// x\n');
    makePluginVersion(home, '3.69.1'); // a healthy peer, so "some other root is fine" cannot mask it
    const shape = detectInstallShape({ home, projectDir: join(home, 'nowhere'), installDir: managed });
    expect(shape.managed).toBe(true);
    const entry = shape.runtimeRoots.find((r) => r.root === managed);
    expect(entry, 'the managed code home must appear as a root').toBeTruthy();
    expect(entry.ownDeps).toBe(false);
  });

  // v3.70.0 fixed a false-GREEN here by pre-judging any certified root without its own
  // node_modules as broken. That over-corrected into a false-RED: Node resolves a
  // specifier up the directory tree, so a code home under an ancestor that HAS a
  // working better-sqlite3 loads fine. Measured on the shipped build: ground-truth
  // probe {ok:true} while the verdict said "absent — every hook throws
  // ERR_MODULE_NOT_FOUND". Whether the tree is owned is not the question; whether the
  // root can LOAD is, and only a probe answers that.
  it('does NOT pre-judge a certified home that resolves better-sqlite3 from an ancestor', async () => {
    const { probeRuntimeRoots } = await import('../lib/install-shape.mjs');
    // Ancestor owns a working tree…
    withRealDeps(home);
    // …and the code home nested inside it owns none.
    const managed = join(home, '.claude-mem-lite');
    mkdirSync(managed, { recursive: true });
    writeFileSync(
      join(managed, 'package.json'),
      JSON.stringify({ name: 'claude-mem-lite', version: '9.9.9' }),
    );
    for (const f of ['server.mjs', 'hook.mjs']) writeFileSync(join(managed, f), '// x\n');

    const shape = detectInstallShape({ home, projectDir: join(home, 'nowhere'), installDir: managed });
    const entry = shape.runtimeRoots.find((r) => r.root === managed);
    expect(entry, 'still a probe target').toBeTruthy();
    expect(entry.ownDeps).toBe(false);
    const [r] = probeRuntimeRoots([entry]);
    expect(r.ok, `probe said broken but the root loads fine: ${r.error}`).toBe(true);
  });

  it('still reports broken when NOTHING resolves, and says absent rather than stale', async () => {
    const { probeRuntimeRoots } = await import('../lib/install-shape.mjs');
    const managed = join(home, '.claude-mem-lite');
    mkdirSync(managed, { recursive: true });
    writeFileSync(
      join(managed, 'package.json'),
      JSON.stringify({ name: 'claude-mem-lite', version: '9.9.9' }),
    );
    for (const f of ['server.mjs', 'hook.mjs']) writeFileSync(join(managed, f), '// x\n');
    const shape = detectInstallShape({ home, projectDir: join(home, 'nowhere'), installDir: managed });
    const [r] = probeRuntimeRoots(shape.runtimeRoots);
    expect(r.ok).toBe(false);
    // An absent tree needs an install; `npm rebuild` of nothing exits 0 and heals nothing.
    expect(r.repair).toMatch(/npm install/);
  });

  it('probeRuntimeRoots reports a deps-missing code home as broken, not ok', async () => {
    const { probeRuntimeRoots } = await import('../lib/install-shape.mjs');
    const managed = join(home, '.claude-mem-lite');
    mkdirSync(managed, { recursive: true });
    for (const f of ['server.mjs', 'hook.mjs']) writeFileSync(join(managed, f), '// x\n');
    const shape = detectInstallShape({ home, projectDir: join(home, 'nowhere'), installDir: managed });
    const [r] = probeRuntimeRoots(shape.runtimeRoots);
    expect(r.ok).toBe(false);
    expect(r.repair).toMatch(/npm install/);
  });

  // Pre-tag review (correctness lens, SHOULD-FIX 2): Claude Code does not prune old
  // cache versions, and each carries its own real node_modules. Probing all of them
  // means a Node major upgrade leaves the never-started versions permanently stale →
  // doctor red forever about trees nothing loads, and rebuild-binding's
  // clearNativeBindingBreakage (gated on EVERY target succeeding) never runs, which
  // is the documented "launcher re-spawns npm every 6h forever" state.
  it('probes only the ACTIVE plugin cache version, not every stale one', () => {
    makePluginVersion(home, '3.69.1');
    makePluginVersion(home, '3.68.1');
    makePluginVersion(home, '3.66.1');
    const shape = detectInstallShape({
      home,
      projectDir: join(home, 'nowhere'),
      installDir: join(home, '.claude-mem-lite'),
    });
    expect(shape.pluginVersions.map((v) => v.version)).toEqual(['3.69.1', '3.68.1', '3.66.1']);
    const cacheRoots = shape.runtimeRoots.filter((r) => /plugin cache/.test(r.label));
    expect(cacheRoots).toHaveLength(1);
    expect(cacheRoots[0].root).toBe(pluginCacheDir(home, '3.69.1'));
  });

  it('honors CLAUDE_PLUGIN_ROOT when the running version is not the newest', () => {
    makePluginVersion(home, '3.69.1');
    makePluginVersion(home, '3.68.1');
    const shape = detectInstallShape({
      home,
      projectDir: join(home, 'nowhere'),
      installDir: join(home, '.claude-mem-lite'),
      pluginRoot: pluginCacheDir(home, '3.68.1'),
    });
    const cacheRoots = shape.runtimeRoots.filter((r) => /plugin cache/.test(r.label));
    expect(cacheRoots).toHaveLength(1);
    expect(cacheRoots[0].root).toBe(pluginCacheDir(home, '3.68.1'));
  });

  it('orders versions numerically even when a dir carries a prerelease suffix', () => {
    makePluginVersion(home, '3.69.1', { deps: 'none' });
    makePluginVersion(home, '3.70.0-rc1', { deps: 'none' });
    // Number('0-rc1') is NaN; a NaN comparison collapses to "equal" and the order
    // becomes insertion-dependent (review NOTE N5).
    expect(listPluginCacheVersions({ home }).map((v) => v.version)).toEqual(['3.70.0-rc1', '3.69.1']);
  });

  it("probes a tree shared through setup.sh's symlink ONCE, but names both homes", () => {
    const data = withRealDeps(join(home, '.claude-mem-lite'));
    for (const f of ['server.mjs', 'hook.mjs']) writeFileSync(join(data, f), '// x\n');
    const cache = pluginCacheDir(home, '3.69.1');
    mkdirSync(join(cache, 'scripts'), { recursive: true });
    writeFileSync(join(cache, 'scripts', 'launch.mjs'), '// launcher\n');
    writeFileSync(
      join(cache, 'package.json'),
      JSON.stringify({ name: 'claude-mem-lite', version: '3.69.1' }),
    );
    symlinkSync(join(data, 'node_modules'), join(cache, 'node_modules'));
    const shape = detectInstallShape({ home, projectDir: join(home, 'nowhere'), installDir: data });
    // One tree → one probe → one failure message, not two `cd` paths for one fault.
    expect(shape.runtimeRoots).toHaveLength(1);
    // ...but the user must still see that the plugin is riding that same tree.
    expect(shape.runtimeRoots[0].label).toMatch(/managed install/);
    expect(shape.runtimeRoots[0].label).toMatch(/plugin cache v3\.69\.1/);
  });

  it('labels each root so a failure names WHICH install is broken', () => {
    const npmGlobal = withRealDeps(join(home, 'npm-global', 'lib', 'node_modules', 'claude-mem-lite'));
    makeManagedInstall(home);
    makePluginVersion(home, '3.69.1');
    const shape = detectInstallShape({
      home,
      projectDir: npmGlobal,
      installDir: join(home, '.claude-mem-lite'),
    });
    const labels = shape.runtimeRoots.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.join(' ')).toMatch(/plugin cache/);
  });
});

describe('probeRuntimeRoots — the check that must not answer about the wrong tree', () => {
  it('reports the broken root when a NON-host tree is the broken one', async () => {
    const { probeRuntimeRoots } = await import('../lib/install-shape.mjs');
    const good = withRealDeps(join(home, 'npm-global', 'lib', 'node_modules', 'claude-mem-lite'));
    const bad = withBrokenDeps(join(home, '.claude-mem-lite'));
    for (const f of ['server.mjs', 'hook.mjs']) writeFileSync(join(bad, f), '// x\n');
    const shape = detectInstallShape({ home, projectDir: good, installDir: bad });
    const results = probeRuntimeRoots(shape.runtimeRoots);
    expect(results).toHaveLength(2);
    const broken = results.filter((r) => !r.ok);
    expect(broken).toHaveLength(1);
    expect(broken[0].root).toBe(bad);
    expect(broken[0].error).toMatch(/bindings file/i);
  });

  it('is all-green when every root loads (control — proves the failure above is not tautological)', async () => {
    const { probeRuntimeRoots } = await import('../lib/install-shape.mjs');
    const a = withRealDeps(join(home, 'npm-global', 'lib', 'node_modules', 'claude-mem-lite'));
    const b = withRealDeps(join(home, 'other'));
    const results = probeRuntimeRoots([
      { label: 'a', root: a },
      { label: 'b', root: b },
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('carries the per-root repair command, so the user does not rebuild the healthy tree', async () => {
    const { probeRuntimeRoots } = await import('../lib/install-shape.mjs');
    const bad = withBrokenDeps(join(home, '.claude-mem-lite'));
    const [r] = probeRuntimeRoots([{ label: 'managed install', root: bad }]);
    expect(r.ok).toBe(false);
    expect(r.repair).toContain(bad);
    expect(r.repair).toMatch(/npm rebuild better-sqlite3/);
  });
});

describe('regression guard: the sandbox scenarios that produced this module', () => {
  it('plugin-only install exposes NO managed layout to demand entry points from', () => {
    makePluginVersion(home, '3.69.1');
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    const shape = detectInstallShape({
      home,
      projectDir: pluginCacheDir(home, '3.69.1'),
      installDir: join(home, '.claude-mem-lite'),
    });
    // The plugin ships its own code; demanding ~/.claude-mem-lite/server.mjs here
    // is what produced "3 issue(s) found" on a healthy recommended install.
    expect(shape.managed).toBe(false);
    expect(shape.pluginVersions.length).toBeGreaterThan(0);
  });

  it('a stale managed tree is visible even when the CLI runs from a healthy npm-global package', () => {
    const good = withRealDeps(join(home, 'npm-global', 'lib', 'node_modules', 'claude-mem-lite'));
    const bad = withBrokenDeps(join(home, '.claude-mem-lite'));
    for (const f of ['server.mjs', 'hook.mjs']) writeFileSync(join(bad, f), '// x\n');
    const shape = detectInstallShape({ home, projectDir: good, installDir: bad });
    expect(shape.runtimeRoots.map((r) => r.root)).toContain(bad);
    expect(existsSync(join(bad, 'server.mjs'))).toBe(true);
  });
});
