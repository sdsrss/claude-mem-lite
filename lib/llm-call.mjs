// lib/llm-call.mjs — the provider-routed background LLM call (Anthropic API →
// OpenRouter → claude CLI).
//
// It lived in `hook-shared.mjs`, which is the hook layer's own module: it imports
// schema, memdir, claudemd, adopt-content and haiku-client, so `lib/lesson-bridge.mjs`
// pulling `callLLM` from there loaded the whole hook constellation for one function,
// and the "lib/ does not depend on the hook layer" guard had to carve out an exception
// by name (audit 2026-09-05 P1-2, carried from 2026-09-02 P2-9). Nothing about the call
// is hook-specific — it is a leaf over haiku-client — so this is where it belongs.
// `hook-shared.mjs` re-exports both names, so every existing caller is unchanged.

import { execClaudeCliSync, resolveModel, flattenForCLI, detectMode, callHaiku, BG_LLM_TIMEOUT_MS } from '../haiku-client.mjs';
import { debugCatch } from '../utils.mjs';

// Accepts either a plain string (legacy) or {system, user} (defense-in-depth
// against prompt injection from poisoned user_prompts content — cso F#4 fix).
// Provider priority mirrors haiku-client (ANTHROPIC_API_KEY > OPENROUTER_API_KEY
// > CLI): when a key is present, delegate to callHaiku — it owns the Anthropic
// Messages / OpenRouter chat-completions request shapes, uses the system role
// natively, AND degrades to the `claude -p` CLI internally if the keyed provider
// fails (so a region-blocked / out-of-credit key still yields a summary). The
// keyless case shells out to `claude -p` directly here, where flattenForCLI
// renders {system, user} with an explicit data-boundary marker. Returns the raw
// response string (callers run parseJsonFromLLM themselves) or null.
// maxTokens is sized for session-summary / episode JSON (larger than the
// registry/optimize callers' budgets).
export async function callLLM(prompt, timeoutMs = BG_LLM_TIMEOUT_MS) {
  if (detectMode() !== 'cli') {
    const result = await callHaiku(prompt, { timeout: timeoutMs, maxTokens: 2000 });
    return result?.text ?? null;
  }

  const { cli: modelName } = resolveModel();
  try {
    // Shared runner with haiku-client.mjs#callModelCLI (rationale there): no
    // transcript persistence, no claudemd hook fan-out, and the one-shot
    // retry-without-flag that keeps this leg alive on an older Claude Code CLI.
    const result = execClaudeCliSync(modelName, { input: flattenForCLI(prompt), timeout: timeoutMs });
    return result.trim();
  } catch (e) {
    const out = extractResponseFromError(e);
    if (out) return out;
    debugCatch(e, 'callLLM');
    return null;
  }
}

/**
 * Extract partial response from CLI error output (timeout/error recovery).
 * Module-local: it was exported (and re-exported from hook-shared) with zero
 * importers anywhere in the tree, so it was one of the knip baseline's dead
 * names — audited and dropped rather than carried through the move.
 * @param {Error} error The caught error from execFileSync
 * @returns {string|null} Extracted JSON string or null
 */
function extractResponseFromError(error) {
  const out = error.stdout?.toString?.()?.trim() || error.output?.[1]?.toString?.()?.trim() || '';
  if (out && out.startsWith('{') && out.endsWith('}')) {
    try {
      const parsed = JSON.parse(out);
      // Reject structurally incomplete responses (e.g. truncated mid-output)
      if (typeof parsed !== 'object' || parsed === null || Object.keys(parsed).length === 0) return null;
      return out;
    } catch { return null; }
  }
  return null;
}
