// A background worker must not re-create a data dir removed while it ran (D#265).
//
// spawnBackground's workers are detached and can live a minute. Every writer they reached created
// its directory recursively, so a test sandbox removed in afterEach came back holding only
// .claude-mem-lite/ (D#258: one mem-e2e-* dir per full run), and a user's removed data dir would
// come back the same way. Each case below has a premise arm: the same call from a process that is
// NOT marked as a worker still creates the dir, so a pass is not the sink being off.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { backgroundWorkerEnv, workerDirGone } from '../lib/worker-data-dir.mjs';
import { recordMetric } from '../lib/metrics.mjs';
import { maybeSampleError } from '../lib/err-sampler.mjs';
import { recordHookError } from '../lib/hook-telemetry.mjs';
import { shouldRecordOnce } from '../lib/record-once.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PATH = join(REPO, 'hook.mjs');

const homes = [];
function freshHome() {
  const h = mkdtempSync(join(tmpdir(), 'mem-worker-dir-'));
  homes.push(h);
  return h;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

// HOME decides the data dir (~/.claude-mem-lite); every override that would move it is cleared.
function baseEnv(home) {
  const env = { ...process.env, HOME: home, MEM_NO_AUTO_ADOPT: '1' };
  for (const k of ['CLAUDE_MEM_DIR', 'CLAUDE_MEM_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_MEM_BG_WORKER']) {
    delete env[k];
  }
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  return env;
}

describe('backgroundWorkerEnv', () => {
  it('adds the recursion guard and the worker mark, and leaves its input alone', () => {
    const input = { PATH: '/bin' };
    expect(backgroundWorkerEnv(input)).toEqual({
      PATH: '/bin',
      CLAUDE_MEM_HOOK_RUNNING: '1',
      CLAUDE_MEM_BG_WORKER: '1',
    });
    expect(input).toEqual({ PATH: '/bin' });
  });

  // FAILS IF either detached spawner builds its own env again: its child is then not marked, and
  // every guard below is off for it.
  it('is the env both detached spawners give their child', () => {
    for (const file of ['hook-shared.mjs', join('lib', 'save-enrich.mjs')]) {
      const src = readFileSync(join(REPO, file), 'utf8');
      const spawns = [...src.matchAll(/spawn\(process\.execPath,[\s\S]*?\}\)/g)].map((m) => m[0]);
      expect(spawns.length, file).toBeGreaterThan(0);
      for (const s of spawns) expect(s, file).toContain('env: backgroundWorkerEnv()');
    }
  });
});

describe('a worker whose data dir is gone', () => {
  it('workerDirGone is false outside a worker and for a dir that exists', () => {
    const home = freshHome();
    vi.stubEnv('CLAUDE_MEM_BG_WORKER', '');
    expect(workerDirGone(join(home, 'nope'))).toBe(false);
    vi.stubEnv('CLAUDE_MEM_BG_WORKER', '1');
    expect(workerDirGone(home)).toBe(false);
    expect(workerDirGone(join(home, 'nope'))).toBe(true);
  });

  // FAILS IF hook-shared's module-scope runtime-dir mkdir runs in a worker again: it fires on
  // import, before any handler, and re-created ~/.claude-mem-lite/runtime.
  it('hook.mjs started as a worker does not create the data dir', () => {
    const home = freshHome();
    const dataDir = join(home, '.claude-mem-lite');
    const run = (env) =>
      spawnSync(process.execPath, [HOOK_PATH, 'llm-episode', join(home, 'no-such-flush.json')], {
        cwd: home,
        env,
        encoding: 'utf8',
        timeout: 30000,
      });

    const r = run(backgroundWorkerEnv(baseEnv(home)));
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(dataDir)).toBe(false);

    // Premise: the same event without the worker mark (a foreground first run) creates it.
    const p = run({ ...baseEnv(home), CLAUDE_MEM_HOOK_RUNNING: '1' });
    expect(p.status, p.stderr).toBe(0);
    expect(existsSync(dataDir)).toBe(true);
  });

  // FAILS IF hook.mjs drops the worker exit at dispatch: update-check then makes its release
  // lookup for a data dir that is gone (every write after it fails, so only the request shows).
  // Every fetch in the child is recorded and refused; the proxy vars are blanked because the
  // CONNECT tunnel does not go through globalThis.fetch.
  it('a worker whose data dir is gone exits before its handler: no release lookup', () => {
    const home = freshHome();
    const stub = join(home, 'offline-fetch.cjs');
    const log = join(home, 'fetches.txt');
    writeFileSync(
      stub,
      "globalThis.fetch = async (url) => { require('fs').appendFileSync(process.env.PROBE_FETCH_LOG, String(url) + '\\n'); throw new Error('offline'); };\n",
    );
    const offline = { PROBE_FETCH_LOG: log, NODE_OPTIONS: `--require "${stub}"` };
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) offline[k] = '';
    const env = { ...baseEnv(home), ...offline };
    delete env.CLAUDE_MEM_SKIP_UPDATE;
    const fetches = () =>
      existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    const run = (e) =>
      spawnSync(process.execPath, [HOOK_PATH, 'update-check'], { cwd: home, env: e, timeout: 30000 });

    expect(run(backgroundWorkerEnv(env)).status).toBe(0);
    expect(fetches()).toEqual([]);
    expect(existsSync(join(home, '.claude-mem-lite'))).toBe(false);

    // Premise: unmarked, the same child does look the release up (through the stub).
    expect(run({ ...env, CLAUDE_MEM_HOOK_RUNNING: '1' }).status).toBe(0);
    expect(fetches().length).toBeGreaterThan(0);
  });

  // FAILS IF ensureDb creates DB_DIR for a worker: every handler opens the database after its LLM
  // round-trip, which is when a sandbox or a data dir has had time to go.
  it('ensureDb in a worker throws instead of creating the data dir', () => {
    const home = freshHome();
    const dataDir = join(home, '.claude-mem-lite');
    const script =
      `import { ensureDb } from ${JSON.stringify(pathToFileURL(join(REPO, 'schema.mjs')).href)};` +
      `try { const db = ensureDb(); db.close(); console.log('opened'); } catch (e) { console.log('threw ' + e.code); }`;
    const run = (env) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: home,
        env,
        encoding: 'utf8',
      });

    const r = run(backgroundWorkerEnv(baseEnv(home)));
    expect(r.stdout.trim(), r.stderr).toBe('threw CLAUDE_MEM_DATA_DIR_GONE');
    expect(existsSync(dataDir)).toBe(false);

    const p = run(baseEnv(home));
    expect(p.stdout.trim(), p.stderr).toBe('opened');
    expect(existsSync(join(dataDir, 'claude-mem-lite.db'))).toBe(true);
  });

  // FAILS IF a sink mkdirs its directory in a worker again. Each sink is called once marked and
  // once not; the unmarked call is the premise that the sink was on.
  const sinks = [
    ['recordMetric', (dir) => recordMetric(dir, { event: 'probe' }), (dir) => join(dir, 'metrics')],
    [
      'maybeSampleError',
      (dir) => maybeSampleError(new Error('probe'), 'ctx', dir),
      (dir) => join(dir, 'errors'),
    ],
    ['recordHookError', (dir) => recordHookError('probe', new Error('probe'), dir), (dir) => dir],
    ['shouldRecordOnce', (dir) => shouldRecordOnce(dir, 'probe-', 'proj', 'k'), (dir) => dir],
  ];
  it.each(sinks)('%s skips a missing dir in a worker and creates it otherwise', (_name, call, written) => {
    vi.stubEnv('CLAUDE_MEM_METRICS', '1');
    vi.stubEnv('CLAUDE_MEM_CATCH_SAMPLE', '1');
    const dir = join(freshHome(), 'gone');

    vi.stubEnv('CLAUDE_MEM_BG_WORKER', '1');
    call(dir);
    expect(existsSync(dir)).toBe(false);

    vi.stubEnv('CLAUDE_MEM_BG_WORKER', '');
    call(dir);
    expect(existsSync(written(dir))).toBe(true);
  });
});
