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
  parseSummaryNotes,
  formatSummaryNotes,
  writeStopSummary,
  writeClearSummary,
  mergeModelSummary,
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

// One row per session, with per-field provenance at the head of `notes`: the three writers
// (Stop, /clear, the model) follow report > model > titles for Done and report > other for
// Not done. Each case drives a real sequence of writes and reads the row back.
describe('one summary row per session', () => {
  const limits = FAST_SUMMARY_LIMITS.stop;
  const T = NOW.getTime();
  const row = (sid) => db.prepare('SELECT * FROM session_summaries WHERE memory_session_id = ?').all(sid);
  const one = (sid) => {
    const rows = row(sid);
    expect(rows, 'premise: exactly one row').toHaveLength(1);
    return rows[0];
  };
  const stop = (sid, report = {}, titles = 'titles now', at = T) =>
    writeStopSummary(db, {
      sessionId: sid,
      project: 'p',
      report,
      source: { request: 'opening', completed: titles },
      now: new Date(at),
      limits,
    });
  const clear = (sid, values, at = T + 10_000) =>
    writeClearSummary(db, {
      sessionId: sid,
      project: 'p',
      values: { request: 'opening', ...values },
      limits: FAST_SUMMARY_LIMITS.sessionStart,
      now: new Date(at),
    });
  const model = (sid, fields) =>
    mergeModelSummary(db, { sessionId: sid, project: 'p', fields, now: new Date(T + 60_000) });
  const secret = 'gh' + 'p_' + 'B'.repeat(36); // see the scrub-order case above

  it('parseSummaryNotes / formatSummaryNotes round-trip, and legacy values map to titles or model, never report', () => {
    for (const p of [
      { done: 'report', left: 'report', lines: '' },
      { done: 'titles', left: 'other', lines: 'Failed: x Uncertain: y' },
      { done: 'model', left: 'report', lines: '' },
    ])
      expect(parseSummaryNotes(formatSummaryNotes(p))).toEqual(p);
    expect(parseSummaryNotes('fast')).toEqual({ done: 'titles', left: 'other', lines: '' });
    expect(parseSummaryNotes('llm')).toEqual({ done: 'model', left: 'other', lines: '' });
    expect(parseSummaryNotes('')).toEqual({ done: 'model', left: 'other', lines: '' });
    expect(parseSummaryNotes(null)).toEqual({ done: 'model', left: 'other', lines: '' });
    expect(parseSummaryNotes('Failed: legacy')).toEqual({
      done: 'titles',
      left: 'other',
      lines: 'Failed: legacy',
    });
  });

  it('newestSummaryId: newest by epoch, id breaking a tie; null for a session with none', () => {
    stop('s1', {}, 't', T);
    db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, request, completed, created_at, created_at_epoch)
       VALUES ('s1', 'p', 'r', 'c', 'x', ?), ('s1', 'p', 'r', 'c', 'x', ?)`,
    ).run(T + 9, T + 9);
    const ids = db
      .prepare("SELECT id FROM session_summaries WHERE memory_session_id = 's1' ORDER BY id")
      .all();
    expect(newestSummaryId(db, 's1')).toBe(ids[2].id);
    expect(newestSummaryId(db, 's3')).toBeNull();
  });

  it('Stop: the first write inserts, later turns update the same row and keep its timestamp', () => {
    stop('s1', { done: 'FIRST' }, 't', T);
    stop('s1', { done: 'SECOND' }, 't', T + 5000);
    const r = one('s1');
    expect(r.completed).toBe('SECOND');
    expect(r.created_at_epoch).toBe(T);
  });

  it('Stop: a Done with no Not done clears the Not done; a Not done alone keeps the Done', () => {
    stop('s1', { done: 'D1', notDone: 'L1' });
    stop('s1', { notDone: 'L2' });
    expect([one('s1').completed, one('s1').remaining_items]).toEqual(['D1', 'L2']);
    stop('s1', { done: 'D3' });
    expect([one('s1').completed, one('s1').remaining_items]).toEqual(['D3', '']);
  });

  it('Stop: without a report, a titles Done follows the current titles; a report Done does not', () => {
    stop('s1', {}, 'turn1 titles');
    stop('s1', {}, 'turn2 titles');
    expect(one('s1').completed).toBe('turn2 titles');
    stop('s2', { done: 'REPORT' }, 'turn1 titles');
    stop('s2', {}, 'turn2 titles');
    expect(one('s2').completed).toBe('REPORT');
  });

  it('Stop: a report arriving on a later turn is protected like one written first', () => {
    stop('s1', {}, 'turn1 titles');
    stop('s1', { done: 'LATE-REPORT' });
    expect(parseSummaryNotes(one('s1').notes)).toMatchObject({ done: 'report', left: 'report' });
    stop('s1', {}, 'turn3 titles');
    clear('s1', { completed: 'fresh titles', remaining: 'HANDOFF' });
    model('s1', { completed: 'MODEL-DONE', remaining_items: 'MODEL-LEFT' });
    expect([one('s1').completed, one('s1').remaining_items]).toEqual(['LATE-REPORT', '']);
  });

  it('Stop: a Not-done-only report keeps the Done as titles, which later titles and the model can replace (delta P2-2)', () => {
    stop('s1', { notDone: 'LEFT' }, 'turn1 titles');
    expect(parseSummaryNotes(one('s1').notes)).toMatchObject({ done: 'titles', left: 'report' });
    stop('s1', {}, 'turn2 titles');
    expect(one('s1').completed).toBe('turn2 titles');
    model('s1', { completed: 'MODEL-DONE', remaining_items: 'MODEL-LEFT' });
    expect([one('s1').completed, one('s1').remaining_items]).toEqual(['MODEL-DONE', 'LEFT']);
  });

  it('Stop: Failed / Uncertain lines alone are not a report (delta P2-1)', () => {
    stop('s1', { lines: 'Failed: the build broke' }, 'turn1 titles');
    const r = one('s1');
    expect(parseSummaryNotes(r.notes)).toEqual({
      done: 'titles',
      left: 'other',
      lines: 'Failed: the build broke',
    });
    model('s1', { completed: 'MODEL-DONE', remaining_items: 'MODEL-LEFT' });
    expect([one('s1').completed, one('s1').remaining_items]).toEqual(['MODEL-DONE', 'MODEL-LEFT']);
    expect(parseSummaryNotes(one('s1').notes).lines).toBe('Failed: the build broke');
  });

  it('Stop: Failed / Uncertain lines follow the latest report and are not kept past it', () => {
    stop('s1', { done: 'D', lines: 'Failed: old' });
    stop('s1', { done: 'D2' });
    expect(parseSummaryNotes(one('s1').notes).lines).toBe('');
    stop('s1', { lines: 'Uncertain: new' });
    expect(parseSummaryNotes(one('s1').notes).lines).toBe('Uncertain: new');
    stop('s1', {});
    expect(parseSummaryNotes(one('s1').notes).lines, 'a turn with nothing to say keeps them').toBe(
      'Uncertain: new',
    );
  });

  it('model: a report Done / Not done survive a full reply; the other fields take the model', () => {
    stop('s1', { done: 'REPORT-DONE', notDone: 'REPORT-LEFT' });
    model('s1', {
      request: 'MODEL-REQ',
      completed: 'MODEL-DONE',
      remaining_items: 'MODEL-LEFT',
      next_steps: 'NEXT',
    });
    const r = one('s1');
    expect([r.request, r.completed, r.remaining_items, r.next_steps]).toEqual([
      'MODEL-REQ',
      'REPORT-DONE',
      'REPORT-LEFT',
      'NEXT',
    ]);
  });

  it("model: a report's cleared Not done stays cleared, even with an older row that has one", () => {
    const ins = db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, request, completed, remaining_items, notes, created_at, created_at_epoch)
       VALUES ('s1', 'p', 'r', ?, ?, ?, 'x', ?)`,
    );
    ins.run('c', 'STALE-LEFT', 'llm', T - 2000);
    ins.run('ALL-DONE', '', formatSummaryNotes({ done: 'report', left: 'report', lines: '' }), T - 1000);
    model('s1', { remaining_items: 'MODEL-LEFT' });
    const newest = db.prepare('SELECT * FROM session_summaries WHERE id = ?').get(newestSummaryId(db, 's1'));
    expect(newest.remaining_items).toBe('');
  });

  it('model: a degraded reply leaves a titles Done as titles, so later titles still land (delta P3-1)', () => {
    stop('s1', {}, 'turn1 titles');
    model('s1', { request: 'only a request' });
    expect(parseSummaryNotes(one('s1').notes).done).toBe('titles');
    stop('s1', {}, 'turn2 titles');
    expect(one('s1').completed).toBe('turn2 titles');
  });

  it('an empty Done takes the titles whatever tag the row carries (third review P3-1)', () => {
    // The worker can create the row itself (Stop's first write failed) with a reply that has
    // no Done; a legacy row can carry '' notes and an empty Done. Neither may block titles.
    model('s1', { lessons: '["x"]' });
    expect(parseSummaryNotes(one('s1').notes).done, 'a row with no Done is not a model Done').toBe('titles');
    stop('s1', {}, 'later titles');
    expect(one('s1').completed).toBe('later titles');
    db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, request, completed, notes, created_at, created_at_epoch)
       VALUES ('s2', 'p', 'r', '', '', 'x', ?)`,
    ).run(T);
    stop('s2', {}, 'titles now');
    expect(one('s2').completed).toBe('titles now');
    expect(parseSummaryNotes(one('s2').notes).done).toBe('titles');
  });

  it('model: the rewritten notes stay within the notes limit (third review P3-3)', () => {
    db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, request, completed, notes, created_at, created_at_epoch)
       VALUES ('s1', 'p', 'r', 'c', ?, 'x', ?)`,
    ).run('Failed: ' + 'x'.repeat(392), T);
    model('s1', { request: 'r2' });
    expect(one('s1').notes.length).toBeLessThanOrEqual(FAST_SUMMARY_LIMITS.stop.notes);
  });

  it('model: an empty field falls back to the row, then to older rows newest first', () => {
    const ins = db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, notes, created_at, created_at_epoch)
       VALUES ('s1', 'p', 'r', ?, ?, 'llm', 'x', ?)`,
    );
    ins.run('OLDEST', 'OLDEST-NEXT', T - 2000);
    ins.run('MIDDLE', '', T - 1000);
    ins.run('', '', T);
    model('s1', { request: 'x' });
    const newest = db.prepare('SELECT * FROM session_summaries WHERE id = ?').get(newestSummaryId(db, 's1'));
    expect([newest.completed, newest.next_steps]).toEqual(['MIDDLE', 'OLDEST-NEXT']);
  });

  it('model: a session with no row is inserted at its last prompt, not at the worker finish (D#79)', () => {
    db.prepare(
      `INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
       VALUES ('s1', 1, 'a', 'x', ?), ('s1', 2, 'b', 'x', ?)`,
    ).run(T - 5000, T - 1000);
    model('s1', { request: 'r', completed: 'c' });
    expect(one('s1').created_at_epoch).toBe(T - 1000);
    model('s2', { request: 'r' });
    expect(one('s2').created_at_epoch, 'no prompt: the worker time').toBe(T + 60_000);
  });

  it('/clear: inserts when there is no row, and otherwise updates the one row and moves it to now', () => {
    clear('s1', { completed: 'titles', remaining: 'left' }, T);
    expect(parseSummaryNotes(one('s1').notes)).toMatchObject({ done: 'titles', left: 'other' });
    stop('s2', { done: 'D' }, 't', T);
    clear('s2', { completed: 'x' }, T + 10_000);
    expect(one('s2').created_at_epoch).toBe(T + 10_000);
  });

  it('/clear: a titles Done takes the fresh titles; a report or model Done fills only a gap', () => {
    stop('s1', {}, 'turn1 titles');
    clear('s1', { completed: 'fresh titles' });
    expect(one('s1').completed).toBe('fresh titles');
    stop('s2', { done: 'REPORT' });
    clear('s2', { completed: 'fresh titles' });
    expect(one('s2').completed).toBe('REPORT');
    stop('s3', {}, 't');
    model('s3', { completed: 'MODEL' });
    clear('s3', { completed: 'fresh titles' });
    expect(one('s3').completed).toBe('MODEL');
  });

  it("/clear: a report Not done is left alone, '' included; any other Not done fills only a gap", () => {
    stop('s1', { done: 'ALL-DONE' });
    clear('s1', { remaining: 'HANDOFF' });
    expect(one('s1').remaining_items).toBe('');
    stop('s2', {}, 't');
    clear('s2', { remaining: 'HANDOFF' });
    expect(one('s2').remaining_items).toBe('HANDOFF');
    stop('s3', {}, 't');
    model('s3', { remaining_items: 'MODEL-LEFT' });
    clear('s3', { remaining: 'HANDOFF' });
    expect(one('s3').remaining_items).toBe('MODEL-LEFT');
  });

  it('/clear: request fills only a gap', () => {
    model('s1', { request: 'MODEL-REQ' });
    clear('s1', { request: 'opening' });
    expect(one('s1').request).toBe('MODEL-REQ');
  });

  it('every Stop and /clear write scrubs before truncating', () => {
    // notes gets room for the whole secret: a cut inside it would pass without any scrub.
    const cut = { ...limits, completed: 20, remaining: 20, request: 20, notes: 200 };
    writeStopSummary(db, {
      sessionId: 's1',
      project: 'p',
      report: { notDone: 'prefix ' + secret, lines: 'Failed: prefix ' + secret },
      source: { request: 'prefix ' + secret, completed: 'prefix ' + secret },
      now: NOW,
      limits: cut,
    });
    stop('s2', {}, 't');
    writeStopSummary(db, {
      sessionId: 's2',
      project: 'p',
      report: { done: 'prefix ' + secret },
      source: { request: 'r', completed: 't' },
      now: NOW,
      limits: cut,
    });
    writeClearSummary(db, {
      sessionId: 's3',
      project: 'p',
      values: { request: 'prefix ' + secret, completed: 'prefix ' + secret, remaining: 'prefix ' + secret },
      limits: cut,
      now: NOW,
    });
    for (const sid of ['s1', 's2', 's3'])
      for (const col of ['request', 'completed', 'remaining_items', 'notes'])
        expect(one(sid)[col] ?? '', `${sid}.${col}`).not.toContain('gh' + 'p_B');
    expect(one('s1').completed.length).toBeLessThanOrEqual(20);
    expect(one('s1').notes, 'premise: the Failed line was kept').toContain('Failed: prefix');
    expect(one('s2').completed.length).toBeLessThanOrEqual(20);
    expect(one('s3').remaining_items.length).toBeLessThanOrEqual(20);
  });
});
