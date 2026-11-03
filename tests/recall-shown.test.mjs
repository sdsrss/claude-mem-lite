// lib/recall-shown.mjs — what one thread has already been shown once (injection budget C1/C3).
//
// The framing header (or the factual arm's line naming the file) and the full cite directive open
// recall block after recall block; a thread needs each once. The plan is a pure function so
// benchmark/injection-budget.mjs can replay recorded blocks through it; the marker is per THREAD
// (same key as the cooldown) and is cleared whenever the main context starts over (not on resume).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import {
  ACK_DIRECTIVE,
  ACK_DIRECTIVE_SHORT,
  RECALL_SHOWN_PREFIX,
  clearRecallShown,
  errorRecallShownPath,
  markErrorRecallShown,
  markRecallShown,
  planRecallBlock,
  readErrorRecallShown,
  readRecallShown,
  recallShownPath,
} from '../lib/recall-shown.mjs';

describe('planRecallBlock', () => {
  const none = { header: false, directive: false };

  it('shows the header and the full directive on a thread’s first block', () => {
    const p = planRecallBlock(none, { header: true, directive: true }, {});
    expect(p).toEqual({ header: true, directive: 'full', next: { header: true, directive: true } });
  });

  it('drops the header and shortens the directive once both were shown', () => {
    const p = planRecallBlock({ header: true, directive: true }, { header: true, directive: true }, {});
    expect(p).toEqual({ header: false, directive: 'short', next: { header: true, directive: true } });
  });

  it('a block without a directive does not mark the directive shown', () => {
    const p = planRecallBlock(none, { header: true, directive: false }, {});
    expect(p.directive).toBeNull();
    expect(p.next).toEqual({ header: true, directive: false });
  });

  it('each switch restores the old behaviour on its own', () => {
    const shown = { header: true, directive: true };
    expect(
      planRecallBlock(shown, { header: true, directive: true }, { CLAUDE_MEM_RECALL_HEADER_ONCE: '0' }),
    ).toMatchObject({
      header: true,
      directive: 'short',
    });
    expect(
      planRecallBlock(shown, { header: true, directive: true }, { CLAUDE_MEM_DIRECTIVE_ONCE: 'off' }),
    ).toMatchObject({
      header: false,
      directive: 'full',
    });
  });

  it('the short directive still carries the tag rule, and is shorter', () => {
    expect(ACK_DIRECTIVE_SHORT).toMatch(/\(#NN\)/);
    expect(ACK_DIRECTIVE_SHORT.length).toBeLessThan(ACK_DIRECTIVE.length / 2);
  });
});

describe('the per-thread marker', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recall-shown-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads empty when absent or unreadable, and round-trips what was marked', () => {
    const p = recallShownPath(dir, 'sess-1');
    expect(p.startsWith(join(dir, RECALL_SHOWN_PREFIX))).toBe(true);
    expect(readRecallShown(p)).toEqual({ header: false, directive: false });
    writeFileSync(p, '{not json');
    expect(readRecallShown(p)).toEqual({ header: false, directive: false });
    markRecallShown(p, { header: true, directive: false });
    expect(readRecallShown(p)).toEqual({ header: true, directive: false });
  });

  it('no session → no marker path (legacy payloads show everything every time)', () => {
    expect(recallShownPath(dir, null)).toBeNull();
    expect(readRecallShown(null)).toEqual({ header: false, directive: false });
    expect(() => markRecallShown(null, { header: true, directive: true })).not.toThrow();
  });

  it('compaction clears the main thread’s marker and leaves a subagent thread’s', () => {
    const main = recallShownPath(dir, 'sess-2');
    const sub = recallShownPath(dir, 'sess-2-agent7');
    markRecallShown(main, { header: true, directive: true });
    markRecallShown(sub, { header: true, directive: true });
    clearRecallShown(dir, 'sess-2');
    expect(existsSync(main)).toBe(false);
    expect(existsSync(sub)).toBe(true);
  });
});

// The hook.mjs half: SessionStart clears the main thread's marker on every source but `resume`, and
// the runtime GC reaps stale ones with the cooldown files. Driven through the real entry point.
describe('SessionStart wiring (hook.mjs)', () => {
  const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hook.mjs');
  let root;
  let home;
  let runtime;
  let projectDir;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'recall-shown-hook-'));
    home = join(root, 'home');
    projectDir = join(root, 'work', 'app');
    mkdirSync(projectDir, { recursive: true });
    runtime = join(home, '.claude-mem-lite', 'runtime');
    mkdirSync(runtime, { recursive: true });
    const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'));
    initSchema(db);
    db.close();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const start = (sid, source) => {
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PID: '',
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_COMPRESS: '1',
      CLAUDE_MEM_SKIP_OPTIMIZE: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
      CLAUDE_MEM_SKIP_SUMMARY: '1',
      CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
      MEM_NO_AUTO_ADOPT: '1',
    };
    delete env.CLAUDE_MEM_HOOK_RUNNING;
    delete env.CLAUDE_MEM_DIR;
    execFileSync(process.execPath, [HOOK, 'session-start'], {
      input: JSON.stringify({ cwd: projectDir, session_id: sid, source, hook_event_name: 'SessionStart' }),
      env,
      encoding: 'utf8',
      timeout: 20000,
    });
  };

  // R3 O3 made compaction the only in-session reset of the error-recall marker (review L6).
  it('compact deletes the error-recall marker; resume keeps it', () => {
    const err = errorRecallShownPath(runtime, 'sess-e');
    markErrorRecallShown(err, new Map(), [7]);
    start('sess-e', 'resume');
    expect(readErrorRecallShown(err).has('7'), 'resume keeps what the thread was shown').toBe(true);
    start('sess-e', 'compact');
    expect(existsSync(err)).toBe(false);
  });

  it('compact and startup clear the main thread; resume keeps it; a subagent thread survives', () => {
    const main = recallShownPath(runtime, 'sess-c');
    const sub = recallShownPath(runtime, 'sess-c-agent1');
    markRecallShown(main, { header: true, directive: true });
    markRecallShown(sub, { header: true, directive: true });
    start('sess-c', 'resume');
    expect(existsSync(main)).toBe(true);
    start('sess-c', 'compact');
    expect(existsSync(main)).toBe(false);
    markRecallShown(main, { header: true, directive: true });
    start('sess-c', 'startup');
    expect(existsSync(main)).toBe(false);
    expect(existsSync(sub)).toBe(true);
  });

  it('the runtime GC reaps a marker older than a day', () => {
    const stale = recallShownPath(runtime, 'sess-old');
    const fresh = recallShownPath(runtime, 'sess-new');
    markRecallShown(stale, { header: true, directive: false });
    markRecallShown(fresh, { header: true, directive: false });
    const twoDaysAgo = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    utimesSync(stale, twoDaysAgo, twoDaysAgo);
    start('sess-gc', 'startup');
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

// R3 O3 (docs/audits/20261103-r3-optimization-plan.md): the 30-minute window let one memory back
// into the same thread — 71 (session, id) pairs were shown 3+ times, up to 11, on 194 transcripts.
// The thread holds the first copy until compaction, and SessionStart `compact` deletes the marker.
describe('error-recall marker: one showing per thread until compaction', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mem-errshown-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const MIN = 60 * 1000;

  it('an id shown 31 minutes or a day ago still counts as shown by default', () => {
    const p = errorRecallShownPath(dir, 'sess-a');
    const t0 = 1_000_000_000_000;
    markErrorRecallShown(p, new Map(), [7, 8], t0);
    expect([...readErrorRecallShown(p, t0 + 31 * MIN, {}).keys()].sort()).toEqual(['7', '8']);
    expect(readErrorRecallShown(p, t0 + 25 * 60 * MIN, {}).has('7')).toBe(true);
  });

  it('CLAUDE_MEM_ERROR_RECALL_REPEAT_MIN restores a time window (30 = the old behaviour)', () => {
    const p = errorRecallShownPath(dir, 'sess-b');
    const t0 = 1_000_000_000_000;
    markErrorRecallShown(p, new Map(), [7], t0);
    const env = { CLAUDE_MEM_ERROR_RECALL_REPEAT_MIN: '30' };
    expect(readErrorRecallShown(p, t0 + 29 * MIN, env).has('7')).toBe(true);
    expect(readErrorRecallShown(p, t0 + 31 * MIN, env).has('7')).toBe(false);
  });

  it('a value that is not a positive number keeps the whole-thread default', () => {
    const p = errorRecallShownPath(dir, 'sess-c');
    const t0 = 1_000_000_000_000;
    markErrorRecallShown(p, new Map(), [7], t0);
    for (const v of ['0', '-5', 'abc', '']) {
      expect(
        readErrorRecallShown(p, t0 + 31 * MIN, { CLAUDE_MEM_ERROR_RECALL_REPEAT_MIN: v }).has('7'),
        v,
      ).toBe(true);
    }
  });
});
