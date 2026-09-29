// lib/quiet-scope.mjs — "should this surface stay quiet here?", defined once.
//
// Moved out of `hook-shared.mjs` (audit 2026-09-05 P1-2): `lib/startup-dashboard.mjs`
// imported `isAdoptedHere` from the hook layer, which is why the "lib/ does not depend
// on the hook layer" guard needed a named exception, and why that dashboard could not be
// unit-tested without dragging in the hook import graph. The three predicates only touch
// env plus the two adoption sentinels, so they are a leaf. `hook-shared.mjs` re-exports
// all three; server.mjs / hook-context.mjs / the tests are unchanged.

import { memdirPath, isAdopted as isAdoptedMemdir, isAutoAdoptDisabledFor } from '../memdir.mjs';
import { isAdopted as isAdoptedClaudeMd, readBlockAt } from '../claudemd.mjs';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { PLUGIN_SLUG } from '../adopt-content.mjs';
import { isSharedAncestor } from './local-steering.mjs';

// Phase A (v2.31.3+): MEM_QUIET_HOOKS=1 drops descriptive hook/MCP-instruction
// bodies (File Lessons / Key Context headers, MCP WHEN-TO-USE & decision rules,
// related-memory lesson suffix). Intended for users who adopted invited-memory
// (MEMORY.md sentinel) or who otherwise want minimal hook noise. Function form
// (not const) so modules importing at load time still respect later env sets
// in-process, and tests can toggle per-call. See docs/plans/2026-04-16-invited-memory-pattern.md.
export function isQuietHooks() {
  return process.env.MEM_QUIET_HOOKS === '1';
}

// Phase D (v2.32.1+) → v3.13: if the current project has adopted our steering,
// the contract is already loaded at system-prompt authority — so hook +
// MCP-instruction output can also go quiet. v3.13 moved that contract from the
// memory-dir MEMORY.md sentinel to the project CLAUDE.md managed block, so check
// the new scheme first and keep the legacy memdir sentinel as a fallback (an
// un-migrated project stays quiet through the transition). isQuietHooks (env)
// remains an independent, stronger override.
export function isAdoptedHere(cwd) {
  try {
    const resolved = cwd || process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
    if (isAdoptedClaudeMd(resolved, PLUGIN_SLUG) || isAdoptedMemdir(memdirPath(resolved), PLUGIN_SLUG))
      return true;
    // r3: the block auto-adopt wrote into CLAUDE.local.md loads whatever the switches say
    // now (MEM_NO_AUTO_ADOPT only stops new writes). A file read, not a git call: this runs
    // on every quiet check, and the project dir is the top-level in the normal case.
    if (readBlockAt(join(resolved, 'CLAUDE.local.md'), PLUGIN_SLUG).body !== null) return true;
    return isSteeringInjectedHere(resolved);
  } catch {
    return false;
  }
}

/**
 * Report §9-A: auto-adopt no longer writes the managed block into a project; SessionStart
 * injects the same steering text unless auto-adopt is switched off (MEM_NO_AUTO_ADOPT=1, or
 * the project's `.mem-no-auto-adopt` sentinel). Steering that is delivered counts as adopted
 * for the quiet gate, as the written block did — otherwise every project would turn verbose
 * the moment the files stopped being written.
 * @param {string} cwd resolved project root
 * @returns {boolean}
 */
function isSteeringInjectedHere(cwd) {
  if (process.env.MEM_NO_AUTO_ADOPT === '1') return false;
  if (isAutoAdoptDisabledFor(cwd)) return false;
  // silentAutoAdopt holds a subdirectory session to an opt-out recorded for the repository root,
  // unless the root CLAUDE.md carries the block (delta review P2-2). Mirror it, or that session
  // gets neither the steering nor the verbose sections.
  const root = workTreeTop(cwd);
  if (!root || root === resolve(cwd) || isSharedAncestor(root)) return true;
  if (readBlockAt(join(root, 'CLAUDE.md'), PLUGIN_SLUG).body !== null) return true;
  return !isAutoAdoptDisabledFor(root);
}

// The nearest ancestor holding `.git` (a directory, or the file of a worktree or submodule) —
// how git finds the top-level, without spawning git on every quiet check.
function workTreeTop(cwd) {
  let d = resolve(cwd);
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export function effectiveQuiet(cwd) {
  return isQuietHooks() || isAdoptedHere(cwd);
}
