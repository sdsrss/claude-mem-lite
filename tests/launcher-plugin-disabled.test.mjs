// The plugin switched off in Claude Code: hook.mjs exited, but the recall scripts behind the
// same launcher (user-prompt-search, pre-tool-recall, post-tool-recall, pre-agent-inject) kept
// injecting memory through the direct settings.json hook set (E2E 2026-10-16, hooks F8). The
// launcher now stops every Node hook entry for a disabled plugin, with hook.mjs's fail-open.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';
import { PLUGIN_KEY } from '../lib/plugin-key.mjs';

const REPO = resolve(import.meta.dirname, '..');
const LAUNCHER = join(REPO, 'scripts', 'hook-launcher.mjs');
let root, home, proj, fp, env;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-launcher-off-'));
  home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  proj = join(root, 'parent', 'app');
  mkdirSync(proj, { recursive: true });
  fp = join(proj, 'invoice.js');
  writeFileSync(fp, 'export const x = 1;\n');
  const db = new Database(join(root, 'claude-mem-lite.db'));
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  insertSession(db, { id: 's', project: 'parent--app', memoryId: 'm' });
  insertObs(db, {
    sessionId: 'm',
    project: 'parent--app',
    type: 'bugfix',
    importance: 2,
    title: 'applyDiscount leaked fractional cents',
    lessonLearned: 'Money math in cents must Math.round after percentage ops',
    filesModified: `["${fp}"]`,
  });
  db.close();
  env = {
    ...process.env,
    HOME: home,
    CLAUDE_MEM_DIR: root,
    CLAUDE_PROJECT_DIR: proj,
    CLAUDE_MEM_HOOK_RUNNING: '',
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_PID;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const pretool = () =>
  spawnSync(process.execPath, [LAUNCHER, 'scripts/pre-tool-recall.js'], {
    input: JSON.stringify({
      tool_name: 'Read',
      session_id: `s-${Math.random()}`,
      tool_input: { file_path: fp },
    }),
    env,
    encoding: 'utf8',
  });

const settings = (obj) => writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(obj));

describe('the hook launcher honours a disabled plugin', () => {
  it('premise: with the plugin enabled the recall script injects the lesson', () => {
    settings({ enabledPlugins: { [PLUGIN_KEY]: true } });
    expect(pretool().stdout).toContain('Math.round after percentage ops');
  });

  it('disabled: nothing is injected and nothing is written', () => {
    settings({ enabledPlugins: { [PLUGIN_KEY]: false } });
    const r = pretool();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('follows an absolute CLAUDE_CONFIG_DIR, like lib/data-paths.mjs claudeConfigDir', () => {
    const other = join(root, 'profile');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'settings.json'), JSON.stringify({ enabledPlugins: { [PLUGIN_KEY]: false } }));
    settings({ enabledPlugins: { [PLUGIN_KEY]: true } }); // the default home says enabled
    env.CLAUDE_CONFIG_DIR = other;
    expect(pretool().stdout).toBe('');
    env.CLAUDE_CONFIG_DIR = 'relative/profile'; // ignored, as claudeConfigDir ignores it
    expect(pretool().stdout).toContain('Math.round');
  });

  it('an unparseable settings.json fails open', () => {
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
    expect(pretool().stdout).toContain('Math.round');
  });

  // E2E round 2 (hooks REGRESSION-1): Claude Code merges enabledPlugins user < project <
  // local, so a plugin a project enables runs there even when the user scope says false, and
  // `.claude/settings.local.json` false is the documented way to switch a project-enabled
  // plugin off. The launcher read the user scope only, so the first case went fully dead.
  const projectSettings = (name, obj) => {
    mkdirSync(join(proj, '.claude'), { recursive: true });
    writeFileSync(join(proj, '.claude', name), JSON.stringify(obj));
  };
  it('user false, project true: the plugin runs in that project', () => {
    settings({ enabledPlugins: { [PLUGIN_KEY]: false } });
    projectSettings('settings.json', { enabledPlugins: { [PLUGIN_KEY]: true } });
    expect(pretool().stdout).toContain('Math.round after percentage ops');
  });
  it('user true, local false: the plugin is off in that project', () => {
    settings({ enabledPlugins: { [PLUGIN_KEY]: true } });
    projectSettings('settings.local.json', { enabledPlugins: { [PLUGIN_KEY]: false } });
    expect(pretool().stdout).toBe('');
  });
  it('local beats project', () => {
    settings({ enabledPlugins: { [PLUGIN_KEY]: true } });
    projectSettings('settings.json', { enabledPlugins: { [PLUGIN_KEY]: true } });
    projectSettings('settings.local.json', { enabledPlugins: { [PLUGIN_KEY]: false } });
    expect(pretool().stdout).toBe('');
  });
  // SessionStart spawns detached workers (auto-maintain, normalize, the update check) that write
  // under CLAUDE_MEM_DIR after the hook has exited: 3 of 3 runs, and afterEach's rmSync threw
  // ENOTEMPTY under load (D#654). This test observes none of them, so they are switched off, as
  // in integration-scenarios (D#116): 0 of 3 runs with a writer after exit.
  it('hook.mjs agrees: user false, project true still runs SessionStart', () => {
    settings({ enabledPlugins: { [PLUGIN_KEY]: false } });
    projectSettings('settings.json', { enabledPlugins: { [PLUGIN_KEY]: true } });
    const noWorkers = {
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
      CLAUDE_MEM_SKIP_COMPRESS: '1',
      CLAUDE_MEM_SKIP_OPTIMIZE: '1',
      CLAUDE_MEM_SKIP_UPDATE: '1',
    };
    const ss = () =>
      spawnSync(process.execPath, [LAUNCHER, 'hook.mjs', 'session-start'], {
        input: JSON.stringify({ session_id: 'ss-1', source: 'startup', cwd: proj }),
        env: { ...env, MEM_NO_AUTO_ADOPT: '1', ...noWorkers },
        encoding: 'utf8',
      });
    expect(ss().stdout).toContain('applyDiscount');
    projectSettings('settings.local.json', { enabledPlugins: { [PLUGIN_KEY]: false } });
    expect(ss().stdout).toBe('');
  });

  it('the launcher spells the same key as lib/plugin-key.mjs', () => {
    expect(readFileSync(LAUNCHER, 'utf8')).toContain(`'${PLUGIN_KEY}'`);
  });
});
