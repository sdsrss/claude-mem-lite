// tests/registry-retriever.test.mjs
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRegistryTestDb } from './test-helpers.mjs';
import {
  buildEnhancedQuery,
  buildQueryFromText,
  filterByProjectDomain,
  retrieveResources,
  searchResources,
  cjkIntentTokens,
} from '../registry-retriever.mjs';
import { upsertResource } from '../registry.mjs';

describe('cjkIntentTokens', () => {
  it('returns English intent equivalents for CJK phrases present (substring map)', () => {
    const out = cjkIntentTokens('帮我写测试然后部署');
    expect(out).toContain('test');
    expect(out).toContain('deploy');
  });
  it('dedupes when multiple CJK keys map to the same English intent', () => {
    const out = cjkIntentTokens('写测试和单元测试'); // 测试→test, 单元测试→test
    expect(out.filter((x) => x === 'test').length).toBe(1);
  });
  it('returns [] for a pure-English prompt (no CJK keys can match)', () => {
    expect(cjkIntentTokens('just refactor and deploy this')).toEqual([]);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function insertResource(
  db,
  {
    name,
    type = 'skill',
    source = 'preinstalled',
    domainTags = '',
    techStack = '',
    stars = 0,
    intentTags = '',
    keywords = '',
  },
) {
  db.prepare(
    `
    INSERT INTO resources (name, type, source, file_hash, status, local_path, domain_tags, tech_stack, repo_stars, capability_summary, trigger_patterns, keywords, intent_tags, use_cases)
    VALUES (?, ?, ?, 'hash', 'active', '/tmp/test', ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    name,
    type,
    source,
    domainTags,
    techStack,
    stars,
    name,
    name,
    keywords || name,
    intentTags || name,
    name,
  );
}

// ─── buildEnhancedQuery ───────────────────────────────────────────────────────

describe('buildEnhancedQuery', () => {
  it('returns null for empty signals', () => {
    expect(buildEnhancedQuery({})).toBeNull();
    expect(buildEnhancedQuery({ primaryIntent: '' })).toBeNull();
  });

  it('builds query from primary intent', () => {
    const query = buildEnhancedQuery({ primaryIntent: 'test' });
    expect(query).toBeTruthy();
    expect(typeof query).toBe('string');
    expect(query.length).toBeGreaterThan(0);
    // Should contain intent_tags prefix
    expect(query).toContain('intent_tags:');
  });

  it('includes secondary intents', () => {
    const query = buildEnhancedQuery({ primaryIntent: 'debug', intent: 'debug fix performance' });
    expect(query).toBeTruthy();
    expect(query).toContain('intent_tags:');
  });

  it('includes tech stack in query', () => {
    const query = buildEnhancedQuery({
      primaryIntent: 'build',
      techStack: 'react typescript',
    });
    expect(query).toBeTruthy();
    expect(query).toContain('domain_tags:');
  });

  it('includes raw keywords', () => {
    const query = buildEnhancedQuery({ rawKeywords: ['prisma', 'seo'] });
    expect(query).toBeTruthy();
    expect(query.toLowerCase()).toContain('prisma');
    expect(query.toLowerCase()).toContain('seo');
  });
});

// ─── buildQueryFromText ──────────────────────────────────────────────────────

describe('buildQueryFromText', () => {
  it('returns null for empty/null input', () => {
    expect(buildQueryFromText('')).toBeNull();
    expect(buildQueryFromText(null)).toBeNull();
    expect(buildQueryFromText(undefined)).toBeNull();
  });

  it('builds query from English text', () => {
    const query = buildQueryFromText('fix database performance issue');
    expect(query).toBeTruthy();
    expect(query.includes('OR')).toBe(true);
  });

  it('handles CJK text', () => {
    const query = buildQueryFromText('修复数据库性能问题');
    expect(query).toBeTruthy();
  });

  it('handles mixed CJK+English', () => {
    const query = buildQueryFromText('用playwright测试前端页面');
    expect(query).toBeTruthy();
    expect(query.toLowerCase()).toContain('playwright');
  });

  it('filters stop words', () => {
    const query = buildQueryFromText('the is a an');
    expect(query).toBeNull();
  });

  it('limits tokens to 8', () => {
    const query = buildQueryFromText('one two three four five six seven eight nine ten eleven');
    expect(query).toBeTruthy();
    // Should not have all 11 tokens
    const orCount = (query.match(/ OR /g) || []).length;
    expect(orCount).toBeLessThanOrEqual(7); // at most 8 tokens = 7 ORs
  });
});

// ─── filterByProjectDomain ──────────────────────────────────────────────────

describe('filterByProjectDomain', () => {
  it('passes all resources when no domains specified', () => {
    const results = [{ domain_tags: 'react javascript' }, { domain_tags: 'python django' }];
    expect(filterByProjectDomain(results, null)).toEqual(results);
    expect(filterByProjectDomain(results, [])).toEqual(results);
  });

  it('passes universal resources (empty domain_tags)', () => {
    const results = [{ domain_tags: '' }, { domain_tags: null }, { domain_tags: 'testing quality' }];
    const filtered = filterByProjectDomain(results, ['python']);
    expect(filtered.length).toBe(3); // all pass
  });

  it('filters technology-specific resources not matching project', () => {
    const results = [
      { name: 'react-tool', domain_tags: 'react javascript' },
      { name: 'python-tool', domain_tags: 'python django' },
      { name: 'testing-tool', domain_tags: 'testing quality' },
    ];
    const filtered = filterByProjectDomain(results, ['python', 'django']);
    expect(filtered.map((r) => r.name)).toContain('python-tool');
    expect(filtered.map((r) => r.name)).toContain('testing-tool');
    expect(filtered.map((r) => r.name)).not.toContain('react-tool');
  });

  it('checks tech_stack column for overlap', () => {
    const results = [{ name: 'prisma-tool', domain_tags: 'prisma', tech_stack: 'typescript node' }];
    const filtered = filterByProjectDomain(results, ['typescript']);
    expect(filtered.length).toBe(1);
  });

  it('passes resources with only functional tags', () => {
    const results = [{ name: 'review-tool', domain_tags: 'review quality code-review' }];
    const filtered = filterByProjectDomain(results, ['python']);
    expect(filtered.length).toBe(1);
  });
});

// ─── retrieveResources ──────────────────────────────────────────────────────

describe('retrieveResources', () => {
  let db;
  beforeEach(() => {
    db = createRegistryTestDb();
    insertResource(db, { name: 'superpowers-tdd', domainTags: 'testing quality' });
    insertResource(db, { name: 'react-design', domainTags: 'react javascript frontend' });
    insertResource(db, { name: 'python-debugger', type: 'agent', domainTags: 'python debugging' });
  });
  afterEach(() => {
    db.close();
  });

  it('returns empty array for null query', () => {
    expect(retrieveResources(db, null)).toEqual([]);
    expect(retrieveResources(db, '')).toEqual([]);
  });

  it('finds resources by FTS5 query', () => {
    const results = retrieveResources(db, 'testing OR tdd OR quality');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('superpowers-tdd');
  });

  it('respects type filter', () => {
    const skills = retrieveResources(db, 'superpowers OR react OR python', { type: 'agent' });
    expect(skills.every((r) => r.type === 'agent')).toBe(true);
  });

  it('respects limit', () => {
    const results = retrieveResources(db, 'superpowers OR react OR python', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('applies domain filtering when projectDomains provided', () => {
    const results = retrieveResources(db, 'superpowers OR react OR python', {
      projectDomains: ['python'],
    });
    // react-design should be filtered out
    expect(results.map((r) => r.name)).not.toContain('react-design');
  });

  it('handles FTS5 syntax errors gracefully', () => {
    // Malformed query should not throw
    const results = retrieveResources(db, 'AND OR ())(');
    expect(Array.isArray(results)).toBe(true);
  });

  it('quality_tier is a bounded bonus, not a multiplier — a weak installed match does not outrank a strong community match', () => {
    // Regression: tier was a MULTIPLIER on the (negative, unbounded) BM25 term, so an
    // installed resource (×3) could outrank a far stronger community match. Build a corpus
    // where the query term is DENSE in a community resource and SPARSE in an installed one,
    // with filler docs lacking the term so BM25 discriminates by frequency.
    const insert = (name, qtier, keywords) => {
      insertResource(db, { name, keywords });
      db.prepare('UPDATE resources SET quality_tier = ? WHERE name = ?').run(qtier, name);
    };
    // Filler docs (no "widgetscan" term) → raise the term's IDF so BM25 separates the two.
    for (let i = 0; i < 6; i++) insert(`filler-${i}`, 'community', `alpha beta gamma delta topic${i}`);
    insert(
      'weak-installed',
      'installed',
      'general helper that can also widgetscan among many other unrelated capabilities here',
    );
    insert('strong-community', 'community', 'widgetscan widgetscan widgetscan widgetscan dedicated tool');

    const results = retrieveResources(db, 'widgetscan', { limit: 5 }).map((r) => r.name);
    const iStrong = results.indexOf('strong-community');
    const iWeak = results.indexOf('weak-installed');
    expect(iStrong).toBeGreaterThanOrEqual(0);
    expect(iStrong).toBeLessThan(iWeak === -1 ? Infinity : iWeak); // strong community ranks above weak installed
  });
});

// ─── searchResources ────────────────────────────────────────────────────────

describe('searchResources', () => {
  let db;
  beforeEach(() => {
    db = createRegistryTestDb();
    insertResource(db, { name: 'superpowers-debugging', domainTags: 'debugging quality' });
    insertResource(db, { name: 'frontend-design', domainTags: 'react frontend javascript' });
  });
  afterEach(() => {
    db.close();
  });

  it('returns empty for empty text', () => {
    expect(searchResources(db, '')).toEqual([]);
  });

  it('finds resources from raw text', () => {
    const results = searchResources(db, 'debug this error');
    expect(results.length).toBeGreaterThan(0);
  });

  it('handles CJK search text', () => {
    const results = searchResources(db, '调试错误');
    // Should not throw, may or may not find results depending on FTS5 tokenization
    expect(Array.isArray(results)).toBe(true);
  });

  it('scoring order: more relevant results first', () => {
    insertResource(db, { name: 'test-runner', domainTags: 'testing' });
    const results = searchResources(db, 'debug troubleshoot error', { limit: 5 });
    if (results.length >= 2) {
      // First result should be debugging-related
      expect(results[0].name).toMatch(/debug/i);
    }
  });
});

// Regression: `registry import` is the only registry edit path and mem-cli defaults every
// unspecified flag to '', so a partial re-import (edit ONE field) must not blank the other
// FTS text columns via UPSERT and silently drop the resource out of search.
describe('upsertResource preserve-on-empty (partial re-import keeps search metadata)', () => {
  let db;
  beforeEach(() => {
    db = createRegistryTestDb();
  });
  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  it('a partial re-import keeps prior keywords searchable and preserves untouched columns', () => {
    upsertResource(db, {
      name: 'kube-deploy',
      type: 'skill',
      source: 'user',
      local_path: '',
      capability_summary: 'deploy to kubernetes',
      keywords: 'kubectl helm rollout',
      intent_tags: 'deploy',
      domain_tags: 'devops',
      trigger_patterns: 'ship to k8s',
    });
    expect(searchResources(db, 'kubectl').some((r) => r.name === 'kube-deploy')).toBe(true);

    // Partial re-import: only capability_summary provided; upsertResource defaults the rest to ''
    // (mem-cli's `registry import` does exactly this — every unspecified flag becomes '').
    upsertResource(db, {
      name: 'kube-deploy',
      type: 'skill',
      source: 'user',
      local_path: '',
      capability_summary: 'deploy to kubernetes (v2)',
    });

    // Still findable by the ORIGINAL keyword — not blanked.
    expect(searchResources(db, 'kubectl').some((r) => r.name === 'kube-deploy')).toBe(true);
    const row = db
      .prepare("SELECT capability_summary, keywords, intent_tags FROM resources WHERE name='kube-deploy'")
      .get();
    expect(row.capability_summary).toBe('deploy to kubernetes (v2)'); // the edited field took effect
    expect(row.keywords).toBe('kubectl helm rollout'); // preserved, not blanked
    expect(row.intent_tags).toBe('deploy'); // preserved, not blanked
  });

  // Audit 2026-07-17 L1: file_hash was the last unprotected column in this UPSERT — a
  // metadata-only re-import (no file_hash in fields) nulled the stored content hash,
  // forcing a redundant re-index and false drift reports until the next full scan.
  it('a partial re-import preserves file_hash (change-detection anchor) when not supplied', () => {
    upsertResource(db, {
      name: 'kube-deploy',
      type: 'skill',
      source: 'user',
      local_path: '/x/SKILL.md',
      file_hash: 'abc123',
      capability_summary: 'deploy to kubernetes',
    });
    // Partial re-import: file_hash omitted → upsertResource passes null
    upsertResource(db, {
      name: 'kube-deploy',
      type: 'skill',
      source: 'user',
      local_path: '',
      capability_summary: 'deploy to kubernetes (v2)',
    });
    const row = db
      .prepare("SELECT file_hash, capability_summary FROM resources WHERE name='kube-deploy'")
      .get();
    expect(row.capability_summary).toBe('deploy to kubernetes (v2)');
    expect(row.file_hash).toBe('abc123'); // preserved, not nulled
  });
});
