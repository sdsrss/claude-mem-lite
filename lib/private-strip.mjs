// claude-mem-lite: Strip <private>...</private> blocks from user-supplied text
// before any persistence or downstream processing.
//
// Use case: user wraps sensitive content (test fixtures, internal IDs, draft
// secrets that scrubSecrets misses) in <private>X</private> to opt out of
// memory capture. Replaces each well-formed pair with [redacted] to preserve
// surrounding grammar and FTS bigram boundaries.
//
// Mirrors thedotmack/claude-mem v13's <private> primitive (referenced in
// observation #8252 follow-up scope) — same syntax for cross-tool familiarity.
//
// FAILS CLOSED (D13, 2026-09-29 — this used to say "Intentionally does NOT strip" an
// open-without-close, because "the user may still be typing"). Every caller strips SUBMITTED
// text — a prompt, a tool response, an import — so nothing is mid-typing, and the fail-open
// kept `<private>my secret` (no close) in the DB, the background LLM input and later
// injections, while the episode-description path already cut at an unclosed opener. Now:
//   - an opener with no close redacts to the END of the text;
//   - blocks pair by DEPTH, so `<private>a<private>b</private>c</private>` redacts whole
//     (the old leftmost-then-lazy pairing let `c` through);
//   - the tags take attributes / whitespace (`<private reason="pii">`, `</private >`);
//     `<private/>` and `<privatex>` are still not tags;
//   - a stray `</private>` with no opener stays, as before (nothing private follows it).
//
// Case-insensitive on the tag (`<PRIVATE>`, `<Private>` all work) since users
// type by hand.

// Tag scanner, NOT a block matcher. The block form this replaced —
// /<private>([\s\S]*?)<\/private>/gi — is quadratic on opener-dense input: every one of
// N openers costs the engine a lazy `[\s\S]*?` walk to the end of the string looking for
// a close that is not there. Measured before the rewrite: 20k unclosed openers (180KB)
// 545ms, 28k (252KB — the PostToolUse/UserPromptSubmit stdin cap) 891ms, against 0.6ms
// for 1MB of plain text. stripPrivate is the FIRST step of every scrubSecrets() call and
// sits on the synchronous UserPromptSubmit path, so that is per-prompt latency the model
// waits on; lib/import-jsonl.mjs feeds it user files with no cap at all.
//
// "Return early when there is no close tag" does not fix it: `'</private>' + N openers`
// has a close and still costs 456ms. The alternation below has no quantifier to back off
// into, so the scan is linear in the input regardless of tag density.
//
// The attribute run stops at `<` as well as `>`. With `[^>]*` each `<private ` that never
// closes (`'<private '.repeat(n)`) scanned to the END of the input for its `>`: 252KB took
// 2.5s (v6.21.0 pre-tag review). Stopping at the next `<` bounds each attempt by the gap to
// the next tag. The cost is that an attribute value containing `<` is not a tag.
const PRIVATE_TAG_RE = /<(\/?)private(?:\s[^<>]*)?>/gi;
export const REDACTION_MARKER = '[redacted]';

/**
 * Replace each <private>…</private> region with [redacted], failing closed (see header).
 * Returns the input unchanged when it holds no opener.
 *
 * @param {unknown} text Input string (non-string passes through)
 * @returns {string|unknown} Stripped text, or input unchanged if not a string
 */
export function stripPrivate(text) {
  if (typeof text !== 'string') return text;
  if (!text.includes('<')) return text; // fast path — most prompts have no tags

  PRIVATE_TAG_RE.lastIndex = 0;
  let out = null; // stays null until the first replacement — no-op inputs return as-is
  let cursor = 0; // end of the last emitted span
  let openAt = -1; // index of the outermost opener of the region being scanned
  let depth = 0;
  let m;
  while ((m = PRIVATE_TAG_RE.exec(text)) !== null) {
    if (m[1] !== '/') {
      if (depth === 0) openAt = m.index;
      depth++;
    } else if (depth > 0 && --depth === 0) {
      if (out === null) out = [];
      out.push(text.slice(cursor, openAt), REDACTION_MARKER);
      cursor = m.index + m[0].length;
    }
  }
  if (depth > 0) {
    // Unclosed: redact to the end.
    if (out === null) out = [];
    out.push(text.slice(cursor, openAt), REDACTION_MARKER);
    return out.join('');
  }
  if (out === null) return text;
  out.push(text.slice(cursor));
  return out.join('');
}

/**
 * Locate the <private> regions stripPrivate would redact, without rewriting the text, so
 * a caller that also removes other spans (lib/host-blocks.mjs stripPromptBlocks) can
 * reconcile the two. Pairing is the same depth scan as stripPrivate.
 *
 * `ignoredOpeners` holds indexes of opener tags to treat as plain text. It exists because
 * an unmatched opener swallows everything after it, including a closer of some other
 * construct that sits between it and the end; the caller decides which unclosed opener is
 * not really a private one and re-scans.
 *
 * @param {string} text Input string
 * @param {Set<number>} [ignoredOpeners] Opener indexes to skip
 * @returns {{regions: Array<[number, number]>, unclosedAt: number}} Region [start, end)
 *   pairs in order (an unclosed one ends at text.length), and the start of the unclosed
 *   outermost opener or -1 when every opener closed
 */
export function findPrivateRegions(text, ignoredOpeners) {
  const regions = [];
  if (!text.includes('<')) return { regions, unclosedAt: -1 };
  PRIVATE_TAG_RE.lastIndex = 0;
  let openAt = -1;
  let depth = 0;
  let m;
  while ((m = PRIVATE_TAG_RE.exec(text)) !== null) {
    if (m[1] !== '/') {
      if (ignoredOpeners?.has(m.index)) continue;
      if (depth === 0) openAt = m.index;
      depth++;
    } else if (depth > 0 && --depth === 0) {
      regions.push([openAt, m.index + m[0].length]);
    }
  }
  if (depth > 0) {
    regions.push([openAt, text.length]);
    return { regions, unclosedAt: openAt };
  }
  return { regions, unclosedAt: -1 };
}
