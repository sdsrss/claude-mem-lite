// lib/quiet-scope.mjs — "should this surface stay quiet here?", defined once.
//
// Moved out of `hook-shared.mjs` (audit 2026-09-05 P1-2): `lib/startup-dashboard.mjs`
// imported `isAdoptedHere` from the hook layer, which is why the "lib/ does not depend
// on the hook layer" guard needed a named exception, and why that dashboard could not be
// unit-tested without dragging in the hook import graph. The three predicates only touch
// env plus the two adoption sentinels, so they are a leaf. `hook-shared.mjs` re-exports
// all three; server.mjs / hook-context.mjs / the tests are unchanged.

import { memdirPath, isAdopted as isAdoptedMemdir } from '../memdir.mjs';
import { isAdopted as isAdoptedClaudeMd } from '../claudemd.mjs';
import { PLUGIN_SLUG } from '../adopt-content.mjs';

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
    return isAdoptedClaudeMd(resolved, PLUGIN_SLUG) || isAdoptedMemdir(memdirPath(resolved), PLUGIN_SLUG);
  } catch {
    return false;
  }
}

export function effectiveQuiet(cwd) {
  return isQuietHooks() || isAdoptedHere(cwd);
}
