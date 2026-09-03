// claude-mem-lite: Registry importer — tree discovery, frontmatter parsing, keyword extraction, GitHub import pipeline
// GitHub API helpers (parseGitHubUrl, buildTreeUrl, buildContentUrl, buildHeaders)
// are in registry-github.mjs.

import { parseGitHubUrl, buildTreeUrl, buildContentUrl, buildRepoUrl, buildHeaders } from './registry-github.mjs';
import { upsertResource } from './registry.mjs';
import { debugLog, isPathConfined } from './utils.mjs';
import { parseFrontmatter } from './lib/frontmatter.mjs';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DB_DIR } from './schema.mjs';

// DATA artifact — managed resources live under the env-aware data dir (DB_DIR),
// NOT a hardcoded homedir, so GitHub imports land where install.mjs + registry-scanner
// read them under CLAUDE_MEM_DIR relocation (D#29). Equals homedir when the env is unset.
const MANAGED_DIR = join(DB_DIR, 'managed');

// ─── Tree Discovery ─────────────────────────────────────────────────────────

// Patterns: flat (skills/name/SKILL.md), plugin (plugins/x/skills/y/SKILL.md),
// agent (agents/name/AGENT.md), root (./SKILL.md)
const SKILL_RE = /(?:^|\/)(skills\/([^/]+)\/SKILL\.md)$/;
const AGENT_RE = /(?:^|\/)(agents\/([^/]+)\/AGENT\.md)$/;
const PLUGIN_SKILL_RE = /^plugins\/([^/]+)\/skills\/([^/]+)\/SKILL\.md$/;
const ROOT_SKILL_RE = /^SKILL\.md$/;

/**
 * Discover skills/agents from a GitHub tree API response.
 * Supports flat (skills/name/SKILL.md), plugin (plugins/x/skills/y/SKILL.md),
 * and root (./SKILL.md) layouts.
 * @param {object} treeData GitHub API tree response { tree: [{ path, type }] }
 * @param {string} pathFilter Only include paths under this prefix (empty = all)
 * @returns {Array<{ name: string, type: 'skill'|'agent', filePath: string }>}
 */
export function discoverFromTree(treeData, pathFilter) {
  const results = [];
  if (!treeData?.tree) return results;

  for (const item of treeData.tree) {
    if (item.type !== 'blob') continue;
    const p = item.path;

    // Apply path filter
    if (pathFilter && !p.startsWith(pathFilter)) continue;

    // Plugin-nested skill: plugins/x/skills/y/SKILL.md → name = "x/y"
    const pluginMatch = p.match(PLUGIN_SKILL_RE);
    if (pluginMatch) {
      results.push({ name: `${pluginMatch[1]}/${pluginMatch[2]}`, type: 'skill', filePath: p });
      continue;
    }

    // Flat skill: skills/name/SKILL.md → name = "name"
    const skillMatch = p.match(SKILL_RE);
    if (skillMatch) {
      results.push({ name: skillMatch[2], type: 'skill', filePath: p });
      continue;
    }

    // Agent: agents/name/AGENT.md → name = "name"
    const agentMatch = p.match(AGENT_RE);
    if (agentMatch) {
      results.push({ name: agentMatch[2], type: 'agent', filePath: p });
      continue;
    }

    // Root-level SKILL.md
    if (ROOT_SKILL_RE.test(p)) {
      results.push({ name: 'root', type: 'skill', filePath: p });
      continue;
    }

    // Generic: any-dir/SKILL.md or any-dir/AGENT.md (non-standard layouts)
    const genericSkill = p.match(/^([^/]+)\/SKILL\.md$/);
    if (genericSkill) {
      results.push({ name: genericSkill[1], type: 'skill', filePath: p });
      continue;
    }
    const genericAgent = p.match(/^([^/]+)\/AGENT\.md$/);
    if (genericAgent) {
      results.push({ name: genericAgent[1], type: 'agent', filePath: p });
      continue;
    }
  }

  return results;
}

// ─── YAML Frontmatter Parser ────────────────────────────────────────────────
// Lightweight YAML subset parser for skill/agent frontmatter.
// Known limitations: does not handle YAML arrays (- item), nested objects,
// or unquoted values containing colons (e.g. bare URLs). For such fields,
// wrap the value in quotes in the frontmatter: url: "https://..."

/**
 * Parse YAML frontmatter from SKILL.md / AGENT.md content.
 * Handles basic key: value, multiline (|, >), JSON arrays ([...]), quoted strings.
 * @param {string} content Full file content
 * @returns {{ frontmatter: Record<string, any>, body: string }}
 */
// The parser itself is lib/frontmatter.mjs's (audit 2026-09-02 P1-16); re-exported here
// because callers and tests import it from this module.
export { parseFrontmatter };

// ─── Keyword Extraction ─────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'up', 'about', 'into', 'through', 'during', 'before', 'after',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do',
  'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall',
  'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'it', 'its', 'as', 'such', 'which', 'who', 'whom', 'what', 'when', 'where', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'any',
  'can', 'use', 'using', 'used', 'also', 'just', 'very', 'only', 'own', 'same',
  'make', 'like', 'get', 'set', 'new', 'one', 'two', 'see', 'way', 'well',
]);

const INTENT_MAP = {
  test:       [/\btest\b/i, /\btdd\b/i, /\bunit\s*test/i, /\be2e\b/i, /\bspec\b/i, /\bcoverage\b/i],
  debug:      [/\bdebug\b/i, /\btroubleshoot\b/i, /\bdiagnose\b/i, /\berror\b/i, /\bbug\b/i],
  deploy:     [/\bdeploy\b/i, /\bci[\s/]*cd\b/i, /\bpipeline\b/i, /\brelease\b/i, /\bship\b/i, /\bpublish\b/i],
  review:     [/\breview\b/i, /\baudit\b/i, /\blint\b/i, /\binspect\b/i, /code\s*quality/i],
  generate:   [/\bcreate\b/i, /\bscaffold\b/i, /\bgenerate\b/i, /\bboilerplate\b/i],
  refactor:   [/\brefactor\b/i, /\boptimize\b/i, /\bclean\s*up\b/i, /\bsimplify\b/i],
  document:   [/\bdocument\b/i, /\bdocs?\b/i, /\breadme\b/i, /\bjsdoc\b/i],
  plan:       [/\bplan\b/i, /\bdesign\b/i, /\barchitect\b/i, /\bblueprint\b/i],
  security:   [/\bsecurity\b/i, /\bvulnerab/i, /\bauthenticat/i, /\bencrypt/i],
  performance:[/\bperformance\b/i, /\bprofil/i, /\bbenchmark\b/i, /\blatency\b/i],
  migrate:    [/\bmigrat/i, /\bupgrad/i, /\blegacy\b/i],
};

const DOMAIN_PATTERNS = {
  frontend:       [/\breact\b/i, /\bvue\b/i, /\bangular\b/i, /\bsvelte\b/i, /\bnext\.?js\b/i, /\bcss\b/i, /\btailwind\b/i, /\bhtml\b/i],
  backend:        [/\bexpress\b/i, /\bfastapi\b/i, /\bdjango\b/i, /\bflask\b/i, /\brails\b/i, /\bspring\b/i],
  database:       [/\bpostgres/i, /\bmysql\b/i, /\bmongodb\b/i, /\bredis\b/i, /\bsqlite\b/i, /\bsql\b/i],
  infrastructure: [/\bdocker\b/i, /\bkubernetes\b/i, /\bterraform\b/i, /\bansible\b/i, /\bcloud\b/i, /\baws\b/i, /\bgcp\b/i, /\bazure\b/i],
  javascript:     [/\bjavascript\b/i, /\btypescript\b/i, /\bnode\b/i, /\bnpm\b/i, /\besm\b/i],
  python:         [/\bpython\b/i, /\bpip\b/i, /\bpydantic\b/i, /\bpoetry\b/i],
  testing:        [/\bjest\b/i, /\bvitest\b/i, /\bpytest\b/i, /\bcypress\b/i, /\bplaywright\b/i],
  security:       [/\boauth\b/i, /\bjwt\b/i, /\bssl\b/i, /\btls\b/i, /\brbac\b/i],
  ml:             [/\bmachine\s*learning\b/i, /\bneural\b/i, /\btensor/i, /\bpytorch\b/i, /\bllm\b/i],
  mobile:         [/\bios\b/i, /\bandroid\b/i, /react.native/i, /\bflutter\b/i, /\bswift\b/i],
};

/**
 * Extract keywords, intent tags, and domain tags from content.
 * @param {string} content Full text
 * @returns {{ keywords: string, intentTags: string, domainTags: string }}
 */
export function extractKeywords(content) {
  if (!content) return { keywords: '', intentTags: '', domainTags: '' };

  const text = content.toLowerCase();

  // ── Keywords: stop-word filtered frequency counting, top 10 ────────────
  const words = text.match(/\b[a-z][a-z0-9]{2,}\b/g) || [];
  const freq = {};
  for (const w of words) {
    if (!STOP_WORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
  }
  const keywords = Object.entries(freq)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([w]) => w)
    .join(' ');

  // ── Intent tags ───────────────────────────────────────────────────────
  const intents = [];
  for (const [intent, patterns] of Object.entries(INTENT_MAP)) {
    if (patterns.some(re => re.test(text))) intents.push(intent);
  }
  const intentTags = intents.join(' ');

  // ── Domain tags ───────────────────────────────────────────────────────
  const domains = [];
  for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
    if (patterns.some(re => re.test(text))) domains.push(domain);
  }
  const domainTags = domains.join(' ');

  return { keywords, intentTags, domainTags };
}

// ─── GitHub Import Pipeline ─────────────────────────────────────────────────

/**
 * Import skills/agents from a GitHub URL into the registry.
 * Stage 1 only — pure code, no LLM.
 * @param {Database} db Registry database
 * @param {string} url GitHub URL
 * @param {object} opts Options
 * @param {Function} opts.fetchFn Override fetch function (for testing)
 * @param {string} opts.managedDir Override managed directory (for testing)
 * @returns {Promise<Array<{ name: string, type: string, id: number }>>}
 */
export async function importFromGitHub(db, url, opts = {}) {
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const managedDir = opts.managedDir || MANAGED_DIR;
  const headers = buildHeaders();

  // 1. Parse GitHub URL
  const parsed = parseGitHubUrl(url);
  if (!parsed) throw new Error('Invalid GitHub URL');
  const { owner, repo, branch: parsedBranch, path: pathFilter } = parsed;

  // 2. Fetch repo metadata (stars, forks, updated_at)
  const repoResp = await fetchFn(buildRepoUrl(owner, repo), { headers });
  if (!repoResp.ok) {
    if (repoResp.status === 404) throw new Error(`Repository not found: ${owner}/${repo}`);
    if (repoResp.status === 403) throw new Error(`GitHub API rate limit exceeded`);
    throw new Error(`GitHub API error: ${repoResp.status}`);
  }
  const repoMeta = await repoResp.json();
  const repoStars = repoMeta.stargazers_count || 0;
  const repoForks = repoMeta.forks_count || 0;
  const repoUpdatedAt = repoMeta.updated_at || null;

  // parseGitHubUrl defaults branch to 'main' when the URL omits `/tree/<branch>`. Prefer the
  // repo's ACTUAL default branch in that case: a repo defaulting to master/develop/trunk
  // otherwise 404s on a non-existent 'main' (GitHub does not redirect a missing ref), failing
  // a URL that opens fine in the browser. An explicit `/tree/<branch>` in the URL still wins.
  const branchExplicit = /\/tree\//.test(url.split(/[?#]/)[0]);
  const branch = branchExplicit ? parsedBranch : (repoMeta.default_branch || parsedBranch);

  // 3. Fetch file tree via GitHub API (recursive)
  const treeResp = await fetchFn(buildTreeUrl(owner, repo, branch), { headers });
  if (!treeResp.ok) {
    if (treeResp.status === 404) throw new Error(`Branch not found: ${branch}`);
    if (treeResp.status === 403) throw new Error(`GitHub API rate limit exceeded`);
    throw new Error(`GitHub API error: ${treeResp.status}`);
  }
  const treeData = await treeResp.json();

  // 4. Discover skills/agents from tree
  const discovered = discoverFromTree(treeData, pathFilter);
  if (discovered.length === 0) return [];

  const repoUrl = `https://github.com/${owner}/${repo}`;
  const results = [];

  // 5. Process each discovered item
  for (const item of discovered) {
    try {
      // 5a. Fetch content via raw GitHub URL
      const contentUrl = buildContentUrl(owner, repo, branch, item.filePath);
      const contentResp = await fetchFn(contentUrl, { headers });
      if (!contentResp.ok) {
        debugLog('WARN', 'importer', `Failed to fetch ${item.filePath}: ${contentResp.status}`);
        continue;
      }
      const content = await contentResp.text();

      // 5b. Parse frontmatter
      const { frontmatter, body } = parseFrontmatter(content);

      // Root skill naming: use frontmatter name if present, else repo name for root, else discovered name
      const rawName = frontmatter.name || (item.name === 'root' ? repo : item.name);
      const name = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
      // Path traversal guard: reject names that would escape managed directory
      const typeDir = item.type === 'agent' ? 'agents' : 'skills';
      if (!isPathConfined(join(managedDir, typeDir, name), managedDir)) {
        debugLog('WARN', 'importer', `Rejected path-traversal name: ${rawName}`);
        continue;
      }
      const description = frontmatter.description || '';
      const fullText = `${name} ${description} ${body}`;

      // 5c. Extract keywords/intents/domains
      const { keywords, intentTags, domainTags } = extractKeywords(fullText);

      // 5d. SHA-256 hash for dedup
      const fileHash = createHash('sha256').update(content).digest('hex');
      const existing = db.prepare(
        'SELECT file_hash FROM resources WHERE type = ? AND name = ?'
      ).get(item.type, name);
      if (existing && existing.file_hash === fileHash) {
        debugLog('DEBUG', 'importer', `Skipping ${name} — unchanged`);
        continue;
      }

      // 5e. Download to managed directory
      const destDir = join(managedDir, typeDir, name);
      mkdirSync(destDir, { recursive: true });
      const fileName = item.type === 'agent' ? 'AGENT.md' : 'SKILL.md';
      writeFileSync(join(destDir, fileName), content, 'utf8');

      // 5f. Upsert to registry DB
      const resourceId = upsertResource(db, {
        name,
        type: item.type,
        status: 'active',
        source: 'github',
        repo_url: repoUrl,
        repo_stars: repoStars,
        local_path: join(destDir, fileName),
        file_hash: fileHash,
        invocation_name: frontmatter['invocation-name'] || frontmatter.invocation_name || '',
        intent_tags: intentTags,
        domain_tags: domainTags,
        action_type: frontmatter.action_type || frontmatter['action-type'] || '',
        trigger_patterns: frontmatter.trigger_patterns || frontmatter['trigger-patterns'] || '',
        capability_summary: description,
        input_type: frontmatter.input_type || frontmatter['input-type'] || '',
        output_type: frontmatter.output_type || frontmatter['output-type'] || '',
        prerequisites: frontmatter.prerequisites || '{}',
        keywords,
        tech_stack: frontmatter.tech_stack || frontmatter['tech-stack'] || '',
        use_cases: frontmatter.use_cases || frontmatter['use-cases'] || '',
        complexity: frontmatter.complexity || 'intermediate',
        quality_tier: 'community',
        indexed_at: new Date().toISOString(),
      });

      // 5g. Update repo_forks and repo_updated_at (not in upsert SQL).
      // Do NOT touch quality_tier here: UPSERT_SQL never writes it, so a first insert
      // gets the column DEFAULT 'community' and a re-import preserves whatever tier the
      // row reached. Re-stamping 'community' downgraded enrichment-promoted tiers
      // (verified/installed → community) on every content re-import, silently lowering
      // the resource's BM25 composite rank (tier is a 1.0/2.0/3.0 multiplier).
      db.prepare(
        'UPDATE resources SET repo_forks = ?, repo_updated_at = ? WHERE id = ?'
      ).run(repoForks, repoUpdatedAt, resourceId);

      results.push({ name, type: item.type, id: resourceId });
      debugLog('INFO', 'importer', `Imported ${item.type}:${name} (id=${resourceId})`);
    } catch (err) {
      debugLog('ERROR', 'importer', `Failed to import ${item.name}: ${err.message}`);
      // Skip individual failures, continue with next
    }
  }

  // 6. Rebuild FTS5 index
  try {
    db.exec("INSERT INTO resources_fts(resources_fts) VALUES('rebuild')");
  } catch (err) {
    debugLog('WARN', 'importer', `FTS rebuild failed: ${err.message}`);
  }

  // 7. Return imported resources
  return results;
}
