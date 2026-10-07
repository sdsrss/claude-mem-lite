// lib/recall-framing.mjs — the first line of a PreToolUse / PostToolUse recall block, in two wordings.
//
// The legacy line announces itself as "system-injected context, continue your planned
// action". It was added in v2.40.0, modelled on the #7758 fix (a handoff injection misread
// as a user message): without a "this is context, not a new request" signal the model
// sometimes ended its turn after an Edit + reminder. Claude Code's hooks reference
// (code.claude.com/docs/en/hooks, fetched 2026-09-27) now warns against exactly this shape:
//
//   "Write the text as factual statements rather than imperative system instructions …
//    Text framed as out-of-band system commands can trigger Claude's prompt-injection
//    defenses, which causes Claude to surface the text to you instead of treating it as
//    context."
//
// PreToolUse is the best-cited face on record (56.2% over 7 days, 2026-09-27), so the wording
// is not swapped on the documentation's say-so. The factual arm keeps that line's point as a
// statement ("the tool call proceeds as planned"). From 6.16.0 to 6.24.x the two ran side by
// side by default, assigned per SESSION, so one walk over one corpus compared them (doctrine rule
// 2: never diff two runs taken at different times); `ab` still does that.
// benchmark/citation-live-replay.mjs `--by-framing` reads the arm back from the injected text
// itself, which stays correct across the deploy boundary.
//
// D#104 readout (2026-10-07, docs/audits/20261007-d104-d111-readout.md): no difference the
// corpus can show. On ack-directive opus-5-5 sessions only, legacy cited 6/162 pretool pairs
// (19 sessions) and factual 2/158 (22 sessions), session-level permutation p = 0.21; the
// failure mode the doc names (the agent surfacing the block) matched no reply in the 20 legacy
// and 22 factual sessions, by a pattern scan whose positive control is weak. A no-margin rule
// passing at that n says nothing, so the incumbent stays: legacy is the default again and the
// split is opt-in.
//
// CLAUDE_MEM_RECALL_FRAMING = legacy (default) | factual | ab. Any other value is legacy.

const LEGACY_TAIL = 'system-injected context, continue your planned action:';
// The substring classifyRecallFraming keys on. Part of the factual line only.
const FACTUAL_MARK = 'notes recorded by claude-mem-lite';
// The shape both arms' first line shares: `[mem] PreToolUse recall — …` / `[mem] PostToolUse recall — …`.
const FRAMING_LINE_RE = /^\[mem\] (?:PreToolUse|PostToolUse) recall — /;

/**
 * Which arm this session gets.
 *
 * `ab` splits on a stable hash of the session id, so every recall block of one session uses
 * one wording (a per-call coin would mix both into every session and leave nothing to
 * compare). No session id → legacy: the arm must be attributable, and a block with no
 * session cannot be.
 *
 * @param {string|null|undefined} sessionId
 * @param {Record<string, string|undefined>} [env]
 * @returns {'legacy'|'factual'}
 */
export function recallFramingArm(sessionId, env = process.env) {
  const mode = String(env.CLAUDE_MEM_RECALL_FRAMING || 'legacy')
    .trim()
    .toLowerCase();
  if (mode === 'factual') return mode;
  if (mode !== 'ab' || !sessionId) return 'legacy';
  // FNV-1a, 32-bit: stable across processes and Node versions, unlike anything keyed on
  // object identity or Math.random.
  let h = 0x811c9dc5;
  for (const ch of String(sessionId)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 2 === 0 ? 'legacy' : 'factual';
}

/**
 * The framing line for one recall block.
 *
 * @param {'PreToolUse'|'PostToolUse'} face
 * @param {{sessionId?: string|null, fname?: string, env?: Record<string, string|undefined>}} [opts]
 * @returns {string}
 */
export function recallFramingLine(face, { sessionId = null, fname = '', env = process.env } = {}) {
  if (recallFramingArm(sessionId, env) === 'legacy') return `[mem] ${face} recall — ${LEGACY_TAIL}`;
  const subject = fname ? ` about ${fname}` : '';
  return `[mem] ${face} recall — ${FACTUAL_MARK}${subject}; the tool call proceeds as planned:`;
}

/**
 * Read the arm back from injected text (the A/B ruler's side).
 *
 * @param {string} text One hook attachment's text.
 * @returns {'legacy'|'factual'|null} null when the text carries neither framing line.
 */
export function classifyRecallFraming(text) {
  // Only the framing line itself counts. The block also carries lesson bodies, and a lesson
  // that quotes either wording (one about this very A/B, say) must not relabel the session
  // (pre-ship review P3-8).
  for (const line of String(text ?? '').split('\n')) {
    if (!FRAMING_LINE_RE.test(line)) continue;
    if (line.endsWith(LEGACY_TAIL)) return 'legacy';
    if (line.includes(FACTUAL_MARK)) return 'factual';
  }
  return null;
}
