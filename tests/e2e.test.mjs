// E2E test suite for claude-mem-lite hook lifecycle
// Tests the actual CLI entry point (node hook.mjs <event>) as a subprocess
// Isolation via HOME env var → redirects ~/.claude-mem-lite/ to temp dir

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { computeMinHash } from '../utils.mjs';
import { initSchema } from '../schema.mjs';
import { saveEvent } from '../lib/activity.mjs';

const HOOK_PATH = resolve('hook.mjs');
const MOCK_CLAUDE = resolve('scripts/mock-claude.mjs');

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-e2e-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initTestDb(tmpHome) {
  const dbDir = join(tmpHome, '.claude-mem-lite');
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(join(dbDir, 'runtime'), { recursive: true });

  const dbPath = join(dbDir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');

  // Single source of truth: reuse initSchema from schema.mjs
  initSchema(db);

  db.close();
  return dbPath;
}

function openTestDb(tmpHome) {
  const dbPath = join(tmpHome, '.claude-mem-lite', 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  return db;
}

function runHook(event, { stdin, env = {}, args = [] } = {}) {
  const mergedEnv = {
    ...process.env,
    HOME: env.HOME || process.env.HOME,
    CLAUDE_PROJECT_DIR: env.CLAUDE_PROJECT_DIR || projectDir,
    CLAUDE_CODE_PATH: env.CLAUDE_CODE_PATH || MOCK_CLAUDE,
    // These e2e tests drive the LLM through MOCK_CLAUDE (cli mode). The dev/CI
    // shell may export real ANTHROPIC_API_KEY / OPENROUTER_API_KEY, which would
    // flip detectMode() to api/openrouter and bypass the mock with a live
    // network call. Clear both by default (deleted below); a test that wants an
    // API path can still set them via the `env` arg, which is spread last.
    ANTHROPIC_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
    CLAUDE_MEM_HOOK_RUNNING: undefined, // Don't inherit — let hooks run
    CLAUDE_MEM_DEBUG: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1', // Skip auto-update network calls in tests
    CLAUDE_MEM_SKIP_COMPRESS: '1', // Skip auto-compress background spawn (tests call it explicitly)
    CLAUDE_MEM_SKIP_OPTIMIZE: '1', // Skip llm-optimize background worker in tests
    CLAUDE_MEM_SKIP_MAINTAIN: '1', // Skip auto-maintain background spawn (tests call it explicitly)
    ...env,
  };

  // Remove undefined keys
  for (const k of Object.keys(mergedEnv)) {
    if (mergedEnv[k] === undefined) delete mergedEnv[k];
  }

  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH, event, ...args], {
      input: stdin || '',
      timeout: 15000,
      encoding: 'utf8',
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() || '',
      stderr: e.stderr?.toString() || '',
      exitCode: e.status ?? 1,
    };
  }
}

function makeToolPayload(toolName, input, response) {
  return JSON.stringify({ tool_name: toolName, tool_input: input, tool_response: response });
}

// G13: parse every metric row written under this test's isolated HOME.
// recordMetric targets join(RUNTIME_DIR, '..') → tmpHome/.claude-mem-lite/metrics/.
function readMetricRows(tmpHome) {
  const dir = join(tmpHome, '.claude-mem-lite', 'metrics');
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip malformed */
      }
    }
  }
  return rows;
}

function getSessionFile(tmpHome) {
  const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
  const files = readdirSync(runtimeDir).filter((f) => f.startsWith('session-'));
  return files.length > 0 ? join(runtimeDir, files[0]) : null;
}

function getSessionIdFromFile(tmpHome) {
  const sf = getSessionFile(tmpHome);
  if (!sf) return null;
  try {
    return JSON.parse(readFileSync(sf, 'utf8')).id;
  } catch {
    return null;
  }
}

function getEpisodeFile(tmpHome) {
  const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
  const files = readdirSync(runtimeDir).filter(
    (f) => f.startsWith('ep-') && f.endsWith('.json') && !f.startsWith('ep-flush-'),
  );
  return files.length > 0 ? join(runtimeDir, files[0]) : null;
}

function getFlushFiles(tmpHome) {
  const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
  return readdirSync(runtimeDir).filter((f) => f.startsWith('ep-flush-'));
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

let tmpHome;
let projectDir;

beforeEach(() => {
  tmpHome = makeTmpDir();
  projectDir = join(tmpHome, 'parent', 'testproj');
  mkdirSync(projectDir, { recursive: true });
  initTestDb(tmpHome);
});

afterEach(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

describe('Suite 1: Full Session Lifecycle', () => {
  it('disabled plugin setting makes session-start exit without side effects', () => {
    const settingsDir = join(tmpHome, '.claude');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, 'settings.json'),
      JSON.stringify(
        {
          enabledPlugins: { 'claude-mem-lite@sdsrss': false },
          hooks: {
            SessionStart: [
              { matcher: '*', hooks: [{ type: 'command', command: `node "${HOOK_PATH}" session-start` }] },
            ],
          },
        },
        null,
        2,
      ),
    );

    const { stdout, exitCode } = runHook('session-start', { env: { HOME: tmpHome } });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(getSessionFile(tmpHome)).toBeNull();

    const db = openTestDb(tmpHome);
    const sessions = db.prepare('SELECT COUNT(*) as c FROM sdk_sessions').get();
    db.close();
    expect(sessions.c).toBe(0);
  });

  it('session-start creates session row (and skips the context wrapper when empty)', () => {
    const { stdout, exitCode } = runHook('session-start', { env: { HOME: tmpHome } });
    expect(exitCode).toBe(0);
    // This fixture's DB holds no observations/summaries, so there is no context body.
    // The hook now omits the wrapper rather than injecting an empty
    // `<claude-mem-context></claude-mem-context>` pair — see
    // tests/session-start-empty-context.test.mjs for the populated counterpart.
    expect(stdout).not.toContain('<claude-mem-context>');

    // Session file created
    const sf = getSessionFile(tmpHome);
    expect(sf).not.toBeNull();

    // Session row in DB
    const db = openTestDb(tmpHome);
    const rows = db.prepare('SELECT * FROM sdk_sessions').all();
    db.close();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].project).toContain('testproj');
  });

  it('post-tool-use (Edit) creates episode buffer file', () => {
    // Start session first
    runHook('session-start', { env: { HOME: tmpHome } });

    const payload = makeToolPayload(
      'Edit',
      {
        file_path: '/tmp/src/index.js',
        old_string: 'foo',
        new_string: 'bar',
      },
      'OK — edited file',
    );

    const { exitCode } = runHook('post-tool-use', {
      stdin: payload,
      env: { HOME: tmpHome },
    });
    expect(exitCode).toBe(0);

    // Episode file should exist
    const epFile = getEpisodeFile(tmpHome);
    expect(epFile).not.toBeNull();

    const episode = JSON.parse(readFileSync(epFile, 'utf8'));
    expect(episode.entries.length).toBe(1);
    expect(episode.entries[0].tool).toBe('Edit');
    expect(episode.files).toContain('/tmp/src/index.js');
  });

  it('multiple post-tool-use entries accumulate in episode', () => {
    runHook('session-start', { env: { HOME: tmpHome } });

    // Three related edits to the same file
    for (let i = 0; i < 3; i++) {
      runHook('post-tool-use', {
        stdin: makeToolPayload(
          'Edit',
          {
            file_path: '/tmp/src/index.js',
            old_string: `old${i}`,
            new_string: `new${i}`,
          },
          'OK — edited file',
        ),
        env: { HOME: tmpHome },
      });
    }

    const epFile = getEpisodeFile(tmpHome);
    expect(epFile).not.toBeNull();
    const episode = JSON.parse(readFileSync(epFile, 'utf8'));
    expect(episode.entries.length).toBe(3);
  });

  it('stop flushes episode and marks session completed', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Add some entries
    runHook('post-tool-use', {
      stdin: makeToolPayload(
        'Edit',
        {
          file_path: '/tmp/src/app.js',
          old_string: 'a',
          new_string: 'b',
        },
        'OK — edited file',
      ),
      env: { HOME: tmpHome },
    });

    const { stdout, exitCode } = runHook('stop', { env: { HOME: tmpHome } });
    expect(exitCode).toBe(0);

    // v2.33.4: CC's Stop schema forbids hookSpecificOutput entirely (only
    // PreToolUse/UserPromptSubmit/PostToolUse/SessionStart accept it). The
    // Stop hook must NOT emit a receipt JSON — prior versions (v2.33.3) just
    // tagged hookEventName='Stop' and still triggered "Invalid input".
    if (stdout && stdout.trim()) {
      const parsed = JSON.parse(stdout.trim());
      expect(parsed?.hookSpecificOutput).toBeUndefined();
    }

    // Session marked completed
    const db = openTestDb(tmpHome);
    const sess = db.prepare('SELECT status FROM sdk_sessions WHERE content_session_id = ?').get(sessionId);
    db.close();
    expect(sess.status).toBe('completed');

    // Episode file should be gone (flushed)
    const epFile = getEpisodeFile(tmpHome);
    expect(epFile).toBeNull();

    // Session file should be cleaned up
    const sf = getSessionFile(tmpHome);
    expect(sf).toBeNull();
  });

  it('full cycle: start → tool-use ×3 → stop → verify DB', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Three edits
    for (let i = 0; i < 3; i++) {
      runHook('post-tool-use', {
        stdin: makeToolPayload(
          'Edit',
          {
            file_path: `/tmp/src/file${i}.js`,
            old_string: 'old',
            new_string: 'new',
          },
          'OK — edited file',
        ),
        env: { HOME: tmpHome },
      });
    }

    runHook('stop', { env: { HOME: tmpHome } });

    // DB should have: 1 session (completed), flush file created
    const db = openTestDb(tmpHome);
    const sess = db.prepare('SELECT * FROM sdk_sessions WHERE content_session_id = ?').get(sessionId);
    expect(sess.status).toBe('completed');
    expect(sess.completed_at).not.toBeNull();

    // Flush file should have been created (background worker not actually running in test)
    const flushFiles = getFlushFiles(tmpHome);
    expect(flushFiles.length).toBeGreaterThanOrEqual(1);

    db.close();
  });
});

describe('Suite 2: Episode Buffer Management', () => {
  it('buffer flushes at 10 entries', () => {
    runHook('session-start', { env: { HOME: tmpHome } });

    // Send 11 entries to the same file (10 = buffer full → flush)
    for (let i = 0; i < 11; i++) {
      runHook('post-tool-use', {
        stdin: makeToolPayload(
          'Edit',
          {
            file_path: '/tmp/src/big.js',
            old_string: `line${i}`,
            new_string: `fixed${i}`,
          },
          'OK — edited file',
        ),
        env: { HOME: tmpHome },
      });
    }

    // A flush file should have been created
    const flushFiles = getFlushFiles(tmpHome);
    expect(flushFiles.length).toBeGreaterThanOrEqual(1);

    // Current episode buffer should have the overflow entries
    const epFile = getEpisodeFile(tmpHome);
    if (epFile) {
      const episode = JSON.parse(readFileSync(epFile, 'utf8'));
      // The 11th entry starts a new episode after the 10-entry flush
      expect(episode.entries.length).toBeLessThanOrEqual(2);
    }
  });

  it('tags episode entries with the CC session_id', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    runHook('post-tool-use', {
      stdin: JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/src/tag.js', old_string: 'a', new_string: 'b' },
        tool_response: 'OK — edited file',
        session_id: 'cc-sess-A',
      }),
      env: { HOME: tmpHome },
    });
    const epFile = getEpisodeFile(tmpHome);
    expect(epFile).not.toBeNull();
    const episode = JSON.parse(readFileSync(epFile, 'utf8'));
    expect(episode.entries[0].ccSession).toBe('cc-sess-A');
  });

  it('two concurrent sessions in one buffer flush as separate observations', () => {
    // CLAUDE_MEM_SKIP_EPISODE_LLM disables the detached llm-episode enrichment
    // spawn so the assertion sees only the synchronous immediate observations
    // (sibling of CLAUDE_MEM_SKIP_COMPRESS / _OPTIMIZE). CLAUDE_MEM_KEEP_LOW_SIGNAL
    // stops the noise gate from dropping the trivial "Modified shared.js" change
    // obs — orthogonal to grouping (merged→1, split→2, so toBe(2) still tests it).
    const env = { HOME: tmpHome, CLAUDE_MEM_SKIP_EPISODE_LLM: '1', CLAUDE_MEM_KEEP_LOW_SIGNAL: '1' };
    runHook('session-start', { env });
    // Two sessions, DIFFERENT files: the buffer's 2-entry window (phase-transition
    // only fires at entries.length >= 2) keeps both in ONE buffer, and distinct
    // files give distinct obs titles so they aren't fuzzy-deduped into one. The
    // split must therefore happen at flush (planEpisodeFlush), not via transition.
    for (const [sid, file] of [
      ['cc-A', '/tmp/src/alpha.js'],
      ['cc-B', '/tmp/src/beta.js'],
    ]) {
      runHook('post-tool-use', {
        stdin: JSON.stringify({
          tool_name: 'Edit',
          tool_input: { file_path: file, old_string: 'x', new_string: 'y' },
          tool_response: 'OK — edited file',
          session_id: sid,
        }),
        env,
      });
    }
    // SessionStart(clear) flushes the leftover 2-session buffer; its receipt
    // aggregates over the WHOLE episode (both sessions' entries), gated by
    // anySignificant && RECEIPT_EVENTS — spec §4 #7.
    const { stdout } = runHook('session-start', { stdin: JSON.stringify({ source: 'clear' }), env });
    expect(stdout).toMatch(/\[mem\] episode flushed: 2 entries/); // aggregate receipt, no throw

    const db = openTestDb(tmpHome);
    try {
      const n = db.prepare('SELECT COUNT(*) c FROM observations').get().c;
      expect(n).toBe(2); // one immediate observation per session group
    } finally {
      db.close();
    }
  });

  it('mixed significance: only the significant session-group produces an observation', () => {
    // spec §4 #3. Session A does an Edit (significant); session B a benign Bash
    // (no edit/error/build/test → insignificant). Both share one buffer (2-entry
    // window), so the per-group significance gate in flushEpisodeGroup must drop
    // B's group while saving A's.
    const env = { HOME: tmpHome, CLAUDE_MEM_SKIP_EPISODE_LLM: '1', CLAUDE_MEM_KEEP_LOW_SIGNAL: '1' };
    runHook('session-start', { env });
    runHook('post-tool-use', {
      stdin: JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/src/gamma.js', old_string: 'x', new_string: 'y' },
        tool_response: 'OK — edited file',
        session_id: 'cc-A',
      }),
      env,
    });
    runHook('post-tool-use', {
      stdin: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
        tool_response: '/home/user/project/subdir',
        session_id: 'cc-B',
      }),
      env,
    });
    runHook('session-start', { stdin: JSON.stringify({ source: 'clear' }), env });
    const db = openTestDb(tmpHome);
    try {
      expect(db.prepare('SELECT COUNT(*) c FROM observations').get().c).toBe(1);
    } finally {
      db.close();
    }
  });

  it('same-file concurrent sessions dedupe to one un-mixed observation (accepted limitation)', () => {
    // spec §5 residual (honesty pin): when both sessions edit the SAME file, the
    // two per-session immediate obs share the title "Modified same.js" and the
    // Tier-1 Jaccard dedup collapses them to one. The win over the base bug holds
    // — the survivor is ONE session's activity, not an A+B merged narrative — but
    // "each session its own obs" is NOT achieved for the file-related case.
    const env = { HOME: tmpHome, CLAUDE_MEM_SKIP_EPISODE_LLM: '1', CLAUDE_MEM_KEEP_LOW_SIGNAL: '1' };
    runHook('session-start', { env });
    for (const sid of ['cc-A', 'cc-B']) {
      runHook('post-tool-use', {
        stdin: JSON.stringify({
          tool_name: 'Edit',
          tool_input: { file_path: '/tmp/src/same.js', old_string: sid, new_string: sid + '!' },
          tool_response: 'OK — edited file',
          session_id: sid,
        }),
        env,
      });
    }
    runHook('session-start', { stdin: JSON.stringify({ source: 'clear' }), env });
    const db = openTestDb(tmpHome);
    try {
      expect(db.prepare('SELECT COUNT(*) c FROM observations').get().c).toBe(1); // deduped, not 2
    } finally {
      db.close();
    }
  });

  it('PostToolUse flush emits receipt JSON with correct event tag', () => {
    // v2.33.5: positive test for the PostToolUse receipt emission path.
    // Complements the Stop-must-not-emit assertion above — if a future edit
    // over-broadens the RECEIPT_EVENTS guard and drops PostToolUse too, this
    // test fails loudly instead of silently swallowing the happy-path emission.
    runHook('session-start', { env: { HOME: tmpHome } });

    // EPISODE_BUFFER_SIZE = 10. The bufferFull check runs BEFORE the new
    // entry is appended, so the 11th call (when episode already holds 10)
    // is the one that triggers flushEpisode → receipt stdout.
    let flushStdout = '';
    for (let i = 0; i < 11; i++) {
      const { stdout } = runHook('post-tool-use', {
        stdin: makeToolPayload(
          'Edit',
          {
            file_path: '/tmp/src/receipt.js',
            old_string: `old${i}`,
            new_string: `new${i}`,
          },
          'OK — edited file',
        ),
        env: { HOME: tmpHome },
      });
      if (stdout && stdout.includes('episode flushed')) flushStdout = stdout;
    }

    // The flush-triggering call MUST produce a PostToolUse-tagged receipt.
    expect(flushStdout).not.toBe('');
    const parsed = JSON.parse(flushStdout.trim());
    expect(parsed.suppressOutput).toBe(true);
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/\[mem\] episode flushed: \d+ entries/);
  });

  it('SessionStart flush receipt + dashboard arrive as ONE envelope', () => {
    // History, in two corrections. First: flushEpisode wrote its receipt with no
    // trailing newline and the dashboard wrote a second object right after, landing as
    // `}{`. The fix added the newline, on the belief that Claude Code parsed stdout
    // line by line. v3.70.0 disproved that belief — 2.1.234's parser JSON.parses the
    // WHOLE trimmed stdout and falls back to plain text on throw, so TWO envelopes on
    // two lines were never both delivered either; for SessionStart the raw JSON went
    // to the model as literal text. This assertion used to check only the `}{` shape
    // and per-line parseability, which the two-envelope state satisfies — it passed
    // against the pre-v3.70 code (pre-tag review, test-effectiveness SHOULD-FIX-1).
    // Now it pins the real contract: exactly one document, carrying both surfaces.
    runHook('session-start', { env: { HOME: tmpHome } });
    // Build a leftover episode (below the 10-entry auto-flush threshold).
    for (let i = 0; i < 2; i++) {
      runHook('post-tool-use', {
        stdin: makeToolPayload(
          'Edit',
          {
            file_path: '/tmp/src/carry.js',
            old_string: `o${i}`,
            new_string: `n${i}`,
          },
          'OK — edited file',
        ),
        env: { HOME: tmpHome },
      });
    }
    // SessionStart (clear) flushes the leftover episode AND prints the dashboard.
    const { stdout } = runHook('session-start', {
      stdin: JSON.stringify({ source: 'clear' }),
      env: { HOME: tmpHome },
    });
    expect(stdout.trim(), 'the leftover episode + dashboard produced no output at all').not.toBe('');
    expect(stdout).not.toContain('}{');
    // The whole stdout — not each line — must be one JSON document.
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.suppressOutput).toBe(true);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    // Both surfaces ride it: the flushed episode receipt and the dashboard.
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/\[mem\] episode flushed: \d+ entries/);
    // And nothing rides outside it.
    expect(
      stdout
        .trim()
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('{')).length === 0 ||
        parsed.hookSpecificOutput.additionalContext.length > 0,
    ).toBe(true);
    expect(stdout.split('\n').filter((l) => l.trim().startsWith('{'))).toHaveLength(1);
  });

  it('skipped tools (Read, Glob) do not create entries', () => {
    runHook('session-start', { env: { HOME: tmpHome } });

    // Read and Glob should be skipped
    runHook('post-tool-use', {
      stdin: makeToolPayload('Read', { file_path: '/tmp/foo.js' }, 'file contents here more than 10 chars'),
      env: { HOME: tmpHome },
    });
    runHook('post-tool-use', {
      stdin: makeToolPayload('Glob', { pattern: '*.js' }, 'file1.js file2.js more stuff padding'),
      env: { HOME: tmpHome },
    });

    // No episode file should exist
    const epFile = getEpisodeFile(tmpHome);
    expect(epFile).toBeNull();
  });

  it('pending entry recovery: pending file gets merged on next call', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // First, create a normal episode entry
    runHook('post-tool-use', {
      stdin: makeToolPayload(
        'Edit',
        {
          file_path: '/tmp/src/app.js',
          old_string: 'a',
          new_string: 'b',
        },
        'OK — edited file',
      ),
      env: { HOME: tmpHome },
    });

    // Manually create a pending file (simulates what writePendingEntry does on lock failure)
    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const pendingFile = join(runtimeDir, `pending-${Date.now()}-test.json`);
    writeFileSync(
      pendingFile,
      JSON.stringify({
        entry: {
          tool: 'Write',
          desc: 'Created app.js (200 chars)',
          files: ['/tmp/src/app.js'],
          ts: Date.now(),
          isError: false,
          isSignificant: true,
          bashSig: null,
        },
        sessionId,
        project: 'parent--testproj',
        ts: Date.now(),
      }),
    );

    // Verify pending file exists
    const pendingBefore = readdirSync(runtimeDir).filter((f) => f.startsWith('pending-'));
    expect(pendingBefore.length).toBe(1);

    // Next post-tool-use should merge the pending entry
    runHook('post-tool-use', {
      stdin: makeToolPayload(
        'Edit',
        {
          file_path: '/tmp/src/app.js',
          old_string: 'x',
          new_string: 'y',
        },
        'OK — edited file',
      ),
      env: { HOME: tmpHome },
    });

    // Pending files should be consumed
    const remainingPending = readdirSync(runtimeDir).filter((f) => f.startsWith('pending-'));
    expect(remainingPending.length).toBe(0);

    // Episode should contain the merged entries (original + pending + new)
    const epFile = getEpisodeFile(tmpHome);
    expect(epFile).not.toBeNull();
    const episode = JSON.parse(readFileSync(epFile, 'utf8'));
    expect(episode.entries.length).toBeGreaterThanOrEqual(3);
  });

  it('file phase change triggers flush (unrelated files + ≥2 entries)', () => {
    runHook('session-start', { env: { HOME: tmpHome } });

    // Two entries on file A
    for (let i = 0; i < 2; i++) {
      runHook('post-tool-use', {
        stdin: makeToolPayload(
          'Edit',
          {
            file_path: '/tmp/src/moduleA.js',
            old_string: `a${i}`,
            new_string: `b${i}`,
          },
          'OK — edited file',
        ),
        env: { HOME: tmpHome },
      });
    }

    // Entry on completely unrelated file B → triggers phase change flush
    runHook('post-tool-use', {
      stdin: makeToolPayload(
        'Edit',
        {
          file_path: '/tmp/tests/unrelated.test.js',
          old_string: 'x',
          new_string: 'y',
        },
        'OK — edited file',
      ),
      env: { HOME: tmpHome },
    });

    // A flush file should have been created from the phase change
    const flushFiles = getFlushFiles(tmpHome);
    expect(flushFiles.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Suite 3: LLM Episode Processing', { retry: 2 }, () => {
  it('llm-episode with mock LLM creates observation in DB', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Create a flush file manually (simulating what flushEpisode does)
    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const flushFile = join(runtimeDir, `ep-flush-${Date.now()}-test.json`);
    writeFileSync(
      flushFile,
      JSON.stringify({
        sessionId,
        project: 'parent--testproj',
        startedAt: Date.now() - 5000,
        lastAt: Date.now(),
        files: ['/tmp/src/index.js'],
        entries: [
          {
            tool: 'Edit',
            desc: 'index.js: "foo" → "bar"',
            files: ['/tmp/src/index.js'],
            ts: Date.now(),
            isError: false,
            isSignificant: true,
            bashSig: null,
          },
        ],
        filesRead: [],
      }),
    );

    // Run llm-episode — it reads the flush file, calls mock LLM, saves observation
    const { exitCode } = runHook('llm-episode', {
      env: { HOME: tmpHome, CLAUDE_MEM_NO_DELAY: '1' },
      args: [flushFile],
    });
    expect(exitCode).toBe(0);

    // Flush file should be consumed
    expect(existsSync(flushFile)).toBe(false);

    // Observation should be in DB
    const db = openTestDb(tmpHome);
    const obs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all(sessionId);
    db.close();
    expect(obs.length).toBe(1);
    expect(obs[0].title).toBe('Mock single observation');
    expect(obs[0].type).toBe('change');
    expect(obs[0].narrative).toContain('Mock narrative');
  });

  it('P0: llm-episode with LLM failure drops low-signal degraded episode', () => {
    // v2.36: isNoiseObservation() blocks "Modified broken.js" fallback at insert.
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const flushFile = join(runtimeDir, `ep-flush-${Date.now()}-bad.json`);
    writeFileSync(
      flushFile,
      JSON.stringify({
        sessionId,
        project: 'parent--testproj',
        startedAt: Date.now() - 5000,
        lastAt: Date.now(),
        files: ['/tmp/src/broken.js'],
        entries: [
          {
            tool: 'Edit',
            desc: 'broken.js: fixed syntax error',
            files: ['/tmp/src/broken.js'],
            ts: Date.now(),
            isError: false,
            isSignificant: true,
            bashSig: null,
          },
        ],
        filesRead: [],
      }),
    );

    const { exitCode } = runHook('llm-episode', {
      env: { HOME: tmpHome, CLAUDE_CODE_PATH: '/dev/null', CLAUDE_MEM_NO_DELAY: '1' },
      args: [flushFile],
    });
    expect(exitCode).toBe(0);

    // P0 drops the low-signal fallback — 0 obs for pure-Edit noise episodes.
    const db = openTestDb(tmpHome);
    const obs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all(sessionId);
    db.close();
    expect(obs.length).toBe(0);
  });

  it('P0 opt-out: CLAUDE_MEM_KEEP_LOW_SIGNAL=1 preserves pre-v2.36 degraded save', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const flushFile = join(runtimeDir, `ep-flush-${Date.now()}-bad.json`);
    writeFileSync(
      flushFile,
      JSON.stringify({
        sessionId,
        project: 'parent--testproj',
        startedAt: Date.now() - 5000,
        lastAt: Date.now(),
        files: ['/tmp/src/broken.js'],
        entries: [
          {
            tool: 'Edit',
            desc: 'broken.js: fixed syntax error',
            files: ['/tmp/src/broken.js'],
            ts: Date.now(),
            isError: false,
            isSignificant: true,
            bashSig: null,
          },
        ],
        filesRead: [],
      }),
    );

    const { exitCode } = runHook('llm-episode', {
      env: {
        HOME: tmpHome,
        CLAUDE_CODE_PATH: '/dev/null',
        CLAUDE_MEM_NO_DELAY: '1',
        CLAUDE_MEM_KEEP_LOW_SIGNAL: '1',
      },
      args: [flushFile],
    });
    expect(exitCode).toBe(0);

    const db = openTestDb(tmpHome);
    const obs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all(sessionId);
    db.close();
    expect(obs.length).toBe(1);
    expect(obs[0].title).toContain('broken.js');
    expect(obs[0].type).toBe('change');
  });

  it('related observation linking: overlapping files populate related_ids', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Seed first observation directly in DB (avoids dedup with identical mock titles)
    const db = openTestDb(tmpHome);
    const now = new Date();
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'shared refactor concepts', 'refactor', 'Refactored shared module', 'shared.js, a.js', 'Refactored the shared module', 'refactor shared', 'updated exports', '[]', ?, 1, ?, ?)
    `,
    ).run(
      sessionId,
      JSON.stringify(['/tmp/src/shared.js', '/tmp/src/a.js']),
      now.toISOString(),
      now.getTime(),
    );
    db.close();

    // Second observation via llm-episode — overlapping file (shared.js)
    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const flush2 = join(runtimeDir, `ep-flush-${Date.now()}-r2.json`);
    writeFileSync(
      flush2,
      JSON.stringify({
        sessionId,
        project: 'parent--testproj',
        startedAt: Date.now() - 3000,
        lastAt: Date.now(),
        files: ['/tmp/src/shared.js', '/tmp/src/b.js'],
        entries: [
          {
            tool: 'Write',
            desc: 'Created b.js (200 chars)',
            files: ['/tmp/src/shared.js', '/tmp/src/b.js'],
            ts: Date.now() - 1000,
            isError: false,
            isSignificant: true,
            bashSig: null,
          },
        ],
        filesRead: [],
      }),
    );
    runHook('llm-episode', { env: { HOME: tmpHome, CLAUDE_MEM_NO_DELAY: '1' }, args: [flush2] });

    // Both observations should have related_ids referencing each other
    const db2 = openTestDb(tmpHome);
    const obs = db2.prepare('SELECT id, related_ids FROM observations ORDER BY id').all();
    db2.close();
    expect(obs.length).toBe(2);

    const rel1 = JSON.parse(obs[0].related_ids);
    const rel2 = JSON.parse(obs[1].related_ids);
    expect(rel1).toContain(obs[1].id);
    expect(rel2).toContain(obs[0].id);
  });
});

describe('Suite 4: Session Summary', { retry: 2 }, () => {
  it('llm-summary with observations creates session_summary', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Seed an observation directly in DB
    const db = openTestDb(tmpHome);
    const now = new Date();
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'test text', 'change', 'Test observation', '', 'Did some changes', '', '', '[]', '[]', 1, ?, ?)
    `,
    ).run(sessionId, now.toISOString(), now.getTime());
    db.close();

    // Run llm-summary (pass sessionId and project as args)
    const { exitCode } = runHook('llm-summary', {
      env: { HOME: tmpHome, CLAUDE_MEM_FLUSH_TIMEOUT: '1' },
      args: [sessionId, 'parent--testproj'],
    });
    expect(exitCode).toBe(0);

    // Session summary should exist
    const db2 = openTestDb(tmpHome);
    const summaries = db2
      .prepare('SELECT * FROM session_summaries WHERE memory_session_id = ?')
      .all(sessionId);
    db2.close();
    expect(summaries.length).toBe(1);
    expect(summaries[0].request).toBe('Mock session request description');
    expect(summaries[0].completed).toBe('Mock accomplishments');
    expect(summaries[0].next_steps).toBe('Mock suggested follow-up');
  });

  it('llm-summary with no observations exits gracefully', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const { exitCode } = runHook('llm-summary', {
      env: { HOME: tmpHome, CLAUDE_MEM_FLUSH_TIMEOUT: '1' },
      args: [sessionId, 'parent--testproj'],
    });
    expect(exitCode).toBe(0);

    // No summary should be created
    const db = openTestDb(tmpHome);
    const summaries = db.prepare('SELECT * FROM session_summaries').all();
    db.close();
    expect(summaries.length).toBe(0);
  });
});

describe('Suite 5: User Prompt', () => {
  it('user-prompt stores scrubbed text in DB', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const { exitCode } = runHook('user-prompt', {
      stdin: JSON.stringify({ user_prompt: 'Help me fix the authentication bug' }),
      env: { HOME: tmpHome },
    });
    expect(exitCode).toBe(0);

    const db = openTestDb(tmpHome);
    const prompts = db.prepare('SELECT * FROM user_prompts WHERE content_session_id = ?').all(sessionId);
    db.close();
    expect(prompts.length).toBe(1);
    expect(prompts[0].prompt_text).toBe('Help me fix the authentication bug');
    expect(prompts[0].prompt_number).toBe(1);
  });

  it('user-prompt accepts "prompt" field (Claude Code hook protocol)', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const { exitCode } = runHook('user-prompt', {
      stdin: JSON.stringify({ prompt: 'Using the new prompt field name' }),
      env: { HOME: tmpHome },
    });
    expect(exitCode).toBe(0);

    const db = openTestDb(tmpHome);
    const prompts = db.prepare('SELECT * FROM user_prompts WHERE content_session_id = ?').all(sessionId);
    db.close();
    expect(prompts.length).toBe(1);
    expect(prompts[0].prompt_text).toBe('Using the new prompt field name');
  });

  it('user-prompt surfaces matching events in an E# memory-context block (HIGH-1 path B)', () => {
    runHook('session-start', { env: { HOME: tmpHome } });

    // Seed an event (the canonical store for promoted bugfix memories) matching the prompt.
    const db = openTestDb(tmpHome);
    const evId = saveEvent(db, {
      project: 'parent--testproj',
      event_type: 'bugfix',
      title: 'redis connection timeout fix',
      body: 'raise the pool size and add exponential backoff on connect',
      importance: 2,
    });
    db.close();

    const { stdout, exitCode } = runHook('user-prompt', {
      stdin: JSON.stringify({ user_prompt: 'how did we fix the redis timeout' }),
      env: { HOME: tmpHome },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('<memory-context relevance="events">');
    expect(stdout).toContain(`E#${evId}`);
    expect(stdout).toContain('backoff');
    // id-space discipline: rendered as E#, never a bare #<id> that citation decay
    // would mis-read as an observation id.
    expect(stdout).not.toContain(`(#${evId})`);
  });

  it('SessionStart surfaces recent high-importance events in a Key Events section (HIGH-1 SessionStart)', () => {
    // First session-start creates the DB + session; seed an event; the next
    // session-start emits the context block including the Key Events section.
    // MEM_QUIET_HOOKS is cleared: the dev shell may export it (=1), and runHook
    // spreads ...process.env, which would suppress the descriptive sections (#8608).
    const nonQuiet = { HOME: tmpHome, MEM_QUIET_HOOKS: '' };
    runHook('session-start', { env: nonQuiet });
    const db = openTestDb(tmpHome);
    const evId = saveEvent(db, {
      project: 'parent--testproj',
      event_type: 'decision',
      title: 'chose WAL + busy_timeout for concurrent sessions',
      body: 'immediate transactions serialize writers across sessions',
      importance: 3,
    });
    db.close();

    const { stdout } = runHook('session-start', { env: nonQuiet });
    expect(stdout).toContain('### Key Events');
    expect(stdout).toContain(`E#${evId}`);
    expect(stdout).not.toContain(`(#${evId})`); // E#, not a bare obs-id form
  });

  it('task-notification prompts are silently dropped (not stored)', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const { exitCode } = runHook('user-prompt', {
      stdin: JSON.stringify({
        prompt:
          '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n</task-notification>',
      }),
      env: { HOME: tmpHome },
    });
    expect(exitCode).toBe(0);

    const db = openTestDb(tmpHome);
    const prompts = db.prepare('SELECT * FROM user_prompts WHERE content_session_id = ?').all(sessionId);
    db.close();
    expect(prompts.length).toBe(0);
  });

  it('prompt counter increments across multiple prompts', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    for (let i = 0; i < 3; i++) {
      runHook('user-prompt', {
        stdin: JSON.stringify({ user_prompt: `Prompt number ${i + 1}` }),
        env: { HOME: tmpHome },
      });
    }

    const db = openTestDb(tmpHome);
    const prompts = db
      .prepare('SELECT prompt_number FROM user_prompts WHERE content_session_id = ? ORDER BY id')
      .all(sessionId);
    const sess = db
      .prepare('SELECT prompt_counter FROM sdk_sessions WHERE content_session_id = ?')
      .get(sessionId);
    db.close();
    expect(prompts.length).toBe(3);
    expect(prompts[0].prompt_number).toBe(1);
    expect(prompts[1].prompt_number).toBe(2);
    expect(prompts[2].prompt_number).toBe(3);
    expect(sess.prompt_counter).toBe(3);
  });
});

describe('Suite 6: Error Recall', () => {
  it('post-tool-use with Bash error outputs recall hints', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Seed DB with a relevant observation carrying a lesson_learned (→ inlined top-1)
    const db = openTestDb(tmpHome);
    const now = new Date();
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, lesson_learned, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'ECONNREFUSED connection refused port 3000', 'bugfix', 'Fixed ECONNREFUSED on port 3000', '', 'Server was not running, needed to start it first', 'Start the dev server before curling the health endpoint.', '', '', '[]', '[]', 2, ?, ?)
    `,
    ).run(sessionId, now.toISOString(), now.getTime());
    // Low-signal "Modified %" obs that ALSO matches the FTS keywords (econnrefused
    // in text) — must be gated OUT of error-recall by notLowSignalTitleClause.
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'ECONNREFUSED noise low signal row', 'change', 'Modified netcfg.json', '', '', '', '', '[]', '[]', 1, ?, ?)
    `,
    ).run(sessionId, now.toISOString(), now.getTime());
    db.close();

    // Bash error containing matching keywords
    const { stdout } = runHook('post-tool-use', {
      stdin: makeToolPayload(
        'Bash',
        {
          command: 'curl http://localhost:3000/api/health',
        },
        'Error: connect ECONNREFUSED 127.0.0.1:3000\n    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)',
      ),
      env: { HOME: tmpHome, CLAUDE_MEM_METRICS: '1' },
    });

    expect(stdout).toContain('[claude-mem-lite] Related memories found for this error');

    // G13: each fired error-recall injection must be metered — the G8 gate change
    // (isError→isHardError) had no post-fix volume signal in metrics before this.
    const erRows = readMetricRows(tmpHome).filter((r) => r.event === 'error_recall');
    expect(erRows.length).toBe(1);
    expect(erRows[0].returned).toBeGreaterThanOrEqual(1);
    expect(stdout).toContain('ECONNREFUSED');
    // ② precision-half: top-1 lesson_learned is inlined (agent acts with no follow-up mem_get)
    expect(stdout).toContain('Start the dev server before curling the health endpoint.');
    // ② precision-half: low-signal 'Modified %' obs is gated out despite matching FTS
    expect(stdout).not.toContain('Modified netcfg.json');

    // MED-3: the hint must ride the JSON envelope, not raw stdout. A raw multi-line
    // text write corrupts a co-emitted episode-flush receipt (both land on stdout)
    // and is silently dropped on CC variants that ignore plain-text PostToolUse
    // stdout. Every non-empty stdout line must therefore be a parseable JSON object.
    const lines = stdout.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = lines.map((l) => JSON.parse(l)); // throws (RED) if any line is raw text
    const hint = parsed.find((p) =>
      p.hookSpecificOutput?.additionalContext?.includes('Related memories found for this error'),
    );
    expect(hint).toBeTruthy();
    expect(hint.hookSpecificOutput.hookEventName).toBe('PostToolUse');
  });

  it('soft error text in successful command output does NOT trigger recall (hard gate)', () => {
    // G8 (roadmap 2026-07-18): the recall gate was bashSig?.isError — any "error"
    // wording in a non-search command's output fired "Related memories found for
    // this error" on exit-0 commands (live: 5+ false fires in one session, and
    // self-recursive since the hint itself contains 'error'). The gate must be
    // isHardError: a genuine failure fingerprint (stack frame / TypeError: /
    // ENOENT / panic), not the word "error" in benign report output.
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Seed an obs that MATCHES the output keywords — so absence of the hint below
    // proves the gate blocked recall, not that FTS found nothing.
    const db = openTestDb(tmpHome);
    const now = new Date();
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, lesson_learned, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'ECONNREFUSED connection refused port 3000', 'bugfix', 'Fixed ECONNREFUSED on port 3000', '', '', 'Start the dev server before curling the health endpoint.', '', '', '[]', '[]', 2, ?, ?)
    `,
    ).run(sessionId, now.toISOString(), now.getTime());
    db.close();

    // Non-search command (node → no isReadOnlyCommand exemption), output contains
    // "error" + a matching keyword but NO hard-error fingerprint: no stack "at "
    // line, no TypeError:/ENOENT/panic → isError=true, isHardError=false.
    const { stdout } = runHook('post-tool-use', {
      stdin: makeToolPayload(
        'Bash',
        {
          command: 'node scripts/health-report.mjs',
        },
        'Health report: 2 endpoints degraded, last error ECONNREFUSED on port 3000 (recovered), overall status OK',
      ),
      env: { HOME: tmpHome, CLAUDE_MEM_METRICS: '1' },
    });

    expect(stdout).not.toContain('Related memories found for this error');
    // G13 negative: no injection → no error_recall metric row (metrics enabled,
    // so absence proves the gate, not a disabled sink).
    expect(readMetricRows(tmpHome).filter((r) => r.event === 'error_recall').length).toBe(0);
  });
});

// D#170. Claude Code does NOT fire PostToolUse for a tool call it judged failed — those
// go to a separate `PostToolUseFailure` event. Registering only PostToolUse made this
// plugin blind to every host-flagged failure, so the only "failures" error-recall saw
// were commands that exited 0 while printing error-ish text.
//
// The payload is not PostToolUse's: the failure text lives in `error` (there is no
// `tool_response`) and `is_interrupt` marks a cancellation. Reading the wrong field
// would make this path silently do nothing, which looks exactly like the old behaviour
// — so the field name is asserted directly rather than inferred from a passing case.
describe('Suite 6b: PostToolUseFailure — host-flagged failures reach error-recall (D#170)', () => {
  const FAILURE_TEXT =
    "Error: ENOENT: no such file or directory, open '/app/package.json'\n" +
    '    at Object.openSync (node:fs:596:3)';

  const failurePayload = (over = {}) =>
    JSON.stringify({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'node scripts/build.mjs' },
      tool_use_id: 'toolu_d170',
      error: FAILURE_TEXT,
      ...over,
    });

  function seed() {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);
    const db = openTestDb(tmpHome);
    const now = new Date();
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, lesson_learned, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'ENOENT package.json missing openSync build', 'bugfix', 'ENOENT on package.json means the cwd is wrong', '', '', 'Run the build from the package root, not from scripts/.', '', '', '[]', '[]', 2, ?, ?)
    `,
    ).run(sessionId, now.toISOString(), now.getTime());
    db.close();
  }

  it('injects for a failure PostToolUse never sees, on its OWN event envelope', () => {
    seed();
    const { stdout } = runHook('post-tool-failure', {
      stdin: failurePayload(),
      env: { HOME: tmpHome, CLAUDE_MEM_METRICS: '1' },
    });

    expect(stdout).toContain('[claude-mem-lite] Related memories found for this error');
    expect(stdout).toContain('Run the build from the package root');

    // The envelope's event name is the field a copy-paste from the PostToolUse path
    // gets wrong, and the host rejects a mismatch — so the injection would vanish while
    // every other assertion here still passed.
    const parsed = stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const hint = parsed.find((p) => p.hookSpecificOutput?.additionalContext?.includes('Related memories'));
    expect(hint).toBeTruthy();
    expect(hint.hookSpecificOutput.hookEventName).toBe('PostToolUseFailure');

    // Its own counter: the volume this event adds has to be readable on its own rather
    // than merged into the surface's existing total.
    const rows = readMetricRows(tmpHome);
    expect(rows.filter((r) => r.event === 'error_recall_failure').length).toBe(1);
    expect(rows.filter((r) => r.event === 'error_recall').length).toBe(0);
  });

  it('reads the failure from `error`, NOT from `tool_response`', () => {
    // The wiring bug this whole suite exists to catch. Same text, delivered under
    // PostToolUse's field name: a handler that reached for `tool_response` would pass
    // every other case in this file and do nothing in production.
    seed();
    const { stdout } = runHook('post-tool-failure', {
      stdin: JSON.stringify({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: 'node scripts/build.mjs' },
        tool_use_id: 'toolu_d170',
        tool_response: FAILURE_TEXT,
      }),
      env: { HOME: tmpHome, CLAUDE_MEM_METRICS: '1' },
    });
    expect(stdout).not.toContain('Related memories found for this error');
  });

  // A refusal whose text WOULD produce query terms and WOULD match the seeded row.
  //
  // The first version of this pair used `§8 SAFETY (immutable): denied …`, and both cases
  // were vacuous: `planErrorRecall` returns null on it (no `error`/`fail`/`not found`
  // wording, no namer), so the surface injects nothing whatever the gate does. Mutation
  // proved it — disabling ONLY the refusal branch passed every test in the release. The
  // text below carries `ENOENT` and `package.json`, which the seeded memory matches, so
  // the ONLY thing keeping this quiet is the gate.
  const REFUSAL_WITH_TERMS =
    '[claudemd] §11 memory-hint: refused — the ENOENT probe on ' +
    'package.json was blocked before it ran.\nError: command not executed.';

  it('stays silent for a tool-chain refusal', () => {
    // 68.9% of host-flagged Bash failures on the maintainer's machine. Injecting three
    // memories because a policy hook denied a command is noise by construction.
    seed();
    const { stdout } = runHook('post-tool-failure', {
      stdin: failurePayload({
        error: REFUSAL_WITH_TERMS,
        tool_input: { command: 'node scripts/build.mjs' },
      }),
      env: { HOME: tmpHome, CLAUDE_MEM_METRICS: '1' },
    });
    expect(stdout).not.toContain('Related memories found for this error');
    expect(readMetricRows(tmpHome).filter((r) => r.event === 'error_recall_failure').length).toBe(0);
  });

  it('...and the SAME text without the refusal marker DOES inject', () => {
    // The negative control the case above needs. Without it, "stays silent" could still
    // be satisfied by text that matches nothing — which is exactly how the first version
    // of this pair passed while the gate was disconnected. Strip only the `[claudemd] §11`
    // marker; every query term stays.
    seed();
    const { stdout } = runHook('post-tool-failure', {
      stdin: failurePayload({
        error: REFUSAL_WITH_TERMS.replace('[claudemd] §11 memory-hint: refused — the', 'The'),
        tool_input: { command: 'node scripts/build.mjs' },
      }),
      env: { HOME: tmpHome, CLAUDE_MEM_METRICS: '1' },
    });
    expect(
      stdout,
      'the refusal case must be silent because of the MARKER, not because its text matches nothing',
    ).toContain('Related memories found for this error');
  });

  it('stays silent when the user interrupted the command', () => {
    seed();
    const { stdout } = runHook('post-tool-failure', {
      stdin: failurePayload({ is_interrupt: true }),
      env: { HOME: tmpHome, CLAUDE_MEM_METRICS: '1' },
    });
    expect(stdout).not.toContain('Related memories found for this error');
  });

  it('is scoped to Bash even if a hand-edited matcher widens the registration', () => {
    // install.mjs writes a SECOND registration into the user's settings.json; the
    // manifest matcher is not the only thing that decides what arrives here.
    //
    // The input DELIBERATELY carries a `command`. A first version of this case sent an
    // Edit payload with only `file_path`, which the downstream "no command string"
    // guard rejected — so deleting the tool_name check entirely left the case green and
    // the guard it names untested. Mutation caught that; the payload below is the
    // difference between asserting a necessary condition and asserting this one.
    seed();
    const { stdout } = runHook('post-tool-failure', {
      stdin: failurePayload({
        tool_name: 'Edit',
        tool_input: { command: 'node scripts/build.mjs', file_path: '/app/x.mjs' },
      }),
      env: { HOME: tmpHome, CLAUDE_MEM_METRICS: '1' },
    });
    expect(stdout).not.toContain('Related memories found for this error');
  });

  it('a Bash failure carrying no command injects nothing', () => {
    // The guard the Bash-scoping case above leans on, pinned in its own right. Review
    // flagged the two as entangled: the scoping case was rescued by THIS guard in a
    // first draft, and once that was fixed nothing was left asserting this one.
    //
    // It is not merely defensive. Without it the payload still reaches selectErrorRecall
    // with `cmd: undefined`, planErrorRecall extracts terms from the error text alone,
    // and the surface injects — attributing a recall to a command it never saw.
    seed();
    for (const toolInput of [{}, { command: '' }, { command: 42 }, { file_path: '/app/x.mjs' }]) {
      const { stdout } = runHook('post-tool-failure', {
        stdin: failurePayload({ tool_input: toolInput }),
        env: { HOME: tmpHome, CLAUDE_MEM_METRICS: '1' },
      });
      expect(stdout, `tool_input=${JSON.stringify(toolInput)}`).not.toContain(
        'Related memories found for this error',
      );
    }
  });

  it('honours the kill switch, and only "off" trips it', () => {
    seed();
    const off = runHook('post-tool-failure', {
      stdin: failurePayload(),
      env: { HOME: tmpHome, CLAUDE_MEM_METRICS: '1', CLAUDE_MEM_ERROR_RECALL_ON_FAILURE: 'off' },
    });
    expect(off.stdout).not.toContain('Related memories found for this error');
    // A typo must not silently revert the feature.
    const typo = runHook('post-tool-failure', {
      stdin: failurePayload(),
      env: { HOME: tmpHome, CLAUDE_MEM_METRICS: '1', CLAUDE_MEM_ERROR_RECALL_ON_FAILURE: '0' },
    });
    expect(typo.stdout).toContain('Related memories found for this error');
  });
});

describe('Suite 7: Secret Scrubbing E2E', () => {
  it('post-tool-use with password=secret scrubs episode desc', () => {
    runHook('session-start', { env: { HOME: tmpHome } });

    const payload = makeToolPayload(
      'Bash',
      {
        command: 'curl -u admin:password=secret123 http://api.example.com/deploy',
      },
      'HTTP 200 OK deployed successfully — this is a longer response for the length check',
    );

    runHook('post-tool-use', {
      stdin: payload,
      env: { HOME: tmpHome },
    });

    const epFile = getEpisodeFile(tmpHome);
    expect(epFile).not.toBeNull();
    const episode = JSON.parse(readFileSync(epFile, 'utf8'));
    // The desc should have the secret scrubbed
    expect(episode.entries[0].desc).not.toContain('secret123');
  });
});

describe('Suite 8a: Cross-Session MinHash Dedup', () => {
  it('cross-session dedup blocks near-duplicate observation', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    // Insert first observation directly into DB with minhash_sig
    const db = openTestDb(tmpHome);
    const now = new Date();
    const title1 = 'Fixed authentication bug in login flow for user sessions';
    const narrative1 =
      'The authentication module had a bug where expired tokens were not being refreshed properly';
    const sig = computeMinHash(title1 + ' ' + narrative1);

    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, minhash_sig, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', ?, 'bugfix', ?, '', ?, '', '', '[]', '[]', 1, ?, ?, ?)
    `,
    ).run(sessionId, title1, title1, narrative1, sig, now.toISOString(), now.getTime());
    db.close();

    // Try to save a near-duplicate observation via llm-episode
    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const flushFile = join(runtimeDir, `ep-flush-${Date.now()}-dedup.json`);
    writeFileSync(
      flushFile,
      JSON.stringify({
        sessionId: `hook-parent--testproj-different-session`,
        project: 'parent--testproj',
        startedAt: Date.now() - 5000,
        lastAt: Date.now(),
        files: ['/tmp/src/auth.js'],
        entries: [
          {
            tool: 'Edit',
            desc: 'auth.js: fixed token refresh',
            files: ['/tmp/src/auth.js'],
            ts: Date.now(),
            isError: false,
            isSignificant: true,
            bashSig: null,
          },
        ],
        filesRead: [],
      }),
    );

    // Run llm-episode - the mock LLM will return a generic title, which won't match
    // by Jaccard but the MinHash check happens on the combined title+narrative
    runHook('llm-episode', { env: { HOME: tmpHome, CLAUDE_MEM_NO_DELAY: '1' }, args: [flushFile] });

    // The mock returns "Mock single observation" which is dissimilar, so it should NOT be deduped
    // This test validates that the minhash_sig column is populated for new observations
    const db2 = openTestDb(tmpHome);
    const obs = db2.prepare('SELECT id, minhash_sig FROM observations ORDER BY id').all();
    db2.close();
    expect(obs.length).toBeGreaterThanOrEqual(1);
    // First observation should have our manually set sig
    expect(obs[0].minhash_sig).toBe(sig);
  });
});

describe('Suite 8a: Additional E2E', () => {
  it('session-start with no existing DB creates DB', () => {
    // Use a fresh tmpHome with no DB
    const freshHome = makeTmpDir();
    const freshProjDir = join(freshHome, 'parent', 'freshproj');
    mkdirSync(freshProjDir, { recursive: true });

    const { exitCode, stdout } = runHook('session-start', {
      env: { HOME: freshHome, CLAUDE_PROJECT_DIR: freshProjDir },
    });
    expect(exitCode).toBe(0);
    // A first-run install has nothing to inject, and the hook now writes no
    // empty `<claude-mem-context>` wrapper. The DB-creation assertion below is what this
    // case is actually about.
    expect(stdout).not.toContain('<claude-mem-context>');

    // DB should have been created
    const dbPath = join(freshHome, '.claude-mem-lite', 'claude-mem-lite.db');
    expect(existsSync(dbPath)).toBe(true);

    try {
      rmSync(freshHome, { recursive: true, force: true });
    } catch {}
  });

  it('auto-migrates ~/claude-mem-lite/claude-mem.db → ~/.claude-mem-lite/claude-mem-lite.db on session-start', () => {
    // Create a fresh home with old unhidden dir + old DB filename
    const migrateHome = makeTmpDir();
    const oldUnhiddenDir = join(migrateHome, 'claude-mem-lite');
    mkdirSync(oldUnhiddenDir, { recursive: true });
    mkdirSync(join(oldUnhiddenDir, 'runtime'), { recursive: true });

    // Create DB with old filename in old dir
    const oldDbPath = join(oldUnhiddenDir, 'claude-mem.db');
    const db = new Database(oldDbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    // Insert a marker observation
    const now = new Date();
    const sessId = 'migrate-test-sess';
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?, ?, 'test', ?, ?, 'completed')`,
    ).run(sessId, sessId, now.toISOString(), now.getTime());
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch) VALUES (?, 'test', 'marker', 'discovery', 'Migration marker', '', '', '', '', '[]', '[]', 1, ?, ?)`,
    ).run(sessId, now.toISOString(), now.getTime());
    db.close();

    // Old file should exist, new hidden dir should not
    expect(existsSync(oldDbPath)).toBe(true);
    const newHiddenDir = join(migrateHome, '.claude-mem-lite');
    expect(existsSync(newHiddenDir)).toBe(false);

    // Session-start triggers ensureDb() which:
    //   1. Renames ~/claude-mem-lite/ → ~/.claude-mem-lite/
    //   2. Renames claude-mem.db → claude-mem-lite.db
    const migrateProjDir = join(migrateHome, 'parent', 'migrateproj');
    mkdirSync(migrateProjDir, { recursive: true });
    const { exitCode } = runHook('session-start', {
      env: { HOME: migrateHome, CLAUDE_PROJECT_DIR: migrateProjDir },
    });
    expect(exitCode).toBe(0);

    // Old unhidden dir should be gone
    expect(existsSync(oldUnhiddenDir)).toBe(false);
    // New hidden dir should exist with renamed DB
    const newDbPath = join(newHiddenDir, 'claude-mem-lite.db');
    expect(existsSync(newDbPath)).toBe(true);

    // Verify data survived both migrations
    const db2 = new Database(newDbPath, { readonly: true });
    const obs = db2.prepare("SELECT title FROM observations WHERE title = 'Migration marker'").get();
    db2.close();
    expect(obs).not.toBeUndefined();
    expect(obs.title).toBe('Migration marker');

    try {
      rmSync(migrateHome, { recursive: true, force: true });
    } catch {}
  });

  it('expired sessions get cleaned up on session-start', () => {
    // Seed an old active session (>24h ago)
    const db = openTestDb(tmpHome);
    const oldEpoch = Date.now() - 25 * 3600000;
    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'parent--testproj', ?, ?, 'active')
    `,
    ).run('old-sess', 'old-sess', new Date(oldEpoch).toISOString(), oldEpoch);
    db.close();

    // Start a new session — should mark old one as expired
    runHook('session-start', { env: { HOME: tmpHome } });

    const db2 = openTestDb(tmpHome);
    const oldSess = db2
      .prepare("SELECT status FROM sdk_sessions WHERE content_session_id = 'old-sess'")
      .get();
    db2.close();
    // Old active sessions should be marked as expired/completed
    if (oldSess) {
      expect(oldSess.status).not.toBe('active');
    }
  });

  it('user-prompt with API key gets scrubbed', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const { exitCode } = runHook('user-prompt', {
      stdin: JSON.stringify({
        user_prompt: 'Deploy with token=sk-abc123def456ghi789jklmnopqrstuvwxyz to production',
      }),
      env: { HOME: tmpHome },
    });
    expect(exitCode).toBe(0);

    const db = openTestDb(tmpHome);
    const prompts = db
      .prepare('SELECT prompt_text FROM user_prompts WHERE content_session_id = ?')
      .all(sessionId);
    db.close();
    expect(prompts.length).toBe(1);
    // The sk- token should be scrubbed
    expect(prompts[0].prompt_text).not.toContain('sk-abc123def456ghi789jklmnopqrstuvwxyz');
    expect(prompts[0].prompt_text).toContain('***');
  });

  it('long prompt is truncated to 10000 chars', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);

    const longPrompt = 'A'.repeat(15000);
    runHook('user-prompt', {
      stdin: JSON.stringify({ user_prompt: longPrompt }),
      env: { HOME: tmpHome },
    });

    const db = openTestDb(tmpHome);
    const prompts = db
      .prepare('SELECT prompt_text FROM user_prompts WHERE content_session_id = ?')
      .all(sessionId);
    db.close();
    expect(prompts.length).toBe(1);
    expect(prompts[0].prompt_text.length).toBeLessThanOrEqual(10000);
  });

  it('CLAUDE.md stays clean across repeated session-starts (no block written)', () => {
    // Pre-v2.30 this test asserted idempotent writes of a <claude-mem-context>
    // block. Post-v2.30 the block is never written: context is delivered via
    // SessionStart hook stdout only.
    const projDir2 = join(tmpHome, 'parent', 'idempotent');
    mkdirSync(projDir2, { recursive: true });
    const original = '# Existing\n\nContent here.\n';
    writeFileSync(join(projDir2, 'CLAUDE.md'), original);

    // Seed a summary
    const db = openTestDb(tmpHome);
    const now = new Date();
    const sessId = `hook-parent--idempotent-${randomUUID().slice(0, 8)}`;
    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'parent--idempotent', ?, ?, 'completed')
    `,
    ).run(sessId, sessId, now.toISOString(), now.getTime());
    db.prepare(
      `
      INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES (?, 'parent--idempotent', 'Test request', 'Test completed', 'Test next', ?, ?)
    `,
    ).run(sessId, now.toISOString(), now.getTime());
    db.close();

    // Two session-starts
    // MEM_NO_AUTO_ADOPT isolates the context-delivery invariant from the v3.13
    // managed-block write (adoption is exercised in Suite 11 / adopt-cli tests).
    const noAdopt = { HOME: tmpHome, CLAUDE_PROJECT_DIR: projDir2, MEM_NO_AUTO_ADOPT: '1' };
    const run1 = runHook('session-start', { env: noAdopt });
    const claudeMd1 = readFileSync(join(projDir2, 'CLAUDE.md'), 'utf8');
    const run2 = runHook('session-start', { env: noAdopt });
    const claudeMd2 = readFileSync(join(projDir2, 'CLAUDE.md'), 'utf8');

    // CLAUDE.md stays exactly as written (no context block ever appears)
    expect(claudeMd1).toBe(original);
    expect(claudeMd2).toBe(original);
    expect(claudeMd2).not.toContain('<claude-mem-context>');

    // Context is delivered via stdout on both runs
    expect(run1.stdout).toContain('<claude-mem-context>');
    expect(run1.stdout).toContain('Test request');
    expect(run2.stdout).toContain('<claude-mem-context>');
  });

  it('auto-compress marks old low-importance observations during session-start', () => {
    const db = openTestDb(tmpHome);
    const now = new Date();
    const sessId = `hook-parent--testproj-${randomUUID().slice(0, 8)}`;
    const hundredDaysAgo = Date.now() - 100 * 86400000;

    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'parent--testproj', ?, ?, 'completed')
    `,
    ).run(sessId, sessId, now.toISOString(), now.getTime());

    // Old, low-importance observation (should be auto-compressed)
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'old routine note', 'discovery', 'Old routine observation', '', '', '', '', '[]', '[]', 1, ?, ?)
    `,
    ).run(sessId, new Date(hundredDaysAgo).toISOString(), hundredDaysAgo);

    // Old imp=0 observation (citation-decay floor / LLM low-signal filter) — STRICTLY lower
    // value than imp=1, so it MUST be GC-eligible too. Pre-fix the auto-compress predicate was
    // `importance = 1` (exact) and imp=0 rows were immortal — ~40% of a mature DB. (audit imp=0)
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'old floored note', 'discovery', 'Old floored observation', '', '', '', '', '[]', '[]', 0, ?, ?)
    `,
    ).run(sessId, new Date(hundredDaysAgo).toISOString(), hundredDaysAgo);

    // Old, higher-importance observation (should NOT be auto-compressed)
    // access_count=1 prevents auto-maintain decay from reducing importance
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, access_count, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'old notable note', 'decision', 'Old notable observation', '', '', '', '', '[]', '[]', 2, 1, ?, ?)
    `,
    ).run(sessId, new Date(hundredDaysAgo).toISOString(), hundredDaysAgo);

    db.close();

    // P2-11: auto-compress marking moved off the SessionStart transaction onto the 24h
    // auto-maintain cadence, so it is driven explicitly here (SKIP_MAINTAIN is set in this
    // harness, so the background spawn never races the read below). The project scope is
    // argv[3] — the same scope the SessionStart transaction always applied.
    runHook('session-start', { env: { HOME: tmpHome } });
    runHook('auto-maintain', { env: { HOME: tmpHome }, args: ['parent--testproj'] });

    const db2 = openTestDb(tmpHome);
    const obs = db2.prepare('SELECT id, importance, compressed_into FROM observations ORDER BY id').all();
    db2.close();

    expect(obs.length).toBe(3);
    // importance=1 should be marked as auto-compressed
    const lowImportance = obs.find((o) => o.importance === 1);
    expect(lowImportance.compressed_into).toBe(-1);
    // importance=0 (decay floor / filtered) must ALSO be auto-compressed, not immortal
    const flooredImportance = obs.find((o) => o.importance === 0);
    expect(flooredImportance.compressed_into).toBe(-1);
    // importance=2 should be untouched
    const highImportance = obs.find((o) => o.importance === 2);
    expect(highImportance.compressed_into).toBeNull();
  });

  it('auto-maintain GCs expired session_handoffs (reaps past-expiry, keeps fresh)', () => {
    // The consume-DELETE only removes the one handoff a continuation reads back; an unresumed
    // 'exit' and every superseded 'clear' lingered forever (read paths filter by expiry but
    // nothing reaped the rows). auto-maintain now deletes past-expiry rows with a +1d margin.
    const db = openTestDb(tmpHome);
    const now = Date.now();
    const ins = db.prepare(
      'INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch) VALUES (?,?,?,?,?)',
    );
    ins.run('parent--testproj', 'exit', 's-old', 'old', now - 10 * 86400000); // 10d → GC
    ins.run('parent--testproj', 'exit', 's-new', 'new', now - 1 * 86400000); // 1d  → keep
    ins.run('parent--testproj', 'clear', 's-clr', 'old clear', now - 2 * 86400000); // 2d → GC (clear 6h+1d)
    db.close();

    // MED-4: the maintenance pass (incl. handoff-GC) now runs in the detached
    // auto-maintain worker, not synchronously in SessionStart. In production
    // SessionStart spawns it; here it is skipped (CLAUDE_MEM_SKIP_MAINTAIN) and
    // invoked directly, mirroring the auto-compress worker tests.
    runHook('session-start', { env: { HOME: tmpHome } });
    runHook('auto-maintain', { env: { HOME: tmpHome } });

    const db2 = openTestDb(tmpHome);
    const surviving = db2
      .prepare('SELECT session_id FROM session_handoffs ORDER BY session_id')
      .all()
      .map((r) => r.session_id);
    db2.close();
    expect(surviving).toEqual(['s-new']); // only the within-expiry exit handoff remains
  });

  it('auto-compress creates weekly summaries for old low-value observations', () => {
    const db = openTestDb(tmpHome);
    const now = new Date();
    const sessId = `hook-parent--testproj-${randomUUID().slice(0, 8)}`;

    // Anchor to Wednesday noon UTC, ≥95 days ago. Avoids the date-flake where
    // `Date.now() - 90d + N*3600000` straddles a Sunday→Monday boundary depending
    // on the wall-clock day-of-week, splitting the 4 hourly observations across
    // two ISO weeks (one of which has only 1 obs and gets skipped by the
    // `obs.length < 3` floor in handleAutoCompress, breaking the test ~1/7 days).
    const anchor = new Date(Date.now() - 95 * 86400000);
    anchor.setUTCHours(12, 0, 0, 0);
    // Walk forward to the next Wednesday (UTC day 3) so the 4 hourly observations
    // are guaranteed to land mid-week.
    const daysToWed = (3 - anchor.getUTCDay() + 7) % 7;
    anchor.setUTCDate(anchor.getUTCDate() + daysToWed);
    const wedNoonEpoch = anchor.getTime();

    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'parent--testproj', ?, ?, 'completed')
    `,
    ).run(sessId, sessId, now.toISOString(), now.getTime());

    // Insert 4 old, low-importance, never-accessed observations in the same week
    for (let i = 0; i < 4; i++) {
      const epoch = wedNoonEpoch + i * 3600000; // 1 hour apart on a Wednesday afternoon
      db.prepare(
        `
        INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative,
          concepts, facts, files_read, files_modified, importance, access_count, created_at, created_at_epoch)
        VALUES (?, 'parent--testproj', 'old text', 'change', ?, '', '', '', '', '[]', '[]', 1, 0, ?, ?)
      `,
      ).run(sessId, `Old change ${i}`, new Date(epoch).toISOString(), epoch);
    }

    // Clear the last-auto-maintain file so maintenance runs
    const maintainFile = join(tmpHome, '.claude-mem-lite', 'runtime', 'last-auto-maintain.json');
    try {
      unlinkSync(maintainFile);
    } catch {}

    db.close();

    // Session-start triggers daily maintenance (purge) and spawns auto-compress background worker.
    // In production, auto-compress runs as a detached process; here we call it directly.
    runHook('session-start', { env: { HOME: tmpHome } });
    runHook('auto-compress', { env: { HOME: tmpHome } });

    const db2 = openTestDb(tmpHome);
    // Should have: 4 original (compressed_into = summaryId) + 1 summary (importance=2)
    const summary = db2
      .prepare("SELECT id, title, importance FROM observations WHERE title LIKE 'Weekly summary%'")
      .get();
    expect(summary).toBeTruthy();
    expect(summary.title).toContain('Weekly summary');
    expect(summary.importance).toBe(2);

    const compressed = db2
      .prepare('SELECT COUNT(*) as c FROM observations WHERE compressed_into = ?')
      .get(summary.id);
    expect(compressed.c).toBe(4);
    db2.close();
  });

  it('auto-maintain worker runs the snapshot pass off the boot path (MED-4)', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);
    const db = openTestDb(tmpHome);
    const now = new Date();
    // A broken row (empty title AND narrative) is a cleanup candidate, so
    // hardDeleteCandidateCount() > 0 and the maintenance pass takes a pre-delete
    // snapshot. That snapshot is the audit's named boot-path blocker (VACUUM INTO).
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'orphan body', 'change', '', '', '', '', '', '[]', '[]', 1, ?, ?)
    `,
    ).run(sessionId, now.toISOString(), now.getTime());
    db.close();
    // Make maintenance due for the worker's internal 24h gate.
    try {
      unlinkSync(join(tmpHome, '.claude-mem-lite', 'runtime', 'last-auto-maintain.json'));
    } catch {
      /* absent */
    }

    // The heavy pass now runs in the detached worker, not synchronously in SessionStart.
    runHook('auto-maintain', { env: { HOME: tmpHome } });

    const memDir = join(tmpHome, '.claude-mem-lite');
    const snaps = readdirSync(memDir).filter((n) => n.includes('.pre-maintain-') && n.endsWith('.bak'));
    expect(snaps.length).toBeGreaterThan(0); // worker took the snapshot
  });

  it('CLAUDE.md is NOT created when none exists (context goes to stdout only)', () => {
    // Pre-v2.30 the hook auto-created CLAUDE.md to inject a context block.
    // Post-v2.30 it must never touch the file: context is stdout-only.
    const projDir3 = join(tmpHome, 'parent', 'noclaudemd');
    mkdirSync(projDir3, { recursive: true });
    // No CLAUDE.md file exists

    const db = openTestDb(tmpHome);
    const now = new Date();
    const sessId = `hook-parent--noclaudemd-${randomUUID().slice(0, 8)}`;
    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'parent--noclaudemd', ?, ?, 'completed')
    `,
    ).run(sessId, sessId, now.toISOString(), now.getTime());
    db.prepare(
      `
      INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES (?, 'parent--noclaudemd', 'Build API', 'API built', 'Add tests', ?, ?)
    `,
    ).run(sessId, now.toISOString(), now.getTime());
    db.close();

    // MEM_NO_AUTO_ADOPT isolates the context-delivery invariant from the v3.13
    // managed-block write (which would legitimately create CLAUDE.md).
    const run = runHook('session-start', {
      env: { HOME: tmpHome, CLAUDE_PROJECT_DIR: projDir3, MEM_NO_AUTO_ADOPT: '1' },
    });

    // CLAUDE.md must NOT be created
    const claudeMdPath = join(projDir3, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(false);

    // Context is delivered via stdout instead
    expect(run.stdout).toContain('<claude-mem-context>');
    expect(run.stdout).toContain('Build API');
  });
});

describe('Suite 8: Session-start context delivery', () => {
  it('session-start emits context via stdout and does not touch CLAUDE.md', () => {
    // Pre-v2.30 this test asserted CLAUDE.md gained a <claude-mem-context> block.
    // Post-v2.30 the block is stdout-only; CLAUDE.md is left untouched.
    // inferProject() does: basename(dirname(path)) + '--' + basename(path)
    const projDir = join(tmpHome, 'parent', 'testproj');
    mkdirSync(projDir, { recursive: true });
    const original = '# My Project\n\nExisting content.\n';
    writeFileSync(join(projDir, 'CLAUDE.md'), original);

    // Seed DB with a session summary for project 'parent--testproj'
    const db = openTestDb(tmpHome);
    const now = new Date();
    const sessionId = `hook-parent--testproj-${randomUUID().slice(0, 8)}`;

    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'parent--testproj', ?, ?, 'completed')
    `,
    ).run(sessionId, sessionId, now.toISOString(), now.getTime());

    db.prepare(
      `
      INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'Fix auth bug', 'Checked login flow', 'Token was expired', 'Fixed token refresh', 'Add tests for token refresh', '[]', '[]', '', ?, ?)
    `,
    ).run(sessionId, now.toISOString(), now.getTime());
    db.close();

    const run = runHook('session-start', {
      // MEM_NO_AUTO_ADOPT isolates the context-delivery invariant from the v3.13
      // managed-block write — this test asserts CLAUDE.md is byte-untouched.
      env: { HOME: tmpHome, CLAUDE_PROJECT_DIR: projDir, MEM_NO_AUTO_ADOPT: '1' },
    });

    // Context appears in hook stdout (the delivery channel Claude actually reads)
    expect(run.stdout).toContain('<claude-mem-context>');
    expect(run.stdout).toContain('</claude-mem-context>');
    expect(run.stdout).toContain('### Last Session');
    expect(run.stdout).toContain('Fix auth bug');
    expect(run.stdout).toContain('Fixed token refresh');

    // CLAUDE.md is untouched — no context block, original content preserved byte-for-byte
    const claudeMd = readFileSync(join(projDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toBe(original);
    expect(claudeMd).not.toContain('<claude-mem-context>');
  });

  it('session-start cleans up legacy <claude-mem-context> block from pre-v2.30 CLAUDE.md', () => {
    // Migration test: users upgrading from v2.29 or earlier will have a stale
    // context block in CLAUDE.md. The hook should remove it on first run.
    const projDir = join(tmpHome, 'parent', 'migrate');
    mkdirSync(projDir, { recursive: true });
    const hint =
      '<!-- claude-mem-lite: auto-updated context. To avoid git noise, add CLAUDE.md to .gitignore -->';
    writeFileSync(
      join(projDir, 'CLAUDE.md'),
      `# My Project\n\n${hint}\n<claude-mem-context>\nstale content from v2.29\n</claude-mem-context>\n\n# Footer\n`,
    );

    // Seed DB so handleSessionStart actually reaches the cleanup path
    const db = openTestDb(tmpHome);
    const now = new Date();
    const sessId = `hook-parent--migrate-${randomUUID().slice(0, 8)}`;
    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'parent--migrate', ?, ?, 'completed')
    `,
    ).run(sessId, sessId, now.toISOString(), now.getTime());
    db.prepare(
      `
      INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES (?, 'parent--migrate', 'Migrate', 'Done', 'Verify', ?, ?)
    `,
    ).run(sessId, now.toISOString(), now.getTime());
    db.close();

    runHook('session-start', { env: { HOME: tmpHome, CLAUDE_PROJECT_DIR: projDir } });

    const claudeMd = readFileSync(join(projDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('# My Project');
    expect(claudeMd).toContain('# Footer');
    expect(claudeMd).not.toContain('<claude-mem-context>');
    expect(claudeMd).not.toContain('stale content from v2.29');
    expect(claudeMd).not.toContain('claude-mem-lite: auto-updated');
  });
});

describe('Suite 9: Hidden Data Dir Migration', () => {
  it('migrates ~/claude-mem-lite/ with runtime dir pre-created by module init', () => {
    // Simulates the race: hook-shared.mjs creates ~/.claude-mem-lite/runtime/
    // at module load time BEFORE ensureDb() runs. Migration must still work.
    const home = makeTmpDir();
    const oldDir = join(home, 'claude-mem-lite');
    const newDir = join(home, '.claude-mem-lite');

    // Old dir with DB
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(join(oldDir, 'runtime'), { recursive: true });
    const oldDbPath = join(oldDir, 'claude-mem-lite.db');
    const db = new Database(oldDbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    const now = new Date();
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?, ?, 'test', ?, ?, 'completed')`,
    ).run('race-sess', 'race-sess', now.toISOString(), now.getTime());
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch) VALUES (?, 'test', 'race marker', 'discovery', 'Race condition marker', '', '', '', '', '[]', '[]', 1, ?, ?)`,
    ).run('race-sess', now.toISOString(), now.getTime());
    db.close();

    // Pre-create new hidden dir with runtime/ (simulates module-level mkdir)
    mkdirSync(join(newDir, 'runtime'), { recursive: true });
    // But NO DB file in new dir
    expect(existsSync(join(newDir, 'claude-mem-lite.db'))).toBe(false);

    const projDir = join(home, 'parent', 'raceproj');
    mkdirSync(projDir, { recursive: true });
    const { exitCode } = runHook('session-start', {
      env: { HOME: home, CLAUDE_PROJECT_DIR: projDir },
    });
    expect(exitCode).toBe(0);

    // Old dir should be gone, data should be in new hidden dir
    expect(existsSync(oldDir)).toBe(false);
    const newDbPath = join(newDir, 'claude-mem-lite.db');
    expect(existsSync(newDbPath)).toBe(true);

    const db2 = new Database(newDbPath, { readonly: true });
    const obs = db2.prepare("SELECT title FROM observations WHERE title = 'Race condition marker'").get();
    db2.close();
    expect(obs).not.toBeUndefined();

    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  });

  it('skips migration when hidden dir already has DB', () => {
    // Both dirs exist with DBs — new dir data must NOT be overwritten
    const home = makeTmpDir();
    const oldDir = join(home, 'claude-mem-lite');
    const newDir = join(home, '.claude-mem-lite');

    // Old dir with old marker
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(join(oldDir, 'runtime'), { recursive: true });
    const oldDb = new Database(join(oldDir, 'claude-mem-lite.db'));
    oldDb.pragma('journal_mode = WAL');
    oldDb.pragma('foreign_keys = OFF');
    initSchema(oldDb);
    const now = new Date();
    oldDb
      .prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?, ?, 'test', ?, ?, 'completed')`,
      )
      .run('old-sess', 'old-sess', now.toISOString(), now.getTime());
    oldDb
      .prepare(
        `INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch) VALUES (?, 'test', 'old data', 'discovery', 'Old marker', '', '', '', '', '[]', '[]', 1, ?, ?)`,
      )
      .run('old-sess', now.toISOString(), now.getTime());
    oldDb.close();

    // New hidden dir with different marker
    mkdirSync(newDir, { recursive: true });
    mkdirSync(join(newDir, 'runtime'), { recursive: true });
    const newDb = new Database(join(newDir, 'claude-mem-lite.db'));
    newDb.pragma('journal_mode = WAL');
    newDb.pragma('foreign_keys = OFF');
    initSchema(newDb);
    newDb
      .prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?, ?, 'test', ?, ?, 'completed')`,
      )
      .run('new-sess', 'new-sess', now.toISOString(), now.getTime());
    newDb
      .prepare(
        `INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch) VALUES (?, 'test', 'new data', 'discovery', 'New marker', '', '', '', '', '[]', '[]', 1, ?, ?)`,
      )
      .run('new-sess', now.toISOString(), now.getTime());
    newDb.close();

    const projDir = join(home, 'parent', 'skipproj');
    mkdirSync(projDir, { recursive: true });
    const { exitCode } = runHook('session-start', {
      env: { HOME: home, CLAUDE_PROJECT_DIR: projDir },
    });
    expect(exitCode).toBe(0);

    // Old dir should still exist (not consumed)
    expect(existsSync(oldDir)).toBe(true);

    // New hidden dir should have its own data preserved (not overwritten)
    const db2 = new Database(join(newDir, 'claude-mem-lite.db'), { readonly: true });
    const newMarker = db2.prepare("SELECT title FROM observations WHERE title = 'New marker'").get();
    const oldMarker = db2.prepare("SELECT title FROM observations WHERE title = 'Old marker'").get();
    db2.close();
    expect(newMarker).not.toBeUndefined();
    expect(oldMarker).toBeUndefined(); // old data NOT merged in

    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  });

  it('migrates dir with already-renamed DB (no file rename needed)', () => {
    // ~/claude-mem-lite/claude-mem-lite.db → ~/.claude-mem-lite/claude-mem-lite.db
    // Only dir migration, DB filename already correct
    const home = makeTmpDir();
    const oldDir = join(home, 'claude-mem-lite');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(join(oldDir, 'runtime'), { recursive: true });

    const dbPath = join(oldDir, 'claude-mem-lite.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    const now = new Date();
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?, ?, 'test', ?, ?, 'completed')`,
    ).run('renamed-sess', 'renamed-sess', now.toISOString(), now.getTime());
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch) VALUES (?, 'test', 'already renamed', 'discovery', 'Already renamed DB', '', '', '', '', '[]', '[]', 1, ?, ?)`,
    ).run('renamed-sess', now.toISOString(), now.getTime());
    db.close();

    const projDir = join(home, 'parent', 'renameproj');
    mkdirSync(projDir, { recursive: true });
    const { exitCode } = runHook('session-start', {
      env: { HOME: home, CLAUDE_PROJECT_DIR: projDir },
    });
    expect(exitCode).toBe(0);

    // Old dir gone, new hidden dir has the DB
    expect(existsSync(oldDir)).toBe(false);
    const newDir = join(home, '.claude-mem-lite');
    const newDbPath = join(newDir, 'claude-mem-lite.db');
    expect(existsSync(newDbPath)).toBe(true);

    // No claude-mem.db should exist (wasn't there to begin with)
    expect(existsSync(join(newDir, 'claude-mem.db'))).toBe(false);

    const db2 = new Database(newDbPath, { readonly: true });
    const obs = db2.prepare("SELECT title FROM observations WHERE title = 'Already renamed DB'").get();
    db2.close();
    expect(obs).not.toBeUndefined();

    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  });

  it('full lifecycle uses hidden dir for all runtime files', () => {
    // Verify session file, episode file, flush file all under ~/.claude-mem-lite/
    const home = makeTmpDir();
    const projDir = join(home, 'parent', 'hiddenproj');
    mkdirSync(projDir, { recursive: true });

    // Session start — creates DB + session file
    const { exitCode: e1 } = runHook('session-start', {
      env: { HOME: home, CLAUDE_PROJECT_DIR: projDir },
    });
    expect(e1).toBe(0);

    const hiddenDir = join(home, '.claude-mem-lite');
    const runtimeDir = join(hiddenDir, 'runtime');

    // DB created under hidden dir
    expect(existsSync(join(hiddenDir, 'claude-mem-lite.db'))).toBe(true);

    // Session file created under hidden dir
    const sessionFiles = readdirSync(runtimeDir).filter((f) => f.startsWith('session-'));
    expect(sessionFiles.length).toBe(1);

    // Post-tool-use → episode buffer under hidden dir
    runHook('post-tool-use', {
      stdin: makeToolPayload(
        'Edit',
        {
          file_path: '/tmp/src/hidden.js',
          old_string: 'old',
          new_string: 'new',
        },
        'OK — edited file',
      ),
      env: { HOME: home, CLAUDE_PROJECT_DIR: projDir },
    });

    const epFiles = readdirSync(runtimeDir).filter((f) => f.startsWith('ep-') && !f.startsWith('ep-flush-'));
    expect(epFiles.length).toBe(1);

    // Stop → session completed, flush file created
    runHook('stop', { env: { HOME: home, CLAUDE_PROJECT_DIR: projDir } });

    const flushFiles = readdirSync(runtimeDir).filter((f) => f.startsWith('ep-flush-'));
    expect(flushFiles.length).toBeGreaterThanOrEqual(1);

    // No unhidden dir should have been created
    expect(existsSync(join(home, 'claude-mem-lite'))).toBe(false);

    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  });
});

// ─── Suite 10: Code Review Fix Validations ──────────────────────────────────

describe('Suite 10: Code Review Fix Validations', () => {
  it('SOURCE_FILES covers all static imports in server.mjs and hook.mjs', async () => {
    // SOURCE_FILES now lives in source-files.mjs (shared between install.mjs and
    // hook-update.mjs). tests/source-files-sync.test.mjs does the full walker
    // check; this quicker spot-check asserts the shared list has not regressed
    // for the two most critical entry points — statically AND dynamically imported.
    const { SOURCE_FILES } = await import('../source-files.mjs');

    const entryFiles = ['server.mjs', 'hook.mjs'];
    const visited = new Set();
    const queue = [...entryFiles];

    while (queue.length > 0) {
      const file = queue.shift();
      if (visited.has(file)) continue;
      visited.add(file);
      const src = readFileSync(resolve(file), 'utf8');
      // Static AND dynamic specifiers. Static-only silently narrowed this walk when P1-8
      // converted six of hook.mjs's imports to `await import()`: four modules and their
      // whole subgraphs left the traversal while the comment above still said it covered
      // the two entry points. Not a coverage LOSS at the time — source-files-sync.test.mjs
      // walks dynamic specifiers too — but a spot-check whose stated scope is wider than
      // its regex is the shape that goes unnoticed the next time.
      const imports = [
        ...[...src.matchAll(/from\s+'\.\/([^']+\.mjs)'/g)].map((m) => m[1]),
        ...[...src.matchAll(/import\s*\(\s*['"]\.\/([^'"]+\.mjs)['"]/g)].map((m) => m[1]),
      ];
      for (const imp of imports) {
        // Resolve './' imports relative to the importing file's dir so a lib/ module's
        // sibling import (lib/compress-core.mjs -> './scrub-record.mjs') maps to
        // lib/scrub-record.mjs, not the repo root.
        const resolved = join(dirname(file), imp);
        if (!visited.has(resolved)) queue.push(resolved);
      }
    }

    for (const file of visited) {
      expect(SOURCE_FILES).toContain(file);
    }
  });

  it('migration preserves DB_DIR when it contains .db files', () => {
    const home = makeTmpDir();
    const oldDir = join(home, 'claude-mem-lite');
    const newDir = join(home, '.claude-mem-lite');

    // Old dir with DB
    mkdirSync(oldDir, { recursive: true });
    const oldDbPath = join(oldDir, 'claude-mem-lite.db');
    const db = new Database(oldDbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    db.close();

    // New dir already has a .db file (user data — must NOT be deleted)
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, 'some-data.db'), 'important data');

    const projDir = join(home, 'parent', 'safetyproj');
    mkdirSync(projDir, { recursive: true });
    const { exitCode } = runHook('session-start', {
      env: { HOME: home, CLAUDE_PROJECT_DIR: projDir },
    });
    expect(exitCode).toBe(0);

    // Both dirs should still exist — migration should NOT have deleted newDir
    expect(existsSync(newDir)).toBe(true);
    expect(existsSync(join(newDir, 'some-data.db'))).toBe(true);
    // Old dir should still exist (migration couldn't proceed)
    expect(existsSync(oldDir)).toBe(true);

    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  });
});

// ─── Suite 11: First-Run Auto-Adopt (v2.33.0 plugin-mode → v2.82.1 any install) ──

describe('Suite 11: first-run auto-adopt', () => {
  function encodedMemdir(home, cwd) {
    // Mirrors memdir.mjs::encodeProjectPath — all non-alphanumerics → '-'
    const encoded = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
    return join(home, '.claude', 'projects', encoded, 'memory');
  }
  // Legacy memory-dir sentinel (pre-v3.13) — used only to assert migration removes it.
  function legacySentinelPresent(home, cwd) {
    const p = join(encodedMemdir(home, cwd), 'MEMORY.md');
    return existsSync(p) && readFileSync(p, 'utf8').includes('claude-mem-lite:begin v1');
  }
  // v3.13 scheme: adopted = managed block in the project-tree CLAUDE.md.
  function adopted(cwd) {
    const p = join(cwd, 'CLAUDE.md');
    return existsSync(p) && readFileSync(p, 'utf8').includes('claude-mem-lite:begin v1');
  }

  it('CLAUDE_PLUGIN_ROOT + first run → adopts + writes marker', () => {
    runHook('session-start', {
      env: {
        HOME: tmpHome,
        CLAUDE_PLUGIN_ROOT: '/tmp/fake-plugin-root',
        MEM_QUIET_HOOKS: undefined,
        MEM_NO_AUTO_ADOPT: undefined,
      },
    });
    expect(adopted(projectDir)).toBe(true);
    // Marker key is inferProject() output — contains "testproj"
    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const markers = readdirSync(runtimeDir).filter((f) => f.startsWith('.auto-adopt-'));
    expect(markers.length).toBeGreaterThan(0);
  });

  // v2.82.1: npm/manual installs (no CLAUDE_PLUGIN_ROOT in hook env) MUST also
  // auto-adopt. Pre-v2.82.1 this test asserted the opposite — and that
  // assertion was the cause of v2.33.0's auto-adopt firing zero times in
  // practice for every user installed via install.mjs (the common path).
  // Regression-locking the npm-mode case here is part of the #4948 promise to
  // catch this on the next install/upgrade.
  it('no CLAUDE_PLUGIN_ROOT (npm/manual install) → DOES adopt', () => {
    runHook('session-start', {
      env: { HOME: tmpHome, MEM_QUIET_HOOKS: undefined, MEM_NO_AUTO_ADOPT: undefined },
    });
    expect(adopted(projectDir)).toBe(true);
    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const markers = readdirSync(runtimeDir).filter((f) => f.startsWith('.auto-adopt-'));
    expect(markers.length).toBeGreaterThan(0);
  });

  // Only MEM_NO_AUTO_ADOPT=1 should block adoption now (CLAUDE_PLUGIN_ROOT
  // gate removed in v2.82.1).
  it('no CLAUDE_PLUGIN_ROOT + MEM_NO_AUTO_ADOPT=1 → does NOT adopt', () => {
    runHook('session-start', {
      env: { HOME: tmpHome, MEM_NO_AUTO_ADOPT: '1', MEM_QUIET_HOOKS: undefined },
    });
    expect(adopted(projectDir)).toBe(false);
  });

  it('CLAUDE_PLUGIN_ROOT + MEM_NO_AUTO_ADOPT=1 → does NOT adopt', () => {
    runHook('session-start', {
      env: {
        HOME: tmpHome,
        CLAUDE_PLUGIN_ROOT: '/tmp/fake-plugin-root',
        MEM_NO_AUTO_ADOPT: '1',
        MEM_QUIET_HOOKS: undefined,
      },
    });
    expect(adopted(projectDir)).toBe(false);
  });

  // v2.82.0: MEM_QUIET_HOOKS no longer gates auto-adopt. It's a stdout
  // suppression knob, not a side-effect kill-switch (PostToolUse still
  // writes the DB under it). Auto-adopt should fire just the same.
  it('CLAUDE_PLUGIN_ROOT + MEM_QUIET_HOOKS=1 → DOES adopt (quiet is stdout-only)', () => {
    runHook('session-start', {
      env: {
        HOME: tmpHome,
        CLAUDE_PLUGIN_ROOT: '/tmp/fake-plugin-root',
        MEM_QUIET_HOOKS: '1',
        MEM_NO_AUTO_ADOPT: undefined,
      },
    });
    expect(adopted(projectDir)).toBe(true);
  });

  // v2.82.0: per-project opt-out via .mem-no-auto-adopt sentinel.
  it('CLAUDE_PLUGIN_ROOT + .mem-no-auto-adopt sentinel → does NOT adopt', () => {
    const memdir = encodedMemdir(tmpHome, projectDir);
    mkdirSync(memdir, { recursive: true });
    writeFileSync(join(memdir, '.mem-no-auto-adopt'), '{}');
    runHook('session-start', {
      env: {
        HOME: tmpHome,
        CLAUDE_PLUGIN_ROOT: '/tmp/fake-plugin-root',
        MEM_QUIET_HOOKS: undefined,
        MEM_NO_AUTO_ADOPT: undefined,
      },
    });
    expect(adopted(projectDir)).toBe(false);
  });

  // v3.13: the SessionStart sync is now IDEMPOTENT and ungated by the one-shot
  // marker (it is the migration vehicle). So removing the block by hand and
  // re-running re-adopts — only `--disable` / MEM_NO_AUTO_ADOPT stops it. This
  // replaces the pre-v3.13 "marker present → skips" behavior.
  it('block removed but marker present → next SessionStart RE-ADOPTS (sync is ungated)', () => {
    const env = {
      HOME: tmpHome,
      CLAUDE_PLUGIN_ROOT: '/tmp/fake-plugin-root',
      MEM_QUIET_HOOKS: undefined,
      MEM_NO_AUTO_ADOPT: undefined,
    };
    runHook('session-start', { env });
    expect(adopted(projectDir)).toBe(true);

    // Simulate a manual block removal while the runtime marker still exists.
    rmSync(join(projectDir, 'CLAUDE.md'), { force: true });
    rmSync(join(projectDir, '.claude'), { recursive: true, force: true });
    expect(adopted(projectDir)).toBe(false);

    runHook('session-start', { env });
    expect(adopted(projectDir)).toBe(true); // re-adopted
  });

  // Full migration integration: a project carrying the legacy memory-dir
  // sentinel gets it stripped AND the CLAUDE.md block written on SessionStart.
  it('legacy memory-dir sentinel is migrated to the CLAUDE.md block on SessionStart', () => {
    const memdir = encodedMemdir(tmpHome, projectDir);
    mkdirSync(memdir, { recursive: true });
    // seed a legacy v1 block + a state sidecar (so the migration proves authorship)
    writeFileSync(
      join(memdir, 'MEMORY.md'),
      '## 用户偏好\n- keep\n<!-- claude-mem-lite:begin v1 -->\n## 插件契约\n- legacy line\n<!-- claude-mem-lite:end -->\n',
    );
    writeFileSync(
      join(memdir, '.plugin_claude_mem_lite_state.json'),
      JSON.stringify({ version: 'v1', bodyHash: 'x', writtenAt: '2026-01-01' }),
    );
    writeFileSync(join(memdir, 'plugin_claude_mem_lite.md'), '# legacy');
    expect(legacySentinelPresent(tmpHome, projectDir)).toBe(true);

    runHook('session-start', {
      env: {
        HOME: tmpHome,
        CLAUDE_PLUGIN_ROOT: '/tmp/fake-plugin-root',
        MEM_QUIET_HOOKS: undefined,
        MEM_NO_AUTO_ADOPT: undefined,
      },
    });

    expect(legacySentinelPresent(tmpHome, projectDir)).toBe(false); // legacy stripped
    expect(existsSync(join(memdir, 'plugin_claude_mem_lite.md'))).toBe(false);
    expect(readFileSync(join(memdir, 'MEMORY.md'), 'utf8')).toContain('- keep'); // user prose kept
    expect(adopted(projectDir)).toBe(true); // new block written
  });
});

describe('Suite: G3 unpersisted-decision reminder (Stop → payload → next SessionStart)', () => {
  function writeTranscript(entries) {
    const p = join(tmpHome, `transcript-${randomUUID().slice(0, 8)}.jsonl`);
    writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return p;
  }
  const bashToolUse = (command) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
  });

  it('finalization prompt + zero persistence → reminder on next session start', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    runHook('user-prompt', {
      stdin: JSON.stringify({ user_prompt: '方案就这样，拍板了，进实现' }),
      env: { HOME: tmpHome },
    });
    const transcript = writeTranscript([bashToolUse('npx vitest run')]);
    runHook('stop', {
      stdin: JSON.stringify({ session_id: randomUUID(), transcript_path: transcript }),
      env: { HOME: tmpHome },
    });

    const payloadFile = join(tmpHome, '.claude-mem-lite', 'runtime', 'cite-recall-parent--testproj.json');
    const payload = JSON.parse(readFileSync(payloadFile, 'utf8'));
    expect(payload.decisionSignal).toBe('拍板');

    const { stdout } = runHook('session-start', { env: { HOME: tmpHome } });
    expect(stdout).toContain('finalized decision');
    expect(stdout).toContain('拍板');
  });

  it('finalization prompt + a mem_defer call → NO reminder', () => {
    runHook('session-start', { env: { HOME: tmpHome } });
    runHook('user-prompt', {
      stdin: JSON.stringify({ user_prompt: '这个设计定稿了' }),
      env: { HOME: tmpHome },
    });
    const transcript = writeTranscript([
      bashToolUse('ls'),
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'mcp__plugin_claude-mem-lite_mem-lite__mem_defer',
              input: { title: 'the decision' },
            },
          ],
        },
      },
    ]);
    runHook('stop', {
      stdin: JSON.stringify({ session_id: randomUUID(), transcript_path: transcript }),
      env: { HOME: tmpHome },
    });

    const payloadFile = join(tmpHome, '.claude-mem-lite', 'runtime', 'cite-recall-parent--testproj.json');
    const payload = JSON.parse(readFileSync(payloadFile, 'utf8'));
    expect(payload.decisionSignal).toBeNull();

    const { stdout } = runHook('session-start', { env: { HOME: tmpHome } });
    expect(stdout).not.toContain('finalized decision');
  });
});

describe('Suite: G1+G2 enrich-save worker (spawned-env recursion guard)', () => {
  it('worker runs under CLAUDE_MEM_HOOK_RUNNING=1 (BG_EVENTS membership) and backfills', () => {
    // queueSaveEnrich spawns the worker with CLAUDE_MEM_HOOK_RUNNING=1 (every
    // background spawn does). hook.mjs's recursion guard exits ANY event not in
    // BG_EVENTS under that env — the live probe caught enrich-save silently
    // no-oping on exactly this line. This test runs the worker in the spawned
    // env; pre-fix it exits(0) before touching the row.
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);
    const db = openTestDb(tmpHome);
    const now = new Date();
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'FTS trigger stale body fix', 'bugfix', 'Fixed stale FTS trigger body', '', 'Trigger body was not updated by CREATE IF NOT EXISTS', '', '', '[]', '[]', 2, ?, ?)
    `,
    ).run(sessionId, now.toISOString(), now.getTime());
    const id = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    db.close();

    runHook('enrich-save', {
      args: [String(id)],
      env: { HOME: tmpHome, CLAUDE_MEM_HOOK_RUNNING: '1', CLAUDE_MEM_METRICS: '1' },
    });

    const db2 = openTestDb(tmpHome);
    const o = db2
      .prepare('SELECT lesson_learned, search_aliases, optimized_at FROM observations WHERE id = ?')
      .get(id);
    db2.close();
    expect(o.lesson_learned).toContain('Mock distilled lesson');
    expect(o.search_aliases).toContain('mock alias one');
    expect(o.search_aliases).toContain('模拟别名');
    expect(o.optimized_at).toBeNull();

    // G13: the worker's outcome must land in metrics — pre-fix handleEnrichSave
    // discarded executeSaveEnrich's reason and the jsonl had zero enrich rows.
    const enrichRows = readMetricRows(tmpHome).filter((r) => r.event === 'enrich_save');
    expect(enrichRows.length).toBe(1);
    expect(enrichRows[0].id).toBe(id);
    expect(enrichRows[0].enriched).toBe(true);
    expect(enrichRows[0].reason).toBe('enriched');
  });
});

describe('Suite: D#60 concurrent-session decay idempotency (G10)', () => {
  it('two CC sessions sharing the memory session file both resolve the same obs', () => {
    // The decay idempotency key was getSessionId() — a PROJECT-scoped file id
    // shared by concurrent same-project CC sessions. Session A resolving obs X
    // uncited stamped last_decided_session_id with the shared id, so session B's
    // pass saw "already decided" and skipped — chronic undercount of
    // decay_seen_count / uncited_streak / adoption denominators. The key must be
    // the CC session UUID from Stop stdin (distinct per session).
    runHook('session-start', { env: { HOME: tmpHome } });
    const sessionId = getSessionIdFromFile(tmpHome);
    const db = openTestDb(tmpHome);
    const now = new Date();
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'parent--testproj', 'decay probe row', 'bugfix', 'Decay probe observation', '', '', '', '', '[]', '[]', 2, ?, ?)
    `,
    ).run(sessionId, now.toISOString(), now.getTime());
    const obsId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    db.close();

    const mkTranscript = (tag) => {
      const p = join(tmpHome, `transcript-${tag}.jsonl`);
      writeFileSync(
        p,
        [
          // Injection surface the decay scan recognizes (error-recall hint shape).
          {
            type: 'attachment',
            attachment: {
              type: 'hook_success',
              command: 'bash "/home/x/.claude-mem-lite/scripts/post-tool-use.sh"',
              stdout: `[claude-mem-lite] Related memories found for this error:\n  #${obsId} [bugfix] Decay probe observation\n`,
            },
          },
          // Main-thread assistant text WITHOUT a #NN citation (text-floor gate).
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'still investigating the failure' }],
            },
          },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n',
      );
      return p;
    };

    const sessionFilePath = join(tmpHome, '.claude-mem-lite', 'runtime', 'session-parent--testproj');
    const sessionFileRaw = readFileSync(sessionFilePath, 'utf8');

    runHook('stop', {
      stdin: JSON.stringify({ session_id: 'cc-session-A', transcript_path: mkTranscript('A') }),
      env: { HOME: tmpHome },
    });
    // Stop unlinks the session file; concurrent session B still holds the SAME
    // memory session id — restore the file to reproduce the shared-key state.
    writeFileSync(sessionFilePath, sessionFileRaw);
    runHook('stop', {
      stdin: JSON.stringify({ session_id: 'cc-session-B', transcript_path: mkTranscript('B') }),
      env: { HOME: tmpHome },
    });

    const db2 = openTestDb(tmpHome);
    const o = db2
      .prepare('SELECT uncited_streak, decay_seen_count FROM observations WHERE id = ?')
      .get(obsId);
    db2.close();
    // Pre-fix: session B is skipped (streak 1, seen 1). Post-fix: both resolve.
    expect(o.uncited_streak).toBe(2);
    expect(o.decay_seen_count).toBe(2);
  });
});
