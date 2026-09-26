// Audit 2026-08-22 P2-9: the non-LLM session summary existed as three hand-copied
// blocks in hook.mjs (Stop fast path, SessionStart previous-session, SessionStart
// /exit-restart). The 13-column INSERT was retyped each time and the truncation limits
// had already split 600/600/400 against 300/200.
//
// These cases hold the two things a reader of the old code could not check at a glance:
// what the row actually contains, and that scrub happens BEFORE truncation.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import {
  readFastSummarySource,
  insertFastSummary,
  newestSummaryId,
  fillFastSummaryGaps,
  refreshStructuredSummary,
  refreshObservationTitles,
  REPORT_NOTES,
  FAST_SUMMARY_LIMITS,
} from '../lib/fast-summary.mjs';
import { insertSession } from './test-helpers.mjs';

let db;
const NOW = new Date('2026-08-22T04:00:00.000Z');

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  // session_summaries.memory_session_id is an FK onto sdk_sessions: seed the parent or
  // every insert here fails on the constraint rather than on its subject.
  for (const id of ['s1', 's2', 's3', 's4']) insertSession(db, { id, project: 'p' });
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* closed */
  }
});

function seedPrompt(sessionId, n, text) {
  db.prepare(
    `INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
              VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, n, text, NOW.toISOString(), NOW.getTime() + n);
}
function seedObs(sessionId, title, epoch, compressedInto = null, supersededAt = null) {
  db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch, compressed_into, superseded_at)
              VALUES (?, 'p', 'discovery', ?, ?, ?, ?, ?)`,
  ).run(sessionId, title, NOW.toISOString(), epoch, compressedInto, supersededAt);
}

describe('readFastSummarySource', () => {
  it('takes the OPENING prompt, by prompt_number and not by insertion order', () => {
    seedPrompt('s1', 3, 'third thing');
    seedPrompt('s1', 1, 'the original request');
    seedPrompt('s1', 2, 'second thing');
    expect(readFastSummarySource(db, 's1').request).toBe('the original request');
  });

  it('takes the five most recent observation titles, newest first, semicolon-joined', () => {
    for (let i = 1; i <= 7; i++) seedObs('s1', `title-${i}`, NOW.getTime() + i);
    expect(readFastSummarySource(db, 's1').completed).toBe('title-7; title-6; title-5; title-4; title-3');
  });

  it('skips rows already folded into a compressed parent', () => {
    seedObs('s1', 'live-one', NOW.getTime() + 2);
    seedObs('s1', 'folded-away', NOW.getTime() + 3, 99);
    expect(readFastSummarySource(db, 's1').completed).toBe('live-one');
  });

  // Scope guard, the mirror of the compressed case above. Audit R8 §11.3 read this query's
  // `compressed_into`-only filter as a half-written liveObsFilterSql and proposed adding
  // `superseded_at IS NULL`. That is wrong here for the reason audit 2026-08-14 F4 already
  // wrote down for the sibling field `session_handoffs.completed`: `completed` is the
  // session's own history, and a lesson a later save overturned still happened. F4 pinned
  // the handoff face; this face had no guard, which is why the sweep reached it.
  // FAILS IF: `superseded_at IS NULL` is added to readFastSummarySource's SELECT.
  it('still records a superseded observation — completed is history, not standing policy', () => {
    seedObs('s1', 'live-one', NOW.getTime() + 2);
    seedObs('s1', 'retracted-by-a-correction', NOW.getTime() + 3, null, NOW.getTime() + 4);
    const { completed } = readFastSummarySource(db, 's1');
    expect(completed, 'the session did write that observation; its own record must say so').toContain(
      'retracted-by-a-correction',
    );
    expect(completed).toContain('live-one');
  });

  it('is empty, not undefined, for a session with nothing in it', () => {
    expect(readFastSummarySource(db, 'nobody')).toEqual({ request: '', completed: '' });
  });
});

describe('insertFastSummary', () => {
  const row = (id) => db.prepare('SELECT * FROM session_summaries WHERE memory_session_id = ?').get(id);

  it('writes every column the three call sites used to spell out by hand', () => {
    insertFastSummary(db, {
      sessionId: 's1',
      project: 'proj',
      now: NOW,
      values: { request: 'req', completed: 'done', remaining: 'left', notes: 'why' },
      limits: FAST_SUMMARY_LIMITS.stop,
    });
    const r = row('s1');
    expect(r.project).toBe('proj');
    expect(r.request).toBe('req');
    expect(r.completed).toBe('done');
    expect(r.remaining_items).toBe('left');
    expect(r.notes).toBe('why');
    expect(r.created_at_epoch).toBe(NOW.getTime());
    // The constant columns: '' for the LLM-only prose fields, '[]' for the file lists —
    // a JSON reader downstream breaks on NULL where it expects an array.
    expect([r.investigated, r.learned, r.next_steps]).toEqual(['', '', '']);
    expect([r.files_read, r.files_edited]).toEqual(['[]', '[]']);
  });

  it("defaults notes to 'fast', which is what two of the three call sites hardcoded", () => {
    insertFastSummary(db, {
      sessionId: 's2',
      project: 'proj',
      now: NOW,
      values: { request: 'req', completed: 'done' },
      limits: FAST_SUMMARY_LIMITS.sessionStart,
    });
    const r = row('s2');
    expect(r.notes).toBe('fast');
    expect(r.remaining_items).toBe('');
  });

  it('truncates per the limits it was given, not a limit of its own', () => {
    insertFastSummary(db, {
      sessionId: 's3',
      project: 'proj',
      now: NOW,
      values: {
        request: 'r'.repeat(500),
        completed: 'c'.repeat(900),
        remaining: 'm'.repeat(900),
        notes: 'n'.repeat(900),
      },
      limits: FAST_SUMMARY_LIMITS.stop,
    });
    const r = row('s3');
    expect(r.request.length).toBe(FAST_SUMMARY_LIMITS.stop.request);
    expect(r.completed.length).toBe(FAST_SUMMARY_LIMITS.stop.completed);
    expect(r.remaining_items.length).toBe(FAST_SUMMARY_LIMITS.stop.remaining);
    expect(r.notes.length).toBe(FAST_SUMMARY_LIMITS.stop.notes);
  });

  it('scrubs BEFORE truncating, so a secret straddling the cut is still caught', () => {
    // The ordering the three copies each documented and each had to get right on its
    // own: truncate first and the tail of the token falls below scrubSecrets' length
    // floor, so the head survives into the row as plain text.
    // The token has to be one whose RULE depends on length, or the ordering is
    // unobservable: a first attempt used an sk-ant key, whose pattern still matched the
    // truncated stub, and the case passed with the order deliberately reversed. The
    // GitHub PAT rule needs 30+ characters after the prefix, so a stub falls below the
    // floor and survives as plain text. (Assembled in pieces so the literal in this file
    // is not itself a push-protection hit.)
    const secret = 'gh' + 'p_' + 'B'.repeat(36);
    const limits = { ...FAST_SUMMARY_LIMITS.sessionStart, completed: 20 };
    insertFastSummary(db, {
      sessionId: 's4',
      project: 'proj',
      now: NOW,
      values: { request: 'req', completed: 'prefix ' + secret },
      limits,
    });
    const r = row('s4');
    expect(r.completed).not.toContain('gh' + 'p_B');
    expect(r.completed.length).toBeLessThanOrEqual(20);
  });
});

describe('FAST_SUMMARY_LIMITS', () => {
  it('keeps the Stop path wider than the SessionStart paths — the drift is recorded, not erased', () => {
    // Unifying these changes how much text the product re-injects into a later session.
    // That is a measurable behaviour change; this case exists so making it is a decision
    // someone takes on purpose rather than a side effect of tidying up.
    expect(FAST_SUMMARY_LIMITS.stop.completed).toBe(600);
    expect(FAST_SUMMARY_LIMITS.stop.remaining).toBe(600);
    expect(FAST_SUMMARY_LIMITS.sessionStart.completed).toBe(300);
    expect(FAST_SUMMARY_LIMITS.sessionStart.remaining).toBe(200);
    expect(FAST_SUMMARY_LIMITS.exitRestart).toEqual(FAST_SUMMARY_LIMITS.sessionStart);
  });
});

describe('readFastSummarySource: a created_at_epoch tie keeps the newest titles (D#75)', () => {
  it('lists the five highest ids of seven tied observations', () => {
    for (let i = 0; i < 7; i++) {
      db.prepare(
        `INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
         VALUES ('s1', 'p', '', 'change', ?, '', '', '', '', '[]', '[]', 1, datetime('now'), 1000)`,
      ).run(`tied title ${i}`);
    }
    const { completed } = readFastSummarySource(db, 's1');
    expect(completed.split('; ')).toEqual([6, 5, 4, 3, 2].map((i) => `tied title ${i}`));
  });
});

// One row per session: the two writers that run against a session that already has a row.
describe('writes that land on an existing row', () => {
  const addRow = (sid, { request = '', completed = '', remaining = '', notes = 'fast', epoch }) =>
    Number(
      db
        .prepare(
          `INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed,
             next_steps, remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
           VALUES (?, 'p', ?, '', '', ?, '', ?, '[]', '[]', ?, ?, ?)`,
        )
        .run(sid, request, completed, remaining, notes, new Date(epoch).toISOString(), epoch).lastInsertRowid,
    );
  const get = (id) => db.prepare('SELECT * FROM session_summaries WHERE id = ?').get(id);
  const secret = 'gh' + 'p_' + 'B'.repeat(36); // see the scrub-order case above

  it('newestSummaryId: newest by epoch, id breaking a tie; null for a session with none', () => {
    const t = NOW.getTime();
    addRow('s1', { epoch: t + 5 });
    const tiedLow = addRow('s1', { epoch: t + 9 });
    const tiedHigh = addRow('s1', { epoch: t + 9 });
    addRow('s2', { epoch: t + 99 });
    expect(tiedHigh).toBeGreaterThan(tiedLow);
    expect(newestSummaryId(db, 's1')).toBe(tiedHigh);
    expect(newestSummaryId(db, 's3')).toBeNull();
  });

  it('fillFastSummaryGaps fills only the empty fields of a model-written row and moves it to now', () => {
    // Two model-written rows (their content beats this path's, so only gaps are filled) with
    // opposite empty / non-empty columns, so each column is seen both ways.
    const a = addRow('s1', {
      request: '',
      completed: 'KEPT-DONE',
      remaining: '',
      notes: 'llm',
      epoch: NOW.getTime() - 1000,
    });
    const b = addRow('s2', {
      request: 'KEPT-REQ',
      completed: '',
      remaining: 'KEPT-LEFT',
      notes: 'llm',
      epoch: NOW.getTime() - 1000,
    });
    const later = new Date(NOW.getTime() + 60000);
    const values = { request: 'new request', completed: 'new done', remaining: 'new left' };
    for (const id of [a, b])
      fillFastSummaryGaps(db, { id, values, limits: FAST_SUMMARY_LIMITS.sessionStart, now: later });
    expect([get(a).request, get(a).completed, get(a).remaining_items]).toEqual([
      'new request',
      'KEPT-DONE',
      'new left',
    ]);
    expect([get(b).request, get(b).completed, get(b).remaining_items]).toEqual([
      'KEPT-REQ',
      'new done',
      'KEPT-LEFT',
    ]);
    expect(get(a).created_at_epoch).toBe(later.getTime());
    expect(get(a).created_at).toBe(later.toISOString());
  });

  it('fillFastSummaryGaps scrubs before truncating', () => {
    const id = addRow('s1', { epoch: NOW.getTime() });
    fillFastSummaryGaps(db, {
      id,
      values: { request: 'r', completed: 'prefix ' + secret },
      limits: { ...FAST_SUMMARY_LIMITS.sessionStart, completed: 20 },
      now: NOW,
    });
    expect(get(id).completed).not.toContain('gh' + 'p_B');
    expect(get(id).completed.length).toBeLessThanOrEqual(20);
  });

  it('refreshStructuredSummary: a new Done replaces, an absent Done keeps, Not done always replaces', () => {
    const id = addRow('s1', { completed: 'OLD-DONE', remaining: 'OLD-LEFT', epoch: NOW.getTime() });
    refreshStructuredSummary(db, { id, values: { remaining: 'NEW-LEFT' }, limits: FAST_SUMMARY_LIMITS.stop });
    expect(get(id).completed).toBe('OLD-DONE');
    expect(get(id).remaining_items).toBe('NEW-LEFT');
    refreshStructuredSummary(db, { id, values: { completed: 'NEW-DONE' }, limits: FAST_SUMMARY_LIMITS.stop });
    expect(get(id).completed).toBe('NEW-DONE');
    expect(get(id).remaining_items, 'a report with no Not done says nothing is left').toBe('');
    expect(get(id).created_at_epoch, 'the timestamp is not touched').toBe(NOW.getTime());
  });

  it('refreshStructuredSummary: notes carry the latest report, tagged as a report either way', () => {
    const id = addRow('s1', { notes: 'Failed: old', epoch: NOW.getTime() });
    const limits = FAST_SUMMARY_LIMITS.stop;
    refreshStructuredSummary(db, { id, values: { completed: 'd', notes: 'Uncertain: new' }, limits });
    expect(get(id).notes).toBe('Uncertain: new');
    refreshStructuredSummary(db, { id, values: { completed: 'd' }, limits });
    expect(get(id).notes, 'stale Failed / Uncertain text is not kept as if it were current').toBe(
      REPORT_NOTES,
    );
    db.prepare("UPDATE session_summaries SET notes = 'llm' WHERE id = ?").run(id);
    refreshStructuredSummary(db, { id, values: { completed: 'd' }, limits });
    expect(get(id).notes, 'a report replaces the model tag: the row now holds a report').toBe(REPORT_NOTES);
  });

  it('refreshStructuredSummary scrubs before truncating', () => {
    const id = addRow('s1', { epoch: NOW.getTime() });
    refreshStructuredSummary(db, {
      id,
      values: { completed: 'prefix ' + secret },
      limits: { ...FAST_SUMMARY_LIMITS.stop, completed: 20 },
    });
    expect(get(id).completed).not.toContain('gh' + 'p_B');
    expect(get(id).completed.length).toBeLessThanOrEqual(20);
  });

  // Provenance (review of c12cf88): `notes` says where completed / remaining_items came from,
  // and each writer's precedence follows it — report > model > observation titles.
  it('fillFastSummaryGaps replaces a no-report row observation-title fallback with the fresh titles', () => {
    const id = addRow('s1', { completed: 'turn1 early obs', notes: 'fast', epoch: NOW.getTime() });
    fillFastSummaryGaps(db, {
      id,
      values: { request: 'r', completed: 'later obs 5; later obs 4', remaining: 'handoff left' },
      limits: FAST_SUMMARY_LIMITS.sessionStart,
      now: NOW,
    });
    expect(get(id).completed).toBe('later obs 5; later obs 4');
    expect(get(id).remaining_items).toBe('handoff left');
  });

  it('fillFastSummaryGaps leaves a report row Done / Not done alone, including a cleared Not done', () => {
    const id = addRow('s1', {
      completed: 'ALL-DONE',
      remaining: '',
      notes: REPORT_NOTES,
      epoch: NOW.getTime(),
    });
    fillFastSummaryGaps(db, {
      id,
      values: { request: 'r', completed: 'titles', remaining: 'HANDOFF-UNFINISHED' },
      limits: FAST_SUMMARY_LIMITS.sessionStart,
      now: NOW,
    });
    expect(get(id).completed).toBe('ALL-DONE');
    expect(get(id).remaining_items, "the report's 'nothing left' stands").toBe('');
    expect(get(id).request).toBe('r');
  });

  it('refreshObservationTitles updates only a no-report row, and only with something to say', () => {
    const limits = FAST_SUMMARY_LIMITS.stop;
    const fast = addRow('s1', { completed: 'old titles', notes: 'fast', epoch: NOW.getTime() });
    const report = addRow('s2', { completed: 'REPORT', notes: REPORT_NOTES, epoch: NOW.getTime() });
    const llm = addRow('s3', { completed: 'MODEL', notes: 'llm', epoch: NOW.getTime() });
    for (const id of [fast, report, llm])
      refreshObservationTitles(db, { id, completed: 'new titles', limits });
    expect([get(fast).completed, get(report).completed, get(llm).completed]).toEqual([
      'new titles',
      'REPORT',
      'MODEL',
    ]);
    refreshObservationTitles(db, { id: fast, completed: '', limits });
    expect(get(fast).completed).toBe('new titles');
  });

  it('refreshObservationTitles scrubs before truncating', () => {
    const id = addRow('s1', { notes: 'fast', epoch: NOW.getTime() });
    refreshObservationTitles(db, {
      id,
      completed: 'prefix ' + secret,
      limits: { ...FAST_SUMMARY_LIMITS.stop, completed: 20 },
    });
    expect(get(id).completed).not.toContain('gh' + 'p_B');
    expect(get(id).completed.length).toBeLessThanOrEqual(20);
  });

  it('refreshStructuredSummary scrubs remaining_items and notes before truncating too', () => {
    const id = addRow('s1', { epoch: NOW.getTime() });
    refreshStructuredSummary(db, {
      id,
      values: { remaining: 'prefix ' + secret, notes: 'Failed: prefix ' + secret },
      limits: { ...FAST_SUMMARY_LIMITS.stop, remaining: 20, notes: 25 },
    });
    expect(get(id).remaining_items).not.toContain('gh' + 'p_B');
    expect(get(id).remaining_items.length).toBeLessThanOrEqual(20);
    expect(get(id).notes).not.toContain('gh' + 'p_B');
    expect(get(id).notes.length).toBeLessThanOrEqual(25);
  });
});
