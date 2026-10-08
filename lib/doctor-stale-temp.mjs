/**
 * What counts as stale temp residue, and — the half that kept drifting — what does NOT.
 *
 * Extracted from install.mjs because the scanner (`doctor`) and the deleter (`cleanup`)
 * were two hand-kept copies of the same rules, and they have now diverged twice:
 *
 *   • v3.93.0 moved the deleter to MEM_RUNTIME_DIR and left the scanner on
 *     join(MEM_DATA_DIR,'runtime'), so under a runtime override doctor reported "none"
 *     while the cleanup it recommends removed files. Fixed by moving the scanner.
 *   • D#53 (measured 2026-09-22): the deleter age-gates `pending-*` / `ep-flush-*` at
 *     ORPHAN_EPISODE_AGE_MS and the scanner did not, so with three in-flight episode
 *     files doctor printed "Stale temp files: 3 found (run: node install.mjs cleanup)"
 *     and cleanup answered "Kept 3 episode file(s) newer than 1h" then "No stale files
 *     found." Two faces of one install contradicting each other, verbatim.
 *
 * Both were the same defect class on different axes — first the directory, then the age
 * gate — which is why this module exports the CLASSIFIER and not just the prefixes.
 * Sharing the prefixes alone would leave the age gate implemented twice, which is the
 * shape that produced D#53 in the first place.
 *
 * A leaf: node:fs, node:path, and one constants module that imports nothing.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ORPHAN_EPISODE_AGE_MS } from './time-constants.mjs';

/**
 * Residue of a self-update. hook-update's installExtractedRelease stages and backs up beside the
 * tree it swaps: the CODE dir (~/.claude-mem-lite), which CLAUDE_MEM_DIR does not move (D#289).
 * Before v2.90.0 the code lived in the data dir, so an updater then swapped into a relocated data
 * dir; residue it left there is stale whatever it holds (scanStaleTempFiles' legacyDir).
 */
const UPDATE_RESIDUE_PREFIXES = ['.update-staging-', '.update-backup-'];

/**
 * The journal a swap keeps inside its backup dir. A literal, not an import: hook-update.mjs is on
 * the repair path and stays off this leaf's load graph; tests/update-residue-faces.test.mjs holds
 * the two spellings equal.
 */
export const SWAP_JOURNAL_NAME = '.swap-journal.json';

/**
 * Written into a backup dir when its swap is over (committed, or rolled back), before the journal
 * is removed: a journal left beside it is never replayed (D#292 C). Same arrangement as above.
 */
export const SWAP_RESOLVED_NAME = '.swap-resolved';

/** Episode hand-off files under the runtime dir. Age-gated: see classifyEpisodeFile. */
const EPISODE_RESIDUE_PREFIXES = ['pending-', 'ep-flush-'];

export const isUpdateResidue = (name) => UPDATE_RESIDUE_PREFIXES.some((p) => name.startsWith(p));

export const isEpisodeResidue = (name) => EPISODE_RESIDUE_PREFIXES.some((p) => name.startsWith(p));

/**
 * Is this update residue the leftover of a swap that is over, or a swap that never finished?
 *
 * A backup dir that holds its journal and no resolved marker is a swap whose updater was killed:
 * it holds the only copy of every file the swap had moved out, and the next update entry replays
 * the journal to put them back. Deleting it as stale temp kept the half-swapped tree for good
 * (D#289). A swap that is over (committed, or rolled back) writes the resolved marker and then
 * removes its journal, so a backup dir with the marker or without a journal, and any staging dir,
 * is residue. A dir from 6.25.0 or older carries no marker; one whose journal survived a finished
 * swap there still reads as unfinished.
 *
 * A swap running right now looks the same as one that was killed; cleanup tells them apart by
 * install.lock, doctor cannot, and says so.
 *
 * 'unreadable-journal' is an unresolved backup dir whose journal is there but cannot be read now,
 * or not as one (a write of 6.25.0 or older torn by a kill). Recovery cannot replay it and it may
 * hold the only copy of what moved, so recovery leaves it (the same rule as hook-update's
 * recoverInterruptedSwaps); the next swap that commits, or an install, retires it. One whose read
 * error clears before that would be replayed like any unfinished swap.
 *
 * Only a real directory is a swap: recovery skips a file or a symlink with the name (its Dirent is
 * not a directory), so the classifier calls those leftover too, judged by lstat as recovery does.
 *
 * @returns {'unfinished-swap'|'unreadable-journal'|'stale'|null} null when not update residue
 */
export function classifyUpdateResidue(codeDir, name) {
  if (!isUpdateResidue(name)) return null;
  const dir = join(codeDir, name);
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return 'stale';
  }
  if (!st.isDirectory() || !name.startsWith('.update-backup-')) return 'stale';
  if (existsSync(join(dir, SWAP_RESOLVED_NAME))) return 'stale';
  let raw;
  try {
    raw = readFileSync(join(dir, SWAP_JOURNAL_NAME), 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? 'stale' : 'unreadable-journal';
  }
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j?.backedUp) && Array.isArray(j?.installed)) return 'unfinished-swap';
  } catch {
    /* not a journal */
  }
  return 'unreadable-journal';
}

/** A directory's names; [] when it does not exist. Any other error throws: absent is not unreadable. */
function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * How the age gate is SPOKEN, derived from the gate itself rather than hand-written.
 *
 * Both faces print this window to the user. Before it existed, cleanup printed a literal
 * "1h" while the rule lived in ORPHAN_EPISODE_AGE_MS, and this change's own first draft
 * added a second literal to doctor's new in-flight line — a hand-kept twin of the gate, in
 * the change whose headline was that the rule has one home. Pre-ship review counted it.
 *
 * Whole hours only: a 20-minute gate would print "0h". The gate is HOUR_MS today, and
 * tests/doctor-stale-temp-agreement.test.mjs parses this label back and requires it to
 * equal the gate, so a gate that is not a whole number of hours fails there rather than
 * printing a wrong window to the user.
 */
export const EPISODE_AGE_LABEL = `${Math.round(ORPHAN_EPISODE_AGE_MS / 3600000)}h`;

/**
 * Is this episode file residue, or is it work in progress?
 *
 * The single definition of the age gate that doctor and cleanup share. (The automatic
 * sweep in hook-shared.mjs and the summarizer's wait in hook-llm.mjs apply the same
 * constant in their own code.) `ep-flush-<ts>-<id>.json` is the episode handed to the
 * summarizer, not leftovers: the round-trip is up to ~60s, and deleting one mid-flight
 * discards that episode's observations silently. An unreadable mtime counts as in-flight,
 * because failing safe costs one stale file until the next sweep and failing open costs
 * an episode.
 *
 * @returns {'stale'|'in-flight'}
 */
export function classifyEpisodeFile(
  runtimeDir,
  name,
  { now = Date.now(), episodeAgeMs = ORPHAN_EPISODE_AGE_MS } = {},
) {
  let mtimeMs;
  try {
    mtimeMs = statSync(join(runtimeDir, name)).mtimeMs;
  } catch {
    return 'in-flight';
  }
  // `>=`, so a file aged exactly the gate is KEPT — the side hook-shared.mjs's sweep
  // (deletes only `< cutoff`) and hook-llm.mjs (`>= cutoff` is live) already chose. `>`
  // put the tie on cleanup's delete side, making the manual command the aggressive one.
  return mtimeMs >= now - episodeAgeMs ? 'in-flight' : 'stale';
}

/**
 * Count what `cleanup` would actually remove, split from what it would deliberately keep.
 *
 * `stale` is the number doctor may recommend cleanup for; `inFlight` is reported as a
 * detail rather than a warning, because a file that is supposed to exist right now is not
 * a fault. Note the asymmetry, which is deliberate and is NOT the age gate being applied
 * inconsistently: update residue is guarded by install.lock in cleanup, not by age, so
 * there is no age gate here for it to mirror. `unfinishedSwaps` are backup dirs with a readable
 * journal and no resolved marker: cleanup finishes those swaps rather than removing them, and
 * `unreadableJournals` it leaves (classifyUpdateResidue).
 *
 * @param {{codeDir: string, runtimeDir: string, legacyDir?: string, now?: number, episodeAgeMs?: number}} args
 *   codeDir is where update residue lives; runtimeDir is where episode files live. legacyDir is a
 *   data dir CLAUDE_MEM_DIR keeps apart from the code dir: update residue there was left by an
 *   updater older than v2.90.0, which swapped into it, so all of it is stale and none of it is
 *   replayed. (It holds no journal either: journals came in v3.57.0.)
 * @returns {{stale: number, inFlight: number, unfinishedSwaps: number, unreadableJournals: number,
 *   notChecked: Array<{dir: string, code: string}>}} A directory that exists but cannot be listed
 *   goes in notChecked, never counted as empty, and the others are still counted.
 */
export function scanStaleTempFiles({ codeDir, runtimeDir, legacyDir, now = Date.now(), episodeAgeMs }) {
  let stale = 0;
  let inFlight = 0;
  let unfinishedSwaps = 0;
  let unreadableJournals = 0;
  const notChecked = [];
  const list = (dir) => {
    try {
      return listDir(dir);
    } catch (e) {
      notChecked.push({ dir, code: e.code || 'error' });
      return [];
    }
  };

  for (const f of list(codeDir)) {
    const kind = classifyUpdateResidue(codeDir, f);
    if (kind === 'unfinished-swap') unfinishedSwaps++;
    else if (kind === 'unreadable-journal') unreadableJournals++;
    else if (kind === 'stale') stale++;
  }
  if (legacyDir) {
    for (const f of list(legacyDir)) if (isUpdateResidue(f)) stale++;
  }

  for (const f of list(runtimeDir)) {
    if (!isEpisodeResidue(f)) continue;
    if (classifyEpisodeFile(runtimeDir, f, { now, episodeAgeMs }) === 'in-flight') inFlight++;
    else stale++;
  }

  return { stale, inFlight, unfinishedSwaps, unreadableJournals, notChecked };
}
