#!/usr/bin/env node
// claude-mem-lite CLI — lightweight command layer for direct memory access
// No MCP SDK or heavy deps — only imports schema.mjs and utils.mjs

import { homedir } from 'os';
import { ensureDbWithWalRecovery, DB_PATH, DB_DIR } from './schema.mjs';
import { resolveRuntimeDir } from './lib/resolve-data-dir.mjs';
import { truncate, typeIcon, inferProject, scrubSecrets, COMPRESSED_PENDING_PURGE } from './utils.mjs';
import { resolveProject } from './project-utils.mjs';
// READ commands resolve the project DB-aware: a subdirectory whose own name holds no rows
// falls back to the enclosing work-tree root, so `cd src/auth && … recent` reads what the
// session's hooks wrote. WRITE commands (save / defer add / restore / import-jsonl) keep
// plain inferProject() — pre-tag review reproduced the reason: for a read, "cwd holds
// nothing" means there is nothing to lose, but for a write it is the normal precondition of
// a project about to be born, and absorbing it into the enclosing repo strands the row once
// the session's hooks start writing the subdirectory's own name. Hook-side is untouched.
import { resolveCliProject as cliProject } from './lib/cli-project.mjs';
import { _resetVocabCache, vecTextForRow, vectorsEnabled } from './tfidf.mjs';
import { reRankWithContext } from './search-scoring.mjs';
import { searchObservationsHybrid } from './search-engine.mjs';
import {
  fetchObsDetail,
  fetchPromptDetail,
  fetchEventDetail,
  fetchSessionDetail,
  OBS_FIELDS,
  SESSION_DETAIL_FIELDS,
  PROMPT_DETAIL_FIELDS,
  EVENT_DETAIL_FIELDS,
  supersededNotice,
} from './lib/get-core.mjs';
import {
  collectBrowseTiers,
  getActiveMemorySessionId,
  BROWSE_TIERS,
  BROWSE_TIER_LABELS,
} from './lib/browse-core.mjs';
import { deepSearch, resolveDeepMode, shouldEscalateToDeep, autoDeepLlmReady } from './deep-search.mjs';
import { selectCompressionCandidates, groupByProjectWeek, compressGroup } from './lib/compress-core.mjs';
import {
  runMaintainOps,
  findDuplicates,
  maintenanceStats,
  OP_CAP,
  STALE_AGE_MS,
  PINNED_INJ_THRESHOLD,
  resolveDefaultMaintainOps,
  ALL_MAINTAIN_OPS,
} from './lib/maintain-core.mjs';
// snapshotDb left with maintain-core: the pre-maintain snapshot is part of the op ORDER
// (it must see the pre-existing pending rows), so it moved into runMaintainOps (P1-5).
import { listSnapshots, backupBudgetBytes } from './lib/db-backup.mjs';
import { deleteObservations, previewDeleteRows } from './lib/delete-core.mjs';
import { OBS_TYPE_SET } from './lib/obs-types.mjs';
import { computeStatsFeed } from './lib/stats-core.mjs';
import { buildLessonNudge } from './lib/save-nudge.mjs';
import { optimizePreview, optimizeRun } from './hook-optimize.mjs';
import { buildSessionContextLines } from './hook-context.mjs';
import { cmdAdopt, cmdUnadopt } from './adopt-cli.mjs';
import { parseIntFlag, isNumericToken } from './lib/cli-flags.mjs';
import { liveObsFilterSql } from './lib/inject-search-core.mjs';
import { auditMemdir, memdirPath } from './memdir.mjs';
import { aggregateProjectCiteRecall } from './lib/citation-tracker.mjs';
import {
  probeOtherSources as probeIdSources,
  bucketIdTokens,
  splitDeferredTokens,
} from './lib/id-routing.mjs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';

// v2.41: shared CLI helpers extracted to cli/common.mjs. Keep this file as the
// router + remaining-command bodies during the incremental split. Future work:
// move each cmdXxx into its own cli/<cmd>.mjs; mem-cli.mjs becomes pure dispatch.
import { isNativeBindingError, healAndReexec } from './lib/binding-probe.mjs';
import { CLI_PATH, CLI_INVOKE } from './cli-path.mjs';
import {
  parseArgs,
  out,
  outVerbatim,
  fail,
  relativeTime,
  fmtDateShort,
  parseIdToken,
  formatProbeHints,
  rejectBareStringFlags,
  resolvePositionalAlias,
  suggestUnknownFlags,
  OBS_TIME_FIELDS,
  formatObsFieldValue,
  obsFieldLabel,
  formatPendingPurgeLine,
} from './cli/common.mjs';
import {
  saveObservation,
  saveWithClosures,
  formatSupersedeSkipped,
  formatSupersededNote,
} from './lib/save-observation.mjs';
import { normalizeScope, insertObservationVector, applyObsUpdate } from './lib/observation-write.mjs';
import { EXPORT_COLUMNS_SQL, buildExportWhere } from './lib/export-columns.mjs';
import { recallByFile, countRecallableByFile } from './lib/recall-core.mjs';
import { fetchRecent, RECENT_MAX } from './lib/recent-core.mjs';
import {
  resolveAnchorToken,
  formatAnchorError,
  resolveQueryAnchor,
  fetchRecentTimeline,
  fetchTimelineWindow,
} from './lib/timeline-core.mjs';
import {
  buildSearchFtsQuery,
  parseDateBounds,
  parseDuration,
  coreRunSearchPipeline,
} from './lib/search-core.mjs';
import { AUTO_MERGE_THRESHOLD } from './lib/dedup-constants.mjs';
import { countRecentHookErrors } from './lib/hook-telemetry.mjs';
import {
  computeCitationFunnelTrend,
  computeSurfaceFunnel,
  DECAY_DENOMINATOR_SURFACES,
} from './lib/citation-tracker.mjs';

// Human labels for citation_surface_log.surface. Padded to a common width so
// the citation-stats face table lines up; the enum itself lives in
// lib/citation-tracker.mjs (CITATION_SURFACES).
const SURFACE_LABELS = {
  pretool: 'PreToolUse recall  ',
  ups: 'UserPromptSubmit   ',
  error_recall: 'error-recall       ',
  fyi: 'FYI (prompt-search)',
  task_imperative: 'task-imperative    ',
  keyctx: 'Key Context        ',
  subagent: 'subagent (dispatch)',
};
import { aggregateMetrics, readMetrics } from './lib/metrics.mjs';
import {
  insertDeferred,
  listOpenWithOrdinal,
  dropDeferred,
  formatDropReasonHint,
  resolveDeferredIds,
  getDeferredByIds,
  formatDeferredDetail,
  searchDeferredWork,
  formatDeferredSearchTrailer,
  formatDeferListRow,
  countStaleOpen,
  formatDeferStaleHint,
} from './lib/deferred-work.mjs';
import { shouldQueueSaveEnrich, queueSaveEnrich } from './lib/save-enrich.mjs';

// ─── Commands ────────────────────────────────────────────────────────────────

// A path query is not a text query, and `search` cannot tell the user so.
//
// OBS_FTS_COLUMNS (scoring-sql.mjs) indexes title/narrative/lesson/aliases/concepts — it
// does NOT index `files`. File association lives in the observation_files junction, which
// is `recall`'s table and only `recall`'s. So a save that named `src/payments/webhook.ts`
// in --files and never mentioned it in prose is reachable by `recall` and unreachable by
// `search`, and the user typing the path they were just editing gets a flat
// "No results" — a true statement about the FTS index that reads as a false one about the
// store. This is the one zero-result shape the CLI can positively disprove, so it does,
// with the exact command that answers it.
//
// Cheap and quiet: one COUNT, only on a zero-result query that is a single whitespace-free
// token shaped like a path or filename, and silent when that count is 0 (the ordinary case
// — an ordinary prose query never reaches the COUNT at all). countRecallableByFile does
// not bump access counters, so offering the hint cannot inflate the engagement signal of
// rows the user has not read.
function emitRecallHint(db, query) {
  const q = String(query || '').trim();
  if (!q || /\s/.test(q)) return;
  if (!(q.includes('/') || q.includes('\\') || /\.[A-Za-z0-9]{1,8}$/.test(q))) return;
  try {
    const n = countRecallableByFile(db, q);
    if (n > 0) {
      out(`[mem] ${n} observation(s) are linked to that file — search indexes text, not file paths.`);
      out(`[mem] Try: claude-mem-lite recall "${q}"`);
    }
  } catch {
    /* hint is best-effort; never break search */
  }
}

async function cmdSearch(db, args, { llm } = {}) {
  const { positional, flags } = parseArgs(args);

  // Bare string flags parse to boolean `true`; without this guard `--branch` reaches
  // the SQLite bind and crashes, while `--to`/`--project` silently change results
  // (epoch-1 upper bound → zero rows; unscoped search). (audit P1 #3)
  if (rejectBareStringFlags(flags, ['query', 'source', 'project', 'from', 'to', 'branch'])) return;

  const query = resolvePositionalAlias(positional.join(' '), flags, ['query']);
  if (query === null) return;
  if (!query) {
    fail(
      '[mem] Usage: claude-mem-lite search <query> [--type TYPE] [--source SOURCE] [--limit N] [--project P] [--from DATE] [--to DATE] [--since DUR] [--importance N] [--branch B] [--offset N] [--sort relevance|time|importance] [--include-noise] [--deep] [--no-deep] [--rerank] — query may also be passed via --query "<query>"',
    );
    return;
  }

  const limit = parseIntFlag(flags.limit, { name: '--limit', defaultValue: 20, max: 1000 });
  const type = flags.type || null;
  const validObsTypes = OBS_TYPE_SET;
  if (type && !validObsTypes.has(type)) {
    fail(`[mem] Invalid --type "${type}". Valid: ${[...validObsTypes].join(', ')}`);
    return;
  }
  const source = flags.source || null; // observations|sessions|prompts|events (null = all)
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const bounds = parseDateBounds(flags.from, flags.to, flags.since);
  if (!bounds.ok) {
    if (bounds.bad === 'since')
      fail(`[mem] Invalid --since "${bounds.value}". Use <N><unit>, e.g. 7d, 24h, 90m, 2w.`);
    else fail(`[mem] Invalid --${bounds.bad} date: "${bounds.value}". Use YYYY-MM-DD or ISO 8601.`);
    return;
  }
  const { epochFrom: dateFrom, epochTo: dateTo } = bounds;
  // Inverted range silently returns 0 rows; warn so users see the cause, don't error
  // (a deliberate "search for nothing in this window" is not malformed input).
  if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) {
    process.stderr.write(
      `[mem] Note: --from "${flags.from}" is after --to "${flags.to}"; this range is empty\n`,
    );
  }
  const minImportance = flags.importance !== undefined ? parseInt(flags.importance, 10) : null;
  // isNumericToken first: "2abc"→2 / "1e2"→1 would pass the range check and silently
  // filter at a value the user never typed. Reject garbage like out-of-range does.
  if (
    minImportance !== null &&
    (!isNumericToken(flags.importance) || isNaN(minImportance) || minImportance < 1 || minImportance > 3)
  ) {
    fail(`[mem] Invalid --importance "${flags.importance}". Must be 1, 2, or 3.`);
    return;
  }
  const branch = flags.branch || null;
  // parseIntFlag (min=0) rejects garbage ("2abc"→2, "1e2"→1) the old isInteger check let
  // through, warns once, and falls back to 0 — same WARN-style contract, now garbage-proof.
  const offset = parseIntFlag(flags.offset, { name: '--offset', defaultValue: 0, min: 0 });
  const tier = flags.tier || null;
  if (tier && !['working', 'active', 'archive'].includes(tier)) {
    fail(`[mem] Invalid --tier "${tier}". Use: working, active, archive`);
    return;
  }
  const sort = flags.sort || 'relevance';
  if (!['relevance', 'time', 'importance'].includes(sort)) {
    fail(`[mem] Invalid --sort "${sort}". Use: relevance, time, importance`);
    return;
  }
  const useOr = flags.or === true || flags.or === 'true';
  // R-1: opt-in flag to surface hook-llm fallback titles ("Modified X", "Worked on X", raw
  // error logs, etc.) which are otherwise filtered from default search. Use for auditing or
  // when explicitly searching for a file/command that produced a degraded title.
  const includeNoise = flags['include-noise'] === true || flags['include-noise'] === 'true';
  const jsonOutput = flags.json === true || flags.json === 'true';
  // --deep: opt-in LLM multi-query / HyDE deep search (deep-search.mjs). Costs one
  // Haiku call + N hybrid searches; observations-only. NOT the passive path — this
  // is the explicit "search harder" lever for vocabulary-mismatch recall misses.
  // --deep forces deep; --no-deep forces normal; neither = unset (env/default decide).
  const explicitDeep =
    flags.deep === true || flags.deep === 'true'
      ? true
      : flags['no-deep'] === true || flags['no-deep'] === 'true'
        ? false
        : undefined;
  const deepMode = resolveDeepMode(explicitDeep, { surface: 'cli' });

  // --rerank: opt-in LLM rerank of the fused top-20 (option C, deep-search.mjs).
  // One extra Haiku call (~1.4s); only meaningful on the explicit --deep path,
  // never on auto-escalation. Same rerank core the LongMemEval benchmark measures.
  const rerankFlag = flags.rerank === true || flags.rerank === 'true';
  const rerank = rerankFlag && deepMode === 'deep';
  if (rerankFlag && deepMode !== 'deep') {
    process.stderr.write(
      '[mem] Note: --rerank requires --deep (it reranks deep-search candidates); ignored\n',
    );
  }

  if (source && !['observations', 'sessions', 'prompts', 'events'].includes(source)) {
    fail(`[mem] Invalid --source "${source}". Use: observations, sessions, prompts, events`);
    return;
  }

  // P2: deferred trailer — open deferred items matching the query, appended
  // after (and never counted in) the main results. Unfiltered first-page text
  // searches only; --json keeps its documented shape (deliberate asymmetry,
  // locked by tests). Defined before the sanitize-empty early-return so a pure
  // "D#92" query (which sanitizes to no FTS terms) still reaches the item.
  const wantDeferredTrailer =
    !jsonOutput && !source && !type && !branch && !tier && !minImportance && offset === 0;
  const emitDeferredTrailer = () => {
    if (!wantDeferredTrailer) return;
    try {
      const rows = searchDeferredWork(db, query, project || cliProject(db));
      for (const line of formatDeferredSearchTrailer(rows, 'claude-mem-lite get D#<id>')) out(line);
    } catch {
      /* trailer is best-effort; never break search */
    }
  };

  const ftsQuery = buildSearchFtsQuery(query, { or: useOr });
  // --deep proceeds even when the literal query sanitizes to nothing — its LLM
  // rewrite may still produce searchable variants (F3, parity with server.mjs).
  if (!ftsQuery && deepMode === 'normal') {
    // A query that sanitizes to an empty FTS expression (only operators/punctuation/
    // sub-min-length tokens) is a zero-result search, not a malformed one. In --json
    // mode emit the same empty envelope as the no-match path below so programmatic
    // consumers always get parseable stdout (the human path keeps the stderr hint).
    if (jsonOutput) {
      out(JSON.stringify({ query, total: 0, returned: 0, offset, limit, deep: false, results: [] }));
    } else {
      emitDeferredTrailer();
      fail(`[mem] No valid search terms in "${query}"`);
    }
    return;
  }
  // --deep ignores --or: each variant runs AND + the engine's built-in
  // OR-fallback, so --or has no effect on the deep path — say so (F8).
  if (deepMode === 'deep' && useOr) {
    process.stderr.write(
      '[mem] Note: --or has no effect with --deep (variants use AND + engine OR-fallback)\n',
    );
  }

  // Warn if obs-only filters used with non-observation source
  if (source && source !== 'observations' && (type || tier || minImportance || branch)) {
    const ignored = [
      type && '--type',
      tier && '--tier',
      minImportance && '--importance',
      branch && '--branch',
    ].filter(Boolean);
    process.stderr.write(
      `[mem] Note: ${ignored.join(', ')} only apply to observations, ignored for --source ${source}\n`,
    );
  }

  // When --type/--tier/--importance/--branch (obs-only fields) is specified, implicitly restrict to observations.
  // --branch was previously cross-source: sessions/prompts have no branch column, so a query like
  // `search "cache" --branch main` would include unrelated session/prompt rows, surprising users
  // who passed --branch expecting a branch-scoped result.
  // --deep is observations-only (deepSearch fuses searchObservationsHybrid lists);
  // it overrides --source and the obs-only filter inference.
  if (deepMode === 'deep' && source && source !== 'observations') {
    process.stderr.write(`[mem] Note: --deep searches observations only; ignoring --source ${source}\n`);
  }
  // branch/tier are obs-exclusive columns → force observations. --type (obs_type) maps to both
  // observations.type AND events.event_type, so scope to obs+events and skip the type-less
  // sessions/prompts legs (D#76). --importance rides the obsTypeScoped path (events carry importance).
  let effectiveSource;
  let obsTypeScoped = false;
  if (deepMode === 'deep') {
    effectiveSource = 'observations';
  } else if (source) {
    effectiveSource = source;
  } else if (type && !branch && !tier) {
    effectiveSource = null;
    obsTypeScoped = true;
  } else if (minImportance || branch || tier) {
    effectiveSource = 'observations';
  } else {
    effectiveSource = null;
  }

  const res = await coreRunSearchPipeline(
    {
      db,
      currentProject: project ? null : cliProject(db),
      env: process.env,
      searchObservationsHybrid,
      deepSearch,
      shouldEscalateToDeep,
      autoDeepLlmReady,
      reRankWithContext,
      llm,
    },
    {
      query,
      ftsQuery,
      effectiveSource,
      deepMode,
      rerank,
      limit,
      offset,
      project: project || null,
      obsType: type,
      importance: minImportance,
      branch,
      includeNoise,
      epochFrom: dateFrom,
      epochTo: dateTo,
      sort,
      tier,
      // ── CLI surface policy ──
      obsTypeScoped, // D#76: obs_type ⇒ obs+events (skip type-less sessions/prompts)
      obsTypeFallback: false, // #8217 removed list-by-type fallback from the CLI
      crossSourceEpochSortNoFts: false, // CLI never reaches cross-source with empty ftsQuery (fails earlier)
      rerankPolicy: 'cli', // re-rank/supersede on any obs; re-sort gated on cross-source
      rerankProject: project || cliProject(db),
      recentListingNoFts: false,
      tolerateMissingFts: true, // pre-FTS legacy DBs: swallow session/prompt FTS errors
      tierPosition: 'early', // tier filter inside the obs block (before sessions/prompts)
      tierProject: project || cliProject(db),
    },
  );
  const isDeep = res.isDeep;
  const orFallbackFired = res.orFallbackFired;
  const deepVariants = res.variants;
  const paged = res.page;
  const total = res.total;

  // Deep / escalation observability on stderr — reconstructed from core signals.
  // The CLI emitted these inline in runDeep; same strings, same order (escalation →
  // variants → rerank). rerank is only ever true on explicit --deep (never auto).
  if (res.escalated)
    process.stderr.write(
      `[mem] auto-escalated to deep search (weak results: ${res.escalatedObsCount} hits)\n`,
    );
  if (isDeep && deepVariants) {
    process.stderr.write(
      deepVariants.length > 1
        ? `[mem] Deep search: rewrote into ${deepVariants.length} query variants, RRF-fused\n`
        : '[mem] Deep search: rewrite returned no usable variants; used original query only\n',
    );
  }
  if (rerank) {
    process.stderr.write(
      res.reranked
        ? '[mem] Deep search: LLM-reranked the fused top-20\n'
        : '[mem] Deep search: rerank produced no usable order; kept fused order\n',
    );
  }

  // "nothing matched" (no offset) vs "this page is empty" (with offset) — the two
  // CLI messages. preFinalizeCount is the pre-pagination population (post-tier).
  if (res.preFinalizeCount === 0) {
    if (jsonOutput) {
      out(
        JSON.stringify({
          query,
          total: 0,
          returned: 0,
          offset,
          limit,
          deep: isDeep,
          variants: isDeep ? deepVariants : undefined,
          results: [],
        }),
      );
    } else {
      out(`[mem] No results for "${query}"`);
      emitRecallHint(db, query);
      // The zero-result path is where the trailer earns its keep — the D#92
      // failure chain was exactly "searched, found nothing, item was deferred".
      emitDeferredTrailer();
    }
    return;
  }

  if (paged.length === 0) {
    if (jsonOutput) {
      out(
        JSON.stringify({
          query,
          total,
          returned: 0,
          offset,
          limit,
          deep: isDeep,
          variants: isDeep ? deepVariants : undefined,
          results: [],
        }),
      );
    } else {
      out(`[mem] No results for "${query}" at offset ${offset}`);
    }
    return;
  }

  // "N of M" total when paged < total (paired-path with server.mjs formatSearchOutput, #8198).
  const showTime = sort === 'time';
  const hasMixed = paged.some((r) => r.source === 'session' || r.source === 'prompt' || r.source === 'event');
  // Suppressed when --or was explicit — user already asked for OR, no "fallback" there.
  const fallbackHint = orFallbackFired && !useOr ? ' (relaxed AND→OR)' : '';

  if (jsonOutput) {
    const items = paged.map((r) => {
      const base = {
        source: r.source,
        id: r.id,
        created_at: r.created_at,
        score: r.score ?? null,
      };
      if (r.source === 'session') {
        return {
          ...base,
          request: r.request || null,
          completed: r.completed || null,
          project: r.project || null,
        };
      }
      if (r.source === 'prompt') {
        return { ...base, prompt_text: r.prompt_text || null };
      }
      return {
        ...base,
        type: r.type,
        title: r.title || r.subtitle || null,
        lesson_learned: r.lesson_learned || null,
        importance: r.importance ?? null,
        files_modified: r.files_modified || null,
        body_tokens: r.bodyTokens ?? null,
      };
    });
    out(
      JSON.stringify({
        query,
        total,
        returned: paged.length,
        offset,
        limit,
        deep: isDeep,
        variants: isDeep ? deepVariants : undefined,
        relaxed_and_to_or: orFallbackFired && !useOr,
        mixed_sources: hasMixed,
        results: items,
      }),
    );
    return;
  }

  const countLabel = total > paged.length ? `${paged.length} of ${total}` : `${paged.length}`;
  // Pluralize on total — "Found 1 of 44 result" reads wrong; the population (44) drives
  // grammatical number, not the page slice (1).
  out(
    `[mem] Found ${countLabel} result${total !== 1 ? 's' : ''} for "${query}"${fallbackHint}:${hasMixed ? ' (# observation, S# session, P# prompt, E# event)' : ''}`,
  );
  // `~Nt` = est. tokens to fetch this row's full body via mem_get (attachBodyTokens, paired with
  // MCP). Conditional so a row that skipped enrichment renders cleanly, not "~undefinedt".
  const tok = (r) => (r.bodyTokens ? ` ~${r.bodyTokens}t` : '');
  for (const r of paged) {
    const timeStr = showTime && r.created_at_epoch ? ` (${relativeTime(r.created_at_epoch)})` : '';
    if (r.source === 'session') {
      const date = fmtDateShort(r.created_at);
      out(
        `S#${r.id} 📋 ${date}${timeStr} ${truncate(r.request || r.completed || '(no summary)', 80)}${tok(r)}`,
      );
    } else if (r.source === 'prompt') {
      const date = fmtDateShort(r.created_at);
      out(`P#${r.id} 💬 ${date}${timeStr} ${truncate(r.prompt_text || '(empty)', 80)}${tok(r)}`);
    } else if (r.source === 'event') {
      const date = fmtDateShort(r.created_at);
      out(
        `E#${r.id} ${typeIcon(r.type)} ${date}${timeStr} ${truncate(r.title || '(untitled)', 80)}${tok(r)}`,
      );
      if (r.lesson_learned) {
        out(`  -> ${truncate(r.lesson_learned, 80)}`);
      }
    } else {
      const date = fmtDateShort(r.created_at);
      const title = truncate(r.title || r.subtitle || '(untitled)', 80);
      out(`#${r.id} ${typeIcon(r.type)} ${date}${timeStr} ${title}${tok(r)}`);
      if (r.lesson_learned) {
        out(`  -> ${truncate(r.lesson_learned, 80)}`);
      }
    }
  }
  emitDeferredTrailer();
}

function cmdRecent(db, args) {
  const { positional, flags } = parseArgs(args);
  const rawArg = positional[0];
  const rawLimit = parseInt(rawArg, 10);
  // Single source of the upper bound for BOTH the positional [N] and the --limit
  // flag (help: "alias for [N] (max 1000)"). Pre-fix the positional path skipped
  // this cap, so `recent 999999` issued an uncapped `LIMIT 999999` full-table dump
  // while `recent --limit 999999` correctly rejected → default — exactly the
  // "none capped --limit dumps the whole set" footgun parseIntFlag was extracted
  // to close (lib/cli-flags.mjs). The literal now lives in lib/recent-core.mjs so
  // the MCP surface is capped by the same number.
  // isNumericToken first: "2abc"→2 / "1e2"→1 are positive integers that the bare check
  // accepted silently; the positional path must reject garbage like the --limit flag does.
  const isValid =
    rawArg !== undefined &&
    isNumericToken(rawArg) &&
    Number.isInteger(rawLimit) &&
    rawLimit > 0 &&
    rawLimit <= RECENT_MAX;
  if (rawArg !== undefined && !isValid) {
    // Name the ACTUAL fallback: a present --limit overrides the positional below, so
    // claiming "default 10" when `recent abc --limit 5` returns 5 misled the user.
    const fallbackLabel = flags.limit !== undefined ? '--limit' : 'default 10';
    process.stderr.write(
      `[mem] Invalid count "${rawArg}" (must be an integer between 1 and ${RECENT_MAX}); using ${fallbackLabel}\n`,
    );
  }
  // Positional [N] wins for backward-compat; --limit is sibling-parity alias
  // (search/recall/browse/stats all accept --limit). Pre-2.69 `recent --limit N`
  // was silently ignored — surprising users extrapolating from siblings.
  const limit = isValid
    ? rawLimit
    : parseIntFlag(flags.limit, { name: '--limit', defaultValue: 10, max: RECENT_MAX });
  const project = flags.project ? resolveProject(db, flags.project) : cliProject(db);
  const jsonOutput = flags.json === true || flags.json === 'true';

  // `recent --type bugfix` previously parsed as a silent no-op — users naturally
  // try this for "show recent bugfixes". Mirror cmdSearch's enum validation.
  const type = flags.type || null;
  if (type) {
    const validObsTypes = OBS_TYPE_SET;
    if (!validObsTypes.has(type)) {
      fail(`[mem] Invalid --type "${type}". Valid: ${[...validObsTypes].join(', ')}`);
      return;
    }
  }

  // --since: relative lower bound on created_at (e.g. "recent 1000 --since 24h").
  // Parsed here (not in the core) because the two surfaces reject a bad duration
  // in their own dialect — CLI fail(), MCP throw.
  let since = null;
  if (flags.since !== undefined) {
    const d = parseDuration(flags.since);
    if (!d.ok) {
      fail(`[mem] Invalid --since "${flags.since}". Use <N><unit>, e.g. 7d, 24h, 90m, 2w.`);
      return;
    }
    since = Date.now() - d.ms;
  }

  // Shared core with MCP mem_recent: live-rows filter + ordering (lib/recent-core.mjs)
  const rows = fetchRecent(db, { project, type, since, limit });

  if (jsonOutput) {
    out(
      JSON.stringify({
        project: project || null,
        limit,
        type: type || null,
        total: rows.length,
        results: rows.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title || r.subtitle || null,
          importance: r.importance ?? null,
          created_at: r.created_at,
          created_at_epoch: r.created_at_epoch,
        })),
      }),
    );
    return;
  }

  if (rows.length === 0) {
    out(`[mem] No recent observations${project ? ` (${project})` : ''}`);
    return;
  }

  out(`[mem] Recent (${project || 'all'}):`);
  for (const r of rows) {
    const time = relativeTime(r.created_at_epoch);
    const title = truncate(r.title || r.subtitle || '(untitled)', 80);
    out(`${('#' + r.id).padEnd(6)} ${typeIcon(r.type)} ${time.padEnd(8)} ${title}`);
  }
}

function cmdRecall(db, args) {
  const { positional, flags } = parseArgs(args);
  if (rejectBareStringFlags(flags, ['file'])) return;
  const file = resolvePositionalAlias(positional.join(' '), flags, ['file']);
  if (file === null) return;
  if (!file) {
    fail(
      '[mem] Usage: claude-mem-lite recall <file> [--limit N] [--include-noise] [--json] — file may also be passed via --file <file>',
    );
    return;
  }

  const limit = parseIntFlag(flags.limit, { name: '--limit', defaultValue: 10, max: 1000 });
  const includeNoise = flags['include-noise'] === true || flags['include-noise'] === 'true';
  const jsonOutput = flags.json === true || flags.json === 'true';

  // Shared core with MCP mem_recall: query + escaping + access bump (lib/recall-core.mjs)
  const { filename, rows } = recallByFile(db, file, { limit, includeNoise });

  if (jsonOutput) {
    out(
      JSON.stringify({
        file: filename,
        limit,
        include_noise: includeNoise,
        total: rows.length,
        results: rows.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title || null,
          lesson_learned: r.lesson_learned || null,
          importance: r.importance ?? null,
          project: r.project,
          created_at: r.created_at,
          created_at_epoch: r.created_at_epoch,
        })),
      }),
    );
    return;
  }

  if (rows.length === 0) {
    out(`[mem] No history for "${filename}"`);
    return;
  }

  out(`[mem] History for ${filename} (${rows.length}):`);
  for (const r of rows) {
    const title = truncate(r.title || '(untitled)', 80);
    const lesson = r.lesson_learned ? `\n     Lesson: ${truncate(r.lesson_learned, 80)}` : '';
    const date = fmtDateShort(r.created_at);
    out(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${title} | ${r.project} | ${date}${lesson}`);
  }
}

// Time-field formatting moved to cli/common.mjs so the CLI `get` and the MCP
// `mem_get` (server.mjs) share one source and can't drift (the drift bug:
// MCP printed bare ms while CLI showed `<ms> (<relative>)`). Imported at the
// top; re-exported here for back-compat with existing importers
// (tests/get-time-format.test.mjs).
export { OBS_TIME_FIELDS, formatObsFieldValue };
// Test seam: exposes cmdSearch with the llm injection slot without going through
// ensureDb — lets hermetic tests pass a seeded :memory: db and a stub llm.
export async function cmdSearchForTest(db, args, opts) {
  return cmdSearch(db, args, opts);
}

function renderObsRows(db, ids, requestedFields) {
  // Access-bump + fetch via the shared get-core (P2-12) — single source with mem_get.
  const rows = fetchObsDetail(db, ids);
  if (rows.length === 0) return null;
  const fields = requestedFields || OBS_FIELDS;
  const parts = [];
  for (const r of rows) {
    const lines = [`#${r.id} [${r.type}] ${fmtDateShort(r.created_at)}`];
    // Retraction first (shared with mem_get via get-core) — see supersededNotice.
    const retracted = supersededNotice(r);
    if (retracted) lines.push(retracted);
    for (const f of fields) {
      if (f === 'id' || f === 'type' || f === 'created_at') continue;
      const val = r[f];
      if (val === null || val === undefined || val === '') continue;
      if (f === 'text' && r.narrative && typeof val === 'string' && val.startsWith(r.narrative)) continue;
      const formatted = formatObsFieldValue(f, val);
      const maxLen = f === 'narrative' ? 1000 : f === 'lesson_learned' ? 500 : f === 'text' ? 500 : 200;
      const display =
        typeof formatted === 'string' && formatted.length > maxLen
          ? formatted.slice(0, maxLen) + '…'
          : formatted;
      lines.push(`${obsFieldLabel(f)}: ${display}`);
    }
    parts.push(lines.join('\n'));
  }
  return { text: parts.join('\n\n'), count: rows.length };
}

function renderSessionRows(db, ids) {
  const rows = fetchSessionDetail(db, ids);
  if (rows.length === 0) return null;
  const parts = [];
  for (const r of rows) {
    const lines = [`S#${r.id} ${fmtDateShort(r.created_at)}`];
    // SESSION_DETAIL_FIELDS (get-core, P2-12): the FULL render set — the old
    // 6-field subset made remaining_items/notes/files_* searchable-but-invisible.
    for (const f of SESSION_DETAIL_FIELDS) {
      if (f === 'id' || f === 'created_at') continue; // already in the header
      const val = r[f];
      if (val === null || val === undefined || val === '') continue;
      const label = f[0].toUpperCase() + f.slice(1).replace(/_/g, ' ');
      lines.push(`${label}: ${val}`);
    }
    parts.push(lines.join('\n'));
  }
  return { text: parts.join('\n\n'), count: rows.length };
}

// The CLI's established labels for the prompt/event detail faces. Sharing the FIELD SET
// with MCP (P2-6) must not rename what users already grep for, so the columns that had a
// label keep it; anything added later falls back to title-case.
const CLI_DETAIL_LABELS = {
  prompt_text: 'Text',
  content_session_id: 'Session',
  file_paths: 'Files',
  git_sha: 'Git',
};

/** Label a column for the CLI's `Label: value` render style. */
const cliFieldLabel = (f) => CLI_DETAIL_LABELS[f] || f[0].toUpperCase() + f.slice(1).replace(/_/g, ' ');

function renderPromptRows(db, ids) {
  const rows = fetchPromptDetail(db, ids);
  if (rows.length === 0) return null;
  const parts = [];
  for (const r of rows) {
    const lines = [`P#${r.id} ${fmtDateShort(r.created_at)}`];
    // id and created_at are already in the header (same convention as the session face).
    for (const f of PROMPT_DETAIL_FIELDS) {
      if (f === 'id' || f === 'created_at') continue;
      const val = r[f];
      if (val === null || val === undefined || val === '') continue;
      lines.push(`${cliFieldLabel(f)}: ${val}`);
    }
    parts.push(lines.join('\n'));
  }
  return { text: parts.join('\n\n'), count: rows.length };
}

function renderEventRows(db, ids) {
  const rows = fetchEventDetail(db, ids); // derives created_at from created_at_epoch
  if (rows.length === 0) return null;
  const parts = [];
  for (const r of rows) {
    const lines = [`E#${r.id} [${r.event_type}] ${r.created_at ? fmtDateShort(r.created_at) : ''}`];
    for (const f of EVENT_DETAIL_FIELDS) {
      if (f === 'id' || f === 'event_type' || f === 'created_at') continue; // in the header
      const val = r[f];
      if (val === null || val === undefined || val === '') continue;
      lines.push(`${cliFieldLabel(f)}: ${val}`);
    }
    parts.push(lines.join('\n'));
  }
  return { text: parts.join('\n\n'), count: rows.length };
}

function cmdGet(db, args) {
  const { positional, flags } = parseArgs(args);
  if (rejectBareStringFlags(flags, ['ids'])) return;
  const idStr = resolvePositionalAlias(positional.join(','), flags, ['ids']);
  if (idStr === null) return;
  if (!idStr) {
    fail(
      '[mem] Usage: claude-mem-lite get <id1,id2,...> [--source obs|session|prompt|event] [--fields f1,f2,...] — ids may also be passed via --ids 1,2\n' +
        '        IDs accept prefix from search output: #123 (obs), P#123 (prompt), S#123 (session), E#123 (event), D#123 (deferred item, full detail).',
    );
    return;
  }

  const tokens = idStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Explicit --source overrides any prefix; otherwise each token's prefix routes individually.
  const explicit = flags.source;
  const validSources = new Set(['obs', 'session', 'prompt', 'event']);
  if (explicit && !validSources.has(explicit)) {
    fail(`[mem] Invalid --source "${explicit}". Use: obs, session, prompt, event`);
    return;
  }

  // D#N deferred tokens are peeled off BEFORE bucketing/source-forcing — they
  // always read deferred_work (get-only surface; delete/timeline keep rejecting).
  const { deferredIds, rest } = splitDeferredTokens(tokens);

  // Shared bucketing with MCP mem_get — single source of truth for P#/S#/E#/# routing (#8050).
  const { bySrc, invalid: unparseable } = bucketIdTokens(rest, { explicit, defaultSource: 'obs' });
  if (unparseable.length > 0) {
    process.stderr.write(`[mem] Ignoring unparseable ID token(s): ${unparseable.join(', ')}\n`);
  }
  if (
    bySrc.obs.length +
      bySrc.session.length +
      bySrc.prompt.length +
      bySrc.event.length +
      deferredIds.length ===
    0
  ) {
    fail('[mem] No valid IDs provided');
    return;
  }

  // Validate --fields against obs schema (only meaningful for obs rows).
  if (rejectBareStringFlags(flags, ['fields', 'source'])) return;
  let requestedFields = null;
  if (flags.fields) {
    const allRequested = flags.fields.split(',').map((s) => s.trim());
    const invalid = allRequested.filter((f) => !OBS_FIELDS.includes(f));
    if (invalid.length > 0) {
      process.stderr.write(
        `[mem] Unknown field(s): ${invalid.join(', ')}. Valid: ${OBS_FIELDS.join(', ')}\n`,
      );
    }
    requestedFields = allRequested.filter((f) => OBS_FIELDS.includes(f));
    if (requestedFields.length === 0) {
      fail('[mem] No valid fields specified');
      return;
    }
  }

  const sections = [];
  let totalFound = 0;
  // Deferred sections render first: explicit D# requests are rare and the
  // FULL detail (never truncated) is the whole point of this surface.
  let deferredMissing = [];
  if (deferredIds.length > 0) {
    const dRows = getDeferredByIds(db, deferredIds);
    const found = new Set(dRows.map((r) => r.id));
    deferredMissing = deferredIds.filter((id) => !found.has(id));
    if (dRows.length > 0) {
      sections.push(dRows.map(formatDeferredDetail).join('\n\n'));
      totalFound += dRows.length;
    }
    if (deferredMissing.length > 0) {
      process.stderr.write(
        `[mem] Deferred item(s) not found: ${deferredMissing.map((i) => `D#${i}`).join(', ')}\n`,
      );
    }
  }
  if (bySrc.obs.length > 0) {
    const s = renderObsRows(db, bySrc.obs, requestedFields);
    if (s) {
      sections.push(s.text);
      totalFound += s.count;
    }
  }
  if (bySrc.session.length > 0) {
    const s = renderSessionRows(db, bySrc.session);
    if (s) {
      sections.push(s.text);
      totalFound += s.count;
    }
  }
  if (bySrc.prompt.length > 0) {
    const s = renderPromptRows(db, bySrc.prompt);
    if (s) {
      sections.push(s.text);
      totalFound += s.count;
    }
  }
  if (bySrc.event.length > 0) {
    const s = renderEventRows(db, bySrc.event);
    if (s) {
      sections.push(s.text);
      totalFound += s.count;
    }
  }

  if (totalFound === 0) {
    // Deferred-only request that found nothing — the source-probe below is
    // about obs/session/prompt/event and would print an empty source list.
    if (
      deferredMissing.length > 0 &&
      bySrc.obs.length + bySrc.session.length + bySrc.prompt.length + bySrc.event.length === 0
    ) {
      fail(
        `[mem] Deferred item(s) not found: ${deferredMissing.map((i) => `D#${i}`).join(', ')}. List open items: claude-mem-lite defer list`,
      );
      return;
    }
    // Probe the OTHER sources so the caller can retry with the right prefix.
    const queried = new Set(
      Object.entries(bySrc)
        .filter(([, v]) => v.length > 0)
        .map(([k]) => k),
    );
    const allIds = [...bySrc.obs, ...bySrc.session, ...bySrc.prompt, ...bySrc.event];
    const probe = probeIdSources(db, allIds, queried);
    const hits = formatProbeHints(probe);
    const hint = hits.length > 0 ? ` Try: ${hits.join('; ')}.` : '';
    const queriedList = [...queried].join(', ');
    fail(`[mem] No records found in source(s) [${queriedList}] for the given ID(s).${hint}`);
    return;
  }

  out(sections.join('\n\n'));
}

function cmdTimeline(db, args) {
  const { positional, flags } = parseArgs(args);
  // Bare `--query` parses to boolean true and crashed downstream in sanitizeFtsQuery
  // (nlp.mjs string ops on a boolean). No sensible default for a search anchor — reject
  // cleanly (#8470). (`--project` bare is absorbed by resolveProject's non-string guard.)
  if (rejectBareStringFlags(flags, ['query'])) return;
  // Route --before/--after through the shared bounded parser, range [0,50] (mirrors MCP
  // mem_timeline's before/after .min(0).max(50)). NOTE this is parseIntFlag's reject-to-default
  // convention, NOT a clamp: an out-of-range value (e.g. `--before 100`) warns to stderr and
  // falls back to the default 5 — same as recent/search/recall, so the behavior is consistent
  // across the CLI (the user sees the valid range and can retry). The point is the UPPER bound:
  // the old hand-rolled validator had none, so `--before 999999999` flowed straight into
  // `LIMIT before+after+1` / the window fetch as a raw SQL LIMIT (whole-table dump) — the
  // #8802 uncapped-LIMIT footgun. min:0 keeps a 0 window legal; parseIntFlag preserves the
  // warn-then-default garbage handling (float truncation + "2abc"/"1e2" rejection).
  const before = parseIntFlag(flags.before, { name: '--before', defaultValue: 5, min: 0, max: 50 });
  const after = parseIntFlag(flags.after, { name: '--after', defaultValue: 5, min: 0, max: 50 });
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const jsonOutput = flags.json === true || flags.json === 'true';

  const toRow = (r) => ({
    id: r.id,
    type: r.type,
    title: r.title || r.subtitle || null,
    created_at: r.created_at,
    created_at_epoch: r.created_at_epoch,
  });

  // Parse --anchor, accepting P#/S#/# prefix so callers can paste search-result IDs verbatim.
  // Resolution ladder (prompt/session → nearest obs, compressed re-anchor, bare-int
  // fallback) is shared with MCP mem_timeline via lib/timeline-core.mjs.
  let anchorId = null;
  let anchorNote = null; // hint line for output when anchor was resolved via conversion
  if (flags.anchor !== undefined && flags.anchor !== true) {
    const resolved = resolveAnchorToken(db, flags.anchor, { project });
    if (!resolved.ok) {
      // --json must always emit a parseable envelope. An explicit-but-missing anchor is
      // a direct-lookup miss (like `get` on a bad id) → anchor:null + error code, rc=1.
      if (jsonOutput) {
        process.exitCode = 1;
        out(
          JSON.stringify({
            anchor: null,
            anchor_note: formatAnchorError(resolved.error, 'mcp'),
            before: [],
            after: [],
            error: resolved.error.code || 'anchor_resolution_failed',
          }),
        );
      } else {
        fail(formatAnchorError(resolved.error, 'cli'));
      }
      return;
    }
    anchorId = resolved.anchorId;
    anchorNote = resolved.anchorNote;
  }

  // Support query-based anchor: `timeline --query "search terms"` or positional.
  // Shared with MCP so AND→OR fallback semantics match `search` — without this,
  // queries like "ep-flush leak" miss rows whose title is "ep-flush ... leaked"
  // that search would otherwise find via OR relaxation.
  const queryStr = flags.query || positional.join(' ');
  if ((!anchorId || isNaN(anchorId)) && queryStr) {
    const found = resolveQueryAnchor(db, queryStr, { project: project ?? null });
    if (found) {
      anchorId = found.anchorId;
      if (found.anchorNote && !anchorNote) anchorNote = found.anchorNote;
    }
  }

  // No anchor: show most recent observations (shared fallback with MCP mem_timeline)
  if (!anchorId || isNaN(anchorId)) {
    if (queryStr) {
      process.stderr.write(`[mem] No anchor found for "${queryStr}", showing recent timeline\n`);
    }
    const rows = fetchRecentTimeline(db, { project, limit: before + after + 1 });

    if (jsonOutput) {
      out(
        JSON.stringify({
          anchor: null,
          anchor_note: queryStr ? `no anchor matched query "${queryStr}"` : null,
          before: [],
          after: [],
          fallback: 'recent',
          results: rows.map(toRow),
        }),
      );
      return;
    }

    if (rows.length === 0) {
      out('[mem] No observations found.');
      return;
    }

    out(`[mem] Timeline (most recent ${rows.length}):`);
    for (const r of rows.reverse()) {
      const time = relativeTime(r.created_at_epoch);
      const title = truncate(r.title || r.subtitle || '(untitled)', 80);
      out(`${('#' + r.id).padEnd(6)} ${typeIcon(r.type)} ${time.padEnd(8)} ${title}`);
    }
    return;
  }

  // Window fetch (access-count bump + project auto-scope) shared with MCP.
  const win = fetchTimelineWindow(db, anchorId, { before, after, project });
  if (!win) {
    // Anchor resolved to a real id but the window fetch found no row (e.g. project
    // mismatch). Same --json contract as the resolution-miss path above.
    if (jsonOutput) {
      process.exitCode = 1;
      out(
        JSON.stringify({
          anchor: null,
          anchor_note: `Observation #${anchorId} not found.`,
          before: [],
          after: [],
          error: 'id-not-found',
        }),
      );
    } else {
      fail(`[mem] Observation #${anchorId} not found`);
    }
    return;
  }
  const { anchor, beforeRows, afterRows } = win;

  if (jsonOutput) {
    out(
      JSON.stringify({
        anchor: toRow(anchor),
        anchor_note: anchorNote,
        before: beforeRows.map(toRow),
        after: afterRows.map(toRow),
      }),
    );
    return;
  }

  const all = [...beforeRows, anchor, ...afterRows];

  out(`[mem] Timeline around #${anchorId}${anchorNote ? ' ' + anchorNote : ''}:`);
  for (const r of all) {
    const marker = r.id === anchorId ? ' <--' : '';
    const time = relativeTime(r.created_at_epoch);
    const title = truncate(r.title || r.subtitle || '(untitled)', 80);
    out(`${('#' + r.id).padEnd(6)} ${typeIcon(r.type)} ${time.padEnd(8)} ${title}${marker}`);
  }
}

function cmdSave(db, args) {
  const { positional, flags } = parseArgs(args);

  // Reject value-less string flags before they reach .split()/saveObservation as a
  // boolean `true` (#8470): bare --files/--title/--lesson crashed with a raw stacktrace.
  // Runs before content resolution so a bare --text gets this clean error, not the usage line.
  if (
    rejectBareStringFlags(flags, [
      'text',
      'content',
      'title',
      'files',
      'lesson',
      'lesson-learned',
      'project',
      'type',
    ])
  )
    return;

  // Content: positional, or --text/--content as flags-only aliases (--content is the
  // literal MCP mem_save field name, #233). Callers coming from the MCP schema map
  // every field to a named flag and omit the positional — the usage error then lands
  // on stderr and reads as "CLI doesn't support save".
  const text = resolvePositionalAlias(positional.join(' '), flags, ['text', 'content']);
  if (text === null) return;
  if (!text.trim()) {
    fail(
      '[mem] Usage: claude-mem-lite save "<text>" [--type T] [--title T] [--importance N] [--project P] [--files f1,f2] [--lesson T] [--closes-deferred 1,D#42] [--supersedes 8754,E#10524] — content may also be passed via --text/--content "<text>"',
    );
    return;
  }

  const type = flags.type || 'discovery';
  const validTypes = OBS_TYPE_SET;
  if (!validTypes.has(type)) {
    fail(`[mem] Invalid type "${type}". Valid: ${[...validTypes].join(', ')}`);
    return;
  }

  // Explicit saves default to importance=2 (notable) — user chose to save
  const rawImp = flags.importance !== undefined ? parseInt(flags.importance, 10) : 2;
  // isNumericToken first: bare parseInt would coerce "2abc"→2 / "1e2"→1 and persist a
  // wrong importance that silently skews ranking/decay. Float literals still truncate (#8277).
  if (
    flags.importance !== undefined &&
    (!isNumericToken(flags.importance) || isNaN(rawImp) || rawImp < 1 || rawImp > 3)
  ) {
    fail(`[mem] Invalid importance "${flags.importance}". Must be 1, 2, or 3.`);
    return;
  }
  // R10 P2-3: write mode — exact matching only, so `--project api` cannot land the row in
  // `mono--api-gateway` where the caller's own next `--project api` read will not find it.
  const project = flags.project ? resolveProject(db, flags.project, { mode: 'write' }) : inferProject();
  const saveFiles = flags.files
    ? flags.files
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
    : [];

  // Optional lesson_learned — accepts --lesson or --lesson-learned (alias)
  // Mirrors MCP memSaveSchema.lesson_learned (≤500 chars) and cmdUpdate's flag handling.
  const rawLesson =
    flags.lesson !== undefined
      ? flags.lesson
      : flags['lesson-learned'] !== undefined
        ? flags['lesson-learned']
        : null;
  if (rawLesson !== null && typeof rawLesson === 'string' && rawLesson.length > 500) {
    fail(`[mem] --lesson too long (${rawLesson.length} chars, max 500).`);
    return;
  }

  // --closes-deferred parsing: accepts comma-separated mixed tokens
  // ("1,D#42,3") with bare integers treated as ordinals and "D#N" as raw ids.
  // We pre-parse tokens here (cheap, syntax-only) but defer resolveDeferredIds
  // INTO the transaction, AFTER the dedup check. Resolving outside the
  // transaction would throw on the duplicate-replay path: the previously-
  // closed deferred row is no longer 'open', so ordinal/id resolution would
  // crash even though the duplicate short-circuit makes closure a no-op.
  // Resolving inside the dedup-gated branch keeps "save the same content
  // twice" idempotent (mirrors server.mjs:934 dedup-skip-closure intent).
  let closesTokens = null;
  if (flags['closes-deferred'] !== undefined && flags['closes-deferred'] !== false) {
    const raw = String(flags['closes-deferred']);
    closesTokens = raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => {
        return /^\d+$/.test(t) ? parseInt(t, 10) : t;
      });
    if (closesTokens.length === 0) {
      fail('[mem] --closes-deferred requires at least one token (integer ordinal or D#N)');
      return;
    }
  }

  // --supersedes: comma-separated ids this save overturns — a bare number for an
  // observation, `E#<n>` for an events row (D#205). Both are tombstoned (dropped from
  // live search); only the observation half is LINKED (`superseded_by` = the new id),
  // because `events.superseded_by_id` references events and cannot hold an observation
  // id. Only same-project live rows are affected (enforced in saveObservation).
  let supersedesIds = null;
  if (flags.supersedes !== undefined && flags.supersedes !== false) {
    const raw = String(flags.supersedes);
    // Tokens go through UNPARSED so saveObservation's classifier — not parseInt — decides
    // what is malformed. parseInt is lenient in the one direction that costs data: it read
    // `1abc` as 1, so a typo (`875x` for `8754`) tombstoned an unrelated observation and
    // printed a clean `Superseded: #1.` Worse, the token vanished before saveObservation
    // saw it, which made the `malformed-id` class D#201 added unreachable from the CLI —
    // the exact face whose silence motivated D#201. Number() rejects `1abc` as NaN.
    supersedesIds = raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (supersedesIds.length === 0) {
      fail(
        '[mem] --supersedes requires at least one id: a number for an observation, or E#<n> for an event (e.g. --supersedes 8754,E#10524)',
      );
      return;
    }
  }

  let result, closesIds;
  try {
    // The transaction body — dedup short-circuit BEFORE the resolver, and D#195's
    // allowStatuses — is lib/save-observation.mjs's (audit 2026-09-02 P1-6). Both faces
    // used to write it out and each carried a "kept in sync with the other" comment.
    ({ result, closesIds } = saveWithClosures(
      db,
      {
        content: text,
        title: flags.title,
        type,
        importance: rawImp,
        project,
        files: saveFiles,
        lesson_learned: rawLesson,
        supersedes: supersedesIds || undefined,
      },
      { closesTokens, project },
    ));
  } catch (e) {
    if (closesTokens) {
      fail(`[mem] save with --closes-deferred failed: ${e.message}`);
    } else {
      fail(`[mem] save failed: ${e.message}`);
    }
    return;
  }

  if (result.kind === 'duplicate') {
    out(
      `[mem] Skipped: similar to existing #${result.existingId}. Use "claude-mem-lite get ${result.existingId}" to review.`,
    );
    // D#201: the dedup swallowed the requested supersession too — say so here,
    // because this branch returns before the note below is ever reached.
    const dupSkip = formatSupersedeSkipped(result.supersedeSkipped);
    if (dupSkip) out(`[mem] ${dupSkip}`);
    return;
  }

  const lessonNote = result.lessonCaptured ? ' 💡lesson captured' : '';
  const closedNote =
    closesIds && closesIds.length > 0 ? ` Closed: ${closesIds.map((i) => `D#${i}`).join(', ')}.` : '';
  const supersededNote = formatSupersededNote(result);
  // G1+G2: detached backfill worker (lesson for obligated types + aliases for
  // every save) — fill-only-empty, so an agent acting on the nudge still wins.
  const enrichNote =
    shouldQueueSaveEnrich(result) && queueSaveEnrich(result.id) ? ' (background enrichment queued)' : '';
  out(
    `[mem] Saved #${result.id} [${result.type}] "${truncate(result.title, 80)}" (project: ${result.project})${lessonNote}${closedNote}${supersededNote}${enrichNote}${buildLessonNudge({ type: result.type, id: result.id, lessonCaptured: result.lessonCaptured, surface: 'cli' })}`,
  );
  // D#201: on its OWN line, after the success line. Appending it to the success
  // string would put a warning inside a sentence that reads as "done".
  const skipNote = formatSupersedeSkipped(result.supersedeSkipped);
  if (skipNote) out(`[mem] ${skipNote}`);
}

// ─── cmdDefer (sub-dispatch: add | list | drop) ──────────────────────────────

function cmdDefer(db, args) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'add':
      cmdDeferAdd(db, rest);
      break;
    case 'list':
      cmdDeferList(db, rest);
      break;
    case 'drop':
      cmdDeferDrop(db, rest);
      break;
    default:
      fail('[mem] Usage: claude-mem-lite defer <add|list|drop> ...');
      fail('[mem]   defer add "<title>" [--priority 1|2|3] [--detail T] [--files f1,f2] [--project P]');
      fail('[mem]   defer list [--project P] [--limit N]');
      fail('[mem]   defer drop <id-or-D#N> --reason "<reason>" [--project P]');
  }
}

function cmdDeferAdd(db, args) {
  const { positional, flags } = parseArgs(args);
  // Reject bare --files/--detail/--project before .split()/bind sees a boolean true (#8470).
  // Runs before title resolution so a bare --title gets this clean error, not the usage line.
  if (rejectBareStringFlags(flags, ['title', 'files', 'detail', 'project'])) return;
  // --title alias: the MCP mem_defer schema's required field IS `title` (#233), so
  // flags-only callers emit `defer add --title "..." --detail "..."` with no positional.
  const resolvedTitle = resolvePositionalAlias(positional.join(' '), flags, ['title']);
  if (resolvedTitle === null) return;
  const title = resolvedTitle.trim();
  if (!title) {
    fail(
      '[mem] Usage: claude-mem-lite defer add "<title>" [--priority 1|2|3] [--detail T] [--files f1,f2] [--project P] — title may also be passed via --title "<title>"',
    );
    return;
  }
  // Mirror MCP memDeferSchema.title (z.string().min(1).max(200)). CLI used to
  // accept multi-line / 1000-char titles, then `defer list` would render them
  // as one wrapped row that pushed every other item off-screen.
  if (title.length > 200) {
    fail(
      `[mem] defer add: title too long (${title.length} chars, max 200). Move detail to --detail "<text>".`,
    );
    return;
  }
  const priority = flags.priority !== undefined ? parseInt(flags.priority, 10) : 2;
  // isNumericToken first: bare parseInt would coerce "3xyz"→3 and silently escalate a
  // deferred item's urgency. Float literals still truncate (#8277).
  if (flags.priority !== undefined && !isNumericToken(flags.priority)) {
    fail(`[mem] Invalid --priority "${flags.priority}". Must be 1 (low), 2 (normal), or 3 (urgent).`);
    return;
  }
  if (![1, 2, 3].includes(priority)) {
    fail(`[mem] Invalid --priority "${flags.priority}". Must be 1 (low), 2 (normal), or 3 (urgent).`);
    return;
  }
  // R10 P2-3: write mode — exact matching only, so `--project api` cannot land the row in
  // `mono--api-gateway` where the caller's own next `--project api` read will not find it.
  const project = flags.project ? resolveProject(db, flags.project, { mode: 'write' }) : inferProject();
  const detail = typeof flags.detail === 'string' ? flags.detail : null;
  const files = flags.files
    ? flags.files
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
    : null;

  let r;
  try {
    r = insertDeferred(db, { project, title, priority, detail, files });
  } catch (e) {
    fail(`[mem] defer add failed: ${e.message}`);
    return;
  }
  // Compute the freshly-inserted row's ordinal for an immediately-actionable
  // response ("ok, deferred this as item N"). Mirrors server.mjs:980.
  const open = listOpenWithOrdinal(db, project, 50);
  const ord = open.find((o) => o.id === r.id)?.ordinal ?? '?';
  out(`[mem] Deferred as D#${r.id} (item ${ord}) in project "${project}".`);
}

function cmdDeferList(db, args) {
  const { flags } = parseArgs(args);
  const project = flags.project ? resolveProject(db, flags.project) : cliProject(db);
  const limit = parseIntFlag(flags.limit, { name: '--limit', defaultValue: 10, max: 100 });
  const list = listOpenWithOrdinal(db, project, limit);
  if (list.length === 0) {
    out(`[mem] No open deferred items in project "${project}".`);
    return;
  }
  out(`[mem] Open deferred items (project "${project}"):`);
  for (const r of list) {
    out(`  ${formatDeferListRow(r)}`);
  }
  const staleHint = formatDeferStaleHint(countStaleOpen(db, project));
  if (staleHint) out(`  ${staleHint}`);
  // Affordance for the detail field — list stays title-only by design (it is
  // mirrored into the SessionStart dashboard, where detail would be noise).
  out(`  Full detail: claude-mem-lite get D#<id>`);
}

function cmdDeferDrop(db, args) {
  const { positional, flags } = parseArgs(args);
  // --id alias (MCP mem_defer_drop.id field shape, #233).
  if (rejectBareStringFlags(flags, ['id'])) return;
  const idStr = resolvePositionalAlias(positional.join(' '), flags, ['id']);
  if (idStr === null) return;
  if (!idStr.trim()) {
    fail(
      '[mem] Usage: claude-mem-lite defer drop <id-or-D#N>[,id2,...] --reason "<reason>" [--project P] — id may also be passed via --id D#N',
    );
    return;
  }
  const reason = flags.reason;
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    fail('[mem] defer drop requires --reason "<non-empty string>"');
    return;
  }
  // Accept either a single token or a comma-separated batch. `save --closes-deferred`
  // already accepts the batch form (cmdSave uses resolveDeferredIds on a split list);
  // drop now mirrors that ergonomic so users can prune multiple items in one call
  // without N shell invocations.
  const rawTokens = idStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const tokens = rawTokens.map((t) => (/^\d+$/.test(t) ? parseInt(t, 10) : t));
  const project = flags.project ? resolveProject(db, flags.project) : cliProject(db);

  let realIds;
  try {
    realIds = resolveDeferredIds(db, project, tokens);
  } catch (e) {
    fail(`[mem] defer drop: ${e.message}`);
    return;
  }
  const dropped = [];
  const noop = [];
  for (const realId of realIds) {
    const r = dropDeferred(db, realId, reason);
    if (r.changed === 0) noop.push(realId);
    else dropped.push(realId);
  }
  if (dropped.length > 0) {
    out(
      `[mem] Dropped ${dropped.map((id) => `D#${id}`).join(', ')} in project "${project}". Reason: ${reason.trim()}`,
    );
  }
  if (noop.length > 0) {
    out(`[mem] No-op (not in 'open' status): ${noop.map((id) => `D#${id}`).join(', ')}`);
  }
  // D#195 (c): catch the mis-drop at the moment it happens, not months later
  // when the ledger can no longer tell a fixed item from a rejected one.
  if (dropped.length > 0) {
    const hint = formatDropReasonHint(reason);
    if (hint) out(`[mem] ${hint}`);
  }
}

// N-1: Quality-focused stats for R-2 A/B baseline.
//
// Shows the five numbers that will tell us whether the Haiku prompt change is
// working: lesson_learned rate, LOW_SIGNAL title rate, per-type hit% and lesson%,
// and current-vs-target deltas. Designed to be eyeballed once a day during the
// A/B rollout. All metrics respect --project and --days filters.
//
// Targets (aspirational, not enforced):
//   - Lesson rate ≥ 15%      (current baseline ~4.4%)
//   - LOW_SIGNAL rate ≤ 30%  (current baseline ~49.4%)
// Batch A CLI↔MCP alignment: CLI `stats --quality` and MCP `mem_stats({quality:true})`
// share the same computation + formatting via lib/stats-quality.mjs. This wrapper
// keeps the cmdStats call-site unchanged (stays sync-compatible) by delegating
// to a dynamic import + sync function chain inside an async caller.
async function renderQualityReport(db, { project, days }) {
  const { computeQualityStats, formatQualityReport } = await import('./lib/stats-quality.mjs');
  out(formatQualityReport(computeQualityStats(db, { project, days })));
}

async function cmdStats(db, args) {
  const { flags } = parseArgs(args);
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const days = parseIntFlag(flags.days, { name: '--days', defaultValue: 30, max: 3650 });
  const jsonOutput = flags.json === true || flags.json === 'true';
  // N-1: --quality routes to a separate quality-focused report (lesson rate,
  // LOW_SIGNAL rate, per-type hit+lesson %, R-2 watchdog targets). Intended as
  // the baseline metric dashboard for the future Haiku prompt A/B test.
  const quality = flags.quality === true || flags.quality === 'true';
  if (quality) {
    if (jsonOutput) {
      const { computeQualityStats } = await import('./lib/stats-quality.mjs');
      out(JSON.stringify(computeQualityStats(db, { project, days })));
      return;
    }
    await renderQualityReport(db, { project, days });
    return;
  }
  // v2.57.x B2: --retry shows the lesson_retry_stats aggregate. Answers
  // "is the bugfix/decision retry path (1 extra Haiku call per attempt)
  // paying off?". If recovered/attempts < 0.10 over a long window, the
  // path is dead weight and should be deleted.
  const retry = flags.retry === true || flags.retry === 'true';
  if (retry) {
    const { readRetryStats } = await import('./hook-llm.mjs');
    const rows = readRetryStats(db, days);
    const totalAttempts = rows.reduce((a, r) => a + r.attempts, 0);
    const totalRecovered = rows.reduce((a, r) => a + r.recovered, 0);
    const recoveryRate = totalAttempts > 0 ? totalRecovered / totalAttempts : 0;
    if (flags.json === true || flags.json === 'true') {
      out(
        JSON.stringify(
          {
            days,
            total_attempts: totalAttempts,
            total_recovered: totalRecovered,
            recovery_rate: Number(recoveryRate.toFixed(4)),
            per_day: rows,
          },
          null,
          2,
        ),
      );
      return;
    }
    out(`[mem] lesson-retry stats — last ${days}d (UTC date buckets)`);
    out(`  attempts:  ${totalAttempts}`);
    out(`  recovered: ${totalRecovered}`);
    out(
      `  rate:      ${(recoveryRate * 100).toFixed(1)}% ${totalAttempts === 0 ? '(no data — retry path may be unused this window)' : ''}`,
    );
    if (totalAttempts >= 50 && recoveryRate < 0.1) {
      out('  ⚠ recovery rate <10% over ≥50 attempts — retry path likely dead weight, consider deleting');
    } else if (totalAttempts >= 50 && recoveryRate >= 0.3) {
      out('  ✓ recovery rate ≥30% — retry path actively saving lessons');
    }
    if (rows.length > 0) {
      out('\n  date         attempts  recovered  rate');
      for (const r of rows.slice(0, 14)) {
        const rate = r.attempts > 0 ? ((r.recovered / r.attempts) * 100).toFixed(1) + '%' : '—';
        out(
          `  ${r.date_bucket}  ${String(r.attempts).padStart(8)}  ${String(r.recovered).padStart(9)}  ${rate.padStart(5)}`,
        );
      }
    }
    return;
  }

  const now = Date.now();
  const {
    obsTotal,
    sessTotal,
    promptTotal,
    obsRecent,
    sessRecent,
    types,
    projects,
    daily,
    tokenEst,
    avgImp,
    lowVal,
    lowSignalTitle,
    noiseRatio,
    lowSignalRatio,
    compressedCount,
    supersededOnlyCount,
    tierMap,
    // currentProject steers the TIER context only (the report itself stays global unless
    // --project was given). Without it, `stats` from a subdirectory tiered every row against
    // the empty cwd-derived name while `recent` had already resolved to the work-tree root.
  } = computeStatsFeed(db, { project, currentProject: cliProject(db), days, now });

  // Hook self-observation: count PreToolUse / Skill-bridge script failures
  // recorded in the last 24h. Surfaces silent breakage (DB corruption,
  // CC upstream field rename) that would otherwise stay invisible — the
  // failure mode that left code-graph's matcher bug undetected for 10 sessions.
  const hookErrors24h = countRecentHookErrors(resolveRuntimeDir(DB_DIR), now - DAY_MS);

  // M-9 (audit 2026-08-14): disk footprint — a "lite" store had accumulated 360MB of
  // pre-maintain snapshots against a 59MB DB with nothing reporting it. Cheap probes
  // only (DB file + .bak aggregate), no recursive tree walk.
  let dbBytes = 0;
  try {
    dbBytes = statSync(join(DB_DIR, 'claude-mem-lite.db')).size;
  } catch {
    /* fresh */
  }
  const snaps = listSnapshots(join(DB_DIR, 'claude-mem-lite.db'));
  const backupBytes = snaps.reduce((s, x) => s + x.size, 0);
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);

  if (jsonOutput) {
    out(
      JSON.stringify({
        project,
        days,
        totals: {
          observations: obsTotal.c,
          sessions: sessTotal.c,
          prompts: promptTotal.c,
        },
        recent: {
          observations: obsRecent.c,
          sessions: sessRecent.c,
        },
        type_distribution: types.map((t) => ({ type: t.type, count: t.c })),
        top_projects: projects.map((p) => ({ project: p.project, count: p.c })),
        daily_activity: daily.map((d) => ({ day: d.day, count: d.c })),
        data_health: {
          estimated_tokens: tokenEst.t ?? 0,
          avg_importance: Number((avgImp.v ?? 1).toFixed(2)),
          low_value_count: lowVal.c,
          noise_ratio: Number(noiseRatio.toFixed(4)),
          low_signal_titles: lowSignalTitle.c,
          low_signal_ratio: Number(lowSignalRatio.toFixed(4)),
          compressed: compressedCount.c,
          superseded_only: supersededOnlyCount.c,
          hook_errors_24h: hookErrors24h,
          db_bytes: dbBytes,
          backup_count: snaps.length,
          backup_bytes: backupBytes,
        },
        tier_distribution: {
          working: tierMap.working ?? 0,
          active: tierMap.active ?? 0,
          archive: tierMap.archive ?? 0,
        },
      }),
    );
    return;
  }

  out(`[mem] Stats${project ? ` (${project})` : ''}:`);
  // Env-aware data dir (CLAUDE_MEM_DIR || ~/.claude-mem-lite) — stated so any
  // raw-db fallback can't guess a co-located-with-the-CLI path (D#92 chain).
  out(`Data dir: ${DB_DIR}`);
  out(
    `Total: ${obsTotal.c.toLocaleString()} observations | ${sessTotal.c} sessions | ${promptTotal.c} prompts`,
  );
  out(`Last ${days}d: ${obsRecent.c} observations | ${sessRecent.c} sessions`);
  out('');
  if (types.length) {
    out('Type distribution (recent):');
    for (const t of types) out(`  ${t.type}: ${t.c}`);
    out('');
  }
  if (projects.length) {
    out('Top projects:');
    for (const p of projects) out(`  ${p.project}: ${p.c}`);
    out('');
  }
  if (daily.length) {
    out('Daily activity (last 7d):');
    for (const d of daily) out(`  ${d.day}: ${d.c} observations`);
    out('');
  }
  out('Data Health:');
  out(`  Est. tokens: ${tokenEst.t ?? 0}`);
  out(`  Avg importance: ${(avgImp.v ?? 1).toFixed(2)}`);
  out(`  Low-value (imp≤1, never used, >30d): ${lowVal.c} (${(noiseRatio * 100).toFixed(1)}% noise)`);
  out(
    `  Low-signal titles (Modified/Error/Worked on…): ${lowSignalTitle.c} (${(lowSignalRatio * 100).toFixed(1)}%)`,
  );
  out(`  Compressed: ${compressedCount.c}`);
  out(
    `  Hook errors (last 24h): ${hookErrors24h}${hookErrors24h > 0 ? `  ← tail ${join(resolveRuntimeDir(DB_DIR), 'hook-errors')}` : ''}`,
  );
  // Hint threshold = the REAL eviction budget (pre-release review 2026-08-16: a
  // hardcoded 3×-DB heuristic promised an eviction that fires only past the budget).
  out(
    `  Disk: DB ${mb(dbBytes)}MB | ${snaps.length} backup snapshot(s) ${mb(backupBytes)}MB${backupBytes > backupBudgetBytes() ? `  ← over the ${mb(backupBudgetBytes())}MB backup budget; next maintain/save snapshot evicts oldest (>7d old)` : ''}`,
  );
  // Tier-1 firing counters for ① file-intel + ② reread-guard (recorded by
  // pre-tool-recall.js via lib/metrics.mjs; CLAUDE_MEM_METRICS=1 to enable).
  const featAgg = aggregateMetrics(DB_DIR, 7);
  const fiN = featAgg.file_intel?.count ?? 0;
  const rrN = featAgg.reread_warn?.count ?? 0;
  const metricsOn = process.env.CLAUDE_MEM_METRICS === '1';
  out(
    `  Feature injections (7d): 📄 file-intel ${fiN} · 🔁 reread-warn ${rrN}${!metricsOn && fiN + rrN === 0 ? '  (set CLAUDE_MEM_METRICS=1 to record)' : ''}`,
  );
  // G13: surface the recall/enrich metering so "did the worker succeed" is
  // readable from stats, not just raw jsonl. enrich-save shows ok/total; the
  // per-reason split (llm-null vs txn-failed …) stays a jq query on the jsonl.
  const prN = featAgg.pretool_recall?.count ?? 0;
  const erN = featAgg.error_recall?.count ?? 0;
  let esOk = 0,
    esN = 0;
  for (const r of readMetrics(DB_DIR, 7)) {
    if (r.event === 'enrich_save') {
      esN++;
      if (r.enriched) esOk++;
    }
  }
  if (prN + erN + esN > 0 || metricsOn) {
    out(
      `  Recall metering (7d): 🧠 pretool ${prN} · ⛑ error-recall ${erN} · ✚ enrich-save ${esOk}/${esN} ok`,
    );
  }
  if (noiseRatio > 0.6 || lowSignalRatio > 0.3)
    out('  ⚠️ High noise ratio — consider running mem maintain / compress');
  out('');
  // Tier counts only live (uncompressed, non-superseded) observations — surface the
  // full decomposition so live + compressed + superseded = Total adds up cleanly.
  const tierTotal = (tierMap.working ?? 0) + (tierMap.active ?? 0) + (tierMap.archive ?? 0);
  const supersededLabel = supersededOnlyCount.c > 0 ? ` + ${supersededOnlyCount.c} superseded` : '';
  out(`Tier distribution (live ${tierTotal}, excludes ${compressedCount.c} compressed${supersededLabel}):`);
  out(
    `  🔴 Working: ${tierMap.working ?? 0} | 🟡 Active: ${tierMap.active ?? 0} | 🔵 Archive: ${tierMap.archive ?? 0}`,
  );
}

function cmdContext(db, args) {
  const { flags } = parseArgs(args);
  const jsonOutput = flags.json === true || flags.json === 'true' || flags.format === 'json';

  // Generate context live from DB — same builder the SessionStart hook uses.
  // Pre-v2.30 this command parsed a snapshot out of CLAUDE.md, but the hook no
  // longer writes there; DB is now the single source of truth.
  const project = flags.project ? resolveProject(db, flags.project) : cliProject(db);
  const block = buildSessionContextLines(db, project).trim();

  if (!block) {
    if (jsonOutput) {
      out(JSON.stringify({ raw: '', sections: {} }));
    } else {
      out(`[mem] No context yet for project "${project}"`);
    }
    return;
  }

  if (jsonOutput) {
    // Parse markdown sections into structured JSON
    const result = { raw: block, sections: {} };
    const sectionRegex = /^###?\s+(.+)$/gm;
    let match;
    const sectionStarts = [];
    while ((match = sectionRegex.exec(block)) !== null) {
      sectionStarts.push({
        name: match[1].trim(),
        index: match.index,
        headerEnd: match.index + match[0].length,
      });
    }
    for (let i = 0; i < sectionStarts.length; i++) {
      const start = sectionStarts[i].headerEnd;
      const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1].index : block.length;
      const key = sectionStarts[i].name.replace(/\s+/g, '_').toLowerCase();
      result.sections[key] = block.slice(start, end).trim();
    }
    out(JSON.stringify(result, null, 2));
  } else {
    // outVerbatim: `context` is the one CLI command that must EMIT a real
    // <claude-mem-context> wrapper — it prints the same block the SessionStart hook
    // injects, so `out`'s defang would strip the delimiters this command exists to
    // produce (the CLI twin of why <skill-loaded> is excluded from CONTEXT_DELIMITER_RE).
    // The untrusted half is already neutralized one layer up: buildSessionContextLines
    // defangs every row it renders, so only the trusted wrapper is written raw here.
    outVerbatim(`<claude-mem-context>\n${block}\n</claude-mem-context>`);
  }
}

// ─── Browse (tier-grouped dashboard) ────────────────────────────────────────

function cmdBrowse(db, args) {
  const { flags } = parseArgs(args);
  const project = flags.project ? resolveProject(db, flags.project) : cliProject(db);
  const tierFilter = flags.tier || null;
  if (tierFilter && !['working', 'active', 'archive'].includes(tierFilter)) {
    fail(`[mem] Invalid tier: "${tierFilter}". Use: working, active, or archive`);
    return;
  }
  const limit = parseIntFlag(flags.limit, { name: '--limit', defaultValue: tierFilter ? 20 : 5, max: 1000 });
  const jsonOutput = flags.json === true || flags.json === 'true';
  const now = Date.now();

  // Shared collection (lib/browse-core, P2-12) — single source with mem_browse.
  const { showTiers, tierData, tierCounts, grandTotal } = collectBrowseTiers(db, {
    project,
    tierFilter,
    limit,
    now,
    currentSessionId: getActiveMemorySessionId(db, project),
  });
  const tiers = BROWSE_TIERS;
  const tierLabels = BROWSE_TIER_LABELS;

  if (jsonOutput) {
    const tiersOut = {};
    for (const tier of showTiers) {
      tiersOut[tier] = {
        count: tierData[tier].count,
        results: tierData[tier].rows.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title || null,
          importance: r.importance ?? null,
          created_at: r.created_at,
          created_at_epoch: r.created_at_epoch,
        })),
      };
    }
    out(
      JSON.stringify({
        project,
        limit,
        tier_filter: tierFilter,
        totals: { ...tierCounts, grand_total: grandTotal },
        tiers: tiersOut,
      }),
    );
    return;
  }

  out(`📊 Memory Dashboard (${project})\n`);

  for (const tier of showTiers) {
    const { count, rows } = tierData[tier];
    out(`${tierLabels[tier]} (${count})`);

    if (tier === 'archive' && !tierFilter) {
      if (count > 0) out('');
      continue;
    }

    if (count === 0) {
      out('');
      continue;
    }

    for (const r of rows) {
      out(
        `  #${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || '(untitled)', 80)} | ${relativeTime(r.created_at_epoch)}`,
      );
    }
    if (count > rows.length) out(`  ... and ${count - rows.length} more`);
    out('');
  }

  if (grandTotal === 0) {
    out('No observations found. Start a coding session to build memory.');
    return;
  }

  if (!tierFilter) {
    const parts = tiers.map((t) => `${t[0].toUpperCase() + t.slice(1)}: ${tierCounts[t] ?? 0}`);
    out(`Totals: ${grandTotal} observations | ${parts.join(' | ')}`);
  }
}

// ─── Delete ──────────────────────────────────────────────────────────────────

function cmdDelete(db, args) {
  const { positional, flags } = parseArgs(args);
  if (rejectBareStringFlags(flags, ['ids'])) return;
  const idStr = resolvePositionalAlias(positional.join(','), flags, ['ids']);
  if (idStr === null) return;
  if (!idStr) {
    fail(
      '[mem] Usage: claude-mem-lite delete <id1,id2,...> [--confirm] — ids may also be passed via --ids 1,2',
    );
    return;
  }

  // delete operates on observations only. Reject P#/S# explicitly so callers aren't
  // surprised by silent NaN filtering when they paste search-output IDs.
  const tokens = idStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const nonObs = tokens.filter((t) => /^[EePpSs]#?\d+$/.test(t));
  if (nonObs.length > 0) {
    fail(
      `[mem] delete only works on observations. Rejected: ${nonObs.join(', ')}. ` +
        `Prompts, sessions, and events are not deletable here — inspect with \`claude-mem-lite get P#N --source prompt\` / \`--source session\` / \`--source event\`.`,
    );
    return;
  }
  const ids = tokens
    .map((t) => {
      const p = parseIdToken(t);
      return p && p.source === null ? p.id : NaN;
    })
    .filter((n) => !isNaN(n));
  if (ids.length === 0) {
    fail('[mem] No valid IDs provided');
    return;
  }

  const confirm = flags.confirm === true || flags.confirm === 'true';
  // Shared preview body (lib/delete-core, P2-12) — single source with mem_delete.
  const { rows, lines: previewLines, missing } = previewDeleteRows(db, ids);

  if (rows.length === 0) {
    fail('[mem] No observations found for given IDs');
    return;
  }

  if (!confirm) {
    out(`[mem] Preview: ${rows.length} observation(s) will be deleted:`);
    for (const line of previewLines) out(line);
    if (missing.length > 0) out(`[mem] Note: ID(s) ${missing.join(', ')} not found and will be skipped.`);
    out('[mem] Run with --confirm to execute deletion.');
    return;
  }

  // Full delete orchestration (snapshot + related_ids cleanup + child recovery + delete
  // transaction) lives in lib/delete-core.mjs — single source of truth shared with the MCP
  // mem_delete path (was inlined here + kept in sync by parity comments, the #1 drift risk).
  const result = deleteObservations(db, ids);
  const recoveredNote =
    result.recoveredChildren > 0
      ? ` Recovered ${result.recoveredChildren} merged/compressed child observation(s) to live.`
      : '';
  out(
    `[mem] Deleted ${result.deleted} observation(s).${recoveredNote}${missing.length > 0 ? ` Note: ID(s) ${missing.join(', ')} not found.` : ''}`,
  );
}

// ─── Update ──────────────────────────────────────────────────────────────────

function cmdUpdate(db, args) {
  const { positional, flags } = parseArgs(args);
  // --id alias (MCP mem_update.id field shape, #233). Bare --id → resolved as absent
  // here (boolean true is not a string), falling through to the usage line below.
  const resolvedId = resolvePositionalAlias(positional[0] ?? '', flags, ['id']);
  if (resolvedId === null) return;
  const raw = resolvedId || undefined;
  if (raw && /^[EePpSs]#?\d+$/.test(String(raw).trim())) {
    fail(
      `[mem] update only works on observations. Rejected: ${raw}. ` +
        `Prompts, sessions, and events are not editable here.`,
    );
    return;
  }
  // Strict parseIdToken gate (aligned with cmdDelete): a bare parseInt fallback
  // truncated "3.9" → 3 and silently UPDATE'd the WRONG row #3 (no preview, no
  // --confirm). Require an exact obs-id token; non-matching input → usage error.
  const parsed = raw ? parseIdToken(raw) : null;
  const id = parsed && parsed.source === null ? parsed.id : NaN;
  if (!id || isNaN(id)) {
    fail(
      '[mem] Usage: claude-mem-lite update <id> [--title T] [--type T] [--importance N] [--lesson T] [--narrative T] [--concepts T] — id may also be passed via --id N',
    );
    return;
  }

  const obs = db.prepare('SELECT id, title FROM observations WHERE id = ?').get(id);
  if (!obs) {
    fail(`[mem] Observation #${id} not found`);
    return;
  }

  // A value-less `--flag` parses to boolean `true` (cli/common.mjs parseArgs); for string
  // fields that would reach the SQLite bind as a raw "TypeError: SQLite3 can only bind ..."
  // (#8470). Reject cleanly via the shared guard — single source with the other commands.
  if (rejectBareStringFlags(flags, ['title', 'narrative', 'lesson', 'lesson-learned', 'concepts'])) return;

  const fields = {};
  if (flags.title !== undefined) {
    // Reject empty title — clears the observation's identifier and would render it
    // as `(untitled)` in every listing. Almost always an accidental shell-stripped arg.
    if (typeof flags.title === 'string' && flags.title.trim() === '') {
      fail(
        '[mem] --title cannot be empty. Pass a non-empty string or omit the flag to leave the title unchanged.',
      );
      return;
    }
    fields.title = flags.title;
  }
  if (flags.narrative !== undefined) {
    // Reject empty (mirror --title): an explicit '' would blank the narrative
    // irrecoverably (update takes no snapshot). Omit the flag to leave it unchanged.
    if (typeof flags.narrative === 'string' && flags.narrative.trim() === '') {
      fail('[mem] --narrative cannot be empty. Omit the flag to leave it unchanged.');
      return;
    }
    fields.narrative = flags.narrative;
  }
  if (flags.type) {
    const validTypes = OBS_TYPE_SET;
    if (!validTypes.has(flags.type)) {
      fail(`[mem] Invalid type "${flags.type}". Valid: ${[...validTypes].join(', ')}`);
      return;
    }
    fields.type = flags.type;
  }
  if (flags.importance) {
    const imp = parseInt(flags.importance, 10);
    // isNumericToken first: bare parseInt would coerce "2abc"→2 and UPDATE the row to a
    // wrong importance. Float literals still truncate (#8277).
    if (!isNumericToken(flags.importance) || isNaN(imp) || imp < 1 || imp > 3) {
      fail(`[mem] Invalid importance "${flags.importance}". Must be 1, 2, or 3.`);
      return;
    }
    fields.importance = imp;
  }
  if (flags.lesson !== undefined || flags['lesson-learned'] !== undefined) {
    const rawLesson = flags.lesson ?? flags['lesson-learned'] ?? '';
    // Mirror cmdSave's 500-char cap — pre-fix `update --lesson <501-char>` was silently
    // accepted, letting overlong lessons leak into the DB through the update path
    // even though save's path rejected them. MCP memSaveSchema also caps at 500.
    if (typeof rawLesson === 'string' && rawLesson.length > 500) {
      fail(`[mem] --lesson too long (${rawLesson.length} chars, max 500).`);
      return;
    }
    if (typeof rawLesson === 'string' && rawLesson.trim() === '') {
      fail('[mem] --lesson cannot be empty. Omit the flag to leave it unchanged.');
      return;
    }
    fields.lesson_learned = rawLesson;
  }
  // Scrub like the sibling text fields above (title/narrative/lesson) and the MCP twin
  // mem_update — concepts is a scrub-target + FTS-indexed column, so a raw secret here
  // lands searchable + exportable (rebuildObservationDerived folds it into `text`).
  if (flags.concepts !== undefined) {
    if (typeof flags.concepts === 'string' && flags.concepts.trim() === '') {
      fail('[mem] --concepts cannot be empty. Omit the flag to leave it unchanged.');
      return;
    }
    fields.concepts = flags.concepts;
  }

  // Shared mutation (lib/observation-write applyObsUpdate, P2-12): scrub + UPDATE +
  // derived-column rebuild in one transaction — single source with MCP mem_update.
  const updatedCols = applyObsUpdate(db, id, fields);
  if (updatedCols.length === 0) {
    fail(
      '[mem] No fields to update. Use --title, --type, --importance, --lesson/--lesson-learned, --narrative, --concepts',
    );
    return;
  }

  out(`[mem] Updated #${id}: ${updatedCols.join(', ')}`);
}

// ─── Export ──────────────────────────────────────────────────────────────────

function cmdExport(db, args) {
  const { flags } = parseArgs(args);
  // Guard value-less string flags. Bare `--to` parsed to boolean `true`, and
  // `new Date(true).getTime()` is 1 (NOT NaN), so the isNaN guard below missed it and
  // the filter became `created_at_epoch <= 1` → an EMPTY export with exit 0. A backup
  // script (`export --to "$END" > backup.json`) with an unset `$END` would silently
  // write an empty backup and report success. Reject like cmdSearch does.
  if (rejectBareStringFlags(flags, ['project', 'type', 'from', 'to'])) return;
  // PARSE + VALIDATE here; the SQL predicate itself comes from buildExportWhere (P2-5),
  // shared with server.mjs runExport. The split is deliberate: the CLI `fail()`s with a
  // usage message where the MCP tool throws, and only this face has a stderr channel for
  // the inverted-range note below.
  const project = flags.project ? resolveProject(db, flags.project) : null;
  if (flags.type) {
    // Reject unknown types — silently returning [] for `--type bogus` looked like a
    // legitimate empty filter result, hiding the typo. Mirrors cmdSearch / cmdSave / cmdUpdate.
    if (!OBS_TYPE_SET.has(flags.type)) {
      fail(`[mem] Invalid --type "${flags.type}". Valid: ${[...OBS_TYPE_SET].join(', ')}`);
      return;
    }
  }
  let exportFromEpoch = null;
  let exportToEpoch = null;
  if (flags.from) {
    exportFromEpoch = new Date(flags.from).getTime();
    if (isNaN(exportFromEpoch)) {
      fail(`[mem] Invalid --from date: "${flags.from}". Use YYYY-MM-DD or ISO 8601.`);
      return;
    }
  }
  if (flags.to) {
    exportToEpoch = new Date(flags.to).getTime();
    if (isNaN(exportToEpoch)) {
      fail(`[mem] Invalid --to date: "${flags.to}". Use YYYY-MM-DD or ISO 8601.`);
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(flags.to)) exportToEpoch += DAY_MS - 1;
  }
  // --include-compressed: include compressed observations (aligned with MCP mem_export).
  // Superseded rows are excluded either way; the flag only toggles the compressed half
  // of the live-row pair (backup/export of tombstones is opt-in, retractions are not).
  const { wheres, params } = buildExportWhere({
    includeCompressed: flags['include-compressed'] === true || flags['include-compressed'] === 'true',
    project,
    type: flags.type || null,
    fromEpoch: exportFromEpoch,
    toEpoch: exportToEpoch,
  });
  if (exportFromEpoch !== null && exportToEpoch !== null && exportFromEpoch > exportToEpoch) {
    process.stderr.write(
      `[mem] Note: --from "${flags.from}" is after --to "${flags.to}"; this range is empty\n`,
    );
  }

  // Backup default: with no --limit, export the COMPLETE matching set. `export` is
  // the documented backup half of backup/restore (README; cmdRestore header), yet its
  // old default capped at 200 (hard max 1000) and the "capped" warning went only to
  // stderr — so a bare `export > backup.json` on a >200-row store silently wrote a
  // truncated backup that lost rows on restore, and `--limit 5000` was REJECTED back
  // to 200 (can't back up >1000 at all). Now: omit --limit → LIMIT -1 (SQLite = no
  // limit); pass --limit N → honor any positive N (a backup may exceed 1000).
  //
  // The invalid-value branch has to land on that same -1, not on the sibling commands'
  // `defaultValue: 200`. `parseIntFlag`'s warn-and-default contract is right for `search`
  // and `recent`, where the default is a display width; here the default is COMPLETENESS,
  // and defaulting a backup to 200 rows reopens the truncation the paragraph above closed
  // — through the invalid door instead of the absent one. It is the same failure shape as
  // the bare `--to` guard at the top of this function: `export --limit "$N" > backup.json`
  // with `$N` unset or typo'd writes 200 rows, warns on a stderr the redirect usually
  // discards, and exits 0. Recovering to the complete set is the only direction that
  // cannot lose a row on restore.
  const limitGiven = flags.limit !== undefined && flags.limit !== null && flags.limit !== '';
  const limit = limitGiven
    ? parseIntFlag(flags.limit, {
        name: '--limit',
        defaultValue: -1,
        warn: () =>
          process.stderr.write(
            `[mem] Invalid --limit "${flags.limit}" (must be an integer ≥ 1); exporting the COMPLETE matching set instead\n`,
          ),
      })
    : -1;
  const format = flags.format || 'json';
  if (!['json', 'jsonl'].includes(format)) {
    fail(`[mem] Invalid format "${format}". Use: json or jsonl`);
    return;
  }

  // Full round-trippable column set so `restore` rebuilds observations faithfully —
  // content + value-signals (access/cited/uncited/injection/decay) + branch + timing.
  // `search_aliases` is an FTS5-indexed column (BM25 weight 5) — dropping it on
  // export silently lost the LLM-generated alternate query terms on restore, so a
  // restored memory became unfindable by its aliases. id + memory_session_id are
  // informational (restore remaps id and buckets under a restore session).
  // EXPORT_COLUMNS_SQL is the single source of truth shared with the MCP mem_export
  // tool (server.mjs) so the two export surfaces can never drift (v3.42 HIGH-2).
  const rows = db
    .prepare(
      `
    SELECT ${EXPORT_COLUMNS_SQL}
    FROM observations WHERE ${wheres.join(' AND ')}
    ORDER BY created_at_epoch DESC LIMIT ?
  `,
    )
    .all(...params, limit);

  if (rows.length === 0) {
    // Empty result must respect the requested format so `export … | jq` works:
    //   json  → "[]" (valid empty array)
    //   jsonl → 0 lines (valid empty file)
    // The friendly note goes to stderr so it doesn't poison stdout for callers
    // piping to a parser.
    if (format === 'json') outVerbatim('[]');
    process.stderr.write('[mem] No observations found matching criteria\n');
    return;
  }

  // outVerbatim, NOT out: `out` neutralizes structural context delimiters (cli/common.mjs)
  // because CLI stdout is model context — but this stream is a BACKUP that `restore` reads
  // back, so defanging it would silently rewrite any row whose text legitimately contains
  // `<system-reminder>`/`</claude-mem-context>` and persist the rewrite on restore. Mirrors
  // safeHandler(mem_export, { verbatim: true }) on the MCP side (audit 2026-08-14 A1).
  if (format === 'jsonl') {
    for (const r of rows) outVerbatim(JSON.stringify(r));
  } else {
    outVerbatim(JSON.stringify(rows, null, 2));
  }

  // `limit > 0`, not just `limitGiven`: an invalid `--limit` now recovers to the complete
  // set (-1), and `rows.length >= -1` is always true — so the guard as written announced
  // "Results capped at -1" on the one path that is guaranteed NOT to be capped.
  if (limitGiven && limit > 0 && rows.length >= limit) {
    process.stderr.write(
      `[mem] Note: Results capped at ${limit}. Raise --limit or narrow --from/--to to export more.\n`,
    );
  }
  // Fidelity caveat at backup-creation time (mirrors the restore-side note). stderr,
  // so stdout stays a clean JSON/JSONL stream for `export > backup.json`.
  process.stderr.write(
    '[mem] Note: export omits related_ids and supersession links (superseded rows are excluded) — content and value-signals round-trip, the relationship graph does not.\n',
  );
}

// ─── Restore ───────────────────────────────────────────────────────────────
// Inverse of `export` — the backup/restore half README:690 promises. Reuses
// lib/save-observation.mjs so FK / FTS / TF-IDF vector / minhash / files-junction
// stay consistent with cmdSave, then a targeted UPDATE re-applies the value-signals
// (access/cited/uncited/injection/decay), branch, and concepts/facts/files_read that
// saveObservation derives or zeros — so a restored backup keeps its citation-decay
// history and original timing (created_at via the `now` param). Source ids are
// discarded (local AUTOINCREMENT; export omits related_ids); session provenance
// collapses to saveObservation's manual-<project> bucket (documented MVP tradeoff).
function cmdRestore(db, argv) {
  const { positional, flags } = parseArgs(argv);
  const file = positional[0];
  if (!file) {
    fail('[mem] Usage: claude-mem-lite restore <file> [--project P] [--dry-run]');
    return;
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    fail(`[mem] Cannot read "${file}": ${e.message}`);
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    out('[mem] Empty file — nothing to restore.');
    return;
  }
  let rows;
  let parseFailures = 0;
  if (trimmed[0] === '[') {
    // Whole-array JSON is a single document — partial parse is impossible, so
    // a syntax error rejects the file (unchanged behavior).
    try {
      rows = JSON.parse(trimmed);
    } catch (e) {
      fail(`[mem] "${file}" is not valid export JSON/JSONL: ${e.message}`);
      return;
    }
  } else {
    // JSONL: tolerate per-line syntax errors so one corrupt line in a large
    // backup doesn't discard every valid row. Parse failures fold into the
    // malformed tally below (the loop already skips valid-JSON-but-wrong-shape
    // rows the same way) — a backup tool must recover what it can.
    rows = [];
    for (const line of trimmed.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        parseFailures++;
      }
    }
  }
  if (!Array.isArray(rows) || (rows.length === 0 && parseFailures === 0)) {
    out('[mem] No observations in file.');
    return;
  }
  if (rows.length === 0) {
    fail(`[mem] "${file}": all ${parseFailures} line(s) failed to parse as JSONL.`);
    return;
  }

  const projOverride = flags.project ? resolveProject(db, flags.project) : null;
  const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true';
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

  const dupCheck = db.prepare(
    'SELECT id FROM observations WHERE project = ? AND title = ? AND created_at_epoch = ? LIMIT 1',
  );
  // Final field state of a restored row, for the post-signalUpdate vector rebuild below.
  const vecRow = db.prepare(
    'SELECT title, narrative, concepts, lesson_learned, search_aliases FROM observations WHERE id = ?',
  );
  const signalUpdate = db.prepare(`UPDATE observations SET
      text = COALESCE(?, text),
      subtitle = ?, concepts = ?, facts = ?, search_aliases = ?, files_read = ?, branch = COALESCE(?, branch),
      scope = ?,
      access_count = ?, cited_count = ?, uncited_streak = ?, injection_count = ?,
      decay_seen_count = ?, last_accessed_at = ?
    WHERE id = ?`);

  let restored = 0,
    skipped = 0,
    malformed = 0,
    tombstoned = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !r.type || !r.title) {
      malformed++;
      continue;
    }
    // M-8 (audit 2026-08-14): a row exported with --include-compressed carries its
    // compressed_into tombstone. Restoring it as a live row resurrects a member its
    // weekly-summary keeper already absorbed (duplicate search hits, and the marker's
    // target id is meaningless in this store). Reject rather than remap; the content
    // lives on in the keeper.
    // D#122: COMPRESSED_PENDING_PURGE (-2) is NOT keeper-absorbed — those rows have
    // no keeper, so rejecting them silently loses their only copy. Restore them
    // live; the maintain decay pipeline will re-evaluate them like any other row.
    // COMPRESSED_AUTO (-1) stays REJECTED by design (review 2026-08-16): those rows
    // were deliberately retired by the quality pipeline (idle-cleanup/optimize mark
    // importance-1 aged rows) — restoring them live would resurrect adjudicated
    // noise, unlike -2 (a purge QUEUE the user may still be racing to undo).
    if (r.compressed_into && r.compressed_into !== COMPRESSED_PENDING_PURGE) {
      tombstoned++;
      continue;
    }
    const project = projOverride || r.project || inferProject();
    const createdEpoch = Number.isFinite(Number(r.created_at_epoch))
      ? Number(r.created_at_epoch)
      : Date.now();
    // Durable exact-dup guard — saveObservation's 5-min Jaccard window can't catch a
    // re-restore of an old-timestamped backup, so gate on project+title+created_at.
    if (dupCheck.get(project, r.title, createdEpoch)) {
      skipped++;
      continue;
    }
    if (dryRun) {
      restored++;
      continue;
    }
    try {
      let files = [];
      try {
        const fm = JSON.parse(r.files_modified || '[]');
        if (Array.isArray(fm)) files = fm;
      } catch {
        /* leave [] */
      }
      const imp = num(r.importance);
      const res = saveObservation(db, {
        content: r.narrative || r.title,
        title: r.title,
        type: r.type,
        importance: imp >= 1 && imp <= 3 ? imp : 1,
        project,
        files,
        lesson_learned: r.lesson_learned || null,
        now: new Date(createdEpoch),
      });
      if (res.kind !== 'saved') {
        skipped++;
        continue;
      } // saveObservation Jaccard dedup
      // Re-apply the fields saveObservation zeros/derives so the backup is faithful.
      // `text` is the observation BODY and its own FTS5 column — import-jsonl / cold-start
      // rows keep the body there with an empty narrative, so saveObservation (content =
      // narrative || title) would collapse it to the bare title. COALESCE re-applies the
      // exported body (NULL when absent → keep saveObservation's derived text, so old
      // backups without the column degrade gracefully). search_aliases is its own FTS5
      // column too, so this UPDATE re-syncs the index (via the observations FTS triggers)
      // and restored body/aliases stay searchable. Scrub the FTS-indexed text fields on
      // the way in — the sibling ingest paths (import-jsonl, compress-core) scrub as
      // defense-in-depth, and restore is the only rewrite path that skipped it. A backup
      // made before a SECRET_PATTERNS entry existed would otherwise re-index an old secret
      // in text/facts/concepts. files_read/branch are paths/identifiers, not scrub-target
      // text — left as-is.
      signalUpdate.run(
        r.text ? scrubSecrets(r.text) : null,
        scrubSecrets(r.subtitle || ''),
        scrubSecrets(r.concepts || ''),
        scrubSecrets(r.facts || ''),
        r.search_aliases === null || r.search_aliases === undefined ? null : scrubSecrets(r.search_aliases),
        r.files_read || '[]',
        r.branch ?? null,
        // v44 scope round-trip (review D#78): whitelist-validated; old backups
        // without the column restore as NULL — same as pre-v44 behavior.
        normalizeScope(r.scope),
        num(r.access_count),
        num(r.cited_count),
        num(r.uncited_streak),
        num(r.injection_count),
        num(r.decay_seen_count),
        r.last_accessed_at ?? null,
        res.id,
      );
      // The FTS `text` column re-syncs through the observations _au trigger, but the
      // TF-IDF vector has no trigger: saveObservation vectorized title+content+lesson,
      // so every field signalUpdate just applied (concepts, search_aliases) was missing
      // from the restored row's vector. Rebuild from the row's FINAL state through the
      // canonical vecTextForRow — the same text every other (re)build path uses. Reading
      // the row back (rather than reusing the locals) keeps this identical to
      // maintain-core's rebuildVectors. Skipped entirely while the vector arm is off,
      // which is the default (lib/observation-write.mjs).
      if (vectorsEnabled()) insertObservationVector(db, res.id, vecTextForRow(vecRow.get(res.id)));
      restored++;
    } catch (e) {
      malformed++;
      if (process.env.CLAUDE_MEM_DEBUG) process.stderr.write(`[mem] restore row failed: ${e.message}\n`);
    }
  }
  // Fold JSONL per-line syntax failures into the malformed tally and the
  // denominator so the report reflects every non-blank input line, not just the
  // ones that parsed.
  const totalMalformed = malformed + parseFailures;
  const totalLines = rows.length + parseFailures;
  const tombstoneNote =
    tombstoned > 0
      ? `, ${tombstoned} compressed member(s) rejected (keeper-absorbed or auto-retired tombstones)`
      : '';
  // Past tense only when rows were actually written. `Restore (dry-run): 6 restored` reads
  // as done to anyone skimming past the parenthetical, and this command's whole job is to
  // let a user check a backup BEFORE trusting it.
  out(
    `[mem] Restore${dryRun ? ' (dry-run)' : ''}: ${restored} ${dryRun ? 'would be restored (at most)' : 'restored'}` +
      `, ${skipped} duplicate(s) ${dryRun ? 'would be skipped' : 'skipped'}${tombstoneNote}` +
      `, ${totalMalformed} malformed/failed from ${totalLines} row(s).`,
  );
  if (dryRun) {
    // The preview applies the durable exact-dup guard (project+title+created_at) but NOT
    // saveObservation's Jaccard near-duplicate collapse, which only exists once rows are
    // being written. Measured: a backup holding two same-titled weekly summaries previewed
    // 10 and restored 9. Simulating Jaccard here would mean a second copy of the dedup rule
    // — the drift class this codebase keeps paying for — so the number is labelled an upper
    // bound instead. Run without --dry-run for the exact count.
    out(
      '[mem] Note: the preview does not simulate near-duplicate collapse, so the real run may restore fewer.',
    );
  }
  // Name the lossiness where the user meets it. Export omits related_ids and drops
  // superseded rows, and restore re-inserts under fresh AUTOINCREMENT ids — so no
  // cross-link can survive the round-trip. That is a deliberate format tradeoff (stored
  // ids would be stale after the remap), but "N restored" alone reads as full fidelity.
  if (restored > 0) {
    out(
      '[mem] Note: related_ids and supersession links are not carried across export/restore (ids are remapped on restore) — restored rows have no cross-links.',
    );
  }
}

// ─── Compress ────────────────────────────────────────────────────────────────

function cmdCompress(db, args) {
  const { flags } = parseArgs(args);
  // Sibling-command flag footgun: compress executes with --execute (optimize uses
  // --run, maintain uses positional `execute`). A bare --run previously fell through to
  // a silent preview; fail fast pointing at the right flag. --execute still wins if both.
  if ((flags.run === true || flags.run === 'true') && flags.execute !== true && flags.execute !== 'true') {
    fail(
      "[mem] compress executes with --execute, not --run (--run is optimize's flag). Re-run: claude-mem-lite compress --execute",
    );
    return;
  }
  const preview = flags.execute !== true && flags.execute !== 'true';
  // Reject malformed --age-days explicitly. The prior fallback (`|| 30`) silently used
  // the default whenever the value parsed as NaN or <1, so users typing `--age-days abc`
  // got the 30-day cutoff without knowing their input was discarded.
  let ageDays = 30;
  if (flags['age-days'] !== undefined) {
    // isNumericToken (not bare parseInt) so "1e5"→1 and "30x"→30 are rejected rather than
    // silently mis-parsed into a far-too-broad cutoff — parity with recent/search/maintain.
    const parsed = Number(flags['age-days']);
    // [30,365] floor/ceil = parity with mem_compress (tool-schemas memCompressSchema
    // .min(30).max(365)). The CLI previously accepted any positive int, so `--age-days 1`
    // compressed day-old rows while the MCP description claimed the CLI "rejects <30 anyway"
    // — a false parity claim (the candidate gate is the real data guard, but the age floor
    // should match the tool the description promises equivalence with).
    if (!isNumericToken(flags['age-days']) || !Number.isInteger(parsed) || parsed < 30 || parsed > 365) {
      fail(
        `[mem] Invalid --age-days "${flags['age-days']}". Must be an integer between 30 and 365 (parity with mem_compress).`,
      );
      return;
    }
    ageDays = parsed;
  }
  const cutoff = Date.now() - ageDays * DAY_MS;
  const project = flags.project ? resolveProject(db, flags.project) : null;

  const candidates = selectCompressionCandidates(db, { cutoff, project });

  if (candidates.length === 0) {
    out('[mem] No candidates for compression.');
    return;
  }

  const compressableGroups = groupByProjectWeek(candidates);

  if (preview) {
    const totalCandidates = compressableGroups.reduce((s, [, obs]) => s + obs.length, 0);
    out(`[mem] Compression preview:`);
    out(`  Total candidates: ${candidates.length}`);
    out(`  Compressable groups (≥3 obs): ${compressableGroups.length}`);
    out(`  Observations to compress: ${totalCandidates}`);
    for (const [key, obs] of compressableGroups.slice(0, 20)) {
      const [proj, week] = key.split('::');
      const types = {};
      for (const o of obs) types[o.type] = (types[o.type] || 0) + 1;
      const typeStr = Object.entries(types)
        .map(([t, c]) => `${c} ${t}`)
        .join(', ');
      out(`  ${proj} ${week}: ${obs.length} obs (${typeStr})`);
    }
    out('[mem] Run with --execute to compress.');
    return;
  }

  // Execute compression — one transaction over all groups (the hook transacts per group).
  let totalCompressed = 0;
  db.transaction(() => {
    for (const [key, obs] of compressableGroups) {
      const [proj] = key.split('::');
      totalCompressed += compressGroup(db, proj, obs).compressed;
    }
  })();

  out(`[mem] Compressed ${totalCompressed} observations into ${compressableGroups.length} weekly summaries.`);
}

// ─── Maintain ────────────────────────────────────────────────────────────────

// Shared by BOTH maintain branches. It used to be a local const inside `execute`,
// which is why `scan` — the preview step — silently accepted `--ops purge-stale`
// (hyphen for underscore), printed a full report and exited 0, leaving the typo to
// surface only on the run the preview was supposed to de-risk. The list itself now
// comes from lib/maintain-core.mjs so this face and the MCP schema cannot drift.
const VALID_MAINTAIN_OPS = ALL_MAINTAIN_OPS;

function cmdMaintain(db, args) {
  const { positional, flags } = parseArgs(args);
  const action = positional[0];
  if (!action || !['scan', 'execute'].includes(action)) {
    fail(
      "[mem] Usage: claude-mem-lite maintain <scan|execute> [--ops cleanup,decay,boost,demote_pinned,dedup,purge_stale,rebuild_vectors,vacuum] [--project P] [--retain-days N] [--merge-ids keepId:removeId,...] — 'scan' previews, 'execute' applies.",
    );
    return;
  }
  // Guard value-less string flags before any `.split()` / resolveProject runs. A bare
  // `--merge-ids` parsed to boolean `true`, and `true.split(',')` (line ~1911) crashed
  // with a raw stack trace — the one string-flag path that lacked this #8470 guard, and
  // the exact form the `scan` output suggests copy-pasting (`--merge-ids <pairs>`).
  if (rejectBareStringFlags(flags, ['ops', 'project', 'merge-ids', 'retain-days'])) return;

  const project = flags.project ? resolveProject(db, flags.project) : null;
  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];

  if (action === 'scan') {
    // Validate --ops here too, with the same list and the same message `execute`
    // uses. Catching the typo in the PREVIEW is the whole point: this is the step a
    // user runs to find out what would happen, and it used to ignore the flag
    // wholesale. Only validated when present — a plain `maintain scan` is unchanged.
    if (flags.ops !== undefined) {
      const scanOps = String(flags.ops)
        .split(',')
        .map((s) => s.trim());
      const invalid = scanOps.filter((op) => !VALID_MAINTAIN_OPS.includes(op));
      if (invalid.length > 0) {
        fail(`[mem] Unknown operation(s): ${invalid.join(', ')}. Valid: ${VALID_MAINTAIN_OPS.join(', ')}`);
        return;
      }
    }

    const staleAge = Date.now() - STALE_AGE_MS;
    const mctx = { projectFilter, baseParams, staleAge };
    const duplicates = findDuplicates(db, mctx);
    const stats = maintenanceStats(db, mctx);

    out(`[mem] Maintenance scan:`);
    // The ops are valid but scan is not scoped by them — say so instead of letting a
    // scoped-looking invocation imply a scoped report.
    if (flags.ops !== undefined) {
      out(`  (--ops is an execute-time filter; this scan reports every category)`);
    }
    out(`  Total active: ${stats.total}`);
    out(`  Near-duplicate pairs: ${duplicates.length}`);
    out(`  Stale (>30d, imp=1, no access, never injected): ${stats.stale}`);
    out(`  Broken (no title/narrative): ${stats.broken}`);
    out(`  Boostable (accessed>3, imp<3): ${stats.boostable}`);
    out(
      `  Pinned-but-uncited (inj>=${PINNED_INJ_THRESHOLD}, cited=0, above floor): ${stats.pinned} — floored by the default maintain set since v3.76.0, no lesson → 1, lesson → 2 (opt out: CLAUDE_MEM_SKIP_DEMOTE_PINNED=1)`,
    );
    out(formatPendingPurgeLine(stats.pendingPurge));
    if (duplicates.length > 0) {
      const autoMergeable = duplicates.filter((d) => parseFloat(d.similarity) >= AUTO_MERGE_THRESHOLD);
      const manualReview = duplicates.filter((d) => parseFloat(d.similarity) < AUTO_MERGE_THRESHOLD);

      if (autoMergeable.length > 0) {
        out(`  Auto-mergeable (similarity >= ${AUTO_MERGE_THRESHOLD}):`);
        for (const d of autoMergeable.slice(0, 15)) {
          const keep = (d.a.importance ?? 1) >= (d.b.importance ?? 1) ? d.a : d.b;
          const remove = keep === d.a ? d.b : d.a;
          out(
            `    [${keep.id}] "${truncate(keep.title, 40)}" <-> [${remove.id}] "${truncate(remove.title, 40)}" (${d.similarity})`,
          );
        }
        const mergeIds = autoMergeable.map((d) => {
          const keep = (d.a.importance ?? 1) >= (d.b.importance ?? 1) ? d.a : d.b;
          const remove = keep === d.a ? d.b : d.a;
          return `${keep.id}:${remove.id}`;
        });
        out(`  Ready-to-use: claude-mem-lite maintain execute --ops dedup --merge-ids ${mergeIds.join(',')}`);
      }

      if (manualReview.length > 0) {
        out('  Needs review:');
        for (const d of manualReview.slice(0, 15)) {
          out(
            `    [${d.a.id}] "${truncate(d.a.title, 40)}" <-> [${d.b.id}] "${truncate(d.b.title, 40)}" (${d.similarity})`,
          );
        }
      }
    }
    return;
  }

  // Execute
  // Distinguish flag-absent (use default op set) from flag-present-but-empty
  // (`--ops ""`, e.g. an unset shell var). The latter previously coerced via `||`
  // to the destructive default set and EXECUTED it; route it to the VALID_MAINTAIN_OPS check
  // below instead so it's rejected like `--ops " "` / `--ops "decay,"`. (That default
  // was the literal `cleanup,decay,boost` when this was written; it now comes from
  // DEFAULT_MAINTAIN_OPS, which is why the list is no longer spelled out here.)
  const opsStr = flags.ops === undefined ? resolveDefaultMaintainOps().join(',') : String(flags.ops);
  const ops = opsStr.split(',').map((s) => s.trim());
  const invalidOps = ops.filter((op) => !VALID_MAINTAIN_OPS.includes(op));
  if (invalidOps.length > 0) {
    fail(`[mem] Unknown operation(s): ${invalidOps.join(', ')}. Valid: ${VALID_MAINTAIN_OPS.join(', ')}`);
    return;
  }
  const staleAge = Date.now() - STALE_AGE_MS;
  const mctx = { projectFilter, baseParams, staleAge, opCap: OP_CAP };

  // Parse + validate --retain-days BEFORE the transaction so an invalid value rejects the
  // whole command atomically. The old code validated inside db.transaction() with a bare
  // `return`, so an earlier op (cleanup hard-delete / decay / boost) had already mutated and
  // the transaction COMMITTED despite the exit-1 error (audit MED-2 atomicity).
  let retainDays = 30;
  if (ops.includes('purge_stale') && flags['retain-days'] !== undefined) {
    // Number + isInteger (not parseInt) so "7.5"/"30x" are rejected rather than silently
    // truncated — parity with the mem_maintain zod .int().min(7).max(365) bound.
    const parsed = Number(flags['retain-days']);
    if (!Number.isInteger(parsed) || parsed < 7 || parsed > 365) {
      fail(`[mem] --retain-days must be an integer in [7, 365] (got "${flags['retain-days']}")`);
      return;
    }
    retainDays = parsed;
  }
  const retainCutoff = Date.now() - retainDays * DAY_MS;
  // purge_stale is the only DELETE here — require --confirm so a mis-typed run can't wipe rows.
  const confirmed = flags.confirm === true || flags.confirm === 'true';

  // Parse "keepId:removeId1:removeId2,keepId2:removeId3"; surface malformed segments
  // (non-numeric / single-element) instead of silently dropping them. The merge SQL and the
  // op ORDER both live in maintain-core (shared with MCP, audit 2026-09-02 P1-5) — this is
  // the one genuinely CLI-shaped part, because the MCP tool receives groups already typed.
  const invalidMergeSegments = [];
  const mergeGroups = [];
  if (flags['merge-ids']) {
    for (const seg of String(flags['merge-ids'])
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const parts = seg.split(':').map((x) => x.trim());
      const nums = parts.map((x) => Number(x));
      if (parts.length < 2 || nums.some((n) => !Number.isFinite(n) || n <= 0)) {
        invalidMergeSegments.push(seg);
        continue;
      }
      mergeGroups.push(nums);
    }
  }

  const results = runMaintainOps(db, mctx, ops, {
    retainDays,
    retainCutoff,
    confirmed,
    mergeGroups,
    mergeIdsProvided: Boolean(flags['merge-ids']),
    invalidMergeSegments,
    mergeIdsFlagName: '--merge-ids',
    renderPurgePreview: (previewRow) => {
      const lines = [
        'purge_stale preview (no --confirm):',
        `  Candidates (pending-purge, older than ${retainDays}d): ${previewRow.candidates}`,
      ];
      if (previewRow.candidates > 0) {
        lines.push(`  Oldest: ${new Date(previewRow.oldest).toISOString().slice(0, 10)}`);
        lines.push(`  Newest: ${new Date(previewRow.newest).toISOString().slice(0, 10)}`);
      }
      lines.push('  To delete, re-run with --confirm.');
      return lines.join('\n');
    },
  });

  out(`[mem] ${results.join('\n[mem] ')}`);
}

// cmdFtsCheck extracted to cli/fts-check.mjs (v2.41 split).
import { cmdFtsCheck } from './cli/fts-check.mjs';

// ─── memdir-audit ────────────────────────────────────────────────────────────
// Body-structure audit for ~/.claude/projects/<encoded>/memory/feedback_*.md
// and project_*.md. CLI-only by design — running this every session would be
// noise; it's a one-shot governance pass. Exit code 0 = 100% compliant,
// 1 = at least one file is non-compliant (so it can gate CI if a project
// wants to enforce structure).

function _formatAuditResult(memdir, result) {
  const lines = [`[mem] memdir audit: ${memdir}`];
  const fmt = (label, list) =>
    list.length ? `${label} (${list.length}):\n  - ${list.join('\n  - ')}` : `${label} (0)`;
  lines.push(fmt('Compliant', result.compliant));
  lines.push(fmt('Missing **Why:**', result.missingWhy));
  lines.push(fmt('Missing **How to apply:**', result.missingHowToApply));
  lines.push(fmt('Missing both', result.missingBoth));
  lines.push(`Total: ${result.total} file(s) (${result.compliant.length} compliant)`);
  return lines.join('\n');
}

function _resolveMemdirsForAudit(flags) {
  if (typeof flags.memdir === 'string' && flags.memdir.length > 0) {
    return [flags.memdir];
  }
  if (flags.all === true || flags.all === 'true') {
    const projectsRoot = join(homedir(), '.claude', 'projects');
    if (!existsSync(projectsRoot)) return [];
    let entries;
    try {
      entries = readdirSync(projectsRoot);
    } catch {
      return [];
    }
    return entries
      .map((name) => join(projectsRoot, name, 'memory'))
      .filter((p) => existsSync(p))
      .sort();
  }
  return [memdirPath(process.cwd())];
}

function cmdMemdirAudit(args) {
  const { flags } = parseArgs(args);
  const memdirs = _resolveMemdirsForAudit(flags);
  if (memdirs.length === 0) {
    out('[mem] No memdirs to audit (use --memdir <path> or run inside a Claude Code project).');
    return;
  }
  let nonCompliant = 0;
  let totalScanned = 0;
  for (const md of memdirs) {
    const result = auditMemdir(md);
    out(_formatAuditResult(md, result));
    totalScanned += result.total;
    nonCompliant += result.missingWhy.length + result.missingHowToApply.length + result.missingBoth.length;
    if (memdirs.length > 1) out('');
  }
  if (memdirs.length > 1) {
    out(
      `[mem] Scanned ${memdirs.length} memdir(s), ${totalScanned} memory file(s), ${nonCompliant} non-compliant.`,
    );
  }
  if (nonCompliant > 0) process.exitCode = 1;
}

// `citation-stats --sidechain`: subagent (sidechain) cite-recall, the blind spot the
// main decay loop excludes (it runs mainOnly). aggregateProjectCiteRecall scans THIS
// project's transcripts: top-level <session>.jsonl = main, and
// <session>/subagents/agent-*.jsonl = sidechain (descends ONE level into the literal
// subagents/ dir only, no unbounded recursion). Same methodology, so comparable.
function _reportSidechainCiteRecall({ days, json }) {
  const cutoff = Date.now() - days * 86400 * 1000;
  // memdir = ~/.claude/projects/<encoded>/memory; transcripts are its siblings.
  const txDir = dirname(memdirPath(process.cwd()));
  const { main, sidechain } = aggregateProjectCiteRecall(txDir, { cutoff });
  const rate = (b) => (b.injected > 0 ? (100 * b.recalled) / b.injected : null);
  const sideRate = rate(sidechain),
    mainRate = rate(main);

  if (json) {
    out(
      JSON.stringify({
        window_days: days,
        main: { ...main, rate: mainRate },
        sidechain: { ...sidechain, rate: sideRate },
      }),
    );
    return;
  }

  const pct = (r) => (r === null ? '—' : `${r.toFixed(1)}%`);
  out(`Sidechain (subagent) cite-recall — last ${days}d:`);
  out(
    `  main        ${pct(mainRate).padStart(6)}   recalled ${main.recalled} / injected ${main.injected}   (${main.files} transcript(s))`,
  );
  out(
    `  sidechain   ${pct(sideRate).padStart(6)}   recalled ${sidechain.recalled} / injected ${sidechain.injected}   (${sidechain.files} subagent file(s), ${sidechain.withInjections} with injections)`,
  );
  if (sidechain.files > 0 && sidechain.injected === 0) {
    out('  → subagent transcripts exist but none carried a detectable memory injection in');
    out('    this window. claude-mem-lite hooks do NOT fire inside subagents; the dispatch-');
    out('    time surface (pre-agent-inject.js, CLAUDE_MEM_SUBAGENT_INJECT) prompt-injects');
    out('    a lesson when enabled — a 0 here means it was off or selected none for these.');
  } else if (sidechain.files === 0) {
    out('  → no subagent transcripts in window.');
  }
}

/**
 * `citation-stats` — visualize the citation-decay feedback loop:
 * per-project cite rate + active decay queue + recently promoted.
 * Read-only over observations.
 *
 * Flags:
 *   --json       machine-readable output
 *   --days N     project cite-rate window (default 7)
 *   --sidechain  subagent (sidechain) cite-recall vs main — the decay-loop blind spot
 */
function cmdCitationStats(db, args) {
  const { flags } = parseArgs(args);
  const json = flags.json === true || flags.json === 'true';
  const days = parseIntFlag(flags.days, { name: '--days', defaultValue: 7, max: 365 });

  if (flags.sidechain === true || flags.sidechain === 'true') {
    return _reportSidechainCiteRecall({ days, json });
  }

  const cutoff = Date.now() - days * 86400 * 1000;
  const perProject = db
    .prepare(
      `
    SELECT project,
           COALESCE(SUM(cited_count), 0) AS cited,
           COALESCE(SUM(decay_seen_count), 0) AS resolved,
           SUM(CASE WHEN uncited_streak >= 2 THEN 1 ELSE 0 END) AS at_risk
      FROM observations
     WHERE created_at_epoch >= ?
       AND ${liveObsFilterSql('')}
  GROUP BY project
  ORDER BY resolved DESC
  `,
    )
    .all(cutoff);

  const decayQueue = db
    .prepare(
      `
    SELECT id, project, type, title, importance, uncited_streak, cited_count
      FROM observations
     WHERE uncited_streak >= 2
       AND ${liveObsFilterSql('')}
  ORDER BY uncited_streak DESC, importance ASC
     LIMIT 20
  `,
    )
    .all();

  // D#179/D#198, second half: the sibling `demoted` caption below was re-worded when the
  // decay loop stopped writing `importance`, and this one was not — the same "the copy I
  // fixed was not the only copy" shape the batch's own sweeps exist to prevent. Gating on
  // `importance >= 3` made the section structurally empty for anything the loop produces:
  // a row cited in ten sessions now has cited_count = 10 and whatever importance it was
  // saved with, so the section degenerated into "rows that were already at 3" under a
  // caption reading "promoted". The discriminator is now the pair the promote branch
  // actually writes (`cited_count + 1`, `uncited_streak = 0`); `importance` is still
  // SELECTed and printed, so a reader can see it is unrelated.
  const promoted = db
    .prepare(
      `
    SELECT id, project, type, title, importance, cited_count
      FROM observations
     WHERE cited_count >= 1 AND COALESCE(uncited_streak, 0) = 0
       AND ${liveObsFilterSql('')}
  ORDER BY cited_count DESC
     LIMIT 10
  `,
    )
    .all();

  const demoted = db
    .prepare(
      `
    SELECT id, project, type, title, importance, demoted_at
      FROM observations
     WHERE demoted_at IS NOT NULL
       AND demoted_at >= ?
       AND ${liveObsFilterSql('')}
  ORDER BY demoted_at DESC
     LIMIT 10
  `,
    )
    .all(cutoff);

  // v34.x: surface pre-v34 data pollution. applyCitationDecay bumps cited_count
  // and decay_seen_count atomically (same UPDATE statement), so the invariant
  // cited_count <= decay_seen_count holds for every resolution this codepath
  // performs. Yet a small set of obs violate it — these are pre-v34 rows
  // where a backfill seeded cited_count without populating decay_seen_count.
  // Without this note, those rows make per-project cite_pct >100% with no
  // explanation. Cite rate stays unbiased for obs created after this commit.
  const pollutedRows = db
    .prepare(
      `
    SELECT COUNT(*) AS n FROM observations
     WHERE cited_count > decay_seen_count
       AND ${liveObsFilterSql('')}
  `,
    )
    .get();
  const dataPollutionNote =
    pollutedRows.n > 0
      ? `${pollutedRows.n} obs have cited_count > decay_seen_count (pre-v34 backfill — invariant holds for new data).`
      : null;

  // R1: per-session invocation→cite funnel trend (citation_log). Same `days` window
  // as the per-project cite rate above; funnel.prior/delta_pt show the direction.
  const funnel = computeCitationFunnelTrend(db, { days });
  // v45: per-injection-face split of the same funnel (citation_surface_log).
  const surfaceFunnel = computeSurfaceFunnel(db, { days });

  // Survivorship-honesty: the per-project rate (cited_count/decay_seen_count over
  // SURVIVING in-window obs) is doubly biased — GC drops uncited obs from the
  // denominator and the window excludes older obs — so it overstates adoption (a
  // project can read 91% while its true lifetime inject→cite is ~6%). citation_log
  // rows persist across GC, so their per-project sum is the honest historical rate.
  // Attach both to each row so the text + JSON surface the biased and honest numbers.
  const funnelByProject = new Map(
    db
      .prepare(
        `SELECT project, COALESCE(SUM(injected_n), 0) inj, COALESCE(SUM(cited_n), 0) cit
                  FROM citation_log GROUP BY project`,
      )
      .all()
      .map((r) => [r.project, r]),
  );
  for (const r of perProject) {
    const f = funnelByProject.get(r.project);
    r.funnel_injected = f ? f.inj : 0;
    r.funnel_cited = f ? f.cit : 0;
  }

  if (json) {
    out(
      JSON.stringify(
        {
          window_days: days,
          per_project: perProject,
          decay_queue: decayQueue,
          promoted,
          demoted,
          data_pollution_note: dataPollutionNote,
          funnel,
          surface_funnel: surfaceFunnel,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (dataPollutionNote) out(`Note: ${dataPollutionNote}\n`);
  out(`Cite rate by project (last ${days}d):`);
  out(
    `  funnel = lifetime injected→cited (citation_log, GC-durable = honest) · surviving = cited/decay over in-window non-GC'd obs (survivorship-biased, reads high):`,
  );
  for (const r of perProject) {
    const funnelRate =
      r.funnel_injected > 0 ? ((r.funnel_cited * 100) / r.funnel_injected).toFixed(1) + '%' : '—';
    const survRate = r.resolved > 0 ? ((r.cited * 100) / r.resolved).toFixed(1) + '%' : '—';
    out(
      `  ${r.project.padEnd(30)} funnel ${String(funnelRate).padStart(6)} (${r.funnel_cited}/${r.funnel_injected}) · surviving ${String(survRate).padStart(6)} (${r.cited}/${r.resolved}) · at_risk:${r.at_risk}`,
    );
  }
  out('');

  // R1: invocation→cite funnel — per-session trend + window-vs-prior direction.
  out(`Invocation→cite funnel (recent sessions, injected→cited; rate window ${days}d):`);
  if (funnel.sessions.length === 0) {
    out('  (no resolved sessions in window)');
  } else {
    for (const s of funnel.sessions) {
      const day = s.resolved_at ? new Date(s.resolved_at).toISOString().slice(0, 10) : '—'.repeat(10);
      const pct = (s.rate * 100).toFixed(1) + '%';
      out(
        `  ${day}  ${(s.project || '').padEnd(28)} inj ${String(s.injected_n).padStart(3)}  cited ${String(s.cited_n).padStart(3)}  ${pct.padStart(6)}`,
      );
    }
  }
  let trendLine = `window rate ${(funnel.window.rate * 100).toFixed(1)}%  cited ${funnel.window.cited}/${funnel.window.injected}`;
  if (funnel.delta_pt === null) {
    trendLine += '  (no prior-window data)';
  } else {
    const arrow = funnel.delta_pt > 0 ? '↑' : funnel.delta_pt < 0 ? '↓' : '→';
    const sign = funnel.delta_pt > 0 ? '+' : '';
    trendLine += `  (prior ${days}d ${(funnel.prior.rate * 100).toFixed(1)}%)  ${arrow} ${sign}${funnel.delta_pt}pt`;
  }
  out(trendLine);
  out('');

  // v45: the same funnel split by INJECTION FACE. The aggregate above says
  // whether effectiveness is rising; this says WHICH face to aim a lever at.
  out(`Cite rate by injection face (last ${days}d):`);
  out(
    '  a per-face VIEW, not a partition — do NOT reconcile against the funnel above: faces overlap (an obs carried by two counts in both) and the funnel also counts cite-back signals that belong to no face:',
  );
  if (surfaceFunnel.unavailable) {
    // The read FAILED — a missing/unreadable citation_surface_log. Pre-b4 this
    // rendered identically to an empty window, so the #10650 shape (table never
    // created, `no such table` swallowed into the debug log) read as "no data
    // yet" for as long as the surface stayed unmetered.
    out(`  (UNAVAILABLE — the per-face table could not be read: ${surfaceFunnel.unavailable})`);
    out('  this is a failure, not an empty window: run `claude-mem-lite fts-check` to repair the schema');
  } else if (surfaceFunnel.surfaces.length === 0) {
    out('  (no rows in this window yet — rows accrue at Stop, one per injection face per session)');
  } else {
    for (const s of surfaceFunnel.surfaces) {
      const pct = (s.rate * 100).toFixed(1) + '%';
      // Which faces actually move importance is NOT readable from the rates —
      // and an annotated keyctx beside a bare `subagent` reads as "that one
      // does feed decay", which is false. Derived from the exported sets so
      // the note cannot drift from the behaviour it describes. (The example
      // used to name task_imperative; it joined the denominator on 2026-08-25
      // once its rate was read, leaving `subagent` as the bare non-decay face.)
      const note =
        s.surface === 'keyctx'
          ? '  (promotion-only: never demotes)'
          : DECAY_DENOMINATOR_SURFACES.includes(s.surface)
            ? ''
            : '  (metered only: outside the decay denominator)';
      out(
        `  ${SURFACE_LABELS[s.surface] || s.surface}  inj ${String(s.injected).padStart(4)}  cited ${String(s.cited).padStart(4)}  ${pct.padStart(6)}  over ${s.sessions} session(s)${note}`,
      );
    }
  }
  out('');
  out('Active decay queue (uncited_streak >= 2, next miss → rollover):');
  if (decayQueue.length === 0) out('  (none)');
  for (const r of decayQueue) {
    out(
      `  #${r.id} [${r.type}] ${(r.title || '').slice(0, 60)}   imp=${r.importance} streak=${r.uncited_streak}`,
    );
  }
  out('');
  out('Recently cited (cited_count >= 1, streak reset; importance unaffected):');
  if (promoted.length === 0) out('  (none)');
  for (const r of promoted) {
    out(`  #${r.id} [${r.type}] ${(r.title || '').slice(0, 60)}   cited ${r.cited_count}x`);
  }
  out('');
  // D#179/D#198: demoted_at now stamps the UNCITED-STREAK ROLLOVER, which no
  // longer lowers importance. The old label ("importance ↓") would describe a
  // write that stopped happening while the column beside it kept printing the
  // row's unchanged value — a caption contradicting its own table.
  out(`Recently rolled over (last ${days}d, uncited streak reset; importance unaffected):`);
  if (demoted.length === 0) out('  (none)');
  for (const r of demoted) {
    const ago = Math.round((Date.now() - r.demoted_at) / DAY_MS);
    out(`  #${r.id} [${r.type}] ${(r.title || '').slice(0, 60)}   imp=${r.importance}   ${ago}d ago`);
  }
}

// ─── Help ────────────────────────────────────────────────────────────────────

function cmdHelp() {
  out(`claude-mem-lite CLI

Commands:
  search <query>        FTS5 search across observations, sessions, and prompts
    --query Q           Query as a flag (alias for the positional; use one, not both)
    --source S          Table: observations|sessions|prompts|events (default: all)
    --type T            Filter obs type (bugfix|decision|discovery|feature|refactor|change)
    --limit N           Max results (default 20)
    --project P         Filter by project
    --from DATE         Start date (YYYY-MM-DD or ISO 8601)
    --to DATE           End date (YYYY-MM-DD or ISO 8601)
    --since DUR         Relative lower bound: 7d|24h|90m|2w|30s (ignored if --from set)
    --importance N      Minimum importance (1=routine, 2=notable, 3=critical)
    --deep              Opt-in LLM multi-query / HyDE deep search (observations only).
                        One extra model call plus N hybrid searches — the explicit
                        "search harder" lever for vocabulary-mismatch misses.
    --no-deep           Force normal search, overriding any env/default that enables deep
    --rerank            LLM-rerank the fused top 20. Requires --deep; ignored without it
    --branch B          Filter by git branch
    --offset N          Skip first N results (pagination)
    --tier T            Filter by tier (working|active|archive, observations only)
    --sort S            Sort: relevance (default), time, importance
    --or                Use OR instead of AND between search terms
    --include-noise     Include hook-llm fallback titles ("Modified X", raw error logs)
    --json              Output as JSON: {query,total,returned,offset,limit,results:[…]}

  recent [N]            Show N most recent observations (default 10)
    --limit N           Sibling-parity alias for [N] (max 1000)
    --since DUR         Only items newer than a relative window: 7d|24h|90m|2w|30s
    --project P         Filter by project
    --type T            Filter obs type (bugfix|decision|discovery|feature|refactor|change)
    --json              Output as JSON: {project,limit,type,total,results:[…]}

  recall <file>         Show observations related to a file
    --file F            File as a flag (alias for the positional)
    --limit N           Max results (default 10)
    --include-noise     Include hook-llm fallback titles ("Modified X", raw error logs)
    --json              Output as JSON: {file,limit,include_noise,total,results:[…]}

  get <id1,id2,...>     Get full details by ID
    IDs accept search-output prefixes: #123 (obs), P#123 (prompt), S#123 (session),
    D#123 (deferred item — FULL detail; defer list is title-only).
    Bare N defaults to obs. Mixed prefixes in one call route each token correctly.
    --ids 1,2           IDs as a flag (alias for the positional list)
    --source S          Force record type (obs|session|prompt|event); overrides prefixes
                        (D# tokens exempt — they always read deferred_work).
    --fields f1,f2,...  Select specific fields to return (observations only).

  timeline              Show observations around an anchor (shows recent if no anchor)
    --anchor ID         Center on this ID. Accepts N, #N, P#N, S#N or E#N — P#/S#/E#
                        anchors resolve to the nearest-in-time observation in the
                        same project.
    --query "text"      Find anchor by FTS5 search. Ranks by BM25 × time-decay,
                        so multi-term queries surface the BEST topical match
                        (highest term coverage), not the most recent. For
                        "recent activity around X", use 'recent' or
                        'search "X" --sort time' instead.
    --before N          Show N before anchor (default 5)
    --after N           Show N after anchor (default 5)
    --project P         Filter by project
    --json              Output as JSON: {anchor,anchor_note,before:[…],after:[…]}
                        (or {anchor:null,fallback:"recent",results:[…]} when no anchor)

  save "<text>"         Save a new observation
    --text T            Content as a flag (alias for the positional; use one, not both)
    --content T         Same alias under the MCP mem_save field name
    --type T            Observation type (default: discovery)
    --title T           Title (auto-generated if omitted)
    --importance N      1=routine, 2=notable, 3=critical (default: 2)
    --project P         Project name
    --files f1,f2       Comma-separated file paths
    --lesson T          Lesson learned (≤500 chars; alias: --lesson-learned)
    --closes-deferred 1,D#42  Close deferred items in same transaction

  defer <action>        First-class deferred work (v2.70+)
    add "<title>"       Mark deferred work for next session (≤200 chars)
      --title T         Title as a flag (alias for the positional)
      --priority N      1=low, 2=normal, 3=urgent (default: 2)
      --detail T        Constraint + why deferred
      --files f1,f2     Comma-separated file paths
      --project P       Project name
    list                List open deferred items (title-only; full detail via get D#N)
      --limit N         Max results (default 10)
      --project P       Filter by project
    drop <D#N|ordinal>[,...]  Drop one or more deferred items (no fix needed)
      --id D#N          ID as a flag (alias for the positional)
      --reason "..."    Required audit trail
      --project P       Project for ordinal resolution (default: current; must
                        match the "defer list --project P" you read ordinals from)

  delete <id1,id2,...>  Delete observations by ID
    --ids 1,2           IDs as a flag (alias for the positional list)
    --confirm           Execute deletion (preview by default)

  update <id>           Update an existing observation
    --id N              ID as a flag (alias for the positional)
    --title T           New title
    --type T            New type
    --importance N      New importance (1=routine, 2=notable, 3=critical)
    --lesson T          Add/update lesson learned (alias: --lesson-learned)
    --narrative T       New narrative
    --concepts T        Space-separated concept tags

  export                Export observations as JSON/JSONL (complete backup by default)
    --project P         Filter by project
    --type T            Filter by type
    --format F          json (default) or jsonl
    --from DATE         Start date
    --to DATE           End date
    --include-compressed  Include compressed observations
    --limit N           Cap output at N rows (default: export ALL matching rows)
  restore <file>        Restore observations from an export file (JSON/JSONL)
    --project P         Override the restored project for every row
    --dry-run           Preview what would be restored without writing

  compress              Compress old low-value observations
    --execute           Execute compression (preview by default)
    --age-days N        Min age in days (default 30)
    --project P         Filter by project

  maintain <scan|execute>  Memory maintenance
    --ops O             Comma-separated: cleanup,decay,boost,demote_pinned,dedup,purge_stale,rebuild_vectors,vacuum
                        Default when omitted: cleanup,decay,boost,demote_pinned (in that order)
    --merge-ids K:R,... For dedup: keepId:removeId pairs (e.g. 10:11,20:21:22)
    --project P         Filter by project
    --retain-days N     For purge_stale: keep last N days (default 30)
                        demote_pinned: floors importance for inj>=${PINNED_INJ_THRESHOLD} & cited=0 — to 1 with no
                        lesson_learned, to 2 with one (clears pinned noise; a lesson-bearing
                        row keeps eligibility on every importance>=2 injection face).
                        In the default set since v3.76.0; runs AFTER boost, which would
                        otherwise hand the row straight back. Opt out of the DEFAULT with
                        CLAUDE_MEM_SKIP_DEMOTE_PINNED=1 — an explicit --ops demote_pinned
                        still runs.
                        vacuum: reclaim freelist dead space (whole-DB, ignores --project)

  optimize              LLM-powered memory optimization (preview by default)
    --run               Execute (default: preview gates)
    --run-all           Execute bypassing gates
    --task T            Comma-separated: re-enrich,normalize,cluster-merge,smart-compress
    --max N             Max items per task (1-100, default 15)
    --scope S           re-enrich scope: narrow (default) | wide | aliases | scopes
                        (aliases: backfill search_aliases on substantive rows that
                         lack them — incl. lesson-bearing manual saves — adds ONLY
                         aliases, never rewrites title/narrative/lesson)
                        (scopes: backfill the applicability label observations.scope
                         on rows that lack it — writes ONLY that column, never stamps
                         optimized_at; feeds CLAUDE_MEM_SCOPE_FILTER)
    --project P         Limit to a single project (.|current = the current project)
    --verbose / -v      Preview also dumps cluster contents + re-enrich samples

  doctor                Environment diagnostics and benchmarks
    --benchmark         Run perf benchmark and emit JSON
    --metrics           Summarize the recorded metrics window (CLAUDE_MEM_METRICS=1)
    --session-audit     Audit session/episode state for orphans and drift
    --json              Machine-readable output (plain doctor run)

  fts-check <check|rebuild>  FTS5 index check or rebuild
                        Exit 0 when every index is healthy / rebuilt, 1 otherwise —
                        so "fts-check rebuild && <next step>" is safe to chain.

  stats                 Show memory statistics
    --project P         Filter by project
    --days N            Lookback window (default 30)
    --quality           Quality dashboard: lesson rate, LOW_SIGNAL rate, per-type
                        hit/lesson %, top-accessed lessons, R-2 watchdog targets
    --json              Output as JSON: nested by section
                        ({totals,recent,type_distribution,top_projects,
                          daily_activity,data_health,tier_distribution})
                        or quality shape when --quality --json combined

  context               Show current CLAUDE.md context block
    --json              Output as structured JSON

  browse                Tier-grouped memory dashboard
    --tier T            Filter: working|active|archive
    --project P         Filter by project
    --limit N           Max entries per tier (default 5)
    --json              Output as JSON: {project,limit,tier_filter,
                          totals:{working,active,archive,grand_total},
                          tiers:{working:{count,results:[…]}, …}}

  citation-stats        Citation-decay feedback loop telemetry
    --days N            Cite-rate window in days (default 7)
    --json              Output as JSON: {window_days,per_project:[],decay_queue:[],promoted:[]}

  import-jsonl <file-or-dir>      Import Claude Code JSONL transcripts (cold-start backfill)
    --project P         Project name (default: inferred from cwd)

  activity <action>     Non-memdir event log (v2.31) — bugfix/lesson/bug/discovery/etc.
    save --type T "<title>" [--body "<text>"] [--files f1,f2] [--file path] [--importance 1-3] [--project P]
    search "<query>"    Search events [--type T] [--limit N] [--project P]
    recent [N]          Most recent events [--type T] [--project P]
    show <id>           Show full event row by id
    delete <id1,id2,…>  Delete events by ID (preview by default; use --confirm to execute)
    promote             Promote insight-bearing events (body + importance>=2) to searchable
                        observations (preview by default; use --execute to apply)

    Valid types: bugfix, lesson, bug, discovery, refactor, feature, observation, decision
    --files (plural, comma-split) preferred; --file (singular) kept for back-compat.
    Use /lesson or /bug slash commands for faster capture (T8).

  adopt                 Write the claude-mem-lite managed block into this project's
                        CLAUDE.md + a plugin_claude_mem_lite.md detail doc under
                        .claude/ (loaded as project instructions). Runs automatically
                        on each SessionStart; use this to force it now.
    --all               Legacy sweep: strip old memory-dir (MEMORY.md) sentinels from
                        known projects. Does NOT adopt — CLAUDE.md adoption is
                        per-project, on each project's next SessionStart.
    --force             Overwrite a manually-edited managed block
    --dry-run           Print intended writes without touching disk
    --status            List adopted projects + version

  unadopt               Precise removal of the sentinel block + plugin_claude_mem_lite.md.
    --all               Unadopt every project
    --status            Read-only: list adopted projects (same as adopt --status)
    --dry-run           Preview what would be removed; no filesystem writes

  memdir-audit          Audit memdir feedback_*.md / project_*.md for the
                        body-structure contract (**Why:** + **How to apply:**).
                        Exit 0 if every file is compliant, 1 otherwise.
    --memdir <path>     Audit an explicit memdir path (escape hatch)
    --all               Audit every project under ~/.claude/projects/*/memory/

DB: ${DB_PATH}`);
}

// ─── Import (GitHub) ────────────────────────────────────────────────────────

async function cmdImportJsonl(db, argv) {
  const { positional, flags } = parseArgs(argv);
  const target = positional[0];
  if (!target) {
    fail('[mem] Usage: claude-mem-lite import-jsonl <file-or-dir> [--project <name>]');
    return;
  }

  // R10 P3-13: two defects in one line. A bare `--project` (no value) parses to boolean
  // `true`, which SQLite rejects at bind time with "SQLite3 can only bind numbers, strings…"
  // — a stack trace instead of a usage message. And unlike every other write command this
  // one never resolved the name, so `--project mem` imported under the literal string "mem"
  // while `save --project mem` wrote to `projects--mem`.
  if (flags.project !== undefined && typeof flags.project !== 'string') {
    fail('[mem] --project needs a name, e.g. --project my-repo');
    return;
  }
  const project = flags.project ? resolveProject(db, flags.project, { mode: 'write' }) : inferProject();
  const fs = await import('fs');
  const { join: pjoin, resolve } = await import('path');
  const abs = resolve(target);

  let files = [];
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    fail(`[mem] Cannot stat ${abs}: ${e.message}`);
    return;
  }

  if (st.isDirectory()) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = pjoin(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && p.endsWith('.jsonl')) files.push(p);
      }
    };
    walk(abs);
  } else {
    files = [abs];
  }

  if (files.length === 0) {
    out('[mem] No .jsonl files found.');
    return;
  }

  const { importJsonl } = await import('./lib/import-jsonl.mjs');
  let totalPrompts = 0,
    totalObs = 0,
    totalSkip = 0,
    totalOrphans = 0,
    totalRecognized = 0,
    errorCount = 0;
  for (const f of files) {
    // Per-file isolation: one unreadable file (EACCES, EBUSY, mid-batch IO error)
    // shouldn't crash the whole import — readFileSync inside importJsonl would
    // otherwise throw an unhandled exception with a node stack trace, leaving
    // earlier successes uncommitted-looking from the user's perspective.
    let r;
    try {
      r = await importJsonl(db, f, { project });
    } catch (e) {
      errorCount++;
      // e.message for node fs errors already begins with the code (e.g. "EACCES: permission denied, ...");
      // don't double-prefix.
      process.stderr.write(`[mem] ${f}: import failed — ${e.message}\n`);
      continue;
    }
    totalPrompts += r.prompts;
    totalObs += r.observations;
    totalSkip += r.skipped;
    totalOrphans += r.orphans || 0;
    totalRecognized += r.recognized || 0;
    out(
      `[mem] ${f}: +${r.prompts} prompts, +${r.observations} observations` +
        `${r.orphans ? ` (${r.orphans} from unpaired tool_use)` : ''}, ${r.skipped} skipped`,
    );
  }
  const errorTail = errorCount > 0 ? `, ${errorCount} file(s) errored` : '';
  out(
    `[mem] Total: ${totalPrompts} prompts, ${totalObs} observations` +
      `${totalOrphans ? ` (${totalOrphans} from unpaired tool_use)` : ''}` +
      `, ${totalSkip} skipped from ${files.length} file(s)${errorTail}.`,
  );
  if (totalPrompts > 0 || totalObs > 0) {
    // Orphan tool_use events persist as (truncated) observations and are counted INSIDE
    // totalObs (lib/import-jsonl.mjs), so they already count as "something was imported"
    // — an orphan-only first import must not fall through to the "already imported"
    // no-op branch below.
    out(`[mem] Try: claude-mem-lite recent 5 --project ${project}`);
  } else if (totalRecognized > 0) {
    // Lines WERE Claude Code transcript events but produced no new rows — the file
    // was already imported (idempotent re-run) or carried no extractable content.
    // Distinct from the wrong-shape case below: do NOT cry "wrong shape" at a valid
    // transcript the user successfully imported earlier (cold-start backfill re-runs
    // hit this on every already-ingested file).
    out(
      `[mem] Nothing new: ${totalRecognized} transcript event(s) already imported (re-running import-jsonl on the same transcript is a safe no-op).`,
    );
  } else if (totalSkip > 0 && errorCount === 0) {
    // No transcript event recognized at all — almost always the wrong file format
    // (import-jsonl ingests Claude Code transcript JSONL, not `export` output, which
    // is observation-shaped). Pre-fix this exited 0 with no signal, so pointing it at
    // the wrong file looked like success. Make the no-op explicit (stdout, like the
    // summary lines above).
    out(
      `[mem] Warning: 0 imported, ${totalSkip} line(s) skipped — none matched the expected Claude Code transcript JSONL shape (user/assistant/tool_result). 'export' output is NOT re-importable via import-jsonl.`,
    );
  }
}

// ─── Enrich ─────────────────────────────────────────────────────────────────

async function cmdOptimize(db, args) {
  // cmdOptimize parses flags positionally (args.indexOf('--task') + args[idx+1])
  // instead of the shared parseArgs, so the GNU `--flag=value` form silently
  // vanished: indexOf found no bare `--flag`, dropping the value with zero signal.
  // On the mutating --run path this was a real footgun — `optimize --run
  // --task=smart-compress --project=p --max=5` ran ALL tasks across ALL projects at
  // the default budget (tasks/project undefined → run-everything). Normalize
  // `--flag=value` into `--flag value` up front so both forms parse identically;
  // the `--execute=` special-case below already anticipated this for one flag.
  args = args.flatMap((a) => {
    const m = /^(--[a-z][a-z-]*)=([\s\S]*)$/.exec(a);
    return m ? [m[1], m[2]] : [a];
  });
  const run = args.includes('--run');
  const runAll = args.includes('--run-all');
  // Sibling-command flag footgun: optimize executes with --run (compress uses
  // --execute, maintain uses positional `execute`). A bare --execute previously fell
  // through to a silent preview, so the user thought they ran a mutation but didn't.
  // Catch both `--execute` and the `--execute=value` form (the latter slipped a bare
  // `args.includes('--execute')` and fell through to a silent preview — review minor).
  const hasExecuteFlag = args.some((a) => a === '--execute' || a.startsWith('--execute='));
  if (hasExecuteFlag && !run && !runAll) {
    fail(
      "[mem] optimize executes with --run, not --execute (--execute is compress's flag). Re-run: claude-mem-lite optimize --run",
    );
    return;
  }
  const verbose = args.includes('--verbose') || args.includes('-v');
  // T2-P1-D: --task accepts a single task or a comma-separated list, parity with MCP memOptimizeSchema.tasks.
  const VALID_TASKS = ['re-enrich', 'normalize', 'cluster-merge', 'smart-compress'];
  const taskIdx = args.indexOf('--task');
  let tasks;
  // R10 P3-15: a trailing bare `--task` used to fall through to "no filter" and run all
  // four tasks — the opposite of what someone typing --task wants, and each task is LLM
  // calls. Same treatment --max and --scope already get.
  if (taskIdx >= 0 && (args[taskIdx + 1] === undefined || args[taskIdx + 1].startsWith('--'))) {
    fail(`[mem] --task needs a value. One or more of: ${VALID_TASKS.join(', ')}`);
    return;
  }
  if (taskIdx >= 0 && args[taskIdx + 1]) {
    const parsed = args[taskIdx + 1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const invalid = parsed.filter((t) => !VALID_TASKS.includes(t));
    if (invalid.length > 0) {
      fail(`[mem] Unknown task(s): ${invalid.join(', ')}. Valid: ${VALID_TASKS.join(', ')}`);
      return;
    }
    tasks = parsed;
  }
  // T2-P1-C: reject --max 0 / --max <non-positive> / --max <non-number> explicitly — the old
  // `|| 15` fallback silently turned these into the default (15), burning LLM tokens.
  const maxIdx = args.indexOf('--max');
  let maxItems = 15;
  if (maxIdx >= 0) {
    const raw = args[maxIdx + 1];
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
      fail(`[mem] Invalid --max "${raw}". Must be an integer between 1 and 100.`);
      return;
    }
    maxItems = parsed;
  }
  // R-7 micro: --scope wide targets bugfix/refactor/feature/decision with narrative but no
  // lesson_learned (the "Haiku judged 'none'" cases). Default 'narrow' preserves old behavior.
  // Validate explicitly so `--scope wlde` (typo) doesn't silently become narrow and waste an LLM run.
  const scopeIdx = args.indexOf('--scope');
  let reenrichScope = 'narrow';
  if (scopeIdx >= 0 && args[scopeIdx + 1] !== undefined) {
    const raw = args[scopeIdx + 1];
    if (raw !== 'narrow' && raw !== 'wide' && raw !== 'aliases' && raw !== 'scopes') {
      fail(`[mem] Invalid --scope "${raw}". Use: narrow, wide, aliases, scopes`);
      return;
    }
    reenrichScope = raw;
  }
  // --project <name> filters all 4 tasks to one project. Opt-in; absence
  // preserves prior cross-project default. `.` or `current` auto-resolve via
  // the CLI project resolver so users don't need to remember the exact name.
  const projectIdx = args.indexOf('--project');
  let project;
  if (projectIdx >= 0 && args[projectIdx + 1]) {
    const raw = args[projectIdx + 1];
    // R10 P3-14: resolve like every other project-scoped command. optimize was the one
    // twin that took the raw string, so `--project api` matched 0 candidates while
    // `save --project api` in the same process resolved to `mono--api-gateway`. Read mode:
    // this selects rows to work on, it does not decide where a new row is filed.
    project = raw === '.' || raw === 'current' ? cliProject(db) : resolveProject(db, raw) || raw;
  }

  if (!run && !runAll) {
    const preview = optimizePreview(db, { project, detail: verbose });
    out('[mem] 🔍 LLM Optimization Preview:');
    if (project) out(`  Project filter: ${project}`);
    out(
      `  Re-enrich candidates: ${preview.reenrich}${preview.reenrichWide !== undefined && preview.reenrichWide !== null ? `  (wide scope: ${preview.reenrichWide})` : ''}${preview.reenrichAliases ? `  (aliases scope: ${preview.reenrichAliases})` : ''}${preview.reenrichScopes ? `  (scopes scope: ${preview.reenrichScopes})` : ''}`,
    );
    out(
      `  Normalize: ${preview.normalizeGateOpen ? `${preview.normalize} unique concepts` : 'gate closed (7-day interval)'}`,
    );
    // "candidates" matches the MCP wording (server.mjs mem_optimize preview) AND the
    // Re-enrich line just above, which already read that way on both surfaces. The two
    // surfaces render one optimizePreview() result — tests/audit-findings-20260814.test.mjs
    // drives both and compares the label lists, so the drift cannot reopen.
    out(`  Cluster-merge candidates: ${preview.clusterMerge} clusters`);
    out(`  Smart-compress candidates: ${preview.smartCompress} clusters`);
    out(`  Total: ${preview.total} items`);
    if (verbose) {
      out('');
      if (preview.mergeClusters && preview.mergeClusters.length > 0) {
        out('─── Cluster-merge details ───');
        for (const [i, cluster] of preview.mergeClusters.entries()) {
          out(`  Cluster ${i + 1} (${cluster.length} obs, project=${cluster[0]?.project || '?'}):`);
          for (const obs of cluster)
            out(`    #${obs.id} [${obs.type || 'change'}] ${truncate(obs.title || '(untitled)', 100)}`);
        }
      }
      if (preview.reenrichSamples && preview.reenrichSamples.length > 0) {
        out('─── Re-enrich sample (first 20) ───');
        for (const obs of preview.reenrichSamples) {
          out(
            `  #${obs.id} [${obs.type || 'change'}] (project=${obs.project || '?'}) ${truncate(obs.title || '(untitled)', 100)}`,
          );
        }
      }
      if (preview.compressSamples && preview.compressSamples.length > 0) {
        out('─── Smart-compress sample (first 5 clusters) ───');
        for (const [i, cluster] of preview.compressSamples.entries()) {
          out(
            `  Cluster ${i + 1} (${cluster.observations?.length || 0} obs, project=${cluster.project || '?'})`,
          );
        }
      }
    }
    out('');
    out('Run with --run to execute, --run-all to bypass gates.');
    out('For R-7 backfill: --run --task re-enrich --scope wide --max N');
    out('Scope: --project <name|.|current> to limit; --verbose for cluster details.');
    return;
  }

  out(
    `[mem] Running LLM optimization${reenrichScope !== 'narrow' ? ` (scope: ${reenrichScope})` : ''}${project ? ` (project: ${project})` : ''}...`,
  );
  const results = await optimizeRun(db, { tasks, maxItems, force: runAll, reenrichScope, project });

  if (results.reenrich)
    out(
      `  Re-enrich: ${results.reenrich.processed || 0} processed, ${results.reenrich.skipped || 0} skipped`,
    );
  if (results.normalize) {
    if (results.normalize.skipped) out(`  Normalize: skipped (${results.normalize.reason})`);
    else
      out(
        `  Normalize: ${results.normalize.processed || 0} updated, ${results.normalize.groups || 0} synonym groups`,
      );
  }
  if (results.clusterMerge)
    out(
      `  Cluster-merge: ${results.clusterMerge.merged || 0} merged of ${results.clusterMerge.processed || 0} clusters`,
    );
  if (results.smartCompress)
    out(
      `  Smart-compress: ${results.smartCompress.compressed || 0} compressed of ${results.smartCompress.processed || 0} clusters`,
    );
}

// cmdDoctor extracted to cli/doctor.mjs (v2.41 split).
import { cmdDoctor } from './cli/doctor.mjs';

// cmdActivity (T7 v2.31) extracted to cli/activity.mjs (v2.41 split).
import { cmdActivity } from './cli/activity.mjs';

import { DAY_MS } from './lib/time-constants.mjs';
// ─── Main Entry Point ────────────────────────────────────────────────────────

export async function run(argv) {
  const cmd = argv[0];
  const cmdArgs = argv.slice(1);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    cmdHelp();
    return;
  }

  // Support `<cmd> --help` or `<cmd> -h` for any subcommand
  if (cmdArgs.includes('--help') || cmdArgs.includes('-h')) {
    cmdHelp();
    return;
  }

  // Typo guard: parseArgs silently DROPS unknown flags, so `save --improtance 3` used to
  // persist the DEFAULT importance and `recent --projcte X` silently queried the inferred
  // project — a misspelled flag changed results with zero signal. Warn (stderr, non-fatal)
  // when a flag looks like a misspelling of a real one; stdout + exit code stay untouched,
  // so JSON/text consumers are unaffected. Mirrors the unknown-COMMAND suggester in cli.mjs.
  for (const { flag, suggestion } of suggestUnknownFlags(parseArgs(cmdArgs).flags)) {
    process.stderr.write(
      suggestion
        ? `[mem] Unknown flag --${flag}; did you mean --${suggestion}?\n`
        : `[mem] Unknown flag --${flag} — ignored, it had no effect. Run "claude-mem-lite help" for this command's flags.\n`,
    );
  }

  // adopt / unadopt do pure filesystem work on ~/.claude/projects/<encoded>/memory/ —
  // no DB needed. Route them before the DB open so an unbootable DB doesn't block.
  if (cmd === 'adopt') {
    cmdAdopt(cmdArgs);
    return;
  }
  if (cmd === 'unadopt') {
    cmdUnadopt(cmdArgs);
    return;
  }
  if (cmd === 'memdir-audit') {
    cmdMemdirAudit(cmdArgs);
    return;
  }

  let db;
  try {
    // Corruption-gated WAL recovery (shared with server/hooks) — a corrupt WAL
    // previously threw here with no auto-repair until the next MCP start.
    db = ensureDbWithWalRecovery({ warn: (m) => process.stderr.write(`[mem] ${m}\n`) });
  } catch (e) {
    // A Node upgrade leaves better_sqlite3.node compiled for the old ABI, and
    // every DB-touching path fails at once. Pre-v3.60 this printed the raw
    // multi-line NODE_MODULE_VERSION error with no repair named, and the only
    // healer was an MCP server start the user might never perform — the shape of
    // the 4-day outage on 2026-08-13. Heal in place, then RE-EXEC: this process
    // has already dlopen'd the stale binary, so it cannot use the new one.
    if (isNativeBindingError(e)) {
      const healed = await healAndReexec({
        // Delegate the actual rebuild to `cli.mjs rebuild-binding` so there is
        // ONE healer: it takes install.lock, resolves which node_modules tree
        // the running code uses, and clears the hooks' breakage marker.
        ensure: async () => {
          // Child stdout is DISCARDED, not inherited: install.mjs logs progress
          // to stdout, and this CLI's stdout is a data channel (`search --json`
          // is piped into jq). Progress still reaches the user via stderr.
          const r = spawnSync(process.execPath, [CLI_PATH, 'rebuild-binding'], {
            stdio: ['ignore', 'ignore', 'inherit'],
            timeout: 300_000,
          });
          return r.status === 0
            ? { ok: true, action: 'rebuilt' }
            : { ok: false, error: `rebuild-binding exited ${r.status ?? 'on signal'}` };
        },
        log: (m) => process.stderr.write(`[mem] ${m}\n`),
      });
      if (healed.healed) {
        process.exitCode = healed.exitCode;
        return;
      }
      out(
        `[mem] Error: native DB binding unusable on Node ${process.version}${healed.error ? ` — ${healed.error}` : ''}`,
      );
      out(`[mem] Fix: ${CLI_INVOKE} rebuild-binding`);
      process.exitCode = 1;
      return;
    }
    out(`[mem] Error: Cannot open database: ${e.message}`);
    out(`[mem] DB path: ${DB_PATH}`);
    process.exitCode = 1;
    return;
  }

  // --json contract surfacing: only `search` and `context` actually emit JSON;
  // historically `recent --json | jq` etc. silently produced text, breaking
  // automation. Emit a one-line stderr note when --json is passed to a command
  // that doesn't honor it. Stdout output and exit code are unchanged so existing
  // text-parsing callers keep working — the note lives in stderr for scripts to
  // detect the gap.
  const JSON_SUPPORTED_CMDS = new Set([
    'search',
    'context',
    'recent',
    'recall',
    'timeline',
    'stats',
    'browse',
    'export',
    'citation-stats',
  ]);
  // Suppress the note on subpaths that DO emit JSON, so it never FALSELY tells a script
  // "outputs text" while writing valid JSON to stdout — a false note is worse than a
  // missing one (it makes the consumer skip a parse that would have succeeded). doctor
  // emits JSON for --benchmark / --metrics / --session-audit; activity's show/save emit
  // JSON. Without those sub-flags, doctor is text and the note stays useful.
  const jsonCapableSubpath =
    (cmd === 'doctor' &&
      (cmdArgs.includes('--benchmark') ||
        cmdArgs.includes('--metrics') ||
        cmdArgs.includes('--session-audit'))) ||
    cmd === 'activity';
  if (cmdArgs.includes('--json') && !JSON_SUPPORTED_CMDS.has(cmd) && !jsonCapableSubpath) {
    process.stderr.write(
      `[mem] Note: --json is supported only on: ${[...JSON_SUPPORTED_CMDS].join(', ')}. "${cmd}" outputs text.\n`,
    );
  }

  try {
    switch (cmd) {
      case 'search':
        await cmdSearch(db, cmdArgs);
        break;
      case 'recent':
        cmdRecent(db, cmdArgs);
        break;
      case 'recall':
        cmdRecall(db, cmdArgs);
        break;
      case 'get':
        cmdGet(db, cmdArgs);
        break;
      case 'timeline':
        cmdTimeline(db, cmdArgs);
        break;
      case 'save':
        cmdSave(db, cmdArgs);
        break;
      case 'defer':
        cmdDefer(db, cmdArgs);
        break;
      case 'delete':
        cmdDelete(db, cmdArgs);
        break;
      case 'update':
        cmdUpdate(db, cmdArgs);
        break;
      case 'export':
        cmdExport(db, cmdArgs);
        break;
      case 'restore':
        cmdRestore(db, cmdArgs);
        break;
      case 'compress':
        cmdCompress(db, cmdArgs);
        break;
      case 'maintain':
        cmdMaintain(db, cmdArgs);
        break;
      case 'optimize':
        await cmdOptimize(db, cmdArgs);
        break;
      case 'fts-check':
        cmdFtsCheck(db, cmdArgs);
        break;
      case 'stats':
        await cmdStats(db, cmdArgs);
        break;
      case 'context':
        cmdContext(db, cmdArgs);
        break;
      case 'browse':
        cmdBrowse(db, cmdArgs);
        break;
      case 'citation-stats':
        cmdCitationStats(db, cmdArgs);
        break;
      case 'import-jsonl':
        await cmdImportJsonl(db, cmdArgs);
        break;
      case 'doctor':
        await cmdDoctor(db, cmdArgs);
        break;
      case 'activity':
        await cmdActivity(db, cmdArgs);
        break;
      default:
        out(`[mem] Unknown command: ${cmd}`);
        out('[mem] Run "claude-mem-lite help" for usage');
        process.exitCode = 1;
    }
  } catch (e) {
    // SQLITE_BUSY / SQLITE_LOCKED + extended variants (SQLITE_BUSY_SNAPSHOT,
    // SQLITE_BUSY_RECOVERY, SQLITE_LOCKED_SHAREDCACHE…). All mean the same thing
    // to the user: writer contention past the 5s busy_timeout. Pre-fix this
    // raised an unhandled SqliteError with a node stack trace.
    const code = e && typeof e.code === 'string' ? e.code : '';
    if (
      code === 'SQLITE_BUSY' ||
      code === 'SQLITE_LOCKED' ||
      code.startsWith('SQLITE_BUSY_') ||
      code.startsWith('SQLITE_LOCKED_')
    ) {
      process.stderr.write(
        `[mem] Database busy — another process held the writer past the 5s timeout. Retry shortly.\n`,
      );
      process.exitCode = 1;
      return;
    }
    // R10 P3-17: everything else used to be re-thrown, so the terminal — and, when the
    // agent runs the CLI, the model's context — got a raw Node stack trace. Print the
    // message, keep the stack behind CLAUDE_MEM_DEBUG for whoever is actually debugging.
    process.stderr.write(`[mem] ${cmd || 'command'} failed: ${(e && e.message) || e}\n`);
    if (process.env.CLAUDE_MEM_DEBUG) process.stderr.write(`${(e && e.stack) || ''}\n`);
    process.exitCode = 1;
  } finally {
    try {
      db.close();
    } catch {}
  }
}
