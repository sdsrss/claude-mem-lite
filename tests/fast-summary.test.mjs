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
import { readFastSummarySource, insertFastSummary, FAST_SUMMARY_LIMITS } from '../lib/fast-summary.mjs';
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
