// hook-handoff read git state and the task list from process.cwd() while the handoff row
// is keyed by inferProject() (CLAUDE_PROJECT_DIR). project-utils.mjs documents that the two
// "happen to coincide" in production, but they do not once a session has `cd`'d: a session
// in repo A that had cd'd into ~/.claude stamped A's handoff with ~/.claude's branch and
// HEAD sha (`master @ c6ce620` on a repo whose branch is `main`). The wrong sha then also
// breaks the Stage -1 git anchor in detectContinuationIntent, which compares against it.
//
// With the session's cwd outside the project, all four readers must use the project root;
// each case below fails if its site goes back to process.cwd(). The paused note is read through lib/paused-reader.mjs's default path,
// which the test guard neutralises, so that case turns the guard off for itself.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { createTestDb } from './test-helpers.mjs';
import { buildAndSaveHandoff, detectContinuationIntent } from '../hook-handoff.mjs';
import * as gitStateModule from '../lib/git-state.mjs';
import * as taskReaderModule from '../lib/task-reader.mjs';

const PROJECT = 'pd-proj';
const SESSION = 'hook-pd-proj-1234abcd';
// Any directory that is not process.cwd(); the spies mean nothing touches it.
const PROJECT_DIR = join(tmpdir(), 'cml-handoff-project-root');

let db;
let savedProjectDir;
let gitSpy;
let taskSpy;

beforeEach(() => {
  savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
  gitSpy = vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
    changed: [],
    stashes: [],
    branch: 'main',
    headSha: 'deadbeef1234',
  });
  taskSpy = vi.spyOn(taskReaderModule, 'readProjectTasks').mockReturnValue([]);
  db = createTestDb();
});

afterEach(() => {
  if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  vi.restoreAllMocks();
  db.close();
});

function seed() {
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
     VALUES (?, ?, ?, datetime('now'), ?, 'active')`,
  ).run(SESSION, SESSION, PROJECT, 1000);
  db.prepare(
    `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
     VALUES (?, ?, 1, datetime('now'), ?)`,
  ).run(SESSION, 'work on the ranker', 1000);
}

describe('handoff reads the project root, not the process cwd', () => {
  it('precondition: the project root differs from process.cwd()', () => {
    expect(PROJECT_DIR).not.toBe(process.cwd());
  });

  it('buildAndSaveHandoff reads git state from CLAUDE_PROJECT_DIR', () => {
    seed();
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    expect(gitSpy).toHaveBeenCalled();
    for (const [options] of gitSpy.mock.calls) expect(options).toEqual({ cwd: PROJECT_DIR });
  });

  it('buildAndSaveHandoff reads the task list from CLAUDE_PROJECT_DIR', () => {
    seed();
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    expect(taskSpy).toHaveBeenCalled();
    for (const [options] of taskSpy.mock.calls) expect(options).toEqual({ projectPath: PROJECT_DIR });
  });

  it('detectContinuationIntent compares HEAD from CLAUDE_PROJECT_DIR', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, git_sha_at_handoff, match_keywords, working_on, created_at_epoch)
       VALUES (?, 'exit', 'sess-prev', 'deadbeef1234', 'ranker', 'ranker work', ?)`,
    ).run(PROJECT, Date.now());
    detectContinuationIntent(db, 'ok thanks', PROJECT, 'sess-next');
    expect(gitSpy).toHaveBeenCalled();
    for (const [options] of gitSpy.mock.calls) expect(options).toEqual({ cwd: PROJECT_DIR });
  });

  it('buildAndSaveHandoff reads the paused note from CLAUDE_PROJECT_DIR', () => {
    const root = mkdtempSync(join(tmpdir(), 'cml-handoff-paused-'));
    const savedGuard = process.env.CLAUDE_MEM_TEST_GUARD;
    try {
      mkdirSync(join(root, 'tasks'));
      const note = ['# Paused — ranker', '', '## Not done', '', '- finish the ranker', ''].join('\n');
      writeFileSync(join(root, 'tasks', 'ranker-paused.md'), note);
      process.env.CLAUDE_PROJECT_DIR = root;
      delete process.env.CLAUDE_MEM_TEST_GUARD;
      seed();
      buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
      const row = db
        .prepare(`SELECT next_steps FROM session_handoffs WHERE project = ? AND type = 'exit'`)
        .get(PROJECT);
      expect(JSON.parse(row.next_steps).file).toBe('tasks/ranker-paused.md');
    } finally {
      if (savedGuard === undefined) delete process.env.CLAUDE_MEM_TEST_GUARD;
      else process.env.CLAUDE_MEM_TEST_GUARD = savedGuard;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// EnterWorktree moves the session into <project>/.claude/worktrees/<name> while
// CLAUDE_PROJECT_DIR stays the main checkout (probed 2026-11-28: a hook dumping its env after
// EnterWorktree saw cwd, PWD and stdin cwd in the worktree, CLAUDE_PROJECT_DIR at the main
// checkout). The worktree's branch is the one the session works on, so git state comes from a
// cwd INSIDE the project; a cwd outside it (the cases above) still reads the project root.
// The task list and the paused note stay at the project root either way.
describe('handoff reads git state from a working directory inside the project', () => {
  let root;
  let worktree;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cml-handoff-wt-')));
    worktree = join(root, '.claude', 'worktrees', 'w1');
    mkdirSync(worktree, { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = root;
    vi.spyOn(process, 'cwd').mockReturnValue(worktree);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('buildAndSaveHandoff reads git state from the worktree, the task list from the root', () => {
    seed();
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    expect(gitSpy).toHaveBeenCalled();
    for (const [options] of gitSpy.mock.calls) expect(options).toEqual({ cwd: worktree });
    expect(taskSpy).toHaveBeenCalled();
    for (const [options] of taskSpy.mock.calls) expect(options).toEqual({ projectPath: root });
  });

  it('detectContinuationIntent compares HEAD from the worktree', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, git_sha_at_handoff, match_keywords, working_on, created_at_epoch)
       VALUES (?, 'exit', 'sess-prev', 'deadbeef1234', 'ranker', 'ranker work', ?)`,
    ).run(PROJECT, Date.now());
    detectContinuationIntent(db, 'ok thanks', PROJECT, 'sess-next');
    expect(gitSpy).toHaveBeenCalled();
    for (const [options] of gitSpy.mock.calls) expect(options).toEqual({ cwd: worktree });
  });

  it('a sibling directory whose name starts with the root is outside, so the root is read', () => {
    const sibling = `${root}-other`;
    mkdirSync(sibling, { recursive: true });
    try {
      process.cwd.mockReturnValue(sibling);
      seed();
      buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
      for (const [options] of gitSpy.mock.calls) expect(options).toEqual({ cwd: root });
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});
