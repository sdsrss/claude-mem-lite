#!/usr/bin/env bash
#
# claude-mem-lite SessionStart pre-hook
# Data directory setup, migrations, and dependency resolution
#

set -euo pipefail

if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ROOT="$(dirname "$SCRIPT_DIR")"
else
  ROOT="$CLAUDE_PLUGIN_ROOT"
fi

# The same three locations lib/data-paths.mjs defines, under the same names. This script
# carried ONE variable for all three, and under CLAUDE_MEM_DIR that variable is the CODE
# dir — so every question about the DATABASE was asked of a directory holding none. This
# repo has now had that confusion three times (v6.3.0, the same fix reintroduced with the
# halves swapped, and here), which is why the names are spelled out rather than inferred.
#
#   CODE_DIR    — ALWAYS homedir. settings.json and the MCP registration bake absolute
#                 paths to server.mjs / hook.mjs under it, so it must not follow the
#                 relocation env var. Owns node_modules and the run-once install markers.
#   DB_DIR      — follows CLAUDE_MEM_DIR. Owns claude-mem-lite.db and its sidecars.
#   RUNTIME_DIR — follows CLAUDE_MEM_RUNTIME_DIR, else DB_DIR/runtime. Owns state a hook
#                 writes and another component reads back (see .deps-broken below).
#
# ASK the shared resolver rather than re-deriving its rules (absolute-only, "undefined" /
# "null" rejected) in a second language. lib/resolve-data-dir.mjs is a leaf module — node:
# builtins only — so it still loads with node_modules missing, which is the state the
# .deps-broken flag exists to describe. Gated on an override actually being set: with
# neither var the resolver returns exactly these defaults, and SessionStart should not pay a
# node spawn to be told that. A resolver that is missing (truncated tree) or that throws
# (invalid override) leaves the defaults in place; the Node side rejects a bad value loudly
# enough on its own, and aborting here would fail the user's session start.
CODE_DIR="$HOME/.claude-mem-lite"
DB_DIR="$CODE_DIR"
# Claude Code's config home, as lib/data-paths.mjs claudeConfigDir resolves it: an absolute
# CLAUDE_CONFIG_DIR, else ~/.claude (a relative value is ignored). The plugin cache, settings.json
# and .claude.json all live there; with the variable set, ~/.claude is another profile's.
# The defaults are spelled once: the default arm below and the marker keys after it both read them.
CC_DEFAULT_CONFIG_DIR="$HOME/.claude"
CC_DEFAULT_STATE_FILE="$HOME/.claude.json"
case "${CLAUDE_CONFIG_DIR:-}" in
  /* | [A-Za-z]:[\\/]*)
    CC_CONFIG_DIR="$CLAUDE_CONFIG_DIR"
    CC_STATE_FILE="$CLAUDE_CONFIG_DIR/.claude.json"
    ;;
  *)
    CC_CONFIG_DIR="$CC_DEFAULT_CONFIG_DIR"
    CC_STATE_FILE="$CC_DEFAULT_STATE_FILE"
    ;;
esac
# Steps 7 and 9 each settle a question about one file (.claude.json, settings.json) with a
# one-shot marker in this data dir, which every CLAUDE_CONFIG_DIR profile shares, so the first
# profile to start settled it for all of them (D#270). Key each marker by the file it gates. The
# default files keep the bare names every existing install already has: renaming one re-runs it.
# Not "is this ~/.claude": CLAUDE_CONFIG_DIR=~/.claude still moves .claude.json into ~/.claude.
marker_suffix() {
  [[ "$1" == "$2" ]] || printf -- '-%s' "$(printf '%s' "$1" | cksum | cut -d' ' -f1)"
}
RUNTIME_DIR="$CODE_DIR/runtime"
if [[ -n "${CLAUDE_MEM_DIR:-}" || -n "${CLAUDE_MEM_RUNTIME_DIR:-}" ]] && [[ -f "$ROOT/lib/resolve-data-dir.mjs" ]]; then
  # shellcheck disable=SC2016  # node script single-quoted on purpose; path passed via env, not shell expansion
  _resolved="$(RESOLVER_MOD="$ROOT/lib/resolve-data-dir.mjs" node -e '
    const { pathToFileURL } = require("node:url");
    import(pathToFileURL(process.env.RESOLVER_MOD).href)
      .then((m) => {
        const db = m.resolveDataDir(process.env.CLAUDE_MEM_DIR);
        process.stdout.write(`${db}\n${m.resolveRuntimeDir(db)}\n`);
      })
      .catch(() => process.exit(1));
  ' 2>/dev/null)" || _resolved=""
  _db="$(printf '%s\n' "$_resolved" | sed -n 1p)"
  _rt="$(printf '%s\n' "$_resolved" | sed -n 2p)"
  # Both or neither: a half-applied override is the split this whole block exists to close.
  if [[ -n "$_db" && -n "$_rt" ]]; then
    DB_DIR="$_db"
    RUNTIME_DIR="$_rt"
  fi
  unset _resolved _db _rt
fi

OLD_UNHIDDEN_DIR="$HOME/claude-mem-lite"

# Colors
if [[ -t 2 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; RED='\033[0;31m'; NC='\033[0m'
else
  GREEN='' YELLOW='' BLUE='' RED='' NC=''
fi

log_ok()   { echo -e "${GREEN}✓${NC} $*" >&2; }
log_info() { echo -e "${BLUE}ℹ${NC} $*" >&2; }
log_warn() { echo -e "${YELLOW}⚠${NC} $*" >&2; }
# shellcheck disable=SC2317,SC2329  # kept for API symmetry with log_ok/log_info/log_warn
# Both codes on purpose: shellcheck 0.10.0 split "this function is never invoked" out of
# SC2317 (unreachable command) into its own SC2329. The lone SC2317 stopped matching, so
# 0.11.0 flags this line and `npx eslint`-style local runs exit 1 while CI stays green —
# the ubuntu-latest runner still ships a pre-0.10 shellcheck. That is a version skew, not
# a disagreement about the code: this job gates on exit 0, so it turns red on its own the
# day GitHub bumps the runner image. Keep SC2317 for anyone on an older shellcheck.
log_err()  { echo -e "${RED}✗${NC} $*" >&2; }

# 1. Migrate unhidden dir (~/claude-mem-lite/ → ~/.claude-mem-lite/)
#    CODE_DIR, not DB_DIR, and deliberately: the pre-v0.5 unhidden directory held the
#    INSTALL — server.mjs, hook.mjs, package.json — and CODE_DIR is the one location that
#    must never follow the relocation env var. Moving it into a relocated DB_DIR would
#    strand every absolute path settings.json and the MCP registration baked.
if [[ -d "$OLD_UNHIDDEN_DIR" && ! -d "$CODE_DIR" ]]; then
  mv "$OLD_UNHIDDEN_DIR" "$CODE_DIR"
  log_ok "Migrated ~/claude-mem-lite/ → ~/.claude-mem-lite/"
fi

# 2. Ensure both locations exist (runtime created after migration check)
mkdir -p "$CODE_DIR"
mkdir -p "$DB_DIR"
if [[ "$DB_DIR" == "$CODE_DIR" ]]; then
  log_ok "Data directory: $DB_DIR"
else
  log_ok "Data directory: $DB_DIR (code: $CODE_DIR)"
fi

# 3. Legacy ~/.claude-mem/ DB is schema-v16 (no memory_session_id) with no migration bridge to
#    the current schema — activating it FATALs on first launch ("no such column: memory_session_id")
#    and the "! -f claude-mem-lite.db" guard would re-copy it every time the user deletes the broken
#    DB (recovery loop). Mirror install.mjs migrateLegacyClaudeMemData: back it up (don't activate)
#    and let a fresh DB be created. Source ~/.claude-mem/ is left intact.
#
#    DB_DIR, because that guard is the whole convergence argument: it closes when the product
#    creates claude-mem-lite.db, and the product creates it in DB_DIR. Asked of CODE_DIR under
#    a relocation it never closed — nothing ever writes a database THERE — so this block
#    copied the legacy database again on every single SessionStart, without bound. Measured
#    2026-09-14: control arm stable at 1 backup across three runs, relocated arm 1 → 3.
OLD_DIR="$HOME/.claude-mem"
if [[ -f "$OLD_DIR/claude-mem.db" && ! -f "$DB_DIR/claude-mem-lite.db" && ! -f "$DB_DIR/claude-mem.db" ]]; then
  BACKUP="$DB_DIR/claude-mem-lite.db.legacy-backup-$(date +%s)"
  if cp "$OLD_DIR/claude-mem.db" "$BACKUP" 2>/dev/null; then
    log_info "Legacy ~/.claude-mem/ DB is schema-incompatible; backed up to $(basename "$BACKUP") (a fresh DB will be created). Old ~/.claude-mem/ preserved."
  else
    log_warn "Legacy DB backup failed — a fresh database will be created"
  fi
fi

# 4. Rename claude-mem.db → claude-mem-lite.db in same directory (DB_DIR: a relocated user's
#    pre-rename database sits there, and asking CODE_DIR left it unrenamed and unopened).
if [[ -f "$DB_DIR/claude-mem.db" && ! -f "$DB_DIR/claude-mem-lite.db" ]]; then
  mv "$DB_DIR/claude-mem.db" "$DB_DIR/claude-mem-lite.db"
  mv "$DB_DIR/claude-mem.db-wal" "$DB_DIR/claude-mem-lite.db-wal" 2>/dev/null || true
  mv "$DB_DIR/claude-mem.db-shm" "$DB_DIR/claude-mem-lite.db-shm" 2>/dev/null || true
  log_ok "Database renamed: claude-mem.db → claude-mem-lite.db"
fi

# 5. Ensure runtime directories exist (after migration to not mask migration check).
#    Both: RUNTIME_DIR carries the cross-component flag below, while CODE_DIR/runtime keeps
#    the two run-once install markers at the bottom of this file.
mkdir -p "$RUNTIME_DIR"
mkdir -p "$CODE_DIR/runtime"

# 6. Ensure native dependencies available for hooks (ESM import needs node_modules in resolution chain)
#    Plugin cache doesn't include node_modules — symlink from data dir or npm install on first run
#
# Visibility contract: `npm install` failure here used to be a stderr-only log_warn,
# invisible to the Claude session unless the operator was watching the terminal.
# When it fails (no toolchain, blocked network, read-only FS) every hook silently
# degrades — pre-tool-recall, post-tool-use, session-start all import better-sqlite3
# and exit on the require() error. v2.79: write a JSON flag to runtime/.deps-broken
# and hook.mjs SessionStart surfaces it in the Claude context as a HIGH-VISIBILITY
# block; success branches remove the flag so a self-heal stays visible too.
#
# ...and that contract is a two-directory agreement, not a filename. hook.mjs renders the
# flag from `join(RUNTIME_DIR, '.deps-broken')`, where RUNTIME_DIR is
# `resolveRuntimeDir(resolveDataDir(CLAUDE_MEM_DIR))` (hook-shared.mjs). Hardcoding a
# homedir path here meant that under CLAUDE_MEM_DIR / CLAUDE_MEM_RUNTIME_DIR the writer and
# the reader named two different directories, so the one surface that says "your hooks are
# degraded" rendered nothing on exactly the installs that had relocated. Measured
# 2026-09-14: flag planted where this script wrote it → banner 0 times; planted where
# hook.mjs reads → 1. Same SPLIT shape lib/resolve-data-dir.mjs documents; it survived
# because tests/runtime-dir-single-home.test.mjs sweeps `walkShipped`, which is every
# shipped .mjs/.js — a bash hook is structurally outside that population. RUNTIME_DIR is
# resolved once at the top of this file.
#
# ONLY this marker follows the override. `.mcp-dedup-v2.78` and `.residue-warned-v2.55`
# below are one-shot state about a CONFIG HOME — a .claude.json edit and a settings.json
# warning, not state a hook hands to another component — so they stay under CODE_DIR, one per
# file they gate. Read lib/resolve-data-dir.mjs's MOVES/STAYS list before relocating either:
# moving a run-once marker re-runs what it gated.
DEPS_FLAG="$RUNTIME_DIR/.deps-broken"

mark_deps_broken() {
  local reason="$1"
  local repair="${2:-npm install --omit=dev}"
  # Embed reason + repair command so hook.mjs renders a complete error without
  # having to re-derive them. Delegate JSON serialization to node so embedded
  # quotes / shell metachars in $ROOT or $reason can't produce an invalid file
  # (bash `printf '"..%s.."'` cannot escape arbitrary strings safely; v2.79.1 fix).
  # shellcheck disable=SC2016  # node script single-quoted on purpose; vars passed via env (MARK_*), not shell expansion
  MARK_REASON="$reason" MARK_ROOT="$ROOT" MARK_FLAG="$DEPS_FLAG" MARK_REPAIR="$repair" node -e '
    const fs = require("fs");
    const reason = process.env.MARK_REASON || "unknown";
    const root = process.env.MARK_ROOT || "";
    const repair = process.env.MARK_REPAIR || "npm install --omit=dev";
    fs.writeFileSync(process.env.MARK_FLAG, JSON.stringify({
      ts: new Date().toISOString(),
      reason,
      root,
      repair: `cd ${JSON.stringify(root)} && ${repair}`,
    }) + "\n");
  ' 2>/dev/null || true
}

mark_deps_ok() {
  rm -f "$DEPS_FLAG" 2>/dev/null || true
}

if [[ ! -d "$ROOT/node_modules/better-sqlite3" ]]; then
  # Fast path: symlink from data dir (instant, no network needed)
  # CODE_DIR: node_modules belongs to the install, not to the data, and must not follow
  # CLAUDE_MEM_DIR — install.mjs writes it under the homedir install location.
  if [[ -d "$CODE_DIR/node_modules/better-sqlite3" ]]; then
    if ln -sfn "$CODE_DIR/node_modules" "$ROOT/node_modules" 2>/dev/null; then
      log_ok "Dependencies linked from $CODE_DIR"
    fi
  fi
  # Slow path: npm install (first-time only, ~10-20s for native addon)
  if [[ ! -d "$ROOT/node_modules/better-sqlite3" ]]; then
    log_info "Installing dependencies (first-time setup)..."
    if (cd "$ROOT" && npm install --omit=dev --no-audit --no-fund 2>&1) >&2; then
      log_ok "Dependencies installed"
    else
      log_warn "Dependency install failed — hooks may have limited functionality (flag: $DEPS_FLAG)"
      mark_deps_broken "npm install --omit=dev failed in plugin cache root"
    fi
  fi
fi

# 6b. Binding probe: node_modules/better-sqlite3 PRESENT is not node binding
#     WORKING. npm >= 12 blocks install/lifecycle scripts by default, so the
#     `npm install` above exits 0 with the native .node binding never compiled
#     (and a Node major upgrade strands a stale-ABI binding the same way) —
#     pre-v3.58 this branch called mark_deps_ok on directory presence alone,
#     leaving every hook dead with a false-green flag until the MCP server's
#     own probe ran. Probe via the shared fix point lib/binding-probe.mjs
#     (opens a :memory: DB; auto-rebuilds with --dangerously-allow-all-scripts,
#     plain-rebuild fallback for older npm). The ABI-keyed marker lives inside
#     node_modules/ — WITH the tree it certifies — so healthy sessions cost one
#     stat, a new plugin-cache version dir (fresh node_modules) re-probes, and
#     a Node upgrade (new ABI) re-probes. While broken, every SessionStart
#     retries the rebuild until it heals.
# Delegates to scripts/binding-probe-cli.mjs — a real module file, NOT an inline
# `node -e` string. That inline form SIGSEGV'd during exit after a verified-good
# rebuild (Node v24.18, ~50% of runs), so a successful heal returned 139 and this
# branch recorded .deps-broken over a healthy install; it also could not contain
# an apostrophe without truncating the shell command. See that file's header.
# Contract: exit 0 = binding usable now.
probe_binding() {
  # Absent on a truncated tree: without this guard node prints a full
  # MODULE_NOT_FOUND stack onto SessionStart stderr on every marker-miss.
  [[ -f "$ROOT/scripts/binding-probe-cli.mjs" ]] || return 1
  # stdout muted: this child runs `npm rebuild`, and SessionStart stdout is a
  # JSON envelope Claude Code parses. Nothing writes there today (verified) —
  # this keeps a future non-piped exec from being able to.
  PROBE_ROOT="$ROOT" node "$ROOT/scripts/binding-probe-cli.mjs" >/dev/null
}

# Ground truth about the binding, independent of how the healer above exited.
# Belt-and-braces: moving the probe out of the inline `node -e` string removed
# the observed SIGSEGV, but the healer's exit code is a PROXY for the question
# that actually matters, and a proxy can lie again (a future crash, a partial
# state, a kill at the hook cap). So ask the real question in a fresh process:
# can we open a DB right now? A false .deps-broken here is not cosmetic — it
# renders a "hooks degraded" banner into the user's session over a healthy
# install. Costs one ~50ms spawn, and only off the marker fast-path.
# shellcheck disable=SC2016  # node script single-quoted on purpose; ROOT passed via env, not shell expansion
binding_usable() {
  VERIFY_ROOT="$ROOT" node -e '
    const { createRequire } = require("node:module");
    const { join } = require("node:path");
    const D = createRequire(join(process.env.VERIFY_ROOT, "package.json"))("better-sqlite3");
    new D(":memory:").close();
  ' >/dev/null 2>&1
}

if [[ -d "$ROOT/node_modules/better-sqlite3" ]]; then
  NODE_ABI="$(node -p 'process.versions.modules' 2>/dev/null || echo 0)"
  BINDING_MARKER="$ROOT/node_modules/.mem-binding-ok-$NODE_ABI"
  if [[ -f "$BINDING_MARKER" ]]; then
    mark_deps_ok
  elif probe_binding || binding_usable; then
    rm -f "$ROOT/node_modules/.mem-binding-ok-"* 2>/dev/null || true
    touch "$BINDING_MARKER" 2>/dev/null || true
    mark_deps_ok
  else
    log_warn "better-sqlite3 native binding unusable — hooks degraded until repaired (flag: $DEPS_FLAG)"
    # Both commands, `&&` not `||`: `npm rebuild` exits 0 without compiling on
    # better-sqlite3 13 (no install script to run), so it never signals failure and
    # an `||` chain would never reach the source build. A20260906-R8-P1-1.
    #
    # …and the pair alone is still not enough. It heals a platform 13 ships no prebuild
    # for; it cannot heal a prebuild that is PRESENT and will not load, because 13 prefers
    # `prebuilds/<target>.node` over anything the source build produces. This string is what
    # the SessionStart dashboard prints as `Repair:`, so it leads with the CLI, which is the
    # only path that moves the dead prebuild aside first (lib/binding-probe.mjs). Mirrors
    # nativeBindingRepairHint(); this file may not import lib/, hence the duplication —
    # tests/audit-r8-binding-repair-hint.test.mjs pins the set of files allowed to do that.
    # mark_deps_broken already prefixes `cd <root> && `, so these are root-relative.
    NB_REPAIR="npm rebuild better-sqlite3 --dangerously-allow-all-scripts && npm run --prefix node_modules/better-sqlite3 build-release"
    if [[ -f "$ROOT/cli.mjs" ]]; then
      NB_REPAIR="node cli.mjs rebuild-binding   (or, without the CLI: $NB_REPAIR)"
    fi
    mark_deps_broken "better-sqlite3 binding probe/rebuild failed (npm >= 12 blocks compile scripts by default)" "$NB_REPAIR"
  fi
fi

# 7. MCP cleanup: one-shot purge of stale global MCP registrations.
#    - Pre-2.10: direct installs left a global "mem" MCP alongside plugin MCP.
#    - Pre-2.78: plugin and global registrations used the generic name "mem";
#      v2.78 renamed to "mem-lite" — any stale global "mem" must be purged so
#      Claude Code doesn't surface duplicate (old "mem" + new "mem-lite") tool
#      prefixes side-by-side.
#    Root .mcp.json in the installed plugin cache is required for Claude Code to
#    register plugin MCP; only stale global/marketplace copies are removed.
#    v2.79.1: marker file now actually gates entry (was touched but never read
#    pre-v2.79.1 — extra node spawn + JSON parse on every SessionStart for a
#    near-always no-op). Bump MCP_MIGRATION name to re-run cleanup in future
#    versions; same shape as the .deps-broken self-heal pattern.
# CODE_DIR/runtime, not RUNTIME_DIR: this marker gates a one-shot edit of the config home's
# .claude.json, which is not per-data-dir state. Relocating it would re-run that edit. One per
# .claude.json (marker_suffix above).
MCP_MIGRATION="$CODE_DIR/runtime/.mcp-dedup-v2.78$(marker_suffix "$CC_STATE_FILE" "$CC_DEFAULT_STATE_FILE")"
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && ! -f "$MCP_MIGRATION" ]]; then
  # shellcheck disable=SC2016  # node script single-quoted on purpose; CLAUDE_JSON passed via env, not shell expansion
  CLAUDE_JSON="$CC_STATE_FILE" node -e '
    const fs = require("fs");
    let changed = false;
    // Remove stale global MCP registrations (plugin .mcp.json handles it).
    // "mem-lite" (current) always; "mem" (legacy, pre-v2.78) only when it runs our
    // server — the name is generic, and a user`s own "mem" server was deleted here.
    // Same pattern as install.mjs OUR_MCP_SERVER_RE (tests/mcp-legacy-name-ownership).
    const OURS = /claude-mem-lite[\w.-]*[\\/]+(?:scripts[\\/]+launch|server)\.mjs/;
    const ours = (k, e) =>
      k === "mem-lite" || (!!e && OURS.test([e.command, ...(Array.isArray(e.args) ? e.args : [])].join(" ")));
    try {
      const p = process.env.CLAUDE_JSON;
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const k of ["mem", "mem-lite"]) {
        if (d.mcpServers?.[k] && ours(k, d.mcpServers[k])) {
          delete d.mcpServers[k];
          process.stderr.write(`✓ Removed stale global MCP "${k}" (plugin handles it)\n`);
          changed = true;
        }
      }
      if (changed) fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
    } catch {}
    // NOTE: Do NOT touch marketplace .mcp.json — Claude Code copies it from
    // marketplace → plugin cache on updates. Clearing it causes the cache
    // .mcp.json to lose the MCP server definition, breaking plugin MCP.
    if (!changed) process.stderr.write("✓ MCP migration: already clean\n");
  ' || true
  touch "$MCP_MIGRATION"
fi

# 8. Prune old plugin cache versions (keep latest 3)
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  CACHE_DIR="$CC_CONFIG_DIR/plugins/cache/sdsrss/claude-mem-lite"
  if [[ -d "$CACHE_DIR" ]]; then
    # List version dirs sorted by semver descending, skip top 3
    # Use glob + while-read for bash 3.2 (macOS) compatibility (no mapfile, no `ls | grep`)
    OLD_VERS=()
    shopt -s nullglob
    _all_dirs=("$CACHE_DIR"/[0-9]*)
    shopt -u nullglob
    while IFS= read -r ver; do
      [[ -n "$ver" ]] && OLD_VERS+=("$ver")
    done < <(for _d in "${_all_dirs[@]}"; do [[ -d "$_d" ]] && echo "${_d##*/}"; done | sort -t. -k1,1nr -k2,2nr -k3,3nr | tail -n +4)
    unset _all_dirs _d
    if [[ ${#OLD_VERS[@]} -gt 0 ]]; then
      PRUNED=0
      for ver in "${OLD_VERS[@]}"; do
        # A20260905-R5-Q1: "not in the newest 3" is not the same question as "not in use".
        # CLAUDE_PLUGIN_ROOT is the version dir this session is RUNNING from, and after a
        # marketplace rollback (a bad release withdrawn while >=3 newer dirs sit in the
        # cache) it falls outside the newest 3 — so this loop deleted the tree every hook
        # and the MCP server import from, mid-session. -ef compares device+inode, so it is
        # not fooled by a trailing slash, a `..` segment or a symlinked cache dir.
        # R10 P2-9 checked this and it needs no change: the whole step is gated on
        # CLAUDE_PLUGIN_ROOT being set (see the `if` above), so unlike prunePluginCache()
        # — which also runs from a terminal, where Claude Code does not set it — this
        # comparison is never made against an empty value. Do not "align" it by dropping
        # that outer gate.
        # hook-update.mjs prunePluginCache() carries the same guard; the two prune the same
        # directory and must agree.
        if [[ "$CACHE_DIR/$ver" -ef "$CLAUDE_PLUGIN_ROOT" ]]; then
          continue
        fi
        rm -rf "${CACHE_DIR:?}/$ver" 2>/dev/null || true
        PRUNED=$((PRUNED + 1))
      done
      if [[ $PRUNED -gt 0 ]]; then
        log_ok "Plugin cache pruned: removed $PRUNED old version(s)"
      fi
    fi
  fi
fi

# 9. Residue detection (plugin mode only): warn once if legacy direct-install
#    hooks remain in ~/.claude/settings.json. A user who installed via global
#    `claude-mem-lite install` and later switched to the marketplace plugin
#    will run every hook twice (direct settings.json hooks AND plugin hooks)
#    until they run `claude-mem-lite uninstall` to clear the settings.json
#    entries. /plugin uninstall does not touch settings.json.
# CODE_DIR/runtime, same reason: the residue it warns about is stale hook entries in the config
# home's settings.json — one warning per config home, regardless of where the data lives.
RESIDUE_MARKER="$CODE_DIR/runtime/.residue-warned-v2.55$(marker_suffix "$CC_CONFIG_DIR" "$CC_DEFAULT_CONFIG_DIR")"
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && ! -f "$RESIDUE_MARKER" ]]; then
  SETTINGS="$CC_CONFIG_DIR/settings.json"
  if [[ -f "$SETTINGS" ]]; then
    SETTINGS_PATH="$SETTINGS" node -e '
      const fs = require("fs");
      try {
        const raw = fs.readFileSync(process.env.SETTINGS_PATH, "utf8");
        const data = JSON.parse(raw);
        const hooks = data.hooks || {};
        const events = Object.keys(hooks);
        const found = [];
        for (const ev of events) {
          const list = Array.isArray(hooks[ev]) ? hooks[ev] : [];
          for (const entry of list) {
            const inner = Array.isArray(entry?.hooks) ? entry.hooks : [];
            for (const h of inner) {
              const cmd = String(h?.command || "");
              if (cmd.includes(".claude-mem-lite/") || cmd.includes("claude-mem-lite/scripts") || cmd.includes("claude-mem-lite/hook.mjs")) {
                found.push(ev);
                break;
              }
            }
          }
        }
        if (found.length) {
          process.stderr.write("\n");
          process.stderr.write("\x1b[33m⚠\x1b[0m Legacy direct-install hooks detected in " + process.env.SETTINGS_PATH + "\n");
          process.stderr.write("  Events with stale entries: " + [...new Set(found)].join(", ") + "\n");
          process.stderr.write("  These will fire alongside plugin hooks (each tool call runs twice).\n");
          process.stderr.write("  Fix: run \x1b[1mclaude-mem-lite uninstall\x1b[0m to clear settings.json,\n");
          process.stderr.write("       then keep using the plugin install. (One-time warning.)\n\n");
          process.exit(2);
        }
      } catch {}
    ' || true
  fi
  # Mark the warning as shown regardless of result — silence is fine if no
  # residue, and the warning above is one-shot per data-dir.
  touch "$RESIDUE_MARKER"
fi

log_ok "claude-mem-lite ready"
exit 0
