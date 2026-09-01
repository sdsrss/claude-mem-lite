import { describe, it, expect, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { buildReleaseManifest, serializeManifest } from '../lib/release-digest.mjs';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));
const mockedExecSync = vi.mocked(execSync);
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const trackedDirs = new Set();

function makeDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  trackedDirs.add(dir);
  return dir;
}

function makeDataDir(version = '1.0.0') {
  const dir = makeDir('mem-update-data');
  mkdirSync(join(dir, 'runtime'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }, null, 2));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'claude-mem-lite', lockfileVersion: 3 }, null, 2));
  writeFileSync(join(dir, 'server.mjs'), '// server');
  writeFileSync(join(dir, 'hook.mjs'), '// old hook');
  writeFileSync(join(dir, 'node_modules', 'old.txt'), 'old');
  return dir;
}

// Code/install dir is ALWAYS homedir-rooted (~/.claude-mem-lite), independent of
// CLAUDE_MEM_DIR relocation — Claude Code bakes absolute paths to server.mjs/hooks
// there. os.homedir() honors $HOME on POSIX, so HOME steers CODE_DIR in tests.
// A regular-file server.mjs (not a symlink) keeps isDevMode() false.
function makeCodeHome(version = '1.0.0') {
  const home = makeDir('mem-update-home');
  const codeDir = join(home, '.claude-mem-lite');
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, 'package.json'), JSON.stringify({ version }, null, 2));
  writeFileSync(join(codeDir, 'server.mjs'), '// code server');
  return { home, codeDir };
}

function makeReleaseDir(version = '1.1.0') {
  const dir = makeDir('mem-update-release');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'registry'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }, null, 2));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'claude-mem-lite', lockfileVersion: 3 }, null, 2));
  writeFileSync(join(dir, 'hook.mjs'), '// new hook');
  writeFileSync(join(dir, 'server.mjs'), '// new server');
  writeFileSync(join(dir, 'cli.mjs'), '#!/usr/bin/env node\n// new cli\n');
  writeFileSync(join(dir, 'scripts', 'post-tool-use.sh'), '#!/usr/bin/env bash\necho ok\n');
  writeFileSync(join(dir, 'registry', 'preinstalled.json'), '{"resources":[]}');
  return dir;
}

// hook-update picks its transport from the proxy env: a proxy → CONNECT tunnel,
// none → native fetch. Every test here stubs globalThis.fetch, so on a developer
// machine that HAS HTTPS_PROXY set (the exact machine the tunnel was written
// for) the stub would be bypassed and these tests would hit the real network.
// Neutralize the four vars httpConnectProxyFor reads — same guard as
// tests/haiku-client.test.mjs. Restored in afterEach.
const PROXY_ENV_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
const originalProxyEnv = Object.fromEntries(PROXY_ENV_VARS.map((v) => [v, process.env[v]]));

async function loadModule(env = {}) {
  vi.resetModules();
  for (const v of PROXY_ENV_VARS) delete process.env[v];
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_MEM_SKIP_UPDATE;
  // `process.env.X = undefined` coerces to the STRING "undefined", which the
  // schema.mjs data-dir resolver now rejects (lib/resolve-data-dir.mjs). A test
  // that doesn't relocate must leave CLAUDE_MEM_DIR truly UNSET, not "undefined"
  // — mirror the afterEach delete instead of assigning a nullish value.
  if (env.CLAUDE_MEM_DIR === undefined) delete process.env.CLAUDE_MEM_DIR;
  else process.env.CLAUDE_MEM_DIR = env.CLAUDE_MEM_DIR;
  if (env.HOME) process.env.HOME = env.HOME;
  if (env.CLAUDE_PLUGIN_ROOT) process.env.CLAUDE_PLUGIN_ROOT = env.CLAUDE_PLUGIN_ROOT;
  return await import('../hook-update.mjs');
}

afterEach(() => {
  mockedExecSync.mockReset();
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(originalProxyEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_MEM_SKIP_UPDATE;
  delete process.env.CLAUDE_MEM_DIR;
  process.env.HOME = originalHome;
  for (const dir of trackedDirs) rmSync(dir, { recursive: true, force: true });
  trackedDirs.clear();
});

describe('createUpdateTmpDir (P3-4: predictable-/tmp TOCTOU)', () => {
  it('creates an owner-only (0700), unpredictably-named staging dir', async () => {
    const { createUpdateTmpDir } = await loadModule();
    const a = createUpdateTmpDir();
    const b = createUpdateTmpDir();
    try {
      // Old code: join(tmpdir(), `claude-mem-lite-update-${Date.now()}`) — guessable, and two
      // same-ms calls collide. mkdtempSync gives a random suffix, so a !== b always.
      expect(a).not.toBe(b);
      expect(a).toContain('claude-mem-lite-update-');
      // 0700: no group/other permission bits (old mkdirSync(recursive) inherited ~0755).
      expect(statSync(a).mode & 0o077).toBe(0);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('hook update lifecycle', () => {
  it('plugin mode only reports available updates and never installs them', async () => {
    const { home } = makeCodeHome('1.0.0');
    const dataDir = makeDataDir();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.1.0', tarball_url: 'https://example.com/release.tgz' }) });
    const { checkForUpdate } = await loadModule({ CLAUDE_MEM_DIR: dataDir, CLAUDE_PLUGIN_ROOT: '/plugin/root', HOME: home });

    const result = await checkForUpdate({ force: true });
    expect(result).toMatchObject({ updateAvailable: true, updated: false, installDeferred: true, to: '1.1.0' });
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dataDir, 'runtime', 'update-state.json'), 'utf8')).latestVersion).toBe('1.1.0');
  });

  it('manual force check bypasses the throttle window', async () => {
    const { home } = makeCodeHome('1.0.0');
    const dataDir = makeDataDir();
    writeFileSync(join(dataDir, 'runtime', 'update-state.json'), JSON.stringify({ lastCheck: new Date().toISOString(), installedVersion: '1.0.0', updateAvailable: false }, null, 2));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.1.0', tarball_url: 'https://example.com/release.tgz' }) });
    const { checkForUpdate } = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });

    expect(await checkForUpdate()).toBeNull();
    const result = await checkForUpdate({ force: true, allowInstall: false });
    expect(result).toMatchObject({ updateAvailable: true, installDeferred: true, to: '1.1.0' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('staged install swaps files only after npm install succeeds', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
        writeFileSync(join(opts.cwd, 'node_modules', 'new.txt'), 'new');
      }
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(true);
    expect(readFileSync(join(dataDir, 'hook.mjs'), 'utf8')).toContain('new hook');
    expect(readFileSync(join(dataDir, 'package-lock.json'), 'utf8')).toContain('lockfileVersion');
    expect(existsSync(join(dataDir, 'node_modules', 'new.txt'))).toBe(true);
    expect(existsSync(join(dataDir, 'node_modules', 'old.txt'))).toBe(false);
  });

  // Regression v2.73.1: copyFileSync preserves source mode and git stores
  // cli.mjs as 100644 — without the chmod inside copyReleaseIntoStaging the
  // ~/.local/bin/claude-mem-lite → cli.mjs symlink target loses its +x bit
  // after every auto-update, dying with "Permission denied" on next CLI call.
  // POSIX-only: Windows has no chmod semantics, so the assertion is skipped.
  it.skipIf(process.platform === 'win32')('staged install marks cli.mjs executable after auto-update', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
      }
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(true);
    const installedCli = join(dataDir, 'cli.mjs');
    expect(existsSync(installedCli)).toBe(true);
    // Any of owner/group/other execute bits proves chmod ran (POSIX mode mask)
    expect(statSync(installedCli).mode & 0o111).not.toBe(0);
  });

  it('staged install restores prior files when npm install fails', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    mockedExecSync.mockImplementation((cmd) => {
      if (String(cmd).startsWith('npm install')) throw new Error('npm failed');
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(false);
    expect(readFileSync(join(dataDir, 'hook.mjs'), 'utf8')).toContain('old hook');
    expect(existsSync(join(dataDir, 'node_modules', 'old.txt'))).toBe(true);
    expect(readdirSync(dataDir).filter(name => name.startsWith('.update-'))).toHaveLength(0);
  });

  it('MED-5: rolls back when the post-install smoke fails (broken install not kept)', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) { mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true }); return ''; }
      // The post-install smoke (node cli.mjs help / node --check) fails → the swapped
      // code does not boot, so the install must be reverted to the prior version.
      if (String(cmd).includes('cli.mjs') || String(cmd).includes('--check')) {
        throw new Error('SyntaxError: Unexpected token (simulated broken install)');
      }
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(false);
    // Old version restored, the broken new version reverted, no leftover staging/backup dirs.
    expect(readFileSync(join(dataDir, 'hook.mjs'), 'utf8')).toContain('old hook');
    expect(readdirSync(dataDir).filter(name => name.startsWith('.update-'))).toHaveLength(0);
  });

  // D#8 regression: `cli.mjs help` exits without opening the DB, so the smoke
  // gate passed with a present-but-uncompiled better-sqlite3 (npm >= 12 blocks
  // lifecycle scripts and exits 0 without producing the .node binding). The
  // smoke gate now probes the binding in a child process when the switched-in
  // node_modules contains better-sqlite3, rebuilding with scripts enabled on
  // failure. Fixtures without node_modules/better-sqlite3 skip the probe.
  describe('post-install smoke: native binding probe', () => {
    // npm install lays down node_modules/better-sqlite3 in staging so the
    // switched-in tree triggers the probe branch.
    const installWithBinding = (extra) => (cmd, opts = {}) => {
      const c = String(cmd);
      if (c.startsWith('npm install')) {
        mkdirSync(join(opts.cwd, 'node_modules', 'better-sqlite3'), { recursive: true });
        return '';
      }
      return extra(c);
    };

    it('probes the binding after the swap and passes a healthy install', async () => {
      const dataDir = makeDataDir();
      const releaseDir = makeReleaseDir();
      let probes = 0;
      mockedExecSync.mockImplementation(installWithBinding((c) => {
        if (c.includes('createRequire')) probes++;
        return '';
      }));
      const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

      expect(await installExtractedRelease(releaseDir, dataDir)).toBe(true);
      expect(probes).toBe(1);
    });

    it('rebuilds with scripts enabled when the probe fails, then re-probes (npm >= 12 heal)', async () => {
      const dataDir = makeDataDir();
      const releaseDir = makeReleaseDir();
      let probes = 0;
      const rebuilds = [];
      mockedExecSync.mockImplementation(installWithBinding((c) => {
        if (c.includes('createRequire')) {
          probes++;
          if (probes === 1) throw new Error('Could not locate the bindings file');
          return '';
        }
        if (c.startsWith('npm rebuild')) { rebuilds.push(c); return ''; }
        return '';
      }));
      const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

      expect(await installExtractedRelease(releaseDir, dataDir)).toBe(true);
      expect(probes).toBe(2);
      expect(rebuilds).toEqual(['npm rebuild better-sqlite3 --dangerously-allow-all-scripts']);
    });

    it('rolls back when the binding stays broken after rebuild', async () => {
      const dataDir = makeDataDir();
      const releaseDir = makeReleaseDir();
      mockedExecSync.mockImplementation(installWithBinding((c) => {
        if (c.includes('createRequire')) throw new Error('Could not locate the bindings file');
        if (c.startsWith('npm rebuild')) return '';
        return '';
      }));
      const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

      expect(await installExtractedRelease(releaseDir, dataDir)).toBe(false);
      expect(readFileSync(join(dataDir, 'hook.mjs'), 'utf8')).toContain('old hook');
      expect(readdirSync(dataDir).filter(name => name.startsWith('.update-'))).toHaveLength(0);
    });
  });

  // Regression: scripts/ is curated to HOOK_SCRIPT_FILES only — dev-only
  // helpers (mock-claude.mjs, extract-repos.mjs, p0-forward-probe.mjs…) and
  // any future subdirectories MUST NOT leak into ~/.claude-mem-lite/scripts/.
  // Pre-v2.55 hook-update did a recursive copy of the whole scripts/ tree and
  // shipped every dev-only file from the GitHub Releases tarball.
  it('staged install curates scripts/ to HOOK_SCRIPT_FILES and skips dev-only files', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    // Add the rest of HOOK_SCRIPT_FILES so we can assert all five land
    writeFileSync(join(releaseDir, 'scripts', 'user-prompt-search.js'), '// search');
    writeFileSync(join(releaseDir, 'scripts', 'prompt-search-utils.mjs'), '// utils');
    writeFileSync(join(releaseDir, 'scripts', 'pre-tool-recall.js'), '// recall');
    writeFileSync(join(releaseDir, 'scripts', 'pre-skill-bridge.js'), '// bridge');
    // Dev-only file + nested helper subdir — neither should land in dataDir
    writeFileSync(join(releaseDir, 'scripts', 'mock-claude.mjs'), '// dev-only');
    mkdirSync(join(releaseDir, 'scripts', 'helpers'), { recursive: true });
    writeFileSync(join(releaseDir, 'scripts', 'helpers', 'tool.mjs'), '// nested');
    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
      }
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(true);
    // All five curated hook scripts land
    for (const name of ['post-tool-use.sh', 'user-prompt-search.js', 'prompt-search-utils.mjs', 'pre-tool-recall.js', 'pre-skill-bridge.js']) {
      expect(existsSync(join(dataDir, 'scripts', name))).toBe(true);
    }
    // Dev-only file + nested helper subdir do not land
    expect(existsSync(join(dataDir, 'scripts', 'mock-claude.mjs'))).toBe(false);
    expect(existsSync(join(dataDir, 'scripts', 'helpers'))).toBe(false);
  });

  // Regression v2.84: pre-fix, copyReleaseIntoStaging + SWITCHABLE_PATHS used
  // SOURCE_FILES imported from the *currently-installed* source-files.mjs (i.e.
  // the local module), so any file added to the manifest in a newer release got
  // silently dropped during the very auto-update that introduced it. Concrete
  // hit: v2.80.x → v2.81.0 auto-update copied the new hook.mjs (it was already
  // in the v2.80 manifest) but skipped lib/cite-back-hint.mjs (added in v2.81)
  // → hook.mjs ERR_MODULE_NOT_FOUND on first SessionStart, hook chain dead,
  // self-update can no longer run to repair itself. Fix: read the tarball's
  // own source-files.mjs and use its SOURCE_FILES / HOOK_SCRIPT_FILES.
  it('staged install honors the tarball-bundled source-files manifest, not the installed one', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();

    // A file the *installed* source-files.mjs has no knowledge of, but which
    // the *tarball* manifest declares ships with the release.
    const newRelPath = 'lib/added-after-installed.mjs';
    mkdirSync(join(releaseDir, 'lib'), { recursive: true });
    writeFileSync(join(releaseDir, newRelPath), '// added in newer release\n');
    writeFileSync(
      join(releaseDir, 'source-files.mjs'),
      "export const SOURCE_FILES = ['hook.mjs', 'server.mjs', 'cli.mjs', 'package.json', 'package-lock.json', 'source-files.mjs', '" +
        newRelPath +
        "'];\nexport const HOOK_SCRIPT_FILES = ['post-tool-use.sh'];\n",
    );

    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
      }
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(true);
    expect(existsSync(join(dataDir, newRelPath))).toBe(true);
    expect(readFileSync(join(dataDir, newRelPath), 'utf8')).toContain('added in newer release');
  });

  // Regression: pre-v2.55 readdirSync + copyFileSync threw EISDIR on any
  // subdirectory under registry/, silently rolling back the entire update.
  // registry/ stays recursive so future subtrees ship intact.
  it('staged install recursively copies subdirectories under registry/', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    mkdirSync(join(releaseDir, 'registry', 'fixtures'), { recursive: true });
    writeFileSync(join(releaseDir, 'registry', 'fixtures', 'sample.json'), '{}');
    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
      }
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir });

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(true);
    expect(existsSync(join(dataDir, 'registry', 'fixtures', 'sample.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'registry', 'preinstalled.json'))).toBe(true);
  });
});

// Regression D#27: hook-update.mjs:19 set INSTALL_DIR = DB_DIR, conflating the
// plugin CODE location (server.mjs / package.json / install target — always
// homedir-rooted because Claude Code bakes absolute paths there) with the DATA
// location (runtime/update-state — env-aware via CLAUDE_MEM_DIR). Under
// relocation (CLAUDE_MEM_DIR set ≠ homedir) auto-update read the version from
// and switched files into the *data* dir, so it never found/updated the real
// server.mjs. State, by contrast, correctly belongs in the data dir (install.mjs
// doctor reads MEM_DATA_DIR/runtime/update-state.json). Fix: INSTALL_DIR = CODE_DIR
// (homedir), STATE_DIR = DB_DIR (data).
describe('code/data dir separation under relocation (D#27)', () => {
  it('getCurrentVersion reads the homedir code dir, not the relocated CLAUDE_MEM_DIR data dir', async () => {
    const { home } = makeCodeHome('2.0.0');          // real code install → 2.0.0
    const dataDir = makeDataDir('1.0.0');            // relocated data dir holds a 1.0.0 decoy package.json
    const { getCurrentVersion } = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });
    // Pre-fix INSTALL_DIR = DB_DIR = dataDir → would read the 1.0.0 decoy.
    expect(getCurrentVersion()).toBe('2.0.0');
  });

  // Pure-plugin install: ~/.claude-mem-lite holds only DB + runtime state, no
  // package.json, so INSTALL_DIR read fails and pre-fix returned '0.0.0' — which
  // made checkForUpdate compute hasUpdate=true and nag every SessionStart. Fix
  // reads the running plugin-cache version from CLAUDE_PLUGIN_ROOT.
  it('getCurrentVersion reads CLAUDE_PLUGIN_ROOT package.json in plugin mode when the code dir has none', async () => {
    const home = makeDir('mem-update-home');
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });  // state only, no package.json
    const pluginRoot = makeDir('mem-plugin-root');
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '3.84.0' }, null, 2));
    const { getCurrentVersion } = await loadModule({ HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot });
    // Pre-fix: no package.json in the code dir → catch → '0.0.0'.
    expect(getCurrentVersion()).toBe('3.84.0');
  });

  it('installExtractedRelease defaults its target to the homedir code dir, not CLAUDE_MEM_DIR', async () => {
    const { home, codeDir } = makeCodeHome('1.0.0');
    writeFileSync(join(codeDir, 'hook.mjs'), '// old hook');
    mkdirSync(join(codeDir, 'node_modules'), { recursive: true });
    const dataDir = makeDataDir('1.0.0');            // data dir keeps its own hook.mjs that must stay untouched
    const releaseDir = makeReleaseDir('1.1.0');
    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
      return '';
    });
    const { installExtractedRelease } = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });

    // No explicit targetDir → must default to the code dir, not the relocated data dir.
    expect(await installExtractedRelease(releaseDir)).toBe(true);
    expect(readFileSync(join(codeDir, 'hook.mjs'), 'utf8')).toContain('new hook');   // code dir updated
    expect(readFileSync(join(dataDir, 'hook.mjs'), 'utf8')).toContain('old hook');   // data dir untouched
  });

  it('update state still lands in the CLAUDE_MEM_DIR data dir, not the code dir', async () => {
    const { home, codeDir } = makeCodeHome('1.0.0');
    const dataDir = makeDataDir('1.0.0');
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.1.0', tarball_url: 'https://example.com/release.tgz' }) });
    const { checkForUpdate } = await loadModule({ CLAUDE_MEM_DIR: dataDir, CLAUDE_PLUGIN_ROOT: '/plugin/root', HOME: home });

    await checkForUpdate({ force: true });
    // State path mirrors hook-shared RUNTIME_DIR (= DB_DIR/runtime) and install.mjs
    // doctor's MEM_DATA_DIR/runtime/update-state.json — it must NOT follow the code dir.
    expect(existsSync(join(dataDir, 'runtime', 'update-state.json'))).toBe(true);
    expect(existsSync(join(codeDir, 'runtime', 'update-state.json'))).toBe(false);
  });
});

describe('rate-limit handling + malformed-response robustness', () => {
  it('persists rateLimited=true on a 403 instead of clobbering it (regression)', async () => {
    const { home } = makeCodeHome('1.0.0');
    const dataDir = makeDataDir('1.0.0');
    const statePath = join(dataDir, 'runtime', 'update-state.json');
    writeFileSync(statePath, JSON.stringify({ lastCheck: new Date(0).toISOString(), rateLimited: false }));
    // GitHub 403 → fetchWithTimeout writes rateLimited:true; the !latest branch must not
    // clobber it back to false with a stale in-memory snapshot.
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const { checkForUpdate } = await loadModule({ CLAUDE_MEM_DIR: dataDir, CLAUDE_PLUGIN_ROOT: '/plugin/root', HOME: home });

    const result = await checkForUpdate({ force: true });
    expect(result).toBeNull();
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.rateLimited).toBe(true);
  });

  it('falls through to the tags API when releases/latest returns 200 with no tag_name (no crash)', async () => {
    const { home } = makeCodeHome('1.0.0');
    const dataDir = makeDataDir('1.0.0');
    // 1st call (releases/latest): 200 OK but malformed body {}. 2nd call (tags): valid.
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ([{ name: 'v1.1.0' }]) });
    const { checkForUpdate } = await loadModule({ CLAUDE_MEM_DIR: dataDir, CLAUDE_PLUGIN_ROOT: '/plugin/root', HOME: home });

    const result = await checkForUpdate({ force: true });
    expect(result).toMatchObject({ updateAvailable: true, to: '1.1.0' });
  });
});

describe('cache hook residue clearing', () => {
  it('clears populated hooks.json in every remaining cache version', async () => {
    const home = makeDir('mem-cache-residue');
    const cacheBase = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
    for (const v of ['2.28.0', '2.31.0']) {
      mkdirSync(join(cacheBase, v, 'hooks'), { recursive: true });
      writeFileSync(join(cacheBase, v, 'hooks', 'hooks.json'), JSON.stringify({
        description: 'original', hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] },
      }));
    }
    // A third version with already-empty hooks.json should be untouched.
    mkdirSync(join(cacheBase, '2.30.0', 'hooks'), { recursive: true });
    writeFileSync(join(cacheBase, '2.30.0', 'hooks', 'hooks.json'), JSON.stringify({ description: 'empty', hooks: {} }));

    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { clearCacheHookResidue } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
      expect(clearCacheHookResidue()).toBe(2);

      for (const v of ['2.28.0', '2.31.0']) {
        const after = JSON.parse(readFileSync(join(cacheBase, v, 'hooks', 'hooks.json'), 'utf8'));
        expect(after.hooks).toEqual({});
        expect(after._note).toMatch(/hook-update\.mjs post-install/);
      }
      const empty = JSON.parse(readFileSync(join(cacheBase, '2.30.0', 'hooks', 'hooks.json'), 'utf8'));
      expect(empty._note).toBeUndefined();
    } finally {
      process.env.HOME = origHome;
    }
  });

  it('returns 0 when cache base does not exist', async () => {
    const home = makeDir('mem-cache-residue-empty');
    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { clearCacheHookResidue } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
      expect(clearCacheHookResidue()).toBe(0);
    } finally {
      process.env.HOME = origHome;
    }
  });
});

describe('plugin cache pruning', () => {
  it('removes old versions and keeps the latest 3', async () => {
    const home = makeDir('mem-prune-home');
    const cacheBase = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
    const versions = ['1.0.0', '1.1.0', '2.0.0', '2.1.0', '2.5.0'];
    for (const v of versions) {
      mkdirSync(join(cacheBase, v), { recursive: true });
      writeFileSync(join(cacheBase, v, 'server.mjs'), `// v${v}`);
    }

    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { prunePluginCache } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
      const removed = prunePluginCache();
      expect(removed).toBe(2);

      const remaining = readdirSync(cacheBase).sort();
      expect(remaining).toEqual(['2.0.0', '2.1.0', '2.5.0']);
    } finally {
      process.env.HOME = origHome;
    }
  });

  it('does nothing when 3 or fewer versions exist', async () => {
    const home = makeDir('mem-prune-home2');
    const cacheBase = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
    for (const v of ['1.0.0', '2.0.0']) {
      mkdirSync(join(cacheBase, v), { recursive: true });
    }

    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { prunePluginCache } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
      expect(prunePluginCache()).toBe(0);
      expect(readdirSync(cacheBase)).toHaveLength(2);
    } finally {
      process.env.HOME = origHome;
    }
  });
});

describe('validateExtractedTarball', () => {
  function makeTarballDir({ name = 'claude-mem-lite', version = '2.57.0', entries = ['cli.mjs', 'server.mjs', 'hook.mjs'], skipPkg = false } = {}) {
    const dir = makeDir('mem-tarball-validate');
    if (!skipPkg) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
    }
    for (const f of entries) {
      writeFileSync(join(dir, f), `// ${f}`);
    }
    return dir;
  }

  it('accepts a well-formed tarball when version matches', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ version: '2.57.0' });
    expect(validateExtractedTarball(dir, '2.57.0')).toEqual({ ok: true });
  });

  it('rejects when package.json is missing', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ skipPkg: true });
    const result = validateExtractedTarball(dir, '2.57.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/package\.json missing/);
  });

  it('rejects when package.json is unparseable', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ skipPkg: true });
    writeFileSync(join(dir, 'package.json'), '{not valid json');
    const result = validateExtractedTarball(dir, '2.57.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unparseable/);
  });

  it('rejects when name is wrong (repo squatter / rename)', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ name: 'malicious-clone' });
    const result = validateExtractedTarball(dir, '2.57.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/name "malicious-clone"/);
  });

  it('rejects when version does not match the resolved tag', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ version: '2.50.0' });
    const result = validateExtractedTarball(dir, '2.57.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/version "2\.50\.0".*"2\.57\.0"/);
  });

  it('rejects when an entry-point file is missing', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ entries: ['cli.mjs', 'server.mjs'] }); // no hook.mjs
    const result = validateExtractedTarball(dir, '2.57.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/entry-point file missing: hook\.mjs/);
  });

  it('skips version match when expectedVersion is not provided (release-resolution shortcut)', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ version: '99.99.99' });
    expect(validateExtractedTarball(dir)).toEqual({ ok: true });
  });

  it('honors expectedName override (for fork installs)', async () => {
    const { validateExtractedTarball } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const dir = makeTarballDir({ name: 'forked-mem-lite', version: '1.0.0' });
    expect(validateExtractedTarball(dir, '1.0.0', 'forked-mem-lite')).toEqual({ ok: true });
  });
});

describe('isRepairDowngrade (P3-3: signed-release rollback guard)', () => {
  it('flags a strictly-older resolved release as a downgrade', async () => {
    const { isRepairDowngrade } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    // Attacker replays v3.20.0 (validly signed, since-patched) as "latest" over installed v3.43.0.
    expect(isRepairDowngrade('3.20.0', '3.43.0')).toBe(true);
    expect(isRepairDowngrade('3.42.9', '3.43.0')).toBe(true);
  });

  it('allows same-or-newer releases (legitimate repair / self-heal)', async () => {
    const { isRepairDowngrade } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    expect(isRepairDowngrade('3.43.0', '3.43.0')).toBe(false);   // re-sync same version
    expect(isRepairDowngrade('3.44.0', '3.43.0')).toBe(false);   // forward
  });

  it('allows through when the local version is unknown (broken install still needs repair)', async () => {
    const { isRepairDowngrade } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    expect(isRepairDowngrade('3.20.0', null)).toBe(false);
    expect(isRepairDowngrade('3.20.0', undefined)).toBe(false);
    expect(isRepairDowngrade(null, '3.43.0')).toBe(false);
  });
});

describe('non-blocking SessionStart helpers (P3d)', () => {
  function seedState(dataDir, state) {
    writeFileSync(join(dataDir, 'runtime', 'update-state.json'), JSON.stringify(state, null, 2));
  }

  it('getCachedUpdateBanner returns the available banner from cached state — no network', async () => {
    const { home } = makeCodeHome('1.0.0'); // non-symlink server.mjs → isDevMode() false
    const dataDir = makeDataDir('1.0.0');
    seedState(dataDir, { lastCheck: new Date().toISOString(), installedVersion: '1.0.0', latestVersion: '1.2.0', updateAvailable: true });
    globalThis.fetch = vi.fn(); // must NOT be called
    const { getCachedUpdateBanner } = await loadModule({ CLAUDE_MEM_DIR: dataDir, CLAUDE_PLUGIN_ROOT: '/plugin/root', HOME: home });
    const banner = getCachedUpdateBanner();
    expect(banner).toContain('v1.2.0 available');
    expect(banner).toContain('current: v1.0.0');
    expect(banner).toContain('plugin mode'); // plugin-mode hint
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('getCachedUpdateBanner returns null when no update is cached', async () => {
    const { home } = makeCodeHome('1.0.0'); // non-symlink server.mjs → isDevMode() false
    const dataDir = makeDataDir('1.0.0');
    seedState(dataDir, { lastCheck: new Date().toISOString(), installedVersion: '1.0.0', updateAvailable: false });
    const { getCachedUpdateBanner } = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });
    expect(getCachedUpdateBanner()).toBeNull();
  });

  it('isUpdateCheckDue is true with no prior check and false right after one', async () => {
    const { home } = makeCodeHome('1.0.0'); // non-symlink server.mjs → isDevMode() false
    const dataDir = makeDataDir('1.0.0');
    const { isUpdateCheckDue } = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });
    expect(isUpdateCheckDue()).toBe(true); // no state file → never checked
    seedState(dataDir, { lastCheck: new Date().toISOString(), installedVersion: '1.0.0', updateAvailable: false });
    const { isUpdateCheckDue: due2 } = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });
    expect(due2()).toBe(false); // just checked → throttled
  });

  it('isUpdateCheckDue is false when CLAUDE_MEM_SKIP_UPDATE is set', async () => {
    const { home } = makeCodeHome('1.0.0'); // non-symlink server.mjs → isDevMode() false
    const dataDir = makeDataDir('1.0.0');
    const mod = await loadModule({ CLAUDE_MEM_DIR: dataDir, HOME: home });
    process.env.CLAUDE_MEM_SKIP_UPDATE = '1';
    expect(mod.isUpdateCheckDue()).toBe(false);
    expect(mod.getCachedUpdateBanner()).toBeNull();
  });
});

// A plugin-cache version dir: ~/.claude/plugins/cache/sdsrss/claude-mem-lite/<ver>/
// with a package.json whose name passes validateExtractedTarball and the three
// required entry points. No source-files.mjs → loadReleaseManifest falls back to
// the real LOCAL_SOURCE_FILES manifest; only the files present here get copied.
function makeCacheVersion(home, version, body = `// v${version}`) {
  const dir = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'claude-mem-lite', version }, null, 2));
  writeFileSync(join(dir, 'cli.mjs'), `#!/usr/bin/env node\n${body} cli\n`);
  writeFileSync(join(dir, 'server.mjs'), `${body} server`);
  writeFileSync(join(dir, 'hook.mjs'), `${body} hook`);
  writeFileSync(join(dir, 'schema.mjs'), `${body} schema`);
  return dir;
}

// syncDataDirFromCache only heals an EXISTING standalone-CLI code install,
// proven by package.json (makeCodeHome writes it) + a resolvable better-sqlite3
// binding. This seeds the binding so the sync path proceeds in tests.
function seedBinding(codeDir) {
  mkdirSync(join(codeDir, 'node_modules', 'better-sqlite3'), { recursive: true });
  writeFileSync(join(codeDir, 'node_modules', 'better-sqlite3', 'index.js'), '// abi-correct');
}

describe('syncDataDirFromCache (plugin-cache → data-dir code sync)', () => {
  it('upgrades the data-dir code from a newer cache version without running npm install', async () => {
    const { home, codeDir } = makeCodeHome('1.0.0');
    seedBinding(codeDir);
    makeCacheVersion(home, '2.0.0', '// v2.0.0');
    const { syncDataDirFromCache } = await loadModule({ HOME: home });

    const result = await syncDataDirFromCache();
    expect(result).toMatchObject({ synced: true, from: '1.0.0', to: '2.0.0' });
    // Source files landed at the cache version
    expect(JSON.parse(readFileSync(join(codeDir, 'package.json'), 'utf8')).version).toBe('2.0.0');
    expect(readFileSync(join(codeDir, 'cli.mjs'), 'utf8')).toContain('v2.0.0 cli');
    expect(readFileSync(join(codeDir, 'hook.mjs'), 'utf8')).toContain('v2.0.0 hook');
    expect(readFileSync(join(codeDir, 'schema.mjs'), 'utf8')).toContain('v2.0.0 schema');
    // Local-cache sync MUST NOT shell out to npm install. (The MED-5 post-install
    // smoke may invoke `node … help` / `node --check`, but never `npm install`.)
    expect(mockedExecSync.mock.calls.some((c) => String(c[0]).startsWith('npm install'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('marks the synced cli.mjs executable', async () => {
    const { home, codeDir } = makeCodeHome('1.0.0');
    seedBinding(codeDir);
    makeCacheVersion(home, '2.0.0');
    const { syncDataDirFromCache } = await loadModule({ HOME: home });
    await syncDataDirFromCache();
    expect(statSync(join(codeDir, 'cli.mjs')).mode & 0o111).not.toBe(0);
  });

  it('leaves the data-dir node_modules untouched (skipNpmInstall)', async () => {
    const { home, codeDir } = makeCodeHome('1.0.0');
    mkdirSync(join(codeDir, 'node_modules', 'better-sqlite3'), { recursive: true });
    writeFileSync(join(codeDir, 'node_modules', 'better-sqlite3', 'index.js'), '// abi-correct');
    makeCacheVersion(home, '2.0.0');
    const { syncDataDirFromCache } = await loadModule({ HOME: home });
    await syncDataDirFromCache();
    expect(readFileSync(join(codeDir, 'node_modules', 'better-sqlite3', 'index.js'), 'utf8')).toContain('abi-correct');
  });

  it('no-ops when the data-dir is already at or ahead of the cache version', async () => {
    const { home, codeDir } = makeCodeHome('2.0.0');
    seedBinding(codeDir);
    makeCacheVersion(home, '2.0.0');
    const { syncDataDirFromCache } = await loadModule({ HOME: home });
    const result = await syncDataDirFromCache();
    expect(result).toMatchObject({ synced: false, reason: 'data-dir-current', sourceVersion: '2.0.0', dataVersion: '2.0.0' });
    // cli.mjs was never written by the no-op (makeCodeHome doesn't create it)
    expect(existsSync(join(codeDir, 'cli.mjs'))).toBe(false);
  });

  it('picks the highest valid cache version when scanning', async () => {
    const { home, codeDir } = makeCodeHome('1.0.0');
    seedBinding(codeDir);
    makeCacheVersion(home, '2.0.0');
    makeCacheVersion(home, '2.10.0');   // semver, not lexicographic — must win over 2.0.0/2.9.0
    makeCacheVersion(home, '2.9.0');
    const { syncDataDirFromCache } = await loadModule({ HOME: home });
    const result = await syncDataDirFromCache();
    expect(result).toMatchObject({ synced: true, to: '2.10.0' });
    expect(JSON.parse(readFileSync(join(codeDir, 'package.json'), 'utf8')).version).toBe('2.10.0');
  });

  it('returns no-cache when the plugin cache dir is absent', async () => {
    const { home } = makeCodeHome('1.0.0');
    const { syncDataDirFromCache } = await loadModule({ HOME: home });
    expect(await syncDataDirFromCache()).toMatchObject({ synced: false, reason: 'no-cache' });
  });

  it('skips a cache version whose package.json name is not claude-mem-lite', async () => {
    const { home } = makeCodeHome('1.0.0');
    const dir = makeCacheVersion(home, '2.0.0');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'evil-squatter', version: '2.0.0' }, null, 2));
    const { syncDataDirFromCache } = await loadModule({ HOME: home });
    // Only that one (invalid) version exists → no valid version to sync from
    expect(await syncDataDirFromCache()).toMatchObject({ synced: false, reason: 'no-valid-cache-version' });
  });

  it('skips in dev mode (data-dir server.mjs is a symlink)', async () => {
    const { home, codeDir } = makeCodeHome('1.0.0');
    // Replace the regular-file server.mjs with a symlink → isDevMode() true
    rmSync(join(codeDir, 'server.mjs'), { force: true });
    const realSrc = join(makeDir('mem-dev-src'), 'server.mjs');
    writeFileSync(realSrc, '// dev source');
    symlinkSync(realSrc, join(codeDir, 'server.mjs'));
    makeCacheVersion(home, '2.0.0');
    const { syncDataDirFromCache } = await loadModule({ HOME: home });
    expect(await syncDataDirFromCache()).toMatchObject({ synced: false, reason: 'dev-mode' });
  });

  it('treats a .git dir as dev mode (whole-directory symlink, server.mjs is a plain file)', async () => {
    // ~/.claude-mem-lite -> /repo whole-dir symlink: server.mjs there is a plain
    // file so the per-file probe misses it, but the checkout's .git is present.
    // Without this, auto-update would clobber the working tree.
    const { home, codeDir } = makeCodeHome('1.0.0');
    mkdirSync(join(codeDir, '.git'), { recursive: true });
    makeCacheVersion(home, '2.0.0');
    const { syncDataDirFromCache } = await loadModule({ HOME: home });
    expect(await syncDataDirFromCache()).toMatchObject({ synced: false, reason: 'dev-mode' });
  });

  it('treats a symlinked core file as dev mode even when server.mjs drifted to a plain copy', async () => {
    // Standard `install --dev` symlinks many files; if server.mjs drifts to a plain
    // copy but hook.mjs is still a symlink, the install is clearly dev-provisioned.
    const { home, codeDir } = makeCodeHome('1.0.0'); // server.mjs is a plain file
    const realSrc = join(makeDir('mem-dev-src2'), 'hook.mjs');
    writeFileSync(realSrc, '// dev hook source');
    symlinkSync(realSrc, join(codeDir, 'hook.mjs'));
    makeCacheVersion(home, '2.0.0');
    const { syncDataDirFromCache } = await loadModule({ HOME: home });
    expect(await syncDataDirFromCache()).toMatchObject({ synced: false, reason: 'dev-mode' });
  });

  it('skips a pure-plugin data dir that has no prior code install (no orphan code written)', async () => {
    // makeCodeHome writes package.json + server.mjs but NO node_modules — a
    // pure-plugin data dir holds only DATA and runs code from the cache. Drop
    // package.json too so neither proof-of-install signal is present.
    const { home, codeDir } = makeCodeHome('1.0.0');
    rmSync(join(codeDir, 'package.json'), { force: true });
    makeCacheVersion(home, '2.0.0');
    const { syncDataDirFromCache } = await loadModule({ HOME: home });
    const result = await syncDataDirFromCache();
    expect(result).toMatchObject({ synced: false, reason: 'no-existing-code-install' });
    // No source files leaked into the data dir
    expect(existsSync(join(codeDir, 'cli.mjs'))).toBe(false);
    expect(existsSync(join(codeDir, 'hook.mjs'))).toBe(false);
  });

  it('skips a data dir that has package.json but no resolvable better-sqlite3 binding', async () => {
    const { home } = makeCodeHome('1.0.0'); // package.json present, no node_modules
    makeCacheVersion(home, '2.0.0');
    const { syncDataDirFromCache } = await loadModule({ HOME: home });
    expect(await syncDataDirFromCache()).toMatchObject({ synced: false, reason: 'no-existing-code-install' });
  });

  it('skips when the resolved source is the target dir (non-plugin direct install)', async () => {
    const { home, codeDir } = makeCodeHome('1.0.0');
    const { syncDataDirFromCache } = await loadModule({ HOME: home });
    // sourceDir === targetDir → self-sync guard fires before any version compare
    expect(await syncDataDirFromCache({ sourceDir: codeDir })).toMatchObject({ synced: false, reason: 'source-is-target' });
  });

  it('honors an explicit sourceDir (launch.mjs passes the running ROOT)', async () => {
    const { home, codeDir } = makeCodeHome('1.0.0');
    seedBinding(codeDir);
    const root = makeCacheVersion(home, '3.1.0', '// v3.1.0');
    const { syncDataDirFromCache } = await loadModule({ HOME: home });
    const result = await syncDataDirFromCache({ sourceDir: root });
    expect(result).toMatchObject({ synced: true, to: '3.1.0' });
    expect(readFileSync(join(codeDir, 'cli.mjs'), 'utf8')).toContain('v3.1.0 cli');
  });
});

describe('release signature verification (P1 supply-chain)', () => {
  function makeSignedRelease(version = '9.9.9') {
    const dir = makeDir('mem-sig-release');
    writeFileSync(join(dir, 'cli.mjs'), '// cli\n');
    writeFileSync(join(dir, 'server.mjs'), '// server\n');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const bytes = serializeManifest(buildReleaseManifest(dir, ['cli.mjs', 'server.mjs'], version));
    const sig = cryptoSign(null, Buffer.from(bytes), privateKey).toString('base64');
    return { dir, pub, bytes, sig };
  }

  it('verifyDownloadedRelease passes for a valid signature + intact files', async () => {
    const { verifyDownloadedRelease } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const { dir, pub, bytes, sig } = makeSignedRelease();
    expect(verifyDownloadedRelease(dir, bytes, sig, pub)).toMatchObject({ ok: true, reason: 'verified' });
  });

  it('verifyDownloadedRelease rejects a tampered file (hash mismatch)', async () => {
    const { verifyDownloadedRelease } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const { dir, pub, bytes, sig } = makeSignedRelease();
    writeFileSync(join(dir, 'server.mjs'), '// TROJANED\n'); // post-sign tamper
    const r = verifyDownloadedRelease(dir, bytes, sig, pub);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/file-mismatch/);
  });

  it('verifyDownloadedRelease rejects a signature from a foreign key', async () => {
    const { verifyDownloadedRelease } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const { dir, bytes, sig } = makeSignedRelease();
    const { publicKey: otherPub } = generateKeyPairSync('ed25519');
    const r = verifyDownloadedRelease(dir, bytes, sig, otherPub.export({ type: 'spki', format: 'pem' }).toString());
    expect(r).toMatchObject({ ok: false, reason: 'signature-invalid' });
  });

  it('verifyReleaseAuthenticity uses the embedded key by default → FAILS CLOSED (active since v3.20.0)', async () => {
    const { verifyReleaseAuthenticity } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    // A real RELEASE_PUBLIC_KEY is now embedded → the default regime VERIFIES.
    // A release carrying a manifest but NO .sig asset is refused (downgrade/strip
    // protection), short-circuiting before any network fetch.
    const assets = [{ name: 'release-manifest.json', browser_download_url: 'https://github.com/x/y/releases/download/v1/release-manifest.json' }];
    globalThis.fetch = vi.fn(); // must NOT be called — missing sig asset short-circuits
    expect(await verifyReleaseAuthenticity('/nonexistent', assets)).toMatchObject({ ok: false, action: 'missing-signature' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('embedded default key parses + rejects a foreign signature (signature-invalid, not a crash)', async () => {
    // Locks that the pasted RELEASE_PUBLIC_KEY is a valid Ed25519 SPKI key: this path
    // reaches createPublicKey(embedded) + crypto.verify. A manifest signed by a
    // DIFFERENT (test) key must come back signature-invalid — proving the embedded key
    // both parses and correctly refuses a non-matching signature (guards a corrupt paste).
    const { verifyDownloadedRelease } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const { dir, bytes, sig } = makeSignedRelease(); // signed by makeSignedRelease's own key, not the embedded one
    expect(verifyDownloadedRelease(dir, bytes, sig)).toMatchObject({ ok: false, reason: 'signature-invalid' });
  });

  it('verifyReleaseAuthenticity honors the CLAUDE_MEM_SKIP_SIG_VERIFY escape hatch', async () => {
    const mod = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    process.env.CLAUDE_MEM_SKIP_SIG_VERIFY = '1';
    try {
      expect(await mod.verifyReleaseAuthenticity('/nonexistent', [])).toMatchObject({ ok: true, action: 'skipped-env' });
    } finally {
      delete process.env.CLAUDE_MEM_SKIP_SIG_VERIFY;
    }
  });

  // Audit 2026-06-22 P1 #5: once a pubkey is embedded the verifier must fail CLOSED.
  // Pre-fix it was opportunistic-forever — an attacker who can publish a release (or
  // MITM the asset CDN) bypassed verification by simply omitting the signature assets
  // (the tags-fallback path always sends assets:[]). The publicKey param lets the test
  // exercise the keyed regime without committing a real embedded key.
  it('key present + NO signature assets → refuses to install (downgrade/strip protection)', async () => {
    const { verifyReleaseAuthenticity } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const { pub } = makeSignedRelease();
    globalThis.fetch = vi.fn(); // must NOT be reached
    const r = await verifyReleaseAuthenticity('/nonexistent', [], pub);
    expect(r).toMatchObject({ ok: false, action: 'missing-signature' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('key present + tags-fallback (assets undefined) → refuses', async () => {
    const { verifyReleaseAuthenticity } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const { pub } = makeSignedRelease();
    const r = await verifyReleaseAuthenticity('/nonexistent', undefined, pub);
    expect(r).toMatchObject({ ok: false, action: 'missing-signature' });
  });

  it('key present + valid signature assets → verified (legit signed release still installs)', async () => {
    const { verifyReleaseAuthenticity } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const { dir, pub, bytes, sig } = makeSignedRelease();
    const assets = [
      { name: 'release-manifest.json', browser_download_url: 'https://github.com/x/y/releases/download/v1/release-manifest.json' },
      { name: 'release-manifest.json.sig', browser_download_url: 'https://github.com/x/y/releases/download/v1/release-manifest.json.sig' },
    ];
    globalThis.fetch = vi.fn(async (url) => ({
      ok: true, status: 200,
      arrayBuffer: async () => (String(url).endsWith('.sig') ? Buffer.from(sig) : Buffer.from(bytes)),
    }));
    const r = await verifyReleaseAuthenticity(dir, assets, pub);
    expect(r).toMatchObject({ ok: true, action: 'verified' });
  });

  it('empty embedded key stays opportunistic (skipped-no-pubkey — unchanged default)', async () => {
    const { verifyReleaseAuthenticity } = await loadModule({ CLAUDE_MEM_DIR: makeDataDir() });
    const r = await verifyReleaseAuthenticity('/nonexistent', [], '');
    expect(r).toMatchObject({ ok: true, action: 'skipped-no-pubkey' });
  });
});


// A hard kill (SIGKILL / power loss) inside the rename loop leaves the install
// half-swapped: the try/catch rollback and the MED-5 smoke gate only run on paths
// the process survives to reach. The backup dir is the evidence — every normal exit
// (success, smoke-fail, error) deletes it — so finding one on the next install entry
// means a prior swap was interrupted and must be finished before another one starts.
describe('interrupted-swap recovery (audit P2-5)', () => {
  it('finishes the rollback of a leftover backup dir, restoring the pre-swap files', async () => {
    const { recoverInterruptedSwaps } = await loadModule();
    const target = makeDir('mem-swap-target');
    mkdirSync(join(target, 'lib'), { recursive: true });
    // Half-applied state: hook.mjs already switched to the new version, lib/late.mjs
    // was backed up but the process died before its replacement landed.
    writeFileSync(join(target, 'hook.mjs'), '// NEW hook');
    const backupDir = join(target, '.update-backup-1700000000000-4242');
    mkdirSync(join(backupDir, 'lib'), { recursive: true });
    writeFileSync(join(backupDir, 'hook.mjs'), '// OLD hook');
    writeFileSync(join(backupDir, 'lib', 'late.mjs'), '// OLD late');
    writeFileSync(join(backupDir, '.swap-journal.json'), JSON.stringify({
      backedUp: ['hook.mjs', 'lib/late.mjs'], installed: ['hook.mjs'],
    }));

    expect(recoverInterruptedSwaps(target)).toBe(1);

    expect(readFileSync(join(target, 'hook.mjs'), 'utf8')).toBe('// OLD hook');
    expect(readFileSync(join(target, 'lib', 'late.mjs'), 'utf8')).toBe('// OLD late');
    expect(existsSync(backupDir)).toBe(false);
  });

  it('sweeps orphan staging dirs and is a no-op on a clean install dir', async () => {
    const { recoverInterruptedSwaps } = await loadModule();
    const target = makeDir('mem-swap-clean');
    writeFileSync(join(target, 'hook.mjs'), '// current');
    const staging = join(target, '.update-staging-1700000000000-4242');
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'hook.mjs'), '// staged');

    expect(recoverInterruptedSwaps(target)).toBe(0);   // staging alone is not a torn swap
    expect(existsSync(staging)).toBe(false);
    expect(readFileSync(join(target, 'hook.mjs'), 'utf8')).toBe('// current');
    expect(recoverInterruptedSwaps(target)).toBe(0);   // idempotent
  });

  it('tolerates a backup dir with no journal (killed before the first rename)', async () => {
    const { recoverInterruptedSwaps } = await loadModule();
    const target = makeDir('mem-swap-nojournal');
    writeFileSync(join(target, 'hook.mjs'), '// current');
    const backupDir = join(target, '.update-backup-1700000000000-99');
    mkdirSync(backupDir, { recursive: true });

    expect(recoverInterruptedSwaps(target)).toBe(1);
    expect(existsSync(backupDir)).toBe(false);
    expect(readFileSync(join(target, 'hook.mjs'), 'utf8')).toBe('// current');
  });
});
