// prompt-search-utils.mjs — Shared logic for user-prompt-search hook and its tests.
// Extracted to eliminate code duplication between the hook script and test file.

import { readFileSync } from 'fs';

// ─── Skip Patterns ──────────────────────────────────────────────────────────

const CONFIRM_RE = /^(y(es)?|no?|ok|done|go|sure|lgtm|thanks?|ty|继续|确认|好的|是的|对|嗯|行|可以|没问题)$/i;
const SLASH_CMD_RE = /^\//;
const PURE_OP_RE = /^(git\s+(commit|push|merge)|npm\s+(publish|deploy))\b/i;

// v2.43.x: pure continuation directives — "keep going on what you were doing"
// with no new topic. Long enough to evade CONFIRM_RE / length gate but
// semantically empty for memory-recall purposes; injecting [mem] context
// here reads like a turn boundary and can prematurely end the model's
// in-flight tool chain. Conservative match: must be SOLELY the directive,
// not directive + new instruction (those keep getting injection).
const CONTINUATION_RE =
  /^(继续|接着|继续做|接着做|继续干|继续做下一步|接着做下一步|别停|不要停|next|continue|go\s*on|keep\s+going|carry\s+on|proceed|more(?:\s+please)?)\s*[?？!！。.，,]*\s*$/i;

// v2.43.x: meta-pause questions — user is asking the model to reflect on
// its own pause/stop, then continue. No new topic = no useful memory hit;
// injection just adds reminder noise on top of an already-reflective turn.
const META_PAUSE_RE =
  /(怎么停|为什么停|为何停|你怎么停|工作停下来|刚才停|why\s+(?:did\s+you\s+)?(?:stop|pause|halt))/i;

/**
 * CJK-weighted effective length. CJK characters (CJK Unified Ideographs
 * main + extension A) carry ~3x the semantic token density of Latin
 * characters — a 5-char Chinese phrase like "优化数据库" encodes roughly
 * the same information as a 15-char English equivalent. Used by every
 * length gate downstream of the prompt hook so Latin-calibrated
 * thresholds (8 / 15) don't falsely reject substantive CJK prompts.
 */
export function computeEffectiveLen(text) {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  return text.length - cjkCount + cjkCount * 3;
}

export function shouldSkip(text) {
  if (!text) return true;
  if (computeEffectiveLen(text) < 8) return true;
  const trimmed = text.trim();
  if (CONFIRM_RE.test(trimmed)) return true;
  if (SLASH_CMD_RE.test(trimmed)) return true;
  if (PURE_OP_RE.test(trimmed)) return true;
  if (CONTINUATION_RE.test(trimmed)) return true;
  if (META_PAUSE_RE.test(trimmed)) return true;
  return false;
}

// ─── Intent Detection ───────────────────────────────────────────────────────

export const INTENTS = [
  // Error/debug intent — highest priority, most actionable
  // CJK: 不工作/有问题/挂了 from real prompts; 异常/失败/排查/定位/诊断 from dev vocabulary
  {
    pattern:
      /error|bug|crash|broken|fail(?:ed|ing|ure)?|fix(?:ed|ing)?|debug|调试|报错|出错|错误|崩溃|修复|故障|不工作|有问题|出了问题|挂了|异常|失败|解决|排查|定位|诊断/i,
    type: 'bugfix',
    limit: 3,
  },
  // Test intent — test failures surface bugfix memories
  // CJK: 跑测试/写测试/测试用例/覆盖率 from real prompts
  {
    pattern:
      /\btest(?:s|ing)?\b|spec\b|assert|单元测试|测试失败|test fail|测试|跑测试|写测试|测试用例|覆盖率/i,
    type: 'bugfix',
    limit: 3,
  },
  // Review/audit intent — from real data: 审查(6x), 检查(9x), 审核, 代码审核
  {
    pattern: /\breview\b|audit|inspect|审查|审核|检查|代码审核|审阅|code.?review/i,
    type: 'discovery',
    limit: 3,
  },
  // Refactor intent — surface past refactor decisions and patterns
  // CJK: 拆分/提取/简化/解耦/清理 from real prompts; 优化代码 = refactor (not perf)
  {
    pattern: /refactor|restructur|cleanup|clean up|重构|整理|代码质量|拆分|提取|简化|解耦|清理/i,
    type: 'refactor',
    limit: 3,
  },
  // Performance intent — before decision (so "slow" doesn't get classified as decision)
  // CJK: 卡顿/超时/内存泄漏/优化 from real prompts; 加速/提速 from dev vocabulary
  {
    pattern:
      /performance|perf\b|slow|latency|bottleneck|optimiz|性能|慢|延迟|耗时|效率低|卡顿|超时|内存泄漏|优化|加速|提速/i,
    type: 'discovery',
    limit: 3,
  },
  // Decision/architecture intent
  // CJK: 方案/原因/考虑/权衡/思路 from real prompts
  {
    pattern: /why\b|decided|architecture|design\b|为什么|决定|架构|设计|方案|原因|考虑|权衡|思路/i,
    type: 'decision',
    limit: 3,
  },
  // Database/schema intent — surface migration decisions
  // CJK: 索引/查询/建表/改表 from dev vocabulary
  {
    pattern: /schema|migration|数据库|迁移|database\b|表结构|字段|索引|查询|建表|改表/i,
    type: 'decision',
    limit: 3,
  },
  // Implementation intent — surface related feature history (no type filter for broader recall)
  // CJK: 开发/编写/创建/构建/做一个/写一个 from real prompts
  {
    pattern:
      /implement|feature\b|add\s+(?:a\s+)?new|实现|添加|新功能|新增|开发|编写|创建|构建|做一个|加一个|写一个/i,
    type: null,
    limit: 3,
  },
  // Recall/history intent (catch-all temporal, lowest priority)
  // CJK: 刚才/历史/回顾 from real prompts; 碰到过|遇到过|见过|同样的问题 from spoken CN
  //
  // MEASURED AND REJECTED — do not re-add `remind me` here without a ruler (2026-09-05,
  // 10-row typed corpus, sandbox install). The reasoning that it belongs is seductive and
  // wrong: `remember` is already in this arm, `remind me` is its imperative twin, and its
  // absence is the sole reason "remind me what we decided about session cookies" reaches
  // hasExplicitSignal with no error signature, no file, no identifier and no CJK, and is
  // dropped before FTS runs. Added, the prompt does fire — and this arm carries
  // useRecent + limit 5, so when topical FTS comes back empty (it does: the OR floor
  // drops a long multi-topic prompt whose best row shares only "session"/"cookies") the
  // recency fallback spends FIVE injection slots on the five newest rows, and on the
  // measured corpus the session-cookies decision was NOT among them. Five noise rows and
  // no answer is worse than the silence it replaced. Any future attempt needs
  // benchmark/citation-live-replay.mjs on the `fyi` face, not this intuition.
  {
    pattern:
      /before|previously|last time|remember|seen this|same\s+issue|之前|上次|以前|记得|刚才|历史|回顾|碰到过|遇到过|见过|同样的问题|类似的问题/i,
    type: null,
    limit: 5,
    useRecent: true,
  },
];

export function detectIntent(text) {
  // Collect all matching intents (patterns may overlap)
  const matches = [];
  for (const intent of INTENTS) {
    if (intent.pattern.test(text)) matches.push(intent);
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  // Disambiguation: when recall intent overlaps with an actionable intent,
  // use position-based resolution — the pattern appearing earlier in text wins.
  // "I remember we fixed..." → recall leads. "fix the bug from before" → bugfix leads.
  const first = matches[0];
  const recallMatch = matches.find((m) => m.useRecent);
  if (recallMatch && first !== recallMatch) {
    const actionPos = text.search(first.pattern);
    const recallPos = text.search(recallMatch.pattern);
    if (recallPos < actionPos) return recallMatch;
  }
  return first;
}

// detectMemOverride lives in lib/mem-override.mjs (importable from hook.mjs
// without dragging the scripts/ tree into SOURCE_FILES). Re-exported here so
// scripts/user-prompt-search.js and existing tests can keep importing it
// from the same module as the rest of the prompt-side helpers.
export { detectMemOverride } from '../lib/mem-override.mjs';

// ─── Error Signature Extraction ─────────────────────────────────────────────

/**
 * Extract a canonical error signature from prompt text.
 *
 * Matches named exception/error classes like:
 *   - "TypeError: Cannot read properties of undefined (reading 'foo')"
 *   - "Error [ERR_MODULE_NOT_FOUND]: module X not found"
 *   - "AssertionError: expected 'a' to equal 'b'"
 *   - "ValueError: invalid literal for int()"
 *   - "thread 'main' panicked at ..." (Rust) → captured via Panic class
 *
 * Intentionally skips bare "Error: ..." without a typed class, and skips
 * lowercase matches — those carry too little signal vs. the intent-based
 * FTS path which already catches them.
 *
 * Returns { className, errorCode, message, signature } or null.
 * `signature` is suitable for direct FTS5 search (sanitizeFtsQuery applies).
 */
export function extractErrorSignature(text) {
  if (!text || typeof text !== 'string') return null;
  // Pass 1: typed class — "<CapCase>(Error|Exception|Panic)" with optional [ERR_CODE]
  const TYPED_RE =
    /\b([A-Z][A-Za-z0-9]+(?:Error|Exception|Panic))(?:\s*\[([A-Z_][A-Z0-9_]*)\])?\s*:\s*([^\n]{3,200})/;
  // Pass 2: bare "Error|Exception|Panic" followed by required [ERR_CODE] (Node idiom).
  // Bare class without a code is skipped — too noisy; intent-based path catches those.
  const BARE_CODED_RE = /\b(Error|Exception|Panic)\s*\[([A-Z_][A-Z0-9_]*)\]\s*:\s*([^\n]{3,200})/;
  const m = text.match(TYPED_RE) || text.match(BARE_CODED_RE);
  if (!m) return null;
  const className = m[1];
  const errorCode = m[2] || null;
  const message = m[3]
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[`'"]+$/, '');
  const sigMsg = message.slice(0, 80);
  const signature = errorCode ? `${className} ${errorCode} ${sigMsg}` : `${className} ${sigMsg}`;
  return { className, errorCode, message, signature };
}

// ─── Result Dedup ───────────────────────────────────────────────────────────

export const MAX_SESSION_INJECTIONS = 15;
export const DEDUP_STALE_MS = 300_000; // 5 minutes
// Marker file-name derivation lives in lib/injected-ids.mjs (D#120) — lib/, not
// here, so hook.mjs can import it (scripts/ static imports from hook.mjs break
// under the installExtractedRelease scripts-dir rename).

/**
 * Check if injection should be skipped based on deduplication state.
 * @param {number[]} newIds - candidate observation IDs
 * @param {string} injectedFile - path to the dedup state file
 * @param {string} [sessionId] - CC session id; a payload written by a DIFFERENT
 *   session never suppresses (M-6, audit 2026-08-14: the file is keyed by project,
 *   so session A's injections + count cap silently carried into session B)
 * @returns {boolean} true if injection should be skipped
 */
export function shouldSkipByDedup(newIds, injectedFile, sessionId) {
  if (!newIds || newIds.length === 0) return true;
  try {
    const raw = readFileSync(injectedFile, 'utf8');
    const { ids: prevIds, ts, count = 0, session } = JSON.parse(raw);
    if (session && sessionId && session !== sessionId) return false;
    if (count >= MAX_SESSION_INJECTIONS) return true;
    if (!ts || Date.now() - ts > DEDUP_STALE_MS) return false;
    if (!Array.isArray(prevIds) || prevIds.length === 0) return false;
    // Normalize both sides to strings before comparing: UPS writes obs ids as numbers
    // (rows.map(r => r.id)) while pre-tool-recall's mergeCrossHookInjected writes them as
    // strings (.map(String)), and both hooks SHARE this file. Without normalization
    // Set.has(8829) misses "8829" → cross-hook dedup never fires and the same lesson
    // double-injects within the window. (pre-tool-recall's readCrossHookInjected already
    // String-normalizes; this brings the UPS-side reader in line.)
    const prevSet = new Set(prevIds.map(String));
    const overlapCount = newIds.filter((id) => prevSet.has(String(id))).length;
    return overlapCount / newIds.length >= 0.8;
  } catch {
    return false;
  }
}

// ─── Registry Skill Name Matching ───────────────────────────────────────────

/**
 * Check if prompt text contains a known managed skill name.
 * Returns the matched name or null.
 * @param {string} text - user prompt
 * @param {Set<string>} skillNames - set of known managed skill names (lowercase)
 * @returns {string|null}
 */
export function matchRegistrySkillName(text, skillNames) {
  if (!text || skillNames.size === 0) return null;
  const lower = text.toLowerCase();

  // Sort names longest-first to match "code-review-expert" before "code-review"
  const sorted = [...skillNames].sort((a, b) => b.length - a.length);

  for (const name of sorted) {
    const idx = lower.indexOf(name);
    if (idx === -1) continue;

    // Check word boundaries: char before and after must be non-alphanumeric (or start/end)
    const before = idx === 0 ? ' ' : lower[idx - 1];
    const after = idx + name.length >= lower.length ? ' ' : lower[idx + name.length];
    if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;

    return name;
  }
  return null;
}

// ─── File Path Detection ─────────────────────────────────────────────────────

/** Detect file paths in text — excludes URLs and pure version numbers */
export function extractFiles(text) {
  const matches = text.match(/[\w./-]+\.\w{1,10}/g) || [];
  return matches.filter(
    (m) => m.includes('.') && !m.startsWith('http') && !m.includes('//') && !/^\d+\.\d+$/.test(m), // Exclude pure version numbers like "3.14" (not paths like "1.0/config.json")
  );
}

// ─── Deferred-work references (D#N) ──────────────────────────────────────────

// Cap injected deferred items per prompt — a batch approval ("D#1 D#2 D#3 全部
// 批准") gets the first three; more would blow the injection noise budget.
export const MAX_DEFERRED_REFS = 3;

/**
 * Extract deferred_work ids the prompt explicitly references as D#N (case-
 * insensitive). Requires the `#` — bare "D92" is prose (chip names, model
 * numbers), not a token. Deduped, input order, capped at MAX_DEFERRED_REFS.
 * @param {string} text
 * @returns {number[]}
 */
export function extractDeferredRefs(text) {
  const out = [];
  const re = /\bD#(\d+)\b/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const id = parseInt(m[1], 10);
    if (id > 0 && !out.includes(id)) {
      out.push(id);
      if (out.length >= MAX_DEFERRED_REFS) break;
    }
  }
  return out;
}
