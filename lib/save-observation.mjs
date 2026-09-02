// Shared "save one observation" pipeline — used by both mem-cli.mjs::cmdSave
// (CLI `claude-mem-lite save`) and server.mjs::mem_save (MCP tool).
//
// Pre-extraction (v2.60.0) the same dedup → scrub → minhash → CJK-bigram →
// transactional INSERT block lived inline in both call sites (~110 lines × 2,
// flagged in the audit). They drifted: each carried its own `aligned with X`
// comments. This module is the single source of truth.
//
// Caller responsibilities (kept where input shape differs):
//   - validation (type whitelist, importance range, lesson length)
//   - argument parsing (CLI flags vs MCP Zod schema)
//   - result rendering (CLI stdout vs MCP content array)

import { jaccardSimilarity, scrubSecrets, computeMinHash, cjkBigrams, getCurrentBranch } from '../utils.mjs';
import { DEDUP_JACCARD_THRESHOLD } from './dedup-constants.mjs';
import { insertObservationRow, insertObservationFiles, insertObservationVector } from './observation-write.mjs';

const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const DEDUP_RECENT_LIMIT = 50;

/** Human-readable cause per `supersedeSkipped` reason (D#201). */
const SUPERSEDE_SKIP_CAUSE = {
  'malformed-id': 'not a positive integer id',
  'no-such-observation': 'no observation with that id',
  'other-project': 'belongs to a different project',
  'already-superseded': 'already superseded (no-op)',
  'duplicate-save': 'the save deduped, so nothing was superseded',
};

/**
 * Render the D#201 warning for requested-but-not-superseded ids. Lives here
 * rather than in either face so the CLI and the MCP tool cannot word it
 * differently or, more to the point, so one of them cannot quietly stop
 * rendering it.
 *
 * @param {Array<{id: any, reason: string}>} [skipped]
 * @returns {string|null} null when nothing was skipped
 */
export function formatSupersedeSkipped(skipped) {
  if (!Array.isArray(skipped) || skipped.length === 0) return null;
  const parts = skipped.map(({ id, reason }) =>
    `#${id} (${SUPERSEDE_SKIP_CAUSE[reason] || reason})`);
  return `⚠ --supersedes: ${parts.length} id(s) NOT superseded — ${parts.join(', ')}.`;
}

/**
 * Save a new observation if it isn't a near-duplicate of one saved within the
 * last 5 minutes (Jaccard similarity > 0.7 on title or content).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} params
 * @param {string} params.content                 Observation body. Required.
 * @param {string} [params.title]                 Defaults to content.slice(0, 100).
 * @param {string} [params.type='discovery']      Caller validates.
 * @param {number} [params.importance=2]          Caller validates 1..3.
 * @param {string} params.project                 Resolved project key.
 * @param {string[]} [params.files=[]]            File paths to attach (junction table).
 * @param {string|null} [params.lesson_learned]   Caller validates ≤500 chars.
 * @param {Date}   [params.now]                   Override for tests.
 * Both result shapes carry `supersededIds` (what was actually tombstoned) and
 * `supersedeSkipped` (requested but NOT tombstoned, each with a `reason`:
 * `malformed-id` | `no-such-observation` | `other-project` |
 * `already-superseded` | `duplicate-save`). Callers MUST surface a non-empty
 * `supersedeSkipped` — that is the whole point of D#201; dropping it puts the
 * silent failure back.
 *
 * @returns {{ kind: 'duplicate', existingId: number, project: string, type: string,
 *             supersededIds: number[], supersedeSkipped: Array<{id: any, reason: string}> }
 *          | { kind: 'saved', id: number, type: string, project: string, title: string,
 *              lessonCaptured: boolean, supersededIds: number[],
 *              supersedeSkipped: Array<{id: any, reason: string}> }}
 */
export function saveObservation(db, params) {
  const now = params.now instanceof Date ? params.now : new Date();
  const project = params.project;
  const type = params.type || 'discovery';
  const content = params.content;
  // Defensive single-source guard: never persist an empty/whitespace-only row.
  // CLI's `!text` check and MCP's `z.string().min(1)` both let whitespace-only
  // content through ("   " is length>=1 and truthy), creating junk observations
  // with blank title/text. Reject here so both call sites are covered at once.
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('mem_save: content is empty or whitespace-only');
  }
  const importance = params.importance ?? 2;
  const files = Array.isArray(params.files)
    ? params.files.filter((f) => typeof f === 'string' && f.length > 0)
    : [];
  const rawLesson = (typeof params.lesson_learned === 'string' && params.lesson_learned.length > 0)
    ? params.lesson_learned
    : null;

  // Scrub secrets BEFORE dedup so the comparison runs on the same form that
  // gets persisted (otherwise a token+placeholder pair could dedup-miss).
  const safeContent = scrubSecrets(content);
  // Derive the title from ALREADY-SCRUBBED content, then scrub again: slicing
  // raw content first could cut a secret value mid-token at the 100-char
  // boundary, leaving a head the value-length-gated scrub regex no longer
  // matches — so the title kept a partial secret while the narrative was clean.
  const rawTitle = params.title || safeContent.slice(0, 100);
  const safeTitle = scrubSecrets(rawTitle);
  const safeLesson = rawLesson ? scrubSecrets(rawLesson) : null;

  const sessionId = `manual-${project}`;

  // Ensure session exists (FK constraint). INSERT OR IGNORE makes this safe
  // under concurrent calls.
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

  // Dedup window: 5-min, top-50 most-recent in project.
  const dedupCutoff = now.getTime() - DEDUP_WINDOW_MS;
  const recent = db.prepare(`
    SELECT id, title, text FROM observations
    WHERE project = ? AND created_at_epoch > ?
    ORDER BY created_at_epoch DESC LIMIT ?
  `).all(project, dedupCutoff, DEDUP_RECENT_LIMIT);

  // Requested supersession targets, normalized. Declared BEFORE the dedup
  // short-circuit because that path reports on them too.
  // Self-reference is filtered inside the transaction, once the new id exists.
  //
  // D#201: the tokens that DON'T survive normalization are kept, not dropped.
  // A caller who names an id and gets no supersession has to be told which id
  // and why — the previous shape reported "requested 4, superseded 0" and
  // "requested nothing" identically, so a mistyped or wrong-table id read as a
  // clean success. `malformed-id` is the pre-query class; the DB-level classes
  // are decided inside the transaction.
  const rawSupersedes = Array.isArray(params.supersedes) ? params.supersedes : [];
  const requestedSupersedes = [...new Set(
    rawSupersedes.map(Number).filter((n) => Number.isInteger(n) && n > 0)
  )];
  const malformedSupersedes = rawSupersedes
    .filter((t) => { const n = Number(t); return !(Number.isInteger(n) && n > 0); })
    .map((t) => ({ id: t, reason: 'malformed-id' }));

  const dupMatch = recent.find((r) =>
    jaccardSimilarity(r.title, safeTitle) > DEDUP_JACCARD_THRESHOLD ||
    jaccardSimilarity(r.text || '', safeContent) > DEDUP_JACCARD_THRESHOLD
  );
  if (dupMatch) {
    // D#201: a dedup short-circuit swallows the requested supersession too — you
    // write a correction, it reads as a near-duplicate of something saved in the
    // last 5 minutes, and the rows you meant to retire stay live. Same sentence
    // as the ineligible-id case ("requested, did not happen, no trace"), so it
    // reports through the same channel rather than staying quiet.
    return {
      kind: 'duplicate', existingId: dupMatch.id, project, type,
      supersededIds: [],
      supersedeSkipped: [
        ...malformedSupersedes,
        ...requestedSupersedes.map((id) => ({ id, reason: 'duplicate-save' })),
      ],
    };
  }

  // FTS-indexed text field includes title + content + lesson + CJK bigrams,
  // so the +0.3 lesson_learned scoring multiplier actually gets to surface
  // lesson-bearing rows on FTS-matched queries.
  const minhashSig = computeMinHash(safeTitle + ' ' + safeContent);
  const indexText = [safeTitle, safeContent, safeLesson].filter(Boolean).join(' ');
  const bigramText = cjkBigrams(indexText);
  const textField = bigramText ? safeContent + ' ' + bigramText : safeContent;

  // Atomic: observation row + observation_files junction + observation_vectors
  // (TF-IDF) + supersession tombstones. Vector write is best-effort — vocab may be
  // uninitialized on a fresh DB; failure must not roll back the observation.
  const saveTx = db.transaction(() => {
    // Manual-save shape: narrative=content, concepts/facts/files_read empty, no
    // subtitle/search_aliases (defaults). Column list single-sourced in lib/observation-write.
    const savedId = insertObservationRow(db, {
      memory_session_id: sessionId, project, text: textField, type, title: safeTitle,
      narrative: safeContent, files_modified: JSON.stringify(files), importance,
      minhash_sig: minhashSig, lesson_learned: safeLesson, branch: getCurrentBranch(),
      created_at: now.toISOString(), created_at_epoch: now.getTime(),
    });

    insertObservationFiles(db, savedId, files);
    // Vector text mirrors the FTS-indexed content (title + content + lesson) so a
    // lesson-only term isn't invisible to the vector arm (finding #8). Reuses the
    // same indexText the FTS `text` field is built from.
    insertObservationVector(db, savedId, indexText);

    // P4 explicit supersession: tombstone + link prior observations this save
    // overturns. Only same-project, currently-live rows are eligible — never
    // tombstone another project's memory or re-stamp an already-superseded row —
    // and never supersede the row we just wrote. superseded_at drops the row out of
    // live search (all queries filter superseded_at IS NULL); superseded_by records
    // WHICH observation replaced it (the missing link in finding #4). The column
    // already exists (schema.mjs), so no migration is required.
    //
    // Runs INSIDE the transaction: committing the correcting row without its
    // tombstones leaves the contradiction supersession exists to retire — both the
    // new row and the ones it overturns stay live behind `superseded_at IS NULL`.
    // Write-the-correction and retire-its-predecessors is one unit or neither.
    const ids = requestedSupersedes.filter((n) => n !== savedId);
    let supersededIds = [];
    const skipped = [];
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      const eligible = db.prepare(
        `SELECT id FROM observations WHERE id IN (${ph}) AND project = ? AND superseded_at IS NULL`
      ).all(...ids, project).map((r) => r.id);
      if (eligible.length > 0) {
        const ph2 = eligible.map(() => '?').join(',');
        db.prepare(`UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id IN (${ph2})`)
          .run(now.getTime(), savedId, ...eligible);
        supersededIds = eligible;
      }
      // D#201: classify the difference instead of discarding it. One extra
      // SELECT, and only when something actually failed to land — the happy
      // path (every id eligible) skips it entirely.
      const landed = new Set(eligible);
      const missed = ids.filter((n) => !landed.has(n));
      if (missed.length > 0) {
        const ph3 = missed.map(() => '?').join(',');
        const rows = new Map(db.prepare(
          `SELECT id, project, superseded_at FROM observations WHERE id IN (${ph3})`
        ).all(...missed).map((r) => [r.id, r]));
        for (const n of missed) {
          const row = rows.get(n);
          // Order matters: a row can be BOTH foreign-project and already
          // superseded, and "it isn't yours" is the more actionable of the two.
          if (!row) skipped.push({ id: n, reason: 'no-such-observation' });
          else if (row.project !== project) skipped.push({ id: n, reason: 'other-project' });
          else skipped.push({ id: n, reason: 'already-superseded' });
        }
      }
    }

    return { savedId, supersededIds, skipped };
  });
  const { savedId, supersededIds, skipped } = saveTx();

  return {
    kind: 'saved',
    id: savedId,
    type,
    project,
    title: safeTitle,
    lessonCaptured: Boolean(safeLesson),
    supersededIds,
    // D#201: requested-but-not-superseded, with a reason each. Malformed tokens
    // are prepended because they were rejected before the query and so carry the
    // caller's ORIGINAL token (which may not even be a number) rather than an id.
    supersedeSkipped: [...malformedSupersedes, ...skipped],
  };
}
