// lib/binding-probe.mjs — better-sqlite3 native binding probe + auto-rebuild.
//
// Shared by install.mjs (verify after `npm install`) and scripts/launch.mjs
// (verify before launching the MCP server). `npm install` exits 0 even when
// the prebuilt .node binary mismatches the running Node ABI (e.g. ABI v137 on
// Node v24), and the presence of node_modules/better-sqlite3/ on disk is not
// sufficient — the binding can be present-but-stale after a Node upgrade.

import { execSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// npm >= 12 blocks lifecycle scripts by default, so a plain `npm rebuild` exits 0
// WITHOUT compiling — see the rebuild() comment below. Single home for the one
// command that actually works, so hints, docs and heal paths cannot drift apart.
export const NATIVE_BINDING_REBUILD_CMD = 'npm rebuild better-sqlite3 --dangerously-allow-all-scripts';

// Set on a re-exec'd child so one failed heal cannot fork-bomb the CLI.
export const BINDING_HEAL_GUARD_ENV = 'CLAUDE_MEM_BINDING_HEALED';

// The native-binding fault family, in the four shapes it actually reaches callers:
//   • ERR_DLOPEN_FAILED            — Node's code for a failed dlopen (ABI mismatch)
//   • NODE_MODULE_VERSION N vs M   — the ABI text itself (some throws carry no code)
//   • Could not locate the bindings file — build/Release missing or never compiled
//   • Module did not self-register — the .node was REPLACED under a process that
//     already dlopen'd the old one; only a fresh process recovers (hence the
//     re-exec in healAndReexec, not an in-process retry)
// Deliberately NARROW: a rebuild cannot fix DB corruption or a missing data dir,
// and misclassifying those would burn a 30s npm run on every fire.
const NATIVE_BINDING_PATTERNS = [
  /NODE_MODULE_VERSION/,
  /Could not locate the bindings file/i,
  /did not self-register/i,
  /invalid ELF header/i,
];

/**
 * True when `err` means "the better-sqlite3 native binding is unusable and a
 * rebuild is the right repair".
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isNativeBindingError(err) {
  if (!err) return false;
  if (err.code === 'ERR_DLOPEN_FAILED') return true;
  // `err ?? ''` covers a thrown STRING: recordHookError accepts any thrown value
  // and already normalizes that shape for its log, so the classifier must not
  // silently read undefined and miss it.
  const msg = String(err.message ?? err ?? '');
  return NATIVE_BINDING_PATTERNS.some((re) => re.test(msg));
}

/**
 * Render a binding error as ONE line without losing the diagnosis.
 *
 * Every surface used to do `String(err).split('\n')[0]`, which is exactly wrong for
 * the ABI-mismatch family this subsystem exists to detect. Node's message puts the
 * filename on line 0 and the `NODE_MODULE_VERSION 127 … requires 137` on lines 2-3,
 * so first-line truncation printed a bare path and dropped the only part that says
 * what is wrong. (The comment in probeBindingInFreshProcess below called that string
 * "the highest-value line doctor prints"; for a stale binding it carried no diagnosis
 * at all.) Collapsing whitespace keeps both the path and the numbers while staying
 * safe for a JSON envelope, a JSONL log record and a one-line hook receipt.
 *
 * @param {unknown} err Error, string, or anything thrown.
 * @param {number} [max] Hard cap; a probe must not be able to flood a receipt.
 * @returns {string}
 */
export function flattenBindingError(err, max = 240) {
  const raw = err instanceof Error ? err.message : err;
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return 'unknown';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Probe better-sqlite3's native binding by importing it from `installDir`'s
 * node_modules and opening an in-memory DB. Returns {ok, error?}.
 *
 * @param {string} installDir Directory containing node_modules/better-sqlite3
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function probeBetterSqlite3Binding(installDir) {
  try {
    const localRequire = createRequire(join(installDir, 'package.json'));
    const Database = localRequire('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Probe the binding from a FRESH child process.
 *
 * Why this exists: better-sqlite3 dlopen's its .node lazily and Node caches the
 * module handle process-wide, so a process that has already touched a STALE
 * binary can never load its replacement — the retry dies with "Module did not
 * self-register" (and, under scripts/setup.sh's probe, a segfault on the way
 * out). Verifying a freshly rebuilt binding therefore has to happen somewhere
 * that never saw the old one. Same constraint healAndReexec re-execs for.
 *
 * Synchronous (spawnSync) to match the surrounding execSync rebuild — this runs
 * in installers and hook-adjacent scripts, never on a request path.
 *
 * @param {string} installDir Directory containing node_modules/better-sqlite3
 * @param {{timeoutMs?: number}} [opts]
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function probeBindingInFreshProcess(installDir, { timeoutMs = 30_000 } = {}) {
  // The child catches and prints the MESSAGE on its own stdout. Two reasons it
  // is not just an uncaught throw read off stderr: an uncaught exception's first
  // stderr line is the stack HEADER (`node:internal/modules/cjs/loader:1520`),
  // not the diagnostic — and this string is the highest-value line `doctor`
  // prints — and any node warning emitted before the throw would land on stderr
  // first and hijack it. The child's stdout is captured by spawnSync and never
  // inherited, so writing there cannot reach a hook's JSON envelope.
  // installDir is interpolated as a JSON string literal, so a path containing
  // quotes/backslashes cannot break out of the script.
  const script =
    'try {' +
    'const { createRequire } = require("node:module");' +
    `const D = createRequire(${JSON.stringify(join(installDir, 'package.json'))})("better-sqlite3");` +
    'new D(":memory:").close();' +
    '} catch (e) { process.stdout.write(String((e && e.message) || e)); process.exit(1); }';
  const r = spawnSync(process.execPath, ['-e', script], { stdio: 'pipe', timeout: timeoutMs });
  // BEFORE the status check: spawnSync's `timeout` is SIGTERM-then-wait, not a
  // deadline, so a child that survives the signal can still exit 0 while
  // r.error is ETIMEDOUT. Reading status alone would call that healthy.
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status === 0) return { ok: true };
  // Fallbacks cover the paths where the catch never ran: a native crash (the
  // SIGSEGV above) or a failure to spawn at all — both leave stdout empty.
  const printed = String(r.stdout || '').trim();
  const stderrLine = String(r.stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return {
    ok: false,
    error: printed || stderrLine || `binding probe exited ${r.status ?? `on signal ${r.signal}`}`,
  };
}

/**
 * Verify better-sqlite3 binding works in `installDir`; if not, run
 * `npm rebuild better-sqlite3` and re-probe. Returns
 * { ok: true, action: 'verified' | 'rebuilt' } on success or
 * { ok: false, error } if rebuild can't fix it. The `probe`, `verify` and
 * `rebuild` deps are injectable so this can be unit-tested without a real npm
 * subprocess.
 *
 * @param {string} installDir Directory containing node_modules/better-sqlite3
 * @param {{probe?: () => Promise<{ok: boolean, error?: string}>, verify?: () => Promise<{ok: boolean, error?: string}> | {ok: boolean, error?: string}, rebuild?: () => Promise<void>, exec?: (cmd: string, opts: object) => void}} [deps]
 * @returns {Promise<{ok: true, action: 'verified' | 'rebuilt'} | {ok: false, error: string}>}
 */
export async function ensureBetterSqlite3Working(installDir, deps = {}) {
  // BOTH probes run out of process by default, because a probe must never
  // poison the process that has to act on its answer. Loading a stale .node
  // caches a dead module handle process-wide (and can SIGSEGV on teardown), so
  // an in-process probe→rebuild→re-probe cycle always ends in "Module did not
  // self-register" — reporting a SUCCESSFUL rebuild as a failure. Measured
  // 2026-08-13 on a real ABI 127-under-137 tree: this function returned
  // {ok:false} while the rebuilt .node loaded fine in a fresh process. Every
  // caller keyed state on that lie — setup.sh wrote .deps-broken over a healthy
  // install, install.mjs::rebuildBinding skipped clearNativeBindingBreakage so
  // the launcher re-spawned npm every 6h forever, and `rebuild-binding` exited 1.
  //
  // Isolating only the SECOND probe is not enough: scripts/launch.mjs imports
  // the MCP server into this very process right after a successful rebuild, so a
  // first probe that dlopened the stale binary would hand the server the dead
  // handle. Cost is one ~40ms spawn on a path that already runs npm.
  //
  // `deps.probe` alone still drives BOTH probes: injected-stub tests keep their
  // existing semantics.
  const probe = deps.probe || (() => probeBindingInFreshProcess(installDir));
  const verify = deps.verify || deps.probe || (() => probeBindingInFreshProcess(installDir));
  // Bounded by default: a node-gyp fallback that stalls (no compiler, a hung
  // registry fetch) must not hang the caller forever — the CLI blocks a user at
  // the terminal, and scripts/setup.sh passes an even tighter 20s cap because it
  // runs under a hook timeout. Callers needing a different budget inject `exec`.
  const exec = deps.exec || ((cmd, opts) => execSync(cmd, { timeout: 240_000, ...opts }));
  const rebuild =
    deps.rebuild ||
    (async () => {
      // npm >= 12 blocks install/lifecycle scripts by default (the `allow-scripts`
      // allowlist ships empty). better-sqlite3's install step
      // (`prebuild-install || node-gyp rebuild`) is what produces the native .node
      // binding, so a plain `npm rebuild better-sqlite3` exits 0 ("rebuilt
      // dependencies successfully") WITHOUT compiling it — the server then FATALs
      // opening the DB and dies before the MCP handshake (client reports -32000),
      // and THIS self-heal silently no-ops on every launch. Re-enable scripts for
      // just this rebuild of our own vetted dependency: `npm rebuild <pkg>` runs
      // only <pkg>'s scripts, so the blast radius is better-sqlite3 alone. Older
      // npm has no such gate and treats the unknown flag as an ignored config; if
      // it instead errors on the flag, fall back to the plain rebuild.
      try {
        exec(NATIVE_BINDING_REBUILD_CMD, { cwd: installDir, stdio: 'pipe' });
      } catch {
        exec('npm rebuild better-sqlite3', { cwd: installDir, stdio: 'pipe' });
      }
    });

  const first = await probe();
  if (first.ok) return { ok: true, action: 'verified' };

  try {
    await rebuild();
  } catch (e) {
    return { ok: false, error: `rebuild failed: ${e.message}` };
  }

  const second = await verify();
  if (second.ok) return { ok: true, action: 'rebuilt' };

  return { ok: false, error: second.error || first.error };
}

/**
 * Foreground heal for a user-invoked process (the CLI): rebuild the binding,
 * then RE-EXEC this process with its original argv and return the child's exit
 * code. The re-exec is not a convenience — better-sqlite3 dlopen's its .node
 * lazily and caches the handle, so a process that has already hit the stale
 * binary cannot use the fresh one: retrying in-process fails with "Module did
 * not self-register" (observed 2026-08-13 while healing this exact fault).
 *
 * Refuses to act when the guard env is already set, so a heal that does not
 * actually fix the binding cannot spawn an unbounded chain of children.
 *
 * @param {{installDir?: string, argv?: string[], env?: Record<string,string|undefined>, ensure?: () => Promise<{ok: boolean, action?: string, error?: string}>, reexec?: (argv: string[], env: Record<string,string|undefined>) => number, log?: (msg: string) => void}} opts
 * @returns {Promise<{healed: true, exitCode: number} | {healed: false, reason: string, error?: string}>}
 */
export async function healAndReexec(opts) {
  const { installDir, argv = process.argv, env = process.env, log = () => {} } = opts;
  const ensure = opts.ensure || (() => ensureBetterSqlite3Working(installDir));
  const reexec =
    opts.reexec ||
    ((childArgv, childEnv) => {
      const r = spawnSync(childArgv[0], childArgv.slice(1), { stdio: 'inherit', env: childEnv });
      return typeof r.status === 'number' ? r.status : 1;
    });

  if (env[BINDING_HEAL_GUARD_ENV]) return { healed: false, reason: 'already-attempted' };

  log(`native DB binding unusable — rebuilding for this Node (${process.version})…`);
  let verify;
  try {
    verify = await ensure();
  } catch (e) {
    return { healed: false, reason: 'rebuild-failed', error: e.message };
  }
  if (!verify.ok) return { healed: false, reason: 'rebuild-failed', error: verify.error };

  log('binding rebuilt — retrying');
  const exitCode = reexec(argv, { ...env, [BINDING_HEAL_GUARD_ENV]: '1' });
  return { healed: true, exitCode };
}
