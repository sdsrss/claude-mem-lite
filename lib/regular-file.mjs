// lib/regular-file.mjs — read a file only when it is a regular file, and only up to a byte limit.
//
// For paths someone else can occupy: the instruction files above a project (/tmp is writable by
// every local user), and the files inside a project, where a repository can commit a symlink to a
// device (`CLAUDE.md -> /dev/zero`) and a local process can leave a FIFO. A plain readFileSync
// reads a device without end and blocks on a FIFO with no writer; Claude Code itself skips an
// instruction file that is "not a regular file or exceeds 4194304 byte limit" (2.1.322's message).
// A leaf (node:fs only), so a hook or the settings check can take it without a load graph.

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';

/** Claude Code's limit for an instruction file, and the default limit here. */
const INSTRUCTION_FILE_MAX_BYTES = 4194304;

/**
 * A regular file's text, or null for a FIFO, a device or a file over `maxBytes`. Opened
 * non-blocking and checked on the descriptor, so a file swapped in after the check is not the one
 * read. The size fstat reports is no bound — /proc/self/pagemap reports 0 whatever it holds, and a
 * file can grow — so the read stops at the first 64 KiB chunk that takes the total past the limit. A
 * missing path throws ENOENT and a directory EISDIR, as a plain read did.
 * @param {string} p
 * @param {number} [maxBytes]
 * @returns {string|null}
 */
export function readRegularText(p, maxBytes = INSTRUCTION_FILE_MAX_BYTES) {
  const fd = openSync(p, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (st.isDirectory()) throw Object.assign(new Error(`${p}: is a directory`), { code: 'EISDIR' });
    if (!st.isFile() || st.size > maxBytes) return null;
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(65536);
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return null;
      chunks.push(chunk.subarray(0, n));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * readRegularText for a caller that already handles a file it cannot read: throws where that
 * returns null, so the caller's existing handling of an unreadable file applies.
 * @param {string} p
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function readRegularTextOrThrow(p, maxBytes = INSTRUCTION_FILE_MAX_BYTES) {
  const text = readRegularText(p, maxBytes);
  if (text === null) throw new Error(`${p}: not a regular file, or over ${maxBytes} bytes`);
  return text;
}
