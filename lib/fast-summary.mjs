// The non-LLM session summary — one shape, three callers.
//
// Audit 2026-08-22 P2-9. hook.mjs carried three hand-copied versions of "read this
// session's first prompt and its last few observation titles, scrub them, insert a
// session_summaries row": the Stop-time fast path, the SessionStart previous-session
// path, and the SessionStart /exit-restart fallback. They had already drifted — the
// 13-column INSERT was retyped each time, and the truncation limits split 600/600/400
// against 300/200. Copy-and-miss on exactly this kind of triplicate is what broke
// v3.35.2, and the comment in one of these blocks announcing "parity with the other"
// is the tell that parity was being maintained by hand.
//
// ONE ROW PER SESSION. Stop fires once per assistant TURN (the session file survives it
// since R10-P1-1), so every writer here runs many times against a session that already has
// a row. Each one lands on the session's newest row (`newestSummaryId`) and INSERTs only when
// there is none: Stop (`writeStopSummary`), SessionStart's /clear-or-/compact path
// (`writeClearSummary`) and hook-llm.mjs's model upgrade (`mergeModelSummary`). The
// /exit-restart fallback in hook.mjs inserts only for a session with no row at all.
// Inserting instead left one live session with 37 rows in 65 minutes, which is 9 and 10 of
// the top ten session search hits for its own vocabulary.
//
// Which writer wins a field depends on where that field came from, recorded per field at
// the head of `notes` (parseSummaryNotes): the assistant's own report beats the model's
// summary, which beats the last observation titles.
//
// The model's write lives here too (`mergeModelSummary`): its precedence against the other
// two writers is the point of this module, and keeping the three in one place is what lets
// them agree on it.
import { scrubRecord } from './scrub-record.mjs';
import { truncate } from '../format-utils.mjs';

/** Column list + placeholder row, written once. */
const INSERT_SQL = `
  INSERT INTO session_summaries
  (memory_session_id, project, request, investigated, learned, completed, next_steps,
   remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
  VALUES (?, ?, ?, '', '', ?, '', ?, '[]', '[]', ?, ?, ?)
`;

/**
 * Per-caller truncation limits. These are NOT unified on purpose: the Stop path stores
 * roughly twice what the two SessionStart paths do, and every one of these strings is
 * re-injected into a later session's context. Collapsing them to one number changes how
 * much text the product injects, which is a measurable behaviour change and not
 * something a refactor gets to decide. Passed explicitly so the difference is visible
 * at the call site instead of living in three retyped `truncate(...)` arguments.
 */
export const FAST_SUMMARY_LIMITS = {
  stop: { request: 200, completed: 600, remaining: 600, notes: 400 },
  sessionStart: { request: 200, completed: 300, remaining: 200, notes: 400 },
  exitRestart: { request: 200, completed: 300, remaining: 200, notes: 400 },
};

/**
 * The two reads every fast summary is built from: the session's opening prompt, and the
 * titles of its most recent observations.
 *
 * The observation filter is `compressed_into` ONLY, deliberately — it is NOT a half-written
 * `liveObsFilterSql` waiting to be completed. `completed` is the session's own history, and a
 * lesson a later save overturned still happened; dropping it here would misreport the session
 * that did the work. This is the same ruling audit 2026-08-14 F4 made for the sibling field
 * `session_handoffs.completed`, where the scope guard lives in
 * `tests/audit-silent-20260814.test.mjs`. Audit R8 §11.3 proposed adding `superseded_at IS
 * NULL` to both; both were rejected on this reasoning. The filter that DOES belong on a
 * superseded row is the one guarding standing policy re-presented to a later session
 * (`key_decisions`), not history.
 *
 * @returns {{request: string, completed: string}} raw (unscrubbed, untruncated) values
 */
export function readFastSummarySource(db, sessionId) {
  const firstPrompt = db
    .prepare(
      `
    SELECT prompt_text FROM user_prompts
    WHERE content_session_id = ?
    ORDER BY prompt_number ASC LIMIT 1
  `,
    )
    .get(sessionId);
  const recentObs = db
    .prepare(
      `
    SELECT title FROM observations
    WHERE memory_session_id = ? AND COALESCE(compressed_into, 0) = 0
    ORDER BY created_at_epoch DESC, id DESC LIMIT 5
  `,
    )
    .all(sessionId);
  return {
    request: firstPrompt?.prompt_text || '',
    completed: recentObs
      .map((o) => o.title)
      .filter(Boolean)
      .join('; '),
  };
}

/**
 * Scrub, truncate, insert. Raw values go into scrubRecord and truncation happens after,
 * at the bind site — a secret straddling the truncation boundary would otherwise fall
 * below scrubSecrets' length floors and survive into the row (privacy review, v3.x).
 * That ordering is the reason this function exists in one copy.
 *
 * @param {{request?: string, completed?: string, remaining?: string, notes?: string}} values raw
 * @param {{request: number, completed: number, remaining: number, notes: number}} limits
 */
export function insertFastSummary(db, { sessionId, project, values, limits, now }) {
  const safe = scrubRecord('session_summaries', {
    request: values.request || '',
    completed: values.completed || '',
    remaining_items: values.remaining || '',
    notes: values.notes || 'fast',
  });
  db.prepare(INSERT_SQL).run(
    sessionId,
    project,
    truncate(safe.request, limits.request),
    truncate(safe.completed, limits.completed),
    truncate(safe.remaining_items, limits.remaining),
    truncate(safe.notes, limits.notes),
    now.toISOString(),
    now.getTime(),
  );
}

/**
 * Where a row's Done and Not done came from, stored as the head of `notes`:
 *
 *   `done<report|model|titles> left<report|other>[ <Failed / Uncertain lines>]`
 *
 *  - done: `report` = the assistant's own Done; `model` = the LLM summary; `titles` = the last
 *    observation titles, a fallback.
 *  - left: `report` = the assistant's own Not done, where '' means "nothing left"; `other` =
 *    the model's inference or the handoff's unfinished list, which only fill a gap.
 *
 * Precedence per field: report > model > titles / other. It is recorded per FIELD because one
 * report can carry a Not done and no Done, or only Failed lines; a single per-row tag read
 * those as a full report and froze stale titles as its Done (v6.13.5 delta review P2-1,
 * P2-2). Rows written before this carry older values: `fast` and bare Failed / Uncertain
 * text read as done = titles, left = other (so fresh titles or a report replace them — a
 * pre-upgrade report Done among them can be replaced once); `llm`, '' and NULL read as done
 * = model, left = other; any EMPTY Done takes the titles whatever its tag. `get` prints
 * `notes` as stored; FTS indexes it at weight 1, and each tag is a single token nobody types.
 * A space separates the head from the lines because `truncate` folds newlines into spaces.
 */
export function parseSummaryNotes(notes) {
  const text = typeof notes === 'string' ? notes : '';
  const m = /^done(report|model|titles) left(report|other)(?: ([\s\S]*))?$/.exec(text);
  if (m) return { done: m[1], left: m[2], lines: m[3] || '' };
  if (text === '' || text === 'llm') return { done: 'model', left: 'other', lines: '' };
  if (text === 'fast') return { done: 'titles', left: 'other', lines: '' };
  return { done: 'titles', left: 'other', lines: text };
}

/** Inverse of parseSummaryNotes. `lines` must already be scrubbed. */
export function formatSummaryNotes({ done, left, lines }, max) {
  const head = `done${done} left${left}`;
  if (!lines) return head;
  return truncate(`${head} ${lines}`, max ?? Number.MAX_SAFE_INTEGER);
}

/**
 * The session's summary row every later write lands on: its newest, by the same order Last
 * Session reads (`created_at_epoch DESC, id DESC`). Rows older than it exist only from before
 * one-row-per-session, or from two writers racing an empty session.
 *
 * @returns {number|null}
 */
export function newestSummaryId(db, sessionId) {
  const row = db
    .prepare(
      `
    SELECT id FROM session_summaries
    WHERE memory_session_id = ?
    ORDER BY created_at_epoch DESC, id DESC
    LIMIT 1
  `,
    )
    .get(sessionId);
  return row ? row.id : null;
}

const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : null);

/** Scrub one raw value, then truncate it: the order insertFastSummary documents. */
function clean(field, value, max) {
  return truncate(scrubRecord('session_summaries', { [field]: value || '' })[field], max);
}

/**
 * Stop's write, on every turn. `report` is this turn's tail extract ({done, notDone, lines}
 * — lines are its Failed / Uncertain lines, raw); `source` is readFastSummarySource's output.
 * The session's first write INSERTs; every later one updates that row:
 *  - a Done in the report replaces `completed` (done = report); without one, a `titles` row
 *    takes the current titles;
 *  - any Done or Not done makes `remaining_items` this report's Not done, '' included
 *    (left = report) — a Done with no Not done says nothing is left;
 *  - Failed / Uncertain lines replace the previous report's whenever the tail carries a
 *    report or such lines.
 * The timestamp is the first write's. Read and write share one IMMEDIATE transaction, so a
 * model upgrade committing in between cannot be overwritten with a stale read.
 */
export function writeStopSummary(db, { sessionId, project, report, source, now, limits }) {
  const done = clean('completed', report.done, limits.completed);
  const notDone = clean('remaining_items', report.notDone, limits.remaining);
  const lines = scrubRecord('session_summaries', { notes: report.lines || '' }).notes;
  const titles = clean('completed', source.completed, limits.completed);
  const hasReport = Boolean(done || notDone);
  db.transaction(() => {
    const id = newestSummaryId(db, sessionId);
    if (id === null) {
      const completed = done || titles;
      if (!(source.request || completed || notDone)) return;
      db.prepare(INSERT_SQL).run(
        sessionId,
        project,
        clean('request', source.request, limits.request),
        completed,
        notDone,
        formatSummaryNotes(
          { done: done ? 'report' : 'titles', left: hasReport ? 'report' : 'other', lines },
          limits.notes,
        ),
        now.toISOString(),
        now.getTime(),
      );
      return;
    }
    const row = db
      .prepare('SELECT completed, remaining_items, notes FROM session_summaries WHERE id = ?')
      .get(id);
    const prov = parseSummaryNotes(row.notes);
    let completed = row.completed;
    let remaining = row.remaining_items;
    if (done) {
      completed = done;
      prov.done = 'report';
    } else if (titles && (prov.done === 'titles' || !nonEmpty(row.completed))) {
      // A titles Done follows the current titles, and an EMPTY Done takes them whatever its
      // tag: a model-created row without a Done, or a legacy '' / NULL notes row (third
      // review P3-1), must not block the fallback.
      completed = titles;
      prov.done = 'titles';
    }
    if (hasReport) {
      remaining = notDone;
      prov.left = 'report';
    }
    if (hasReport || lines) prov.lines = lines;
    db.prepare('UPDATE session_summaries SET completed = ?, remaining_items = ?, notes = ? WHERE id = ?').run(
      completed,
      remaining,
      formatSummaryNotes(prov, limits.notes),
      id,
    );
  }).immediate();
}

/**
 * SessionStart's previous-session write (/clear or /compact). It has the opening prompt, the
 * last observation titles and the handoff's unfinished list:
 *  - no row yet: INSERT (done = titles, left = other);
 *  - `request` fills a gap only;
 *  - `completed`: a `titles` row takes the fresh titles, any other fills a gap only;
 *  - `remaining_items`: a `report` Not done is left alone ('' = nothing left); otherwise it
 *    fills a gap only.
 * The row moves to `now`: this runs when the previous session ended, which is what its own
 * INSERT used to record, and Last Session orders by it.
 */
export function writeClearSummary(db, { sessionId, project, values, limits, now }) {
  const request = clean('request', values.request, limits.request);
  const titles = clean('completed', values.completed, limits.completed);
  const unfinished = clean('remaining_items', values.remaining, limits.remaining);
  db.transaction(() => {
    const id = newestSummaryId(db, sessionId);
    if (id === null) {
      db.prepare(INSERT_SQL).run(
        sessionId,
        project,
        request,
        titles,
        unfinished,
        formatSummaryNotes({ done: 'titles', left: 'other', lines: '' }),
        now.toISOString(),
        now.getTime(),
      );
      return;
    }
    const row = db
      .prepare('SELECT request, completed, remaining_items, notes FROM session_summaries WHERE id = ?')
      .get(id);
    const prov = parseSummaryNotes(row.notes);
    const completed =
      prov.done === 'titles' && titles ? titles : (nonEmpty(row.completed) ?? (titles || row.completed));
    const remaining =
      prov.left === 'report'
        ? row.remaining_items
        : (nonEmpty(row.remaining_items) ?? (unfinished || row.remaining_items));
    db.prepare(
      `UPDATE session_summaries SET request = ?, completed = ?, remaining_items = ?, created_at = ?, created_at_epoch = ?
       WHERE id = ?`,
    ).run(
      nonEmpty(row.request) ?? (request || row.request),
      completed,
      remaining,
      now.toISOString(),
      now.getTime(),
      id,
    );
  }).immediate();
}

/**
 * Whether a Stop later than the one at `spawnEpoch` has been recorded for the session
 * (sdk_sessions.completed_at_epoch holds the LATEST Stop). Stop spawns one model worker per
 * turn and two of them can finish out of order; the later Stop's worker reads a superset of
 * this one's input and owns the row, so this one's reply must not land after it (P3-6). A
 * missing or non-numeric epoch is never superseded.
 */
export function summarySuperseded(db, sessionId, spawnEpoch) {
  if (!Number.isFinite(spawnEpoch) || spawnEpoch <= 0) return false;
  const latest = db
    .prepare('SELECT completed_at_epoch AS e FROM sdk_sessions WHERE content_session_id = ?')
    .get(sessionId)?.e;
  return Number.isFinite(latest) && latest > spawnEpoch;
}

const MODEL_TEXT_FIELDS = ['request', 'investigated', 'learned', 'next_steps'];
const MODEL_JSON_FIELDS = ['lessons', 'key_decisions'];
const SUMMARY_COLUMNS = [...MODEL_TEXT_FIELDS, 'completed', 'remaining_items', ...MODEL_JSON_FIELDS];

/**
 * The LLM worker's write. `fields` are the model's values, already scrubbed (lessons /
 * key_decisions as a JSON string or null). Lands on the session's newest row; a field the
 * model left empty falls back to the row's own value, then to the session's older rows newest
 * first (legacy duplicates, races), so a degraded reply erases nothing. Per field:
 *  - `completed`: a `report` Done is kept; otherwise the model's replaces it (done = model);
 *  - `remaining_items`: a `report` Not done is kept, '' included; otherwise the model's
 *    replaces it;
 *  - everything else: the model's replaces it.
 * The row's timestamp is NOT moved (D#79): this worker can finish after the NEXT session has
 * written its first row. A session with no row is inserted at its own last prompt, not at the
 * worker's finish, for the same reason.
 *
 * `spawnEpoch` is the epoch of the Stop that spawned this worker; when a later Stop has been
 * recorded, nothing is written and false is returned (see summarySuperseded). Omitted — the
 * /clear spawn, a worker spawned by an older version — it always writes.
 */
export function mergeModelSummary(db, { sessionId, project, fields, now, spawnEpoch }) {
  return db
    .transaction(() => {
      if (summarySuperseded(db, sessionId, spawnEpoch)) return false;
      const id = newestSummaryId(db, sessionId);
      if (id === null) {
        const last = db
          .prepare('SELECT MAX(created_at_epoch) AS e FROM user_prompts WHERE content_session_id = ?')
          .get(sessionId)?.e;
        const stamp = Number.isFinite(last) && last > 0 && last <= now.getTime() ? new Date(last) : now;
        db.prepare(
          `INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps,
           remaining_items, files_read, files_edited, notes, lessons, key_decisions, created_at, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?)`,
        ).run(
          sessionId,
          project,
          fields.request || '',
          fields.investigated || '',
          fields.learned || '',
          fields.completed || '',
          fields.next_steps || '',
          fields.remaining_items || '',
          formatSummaryNotes({
            done: nonEmpty(fields.completed) ? 'model' : 'titles',
            left: 'other',
            lines: '',
          }),
          fields.lessons ?? null,
          fields.key_decisions ?? null,
          stamp.toISOString(),
          stamp.getTime(),
        );
        return true;
      }
      const rows = db
        .prepare(
          `SELECT id, notes, ${SUMMARY_COLUMNS.join(', ')} FROM session_summaries
         WHERE memory_session_id = ? ORDER BY created_at_epoch DESC, id DESC`,
        )
        .all(sessionId);
      const own = rows.find((r) => r.id === id);
      const siblings = rows.filter((r) => r.id !== id);
      const floor = (col) =>
        nonEmpty(own[col]) ?? siblings.map((r) => nonEmpty(r[col])).find(Boolean) ?? own[col];
      const prov = parseSummaryNotes(own.notes);
      const next = {};
      for (const col of [...MODEL_TEXT_FIELDS, ...MODEL_JSON_FIELDS])
        next[col] = nonEmpty(fields[col]) ?? floor(col);
      if (prov.done !== 'report' && nonEmpty(fields.completed)) {
        next.completed = fields.completed;
        prov.done = 'model';
      } else {
        next.completed = floor('completed');
      }
      next.remaining_items =
        prov.left === 'report'
          ? own.remaining_items
          : (nonEmpty(fields.remaining_items) ?? floor('remaining_items'));
      db.prepare(
        `UPDATE session_summaries SET ${SUMMARY_COLUMNS.map((c) => `${c} = ?`).join(', ')}, notes = ? WHERE id = ?`,
      ).run(
        ...SUMMARY_COLUMNS.map((c) => next[c]),
        formatSummaryNotes(prov, FAST_SUMMARY_LIMITS.stop.notes),
        id,
      );
      return true;
    })
    .immediate();
}
