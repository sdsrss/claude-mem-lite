// lib/atomic-write.mjs — crash-safe file writes with optional one-time backup.
//
// Why: several write paths mutate user-global config that, if torn or clobbered,
// breaks the user outside the plugin's control — most acutely ~/.claude.json
// (the WHOLE Claude Code config) in hook-update's post-update MCP dedup, and
// ~/.claude/settings.json in install. A plain writeFileSync can leave a
// half-written file on crash, and a fixed ".tmp" name races concurrent writers.
// This writes to a pid-unique temp then renames (atomic on POSIX), and can drop
// a one-time ".bak" so a logic bug in the caller's merge is recoverable.

import { writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Atomically write `data` to `filePath` (temp + rename). Optionally back up the
 * existing file once to `<filePath>.bak` before the first overwrite.
 * @param {string} filePath
 * @param {string} data
 * @param {object} [opts]
 * @param {boolean} [opts.backup=false]  Create <filePath>.bak if absent and the
 *   target exists, before writing. Only the first call creates it, so the backup
 *   preserves the last-known-good rather than being overwritten each run.
 */
export function atomicWriteFileSync(filePath, data, { backup = false } = {}) {
  // Write THROUGH a symlink to its real target. renameSync onto a symlink NAME replaces the
  // link with a regular file, silently orphaning a dotfiles-managed (chezmoi/stow/yadm)
  // config: ~/.claude/settings.json (and ~/.claude.json) get severed from the dotfiles
  // repo, so future dotfiles edits stop applying and .bak captures the wrong content.
  // Resolve first, then put the temp in the TARGET's dir so the rename stays same-device
  // (atomic, no EXDEV). A broken/absent symlink falls through to a direct write.
  let target = filePath;
  try {
    if (lstatSync(filePath).isSymbolicLink()) target = realpathSync(filePath);
  } catch { /* not a symlink, or missing — write filePath directly */ }

  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (backup && existsSync(target) && !existsSync(target + '.bak')) {
    try { copyFileSync(target, target + '.bak'); } catch { /* best-effort backup */ }
  }

  // pid-unique temp: a fixed ".tmp" name lets two concurrent installs clobber
  // each other's temp mid-write. Same-dir-as-target temp keeps the rename atomic (no
  // cross-device move) even when the target lives in a dotfiles repo on another mount.
  // The temp is removed on ANY failure. Without this a failed rename (target replaced by a
  // directory, permissions, a symlink whose resolution path fails) leaves
  // `<name>.tmp-<pid>` behind — and several call sites write into the USER's project root
  // (CLAUDE.md), where the residue shows up in their `git status` and nothing sweeps it:
  // the orphan sweep only walks RUNTIME_DIR. Cleaning here covers every caller rather than
  // asking each one to remember, which is the mistake the private twins made.
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing written, or already gone */ }
    throw e;
  }
}
