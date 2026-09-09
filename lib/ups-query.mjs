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
import { sanitizeFtsQuery, ftsQueryTokens } from '../utils.mjs';

export const UPS_QUERY_CAPS = { maxChars: 2000, maxTokens: 64 };

/** The capped query builder every automatic prompt-time search path goes through. */
export function upsFtsQuery(text) {
  return sanitizeFtsQuery(text, UPS_QUERY_CAPS);
}

/**
 * The terms the automatic prompt-time query was ACTUALLY built from — one source, not two.
 *
 * `sanitizeFtsQuery` cleans, drops stop words, caps at `maxTokens`, and CJK-segments before
 * it expands synonyms; `ftsQueryTokens` returns exactly that list under the same caps. A
 * coverage ratio measured against anything else is measuring terms that were never
 * searched, which is what made the ceiling a function of prompt length in both directions:
 * past maxChars (fixed by sharing the cut) and past maxTokens (fixed here).
 */
export function upsQueryTerms(text) {
  return ftsQueryTokens(text, UPS_QUERY_CAPS).tokens.map((t) => String(t).toLowerCase());
}
