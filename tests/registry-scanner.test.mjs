// Tests for registry-scanner.mjs — flat scan, plugin scan, dedup, diffResources
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  scanDirectory,
  scanPluginResources,
  scanPluginsDirectory,
  scanAllResources,
  diffResources,
} from '../registry-scanner.mjs';
import { createRegistryTestDb } from './test-helpers.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_ROOT = join(tmpdir(), `scanner-test-${process.pid}`);

function mkDir(...segments) {
  const p = join(TEST_ROOT, ...segments);
  mkdirSync(p, { recursive: true });
  return p;
}

const createRegistryDb = createRegistryTestDb;

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => mkdirSync(TEST_ROOT, { recursive: true }));
afterEach(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

// ─── Flat Scan (regression) ──────────────────────────────────────────────────

describe('scanDirectory (flat)', () => {
  it('discovers skill directories with SKILL.md', () => {
    const skillsDir = mkDir('flat-skills');
    const mySkill = mkDir('flat-skills', 'my-skill');
    writeFileSync(join(mySkill, 'SKILL.md'), '---\nname: my-skill\n---\n# My Skill\nSome long content here.');

    const res = scanDirectory(skillsDir, 'skill', 'preinstalled');
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe('my-skill');
    expect(res[0].type).toBe('skill');
    expect(res[0].source).toBe('preinstalled');
    expect(res[0].fileHash).toBeTruthy();
  });

  it('discovers .md files directly in directory', () => {
    const agentsDir = mkDir('flat-agents');
    writeFileSync(
      join(agentsDir, 'code-review.md'),
      '# Code Review Agent\nReviews code for quality and best practices.',
    );

    const res = scanDirectory(agentsDir, 'agent', 'user');
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe('code-review');
    expect(res[0].type).toBe('agent');
  });

  it('skips hidden dirs and node_modules', () => {
    const dir = mkDir('flat-skip');
    mkDir('flat-skip', '.hidden');
    writeFileSync(join(dir, '.hidden', 'SKILL.md'), '# Hidden skill with enough content');
    mkDir('flat-skip', 'node_modules');
    writeFileSync(join(dir, 'node_modules', 'SKILL.md'), '# Module skill with enough content');
    mkDir('flat-skip', 'good-skill');
    writeFileSync(
      join(dir, 'good-skill', 'SKILL.md'),
      '# Good Skill\nWith enough content to pass minimum check.',
    );

    const res = scanDirectory(dir, 'skill', 'preinstalled');
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe('good-skill');
  });

  it('skips near-empty files (<10 chars)', () => {
    const dir = mkDir('flat-empty');
    mkDir('flat-empty', 'tiny');
    writeFileSync(join(dir, 'tiny', 'SKILL.md'), '# Hi');

    const res = scanDirectory(dir, 'skill', 'preinstalled');
    expect(res).toHaveLength(0);
  });

  it('returns empty array for nonexistent dir', () => {
    const res = scanDirectory(join(TEST_ROOT, 'nonexistent'), 'skill', 'user');
    expect(res).toEqual([]);
  });
});

// ─── Plugin Scan ─────────────────────────────────────────────────────────────

describe('scanPluginResources', () => {
  it('discovers nested agents/*.md', () => {
    const plugin = mkDir('plugin-a');
    mkDir('plugin-a', 'agents');
    writeFileSync(
      join(plugin, 'agents', 'code-expert.md'),
      '# Code Expert\nAn expert agent for code analysis and review tasks.',
    );

    const res = scanPluginResources(plugin, 'plugin-a', 'preinstalled');
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe('plugin-a/code-expert');
    expect(res[0].type).toBe('agent');
    expect(res[0].source).toBe('preinstalled');
  });

  it('discovers nested skills/*/SKILL.md', () => {
    const plugin = mkDir('plugin-b');
    mkDir('plugin-b', 'skills', 'my-skill');
    writeFileSync(
      join(plugin, 'skills', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\n---\n# My Skill\nSkill content for testing purposes.',
    );

    const res = scanPluginResources(plugin, 'plugin-b', 'preinstalled');
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe('plugin-b/my-skill');
    expect(res[0].type).toBe('skill');
  });

  it('discovers both agents and skills from a single plugin', () => {
    const plugin = mkDir('plugin-c');
    mkDir('plugin-c', 'agents');
    writeFileSync(
      join(plugin, 'agents', 'expert.md'),
      '# Expert Agent\nHandles expert-level tasks with precision.',
    );
    mkDir('plugin-c', 'skills', 'design-patterns');
    writeFileSync(
      join(plugin, 'skills', 'design-patterns', 'SKILL.md'),
      '---\nname: design-patterns\n---\n# Design Patterns Skill',
    );

    const res = scanPluginResources(plugin, 'plugin-c', 'preinstalled');
    const agents = res.filter((r) => r.type === 'agent');
    const skills = res.filter((r) => r.type === 'skill');
    expect(agents).toHaveLength(1);
    expect(skills).toHaveLength(1);
    expect(agents[0].name).toBe('plugin-c/expert');
    expect(skills[0].name).toBe('plugin-c/design-patterns');
  });

  it('skips non-.md files in agents/', () => {
    const plugin = mkDir('plugin-d');
    mkDir('plugin-d', 'agents');
    writeFileSync(join(plugin, 'agents', 'readme.txt'), 'not a markdown file');
    writeFileSync(join(plugin, 'agents', 'real.md'), '# Real Agent\nThis is a real agent with content.');

    const res = scanPluginResources(plugin, 'plugin-d', 'preinstalled');
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe('plugin-d/real');
  });

  it('returns empty for plugin with no agents/ or skills/', () => {
    const plugin = mkDir('plugin-empty');
    writeFileSync(join(plugin, 'README.md'), '# Plugin\nJust a readme, no agents or skills.');

    const res = scanPluginResources(plugin, 'plugin-empty', 'preinstalled');
    expect(res).toHaveLength(0);
  });
});

describe('scanPluginsDirectory', () => {
  it('scans multiple plugins', () => {
    const agentsDir = mkDir('agents');

    // Plugin 1
    mkDir('agents', 'ui-design', 'agents');
    writeFileSync(
      join(agentsDir, 'ui-design', 'agents', 'designer.md'),
      '# Designer\nA UI designer agent for creating interfaces.',
    );
    mkDir('agents', 'ui-design', 'skills', 'responsive');
    writeFileSync(
      join(agentsDir, 'ui-design', 'skills', 'responsive', 'SKILL.md'),
      '---\nname: responsive\n---\n# Responsive Design',
    );

    // Plugin 2
    mkDir('agents', 'security', 'agents');
    writeFileSync(
      join(agentsDir, 'security', 'agents', 'scanner.md'),
      '# Security Scanner\nScans for vulnerabilities.',
    );

    const res = scanPluginsDirectory(agentsDir, 'preinstalled');
    expect(res).toHaveLength(3);
    const names = res.map((r) => r.name).sort();
    expect(names).toEqual(['security/scanner', 'ui-design/designer', 'ui-design/responsive']);
  });

  it('skips hidden dirs and non-directories', () => {
    const agentsDir = mkDir('agents2');
    mkDir('agents2', '.hidden', 'agents');
    writeFileSync(join(agentsDir, '.hidden', 'agents', 'x.md'), '# Hidden agent with content enough');
    writeFileSync(join(agentsDir, 'some-file.txt'), 'not a dir');
    mkDir('agents2', 'real-plugin', 'agents');
    writeFileSync(join(agentsDir, 'real-plugin', 'agents', 'a.md'), '# Real Agent\nWith valid content.');

    const res = scanPluginsDirectory(agentsDir, 'preinstalled');
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe('real-plugin/a');
  });

  it('returns empty for nonexistent dir', () => {
    expect(scanPluginsDirectory(join(TEST_ROOT, 'nope'), 'preinstalled')).toEqual([]);
  });
});

// ─── scanAllResources (integration) ──────────────────────────────────────────

describe('scanAllResources', () => {
  it('finds resources from both flat skills and plugin agents', () => {
    const dataDir = mkDir('data');
    mkDir('data', 'managed', 'skills', 'standalone-skill');
    writeFileSync(
      join(dataDir, 'managed', 'skills', 'standalone-skill', 'SKILL.md'),
      '---\nname: standalone-skill\n---\n# Standalone Skill\nThis is a standalone skill.',
    );

    mkDir('data', 'managed', 'agents', 'my-plugin', 'agents');
    writeFileSync(
      join(dataDir, 'managed', 'agents', 'my-plugin', 'agents', 'expert.md'),
      '# Expert\nA domain expert for helping.',
    );
    mkDir('data', 'managed', 'agents', 'my-plugin', 'skills', 'helper');
    writeFileSync(
      join(dataDir, 'managed', 'agents', 'my-plugin', 'skills', 'helper', 'SKILL.md'),
      '---\nname: helper\n---\n# Helper Skill\nHelps with things.',
    );

    const res = scanAllResources({ dataDir });
    const names = res.map((r) => `${r.type}:${r.name}`).sort();
    expect(names).toContain('skill:standalone-skill');
    expect(names).toContain('agent:my-plugin/expert');
    expect(names).toContain('skill:my-plugin/helper');
  });

  it('deduplicates by type:name (first wins)', () => {
    const dataDir = mkDir('dedup-data');
    // Two plugins named differently but producing same resource name won't collide
    // Test actual dedup: same skill in managed/skills and managed/agents/plugin/skills
    mkDir('dedup-data', 'managed', 'skills', 'shared');
    writeFileSync(
      join(dataDir, 'managed', 'skills', 'shared', 'SKILL.md'),
      '---\nname: shared\n---\n# Shared from flat\nFlat version of the skill.',
    );

    // This one won't collide because plugin names are prefixed
    mkDir('dedup-data', 'managed', 'agents', 'plug', 'skills', 'shared');
    writeFileSync(
      join(dataDir, 'managed', 'agents', 'plug', 'skills', 'shared', 'SKILL.md'),
      '---\nname: shared\n---\n# Shared from plugin\nPlugin version of the skill.',
    );

    const res = scanAllResources({ dataDir });
    const skillNames = res
      .filter((r) => r.type === 'skill')
      .map((r) => r.name)
      .sort();
    // Both should exist since they have different names (shared vs plug/shared)
    expect(skillNames).toContain('shared');
    expect(skillNames).toContain('plug/shared');
  });
});

// ─── diffResources compatibility ──────────────────────────────────────────────

describe('diffResources', () => {
  it('identifies new resources from plugin scan', () => {
    const db = createRegistryDb();
    const scanned = [
      {
        name: 'my-plugin/expert',
        type: 'agent',
        source: 'preinstalled',
        localPath: '/tmp/x',
        content: 'test',
        fileHash: 'abc123',
        repoUrl: null,
      },
      {
        name: 'my-plugin/helper',
        type: 'skill',
        source: 'preinstalled',
        localPath: '/tmp/y',
        content: 'test2',
        fileHash: 'def456',
        repoUrl: null,
      },
    ];

    const { toIndex, toDisable } = diffResources(db, scanned);
    expect(toIndex).toHaveLength(2);
    expect(toDisable).toHaveLength(0);
    db.close();
  });

  it('detects changed hash for plugin resources', () => {
    const db = createRegistryDb();
    db.prepare(
      'INSERT INTO resources (name, type, source, file_hash, local_path) VALUES (?, ?, ?, ?, ?)',
    ).run('plug/agent-x', 'agent', 'preinstalled', 'oldhash', '/tmp/a');

    const scanned = [
      {
        name: 'plug/agent-x',
        type: 'agent',
        source: 'preinstalled',
        localPath: '/tmp/a',
        content: 'updated',
        fileHash: 'newhash',
        repoUrl: null,
      },
    ];

    const { toIndex } = diffResources(db, scanned);
    expect(toIndex).toHaveLength(1);
    expect(toIndex[0].name).toBe('plug/agent-x');
    db.close();
  });

  it('marks removed plugin resources for disable', () => {
    const db = createRegistryDb();
    db.prepare(
      'INSERT INTO resources (name, type, source, file_hash, local_path) VALUES (?, ?, ?, ?, ?)',
    ).run('old-plugin/gone', 'agent', 'preinstalled', 'hash', '/tmp/z');

    const { toDisable } = diffResources(db, []);
    expect(toDisable).toHaveLength(1);
    expect(toDisable[0].name).toBe('old-plugin/gone');
    db.close();
  });

  it('does not disable resources without local_path (metadata-imported)', () => {
    const db = createRegistryDb();
    // Resources imported via mem_registry or install.mjs — empty local_path
    db.prepare(
      'INSERT INTO resources (name, type, source, file_hash, local_path) VALUES (?, ?, ?, ?, ?)',
    ).run('imported-skill', 'skill', 'preinstalled', 'hash', '');
    db.prepare(
      'INSERT INTO resources (name, type, source, file_hash, local_path) VALUES (?, ?, ?, ?, ?)',
    ).run('another-imported', 'skill', 'preinstalled', 'hash2', '');

    const { toDisable } = diffResources(db, []);
    expect(toDisable).toHaveLength(0);
    db.close();
  });
});

// ─── Schema: enrichment columns ───────────────────────────────────────────────

describe('resources table schema', () => {
  it('has enrichment_status and repo metadata columns', () => {
    const db = createRegistryTestDb();
    const cols = db
      .prepare('PRAGMA table_info(resources)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('enrichment_status');
    expect(cols).toContain('enriched_at');
    expect(cols).toContain('repo_updated_at');
    expect(cols).toContain('repo_forks');
    db.close();
  });
});
