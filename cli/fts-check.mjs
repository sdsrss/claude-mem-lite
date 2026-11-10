// cli/fts-check.mjs — `claude-mem-lite fts-check <check|rebuild>`.
// Extracted from mem-cli.mjs (v2.41, god-module split).

import Database from 'better-sqlite3';
import { DB_PATH, checkFTSIntegrity, rebuildIndexes } from '../schema.mjs';
import { notRebuiltText } from '../lib/db-unusable.mjs';
import { holdOpen } from '../lib/checked-write.mjs';
import { parseArgs, out, fail } from './common.mjs';
import { CLI_INVOKE } from '../cli-path.mjs';

export function cmdFtsCheck(db, args) {
  const { positional } = parseArgs(args);
  const action = positional[0];
  if (!action) {
    fail(`[mem] Usage: ${CLI_INVOKE} fts-check <check|rebuild>`);
    return;
  }
  if (!['check', 'rebuild'].includes(action)) {
    // Tell the user what was wrong rather than dumping the usage — they passed
    // something concrete, the error should name the invalid token.
    fail(`[mem] Invalid action "${action}". Use: check, rebuild`);
    return;
  }

  // Exit-code contract, matching `memdir-audit` — the other diagnostic in
  // CLI_COMMANDS, whose help documents "Exit 0 if every file is compliant, 1
  // otherwise". Both actions used to print the failure and exit 0, so
  // `fts-check rebuild && echo repaired` announced a repair that had not
  // happened, and an agent reading only the status code was told the index was
  // healthy. `doctor` points users at this command precisely when it is not.
  //
  // Findings stay on STDOUT via out() rather than moving to fail()'s stderr:
  // they are the report the user asked for, not an error trace, and the details
  // are worth piping. Only process.exitCode changes.
  if (action === 'check') {
    const result = checkFTSIntegrity(db);
    if (result.healthy) {
      out('[mem] FTS5 indexes are healthy — all integrity checks passed.');
    } else if (result.busy) {
      // Not a finding: "issues found" invited a rebuild of a healthy store, a long write that
      // blocks the live hooks (E2E 2026-10-16 round 2). Exit 1 all the same: nothing was checked.
      out('[mem] FTS5 check not run — the database is in use by another process. This is not');
      out('  corruption; do not rebuild. Run the check again when the store is idle.');
      process.exitCode = 1;
    } else {
      out(`[mem] FTS5 issues found:`);
      for (const d of result.details) out(`  ${d}`);
      process.exitCode = 1;
    }
    return;
  }

  if (action === 'rebuild') {
    // The FTS5 indexes, then every other index (REINDEX): the last step of doctor's restore
    // command, which the restore check ran on its copy (D#558).
    // A read-only connection held until this process exits, after mem-cli closes `db`: that close
    // is then not the store's last and does not checkpoint the log into the main file, which on a
    // store damaged only in a log frame writes the damage over intact pages (D#593).
    const holder = holdOpen(Database, DB_PATH);
    if (holder) process.once('exit', () => holder.close());
    const result = rebuildIndexes(db);
    if (result.check !== 'ok') {
      out(`[mem] ${notRebuiltText(result)}`);
      process.exitCode = 1;
    } else if (result.errors.length > 0) {
      // Partial success is a failure of the requested operation: the caller asked
      // for a rebuild and at least one index still is not rebuilt.
      out(`[mem] Rebuilt: ${result.rebuilt.join(', ')}. Errors: ${result.errors.join(', ')}`);
      process.exitCode = 1;
    } else {
      out(`[mem] Successfully rebuilt: ${result.rebuilt.join(', ')}`);
    }
  }
}
