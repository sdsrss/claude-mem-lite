// Shared maintenance operations — single source of truth for cmdMaintain (CLI),
// mem_maintain (MCP), and handleAutoMaintain (hook). Pre-extraction each
// operation's SQL was copy-pasted across the call sites and kept in sync by
// "parity" comments, which had already drifted: the CLI/hook `decay` and
// `mark-idle` protect injection_count>0 (v2.56.0 — an obs Claude was shown 8×
// is contextually proven), but the MCP copy never got that clause, so
// mem_maintain decayed/purged injected memories the other two paths preserve.
// Consolidating here UNIFIES decay/mark-idle on the protected (correct) form.
//
// Every mutation is statement-only — the CALLER owns the transaction boundary
// (CLI/MCP wrap the execute ops in one transaction; the hook runs them in its
// auto-maintain block). `ctx` carries the per-caller knobs:
//   { projectFilter: 'AND project = ?' | '', baseParams: [project?] , staleAge, opCap }

import { COMPRESSED_AUTO, COMPRESSED_PENDING_PURGE, computeMinHash, estimateJaccardFromMinHash, jaccardSimilarity } from '../utils.mjs';
import { rebuildVocabulary, computeVector, _resetVocabCache, vectorsEnabled, vecTextForRow } from '../tfidf.mjs';
import { DEDUP_JACCARD_THRESHOLD, MINHASH_PRE_THRESHOLD as MINHASH_PRE_THRESHOLD_SRC, FUZZY_DEDUP_THRESHOLD, FUZZY_BODY_THRESHOLD, MINHASH_PREFILTER } from './dedup-constants.mjs';
import { liveObsFilterSql } from './inject-search-core.mjs';

import { DAY_MS } from './time-constants.mjs';
import { snapshotDb } from './db-backup.mjs';
export const STALE_AGE_MS = 30 * DAY_MS;
export const OP_CAP = 1000;
export const SCAN_LIMIT = 500;
export const DUPLICATE_LIMIT = 50;
// Back-compat: maintain-core historically exported these names; both now source
// their value from the single canonical lib/dedup-constants.mjs.
export const SIMILARITY_THRESHOLD = DEDUP_JACCARD_THRESHOLD;
export const MINHASH_PRE_THRESHOLD = MINHASH_PRE_THRESHOLD_SRC;
// A memory injected this many times with zero citations is "pinned noise" that
// the regular decay op can't touch (decay protects injection_count>0).
export const PINNED_INJ_THRESHOLD = 8;

// Single home for the default maintenance op set AND its order.
//
// Three faces run maintenance — hook.mjs auto-maintain, CLI `maintain execute`,
// MCP `mem_maintain` — and each used to hand-list its own default set. They had
// drifted in both ways a hand-copied list can:
//   - `demote_pinned` was in NOBODY's default set, and hook.mjs did not even
//     import demotePinned. Its opponent `boostAccessed` was in all three. So the
//     automatic path promoted and never demoted: measured on the maintainer's live
//     DB, 148 rows sat demoted-by-citation-decay, never cited, and back at
//     importance>=3 — 148/148 of them boostAccessed-eligible (access_count>3).
//   - the two faces that DID wire the op ran it in opposite orders: mem-cli did
//     demote-then-boost, which hands the row straight back (importance 1 → 2);
//     server.mjs did boost-then-demote, which lands it at 1.
// Hence: order matters, and `demote_pinned` MUST come after `boost`.
export const DEFAULT_MAINTAIN_OPS = Object.freeze(['cleanup', 'decay', 'boost', 'demote_pinned']);

// Opt-out for the v3.76.0 default change. Scoped to the DEFAULT set ONLY — an
// explicit `--ops demote_pinned` / `operations:["demote_pinned"]` still runs. An
// accepted value that silently means something else is worse than an unsupported
// one (cf. CLAUDE_MEM_RECOMMEND_MODE=live, which parses and then does not do what
// it says).
// The first cut of this compared `=== '1'`, which silently ignored `=true` / `=yes` /
// `= 1` — precisely the failure mode the comment above warns about, committed three
// lines under it. Sibling skip-flags in this repo are bare truthiness checks
// (`if (!process.env.CLAUDE_MEM_SKIP_COMPRESS)`), so any non-empty value opts out;
// the falsey WORDS are honoured too, because `=0` or `=false` reading as "skip" is the
// same class of silent surprise in the other direction.
function envFlagEnabled(raw) {
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

export function resolveDefaultMaintainOps(env = process.env) {
  return envFlagEnabled(env?.CLAUDE_MEM_SKIP_DEMOTE_PINNED)
    ? DEFAULT_MAINTAIN_OPS.filter((op) => op !== 'demote_pinned')
    : [...DEFAULT_MAINTAIN_OPS];
}

// Two trimmed bodies count as "the same body" when both are empty (a genuine
// no-body re-save) or their word-set Jaccard clears the floor. One-empty-one-not
// is treated as DISTINCT so a body-bearing observation is never hidden by a
// body-less peer that merely shares its title.
function bodiesSimilar(a, b, threshold) {
  const ba = (a || '').trim();
  const bb = (b || '').trim();
  if (!ba && !bb) return true;
  if (!ba || !bb) return false;
  return jaccardSimilarity(ba, bb) >= threshold;
}

/**
 * Pick which near-duplicate observation ids to supersede in the hook fuzzy-dedup
 * pass. Pure (no DB) so it is unit-testable. A pair must clear BOTH the title
 * thresholds (MinHash prefilter → exact title Jaccard) AND the body Jaccard floor
 * before the lower-importance row is marked for superseding (audit #8 — title-only
 * matching collapsed observations with the same title token-set but different bodies).
 * @param {Array<{id:number,title:string,body:string,importance:number}>} rows
 *        Candidate rows in scan order (caller decides ordering / recency window).
 * @returns {number[]} ids to supersede (lower-importance member of each kept pair).
 */
export function selectFuzzyDedupeIds(rows, {
  titleThreshold = FUZZY_DEDUP_THRESHOLD,
  bodyThreshold = FUZZY_BODY_THRESHOLD,
  minhashPrefilter = MINHASH_PREFILTER,
  maxMerges = 20,
} = {}) {
  const removeIds = [];
  if (!Array.isArray(rows) || rows.length < 2) return removeIds;
  const removed = new Set();
  const titles = rows.map(r => (r.title || '').trim());
  const minhashes = titles.map(t => t ? computeMinHash(t) : null);
  outer: for (let i = 0; i < rows.length; i++) {
    if (!minhashes[i] || removed.has(rows[i].id)) continue;
    for (let j = i + 1; j < rows.length; j++) {
      if (!minhashes[j] || removed.has(rows[j].id)) continue;
      if (estimateJaccardFromMinHash(minhashes[i], minhashes[j]) < minhashPrefilter) continue;
      if (jaccardSimilarity(titles[i], titles[j]) < titleThreshold) continue;
      if (!bodiesSimilar(rows[i].body, rows[j].body, bodyThreshold)) continue;
      // Keep the higher-importance row; tiebreak by earlier scan position (kept as i).
      const keep = (rows[i].importance ?? 1) >= (rows[j].importance ?? 1) ? rows[i] : rows[j];
      const remove = keep === rows[i] ? rows[j] : rows[i];
      removeIds.push(remove.id);
      removed.add(remove.id);
      if (removeIds.length >= maxMerges) break outer;
    }
  }
  return removeIds;
}

/**
 * Tombstone the ids an auto-dedup pass selected.
 *
 * `AND superseded_at IS NULL` is the load-bearing half. Both dedup channels select live
 * rows and then stamp them, and between those two steps another writer can supersede a
 * row — `save --supersedes=[#A]` writes A.superseded_by = B's NUMERIC id, and the chain
 * citation-tracker's decay hand-off and timeline re-anchoring both follow. An unguarded
 * UPDATE overwrites that numeric chain with the string marker and the chain silently dead-
 * ends. The window is narrow and the failure is not reproducible on demand, which is
 * exactly why it survived seven rounds of this invariant being re-broken.
 *
 * The exact channel grew this guard in v3.63; the fuzzy channel did not, and the audit of
 * 2026-08-22 (P2-1) found the asymmetry still open. Both channels now stamp through this
 * one function, so the guard cannot be present on one and missing on the other.
 *
 * @param {object} db open DB handle
 * @param {number[]} ids observation ids selected for superseding
 * @param {string} marker superseded_by value ('auto-dedup' | 'auto-dedup-fuzzy')
 * @returns {number} rows actually stamped — less than ids.length means the guard held
 */
export function stampDedupSuperseded(db, ids, marker) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const ph = ids.map(() => '?').join(',');
  const res = db.prepare(
    `UPDATE observations SET superseded_at = ?, superseded_by = ?
     WHERE id IN (${ph}) AND superseded_at IS NULL`
  ).run(Date.now(), marker, ...ids);
  return res.changes;
}

/**
 * Mark auto-compressible observations for one project — the two full-table conditional
 * UPDATEs that used to run inside the SessionStart transaction on every single boot
 * (audit 2026-08-22, P2-11). They are maintenance by definition: nothing about a new
 * session makes a 30-day-old row newly compressible, and the same 24h auto-maintain gate
 * that guards decay/purge/backup was already sitting right next to them.
 *
 * Both predicates are unchanged, including the project scope — this moves *when* the
 * marking runs, not *what* it marks.
 *
 * @param {object} db open DB handle
 * @param {string} project project scope (unchanged from the SessionStart behavior)
 * @param {object} [opts]
 * @param {number} [opts.agedAgeMs] age floor for the general 30d pass
 * @param {number} [opts.noiseAgeMs] age floor for the accelerated 7d LOW_SIGNAL pass
 * @returns {{aged: number, noise: number}} rows marked by each pass
 */
export function markAutoCompressible(db, project, {
  agedAgeMs = 30 * DAY_MS,
  noiseAgeMs = 7 * DAY_MS,
} = {}) {
  if (!project) return { aged: 0, noise: 0 };
  const now = Date.now();

  // v2.56.0 #4: protect injection_count > 0 obs (proven contextually relevant via
  // hook-memory injection, even if the user never explicitly fetched them).
  // `<= 1` (was `= 1`): citation-decay floors importance at 0 and the LLM low-signal
  // filter saves at imp=0 — those rows are STRICTLY lower value than imp=1 yet escaped
  // GC, accumulating to ~40% of a mature DB (immortal: hidden from injection by the
  // imp>=1 floor, but visible as explicit-search noise).
  // v3.23: never auto-hide a row that carries a real lesson — compression folds sources
  // into a title-only summary (lesson lost) and COMPRESSED_AUTO hides the row from search
  // entirely (audit: 62 lessons buried this way).
  const aged = db.prepare(`
    UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}
    WHERE COALESCE(compressed_into, 0) = 0
      AND COALESCE(importance, 1) <= 1
      AND COALESCE(injection_count, 0) = 0
      AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
      AND created_at_epoch < ?
      AND project = ?
  `).run(now - agedAgeMs, project).changes;

  // v2.47 P0-3: accelerated pass for LOW_SIGNAL + no-signal noise — 7 days instead of 30.
  // The write-side capNoiseImportance already forces imp=1 on these; this only shrinks GC
  // latency so the corpus reduction materializes within a week instead of bleeding into
  // the 30-day tier.
  //
  // v3.76.0: `injection_count = 0` added here to match the aged pass above, which has
  // carried it since v2.56.0. Until this release nothing could reach BOTH `importance<=1`
  // and `injection_count>=1`, so the omission was unobservable; `demote_pinned` joining
  // the default op set creates exactly that population. Without this clause a demoted row
  // could be marked COMPRESSED_AUTO on the NEXT maintain run — hidden from every
  // `COALESCE(compressed_into,0)=0` read path, therefore never injected, therefore never
  // cited, therefore with no path back. Pre-tag review reproduced that chain end to end.
  // Today the two passes are also protected by an interlock — the title patterns below
  // are the same set `notLowSignalTitleClause` (lib/low-signal-patterns.mjs) keeps off the
  // only surfaces that bump `injection_count` — but that is two hand-listed sets in two
  // files agreeing by maintenance, which is not a guarantee. This clause is.
  const noise = db.prepare(`
    UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}
    WHERE COALESCE(compressed_into, 0) = 0
      AND COALESCE(importance, 1) <= 1
      AND COALESCE(injection_count, 0) = 0
      AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
      AND (facts IS NULL OR facts = '' OR facts = '[]')
      AND (
        title LIKE 'Modified %' OR title LIKE 'Worked on %'
        OR title LIKE 'Reviewed %' OR title LIKE 'Error%'
      )
      AND created_at_epoch < ?
      AND project = ?
  `).run(now - noiseAgeMs, project).changes;

  return { aged, noise };
}

/** Delete broken observations (no title AND no narrative). Returns rows deleted. */
// Before hard-deleting observations, un-hide any rows merged INTO them. A child has
// compressed_into = <keeperId>; deleting that keeper (compressed_into has no FK) would
// leave the child dangling behind a now-missing parent — hidden from every
// COALESCE(compressed_into,0)=0 view and unrecoverable. Recovery = resurface the child
// as live (NULL) rather than lose it silently. Shared by every hard-delete path:
// maintain (cleanupBroken/purgeStale) AND the interactive `delete` / MCP mem_delete.
export function recoverChildrenOf(db, ids) {
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  // `AND id NOT IN (...)`: never "recover" a row that is itself being deleted in the same
  // call (e.g. `delete 1,2` where #2 was merged into #1). Without it, #2 is un-hidden and
  // then immediately deleted, inflating the reported recovery count with a row that did not
  // survive. Recovery should count only children that actually stay live.
  return db.prepare(
    `UPDATE observations SET compressed_into = NULL WHERE compressed_into IN (${ph}) AND id NOT IN (${ph})`
  ).run(...ids, ...ids).changes;
}

// Resurface children orphaned by a keeper hard-deleted BEFORE recoverChildrenOf existed
// (legacy data). recoverChildrenOf only fires at delete time for the keepers being deleted
// in that call; rows whose keeper vanished in a past release are missed forever. A child
// with compressed_into = <positive keeperId> whose keeper row no longer exists is hidden
// from every COALESCE(compressed_into,0)=0 view AND sits in no maintenance queue (not
// COMPRESSED_AUTO, not COMPRESSED_PENDING_PURGE), so nothing ever resurfaces or GCs it —
// it leaks its full narrative out of reach. Setting compressed_into = NULL makes it live
// again; normal decay/GC then handles it on merit. `compressed_into > 0` excludes the
// negative sentinels (intentional states, not orphans). NON-DESTRUCTIVE: only un-hides
// rows, never deletes — safe to run unconditionally, no snapshot needed.
export function recoverOrphanedChildren(db, { projectFilter = '', baseParams = [] } = {}) {
  return db.prepare(`
    UPDATE observations SET compressed_into = NULL
    WHERE compressed_into > 0
      AND NOT EXISTS (SELECT 1 FROM observations k WHERE k.id = observations.compressed_into)
      ${projectFilter}
  `).run(...baseParams).changes;
}

// Heal lesson-bearing rows that citation-decay buried at importance 0 back when its floor
// was 0. That loop was later given a floor of 1, and as of D#179/D#198 it does not write
// `importance` on any branch at all — so this op no longer has an active producer and only
// drains the historical backlog. Keep it: nothing else lifts a stranded 0. All passive injection
// surfaces exclude importance 0 (pre-tool-recall >=2, user-prompt-search >=1, memory-context
// >=1), so a lesson demoted there is invisible AND — being injection_count>0 by construction
// — sits in no GC queue either (decayAndMarkIdle only marks injection_count=0 rows): stranded
// out of reach with its distilled lesson. Lifting to 1 restores >=1-surface visibility + a
// citation-recovery path. NON-DESTRUCTIVE (only 0→1 on lesson-bearing rows, never
// deletes/hides), idempotent (a no-op once no imp-0 lesson rows remain), so safe to run
// unconditionally alongside recoverOrphanedChildren. `superseded_at IS NULL` mirrors the
// injection surfaces' own filter (pre-tool-recall:368, memory-context:217) — a de-dup loser
// (auto-dedup sets superseded_at but leaves compressed_into=0) must NOT be lifted back into
// injectability. Non-lesson imp-0 rows are left buried (low-value, not worth resurfacing).
export function recoverBuriedLessons(db, { projectFilter = '', baseParams = [] } = {}) {
  return db.prepare(`
    UPDATE observations SET importance = 1
    WHERE ${liveObsFilterSql('')}
      AND COALESCE(importance, 1) = 0
      AND lesson_learned IS NOT NULL AND lesson_learned <> '' AND lower(lesson_learned) <> 'none'
      ${projectFilter}
  `).run(...baseParams).changes;
}

// Heal deferred_work rows whose closing observation / source prompt was hard-deleted while
// foreign_keys was OFF. The warm-start fast-path deliberately runs with FK disabled (schema.mjs
// early migrations require cascade off), so the column's `ON DELETE SET NULL` never fired and a
// dangling closed_by_obs_id / source_prompt_id survives — exactly what `PRAGMA foreign_key_check`
// flags. This applies the SET NULL the FK would have. Closure state lives in status/
// closed_at_epoch, NOT the back-ref, so nulling the id does NOT reopen a done item — it only drops
// a pointer to a row that no longer exists. NON-DESTRUCTIVE + idempotent (a no-op once no dangling
// refs remain), so safe to run unconditionally alongside recoverOrphanedChildren. (P3-5)
export function sweepDeferredWorkOrphans(db, { projectFilter = '', baseParams = [] } = {}) {
  const obs = db.prepare(`
    UPDATE deferred_work SET closed_by_obs_id = NULL
    WHERE closed_by_obs_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = deferred_work.closed_by_obs_id)
      ${projectFilter}
  `).run(...baseParams).changes;
  const prompt = db.prepare(`
    UPDATE deferred_work SET source_prompt_id = NULL
    WHERE source_prompt_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM user_prompts p WHERE p.id = deferred_work.source_prompt_id)
      ${projectFilter}
  `).run(...baseParams).changes;
  return obs + prompt;
}

export function cleanupBroken(db, { projectFilter, baseParams, opCap = OP_CAP }) {
  const doomed = db.prepare(`
    SELECT id FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND (title IS NULL OR title = '') AND (narrative IS NULL OR narrative = '')
      -- A lesson-bearing row is NOT "broken" — it still carries the distilled value,
      -- so empty title+narrative isn't grounds to hard-delete it (a degenerate
      -- cluster-merge can write merged_title='' onto a row that kept a synthesized
      -- lesson). Parity with the "lessons never auto-GC" guards in
      -- decayAndMarkIdle / selectCompressionCandidates / findSmartCompressCandidates.
      AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
      ${projectFilter} LIMIT ${opCap}
  `).all(...baseParams).map(r => r.id);
  if (!doomed.length) return 0;
  recoverChildrenOf(db, doomed); // empty-content row could still be a cluster keeper
  const ph = doomed.map(() => '?').join(',');
  return db.prepare(`DELETE FROM observations WHERE id IN (${ph})`).run(...doomed).changes;
}

/**
 * Decay importance of old, never-accessed, NEVER-INJECTED observations and mark the
 * importance-1 idle ones as pending-purge. injection_count>0 is protected as first-class
 * engagement alongside access_count (unified across all three paths).
 *
 * MARK-IDLE RUNS BEFORE DECAY (audit MED-1): if decay ran first, an imp-2 row would be
 * decayed 2→1 and then re-selected by the same call's mark-idle pass → hidden as
 * pending-purge in ONE pass, collapsing the per-tier grace cycle and over-marking vs what
 * `maintain scan` (stale = imp-1 only) forecasts. Marking first means each call only marks
 * rows that were ALREADY imp-1; a freshly-decayed imp-2→1 row waits for the next call,
 * so importance tiers each buy a grace cycle (imp3→2→1→pending across runs) and the scan
 * forecast matches what decay actually marks.
 */
export function decayAndMarkIdle(db, { projectFilter, baseParams, staleAge, opCap = OP_CAP }) {
  const idleMarked = db.prepare(`
    UPDATE observations SET compressed_into = ${COMPRESSED_PENDING_PURGE}
    WHERE id IN (
      SELECT id FROM observations
      -- liveObsFilterSql, not compressed_into alone (P3-13). This statement writes the
      -- sentinel purgeStale hard-deletes, and deleting a RETIRED row destroys its
      -- superseded_by column -- the redirect three functions in the Stop citation loop
      -- follow to credit a #NN naming a corrected memory to its successor
      -- (lib/citation-tracker.mjs redirectSupersededIds). 27 of 31 superseded rows on the
      -- maintainer's DB carry one. An explicit delete still removes a tombstone, exactly
      -- as with the lesson guard below.
      --
      -- ONLY the two PENDING_PURGE writers carry this (here and
      -- search-scoring.runIdleCleanup). The decay arm below, boostAccessed, demotePinned
      -- and cleanupBroken deliberately keep compressed_into alone: the first three move
      -- only importance, which is inert on a row every read path already hides, so
      -- exempting them would be churn plus a forecast change for no behavioural
      -- difference. maintenanceStats' stale count mirrors THIS predicate and moved with it.
      --
      -- NB: no backticks anywhere in this block -- it sits inside a JS template literal,
      -- where one terminates the string. A first draft did that and node --check failed.
      WHERE ${liveObsFilterSql('')}
        AND COALESCE(importance, 1) = 1
        AND COALESCE(access_count, 0) = 0
        AND COALESCE(injection_count, 0) = 0
        -- v3.23: never mark a lesson-bearing row idle→pending-purge. A lesson is the
        -- distilled value of a lessons store; auto-GC must not silently purge it (parity
        -- with the compress lesson guards in hook.mjs + compress-core.mjs). Truly stale
        -- lessons are removed by explicit delete, not background decay.
        AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
        AND created_at_epoch < ?
        ${projectFilter} LIMIT ${opCap}
    )
  `).run(staleAge, ...baseParams).changes;

  const decayed = db.prepare(`
    UPDATE observations SET importance = MAX(1, COALESCE(importance, 1) - 1)
    WHERE id IN (
      SELECT id FROM observations
      WHERE COALESCE(compressed_into, 0) = 0
        AND COALESCE(importance, 1) > 1
        AND COALESCE(access_count, 0) = 0
        AND COALESCE(injection_count, 0) = 0
        AND created_at_epoch < ?
        ${projectFilter} LIMIT ${opCap}
    )
  `).run(staleAge, ...baseParams).changes;

  return { decayed, idleMarked };
}

/** Boost importance of frequently-accessed observations. Returns rows boosted. */
export function boostAccessed(db, { projectFilter, baseParams, opCap = OP_CAP }) {
  return db.prepare(`
    UPDATE observations SET importance = MIN(3, COALESCE(importance, 1) + 1)
    WHERE id IN (
      SELECT id FROM observations
      WHERE COALESCE(compressed_into, 0) = 0
        AND COALESCE(access_count, 0) > 3
        AND COALESCE(importance, 1) < 3
        ${projectFilter} LIMIT ${opCap}
    )
  `).run(...baseParams).changes;
}

// Every other automatic pass in this file carries this clause verbatim (lines 179, 192,
// 299, 334) — a lesson is the distilled value a lessons store exists to hold, and
// background machinery must not quietly dispose of one.
const NO_LESSON_SQL = "(lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')";

// The floor demotePinned writes, and therefore also the bound that decides whether a row
// still HAS anything to demote. One home: v3.76.0 shipped with the floor here and the
// forecast in maintenanceStats still hard-coded `importance > 1`, so a lesson row already
// at 2 was counted as pinned forever while every execute reported "Demoted 0" — the exact
// scan-forecast-vs-execute drift the decayAndMarkIdle comment below exists to prevent.
const PINNED_FLOOR_SQL = `(CASE WHEN ${NO_LESSON_SQL} THEN 1 ELSE 2 END)`;
// Shared by the op and its forecast. Callers add their own compressed_into/project filter.
// Module-private on purpose: nothing outside this file consumes it, and exporting by habit
// is how the knip baseline drifts (cf. the v3.70.0 DEFAULT_MARKETPLACE trio).
const PINNED_PREDICATE_SQL = `
  COALESCE(injection_count, 0) >= ${PINNED_INJ_THRESHOLD}
  AND COALESCE(cited_count, 0) = 0
  AND COALESCE(importance, 1) > ${PINNED_FLOOR_SQL}`;

/**
 * Repair the citation-decay blind spot: heavy-injection + zero-citation rows that
 * decay protects (injection_count>0) stay pinned at max importance forever. Floor
 * them; never purge.
 *
 * TWO floors, and the asymmetry is the point. `importance >= 2` is a hard WHERE on the
 * injection faces that actually earn citations — pre-tool-recall
 * (scripts/pre-tool-recall.js:428,470), SessionStart Key Context (hook-context.mjs:95,315)
 * and cross-project (hook-memory.mjs:280) — whereas `injection_count`, the signal that
 * triggers this op at all, is incremented ONLY on the two UserPromptSubmit faces
 * (hook-memory.mjs:367, scripts/user-prompt-search.js:979). Those are the weakest faces
 * by measured cite-rate. Dropping straight to 1 therefore convicts a row on its weakest
 * surface and evicts it from its strongest — which pre-tag review caught: on the
 * maintainer's live DB, 16 of the 17 rows this op would have moved were lesson-bearing.
 *
 *   no lesson -> 1  (fully de-ranked; the original behaviour, unchanged)
 *   lesson    -> 2  (loses the top tier and its ranking weight, keeps eligibility on
 *                    every importance>=2 face)
 *
 * The floor doubles as the WHERE bound so a row already sitting at its floor is not
 * re-touched: SQLite counts a same-value UPDATE in `changes`, which would otherwise
 * report phantom demotions on every run forever.
 */
export function demotePinned(db, { projectFilter, baseParams, opCap = OP_CAP }) {
  return db.prepare(`
    UPDATE observations SET importance = ${PINNED_FLOOR_SQL}
    WHERE id IN (
      SELECT id FROM observations
      WHERE COALESCE(compressed_into, 0) = 0
        AND ${PINNED_PREDICATE_SQL}
        ${projectFilter} LIMIT ${opCap}
    )
  `).run(...baseParams).changes;
}

/**
 * Merge explicit duplicate groups: each group is [keepId, removeId, …]. Marks the
 * removeIds compressed into keepId (only if not already compressed). Returns the
 * number of rows merged. Callers parse their own input (CLI string / MCP array).
 */
export function mergeDuplicates(db, groups) {
  // Resolve the WHOLE batch before writing so transitive merges can't orphan rows.
  // A row is hidden from every view by `compressed_into != 0`, so pointing it at a
  // keeper that is itself hidden buries it behind a hidden parent. Naively applying
  // groups one update at a time loses data in three ways the old 1-line self-merge
  // guard missed:
  //   - chain  [[A,B],[B,C]] -> C.compressed_into=B, but B is now hidden into A;
  //     if B is later purgeStale-deleted, C's keeper vanishes and C is unrecoverable.
  //   - mutual [[A,B],[B,A]] -> BOTH hidden, the cluster loses its live representative.
  //   - already-compressed keeper [E,F] when E was merged in a prior call -> F buried
  //     behind hidden E.
  // mem_maintain's "dedup" auto-suggests pairs that can form these chains (server.mjs),
  // so this is reachable in normal use, not just typos. Fix: build the redirect map,
  // collapse each removeId to a single live keeper (cycles -> smallest id as canonical),
  // and only write removeId -> keeper when that keeper is currently live. Shared core,
  // so CLI + MCP both inherit it.
  const redirect = new Map(); // removeId -> keepId (first writer wins, deterministic)
  for (const group of groups) {
    if (!group || group.length < 2) continue;
    const [keepId, ...removeIds] = group;
    for (const removeId of removeIds) {
      if (removeId === keepId) continue;            // self-merge typo: no-op
      if (!redirect.has(removeId)) redirect.set(removeId, keepId);
    }
  }
  if (redirect.size === 0) return 0;

  // Follow the redirect chain to the ultimate keeper. A cycle (mutual merge) collapses
  // to the smallest id among the cycle members so every member agrees on one survivor.
  const resolveKeeper = (start) => {
    const seen = [];
    let cur = start;
    while (redirect.has(cur)) {
      const at = seen.indexOf(cur);
      if (at !== -1) return Math.min(...seen.slice(at)); // cycle -> canonical = min member
      seen.push(cur);
      cur = redirect.get(cur);
    }
    return cur; // an id with no outgoing redirect is a keeper
  };

  // Liveness here is `liveObsFilterSql`, not compressed_into alone (audit 2026-09-02 P0-2):
  // a superseded row keeps compressed_into=0, so the narrower predicate accepted a TOMBSTONE
  // as a keeper and pointed a live row at it — the row then vanishes from every read face
  // (all of which filter superseded_at) with no recovery path, because recoverOrphanedChildren
  // only resurfaces children whose keeper row is GONE, and a tombstone still exists.
  const isLive = db.prepare(`SELECT 1 FROM observations WHERE id = ? AND ${liveObsFilterSql('')}`);
  const mergeStmt = db.prepare(`UPDATE observations SET compressed_into = ? WHERE id = ? AND ${liveObsFilterSql('')}`);
  let merged = 0;
  for (const removeId of redirect.keys()) {
    const keeper = resolveKeeper(removeId);
    if (keeper === removeId) continue;              // cycle canonical: this row survives
    if (!isLive.get(keeper)) continue;              // keeper not live -> skip, never orphan
    merged += mergeStmt.run(keeper, removeId).changes;
  }
  return merged;
}

/**
 * Count rows a destructive maintenance run would hard-DELETE: pending-purge rows
 * (any age — a cheap proxy for "purge has something to remove", deliberately not
 * age-filtered so the guard never under-counts) and/or broken empty-content rows
 * (cleanupBroken's doomed set). Used by the maintenance entry points to decide
 * whether to VACUUM-snapshot the DB first (audit MED-2) — over-counting only costs
 * one extra bounded backup; under-counting would skip the safety net.
 */
export function hardDeleteCandidateCount(db, { projectFilter, baseParams }, { cleanup = false, purge = false } = {}) {
  let n = 0;
  if (purge) {
    n += db.prepare(
      `SELECT COUNT(*) AS c FROM observations WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} ${projectFilter}`
    ).get(...baseParams).c;
  }
  if (cleanup) {
    n += db.prepare(
      `SELECT COUNT(*) AS c FROM observations
       WHERE COALESCE(compressed_into, 0) = 0
         AND (title IS NULL OR title = '') AND (narrative IS NULL OR narrative = '') ${projectFilter}`
    ).get(...baseParams).c;
  }
  return n;
}

/** Preview pending-purge candidates older than the retain cutoff (no deletion). */
export function purgeStalePreview(db, { projectFilter, baseParams }, retainCutoff) {
  return db.prepare(`
    SELECT COUNT(*) AS candidates, MIN(created_at_epoch) AS oldest, MAX(created_at_epoch) AS newest
    FROM observations
    WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} AND created_at_epoch < ? ${projectFilter}
  `).get(retainCutoff, ...baseParams);
}

/** Delete pending-purge observations older than the retain cutoff. Returns rows deleted. */
export function purgeStale(db, { projectFilter, baseParams, opCap = OP_CAP }, retainCutoff) {
  // No lesson guard HERE by design: this hard-DELETE only touches rows already
  // marked COMPRESSED_PENDING_PURGE, and every writer of that sentinel is itself
  // lesson-guarded (decayAndMarkIdle above + search-scoring.runIdleCleanup), so a
  // lesson row can never reach here. INVARIANT: any NEW code that sets
  // compressed_into = COMPRESSED_PENDING_PURGE MUST carry the "lessons never auto-GC"
  // guard, or it re-opens the path that hard-deletes lessons through this DELETE.
  const doomed = db.prepare(`
    SELECT id FROM observations
    WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} AND created_at_epoch < ?
      ${projectFilter} LIMIT ${opCap}
  `).all(retainCutoff, ...baseParams).map(r => r.id);
  if (!doomed.length) return 0;
  // A keeper that absorbed dups can later be marked idle (compressed_into=PENDING_PURGE)
  // and reach here; deleting it would orphan its children. Recover them first.
  recoverChildrenOf(db, doomed);
  const ph = doomed.map(() => '?').join(',');
  return db.prepare(`DELETE FROM observations WHERE id IN (${ph})`).run(...doomed).changes;
}

/**
 * Near-duplicate title detection: MinHash pre-filter → exact Jaccard. Returns
 * [{ a:{id,title,importance}, b:{…}, similarity:'0.NN' }, …].
 */
export function findDuplicates(db, { projectFilter, baseParams, limit = SCAN_LIMIT, dupLimit = DUPLICATE_LIMIT }) {
  const recent = db.prepare(`
    SELECT id, title, project, importance, access_count, created_at_epoch
    FROM observations
    -- liveObsFilterSql, not compressed_into alone (audit 2026-09-02 P0-2): this scan renders a
    -- ready-to-paste "maintain execute --ops dedup --merge-ids A,B", and the keeper rule is
    -- importance-based (mem-cli.mjs / server.mjs), so a superseded tombstone in the pair could
    -- be nominated keeper. Same predicate the hook-side fuzzy dedup candidate query uses
    -- (hook.mjs), and the same one mergeDuplicates now enforces at write time.
    WHERE ${liveObsFilterSql('')} ${projectFilter}
    ORDER BY created_at_epoch DESC LIMIT ${limit}
  `).all(...baseParams);

  const titles = recent.map((r) => (r.title || '').trim());
  const minhashes = titles.map((t) => (t ? computeMinHash(t) : null));
  const duplicates = [];
  for (let i = 0; i < recent.length && duplicates.length < dupLimit; i++) {
    if (!titles[i] || !minhashes[i]) continue;
    for (let j = i + 1; j < recent.length; j++) {
      if (!titles[j] || !minhashes[j]) continue;
      if (estimateJaccardFromMinHash(minhashes[i], minhashes[j]) < MINHASH_PRE_THRESHOLD) continue;
      const sim = jaccardSimilarity(titles[i], titles[j]);
      if (sim > SIMILARITY_THRESHOLD) {
        duplicates.push({
          a: { id: recent[i].id, title: recent[i].title, importance: recent[i].importance },
          b: { id: recent[j].id, title: recent[j].title, importance: recent[j].importance },
          similarity: sim.toFixed(2),
        });
      }
      if (duplicates.length >= dupLimit) break;
    }
  }
  return duplicates;
}

/** Single-scan maintenance counters (includes `pinned`; callers render what they show). */
export function maintenanceStats(db, { projectFilter, baseParams, staleAge }) {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      -- injection_count=0 MUST mirror decayAndMarkIdle's mark-idle guard (#8614):
      -- the scan stat previews what decay will mark idle, and decay protects
      -- injected rows. Omitting it over-counted "stale" by the injected-but-decayed
      -- rows decay never touches (e.g. demote_pinned's output: imp=1 but inj>0).
      -- lesson_learned guard mirrors decayAndMarkIdle (:188) / cleanupBroken (:153): those
      -- ops NEVER touch a lesson-bearing row ("lessons never auto-GC"), so the scan preview
      -- must exclude them too or it over-forecasts "Stale"/"Broken" vs what execute does.
      -- superseded_at IS NULL mirrors the P3-13 guard added to decayAndMarkIdle's
      -- mark-idle pass. It belongs ONLY on the stale count: boostable and pinned forecast
      -- ops that were deliberately left touching tombstones, and forecasting an exemption
      -- they do not have would break this parity in the other direction.
      COALESCE(SUM(CASE WHEN COALESCE(importance, 1) = 1 AND COALESCE(access_count, 0) = 0
                    AND COALESCE(injection_count, 0) = 0
                    AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
                    AND superseded_at IS NULL
                    AND created_at_epoch < ? THEN 1 ELSE 0 END), 0) as stale,
      COALESCE(SUM(CASE WHEN (title IS NULL OR title = '') AND (narrative IS NULL OR narrative = '')
                    AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
               THEN 1 ELSE 0 END), 0) as broken,
      COALESCE(SUM(CASE WHEN COALESCE(access_count, 0) > 3 AND COALESCE(importance, 1) < 3
               THEN 1 ELSE 0 END), 0) as boostable,
      COALESCE(SUM(CASE WHEN ${PINNED_PREDICATE_SQL} THEN 1 ELSE 0 END), 0) as pinned
    FROM observations
    WHERE COALESCE(compressed_into, 0) = 0 ${projectFilter}
  `).get(staleAge, ...baseParams);
  const pendingPurge = db.prepare(
    `SELECT COUNT(*) as count FROM observations WHERE compressed_into = ${COMPRESSED_PENDING_PURGE} ${projectFilter}`
  ).get(...baseParams);
  return { ...stats, pendingPurge: pendingPurge.count };
}

/** Rebuild the TF-IDF vocabulary + every active observation vector (own transaction). */
export function rebuildVectors(db) {
  if (!vectorsEnabled()) return { ok: false, reason: 'vector arm disabled (set CLAUDE_MEM_VECTORS=1 to re-enable)', updated: 0, total: 0 };
  _resetVocabCache();
  const vocab = rebuildVocabulary(db);
  if (!vocab) return { ok: false, reason: 'no observations to build vocabulary from' };
  const allObs = db.prepare(`
    SELECT id, title, narrative, concepts, lesson_learned, search_aliases FROM observations
    WHERE ${liveObsFilterSql('')}
  `).all();
  let updated = 0;
  const insertStmt = db.prepare('INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)');
  const now = Date.now();
  db.transaction(() => {
    db.prepare('DELETE FROM observation_vectors').run();
    for (const obs of allObs) {
      const vec = computeVector(vecTextForRow(obs), vocab);
      if (vec) {
        insertStmt.run(obs.id, Buffer.from(vec.buffer), vocab.version, now);
        updated++;
      }
    }
  })();
  return { ok: true, terms: vocab.terms.size, updated, total: allObs.length };
}

/**
 * VACUUM the whole DB, reporting freelist reclaim. Must run OUTSIDE any transaction.
 *
 * Module-private since P1-5: its only two consumers were mem-cli.mjs and server.mjs, and
 * both now reach it through `runMaintainOps`. Exporting it again would add a name to the
 * knip baseline for nobody (the v3.70.0 precedent, #9675) — export it the day something
 * outside this module needs it.
 */
function vacuum(db) {
  const pageSize = db.pragma('page_size', { simple: true });
  const freeBefore = db.pragma('freelist_count', { simple: true });
  db.exec('VACUUM');
  const freeAfter = db.pragma('freelist_count', { simple: true });
  const reclaimedMB = ((Math.max(0, freeBefore - freeAfter) * pageSize) / 1048576).toFixed(1);
  return { reclaimedMB, freeBefore, freeAfter };
}

// ─── The `maintain execute` sequence, once ──────────────────────────────────
//
// Audit 2026-09-02 P1-5. Every OPERATION above was already shared; the SEQUENCE was
// hand-copied into mem-cli.mjs and server.mjs, and had drifted three ways:
//
//   * `server.mjs` rendered the demote_pinned line with a hardcoded `inj>=8` while
//     mem-cli.mjs interpolated PINNED_INJ_THRESHOLD — change the constant and the MCP
//     surface reports a threshold the code no longer uses.
//   * the cap hint was a named `capHint()` on one face and the same ternary inlined
//     four times on the other.
//   * the comment explaining WHY demote_pinned must physically follow boost (boostAccessed
//     lifts any access_count>3 row under importance 3, so demoting first and boosting
//     second hands the row straight back inside one run) existed only on the CLI, i.e.
//     the face where it was already right.
//
// The order is the contract, so it lives here with its reason. What stays with the
// surfaces is what genuinely differs: how a caller spells `merge_ids`, and what a purge
// preview tells the user to type next. Those arrive as explicit parameters rather than
// being re-implemented, which makes the differences reviewable in one place.

/**
 * Run the `maintain execute` operation sequence and return the report lines.
 *
 * Owns the snapshot, the transaction boundary and the three post-transaction ops, because
 * all three are part of the ordering contract: the pre-transaction snapshot counts only
 * PRE-EXISTING pending rows, so purge must run before decay or a row is marked and deleted
 * in one call with the backup skipped (audit HIGH-1), and VACUUM cannot run inside a
 * transaction at all.
 *
 * @param {object} db
 * @param {object} ctx  { projectFilter, baseParams, staleAge, opCap }
 * @param {string[]} ops
 * @param {object} opts
 * @param {number} [opts.retainDays=30]
 * @param {number} opts.retainCutoff
 * @param {boolean} [opts.confirmed=false]     purge_stale is the only DELETE; unconfirmed previews
 * @param {Array<number[]>|null} [opts.mergeGroups]  parsed dedup groups, already validated
 * @param {boolean} [opts.mergeIdsProvided]    true when the caller passed merge ids at all
 * @param {string[]} [opts.invalidMergeSegments]  malformed segments to warn about (CLI only)
 * @param {string} [opts.mergeIdsFlagName]     how this surface spells the flag, for the warning
 * @param {Function} opts.renderPurgePreview   (previewRow, retainDays) => string
 * @param {Function} [opts.onError]            (err, scope) => void, for the two catch arms
 * @returns {string[]} report lines, in order
 */
export function runMaintainOps(db, ctx, ops, {
  retainDays = 30,
  retainCutoff,
  confirmed = false,
  mergeGroups = null,
  mergeIdsProvided = false,
  invalidMergeSegments = [],
  mergeIdsFlagName = 'merge_ids',
  renderPurgePreview,
  onError = () => {},
} = {}) {
  const results = [];
  const opCap = ctx.opCap ?? OP_CAP;
  const capHint = (changes) => (changes >= opCap ? ' (cap reached, re-run for more)' : '');

  // Snapshot before the irreversible hard deletes, and only when rows will actually be
  // removed. OUTSIDE the transaction below — VACUUM cannot run inside one, and a snapshot
  // taken inside would not see a consistent pre-state anyway. Best-effort; never throws.
  const willPurge = ops.includes('purge_stale') && confirmed;
  if (hardDeleteCandidateCount(db, ctx, { cleanup: ops.includes('cleanup'), purge: willPurge }) > 0) {
    snapshotDb(db, { tag: 'pre-maintain' });
  }

  db.transaction(() => {
    // PURGE FIRST — same order as handleAutoMaintain. Running decay before purge in one
    // transaction marks a stale row pending-purge AND deletes it in the SAME call (zero
    // grace), and the snapshot above counts only PRE-EXISTING pending rows, so it skips the
    // backup: permanent, unrecoverable loss of notable imp-2/3 memories (audit HIGH-1).
    // Purging first deletes only rows a PRIOR run marked — which the guard saw and backed
    // up — and rows decay marks below wait for the next run, regaining the grace cycle.
    if (ops.includes('purge_stale')) {
      if (!confirmed) {
        results.push(renderPurgePreview(purgeStalePreview(db, ctx, retainCutoff), retainDays));
      } else {
        const purged = purgeStale(db, ctx, retainCutoff);
        results.push(`Purged ${purged} stale observations (retained last ${retainDays} days)${capHint(purged)}`);
      }
    }

    if (ops.includes('cleanup')) {
      const deleted = cleanupBroken(db, ctx);
      results.push(`Cleaned up ${deleted} broken observations${capHint(deleted)}`);
      // Self-heal legacy orphans (keeper hard-deleted pre-recoverChildrenOf): resurface
      // unreachable children. Non-destructive — un-hide only, no delete.
      const orphans = recoverOrphanedChildren(db, ctx);
      if (orphans > 0) results.push(`Recovered ${orphans} orphaned compression children`);
      // Heal lesson rows citation-decay buried at importance 0 (pre floor=1). 0→1 on
      // lesson-bearing rows only; idempotent no-op once none remain.
      const lessonsHealed = recoverBuriedLessons(db, ctx);
      if (lessonsHealed > 0) results.push(`Healed ${lessonsHealed} lesson rows buried at importance 0`);
      // Heal deferred_work rows whose closing obs / source prompt was hard-deleted while FK
      // was OFF (dangling refs foreign_key_check flags). Applies the FK's ON DELETE SET NULL.
      const deferredHealed = sweepDeferredWorkOrphans(db, ctx);
      if (deferredHealed > 0) results.push(`Healed ${deferredHealed} deferred-work rows with dangling references`);
    }

    if (ops.includes('decay')) {
      // injection_count>0 protected (decayAndMarkIdle) — an obs Claude was shown 8× is
      // contextually proven. The MCP copy lacked this clause before the extraction.
      const { decayed, idleMarked } = decayAndMarkIdle(db, ctx);
      results.push(`Decayed ${decayed} stale observations, marked ${idleMarked} idle as pending-purge${capHint(Math.max(decayed, idleMarked))}`);
    }

    if (ops.includes('boost')) {
      const boosted = boostAccessed(db, ctx);
      results.push(`Boosted ${boosted} frequently-accessed observations${capHint(boosted)}`);
    }

    // AFTER boost, and the order is load-bearing in one direction only: boostAccessed lifts
    // any access_count>3 row with importance<3, so demoting a pinned row to 1 and then
    // boosting hands it straight back at 2 — the demotion silently undone inside a single
    // run. DEFAULT_MAINTAIN_OPS pins the order; this block has to physically follow the
    // boost block for that order to be real.
    if (ops.includes('demote_pinned')) {
      // Repairs the citation-decay blind spot: decay protects injection_count>0, so a
      // heavily-injected-but-uncited memory stays pinned at max importance forever.
      // Floor, not purge: no lesson_learned → 1, lesson-bearing → 2 (v3.76.1 dual floor).
      const demoted = demotePinned(db, ctx);
      results.push(`Demoted ${demoted} pinned-but-uncited observations (inj>=${PINNED_INJ_THRESHOLD}, cited=0; no lesson → importance 1, lesson → 2)${capHint(demoted)}`);
    }

    if (ops.includes('dedup') && mergeIdsProvided) {
      const totalMerged = mergeDuplicates(db, mergeGroups || []);
      if (invalidMergeSegments.length) {
        results.push(`Warning: ignored ${invalidMergeSegments.length} malformed ${mergeIdsFlagName} segment(s): ${invalidMergeSegments.join(', ')} (expected keepId:removeId[:removeId...] with positive integers)`);
      }
      results.push(`Merged ${totalMerged} duplicate observations`);
    }

    if (!ops.includes('dedup') && mergeIdsProvided) {
      results.push(`Warning: ${mergeIdsFlagName} provided but "dedup" not in operations — ${mergeIdsFlagName} ignored`);
    }
  })();

  // FTS5 optimize — outside the transaction.
  db.exec("INSERT INTO observations_fts(observations_fts) VALUES('optimize')");
  results.push('FTS5 index optimized');

  if (ops.includes('rebuild_vectors')) {
    try {
      const r = rebuildVectors(db);
      results.push(r.ok
        ? `Vectors: rebuilt vocabulary (${r.terms} terms), updated ${r.updated}/${r.total} vectors`
        : `Vectors: ${r.reason}`);
    } catch (e) {
      onError(e, 'rebuild_vectors');
      results.push(`Vectors: rebuild failed — ${e.message}`);
    }
  }

  // VACUUM: reclaim freelist pages left by DELETEs. Whole-DB, outside any transaction.
  if (ops.includes('vacuum')) {
    try {
      const v = vacuum(db);
      results.push(`VACUUM: reclaimed ~${v.reclaimedMB}MB (freelist ${v.freeBefore} → ${v.freeAfter} pages)`);
    } catch (e) {
      onError(e, 'vacuum');
      results.push(`VACUUM failed — ${e.message}`);
    }
  }

  return results;
}
