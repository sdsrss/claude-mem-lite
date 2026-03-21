// claude-mem-lite shared utilities
// Used by server.mjs, hook.mjs, and tests

import { basename, dirname } from 'path';

// ─── Sentinel Values ────────────────────────────────────────────────────────

/** compressed_into sentinel: auto-compressed without merge target */
export const COMPRESSED_AUTO = -1;
/** compressed_into sentinel: pending user-confirmed purge (marked by idle cleanup) */
export const COMPRESSED_PENDING_PURGE = -2;

// ─── Type-Differentiated Recency Decay ──────────────────────────────────────

/** Recency half-life per observation type (in milliseconds) */
export const DECAY_HALF_LIFE_BY_TYPE = {
  decision:  90 * 86400000,  // 90 days — architectural decisions persist
  discovery: 60 * 86400000,  // 60 days — learned patterns last
  feature:   30 * 86400000,  // 30 days — feature work is mid-range
  bugfix:    14 * 86400000,  // 14 days — bugs are usually one-off
  refactor:  14 * 86400000,  // 14 days — code cleanup
  change:     7 * 86400000,  //  7 days — routine changes decay fast
};
export const DEFAULT_DECAY_HALF_LIFE_MS = 14 * 86400000;

// ─── BM25 Weight Constants ──────────────────────────────────────────────────
// Single source of truth for FTS5 BM25 weight expressions.
// Column order must match ensureFTS() calls in schema.mjs.

/** observations_fts BM25 weights: title=10, subtitle=5, narrative=5, text=3, facts=3, concepts=2, lesson_learned=8 */
export const OBS_BM25 = 'bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)';

/** session_summaries_fts BM25 weights: request=5, investigated=3, learned=3, completed=3, next_steps=2, notes=1, remaining_items=1 */
export const SESS_BM25 = 'bm25(session_summaries_fts, 5, 3, 3, 3, 2, 1, 1)';

/** FTS5 columns for observations (must match BM25 weight order) */
export const OBS_FTS_COLUMNS = ['title', 'subtitle', 'narrative', 'text', 'facts', 'concepts', 'lesson_learned'];

/** SQL CASE for type-differentiated recency decay half-lives (milliseconds) */
export const TYPE_DECAY_CASE = `(
  CASE o.type
    WHEN 'decision'  THEN 7776000000.0
    WHEN 'discovery' THEN 5184000000.0
    WHEN 'feature'   THEN 2592000000.0
    WHEN 'bugfix'    THEN 1209600000.0
    WHEN 'refactor'  THEN 1209600000.0
    WHEN 'change'    THEN  604800000.0
    ELSE 1209600000.0
  END
)`;

// ─── String Utilities ────────────────────────────────────────────────────────

/**
 * Compute word-level Jaccard similarity between two strings.
 * @param {string} a First string
 * @param {string} b Second string
 * @returns {number} Similarity score between 0 and 1
 */
export function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;
  // Strip trailing punctuation from tokens to match MinHash normalization
  // (prevents "server.rs," ≠ "server.rs" dedup failures)
  const norm = s => s.toLowerCase().split(/\s+/).map(t => t.replace(/[,;:!?]+$/, ''));
  const setA = new Set(norm(a));
  const setB = new Set(norm(b));
  let intersection = 0;
  for (const w of setA) { if (setB.has(w)) intersection++; }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Truncate a string to a maximum length, replacing newlines with spaces.
 * @param {string} str Input string
 * @param {number} [max=80] Maximum character length
 * @returns {string} Truncated string with ellipsis if needed
 */
export function truncate(str, max = 80) {
  if (!str) return '';
  str = str.replace(/\n/g, ' ').trim();
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ─── Secret Scrubbing ──────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  // Key-value assignments: password=xxx, token=xxx, api_key=xxx, secret=xxx, etc.
  // Excludes code-like values: null, undefined, true, false, None, empty, function calls (word()),
  // and short values (<6 chars) that are typically variable names not secrets.
  [/(\b(?:password|passwd|token|api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer)\s*[=:]\s*)(?!(?:null|undefined|true|false|None|nil|empty|""|''|0)\b)(?!\w+\()(?!new\s)(?!process\.env\.)[^\s,;'"}\]]{6,}/gi, '$1***'],
  // AWS access keys (AKIA...)
  [/\bAKIA[A-Z0-9]{16}\b/g, '***'],
  // OpenAI / Anthropic keys (sk-...) — specific prefixes have lower length threshold
  [/\bsk-(?:proj|ant|ant-api\d{2})-[a-zA-Z0-9_-]{8,}\b/g, '***'],
  [/\bsk-[a-zA-Z0-9_-]{20,}\b/g, '***'],
  // GitHub tokens (ghp_, gho_, github_pat_)
  [/\b(?:ghp_|gho_|ghs_|ghr_)[a-zA-Z0-9_]{30,}\b/g, '***'],
  [/\bgithub_pat_[a-zA-Z0-9_]{22,}\b/g, '***'],
  // GitLab tokens (glpat-)
  [/\bglpat-[a-zA-Z0-9_-]{20,}\b/g, '***'],
  // Slack tokens (xox[bpas]-)
  [/\bxox[bpas]-[a-zA-Z0-9-]{10,}\b/g, '***'],
  // JWT tokens (eyJ...eyJ...)
  [/\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\b/g, '***'],
  // PEM private key blocks
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, '***PEM_KEY***'],
  // Long hex strings in assignments (e.g. SECRET_KEY=abc123def456...)
  [/(\b(?:key|secret|token|hash)\s*[=:]\s*)[0-9a-f]{32,}\b/gi, '$1***'],
  // Google Cloud API keys (AIza...)
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, '***'],
  // Generic Bearer tokens in Authorization headers
  [/(Authorization:\s*Bearer\s+)[^\s,;'"}\]]+/gi, '$1***'],
  // Supabase / generic long base64 keys (40+ chars, common in env vars)
  [/(\b(?:SUPABASE_KEY|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|REDIS_URL)\s*[=:]\s*)[^\s,;'"}\]]+/gi, '$1***'],
  // Basic auth in URLs (https://user:password@host)
  [/https?:\/\/[^@/\s]+:[^@/\s]+@/gi, 'https://***:***@'],
  // Database connection strings (postgres, mysql, mongodb, redis, amqp)
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s,;'"}\]]+/gi, '$1://***'],
  // npm tokens (npm_...)
  [/\bnpm_[a-zA-Z0-9]{36,}\b/g, '***'],
  // Stripe keys (sk_live_, rk_live_, pk_live_, sk_test_, pk_test_)
  [/\b[srp]k_(?:live|test)_[a-zA-Z0-9]{20,}\b/g, '***'],
];

/**
 * Scrub known secret patterns (API keys, tokens, credentials) from text.
 * @param {string} text Input text potentially containing secrets
 * @returns {string} Text with secrets replaced by '***'
 */
export function scrubSecrets(text) {
  if (!text || typeof text !== 'string') return text || '';
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ─── Token Estimation ─────────────────────────────────────────────────────

/**
 * Estimate token count for a string.
 * Uses ~4 chars/token for ASCII, ~1.5 chars/token for CJK characters.
 * @param {string} text Input text
 * @returns {number} Estimated token count (minimum 1)
 */
export function estimateTokens(text) {
  const s = text || '';
  if (!s) return 1;
  // Count CJK characters (each ~1 token) vs ASCII (~4 chars/token)
  let cjkCount = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) ||
        (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef) ||
        (c >= 0xac00 && c <= 0xd7af)) {
      cjkCount++;
    }
  }
  const asciiLen = s.length - cjkCount;
  return Math.max(1, Math.ceil(asciiLen / 4) + Math.ceil(cjkCount / 1.5));
}

// ─── MinHash Signatures ──────────────────────────────────────────────────

// FNV-1a hash: fast, non-cryptographic, ~10x faster than SHA-256 for MinHash
function fnv1a(str) {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
    hash >>>= 0; // Keep as uint32
  }
  return hash;
}

/**
 * Compute a MinHash signature for approximate set similarity.
 * Returns null for texts with fewer than 3 tokens.
 * @param {string} text Input text to hash
 * @param {number} [numHashes=64] Number of hash functions
 * @returns {string|null} Hex-encoded MinHash signature or null
 */
export function computeMinHash(text, numHashes = 64) {
  if (!text || typeof text !== 'string') return null;
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(t => t.length > 2);
  // Require at least 3 tokens for meaningful signature (avoids high collision on short texts)
  if (tokens.length < 3) return null;

  const mins = new Array(numHashes).fill(0xFFFFFFFF);
  for (const token of tokens) {
    for (let i = 0; i < numHashes; i++) {
      const val = fnv1a(`${i}-${token}`);
      if (val < mins[i]) mins[i] = val;
    }
  }
  return mins.map(v => v.toString(16).padStart(8, '0')).join('');
}

/**
 * Estimate Jaccard similarity from two MinHash signatures.
 * @param {string} sig1 First hex-encoded MinHash signature
 * @param {string} sig2 Second hex-encoded MinHash signature
 * @returns {number} Estimated Jaccard similarity between 0 and 1
 */
export function estimateJaccardFromMinHash(sig1, sig2) {
  if (!sig1 || !sig2) return 0;
  if (sig1.length !== sig2.length) return 0;
  const numHashes = sig1.length / 8;
  if (numHashes === 0) return 0;
  let matches = 0;
  for (let i = 0; i < numHashes; i++) {
    const offset = i * 8;
    if (sig1.slice(offset, offset + 8) === sig2.slice(offset, offset + 8)) matches++;
  }
  return matches / numHashes;
}

/**
 * Map observation type to its display emoji icon.
 * @param {string} type Observation type (decision, bugfix, feature, etc.)
 * @returns {string} Emoji icon for the type
 */
export function typeIcon(type) {
  const icons = { decision: '🟡', bugfix: '🔴', feature: '🟢', refactor: '🔵', discovery: '🔍', change: '📝' };
  return icons[type] || '⚪';
}

// ─── FTS5 ────────────────────────────────────────────────────────────────────

const FTS5_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

// Synonym/abbreviation map: query abbreviation → expanded full forms
// Bidirectional: both directions are registered so "K8s" finds "Kubernetes" and vice versa
const SYNONYM_MAP = new Map();
const SYNONYM_PAIRS = [
  // Abbreviation ↔ full form
  ['k8s', 'kubernetes'],
  ['db', 'database'],
  ['js', 'javascript'],
  ['ts', 'typescript'],
  ['py', 'python'],
  ['ci', 'continuous integration'],
  ['cd', 'continuous deployment'],
  ['ws', 'websocket'],
  ['auth', 'authentication'],
  ['authn', 'authentication'],
  ['authz', 'authorization'],
  ['config', 'configuration'],
  ['deps', 'dependencies'],
  ['env', 'environment'],
  ['infra', 'infrastructure'],
  ['msg', 'message'],
  ['pkg', 'package'],
  ['repo', 'repository'],
  ['req', 'request'],
  ['res', 'response'],
  ['ml', 'machine learning'],
  ['ai', 'artificial intelligence'],
  ['api', 'application programming interface'],
  ['ui', 'user interface'],
  ['ux', 'user experience'],
  ['fe', 'frontend'],
  ['be', 'backend'],
  ['gql', 'graphql'],
  ['tf', 'terraform'],
  ['cdk', 'cloud development kit'],
  ['iac', 'infrastructure as code'],
  ['e2e', 'end to end'],
  ['perf', 'performance'],
  ['impl', 'implementation'],
  ['fn', 'function'],
  ['util', 'utility'],
  ['utils', 'utilities'],
  ['err', 'error'],
  ['src', 'source'],
  ['lib', 'library'],
  ['dev', 'development'],
  ['prod', 'production'],
  ['async', 'asynchronous'],
  ['sync', 'synchronous'],
  // Semantic equivalents — precise synonyms only (overly broad bridges removed)
  ['login', 'signin'],
  ['bug', 'error'],
  ['bug', 'defect'],
  ['crash', 'panic'],
  ['crash', 'segfault'],
  ['slow', 'latency'],
  ['remove', 'delete'],
  ['setup', 'install'],
  ['deploy', 'release'],
  ['deploy', 'publish'],
  ['refactor', 'restructure'],
  ['test', 'spec'],
  ['cache', 'caching'],
  ['cache', 'memoize'],
  ['optimize', 'optimization'],
  ['fix', 'bugfix'],
  ['fix', 'patch'],
  ['debug', 'debugging'],
  ['debug', 'troubleshoot'],
  ['error', 'failure'],
  ['migrate', 'migration'],
  // ─── CJK ↔ EN cross-language synonyms ───
  // Authentication & Authorization
  ['认证', 'auth'], ['认证', 'authentication'], ['登录', 'login'], ['登录', 'auth'],
  ['授权', 'authorization'], ['权限', 'permission'],
  // Deployment & Operations
  ['部署', 'deploy'], ['部署', 'deployment'], ['发布', 'release'], ['发布', 'publish'],
  // Data & Storage
  ['缓存', 'cache'], ['缓存', 'caching'],
  ['数据库', 'database'], ['数据库', 'db'],
  // Testing & Debugging
  ['测试', 'test'], ['测试', 'testing'],
  ['调试', 'debug'], ['调试', 'debugging'],
  ['修复', 'fix'], ['修复', 'bugfix'],
  // Code Quality
  ['重构', 'refactor'], ['重构', 'refactoring'],
  ['配置', 'config'], ['配置', 'configuration'],
  // API & Networking
  ['接口', 'api'], ['接口', 'endpoint'],
  ['路由', 'route'], ['路由', 'routing'],
  ['中间件', 'middleware'],
  // UI & Components
  ['组件', 'component'], ['模板', 'template'],
  // Database Operations
  ['迁移', 'migration'], ['迁移', 'migrate'],
  ['索引', 'index'], ['查询', 'query'], ['查询', 'search'],
  ['排序', 'sort'], ['分页', 'pagination'],
  // Validation & Security
  ['验证', 'validate'], ['验证', 'validation'],
  ['加密', 'encrypt'], ['加密', 'encryption'],
  ['会话', 'session'], ['令牌', 'token'],
  // Patterns & Architecture
  ['钩子', 'hook'], ['回调', 'callback'],
  ['异步', 'async'], ['同步', 'sync'],
  ['并发', 'concurrent'], ['线程', 'thread'],
  // Performance
  ['性能', 'performance'], ['性能', 'perf'],
  ['内存', 'memory'], ['泄漏', 'leak'],
  ['超时', 'timeout'], ['重试', 'retry'],
  // Observability
  ['日志', 'log'], ['日志', 'logging'],
  ['监控', 'monitor'], ['告警', 'alert'],
  // Build & Dependencies
  ['依赖', 'dependency'], ['构建', 'build'], ['构建', 'compile'],
  ['打包', 'bundle'], ['类型', 'type'], ['类型', 'typescript'],
  // Errors
  ['错误', 'error'], ['异常', 'exception'],
  // Infrastructure
  ['容器', 'container'], ['容器', 'docker'],
  ['集群', 'cluster'], ['集群', 'kubernetes'],
  ['网关', 'gateway'], ['负载', 'load balancing'],
  ['队列', 'queue'], ['序列化', 'serialize'],
];
// Build bidirectional lookup (case-insensitive)
for (const [abbr, full] of SYNONYM_PAIRS) {
  const aLow = abbr.toLowerCase();
  const fLow = full.toLowerCase();
  if (!SYNONYM_MAP.has(aLow)) SYNONYM_MAP.set(aLow, new Set());
  SYNONYM_MAP.get(aLow).add(fLow);
  if (!SYNONYM_MAP.has(fLow)) SYNONYM_MAP.set(fLow, new Set());
  SYNONYM_MAP.get(fLow).add(aLow);
}

// Format a term for FTS5: quote if it contains spaces, hyphens, or special chars
function ftsToken(term) {
  // Bare tokens are safe if purely alphanumeric or CJK characters
  if (/^[a-zA-Z0-9\u4e00-\u9fff\u3400-\u4dbf]+$/.test(term)) return term;
  return `"${term.replace(/"/g, '""')}"`;
}

function expandToken(token) {
  const synonyms = SYNONYM_MAP.get(token.toLowerCase());
  if (!synonyms || synonyms.size === 0) return ftsToken(token);
  // FTS5 OR group: (original OR synonym1 OR "multi word synonym")
  const parts = [ftsToken(token)];
  for (const syn of synonyms) {
    parts.push(ftsToken(syn));
  }
  return `(${parts.join(' OR ')})`;
}

/**
 * Sanitize and expand a user query into a valid FTS5 query string.
 * Strips special characters, expands synonyms, and joins with AND/space.
 * @param {string} query Raw user search query
 * @returns {string|null} FTS5-safe query or null if empty
 */
export function sanitizeFtsQuery(query) {
  if (!query) return null;
  const cleaned = query
    .replace(/[{}()[\]^~*:"\\]/g, ' ')
    .replace(/(^|\s)-/g, '$1')
    .trim();
  if (!cleaned) return null;
  const tokens = cleaned.split(/\s+/).filter(t =>
    t && !/^-+$/.test(t) && !FTS5_KEYWORDS.has(t.toUpperCase()) && !/^NEAR\/\d+$/i.test(t)
    // Skip single ASCII-letter tokens — too noisy for FTS5 (CJK single chars handled separately below)
    && !(t.length === 1 && /^[a-zA-Z]$/.test(t))
  );
  if (tokens.length === 0) return null;
  // Replace single CJK character tokens with bigrams for better phrase matching.
  // Individual CJK chars ("系","统") are too noisy; bigrams ("系统") capture compound words.
  const bigrams = cjkBigrams(cleaned);
  const bigramSet = new Set(bigrams ? bigrams.split(' ').filter(Boolean) : []);
  const hasBigrams = bigramSet.size > 0;
  const finalTokens = [];
  const seen = new Set();
  const rawTokensSeen = new Set(); // track raw tokens to prevent bigram duplicates
  for (const t of tokens) {
    // Skip single CJK characters when we have bigrams — they're subsumed by bigram tokens
    if (hasBigrams && /^[\u4e00-\u9fff\u3400-\u4dbf]$/.test(t)) continue;
    const expanded = expandToken(t);
    if (!seen.has(expanded)) { seen.add(expanded); rawTokensSeen.add(t); finalTokens.push(expanded); }
  }
  for (const bg of bigramSet) {
    if (!seen.has(bg) && !rawTokensSeen.has(bg)) { seen.add(bg); finalTokens.push(bg); }
  }
  if (finalTokens.length === 0) return null;
  // FTS5 requires explicit AND after parenthesized OR groups
  const hasGroup = finalTokens.some(e => e.startsWith('('));
  return finalTokens.join(hasGroup ? ' AND ' : ' ');
}

/**
 * Relax an AND-joined FTS5 query to OR-joined for fallback search.
 * Only useful when the original query has multiple tokens (single-token queries
 * are already as relaxed as possible).
 * @param {string} ftsQuery Original AND-joined FTS5 query from sanitizeFtsQuery
 * @returns {string|null} OR-joined query, or null if relaxation wouldn't help
 */
export function relaxFtsQueryToOr(ftsQuery) {
  if (!ftsQuery) return null;
  // Replace AND joins with OR — handles both explicit " AND " and implicit space joins
  const orQuery = ftsQuery.replace(/ AND /g, ' OR ');
  // If no AND was present, tokens are space-joined (implicit AND); convert to OR
  if (orQuery === ftsQuery && !ftsQuery.includes(' OR ')) {
    const parts = ftsQuery.split(/\s+/);
    if (parts.length < 2) return null; // single token — OR won't help
    return parts.join(' OR ');
  }
  return orQuery !== ftsQuery ? orQuery : null;
}

// ─── Importance ──────────────────────────────────────────────────────────────

/**
 * Clamp an importance value to the valid range [1, 3].
 * @param {*} val Raw importance value (may be non-numeric)
 * @returns {number} Clamped integer importance (1, 2, or 3)
 */
export function clampImportance(val) {
  if (typeof val !== 'number' || isNaN(val)) return 1;
  return Math.max(1, Math.min(3, Math.round(val)));
}

/**
 * Compute deterministic importance from episode entries using rule-based heuristics.
 * Checks file patterns (env, migrations, config) and bash significance signals.
 * @param {object} episode Episode with entries array
 * @returns {number} Rule-based importance (1, 2, or 3)
 */
// Tools that produce file edits (used for significance detection, feedback, importance)
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

export function computeRuleImportance(episode) {
  let importance = 1;
  const toolTypes = new Set();
  let hasErrorThenEdit = false;
  let lastWasError = false;

  for (const entry of episode.entries) {
    const sig = entry.bashSig;
    const files = entry.files || [];
    toolTypes.add(entry.tool);

    // Track error→edit debug cycle pattern
    if (lastWasError && EDIT_TOOLS.has(entry.tool)) hasErrorThenEdit = true;
    lastWasError = entry.isError || sig?.isError;

    if (sig?.isError && (sig?.isTest || sig?.isBuild)) { importance = 3; break; }
    if (files.some(f => /\.(env|pem|key)$|\/auth\.|\/credential|\/password/i.test(f))) { importance = 3; break; }
    if (files.some(f => /migration|schema\.|prisma|alembic/i.test(f))) { importance = 3; break; }
    if (sig?.isError && importance < 2) importance = 2;
    if (sig?.isGit && importance < 2) importance = 2;
    if (sig?.isDeploy && importance < 2) importance = 2;
    if (files.some(f => /\.config\.|tsconfig|Dockerfile|docker-compose|package\.json|\.yml$|\.yaml$/i.test(basename(f))) && importance < 2) importance = 2;
  }

  // Debug cycle: error followed by edit = active debugging
  if (hasErrorThenEdit && importance < 2) importance = 2;
  // Broad change: many files touched (8+ indicates significant scope)
  if ((episode.files || []).length >= 8 && importance < 2) importance = 2;

  return importance;
}

/**
 * Generate CJK bigrams from text for improved Chinese phrase matching in FTS5.
 * "修复了系统崩溃" → "修复 系统 统崩 崩溃"
 * @param {string} text Input text containing CJK characters
 * @returns {string} Space-separated bigrams
 */
// Common CJK compound words (2-4 chars) — dictionary-first tokenization.
// When a compound word is found, it's emitted as a whole token instead of being
// split into overlapping bigrams. This dramatically reduces noise:
// "数据库" → "数据库" (1 token) instead of "数据 据库" (2 noisy tokens)
const CJK_COMPOUNDS = new Set([
  // tech/programming
  '数据库', '数据', '接口', '函数', '变量', '组件', '模块', '配置', '框架', '部署',
  '测试', '调试', '编译', '打包', '构建', '缓存', '索引', '迁移', '回滚', '权限',
  '认证', '授权', '加密', '解密', '序列', '并发', '异步', '同步', '线程', '进程',
  '容器', '集群', '服务器', '中间件', '网关', '负载', '监控', '日志', '告警',
  '前端', '后端', '全栈', '响应式', '路由', '状态', '渲染', '样式', '布局',
  // actions
  '修复', '重构', '优化', '升级', '安装', '卸载', '导入', '导出', '上传', '下载',
  '提交', '推送', '合并', '发布', '上线', '回退', '审查', '审核', '评审',
  // errors/issues
  '报错', '崩溃', '泄露', '溢出', '死锁', '超时', '中断', '异常', '故障',
  // architecture
  '架构', '设计', '方案', '规划', '文档', '注释', '版本', '分支', '依赖',
  '性能', '安全', '漏洞', '补丁',
]);

// Sort by length descending for greedy matching
const CJK_SORTED = [...CJK_COMPOUNDS].sort((a, b) => b.length - a.length);

/**
 * Generate search tokens from CJK text using dictionary-first tokenization.
 * Compound words are emitted whole; remaining chars use bigram fallback.
 * "修复了数据库崩溃" → "修复 数据库 崩溃" (3 clean tokens)
 * vs old bigram: "修复 复了 了数 数据 据库 库崩 崩溃" (7 noisy tokens)
 * @param {string} text Input text containing CJK characters
 * @returns {string} Space-separated tokens
 */
export function cjkBigrams(text) {
  if (!text) return '';
  const runs = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g) || [];
  const tokens = [];
  for (const run of runs) {
    let i = 0;
    while (i < run.length) {
      let matched = false;
      // Greedy dictionary match (longest first)
      for (const word of CJK_SORTED) {
        if (i + word.length <= run.length && run.slice(i, i + word.length) === word) {
          tokens.push(word);
          i += word.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Fallback: bigram for unknown compound
        if (i + 1 < run.length) {
          tokens.push(run[i] + run[i + 1]);
        }
        i++;
      }
    }
  }
  return [...new Set(tokens)].join(' ');
}

// ─── Project Inference ───────────────────────────────────────────────────────

/**
 * Infer a sanitized project name from CLAUDE_PROJECT_DIR, PWD, or cwd.
 * Format: "parent--basename" with non-alphanumeric chars replaced by hyphens.
 * @returns {string} Sanitized project identifier safe for use in filenames
 */
export function inferProject() {
  const p = process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
  const base = basename(p);
  const parent = basename(dirname(p));
  const raw = parent && parent !== '.' && parent !== '/' ? `${parent}--${base}` : base;
  // Sanitize to prevent path traversal when used in filenames (ep-<project>.json)
  // Truncate to 100 chars to avoid exceeding filesystem name limits (255 bytes)
  return raw.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100);
}

// ─── Bash Analysis ───────────────────────────────────────────────────────────

/**
 * Detect significance signals in a Bash command and its response.
 * Checks for errors, test runs, builds, git operations, and deployments.
 * @param {object} input Tool input with command field
 * @param {string} response Command output text
 * @returns {{isError: boolean, isTest: boolean, isBuild: boolean, isGit: boolean, isDeploy: boolean, isSignificant: boolean}}
 */
export function detectBashSignificance(input, response) {
  const cmd = (input.command || '').toLowerCase();
  // Skip error keyword matching when the command is a read/search operation
  // (grep output naturally contains matched keywords like "error")
  const isSearchCmd = /\b(grep|rg|ag|ack|cat|head|tail|less|more|find|locate|wc|file|which|type)\b/i.test(cmd);
  const isError = !isSearchCmd
    && /\berror\b|\bERR!|fail(ed|ure)?|exception|panic|traceback|errno|enoent|command not found/i.test(response)
    && response.length > 15;
  // Match actual test runner invocations, not commands that merely reference "test" as a keyword
  const isTest = /\b(npm\s+test|npm\s+run\s+test|yarn\s+test|pnpm\s+test|pnpm\s+run\s+test|bun\s+test|go\s+test|cargo\s+test)\b/i.test(cmd)
    || /\b(jest|pytest|vitest|mocha|cypress|playwright)\b/i.test(cmd);
  const isBuild = /\b(build|compile|tsc|webpack|vite|rollup|esbuild|make|cargo)\b/i.test(cmd);
  const isGit = /\bgit\s+(commit|merge|rebase|cherry-pick|push)\b/i.test(cmd);
  const isDeploy = /\b(deploy|docker|kubectl|terraform)\b/i.test(cmd);
  return {
    isError, isTest, isBuild, isGit, isDeploy,
    isSignificant: isError || isTest || isBuild || isGit || isDeploy,
  };
}

const ERROR_STOP_WORDS = new Set([
  'error', 'failed', 'cannot', 'could', 'with', 'from', 'that', 'this',
  'have', 'been', 'were', 'does', 'will', 'would', 'should', 'must',
  'true', 'false', 'null', 'undefined', 'function', 'return', 'const',
  'node', 'require', 'stack', 'trace',
]);

/**
 * Extract discriminative keywords from a failed command and its error output.
 * Filters out common stop words to produce useful FTS5 search terms.
 * @param {string} cmd The command that was executed
 * @param {string} response The error output text
 * @returns {string[]|null} Array of 1-6 keywords or null if none found
 */
export function extractErrorKeywords(cmd, response) {
  const words = new Set();
  const cmdParts = cmd.split(/[\s/\\|&;]+/).filter(w => w.length > 2 && !/^-/.test(w));
  for (const w of cmdParts.slice(0, 3)) {
    const lw = w.toLowerCase();
    if (!ERROR_STOP_WORDS.has(lw)) words.add(lw);
  }
  const errLines = response.split('\n').filter(l =>
    /error|fail|exception|cannot|not found|undefined|null/i.test(l)
  ).slice(0, 3);
  for (const line of errLines) {
    const tokens = line.replace(/[^a-zA-Z0-9_.-]/g, ' ').split(/\s+/)
      .filter(w => w.length > 3 && !/^\d+$/.test(w));
    for (const t of tokens.slice(0, 5)) {
      const lt = t.toLowerCase();
      if (!ERROR_STOP_WORDS.has(lt)) words.add(lt);
    }
  }
  const result = [...words].slice(0, 6);
  return result.length >= 1 ? result : null;
}

// ─── File Paths ──────────────────────────────────────────────────────────────

/**
 * Extract file paths from tool input (file_path, path, filePath, or command args).
 * Deduplicates and excludes /dev/, /proc/, and /tmp/ paths.
 * @param {object} input Tool input object
 * @returns {string[]} Unique array of file paths
 */
export function extractFilePaths(input) {
  const paths = [];
  if (input.file_path) paths.push(input.file_path);
  if (input.path) paths.push(input.path);
  if (input.filePath) paths.push(input.filePath);
  if (input.command) {
    // Match absolute paths; extension optional to support Makefile, Dockerfile etc.
    const match = input.command.match(/(?:^|\s)(\/[\w./-]+\w)/g);
    if (match) {
      for (const m of match) {
        const p = m.trim();
        if (!p.startsWith('/dev/') && !p.startsWith('/proc/') && !p.startsWith('/tmp/')
          // Skip single-component paths like /exit, /clear — likely slash commands, not files
          && (p.indexOf('/', 1) !== -1 || /\.\w+$/.test(p))) {
          paths.push(p);
        }
      }
    }
  }
  return [...new Set(paths)];
}

// ─── Episode Logic ───────────────────────────────────────────────────────────

/**
 * Strip test/spec/e2e suffixes from a filename for sibling matching.
 * Example: auth.test.ts → auth.ts, auth.spec.js → auth.js
 * @param {string} filePath File path to strip
 * @returns {string} Basename with test suffix removed
 */
export function stripTestSuffix(filePath) {
  return basename(filePath).replace(/\.(test|spec|e2e)\./i, '.');
}

/**
 * Check if new files are related to an existing episode's file set.
 * Considers exact match, directory overlap, and test-sibling relationships.
 * @param {object} episode Episode with files array
 * @param {string[]} newFiles Array of file paths to check
 * @returns {boolean} true if any file is related to the episode
 */
export function isRelatedToEpisode(episode, newFiles) {
  // No files (Bash, Grep without file context) → always related
  if (newFiles.length === 0) return true;
  if (episode.files.length === 0) return true;
  // Check file, directory, or test-sibling overlap
  for (const nf of newFiles) {
    for (const ef of episode.files) {
      if (nf === ef) return true;
      if (dirname(nf) === dirname(ef)) return true;
      // Test file ↔ source file (auth.ts ↔ auth.test.ts across directories)
      if (stripTestSuffix(nf) === stripTestSuffix(ef)) return true;
    }
  }
  return false;
}

// ─── Entry Description ──────────────────────────────────────────────────────

/**
 * Generate a human-readable description of a tool invocation for episode entries.
 * @param {string} toolName Name of the tool (Edit, Write, Bash, etc.)
 * @param {object} input Tool input parameters
 * @param {string} resp Tool response text
 * @returns {string} Concise description of the action
 */
export function makeEntryDesc(toolName, input, resp) {
  switch (toolName) {
    case 'Edit':
      return `${basename(input.file_path || '')}: "${truncate(input.old_string || '', 40)}" → "${truncate(input.new_string || '', 40)}"`;
    case 'Write':
      return `Created ${basename(input.file_path || '')} (${(input.content || '').length} chars)`;
    case 'NotebookEdit':
      return `Notebook cell: ${truncate(input.new_source || '', 60)}`;
    case 'Bash': {
      const cmd = truncate(input.command || '', 50);
      const isErr = /error|fail|exception|panic/i.test(resp) && resp.length > 30;
      const snippet = truncate(resp, 60);
      return isErr ? `${cmd} → ERROR: ${snippet}` : `${cmd} → ${snippet}`;
    }
    case 'Grep':
      return `Search "${truncate(input.pattern || '', 20)}" → ${truncate(resp, 60)}`;
    case 'LSP':
      return `${input.operation || ''} ${basename(input.filePath || '')}`;
    case 'Task': case 'Agent':
      return truncate(input.description || '', 60);
    case 'WebSearch':
      return `Web: ${truncate(input.query || '', 50)}`;
    case 'WebFetch':
      return `Fetch: ${truncate(input.url || '', 50)}`;
    default:
      return `${toolName}: ${truncate(resp, 50)}`;
  }
}

// ─── Date Formatting ─────────────────────────────────────────────────────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Format an ISO date string as "Mon DD HH:MM" for compact display.
 * @param {string} iso ISO 8601 date string
 * @returns {string} Formatted date or empty string
 */
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const mon = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${day} ${h}:${m}`;
}

/**
 * Format an ISO date string as "HH:MM" for time-only display.
 * @param {string} iso ISO 8601 date string
 * @returns {string} Formatted time or empty string
 */
export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ─── ISO Week ────────────────────────────────────────────────────────────────

/**
 * Convert an epoch timestamp to an ISO week key string (e.g. "2026-W06").
 * @param {number} epochMs Epoch timestamp in milliseconds
 * @returns {string} ISO week key in format "YYYY-Wnn"
 */
export function isoWeekKey(epochMs) {
  const d = new Date(epochMs);
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
  const isoYear = tmp.getUTCFullYear();
  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}

// ─── Structured Logging ──────────────────────────────────────────────────────

/**
 * Emit a structured log line gated by CLAUDE_MEM_DEBUG.
 * Format: [claude-mem-lite] [ISO timestamp] [LEVEL] context: message
 * @param {'DEBUG'|'WARN'|'ERROR'} level Log severity
 * @param {string} context Module or function name
 * @param {string} msg Human-readable message
 */
export function debugLog(level, context, msg) {
  if (!process.env.CLAUDE_MEM_DEBUG) return;
  const ts = new Date().toISOString();
  console.error(`[claude-mem-lite] [${ts}] [${level}] ${context}: ${msg}`);
}

/**
 * Log a caught error at ERROR level (includes stack trace when available).
 * Gated by CLAUDE_MEM_DEBUG. Use in catch blocks for non-fatal errors.
 * @param {Error|unknown} e The caught error
 * @param {string} context Module or function name for attribution
 */
export function debugCatch(e, context) {
  if (process.env.CLAUDE_MEM_DEBUG) {
    const ts = new Date().toISOString();
    console.error(`[claude-mem-lite] [${ts}] [ERROR] ${context}:`, e?.stack || e?.message || e);
  }
}

// ─── JSON Parsing ────────────────────────────────────────────────────────────

/**
 * Parse JSON from LLM output, handling markdown fences and embedded objects.
 * Tries: direct parse → fenced code block → regex object extraction.
 * @param {string} text Raw LLM output text
 * @returns {object|null} Parsed JSON object or null on failure
 */
export function parseJsonFromLLM(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) try { return JSON.parse(fenced[1]); } catch {}
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) try { return JSON.parse(obj[0]); } catch {}
  return null;
}

// ─── Handoff Utilities ──────────────────────────────────────────────────────

/** Stop words for handoff keyword extraction (broader than ERROR_STOP_WORDS). */
export const HANDOFF_STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were',
  'been', 'have', 'has', 'had', 'does', 'did', 'will', 'would', 'should', 'could',
  'can', 'may', 'must', 'not', 'but', 'its', 'all', 'any', 'each', 'some',
  'into', 'over', 'after', 'before', 'between', 'about', 'also', 'just', 'then',
  'than', 'when', 'where', 'how', 'what', 'which', 'who', 'why', 'here', 'there',
  'more', 'very', 'only', 'still', 'now', 'new', 'old', 'get', 'got', 'set',
  'true', 'false', 'null', 'undefined', 'function', 'return', 'const', 'let', 'var',
  'import', 'export', 'default', 'class', 'async', 'await', 'try', 'catch',
]);

/**
 * Tokenize text for handoff keyword matching.
 * Splits on whitespace/punctuation, lowercases, filters short tokens.
 * @param {string} text Input text
 * @returns {string[]} Array of lowercase tokens (length >= 3)
 */
export function tokenizeHandoff(text) {
  if (!text) return [];
  return text
    .split(/[\s,;:.()[\]{}'"`<>→|/\\#@!?=+*&^%$~]+/)
    .map(w => w.toLowerCase().replace(/^[.-]+|[.-]+$/g, ''))
    .filter(w => w.length >= 3);
}

/**
 * Check if a token is a "specific" term (file name, identifier, etc.)
 * that should get double weight in intent matching.
 * @param {string} token Lowercase token
 * @returns {boolean}
 */
export function isSpecificTerm(token) {
  if (!token || token.length < 3) return false;
  if (token.includes('_') || token.includes('-')) return true;
  if (HANDOFF_STOP_WORDS.has(token)) return false;
  return token.length >= 4 && !/^\d+$/.test(token);
}

/**
 * Extract match keywords from text and file paths for handoff intent matching.
 * @param {string} text Combined text from prompts, observations, etc.
 * @param {string[]} files Array of file paths
 * @returns {string} Space-separated keywords
 */
export function extractMatchKeywords(text, files) {
  const terms = new Set();
  for (const f of files) {
    const base = basename(f).replace(/\.[^.]+$/, '');
    if (base.length >= 3) terms.add(base.toLowerCase());
  }
  const words = tokenizeHandoff(text);
  for (const w of words) {
    if (!HANDOFF_STOP_WORDS.has(w)) terms.add(w);
  }
  return [...terms].join(' ');
}
