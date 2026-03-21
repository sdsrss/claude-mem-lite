// claude-mem-lite CLAUDE.md context injection and token budgeting
// Handles adaptive time windows, token-budgeted selection, and CLAUDE.md persistence

import { join } from 'path';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { estimateTokens, truncate, debugLog, debugCatch, DECAY_HALF_LIFE_BY_TYPE, DEFAULT_DECAY_HALF_LIFE_MS } from './utils.mjs';

/**
 * Infer the project directory from environment variables or cwd.
 * @returns {string} Absolute path to the project directory
 */
function inferProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
}

/**
 * Compute adaptive recall time windows based on project activity velocity.
 * High activity -> shorter windows (recent data more relevant).
 * Low activity -> longer windows (older data stays relevant).
 * @param {object} db better-sqlite3 database handle
 * @param {string} project Project name to check velocity for
 * @returns {{tier1: number, tier2: number, tier3: number, sessWindow: number}} Time window durations in ms
 */
export function computeAdaptiveWindows(db, project) {
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM observations
    WHERE project = ? AND created_at_epoch > ? AND COALESCE(compressed_into, 0) = 0
  `).get(project, sevenDaysAgo);
  const velocity = (row?.c || 0) / 7; // observations per day

  if (velocity > 10) {
    // High velocity: tighter windows, focus on very recent
    return { tier1: 12 * 3600000, tier2: 3 * 86400000, tier3: 14 * 86400000, sessWindow: 3 * 86400000 };
  } else if (velocity >= 3) {
    // Medium velocity: default windows
    return { tier1: 24 * 3600000, tier2: 7 * 86400000, tier3: 30 * 86400000, sessWindow: 7 * 86400000 };
  } else {
    // Low velocity: wider windows, older data still relevant
    return { tier1: 48 * 3600000, tier2: 14 * 86400000, tier3: 60 * 86400000, sessWindow: 14 * 86400000 };
  }
}

/**
 * Select observations and sessions within a token budget using greedy knapsack.
 * Scores candidates by recency * importance, picks highest value-density first.
 * @param {object} db better-sqlite3 database handle
 * @param {string} project Project name
 * @param {number} [budget=2000] Maximum token budget
 * @returns {{observations: object[], summaries: object[], totalTokens: number}} Selected items
 */
export function selectWithTokenBudget(db, project, budget = 2000) {
  const now_ms = Date.now();
  const windows = computeAdaptiveWindows(db, project);
  const tier1Ago = now_ms - windows.tier1;
  const tier2Ago = now_ms - windows.tier2;
  const tier3Ago = now_ms - windows.tier3;

  // Candidate pool: tiered time windows by importance (adaptive)
  const obsPool = db.prepare(`
    SELECT id, type, title, narrative, importance, created_at_epoch, files_modified, lesson_learned
    FROM observations
    WHERE project = ? AND COALESCE(compressed_into, 0) = 0
      AND (
        (created_at_epoch > ? AND importance >= 1)
        OR (created_at_epoch > ? AND importance >= 2)
        OR (created_at_epoch > ? AND importance >= 3)
      )
    ORDER BY created_at_epoch DESC
    LIMIT 50
  `).all(project, tier1Ago, tier2Ago, tier3Ago);

  const sessPool = db.prepare(`
    SELECT id, request, completed, next_steps, created_at_epoch
    FROM session_summaries
    WHERE project = ? AND created_at_epoch > ?
    ORDER BY created_at_epoch DESC
    LIMIT 10
  `).all(project, now_ms - windows.sessWindow);

  const selectedObs = [];
  const selectedSess = [];
  let totalTokens = 0;

  // Score each candidate: value = recency * importance, cost = tokens
  // Recency uses exponential half-life (consistent with server.mjs BM25 scoring)
  const scoredObs = obsPool.map(o => {
    const halfLifeMs = DECAY_HALF_LIFE_BY_TYPE[o.type] || DEFAULT_DECAY_HALF_LIFE_MS;
    const recency = 1.0 + Math.exp(-0.693 * (now_ms - o.created_at_epoch) / halfLifeMs);
    const impBoost = 0.5 + 0.5 * (o.importance || 1);
    const lessonBoost = o.lesson_learned ? 1.3 : 1.0;
    const value = recency * impBoost * lessonBoost;
    const cost = estimateTokens((o.title || '') + (o.narrative || ''));
    return { ...o, value, cost, valueDensity: cost > 0 ? value / Math.sqrt(cost) : 0 };
  });

  const scoredSess = sessPool.map(s => {
    const recency = 1.0 + Math.exp(-0.693 * (now_ms - s.created_at_epoch) / DEFAULT_DECAY_HALF_LIFE_MS);
    const value = recency * 1.5; // Session summaries slightly boosted
    const cost = estimateTokens((s.request || '') + (s.completed || '') + (s.next_steps || ''));
    return { ...s, value, cost, valueDensity: cost > 0 ? value / Math.sqrt(cost) : 0 };
  });

  // Combine and sort by value density (greedy knapsack)
  const allCandidates = [
    ...scoredObs.map(o => ({ ...o, _kind: 'obs' })),
    ...scoredSess.map(s => ({ ...s, _kind: 'sess' })),
  ].sort((a, b) => b.valueDensity - a.valueDensity);

  const selectedFiles = new Set();
  const selectedTypes = new Map(); // type → count for diversity constraint

  for (const c of allCandidates) {
    if (totalTokens + c.cost > budget) continue;

    // Type diversity: max 3 observations of same type (checked first to avoid file set pollution)
    if (c._kind === 'obs' && c.type) {
      const typeCount = selectedTypes.get(c.type) || 0;
      if (typeCount >= 3) continue;
    }

    // Diversity penalty: reduce value for file overlap with already-selected
    if (c._kind === 'obs' && c.files_modified) {
      let cFiles;
      try { cFiles = JSON.parse(c.files_modified || '[]'); } catch (e) { debugCatch(e, 'budgetSelect-parseFiles'); cFiles = []; }
      if (cFiles.length > 0 && selectedFiles.size > 0) {
        const overlap = cFiles.filter(f => selectedFiles.has(f)).length;
        const overlapRatio = overlap / cFiles.length;
        const penalizedValue = c.valueDensity * (1 - 0.3 * overlapRatio);
        if (penalizedValue < 0.001) continue;
      }
      for (const f of cFiles) selectedFiles.add(f);
    }

    // Commit type diversity counter after both gates pass
    if (c._kind === 'obs' && c.type) {
      selectedTypes.set(c.type, (selectedTypes.get(c.type) || 0) + 1);
    }

    totalTokens += c.cost;
    if (c._kind === 'obs') {
      selectedObs.push({ id: c.id, type: c.type, title: c.title, created_at: new Date(c.created_at_epoch).toISOString() });
    } else {
      selectedSess.push({ id: c.id, request: c.request, completed: c.completed, next_steps: c.next_steps, created_at: new Date(c.created_at_epoch).toISOString() });
    }
  }

  return { observations: selectedObs, summaries: selectedSess, totalTokens };
}

/**
 * Update the project's CLAUDE.md file with a context block.
 * Replaces existing <claude-mem-context> section or appends a new one.
 * Uses atomic tmp+rename write to prevent partial writes.
 * @param {string} contextBlock Markdown content to inject
 */
export function updateClaudeMd(contextBlock) {
  const claudeMdPath = join(inferProjectDir(), 'CLAUDE.md');
  let content = '';
  try { content = readFileSync(claudeMdPath, 'utf8'); } catch {}

  const startTag = '<claude-mem-context>';
  const endTag = '</claude-mem-context>';
  const hintComment = '<!-- claude-mem-lite: auto-updated context. To avoid git noise, add CLAUDE.md to .gitignore -->';
  const newSection = `${startTag}\n${contextBlock}\n${endTag}`;

  // Use lastIndexOf for both tags — prevents matching documentation references
  // to <claude-mem-context> that appear in code/markdown before the actual context block
  const startIdx = content.lastIndexOf(startTag);
  const endIdx = content.lastIndexOf(endTag);

  if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
    // Skip write if content is unchanged — reduces git noise
    const existingSection = content.slice(startIdx, endIdx + endTag.length);
    if (existingSection === newSection) return;
    // Replace from first start to last end — collapses any duplicate sections into one
    content = content.slice(0, startIdx) + newSection + content.slice(endIdx + endTag.length);
  } else if (content.length > 0) {
    // Append to end — never disturb existing CLAUDE.md structure
    const hint = content.includes(hintComment) ? '' : hintComment + '\n';
    content = content.trimEnd() + '\n\n' + hint + newSection + '\n';
  } else {
    content = hintComment + '\n' + newSection + '\n';
  }

  const tmp = claudeMdPath + '.mem-tmp';
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, claudeMdPath);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    debugLog('ERROR', 'updateClaudeMd', `CLAUDE.md write failed: ${e.message}`);
  }
}

/**
 * Build summary lines from a latestSummary row.
 * Extracted for testability — used by handleSessionStart.
 * @param {object} latestSummary Row from session_summaries with request, completed, etc.
 * @returns {string[]} Lines to include in context output
 */
export function buildSummaryLines(latestSummary) {
  const lines = [];
  if (!latestSummary) return lines;

  lines.push('### Last Session');
  if (latestSummary.request) lines.push(`Request: ${truncate(latestSummary.request, 120)}`);
  if (latestSummary.completed) lines.push(`Completed: ${truncate(latestSummary.completed, 120)}`);
  if (latestSummary.remaining_items) lines.push(`Remaining: ${truncate(latestSummary.remaining_items, 120)}`);
  if (latestSummary.next_steps) lines.push(`Next: ${truncate(latestSummary.next_steps, 120)}`);
  if (latestSummary.lessons) {
    try {
      const lessons = JSON.parse(latestSummary.lessons);
      if (lessons.length > 0) lines.push(`Lessons: ${lessons.slice(0, 3).join('; ')}`);
    } catch {}
  }
  if (latestSummary.key_decisions) {
    try {
      const decisions = JSON.parse(latestSummary.key_decisions);
      if (decisions.length > 0) lines.push(`Decisions: ${decisions.slice(0, 3).join('; ')}`);
    } catch {}
  }
  lines.push('');
  return lines;
}
