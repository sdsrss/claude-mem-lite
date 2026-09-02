#!/usr/bin/env node
// claude-mem-lite MCP Server — All-in-one memory system
// FTS5 search, zero LLM calls, single process

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { truncate, typeIcon, inferProject, fmtDate, debugLog, debugCatch, isPathConfined } from './utils.mjs';
import { resolveProject as _resolveProjectShared } from './project-utils.mjs';
import { ensureDbWithWalRecovery, DB_PATH, DB_DIR, REGISTRY_DB_PATH } from './schema.mjs';
import { reRankWithContext, runIdleCleanup, buildServerInstructions } from './search-scoring.mjs';
import { searchObservationsHybrid } from './search-engine.mjs';
import { deepSearch, resolveDeepMode, shouldEscalateToDeep, autoDeepLlmReady } from './deep-search.mjs';
import { selectCompressionCandidates, groupByProjectWeek, compressGroup } from './lib/compress-core.mjs';
import { resolveAnchorToken, formatAnchorError, resolveQueryAnchor, fetchRecentTimeline, fetchTimelineWindow } from './lib/timeline-core.mjs';
import { buildSearchFtsQuery, parseDateBounds, parseDuration, coreRunSearchPipeline } from './lib/search-core.mjs';
import {
  cleanupBroken, decayAndMarkIdle, boostAccessed, demotePinned, mergeDuplicates,
  recoverOrphanedChildren, recoverBuriedLessons, sweepDeferredWorkOrphans,
  purgeStale, purgeStalePreview, findDuplicates, maintenanceStats, rebuildVectors, vacuum,
  hardDeleteCandidateCount,
  OP_CAP, STALE_AGE_MS, resolveDefaultMaintainOps, DEFAULT_MAINTAIN_OPS,
} from './lib/maintain-core.mjs';
import { snapshotDb } from './lib/db-backup.mjs';
import { deleteObservations, previewDeleteRows } from './lib/delete-core.mjs';
import { fetchObsDetail, fetchPromptDetail, fetchEventDetail, OBS_FIELDS, SESSION_DETAIL_FIELDS, PROMPT_DETAIL_FIELDS, EVENT_DETAIL_FIELDS, supersededNotice } from './lib/get-core.mjs';
import { collectBrowseTiers, getActiveMemorySessionId, BROWSE_TIERS, BROWSE_TIER_LABELS } from './lib/browse-core.mjs';
import { effectiveQuiet, RUNTIME_DIR } from './hook-shared.mjs';
import { computeStatsFeed } from './lib/stats-core.mjs';
import { buildLessonNudge } from './lib/save-nudge.mjs';
import { formatObsFieldValue, obsFieldLabel, formatPendingPurgeLine } from './cli/common.mjs';
// The partial-export warning points the caller at the CLI twin, which exports the complete
// set by default — the invocation has to be the one that actually works on this install.
import { CLI_INVOKE } from './cli-path.mjs';
import { neutralizeContextDelimiters, neutralizeSkillDelimiters } from './format-utils.mjs';
import { memSearchSchema, memRecentSchema, memTimelineSchema, memGetSchema, memDeleteSchema, memSaveSchema, memStatsSchema, memCompressSchema, memMaintainSchema, memOptimizeSchema, memUpdateSchema, memExportSchema, memRecallSchema, memFtsCheckSchema, memRegistrySchema, memBrowseSchema, memUseSchema, memDeferSchema, memDeferListSchema, memDeferDropSchema, tools as TOOL_DEFS } from './tool-schemas.mjs';

// Lookup helper: all user-facing tool descriptions live in tool-schemas.mjs
// (discouragement-style, Task 5). This keeps server.mjs from drifting.
const _toolDescByName = Object.fromEntries(TOOL_DEFS.map((t) => [t.name, t.description]));
function descriptionOf(name) {
  const d = _toolDescByName[name];
  if (!d) throw new Error(`tool-schemas.mjs is missing description for "${name}"`);
  return d;
}
import { optimizePreview, optimizeRun } from './hook-optimize.mjs';
import { join, sep } from 'path';
import { homedir } from 'os';
import { ensureRegistryDb, collectRegistryStats, listResourcesRanked, formatRegistryListLine } from './registry.mjs';
import { IMPORT_STRING_FIELDS, importResource, removeResource, reindexResources } from './lib/registry-core.mjs';
import { searchResources } from './registry-retriever.mjs';
import { probeOtherSources as probeIdSources, bucketIdTokens, splitDeferredTokens } from './lib/id-routing.mjs';
import { saveObservation } from './lib/save-observation.mjs';
import { applyObsUpdate } from './lib/observation-write.mjs';
import { EXPORT_COLUMNS_SQL } from './lib/export-columns.mjs';
import { liveObsFilterSql } from './lib/inject-search-core.mjs';
import { recallByFile } from './lib/recall-core.mjs';
import { fetchRecent } from './lib/recent-core.mjs';
import { AUTO_MERGE_THRESHOLD } from './lib/dedup-constants.mjs';
import {
  insertDeferred, listOpenWithOrdinal, dropDeferred, formatDropReasonHint,
  resolveDeferredIds, closeDeferredItems,
  getDeferredByIds, formatDeferredDetail,
  searchDeferredWork, formatDeferredSearchTrailer,
  formatDeferListRow, countStaleOpen, formatDeferStaleHint,
} from './lib/deferred-work.mjs';
import { shouldQueueSaveEnrich, queueSaveEnrich } from './lib/save-enrich.mjs';
import { _resetVocabCache } from './tfidf.mjs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('./package.json');

// ─── Database ───────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, chmodSync } from 'fs';

let db;
try {
  // Corruption-gated WAL recovery lives in schema.mjs (shared with hooks/CLI
  // since the D#8-adjacent P3 fix); the server keeps only its exit semantics.
  db = ensureDbWithWalRecovery({
    warn: (m) => debugLog('WARN', 'server', m),
    info: (m) => debugLog('INFO', 'server', m),
  });
} catch (err) {
  // Fatal: log and exit with descriptive message (Claude Code shows stderr)
  console.error(`[claude-mem-lite] FATAL: Database cannot be opened: ${err.message}`);
  if (err.walRecoveryAttempted) {
    console.error(`[claude-mem-lite] Try: rm "${DB_PATH}-wal" "${DB_PATH}-shm" or reinstall with: node install.mjs install`);
  } else {
    console.error(`[claude-mem-lite] Left WAL/SHM intact (not a corruption error). If this persists, retry or reinstall: node install.mjs install`);
  }
  process.exit(1);
}
// Server process uses longer busy_timeout for concurrent MCP requests
db.pragma('busy_timeout = 5000');

// ─── Registry Database (lazy-loaded on first mem_registry call) ─────────────

let registryDb = null;

function getRegistryDb() {
  if (registryDb) return registryDb;
  try {
    registryDb = ensureRegistryDb(REGISTRY_DB_PATH);
    registryDb.pragma('busy_timeout = 5000'); // match main DB + ensureRegistryDb (was 3000, overriding it back down)
  } catch (e) {
    debugLog('WARN', 'server', `Registry DB not available: ${e.message}`);
  }
  return registryDb;
}

// inferProject, typeIcon, truncate, fmtDate imported from utils.mjs

// ─── Project Name Resolution ────────────────────────────────────────────────
// Users naturally type short names like "mem" but inferProject() stores
// "projects--mem" (parent--base from CWD). resolveProject() bridges this gap.
// Implementation extracted to project-utils.mjs; local adapter closes over module-level `db`.

function resolveProject(name) { return _resolveProjectShared(db, name); }

// ─── Scoring Model Constants ────────────────────────────────────────────────
//
// Composite scoring: BM25(weights) × recency_decay × [project_boost] × [importance] × [access_bonus]
//
// BM25 column weights — higher weight = matches in that column score higher:
//   observations_fts:        title=10, subtitle=5, narrative=5, text=3, facts=3, concepts=2, lesson_learned=8
//   session_summaries_fts:   request=5, investigated=3, learned=3, completed=3, next_steps=2, notes=1, remaining_items=1
//
// Recency decay — exponential half-life:
//   factor = 1 + e^(-ln2 × age_ms / half_life_ms)
//   At age=0: 2.0 (full boost) → at half_life: 1.5 → at ∞: 1.0
//   0.693 = ln(2), ensures exact halving at each half-life interval
//
// Optional per-query modifiers:
//   Project boost: 2× for current project matches
//   Importance:    0.5 + 0.5 × importance (range 0.5–2.0)
//   Access bonus:  1 + 0.1 × ln(1 + access_count)

// Session/prompt FTS scoring (SESS_BM25 + recency decay) lives in lib/search-core.mjs.

// ─── MCP Server ─────────────────────────────────────────────────────────────

// Emit one-line instructions-mode trace on stderr so debugging the "why did
// the server send BASE instead of BASE+VERBOSE?" path doesn't require reading
// three files (server.mjs → hook-shared.mjs → memdir.mjs). CLAUDE_MEM_QUIET_TRACE=0
// opts out. stderr doesn't pollute the MCP stdio protocol channel.
const _quiet = effectiveQuiet();
if (process.env.CLAUDE_MEM_QUIET_TRACE !== '0') {
  const reason = process.env.MEM_QUIET_HOOKS === '1'
    ? 'env:MEM_QUIET_HOOKS=1'
    : _quiet ? 'adopted:steering' : 'none';
  const mode = _quiet ? 'BASE' : 'BASE+VERBOSE';
  process.stderr.write(`[mem] instructions: ${mode} reason=${reason}\n`);
}

const server = new McpServer(
  { name: 'mem-lite', version: PKG_VERSION },
  { instructions: buildServerInstructions(_quiet) },
);

// Track MCP request activity for idle-time cleanup (see idle timer below)
let lastMcpRequestTime = Date.now();
let idleCleanupRan = false;

/**
 * Defang structural context delimiters in every text block of a tools/call result.
 *
 * A tools/call payload IS model context — unlike CLI stdout there is no human between
 * the DB row and the transcript. Observations are stored raw on purpose (defense lives
 * at the injection boundary, not at save), and every HOOK surface already neutralizes
 * before writing to the model (buildSessionContextLines / formatMemoryLine /
 * formatErrorRecallHints / renderHandoffFromRow / pre-tool-recall). The MCP read tools
 * were the one model-facing family left raw, so a memory carrying a forged
 * `<system-reminder>` replayed verbatim into a mem_search result — reinstating exactly
 * the channel the hook-side defang closes. Applied at the single handler chokepoint so
 * a newly registered tool is covered by construction (§9 parallel-path completeness).
 *
 * Error payloads go through it too: `err.message` can echo caller-supplied text.
 *
 * @param {object} result Tool result ({ content: [{type,text}], … }).
 * @returns {object} Same shape with text blocks neutralized.
 */
/**
 * Fold CLI-flag aliases onto their canonical MCP field names.
 *
 * The schemas declare both spellings (see tool-schemas.mjs); this is where the alias
 * actually takes effect. Canonical wins when both are present — an explicit canonical
 * value is the more specific intent, and silently letting an alias override it would
 * reintroduce the same class of surprise the aliases exist to remove.
 *
 * @param {object} args Raw validated tool arguments.
 * @param {Record<string,string>} pairs alias → canonical field name.
 * @returns {object} New args object (never mutates the caller's).
 */
function applyArgAliases(args, pairs) {
  if (!args || typeof args !== 'object') return args;
  let next = args;
  for (const [alias, canonical] of Object.entries(pairs)) {
    if (next[alias] !== undefined && next[canonical] === undefined) {
      if (next === args) next = { ...args };
      next[canonical] = next[alias];
    }
  }
  return next;
}

function defangResult(result) {
  if (!result || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.map(c =>
      c && c.type === 'text' && typeof c.text === 'string'
        ? { ...c, text: neutralizeContextDelimiters(c.text) }
        : c
    ),
  };
}

/**
 * @param {Function} fn Tool handler.
 * @param {object} [opts]
 * @param {boolean} [opts.verbatim=false] Skip the defang pass. Only for payloads that
 *   must round-trip byte-exact — `mem_export` feeds `restore`, so neutralizing it would
 *   silently corrupt backups of any memory that legitimately discusses these tags.
 */
function safeHandler(fn, { verbatim = false } = {}) {
  return async (args, extra) => {
    try {
      lastMcpRequestTime = Date.now();
      idleCleanupRan = false;
      const result = await fn(args, extra);
      return verbatim ? result : defangResult(result);
    } catch (err) {
      return defangResult({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
    }
  };
}

// ─── Tool: mem_search — helper functions ────────────────────────────────────

// TYPE_DECAY_CASE imported from utils.mjs

// Score expression variants for FTS5 queries (see Scoring Model Constants above)
// Observation-search core (FTS query/params builders, hybrid pipeline) lives in
// search-engine.mjs so mem-cli.mjs gets the identical implementation.

// searchObservations / searchSessions / searchPrompts were consolidated into the
// shared coreRunSearchPipeline (lib/search-core.mjs). This surface is now a thin
// adapter (runSearchPipeline below); only output formatting stays local.
function formatSearchOutput(paginatedResults, args, ftsQuery, totalCount, orFallbackFired = false, isDeepSearch = false) {
  if (paginatedResults.length === 0) {
    const hint = [];
    if (isDeepSearch) {
      // Deep search runs even when the literal query sanitizes to empty, so the
      // "query was filtered" hint below would be misleading — the LLM rewrite ran
      // N variants and simply found nothing (F9).
      hint.push('No results — deep search rewrote the query into variants and still found nothing.');
      hint.push('This is a recall miss (the rewrite ran), not a query-syntax issue; the memory likely has no related observations.');
    } else if (args.query && !ftsQuery) {
      hint.push(`Query "${args.query}" was filtered (FTS5 keywords/special chars only).`);
      hint.push('Tip: use content words instead of operators (AND, OR, NOT, NEAR).');
    } else {
      hint.push('No results found.');
      if (args.query) {
        const expanded = ftsQuery || args.query;
        if (expanded !== args.query) hint.push(`Searched as: ${expanded}`);
        hint.push('Tip: check spelling, try broader terms, or use mem_stats to see available data.');
      }
    }
    return { content: [{ type: 'text', text: hint.join('\n') }] };
  }

  const lines = [];
  // "N of M" whenever the population exceeds the page — NOT gated on isCrossSource.
  // totalCount is the true limit/offset-invariant population (countSearchTotal), so
  // single-source searches (obs_type / type / importance filters) must surface it too.
  // The old isCrossSource gate predated countSearchTotal: back then single-source
  // totalCount was just results.length, so suppressing "of M" hid nothing. Now it hid
  // the real total, diverging from the CLI (mem-cli.mjs has no such gate). (#8217)
  const countLabel = totalCount > paginatedResults.length
    ? `${paginatedResults.length} of ${totalCount}`
    : `${paginatedResults.length}`;
  const hasMixed = paginatedResults.some(r => r.source === 'session' || r.source === 'prompt' || r.source === 'event');
  // P2-6: empty/omitted query falls through to a "listing recent" path — label it explicitly
  // so callers don't mistake BM25-less results for relevance-ranked ones.
  const qLabel = args.query ? ` for "${args.query}"` : ' (no query — listing recent)';
  // Surface AND→OR fallback so callers (incl. Claude) know a strict multi-term
  // query actually matched only a subset of the terms. Suppressed when the caller
  // explicitly requested OR semantics — there's no "fallback" in that path.
  const fallbackHint = orFallbackFired && !args.or ? ' (relaxed AND→OR)' : '';
  lines.push(`Found ${countLabel} result(s)${qLabel}${fallbackHint}:${hasMixed ? ' (# observation, S# session, P# prompt, E# event)' : ''}\n`);

  // `~Nt` = estimated tokens to fetch this row's full body via mem_get (attachBodyTokens).
  // Conditional so a result that skipped enrichment renders cleanly, not "~undefinedt".
  const tok = r => (r.bodyTokens ? ` ~${r.bodyTokens}t` : '');
  for (const r of paginatedResults) {
    if (r.source === 'obs') {
      lines.push(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || r.subtitle || '(untitled)')} | ${r.project} | ${fmtDate(r.date)}${tok(r)}`);
      if (r.snippet && r.snippet.length > 10 && r.snippet !== r.title) {
        lines.push(`     ${truncate(r.snippet, 100)}`);
      }
    } else if (r.source === 'session') {
      lines.push(`S#${r.id} 📋 ${truncate(r.request || r.completed || '(no summary)')} | ${r.project} | ${fmtDate(r.date)}${tok(r)}`);
    } else if (r.source === 'prompt') {
      lines.push(`P#${r.id} 💬 ${truncate(r.text)} | ${fmtDate(r.date)}${tok(r)}`);
    } else if (r.source === 'event') {
      lines.push(`E#${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || '(untitled)')} | ${r.project} | ${fmtDate(r.date)}${tok(r)}`);
    }
  }

  lines.push(`\nWorkflow: mem_timeline(anchor=ID) for context | mem_get(ids=[...]) for full details  ·  ~Nt = est. tokens to fetch full detail`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── Tool: mem_search ───────────────────────────────────────────────────────

// Exported for tests: runs the full mem_search pipeline against an explicit db
// with an optional injected llm (deepSearch dependency). The MCP tool handler
// calls this with the module db and the default llm.
// v3.42 F3: resolveProject now runs against the injected `db` param (not the module db), so
// a project: arg through this seam resolves against the TEST db — real test isolation.
export async function handleSearchForTest(db, args, { llm, rerankLlm } = {}) {
  return runSearchPipeline(db, args, { llm, rerankLlm });
}

async function runSearchPipeline(db, args, { llm, rerankLlm } = {}) {
  if (args.project) args = { ...args, project: _resolveProjectShared(db, args.project) };
  // CLI-flag aliases: --source/--from/--to/--since. Folded before any read of the
  // canonical names below, so every downstream filter sees them.
  args = applyArgAliases(args, { source: 'type', from: 'date_from', to: 'date_to', since: 'date_since' });

  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  // args.or: force OR from the start (CLI `search --or` parity). The default path
  // still does AND with the engine's OR-fallback when AND returns 0.
  const ftsQuery = buildSearchFtsQuery(args.query, { or: args.or });
  const currentProject = inferProject();

  const bounds = parseDateBounds(args.date_from, args.date_to, args.date_since);
  if (!bounds.ok) {
    if (bounds.bad === 'since') throw new Error(`Invalid date_since: "${bounds.value}" (use <N><unit>, e.g. 7d, 24h, 90m, 2w)`);
    throw new Error(`Invalid date_${bounds.bad}: "${bounds.value}" (use ISO 8601 or YYYY-MM-DD)`);
  }
  const { epochFrom, epochTo } = bounds;

  // MCP defaults to 'auto' (escalate on weak results) unless overridden by
  // args.deep or CLAUDE_MEM_AUTO_DEEP. Rerank is explicit-deep only (D#43).
  const deepMode = resolveDeepMode(args.deep, { surface: 'mcp' });
  const rerank = args.rerank === true && deepMode === 'deep';

  // P2: deferred trailer — open deferred items matching the query, appended to
  // the text blob AFTER (and never counted in) the main results/total. Parity
  // with CLI cmdSearch's emitDeferredTrailer; unfiltered first-page searches
  // only. Structured fields (results/total) stay untouched — the trailer is a
  // text affordance, not a result source.
  const wantDeferredTrailer = !args.type && !args.obs_type && !args.branch && !args.tier && !args.importance && offset === 0;
  const appendDeferredTrailer = (result) => {
    if (!wantDeferredTrailer) return result;
    try {
      const rows = searchDeferredWork(db, args.query || '', args.project || currentProject);
      const lines = formatDeferredSearchTrailer(rows, 'mem_get ids=["D#<id>"]');
      if (lines.length > 0 && result.content?.[0]?.type === 'text') {
        result.content[0].text += `\n\n${lines.join('\n')}`;
      }
    } catch { /* trailer is best-effort; never break search */ }
    return result;
  };

  // Early return when query was provided but sanitized to nothing (all FTS5
  // keywords/special chars). Skipped for deep/auto (the LLM rewrite may still
  // produce variants) and for filter-only listings (date/obs_type/importance).
  // A pure "D#92" query lands here — the trailer still reaches the item.
  if (args.query && !ftsQuery && !epochFrom && !epochTo && !args.obs_type && !args.importance && deepMode === 'normal') {
    return { ...appendDeferredTrailer(formatSearchOutput([], args, ftsQuery, 0)), escalated: false, results: [], total: 0, variants: null };
  }

  // Source scoping. deep is observations-only (deepSearch fuses hybrid-obs lists). branch/tier are
  // obs-EXCLUSIVE columns (sessions/prompts/events lack them) → force observations, else those legs
  // return UNFILTERED and leak rows that can't be scoped (the pre-fix cross-source branch/tier leak).
  // obs_type is DIFFERENT: events carry the same type vocabulary (events.event_type), so an obs_type
  // filter maps to obs + events both — scope to those two and skip the type-less sessions/prompts
  // legs (D#76). importance filters obs and events (both carry it), so it rides the obsTypeScoped path.
  let effectiveType;
  let obsTypeScoped = false;
  if (deepMode === 'deep') {
    effectiveType = 'observations';
  } else if (args.type) {
    effectiveType = args.type;
  } else if (args.obs_type && !args.branch && !args.tier) {
    effectiveType = undefined;   // cross-source gate open; obsTypeScoped narrows it to obs+events
    obsTypeScoped = true;
  } else if (args.importance || args.branch || args.tier) {
    effectiveType = 'observations';
  } else {
    effectiveType = undefined;
  }

  const r = await coreRunSearchPipeline(
    {
      db, currentProject, env: process.env,
      searchObservationsHybrid, deepSearch, shouldEscalateToDeep, autoDeepLlmReady,
      reRankWithContext, llm, rerankLlm,
    },
    {
      query: args.query, ftsQuery, effectiveSource: effectiveType, deepMode, rerank,
      limit, offset, project: args.project ?? null, obsType: args.obs_type ?? null,
      importance: args.importance ?? null, branch: args.branch ?? null,
      includeNoise: args.include_noise === true, epochFrom, epochTo,
      sort: args.sort || 'relevance', tier: args.tier ?? null,
      // ── MCP surface policy ──
      obsTypeScoped,                     // D#76: obs_type ⇒ obs+events (skip type-less sessions/prompts)
      obsTypeFallback: true,             // list-recent-by-type when 0 matches
      crossSourceEpochSortNoFts: true,   // epoch-sort cross-source with no ftsQuery
      rerankPolicy: 'mcp',               // (ftsQuery||isDeep) gate; re-rank/re-sort on ftsQuery&&!reranked
      rerankProject: currentProject,
      recentListingNoFts: true,          // recent-listing for explicit --source with no ftsQuery
      tolerateMissingFts: false,
      tierPosition: 'late',              // tier filter after re-rank
      tierProject: args.project || currentProject,
    }
  );

  // Observability: announce auto-escalation on stderr (parity with CLI deep note).
  if (r.escalated) process.stderr.write(`[mem] auto-escalated to deep search (weak results: ${r.escalatedObsCount} hits)\n`);

  const output = formatSearchOutput(r.page, args, ftsQuery, r.total, r.orFallbackFired, r.isDeep);
  // Surface the rewrite to the calling agent (F13) + the rerank signal (D#43).
  if (r.isDeep && r.variants && output.content?.[0]?.type === 'text') {
    output.content[0].text += r.variants.length > 1
      ? `\n\n[deep search: rewrote into ${r.variants.length} variants — ${r.variants.slice(1).map(v => JSON.stringify(v)).join(', ')}]`
      : '\n\n[deep search: rewrite produced no usable variants; searched the original query only (== baseline)]';
  }
  if (r.reranked && output.content?.[0]?.type === 'text') {
    output.content[0].text += '\n\n[deep search: LLM-reranked the top candidates by relevance]';
  }
  appendDeferredTrailer(output);

  // Expose structured fields for tests + the MCP content blob.
  return { ...output, results: r.page, total: r.total, escalated: r.escalated, variants: r.variants, reranked: r.reranked };
}

server.registerTool(
  'mem_search',
  {
    description: descriptionOf('mem_search'),
    inputSchema: memSearchSchema,
  },
  safeHandler(async (args) => {
    const result = await runSearchPipeline(db, args, {});
    return { content: result.content };
  })
);

// ─── Tool: mem_recent ────────────────────────────────────────────────────────

// In-process test seam (mirrors handleSearchForTest, #8743): threads an injected db through
// the SAME body the registered handler runs. v3.42 F3: a `project` arg now resolves against
// the injected db (not the module db), so :memory: test isolation is actually achieved.
export async function handleRecentForTest(db, args) {
  return runRecent(db, args);
}

async function runRecent(db, args) {
  // CLI-flag aliases: `recent --type` is the OBSERVATION type here, `--since` the window.
  args = applyArgAliases(args, { type: 'obs_type', since: 'date_since' });
  if (args.project) args = { ...args, project: _resolveProjectShared(db, args.project) };
  const limit = args.limit ?? 10;
  const project = args.project || inferProject();

  // date_since: relative lower bound on created_at (CLI `recent --since` parity).
  // Parsed here rather than in the core because the surfaces reject a bad duration
  // in their own dialect — MCP throws, CLI fail()s.
  let since = null;
  if (args.date_since !== undefined) {
    const d = parseDuration(args.date_since);
    if (!d.ok) throw new Error(`Invalid date_since: "${args.date_since}" (use <N><unit>, e.g. 7d, 24h, 90m, 2w)`);
    since = Date.now() - d.ms;
  }

  // Shared core with CLI `recent`: live-rows filter + ordering (lib/recent-core.mjs).
  // obs_type is already enum-validated by zod before the handler runs.
  const rows = fetchRecent(db, { project, type: args.obs_type || null, since, limit });

  if (rows.length === 0) {
    return { content: [{ type: 'text', text: `No recent observations${project ? ` (${project})` : ''}.` }] };
  }

  const lines = [`Recent observations (${project || 'all'}):\n`];
  for (const r of rows) {
    lines.push(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || r.subtitle || '(untitled)')} | ${r.project} | ${fmtDate(r.created_at)}`);
  }
  lines.push(`\nWorkflow: mem_get(ids=[...]) for full details | mem_timeline(anchor=ID) for context`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

server.registerTool(
  'mem_recent',
  {
    description: descriptionOf('mem_recent'),
    inputSchema: memRecentSchema,
  },
  safeHandler(async (args) => runRecent(db, args))
);

// ─── Tool: mem_timeline ─────────────────────────────────────────────────────

server.registerTool(
  'mem_timeline',
  {
    description: descriptionOf('mem_timeline'),
    inputSchema: memTimelineSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const before = args.before ?? 5;
    const after = args.after ?? 5;
    let anchorId = args.anchor;
    let anchorNote = null;

    // Resolve prefixed-token anchor (e.g. "P#3462" / "S#53" / "#8121") — users pasting
    // from mem_search results expect the same routing as CLI `timeline --anchor`.
    // Resolution ladder (prompt/session → nearest obs, compressed re-anchor, bare-int
    // fallback) is shared with the CLI via lib/timeline-core.mjs. Covers bare numeric
    // anchors too, so `anchor: 7826` (int) can't bypass the compressed check and
    // silently straddle a dead record.
    if (typeof anchorId === 'string' || typeof anchorId === 'number') {
      const resolved = resolveAnchorToken(db, anchorId, { project: args.project ?? null });
      if (!resolved.ok) {
        return { content: [{ type: 'text', text: formatAnchorError(resolved.error, 'mcp') }] };
      }
      anchorId = resolved.anchorId;
      anchorNote = resolved.anchorNote;
    }

    // Auto-find anchor via FTS (with recency decay). Shared with CLI
    // `timeline --query` so AND→OR fallback semantics stay identical (#8217);
    // the relaxed-note hint mirrors search transparency.
    if (!anchorId && args.query) {
      const found = resolveQueryAnchor(db, args.query, { project: args.project ?? null });
      if (found) {
        anchorId = found.anchorId;
        if (found.anchorNote && !anchorNote) anchorNote = found.anchorNote;
      }
    }

    // No anchor: return most recent
    if (!anchorId) {
      const rows = fetchRecentTimeline(db, { project: args.project ?? null, limit: before + after + 1 });

      if (rows.length === 0) {
        return { content: [{ type: 'text', text: 'No observations found.' }] };
      }

      const lines = [`Timeline (most recent ${rows.length}):\n`];
      for (const r of rows.reverse()) {
        lines.push(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || r.subtitle || '(untitled)')} | ${r.project} | ${fmtDate(r.created_at)}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // Window fetch (access-count bump + project auto-scope) shared with CLI.
    const win = fetchTimelineWindow(db, anchorId, { before, after, project: args.project ?? null });
    if (!win) {
      return { content: [{ type: 'text', text: `Observation #${anchorId} not found.` }] };
    }

    const all = [...win.beforeRows, win.anchor, ...win.afterRows];
    const lines = [`Timeline around #${anchorId}${anchorNote ? ' ' + anchorNote : ''}:\n`];
    for (const r of all) {
      const marker = r.id === anchorId ? ' ◀' : '';
      lines.push(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || r.subtitle || '(untitled)')} | ${r.project} | ${fmtDate(r.created_at)}${marker}`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: mem_get ──────────────────────────────────────────────────────────

server.registerTool(
  'mem_get',
  {
    description: descriptionOf('mem_get'),
    inputSchema: memGetSchema,
  },
  safeHandler(async (args) => {
    // D#N deferred tokens are peeled off BEFORE bucketing/source-forcing —
    // get-only read surface into deferred_work (parity with CLI cmdGet; the
    // fetch+render live in lib/deferred-work.mjs so the twins cannot drift).
    const { deferredIds, rest } = splitDeferredTokens(args.ids);
    // Bucket by per-token prefix (or force all to `args.source` when explicit).
    // coerceMixedIdTokens has already stringified + regex-validated each token.
    const { bySrc, invalid } = bucketIdTokens(rest, { explicit: args.source || null, defaultSource: 'obs' });
    if (invalid.length > 0) {
      // Should not happen — schema regex already rejected bad tokens — but guard defensively.
      return { content: [{ type: 'text', text: `Invalid ID token(s): ${invalid.join(', ')}. Expected N, #N, P#N, S#N, E#N, or D#N.` }] };
    }
    const totalRequested = bySrc.obs.length + bySrc.session.length + bySrc.prompt.length + bySrc.event.length + deferredIds.length;
    if (totalRequested === 0) {
      return { content: [{ type: 'text', text: 'No valid IDs provided.' }] };
    }

    // `fields` filter only makes sense for obs rows; session/prompt ignore it.
    // Validate when obs is queried — throw on all-invalid, note on partial-invalid.
    let fieldsNote = '';
    let obsFieldFilter = null;
    if (args.fields?.length && bySrc.obs.length > 0) {
      const invalidFields = args.fields.filter(f => !OBS_FIELDS.includes(f));
      const validFields = args.fields.filter(f => OBS_FIELDS.includes(f));
      if (validFields.length === 0) {
        throw new Error(`No valid fields. Unknown field(s): ${invalidFields.join(', ')}. Valid: ${OBS_FIELDS.join(', ')}`);
      }
      if (invalidFields.length > 0) {
        fieldsNote = `Note: unknown field(s) dropped: ${invalidFields.join(', ')}. Valid: ${OBS_FIELDS.join(', ')}`;
      }
      obsFieldFilter = validFields;
    }

    // Per-source fetchers — each returns { rows, foundIds:Set, prefix }.
    const sections = [];
    const foundBySource = { obs: new Set(), session: new Set(), prompt: new Set(), event: new Set() };

    if (bySrc.obs.length > 0) {
      // Access-bump + fetch via the shared get-core (P2-12) — single source with CLI get.
      const rows = fetchObsDetail(db, bySrc.obs);
      const renderFields = obsFieldFilter || OBS_FIELDS;
      for (const row of rows) {
        foundBySource.obs.add(row.id);
        const lines = [`── #${row.id} ──`];
        // Retraction first (shared with the CLI `get` via get-core) — see supersededNotice.
        const retracted = supersededNotice(row);
        if (retracted) lines.push(retracted);
        for (const f of renderFields) {
          const val = row[f];
          if (val === null || val === undefined || val === '') continue;
          if (f === 'text' && row.narrative && typeof val === 'string' && val.startsWith(row.narrative)) continue;
          // Shared formatter (cli/common.mjs) renders epoch-ms time fields as
          // `<ms> (<relative>)` — parity with the CLI `get` path so an LLM reader
          // gets a scannable hint instead of a bare millisecond integer.
          const display = formatObsFieldValue(f, val);
          const maxLen = f === 'narrative' ? 1000 : f === 'lesson_learned' ? 500 : f === 'text' ? 500 : 200;
          lines.push(`${obsFieldLabel(f)}: ${typeof display === 'string' && display.length > maxLen ? display.slice(0, maxLen) + '…' : display}`);
        }
        sections.push(lines.join('\n'));
      }
    }

    if (bySrc.session.length > 0) {
      const ph = bySrc.session.map(() => '?').join(',');
      const rows = db.prepare(`SELECT * FROM session_summaries WHERE id IN (${ph}) ORDER BY created_at_epoch ASC`).all(...bySrc.session);
      // SESSION_DETAIL_FIELDS (get-core, P2-12): shared full set — adds remaining_items
      // (searchable via FTS but previously unrendered on BOTH detail faces).
      const sessFields = SESSION_DETAIL_FIELDS;
      for (const row of rows) {
        foundBySource.session.add(row.id);
        const lines = [`── S#${row.id} ──`];
        for (const f of sessFields) {
          const val = row[f];
          if (val === null || val === undefined || val === '') continue;
          const maxLen = 500;
          lines.push(`${f}: ${typeof val === 'string' && val.length > maxLen ? val.slice(0, maxLen) + '…' : val}`);
        }
        sections.push(lines.join('\n'));
      }
    }

    if (bySrc.prompt.length > 0) {
      for (const row of fetchPromptDetail(db, bySrc.prompt)) {
        foundBySource.prompt.add(row.id);
        const lines = [`── P#${row.id} ──`];
        for (const f of PROMPT_DETAIL_FIELDS) {
          if (f === 'id') continue;   // already in the header
          const val = row[f];
          if (val === null || val === undefined || val === '') continue;
          lines.push(`${f}: ${typeof val === 'string' && val.length > 500 ? val.slice(0, 500) + '…' : val}`);
        }
        sections.push(lines.join('\n'));
      }
    }

    if (bySrc.event.length > 0) {
      // fetchEventDetail derives created_at from created_at_epoch (events have no ISO
      // column), so EVENT_DETAIL_FIELDS names it like any other field on both faces.
      for (const row of fetchEventDetail(db, bySrc.event)) {
        foundBySource.event.add(row.id);
        const lines = [`── E#${row.id} [${row.event_type}] ──`];
        for (const f of EVENT_DETAIL_FIELDS) {
          if (f === 'id' || f === 'event_type') continue;   // already in the header
          const val = row[f];
          if (val === null || val === undefined || val === '') continue;
          lines.push(`${f}: ${typeof val === 'string' && val.length > 500 ? val.slice(0, 500) + '…' : val}`);
        }
        sections.push(lines.join('\n'));
      }
    }

    // Deferred sections — prepended below (explicit D# requests are rare; the
    // FULL untruncated detail is the point of this surface).
    let deferredSections = [];
    let deferredFound = 0;
    let deferredMissing = [];
    if (deferredIds.length > 0) {
      const dRows = getDeferredByIds(db, deferredIds);
      const found = new Set(dRows.map(r => r.id));
      deferredMissing = deferredIds.filter(id => !found.has(id));
      deferredSections = dRows.map(formatDeferredDetail);
      deferredFound = dRows.length;
    }

    const totalFound = foundBySource.obs.size + foundBySource.session.size + foundBySource.prompt.size + foundBySource.event.size + deferredFound;

    if (totalFound === 0 && deferredIds.length > 0 && bySrc.obs.length + bySrc.session.length + bySrc.prompt.length + bySrc.event.length === 0) {
      // Deferred-only request, nothing found — the source-probe below is about
      // obs/session/prompt/event and would render an empty source list.
      return { content: [{ type: 'text', text: `Deferred item(s) not found: ${deferredMissing.map(i => `D#${i}`).join(', ')}. List open items: mem_defer_list.` }] };
    }

    if (totalFound === 0) {
      // Probe other sources so callers can retry with the right prefix/source override.
      const queried = new Set(Object.entries(bySrc).filter(([, v]) => v.length > 0).map(([k]) => k));
      const allNumericIds = [...bySrc.obs, ...bySrc.session, ...bySrc.prompt, ...bySrc.event];
      const probe = probeIdSources(db, allNumericIds, queried);
      const hints = [];
      if (probe.obs.length > 0)     hints.push(`#${probe.obs.join(', #')} (obs — use source='obs' or bare #N)`);
      if (probe.session.length > 0) hints.push(`S#${probe.session.join(', S#')} (session — use source='session' or S#N)`);
      if (probe.prompt.length > 0)  hints.push(`P#${probe.prompt.join(', P#')} (prompt — use source='prompt' or P#N)`);
      if (probe.event.length > 0)   hints.push(`E#${probe.event.join(', E#')} (event — use source='event' or E#N)`);
      const hint = hints.length > 0 ? ` Try: ${hints.join('; ')}.` : '';
      const queriedList = [...queried].join(', ');
      const deferredNote = deferredMissing.length > 0 ? ` Deferred item(s) not found: ${deferredMissing.map(i => `D#${i}`).join(', ')}.` : '';
      const msg = `No records found in source(s) [${queriedList}] for the given ID(s).${deferredNote}${hint}`;
      return { content: [{ type: 'text', text: fieldsNote ? `${msg}\n\n${fieldsNote}` : msg }] };
    }

    // Missing-ID note per bucket (mirrors mem_delete). Show missing IDs with their bucket prefix
    // so callers can tell which source returned nothing.
    const missingHints = [];
    const miss = (arr, found, prefix) => arr.filter(id => !found.has(id)).map(id => `${prefix}${id}`);
    missingHints.push(...miss(bySrc.obs, foundBySource.obs, '#'));
    missingHints.push(...miss(bySrc.session, foundBySource.session, 'S#'));
    missingHints.push(...miss(bySrc.prompt, foundBySource.prompt, 'P#'));
    missingHints.push(...miss(bySrc.event, foundBySource.event, 'E#'));
    missingHints.push(...deferredMissing.map(id => `D#${id}`));

    const parts = [];
    if (fieldsNote) parts.push(fieldsNote);
    parts.push(...deferredSections, ...sections);
    if (missingHints.length > 0) {
      parts.push(`Note: ID(s) ${missingHints.join(', ')} not found.`);
    }

    return { content: [{ type: 'text', text: parts.join('\n\n') }] };
  })
);

// ─── Tool: mem_delete ────────────────────────────────────────────────────────

server.registerTool(
  'mem_delete',
  {
    description: descriptionOf('mem_delete'),
    inputSchema: memDeleteSchema,
  },
  safeHandler(async (args) => {
    // Shared preview body (lib/delete-core, P2-12) — single source with CLI delete.
    const { rows, lines: previewLines } = previewDeleteRows(db, args.ids);

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No observations found for given IDs.' }] };
    }

    if (!args.confirm) {
      const lines = [`Preview: ${rows.length} observation(s) will be deleted:\n`, ...previewLines];
      lines.push(`\nCall mem_delete(ids=[...], confirm=true) to execute.`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // Full delete orchestration (snapshot + related_ids cleanup + child recovery +
    // delete transaction) lives in lib/delete-core.mjs — single source of truth shared
    // with the CLI `delete` path (was inlined + kept in sync by parity comments).
    const result = deleteObservations(db, args.ids);

    const missing = args.ids.filter(id => !rows.some(r => r.id === id));
    const msg = [`Deleted ${result.deleted} observation(s).`];
    if (result.recoveredChildren > 0) msg.push(`Recovered ${result.recoveredChildren} merged/compressed child observation(s) to live.`);
    if (missing.length > 0) msg.push(`Note: ID(s) ${missing.join(', ')} not found.`);
    return { content: [{ type: 'text', text: msg.join(' ') }] };
  })
);

// ─── Tool: mem_save ─────────────────────────────────────────────────────────

// Sanity ceilings on the free-text fields that reach unbounded TEXT columns. zod
// validates TYPES; before this, `title` had no size bound at all
// (`z.string().optional()`), so one runaway summarizer write stored a multi-KB title
// verbatim and every later FTS rebuild, minhash and vector recompute paid for that row
// forever. Truncate rather than reject: rejection would be a breaking contract change
// on a published MCP tool, and a caller that over-writes still wants its memory saved.
//
// Numbers: `title` at 500 is ~5× the longest form any read path renders (titles are
// truncate()'d to 80–100 chars on display) and 5× saveObservation's own
// content.slice(0, 100) fallback — generous headroom, still a bound. `content` (50000)
// and `lesson_learned` (500) mirror the zod maxima already published in
// tool-schemas.mjs, so the advertised contract is not narrowed; applying them here
// converts a hard zod REJECT into graceful truncation for any caller that reaches this
// path without schema validation.
export const SAVE_TEXT_LIMITS = { content: 50000, title: 500, lesson_learned: 500 };

/**
 * Cap one free-text field at `limit`, marking the loss in-band so the truncation is
 * visible in the stored row (a silently shortened memory is worse than a marked one).
 * The marker names the ORIGINAL length, and the result never exceeds `limit`.
 * Non-strings (absent optional fields) pass through untouched.
 */
export function clampSaveText(value, limit) {
  if (typeof value !== 'string' || value.length <= limit) return value;
  const marker = ` … [truncated from ${value.length} chars]`;
  return value.slice(0, Math.max(0, limit - marker.length)) + marker;
}

server.registerTool(
  'mem_save',
  {
    description: descriptionOf('mem_save'),
    inputSchema: memSaveSchema,
  },
  safeHandler(async (args) => {
    // `obs_type` → `type`: the sibling read tools all name it obs_type (see the schema
    // comment). Without this, an unknown key was dropped and the row saved as `discovery`.
    args = applyArgAliases(args, { obs_type: 'type' });
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const project = args.project || inferProject();

    let closesIds = null;
    let result;
    try {
      result = db.transaction(() => {
        const r = saveObservation(db, {
          // Size ceiling applied here rather than in lib/save-observation.mjs so the
          // shared pipeline keeps its "caller validates" contract (see its header).
          content: clampSaveText(args.content, SAVE_TEXT_LIMITS.content),
          title: clampSaveText(args.title, SAVE_TEXT_LIMITS.title),
          type: args.type || 'discovery',
          importance: args.importance,
          project,
          files: args.files || [],
          lesson_learned: clampSaveText(args.lesson_learned, SAVE_TEXT_LIMITS.lesson_learned),
          supersedes: args.supersedes,
        });
        if (r.kind === 'duplicate') return r; // dedup short-circuits BEFORE resolver — replay is idempotent
        // Resolve INSIDE tx + after dedup check so duplicate replays don't throw on
        // already-closed items. Mirrors mem-cli.mjs cmdSave shape.
        if (args.closes_deferred && args.closes_deferred.length > 0) {
          // D#195: 'dropped' is closable by the close verb (kept in sync with
          // mem-cli.mjs cmdSave — same policy, both faces).
          closesIds = resolveDeferredIds(db, project, args.closes_deferred, { allowStatuses: ['open', 'dropped'] });
          closeDeferredItems(db, closesIds, r.id);
        }
        return r;
      })();
    } catch (e) {
      if (args.closes_deferred && args.closes_deferred.length > 0) {
        // Re-throw with a clearer prefix so MCP error response names the
        // contract failure — gate on caller intent (args.closes_deferred) since
        // closesIds is closure-scoped and may not have been assigned before throw.
        throw new Error(`mem_save with closes_deferred failed: ${e.message}`, { cause: e });
      }
      throw e;  // unwrapped — preserves original message + stack
    }

    if (result.kind === 'duplicate') {
      return { content: [{ type: 'text', text: `Skipped: similar to existing #${result.existingId} in project "${project}". Use mem_get(ids=[${result.existingId}]) to review.` }] };
    }

    const lessonNote = result.lessonCaptured ? ` 💡lesson captured` : '';
    const closedNote = closesIds && closesIds.length > 0
      ? ` Closed deferred: ${closesIds.map(i => `D#${i}`).join(', ')}.`
      : '';
    const supersededNote = result.supersededIds && result.supersededIds.length > 0
      ? ` Superseded: ${result.supersededIds.map(i => `#${i}`).join(', ')}.`
      : '';
    const nudge = buildLessonNudge({ type: result.type, id: result.id, lessonCaptured: result.lessonCaptured, surface: 'mcp' });
    // G1+G2: detached backfill worker (lesson for obligated types + aliases for
    // every save) — fill-only-empty, so an agent acting on the nudge still wins.
    const enrichNote = shouldQueueSaveEnrich(result) && queueSaveEnrich(result.id)
      ? ' (background enrichment queued)' : '';
    return { content: [{ type: 'text', text: `Saved as observation #${result.id} [${result.type}] in project "${project}".${lessonNote}${closedNote}${supersededNote}${enrichNote}${nudge}` }] };
  })
);

// ─── Tool: mem_defer ────────────────────────────────────────────────────────

server.registerTool(
  'mem_defer',
  {
    description: descriptionOf('mem_defer'),
    inputSchema: memDeferSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const project = args.project || inferProject();
    const r = insertDeferred(db, {
      project,
      title: args.title,
      priority: args.priority ?? 2,
      detail: args.detail ?? null,
      files: args.files ?? null,
    });
    // Compute the ordinal for the freshly-inserted row so the response is
    // immediately actionable ("ok, I deferred this as item 1").
    const open = listOpenWithOrdinal(db, project, 50);
    const ord = open.find(o => o.id === r.id)?.ordinal ?? null;
    return { content: [{ type: 'text', text:
      `Deferred as D#${r.id} (item ${ord ?? '?'}) in project "${project}" — surfaces in next SessionStart banner.` }] };
  })
);

// ─── Tool: mem_defer_list ───────────────────────────────────────────────────

server.registerTool(
  'mem_defer_list',
  {
    description: descriptionOf('mem_defer_list'),
    inputSchema: memDeferListSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const project = args.project || inferProject();
    const list = listOpenWithOrdinal(db, project, args.limit ?? 10);
    if (list.length === 0) {
      return { content: [{ type: 'text', text: `No open deferred items in project "${project}".` }] };
    }
    const lines = [`Open deferred items (project "${project}"):`];
    for (const r of list) {
      lines.push(formatDeferListRow(r));
    }
    const staleHint = formatDeferStaleHint(countStaleOpen(db, project));
    if (staleHint) lines.push(staleHint);
    // Affordance for the detail field — list stays title-only by design.
    lines.push(`Full detail: mem_get ids=["D#<id>"]`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: mem_defer_drop ───────────────────────────────────────────────────

server.registerTool(
  'mem_defer_drop',
  {
    description: descriptionOf('mem_defer_drop'),
    inputSchema: memDeferDropSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const project = args.project || inferProject();
    // Resolve id (accept D#N or ordinal int) via resolveDeferredIds with a
    // single-element array — reuses the same project + status validation.
    const [realId] = resolveDeferredIds(db, project, [args.id]);
    const r = dropDeferred(db, realId, args.reason);
    if (r.changed === 0) {
      return { content: [{ type: 'text', text: `D#${realId} was not in 'open' status — drop is a no-op.` }] };
    }
    // D#195 (c): same advisory as the CLI's `defer drop`, so an agent reaching
    // this through MCP gets the same steer toward `mem_save(closes_deferred)`.
    const hint = formatDropReasonHint(args.reason);
    const dropText = `Dropped D#${realId} in project "${project}". Reason: ${args.reason}`;
    return { content: [{ type: 'text', text: hint ? `${dropText}\n${hint}` : dropText }] };
  })
);

// ─── Tool: mem_stats ────────────────────────────────────────────────────────

server.registerTool(
  'mem_stats',
  {
    description: descriptionOf('mem_stats'),
    inputSchema: memStatsSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const days = args.days ?? 30;

    // Batch A CLI↔MCP alignment: quality:true → quality dashboard (lesson
    // rate, LOW_SIGNAL rate, per-type hit/lesson %, top lessons, R-2 watchdog).
    // Same computation + format as CLI `stats --quality` via lib/stats-quality.mjs.
    if (args.quality) {
      const { computeQualityStats, formatQualityReport } = await import('./lib/stats-quality.mjs');
      const data = computeQualityStats(db, { project: args.project, days });
      return { content: [{ type: 'text', text: formatQualityReport(data) }] };
    }

    const {
      obsTotal, sessTotal, promptTotal, obsRecent, sessRecent,
      types, projects, daily, tokenEst, avgImp, lowVal, lowSignalTitle,
      noiseRatio, lowSignalRatio, compressedCount, supersededOnlyCount, tierMap,
    } = computeStatsFeed(db, { project: args.project || null, days });

    const lines = [
      `Memory Statistics${args.project ? ` (project: ${args.project})` : ''}:`,
      '',
      // Env-aware data dir — parity with CLI cmdStats (D#92 wrong-path chain).
      `Data dir: ${DB_DIR}`,
      `Total: ${obsTotal.c} observations | ${sessTotal.c} sessions | ${promptTotal.c} prompts`,
      `Last ${days}d: ${obsRecent.c} observations | ${sessRecent.c} sessions`,
      '',
      'Type distribution (recent):',
      ...types.map(t => `  ${typeIcon(t.type)} ${t.type}: ${t.c}`),
      '',
      ...(projects.length ? ['Top projects:', ...projects.map(p => `  ${p.project}: ${p.c}`)] : []),
      '',
      'Daily activity (last 7d):',
      ...daily.map(d => `  ${d.day}: ${d.c} observations`),
      '',
      'Data Health:',
      `  Est. tokens: ${tokenEst.t ?? 0}`,
      `  Avg importance: ${(avgImp.v ?? 1).toFixed(2)}`,
      `  Low-value (imp≤1, never used, >30d): ${lowVal.c} (${(noiseRatio * 100).toFixed(1)}% noise)`,
      `  Low-signal titles (Modified/Error/Worked on…): ${lowSignalTitle.c} (${(lowSignalRatio * 100).toFixed(1)}%)`,
      `  Compressed: ${compressedCount.c}`,
      ...((noiseRatio > 0.6 || lowSignalRatio > 0.3) ? ['  ⚠️ High noise ratio — consider running mem_compress / maintain'] : []),
      '',
      // Tier counts only live (uncompressed, non-superseded) observations — surface
      // the full decomposition so live + compressed + superseded = Total adds up cleanly.
      `Tier distribution (live ${(tierMap.working ?? 0) + (tierMap.active ?? 0) + (tierMap.archive ?? 0)}, excludes ${compressedCount.c} compressed${supersededOnlyCount.c > 0 ? ` + ${supersededOnlyCount.c} superseded` : ''}):`,
      `  🔴 Working: ${tierMap.working ?? 0} | 🟡 Active: ${tierMap.active ?? 0} | 🔵 Archive: ${tierMap.archive ?? 0}`,
    ];

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: mem_compress ──────────────────────────────────────────────────────

server.registerTool(
  'mem_compress',
  {
    description: descriptionOf('mem_compress'),
    inputSchema: memCompressSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const preview = args.preview !== false;
    const ageDays = args.age_days ?? 30;
    const cutoff = Date.now() - ageDays * DAY_MS;
    const candidates = selectCompressionCandidates(db, { cutoff, project: args.project || null });

    if (candidates.length === 0) {
      return { content: [{ type: 'text', text: 'No candidates for compression.' }] };
    }

    const compressableGroups = groupByProjectWeek(candidates);

    if (preview) {
      const totalCandidates = compressableGroups.reduce((s, [, obs]) => s + obs.length, 0);
      const lines = [
        `Compression preview:`,
        `  Total candidates: ${candidates.length}`,
        `  Compressable groups (≥3 obs): ${compressableGroups.length}`,
        `  Observations to compress: ${totalCandidates}`,
        '',
        'Groups:',
        ...compressableGroups.slice(0, 20).map(([key, obs]) => {
          const [proj, week] = key.split('::');
          const types = {};
          for (const o of obs) types[o.type] = (types[o.type] || 0) + 1;
          const typeStr = Object.entries(types).map(([t, c]) => `${c} ${t}`).join(', ');
          return `  ${proj} ${week}: ${obs.length} obs (${typeStr})`;
        }),
        '',
        `Call mem_compress(preview=false${args.age_days ? `, age_days=${args.age_days}` : ''}${args.project ? `, project="${args.project}"` : ''}) to execute.`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // Execute compression — one transaction over all groups (the hook transacts per group).
    let totalCompressed = 0;
    const compress = db.transaction(() => {
      for (const [key, obs] of compressableGroups) {
        const [proj] = key.split('::');
        totalCompressed += compressGroup(db, proj, obs).compressed;
      }
    });
    compress();

    return { content: [{ type: 'text', text: `Compressed ${totalCompressed} observations into ${compressableGroups.length} weekly summaries.` }] };
  })
);

// ─── Tool: mem_maintain ──────────────────────────────────────────────────────

server.registerTool(
  'mem_maintain',
  {
    description: descriptionOf('mem_maintain'),
    inputSchema: memMaintainSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const DUPLICATE_DISPLAY = 15;

    const action = args.action;
    const project = args.project;
    const projectFilter = project ? 'AND project = ?' : '';
    const baseParams = project ? [project] : [];

    if (action === 'scan') {
      const staleAge = Date.now() - STALE_AGE_MS;
      const mctx = { projectFilter, baseParams, staleAge };
      const duplicates = findDuplicates(db, mctx);
      const stats = maintenanceStats(db, mctx);

      const lines = [
        `Memory maintenance scan:`,
        `  Total active observations: ${stats.total}`,
        `  Near-duplicate pairs: ${duplicates.length}`,
        `  Stale (>30d, imp=1, no access, never injected): ${stats.stale}`,
        `  Broken (no title/narrative): ${stats.broken}`,
        `  Boostable (accessed>3, imp<3): ${stats.boostable}`,
        formatPendingPurgeLine(stats.pendingPurge),
      ];
      if (duplicates.length > 0) {
        const autoMergeable = duplicates.filter(d => parseFloat(d.similarity) >= AUTO_MERGE_THRESHOLD);
        const manualReview = duplicates.filter(d => parseFloat(d.similarity) < AUTO_MERGE_THRESHOLD);

        if (autoMergeable.length > 0) {
          lines.push('', `Auto-mergeable pairs (similarity >= ${AUTO_MERGE_THRESHOLD}):`);
          for (const d of autoMergeable.slice(0, DUPLICATE_DISPLAY)) {
            // Keep the higher-importance or newer observation
            const keep = d.a.importance >= d.b.importance ? d.a : d.b;
            const remove = keep === d.a ? d.b : d.a;
            lines.push(`  [${keep.id}] "${truncate(keep.title, 40)}" <-> [${remove.id}] "${truncate(remove.title, 40)}" (${d.similarity})`);
          }
          // Build ready-to-use merge_ids for auto-mergeable pairs
          const mergeIds = autoMergeable.map(d => {
            const keep = d.a.importance >= d.b.importance ? d.a : d.b;
            const remove = keep === d.a ? d.b : d.a;
            return [keep.id, remove.id];
          });
          lines.push('', `Ready-to-use command:`, `  mem_maintain(action="execute", operations=["dedup"], merge_ids=${JSON.stringify(mergeIds)})`);
        }

        if (manualReview.length > 0) {
          lines.push('', 'Needs review:');
          for (const d of manualReview.slice(0, DUPLICATE_DISPLAY)) {
            lines.push(`  [${d.a.id}] "${truncate(d.a.title, 40)}" <-> [${d.b.id}] "${truncate(d.b.title, 40)}" (${d.similarity})`);
          }
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (action === 'execute') {
      const ops = args.operations && args.operations.length > 0
        ? args.operations
        : resolveDefaultMaintainOps();
      // T2-P1-A: reject explicit empty array (vs. omitted → defaults above). Empty-array
      // callers are almost always mistakes; silently running only FTS5 optimize hides the error.
      if (args.operations && args.operations.length === 0) {
        return { content: [{ type: 'text', text: `operations array is empty. Pass a non-empty list (e.g. ${JSON.stringify(DEFAULT_MAINTAIN_OPS)}) or omit operations to use the default set.` }], isError: true };
      }
      const results = [];
      const staleAge = Date.now() - STALE_AGE_MS;
      const mctx = { projectFilter, baseParams, staleAge, opCap: OP_CAP };

      // T2-P0-A: purge_stale is the only op gated on confirm=true — cleanupBroken also
      // hard-deletes (broken rows only) but always ran unconfirmed on both surfaces, and
      // the pre-transaction snapshot above covers it. An unconfirmed call gets a dry-run
      // preview of the purge INSTEAD OF the purge.
      // M-7 (audit 2026-08-14): preview-instead-of-early-return — the old
      // `return`-on-unconfirmed skipped EVERY requested op, while the CLI twin ran the
      // non-destructive ones (cleanup/decay/boost) and previewed only the purge. Same
      // op list, two different amounts of work done, both reporting success. Aligned
      // to the CLI semantics (the safer surface changed less: nothing destructive
      // runs unconfirmed on either surface now or before).
      const purgeConfirmed = args.confirm === true;

      // MED-2: snapshot the DB before the irreversible cleanup/purge hard-deletes —
      // only when rows will actually be removed, and OUTSIDE the transaction below
      // (VACUUM cannot run inside one). Best-effort; snapshotDb never throws.
      if (hardDeleteCandidateCount(db, mctx, { cleanup: ops.includes('cleanup'), purge: ops.includes('purge_stale') && purgeConfirmed }) > 0) {
        snapshotDb(db, { tag: 'pre-maintain' });
      }

      db.transaction(() => {
        // PURGE FIRST — matches the auto-maintain hook order (hook.mjs:766) and the CLI
        // cmdMaintain. Running decay BEFORE purge in one transaction marked a stale row
        // pending-purge AND deleted it in the SAME call (zero grace), while the pre-txn
        // snapshot guard counts only PRE-EXISTING pending rows so it skipped the backup →
        // permanent loss of notable imp-2/3 memories (audit HIGH-1). Purging first deletes
        // only rows a PRIOR run marked (backed up); rows decay marks below wait one cycle.
        if (ops.includes('purge_stale')) {
          const retainDays = args.retain_days ?? 30;
          const retainCutoff = Date.now() - retainDays * DAY_MS;
          if (!purgeConfirmed) {
            // Dry-run preview (parity with CLI `maintain` without --confirm): the other
            // requested non-destructive ops still run below.
            const previewRow = purgeStalePreview(db, mctx, retainCutoff);
            const lines = [
              'purge_stale preview (confirm=false):',
              `  Candidates (pending-purge, older than ${retainDays}d): ${previewRow.candidates}`,
            ];
            if (previewRow.candidates > 0) {
              lines.push(`  Oldest: ${new Date(previewRow.oldest).toISOString().slice(0, 10)}`);
              lines.push(`  Newest: ${new Date(previewRow.newest).toISOString().slice(0, 10)}`);
            }
            lines.push('  Nothing was deleted. To delete, re-run with confirm=true:');
            lines.push(`  mem_maintain(action="execute", operations=${JSON.stringify(ops)}, confirm=true${args.retain_days ? `, retain_days=${args.retain_days}` : ''}${args.project ? `, project="${args.project}"` : ''})`);
            results.push(lines.join('\n'));
          } else {
            const purged = purgeStale(db, mctx, retainCutoff);
            results.push(`Purged ${purged} stale observations (retained last ${retainDays} days)` + (purged >= OP_CAP ? ' (cap reached, re-run for more)' : ''));
          }
        }

        if (ops.includes('cleanup')) {
          const deleted = cleanupBroken(db, mctx);
          results.push(`Cleaned up ${deleted} broken observations` + (deleted >= OP_CAP ? ' (cap reached, re-run for more)' : ''));
          // Self-heal legacy orphans (keeper hard-deleted pre-recoverChildrenOf):
          // resurface unreachable children. Non-destructive — un-hide only, no delete.
          const orphans = recoverOrphanedChildren(db, mctx);
          if (orphans > 0) results.push(`Recovered ${orphans} orphaned compression children`);
          // Heal lesson rows citation-decay buried at importance 0 (pre floor=1). 0→1 on
          // lesson-bearing rows only; idempotent no-op once none remain.
          const lessonsHealed = recoverBuriedLessons(db, mctx);
          if (lessonsHealed > 0) results.push(`Healed ${lessonsHealed} lesson rows buried at importance 0`);
          // Heal deferred_work rows whose closing obs / source prompt was deleted while FK was
          // OFF (dangling ref foreign_key_check flags). Applies the ON DELETE SET NULL the FK would.
          const deferredHealed = sweepDeferredWorkOrphans(db, mctx);
          if (deferredHealed > 0) results.push(`Healed ${deferredHealed} deferred-work rows with dangling references`);
        }

        if (ops.includes('decay')) {
          // injection_count>0 protected (maintain-core; unifies with CLI + hook —
          // the MCP copy previously lacked this clause and decayed/purged injected memories).
          const { decayed, idleMarked } = decayAndMarkIdle(db, mctx);
          results.push(`Decayed ${decayed} stale observations, marked ${idleMarked} idle as pending-purge` + ((decayed >= OP_CAP || idleMarked >= OP_CAP) ? ' (cap reached, re-run for more)' : ''));
        }

        if (ops.includes('boost')) {
          const boosted = boostAccessed(db, mctx);
          results.push(`Boosted ${boosted} frequently-accessed observations` + (boosted >= OP_CAP ? ' (cap reached, re-run for more)' : ''));
        }

        if (ops.includes('demote_pinned')) {
          const demoted = demotePinned(db, mctx);
          results.push(`Demoted ${demoted} pinned-but-uncited observations (inj>=8, cited=0; no lesson → importance 1, lesson → 2)` + (demoted >= OP_CAP ? ' (cap reached, re-run for more)' : ''));
        }

        if (ops.includes('dedup') && args.merge_ids) {
          const totalMerged = mergeDuplicates(db, args.merge_ids);
          results.push(`Merged ${totalMerged} duplicate observations`);
        }

        if (!ops.includes('dedup') && args.merge_ids) {
          results.push('Warning: merge_ids provided but "dedup" not in operations — merge_ids ignored');
        }
      })();

      // FTS5 optimize (outside transaction)
      db.exec("INSERT INTO observations_fts(observations_fts) VALUES('optimize')");
      results.push('FTS5 index optimized');

      // rebuild_vectors: outside main transaction (maintain-core, shared with CLI).
      if (ops.includes('rebuild_vectors')) {
        try {
          const r = rebuildVectors(db);
          results.push(r.ok
            ? `Vectors: rebuilt vocabulary (${r.terms} terms), updated ${r.updated}/${r.total} vectors`
            : `Vectors: ${r.reason}`);
        } catch (e) {
          debugCatch(e, 'rebuild_vectors');
          results.push(`Vectors: rebuild failed — ${e.message}`);
        }
      }

      // vacuum: reclaim freelist dead space left by DELETEs. Whole-DB, outside any
      // transaction. maintain-core, shared with CLI.
      if (ops.includes('vacuum')) {
        try {
          const v = vacuum(db);
          results.push(`VACUUM: reclaimed ~${v.reclaimedMB}MB (freelist ${v.freeBefore} → ${v.freeAfter} pages)`);
        } catch (e) {
          debugCatch(e, 'vacuum');
          results.push(`VACUUM failed — ${e.message}`);
        }
      }

      return { content: [{ type: 'text', text: results.join('\n') }] };
    }

    return { content: [{ type: 'text', text: `Unknown action: ${action}. Use "scan" or "execute".` }], isError: true };
  })
);

// ─── Tool: mem_optimize ────────────────────────────────────────────────────

server.registerTool(
  'mem_optimize',
  {
    description: descriptionOf('mem_optimize'),
    inputSchema: memOptimizeSchema,
  },
  safeHandler(async (args) => {
    const action = args.action || 'preview';

    if (action === 'preview') {
      const preview = optimizePreview(db, { project: args.project, detail: args.detail === true });
      const lines = [
        `🔍 LLM Optimization Preview:`,
      ];
      if (args.project) lines.push(`  Project filter: ${args.project}`);
      lines.push(
        `  Re-enrich candidates: ${preview.reenrich}`,
        `  Normalize: ${preview.normalizeGateOpen ? `${preview.normalize} unique concepts` : 'gate closed (7-day interval)'}`,
        `  Cluster-merge candidates: ${preview.clusterMerge} clusters`,
        `  Smart-compress candidates: ${preview.smartCompress} clusters`,
        `  Total: ${preview.total} items`,
      );
      if (args.detail === true) {
        if (preview.mergeClusters && preview.mergeClusters.length > 0) {
          lines.push('', '─── Cluster-merge details ───');
          for (const [i, cluster] of preview.mergeClusters.entries()) {
            lines.push(`  Cluster ${i + 1} (${cluster.length} obs, project=${cluster[0]?.project || '?'}):`);
            for (const obs of cluster) lines.push(`    #${obs.id} [${obs.type || 'change'}] ${truncate(obs.title || '(untitled)', 100)}`);
          }
        }
        if (preview.reenrichSamples && preview.reenrichSamples.length > 0) {
          lines.push('', '─── Re-enrich sample (first 20) ───');
          for (const obs of preview.reenrichSamples) {
            lines.push(`  #${obs.id} [${obs.type || 'change'}] (project=${obs.project || '?'}) ${truncate(obs.title || '(untitled)', 100)}`);
          }
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    const force = action === 'run_all';
    const results = await optimizeRun(db, {
      tasks: args.tasks,
      maxItems: args.max_items || 15,
      force,
      // T2-P0-B: scope parity with CLI (--scope wide). When omitted, optimizeRun defaults
      // to narrow via its own code; passing through keeps that fallback intact.
      reenrichScope: args.scope,
      project: args.project,
    });

    const lines = ['🔧 LLM Optimization Results:'];
    if (results.reenrich) lines.push(`  Re-enrich: ${results.reenrich.processed || 0} processed, ${results.reenrich.skipped || 0} skipped`);
    if (results.normalize) {
      if (results.normalize.skipped) lines.push(`  Normalize: skipped (${results.normalize.reason})`);
      else lines.push(`  Normalize: ${results.normalize.processed || 0} updated, ${results.normalize.groups || 0} synonym groups`);
    }
    if (results.clusterMerge) lines.push(`  Cluster-merge: ${results.clusterMerge.merged || 0} merged of ${results.clusterMerge.processed || 0} clusters`);
    if (results.smartCompress) lines.push(`  Smart-compress: ${results.smartCompress.compressed || 0} compressed of ${results.smartCompress.processed || 0} clusters`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: mem_registry ─────────────────────────────────────────────────────

server.registerTool(
  'mem_registry',
  {
    description: descriptionOf('mem_registry'),
    inputSchema: memRegistrySchema,
  },
  safeHandler(async (args) => {
    const rdb = getRegistryDb();
    if (!rdb) {
      return { content: [{ type: 'text', text: 'Registry DB not available. Run install first.' }], isError: true };
    }

    const action = args.action;

    if (action === 'search') {
      if (!args.query) {
        return { content: [{ type: 'text', text: 'search requires a query parameter' }], isError: true };
      }
      let results = searchResources(rdb, args.query, {
        type: args.type || undefined,
        limit: args.category || args.quality ? 20 : 10, // fetch more for post-filtering
      });
      // Apply category/quality filters if provided
      if (args.category) results = results.filter(r => r.category === args.category);
      if (args.quality) results = results.filter(r => r.quality_tier === args.quality);
      // Prioritize directly invocable resources (with invocation_name) over community resources
      results.sort((a, b) => {
        const aInvocable = a.invocation_name ? 1 : 0;
        const bInvocable = b.invocation_name ? 1 : 0;
        if (aInvocable !== bInvocable) return bInvocable - aInvocable;
        return 0; // preserve FTS5 ranking within same tier
      });
      results = results.slice(0, 5);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: `No matching resources for: "${args.query}"` }] };
      }
      const home = homedir();
      const toPortable = (p) => p && p.startsWith(home) ? '~' + p.slice(home.length) : (p || '');
      const lines = results.map(r => {
        const qualityBadge = r.quality_tier === 'installed' ? '[✓]' : r.quality_tier === 'verified' ? '[★]' : '[○]';
        const categoryLabel = r.category ? ` [${r.category}]` : '';
        const isManaged = r.local_path && r.local_path.includes(join(DB_DIR, 'managed') + sep);
        const portablePath = isManaged ? toPortable(r.local_path) : '';
        let howToUse;
        if (isManaged) {
          // Managed: use Read(path) or mem_use — Skill() won't work for managed resources
          // Agents always have complete .md paths (e.g., agents/group/agents/name.md)
          // Only skills can be directory paths (9 cases) — resolve to /SKILL.md
          const resolvedPath = portablePath.endsWith('.md') ? portablePath : `${portablePath}/SKILL.md`;
          howToUse = `Read("${resolvedPath}") or mem_use(name="${r.name}"${r.type === 'agent' ? ', type="agent"' : ''})`;
        } else if (r.invocation_name) {
          // Native plugin/user skill: Skill() with full invocation name
          howToUse = r.type === 'skill'
            ? `Skill("${r.invocation_name}")`
            : `Agent(subagent_type="${r.invocation_name}")`;
        } else {
          howToUse = `mem_use(name="${r.name}"${r.type === 'agent' ? ', type="agent"' : ''})`;
        }
        const pathLine = portablePath ? `\n  Path: ${portablePath}` : '';
        return `${qualityBadge} ${r.type === 'skill' ? 'S' : 'A'} **${r.name}**${categoryLabel} — ${truncate(r.capability_summary || '', 80)}${pathLine}\n  Use: ${howToUse}`;
      });
      return { content: [{ type: 'text', text: `Found ${results.length} resource(s) for "${args.query}":\n\n${lines.join('\n\n')}` }] };
    }

    if (action === 'list') {
      // Shared ranked query + row line (registry.mjs, P2-12) — single source with CLI list.
      const resources = listResourcesRanked(rdb, { type: args.type });
      if (resources.length === 0) return { content: [{ type: 'text', text: 'No resources found.' }] };
      const lines = resources.map(formatRegistryListLine);
      return { content: [{ type: 'text', text: `Resources (${resources.length}):\n${lines.join('\n')}` }] };
    }

    if (action === 'stats') {
      // Shared collection (registry.mjs collectRegistryStats, P2-12) — single
      // source with the CLI registry stats action.
      const s = collectRegistryStats(rdb);
      const lines = [
        `Registry Stats:`,
        `  Total active: ${s.total}`,
        ...s.byType.map(t => `  ${t.type}: ${t.c}`),
        `  User-added: ${s.userAdded}`,
        `  Zero adoption (recommended but never adopted): ${s.zeroAdopt}`,
      ];
      if (s.topAdopted.length > 0) {
        lines.push('', 'Top adopted:');
        for (const r of s.topAdopted) {
          lines.push(`  ${r.name} (${r.type}): ${r.adopt_count}/${r.recommend_count}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (action === 'import') {
      if (!args.name || !args.resource_type) {
        return { content: [{ type: 'text', text: 'import requires name and resource_type' }], isError: true };
      }
      // Provenance preservation + the 'installed' tier grant live in lib/registry-core.mjs,
      // shared with the `registry import` CLI twin (audit 2026-08-22 P1-3). Before that
      // extraction this side wrote its own SQL and silently skipped the tier grant.
      const fields = {};
      for (const f of IMPORT_STRING_FIELDS) fields[f] = args[f] || '';
      const { id } = importResource(rdb, {
        name: args.name, type: args.resource_type, source: args.source, fields,
      });
      return { content: [{ type: 'text', text: `Imported: ${args.resource_type}:${args.name} (id=${id})` }] };
    }

    if (action === 'remove') {
      if (!args.name || !args.resource_type) {
        return { content: [{ type: 'text', text: 'remove requires name and resource_type' }], isError: true };
      }
      const { removed } = removeResource(rdb, { name: args.name, type: args.resource_type });
      return { content: [{ type: 'text', text: removed ? `Removed: ${args.resource_type}:${args.name}` : 'Not found.' }] };
    }

    if (action === 'reindex') {
      const { activeCount } = reindexResources(rdb);
      return { content: [{ type: 'text', text: `FTS5 reindexed. ${activeCount} active resources.` }] };
    }

    if (action === 'import_url') {
      if (!args.url) {
        return { content: [{ type: 'text', text: 'import_url requires a url parameter' }], isError: true };
      }
      const { importFromGitHub } = await import('./registry-importer.mjs');
      try {
        const results = await importFromGitHub(rdb, args.url);
        if (results.length === 0) {
          return { content: [{ type: 'text', text: `No skills/agents found in: ${args.url}` }] };
        }

        let enrichMsg = '';
        if (args.enrich) {
          const { enrichResource } = await import('./registry-enricher.mjs');
          let ok = 0;
          for (const r of results) {
            const row = rdb.prepare('SELECT local_path FROM resources WHERE id = ?').get(r.id);
            if (!row?.local_path) continue;
            try {
              const content = readFileSync(row.local_path, 'utf8');
              if (await enrichResource(rdb, r.name, r.type, content)) ok++;
            } catch {}
          }
          enrichMsg = `\nEnriched: ${ok}/${results.length}`;
        }

        const lines = results.map(r => `${r.type === 'skill' ? 'S' : 'A'} ${r.name} (id=${r.id})`);
        return { content: [{ type: 'text', text: `Imported ${results.length} resource(s) from ${args.url}:\n${lines.join('\n')}${enrichMsg}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Import failed: ${e.message}` }], isError: true };
      }
    }

    if (action === 'enrich') {
      if (!args.name) {
        return { content: [{ type: 'text', text: 'enrich requires a name parameter' }], isError: true };
      }
      const row = rdb.prepare("SELECT name, type, local_path FROM resources WHERE name = ? AND status = 'active'").get(args.name);
      if (!row) {
        return { content: [{ type: 'text', text: `Resource not found: ${args.name}` }], isError: true };
      }
      if (!row.local_path) {
        return { content: [{ type: 'text', text: `No local_path for ${args.name}` }], isError: true };
      }
      // Confine to the env-aware data dir (managed/ relocates with CLAUDE_MEM_DIR, D#29);
      // === homedir when the env is unset, so non-relocated confinement is unchanged.
      const enrichBase = DB_DIR;
      if (!isPathConfined(row.local_path, enrichBase)) {
        return { content: [{ type: 'text', text: `Access denied: path outside managed directory` }], isError: true };
      }

      const { enrichResource } = await import('./registry-enricher.mjs');
      try {
        const content = readFileSync(row.local_path, 'utf8');
        const ok = await enrichResource(rdb, row.name, row.type, content);
        return { content: [{ type: 'text', text: ok ? `Enriched: ${args.name}` : `Enrichment failed for ${args.name}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Enrich error: ${e.message}` }], isError: true };
      }
    }

    return { content: [{ type: 'text', text: `Unknown action: ${action}. Valid: search, list, stats, import, remove, reindex, import_url, enrich` }], isError: true };
  })
);

// ─── Tool: mem_use ──────────────────────────────────────────────────────────

// Cap on the caller-supplied name echoed back in a miss message. Well past any real
// skill/agent name (the longest registered one here is 23 chars), short enough that an
// unbounded argument cannot pad the response — the echo appears twice.
const ECHO_NAME_MAX = 80;

server.registerTool(
  'mem_use',
  {
    description: descriptionOf('mem_use'),
    inputSchema: memUseSchema,
  },
  safeHandler(async (args) => {
    const rdb = getRegistryDb();
    if (!rdb) {
      return { content: [{ type: 'text', text: 'Registry DB not available.' }], isError: true };
    }

    const name = args.name.trim();
    const type = args.type || 'skill';

    // 1. Exact match by name or invocation_name — the ONLY path that loads content.
    const row = rdb.prepare(`
      SELECT id, name, type, local_path, invocation_name, capability_summary
      FROM resources
      WHERE status = 'active' AND type = ?
        AND (name = ? OR invocation_name = ?)
      LIMIT 1
    `).get(type, name, name);

    // 2. Name miss → SUGGEST, never substitute. The FTS5 search still runs (it is what
    // produces the candidate list), but its result is only ever rendered as names: loading
    // the top hit under the caller's requested name shipped a different skill's body inside
    // <skill-loaded> plus "Follow the instructions above to execute this <type>." — with
    // nothing marking the swap, so an agent that asked for A executed B (audit F1,
    // 2026-08-14: with only `deploy-rollback-runbook` registered, `deploy-notes` /
    // `rollback-checklist` / `runbook-index` each returned its full body). Loading stays an
    // exact-name decision the caller makes.
    if (!row) {
      let candidates = [];
      try { candidates = searchResources(rdb, name, { type, limit: 5 }).map((r) => r.name).filter(Boolean); }
      catch { /* a suggestion is best-effort; the miss message below still stands */ }
      // Every echo of the caller's own name below is bounded + delimiter-inert (audit F7):
      // raw interpolation let a crafted `name` forge a <skill-loaded> block and the execute
      // imperative inside this message, and the handler-wide defangResult cannot catch it —
      // <skill-loaded> is off CONTEXT_DELIMITER_RE precisely so the real load path can emit
      // it. `truncate` also folds newlines, so a multi-line name cannot fake block structure.
      // Registered names are defanged too (a crafted one can be imported), but NOT truncated:
      // the suggestion tells the caller to load one by its exact name, so it must stay exact.
      const echoed = neutralizeSkillDelimiters(truncate(name, ECHO_NAME_MAX));
      const echoedCandidates = candidates.map((n) => neutralizeSkillDelimiters(n));
      const head = `No ${type} found for "${echoed}".`;
      const browse = `mem_registry(action="search", query="${echoed}")`;
      if (candidates.length === 0) {
        return { content: [{ type: 'text', text: `${head} Try ${browse} to browse.` }] };
      }
      const list = echoedCandidates.map((n) => `  - ${n}`).join('\n');
      return { content: [{ type: 'text', text:
        `${head} Closest ${type}s by search (NOT loaded — none matched the name you asked for):\n${list}\n\n` +
        `Load one deliberately with its exact name, e.g. mem_use(name="${echoedCandidates[0]}"${type === 'skill' ? '' : `, type="${type}"`}), or browse with ${browse}.` }] };
    }

    // 3. Resolve path: directory skills → SKILL.md (agents always have full .md paths)
    let skillPath = row.local_path || '';
    if (skillPath && !skillPath.endsWith('.md')) {
      for (const candidate of [
        join(skillPath, 'SKILL.md'),
        join(skillPath, `skills/${row.name}/SKILL.md`),
      ]) {
        if (existsSync(candidate)) { skillPath = candidate; break; }
      }
    }

    // 4. Path confinement check — prevent reading arbitrary files via crafted local_path.
    // Base is the env-aware data dir (D#29): managed/ relocates with CLAUDE_MEM_DIR and
    // equals homedir when unset, so this does not weaken the non-relocated confinement.
    const managedBase = DB_DIR;
    if (skillPath && !isPathConfined(skillPath, managedBase)) {
      return { content: [{ type: 'text', text: `Access denied: path "${skillPath}" is outside managed directory` }], isError: true };
    }

    // 5. Read content
    let content;
    try {
      content = readFileSync(skillPath, 'utf8');
    } catch {
      const msg = skillPath.endsWith('.md')
        ? `Found ${type} "${row.name}" but cannot read file: ${skillPath}`
        : `Found ${type} "${row.name}" but no .md file in: ${skillPath}`;
      return { content: [{ type: 'text', text: msg }], isError: true };
    }

    // 5. Record invocation
    try {
      rdb.prepare(`
        INSERT INTO invocations (resource_id, session_id, trigger, adopted, outcome)
        VALUES (?, ?, 'user_explicit', 1, 'success')
      `).run(row.id, process.env.CLAUDE_SESSION_ID || 'unknown');
    } catch { /* non-critical */ }

    const _home = homedir();
    const portablePath = skillPath && skillPath.startsWith(_home) ? '~' + skillPath.slice(_home.length) : (skillPath || '');
    const pathAttr = portablePath ? ` path="${portablePath}"` : '';
    const reloadHint = portablePath ? ` Reload: Read("${portablePath}")` : '';
    return { content: [{ type: 'text', text: `<skill-loaded name="${row.name}" type="${row.type}"${pathAttr}>\n${content}\n</skill-loaded>\n\nFollow the instructions above to execute this ${row.type}.${reloadHint}` }] };
  }),
);

// ─── Tool: mem_update ────────────────────────────────────────────────────────

server.registerTool(
  'mem_update',
  {
    description: descriptionOf('mem_update'),
    inputSchema: memUpdateSchema,
  },
  safeHandler(async (args) => {
    // `obs_type` → `type`, same alias mem_save takes — see the schema comment.
    args = applyArgAliases(args, { obs_type: 'type' });
    const obs = db.prepare('SELECT id, title FROM observations WHERE id = ?').get(args.id);
    if (!obs) return { content: [{ type: 'text', text: `Observation #${args.id} not found` }], isError: true };

    // Shared mutation (lib/observation-write applyObsUpdate, P2-12): scrub + UPDATE +
    // derived-column rebuild in one transaction — single source with CLI cmdUpdate.
    const updatedCols = applyObsUpdate(db, args.id, {
      title: args.title, narrative: args.narrative, type: args.type,
      importance: args.importance, lesson_learned: args.lesson_learned, concepts: args.concepts,
    });
    if (updatedCols.length === 0) return { content: [{ type: 'text', text: 'No fields to update' }], isError: true };

    return { content: [{ type: 'text', text: `Updated observation #${args.id}: ${updatedCols.join(', ')}` }] };
  })
);

// ─── Tool: mem_export ────────────────────────────────────────────────────────

// In-process test seam (mirrors handleRecentForTest, #8743): threads an injected db
// through the SAME body the registered handler runs. NOTE: a `project` arg is still
// resolved via resolveProject() against the MODULE db, not the injected one.
export async function handleExportForTest(db, args) {
  return runExport(db, args);
}

async function runExport(db, args) {
  const wheres = [];
  const params = [];
  // Composed, not hand-written: the CLI twin (mem-cli.mjs cmdExport) already
  // routes through liveObsFilterSql, and a hand-rolled copy here is how the
  // live-row predicate drifted apart on other surfaces (P2-11/D#123). With
  // include_compressed the compressed half is dropped but retractions still
  // are not — tombstone export is opt-in, supersession is never exported.
  wheres.push(args.include_compressed ? 'superseded_at IS NULL' : liveObsFilterSql(''));
  if (args.project) { wheres.push('project = ?'); params.push(_resolveProjectShared(db, args.project)); }
  if (args.type) { wheres.push('type = ?'); params.push(args.type); }
  // T3-P1-A: surface invalid dates instead of silently dropping the filter — mirrors
  // mem_search, which threw. A dropped filter can quietly expand the export blast radius.
  if (args.date_from) {
    const epoch = new Date(args.date_from).getTime();
    if (isNaN(epoch)) throw new Error(`Invalid date_from: "${args.date_from}" (use ISO 8601 or YYYY-MM-DD)`);
    wheres.push('created_at_epoch >= ?');
    params.push(epoch);
  }
  if (args.date_to) {
    const d = args.date_to.length === 10 ? args.date_to + 'T23:59:59.999Z' : args.date_to;
    const epoch = new Date(d).getTime();
    if (isNaN(epoch)) throw new Error(`Invalid date_to: "${args.date_to}" (use ISO 8601 or YYYY-MM-DD)`);
    wheres.push('created_at_epoch <= ?');
    params.push(epoch);
  }

  const where = wheres.length > 0 ? 'WHERE ' + wheres.join(' AND ') : '';
  // No clamp (audit 2026-08-14 A2): `Math.min(args.limit ?? 200, 1000)` made an MCP-driven
  // backup of a >1000-row store impossible, on the tool whose own description says "USE
  // when: Backing up memory before a migration or reinstall" — while the CLI twin exported
  // the complete matching set (mem-cli.mjs cmdExport, fixed there for the same reason). The
  // DEFAULT stays 200: an MCP result is model context, so a bare exploratory call must not
  // dump a whole store into the transcript. An explicit limit is now honoured at any size.
  const exportLimit = args.limit ?? 200;
  // T3-P2-B: probe limit+1 so we can tell "user hit their own limit with more waiting" from
  // "user got exactly what existed". Trim to exportLimit before rendering.
  // EXPORT_COLUMNS_SQL: shared with CLI cmdExport — the full round-trippable set restore
  // reads back (v3.42 HIGH-2: this handler used to carry a narrower 16-col SELECT, silently
  // dropping text/aliases/citation-signals on the advertised MCP backup→restore flow).
  const probed = db.prepare(`SELECT ${EXPORT_COLUMNS_SQL} FROM observations ${where} ORDER BY created_at_epoch DESC LIMIT ?`).all(...params, exportLimit + 1);
  const rows = probed.slice(0, exportLimit);
  const moreAvailable = probed.length > exportLimit;

  if (rows.length === 0) return { content: [{ type: 'text', text: 'No observations found matching the criteria.' }] };

  const output = args.format === 'jsonl'
    ? rows.map(r => JSON.stringify(r)).join('\n')
    : JSON.stringify(rows, null, 2);

  // A truncated backup is the failure mode this tool must never produce quietly: the old
  // note ("Results capped at N … increase limit (max 1000)") never said how much was
  // missing, and its advice was a dead end on a store past the ceiling. Name the real
  // total, the number of rows left out, and a remedy that actually returns all of them.
  //
  // The remedy has to lead with a FILE REDIRECT (pre-tag review, 2026-08-14). Removing the
  // 1000-row ceiling took away the only bound on an MCP export's size, and the 200 default
  // is kept precisely because an MCP result IS model context — so "re-run with
  // limit: <total>", the previous first suggestion, told the caller to put the entire store
  // into one tool result (thin fixture rows measure ~612 bytes each, so a few-thousand-row
  // store is megabytes in a single message), and a bare `cli.mjs export` had the same
  // property unredirected. The limit re-run stays mentioned but demoted, with its cost
  // stated: it is occasionally what the caller actually wants, and silently dropping it
  // would send them back to guessing.
  let cap = '';
  if (moreAvailable) {
    const total = db.prepare(`SELECT COUNT(*) AS c FROM observations ${where}`).get(...params).c;
    cap = `\nWARNING — PARTIAL EXPORT, NOT A COMPLETE BACKUP: capped at ${exportLimit} of ${total} matching observations; ${total - exportLimit} rows are missing from this payload and restoring it would lose them.` +
      `\nFor a complete backup, write it to a FILE instead of pulling it through this conversation: \`${CLI_INVOKE} export --format jsonl > backup.jsonl\` (the CLI exports the complete set by default). Narrowing with date_from/date_to also works.` +
      `\nRaising \`limit\` here is the last resort, not the first: this result is model context, so all ${total} rows would be loaded into the transcript.`;
  }
  return { content: [{ type: 'text', text: `Exported ${rows.length} observations:${cap}\n${output}` }] };
}

server.registerTool(
  'mem_export',
  {
    description: descriptionOf('mem_export'),
    inputSchema: memExportSchema,
  },
  // verbatim: the export payload feeds `restore` — defanging it would silently
  // rewrite backed-up rows whose text legitimately contains these tags.
  safeHandler(
    async (args) => runExport(db, applyArgAliases(args, { from: 'date_from', to: 'date_to' })),
    { verbatim: true },
  )
);

// ─── Tool: mem_recall ────────────────────────────────────────────────────────

server.registerTool(
  'mem_recall',
  {
    description: descriptionOf('mem_recall'),
    inputSchema: memRecallSchema,
  },
  safeHandler(async (args) => {
    // Shared core with CLI cmdRecall: query + escaping + access bump (lib/recall-core.mjs)
    const { filename, rows } = recallByFile(db, args.file, {
      limit: args.limit ?? 10,
      includeNoise: args.include_noise === true,
    });

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: `No history for "${filename}". This file hasn't been observed yet.` }] };
    }

    const lines = [`History for ${filename} (${rows.length} observation${rows.length !== 1 ? 's' : ''}):\n`];
    for (const r of rows) {
      const lesson = r.lesson_learned ? `\n     Lesson: ${truncate(r.lesson_learned, 100)}` : '';
      lines.push(`#${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || '(untitled)')} | ${r.project} | ${fmtDate(r.created_at)}${lesson}`);
    }
    lines.push(`\nWorkflow: mem_get(ids=[...]) for full details`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Tool: mem_fts_check ─────────────────────────────────────────────────────
// Handler extracted to server/fts-check.mjs (v2.41 split).
import { handleMemFtsCheck } from './server/fts-check.mjs';

import { DAY_MS } from './lib/time-constants.mjs';
server.registerTool(
  'mem_fts_check',
  {
    description: descriptionOf('mem_fts_check'),
    inputSchema: memFtsCheckSchema,
  },
  safeHandler(async (args) => handleMemFtsCheck(db, args))
);

// ─── Tool: mem_browse ────────────────────────────────────────────────────────

server.registerTool(
  'mem_browse',
  {
    description: descriptionOf('mem_browse'),
    inputSchema: memBrowseSchema,
  },
  safeHandler(async (args) => {
    if (args.project) args = { ...args, project: resolveProject(args.project) };
    const project = args.project || inferProject();
    const tierFilter = args.tier || null;
    const limit = args.limit ?? (tierFilter ? 20 : 5);
    const now = Date.now();

    // Shared collection (lib/browse-core, P2-12) — single source with CLI browse.
    const { showTiers, tierData, tierCounts, grandTotal } = collectBrowseTiers(db, {
      project, tierFilter, limit, now,
      currentSessionId: getActiveMemorySessionId(db, project),
    });
    const tiers = BROWSE_TIERS;
    const tierLabels = BROWSE_TIER_LABELS;

    const lines = [`Memory Dashboard (${project})\n`];

    for (const tier of showTiers) {
      const { count, rows } = tierData[tier];
      lines.push(`${tierLabels[tier]} (${count})`);

      if (tier === 'archive' && !tierFilter) {
        if (count > 0) lines.push('');
        continue;
      }

      if (count === 0) { lines.push(''); continue; }

      for (const r of rows) {
        lines.push(`  #${r.id} ${typeIcon(r.type)} [${r.type}] ${truncate(r.title || '(untitled)', 80)} | ${fmtDate(r.created_at)}`);
      }
      if (count > rows.length) lines.push(`  ... and ${count - rows.length} more`);
      lines.push('');
    }

    if (grandTotal === 0) {
      return { content: [{ type: 'text', text: 'No observations found. Start a coding session to build memory.' }] };
    }

    if (!tierFilter) {
      const parts = tiers.map(t => `${t[0].toUpperCase() + t.slice(1)}: ${tierCounts[t] ?? 0}`);
      lines.push(`Totals: ${grandTotal} observations | ${parts.join(' | ')}`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  })
);

// ─── Hidden tool filter ─────────────────────────────────────────────────────
// All tools are registered (so `tools/call <name>` still resolves for scripts
// and direct MCP clients), but only the core tools appear in the `tools/list`
// response. Hiding the maintenance/admin tools keeps Claude Code's startup
// context small while preserving the contract that the plugin dogfoods (see
// the CLAUDE.md managed block + adopt-content.mjs detail doc).
// Surface counts as of v2.70.0: 9 core (mem_search/recent/timeline/get/save/
// recall + mem_defer/mem_defer_list/mem_defer_drop) + 11 hidden (maintenance/
// admin/specialized) = 20 registered; tests/tool-schemas.test.mjs is the
// authoritative count.
//
// Safe because:
//   - Protocol-layer override: we replace the mcp.js default ListTools
//     handler on the underlying Server (setRequestHandler is a Map.set).
//   - `enabled` stays true, so `tools/call` keeps routing normally — per
//     mcp.js line 106, a `disabled` tool would reject calls too.

const HIDDEN_TOOL_NAMES = new Set(
  TOOL_DEFS.filter((t) => t.hidden === true).map((t) => t.name),
);

// Opt-out: setting CLAUDE_MEM_ALL_TOOLS=1 restores pre-v2.34.0 behavior where
// every registered tool is visible in `tools/list`. Users who relied on Claude
// Code autonomously invoking the now-hidden maintenance tools can use this as
// an immediate escape hatch while adopting the CLI entry points documented in
// adopt-content.mjs / README.
const EXPOSE_ALL_TOOLS = process.env.CLAUDE_MEM_ALL_TOOLS === '1';

if (!EXPOSE_ALL_TOOLS) {
  // Force mcp.js to install its default ListTools/CallTools handlers before
  // we override; registerTool already did this, but keep the call explicit so
  // a future reorder of tool registration doesn't break the override.
  const originalHandler = server.server._requestHandlers.get('tools/list');
  if (typeof originalHandler !== 'function') {
    throw new Error('tools/list handler missing — server initialization order changed');
  }
  server.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
    const full = await originalHandler(req, extra);
    return { ...full, tools: full.tools.filter((t) => !HIDDEN_TOOL_NAMES.has(t.name)) };
  });
}

// One-time discoverability banner (stderr only — Claude Code surfaces it on
// session start). Skipped under MEM_QUIET_HOOKS=1 so CI / tests / hermeticity
// harnesses stay silent.
if (!effectiveQuiet()) {
  const status = EXPOSE_ALL_TOOLS
    ? `all ${TOOL_DEFS.length} tools exposed via CLAUDE_MEM_ALL_TOOLS=1`
    : `tools/list narrowed to ${TOOL_DEFS.length - HIDDEN_TOOL_NAMES.size} core tools (${HIDDEN_TOOL_NAMES.size} hidden but callable by exact name; unset CLAUDE_MEM_ALL_TOOLS to keep, set =1 to restore all)`;
  process.stderr.write(`[claude-mem-lite v${PKG_VERSION}] ${status}\n`);
}

// ─── WAL Checkpoint (periodic) ───────────────────────────────────────────────

// Checkpoint WAL every 5 minutes to prevent unbounded growth
const WAL_CHECKPOINT_INTERVAL = 5 * 60 * 1000;
const walTimer = setInterval(() => {
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (e) { debugCatch(e, 'walCheckpoint'); }
}, WAL_CHECKPOINT_INTERVAL);
walTimer.unref(); // Don't keep process alive just for checkpoints

// ─── Idle-Time Memory Optimization ──────────────────────────────────────────
// When no MCP requests for 5 minutes, run lightweight DB maintenance.
// lastMcpRequestTime and idleCleanupRan are declared near safeHandler (which updates them).

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

const idleTimer = setInterval(() => {
  if (idleCleanupRan) return;
  if (Date.now() - lastMcpRequestTime < IDLE_THRESHOLD_MS) return;
  idleCleanupRan = true;

  try {
    // Type-differentiated cleanup: higher-value types survive longer
    const { marked, compressed } = runIdleCleanup(db);
    if (marked > 0) debugLog('INFO', 'idle-cleanup', `Marked ${marked} stale observations as pending-purge`);
    if (compressed > 0) debugLog('INFO', 'idle-cleanup', `Compressed ${compressed} old observations`);

    // FTS5 index optimization (outside transaction — WAL-friendly)
    db.exec("INSERT INTO observations_fts(observations_fts) VALUES('optimize')");
    debugLog('DEBUG', 'idle-cleanup', 'FTS5 optimize complete');
  } catch (e) {
    debugCatch(e, 'idle-cleanup');
  }
}, 60000); // Check every minute
idleTimer.unref();

// ─── Shutdown Cleanup ────────────────────────────────────────────────────────

function shutdown(exitCode = 0) {
  clearInterval(walTimer);
  clearInterval(idleTimer);
  try { if (db) db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { if (db) db.close(); } catch {}
  try { if (registryDb) registryDb.close(); } catch {}
  process.exit(exitCode);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => { debugCatch(err, 'uncaughtException'); shutdown(1); });
process.on('unhandledRejection', (err) => { debugCatch(err, 'unhandledRejection'); shutdown(1); });

// ─── Runtime Dir Retention + Permissions ────────────────────────────────────

/** Spawn-log retention window — same 14 days as every sibling JSONL sink. */
export const SPAWN_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Hard ceiling for pathological spawn churn inside the retention window. */
export const SPAWN_LOG_MAX_LINES = 2000;

/**
 * Trim mcp-spawns.log to the retention window. The sibling sinks (lib/metrics,
 * lib/err-sampler, lib/hook-telemetry) shard per day and unlink old shards; this
 * sink is one flat file at a documented path, so the same 14-day window is applied
 * line-wise instead. Records without a parseable `ts` are dropped — the log is
 * append-only JSONL, so a malformed line is truncated telemetry, not data.
 * Only rewrites when something actually expires. Never throws.
 *
 * @param {string} path   Absolute path to mcp-spawns.log
 * @param {number} [nowMs]
 * @returns {number} lines removed
 */
export function pruneSpawnLog(path, nowMs = Date.now()) {
  try {
    if (!existsSync(path)) return 0;
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    // ISO-8601 sorts lexically = chronologically, so no Date.parse per line
    // (same trick as hook-telemetry.countRecentHookErrors).
    const cutoffIso = new Date(nowMs - SPAWN_LOG_RETENTION_MS).toISOString();
    let kept = lines.filter((l) => {
      try {
        const { ts } = JSON.parse(l);
        return typeof ts === 'string' && ts >= cutoffIso;
      } catch { return false; }
    });
    if (kept.length > SPAWN_LOG_MAX_LINES) kept = kept.slice(-SPAWN_LOG_MAX_LINES);
    if (kept.length === lines.length) return 0;
    writeFileSync(path, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });
    return lines.length - kept.length;
  } catch { return 0; }
}

/**
 * Restrict the runtime dir and its files to owner-only. Directory 0700 is the
 * load-bearing part (without +x another local user cannot traverse in); the
 * per-file 0600 is defense in depth and remediates files created before this fix.
 * Subdirectories are skipped — they are created with `{mode: 0o700}` by their own
 * sinks. Symlinks are skipped (Dirent.isFile() is false) so this never chmods
 * through to a target outside the runtime dir. Idempotent, never throws.
 *
 * @param {string} dir  Absolute path to RUNTIME_DIR
 * @returns {number} files chmod'ed
 */
export function hardenRuntimeFiles(dir) {
  try {
    if (!existsSync(dir)) return 0;
    chmodSync(dir, 0o700);
    let touched = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try { chmodSync(join(dir, entry.name), 0o600); touched++; } catch { /* per-entry, silent */ }
    }
    return touched;
  } catch { return 0; }
}

// ─── Start Server ───────────────────────────────────────────────────────────

// Spawn telemetry — appends one JSON line per process start so we can diagnose
// dual-registration (plugin namespace + local .mcp.json could both spawn the
// server in one Claude Code session). Two records with close timestamps and
// the same ppid is the smoking gun. Never throws — telemetry must not block
// startup. Disable with MEM_DISABLE_SPAWN_LOG=1.
//
// File mode: `{mode: 0o600}` on appendFileSync only applies on file creation
// (umask-default after the first append) — pre-v2.79.1 relied on it alone, so
// the "0600" claim was misleading. hardenRuntimeFiles below sets the mode for
// real, on every start, including logs created before this fix.
if (process.env.MEM_DISABLE_SPAWN_LOG !== '1') {
  try {
    if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      argv1: process.argv[1] || '',
      version: PKG_VERSION,
    }) + '\n';
    const spawnLog = join(RUNTIME_DIR, 'mcp-spawns.log');
    appendFileSync(spawnLog, line, { mode: 0o600 });
    // Lazy GC on append, mirroring lib/hook-telemetry.pruneOldShards. Single-file
    // sink (not day-sharded) so retention is applied line-wise instead.
    pruneSpawnLog(spawnLog);
  } catch { /* never block startup on telemetry failure */ }
}

// Owner-only for the whole runtime dir. Sibling aux files carry captured file
// paths (reads-<project>.txt) and scrubbed activity (ep-<project>.json), but were
// written at the default umask (0644) while the DB itself is 0600 / DB_DIR 0700
// (schema.mjs). The hooks that create them set the mode at creation; this sweep
// is what remediates files already on disk from before the fix.
hardenRuntimeFiles(RUNTIME_DIR);

const transport = new StdioServerTransport();
await server.connect(transport);
