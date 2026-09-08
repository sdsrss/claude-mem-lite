// Units for lib/db-unusable.mjs and lib/record-once.mjs.
// tests/db-unusable-wiring.test.mjs proves anything CALLS them.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isDbUnusableError,
  dbUnusableRemedy,
  formatDbUnusableNotice,
  formatDbUnusableModelNotice,
  DB_UNUSABLE_MARKER_PREFIX,
} from '../lib/db-unusable.mjs';
import { shouldRecordOnce, RELOG_INTERVAL_MS } from '../lib/record-once.mjs';

const dirs = [];
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

describe('isDbUnusableError', () => {
  it.each([
    ['file is not a database', true],
    ['SqliteError: file is not a database', true],
    ['database disk image is malformed', true],
    ['DISK IMAGE IS MALFORMED', true],
  ])('classifies %j as unusable=%s', (msg, expected) => {
    expect(isDbUnusableError(new Error(msg))).toBe(expected);
    expect(isDbUnusableError(msg), 'a bare string reaches recordHookError too').toBe(expected);
  });

  // The discriminator that matters, and the reason the regex is not just /database/: these
  // are a PERMISSIONS or missing-directory failure whose remedy is nothing like "move the
  // file aside". Answering them with the corruption remedy would tell a user to destroy a
  // healthy store — and "unable to open database file" is the message a read-only or absent
  // data dir produces, which is a far more common accident than corruption.
  it.each([
    ['unable to open database file'],
    ['SQLITE_CANTOPEN: unable to open database file'],
    ['EACCES: permission denied'],
    ['DB schema is v999 but this claude-mem-lite binary supports up to v49'],
    ['Cannot find module better_sqlite3.node'],
  ])('does NOT classify %j as unusable', (msg) => {
    expect(isDbUnusableError(new Error(msg))).toBe(false);
  });

  // THE ONE THAT DESTROYS DATA IF IT IS WRONG. SQLite reports a damaged FTS5 INDEX over an
  // otherwise healthy file as SQLITE_CORRUPT_VTAB, whose message text is byte-identical to
  // the file-level fault — so the code is the only thing separating them, and schema.mjs's
  // own docblock says "matching on message alone is what conflated them" (R10 P3-9). The
  // first cut of this classifier matched on message alone and reintroduced the conflation on
  // a new surface: the remedy for a VTAB error would have been `cp <old snapshot> <db>`,
  // overwriting a database whose rows are all intact. The right remedy is rebuildFTS, which
  // ensureDbWithWalRecovery already runs.
  it('does NOT classify a damaged FTS index (SQLITE_CORRUPT_VTAB) as an unusable file', () => {
    const vtab = Object.assign(new Error('database disk image is malformed'), {
      code: 'SQLITE_CORRUPT_VTAB',
    });
    expect(isDbUnusableError(vtab)).toBe(false);
    // The control: the same message WITHOUT the VTAB code is a real file-level fault.
    expect(isDbUnusableError(new Error('database disk image is malformed'))).toBe(true);
  });

  it('agrees with schema.mjs, which owns the file-vs-index distinction', async () => {
    // One definition, not two: a second copy of the VTAB rule is the twin-drift class this
    // repo keeps paying for. Pinned so a future edit to either side turns this red.
    const { isDbCorruptionError, isFtsCorruptionError } = await import('../schema.mjs');
    const vtab = Object.assign(new Error('database disk image is malformed'), {
      code: 'SQLITE_CORRUPT_VTAB',
    });
    expect(isFtsCorruptionError(vtab)).toBe(true);
    expect(isDbCorruptionError(vtab), 'schema.mjs excludes it from the file-level family').toBe(false);
    expect(isDbUnusableError(vtab), 'and so must this one').toBe(false);
  });

  it('is total on the shapes recordHookError accepts', () => {
    for (const v of [null, undefined, 0, '', {}, []]) {
      expect(() => isDbUnusableError(v)).not.toThrow();
      expect(isDbUnusableError(v)).toBe(false);
    }
  });
});

describe('dbUnusableRemedy', () => {
  it('offers set-aside when no snapshot exists, and says so rather than staying vague', () => {
    const dir = tmp('rem-none-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    const r = dbUnusableRemedy(db);
    expect(r.kind).toBe('set-aside');
    expect(r.snapshotCount).toBe(0);
    expect(r.command).toContain(`mv "${db}" "${db}.corrupt"`);
    expect(r.command, 'stale WAL/SHM would resurrect the broken state').toContain(`${db}-wal`);
  });

  it('offers restore, naming the NEWEST snapshot, when one exists', () => {
    const dir = tmp('rem-snap-');
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    // Distinct mtimes so "newest" is decided by the field the code sorts on, not by luck.
    writeFileSync(`${db}.2026-09-01.bak`, 'a');
    writeFileSync(`${db}.2026-09-07.bak`, 'b');
    const older = `${db}.2026-09-01.bak`;
    const newer = `${db}.2026-09-07.bak`;
    const now = Date.now();
    utimesSync(older, now / 1000 - 1000, now / 1000 - 1000);
    utimesSync(newer, now / 1000, now / 1000);
    const r = dbUnusableRemedy(db);
    expect(r.kind).toBe('restore');
    expect(r.snapshotCount).toBe(2);
    expect(r.command).toContain(newer);
    expect(r.command).not.toContain(older);
  });

  // Three outcomes, never two — "there is no backup" and "I could not look" must not print in
  // the same voice, which is the rule lib/schema-skew.mjs states and the v6.2.0 doctor check
  // broke. Driven with a path whose parent is a FILE, so readdirSync fails with ENOTDIR.
  it('says "could not look" rather than "no backup" when the directory is unreadable', () => {
    const dir = tmp('rem-unread-');
    const notADir = join(dir, 'blocker');
    writeFileSync(notADir, 'x');
    const r = dbUnusableRemedy(join(notADir, 'claude-mem-lite.db'));
    expect(r.kind).toBe('unknown');
    expect(r.command, 'a command we cannot justify must not be printed').toBe('');
    expect(r.note).toMatch(/Could not read/);
    expect(r.note).not.toMatch(/No backup snapshot exists/);
  });
});

describe('the two notices', () => {
  const db = '/tmp/x/claude-mem-lite.db';
  const restore = {
    kind: 'restore',
    command: `rm -f "${db}-wal" "${db}-shm" && cp "${db}.v1.bak" "${db}"`,
    snapshotCount: 1,
    note: 'Restores the newest of 1 backup snapshot(s).',
  };

  it('the human notice carries the path, the command and the note', () => {
    const out = formatDbUnusableNotice({ dbPath: db, remedy: restore });
    expect(out).toMatch(/Memory is OFF/);
    expect(out).toContain(db);
    expect(out).toContain(restore.command);
    expect(out).toContain(restore.note);
  });

  it('renders without a command when there is none to give', () => {
    const out = formatDbUnusableNotice({
      dbPath: db,
      remedy: { kind: 'unknown', command: '', snapshotCount: 0, note: 'Could not read /tmp/x' },
    });
    expect(out).toMatch(/Memory is OFF/);
    expect(out).toContain('Could not read');
    // No stray blank remedy line where the command would have been.
    expect(out.split('\n').every((l) => l.trim().length > 0)).toBe(true);
  });

  // The model channel gets the FACT, never the command — this family's remedy overwrites the
  // database, and an agent holding Bash is not the same audience as a human reading a banner.
  // Asserted here as well as end-to-end so the property survives a refactor of either caller.
  it('the model notice contains no shell command at all', () => {
    const out = formatDbUnusableModelNotice();
    expect(out).toMatch(/Memory is OFF/);
    expect(out).not.toMatch(/rm -f|\bcp\b|\bmv\b|&&/);
    expect(out, 'it must still route the user somewhere').toMatch(/claude-mem-lite doctor/);
  });

  it('the two notices are not the same string', () => {
    // The premise for the wiring test: if these ever converged, the end-to-end assertion that
    // the model channel is command-free would be graded against the human one.
    expect(formatDbUnusableModelNotice()).not.toBe(formatDbUnusableNotice({ dbPath: db, remedy: restore }));
  });
});

describe('shouldRecordOnce', () => {
  it('records the first time and suppresses within the interval', () => {
    const dir = tmp('once-');
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'projA', 'k')).toBe(true);
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'projA', 'k')).toBe(false);
  });

  it('records again once the interval has passed', () => {
    const dir = tmp('once-int-');
    const t0 = Date.now();
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k', { now: t0 })).toBe(true);
    expect(
      shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k', { now: t0 + RELOG_INTERVAL_MS + 1 }),
    ).toBe(true);
  });

  it('keys per project, so one project cannot silence another', () => {
    const dir = tmp('once-proj-');
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'projA', 'k')).toBe(true);
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'projB', 'k')).toBe(true);
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'projA', 'k')).toBe(false);
  });

  it('re-records when the key changes — new information is not the fault already logged', () => {
    const dir = tmp('once-key-');
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k1')).toBe(true);
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k2')).toBe(true);
  });

  it('keeps two prefixes independent, so skew and corruption do not silence each other', () => {
    const dir = tmp('once-prefix-');
    expect(shouldRecordOnce(dir, '.a-', 'p', 'k')).toBe(true);
    expect(shouldRecordOnce(dir, '.b-', 'p', 'k')).toBe(true);
  });

  // FAILS TOWARD RECORDING, and it is total: both properties were paid for by a review round
  // on the skew twin, where the first cut made openDb() itself throw.
  it('records, and does not throw, when the runtime dir cannot be written', () => {
    const dir = tmp('once-ro-');
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const runtime = join(blocker, 'runtime');
    let out;
    expect(() => {
      out = shouldRecordOnce(runtime, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k');
    }).not.toThrow();
    expect(out).toBe(true);
    // And it stays true — an unwritable marker must never become a permanent silence.
    expect(shouldRecordOnce(runtime, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k')).toBe(true);
  });

  it('records when the marker is present but corrupt', () => {
    const dir = tmp('once-corrupt-');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${DB_UNUSABLE_MARKER_PREFIX}p`), '{ not json');
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k')).toBe(true);
    // …and repairs itself, so the flood stops after one line rather than never.
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, 'p', 'k')).toBe(false);
  });

  // The property the extraction briefly lost. `shouldRecordSkew` is called from inside
  // `openDb()`'s catch, whose contract is return-null-never-throw, and moving the key
  // derivation outside the try made a hostile `info` propagate. Pinned on the WRAPPER, not on
  // shouldRecordOnce, because the wrapper is where the derivation lives.
  it('shouldRecordSkew stays TOTAL against an info that throws on access', async () => {
    const { shouldRecordSkew } = await import('../lib/schema-skew.mjs');
    const dir = tmp('once-total-');
    const throwingGetter = {
      get dbVersion() {
        throw new Error('boom');
      },
      binaryVersion: 1,
    };
    const throwingToString = {
      dbVersion: {
        toString() {
          throw new Error('ts');
        },
      },
      binaryVersion: 1,
    };
    // A FRESH dir per input: every hostile shape degrades to the same `?:?` key, so reusing
    // one dir would dedup the 2nd..4th to `false` and the assertion would be about the dedup,
    // not about totality. (It did, on the first run of this case.)
    for (const info of [throwingGetter, throwingToString, null, undefined]) {
      let out;
      expect(() => {
        out = shouldRecordSkew(tmp('once-total-'), 'p', info);
      }, 'nothing called from openDb()s catch may throw').not.toThrow();
      expect(out).toBe(true);
    }
    // And the degraded key still dedups on a second call, so totality did not cost the flood
    // control it exists for.
    expect(shouldRecordSkew(dir, 'p', throwingGetter)).toBe(true);
    expect(shouldRecordSkew(dir, 'p', throwingGetter)).toBe(false);
  });

  it('sanitises the project into a single path segment', () => {
    const dir = tmp('once-path-');
    expect(shouldRecordOnce(dir, DB_UNUSABLE_MARKER_PREFIX, '../../etc/passwd', 'k')).toBe(true);
    const written = readFileSync(join(dir, `${DB_UNUSABLE_MARKER_PREFIX}.._.._etc_passwd`), 'utf8');
    expect(JSON.parse(written).key).toBe('k');
  });
});
