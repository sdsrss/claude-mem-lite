// Save-time background enrichment — G1+G2 (roadmap 2026-07-18).
//
// The v3.49 save-nudge REMINDS the caller to write a lesson; nothing backfills
// when the nudge is ignored (14d live: 20.7% of bugfix/decision writes are
// lessonless, worsening), and manual saves NEVER carry search_aliases at
// creation — the paraphrase-recall gap stays open until the next daily
// llm-optimize pass ("saved yesterday, need it today" is the highest-value
// window). This module closes both at the source with ONE Haiku call: distill
// lesson_learned (obligated types only) + search_aliases (every manual save),
// executed by a detached worker so the save path itself stays zero-latency.
//
// D#135 P3: the same call also classifies `scope` (where the lesson APPLIES).
// v44 shipped the column plus the CLAUDE_MEM_SCOPE_FILTER read lever, but only
// hook-llm's episode summarizer ever wrote it — manual saves left it NULL, so on
// 2026-08-19 every bugfix/decision/discovery row was unclassified (0/41 of the
// 08-16..08-17 cohort) and the lever was inert on exactly the rows pre-tool
// recall injects. Riding this Haiku call costs no extra round trip.
//
// Contract (empty-overwrite is the historical audit main-class — R1/R4):
//   • FILL-ONLY-EMPTY: never replaces a caller-written lesson, aliases, or scope
//     filled by a concurrent optimize pass (re-checked inside a BEGIN IMMEDIATE txn).
//   • Touches ONLY lesson_learned / search_aliases / scope / text (alias append) —
//     title/narrative/type/importance/concepts/facts stay byte-identical.
//   • Never sets optimized_at: the daily wide re-enrich stays the safety net.
//   • Silent degradation: no Haiku, bad JSON, ineligible row → row unchanged.
//
// Kill switch: CLAUDE_MEM_SKIP_SAVE_ENRICH=1 (naming mirrors SKIP_COMPRESS /
// SKIP_OPTIMIZE). VITEST is gated out: e2e suites run hundreds of saves and a
// dev machine with a logged-in claude CLI would fire that many REAL LLM calls.

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scrubSecrets, cjkBigrams, truncate, debugCatch } from '../utils.mjs';
import { scrubRecord } from './scrub-record.mjs';
import { normalizeScope, SCOPE_PROMPT_LEGEND, upsertObservationVector } from './observation-write.mjs';

export const ENRICH_OBLIGATED_TYPES = new Set(['bugfix', 'decision']);

const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'hook.mjs');

/**
 * Trigger predicate for the save surfaces (CLI cmdSave / MCP mem_save).
 * Every genuinely-new manual save qualifies (aliases are always missing at
 * creation); env gates and dedup hits opt out.
 */
export function shouldQueueSaveEnrich(saveResult, env = process.env) {
  if (!saveResult || saveResult.kind !== 'saved') return false;
  if (env.CLAUDE_MEM_SKIP_SAVE_ENRICH === '1') return false;
  if (env.VITEST) return false;
  return true;
}

/**
 * Spawn the detached enrichment worker (`node hook.mjs enrich-save <id>`).
 * Fire-and-forget; never throws into the save path.
 */
export function queueSaveEnrich(id) {
  try {
    const child = spawn(process.execPath, [HOOK_PATH, 'enrich-save', String(id)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '1' },
    });
    child.on('error', (err) => { debugCatch(err, 'queueSaveEnrich'); });
    child.unref();
    return true;
  } catch (err) {
    debugCatch(err, 'queueSaveEnrich');
    return false;
  }
}

/**
 * Worker body: one Haiku call → fill-only-empty backfill.
 * @param {import('better-sqlite3').Database} db
 * @param {number} id observation id
 * @param {{callJson?: Function}} [opts] injectable LLM for tests
 * @returns {Promise<{enriched: boolean, reason?: string}>}
 */
export async function executeSaveEnrich(db, id, { callJson } = {}) {
  const row = db.prepare(`
    SELECT id, type, title, narrative, text, lesson_learned, search_aliases, scope,
           superseded_at, compressed_into
    FROM observations WHERE id = ?
  `).get(id);
  if (!row || row.superseded_at || row.compressed_into) {
    return { enriched: false, reason: 'ineligible' };
  }
  const wantLesson = ENRICH_OBLIGATED_TYPES.has(row.type)
    && !(row.lesson_learned && row.lesson_learned.trim());
  const wantAliases = !(row.search_aliases && row.search_aliases.trim());
  const wantScope = !row.scope;
  if (!wantLesson && !wantAliases && !wantScope) return { enriched: false, reason: 'complete' };

  const { callModelJSON, BG_LLM_TIMEOUT_MS } = await import('../haiku-client.mjs');
  const call = callJson || callModelJSON;
  const prompt = `A coding memory was just saved. Enrich its retrievability. Return ONLY valid JSON, no markdown fences.

Title: ${truncate(row.title || '(untitled)', 200)}
Context: ${truncate(row.narrative || row.text || '(none)', 500)}
Type: ${row.type || 'change'}

JSON: {"lesson_learned":"the transferable insight (root cause + fix, or constraint + tradeoff) in 1-2 sentences — or 'none' if routine","search_aliases":["alt phrasing","synonym","spelled-out jargon","CJK term if a key domain word has one"],"scope":"file|module|project|environment"}
search_aliases: 3-6 terms a user might search for the SAME memory that are NOT already in the title.
scope: ${SCOPE_PROMPT_LEGEND}`;

  let parsed = null;
  try {
    parsed = await call(prompt, 'haiku', { timeout: BG_LLM_TIMEOUT_MS, maxTokens: 400 });
  } catch (e) { debugCatch(e, 'save-enrich-llm'); }
  if (!parsed || typeof parsed !== 'object') return { enriched: false, reason: 'llm-null' };

  const lesson = wantLesson
    && typeof parsed.lesson_learned === 'string'
    && parsed.lesson_learned.trim().length > 0
    && parsed.lesson_learned.trim().toLowerCase() !== 'none'
    ? scrubSecrets(parsed.lesson_learned).slice(0, 500) : null;
  const aliasArr = wantAliases && Array.isArray(parsed.search_aliases)
    ? parsed.search_aliases.filter((a) => typeof a === 'string' && a.trim().length > 0).slice(0, 6)
    : [];
  // Whitelist-validated: Haiku output is untrusted, anything off-enum becomes null
  // (= "unclassified", which every scope-aware read path treats as do-not-filter).
  const scope = wantScope ? normalizeScope(parsed.scope) : null;
  if (!lesson && aliasArr.length === 0 && !scope) return { enriched: false, reason: 'nothing-usable' };

  // Fill-only-empty under BEGIN IMMEDIATE: a concurrent daily-optimize pass (or
  // a caller's mem_update) may have filled either field between spawn and now —
  // read-then-modify without the immediate lock is exactly sqlite gotcha #5.
  let enriched = false;
  const txn = db.transaction(() => {
    const fresh = db.prepare(`
      SELECT lesson_learned, search_aliases, scope, text, superseded_at, compressed_into
      FROM observations WHERE id = ?
    `).get(id);
    if (!fresh || fresh.superseded_at || fresh.compressed_into) return;
    const sets = [];
    const vals = [];
    if (lesson && !(fresh.lesson_learned && fresh.lesson_learned.trim())) {
      const safe = scrubRecord('observations', { lesson_learned: lesson });
      sets.push('lesson_learned = ?');
      vals.push(safe.lesson_learned);
    }
    if (aliasArr.length && !(fresh.search_aliases && fresh.search_aliases.trim())) {
      // APPEND aliases (+ CJK bigrams) to the existing FTS text — never rebuild
      // it (the alias-backfill branch invariant: rebuilding from concepts/facts
      // would drop the original narrative terms on manual saves).
      const searchAliases = aliasArr.join(' ');
      const appendedText = [fresh.text || '', searchAliases, cjkBigrams(searchAliases)]
        .filter(Boolean).join(' ');
      const safe = scrubRecord('observations', { search_aliases: searchAliases, text: appendedText });
      sets.push('search_aliases = ?', 'text = ?');
      vals.push(safe.search_aliases, safe.text);
    }
    // Enum value, not free text — no scrubRecord pass needed (and none possible:
    // a secret can't survive normalizeScope's four-value whitelist).
    if (scope && !fresh.scope) {
      sets.push('scope = ?');
      vals.push(scope);
    }
    if (sets.length === 0) return;
    db.prepare(`UPDATE observations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    enriched = true;
  });
  try {
    txn.immediate();
  } catch (e) {
    debugCatch(e, 'save-enrich-txn');
    return { enriched: false, reason: 'txn-failed' };
  }

  if (enriched) {
    // Refresh the TF-IDF vector so backfilled lesson/aliases reach the vector arm too.
    //
    // This used to `await import('../hook-optimize.mjs')` for its `rebuildVector` — the
    // ONLY lib -> hook-layer edge in the tree, and a lazy one specifically so the save
    // surfaces would not drag in a 1139-line optimize stack to write one row (audit
    // 2026-09-02 P1-4). The function's body now lives in lib/observation-write.mjs, so the
    // edge is gone and the import is static and cheap. `gate: false` matches what
    // rebuildVector did.
    try {
      const full = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
      if (full) upsertObservationVector(db, id, full, { gate: false, scope: 'save-enrich-vector' });
    } catch (e) { debugCatch(e, 'save-enrich-vector'); }
  }
  return { enriched };
}
