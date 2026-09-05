// Unpersisted-decision reminder — G3 (roadmap 2026-07-18).
//
// The write-side other half of the D#92 incident: that deferred item was
// recoverable only because the originating session VOLUNTARILY wrote a defer
// detail. When a session finalizes something in conversation (定稿/拍板/
// approved/…) and makes no deliberate persistence call, /clear loses it —
// tasks/ and docs/ are gitignored local files with no cross-session search
// face. This module detects the shape at Stop; the payload rides
// cite-recall-<project>.json and the NEXT SessionStart surfaces ONE reminder
// line (that is the moment recovery is actionable — the handoff still carries
// the context). Remind-only by design: false positives cost one line, so the
// signal list stays conservative and never auto-writes anything.

import { readTranscriptEntries } from './transcript-scan.mjs';

// Distinctive finalization word forms (CJK + EN). Deliberately NOT included:
// "方案 A 定" and bare "定" (too FP-prone), bare "ok/好" (noise). The list is
// remind-only, so precision beats recall here.
const FINALIZATION_FORMS = ['定稿', '拍板', '敲定', '批准', '采纳'];
const FINALIZATION_EN_RE = /\bapproved?\b|\bsign(?:ed)?[\s-]?off\b|\bfinali[sz]ed?\b|writing-plans/i;

/**
 * Scan user prompts for a finalization signal.
 * @param {string[]} prompts
 * @returns {string|null} the matched form (for quoting in the reminder), or null
 */
export function detectFinalization(prompts) {
  for (const p of prompts || []) {
    if (typeof p !== 'string' || !p) continue;
    for (const form of FINALIZATION_FORMS) {
      if (p.includes(form)) return form;
    }
    const m = p.match(FINALIZATION_EN_RE);
    if (m) return m[0];
  }
  return null;
}

// Deliberate-persistence calls, transcript-side. Mirrors the tool-name/idiom
// sets in lib/cite-back-hint.mjs (countUnsavedBugfixShape) but counts ANY
// mem_save/mem_defer — a decision can legitimately land as any type.
const PERSIST_TOOL_NAMES = new Set([
  'mem_save',
  'mem_defer',
  'mcp__claude_mem_lite__mem_save',
  'mcp__claude_mem_lite__mem_defer',
  'mcp__plugin_claude-mem-lite_mem-lite__mem_save',
  'mcp__plugin_claude-mem-lite_mem-lite__mem_defer',
]);
const PERSIST_CLI_RE = /(?:cli\.mjs|claude-mem-lite)['"]?\s+(?:save\b|defer\s+add\b)/;
// G18: Skill-path persistence. /lesson /memory /bug land observations (or memdir
// files) just as deliberately as mem_save — without these, a session that
// finalized AND persisted via a skill still got the reminder (false positive).
// Skill values may be plugin-qualified ('claude-mem-lite:lesson') or bare.
const PERSIST_SKILL_RE = /(?:^|:)(?:lesson|memory|bug)$/;
// G18: memory-dir writes (~/.claude/projects/<slug>/memory/*.md, incl. MEMORY.md
// index updates) are the durable-layer persistence path for decisions.
const MEMDIR_WRITE_RE = /[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory[\\/][^\\/]+\.md$/;

/**
 * Count deliberate persistence calls (mem_save / mem_defer tool_use, CLI
 * `save` / `defer add`) in the session transcript. 0 on missing/unreadable.
 */
export function countDeliberatePersistence(transcriptPath) {
  // Shares the Stop-time parse (lib/transcript-scan.mjs) rather than doing its own
  // read+split+parse. It was the NINTH scanner of the same file and was missed when the
  // other eight were collapsed — sitting two lines away from two that were migrated, so
  // it was quietly charging a full re-parse (~20-25ms on a 5.7MB transcript) against a
  // pass whose whole point was to stop doing that. Missing/unreadable paths still yield
  // 0, because readTranscriptEntries returns [] for them.
  let count = 0;
  for (const entry of readTranscriptEntries(transcriptPath)) {
    if (entry.type !== 'assistant' && entry.message?.role !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      if (PERSIST_TOOL_NAMES.has(block.name)) {
        count++;
        continue;
      }
      if (block.name === 'Bash' && PERSIST_CLI_RE.test(block.input?.command || '')) {
        count++;
        continue;
      }
      if (block.name === 'Skill' && PERSIST_SKILL_RE.test(block.input?.skill || '')) {
        count++;
        continue;
      }
      if (
        (block.name === 'Write' || block.name === 'Edit') &&
        MEMDIR_WRITE_RE.test(block.input?.file_path || '')
      )
        count++;
    }
  }
  return count;
}

/**
 * The G3 gate: finalization signal present AND zero deliberate persistence.
 * @returns {{fire: boolean, signal: string|null}}
 */
export function detectUnpersistedDecision({ prompts, transcriptPath }) {
  const signal = detectFinalization(prompts);
  if (!signal) return { fire: false, signal: null };
  if (countDeliberatePersistence(transcriptPath) > 0) return { fire: false, signal };
  return { fire: true, signal };
}
