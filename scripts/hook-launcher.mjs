#!/usr/bin/env node
// scripts/hook-launcher.mjs — Self-healing wrapper for Node hook entry points.
//
// Why: pre-v2.84 a stale-manifest bug in hook-update.mjs could leave the
// install with a hook.mjs that imports lib/cite-back-hint.mjs (or any other
// newly-added module) while the file itself was never copied. The resulting
// ERR_MODULE_NOT_FOUND killed every hook fire, including the next auto-update
// that would have healed the install. v2.84.0 fixes the root cause; this
// launcher is defense-in-depth for similar future drift (corrupt download,
// half-applied install, manual file deletion).
//
// Behavior: try-import the target entry. On ERR_MODULE_NOT_FOUND originating
// from our install — either a missing relative module (e.url under the install
// dir) or a missing bare dependency like better-sqlite3 (e.url is undefined and
// the importer named in the message is under the install dir) — run
// `install.mjs repair` (rate-limited via a 6h marker file under runtime/) and
// retry the import once. If repair is unavailable or fails, degrade quietly:
// these are best-effort memory hooks, so a broken/missing dependency emits one
// clean recovery line and exits 0 rather than dumping a Node stack trace on
// every fire. On any other (foreign) exception, re-throw so Node's default
// error surface is preserved.
//
// HARD constraint: pure node: imports only. Importing anything from lib/ here
// would defeat the entire purpose — the launcher must survive a broken
// install.

import { existsSync, mkdirSync, writeFileSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = join(__dirname, '..');
// A bogus CLAUDE_MEM_DIR ("undefined"/"null"/relative from a mis-quoted env
// interpolation) must degrade to the default here, not become a stray dir. The
// launcher's pure-node charter (above) forbids importing lib/resolve-data-dir.mjs,
// and its fail-open duty forbids throwing, so mirror that guard inline + lenient:
// non-absolute → default. Data-writing paths import that module and throw instead.
const MEM_DIR = process.env.CLAUDE_MEM_DIR;
const DATA_DIR = MEM_DIR && isAbsolute(MEM_DIR) ? MEM_DIR : join(homedir(), '.claude-mem-lite');
const RUNTIME_DIR = join(DATA_DIR, 'runtime');
const HEAL_MARKER = join(RUNTIME_DIR, 'hook-launcher-lastheal');
const HEAL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// Observable breakage state: written when the launcher degrades a broken install
// to exit 0, cleared once the install is confirmed healthy. `doctor` reads it so
// the intentional silence (no stack trace per fire) stays detectable. (#4/#8)
const BROKEN_MARKER = join(RUNTIME_DIR, 'hook-launcher-broken');

// ── Native-binding (ABI) self-heal ──────────────────────────────────────────
// A stale better_sqlite3.node after a Node upgrade does NOT throw at import time
// — better-sqlite3 dlopen's it lazily at the first `new Database()`, deep inside
// the hook script, whose own catch swallows it. So it never reaches the
// ERR_MODULE_NOT_FOUND path below.
//
// scripts/setup.sh has probed + rebuilt the binding at SessionStart since v3.58,
// but ONLY on plugin-manifest installs: hooks/hooks.json registers setup.sh,
// while an install.mjs-managed settings.json does NOT — it wires the launcher
// alone. On that install shape nothing healed. Field result (2026-08-13): 4 days
// with a dead memory system, 79 failed fires in one day.
//
// The hook scripts now drop a marker on every such fire (via
// lib/hook-telemetry.mjs and lib/native-binding-hint.mjs); this heals from it at
// SESSION-START only — never on the per-tool hot path, where an npm run would
// stall the user's edit.
// Marker dir mirrors the standalone hook scripts (pre-tool-recall /
// pre-skill-bridge), which honor CLAUDE_MEM_RUNTIME_DIR — they write 78 of every
// 79 of these markers, so reading a different dir would mean never healing.
// The last hand-written copy of this rule, and it stays: this launcher runs BEFORE the
// native binding is known to work, so it imports only `node:` builtins on purpose — even
// `lib/resolve-data-dir.mjs` is a module resolution it declines to make on the path whose
// job is to survive a broken install. `lib/resolve-data-dir.mjs::resolveRuntimeDir` is the
// canonical rule (audit 2026-09-02 P1-14). It is NOT identical to it, and saying so was
// wrong: the resolver additionally makes a RELATIVE override absolute (`isAbsolute(raw) ?
// raw : resolve(raw)`), while this expression hands the relative value straight to `fs`,
// which resolves it against cwd at call time instead of at module load. They agree on
// unset, on empty and on an absolute override — the three cases that reach a real install.
// Keep the DEFAULTING behaviour in step; do not read "identical" into the difference.
const NB_RUNTIME_DIR = process.env.CLAUDE_MEM_RUNTIME_DIR || RUNTIME_DIR;
const NB_BROKEN_MARKER = join(NB_RUNTIME_DIR, 'native-binding-broken');
const NB_HEAL_MARKER = join(NB_RUNTIME_DIR, 'native-binding-lastheal');
// Literal, not imported: the pure-`node:` charter above forbids importing lib/
// here (this file must survive a broken install). Kept in sync with
// lib/binding-probe.mjs::NATIVE_BINDING_REBUILD_CMD, which is the single home
// everywhere the charter allows an import.
const NB_MANUAL_CMD = 'npm rebuild better-sqlite3 --dangerously-allow-all-scripts';

// Resolvable invocation of the bundled CLI's repair path. Absolute via
// INSTALL_DIR (import.meta.url) so it works on a plugin-only install, where
// bare `claude-mem-lite` is not on PATH and ~/.claude-mem-lite/ holds no source.
// cli.mjs routes `repair` → install.mjs. (review #3)
const CLI_REPAIR = `node ${join(INSTALL_DIR, 'cli.mjs')} repair`;

// Last-resort recovery string for users whose `cli.mjs repair` path
// itself failed (install.mjs missing / repair errored / retry still drifting).
// Duplicated in install.mjs::repair() catch; both are reachable when local
// scripts are broken, so neither can import a shared constant.
const TARBALL_FALLBACK =
  'T=$(mktemp -d) && curl -sL https://api.github.com/repos/sdsrss/claude-mem-lite/tarball | tar xz -C "$T" --strip-components=1 && node "$T/install.mjs" install';

const [, , entryArg, ...rest] = process.argv;
if (!entryArg) {
  process.stderr.write('[claude-mem-lite] hook-launcher: missing entry argument\n');
  process.exit(1);
}

const entryAbs = entryArg.startsWith('/') ? entryArg : join(INSTALL_DIR, entryArg);

// Swap barrier. An auto-update / repair renames files into the install dir one at
// a time — atomic per file, not per file SET — so a hook process that starts
// mid-swap can resolve its entry from the old version and an import from the new
// one. hook-update.mjs marks that window; skip the fire instead of importing a
// mixed module graph. Hooks are best-effort and the swap lasts ~a second, so the
// next fire runs against a settled install.
//
// Stale-guarded on BOTH pid and ts: an updater killed mid-swap leaves the marker
// behind, and a marker that outlives its writer must never mute hooks permanently.
// Anything unreadable/torn/expired reads as "no swap" — fail-open, like the rest
// of this launcher. Inline (not lib/proc-lock.mjs) per the pure-node: charter.
const SWAP_MARKER = join(RUNTIME_DIR, 'swap-in-progress');
const SWAP_MAX_MS = 2 * 60 * 1000;

function swapInProgress() {
  try {
    const { pid, ts } = JSON.parse(readFileSync(SWAP_MARKER, 'utf8'));
    if (typeof ts !== 'number' || Date.now() - ts > SWAP_MAX_MS) return false;
    if (typeof pid !== 'number' || pid <= 0) return false;
    try {
      process.kill(pid, 0);   // signal 0 = existence probe
      return true;
    } catch (e) {
      return e.code === 'EPERM';   // alive, owned by another user
    }
  } catch {
    return false;   // no marker / unreadable / torn JSON → not a swap
  }
}

if (swapInProgress()) process.exit(0);

async function runEntry({ bustCache = false } = {}) {
  // Mirror direct invocation: process.argv[1] is the entry, [2..] are its args.
  process.argv = [process.argv[0], entryAbs, ...rest];
  // Node ESM caches resolution outcomes (success AND failure) by URL. On the
  // post-self-heal retry the freshly-written module file lives at the same
  // path the first import already cached as ERR_MODULE_NOT_FOUND — without a
  // cache-buster query the second await import() returns the cached rejection
  // and the heal looks like it did nothing.
  const url = pathToFileURL(entryAbs).href + (bustCache ? `?t=${Date.now()}` : '');
  await import(url);
}

// Two ERR_MODULE_NOT_FOUND shapes reach here (both verified against Node 22):
//   • missing relative module → e.url = file://<missing-path> (under install)
//   • missing bare dependency (e.g. a half-installed better-sqlite3) → e.url is
//     UNDEFINED and the message is `Cannot find package '<name>' imported from
//     <importer>`. This is the shape that bricked the hooks: the old
//     file://INSTALL_DIR prefix test never matched it in a dev-dir install, so
//     a missing dependency was misread as a foreign error and re-thrown as a
//     Node stack trace on every hook fire.
// Anchor on any path the error exposes — the missing URL and/or the importer
// (present in both messages as "imported from <path>"). If it sits inside our
// install, a self-heal could fix it.
// package.json dependency set of THIS install — read lazily, best-effort. Lets
// isLocalModuleErr tell a genuinely-ours missing bare dependency (better-sqlite3,
// zod, …) apart from a foreign/mistyped package name that merely happens to be
// imported from an install-dir file. The former is self-healable; the latter is
// a real packaging bug that must surface a Node stack trace rather than be
// swallowed by an exit-0 self-heal. (review #5/#7)
function ownDependencies() {
  try {
    const pkg = JSON.parse(readFileSync(join(INSTALL_DIR, 'package.json'), 'utf8'));
    return new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]);
  } catch {
    return null; // unreadable package.json → caller stays permissive
  }
}

function isLocalModuleErr(e) {
  if (!e || e.code !== 'ERR_MODULE_NOT_FOUND') return false;
  // Missing RELATIVE module: e.url is the missing file's URL. Ours iff it sits
  // under our install dir (the `.claude-mem-lite` substring also covers the
  // symlink-farm dev/direct-install case where INSTALL_DIR is the realpath).
  if (e.url) {
    const p = String(e.url).replace(/^file:\/\//, '');
    return p.startsWith(INSTALL_DIR) || p.includes('.claude-mem-lite');
  }
  // Missing BARE dependency: e.url is UNDEFINED; message is
  // `Cannot find package '<name>' imported from <importer>`. The (.+) capture
  // needs no `m` flag (`.` stops at a newline) and so tolerates a multi-line
  // message that appends a hint line after the importer path — the old
  // `(.+?)\s*$` returned undefined there and misclassified the dep. (review #11/#15)
  const msg = String(e.message || '');
  const importer = /imported from (.+)/.exec(msg)?.[1]?.trim();
  if (!importer) return false;
  const importerPath = importer.replace(/^file:\/\//, '');
  if (!(importerPath.startsWith(INSTALL_DIR) || importerPath.includes('.claude-mem-lite'))) return false;
  // Importer is ours — but only self-heal if the missing package is one we
  // actually declare. A foreign/typo'd name re-throws so the bug is visible.
  const pkgName = /Cannot find package '([^']+)'/.exec(msg)?.[1];
  const deps = ownDependencies();
  if (!deps || !pkgName) return true; // best-effort: can't verify → stay permissive
  // Normalize sub-path / scoped imports to the package root (better-sqlite3/x → better-sqlite3).
  const root = pkgName.startsWith('@') ? pkgName.split('/').slice(0, 2).join('/') : pkgName.split('/')[0];
  return deps.has(root);
}

// Human-readable label for the "Detected broken install (<reason>)" line:
// prefer the missing dependency/module name over a raw path fragment.
function describeFailure(e) {
  const pkg = /Cannot find package '([^']+)'/.exec(String(e.message || ''))?.[1];
  if (pkg) return pkg;
  if (e.url) return String(e.url).split('/').pop();
  return String(e.message || 'unknown').split('/').slice(-2).join('/');
}

function recentHealAttempt() {
  try {
    return Date.now() - statSync(HEAL_MARKER).mtimeMs < HEAL_COOLDOWN_MS;
  } catch { return false; }
}

function recordHealAttempt() {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(HEAL_MARKER, String(Date.now()));
  } catch { /* best-effort */ }
}

// Drop the 6h cooldown once a heal fully resolves. The marker is written BEFORE
// spawn (rate-limits concurrent fires), but a SUCCESSFUL heal must not keep
// blocking an unrelated later breakage that happens within the window. (#6/#9)
function clearHealMarker() {
  try { unlinkSync(HEAL_MARKER); } catch { /* already gone — fine */ }
}

function recordBreakage(reason) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(BROKEN_MARKER, JSON.stringify({ reason, ts: Date.now() }));
  } catch { /* best-effort */ }
}

function clearBreakage() {
  try { if (existsSync(BROKEN_MARKER)) unlinkSync(BROKEN_MARKER); } catch { /* best-effort */ }
}

async function attemptHeal(reason) {
  if (recentHealAttempt()) {
    process.stderr.write(
      `[claude-mem-lite] Self-heal skipped (last attempt < 6h ago).\n` +
      `[claude-mem-lite] Manual recovery: ${CLI_REPAIR}\n` +
      `[claude-mem-lite] If that fails, run: ${TARBALL_FALLBACK}\n`,
    );
    return false;
  }
  recordHealAttempt();
  process.stderr.write(`[claude-mem-lite] Detected broken install (${reason}) — running self-heal\n`);
  const installer = join(INSTALL_DIR, 'install.mjs');
  if (!existsSync(installer)) {
    process.stderr.write(
      `[claude-mem-lite] install.mjs missing at ${installer} — cannot self-heal\n` +
      `[claude-mem-lite] Manual recovery: ${TARBALL_FALLBACK}\n`,
    );
    return false;
  }
  const result = spawnSync(process.execPath, [installer, 'repair'], {
    stdio: 'inherit',
    timeout: 300000,
  });
  return result.status === 0;
}

// Defense-in-depth for plugin-mode version drift: the plugin-cache MCP server
// (kept current by Claude Code) migrates the shared DB schema forward, while
// this data-dir code (the standalone CLI + these hooks) is only advanced by the
// GitHub-tarball auto-update, which plugin mode disables — so it can lag the
// schema and fail to open the DB. syncDataDirFromCache copies the current cache
// source files locally to close that gap. launch.mjs (MCP start) is the primary
// healer; this is a backup that also covers the case where the MCP server never
// starts. Gated to session-start (once per session, OFF the per-tool hot path)
// and fully best-effort: a stale module without the fn, or any error, just
// falls through to the normal entry import. The dynamic import keeps this
// launcher's pure-`node:` static-import charter intact (it must survive a broken
// install even if hook-update.mjs is unimportable).
// → the function this describes is trySyncDataDirFromCache(), below.

// Rebuild the native binding when a prior fire recorded it as unusable.
//
// DETACHED, never awaited. This hook runs under a 15s Claude Code cap
// (hooks/hooks.json) while a rebuild can take far longer — prebuild-install has
// to fetch, and a node-gyp fallback is minutes. Waiting would trade a broken
// binding for a SIGKILL'd session-start (no memory context at all) plus a
// half-written .node, the exact hazard scripts/setup.sh's 20s exec cap documents.
// Detaching costs one fire: the rebuild lands within seconds and the NEXT hook
// fire — usually the same session's first PreToolUse — is already healthy.
// stdio is fully ignored: install.mjs logs to STDOUT, and SessionStart stdout is
// a JSON envelope Claude Code parses, so inheriting it corrupts the fire.
//
// Bounded by its own 6h cooldown so an unfixable case (no prebuild for this Node,
// no compiler, offline) does not re-spawn npm every session. The cooldown is
// dropped once the binding is confirmed healthy, so a LATER unrelated break heals
// immediately instead of waiting out a stale window.
// Best-effort throughout — a heal failure must never stop the hook fire.
function healNativeBindingIfBroken() {
  try {
    if (!existsSync(NB_BROKEN_MARKER)) {
      // Healthy (or already healed by the child) → reset the cooldown.
      try { unlinkSync(NB_HEAL_MARKER); } catch { /* nothing to reset */ }
      return;
    }
    try {
      if (Date.now() - statSync(NB_HEAL_MARKER).mtimeMs < HEAL_COOLDOWN_MS) return;
    } catch { /* no marker → not on cooldown */ }
    try {
      mkdirSync(NB_RUNTIME_DIR, { recursive: true });
      writeFileSync(NB_HEAL_MARKER, String(Date.now()));
    } catch { /* best-effort */ }

    const installer = join(INSTALL_DIR, 'install.mjs');
    if (!existsSync(installer)) {
      process.stderr.write(
        `[claude-mem-lite] native DB binding unusable and install.mjs is missing — run: cd "${INSTALL_DIR}" && ${NB_MANUAL_CMD}\n`,
      );
      return;
    }
    // The CHILD clears the breakage marker, and only on a verified-good rebuild
    // (install.mjs::rebuildBinding). Clearing it here would mean a rebuild that
    // silently did nothing — lock contention, a no-op npm — still reads as
    // "healed", dropping the cooldown and re-spawning npm on every session.
    process.stderr.write(
      '[claude-mem-lite] native DB binding unusable (Node version change?) — rebuilding in the background\n',
    );
    const child = spawn(process.execPath, [installer, 'rebuild-binding'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch { /* best-effort — never block the hook fire */ }
}

async function trySyncDataDirFromCache() {
  try {
    const { syncDataDirFromCache } = await import(
      pathToFileURL(join(INSTALL_DIR, 'hook-update.mjs')).href
    );
    if (typeof syncDataDirFromCache === 'function') await syncDataDirFromCache();
  } catch { /* best-effort — proceed to the normal entry regardless */ }
}

const IS_SESSION_START = rest.includes('session-start');

if (IS_SESSION_START) {
  // Before the entry: this process has not dlopen'd better-sqlite3 yet, so the
  // freshly built .node is picked up by the very fire that follows. (After a
  // failed dlopen, only a NEW process can load the replacement — the module
  // handle is cached and an in-process retry dies with "did not self-register".)
  healNativeBindingIfBroken();
  await trySyncDataDirFromCache();
}


try {
  await runEntry();
  // A clean session-start fire confirms the install is healthy → clear any stale
  // breakage marker. Gated to session-start so the per-tool hot path pays nothing.
  if (IS_SESSION_START) clearBreakage();
  // After the entry too: the fire that DISCOVERS the breakage is the one that
  // records it, so a pre-entry-only check would leave the whole session dead and
  // heal one session late.
  if (IS_SESSION_START) healNativeBindingIfBroken();
} catch (e) {
  if (!isLocalModuleErr(e)) throw e;
  const reason = describeFailure(e);
  const healed = await attemptHeal(reason);
  if (!healed) {
    // Broken/missing dependency we can't repair right now (repair failed, or
    // was skipped within the 6h cooldown). attemptHeal already wrote actionable
    // guidance — degrade quietly instead of re-throwing the original import
    // error, which would spew a Node stack trace on every hook fire. Record the
    // breakage so the exit-0 silence stays observable to `doctor`. (#4/#8)
    recordBreakage(reason);
    process.exit(0);
  }
  try {
    await runEntry({ bustCache: true });
    // Fully healed: drop the cooldown so an UNRELATED later break can heal
    // immediately (#6/#9), and clear the breakage marker.
    clearHealMarker();
    clearBreakage();
  } catch (retryErr) {
    recordBreakage(`retry-failed: ${retryErr.message}`);
    process.stderr.write(
      `[claude-mem-lite] Hook still failing after self-heal: ${retryErr.message}\n` +
      `[claude-mem-lite] Manual recovery: ${TARBALL_FALLBACK}\n`,
    );
    process.exit(0);
  }
}
