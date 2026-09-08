// `claude plugin uninstall` removes the manifest and leaves the plugin cache on disk —
// measured at 241 MB on a machine where the plugin was already gone. This project's own
// `uninstall` reclaims it, but only through a branch gated on "no other plugin from this
// marketplace remains", because the same branch also deletes the marketplace-wide directory.
// That gate is right for `cache/<marketplace>/` and wrong for `cache/<marketplace>/
// claude-mem-lite/`, which belongs to this plugin alone: a user with any sibling sdsrss
// plugin kept every cached version of a plugin they had uninstalled.
//
// §8.V3: a destructive path modified this session is exercised in a sandbox HOME, never
// against the real one. Every case here builds its own tree under mkdtemp.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeFixtureTracker } from './test-helpers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

/**
 * @param siblingPlugin  another plugin from the SAME marketplace, which is what closes the
 *                       gate on the marketplace-wide delete.
 */
function sandboxHome({ siblingPlugin }) {
  const home = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-uninst-home-')));
  const plugins = join(home, '.claude', 'plugins');
  const ourCache = join(plugins, 'cache', 'sdsrss', 'claude-mem-lite', '6.3.0');
  mkdirSync(join(ourCache, 'scripts'), { recursive: true });
  writeFileSync(join(ourCache, 'scripts', 'launch.mjs'), '// stub\n');
  writeFileSync(join(ourCache, 'package.json'), '{"name":"claude-mem-lite","version":"6.3.0"}');

  const siblingCache = join(plugins, 'cache', 'sdsrss', 'other-plugin', '1.0.0');
  mkdirSync(siblingCache, { recursive: true });
  writeFileSync(join(siblingCache, 'package.json'), '{"name":"other-plugin"}');

  mkdirSync(join(plugins, 'marketplaces', 'sdsrss'), { recursive: true });
  writeFileSync(join(plugins, 'marketplaces', 'sdsrss', 'marketplace.json'), '{}');

  const installed = { 'claude-mem-lite@sdsrss': { version: '6.3.0' } };
  if (siblingPlugin) installed['other-plugin@sdsrss'] = { version: '1.0.0' };
  writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify(installed));

  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: installed }));

  return {
    home,
    ourCacheRoot: join(plugins, 'cache', 'sdsrss', 'claude-mem-lite'),
    siblingCacheRoot: join(plugins, 'cache', 'sdsrss', 'other-plugin'),
    marketplaceCacheRoot: join(plugins, 'cache', 'sdsrss'),
    installedPath: join(plugins, 'installed_plugins.json'),
  };
}

function runUninstall(home) {
  const dataDir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-uninst-data-')));
  return spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'uninstall'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_MEM_DIR: dataDir,
      CLAUDE_MEM_SKIP_UPDATE: '1',
      MEM_NO_AUTO_ADOPT: '1',
    },
  });
}

describe('uninstall reclaims its own plugin cache', () => {
  it('removes our cache even when a sibling plugin keeps the marketplace alive', () => {
    const s = sandboxHome({ siblingPlugin: true });
    // Premise: the sibling really is what closes the gate, and both trees exist first.
    expect(existsSync(s.ourCacheRoot)).toBe(true);
    expect(existsSync(s.siblingCacheRoot)).toBe(true);

    const r = runUninstall(s.home);
    expect(r.status).toBe(0);
    expect(existsSync(s.ourCacheRoot)).toBe(false);
    // The gate still does its job for everything that is not ours.
    expect(existsSync(s.siblingCacheRoot)).toBe(true);
    expect(existsSync(s.marketplaceCacheRoot)).toBe(true);
  });

  it('still removes the whole marketplace cache when nothing else uses it', () => {
    // Control: the pre-existing behaviour must survive the change.
    const s = sandboxHome({ siblingPlugin: false });
    const r = runUninstall(s.home);
    expect(r.status).toBe(0);
    expect(existsSync(s.marketplaceCacheRoot)).toBe(false);
  });

  it('leaves the sibling plugin registered', () => {
    const s = sandboxHome({ siblingPlugin: true });
    runUninstall(s.home);
    const installed = JSON.parse(readFileSync(s.installedPath, 'utf8'));
    expect(installed['other-plugin@sdsrss']).toBeTruthy();
    expect(installed['claude-mem-lite@sdsrss']).toBeUndefined();
  });
});
