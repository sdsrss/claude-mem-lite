// lib/hook-text-cap.mjs — keep every string the host injects under its 10,000-character cap.
//
// Claude Code's hooks reference (code.claude.com/docs/en/hooks, fetched 2026-09-27):
//
//   "A hook's `additionalContext`, `systemMessage`, and `initialUserMessage` strings, and its
//    plain stdout, are capped at 10,000 characters … For JSON output, each field is measured
//    separately; plain stdout is measured whole. Over the limit: Claude Code saves the output
//    to a file in the session directory and replaces it with the file path and a preview of
//    up to the first 2,000 characters … Claude Code doesn't ask Claude to read the file."
//
// So an over-long injection is not cut at 10,000 — it collapses to a 2,000-character preview
// and the model is never told to fetch the rest. Trimming here, by whole lines, keeps ~9,500
// characters in context instead of 2,000, and says which ids were dropped.
//
// Two entry points, one per delivery channel:
//   • capHookText(text)        — a single string (an envelope field, PreCompact's one write);
//   • writePlainHookText(text) — plain stdout written in several chunks by one process
//                                (UserPromptSubmit), measured whole by the host, so the
//                                budget is per HANDLER, not per call.

/** The host's documented per-field / whole-plain-stdout cap. */
export const HOOK_TEXT_CAP = 10_000;

// Content stops RESERVE characters short of the cap so the omission footer and any closing
// tags re-appended for blocks cut open fit. Sized, not proven: MAX_FOOTER_IDS bounds the id
// COUNT, not their length, and nothing bounds the tag nesting. For what the surfaces emit
// (ids of a few digits, one or two nested blocks) the tail is under ~250 characters; a longer
// one is still held under the cap by the final safeSlice, at the cost of the re-closed tags.
const RESERVE = 500;
const MAX_FOOTER_IDS = 12;

// Ids as every injection surface renders them: `#12`, `E#34`, `D#5`, `P#820`.
const ID_RE = /(?<![\w#])((?:[A-Z])?#\d+)\b/g;
const OPEN_TAG_RE = /^<([a-z][\w-]*)(?:\s[^>]*)?>$/;
const CLOSE_TAG_RE = /^<\/([a-z][\w-]*)>$/;

function idsIn(lines) {
  const seen = new Set();
  for (const line of lines) for (const m of line.matchAll(ID_RE)) seen.add(m[1]);
  return [...seen];
}

/**
 * @param {string[]} droppedLines whole lines not shown
 * @param {string} [cutRest] the tail of a line that was cut short, when one was
 */
function omissionFooter(droppedLines, cutRest = '') {
  const ids = idsIn(cutRest ? [cutRest, ...droppedLines] : droppedLines);
  const shown = ids.slice(0, MAX_FOOTER_IDS).join(', ');
  const more = ids.length > MAX_FOOTER_IDS ? ` +${ids.length - MAX_FOOTER_IDS} more` : '';
  const idPart = ids.length ? ` (ids: ${shown}${more})` : '';
  const what = [
    cutRest ? 'a line was cut short' : '',
    droppedLines.length ? `${droppedLines.length} more line(s) not shown` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return `[claude-mem-lite] ${what} — hook output limit${idPart}`;
}

/** `s` cut to at most `n` UTF-16 units without leaving half of a surrogate pair. */
function safeSlice(s, n) {
  if (n <= 0) return '';
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/**
 * Trim `text` to at most `cap` characters by dropping whole lines from the end.
 *
 * Lines are kept from the top (every surface renders its highest-ranked rows first), a
 * footer names what was dropped, and any `<tag>` block whose closing line was dropped is
 * closed again so the kept text still parses as the block it claims to be. A text already
 * within `cap` is returned unchanged.
 *
 * @param {string} text
 * @param {number} [cap] Hard ceiling for the returned string.
 * @returns {string}
 */
export function capHookText(text, cap = HOOK_TEXT_CAP) {
  const s = String(text ?? '');
  if (s.length <= cap) return s;
  const budget = Math.max(0, cap - RESERVE);
  const lines = s.split('\n');
  const kept = [];
  const open = [];
  let used = 0;
  let i = 0;
  for (; i < lines.length; i++) {
    const add = lines[i].length + (kept.length ? 1 : 0);
    if (used + add > budget) break;
    kept.push(lines[i]);
    used += add;
    const o = lines[i].match(OPEN_TAG_RE);
    const c = lines[i].match(CLOSE_TAG_RE);
    if (o) open.push(o[1]);
    else if (c && open[open.length - 1] === c[1]) open.pop();
  }
  // A first line longer than the whole budget would otherwise leave nothing at all. It is cut
  // with a visible ellipsis and the footer says so: a lesson or an instruction cut mid-sentence
  // with no marker reads as complete (pre-ship review P3-1).
  let cutRest = '';
  if (kept.length === 0 && lines.length > 0) {
    let head = safeSlice(lines[0], budget - 1);
    // Back off to a word boundary when the cut lands inside a token, so an id is never shown
    // half (`#424…`) and the footer, which reads ids from the cut part, gets it whole.
    if (/[\w#]$/.test(head) && /^[\w#]/.test(lines[0].slice(head.length))) {
      const sp = head.search(/\s\S*$/);
      if (sp > 0) head = head.slice(0, sp + 1);
    }
    kept.push(`${head}…`);
    cutRest = lines[0].slice(head.length);
    i = 1;
  }
  // A closing line re-appended below is not "not shown"; count it out of the footer.
  const reclosed = new Map();
  for (const t of open) reclosed.set(t, (reclosed.get(t) || 0) + 1);
  const dropped = lines.slice(i).filter((l) => {
    if (l.trim() === '') return false;
    const c = l.match(CLOSE_TAG_RE);
    if (c && reclosed.get(c[1]) > 0) {
      reclosed.set(c[1], reclosed.get(c[1]) - 1);
      return false;
    }
    return true;
  });
  const tail = [];
  if (dropped.length || cutRest) tail.push(omissionFooter(dropped, cutRest));
  for (let k = open.length - 1; k >= 0; k--) tail.push(`</${open[k]}>`);
  const out = [...kept, ...tail].join('\n');
  // "Never over cap" holds regardless; the slice fires only for a tail RESERVE did not cover
  // (see RESERVE) or a caller passing a cap smaller than RESERVE.
  return out.length <= cap ? out : safeSlice(out, cap);
}

/**
 * Which of `entries` reached the model WHOLE in `shown` (D#108).
 *
 * Every surface books what it injected — the dedup marker, `injection_count`, the Key
 * Context marker — and must book only what the cap kept: a row booked but cut is
 * suppressed for the dedup window as if it had been seen. An entry counts when all of its
 * text survives as whole lines; a row cut short (`…`) or a multi-line item whose tail was
 * dropped does not. Each surface's rows carry their own id, so one row's text cannot stand
 * in for another's.
 *
 * @template T
 * @param {string} shown What the writer actually emitted (the writers below return it).
 * @param {Iterable<{id: T, text: string}>} entries Rendered items, in any order.
 * @returns {T[]} ids of the entries shown whole, in `entries` order.
 */
export function idsShownWhole(shown, entries) {
  const hay = `\n${String(shown ?? '')}\n`;
  const out = [];
  for (const e of entries || []) {
    if (e && typeof e.text === 'string' && e.text !== '' && hay.includes(`\n${e.text}\n`)) out.push(e.id);
  }
  return out;
}

/**
 * Write ONE capped string as a hook's whole plain stdout (PreCompact's single block).
 *
 * @param {string} text
 * @param {{write?: (s: string) => void}} [deps]
 * @returns {string} What was written, without the trailing newline — feed it to idsShownWhole.
 */
export function writeCappedHookText(text, deps = {}) {
  const write = deps.write || ((s) => process.stdout.write(s));
  const out = capHookText(text, HOOK_TEXT_CAP - 1);
  write(`${out}\n`);
  return out;
}

// ── plain stdout, several chunks per handler ─────────────────────────────────────────

let plainUsed = 0;

/**
 * Write a chunk of plain hook stdout, keeping the HANDLER's total under the cap.
 *
 * The host measures plain stdout whole, so two blocks that each fit can still overflow
 * together. A chunk that no longer fits is trimmed by capHookText to what is left; once the
 * budget is spent, later chunks are reduced to a one-line omission note while room for one
 * remains, and dropped after that.
 *
 * @param {string} text Chunk to write; a trailing newline is added.
 * @param {{write?: (s: string) => void, cap?: number}} [deps]
 * @returns {string} What was written, without the trailing newline ('' when nothing was) —
 *   feed it to idsShownWhole before booking any row as delivered.
 */
export function writePlainHookText(text, deps = {}) {
  const write = deps.write || ((s) => process.stdout.write(s));
  const cap = deps.cap ?? HOOK_TEXT_CAP;
  const body = String(text ?? '');
  const remaining = cap - plainUsed;
  if (remaining > RESERVE) {
    // capHookText returns `body` unchanged when it fits, so this is also the common path.
    const out = capHookText(body, remaining - 1);
    write(`${out}\n`);
    plainUsed += out.length + 1;
    return out;
  }
  const note = omissionFooter(body.split('\n').filter((l) => l.trim() !== ''));
  if (note.length + 1 <= remaining) {
    write(`${note}\n`);
    plainUsed += note.length + 1;
    return note;
  }
  return '';
}

/**
 * Start a new plain-stdout budget. Called at the top of each handler that writes through
 * writePlainHookText: one handler invocation is one hook output, and in-process callers
 * (tests, the dispatcher) may run several.
 */
export function resetPlainHookText() {
  plainUsed = 0;
}
