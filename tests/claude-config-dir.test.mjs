// CLAUDE_CONFIG_DIR moves Claude Code's whole config home — `projects/<dir>/memory`, and the
// `.claude.json` state file with it (verified 2026-09-29 on Claude Code 2.1.284: a session
// run with CLAUDE_CONFIG_DIR=<d> wrote <d>/.claude.json and <d>/projects/). The plugin hard-coded
// ~/.claude in four read paths, so for such a user `adopt --disable` wrote its sentinel where
// the host never looks, and `adopt --status` / `unadopt --all` / `memdir-audit --all` scanned
// the wrong projects. lib/bash-file-targets.mjs already followed the variable.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import {
  claudeConfigDir,
  claudeConfigDirFor,
  claudeStatePath,
  ignoredClaudeConfigDir,
} from '../lib/data-paths.mjs';
import { memdirPath } from '../memdir.mjs';
import { readProjectTasks } from '../lib/task-reader.mjs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { spawnSync } from 'child_process';
import { recentPlans } from '../lib/plan-reader.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const saved = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
});

describe('the host config home follows CLAUDE_CONFIG_DIR', () => {
  it('defaults to ~/.claude and ~/.claude.json', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeConfigDir()).toBe(join(homedir(), '.claude'));
    expect(claudeStatePath()).toBe(join(homedir(), '.claude.json'));
  });

  it('moves both under CLAUDE_CONFIG_DIR, read at call time', () => {
    process.env.CLAUDE_CONFIG_DIR = '/srv/cc';
    expect(claudeConfigDir()).toBe('/srv/cc');
    expect(claudeStatePath()).toBe('/srv/cc/.claude.json');
  });

  it('ignores a relative value rather than resolving it against an arbitrary cwd', () => {
    process.env.CLAUDE_CONFIG_DIR = 'relative/dir';
    expect(claudeConfigDir()).toBe(join(homedir(), '.claude'));
    expect(claudeStatePath()).toBe(join(homedir(), '.claude.json'));
  });

  it('the task reader matches a project through the moved projects dir', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'cml-cfgdir-proj-'));
    try {
      mkdirSync(join(cfg, 'tasks', 'list-9'), { recursive: true });
      writeFileSync(
        join(cfg, 'tasks', 'list-9', '1.json'),
        JSON.stringify({ id: '1', subject: 'mine', status: 'pending' }),
      );
      mkdirSync(join(cfg, 'projects', '-work-app', 'list-9'), { recursive: true });
      process.env.CLAUDE_CONFIG_DIR = cfg;
      expect(readProjectTasks({ projectPath: '/work/app' }).map((t) => t.title)).toEqual(['mine']);
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  it('memdir-audit --all scans the moved projects dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'cml-cfgdir-audit-'));
    try {
      mkdirSync(join(root, 'cfg', 'projects', '-work-app', 'memory'), { recursive: true });
      const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
      const r = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'memdir-audit', '--all'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: join(root, 'home'),
          CLAUDE_CONFIG_DIR: join(root, 'cfg'),
          CLAUDE_MEM_DIR: join(root, 'data'),
        },
      });
      expect(r.stdout).toContain(join(root, 'cfg', 'projects', '-work-app', 'memory'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('memdirPath lands in the moved projects dir', () => {
    process.env.CLAUDE_CONFIG_DIR = '/srv/cc';
    expect(memdirPath('/work/app')).toBe('/srv/cc/projects/-work-app/memory');
  });

  it('the task reader looks under the moved config home', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'cml-cfgdir-'));
    try {
      mkdirSync(join(cfg, 'tasks', 'list-1'), { recursive: true });
      writeFileSync(
        join(cfg, 'tasks', 'list-1', '1.json'),
        JSON.stringify({ id: '1', subject: 'probe task', status: 'pending' }),
      );
      process.env.CLAUDE_CONFIG_DIR = cfg;
      expect(readProjectTasks().map((t) => t.title)).toEqual(['probe task']);
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  it('the plan reader looks under the moved config home', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'cml-cfgdir-plans-'));
    try {
      mkdirSync(join(cfg, 'plans'));
      writeFileSync(join(cfg, 'plans', 'my-plan.md'), '# Probe plan\n');
      process.env.CLAUDE_CONFIG_DIR = cfg;
      expect(
        recentPlans()
          .map((p) => p.name ?? p.file ?? p.path)
          .join(' '),
      ).toMatch(/my-plan/);
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });
});

// D#173 / D#176: the installer and the install-shape probe read settings.json, plugins/ and
// installed_plugins.json from ~/.claude even with CLAUDE_CONFIG_DIR set — where Claude Code
// 2.1.292 reads all three from the variable (`claude plugin list` in a sandbox). Each case puts
// the live file under the config dir and a decoy, or nothing, under ~/.claude.
describe('the installer and its probes use the host config home', () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cml-cfgdir-inst-'));
    mkdirSync(join(root, 'home', '.claude'), { recursive: true });
    mkdirSync(join(root, 'cfg', 'plugins'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const cfg = () => join(root, 'cfg');
  const home = () => join(root, 'home');

  it('claudeConfigDirFor names <home>/.claude when given a home, else the host config home', () => {
    process.env.CLAUDE_CONFIG_DIR = cfg();
    expect(claudeConfigDirFor('/h')).toBe(join('/h', '.claude'));
    expect(claudeConfigDirFor()).toBe(cfg());
  });

  it('detectInstallShape finds the plugin cache and its recorded version under the config dir', async () => {
    const { detectInstallShape } = await import('../lib/install-shape.mjs');
    // Two versions, and Claude Code recorded the OLDER one (a rollback): only a read of the
    // config dir's installed_plugins.json can pick it over newest-wins.
    const verAt = (v) => join(cfg(), 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', v);
    for (const v of ['9.1.0', '9.2.0']) {
      mkdirSync(join(verAt(v), 'scripts'), { recursive: true });
      writeFileSync(join(verAt(v), 'scripts', 'launch.mjs'), '//\n');
      writeFileSync(join(verAt(v), 'cli.mjs'), '//\n');
    }
    const ver = verAt('9.1.0');
    writeFileSync(
      join(cfg(), 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'claude-mem-lite@sdsrss': [{ installPath: ver }] } }),
    );
    process.env.CLAUDE_CONFIG_DIR = cfg();
    const shape = detectInstallShape({ installDir: join(root, 'none'), pluginRoot: '' });
    expect(shape.pluginVersions.map((v) => v.version).sort()).toEqual(['9.1.0', '9.2.0']);
    expect(shape.activePluginVersion?.root).toBe(ver);
  });

  it('the settings.json hook probes read the config dir', async () => {
    const { hasInstallManagedHooks, settingsHookCommands } = await import('../plugin-cache-guard.mjs');
    const cmd = 'node "/x/.claude-mem-lite/scripts/hook-launcher.mjs" hook.mjs stop';
    writeFileSync(
      join(cfg(), 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: cmd }] }] } }),
    );
    process.env.CLAUDE_CONFIG_DIR = cfg();
    expect(hasInstallManagedHooks()).toBe(true);
    expect(settingsHookCommands()).toEqual([cmd]);
    // A caller naming a home still gets that home (the fixtures' seam).
    expect(hasInstallManagedHooks({ home: home() })).toBe(false);
  });

  it('pluginIsRegistered reads installed_plugins.json under the config dir', async () => {
    const { pluginIsRegistered } = await import('../install.mjs');
    writeFileSync(
      join(cfg(), 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'claude-mem-lite@sdsrss': [{ installPath: '/p' }] } }),
    );
    // HOME is the sandbox too: os.homedir() follows it, so code that ignored the variable would
    // read the sandbox home's (empty) registry here, not the developer's real one.
    const realHome = process.env.HOME;
    process.env.HOME = home();
    process.env.CLAUDE_CONFIG_DIR = cfg();
    try {
      expect(pluginIsRegistered({ settings: {} })).toBe(true);
    } finally {
      process.env.HOME = realHome;
    }
    // Premise: the same call naming the sandbox home, which holds no record, says no.
    expect(pluginIsRegistered({ home: home(), settings: {} })).toBe(false);
  });

  // FAILS IF install writes its hooks where the host does not read them: the npm / npx install
  // shape then has no hooks at all for a CLAUDE_CONFIG_DIR user, and with two profiles it wires
  // the OTHER profile.
  it('install writes its hooks into the config dir settings.json and leaves ~/.claude alone', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'install', '--dev'], {
      encoding: 'utf8',
      cwd: root,
      timeout: 120000,
      env: {
        ...process.env,
        HOME: home(),
        CLAUDE_CONFIG_DIR: cfg(),
        CLAUDE_MEM_DIR: join(root, 'data'),
        CLAUDE_MEM_SKIP_REPOS: '1',
        MEM_NO_AUTO_ADOPT: '1',
      },
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const written = JSON.parse(readFileSync(join(cfg(), 'settings.json'), 'utf8'));
    expect(JSON.stringify(written.hooks || {})).toContain('claude-mem-lite');
    expect(existsSync(join(home(), '.claude', 'settings.json'))).toBe(false);
  }, 130000);
});

// D#269: Claude Code resolves a relative CLAUDE_CONFIG_DIR against the directory it starts in
// (2.1.293 in a sandbox: `claude plugin list` wrote <cwd>/<value>/.claude.json and nothing under
// ~/.claude), while this code ignores the value, so the two use different config homes. Following
// it would need every hook, the MCP server and the CLI to share the host's cwd; doctor says so
// instead. An empty value the host reads as unset for its state file (~/.claude.json), as here.
describe('a CLAUDE_CONFIG_DIR this code does not follow (D#269)', () => {
  it('ignoredClaudeConfigDir names a relative value and nothing else', () => {
    const got = [];
    for (const v of ['relcfg', './p', 'C:cfg', '/srv/cc', '', undefined]) {
      if (v === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = v;
      got.push(ignoredClaudeConfigDir());
    }
    expect(got).toEqual(['relcfg', './p', 'C:cfg', null, null, null]);
  });

  function doctorConfigLines(value) {
    const home = mkdtempSync(join(tmpdir(), 'cml-cfgdir-doctor-'));
    try {
      const env = { ...process.env, HOME: home, MEM_NO_AUTO_ADOPT: '1', CLAUDE_MEM_DIR: join(home, 'data') };
      if (value === undefined) delete env.CLAUDE_CONFIG_DIR;
      else env.CLAUDE_CONFIG_DIR = value;
      const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
      const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor'], {
        cwd: home,
        env,
        encoding: 'utf8',
      });
      expect(r.stdout, 'premise: doctor ran').toContain('Node.js:');
      return r.stdout.split('\n').filter((l) => l.includes('CLAUDE_CONFIG_DIR'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('doctor warns about a relative value and says what to set', () => {
    const lines = doctorConfigLines('relcfg');
    expect(lines[0]).toMatch(/⚠.*CLAUDE_CONFIG_DIR="relcfg".*relative/);
    expect(lines.join('\n')).toContain('absolute path');
  });

  it('doctor says nothing about an absolute value, an empty one or none', () => {
    expect([doctorConfigLines('/srv/cc'), doctorConfigLines(''), doctorConfigLines(undefined)]).toEqual([
      [],
      [],
      [],
    ]);
  });
});
