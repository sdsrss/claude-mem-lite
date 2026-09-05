// lib/cooldown-path.mjs — the ONE definition of the pre-recall cooldown file's path.
//
// The rule (sanitize the session id, cap it at 64 chars, join it to RUNTIME_DIR under a
// fixed prefix) had three independent copies: scripts/pre-tool-recall.js writes the file,
// lib/cite-back-hint.mjs and lib/edge-attribution.mjs read it. Two of the three carried a
// comment saying the copies MUST agree and that drift silently zeros the surface that
// depends on them — a writer and a reader disagreeing does not error, it just reads a
// file nobody wrote. Only the pre-tool-recall/cite-back pair was pinned by a test; the
// edge-attribution copy, whose drift silently zeros Stop-side attribution, was not.
//
// The original reason for copying (#8447: keep the standalone hook fast-path free of
// imports) was retired by v3.80.0 — scripts/pre-tool-recall.js already imports
// lib/resolve-data-dir.mjs and lib/hook-telemetry.mjs on its startup path. This module is
// two pure functions over `node:path` and adds nothing measurable to that.

import { join } from 'path';

/** Filename prefix. Exported so a sweeper can match the family without re-deriving it. */
export const COOLDOWN_FILE_PREFIX = 'pre-recall-cooldown-';

/**
 * Session id → filesystem-safe key. The 64-char cap and the character class are part of
 * the contract, not defensive hygiene: writer and readers must derive the same name from
 * the same id, so a change here is a change to all three at once.
 *
 * @param {unknown} sessionId
 * @returns {string}
 */
export function cooldownSessionKey(sessionId) {
  return String(sessionId)
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 64);
}

/**
 * Absolute path to a session's pre-recall cooldown file.
 *
 * @param {string} runtimeDir Absolute RUNTIME_DIR.
 * @param {unknown} sessionId Claude Code session id.
 * @returns {string}
 */
export function cooldownPathFor(runtimeDir, sessionId) {
  return join(runtimeDir, `${COOLDOWN_FILE_PREFIX}${cooldownSessionKey(sessionId)}.json`);
}
