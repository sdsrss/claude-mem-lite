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

import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { readSnapshots } from './db-backup.mjs';
import { shellWord, CLI_INVOKE } from '../cli-path.mjs';

/** Marker prefix for lib/record-once.mjs. Per project, like the skew one. */
export const DB_UNUSABLE_MARKER_PREFIX = '.db-unusable-logged-';

// SQLite's own spellings for "this file is not a usable database". Kept here as the single
// definition so install.mjs's doctor check and the hook path classify identically — they used
// to hold one copy each, which is this repo's named twin-drift class.
//
// Deliberately NOT matching "unable to open database file": that is a PERMISSIONS or
// missing-directory failure, whose remedy is nothing like the two below, and answering it
// with "move the file aside" would tell a user to destroy a healthy store.
// "unsupported file format": page 1's schema format number damaged (the round-3 defects review:
// doctor printed ✗ with no step, while repair-db repairs the store).
const UNUSABLE_RE = /not a database|disk image is malformed|unsupported file format/i;
// A row of sqlite_master SQLite cannot parse: every statement fails, so memory is as off as
// with a damaged header. One cause is a damaged row; another is SQL this SQLite's parser does
// not know (reasoned, not reproduced), where restoring a snapshot or setting the file aside is
// wrong. So this family gets repair-db, which reads past such a row and refuses a store from
// another schema version, and after repair-db the snapshot names with no command.
const SCHEMA_UNREADABLE_RE = /malformed database schema/i;

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
 * What to do about a damaged FTS5 INDEX — the query-time half of isFtsCorruptionError.
 *
 * R10 P3-9 wired the classifier into `ensureDbWithWalRecovery`, which rebuilds and retries.
 * That covers OPEN time. A structure record damaged inside the index opens fine — nothing
 * reads it until the first MATCH — so the fault surfaces at QUERY time, and there the two
 * faces that carry it to a reader (the CLI catch-all, the MCP safeHandler) passed SQLite's
 * own sentence through with no next step. `recent` / `recall` / `browse` / `context` never
 * touch FTS and keep answering, which makes that dead end easy to misread as "search found
 * nothing" rather than "search is broken".
 *
 * ONE STRING FOR BOTH CHANNELS, unlike the file-level family below. The split there exists
 * because that remedy OVERWRITES the database and must not be handed ready-to-run to an
 * agent holding Bash. This one re-derives every index from its own content table: the rows
 * are never read from the index, so a rebuild is lossless and idempotent, and `doctor`
 * already runs it unprompted. Naming "intact" is load-bearing — the reading this line
 * exists to prevent is "my memories are corrupt".
 *
 * SCOPE, measured rather than assumed: a damaged index does not always reach the caller as
 * SQLITE_CORRUPT_VTAB. `observations_fts_data` holds three rows on a one-observation store —
 * id=1 (averages), id=10 (the STRUCTURE record) and one leaf page — and which row the damage
 * lands on decides the code. Over 100 trials each:
 *
 *   UPDATE … SET block = randomblob(32) WHERE id > 1   (structure + leaf)  98 VTAB, 2 NOMEM
 *   UPDATE … SET block = randomblob(32) WHERE id > 10  (leaf only)        100 VTAB, 0 NOMEM
 *   DELETE … WHERE id > 10                             (leaf only)        100 VTAB, 0 NOMEM
 *
 * So NOMEM comes from a mangled STRUCTURE record, where SQLite reads a corrupt varint and asks
 * for an absurd allocation — not from leaf damage. (A first draft of this paragraph said
 * "leaf pages", which would send anyone re-measuring `WHERE id > 10` to 0/N and make the
 * boundary below look vacuous. Caught by the pre-ship claims audit.) That case gets no
 * remedy, on purpose:
 * isFtsCorruptionError is what isDbCorruptionError and isDbUnusableError consult, so
 * admitting SQLITE_NOMEM would answer a real out-of-memory with a full FTS rebuild, and
 * would tell a user their index is damaged when it may be their RAM. The code cannot
 * discriminate the two, so this covers the fault it can name.
 * `tests/fts-corruption-query-time-remedy.test.mjs` pins that boundary.
 */
export function ftsCorruptionRemedy(cli) {
  return (
    'The FTS5 search index is damaged; the stored observations are intact. ' +
    `Rebuild it losslessly with \`${cli} fts-check rebuild\` ` +
    `(\`${cli} doctor\` rebuilds it too, and re-checks everything else).`
  );
}

/** The CLI face's wording. Both faces name the CLI by path: the bare command exists only after
 *  an optional global npm install (D#462). */
export const FTS_CORRUPTION_REMEDY = ftsCorruptionRemedy(CLI_INVOKE);

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
  const msg = String(err.message ?? err ?? '');
  return UNUSABLE_RE.test(msg) || SCHEMA_UNREADABLE_RE.test(msg);
}

/** `repair-db` (D#541), named by path like every command these faces print (D#462). */
export const REPAIR_DB_COMMAND = `${CLI_INVOKE} repair-db`;

// SQLite's spelling for a file whose first page it does not recognise.
const NOT_A_DATABASE_RE = /not a database/i;

/**
 * Where a damaged store is kept: `<db>.damaged-<UTC stamp>`, never an existing name. The fixed
 * `<db>.corrupt` this replaced made a second set-aside overwrite the first.
 * @param {string} dbPath
 * @param {() => number} [now]
 */
export function damagedAsidePath(dbPath, now = Date.now) {
  const base = `${dbPath}.damaged-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
  let p = base;
  for (let n = 1; existsSync(p) || existsSync(`${p}-wal`); n++) p = `${base}-${n}`;
  return p;
}

/** Which of SQLite's spellings the failure is: not a database at all, a schema it cannot parse, or damage. */
function familyOf(msg) {
  if (NOT_A_DATABASE_RE.test(msg)) return 'notadb';
  return SCHEMA_UNREADABLE_RE.test(msg) ? 'schema' : 'damaged';
}

/**
 * What the user should actually run.
 *
 * `repair-db`, for every failure this family covers: it reads what SQLite still can, with
 * writable_schema when the schema will not parse and from the main file alone when the log is
 * what breaks the store, writes nothing until its copy is checked, and keeps the store as found.
 * Of the 46 WAL plants where doctor printed `✗ Database`, it printed the set-aside (which keeps
 * 0 rows in the store) on 23 and no command on the other 23; the copy read every table in full on
 * 23 of the 46 in one run (24 in a re-run).
 *
 * `afterRepair` is repair-db's own fallback, for a file it could not read. Three outcomes there,
 * never two — the same rule schema-skew.mjs states: "there is no backup" and "I could not look
 * for one" must not print in the same voice, because a green-sounding line ends the reader's
 * search. Both of its commands give the damaged file and its log a second name before removing
 * the first (D#539: the restore line used to end with "move the broken file aside first", after a
 * command that had already overwritten it), and `ln` refuses an existing name, so running a
 * printed line twice stops at that step instead of moving a newer store over the kept one, which
 * `mv` did. `touch` gives `ln` a log to link when there is none, rather than a shell `if` that
 * fish cannot parse.
 *
 * `snapshotCount` is part of the return rather than something a caller re-derives: a second
 * `readSnapshots` call to recover a number this function already had would be a second
 * directory read that can disagree with the first.
 *
 * A schema SQLite cannot read, after repair-db, gets kind 'schema', which carries no command
 * (see SCHEMA_UNREADABLE_RE).
 *
 * @param {string} dbPath
 * @param {unknown} [err]
 * @param {{afterRepair?: boolean, now?: () => number}} [opts]
 * @returns {{kind: 'repair'|'restore'|'set-aside'|'unknown'|'schema', family: 'notadb'|'schema'|'damaged',
 *   command: string, note: string, snapshotCount: number}}
 */
export function dbUnusableRemedy(dbPath, err, { afterRepair = false, now = Date.now } = {}) {
  const msg = String(err?.message ?? err ?? '');
  const family = familyOf(msg);
  const snap = readSnapshots(dbPath);
  const count = snap.ok ? snap.snapshots.length : 0;
  // Newest by mtime, ties broken by name (which carries an ISO stamp) so the answer is total
  // rather than dependent on readdir order — the D#9 shape.
  const newest = snap.ok
    ? snap.snapshots.slice().sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : -1))[0]
    : undefined;
  if (!afterRepair) {
    return {
      kind: 'repair',
      family,
      command: REPAIR_DB_COMMAND,
      snapshotCount: count,
      note:
        'repair-db copies the rows SQLite can still read into a fresh file, says which tables may have lost ' +
        'rows, and keeps the store as found beside it; if it cannot read the file, it says what to do instead' +
        (newest ? ` (the newest of ${count} backup snapshot(s) is ${newest.path}).` : '.'),
    };
  }
  if (!snap.ok) {
    return {
      kind: family === 'schema' ? 'schema' : 'unknown',
      family,
      command: '',
      snapshotCount: 0,
      note:
        `Could not read ${dirname(dbPath)} to look for a backup snapshot (${snap.reason}) — ` +
        `fix that directory first, then look for ${basename(dbPath)}.*.bak beside the database.`,
    };
  }
  if (family === 'schema') {
    return {
      kind: 'schema',
      family,
      command: '',
      snapshotCount: count,
      note: newest
        ? `${count} backup snapshot(s) exist beside it; the newest is ${newest.path}. ` +
          'Restoring one replaces the database file, so copy the damaged file aside first.'
        : 'No backup snapshot exists beside the database.',
    };
  }
  const aside = damagedAsidePath(dbPath, now);
  const db = shellWord(dbPath);
  const wal = shellWord(`${dbPath}-wal`);
  const keep = [
    `touch ${wal}`,
    `ln ${db} ${shellWord(aside)}`,
    `ln ${wal} ${shellWord(`${aside}-wal`)}`,
    `rm ${db} ${wal}`,
    `rm -f ${shellWord(`${dbPath}-shm`)}`,
  ].join(' && ');
  const keeps =
    `It first gives the file and its log a second name, ${aside} and ${aside}-wal, and only then ` +
    'removes the old names and the -shm index (which holds no rows); run twice, it stops at the first `ln`.';
  if (!newest) {
    return {
      kind: 'set-aside',
      family,
      command: keep,
      snapshotCount: 0,
      note:
        'No backup snapshot exists beside the database. This command sets the damaged file aside so the ' +
        `next session creates a fresh store. ${keeps}`,
    };
  }
  return {
    kind: 'restore',
    family,
    command: `${keep} && cp ${shellWord(newest.path)} ${db}`,
    snapshotCount: count,
    note:
      `This command restores the newest of ${count} backup snapshot(s), ${newest.path}; what was saved ` +
      `after it is not in it. ${keeps}`,
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
    '⚠️ [claude-mem-lite] Memory is OFF: the database file cannot be used.',
    {
      schema: `   ${dbPath} exists but SQLite cannot read its schema.`,
      notadb: `   ${dbPath} exists but SQLite does not recognise it as a database.`,
      damaged: `   ${dbPath} exists but SQLite reports it as damaged.`,
    }[remedy.family ?? (remedy.kind === 'schema' ? 'schema' : 'notadb')],
  ];
  // The note before the command: it says what the command keeps (D#539).
  if (remedy.note) lines.push(`   ${remedy.note}`);
  if (remedy.command) {
    // Before the command: it moves or replaces the database file, under any session still holding
    // the store (D#534). doctor says the same.
    lines.push('   Once every Claude Code session is closed, this one included, run:');
    lines.push(`   ${remedy.command}`);
  }
  lines.push(`   Saves and recall are disabled. \`${CLI_INVOKE} doctor\` re-checks.`);
  return lines.join('\n');
}

/**
 * The same fact, with NO COMMAND IN IT, for the model channel.
 *
 * The schema-skew twin sends one string to both channels and that is safe there — its
 * commands are `git pull` / `claude plugin update` / `npm i -g`. This family's remedies
 * replace or move the database file, and must run with every session closed, the agent's own
 * included; handing a ready-to-run shell line that does that to an agent that has Bash — with
 * no addressee and no "ask first" — is a different proposition.
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
    `   run \`${CLI_INVOKE} doctor\`.`,
  ].join('\n');
}
