// claude-mem-lite: PostToolUse cite-back hint builder.
//
// Fires when a flushed episode edits a file that PreToolUse:Read/Edit had
// nudged earlier in the same session — the canonical "you fixed something we
// warned about, save the lesson?" moment.
//
// Pure function: takes an episode + the session-scoped pre-recall cooldown
// object and returns a hint string (or null). Cooldown I/O lives elsewhere so
// this stays unit-testable without disk fixtures.
//
// Cooldown schema (post-v2.81): { "<path>": { ts: <number>, lessonIds: [#NN, ...] } }
// Legacy schema   (pre-v2.81):  { "<path>": <number> } — tolerated, never emits.

import { basename } from 'path';
import { readFileSync } from 'fs';
import { readTranscriptEntries } from './transcript-scan.mjs';
import { EDIT_TOOLS } from '../utils.mjs';
// SEC-6 (2026-08-29 audit): these two hints were the only one of the injection surfaces
// whose text cells reach the model undefanged. Every sibling neutralizes (events-injection
// titles/lessons, hook-context's whole block, hook-handoff — which defangs the output of
// basename() specifically, at hook-handoff.mjs:473). A filename is attacker-influenceable
// in the ordinary case: it is whatever the repository being worked on happens to contain.
import { neutralizeContextDelimiters } from '../format-utils.mjs';
import { cooldownPathFor as sharedCooldownPathFor } from './cooldown-path.mjs';
import { citeRecallPathFor } from './cite-recall-path.mjs';
// One caliber for `#NN`. citation-tracker.mjs does NOT import this module, so the edge
// is acyclic.
import { citationIdRe } from './citation-tracker.mjs';
import { envNumber } from './env-number.mjs';

const MAX_FILES = 2;

// Leader literal for the cite-back hint. Shared by the builder (below) and the
// Stop-time signal extractor (extractCiteBackSignals) so the two can never drift
// — the extractor finds hint emissions by this exact prefix.
const CITE_BACK_HINT_LEADER = '[mem] ⚠ Cite-back:';

export function buildCiteBackHint(episode, cooldown) {
  if (!episode || !cooldown) return null;
  const entries = episode.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const seen = new Set();
  const matches = [];
  for (const e of entries) {
    if (!EDIT_TOOLS.has(e.tool)) continue;
    for (const file of e.files || []) {
      if (seen.has(file)) continue;
      const entry = cooldown[file];
      if (!entry || typeof entry !== 'object') continue;
      const ids = Array.isArray(entry.lessonIds) ? entry.lessonIds : null;
      if (!ids || ids.length === 0) continue;
      seen.add(file);
      matches.push({ file, ids });
      if (matches.length >= MAX_FILES) break;
    }
    if (matches.length >= MAX_FILES) break;
  }

  if (matches.length === 0) return null;

  // B1 (v2.83): leader line carries explicit counts (file count + total lesson
  // count) and a directive verb. Pre-v2.83 wording "if you fixed it" was
  // routinely treated as advisory and ignored — cite-recall data showed the
  // hint firing without follow-up `/lesson` calls. §10 Specificity binds:
  // numeric framing is measurably harder to dismiss than a hedged hint.
  const totalLessons = matches.reduce((sum, m) => sum + m.ids.length, 0);
  const lines = [
    `${CITE_BACK_HINT_LEADER} edited ${matches.length} file(s) with ${totalLessons} prior lesson(s) this session. Save now if any was the root cause:`,
  ];
  for (const m of matches) {
    const fname = neutralizeContextDelimiters(basename(m.file));
    const idList = m.ids.map((id) => `#${id}`).join(', ');
    lines.push(`  • ${fname} ← ${idList} — /lesson --file ${fname} "<root cause + fix>"`);
  }
  return lines.join('\n');
}

// B1 (v2.83): structured per-episode "tricky fix just happened" detector. Lifts
// the inline error→fix nudge that used to live in hook.mjs flushEpisode into
// the lib so all save-prompt hints share one home + the same wording rules.
//
// Detection (mirrors pre-v2.83 hook.mjs:194 heuristic):
//   • has at least one entry with a HARD failure fingerprint (isHardError) — NOT just
//     isError. `node cli.mjs search "error"`, `npx vitest` green output, or any command
//     whose output merely MENTIONS "error"/"failed" sets isError=true but is not a fix;
//     gating on isError nagged on non-fixes (audit: fired on a read-only session + a
//     scratch write). isHardError requires a real crash/exception/stack (bash-utils.mjs).
//   • has at least one entry using an edit tool
//   • entries.length >= 3 (rules out single-typo fixes that don't need a lesson)
// Returns null when any condition fails or when no edited files are recoverable
// from the entry list (defensive — episodes flushed mid-tool can have empties).
// Legacy fallback: entries written before isHardError existed lack the field, so fall
// back to isError for them rather than silently regress the nudge to never-fire.
const MIN_BUGFIX_ENTRIES = 3;
const MAX_DISPLAY_FILES = 3;

export function buildUnsavedBugfixHint(episode) {
  if (!episode) return null;
  const entries = episode.entries;
  if (!Array.isArray(entries) || entries.length < MIN_BUGFIX_ENTRIES) return null;

  let hasError = false;
  let hasEdit = false;
  const editedFiles = new Set();
  for (const e of entries) {
    if (!e) continue;
    if (e.isHardError !== undefined ? e.isHardError : e.isError) hasError = true;
    if (EDIT_TOOLS.has(e.tool)) {
      hasEdit = true;
      for (const f of e.files || []) editedFiles.add(f);
    }
  }
  if (!hasError || !hasEdit || editedFiles.size === 0) return null;

  const files = [...editedFiles];
  const displayed = files.slice(0, MAX_DISPLAY_FILES).map((f) => neutralizeContextDelimiters(basename(f)));
  const firstFname = neutralizeContextDelimiters(basename(files[0]));
  return `[mem] ⚠ Unsaved bugfix-shape: error+edit across ${files.length} file(s) in ${entries.length} entries (${displayed.join(', ')}). Save now if it was a real fix: /lesson --file ${firstFname} "<root cause + fix>"`;
}

// Path scheme comes from lib/cooldown-path.mjs, the single definition shared with the
// writer (scripts/pre-tool-recall.js) and the other reader (lib/edge-attribution.mjs).
// Argument order is flipped from the shared helper's, so keep this thin adapter rather
// than re-ordering every call site (ARCH-2).
function cooldownPathFor(sessionId, runtimeDir) {
  return sharedCooldownPathFor(runtimeDir, sessionId);
}

// ─── countUnsavedBugfixShape (B2, v2.83.1) ──────────────────────────────────
// At Stop time, count this session's transcript for:
//   • bugfix-shape hint emissions (buildUnsavedBugfixHint fired)
//   • lesson/bugfix save signals (mem_save tool_use with type ∈ {bugfix, lesson}
//     OR Bash `activity save --type lesson|bugfix`)
//
// Returns {nudged, saved, unsaved} where unsaved = max(0, nudged - saved).
// SessionStart surfaces `unsaved` as a follow-on to the cite-recall nudge,
// turning per-episode hints into cross-session pressure.
const UNSAVED_BUGFIX_LITERAL = 'Unsaved bugfix-shape';
const ACTIVITY_SAVE_LESSON_RE = /activity\s+save\s+--type\s+(lesson|bugfix)\b/;
// P2(a): /bug and /lesson were redirected from `activity save` (events) to
// `cli.mjs save … --lesson` (searchable observations). Recognize that shape too,
// or the unsaved-bugfix nudge over-fires after an explicit save. Anchored on the
// mem CLI + the --lesson flag both skills always pass. Uses `[\s\S]*?` (not
// `[^\n]*`) because the skill templates document a multi-line, backslash-
// continued command — after JSON.parse the command carries real newlines, so the
// gap between `save` and `--lesson` must be allowed to span them (lazy → nearest).
const OBS_INSIGHT_SAVE_RE = /(?:cli\.mjs|claude-mem-lite)['"]?\s+save\b[\s\S]*?--lesson(?:-learned)?\b/;
const MEM_SAVE_TOOL_NAMES = new Set([
  'mem_save',
  'mcp__claude_mem_lite__mem_save',
  'mcp__plugin_claude-mem-lite_mem-lite__mem_save',
]);

export function countUnsavedBugfixShape(transcriptPath) {
  let nudged = 0;
  let saved = 0;

  for (const entry of readTranscriptEntries(transcriptPath)) {
    // Bugfix-shape hint emissions live in PostToolUse attachment.stdout.
    if (entry.type === 'attachment') {
      const stdout = entry.attachment?.stdout || '';
      if (stdout.includes(UNSAVED_BUGFIX_LITERAL)) nudged++;
      continue;
    }

    // Save signals live in assistant tool_use blocks.
    if (entry.type === 'assistant' || entry.message?.role === 'assistant') {
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        if (MEM_SAVE_TOOL_NAMES.has(block.name)) {
          const t = block.input?.type;
          if (t === 'bugfix' || t === 'lesson') saved++;
          continue;
        }
        if (block.name === 'Bash') {
          const cmd = block.input?.command || '';
          if (ACTIVITY_SAVE_LESSON_RE.test(cmd) || OBS_INSIGHT_SAVE_RE.test(cmd)) saved++;
        }
      }
    }
  }

  return { nudged, saved, unsaved: Math.max(0, nudged - saved) };
}

// ─── buildCiteRecallNudge (extracted from hook.mjs for unit-testability) ────
// Reads `runtime/cite-recall-<project>.json` (written by handleStop) and
// builds the SessionStart nudge surface. Two independent gates compose:
//   • cite-recall ratio gate: prior session's HOOK-INJECTED cite-recall ratio <
//     threshold (default 0.4) AND that same injected count >= floor (default 5).
//     D#19: the wide computeCiteRecall ratio is the fallback for payloads written
//     before v6.6.0, and the forced reading under
//     CLAUDE_MEM_CITE_NUDGE_WIDE_DENOMINATOR=1.
//   • B2 (v2.83.1) unsaved-bugfix gate: `unsaved > 0` (no min-volume floor —
//     the bugfix-shape heuristic already requires ≥3 entries)
// Either gate can fire independently. Both off → empty string (no surface).
//
// Self-silence: after this many consecutive qualifying sessions where the
// project's cite-recall stayed below threshold, stop emitting the ratio nag — a
// project that has ignored the cite-#NN ask N times running is not going to
// start because we asked again; further nags are pure context noise (the audit's
// "nag-at-0%-compliance" anti-pattern). The streak resets the moment cite-recall
// recovers, so the nudge re-engages if behavior changes. Env override:
// CLAUDE_MEM_CITE_NUDGE_SILENCE_AFTER (0 = never silence).
export const CITE_NUDGE_SILENCE_AFTER = 3;

/**
 * Which (injected, recalled, ratio) triple the gate judges, and whether it is the
 * hook-injected one.
 *
 * D#19. `computeCiteRecall`'s denominator is deliberately wide — every `#NN`-shaped
 * token in non-assistant text, which includes tool_result bodies, file contents, CLI
 * output and pasted reports. That is the right caliber for "which ids has the model
 * SEEN", and it is not the question this nag asks. The nag asks whether the model cited
 * back the lessons the HOOKS put in front of it, and against the wide denominator that
 * ratio is structurally small: measured 2026-09-08 over all 69 transcripts on this
 * machine, wide median 0.125 vs hook-injected median 0.429, and the shipped 0.6
 * threshold fired on 46 of 48 qualifying sessions (96%).
 *
 * A gate that is 96% true carries almost no information, and because `nextCiteLowStreak`
 * only resets when the gate does NOT fire, the streak climbs to CITE_NUDGE_SILENCE_AFTER
 * within the first few sessions and the surface goes quiet for the life of the project.
 * That — not "the threshold is unsatisfiable", which was D#19's premise and is false
 * (max ratio is 0.833 on both denominators today) — is the defect.
 *
 * Back-compat: a payload written before this release has no `gate*` keys, so the wide
 * triple is used and the only change such a project sees is the threshold. Full revert:
 * CLAUDE_MEM_CITE_NUDGE_WIDE_DENOMINATOR=1 plus CLAUDE_MEM_CITE_NUDGE_THRESHOLD=0.6.
 */
function gateStats(data, env) {
  const wide = {
    injected: data?.injected,
    recalled: data?.recalled,
    ratio: data?.ratio,
    hookScoped: false,
  };
  if (env.CLAUDE_MEM_CITE_NUDGE_WIDE_DENOMINATOR === '1') return wide;
  if (typeof data?.gateInjected === 'number' && typeof data?.gateRatio === 'number') {
    return {
      injected: data.gateInjected,
      recalled: data.gateRecalled,
      ratio: data.gateRatio,
      hookScoped: true,
    };
  }
  return wide;
}

// True iff this session's stats satisfy the ratio-nag gate (low cite-recall with
// enough injection volume to judge). Shared by buildCiteRecallNudge (decide to
// nag) and nextCiteLowStreak (decide to keep silencing).
function ratioGateFires(rawData, env) {
  const data = gateStats(rawData, env);
  // `Number(x) || d` was NaN-safe but swallowed an explicit 0, and 0 is meaningful
  // on BOTH knobs: threshold 0 means "never nag on ratio", min-injected 0 means "no
  // volume requirement". Neither was reachable through the env before.
  // D#19: 0.6 → 0.4. Chosen off the hook-injected distribution measured 2026-09-08 on
  // this machine's 69 transcripts (n=14 qualifying: p25 0.333, median 0.429, p75 0.5),
  // where 0.4 fires on 6/14 = 43% — often enough to be a signal, rarely enough that
  // lowStreak resets and the surface survives. Stamped rather than presented as
  // calibrated: n=14 is small and the corpus grows every session.
  const threshold = envNumber(env.CLAUDE_MEM_CITE_NUDGE_THRESHOLD, {
    name: 'CLAUDE_MEM_CITE_NUDGE_THRESHOLD',
    defaultValue: 0.4,
    min: 0,
    max: 1,
  });
  // No `integer: true` here or on SILENCE_AFTER, deliberately. Both are consumed with
  // `>=` against an integer counter, so a fractional bound works and `2.5` was a usable
  // setting before this release; rejecting it would silently swap a working value for the
  // default. `max: 1` on THRESHOLD is different and stays: `ratio` is
  // recalled/injected.size and cannot exceed 1, so a bound there is the domain, not a
  // preference. Same rule as lib/relevance-floor.mjs — read the bound off the consumer.
  const minInjected = envNumber(env.CLAUDE_MEM_CITE_NUDGE_MIN_INJECTED, {
    name: 'CLAUDE_MEM_CITE_NUDGE_MIN_INJECTED',
    defaultValue: 5,
    min: 0,
  });
  return (
    typeof data?.injected === 'number' &&
    typeof data?.ratio === 'number' &&
    data.injected >= minInjected &&
    data.ratio < threshold
  );
}

// Next consecutive-low-cite streak: increment when the ratio gate fires this
// session, reset to 0 otherwise (recovery, or too few injections to judge).
export function nextCiteLowStreak(priorStreak, stats, env = process.env) {
  const prior = Number.isFinite(priorStreak) ? priorStreak : 0;
  return ratioGateFires(stats, env) ? prior + 1 : 0;
}

/**
 * R11-B-P1-2 — advance the self-silence streak by SESSION, which is the unit the
 * docblock above has always claimed and the code never implemented.
 *
 * `Stop` fires once per assistant TURN, and the writer incremented on every fire, so
 * with a median of ~6 turns per session the default silence-after-3 was reached inside
 * the FIRST session and never recovered. Measured on this machine before the fix:
 * `runtime/cite-recall-dev--claude-mem-lite.json` read lowStreak 58 for a project with
 * 26 transcripts on disk — a per-session counter cannot exceed the session count — and
 * 2 of 3 projects had the cite-#NN nudge permanently silenced.
 *
 * Recomputing from the value the session STARTED at (rather than freezing after the
 * first fire) keeps two properties: a session advances the streak by at most 1, and a
 * citation arriving in a later turn still resets it to 0 — which matters because the
 * whole contract is "cite NEXT time you produce user-visible text".
 *
 * @param {object|null} prev  parsed previous payload, or null when absent/unreadable
 * @param {string|null} ccSessionId  current CC session id
 * @returns {{lowStreak: number, streakBase: number, lastStreakSession: string|null}}
 */
export function nextCiteStreakState(prev, ccSessionId, stats, env = process.env) {
  let streakBase = 0;
  if (prev && typeof prev === 'object') {
    if (prev.lastStreakSession === undefined) {
      // Written under the pre-R11 TURN semantics. The stored number counted Stop fires,
      // so it is not convertible to sessions — discard it once, here, rather than
      // leaving every existing install permanently silenced by a number that never
      // meant what it was read as.
      streakBase = 0;
    } else if (ccSessionId && prev.lastStreakSession === ccSessionId) {
      streakBase = Number(prev.streakBase) || 0;
    } else {
      streakBase = Number(prev.lowStreak) || 0;
    }
  }
  return {
    lowStreak: nextCiteLowStreak(streakBase, stats, env),
    streakBase,
    // null when there is no CC session to key on: the same-session branch above then
    // never matches, so those invocations keep the old per-fire behaviour. There is no
    // session identity available to do better, and the field's presence is what tells a
    // later read that this file is post-R11.
    lastStreakSession: ccSessionId || null,
  };
}

// Env opt-outs:
//   • CLAUDE_MEM_NO_CITE_NUDGE=1 — disables BOTH gates (full silence)
//   • CLAUDE_MEM_CITE_NUDGE_THRESHOLD — ratio gate threshold (default 0.4)
//   • CLAUDE_MEM_CITE_NUDGE_WIDE_DENOMINATOR=1 — judge the wide computeCiteRecall
//     ratio instead of the hook-injected one (pre-v6.6.0 behaviour)
//   • CLAUDE_MEM_CITE_NUDGE_MIN_INJECTED — ratio gate min-volume (default 5)
//   • CLAUDE_MEM_CITE_NUDGE_SILENCE_AFTER — consecutive-low streak before the
//     ratio nag self-silences (default 3; 0 = never silence)
export function buildCiteRecallNudge(project, runtimeDir, env = process.env) {
  if (env.CLAUDE_MEM_NO_CITE_NUDGE === '1') return '';
  try {
    const path = citeRecallPathFor(runtimeDir, project);
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    // Garbage here used to become NaN, and `NaN >= silenceAfter` is false — so a
    // typo turned the self-silencing OFF, the opposite of every other knob's failure
    // direction and the one a user would never notice. 0 stays valid ("never silence").
    const silenceAfter = envNumber(env.CLAUDE_MEM_CITE_NUDGE_SILENCE_AFTER, {
      name: 'CLAUDE_MEM_CITE_NUDGE_SILENCE_AFTER',
      defaultValue: CITE_NUDGE_SILENCE_AFTER,
      min: 0,
    });
    // silenceAfter > 0 AND the project has ignored the nag that many times running.
    const silenced = silenceAfter > 0 && typeof data.lowStreak === 'number' && data.lowStreak >= silenceAfter;
    const lines = [];
    if (!silenced && ratioGateFires(data, env)) {
      // Report the SAME triple the gate judged — printing the wide numbers next to a
      // narrow verdict is how a surface stops being auditable.
      const g = gateStats(data, env);
      const pct = Math.round(g.ratio * 100);
      // The `(recalled/injected)` parenthetical keeps its exact shape — two guards
      // assert on it, and it is the part a reader scans for.
      const scope = g.hookScoped ? 'of the lessons the hooks injected' : 'of the ids seen';
      lines.push(
        `[mem] Last session cite-recall ${pct}% (${g.recalled}/${g.injected}) ${scope} — when injected lessons (#NN lines) inform your action, cite #NN explicitly so the contract loop stays observable.`,
      );
    }
    if (typeof data.unsaved === 'number' && data.unsaved > 0) {
      lines.push(
        `[mem] Last session: ${data.unsaved} unsaved bugfix-shape edit(s) — if any was a real fix, save now: /lesson --file <path> "<root cause + fix>"`,
      );
    }
    // G3 third gate: the prior session finalized a decision in conversation
    // ("${data.decisionSignal}") but made no mem_save/mem_defer write — surface
    // once while the handoff context still makes recovery actionable.
    if (typeof data.decisionSignal === 'string' && data.decisionSignal.length > 0) {
      lines.push(
        `[mem] ⚠ Last session mentioned a finalized decision ("${data.decisionSignal}") but persisted nothing — if it should survive /clear, capture it now: mem_save(type="decision", …) or mem_defer.`,
      );
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

export function loadCiteBackForEpisode(episode, runtimeDir) {
  if (!episode || !episode.sessionId || !runtimeDir) return null;
  let cooldown;
  try {
    cooldown = JSON.parse(readFileSync(cooldownPathFor(episode.sessionId, runtimeDir), 'utf8'));
  } catch {
    return null;
  }
  return buildCiteBackHint(episode, cooldown);
}

// ─── extractCiteBackSignals (P5 ①) ──────────────────────────────────────────
// Stop-time positive-citation signal. Scans the transcript for cite-back hint
// emissions (PostToolUse attachment.stdout carrying CITE_BACK_HINT_LEADER — the
// same source countUnsavedBugfixShape reads) and collects the `#NN` lesson ids
// they name. Each id is an observation whose warned file the agent actually
// EDITED this session — a behavioral citation even when the agent never typed
// #NN. The Stop handler unions these into the cited set passed to
// applyCitationDecay (lib/citation-tracker.mjs), so acting on a lesson promotes
// it and lifts the project's adoption rate. Returns an empty set on missing path.
// The ids collected here are unioned into the SAME cited set applyCitationDecay reads,
// so this caliber must be the extractor's own — imported, not a sixth hand-copy.
const CITE_BACK_ID_RE = citationIdRe();

export function extractCiteBackSignals(transcriptPath) {
  const ids = new Set();
  for (const entry of readTranscriptEntries(transcriptPath)) {
    if (entry.type !== 'attachment') continue;
    const stdout = entry.attachment?.stdout || '';
    if (!stdout.includes(CITE_BACK_HINT_LEADER)) continue;
    CITE_BACK_ID_RE.lastIndex = 0;
    let m;
    while ((m = CITE_BACK_ID_RE.exec(stdout))) {
      const id = Number(m[1]);
      if (Number.isInteger(id) && id > 0 && id < 1e7) ids.add(id);
    }
  }
  return ids;
}
