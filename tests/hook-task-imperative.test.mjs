// tests/hook-task-imperative.test.mjs
// Phase-2 task-imperative injection (spec 2026-06-29 §4.1/§4.3/§9).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';
import { selectImperativeLesson } from '../hook-memory.mjs';

describe('selectImperativeLesson (Phase-2 gate)', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertSession(db, { id: 'imp-sess', project: 'p' });
  });
  afterEach(() => db.close());
  const seed = (o) => insertObs(db, { sessionId: 'imp-sess', project: 'p', ...o });

  it('returns the importance>=2 lesson whose identifiers overlap the prompt', () => {
    seed({ title: 'RRF merge fix', lessonLearned: 'use rrfMerge not naive union for fusion', importance: 2 });
    const pick = selectImperativeLesson(db, 'about to touch rrfMerge in tfidf', 'p');
    expect(pick).not.toBeNull();
    expect(pick.lesson_learned).toBe('use rrfMerge not naive union for fusion');
  });
  it('excludes importance<2 lessons', () => {
    seed({ title: 'low', lessonLearned: 'keep rrfMerge stable', importance: 1 });
    expect(selectImperativeLesson(db, 'editing rrfMerge', 'p')).toBeNull();
  });
  it('excludes empty / "none" lesson_learned', () => {
    seed({ title: 'no lesson', lessonLearned: '', importance: 3 });
    seed({ title: 'none lesson', lessonLearned: 'none', importance: 3 });
    expect(selectImperativeLesson(db, 'touch rrfMerge', 'p')).toBeNull();
  });
  it('returns null when no lesson identifier overlaps the prompt', () => {
    seed({ title: 'unrelated', lessonLearned: 'always call recoverChildrenOf first', importance: 3 });
    expect(selectImperativeLesson(db, 'plain english prompt no symbols', 'p')).toBeNull();
  });
  it('returns null when the prompt has no extractable identifiers', () => {
    seed({ title: 'x', lessonLearned: 'use rrfMerge here', importance: 3 });
    expect(selectImperativeLesson(db, 'fix the thing please', 'p')).toBeNull();
  });
  it('picks highest importance*overlap (top-1)', () => {
    seed({ title: 'a', lessonLearned: 'touch rrfMerge carefully', importance: 2 });
    seed({ title: 'b', lessonLearned: 'rrfMerge and rrfFuseN must agree', importance: 3 });
    expect(selectImperativeLesson(db, 'editing rrfMerge today', 'p').lesson_learned).toBe(
      'rrfMerge and rrfFuseN must agree',
    );
  });
  it('respects excludeIds (no double-injection with the context block)', () => {
    seed({ title: 'a', lessonLearned: 'use rrfMerge not union', importance: 3 });
    const first = selectImperativeLesson(db, 'editing rrfMerge', 'p');
    expect(first).not.toBeNull();
    expect(selectImperativeLesson(db, 'editing rrfMerge', 'p', [first.id])).toBeNull();
  });
});

const HOOK_PATH = resolve(new URL('..', import.meta.url).pathname, 'hook.mjs');

describe('hook.mjs UserPromptSubmit task-imperative wiring (default off)', () => {
  let tmpHome, projDir;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-task-imp-'));
    projDir = join(tmpHome, 'proj', 'mem');
    mkdirSync(projDir, { recursive: true });
  });
  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function initHomeDb() {
    const dbDir = join(tmpHome, '.claude-mem-lite');
    mkdirSync(join(dbDir, 'runtime'), { recursive: true });
    const db = new Database(join(dbDir, 'claude-mem-lite.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    return db;
  }
  function runUserPrompt(stdin, extraEnv = {}) {
    try {
      const stdout = execFileSync(process.execPath, [HOOK_PATH, 'user-prompt'], {
        input: stdin,
        timeout: 10000,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: tmpHome,
          CLAUDE_PROJECT_DIR: projDir,
          CLAUDE_MEM_SKIP_UPDATE: '1',
          CLAUDE_MEM_SKIP_COMPRESS: '1',
          CLAUDE_MEM_SKIP_OPTIMIZE: '1',
          MEM_NO_AUTO_ADOPT: '1',
          MEM_QUIET_HOOKS: '1',
          CLAUDE_MEM_HOOK_RUNNING: undefined,
          CLAUDE_MEM_TASK_IMPERATIVE: undefined,
          ...extraEnv,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { stdout, exitCode: 0 };
    } catch (e) {
      return { stdout: e.stdout?.toString() || '', exitCode: e.status ?? 1 };
    }
  }
  const seedLesson = () => {
    const db = initHomeDb();
    insertSession(db, { id: 'cc-imp', project: 'proj--mem' });
    insertObs(db, {
      sessionId: 'cc-imp',
      project: 'proj--mem',
      type: 'bugfix',
      title: 'recoverChildrenOf ordering',
      text: 'recover children before delete',
      lessonLearned: 'always call recoverChildrenOf before hard delete',
      importance: 3,
    });
    db.close();
  };
  const stdin = JSON.stringify({ prompt: 'about to edit recoverChildrenOf now', session_id: 'cc-imp' });

  it('flag OFF (default): no imperative line', () => {
    seedLesson();
    const out = runUserPrompt(stdin);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).not.toContain('You must:');
  });
  it('flag ON: emits the imperative line for an overlapping high-value lesson', () => {
    seedLesson();
    const out = runUserPrompt(stdin, { CLAUDE_MEM_TASK_IMPERATIVE: 'on' });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(
      'Memory — a past lesson applies to THIS task. You must: always call recoverChildrenOf before hard delete.',
    );
  });
});
