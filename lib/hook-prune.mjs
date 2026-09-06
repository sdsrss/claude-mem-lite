// lib/hook-prune.mjs — settings.json hook-entry classification and reconciliation.
//
// Extracted here because TWO faces need it and a direct import would close a cycle:
// `install.mjs` owns hook registration, and `hook-update.mjs` (which install.mjs
// already imports) has to reconcile after a swap. Per CLAUDE.md's rule — logic two
// faces share moves to `lib/`, the big file keeps only wiring — rather than
// documenting `install.mjs -> hook-update.mjs -> install.mjs` as an allowed cycle.
//
// Zero local imports on purpose: `hook-update.mjs` reaches this from the auto-update
// path, which must stay cheap and must not drag install.mjs's dependency graph in.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Identify a settings hook as one of OURS (to replace on install / strip on uninstall).
 *
 * Must be tight: the old `hook.mjs` + event-word test matched a user's OWN generic hook
 * (`node ~/.config/hook.mjs session-start`) and install/uninstall silently deleted it.
 * The launcher marker (`hook-launcher.mjs`, which every Node hook routes through since
 * v2.84) replaces that clause; the product-name substring (our install-dir / legacy-direct
 * hooks) and the bash prefilters round out the real markers.
 */
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

/**
 * The launcher's ENTRY argument, resolved — or null when this command is not a
 * launcher invocation we own.
 *
 * `nodeHook` writes `node "<INSTALL_DIR>/scripts/hook-launcher.mjs" scripts/<entry>.js`,
 * and the launcher resolves that bare relative token against its own INSTALL_DIR
 * (`hook-launcher.mjs:125`). Both halves matter for orphan detection: the quoted
 * launcher path exists on a healthy install, so a scanner that stops at the first
 * quoted token declares the entry healthy without ever looking at the file that
 * actually runs. That is precisely how the v5.0.0 `Skill` hook removal went unseen.
 *
 * Plugin-channel commands are excluded: `${CLAUDE_PLUGIN_ROOT}` is expanded by Claude
 * Code, not by us, so nothing here can resolve them — and hooks/hooks.json owns them.
 */
export function launcherEntryPath(cmd, installDir) {
  if (typeof cmd !== 'string' || cmd.includes('${CLAUDE_PLUGIN_ROOT}')) return null;
  if (!cmd.includes('hook-launcher.mjs')) return null;
  // Everything after the quoted launcher path; the entry is its first bare token.
  const tail = cmd.split(/hook-launcher\.mjs"?\s*/)[1];
  if (!tail) return null;
  const entry = tail.split(/\s+/).find((t) => t && !t.startsWith('-'));
  if (!entry) return null;
  return entry.startsWith('/') ? entry : join(installDir, entry);
}

/**
 * Drop settings.json hook entries whose launcher target no longer exists.
 *
 * Auto-update only ever handled hook ADDITIONS. `configureHooks()` strips stale mem
 * entries and rewrites every event, but its only caller is `install()`;
 * `hook-update.mjs` swaps `scripts/` wholesale, so an upgrade that REMOVES a hook
 * script leaves settings.json pointing at a file it just deleted. The launcher then
 * treats each fire as a broken install: two stderr lines and the self-heal marker,
 * for a file that is never coming back. First hit by the v5.0.0 `PreToolUse:Skill`
 * removal (R9 review P1-1); plugin-channel installs are unaffected because
 * hooks/hooks.json is replaced wholesale.
 *
 * Narrow by construction — an entry is dropped only when it is ours (`isMemHook`),
 * routes through our launcher, and its resolved target is absent. An entry that
 * cannot be parsed, or whose target exists, is left exactly as found; a foreign
 * tool's dead hook is not ours to remove.
 *
 * Pure: returns a new settings object plus the entry tokens removed, so the caller
 * decides whether to write and can log what changed.
 *
 * @returns {{settings: object, removed: string[]}}
 */
export function pruneDanglingMemHooks(settings, installDir) {
  if (!settings?.hooks) return { settings, removed: [] };
  const removed = [];
  const hooks = {};
  for (const [event, configs] of Object.entries(settings.hooks)) {
    if (!Array.isArray(configs)) {
      hooks[event] = configs;
      continue;
    }
    const kept = [];
    for (const cfg of configs) {
      if (!isMemHook(cfg)) {
        kept.push(cfg);
        continue;
      }
      const liveHooks = (cfg.hooks || []).filter((h) => {
        const target = launcherEntryPath(h.command, installDir);
        if (!target || existsSync(target)) return true;
        // Record the token as written, not the resolved path — that is what a
        // reader has to match against settings.json and the release manifest.
        const tail = String(h.command).split(/hook-launcher\.mjs"?\s*/)[1] || '';
        removed.push(tail.split(/\s+/).find((t) => t && !t.startsWith('-')) || target);
        return false;
      });
      if (liveHooks.length > 0) kept.push({ ...cfg, hooks: liveHooks });
    }
    hooks[event] = kept;
  }
  return { settings: { ...settings, hooks }, removed };
}
