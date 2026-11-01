// server/fts-check.mjs — MCP `mem_fts_check` handler.
// Extracted from server.mjs (v2.41, god-module split).
//
// Pure delegate to schema.mjs helpers; Zod filters args.action before we get
// here (see memFtsCheckSchema). No shared state beyond the `db` handle passed
// in from the server-process module scope.

import { checkFTSIntegrity, rebuildIndexes } from '../schema.mjs';

/**
 * Handle `mem_fts_check({ action })`. Returns an MCP content wrapper.
 * @param {import('better-sqlite3').Database} db
 * @param {{ action: 'check' | 'rebuild' }} args
 */
export function handleMemFtsCheck(db, args) {
  if (args.action === 'check') {
    const result = checkFTSIntegrity(db);
    // A busy store is not a finding: "issues found" invited mem_fts_check rebuild on a healthy
    // store, a long write that blocks the live hooks (E2E 2026-10-16 round 2).
    const text = result.healthy
      ? 'FTS5 indexes are healthy — all integrity checks passed.'
      : result.busy
        ? 'FTS5 check not run — the database is in use by another process. This is not corruption; do not rebuild. Check again when the store is idle.'
        : `FTS5 issues found:\n${result.details.join('\n')}`;
    return { content: [{ type: 'text', text }] };
  }
  // args.action === 'rebuild' (Zod enum enforces one of the two). The FTS5 indexes, then every
  // other index, as `fts-check rebuild` does (D#558).
  const result = rebuildIndexes(db);
  // Refused by the page check (D#593): its reason alone, which carries the advice but no command
  // (the human faces print the copy command; this channel is the model's).
  const summary =
    result.pages.state !== 'ok'
      ? `Not rebuilt: ${result.errors[0].replace(/^not rebuilt: /, '')}`
      : result.errors.length > 0
        ? `Rebuilt: ${result.rebuilt.join(', ')}. Errors: ${result.errors.join(', ')}`
        : `Successfully rebuilt: ${result.rebuilt.join(', ')}`;
  return { content: [{ type: 'text', text: summary }] };
}
