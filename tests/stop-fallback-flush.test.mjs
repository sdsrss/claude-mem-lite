// Audit 2026-08-22 P2-9. handleStop has two ways to flush the episode buffer: the
// normal locked path, and — when another hook process holds the lock — a fallback that
// renames the buffer to claim it and saves from there. The fallback was a hand-copy of
// flushEpisodeGroup carrying three comments asserting parity with it, and it was not in
// parity. It now calls flushEpisodeGroup.
//
// Both differences the copy had are observable from outside, so they are tested from
// outside: a real `hook.mjs stop` subprocess with the lock already held by a live PID.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, basename, dirname } from 'path';

const HOOK_PATH = resolve(import.meta.dirname, '../hook.mjs');
const PROJECT_DIRS = [];
let dataDir, cwd, runtimeDir, project;

function episodeName() {
  // inferProject() names a project by its last TWO path segments joined with '--'
  // (/mnt/.../projects/mem -> 'projects--mem'), and the episode buffer is keyed by that
  // name. Deriving it any other way here means writing a buffer the hook never looks for,
  // which reads as "the fallback saved nothing".
  return `${basename(dirname(cwd))}--${basename(cwd)}`;
}

/** Two interleaved CC sessions in one buffer — what planEpisodeFlush splits apart. */
function writeBuffer() {
  // The grouping key is `ccSession` — NOT `ccSessionId`, which is what the hook payload
  // calls it. Spelled the other way, every entry lands in the '__none__' bucket,
  // planEpisodeFlush returns a single group, and the split this file is about silently
  // does not happen while the run still looks successful.
  const entry = (session, file, desc) => ({
    tool: 'Write',
    desc,
    file,
    files: [file],
    ccSession: session,
    isError: false,
    ts: Date.now(),
  });
  writeFileSync(
    join(runtimeDir, `ep-${project}.json`),
    JSON.stringify({
      project,
      sessionId: 'mem-sess',
      entries: [
        entry('cc-one', join(cwd, 'db-schema.sql'), 'Write db-schema.sql'),
        entry('cc-two', join(cwd, 'migrations/002.sql'), 'Write migrations/002.sql'),
      ],
      files: [join(cwd, 'db-schema.sql')],
      filesRead: [],
    }),
  );
}

/** Hold the episode lock with THIS process's live pid: acquireLock cannot steal it. */
function holdLock() {
  writeFileSync(
    join(runtimeDir, `ep-${project}.json.lock`),
    JSON.stringify({ pid: process.pid, ts: Date.now() }),
  );
}

function runStop(extraEnv = {}) {
  return execFileSync(process.execPath, [HOOK_PATH, 'stop'], {
    cwd,
    input: JSON.stringify({ session_id: 'cc-one', hook_event_name: 'Stop' }),
    env: {
      // PWD as well as CLAUDE_PROJECT_DIR: inferProject reads CLAUDE_PROJECT_DIR || PWD ||
      // cwd, and a child spawned with an inherited PWD names the PARENT's project — it
      // then looks for an episode buffer that is not there and does nothing, quietly.
      ...process.env,
      CLAUDE_MEM_DIR: dataDir,
      CLAUDE_PROJECT_DIR: cwd,
      PWD: cwd,
      MEM_QUIET_HOOKS: '1',
      CLAUDE_MEM_SKIP_UPDATE: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 60000,
  });
}

const flushFiles = () => readdirSync(runtimeDir).filter((f) => f.startsWith('ep-flush-'));

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'stop-fallback-'));
  PROJECT_DIRS.push(root);
  dataDir = join(root, 'data');
  cwd = join(root, 'work');
  mkdirSync(join(cwd, 'migrations'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  runtimeDir = join(dataDir, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  project = episodeName();
});

afterEach(() => {
  for (const d of PROJECT_DIRS.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

describe('handleStop lock-contended fallback', () => {
  it('honours CLAUDE_MEM_SKIP_EPISODE_LLM, which the hand-copied version ignored', () => {
    // The copy always spawned llm-episode. Under the skip flag — which exists so a test
    // run does not fire background model calls — a contended Stop still spawned one, and
    // left the ep-flush-* file behind for it.
    writeBuffer();
    holdLock();
    runStop({ CLAUDE_MEM_SKIP_EPISODE_LLM: '1' });

    expect(flushFiles(), 'skip flag set, yet a flush file was left for a worker').toEqual([]);

    // …and the immediate observation is still persisted: the flag suppresses enrichment,
    // never the save. Without this half, deleting the whole fallback would pass the above.
    const db = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
    const rows = db.prepare('SELECT memory_session_id FROM observations').all();
    db.close();
    expect(rows.length, 'the contended fallback persisted nothing').toBeGreaterThan(0);
  });

  it('splits interleaved CC sessions into one observation each, and claims the buffer', () => {
    // v3.35.2's fix, re-asserted through the fallback: two sessions in one buffer must not
    // be co-attributed to a single garbled row.
    writeBuffer();
    holdLock();
    runStop({ CLAUDE_MEM_SKIP_EPISODE_LLM: '1' });

    const db = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
    const titles = db
      .prepare('SELECT title FROM observations ORDER BY id')
      .all()
      .map((r) => r.title);
    db.close();
    // One row per CC session. Merged, the two sessions' work lands in a single garbled
    // observation — the v3.35.2 defect, reachable again through this path.
    expect(titles.length, `expected one observation per CC session, got ${JSON.stringify(titles)}`).toBe(2);
    // Buffer consumed — a claim file left behind means the next fire re-emits this work.
    expect(existsSync(join(runtimeDir, `ep-${project}.json`))).toBe(false);
    expect(readdirSync(runtimeDir).filter((f) => f.includes('.claim-'))).toEqual([]);
  });
});
