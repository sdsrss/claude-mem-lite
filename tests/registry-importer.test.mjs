import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  discoverFromTree,
  parseFrontmatter,
  extractKeywords,
  importFromGitHub,
} from '../registry-importer.mjs';
import { createRegistryTestDb } from './test-helpers.mjs';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const MOCK_TREE = {
  tree: [
    { path: 'README.md', type: 'blob' },
    { path: 'skills/humanizer/SKILL.md', type: 'blob' },
    { path: 'skills/humanizer/README.md', type: 'blob' },
    { path: 'agents/reviewer/AGENT.md', type: 'blob' },
    { path: '.claude-plugin/plugin.json', type: 'blob' },
    { path: 'plugins/tdd/skills/tdd-workflow/SKILL.md', type: 'blob' },
    { path: 'SKILL.md', type: 'blob' },
  ],
};

describe('discoverFromTree', () => {
  it('discovers skills from flat layout', () => {
    const results = discoverFromTree(MOCK_TREE, '');
    const names = results.map((r) => r.name);
    expect(names).toContain('humanizer');
  });

  it('discovers agents', () => {
    const results = discoverFromTree(MOCK_TREE, '');
    const agents = results.filter((r) => r.type === 'agent');
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.some((a) => a.name === 'reviewer')).toBe(true);
  });

  it('discovers plugin-nested skills', () => {
    const results = discoverFromTree(MOCK_TREE, '');
    const names = results.map((r) => r.name);
    expect(names).toContain('tdd/tdd-workflow');
  });

  it('discovers root-level SKILL.md', () => {
    const results = discoverFromTree({ tree: [{ path: 'SKILL.md', type: 'blob' }] }, '');
    expect(results.length).toBe(1);
    expect(results[0].type).toBe('skill');
  });

  it('filters by path prefix', () => {
    const results = discoverFromTree(MOCK_TREE, 'skills/humanizer');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('humanizer');
  });

  it('returns empty for no skills', () => {
    const results = discoverFromTree({ tree: [{ path: 'src/index.js', type: 'blob' }] }, '');
    expect(results).toEqual([]);
  });
});

describe('parseFrontmatter', () => {
  it('extracts name and description', () => {
    const content =
      '---\nname: humanizer\nversion: 2.3.0\ndescription: |\n  Remove AI writing patterns\n---\n# Body';
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.name).toBe('humanizer');
    expect(frontmatter.version).toBe('2.3.0');
    expect(frontmatter.description).toContain('Remove AI');
    expect(body).toContain('# Body');
  });

  it('returns empty frontmatter when none exists', () => {
    const { frontmatter, body } = parseFrontmatter('# Just a body');
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(body).toBe('# Just a body');
  });

  it('parses allowed-tools JSON array', () => {
    const content = '---\nname: test\nallowed-tools: ["Read", "Write", "Edit"]\n---\nbody';
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter['allowed-tools']).toEqual(['Read', 'Write', 'Edit']);
  });
});

describe('extractKeywords', () => {
  it('extracts keywords from content', () => {
    const kw = extractKeywords('Build React components with TypeScript and Jest testing');
    expect(kw.keywords).toContain('react');
    expect(kw.keywords).toContain('typescript');
    expect(kw.keywords).toContain('jest');
  });

  it('infers domain tags', () => {
    const kw = extractKeywords('Use PostgreSQL with Docker for deployment');
    expect(kw.domainTags).toContain('database');
    expect(kw.domainTags).toContain('infrastructure');
  });

  it('infers intent tags', () => {
    const kw = extractKeywords('Debug and troubleshoot production errors');
    expect(kw.intentTags).toContain('debug');
  });
});

// ─── importFromGitHub ───────────────────────────────────────────────────────

describe('importFromGitHub', () => {
  const TMP = join(tmpdir(), 'importer-test-' + process.pid);
  let db;

  beforeEach(() => {
    db = createRegistryTestDb();
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    db.close();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('imports a single skill from mocked tree and content', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ stargazers_count: 42, forks_count: 5, updated_at: '2026-01-01' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () =>
          Promise.resolve('---\nname: test-skill\ndescription: A test skill\n---\n# Test\nDoes testing.'),
      });

    const results = await importFromGitHub(db, 'https://github.com/user/repo', {
      fetchFn: mockFetch,
      managedDir: TMP,
    });

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('test-skill');
    expect(results[0].type).toBe('skill');

    const row = db.prepare("SELECT * FROM resources WHERE name = 'test-skill'").get();
    expect(row).toBeTruthy();
    expect(row.repo_stars).toBe(42);
    expect(row.source).toBe('github');
    expect(row.status).toBe('active');
  });

  it('uses the repo default_branch when the URL omits /tree/ (master-default repo, no 404)', async () => {
    // Regression: parseGitHubUrl defaults branch→'main'; a repo whose default is 'master'
    // 404'd on the non-existent 'main' ref instead of importing. Fix: fall back to
    // repoMeta.default_branch when the URL didn't specify /tree/<branch>.
    const mockFetch = vi.fn(async (u) => {
      if (u.includes('/git/trees/main')) return { ok: false, status: 404 }; // 'main' does not exist
      if (u.includes('/git/trees/master'))
        return { ok: true, json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }) };
      if (u.includes('raw.githubusercontent.com'))
        return {
          ok: true,
          text: () => Promise.resolve('---\nname: master-skill\ndescription: d\n---\n# T\nbody'),
        };
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            stargazers_count: 3,
            forks_count: 0,
            updated_at: '2026-01-01',
            default_branch: 'master',
          }),
      }; // repo metadata
    });
    const results = await importFromGitHub(db, 'https://github.com/user/repo', {
      fetchFn: mockFetch,
      managedDir: TMP,
    });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('master-skill');
  });

  it('preserves an enrichment-promoted quality_tier across a content re-import', async () => {
    // Regression: the post-upsert UPDATE hardcoded quality_tier='community', so a
    // re-import (changed upstream content → new file_hash) downgraded any tier that
    // enrichment had promoted (verified/installed → community), silently lowering the
    // resource's BM25 composite rank (tier is a 1.0/2.0/3.0 multiplier).
    const importOnce = (content, stars) =>
      importFromGitHub(db, 'https://github.com/user/repo', {
        managedDir: TMP,
        fetchFn: vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            json: () =>
              Promise.resolve({ stargazers_count: stars, forks_count: 1, updated_at: '2026-01-01' }),
          })
          .mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }),
          })
          .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(content) }),
      });

    await importOnce('---\nname: tiered-skill\ndescription: v1\n---\n# v1', 10);
    // Simulate enrichment promoting the tier.
    db.prepare("UPDATE resources SET quality_tier = 'verified' WHERE name = 'tiered-skill'").run();

    // Upstream content changes → re-import (new file_hash, so it does NOT short-circuit).
    await importOnce('---\nname: tiered-skill\ndescription: v2 changed\n---\n# v2 changed body', 11);

    const row = db.prepare("SELECT quality_tier FROM resources WHERE name = 'tiered-skill'").get();
    expect(row.quality_tier).toBe('verified'); // preserved, not reset to 'community'
  });

  it('uses repo name for root SKILL.md', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 0 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('---\ndescription: Root skill\n---\n# Root'),
      });

    const results = await importFromGitHub(db, 'https://github.com/user/my-tool', {
      fetchFn: mockFetch,
      managedDir: TMP,
    });

    expect(results.length).toBe(1);
    // Root skill without explicit name should use repo name
    expect(results[0].name).toBe('my-tool');
  });

  it('returns empty for repo with no skills', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 0 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tree: [{ path: 'src/index.js', type: 'blob' }] }),
      });

    const results = await importFromGitHub(db, 'https://github.com/user/empty', {
      fetchFn: mockFetch,
      managedDir: TMP,
    });
    expect(results).toEqual([]);
  });

  it('rejects invalid GitHub URL', async () => {
    await expect(importFromGitHub(db, 'https://gitlab.com/foo/bar', { managedDir: TMP })).rejects.toThrow(
      'Invalid GitHub URL',
    );
  });

  it('skips unchanged resources (hash dedup)', async () => {
    const content = '---\nname: dup\n---\n# Dup';
    // First import
    const mockFetch1 = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 0 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }),
      })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(content) });
    await importFromGitHub(db, 'https://github.com/user/repo', { fetchFn: mockFetch1, managedDir: TMP });

    // Second import with same content
    const mockFetch2 = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 0 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }),
      })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(content) });
    const results2 = await importFromGitHub(db, 'https://github.com/user/repo', {
      fetchFn: mockFetch2,
      managedDir: TMP,
    });
    expect(results2).toEqual([]); // skipped, same hash
  });

  it('re-imports when content changes', async () => {
    // First import
    const mockFetch1 = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 0 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }),
      })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('---\nname: evolving\n---\n# V1') });
    await importFromGitHub(db, 'https://github.com/user/repo', { fetchFn: mockFetch1, managedDir: TMP });

    // Second import with different content
    const mockFetch2 = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 10 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('---\nname: evolving\n---\n# V2 updated'),
      });
    const results2 = await importFromGitHub(db, 'https://github.com/user/repo', {
      fetchFn: mockFetch2,
      managedDir: TMP,
    });
    expect(results2.length).toBe(1);
    expect(results2[0].name).toBe('evolving');

    const row = db.prepare("SELECT * FROM resources WHERE name = 'evolving'").get();
    expect(row.repo_stars).toBe(10);
  });

  it('throws on 404 repo', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(
      importFromGitHub(db, 'https://github.com/user/missing', { fetchFn: mockFetch, managedDir: TMP }),
    ).rejects.toThrow('Repository not found');
  });

  it('sets repo_forks and repo_updated_at', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ stargazers_count: 10, forks_count: 3, updated_at: '2026-03-01T00:00:00Z' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tree: [{ path: 'skills/myskill/SKILL.md', type: 'blob' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('---\nname: myskill\ndescription: A skill\n---\n# My Skill'),
      });

    const results = await importFromGitHub(db, 'https://github.com/user/repo', {
      fetchFn: mockFetch,
      managedDir: TMP,
    });
    expect(results.length).toBe(1);

    const row = db.prepare("SELECT * FROM resources WHERE name = 'myskill'").get();
    expect(row.repo_forks).toBe(3);
    expect(row.repo_updated_at).toBe('2026-03-01T00:00:00Z');
    expect(row.quality_tier).toBe('community');
  });
});

// D#29: the default managed dir (used by the production callers mem-cli/server, which
// pass NO managedDir override) hardcoded join(homedir(),'.claude-mem-lite','managed'),
// ignoring CLAUDE_MEM_DIR. Under relocation that wrote imported skills to the homedir
// while the registry DB + scanner live in the relocated data dir → imported skills
// silently invisible. The default must follow DB_DIR.
describe('importFromGitHub data-dir relocation (D#29)', () => {
  const origHome = process.env.HOME;
  const origMemDir = process.env.CLAUDE_MEM_DIR;
  const tracked = [];
  afterEach(() => {
    process.env.HOME = origHome;
    if (origMemDir === undefined) delete process.env.CLAUDE_MEM_DIR;
    else process.env.CLAUDE_MEM_DIR = origMemDir;
    for (const d of tracked) rmSync(d, { recursive: true, force: true });
    tracked.length = 0;
    vi.resetModules();
  });

  it('default managed dir honors CLAUDE_MEM_DIR (writes to the relocated data dir, not homedir)', async () => {
    const homeTmp = join(tmpdir(), 'imp-home-' + randomUUID().slice(0, 8));
    const ccDir = join(tmpdir(), 'imp-cc-' + randomUUID().slice(0, 8));
    mkdirSync(homeTmp, { recursive: true });
    mkdirSync(ccDir, { recursive: true });
    tracked.push(homeTmp, ccDir);
    process.env.HOME = homeTmp; // pre-fix would write here; keeps the test off the real FS
    process.env.CLAUDE_MEM_DIR = ccDir; // post-fix the default managed dir follows this
    vi.resetModules();
    const { importFromGitHub: relocatedImport } = await import('../registry-importer.mjs');
    const db = createRegistryTestDb();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ stargazers_count: 1 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tree: [{ path: 'SKILL.md', type: 'blob' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('---\nname: reloc-skill\ndescription: x\n---\n# R'),
      });

    // NO managedDir override → exercises the module default (the production path).
    const results = await relocatedImport(db, 'https://github.com/user/repo', { fetchFn: mockFetch });
    expect(results.length).toBe(1);
    const row = db.prepare("SELECT local_path FROM resources WHERE name = 'reloc-skill'").get();
    expect(row.local_path.startsWith(join(ccDir, 'managed'))).toBe(true); // relocated data dir
    expect(row.local_path.startsWith(homeTmp)).toBe(false); // NOT the homedir
    db.close();
  });
});
