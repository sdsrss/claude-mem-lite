// Tests for resource-discovery.mjs — shared discovery module
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  findSkillMd,
  discoverFlat,
  discoverPlugin,
  discoverPlugins,
  discoverAllManaged,
  withRelativePaths,
} from '../resource-discovery.mjs';

const TEST_ROOT = join(tmpdir(), `discovery-test-${process.pid}`);

function mkDir(...segments) {
  const p = join(TEST_ROOT, ...segments);
  mkdirSync(p, { recursive: true });
  return p;
}

beforeEach(() => mkdirSync(TEST_ROOT, { recursive: true }));
afterEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

// ─── findSkillMd ──────────────────────────────────────────────────────────────

describe('findSkillMd', () => {
  it('finds direct SKILL.md', () => {
    const dir = mkDir('skill-a');
    writeFileSync(join(dir, 'SKILL.md'), '# Skill A');
    expect(findSkillMd(dir)).toBe(join(dir, 'SKILL.md'));
  });

  it('finds .claude/skills/*/SKILL.md', () => {
    const dir = mkDir('skill-b');
    mkdirSync(join(dir, '.claude', 'skills', 'inner'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'inner', 'SKILL.md'), '# Inner');
    expect(findSkillMd(dir)).toBe(join(dir, '.claude', 'skills', 'inner', 'SKILL.md'));
  });

  it('finds skills/*/SKILL.md', () => {
    const dir = mkDir('skill-c');
    mkdirSync(join(dir, 'skills', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'sub', 'SKILL.md'), '# Sub');
    expect(findSkillMd(dir)).toBe(join(dir, 'skills', 'sub', 'SKILL.md'));
  });

  it('returns null for empty dir', () => {
    const dir = mkDir('empty');
    expect(findSkillMd(dir)).toBeNull();
  });
});

// ─── discoverFlat ─────────────────────────────────────────────────────────────

describe('discoverFlat', () => {
  it('discovers skills in flat directory', () => {
    const dir = mkDir('flat');
    mkDir('flat', 'my-skill');
    writeFileSync(join(dir, 'my-skill', 'SKILL.md'), '# My Skill');

    const items = discoverFlat(dir, 'skill');
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('my-skill');
    expect(items[0].type).toBe('skill');
    expect(items[0].parentPlugin).toBeNull();
  });

  it('respects skipNames option', () => {
    const dir = mkDir('flat-skip');
    mkDir('flat-skip', 'good');
    writeFileSync(join(dir, 'good', 'SKILL.md'), '# Good');
    mkDir('flat-skip', 'learned');
    writeFileSync(join(dir, 'learned', 'SKILL.md'), '# Learned');

    const items = discoverFlat(dir, 'skill', { skipNames: ['learned'] });
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('good');
  });

  it('returns empty for nonexistent dir', () => {
    expect(discoverFlat(join(TEST_ROOT, 'nope'), 'skill')).toEqual([]);
  });
});

// ─── discoverPlugin ───────────────────────────────────────────────────────────

describe('discoverPlugin', () => {
  it('discovers agents and skills in a plugin', () => {
    const plugin = mkDir('plug');
    mkDir('plug', 'agents');
    writeFileSync(join(plugin, 'agents', 'expert.md'), '# Expert Agent');
    mkDir('plug', 'skills', 'helper');
    writeFileSync(join(plugin, 'skills', 'helper', 'SKILL.md'), '# Helper Skill');

    const items = discoverPlugin(plugin, 'plug');
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.type === 'agent').name).toBe('plug/expert');
    expect(items.find((i) => i.type === 'skill').name).toBe('plug/helper');
    expect(items.every((i) => i.parentPlugin === 'plug')).toBe(true);
  });

  it('skips empty agent files', () => {
    const plugin = mkDir('plug-empty');
    mkDir('plug-empty', 'agents');
    writeFileSync(join(plugin, 'agents', 'empty.md'), '');

    const items = discoverPlugin(plugin, 'plug-empty');
    expect(items).toHaveLength(0);
  });
});

// ─── discoverPlugins ──────────────────────────────────────────────────────────

describe('discoverPlugins', () => {
  it('discovers across multiple plugins', () => {
    const dir = mkDir('agents');
    mkDir('agents', 'a', 'agents');
    writeFileSync(join(dir, 'a', 'agents', 'x.md'), '# Agent X');
    mkDir('agents', 'b', 'skills', 's1');
    writeFileSync(join(dir, 'b', 'skills', 's1', 'SKILL.md'), '# Skill S1');

    const items = discoverPlugins(dir);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.name).sort()).toEqual(['a/x', 'b/s1']);
  });

  it('returns empty for nonexistent dir', () => {
    expect(discoverPlugins(join(TEST_ROOT, 'nope'))).toEqual([]);
  });
});

// ─── discoverAllManaged ───────────────────────────────────────────────────────

describe('discoverAllManaged', () => {
  it('discovers both standalone skills and plugin resources', () => {
    const managed = mkDir('managed');
    mkDir('managed', 'skills', 'standalone');
    writeFileSync(join(managed, 'skills', 'standalone', 'SKILL.md'), '# Standalone');
    mkDir('managed', 'agents', 'plug', 'agents');
    writeFileSync(join(managed, 'agents', 'plug', 'agents', 'bot.md'), '# Bot');

    const items = discoverAllManaged(managed);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.name).sort()).toEqual(['plug/bot', 'standalone']);
  });

  it('skips learned directory', () => {
    const managed = mkDir('managed2');
    mkDir('managed2', 'skills', 'real');
    writeFileSync(join(managed, 'skills', 'real', 'SKILL.md'), '# Real');
    mkDir('managed2', 'skills', 'learned');
    writeFileSync(join(managed, 'skills', 'learned', 'SKILL.md'), '# Learned');

    // discoverAllManaged passes skipNames: ['learned']
    const managed2 = join(TEST_ROOT, 'managed2');
    const items = discoverAllManaged(managed2);
    const names = items.map((i) => i.name);
    expect(names).toContain('real');
    expect(names).not.toContain('learned');
  });
});

// ─── withRelativePaths ────────────────────────────────────────────────────────

describe('withRelativePaths', () => {
  it('adds filePath relative to managedDir', () => {
    const items = [
      { type: 'skill', name: 'x', absPath: '/base/managed/skills/x/SKILL.md', parentPlugin: null },
    ];
    const result = withRelativePaths(items, '/base/managed');
    expect(result[0].filePath).toBe('skills/x/SKILL.md');
    expect(result[0].absPath).toBe('/base/managed/skills/x/SKILL.md');
  });
});
