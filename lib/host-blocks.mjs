// claude-mem-lite: remove instruction blocks the host prepends to a user prompt.
//
// With Claude in Chrome connected, the Claude Code VS Code extension sends every prompt
// with a `<browser_instruction>…</browser_instruction>` block in front of what the user
// typed: about 4KB of browser-tool instructions (4150 chars observed), identical on every
// turn. In the transcript it is its own text part, the first one; the UserPromptSubmit hooks
// receive it joined in front of the typed text. Kept, it became the stored prompt_text and so the
// handoff's "Working On" line, and in scripts/user-prompt-search.js it filled the whole
// capped FTS query (lib/ups-query.mjs: 2000 chars / 64 tokens).
//
// Applied at every boundary that reads a prompt in, before the <task-notification> sentinel
// they share: hook.mjs handleUserPrompt, scripts/user-prompt-search.js and
// lib/import-jsonl.mjs importPrompt.
//
// Case-sensitive on purpose: the host emits the tag in lowercase, and a case-folded copy
// of the text can differ in length from the original, which would misplace every index.
//
// Only well-formed pairs at the START of the prompt are removed (leading whitespace allowed,
// consecutive leading blocks allowed). The host puts the block there and nowhere else, so a
// pair further in is something the user typed and stays. A leading pair the user typed looks
// the same as the host's, so <private> inside one is handled exactly as anywhere else: a
// region that never closes redacts to the end (fail closed).
// An opener with no close is left alone: unlike <private> (which fails closed), this block
// carries nothing sensitive, and a prompt that merely mentions the tag should not lose the
// rest of its text.

import { findPrivateRegions, REDACTION_MARKER } from './private-strip.mjs';

const HOST_BLOCK_TAGS = ['browser_instruction'];

/**
 * Remove the well-formed host instruction block(s) at the start of the prompt and trim the result.
 * Returns the input unchanged when it holds no such block.
 *
 * indexOf scanning rather than a lazy `[\s\S]*?` regex: the regex form walks to the end of
 * the input once per unclosed opener, and this runs on the synchronous prompt path
 * (see the measurements in lib/private-strip.mjs).
 *
 * @param {unknown} text Prompt text (non-string passes through)
 * @returns {string|unknown}
 */
export function stripHostBlocks(text) {
  if (typeof text !== 'string' || !text.includes('<')) return text;
  const spans = findHostSpans(text);
  if (spans.length === 0) return text;
  return text.slice(spans[spans.length - 1][1]).trim();
}

// Well-formed host block spans [start, end) at the START of `text`, in order: each begins
// after nothing but whitespace from the previous one (or from index 0). Anything later is
// user text; see the header for why that matters.
function findHostSpans(text) {
  const spans = [];
  const skipWhitespace = (from) => {
    let at = from;
    while (at < text.length && /\s/.test(text[at])) at++;
    return at;
  };
  let cursor = skipWhitespace(0);
  for (;;) {
    const tag = HOST_BLOCK_TAGS.find((name) => text.startsWith(`<${name}>`, cursor));
    if (!tag) break;
    const end = text.indexOf(`</${tag}>`, cursor + tag.length + 2);
    if (end === -1) break;
    const spanEnd = end + tag.length + 3;
    spans.push([cursor, spanEnd]);
    cursor = skipWhitespace(spanEnd);
  }
  return spans;
}

/**
 * Remove host blocks and redact <private> regions in one pass over the ORIGINAL text.
 *
 * Why not stripHostBlocks(stripPrivate(text)): an unmatched <private> inside a well-formed
 * block redacts to the end of the text, eating the block's closer, so the block's opener is
 * left in front of the marker. The reverse order is worse: a private region that opens
 * inside the block and closes after it loses its opener with the block, and the text up to
 * its closer leaks. So both span sets are computed on the original text and reconciled:
 *   - every unclosed private opener redacts to the end, inside a block or not (fail closed,
 *     as stripPrivate): a leading pair the user typed cannot be told from the host's;
 *   - overlapping spans merge into one interval; it becomes [redacted] when it holds a
 *     private region that is not wholly inside a host block (so a crossing region redacts
 *     through its closer), and '' when everything in it was host text.
 * Returns the input unchanged (same reference) when nothing matched; trims only when a host
 * block was removed.
 *
 * @param {unknown} text Prompt text (non-string passes through)
 * @returns {string|unknown}
 */
export function stripPromptBlocks(text) {
  if (typeof text !== 'string' || !text.includes('<')) return text;
  const hostSpans = findHostSpans(text);

  const privateRegions = findPrivateRegions(text).regions;
  if (hostSpans.length === 0 && privateRegions.length === 0) return text;

  // Both lists are sorted, so one forward pointer finds each region's containing block.
  const intervals = hostSpans.map(([start, end]) => ({ start, end, redact: false }));
  let hostIdx = 0;
  for (const [start, end] of privateRegions) {
    while (hostIdx < hostSpans.length && hostSpans[hostIdx][1] <= start) hostIdx++;
    const host = hostSpans[hostIdx];
    const inside = host && host[0] <= start && end <= host[1];
    if (!inside) intervals.push({ start, end, redact: true });
  }
  intervals.sort((a, b) => a.start - b.start || b.end - a.end);

  const pieces = [];
  let cursor = 0;
  let current = null;
  const flush = () => {
    if (!current) return;
    pieces.push(text.slice(cursor, current.start));
    if (current.redact) pieces.push(REDACTION_MARKER);
    cursor = current.end;
  };
  for (const interval of intervals) {
    if (current && interval.start < current.end) {
      current.end = Math.max(current.end, interval.end);
      current.redact = current.redact || interval.redact;
    } else {
      flush();
      current = { ...interval };
    }
  }
  flush();
  pieces.push(text.slice(cursor));
  // Trim only when a host block came off: with <private> changes alone the result must equal
  // stripPrivate's, or the importer's two dedup keys for a block-less prompt would differ.
  const joined = pieces.join('');
  return hostSpans.length > 0 ? joined.trim() : joined;
}
