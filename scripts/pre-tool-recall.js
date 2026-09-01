#!/usr/bin/env node
// claude-mem-lite: PreToolUse file recall — injects lessons before Edit/Write
// Lightweight standalone (~30ms): only imports better-sqlite3, fs, path, os,
// and the pure-data lib/low-signal-patterns.mjs (zero runtime deps, ~1ms overhead).
// Safety: readonly DB, exit 0 always, 3s timeout

import { existsSync, readFileSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';
import { injectedIdsFileName } from '../lib/injected-ids.mjs';
import { liveObsFilterSql } from '../lib/inject-search-core.mjs';
import { buildNotLowSignalSql } from '../lib/low-signal-patterns.mjs';
import { recordHookError } from '../lib/hook-telemetry.mjs';
import { cooldownPathFor as sharedCooldownPathFor } from '../lib/cooldown-path.mjs';
import { citeFactorClause } from '../scoring-sql.mjs';
import { fileMatchClause, fileMatchParams, basenameAnySep } from '../lib/file-edge-match.mjs';
import { fileIntelFor } from '../lib/file-intel.mjs';
import { shouldWarnReread, buildRereadWarning, readFileMeta } from '../lib/reread-guard.mjs';
import { recordMetric } from '../lib/metrics.mjs';
import { presentIdents } from '../lib/lesson-idents.mjs';
import { neutralizeContextDelimiters } from '../format-utils.mjs';
// D#154: the one stdout writer. This script has THREE emit sites (Read→Edit ack,
// repeated-read guard, lesson block) and they stay one document because each branch
// process.exit()s before reaching the next.
//
// Be precise about what routing them through the queue does and does not buy, because an
// earlier version of this comment claimed "a second write is now impossible by
// construction" and that is FALSE (pre-tag review, v3.80.0): each site flushes
// IMMEDIATELY after queueing, and the flush resets the queue — so queue→flush→queue→flush
// emits two documents exactly like two raw writes would. Merging is a property of
// DEFERRING the flush (what hook.mjs does with a single flush at the end of its dispatch),
// not of using the queue.
//
// What it does buy: one construction site instead of three, so the "only the writer
// assembles an envelope" invariant is checkable (tests/hook-script-stdout-contract.test.mjs),
// and the merge is AVAILABLE to anyone who later defers the flush. The mutual exclusion
// itself is still control flow — the process.exit(0) below.
//
// Import-free module, no runtime deps — nothing added to this script's load cost.
import { queueHookContext, flushHookStdout } from '../lib/hook-stdout.mjs';
// Recall queries the SAVE-path project, so this MUST produce the same string as the
// save path. It used to be a hand-kept copy of the same 6 lines; that copy had already
// drifted once (missing the process.env.PWD fallback, so a symlinked project dir
// recalled nothing) and would have drifted again when the 2026-08-17 e2e round taught inferProject to
// anchor on the git work-tree root. project-utils.mjs is a leaf module over path/fs/os
// only — cheaper than several imports this script already carries.
import { inferProject } from '../project-utils.mjs';

import { DAY_MS } from '../lib/time-constants.mjs';
// CLAUDE_MEM_DIR matches schema.mjs / main CLI — one env var sandboxes the
// whole system. CLAUDE_MEM_DB_PATH / CLAUDE_MEM_RUNTIME_DIR remain as
// per-component overrides for tests that mix isolated + real paths.
const DATA_DIR = resolveDataDir(process.env.CLAUDE_MEM_DIR);
const DB_PATH = process.env.CLAUDE_MEM_DB_PATH || join(DATA_DIR, 'claude-mem-lite.db');
const RUNTIME_DIR = process.env.CLAUDE_MEM_RUNTIME_DIR || join(DATA_DIR, 'runtime');
// A3 (v2.83): cross-hook dedup window. UPS writes
// `runtime/.claude-mem-injected-<project>` after each inject; we read it to drop IDs the
// agent already saw in this window. Imported, not inlined (ARCH-3): the copy's stated
// reason — keep this standalone fast path import-free (#8447) — was retired by v3.80.0,
// which already imports lib modules here, and the inlined value silently encoded the
// same premise twice.
import { DEDUP_STALE_MS as CROSS_HOOK_DEDUP_MS } from './prompt-search-utils.mjs';
// Upper bound on the over-fetch the cross-hook dedup buys itself (ALGO-4). The dedup
// runs in JS after the SELECTs, so each LIMIT is raised by the seen-set size to keep the
// dedup a re-ranking rather than a truncation. This cap exists for one reason only: the
// seen-set is read from a file on disk, and a number off disk must never size a query.
//
// It is NOT a sufficiency argument, and the first version of this comment claimed one —
// "bounded by UPS's own per-prompt budget in practice (MAX_RESULTS 3)". That premise is
// false. `crossHookInjectedFile` is a UNION across hooks and calls inside the staleness
// window: `mergeCrossHookInjected` unions new ids into the old ones, UPS contributes up
// to MAX_RESULTS per prompt and this script contributes up to `mergeCap` per trigger, so
// nothing holds it at 3. Measured on this machine's `runtime/.claude-mem-injected-*`
// markers (2026-09-01): id-count histogram 1x9, 2x1, 3x2, 16x1 over n=13, and 1x11, 2x1,
// 3x1, 15x1 over n=14 an hour later. Read that as "3 is not a bound", not as a
// distribution: it is one developer machine, the tail entry is a single long agent session
// (on the re-measure the top entry was the measuring session itself), and the count is of
// ids IN THE FILE while `readCrossHookInjected` returns an EMPTY set for a payload whose
// `ts` is outside DEDUP_STALE_MS — file size and runtime seen-set size are not the same
// quantity.
//
// The residual failure mode that premise was hiding, derived from the arithmetic and NOT
// observed in the wild: at a seen-set of 16 the slack still caps at 5, so a Read fetches
// obsLimit = 6, and if all 6 are in the seen-set the face goes silent again — the exact
// failure ALGO-4 exists to fix. The cap is right (an unbounded LIMIT is worse), the
// reassurance was wrong.
const CROSS_HOOK_DEDUP_SLACK_MAX = 5;
// v2.33.1: cooldown path is session-scoped so same-file-twice within one
// session never re-injects (was: global file, 5-min window). Cross-session:
// fresh file, fresh nudges — this is intended. No session_id → fall back to
// legacy global path so env-less test harnesses still behave.
const LEGACY_COOLDOWN_PATH = join(RUNTIME_DIR, 'pre-recall-cooldown.json');
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes (used only for legacy fallback)
// v2.98 salience forcing-function (#8651: verified injection only moved
// bug-reintroduction 100%→50% — the agent sees lessons and ignores them; the
// bottleneck is ACTING). Default ON: Edit/Write lesson blocks end with an ack
// directive, and Read→Edit re-surfaces the Read-time lesson IDs as a one-line
// ack nudge at the actual action point. CLAUDE_MEM_SALIENCE=legacy (or 0)
// restores the pre-v2.98 passive behavior.
const SALIENCE_LEGACY = process.env.CLAUDE_MEM_SALIENCE === 'legacy'
  || process.env.CLAUDE_MEM_SALIENCE === '0';
const SALIENCE_BIND = process.env.CLAUDE_MEM_SALIENCE === 'bind';
const SALIENCE_BRIDGE = process.env.CLAUDE_MEM_SALIENCE === 'bridge';
const ACK_DIRECTIVE = "apply each lesson to this edit or rule it out — state '#NN applied' or '#NN n/a — <reason>' in your next user-facing message.";
// v-bind salience forcing-function (#8771 audit: ack ≠ act). Instead of a cheap
// '#NN applied / n/a' verdict, demand the model bind the lesson to the concrete
// line it's editing and quote the satisfying edit line. Selected by
// CLAUDE_MEM_SALIENCE=bind; default stays ACK_DIRECTIVE.
const BIND_DIRECTIVE = "For each lesson: state the one concrete check it forces on the line(s) you're editing, quote the edit line that satisfies it, then report '#NN: <check> — pass' or '#NN: n/a — <why this edit can't reach it>'.";
const ACTIVE_DIRECTIVE = SALIENCE_BIND ? BIND_DIRECTIVE : ACK_DIRECTIVE;
const STALE_MS = 10 * 60 * 1000;   // 10 minutes cleanup threshold for legacy file
// Feature ① (file intelligence): on the first Read of a file each session, inject
// its approximate token size + a one-line summary so the agent can decide to read
// fully, slice, or grep. Read-only (Edit/Write already commit to the file). Default
// ON; CLAUDE_MEM_FILE_INTEL=0 disables. Files below the token floor stay silent so
// small reads carry no noise. Env names mirror schema.mjs CLAUDE_MEM_* convention (#8447).
const FILE_INTEL_OFF = ['0', 'off', 'false', 'no'].includes(
  String(process.env.CLAUDE_MEM_FILE_INTEL || '').toLowerCase());
// P2 (D#78): edge-level decay ENFORCEMENT — opt-in (default OFF, shadow-first).
// When on, a (obs,file) edge whose miss_streak reached K consecutive uncited
// injections stops firing on this surface; the lesson stays reachable via
// search / UPS / error-recall. P1 counting (Stop-side attribution) is always
// on regardless of this flag. Flip only after real-DB cite-rate evidence.
const EDGE_DECAY_ON = ['1', 'on', 'true', 'yes'].includes(
  String(process.env.CLAUDE_MEM_EDGE_DECAY || '').toLowerCase());
// NaN-checked, not `|| 3`: an explicit K=0 is falsy and would silently become
// the default instead of clamping to the declared minimum of 1 (review D#78).
const EDGE_DECAY_K_RAW = parseInt(process.env.CLAUDE_MEM_EDGE_DECAY_K, 10);
const EDGE_DECAY_K = Math.max(1, Number.isNaN(EDGE_DECAY_K_RAW) ? 3 : EDGE_DECAY_K_RAW);
// P3 (D#78): scope filter — opt-in (default OFF, shadow-first). When on,
// environment-scoped observations (tooling/CI/network gotchas that apply in
// ANY project) stop firing on FILE-triggered recall; they stay reachable via
// search / UPS / error-recall. NULL scope (legacy / manual rows) always passes.
//
// DO NOT TURN THIS ON, AND DO NOT REBUILD IT AS A DOWN-WEIGHT (D#153, closed
// 2026-08-25). Its premise is that environment-scoped rows are the low-relevance
// class on THIS face. Measured on the live corpus with the shipped extractors —
// `node benchmark/citation-live-replay.mjs --by-scope`, 1122 transcripts — the
// `pretool` face (this one) cites:
//   environment 47.5% (67/141)  CI [39.5, 55.7]
//   project     44.3% (293/661) CI [40.6, 48.1]
//   file        40.0% (2/5)  ·  (gone) 37.1% (185/498)  ·  module 36.5% (31/85)
//   (null)      34.9% (45/129)          ·  face overall 41.0% (623/1519)
// environment is the best-citing scope bucket on the face the filter gates. The
// CIs for environment and project OVERLAP, so "environment leads" is NOT
// established; what is refuted is "environment is the class to suppress".
// Its interval sits above module and null, which is the comparison that matters
// for a lever whose whole premise is that this bucket is the weak one.
//
// The earlier redesign sketch (multiplicative demotion at the TYPE_QUALITY layer
// instead of a WHERE-clause exclusion) fixes the failure mode that was measured
// in 2026-08 — 173 recall groups going empty — but it would still down-rank this
// bucket, so it was NOT built. Kept as an off switch rather than deleted: the
// column and the label are used elsewhere, and a flag nobody flips costs nothing
// as long as the reason not to flip it is written down, which is this paragraph.
//
// NOT corroborated by #10720, though an earlier draft of this note said so. That
// observation is a scope LABEL distribution (364 labelled DB rows: project 184 /
// environment 114 / module 50 / file 16), which establishes the filter's blast
// radius — environment is 31.3% of labels, not the near-no-op it looked like at 8
// rows — and says nothing about relevance. The refutation rests on the by-scope
// replay alone.
//
// Caliber caveat, so the numbers are re-derivable rather than quotable: the six
// buckets sum to exactly 1519, the face's own pair count, because 498 ids whose
// observation has since left the table are reported as `(gone)` rather than
// dropped. Those are an OLD cohort (max id 8880 against a corpus reaching 10850)
// from id bands where the surviving population is ~81% `(null)` and ~2.5%
// environment, so the missing bucket cannot plausibly be environment-heavy;
// environment and project pairs sit in the same bands, so the head-to-head is not
// era-confounded. The `(null)` bucket and the face-overall figure ARE, being
// dominated by legacy rows.
const SCOPE_FILTER_ON = ['1', 'on', 'true', 'yes'].includes(
  String(process.env.CLAUDE_MEM_SCOPE_FILTER || '').toLowerCase());
const FILE_INTEL_MIN_TOKENS = Math.max(1,
  parseInt(process.env.CLAUDE_MEM_FILE_INTEL_MIN_TOKENS, 10) || 800);
// Feature ② (repeated-read guard): when the agent does a FULL re-read of a file
// it already read this session and the file is unchanged (mtime), nudge it to
// reuse context instead of re-slurping. Read-only; only fires above the floor and
// never on offset/limit paging. Default ON; CLAUDE_MEM_REREAD_GUARD=0 disables.
const REREAD_GUARD_OFF = ['0', 'off', 'false', 'no'].includes(
  String(process.env.CLAUDE_MEM_REREAD_GUARD || '').toLowerCase());
const REREAD_MIN_TOKENS = Math.max(1,
  parseInt(process.env.CLAUDE_MEM_REREAD_MIN_TOKENS, 10) || 600);
// Stale-cooldown GC moved to hook.mjs::handleSessionStart — running it on every
// Edit cost 15-30 disk stats per call. SessionStart fires once at session boot,
// which is enough to keep RUNTIME_DIR from growing unbounded.

// Path rule lives in lib/cooldown-path.mjs — this script WRITES the file that
// lib/cite-back-hint.mjs and lib/edge-attribution.mjs read, and a writer/reader
// disagreement does not error, it silently reads a file nobody wrote (ARCH-2). The
// no-session legacy fallback stays here: it is this script's own back-compat, not part
// of the shared naming rule.
function cooldownPathFor(sessionId) {
  if (!sessionId) return LEGACY_COOLDOWN_PATH;
  return sharedCooldownPathFor(RUNTIME_DIR, sessionId);
}

// Comprehension-bridge (CLAUDE_MEM_SALIENCE=bridge): rewrite the top bound lesson
// into a check naming a symbol in THIS change. Dynamic import keeps the LLM stack
// out of the default fast path (#8447). Fail-open: null → caller uses ACK line.
async function bridgeTopLesson(rows, changeText) {
  if (!SALIENCE_BRIDGE || !changeText) return null;
  const fake = process.env.CLAUDE_MEM_BRIDGE_FAKE;
  let extractIdents, bridgeLesson;
  try {
    ({ extractIdents } = await import('../lib/lesson-idents.mjs'));
    if (!fake) ({ bridgeLesson } = await import('../lib/lesson-bridge.mjs'));
  } catch { return null; }
  for (const r of rows) {
    const lesson = r.lesson_learned;
    if (!lesson) continue;
    if (!extractIdents(lesson).some((id) => changeText.includes(id))) continue;
    let res;
    if (fake) res = /^n\s*\/?\s*a$/i.test(fake.trim()) ? { ok: false } : { ok: true, check: fake.trim().slice(0, 200) };
    else res = await bridgeLesson({ lesson, hunk: changeText });
    if (res.ok) return { id: r.id, check: res.check };
    return null; // top bound lesson abstained → fall back to ACK, don't scan further
  }
  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function readCooldown(cooldownPath) {
  try { return JSON.parse(readFileSync(cooldownPath, 'utf8')); } catch { return {}; }
}

// v2.81: cooldown entries are {ts, lessonIds} objects so the PostToolUse
// cite-back hint can name the lessons that were nudged. Legacy entries
// (pre-v2.81) are bare numbers — entryTimestamp() reads both shapes.
function entryTimestamp(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof v.ts === 'number') return v.ts;
  return 0;
}

// A3 (v2.83): cross-hook injected-IDs store. UPS writes
// `runtime/.claude-mem-injected-<project>-<session>` with {ids, ts, count}. We
// read inside the staleness window, filter overlaps from PreToolUse output,
// then merge back so the next UPS sees what we emitted too.
// D#120: the file is keyed per SESSION (payload-only keying let two concurrent
// windows clobber each other's marker). Derivation shared via lib/injected-ids.mjs
// (pure, no deps — within the standalone fast-path budget, #8447).
function crossHookInjectedFile(project, sessionId) {
  return join(RUNTIME_DIR, injectedIdsFileName(project, sessionId));
}

// M-6 (audit 2026-08-14): the marker file is keyed by PROJECT, so two concurrent
// CC sessions in the same project shared one suppression state — session A's
// injections silently deduped session B's, and B inherited A's count cap. Both
// read and merge now carry the CC session id: a payload written by a DIFFERENT
// session is ignored (read) / replaced (merge), mirroring the v3.35.2 episode
// session-key fix. Legacy payloads without `session` keep the old behavior.
function readCrossHookInjected(project, sessionId) {
  try {
    const raw = readFileSync(crossHookInjectedFile(project, sessionId), 'utf8');
    const { ids, ts, session } = JSON.parse(raw);
    if (session && sessionId && session !== sessionId) return new Set();
    if (!ts || Date.now() - ts > CROSS_HOOK_DEDUP_MS) return new Set();
    if (!Array.isArray(ids)) return new Set();
    return new Set(ids.map(String));
  } catch { return new Set(); }
}

function mergeCrossHookInjected(project, newIds, sessionId) {
  if (!newIds || newIds.length === 0) return;
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    const file = crossHookInjectedFile(project, sessionId);
    let prev = { ids: [], ts: 0, count: 0 };
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      // Within the staleness window AND same session (or legacy): union.
      // Outside / other session: replace.
      if (parsed.ts && Date.now() - parsed.ts < CROSS_HOOK_DEDUP_MS
          && !(parsed.session && sessionId && parsed.session !== sessionId)) {
        prev = parsed;
      }
    } catch { /* fresh file */ }
    const ids = [...new Set([
      ...(Array.isArray(prev.ids) ? prev.ids.map(String) : []),
      ...newIds.map(String),
    ])];
    // Atomic (tmp+rename, M-6): a plain write torn by a concurrent hook left the
    // shared marker as invalid JSON, silently disabling cross-hook dedup.
    atomicWriteFileSync(file, JSON.stringify({
      ids,
      ts: Date.now(),
      count: (prev.count || 0) + 1,
      ...(sessionId ? { session: sessionId } : {}),
    }));
  } catch { /* silent — dedup is best-effort */ }
}

function writeCooldown(cooldownPath, data, isSessionScoped) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    // Legacy (no session_id): stale entries trimmed to 10m window.
    // Session-scoped: keep all entries for the session's lifetime — same-file-twice
    // in one session never re-injects. Old session files GC'd on next write.
    const now = Date.now();
    const cleaned = isSessionScoped ? data : {};
    if (!isSessionScoped) {
      for (const [k, v] of Object.entries(data)) {
        const ts = entryTimestamp(v);
        if (ts && now - ts < STALE_MS) cleaned[k] = v;
      }
    }
    // Atomic (tmp+rename, M-6): the cooldown carries lessonIdents that the
    // PostToolUse bind-salience check reads back — a torn write turned that
    // check into a zero-trace no-op.
    atomicWriteFileSync(cooldownPath, JSON.stringify(cleaned));
  } catch { /* silent */ }
}

// ─── Main ───────────────────────────────────────────────────────────────────

try {
  // Skip if recursive hook
  if (process.env.CLAUDE_MEM_HOOK_RUNNING) process.exit(0);

  // Skip if DB doesn't exist
  if (!existsSync(DB_PATH)) process.exit(0);

  // Read stdin
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  // Parse event
  let filePath;
  let sessionId;
  let toolName;
  let toolInput;
  // isFullRead: a Read with no offset/limit reads the whole file. The reread
  // guard only flags full-vs-full re-reads, so paging never trips it.
  let isFullRead = true;
  try {
    const event = JSON.parse(input);
    toolInput = event.tool_input;
    filePath = event.tool_input?.file_path;
    sessionId = event.session_id || null;
    toolName = event.tool_name || null;
    const off = event.tool_input?.offset;
    const lim = event.tool_input?.limit;
    isFullRead = (off === undefined || off === null) && (lim === undefined || lim === null);
  } catch (e) {
    recordHookError('pre-recall:json', e, RUNTIME_DIR, { inputLen: input.length });
    process.exit(0);
  }

  // Upstream-shape probe: hook ran but neither field nor input shape matches the
  // contract we encode (event.tool_input.file_path, event.tool_name in
  // Edit|Write|NotebookEdit|Read). Distinguishes "Claude Code renamed the field"
  // from "event genuinely has no file_path" — without this trace, a CC upstream
  // rename silently zeroes injection like code-graph's matcher bug.
  if (!filePath) {
    if (toolName && !['Edit', 'Write', 'NotebookEdit', 'Read'].includes(toolName)) {
      recordHookError('pre-recall:unknown-tool', new Error(`tool_name=${toolName}`), RUNTIME_DIR, { toolName });
    } else if (!toolName) {
      recordHookError('pre-recall:no-toolname', new Error('event missing tool_name'), RUNTIME_DIR);
    }
    process.exit(0);
  }

  // v2.34.6 Gap 3: Read-side recall with asymmetric quiet-mode. Reads have
  // lower per-event information value than Edits (passive observation, may
  // not lead to action), so inject less per Read. Cooldown is shared with
  // Edit via per-filePath session state — Read→Edit in the same session is
  // not double-injected. See CHANGELOG v2.34.6 for the data behind 120/1/no-nudge.
  const isRead = toolName === 'Read';

  // v2.33.1: session-scoped cooldown. Within one session, same file recalls
  // once; cross-session, each session gets fresh nudges. Legacy 5-min global
  // cooldown only applies when no session_id is present.
  const cooldownPath = cooldownPathFor(sessionId);
  const isSessionScoped = Boolean(sessionId);
  const cooldown = readCooldown(cooldownPath);
  const now = Date.now();
  if (isSessionScoped) {
    const entry = cooldown[filePath];
    if (entry) {
      // v2.98 salience: the old full-dedup meant a Read-injected lesson left the
      // actual Edit with ZERO context at the action point — the most likely spot
      // for #8651's "saw it, ignored it". When this Edit/Write follows a
      // Read-mode injection that surfaced lessons, emit a one-line ack nudge
      // naming the IDs (no lesson bodies — token cost stays minimal), then mark
      // the entry handled so the next Edit is silent again. Entries without a
      // mode field (pre-v2.98) are treated as already handled.
      const seenIds = (typeof entry === 'object' && Array.isArray(entry.lessonIds))
        ? entry.lessonIds : [];
      const wasReadMode = typeof entry === 'object' && entry.mode === 'read';
      if (!isRead && wasReadMode && seenIds.length > 0 && !SALIENCE_LEGACY) {
        const idList = seenIds.map(id => `#${id}`).join(', ');
        queueHookContext('PreToolUse', [
          '[mem] PreToolUse recall — system-injected context, continue your planned action:',
          `[mem] ⚠ Lessons ${idList} were shown when you Read ${basename(filePath)} — ${ACTIVE_DIRECTIVE}`,
        ].join('\n'));
        flushHookStdout();
        cooldown[filePath] = { ...entry, mode: 'edit' };
        writeCooldown(cooldownPath, cooldown, isSessionScoped);
      } else if (isRead && !REREAD_GUARD_OFF && typeof entry === 'object' && entry.reread) {
        // ② repeated-read guard: a full re-read of an unchanged, sizable file —
        // nudge to reuse what's already in context. Read-only; never throws.
        const meta = readFileMeta(filePath);
        if (shouldWarnReread(entry.reread, meta ? meta.mtimeMs : null, isFullRead, REREAD_MIN_TOKENS)) {
          queueHookContext('PreToolUse', [
            '[mem] PreToolUse recall — system-injected context, continue your planned action:',
            buildRereadWarning(basename(filePath), entry.reread.tokens),
          ].join('\n'));
          flushHookStdout();
          recordMetric(DATA_DIR, { event: 'reread_warn' }); // tier-1 firing counter (②)
        }
      }
      process.exit(0); // already recalled this file in-session
    }
  } else {
    const ts = entryTimestamp(cooldown[filePath]);
    if (ts && (now - ts) < COOLDOWN_MS) process.exit(0);
  }

  // Open DB readonly
  const Database = (await import('better-sqlite3')).default;
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 1000');
  } catch (e) {
    recordHookError('pre-recall:db-open', e, RUNTIME_DIR);
    process.exit(0);
  }

  try {
    const project = inferProject();
    // Same any-separator split the observations leg gets through fileMatchParams
    // (pre-tag review of v3.76.2, SF-1/S1). This derivation feeds the EVENTS leg
    // ~120 lines below, which matches a JSON array inside events.file_paths rather
    // than the observation_files junction, so it cannot use fileMatchClause — but it
    // needs the same key, and host-native `basename` gave it the whole path for a
    // Windows-shaped payload. Fixing the observations leg alone would have left this
    // hook recalling lessons but no events.
    const fname = basenameAnySep(filePath);
    // Escape LIKE wildcards (still needed below for the events file_paths arms)
    const escaped = fname.replace(/%/g, '\\%').replace(/_/g, '\\_');
    // P0 (D#78): path-boundary match — editing utils.mjs must NOT pull lessons
    // stored under bash-utils.mjs (the old '%<basename>' suffix LIKE did).
    // Clause + params come from lib/file-edge-match.mjs, byte-shared with the
    // Stop-side edge attribution so trigger and resolver can never drift.
    const fileMatch = fileMatchClause('of2');
    const fileParams = fileMatchParams(filePath);
    // 60-day lookback to avoid surfacing ancient observations
    const cutoff = Date.now() - 60 * DAY_MS;

    // Surface actionable lessons first, then high-importance bugfix/decision observations.
    // Priority: 1) observations with lesson_learned (most actionable for preventing repeat bugs)
    //           2) bugfix/decision types with importance>=2 (contextual history)
    // Skip pure change/discovery without lessons — they add noise without actionable value.
    //
    // v2.34.6: Read tightens the filter to require lesson_learned (drops type-OR
    // fallback — decision/bugfix WITHOUT lesson add context noise to passive Reads
    // where the agent isn't committed to a change). Edit/Write keep the wider
    // filter for decision-point context.
    // LOW_SIGNAL title patterns — auto-generated hook-llm fallback titles carry
    // no actionable guidance. β refactor (#7877 applied): derived from
    // lib/low-signal-patterns.mjs so this cold-start script, utils.mjs regex,
    // and scoring-sql.mjs SQL share one authoritative list.
    const notLowSignalSql = buildNotLowSignalSql('o');
    // Edit: bugfix/decision without lesson_learned is admitted only when the
    // title isn't a LOW_SIGNAL auto-fallback (those carry pipe-delimited raw
    // output or filename-stubs, no guidance value for the about-to-Edit agent).
    const typeFallback = isRead
      ? 'AND o.lesson_learned IS NOT NULL AND o.lesson_learned != \'\''
      : `AND (
          (o.lesson_learned IS NOT NULL AND o.lesson_learned != '')
          OR (o.type IN ('bugfix', 'decision') AND ${notLowSignalSql})
        )`;
    // Cross-hook dedup slack (audit 2026-08-29 ALGO-4, the D#172 shape again). The
    // dedup below drops rows UPS already injected this prompt, and it used to run
    // DOWNSTREAM of these LIMITs — so a deduped row left its slot EMPTY instead of
    // yielding it to the next candidate, i.e. "dedup" was implemented as "shrink".
    // On a Read (obsLimit 1 / eventsLimit 1) one dedup hit silenced the whole face.
    // Read the seen-set FIRST and over-fetch by its size so the dedup removes rows
    // from a pool that still has enough left to fill the cap. Capped at
    // CROSS_HOOK_DEDUP_SLACK_MAX purely because the seen-set is read off disk and a
    // number off disk must not size a query — NOT because the seen-set is small. It is
    // a cross-hook union over the staleness window and was measured at up to 16 ids on
    // this machine, so with the slack saturated a Read can still fetch fewer rows than
    // the seen-set holds and go silent. See the constant's docblock.
    const crossHookSeen = readCrossHookInjected(project, sessionId);
    const dedupSlack = Math.min(crossHookSeen.size, CROSS_HOOK_DEDUP_SLACK_MAX);
    const obsLimit = (isRead ? 1 : 2) + dedupSlack;
    // A1.5 (v2.83.2): cite_factor as a tertiary sort key. When multiple file-
    // matching lessons exist, the one with proven cite history outranks the
    // merely-most-recent one. Single-match files unchanged (obsLimit=1 Read /
    // 2 Edit). Composes with v2.83.0 A1 to extend the citation-decay feedback
    // loop to the 85%-recall PreToolUse:Read/Edit path.
    // P2 (D#78): decayed-edge filter. This readonly fast-path never migrates,
    // so a pre-v43 DB has no miss_streak column and the filter would throw at
    // prepare time — probe pragma_table_info and fall back to unfiltered
    // (pre-v43 edges carry no counts anyway, so nothing would be filtered).
    let edgeDecayFilter = '';
    if (EDGE_DECAY_ON) {
      try {
        const hasCol = db.prepare(
          `SELECT 1 FROM pragma_table_info('observation_files') WHERE name = 'miss_streak'`
        ).get();
        if (hasCol) edgeDecayFilter = `AND of2.miss_streak < ${EDGE_DECAY_K}`;
      } catch { /* probe failure → unfiltered */ }
    }
    // P3 (D#78): environment-scope filter — same probe discipline (readonly
    // fast-path may hit a pre-v43 DB where observations.scope doesn't exist).
    let scopeFilter = '';
    if (SCOPE_FILTER_ON) {
      try {
        const hasScope = db.prepare(
          `SELECT 1 FROM pragma_table_info('observations') WHERE name = 'scope'`
        ).get();
        if (hasScope) scopeFilter = `AND (o.scope IS NULL OR o.scope != 'environment')`;
      } catch { /* probe failure → unfiltered */ }
    }
    const rows = db.prepare(`
      SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
      FROM observations o
      JOIN observation_files of2 ON of2.obs_id = o.id
      WHERE o.project = ?
        AND o.importance >= 2
        AND ${liveObsFilterSql('o')}
        AND o.created_at_epoch > ?
        AND ${fileMatch}
        ${edgeDecayFilter}
        ${scopeFilter}
        ${typeFallback}
      ORDER BY
        CASE WHEN o.lesson_learned IS NOT NULL AND o.lesson_learned != '' THEN 0 ELSE 1 END,
        ${citeFactorClause('o')} DESC,
        o.created_at_epoch DESC
      LIMIT ${obsLimit}
    `).all(project, cutoff, ...fileParams);

    // T9: also query the `events` table — after T9, bugfix/lesson/decision/etc.
    // route here instead of observations, so we must read both sources to keep
    // surfacing past lessons. `file_paths` is a JSON array string; the LIKE
    // patterns match both basename and full-path entries. JSON quoting
    // (`"<name>"`) prevents partial-match false positives like "foo.mjs"
    // matching "myfoo.mjs".
    const filePathEscaped = filePath.replace(/%/g, '\\%').replace(/_/g, '\\_');
    // v2.34.6: Read also tightens the events query — only rows with a non-empty
    // body (= lesson equivalent). Edit path keeps a wider net, but P0 (D#78)
    // closes the parallel-path drift vs the observations query: a bodyless row
    // is admitted only when it is a lesson-bearing type (bugfix/decision — the
    // obs fallback's set — plus events-only 'lesson') AND its title isn't a
    // LOW_SIGNAL auto-fallback; body-bearing rows outrank bodyless ones
    // (mirrors the obs lesson-first sort). Known tradeoff: a deliberately
    // bodyless manual event whose title starts with a LOW_SIGNAL prefix
    // ('npm …', 'Error: …') no longer fires here — it stays reachable via
    // search / UPS; /bug and /lesson write bodies, so this is a rare shape.
    const eventsBodyFilter = isRead
      ? "AND body IS NOT NULL AND body != ''"
      : `AND ((body IS NOT NULL AND body != '')
          OR (event_type IN ('bugfix', 'decision', 'lesson') AND ${buildNotLowSignalSql('')}))`;
    const eventsLimit = (isRead ? 1 : 2) + dedupSlack;
    let eventRows = [];
    try {
      eventRows = db.prepare(`
        SELECT id, event_type AS type, title, body AS lesson_learned
        FROM events
        WHERE project = ?
          AND importance >= 2
          AND superseded_at_epoch IS NULL
          AND created_at_epoch > ?
          AND (file_paths LIKE ? ESCAPE '\\' OR file_paths LIKE ? ESCAPE '\\')
          ${eventsBodyFilter}
        ORDER BY
          CASE WHEN body IS NOT NULL AND body != '' THEN 0 ELSE 1 END,
          created_at_epoch DESC
        LIMIT ${eventsLimit}
      `).all(project, cutoff, `%"${escaped}"%`, `%"${filePathEscaped}"%`);
    } catch { /* events table may not exist on pre-v2.31 DBs — silent */ }

    // A3 (v2.83): cross-hook dedup. UPS may have already injected some of
    // these obs ids this prompt — re-emitting wastes the PreToolUse slot
    // (and inflates context). Drop ids found in the cross-hook injected file
    // inside the staleness window; keep file-cooldown unchanged (the same
    // file might also re-warrant a different lesson next session).
    // P1 (D#78): tag each row's source table — events share the numeric id
    // space with observations, and the Stop-side edge attribution must never
    // feed an event id into observation_files updates.
    // (crossHookSeen is read above, before the two SELECTs — it sizes their LIMITs.)
    const sourcedRows = [
      ...rows.map(r => ({ ...r, src: 'obs' })),
      ...eventRows.map(r => ({ ...r, src: 'evt' })),
    ];
    const dedupedRows = crossHookSeen.size > 0
      ? sourcedRows.filter(r => !crossHookSeen.has(String(r.id)))
      : sourcedRows;

    // Merge: observations first (they carry richer lesson_learned), then events.
    // Edit/Write caps at 3 total; Read caps at 1 (single most-actionable hit).
    const mergeCap = isRead ? 1 : 3;
    const allRows = dedupedRows.slice(0, mergeCap);

    // v2.31 T2: emit JSON with hookSpecificOutput.additionalContext so the message
    // reliably renders across CC variants (sdscc drops plain-text stdout from PreToolUse).
    // suppressOutput:true hides it from transcript mode per CC hook docs.
    // Feature ①: file intelligence (size + summary) for the first Read of this
    // file this session. Read-only; opt out via CLAUDE_MEM_FILE_INTEL=0. Never
    // throws — fileIntelFor returns null on unreadable/below-threshold files.
    let fileIntelLine = null;
    if (isRead && !FILE_INTEL_OFF) {
      try { fileIntelLine = fileIntelFor(filePath, { minTokens: FILE_INTEL_MIN_TOKENS }); } catch {}
    }
    // Tier-1 firing counter (①). recordMetric no-ops unless CLAUDE_MEM_METRICS=1,
    // so default users pay nothing; observers see counts in `doctor` / `stats`.
    if (fileIntelLine) recordMetric(DATA_DIR, { event: 'file_intel' });
    const lines = [];
    // v2.34.6: Read mode uses 120-char truncation (Edit mode keeps the 240-char
    // cap from R3-UX). Rationale: Read is a one-shot nudge with 1 lesson max;
    // Edit is a 3-lesson decision-support injection where the fuller lesson tail
    // carries the actionable "Fix:" guidance — short enough per-lesson at 240,
    // but the total payload is bounded by the 3-row limit and the cooldown.
    const LESSON_MAX = isRead ? 120 : 240;
    // Feature ① (file-intel): null on Edit/Write and on below-threshold or
    // unreadable files. When present (first Read of a sizable file this session),
    // it leads the injection, above any lessons.
    const hasLessons = allRows.length > 0;
    // G13: obs/event lesson recall is the largest injected_n contributor
    // (session max observed: 105) yet had no firing counter — file_intel/
    // reread_warn were metered while the actual #NN injections were invisible.
    // Source split lets the D#78 per-surface attribution read obs vs events.
    if (hasLessons) {
      recordMetric(DATA_DIR, {
        event: 'pretool_recall',
        injected: allRows.length,
        obs: allRows.filter(r => r.src === 'obs').length,
        evt: allRows.filter(r => r.src === 'evt').length,
        mode: isRead ? 'read' : 'edit',
      });
    }
    const showFraming = hasLessons || Boolean(fileIntelLine)
      || (!isRead && process.env.CLAUDE_MEM_PRETOOL_NUDGE === '1');
    if (showFraming) {
      // Framing line mirrors #7758 handoff-injection fix: without an explicit
      // "system-injected, continue" disclaimer, observed turn-end after Edit+reminder
      // when the model misreads passive lesson context as a closing note.
      lines.push(`[mem] PreToolUse recall — system-injected context, continue your planned action:`);
    }
    // MED-1 (full audit 2026-07-16): defang the injection-block delimiters in
    // all DB/file-derived text before it enters additionalContext (which CC wraps
    // in <system-reminder>). Stored text is raw — a lesson/title/summary carrying
    // a literal </system-reminder> or forged <invoke ...> would break the wrapper
    // and inject a privileged instruction. Mirrors formatErrorRecallHints, which
    // already applies the same guard on the parallel error-recall surface. The
    // `#id [type]` prefix is agent-generated (numeric id + type enum) — no defang.
    if (fileIntelLine) lines.push(neutralizeContextDelimiters(fileIntelLine));
    if (hasLessons) {
      lines.push(`[mem] Lessons for ${fname}:`);
      for (const r of allRows) {
        if (r.lesson_learned) {
          const lesson = r.lesson_learned.length > LESSON_MAX
            ? r.lesson_learned.slice(0, LESSON_MAX - 3) + '...'
            : r.lesson_learned;
          lines.push(`  #${r.id} [${r.type}] ${neutralizeContextDelimiters(lesson)}`);
        } else {
          const title = (r.title || '').length > LESSON_MAX
            ? r.title.slice(0, LESSON_MAX - 3) + '...'
            : (r.title || '');
          lines.push(`  #${r.id} [${r.type}] ${neutralizeContextDelimiters(title)}`);
        }
      }
      // v2.98 salience: Edit/Write is the action point — close the block with an
      // explicit ack directive instead of leaving the lessons as passive FYI
      // (#8651: passive framing was ignored ~half the time even when on-topic).
      // Read keeps the quiet form; its forcing-function fires at the later Edit
      // via the Read→Edit ack nudge above.
      if (!isRead && !SALIENCE_LEGACY) {
        const changeText = [toolInput?.old_string, toolInput?.new_string, toolInput?.content]
          .filter(Boolean).join('\n');
        const bridged = await bridgeTopLesson(allRows, changeText);
        if (bridged) lines.push(`[mem] ⚠ #${bridged.id} → this edit must: ${neutralizeContextDelimiters(bridged.check)}. Confirm your new code satisfies it.`);
        else lines.push(`[mem] ⚠ Before this edit: ${ACTIVE_DIRECTIVE}`);
      }
    } else if (!isRead && process.env.CLAUDE_MEM_PRETOOL_NUDGE === '1') {
      // R-4: Edit/Write empty → short backfill reminder. OPT-IN (default off) as
      // of the cross-project audit: this "no prior lessons, remember to /lesson"
      // reminder fired on ~70% of Edit/Write recalls and drove zero observed
      // /lesson calls — pure context noise, mostly on brand-new files that by
      // definition can't have a lesson. Save-nudging now lives at Stop time
      // (buildCiteRecallNudge's unsaved-bugfix line + the cite-back hint), which
      // has the full episode to judge whether a real fix happened. Set
      // CLAUDE_MEM_PRETOOL_NUDGE=1 to restore the per-Edit reminder.
      //
      // Read never emitted this (passive). The cooldown write below still runs on
      // every branch, so Read→Edit dedup + cite-back lessonId tracking are intact.
      // (Framing line already pushed above via showFraming.)
      lines.push(`[mem] No prior lessons for ${fname} — if you solve a non-obvious bug here, run: /lesson --file ${fname} "<root cause + fix>"`);
    }

    if (lines.length > 0) {
      queueHookContext('PreToolUse', lines.join('\n'));
      flushHookStdout();
    }
    // Cooldown applies on ALL branches (including silent-Read) so subsequent
    // calls on the same file in the same session don't re-query — preserving
    // the per-filePath invariant that underpins Read→Edit dedup.
    // v2.81: record the emitted lesson IDs so flushEpisode (hook.mjs) can
    // build the PostToolUse cite-back hint when the user actually edits the
    // file. Empty array on no-lesson branches keeps the schema uniform.
    // v2.98: mode records WHERE the injection happened so the Read→Edit ack
    // nudge can distinguish "lessons seen passively at Read" from "already
    // surfaced at an action point".
    // ② repeated-read guard: record file metadata on the first Read so a later
    // full re-read of the unchanged file can be flagged. Read-only, session-scoped;
    // one stat + bounded read, first-read only.
    const rereadMeta = (isRead && !REREAD_GUARD_OFF && isSessionScoped) ? readFileMeta(filePath) : null;
    // bind salience (component 2): record the identifiers each lesson NAMES that
    // ALSO appear in the current (pre-edit) file, so post-tool-recall.js can flag
    // an edit that drops one. Only under =bind with lessons — keeps the default
    // path free of the extra file read. Bounded read; never throws.
    let lessonIdents;
    if (SALIENCE_BIND && allRows.length > 0) {
      try {
        const pre = readFileSync(filePath, 'utf8').slice(0, 256 * 1024);
        const acc = {};
        for (const r of allRows) {
          const present = presentIdents(`${r.lesson_learned || ''} ${r.title || ''}`, pre);
          if (present.length) acc[r.id] = present;
        }
        if (Object.keys(acc).length) lessonIdents = acc;
      } catch { /* unreadable pre-edit file — skip the diff check */ }
    }
    cooldown[filePath] = {
      ts: now,
      lessonIds: allRows.map(r => r.id),
      // P1 (D#78): observation-sourced ids only — consumed by the Stop-side
      // edge attribution (lib/edge-attribution.mjs). lessonIds stays mixed for
      // the cite-back hint contract.
      obsIds: allRows.filter(r => r.src === 'obs').map(r => r.id),
      mode: isRead ? 'read' : 'edit',
      ...(lessonIdents ? { lessonIdents } : {}),
      ...(rereadMeta ? { reread: { mtimeMs: rereadMeta.mtimeMs, tokens: rereadMeta.tokens, full: isFullRead } } : {}),
    };
    writeCooldown(cooldownPath, cooldown, isSessionScoped);
    // A3 (v2.83): merge our newly-emitted IDs into the cross-hook injected
    // file so the next UPS prompt skips them too. Always write, even on
    // empty allRows, so the file's ts stays fresh for the no-op case where
    // we'd otherwise drift outside the dedup window.
    mergeCrossHookInjected(project, allRows.map(r => r.id), sessionId);
  } catch (e) {
    // Silent failure — never block editing, but record for self-observation.
    recordHookError('pre-recall:query', e, RUNTIME_DIR, { filePath });
  } finally {
    try { db.close(); } catch {}
  }
} catch (e) {
  // Top-level catch — exit 0 no matter what, but record what slipped past.
  try { recordHookError('pre-recall:top', e, RUNTIME_DIR); } catch {}
}
