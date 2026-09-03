#!/usr/bin/env node
// claude-mem-lite Hook v2 — Cognitive memory architecture
// Selective encoding, episodic batching, error-triggered recall
// Hooks (fast <100ms): post-tool-use, session-start, stop
// Background workers (slow): llm-episode, llm-summary
//
// ─── Session-id invariant (do not violate — see bf121aa / v2.33.2) ──────────
// Two session identifiers coexist in this codebase:
//   • mem-internal id: `hook-<project>-<hash>`, produced by getSessionId().
//     handleUserPrompt writes it into user_prompts / sdk_sessions.content_session_id
//     / observations.memory_session_id. Treat as the ONLY valid WHERE / JOIN key
//     for those three tables.
//   • CC UUID: `hookData.session_id` from stdin. Use ONLY for
//     session_handoffs.session_id (parallel-session scoping, per bf121aa).
// Mixing them silently breaks everything — UPDATE matches 0 rows, SELECT returns
// empty, buildAndSaveHandoff early-returns, no throw. Precedent: v2.33.1 shipped
// with the two mixed since 2026-04-12; 48 stale 'active' sessions + 0 handoffs
// for projects--mem went unnoticed for 4 days. Keep the split or document why
// you're changing it.

import { randomUUID } from 'crypto';
import { join } from 'path';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync, statSync, existsSync } from 'fs';
import { homedir } from 'os';
import {
  inferProject, detectBashSignificance,
  extractFilePaths, isRelatedToEpisode,
  makeEntryDesc, scrubSecrets, stripPrivate, EDIT_TOOLS, debugCatch, debugLog,
  formatErrorRecallHints,
  MAX_HOOK_STDIN_BYTES,
} from './utils.mjs';
// Direct import (not via the utils.mjs barrel): the barrel's re-exports are a v2.21
// backward-compat surface that knip already lists as unused; new shared symbols go to
// their canonical module.
import { inferProjectDir } from './project-utils.mjs';
import { readHookStdin } from './lib/hook-stdin.mjs';
// Aliased: `acquireLock` from hook-episode.mjs below is the episode buffer's own
// (argument-less) lock — a different mutex with a different staleness policy.
import { acquireLock as acquireProcLock } from './lib/proc-lock.mjs';
import {
  readEpisodeRaw, episodeFile,
  acquireLock, releaseLock, readEpisode, writeEpisode,
  createEpisode, addFileToEpisode, planEpisodeFlush,
  writePendingEntry, mergePendingEntries, episodeHasSignificantContent, explainSignificance,
} from './hook-episode.mjs';
import { cleanupClaudeMdLegacyBlock, buildSessionContextLines } from './hook-context.mjs';
import { entry as preCompactEntry } from './hook-precompact.mjs';
import {
  RUNTIME_DIR, EPISODE_BUFFER_SIZE, EPISODE_TIME_GAP_MS,
  SESSION_EXPIRY_MS, STALE_SESSION_MS, STALE_LOCK_MS, AUTO_MAINTAIN_LOCK,
  STALE_EPISODE_BUFFER_AGE_MS,
  HANDOFF_EXPIRY_CLEAR, HANDOFF_EXPIRY_EXIT,
  sessionFile, getSessionId, createSessionId, openDb,
  spawnBackground, sweepOrphanEpisodeFiles, sweepStaleProjectMarkers,
} from './hook-shared.mjs';
import { handleLLMEpisode, handleLLMSummary, saveEpisodeImmediate } from './hook-llm.mjs';
import { readFastSummarySource, insertFastSummary, FAST_SUMMARY_LIMITS } from './lib/fast-summary.mjs';
import { formatHookError } from './lib/native-binding-hint.mjs';
import { recordHookError } from './lib/hook-telemetry.mjs';
import { queueHookContext, queueHookSystemMessage, flushHookStdout } from './lib/hook-stdout.mjs';
import { shouldRecallOnFailure } from './lib/tool-refusal.mjs';
import { selectCompressionCandidates, groupByProjectWeek, compressGroup } from './lib/compress-core.mjs';
import { cleanupBroken, decayAndMarkIdle, boostAccessed, demotePinned, resolveDefaultMaintainOps, markAutoCompressible, selectFuzzyDedupeIds, stampDedupSuperseded, hardDeleteCandidateCount, purgeStale, recoverOrphanedChildren, recoverBuriedLessons, sweepDeferredWorkOrphans } from './lib/maintain-core.mjs';
import { snapshotDb } from './lib/db-backup.mjs';
import {
  extractCitationsFromTranscript,
  extractInjectedBySurface,
  buildCitationRelevanceSet,
  unionSurfaces,
  extractInjectedFromKeyContext,
  bumpCitationAccess,
  computeCiteRecall,
  applyCitationDecay,
  recordCitationFunnel,
  recordCitationSurfaces,
  collectSubagentSurface,
  hasMainThreadAssistantText,
} from './lib/citation-tracker.mjs';
import { resolveEdgeAttribution, readPreRecallFileEdges } from './lib/edge-attribution.mjs';
import { extractTailAssistantText, extractStructuredSummary } from './lib/summary-extractor.mjs';
import { searchRelevantMemories, formatMemoryLine, selectImperativeLesson } from './hook-memory.mjs';
import { searchInjectableEvents, renderInjectableEvent } from './lib/events-injection.mjs';
import { upsFtsQuery } from './lib/ups-query.mjs';
import { formatTaskImperative } from './lib/task-imperative.mjs';
import { gcOldMetricShards, recordMetric } from './lib/metrics.mjs';
import { detectMemOverride } from './lib/mem-override.mjs';
import { injectedIdsFileName, keyContextIdsFileName, readInjectedMarker } from './lib/injected-ids.mjs';
import { recordKeyContextInjection, touchKeyContextMarker } from './lib/keyctx-marker.mjs';
import { liveObsFilterSql } from './lib/inject-search-core.mjs';
import { selectErrorRecall } from './lib/error-recall-core.mjs';
import { buildAndSaveHandoff, detectContinuationIntent, renderHandoffInjection, pickHandoffToInject, extractUnfinishedSummary } from './hook-handoff.mjs';
import { loadCiteBackForEpisode, extractCiteBackSignals, buildUnsavedBugfixHint, countUnsavedBugfixShape, buildCiteRecallNudge as libBuildCiteRecallNudge, nextCiteLowStreak } from './lib/cite-back-hint.mjs';
import { citeRecallPathFor } from './lib/cite-recall-path.mjs';
import { detectUnpersistedDecision } from './lib/persist-reminder.mjs';
// plugin-cache-guard.mjs loaded dynamically — pre-2.31.2 installs that auto-upgraded
// from an older hook-update.mjs SOURCE_FILES (which did not list this module) would
// crash on static import. Degrade gracefully to no-op when the module is absent.
let _cacheGuardCache = null;
async function loadCacheGuard() {
  if (_cacheGuardCache !== null) return _cacheGuardCache;
  try { _cacheGuardCache = await import('./plugin-cache-guard.mjs'); }
  catch { _cacheGuardCache = {}; }
  return _cacheGuardCache;
}
// Audit 2026-09-02 P1-8. `hook.mjs` is ONE entry point for seven events, so every static
// import is paid by every event — PostToolUse, the highest-frequency one, was loading 85
// modules (1.37 MB) to use a handful. The six modules below are loaded inside the handler
// that needs them instead: registry-recommend, patha-exclude-meter, hook-update,
// hook-optimize, adopt-cli, upgrade-banner. Measured marginal cost of the four largest,
// same process: hook-update 9.4 ms, registry-recommend 5.1, hook-optimize 5.9, the rest
// 0.5-2.4 each.
//
// A failing dynamic import lands in the dispatcher's tail catch -> recordHookError, the
// same place a failing static import would have landed the whole process; each site keeps
// whatever local try/catch it already had, so a missing module degrades exactly one
// feature rather than the event.
//
// Three named by the audit are deliberately NOT converted, because the reason they are
// loaded is not that nobody looked:
//   * hook-llm.mjs (+16.3 ms, the single largest) — `flushEpisode` is SYNCHRONOUS and on
//     the PostToolUse path, and it calls `saveEpisodeImmediate` from that module. Lazy
//     loading needs either an async rewrite of the flush path or extracting the function,
//     and extraction does not pay: `saveEpisodeImmediate` reaches `saveObservation`, which
//     pulls tfidf / observation-write / activity / maintain-core anyway — only
//     haiku-client would actually stop loading.
//   * lib/db-backup.mjs and lib/compress-core.mjs (<=2.4 ms each) — their call sites sit
//     in `runSessionStartAutoMaintain` and `handleAutoCompress`, both synchronous. Turning
//     two functions and their callers async across a background-worker path costs more
//     risk than the milliseconds are worth.
import { SKIP_TOOLS, SKIP_PREFIXES } from './skip-tools.mjs';
import { getVocabulary } from './tfidf.mjs';

import { DAY_MS } from './lib/time-constants.mjs';
// Prevent recursive hooks from background claude -p calls
// Background workers (llm-episode, llm-summary) are exempt — they're ours
const event = process.argv[2];
// Events allowed to run under CLAUDE_MEM_HOOK_RUNNING=1 (the recursion guard at
// the dispatch below exits everything else). EVERY spawnBackground/queue* event
// MUST be listed here — a missing entry makes the detached worker exit(0)
// silently, which looks identical to "worker ran and found nothing" from the
// outside (live-probe catch, 2026-07-18: enrich-save no-oped on this line;
// audit F6, 2026-08-14: update-check had been dead the same way, so the 24h
// release check never ran and every SessionStart respawned a worker that
// exit(0)'d before its handler).
// `tests/audit-findings-20260814.test.mjs` scans BOTH detached spawners
// (spawnBackground here, spawn(node,[HOOK_PATH,…]) in lib/save-enrich.mjs) and
// reds when a spawned event is missing from this list.
const BG_EVENTS = new Set(['llm-episode', 'llm-summary', 'auto-compress', 'llm-optimize', 'auto-maintain', 'enrich-save', 'update-check']);

// Respect Claude Code plugin disable state even when legacy settings.json hooks remain.
// install.mjs writes direct hooks into ~/.claude/settings.json, so disabling the plugin
// in Claude UI does not automatically remove them. Exit early to make disable actually work.
const PLUGIN_KEY = 'claude-mem-lite@sdsrss';
function isPluginExplicitlyDisabled() {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return settings.enabledPlugins?.[PLUGIN_KEY] === false;
  } catch {
    return false;
  }
}

if (event && isPluginExplicitlyDisabled()) process.exit(0);
if (process.env.CLAUDE_MEM_HOOK_RUNNING && !BG_EVENTS.has(event)) process.exit(0);

// Crash-safe: flush episode buffer on unexpected termination to prevent data loss
// Uses flag-based approach to avoid calling file I/O inside signal handlers,
// which can deadlock if the signal fires during a main-thread file operation.
let _shutdownRequested = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (_shutdownRequested) process.exit(0); // Double-signal = force exit
    _shutdownRequested = true;
    // Schedule flush on next tick to avoid re-entering file I/O
    setTimeout(() => {
      try {
        const ep = readEpisodeRaw();
        if (ep && ep.entries && ep.entries.length > 0) {
          // Persist a rule-based observation synchronously — the ONLY thing that
          // salvages the in-flight episode on abnormal termination (audit #6). A
          // detached llm-episode child can't be spawned from a dying process, so no
          // ep-flush-* file is written here: it would have NO consumer AND would make
          // every later handleLLMSummary poll the full CLAUDE_MEM_FLUSH_TIMEOUT (~15s)
          // waiting for a file that only the 24h orphan-sweep ever removes.
          // Split by CC session first (v3.35.2 parity): the normal flush and the Stop
          // lock-contended fallback both planEpisodeFlush, but this crash path flushed the
          // WHOLE buffer as one observation, co-attributing two interleaved same-project
          // sessions into one garbled row. planEpisodeFlush returns [ep] by reference when
          // there is ≤1 CC session (the common case → identical to before), else one sub
          // per session. Pure/sync → safe inside the signal handler.
          // Same B1 gate as flushEpisode: without an openable DB every save below is a
          // no-op, so deleting the buffer afterwards would destroy the very episode this
          // handler exists to salvage. openDb is sync (safe here) and records its own
          // failure; leaving the file untouched lets the next fire retry it.
          const db = openDb();
          if (db) {
            try {
              for (const sub of planEpisodeFlush(ep)) saveEpisodeImmediate(sub, db);
              try { unlinkSync(join(RUNTIME_DIR, `ep-${inferProject()}.json`)); } catch {}
            } finally {
              try { db.close(); } catch { /* already gone */ }
            }
          }
        }
      } catch {}
      // The salvage path exits without falling through to the dispatcher tail, so
      // it owns its own flush: a receipt queued before the signal arrived was
      // delivered by the pre-v3.70 inline write and would otherwise be dropped here
      // (pre-tag review NOTE N1).
      try { flushHookStdout(); } catch { /* never change the exit code for a receipt */ }
      process.exit(0);
    });
  });
}

if (!event) process.exit(0);

// ─── Episode Flush ──────────────────────────────────────────────────────────

// hookEventName serves two roles: it is written into the emitted receipt JSON
// AND it gates emission via RECEIPT_EVENTS. Callers MUST pass their triggering
// event name so both work — Stop falls outside the allowlist, so its receipt
// is skipped entirely (CC's Stop schema rejects hookSpecificOutput at the root,
// not just on event-name mismatch). The episode still flushes to DB and
// spawns llm-episode background enrichment; only the stdout receipt is gated.
// Regression chain: v2.33.1 introduced the receipt; v2.33.3 misdiagnosed the
// Stop rejection as event-name mismatch; v2.33.4 is the root-cause fix.
const RECEIPT_EVENTS = new Set(['PostToolUse', 'SessionStart', 'UserPromptSubmit']);
function flushEpisode(episode, hookEventName = 'PostToolUse') {
  if (!episode || episode.entries.length === 0) return;

  // Acquire the DB ONCE, up front, and bail before touching anything destructive when it
  // will not open. Every persistence step below is a no-op without it (saveObservation
  // returns null on a null db; the detached llm-episode worker hits the same wall), yet
  // the `unlinkSync(episodeFile())` at the tail used to run regardless — so a DB that
  // could not be opened deleted the session's captured work while the hook exited 0 with
  // empty stdout AND empty stderr (audit B1, 2026-08-14). Returning here leaves the
  // buffer on disk for the next fire to retry; openDb() has already recorded the failure
  // under `hook-shared:db-open`. Reusing the handle for the immediate saves also drops
  // this path from one open per sub-episode to one per flush.
  const db = openDb();
  if (!db) return;
  try {
    flushEpisodeWithDb(db, episode, hookEventName);
  } finally {
    try { db.close(); } catch { /* already closed / gone */ }
  }
}

// D#178 safety valve. With CLAUDE_MEM_READS_CARRY on, an insignificant flush leaves
// `reads-<project>.txt` in place, so a long insignificant streak keeps appending to it.
//
// THE CAP COUNTS LINES, NOT DISTINCT PATHS, and that is the whole point. The writer
// (`scripts/post-tool-use.sh`) appends one line per Read with no dedup, so the file grows
// by REPEATED lines — a session re-reading the same five files forever. The first draft
// compared the DISTINCT set against the cap, which is the quantity that stays tiny
// (measured on the live corpus: median 1, p95 6, max 21 carried paths), so the valve could
// not fire on the growth mode it exists to bound. That is this repo's recurring
// "predicate that cannot return true reports the defect as absent" shape, and the pre-tag
// review caught it here.
//
// Still a backstop and not a relevance bound — the same distinction
// IMPERATIVE_POOL_BACKSTOP documents for its pool.
const READS_CARRY_MAX_LINES = 20000;

/**
 * Bound the reads file when an insignificant flush leaves it in place. Rewrites it only
 * when it is over READS_CARRY_MAX_LINES raw lines, keeping the newest distinct paths.
 *
 * @param {string} readsFile
 * @returns {number} distinct paths now held; 0 when there is no reads file (the COMMON
 *   case — no Read since the last collect); -1 only when the file exists but could not be
 *   read or the trim threw. The three-way split is the point: `episode_reads` is the ruler
 *   for this flag, and folding "nothing to hold" together with "could not look" would put
 *   the normal case and the broken case on the same value. A first draft returned -1 for
 *   both, which made -1 the overwhelmingly common reading and hid the failure inside it.
 */
function trimReadsFile(readsFile) {
  let raw;
  try {
    raw = readFileSync(readsFile, 'utf8');
  } catch (e) {
    return e?.code === 'ENOENT' ? 0 : -1;
  }
  try {
    const lines = raw.split('\n').filter(Boolean);
    const paths = [...new Set(lines)];
    if (lines.length <= READS_CARRY_MAX_LINES) return paths.length;
    const keep = paths.slice(-READS_CARRY_MAX_LINES);
    const tmp = readsFile + `.trim-${process.pid}`;
    writeFileSync(tmp, keep.join('\n') + '\n', { mode: 0o600 });
    renameSync(tmp, readsFile);
    return keep.length;
  } catch {
    return -1;
  }
}

function flushEpisodeWithDb(db, episode, hookEventName) {
  // Split by CC session so concurrent same-project sessions flush as separate
  // observations. planEpisodeFlush returns [episode] BY REFERENCE for the common
  // single-session (or all-legacy) case → flushEpisodeGroup(episode) is identical
  // to pre-grouping. Two+ interleaved sessions each get their own sub-episode.
  const subs = planEpisodeFlush(episode);

  // D#178. The reads file used to be consumed right here, unconditionally, BEFORE
  // anything knew whether this flush would persist an observation — and an
  // insignificant flush then dropped every path it had just swept up, leaving the
  // next observation that DID save with files_read = []. Measured over 1122 real
  // transcripts (benchmark/episode-flush-replay.mjs): 42.2% of the reads a flush
  // consumed died that way, and 72.7% of significant flushes carried none at all.
  //
  // The fix is an ORDERING, not a buffer: explainSignificance reads only `entries`
  // and `files`, never `filesRead`, so the verdict is available before the file is
  // touched. An insignificant flush now leaves the file alone and the next
  // significant one collects the union. Ages measured on the same corpus: the reads
  // that survive attach a median 1.7 minutes and p90 10.1 minutes later than they do
  // today, which is the whole cost — a read carried across two insignificant flushes
  // lands on the edit it preceded rather than on nothing.
  //
  // ON by default since v3.83.0. `CLAUDE_MEM_READS_CARRY=0` restores the pre-D#178
  // behavior byte for byte — kept as an off switch because this changes what a released
  // artifact stores, and a defect here is invisible from the outside (the symptom is an
  // absent field, which reads exactly like "there was nothing to record").
  const carryReads = !['0', 'off', 'false', 'no'].includes(
    String(process.env.CLAUDE_MEM_READS_CARRY ?? '').toLowerCase());
  const willPersist = !carryReads || subs.some((s) => episodeHasSignificantContent(s));

  // Collect Read file paths tracked by post-tool-use.sh
  // Use rename to atomically collect — prevents losing concurrent appends
  const readsFile = join(RUNTIME_DIR, `reads-${episode.project || inferProject()}.txt`);
  const readsCollect = readsFile + `.collect-${Date.now()}`;
  let readsHeld = 0;
  if (willPersist) {
    try {
      renameSync(readsFile, readsCollect);
      const raw = readFileSync(readsCollect, 'utf8');
      const paths = [...new Set(raw.split('\n').filter(Boolean))];
      episode.filesRead = paths;
      try { unlinkSync(readsCollect); } catch {}
    } catch {
      episode.filesRead = episode.filesRead || [];
    }
  } else {
    episode.filesRead = [];
    // Not collecting means the file keeps growing across an insignificant streak, and a
    // project that never flushes significantly would grow it without bound. Trim it.
    //
    // The trim's race window is WIDER than the collect path's, and saying otherwise (the
    // first draft did) is the kind of comfortable claim that stops anyone checking: the
    // collect path is a single atomic `renameSync`, while this is read → dedup → write tmp
    // → rename, and a `>>` append from the bash prefilter landing inside that span is lost
    // to the final rename. Accepted rather than fixed: the trim only runs above
    // READS_CARRY_MAX_LINES, which no observed session approaches, so the exposure is a
    // path or two in a session that has already read 20000 times.
    readsHeld = trimReadsFile(readsFile);
  }
  // planEpisodeFlush now runs BEFORE the collection, so the multi-session branch — the
  // one that builds fresh objects rather than returning [episode] by reference — copied
  // whatever filesRead the buffer happened to carry, not what was just collected. The
  // single-group path is identity and unaffected; this line is what keeps the two paths
  // saying the same thing, and without it concurrent same-project sessions would lose
  // their reads while a solo session kept them.
  for (const sub of subs) if (sub !== episode) sub.filesRead = episode.filesRead;

  let anySignificant = false;
  let writefail = false;
  for (const sub of subs) {
    const r = flushEpisodeGroup(sub, db);
    if (r === 'writefail') {
      // Single-group: preserve the original early return — buffer left un-unlinked
      // for a later retry, no receipt. Multi-group: skip only the failed group and
      // keep the rest. The asymmetry is safe: each group's immediate obs is persisted
      // BEFORE its flush-file write, so re-flushing the whole buffer would re-emit
      // already-saved groups as duplicate observations.
      if (subs.length === 1) { writefail = true; break; }
      continue;
    }
    if (r === 'significant') anySignificant = true;
  }

  // D#178 instrument, and the ruler for the flag above. With CLAUDE_MEM_READS_CARRY
  // off, a row with `significant: false` and `readsConsumed > 0` is that many Read
  // paths collected and dropped on the floor. With it on, those rows become
  // `readsConsumed: 0, readsHeld: N` — the same event, now recording a deferral
  // instead of a loss, so one query over this sink covers both arms.
  // Emitted HERE and not in flushEpisodeGroup on purpose: planEpisodeFlush copies
  // the SAME filesRead array into every sub, so a per-group counter double-counts
  // the multi-session case, and the destroyed/kept decision is `anySignificant`,
  // which only exists at this level. `writefail` is its own arm because on the SIGNIFICANT
  // path it keeps the episode buffer for a retry the reads file can no longer serve — it
  // was already unlinked, so the retry re-collects nothing. A writefail flush is NOT
  // necessarily one whose significance said collect: `flushEpisodeGroup` writes its flush
  // file outside the significance branch, so an insignificant flush can fail there too —
  // and with the flag on that case is strictly better than before, because the reads file
  // was never touched and the retry still finds it.
  // Off unless CLAUDE_MEM_METRICS=1, like every other row in this sink.
  recordMetric(join(RUNTIME_DIR, '..'), {
    event: 'episode_reads',
    readsConsumed: (episode.filesRead || []).length,
    readsHeld,
    carry: carryReads,
    significant: anySignificant,
    subs: subs.length,
    writefail,
  });
  if (writefail) return;

  // Aggregate receipt over the whole episode, gated exactly as before
  // (isSignificant → anySignificant). v2.33.4: Stop rejects hookSpecificOutput.
  if (anySignificant && RECEIPT_EVENTS.has(hookEventName)) {
    try {
      const entries = episode.entries || [];
      const toolCounts = {};
      for (const e of entries) toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
      const toolSummary = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t, n]) => `${t}×${n}`)
        .join(', ');
      const lines = [`[mem] episode flushed: ${entries.length} entries (${toolSummary})`];
      // v2.83: error→fix nudge lifted to lib/cite-back-hint.mjs::buildUnsavedBugfixHint
      // so the wording (count + "Save now" verb) stays in sync with cite-back.
      const bugfixHint = buildUnsavedBugfixHint(episode);
      if (bugfixHint) lines.push(bugfixHint);
      // v2.81: cite-back hint — fires when this episode edits a file that
      // PreToolUse:Read/Edit nudged earlier in the same session. Precision
      // signal (we know the file was warned about); orthogonal to the
      // bugfix-shape nudge above and may co-fire.
      const citeBack = loadCiteBackForEpisode(episode, RUNTIME_DIR);
      if (citeBack) lines.push(citeBack);
      // Queued, not written: when this receipt flushes at SessionStart (leftover
      // episode after /clear or /compact) the startup dashboard also has something
      // to say, and two envelopes on one stdout is not a JSON document — Claude
      // Code's parser takes the whole thing as plain text (lib/hook-stdout.mjs).
      // The older comment here claimed a line-based parser made two objects safe
      // as long as each got its own line; the 2.1.233 bundle has no such parser.
      queueHookContext(hookEventName, lines.join('\n'));
    } catch { /* never block on receipt */ }
  }

  // Remove episode buffer AFTER spawning background workers to prevent concurrent overwrites
  try { unlinkSync(episodeFile()); } catch {}
}

// Save one episode-shaped object: immediate rule-based observation (if
// significant) + flush file + llm-episode enrichment spawn. Extracted from
// flushEpisode so each CC-session slice (from planEpisodeFlush) flushes
// independently and carries its OWN savedId into its OWN flush file — the
// llm-episode worker upgrades the pre-saved obs by that id. Returns
// 'significant' | 'insignificant' | 'writefail'. CLAUDE_MEM_SKIP_EPISODE_LLM
// suppresses the detached enrichment spawn (test determinism; sibling of
// CLAUDE_MEM_SKIP_COMPRESS / _OPTIMIZE) — the synchronous immediate obs still lands.
function flushEpisodeGroup(ep, db) {
  const verdict = explainSignificance(ep);
  const isSignificant = verdict.significant;
  // Audit P2-14 instrument: moving Grep into the bash prefilter would save 85ms per Grep
  // (91.2ms handoff vs 6.1ms for the already-skipped Read), but nothing records how many
  // episodes are kept ONLY because of their Greps — and demoting what the product
  // remembers on a deduction is how work disappears silently. This is that counter.
  // Off unless CLAUDE_MEM_METRICS=1, like every other row in this sink.
  recordMetric(join(RUNTIME_DIR, '..'), {
    event: 'episode_significance',
    rule: verdict.rule,
    significant: isSignificant,
    readCount: verdict.readCount,
    grepCount: verdict.grepCount,
    grepDecisive: verdict.grepDecisive,
  });

  // Immediate save: rule-based observation for instant visibility; the LLM
  // background worker upgrades title/narrative/importance later. `db` is
  // flushEpisode's handle — passed in so the caller owns open/close and the whole
  // flush is gated on one availability check (B1). saveEpisodeImmediate re-checks
  // significance itself, so the guard here is about the flush-file decision below.
  if (isSignificant) {
    const id = saveEpisodeImmediate(ep, db, 'flushEpisode-immediateSave');
    if (id) ep.savedId = id;
  }

  const flushFile = join(RUNTIME_DIR, `ep-flush-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  try {
    writeFileSync(flushFile, JSON.stringify(ep), { mode: 0o600 }); // captured paths + scrubbed activity — owner-only (sec P3-2)
  } catch {
    return 'writefail';
  }

  if (isSignificant && !process.env.CLAUDE_MEM_SKIP_EPISODE_LLM) {
    spawnBackground('llm-episode', flushFile);
  } else {
    try { unlinkSync(flushFile); } catch {}
  }
  return isSignificant ? 'significant' : 'insignificant';
}

// ─── PostToolUse Handler ────────────────────────────────────────────────────

// Tier 1 D: Skip low-value tools entirely (source of truth: skip-tools.mjs)
// Consistency enforced by tests/skip-tools.test.mjs

async function handlePostToolUse() {
  let raw;
  try { raw = await readStdin(); } catch { return; }

  let hookData;
  try { hookData = JSON.parse(raw.text); } catch {
    // Truncated JSON — try to salvage tool_name from the prefix
    if (raw.truncated) {
      debugLog('WARN', 'postToolUse', 'stdin truncated at 256KB, attempting salvage');
      const m = raw.text.match(/"tool_name"\s*:\s*"([^"]+)"/);
      if (m) hookData = { tool_name: m[1], tool_input: {}, tool_response: '(truncated)' };
    }
    if (!hookData) return;
  }

  const { tool_name, tool_input, tool_response } = hookData;
  if (!tool_name) return;
  // A non-string tool_name is a host-protocol violation, not a payload we can handle:
  // `tool_name.startsWith(p)` two lines down threw a TypeError that the top-level catch
  // absorbed, so the observation was dropped with nothing attributable behind it. Guard the
  // type (parity with scripts/pre-skill-bridge.js:43) and RECORD it rather than dropping
  // quietly: PostToolUse is the plugin's whole capture path, so a host field-shape change
  // would kill every observation, and hook-errors/ is the only window into that — the same
  // blindness that let the v3.60 binding outage run for 4 days. Volume is bounded by the
  // recorder's 14-day retention and one short line per fire.
  if (typeof tool_name !== 'string') {
    recordHookError(
      'post-tool-use:tool_name-type',
      new TypeError(`tool_name is ${Array.isArray(tool_name) ? 'array' : typeof tool_name}, expected string`),
      RUNTIME_DIR,
      { toolNameType: Array.isArray(tool_name) ? 'array' : typeof tool_name },
    );
    return;
  }

  // Skip noise (source of truth: skip-tools.mjs)
  if (SKIP_TOOLS.has(tool_name)) return;
  if (SKIP_PREFIXES.some(p => tool_name.startsWith(p))) return;

  // Shadow skill-adoption telemetry. mem_use is pre-filtered above, so the Skill tool is
  // the only visible adoption signal (v1). Placed before the resp-length gate because a
  // skill load's response shape varies. Never throws.
  if (tool_name === 'Skill') {
    const ti = typeof tool_input === 'string' ? tryParseJson(tool_input) : (tool_input || {});
    // hookData.session_id (CC UUID) pairs this adoption to the would-be reco from the
    // UserPromptSubmit hook earlier in the same session (matched precision, B1).
    // Lazy: only a `Skill` tool call needs this module, which is a small fraction of
    // PostToolUse fires.
    try {
      const { recordSkillAdoption } = await import('./registry-recommend.mjs');
      recordSkillAdoption('Skill', ti, inferProject(), hookData.session_id);
    } catch { /* telemetry only — never blocks capture */ }
  }

  const resp = normalizeToolResponse(tool_response);
  if (!resp || resp.length < 10) return;

  const toolInput = typeof tool_input === 'string' ? tryParseJson(tool_input) : (tool_input || {});
  const files = extractFilePaths(toolInput);

  // Tier 1 B: Detect significant Bash commands
  const bashSig = (tool_name === 'Bash') ? detectBashSignificance(toolInput, resp) : null;

  // Build episode entry
  const entry = {
    tool: tool_name,
    desc: scrubSecrets(makeEntryDesc(tool_name, toolInput, resp, bashSig)),
    files,
    ts: Date.now(),
    isError: bashSig?.isError || false,
    // isHardError gates the bugfix-shape save-nudge (lib/cite-back-hint.mjs): a real
    // failure fingerprint, not just "error" appearing in search/log output.
    isHardError: bashSig?.isHardError || false,
    isSignificant: EDIT_TOOLS.has(tool_name) ||
                   bashSig?.isSignificant || false,
    bashSig: bashSig || null,
    // CC UUID from hook stdin — lets flushEpisode split a buffer shared by
    // concurrent same-project sessions into per-session observations. Null for
    // legacy/stdin-less invocations (→ single __none__ group = old behavior).
    ccSession: hookData.session_id || null,
  };

  // Episode buffer management (locked to prevent TOCTOU race)
  const sessionId = getSessionId();
  const project = inferProject();

  // Lazy DB: only opened when needed (error recall or file history)
  let db = null;
  const getDb = () => { if (!db) db = openDb(); return db; };

  // Tier 2 G: Error-triggered recall. Gated on isHardError (genuine failure
  // fingerprint), NOT isError — the loose gate fired "Related memories found for
  // this error" on exit-0 commands whose output merely contained the word "error"
  // (G8, roadmap 2026-07-18), and was self-recursive: the hint string itself
  // contains 'error', so a later command echoing it re-triggered recall.
  // entry.isError above keeps the loose semantics on purpose (episode narrative).
  if (bashSig?.isHardError) {
    const d = getDb();
    if (d) triggerErrorRecall(d, toolInput, resp);
  }

  if (!acquireLock()) {
    if (db) try { db.close(); } catch {}
    writePendingEntry(entry, sessionId, project);
    return;
  }
  try {
    let episode = readEpisode();

    // Merge any pending entries from previous lock failures
    if (episode) mergePendingEntries(episode);

    if (episode) {
      const timeSinceLastEntry = Date.now() - episode.lastAt;
      const fileRelated = isRelatedToEpisode(episode, files);
      const bufferFull = episode.entries.length >= EPISODE_BUFFER_SIZE;
      const timeGap = timeSinceLastEntry > EPISODE_TIME_GAP_MS;

      // Phase transition → flush current episode, start new
      if (bufferFull || timeGap || (!fileRelated && episode.entries.length >= 2)) {
        flushEpisode(episode);
        episode = null;
      }
    }

    if (!episode) {
      episode = createEpisode(sessionId, project);
      mergePendingEntries(episode);
    }

    episode.entries.push(entry);
    episode.lastAt = Date.now();
    addFileToEpisode(episode, files);

    // File history injection moved to PreToolUse hook (scripts/pre-tool-recall.js)

    writeEpisode(episode);

  } finally {
    releaseLock();
    if (db) try { db.close(); } catch {}
  }
}

// ─── Error-Triggered Recall (Tier 2 G) ─────────────────────────────────────

/**
 * @param {object} db Open handle.
 * @param {object} toolInput The failed tool's input (needs `.command`).
 * @param {string} response The failure text.
 * @param {{eventName?: string, metricEvent?: string}} [opts] Which hook event this is
 *   answering. The envelope carries exactly one hookEventName and the host rejects a
 *   mismatch, so the PostToolUseFailure path MUST pass its own — defaulting silently
 *   would emit a PostToolUse envelope from a PostToolUseFailure hook.
 */
function triggerErrorRecall(db, toolInput, response, opts = {}) {
  const eventName = opts.eventName || 'PostToolUse';
  const metricEvent = opts.metricEvent || 'error_recall';
  try {
    const project = inferProject();

    // Extract error keywords (D#136). The extractor's line filter is HARD_ERROR_RE —
    // the very predicate isHardError above used — OR'd with the prose one, so anything
    // that reaches this line is also something we can read terms from. Before that,
    // the two lists diverged and npm's own output fell in the gap: `npm ERR! code
    // ENOENT` has no `error`/`fail`/`not found`, so extraction yielded nothing and the
    // query degraded to ['npm','run','build'] — the command's topic, not the failure.
    // planErrorRecall still returns null when nothing usable survives (empty output, or
    // only stop words), and then we stay silent rather than query the command's topic.
    // Selection lives in lib/error-recall-core.mjs so the offline calibration suite
    // scores THIS statement rather than a re-typed lookalike. null ⇒ do not inject.
    const selected = selectErrorRecall(db, {
      cmd: toolInput.command || '',
      response,
      project,
    });
    if (!selected) return;
    const rows = selected.rows;

    const out = formatErrorRecallHints(rows);
    if (out) {
      // G13: this surface feeds the citation denominator but had zero metering —
      // the G8 gate change (isError→isHardError) could not be volume-verified
      // from metrics. Counter only; no latency (query is bundled in the hook).
      recordMetric(join(RUNTIME_DIR, '..'), { event: metricEvent, returned: rows.length });
      // MED-3 (full audit 2026-07-16): go through the envelope, NOT raw stdout —
      // a raw multi-line write corrupts a co-emitted episode-flush receipt.
      // The follow-up correction (2026-08-17): "two separate JSON lines each parse
      // independently" was false. A hard-error Bash call reaches BOTH this and
      // flushEpisode in one handlePostToolUse, and two documents make the parser
      // fall back to plain text — which the renderer drops entirely for
      // PostToolUse. Both receipts vanished. Queue; one envelope is written at exit.
      queueHookContext(eventName, out);
    }
  } catch (e) { debugCatch(e, 'triggerErrorRecall'); }
}

/**
 * PostToolUseFailure — the event that carries tool calls the HOST judged failed (D#170).
 *
 * WHY A SECOND ENTRY POINT AT ALL. `PostToolUse` does not fire for a failed tool call;
 * Claude Code routes those here. Registering only `PostToolUse` therefore made this
 * plugin blind to every host-flagged failure, and the only "failures" error-recall ever
 * saw were commands that exited 0 while printing error-ish text — the classic shape
 * being `cmd 2>&1 | tail`, where the pipe launders a failure into a success. Verified on
 * the 2.1.241 bundle (the event and its schema) and by live probe (two genuinely failing
 * Bash calls, one with a full stack frame, left zero trace in the episode buffer and the
 * events table while the successful calls either side were recorded).
 *
 * THE PAYLOAD IS NOT PostToolUse'S. There is no `tool_response`; the failure text is in
 * `error`, and `is_interrupt` marks a user cancellation. Reading `tool_response` here
 * would find undefined and silently do nothing — which is exactly how this class of
 * wiring bug stays invisible, so the field names are asserted in the tests.
 *
 * DELIBERATELY NARROWER THAN THE EVENT. Only `Bash` (this surface queries on a command
 * plus its output; no other tool has that shape), only when the failure came from a
 * PROGRAM rather than from the agent's own tool chain (lib/tool-refusal.mjs — 68.9% of
 * host-flagged failures on the maintainer's machine were guardrails working), and NOT
 * feeding the episode buffer. That last exclusion is scope, not oversight: episode
 * entries flow into LLM summarisation and the bugfix save-nudge, whose behaviour under a
 * sudden influx of failures has not been measured, and this change is already worth a
 * 3.5x increase in this surface's firing volume.
 *
 * NO `isHardError` GATE HERE, AND THAT IS THE POINT — stated because review found it
 * unwritten and it is a real semantic difference between the two entry points. On the
 * PostToolUse path the host says nothing about success, so `isHardError` has to GUESS
 * from vocabulary whether a command failed; here the host has already ruled, and
 * re-deriving its verdict from the text would only discard cases. The measurable
 * consequence: `Segmentation fault (core dumped)` and a Rust `panicked at` both score
 * `isHardError === false` (the first has no error word, the second loses on `\bpanic\b`'s
 * word boundary), so until this event they could not reach term extraction at all. They
 * can now. That is the coverage this event was wired for, not an oversight — but it does
 * mean ERROR_NAMER_RE's `SIG…`/`panicked` alternatives went live here first.
 *
 * Off switch: CLAUDE_MEM_ERROR_RECALL_ON_FAILURE=off.
 */
async function handlePostToolFailure() {
  if (String(process.env.CLAUDE_MEM_ERROR_RECALL_ON_FAILURE || '').toLowerCase() === 'off') return;

  let raw;
  try { raw = await readStdin(); } catch { return; }
  let hookData;
  try { hookData = JSON.parse(raw.text); } catch { return; }

  const { tool_name, tool_input, error, is_interrupt } = hookData || {};
  // The manifest matcher already scopes this to Bash. Re-checking is not redundancy for
  // its own sake: install.mjs writes a SECOND registration into the user's settings.json,
  // and a hand-edited matcher there would otherwise hand this path an Edit or a Read.
  //
  // A payload whose SHAPE is wrong is recorded, not just dropped. Tests pin the field
  // names against a payload we construct; they cannot see the host renaming `error` or
  // changing `tool_name`'s type, and this whole path fails silently by design — the
  // v3.60 binding outage ran four days on exactly that combination, and hook-errors/ was
  // the only window that would have shown it. Volume is bounded by the recorder's
  // 14-day retention and one short line per fire.
  if (tool_name !== undefined && typeof tool_name !== 'string') {
    recordHookError(
      'post-tool-failure:tool_name-type',
      new TypeError(`tool_name is ${Array.isArray(tool_name) ? 'array' : typeof tool_name}, expected string`),
      RUNTIME_DIR,
    );
    return;
  }
  if (tool_name !== 'Bash') return;
  if (error !== undefined && typeof error !== 'string') {
    recordHookError(
      'post-tool-failure:error-type',
      new TypeError(`error is ${typeof error}, expected string — host payload shape may have changed`),
      RUNTIME_DIR,
    );
    return;
  }

  const verdict = shouldRecallOnFailure({ error, is_interrupt });
  if (!verdict.ok) return;

  const toolInput = typeof tool_input === 'string' ? tryParseJson(tool_input) : (tool_input || {});
  if (typeof toolInput?.command !== 'string' || !toolInput.command) return;

  let db = null;
  try {
    db = openDb();
    if (!db) return;
    // Same selection, same rendering, same core as the PostToolUse path — only the event
    // name on the envelope differs. A second copy of the query here is the twin-drift
    // defect this project keeps paying for.
    triggerErrorRecall(db, toolInput, error, {
      eventName: 'PostToolUseFailure',
      // A separate counter, so the volume this event adds is readable on its own rather
      // than merged into the existing surface's total. The citation funnel deliberately
      // keeps ONE `error_recall` surface: these are the same injections to the model, and
      // splitting the cite-rate denominator would make both halves too small to read.
      metricEvent: 'error_recall_failure',
    });
  } catch (e) {
    debugCatch(e, 'handlePostToolFailure');
  } finally {
    // No flushHookStdout() here: the single flush after the event switch owns writing
    // the envelope, and two flush points is how a process ends up emitting two JSON
    // documents — the degradation that made BOTH receipts vanish in v3.68.
    if (db) try { db.close(); } catch {}
  }
}

// ─── Stop Handler ───────────────────────────────────────────────────────────

async function handleStop() {
  // Read Claude Code's real session_id from hook stdin for parallel-session scoping.
  // This is the stable CC identifier — the mem plugin's file-based getSessionId()
  // collides across parallel sessions for the same project (see docs/bug.txt).
  let ccSessionId = null;
  let transcriptPath = null;
  try {
    const raw = await readStdin();
    const hookData = JSON.parse(raw.text);
    if (typeof hookData?.session_id === 'string' && hookData.session_id.length > 0) {
      ccSessionId = hookData.session_id;
    }
    if (typeof hookData?.transcript_path === 'string' && hookData.transcript_path.length > 0) {
      transcriptPath = hookData.transcript_path;
    }
  } catch { /* stdin unavailable — fall back to local session id */ }

  // Capture session info BEFORE cleanup. All DB lookups use the mem-internal id
  // (that's what handleUserPrompt wrote into user_prompts / sdk_sessions / observations
  // via getSessionId()). `ccSessionId` is used only to tag session_handoffs rows
  // for parallel-session scoping — it must not be used as a query key, otherwise
  // queries miss and UPDATE sdk_sessions becomes a no-op (v2.33.2 regression fix).
  const sessionId = getSessionId();
  const project = inferProject();

  // Snapshot episode BEFORE flush for handoff extraction
  const episodeSnapshot = readEpisodeRaw();

  // Flush remaining episode buffer (locked to prevent race with handlePostToolUse)
  if (acquireLock(1000)) {
    try {
      const episode = readEpisode();
      if (episode) {
        flushEpisode(episode, 'Stop');
      }
    } finally {
      releaseLock();
    }
  } else {
    // Fallback: lock contended — atomically rename episode file to claim ownership.
    // Prevents data loss from concurrent PostToolUse writes between read and delete.
    const epFile = episodeFile();
    const claimFile = epFile + `.claim-${process.pid}-${Date.now()}`;
    // Third instance of the B1 gate (flushEpisode and the SIGTERM salvage are the other
    // two): this path already MOVED the buffer out of the way, so with no openable DB the
    // `unlinkSync(claimFile)` below would destroy it just as surely — and the 1h orphan
    // sweep would have eaten a restored-but-unnoticed claim file anyway. Open once, and
    // put the buffer back under its real name when the save cannot happen.
    let claimDb;
    try {
      renameSync(epFile, claimFile);
      claimDb = openDb();
      try {
        const episode = claimDb ? JSON.parse(readFileSync(claimFile, 'utf8')) : null;
        if (episode && episode.entries && episode.entries.length > 0 && episodeHasSignificantContent(episode)) {
          if (!episode.sessionId) episode.sessionId = sessionId;
          if (!episode.project) episode.project = project;
          // Split by CC session before saving — parity with flushEpisode's non-contended path
          // (v3.35.2). Without this, the lock-contended fallback re-merged exactly the interleaved
          // concurrent-session buffers v3.35.2 split apart, co-attributing two sessions' work into
          // one garbled observation. planEpisodeFlush returns [episode] by reference for the common
          // single-session case, so this is a no-op there. Immediate-save each group BEFORE its
          // flush-file write (same ordering as flushEpisodeGroup) so a worker crash can't lose it.
          // One body for both paths (audit 2026-08-22 P2-9). This loop used to be a
          // hand-copy of flushEpisodeGroup carrying three comments asserting parity with
          // it, and it was not in parity: it ignored CLAUDE_MEM_SKIP_EPISODE_LLM, so a
          // lock-contended Stop under test spawned a real background worker; and a failed
          // flush-file write threw out of the whole loop into the outer catch, whose
          // `finally` then deleted the claim file — abandoning the subs that had not been
          // written yet. flushEpisodeGroup returns 'writefail' and the caller skips only
          // that sub. Per-sub significance gating lives inside it too.
          for (const sub of planEpisodeFlush(episode)) {
            if (!sub.sessionId) sub.sessionId = sessionId;
            if (!sub.project) sub.project = project;
            flushEpisodeGroup(sub, claimDb);
          }
        }
      } finally {
        if (claimDb) {
          try { unlinkSync(claimFile); } catch {}
          try { claimDb.close(); } catch { /* already gone */ }
        } else {
          // Nothing was (or could be) persisted — restore the buffer under its real name
          // so the next fire retries it. If even the rename fails, the claim file stays
          // and the 1h orphan sweep collects it, which is the pre-B1 behaviour.
          try { renameSync(claimFile, epFile); } catch { /* leave it for sweepOrphanEpisodeFiles */ }
        }
      }
    } catch (e) { debugCatch(e, 'handleStop-fallback'); }
  }

  // Mark session completed + save handoff (sync, instant)
  const db = openDb();
  if (db) {
    try {
      db.prepare(`
        UPDATE sdk_sessions SET status = 'completed', completed_at = ?, completed_at_epoch = ?
        WHERE content_session_id = ? AND status = 'active'
      `).run(new Date().toISOString(), Date.now(), sessionId);
      // Save handoff snapshot for cross-session continuity.
      // sessionId = mem-internal (query key); ccSessionId = CC UUID (scope key for
      // parallel-safe row identity). Without the split, CC UUID-based queries miss
      // user_prompts and the handoff row is silently skipped (see hook-handoff.mjs).
      try { buildAndSaveHandoff(db, sessionId, project, 'exit', episodeSnapshot, ccSessionId || sessionId); }
      catch (e) { debugCatch(e, 'handleStop-handoff'); }

      // Fast summary baseline — ensures summary exists even if background LLM fails.
      // T4-P2-B: guard against Stop firing twice for the same session (rare but possible;
      // mirrors handleSessionStart line 795 hasSummary guard). Uses mem-internal sessionId
      // as the WHERE key per the top-of-file dual-id invariant (#7789).
      try {
        const existingSummary = db.prepare(
          'SELECT 1 FROM session_summaries WHERE memory_session_id = ? LIMIT 1'
        ).get(sessionId);
        if (!existingSummary) {
          const { request: fastRequestRaw, completed: obsCompleted } = readFastSummarySource(db, sessionId);

          // Structural extraction from the assistant's tail message.
          // CLAUDE.md §10 mandates Done/Not done/Failed/Uncertain markers, so the
          // tail is deterministically parseable without Haiku. Prior baseline left
          // remaining_items=='' for every session whose Haiku pass failed (≈66%
          // in prod data), losing the user-visible "Not done" list.
          let structuredCompleted = '';
          let structuredNotDone = '';
          let structuredNotes = '';
          try {
            const tail = transcriptPath ? extractTailAssistantText(transcriptPath) : null;
            if (tail) {
              const s = extractStructuredSummary(tail);
              structuredCompleted = s.done;
              structuredNotDone = s.notDone;
              const notesParts = [];
              if (s.failed) notesParts.push(`Failed: ${s.failed}`);
              if (s.uncertain) notesParts.push(`Uncertain: ${s.uncertain}`);
              structuredNotes = notesParts.join('\n');
            }
          } catch (e) { debugCatch(e, 'handleStop-structured-extract'); }

          const finalCompleted = structuredCompleted || obsCompleted;
          const finalRemaining = structuredNotDone;
          const finalNotes = structuredNotes || 'fast';

          if (fastRequestRaw || finalCompleted || finalRemaining) {
            insertFastSummary(db, {
              sessionId, project, now: new Date(),
              values: { request: fastRequestRaw, completed: finalCompleted, remaining: finalRemaining, notes: finalNotes },
              limits: FAST_SUMMARY_LIMITS.stop,
            });
          }
        }
      } catch (e) { debugCatch(e, 'handleStop-fast-summary'); }

      // P4: scan transcript for `#NN` observation citations in assistant text
      // and bump access_count for matched rows. Closes the loop on the "cite #NN"
      // contract — before P4 this was a one-way obligation with no feedback.
      //
      // CLAUDE_MEM_NO_CITATION_TRACK=1 disables BOTH the P4 access_count bump
      // AND the v32 citation-decay loop nested below — anything that needs the
      // transcript scan lives inside this guard. To disable just the decay
      // loop (keep access_count bumps), use MEM_DISABLE_CITATION_DECAY=1 which
      // applyCitationDecay checks separately.
      try {
        if (transcriptPath && !process.env.CLAUDE_MEM_NO_CITATION_TRACK) {
          // D#152/D#177: the `subagent` face, collected ONCE, up front, and used twice —
          // by the decay block below (only under CLAUDE_MEM_SUBAGENT_DECAY) and by its own
          // metering call at the tail. It used to be collected at the tail only, with a
          // comment saying the position was load-bearing because lib/transcript-scan.mjs
          // memoizes ONE file and reading the sidechains evicts the parent. That constraint
          // is real but it is not "last" — it is "not BETWEEN two parent scans". Running it
          // FIRST parses the sidechains before anything has memoized the parent, so the
          // parent is then parsed once and stays memoized for every scanner after it:
          // still one parent parse per Stop, the property the tail comment was protecting.
          let sub = { injected: new Set(), cited: new Set(), files: 0 };
          try { sub = collectSubagentSurface(transcriptPath); }
          catch (e) { debugCatch(e, 'handleStop-subagent-collect'); }

          const ids = extractCitationsFromTranscript(transcriptPath);
          if (ids.size > 0) {
            // Gate the access-count channel on relevance (audit FLOW-2 / D#179). The cited
            // set is every `#NN` in this session's assistant text and cannot tell a
            // citation from a mention; in this repository a CHANGELOG or audit-writing
            // session names dozens of ids in prose, and access_count > 3 promotes a row a
            // tier via boostAccessed. The population to credit — all seven faces, and why
            // extractAllInjected alone is the wrong five — lives in the builder.
            const relevant = buildCitationRelevanceSet({
              transcriptPath, runtimeDir: RUNTIME_DIR, project,
              sessionId: ccSessionId, subagentInjected: sub.injected,
            });
            const n = bumpCitationAccess(db, ids, project, relevant);
            debugLog('DEBUG', 'handleStop',
              `citations: ${ids.size} ids scanned, ${relevant.size} relevant, ${n} obs bumped`);
          }

          // v32 citation-decay: tighter feedback loop on top of P4. Re-scan
          // transcript with main-thread filter, extract injected IDs from BOTH
          // surfaces (PTR + UserPromptSubmit <memory-context>) via extractAllInjected,
          // then mutate importance/streak per applyCitationDecay's contract.
          // Cheap (file still in OS cache).
          //
          // v34.x: pre-v34 this only saw pre-tool-recall injections, leaving the
          // UPS surface (highest-volume — all decision-type FTS hits) starved.
          // Union closed by extractAllInjected — one integration point so the
          // contract test in tests/citation-tracker-userprompt.test.mjs covers it.
          try {
            // mainOnly: the injected denominator must use the same thread
            // filter as citedMain (the numerator, below) — an obs injected only
            // inside a subagent (sidechain) would otherwise enter the denominator
            // but never the numerator and streak-demote despite being used there.
            // v45: take the per-FACE breakdown and union it, instead of asking
            // for the union directly. Same ids (extractAllInjected IS this union
            // — see unionSurfaces), same single transcript walk, but the split
            // survives to citation_surface_log below so "which face earns its
            // budget" becomes answerable. Before this, every face was merged
            // before anything was recorded and no lever had a target.
            const injectedBySurface = extractInjectedBySurface(transcriptPath, { mainOnly: true });
            const injected = unionSurfaces(injectedBySurface);
            // P5 ①: cite-back signals — observations whose warned file the agent
            // edited this session. Union into injected so they're resolved (they
            // were injected via pre-tool-recall) and, below, into cited so the
            // edit promotes them even without a literal #NN in text.
            const citeBackIds = extractCiteBackSignals(transcriptPath);
            for (const id of citeBackIds) injected.add(id);
            // D#124, promotion-only (v3.66.1): the SessionStart Key Context block
            // leaves no hook attachment, so its ids come from the per-session
            // marker. They are added to the decay set ONLY where they were
            // actually cited (below), never as bare denominator: the block
            // re-renders the same fixed top-10 unconditionally, so an uncited
            // render says nothing about relevance. v3.66.0 fed them in as
            // denominator and that made the block eat its own contents.
            // The policy used to rest on a second ground as well — "since keyObs
            // gates on `importance >= 2`, one demotion evicts the common
            // importance-2 row from Key Context for good" — which D#179/D#198
            // retired: this loop no longer writes `importance`, so no citation
            // miss can evict anything. The first ground is untouched and is why
            // the policy stays.
            const keyCtxIds = extractInjectedFromKeyContext({
              runtimeDir: RUNTIME_DIR, project, sessionId: ccSessionId,
            });
            // D#177: `sub.injected` counts toward the entry gate when the face is admitted.
            // Without this a session whose ONLY injection was a dispatched agent's prompt
            // would return here with injected.size === 0 and the face would be "in the
            // denominator" in name only — the failure mode where a face is wired at one
            // level and gated out at another, which is how UPS went unmetered for a whole
            // minor version.
            const subDecayOn = !['0', 'off', 'false', 'no'].includes(
              String(process.env.CLAUDE_MEM_SUBAGENT_DECAY ?? '').toLowerCase());
            if (injected.size > 0 || keyCtxIds.size > 0 || (subDecayOn && sub.injected.size > 0)) {
              // Text-floor gate: skip decay on tool-only Stops. Without this,
              // a turn that ends on tool_use locks every injected obs as
              // uncited (last_decided_session_id set), so a later turn that
              // cites correctly can't undo the verdict. Per CLAUDE.md the
              // contract is "NEXT time you produce user-facing text," so a
              // session with zero main-thread text gets a free pass — the
              // next Stop in the same session will re-evaluate.
              if (!hasMainThreadAssistantText(transcriptPath)) {
                debugLog('DEBUG', 'handleStop', `citation-decay: skipped (no main-thread assistant text yet, injected=${injected.size})`);
              } else {
                const citedMain = extractCitationsFromTranscript(transcriptPath, { mainOnly: true });
                for (const id of citeBackIds) citedMain.add(id);
                // D#177: admit the `subagent` face to the decay loop. It cannot ride the
                // normal path because its injection lands in a dispatched agent's PROMPT
                // and its citation lands in that agent's OWN transcript — so its ids enter
                // the denominator AND its receiver-attributed cites enter the numerator,
                // asymmetrically, together. Feeding only the first half would mark every
                // subagent-only injection uncited by construction (that is why the face was
                // metered-but-excluded since v3.77); feeding only the second half would
                // credit the main-thread faces for citations the main thread never made.
                //
                // `sub.cited` is already the per-FILE intersection with `sub.injected`
                // (collectSubagentSurface), so this cannot credit an id the subagent surface
                // did not itself inject. Measured on the live corpus (1122 transcripts, 34
                // subagent-bearing sessions): 33 marginal (session,id) pairs enter the
                // denominator, 21.2% of them cited; 21 distinct observations behind the
                // uncited ones, FIVE at uncited_streak = 2. Four are 3->2 down-ranks (#8597,
                // #8847 with cited_count 56, #8948, #10246). At 2026-08-25 18:00Z #10716 was
                // at importance 2 — one miss from a 2->1 eviction out of
                // rankImperativeCandidates' own `importance >= 2` pool, the case
                // IMPERATIVE_POOL_BACKSTOP does not cover, and the reason "down-ranks, not
                // evictions" is wrong as a blanket claim. That row has since been promoted by
                // the very session that documented it (D#179: this loop cannot tell writing
                // `#NN` from applying it), so re-check the CLASS, not the row.
                // Cross-crediting is 3 pairs of 1181 DISTINCT (session,id) across the five
                // decay faces inside subagent-bearing sessions (0.25%), or 3 of 2738 the same
                // way corpus-wide (0.11%) — ids the main thread never cited but a subagent did.
                //
                // ON by default since v3.83.0; `CLAUDE_MEM_SUBAGENT_DECAY=0` restores the
                // metered-but-never-decaying state the face sat in from v3.77 to v3.82.
                //
                // The denominator is a COPY, not a mutation of `injected`: the edge
                // attribution below takes `mainInjectedIds: injected` to keep sidechain-only
                // injections from accruing file-edge misses (review D#78), and folding the
                // subagent ids into that set would undo exactly that guard.
                // The promotion-only half: a Key Context row the agent actually
                // cited joins the decay set (and takes the promote branch); one
                // it ignored is never entered, so it cannot streak or demote.
                for (const id of keyCtxIds) if (citedMain.has(id)) injected.add(id);
                // BOTH halves of the merge are COPIES, built AFTER the keyctx promotion above
                // so they carry it too. When the flag is off each IS the original object, so
                // every consumer below is byte identical to the pre-D#177 path.
                //
                // The copies are the whole safety property. `injected` and `citedMain` have
                // four consumers between them and only `applyCitationDecay` should see the
                // subagent ids; the first draft of this change mutated `citedMain` in place
                // and the pre-tag review measured both leaks it caused:
                //   • recordCitationSurfaces (below) scored a `pretool` row the main thread
                //     never cited as a pretool HIT — `pretool.cited_n` 0 -> 1 on a
                //     two-observation probe. That is the caliber CLAUDE.md publishes for the
                //     funnel ("cited as #NN in the session's own MAIN-THREAD text"), so it
                //     would have made citation_surface_log and citation-live-replay.mjs
                //     permanently different rulers — the v3.81.0 cross-agent defect, mirrored.
                //   • resolveEdgeAttribution gates sidechain edges on
                //     `!mainInjected.has(id) && !cited.has(id)`, so a file edge flipped MISS
                //     -> HIT (`miss_streak` 1 -> 0). The comment there defends the DENOMINATOR
                //     half of that gate and says nothing about the numerator, which is exactly
                //     how the leak got past a reading of it.
                const decayInjected = subDecayOn ? new Set([...injected, ...sub.injected]) : injected;
                const decayCited = subDecayOn ? new Set([...citedMain, ...sub.cited]) : citedMain;
                // D#60: the idempotency key must be the CC session UUID, NOT the
                // project-scoped memory sessionId — concurrent same-project CC
                // sessions share the latter, so the second session's decay pass
                // read "already decided" and silently undercounted decay_seen /
                // streaks / adoption denominators. Fallback keeps legacy
                // stdin-less invocations on the old key.
                const r = applyCitationDecay(db, project, decayInjected, decayCited, ccSessionId || sessionId);
                debugLog('DEBUG', 'handleStop', `citation-decay: touched=${r.touched} promoted=${r.promoted} demoted=${r.demoted}`);
                // R1: persist this session's invocation→cite funnel row. touched =
                // obs resolved this run (denominator), promoted = obs cited this run
                // (numerator). Idempotent (touched is 0 on re-fire) + best-effort.
                recordCitationFunnel(db, project, sessionId, r.touched, r.promoted);
                // v45: the same funnel split by injection FACE. Keyed on
                // ccSessionId — the SAME D#60 reasoning as applyCitationDecay
                // above, and load-bearing here for a second reason: this table
                // OVERWRITES rather than accumulates, and the memory sessionId
                // is one file per PROJECT, so two concurrent CC sessions in one
                // project would share a row and the later Stop would erase the
                // earlier session's counts outright. citation_log survives the
                // shared key only because it adds deltas.
                // keyctx rides along for VISIBILITY only — it is a separate
                // telemetry table, so recording it here cannot widen the decay
                // denominator the way v3.66.0's union did.
                recordCitationSurfaces(db, project, ccSessionId || sessionId,
                  { ...injectedBySurface, keyctx: keyCtxIds }, citedMain);
                // P1 (D#78): per-edge attribution. The session cooldown file
                // (keyed by CC session id) records which FILE each obs was
                // injected for; resolve those (obs,file) edges as hit/miss with
                // the same citedMain set. Lives inside the same text-floor gate
                // so a tool-only Stop can't lock edges as missed. Best-effort.
                // Keying on ccSessionId (NOT the rotating memory sessionId)
                // matches the cooldown file's lifetime — a memory-session
                // rotation mid-CC-session must not re-resolve old injections as
                // fresh misses. mainInjectedIds mirrors the mainOnly discipline
                // above: sidechain-only injections in the cooldown never accrue
                // misses (review D#78).
                try {
                  if (ccSessionId) {
                    const edges = readPreRecallFileEdges(RUNTIME_DIR, ccSessionId);
                    if (edges.length > 0) {
                      const er = resolveEdgeAttribution(db, project, edges, citedMain, ccSessionId,
                        { mainInjectedIds: injected });
                      debugLog('DEBUG', 'handleStop', `edge-attribution: edges=${er.touchedEdges} hits=${er.hits} misses=${er.misses}`);
                    }
                  }
                } catch (e) { debugCatch(e, 'handleStop-edge-attribution'); }
              }
            }
          } catch (e) { debugCatch(e, 'handleStop-citation-decay'); }

          // Persist cite-recall ratio for the next SessionStart to surface as
          // feedback. This block re-scans the transcript rather than threading the
          // count through `extractCitationsFromTranscript`, so the bump path stays
          // unchanged — and since P2-8 every scanner in it shares ONE parse via
          // lib/transcript-scan.mjs, so "scan again" costs an array iteration, not a
          // re-read. (The old wording, "cheap; the file is already in OS cache", was
          // arguing the pre-memo case: the OS cache saved the read, never the parse,
          // which was ~all of the cost.)
          try {
            const stats = computeCiteRecall(transcriptPath);
            // B2 (v2.83.1): also persist the bugfix-shape nudge/save delta so
            // the next SessionStart can surface "N unsaved bugfix-shape edits"
            // alongside cite-recall. Same scan target (transcript already in OS
            // cache); same persistence file; one extra line in buildCiteRecallNudge.
            const bugfixStats = countUnsavedBugfixShape(transcriptPath);
            const dest = citeRecallPathFor(RUNTIME_DIR, project);
            // Carry the consecutive-low-cite streak forward so the SessionStart
            // nag can self-silence after the project has ignored it N times.
            let priorStreak = 0;
            try { priorStreak = JSON.parse(readFileSync(dest, 'utf8')).lowStreak || 0; } catch {}
            const lowStreak = nextCiteLowStreak(priorStreak, stats);
            // G3: finalized-in-conversation + zero deliberate persistence →
            // decisionSignal rides the payload; next SessionStart reminds once.
            let decisionSignal = null;
            try {
              const promptRows = db.prepare(`
                SELECT prompt_text FROM user_prompts
                WHERE content_session_id = ? ORDER BY prompt_number ASC LIMIT 200
              `).all(sessionId);
              const d = detectUnpersistedDecision({
                prompts: promptRows.map((r) => r.prompt_text),
                transcriptPath,
              });
              if (d.fire) decisionSignal = d.signal;
            } catch (e) { debugCatch(e, 'handleStop-persist-reminder'); }
            const payload = { ...stats, ...bugfixStats, lowStreak, decisionSignal, project, savedAt: Date.now() };
            writeFileSync(dest, JSON.stringify(payload), { mode: 0o600 });
          } catch (e) { debugCatch(e, 'handleStop-cite-recall-persist'); }

          // D#152: the `subagent` face. Recorded in its OWN
          // recordCitationSurfaces call because it carries a different `cited`
          // set — a lesson handed to a dispatched subagent is cited in that
          // subagent's own transcript. Folding it into the main call would score
          // subagent injections against citedMain and report 0% by
          // construction; folding its cites INTO citedMain would credit the
          // main-thread faces for citations the main thread never made. The
          // upsert key is (project, session, surface), so two calls with
          // disjoint face sets do not collide.
          //
          // SINCE v3.83.0 (D#177) this is no longer metering-only: the face DOES reach
          // applyCitationDecay, through the `decayInjected` / `decayCited` copies above.
          // The sentence above about folding cites into `citedMain` still holds and is the
          // reason those are copies — this call, `resolveEdgeAttribution` and the keyctx
          // promotion all keep the un-widened set. `CLAUDE_MEM_SUBAGENT_DECAY=0` returns
          // the face to metering-only.
          //
          // The "placed LAST" note below is now historical: `collectSubagentSurface` runs
          // at the HEAD of this block (the decay loop needs its result), and `sub` here is
          // that same object rather than a second call. The parse-count property the note
          // defends is unchanged — see the comment at the collection site.
          // earlier, this block costs ONE extra parse of the parent — the memo
          // re-caches on the first re-read, so it is one, not one per later
          // scanner — and breaks the "one parse per Stop" property the block
          // above documents. Measured by instrumenting the parse: 1 parent parse
          // at this position, 2 when relocated earlier. ~25ms on the largest
          // real transcript here (5.4MB), matching lib/transcript-scan.mjs's
          // own header figure.
          // The text floor is re-checked rather than inherited — same reason as
          // every other face: a tool-only Stop must not bank a verdict, and it
          // must not enter the funnel's session denominator either.
          try {
            if (hasMainThreadAssistantText(transcriptPath)) {
              // `sub` is the one collected at the top of this block — a second
              // collectSubagentSurface call here would re-parse every sidechain file and,
              // worse, could disagree with the set the decay loop above just scored.
              if (sub.injected.size > 0) {
                recordCitationSurfaces(db, project, ccSessionId || sessionId,
                  { subagent: sub.injected }, sub.cited);
                debugLog('DEBUG', 'handleStop',
                  `subagent-face: files=${sub.files} injected=${sub.injected.size} cited=${sub.cited.size}`);
              }
            }
          } catch (e) { debugCatch(e, 'handleStop-subagent-face'); }
        }
      } catch (e) { debugCatch(e, 'handleStop-citation-track'); }
    } finally {
      db.close();
    }
  }

  // Spawn background for session summary (pass sessionId and project).
  // CLAUDE_MEM_SKIP_SUMMARY brings this in line with every other background
  // worker (auto-compress / llm-optimize / auto-maintain all have one). It was
  // the only ungated spawnBackground, which made Stop untestable end-to-end
  // without residue: the detached child outlives the parent process an e2e test
  // waits on, then recreates the sandbox tree behind the test's cleanup. Any
  // grace period for that is a race, not a barrier — the post-tag review timed a
  // recreate at 432ms and watched a 300ms grace lose.
  if (!process.env.CLAUDE_MEM_SKIP_SUMMARY) spawnBackground('llm-summary', sessionId, project);

  // Clean session file AFTER spawning background
  try { unlinkSync(sessionFile()); } catch {}
}

// ─── SessionStart Handler + CLAUDE.md Persistence (Tier 1 A, E) ─────────────

// Build the SessionStart nudge line shown when the prior session's cite-recall
// fell below threshold. Empty string = no surface (insufficient signal, recall
// already healthy, or feature opted-out via env). Default threshold 0.6,
// min injected 5 — both env-overridable for ops tuning + tests.
// Thin wrapper: lib/cite-back-hint.mjs owns the logic so it stays unit-tested.
// Passing module-level RUNTIME_DIR keeps the call site identical to pre-v2.83.1.
function buildCiteRecallNudge(project) {
  return libBuildCiteRecallNudge(project, RUNTIME_DIR);
}

// GC stale per-session runtime files older than 24h: pre-recall cooldowns AND
// (D#120) the per-session injected-ids markers — both grow one file per session.
// Pulled out of pre-tool-recall.js (where it ran on every Edit, costing 15-30
// disk stats per call on long-lived projects) and consolidated here — once per
// SessionStart is enough to keep RUNTIME_DIR from growing unbounded.
const PRE_RECALL_COOLDOWN_STALE_MS = 24 * 60 * 60 * 1000;
function gcStalePreRecallCooldowns() {
  try {
    const now = Date.now();
    for (const name of readdirSync(RUNTIME_DIR)) {
      // D#120: the injected-ids marker is also per-session now — same growth
      // shape as the cooldown files, same 24h GC (dedup window is 5 min).
      const isCooldown = name.startsWith('pre-recall-cooldown-') && name.endsWith('.json');
      const isInjectedMarker = name.startsWith('.claude-mem-injected-')
        || name.startsWith('.claude-mem-keyctx-'); // D#123 Key Context marker — same per-session growth, same 24h GC
      if (!isCooldown && !isInjectedMarker) continue;
      try {
        const p = join(RUNTIME_DIR, name);
        const st = statSync(p);
        if (now - st.mtimeMs > PRE_RECALL_COOLDOWN_STALE_MS) unlinkSync(p);
      } catch { /* silent per-entry */ }
    }
  } catch { /* silent — RUNTIME_DIR may not exist on first run */ }
}

// ─── SessionStart phase helpers ──────────────────────────────────────────────
// Extracted verbatim from handleSessionStart (audit P1-10) so the dispatcher
// reads as a sequence of named phases. Each is a self-contained side-effect unit
// (db / fs / stdout / background spawns) with a narrow input contract and no
// return-state coupling; behavior is byte-identical to the prior inline blocks.

function runSessionStartDbMutations(db, { sessionId, project, prevSessionId, now }) {
  // ── DB mutations in a transaction (crash-safe consistency) ──
  const staleSessionCutoff = Date.now() - STALE_SESSION_MS;

  db.transaction(() => {
    // Ensure session exists in DB (INSERT OR IGNORE avoids race condition)
    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

    // Complete previous session if this is a mid-session restart (/clear, /compact, crash)
    if (prevSessionId) {
      db.prepare(`
        UPDATE sdk_sessions SET status = 'completed', completed_at = ?, completed_at_epoch = ?
        WHERE content_session_id = ? AND status = 'active'
      `).run(now.toISOString(), now.getTime(), prevSessionId);
    }

    // Stale session cleanup: mark 24h+ active sessions as abandoned
    db.prepare(`
      UPDATE sdk_sessions SET status = 'abandoned'
      WHERE status = 'active' AND started_at_epoch < ?
    `).run(staleSessionCutoff);

    // The two auto-compress marking passes that used to run here moved to the 24h
    // auto-maintain worker (audit 2026-08-22, P2-11): they are maintenance, and every
    // boot paid two full-table conditional UPDATEs for them. markAutoCompressible in
    // lib/maintain-core.mjs holds the (unchanged) predicates.
  })();
}

// Per-project 24h gate for the auto-compressible marking. Separate from the global
// maintain gate on purpose: the marking is project-scoped work that every project needs
// daily, while the pass it used to ride on (VACUUM snapshot + purge + decay + dedup) is
// whole-DB work that should happen once a day in total.
function markCompressibleGateFile(project) {
  // Project names arrive already mangled by inferProject (`projects--mem`), but this is
  // a filename, so do not trust that — one stray separator writes outside RUNTIME_DIR.
  return join(RUNTIME_DIR, `last-mark-compressible-${String(project).replace(/[^A-Za-z0-9._-]/g, '-')}.json`);
}

function markAutoCompressibleIfDue(db, project) {
  if (!project) {
    // Every production spawn passes it (spawnBackground('auto-maintain', project)); a
    // hand-run `hook.mjs auto-maintain` does not. Say so rather than skipping in
    // silence — work vanishing without a word is this codebase's recurring shape.
    debugLog('DEBUG', 'auto-maintain', 'no project argument — skipping auto-compress marking');
    return;
  }
  const gate = markCompressibleGateFile(project);
  try {
    const last = JSON.parse(readFileSync(gate, 'utf8'));
    if (Date.now() - last.epoch < 24 * 3600000) return;
  } catch { /* no gate file → due */ }
  try {
    const marked = markAutoCompressible(db, project);
    if (marked.aged > 0) debugLog('DEBUG', 'auto-maintain', `auto-compressed ${marked.aged} old observations`);
    if (marked.noise > 0) debugLog('DEBUG', 'auto-maintain', `auto-compressed ${marked.noise} LOW_SIGNAL noise (7d window)`);
    writeFileSync(gate, JSON.stringify({ epoch: Date.now() }));
  } catch (e) { debugCatch(e, 'auto-maintain-mark-compressible'); }
}

function runSessionStartAutoMaintain(db, project) {
  // The auto-compressible marking runs on its OWN per-project gate, before the global
  // one below. v3.75.0 moved this work off SessionStart onto this worker (P2-11) and,
  // by putting it inside the global `shouldMaintain` block, cut its coverage from
  // "every project, every boot" to "one project per 24h" — RUNTIME_DIR is a single
  // global directory, so whichever project wins the gate is the only one marked, and
  // with N projects in rotation N-1 never get the 7-day noise pass. The move was right;
  // the shared gate was not. Heavy work (VACUUM snapshot, purge, decay, dedup) stays on
  // the global gate — that genuinely should run once a day, not once per project.
  markAutoCompressibleIfDue(db, project);

  // Auto-maintain: cleanup + decay + boost + purge, gated to once per 24h
  const maintainFile = join(RUNTIME_DIR, 'last-auto-maintain.json');
  let shouldMaintain = true;
  try {
    const last = JSON.parse(readFileSync(maintainFile, 'utf8'));
    if (Date.now() - last.epoch < 24 * 3600000) shouldMaintain = false;
  } catch {}
  if (shouldMaintain) {
    try {
      const STALE_AGE = Date.now() - 30 * DAY_MS;
      const OP_CAP = 500;
      // Shared maintenance context (whole-DB, cap 500) — used by every maintain-core
      // op below AND the MED-2 snapshot guard. injection_count>0 protection lives in
      // decayAndMarkIdle.
      const mctx = { projectFilter: '', baseParams: [], staleAge: STALE_AGE, opCap: OP_CAP };

      // MED-2: snapshot the DB before the irreversible purge/cleanup hard-deletes
      // below, but only when rows will actually be removed (cheap COUNT). Must run
      // here, outside any transaction — VACUUM cannot run inside one. Best-effort:
      // snapshotDb never throws, so a backup failure cannot block auto-maintain.
      if (hardDeleteCandidateCount(db, mctx, { cleanup: true, purge: true }) > 0) {
        snapshotDb(db, { tag: 'pre-maintain' });
      }

      // Purge FIRST via the SHARED purgeStale — was an inline DELETE that skipped
      // recoverChildrenOf, so purging a keeper that had absorbed dups orphaned its
      // children (compressed_into dangling at a deleted id). purgeStale recovers them
      // first and caps at opCap. Schema has no marked_at_epoch, so retention anchors on
      // created_at_epoch: 30d marking gate + 7d grace = 37d.
      // The marking itself already ran at the top of this function, on its own
      // per-project gate — it must not be conditioned on the global one (see
      // markAutoCompressibleIfDue). It still happens BEFORE the purge/decay ops below,
      // preserving the order the SessionStart transaction had relative to them.

      const purged = purgeStale(db, mctx, Date.now() - 37 * DAY_MS);
      if (purged > 0) debugLog('DEBUG', 'auto-maintain', `purged ${purged} stale observations`);

      const cleaned = cleanupBroken(db, mctx);
      if (cleaned > 0) debugLog('DEBUG', 'auto-maintain', `cleaned ${cleaned} broken observations`);

      // Self-heal legacy orphans: children whose compression keeper was hard-deleted
      // before recoverChildrenOf existed are hidden + queue-less (unreachable). Resurface
      // them so normal decay/GC handles them on merit. Non-destructive (un-hide only).
      const orphansRecovered = recoverOrphanedChildren(db, mctx);
      if (orphansRecovered > 0) debugLog('DEBUG', 'auto-maintain', `recovered ${orphansRecovered} orphaned compression children`);

      // Heal lesson rows citation-decay buried at importance 0 under the old floor=0.
      // Non-destructive (0→1 on lesson-bearing rows only); idempotent no-op once none remain.
      const lessonsHealed = recoverBuriedLessons(db, mctx);
      if (lessonsHealed > 0) debugLog('DEBUG', 'auto-maintain', `healed ${lessonsHealed} lesson rows buried at importance 0`);

      // Heal deferred_work rows whose closing obs / source prompt was deleted while FK was OFF
      // (dangling ref foreign_key_check flags). Applies the ON DELETE SET NULL the FK would.
      const deferredHealed = sweepDeferredWorkOrphans(db, mctx);
      if (deferredHealed > 0) debugLog('DEBUG', 'auto-maintain', `healed ${deferredHealed} deferred-work rows with dangling references`);

      const { decayed, idleMarked } = decayAndMarkIdle(db, mctx);
      if (decayed > 0) debugLog('DEBUG', 'auto-maintain', `decayed ${decayed} stale observations`);
      if (idleMarked > 0) debugLog('DEBUG', 'auto-maintain', `marked ${idleMarked} idle as pending-purge`);

      const boosted = boostAccessed(db, mctx);
      if (boosted > 0) debugLog('DEBUG', 'auto-maintain', `boosted ${boosted} frequently-accessed observations`);

      // Auto-dedup (exact): merge identical-title observations within 1h.
      // Catches rapid duplicate writes (same hook firing twice, race conditions).
      // BOTH join sides must be live (audit 2026-08-14 H-1): without the
      // superseded_at filters (which the fuzzy channel below always had), a row the
      // fuzzy pass had tombstoned could come back as `a` (a.id < b.id) and tombstone
      // the LIVE keeper `b` — both copies gone from every read path. Worse, a user
      // correction saved with supersedes=[#A] (A.superseded_by = B's NUMERIC id) has
      // the same title as A, so the pair (A, B) tombstoned the correction B itself
      // and the string 'auto-dedup' write clobbered numeric supersession chains that
      // citation-tracker decay hand-off and timeline re-anchoring both follow. The
      // UPDATE repeats the guard so a concurrent writer can't re-stamp a chain.
      const dupPairs = db.prepare(`
        SELECT a.id as keep_id, b.id as remove_id
        FROM observations a
        JOIN observations b ON a.title = b.title AND a.project = b.project
          AND a.id < b.id
          AND ABS(a.created_at_epoch - b.created_at_epoch) < 3600000
          AND ${liveObsFilterSql('a')}
          AND ${liveObsFilterSql('b')}
        LIMIT 20
      `).all();
      if (dupPairs.length > 0) {
        const removeIds = dupPairs.map(p => p.remove_id);
        stampDedupSuperseded(db, removeIds, 'auto-dedup');
        debugLog('DEBUG', 'auto-maintain', `auto-deduped ${dupPairs.length} near-identical observations`);
      }

      // Auto-dedup (fuzzy): catches near-identical titles that exact-match
      // misses across larger time windows — e.g. episode-batch titles like
      // "Modified A.mjs, B.mjs" vs "Modified B.mjs, A.mjs" written days apart.
      // MinHash pre-filter (≥0.7) cuts the O(N²) scan; Jaccard ≥0.95 stays
      // well clear of legit "two updates same area" pairs (those typically
      // score 0.7–0.85, surfaced via `maintain scan` for manual review).
      // Bounded by ${SCAN_LIMIT} recent rows × ${FUZZY_MAX_MERGES}-merge cap.
      if (!process.env.CLAUDE_MEM_SKIP_AUTO_DEDUP_FUZZY) {
        const SCAN_LIMIT = 500;
        const FUZZY_MAX_MERGES = 20;
        const recent = db.prepare(`
          SELECT id, title, importance, created_at_epoch, narrative, text
          FROM observations
          WHERE ${liveObsFilterSql('')}
            AND created_at_epoch > ?
            AND title IS NOT NULL AND title != ''
          ORDER BY created_at_epoch DESC LIMIT ${SCAN_LIMIT}
        `).all(STALE_AGE);
        if (recent.length >= 2) {
          // audit #8: supersede only when title AND body match — title-only (a word-SET
          // metric) collapsed distinct observations sharing a title token-set. The
          // selection is the shared pure core in lib/maintain-core (unit-tested there).
          const rows = recent.map(r => ({
            id: r.id, title: r.title, importance: r.importance,
            body: (r.narrative && r.narrative.trim()) || (r.text && r.text.trim()) || '',
          }));
          const fuzzyRemoveIds = selectFuzzyDedupeIds(rows, { maxMerges: FUZZY_MAX_MERGES });
          if (fuzzyRemoveIds.length > 0) {
            stampDedupSuperseded(db, fuzzyRemoveIds, 'auto-dedup-fuzzy');
            debugLog('DEBUG', 'auto-maintain', `fuzzy auto-deduped ${fuzzyRemoveIds.length} near-identical observations`);
          }
        }
      }

      // v3.76.0: the automatic path used to promote and never demote. boostAccessed ran
      // above; demotePinned was not even imported here, and it sat outside the default op
      // set of the CLI and MCP faces too — so the only op that can reach a
      // heavily-injected-but-uncited row (regular decay deliberately protects
      // injection_count>0) ran solely when a human typed `--ops demote_pinned`. Measured
      // on the maintainer's live DB before the fix: 148 rows demoted by citation decay,
      // never cited, and back at importance>=3, 148/148 of them boost-eligible.
      //
      // Placed AFTER boost, for the obvious reason: boostAccessed lifts any
      // access_count>3 row with importance<3, so demoting first hands the row straight
      // back at 2 (mem-cli had exactly that order and silently undid its own demotion
      // inside a single run).
      //
      // Placed AFTER fuzzy dedup, for a less obvious one, found by pre-tag review: the
      // dedup block above re-SELECTs `importance` and selectFuzzyDedupeIds keeps the
      // higher-importance member of a near-duplicate pair. Demoting first inverted that
      // rule using a value rewritten 40 lines earlier in the same pass — the pinned row
      // lost and was tombstoned, keeping the copy WITHOUT the injection history. Dedup
      // now decides on pre-demotion importance. Nothing between boost and here reads
      // importance, so the move is free.
      //
      // Whole-DB mctx (projectFilter ''), so unlike markAutoCompressibleIfDue this needs
      // NO per-project gate: one run under the global 24h gate covers every project at
      // once. Do not "fix" it into a per-project gate — that is the v3.75.0 regression in
      // reverse.
      const demotedPinned = resolveDefaultMaintainOps().includes('demote_pinned')
        ? demotePinned(db, mctx)
        : 0;
      if (demotedPinned > 0) debugLog('DEBUG', 'auto-maintain', `demoted ${demotedPinned} pinned-but-uncited observations (no lesson → 1, lesson → 2)`);

      // Orphan sweep: remove `ep-flush-*` / `pending-*` runtime files older
      // than 1h. handleLLMEpisode normally unlinks its own tmpFile on every
      // exit path, but a crashed worker (OOM, host reboot, kill -9) leaves
      // the file behind, and the doctor "Stale temp files" warning then
      // accumulates indefinitely. fs-only; runs inside the 24h gate so it
      // shares cadence with the rest of auto-maintain.
      //
      // Since audit P1-12 this also reclaims abandoned per-project episode buffers at 7d.
      // That one is named individually in the log: every other family it sweeps is residue
      // or a re-derivable tracker, while `ep-<project>.json` holds unflushed observations —
      // and the alternative to deleting it is worse (SessionStart flushes whatever it finds
      // with no staleness gate, so a revisit stamps months-old activity with today's date).
      try {
        const swept = sweepOrphanEpisodeFiles(RUNTIME_DIR, {
          onSweep: (name, kind) => {
            if (kind === 'buffer') debugLog('DEBUG', 'auto-maintain', `discarding abandoned episode buffer ${name} (>7d; would otherwise flush mis-dated on revisit)`);
          },
        });
        if (swept > 0) debugLog('DEBUG', 'auto-maintain', `swept ${swept} orphan ep-flush/pending file(s)`);
      } catch (e) { debugCatch(e, 'auto-maintain-orphan-sweep'); }

      // GC expired session_handoffs: the consume-DELETE (handleSessionStart) only removes
      // the single handoff a continuation reads back; an 'exit'/'compact' that is never
      // resumed (and every superseded 'clear') lingers forever — read paths filter by
      // expiry but nothing reaped the rows. Delete past-expiry rows with a +1d margin so a
      // still-readable handoff is never raced away. 'clear' 6h+1d, 'exit'/other 7d+1d.
      try {
        const gc = db.prepare(`
          DELETE FROM session_handoffs
          WHERE (type = 'clear' AND created_at_epoch < ?)
             OR (type != 'clear' AND created_at_epoch < ?)
        `).run(Date.now() - HANDOFF_EXPIRY_CLEAR - DAY_MS, Date.now() - HANDOFF_EXPIRY_EXIT - DAY_MS);
        if (gc.changes > 0) debugLog('DEBUG', 'auto-maintain', `gc'd ${gc.changes} expired session_handoffs`);
      } catch (e) { debugCatch(e, 'auto-maintain-handoff-gc'); }

      // Mark maintenance as done (24h gate) — even though compression runs in background
      writeFileSync(maintainFile, JSON.stringify({ epoch: Date.now() }));
      // Weekly summary grouping runs in background to avoid blocking SessionStart
      if (!process.env.CLAUDE_MEM_SKIP_COMPRESS) spawnBackground('auto-compress');
      if (!process.env.CLAUDE_MEM_SKIP_OPTIMIZE) spawnBackground('llm-optimize');
    } catch (e) { debugCatch(e, 'auto-maintain'); }
  }
}

// SessionStart boot path (MED-4): cheap 24h gate pre-check only. When maintenance is
// due, the heavy pass (VACUUM-INTO snapshot + purge/cleanup/decay/dedup) is handed to
// a detached `auto-maintain` worker via spawnBackground so it never blocks interactive
// session start. The worker re-checks the same gate (idempotent) before doing the work.
function scheduleSessionStartAutoMaintain(project) {
  // TWO gates, either of which is enough to spawn. Checking only the global one is what
  // made the marking single-project in v3.75.0: in a multi-project rotation the global
  // stamp is already fresh by the time the second project boots, so its worker never
  // ran and its rows were never marked.
  const due = (file) => {
    try {
      const last = JSON.parse(readFileSync(file, 'utf8'));
      return Date.now() - last.epoch >= 24 * 3600000;
    } catch { return true; }   // no gate file → due
  };
  const maintainDue = due(join(RUNTIME_DIR, 'last-auto-maintain.json'));
  const markingDue = Boolean(project) && due(markCompressibleGateFile(project));
  if (!maintainDue && !markingDue) return;
  if (!process.env.CLAUDE_MEM_SKIP_MAINTAIN) spawnBackground('auto-maintain', project);
}

// The maintenance mutex deliberately does NOT end in `.lock`: cleanStaleLockFiles()
// below unlinks every `*.lock` in RUNTIME_DIR whose age exceeds STALE_LOCK_MS (30s)
// WITHOUT consulting the holder's pid — a policy written for the episode lock, whose
// critical section is milliseconds. A maintenance pass is seconds to minutes (VACUUM INTO
// snapshot, purge, decay, dedup over the whole DB), so that sweeper would strip this lock
// mid-pass and hand the exclusion straight back to the race it exists to close.
// proc-lock brings its own staleness policy (age OR provably-dead pid), which is the
// correct one here.
// Generous upper bound on one pass; a crashed holder is normally reclaimed sooner via the
// dead-pid check, so this only matters for a holder killed on another host.
const AUTO_MAINTAIN_LOCK_STALE_MS = 10 * 60 * 1000;

// Detached `auto-maintain` worker entry: opens its own DB and runs the maintenance
// pass off the interactive boot path. runSessionStartAutoMaintain still owns the 24h
// gate + the compress/optimize spawns at its tail.
//
// Cross-process mutual exclusion (2026-08-29 audit FLOW-1). The pass is shaped
// read-gate → long work → write-gate, so two Claude Code windows booting either side of
// the 24h boundary both see "due" and both spawn a worker. That breaks a documented
// in-process invariant: decayAndMarkIdle marks BEFORE it decays precisely so an imp-2 row
// cannot be decayed 2→1 and marked COMPRESSED_PENDING_PURGE in the same pass (MED-1, see
// its docblock — each importance tier is supposed to buy a grace cycle). Across two
// processes the ordering is gone: worker A decays 2→1, worker B's mark-idle then sees a
// qualifying imp-1 row and hides it, 37 days from a hard delete. The same overlap
// double-runs the cascade below it (duplicate weekly summaries from compressGroup, whose
// UPDATE has no compressed_into guard; doubled llm-optimize spend).
//
// Lock at the worker entry rather than around the individual ops: the cascade spawns sit
// inside the pass, so one gate covers the whole family. Not acquiring is a plain no-op —
// a peer is already doing exactly this work.
function handleAutoMaintain(project) {
  const release = acquireProcLock(join(RUNTIME_DIR, AUTO_MAINTAIN_LOCK), {
    staleMs: AUTO_MAINTAIN_LOCK_STALE_MS,
  });
  if (!release) {
    debugLog('DEBUG', 'auto-maintain', 'skipped — a live peer holds the maintenance lock');
    return;
  }
  try {
    const db = openDb();
    if (!db) return;
    try { runSessionStartAutoMaintain(db, project); }
    finally { try { db.close(); } catch { /* ignore */ } }
  } finally {
    release();
  }
}

function saveHandoffAndFastSummary(db, { prevSessionId, prevProject, project, ccSessionId, episodeSnapshot, now }) {
  // Shared clear handoff reference — queried once, used by fast summary + working state
  let prevClearHandoff = null;

  if (prevSessionId) {
    // Save handoff for cross-session continuity (/clear or /compact).
    // prevSessionId is the mem-internal id — use it to look up the finished session's
    // user_prompts / observations. ccSessionId (same CC session across /clear) scopes
    // the stored row so UserPromptSubmit can read its own handoff back.
    // Legacy/test paths (no stdin) fall back to prevSessionId for both.
    const handoffScopeId = ccSessionId || prevSessionId;
    try { buildAndSaveHandoff(db, prevSessionId, prevProject || project, 'clear', episodeSnapshot, handoffScopeId); }
    catch (e) { debugCatch(e, 'session-start-handoff'); }

    // Read the just-saved handoff for downstream consumers (fast summary remaining, working state).
    // Session-scoped read to avoid picking up a parallel session's clear handoff.
    try {
      prevClearHandoff = db.prepare(
        'SELECT working_on, unfinished, key_files FROM session_handoffs WHERE project = ? AND type = ? AND session_id = ?'
      ).get(prevProject || project, 'clear', handoffScopeId);
    } catch {}

    // Generate session summary for previous session (background Haiku — richer version)
    spawnBackground('llm-summary', prevSessionId, prevProject || project);

    // Build fast synchronous summary for immediate context availability.
    // Background llm-summary will produce a richer Haiku version later;
    // context injection query (ORDER BY created_at_epoch DESC) auto-prefers latest.
    try {
      const { request: fastRequestRaw, completed: fastCompletedRaw } = readFastSummarySource(db, prevSessionId);

      // Infer remaining_items from handoff unfinished (already built above at line 476)
      let fastRemainingRaw = '';
      if (prevClearHandoff?.unfinished) {
        fastRemainingRaw = extractUnfinishedSummary(prevClearHandoff.unfinished, 0);
      }
      // Fallback: episode errors
      if (!fastRemainingRaw && episodeSnapshot?.entries) {
        const errors = episodeSnapshot.entries.filter(e => e.isError).map(e => e.desc).filter(Boolean);
        if (errors.length > 0) fastRemainingRaw = errors.join('; ');
      }

      if (fastRequestRaw || fastCompletedRaw) {
        insertFastSummary(db, {
          sessionId: prevSessionId, project: prevProject || project, now,
          values: { request: fastRequestRaw, completed: fastCompletedRaw, remaining: fastRemainingRaw },
          limits: FAST_SUMMARY_LIMITS.sessionStart,
        });
      }
    } catch (e) { debugCatch(e, 'session-start-fast-summary'); }
  }
}

function cleanStaleLockFiles() {
  // Clean stale lock files in runtime dir
  try {
    for (const f of readdirSync(RUNTIME_DIR)) {
      if (!f.endsWith('.lock')) continue;
      const lp = join(RUNTIME_DIR, f);
      try {
        const raw = readFileSync(lp, 'utf8');
        const info = JSON.parse(raw);
        const age = Date.now() - (info.ts || 0);
        let stale = age > STALE_LOCK_MS;
        if (!stale && info.pid) {
          try { process.kill(info.pid, 0); } catch (killErr) {
            stale = killErr.code === 'ESRCH';
          }
        }
        if (stale) unlinkSync(lp);
      } catch {
        try {
          const st = statSync(lp);
          if (Date.now() - st.mtimeMs > STALE_LOCK_MS) unlinkSync(lp);
        } catch {}
      }
    }
  } catch {}
}

function buildFallbackFastSummary(db, { project, now, prevSessionId }) {
  // Fallback fast summary: if a recently completed session has no summary yet
  // (e.g. /exit → fast restart before Haiku finishes), build one synchronously.
  // Skipped when prevSessionId is set (already handled above).
  if (!prevSessionId) {
    try {
      const recentSession = db.prepare(`
        SELECT content_session_id, project FROM sdk_sessions
        WHERE project = ? AND status = 'completed' AND completed_at_epoch > ?
        ORDER BY completed_at_epoch DESC LIMIT 1
      `).get(project, Date.now() - 120000); // within last 2 minutes

      if (recentSession) {
        const hasSummary = db.prepare(`
          SELECT 1 FROM session_summaries WHERE memory_session_id = ? LIMIT 1
        `).get(recentSession.content_session_id);

        if (!hasSummary) {
          const { request: frRaw, completed: fcRaw } = readFastSummarySource(db, recentSession.content_session_id);
          if (frRaw || fcRaw) {
            // No remaining_items on this path: an /exit restart has no handoff and no
            // episode snapshot to infer one from. It was a bare '' in the SQL before.
            insertFastSummary(db, {
              sessionId: recentSession.content_session_id, project, now,
              values: { request: frRaw, completed: fcRaw },
              limits: FAST_SUMMARY_LIMITS.exitRestart,
            });
          }
        }
      }
    } catch (e) { debugCatch(e, 'session-start-exit-fast-summary'); }
  }
}

async function buildStartupDashboardText(db, project) {
  // T10c: Startup dashboard — aggregate git/tasks/plans/handoff/events into text.
  //
  // Returns the text rather than writing it: SessionStart has three would-be
  // stdout contributors (this, the <claude-mem-context> block, the update
  // banner) and handleSessionStart merges them into ONE envelope. Writing here
  // put a JSON document and raw prose on the same stdout, which stopped the
  // host from parsing the envelope at all — the whole `{"suppressOutput":true,
  // …}` object was delivered to the model as literal escaped text. See
  // tests/session-start-stdout-envelope.test.mjs.
  try {
    const { buildDashboard } = await import('./lib/startup-dashboard.mjs');
    // projectPath MUST come from the same place `project` does (inferProjectDir), not from
    // process.cwd(): otherwise the dashboard renders directory A's git state and task list
    // under directory B's project name whenever the hook process was not spawned at the
    // project root. See inferProjectDir()'s docblock for the case this closed.
    let dashboardText = buildDashboard({ db, project, projectPath: inferProjectDir() });
    const citeNudge = buildCiteRecallNudge(project);
    if (citeNudge) {
      dashboardText = dashboardText ? `${citeNudge}\n${dashboardText}` : citeNudge;
    }
    // v2.79: surface setup.sh dependency-install failure as a high-visibility
    // line at the very top of the dashboard. setup.sh writes runtime/.deps-broken
    // (JSON: ts/reason/root/repair) on failure and removes it on success — so
    // a stale flag self-heals on the next clean SessionStart. Without this
    // surface, hook degradation looks identical to "nothing happening" until
    // the user notices missing context days later.
    try {
      const depsFlag = join(RUNTIME_DIR, '.deps-broken');
      if (existsSync(depsFlag)) {
        let detail = 'unknown';
        let repair = '';
        try {
          const raw = readFileSync(depsFlag, 'utf8').trim();
          const parsed = JSON.parse(raw);
          detail = parsed.reason || detail;
          repair = parsed.repair || '';
        } catch { /* corrupt flag — surface the fact only */ }
        const nudgeLines = [
          '⚠️ [claude-mem-lite] Hook dependencies failed to install on the last SessionStart.',
          `   Reason: ${detail}`,
        ];
        if (repair) nudgeLines.push(`   Repair: ${repair}`);
        nudgeLines.push('   Until fixed, PreToolUse / PostToolUse / memory injection are degraded.');
        const nudge = nudgeLines.join('\n');
        dashboardText = dashboardText ? `${nudge}\n${dashboardText}` : nudge;
      }
    } catch (e) { debugCatch(e, 'session-start-deps-flag'); }
    return dashboardText || '';
  } catch (e) { debugCatch(e, 'session-start-dashboard'); return ''; }
}

async function handleSessionStart() {
  // GC stale per-session cooldown files. Cheap (<5ms typical) and idempotent;
  // moved here from pre-tool-recall.js's hot path.
  gcStalePreRecallCooldowns();
  // P2-15: the per-PROJECT half of the same problem — markers written once per
  // project and never revisited (session-/cite-recall-/skill cooldowns). Same
  // SessionStart cadence, 30d gate, named family list (hook-shared.mjs).
  try { sweepStaleProjectMarkers(RUNTIME_DIR); } catch { /* best-effort */ }
  // Bound the shadow-recommendation log (daily JSONL shards, no GC at write time).
  try { const { gcOldShadowShards } = await import('./registry-recommend.mjs'); gcOldShadowShards(); } catch { /* best-effort, never blocks SessionStart */ }
  // Same for the opt-in metrics sink (RUNTIME_DIR's parent is DB_DIR). Runs even when
  // metrics are disabled, so shards left by a since-toggled-off run still get pruned.
  try { gcOldMetricShards(join(RUNTIME_DIR, '..')); } catch { /* best-effort */ }

  // Plugin cache self-heal: Claude Code auto-updates the marketplace plugin can
  // re-populate cache/<ver>/hooks/hooks.json, reintroducing duplicate hook
  // registration alongside install.mjs-managed settings.json entries. Silently
  // clear — gated by hasInstallManagedHooks to avoid breaking plugin-only users.
  // Dynamic-import fallback: if plugin-cache-guard.mjs is missing (pre-2.31.2
  // auto-upgrade install), skip self-heal instead of crashing the entire hook.
  try {
    const guard = await loadCacheGuard();
    if (guard.hasInstallManagedHooks && guard.hasInstallManagedHooks()) {
      const cleared = guard.clearPluginCacheHooks({
        reason: 'Auto-healed by hook.mjs session-start — install.mjs-managed hooks active in settings.json',
      });
      if (cleared.length > 0) {
        debugLog('DEBUG', 'session-start', `auto-healed stale plugin cache hooks.json in version(s): ${cleared.join(', ')}`);
      }
    }
  } catch (e) { debugCatch(e, 'session-start-cache-heal'); }

  // Auto-adopt + migrate (v3.13 CLAUDE.md-steering). silentAutoAdopt is now an
  // IDEMPOTENT per-session sync, so it runs on EVERY SessionStart — not gated by
  // the one-shot RUNTIME_DIR marker. That gate is deliberately gone: existing
  // users whose marker predates v3.13 must still get migrated (legacy memory-dir
  // sentinel stripped, CLAUDE.md managed block written) on their next session.
  // The sync short-circuits cheaply once a project is already on the new scheme.
  // ANY install path — `/plugin install`, `npm install -g`, `npx`, manual — is
  // consent to integration. Scope:
  //   - gated by !MEM_NO_AUTO_ADOPT (explicit global escape hatch)
  //   - per-project opt-out via `<memdir>/.mem-no-auto-adopt` sentinel (managed
  //     by `claude-mem-lite adopt --disable / --enable`; checked inside
  //     silentAutoAdopt).
  //   - CLAUDE_MEM_NO_TEMPLATE_REFRESH=1 freezes the block against drift refresh.
  // Note v2.82.0: removed MEM_QUIET_HOOKS gate. That env var suppresses stdout
  // noise; it must NOT also disable side-effect work (PostToolUse writes the
  // DB unconditionally — auto-adopt follows the same rule). Failures are
  // swallowed; the marker is still written for telemetry/back-compat.
  try {
    if (process.env.MEM_NO_AUTO_ADOPT !== '1') {
      const project = inferProject();
      const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const { silentAutoAdopt } = await import('./adopt-cli.mjs');
      const r = silentAutoAdopt({ cwd, markerDir: RUNTIME_DIR, markerKey: project });
      if (r.ok) {
        debugLog('DEBUG', 'session-start-auto-adopt', `action=${r.action} project=${project}`);
      } else {
        debugLog('DEBUG', 'session-start-auto-adopt', `skipped project=${project} reason=${r.reason}`);
      }
    }
  } catch (e) { debugCatch(e, 'session-start-auto-adopt'); }

  // Read CC real session_id from hook stdin — used to scope handoff rows so parallel
  // sessions for the same project don't clobber each other (see docs/bug.txt).
  let ccSessionId = null;
  try {
    const raw = await readStdin();
    const hookData = JSON.parse(raw.text);
    if (typeof hookData?.session_id === 'string' && hookData.session_id.length > 0) {
      ccSessionId = hookData.session_id;
    }
  } catch { /* stdin unavailable — legacy behavior */ }

  // Snapshot episode BEFORE flush for handoff extraction
  const episodeSnapshot = readEpisodeRaw();

  // Flush any leftover episode buffer from previous session (e.g. after /clear).
  //
  // A buffer older than STALE_EPISODE_BUFFER_AGE_MS is DISCARDED, not flushed. This is the
  // half of P1-12 the orphan sweep cannot reach: the sweep runs inside the detached
  // auto-maintain worker scheduled further down this same function, so on the revisit that
  // matters the flush below has already happened and the sweeper finds nothing. Without this
  // gate, returning to a project abandoned months ago injects its months-old tool activity
  // stamped with today's date — the exact harm hook-shared.mjs's threshold docblock names.
  // Same constant, because it is the same question ("did this buffer outlive its session by
  // an order of magnitude?"), asked at the other end.
  if (acquireLock()) {
    try {
      let stale = false;
      try {
        stale = Date.now() - statSync(episodeFile()).mtimeMs > STALE_EPISODE_BUFFER_AGE_MS;
      } catch { /* no buffer file — readEpisode() returns null below */ }
      if (stale) {
        debugLog('INFO', 'session-start', `discarding stale episode buffer (>${STALE_EPISODE_BUFFER_AGE_MS}ms): ${episodeFile()}`);
        try { unlinkSync(episodeFile()); } catch { /* best-effort */ }
      } else {
        const prevEpisode = readEpisode();
        if (prevEpisode && prevEpisode.entries && prevEpisode.entries.length > 0) {
          flushEpisode(prevEpisode, 'SessionStart');
        }
      }
    } finally {
      releaseLock();
    }
  }

  // Detect mid-session restart (/clear or /compact): if a recent session file exists,
  // the previous session ended without Stop hook firing. Read BEFORE createSessionId()
  // overwrites the session file. Normal /exit deletes the file, so this only triggers
  // for /clear, /compact, or crash recovery.
  let prevSessionId = null;
  let prevProject = null;
  try {
    const data = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    if (Date.now() - data.startedAt < SESSION_EXPIRY_MS) {
      prevSessionId = data.id;
      prevProject = data.project;
    }
  } catch {} // No session file = fresh startup, nothing to recover

  // Tier 1 A: Create unique session ID
  const sessionId = createSessionId();
  const project = inferProject();

  const db = openDb();
  if (!db) return;

  try {
    const now = new Date();

    runSessionStartDbMutations(db, { sessionId, project, prevSessionId, now });

    scheduleSessionStartAutoMaintain(project);

    // ── Non-transactional operations (side effects, background work) ──

    saveHandoffAndFastSummary(db, { prevSessionId, prevProject, project, ccSessionId, episodeSnapshot, now });

    cleanStaleLockFiles();

    buildFallbackFastSummary(db, { project, now, prevSessionId });

    const dashboardText = await buildStartupDashboardText(db, project);

    // Build the full context body via shared helper (also used by `mem-cli context`).
    // Queries session_summaries, key observations, clear handoff, and the
    // token-budgeted observation pool directly from the DB.
    // Pass CC session id so the Working State block is scoped to this session,
    // preventing parallel sessions from seeing each other's /clear handoff.
    const contextCollector = {};
    const fullContext = buildSessionContextLines(db, project, now, ccSessionId, contextCollector);

    // Stdout is the sole context-delivery channel, and it carries exactly ONE
    // JSON envelope. Everything SessionStart wants to say is collected here and
    // written once below: a JSON document followed by raw prose is not a JSON
    // document, and the host then declines to parse the envelope — delivering
    // `{"suppressOutput":true,…}` to the model as literal escaped text instead
    // of honouring it.
    //
    // Skip the wrapper entirely when there is no body. On a brand-new install every
    // section is empty, and the hook still emitted `<claude-mem-context>\n\n</...>` —
    // a framing block that asserts a memory surface and then shows nothing, which is
    // both wasted context and an active misread ("memory exists and is empty" is a
    // reason NOT to call mem_*).
    const stdoutParts = [];
    if (dashboardText) stdoutParts.push(dashboardText);
    if (fullContext.trim()) {
      stdoutParts.push(`<claude-mem-context>\n${fullContext}\n</claude-mem-context>`);
    }

    // Auto-update banner (audit P3d): NON-BLOCKING — read from cached state
    // (zero network) and, if the 24h check is due, refresh in a detached
    // background worker so SessionStart never blocks on a GitHub fetch (was an
    // inline `await checkForUpdate()` that could stall the session 3-6s).
    // Collected here rather than written at the end of the handler so it joins
    // the single envelope; the spawn stays a side effect and is fired below.
    let updateCheckDue = false;
    try {
      const { getCachedUpdateBanner, isUpdateCheckDue } = await import('./hook-update.mjs');
      const banner = getCachedUpdateBanner();
      // The human channel, not additionalContext: "vX available" is a notice for the
      // USER. Folding it into additionalContext under suppressOutput:true kept its
      // content and lost its audience. Claude Code renders a command hook's top-level
      // systemMessage as its own hook_system_message, independent of the context
      // block — see lib/hook-stdout.mjs for the bundle evidence.
      if (banner) queueHookSystemMessage(String(banner));
      updateCheckDue = isUpdateCheckDue();
    } catch (e) { debugCatch(e, 'session-start-update'); }

    // Queued into the same single envelope a leftover episode receipt may also
    // be contributing to (flushEpisode runs earlier in this very process after
    // /clear or /compact). Written once, at the dispatcher's exit.
    if (stdoutParts.length) queueHookContext('SessionStart', stdoutParts.join('\n\n'));
    if (updateCheckDue) {
      try { spawnBackground('update-check'); } catch (e) { debugCatch(e, 'session-start-update-spawn'); }
    }

    // D#123 (review C-1): persist the Key Context ids ACTUALLY rendered above so
    // handleUserPrompt can exclude exactly those from <memory-context> — and
    // nothing else. Under quiet/adopted the sections don't render, the id list is
    // empty, and prompt-time injection is NOT suppressed (the old query-mirroring
    // exclude-set blanked the same-project leg on adopted projects). Written
    // unconditionally (even when empty) so a resumed session can't act on a
    // previous session's stale marker semantics; 24h GC below.
    // D#124: the same call also bumps injection_count on the rendered rows —
    // Key Context was a shown-but-uncounted surface, so its rows could never
    // reach applyCitationDecay's denominator. One recorder, both writers.
    recordKeyContextInjection(db, {
      runtimeDir: RUNTIME_DIR,
      project,
      sessionId: ccSessionId,
      ids: contextCollector.keyContextIds || [],
    });

    // One-time migration: remove any stale <claude-mem-context> block left in
    // CLAUDE.md by pre-v2.30 installs. Idempotent no-op afterwards.
    cleanupClaudeMdLegacyBlock();

    // v2.70.0 one-shot upgrade banner: notify users on first SessionStart per
    // project that the `### Deferred Work` block now reads from the
    // deferred_work table (was: high-importance observations in v2.69.x).
    // Idempotent via marker file; subsequent SessionStarts are silent.
    try {
      // Gate on prior data OLDER THAN v2.70.0: a brand-new install never had
      // v2.69.x deferred-block semantics, so the migration notice is wrong noise.
      // "Any observations at all" still misfired for someone who installed today
      // and saved a few memories before their first SessionStart — age is what
      // actually identifies an upgrader (see lib/upgrade-banner.mjs).
      const { emitV270UpgradeBanner, hasPreV270Data } = await import('./lib/upgrade-banner.mjs');
      emitV270UpgradeBanner({
        project,
        runtimeDir: RUNTIME_DIR,
        hasPriorData: hasPreV270Data(db, project),
      });
    } catch (e) { debugCatch(e, 'session-start-v270-banner'); }

    // Pre-load TF-IDF vocabulary cache for this session (from DB, ~1ms)
    try { getVocabulary(db); } catch (e) { debugCatch(e, 'session-start-vocab'); }

  } finally {
    db.close();
  }
}

// ─── PreCompact Handler ──────────────────────────────────────────────────────
// Fires immediately before Claude Code auto-compaction begins. Re-emits the
// memory context block on stdout so the summarizer sees it during compaction.
// SessionStart's "compact" matcher fires AFTER compaction — by then the
// previous-turn injection has already been collapsed. Pure read; no DB writes.

async function handlePreCompactDispatch() {
  let hookData = {};
  try {
    const raw = await readStdin();
    hookData = JSON.parse(raw.text);
  } catch { /* stdin unavailable — emit anyway with whatever we can infer */ }

  const db = openDb();
  if (!db) return;
  try {
    await preCompactEntry(db, hookData);
  } finally {
    try { db.close(); } catch {}
  }
}

// ─── UserPromptSubmit Handler ────────────────────────────────────────────────

async function handleUserPrompt() {
  let raw;
  try { raw = await readStdin(); } catch { return; }

  let hookData;
  try { hookData = JSON.parse(raw.text); } catch { return; }

  const rawPrompt = hookData.prompt || hookData.user_prompt;
  if (!rawPrompt || typeof rawPrompt !== 'string') return;

  // Skip internal Claude Code protocol messages — not real user input.
  // Check on raw text BEFORE stripPrivate (the marker is a literal sentinel,
  // wrapping it in <private> would never make sense, but order matters: a
  // future <task-notification> with embedded <private> blocks should still
  // be classified as protocol first.)
  if (rawPrompt.startsWith('<task-notification>')) return;

  // Strip user-marked <private>...</private> blocks at the input boundary so
  // every downstream consumer (user_prompts INSERT, FTS query, continuation
  // detection, semantic-memory injection) sees the redacted text — single
  // source of truth for the privacy primitive.
  // Strip NUL / C0 control chars (keep \t \n \r) before any downstream use: an
  // embedded NUL terminates SQLite's C string, silently truncating the stored
  // prompt_text at the first NUL (and breaking FTS). Single source of truth, so the
  // user_prompts INSERT, FTS query, and continuation detection all see clean text.
  // eslint-disable-next-line no-control-regex -- intentional: NUL/C0 strip prevents SQLite C-string truncation
  const promptText = stripPrivate(rawPrompt).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

  const sessionId = getSessionId();
  const db = openDb();
  if (!db) return;

  const project = inferProject();

  try {
    const now = new Date();

    // Ensure session exists (INSERT OR IGNORE avoids race condition)
    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

    // T4-P2-D: atomic increment+read via UPDATE ... RETURNING (SQLite 3.35+).
    // Previously UPDATE + SELECT as two statements; parallel prompts could read a stale
    // counter and emit duplicate prompt_number values. better-sqlite3 ships a modern SQLite.
    const bumped = db.prepare(
      'UPDATE sdk_sessions SET prompt_counter = COALESCE(prompt_counter, 0) + 1 WHERE content_session_id = ? RETURNING prompt_counter'
    ).get(sessionId);
    const promptNumber = bumped?.prompt_counter || 1;

    // Claude Code's real session_id (CC UUID) from hook stdin. Persisted on the
    // prompt row (cc_session_id) so buildAndSaveHandoff can scope working_on to ONE
    // CC session — getSessionId() is project-scoped (no CC-UUID), so without this
    // concurrent/within-TTL same-project sessions merge each other's prompts (D#26).
    // Also scopes handoff-row injection below. Null (legacy) when stdin lacks session_id.
    const ccSessionId = typeof hookData.session_id === 'string' && hookData.session_id.length > 0
      ? hookData.session_id
      : null;

    db.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, cc_session_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      // Scrub BEFORE the 10k slice: a secret straddling char 10000 would otherwise
      // be cut to a sub-6-char head that scrubSecrets's value-length floor no longer
      // matches, persisting a partial secret into prompt_text (later re-emitted at
      // server.mjs prompt_text + mem-cli recent). Scrubbing full text first is leak-free.
      scrubSecrets(promptText).slice(0, 10000),
      promptNumber,
      ccSessionId,
      now.toISOString(), now.getTime()
    );

    // Cross-session handoff injection (first 3 prompts window, before semantic memory).
    // prompt_counter is project-scoped (shared across concurrent same-project CC sessions), so a
    // parallel session would start past the window and never get its handoff injected. Count THIS
    // cc_session's own prompts instead (the current one is already inserted above); legacy null cc
    // id falls back to the shared counter.
    const windowPos = ccSessionId
      ? (db.prepare('SELECT COUNT(*) c FROM user_prompts WHERE cc_session_id = ?').get(ccSessionId)?.c || promptNumber)
      : promptNumber;
    if (windowPos <= 3) {
      try {
        if (detectContinuationIntent(db, promptText, project, ccSessionId)) {
          const picked = pickHandoffToInject(db, project, ccSessionId);
          if (picked) {
            const injection = renderHandoffInjection(db, project, ccSessionId);
            if (injection) process.stdout.write(injection + '\n');
            // Consume ONLY the row we just injected — leave other projects' exit
            // handoffs intact so future sessions can still resume from them.
            // Pre-v2.46 wiped every exit handoff for the project on any continuation
            // intent, which made the DB effectively forgetful: 115 completed sessions
            // produced 1 persisted handoff.
            try {
              db.prepare(
                'DELETE FROM session_handoffs WHERE project = ? AND type = ? AND session_id = ?'
              ).run(project, picked.type, picked.session_id);
            } catch {}
          }
        }
      } catch (e) { debugCatch(e, 'handleUserPrompt-handoff'); }
    }

    // Semantic memory injection: search past observations for the user's prompt.
    // P0 short-circuit on user-explicit "ignore memory" / "不要用记忆" override
    // (mirrors CC built-in memoryTypes.ts:215). Skip both Key Context lookup
    // and the <memory-context> emission for this turn.
    if (!detectMemOverride(promptText)) try {
      // D#123 (review C-1): the exclude-set is the Key Context ids ACTUALLY
      // rendered at SessionStart — read from the marker handleSessionStart wrote,
      // not re-derived from a query. The old query-mirroring set excluded rows
      // that were never shown (quiet/adopted projects render no Key Context at
      // all), blanking the same-project <memory-context> leg outright. Missing
      // or other-session marker → empty set: unknown injections must fail open
      // (inject, maybe duplicate) rather than fail closed (suppress).
      const keyContextIds = [];
      try {
        const raw = readFileSync(join(RUNTIME_DIR, keyContextIdsFileName(project, ccSessionId)), 'utf8');
        const { ids, session } = JSON.parse(raw);
        if (Array.isArray(ids) && !(session && ccSessionId && session !== ccSessionId)) {
          keyContextIds.push(...ids);
        }
        // The marker's validity is session-lifetime but gcStalePreRecallCooldowns sweeps it
        // by AGE. Stamping it on read makes that sweep mean "24h with no prompt in this
        // session" instead of "24h since the render" — otherwise a session running past a
        // day loses its own exclude-set and re-injects what Key Context is still showing.
        touchKeyContextMarker({ runtimeDir: RUNTIME_DIR, project, sessionId: ccSessionId });
      } catch { /* no marker — nothing was injected, exclude nothing */ }
      const pathAInjectedIds = [];

      // Read IDs already injected by user-prompt-search.js to avoid duplicate injection
      try {
        // D#120: the marker file is session-keyed (no ccSessionId → legacy
        // project-keyed name), so a concurrent session's write can no longer
        // replace this session's payload between the UPS write and this read.
        const injectedFile = join(RUNTIME_DIR, injectedIdsFileName(project, ccSessionId));
        // The freshness + same-session gate is lib/injected-ids.mjs's (audit 2026-09-02
        // P1-2); this was the third hand-typed copy of it. THE 10 s WINDOW STAYS HERE and
        // is passed in: the two writers gate on DEDUP_STALE_MS (5 min) and this reader on
        // 10 s ("same prompt cycle"), and that disagreement is a real open question
        // (P1-2's second half — the 10 s window still accepts the PREVIOUS prompt's
        // marker), not a copy-paste slip to be normalised away by the consolidation.
        // Legacy payloads without `session` keep the old time-window-only behaviour.
        const { ids, fresh } = readInjectedMarker(injectedFile,
          { sessionId: ccSessionId, maxAgeMs: 10000 });
        if (fresh) {
          // D#193, DELIBERATELY NOT NUMERICALISED — read this before "fixing" it.
          //
          // Ids arrive here as written. `user-prompt-search.js` writes plain numbers, but
          // `mergeCrossHookInjected` (pre-tool-recall.js) `.map(String)`s the whole union,
          // so once PreToolUse has emitted one row in the window every id is a STRING.
          // Both consumers below test `new Set(excludeIds).has(r.id)` against a NUMBER out
          // of SQLite, so from that moment the exclude suppresses nothing.
          //
          // Coercing with Number() here would make it work — and that is a real behaviour
          // change, not a type repair, which is why it is not done as a drive-by.
          //
          // GET THE SIDE RIGHT. The marker is WRITTEN by `user-prompt-search.js` (the
          // `fyi` face) and `pre-tool-recall.js` (`pretool`); it is READ here, in
          // handleUserPrompt, which is the `ups` face. So the gated population is
          // `ups ∩ (fyi ∪ pretool)`. A first version of this note measured the mirror
          // image — `fyi ∩ (pretool ∪ ups)` — and published 18.0%, the number for a
          // mechanism that is not this one. The pre-tag review caught it.
          //
          // Measured 2026-09-02T12:12Z over 99 transcripts, one walk, as an UPPER bound
          // (session-level, ignoring the marker's stale window): a working exclude would
          // drop at most 23 of 256 `ups` (session, id) pairs — 9.0% — across 14 of 71
          // sessions, and 3 of 24 on task_imperative (12.5%). By attachments rather than
          // pairs it is 29 of 332 (8.7%).
          //
          // Still not repaired at 9.0%, and the corrected number strengthens the case
          // rather than weakening it: this path ALREADY has a working suppressor.
          // `shouldSkipByDedup` (prompt-search-utils.mjs) String-normalises both sides, so
          // it functions, and it skips the whole injection at >=0.8 overlap. Turning this
          // one on adds a second, finer-grained suppressor on a face that is already
          // suppressed, with the direction unknown — the freed slot is sometimes refilled
          // from the pool and sometimes just lost (`rerank-pool-replay`: 6587 of 11289
          // prompts already inject nothing) and the `ups` cite-rate is 8.1%.
          //
          // The ruler that settles it is now BUILT and sits at the bottom of this same
          // function: `lib/patha-exclude-meter.mjs`, off unless CLAUDE_MEM_METRICS=1. It
          // does not persist the marker for an offline replay — reconstructing per-prompt
          // exclude sets that way needs a file that rotates after DEDUP_STALE_MS, and the
          // replay would then run against a drifted database. Both arms run at this read
          // instead. What is still missing is elapsed time, not a method. D#213.
          // tests/pathA-exclude-inert.test.mjs pins this state so a silent flip goes red.
          for (const id of ids) { keyContextIds.push(id); pathAInjectedIds.push(id); }
        }
      } catch { /* file may not exist — that's fine */ }

      // Phase-2 task-imperative (EXPERIMENTAL, default OFF — CLAUDE_MEM_TASK_IMPERATIVE):
      // the single highest-value lesson relevant to THIS prompt, delivered at the prompt
      // position under an imperative template. Excluded from the <memory-context> list so it
      // is never injected twice. Channel-isolation measure (efficacy arm U, 2026-06-29):
      // task-prompt 6-8/8 vs PreToolUse hook 0/8.
      //
      // The default flip is ABANDONED (D#137, 2026-08-16). rankImperativeCandidates requires
      // identifier overlap between the prompt and the lesson body/title, and over the last 400
      // real prompts that gate opened 76 times = 19.0% (CJK prompts 57/352 = 16.2%, ASCII
      // 19/48 = 39.6%). With 88% of prompts on this install in Chinese, the emitter fires
      // roughly once every six prompts — the canary can never accumulate n, because the
      // ceiling is the gate's DESIGN (precision-first symbol anchoring), not a defect.
      // Reviving the flip needs a CJK-viable anchor proven in A/B without a precision loss;
      // until then this stays experimental and off.
      const taskImperativeOn = process.env.CLAUDE_MEM_TASK_IMPERATIVE === 'on'
        || process.env.CLAUDE_MEM_TASK_IMPERATIVE === '1';
      // ── D#214 arm B (counterfactual), computed BEFORE the delivered arm ─────────
      // Ordering is the whole correctness argument, so it is stated where the order is:
      // arm A's search legitimately bumps `injection_count` on every row it delivers,
      // and that column feeds `noisePenaltyClause`. Running the counterfactual AFTER it
      // — as the first version did — lets arm A push a row across the >=4 noise gate and
      // then attributes the resulting difference to the repair. The pre-tag review
      // reproduced that: a marker id for a row the query never matches, where the honest
      // answer is `suppressed 0 / refilled 0`, reported `refilled: 1, setChanged: true`.
      //
      // So arm B runs first, on the same handle, with `counterfactual: true` — it writes
      // nothing and emits no `inject` metric row, so arm A afterwards sees exactly the
      // state arm B saw. Both arms, one state, and neither one perturbs the other.
      //
      // Arm B also carries its OWN imperative pick. Reusing arm A's put a pick the
      // repaired system would not have made into arm B's exclude, so on any prompt where
      // the pick changed, the delta described a system that does not exist.
      // Lazy on "the marker carried ids", NOT on the metrics env. Gating the import on
      // `CLAUDE_MEM_METRICS === '1'` would read cheaper still, and would put a second copy
      // of `pathAMeterEnabled`'s own predicate here — the twin shape this meter's tests
      // exist to pin. `pathAMeterEnabled()` stays the only place that predicate lives; the
      // module still stops loading on every OTHER event, which is what P1-8 is about.
      let pathAMeterEnabled, coerceMarkerIds, recordPathAExclude;
      if (pathAInjectedIds.length > 0) {
        ({ pathAMeterEnabled, coerceMarkerIds, recordPathAExclude } = await import('./lib/patha-exclude-meter.mjs'));
      }
      const meterCoerced = (pathAMeterEnabled && pathAMeterEnabled())
        ? [...coerceMarkerIds(pathAInjectedIds)]
        : null;
      let meterArmB = null;
      if (meterCoerced) {
        try {
          const pickB = taskImperativeOn
            ? selectImperativeLesson(db, promptText, project, [...pathAInjectedIds, ...meterCoerced])
            : null;
          const excludeB = pickB ? [...keyContextIds, pickB.id] : keyContextIds;
          meterArmB = {
            rows: searchRelevantMemories(db, promptText, project, [...excludeB, ...meterCoerced], { counterfactual: true }),
            pick: pickB ? pickB.id : null,
          };
        } catch (e) {
          debugCatch(e, 'patha-exclude-meter-armB');
          meterArmB = { error: String(e?.message || 'unknown') };
        }
      }

      // Exclude only ids path-A (user-prompt-search.js) already injected — NOT the
      // SessionStart Key Context set, which overlaps the high-value lesson pool and
      // would suppress the pick. The chosen id is excluded from the <memory-context>
      // block below instead.
      const imperativePick = taskImperativeOn
        ? selectImperativeLesson(db, promptText, project, pathAInjectedIds)
        : null;
      const contextExclude = imperativePick ? [...keyContextIds, imperativePick.id] : keyContextIds;

      const memories = searchRelevantMemories(db, promptText, project, contextExclude);
      if (memories.length > 0) {
        const lines = ['<memory-context relevance="high">'];
        for (const m of memories) lines.push(formatMemoryLine(m));
        lines.push('</memory-context>');
        process.stdout.write(lines.join('\n') + '\n');
      }
      // HIGH-1 (full audit 2026-07-16): surface FTS-matched events — the canonical
      // store for promoted bugfix/decision/lesson memories that persistHaikuSummary
      // upgrade-deletes out of observations. Without this leg they are unreachable at
      // prompt time. Separate E#-tagged block so it doesn't perturb observation
      // ranking and citation extractors (bare-`#` anchored) never read an event id as
      // an obs id. Nested try so an events failure can't suppress the imperative pick.
      try {
        // upsFtsQuery, not the raw prompt (audit ALGO-1). lib/ups-query.mjs declares
        // itself "the ONE query-cap definition for the UserPromptSubmit event", and both
        // OTHER legs of this same event go through it — but this leg, wired in v3.48
        // before that module existed, handed searchInjectableEvents the whole prompt and
        // let it call the uncapped sanitizeFtsQuery. Measured here: a 250KB CJK prompt
        // (path B's stdin cap is 256KB) costs 356ms uncapped against 5.5ms capped, all of
        // it synchronous, before the model sees the turn.
        const events = searchInjectableEvents(db, { ftsQuery: upsFtsQuery(promptText), project });
        if (events.length > 0) {
          const elines = ['<memory-context relevance="events">'];
          for (const e of events) elines.push(`- ${renderInjectableEvent(e)}`);
          elines.push('</memory-context>');
          process.stdout.write(elines.join('\n') + '\n');
        }
      } catch (e) { debugCatch(e, 'handleUserPrompt-events'); }
      if (imperativePick) {
        // Guard the write on a non-empty return — formatTaskImperative yields '' for a
        // lesson that strips to empty (e.g. "."), which would otherwise emit a bare line.
        const imperativeLine = formatTaskImperative(imperativePick.lesson_learned, imperativePick.id);
        if (imperativeLine) process.stdout.write(imperativeLine + '\n');
      }

      // D#214's ruler, second half: arm B was computed above, before anything was
      // delivered; this only shapes the row and appends it. Kept after every
      // `process.stdout.write` so the metric append is never in front of the injection,
      // and so a throw here cannot corrupt what was already emitted.
      //
      // `meterCoerced` being non-null is the gate — it is null unless
      // CLAUDE_MEM_METRICS=1 AND the marker carried ids, which is what keeps both the
      // counterfactual search and the second lesson selection off a stock install.
      try {
        if (meterCoerced) {
          recordPathAExclude(join(RUNTIME_DIR, '..'), {
            markerIds: pathAInjectedIds,
            emitted: memories,
            after: meterArmB,
            imperativeArm: taskImperativeOn ? 'on' : 'off',
            imperativeBefore: imperativePick ? imperativePick.id : null,
            imperativeAfter: meterArmB ? (meterArmB.pick ?? null) : null,
          });
        }
      } catch (e) { debugCatch(e, 'patha-exclude-meter'); }
    } catch (e) { debugCatch(e, 'handleUserPrompt-memory'); }
  } finally {
    db.close();
  }
}

// ─── Save-Enrich (Background Worker, G1+G2) ─────────────────────────────────

/**
 * Detached worker spawned by the save surfaces (lib/save-enrich.mjs
 * queueSaveEnrich): one Haiku call backfills lesson (obligated types) +
 * search_aliases, fill-only-empty. Silent on any failure.
 */
async function handleEnrichSave(rawId) {
  const id = parseInt(rawId, 10);
  if (!Number.isInteger(id) || id <= 0) return;
  const db = openDb();
  if (!db) return;
  try {
    const { executeSaveEnrich } = await import('./lib/save-enrich.mjs');
    const result = await executeSaveEnrich(db, id);
    // G13: the worker's outcome was previously discarded — "spawned but did it
    // work" was invisible (32% alias coverage with 3 indistinguishable failure
    // causes). reason 'filled-concurrently' = txn ran but a concurrent optimize/
    // update had already filled every empty field.
    recordMetric(join(RUNTIME_DIR, '..'), {
      event: 'enrich_save',
      id,
      enriched: result.enriched,
      reason: result.reason ?? (result.enriched ? 'enriched' : 'filled-concurrently'),
    });
  } catch (e) {
    recordMetric(join(RUNTIME_DIR, '..'), { event: 'enrich_save', id, enriched: false, reason: 'worker-error' });
    debugCatch(e, 'enrich-save');
  } finally {
    try { db.close(); } catch {}
  }
}

// ─── Auto-Compress (Background Worker) ───────────────────────────────────────

/**
 * Background worker: group old low-value observations into weekly summaries.
 * Spawned by SessionStart daily after the fast purge DELETE.
 * Iterates 60-day-old observations, groups by project+week, creates summary per group.
 */
function handleAutoCompress() {
  const db = openDb();
  if (!db) return;

  try {
    const compressCutoff = Date.now() - 60 * DAY_MS; // 60 days
    const compressCandidates = selectCompressionCandidates(db, { cutoff: compressCutoff, includeAutoMarked: true });
    if (compressCandidates.length < 3) return;

    const groups = groupByProjectWeek(compressCandidates);
    // Transact each group to prevent orphan summaries on crash (CLI/MCP wrap all groups in one).
    const compressGroupTxn = db.transaction((proj, obs) => compressGroup(db, proj, obs).compressed);
    let totalCompressed = 0;
    for (const [key, obs] of groups) {
      const [proj] = key.split('::');
      totalCompressed += compressGroupTxn(proj, obs);
    }
    if (totalCompressed > 0) {
      debugLog('DEBUG', 'auto-compress', `auto-compressed ${totalCompressed} observations into weekly summaries`);
    }
  } catch (e) {
    debugCatch(e, 'auto-compress');
  } finally {
    db.close();
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

// P1-9: the mechanism is shared (lib/hook-stdin.mjs); the CALIBER stays this entry point's
// own. 256 KB because a tool response is the largest payload the host sends here, and
// `rejectOnTimeout` because this reader's callers treat a timeout as "drop the event" — the
// alternative, acting on a partial payload, means writing a truncated tool response into
// memory as if it were the whole thing. The other four hook processes are advisory and
// resolve instead; those are different decisions about different payloads, not drift.
function readStdin() {
  return readHookStdin({
    timeoutMs: 3000,
    maxBytes: MAX_HOOK_STDIN_BYTES, // shared tier, utils.mjs
    rejectOnTimeout: true,
  }).catch((err) => {
    if (err?.message === 'timeout') debugLog('WARN', 'readStdin', 'stdin timeout after 3s — event dropped');
    throw err;
  });
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// Strip ANSI escape codes and extract readable text from tool responses.
// Bash responses come as {stdout, stderr} objects or JSON strings — extract the text content
// instead of producing noisy `{"stdout":"\u001b[1m..."}` in episode descriptions.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;
function extractStdio(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const { stdout, stderr } = obj;
  if (typeof stdout === 'string' || typeof stderr === 'string') {
    const parts = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(stderr);
    return parts.join('\n');
  }
  return null;
}
function normalizeToolResponse(toolResponse) {
  if (typeof toolResponse === 'string') {
    // Try to parse JSON strings like '{"stdout":"...","stderr":"..."}'
    if (toolResponse.startsWith('{"stdout"') || toolResponse.startsWith('{"stderr"')) {
      try {
        const parsed = JSON.parse(toolResponse);
        const extracted = extractStdio(parsed);
        if (extracted) return extracted.replace(ANSI_RE, '');
      } catch {}
    }
    return toolResponse.replace(ANSI_RE, '');
  }
  if (toolResponse && typeof toolResponse === 'object') {
    const extracted = extractStdio(toolResponse);
    if (extracted) return extracted.replace(ANSI_RE, '');
    return JSON.stringify(toolResponse).replace(ANSI_RE, '');
  }
  return '';
}

// ─── Main ───────────────────────────────────────────────────────────────────

try {
  switch (event) {
    case 'post-tool-use':    await handlePostToolUse(); break;
    // Host-flagged tool failures arrive on their own event; PostToolUse never sees them.
    case 'post-tool-failure': await handlePostToolFailure(); break;
    case 'session-start':    await handleSessionStart(); break;
    case 'pre-compact':      await handlePreCompactDispatch(); break;
    case 'stop':             await handleStop(); break;
    case 'user-prompt':      await handleUserPrompt(); break;
    case 'llm-episode':      await handleLLMEpisode(); break;
    case 'llm-summary':      await handleLLMSummary(); break;
    case 'auto-compress':    handleAutoCompress(); break;
    case 'enrich-save':      await handleEnrichSave(process.argv[3]); break;
    case 'auto-maintain':    handleAutoMaintain(process.argv[3]); break;
    case 'llm-optimize':   { const { handleLLMOptimize } = await import('./hook-optimize.mjs'); await handleLLMOptimize(); break; }
    // Detached update refresh spawned by handleSessionStart (audit P3d) — does the
    // GitHub fetch off the SessionStart critical path, writing update-state.json so
    // the NEXT session's cached banner is fresh.
    //
    // F6 staging: the detached update-check worker has not run since v2.85.0
    // (missing from BG_EVENTS). Restore the check + banner first; re-enable the
    // self-replacing install in a follow-up once this path has proven itself, so a
    // failure in either half is attributable. Without the option, hook-update.mjs's
    // `allowInstall = options.allowInstall ?? !pluginMode` defaults to TRUE on a
    // direct / settings.json install, so fixing F6 would switch a ten-week-dormant
    // self-installer back on in the same release that resurrects the worker. The
    // module default and the installer's own guards are unchanged — install.mjs
    // still passes allowInstall:true for the explicit, user-invoked update.
    case 'update-check':     { const { checkForUpdate } = await import('./hook-update.mjs'); await checkForUpdate({ allowInstall: false }); break; }
  }
} catch (err) {
  // Log fatal errors (ungated) with structured format. ERR_DLOPEN_FAILED (an
  // unloadable native DB binding, e.g. ABI-stale after a Node upgrade) is
  // collapsed to one short, rate-limited rebuild hint instead of the raw
  // multi-line NODE_MODULE_VERSION message on every fire — see
  // lib/native-binding-hint.mjs.
  const line = formatHookError(err, event, { runtimeDir: RUNTIME_DIR });
  if (line) console.error(line);
  // stderr alone is invisible to `stats` self-observation — only the native-binding
  // family was persisted, so a non-binding fatal (schema drift, bad stdin shape)
  // could kill every dispatch-routed surface while the hook-errors log read zero
  // (audit 2026-08-14 M-5; same blindness one layer up from the v3.60 outage).
  recordHookError(`hook:${event}`, err, RUNTIME_DIR);
}

// Single stdout write for the whole process (lib/hook-stdout.mjs). Runs after the
// catch too: a handler that queued a receipt and then threw should still deliver
// what it had, and Claude Code only ever reads one JSON document from here.
try { flushHookStdout(); } catch { /* a receipt must never change the exit code */ }

process.exit(0);
