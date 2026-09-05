// Regression tests for the runtime-dir audit fixes (P2-7 retention, P3-2 perms).
// Each block documents the pre-fix symptom so a future revert is flagged loudly.
//
//   P2-7  server  ${RUNTIME_DIR}/mcp-spawns.log appended one JSON line per process
//                 start with NO retention — the only JSONL sink in the repo without
//                 one (siblings lib/metrics.mjs, lib/err-sampler.mjs,
//                 lib/hook-telemetry.mjs all prune on a 14-day window).
//   P3-2  perms   runtime aux files carrying captured file paths + scrubbed activity
//                 were written at the default umask (0644 — world-readable on a shared
//                 host) while the DB itself is 0600 / its dir 0700 (schema.mjs:968,980).

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  chmodSync,
  existsSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// server.mjs resolves RUNTIME_DIR from CLAUDE_MEM_DIR at import time and does its
// spawn-telemetry write at module scope. Point the data dir at a throwaway sandbox
// BEFORE the dynamic import so importing the module under test never touches the
// developer's real ~/.claude-mem-lite (vitest.config forces CLAUDE_MEM_DIR='').
const SANDBOX = mkdtempSync(join(tmpdir(), 'mem-runtime-harden-'));
process.env.CLAUDE_MEM_DIR = SANDBOX;

const { pruneSpawnLog, hardenRuntimeFiles, SPAWN_LOG_RETENTION_MS, SPAWN_LOG_MAX_LINES } =
  await import('../server.mjs');
const { writeEpisode, episodeFile } = await import('../hook-episode.mjs');

const SERVER_PATH = resolve(import.meta.dirname, '../server.mjs');
const HOOK_SHARED_PATH = resolve(import.meta.dirname, '../hook-shared.mjs');
const POST_TOOL_USE_SCRIPT = resolve(import.meta.dirname, '../scripts/post-tool-use.sh');

const DAY_MS = 86400000;

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

/** One spawn-telemetry record, `agoMs` in the past. Shape matches server.mjs. */
function spawnLine(agoMs) {
  return JSON.stringify({
    ts: new Date(Date.now() - agoMs).toISOString(),
    pid: 1234,
    ppid: 5678,
    argv1: '/plugin/server.mjs',
    version: '0.0.0-test',
  });
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ─── P2-7: mcp-spawns.log retention ─────────────────────────────────────────

describe('P2-7 spawn-log retention', () => {
  it('exposes a 14-day retention window matching the sibling JSONL sinks', () => {
    expect(SPAWN_LOG_RETENTION_MS).toBe(14 * DAY_MS);
  });

  it('drops records older than the retention window and keeps recent ones', () => {
    const dir = freshDir('spawnlog-old-');
    try {
      const log = join(dir, 'mcp-spawns.log');
      const stale = [spawnLine(20 * DAY_MS), spawnLine(30 * DAY_MS), spawnLine(400 * DAY_MS)];
      const fresh = [spawnLine(60_000), spawnLine(2 * DAY_MS)];
      writeFileSync(log, [...stale, ...fresh].join('\n') + '\n');

      const dropped = pruneSpawnLog(log);

      expect(dropped).toBe(3);
      const kept = readFileSync(log, 'utf8').split('\n').filter(Boolean);
      expect(kept).toEqual(fresh);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a fresh log byte-identical (no rewrite when nothing expires)', () => {
    const dir = freshDir('spawnlog-fresh-');
    try {
      const log = join(dir, 'mcp-spawns.log');
      const body = [spawnLine(0), spawnLine(DAY_MS), spawnLine(13 * DAY_MS)].join('\n') + '\n';
      writeFileSync(log, body);

      expect(pruneSpawnLog(log)).toBe(0);
      expect(readFileSync(log, 'utf8')).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps line count when a burst stays inside the window', () => {
    const dir = freshDir('spawnlog-cap-');
    try {
      const log = join(dir, 'mcp-spawns.log');
      const lines = Array.from({ length: SPAWN_LOG_MAX_LINES + 25 }, () => spawnLine(60_000));
      writeFileSync(log, lines.join('\n') + '\n');

      expect(pruneSpawnLog(log)).toBe(25);
      expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(SPAWN_LOG_MAX_LINES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws on a missing log or malformed lines', () => {
    const dir = freshDir('spawnlog-bad-');
    try {
      expect(pruneSpawnLog(join(dir, 'nope.log'))).toBe(0);

      const log = join(dir, 'mcp-spawns.log');
      writeFileSync(log, `not json\n${spawnLine(0)}\n{"ts":42}\n`);
      expect(pruneSpawnLog(log)).toBe(2);
      expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prunes on real server startup (proves the call site is wired, not just the helper)', async () => {
    const memDir = freshDir('spawnlog-e2e-');
    const runtimeDir = join(memDir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const log = join(runtimeDir, 'mcp-spawns.log');
    writeFileSync(log, [spawnLine(30 * DAY_MS), spawnLine(20 * DAY_MS)].join('\n') + '\n');

    const proc = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, CLAUDE_MEM_DIR: memDir, MEM_QUIET_HOOKS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});

    try {
      // The append+prune and the hardenRuntimeFiles sweep are separate statements
      // at server.mjs module scope (~2063 and ~2075). Polling only for the prune
      // and then asserting the MODE reads across a boundary this test does not
      // control: the mode comes from the later sweep, not from the writes — the
      // test seeds `log` with a plain writeFileSync, so its permissions start at
      // 0666 & ~umask (0644 under CI's umask 0022), and a `mode:` option on a
      // write to an EXISTING file is ignored. On a loaded 2-core runner the
      // server can be descheduled between the two statements, so the poll exits
      // on a pruned-but-not-yet-hardened file. Wait for both conditions.
      let rows = [];
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 100));
        rows = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        if (rows.length === 1 && mode(log) === 0o600) break;
      }
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]).pid).toBe(proc.pid);
      // Still a real assertion: if the sweep never runs, the loop above spends its
      // full 10s and this fails with the seeded umask-derived mode.
      expect(mode(log)).toBe(0o600);
    } finally {
      proc.kill('SIGKILL');
      rmSync(memDir, { recursive: true, force: true });
    }
  }, 15_000);
});

// ─── P3-2: owner-only runtime auxiliary files ───────────────────────────────

describe('P3-2 runtime file permissions', () => {
  it('hardenRuntimeFiles tightens a world-readable dir and its files to owner-only', () => {
    const dir = freshDir('harden-');
    try {
      chmodSync(dir, 0o755);
      const reads = join(dir, 'reads-dev--proj.txt');
      const ep = join(dir, 'ep-dev--proj.json');
      writeFileSync(reads, '/home/user/secret-project/plan.md\n');
      writeFileSync(ep, '{}');
      chmodSync(reads, 0o644);
      chmodSync(ep, 0o644);
      const sub = join(dir, 'hook-errors');
      mkdirSync(sub, { mode: 0o700 });

      const touched = hardenRuntimeFiles(dir);

      expect(touched).toBe(2);
      expect(mode(dir)).toBe(0o700);
      expect(mode(reads)).toBe(0o600);
      expect(mode(ep)).toBe(0o600);
      // Subdirectories keep their own (already 0700) mode — files only.
      expect(mode(sub)).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent and never throws on a missing dir', () => {
    const dir = freshDir('harden-idem-');
    try {
      writeFileSync(join(dir, 'a.txt'), 'x');
      expect(hardenRuntimeFiles(dir)).toBe(1);
      expect(hardenRuntimeFiles(dir)).toBe(1);
      expect(mode(dir)).toBe(0o700);
      expect(hardenRuntimeFiles(join(dir, 'gone'))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('post-tool-use.sh creates reads-<project>.txt owner-only', () => {
    const memDir = freshDir('reads-perm-');
    try {
      const r = spawnSync('bash', [POST_TOOL_USE_SCRIPT], {
        input: JSON.stringify({
          session_id: 'perm-test',
          tool_name: 'Read',
          tool_input: { file_path: '/home/user/secret-project/plan.md' },
        }),
        env: {
          ...process.env,
          CLAUDE_MEM_DIR: memDir,
          CLAUDE_PROJECT_DIR: '/tmp/org/proj',
          CLAUDE_MEM_HOOK_RUNNING: '',
        },
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);

      const runtimeDir = join(memDir, 'runtime');
      const readsFile = join(runtimeDir, 'reads-org--proj.txt');
      expect(existsSync(readsFile)).toBe(true);
      expect(readFileSync(readsFile, 'utf8')).toBe('/home/user/secret-project/plan.md\n');
      expect(mode(runtimeDir)).toBe(0o700);
      expect(mode(readsFile)).toBe(0o600);
    } finally {
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  // hardenRuntimeFiles runs only at MCP-server startup (server.mjs). Hooks routinely
  // run BEFORE any server process exists (fresh install), so the runtime dir must be
  // born owner-only at the hook layer too — else its ep-flush files (captured paths +
  // scrubbed activity) sit world-readable until the first server sweep.
  it('hook-shared creates RUNTIME_DIR owner-only without a server sweep (fresh install)', () => {
    const memDir = freshDir('hookdir-fresh-');
    try {
      const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(HOOK_SHARED_PATH)})`], {
        env: { ...process.env, CLAUDE_MEM_DIR: memDir },
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      const runtimeDir = join(memDir, 'runtime');
      expect(existsSync(runtimeDir)).toBe(true);
      expect(mode(runtimeDir)).toBe(0o700);
    } finally {
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  it('hook-shared retroactively hardens a pre-existing world-readable RUNTIME_DIR', () => {
    const memDir = freshDir('hookdir-loose-');
    try {
      const runtimeDir = join(memDir, 'runtime');
      mkdirSync(runtimeDir, { recursive: true });
      chmodSync(runtimeDir, 0o755); // simulate a dir created by an older version at default umask
      const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(HOOK_SHARED_PATH)})`], {
        env: { ...process.env, CLAUDE_MEM_DIR: memDir },
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(mode(runtimeDir)).toBe(0o700);
    } finally {
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  it('writeEpisode persists the episode buffer owner-only', () => {
    writeEpisode({
      sessionId: 's1',
      project: 'p',
      startedAt: 1,
      lastAt: 2,
      files: [],
      entries: [],
      filesRead: [],
    });
    const target = episodeFile();
    try {
      expect(existsSync(target)).toBe(true);
      expect(mode(target)).toBe(0o600);
    } finally {
      rmSync(target, { force: true });
    }
  });
});
