// lib/db-backup.mjs — point-in-time DB snapshot before irreversible maintenance.
//
// VACUUM INTO produces a consistent, compact copy of the database (WAL-safe —
// unlike copyFileSync, which would miss un-checkpointed WAL frames). Best-effort:
// a failure logs a WARN and returns null so it NEVER blocks the maintenance it
// guards (a backup that aborts a disk-full purge would be worse than no backup).
//
// MUST be called OUTSIDE any transaction — VACUUM cannot run inside one, which is
// why the maintenance entry points snapshot before opening their db.transaction().
import { readdirSync, unlinkSync, statSync } from 'fs';
import { dirname, basename, join } from 'path';
import { debugLog } from '../utils.mjs';

import { DAY_MS } from './time-constants.mjs';
// M-9 (audit 2026-08-14): per-tag retention alone let one-shot tags live forever —
// each tag kept its newest 3, but a tag written once (pre-backfill-v3390 and four
// siblings) never got a second snapshot to age it out, so 9 orphaned .bak files held
// 360MB against a 59MB live DB. A TOTAL byte budget across ALL tags bounds the
// footprint of a system whose name promises "lite". Oldest-first eviction, newest
// snapshot always survives (the most recent safety net must outlive any budget).
const DEFAULT_BACKUP_BUDGET_BYTES = 256 * 1024 * 1024;

/** Effective budget (env-tunable). Exported so stats/doctor derive their
 * footprint-warning thresholds from the SAME number eviction acts on —
 * pre-release review 2026-08-16: a hardcoded `3× DB` hint fired ~2.7× below
 * the real budget and promised an eviction that would never happen. */
export function backupBudgetBytes() {
  const mb = Number(process.env.CLAUDE_MEM_BACKUP_BUDGET_MB);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : DEFAULT_BACKUP_BUDGET_BYTES;
}

// Eviction grace: snapshots younger than this are never budget-evicted. This is
// what protects a fresh `pre-delete` undo pre-image (deleteObservations reports
// its path as the recovery route) from being unlinked by same-day maintain churn
// (pre-release review 2026-08-16). Deliberately age-based, NOT newest-per-tag:
// a per-tag exemption would make every one-shot tag's only snapshot immortal —
// exactly the 360MB orphan shape M-9 exists to evict. Mirrors the purge grace
// convention (7d) used by stale-observation retention.
export const BACKUP_EVICTION_GRACE_MS = 7 * DAY_MS;

// Canonical snapshot shape `<base>.<tag>-<ISO stamp>-<pid>-<seq>.bak` (what
// snapshotDb writes). Budget eviction deletes ONLY names matching this — a
// user's hand-made `cp db db.before-upgrade.bak` must never be auto-unlinked.
const SNAPSHOT_STAMP_RE = /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+-\d+\.bak$/;

/** All `<db>.<tag>-<ts>.bak` snapshots for `dbPath`, any tag, with size + mtime. */
export function listSnapshots(dbPath) {
  try {
    const dir = dirname(dbPath);
    const prefix = `${basename(dbPath)}.`;
    const out = [];
    for (const n of readdirSync(dir)) {
      if (!n.startsWith(prefix) || !n.endsWith('.bak')) continue;
      const full = join(dir, n);
      try {
        const st = statSync(full);
        out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* raced away */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Evict oldest snapshots (across ALL tags) until the total is within the byte
 * budget. Never evicted: the single newest snapshot (even if it alone exceeds
 * the budget), anything younger than BACKUP_EVICTION_GRACE_MS, and any file not
 * matching the canonical snapshot name shape. The total counts every .bak
 * (exempt files included), so a burst of young snapshots can hold the dir above
 * budget for up to the grace window — bounded by write rate, and the price of
 * never deleting an undo pre-image someone may still want.
 * Returns the number of files removed. Best-effort, never throws.
 */
export function enforceBackupBudget(dbPath, { budgetBytes = backupBudgetBytes(), nowMs = Date.now() } = {}) {
  try {
    const snaps = listSnapshots(dbPath).sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    let total = snaps.reduce((s, x) => s + x.size, 0);
    let removed = 0;
    const graceCutoff = nowMs - BACKUP_EVICTION_GRACE_MS;
    // Walk oldest-first; stop before touching the newest (index 0).
    for (let i = snaps.length - 1; i >= 1 && total > budgetBytes; i--) {
      if (!SNAPSHOT_STAMP_RE.test(snaps[i].path)) continue; // not ours — never delete
      if (snaps[i].mtimeMs > graceCutoff) continue; // inside undo grace
      try {
        unlinkSync(snaps[i].path);
        total -= snaps[i].size;
        removed++;
      } catch {
        /* per-entry best-effort */
      }
    }
    if (removed > 0) {
      try {
        debugLog('DEBUG', 'db-backup', `budget eviction removed ${removed} snapshot(s)`);
      } catch {
        /* ignore */
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

// Monotonic per-process suffix so two snapshots in the same millisecond (same pid)
// still get unique filenames (VACUUM INTO fails if the target already exists).
let _seq = 0;

/**
 * Snapshot `db` to `<db-path>.<tag>-<ts>.bak` via VACUUM INTO, then prune to the
 * newest `retain` snapshots. No-op (returns null) for :memory: DBs (tests) and on
 * any error (logged). Returns the snapshot path on success.
 * @returns {string|null}
 */
export function snapshotDb(db, { tag = 'pre-maintain', retain = 3 } = {}) {
  try {
    const dbPath = db && db.name;
    if (!dbPath || dbPath === ':memory:') return null; // in-memory — nothing to snapshot
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${_seq++}`;
    const out = `${dbPath}.${tag}-${stamp}.bak`;
    // Path is internal (db.name from our own config), but escape single quotes
    // defensively since VACUUM INTO takes a string literal, not a bound param.
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    pruneSnapshots(dbPath, tag, retain);
    enforceBackupBudget(dbPath);
    return out;
  } catch (e) {
    try {
      debugLog('WARN', 'db-backup', `snapshot skipped (proceeding without): ${e.message}`);
    } catch {
      /* ignore */
    }
    return null;
  }
}

// Keep the newest `retain` `<base>.<tag>-*.bak` files, unlink the rest. The ISO
// timestamp embedded in the name makes a lexical sort chronological.
function pruneSnapshots(dbPath, tag, retain) {
  try {
    const dir = dirname(dbPath);
    const prefix = `${basename(dbPath)}.${tag}-`;
    const names = readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.bak'))
      .sort()
      .reverse(); // newest first
    for (const n of names.slice(retain)) {
      try {
        unlinkSync(join(dir, n));
      } catch {
        /* per-entry best-effort */
      }
    }
  } catch {
    /* best-effort — dir may be unreadable */
  }
}
