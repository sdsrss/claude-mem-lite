#!/usr/bin/env node
// scripts/binding-probe-cli.mjs — SessionStart native-binding probe + bounded heal.
//
// Contract with scripts/setup.sh: exit 0 = binding usable NOW, non-zero = not.
// Everything human-readable goes to stderr — SessionStart stdout is a JSON
// envelope Claude Code parses, so this must never write there.
//
// Extracted (v3.60.1) from an inline `node --input-type=module -e '…'` string
// inside setup.sh. Two load-bearing reasons, both observed rather than assumed:
//   • That form CRASHED. The -e process SIGSEGV'd during exit after a
//     verified-good rebuild (Node v24.18, ~50% of runs, no fatal-error report
//     produced), so a SUCCESSFUL heal exited 139 and setup.sh wrote
//     .deps-broken over a healthy install. install.mjs::rebuildBinding doing
//     the same work as a normal module never reproduced it.
//   • It could not contain an apostrophe. The script was interpolated into a
//     single-quoted bash string, so a single `don't` in a comment truncated the
//     shell command — a footgun that fired during development of this fix.
//
// Rebuilds are bounded to 20s because setup.sh runs under the SessionStart hook
// cap (hooks/hooks.json timeout 30): letting the hook SIGKILL a mid-flight
// node-gyp would leave a partial .node with no flag written. On lock-miss or
// timeout, mark broken and defer to the MCP launch path (no cap, same lock).

import { execSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.PROBE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

// Fallback for a half-installed tree where lib/ helpers are absent: a bare
// probe with no rebuild. A WORKING binding must still be able to clear the
// broken flag, and a helperless broken tree is repaired by the hook-launcher
// path instead. Out of process like every other probe here — loading a stale
// .node caches a dead module handle for the rest of THIS process.
// Output-identical twin of lib/binding-probe.mjs::flattenBindingError, kept here
// because bareProbe runs when lib/ could not be imported. Same 240 cap, same
// ellipsis, same 'unknown' floor — asserted for parity by the tests.
function flattenLocal(err, max = 240) {
  const s = String(err ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return 'unknown';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function bareProbe(root) {
  const script =
    'try {' +
    'const { createRequire } = require("node:module");' +
    `const D = createRequire(${JSON.stringify(join(root, 'package.json'))})("better-sqlite3");` +
    'new D(":memory:").close();' +
    '} catch (e) { process.stdout.write(String((e && e.message) || e)); process.exit(1); }';
  const r = spawnSync(process.execPath, ['-e', script], { stdio: 'pipe', timeout: 8000 });
  if (!r.error && r.status === 0) return true;
  // Say WHY. The inline predecessor printed the cause here; dropping it left the
  // user with setup.sh's generic "binding unusable" and nothing to act on. Flattened
  // rather than first-lined: Node's ABI message puts the filename on line 0 and the
  // NODE_MODULE_VERSION pair on lines 2-3, so `.split('\n')[0]` said WHERE but never
  // WHY — for the exact fault this probe exists to find.
  //
  // Flattening is inlined, NOT lib/binding-probe.mjs::flattenBindingError, because
  // this function is the fallback for a tree where lib/ failed to import — `helpers`
  // is still null on every path that reaches here.
  //
  // The twin must stay byte-identical in OUTPUT, and it did not: the first draft
  // capped with a bare `.slice(0, 240)` while the shared helper appends an ellipsis,
  // so they already disagreed at the one boundary the duplication exists to protect.
  // A comment is not a guard, and this repo's hand-maintained twins have drifted
  // before. tests/binding-error-diagnosis.test.mjs now drives THIS path in a
  // lib/-less tree and asserts parity with the shared helper.
  // Order matters: flattenLocal floors to the string 'unknown', which is truthy, so
  // `flattenLocal(x) || fallback` would make the fallbacks unreachable and swallow a
  // spawn error or an exit code whenever the child printed nothing. Pick the source
  // FIRST, then flatten it.
  const printed = String(r.stdout || '').trim();
  const spawnErr = r.error && r.error.message;
  const why = printed
    ? flattenLocal(printed)
    : spawnErr
      ? flattenLocal(spawnErr)
      : `probe exited ${r.status ?? `on signal ${r.signal}`}`;
  process.stderr.write(`[claude-mem-lite] binding probe: ${why}\n`);
  return false;
}

let helpers = null;
try {
  const [probeMod, lockMod, dirMod] = await Promise.all(
    ['binding-probe.mjs', 'proc-lock.mjs', 'resolve-data-dir.mjs'].map(
      (f) => import(pathToFileURL(join(ROOT, 'lib', f)).href),
    ),
  );
  helpers = { ...probeMod, ...lockMod, ...dirMod };
} catch {
  process.exit(bareProbe(ROOT) ? 0 : 1);
}

// Probe first — read-only, no lock needed. A healthy binding exits here.
// Bounded like every other step: the whole script runs under the SessionStart
// hook cap (hooks/hooks.json timeout 30) and an unbounded probe would spend the
// entire budget before the rebuild it exists to trigger.
const first = helpers.probeBindingInFreshProcess(ROOT, { timeoutMs: 8000 });
if (first.ok) process.exit(0);

// Broken: rebuild ONLY under the shared install.lock. A second MCP launch or an
// install.mjs repair rebuilding the same node_modules concurrently can tear the
// .node mid-compile.
let lockPath;
try {
  lockPath = join(helpers.resolveDataDir(process.env.CLAUDE_MEM_DIR), 'runtime', 'install.lock'); // runtime-dir:stays-put — install lock serialises real installers
} catch (e) {
  // resolveDataDir THROWS on a non-absolute CLAUDE_MEM_DIR. Unhandled, that
  // prints an 8-line rejection stack onto SessionStart stderr; one line is enough.
  process.stderr.write(`[claude-mem-lite] binding probe: ${e.message}\n`);
  process.exit(1);
}
const release = helpers.acquireLock(lockPath);
if (!release) {
  process.stderr.write(
    `[claude-mem-lite] binding probe: ${helpers.flattenBindingError(first.error)} ` +
      '(another install/repair in flight — deferring heal)\n',
  );
  process.exit(1);
}

let result;
try {
  result = await helpers.ensureBetterSqlite3Working(ROOT, {
    // Reuse the probe we already paid for. Without this, ensure() spawns its own
    // default first probe — a second identical child on the critical path, under
    // a hook cap, to re-learn what `first` already says.
    probe: () => first,
    exec: (cmd, opts) => execSync(cmd, { ...opts, timeout: 20000 }),
    verify: () => helpers.probeBindingInFreshProcess(ROOT, { timeoutMs: 8000 }),
    // NOT on this path (A20260906-R8b-P0-1). The source build is
    // `node-gyp clean && node-gyp rebuild`: it deletes build/ before compiling, and a full
    // compile takes ~41 s against the 20 s cap above — so under this budget it does not fail
    // harmlessly, it destroys a binding that was working (measured: DB opens YES → NO, .node
    // gone, SIGTERM at 20.02 s), and repeats every SessionStart because setup.sh writes its
    // marker only on success. The compile belongs on a foreground path with no cap:
    // `claude-mem-lite rebuild-binding`, which is what the repair hints now print.
    sourceBuild: false,
  });
} finally {
  // process.exit skips finally blocks — every exit below this point, so the
  // lock is always released.
  release();
}

if (!result.ok) {
  process.stderr.write(`[claude-mem-lite] binding probe: ${result.error}\n`);
  process.exit(1);
}
if (result.action === 'rebuilt') {
  process.stderr.write('[claude-mem-lite] rebuilt better-sqlite3 binding for current Node ABI\n');
}
process.exit(0);
