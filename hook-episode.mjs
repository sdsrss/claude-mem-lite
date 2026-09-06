// claude-mem-lite episode buffer management
// Handles file-based episode storage with advisory locking and pending entry recovery

import { join } from 'path';
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  openSync,
  closeSync,
  writeSync,
  renameSync,
  statSync,
  constants as fsConstants,
} from 'fs';
import { inferProject, EDIT_TOOLS } from './utils.mjs';
import { RUNTIME_DIR } from './hook-shared.mjs';

/**
 * Read episode file without locking (for signal handlers only).
 * @returns {object|null} Parsed episode or null on failure
 */
export function readEpisodeRaw() {
  try {
    return JSON.parse(readFileSync(join(RUNTIME_DIR, `ep-${inferProject()}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Get the path to the current project's episode buffer file.
 * @returns {string} Absolute path to the episode JSON file
 */
export function episodeFile() {
  return join(RUNTIME_DIR, `ep-${inferProject()}.json`);
}

/**
 * Get the path to the advisory lock file for episode operations.
 * @returns {string} Absolute path to the lock file
 */
export function lockFile() {
  return episodeFile() + '.lock';
}

/**
 * Acquire an advisory file lock for episode buffer operations.
 * Uses atomic O_CREAT|O_EXCL for lock creation with stale lock detection.
 * @param {number} [maxWaitMs=500] Maximum time to wait for the lock
 * @returns {boolean} true if lock acquired, false on timeout
 */
export function acquireLock(maxWaitMs = 500) {
  const lf = lockFile();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      let fd;
      try {
        fd = openSync(lf, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
        const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
        writeSync(fd, payload);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      return true;
    } catch {
      // Lock exists — check if stale or orphaned
      try {
        const raw = readFileSync(lf, 'utf8');
        const info = JSON.parse(raw);
        const age = Date.now() - (info.ts || 0);
        let stale = age > 30000; // >30s = stale
        if (!stale && info.pid) {
          try {
            process.kill(info.pid, 0);
          } catch (killErr) {
            stale = killErr.code === 'ESRCH'; // Only stale if process truly gone
          }
        }
        if (stale) {
          try {
            unlinkSync(lf);
          } catch {}
          continue;
        }
      } catch {
        // Can't read lock — check mtime
        try {
          const st = statSync(lf);
          if (Date.now() - st.mtimeMs > 30000) {
            try {
              unlinkSync(lf);
            } catch {}
            continue;
          }
        } catch {}
      }
      // WARNING: Atomics.wait blocks the main thread. This is intentional and safe here
      // because hook.mjs runs as a short-lived subprocess (not the MCP server).
      // Do NOT use this pattern in server.mjs or any long-lived event-driven process.
      const wait = Math.ceil(Math.random() * 20);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
  return false;
}

/**
 * Release the advisory file lock for episode buffer operations.
 */
export function releaseLock() {
  try {
    unlinkSync(lockFile());
  } catch {}
}

/**
 * Read the current episode buffer from disk (requires lock).
 * @returns {object|null} Parsed episode or null if not found
 */
export function readEpisode() {
  try {
    return JSON.parse(readFileSync(episodeFile(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Atomically write episode buffer to disk using tmp+rename.
 * @param {object} episode The episode object to persist
 */
export function writeEpisode(episode) {
  const target = episodeFile();
  const tmp = target + `.tmp-${process.pid}`;
  const { _fileSet, ...serializable } = episode;
  // 0600 on the tmp file, not on `target`: mode applies at creation and rename
  // carries it over, so the buffer is never briefly world-readable. The buffer
  // holds captured file paths + scrubbed activity — owner-only like the DB.
  writeFileSync(tmp, JSON.stringify(serializable), { mode: 0o600 });
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

/**
 * Create a new empty episode buffer.
 * @param {string} sessionId The current session ID
 * @param {string} project The current project name
 * @returns {object} A fresh episode object
 */
export function createEpisode(sessionId, project) {
  return {
    sessionId,
    project,
    startedAt: Date.now(),
    lastAt: Date.now(),
    files: [],
    entries: [],
    filesRead: [],
  };
}

/**
 * Split an episode's entries by originating CC session so each concurrent
 * session flushes as its own observation. Common path (single session, or all
 * untagged/legacy entries) returns [episode] BY REFERENCE — behavior identical
 * to pre-grouping. When >=2 sessions interleaved in one buffer, returns one
 * sub-episode per session with its own entries + recomputed file union;
 * filesRead (untagged bash reads-file) is inherited by every sub. Each sub
 * resets savedId so it receives its own from its immediate-save (savedId is
 * load-bearing: llm-episode upgrades the pre-saved obs by it).
 * @param {object} episode
 * @returns {object[]}
 */
export function planEpisodeFlush(episode) {
  const groups = new Map();
  for (const e of episode.entries) {
    const key = e.ccSession ?? '__none__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  if (groups.size <= 1) return [episode];
  const subs = [];
  for (const [, entries] of groups) {
    subs.push({
      ...episode,
      entries,
      files: [...new Set(entries.flatMap((e) => e.files || []))],
      filesRead: episode.filesRead,
      savedId: undefined,
    });
  }
  return subs;
}

/**
 * Add file paths to an episode's file tracking set (deduped).
 * @param {object} episode The episode to update
 * @param {string[]} files Array of file paths to add
 */
export function addFileToEpisode(episode, files) {
  if (!episode._fileSet) episode._fileSet = new Set(episode.files);
  for (const f of files) {
    if (!episode._fileSet.has(f)) {
      episode._fileSet.add(f);
      episode.files.push(f);
    }
  }
}

/**
 * Write a pending entry to a recovery file when the episode lock cannot be acquired.
 * @param {object} entry The episode entry to persist
 * @param {string} sessionId The current session ID
 * @param {string} project The current project name
 */
export function writePendingEntry(entry, sessionId, project) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const pendingFile = join(RUNTIME_DIR, `pending-${ts}-${rand}.json`);
  const tmp = pendingFile + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify({ entry, sessionId, project, ts }), { mode: 0o600 });
    renameSync(tmp, pendingFile);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

/**
 * Merge pending recovery entries into the current episode buffer.
 * Reads and removes pending-*.json files from the runtime directory.
 * @param {object} episode The episode to merge entries into
 */
export function mergePendingEntries(episode) {
  const oneHourAgo = Date.now() - 3600000;
  const MAX_PENDING_MERGE = 50;
  let files;
  try {
    files = readdirSync(RUNTIME_DIR)
      // R10 P3-4: `.json.tmp` is the WRITER's in-flight temp, not a pending entry.
      // writePendingEntry writes `pending-<ts>-<rand>.json.tmp` then renames it into place;
      // the bare `pending-` prefix matched the temp too, this loop's JSON.parse failed on a
      // partial file, the catch deleted it as corrupt, and the writer's rename then failed
      // ENOENT inside its own swallowed catch. One tool entry lost, silently, every time
      // the two raced.
      .filter((f) => f.startsWith('pending-') && f.endsWith('.json'))
      .sort();
  } catch {
    return;
  }

  let merged = 0;
  for (const f of files) {
    if (merged >= MAX_PENDING_MERGE) break;
    const fp = join(RUNTIME_DIR, f);
    try {
      const raw = readFileSync(fp, 'utf8');
      const pending = JSON.parse(raw);
      if (pending.ts < oneHourAgo) {
        try {
          unlinkSync(fp);
        } catch {}
        continue;
      }
      // Only merge entries belonging to the same project
      if (pending.project && episode.project && pending.project !== episode.project) continue;
      if (pending.entry) {
        unlinkSync(fp);
        episode.entries.push(pending.entry);
        episode.lastAt = Math.max(episode.lastAt, pending.entry.ts || pending.ts);
        addFileToEpisode(episode, pending.entry.files || []);
        merged++;
      } else {
        // No entry data — clean up the file without merging
        try {
          unlinkSync(fp);
        } catch {}
      }
    } catch {
      // Corrupt pending file — remove
      try {
        unlinkSync(fp);
      } catch {}
    }
  }
}

/** Rule 4's threshold — 8+ Read/Grep entries read as investigation. */
const RESEARCH_ENTRY_THRESHOLD = 8;

/**
 * The significance decision WITH its reasoning, for instrumentation.
 * `episodeHasSignificantContent` is the boolean face of this same body, so the meter
 * and the decision cannot drift (audit 2026-08-22 P2-14).
 *
 * `grepDecisive` answers the one question the "move Grep into the bash skip list"
 * decision is blocked on: would this episode still have been kept without its Grep
 * entries? It is true ONLY when rule 4 decided AND the non-Grep entries alone fall
 * short — an edit-driven episode that happens to contain Greps is not evidence that
 * Grep carries research episodes.
 *
 * READ THE DENOMINATOR BEFORE READING `grepDecisive: 0`. It is a vacuous zero whenever
 * no episode contains a Grep at all, and that is the state measured on 2026-08-25:
 * across 555 instrumented episodes, `sum(readCount) = sum(grepCount) = 0`, and the `Grep`
 * tool was invoked **0 times in the entire 1111-transcript history on this machine**.
 * So "grepDecisive is 0, therefore Grep is safe to skip" is not an inference this counter
 * supports here — it never had the chance to fire. (The decision it was built for is
 * separately moot on that corpus: skipping a tool nobody calls saves 0ms.) Same shape as
 * the FTS5 `rowid = ? AND fts MATCH ?` trap this repo already paid for — a predicate that
 * cannot return true reports the defect as absent.
 *
 * The same measurement shows rules 4 and `buildImmediateObservation`'s `isReviewPattern`
 * are BOTH dormant, for a reason that has nothing to do with Grep: `readCount` counts
 * `Read || Grep`, and `Read` is filtered out at both layers (scripts/post-tool-use.sh
 * records it to `reads-<project>.txt` and exits; SKIP_TOOLS returns early in Node), so the
 * rule's only remaining input is a tool that is never called. Last observation the review
 * branch produced: 133 days ago, 111 lifetime.
 *
 * D#171 proposed the obvious repair — re-point rule 4 at `episode.filesRead`, populated at
 * hook.mjs:228 before this function runs, the same way rule 3 already reads
 * `episode.files`. MEASURED 2026-08-25: IT DOES NOT WORK TODAY, and the reason is dated,
 * not structural. Both halves matter, and the pre-tag review corrected the first draft of
 * each.
 *
 * Unlike the Grep case the denominator is real: `Read` fires 1861 times across the
 * 1114-transcript history (9.1% of all tool calls; the transcripts hold records spanning
 * 2026-08-13..08-25, so that is a live rate, not a lifetime counter). But `filesRead` is a
 * per-FLUSH slice, not a per-episode total — flushEpisodeWithDb renames and consumes
 * `reads-<project>.txt` on every flush. COMPARE THE TWO RATES ON THE SAME WINDOW: the
 * `episode_significance` metric rows cover three ACTIVE days (08-22 / 08-24 / 08-25; 08-23
 * has no file), 607 flushes; the transcripts touched in that window carry 596 Reads. That
 * is 0.98 Reads per episode. The first draft said 0.8 by dividing a 12-day Read rate by a
 * 3-day flush rate — two windows, one ratio, which is the same shape of error v3.80.0
 * recorded as "reading a lifetime counter as an active rate".
 *
 * At ~1 Read per episode a threshold of 8 is out of reach, and the 90-day sample agrees:
 * `files_read` is non-empty on 34 of 1872 rows (1.8%), p50 1 / p95 5 / max 8, exactly ONE
 * row reaching 8 — and that column is a SUPERSET of `episode.filesRead` (hook-llm.mjs
 * merges searched files in), so the true field is smaller. Two caveats on that sample, both
 * from the review: it only covers SIGNIFICANT episodes (saveEpisodeImmediate is gated on
 * `isSignificant`), which is ~8% of flushes and structurally excludes the population rule 4
 * would change; and 90 days starts AFTER the break below.
 *
 * THE RULE WAS NOT ALWAYS UNREACHABLE — do not write "structurally". Non-empty `files_read`
 * by month, with the count reaching the threshold of 8:
 *
 *     2026-02    35/  78  44.9%   >=8:  3   max 11
 *     2026-03   603/1004  60.1%   >=8: 49   max 53
 *     2026-04   314/ 621  50.6%   >=8: 28   max 33
 *     2026-05     8/ 129   6.2%   >=8:  0
 *     2026-06     5/ 754   0.7%   >=8:  0
 *     2026-07     8/ 919   0.9%   >=8:  1
 *     2026-08    20/ 193  10.4%   >=8:  0
 *     lifetime reaching >=8: 81
 *
 * For three consecutive months this field fed the threshold at a real rate. The break is
 * sharp: 2026-05-08 reads 11%, 05-09 onward reads 0.
 *
 * "THE REACHABLE INPUT IS THE EPISODE BOUNDARY" WAS WRONG — D#174 investigated it and the
 * boundary never moved. One query falsifies the whole family of boundary explanations:
 * measure the SIBLING column the same producer writes. `files_modified` is non-empty on
 * 85-98% of rows every month from 2026-02 through 2026-08, averaging 2.0-2.6 paths, and it
 * does not so much as dip across the break — while `files_read` goes 60% -> 1%. Episodes
 * still carry ~2 edits each; they just stopped carrying reads. A smaller boundary would have
 * taken both columns down together. Consistent with that, nothing in this repo changed at the
 * break: zero commits on 05-08/05-09, scripts/post-tool-use.sh byte-identical from 03-29 to
 * 05-24, hooks/hooks.json byte-identical from 04-22 to 05-10, and EPISODE_BUFFER_SIZE /
 * EPISODE_TIME_GAP_MS / isRelatedToEpisode untouched since 2026-02-11.
 *
 * WHAT ACTUALLY SET THE RATE (probed, not read): a flush consumed reads-<project>.txt
 * unconditionally but only PERSISTED it when the episode was significant
 * (flushEpisodeGroup saves on `isSignificant`, and unlinks the flush file otherwise). So a
 * buffered-but-insignificant flush — a successful `npm test` on its own, say — swallowed every
 * Read accumulated since the previous flush and wrote none of them anywhere. Measured in a
 * sandbox: seed 2 Reads, fire one such flush, and 0 observations are saved, the reads-file is
 * gone, and the NEXT (edit-bearing, significant) observation carries `files_read=[]`.
 *
 * PAST TENSE SINCE v3.83.0: D#178 is FIXED. `flushEpisodeWithDb` now decides significance
 * before it touches the file, and an insignificant flush leaves it in place for the next
 * saving one (`CLAUDE_MEM_READS_CARRY=0` restores the old order). Two numbers in the
 * paragraph above were also wrong and are corrected here rather than left to be re-quoted:
 * the significant share is ~59%, not "~4-8%" — the `episode_significance` meter reads 40.7%
 * INsignificant over n=938 across three active days — and the 92-96% figure D#178 was filed
 * on came from the same slip. What the loss actually was, replayed over 1122 real
 * transcripts through this file's own batcher (`benchmark/episode-flush-replay.mjs`):
 * 42.2% of the Read paths a flush consumed destroyed, 72.7% of significant flushes
 * carrying none. Same measurement pass as CHANGELOG v3.83.0, CLAUDE.md and README — quoting
 * a second pass here would be the stitched-across-runs error one file at a time.
 *
 * The D#171 conclusion below is UNAFFECTED and that is worth stating explicitly, because
 * the fix moves the quantity its arithmetic used. Post-fix the carried distinct set runs
 * median 1, p95 6, max 21 per delivering flush — still nowhere near rule 4's threshold of
 * 8 on a per-EPISODE basis, and rule 4 does not read this field anyway.
 *
 * Note the first version of that probe used `echo hello` as its "insignificant" entry.
 * detectBashSignificance drops it, so the episode had zero entries, flushEpisode
 * early-returned at `entries.length === 0`, the reads were never touched — and the probe
 * confidently reported the opposite conclusion. An insignificant entry must be asserted into
 * the buffer before it proves anything.
 *
 * D#171 closed as won't-fix-as-specified: the repair it named does not work at the current
 * cadence, and re-pointing the rule would move the dormancy to a field nobody suspects.
 * That closure stands, and D#174 no longer offers a reason to reopen it — the rule's own
 * input (`readCount`, which counts Read/Grep ENTRIES, and Read never reaches Node) is a
 * different quantity from `filesRead` and is untouched by any of the above.
 *
 * EXACTLY ONE claim above is pinned by a test, and deliberately so (D#175). Every number
 * here is a corpus measured at a timestamp — a test over those would be a snapshot that
 * rots and gets edited into greenness. The per-FLUSH claim is different in kind: it is a
 * property of code (the reads-file is renamed aside, then the copy is unlinked), and if
 * someone later makes reads accumulate across flushes, every "out of reach at ~1 Read per
 * episode" sentence above silently becomes false. That is the one this closure rests on,
 * so `tests/feature-sweep-hooks.test.mjs` → "the reads-file is consumed, not accumulated
 * (D#175)" drives two real flushes through the subprocess and asserts the second one starts
 * empty. Rename-becomes-copy and the dropped unlink are separate mutations caught by
 * separate assertions there — one does not cover the other.
 *
 * THAT ALARM DID NOT FIRE FOR D#178, and the reason is worth keeping. Both of its flushes
 * are SIGNIFICANT (each buffers a `.sql` Write), so both take the collect branch under the
 * new order too — the v3.83.0 change walked straight underneath a guard installed one
 * commit earlier to catch exactly "reads accumulate across flushes". Its sibling cases in
 * the same file now cover the insignificant arm, in both flag positions and in the
 * multi-session shape; a per-flush guard whose fixture only ever exercises one arm of the
 * branch it guards is covering the arm nobody was going to change.
 *
 * @param {object} episode
 * @returns {{significant: boolean, rule: 1|2|3|4|null, readCount: number,
 *   grepCount: number, grepDecisive: boolean}}
 */
export function explainSignificance(episode) {
  const entries = episode?.entries || [];
  const grepCount = entries.filter((e) => e.tool === 'Grep').length;
  const readCount = entries.filter((e) => e.tool === 'Read' || e.tool === 'Grep').length;
  const base = { readCount, grepCount, grepDecisive: false };

  // 1. File edits → always significant (code changes matter)
  if (entries.some((e) => EDIT_TOOLS.has(e.tool))) return { ...base, significant: true, rule: 1 };

  // 2. Test/build errors → significant (actionable failures)
  // Plain bash errors without edits are noise (e.g. typos, exploration errors)
  if (entries.some((e) => e.tool === 'Bash' && e.isError && (e.bashSig?.isTest || e.bashSig?.isBuild))) {
    return { ...base, significant: true, rule: 2 };
  }

  // 3. Important files touched (config, schema, security, migration)
  // Checks episode.files (all touched files, including reads) — catches important-file investigation
  const allFiles = episode?.files || [];
  if (
    allFiles.some(
      (f) =>
        /\.(env|yml|yaml|toml|lock|sql|prisma|proto)$/.test(f) ||
        /(config|schema|migration|auth|security)/i.test(f),
    )
  )
    return { ...base, significant: true, rule: 3 };

  // 4. Research pattern: reading many files indicates investigation
  if (readCount >= RESEARCH_ENTRY_THRESHOLD) {
    return {
      ...base,
      significant: true,
      rule: 4,
      grepDecisive: readCount - grepCount < RESEARCH_ENTRY_THRESHOLD,
    };
  }
  return { ...base, significant: false, rule: null };
}

/**
 * Check if an episode has significant content worth processing with LLM.
 * Significant = contains file edits, Bash errors, or a review/research pattern
 * (8+ Read/Grep entries indicate investigation worth recording).
 * @param {object} episode The episode to check
 * @returns {boolean} true if the episode has significant content
 */
export function episodeHasSignificantContent(episode) {
  return explainSignificance(episode).significant;
}
