// D#67: three more observations reads in buildAndSaveHandoff had the two shapes D#40 fixed
// in Key Decisions (aa2df33 + 0ac7f04).
//
// 1. key_files read `files_modified ... ORDER BY created_at_epoch DESC LIMIT 10`, THEN a JS
//    filter dropped every entry that is not a file ('[]', directories, /tmp paths). The SQL
//    LIMIT was a reachability bound: rows contributing nothing used up the window and
//    could evict older real files. Latent on the live DB: the v6.13.2 pre-ship claims
//    review replayed it 2026-09-26 with the read's own WHERE and window, and 0 of 45
//    stored handoffs lost a file. The first fixture below builds the shape.
// 2. `completed` (LIMIT 15) and the carry-forward subject fallback (LIMIT 1) ordered by
//    created_at_epoch DESC alone, so a tie came back ascending rowid and the cap kept the
//    OLDEST rows.
// 3. renderHandoffFromRow's <session-summary> append read session_summaries twice with no
//    id tiebreaker (exact memory_session_id arm, and the nearest-in-time fallback), so a
//    created_at_epoch tie attached the OLDER summary. Latent: 0 tie groups over the live
//    DB's 450 summary rows, read-only, 2026-09-26.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { buildAndSaveHandoff, renderHandoffInjection } from '../hook-handoff.mjs';
import * as gitStateModule from '../lib/git-state.mjs';
import * as taskReaderModule from '../lib/task-reader.mjs';

const P = 'proj-d67';
const S = 'sess-d67';
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
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function prompt(text) {
  db.prepare(
    `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
     VALUES (?, ?, 1, datetime('now'), 600)`,
  ).run(S, text);
}

function obs({ title, importance = 1, files = null, epoch }) {
  db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, importance, files_modified, created_at, created_at_epoch)
     VALUES (?, ?, 'change', ?, ?, ?, datetime('now'), ?)`,
  ).run(S, P, title, importance, files === null ? null : JSON.stringify(files), epoch);
}

function handoff() {
  buildAndSaveHandoff(db, S, P, 'exit', null);
  const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = ?`).get(P);
  expect(row, 'premise: a handoff row was written').toBeTruthy();
  return row;
}

describe('key_files: rows with no valid file do not use up the window (D#67)', () => {
  it('reaches real files that sit below ten newer rows contributing nothing', () => {
    prompt('ship the fix');
    for (let i = 0; i < 3; i++) obs({ title: `edit ${i}`, files: [`src/real-${i}.mjs`], epoch: 1_000 + i });
    // Newer rows the JS filter drops entirely: an empty array, a directory, a /tmp path.
    for (let i = 0; i < 4; i++) obs({ title: `empty ${i}`, files: [], epoch: 2_000 + i });
    for (let i = 0; i < 4; i++) obs({ title: `dir ${i}`, files: [`/home/u/proj-${i}`], epoch: 3_000 + i });
    for (let i = 0; i < 4; i++) obs({ title: `tmp ${i}`, files: [`/tmp/x-${i}.txt`], epoch: 4_000 + i });

    const files = JSON.parse(handoff().key_files);
    expect(files.sort()).toEqual(['src/real-0.mjs', 'src/real-1.mjs', 'src/real-2.mjs']);
  });

  it('does not spend the cap on rows that repeat a file already listed', () => {
    prompt('ship the fix');
    for (let i = 0; i < 3; i++) obs({ title: `edit ${i}`, files: [`src/real-${i}.mjs`], epoch: 1_000 + i });
    for (let i = 0; i < 12; i++) obs({ title: `again ${i}`, files: ['src/hot.mjs'], epoch: 2_000 + i });
    const files = JSON.parse(handoff().key_files);
    expect(files.sort()).toEqual(['src/hot.mjs', 'src/real-0.mjs', 'src/real-1.mjs', 'src/real-2.mjs']);
  });

  it('still stops after ten contributing rows, newest first', () => {
    prompt('ship the fix');
    for (let i = 0; i < 12; i++) obs({ title: `edit ${i}`, files: [`src/f-${i}.mjs`], epoch: 1_000 + i });
    const files = JSON.parse(handoff().key_files);
    expect(files.sort()).toEqual([...Array(10)].map((_, k) => `src/f-${k + 2}.mjs`).sort());
  });

  it('breaks a created_at_epoch tie newest-id-first', () => {
    prompt('ship the fix');
    for (let i = 0; i < 12; i++) obs({ title: `edit ${i}`, files: [`src/t-${i}.mjs`], epoch: 1_000 });
    const files = JSON.parse(handoff().key_files);
    expect(files.sort()).toEqual([...Array(10)].map((_, k) => `src/t-${k + 2}.mjs`).sort());
  });
});

describe('completed: a created_at_epoch tie keeps the newest rows (D#67)', () => {
  it('keeps the latest fifteen of eighteen tied rows, newest first', () => {
    prompt('ship the fix');
    for (let i = 0; i < 18; i++) obs({ title: `step ${i}`, epoch: 1_000 });
    const lines = handoff().completed.split('\n');
    expect(lines).toEqual([...Array(15)].map((_, k) => `[change] step ${17 - k}`));
  });
});

describe('carry-forward subject: a created_at_epoch tie picks the newest row (D#67)', () => {
  it('uses the highest id among tied importance-3 rows', () => {
    // The fallback runs only when no prompt carries a subject, so this session's single
    // prompt is a bare continuation word.
    prompt('continue');
    for (let i = 0; i < 3; i++) obs({ title: `subject ${i}`, importance: 3, epoch: 1_000 });
    const row = handoff();
    expect(row.working_on, 'premise: the fallback arm ran').toMatch(/^\(carry-forward subject\)/);
    expect(row.working_on).toBe('(carry-forward subject) subject 2');
  });
});

describe('<session-summary>: a created_at_epoch tie attaches the newest summary', () => {
  function summary(sid, completed, epoch) {
    db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, request, completed, created_at, created_at_epoch)
       VALUES (?, ?, 'req', ?, datetime('now'), ?)`,
    ).run(sid, P, completed, epoch);
  }
  function handoffRow(sid, epoch) {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
       VALUES (?, 'exit', ?, 'work', ?)`,
    ).run(P, sid, epoch);
  }

  it('exact memory_session_id arm', () => {
    const now = Date.now();
    handoffRow(S, now);
    summary(S, 'older turn', now);
    summary(S, 'newer turn', now);
    const out = renderHandoffInjection(db, P);
    expect(out, 'premise: the summary block rendered').toContain('<session-summary');
    expect(out).toContain('newer turn');
    expect(out).not.toContain('older turn');
  });

  it('nearest-in-time fallback arm', () => {
    const now = Date.now();
    handoffRow('cc-uuid-not-a-memory-session-id', now);
    summary(S, 'older summary', now - 5);
    summary(S, 'newer summary', now - 5);
    const out = renderHandoffInjection(db, P);
    expect(out, 'premise: the summary block rendered').toContain('<session-summary');
    expect(out).toContain('newer summary');
    expect(out).not.toContain('older summary');
  });
});
