// cli/fts-check.mjs — `claude-mem-lite fts-check <check|rebuild>`.
// Extracted from mem-cli.mjs (v2.41, god-module split).

import { checkFTSIntegrity, rebuildFTS } from '../schema.mjs';
import { parseArgs, out, fail } from './common.mjs';

export function cmdFtsCheck(db, args) {
  const { positional } = parseArgs(args);
  const action = positional[0];
  if (!action) {
    fail('[mem] Usage: claude-mem-lite fts-check <check|rebuild>');
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
    } else {
      out(`[mem] FTS5 issues found:`);
      for (const d of result.details) out(`  ${d}`);
      process.exitCode = 1;
    }
    return;
  }

  if (action === 'rebuild') {
    const result = rebuildFTS(db);
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
