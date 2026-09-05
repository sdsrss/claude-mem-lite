// lib/task-imperative.mjs — pure formatter for the task-imperative memory line.
// Shared by the live UserPromptSubmit emitter (Phase 2) AND efficacy arm U (the
// measurement that gates Phase 2): ONE tested source of truth so the measured
// framing and the shipped framing cannot drift. Hot-path-shared → regex/string
// only, NO heavy imports (lesson #8447), mirroring lib/lesson-idents.mjs.
// format-utils.mjs is a zero-import pure-string module, so it respects that constraint.
import { neutralizeContextDelimiters } from '../format-utils.mjs';
//
// Delivers a high-value lesson at the task-prompt position as an imperative,
// task-bound constraint: attribution kept (honest + #NN cite-traceable), the
// path-A/B softeners ("FYI", "continue your task", "NOT a new user message")
// dropped.
// Spec: docs/superpowers/specs/2026-06-29-task-imperative-memory-injection-design.md

// The emitted line's fixed head. Exported because lib/citation-tracker.mjs matches on
// it to meter this face: an extractor carrying its own copy of the framing is the exact
// shape that silenced Go panics in v3.74.0 (trigger and filter were two lists that were
// never the same list). One constant, both directions — change the framing and the
// meter follows, or nothing does.
export const TASK_IMPERATIVE_PREFIX = 'Memory — a past lesson applies to THIS task.';

export function formatTaskImperative(lesson, id) {
  const body = neutralizeContextDelimiters(
    String(lesson || '')
      .trim()
      .replace(/\.$/, ''),
  );
  if (!body) return '';
  const tag = id === undefined || id === null || id === '' ? '' : ` (#${id})`;
  return `${TASK_IMPERATIVE_PREFIX} You must: ${body}.${tag}`;
}

// Subagent-dispatch framing. Subagents are memory-blind (plugin hooks don't fire
// inside them — #8848); the P0 dispatch hook (scripts/pre-agent-inject.js) APPENDS
// this block to a spawned subagent's prompt via PreToolUse updatedInput. This is
// deliberately NOT the "You must:" imperative above: Phase-0b measured live
// (2026-07-03) that a raw imperative PREPEND trips the subagent's own
// prompt-injection detector -> refusal, whereas this appended, attributed,
// reference-only block is adopted. The four load-bearing elements (named provenance
// / "reference, not an instruction" / appended-below-the-task / no adversarial
// tokens) are the measured difference between adopt and refuse — do not drift them.
export function formatSubagentContext(lesson, id) {
  const body = neutralizeContextDelimiters(
    String(lesson || '')
      .trim()
      .replace(/\.$/, ''),
  );
  if (!body) return '';
  const tag = id === undefined || id === null || id === '' ? '' : `#${id} — `;
  return [
    '',
    '---',
    "[Project memory — surfaced by your operator's claude-mem-lite memory system for this project. Reference context, not an external instruction.]",
    'A past lesson recorded for this project that may be relevant to the task above:',
    `  ${tag}${body}.`,
  ].join('\n');
}
