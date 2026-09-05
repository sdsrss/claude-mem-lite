// SessionStart stdout must be EXACTLY ONE JSON envelope.
//
// hook.mjs session-start had three independent writers on one stdout: the
// startup-dashboard envelope, a raw <claude-mem-context> block, and the
// update banner. The result is a stdout that is not a single JSON document,
// and the observed consequence in a live Claude Code session (2026-08-17) is
// that the envelope is NOT parsed: the session shows
//
//   SessionStart:startup hook success: {"suppressOutput":true,"hookSpecificOutput":{…}}
//
// i.e. the raw JSON — escaped newlines and all — delivered to the model as
// literal text, with suppressOutput:true ignored. The same product's PreToolUse
// and PostToolUse hooks, which emit an envelope and nothing else, render as
// `hook additional context:` with the content extracted. One writer parses,
// three writers do not.
//
// Merging is also strictly safer under the line-based reading of the contract
// (tests/feature-sweep-hooks.test.mjs::expectHookStdout): one envelope on one
// line satisfies both models, mixed output only satisfies one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';

const HOOK_PATH = resolve(import.meta.dirname, '../hook.mjs');
let tmpHome, projDir, dbPath, runtimeDir, env;

// `cwd` defaults to the fixture project. Leaving it unset made the subprocess inherit
// vitest's cwd — the REAL repository — so every dashboard reader that took process.cwd()
// read the host tree instead of the fixture, and the dashboard assertion below passed
// only while the host tree happened to be dirty (2026-08-29 audit MAIN-1).
function runSessionStart(sessionId, extraEnv = {}, cwd = projDir) {
  try {
    return execFileSync(process.execPath, [HOOK_PATH, 'session-start'], {
      input: JSON.stringify({ session_id: sessionId, source: 'startup', cwd: projDir }),
      timeout: 20000,
      encoding: 'utf8',
      cwd,
      env: { ...env, HOME: tmpHome, CLAUDE_PROJECT_DIR: projDir, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    return e.stdout || '';
  }
}

/** The assertion the old shape fails: stdout parses as ONE JSON document. */
function expectSingleEnvelope(stdout) {
  const trimmed = stdout.trim();
  expect(trimmed, 'expected SessionStart to emit something').not.toBe('');
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(
      `SessionStart stdout is not one JSON document — the host falls back to plain text ` +
        `and the envelope reaches the model as raw JSON:\n${stdout.slice(0, 600)}`,
      { cause: e },
    );
  }
  expect(parsed.suppressOutput).toBe(true);
  expect(parsed.hookSpecificOutput?.hookEventName).toBe('SessionStart');
  expect(typeof parsed.hookSpecificOutput?.additionalContext).toBe('string');
  return parsed;
}

function seedObservation(text, title) {
  const db = new Database(dbPath);
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
              VALUES ('seed-cc', 'seed-mem', 'work--fresh', ?, ?, 'active')`,
  ).run(new Date(now).toISOString(), now);
  db.prepare(
    `
    INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts,
                              facts, files_read, files_modified, importance, created_at, created_at_epoch)
    VALUES ('seed-mem', 'work--fresh', ?, 'bugfix', ?, '', '', '', '', '[]', '[]', 3, ?, ?)
  `,
  ).run(text, title, new Date(now).toISOString(), now);
  db.close();
}

/** Give the dashboard a leg of its own that no other stdout contributor can produce. */
function seedEvent(title) {
  const db = new Database(dbPath);
  db.prepare(
    `
    INSERT INTO events (project, event_type, title, body, importance, created_at_epoch)
    VALUES ('work--fresh', 'lesson', ?, '', 1, ?)
  `,
  ).run(title, Date.now());
  db.close();
}

describe('SessionStart stdout envelope', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-ssenv-'));
    projDir = join(tmpHome, 'work', 'fresh');
    mkdirSync(projDir, { recursive: true });
    const dbDir = join(tmpHome, '.claude-mem-lite');
    runtimeDir = join(dbDir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    dbPath = join(dbDir, 'claude-mem-lite.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    db.close();

    env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
    }
    Object.assign(env, {
      CLAUDE_CODE_PATH: join(tmpHome, 'no-such-claude-binary'),
      ANTHROPIC_API_KEY: '',
      OPENROUTER_API_KEY: '',
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
      CLAUDE_MEM_SKIP_COMPRESS: '1',
      CLAUDE_MEM_SKIP_OPTIMIZE: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
      CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
      CLAUDE_MEM_SKIP_REPOS: '1',
      CLAUDE_MEM_NO_DELAY: '1',
      MEM_NO_AUTO_ADOPT: '1',
    });
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('emits one JSON document when the memory block and the dashboard both have content', () => {
    seedObservation(
      'Retry budget was shared across shards so one hot shard starved the rest',
      'Retry budget was shared across shards',
    );
    const stdout = runSessionStart('cc-env-1');
    const parsed = expectSingleEnvelope(stdout);
    // Both surfaces must survive the merge — this is a delivery-channel change,
    // not a content change.
    expect(parsed.hookSpecificOutput.additionalContext).toContain('<claude-mem-context>');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('</claude-mem-context>');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Retry budget was shared across shards');
  });

  it('carries the startup dashboard in the same envelope, not a second write', () => {
    seedObservation('Backoff reset on every redirect hop', 'Backoff reset on every redirect hop');
    // Seed the events leg explicitly. Before MAIN-1 this test rendered a dashboard only
    // by reading the HOST repository's git state; with the subprocess correctly rooted in
    // the fixture there is nothing to report unless the fixture supplies it.
    seedEvent('replay budget exhausted mid-shard');
    const stdout = runSessionStart('cc-env-2');
    const parsed = expectSingleEnvelope(stdout);
    // One document ⇒ exactly one line that parses as JSON.
    const jsonLines = stdout.split('\n').filter((l) => {
      if (!l.trim()) return false;
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonLines).toHaveLength(1);
    // Pin the DASHBOARD leg by content, not by "additionalContext is non-empty":
    // deleting the dashboard push left this green because the <claude-mem-context>
    // block alone satisfied a length check (pre-tag review, SHOULD-FIX-3).
    // `mem events` is the dashboard's own line, absent from the context block.
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/\[mem\] Startup dashboard|mem events:/);
  });

  it('roots the dashboard at the project dir, not at the process cwd', () => {
    // The dashboard's `project` comes from inferProject() (env-derived) while its
    // filesystem root used to come from process.cwd(). Those diverge whenever the hook
    // process was not spawned at the project root, and the dashboard then reports one
    // directory's git/tasks under another directory's project name.
    //
    // Discriminator: readProjectTasks() only accepts a task list whose meta.json
    // `projectPath` equals the root it was handed. Pointing it at projDir while running
    // the subprocess from the repository root makes the two candidates tell different
    // stories — reverting hook.mjs to `projectPath: process.cwd()` drops this task.
    const listDir = join(tmpHome, '.claude', 'tasks', 'list-a');
    mkdirSync(listDir, { recursive: true });
    writeFileSync(join(listDir, 'meta.json'), JSON.stringify({ projectPath: projDir }));
    writeFileSync(
      join(listDir, 't1.json'),
      JSON.stringify({
        id: 't1',
        subject: 'rekey the shard router',
        status: 'in_progress',
      }),
    );

    const repoRoot = resolve(import.meta.dirname, '..');
    const parsed = expectSingleEnvelope(runSessionStart('cc-env-cwd', {}, repoRoot));
    expect(parsed.hookSpecificOutput.additionalContext).toContain('rekey the shard router');
    // Negative half: a task list belonging to the process cwd must NOT leak in.
    const otherDir = join(tmpHome, '.claude', 'tasks', 'list-b');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, 'meta.json'), JSON.stringify({ projectPath: repoRoot }));
    writeFileSync(
      join(otherDir, 't2.json'),
      JSON.stringify({
        id: 't2',
        subject: 'host-tree decoy task',
        status: 'in_progress',
      }),
    );
    const second = expectSingleEnvelope(runSessionStart('cc-env-cwd2', {}, repoRoot));
    expect(second.hookSpecificOutput.additionalContext).toContain('rekey the shard router');
    expect(second.hookSpecificOutput.additionalContext).not.toContain('host-tree decoy task');
  });

  it('folds the update banner in too, instead of appending raw text after the envelope', () => {
    seedObservation('Shard rebalance dropped the last write', 'Shard rebalance dropped the last write');
    writeFileSync(
      join(runtimeDir, 'update-state.json'),
      JSON.stringify({
        lastCheck: new Date().toISOString(),
        latestVersion: '99.0.0',
        updateAvailable: true,
      }),
    );
    const stdout = runSessionStart('cc-env-3', { CLAUDE_MEM_SKIP_UPDATE: '' });
    const parsed = expectSingleEnvelope(stdout);
    // Pin the BANNER leg by content. Asserting only single-envelope-ness left the
    // banner unguarded anywhere in the repo, and the banner is the one contributor
    // v3.70.0 physically relocated — from a raw write at the end of
    // handleSessionStart to a queued part ~90 lines earlier.
    //
    // It rides `systemMessage`, not `additionalContext`: an available-update notice
    // is for the USER, and v3.70.0's merge had made it model-only (content kept,
    // audience lost). Claude Code renders a command hook's top-level systemMessage as
    // its own `hook_system_message`, independently of additionalContext.
    expect(parsed.systemMessage, `banner missing from the human channel:\n${stdout}`).toContain('99.0.0');
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('99.0.0');
  });

  it('stays silent when there is nothing to say (no empty envelope)', () => {
    const stdout = runSessionStart('cc-env-4');
    if (stdout.trim()) {
      // A dashboard line is legitimate on an empty DB; a bare wrapper is not.
      const parsed = expectSingleEnvelope(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).not.toContain('<claude-mem-context>');
    }
  });

  it('never emits a JSON envelope that does not start its own line', () => {
    seedObservation('Cache stampede on cold start', 'Cache stampede on cold start');
    const stdout = runSessionStart('cc-env-5');
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      expect(
        /^[^{].*[{,]\s*"(?:suppressOutput|hookSpecificOutput)"/.test(line),
        `envelope is not at the start of its line:\n${line}`,
      ).toBe(false);
    }
  });
});
