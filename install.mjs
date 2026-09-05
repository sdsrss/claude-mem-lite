#!/usr/bin/env node
// claude-mem-lite Installer — Smart install/uninstall/status/doctor

import { execSync, execFileSync } from 'child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  cpSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  readdirSync,
  statSync,
  lstatSync,
} from 'fs';
import { join, resolve, dirname, isAbsolute, basename } from 'path';
import { homedir, tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import { resolveDataDir, resolveRuntimeDir } from './lib/resolve-data-dir.mjs';

const PROJECT_DIR = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)));
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
// Plugin CODE / install location — ALWAYS homedir-rooted. Claude Code's
// settings.json + MCP registration bake ABSOLUTE paths to server.mjs / hooks here,
// and env vars are per-shell (the MCP launcher won't reliably inherit
// CLAUDE_MEM_DIR), so code must NOT follow the relocation env var.
const DATA_DIR = join(homedir(), '.claude-mem-lite');
// User DATA location — DB, managed resources, registry DB, runtime/. Honors
// CLAUDE_MEM_DIR exactly like schema.mjs DB_DIR so the installer WRITES data where
// the runtime/data layer READS it (pre-fix: installer wrote homedir, runtime read
// the relocated dir → preinstalled skills silently vanished, doctor read the wrong
// DB). Equals DATA_DIR when CLAUDE_MEM_DIR is unset (the common case).
const MEM_DATA_DIR = resolveDataDir(process.env.CLAUDE_MEM_DIR);
// Hook-WRITTEN runtime state (breakage markers, ep-flush/pending buffers) lives here.
// Installation-identity state — install.lock, update-state.json, update residue — stays
// under MEM_DATA_DIR on purpose: those are about the one real installation, and moving
// them with a per-harness override would let two concurrent installs take separate locks.
const MEM_RUNTIME_DIR = resolveRuntimeDir(MEM_DATA_DIR);
const DB_PATH = join(MEM_DATA_DIR, 'claude-mem-lite.db');
const OLD_DATA_DIR = join(homedir(), '.claude-mem');

// Detect ephemeral context (npx) — files won't persist after exit
const IS_NPX =
  process.env.npm_command === 'exec' || PROJECT_DIR.includes('_npx') || PROJECT_DIR.includes('.npm/_');

// Both modes install to ~/.claude-mem-lite/ (copies or symlinks)
const INSTALL_DIR = DATA_DIR;
const SERVER_PATH = join(INSTALL_DIR, 'server.mjs');
const HOOK_PATH = join(INSTALL_DIR, 'hook.mjs');
// P2-7: both constants and the predicate come from lib/plugin-key.mjs, which hook.mjs also
// imports — this pair used to be typed out in each.
import { MARKETPLACE_KEY, PLUGIN_KEY, isPluginExplicitlyDisabled } from './lib/plugin-key.mjs';
const NPM_INSTALL_CMD = 'npm install --omit=dev --no-audit --no-fund';

import { RESOURCE_METADATA } from './install-metadata.mjs';
import {
  scanPluginCacheHookPollution,
  hasInstallManagedHooks,
  pluginCacheHookEvents,
} from './plugin-cache-guard.mjs';
import { SOURCE_FILES, HOOK_SCRIPT_FILES } from './source-files.mjs';
import {
  probeBetterSqlite3Binding,
  ensureBetterSqlite3Working,
  NATIVE_BINDING_REBUILD_CMD,
} from './lib/binding-probe.mjs';
import { detectInstallShape, probeRuntimeRoots } from './lib/install-shape.mjs';
import { clearNativeBindingBreakage, readNativeBindingBreakage } from './lib/native-binding-hint.mjs';
import { sweepStaleTestFixtures } from './lib/tmp-fixture-sweep.mjs';
import { acquireLock } from './lib/proc-lock.mjs';
import { atomicWriteFileSync } from './lib/atomic-write.mjs';

// Re-export for backward compatibility — tests/install-hook-scripts.test.mjs
// and any external consumers still import HOOK_SCRIPT_FILES from install.mjs.
// The constant itself moved to source-files.mjs in v2.55 so hook-update.mjs
// can share it without a static cycle.
export { HOOK_SCRIPT_FILES };

// Re-export for backward compatibility — tests/install-bsqlite-probe.test.mjs
// imports these from install.mjs. The implementation moved to lib/binding-probe.mjs
// so scripts/launch.mjs can share the probe without importing install.mjs (which
// pulls heavy install-only deps).
export { probeBetterSqlite3Binding, ensureBetterSqlite3Working };

export function copyHookScripts(srcDir, destDir) {
  for (const name of HOOK_SCRIPT_FILES) {
    const src = join(srcDir, name);
    if (existsSync(src)) copyFileSync(src, join(destDir, name));
  }
}

/**
 * Move legacy `~/.claude-mem/claude-mem.db` (+ -wal/-shm sidecars) to
 * timestamped `*.legacy-backup-<ms>` files inside `newDir`. The legacy DB
 * carries v16 schema (schema_versions plural table); the new claude-mem-lite
 * code expects v28 (schema_version singular + memory_session_id column) and
 * MIGRATIONS[] has no v16→v28 bridge — so loading the legacy DB FATALs on
 * first launch. Backing up rather than copying-as-current lets the new
 * install create a fresh v28 DB while preserving legacy bytes for recovery.
 *
 * Returns: {action: 'noop'|'skip'|'backed-up', backupPath?}
 *   - noop: no legacy DB found
 *   - skip: working `claude-mem-lite.db` already exists in newDir
 *   - backed-up: legacy files renamed to `<newDir>/claude-mem-lite.db.legacy-backup-<ts>` etc.
 */
export function migrateLegacyClaudeMemData(oldDir, newDir, opts = {}) {
  const legacyDb = join(oldDir, 'claude-mem.db');
  const targetDb = join(newDir, 'claude-mem-lite.db');
  if (!existsSync(legacyDb)) return { action: 'noop' };
  if (existsSync(targetDb)) return { action: 'skip' };

  if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });
  const ts = opts.now ?? Date.now();
  const backupPath = join(newDir, `claude-mem-lite.db.legacy-backup-${ts}`);
  renameSync(legacyDb, backupPath);
  for (const ext of ['-wal', '-shm']) {
    const src = legacyDb + ext;
    if (existsSync(src)) renameSync(src, join(newDir, `claude-mem-lite.db${ext}.legacy-backup-${ts}`));
  }
  return { action: 'backed-up', backupPath };
}

/**
 * Derive invocation_name from resource name when metadata doesn't provide one.
 * Rules:
 *   "parent/child" → "parent:child"  (plugin:resource format)
 *   "simple-name"  → "simple-name"   (standalone resource)
 * @param {string} name Resource name
 * @returns {string} Derived invocation name
 */
function deriveInvocationName(name) {
  if (name.includes('/')) return name.replace('/', ':');
  return name;
}

/**
 * Apply curated metadata to existing resource DB entries.
 * Fixes existing installs that have generic name-echo metadata.
 * Also syncs keywords, tech_stack, use_cases and auto-derives invocation_name.
 * @param {Database} rdb Registry database handle
 */
function reindexKnownResources(rdb) {
  const update = rdb.prepare(`
    UPDATE resources SET
      intent_tags = ?, domain_tags = ?,
      capability_summary = ?, trigger_patterns = ?,
      invocation_name = CASE WHEN ? != '' THEN ? ELSE invocation_name END,
      recommendation_mode = CASE WHEN ? != '' THEN ? ELSE recommendation_mode END,
      keywords = CASE WHEN ? != '' THEN ? ELSE keywords END,
      tech_stack = CASE WHEN ? != '' THEN ? ELSE tech_stack END,
      use_cases = CASE WHEN ? != '' THEN ? ELSE use_cases END,
      updated_at = datetime('now')
    WHERE type = ? AND name = ?
  `);

  rdb.transaction(() => {
    for (const [key, meta] of Object.entries(RESOURCE_METADATA)) {
      const sep = key.indexOf(':');
      if (sep < 0) continue; // skip malformed keys without type:name separator
      const type = key.slice(0, sep);
      const name = key.slice(sep + 1);
      const invName = meta.invocation_name || deriveInvocationName(name);
      const recMode = meta.recommendation_mode || '';
      const kw = meta.keywords || '';
      const ts = meta.tech_stack || '';
      const uc = meta.use_cases || '';
      update.run(
        meta.intent_tags,
        meta.domain_tags,
        meta.capability_summary,
        meta.trigger_patterns,
        invName,
        invName,
        recMode,
        recMode,
        kw,
        kw,
        ts,
        ts,
        uc,
        uc,
        type,
        name,
      );
    }
  })();
}

/**
 * Register plugin resources that have no local files (virtual resources).
 * These are skills/agents from other installed plugins that the dispatch
 * system should know about for intelligent recommendation.
 * Only inserts entries that don't already exist in the resources table.
 * @param {Database} rdb Registry database handle
 */
function registerVirtualResources(rdb) {
  const insert = rdb.prepare(`
    INSERT OR IGNORE INTO resources (name, type, status, source, local_path, invocation_name,
      intent_tags, domain_tags, capability_summary, trigger_patterns,
      keywords, tech_stack, use_cases, recommendation_mode,
      created_at, updated_at)
    VALUES (?, ?, 'active', 'preinstalled', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  // Backfill FTS5 fields for existing resources that have empty keywords/tech_stack/use_cases
  const updateFts = rdb.prepare(`
    UPDATE resources SET
      keywords = CASE WHEN (keywords IS NULL OR keywords = '') AND ?1 != '' THEN ?1 ELSE keywords END,
      tech_stack = CASE WHEN (tech_stack IS NULL OR tech_stack = '') AND ?2 != '' THEN ?2 ELSE tech_stack END,
      use_cases = CASE WHEN (use_cases IS NULL OR use_cases = '') AND ?3 != '' THEN ?3 ELSE use_cases END,
      updated_at = datetime('now')
    WHERE type = ?4 AND name = ?5
      AND ((keywords IS NULL OR keywords = '') OR (tech_stack IS NULL OR tech_stack = '') OR (use_cases IS NULL OR use_cases = ''))
  `);

  let count = 0;
  rdb.transaction(() => {
    for (const [key, meta] of Object.entries(RESOURCE_METADATA)) {
      const sep = key.indexOf(':');
      if (sep < 0) continue;
      const type = key.slice(0, sep);
      const name = key.slice(sep + 1);
      const { changes } = insert.run(
        name,
        type,
        meta.invocation_name || deriveInvocationName(name),
        meta.intent_tags || name.replace(/-/g, ' '),
        meta.domain_tags || '',
        meta.capability_summary || `${type}: ${name.replace(/-/g, ' ')}`,
        meta.trigger_patterns || `when user needs ${name.replace(/-/g, ' ')}`,
        meta.keywords || '',
        meta.tech_stack || '',
        meta.use_cases || '',
        meta.recommendation_mode || 'proactive',
      );
      count += changes;

      // Backfill FTS5 fields for existing resources.
      // ?N numbered placeholders REQUIRE object-form binding in better-sqlite3 —
      // positional .run(v1, v2, …) always throws "Too many parameter values"
      // regardless of arg count. Pre-fix this swallow-warned on every install
      // (masked by install.mjs:785 import failure before the v2.84.2 path fix).
      if (changes === 0) {
        updateFts.run({
          1: meta.keywords || '',
          2: meta.tech_stack || '',
          3: meta.use_cases || '',
          4: type,
          5: name,
        });
      }
    }

    // Backfill keywords from preinstalled tags for resources still missing keywords
    try {
      const backfill = rdb.prepare(`
        UPDATE resources SET keywords = (
          SELECT GROUP_CONCAT(json_each.value, ',')
          FROM preinstalled p, json_each(p.tags)
          WHERE p.type = resources.type AND p.name = resources.name
        )
        WHERE (keywords IS NULL OR keywords = '')
          AND EXISTS (
            SELECT 1 FROM preinstalled p
            WHERE p.type = resources.type AND p.name = resources.name
              AND p.tags != '[]' AND p.tags IS NOT NULL
          )
      `);
      backfill.run();
    } catch {}

    // Backfill invocation_name for resources that still have it empty
    // Derive from name: "parent/child" → "parent:child", otherwise use name as-is
    try {
      const emptyInvoc = rdb
        .prepare(
          `
        SELECT id, name FROM resources
        WHERE status = 'active' AND (invocation_name IS NULL OR invocation_name = '')
      `,
        )
        .all();
      if (emptyInvoc.length > 0) {
        const setInvoc = rdb.prepare('UPDATE resources SET invocation_name = ? WHERE id = ?');
        for (const r of emptyInvoc) {
          setInvoc.run(deriveInvocationName(r.name), r.id);
        }
      }
    } catch {}
  })();
  return count;
}

let cmd = process.argv[2];
let flags = new Set(process.argv.slice(3));

function log(msg) {
  console.log(`  ${msg}`);
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

/**
 * Recursive on-disk size of `dir`, in bytes. Bounded by `maxEntries` so a
 * surprise-large tree can never turn a progress line into a long stat storm —
 * returns `{ bytes, truncated }` and callers render truncated sums as "≥ N MB".
 *
 * @param {string} dir Directory to measure (missing dir → 0 bytes).
 * @param {number} [maxEntries=50000] Stat budget.
 * @returns {{bytes: number, truncated: boolean}}
 */
function dirSizeBytes(dir, maxEntries = 50000) {
  let bytes = 0,
    seen = 0,
    truncated = false;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > maxEntries) {
        truncated = true;
        return { bytes, truncated };
      }
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          bytes += statSync(p).size;
        } catch {
          /* raced away */
        }
      }
    }
  }
  return { bytes, truncated };
}

/** Render a byte count as a short human string ("148 MB"). */
function fmtMB(bytes, truncated = false) {
  return `${truncated ? '≥' : ''}${Math.round(bytes / 1048576)} MB`;
}
function warn(msg) {
  console.log(`  ⚠ ${msg}`);
}
function fail(msg) {
  console.log(`  ✗ ${msg}`);
}

// Pure JSON-version field bumper for the release pipeline. Reads `filePath`,
// walks `keyPath` (e.g. `['version']` or `['plugins', 0, 'version']`), and
// rewrites only when the new value differs. Returns `{ changed, prev }` so
// callers can log "X → Y" with the captured-before-mutation value — pre-2.63.0
// the plugin.json branch in syncVersions logged "Y → Y" because it read the
// field after assignment.
export function bumpJsonField(filePath, keyPath, newVal) {
  const json = JSON.parse(readFileSync(filePath, 'utf8'));
  let parent = json;
  for (let i = 0; i < keyPath.length - 1; i++) parent = parent?.[keyPath[i]];
  if (!parent) return { changed: false, prev: undefined };
  const lastKey = keyPath[keyPath.length - 1];
  const prev = parent[lastKey];
  if (prev === newVal) return { changed: false, prev };
  parent[lastKey] = newVal;
  writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
  return { changed: true, prev };
}

// CLAUDE.md's `- **Version**: x.y.z` line, patched to a new version.
//
// Replaces the version TOKEN, not the whole line. The line carries a trailing
// annotation ("— **this exact string is a release guard.**") and the previous
// whole-line form deleted it on the first release after that annotation was
// written. Every gate stayed green through the deletion — publish.yml greps the
// `^- **Version**: <semver>` prefix and install-e2e asserts the same substring,
// so neither can see a truncated tail. Pure + exported for the same reason
// bumpJsonField is: syncVersions gets one testable point of truth per file shape.
//
// @returns patched text, or null when the line is absent (caller warns + skips).
export function patchClaudeMdVersion(text, version) {
  const versionLine = /^(- \*\*Version\*\*: )\d+\.\d+\.\d+(.*)$/m;
  if (!versionLine.test(text)) return null;
  return text.replace(versionLine, (_m, head, tail) => `${head}${version}${tail}`);
}

// Repair instruction for an unregistered hook manifest.
//
// The obvious advice — copy the marketplace clone over the cache copy — is a SILENT
// NO-OP in one real sequence (pre-ship review, finding 3): `install` empties the
// marketplace manifest too, so after `install` + `cleanup-hooks` BOTH files are
// `{"hooks":{}}` and the cp exits 0 having changed nothing, leaving the user staring
// at the same red line. Claude Code also seeds a NEW cache version from that same
// emptied clone. So check the source before prescribing it, and fall back to a
// reinstall — which re-clones the manifest from the repo — when it is empty too.
export function hookManifestRepairHint(cacheRoot, marketplaceRoot) {
  const src = join(marketplaceRoot, 'hooks', 'hooks.json');
  const dst = join(cacheRoot, 'hooks', 'hooks.json');
  return pluginCacheHookEvents(marketplaceRoot).ok
    ? `cp "${src}" "${dst}" && restart Claude Code`
    : `no usable marketplace copy to restore from — reinstall the plugin (/plugin uninstall then /plugin install), then restart Claude Code`;
}

// Doctor's final summary line. Pure function so the 4-way contract
// (clean / warnings-only / issues / mixed) is unit-testable without spinning
// up the full doctor pipeline. `issues` are ✗-level (action required);
// `warnings` are ⚠-level (informational, "All checks passed!" must NOT lie
// about them).
export function buildDoctorSummary(issues, warnings) {
  const wPlural = warnings === 1 ? '' : 's';
  if (issues === 0 && warnings === 0) return 'All checks passed!';
  if (issues === 0) return `All critical checks passed (${warnings} warning${wPlural}).`;
  const warnSuffix = warnings > 0 ? ` (+${warnings} warning${wPlural})` : '';
  return `${issues} issue(s) found.${warnSuffix}`;
}

// Dev installs symlink server.mjs → the project's source file. Used to suppress
// misleading "first run" messages since hook-update.mjs skips state-writes in
// this mode (see hook-update.mjs isDevMode).
function isDevInstall() {
  try {
    const serverPath = join(INSTALL_DIR, 'server.mjs');
    return existsSync(serverPath) && lstatSync(serverPath).isSymbolicLink();
  } catch {
    return false;
  }
}

// Decide what to check out of a registry repo. We only ever copy the manifest's
// `entry.path` subdirs into managed/skills|agents, so the working tree never
// needs the rest of the repo — a partial+sparse clone fetches just those subtrees
// (e.g. davila7/claude-code-templates: 197MB whole repo → a few MB of 3 paths).
// Returns { full, paths }: `full` forces a normal checkout when any entry maps to
// the repo root ('.') — sparse buys nothing there. Unsafe paths ('..'/absolute)
// are dropped here exactly as the copy loop drops them, so they never reach
// `sparse-checkout set`. Pure + exported for unit testing.
export function planRepoSparsePaths(entries) {
  let needsFull = false;
  const paths = [];
  for (const e of entries || []) {
    const p = e && e.path;
    if (!p || p === '.' || p === './') {
      needsFull = true;
      continue;
    }
    if (isAbsolute(p) || String(p).includes('..')) continue; // unsafe — skipped at copy too
    const norm = String(p).replace(/^\.\//, '').replace(/\/+$/, '');
    if (norm && !paths.includes(norm)) paths.push(norm);
  }
  // No usable sparse paths (all root or all unsafe) → a full checkout is the only
  // thing that can produce content; sparse would be an empty, pointless tree.
  return { full: needsFull || paths.length === 0, paths };
}

// True only for a clone this code produced (partial-clone promisor + sparse-checkout
// both on). A legacy full clone returns false → caller re-clones it slim. Detection
// erring false only costs a one-time re-clone (the dir is a rebuildable cache), so
// over-eager migration is safe; under-eager just keeps a fat clone one more cycle.
function isPartialSparseClone(clonePath) {
  const cfg = (key) => {
    try {
      return execFileSync('git', ['-C', clonePath, 'config', '--get', key], {
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
    } catch {
      return '';
    } // missing key → git exits non-zero → treat as unset
  };
  return cfg('remote.origin.promisor') === 'true' && cfg('core.sparseCheckout') === 'true';
}

// ─── Install ────────────────────────────────────────────────────────────────

// Dynamic-import helpers, resolved against the installed copy at INSTALL_DIR
// (lets install.mjs run from a /tmp staging dir whose node_modules is at
// INSTALL_DIR, not the script dir). Used by the resource / db-verify / adopt steps.
const importFromInstall = (rel) => import(pathToFileURL(join(INSTALL_DIR, rel)).href);
const requireFromInstall = createRequire(pathToFileURL(join(INSTALL_DIR, 'package.json')).href);

// ─── install() step helpers (audit P1-9) ──────────────────────────────────────
function installSourceFiles(IS_DEV) {
  // Auto-migrate unhidden dir (~/claude-mem-lite/ → ~/.claude-mem-lite/)
  const oldUnhidden = join(homedir(), 'claude-mem-lite');
  if (!existsSync(DATA_DIR) && existsSync(oldUnhidden)) {
    log('Migrating ~/claude-mem-lite/ → ~/.claude-mem-lite/...');
    renameSync(oldUnhidden, DATA_DIR);
    ok('Directory migrated');
  }

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  // Under relocation the DB/managed/runtime live here, not in the code dir — create it too.
  if (!existsSync(MEM_DATA_DIR)) mkdirSync(MEM_DATA_DIR, { recursive: true });

  if (IS_DEV) {
    log('Dev mode — creating symlinks in ~/.claude-mem-lite/...');
    // Symlink individual source files
    for (const f of SOURCE_FILES) {
      const target = join(PROJECT_DIR, f);
      const link = join(DATA_DIR, f);
      if (existsSync(target)) {
        // Ensure parent dir exists for subdir entries (e.g. 'lib/activity.mjs')
        const linkParent = dirname(link);
        if (!existsSync(linkParent)) mkdirSync(linkParent, { recursive: true });
        // Remove existing file/symlink before creating
        if (existsSync(link))
          try {
            unlinkSync(link);
          } catch {}
        symlinkSync(target, link);
      }
    }
    // Symlink scripts/ directory
    const scriptsLink = join(DATA_DIR, 'scripts');
    if (existsSync(scriptsLink))
      try {
        rmSync(scriptsLink, { recursive: true, force: true });
      } catch {}
    symlinkSync(join(PROJECT_DIR, 'scripts'), scriptsLink);
    // Symlink node_modules/
    const nmLink = join(DATA_DIR, 'node_modules');
    if (existsSync(nmLink))
      try {
        rmSync(nmLink, { recursive: true, force: true });
      } catch {}
    symlinkSync(join(PROJECT_DIR, 'node_modules'), nmLink);
    // Symlink registry/ directory
    const regLink = join(DATA_DIR, 'registry');
    if (existsSync(regLink))
      try {
        rmSync(regLink, { recursive: true, force: true });
      } catch {}
    if (existsSync(join(PROJECT_DIR, 'registry'))) {
      symlinkSync(join(PROJECT_DIR, 'registry'), regLink);
    }
    // commands/ is intentionally NOT linked: Claude Code reads slash commands
    // from the plugin cache (~/.claude/plugins/cache/<mp>/<plugin>/<ver>/commands/)
    // or user-level ~/.claude/commands/, never from ~/.claude-mem-lite/commands/.
    // Pre-v2.55 maintained a symlink/copy here that had no consumers.
    ok('Symlinks created in ~/.claude-mem-lite/ → dev dir');
  } else {
    log('Installing to ~/.claude-mem-lite/...');
    const scriptsDir = join(DATA_DIR, 'scripts');
    if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true });
    for (const f of SOURCE_FILES) {
      const src = join(PROJECT_DIR, f);
      const dst = join(DATA_DIR, f);
      if (existsSync(src)) {
        // Ensure parent dir exists for subdir entries (e.g. 'lib/activity.mjs')
        const dstParent = dirname(dst);
        if (!existsSync(dstParent)) mkdirSync(dstParent, { recursive: true });
        copyFileSync(src, dst);
      }
    }
    // Copy hook scripts (settings.json hook commands point at these — must
    // stay in sync with HOOK_SCRIPT_FILES manifest)
    copyHookScripts(join(PROJECT_DIR, 'scripts'), scriptsDir);
    // Ensure bash script is executable
    try {
      execFileSync('chmod', ['+x', join(scriptsDir, 'post-tool-use.sh')], { stdio: 'pipe' });
    } catch {}
    // commands/ is intentionally NOT copied — see dev-mode branch above.
    // Copy registry manifest
    const registryDir = join(DATA_DIR, 'registry');
    if (!existsSync(registryDir)) mkdirSync(registryDir, { recursive: true });
    const manifestSrc = join(PROJECT_DIR, 'registry', 'preinstalled.json');
    if (existsSync(manifestSrc)) copyFileSync(manifestSrc, join(registryDir, 'preinstalled.json'));
    ok('Source files copied to ~/.claude-mem-lite/');

    // v2.48 P1-4: prune stale top-level .mjs + 0-byte .db files left behind by
    // prior upgrades (e.g. dispatch.mjs removed in v2.20.0, zero-byte mem.db /
    // memory.db / registry.db from pre-consolidation installs). Subdirs +
    // symlinks + non-empty DBs are always preserved.
    try {
      const pruned = pruneStaleInstallFiles(DATA_DIR, SOURCE_FILES);
      if (pruned.length > 0) {
        ok(`Pruned ${pruned.length} stale file(s): ${pruned.map((p) => basename(p)).join(', ')}`);
      }
    } catch (e) {
      /* prune is best-effort — never block install */ void e;
    }
  }
}

async function installDependencies(IS_DEV) {
  // 2. npm install (skip for --dev: node_modules is symlinked)
  if (IS_DEV) {
    ok('Dependencies: using dev dir (symlinked)');
  } else {
    log('Ensuring dependencies installed...');
    try {
      // stderr inherited so users see real-time progress (network slowness,
      // node-gyp compile spinner, prebuild-install fallback messages). With
      // `stdio: 'pipe'` the install appeared to hang under the 5-min Bash
      // timeout when better-sqlite3 had no Node v24 prebuild and had to
      // compile from source — see bug audit 2026-05.
      execSync(NPM_INSTALL_CMD, { cwd: INSTALL_DIR, stdio: ['ignore', 'pipe', 'inherit'] });
      ok('Dependencies installed');
    } catch (e) {
      fail('npm install failed: ' + e.message);
      process.exit(1);
    }
    // npm install exits 0 even when the better-sqlite3 prebuilt .node binary
    // mismatches the running Node ABI (e.g. NODE_MODULE_VERSION 137 on Node v24).
    // Probe and auto-rebuild before declaring success — otherwise the next
    // launch FATALs with "Could not locate the bindings file".
    const verify = await ensureBetterSqlite3Working(INSTALL_DIR);
    if (verify.ok) {
      ok(`better-sqlite3: ${verify.action}`);
    } else {
      fail(`better-sqlite3 binding unusable after rebuild: ${verify.error}`);
      log(
        'Try manually: cd ' + INSTALL_DIR + ' && npm rebuild better-sqlite3 --dangerously-allow-all-scripts',
      );
      process.exit(1);
    }

    // The package this installer is RUNNING from owns a second tree, and after
    // `npm i -g claude-mem-lite` npm >= 12 has left its better-sqlite3 install
    // scripts blocked — so the binding is present-but-uncompiled and nothing
    // above touches it. The shell CLI heals it on first DB use, but only after
    // the user has already seen `doctor` report `2 issue(s) found` on a
    // correct install. Close the window here instead. Never fatal: this tree is
    // not what hooks or the MCP server load.
    if (PROJECT_DIR !== INSTALL_DIR && existsSync(join(PROJECT_DIR, 'node_modules', 'better-sqlite3'))) {
      const selfVerify = await ensureBetterSqlite3Working(PROJECT_DIR);
      if (selfVerify.ok) {
        if (selfVerify.action === 'rebuilt')
          ok(`better-sqlite3: rebuilt for the running package too (${PROJECT_DIR})`);
      } else {
        warn(
          `better-sqlite3 unusable in the package this installer runs from (${PROJECT_DIR}): ${selfVerify.error}`,
        );
        log(
          `  The install itself is fine; the \`claude-mem-lite\` shell command will self-heal on first use, or run: cd ${PROJECT_DIR} && ${NATIVE_BINDING_REBUILD_CMD}`,
        );
      }
    }
  }
}

function createCliSymlink() {
  // 2b. Create global CLI symlink (claude-mem-lite command)
  const cliSource = join(INSTALL_DIR, 'cli.mjs');
  if (existsSync(cliSource)) {
    try {
      execFileSync('chmod', ['+x', cliSource], { stdio: 'pipe' });
    } catch {}
    // Try ~/.local/bin first (user-writable, commonly on PATH)
    const localBin = join(homedir(), '.local', 'bin');
    const cliLink = join(localBin, 'claude-mem-lite');
    try {
      if (!existsSync(localBin)) mkdirSync(localBin, { recursive: true });
      if (existsSync(cliLink)) unlinkSync(cliLink);
      symlinkSync(cliSource, cliLink);
      ok(`CLI: ${cliLink} → ${cliSource}`);
    } catch {
      // Fallback: try /usr/local/bin (may need sudo)
      try {
        const globalLink = '/usr/local/bin/claude-mem-lite';
        if (existsSync(globalLink)) unlinkSync(globalLink);
        symlinkSync(cliSource, globalLink);
        ok(`CLI: ${globalLink} → ${cliSource}`);
      } catch {
        warn('CLI symlink failed — run manually: ln -sf ' + cliSource + ' ~/.local/bin/claude-mem-lite');
      }
    }
  }
}

function registerMcpServer() {
  // 3. Register MCP server (skip if plugin system already handles it)
  // Plugin MCP must stay at root .mcp.json so Claude Code registers plugin:*:mem-lite.
  // Duplicate registrations in practice come from old global install.mjs state
  // (claude mcp add) or stale marketplace copies, not from the cache root itself.
  // Global registration via `claude mcp add` creates a DUPLICATE mcp__mem-lite__* server.
  // The legacy generic name "mem" (pre-v2.78) is also purged so a user who installed in
  // either era ends up with a single canonical "mem-lite" registration.
  // Detect plugin mode: installed_plugins.json has our entry → plugin handles MCP.
  const installedPluginsPath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  let pluginHandlesMcp = false;
  try {
    const installed = JSON.parse(readFileSync(installedPluginsPath, 'utf8'));
    pluginHandlesMcp = !!installed?.plugins?.[PLUGIN_KEY]?.length;
  } catch {
    /* not installed via plugin system */
  }

  if (pluginHandlesMcp) {
    log('MCP server: plugin system handles registration (skipping global)');
    // Clean up stale global registrations (both legacy "mem" and current "mem-lite")
    for (const name of ['mem', 'mem-lite']) {
      try {
        execFileSync('claude', ['mcp', 'remove', '-s', 'user', name], { stdio: 'pipe' });
        ok(`Removed stale global MCP "${name}"`);
      } catch {}
    }
  } else {
    log('Registering MCP server...');
    try {
      // Purge legacy "mem" and any pre-existing "mem-lite" before re-registering
      for (const name of ['mem', 'mem-lite']) {
        try {
          execFileSync('claude', ['mcp', 'remove', '-s', 'user', name], { stdio: 'pipe' });
        } catch {}
        try {
          execFileSync('claude', ['mcp', 'remove', '-s', 'project', name], { stdio: 'pipe' });
        } catch {}
      }
      execFileSync(
        'claude',
        ['mcp', 'add', '-s', 'user', '-t', 'stdio', 'mem-lite', '--', 'node', SERVER_PATH],
        { stdio: 'pipe' },
      );
      ok('MCP server registered: mem-lite');
    } catch (e) {
      fail('MCP registration failed: ' + e.message);
      warn('Try manually: claude mcp add -s user -t stdio mem-lite -- node ' + SERVER_PATH);
    }
  }
}

function dedupePluginCacheAndHooks({ managedHooks } = {}) {
  // 3b. Deduplicate: if marketplace plugin also registers MCP + hooks,
  // clear them to prevent double execution. install.mjs hooks (in settings.json)
  // point to ~/.claude-mem-lite/ (latest code in dev mode via symlinks),
  // while plugin hooks use ${CLAUDE_PLUGIN_ROOT} (potentially stale marketplace copy).
  //
  // MCP dedup: Claude Code copies .mcp.json from marketplace clone → plugin cache.
  // Do NOT modify marketplace .mcp.json — it breaks the MCP server registration chain.
  // Dedup is handled by skipping global `claude mcp add` when plugin system is active.
  const pluginDir = join(homedir(), '.claude', 'plugins', 'marketplaces', MARKETPLACE_KEY);
  const pluginHooksPath = join(pluginDir, 'hooks', 'hooks.json');

  // Clearing is a DEDUP, and a dedup with only one registration left is a delete.
  // Both clearers below empty a file Claude Code reads hooks from; that is correct
  // only while settings.json ALSO registers them. On a plugin-only install (no
  // install.mjs-managed entries) the cache manifest is the sole registration, so
  // clearing it silently unregisters all seven events — and status/doctor then read
  // "settings.json holds none" as the healthy plugin shape. plugin-cache-guard.mjs
  // has documented this precondition since it was written and hook.mjs's self-heal
  // honours it; these two sites did not.
  //
  // `managedHooks` comes from the caller rather than a bare hasInstallManagedHooks()
  // call, and that is the whole point: install() runs configureHooks() first, so a
  // self-read here is ALWAYS true and the guard would be decorative — the real
  // protection would be the call ORDER, which nothing pins and a future reorder
  // would silently revert (pre-ship review, finding 1). Passing the value makes the
  // dependency data, not sequence. Explicit `false` is honoured; omitted → self-read,
  // for any caller that has not just written settings.json.
  const settingsOwnsHooks = managedHooks ?? hasInstallManagedHooks();

  // Scope note (pre-ship review, finding 2): the gate covers the two hook-CLEARING
  // blocks only. The launch.mjs / launch-preflight.mjs sync below it is not dedup —
  // it is issue #15's dev-mode MCP routing fix — and an early return out of the whole
  // function would silently stop shipping it to plugin-cache users.
  if (!settingsOwnsHooks) {
    log(
      'Plugin cache: hooks left in place (plugin-only install — the cache manifest is the only registration)',
    );
  }

  if (existsSync(pluginDir)) {
    // NOTE: Do NOT clear marketplace .mcp.json — Claude Code copies from
    // marketplace clone → plugin cache on updates. Clearing it causes the
    // cache .mcp.json to lose the MCP server definition, breaking plugin MCP.
    // Dedup is already handled by skipping global `claude mcp add` above.

    // Clear plugin hooks to prevent double hook execution
    try {
      if (settingsOwnsHooks && existsSync(pluginHooksPath)) {
        const pluginHooks = JSON.parse(readFileSync(pluginHooksPath, 'utf8'));
        if (pluginHooks.hooks && Object.keys(pluginHooks.hooks).length > 0) {
          // Atomic (audit 2026-09-02 P1-10): a torn hooks.json is not a fail-open marker —
          // Claude Code parses it at plugin load, so half a file disables the plugin's hooks
          // for that install until the next successful write. Same writer settings.json
          // already uses 1600 lines down.
          atomicWriteFileSync(
            pluginHooksPath,
            JSON.stringify(
              {
                description: pluginHooks.description || 'claude-mem-lite hooks',
                _note:
                  'Hooks managed by install.mjs in settings.json — this file cleared to prevent duplicates',
                hooks: {},
              },
              null,
              2,
            ) + '\n',
          );
          ok('Marketplace plugin: hooks cleared (prevents duplicate)');
        }
      }
    } catch (e) {
      warn(`Marketplace hooks dedup: ${e.message}`);
    }

    // Sync launch.mjs to plugin cache — ensures MCP server loads dev code via symlink detection.
    // ALSO clear cached hooks.json in every version dir — Claude Code runtime reads hooks from
    // ~/.claude/plugins/cache/<mp>/<plugin>/<ver>/hooks/hooks.json, NOT from the marketplace source.
    // Clearing only the marketplace source (above) leaves stale cache copies that double-register
    // hooks alongside install.mjs-written settings.json entries.
    try {
      const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', MARKETPLACE_KEY, 'claude-mem-lite');
      if (existsSync(cacheBase)) {
        const launchSyncFiles = ['launch.mjs', 'launch-preflight.mjs'];
        let clearedHooks = 0;
        for (const ver of readdirSync(cacheBase)) {
          const verDir = join(cacheBase, ver);

          // Sync launch.mjs + its preflight companion (issue #15)
          if (existsSync(join(verDir, 'scripts'))) {
            for (const f of launchSyncFiles) {
              const src = join(PROJECT_DIR, 'scripts', f);
              if (existsSync(src)) {
                try {
                  copyFileSync(src, join(verDir, 'scripts', f));
                } catch {
                  /* keep going */
                }
              }
            }
          }

          // Clear cached hooks.json (runtime reads here, not marketplace source)
          const cachedHooksPath = join(verDir, 'hooks', 'hooks.json');
          if (settingsOwnsHooks && existsSync(cachedHooksPath)) {
            try {
              const h = JSON.parse(readFileSync(cachedHooksPath, 'utf8'));
              if (h.hooks && Object.keys(h.hooks).length > 0) {
                // Atomic, same reason as the marketplace-source copy above (P1-10). This one
                // is the higher-cost of the two: it runs once PER CACHED VERSION, so a tear
                // here disables hooks for whichever version Claude Code happens to load.
                atomicWriteFileSync(
                  cachedHooksPath,
                  JSON.stringify(
                    {
                      description: h.description || 'claude-mem-lite hooks',
                      _note: `Hooks managed by install.mjs in settings.json — cache hooks.json cleared to prevent duplicate registration (cache ver: ${ver})`,
                      hooks: {},
                    },
                    null,
                    2,
                  ) + '\n',
                );
                clearedHooks++;
              }
            } catch {
              /* silent — never block install on one bad cache entry */
            }
          }
        }
        const parts = ['launch.mjs synced (dev mode MCP routing)'];
        if (clearedHooks > 0) parts.push(`${clearedHooks} stale hooks.json cleared`);
        ok(`Plugin cache: ${parts.join('; ')}`);
      }
    } catch (e) {
      warn(`Plugin cache sync: ${e.message}`);
    }
  }
}

function configureHooks() {
  // 4. Configure hooks (merge: preserve user's existing hooks, replace ours)
  log('Configuring hooks...');
  const settings = readSettings();
  if (clearPluginDisabledMarkerForDirectInstall(settings)) {
    ok('Cleared stale disabled plugin flag so install.mjs-managed hooks can run');
  }
  settings.hooks = settings.hooks || {};

  const SCRIPTS_PATH = join(INSTALL_DIR, 'scripts');
  const PREFILTER_PATH = join(SCRIPTS_PATH, 'post-tool-use.sh');
  // Second bash prefilter, same idea one event over: skip the Node start for a
  // default-off feature (audit 2026-08-22 P2-5, see the script's header).
  const AGENT_PREFILTER_PATH = join(SCRIPTS_PATH, 'pre-agent-inject.sh');
  // v2.84: every Node hook invocation routes through hook-launcher.mjs so an
  // ERR_MODULE_NOT_FOUND from a partial-install drift auto-heals via
  // install.mjs repair instead of permanently bricking the hook chain.
  const LAUNCHER_PATH = join(SCRIPTS_PATH, 'hook-launcher.mjs');
  const nodeHook = (entry, ...args) => `node "${LAUNCHER_PATH}" ${entry} ${args.join(' ')}`.trim();

  const memPostToolUse = {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: `bash "${PREFILTER_PATH}"`,
        timeout: 5,
      },
    ],
  };

  // Component 2 of the bind-salience forcing function: after an Edit/Write, flag an
  // identifier the file's own lesson named that the edit just removed (component 1 is the
  // pre-edit directive from scripts/pre-tool-recall.js, which also records the identifiers
  // this one checks). Shipped, signed and tested since it was written, but registered in
  // NEITHER registry — so `CLAUDE_MEM_SALIENCE=bind` delivered half the mechanism and
  // nothing said so (audit B6, 2026-08-14). Matched on the edit tools only, NOT Read: there
  // is no post-edit state to compare after a read. Inert (returns before touching stdin)
  // unless CLAUDE_MEM_SALIENCE=bind, so the default chain pays one short-circuit spawn per
  // edit and emits nothing.
  const memPostToolRecall = {
    matcher: 'Edit|Write|NotebookEdit',
    hooks: [
      {
        type: 'command',
        command: nodeHook('scripts/post-tool-recall.js'),
        timeout: 3,
      },
    ],
  };

  // D#170. A SEPARATE event from PostToolUse, not a variant of it: Claude Code does not
  // fire PostToolUse for a tool call it judged failed, so without this registration the
  // plugin never sees a single host-flagged failure. Matched on Bash alone — the surface
  // it feeds queries on a command plus its output, and no other tool has that shape.
  const memPostToolFailure = {
    matcher: 'Bash',
    hooks: [
      {
        type: 'command',
        command: nodeHook('hook.mjs', 'post-tool-failure'),
        timeout: 5,
      },
    ],
  };

  const memSessionStart = {
    matcher: 'startup|clear|compact',
    hooks: [
      {
        type: 'command',
        command: nodeHook('hook.mjs', 'session-start'),
        timeout: 10,
      },
    ],
  };

  const memStop = {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: nodeHook('hook.mjs', 'stop'),
        timeout: 5,
      },
    ],
  };

  // Fires immediately BEFORE auto-compaction, re-emitting <claude-mem-context> so the
  // summarizer that rewrites the transcript still has memory in scope (SessionStart's
  // compact matcher fires AFTER, when the context is already gone). Parity with
  // hooks/hooks.json: omitting it here made every settings.json install lose exactly the
  // block that exists to survive compaction, invisibly — doctor only ever asked "are ANY
  // mem hooks present", never "which events" (audit B3, 2026-08-14).
  const memPreCompact = {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: nodeHook('hook.mjs', 'pre-compact'),
        timeout: 5,
      },
    ],
  };

  const memUserPrompt = {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: nodeHook('scripts/user-prompt-search.js'),
        timeout: 2,
      },
      {
        type: 'command',
        command: nodeHook('hook.mjs', 'user-prompt'),
        timeout: 5,
      },
    ],
  };

  const memPreToolRecall = {
    // v2.34.6: Read added to cover planning-Read (pre-Edit exploration).
    // Read-path uses a tighter filter (lesson_learned required, top-1,
    // 120-char truncation, silent-on-empty) — see scripts/pre-tool-recall.js.
    matcher: 'Edit|Write|NotebookEdit|Read',
    hooks: [
      {
        type: 'command',
        command: nodeHook('scripts/pre-tool-recall.js'),
        timeout: 3,
      },
    ],
  };

  const memPreSkillBridge = {
    matcher: 'Skill',
    hooks: [
      {
        type: 'command',
        command: nodeHook('scripts/pre-skill-bridge.js'),
        timeout: 3,
      },
    ],
  };

  // P0 subagent dispatch-time injection (default off — CLAUDE_MEM_SUBAGENT_INJECT).
  // Fires on the Agent/Task dispatch so a subagent (otherwise memory-blind — #8848)
  // can receive one relevant lesson via updatedInput. Parity with hooks/hooks.json.
  // Behind the bash prefilter since 2026-08-22 (audit P2-5): the flag is off by
  // default, and a disabled feature was starting a Node interpreter on every single
  // Agent dispatch (22.6ms → 2.4ms; see scripts/pre-agent-inject.sh). The prefilter
  // execs the same launcher when the flag is on.
  const memPreAgentInject = {
    matcher: 'Agent|Task',
    hooks: [
      {
        type: 'command',
        command: `bash "${AGENT_PREFILTER_PATH}"`,
        timeout: 5,
      },
    ],
  };

  // Filter out existing mem hooks, then append fresh ones
  // PreToolUse has three separate matchers, so we register all three
  // Event set MUST stay equal to hooks/hooks.json's (minus scripts/setup.sh, which
  // bootstraps the plugin cache and has no settings.json counterpart) —
  // tests/audit-silent-20260814.test.mjs diffs a real `install --dev` run's
  // settings.json against the shipped manifest and reds on any new divergence.
  const hookConfigs = {
    PreToolUse: [memPreToolRecall, memPreSkillBridge, memPreAgentInject],
    PostToolUse: [memPostToolUse, memPostToolRecall],
    PostToolUseFailure: [memPostToolFailure],
    PreCompact: [memPreCompact],
    SessionStart: [memSessionStart],
    Stop: [memStop],
    UserPromptSubmit: [memUserPrompt],
  };

  for (const [event, configs] of Object.entries(hookConfigs)) {
    const existing = Array.isArray(settings.hooks[event])
      ? settings.hooks[event].filter((cfg) => !isMemHook(cfg))
      : [];
    settings.hooks[event] = [...existing, ...configs];
  }

  writeSettings(settings);
  // Derived from the map, not a parallel literal: the pre-B3 line said five events and
  // kept saying five after the map changed, which is how a missing registration reads as
  // a successful one.
  ok(`Hooks configured (${Object.keys(hookConfigs).join(', ')})`);
  // Returned so dedupePluginCacheAndHooks gates on a VALUE this function produced
  // rather than re-reading settings.json — see the `managedHooks` note there. This
  // function writes all seven events unconditionally, so the answer is always true;
  // returning it keeps that fact in the caller's dataflow instead of in call order.
  return true;
}

function backupLegacyClaudeMemData() {
  // 5. Legacy ~/.claude-mem/ → ~/.claude-mem-lite/ — back up, don't reuse.
  // The legacy DB is schema v16 (schema_versions plural) and there's no
  // bridge in MIGRATIONS[] to v28. Reusing it FATALs on first launch with
  // "no such column: memory_session_id". Rename to a timestamped backup
  // so the new install creates a fresh v28 DB.
  try {
    const r = migrateLegacyClaudeMemData(OLD_DATA_DIR, MEM_DATA_DIR);
    if (r.action === 'backed-up') {
      ok(`Legacy ~/.claude-mem/ DB backed up to ${r.backupPath}`);
      log('New v28 DB will be created on first launch (legacy schema is incompatible).');
    }
  } catch (e) {
    warn('Legacy DB backup failed: ' + e.message);
  }

  // 5b. Rename claude-mem.db → claude-mem-lite.db in same directory
  const oldDbInDir = join(MEM_DATA_DIR, 'claude-mem.db');
  if (existsSync(oldDbInDir) && !existsSync(DB_PATH)) {
    renameSync(oldDbInDir, DB_PATH);
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(oldDbInDir + ext))
        try {
          renameSync(oldDbInDir + ext, DB_PATH + ext);
        } catch {}
    }
    ok('Database renamed: claude-mem.db → claude-mem-lite.db');
  }
}

async function installPreinstalledResources() {
  // 6. Install pre-installed resources (skills + agents)
  if (process.env.CLAUDE_MEM_SKIP_REPOS) {
    ok('Skill/agent registry: skipped (CLAUDE_MEM_SKIP_REPOS)');
  } else
    try {
      const manifestPath = join(INSTALL_DIR, 'registry', 'preinstalled.json');
      if (!existsSync(manifestPath)) {
        // For git-clone mode, check PROJECT_DIR
        const altPath = join(PROJECT_DIR, 'registry', 'preinstalled.json');
        if (existsSync(altPath)) {
          const registryDir = join(INSTALL_DIR, 'registry');
          if (!existsSync(registryDir)) mkdirSync(registryDir, { recursive: true });
          copyFileSync(altPath, manifestPath);
        }
      }

      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const resources = manifest.resources || [];

        if (resources.length > 0) {
          const managedDir = join(MEM_DATA_DIR, 'managed');

          // 6a. Git shallow clone unique repos
          const repos = new Map();
          for (const r of resources) {
            if (!repos.has(r.repo)) repos.set(r.repo, []);
            repos.get(r.repo).push(r);
          }

          // Disclose the cost BEFORE spending it. This step is the single largest
          // thing `install` does — N shallow git clones over the network, ~150 MB on
          // disk for the default manifest — and it used to announce itself only after
          // the fact ("Repos: 15 cloned"). A first-time user on a metered link or a
          // small disk had no warning and no visible way out; the opt-out existed but
          // lived only in an env var no output ever mentioned.
          // Count only repos not already on disk — a re-run/update clones nothing, and
          // announcing "cloning 15 repos" every time would be false.
          const repoDirName = (repoUrl) =>
            repoUrl
              .split('/')
              .slice(-2)
              .join('-')
              .replace(/[^a-zA-Z0-9._-]/g, '_');
          const pendingClones = [...repos.keys()].filter(
            (repoUrl) => !existsSync(join(managedDir, 'repos', repoDirName(repoUrl))),
          ).length;
          if (pendingClones > 0) {
            log(`Skill/agent registry: cloning ${pendingClones} repo(s) — network + ~150 MB on disk.`);
            log('  Skip with CLAUDE_MEM_SKIP_REPOS=1 (memory features work without it).');
          }

          let cloned = 0,
            updated = 0;
          const deadRepos = new Set(); // repos that no longer exist (404)

          const isRepoNotFound = (err) => {
            const msg = (err?.stderr ? err.stderr.toString() : '') + (err?.message || '');
            return /repository.*not found|404/i.test(msg);
          };

          for (const [repoUrl, entries] of repos) {
            const repoName = repoUrl
              .split('/')
              .slice(-2)
              .join('-')
              .replace(/[^a-zA-Z0-9._-]/g, '_');
            const clonePath = join(managedDir, 'repos', repoName);
            let repoReady = false;

            const plan = planRepoSparsePaths(entries);
            const cloneUrl = `${repoUrl.replace(/\.git$/, '')}.git`;
            // Clone only what we extract: a partial (blob:none) + sparse clone fetches
            // just the manifest subpaths' subtrees instead of the whole repo. Falls
            // back to a plain shallow clone if partial-clone/sparse-checkout is
            // unsupported (old git/server) — identical to the prior behavior.
            const cloneSlim = () => {
              if (plan.full) {
                execFileSync('git', ['clone', '--depth', '1', cloneUrl, clonePath], {
                  stdio: 'pipe',
                  timeout: 30000,
                });
                return;
              }
              try {
                execFileSync(
                  'git',
                  ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', cloneUrl, clonePath],
                  { stdio: 'pipe', timeout: 30000 },
                );
                execFileSync('git', ['-C', clonePath, 'sparse-checkout', 'set', '--no-cone', ...plan.paths], {
                  stdio: 'pipe',
                  timeout: 30000,
                });
                execFileSync('git', ['-C', clonePath, 'checkout'], { stdio: 'pipe', timeout: 30000 });
              } catch {
                try {
                  rmSync(clonePath, { recursive: true, force: true });
                } catch {}
                execFileSync('git', ['clone', '--depth', '1', cloneUrl, clonePath], {
                  stdio: 'pipe',
                  timeout: 30000,
                });
              }
            };

            // Migrate a legacy full clone: drop it so the fresh-clone path below
            // rebuilds it slim. managed/repos is a rebuildable cache, so this loses
            // nothing and reclaims the bulk of its footprint on the next install run.
            if (!plan.full && existsSync(clonePath) && !isPartialSparseClone(clonePath)) {
              try {
                rmSync(clonePath, { recursive: true, force: true });
              } catch {}
            }

            if (!existsSync(clonePath)) {
              // Fresh clone (also the rebuild path for a just-migrated legacy clone)
              try {
                mkdirSync(join(managedDir, 'repos'), { recursive: true });
                cloneSlim();
                cloned++;
                repoReady = true;
              } catch (err) {
                if (isRepoNotFound(err)) {
                  deadRepos.add(repoUrl);
                  warn(`  Repo not found (removed?): ${repoUrl}`);
                } else {
                  warn(`  Clone failed: ${repoUrl}`);
                }
                continue;
              }
            } else {
              // Update existing: fetch latest and fast-forward
              try {
                // Re-assert the sparse set so a newer manifest that adds a subpath to
                // an already-slim clone checks it out (idempotent; no-op for full clones).
                if (!plan.full && isPartialSparseClone(clonePath)) {
                  try {
                    execFileSync(
                      'git',
                      ['-C', clonePath, 'sparse-checkout', 'set', '--no-cone', ...plan.paths],
                      { stdio: 'pipe', timeout: 30000 },
                    );
                  } catch {}
                }
                const localHash = execFileSync('git', ['-C', clonePath, 'rev-parse', 'HEAD'], {
                  encoding: 'utf8',
                  stdio: 'pipe',
                }).trim();
                execFileSync('git', ['-C', clonePath, 'fetch', '--depth', '1', 'origin'], {
                  stdio: 'pipe',
                  timeout: 30000,
                });
                const remoteHash = execFileSync('git', ['-C', clonePath, 'rev-parse', 'FETCH_HEAD'], {
                  encoding: 'utf8',
                  stdio: 'pipe',
                }).trim();
                if (localHash !== remoteHash) {
                  execFileSync('git', ['-C', clonePath, 'reset', '--hard', 'FETCH_HEAD'], { stdio: 'pipe' });
                  updated++;
                  repoReady = true; // needs re-copy
                }
              } catch (err) {
                if (isRepoNotFound(err)) {
                  deadRepos.add(repoUrl);
                  warn(`  Repo not found (removed?): ${repoUrl} — cleaning up`);
                  // Remove local clone
                  try {
                    rmSync(clonePath, { recursive: true, force: true });
                  } catch {}
                  // Remove extracted resources
                  for (const entry of entries) {
                    const destDir = join(managedDir, entry.type === 'skill' ? 'skills' : 'agents');
                    const destPath = join(destDir, entry.name);
                    try {
                      if (existsSync(destPath)) rmSync(destPath, { recursive: true, force: true });
                    } catch {}
                  }
                  continue;
                }
                // Transient failure — use existing clone as-is
              }
            }

            // Copy resources to managed/skills/ or managed/agents/
            // Re-copy if repo was freshly cloned or updated
            mkdirSync(join(managedDir, 'skills'), { recursive: true });
            mkdirSync(join(managedDir, 'agents'), { recursive: true });
            for (const entry of entries) {
              // Path traversal guard: reject entries with '..' or absolute paths
              if (
                entry.path.includes('..') ||
                entry.name.includes('..') ||
                isAbsolute(entry.path) ||
                isAbsolute(entry.name)
              )
                continue;
              const srcPath = entry.path === '.' ? clonePath : join(clonePath, entry.path);
              const destDir = join(managedDir, entry.type === 'skill' ? 'skills' : 'agents');
              const destPath = join(destDir, entry.name);
              if (existsSync(srcPath) && (repoReady || !existsSync(destPath))) {
                try {
                  if (existsSync(destPath)) rmSync(destPath, { recursive: true, force: true });
                  cpSync(srcPath, destPath, { recursive: true });
                } catch {}
              }
            }
          }
          const managedSize = dirSizeBytes(managedDir);
          ok(
            `Repos: ${cloned} cloned, ${updated} updated, ${repos.size - deadRepos.size} active` +
              (deadRepos.size > 0 ? `, ${deadRepos.size} dead removed` : '') +
              ` (${fmtMB(managedSize.bytes, managedSize.truncated)} in ${managedDir})`,
          );

          // 6b. Init registry DB and record preinstalled entries
          const { ensureRegistryDb } = await importFromInstall('registry.mjs');
          const regDbPath = join(MEM_DATA_DIR, 'resource-registry.db');
          const rdb = ensureRegistryDb(regDbPath);

          const insertPre = rdb.prepare(`
        INSERT OR REPLACE INTO preinstalled (name, type, repo_url, repo_path, tags, enabled)
        VALUES (?, ?, ?, ?, ?, 1)
      `);
          const activeResources =
            deadRepos.size > 0 ? resources.filter((r) => !deadRepos.has(r.repo)) : resources;
          for (const r of activeResources) {
            insertPre.run(r.name, r.type, r.repo, r.path, JSON.stringify(r.tags || []));
          }

          // Clean up DB entries for dead repos
          if (deadRepos.size > 0) {
            const delPre = rdb.prepare('DELETE FROM preinstalled WHERE repo_url = ?');
            const delRes = rdb.prepare('DELETE FROM resources WHERE repo_url = ?');
            for (const deadUrl of deadRepos) {
              try {
                delPre.run(deadUrl);
              } catch {}
              try {
                delRes.run(deadUrl);
              } catch {}
            }
          }
          ok(
            `Registry DB initialized (${activeResources.length} preinstalled entries` +
              (deadRepos.size > 0 ? `, ${deadRepos.size} dead repos purged` : '') +
              ')',
          );

          // 6c. Fetch GitHub stars (best-effort, unauthenticated)
          log('  Fetching GitHub stars...');
          const starCache = new Map();
          for (const [repoUrl] of repos) {
            if (deadRepos.has(repoUrl)) continue;
            const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
            if (match) {
              try {
                const apiUrl = `https://api.github.com/repos/${match[1]}/${match[2]}`;
                const res = execFileSync('curl', ['-sf', apiUrl], { encoding: 'utf8', timeout: 10000 });
                const data = JSON.parse(res);
                if (typeof data.stargazers_count === 'number') {
                  starCache.set(repoUrl, data.stargazers_count);
                }
              } catch {}
            }
          }
          if (starCache.size > 0) ok(`Stars fetched (${starCache.size}/${repos.size} repos)`);

          // 6d. Scan and index resources (fallback-only, Haiku indexing deferred to first run)
          log('  Scanning resources...');
          const { scanAllResources, diffResources } = await importFromInstall('registry-scanner.mjs');
          const scanned = scanAllResources({ dataDir: MEM_DATA_DIR });

          // Attach star counts and repo URLs
          for (const s of scanned) {
            const entry = resources.find((r) => r.name === s.name && r.type === s.type);
            if (entry) {
              s.repoUrl = entry.repo;
              s.repoStars = starCache.get(entry.repo) || 0;
            }
          }

          const { toIndex } = diffResources(rdb, scanned);
          if (toIndex.length > 0) {
            // Use fallback indexing at install time (no Haiku calls)
            // Full Haiku indexing happens on first SessionStart
            const { upsertResource } = await importFromInstall('registry.mjs');
            for (const res of toIndex) {
              try {
                const metaKey = `${res.type}:${res.name}`;
                const meta = RESOURCE_METADATA[metaKey];
                upsertResource(rdb, {
                  name: res.name,
                  type: res.type,
                  status: 'active',
                  source: res.source,
                  repo_url: res.repoUrl || null,
                  repo_stars: res.repoStars || 0,
                  local_path: res.localPath,
                  file_hash: res.fileHash,
                  invocation_name: meta?.invocation_name || deriveInvocationName(res.name),
                  intent_tags: meta?.intent_tags || res.name.replace(/-/g, ' '),
                  domain_tags: meta?.domain_tags || '',
                  trigger_patterns:
                    meta?.trigger_patterns || `when user needs ${res.name.replace(/-/g, ' ')}`,
                  capability_summary:
                    meta?.capability_summary || `${res.type}: ${res.name.replace(/-/g, ' ')}`,
                });
              } catch {}
            }
            ok(`Resources registered: ${toIndex.length} indexed`);
          }

          // Apply curated metadata to all known resources (fixes existing installs)
          reindexKnownResources(rdb);
          ok('Resource metadata curated (FTS5 reindexed)');

          // Register plugin resources (skills/agents from other plugins, no local files)
          const virtualCount = registerVirtualResources(rdb);
          if (virtualCount > 0) ok(`Plugin resources registered: ${virtualCount} virtual entries`);

          rdb.close();
        }
      } else {
        log('  No preinstalled manifest found, skipping');
      }
    } catch (e) {
      warn('Resource setup: ' + e.message);
      log('  Skills/agents will be indexed on first use');
    }
}

function verifyDatabase() {
  // 7. Verify database
  if (existsSync(DB_PATH)) {
    try {
      const Database = requireFromInstall('better-sqlite3');
      const db = new Database(DB_PATH, { readonly: true });
      const count = db.prepare('SELECT COUNT(*) as c FROM observations').get();
      db.close();
      ok(`Database accessible: ${count.c} observations`);
    } catch (e) {
      warn('Database check failed: ' + e.message);
    }
  } else {
    log('No existing database — will be created on first use');
  }
}

async function dogfoodAutoAdopt() {
  // 7b. Dogfood auto-adopt (invited-memory, Phase C T13).
  // Only fires when install.mjs is running from the claude-mem-lite source repo
  // itself (detected via git remote match). In npm/npx flows PROJECT_DIR is a
  // cache dir with no git metadata, so this is a no-op for end users.
  // --no-adopt override respected.
  if (!flags.has('--no-adopt')) {
    try {
      const remote = execFileSync('git', ['-C', PROJECT_DIR, 'config', '--get', 'remote.origin.url'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
      const isDogfood = /github\.com[:/]sdsrss\/claude-mem-lite(\.git)?$/i.test(remote);
      if (isDogfood) {
        const { cmdAdopt } = await importFromInstall('adopt-cli.mjs');
        cmdAdopt([]);
        ok('Invited-memory: auto-adopt for claude-mem-lite dogfood repo');
      }
    } catch {
      // Not a git repo, or git missing — silent skip (this is the normal npm path).
    }
  }
}

function disableOldClaudeMemPlugin() {
  const settings = readSettings();
  // 8. Disable old claude-mem plugin
  if (settings.enabledPlugins?.['claude-mem@thedotmack'] !== undefined) {
    settings.enabledPlugins['claude-mem@thedotmack'] = false;
    writeSettings(settings);
    ok('Old claude-mem plugin disabled');
  }
}

function offerCleanOldVectorDb() {
  // 9. Offer to clean old vector-db
  const vectorDbPath = join(OLD_DATA_DIR, 'vector-db');
  if (existsSync(vectorDbPath)) {
    try {
      const size = execFileSync('du', ['-sh', vectorDbPath], { encoding: 'utf8' }).trim().split('\t')[0];
      warn(`Old vector-db exists (${size}). Run: rm -rf ~/.claude-mem/vector-db/`);
    } catch {}
  }
}

async function install() {
  console.log('\nclaude-mem-lite installer\n');

  // 1. Install source files to ~/.claude-mem-lite/
  const IS_DEV = flags.has('--dev');

  installSourceFiles(IS_DEV);
  await installDependencies(IS_DEV);
  createCliSymlink();
  registerMcpServer();
  // configureHooks BEFORE dedupe, and its result feeds the dedup gate: dedupe now
  // refuses to clear a hooks manifest unless install.mjs-managed hooks exist in
  // settings.json, and on a first install those entries do not exist until
  // configureHooks writes them. Passing the value (rather than letting dedupe
  // re-read settings.json) is what keeps a future reorder from silently turning the
  // dedup off — the dependency is data, not sequence.
  const managedHooks = configureHooks();
  dedupePluginCacheAndHooks({ managedHooks });
  backupLegacyClaudeMemData();
  await installPreinstalledResources();
  verifyDatabase();
  await dogfoodAutoAdopt();
  disableOldClaudeMemPlugin();
  offerCleanOldVectorDb();

  console.log('\n  Done! Restart Claude Code to activate.\n');
}

// ─── Uninstall ──────────────────────────────────────────────────────────────

async function uninstall() {
  console.log('\nclaude-mem-lite uninstaller\n');

  // 1. Remove MCP (legacy hook-based install).
  // Try both the legacy "mem" (pre-v2.78) and current "mem-lite" names so a user
  // who installed in either era ends up clean.
  let removedAny = false;
  for (const name of ['mem', 'mem-lite']) {
    try {
      execFileSync('claude', ['mcp', 'remove', '-s', 'user', name], { stdio: 'pipe' });
      ok(`MCP server removed: ${name}`);
      removedAny = true;
    } catch {}
  }
  if (!removedAny) warn('MCP server not found or already removed');

  // 1b. Remove CLI symlink
  for (const binDir of [join(homedir(), '.local', 'bin'), '/usr/local/bin']) {
    const cliLink = join(binDir, 'claude-mem-lite');
    try {
      if (existsSync(cliLink)) {
        unlinkSync(cliLink);
        ok(`CLI symlink removed: ${cliLink}`);
      }
    } catch {
      /* may not have permissions */
    }
  }

  // 2. Remove hooks from settings.json (match both npx and git-clone install paths)
  const settings = readSettings();
  cleanupMemHooksFromSettings(settings);

  // 2b. Uninstall does NOT auto-unadopt — an adopted project may be in active use
  // in other Claude Code sessions, and adoption lives in EACH project's own
  // CLAUDE.md. `unadopt --all` now strips every block across the projects Claude
  // Code knows about (~/.claude.json), so point at it — but note the timing: a
  // --purge run removes the CLI symlink, so this is best done BEFORE uninstall.
  log('Invited-memory: project adoption left in place (each adopted project keeps its');
  log('  CLAUDE.md managed block + .claude/plugin_claude_mem_lite.md). To remove it from');
  log('  every known project, run `claude-mem-lite unadopt --all` — best done BEFORE');
  log('  uninstall, while the CLI is still on PATH. A project Claude Code never opened');
  log('  is not in the known list — run `claude-mem-lite unadopt` from inside it.');

  // 3. Clean plugin registry entries conservatively (avoid deleting other plugins
  // from the same marketplace publisher)
  const pluginsDir = join(homedir(), '.claude', 'plugins');
  const installedPath = join(pluginsDir, 'installed_plugins.json');
  let canRemoveMarketplaceArtifacts;
  try {
    const installed = JSON.parse(readFileSync(installedPath, 'utf8'));
    const plugins = getInstalledPluginEntries(installed);
    let cleaned = false;
    if (PLUGIN_KEY in plugins) {
      delete plugins[PLUGIN_KEY];
      cleaned = true;
    }
    canRemoveMarketplaceArtifacts = !hasOtherMarketplacePlugins(installed);
    if (cleaned) {
      writeFileSync(installedPath, JSON.stringify(installed, null, 2) + '\n');
      ok('Removed from installed_plugins.json');
    }
  } catch {
    // Conservative default: if registry shape is unknown, preserve marketplace cache.
    canRemoveMarketplaceArtifacts = false;
  }

  // 4. Clean plugin system entries from settings.json
  const marketplaceKey = MARKETPLACE_KEY;
  if (settings.enabledPlugins) {
    delete settings.enabledPlugins[PLUGIN_KEY];
  }
  if (settings.extraKnownMarketplaces && canRemoveMarketplaceArtifacts) {
    delete settings.extraKnownMarketplaces[marketplaceKey];
  }
  writeSettings(settings);
  ok('Hooks and plugin settings cleaned');

  // 5. Clean plugin system registry files (only if no other marketplace plugins remain)
  const marketplaceDir = join(pluginsDir, 'marketplaces', marketplaceKey);
  if (canRemoveMarketplaceArtifacts && existsSync(marketplaceDir)) {
    rmSync(marketplaceDir, { recursive: true, force: true });
    ok('Marketplace directory removed');
  }

  // 5b. Remove cache directory
  const cacheDir = join(pluginsDir, 'cache', marketplaceKey);
  if (canRemoveMarketplaceArtifacts && existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true });
    ok('Plugin cache removed');
  }

  // 5c. Clean known_marketplaces.json
  const knownPath = join(pluginsDir, 'known_marketplaces.json');
  try {
    const known = JSON.parse(readFileSync(knownPath, 'utf8'));
    if (canRemoveMarketplaceArtifacts && marketplaceKey in known) {
      delete known[marketplaceKey];
      writeFileSync(knownPath, JSON.stringify(known, null, 2) + '\n');
      ok('Removed from known_marketplaces.json');
    }
  } catch {
    /* file may not exist */
  }

  if (!canRemoveMarketplaceArtifacts && (existsSync(marketplaceDir) || existsSync(cacheDir))) {
    log('Marketplace cache preserved (other plugins may still depend on sdsrss marketplace)');
  }

  // 6. Purge data if requested
  if (flags.has('--purge')) {
    const homeDir = join(homedir(), '.claude-mem-lite');
    // Always remove the homedir code/install dir (guarded to the canonical path).
    if (existsSync(DATA_DIR) && DATA_DIR === homeDir) {
      rmSync(DATA_DIR, { recursive: true, force: true });
      ok('Data purged (~/.claude-mem-lite/)');
    } else if (existsSync(DATA_DIR)) {
      fail('DATA_DIR path mismatch, refusing to purge for safety: ' + DATA_DIR);
    }
    // Also remove the relocated data dir — but ONLY if it's genuinely our data dir
    // (contains claude-mem-lite.db), so a mistyped CLAUDE_MEM_DIR is never rm'd.
    if (MEM_DATA_DIR !== homeDir) {
      if (existsSync(join(MEM_DATA_DIR, 'claude-mem-lite.db'))) {
        rmSync(MEM_DATA_DIR, { recursive: true, force: true });
        ok(`Relocated data purged (${MEM_DATA_DIR})`);
      } else if (existsSync(MEM_DATA_DIR)) {
        warn(
          `CLAUDE_MEM_DIR (${MEM_DATA_DIR}) has no claude-mem-lite.db — left untouched. Remove manually if intended.`,
        );
      }
    }
  } else {
    log('Data preserved (use --purge to remove)');
  }

  console.log('\n  Done!\n');
}

// ─── Cleanup Hooks ───────────────────────────────────────────────────────────

async function cleanupHooks() {
  console.log('\nclaude-mem-lite cleanup-hooks\n');

  const settings = readSettings();
  const removed = cleanupMemHooksFromSettings(settings);

  if (removed > 0) {
    writeSettings(settings);
    ok(`Removed ${removed} claude-mem-lite hook configuration${removed === 1 ? '' : 's'} from settings.json`);
  } else {
    ok('No claude-mem-lite hooks found in settings.json');
  }

  console.log('');
}

// ─── Status ─────────────────────────────────────────────────────────────────

async function status() {
  // Dogfood-8: support --json so CI / setup scripts can probe install state
  // without scraping text. Collect each check as a structured record first,
  // then print text OR JSON. Text path keeps identical wording so existing
  // users / docs / screenshots stay correct.
  const json = flags.has('--json');
  const checks = [];
  const push = (level, key, message, extra = {}) => checks.push({ level, key, message, ...extra });

  // A plugin install registers its MCP server and its hooks through the plugin
  // manifest, never through `claude mcp add` / settings.json. Without knowing
  // that, status printed `✗ MCP server: not registered` and `✗ Hooks: not
  // configured` at a correctly-installed plugin user — two red marks describing
  // the intended state.
  const shape = detectInstallShape({ home: homedir(), projectDir: PROJECT_DIR, installDir: INSTALL_DIR });
  const pluginProvides = !!shape.activePluginVersion;

  // MCP
  try {
    const list = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8' });
    // Accept either the current "mem-lite" registration or the legacy "mem"
    // name (pre-v2.78) so a user mid-upgrade still sees a green status until
    // setup.sh / install.mjs purges the legacy entry on next run.
    // v2.79.1: dropped a `/\bmem\b\s/` fallback regex — the `\b` word boundary
    // also matched "mem-lite" (because `-` is a non-word char), so the regex
    // was always-true noise (benign only because the mem-lite checks short-
    // circuited first). `claude mcp list` formats as `<name>: <command>`, so
    // the two colon-form checks below cover every shape.
    const registered = list.includes('mem-lite:') || list.includes('mem:');
    if (registered) {
      push('ok', 'mcp', 'MCP server: registered', { registered });
    } else if (pluginProvides) {
      push(
        'ok',
        'mcp',
        `MCP server: provided by the plugin manifest (v${shape.activePluginVersion.version} .mcp.json) — no user-scope registration expected`,
        { registered: false, via: 'plugin' },
      );
    } else {
      push('fail', 'mcp', 'MCP server: not registered', { registered });
    }
  } catch {
    push('warn', 'mcp', 'Could not check MCP status', { registered: null });
  }

  // Hooks
  const settings = readSettings();
  const hasHooks = hasMemHooksConfigured(settings);
  const pluginDisabled = isPluginExplicitlyDisabled(settings);
  const pluginEnabled = settings.enabledPlugins?.[PLUGIN_KEY] === true;

  if (pluginEnabled) push('ok', 'plugin', 'Plugin: enabled in settings', { enabled: true, disabled: false });
  else if (pluginDisabled)
    push('warn', 'plugin', 'Plugin: disabled in settings', { enabled: false, disabled: true });
  else push('warn', 'plugin', 'Plugin: not present in enabledPlugins', { enabled: false, disabled: false });

  if (hasHooks && pluginDisabled) {
    push(
      'warn',
      'hooks',
      'Hooks: still configured in settings.json while plugin is disabled (runtime ignores them; run cleanup-hooks or uninstall to clean up)',
      { configured: true },
    );
  } else if (hasHooks) {
    push('ok', 'hooks', 'Hooks: configured', { configured: true });
  } else if (pluginDisabled) {
    push('ok', 'hooks', 'Hooks: not configured', { configured: false });
  } else if (pluginProvides) {
    // Open the manifest being credited. Trusting `settings.json holds none` alone
    // reported all-green over an emptied cache manifest — zero hooks registered.
    const manifest = pluginCacheHookEvents(shape.activePluginVersion.root);
    if (manifest.ok) {
      push(
        'ok',
        'hooks',
        `Hooks: provided by the plugin manifest (v${shape.activePluginVersion.version} hooks/hooks.json, ${manifest.events.length} events) — settings.json correctly holds none`,
        { configured: false, via: 'plugin', events: manifest.events },
      );
    } else {
      const repair = hookManifestRepairHint(
        shape.activePluginVersion.root,
        join(homedir(), '.claude', 'plugins', 'marketplaces', MARKETPLACE_KEY),
      );
      push(
        'fail',
        'hooks',
        `Hooks: plugin manifest v${shape.activePluginVersion.version} registers NO hooks (${manifest.reason}) and settings.json holds none — every hook is unregistered. Repair: ${repair}`,
        { configured: false, via: 'plugin', events: [], manifest_reason: manifest.reason },
      );
    }
  } else {
    push('fail', 'hooks', 'Hooks: not configured', { configured: false });
  }

  // Plugin cache pollution: populated hooks.json in cache AND install.mjs-managed
  // settings.json hooks → runtime registers both → duplicate firing.
  const polluted = scanPluginCacheHookPollution();
  if (polluted.length > 0 && hasHooks) {
    push(
      'fail',
      'plugin_cache',
      `Plugin cache: stale hooks.json in version(s) ${polluted.join(', ')} — duplicate firing alongside settings.json (run 'install' to auto-clear)`,
      { polluted_versions: polluted },
    );
  } else if (polluted.length > 0) {
    push(
      'ok',
      'plugin_cache',
      `Plugin cache: ${polluted.length} version(s) with hooks.json (plugin-only mode)`,
      { polluted_versions: polluted },
    );
  } else if (pluginEnabled || hasHooks) {
    push('ok', 'plugin_cache', 'Plugin cache: no stale hooks.json (no duplicate firing)', {
      polluted_versions: [],
    });
  }

  // Database
  if (existsSync(DB_PATH)) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(DB_PATH, { readonly: true });
      const obs = db.prepare('SELECT COUNT(*) as c FROM observations').get();
      const sess = db.prepare('SELECT COUNT(*) as c FROM session_summaries').get();
      db.close();
      push('ok', 'database', `Database: ${obs.c} observations, ${sess.c} sessions`, {
        exists: true,
        observations: obs.c,
        sessions: sess.c,
      });
    } catch (e) {
      push('warn', 'database', 'Database: exists but check failed — ' + e.message, {
        exists: true,
        error: e.message,
      });
    }
  } else {
    push('warn', 'database', 'Database: not found', { exists: false });
  }

  // CLI
  try {
    execFileSync('claude-mem-lite', ['--help'], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    push('ok', 'cli', 'CLI: claude-mem-lite command available', { available: true });
  } catch {
    push('warn', 'cli', 'CLI: command not on PATH — run install again to create symlink', {
      available: false,
    });
  }

  // Old system
  const vectorDb = join(OLD_DATA_DIR, 'vector-db');
  if (existsSync(vectorDb)) {
    push('warn', 'old_data', 'Old vector-db still exists (can be removed)', { vector_db_exists: true });
  }

  if (json) {
    const out = {};
    for (const c of checks) {
      const { level, key, message, ...extra } = c;
      out[key] = { level, message, ...extra };
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log('\nclaude-mem-lite status\n');
  for (const c of checks) {
    if (c.level === 'ok') ok(c.message);
    else if (c.level === 'warn') warn(c.message);
    else fail(c.message);
  }
  console.log('');
}

// ─── Doctor ─────────────────────────────────────────────────────────────────

async function doctor() {
  // Dogfood-9: structured --json output for CI / wrapper scripts that want to
  // act on individual checks (e.g. "fail my deploy if FTS5 integrity not ok").
  // Implementation strategy: shadow ok/warn/fail/log inside doctor() so every
  // existing call site automatically captures into `checks`, and route final
  // output to JSON or text. Mirror install.mjs::status() shape — { key: {...} }
  // would lose ordering, so use a flat array of { level, message } objects
  // (doctor checks are ordered by significance: deps → server → DB → drift).
  const json = flags.has('--json');
  const checks = [];
  if (!json) console.log('\nclaude-mem-lite doctor\n');

  // Shadow file-level helpers so every call site auto-records.
  const ok = (msg) => {
    checks.push({ level: 'ok', message: msg });
    if (!json) console.log(`  ✓ ${msg}`);
  };
  const warn = (msg) => {
    checks.push({ level: 'warn', message: msg });
    if (!json) console.log(`  ⚠ ${msg}`);
  };
  const fail = (msg) => {
    checks.push({ level: 'fail', message: msg });
    if (!json) console.log(`  ✗ ${msg}`);
  };
  const log = (msg) => {
    if (!json) console.log(`  ${msg}`);
  };

  let issues = 0;
  let warnings = 0;
  // Doctor-local ⚠ helper: visually identical to the file-level `warn`, but
  // bumps `warnings` so the summary line can distinguish "fully green" from
  // "warnings present". Used for informational ⚠ checks; the two ⚠ paths
  // that ALSO bump `issues` (stale procs, dev drift) keep using the file-level
  // `warn` directly to avoid double-counting.
  const dwarn = (msg) => {
    warnings++;
    warn(msg);
  };

  // Node version
  const nodeVer = process.version;
  if (parseInt(nodeVer.slice(1)) >= 18) {
    ok(`Node.js: ${nodeVer}`);
  } else {
    fail(`Node.js ${nodeVer} too old (need >=18)`);
    issues++;
  }

  // Which code homes does this machine actually run? A machine can hold three
  // at once (plugin cache / ~/.claude-mem-lite / npm-global) and each owns its
  // own native binding. Answering about only the dir install.mjs sits in got it
  // wrong both ways in the field: `✗ server.mjs: missing` on a healthy
  // plugin-only install, and `✓ better-sqlite3: verified` while the registered
  // MCP server FATAL'd because a DIFFERENT tree was stale. See lib/install-shape.mjs.
  const shape = detectInstallShape({ home: homedir(), projectDir: PROJECT_DIR, installDir: INSTALL_DIR });

  // Dependencies. Out of process: an in-process open of a STALE .node caches a
  // dead module handle for the rest of doctor and can SIGSEGV on teardown —
  // truncating the report of the very run the user started because things are
  // broken. This is also what makes the native-binding check further down
  // (which reuses these results) honest rather than answering from a poisoned
  // process.
  const rootProbes = probeRuntimeRoots(shape.runtimeRoots);
  const brokenRoots = rootProbes.filter((r) => !r.ok);
  if (rootProbes.length === 0) {
    fail('better-sqlite3: no install on this machine owns a native binding — nothing here can open the DB');
    issues++;
  } else if (brokenRoots.length === 0) {
    ok(
      `better-sqlite3: verified in ${rootProbes.length} install${rootProbes.length === 1 ? '' : 's'} (${rootProbes.map((r) => r.label).join('; ')})`,
    );
  } else {
    // Name the ROOT, not just the fault: the repair is per-tree, and pointing a
    // user at the wrong `cd` is how `rebuild-binding` used to report success
    // while the broken install stayed broken.
    for (const b of brokenRoots) {
      fail(`better-sqlite3 unusable in ${b.label}: ${b.error}`);
      log(`    repair: ${b.repair}`);
      issues++;
    }
  }

  try {
    await import('@modelcontextprotocol/sdk/server/mcp.js');
    ok('@modelcontextprotocol/sdk: verified (import OK)');
  } catch (e) {
    fail(`@modelcontextprotocol/sdk: import failed (${e.message})`);
    issues++;
  }

  // Entry points. These live in ~/.claude-mem-lite ONLY in the install.mjs-managed
  // layout; `/plugin install` provisions the data dir but serves code from the
  // plugin cache, so demanding them there reported two ✗ and exit 1 on a healthy
  // install of the README's recommended method. Grade against the shape that is
  // actually in use.
  if (shape.managed) {
    ok(`server.mjs: ${SERVER_PATH}`);
    ok(`hook.mjs: ${HOOK_PATH}`);
  } else if (shape.activePluginVersion) {
    const v = shape.activePluginVersion;
    ok(
      `Entry points: served from plugin cache v${v.version} (plugin-only install — the ~/.claude-mem-lite code layout is not used)`,
    );
    for (const entry of ['server.mjs', 'hook.mjs', 'cli.mjs']) {
      if (!existsSync(join(v.root, entry))) {
        fail(
          `Plugin cache v${v.version}: ${entry} missing — reinstall with \`/plugin install claude-mem-lite@sdsrss\``,
        );
        issues++;
      }
    }
  } else {
    fail('server.mjs: missing');
    fail('hook.mjs: missing');
    issues += 2;
  }

  // Hook self-heal runtime: the launcher (scripts/hook-launcher.mjs) degrades a
  // broken install to exit 0 so it never spams a Node stack trace on every hook
  // fire. That silence is intentional but hides failure — it drops a breakage
  // marker so this check can surface the otherwise-invisible degraded state.
  const brokenMarker = join(MEM_RUNTIME_DIR, 'hook-launcher-broken');
  if (existsSync(brokenMarker)) {
    let detail = '';
    try {
      const b = JSON.parse(readFileSync(brokenMarker, 'utf8'));
      const ageH = Math.round((Date.now() - (b.ts || 0)) / 3600000);
      detail = ` (last: ${b.reason || 'unknown'}, ~${ageH}h ago)`;
    } catch {
      /* unreadable marker → bare warning */
    }
    dwarn(
      `Hook self-heal: a recent hook fire degraded to exit-0${detail} — run \`node ${join(PROJECT_DIR, 'install.mjs')} repair\``,
    );
  } else {
    ok('Hook self-heal: no recent silent hook breakage');
  }

  // Native DB binding. Two signals, because they answer different questions:
  // the marker says "hooks have been failing" (possibly for days, since the hint
  // is 6h-rate-limited stderr nobody reads), the live probe says "is it broken
  // right now". A Node upgrade breaks every DB-touching path at once, so this is
  // the single highest-value line in doctor when it fires.
  const breakage = readNativeBindingBreakage(MEM_RUNTIME_DIR);
  // Reuses the per-root probes above — same trees, same question, and doctor
  // should not pay for another round of child spawns to ask it twice.
  if (brokenRoots.length > 0) {
    fail(
      `Native DB binding: unusable in ${brokenRoots.map((b) => b.label).join(', ')} — run \`node ${join(PROJECT_DIR, 'cli.mjs')} rebuild-binding\` (repairs every broken install, not just this one)`,
    );
    issues++;
  } else if (breakage) {
    const ageH = Math.round((Date.now() - (breakage.ts || 0)) / 3600000);
    dwarn(
      `Native DB binding: healthy now, but a fire failed ~${ageH}h ago (${breakage.reason || 'unknown'}) — stale marker clears on the next successful rebuild-binding`,
    );
  } else {
    ok(`Native DB binding: loadable on Node ${process.version}`);
  }

  // Disk footprint (audit 2026-08-14 M-9): a "lite" data dir had grown to 653MB
  // against a 59MB DB — 360MB of it orphaned per-tag .bak snapshots — with no
  // check anywhere. Cheap probes only (DB file + .bak aggregate, no tree walk).
  // The budget itself is enforced by lib/db-backup on every new snapshot; this
  // check surfaces stores that predate the budget or exceed it between snapshots.
  try {
    const { listSnapshots, backupBudgetBytes } = await import('./lib/db-backup.mjs');
    const dbFile = join(MEM_DATA_DIR, 'claude-mem-lite.db');
    const dbBytes = existsSync(dbFile) ? statSync(dbFile).size : 0;
    const snaps = listSnapshots(dbFile);
    const backupBytes = snaps.reduce((s, x) => s + x.size, 0);
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    // Warn threshold = the REAL eviction budget (pre-release review 2026-08-16) —
    // warning below it promised an eviction enforceBackupBudget would never do.
    if (backupBytes > backupBudgetBytes()) {
      dwarn(
        `Disk footprint: ${snaps.length} backup snapshot(s) hold ${mb(backupBytes)}MB, over the ${mb(backupBudgetBytes())}MB budget (CLAUDE_MEM_BACKUP_BUDGET_MB) — the next maintain/save snapshot evicts oldest snapshots past the 7d undo grace`,
      );
    } else {
      ok(
        `Disk footprint: DB ${mb(dbBytes)}MB, ${snaps.length} backup snapshot(s) ${mb(backupBytes)}MB (budget ${mb(backupBudgetBytes())}MB)`,
      );
    }
  } catch {
    /* footprint check is informational — never block doctor */
  }

  // Plugin/hook lifecycle state
  const settings = readSettings();
  const hasHooks = hasMemHooksConfigured(settings);
  const pluginDisabled = isPluginExplicitlyDisabled(settings);
  if (pluginDisabled && hasHooks) {
    fail('Plugin lifecycle: plugin is disabled but claude-mem-lite hooks still remain in settings.json');
    issues++;
  } else if (pluginDisabled) {
    ok('Plugin lifecycle: disabled cleanly (no active mem hooks)');
  } else if (hasHooks) {
    ok('Plugin lifecycle: hooks active');
  } else if (shape.activePluginVersion) {
    // Plugin-only: hooks come from the cache's hooks/hooks.json, and an EMPTY
    // settings.json hooks block is the correct state — warning about it told a
    // correctly-installed user their hooks were missing. But "correct state" is
    // only half the question: read the manifest too, or an emptied one passes as
    // the healthy shape (same false green as status).
    const manifest = pluginCacheHookEvents(shape.activePluginVersion.root);
    if (manifest.ok) {
      ok(
        `Plugin lifecycle: hooks served by the plugin manifest (v${shape.activePluginVersion.version}, ${manifest.events.length} events); settings.json correctly holds none`,
      );
    } else {
      fail(
        `Plugin lifecycle: plugin manifest v${shape.activePluginVersion.version} registers NO hooks (${manifest.reason}) and settings.json holds none — every hook is unregistered`,
      );
      log(
        `    Repair: ${hookManifestRepairHint(shape.activePluginVersion.root, join(homedir(), '.claude', 'plugins', 'marketplaces', MARKETPLACE_KEY))}`,
      );
      issues++;
    }
  } else {
    dwarn('Plugin lifecycle: hooks not configured');
  }

  // Orphan hooks: settings.json entries referencing hook files that no longer
  // exist on disk. Trips when a user runs `/plugin uninstall` and/or
  // `rm -rf ~/.claude-mem-lite/` without first running `claude-mem-lite uninstall`
  // (which clears the settings.json entries). The hooks keep firing and exit
  // with require-error noise every session. README's Uninstall section warns
  // about the right ordering; this check flags the broken state so it surfaces
  // even when the user skipped the README.
  const orphanPaths = collectOrphanHookPaths(settings);
  if (orphanPaths.length > 0) {
    fail(
      `Orphan hooks: ${orphanPaths.length} settings.json entr${orphanPaths.length === 1 ? 'y references a missing file' : 'ies reference missing files'}`,
    );
    for (const p of orphanPaths.slice(0, 5)) log(`    missing: ${p}`);
    if (orphanPaths.length > 5) log(`    ... +${orphanPaths.length - 5} more`);
    log(`    Repair: node ${join(PROJECT_DIR, 'install.mjs')} uninstall    # removes the dead hook entries`);
    issues++;
  } else if (hasHooks) {
    ok('Orphan hooks: none (all hook targets present)');
  }

  // Database
  if (existsSync(DB_PATH)) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(DB_PATH, { readonly: true });
      // Check FTS
      const fts = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='observations_fts'")
        .get();
      db.close();
      if (fts) {
        ok('FTS5 index: present');
        // FTS5 integrity check (requires read-write access for INSERT INTO fts VALUES('integrity-check'))
        try {
          const { checkFTSIntegrity, rebuildFTS } = await import('./schema.mjs');
          const rwDb = new Database(DB_PATH);
          rwDb.pragma('busy_timeout = 3000');
          try {
            const { healthy, details } = checkFTSIntegrity(rwDb);
            if (healthy) {
              ok('FTS5 integrity: all indexes healthy');
            } else {
              dwarn('FTS5 integrity issues detected:');
              for (const d of details) log(`    ${d}`);
              log('  Attempting FTS5 rebuild...');
              const { rebuilt, errors } = rebuildFTS(rwDb);
              if (rebuilt.length > 0) ok(`FTS5 rebuilt: ${rebuilt.join(', ')}`);
              if (errors.length > 0) {
                fail(`FTS5 rebuild errors: ${errors.join(', ')}`);
                issues++;
              }
            }
          } finally {
            rwDb.close();
          }
        } catch (e) {
          dwarn('FTS5 integrity check failed: ' + e.message);
        }
      } else {
        dwarn('FTS5 index: missing (will be created on server start)');
      }
    } catch (e) {
      fail('Database: ' + e.message);
      issues++;
    }
  } else {
    dwarn('Database: not found (will be created)');
  }

  // Check for stale processes — extends beyond legacy chroma/worker to
  // catch MCP launchers / servers from cached old plugin versions. Auto-update
  // bumps installed_plugins.json but cannot kill the MCP process spawned for
  // an active session, so v2.60.0/v2.61.0 launchers commonly outlive their
  // version (recurrent pattern, see #2580 for the gsd analogue). Filtering
  // strategy: legacy chroma/worker = always stale; cache-path launchers = only
  // when their version segment ≠ current package.json version; dev-install
  // paths (no version segment) are never flagged.
  try {
    const procs = execFileSync(
      'pgrep',
      ['-af', 'chroma|claude-mem-lite.*(scripts/launch|server)\\.mjs|\\.claude-mem/.*worker'],
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' },
    ).trim();
    const lines = procs.split('\n').filter((l) => l && !l.includes('pgrep'));
    let currentVersion = '';
    try {
      currentVersion = JSON.parse(readFileSync(join(PROJECT_DIR, 'package.json'), 'utf8')).version;
    } catch {
      /* fall through with empty version */
    }
    const stale = lines.filter((l) => isStaleMemProcess(l, currentVersion));
    if (stale.length > 0) {
      // ⚠-level ONLY, deliberately not `issues++`. buildDoctorSummary's contract is
      // "issues are ✗-level (action required); warnings are ⚠-level (informational)",
      // and an old process is the one finding here the user cannot act on from a
      // doctor run: auto-update bumps installed_plugins.json but cannot kill the MCP
      // process an active session already spawned, so a correct, healthy install
      // reports this for as long as that session lives. Counting it made `doctor`
      // exit 1 while every line on screen was ✓ or ⚠ — it failed the v3.70.0 release
      // `validate` job (where the "old processes" were vitest's own workers) and it
      // reddens doctor-install-shape-e2e's "instead of going red forever" case on any
      // dev box with a previous-version session still open.
      //
      // `dwarn`, not the bare `warn`: the first cut called the bare one, which prints the
      // ⚠ line but never touches the `warnings` counter — so a doctor run whose ONLY
      // finding was a stale launcher printed the ⚠ and then closed with
      // "All checks passed!". That is the exact sentence buildDoctorSummary's docblock
      // says must not lie, and the exact case tests/doctor-summary.test.mjs pins at the
      // pure-function level; the counter simply never reached it from here. `dwarn`
      // increments `warnings` only — `issues` stays 0, so the paragraph above still
      // holds and `doctor` still exits 0.
      dwarn(
        `Old processes running${currentVersion ? ` (current: v${currentVersion})` : ''}:\n    ` +
          stale.join('\n    '),
      );
    } else {
      ok('No stale processes');
    }
  } catch {
    ok('No stale processes');
  }

  // Update state
  try {
    const stateFile = join(MEM_DATA_DIR, 'runtime', 'update-state.json'); // runtime-dir:stays-put — installation identity
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      const parts = [];
      if (state.lastCheck) parts.push(`last check: ${state.lastCheck}`);
      if (state.latestVersion) parts.push(`latest: v${state.latestVersion}`);
      if (state.lastUpdate) parts.push(`last update: ${state.lastUpdate}`);
      if (state.updateAvailable) parts.push('update pending');
      if (state.rateLimited) parts.push('rate-limited');
      if (state.lastError) parts.push(`last error: ${state.lastError}`);
      ok(`Update state: ${parts.join(', ') || 'empty'}`);
    } else if (isDevInstall()) {
      // Dev installs symlink server.mjs → project source; hook-update.mjs
      // short-circuits before writing state (see hook-update.mjs isDevMode).
      ok('Update state: skipped (dev mode — symlinked install)');
    } else {
      dwarn('Update state: no state file (first run?)');
    }
  } catch {
    dwarn('Update state: failed to read');
  }

  // LLM provider reachability. Doctor had no provider check at all, which is how
  // a configured OPENROUTER_API_KEY could sit unusable for weeks behind an
  // all-green report while every background call silently paid the CLI fallback.
  // Transport only, and only when a key is set — no key means no probe and no
  // network touched.
  try {
    const { llmProviderStatus } = await import('./lib/llm-provider-probe.mjs');
    const st = await llmProviderStatus();
    if (st.level === 'ok') ok(st.message);
    else dwarn(st.message);
  } catch {
    dwarn('LLM provider: check failed');
  }

  // Dev drift: in dev-mode installs, all SOURCE_FILES entries should be
  // symlinks. A plain file means an earlier install (or manual cp) copied it
  // (edits in the repo won't propagate). A missing entry (neither symlink nor
  // plain) means an earlier install never wrote the file — same divergence
  // class. Per #8043: "is this file present ≠ is this install consistent" —
  // missing is tracked separately by checkDevDrift but the caller MUST surface
  // it to honour #8268's "gate the all-green string on every counter" rule.
  // Gated on the managed layout existing at all. SOURCE_FILES describes what
  // `install` deploys into ~/.claude-mem-lite; on a plugin-only install nothing
  // was ever deployed there, so every entry reads as "missing" and this reported
  // `⚠ Managed files: 121 missing` + an issue on a correct install — prescribing
  // a repair against a path that does not exist.
  try {
    const skipDrift = !shape.managed && !!shape.activePluginVersion;
    const { checkDevDrift } = await import('./lib/doctor-drift.mjs');
    const r = skipDrift ? null : checkDevDrift(INSTALL_DIR, SOURCE_FILES);
    const devRemedy = `re-run: node ${join(PROJECT_DIR, 'install.mjs')} install --dev`;
    const nameList = (files, count) => {
      const suffix = count > files.length ? ` +${count - files.length} more` : '';
      return `${files.join(', ')}${suffix}`;
    };
    if (skipDrift) {
      ok(
        'Managed files: n/a (plugin-only install — code is served from the plugin cache, so ~/.claude-mem-lite holds data only)',
      );
    } else if (r.devMode) {
      const parts = [];
      if (r.plainCount > 0) {
        parts.push(`${r.plainCount} non-symlink: ${nameList(r.plainFiles.slice(0, 5), r.plainCount)}`);
      }
      if (r.missingEntryCount > 0) {
        parts.push(
          `${r.missingEntryCount} missing ENTRY POINT: ${nameList(r.missingEntryFiles, r.missingEntryCount)}`,
        );
      }
      if (parts.length > 0) {
        // Hard: a non-symlink means repo edits stop propagating, and a missing entry point
        // means the hook/CLI command that names that path cannot start at all. A hybrid
        // install also loses the realpath argument below — a COPIED entry point resolves
        // its imports against the install dir, so absent modules can throw there.
        if (r.missingModuleCount > 0) {
          parts.push(
            `${r.missingModuleCount} missing module: ${nameList(r.missingModuleFiles, r.missingModuleCount)}`,
          );
        }
        warn(`Dev drift: ${parts.join('; ')} (${devRemedy})`);
        issues++;
      } else if (r.missingModuleCount > 0) {
        // Informational, NOT an issue: in a pure-symlink install every entry point resolves
        // to the repo, and Node resolves each module's imports against that REALPATH — so an
        // import-only file absent from the install dir is unreachable, not broken. Reporting
        // it as drift prescribed `install --dev` for a demonstrably healthy install (the
        // maintainer's own machine ran every one of those modules fine while doctor called
        // them missing).
        dwarn(
          `Dev drift: ${r.symlinkCount} symlinks, 0 plain, all entry points present — ` +
            `${r.missingModuleCount} import-only file(s) not linked into the install dir ` +
            `(${nameList(r.missingModuleFiles, r.missingModuleCount)}). Harmless: Node resolves ` +
            `imports against each entry point's realpath, i.e. the repo. ${devRemedy} to link them.`,
        );
      } else {
        ok(`Dev drift: clean (${r.symlinkCount} symlinks, 0 plain, 0 missing)`);
      }
    } else if (r.missingCount > 0) {
      // COPY install (npm / plugin / `install` without --dev). Here the realpath argument
      // does NOT apply: entry points are real files, so `../lib/x.mjs` resolves against the
      // install dir and a missing module is an ERR_MODULE_NOT_FOUND on every hook fire.
      // This case used to print NOTHING — checkDevDrift returns devMode=false and both the
      // warning and the all-clear were gated on devMode, so the shape where missing files
      // are FATAL was the silent one (#8268's rule failing in the other direction).
      const parts = [];
      if (r.missingEntryCount > 0) {
        parts.push(
          `${r.missingEntryCount} entry point: ${nameList(r.missingEntryFiles, r.missingEntryCount)}`,
        );
      }
      if (r.missingModuleCount > 0) {
        parts.push(`${r.missingModuleCount} module: ${nameList(r.missingModuleFiles, r.missingModuleCount)}`);
      }
      // `claude-mem-lite update` is the observation editor (`update <id>`); the
      // self-updater is `self-update`. Naming the wrong one sent the user to a
      // usage error at the exact moment their install was incomplete.
      warn(
        `Managed files: ${r.missingCount} missing (${parts.join('; ')}) — a copy install resolves ` +
          `imports against the install dir, so these throw at hook time. Fix: claude-mem-lite self-update ` +
          `(or: node ${join(INSTALL_DIR, 'install.mjs')} repair)`,
      );
      issues++;
    }
    // Complete copy install: no message — drift is a dev-install concern.
  } catch (e) {
    dwarn('Dev drift: check failed — ' + e.message);
  }

  // Hook scripts: the check above grades SOURCE_FILES, which holds zero `scripts/` entries.
  // Hook scripts ship from the separate HOOK_SCRIPT_FILES manifest into
  // ~/.claude-mem-lite/scripts/, and every settings.json hook command names one of those
  // absolute paths — so "the tarball shipped without scripts/" (source-files.mjs:243) killed
  // every hook while doctor printed an all-clear. Both classes are issues here; see
  // checkHookScriptDrift for why the managed-files demote branch must not be copied over.
  try {
    // Same gate as the managed-files check: a plugin-only install never deploys into
    // ~/.claude-mem-lite, and its hooks run from ${CLAUDE_PLUGIN_ROOT}/scripts/ instead.
    const skipScripts = !shape.managed && !!shape.activePluginVersion;
    const { checkHookScriptDrift, HOOK_SCRIPT_ENTRY_POINTS } = await import('./lib/doctor-drift.mjs');
    const h = skipScripts ? null : checkHookScriptDrift(INSTALL_DIR, HOOK_SCRIPT_FILES);
    const scriptRemedy = `claude-mem-lite self-update (or: node ${join(INSTALL_DIR, 'install.mjs')} repair)`;
    if (skipScripts) {
      ok('Hook scripts: n/a (plugin-only install — hooks run from the plugin cache)');
    } else if (!h.present) {
      warn(
        `Hook scripts: ${join(INSTALL_DIR, 'scripts')} ` +
          `${h.dirSymlink ? 'is a dangling symlink' : 'is absent'} — all ${HOOK_SCRIPT_ENTRY_POINTS.size} hook ` +
          `commands name absolute paths under it, so no hook can fire. Fix: ${scriptRemedy}`,
      );
      issues++;
    } else if (h.missingCount > 0) {
      const parts = [];
      if (h.missingEntryFiles.length > 0) {
        parts.push(
          `${h.missingEntryFiles.length} hook entry (${h.missingEntryFiles.join(', ')}) — the command cannot start`,
        );
      }
      if (h.missingModuleFiles.length > 0) {
        parts.push(
          `${h.missingModuleFiles.length} imported helper (${h.missingModuleFiles.join(', ')}) — ERR_MODULE_NOT_FOUND at hook time`,
        );
      }
      warn(`Hook scripts: ${h.missingCount} missing — ${parts.join('; ')}. Fix: ${scriptRemedy}`);
      issues++;
    } else {
      ok(
        `Hook scripts: ${HOOK_SCRIPT_FILES.length} present ` +
          `(${h.dirSymlink ? 'dev — scripts/ symlinked to the repo' : 'copy install'})`,
      );
    }
  } catch (e) {
    dwarn('Hook scripts: check failed — ' + e.message);
  }

  // Stale temp files
  try {
    // hook-update + the episode workers write runtime/ + staging under DB_DIR
    // (= MEM_DATA_DIR, env-aware), NOT the homedir code dir — scan there so doctor
    // sees the real residue under relocation. MEM_RUNTIME_DIR rather than
    // join(MEM_DATA_DIR,'runtime'): `pending-*` / `ep-flush-*` are written through
    // hook-shared.mjs's override-aware RUNTIME_DIR, and `cleanup()` below deletes them from
    // MEM_RUNTIME_DIR — v3.93.0 moved the deleter and left this scanner behind, so under the
    // override doctor reported "none" while the cleanup it recommends removed files.
    const runtimeDir = MEM_RUNTIME_DIR;
    let staleCount = 0;
    const stalePatterns = ['.update-staging-', '.update-backup-'];
    if (existsSync(MEM_DATA_DIR)) {
      for (const f of readdirSync(MEM_DATA_DIR)) {
        if (stalePatterns.some((p) => f.startsWith(p))) staleCount++;
      }
    }
    if (existsSync(runtimeDir)) {
      for (const f of readdirSync(runtimeDir)) {
        if (f.startsWith('pending-') || f.startsWith('ep-flush-')) staleCount++;
      }
    }
    if (staleCount > 0) {
      dwarn(`Stale temp files: ${staleCount} found (run: node install.mjs cleanup)`);
    } else {
      ok('Stale temp files: none');
    }
  } catch {
    dwarn('Stale temp files: check failed');
  }

  // DB stats
  if (existsSync(DB_PATH)) {
    try {
      const dbSize = statSync(DB_PATH).size;
      const sizeMB = (dbSize / 1024 / 1024).toFixed(1);
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(DB_PATH, { readonly: true });
      const obsCount = db.prepare('SELECT COUNT(*) as cnt FROM observations').get()?.cnt || 0;
      // Align with stats / MCP mem_stats: session_summaries, not sdk_sessions
      const sessCount = db.prepare('SELECT COUNT(*) as cnt FROM session_summaries').get()?.cnt || 0;
      db.close();
      ok(`DB stats: ${sizeMB}MB, ${obsCount} observations, ${sessCount} sessions`);
    } catch (e) {
      dwarn('DB stats: ' + e.message);
    }
  }

  // Env flags that are ACCEPTED but do nothing. A flag a user set and believes is
  // in effect is a silent lie the rest of doctor cannot see: every other check here
  // asks whether the install is healthy, and this install is perfectly healthy while
  // behaving as though the flag were unset (audit 2026-08-22 P2-5).
  // Dynamically imported, and the mode table is read from the module that owns it:
  // a static import would drag the registry retriever's dependency chain into a tool
  // whose whole job is to run when the tree is broken, and a local copy of the list
  // is the drift shape this repo keeps paying for.
  try {
    const { getRequestedRecommendMode, RECOMMEND_MODE_UNIMPLEMENTED } =
      await import('./registry-recommend.mjs');
    const requested = getRequestedRecommendMode();
    if (RECOMMEND_MODE_UNIMPLEMENTED.has(requested)) {
      dwarn(
        `CLAUDE_MEM_RECOMMEND_MODE=${requested}: accepted but NOT implemented — ` +
          'live skill-recommendation injection is Phase 2 and does not exist. The engine ' +
          'is running in shadow (logs only, injects nothing). Set shadow or off.',
      );
    }
  } catch (e) {
    dwarn('Env flags: check failed — ' + e.message);
  }

  // Plugin cache versions
  const pluginCacheBase = join(homedir(), '.claude', 'plugins', 'cache', MARKETPLACE_KEY, 'claude-mem-lite');
  if (existsSync(pluginCacheBase)) {
    try {
      const versions = readdirSync(pluginCacheBase).filter((n) => /^\d+\./.test(n));
      let sizeStr;
      try {
        sizeStr = execFileSync('du', ['-sh', pluginCacheBase], { encoding: 'utf8', timeout: 5000 })
          .trim()
          .split('\t')[0];
      } catch {
        sizeStr = '?';
      }
      if (versions.length > 3) {
        dwarn(
          `Plugin cache: ${versions.length} versions (${sizeStr}) — run setup.sh or update to auto-prune to 3`,
        );
      } else {
        ok(`Plugin cache: ${versions.length} version(s) (${sizeStr})`);
      }
    } catch {}
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          issues,
          warnings,
          summary: buildDoctorSummary(issues, warnings),
          checks,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\n  ${buildDoctorSummary(issues, warnings)}\n`);
  }
  // Diagnostic-tool exit-code contract: any ✗-level finding must propagate non-zero
  // so CI / wrapper scripts (`claude-mem-lite doctor || alert`) actually trip. Keeps
  // ⚠-only states at exit 0 (#8268 already established the visual ⚠ vs counted-issue
  // separation; this propagates that count to the shell).
  if (issues > 0) process.exitCode = 1;
}

// ─── Settings helpers ───────────────────────────────────────────────────────

// Identify a settings hook as one of OURS (to replace on install / strip on uninstall).
// Must be tight: the old `hook.mjs` + event-word test matched a user's OWN generic hook
// (`node ~/.config/hook.mjs session-start`) and install/uninstall silently deleted it.
// The launcher marker (`hook-launcher.mjs`, which every Node hook routes through since v2.84)
// replaces that clause; the product-name substring (our install-dir / legacy-direct hooks)
// and the bash prefilter round out the real markers.
export function isMemHook(cfg) {
  if (!cfg.hooks) return false;
  return cfg.hooks.some((h) => {
    const cmd = h.command || '';
    return (
      cmd.includes('claude-mem-lite') ||
      cmd.includes('hook-launcher.mjs') ||
      cmd.includes('scripts/post-tool-use.sh') ||
      // Same reason post-tool-use.sh is named here: a bash prefilter routes through
      // NO launcher, and the product-name clause only fires when the install dir
      // happens to contain it — which CLAUDE_MEM_DIR can relocate. Without this line
      // an Agent|Task hook in a relocated install survives uninstall and duplicates
      // on reinstall (audit 2026-08-22 P2-5 added the second prefilter).
      cmd.includes('scripts/pre-agent-inject.sh')
    );
  });
}

function hasMemHooksConfigured(settings) {
  if (!settings?.hooks) return false;
  return Object.values(settings.hooks).some(
    (configs) => Array.isArray(configs) && configs.some((cfg) => isMemHook(cfg)),
  );
}

/**
 * Walk every mem-hook command in settings.json and collect any absolute file
 * paths that don't currently exist on disk. Used by doctor() to surface
 * post-uninstall residue ("/plugin uninstall claude-mem-lite" leaves
 * settings.json hooks pointing at ~/.claude-mem-lite/hook.mjs; if the user
 * then deleted that directory, every session start dispatches to a missing
 * file).
 *
 * Path extraction: command strings look like:
 *   node "/home/sds/.claude-mem-lite/hook.mjs" session-start
 *   bash "/home/sds/.claude-mem-lite/scripts/post-tool-use.sh"
 *   node "/home/sds/.claude-mem-lite/scripts/pre-tool-recall.js"
 *
 * Scan order (v2.80+): walk EVERY quoted token via matchAll, prefer ones that
 * look like a hook path (absolute + ends in a known hook-runtime extension).
 * If no quoted token qualifies, fall back to the first path-shaped token from
 * a whitespace-split of the command. If both miss, skip the entry entirely —
 * deliberate bias toward **under-reporting over false-flagging**: a wrapper
 * like `bash -c "inline" "/real/path.sh"` should report the real path, not
 * the inline string. ${CLAUDE_PLUGIN_ROOT}-templated commands are ignored —
 * those are plugin-owned hooks resolved by Claude Code at runtime, not by us.
 *
 * Extension list (HOOK_PATH_EXTS) is hardcoded for the runtimes this plugin
 * actually registers (node/bash). Extend if Claude Code ever supports new
 * hook runtimes (e.g. python/.py). Currently safe because isMemHook() filters
 * to claude-mem-lite-owned hooks only — foreign runtimes can't reach here.
 */
const HOOK_PATH_EXTS = ['.mjs', '.js', '.cjs', '.sh'];

function looksLikeHookPath(p) {
  if (!p || !p.startsWith('/')) return false;
  return HOOK_PATH_EXTS.some((ext) => p.endsWith(ext));
}

export function collectOrphanHookPaths(settings) {
  if (!settings?.hooks) return [];
  const out = [];
  for (const configs of Object.values(settings.hooks)) {
    if (!Array.isArray(configs)) continue;
    for (const cfg of configs) {
      if (!isMemHook(cfg)) continue;
      for (const h of cfg.hooks || []) {
        const cmd = h.command || '';
        if (cmd.includes('${CLAUDE_PLUGIN_ROOT}')) continue;
        // v2.80: scan ALL quoted tokens (was: only the first), prefer ones
        // that look like a hook path. Fixes a footgun where a wrapper command
        // like `bash -c "some inline" "/real/path.sh"` would pick "some inline"
        // and flag a false orphan. If no quoted token looks like a path, fall
        // through to the unquoted scanner; if that also misses, skip the
        // entry — we'd rather under-report than false-flag.
        let path = null;
        for (const m of cmd.matchAll(/"([^"]+)"/g)) {
          if (looksLikeHookPath(m[1])) {
            path = m[1];
            break;
          }
        }
        if (!path) {
          const parts = cmd.split(/\s+/);
          path = parts.find((p) => looksLikeHookPath(p)) || null;
        }
        if (!path) continue;
        if (!existsSync(path) && !out.includes(path)) out.push(path);
      }
    }
  }
  return out;
}

/**
 * v2.48 P1-4: prune top-level stale files left behind by removed-module upgrades.
 *
 * Strict whitelist: only removes files under `dataDir` (no recursion) that match
 *   - `*.mjs` whose basename is NOT in SOURCE_FILES (comparing against both the
 *     bare entry and any `subdir/basename` entry flattened to its basename — the
 *     prune intentionally skips subdir files; see below)
 *   - 0-byte `.db` files that are NOT in the protected-db allow-list
 *
 * Protections (never touched):
 *   - subdirectories (managed/, runtime/, scripts/, lib/, cli/, commands/, server/, node_modules/, .claude-plugin/, registry/, etc.)
 *   - non-empty `.db` files — real data risk, always preserved
 *   - WAL/SHM (`*-wal`, `*-shm`) transients
 *   - files not ending in `.mjs` or `.db`
 *   - the two canonical DBs (`claude-mem-lite.db`, `resource-registry.db`) even when 0-byte (fresh-install transient state)
 *
 * @param {string} dataDir Absolute path, typically `~/.claude-mem-lite`
 * @param {string[]} sourceFiles SOURCE_FILES manifest
 * @returns {string[]} Absolute paths of files that were deleted (ordered by readdir)
 */
export function pruneStaleInstallFiles(dataDir, sourceFiles) {
  if (!existsSync(dataDir)) return [];
  // Flatten manifest to just top-level basenames. SOURCE_FILES contains entries
  // like 'lib/activity.mjs' — those belong to a subdir and prune never touches
  // subdirs anyway. For top-level entries ('server.mjs'), basename === entry.
  const topLevelAllowed = new Set(sourceFiles.filter((f) => !f.includes('/')).map((f) => f));
  const PROTECTED_DBS = new Set(['claude-mem-lite.db', 'resource-registry.db']);
  const removed = [];
  let entries;
  try {
    entries = readdirSync(dataDir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const full = join(dataDir, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    // Skip directories and symlinks (dev mode uses symlinks; treat as intentional).
    if (!st.isFile()) continue;
    if (name.endsWith('.mjs') && !topLevelAllowed.has(name)) {
      try {
        unlinkSync(full);
        removed.push(full);
      } catch {
        /* best-effort */
      }
      continue;
    }
    if (name.endsWith('.db') && !PROTECTED_DBS.has(name) && st.size === 0) {
      try {
        unlinkSync(full);
        removed.push(full);
      } catch {
        /* best-effort */
      }
    }
  }
  return removed;
}

export function clearPluginDisabledMarkerForDirectInstall(settings) {
  if (settings?.enabledPlugins?.[PLUGIN_KEY] !== false) return false;
  delete settings.enabledPlugins[PLUGIN_KEY];
  if (Object.keys(settings.enabledPlugins).length === 0) delete settings.enabledPlugins;
  return true;
}

function cleanupMemHooksFromSettings(settings) {
  if (!settings?.hooks) return 0;

  let removed = 0;
  for (const [event, configs] of Object.entries(settings.hooks)) {
    if (!Array.isArray(configs)) continue;
    const kept = configs.filter((cfg) => !isMemHook(cfg));
    removed += configs.length - kept.length;
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

function getInstalledPluginEntries(installed) {
  if (installed?.plugins && typeof installed.plugins === 'object') return installed.plugins;
  return installed && typeof installed === 'object' ? installed : {};
}

export function hasOtherMarketplacePlugins(
  installed,
  marketplaceKey = MARKETPLACE_KEY,
  pluginKey = PLUGIN_KEY,
) {
  const plugins = getInstalledPluginEntries(installed);
  return Object.keys(plugins).some((key) => key !== pluginKey && key.endsWith(`@${marketplaceKey}`));
}

function readSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  // Atomic (pid-unique temp + rename) with a one-time .bak: settings.json is the
  // user's Claude Code config. The old fixed ".tmp" name let concurrent installs
  // clobber each other's temp mid-write, and there was no recovery artifact if a
  // hook-merge bug dropped user config. atomicWriteFileSync handles dir creation.
  atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', { backup: true });
}

// ─── Cleanup Stale Files ─────────────────────────────────────────────────────

function cleanup() {
  // Dogfood-7 addition: --dry-run lists which files would be removed without
  // touching disk. Useful before running cleanup on a remote/CI machine where
  // accidentally pruning the wrong file would be costly. Doctor reports stale
  // file counts and points users here; --dry-run lets them confirm the list.
  const dryRun = flags.has('--dry-run');
  console.log(`\nclaude-mem-lite cleanup${dryRun ? ' (--dry-run)' : ''}\n`);
  let removed = 0;

  // Clean .update-staging-* / .update-backup-* — hook-update writes these under
  // DB_DIR (= MEM_DATA_DIR, env-aware), so scan the data dir, not the homedir code dir.
  const stalePatterns = ['.update-staging-', '.update-backup-'];
  if (existsSync(MEM_DATA_DIR)) {
    for (const f of readdirSync(MEM_DATA_DIR)) {
      if (stalePatterns.some((p) => f.startsWith(p))) {
        if (dryRun) {
          ok(`Would remove: ${f}`);
          removed++;
          continue;
        }
        try {
          rmSync(join(MEM_DATA_DIR, f), { recursive: true, force: true });
          ok(`Removed: ${f}`);
          removed++;
        } catch (e) {
          warn(`Failed to remove ${f}: ${e.message}`);
        }
      }
    }
  }

  // Clean pending-* / ep-flush-* in runtime/ (env-aware, and honouring the runtime override)
  const runtimeDir = MEM_RUNTIME_DIR;
  if (existsSync(runtimeDir)) {
    for (const f of readdirSync(runtimeDir)) {
      if (f.startsWith('pending-') || f.startsWith('ep-flush-')) {
        if (dryRun) {
          ok(`Would remove: runtime/${f}`);
          removed++;
          continue;
        }
        try {
          rmSync(join(runtimeDir, f), { force: true });
          ok(`Removed: runtime/${f}`);
          removed++;
        } catch (e) {
          warn(`Failed to remove runtime/${f}: ${e.message}`);
        }
      }
    }
  }

  // Reap leaked test-fixture sandboxes from temp (mem-e2e-* / mem-audit-* / cite-*
  // etc.) left by interrupted vitest runs — the §8.V4 disposal gap the audit found
  // (~795MB). 24h age here (vs 1h in the test reaper) is conservative for a manual
  // cleanup. Scans os.tmpdir() and the Claude Code temp root, depth-1, mem-prefixes
  // only — never touches other tools' temp dirs.
  const fixtureRoots = [tmpdir(), join(homedir(), '.claude', 'tmp')];
  const swept = sweepStaleTestFixtures({ dirs: fixtureRoots, ageMs: 24 * 60 * 60 * 1000, dryRun });
  for (const p of swept.names) ok(`${dryRun ? 'Would remove' : 'Removed'}: ${p}`);
  removed += swept.removed;

  const verb = dryRun ? 'would be removed' : 'removed';
  console.log(`\n  ${removed === 0 ? 'No stale files found.' : `${removed} stale file(s) ${verb}.`}\n`);
}

// ─── Manual Update ───────────────────────────────────────────────────────────

async function manualUpdate() {
  console.log('\nclaude-mem-lite update\n');

  // Force check by importing hook-update (bypasses throttle for manual use)
  const { checkForUpdate, getCurrentVersion } = await import('./hook-update.mjs');
  log('Checking for updates...');
  const result = await checkForUpdate({ force: true, allowInstall: true });

  if (result?.updated) {
    ok(`Updated: v${result.from} → v${result.to}`);
  } else if (result?.updateAvailable && result?.installDeferred) {
    warn(`v${result.to} available — plugin mode only checks for updates.`);
    log('  To upgrade, inside Claude Code run:');
    log('    /plugin marketplace update sdsrss');
    log('    /plugin install claude-mem-lite@sdsrss');
  } else if (result?.updateAvailable) {
    warn(`v${result.to} available but install failed — try: node install.mjs install`);
  } else {
    const ver = getCurrentVersion();
    ok(`Already up to date (v${ver})`);
  }
  console.log('');
}

// ─── Repair: Re-sync from latest GitHub Release ─────────────────────────────
// Recovery path for installs broken by a partial auto-update (most often the
// stale-manifest bug fixed in v2.84.0: hook-update.mjs copied the new hook.mjs
// but skipped a new lib/* entry, leaving an ERR_MODULE_NOT_FOUND that
// permanently disables the hook chain — including the next auto-update that
// would have healed it). Self-contained: downloads a fresh tarball and spawns
// the tarball's own install.mjs install, so the recovery path always runs the
// latest code even when local install.mjs / hook-update.mjs are themselves
// buggy on disk.
async function repair() {
  console.log('\nclaude-mem-lite repair — re-syncing from the latest SIGNED GitHub release\n');
  const stagingDir = mkdtempSync(join(tmpdir(), 'claude-mem-lite-repair-'));
  try {
    // Resolve the latest RELEASE (tag) and cryptographically VERIFY it before running any
    // downloaded code — parity with the auto-update path (hook-update.downloadAndInstall).
    // The old code fetched `/tarball` (default-branch main HEAD, unreleased WIP) and ran its
    // install.mjs UNVERIFIED, and this path is auto-triggered by hook-launcher on any
    // ERR_MODULE_NOT_FOUND — so a drifted install silently self-healed onto main, and a
    // repo/TLS-MITM compromise achieved RCE, bypassing the Ed25519 signed-release control that
    // the manual `update` path enforces. Lazy import so a missing/broken hook-update dependency
    // degrades to the manual fallback (fail-closed) rather than to unverified auto-install.
    let fetchLatestRelease,
      verifyReleaseAuthenticity,
      validateExtractedTarball,
      isRepairDowngrade,
      getCurrentVersion;
    try {
      ({
        fetchLatestRelease,
        verifyReleaseAuthenticity,
        validateExtractedTarball,
        isRepairDowngrade,
        getCurrentVersion,
      } = await import('./hook-update.mjs'));
    } catch (e) {
      throw new Error(
        `cannot load the verified-update path (${e.message}) — refusing to auto-install unverified code`,
        { cause: e },
      );
    }
    const rel = await fetchLatestRelease();
    if (!rel || !rel.tarballUrl)
      throw new Error('could not resolve the latest release (network / rate-limit)');
    // Rollback guard: refuse to repair BACKWARD onto an older validly-signed release replayed
    // as "latest" (the only attack signing leaves open). Skipped when the local version is
    // unreadable — a broken install still needs repair; the signature check below still gates
    // authenticity either way.
    let localVersion = null;
    try {
      localVersion = getCurrentVersion();
    } catch {
      /* broken install → allow repair */
    }
    if (isRepairDowngrade(rel.version, localVersion)) {
      throw new Error(
        `refusing to repair BACKWARD: resolved release v${rel.version} is older than installed v${localVersion} (possible signed-release rollback)`,
      );
    }
    // URL allow-list mirrors hook-update.downloadAndInstall — only github.com tarball URLs.
    if (!/^https:\/\/(?:api\.)?github\.com\/[a-zA-Z0-9./_-]+$/.test(rel.tarballUrl)) {
      throw new Error(`refusing suspicious tarball URL: ${rel.tarballUrl}`);
    }
    const tarballPath = join(stagingDir, 'release.tgz');
    log(`Downloading release v${rel.version}...`);
    execFileSync(
      'curl',
      ['-sL', '-f', '-H', 'Accept: application/vnd.github+json', rel.tarballUrl, '-o', tarballPath],
      { timeout: 60000, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    log('Extracting...');
    execFileSync('tar', ['xzf', tarballPath, '-C', stagingDir, '--strip-components=1'], {
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    // Defense-in-depth on the extracted tarball (name + version === resolved tag + entry
    // points) BEFORE the signature check — parity with hook-update.downloadAndInstall. Catches
    // a wrong-version / truncated / squatter artifact whose package.json doesn't match the tag.
    const tarballValid = validateExtractedTarball(stagingDir, rel.version);
    if (!tarballValid.ok) throw new Error(`extracted tarball failed validation: ${tarballValid.reason}`);
    // Verify the Ed25519 signature BEFORE running the downloaded install.mjs. Fail-closed:
    // any tampering / missing-signature / fetch-failure aborts to the manual fallback.
    log('Verifying release signature...');
    const authentic = await verifyReleaseAuthenticity(stagingDir, rel.assets);
    if (!authentic.ok) throw new Error(`release signature check failed (${authentic.action})`);
    const tarballInstaller = join(stagingDir, 'install.mjs');
    if (!existsSync(tarballInstaller)) throw new Error('verified tarball missing install.mjs');
    log('Re-running install from the verified release sources...');
    execFileSync(process.execPath, [tarballInstaller, 'install'], { stdio: 'inherit', timeout: 300000 });
    ok(`Repair complete — resynced from verified release v${rel.version}`);
  } catch (e) {
    fail(`Repair failed: ${e.message}`);
    console.log('');
    console.log('  Automatic repair fails closed rather than run unverified code.');
    console.log('  Manual fallback — run this in any shell (you are choosing to trust it):');
    console.log('');
    console.log(
      '  T=$(mktemp -d) && curl -sL https://api.github.com/repos/sdsrss/claude-mem-lite/tarball | tar xz -C "$T" --strip-components=1 && node "$T/install.mjs" install',
    );
    console.log('');
    process.exit(1);
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
  }
}

// ─── Release: Sync Versions ─────────────────────────────────────────────────

function syncVersions() {
  console.log('\nclaude-mem-lite release — sync versions\n');

  const pkg = JSON.parse(readFileSync(join(PROJECT_DIR, 'package.json'), 'utf8'));
  const version = pkg.version;
  log(`package.json version: ${version}`);

  const pluginJsonPath = join(PROJECT_DIR, '.claude-plugin', 'plugin.json');
  if (existsSync(pluginJsonPath)) {
    const r = bumpJsonField(pluginJsonPath, ['version'], version);
    ok(r.changed ? `plugin.json: ${r.prev} → ${version}` : `plugin.json: already ${version}`);
  } else {
    warn('plugin.json not found');
  }

  const marketJsonPath = join(PROJECT_DIR, '.claude-plugin', 'marketplace.json');
  if (existsSync(marketJsonPath)) {
    const r = bumpJsonField(marketJsonPath, ['plugins', 0, 'version'], version);
    if (r.prev === undefined) warn('marketplace.json: plugins[0] not found');
    else ok(r.changed ? `marketplace.json: ${r.prev} → ${version}` : `marketplace.json: already ${version}`);
  } else {
    warn('marketplace.json not found');
  }

  // Sync CLAUDE.md `**Version**: x.y.z` line — install-e2e asserts this
  // matches package.json so omitting it here would break CI on every release.
  const claudeMdPath = join(PROJECT_DIR, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const orig = readFileSync(claudeMdPath, 'utf8');
    const patched = patchClaudeMdVersion(orig, version);
    if (patched !== null) {
      if (patched !== orig) {
        writeFileSync(claudeMdPath, patched);
        ok(`CLAUDE.md: → ${version}`);
      } else {
        ok(`CLAUDE.md: already ${version}`);
      }
    } else {
      warn('CLAUDE.md: `**Version**:` line not found — skipped');
    }
  } else {
    warn('CLAUDE.md not found');
  }

  console.log('');
}

// Regenerate package-lock.json via npm@10.9.2 to guarantee CI parity. The
// drift this prevents: `npm install --package-lock-only` on npm@11+ silently
// strips top-level `@emnapi/core` + `@emnapi/runtime` entries when those are
// transitive deps of platform-optional bindings (e.g. `@oxc-parser/binding-*`
// from knip), and CI's bundled npm@10 (Node 22 default in GitHub Actions)
// then refuses `npm ci` with EUSAGE. Same recipe bit twice (#8271 / 2.58.2 /
// 2.62.1) before this guard. The packageManager field in package.json
// declares the same version for corepack-aware tooling. Network cost: ~5-30s
// per release; release cadence makes this acceptable.
function regenerateLockfile() {
  console.log('\nclaude-mem-lite release — regenerate lockfile (npm@10.9.2)\n');
  try {
    execFileSync('npx', ['--yes', 'npm@10.9.2', 'install'], {
      stdio: 'inherit',
      cwd: PROJECT_DIR,
    });
    ok('lockfile regenerated');
  } catch (e) {
    fail('lockfile regen failed: ' + e.message);
    throw e;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

// An install can own MORE THAN ONE better-sqlite3 tree (dev repo, ~/.claude-mem-lite,
// the plugin cache), each with its own .node — and only the one the RUNNING code
// resolves matters, i.e. the one next to this file. Rebuilding the wrong tree
// reports success while every hook keeps failing. Fall back to INSTALL_DIR when
// this file sits in a source-only layout with no deps of its own.
/**
 * Is this `pgrep -af` line a stale claude-mem process worth flagging?
 *
 * Extracted and tightened after CI reported `1 issue(s) found` on a healthy
 * plugin-only install (v3.70.0 Release run 32068227636). The legacy clause was
 * `/claude-mem.*worker/`, which matches ANY command line where `claude-mem`
 * precedes `worker` — including vitest's own
 * `…/claude-mem-lite/node_modules/vitest/dist/workers/forks.js` whenever the repo
 * is checked out into a directory called `claude-mem-lite`, as GitHub Actions does.
 * doctor then counted an issue and exited 1 while every other check was green: the
 * exact class of false-red this release exists to remove, invisible locally only
 * because the dev checkout is not named after the package.
 *
 * The legacy worker lived under the pre-v2.20 DATA dir `~/.claude-mem/`, so anchor
 * on that dot-prefixed path segment. It cannot appear in a repo checkout path.
 *
 * @param {string} line One `pgrep -af` output line.
 * @param {string} currentVersion Running package version, '' when unreadable.
 * @returns {boolean}
 */
export function isStaleMemProcess(line, currentVersion) {
  if (!line) return false;
  const cmd = (line.match(/^\s*\d+\s+(.*)$/)?.[1] ?? line).trim();
  if (!cmd) return false;
  const tokens = cmd.split(/\s+/);
  const exe = tokens[0] || '';

  // A shell or wrapper that merely MENTIONS these names in its arguments is not one
  // of our processes. Searching the whole line as free text bit twice within one
  // release: first vitest workers under a checkout named `claude-mem-lite`, then the
  // `git commit -F -` publishing THIS fix, whose message text contains the word
  // "chroma". Anything that takes a program as an argument can quote us.
  if (
    /(^|\/)(ba|z|k|da|c|t)?sh$/.test(exe) ||
    /(^|\/)(env|xargs|timeout|nohup|sudo|git|grep|rg|less|vi|vim|nano|code)$/.test(exe)
  ) {
    return false;
  }

  // Legacy chroma server: the EXECUTABLE, not a substring of some argument.
  if (/(^|\/)chroma$/.test(exe)) return true;
  // Legacy worker: a script path under the pre-v2.20 DATA dir. Dot-prefixed, so a
  // repo checkout called `claude-mem-lite` cannot produce it.
  if (tokens.some((t) => /\.claude-mem\/[^/]*worker[^/]*$/.test(t))) return true;

  // A plugin-cache launcher/server whose version segment is not the running one.
  // Anchored at end-of-token so it is a script being executed, not prose.
  const script = tokens.find((t) => /claude-mem-lite\/\d+\.\d+\.\d+\/(scripts\/launch|server)\.mjs$/.test(t));
  if (!script || !currentVersion) return false;
  return script.match(/claude-mem-lite\/(\d+\.\d+\.\d+)\//)[1] !== currentVersion;
}

function bindingHostDir() {
  return existsSync(join(PROJECT_DIR, 'node_modules', 'better-sqlite3')) ? PROJECT_DIR : INSTALL_DIR;
}

// Local, network-free repair for an unusable native DB binding — the Node-upgrade
// fault (ABI 127 → 137) that `repair` is the wrong size for: repair re-downloads
// and signature-verifies a whole GitHub release and fails closed offline, while
// this recompiles one module in place. Named in the hook hint, run unattended by
// scripts/hook-launcher.mjs at session-start, and usable by hand.
//
// Takes the same install.lock as the install write phase and launch.mjs's rebuild:
// two concurrent rebuilds can clobber the .node mid-compile. A live peer → report
// and exit 0 (it is doing this very work), never race it.
async function rebuildBinding() {
  const release = acquireLock(join(MEM_DATA_DIR, 'runtime', 'install.lock')); // runtime-dir:stays-put — install lock serialises real installers
  if (!release) {
    // NOT exit 0: skipping is not healing. Callers key their state on the exit
    // code — a false success would let the launcher drop its cooldown and the
    // CLI re-exec into the same broken binding.
    console.error('[install] Another install/repair is in progress — it owns the rebuild; skipping.');
    process.exitCode = 1;
    return;
  }
  try {
    // Every code home on this machine, not just the one this file sits in.
    // Pre-fix this rebuilt bindingHostDir() alone and reported `✓ ... verified`
    // — so a user whose ~/.claude-mem-lite tree was stale (hooks silently dead,
    // MCP server FATAL'ing) ran the documented repair, watched it succeed, and
    // still had no memory. Falling back to INSTALL_DIR keeps a source-only
    // layout with no deps of its own repairable.
    const shape = detectInstallShape({ home: homedir(), projectDir: PROJECT_DIR, installDir: INSTALL_DIR });
    const targets =
      shape.runtimeRoots.length > 0 ? shape.runtimeRoots : [{ label: 'install dir', root: bindingHostDir() }];

    let failed = 0;
    for (const { label, root } of targets) {
      const verify = await ensureBetterSqlite3Working(root);
      if (verify.ok) {
        ok(`better-sqlite3 binding ${verify.action} for Node ${process.version} — ${label} (${root})`);
      } else {
        fail(`better-sqlite3 binding still unusable in ${label}: ${verify.error}`);
        log(`Try manually: cd ${root} && ${NATIVE_BINDING_REBUILD_CMD}`);
        failed++;
      }
    }
    if (failed > 0) {
      process.exitCode = 1;
    } else {
      // Every tree is loadable → drop the marker so session-start stops retrying.
      clearNativeBindingBreakage(MEM_RUNTIME_DIR);
    }
  } finally {
    release();
  }
}

// Cross-process gate around the install write phase. repair() is intentionally
// NOT locked here: it spawns `install.mjs install` as a child, which takes this
// lock — locking the parent too would deadlock. A live peer (another session's
// install/self-heal) holds it → skip rather than race into a torn install. Lock
// path is shared with hook-update.installExtractedRelease (both env-aware).
async function runLockedInstall() {
  const release = acquireLock(join(MEM_DATA_DIR, 'runtime', 'install.lock')); // runtime-dir:stays-put — install lock serialises real installers
  if (!release) {
    console.log('[install] Another install/repair is in progress — skipping to avoid a torn write.');
    return;
  }
  try {
    await install();
  } finally {
    release();
  }
}

export async function main(argv = process.argv.slice(2)) {
  cmd = argv[0];
  flags = new Set(argv.slice(1));

  switch (cmd) {
    case 'install':
      await runLockedInstall();
      break;
    case 'uninstall':
      await uninstall();
      break;
    case 'status':
      await status();
      break;
    case 'doctor':
      await doctor();
      break;
    case 'cleanup-hooks':
      await cleanupHooks();
      break;
    case 'cleanup':
      cleanup();
      break;
    case 'self-update':
    case 'update':
      await manualUpdate();
      break;
    case 'repair':
      await repair();
      break;
    case 'rebuild-binding':
      await rebuildBinding();
      break;
    case 'release':
      syncVersions();
      if (!flags.has('--no-lock')) regenerateLockfile();
      break;
    default:
      if (IS_NPX) {
        // npx claude-mem-lite (no args) → auto install
        await runLockedInstall();
      } else {
        // Name the unknown token before the usage block. Pre-fix `install frobnicate`
        // dumped usage silently, which read like the user had typed nothing — they had
        // no idea their command was rejected.
        if (cmd) {
          console.error(`[install] Unknown command: "${cmd}"`);
          process.exitCode = 1;
        }
        console.log(`
claude-mem-lite — Lightweight memory system for Claude Code

Usage:
  node install.mjs install            Install (copy files to ~/.claude-mem-lite/)
  node install.mjs install --dev      Install dev mode (symlinks to dev dir)
  node install.mjs uninstall          Remove (keep data)
  node install.mjs uninstall --purge  Remove and delete all data
  node install.mjs status             Show current status (use --json for structured output)
  node install.mjs doctor             Diagnose issues (use --json for structured output)
  node install.mjs cleanup            Remove stale temp/staging files (use --dry-run to preview)
  node install.mjs cleanup-hooks      Remove only claude-mem-lite hooks from settings.json
  node install.mjs self-update         Check for and install updates
  node install.mjs repair             Recover a broken install: download latest tarball, re-run install
  node install.mjs rebuild-binding    Recompile better-sqlite3 for the running Node (fixes "NODE_MODULE_VERSION" after a Node upgrade)
  node install.mjs release            Sync versions (plugin/marketplace/CLAUDE.md) + regen lockfile via npm@10.9.2 (use --no-lock to skip lock regen)

  npx claude-mem-lite                 Install via npx (one-liner)
`);
      }
  }
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) await main();
