// claude-mem-lite: Resource retriever — FTS5 search + composite scoring
// Tier 2 of the 3-tier dispatch intelligence architecture

import { debugCatch } from './utils.mjs';

// ─── Domain Synonyms ─────────────────────────────────────────────────────────

export const DISPATCH_SYNONYMS = {
  // English intent synonyms
  'clean':    ['refactor', 'lint', 'format', 'organize', 'tidy', 'simplify', 'restructure', 'rewrite', 'smell', 'debt'],
  'test':     ['testing', 'unittest', 'e2e', 'coverage', 'tdd', 'qa', 'spec', 'jest', 'vitest', 'pytest', 'mocha', 'cypress', 'playwright'],
  'fix':      ['debug', 'bugfix', 'troubleshoot', 'diagnose', 'repair', 'error', 'crash', 'broken', 'issue', 'problem'],
  'debug':    ['debugging', 'fix', 'bugfix', 'troubleshoot', 'diagnose', 'error', 'crash', 'bug', 'breakpoint'],
  'debugging':['debug', 'fix', 'bugfix', 'troubleshoot', 'diagnose', 'error', 'crash', 'bug', 'systematic'],
  'fast':     ['performance', 'optimize', 'profile', 'benchmark', 'speed', 'latency', 'bottleneck', 'slow', 'cache'],
  'deploy':   ['release', 'publish', 'ci', 'cd', 'ship', 'rollout', 'staging', 'production'],
  'commit':   ['git', 'push', 'merge', 'pr', 'branch', 'version', 'rebase', 'stash', 'tag'],
  'secure':   ['security', 'vulnerability', 'audit', 'secrets', 'auth', 'xss', 'csrf', 'injection', 'encrypt', 'ssl', 'tls', 'cors', 'oauth', 'jwt', 'cve'],
  'review':   ['code-review', 'pr-review', 'quality', 'inspect', 'check', 'audit'],
  'doc':      ['documentation', 'readme', 'docs', 'comment', 'jsdoc', 'typedoc', 'changelog', 'wiki', 'guide'],
  'design':   ['ui', 'ux', 'frontend', 'layout', 'css', 'component', 'tailwind', 'responsive', 'theme'],
  'infra':    ['infrastructure', 'devops', 'docker', 'kubernetes', 'terraform', 'ansible', 'helm', 'aws', 'gcp', 'azure', 'nginx', 'pipeline', 'cloud'],
  'db':       ['database', 'sql', 'postgres', 'mysql', 'mongodb', 'schema', 'migration', 'orm', 'prisma', 'redis', 'sqlite', 'drizzle', 'sequelize'],
  'api':      ['endpoint', 'rest', 'graphql', 'route', 'backend', 'grpc', 'websocket', 'middleware', 'swagger', 'openapi'],
  'plan':     ['planning', 'architecture', 'spec', 'blueprint', 'rfc', 'proposal', 'roadmap'],
  'build':    ['compile', 'bundle', 'webpack', 'vite', 'typescript', 'tsc', 'esbuild', 'rollup', 'parcel', 'babel', 'swc', 'transpile'],
  'lint':     ['eslint', 'prettier', 'biome', 'stylelint', 'format', 'style'],
  'search':   ['lookup', 'latest', 'best-practices', 'perplexity'],
  // Chinese intent mappings
  '清理':     ['refactor', 'clean', 'lint', 'format', 'simplify'],
  '测试':     ['test', 'testing', 'tdd', 'qa', 'spec', 'jest', 'vitest', 'pytest'],
  '提交':     ['commit', 'git', 'push', 'pr'],
  '部署':     ['deploy', 'release', 'ci', 'ship'],
  '优化':     ['optimize', 'performance', 'fast', 'speed', 'cache'],
  '安全':     ['security', 'audit', 'vulnerability', 'auth', 'xss', 'csrf'],
  '审查':     ['review', 'code-review', 'pr-review', 'quality'],
  '修复':     ['fix', 'debug', 'bugfix', 'repair', 'error', 'crash'],
  '文档':     ['documentation', 'readme', 'docs'],
  '设计':     ['design', 'ui', 'ux', 'frontend', 'layout', 'component'],
  '构建':     ['build', 'compile', 'bundle', 'webpack', 'vite'],
  '重构':     ['refactor', 'restructure', 'simplify', 'clean'],
  '数据库':   ['database', 'sql', 'schema', 'migration', 'orm'],
  '接口':     ['api', 'endpoint', 'rest', 'route', 'backend'],
  '规划':     ['planning', 'architecture', 'spec', 'blueprint'],
  '格式化':   ['lint', 'format', 'eslint', 'prettier', 'style'],
  '编译':     ['compile', 'build', 'bundle', 'transpile'],
  '打包':     ['bundle', 'build', 'webpack', 'vite'],
  '容器':     ['docker', 'container', 'kubernetes', 'infrastructure'],
  '运维':     ['devops', 'infrastructure', 'deploy', 'docker'],
  '搜索':     ['search', 'lookup', 'latest', 'perplexity'],
};

// ─── CJK Tokenization ───────────────────────────────────────────────────────
// Chinese text has no word boundaries (no spaces between words).
// Two-layer extraction:
//   1. DISPATCH_SYNONYMS CJK keys → synonym-expanded via expandToken()
//   2. CJK_INTENT_MAP → inject English equivalents for FTS5 matching

const CJK_INTENT_MAP = {
  // test
  '测试': 'test', '写测试': 'test', '单测': 'test', '单元测试': 'test',
  '用例': 'test', '覆盖率': 'coverage',
  // fix/debug — synced with extractIntent CJK patterns
  '修复': 'fix', '调试': 'debug', '排错': 'debug', '报错': 'error',
  '出错': 'error', '修bug': 'fix', '改bug': 'fix', '找bug': 'debug',
  '有bug': 'fix', '有问题': 'fix', '不工作': 'fix', '跑不起来': 'fix',
  '不能用': 'fix', '挂了': 'crash', '崩溃': 'crash',
  // commit
  '提交': 'commit', '推送': 'push', '上传': 'push',
  // deploy
  '部署': 'deploy', '上线': 'deploy', '发布': 'release', '回滚': 'rollback',
  // review
  '审查': 'review', '审核': 'review', '评审': 'review', '代码审查': 'review',
  '代码审核': 'review', '看看代码': 'review',
  // clean
  '重构': 'refactor', '清理': 'clean', '整理': 'clean', '简化': 'simplify',
  '太烂': 'refactor', '乱七八糟': 'refactor', '看不懂': 'refactor',
  // performance
  '优化': 'optimize', '性能': 'performance', '卡顿': 'performance', '太慢': 'performance',
  '耗时': 'performance', '慢死了': 'performance', '好慢': 'performance', '缓存': 'cache',
  // security
  '安全': 'security', '漏洞': 'vulnerability', '鉴权': 'auth', '认证': 'auth',
  '授权': 'auth', '权限': 'auth', '泄露': 'security', '暴露': 'security',
  '不安全': 'vulnerability',
  // lint
  '格式化': 'format', '代码风格': 'lint', '代码规范': 'lint', '类型检查': 'typecheck',
  // design
  '设计': 'design', '界面': 'ui', '前端': 'frontend', '样式': 'css',
  '页面': 'frontend', '组件': 'component', '布局': 'layout',
  // build
  '构建': 'build', '编译': 'compile', '打包': 'bundle', '依赖': 'dependency',
  // doc
  '文档': 'documentation', '写文档': 'documentation', '文档化': 'documentation',
  '注释': 'comment',
  // infra
  '容器': 'docker', '服务器': 'server', '运维': 'devops', '集群': 'cluster',
  '监控': 'monitoring', '配置': 'config', '日志': 'logging',
  // db
  '数据库': 'database', '建表': 'database', '索引': 'database', '迁移': 'migration',
  '查询慢': 'performance',
  // api
  '接口': 'api', '路由': 'route',
  // plan
  '规划': 'planning', '架构': 'architecture', '方案': 'plan', '设计方案': 'architecture',
  // search — only web/info search, NOT code search (grep/find)
  '联网搜索': 'search', '网上搜索': 'search', '查资料': 'search', '找资料': 'search',
  '搜索最新': 'search', '搜索资料': 'search', '搜索文档': 'search',
};

// Merge all CJK keys from both maps, longest-first to avoid partial matches
const ALL_CJK_KEYS = [...new Set([
  ...Object.keys(DISPATCH_SYNONYMS).filter(k => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(k)),
  ...Object.keys(CJK_INTENT_MAP),
])].sort((a, b) => b.length - a.length);

function extractCJKTokens(text) {
  const found = [];
  const seen = new Set();
  for (const key of ALL_CJK_KEYS) {
    if (text.includes(key)) {
      if (!seen.has(key)) { seen.add(key); found.push(key); }
      // Also inject English equivalent for direct FTS5 matching
      const en = CJK_INTENT_MAP[key];
      if (en && !seen.has(en)) { seen.add(en); found.push(en); }
    }
  }
  return found;
}

// ─── Query Building ──────────────────────────────────────────────────────────

/**
 * Expand a single token with synonyms for FTS5.
 * @param {string} token Input token
 * @returns {string} FTS5 OR group or bare token
 */
const MAX_SYNONYM_EXPANSION = 8;

function expandToken(token) {
  const lower = token.toLowerCase();
  const synonyms = DISPATCH_SYNONYMS[lower];
  // CJK characters: pass through unquoted — FTS5 unicode61 tokenizer handles them natively.
  // Quoting CJK tokens can interfere with tokenization.
  const isSafe = t => /^[a-zA-Z0-9]+$/.test(t) || /[\u4e00-\u9fff\u3400-\u4dbf]/.test(t);
  if (!synonyms || synonyms.length === 0) {
    return isSafe(token) ? token : `"${token.replace(/"/g, '""')}"`;
  }
  // Cap synonym expansion to prevent BM25 precision dilution from overly broad OR groups
  const capped = synonyms.slice(0, MAX_SYNONYM_EXPANSION);
  const parts = [token, ...capped].map(t =>
    isSafe(t) ? t : `"${t.replace(/"/g, '""')}"`
  );
  return `(${parts.join(' OR ')})`;
}

/**
 * Build enhanced FTS5 query from context signals.
 * Expands synonyms and joins with OR for broad matching.
 * @param {object} signals Context signals from Tier 1
 * @returns {string|null} FTS5 query string or null
 */
export function buildEnhancedQuery(signals) {
  const parts = [];

  // Column-targeted: route primary intent to intent_tags column (highest signal)
  if (signals.primaryIntent) {
    const expanded = expandToken(signals.primaryIntent.toLowerCase());
    parts.push(`intent_tags:${expanded}`);
  }

  // Secondary intents → also column-targeted to intent_tags (not general query).
  // Previously these were general tokens that matched trigger_patterns (BM25 weight 5.0),
  // causing secondary domain words (e.g. "api" in "Write documentation for the API module")
  // to overpower the primary intent. Column-targeting keeps intent signal in the right lane.
  //
  // Note: signals.action (tool type: edit/bash/write) is NOT included — it's metadata
  // about the tool being used, not what the user needs help with.
  const generalTokens = new Set();
  if (signals.intent) {
    const intents = signals.intent.split(/[\s,]+/).filter(Boolean);
    // Secondary intents: column-targeted but WITHOUT synonym expansion.
    // This gives primary intent (expanded) higher BM25 weight than secondary intents (single token).
    for (const t of intents.slice(signals.primaryIntent ? 1 : 0)) {
      parts.push(`intent_tags:${t.toLowerCase()}`);
    }
  }
  if (signals.errorDomain) {
    for (const t of signals.errorDomain.split(/[\s,]+/).filter(Boolean)) {
      generalTokens.add(t.toLowerCase());
    }
  }

  // Column-targeted: route tech stack to domain_tags column
  if (signals.techStack) {
    for (const t of signals.techStack.split(/[\s,]+/).filter(Boolean)) {
      parts.push(`domain_tags:${expandToken(t.toLowerCase())}`);
    }
  }

  // Raw keywords from prompt: domain-specific terms not captured by intent patterns.
  // Added as column-targeted intent_tags + literal general match (no synonym expansion).
  // Synonym expansion is harmful for rawKeywords: "database" expanding to ORM/SQL terms
  // would dilute BM25 precision. Literal matching is sufficient — "seo" matches "seo"
  // directly across name, intent_tags, capability_summary, trigger_patterns.
  if (signals.rawKeywords?.length > 0) {
    const isSafe = t => /^[a-zA-Z0-9]+$/.test(t) || /[\u4e00-\u9fff\u3400-\u4dbf]/.test(t);
    for (const kw of signals.rawKeywords) {
      const safeKw = isSafe(kw) ? kw : `"${kw.replace(/"/g, '""')}"`;
      parts.push(`intent_tags:${safeKw}`);
      parts.push(safeKw);
    }
  }

  // Add general tokens (expanded with synonyms)
  for (const t of generalTokens) {
    parts.push(expandToken(t));
  }

  if (parts.length === 0) return null;
  return parts.join(' OR ');
}

/**
 * Build FTS5 query from raw text (user prompt, tool description).
 * Tokenizes, filters stop words, expands synonyms.
 * @param {string} text Raw text input
 * @returns {string|null} FTS5 query string or null
 */
const TEXT_QUERY_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'after', 'before', 'above', 'below', 'and', 'or', 'but', 'not', 'no',
  'this', 'that', 'these', 'those', 'it', 'its', 'my', 'your', 'his',
  'her', 'our', 'their', 'me', 'him', 'us', 'them', 'i', 'you', 'he',
  'she', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
  'such', 'than', 'too', 'very', 'just', 'also', 'then', 'so', 'if',
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都',
  '一', '一个', '上', '也', '这', '那', '你', '他', '她', '它', '们',
  '把', '让', '给', '用', '来', '去', '做', '说', '要', '会', '能',
  '帮', '帮我', '请', '下', '吧',
]);

export function buildQueryFromText(text) {
  if (!text || typeof text !== 'string') return null;

  const cleaned = text.replace(/[{}()[\]^~*:@#$%&"\\]/g, ' ').trim();

  // Extract CJK compound words before whitespace split (Chinese has no spaces)
  const cjkTokens = extractCJKTokens(cleaned);

  // Extract embedded English words from mixed CJK/Latin text.
  // Handles "用seo技能检查下网站的seo优化问题" → extracts "seo".
  // Whitespace split fails here because CJK text has no spaces.
  const embeddedEnTokens = (cleaned.match(/[a-zA-Z]{2,}/g) || [])
    .map(w => w.toLowerCase());

  const wsTokens = cleaned.split(/\s+/)
    .filter(t => t.length > 1 && !TEXT_QUERY_STOP_WORDS.has(t.toLowerCase()) && !/^\d+$/.test(t));

  // Merge: CJK tokens first (high signal), then embedded English, then whitespace tokens, deduplicated
  const seen = new Set();
  const tokens = [];
  for (const t of [...cjkTokens, ...embeddedEnTokens, ...wsTokens]) {
    const key = t.toLowerCase();
    if (!seen.has(key) && !TEXT_QUERY_STOP_WORDS.has(key)) { seen.add(key); tokens.push(t); }
  }
  tokens.splice(8); // Limit to 8 most relevant tokens

  if (tokens.length === 0) return null;

  const expanded = tokens.map(t => expandToken(t));
  return expanded.join(' OR ');
}

// ─── Project Domain Filtering ─────────────────────────────────────────────────

// Platform/language tags that indicate a resource is technology-specific.
// Only resources with these tags AND no overlap with project domains get filtered out.
// Resources with only functional tags (testing, quality, review) always pass.
const TECHNOLOGY_TAGS = new Set([
  'javascript', 'typescript', 'node', 'react', 'vue', 'svelte', 'angular',
  'python', 'django', 'flask', 'fastapi',
  'rust', 'go', 'java', 'kotlin', 'ruby', 'php', 'swift', 'dart', 'flutter',
  'ios', 'macos', 'android',
  'cpp', 'c', 'csharp', 'dotnet', 'aspnet',
  'elixir', 'erlang', 'lua', 'zig', 'solidity',
  'html', 'css', 'frontend', 'backend',
  'browser', 'web', 'playwright',
]);

/**
 * Post-filter FTS5 results by project domain overlap.
 * - Resources with empty domain_tags (universal) always pass.
 * - Resources with only functional tags (no technology-specific tags) always pass.
 * - Resources with technology tags must overlap with project domains or tech_stack.
 * @param {object[]} results FTS5 results
 * @param {string[]} projectDomains Detected project domains
 * @returns {object[]} Filtered results
 */
export function filterByProjectDomain(results, projectDomains) {
  if (!projectDomains || projectDomains.length === 0) return results;
  const domainSet = new Set(projectDomains.map(d => d.toLowerCase()));
  return results.filter(r => {
    // Universal: no domain_tags
    if (!r.domain_tags || r.domain_tags.trim() === '') return true;

    const tags = r.domain_tags.split(/[\s,]+/).map(t => t.trim().toLowerCase()).filter(Boolean);

    // Check if any tag is a technology tag
    const hasTechTag = tags.some(t => TECHNOLOGY_TAGS.has(t));
    if (!hasTechTag) return true; // Only functional tags — always pass

    // Has tech tags — check overlap with project domains
    if (tags.some(t => domainSet.has(t))) return true;

    // Also check tech_stack column (broader tech info)
    if (r.tech_stack) {
      const techTags = r.tech_stack.split(/[\s,]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
      if (techTags.some(t => domainSet.has(t))) return true;
    }

    return false;
  });
}

// ─── FTS5 Retrieval ──────────────────────────────────────────────────────────

// BM25 weights (8 columns, positional — must match FTS5 column order in registry.mjs):
//   trigger_patterns(3), keywords(3), capability_summary(3),
//   intent_tags(2), use_cases(2), domain_tags(1), tech_stack(1), name(1)
//
// Composite ranking formula:
//   40% BM25 text relevance
//   15% Star popularity (saturation normalization — diminishing returns after ~500 stars)
//   15% Success rate (Laplace smoothing — Beta prior α=1, β=1 for small-sample robustness)
//   10% Adoption rate (Laplace smoothing)
//   10% Cold start exploration bonus (UCB1-inspired — decays as recommend_count grows)
//   -10% Negative feedback penalty (zombie recommendations: high recommend, near-zero adopt)

// Time-windowed behavioral signals: blend all-time rates (stability) with recent 30-day rates (freshness).
// recent_* subqueries return NULL when no recent invocations:
//   COUNT(*)=0 → SUM(...)=NULL → (NULL+1.0)/(0+2.0) = NULL → COALESCE falls back to all-time only.
//
// Sign convention: bm25() returns NEGATIVE (more negative = more relevant).
// We keep the negative direction and SUBTRACT positive behavioral signals to make
// better resources more negative. ORDER BY ... ASC puts most negative (best) first.
// Composite score expression (shared between SELECT and ORDER BY)
// Sign convention: more negative = better. BM25 is negative, behavioral signals are subtracted.
const COMPOSITE_EXPR = `(
    bm25(resources_fts, 3.0, 3.0, 3.0, 2.0, 2.0, 1.0, 1.0, 1.0) * 0.4
    * CASE COALESCE(r.quality_tier, 'community')
        WHEN 'installed' THEN 3.0
        WHEN 'verified' THEN 2.0
        ELSE 1.0
      END
    - COALESCE(r.repo_stars * 1.0 / (r.repo_stars + 100.0), 0) * 0.15
    - (
        (COALESCE(r.success_count, 0) + 1.0) / (COALESCE(r.recommend_count, 0) + 2.0) * 0.5
        + COALESCE(
            (SELECT (SUM(CASE WHEN i.outcome='success' THEN 1 ELSE 0 END) + 1.0)
                  / (COUNT(*) + 2.0)
             FROM invocations i WHERE i.resource_id = r.id
               AND i.created_at > datetime('now', '-30 days')),
            (COALESCE(r.success_count, 0) + 1.0) / (COALESCE(r.recommend_count, 0) + 2.0)
          ) * 0.5
      ) * 0.15
    - (
        (COALESCE(r.weighted_adopt_sum, 0) + 1.0) / (COALESCE(r.recommend_count, 0) + 2.0) * 0.5
        + COALESCE(
            (SELECT (SUM(COALESCE(i.score, 0)) + 1.0)
                  / (COUNT(*) + 2.0)
             FROM invocations i WHERE i.resource_id = r.id
               AND i.created_at > datetime('now', '-30 days')),
            (COALESCE(r.weighted_adopt_sum, 0) + 1.0) / (COALESCE(r.recommend_count, 0) + 2.0)
          ) * 0.5
      ) * 0.10
    - CASE WHEN COALESCE(r.recommend_count, 0) <= 5
        THEN 0.10 * (1.0 - COALESCE(r.recommend_count, 0) * 1.0 / 5.0)
        ELSE 0 END
    + CASE WHEN COALESCE(r.recommend_count, 0) > 5
           AND (COALESCE(r.adopt_count, 0) + 1.0) / (COALESCE(r.recommend_count, 0) + 2.0) < 0.1
        THEN 0.10
        ELSE 0 END
  )`;

const SEARCH_SQL = `
  SELECT *, composite_score FROM (
    SELECT r.*,
      bm25(resources_fts, 3.0, 3.0, 3.0, 2.0, 2.0, 1.0, 1.0, 1.0) AS relevance,
      ${COMPOSITE_EXPR} AS composite_score
    FROM resources_fts
    JOIN resources r ON r.id = resources_fts.rowid
    WHERE resources_fts MATCH ?
      AND r.status = 'active'
  ) sub
  ORDER BY composite_score ASC
  LIMIT ?
`;

const SEARCH_BY_TYPE_SQL = `
  SELECT *, composite_score FROM (
    SELECT r.*,
      bm25(resources_fts, 3.0, 3.0, 3.0, 2.0, 2.0, 1.0, 1.0, 1.0) AS relevance,
      ${COMPOSITE_EXPR} AS composite_score
    FROM resources_fts
    JOIN resources r ON r.id = resources_fts.rowid
    WHERE resources_fts MATCH ?
      AND r.status = 'active'
      AND r.type = ?
  ) sub
  ORDER BY composite_score ASC
  LIMIT ?
`;

/**
 * Search for resources using FTS5 with composite scoring.
 * When projectDomains is provided, fetches extra results internally to allow
 * headroom after domain filtering, then slices to requested limit.
 * @param {Database} db Registry database
 * @param {string} query FTS5 query string (already expanded)
 * @param {object} [opts] Options
 * @param {'skill'|'agent'} [opts.type] Filter by type
 * @param {number} [opts.limit=3] Max results
 * @param {string[]} [opts.projectDomains] Project domains for post-filtering
 * @returns {object[]} Array of matching resources with relevance scores
 */
export function retrieveResources(db, query, { type, limit = 3, projectDomains } = {}) {
  if (!query) return [];

  // Fetch extra when domain filtering is active to ensure enough results after filtering
  const fetchLimit = (projectDomains && projectDomains.length > 0) ? Math.max(limit * 3, 10) : limit;

  try {
    let results;
    if (type) {
      results = db.prepare(SEARCH_BY_TYPE_SQL).all(query, type, fetchLimit);
    } else {
      results = db.prepare(SEARCH_SQL).all(query, fetchLimit);
    }
    if (projectDomains && projectDomains.length > 0) {
      results = filterByProjectDomain(results, projectDomains);
    }
    return results.slice(0, limit);
  } catch (e) {
    // FTS5 query syntax error — try simpler query
    debugCatch(e, 'retrieveResources');
    try {
      const simpleQuery = query.replace(/[()]/g, '').split(/\s+OR\s+/).slice(0, 3).join(' OR ');
      let results;
      if (type) {
        results = db.prepare(SEARCH_BY_TYPE_SQL).all(simpleQuery, type, fetchLimit);
      } else {
        results = db.prepare(SEARCH_SQL).all(simpleQuery, fetchLimit);
      }
      if (projectDomains && projectDomains.length > 0) {
        results = filterByProjectDomain(results, projectDomains);
      }
      return results.slice(0, limit);
    } catch {
      return [];
    }
  }
}

/**
 * Search for resources using raw text (builds query automatically).
 * Convenience wrapper combining buildQueryFromText + retrieveResources.
 * @param {Database} db Registry database
 * @param {string} text Raw search text
 * @param {object} [opts] Options passed to retrieveResources
 * @returns {object[]} Matching resources
 */
export function searchResources(db, text, opts) {
  const query = buildQueryFromText(text);
  if (!query) return [];
  return retrieveResources(db, query, opts);
}
