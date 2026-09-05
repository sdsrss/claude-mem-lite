// SessionStart must not inject an EMPTY <claude-mem-context> wrapper.
//
// On a brand-new install every context section is empty, and the hook still wrote
// `<claude-mem-context>\n\n</claude-mem-context>` to stdout — which Claude Code injects
// as a system-reminder. That block costs tokens and, worse, asserts a memory surface and
// then shows nothing: "memory exists and is empty" is a reason NOT to reach for mem_*,
// which is the opposite of what a first-run user needs.
//
// Non-empty output must stay byte-identical, so the second case pins the wrapper's
// presence as soon as there is anything to put in it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';

const HOOK_PATH = resolve(import.meta.dirname, '../hook.mjs');
let tmpHome, projDir, dbPath, env;

function runSessionStart(sessionId) {
  try {
    return execFileSync(process.execPath, [HOOK_PATH, 'session-start'], {
      input: JSON.stringify({ session_id: sessionId, source: 'startup', cwd: projDir }),
      timeout: 20000,
      encoding: 'utf8',
      env: { ...env, HOME: tmpHome, CLAUDE_PROJECT_DIR: projDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    // Hooks exit 0 by contract; return whatever reached stdout so asserts can speak.
    return e.stdout || '';
  }
}

describe('SessionStart <claude-mem-context> wrapper', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-emptyctx-'));
    projDir = join(tmpHome, 'work', 'fresh');
    mkdirSync(projDir, { recursive: true });
    const dbDir = join(tmpHome, '.claude-mem-lite');
    mkdirSync(join(dbDir, 'runtime'), { recursive: true });
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
      CLAUDE_CODE_PATH: join(tmpHome, 'no-such-claude-binary'), // no LLM spend, no network
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

  it('emits no wrapper at all when there is nothing to put in it', () => {
    const stdout = runSessionStart('cc-empty-1');
    expect(stdout).not.toContain('<claude-mem-context>');
    // The startup dashboard is a separate channel (JSON additionalContext) and is
    // allowed to speak; only the empty memory block must be gone.
    expect(stdout).not.toContain('</claude-mem-context>');
  });

  it('still emits the wrapper as soon as there is content', () => {
    const db = new Database(dbPath);
    const now = Date.now();
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
                VALUES ('seed-cc', 'seed-mem', 'work--fresh', ?, ?, 'active')`,
    ).run(new Date(now).toISOString(), now);
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts,
                                facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES ('seed-mem', 'work--fresh', ?, 'bugfix', ?, '', '', '', '', '[]', '[]', 3, ?, ?)
    `,
    ).run(
      'Retry budget was shared across shards so one hot shard starved the rest',
      'Retry budget was shared across shards',
      new Date(now).toISOString(),
      now,
    );
    db.close();

    const stdout = runSessionStart('cc-nonempty-1');
    expect(stdout).toContain('<claude-mem-context>');
    expect(stdout).toContain('</claude-mem-context>');
    expect(stdout).toContain('Retry budget was shared across shards');
  });
});
