// CLAUDE_CONFIG_DIR moves Claude Code's whole config home — `projects/<dir>/memory`, and the
// `.claude.json` state file with it (verified 2026-09-29 on Claude Code 2.1.284: a session
// run with CLAUDE_CONFIG_DIR=<d> wrote <d>/.claude.json and <d>/projects/). The plugin hard-coded
// ~/.claude in four read paths, so for such a user `adopt --disable` wrote its sentinel where
// the host never looks, and `adopt --status` / `unadopt --all` / `memdir-audit --all` scanned
// the wrong projects. lib/bash-file-targets.mjs already followed the variable.

import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { claudeConfigDir, claudeStatePath } from '../lib/data-paths.mjs';
import { memdirPath } from '../memdir.mjs';
import { readProjectTasks } from '../lib/task-reader.mjs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { spawnSync } from 'child_process';
import { recentPlans } from '../lib/plan-reader.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
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
