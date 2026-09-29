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
  summarySourceLabel,
  FAST_SUMMARY_LIMITS,
  TAIL_FLOOR_CHARS,
  TAIL_MIN_REPLACE,
} from '../lib/fast-summary.mjs';
import { insertSession } from './test-helpers.mjs';
import { scrubRecord } from '../lib/scrub-record.mjs';

let db;
const NOW = new Date('2026-08-22T04:00:00.000Z');

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  // session_summaries.memory_session_id is an FK onto sdk_sessions: seed the parent or
  // every insert here fails on the constraint rather than on its subject.
  for (const id of ['s1', 's2', 's3', 's4']) insertSession(db, { id, project: 'p' });
  for (const id of ['q0', 'q1', 'q2']) insertSession(db, { id: `s-${id}`, project: 'p' });
  for (const id of ['starWords', 'starRun', 'boldRun', 'openBold', 'openFence', 'pipes', 'starsOnly'])
    insertSession(db, { id: `s-${id}`, project: 'p' });
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

// D#121: a session whose final reply carries no report (0/30 in the headless default-user
// corpus, docs/audits/20260927-d114-default-user-corpus.md) had only its opening prompt and
// observation titles, usually empty, as Last Session. Stop now keeps the head of the final
// reply as a Done floor: report > model > tail > titles (tasks/specs/d121-tail-floor.md).
describe('the final reply as a Done floor (D#121)', () => {
  const limits = FAST_SUMMARY_LIMITS.stop;
  const T = NOW.getTime();
  const one = (sid) => {
    const rows = db.prepare('SELECT * FROM session_summaries WHERE memory_session_id = ?').all(sid);
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
  const clear = (sid, values) =>
    writeClearSummary(db, {
      sessionId: sid,
      project: 'p',
      values: { request: 'opening', ...values },
      limits: FAST_SUMMARY_LIMITS.sessionStart,
      now: new Date(T + 10_000),
    });
  const model = (sid, fields) =>
    mergeModelSummary(db, { sessionId: sid, project: 'p', fields, now: new Date(T + 60_000) });
  // Realistic lengths: task replies in the corpus ran 801+ chars, closing ones 15–187.
  const REPLY =
    'I fixed the parser: `parse()` now rejects an empty header, and the suite passes. ' +
    'The change is in src/parse.mjs, with a new case in tests/parse.test.mjs; I did not ' +
    'touch the CLI, and nothing is committed yet. The root cause was that the header split ' +
    'returned one empty field for an empty line, which the length check accepted as a valid ' +
    'single-column header. The new check rejects a header whose every field is empty, and ' +
    'the error names the line number so the caller can point at the bad input.';
  const SECOND =
    'Second answer: the retry loop now backs off exponentially and caps at 30 s, so a flaky ' +
    'upstream no longer pins a core. I added a test for the cap and ran the whole suite, ' +
    'which passes; the old fixed delay is gone. The jitter is drawn per attempt rather than ' +
    'once per request, which keeps several clients from retrying in lockstep, and the cap ' +
    'applies before the jitter so the worst case stays at 30 s plus one jitter interval.';
  const WELCOME = "You're welcome!";
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.CLAUDE_MEM_SUMMARY_TAIL;
    delete process.env.CLAUDE_MEM_SUMMARY_TAIL;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_MEM_SUMMARY_TAIL;
    else process.env.CLAUDE_MEM_SUMMARY_TAIL = savedEnv;
  });

  it('premise: the short reply used below is under the replace threshold, the long one over it', () => {
    expect(WELCOME.length).toBeLessThan(TAIL_MIN_REPLACE);
    expect(REPLY.length).toBeGreaterThanOrEqual(TAIL_MIN_REPLACE);
  });

  it('without a report, the flattened head of the final reply is the Done, tagged tail', () => {
    stop('s1', {
      tail: `## Result\n\n${REPLY}\n\n\`\`\`js\nparse('')\n\`\`\`\n- **Next:** node_modules untouched`,
    });
    const r = one('s1');
    // Heading marker and the code block go; inline markup stays (it is not rewritten, see below).
    expect(r.completed.startsWith('Result I fixed the parser: `parse()` now rejects an empty header')).toBe(
      true,
    );
    expect(r.completed).not.toMatch(/^#|parse\(''\)/);
    expect(r.completed.length).toBeLessThanOrEqual(TAIL_FLOOR_CHARS);
    expect(parseSummaryNotes(r.notes)).toMatchObject({ done: 'tail', left: 'other' });
  });

  it('keeps identifiers and inline arrows intact while flattening', () => {
    stop('s1', { tail: 'Moved node_modules handling so a -> b holds for every_case here, as asked.' });
    expect(one('s1').completed).toBe(
      'Moved node_modules handling so a -> b holds for every_case here, as asked.',
    );
  });

  it('cuts at TAIL_FLOOR_CHARS, scrubbing before the cut', () => {
    const secret = 'gh' + 'p_' + 'C'.repeat(36);
    stop('s1', { tail: `${'x'.repeat(TAIL_FLOOR_CHARS - 10)} token ${secret} tail` });
    const r = one('s1');
    expect(r.completed.length).toBeLessThanOrEqual(TAIL_FLOOR_CHARS);
    expect(r.completed).not.toContain('ghp_CCCC');
  });

  it('beats titles on later turns, and a later substantive reply replaces it', () => {
    stop('s1', { tail: REPLY }, 'turn1 titles');
    stop('s1', {}, 'turn2 titles');
    expect(one('s1').completed.startsWith('I fixed the parser')).toBe(true);
    stop('s1', { tail: SECOND });
    expect(one('s1').completed.startsWith('Second answer')).toBe(true);
  });

  it('a short closing reply does not replace it, but may create the first floor', () => {
    stop('s1', { tail: REPLY });
    stop('s1', { tail: WELCOME });
    expect(one('s1').completed.startsWith('I fixed the parser')).toBe(true);
    stop('s2', { tail: WELCOME }, '');
    expect(one('s2').completed).toBe(WELCOME);
  });

  it('a report replaces it and is then protected from later tails', () => {
    stop('s1', { tail: REPLY });
    stop('s1', { done: 'REPORT-DONE' });
    stop('s1', { tail: REPLY });
    expect(one('s1').completed).toBe('REPORT-DONE');
    expect(parseSummaryNotes(one('s1').notes).done).toBe('report');
  });

  it('a model reply replaces it; a later tail does not replace the model', () => {
    stop('s1', { tail: REPLY });
    model('s1', { completed: 'MODEL-DONE' });
    stop('s1', { tail: SECOND });
    expect(one('s1').completed).toBe('MODEL-DONE');
  });

  it('/clear titles do not replace it', () => {
    stop('s1', { tail: REPLY });
    clear('s1', { completed: 'fresh titles' });
    expect(one('s1').completed.startsWith('I fixed the parser')).toBe(true);
  });

  it('CLAUDE_MEM_SUMMARY_TAIL=0 keeps the titles fallback', () => {
    process.env.CLAUDE_MEM_SUMMARY_TAIL = '0';
    stop('s1', { tail: REPLY }, 'only titles');
    expect(one('s1').completed).toBe('only titles');
    expect(parseSummaryNotes(one('s1').notes).done).toBe('titles');
  });

  // v6.18.0 pre-tag reviews: no ORDER of scrub and markup-stripping is safe. Stripping first
  // let a backtick-split key's tail through; scrubbing first missed a pipe-split Bearer token
  // the scrubber only sees once the pipe is gone. The floor is a convenience, so it fails
  // closed: a reply in which the scrubber finds a secret — as written, or with `, | and *
  // removed — writes no floor for that turn.
  it('a reply carrying a secret in any markup view writes no floor', () => {
    const key = 'sk-' + 'ant-api03-' + 'Q'.repeat(40);
    const inputs = [
      'Set the config: password=hunter2|Zq9xw7Lk and restart.',
      '| Authorization: Bearer | ' + 'tok' + 'X'.repeat(30) + ' |',
      'Use `' + key.slice(0, 20) + '`' + key.slice(20) + ' for the call.',
      'Use ' + key.slice(0, 20) + '**' + key.slice(20) + '** for the call.',
      `${'word '.repeat(22)}${'gh' + 'p_' + 'C'.repeat(36)} straddles the cut`,
      // A markup-wrapped label: invisible to the scrubber as written until D#128.
      'Set **password**=hunter2Zq9 and restart.',
      // Invisible to the scrubber as written, caught once the markup is gone:
      'Use `' + key.slice(0, 8) + '`' + key.slice(8) + ' now.',
      'Use ' + key.slice(0, 8) + '*' + key.slice(8) + ' now.',
      'Use gh|' + ('gh' + 'p_' + 'C'.repeat(36)).slice(2) + ' now.',
    ];
    inputs.forEach((raw, n) => {
      const sid = `s${(n % 4) + 1}`;
      db.prepare('DELETE FROM session_summaries WHERE memory_session_id = ?').run(sid);
      stop(sid, { tail: raw }, '');
      expect(one(sid).completed, `input ${n} wrote a floor`).toBe('');
    });
    // Premise: the same shape without a secret does write one.
    db.prepare("DELETE FROM session_summaries WHERE memory_session_id = 's1'").run();
    stop('s1', { tail: 'Set the config: retries=3|timeout=30 and restart.' }, '');
    expect(one('s1').completed).toBe('Set the config: retries=3|timeout=30 and restart.');
  });

  // v6.18.0 security review P1: the check ran on the reply as written, the store on the
  // text with list / quote markers removed. A marker between a label and its value hid the
  // pair from the check; removing it for storage brought them together. The check now runs
  // on what is stored.
  it('checks the text it stores: a label and value split by list or quote markers write no floor', () => {
    const value = 'S3cr3t' + '-Value_77';
    stop('s1', { tail: `Staging creds:\n- **Password**:\n  - \`${value}\`` }, '');
    expect(one('s1').completed).not.toContain(value);
    stop('s2', { tail: `Staging creds:\n> password:\n> ${value}\nDone with setup.` }, '');
    expect(one('s2').completed).not.toContain(value);
  });

  // Security review P2-1: the scrubber has pre-existing quadratic patterns, and scrubbing the
  // WHOLE reply three times pushed a crafted 200k-char reply past Stop's 5 s timeout. Only the
  // head is stored, so only a bounded head is examined.
  it('examines a bounded head: crafted scrubber-quadratic input stays fast', () => {
    const N = 200_000;
    const shapes = [
      "'" + 'secret'.repeat(N / 6),
      '"' + 'password'.repeat(N / 8),
      '-----BEGIN ' + 'PRIVATE KEY-----\n'.repeat(N / 17),
    ];
    shapes.forEach((text, i) => {
      const t0 = performance.now();
      stop(`s-q${i}`, { tail: text }, '');
      expect(performance.now() - t0, `shape ${i} took too long`).toBeLessThan(1000);
    });
  });

  // Narrow re-check after the security fix (v6.18.0): three hardening cases.
  it('the lines-kept view is needed: a value the joined view hides still writes no floor', () => {
    stop('s1', { tail: 'Staging creds\npassword: hunterxyz\nDone' }, '');
    expect(one('s1').completed).not.toContain('hunterxyz');
  });

  it('a PEM header in the examined head writes no floor, even when its END is out of reach', () => {
    const body = ('MIIEowIBAAKCAQEA' + 'q'.repeat(48) + '\n').repeat(200);
    stop(
      's1',
      { tail: `Key:\n-----BEGIN RSA ${'PRIVATE'} KEY-----\n${body}-----END RSA ${'PRIVATE'} KEY-----` },
      '',
    );
    expect(one('s1').completed).not.toContain('MIIE');
  });

  it('the cut text is checked too: a shape the 120-char cut completes writes no floor', () => {
    // The scrubber leaves `password=<value>(x)` alone (a call, not an assignment) but flags
    // `password=<value>…` once the cut removes the parentheses.
    let flagged = 0;
    for (let pad = 60; pad <= 118; pad++) {
      const sid = `s${(pad % 4) + 1}`;
      db.prepare('DELETE FROM session_summaries WHERE memory_session_id = ?').run(sid);
      const tail = `${'a'.repeat(pad)} password=${'Kq7'.repeat(9)}(x) and more words after the call here`;
      stop(sid, { tail }, '');
      const c = one(sid).completed;
      if (c && scrubRecord('session_summaries', { completed: c }).completed !== c) flagged++;
    }
    expect(flagged, 'stored floors that a re-scrub would change').toBe(0);
  });

  it('a secret-bearing reply leaves an earlier floor in place', () => {
    stop('s1', { tail: REPLY });
    stop('s1', { tail: 'Rotated it: password=hunter2|Zq9xw7Lk. ' + 'x'.repeat(TAIL_MIN_REPLACE) });
    expect(one('s1').completed.startsWith('I fixed the parser')).toBe(true);
  });

  it('a reply that opens with a code block stores the prose after it', () => {
    stop('s1', { tail: '```js\nconst secretPlan = 1;\n```\nI replaced the constant with a config read.' });
    expect(one('s1').completed).toBe('I replaced the constant with a config read.');
  });

  it('leaves every token as written: dunder names, globs, bold and backticks', () => {
    const line =
      'Touched pkg/__init__.py and __dirname; matched *.mjs and *.cjs, `**/__tests__/**`. **Done**.';
    stop('s1', { tail: line });
    expect(one('s1').completed).toBe(line);
  });

  it('a Not-done-only or Failed-only reply is a report: no floor from it', () => {
    stop(
      's1',
      { notDone: 'the schema migration', tail: 'Not done: the schema migration — blocked on AUTH.' },
      '',
    );
    expect(one('s1').completed).toBe('');
    stop('s2', { lines: 'Failed: build', tail: 'Failed: the build broke on the new flag.' }, 'some titles');
    expect(one('s2').completed).toBe('some titles');
    expect(parseSummaryNotes(one('s2').notes).done).toBe('titles');
  });

  it('the replace threshold is on the raw reply length, inclusive', () => {
    stop('s1', { tail: REPLY });
    stop('s1', { tail: 'B'.repeat(TAIL_MIN_REPLACE - 1) });
    expect(one('s1').completed.startsWith('I fixed the parser')).toBe(true);
    stop('s1', { tail: 'C'.repeat(TAIL_MIN_REPLACE) });
    expect(one('s1').completed.startsWith('CCC')).toBe(true);
    // A code-heavy reply flattens short but was long as written: it still replaces.
    stop('s2', { tail: REPLY });
    stop('s2', { tail: '```\n' + 'x'.repeat(TAIL_MIN_REPLACE) + '\n```\nApplied the patch above.' });
    expect(one('s2').completed).toBe('Applied the patch above.');
  });

  // A model-created row with an empty Done is tagged titles already; the case the
  // empty-Done clause exists for is a legacy row whose '' / 'llm' notes parse as model.
  it('an empty Done takes the floor whatever its tag (legacy model-tagged row)', () => {
    db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, request, completed, notes, created_at, created_at_epoch)
       VALUES ('s1', 'p', 'opening', '', 'llm', 'x', ?)`,
    ).run(T);
    expect(parseSummaryNotes(one('s1').notes).done, 'premise: parsed as model').toBe('model');
    stop('s1', { tail: REPLY }, '');
    expect(one('s1').completed.startsWith('I fixed the parser')).toBe(true);
  });

  it('turning CLAUDE_MEM_SUMMARY_TAIL=0 on mid-session lets titles replace an existing floor', () => {
    stop('s1', { tail: REPLY }, 'old titles');
    process.env.CLAUDE_MEM_SUMMARY_TAIL = '0';
    stop('s1', { tail: SECOND }, 'new titles');
    expect(one('s1').completed).toBe('new titles');
    expect(parseSummaryNotes(one('s1').notes).done).toBe('titles');
    // Titles are usually EMPTY for such a user: the opt-out must still clear the floor.
    delete process.env.CLAUDE_MEM_SUMMARY_TAIL;
    stop('s2', { tail: REPLY }, '');
    process.env.CLAUDE_MEM_SUMMARY_TAIL = '0';
    stop('s2', { tail: SECOND }, '');
    expect(one('s2').completed).toBe('');
    expect(parseSummaryNotes(one('s2').notes).done).toBe('titles');
  });

  // Stop runs this on every turn over text the model wrote, which can quote anything: each
  // adversarial shape must stay linear. 200k chars ran in <= 13 ms locally (2026-09-27).
  it('flattening stays fast on 200k-char adversarial shapes', () => {
    const N = 200_000;
    const shapes = {
      starWords: '*a '.repeat(N / 3),
      starRun: '*a'.repeat(N / 2),
      boldRun: '**a'.repeat(N / 3),
      openBold: '**' + 'a'.repeat(N),
      openFence: '```' + 'x'.repeat(N),
      pipes: '|a'.repeat(N / 2),
      starsOnly: '*'.repeat(N),
    };
    for (const [name, text] of Object.entries(shapes)) {
      const t0 = performance.now();
      stop(`s-${name}`, { tail: text });
      expect(performance.now() - t0, `${name} took too long`).toBeLessThan(1000);
    }
  });

  it('round-trips the tag and labels it last-reply for the handoff', () => {
    const p = { done: 'tail', left: 'other', lines: '' };
    expect(parseSummaryNotes(formatSummaryNotes(p))).toEqual(p);
    expect(summarySourceLabel(formatSummaryNotes(p))).toBe('last-reply');
  });
});

// P3-6 (v6.13.5 third review): Stop spawns one model worker per turn, and two workers of
// consecutive turns can finish out of order, so the older reply landed last and overwrote the
// newer one's model fields. A worker now carries its Stop's epoch; sdk_sessions.completed_at_epoch
// holds the session's LATEST Stop, and a worker whose Stop is older than that writes nothing —
// the newer Stop's worker summarizes the newer window.
describe('a model reply from a superseded Stop does not land (P3-6)', () => {
  const T = NOW.getTime();
  const setLatestStop = (sid, epoch) =>
    db.prepare('UPDATE sdk_sessions SET completed_at_epoch = ? WHERE content_session_id = ?').run(epoch, sid);
  const seedRow = (sid) =>
    insertFastSummary(db, {
      sessionId: sid,
      project: 'p',
      now: NOW,
      values: { request: 'opening', completed: 'titles' },
      limits: FAST_SUMMARY_LIMITS.stop,
    });
  const model = (sid, spawnEpoch) =>
    mergeModelSummary(db, {
      sessionId: sid,
      project: 'p',
      fields: { request: 'model request', next_steps: 'model next' },
      now: new Date(T + 60_000),
      spawnEpoch,
    });
  const read = (sid) =>
    db.prepare('SELECT request, next_steps FROM session_summaries WHERE memory_session_id = ?').all(sid);

  it('skips the write when a newer Stop exists, and reports it', () => {
    seedRow('s1');
    setLatestStop('s1', T + 2000);
    expect(model('s1', T + 1000)).toBe(false);
    expect(read('s1')).toEqual([{ request: 'opening', next_steps: '' }]);
  });

  it('skips the INSERT too, for a session with no row yet', () => {
    setLatestStop('s1', T + 2000);
    expect(model('s1', T + 1000)).toBe(false);
    expect(read('s1')).toEqual([]);
  });

  it('writes when its own Stop is the latest, when no epoch was passed, and when none is stored', () => {
    for (const sid of ['s1', 's2', 's3', 's4']) seedRow(sid);
    setLatestStop('s1', T + 1000);
    setLatestStop('s2', T + 2000);
    setLatestStop('s4', T + 2000);
    expect(model('s1', T + 1000), 'its own Stop').toBe(true);
    expect(model('s2', undefined), 'a spawn without an epoch (/clear, a pre-upgrade worker)').toBe(true);
    expect(model('s3', T + 1000), 'no Stop recorded').toBe(true);
    expect(model('s4', Number('')), 'an empty argv epoch is not epoch 0').toBe(true);
    for (const sid of ['s1', 's2', 's3', 's4']) expect(read(sid)[0].request, sid).toBe('model request');
  });
});
