// lib/reread-guard.mjs — pure logic + one IO helper for feature ② (repeated-read
// guard). When the agent does a full Read of a file it already read this session
// and the file is unchanged, nudge it to reuse what it has instead of re-slurping.
//
// Imported by the hot standalone scripts/pre-tool-recall.js — stays light, reuses
// the token estimator from ./file-intel.mjs (also pure). Never throws.
//
// False-positive guards (the bit OpenWolf's equivalent omits — its "unless
// modified" lives only in instructions, not the hook):
//   - full-vs-full only: paging with offset/limit never warns
//   - mtime check: a file changed since the prior read never warns
//   - token floor: re-reading a tiny file is cheap, not worth a nudge

import { statSync, openSync, readSync, closeSync } from 'fs';
import { estimateContentTokens, humanTokens } from './file-intel.mjs';

const DEFAULT_MIN_TOKENS = 600;
const DEFAULT_MAX_READ_BYTES = 24 * 1024;

// IO: { mtimeMs, tokens } for an on-disk file, or null. Never throws.
export function readFileMeta(filePath, maxReadBytes = DEFAULT_MAX_READ_BYTES) {
  let st;
  try {
    st = statSync(filePath);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }

  const size = st.size;
  if (size > maxReadBytes) {
    return { mtimeMs: st.mtimeMs, tokens: Math.ceil(size / 4) };
  }
  try {
    const fd = openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(size);
      const n = size > 0 ? readSync(fd, buf, 0, size, 0) : 0;
      return { mtimeMs: st.mtimeMs, tokens: estimateContentTokens(buf.subarray(0, n).toString('utf8')) };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

// Pure: should a repeat read warn? recorded = { mtimeMs, tokens, full }.
export function shouldWarnReread(recorded, currentMtimeMs, isFullRead, minTokens = DEFAULT_MIN_TOKENS) {
  if (!recorded || typeof recorded !== 'object') return false;
  if (!recorded.full || !isFullRead) return false; // only full-vs-full re-reads
  if (!(recorded.tokens >= minTokens)) return false; // big enough to matter
  if (currentMtimeMs === null || currentMtimeMs === undefined) return false;
  return currentMtimeMs <= recorded.mtimeMs; // unchanged since last read
}

// Pure: the warning line (no framing — the hook prepends the shared framing line).
export function buildRereadWarning(basename, tokens) {
  return (
    `[mem] 🔁 You already read ${basename} this session (~${humanTokens(tokens)} tok, unchanged) ` +
    `— reuse what you have instead of re-reading; pass offset/limit if you need a specific part.`
  );
}
