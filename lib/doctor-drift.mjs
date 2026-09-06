// Dev-drift check: in dev-mode installs (symlinked to project repo), every
// managed source file in INSTALL_DIR should be a symlink. A regular file
// means an earlier install copied it (e.g. install.mjs before it was added
// to SOURCE_FILES) or someone ran `cp` manually — edits won't propagate
// from the repo, testing vs runtime will silently diverge.
//
// Returns: { devMode, drift, details } — devMode=false when no symlinks
// detected (prod copy install), drift=true when in dev-mode AND at least
// one SOURCE_FILES entry is a plain file.

import { existsSync, lstatSync } from 'fs';
import { join } from 'path';

// Files something EXECUTES by path (the CLI, the MCP server, a hook entry) as opposed to
// files that are only ever `import`ed. The distinction decides whether an absent file
// matters in a symlink install: Node resolves an ESM specifier against the importing
// module's REALPATH, so a symlinked entry point resolves `../lib/x.mjs` inside the REPO and
// never looks at the install dir. An absent import-only module is therefore unreachable
// dead weight there — while an absent ENTRY POINT is fatal in every shape, because the
// command names that path directly.
//
// Scope note: this classifies only what the CALLER passes in, and install.mjs passes
// SOURCE_FILES, which holds zero `scripts/` entries — hook scripts are installed from the
// separate HOOK_SCRIPT_FILES manifest. An earlier draft mapped those into this set; it
// could never match a single path, so it was removed rather than left as inert code
// implying coverage it did not have. The hook-script manifest now has its own check with
// its own severity rules: `checkHookScriptDrift` below.
const ENTRY_POINTS = new Set(['cli.mjs', 'mem-cli.mjs', 'server.mjs', 'hook.mjs', 'install.mjs']);

export function checkDevDrift(installDir, sourceFiles) {
  if (!existsSync(installDir)) {
    return {
      devMode: false,
      drift: false,
      symlinkCount: 0,
      plainCount: 0,
      plainFiles: [],
      missingCount: 0,
      details: [],
    };
  }
  const symlinkFiles = [];
  const plainFiles = [];
  const missing = [];
  for (const rel of sourceFiles) {
    const p = join(installDir, rel);
    if (!existsSync(p)) {
      missing.push(rel);
      continue;
    }
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) symlinkFiles.push(rel);
      else plainFiles.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  // devMode detection: if ≥1 symlink exists among source files, consider
  // this a dev install. (Prod install is all plain files → drift=false
  // because there's nothing to drift from.)
  const devMode = symlinkFiles.length > 0;
  const drift = devMode && plainFiles.length > 0;
  const missingEntry = missing.filter((rel) => ENTRY_POINTS.has(rel));
  const missingModules = missing.filter((rel) => !ENTRY_POINTS.has(rel));
  return {
    devMode,
    drift,
    symlinkCount: symlinkFiles.length,
    plainCount: plainFiles.length,
    plainFiles,
    missingCount: missing.length,
    missingFiles: missing.slice(0, 5),
    // Split so the caller can grade by consequence rather than by count: an entry point is
    // fatal in every install shape, an import-only module only in a copy install.
    missingEntryCount: missingEntry.length,
    missingEntryFiles: missingEntry.slice(0, 5),
    missingModuleCount: missingModules.length,
    missingModuleFiles: missingModules.slice(0, 5),
    details: plainFiles.slice(0, 5),
  };
}

// Hook scripts a hook COMMAND LINE names directly — install.mjs's settings.json template
// and hooks/hooks.json both spell these paths out. Absent ⇒ the command cannot start.
// `prompt-search-utils.mjs` is deliberately absent from this set: nothing invokes it, it is
// imported by user-prompt-search.js. The split drives the message, not the severity — see
// checkHookScriptDrift.
//
// Exported so the set is not a second hand-maintained copy of the hook wiring that can go
// stale in silence: tests/doctor-hook-script-manifest.test.mjs re-derives it from the
// `command` strings in hooks/hooks.json and asserts equality, so registering a new hook
// script without classifying it here goes red.
//
// `pre-agent-inject.js` moved OUT of this set on 2026-08-22 (audit P2-5): no command line
// names it any more — `pre-agent-inject.sh` does, and execs the .js only when the feature
// is switched on. It is still shipped and still executed, so `checkHookScriptDrift` keeps
// grading it; it now reports as the module class, whose message ("ERR_MODULE_NOT_FOUND at
// hook time") is the truer description of what its absence does. Same severity either way,
// which is why this set is documented as driving the MESSAGE, not the grade.
export const HOOK_SCRIPT_ENTRY_POINTS = new Set([
  'post-tool-use.sh',
  'user-prompt-search.js',
  'pre-tool-recall.js',
  'post-tool-recall.js',
  'pre-agent-inject.sh',
  'hook-launcher.mjs',
]);

/**
 * Integrity of the HOOK_SCRIPT_FILES manifest under `<installDir>/scripts/`.
 *
 * Separate from checkDevDrift because the two manifests install in different SHAPES, and
 * #10686's rule — grade by which path RESOLVES the file — lands differently for each:
 *
 *   • dev install: install.mjs symlinks the whole `scripts/` DIRECTORY (one link), not each
 *     file. So per-file lstat sees plain files through the link, and "plain file among
 *     symlinks = drift" — the signal checkDevDrift is built on — does not exist here at all.
 *     Applying it would flag every healthy dev install with 8 phantom drifts. What a missing
 *     file means instead: the install dir IS the repo dir, so it is missing from the repo.
 *   • copy install: an entry script is named by a command line (dead hook if absent), and
 *     user-prompt-search.js resolves `./prompt-search-utils.mjs` against the install dir
 *     (ERR_MODULE_NOT_FOUND on every user prompt if absent).
 *
 * Both classes are therefore fatal in both shapes. The entry/module split is kept for the
 * MESSAGE — telling the reader which consequence they have — and must NOT be re-used to
 * demote the module class the way the managed-files check legitimately does.
 *
 * `present:false` covers a scripts/ dir that was never created AND a dangling symlink:
 * existsSync follows links, and the hook commands resolve through it to the same nothing.
 *
 * @param {string} installDir
 * @param {string[]} hookScriptFiles HOOK_SCRIPT_FILES manifest
 */
export function checkHookScriptDrift(installDir, hookScriptFiles) {
  const scriptsDir = join(installDir, 'scripts');
  let dirSymlink = false;
  try {
    dirSymlink = lstatSync(scriptsDir).isSymbolicLink();
  } catch {
    /* absent — handled below */
  }
  const classify = (missing) => ({
    missingCount: missing.length,
    missingEntryFiles: missing.filter((n) => HOOK_SCRIPT_ENTRY_POINTS.has(n)),
    missingModuleFiles: missing.filter((n) => !HOOK_SCRIPT_ENTRY_POINTS.has(n)),
  });
  if (!existsSync(scriptsDir)) {
    const all = classify([...hookScriptFiles]);
    return { present: false, dirSymlink, ...all };
  }
  const missing = [];
  for (const name of hookScriptFiles) {
    if (!existsSync(join(scriptsDir, name))) missing.push(name);
  }
  return { present: true, dirSymlink, ...classify(missing) };
}
