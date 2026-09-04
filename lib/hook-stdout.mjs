// lib/hook-stdout.mjs — one hook process, at most ONE JSON document on stdout.
//
// Claude Code parses a command hook's stdout as a SINGLE JSON document. From the
// 2.1.233 bundle, the whole parser is:
//
//   function Hxi(e) {
//     let t = e.trim();
//     if (!t.startsWith("{")) return { plainText: e };   // whole stdout = prose
//     try { let r = XZf(t); ... }                        // JSON.parse(WHOLE stdout) + zod
//     catch (r) { return { plainText: e } }              // ← throw ⇒ whole stdout = prose
//   }
//
// There is no line splitting anywhere in it. That matters because this codebase
// had assumed the opposite ("Claude Code's line-based JSON parser", hook.mjs
// flushEpisode) and shipped surfaces that emit two envelopes, or an envelope
// plus a raw block, on one stdout. Both shapes make JSON.parse throw, so:
//
// There are THREE channels, not one, and each event uses a different subset. Verified
// against the 2.1.260 bundle, 2026-09-04 (minified names are rebuilt every release —
// match on shape, not on the identifier):
//
//   • UserPromptSubmit / UserPromptExpansion — plain text becomes `additionalContext`
//     and is injected verbatim, so the model receives `{"suppressOutput":true,…}` as
//     literal escaped text and suppressOutput is never honoured.
//   • SessionStart — NOT via additionalContext (see channel 1 below), but the runner's
//     status-0 branch also emits a `hook_success` attachment whose `content` is
//     `stdout.trim()`, and the attachment renderer turns that into a real message for
//     SessionStart / UserPromptSubmit / UserPromptExpansion, prefixed
//     `<hookName> hook success: `. So a stray envelope still reaches the model here —
//     with a prefix rather than verbatim.
//   • PreCompact — raw stdout becomes `newCustomInstructions` for the compaction
//     summarizer (channel 2 below).
//   • everything else — plain text is dropped in silence.
//
// So contributions are queued and written once. Callers keep their own gating
// (RECEIPT_EVENTS, significance, etc.); this only owns the writing.
//
// ── THE THREE CHANNELS, and what each correction cost ────────────────────────────
//
// The original list had TWO bullets and named SessionStart as plain-text-injecting.
// The v3.94.0 rewrite fixed that half and broke the other: it moved SessionStart into
// "dropped in silence", which is false via channel 3. Caught by the v3.94.0 pre-tag
// correctness review. Both errors have the same root — reading one channel and
// generalising — which is why the channels are now enumerated rather than summarised.
//
// 1. **additionalContext.** The stdout classifier (`f8e` in 2.1.260, `Hxi` in 2.1.233)
//    turns plain text into an injectable answer for exactly two events:
//
//      if (status === 0) { let N = (plainText ?? "").trim();
//        return (event === "UserPromptSubmit" || event === "UserPromptExpansion") && N !== ""
//          ? { answer: { hookSpecificOutput: { hookEventName: event, additionalContext: N } }, … }
//          : { answer: {}, … } }
//
//    SessionStart's consumer reads `additionalContexts`, which comes off that empty
//    `answer` — so on THIS channel SessionStart really does get nothing. hook.mjs
//    SessionStart uses an envelope, so it does not depend on the finding either way.
//
// 3. **hook_success attachment.** Same status-0 branch, independent of the classifier:
//
//      if (ts.status === 0) { let ls = await bde(ts.stdout.trim(), …);
//        yield { message: cn({ type: "hook_success", …, content: ls, … }), … } }
//
//    and the renderer:
//
//      case "hook_success":
//        if (e.hookEvent !== "SessionStart" && e.hookEvent !== "UserPromptSubmit"
//            && e.hookEvent !== "UserPromptExpansion") return [];
//        if (e.content === "") return [];
//        return [Te({ content: Ra(`${e.hookName} hook success: ${e.content}`), isMeta: !0 })];
//
// 2. There is a SECOND consumption channel, and it is raw stdout. The hook runner
//    sets `result.output = status === 0 ? stdout : stderr` — the whole stdout, JSON
//    or not, quite apart from the parsed `answer`. `executePreCompactHooks` uses THAT:
//
//      let v = results.filter(r => r.succeeded && !r.blocked && r.output.trim())
//                     .map(r => r.output.trim());
//      return { newCustomInstructions: v.length ? v.join("\n\n") : undefined, … }
//
//    and `newCustomInstructions` is passed as `customInstructions` into the compaction
//    summarizer. `grep -abo '\.newCustomInstructions'` on 2.1.260 returns SIX read
//    sites; a draft said four, which is what comes of counting the ones a single
//    bounded grep happened to show. So hook-precompact.mjs writing a bare
//    `<claude-mem-context>` block to stdout is not merely allowed — it is the ONLY
//    correct form there. Routing it through this module would deliver the literal
//    envelope JSON to the summarizer as its instructions. tests/precompact-stdout-shape
//    pins that, so the "consistency" refactor cannot happen by accident.
//
// The general rule the two corrections share: "the host drops plain text" is a claim
// about ONE channel. Before believing it for an event, find which field that event's
// runner actually reads.

let parts = [];
let queuedEvent = null;
let systemParts = [];
let queuedInput = null;

/** Emit the noisy drop notice. stderr is safe: the host never parses it as the envelope. */
function warnDrop(deps, msg) {
  const warn = deps.warn || ((m) => { try { process.stderr.write(m); } catch { /* never block on a warning */ } });
  warn(msg);
}

/**
 * Claim this process's single hookEventName, or refuse the contribution.
 *
 * Mixed event names cannot be merged — Claude Code throws when
 * hookSpecificOutput.hookEventName does not match the event it dispatched.
 * In practice one process serves one event; keep the first and drop the
 * stragglers rather than emit an envelope the host rejects outright.
 *
 * The drop is NOISY on purpose. It is unreachable today (all call sites are
 * event-consistent), but flushEpisode's hookEventName DEFAULTS to 'PostToolUse',
 * so a future caller that omits the argument would both mis-tag its receipt and
 * have it swallowed without a trace. Silently vanishing work is this repo's
 * most-repeated defect class.
 *
 * @returns {boolean} true when the caller may proceed.
 */
function claimEvent(hookEventName, what, deps) {
  if (queuedEvent && queuedEvent !== hookEventName) {
    warnDrop(deps, `[claude-mem-lite] hook-stdout: dropped a ${hookEventName} ${what} — this process `
      + `already queued ${queuedEvent}, and one envelope carries exactly one hookEventName. `
      + 'This is a wiring bug: the contribution is lost.\n');
    return false;
  }
  queuedEvent = hookEventName;
  return true;
}

/**
 * Queue a contribution to this process's single stdout envelope.
 *
 * @param {string} hookEventName Event name for hookSpecificOutput.
 * @param {string} text additionalContext contribution; empty/blank is ignored.
 * @param {{warn?: (msg: string) => void}} [deps]
 * @returns {void}
 */
export function queueHookContext(hookEventName, text, deps = {}) {
  if (!hookEventName) return;
  const body = String(text ?? '').trim();
  if (!body) return;
  if (!claimEvent(hookEventName, 'contribution', deps)) return;
  parts.push(body);
}

/**
 * Queue a `hookSpecificOutput.updatedInput` — a REPLACEMENT of the tool's input,
 * not a contribution to it. PreToolUse is the only event whose schema carries one
 * (2.1.241 bundle: `{hookEventName: "PreToolUse", permissionDecision?,
 * permissionDecisionReason?, updatedInput?, additionalContext?}`), and that same
 * schema is why this belongs here rather than in its own writer: a mutation and a
 * context line may ride ONE envelope, so a hook that grew both would otherwise
 * emit two documents and lose both (the v3.70.0 degradation this module exists for).
 *
 * FIRST writer wins, and a second is dropped noisily. Unlike additionalContext
 * there is no merge: two callers each hand over a whole tool_input, so last-wins
 * would silently discard the earlier mutation — the same vanishing-work shape
 * claimEvent guards against.
 *
 * @param {string} hookEventName Event name for hookSpecificOutput.
 * @param {object} input Replacement tool_input; non-objects and null are ignored.
 * @param {{warn?: (msg: string) => void}} [deps]
 * @returns {void}
 */
export function queueHookUpdatedInput(hookEventName, input, deps = {}) {
  if (!hookEventName) return;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  if (!claimEvent(hookEventName, 'updatedInput', deps)) return;
  if (queuedInput) {
    warnDrop(deps, '[claude-mem-lite] hook-stdout: dropped a second updatedInput — one envelope '
      + 'replaces the tool input exactly once, and merging two whole inputs is not defined. '
      + 'This is a wiring bug: the second mutation is lost.\n');
    return;
  }
  queuedInput = input;
}

/**
 * Queue a line for the HUMAN, not the model.
 *
 * Claude Code renders a command hook's top-level `systemMessage` as its own
 * `hook_system_message` conversation message, independently of
 * `hookSpecificOutput.additionalContext` — verified in the 2.1.234 bundle
 * (`if (G.systemMessage) { … yield { message: yc({ type: "hook_system_message", … }) } }`)
 * and documented there as "Display a message to the user (all hooks)". One envelope
 * can therefore carry context for the model AND a notice for the user.
 *
 * Needed because v3.70.0's merge folded the update banner into additionalContext with
 * `suppressOutput: true`, which kept its content and lost its audience.
 *
 * @param {string} text Notice for the user; empty/blank is ignored.
 * @returns {void}
 */
export function queueHookSystemMessage(text) {
  const body = String(text ?? '').trim();
  if (!body) return;
  systemParts.push(body);
}

/**
 * Write the queued contributions as one envelope. Idempotent: a second call
 * with nothing queued writes nothing, so calling it from both the dispatcher
 * and an exit backstop is safe.
 *
 * @param {{write?: (s: string) => void}} [deps]
 * @returns {boolean} true when an envelope was written.
 */
export function flushHookStdout(deps = {}) {
  const hasContext = Boolean(queuedEvent) && parts.length > 0;
  const hasInput = Boolean(queuedEvent) && queuedInput !== null;
  const hasSystem = systemParts.length > 0;
  if (!hasContext && !hasInput && !hasSystem) return false;
  const write = deps.write || ((s) => process.stdout.write(s));
  const envelope = { suppressOutput: true };
  if (hasSystem) envelope.systemMessage = systemParts.join('\n');
  // Omitted entirely when there is nothing addressed to the host's per-event block:
  // Stop's schema REJECTS a hookSpecificOutput block, and an envelope carrying only a
  // user notice must not invent an event name to hang one on.
  if (hasContext || hasInput) {
    envelope.hookSpecificOutput = { hookEventName: queuedEvent };
    if (hasInput) envelope.hookSpecificOutput.updatedInput = queuedInput;
    if (hasContext) envelope.hookSpecificOutput.additionalContext = parts.join('\n\n');
  }
  parts = [];
  queuedEvent = null;
  systemParts = [];
  queuedInput = null;
  write(JSON.stringify(envelope) + '\n');
  return true;
}

/** Test seam: forget anything queued but not yet written. */
export function resetHookStdout() {
  parts = [];
  queuedEvent = null;
  systemParts = [];
  queuedInput = null;
}

/** Test seam: what is queued right now. */
export function peekHookStdout() {
  return {
    hookEventName: queuedEvent,
    parts: [...parts],
    systemParts: [...systemParts],
    updatedInput: queuedInput,
  };
}
