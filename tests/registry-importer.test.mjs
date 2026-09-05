import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  discoverFromTree,
  parseFrontmatter,
  extractKeywords,
  importFromGitHub,
  formatImportSkips,
  IMPORT_DEFAULT_LIMITS,
} from '../registry-importer.mjs';
import { createRegistryTestDb } from './test-helpers.mjs';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// dirname(fileURLToPath(...)) + join, never new URL(): the URL form drops the named module
// out of knip's report entirely (CLAUDE.md invariant, guarded by no-url-module-paths.test.mjs).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

  // ── audit 2026-09-05 R6 P3-2: `.` and `..` are not usable directory names ──────────
  // Both survive the `[^a-zA-Z0-9._-] → _` filter (dot is in the allowed set) and then PASS
  // isPathConfined, because join() resolves them away before the check: `<managed>/skills/..`
  // resolves to `<managed>` itself, which the guard admits on its `resolved === base` arm.
  // Not a traversal — the write stays inside managedDir — but it lands outside the
  // one-directory-per-resource layout, and two repos declaring the same one clobber.
  // FAILS IF: the importer only checks confinement. `name: .` then writes
  // `<managed>/skills/SKILL.md` and `name: ..` writes `<managed>/SKILL.md`.
  const mockRepoWithName = (frontmatterName) =>
    vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ stargazers_count: 1, forks_count: 0, updated_at: '2026-01-01' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tree: [{ path: 'skills/legit/SKILL.md', type: 'blob' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(`---\nname: ${frontmatterName}\ndescription: d\n---\n# T\nbody`),
      });

  it.each([['.'], ['..']])(
    'rejects a frontmatter name of %j instead of writing outside the resource dir',
    async (bad) => {
      const results = await importFromGitHub(db, 'https://github.com/user/repo', {
        fetchFn: mockRepoWithName(bad),
        managedDir: TMP,
      });
      expect(results).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) c FROM resources').get().c).toBe(0);
      // The two files the un-guarded code would have produced.
      expect(existsSync(join(TMP, 'SKILL.md')), 'wrote <managed>/SKILL.md').toBe(false);
      expect(existsSync(join(TMP, 'skills', 'SKILL.md')), 'wrote <managed>/skills/SKILL.md').toBe(false);
    },
  );

  // The counter-case: the guard must reject ONLY `.`/`..`/empty, not every name containing a
  // dot. A real traversal attempt is already neutered by the charset filter (`/` → `_`) and
  // must still import under its sanitized name.
  // FAILS IF: the new check is widened to anything dot-shaped (e.g. a bare `startsWith('.')`).
  it('still imports a traversal-shaped name under its sanitized form', async () => {
    const results = await importFromGitHub(db, 'https://github.com/user/repo', {
      fetchFn: mockRepoWithName('../../etc'),
      managedDir: TMP,
    });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('.._.._etc');
    expect(existsSync(join(TMP, 'skills', '.._.._etc', 'SKILL.md'))).toBe(true);
  });

  // ── audit 2026-09-05 R6 Q1: import bounds ─────────────────────────────────────────
  // Measured BEFORE the cap, with the same fetchFn injection at production scale: a tree
  // offering 500 `skills/*/SKILL.md` entries of 2 MB each imported all 500, issued 502
  // fetches and wrote 1000.0 MB in 20.1 s — from one `registry import-url`. No bound of any
  // kind existed on count, per-file size, or total. These cases use tiny limits so they run
  // in milliseconds; the shipped defaults live in IMPORT_DEFAULT_LIMITS.
  const mockRepo = (files) =>
    vi.fn(async (u) => {
      if (u.includes('/git/trees/'))
        return {
          ok: true,
          json: async () => ({
            tree: files.map((f) => ({ path: `skills/${f.name}/SKILL.md`, type: 'blob' })),
          }),
        };
      if (u.includes('raw.githubusercontent.com')) {
        const f = files.find((x) => u.includes(`/skills/${x.name}/`));
        return { ok: true, text: async () => `---\nname: ${f.name}\ndescription: d\n---\n${f.body}` };
      }
      return {
        ok: true,
        json: async () => ({ stargazers_count: 1, forks_count: 0, default_branch: 'main' }),
      };
    });

  const files = (n, size = 10) =>
    Array.from({ length: n }, (_, i) => ({ name: `s${i}`, body: 'x'.repeat(size) }));

  // FAILS IF: the item count is unbounded — all 10 import instead of 3.
  it('caps the number of imported items and reports the refusal', async () => {
    const skipped = [];
    const results = await importFromGitHub(db, 'https://github.com/user/repo', {
      fetchFn: mockRepo(files(10)),
      managedDir: TMP,
      limits: { items: 3 },
      skipped,
    });
    expect(results.length).toBe(3);
    expect(skipped.filter((s) => s.reason === 'item-cap').length).toBe(7);
    expect(formatImportSkips(skipped)).toMatch(/7 .*item-cap|item-cap.*7/);
  });

  // FAILS IF: per-file size is unbounded — the oversized entry imports too.
  it('refuses a single file over the per-file byte cap, and keeps the rest', async () => {
    const skipped = [];
    const results = await importFromGitHub(db, 'https://github.com/user/repo', {
      fetchFn: mockRepo([
        { name: 'small', body: 'x'.repeat(10) },
        { name: 'huge', body: 'x'.repeat(5000) },
      ]),
      managedDir: TMP,
      limits: { fileBytes: 1000 },
      skipped,
    });
    expect(results.map((r) => r.name)).toEqual(['small']);
    expect(skipped).toEqual([expect.objectContaining({ name: 'huge', reason: 'file-too-large' })]);
    expect(existsSync(join(TMP, 'skills', 'huge'))).toBe(false);
  });

  // FAILS IF: the run has no total-byte budget — 10 × 500 B all land despite a 1200 B budget.
  it('stops at the total byte budget and reports what it did not import', async () => {
    const skipped = [];
    const results = await importFromGitHub(db, 'https://github.com/user/repo', {
      fetchFn: mockRepo(files(10, 500)),
      managedDir: TMP,
      limits: { totalBytes: 1200 },
      skipped,
    });
    expect(results.length).toBeLessThan(10);
    expect(results.length).toBeGreaterThan(0);
    expect(skipped.some((s) => s.reason === 'total-budget')).toBe(true);
    expect(results.length + skipped.length).toBe(10);
  });

  // The documented opt-out (§2-EXT released-artifact checklist): 0 means unlimited.
  // FAILS IF: 0 is treated as "cap of zero" and refuses everything, or is ignored.
  it('an env override of 0 restores the pre-cap unlimited behavior', async () => {
    const results = await importFromGitHub(db, 'https://github.com/user/repo', {
      fetchFn: mockRepo(files(10)),
      managedDir: TMP,
      env: { CLAUDE_MEM_IMPORT_MAX_ITEMS: '0' },
      limits: { items: 3 },
    });
    expect(results.length).toBe(10);
  });

  // FAILS IF: a typo in the override silently disables the cap. The failure mode of a bad
  // value must be "the cap still applies", never "no cap" (mirrors registryConfineEnabled).
  it('a non-numeric or negative override keeps the cap', async () => {
    for (const bad of ['abc', '-5']) {
      const fresh = createRegistryTestDb();
      const results = await importFromGitHub(fresh, 'https://github.com/user/repo', {
        fetchFn: mockRepo(files(10)),
        managedDir: TMP,
        env: { CLAUDE_MEM_IMPORT_MAX_ITEMS: bad },
        limits: { items: 3 },
      });
      expect(results.length, `override ${bad} disabled the cap`).toBe(3);
      fresh.close();
    }
  });

  // The shipped defaults are the contract the CHANGELOG note tells users about, so pin the
  // numbers rather than only the mechanism.
  it('ships the documented default bounds', () => {
    expect(IMPORT_DEFAULT_LIMITS).toEqual({
      items: 200,
      fileBytes: 2 * 1024 * 1024,
      totalBytes: 50 * 1024 * 1024,
    });
  });

  // Counter-case: an ordinary import must be untouched by the bounds, and report no refusal.
  // FAILS IF: the caps are applied off-by-one or the skip sink is written unconditionally.
  it('an ordinary small import is unaffected and reports nothing skipped', async () => {
    const skipped = [];
    const results = await importFromGitHub(db, 'https://github.com/user/repo', {
      fetchFn: mockRepo(files(3)),
      managedDir: TMP,
      skipped,
    });
    expect(results.length).toBe(3);
    expect(skipped).toEqual([]);
    expect(formatImportSkips(skipped)).toBe('');
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

// ─── Both faces wire the import bounds (audit 2026-09-05 R6 Q1) ─────────────────────
// The bounds live in importFromGitHub, so they are enforced no matter who calls — but a
// refusal the user never sees is not "explicit refusal". Both faces must pass the `skipped`
// sink AND render it through the SHARED formatImportSkips, or the same import prints two
// different stories (or one silent one). Static sweep rather than an e2e call: the faces
// invoke importFromGitHub with no fetchFn, so exercising them would hit the network.
describe('import bounds are surfaced on both faces', () => {
  const FACES = [
    ['MCP', join(REPO_ROOT, 'server.mjs')],
    ['CLI', join(REPO_ROOT, 'mem-cli.mjs')],
  ];

  it.each(FACES)('%s passes a skipped sink to every importFromGitHub call site', (face, file) => {
    const src = readFileSync(file, 'utf8');
    // Call sites only — the import statement names the symbol too.
    const sites = [...src.matchAll(/importFromGitHub\(([^;]*?)\)\s*;/gs)].map((m) => m[1]);
    expect(sites.length, `${face}: no importFromGitHub call site found`).toBeGreaterThan(0);
    for (const args of sites) {
      expect(args, `${face}: call site does not pass the skipped sink: importFromGitHub(${args})`).toMatch(
        /\bskipped\b/,
      );
    }
  });

  it.each(FACES)('%s renders the shared formatImportSkips helper', (face, file) => {
    const src = readFileSync(file, 'utf8');
    expect(src, `${face}: does not call formatImportSkips`).toMatch(/formatImportSkips\s*\(/);
    // And imports it from the one module that owns the wording.
    expect(src).toMatch(/formatImportSkips[^;]*from '\.\/registry-importer\.mjs'|registry-importer\.mjs'\)/);
  });
});
