#!/usr/bin/env node
// launch.mjs — Auto-installs dependencies then starts MCP server
// Uses only Node built-ins so it works before npm install
import { execSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..');

if (!existsSync(join(ROOT, 'node_modules', 'better-sqlite3'))) {
  process.stderr.write('[claude-mem-lite] Installing dependencies...\n');
  try {
    execSync('npm install --omit=dev', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'], // stdout piped (discard), stderr inherit
      timeout: 120_000,
    });
    process.stderr.write('[claude-mem-lite] Dependencies installed\n');
  } catch (e) {
    // Plugin-cache / multi-user / disk-full installs can fail here, and this is not a
    // rare path: Claude Code materializes each new plugin-cache version WITHOUT
    // node_modules, so the guard above opens on the first MCP launch after every
    // plugin update. Without this catch the user sees a Node stack trace.
    //
    // `.split('\n')[0]` is CORRECT here, unlike the four binding-error sites fixed in
    // v3.70.2, and the difference is the `stdio` above: stderr is **inherit**, so
    // npm's own diagnosis (`npm error code EROFS`, `path …`, `rofs EROFS: read-only
    // file system …`) has already streamed straight to the user's terminal by the time
    // we get here — verified by running this file against an unwritable ROOT. With
    // stderr inherited, execSync's `e.message` holds only "Command failed: <cmd>";
    // there is no captured diagnosis to lose. Do NOT "fix" this by piping stderr to
    // recover it: piping is what made a compiling better-sqlite3 look hung under the
    // 5-min bash timeout (bug audit 2026-05), which is why stderr is inherited.
    //
    // A pre-tag review measured `e.message` under `stdio: 'pipe'`, where stderr IS
    // folded into the message, and concluded this line drops the diagnosis. It does
    // not — the stdio differs. Recorded here because the same wrong conclusion is
    // easy to reach from the code alone.
    //
    // `e.status` not `e.code`: execSync failures carry the exit status on `status`,
    // so the old `|| e.code` rung was dead.
    // `?? null` not `!= null`: the loose form is the idiom, but this file is
    // linted under `eqeqeq: always`, and rewriting it as `!== undefined` would
    // be a BEHAVIOUR change — execSync reports a signal kill with `status: null`,
    // which `!== undefined` accepts and would render as "npm exited null".
    // Coalescing first keeps the original both-nullish semantics exactly, `0`
    // included.
    const status = e?.status ?? null;
    const detail = e?.message?.split('\n')[0]
      || (status !== null ? `npm exited ${status}` : '')
      || (e?.signal ? `npm killed by ${e.signal}` : '')
      || 'unknown error';
    process.stderr.write(`[claude-mem-lite] npm install failed in ${ROOT} — ${detail}\n`);
    process.stderr.write(`[claude-mem-lite] Likely cause: read-only directory, disk full, or network blocked.\n`);
    process.stderr.write(`[claude-mem-lite] Repair: cd "${ROOT}" && npm install --omit=dev\n`);
    process.exit(1);
  }
}

// Verify better-sqlite3 native binding matches the current Node ABI. The
// directory-presence check above is necessary but not sufficient: a Node
// version change (e.g. v22 → v24, ABI v127 → v137) leaves node_modules
// intact but the .node binary stale → server FATALs with "Could not locate
// the bindings file" on first DB open. Probe + auto-rebuild before launching.
try {
  const { ensureBetterSqlite3Working, probeBindingInFreshProcess } = await import('../lib/binding-probe.mjs');
  // The rebuild inside ensureBetterSqlite3Working mutates node_modules — the
  // same write class as install/repair/update, and this was the ONE rebuild
  // path outside the shared install.lock: a second MCP launch or a concurrent
  // `install.mjs repair` (hook-launcher heal) could clobber the .node
  // mid-compile. Take the lock for the rebuild-capable path; a live peer →
  // wait up to 10s, then degrade to a probe-only pass (healthy binding
  // proceeds; a broken one defers to the peer instead of racing it).
  const { acquireLock } = await import('../lib/proc-lock.mjs');
  const { resolveDataDir } = await import('../lib/resolve-data-dir.mjs');
  const lockPath = join(resolveDataDir(process.env.CLAUDE_MEM_DIR), 'runtime', 'install.lock'); // runtime-dir:stays-put — install lock serialises real installers
  let release = null;
  for (let i = 0; i < 20 && !(release = acquireLock(lockPath)); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  let verify;
  try {
    if (release) {
      verify = await ensureBetterSqlite3Working(ROOT);
    } else {
      // Out of process, like the rebuild-capable branch above: this process goes
      // on to import the MCP server, and a stale .node loaded here would leave a
      // dead module handle cached for it. Also keeps the exit(1) guidance below
      // reachable — an in-process load of a stale binding can SIGSEGV instead.
      const probe = probeBindingInFreshProcess(ROOT);
      verify = probe.ok
        ? { ok: true, action: 'verified' }
        : { ok: false, error: `${probe.error} (another install/repair holds the lock — not rebuilding concurrently; reconnect with /mcp once it finishes)` };
    }
  } finally {
    if (release) release();
  }
  if (!verify.ok) {
    process.stderr.write(`[claude-mem-lite] better-sqlite3 binding unusable: ${verify.error}\n`);
    process.stderr.write(`[claude-mem-lite] Repair: cd "${ROOT}" && npm rebuild better-sqlite3 --dangerously-allow-all-scripts\n`);
    process.exit(1);
  }
  if (verify.action === 'rebuilt') {
    process.stderr.write('[claude-mem-lite] Rebuilt better-sqlite3 binding for current Node ABI\n');
  }
} catch (e) {
  // Probe module itself failed to load — fall through to server import and let
  // the native FATAL surface as before. Don't block launch on a probe regression.
  process.stderr.write(`[claude-mem-lite] binding probe skipped: ${e.message}\n`);
}

// Verify MCP SDK is importable (exports mapping intact).
// Incomplete installs can leave the directory present but package.json missing,
// causing Node.js to fail resolving subpath exports like /server/mcp.js.
try {
  await import('@modelcontextprotocol/sdk/server/mcp.js');
} catch (firstErr) {
  process.stderr.write(`[claude-mem-lite] MCP SDK broken (${firstErr.code || firstErr.message}) — reinstalling...\n`);
  try {
    execSync('npm install @modelcontextprotocol/sdk --force --omit=dev --no-audit --no-fund', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 60_000,
    });
    // Verify the reinstall actually fixed it
    await import('@modelcontextprotocol/sdk/server/mcp.js');
    process.stderr.write('[claude-mem-lite] MCP SDK repaired\n');
  } catch (e) {
    process.stderr.write(`[claude-mem-lite] MCP SDK repair failed: ${e.message}\n`);
    process.exit(1);
  }
}

// Keep the data-dir code (~/.claude-mem-lite/ — backs the standalone CLI symlink
// and the settings.json hooks) in lockstep with THIS running version. In plugin
// mode the MCP server runs from the plugin cache (kept current by Claude Code's
// marketplace updater) and migrates the shared DB schema forward; the data-dir
// copy is only advanced by the GitHub-tarball auto-update, which plugin mode
// disables and which stalls easily, so it drifts behind and the CLI/hooks then
// fail to open the DB the cache migrated ("schema is vN but binary supports up
// to vN-1"). syncDataDirFromCache copies the source files locally (no network,
// no npm install) so the data-dir becomes exactly the version that owns the DB.
// Best-effort — a sync failure must never block the MCP server launch. It runs
// from the current cache code, so an already-drifted install self-heals on the
// next launch once its cache reaches a version carrying this call.
if (process.env.CLAUDE_PLUGIN_ROOT) {
  try {
    const { syncDataDirFromCache } = await import('../hook-update.mjs');
    await syncDataDirFromCache({ sourceDir: ROOT });
  } catch (e) {
    process.stderr.write(`[claude-mem-lite] data-dir sync skipped: ${e.message}\n`);
  }
}

// Dev mode: prefer ~/.claude-mem-lite/server.mjs (symlinked to source) over
// CLAUDE_PLUGIN_ROOT (potentially stale plugin cache). This ensures the MCP
// server always runs the latest code when installed with `install --dev`.
const dataDir = join(homedir(), '.claude-mem-lite');
const devServer = join(dataDir, 'server.mjs');
let useDevServer = false;
try { useDevServer = existsSync(devServer) && lstatSync(devServer).isSymbolicLink(); } catch {}

if (useDevServer) {
  await import(pathToFileURL(devServer).href);
} else {
  // Preflight: detect incomplete primary install (issue #15) — if relative
  // imports referenced by server.mjs are missing on disk, fall back to the
  // hook-update.mjs-maintained ~/.claude-mem-lite/ copy when healthy, or exit
  // with a clear repair command instead of a Node ERR_MODULE_NOT_FOUND stack.
  const { resolveLaunchEntry } = await import('./launch-preflight.mjs');
  try {
    const entry = resolveLaunchEntry({
      primaryRoot: ROOT,
      fallbackRoot: dataDir,
      warn: (msg) => process.stderr.write(msg + '\n'),
    });
    await import(pathToFileURL(entry.path).href);
  } catch (e) {
    if (e.code === 'INSTALL_INCOMPLETE') {
      process.stderr.write(e.message + '\n');
      process.exit(1);
    }
    throw e;
  }
}
