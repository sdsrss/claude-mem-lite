import { DAY_MS } from './lib/time-constants.mjs';
// claude-mem-lite: String formatting and display utilities
// Extracted from utils.mjs for focused responsibility

/**
 * Truncate a string to a maximum length, replacing newlines with spaces.
 * @param {string} str Input string
 * @param {number} [max=80] Maximum character length
 * @returns {string} Truncated string with ellipsis if needed
 */
export function truncate(str, max = 80) {
  if (!str) return '';
  // Defense-in-depth: a non-string (e.g. an LLM that returned title as an array/number)
  // would throw `str.replace is not a function` and abort the caller. Coerce to '' rather
  // than crash; the real type-guarding happens at the call site.
  if (typeof str !== 'string') return '';
  str = str.replace(/\n/g, ' ').trim();
  if (str.length <= max) return str;
  // Never split a UTF-16 surrogate pair: slicing between the high and low half emits a
  // lone surrogate (invalid UTF-16) that then gets persisted to the DB. If the last kept
  // code unit is a high surrogate, drop it so we cut on a code-point boundary.
  let end = max - 1;
  const last = str.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return str.slice(0, end) + '\u2026';
}

// Two delimiter classes are defanged here:
//   1. The blocks claude-mem-lite wraps injected context in (claude-mem-context /
//      memory-context / session-handoff). User-derived text containing one LITERALLY
//      would prematurely open/close the block it lands in, spilling the rest as
//      undelimited context.
//   2. Harness-authority + tool-call tags the runtime injects (system-reminder /
//      task-notification / function_calls / function_results, the latter two also in
//      their antml:-namespaced form). Memory replays arbitrary captured text \u2014 file
//      contents, tool output, web pages \u2014 so a poisoned observation carrying a literal
//      <system-reminder>\u2026</system-reminder> or a forged <function_calls>\u2026</function_calls>
//      block would smuggle a privileged-channel instruction / fake tool-call narrative
//      into the model's context. It can't escape its wrapper (class 1 closers are
//      defanged), but a nested forged authority/tool tag is still an indirect-prompt-
//      injection vector; strip the brackets so it reads as inert text. Tool-call tags
//      (<invoke \u2026>/<parameter \u2026>, bare + antml:-namespaced) are included: a prior turn's
//      malformed tool-XML replayed through a handoff corrupted the continuation surface
//      (mid-token truncation + model confusion), so replayed tool-XML must defang too.
//      These carry attributes, so the match allows an optional attribute tail before the
//      closing `>` \u2014 which also catches an attribute-bearing forgery of an authority tag
//      (<system-reminder foo="\u2026">). Unrelated tags (<other-tag>) are left intact.
// Reachable by editing files that contain these tokens \u2014 e.g. developing claude-mem-lite
// itself, where source/observations carry the delimiter names.
const CONTEXT_DELIMITER_RE =
  /<\/?(?:claude-mem-context|memory-context|session-handoff|system-reminder|task-notification|(?:antml:)?function_calls|(?:antml:)?function_results|(?:antml:)?invoke|(?:antml:)?parameter)(?:\s[^>]*)?>/gi;

// Pass cap for the fixpoint loop below. 32 nested layers of a forged delimiter is far past
// anything prose produces; the cap exists only to bound the ADVERSARIAL cost (an unbounded
// fixpoint is O(depth \u00d7 length), i.e. quadratic on a crafted 200k-char payload, on the
// synchronous hook/CLI write path \u2014 this repo has shipped two ReDoS findings already).
const DEFANG_MAX_PASSES = 32;

/**
 * Strip the angle brackets of every `re` match, repeatedly, until the text stops changing.
 *
 * A SINGLE pass is not enough, and the gap is two characters wide: in
 * `<<system-reminder>>` the pattern matches the INNER pair, removing it leaves the outer
 * pair wrapped around the bare tag name, and the "defanged" output is a live
 * `<system-reminder>` \u2014 produced by the function whose job is to make it inert (pre-tag
 * review, 2026-08-14). Widening the pattern to also eat adjacent brackets does not fix it
 * either: `<system-reminder <system-reminder> x>y>` re-forms `<system-reminder x>` from
 * text the widened match keeps. Only a fixpoint closes the general case.
 *
 * TERMINATION: every match begins with `<` and the replacement drops it, so any pass that
 * changes the string removes at least one `<` \u2014 the iteration is self-bounded by the number
 * of `<` in the input, and DEFANG_MAX_PASSES bounds it again by a constant.
 *
 * INERT AT ANY DEPTH: if the text is still changing when the cap is reached (\u226532 nested
 * forged layers \u2014 not reachable by accident), every remaining angle bracket is removed.
 * That is lossier than the normal path, but the return value then provably contains no tag,
 * which is the property callers rely on; giving up at the cap and returning still-tagged
 * text would hand the attacker exactly the bypass the loop exists to close.
 *
 * @param {string} s Input string (any type; coerced)
 * @param {RegExp} re Global tag pattern whose matches start with `<` and end with `>`
 * @returns {string} Text containing no match of `re`
 */
function defangToFixpoint(s, re) {
  let text = String(s ?? '');
  for (let pass = 0; pass < DEFANG_MAX_PASSES; pass++) {
    const next = text.replace(re, (m) => m.slice(1, -1));
    if (next === text) return text; // fixpoint: nothing left to defang
    text = next;
  }
  return text.replace(/[<>]/g, ''); // pathological nesting \u2192 fail closed
}

/**
 * Defang the literal context-block delimiter tags in user-derived text. Strips just the
 * angle brackets, so `</claude-mem-context>` renders as `/claude-mem-context` \u2014 still
 * readable, but no longer a structural delimiter. Complements `mdCell`'s pipe-escaping.
 * Iterated to a fixpoint (see defangToFixpoint): a single pass let `<<system-reminder>>`
 * come back live.
 * @param {string} s Input string (any type; coerced)
 * @returns {string} Text with delimiter tags defanged
 */
export function neutralizeContextDelimiters(s) {
  return defangToFixpoint(s, CONTEXT_DELIMITER_RE);
}

// <skill-loaded> is deliberately NOT in CONTEXT_DELIMITER_RE above: mem_use's legitimate
// load path has to emit a REAL one, and that result goes through the same handler-wide
// defang, which would strip it. So the tag is neutralized here instead — per call site,
// on the untrusted text only. Attribute-bearing openers and the bare closer both match,
// same "strip the brackets, keep the text" treatment as the class above.
const SKILL_BLOCK_RE = /<\/?skill-loaded(?:\s[^>]*)?>/gi;

/**
 * Defang a literal `<skill-loaded>` opener/closer in text that is about to be echoed
 * INSIDE a mem_use response. A caller-supplied name interpolated raw could otherwise
 * forge a whole skill block (plus its execute imperative) in a message the caller
 * controls end to end — audit F7, 2026-08-14. Never apply this to the real load path.
 * Same fixpoint iteration as the class above, for the same reason: one pass turned the
 * caller-supplied `<<skill-loaded>>` back into a live `<skill-loaded>` opener.
 * @param {string} s Input string (any type; coerced)
 * @returns {string} Text with skill-block delimiters defanged
 */
export function neutralizeSkillDelimiters(s) {
  return defangToFixpoint(s, SKILL_BLOCK_RE);
}

/**
 * Render the PostToolUse error-recall hint block (hook.mjs::triggerErrorRecall).
 * The single most-relevant hit (rows[0]) that carries a lesson_learned gets its
 * lesson INLINED, so the agent can act with zero follow-up round-trips: the old
 * "pointer + mem_get for details" form cost a deferred mem_get (2 model turns in
 * tool-heavy sessions, where mem_* is gated behind ToolSearch) at the exact
 * moment a fix is needed. Later rows stay as #ID pointers to keep the injected
 * payload bounded (one body, not three). Upstream noise gating (low-signal title
 * exclusion) is the SELECT's job (see triggerErrorRecall).
 * @param {Array<{id:number,type:string,title:string,lesson_learned?:string}>} rows
 * @returns {string} stdout block (trailing newline) or '' when there are no rows
 */
export function formatErrorRecallHints(rows) {
  if (!rows || rows.length === 0) return '';
  const lines = rows.map((r, i) => {
    // Defang title + lesson: this block is written to PostToolUse stdout \u2192 model context,
    // and observations are stored raw (defense is at the injection boundary, not at save),
    // so a poisoned lesson carrying a forged <system-reminder>/tool tag would inject here
    // un-neutralized. Same guard the handoff render applies to its replayed fields.
    const head = `  #${r.id} [${r.type}] ${neutralizeContextDelimiters(truncate(r.title, 60))}`;
    // Inline the lesson body for the single most-relevant hit only (bounded payload).
    if (i === 0 && typeof r.lesson_learned === 'string' && r.lesson_learned.trim()) {
      return `${head} \u2014 ${neutralizeContextDelimiters(truncate(r.lesson_learned.trim(), 200))}`;
    }
    return head;
  });
  const ids = rows.map((r) => r.id).join(',');
  return `[claude-mem-lite] Related memories found for this error:\n${lines.join('\n')}\n  \u2192 Use mem_get(ids=[${ids}]) for details.\n`;
}

/**
 * Map observation type to its display emoji icon.
 * @param {string} type Observation type (decision, bugfix, feature, etc.)
 * @returns {string} Emoji icon for the type
 */
export function typeIcon(type) {
  const icons = {
    decision: '\uD83D\uDFE1',
    bugfix: '\uD83D\uDD34',
    feature: '\uD83D\uDFE2',
    refactor: '\uD83D\uDD35',
    discovery: '\uD83D\uDD0D',
    change: '\uD83D\uDCDD',
  };
  return icons[type] || '\u26AA';
}

// ─── Date Formatting ─────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format an ISO date string as "Mon DD HH:MM" for compact display.
 * @param {string} iso ISO 8601 date string
 * @returns {string} Formatted date or empty string
 */
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const mon = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${day} ${h}:${m}`;
}

/**
 * Format an ISO date string as "HH:MM" for time-only display.
 * @param {string} iso ISO 8601 date string
 * @returns {string} Formatted time or empty string
 */
export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  // Guard against an unparseable timestamp (e.g. corrupt/imported created_at):
  // a bare new Date('garbage') yields Invalid Date → getUTCHours() is NaN →
  // "NaN:NaN" leaking into the SessionStart Recent table. Degrade to '' like the
  // falsy-input case above.
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ─── ISO Week ────────────────────────────────────────────────────────────────

/**
 * Convert an epoch timestamp to an ISO week key string (e.g. "2026-W06").
 * @param {number} epochMs Epoch timestamp in milliseconds
 * @returns {string} ISO week key in format "YYYY-Wnn"
 */
export function isoWeekKey(epochMs) {
  const d = new Date(epochMs);
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((tmp - yearStart) / DAY_MS + 1) / 7);
  const isoYear = tmp.getUTCFullYear();
  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}
