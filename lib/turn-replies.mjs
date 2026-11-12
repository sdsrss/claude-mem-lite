// D#825 — each turn's last reply, recorded at Stop under the memory session that answered it, for
// the session summary worker (D19 + D22). Reading the turns back out of the transcript had to
// infer which session a record belonged to, and that inference was wrong on real shapes: 148 of
// 1,939 simulated Stops on the maintainer's transcripts (2026-11-12) took another session's turn
// when cut at compactions alone, 57 still with a time floor (tasks/specs/d825-summary-turn-capture.md).
// Stop knows its own session and is handed the reply (`last_assistant_message`), so here nothing
// is inferred.
//
// One file per memory session in the runtime dir, keyed by prompt number: a turn's later reply
// (a background task's notice answered in the same turn) replaces the earlier one, and replies
// given before the session's first stored prompt (number 0) come first. SessionStart's 24 h
// runtime sweep removes the file; a session that expires (12 h) is summarized well before.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { scrubSecrets } from '../secret-scrub.mjs';
import { atomicWriteFileSync } from './atomic-write.mjs';

export const TURN_REPLIES_PREFIX = 'turn-replies-';

// Code points kept per reply. The longest final reply over 1,939 Stops on the maintainer's
// transcripts was 7,081 (p99.9 5,187; 2026-11-12), and the summary prompt cuts every reply to at
// most 2,000 + 1,000 itself, so the cut only bounds the file.
export const TURN_REPLY_MAX_CHARS = 12000;
const HEAD = (TURN_REPLY_MAX_CHARS * 2) / 3;
const TAIL = TURN_REPLY_MAX_CHARS / 3;

/** The record file of `sessionId`; a long id keeps a hash of the whole id, so its tail still counts. */
export function turnRepliesPath(runtimeDir, sessionId) {
  const id = String(sessionId);
  const safe = id.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const key =
    safe.length <= 120
      ? safe
      : `${safe.slice(0, 80)}-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
  return join(runtimeDir, `${TURN_REPLIES_PREFIX}${key}.json`);
}

/** Scrubbed whole first, so a secret across the cut is never half kept; then cut to head + tail. */
function storedText(reply) {
  const text = scrubSecrets(String(reply ?? '')).trim();
  const points = Array.from(text);
  if (points.length <= TURN_REPLY_MAX_CHARS) return text;
  const omitted = points.length - HEAD - TAIL;
  return `${points.slice(0, HEAD).join('')}\n[… ${omitted} characters omitted …]\n${points.slice(-TAIL).join('')}`;
}

/** [promptNumber, text] pairs from the file, or [] when it is missing, unreadable or of another shape. */
function readPairs(file) {
  try {
    const turns = JSON.parse(readFileSync(file, 'utf8'))?.turns;
    if (!Array.isArray(turns)) return [];
    return turns.filter(
      (t) => Array.isArray(t) && Number.isInteger(t[0]) && t[0] >= 0 && typeof t[1] === 'string' && t[1],
    );
  } catch {
    return [];
  }
}

/**
 * Record `reply` as the last reply of prompt `promptNumber` in `sessionId` (0 before the first
 * stored prompt). A blank reply records nothing. Never throws.
 * @returns {boolean} whether the file was written
 */
export function recordTurnReply(runtimeDir, sessionId, promptNumber, reply) {
  if (!sessionId || !Number.isInteger(promptNumber) || promptNumber < 0) return false;
  const text = storedText(reply);
  if (!text) return false;
  // The runtime dir is not created here: a Stop racing an uninstall must not bring it back.
  if (!existsSync(runtimeDir)) return false;
  const file = turnRepliesPath(runtimeDir, sessionId);
  const turns = new Map(readPairs(file));
  turns.set(promptNumber, text);
  try {
    atomicWriteFileSync(file, JSON.stringify({ turns: [...turns].sort((a, b) => a[0] - b[0]) }), {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

/** Each turn's last reply in `sessionId`, in prompt order; [] when none was recorded. */
export function readTurnReplies(runtimeDir, sessionId) {
  if (!sessionId) return [];
  // Written in prompt order (recordTurnReply sorts), so read in file order.
  return readPairs(turnRepliesPath(runtimeDir, sessionId)).map((t) => t[1]);
}
