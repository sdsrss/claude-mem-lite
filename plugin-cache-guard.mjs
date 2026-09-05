// Plugin cache hook sentinel.
//
// Claude Code runtime reads plugin hooks from
// ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/hooks/hooks.json
// NOT from the marketplace source (~/.claude/plugins/marketplaces/<mp>/hooks/hooks.json).
//
// When install.mjs writes mem hooks directly into ~/.claude/settings.json, any stale
// cache hooks.json (e.g. left behind by a previous marketplace install or an auto-update
// that re-populates cache) causes double hook registration: one fires from settings.json,
// another from cache. This module detects and heals that state.
//
// Safe-by-default: clearPluginCacheHooks is only called when hasInstallManagedHooks()
// returns true, so plugin-only users (cache is the sole registration) are not affected.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const DEFAULT_MARKETPLACE = 'sdsrss';
export const DEFAULT_PLUGIN = 'claude-mem-lite';

function cacheBaseFor(opts) {
  const home = opts?.home || homedir();
  const mp = opts?.marketplace || DEFAULT_MARKETPLACE;
  const plugin = opts?.plugin || DEFAULT_PLUGIN;
  return join(home, '.claude', 'plugins', 'cache', mp, plugin);
}

export function scanPluginCacheHookPollution(opts) {
  const base = cacheBaseFor(opts);
  if (!existsSync(base)) return [];
  const polluted = [];
  for (const ver of readdirSync(base)) {
    const p = join(base, ver, 'hooks', 'hooks.json');
    if (!existsSync(p)) continue;
    try {
      const h = JSON.parse(readFileSync(p, 'utf8'));
      if (h.hooks && Object.keys(h.hooks).length > 0) polluted.push(ver);
    } catch { /* ignore unreadable cache entries */ }
  }
  return polluted.sort();
}

export function clearPluginCacheHooks(opts) {
  const base = cacheBaseFor(opts);
  if (!existsSync(base)) return [];
  const plugin = opts?.plugin || DEFAULT_PLUGIN;
  const reason = opts?.reason || 'Auto-cleared to prevent duplicate hook registration';
  const cleared = [];
  for (const ver of readdirSync(base)) {
    const p = join(base, ver, 'hooks', 'hooks.json');
    if (!existsSync(p)) continue;
    try {
      const h = JSON.parse(readFileSync(p, 'utf8'));
      if (!h.hooks || Object.keys(h.hooks).length === 0) continue;
      writeFileSync(p, JSON.stringify({
        description: h.description || `${plugin} hooks`,
        _note: `${reason} (cache ver: ${ver})`,
        hooks: {},
      }, null, 2) + '\n');
      cleared.push(ver);
    } catch { /* ignore unwritable cache entries */ }
  }
  return cleared.sort();
}

/**
 * What a cache version's hooks/hooks.json ACTUALLY registers.
 *
 * The counterpart to hasInstallManagedHooks: on a plugin-only install this file
 * is the sole hook registration, so an EMPTY one means every hook is dead. Both
 * status and doctor used to credit "the plugin manifest serves the hooks" from
 * `settings.json holds none` + `an active plugin version exists` alone, never
 * opening the manifest — and an emptied manifest looks exactly like a healthy
 * npm-shape install from those two facts. That false green is what let a cleared
 * cache run for a full session reporting all-green with zero hooks firing.
 *
 * @param {string} root Cache version dir (shape.activePluginVersion.root)
 * @returns {{ok: boolean, events: string[], reason: string|null}}
 *          ok=false with reason 'no-manifest' | 'unreadable' | 'empty'
 */
export function pluginCacheHookEvents(root) {
  const p = join(root, 'hooks', 'hooks.json');
  if (!existsSync(p)) return { ok: false, events: [], reason: 'no-manifest' };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { ok: false, events: [], reason: 'unreadable' };
  }
  const events = Object.keys(parsed?.hooks || {});
  return events.length > 0
    ? { ok: true, events, reason: null }
    : { ok: false, events: [], reason: 'empty' };
}

export function hasInstallManagedHooks(opts) {
  const home = opts?.home || homedir();
  const plugin = opts?.plugin || DEFAULT_PLUGIN;
  const settingsPath = join(home, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return false;
  try {
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const serialized = JSON.stringify(s.hooks || {});
    return serialized.includes(`.${plugin}/`) || serialized.includes(`/${plugin}/`);
  } catch { return false; }
}

/** Every `command` string under settings.json `hooks`, in registration order. */
function settingsHookCommands(home) {
  const settingsPath = join(home, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return [];
  let s;
  try { s = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { return []; }
  const out = [];
  for (const matchers of Object.values(s?.hooks || {})) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      for (const h of (Array.isArray(m?.hooks) ? m.hooks : [])) {
        if (typeof h?.command === 'string') out.push(h.command);
      }
    }
  }
  return out;
}

/**
 * Absolute paths a hook command names. install.mjs writes `node "<abs>" …` /
 * `bash "<abs>"`, so the quoted form is the shipped shape; the unquoted arm covers
 * hand-edited and pre-quoting entries.
 */
function commandPaths(command) {
  const paths = [];
  for (const m of command.matchAll(/"([^"]+)"/g)) if (m[1].startsWith('/')) paths.push(m[1]);
  if (paths.length === 0) {
    for (const tok of command.split(/\s+/)) if (tok.startsWith('/')) paths.push(tok);
  }
  return paths;
}

/**
 * Does settings.json register hooks we manage that can ACTUALLY RUN?
 *
 * `hasInstallManagedHooks` answers a string question — "does settings.json mention a
 * path of ours" — and that is the right question for install(), which has just written
 * those entries itself. It is the wrong question for the SessionStart self-heal, whose
 * action is DESTRUCTIVE: clearing the plugin cache manifest is a dedup only while
 * settings.json really is the other registration. A user who installed globally, later
 * switched to the plugin, and removed `~/.claude-mem-lite` by hand (or by an
 * `npm uninstall -g` that never ran our `uninstall`) leaves entries that name a deleted
 * launcher. They fire nothing — and on that state the self-heal read them as a live
 * registration and emptied the ONE manifest that was working, on every single
 * SessionStart. v3.95.1 taught status/doctor to SEE that end state; this is the half
 * that stops producing it.
 *
 * Deliberately narrow: a `false` is returned only when at least one managed command was
 * parsed AND none of the paths it names exist. An unparseable or unfamiliar command shape
 * keeps the old answer, so this can only ever remove the destructive branch from a case
 * we positively verified as dead — never add it to one.
 *
 * @param {object} [opts]
 * @param {string} [opts.home]
 * @param {string} [opts.plugin]
 * @returns {boolean}
 */
export function hasLiveInstallManagedHooks(opts) {
  if (!hasInstallManagedHooks(opts)) return false;
  const home = opts?.home || homedir();
  const plugin = opts?.plugin || DEFAULT_PLUGIN;
  const managed = settingsHookCommands(home)
    .filter(c => c.includes(`.${plugin}/`) || c.includes(`/${plugin}/`));
  let checked = 0;
  for (const c of managed) {
    for (const p of commandPaths(c)) {
      checked++;
      if (existsSync(p)) return true;
    }
  }
  // No path we could check → keep hasInstallManagedHooks' answer (see docblock).
  return checked === 0;
}
