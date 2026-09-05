// lib/lesson-bridge.mjs — pure prompt builder + fail-open Haiku bridge for the
// comprehension-bridge forcing-function (CLAUDE_MEM_SALIENCE=bridge). Loaded by
// scripts/pre-tool-recall.js via dynamic import ONLY when the flag is on, so the
// fast hook never pulls the LLM stack by default (lesson #8447).
import { callLLM } from './llm-call.mjs';

const LESSON_MAX = 600;   // chars — a lesson_learned fits well under this
const HUNK_MAX = 1200;    // chars — the change region; bounds Haiku input cost
const CHECK_MAX = 200;    // chars — bounded injected payload

export function buildBridgePrompt(lesson, hunk) {
  const l = String(lesson || '').slice(0, LESSON_MAX);
  const h = String(hunk || '').slice(0, HUNK_MAX);
  return [
    'A past lesson and the code change about to be made are below.',
    'In ONE line, state the single concrete check the lesson forces on THIS change,',
    'naming the actual symbol involved. If the lesson cannot apply, output exactly: N/A',
    'Be specific. No preamble, no markdown.',
    '',
    `LESSON: ${l}`,
    '',
    'CHANGE:',
    h,
  ].join('\n');
}

// { ok:true, check } when the bridge produced a usable, applicable check;
// { ok:false } on N/A / empty / error / timeout. NEVER throws — the caller
// falls back to the baseline ACK_DIRECTIVE on { ok:false }.
export async function bridgeLesson({ lesson, hunk, timeoutMs = 2500, _callLLM = callLLM }) {
  try {
    const raw = await _callLLM(buildBridgePrompt(lesson, hunk), timeoutMs);
    const line = String(raw || '').trim().split('\n')[0].trim();
    if (!line || /^n\s*\/?\s*a$/i.test(line)) return { ok: false };
    return { ok: true, check: line.slice(0, CHECK_MAX) };
  } catch {
    return { ok: false };
  }
}
