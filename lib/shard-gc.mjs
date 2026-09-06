// lib/shard-gc.mjs — retention sweep for daily JSONL shard directories.
//
// `lib/metrics.mjs` (CLAUDE_MEM_METRICS) appends one `YYYY-MM-DD.jsonl` per day with
// no GC of its own, so a long-lived install grows that dir unbounded.
//
// This module exists because there used to be TWO such sinks — the second was
// `registry-recommend.mjs`'s shadow log — and the sweep was written twice, line for
// line, differing only in how the directory is resolved; audit 2026-09-05 P2-3 found
// it as the largest non-intentional cross-file duplicate. That is the twin-drift class
// CLAUDE.md names: the retention rule (90 days, the `YYYY-MM-DD.jsonl` name filter) had
// two homes and could disagree with itself. The skill-registry subsystem was removed in
// 2026-09 (docs/audits/20260906-145304.md), leaving one caller; the extraction stays
// because the retention rule is worth owning in one place, not because of the caller count.
//
// Directory resolution stays with each caller — it is the only part that differed.

import { existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { DAY_MS } from './time-constants.mjs';

/** Shard filename → its ISO date. ISO dates sort lexicographically = chronologically. */
const SHARD_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * Delete `YYYY-MM-DD.jsonl` shards in `dir` older than `retainDays`. The shard date is
 * read from the filename, not from mtime — a shard rewritten today is still a shard for
 * its own day. Best-effort and never throws: this runs inside the SessionStart GC sweep,
 * where a missing dir, a racing writer, or an unreadable entry must not block startup.
 * A missing/empty `dir` is a no-op, so callers may pass an unresolved path.
 * @param {string} dir Directory holding the daily shards.
 * @param {number} [retainDays] Days to keep. 90 keeps a full quarter for aggregate windows.
 * @returns {number} shards removed
 */
export function gcDailyShards(dir, retainDays = 90) {
  try {
    if (!dir || !existsSync(dir)) return 0;
    const cutoff = new Date(Date.now() - retainDays * DAY_MS).toISOString().slice(0, 10);
    let removed = 0;
    for (const name of readdirSync(dir)) {
      const m = SHARD_RE.exec(name);
      if (m && m[1] < cutoff) {
        try {
          unlinkSync(join(dir, name));
          removed++;
        } catch {
          /* per-entry, silent */
        }
      }
    }
    return removed;
  } catch {
    return 0;
  }
}
