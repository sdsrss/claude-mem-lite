// cli/fts-check.mjs — `claude-mem-lite fts-check <check|rebuild>`.
// Extracted from mem-cli.mjs (v2.41, god-module split).

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { checkFTSIntegrity, rebuildIndexes } from '../schema.mjs';
import { checkStorePages } from '../lib/store-pages.mjs';
import { PAGE_DAMAGE_COPY_ADVICE, dataDirCopyCommand } from '../lib/db-unusable.mjs';
import { parseArgs, out, fail } from './common.mjs';
import { CLI_INVOKE } from '../cli-path.mjs';

/**
 * What `fts-check rebuild` prints when the page check stops it (D#593): the reason, the check's
 * lines, and on damage the advice and a command that copies the data directory.
 * @param {ReturnType<typeof checkStorePages>} pages a result that is not `ok`
 * @param {string} dbPath
 * @returns {string[]}
 */
function refusalLines(pages, dbPath) {
  if (pages.state !== 'damaged') {
    return [`[mem] Not rebuilt: the database's pages could not be checked first (${pages.error}).`];
  }
  return [
    "[mem] Not rebuilt: the database's pages are damaged, so a rebuild could overwrite rows on them:",
    ...pages.lines.map((l) => `  ${l}`),
    ...(pages.more > 0 ? [`  and ${pages.more} more`] : []),
    `  ${PAGE_DAMAGE_COPY_ADVICE}`,
    `  ${dataDirCopyCommand(dbPath)}`,
  ];
}

/**
 * `fts-check rebuild`'s page check, run BEFORE the CLI opens the store with the product opener
 * (D#593): the opener can write (the first open of a store initSchema built, a migration), and on
 * damaged pages any write can overwrite rows. A read-only handle writes nothing, not even the
 * checkpoint a read-write handle's close makes. Returns the lines to print when the rebuild must not
 * run, else null; also null when a read-only handle cannot be made at all, which the opener's own
 * error handling then reports as for every other command.
 * @param {string[]} args the command's arguments
 * @param {string} dbPath
 * @returns {string[]|null}
 */
export function ftsRebuildPreCheck(args, dbPath) {
  if (parseArgs(args, { track: false }).positional[0] !== 'rebuild' || !existsSync(dbPath)) return null;
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const pages = checkStorePages(db);
    return pages.state === 'ok' ? null : refusalLines(pages, dbPath);
  } finally {
    db.close();
  }
}

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
    const result = rebuildIndexes(db);
    if (result.errors.length > 0) {
      // Partial success is a failure of the requested operation: the caller asked
      // for a rebuild and at least one index still is not rebuilt.
      out(`[mem] Rebuilt: ${result.rebuilt.join(', ')}. Errors: ${result.errors.join(', ')}`);
      process.exitCode = 1;
    } else {
      out(`[mem] Successfully rebuilt: ${result.rebuilt.join(', ')}`);
    }
  }
}
