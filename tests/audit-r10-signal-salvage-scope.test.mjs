// R10 P3-2 — the SIGTERM/SIGINT episode salvage belongs to the interactive hook only.
//
// It was installed for EVERY hook.mjs invocation, background workers included. Those seven
// workers (llm-episode, llm-summary, auto-compress, llm-optimize, auto-maintain,
// enrich-save, update-check) do not own the live `ep-<project>.json` buffer — the
// interactive session does. So `pkill node`, or a machine shutdown, had every running
// worker flush that buffer to the DB and then unlink it, none of them holding the episode
// lock, while an interactive session was still appending to it.
//
// Driven as real subprocesses under a sandboxed data dir, because hook.mjs process.exit()s
// during import and the handler cannot be reached any other way (the note at the top of
// tests/save-episode-immediate.test.mjs makes the same point).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { projectNameFromDir } from '../project-utils.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(REPO, 'hook.mjs');

let root, dataDir, runtimeDir, projectDir, PROJECT;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-sigsalvage-'));
  dataDir = join(root, 'data');
  runtimeDir = join(dataDir, 'runtime');
  projectDir = join(root, 'probe');
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  // The handler unlinks `ep-${inferProject()}.json`, so the fixture must use the name the
  // CHILD will derive, not one this test invents — a mismatched name makes both cases pass
  // for the wrong reason (nothing to salvage, nothing to delete).
  PROJECT = projectNameFromDir(projectDir);
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function bufferPath(project) {
  return join(runtimeDir, `ep-${project}.json`);
}

/** A buffer with a file-edit entry — significant, so the salvage path really saves it. */
function seedBuffer(project) {
  const p = bufferPath(project);
  writeFileSync(
    p,
    JSON.stringify({
      project,
      sessionId: 'cc-sig-1',
      startedAt: Date.now(),
      lastAt: Date.now(),
      entries: [{ tool: 'Edit', isError: false, file: 'src/auth.mjs', ts: Date.now() }],
      files: ['src/auth.mjs'],
      filesRead: [],
    }),
  );
  return p;
}

/**
 * Start hook.mjs for `event`, leave stdin OPEN so it does not race to exit, wait for it to
 * be alive, SIGTERM it, and wait for exit. Returns whether it was still running when the
 * signal was sent — a case that signals a dead process proves nothing.
 */
function runAndSignal(event, project, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, event, ...extraArgs], {
      env: {
        ...process.env,
        HOME: root,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_PROJECT_DIR: projectDir,
        MEM_NO_AUTO_ADOPT: '1',
        CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
        CLAUDE_MEM_SKIP_SUMMARY: '1',
        CLAUDE_MEM_KEEP_LOW_SIGNAL: '1',
      },
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let exited = false;
    child.on('exit', () => (exited = true));
    setTimeout(() => {
      const wasAlive = !exited;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve({ wasAlive });
      }, 700);
    }, 400);
  });
}

describe('R10 P3-2 — only the interactive hook salvages the episode buffer on a signal', () => {
  it('an interactive hook DOES salvage it — the premise', async () => {
    const p = seedBuffer(PROJECT);
    const { wasAlive } = await runAndSignal('post-tool-use', PROJECT);
    expect(wasAlive, 'the process exited before the signal; this case proves nothing').toBe(true);
    expect(existsSync(p), 'the interactive salvage path stopped working').toBe(false);
  });

  // The background arm is STRUCTURAL, and that is a limitation worth stating rather than
  // papering over. To show the bug behaviourally a background worker must be alive AND have
  // a free event loop when the signal lands. Measured in this sandbox: auto-maintain exits
  // in ~92 ms, llm-optimize ~82 ms, llm-episode / llm-summary / enrich-save / auto-compress
  // all under 400 ms, and update-check lives ~2 s but blocks its loop on a network call, so
  // the handler never runs — verified against the UNFIXED code, where none of the six
  // deleted the buffer. In production they are alive for seconds precisely because they are
  // waiting on model calls, which is when `pkill node` or a shutdown reaches them; a
  // sandbox with no model configured cannot reproduce that.
  //
  // So this pins the gate itself. It goes red on a revert of the fix, which is the shape
  // that matters, and it says out loud what it does not cover.
  it('the salvage handler is gated on BG_EVENTS, before it reads the buffer', () => {
    const src = readFileSync(HOOK, 'utf8');
    expect(src, 'the BG_EVENTS gate on the signal handler is gone').toMatch(
      /const SALVAGES_EPISODE_ON_SIGNAL = !BG_EVENTS\.has\(event\);/,
    );
    const gate = src.indexOf('if (!SALVAGES_EPISODE_ON_SIGNAL)');
    const read = src.indexOf('readEpisodeRaw()');
    expect(gate, 'no early return for background workers').toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    expect(gate, 'the gate must precede the buffer read, or workers still touch it').toBeLessThan(read);
  });

  it('every name in BG_EVENTS is an event the dispatcher actually handles', () => {
    // The gate is only as good as the list. A worker spawned under a name missing from
    // BG_EVENTS would salvage, and — per that list's own docblock — would also exit(0)
    // silently under the recursion guard, so nothing else would report it either.
    const src = readFileSync(HOOK, 'utf8');
    const listed = [...src.matchAll(/const BG_EVENTS = new Set\(\[([\s\S]*?)\]\)/g)][0][1]
      .split(',')
      .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
      .filter((t) => t && !t.startsWith('//'));
    expect(listed.length).toBeGreaterThan(5);
    const cases = new Set([...src.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));
    for (const ev of listed) {
      expect(cases.has(ev), `BG_EVENTS lists "${ev}" but the dispatcher has no case for it`).toBe(true);
    }
    // And every spawnBackground name is IN the list — the direction that lets a worker
    // silently salvage a buffer it does not own.
    const spawned = new Set([...src.matchAll(/spawnBackground\('([a-z-]+)'/g)].map((m) => m[1]));
    expect(spawned.size).toBeGreaterThan(3);
    for (const ev of spawned) {
      expect(listed.includes(ev), `spawnBackground('${ev}') is missing from BG_EVENTS`).toBe(true);
    }
  });
});
