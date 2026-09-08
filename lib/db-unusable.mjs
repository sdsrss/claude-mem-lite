// lib/db-unusable.mjs — the database file is not a usable database.
//
// The sibling of lib/schema-skew.mjs, and it exists for the same reason: the throw is
// correct, and everything downstream of it was missing. Measured 2026-09-08 in a sandboxed
// HOME with a corrupted header:
//
//   • CLI (`search` / `recent` / `stats` / `get` / `save` / `browse` / `fts-check`) — all exit
//     1 with the SQLite message. Correct.
//   • `status` — "⚠ Database: exists but check failed". Correct.
//   • `doctor` — names the file and prints an exact repair command. Correct.
//   • Hooks — `openDb()` returns null, `hook.mjs`'s `const db = openDb(); if (!db) return;`
//     ends SessionStart with EMPTY stdout and EMPTY stderr, and every fire wrote another
//     stack trace to runtime/hook-errors/. Nothing the user sees says memory is off.
//
// State that last figure carefully, because the first draft got it wrong twice over: it said
// "20 fires → 10 identical ~1.5 KB records", which was a MIXED fire set (only some events
// reach this path) reported as if it were 20 SessionStarts, and a size nobody measured.
// Re-measured over 20 SessionStart fires: 20 records, 859-873 bytes each — one per fire, and
// ~1.7x smaller than claimed. `recordHookError` caps the stack at 6 frames and the message at
// 500 chars, so the per-record size is bounded; the unbounded quantity is the COUNT.
//
// So the one surface the user is actually looking at during a session was the only silent
// one, on a condition that never heals by itself. That is the schema-skew shape exactly, and
// this module is deliberately its mirror image so the two cannot drift apart.
//
// It imports no native binding: the static graph is 10 modules and zero package edges (the
// only bare specifiers anywhere in it are the `node:` builtins). That is the property that
// matters — a classifier the hook path may need while the binding is the broken thing must
// not sit behind a native import. It is NOT as tight as schema-skew.mjs, which imports
// `node:` builtins and nothing else; this one reaches `db-backup → utils → …` for
// `readSnapshots`. Same guarantee, larger graph — do not restate it as "same discipline".

import { basename, dirname } from 'node:path';
import { readSnapshots } from './db-backup.mjs';

/** Marker prefix for lib/record-once.mjs. Per project, like the skew one. */
export const DB_UNUSABLE_MARKER_PREFIX = '.db-unusable-logged-';

// SQLite's own spellings for "this file is not a usable database". Kept here as the single
// definition so install.mjs's doctor check and the hook path classify identically — they used
// to hold one copy each, which is this repo's named twin-drift class.
//
// Deliberately NOT matching "unable to open database file": that is a PERMISSIONS or
// missing-directory failure, whose remedy is nothing like the two below, and answering it
// with "move the file aside" would tell a user to destroy a healthy store.
const UNUSABLE_RE = /not a database|disk image is malformed/i;

/**
 * Whether an error is a damaged FTS5 INDEX rather than a damaged database file.
 *
 * THE MESSAGE CANNOT TELL THEM APART. SQLite reports a damaged index as
 * SQLITE_CORRUPT_VTAB with the same "database disk image is malformed" text the file-level
 * faults use, so the code is the only discriminator — and matching on message alone is what
 * conflated them before R10 P3-9. The remedy is rebuildFTS, which the FTS content lets us do
 * losslessly; treating it as file corruption would offer `cp <old snapshot> <db>` over a
 * database whose rows are all intact.
 *
 * This lives HERE rather than in schema.mjs (which re-exports it, so every existing importer
 * is unchanged) because both consumers of the distinction now need it and schema.mjs imports
 * better-sqlite3 — a classifier the hook path may need while the binding is the broken thing
 * must not be behind a native import.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isFtsCorruptionError(err) {
  return /SQLITE_CORRUPT_VTAB/i.test(`${err?.code || ''}`);
}

/**
 * True when `err` means "this file exists and SQLite cannot use it as a database".
 *
 * Accepts anything thrown (Error, string, null) because recordHookError does.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isDbUnusableError(err) {
  if (!err) return false;
  // FIRST, and for the same reason isDbCorruptionError does it first: a damaged index is a
  // HEALTHY FILE, and every remedy below is wrong — and destructive — for one.
  if (isFtsCorruptionError(err)) return false;
  return UNUSABLE_RE.test(String(err.message ?? err ?? ''));
}

/**
 * What the user should actually run. Three outcomes, never two — the same rule schema-skew.mjs
 * states: "there is no backup" and "I could not look for one" must not print in the same
 * voice, because a green-sounding line ends the reader's search.
 *
 * `snapshotCount` is part of the return rather than something a caller re-derives: doctor's
 * sentence names it ("Restore the newest of 2 backup snapshot(s)"), and a second
 * `readSnapshots` call to recover a number this function already had would be a second
 * directory read that can disagree with the first.
 *
 * @param {string} dbPath
 * @returns {{kind: 'restore'|'set-aside'|'unknown', command: string, note: string, snapshotCount: number}}
 */
export function dbUnusableRemedy(dbPath) {
  const clear = `rm -f "${dbPath}-wal" "${dbPath}-shm"`;
  const snap = readSnapshots(dbPath);
  if (!snap.ok) {
    return {
      kind: 'unknown',
      command: '',
      snapshotCount: 0,
      note:
        `Could not read ${dirname(dbPath)} to look for a backup snapshot (${snap.reason}) — ` +
        `fix that directory first, then look for ${basename(dbPath)}.*.bak beside the database.`,
    };
  }
  if (snap.snapshots.length === 0) {
    return {
      kind: 'set-aside',
      command: `${clear} && mv "${dbPath}" "${dbPath}.corrupt"`,
      snapshotCount: 0,
      note:
        'No backup snapshot exists beside the database. That command sets the broken file ' +
        'aside so a fresh store is created on the next session — memories in it are not ' +
        'recoverable without a backup.',
    };
  }
  // Newest by mtime, ties broken by name (which carries an ISO stamp) so the answer is total
  // rather than dependent on readdir order — the D#9 shape.
  const newest = snap.snapshots
    .slice()
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : -1))[0];
  return {
    kind: 'restore',
    command: `${clear} && cp "${newest.path}" "${dbPath}"`,
    snapshotCount: snap.snapshots.length,
    note:
      `Restores the newest of ${snap.snapshots.length} backup snapshot(s). Move the broken ` +
      'file aside first if you want to keep it for inspection.',
  };
}

/**
 * The user-facing block. Short on purpose — at SessionStart it shares one stdout envelope
 * with the startup dashboard and the `<claude-mem-context>` block.
 *
 * @param {{dbPath: string, remedy: ReturnType<typeof dbUnusableRemedy>}} info
 * @returns {string}
 */
export function formatDbUnusableNotice({ dbPath, remedy }) {
  const lines = [
    '⚠️ [claude-mem-lite] Memory is OFF: the database file cannot be opened.',
    `   ${dbPath} exists but SQLite does not recognise it as a database.`,
  ];
  if (remedy.command) lines.push(`   ${remedy.command}`);
  if (remedy.note) lines.push(`   ${remedy.note}`);
  lines.push('   Until then, saves and recall are disabled. `claude-mem-lite doctor` re-checks.');
  return lines.join('\n');
}

/**
 * The same fact, with NO COMMAND IN IT, for the model channel.
 *
 * The schema-skew twin sends one string to both channels and that is safe there — its
 * commands are `git pull` / `claude plugin update` / `npm i -g`. This family's remedy is
 * `rm -f …-wal …-shm && cp "<snapshot>" "<db>"`, which OVERWRITES the database, and handing
 * a ready-to-run irreversible shell line to an agent that has Bash — with no addressee and no
 * "ask first" — is a different proposition. Worse, the restore arm defeats its own advice: a
 * reader who acts on the command line destroys the broken file the next line tells them to
 * keep for inspection.
 *
 * So the human gets the command and the model gets the situation. Both still learn memory is
 * off, which is the point of using both channels at all.
 *
 * @returns {string}
 */
export function formatDbUnusableModelNotice() {
  return [
    '⚠️ [claude-mem-lite] Memory is OFF for this session: the database file is unreadable.',
    '   Saves and recall are disabled. Do not attempt to repair it yourself — tell the user to',
    '   run `claude-mem-lite doctor`, which prints the exact command for their machine.',
  ].join('\n');
}
