// claude-mem-lite shared search-scoring / ranking helpers: re-ranking, PRF term
// extraction, concept-expansion — plus the MCP instructions
// builder and idle-cleanup/access-boost side helpers. Used by the MCP server,
// the CLI (mem-cli), and search-engine; originally extracted from server.mjs for
// testability (server.mjs has top-level side effects), hence the former
// "server-internals" name — renamed in audit P3 since it is not server-only.

import {
  debugCatch,
  COMPRESSED_AUTO,
  NOT_COMPRESSION_KEEPER_SQL,
  NOT_EXPLICIT_SAVE_SQL,
  OBS_BM25,
} from './utils.mjs';
import { BASE_STOP_WORDS } from './stop-words.mjs';
import { porterStem } from './tfidf.mjs';
import { CLI_INVOKE } from './cli-path.mjs';
import { liveObsFilterSql } from './lib/inject-search-core.mjs';

import { DAY_MS } from './lib/time-constants.mjs';
// The pinned-but-uncited threshold, from the module that OWNS the rule (`demotePinned` and
// its forecast both read it there). Imported rather than restated: a second hand-typed copy
// of this number is exactly what produced the `inj>=8` report-string drift in server.mjs.
// (The v3.76.0 scan-vs-execute drift was a different constant — two copies of the FLOOR,
// `importance > 1`; do not cite it for this one.) The edge is cheap: `lib/maintain-core.mjs`
// has five direct imports — `utils.mjs`, `lib/dedup-constants.mjs`,
// `lib/inject-search-core.mjs`, `lib/time-constants.mjs` and `lib/db-backup.mjs` — three of
// which this module already imports directly, and the 16-file closure resolves to nothing
// but node builtins (`fs`, `path`, `child_process`, `node:os`, `node:path`) — no
// third-party package, so no native dependency, and no edge back to this file (the three
// "search-scoring" strings in that graph are all comments).
import { PINNED_INJ_THRESHOLD } from './lib/maintain-core.mjs';
// ─── MCP Server Instructions Builder ───────────────────────────────────────
// Phase A (v2.31.3+): when quiet=true, drops WHEN-TO-USE proactive-trigger and
// Decision-rules sections; keeps the irreducible CLI/MCP tool list. Intended
// for users who adopted invited-memory (the steering block carries the same
// triggers). Default false preserves v2.31.2 behavior.
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
  // R3 O6: the write verbs with their flags, so a CLI write does not start with a `help` call
  // (the full help is 15.7 KB).
  // tests/instructions-cli-write-lines.test.mjs runs both lines as written.
  `  ${CLI_INVOKE} defer add "<title>" --priority 1|2|3 --detail "<why>"  — cross-session TODO (3 = urgent)`,
  `  ${CLI_INVOKE} save "<what happened>" --type bugfix --lesson "<root cause + fix>" --files <path>  — save a lesson (--files ties it to file recall)`,
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
  '  • "clean up old/duplicate memories" → CLI `maintain scan` to preview; the cleanup itself is /claude-mem-lite:update, which the user starts (NOT deleting rows one by one)',
  '  • "is the search index healthy?" → CLI `fts-check check` (NOT manual COUNT queries)',
  '  • "overview of memory tiers" → CLI `browse` (NOT mem_search + manual grouping)',
  '  • "export for backup" → CLI `export` (NOT manual SELECT queries)',
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
  const recentFiles = db
    .prepare(
      `
    SELECT DISTINCT of2.filename FROM observation_files of2
    JOIN observations o ON o.id = of2.obs_id
    -- R11 A-P3-3: liveObsFilterSql, not the bare window. This is a READ path, so it is
    -- outside the settled list of 11 observation WRITES, and it was granting a boost of
    -- up to 1.3x from filenames contributed by rows no retrieval surface can return.
    -- The superseded half is the one that fires unattended (exact auto-dedup tombstones
    -- a duplicate save immediately); every automatic compressed_into writer gates on a
    -- 14-day floor, so that half needs an explicit \`compress\` to reach a fresh row.
    WHERE o.project = ? AND o.created_at_epoch > ? AND ${liveObsFilterSql('o')}
  `,
    )
    .all(project, twoHoursAgo);

  const activeFiles = new Set(recentFiles.map((r) => r.filename));
  if (activeFiles.size === 0) return;

  // Pre-compute active directories for directory-level matching
  const activeDirs = new Set();
  for (const f of activeFiles) {
    const lastSlash = f.lastIndexOf('/');
    if (lastSlash > 0) activeDirs.add(f.substring(0, lastSlash));
  }

  // Batch-fetch observation_files for all obs result IDs
  const obsResults = results.filter((r) => r.source === 'obs' && r.id);
  if (obsResults.length === 0) return;
  const obsIds = obsResults.map((r) => r.id);
  const placeholders = obsIds.map(() => '?').join(',');
  const fileRows = db
    .prepare(`SELECT obs_id, filename FROM observation_files WHERE obs_id IN (${placeholders})`)
    .all(...obsIds);

  // Build map: obs_id → [filenames]
  const obsFileMap = new Map();
  for (const row of fileRows) {
    if (!obsFileMap.has(row.obs_id)) obsFileMap.set(row.obs_id, []);
    obsFileMap.get(row.obs_id).push(row.filename);
  }

  for (const result of obsResults) {
    const resultFiles = obsFileMap.get(result.id);
    if (!resultFiles || resultFiles.length === 0) continue;
    const exactMatches = resultFiles.filter((f) => activeFiles.has(f)).length;
    // Directory-level: same parent dir but different file (half weight)
    const dirMatches = resultFiles.filter((f) => {
      if (activeFiles.has(f)) return false; // already counted as exact
      const lastSlash = f.lastIndexOf('/');
      return lastSlash > 0 && activeDirs.has(f.substring(0, lastSlash));
    }).length;
    const fileOverlap = (exactMatches + 0.5 * dirMatches) / resultFiles.length;
    // BM25 scores are negative — multiply by >1 makes more negative = better rank
    if (result.score !== null && result.score !== undefined && fileOverlap > 0) {
      result.score *= 1.0 + 0.3 * fileOverlap;
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
  'use',
  'used',
  'using',
  'new',
  'added',
  'updated',
  'file',
  'files',
  'code',
  'change',
  'changed',
  'changes',
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
    ftsQuery
      .replace(/["()]/g, ' ')
      .split(/\s+/)
      .map((t) => porterStem(t.toLowerCase()))
      .filter((t) => t.length > 1 && t !== 'or' && t !== 'and'),
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
  const stemDocCount = Object.create(null); // stem -> # of top docs it appears in (the >=2 bar)
  const stemSurfaces = Object.create(null); // stem -> Map(surface -> total occurrences)
  const docCount = Math.min(results.length, 8);
  for (let i = 0; i < docCount; i++) {
    const r = results[i];
    const text = ((r.title || '') + ' ' + (r.narrative || '')).toLowerCase();
    const surfaces = text
      .replace(/[^a-z0-9_-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3);
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
      let best = null,
        bestN = -1;
      for (const [surface, n] of stemSurfaces[stem]) {
        if (n > bestN) {
          best = surface;
          bestN = n;
        }
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
    rows = db
      .prepare(
        `
      SELECT o.concepts FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ? AND ${liveObsFilterSql('o')}
        AND (? IS NULL OR o.project = ?)
      ORDER BY ${OBS_BM25}, o.id DESC
      LIMIT 20
    `,
      )
      .all(ftsQuery, project ?? null, project ?? null);
  } catch (e) {
    debugCatch(e, 'expandQueryByConcepts-fts');
    return [];
  }

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
    ftsQuery
      .replace(/["()]/g, ' ')
      .split(/\s+/)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length > 1 && t !== 'or' && t !== 'and'),
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
 *
 * A PROMOTER OUTSIDE THE MAINTENANCE RUN. `lib/maintain-core.mjs`'s DEFAULT_MAINTAIN_OPS
 * docblock records `boostAccessed` and `demotePinned` as opponents, and names TWO separate
 * defects it closed — keep them apart: the automatic path promoted and never demoted
 * because `demote_pinned` was in nobody's default set and hook.mjs did not import it, while
 * the two faces that DID wire the op ran it in opposite orders. The 148/148 figure quoted
 * there is rows sitting back at importance>=3 that were BOOST-ELIGIBLE, not rows this op
 * would have moved — CHANGELOG.md narrows the reachable-by-demotePinned count to 7.
 *
 * Both of those fixes act INSIDE a maintenance run. This function fires from
 * `fetchObsDetail`, so it is a promoter neither a default-set nor an ordering fix can reach:
 * every `get` / `mem_get` was another chance to hand the row straight back — the same
 * sentence that docblock uses for the bug it closed.
 *
 * Reproduced end-to-end before this clause: `maintain execute --ops demote_pinned` floors a
 * pinned-but-uncited row 2 -> 1, and ONE subsequent `get` returned it to 2. So an op in the
 * default maintain set (`lib/maintain-core.mjs` DEFAULT_MAINTAIN_OPS) had an effect any read
 * reverted, on its own target population.
 *
 * Population, stated rather than implied (doctrine rule 3): on the maintainer's DB sampled
 * 2026-09-14T20:14:16Z, 67 live rows, 3 pinned-but-uncited, and 0 of those had reached
 * access_count >= 2 — `injection_count` does not bump `access_count`, so the overlap needs
 * two explicit reads and was unrealised there. The mechanism is deterministic; the observed
 * incidence on that corpus is zero, and this is a snapshot of one corpus, not a property.
 *
 * WHAT THIS DELIBERATELY DOES NOT FIX. `importance = 1` is also what an explicit
 * `claude-mem-lite update N --importance 1` writes, and that demotion is reverted by the
 * next read exactly the same way — worse, INSPECTING the row is what pushes access_count to
 * 2 in the first place. Separating "1 because nobody set it" from "1 because a human said
 * so" needs a marker this schema does not have, and `demoted_at` is not it — for a reason
 * the first draft of this paragraph got wrong, so it is stated precisely: nothing keys on
 * `demoted_at IS NULL` (the sole non-test reader, `mem-cli.mjs`'s decay-queue report, keys
 * on IS NOT NULL), so a write here would not evict anything — it would ADD the row to that
 * report, and `applyCitationDecay` CLEARS the column on the row's first citation, silently
 * discarding a human's demotion. Wrong owner, wrong lifetime. Left as a design decision
 * rather than patched around.
 *
 * THE EXCLUSION IS demotePinned's FLOOR, NOT ITS TRIGGER. `PINNED_FLOOR_SQL` in
 * lib/maintain-core.mjs is `CASE WHEN <no lesson> THEN 1 ELSE 2 END`, so a LESSON-BEARING
 * pinned row is floored at 2 and boosting it 1 -> 2 lands it exactly on that floor. The
 * first cut of this clause copied the trigger (`inj >= N AND cited = 0`) without the floor
 * and stranded those rows at 1, below the bound maintain-core declares for them — and 16 of
 * the 17 rows that op would have moved on the maintainer's DB were lesson-bearing. The
 * predicate below must keep selecting exactly the rows demotePinned would floor to 1.
 *
 * The no-lesson clause is COPIED rather than imported: `NO_LESSON_SQL` and `PINNED_FLOOR_SQL`
 * are module-private in maintain-core by an explicit decision recorded there ("exporting by
 * habit is how the knip baseline drifts"), and five verbatim copies already live in that
 * file. The prose stays out here in the docblock rather than inside the SQL string, because
 * a backtick in a template literal ends it — that cost one parse error on this very edit.
 *
 * @param {object} db better-sqlite3 database handle
 * @param {number[]} ids Array of observation IDs to check
 */
export function autoBoostIfNeeded(db, ids) {
  if (!ids || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `
    UPDATE observations SET importance = 2
    WHERE id IN (${placeholders})
      AND COALESCE(importance, 1) = 1
      -- D10: not an importance a person set (update --importance / mem_update).
      AND importance_set_at IS NULL
      AND COALESCE(access_count, 0) >= 2
      -- Exactly the rows demotePinned would floor to 1 (see the docblock above).
      AND NOT (
        COALESCE(injection_count, 0) >= ${PINNED_INJ_THRESHOLD}
        AND COALESCE(cited_count, 0) = 0
        AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
      )
  `,
  ).run(...ids);
}

// ─── Idle Cleanup ────────────────────────────────────────────────────────────

/**
 * Run type-differentiated idle cleanup on stale observations.
 * Higher-value types (decision, discovery) survive longer than ephemeral types (change).
 * - Hides low-quality (importance<=1, never accessed) rows (COMPRESSED_AUTO + hidden_at); since D12
 *   maintain-core decayAndMarkIdle queues one for purge only after HIDE_GRACE_MS idle.
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

      const marked = db
        .prepare(
          `
        -- D12: HIDE (COMPRESSED_AUTO + hidden_at), no longer queue for purge directly —
        -- maintain-core decayAndMarkIdle queues a hidden row only after HIDE_GRACE_MS idle.
        UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}, hidden_at = ?
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
          AND ${NOT_COMPRESSION_KEEPER_SQL}
          AND ${NOT_EXPLICIT_SAVE_SQL}
      `,
        )
        .run(Date.now(), cutoff);
      totalMarked += marked.changes;

      const compressed = db
        .prepare(
          `
        UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}, hidden_at = ?
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
          AND ${NOT_COMPRESSION_KEEPER_SQL}
          AND ${NOT_EXPLICIT_SAVE_SQL}
      `,
        )
        .run(Date.now(), cutoff);
      totalCompressed += compressed.changes;
    }
  })();

  return { marked: totalMarked, compressed: totalCompressed };
}
