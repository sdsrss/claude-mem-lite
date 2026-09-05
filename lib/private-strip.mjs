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
// Intentionally does NOT strip:
//   - Open-without-close (`<private>...` with no `</private>`): user may still
//     be typing; aggressive strip-to-EOL would surprise. Caller can chain a
//     length cap (`promptText.slice(0, 10000)`) after this for safety.
//   - Stray `</private>` with no opener: same reasoning, leave intact.
// Both gaps are documented for callers to layer additional guards if needed.
//
// Case-insensitive on the tag (`<PRIVATE>`, `<Private>` all work) since users
// type by hand. Non-greedy match handles multiple blocks correctly.

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
const PRIVATE_TAG_RE = /<(\/?)private>/gi;
const REDACTION_MARKER = '[redacted]';

/**
 * Replace each well-formed <private>...</private> block with [redacted].
 * Returns input unchanged if no closed block is present.
 *
 * Pairing rule reproduces the leftmost-then-lazy semantics of the block regex exactly:
 * the EARLIEST unmatched opener claims the next close (so `<private>a<private>b</private>`
 * collapses whole, as the regex did), a close with no open ahead of it stays intact, and
 * an opener with no close after it stays intact.
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
  let openAt = -1; // index of the earliest opener not yet paired
  let m;
  while ((m = PRIVATE_TAG_RE.exec(text)) !== null) {
    if (m[1] !== '/') {
      if (openAt < 0) openAt = m.index;
    } else if (openAt >= 0) {
      if (out === null) out = [];
      out.push(text.slice(cursor, openAt), REDACTION_MARKER);
      cursor = m.index + m[0].length;
      openAt = -1;
    }
  }
  if (out === null) return text;
  out.push(text.slice(cursor));
  return out.join('');
}
