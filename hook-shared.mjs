// claude-mem-lite: Shared infrastructure for hook.mjs and hook-llm.mjs
// Constants, session management, DB access, LLM calls, process utilities

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync, unlinkSync, chmodSync } from 'fs';
import { inferProject, debugCatch } from './utils.mjs';
import { CITE_RECALL_FILE_PREFIX } from './lib/cite-recall-path.mjs';
import { ensureDbWithWalRecovery, DB_DIR } from './schema.mjs';
import { resolveRuntimeDir } from './lib/resolve-data-dir.mjs';
// Pure-`node:`/local module (it imports only binding-probe + native-binding-hint, and
// neither imports this file) — no cycle.
import { recordHookError } from './lib/hook-telemetry.mjs';
import { execClaudeCliSync, resolveModel as resolveModelShared, flattenForCLI as _flattenForCLI, detectMode as detectLLMMode, callHaiku, BG_LLM_TIMEOUT_MS } from './haiku-client.mjs';
// Phase D: invited-memory sentinel detection. memdir.mjs/claudemd.mjs only pull in
// fs/path/os/crypto; adopt-content.mjs is pure strings. No circular deps —
// neither imports hook-shared.
import { memdirPath as _memdirPath, isAdopted as _isAdoptedMemdir } from './memdir.mjs';
import { isAdopted as _isAdoptedClaudeMd } from './claudemd.mjs';
import { PLUGIN_SLUG as _PLUGIN_SLUG } from './adopt-content.mjs';

import { DAY_MS } from './lib/time-constants.mjs';
// ─── Constants ────────────────────────────────────────────────────────────────

// P1-14: one resolver, so this module honours CLAUDE_MEM_RUNTIME_DIR like the five
// standalone hook scripts already did. It did not, and hook.mjs / server.mjs /
// hook-context.mjs / hook-episode.mjs all take RUNTIME_DIR from here — so the override
// split the runtime dir in half instead of relocating it.
export const RUNTIME_DIR = resolveRuntimeDir(DB_DIR);
export const SCRIPT_PATH = process.argv[1];

// Timing constants
export const EPISODE_BUFFER_SIZE = 10;
export const EPISODE_TIME_GAP_MS = 5 * 60 * 1000;       // 5 min
export const SESSION_EXPIRY_MS = 12 * 60 * 60 * 1000;    // 12h
export const STALE_SESSION_MS = 24 * 60 * 60 * 1000;     // 24h
export const STALE_LOCK_MS = 30000;                       // 30s

// The background-maintenance mutex, defined HERE next to the sweeper policy it has to
// escape. cleanStaleLockFiles() below unlinks any `*.lock` older than STALE_LOCK_MS
// WITHOUT checking whether the holder is alive — right for the episode lock's millisecond
// critical section, fatal for a maintenance pass that runs for seconds to minutes. The
// name therefore ends in `.proclock`, and `tests/auto-maintain-proc-lock.test.mjs` asserts
// that against THIS constant rather than a re-typed copy: the first version of that test
// built its own path from a literal, so renaming the lock left it green with the hazard
// back. proc-lock's own staleness policy (age OR provably-dead pid) is the correct one.
export const AUTO_MAINTAIN_LOCK = 'auto-maintain.proclock';
export const DEDUP_WINDOW_MS = 5 * 60 * 1000;            // 5 min (title dedup)
export const RELATED_OBS_WINDOW_MS = 7 * DAY_MS;       // 7 days
export const FALLBACK_OBS_WINDOW_MS = RELATED_OBS_WINDOW_MS; // same window
// Candidate rows the SessionStart Key Context surface considers (hook-context.mjs
// keyObs; each of the two sections then renders at most 5). The user-prompt
// exclude-set does NOT mirror this query — it reads the ids actually rendered
// from the keyctx marker (D#123 review C-1: query-mirroring suppressed
// <memory-context> injection on quiet/adopted projects where nothing renders).
export const KEY_CONTEXT_LIMIT = 10;

// Phase A (v2.31.3+): MEM_QUIET_HOOKS=1 drops descriptive hook/MCP-instruction
// bodies (File Lessons / Key Context headers, MCP WHEN-TO-USE & decision rules,
// related-memory lesson suffix). Intended for users who adopted invited-memory
// (MEMORY.md sentinel) or who otherwise want minimal hook noise. Function form
// (not const) so modules importing at load time still respect later env sets
// in-process, and tests can toggle per-call. See docs/plans/2026-04-16-invited-memory-pattern.md.
export function isQuietHooks() {
  return process.env.MEM_QUIET_HOOKS === '1';
}

// Phase D (v2.32.1+) → v3.13: if the current project has adopted our steering,
// the contract is already loaded at system-prompt authority — so hook +
// MCP-instruction output can also go quiet. v3.13 moved that contract from the
// memory-dir MEMORY.md sentinel to the project CLAUDE.md managed block, so check
// the new scheme first and keep the legacy memdir sentinel as a fallback (an
// un-migrated project stays quiet through the transition). isQuietHooks (env)
// remains an independent, stronger override.
export function isAdoptedHere(cwd) {
  try {
    const resolved = cwd || process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
    return _isAdoptedClaudeMd(resolved, _PLUGIN_SLUG)
      || _isAdoptedMemdir(_memdirPath(resolved), _PLUGIN_SLUG);
  } catch {
    return false;
  }
}

export function effectiveQuiet(cwd) {
  return isQuietHooks() || isAdoptedHere(cwd);
}

// Handoff system constants
export const HANDOFF_EXPIRY_CLEAR = 6 * 3600000;                // 6 hours (covers lunch/meeting breaks)
export const HANDOFF_EXPIRY_EXIT = 7 * 24 * 60 * 60 * 1000;   // 7 days
export const HANDOFF_ANCHOR_MAX_AGE = 72 * 3600000;             // 72h cap on git_sha anchor — avoids stale-HEAD false positives
export const HANDOFF_MATCH_THRESHOLD = 3;                       // min weighted score
export const CONTINUE_KEYWORDS = /继续|接着|上次|之前的|前面的|刚才|\bcontinue\b|\bresume\b|\bwhere[\s-]+we[\s-]+left\b|\bpick[\s-]+up\b|\bcarry[\s-]+on\b/i;

// Orphan-sweep threshold for `ep-flush-*` / `pending-*` runtime artifacts.
// handleLLMEpisode's worst-case round-trip is ~60s (delay + LLM call + DB
// write); 1h leaves a wide safety margin against deleting an in-flight file.
// Older orphans are crashed workers or pre-shutdown buffers that no live
// caller will ever pick up, so sweeping them on SessionStart is safe.
export const ORPHAN_EPISODE_AGE_MS = 60 * 60 * 1000;

// `reads-<project>.txt` (bash fast-path Read tracker) is consumed by flushEpisode's
// rename-collect on the next edit-flush, NOT by a background worker — so a project
// that reads but never triggers an edit-flush leaves it uncollected and unswept, and
// it grows without bound (the 1h episode threshold is far too eager: a long read-only
// investigation legitimately appends to it for hours). A dedicated 24h floor sweeps
// only genuinely-abandoned trackers (no append AND no flush in a day → its paths are
// stale to any current episode) while leaving every active session's file untouched.
export const ORPHAN_READS_AGE_MS = 24 * 60 * 60 * 1000;

// `ep-<project>.json` — the LIVE episode buffer, one file per project — had no reclamation
// path at all: it is excluded from both marker-GC lists below (correctly: it holds unflushed
// observations, not cache) and `sweepOrphanEpisodeFiles` only ever matched `ep-flush-`.
// A real install on 2026-09-02 held four of them for projects deleted months earlier, the
// oldest 53 days (`ep-tmp--loop-testing-e2e.*.json`, 07-11).
//
// Leaving them is not neutral. `readEpisode` has no staleness gate, so `handleSessionStart`
// unconditionally flushes whatever it finds (hook.mjs "Flush any leftover episode buffer") —
// revisiting such a project injects months-old tool activity into today's memory stamped
// with today's date. The stale buffer is not preserved data, it is data that will be
// mis-dated the moment anyone touches the project again.
//
// 7 days, and the argument is that no LEGITIMATE state needs a buffer to live even one day:
// `EPISODE_TIME_GAP_MS` is 5 min and `SESSION_EXPIRY_MS` is 12 h, so a buffer untouched for
// 7 days outlived its owning session by an order of magnitude. The margin over 12 h is
// deliberate slack for a laptop suspended across a long weekend, not a second threshold with
// its own meaning. Considered and rejected: flushing on sweep instead of deleting — it would
// re-date the content exactly the way the revisit path does, i.e. commit the defect on
// purpose rather than by omission.
//
// Exported as of the pre-tag review for v3.92.0, on this constant's own stated rule ("export
// it the day something needs it"): the sweep alone does NOT close the harm described above.
// `handleSessionStart` flushes the leftover buffer in the FOREGROUND, and the sweeper runs
// later, in a detached auto-maintain worker — so on the revisit itself the mis-dated flush
// happens first and the sweeper then finds nothing. What the sweep delivers is dir-wide
// reclamation of OTHER projects' abandoned buffers; the same-project revisit needs the same
// threshold applied at the flush, which is `hook.mjs`'s importer of this symbol.
// `bufferAgeMs` stays a parameter so a test can pin the sweep threshold without an import.
export const STALE_EPISODE_BUFFER_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Sweep stale `ep-flush-*` / `pending-*` (older than `ageMs`, default 1h),
// `reads-*.txt` (older than `readsAgeMs`, default 24h) and abandoned per-project episode
// buffers `ep-<project>.json` (older than `bufferAgeMs`, default 7d) in `runtimeDir` by
// mtime. `onSweep(name, kind)` is called before each unlink so a caller can log the one
// deletion that discards content rather than residue ('buffer'); it is a callback rather
// than a debugLog here because this module is imported by every hook entry point and stays
// dependency-free. Returns the number of files removed. fs-only — no DB / no network. Used by
// handleSessionStart auto-maintain to prevent the doctor "Stale temp files" warning
// from accumulating across crashes; equivalent to the manual path in
// `node install.mjs cleanup` but age-gated so concurrent in-flight workers / active
// read sessions are never raced.
export function sweepOrphanEpisodeFiles(runtimeDir, { ageMs = ORPHAN_EPISODE_AGE_MS, readsAgeMs = ORPHAN_READS_AGE_MS, bufferAgeMs = STALE_EPISODE_BUFFER_AGE_MS, now = Date.now(), onSweep = () => {} } = {}) {
  let entries;
  try { entries = readdirSync(runtimeDir); } catch { return 0; }
  const cutoff = now - ageMs;
  const readsCutoff = now - readsAgeMs;
  const bufferCutoff = now - bufferAgeMs;
  let count = 0;
  for (const f of entries) {
    // Crash residue: this runtime dir writes four families of temp name, each the middle
    // of a rename-or-unlink pair that leaks if the process dies between the two steps.
    // The predicate covered only `.claim-`, whose comment states the reason it exists —
    // and the other three are that same window (audit FLOW-3):
    //   .claim-   handleStop's lock-contended fallback   (hook.mjs)
    //   .collect- the reads-file rename a flush performs (hook.mjs)
    //   .trim-    the reads-file truncation              (hook.mjs)
    //   .tmp-     every atomic write                     (hook-episode.mjs, atomicWrite)
    // Neither of the old clauses could reach them: `reads-<p>.txt.collect-<ts>` does not
    // end in `.txt`, and `ep-<p>.json.tmp-<pid>` does not start with `ep-flush-`.
    //
    // Anchored to the END of the name, and the reason is not the one first written here.
    // The original note claimed it protected `reads-x.tmp-y.txt` from the short clock; it
    // does not — that name ends in `.txt`, so `isReads` picks the 24h cutoff either way,
    // and dropping the anchor killed no test (caught by a pre-tag reviewer). What the
    // anchor actually protects is the LIVE episode buffer of a project whose sanitized
    // name contains the token: `ep-x.tmp-y.json` matches an unanchored pattern, and would
    // then be swept as residue one hour into a session that is still using it.
    const isCrashResidue = /\.(claim|collect|trim|tmp)-[^.]*$/.test(f);
    const isEpisode = f.startsWith('ep-flush-') || f.startsWith('pending-');
    const isReads = f.startsWith('reads-') && f.endsWith('.txt');
    // The live per-project buffer, on its own 7-day cutoff. `ep-flush-*` is also `ep-`-
    // prefixed AND also ends in `.json`, so the exclusion is load-bearing, not defensive:
    // without it a queued flush file would jump from the 1h cutoff to the 7d one.
    const isStaleBuffer = f.startsWith('ep-') && !f.startsWith('ep-flush-') && f.endsWith('.json');
    if (!isCrashResidue && !isEpisode && !isReads && !isStaleBuffer) continue;
    const full = join(runtimeDir, f);
    try {
      // Residue takes the short cutoff and a live tracker takes the 24h one, with no
      // tie-break needed: residue always APPENDS its suffix, so it never ends in `.txt`
      // and `isReads` is already false for it. (A `&& !isCrashResidue` tie-break was
      // written here first and no mutation could kill it — it was guarding a state the
      // two predicates cannot both be in.) `isStaleBuffer` is in the same position: a
      // residue name ends in `.tmp-<pid>`, never `.json`.
      const fileCutoff = isReads ? readsCutoff : isStaleBuffer ? bufferCutoff : cutoff;
      if (statSync(full).mtimeMs < fileCutoff) {
        try { onSweep(f, isStaleBuffer ? 'buffer' : isReads ? 'reads' : isCrashResidue ? 'residue' : 'episode'); } catch { /* logging must never block the sweep */ }
        unlinkSync(full);
        count++;
      }
    } catch { /* concurrent unlink / permission — ignore */ }
  }
  return count;
}

// ─── Per-project marker GC (P2-15) ───────────────────────────────────────────
// RUNTIME_DIR had three sweeps and a hole. Per-SESSION files age out at 24h
// (hook.mjs) and orphaned episode/read trackers at 1h/24h (above), but the
// per-PROJECT markers — one file per project, written once, never revisited —
// had no reclamation path at all. A live install on 2026-08-16 held 253 files,
// 152 of them past 30 days, including entire families for test sandboxes
// deleted months earlier (session-tmp--sdscc-e2e-*, cite-recall-scratchpad--
// fixture-*) and a .skill-reco-cooldown-* family that nothing had ever swept.
//
// Deliberately a NAMED list rather than a wildcard: these markers share a shape
// but not a meaning. The GC-able ones are caches — delete them and the next
// session re-derives the state (or, for a cooldown, merely allows a suggestion
// sooner). The preserved ones are records of a side effect already performed;
// removing them re-arms it (.auto-adopt-* re-attempts a write into the user's
// project CLAUDE.md, the migration sentinels re-run their one-time work), which
// is a bad trade for the 13-45 bytes each occupies.
export const STALE_PROJECT_MARKER_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Regenerated on demand; safe to lose at any time.
export const GC_PROJECT_MARKER_PREFIXES = Object.freeze([
  'session-',                 // project → memory-session-id pointer
  CITE_RECALL_FILE_PREFIX,    // last session's cite-recall snapshot (nudge input)
  '.skill-cooldown-',         // suggestion throttle timestamp
  '.skill-reco-cooldown-',    // recommendation throttle timestamp
]);

// Records of a completed side effect — never age out. `ep-`/`ep-flush-`/
// `pending-`/`reads-` are absent from BOTH lists on purpose: they all belong to
// sweepOrphanEpisodeFiles, on three cutoffs of their own (1h residue / 24h reads /
// 7d abandoned buffer). `ep-<project>.json` was the one with no cutoff at all until
// audit P1-12 — it is still not marker-GC-able here, because 30 days of unflushed
// observations is far past the point where flushing them would mis-date them.
export const GC_PRESERVED_MARKER_PREFIXES = Object.freeze([
  '.auto-adopt-',
  '.deferred-block-migrated-',
  '.legacy-claude-md-cleaned-',
  // v3.66.1: these two shipped in the GC list for one release and had to come
  // out. Both are version-keyed one-shot migration sentinels written by
  // scripts/setup.sh, and their gate is `! -f <marker>` — deleting one re-runs
  // its migration. `.mcp-dedup-v2.78` gates a block that removes
  // mcpServers.mem / mcpServers["mem-lite"] from the user's ~/.claude.json with
  // a raw writeFileSync (no tmp+rename, no backup), which the repo's own test
  // documents as intentionally one-shot: "If a user later runs `claude mcp add
  // mem ...` themselves, the gate intentionally lets it stand." A 30-day sweep
  // turned that into a recurring purge of a config file we do not own.
  // The mtime never refreshes (the gate skips the block once the file exists),
  // so every install older than 30 days would have lost it on the first
  // SessionStart after upgrading.
  //
  // Why it was missed: the search for writers used `grep --include=*.mjs
  // --include=*.js`, and the writer is a SHELL script. `sentinelPrefixesFromShell`
  // below now derives this class from scripts/*.sh instead of from memory.
  '.mcp-dedup-',
  '.residue-warned-',
]);

/**
 * Marker-name prefixes that scripts/*.sh treats as one-shot sentinels, derived
 * from the shell source rather than restated here. `tests/runtime-marker-gc`
 * asserts none of them is GC-able: a shell-written sentinel is invisible to a
 * JS-only grep, which is exactly how `.mcp-dedup-` reached the GC list.
 *
 * @param {string} shellSource concatenated contents of scripts/*.sh
 * @returns {string[]} prefixes like `.mcp-dedup-`
 */
export function sentinelPrefixesFromShell(shellSource) {
  const out = new Set();
  // Matches `"$DATA_DIR/runtime/.mcp-dedup-v2.78"` and friends: a dotfile under
  // runtime/ whose name carries a version-ish suffix.
  for (const m of String(shellSource || '').matchAll(/runtime\/(\.[a-z0-9-]*?-)v?[0-9][0-9.]*/gi)) {
    out.add(m[1]);
  }
  return [...out];
}

/**
 * Sweep per-project runtime markers older than `ageMs`. fs-only, best-effort,
 * never throws. Returns the number of files removed.
 *
 * The two prefix lists are injectable ONLY so the precedence rule below can be
 * exercised: with the shipped lists they are disjoint, which makes the
 * preserved check redundant today and load-bearing the moment a future family
 * nests inside a GC-able one. Production callers pass neither.
 *
 * @param {string} runtimeDir
 * @param {{ageMs?: number, now?: number, gcPrefixes?: string[], preservedPrefixes?: string[]}} [opts]
 * @returns {number}
 */
export function sweepStaleProjectMarkers(runtimeDir, {
  ageMs = STALE_PROJECT_MARKER_AGE_MS,
  now = Date.now(),
  gcPrefixes = GC_PROJECT_MARKER_PREFIXES,
  preservedPrefixes = GC_PRESERVED_MARKER_PREFIXES,
  env = process.env,
} = {}) {
  // Kill switch (naming mirrors SKIP_COMPRESS / SKIP_OPTIMIZE / SKIP_SAVE_ENRICH):
  // this is the only sweep that deletes files a user might want to inspect, so a
  // released default that reclaims state needs a documented way back out.
  if (env.CLAUDE_MEM_SKIP_MARKER_GC === '1') return 0;
  let entries;
  try { entries = readdirSync(runtimeDir); } catch { return 0; }
  const cutoff = now - ageMs;
  let count = 0;
  for (const f of entries) {
    // Preserved wins on any overlap, so a future prefix added to both lists
    // fails safe (kept) instead of deleting a side-effect record.
    if (preservedPrefixes.some((p) => f.startsWith(p))) continue;
    if (!gcPrefixes.some((p) => f.startsWith(p))) continue;
    const full = join(runtimeDir, f);
    try {
      if (statSync(full).mtimeMs < cutoff) { unlinkSync(full); count++; }
    } catch { /* concurrent unlink / permission / directory — ignore */ }
  }
  return count;
}

// Ensure runtime directory exists AND is owner-only (0700), matching the DB dir
// (schema.mjs). Runtime aux files carry captured file paths + scrubbed activity; on a
// shared host a 0755 dir would let another local user read them. hardenRuntimeFiles()
// (server.mjs) sweeps at MCP-server startup, but hooks routinely run before any server
// exists, so harden here too: create 0700, and chmod a pre-existing dir a prior version
// created at the default umask. A 0700 dir blocks traversal to every file inside,
// current and future, regardless of individual file mode (audit sec P3-2 2026-07-24).
try {
  if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  else chmodSync(RUNTIME_DIR, 0o700);
} catch {}

// ─── Session ID Management ───────────────────────────────────────────────────

export function sessionFile() {
  return join(RUNTIME_DIR, `session-${inferProject()}`);
}

export function getSessionId() {
  try {
    const data = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    if (Date.now() - data.startedAt < SESSION_EXPIRY_MS) return data.id;
  } catch {}
  return createSessionId();
}

export function createSessionId() {
  const project = inferProject();
  const id = `hook-${project}-${randomUUID().slice(0, 8)}`;
  const file = sessionFile();
  const tmp = file + `.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ id, startedAt: Date.now(), project }), { mode: 0o600 });
  renameSync(tmp, file);
  return id;
}

// ─── Database ────────────────────────────────────────────────────────────────

export function openDb() {
  try {
    // WAL-corruption self-heal (was server.mjs-only): without it, hooks stayed
    // silently dead (null DB) on a corrupt WAL until the next MCP server start.
    return ensureDbWithWalRecovery();
  } catch (e) {
    // Still null, still no throw — a hook must never crash the host session, and all
    // eight call sites in hook.mjs are written to no-op on null. But "returned null"
    // used to be the ONLY trace: nothing reached runtime/hook-errors/, so `stats`
    // reported 0 and doctor printed "no recent silent hook breakage" while every
    // capture path was dead (audit B1, 2026-08-14 — the same blindness that hid the
    // v3.60 binding outage for four days). recordHookError is the established sink;
    // scripts/pre-tool-recall.js already logs its own db-open failures this way, and
    // routing through it also flags the native-binding family for the session-start
    // self-heal. The recorder swallows its own errors, so this cannot throw.
    recordHookError('hook-shared:db-open', e, RUNTIME_DIR);
    return null;
  }
}

// ─── LLM (provider-routed: Anthropic API → OpenRouter → claude CLI) ─────────

// Accepts either a plain string (legacy) or {system, user} (defense-in-depth
// against prompt injection from poisoned user_prompts content — cso F#4 fix).
// Provider priority mirrors haiku-client (ANTHROPIC_API_KEY > OPENROUTER_API_KEY
// > CLI): when a key is present, delegate to callHaiku — it owns the Anthropic
// Messages / OpenRouter chat-completions request shapes, uses the system role
// natively, AND degrades to the `claude -p` CLI internally if the keyed provider
// fails (so a region-blocked / out-of-credit key still yields a summary). The
// keyless case shells out to `claude -p` directly here, where flattenForCLI
// renders {system, user} with an explicit data-boundary marker. Returns the raw
// response string (callers run parseJsonFromLLM themselves) or null.
// maxTokens is sized for session-summary / episode JSON (larger than the
// registry/optimize callers' budgets).
export async function callLLM(prompt, timeoutMs = BG_LLM_TIMEOUT_MS) {
  if (detectLLMMode() !== 'cli') {
    const result = await callHaiku(prompt, { timeout: timeoutMs, maxTokens: 2000 });
    return result?.text ?? null;
  }

  const { cli: modelName } = resolveModelShared();
  try {
    // Shared runner with haiku-client.mjs#callModelCLI (rationale there): no
    // transcript persistence, no claudemd hook fan-out, and the one-shot
    // retry-without-flag that keeps this leg alive on an older Claude Code CLI.
    const result = execClaudeCliSync(modelName, { input: _flattenForCLI(prompt), timeout: timeoutMs });
    return result.trim();
  } catch (e) {
    const out = _extractResponseFromError(e);
    if (out) return out;
    debugCatch(e, 'callLLM');
    return null;
  }
}

// ─── Background Spawner ─────────────────────────────────────────────────────

export function spawnBackground(bgEvent, ...extraArgs) {
  const args = [SCRIPT_PATH, bgEvent, ...extraArgs];
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '1' },
    });
    child.on('error', (err) => { debugCatch(err, 'spawnBackground'); });
    child.on('exit', () => {});
    child.unref();
  } catch (err) {
    debugCatch(err, 'spawnBackground');
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Extract partial response from CLI error output (timeout/error recovery).
 * @param {Error} error The caught error from execFileSync
 * @returns {string|null} Extracted JSON string or null
 */
export function _extractResponseFromError(error) {
  const out = error.stdout?.toString?.()?.trim() || error.output?.[1]?.toString?.()?.trim() || '';
  if (out && out.startsWith('{') && out.endsWith('}')) {
    try {
      const parsed = JSON.parse(out);
      // Reject structurally incomplete responses (e.g. truncated mid-output)
      if (typeof parsed !== 'object' || parsed === null || Object.keys(parsed).length === 0) return null;
      return out;
    } catch { return null; }
  }
  return null;
}
