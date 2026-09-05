// lib/install-shape.mjs — which code homes does this machine actually RUN?
//
// claude-mem-lite can occupy three code homes at once and they are not
// interchangeable:
//
//   plugin cache   ~/.claude/plugins/cache/<mp>/claude-mem-lite/<ver>/
//                  runs the manifest hooks + the plugin MCP launcher
//   managed dir    ~/.claude-mem-lite/
//                  runs the settings.json hooks + the registered MCP server
//   npm-global     <prefix>/lib/node_modules/claude-mem-lite/
//                  runs the `claude-mem-lite` shell command
//
// Each carries its OWN node_modules, so each has its own native binding that
// can go stale independently. install.mjs used to answer every "is the binding
// OK / are the files there" question about exactly one of them — the directory
// install.mjs itself sits in. That is the right question for install.mjs's own
// imports and the wrong one for a health check, and it failed in both
// directions in a sandbox run of the documented install flows (2026-08-17):
//
//   • plugin-only user, healthy system → `✗ server.mjs: missing`,
//     `✗ hook.mjs: missing`, `⚠ Managed files: 121 missing`, exit 1. Those
//     files only ever exist in the managed layout, which a plugin install does
//     not create.
//   • npm-global CLI + a stale ~/.claude-mem-lite binding → `✓ better-sqlite3:
//     verified`, exit 0, while the registered MCP server FATAL'd on startup
//     ("wrong ELF class") and every hook degraded to a silent exit 0. The
//     documented repair, `rebuild-binding`, then rebuilt the healthy tree and
//     reported success. That is the v3.60 field failure (memory dead for four
//     days) with the whole diagnose→repair chain reporting green.
//
// So: enumerate the roots, probe each, and name the one that is broken.

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  probeBindingInFreshProcess,
  NATIVE_BINDING_REBUILD_CMD,
  flattenBindingError,
} from './binding-probe.mjs';

// Module-private: nothing outside needs these, and a new unused export is a
// review signal against the knip baseline recorded in CLAUDE.md.
const DEFAULT_MARKETPLACE = 'sdsrss';
const DEFAULT_PLUGIN = 'claude-mem-lite';

// Both must be present before ~/.claude-mem-lite counts as a CODE home. Either
// one alone is a torn install, and `runtime/` + the DB alone is the data-only
// dir every install shape creates — including plugin-only, which is exactly the
// case that must NOT be graded against the managed layout.
const MANAGED_ENTRY_POINTS = ['server.mjs', 'hook.mjs'];

function cacheBaseFor({ home = homedir(), marketplace = DEFAULT_MARKETPLACE, plugin = DEFAULT_PLUGIN } = {}) {
  return join(home, '.claude', 'plugins', 'cache', marketplace, plugin);
}

// Leading integer per dot-segment, so a prerelease dir (`3.70.0-rc1`) orders by its
// numeric part instead of collapsing to "equal": `Number('0-rc1')` is NaN, and a NaN
// difference is falsy, which silently made the comparator return 0 and left ordering
// up to readdir insertion order (pre-tag review NOTE N5). `/^\d+\./` admits such dirs,
// so this is reachable the moment a prerelease is ever cached.
function semverDesc(a, b) {
  const parts = (v) =>
    v.split('.').map((s) => {
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * True when `installDir` holds a managed CODE install, not merely the data dir.
 *
 * @param {string} installDir
 * @returns {boolean}
 */
export function hasManagedCodeInstall(installDir) {
  if (!installDir || !existsSync(installDir)) return false;
  return MANAGED_ENTRY_POINTS.every((f) => existsSync(join(installDir, f)));
}

/**
 * Plugin-cache version dirs that carry runnable code, newest first.
 *
 * Gated on scripts/launch.mjs rather than mere directory presence: a
 * half-pruned or half-written version dir is not something the runtime can
 * start, and listing it would invent roots to probe.
 *
 * @param {{home?: string, marketplace?: string, plugin?: string}} [opts]
 * @returns {Array<{version: string, root: string}>}
 */
export function listPluginCacheVersions(opts = {}) {
  const base = cacheBaseFor(opts);
  if (!existsSync(base)) return [];
  const out = [];
  let entries;
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  for (const version of entries) {
    if (!/^\d+\./.test(version)) continue;
    const root = join(base, version);
    if (!existsSync(join(root, 'scripts', 'launch.mjs'))) continue;
    out.push({ version, root });
  }
  return out.sort((a, b) => semverDesc(a.version, b.version));
}

/**
 * Every distinct code home on this machine, plus the subset that owns a native
 * binding worth probing.
 *
 * `runtimeRoots` deduplicates on the REALPATH OF THE BINDING, not of the root:
 * scripts/setup.sh's fast path symlinks a plugin cache's node_modules at the
 * managed dir's, so two distinct roots routinely share one tree. Probing it
 * twice would double every failure message for a single fault.
 *
 * @param {{home?: string, projectDir?: string, installDir?: string, marketplace?: string, plugin?: string, pluginRoot?: string}} opts
 * @returns {{managed: boolean, pluginVersions: Array<{version: string, root: string}>, activePluginVersion: {version: string, root: string}|null, runtimeRoots: Array<{label: string, root: string, ownDeps: boolean}>}}
 */
export function detectInstallShape({
  home = homedir(),
  projectDir,
  installDir,
  marketplace,
  plugin,
  pluginRoot = process.env.CLAUDE_PLUGIN_ROOT,
} = {}) {
  const managed = hasManagedCodeInstall(installDir);
  const pluginVersions = listPluginCacheVersions({ home, marketplace, plugin });

  // Only ONE cache version is live. Claude Code never prunes old version dirs and
  // each keeps its own real node_modules, so probing all of them meant a Node major
  // upgrade left every never-started version permanently stale: doctor red forever
  // about trees nothing loads, and rebuild-binding — which clears the breakage marker
  // only when EVERY target succeeds — could never clear it, reproducing the
  // "launcher re-spawns npm every 6h forever" state from 2026-08-13. Prefer the
  // version this process was actually launched from; else the newest.
  const activePluginVersion =
    pluginVersions.find((v) => pluginRoot && resolvesSame(v.root, pluginRoot)) || pluginVersions[0] || null;

  const runtimeRoots = [];
  const byKey = new Map();
  const add = (label, root, { certified = false } = {}) => {
    if (!root) return;
    const bs3 = join(root, 'node_modules', 'better-sqlite3');
    const ownDeps = existsSync(bs3);
    // A dir that merely lacks deps is not a runtime root — but one this function
    // just CERTIFIED as a code home is, because that is where hooks and the MCP
    // server load from. Dropping it turned a pre-v3.70 exit 1 into exit 0.
    //
    // It is added as a probe TARGET, not pre-judged broken. v3.70.0 pre-judged it,
    // which over-corrected into a false red: Node resolves a specifier up the
    // directory tree, so a code home nested under an ancestor that owns a working
    // better-sqlite3 loads perfectly well. Measured on that build — ground-truth
    // probe {ok:true} against a verdict of "absent, every hook throws". Owning the
    // tree is not the question; being able to LOAD is, and only a probe answers it.
    if (!ownDeps && !(certified && existsSync(root))) return;

    // Dedup on the binding's realpath when there is one (scripts/setup.sh symlinks a
    // plugin cache's node_modules at the managed dir's, so two homes routinely share
    // one tree and one probe answers for both). With no own tree there is no binding
    // path to key on, so key on the root itself.
    let key = root;
    if (ownDeps) {
      key = bs3;
      try {
        key = realpathSync(bs3);
      } catch {
        /* unresolvable → key on the literal path */
      }
    } else {
      try {
        key = realpathSync(root);
      } catch {
        /* ditto */
      }
    }
    const existing = byKey.get(key);
    if (existing) {
      // The label has to name both homes — otherwise a plugin user reading
      // "managed install is broken" has no way to know their plugin shares that tree.
      existing.label += `, ${label}`;
      return;
    }
    const entry = { label, root, ownDeps };
    byKey.set(key, entry);
    runtimeRoots.push(entry);
  };

  // Order is significance order for the report: the tree the user's own command
  // runs from, then the one hooks/MCP run from, then the live plugin version.
  add('running CLI', projectDir);
  if (managed) add('managed install (~/.claude-mem-lite)', installDir, { certified: true });
  if (activePluginVersion) {
    add(`plugin cache v${activePluginVersion.version}`, activePluginVersion.root, { certified: true });
  }

  return { managed, pluginVersions, activePluginVersion, runtimeRoots };
}

/** True when two paths denote the same directory, tolerating symlinks. */
function resolvesSame(a, b) {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Probe each root's native binding out of process, carrying a per-root repair
 * command so a failure cannot send the user to rebuild a healthy tree.
 *
 * @param {Array<{label: string, root: string}>} roots
 * @param {{probe?: (root: string) => {ok: boolean, error?: string}}} [deps]
 * @returns {Array<{label: string, root: string, ok: boolean, error?: string, repair?: string}>}
 */
export function probeRuntimeRoots(roots, deps = {}) {
  const probe = deps.probe || ((root) => probeBindingInFreshProcess(root));
  return roots.map(({ label, root, ownDeps = true }) => {
    // EVERY root is probed, including one with no tree of its own: the probe uses
    // Node's real resolution chain, so it is the only thing that knows whether an
    // ancestor node_modules is carrying this install. Pre-judging an unowned tree
    // broken is what made v3.70.0 report "absent — every hook throws" about a root
    // that loaded fine.
    const r = probe(root);
    if (r.ok) return { label, root, ok: true };
    // The repair depends on WHICH failure it is. `npm rebuild` on a package that is
    // not installed exits 0 and heals nothing, so an unowned tree that also cannot
    // resolve from an ancestor needs an install; a present-but-unloadable tree needs
    // the rebuild.
    // NOT `.split('\n')[0]`: Node puts the filename on line 0 and the
    // `NODE_MODULE_VERSION 127 … requires 137` on lines 2-3, so first-line truncation
    // showed a bare path for the one fault family this check exists for.
    const error = flattenBindingError(r.error);
    return ownDeps
      ? { label, root, ok: false, error, repair: `cd ${root} && ${NATIVE_BINDING_REBUILD_CMD}` }
      : {
          label,
          root,
          ok: false,
          // Say only what is known. The probe may have reached an ANCESTOR
          // node_modules and failed there — an earlier draft of this line asserted
          // "none resolvable from a parent directory" and was caught printing that
          // next to a probe error naming the parent tree it had just loaded from.
          error: `${error} — and this install owns no node_modules/better-sqlite3, so there is nothing here to rebuild`,
          repair: `cd ${root} && npm install --omit=dev`,
        };
  });
}
