// claude-mem-lite shared search-scoring / ranking helpers: re-ranking, supersede
// marking, PRF term extraction, concept-expansion — plus the MCP instructions
// builder and idle-cleanup/access-boost side helpers. Used by the MCP server,
// the CLI (mem-cli), and search-engine; originally extracted from server.mjs for
// testability (server.mjs has top-level side effects), hence the former
// "server-internals" name — renamed in audit P3 since it is not server-only.

import { debugCatch, COMPRESSED_AUTO, COMPRESSED_PENDING_PURGE, OBS_BM25 } from './utils.mjs';
import { BASE_STOP_WORDS } from './stop-words.mjs';
import { porterStem } from './tfidf.mjs';
import { CLI_INVOKE } from './cli-path.mjs';
import { liveObsFilterSql } from './lib/inject-search-core.mjs';

import { DAY_MS } from './lib/time-constants.mjs';
// ─── MCP Server Instructions Builder ───────────────────────────────────────
// Phase A (v2.31.3+): when quiet=true, drops WHEN-TO-USE proactive-trigger and
// Decision-rules sections; keeps the irreducible CLI/MCP tool list. Intended
// for users who adopted invited-memory (MEMORY.md sentinel carries the same
// triggers at higher authority). Default false preserves v2.31.2 behavior.
// The CLI-vs-MCP round-trip routing rule lives in BASE (not VERBOSE) on purpose:
// it must reach adopted (quiet) projects too, where tool-heavy sessions defer the
// mem_* tools behind ToolSearch (CLI via Bash = 1 model round-trip; ToolSearch +
// call = 2). Execution latency is NOT the lever — warm MCP (~25ms) actually beats
// CLI cold-start (~90ms); both are noise against one model turn. Round-trips are.

const INSTRUCTIONS_BASE = [
  'Long-term memory across sessions. Hooks auto-inject context (0 round-trips) — prefer adopting that over any call. For an explicit query, pick the path with fewer model round-trips (CLI vs MCP below).',
  '',
  `CLI (via Bash) — invoke as \`${CLI_INVOKE} <cmd>\` (resolves on any install shape; the bare \`claude-mem-lite\` shorthand works only after an optional global \`npm i -g claude-mem-lite\`):`,
  `  ${CLI_INVOKE} search "query"  — FTS5 full-text search`,
  `  ${CLI_INVOKE} search "err" --type bugfix  — filter by type`,
  `  ${CLI_INVOKE} recall "file.mjs"  — file-related memories`,
  `  ${CLI_INVOKE} recent 5  — latest observations`,
  `  ${CLI_INVOKE} get 42,43  — full details by ID`,
  `  ${CLI_INVOKE} timeline --anchor 42  — chronological context`,
  '',
  'MCP tools: mem_search, mem_recent, mem_save, mem_get, mem_recall, mem_timeline (plus mem_defer/mem_defer_list/mem_defer_drop for cross-session TODOs). If already loaded, call directly (warm server, fastest path). In tool-heavy sessions these are deferred behind ToolSearch — if using one would cost a ToolSearch load first, run the Bash CLI above instead: one call, not two. Neither needs a PATH/CLI install.',
  'mem_save: Save non-obvious insights (bugfix lessons, architecture decisions).',
  'Search tips: short keywords (2-3 words), filter with obs_type when relevant.',
];

const INSTRUCTIONS_VERBOSE = [
  '',
  'WHEN TO USE (proactive triggers during coding):',
  '  • About to Edit/Write a file → mem_recall(file="path") FIRST — past bugfixes & lessons',
  '  • Test failure or error → mem_search(query="error keywords", obs_type="bugfix")',
  '  • Before refactoring → mem_search(query="module-name", obs_type="refactor") for past decisions',
  '  • Starting new feature → mem_search(query="feature area") for prior art & patterns',
  '  • After fixing a tricky bug → mem_save(type="bugfix", lesson_learned="root cause & fix")',
  '  • After architecture decision → mem_save(type="decision", lesson_learned="rationale")',
  '  • Deferring work to a future session → mem_defer(title, priority, detail); when fixed, mem_save(..., closes_deferred=[N])',
  '  • Hook-injected context mentions #ID → mem_get(ids=[ID]) for full details',
  '',
  'Decision rules (use INSTEAD OF multi-step search):',
  '  • "what happened recently?" → mem_recent (NOT search with empty query)',
  '  • "what do we know about file.mjs?" → mem_recall (NOT grep + manual search)',
  '  • "show me around observation #42" → mem_timeline (NOT mem_get + manual navigation)',
  '  • "clean up old/duplicate memories" → mem_maintain (NOT manual mem_delete loop)',
  '  • "is the search index healthy?" → mem_fts_check (NOT manual COUNT queries)',
  '  • "overview of memory tiers" → mem_browse (NOT mem_search + manual grouping)',
  '  • "export for backup" → mem_export (NOT manual SELECT queries)',
];

export function buildServerInstructions(quiet = false) {
  if (quiet) return INSTRUCTIONS_BASE.join('\n');
  return [...INSTRUCTIONS_BASE, ...INSTRUCTIONS_VERBOSE].join('\n');
}

// ─── Search Re-ranking Helpers ────────────────────────────────────────────

/**
 * Re-rank search results by boosting scores for observations touching recently active files.
 * Mutates score fields on result objects in-place (BM25 negative scores).
 * @param {object} db better-sqlite3 database handle
 * @param {object[]} results Array of search result objects with source, score, files_modified
 * @param {string} project Current project name for scoping recent activity
 */
export function reRankWithContext(db, results, project) {
  if (!results || results.length === 0) return;
  // Get recently active files (last 2 hours, same project) via observation_files junction table
  const twoHoursAgo = Date.now() - 2 * 3600000;
  const recentFiles = db.prepare(`
    SELECT DISTINCT of2.filename FROM observation_files of2
    JOIN observations o ON o.id = of2.obs_id
    WHERE o.project = ? AND o.created_at_epoch > ?
  `).all(project, twoHoursAgo);

  const activeFiles = new Set(recentFiles.map(r => r.filename));
  if (activeFiles.size === 0) return;

  // Pre-compute active directories for directory-level matching
  const activeDirs = new Set();
  for (const f of activeFiles) {
    const lastSlash = f.lastIndexOf('/');
    if (lastSlash > 0) activeDirs.add(f.substring(0, lastSlash));
  }

  // Batch-fetch observation_files for all obs result IDs
  const obsResults = results.filter(r => r.source === 'obs' && r.id);
  if (obsResults.length === 0) return;
  const obsIds = obsResults.map(r => r.id);
  const placeholders = obsIds.map(() => '?').join(',');
  const fileRows = db.prepare(
    `SELECT obs_id, filename FROM observation_files WHERE obs_id IN (${placeholders})`
  ).all(...obsIds);

  // Build map: obs_id → [filenames]
  const obsFileMap = new Map();
  for (const row of fileRows) {
    if (!obsFileMap.has(row.obs_id)) obsFileMap.set(row.obs_id, []);
    obsFileMap.get(row.obs_id).push(row.filename);
  }

  for (const result of obsResults) {
    const resultFiles = obsFileMap.get(result.id);
    if (!resultFiles || resultFiles.length === 0) continue;
    const exactMatches = resultFiles.filter(f => activeFiles.has(f)).length;
    // Directory-level: same parent dir but different file (half weight)
    const dirMatches = resultFiles.filter(f => {
      if (activeFiles.has(f)) return false; // already counted as exact
      const lastSlash = f.lastIndexOf('/');
      return lastSlash > 0 && activeDirs.has(f.substring(0, lastSlash));
    }).length;
    const fileOverlap = (exactMatches + 0.5 * dirMatches) / resultFiles.length;
    // BM25 scores are negative — multiply by >1 makes more negative = better rank
    if (result.score !== null && result.score !== undefined && fileOverlap > 0) {
      result.score *= (1.0 + 0.3 * fileOverlap);
    }
  }
  // Note: caller re-sorts the main results array after this — no sort needed here
}

// ─── Pseudo-Relevance Feedback (PRF) ────────────────────────────────────────
// Two-phase document-level expansion: extract discriminative terms from top
// results' full text (title + narrative), filter out query terms + stop words,
// use TF-IDF-style scoring to find terms that appear in many top results.

/** @type {Set<string>} Common words excluded from PRF term extraction */
export const PRF_STOP_WORDS = new Set([
  ...BASE_STOP_WORDS,
  'use', 'used', 'using', 'new', 'added', 'updated',
  'file', 'files', 'code', 'change', 'changed', 'changes',
]);

/**
 * Extract discriminative terms from top search results for pseudo-relevance feedback.
 * Selects terms that appear in 2+ top documents but aren't already in the query.
 * @param {object[]} results Top search result objects with title and narrative fields
 * @param {string} ftsQuery The original FTS5 query (terms are excluded from output)
 * @param {number} [limit=3] Maximum number of expansion terms to return
 * @returns {string[]} Array of discriminative terms for query expansion
 */
export function extractPRFTerms(results, ftsQuery, limit = 3) {
  // Query tokens to exclude from expansion — stemmed so morphological variants of a
  // query term (e.g. "authenticate" when the user searched "authentication") are also
  // excluded, not just the exact surface form.
  const queryTokens = new Set(
    ftsQuery.replace(/["()]/g, ' ').split(/\s+/)
      .map(t => porterStem(t.toLowerCase()))
      .filter(t => t.length > 1 && t !== 'or' && t !== 'and')
  );

  // Bucket morphological variants by porter STEM so "cache"/"caching"/"cached" jointly
  // clear the ">= 2 docs" discriminativeness bar. But the SELECTED term must be a SURFACE
  // form: the emitted terms are fed back into `observations_fts MATCH` (search-engine.mjs),
  // and that index uses FTS5's DEFAULT unicode61 tokenizer — NO stemming (verified: MATCH
  // "cach" returns zero rows, only "caching"/"cache" match). Emitting a bare stem would
  // silently match nothing and kill expansion recall. Track each stem's surface forms with
  // their occurrence counts and emit the most frequent (best-matchable) surface.
  // Prototype-less: doc text tokenizes to arbitrary identifiers, and a stem that
  // collides with an Object.prototype property ("constructor" — common in code
  // narratives) made `stemSurfaces[stem] ||= new Map()` read the INHERITED function
  // as truthy, skip the assignment, and crash on sm.get (surfaced 2026-08-16 when
  // the M-2 gate fix first ran PRF over OR-rescued rows).
  const stemDocCount = Object.create(null);   // stem -> # of top docs it appears in (the >=2 bar)
  const stemSurfaces = Object.create(null);   // stem -> Map(surface -> total occurrences)
  const docCount = Math.min(results.length, 8);
  for (let i = 0; i < docCount; i++) {
    const r = results[i];
    const text = ((r.title || '') + ' ' + (r.narrative || '')).toLowerCase();
    const surfaces = text.replace(/[^a-z0-9_-]/g, ' ').split(/\s+/).filter(t => t.length >= 3);
    const docStems = new Set();
    for (const surface of surfaces) {
      // Stop-word filter at BOTH surface and stem level: PRF_STOP_WORDS lists surface
      // inflections ("changed"/"updated"/"files") whose porter stem ("chang"/"updat") is
      // not itself listed, so a stem-only check would let the surface through to emission.
      if (PRF_STOP_WORDS.has(surface)) continue;
      const stem = porterStem(surface);
      if (stem.length < 3 || PRF_STOP_WORDS.has(stem) || queryTokens.has(stem)) continue;
      const sm = (stemSurfaces[stem] ||= new Map());
      sm.set(surface, (sm.get(surface) || 0) + 1);
      docStems.add(stem);
    }
    for (const stem of docStems) stemDocCount[stem] = (stemDocCount[stem] || 0) + 1;
  }

  // Select stems appearing in >= 2 top docs (discriminative, not noise), emitting the
  // most frequent surface form of each so the term actually matches the unstemmed index.
  return Object.entries(stemDocCount)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([stem]) => {
      let best = null, bestN = -1;
      for (const [surface, n] of stemSurfaces[stem]) {
        if (n > bestN) { best = surface; bestN = n; }
      }
      return best;
    });
}

// ─── Concept Co-occurrence Query Expansion ─────────────────────────────────
// "Poor man's word2vec": find concepts that frequently co-occur with query
// terms in existing observations, then use them to supplement sparse results.

/**
 * Expand a search query by finding co-occurring concepts in matching observations.
 * Acts as a "poor man's word2vec" for concept-based query expansion.
 * @param {object} db better-sqlite3 database handle
 * @param {string} ftsQuery The FTS5 query to find concept neighbors for
 * @param {string} [project] Optional project filter
 * @returns {string[]} Array of concept terms for query expansion (max 3)
 */
export function expandQueryByConcepts(db, ftsQuery, project) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT o.concepts FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ? AND ${liveObsFilterSql('o')}
        AND (? IS NULL OR o.project = ?)
      ORDER BY ${OBS_BM25}
      LIMIT 20
    `).all(ftsQuery, project ?? null, project ?? null);
  } catch (e) { debugCatch(e, 'expandQueryByConcepts-fts'); return []; }

  if (rows.length === 0) return [];

  // Count concept frequencies across matched observations
  const freq = {};
  for (const row of rows) {
    for (const c of (row.concepts || '').split(/\s+/).filter(Boolean)) {
      const cl = c.toLowerCase();
      freq[cl] = (freq[cl] || 0) + 1;
    }
  }

  // Filter out terms already present in the query
  const queryTokens = new Set(
    ftsQuery.replace(/["()]/g, ' ').split(/\s+/)
      .map(t => t.toLowerCase())
      .filter(t => t.length > 1 && t !== 'or' && t !== 'and')
  );

  return Object.entries(freq)
    .filter(([c, count]) => count >= 2 && !queryTokens.has(c))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([concept]) => concept);
}

// ─── Auto-boost ─────────────────────────────────────────────────────────────

/**
 * Boost importance to 2 for observations that have been accessed multiple times
 * (access_count >= 2) but still have default importance (1).
 * Called after incrementing access_count in mem_get.
 * @param {object} db better-sqlite3 database handle
 * @param {number[]} ids Array of observation IDs to check
 */
export function autoBoostIfNeeded(db, ids) {
  if (!ids || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`
    UPDATE observations SET importance = 2
    WHERE id IN (${placeholders})
      AND COALESCE(importance, 1) = 1
      AND COALESCE(access_count, 0) >= 2
  `).run(...ids);
}

// ─── Idle Cleanup ────────────────────────────────────────────────────────────

/**
 * Run type-differentiated idle cleanup on stale observations.
 * Higher-value types (decision, discovery) survive longer than ephemeral types (change).
 * - Marks low-quality (importance<=1, never accessed) as pending-purge (COMPRESSED_PENDING_PURGE).
 * - Marks importance=1 accessed observations as auto-compressed (COMPRESSED_AUTO).
 * @param {object} db better-sqlite3 database handle
 * @returns {{ marked: number, compressed: number }}
 */
export function runIdleCleanup(db) {
  // SAFETY: type values are hardcoded constants, not user input
  const staleThresholds = [
    { types: "'decision','discovery'", days: 90 },
    { types: "'feature'", days: 60 },
    { types: "'bugfix','refactor'", days: 30 },
    { types: "'change'", days: 14 },
  ];

  let totalMarked = 0;
  let totalCompressed = 0;

  db.transaction(() => {
    for (const { types, days } of staleThresholds) {
      const cutoff = Date.now() - days * DAY_MS;

      const marked = db.prepare(`
        UPDATE observations SET compressed_into = ${COMPRESSED_PENDING_PURGE}
        WHERE importance <= 1 AND COALESCE(access_count, 0) = 0
          -- injection_count=0, the second half of decayAndMarkIdle's engagement guard
          -- (audit 2026-09-02 P0-4). Since v2.56 an injected-but-never-accessed row counts
          -- as PROVEN RELEVANT and decay protects it; this MCP sibling carried the lesson
          -- guard (CHANGELOG "the sixth enforcement site") and not this one, so a row the
          -- CLI/hook paths preserve was pending-purge'd 5 minutes into an idle server —
          -- the same guard-on-one-path shape the docblock below claims was consolidated.
          AND COALESCE(injection_count, 0) = 0
          AND type IN (${types})
          -- liveObsFilterSql, not compressed_into alone (P3-13), and the THIRD clause this
          -- MCP twin has had to be brought level on (lesson guard, then injection_count in
          -- audit P0-4, now this). A retired row's superseded_by column is the redirect the
          -- Stop citation loop follows to credit a #NN naming a corrected memory; purgeStale
          -- hard-deletes what this marks, and that destroys it. Same predicate, same
          -- reasoning, as decayAndMarkIdle's mark-idle pass -- the two are twins and drift
          -- here has cost data twice. The COMPRESSED_AUTO pass below deliberately does NOT
          -- get it: -1 is not deletable by any path, so a tombstone reaching it loses nothing.
          -- (No backticks: inside a JS template literal.)
          AND created_at_epoch < ? AND ${liveObsFilterSql('')}
          -- Never auto-mark a lesson-bearing row for purge. This idle path is the
          -- MCP-server sibling of maintain-core.decayAndMarkIdle and must carry the
          -- SAME "lessons never auto-GC" guard; without it a lesson demoted to imp≤1
          -- by citation-decay gets pending-purge'd here and hard-deleted by purgeStale.
          AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
      `).run(cutoff);
      totalMarked += marked.changes;

      const compressed = db.prepare(`
        UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}
        WHERE COALESCE(compressed_into, 0) = 0 AND importance = 1
          -- Same engagement guard as the mark-idle pass above: COMPRESSED_AUTO also hides
          -- the row from every retrieval surface, so an injected row must not reach it.
          AND COALESCE(injection_count, 0) = 0
          AND type IN (${types})
          AND created_at_epoch < ?
          -- Same lesson guard: auto-compress (-1) hides the row from all retrieval and
          -- recoverBuriedLessons only re-floors live (compressed_into=0) rows, so a
          -- compressed lesson is unrecoverable. Parity with selectCompressionCandidates.
          AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
      `).run(cutoff);
      totalCompressed += compressed.changes;
    }
  })();

  return { marked: totalMarked, compressed: totalCompressed };
}
