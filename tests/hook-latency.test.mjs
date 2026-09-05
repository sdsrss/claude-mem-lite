// Hook latency regression tests.
// Each Claude Code hook fires on every tool call / prompt / session-start and
// runs synchronously — wall-clock time directly bills against the user. Before
// this file there was no regression bound: a refactor could land that adds 200ms
// of disk stats on the Edit hot path and only show up as "Claude feels sluggish".
//
// We measure end-to-end (Node spawn + import + DB open + query) on a tiny
// fixture DB. Thresholds are deliberately generous (CI machines vary widely)
// but well under the timeout each hook is gated to in production
// (pre-tool-recall: 3s, post-tool-use: 5s, user-prompt-search: 2s).
//
// CLAUDE_MEM_HOOK_LATENCY_BUDGET_MS env override allows local tightening or
// CI-loosening without touching code.

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, join } from 'path';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { createTestDb } from './test-helpers.mjs';

// CI runners and slow laptops both inflate cold-start latency. The budget is
// intentionally above typical observed (≤300ms locally) so a CI hiccup doesn't
// cause flakes — a 4× regression vs typical is what we actually want to flag.
const PRE_TOOL_RECALL_BUDGET_MS = Number(process.env.CLAUDE_MEM_HOOK_LATENCY_BUDGET_MS) || 1500;
const POST_TOOL_USE_BUDGET_MS = Number(process.env.CLAUDE_MEM_HOOK_LATENCY_BUDGET_MS) || 1500;

const PRE_TOOL_RECALL_SCRIPT = resolve(import.meta.dirname, '../scripts/pre-tool-recall.js');
const POST_TOOL_USE_SCRIPT = resolve(import.meta.dirname, '../scripts/post-tool-use.sh');

describe('hook latency regression', () => {
  let testDir;
  let dbPath;
  let runtimeDir;

  // GUARD — the reason this file's isolation bug survived unnoticed: every other
  // assertion here is a latency bound, so a hook subprocess that writes into the
  // developer's REAL data dir passes green forever. This is the one assertion that
  // can go red for it.
  //
  // Fingerprint-scoped, NOT "the real runtime dir is unchanged": that dir is live —
  // the maintainer's own session hooks write to it while the suite runs — so a
  // listing diff would be flaky. `reads-test.txt` can only be produced by
  // CLAUDE_PROJECT_DIR=/test, which is this file and nothing else in the repo.
  //
  // Absent→present rather than "must be absent", so a stale file left by a pre-fix
  // run cannot masquerade as a fresh regression.
  const REAL_READS_TEST = join(
    process.env.HOME || homedir(),
    '.claude-mem-lite',
    'runtime',
    'reads-test.txt',
  );
  let realReadsTestPreexisted;
  beforeAll(() => {
    realReadsTestPreexisted = existsSync(REAL_READS_TEST);
  });
  afterAll(() => {
    if (realReadsTestPreexisted) return;
    expect(
      existsSync(REAL_READS_TEST),
      `a hook subprocess wrote ${REAL_READS_TEST}: the child env is missing CLAUDE_MEM_DIR, so ` +
        "scripts/post-tool-use.sh:80 resolved $HOME/.claude-mem-lite/runtime instead of this test's sandbox",
    ).toBe(false);
  });

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'hook-latency-'));
    runtimeDir = join(testDir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });

    // Tiny seed DB so we measure overhead, not query cost on a giant corpus.
    dbPath = join(testDir, 'mem.db');
    const db = createTestDb(dbPath);
    db.prepare(
      `
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('test', 'test', 'projects--test', '2026-01-01T00:00:00Z', 1735689600000, 'active')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_modified, files_read, importance, created_at, created_at_epoch)
      VALUES ('test', 'projects--test', 'sample obs body', 'bugfix', 'Fix sample bug in foo.mjs', '', '', '', '["foo.mjs"]', '[]', 2, '2026-01-01T00:00:00Z', 1735689600000)
    `,
    ).run();
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  /**
   * Env for one hook subprocess, fully contained in this test's sandbox.
   *
   * CLAUDE_MEM_DIR is the one the BASH prefilter reads: scripts/post-tool-use.sh:80
   * resolves `${CLAUDE_MEM_DIR:-$HOME/.claude-mem-lite}/runtime` and has never known
   * about CLAUDE_MEM_RUNTIME_DIR (a JS-side name). Without it the post-tool-use case
   * below appended `/test/foo.mjs` to the DEVELOPER'S REAL
   * ~/.claude-mem-lite/runtime/reads-test.txt on every run — 69 lines had piled up
   * before anyone looked, and every run was GREEN, because latency is the only thing
   * this file asserts. The guard at the bottom of the file is what makes that
   * failure mode visible; this helper is what fixes it.
   *
   * One helper rather than three copied env literals: the three spawn sites differ
   * only in the DB path, and a fourth case added later inherits the isolation
   * instead of re-deriving it.
   */
  const hookEnv = (dbPath, extra = {}) => ({
    ...process.env,
    CLAUDE_MEM_DB_PATH: dbPath,
    CLAUDE_MEM_DIR: testDir,
    CLAUDE_MEM_RUNTIME_DIR: runtimeDir,
    CLAUDE_PROJECT_DIR: '/test',
    ...extra,
  });

  it('pre-tool-recall.js completes within latency budget on Edit', () => {
    const hookData = {
      session_id: 'test-session-latency',
      tool_name: 'Edit',
      tool_input: { file_path: '/test/foo.mjs' },
    };

    const start = performance.now();
    const r = spawnSync(process.execPath, [PRE_TOOL_RECALL_SCRIPT], {
      input: JSON.stringify(hookData),
      env: hookEnv(dbPath),
      encoding: 'utf8',
      timeout: 10000,
    });
    const elapsed = performance.now() - start;

    expect(r.status).toBe(0);
    expect(elapsed).toBeLessThan(PRE_TOOL_RECALL_BUDGET_MS);
  });

  it('pre-tool-recall.js exits fast when DB does not exist (no spurious work)', () => {
    const hookData = {
      session_id: 'test-session-latency',
      tool_name: 'Edit',
      tool_input: { file_path: '/test/foo.mjs' },
    };

    const start = performance.now();
    const r = spawnSync(process.execPath, [PRE_TOOL_RECALL_SCRIPT], {
      input: JSON.stringify(hookData),
      env: hookEnv(join(testDir, 'does-not-exist.db')),
      encoding: 'utf8',
      timeout: 5000,
    });
    const elapsed = performance.now() - start;

    expect(r.status).toBe(0);
    // No-DB short-circuit must finish faster than the populated path. We only
    // assert "under budget" rather than "faster than first test" because the
    // gap is dominated by Node spawn — which fluctuates 30%+ run-to-run.
    expect(elapsed).toBeLessThan(PRE_TOOL_RECALL_BUDGET_MS);
  });

  it('post-tool-use.sh fast-filter completes within latency budget', () => {
    // Mock CLAUDE_MEM_LITE_HOOK_NODE so the bash filter doesn't recurse into
    // a real hook.mjs run during this test — we only want to measure the bash
    // pre-filter path, which is the per-tool-call overhead.
    const hookData = {
      session_id: 'test-session-latency',
      tool_name: 'Read',
      tool_input: { file_path: '/test/foo.mjs' },
      tool_response: { success: true },
    };

    const start = performance.now();
    const r = spawnSync('bash', [POST_TOOL_USE_SCRIPT], {
      input: JSON.stringify(hookData),
      // Tell the shell filter not to spawn the heavy Node hook — a no-op binary.
      // The bash filter logic still runs end-to-end, including the Read fast-path
      // that writes reads-<project>.txt, which is why hookEnv's CLAUDE_MEM_DIR
      // matters most on THIS case.
      env: hookEnv(dbPath, { CLAUDE_MEM_LITE_HOOK_NODE: '/bin/true' }),
      encoding: 'utf8',
      timeout: 5000,
    });
    const elapsed = performance.now() - start;

    expect(r.status).toBe(0);
    expect(elapsed).toBeLessThan(POST_TOOL_USE_BUDGET_MS);
  });
});
