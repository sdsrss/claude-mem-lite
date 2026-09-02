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
  'no-such-event': 'no event with that id',
  'other-project': 'belongs to a different project',
  'already-superseded': 'already superseded (no-op)',
  'duplicate-save': 'the save deduped, so nothing was superseded',
};

/**
 * Split `--supersedes` tokens into the two tables they can name (D#205).
 *
 * `E#<n>` addresses the `events` table, matching the prefix those rows are
 * RENDERED with in the injected lessons block since D#202 — so a reader who sees
 * `E#10524` can retire it by typing back exactly what they read. A bare number
 * stays an observation id: observations are the incumbent namespace, and the same
 * asymmetry is already how `lib/injected-ids.mjs` writes the shared marker file.
 *
 * Anything else is malformed and is REPORTED rather than dropped — D#201's whole
 * point, and the reason this returns the caller's original token for those.
 *
 * @param {Array<any>} raw
 * @returns {{obs: number[], events: number[], malformed: Array<{id: any, reason: string}>}}
 */
export function splitSupersedeTokens(raw) {
  const obs = new Set();
  const events = new Set();
  const malformed = [];
  for (const t of Array.isArray(raw) ? raw : []) {
    const s = typeof t === 'string' ? t.trim() : t;
    const m = typeof s === 'string' ? /^[Ee]#?(\d+)$/.exec(s) : null;
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0) { events.add(n); continue; }
      // `kind` survives even on the malformed branch, so `E#0` reports as `E#0` and not
      // `#E#0` — the formatter prefixes by kind, and a doubled prefix on the one line
      // whose job is to echo what the caller typed reads as a second defect.
      malformed.push({ id: t, reason: 'malformed-id', kind: 'event' });
      continue;
    }
    const n = Number(s);
    if (Number.isInteger(n) && n > 0) obs.add(n);
    else malformed.push({ id: t, reason: 'malformed-id', kind: 'obs' });
  }
  return { obs: [...obs], events: [...events], malformed };
}

/**
 * Render the D#201 warning for requested-but-not-superseded ids. Lives here
 * rather than in either face so the CLI and the MCP tool cannot word it
 * differently or, more to the point, so one of them cannot quietly stop
 * rendering it.
 *
 * D#205: an entry carrying `kind: 'event'` is rendered `E#<id>`, the same prefix the
 * lessons block shows it under, so the id echoed back is the id the caller typed. The
 * prefix is added HERE rather than baked into `id` because callers compare `id` against
 * real row ids; a pre-prefixed string would silently break that.
 *
 * @param {Array<{id: any, reason: string, kind?: 'obs'|'event'}>} [skipped]
 * @returns {string|null} null when nothing was skipped
 */
/**
 * Render the ` Superseded: …` note for a successful save (D#205).
 *
 * Lives here for the same reason `formatSupersedeSkipped` does: the CLI and the MCP tool
 * each hand-built this string, and when events became supersedable one of the two would
 * have kept printing observations only. This round fixed three separate instances of
 * "the copy I fixed was not the only copy"; a shared renderer is the form that stops the
 * fourth. `tests/save-observation-supersedes.test.mjs` sweeps both faces for the call.
 *
 * Events render with the `E#` prefix and are listed AFTER observations rather than merged,
 * because the two tables share an id space and a flat list of bare `#N` would not say
 * which row was retired.
 *
 * @param {{supersededIds?: number[], supersededEventIds?: number[]}} [result]
 * @returns {string} '' when nothing was superseded (safe to concatenate)
 */
export function formatSupersededNote(result) {
  const obs = result?.supersededIds ?? [];
  const events = result?.supersededEventIds ?? [];
  if (obs.length === 0 && events.length === 0) return '';
  const parts = [...obs.map((i) => `#${i}`), ...events.map((i) => `E#${i}`)];
  return ` Superseded: ${parts.join(', ')}.`;
}

export function formatSupersedeSkipped(skipped) {
  if (!Array.isArray(skipped) || skipped.length === 0) return null;
  const parts = skipped.map(({ id, reason, kind }) => {
    // Only a resolved NUMERIC id gets a prefix. A malformed entry carries the caller's
    // ORIGINAL token, which may already contain its own `#` or `E#` — prefixing that
    // produced `#E#0` (and, after a first attempt at fixing it, `E#E#0`). Echoing an
    // unparseable token exactly as typed is also the more useful thing to print.
    const label = typeof id === 'number' ? `${kind === 'event' ? 'E#' : '#'}${id}` : String(id);
    return `${label} (${SUPERSEDE_SKIP_CAUSE[reason] || reason})`;
  });
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
 * Both result shapes carry `supersededIds` (observations actually tombstoned) and
 * `supersedeSkipped` (requested but NOT tombstoned, each with a `reason`:
 * `malformed-id` | `no-such-observation` | `no-such-event` | `other-project` |
 * `already-superseded` | `duplicate-save`, plus `kind: 'obs'|'event'`). Callers MUST
 * surface a non-empty `supersedeSkipped` — that is the whole point of D#201; dropping it
 * puts the silent failure back.
 *
 * The `saved` shape also carries `supersededEventIds` (D#205), kept separate rather than
 * merged: `events` and `observations` share an id space, so one flat list of bare `#N`
 * could not say which table a retired row came from. Use `formatSupersededNote` to render
 * both rather than reassembling the string per face.
 *
 * @returns {{ kind: 'duplicate', existingId: number, project: string, type: string,
 *             supersededIds: number[],
 *             supersedeSkipped: Array<{id: any, reason: string, kind?: string}> }
 *          | { kind: 'saved', id: number, type: string, project: string, title: string,
 *              lessonCaptured: boolean, supersededIds: number[], supersededEventIds: number[],
 *              supersedeSkipped: Array<{id: any, reason: string, kind?: string}> }}
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
  //
  // D#205: `E#<n>` addresses the events table. Until this release `--supersedes` could
  // only retire an observation, so a conclusion carried by an EVENT row had no retirement
  // path at all and kept injecting from two faces after later measurement overturned it
  // (the founding case: event #10524's "2.1-3.8x per call", retracted in prose while the
  // row stayed live). D#201 made that failure loud; this makes it fixable.
  const rawSupersedes = Array.isArray(params.supersedes) ? params.supersedes : [];
  const { obs: requestedSupersedes, events: requestedSupersedeEvents, malformed: malformedSupersedes } =
    splitSupersedeTokens(rawSupersedes);

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
        ...requestedSupersedes.map((id) => ({ id, reason: 'duplicate-save', kind: 'obs' })),
        ...requestedSupersedeEvents.map((id) => ({ id, reason: 'duplicate-save', kind: 'event' })),
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
          if (!row) skipped.push({ id: n, reason: 'no-such-observation', kind: 'obs' });
          else if (row.project !== project) skipped.push({ id: n, reason: 'other-project', kind: 'obs' });
          else skipped.push({ id: n, reason: 'already-superseded', kind: 'obs' });
        }
      }
    }

    // D#205, the events half. Same three DB-level classes, same one-extra-SELECT-only-on-
    // failure shape, and inside the SAME transaction as the observation write for the same
    // reason: a correction that lands while the row it overturns stays live is the state
    // supersession exists to prevent.
    //
    // `superseded_at_epoch` now carries TWO meanings on this table, and nothing
    // distinguishes them: `lib/activity.mjs promoteInsightEvents` already stamps it to mark
    // an event PROMOTED into an observation (its idempotency gate selects on
    // `superseded_at_epoch IS NULL`), and this writes it to mean RETIRED BY A CORRECTION.
    // Both consequences are benign today — a retired event correctly stops being a
    // promotion candidate, and a promoted one correctly reports `already-superseded` as a
    // no-op — but the skip reason reads slightly wrong for a promoted row, and any future
    // code wanting to tell the two apart will need a second column. Flagged by the v3.89.0
    // pre-tag review; not split here because inventing a column to record a distinction
    // nothing currently reads is the kind of speculative schema change this repo avoids.
    //
    // `superseded_by_id` is deliberately left NULL. That column is
    // `INTEGER REFERENCES events(id)`, so it cannot hold the id of the OBSERVATION doing
    // the retiring — writing `savedId` there would point at whatever event happens to
    // share the number, which is exactly the cross-table id collision D#202 just closed
    // (25.7% of injectable events share an id with a live observation). A missing link is
    // recoverable; a wrong one is not.
    let supersededEventIds = [];
    if (requestedSupersedeEvents.length > 0) {
      const ph = requestedSupersedeEvents.map(() => '?').join(',');
      const eligible = db.prepare(
        `SELECT id FROM events WHERE id IN (${ph}) AND project = ? AND superseded_at_epoch IS NULL`
      ).all(...requestedSupersedeEvents, project).map((r) => r.id);
      if (eligible.length > 0) {
        const ph2 = eligible.map(() => '?').join(',');
        db.prepare(`UPDATE events SET superseded_at_epoch = ? WHERE id IN (${ph2})`)
          .run(now.getTime(), ...eligible);
        supersededEventIds = eligible;
      }
      const landed = new Set(eligible);
      const missed = requestedSupersedeEvents.filter((n) => !landed.has(n));
      if (missed.length > 0) {
        const ph3 = missed.map(() => '?').join(',');
        const rows = new Map(db.prepare(
          `SELECT id, project, superseded_at_epoch FROM events WHERE id IN (${ph3})`
        ).all(...missed).map((r) => [r.id, r]));
        for (const n of missed) {
          const row = rows.get(n);
          if (!row) skipped.push({ id: n, reason: 'no-such-event', kind: 'event' });
          else if (row.project !== project) skipped.push({ id: n, reason: 'other-project', kind: 'event' });
          else skipped.push({ id: n, reason: 'already-superseded', kind: 'event' });
        }
      }
    }

    return { savedId, supersededIds, supersededEventIds, skipped };
  });
  const { savedId, supersededIds, supersededEventIds, skipped } = saveTx();

  return {
    kind: 'saved',
    id: savedId,
    type,
    project,
    title: safeTitle,
    lessonCaptured: Boolean(safeLesson),
    supersededIds,
    // D#205: kept in its OWN array rather than merged into supersededIds. The two are
    // different tables that share an id space, so a merged list would be ambiguous at
    // exactly the point a reader needs to know which row was retired.
    supersededEventIds,
    // D#201: requested-but-not-superseded, with a reason each. Malformed tokens
    // are prepended because they were rejected before the query and so carry the
    // caller's ORIGINAL token (which may not even be a number) rather than an id.
    supersedeSkipped: [...malformedSupersedes, ...skipped],
  };
}
