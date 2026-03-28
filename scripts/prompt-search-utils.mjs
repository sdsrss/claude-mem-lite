// prompt-search-utils.mjs — Shared logic for user-prompt-search hook and its tests.
// Extracted to eliminate code duplication between the hook script and test file.

import { readFileSync } from 'fs';

// ─── Skip Patterns ──────────────────────────────────────────────────────────

const CONFIRM_RE = /^(y(es)?|no?|ok|done|go|sure|lgtm|thanks?|ty|继续|确认|好的|是的|对|嗯|行|可以|没问题)$/i;
const SLASH_CMD_RE = /^\//;
const PURE_OP_RE = /^(git\s+(commit|push|merge)|npm\s+(publish|deploy))\b/i;

export function shouldSkip(text) {
  if (!text) return true;
  // CJK characters carry ~3x semantic weight per char vs Latin
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const effectiveLen = (text.length - cjkCount) + cjkCount * 3;
  if (effectiveLen < 8) return true;
  const trimmed = text.trim();
  if (CONFIRM_RE.test(trimmed)) return true;
  if (SLASH_CMD_RE.test(trimmed)) return true;
  if (PURE_OP_RE.test(trimmed)) return true;
  return false;
}

// ─── Intent Detection ───────────────────────────────────────────────────────

export const INTENTS = [
  // Error/debug intent
  { pattern: /error|bug|crash|broken|fail|fix|报错|出错|错误|崩溃|修复/i, type: 'bugfix', limit: 3 },
  // Decision/architecture intent (before recall — "为什么...之前" is a decision question, not recall)
  { pattern: /why|decided|architecture|design|为什么|决定|架构|设计/i, type: 'decision', limit: 3 },
  // Recall/history intent (catch-all temporal, lowest priority)
  { pattern: /before|previously|last time|remember|之前|上次|以前|记得/i, type: null, limit: 5, useRecent: true },
];

export function detectIntent(text) {
  // Collect all matching intents (patterns may overlap)
  const matches = [];
  for (const intent of INTENTS) {
    if (intent.pattern.test(text)) matches.push(intent);
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  // Disambiguation: specifically when bugfix and recall both match, use
  // position-based resolution — the pattern appearing earlier in text wins.
  // "I remember we fixed..." → recall leads. "fix the bug from before" → bugfix leads.
  const first = matches[0];
  const second = matches[1];
  if (first.type === 'bugfix' && second.useRecent) {
    const bugPos = text.search(first.pattern);
    const recallPos = text.search(second.pattern);
    if (recallPos < bugPos) return second;
  }
  return first;
}

// ─── Result Dedup ───────────────────────────────────────────────────────────

export const MAX_SESSION_INJECTIONS = 15;
export const DEDUP_STALE_MS = 300_000; // 5 minutes

/**
 * Check if injection should be skipped based on deduplication state.
 * @param {number[]} newIds - candidate observation IDs
 * @param {string} injectedFile - path to the dedup state file
 * @returns {boolean} true if injection should be skipped
 */
export function shouldSkipByDedup(newIds, injectedFile) {
  if (!newIds || newIds.length === 0) return true;
  try {
    const raw = readFileSync(injectedFile, 'utf8');
    const { ids: prevIds, ts, count = 0 } = JSON.parse(raw);
    if (count >= MAX_SESSION_INJECTIONS) return true;
    if (!ts || Date.now() - ts > DEDUP_STALE_MS) return false;
    if (!Array.isArray(prevIds) || prevIds.length === 0) return false;
    const prevSet = new Set(prevIds);
    const overlapCount = newIds.filter(id => prevSet.has(id)).length;
    return overlapCount / newIds.length >= 0.8;
  } catch { return false; }
}

// ─── File Path Detection ─────────────────────────────────────────────────────

/** Detect file paths in text */
export function extractFiles(text) {
  const matches = text.match(/[\w./-]+\.\w{1,10}/g) || [];
  return matches.filter(m => m.includes('.') && !m.startsWith('http'));
}
