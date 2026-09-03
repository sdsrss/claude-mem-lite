// lib/plugin-key.mjs — the plugin's identity in Claude Code's settings, and the one
// predicate that reads it.
//
// Audit 2026-09-02 P2-7. `PLUGIN_KEY` and `isPluginExplicitlyDisabled` shipped twice in JS —
// `hook.mjs` (which exits 0 on every event when the plugin is off) and `install.mjs` (which
// reports it in `doctor`/`status` and branches on it during cleanup) — plus a third,
// deliberate copy in `scripts/post-tool-use.sh`.
//
// What makes the duplication load-bearing rather than untidy: `install.mjs` writes hooks
// DIRECTLY into `~/.claude/settings.json`, so turning the plugin off in the Claude UI does
// not remove them. They keep firing, and this predicate is the only thing that makes
// "disabled" mean disabled. A key that drifts on one side leaves the user with a plugin they
// switched off and a hook set that never noticed.
//
// ZERO DEPENDENCIES: `hook.mjs` imports this at module scope on the hottest path in the
// system, and the check runs before anything else can.
//
// The shell copy in `scripts/post-tool-use.sh` STAYS a copy and is not a defect. That path
// is the ~5 ms bash pre-filter whose entire purpose is never reaching `node`, so it cannot
// import anything; its own header documents the parity requirement and
// `tests/post-tool-use-disabled.test.mjs` pins it. Two homes with a tested bridge is a
// different thing from two homes and a comment.

/** Marketplace this plugin is published under. */
export const MARKETPLACE_KEY = 'sdsrss';

/** The key Claude Code writes under `enabledPlugins` in `~/.claude/settings.json`. */
export const PLUGIN_KEY = `claude-mem-lite@${MARKETPLACE_KEY}`;

/**
 * Whether the user has EXPLICITLY switched the plugin off.
 *
 * Strict `=== false`, not falsiness: an absent key means "never installed via the
 * marketplace" (an npm-only install, which must keep working) and `true` means enabled.
 * Only an explicit `false` is a decision to honour — treating absent as disabled would
 * silently kill every direct-install user.
 *
 * @param {object|null|undefined} settings  Parsed ~/.claude/settings.json, or nullish when
 *   it is missing or unreadable — which reads as NOT disabled, so an unparseable settings
 *   file fails open rather than disabling the plugin the user is trying to use.
 */
export function isPluginExplicitlyDisabled(settings) {
  return settings?.enabledPlugins?.[PLUGIN_KEY] === false;
}
