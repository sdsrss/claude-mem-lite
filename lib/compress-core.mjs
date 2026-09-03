// Shared "compress old low-value observations into weekly summaries" core.
//
// Single source of truth for cmdCompress (CLI), mem_compress (MCP), and
// handleAutoCompress (hook). Pre-extraction the candidate query, the
// project+ISO-week grouping, and the per-group summary INSERT + mark-compressed
// were copy-pasted across all three and kept in sync by hand-written "parity"
// comments — which is exactly how the TF-IDF-vector write drifted out of the
// compression path (audit ARCH-1). Call sites keep what legitimately differs:
// argument parsing, preview rendering, candidate-window params, and transaction
// granularity (CLI/MCP wrap all groups in one transaction; the hook transacts
// each group). They no longer re-implement the mutation.
//
// The summary INSERT also writes its TF-IDF observation_vectors row in the same
// (caller-owned) transaction — fixed once here rather than in all three call
// sites. Without it, FTS-miss queries that fall back to vector recall (CJK /
// concept / paraphrase) could never reach compressed summaries; the LLM
// smart-compress path already wrote vectors, so the deterministic path was the
// sole gap (audit P6).

import { isoWeekKey, COMPRESSED_AUTO, debugCatch } from '../utils.mjs';
import { getVocabulary, computeVector } from '../tfidf.mjs';
import { scrubRecord } from './scrub-record.mjs';

/**
 * Low-value compression candidates: importance<=1, never accessed, older than
 * `cutoff`, not already compressed. `includeAutoMarked` also folds in rows the
 * hook lightweight-marked as COMPRESSED_AUTO (the hook re-summarizes those).
 * `<= 1` (was `= 1`): citation-decay floors importance at 0 and the LLM low-signal
 * filter saves at imp=0; those rows are strictly lower value than imp=1 and must be
 * GC-eligible too, or they accumulate forever (parity with hook.mjs auto-compress).
 */
export function selectCompressionCandidates(db, { cutoff, project = null, includeAutoMarked = false }) {
  const compressedFilter = includeAutoMarked
    ? `AND (compressed_into IS NULL OR compressed_into = ${COMPRESSED_AUTO})`
    : 'AND compressed_into IS NULL';
  const projectFilter = project ? 'AND project = ?' : '';
  const params = project ? [cutoff, project] : [cutoff];
  return db.prepare(`
    SELECT id, project, type, title, created_at, created_at_epoch
    FROM observations
    WHERE COALESCE(importance, 1) <= 1
      AND COALESCE(access_count, 0) = 0
      -- v3.23: exclude rows carrying a real lesson — folding them into a title-only
      -- weekly summary discards the lesson (the distilled value of a lessons store).
      -- Mirrors the hook auto-compress lesson guard so neither path buries a lesson.
      AND (lesson_learned IS NULL OR lesson_learned = '' OR lesson_learned = 'none')
      -- Tombstones stay out (audit 2026-09-02 P0-3). A superseded row keeps
      -- compressed_into NULL, so compressedFilter alone admitted retracted content into a
      -- weekly summary — and the summary is a LIVE importance-2 row, so the retraction is
      -- undone by the compression. Spelled out rather than reusing liveObsFilterSql because
      -- the compressed_into half is deliberately looser here (includeAutoMarked folds in
      -- COMPRESSED_AUTO rows for re-summarization).
      AND superseded_at IS NULL
      AND created_at_epoch < ?
      ${compressedFilter}
      ${projectFilter}
    ORDER BY project, created_at_epoch
  `).all(...params);
}

/**
 * Group candidates by `project::isoWeek` and keep only groups worth compressing
 * (≥ 3 observations). Returns [[key, obs[]], …] — callers split the key on '::'
 * for the project.
 */
export function groupByProjectWeek(candidates) {
  const groups = new Map();
  for (const c of candidates) {
    const key = `${c.project}::${isoWeekKey(c.created_at_epoch)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups.entries()].filter(([, obs]) => obs.length >= 3);
}

/**
 * Compress one group: create a weekly-summary observation (importance 2, dominant
 * type, median timestamp so it sits correctly in recency/timeline), then mark all
 * sources as compressed into it. Statement-only — the CALLER owns the transaction
 * boundary (all-groups-in-one for CLI/MCP, per-group for the hook).
 *
 * @returns {{ summaryId: number, compressed: number }}
 */
export function compressGroup(db, proj, obs) {
  const types = {};
  for (const o of obs) types[o.type] = (types[o.type] || 0) + 1;
  const dominantType = Object.entries(types).sort((a, b) => b[1] - a[1])[0][0];
  const title = `Weekly summary: ${obs.length} ${dominantType} observations`;
  const narrative = obs.map((o) => `- ${o.title || '(untitled)'}`).join('\n');
  const sessionId = `compress-${proj}`;

  const sortedEpochs = obs.map((o) => o.created_at_epoch).sort((a, b) => a - b);
  const medianEpoch = sortedEpochs[Math.floor(sortedEpochs.length / 2)];
  const medianDate = new Date(medianEpoch);

  const now = new Date();
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(sessionId, sessionId, proj, now.toISOString(), now.getTime());

  // Defense-in-depth: source rows were scrubbed at ingest, but the new narrative
  // is constructed here and re-persisted.
  const safe = scrubRecord('observations', { text: narrative, title, narrative });
  const summaryResult = db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, '', ?, '', '', '[]', '[]', 2, ?, ?)
  `).run(sessionId, proj, safe.text, dominantType, safe.title, safe.narrative, medianDate.toISOString(), medianEpoch);
  const summaryId = Number(summaryResult.lastInsertRowid);

  // TF-IDF vector for the summary so it is reachable by vector recall (parity
  // with save-observation.mjs and the LLM smart-compress path). Best-effort:
  // vocab may be uninitialized on a fresh DB — a failure here must not abort the
  // compression the caller is transacting.
  try {
    const vocab = getVocabulary(db);
    if (vocab) {
      const vec = computeVector(`${safe.title} ${safe.narrative}`, vocab);
      if (vec) {
        db.prepare(
          'INSERT OR REPLACE INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)'
        ).run(summaryId, Buffer.from(vec.buffer), vocab.version, medianEpoch);
      }
    }
  } catch (e) { debugCatch(e, 'compress-vector'); }

  const obsIds = obs.map((o) => o.id);
  const obsPh = obsIds.map(() => '?').join(',');
  // Re-assert the candidate predicate at write time (audit 2026-09-02 P0-3): the hook path
  // transacts per group, so a row can be superseded or absorbed by another summary between
  // selection and here, and re-pointing it would drop it out of that summary's child set.
  // Deliberately NOT liveObsFilterSql: COMPRESSED_AUTO rows are legitimate inputs
  // (includeAutoMarked), so only the superseded half plus "no positive keeper yet" applies.
  const compressed = db.prepare(`
    UPDATE observations SET compressed_into = ?
    WHERE id IN (${obsPh})
      AND superseded_at IS NULL
      AND (compressed_into IS NULL OR compressed_into = ${COMPRESSED_AUTO})
  `).run(summaryId, ...obsIds).changes;

  // `changes`, not obs.length: with the guard above those differ exactly when a row lost
  // eligibility between selection and write, and reporting the intended count would make
  // the guard invisible in every caller's totals.
  return { summaryId, compressed };
}
