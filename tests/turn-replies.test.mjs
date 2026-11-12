// D#825: each turn's last reply, recorded at Stop under the memory session that answered it, so
// the summary worker reads the session's own turns without inferring them from the transcript.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  utimesSync,
} from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import {
  recordTurnReply,
  readTurnReplies,
  turnRepliesPath,
  TURN_REPLIES_PREFIX,
  TURN_REPLY_MAX_CHARS,
} from '../lib/turn-replies.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'turn-replies-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('recordTurnReply / readTurnReplies', () => {
  it('reads back one reply per prompt number, in prompt order', () => {
    recordTurnReply(dir, 'sess-a', 1, 'first turn done');
    recordTurnReply(dir, 'sess-a', 2, 'second turn done');
    expect(readTurnReplies(dir, 'sess-a')).toEqual(['first turn done', 'second turn done']);
  });

  it('a later reply under the same prompt number replaces the earlier one (a notice answered in the same turn)', () => {
    recordTurnReply(dir, 'sess-a', 1, 'started the tests in the background');
    recordTurnReply(dir, 'sess-a', 1, 'tests passed: 12/12');
    expect(readTurnReplies(dir, 'sess-a')).toEqual(['tests passed: 12/12']);
  });

  it('keeps replies given before the first stored prompt as their own turn, first', () => {
    recordTurnReply(dir, 'sess-a', 0, 'background build finished');
    recordTurnReply(dir, 'sess-a', 1, 'fixed the bug');
    expect(readTurnReplies(dir, 'sess-a')).toEqual(['background build finished', 'fixed the bug']);
  });

  it('sorts by prompt number even when written out of order', () => {
    recordTurnReply(dir, 'sess-a', 3, 'three');
    recordTurnReply(dir, 'sess-a', 1, 'one');
    expect(readTurnReplies(dir, 'sess-a')).toEqual(['one', 'three']);
  });

  it('keeps sessions apart', () => {
    recordTurnReply(dir, 'sess-a', 1, 'a');
    recordTurnReply(dir, 'sess-b', 1, 'b');
    expect(readTurnReplies(dir, 'sess-a')).toEqual(['a']);
    expect(readTurnReplies(dir, 'sess-b')).toEqual(['b']);
  });

  it('keeps two long session ids of one project apart (their random suffix is at the end)', () => {
    const project = 'x'.repeat(150);
    recordTurnReply(dir, `hook-${project}-aaaaaaaa`, 1, 'a');
    recordTurnReply(dir, `hook-${project}-bbbbbbbb`, 1, 'b');
    expect(readTurnReplies(dir, `hook-${project}-aaaaaaaa`)).toEqual(['a']);
    expect(readTurnReplies(dir, `hook-${project}-bbbbbbbb`)).toEqual(['b']);
  });

  it('records nothing for an empty or missing reply', () => {
    expect(recordTurnReply(dir, 'sess-a', 1, '   ')).toBe(false);
    expect(recordTurnReply(dir, 'sess-a', 1, null)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(readTurnReplies(dir, 'sess-a')).toEqual([]);
  });

  it('a blank reply does not erase the turn already recorded', () => {
    recordTurnReply(dir, 'sess-a', 1, 'done');
    recordTurnReply(dir, 'sess-a', 1, '');
    expect(readTurnReplies(dir, 'sess-a')).toEqual(['done']);
  });

  it('stores the reply scrubbed', () => {
    const key = 'sk-' + 'ant-api03-' + 'Zx9'.repeat(30);
    recordTurnReply(dir, 'sess-a', 1, `Set the key to ${key} and it works.`);
    const raw = readFileSync(turnRepliesPath(dir, 'sess-a'), 'utf8');
    expect(raw).not.toContain('Zx9Zx9Zx9');
    expect(readTurnReplies(dir, 'sess-a')[0]).not.toContain('Zx9Zx9Zx9');
  });

  it('scrubs before it cuts, so a key across the cut is not half kept', () => {
    const key = 'ghp' + '_' + 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6';
    // The key starts 10 characters before the head cut: cut first, the head would keep
    // `ghp_aB3dE6`, too short for the scrubber to know.
    const head = Math.floor((TURN_REPLY_MAX_CHARS * 2) / 3);
    const reply = 'h'.repeat(head - 11) + ' ' + key + ' ' + 't'.repeat(TURN_REPLY_MAX_CHARS);
    recordTurnReply(dir, 'sess-a', 1, reply);
    const stored = readTurnReplies(dir, 'sess-a')[0];
    expect(stored).not.toContain('aB3dE6');
    expect(stored).toContain(' *** ');
  });

  it(`cuts a reply over ${TURN_REPLY_MAX_CHARS} characters to its head and tail, naming the cut`, () => {
    const reply = 'H'.repeat(TURN_REPLY_MAX_CHARS) + 'T'.repeat(1000);
    recordTurnReply(dir, 'sess-a', 1, reply);
    const stored = readTurnReplies(dir, 'sess-a')[0];
    expect(stored.startsWith('H'.repeat(100))).toBe(true);
    expect(stored.endsWith('T'.repeat(1000))).toBe(true);
    expect(stored).toContain('characters omitted');
    expect(Array.from(stored).length).toBeLessThan(TURN_REPLY_MAX_CHARS + 100);
  });

  it(`leaves a reply of ${TURN_REPLY_MAX_CHARS} characters whole`, () => {
    const reply = 'x'.repeat(TURN_REPLY_MAX_CHARS);
    recordTurnReply(dir, 'sess-a', 1, reply);
    expect(readTurnReplies(dir, 'sess-a')[0]).toBe(reply);
  });

  it('an unreadable file reads as no turns, and the next reply starts it over', () => {
    writeFileSync(turnRepliesPath(dir, 'sess-a'), '{not json');
    expect(readTurnReplies(dir, 'sess-a')).toEqual([]);
    recordTurnReply(dir, 'sess-a', 2, 'two');
    expect(readTurnReplies(dir, 'sess-a')).toEqual(['two']);
  });

  it('a file of another shape reads as no turns', () => {
    writeFileSync(
      turnRepliesPath(dir, 'sess-a'),
      JSON.stringify({ turns: [[1, 5], ['x', 'y'], null, [-1, 'negative'], [1.5, 'fraction']] }),
    );
    expect(readTurnReplies(dir, 'sess-a')).toEqual([]);
  });

  it('writes one private file under the prefix and leaves no temp file', () => {
    recordTurnReply(dir, 'sess-a', 1, 'done');
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    expect(names[0].startsWith(TURN_REPLIES_PREFIX)).toBe(true);
    expect(statSync(join(dir, names[0])).mode & 0o777).toBe(0o600);
  });

  it('a missing runtime dir neither throws nor records', () => {
    const gone = join(dir, 'gone');
    expect(recordTurnReply(gone, 'sess-a', 1, 'done')).toBe(false);
    expect(readTurnReplies(gone, 'sess-a')).toEqual([]);
  });
});

// The runtime sweep SessionStart runs: a record untouched for a day goes with the other per-session
// files; a session's workers read it within minutes of its last Stop.
describe('SessionStart reaps a record older than a day (hook.mjs)', () => {
  const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hook.mjs');
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'turn-replies-hook-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('removes the stale record and keeps the fresh one', () => {
    const home = join(root, 'home');
    const projectDir = join(root, 'work', 'app');
    mkdirSync(projectDir, { recursive: true });
    const runtime = join(home, '.claude-mem-lite', 'runtime');
    mkdirSync(runtime, { recursive: true });
    const db = new Database(join(home, '.claude-mem-lite', 'claude-mem-lite.db'));
    initSchema(db);
    db.close();
    recordTurnReply(runtime, 'sess-old', 1, 'old');
    recordTurnReply(runtime, 'sess-new', 1, 'new');
    const twoDaysAgo = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    utimesSync(turnRepliesPath(runtime, 'sess-old'), twoDaysAgo, twoDaysAgo);
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
      input: JSON.stringify({
        cwd: projectDir,
        session_id: 'cc-gc',
        source: 'startup',
        hook_event_name: 'SessionStart',
      }),
      env,
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(existsSync(turnRepliesPath(runtime, 'sess-old'))).toBe(false);
    expect(existsSync(turnRepliesPath(runtime, 'sess-new'))).toBe(true);
  });
});
