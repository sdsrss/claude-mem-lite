// D#40: `## Key Decisions` read `ORDER BY created_at_epoch DESC LIMIT 10`, THEN dropped
// low-signal titles in JS, THEN kept five. A SQL LIMIT upstream of a JS filter is a
// reachability bound, not a ranking bound: six or more low-signal rows among the newest ten
// evicted older real decisions the section had room for.
//
// Reachable, not hypothetical: capNoiseImportance caps a low-signal title at 1 on WRITE, but
// two later writers raise importance without reading the title (maintain-core boostAccessed
// on access_count > 3, search-scoring autoBoostIfNeeded on access_count >= 2) — R12 A3. The
// live corpus had none in the pool when D#40 was measured (43 candidates, 0 low-signal), so
// that reading was a blind instrument; this fixture puts them there.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { buildAndSaveHandoff } from '../hook-handoff.mjs';
import { LOW_SIGNAL_TITLE } from '../utils.mjs';
import * as gitStateModule from '../lib/git-state.mjs';
import * as taskReaderModule from '../lib/task-reader.mjs';

const P = 'proj-d40';
const S = 'sess-d40';
let db;

beforeEach(() => {
  vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
    changed: [],
    stashes: [],
    branch: null,
    headSha: null,
  });
  vi.spyOn(taskReaderModule, 'readProjectTasks').mockReturnValue([]);
  db = createTestDb();
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
     VALUES (?, ?, ?, datetime('now'), ?, 'active')`,
  ).run(S, S, P, 500);
  // A session with no prompt hands off nothing (the empty-session guard), so give it one.
  db.prepare(
    `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
     VALUES (?, 'decide the retry policy', 1, datetime('now'), 600)`,
  ).run(S);
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function obs(title, importance, epoch) {
  db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, importance, created_at, created_at_epoch)
     VALUES (?, ?, 'decision', ?, ?, datetime('now'), ?)`,
  ).run(S, P, title, importance, epoch);
}

function keyDecisions() {
  buildAndSaveHandoff(db, S, P, 'exit', null);
  const row = db.prepare(`SELECT key_decisions FROM session_handoffs WHERE project = ?`).get(P);
  expect(row, 'premise: a handoff row was written').toBeTruthy();
  return (row?.key_decisions || '').split('\n').filter(Boolean);
}

describe('Key Decisions: the low-signal filter runs before the limit (D#40)', () => {
  it('keeps five real decisions when eight newer low-signal rows sit above them', () => {
    for (let i = 0; i < 5; i++) obs(`real decision ${i}`, 3, 1_000 + i);
    for (let i = 0; i < 8; i++) obs(`Modified file-${i}.mjs`, 2, 2_000 + i);
    // Premise: the fixture's noise really is what the filter drops.
    expect(LOW_SIGNAL_TITLE.test('Modified file-0.mjs')).toBe(true);

    const lines = keyDecisions();
    expect(lines).toHaveLength(5);
    for (let i = 0; i < 5; i++) expect(lines.join('\n')).toContain(`real decision ${i}`);
    expect(lines.join('\n')).not.toMatch(/Modified file-/);
  });

  it('still caps at five and keeps newest-first when real decisions outnumber the cap', () => {
    for (let i = 0; i < 7; i++) obs(`real decision ${i}`, 3, 1_000 + i);
    for (let i = 0; i < 3; i++) obs(`Modified file-${i}.mjs`, 2, 2_000 + i);
    expect(keyDecisions()).toEqual([6, 5, 4, 3, 2].map((i) => `[decision] real decision ${i}`));
  });

  it('breaks a created_at_epoch tie newest-id-first, so the cap keeps the latest writes', () => {
    // Two inserts share a millisecond often enough that the tie is the common case for a
    // batch of saves. Without `id DESC` SQLite returns the tie in ascending rowid, so the cap
    // of five kept the OLDEST five of seven.
    for (let i = 0; i < 7; i++) obs(`real decision ${i}`, 3, 1_000);
    expect(keyDecisions()).toEqual([6, 5, 4, 3, 2].map((i) => `[decision] real decision ${i}`));
  });
});
