// lib/ups-query.mjs — the ONE query-cap definition for the UserPromptSubmit event.
//
// That event fires two hooks: scripts/user-prompt-search.js (the FYI block) and
// `hook.mjs user-prompt` (the <memory-context> block). v3.75.0 capped the first and left
// the second building an uncapped query from the raw prompt — the guard-on-one-path shape
// this codebase pays for more than any other. Both faces now import from here, so the cap
// cannot be present on one and absent on the other.
//
// The caps bound what is COMPUTED, not what is read. The stdin guards upstream
// (MAX_UPS_PROMPT_BYTES 64KB on path A, MAX_HOOK_STDIN_BYTES 256KB on path B) cap the
// input; sanitizeFtsQuery still costs 0.8ms on a normal prompt, 6.2ms on a 64KB ASCII one
// and 31.8ms on a 64KB CJK one (extractCjkKeywords is O(len x dict) over an unsegmented
// run), all of it before the model sees the turn. 2000 characters is a long prompt by any
// measure, and past ~64 meaningful AND-joined terms an FTS5 query matches nothing anyway
// and survives only through the OR fallback.
//
// An explicit `claude-mem-lite search` stays UNCAPPED — a person who types a long query
// meant it. Only these two automatic surfaces pass the caps.
import { sanitizeFtsQuery } from '../utils.mjs';

export const UPS_QUERY_CAPS = { maxChars: 2000, maxTokens: 64 };

/** The capped query builder every automatic prompt-time search path goes through. */
export function upsFtsQuery(text) {
  return sanitizeFtsQuery(text, UPS_QUERY_CAPS);
}

/**
 * The same text the query was built from — for anything that has to reason about the
 * query's TERMS rather than run the query.
 *
 * Audit A1 (2026-09-08): hook-memory.mjs's term-coverage filter re-derived its denominator
 * from the raw prompt while the MATCH expression came from upsFtsQuery. Terms past
 * maxChars were never searched, so no matched row could cover them and the coverage ratio
 * fell as the prompt grew — past ~4000 characters no candidate cleared the 0.4 floor and
 * the whole <memory-context> surface returned nothing, silently, on any prompt carrying a
 * pasted diff or log. It also put the uncapped extractCjkKeywords back on the hot path the
 * cap above exists to keep off it (43.9x the capped builder on a 256KB CJK prompt).
 *
 * This is deliberately the TEXT and not a token list: the two faces tokenize differently
 * (sanitizeFtsQuery vs tokenizeHandoff + extractCjkKeywords), so a shared token list would
 * mean unifying two tokenizers, which is a larger change than the defect warrants. Sharing
 * the cut point removes the length dependence — the coverage ceiling becomes a constant of
 * the two tokenizers (~0.64 in the audit's measurement, comfortably above the 0.4 floor)
 * instead of a function of prompt size. Do NOT re-spell `.slice(0, 2000)` at a call site;
 * that is the copied-cap shape this module's header exists to prevent.
 */
export function upsCappedText(text) {
  return typeof text === 'string' ? text.slice(0, UPS_QUERY_CAPS.maxChars) : text;
}
