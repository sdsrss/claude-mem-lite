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
// It imports no native binding: its static graph has zero package edges (the only bare
// specifiers anywhere in it are the `node:` builtins). That is the property that
// matters — a classifier the hook path may need while the binding is the broken thing must
// not sit behind a native import. It is NOT as tight as schema-skew.mjs, which imports
// `node:` builtins and nothing else; this one reaches `db-backup → utils → …` for
// `readSnapshots`. Same guarantee, larger graph — do not restate it as "same discipline".

import { spawnSync } from 'node:child_process';
import {
  constants as fsConstants,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSnapshots } from './db-backup.mjs';
import { CODE_DIR } from './data-paths.mjs';
import { SCHEMA_SKEW_CODE } from './schema-skew.mjs';
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
const UNUSABLE_RE = /not a database|disk image is malformed/i;
// A row of sqlite_master SQLite cannot parse: every statement fails, so memory is as off as
// with a damaged header. One cause is a damaged row; another is SQL this SQLite's parser does
// not know (reasoned, not reproduced), where restoring a snapshot or setting the file aside is
// wrong. So this family gets the notice and the snapshot names, and no command.
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
 * because that remedy moves the database file out from under every session and must not be
 * handed ready-to-run to an agent holding Bash. This one re-derives every index from its own content table: the rows
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
 * Why a checked rebuild (schema.mjs rebuildFTS / rebuildIndexes, D#593) committed nothing, as one
 * sentence starting lowercase, for a caller to prefix. 'damaged': the store read damaged inside the
 * rebuild's transaction; otherwise the write could not be made or checked (busy, a failing step).
 * @param {{check: string, errors: string[]}} result
 */
export function notRebuiltReason(result) {
  const last = (result.errors.at(-1) ?? '').replace(/^not rebuilt: /, '');
  return result.check === 'damaged'
    ? `not rebuilt: the store is damaged (${last}), and a rebuild on a damaged store can overwrite rows. Nothing was written.`
    : `not rebuilt: ${last}. Nothing was written.`;
}

/** notRebuiltReason and what to do next, for the CLI and MCP faces. Damage points at the snapshots
 *  (doctor checks them and prints the restore command); anything else at running it again. */
export function notRebuiltText(result) {
  const reason = notRebuiltReason(result);
  const head = reason[0].toUpperCase() + reason.slice(1);
  return result.check === 'damaged'
    ? `${head} Run \`${CLI_INVOKE} doctor\`: it checks the backup snapshots and prints the command that restores the newest one that passes.`
    : `${head} If a session is writing to the store, run it again when it is idle.`;
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
  const msg = String(err.message ?? err ?? '');
  return UNUSABLE_RE.test(msg) || SCHEMA_UNREADABLE_RE.test(msg);
}

/** The child checkSnapshot runs: lib/snapshot-probe.mjs, beside this file. */
const SNAPSHOT_PROBE = join(dirname(fileURLToPath(import.meta.url)), 'snapshot-probe.mjs');
/** checkSnapshot's private directories in the data directory: `<prefix><pid>-XXXXXX`, the pid
 *  being the process that made it. */
const CHECK_DIR_PREFIX = '.snapshot-check-';
const CHECK_DIR_RE = /^\.snapshot-check-(\d+)-[A-Za-z0-9]{6}$/;
/** The probe's run on one copy: open (migrations included), index rebuild, integrity check. The
 *  copy before it is not bounded by this. */
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
/** No check runs this long, so a private directory this old was left by a killed check even when
 *  its pid now names a live process. */
const STALE_CHECK_MS = 24 * 60 * 60 * 1000;
// SQLite codes about the check's own copy rather than about the snapshot: the copy lives in the
// data directory, so a full or failing disk there says nothing about what a restore would give,
// and neither does a path SQLite cannot open (the private directory makes it longer than the
// store's: v6.30.6 r1 defects P3-3).
const CHECK_OWN_CODE_RE = /^SQLITE_(FULL|IOERR|CANTOPEN)/;

function nonEmptyFile(path) {
  try {
    const st = statSync(path);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * What restoring the snapshot at `path` would give (D#558). The snapshot is copied into a private
 * directory beside it, with its own `-wal` when it has a non-empty one (a hand-made `cp` of a live
 * store), and lib/snapshot-probe.mjs opens the copy in a child process with the opener every
 * product face uses, rebuilds its indexes as the restore command's last step (`fts-check rebuild`)
 * does, then runs SQLite's integrity check and counts observations. The directory is removed
 * before this returns.
 *
 * - `ok`: the copy opens, its indexes rebuild, it passes the integrity check, and it holds
 *   `observations`, or `otherRows` in the other tables a user's rows live in (at least one);
 * - `empty`: the same with no row in either, so restoring it gives what a fresh store gives;
 * - `bad`: the product's opener throws on it (`why: 'open'`), an index does not rebuild
 *   (`why: 'rebuild'`), or the integrity check fails or throws (`why: 'integrity'`), `reason`
 *   saying how;
 * - `unchecked`: the check itself could not run (the copy, the child, a full or failing disk, a
 *   copy SQLite cannot open, whichever step met it), or the snapshot was written by a newer
 *   claude-mem-lite, `reason` saying why and `where` naming the directory when making the private
 *   one failed.
 *
 * `listed`, when present, is how many observations the copy's own index listed before the rebuild,
 * more than its table holds after it: the table lost rows, or the index kept entries for rows a
 * delete removed. The restore gives what the table holds; doctor prints both numbers.
 *
 * `withLog` says whether the snapshot's own `-wal` was part of the copy, so the restore command
 * copies it too. The first attempt checked the file itself with integrity_check, which rejects a
 * snapshot whose damage an index rebuild repairs, and could not read a file over 2 GiB; this one
 * checks what a restore gives.
 *
 * @param {string} path
 * @param {{probe?: string, timeoutMs?: number}} [opts] `probe` replaces the child script (tests)
 * @returns {{verdict: 'ok'|'empty'|'bad'|'unchecked', withLog: boolean, observations?: number, otherRows?: number, listed?: number, why?: 'open'|'rebuild'|'integrity', reason?: string, where?: string}}
 */
export function checkSnapshot(path, { probe = SNAPSHOT_PROBE, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  let dir = null;
  let withLog = false;
  const unchecked = (reason) => ({ verdict: 'unchecked', withLog, reason });
  const bad = (why, reason) => ({ verdict: 'bad', withLog, why, reason: String(reason).slice(0, 200) });
  try {
    try {
      dir = mkdtempSync(join(dirname(path), `${CHECK_DIR_PREFIX}${process.pid}-`));
    } catch (e) {
      return { ...unchecked(e?.code || e?.message || 'unwritable'), where: dirname(path) };
    }
    const copy = join(dir, 'claude-mem-lite.db');
    // FICLONE: a reflink where the filesystem has them, a plain streamed copy elsewhere.
    copyFileSync(path, copy, fsConstants.COPYFILE_FICLONE);
    withLog = nonEmptyFile(`${path}-wal`);
    if (withLog) copyFileSync(`${path}-wal`, `${copy}-wal`, fsConstants.COPYFILE_FICLONE);
    // The copy takes the snapshot's mode, and a read-only one opened read-only and read as damage
    // (v6.30.6 r1 defects P2-3); the restore command makes the restored store writable the same way.
    for (const f of withLog ? [copy, `${copy}-wal`] : [copy]) chmodSync(f, 0o600);
    // SQLite's sort files and Node's temporary files go into the private directory too, so a full
    // /tmp is not read as the snapshot's (v6.30.6 r1 defects P3-4). So does the home directory:
    // an opener that finds no store moves one from ~/claude-mem-lite (v6.30.8 r1 defects F7).
    const r = spawnSync(process.execPath, [probe], {
      env: {
        ...process.env,
        CLAUDE_MEM_DIR: dir,
        SQLITE_TMPDIR: dir,
        TMPDIR: dir,
        HOME: dir,
        USERPROFILE: dir,
      },
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error) {
      if (r.error.code === 'ETIMEDOUT') return unchecked(`ETIMEDOUT, over ${elapsed(timeoutMs)}`);
      return unchecked(r.error.code || r.error.message);
    }
    let out = null;
    try {
      out = JSON.parse(String(r.stdout).trim().split('\n').pop());
    } catch {
      /* no result line: the probe did not run to its end */
    }
    if (r.status !== 0 || !out || typeof out !== 'object') {
      const how = r.signal ? `probe killed by ${r.signal}` : `probe exited ${r.status}`;
      // The error line, not the first one: Node prints a source location above a load failure.
      const lines = String(r.stderr)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const said = (lines.find((l) => /^\w*Error\b/.test(l)) ?? lines[0] ?? '').slice(0, 200);
      return unchecked(said ? `${how}: ${said}` : how);
    }
    const rebuildErrors = Array.isArray(out.rebuildErrors) ? out.rebuildErrors : [];
    const own = [out.error, ...rebuildErrors].find((e) => CHECK_OWN_CODE_RE.test(e?.code ?? ''));
    if (own) return unchecked(own.code);
    // This version refuses a store a newer one wrote, which says nothing about the snapshot; an
    // older snapshot named past it could hold less (v6.30.6 r1 defects P2-1).
    if (out.error?.code === SCHEMA_SKEW_CODE) {
      return unchecked('written by a newer claude-mem-lite; update claude-mem-lite, then run doctor again');
    }
    if (out.error && !out.opened) return bad('open', out.error.code || out.error.message);
    // A rebuild that could not be made or checked wrote nothing and says nothing about the snapshot:
    // decided by its state, not guessed from a code (D#593, condition 3 of its first attempt).
    if (out.rebuildCheck === 'unchecked')
      return unchecked(rebuildErrors.at(-1)?.message ?? 'rebuild not checked');
    if (rebuildErrors.length > 0) return bad('rebuild', rebuildErrors[0].message);
    if (out.error) return bad('integrity', out.error.code || out.error.message);
    if (out.integrity !== 'ok') return bad('integrity', out.integrity);
    const otherRows = Number.isInteger(out.otherRows) ? out.otherRows : 0;
    const passed = {
      verdict: out.observations > 0 || otherRows > 0 ? 'ok' : 'empty',
      withLog,
      observations: out.observations,
      otherRows,
    };
    if (Number.isInteger(out.listed) && out.listed > out.observations) passed.listed = out.listed;
    return passed;
  } catch (e) {
    return unchecked(e?.code || e?.message || 'unreadable');
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* left behind: sweepSnapshotChecks removes it once this process has exited */
      }
    }
  }
}

function elapsed(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

/** Whether `pid` names a running process (EPERM: one this user may not signal, still running). */
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * Remove the private directories checkSnapshot leaves when it is killed mid-check (each holds a
 * full copy of a snapshot): those whose process has exited, and any older than a check can run
 * (its pid may name another process by then). A doctor checking in another terminal keeps its
 * own. Only directories named exactly as checkSnapshot names them; never a link. doctor calls
 * this before its database check, healthy store or not, so a copy left by an interrupted check
 * goes on the next doctor run even once the store is restored.
 * @param {string} dir the data directory
 * @param {{nowMs?: number}} [opts]
 */
export function sweepSnapshotChecks(dir, { nowMs = Date.now() } = {}) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const m = CHECK_DIR_RE.exec(n);
    if (!m) continue;
    const full = join(dir, n);
    try {
      const st = lstatSync(full);
      if (!st.isDirectory()) continue;
      if (running(Number(m[1])) && nowMs - st.mtimeMs < STALE_CHECK_MS) continue;
      rmSync(full, { recursive: true, force: true });
    } catch {
      /* raced away, or not ours to remove */
    }
  }
}

/**
 * The CLI, run against `dbPath`'s data directory. A relocated one gets a `CLAUDE_MEM_DIR=` prefix,
 * since it may be set only in Claude Code's environment; the default one gets none, which
 * PowerShell, cmd and csh cannot run (v6.30.6 r1 defects P3-7), so there a CLAUDE_MEM_DIR the
 * shell exports for another store wins.
 */
function cliFor(dbPath, args) {
  const dir = dirname(dbPath);
  return dir === CODE_DIR
    ? `${CLI_INVOKE} ${args}`
    : `CLAUDE_MEM_DIR=${shellWord(dir)} ${CLI_INVOKE} ${args}`;
}

function doctorCommand(dbPath) {
  return cliFor(dbPath, 'doctor');
}

/**
 * What the user should actually run. Three outcomes, never two — the same rule schema-skew.mjs
 * states: "there is no backup" and "I could not look for one" must not print in the same
 * voice, because a green-sounding line ends the reader's search.
 *
 * A snapshot goes into a command only after `check` (doctor passes checkSnapshot) calls it `ok`,
 * newest first: `bad` and `empty` ones are passed over and counted; one the check could not run on
 * before any passes stops the walk with no command (kind 'unknown', or 'schema'), since an older
 * snapshot named past it could hold less. The command restores the newest that passes; every older
 * snapshot is checked as well, and each that passes is listed in `found` with its counts and given
 * its own command in `alternatives`, newest first (D#577). Without `check` (the SessionStart notice, which must not copy and open every
 * candidate on each session start while the store is broken) no snapshot goes into a command:
 * kind 'unknown' counts them and points at doctor, the kind every version's doctor renders as its
 * note (a killed update can leave an older install.mjs beside this file). None `ok`, or none at
 * all: the set-aside. Only regular files count as snapshots: a directory or a device named like
 * one is not a copy of anything, and copying it fails. Every doctor named in a note carries a
 * relocated data directory, which the shell the user runs it from may not (cliFor).
 *
 * Both commands keep every byte they replace (D#539): the broken file and its `-wal` move to
 * `keptAs` and `keptAs-wal`, the names SQLite pairs, and only the `-shm` is deleted. The restore
 * ends with `fts-check rebuild`, the step the check ran after the product's open. Each starts
 * with a guard so running it a second time stops before overwriting the first kept copy, and
 * `touch` gives `mv` a log to move when there is none (an empty `-wal` reads as no log).
 * Chained with `&&` only: fish has no `{ }` grouping. The kept name carries the broken file's
 * mtime, not the clock, so every doctor run on one broken file prints the same command (and the
 * --json face matches the human one); a later broken file gets another name. When that name or its
 * `-wal` already exists (a kept file moved back keeps its mtime) a `-1`, `-2`, … is added, so the
 * command doctor prints never stops at its own guard.
 *
 * `found` is the sentence about the snapshots, which doctor puts in front of its own command
 * sentence; `note` is what the SessionStart notice prints. `snapshotCount` counts the non-empty
 * snapshots, so a caller does not re-read the directory for it.
 *
 * `err`, when given, picks the family: a schema SQLite cannot read gets kind 'schema', which
 * carries no command (see SCHEMA_UNREADABLE_RE).
 *
 * @param {string} dbPath
 * @param {unknown} [err]
 * @param {{check?: (path: string) => ReturnType<typeof checkSnapshot>, stampMs?: number}} [opts]
 *   `stampMs` replaces the broken file's mtime in the kept name (tests)
 * @returns {{kind: 'restore'|'set-aside'|'unknown'|'schema', command: string, keptAs: string, found: string, note: string, snapshotCount: number, alternatives?: Array<{path: string, command: string}>}}
 */
export function dbUnusableRemedy(dbPath, err, { check, stampMs } = {}) {
  const schema = SCHEMA_UNREADABLE_RE.test(String(err?.message ?? err ?? ''));
  let stamp = stampMs;
  if (stamp === undefined) {
    try {
      stamp = statSync(dbPath).mtimeMs;
    } catch {
      stamp = Date.now();
    }
  }
  const keptBase = `${dbPath}.corrupt-${new Date(Math.floor(stamp)).toISOString().replace(/[:.]/g, '-')}`;
  let keptAs = keptBase;
  for (let i = 1; existsSync(keptAs) || existsSync(`${keptAs}-wal`); i++) keptAs = `${keptBase}-${i}`;
  const setAsideCommand = [
    `test ! -e ${shellWord(keptAs)}`,
    `test ! -e ${shellWord(`${keptAs}-wal`)}`,
    `rm -f ${shellWord(`${dbPath}-shm`)}`,
    `touch ${shellWord(`${dbPath}-wal`)}`,
    `mv ${shellWord(dbPath)} ${shellWord(keptAs)}`,
    `mv ${shellWord(`${dbPath}-wal`)} ${shellWord(`${keptAs}-wal`)}`,
  ].join(' && ');
  const keeps = `as ${keptAs} and ${keptAs}-wal`;
  const noCommand = (kind, found, note = found, snapshotCount = 0) => ({
    kind,
    command: '',
    keptAs: '',
    snapshotCount,
    found,
    note,
  });
  const snap = readSnapshots(dbPath);
  if (!snap.ok) {
    const found =
      `Could not read ${dirname(dbPath)} to look for a backup snapshot (${snap.reason}) — ` +
      `fix that directory first, then look for ${basename(dbPath)}.*.bak beside the database.`;
    return noCommand(schema ? 'schema' : 'unknown', found);
  }
  // A 0-byte `.bak` is what a failed snapshot of a damaged store left before 6.30.4 (D#551),
  // usually the newest one; it is not a copy of anything. Newest first by mtime, ties broken by
  // path so the order is total rather than readdir's — the D#9 shape.
  const files = snap.snapshots.filter((s) => s.isFile);
  const snapshots = files
    .filter((s) => s.size > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : -1));
  const empty = files.length - snapshots.length;
  const skipped = empty > 0 ? ` (${empty} empty .bak file${empty === 1 ? '' : 's'} skipped)` : '';
  const count = `${snapshots.length} backup snapshot(s) beside the database${skipped}`;
  const setAside = (found) => ({
    kind: 'set-aside',
    command: setAsideCommand,
    keptAs,
    snapshotCount: snapshots.length,
    found,
    note: `${found} That command moves the broken file and its log aside, ${keeps}, so a fresh store is created on the next session.`,
  });
  if (snapshots.length === 0) {
    const found =
      empty > 0
        ? `No backup snapshot beside the database holds any data${skipped}.`
        : 'No backup snapshot exists beside the database.';
    return schema ? noCommand('schema', found) : setAside(found);
  }
  if (!check) {
    const found = `${snapshots.length} backup snapshot(s) exist beside the database${skipped}.`;
    const checks = schema
      ? 'checks which ones restore'
      : 'checks which ones restore before it gives a command';
    const note = `${found} \`${doctorCommand(dbPath)}\` ${checks}.`;
    return noCommand(schema ? 'schema' : 'unknown', found, note, snapshots.length);
  }
  // doctor prints which one it is checking: a large snapshot takes seconds (v6.30.6 r1 defects P3-2).
  const ask = (i) => check(snapshots[i].path, { nth: i + 1, of: snapshots.length });
  const reject = (counts, r) => {
    counts[r.verdict === 'empty' ? 'empty' : r.why === 'rebuild' || r.why === 'integrity' ? r.why : 'open'] +=
      1;
  };
  const rejectedText = (counts) =>
    [
      counts.open && `${counts.open} ${counts.open === 1 ? 'does' : 'do'} not open`,
      counts.rebuild && `${counts.rebuild} ${counts.rebuild === 1 ? 'fails' : 'fail'} the index rebuild`,
      counts.integrity &&
        `${counts.integrity} ${counts.integrity === 1 ? 'fails' : 'fail'} the integrity check`,
      counts.empty && `${counts.empty} ${counts.empty === 1 ? 'holds' : 'hold'} no rows`,
    ]
      .filter(Boolean)
      .join(', ');
  const rejected = { open: 0, rebuild: 0, integrity: 0, empty: 0 };
  let at = 0;
  let result;
  for (; at < snapshots.length; at++) {
    result = ask(at);
    if (result.verdict === 'ok' || result.verdict === 'unchecked') break;
    reject(rejected, result);
  }
  const why = rejectedText(rejected);
  if (at === snapshots.length) {
    const found = `None of the ${count} restores cleanly (${why}).`;
    return schema ? noCommand('schema', found, found, snapshots.length) : setAside(found);
  }
  const passedOver =
    at === 0
      ? ''
      : `Of the ${count}, the newest ${at === 1 ? 'one does' : `${at} do`} not restore cleanly (${why}); the next one`;
  if (result.verdict === 'unchecked') {
    const found = `${passedOver || `The newest of the ${count}`} could not be checked (${result.reason}): ${result.where ?? snapshots[at].path}.`;
    const note = `${found} Once that is resolved, run \`${doctorCommand(dbPath)}\` again; no snapshot goes into a command before then.`;
    return noCommand(schema ? 'schema' : 'unknown', found, note, snapshots.length);
  }
  // The command restores the newest snapshot that passes, and every older one is checked too, so
  // each that passes is listed with its counts before the command and given its own (D#577). The
  // fourth attempt named an older one when the newest was short of its own index (`listed`), but
  // that shape has two causes: the table lost rows, or a delete's write to an index page was lost
  // and the index still lists the rows the user removed (v6.30.7 r1 claims P2-1). Doctor chooses
  // by age alone, as the established tools do, and the user chooses between them with the numbers
  // in front of them (the survey in docs/audits, 2026-10-24). One the check cannot run on is named
  // with its reason; the command restores a snapshot newer than it, so it passes over nothing newer.
  const older = [];
  const olderUnchecked = [];
  const olderRejected = { open: 0, rebuild: 0, integrity: 0, empty: 0 };
  for (let j = at + 1; j < snapshots.length; j++) {
    const r = ask(j);
    if (r.verdict === 'ok') older.push({ path: snapshots[j].path, result: r });
    else if (r.verdict === 'unchecked') olderUnchecked.push(`${r.where ?? snapshots[j].path} (${r.reason})`);
    else reject(olderRejected, r);
  }
  const holds = (r) =>
    `${r.observations} observation(s)${r.observations === 0 && r.otherRows ? ` and ${r.otherRows} other row(s)` : ''}`;
  const what = `a copy of it, restored with its indexes rebuilt the way the command does it, opens in this version, passes SQLite's integrity check and holds ${holds(result)}${result.listed ? `, ${result.listed - result.observations} fewer than its own index lists` : ''}`;
  const restores = result.listed ? 'restores, but short' : passedOver ? 'does' : 'restores cleanly';
  let found = `${passedOver || `The newest of the ${count}`} ${restores}: ${what}.`;
  if (result.listed) {
    found +=
      ' Short of its own index means its table lost those rows or its index still lists rows a delete removed.';
  }
  if (older.length > 0) {
    const each = older.map(
      ({ path, result: r }) => `${path}, ${holds(r)}${r.listed ? ` (its index lists ${r.listed})` : ''}`,
    );
    found += ` ${older.length === 1 ? 'An older snapshot also restores' : `${older.length} older snapshots also restore`}: ${each.join('; ')}.`;
    if (older.some(({ result: r }) => r.observations > result.observations)) {
      found += ` ${older.length === 1 ? 'It holds' : 'One of them holds'} more observations than the one the command restores.`;
    }
    found +=
      ' Restoring an older one instead loses what was written after it was taken and brings back what was deleted since.';
  }
  if (olderUnchecked.length > 0) {
    found += ` ${olderUnchecked.length === 1 ? 'An older snapshot' : `${olderUnchecked.length} older snapshots`} could not be checked: ${olderUnchecked.join('; ')}.`;
  }
  const olderWhy = rejectedText(olderRejected);
  if (olderWhy) found += ` Of the older ones, ${olderWhy}.`;
  // The restore puts the snapshot (and its own -wal, when the check used one) in place writable, as
  // the check's copy was, then rebuilds the indexes as the check did. `test -s` first: with the
  // snapshot gone, nothing moves (v6.30.6 r1 defects P3-5).
  const restoreCommand = (path, withLog) => {
    const db = shellWord(dbPath);
    const wal = shellWord(`${dbPath}-wal`);
    return [
      `test -s ${shellWord(path)}`,
      ...(withLog ? [`test -s ${shellWord(`${path}-wal`)}`] : []),
      setAsideCommand,
      `cp ${shellWord(path)} ${db}`,
      `chmod 600 ${db}`,
      ...(withLog ? [`cp ${shellWord(`${path}-wal`)} ${wal}`, `chmod 600 ${wal}`] : []),
      // The rebuild is part of what the check vouched for: an FTS5 index whose damage FTS5's own
      // check does not see (a shadow table's rows out of key order), and an ordinary index whose
      // entries no longer match its table, both pass doctor and fail integrity_check until rebuilt.
      cliFor(dbPath, 'fts-check rebuild'),
    ].join(' && ');
  };
  const named = snapshots[at].path;
  if (schema) {
    const note = `${found} It is ${named}. Restoring it replaces the database file, so copy the broken file aside first.`;
    return noCommand('schema', found, note, snapshots.length);
  }
  // Each starts with the same set-aside, so once one has run every other stops at its guard.
  const alternatives = older.map(({ path, result: r }) => ({
    path,
    command: restoreCommand(path, r.withLog),
  }));
  return {
    kind: 'restore',
    command: restoreCommand(named, result.withLog),
    keptAs,
    snapshotCount: snapshots.length,
    found,
    note: `${found} The command keeps the broken file and its log ${keeps}, and rebuilds the store's indexes.`,
    alternatives,
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
    remedy.kind === 'schema'
      ? `   ${dbPath} exists but SQLite cannot read its schema.`
      : `   ${dbPath} exists but SQLite does not recognise it as a database.`,
  ];
  if (remedy.command) {
    // Before the command: it moves the database file and its -wal aside and deletes the -shm,
    // under any session still holding the store (D#534). doctor says the same.
    lines.push('   Once every Claude Code session is closed, this one included, run:');
    lines.push(`   ${remedy.command}`);
  }
  if (remedy.note) lines.push(`   ${remedy.note}`);
  lines.push(`   Saves and recall are disabled. \`${doctorCommand(dbPath)}\` re-checks.`);
  return lines.join('\n');
}

/**
 * The same fact, with NO COMMAND IN IT, for the model channel.
 *
 * The schema-skew twin sends one string to both channels and that is safe there — its
 * commands are `git pull` / `claude plugin update` / `npm i -g`. This family's remedy moves the
 * database file and its log out from under every session and copies a snapshot into place, which
 * is safe only once every Claude Code session is closed, and handing that as a ready-to-run shell
 * line to an agent that has Bash, from inside one of those sessions, with no addressee and no
 * "ask first", is a different proposition.
 *
 * So the human gets the command and the model gets the situation. Both still learn memory is
 * off, which is the point of using both channels at all.
 *
 * @param {string} [dbPath] absent when an update killed partway left a hook.mjs from 6.30.7 or
 *   earlier beside this file (it calls this with no argument)
 * @returns {string}
 */
export function formatDbUnusableModelNotice(dbPath) {
  return [
    '⚠️ [claude-mem-lite] Memory is OFF for this session: the database file is unreadable.',
    '   Saves and recall are disabled. Do not attempt to repair it yourself — tell the user to',
    `   run \`${dbPath ? doctorCommand(dbPath) : `${CLI_INVOKE} doctor`}\`.`,
  ].join('\n');
}
