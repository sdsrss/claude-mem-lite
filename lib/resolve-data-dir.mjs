// Single source of truth for resolving the CLAUDE_MEM_DIR data directory.
// Zero runtime deps (node:path + node:os only) so hot-path hook scripts can
// import it without pulling in better-sqlite3.
//
// The env var is a RELOCATION knob: unset → ~/.claude-mem-lite (the common,
// non-relocated case); set → an absolute path on a larger/faster volume.
// Anything else is a mistake we must reject LOUDLY rather than turn into a
// stray directory:
//   - The literal strings "undefined"/"null" arise when a caller interpolates
//     a JS nullish value into a shell env string (e.g. `CLAUDE_MEM_DIR='${x}'`
//     with x === undefined). They are truthy, so `env || default` accepts them
//     and better-sqlite3 then creates a relative `undefined/` dir at cwd.
//   - A relative path silently resolves against each process's cwd, scattering
//     state across directories.
// Falsy (unset/empty) is the only non-absolute value we treat as "use default".
import { homedir, tmpdir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

/**
 * Test-run containment (audit 2026-08-22 P2-4).
 *
 * vitest.config.mjs clears CLAUDE_MEM_DIR for every worker, which stops a relocated
 * dev DB from being read — but it cannot stop a test that never sets the var at all:
 * that test simply resolves the DEFAULT, and the default is the maintainer's real
 * `~/.claude-mem-lite`. It is not hypothetical. During the v3.73.0 release a test
 * wrote a `rateLimited` marker into the live data dir, because the module computed
 * its path at import time and the test's later env stub arrived too late.
 *
 * The guard rides the same channel as the leak: a subprocess that inherits
 * `...process.env` (how e2e tests spawn hooks, and how the var goes missing in the
 * first place) also inherits CLAUDE_MEM_TEST_GUARD, so the redirect follows it there.
 * A subprocess given a curated env has to pass CLAUDE_MEM_DIR explicitly and is safe
 * by construction.
 *
 * It REDIRECTS rather than throws, deliberately. Throwing was tried first and took 181
 * of 289 test files down at collection: schema.mjs resolves the dir at IMPORT time, so
 * every test that imports it — including the hundreds that then use `:memory:` and never
 * touch a file — would have to opt out of a guard they never needed. "Imported the
 * module" is not the failure; "wrote to the real directory" is, and a redirect makes
 * that one impossible while leaving the import harmless.
 *
 * The redirect target is shared per run (CLAUDE_MEM_TEST_SANDBOX, set by
 * tests/global-setup.mjs) so a parent and the subprocess it spawns still agree on one
 * directory — the same reason the ambient env is inherited at all.
 *
 * Escape hatch: CLAUDE_MEM_TEST_GUARD=off, for a test that must exercise real default
 * resolution. It should be rare and it should say why.
 */
function containInTests(dir) {
  if (process.env.CLAUDE_MEM_TEST_GUARD !== '1') return dir;
  // Block ONE directory: the real one. "Anywhere outside os.tmpdir()" was tried first
  // and was wrong twice over — fixtures hardcode '/tmp' while os.tmpdir() follows
  // $TMPDIR (relocated under $HOME by a sandboxed shell), and several suites keep their
  // scratch DB inside the repo at tests/.tmp-*. Both are isolated; neither is the leak.
  // The leak is always the same shape: nobody set CLAUDE_MEM_DIR, so the DEFAULT
  // resolved, and the default is the developer's live database.
  //
  // Compared against the path captured by tests/global-setup.mjs BEFORE the suite
  // relocated anything, not against homedir() — several suites deliberately run with
  // HOME pointed at a fixture, and re-deriving the default here would redirect exactly
  // those legitimate cases while missing the real dir once HOME moved.
  const real = process.env.CLAUDE_MEM_TEST_REALDIR || join(homedir(), '.claude-mem-lite');
  if (resolve(dir) !== resolve(real)) return dir;
  const sandbox = process.env.CLAUDE_MEM_TEST_SANDBOX;
  return sandbox && isAbsolute(sandbox) ? sandbox : join(resolve(tmpdir()), 'claude-mem-test-fallback');
}

/**
 * @param {string|undefined|null} raw  Typically process.env.CLAUDE_MEM_DIR.
 * @returns {string} An absolute data directory.
 * @throws if `raw` is a non-empty, non-absolute value (incl. "undefined"/"null").
 */
export function resolveDataDir(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return containInTests(join(homedir(), '.claude-mem-lite'));
  }
  if (typeof raw !== 'string' || raw === 'undefined' || raw === 'null' || !isAbsolute(raw)) {
    throw new Error(
      `CLAUDE_MEM_DIR must be an absolute path; got ${JSON.stringify(raw)}. ` +
      `Leave it unset to use ~/.claude-mem-lite.`
    );
  }
  return containInTests(raw);
}

/**
 * The runtime directory: episode buffers, per-session markers, cooldowns, hook telemetry.
 *
 * Audit 2026-09-02 P1-14. `CLAUDE_MEM_RUNTIME_DIR` was honoured by exactly the five
 * standalone hook scripts and `scripts/hook-launcher.mjs`, and IGNORED by `hook-shared.mjs`
 * (which `hook.mjs`, `server.mjs`, `hook-context.mjs` and `hook-episode.mjs` all take it
 * from) and by `hook-optimize.mjs`. So setting it did not relocate the runtime dir — it
 * SPLIT it: the `fyi` and `pretool` faces wrote markers to the override while `ups` and
 * `keyctx` read them from the real one. A harness pointing the system at an isolated
 * runtime got a half-isolated one, silently, with no error and no empty directory to
 * notice.
 *
 * The audit's own suggestion was to delete the variable from the five scripts. Measured
 * before copying it: it is load-bearing in ten test files, in `hook-launcher.mjs`, and in
 * `experiment/lib/arms.mjs`, which uses it to keep an experiment arm off the real state.
 * Removing it would have cost all of that to fix a split that one shared resolver fixes.
 * The defect was never that the knob exists — it is that the rule for reading it had eight
 * hand-written homes and two modules that had never heard of it.
 *
 * @param {string} dataDir  An already-resolved data dir (from resolveDataDir).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} An absolute runtime directory.
 */
export function resolveRuntimeDir(dataDir, env = process.env) {
  const raw = env.CLAUDE_MEM_RUNTIME_DIR;
  // Same "falsy means default" rule as above. A relative override is NOT rejected the way
  // CLAUDE_MEM_DIR is: this variable is set by test harnesses that predate that check, and
  // turning a previously-working relative path into a throw would break isolation setups
  // in order to enforce tidiness. It is resolved against cwd instead, so the value is at
  // least absolute by the time anything writes to it.
  if (raw === undefined || raw === null || raw === '') return join(dataDir, 'runtime');
  return isAbsolute(raw) ? raw : resolve(raw);
}
