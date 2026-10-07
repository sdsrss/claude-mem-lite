// lib/worker-data-dir.mjs — a background worker never re-creates a data dir removed while it ran.
//
// spawnBackground's workers are detached and can live a minute (a delay plus an LLM round-trip).
// Every writer they reach created its directory with mkdirSync(..., { recursive: true }), so a
// worker that outlived the data dir re-created the whole path: a test sandbox removed in
// afterEach came back holding only .claude-mem-lite/ (D#258, D#265), and `uninstall` followed by
// a data-dir removal would get one back the same way. A foreground hook still creates the dir
// on first run; only a process its spawner marked as a worker asks.
//
// node:fs only: lib/metrics.mjs and lib/err-sampler.mjs import it, and they must stay leaves.

import { existsSync } from 'node:fs';

const BG_WORKER_ENV = 'CLAUDE_MEM_BG_WORKER';

/**
 * The environment both detached spawners give their child: the recursion guard hook.mjs exempts
 * its own background events from, plus the worker mark this module reads.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function backgroundWorkerEnv(env = process.env) {
  return { ...env, CLAUDE_MEM_HOOK_RUNNING: '1', [BG_WORKER_ENV]: '1' };
}

/**
 * True when this process is a background worker and `dir` does not exist. The caller must then
 * skip the write rather than create `dir`: whoever removed it meant it.
 * @param {string} dir the data dir, or the dir a sink writes into
 * @returns {boolean}
 */
export function workerDirGone(dir) {
  return process.env[BG_WORKER_ENV] === '1' && !existsSync(dir);
}
