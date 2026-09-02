// mkplugin.mjs — build a plugin-ONLY sandbox HOME fast (no npm install).
// Exports makePluginHome() so repro scripts can iterate in seconds.
import { REPO, snapshotRepo, makeFakeClaudeBin, sandboxEnv, join } from './lib.mjs';
import { sandboxBase } from './sbx-base.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export function makePluginHome(label = 'P') {
  const SBX = mkdtempSync(join(sandboxBase(), `memsbx-${label}-`));
  const HOME = join(SBX, 'home');
  const PROJECT = join(SBX, 'work', 'my-app');
  const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
  const CACHE = join(HOME, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', VERSION);
  const DATA = join(HOME, '.claude-mem-lite');

  mkdirSync(join(HOME, '.claude'), { recursive: true });
  mkdirSync(join(HOME, 'tmp'), { recursive: true });
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(DATA, { recursive: true });
  makeFakeClaudeBin(HOME);
  execFileSync('git', ['init', '-q'], { cwd: PROJECT });
  writeFileSync(join(PROJECT, 'app.js'), 'export const answer = 42;\n');

  snapshotRepo(CACHE);
  // Deps: reuse the repo's compiled tree via the same symlink shape setup.sh
  // takes on its fast path (data-dir node_modules → plugin cache).
  if (!existsSync(join(DATA, 'node_modules'))) symlinkSync(join(REPO, 'node_modules'), join(DATA, 'node_modules'));
  if (!existsSync(join(CACHE, 'node_modules'))) symlinkSync(join(DATA, 'node_modules'), join(CACHE, 'node_modules'));

  writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { 'claude-mem-lite@sdsrss': true },
  }, null, 2));
  mkdirSync(join(HOME, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(HOME, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    'claude-mem-lite@sdsrss': { version: VERSION, marketplace: 'sdsrss' },
  }, null, 2));

  return { SBX, HOME, PROJECT, CACHE, DATA, VERSION, ENV: sandboxEnv(HOME, { CLAUDE_PLUGIN_ROOT: CACHE }) };
}
