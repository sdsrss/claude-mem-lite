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
// ZERO LOCAL DEPENDENCIES (node:fs only): `hook.mjs` imports this at module scope on the hottest
// path in the system, and the check runs before anything else can.
//
// The shell copy in `scripts/post-tool-use.sh` STAYS a copy and is not a defect. That path
// is the ~5 ms bash pre-filter whose entire purpose is never reaching `node`, so it cannot
// import anything; its own header documents the parity requirement and
// `tests/post-tool-use-disabled.test.mjs` pins it. Two homes with a tested bridge is a
// different thing from two homes and a comment.

import { readRegularTextOrThrow } from './regular-file.mjs';

/** Marketplace this plugin is published under. */
export const MARKETPLACE_KEY = 'sdsrss';

/** This plugin's own name — the directory Claude Code materializes versions under. */
export const PLUGIN_NAME = 'claude-mem-lite';

/** The key Claude Code writes under `enabledPlugins` in `~/.claude/settings.json`. */
export const PLUGIN_KEY = `${PLUGIN_NAME}@${MARKETPLACE_KEY}`;

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

/**
 * The settings files Claude Code merges for `enabledPlugins`, lowest precedence first: user
 * (`<config home>/settings.json`), project (`<project>/.claude/settings.json`), local
 * (`<project>/.claude/settings.local.json`). Flag and policy settings sit above these and are
 * not readable from a hook.
 *
 * @param {string} configHome  the host's config home (lib/data-paths.mjs claudeConfigDir)
 * @param {string} projectDir  CLAUDE_PROJECT_DIR, else the hook's cwd
 */
export function pluginSettingsScopes(configHome, projectDir) {
  return [
    `${configHome}/settings.json`,
    `${projectDir}/.claude/settings.json`,
    `${projectDir}/.claude/settings.local.json`,
  ];
}

/**
 * Whether the plugin is off once the scopes are merged: the highest scope that sets the key
 * wins, and only an explicit `false` there disables (same rule as isPluginExplicitlyDisabled).
 * The user scope alone was read, so a plugin a project enabled was dead in that project, and
 * a project's documented `settings.local.json` false was ignored (E2E 2026-10-16 round 2).
 *
 * @param {Array<object|null|undefined>} settingsList  parsed scopes, lowest first; a missing
 *   or unparseable file is nullish and sets nothing (fail open)
 */
export function isPluginDisabledInScopes(settingsList) {
  let value;
  for (const settings of settingsList) {
    const v = settings?.enabledPlugins?.[PLUGIN_KEY];
    if (typeof v === 'boolean') value = v;
  }
  return value === false;
}

/**
 * isPluginDisabledInScopes over the files themselves: each scope read and parsed, a missing or
 * unparseable one setting nothing. For callers that are not the hook itself — the bash
 * prefilter's re-check and the CLI save face — so they read the files the way hook.mjs does.
 *
 * @param {string} configHome  the host's config home (lib/data-paths.mjs claudeConfigDir)
 * @param {string} projectDir  CLAUDE_PROJECT_DIR, else the caller's cwd
 */
export function isPluginDisabledForProject(configHome, projectDir) {
  return isPluginDisabledInScopes(pluginSettingsScopes(configHome, projectDir).map(readSettingsScope));
}

/**
 * One settings file parsed, or null when it is missing, unparseable, or not a regular file (a FIFO,
 * a device) or over 4 MiB, which sets nothing (fail open). Two of the scopes live in the project,
 * where a repository can commit `.claude/settings.json -> /dev/zero`: a plain read of that ran
 * without end on every hook event.
 * @param {string} path
 * @returns {object|null}
 */
export function readSettingsScope(path) {
  try {
    return JSON.parse(readRegularTextOrThrow(path));
  } catch {
    return null;
  }
}
