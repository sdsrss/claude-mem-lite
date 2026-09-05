// server/fts-check.mjs — MCP `mem_fts_check` handler.
// Extracted from server.mjs (v2.41, god-module split).
//
// Pure delegate to schema.mjs helpers; Zod filters args.action before we get
// here (see memFtsCheckSchema). No shared state beyond the `db` handle passed
// in from the server-process module scope.

import { checkFTSIntegrity, rebuildFTS } from '../schema.mjs';

/**
 * Handle `mem_fts_check({ action })`. Returns an MCP content wrapper.
 * @param {import('better-sqlite3').Database} db
 * @param {{ action: 'check' | 'rebuild' }} args
 */
export function handleMemFtsCheck(db, args) {
  if (args.action === 'check') {
    const result = checkFTSIntegrity(db);
    return {
      content: [
        {
          type: 'text',
          text: result.healthy
            ? 'FTS5 indexes are healthy — all integrity checks passed.'
            : `FTS5 issues found:\n${result.details.join('\n')}`,
        },
      ],
    };
  }
  // args.action === 'rebuild' (Zod enum enforces one of the two)
  const result = rebuildFTS(db);
  const summary =
    result.errors.length > 0
      ? `Rebuilt: ${result.rebuilt.join(', ')}. Errors: ${result.errors.join(', ')}`
      : `Successfully rebuilt: ${result.rebuilt.join(', ')}`;
  return { content: [{ type: 'text', text: summary }] };
}
