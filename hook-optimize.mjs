// claude-mem-lite: LLM-powered database optimization
// SHARED ENGINE — the `hook-` prefix is historical, not a scope. All three entry
// surfaces import this: hook.mjs (handleLLMOptimize), server.mjs and mem-cli.mjs
// (optimizePreview/optimizeRun), plus a lazy import from lib/save-enrich.mjs. Do not
// assume hook-pipeline session lifecycle or single-writer concurrency here.
// Background worker for intelligent maintenance: re-enrich, normalize, cluster-merge, smart-compress
// Triggered from auto-maintain (24h) or manually via mem_optimize MCP tool / CLI

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  truncate,
  debugLog,
  debugCatch,
  COMPRESSED_AUTO,
  computeMinHash,
  estimateJaccardFromMinHash,
  jaccardSimilarity,
  clampImportance,
  cjkBigrams,
  notLowSignalTitleClause,
  scrubSecrets,
  getCurrentBranch,
} from './utils.mjs';
import { callModelJSONAsync, BG_LLM_TIMEOUT_MS } from './haiku-client.mjs';
import { acquireLLMSlot, releaseLLMSlot } from './hook-semaphore.mjs';
import { scrubRecord } from './lib/scrub-record.mjs';
import { MERGE_JACCARD_LOW, AUTO_MERGE_THRESHOLD } from './lib/dedup-constants.mjs';
import { DB_DIR } from './schema.mjs';
import { OBS_TYPE_SET } from './lib/obs-types.mjs';
import { normalizeScope, SCOPE_PROMPT_LEGEND, insertObservationRow } from './lib/observation-write.mjs';
import { liveObsFilterSql } from './lib/inject-search-core.mjs';
import { resolveRuntimeDir } from './lib/resolve-data-dir.mjs';
import { MEMORY_INPUT_GUARD } from './lib/memory-input-guard.mjs';

import { DAY_MS } from './lib/time-constants.mjs';
// P1-14: same resolver as hook-shared.mjs — this was the second module that had never
// heard of CLAUDE_MEM_RUNTIME_DIR, and a third hand-written copy of the join().
const RUNTIME_DIR = resolveRuntimeDir(DB_DIR);

// ─── Budget ─────────────────────────────────────────────────────────────────

export function distributeBudget(total = 15) {
  const normalize = 1;
  const reenrich = Math.max(1, Math.floor(total * 0.4));
  const clusterMerge = Math.max(1, Math.floor(total * 0.3));
  const smartCompress = Math.max(1, total - reenrich - normalize - clusterMerge);
  // Clamp: if total is too small for all 4 tasks, allocate 1 each by priority until `total`
  // is exhausted so the returned sum is ≤ total (the old fallback returned {1,1,1,1}=4 for
  // total≤3, over-running `optimize --max N`).
  if (reenrich + normalize + clusterMerge + smartCompress > total) {
    const alloc = { reenrich: 0, clusterMerge: 0, smartCompress: 0, normalize: 0 };
    const order = ['reenrich', 'clusterMerge', 'smartCompress', 'normalize'];
    for (let i = 0; i < total && i < order.length; i++) alloc[order[i]] = 1;
    return alloc;
  }
  return { reenrich, normalize, clusterMerge, smartCompress };
}

// ─── Shared Helpers ─────────────────────────────────────────────────────────

// ─── Task 1: Re-enrich ─────────────────────────────────────────────────────

/**
 * Find observations eligible for LLM re-enrichment.
 *
 * Two scopes:
 * - 'narrow' (default): fully-degraded observations — Haiku failed to extract
 *   concepts / facts / lesson / aliases. Conservative; preserves pre-R-7 behavior.
 * - 'wide' (R-7): substantive bugfix / refactor / feature / decision observations
 *   that have concepts + facts populated but are missing lesson_learned.
 *   Targets the "Haiku ran but judged 'none'" cases that dominate the library.
 *   Excludes LOW_SIGNAL titles (no source material to extract from) and
 *   thin narratives (<100 chars → nothing to rewrite into a lesson).
 *
 * Both scopes respect optimized_at (idempotent) and skip compressed/superseded rows.
 *
 * @param {object} db better-sqlite3 database handle
 * @param {number} limit max candidates to return
 * @param {{ scope?: 'narrow' | 'wide' | 'aliases' | 'scopes' | 'concepts', project?: string }} [opts] Optional project filter (e.g. inferProject()-resolved name) narrows candidates to a single project — opt-in to preserve prior cross-project default.
 */
export function findReenrichCandidates(db, limit = 10, { scope = 'narrow', project } = {}) {
  const projectClause = project ? 'AND project = ?' : '';
  if (scope === 'scopes') {
    // D#135 P3 scope backfill: substantive rows with observations.scope still
    // NULL, REGARDLESS of lesson or aliases. narrow/wide need lesson IS NULL and
    // aliases needs search_aliases IS NULL, so a legacy lesson-bearing row with
    // aliases is reachable by NONE of them — that shape was 1955 of the 2041
    // scope-less rows on 2026-08-19, i.e. the pool is ~97% invisible to the
    // existing passes. Idempotent via scope becoming non-null; deliberately NOT
    // gated on optimized_at (the alias branch's precedent — an optimized row can
    // still be unclassified) and it never SETS optimized_at, so the wide pass
    // keeps its own candidates.
    // Lesson-bearing first: CLAUDE_MEM_SCOPE_FILTER gates pre-tool recall, which
    // injects lesson-bearing rows — classifying those first is what makes the
    // lever usable before the backlog is fully drained.
    const stmt = db.prepare(`
      SELECT id, title, narrative, type, lesson_learned, importance, project
      FROM observations
      WHERE ${liveObsFilterSql('')}
        AND scope IS NULL
        AND LENGTH(COALESCE(narrative, '')) > 100
        AND ${notLowSignalTitleClause('')}
        ${projectClause}
      ORDER BY
        CASE WHEN lesson_learned IS NOT NULL AND lesson_learned != '' THEN 0 ELSE 1 END,
        created_at_epoch DESC,
        id DESC
      LIMIT ?
    `);
    return project ? stmt.all(project, limit) : stmt.all(limit);
  }
  if (scope === 'aliases') {
    // P1 alias backfill: substantive rows missing search_aliases, REGARDLESS of
    // lesson. Targets lesson-bearing manual saves (mem_save writes no aliases →
    // paraphrase-unfindable) that narrow (needs lesson NULL) and wide (needs
    // lesson NULL) both skip. Idempotent via search_aliases becoming non-null —
    // deliberately NOT gated on optimized_at, so a lesson-less row can still be
    // picked up by wide scope for lesson enrichment afterward.
    const stmt = db.prepare(`
      SELECT id, title, narrative, type, subtitle, concepts, facts, text, search_aliases, importance, project
      FROM observations
      WHERE ${liveObsFilterSql('')}
        AND (search_aliases IS NULL OR search_aliases = '')
        AND LENGTH(COALESCE(narrative, '')) > 100
        AND ${notLowSignalTitleClause('')}
        ${projectClause}
      ORDER BY created_at_epoch DESC, id DESC
      LIMIT ?
    `);
    return project ? stmt.all(project, limit) : stmt.all(limit);
  }
  if (scope === 'concepts') {
    // D#6 concepts backfill: substantive rows with no concepts, REGARDLESS of lesson,
    // aliases or scope. Same shape and same reason as the two pools above, one column
    // over — and this one exists because the P1-2 fix created it. save-enrich fires on
    // every successful manual save and writes search_aliases (always) + lesson_learned
    // (bugfix/decision) + scope, which are precisely narrow's, wide's, aliases' and
    // scopes' predicates, so a save-enriched row matches NONE of the four and never
    // receives concepts. Measured on the real DB 2026-09-07: 14/14 live observations
    // conceptless, 14/14 with aliases, 0/14 with optimized_at, all four pools empty.
    //
    // Keyed on `concepts` ALONE, not on concepts+facts: idempotency here is "the column
    // this pass fills becomes non-empty", the same contract aliases and scopes carry. A
    // facts term in the predicate would re-select forever every row whose narrative
    // yields no extractable fact.
    //
    // Deliberately NOT gated on optimized_at, for the reason the alias branch gives and
    // one more: the general pass preserves-on-empty, so a re-enrich whose model returned
    // no concepts leaves the row stamped AND conceptless. Gating on the stamp would
    // strand exactly those rows — the R10 P2-2 shape, where one pass's bookkeeping
    // evicts a row from a backfill it never visited.
    const stmt = db.prepare(`
      SELECT id, title, narrative, type, subtitle, concepts, facts, text, importance, project
      FROM observations
      WHERE ${liveObsFilterSql('')}
        AND (concepts IS NULL OR concepts = '')
        AND LENGTH(COALESCE(narrative, '')) > 100
        AND ${notLowSignalTitleClause('')}
        ${projectClause}
      ORDER BY created_at_epoch DESC, id DESC
      LIMIT ?
    `);
    return project ? stmt.all(project, limit) : stmt.all(limit);
  }
  if (scope === 'wide') {
    // This pool's ORDER BY leads with a CASE term and spans lines, which is exactly why the
    // first pass of the D#9 tiebreaker missed it. The full note lives in the default pool at
    // the bottom of this function -- read it before touching any ORDER BY here.
    const stmt = db.prepare(`
      SELECT id, title, narrative, type, subtitle, concepts, facts, search_aliases, importance, project
      FROM observations
      WHERE ${liveObsFilterSql('')}
        AND optimized_at IS NULL
        AND type IN ('bugfix','refactor','feature','decision')
        AND (lesson_learned IS NULL OR lesson_learned = '')
        AND LENGTH(COALESCE(narrative, '')) > 100
        AND ${notLowSignalTitleClause('')}
        ${projectClause}
      ORDER BY
        CASE type WHEN 'decision' THEN 0 WHEN 'bugfix' THEN 1 WHEN 'refactor' THEN 2 ELSE 3 END,
        created_at_epoch DESC,
        id DESC
      LIMIT ?
    `);
    return project ? stmt.all(project, limit) : stmt.all(limit);
  }
  const stmt = db.prepare(`
    SELECT id, title, narrative, type, subtitle, importance, project
    FROM observations
    WHERE ${liveObsFilterSql('')}
      AND (concepts IS NULL OR concepts = '')
      AND (facts IS NULL OR facts = '')
      AND lesson_learned IS NULL
      AND search_aliases IS NULL
      AND optimized_at IS NULL
      ${projectClause}
    -- D#9: the id term is a REACHABILITY guard, not cosmetics. Every pool in this file is
    -- ORDER BY created_at_epoch DESC LIMIT n feeding JS-side work, so a tie AT THE
    -- BOUNDARY decides pool MEMBERSHIP. Measured 2026-09-07: two inserts land in the same
    -- millisecond 272/300 times, and on a tie SQLite returns ASCENDING rowid -- the exact
    -- opposite of the "newest first" this clause states -- so the newest rows fell out of
    -- the pool whenever the clock had not ticked. SQLite's tie order is deterministic here
    -- (8 rows on one epoch, 200 queries, one returned order), so this is not defending
    -- against a varying plan; it is making the stated order total.
    --
    -- TWO DIFFERENT COUNTS, AND AN EARLIER DRAFT OF THIS COMMENT CONFLATED THEM. This
    -- function, findReenrichCandidates, holds FIVE pools -- five db.prepare blocks:
    -- 'scopes', 'aliases', 'concepts', 'wide', and this default 'narrow' one. The FILE
    -- holds SEVEN "ORDER BY ... created_at_epoch DESC" sites: those five plus
    -- extractUniqueConcepts and findMergeCandidates. All seven now carry the id term.
    -- DO NOT GREP FOR THE ONE-LINE FORM: two of the seven ('scopes' and 'wide') lead with
    -- a CASE ... term and span several lines, so grepping the joined
    -- "created_at_epoch DESC, id DESC" spelling sees only five. That is how the first pass
    -- read six and shipped 'wide' untiebroken -- the pool the DAILY unattended path passes
    -- explicitly, on a budget of 6, where a boundary tie decides which rows reach the LLM
    -- on a given run. Caught later by a test driving scope 'wide'; the original boundary
    -- case drove only 'narrow', so nothing went red.
    -- NOT FIXED, AND NAMED SO THE COMPLETENESS CLAIM IS TRUE: findSmartCompressCandidates
    -- carries an eighth ordering, "ORDER BY project, created_at_epoch" -- ASCENDING, no id
    -- term, no LIMIT. It is outside the seven by construction and is left alone under Iron
    -- Law #1: it feeds clusterForCompression, and a tie can move cluster MEMBERSHIP
    -- because that function's own sort is stable, so SQL order survives as the tiebreak
    -- and decides where a 14-day sub-cluster window is anchored. Phase-2 removed the
    -- vector branch this used to hide behind, so the hazard is no longer gated on a
    -- default-off env flag -- it is unconditional now. Still no failing case has been
    -- built, so it stays unjudged, not cleared; the removal RAISED its priority.
    -- This comment is INSIDE a template literal, so it must never contain a backtick.
    ORDER BY created_at_epoch DESC, id DESC
    LIMIT ?
  `);
  return project ? stmt.all(project, limit) : stmt.all(limit);
}

/**
 * Row count for a re-enrich pool, without materialising it. Only the 'scopes'
 * pool is served: it is the one large enough for the difference to matter
 * (2041 rows at introduction, against ~22 alias candidates), and keeping the
 * predicate here rather than duplicating it would drift — so this shares the
 * finder's WHERE by construction, via a SELECT COUNT over the same clauses.
 * @returns {number}
 */
export function countReenrichCandidates(db, scope = 'scopes', project) {
  if (scope !== 'scopes') return findReenrichCandidates(db, 5000, { scope, project }).length;
  const projectClause = project ? 'AND project = ?' : '';
  const stmt = db.prepare(`
    SELECT COUNT(*) c
    FROM observations
    WHERE ${liveObsFilterSql('')}
      AND scope IS NULL
      AND LENGTH(COALESCE(narrative, '')) > 100
      AND ${notLowSignalTitleClause('')}
      ${projectClause}
  `);
  return (project ? stmt.get(project) : stmt.get()).c;
}

export async function executeReenrich(db, limit = 10, { scope = 'narrow', project } = {}) {
  const candidates = findReenrichCandidates(db, limit, { scope, project });
  if (candidates.length === 0) return { processed: 0, skipped: 0 };

  let processed = 0,
    skipped = 0;
  const validTypes = OBS_TYPE_SET;

  for (const cand of candidates) {
    const gotSlot = await acquireLLMSlot();
    if (!gotSlot) {
      skipped++;
      continue;
    }

    try {
      if (scope === 'scopes') {
        // Classification-only pass (D#135 P3). One cheap Haiku call per row, and
        // the UPDATE touches exactly ONE column — this pool is full of curated
        // lesson-bearing rows, so borrowing the general re-enrich (which rewrites
        // title/narrative/lesson and stamps optimized_at) would risk permanent
        // content loss to buy a single enum value.
        const scopePrompt = `Classify where this coding memory APPLIES. Return ONLY valid JSON, no markdown fences.

Title: ${truncate(cand.title || '(untitled)', 200)}
Narrative: ${truncate(cand.narrative || '(no narrative)', 500)}
Lesson: ${truncate(cand.lesson_learned || '(none)', 300)}

JSON: {"scope":"file|module|project|environment"}
scope: ${SCOPE_PROMPT_LEGEND}`;
        const parsed = await callModelJSONAsync(scopePrompt, 'haiku', {
          timeout: BG_LLM_TIMEOUT_MS,
          maxTokens: 60,
        });
        const scopeValue = normalizeScope(parsed && parsed.scope);
        if (!scopeValue) {
          skipped++;
          continue;
        }
        // `AND scope IS NULL` is the fill-only-empty guard: a save-enrich worker or
        // an episode upgrade can land between candidate selection and this write,
        // and a classifier round-trip is long enough for that to be real.
        const res = db
          .prepare('UPDATE observations SET scope = ? WHERE id = ? AND scope IS NULL')
          .run(scopeValue, cand.id);
        if (res.changes === 0) {
          skipped++;
          continue;
        }
        // Nothing derived to rebuild: scope is a filter column, absent from the FTS text.
        processed++;
        continue;
      }
      if (scope === 'aliases') {
        // Alias-only backfill: generate search_aliases and APPEND them (plus any
        // CJK bigrams) to the EXISTING FTS text. Never rebuild text from
        // concepts/facts (empty on manual saves → would drop the original
        // narrative terms and regress recall) and never touch the user's curated
        // title / narrative / lesson / type / importance.
        const aliasPrompt = `Generate alternative search terms so this memory is findable by paraphrase, synonym, or cross-language queries. Return ONLY valid JSON, no markdown fences.

Title: ${truncate(cand.title || '(untitled)', 200)}
Narrative: ${truncate(cand.narrative || '(no narrative)', 500)}

JSON: {"search_aliases":["alt phrasing","synonym","spelled-out jargon","CJK term if the domain word has one"],"scope":"file|module|project|environment"}
Give 3-6 aliases: words a user might search for the SAME concept but that are NOT already in the title (synonyms, the spelled-out form of an acronym, the jargon term for a described symptom, a CJK translation of a key domain term).
scope: ${SCOPE_PROMPT_LEGEND}`;
        const parsed = await callModelJSONAsync(aliasPrompt, 'haiku', {
          timeout: BG_LLM_TIMEOUT_MS,
          maxTokens: 300,
        });
        const aliasArr =
          parsed && Array.isArray(parsed.search_aliases)
            ? parsed.search_aliases.filter((a) => typeof a === 'string' && a.trim().length > 0)
            : [];
        if (!aliasArr.length) {
          skipped++;
          continue;
        }
        const searchAliases = aliasArr.slice(0, 6).join(' ');
        const aliasBigrams = cjkBigrams(searchAliases);
        const appendedText = [cand.text || '', searchAliases, aliasBigrams].filter(Boolean).join(' ');
        const safe = scrubRecord('observations', { text: appendedText, search_aliases: searchAliases });
        // scope rides this call for free (D#135 P3). COALESCE, not a plain set:
        // an omitted or off-enum value normalizes to null and must not erase a
        // classification an earlier face already wrote.
        // D#12: the live-row guard, on the WHERE and not merely on the SELECT that chose
        // the row. The Haiku call above is up to BG_LLM_TIMEOUT_MS (45 s), long enough for
        // a concurrent hook to supersede or auto-compress this row — R10 P3-3's finding,
        // fixed then on the general branch only and carried by the concepts branch since
        // D#6. This was the one branch of the four without it. `changes === 0` is a SKIP,
        // not a success: it must not count as processed. (It also used to guard a vector
        // rebuild on a dead row; that rebuild is gone, the liveness reason is not.)
        const res = db
          .prepare(
            `UPDATE observations SET search_aliases = ?, text = ?, scope = COALESCE(?, scope)
             WHERE id = ? AND ${liveObsFilterSql('')}`,
          )
          .run(safe.search_aliases, safe.text, normalizeScope(parsed.scope), cand.id);
        if (res.changes === 0) {
          skipped++;
          continue;
        }
        processed++;
        continue;
      }
      if (scope === 'concepts') {
        // Concepts-only backfill (D#6). Writes concepts + facts and APPENDS them to the
        // existing FTS text — never rebuilds it, for the reason the alias branch gives:
        // a rebuild from concepts/facts drops the original narrative and alias terms and
        // regresses recall. Never touches the user's curated title / narrative / lesson /
        // type / importance, and never stamps optimized_at, so the wide pass keeps its
        // own candidates exactly as the alias and scopes passes leave them.
        const conceptsPrompt = `Extract search concepts and concrete facts from this coding memory. Return ONLY valid JSON, no markdown fences.

Title: ${truncate(cand.title || '(untitled)', 200)}
Narrative: ${truncate(cand.narrative || '(no narrative)', 500)}

JSON: {"concepts":["kw1","kw2"],"facts":["specific fact 1","specific fact 2"]}
concepts: 3-8 short keyword phrases naming what this memory is ABOUT (systems, components, error classes, techniques).
facts: 1-4 specific, checkable statements the narrative actually asserts. Omit rather than invent.`;
        const parsed = await callModelJSONAsync(conceptsPrompt, 'haiku', {
          timeout: BG_LLM_TIMEOUT_MS,
          maxTokens: 300,
        });
        const pickStrings = (v) =>
          Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim().length > 0) : [];
        const conceptArr = pickStrings(parsed && parsed.concepts);
        // No concepts is a SKIP, not an empty write: writing '' would leave the row in
        // this pool forever, and the pass would burn one Haiku call per cycle on it.
        if (!conceptArr.length) {
          skipped++;
          continue;
        }
        const factArr = pickStrings(parsed && parsed.facts);
        const conceptsOnly = conceptArr.slice(0, 10).join(' ');
        const factsOnly = factArr.slice(0, 10).join(' ');
        const appendedText = [
          cand.text || '',
          conceptsOnly,
          factsOnly,
          cjkBigrams(`${conceptsOnly} ${factsOnly}`),
        ]
          .filter(Boolean)
          .join(' ');
        const safe = scrubRecord('observations', {
          concepts: conceptsOnly,
          facts: factsOnly,
          text: appendedText,
        });
        // Fill-only-empty on `concepts` plus the live-row guard, both on the WHERE and
        // not merely on the SELECT: the round-trip above is up to 45 s, long enough for a
        // concurrent hook to supersede or compress the row (R10 P3-3) or for save-enrich
        // to fill it. `facts` rides along with preserve-on-empty for the same reason the
        // general pass preserves it — a partial answer must not wipe a filled column.
        const res = db
          .prepare(
            `UPDATE observations SET concepts = ?, facts = COALESCE(NULLIF(?, ''), facts), text = ?
             WHERE id = ? AND (concepts IS NULL OR concepts = '') AND ${liveObsFilterSql('')}`,
          )
          .run(safe.concepts, safe.facts, safe.text, cand.id);
        if (res.changes === 0) {
          skipped++;
          continue;
        }
        processed++;
        continue;
      }
      const prompt = `Re-enrich this observation with structured metadata. Return ONLY valid JSON, no markdown fences.

Title: ${truncate(cand.title || '(untitled)', 200)}
Narrative: ${truncate(cand.narrative || '(no narrative)', 500)}
Type: ${cand.type || 'change'}

JSON: {"type":"decision|bugfix|feature|refactor|discovery|change","title":"improved ≤120 char title","narrative":"improved 2-3 sentence narrative","concepts":["kw1","kw2"],"facts":["specific fact 1","specific fact 2"],"importance":1,"lesson_learned":"non-obvious insight or 'none' if routine","search_aliases":["alt query 1","alt query 2"],"scope":"file|module|project|environment"}
importance: 0=no value, 1=routine, 2=notable non-obvious insight, 3=critical. Default 1.
lesson_learned: State what was learned. If routine, write "none".
search_aliases: 2-6 alternative search terms (include CJK if applicable).
scope: ${SCOPE_PROMPT_LEGEND}`;

      const parsed = await callModelJSONAsync(prompt, 'haiku', {
        timeout: BG_LLM_TIMEOUT_MS,
        maxTokens: 500,
      });
      if (!parsed || !parsed.title) {
        skipped++;
        continue;
      }

      // Auto-hide on importance:0 targets fully-degraded NARROW rows (this branch predates
      // the wide-scope widening). A wide candidate has a substantive narrative (>100 chars)
      // and a real bugfix/feature/decision type by construction, and COMPRESSED_AUTO(-1) is
      // reachable by no auto-recovery pass — so one Haiku "importance 0" misjudgment would
      // hide a real observation until manual surgery. In wide scope, fall through and let
      // clampImportance floor it to 1 (kept visible, low-ranked) instead of hiding.
      if ((parsed.importance === 0 || parsed.importance === '0') && scope !== 'wide') {
        // D#12, and this one is not a stale-write guard — it is a POINTER guard.
        // `compressed_into` is the child -> keeper link, and COMPRESSED_AUTO is -1. If a
        // concurrent cluster-merge or smart-compress adopts this row during the 45 s Haiku
        // call, it holds a POSITIVE keeper id; overwriting that with -1 does not merely
        // stamp a dead row, it destroys the link — lib/maintain-core.mjs:316 recovers
        // orphans with `compressed_into > 0`, and recoverChildrenOf follows the same id.
        // The sibling write in lib/maintain-core.mjs:631 already carries this predicate,
        // so the codebase had decided the question and this site had not been updated.
        const res = db
          .prepare(
            `UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}, optimized_at = ?
             WHERE id = ? AND ${liveObsFilterSql('')}`,
          )
          .run(Date.now(), cand.id);
        if (res.changes === 0) {
          skipped++;
          continue;
        }
        processed++;
        continue;
      }

      // Enrichment ("add a lesson") must not reclassify a specific type down to the generic
      // 'change' (lower TYPE_QUALITY + faster decay); keep the stored type on that downgrade.
      let type = validTypes.has(parsed.type) ? parsed.type : cand.type || 'change';
      if (type === 'change' && cand.type && cand.type !== 'change') type = cand.type;
      const concepts = Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 10) : [];
      const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 10) : [];
      // Preserve-on-empty: wide-scope candidates can already carry concepts/facts/aliases
      // (findReenrichCandidates requires only lesson_learned empty), so a partial re-enrich
      // that returns a lesson but omits/empties these must NOT wipe them — the same UPDATE
      // sets optimized_at, locking the row out of any future re-enrich (:88), so the loss is
      // permanent. Keep the candidate's existing value when the LLM returned nothing. (Narrow
      // candidates are all-null on these by their WHERE, so cand.* is falsy → no-op there.)
      const conceptsText = concepts.length ? concepts.join(' ') : cand.concepts || '';
      const factsText = facts.length ? facts.join(' ') : cand.facts || '';
      // Scrub BEFORE truncate so a secret straddling the cut can't leave a sub-6-char
      // head that scrubSecrets's value-length floor no longer matches (the scrubRecord
      // below would then miss it too). Mirrors the hook-llm save-path fix.
      const lessonLearned =
        typeof parsed.lesson_learned === 'string' &&
        parsed.lesson_learned.toLowerCase() !== 'none' &&
        parsed.lesson_learned.trim().length > 0
          ? scrubSecrets(parsed.lesson_learned).slice(0, 500)
          : null;
      const searchAliases =
        Array.isArray(parsed.search_aliases) && parsed.search_aliases.length
          ? parsed.search_aliases.slice(0, 6).join(' ')
          : cand.search_aliases || null;
      // R10 P1-4. `wide` is the lesson-backfill pass by definition — its WHERE selects rows
      // that already have a substantive narrative and only lack a lesson. Rewriting their
      // title and cutting their narrative at 500 chars is not enrichment, it is content
      // loss: this UPDATE also stamps optimized_at, which evicts the row from all three
      // re-enrich pools permanently, and unlike applyObsUpdate there is no snapshot to
      // restore from. The affected rows are exactly the hand-written ones (mem_save,
      // mem_update --narrative, import-jsonl); hook-llm caps its own writes at 500, which
      // is why this stayed invisible. So wide carries the stored values through unchanged.
      //
      // For `narrow`, the truncate stays on LLM output but NOT on the preserve-on-empty
      // fallback — truncating the row's own stored narrative to buy nothing was the same
      // bug in miniature.
      const isWide = scope === 'wide';
      const title = isWide ? cand.title : truncate(scrubSecrets(parsed.title || ''), 120);
      const narrative = isWide
        ? cand.narrative
        : parsed.narrative
          ? truncate(scrubSecrets(parsed.narrative), 500)
          : cand.narrative || '';
      // Floor at the stored importance: re-enrich adds a lesson, it must never silently downgrade
      // a user-set/promoted importance (the UPDATE also sets optimized_at → the loss is permanent).
      // Upgrades are still honored.
      const importance = Math.max(clampImportance(parsed.importance), cand.importance || 1);

      const bigramText = cjkBigrams((title || '') + ' ' + (narrative || ''));
      const textField = [conceptsText, factsText, searchAliases || '', bigramText].filter(Boolean).join(' ');
      const minhashSig = computeMinHash((title || '') + ' ' + (narrative || ''));

      // Scrub LLM-output text fields at the UPDATE boundary. type is an
      // enum, importance is numeric, minhash_sig is hash bytes.
      const safe = scrubRecord('observations', {
        title,
        narrative,
        concepts: conceptsText,
        facts: factsText,
        text: textField,
        lesson_learned: lessonLearned,
        search_aliases: searchAliases,
      });
      // R10 P3-3: the live-row guard on the WHERE. The LLM round-trip above is up to 45 s,
      // and a concurrent hook can supersede or auto-compress this row inside that window —
      // without the guard the dead row was rewritten with stale content AND stamped
      // optimized_at, which resurrects it into every pool that filters on the stamp. The
      // scopes branch already guards with `AND scope IS NULL`; this is the same idea.
      // 0 changes is a skip, not a success: it must not count as processed and must not
      // rebuild a vector for a row that is no longer live.
      const res = db
        .prepare(
          `
        UPDATE observations SET type=?, title=?, narrative=?, concepts=?, facts=?,
          text=?, importance=?, lesson_learned=?, search_aliases=?, minhash_sig=?, optimized_at=?,
          scope=COALESCE(?, scope)
        WHERE id = ? AND ${liveObsFilterSql('')}
      `,
        )
        .run(
          type,
          safe.title,
          safe.narrative,
          safe.concepts,
          safe.facts,
          safe.text,
          importance,
          safe.lesson_learned,
          safe.search_aliases,
          minhashSig,
          Date.now(),
          // COALESCE (mirrors the hook-llm upgrade path): a re-enrich that omits
          // scope, or emits an off-enum value, must never blank an existing label —
          // and THIS update stamps optimized_at, so the loss would be permanent.
          normalizeScope(parsed.scope),
          cand.id,
        );
      if (res.changes === 0) {
        skipped++;
        continue;
      }

      processed++;
    } catch (e) {
      debugCatch(e, 'reenrich');
      skipped++;
    } finally {
      releaseLLMSlot();
    }
  }

  if (processed > 0) debugLog('DEBUG', 'llm-optimize', `re-enriched ${processed} degraded observations`);
  return { processed, skipped };
}

// ─── Task 2: Normalize ─────────────────────────────────────────────────────

const NORMALIZE_GATE_FILE = join(RUNTIME_DIR, 'last-normalize.json');
const NORMALIZE_INTERVAL_MS = 7 * DAY_MS; // 7 days

// Pure gate decision (no IO) — exported for testing. Fail-OPEN on a
// malformed-but-valid-JSON gate: a missing/non-numeric `epoch` makes
// `now - epoch` NaN, and `NaN >= INTERVAL` is false — which would PERMANENTLY
// block normalize with no recovery, contradicting the catch-branch's fail-open
// intent (a corrupt file that fails JSON.parse already returns true). A future
// epoch (clock skew / NTP correction) is equally suspect → run.
export function _normalizeGateOpen(last, now) {
  const epoch = last?.epoch;
  if (typeof epoch !== 'number' || !Number.isFinite(epoch) || epoch > now) return true;
  return now - epoch >= NORMALIZE_INTERVAL_MS;
}

export function shouldRunNormalize(project = null) {
  // The 7-day gate rate-limits the UNSCOPED whole-store normalize. An explicit --project is
  // targeted work: it must not be blocked by a prior global (or other-project) run, and it
  // does not advance the shared timer (see executeNormalize). Without this, `optimize --run
  // --task normalize --project B` returned skipped(gate) for 7 days if ANY project had run.
  if (project) return true;
  try {
    const last = JSON.parse(readFileSync(NORMALIZE_GATE_FILE, 'utf8'));
    return _normalizeGateOpen(last, Date.now());
  } catch {
    return true;
  }
}

/**
 * Longest concept token allowed into the normalize prompt (R10-P3-21 layer 1).
 *
 * Measured 2026-09-08 over three populations — the real DB (1 row with concepts, 10
 * distinct tokens, max 13), `benchmark/fixtures/seed-data.json` (200 rows, 541 distinct,
 * max 22 = `infrastructure-as-code`) and `seed-data-cjk.json` (31 rows, 55 distinct,
 * max 9). Combined 606 distinct real tokens, longest 22. 40 is ~1.8x that, so the gate
 * has room for vocabulary this corpus has not seen yet. The real-DB arm is far too small
 * to calibrate on and is named here so nobody re-derives the number from it alone.
 */
const CONCEPT_MAX_LEN = 40;

/**
 * Characters that make a JSON-shaped injection expressible, and that no real concept has.
 * Zero of the 606 measured tokens contain any of them.
 *
 * A DENYLIST, deliberately, not an allowlist of word characters: `\w` is ASCII-only in JS,
 * so an allowlist would eat `café` along with the payload, and silently narrowing a
 * retrieval feature is a worse failure than the one being fixed. Control characters are
 * included because `\s` already excludes whitespace at the split, but not every C0 byte.
 */
// The C0 range below is written as ESCAPES, never as literal bytes. An earlier edit of
// this line put real 0x00 and 0x1F characters into the source, and all three symptoms
// were the same one: grep classified the file as binary and silently returned nothing,
// and both the Edit tool and bash refused strings containing them. Same class as the
// grep -a lesson already in MEMORY.md.
//
// A literal HYPHEN is absent on purpose - `infrastructure-as-code`, `react-hook-form`,
// `better-sqlite3` and `utf-8` are all measured real concepts, and an earlier draft that
// included one would have filtered every one of them. The hyphen below is a RANGE
// operator. A literal space is unnecessary: the caller split on whitespace to get here.
//
// The C0 range is the POINT of the disable below, not an oversight: the caller splits
// on /\s+/, which covers tab, newline, CR, FF, VT and space but NOT
// 0x00-0x08 or 0x0E-0x1F, so those bytes reach here inside a "single token".
// eslint-disable-next-line no-control-regex
const CONCEPT_SHAPE_DENY = /[{}[\]"'`\\<>\u0000-\u001F]/;

/**
 * Is this token shaped like a concept rather than like a payload? (R10-P3-21 layer 1.)
 *
 * The bound that makes this workable is upstream and worth stating: extractUniqueConcepts
 * splits on /\s+/, so anything reaching here is already a single whitespace-free token —
 * prose instructions cannot survive that, and what remains expressible is the JSON-shaped
 * group literal, which needs the characters above.
 */
export function isConceptShaped(token) {
  return (
    typeof token === 'string' &&
    token.length >= 2 &&
    token.length <= CONCEPT_MAX_LEN &&
    !CONCEPT_SHAPE_DENY.test(token)
  );
}

export function extractUniqueConcepts(db, limit = 500, { project } = {}) {
  const projectClause = project ? 'AND project = ?' : '';
  const stmt = db.prepare(`
    SELECT concepts FROM observations
    WHERE ${liveObsFilterSql('')}
      AND concepts IS NOT NULL AND concepts != ''
      ${projectClause}
    ORDER BY created_at_epoch DESC, id DESC -- D#9: total order, see findReenrichCandidates
    LIMIT 2000
  `);
  const rows = project ? stmt.all(project) : stmt.all();

  const conceptSet = new Set();
  for (const row of rows) {
    for (const c of row.concepts.split(/\s+/)) {
      const trimmed = c.trim();
      // R10-P3-21 layer 1. This function's output is a PROMPT INGREDIENT: it is joined
      // with ', ' and sent to Sonnet, whose answer is then written back across every
      // project. So the shape gate belongs here, at the boundary where stored content
      // becomes model input — not at the write, which is far too late.
      if (isConceptShaped(trimmed)) conceptSet.add(trimmed);
    }
  }
  return [...conceptSet].slice(0, limit);
}

export async function identifySynonymGroups(concepts) {
  const gotSlot = await acquireLLMSlot();
  if (!gotSlot) return [];

  try {
    // R10-P3-21 layer 2: static instructions in `system`, stored content in `user`, the
    // same split episode extraction and session summary already use (hook-llm.mjs:906,
    // :1408). callModelJSONAsync has taken this shape since haiku-client.mjs:161's
    // splitPrompt — API mode maps it to a cached system role, CLI mode renders it with an
    // explicit boundary marker — so this is adopting an existing contract, not adding one.
    const system = `Analyze concept terms from a code memory database and identify synonym groups (terms that refer to the same concept). Include cross-language synonyms (English/Chinese). Return ONLY valid JSON.

JSON: {"groups":[{"canonical":"preferred term","aliases":["synonym1","synonym2"]}, ...]}

Rules:
- Only include groups where you are confident the terms are true synonyms
- canonical should be the most specific/technical term
- Include CJK ↔ English equivalents if present
- Skip terms that have no synonyms in the list
- Every canonical and every alias MUST be a term from the list; never introduce a new one
${MEMORY_INPUT_GUARD}`;
    const user = `Concepts: ${concepts.join(', ')}`;

    const parsed = await callModelJSONAsync({ system, user }, 'sonnet', {
      timeout: BG_LLM_TIMEOUT_MS,
      maxTokens: 1000,
    });
    if (!parsed?.groups || !Array.isArray(parsed.groups)) return [];
    const wellFormed = parsed.groups.filter(
      (g) => g.canonical && Array.isArray(g.aliases) && g.aliases.length > 0,
    );

    // R10-P3-21 layer 3. The prompt rule above is a request; this is the enforcement, and
    // the two are not redundant — layer 2 is defense-in-depth wiring, not a behavioural
    // guarantee (lesson #8605: prompt wording barely moves the model). Normalization maps
    // EXISTING terms onto an existing preferred term, so a canonical or alias the corpus
    // never had is out of contract by construction, whatever produced it — a jailbreak, a
    // hallucination, or a future edit that weakens the prompt.
    //
    // Case-insensitive because applyNormalization's aliasMap lowercases on both sides
    // (:738 and :774). A stricter check here would reject groups that function would have
    // applied, i.e. two predicates deciding one thing.
    const known = new Set(concepts.map((c) => c.toLowerCase()));
    return wellFormed.filter(
      (g) =>
        known.has(String(g.canonical).toLowerCase()) &&
        g.aliases.every((a) => known.has(String(a).toLowerCase())),
    );
  } catch (e) {
    debugCatch(e, 'normalize-identify');
    return [];
  } finally {
    releaseLLMSlot();
  }
}

export function applyNormalization(db, groups, { project = null } = {}) {
  if (!groups || groups.length === 0) return { updated: 0 };

  const aliasMap = new Map();
  for (const g of groups) {
    for (const alias of g.aliases) {
      aliasMap.set(alias.toLowerCase(), g.canonical);
    }
  }

  // Scope the mutation to `project` when normalize was scoped (v2.72.0 --project).
  // Without this, synonym groups derived from ONE project's concepts rewrote the
  // concepts/search_aliases of EVERY project's observations — the exact cross-project
  // contamination the --project flag was added to prevent. NULL → all projects (legacy
  // unscoped run), matching the search-engine `(? IS NULL OR project = ?)` idiom.
  const rows = db
    .prepare(
      `
    SELECT id, title, narrative, concepts, search_aliases, lesson_learned FROM observations
    WHERE ${liveObsFilterSql('')}
      AND concepts IS NOT NULL AND concepts != ''
      AND (? IS NULL OR project = ?)
  `,
    )
    .all(project, project);

  let updated = 0;
  // R10 P2-2: normalize does NOT stamp optimized_at. That column is the "re-enrich has
  // seen this row" marker read by all three re-enrich pools (:156, :177) and by
  // cluster-merge (:634); writing it here evicted a row from lesson backfill because a
  // synonym replacement touched one concept term — two unrelated passes sharing one flag.
  // Nothing in normalize needs it: its own re-run gate is the 7-day NORMALIZE_GATE_FILE
  // timer, and the pass is idempotent anyway because a canonicalized term stops matching
  // an alias, so `changed` stays false on the second run.
  const updateStmt = db.prepare(`
    UPDATE observations SET concepts = ?, search_aliases = ? WHERE id = ?
  `);

  for (const row of rows) {
    const terms = row.concepts.split(/\s+/);
    let changed = false;
    const newTerms = terms.map((t) => {
      const canonical = aliasMap.get(t.toLowerCase());
      if (canonical && canonical !== t) {
        changed = true;
        return canonical;
      }
      return t;
    });

    if (changed) {
      const uniqueConcepts = [...new Set(newTerms)].join(' ');
      const existingAliases = row.search_aliases || '';
      const originalTerms = terms.filter(
        (t) => aliasMap.has(t.toLowerCase()) && aliasMap.get(t.toLowerCase()) !== t,
      );
      const newAliases = [existingAliases, ...originalTerms].filter(Boolean).join(' ');
      // Defense-in-depth scrub. Canonical concept names come from LLM output
      // (identifySynonymGroups via Sonnet); existing values are already
      // scrubbed but free LLM tokens can re-introduce secret-shaped strings.
      const safe = scrubRecord('observations', {
        concepts: uniqueConcepts,
        search_aliases: newAliases,
      });
      updateStmt.run(safe.concepts, safe.search_aliases, row.id);
      updated++;
    }
  }

  if (updated > 0) debugLog('DEBUG', 'llm-optimize', `normalized concepts in ${updated} observations`);
  return { updated };
}

export async function executeNormalize(db, force = false, { project } = {}) {
  if (!force && !shouldRunNormalize(project)) return { skipped: true, reason: 'gate' };

  const concepts = extractUniqueConcepts(db, 500, { project });
  if (concepts.length < 5) return { skipped: true, reason: 'too few concepts' };

  const groups = await identifySynonymGroups(concepts);
  if (groups.length === 0) return { processed: 0, groups: 0 };

  const result = applyNormalization(db, groups, { project });

  // Only the UNSCOPED (whole-store) run advances the shared 7-day gate. A project-scoped run
  // must not reset the global timer (it never consulted it — shouldRunNormalize(project) is
  // always open), or one `--project X` run would silently block the next global normalize.
  if (!project) {
    try {
      writeFileSync(NORMALIZE_GATE_FILE, JSON.stringify({ epoch: Date.now() }));
    } catch {
      /* best-effort */
    }
  }

  return { processed: result.updated, groups: groups.length };
}

// ─── Task 3: Cluster-merge ─────────────────────────────────────────────────

const MERGE_TIME_WINDOW_MS = 30 * DAY_MS;
// Merge-review band [MERGE_JACCARD_LOW, AUTO_MERGE_THRESHOLD): titles in this
// Jaccard range are LLM-reviewed for merge; at/above AUTO_MERGE_THRESHOLD they'd
// already auto-merge elsewhere, below MERGE_JACCARD_LOW they're too dissimilar.

export function findMergeCandidates(db, maxClusters = 5, { project } = {}) {
  const cutoff = Date.now() - MERGE_TIME_WINDOW_MS;
  const projectClause = project ? 'AND project = ?' : '';
  const stmt = db.prepare(`
    -- search_aliases used to be in this list for R10 P3-7: the merge path read
    -- keeper.search_aliases when it rebuilt the keeper's TF-IDF vector. Phase-2 removed that
    -- rebuild, so the column had no reader left and went with it. Do NOT re-add it on the
    -- strength of R10 P3-7 -- that finding is moot, not pending. executeMergeCluster reads
    -- keeper.{id,importance,narrative,concepts,facts} and o.{id,title,type,narrative,
    -- importance,access_count,lesson_learned}, and nothing else off these rows.
    SELECT id, title, narrative, project, type, access_count, importance, created_at_epoch, minhash_sig, lesson_learned, concepts, facts
    FROM observations
    WHERE ${liveObsFilterSql('')}
      AND optimized_at IS NULL
      AND title IS NOT NULL AND title != ''
      AND created_at_epoch > ?
      ${projectClause}
    -- D#9: this pool's head is what the keeper reduce falls back to on a full tie, so an
    -- arbitrary tie order decides WHICH DUPLICATE SURVIVES a merge. Same-episode rows are
    -- exactly that tie (same project, same importance, access_count 0, same millisecond).
    ORDER BY created_at_epoch DESC, id DESC
    LIMIT 200
  `);
  const rows = project ? stmt.all(cutoff, project) : stmt.all(cutoff);

  const used = new Set();
  const clusters = [];

  for (let i = 0; i < rows.length && clusters.length < maxClusters; i++) {
    if (used.has(rows[i].id)) continue;
    const cluster = [rows[i]];

    for (let j = i + 1; j < rows.length && cluster.length < 5; j++) {
      if (used.has(rows[j].id)) continue;
      if (rows[i].project !== rows[j].project) continue;
      if (Math.abs(rows[i].created_at_epoch - rows[j].created_at_epoch) > MERGE_TIME_WINDOW_MS) continue;

      if (rows[i].minhash_sig && rows[j].minhash_sig) {
        // 0.8 slack: the MinHash estimate is noisy, so pre-filter a band below
        // MERGE_JACCARD_LOW rather than at it, to avoid dropping true candidates.
        const est = estimateJaccardFromMinHash(rows[i].minhash_sig, rows[j].minhash_sig);
        if (est < MERGE_JACCARD_LOW * 0.8) continue;
      }

      const titleSim = jaccardSimilarity(rows[i].title, rows[j].title);
      if (titleSim >= MERGE_JACCARD_LOW && titleSim < AUTO_MERGE_THRESHOLD) {
        cluster.push(rows[j]);
        used.add(rows[j].id);
      }
    }

    if (cluster.length >= 2) {
      used.add(rows[i].id);
      clusters.push(cluster);
    }
  }

  return clusters;
}

export async function executeMergeCluster(db, cluster) {
  if (cluster.length < 2) return { merged: false };

  const gotSlot = await acquireLLMSlot();
  if (!gotSlot) return { merged: false };

  try {
    const obsDescriptions = cluster
      .map(
        (o, i) =>
          `${i + 1}. [${o.type || 'change'}] "${truncate(o.title, 200)}" — ${truncate(o.narrative || '(no narrative)', 500)}`,
      )
      .join('\n');

    const prompt = `These observations from a code memory database may be about the same topic. Should they be merged into a single observation?

Observations:
${obsDescriptions}

Return ONLY valid JSON:
- If they should NOT be merged: {"should_merge":false}
- If they SHOULD be merged: {"should_merge":true,"merged_title":"≤120 char comprehensive title","merged_narrative":"comprehensive ≤800 char summary preserving all key details","merged_concepts":["kw1","kw2"],"merged_facts":["specific fact 1"],"merged_lesson":"synthesized non-obvious lesson or null","importance":2}`;

    const parsed = await callModelJSONAsync(prompt, 'sonnet', {
      timeout: BG_LLM_TIMEOUT_MS,
      maxTokens: 1000,
    });
    if (!parsed || !parsed.should_merge) return { merged: false };

    // Keeper = highest importance, then highest access_count, then highest id. Previously
    // access_count alone, so a critical (importance=3) but never-accessed observation lost
    // the keeper role to a trivial (importance=1) accessed one and was compressed away.
    //
    // D#9: the third term is the one that makes this TOTAL. Without it a full tie fell
    // through to `cluster[0]` — the SQL head — and same-episode duplicates are exactly a
    // full tie: same project, same importance, access_count 0, and a created_at_epoch in
    // the same millisecond 272 times out of 300 (measured 2026-09-07). On a tie SQLite
    // returns ASCENDING rowid while an untied pool returns the newest first, so which
    // duplicate survived flipped on whether two writes straddled a millisecond. Ordering
    // the pool alone would not have been enough: this reduce is exported to callers that
    // build their own cluster, so it has to be total on its own. Highest id = written last
    // = the version whose content the merged summary should be anchored on.
    const keeper = cluster.reduce((best, o) => {
      const oi = o.importance || 1,
        bi = best.importance || 1;
      if (oi !== bi) return oi > bi ? o : best;
      const oa = o.access_count || 0,
        ba = best.access_count || 0;
      if (oa !== ba) return oa > ba ? o : best;
      return (o.id || 0) > (best.id || 0) ? o : best;
    }, cluster[0]);
    const others = cluster.filter((o) => o.id !== keeper.id);
    // Floor the merged importance at the cluster max — merging must never silently
    // downgrade the ranking of the most-important member (the LLM default is 2). The keeper
    // is selected by importance-first, so keeper.importance IS the cluster max by construction.
    const maxClusterImportance = keeper.importance || 1;

    const concepts = Array.isArray(parsed.merged_concepts) ? parsed.merged_concepts.slice(0, 10) : [];
    const facts = Array.isArray(parsed.merged_facts) ? parsed.merged_facts.slice(0, 10) : [];
    // Preserve-on-empty (mirror the merged_lesson guard below + the re-enrich path): the merge
    // overwrites the keeper in place, so a partial LLM response that omits these must fall back to
    // the keeper's own values, not blank its live concepts/facts (findMergeCandidates now selects them).
    const conceptsText = concepts.length ? concepts.join(' ') : keeper.concepts || '';
    const factsText = facts.length ? facts.join(' ') : keeper.facts || '';
    // Scrub BEFORE truncate (see re-enrich note): keep the boundary cut on
    // already-scrubbed text so a straddling secret can't leak a sub-floor head.
    const title = truncate(scrubSecrets(parsed.merged_title || ''), 120);
    const narrative = truncate(scrubSecrets(parsed.merged_narrative || keeper.narrative || ''), 800);
    // Preserve-on-empty. The merge overwrites the keeper in place and hides every non-keeper
    // member (compressed_into=keeper.id), so if the LLM returns merged_lesson:null (the prompt
    // at :429 explicitly permits it) every cluster lesson would leave all live surfaces at once
    // with no auto-recovery — the keeper snapshot and hidden members sit at compressed_into>0,
    // which recoverBuriedLessons (compressed_into=0 only) skips. So use the LLM's synthesized
    // lesson when non-empty, else fall back to the union of the members' own non-empty lessons.
    // findMergeCandidates filters superseded_at IS NULL, so the union pulls only LIVE members
    // (a tombstoned/retired lesson can't resurrect onto the keeper). The union is scrubbed then
    // capped at 500 chars like a single lesson, so an unusually long union may truncate trailing
    // members — still strictly better than the prior unconditional null (partial > total loss).
    let lessonLearned =
      typeof parsed.merged_lesson === 'string' && parsed.merged_lesson.trim().length > 0
        ? scrubSecrets(parsed.merged_lesson).slice(0, 500)
        : null;
    if (!lessonLearned) {
      const memberLessons = [
        ...new Set(
          cluster.map((o) => (o.lesson_learned || '').trim()).filter((l) => l && l.toLowerCase() !== 'none'),
        ),
      ];
      if (memberLessons.length) lessonLearned = scrubSecrets(memberLessons.join(' — ')).slice(0, 500);
    }

    const bigramText = cjkBigrams((title || '') + ' ' + (narrative || ''));
    const textField = [conceptsText, factsText, bigramText].filter(Boolean).join(' ');
    const minhashSig = computeMinHash((title || '') + ' ' + (narrative || ''));
    const importance = Math.max(clampImportance(parsed.importance || 2), maxClusterImportance);

    // Scrub LLM-output cluster-merge text fields at the UPDATE boundary.
    // importance is numeric; minhash_sig is hash bytes.
    const safe = scrubRecord('observations', {
      title,
      narrative,
      concepts: conceptsText,
      facts: factsText,
      text: textField,
      lesson_learned: lessonLearned,
    });
    const mergeApplied = db.transaction(() => {
      // Re-check the keeper's liveness INSIDE the transaction (audit 2026-09-02 P0-3).
      // findMergeCandidates selected live rows, but a Sonnet round-trip sits between that
      // SELECT and this write (:617, BG_LLM_TIMEOUT_MS), and a concurrent SessionStart
      // auto-dedup or `save --supersedes` can tombstone the keeper in that window. Pointing
      // the other members at a tombstoned keeper is precisely the "buried behind a hidden
      // parent" loss that mergeDuplicates' docblock enumerates (lib/maintain-core.mjs), and
      // it is what that function's own isLive gate exists to prevent. Same predicate here.
      const keeperLive = db
        .prepare(`SELECT 1 FROM observations WHERE id = ? AND ${liveObsFilterSql('')}`)
        .get(keeper.id);
      if (!keeperLive) return false;

      // Snapshot the keeper's pre-merge row BEFORE overwriting it, so its original
      // full text survives as a recoverable compressed_into child (mirroring
      // compressGroup / recoverChildrenOf). The keeper is the cluster's most-
      // important member; an in-place overwrite by the LLM's ≤800-char summary
      // would otherwise destroy its original text irreversibly (HIGH-3 data loss).
      // Column list is derived from the live schema (minus id/compressed_into) so
      // it stays correct as migrations add columns; names are internal identifiers.
      const snapCols = db
        .prepare(`PRAGMA table_info(observations)`)
        .all()
        .map((c) => c.name)
        .filter((c) => c !== 'id' && c !== 'compressed_into');
      const snapColList = snapCols.join(', ');
      db.prepare(
        `INSERT INTO observations (${snapColList}, compressed_into)
         SELECT ${snapColList}, ? FROM observations WHERE id = ?`,
      ).run(keeper.id, keeper.id);

      db.prepare(
        `
        UPDATE observations SET title=?, narrative=?, concepts=?, facts=?, text=?,
          importance=?, lesson_learned=?, minhash_sig=?, optimized_at=?
        WHERE id = ?
      `,
      ).run(
        safe.title,
        safe.narrative,
        safe.concepts,
        safe.facts,
        safe.text,
        importance,
        safe.lesson_learned,
        minhashSig,
        Date.now(),
        keeper.id,
      );

      const otherIds = others.map((o) => o.id);
      const ph = otherIds.map(() => '?').join(',');
      // Live guard on the members too: one already compressed into ANOTHER summary S during
      // the LLM window would be re-pointed here, silently dropping a row out of S's child set.
      db.prepare(
        `UPDATE observations SET compressed_into = ? WHERE id IN (${ph}) AND ${liveObsFilterSql('')}`,
      ).run(keeper.id, ...otherIds);
      return true;
    })();
    if (!mergeApplied) {
      debugLog('DEBUG', 'llm-optimize', `cluster-merge aborted: keeper #${keeper.id} no longer live`);
      return { merged: false };
    }

    debugLog('DEBUG', 'llm-optimize', `merged ${cluster.length} observations into #${keeper.id}`);
    return { merged: true, keeperId: keeper.id, mergedCount: others.length };
  } catch (e) {
    debugCatch(e, 'cluster-merge');
    return { merged: false };
  } finally {
    releaseLLMSlot();
  }
}

export async function executeClusterMerge(db, maxClusters = 5, { project } = {}) {
  const clusters = findMergeCandidates(db, maxClusters, { project });
  if (clusters.length === 0) return { processed: 0, merged: 0 };

  let merged = 0;
  for (const cluster of clusters) {
    const result = await executeMergeCluster(db, cluster);
    if (result.merged) merged++;
  }

  return { processed: clusters.length, merged };
}

// ─── Task 4: Smart-compress ────────────────────────────────────────────────

const COMPRESS_TIME_SPLIT_MS = 14 * DAY_MS;

export function findSmartCompressCandidates(db, ageDays = 30, { project } = {}) {
  const cutoff = Date.now() - ageDays * DAY_MS;
  const projectClause = project ? 'AND project = ?' : '';
  const stmt = db.prepare(`
    SELECT id, title, narrative, lesson_learned, project, type, created_at_epoch
    FROM observations
    -- liveObsFilterSql, not compressed_into alone (audit 2026-09-02 P0-3): auto-dedup losers
    -- carry superseded_at with compressed_into=0 and match this predicate exactly (imp=1,
    -- access 0, no lesson), so the narrower filter fed RETRACTED text to Sonnet and returned
    -- it to live retrieval as a fresh "discovery" summary. Parity with findMergeCandidates.
    WHERE ${liveObsFilterSql('')}
      AND COALESCE(importance, 1) = 1
      AND COALESCE(access_count, 0) = 0
      -- Never auto-compress a lesson-bearing row. Smart-compress sets compressed_into
      -- on the originals (line ~693), which hides them from every injection/search
      -- surface AND puts them out of recoverBuriedLessons' reach (it only lifts
      -- compressed_into=0). A lesson demoted to imp=1 by citation-decay would be
      -- silently buried by the unattended 24h llm-optimize run. Exact parity with the
      -- canonical compress sibling selectCompressionCandidates (compress-core.mjs) —
      -- "lessons never auto-GC" (also enforced in decayAndMarkIdle, maintain-core.mjs).
      AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
      AND created_at_epoch < ?
      ${projectClause}
    ORDER BY project, created_at_epoch
  `);
  return project ? stmt.all(cutoff, project) : stmt.all(cutoff);
}

export function clusterForCompression(candidates) {
  if (candidates.length < 3) return [];

  const byProject = new Map();
  for (const c of candidates) {
    if (!byProject.has(c.project)) byProject.set(c.project, []);
    byProject.get(c.project).push(c);
  }

  const clusters = [];

  for (const [project, obs] of byProject) {
    if (obs.length < 3) continue;

    // The TF-IDF cosine branch that used to sit here is GONE with the vector arm
    // (Phase-2). This is not a behaviour change: getVocabulary() returned null whenever
    // the arm was off, which was the default, so grouping by time window alone was
    // ALREADY the shipped path — the cosine branch was unreachable in production.
    //
    // Read that as a WARNING, not as reassurance. A 14-day window with no similarity
    // check is a weak relatedness heuristic feeding an unattended write that HIDES its
    // inputs, and it is now the only one. What stands between it and a bad compression is
    // buildCompressPrompt's should_compress veto — measured 2026-09-07 at 6/6 refusals on
    // unrelated clusters, 0/6 false refusals on related ones, and decisive (6/6 stable
    // under member-order rotation) on partly-related ones. D#16 decided AGAINST making
    // this branch skip outright, on that evidence. Do not re-open it without re-running
    // benchmark/compress-veto-rate.mjs.
    const sorted = obs.sort((a, b) => a.created_at_epoch - b.created_at_epoch);
    let subCluster = [sorted[0]];
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k].created_at_epoch - subCluster[0].created_at_epoch > COMPRESS_TIME_SPLIT_MS) {
        if (subCluster.length >= 3) clusters.push({ project, observations: subCluster });
        subCluster = [sorted[k]];
      } else {
        subCluster.push(sorted[k]);
      }
    }
    if (subCluster.length >= 3) clusters.push({ project, observations: subCluster });
  }

  return clusters;
}

/**
 * The smart-compress prompt. Exported so a RULER can measure the shipped text.
 *
 * Extracted for benchmark/compress-veto-rate.mjs (D#10). It has to be one string in one
 * place: a ruler that retypes the prompt measures its own copy, which is exactly how
 * tests/handoff-simulation.test.mjs came to assert on a re-implementation while the real
 * hook emitted a block no user had ever seen.
 *
 * D#10. This prompt used to OPEN with "Summarize these related code memory observations",
 * asserting the premise it should have been testing, and the only bail was a missing title
 * — so the model had no way to refuse. The sibling executeMergeCluster has had
 * `should_merge` since it was written; these two LLM cluster paths disagreed about whether
 * the model may say no, and this is the one that HIDES its inputs (compressed_into removes
 * them from every injection and search surface and puts them out of recoverBuriedLessons'
 * reach).
 *
 * It matters because there is no upstream relatedness check at all any more.
 * clusterForCompression used to compute cosine similarity when a TF-IDF vocabulary was
 * available, but that vocabulary was null whenever the vector arm was off — the default —
 * so the 14-day-window-ALONE branch was already what shipped, and Phase-2's removal of the
 * arm made it the only branch. Measured with a control arm 2026-09-07, before the removal:
 * three unrelated observations over 12 days form 1 cluster with the arm off and 0 with it
 * on. This veto is therefore the ONLY thing standing between the heuristic and an
 * unattended write that hides real rows.
 *
 * @param {Array<object>} observations cluster members
 * @returns {string}
 */
export function buildCompressPrompt(observations) {
  const obsDescriptions = observations
    .map(
      (o, i) =>
        `${i + 1}. [${o.type || 'change'}] "${truncate(o.title || '(untitled)', 200)}" — ${truncate(o.narrative || '(no narrative)', 500)}${o.lesson_learned ? ` | Lesson: ${truncate(o.lesson_learned, 200)}` : ''}`,
    )
    .join('\n');

  return `These code memory observations were grouped by a heuristic that may be wrong. FIRST decide whether they are one story worth collapsing into a single memory. Return ONLY valid JSON.

Observations:
${obsDescriptions}

JSON: {"should_compress":true,"title":"descriptive summary ≤120 chars","narrative":"comprehensive summary ≤800 chars preserving key decisions and lessons","concepts":["kw1","kw2"],"facts":["all specific facts preserved"],"lesson_learned":"most important synthesized lesson or 'none'","search_aliases":["alt search 1","alt search 2"]}
should_compress: false when these are about unrelated systems, files or problems, or when a merged summary would lose more than it saves. Compressing HIDES the originals from search, so refuse when in doubt. When false, the other fields are ignored.
When true: preserve all important decisions, lessons, and specific facts.`;
}

export async function executeSmartCompressCluster(db, observations, project) {
  if (observations.length < 3) return { compressed: false };

  const gotSlot = await acquireLLMSlot();
  if (!gotSlot) return { compressed: false };

  try {
    const prompt = buildCompressPrompt(observations);

    const parsed = await callModelJSONAsync(prompt, 'sonnet', {
      timeout: BG_LLM_TIMEOUT_MS,
      maxTokens: 1000,
    });
    // Fail CLOSED, exactly as `should_merge` does: an omitted verdict refuses. The two
    // failure directions are not symmetric — refusing wrongly means a compression did not
    // happen, proceeding wrongly means unrelated observations were hidden from every
    // surface. On a path that hides its inputs, silence is not consent.
    if (!parsed || !parsed.should_compress) return { compressed: false };
    if (!parsed.title) return { compressed: false };

    // Scrub BEFORE truncate (see re-enrich note): boundary cut on scrubbed text.
    const title = truncate(scrubSecrets(parsed.title || ''), 120);
    const narrative = truncate(scrubSecrets(parsed.narrative || ''), 800);
    const concepts = Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 10) : [];
    const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 10) : [];
    const conceptsText = concepts.join(' ');
    const factsText = facts.join(' ');
    const lessonLearned =
      typeof parsed.lesson_learned === 'string' &&
      parsed.lesson_learned.toLowerCase() !== 'none' &&
      parsed.lesson_learned.trim().length > 0
        ? scrubSecrets(parsed.lesson_learned).slice(0, 500)
        : null;
    const searchAliases = Array.isArray(parsed.search_aliases)
      ? parsed.search_aliases.slice(0, 6).join(' ')
      : null;

    const bigramText = cjkBigrams((title || '') + ' ' + (narrative || ''));
    const textField = [conceptsText, factsText, searchAliases || '', bigramText].filter(Boolean).join(' ');

    const epochs = observations.map((o) => o.created_at_epoch).sort((a, b) => a - b);
    const medianEpoch = epochs[Math.floor(epochs.length / 2)];

    const summaryId = db.transaction(() => {
      const sessionId = `compress-${project}`;
      const now = new Date();
      db.prepare(
        `INSERT OR IGNORE INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?,?,?,?,?,'active')`,
      ).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

      // Defense-in-depth: title/narrative/etc. are LLM-generated compression
      // output; scrub at the persistence boundary regardless of upstream trust.
      const safe = scrubRecord('observations', {
        text: textField,
        title,
        narrative,
        concepts: conceptsText,
        facts: factsText,
        lesson_learned: lessonLearned,
        search_aliases: searchAliases,
      });
      // R10 P3-8: through the shared writer, not a fourth hand-spelled INSERT. The copy
      // this replaces had already drifted from OBS_COLUMNS in three ways — no minhash_sig
      // (so the summary was invisible to the MinHash prefilter that findDuplicates and
      // selectFuzzyDedupeIds run, and could never be deduplicated against anything), no
      // branch, and subtitle written as '' instead of the schema's NULL. That is exactly
      // the drift lib/observation-write.mjs's docblock says the shared column list exists
      // to make impossible.
      //
      // optimized_at is not in OBS_COLUMNS, so it stays a separate UPDATE below — the
      // summary must be marked processed so the re-enrich pools do not pick it up.
      const newId = insertObservationRow(db, {
        memory_session_id: sessionId,
        project,
        text: safe.text,
        type: 'discovery',
        title: safe.title,
        narrative: safe.narrative,
        concepts: safe.concepts,
        facts: safe.facts,
        importance: 2,
        minhash_sig: computeMinHash(`${title || ''} ${narrative || ''}`),
        lesson_learned: safe.lesson_learned,
        search_aliases: safe.search_aliases,
        branch: getCurrentBranch(),
        created_at: new Date(medianEpoch).toISOString(),
        created_at_epoch: medianEpoch,
      });
      db.prepare('UPDATE observations SET optimized_at = ? WHERE id = ?').run(Date.now(), newId);
      const result = { lastInsertRowid: newId };

      const sId = Number(result.lastInsertRowid);

      const obsIds = observations.map((o) => o.id);
      const ph = obsIds.map(() => '?').join(',');
      // Live guard (audit 2026-09-02 P0-3): the candidate SELECT is separated from this write
      // by a Sonnet round-trip, so a member may already be compressed into another summary or
      // tombstoned. Re-pointing it here would silently remove a row from that summary's child
      // set. Members that lost liveness stay where they are; the summary still lands.
      db.prepare(
        `UPDATE observations SET compressed_into = ? WHERE id IN (${ph}) AND ${liveObsFilterSql('')}`,
      ).run(sId, ...obsIds);

      return sId;
    })();

    debugLog(
      'DEBUG',
      'llm-optimize',
      `smart-compressed ${observations.length} observations into #${summaryId}`,
    );
    return { compressed: true, summaryId, count: observations.length };
  } catch (e) {
    debugCatch(e, 'smart-compress');
    return { compressed: false };
  } finally {
    releaseLLMSlot();
  }
}

export async function executeSmartCompress(db, maxClusters = 5, { project } = {}) {
  const candidates = findSmartCompressCandidates(db, 30, { project });
  if (candidates.length < 3) return { processed: 0, compressed: 0 };

  const clusters = clusterForCompression(candidates);
  if (clusters.length === 0) return { processed: 0, compressed: 0 };

  let compressed = 0;
  const toProcess = clusters.slice(0, maxClusters);
  for (const cluster of toProcess) {
    const result = await executeSmartCompressCluster(db, cluster.observations, cluster.project);
    if (result.compressed) compressed++;
  }

  return { processed: toProcess.length, compressed };
}

// ─── Pipeline Orchestrator ──────────────────────────────────────────────────

/**
 * @param {object} db better-sqlite3 database handle
 * @param {{ project?: string, detail?: boolean }} [opts]
 *   project: scope all candidate finders to a single project (opt-in; default scans all).
 *   detail: when true, also return `mergeClusters` / `reenrichSamples` / `compressSamples`
 *     arrays alongside the aggregate counts so callers (CLI --verbose, MCP detail mode)
 *     can render auditable previews without re-running the finders. The candidate-count
 *     arms still call the finders with high limits — detail mode does NOT widen scope,
 *     it surfaces the same rows the counts already crossed.
 */
export function optimizePreview(db, { project, detail = false } = {}) {
  const reenrichCandidates = findReenrichCandidates(db, 1000, { project });
  const reenrich = reenrichCandidates.length;
  // R-7: also report the widened-scope candidate count so users can see how many
  // bugfix/refactor/feature/decision observations are eligible for lesson backfill.
  const reenrichWide = findReenrichCandidates(db, 5000, { scope: 'wide', project }).length;
  // P1: alias-backfill eligibility — substantive rows missing search_aliases
  // (incl. lesson-bearing manual saves) that narrow+wide both skip.
  const reenrichAliases = findReenrichCandidates(db, 5000, { scope: 'aliases', project }).length;
  // D#135 P3: the scope-backfill backlog. Reported so the one-shot drain
  // (`optimize --run --task re-enrich --scope scopes --max N`) can be sized —
  // the daily pass alone would take months on a multi-thousand-row pool.
  // COUNT, not `findReenrichCandidates(5000).length`: this pool started at 2041
  // rows against the aliases pool's ~22, and the finder selects narrative +
  // lesson_learned per row, so counting by materialising was the one place this
  // round pulled megabytes to print an integer. (pre-tag review NOTE 11)
  const reenrichScopes = countReenrichCandidates(db, 'scopes', project);
  // D#6: the concepts-backfill backlog. Reported for the same reason as the three
  // above — a pool whose size is invisible cannot be sized for a one-shot drain
  // (`optimize --run --task re-enrich --scope concepts --max N`), and this pool is
  // the one that holds every save-enriched manual save.
  const reenrichConcepts = findReenrichCandidates(db, 5000, { scope: 'concepts', project }).length;

  const concepts = extractUniqueConcepts(db, 500, { project });
  const normalizeReady = shouldRunNormalize(project) && concepts.length >= 5;

  const mergeClusters = findMergeCandidates(db, 50, { project });
  const clusterMerge = mergeClusters.length;

  const compressCandidates = findSmartCompressCandidates(db, 30, { project });
  const compressClusters = clusterForCompression(compressCandidates);
  const smartCompress = compressClusters.length;

  const result = {
    reenrich,
    reenrichWide,
    reenrichAliases,
    reenrichScopes,
    reenrichConcepts,
    normalize: normalizeReady ? concepts.length : 0,
    normalizeGateOpen: shouldRunNormalize(project),
    clusterMerge,
    smartCompress,
    total: reenrich + (normalizeReady ? 1 : 0) + clusterMerge + smartCompress,
  };
  if (detail) {
    // Caps avoid dumping arbitrarily large arrays into CLI/MCP output — 20 picks
    // a sample size big enough to be auditable but small enough to fit a terminal
    // page. Callers that need more can drop --verbose and run the finders directly.
    result.mergeClusters = mergeClusters;
    result.reenrichSamples = reenrichCandidates.slice(0, 20);
    result.compressSamples = compressClusters.slice(0, 5);
  }
  return result;
}

/**
 * Run optimization tasks against the memory DB.
 *
 * @param {object} db better-sqlite3 handle
 * @param {object} [opts]
 * @param {string[]} [opts.tasks] Subset of tasks to run (default: all). When a single
 *   task is selected, it receives the FULL maxItems budget instead of the proportional
 *   slice from distributeBudget() — otherwise explicit `--max N --task re-enrich`
 *   would silently waste 60% of the requested budget.
 * @param {number} [opts.maxItems=15] Total item budget across all selected tasks.
 *   Exception: the 'scopes' side-pass the default re-enrich run performs (D#135 P3)
 *   is budgeted separately, up to the re-enrich slice again — see the rationale at
 *   the call site. Its calls are enum-classification only (maxTokens 60).
 * @param {boolean} [opts.force=false] Bypass time-based gates (e.g. normalize interval).
 * @param {'narrow'|'wide'|'aliases'|'concepts'} [opts.reenrichScope='narrow'] Scope for the re-enrich task.
 *   'wide' targets bugfix/refactor/feature/decision with narrative but no lesson (R-7).
 *   'aliases' (P1) backfills search_aliases on substantive alias-less rows regardless
 *   of lesson (lesson-bearing manual saves) — adds ONLY aliases, never rewrites content.
 * @param {string} [opts.project] Filter all tasks to a single project. Opt-in;
 *   absence preserves the prior all-projects default.
 */
export async function optimizeRun(
  db,
  { tasks, maxItems = 15, force = false, reenrichScope = 'narrow', project } = {},
) {
  const allTasks = ['re-enrich', 'normalize', 'cluster-merge', 'smart-compress'];
  const selectedTasks = tasks && tasks.length > 0 ? tasks : allTasks;
  // Single-task mode: give that task the full budget. Distribution only makes sense
  // when multiple tasks compete for the same pool.
  const budget =
    selectedTasks.length === 1
      ? { reenrich: maxItems, normalize: maxItems, clusterMerge: maxItems, smartCompress: maxItems }
      : distributeBudget(maxItems);
  const results = {};

  for (const task of selectedTasks) {
    try {
      switch (task) {
        case 're-enrich':
          if (reenrichScope === 'narrow' || reenrichScope === 'wide') {
            // P1-2 (v3.43) + audit 2026-07-17 P4: the maintenance pass covers BOTH the main
            // scope (narrow = fill lesson/concepts on fully-degraded rows; wide = lesson
            // backfill on substantive event-typed rows) AND aliases (backfill search_aliases
            // on lesson-bearing manual saves that narrow+wide both skip — mem_save writes no
            // aliases, so without this they stay paraphrase-unfindable). v3.43 hung the split
            // only on the DEFAULT 'narrow' branch, but the DAILY auto path (handleLLMOptimize
            // via auto-maintain) passes 'wide' explicitly — so aliases never had a cadence and
            // live coverage crawled at ~15%. The split is ADAPTIVE: aliases takes at most half
            // the budget and only what its candidate pool actually holds, so a zero-candidate
            // aliases pass costs nothing and the main scope keeps its full budget. Boundary:
            // at budget.reenrich === 1, `half` floors to 1 (the whole budget), so with ≥1
            // alias candidate the main scope gets 0 that cycle — pre-existing v3.43 semantics
            // (reachable only via manual `optimize --max ≤4`; the daily path runs reenrich=6),
            // and the starved scope self-corrects next cycle.
            // An explicit --scope aliases still runs exactly that one scope (below).
            //
            // D#135 P3 adds a THIRD claimant, 'scopes' (observations.scope backfill),
            // for the same cadence reason — but it is budgeted SEPARATELY, not carved
            // out of budget.reenrich like aliases. Two measured reasons:
            //   • Its candidate pool is a near-superset of the others' (any live
            //     substantive row with scope NULL: 2041 rows on 2026-08-19 vs 36 wide
            //     and 22 alias candidates), so an adaptive half-share would not be
            //     occasional — it would permanently halve the lesson-enrichment
            //     cadence that the main scope exists to provide.
            //   • It is a fundamentally cheaper call: one enum token (maxTokens 60)
            //     against a full re-enrich's 500, so charging it one full item slot
            //     mis-prices it by an order of magnitude.
            // Cap is budget.reenrich, so the daily pass adds at most that many cheap
            // classification calls and an empty pool still costs nothing.
            //
            // D#6 adds a FOURTH claimant, 'concepts', and it SHARES the aliases half
            // rather than taking one of its own. Sharing keeps the boundary this comment
            // already describes: the main scope still gets at least half the budget, so
            // adding a pool cannot starve the lesson enrichment that is the point of the
            // pass. Aliases is served FIRST out of that shared half, on a stated
            // ordering: an alias-less row is paraphrase-UNFINDABLE (a recall zero),
            // while a conceptless row is findable and merely ranks worse — measured at
            // +0.0846 R@10 on the benchmark fixture, which is real but is not a zero.
            // Both pools drain (each is idempotent via the column it fills), so the
            // ordering decides which drains first, not which gets served at all.
            const half = Math.max(1, Math.floor(budget.reenrich / 2));
            const aliasBudget = Math.min(
              half,
              findReenrichCandidates(db, half, { scope: 'aliases', project }).length,
            );
            const conceptsBudget = Math.min(
              half - aliasBudget,
              findReenrichCandidates(db, Math.max(0, half - aliasBudget), { scope: 'concepts', project })
                .length,
            );
            const scopesBudget = Math.min(
              budget.reenrich,
              findReenrichCandidates(db, budget.reenrich, { scope: 'scopes', project }).length,
            );
            const mainRes = await executeReenrich(db, budget.reenrich - aliasBudget - conceptsBudget, {
              scope: reenrichScope,
              project,
            });
            const aliasRes =
              aliasBudget > 0
                ? await executeReenrich(db, aliasBudget, { scope: 'aliases', project })
                : { processed: 0, skipped: 0 };
            const conceptsRes =
              conceptsBudget > 0
                ? await executeReenrich(db, conceptsBudget, { scope: 'concepts', project })
                : { processed: 0, skipped: 0 };
            const scopesRes =
              scopesBudget > 0
                ? await executeReenrich(db, scopesBudget, { scope: 'scopes', project })
                : { processed: 0, skipped: 0 };
            results.reenrich = {
              processed:
                (mainRes.processed || 0) +
                (aliasRes.processed || 0) +
                (conceptsRes.processed || 0) +
                (scopesRes.processed || 0),
              skipped:
                (mainRes.skipped || 0) +
                (aliasRes.skipped || 0) +
                (conceptsRes.skipped || 0) +
                (scopesRes.skipped || 0),
              byScope: {
                [reenrichScope]: mainRes,
                aliases: aliasRes,
                concepts: conceptsRes,
                scopes: scopesRes,
              },
            };
          } else {
            results.reenrich = await executeReenrich(db, budget.reenrich, { scope: reenrichScope, project });
          }
          break;
        case 'normalize':
          results.normalize = await executeNormalize(db, force, { project });
          break;
        case 'cluster-merge':
          results.clusterMerge = await executeClusterMerge(db, budget.clusterMerge, { project });
          break;
        case 'smart-compress':
          results.smartCompress = await executeSmartCompress(db, budget.smartCompress, { project });
          break;
      }
    } catch (e) {
      debugCatch(e, `optimize:${task}`);
      results[task] = { error: e.message };
    }
  }

  return results;
}

export async function handleLLMOptimize() {
  const { ensureDb } = await import('./schema.mjs');
  let db;
  try {
    db = ensureDb();
  } catch {
    return;
  }

  try {
    // v2.54.0: auto-maintain default scope is 'wide'. Narrow scope (the prior
    // default) only matches fully-degraded rows (no concepts AND no facts AND
    // no lesson AND no aliases) — production diagnostic 2026-04-30 found only
    // 56 obs ever optimized after months of daily auto-maintain runs. Wide
    // targets bugfix/refactor/feature/decision rows with substantive narrative
    // but missing lesson_learned, which is exactly the audit's 11.2% coverage
    // gap. CLI `mem optimize` keeps narrow as default for explicit invocations.
    const results = await optimizeRun(db, { reenrichScope: 'wide' });
    const parts = [];
    if (results.reenrich?.processed) parts.push(`re-enriched: ${results.reenrich.processed}`);
    if (results.normalize?.processed) parts.push(`normalized: ${results.normalize.processed}`);
    if (results.clusterMerge?.merged) parts.push(`merged: ${results.clusterMerge.merged}`);
    if (results.smartCompress?.compressed) parts.push(`compressed: ${results.smartCompress.compressed}`);
    if (parts.length > 0) debugLog('DEBUG', 'llm-optimize', parts.join(', '));
  } catch (e) {
    debugCatch(e, 'llm-optimize');
  } finally {
    db.close();
  }
}
