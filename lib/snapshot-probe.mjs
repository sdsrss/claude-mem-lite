// lib/snapshot-probe.mjs — what restoring one backup snapshot would give (D#558).
//
// Run as a CHILD by lib/db-unusable.mjs `checkSnapshot`, with CLAUDE_MEM_DIR set to a private
// directory that holds a copy of the snapshot as claude-mem-lite.db. It does what the restore
// command does after its `cp`: opens the copy with the opener every product face uses
// (ensureDbWithWalRecovery, its FTS-rebuild and WAL branches included) and rebuilds its indexes
// with rebuildIndexes, which is what `fts-check rebuild` runs. Then it runs SQLite's integrity
// check on that read-write connection and counts observations. One JSON line on stdout, carrying
// every rebuild error with its SQLite code, so checkSnapshot can tell the check's own disk filling
// up from damage (the second attempt dropped those codes, r1 P1-1).
//
// A child process, not a call: ensureDb opens DB_PATH, which lib/data-paths.mjs fixes from
// CLAUDE_MEM_DIR when it is first imported, so the product's own opener reaches a copy only in a
// process whose data directory is the copy's. A second opener written for the copy would be a
// twin of ensureDb, and the first attempt at this check (v6.30.5, withdrawn) failed on exactly
// that kind of gap: a stand-in check that disagreed with what a restore gives.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH, ensureDbWithWalRecovery, rebuildIndexes } from '../schema.mjs';

/** The other tables a user's rows live in: a snapshot holding rows only here is not empty. */
const OTHER_ROW_TABLES = ['session_summaries', 'user_prompts', 'events', 'deferred_work'];

/**
 * The checks after the open, on a connection to the restored copy. Exported for tests. Each
 * field is set before the next step runs, so a step that throws leaves the earlier ones in place.
 * `listed` is the observation count before the rebuild, which SQLite takes from an index when the
 * table has one, so it can list more rows than the table holds once rebuilt. `otherRows` counts
 * the rows of OTHER_ROW_TABLES.
 * @param {import('better-sqlite3').Database} db
 * @param {object} [into] the result being built
 * @returns {{listed: number, rebuildErrors: {code: string|null, message: string}[], rebuildCheck: 'ok'|'damaged'|'unchecked', integrity?: string, observations?: number, otherRows?: number}}
 */
export function probeOpenedStore(db, into = {}) {
  into.listed = db.prepare('SELECT count(*) FROM observations').pluck().get();
  const { errors, codes, check } = rebuildIndexes(db);
  into.rebuildErrors = errors.map((message, i) => ({ code: codes[i], message }));
  // 'ok' | 'damaged' | 'unchecked': a rebuild that could not be checked wrote nothing and leaves the
  // snapshot unchecked, decided by this state rather than guessed from an error code (D#593).
  into.rebuildCheck = check;
  into.integrity = db.prepare('PRAGMA integrity_check(1)').pluck().all().join('; ');
  into.observations = db.prepare('SELECT count(*) FROM observations').pluck().get();
  into.otherRows = OTHER_ROW_TABLES.reduce(
    (n, t) => n + db.prepare(`SELECT count(*) FROM ${t}`).pluck().get(),
    0,
  );
  return into;
}

function main() {
  // The opener creates a fresh store where none is, which would read as an empty snapshot.
  if (!existsSync(DB_PATH)) {
    process.stderr.write('Error: the copy to check is gone\n');
    process.exitCode = 2;
    return;
  }
  let db = null;
  const result = { opened: false };
  try {
    db = ensureDbWithWalRecovery();
    result.opened = true;
    probeOpenedStore(db, result);
  } catch (e) {
    result.error = { code: e?.code ?? null, message: String(e?.message ?? e) };
  } finally {
    try {
      db?.close();
    } catch {
      /* a private copy: nothing to keep */
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
