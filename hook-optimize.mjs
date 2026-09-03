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
  truncate, debugLog, debugCatch, COMPRESSED_AUTO,
  computeMinHash, estimateJaccardFromMinHash, jaccardSimilarity, clampImportance, cjkBigrams,
  notLowSignalTitleClause, scrubSecrets,
} from './utils.mjs';
import { callModelJSONAsync, BG_LLM_TIMEOUT_MS } from './haiku-client.mjs';
import { acquireLLMSlot, releaseLLMSlot } from './hook-semaphore.mjs';
import { scrubRecord } from './lib/scrub-record.mjs';
import { getVocabulary, computeVector, cosineSimilarity, vecTextForRow } from './tfidf.mjs';
import { MERGE_JACCARD_LOW, AUTO_MERGE_THRESHOLD } from './lib/dedup-constants.mjs';
import { DB_DIR } from './schema.mjs';
import { OBS_TYPE_SET } from './lib/obs-types.mjs';
import { normalizeScope, SCOPE_PROMPT_LEGEND } from './lib/observation-write.mjs';
import { liveObsFilterSql } from './lib/inject-search-core.mjs';

import { DAY_MS } from './lib/time-constants.mjs';
const RUNTIME_DIR = join(DB_DIR, 'runtime');

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

/**
 * Rebuild TF-IDF vector for an observation. Non-critical — swallows errors.
 * Exported for testing; also kept as the single source of vector-rebuild logic
 * for the optimize / re-enrich path to avoid drift with the hook-llm write path.
 */
export function rebuildVector(db, obsId, textPartsOrRow) {
  try {
    const vocab = getVocabulary(db);
    if (!vocab) return;
    // Accept a legacy [parts] array OR an observation row (preferred — single-source field set
    // incl. lesson_learned/search_aliases via vecTextForRow, so rebuilds match the save path).
    const text = Array.isArray(textPartsOrRow)
      ? textPartsOrRow.filter(Boolean).join(' ')
      : vecTextForRow(textPartsOrRow);
    const vec = computeVector(text, vocab);
    if (vec) {
      // Bug #1 fix: column is `created_at_epoch`, not `computed_at`. Every other
      // INSERT callsite (server.mjs, hook-llm.mjs, mem-cli.mjs) uses the correct
      // name; this was the only drift, silently caught by the catch below until
      // the R-7 experiment surfaced it.
      db.prepare(`
        INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch)
        VALUES (?, ?, ?, ?)
      `).run(obsId, Buffer.from(vec.buffer), vocab.version, Date.now());
    }
  } catch (e) { debugCatch(e, 'optimize-vector'); }
}

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
 * @param {{ scope?: 'narrow' | 'wide' | 'aliases' | 'scopes', project?: string }} [opts] Optional project filter (e.g. inferProject()-resolved name) narrows candidates to a single project — opt-in to preserve prior cross-project default.
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
        created_at_epoch DESC
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
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);
    return project ? stmt.all(project, limit) : stmt.all(limit);
  }
  if (scope === 'wide') {
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
        created_at_epoch DESC
      LIMIT ?
    `);
    return project ? stmt.all(project, limit) : stmt.all(limit);
  }
  const stmt = db.prepare(`
    SELECT id, title, narrative, type, subtitle, importance, project
    FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND (concepts IS NULL OR concepts = '')
      AND (facts IS NULL OR facts = '')
      AND lesson_learned IS NULL
      AND search_aliases IS NULL
      AND optimized_at IS NULL
      ${projectClause}
    ORDER BY created_at_epoch DESC
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

  let processed = 0, skipped = 0;
  const validTypes = OBS_TYPE_SET;

  for (const cand of candidates) {
    const gotSlot = await acquireLLMSlot();
    if (!gotSlot) { skipped++; continue; }

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
        const parsed = await callModelJSONAsync(scopePrompt, 'haiku', { timeout: BG_LLM_TIMEOUT_MS, maxTokens: 60 });
        const scopeValue = normalizeScope(parsed && parsed.scope);
        if (!scopeValue) { skipped++; continue; }
        // `AND scope IS NULL` is the fill-only-empty guard: a save-enrich worker or
        // an episode upgrade can land between candidate selection and this write,
        // and a classifier round-trip is long enough for that to be real.
        const res = db.prepare('UPDATE observations SET scope = ? WHERE id = ? AND scope IS NULL')
          .run(scopeValue, cand.id);
        if (res.changes === 0) { skipped++; continue; }
        // No rebuildVector: scope is a filter column, absent from the FTS text
        // field and from vecTextForRow — a rebuild here would be a no-op write.
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
        const parsed = await callModelJSONAsync(aliasPrompt, 'haiku', { timeout: BG_LLM_TIMEOUT_MS, maxTokens: 300 });
        const aliasArr = parsed && Array.isArray(parsed.search_aliases)
          ? parsed.search_aliases.filter((a) => typeof a === 'string' && a.trim().length > 0)
          : [];
        if (!aliasArr.length) { skipped++; continue; }
        const searchAliases = aliasArr.slice(0, 6).join(' ');
        const aliasBigrams = cjkBigrams(searchAliases);
        const appendedText = [cand.text || '', searchAliases, aliasBigrams].filter(Boolean).join(' ');
        const safe = scrubRecord('observations', { text: appendedText, search_aliases: searchAliases });
        // scope rides this call for free (D#135 P3). COALESCE, not a plain set:
        // an omitted or off-enum value normalizes to null and must not erase a
        // classification an earlier face already wrote.
        db.prepare(`UPDATE observations SET search_aliases = ?, text = ?, scope = COALESCE(?, scope) WHERE id = ?`)
          .run(safe.search_aliases, safe.text, normalizeScope(parsed.scope), cand.id);
        // Refresh the TF-IDF vector from the just-updated FTS text so the new
        // aliases reach the vector arm too — the narrow/wide branch rebuilds, this
        // one must as well. No-ops when the vector arm is off / vocab unbuilt.
        rebuildVector(db, cand.id, [safe.text]);
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

      const parsed = await callModelJSONAsync(prompt, 'haiku', { timeout: BG_LLM_TIMEOUT_MS, maxTokens: 500 });
      if (!parsed || !parsed.title) { skipped++; continue; }

      // Auto-hide on importance:0 targets fully-degraded NARROW rows (this branch predates
      // the wide-scope widening). A wide candidate has a substantive narrative (>100 chars)
      // and a real bugfix/feature/decision type by construction, and COMPRESSED_AUTO(-1) is
      // reachable by no auto-recovery pass — so one Haiku "importance 0" misjudgment would
      // hide a real observation until manual surgery. In wide scope, fall through and let
      // clampImportance floor it to 1 (kept visible, low-ranked) instead of hiding.
      if ((parsed.importance === 0 || parsed.importance === '0') && scope !== 'wide') {
        db.prepare(`UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}, optimized_at = ? WHERE id = ?`)
          .run(Date.now(), cand.id);
        processed++;
        continue;
      }

      // Enrichment ("add a lesson") must not reclassify a specific type down to the generic
      // 'change' (lower TYPE_QUALITY + faster decay); keep the stored type on that downgrade.
      let type = validTypes.has(parsed.type) ? parsed.type : (cand.type || 'change');
      if (type === 'change' && cand.type && cand.type !== 'change') type = cand.type;
      const concepts = Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 10) : [];
      const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 10) : [];
      // Preserve-on-empty: wide-scope candidates can already carry concepts/facts/aliases
      // (findReenrichCandidates requires only lesson_learned empty), so a partial re-enrich
      // that returns a lesson but omits/empties these must NOT wipe them — the same UPDATE
      // sets optimized_at, locking the row out of any future re-enrich (:88), so the loss is
      // permanent. Keep the candidate's existing value when the LLM returned nothing. (Narrow
      // candidates are all-null on these by their WHERE, so cand.* is falsy → no-op there.)
      const conceptsText = concepts.length ? concepts.join(' ') : (cand.concepts || '');
      const factsText = facts.length ? facts.join(' ') : (cand.facts || '');
      // Scrub BEFORE truncate so a secret straddling the cut can't leave a sub-6-char
      // head that scrubSecrets's value-length floor no longer matches (the scrubRecord
      // below would then miss it too). Mirrors the hook-llm save-path fix.
      const lessonLearned = typeof parsed.lesson_learned === 'string'
        && parsed.lesson_learned.toLowerCase() !== 'none'
        && parsed.lesson_learned.trim().length > 0
        ? scrubSecrets(parsed.lesson_learned).slice(0, 500) : null;
      const searchAliases = Array.isArray(parsed.search_aliases) && parsed.search_aliases.length
        ? parsed.search_aliases.slice(0, 6).join(' ') : (cand.search_aliases || null);
      const title = truncate(scrubSecrets(parsed.title || ''), 120);
      const narrative = truncate(scrubSecrets(parsed.narrative || cand.narrative || ''), 500);
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
        title, narrative,
        concepts: conceptsText,
        facts: factsText,
        text: textField,
        lesson_learned: lessonLearned,
        search_aliases: searchAliases,
      });
      db.prepare(`
        UPDATE observations SET type=?, title=?, narrative=?, concepts=?, facts=?,
          text=?, importance=?, lesson_learned=?, search_aliases=?, minhash_sig=?, optimized_at=?,
          scope=COALESCE(?, scope)
        WHERE id = ?
      `).run(type, safe.title, safe.narrative, safe.concepts, safe.facts, safe.text,
        importance, safe.lesson_learned, safe.search_aliases, minhashSig, Date.now(),
        // COALESCE (mirrors the hook-llm upgrade path): a re-enrich that omits
        // scope, or emits an off-enum value, must never blank an existing label —
        // and THIS update stamps optimized_at, so the loss would be permanent.
        normalizeScope(parsed.scope), cand.id);

      rebuildVector(db, cand.id, { title, narrative, concepts: conceptsText, lesson_learned: safe.lesson_learned, search_aliases: safe.search_aliases });

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

export function extractUniqueConcepts(db, limit = 500, { project } = {}) {
  const projectClause = project ? 'AND project = ?' : '';
  const stmt = db.prepare(`
    SELECT concepts FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND concepts IS NOT NULL AND concepts != ''
      ${projectClause}
    ORDER BY created_at_epoch DESC
    LIMIT 2000
  `);
  const rows = project ? stmt.all(project) : stmt.all();

  const conceptSet = new Set();
  for (const row of rows) {
    for (const c of row.concepts.split(/\s+/)) {
      const trimmed = c.trim();
      if (trimmed.length >= 2) conceptSet.add(trimmed);
    }
  }
  return [...conceptSet].slice(0, limit);
}

export async function identifySynonymGroups(concepts) {
  const gotSlot = await acquireLLMSlot();
  if (!gotSlot) return [];

  try {
    const prompt = `Analyze these concept terms from a code memory database and identify synonym groups (terms that refer to the same concept). Include cross-language synonyms (English/Chinese). Return ONLY valid JSON.

Concepts: ${concepts.join(', ')}

JSON: {"groups":[{"canonical":"preferred term","aliases":["synonym1","synonym2"]}, ...]}

Rules:
- Only include groups where you are confident the terms are true synonyms
- canonical should be the most specific/technical term
- Include CJK ↔ English equivalents if present
- Skip terms that have no synonyms in the list`;

    const parsed = await callModelJSONAsync(prompt, 'sonnet', { timeout: BG_LLM_TIMEOUT_MS, maxTokens: 1000 });
    if (!parsed?.groups || !Array.isArray(parsed.groups)) return [];
    return parsed.groups.filter(g => g.canonical && Array.isArray(g.aliases) && g.aliases.length > 0);
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
  const rows = db.prepare(`
    SELECT id, title, narrative, concepts, search_aliases, lesson_learned FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND concepts IS NOT NULL AND concepts != ''
      AND (? IS NULL OR project = ?)
  `).all(project, project);

  let updated = 0;
  const updateStmt = db.prepare(`
    UPDATE observations SET concepts = ?, search_aliases = ?, optimized_at = ? WHERE id = ?
  `);

  for (const row of rows) {
    const terms = row.concepts.split(/\s+/);
    let changed = false;
    const newTerms = terms.map(t => {
      const canonical = aliasMap.get(t.toLowerCase());
      if (canonical && canonical !== t) { changed = true; return canonical; }
      return t;
    });

    if (changed) {
      const uniqueConcepts = [...new Set(newTerms)].join(' ');
      const existingAliases = row.search_aliases || '';
      const originalTerms = terms.filter(t => aliasMap.has(t.toLowerCase()) && aliasMap.get(t.toLowerCase()) !== t);
      const newAliases = [existingAliases, ...originalTerms].filter(Boolean).join(' ');
      // Defense-in-depth scrub. Canonical concept names come from LLM output
      // (identifySynonymGroups via Sonnet); existing values are already
      // scrubbed but free LLM tokens can re-introduce secret-shaped strings.
      const safe = scrubRecord('observations', {
        concepts: uniqueConcepts,
        search_aliases: newAliases,
      });
      updateStmt.run(safe.concepts, safe.search_aliases, Date.now(), row.id);
      // V-F3: normalize mutated concepts + search_aliases (both vector fields) — rebuild the
      // vector so it reflects the canonicalized terms (no-op when the vector arm is disabled).
      rebuildVector(db, row.id, { title: row.title, narrative: row.narrative, concepts: safe.concepts, search_aliases: safe.search_aliases, lesson_learned: row.lesson_learned });
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
  if (!project) { try { writeFileSync(NORMALIZE_GATE_FILE, JSON.stringify({ epoch: Date.now() })); } catch { /* best-effort */ } }

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
    SELECT id, title, narrative, project, type, access_count, importance, created_at_epoch, minhash_sig, lesson_learned, concepts, facts
    FROM observations
    WHERE ${liveObsFilterSql('')}
      AND optimized_at IS NULL
      AND title IS NOT NULL AND title != ''
      AND created_at_epoch > ?
      ${projectClause}
    ORDER BY created_at_epoch DESC
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
    const obsDescriptions = cluster.map((o, i) =>
      `${i + 1}. [${o.type || 'change'}] "${truncate(o.title, 200)}" — ${truncate(o.narrative || '(no narrative)', 500)}`
    ).join('\n');

    const prompt = `These observations from a code memory database may be about the same topic. Should they be merged into a single observation?

Observations:
${obsDescriptions}

Return ONLY valid JSON:
- If they should NOT be merged: {"should_merge":false}
- If they SHOULD be merged: {"should_merge":true,"merged_title":"≤120 char comprehensive title","merged_narrative":"comprehensive ≤800 char summary preserving all key details","merged_concepts":["kw1","kw2"],"merged_facts":["specific fact 1"],"merged_lesson":"synthesized non-obvious lesson or null","importance":2}`;

    const parsed = await callModelJSONAsync(prompt, 'sonnet', { timeout: BG_LLM_TIMEOUT_MS, maxTokens: 1000 });
    if (!parsed || !parsed.should_merge) return { merged: false };

    // Keeper = highest importance, then highest access_count. Previously access_count
    // alone, so a critical (importance=3) but never-accessed observation lost the keeper
    // role to a trivial (importance=1) accessed one and was compressed away.
    const keeper = cluster.reduce((best, o) => {
      const oi = o.importance || 1, bi = best.importance || 1;
      if (oi !== bi) return oi > bi ? o : best;
      return (o.access_count || 0) > (best.access_count || 0) ? o : best;
    }, cluster[0]);
    const others = cluster.filter(o => o.id !== keeper.id);
    // Floor the merged importance at the cluster max — merging must never silently
    // downgrade the ranking of the most-important member (the LLM default is 2). The keeper
    // is selected by importance-first, so keeper.importance IS the cluster max by construction.
    const maxClusterImportance = keeper.importance || 1;

    const concepts = Array.isArray(parsed.merged_concepts) ? parsed.merged_concepts.slice(0, 10) : [];
    const facts = Array.isArray(parsed.merged_facts) ? parsed.merged_facts.slice(0, 10) : [];
    // Preserve-on-empty (mirror the merged_lesson guard below + the re-enrich path): the merge
    // overwrites the keeper in place, so a partial LLM response that omits these must fall back to
    // the keeper's own values, not blank its live concepts/facts (findMergeCandidates now selects them).
    const conceptsText = concepts.length ? concepts.join(' ') : (keeper.concepts || '');
    const factsText = facts.length ? facts.join(' ') : (keeper.facts || '');
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
    let lessonLearned = typeof parsed.merged_lesson === 'string'
      && parsed.merged_lesson.trim().length > 0
      ? scrubSecrets(parsed.merged_lesson).slice(0, 500) : null;
    if (!lessonLearned) {
      const memberLessons = [...new Set(cluster
        .map(o => (o.lesson_learned || '').trim())
        .filter(l => l && l.toLowerCase() !== 'none'))];
      if (memberLessons.length) lessonLearned = scrubSecrets(memberLessons.join(' — ')).slice(0, 500);
    }

    const bigramText = cjkBigrams((title || '') + ' ' + (narrative || ''));
    const textField = [conceptsText, factsText, bigramText].filter(Boolean).join(' ');
    const minhashSig = computeMinHash((title || '') + ' ' + (narrative || ''));
    const importance = Math.max(clampImportance(parsed.importance || 2), maxClusterImportance);

    // Scrub LLM-output cluster-merge text fields at the UPDATE boundary.
    // importance is numeric; minhash_sig is hash bytes.
    const safe = scrubRecord('observations', {
      title, narrative,
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
      const keeperLive = db.prepare(
        `SELECT 1 FROM observations WHERE id = ? AND ${liveObsFilterSql('')}`
      ).get(keeper.id);
      if (!keeperLive) return false;

      // Snapshot the keeper's pre-merge row BEFORE overwriting it, so its original
      // full text survives as a recoverable compressed_into child (mirroring
      // compressGroup / recoverChildrenOf). The keeper is the cluster's most-
      // important member; an in-place overwrite by the LLM's ≤800-char summary
      // would otherwise destroy its original text irreversibly (HIGH-3 data loss).
      // Column list is derived from the live schema (minus id/compressed_into) so
      // it stays correct as migrations add columns; names are internal identifiers.
      const snapCols = db.prepare(`PRAGMA table_info(observations)`).all()
        .map(c => c.name).filter(c => c !== 'id' && c !== 'compressed_into');
      const snapColList = snapCols.join(', ');
      db.prepare(
        `INSERT INTO observations (${snapColList}, compressed_into)
         SELECT ${snapColList}, ? FROM observations WHERE id = ?`
      ).run(keeper.id, keeper.id);

      db.prepare(`
        UPDATE observations SET title=?, narrative=?, concepts=?, facts=?, text=?,
          importance=?, lesson_learned=?, minhash_sig=?, optimized_at=?
        WHERE id = ?
      `).run(safe.title, safe.narrative, safe.concepts, safe.facts, safe.text,
        importance, safe.lesson_learned, minhashSig, Date.now(), keeper.id);

      const otherIds = others.map(o => o.id);
      const ph = otherIds.map(() => '?').join(',');
      // Live guard on the members too: one already compressed into ANOTHER summary S during
      // the LLM window would be re-pointed here, silently dropping a row out of S's child set.
      db.prepare(`UPDATE observations SET compressed_into = ? WHERE id IN (${ph}) AND ${liveObsFilterSql('')}`)
        .run(keeper.id, ...otherIds);
      return true;
    })();
    if (!mergeApplied) {
      debugLog('DEBUG', 'llm-optimize', `cluster-merge aborted: keeper #${keeper.id} no longer live`);
      return { merged: false };
    }

    rebuildVector(db, keeper.id, { title, narrative, concepts: conceptsText, lesson_learned: lessonLearned, search_aliases: keeper.search_aliases });

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
const COMPRESS_COSINE_THRESHOLD = 0.3;

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

export function clusterForCompression(candidates, db) {
  if (candidates.length < 3) return [];

  const byProject = new Map();
  for (const c of candidates) {
    if (!byProject.has(c.project)) byProject.set(c.project, []);
    byProject.get(c.project).push(c);
  }

  const clusters = [];

  for (const [project, obs] of byProject) {
    if (obs.length < 3) continue;

    let vocab;
    try { vocab = getVocabulary(db); } catch {}

    if (vocab) {
      const vectors = obs.map(o => {
        const text = [o.title || '', o.narrative || ''].join(' ');
        return computeVector(text, vocab);
      });

      const used = new Set();
      for (let i = 0; i < obs.length; i++) {
        if (used.has(i) || !vectors[i]) continue;
        const cluster = [{ obs: obs[i], idx: i }];
        used.add(i);

        for (let j = i + 1; j < obs.length; j++) {
          if (used.has(j) || !vectors[j]) continue;
          const sim = cosineSimilarity(vectors[i], vectors[j]);
          if (sim >= COMPRESS_COSINE_THRESHOLD) {
            cluster.push({ obs: obs[j], idx: j });
            used.add(j);
          }
        }

        if (cluster.length >= 3) {
          const sorted = cluster.map(c => c.obs).sort((a, b) => a.created_at_epoch - b.created_at_epoch);
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
      }
    } else {
      // Fallback: group by time window only
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
  }

  return clusters;
}

export async function executeSmartCompressCluster(db, observations, project) {
  if (observations.length < 3) return { compressed: false };

  const gotSlot = await acquireLLMSlot();
  if (!gotSlot) return { compressed: false };

  try {
    const obsDescriptions = observations.map((o, i) =>
      `${i + 1}. [${o.type || 'change'}] "${truncate(o.title || '(untitled)', 200)}" — ${truncate(o.narrative || '(no narrative)', 500)}${o.lesson_learned ? ` | Lesson: ${truncate(o.lesson_learned, 200)}` : ''}`
    ).join('\n');

    const prompt = `Summarize these related code memory observations into ONE comprehensive summary. Preserve all important decisions, lessons, and specific facts. Return ONLY valid JSON.

Observations:
${obsDescriptions}

JSON: {"title":"descriptive summary ≤120 chars","narrative":"comprehensive summary ≤800 chars preserving key decisions and lessons","concepts":["kw1","kw2"],"facts":["all specific facts preserved"],"lesson_learned":"most important synthesized lesson or 'none'","search_aliases":["alt search 1","alt search 2"]}`;

    const parsed = await callModelJSONAsync(prompt, 'sonnet', { timeout: BG_LLM_TIMEOUT_MS, maxTokens: 1000 });
    if (!parsed || !parsed.title) return { compressed: false };

    // Scrub BEFORE truncate (see re-enrich note): boundary cut on scrubbed text.
    const title = truncate(scrubSecrets(parsed.title || ''), 120);
    const narrative = truncate(scrubSecrets(parsed.narrative || ''), 800);
    const concepts = Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 10) : [];
    const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 10) : [];
    const conceptsText = concepts.join(' ');
    const factsText = facts.join(' ');
    const lessonLearned = typeof parsed.lesson_learned === 'string'
      && parsed.lesson_learned.toLowerCase() !== 'none'
      && parsed.lesson_learned.trim().length > 0
      ? scrubSecrets(parsed.lesson_learned).slice(0, 500) : null;
    const searchAliases = Array.isArray(parsed.search_aliases)
      ? parsed.search_aliases.slice(0, 6).join(' ') : null;

    const bigramText = cjkBigrams((title || '') + ' ' + (narrative || ''));
    const textField = [conceptsText, factsText, searchAliases || '', bigramText].filter(Boolean).join(' ');

    const epochs = observations.map(o => o.created_at_epoch).sort((a, b) => a - b);
    const medianEpoch = epochs[Math.floor(epochs.length / 2)];

    const summaryId = db.transaction(() => {
      const sessionId = `compress-${project}`;
      const now = new Date();
      db.prepare(`INSERT OR IGNORE INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?,?,?,?,?,'active')`
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
      const result = db.prepare(`INSERT INTO observations
        (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
         files_read, files_modified, importance, lesson_learned, search_aliases, optimized_at,
         created_at, created_at_epoch)
        VALUES (?,?,?,?,?,'',?,?,?,'[]','[]',2,?,?,?,?,?)`
      ).run(sessionId, project, safe.text, 'discovery', safe.title, safe.narrative,
        safe.concepts, safe.facts, safe.lesson_learned, safe.search_aliases, Date.now(),
        new Date(medianEpoch).toISOString(), medianEpoch);

      const sId = Number(result.lastInsertRowid);

      const obsIds = observations.map(o => o.id);
      const ph = obsIds.map(() => '?').join(',');
      // Live guard (audit 2026-09-02 P0-3): the candidate SELECT is separated from this write
      // by a Sonnet round-trip, so a member may already be compressed into another summary or
      // tombstoned. Re-pointing it here would silently remove a row from that summary's child
      // set. Members that lost liveness stay where they are; the summary still lands.
      db.prepare(`UPDATE observations SET compressed_into = ? WHERE id IN (${ph}) AND ${liveObsFilterSql('')}`)
        .run(sId, ...obsIds);

      return sId;
    })();

    rebuildVector(db, summaryId, { title, narrative, concepts: conceptsText });

    debugLog('DEBUG', 'llm-optimize', `smart-compressed ${observations.length} observations into #${summaryId}`);
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

  const clusters = clusterForCompression(candidates, db);
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

  const concepts = extractUniqueConcepts(db, 500, { project });
  const normalizeReady = shouldRunNormalize(project) && concepts.length >= 5;

  const mergeClusters = findMergeCandidates(db, 50, { project });
  const clusterMerge = mergeClusters.length;

  const compressCandidates = findSmartCompressCandidates(db, 30, { project });
  const compressClusters = clusterForCompression(compressCandidates, db);
  const smartCompress = compressClusters.length;

  const result = {
    reenrich,
    reenrichWide,
    reenrichAliases,
    reenrichScopes,
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
 * @param {'narrow'|'wide'|'aliases'} [opts.reenrichScope='narrow'] Scope for the re-enrich task.
 *   'wide' targets bugfix/refactor/feature/decision with narrative but no lesson (R-7).
 *   'aliases' (P1) backfills search_aliases on substantive alias-less rows regardless
 *   of lesson (lesson-bearing manual saves) — adds ONLY aliases, never rewrites content.
 * @param {string} [opts.project] Filter all tasks to a single project. Opt-in;
 *   absence preserves the prior all-projects default.
 */
export async function optimizeRun(db, { tasks, maxItems = 15, force = false, reenrichScope = 'narrow', project } = {}) {
  const allTasks = ['re-enrich', 'normalize', 'cluster-merge', 'smart-compress'];
  const selectedTasks = tasks && tasks.length > 0 ? tasks : allTasks;
  // Single-task mode: give that task the full budget. Distribution only makes sense
  // when multiple tasks compete for the same pool.
  const budget = selectedTasks.length === 1
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
            const half = Math.max(1, Math.floor(budget.reenrich / 2));
            const aliasBudget = Math.min(half, findReenrichCandidates(db, half, { scope: 'aliases', project }).length);
            const scopesBudget = Math.min(
              budget.reenrich,
              findReenrichCandidates(db, budget.reenrich, { scope: 'scopes', project }).length,
            );
            const mainRes = await executeReenrich(db, budget.reenrich - aliasBudget, { scope: reenrichScope, project });
            const aliasRes = aliasBudget > 0
              ? await executeReenrich(db, aliasBudget, { scope: 'aliases', project })
              : { processed: 0, skipped: 0 };
            const scopesRes = scopesBudget > 0
              ? await executeReenrich(db, scopesBudget, { scope: 'scopes', project })
              : { processed: 0, skipped: 0 };
            results.reenrich = {
              processed: (mainRes.processed || 0) + (aliasRes.processed || 0) + (scopesRes.processed || 0),
              skipped: (mainRes.skipped || 0) + (aliasRes.skipped || 0) + (scopesRes.skipped || 0),
              byScope: { [reenrichScope]: mainRes, aliases: aliasRes, scopes: scopesRes },
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
