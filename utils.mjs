// claude-mem-lite shared utilities
// Used by server.mjs, hook.mjs, and tests

import { basename, dirname } from 'path';
import { execSync } from 'child_process';
import { buildLowSignalRegex } from './lib/low-signal-patterns.mjs';
// Local binding for internal use: the `export … from './secret-scrub.mjs'` re-export below
// is a pass-through and creates no binding in this module's scope.
import { scrubSecrets as _scrubSecrets } from './secret-scrub.mjs';

// ─── Re-exports from extracted modules ──────────────────────────────────────
// Backward compatibility: consumers that predate the extraction import from utils.mjs.
//
// The barrel carries what in-tree code actually imports THROUGH it, and nothing else.
// "Backward compatible" here means compatible with this repo's own call sites: there is no
// `main`/`exports` in package.json, so nothing outside the tree can import this module, and
// a re-export with no importer is not a compatibility guarantee — it is a name knip has to
// keep reporting. Eleven were dropped 2026-09-14 after both knip (whose entry set includes
// tests, so a test-only consumer would have kept them) and a per-name import scan covering
// named, namespace, dynamic and re-export forms agreed nothing imports them from here.
// Each one is still exported by its own leaf module, where its real callers import it.
// Same disposal the `extractResponseFromError` docblock records for the same reason.
export {
  DECAY_HALF_LIFE_BY_TYPE,
  DEFAULT_DECAY_HALF_LIFE_MS,
  OBS_BM25,
  SESS_BM25,
  EVT_BM25,
  TYPE_QUALITY_CASE,
  OBS_FTS_COLUMNS,
  notLowSignalTitleClause,
  noisePenaltyClause,
} from './scoring-sql.mjs';
export { cjkBigrams, sanitizeFtsQuery, ftsQueryTokens, relaxFtsQueryToOr } from './nlp.mjs';
export { inferProject } from './project-utils.mjs';
export { scrubSecrets } from './secret-scrub.mjs';
export { stripPrivate } from './lib/private-strip.mjs';
export {
  truncate,
  queryLabel,
  typeIcon,
  fmtDate,
  fmtTime,
  isoWeekKey,
  formatErrorRecallHints,
  neutralizeContextDelimiters,
  safeText,
  normalizeInline,
} from './format-utils.mjs';
export { computeMinHash, estimateJaccardFromMinHash, jaccardSimilarity } from './hash-utils.mjs';
export {
  detectBashSignificance,
  extractErrorKeywords,
  extractFilePaths,
  stripTestSuffix,
} from './bash-utils.mjs';

// Internal imports for functions that remain in this module
import { normalizeInline, truncate } from './format-utils.mjs';
import { stripPrivate } from './lib/private-strip.mjs';
import { stripTestSuffix } from './bash-utils.mjs';
// Static, and deliberately the dependency-free resolver (node:os + node:path only) —
// debugCatch's sampler must not pull in the DB layer. See its comment below.
import { resolveDataDir } from './lib/resolve-data-dir.mjs';

// ─── Sentinel Values ────────────────────────────────────────────────────────

/** compressed_into sentinel: auto-compressed without merge target */
export const COMPRESSED_AUTO = -1;
/** compressed_into sentinel: pending user-confirmed purge (marked by idle cleanup) */
export const COMPRESSED_PENDING_PURGE = -2;
/**
 * SQL clause: this row is not the KEEPER of a compression group. Every writer of the two
 * sentinels above carries it. Auto-compress backdates a weekly summary to its members' median
 * time, so the age-based hide passes reached it within two runs — and hiding a keeper hides
 * every member compressed into it, so the week went unsearchable (E2E round 2026-09-29).
 * Non-correlated on purpose: SQLite materializes the list once instead of scanning per row.
 */
export const NOT_COMPRESSION_KEEPER_SQL =
  'id NOT IN (SELECT compressed_into FROM observations WHERE compressed_into > 0)';

// ─── Path Safety ──────────────────────────────────────────────────────────

// `isPathConfined` lived here until 2026-09. Its consumers were the skill-registry
// enrichment confinement gate and mem_use's managed-path check, both removed with that
// subsystem (docs/audits/20260906-145304.md); keeping the export would have added a dead
// name to the knip baseline — the same call made for `basenameAnySep` below.

// `basenameAnySep` lived here until 2026-08-22. Its sole production consumer was
// `recallForFile` (hook-memory.mjs), which had no callers of its own and was
// deleted the same round; keeping the export would have added a dead name to the
// knip baseline. The behaviour it encoded is NOT gone — it moved into
// lib/file-edge-match.mjs (module-private, so that ~30ms cold-start path stays
// free of this module's child_process import), which is where the split actually
// had to happen: `path.basename` follows the HOST's rules, so on POSIX it returns
// a Windows path unchanged, while observation_files.filename stores either
// separator. tests/win-path-basename.test.mjs asserts it through fileMatchParams.

// ─── Token Estimation ─────────────────────────────────────────────────────

/**
 * Estimate token count for a string.
 * Uses ~4 chars/token for ASCII, ~1.5 chars/token for CJK characters.
 * @param {string} text Input text
 * @returns {number} Estimated token count (minimum 1)
 */
export function estimateTokens(text) {
  const s = text || '';
  if (!s) return 1;
  // Count CJK characters (each ~1 token) vs ASCII (~4 chars/token)
  let cjkCount = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x3000 && c <= 0x303f) ||
      (c >= 0xff00 && c <= 0xffef) ||
      (c >= 0xac00 && c <= 0xd7af)
    ) {
      cjkCount++;
    }
  }
  const asciiLen = s.length - cjkCount;
  return Math.max(1, Math.ceil(asciiLen / 4) + Math.ceil(cjkCount / 1.5));
}

// ─── Importance ──────────────────────────────────────────────────────────────

/**
 * Clamp an importance value to the valid range [1, 3].
 * @param {*} val Raw importance value (may be non-numeric)
 * @returns {number} Clamped integer importance (1, 2, or 3)
 */
export function clampImportance(val) {
  // Coerce numeric strings: an LLM emitting "importance":"2" (quoted) would otherwise
  // collapse to 1, silently dropping its signal. Non-numeric strings → NaN → 1.
  const n = typeof val === 'number' ? val : typeof val === 'string' ? Number(val) : NaN;
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(3, Math.round(n)));
}

/**
 * Compute deterministic importance from episode entries using rule-based heuristics.
 * Checks file patterns (env, migrations, config) and bash significance signals.
 * @param {object} episode Episode with entries array
 * @returns {number} Rule-based importance (1, 2, or 3)
 */
// Tools that produce file edits (used for significance detection, feedback, importance)
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/**
 * The files an episode entry EDITED: an Edit/Write/NotebookEdit entry's paths, or what a
 * Bash command wrote (`bashWrites`, recorded by hook.mjs from extractFileTargets). Every
 * "was this an edit" consumer goes through here or isEditEntry: nine sites asked
 * `EDIT_TOOLS.has(e.tool)`, and on Opus 5.5 82% of file edits went through Bash
 * (docs/audits/20260926-154904-session-history-analysis-r2.md, N1), so each of them saw
 * a session of `sed -i` / python patches as one with no edits at all.
 * @param {object} e episode entry
 * @returns {string[]}
 */
export function entryEditedFiles(e) {
  if (!e) return [];
  if (EDIT_TOOLS.has(e.tool)) return e.files || [];
  if (e.tool === 'Bash' && Array.isArray(e.bashWrites)) return e.bashWrites;
  return [];
}

/** @param {object} e episode entry @returns {boolean} the entry edited a file */
export function isEditEntry(e) {
  return Boolean(e) && (EDIT_TOOLS.has(e.tool) || entryEditedFiles(e).length > 0);
}

/**
 * The files an episode EDITED, and everything else it touched. `episode.files` is every
 * path any entry mentioned — `cat package.json`, `ls src`, a README it skimmed — and it is
 * not the right edge set for a lesson: `files` becomes `files_modified` and the
 * observation_files / events.file_paths recall keys, and the
 * handoff's Key Files. In the sandbox usage evaluation
 * (docs/audits/20260929-sandbox-usage-eval.md) the episode summarizer stored that whole
 * list, so 21 of 79 PreToolUse lesson injections fired on `package.json` and none of the
 * 21 concerned it.
 * @param {{entries?: object[], files?: string[], filesRead?: string[]}} episode
 * @returns {{modified: string[], read: string[]}}
 */
export function splitEpisodeFiles(episode) {
  const modified = new Set();
  const searched = new Set();
  for (const entry of episode?.entries || []) {
    if (!entry?.files) continue;
    // A Bash entry can do both: `cp a b` reads a and writes b.
    const edited = new Set(entryEditedFiles(entry));
    for (const f of entry.files) (edited.has(f) ? modified : searched).add(f);
  }
  // Merge bash-tracked reads and search tool files into filesRead
  const read = new Set([...(episode?.filesRead || []), ...searched]);
  // Remove files that were both searched AND modified — they're modified
  for (const f of modified) read.delete(f);
  return { modified: [...modified], read: [...read] };
}

// Stdin caps for the hook entry points (G19). Two DELIBERATE tiers, not drift:
// full hook payloads carry tool_response bodies (256KB), while the UserPromptSubmit
// search surface caps the prompt itself at 64KB (#9494 huge-prompt guard — search
// relevance gains nothing past that). scripts/pre-agent-inject.js repeats the
// 256KB literal by design: its default-off path must stay import-free.
export const MAX_HOOK_STDIN_BYTES = 256 * 1024;
export const MAX_UPS_PROMPT_BYTES = 64 * 1024;

// Low-signal degraded title patterns — shared by hook-llm.mjs (dedup + importance cap) and hook-handoff.mjs (decision filter)
// Two top-level alternatives:
//   1. ^(prefix1|prefix2|...) — title starts with one of the hook-llm fallback prefixes
//   2. \(error\)$              — title ends with '(error)' (Bug #2 fix: previously this was
//      inside the prefix group with a meaningless $, so only the exact title '(error)' matched.
//      Tool-fragment titles like 'gh release list ... (error)' leaked through.)
//
// β refactor (#7877 applied): derived from lib/low-signal-patterns.mjs so the
// regex path (this) and the SQL NOT LIKE path (scoring-sql.mjs::notLowSignalTitleClause)
// and pre-tool-recall.js inline SQL all share one authoritative pattern list.
// Previously these were hand-mirrored via "keep in sync" comments.
export const LOW_SIGNAL_TITLE = buildLowSignalRegex();

export function computeRuleImportance(episode) {
  let importance = 1;
  const toolTypes = new Set();
  let hasErrorThenEdit = false;
  let lastWasError = false;

  for (const entry of episode.entries) {
    const sig = entry.bashSig;
    const files = entry.files || [];
    toolTypes.add(entry.tool);

    // Track error→edit debug cycle pattern
    if (lastWasError && isEditEntry(entry)) hasErrorThenEdit = true;
    lastWasError = entry.isError || sig?.isError;

    if (sig?.isError && (sig?.isTest || sig?.isBuild)) {
      importance = 3;
      break;
    }
    // Sensitive-file → critical only when the file was EDITED, not merely read or
    // referenced in a bash command (finding #7): reading auth.js / .env / schema.mjs
    // incidentally during an unrelated task must not promote the whole memory to
    // imp=3 and outrank genuine memories in top-K injection.
    const edited = entryEditedFiles(entry);
    if (edited.some((f) => /\.(env|pem|key)$|\/auth\.|\/credential|\/password/i.test(f))) {
      importance = 3;
      break;
    }
    if (edited.some((f) => /migration|schema\.|prisma|alembic/i.test(f))) {
      importance = 3;
      break;
    }
    if (sig?.isError && importance < 2) importance = 2;
    if (sig?.isGit && importance < 2) importance = 2;
    if (sig?.isDeploy && importance < 2) importance = 2;
    if (
      files.some((f) =>
        /\.config\.|tsconfig|Dockerfile|docker-compose|package\.json|\.yml$|\.yaml$/i.test(basename(f)),
      ) &&
      importance < 2
    )
      importance = 2;
  }

  // Debug cycle: error followed by edit = active debugging
  if (hasErrorThenEdit && importance < 2) importance = 2;
  // Broad change: many files touched (8+ indicates significant scope)
  if ((episode.files || []).length >= 8 && importance < 2) importance = 2;

  return importance;
}

// ─── Episode Logic ───────────────────────────────────────────────────────────

/**
 * Check if new files are related to an existing episode's file set.
 * Considers exact match, directory overlap, and test-sibling relationships.
 * @param {object} episode Episode with files array
 * @param {string[]} newFiles Array of file paths to check
 * @returns {boolean} true if any file is related to the episode
 */
export function isRelatedToEpisode(episode, newFiles) {
  // No files (Bash, Grep without file context) → always related
  if (newFiles.length === 0) return true;
  if (episode.files.length === 0) return true;
  // Check file, directory, or test-sibling overlap
  for (const nf of newFiles) {
    for (const ef of episode.files) {
      if (nf === ef) return true;
      if (dirname(nf) === dirname(ef)) return true;
      // Test file ↔ source file (auth.ts ↔ auth.test.ts across directories)
      if (stripTestSuffix(nf) === stripTestSuffix(ef)) return true;
    }
  }
  return false;
}

// ─── Entry Description ──────────────────────────────────────────────────────

/**
 * Generate a human-readable description of a tool invocation for episode entries.
 * @param {string} toolName Name of the tool (Edit, Write, Bash, etc.)
 * @param {object} input Tool input parameters
 * @param {string} resp Tool response text
 * @param {object} [opts] Optional signals from detectBashSignificance
 * @param {boolean} [opts.isError] If provided, overrides inline error regex detection
 * @returns {string} Concise description of the action
 */
// SEC-3 (2026-08-29 audit): scrub BEFORE truncating, inside the function that truncates.
//
// The caller wraps this whole result in scrubSecrets(), which is one step too late: every
// field below is already cut to 40-60 characters by then, so a secret straddling the cut
// has lost the tail its value-length-gated pattern needs and the head survives verbatim.
// The prompt path fixed this ordering (hook.mjs) and this path kept the old one.
//
// The scrub input is windowed rather than whole: `resp` is an uncapped tool response (a
// Bash stdout can be megabytes) and this runs on every PostToolUse. 4096 is two orders of
// magnitude above the longest cut here, so a secret that begins before the cut is still
// seen whole by the patterns, at bounded cost.
const DESC_SCRUB_WINDOW = 4096;

// Every field is cut strictly around private spans: closed `<private>` spans are redacted across
// the WHOLE input first (one linear pass; hook input is capped at 256 KiB), then the window stops
// before the first remaining `<private>` or private-key BEGIN, so no field shows a span whose end
// is out of view. Before v6.19.0 an unclosed opener in the window (a Grep line
// `notes.md:3:<private>bank pin 4412`) was shown as written (v6.19.0 pre-tag reviews P3-1, r3 P2-1).
// A `</private>` or private-key END that comes first is a span whose START is out of view (a
// nested span, `tail key.pem`), so everything before it may be its inside: the field shows nothing
// (round-3 P3-1). The PEM half is case-sensitive, like the scrubber's PEM pattern. The tag half
// takes the whitespace and attributes lib/private-strip.mjs takes (D13): bare-only let a stray
// `</private >` or `</private reason="x">` show the text before it (D#208).
const PRIVATE_MARK_RE =
  /<\/?[Pp][Rr][Ii][Vv][Aa][Tt][Ee](?:\s[^<>]*)?>|-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY/;
// A window edge that cuts a token leaves a fragment shorter than its pattern needs (`ghp_` and 12
// of its 36 characters), and whitespace collapsing can bring it into view: the cut token is
// dropped (defect review P3-6, round-3 P3-4/P3-6). A head window with no whitespace keeps it: its
// start is intact and it is the only part shown. A tail window with no whitespace is all one cut token.
const isWs = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || /\s/.test(c);
function dropCutTokenAtEnd(win, next) {
  if (next === undefined || isWs(next)) return win;
  let i = win.length;
  while (i > 0 && !isWs(win[i - 1])) i--;
  return i > 0 ? win.slice(0, i) : win;
}
function dropCutTokenAtStart(win, prev) {
  if (prev === undefined || isWs(prev)) return win;
  let i = 0;
  while (i < win.length && !isWs(win[i])) i++;
  return win.slice(i);
}
function scrubTruncate(str, max, window = DESC_SCRUB_WINDOW) {
  if (typeof str !== 'string' || str === '') return truncate(str, max);
  const stripped = stripPrivate(str);
  let win = stripped.slice(0, window);
  const mark = PRIVATE_MARK_RE.exec(win);
  if (mark) win = mark[0][1] === '/' || mark[0].startsWith('-----END') ? '' : win.slice(0, mark.index);
  else win = dropCutTokenAtEnd(win, stripped[window]);
  // The window edge can split a surrogate pair; truncate only guards a cut it makes itself.
  if (/[\uD800-\uDBFF]$/.test(win)) win = win.slice(0, -1);
  return truncate(_scrubSecrets(win), max);
}

// Head+tail cut for command output. A check usually prints its verdict last ("...parsed: 0",
// "3 passed"); a head-only cut hands the episode summarizer an unresolved-looking fragment,
// and it has written a bugfix narrative for a check that passed. The tail comes from its own
// scrub window at the END of the original string: taking it from the head window would drop
// the verdict of any output longer than DESC_SCRUB_WINDOW.
//
// Output with a private span anywhere in it (a `<private>` tag or a PEM private-key marker) shows
// no tail, only v6.18.0's 60-character head (cut as above). The tail is scrubbed in its own
// window, which cannot see a span that crosses its edge, and pairing the markers per window
// stored span text two ways in the v6.19.0 pre-tag review (a cut inside a closed `<private>`, a
// key with no END more than 4096 characters back).
// Any `<private` or `</private` followed by whitespace or `>`: the tag grammar
// lib/private-strip.mjs accepts, attributes included (D13), and a little more. Broader only costs
// a shorter description; narrower showed an unclosed `<private reason="…">`'s content in the tail.
const PRIVATE_TAG_HINT_RE = /<\/?private[\s>]/i;
const HEAD_ONLY_MAX = 60;
// The tail window is scrubbed with TAIL_CONTEXT characters before it, which are then dropped: a
// label cut by the window's edge (`pass|word: <value>`) is seen whole, so its value is not left
// unlabelled at the window's start, where whitespace collapsing can bring it into view (v6.19.1
// pre-tag review F1). A replacement inside the context moves the cut by its length change; the
// token the cut lands in is dropped either way.
const TAIL_CONTEXT = 256;
function scrubTailWindow(str, window) {
  const scrubbed = _scrubSecrets(str.slice(-(window + TAIL_CONTEXT)));
  return dropCutTokenAtStart(scrubbed.slice(TAIL_CONTEXT), scrubbed[TAIL_CONTEXT - 1]);
}
const oneSpace = (s) => s.replace(/\s+/g, ' ');
// The early return needs the WHOLE output inside the head window: a long output whose first
// 4096 characters collapse to a few (whitespace) still has a tail to show (v6.19.0 pre-tag
// claims review F2).
function scrubTruncateEnds(str, max) {
  if (typeof str === 'string' && (str.includes('PRIVATE KEY') || PRIVATE_TAG_HINT_RE.test(str))) {
    return scrubTruncate(str, HEAD_ONLY_MAX);
  }
  // Up to two windows long, one window covers the whole output: two overlapping windows showed
  // the same text twice (delta review P3-4).
  const window =
    typeof str === 'string' && str.length <= 2 * DESC_SCRUB_WINDOW
      ? 2 * DESC_SCRUB_WINDOW
      : DESC_SCRUB_WINDOW;
  // Whitespace runs are one space: a blank-line run no longer spends the budget (or, before the
  // one-window rule, hid behind the window edge).
  const flat = oneSpace(scrubTruncate(str, window, window));
  const whole = typeof str !== 'string' || str.length <= window;
  if (whole && flat.length <= max) return flat;
  const tailLen = Math.floor(max / 2) - 1;
  const tailSrc = whole ? flat : oneSpace(normalizeInline(scrubTailWindow(str, window)));
  if (tailSrc === '') return truncate(flat, max);
  // Drop a lone low surrogate the tail's cut may start on.
  const tail = tailSrc.slice(-tailLen).replace(/^[\uDC00-\uDFFF]/, '');
  // A head short enough to escape truncate's own "…" still gets one before the tail.
  const budget = max - tailLen;
  let head = truncate(flat, budget);
  if (!head.endsWith('…')) head = head.length < budget ? `${head}…` : truncate(flat, budget - 1);
  return head + tail;
}

export function makeEntryDesc(toolName, input, resp, opts) {
  switch (toolName) {
    case 'Edit':
      return `${basename(input.file_path || '')}: "${scrubTruncate(input.old_string || '', 40)}" → "${scrubTruncate(input.new_string || '', 40)}"`;
    case 'Write':
      return `Created ${basename(input.file_path || '')} (${(input.content || '').length} chars)`;
    case 'NotebookEdit':
      return `Notebook cell: ${scrubTruncate(input.new_source || '', 60)}`;
    case 'Bash': {
      const cmd = scrubTruncate(input.command || '', 50);
      // Use caller-provided bashSig.isError (word-boundary aware) when available;
      // fall back to inline regex only for standalone callers (tests, etc.)
      const isErr =
        opts?.isError ??
        (/\berror\b|\bfail(ed|ure)?\b|\bexception\b|\bpanic\b/i.test(resp) && resp.length > 30);
      // A silent command (a `sed -i`, a heredoc write) has no output to show.
      if (!resp) return cmd;
      const snippet = scrubTruncateEnds(resp, 100);
      return isErr ? `${cmd} → ERROR: ${snippet}` : `${cmd} → ${snippet}`;
    }
    case 'Grep':
      return `Search "${scrubTruncate(input.pattern || '', 20)}" → ${scrubTruncate(resp, 60)}`;
    case 'LSP':
      return `${input.operation || ''} ${basename(input.filePath || '')}`;
    case 'Task':
    case 'Agent':
      return scrubTruncate(input.description || '', 60);
    case 'WebSearch':
      return `Web: ${scrubTruncate(input.query || '', 50)}`;
    case 'WebFetch':
      return `Fetch: ${scrubTruncate(input.url || '', 50)}`;
    default:
      return `${toolName}: ${scrubTruncate(resp, 50)}`;
  }
}

// ─── Structured Logging ──────────────────────────────────────────────────────

/**
 * Emit a structured log line gated by CLAUDE_MEM_DEBUG.
 * Format: [claude-mem-lite] [ISO timestamp] [LEVEL] context: message
 * @param {'DEBUG'|'WARN'|'ERROR'} level Log severity
 * @param {string} context Module or function name
 * @param {string} msg Human-readable message
 */
export function debugLog(level, context, msg) {
  if (!process.env.CLAUDE_MEM_DEBUG) return;
  const ts = new Date().toISOString();
  console.error(`[claude-mem-lite] [${ts}] [${level}] ${context}: ${msg}`);
}

/**
 * Log a caught error at ERROR level (includes stack trace when available).
 * Gated by CLAUDE_MEM_DEBUG for stderr output. Separately, if
 * `CLAUDE_MEM_CATCH_SAMPLE` (float 0..1) is set, a random fraction of caught
 * errors get appended to `$DB_DIR/errors/YYYY-MM-DD.jsonl` — observable
 * residue for otherwise-silent swallowed errors (see lib/err-sampler.mjs).
 * Use in catch blocks for non-fatal errors.
 * @param {Error|unknown} e The caught error
 * @param {string} context Module or function name for attribution
 */
export function debugCatch(e, context) {
  if (process.env.CLAUDE_MEM_DEBUG) {
    const ts = new Date().toISOString();
    console.error(`[claude-mem-lite] [${ts}] [ERROR] ${context}:`, e?.stack || e?.message || e);
  }
  // Sampled-to-disk surface for post-mortem. Lazy-loaded so fs-less paths
  // don't pay the module cost; wrapped in try so sampler faults never crash
  // the caller (debugCatch is the error-handler-of-last-resort path).
  //
  // The data dir comes from lib/resolve-data-dir.mjs (imports: node:os, node:path) and
  // NOT from schema.mjs's DB_DIR. This is the last-resort error path, so it must not
  // inherit the DB layer's import graph: with schema.mjs unresolvable, the sampler wrote
  // NOTHING — the trail meant to explain a broken install disappeared with it (verified
  // by blocking the specifier; tests/debug-catch-sampler-deps.test.mjs). Resolving at
  // call time also honours a data dir redirected after module load, which DB_DIR (a
  // load-time constant) does not.
  if (process.env.CLAUDE_MEM_CATCH_SAMPLE) {
    (async () => {
      try {
        const { maybeSampleError } = await import('./lib/err-sampler.mjs');
        maybeSampleError(e, context, resolveDataDir(process.env.CLAUDE_MEM_DIR));
      } catch {
        /* sampler dynamic-import fault must not propagate */
      }
    })();
  }
}

// ─── JSON Parsing ────────────────────────────────────────────────────────────

/**
 * Extract the first brace-balanced JSON object substring from text, honoring strings
 * and escapes so braces inside string values don't throw off the depth count. Returns
 * null when there's no `{` or no balanced close. Used to recover a valid leading object
 * when the LLM wrapped it in prose that ALSO contains braces — the greedy `{[\s\S]*}`
 * fallback spans first-`{` to last-`}` and is defeated by an unrelated trailing `{…}`.
 */
function firstBalancedJsonObject(text) {
  // Anchor on whichever structural opener comes first — `{` (object) or `[` (array) —
  // so a prose-wrapped top-level array isn't truncated to its first inner object.
  const braceAt = text.indexOf('{');
  const brackAt = text.indexOf('[');
  let start, open, close;
  if (braceAt === -1 && brackAt === -1) return null;
  if (brackAt !== -1 && (braceAt === -1 || brackAt < braceAt)) {
    start = brackAt;
    open = '[';
    close = ']';
  } else {
    start = braceAt;
    open = '{';
    close = '}';
  }
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Parse JSON from LLM output, handling markdown fences and embedded objects.
 * Tries: direct parse → fenced code block → first balanced object → greedy regex.
 * @param {string} text Raw LLM output text
 * @returns {object|null} Parsed JSON object or null on failure
 */
export function parseJsonFromLLM(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  // No `\s*` around the lazy capture: `\s*([\s\S]*?)\s*` catastrophically backtracks
  // (O(n²)) on a fence + long whitespace + no closing fence — a ~5KB partial buffer hung
  // the CLI-timeout salvage path for 10+s (round-5 review). `([\s\S]*?)```` is a single
  // O(n) lazy scan; JSON.parse tolerates the surrounding whitespace the trim used to strip.
  const fenced = text.match(/```(?:json)?([\s\S]*?)```/);
  if (fenced)
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  // First balanced object — survives unfenced output wrapped in brace-containing prose.
  const balanced = firstBalancedJsonObject(text);
  if (balanced)
    try {
      return JSON.parse(balanced);
    } catch {}
  // Last-resort span from the first `{` to the last `}` — handles a payload that isn't the
  // FIRST balanced object. Resolved via index scan (O(n)) rather than the greedy
  // /\{[\s\S]*\}/, which backtracks O(n²) across k unclosed opening braces (a synthetic
  // "{{{…" with no close made the regex O(n²); LLM outputs are bounded so it wasn't
  // exploitable — defense in depth). Behaviorally identical: the greedy match anchors on the
  // first `{` that has any `}` after it and, being greedy, ends at the last `}`.
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {}
  }
  return null;
}

// ─── Handoff Utilities ──────────────────────────────────────────────────────

/** Stop words for handoff keyword extraction (broader than ERROR_STOP_WORDS). */
// Module-private since v6.6.0: hook-memory.mjs was its last importer, and it went away
// with extractQueryTerms when the coverage denominator moved to the shared term source.
const HANDOFF_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'are',
  'was',
  'were',
  'been',
  'have',
  'has',
  'had',
  'does',
  'did',
  'will',
  'would',
  'should',
  'could',
  'can',
  'may',
  'must',
  'not',
  'but',
  'its',
  'all',
  'any',
  'each',
  'some',
  'into',
  'over',
  'after',
  'before',
  'between',
  'about',
  'also',
  'just',
  'then',
  'than',
  'when',
  'where',
  'how',
  'what',
  'which',
  'who',
  'why',
  'here',
  'there',
  'more',
  'very',
  'only',
  'still',
  'now',
  'new',
  'old',
  'get',
  'got',
  'set',
  'true',
  'false',
  'null',
  'undefined',
  'function',
  'return',
  'const',
  'let',
  'var',
  'import',
  'export',
  'default',
  'class',
  'async',
  'await',
  'try',
  'catch',
]);

/**
 * Tokenize text for handoff keyword matching.
 * Splits on whitespace/punctuation, lowercases, filters short tokens.
 * @param {string} text Input text
 * @returns {string[]} Array of lowercase tokens (length >= 3)
 */
export function tokenizeHandoff(text) {
  if (!text) return [];
  return text
    .split(/[\s,;:.()[\]{}'"`<>→|/\\#@!?=+*&^%$~]+/)
    .map((w) => w.toLowerCase().replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w.length >= 3);
}

/**
 * Check if a token is a "specific" term (file name, identifier, etc.)
 * that should get double weight in intent matching.
 * @param {string} token Lowercase token
 * @returns {boolean}
 */
export function isSpecificTerm(token) {
  if (!token || token.length < 3) return false;
  if (token.includes('_') || token.includes('-')) return true;
  if (HANDOFF_STOP_WORDS.has(token)) return false;
  return token.length >= 4 && !/^\d+$/.test(token);
}

/**
 * Detect prompts whose content is purely workflow/control language with no
 * subject substance — "继续", "提交代码", "/exit", "commit and push", etc.
 *
 * Rationale: `buildAndSaveHandoff` writes user-prompt text into `working_on`
 * verbatim. When a session's only prompt is a meta-trigger, the resumed
 * session sees `Working On: 继续前面的工作` — self-referential garbage. This
 * detector lets the writer filter such prompts before they pollute the field.
 *
 * Strategy: strip a curated set of trigger keywords (zh + en) plus
 * punctuation; if <4 chars of substantive content remain, the prompt is meta.
 * Threshold tuned against real `user_prompts` samples — keeps prompts like
 * "提交代码，发新版本，检查线上有没有错误" (real verification subject) while
 * dropping bare "/exit" / "继续" / "commit".
 *
 * @param {string} text Prompt text
 * @returns {boolean} true if the prompt is meta-trigger only
 */
export function isMetaTriggerPrompt(text) {
  if (!text || typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  const stripped = trimmed
    .replace(/继续(前面|之前|刚才|上次)?(的)?(工作|任务|话题|讨论)?/g, '')
    .replace(/提交(代码|了|完|过)?(并)?(发布)?/g, '')
    .replace(/退出/g, '')
    .replace(/发(布|新版本|个新版本)/g, '')
    .replace(/新开(了)?(一个)?(会话|session)?/g, '')
    .replace(/保存(进度|状态|工作|代码)?/g, '')
    .replace(/接着(干|做|来|继续)?/g, '')
    .replace(/上次(到哪了|说到哪了)?/g, '')
    .replace(/总结一下|复盘一下/g, '')
    .replace(/前面(的)?(工作|话题|讨论|内容)/g, '')
    // R3 H-M2: control phrases named in lesson #8287 / common continuations. Phrase-anchored
    // (or bare suffix/prefix) so a real subject that merely contains one keeps its other tokens.
    .replace(/停了|停不下来/g, '')
    .replace(/怎么(回事|了|样了|停的)?/g, '')
    .replace(/再来(一次|一遍|一下)?/g, '')
    .replace(/\/?(clear|exit)\b/gi, '')
    .replace(/\b(go on|go ahead|keep going|carry on|proceed|why(?:'?d| did) you stop)\b/gi, '')
    .replace(/\b(commit|continue|resume|push|save|restart|exit|next)\b/gi, '')
    .replace(/[，,。.!！?？:：;；()（）【】[\]\s/\\-]+/g, '')
    .trim();

  return stripped.length < 4;
}

/**
 * Extract match keywords from text and file paths for handoff intent matching.
 * @param {string} text Combined text from prompts, observations, etc.
 * @param {string[]} files Array of file paths
 * @returns {string} Space-separated keywords
 */
export function extractMatchKeywords(text, files) {
  const terms = new Set();
  for (const f of files) {
    const base = basename(f).replace(/\.[^.]+$/, '');
    if (base.length >= 3) terms.add(base.toLowerCase());
  }
  const words = tokenizeHandoff(text);
  for (const w of words) {
    if (!HANDOFF_STOP_WORDS.has(w)) terms.add(w);
  }
  return [...terms].join(' ');
}

// ─── Git Branch Detection ──────────────────────────────────────────────────

let _cachedBranch;
let _branchCacheTime = 0;
const BRANCH_CACHE_TTL = 60000; // 60s TTL for long-running MCP server process
export function getCurrentBranch() {
  const now = Date.now();
  if (_cachedBranch !== undefined && now - _branchCacheTime < BRANCH_CACHE_TTL) return _cachedBranch;
  try {
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    _cachedBranch = result && result !== 'HEAD' ? result : null;
  } catch {
    _cachedBranch = null;
  }
  _branchCacheTime = now;
  return _cachedBranch;
}
