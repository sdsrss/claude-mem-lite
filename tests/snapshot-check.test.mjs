// D#558: the restore command names a snapshot only when restoring it gives a store this version
// opens and SQLite's integrity check passes once its indexes are rebuilt the way the command's
// last step (`fts-check rebuild`: the FTS5 indexes, then REINDEX) rebuilds them. The check
// restores a copy into a private directory and opens it in a child process with the product's
// own opener (lib/snapshot-probe.mjs). These cases run the real check, and the printed commands
// in a shell; tests/db-unusable.test.mjs drives the walk with a stub.
//
// The first attempt (v6.30.5, withdrawn at its round-2 review) checked the snapshot FILE with
// integrity_check and rejected snapshots whose only damage was the search index; the 'fts' case
// below is that shape. The second (645de4e2, withdrawn at its r1 review) ignored the rebuild's
// own errors, so a full disk during the rebuild rejected a sound snapshot; and it did no REINDEX,
// so it rejected snapshots whose only damage was an ordinary index (the 'index' case).

import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLI_INVOKE, shellWord } from '../cli-path.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as du from '../lib/db-unusable.mjs';
import { pathWithClaudeStub } from './claude-stub.mjs';
import { makeFixtureTracker, writeStoreSnapshot } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());
const dataDir = () => fixtures.track(mkdtempSync(join(tmpdir(), 'cml-snapcheck-')));
const listing = (dir) => readdirSync(dir).sort();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
/** The pid of a process that has exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const integrityRows = (path) => {
  const copy = join(dataDir(), 'premise.db');
  copyFileSync(path, copy);
  const raw = new Database(copy);
  try {
    return raw.prepare('PRAGMA integrity_check(5)').pluck().all();
  } finally {
    raw.close();
  }
};

describe('checkSnapshot restores a private copy and opens it with the product opener', () => {
  it('passes a sound snapshot and counts its observations, leaving nothing behind', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { observations: 7 });
    const before = listing(dir);
    const r = du.checkSnapshot(snap);
    expect(r).toMatchObject({ verdict: 'ok', observations: 7, withLog: false });
    expect(listing(dir), 'no private directory, -wal or -shm left in the data dir').toEqual(before);
  });

  it('passes a snapshot whose only damage is its search index (round-2 P1-1 of the first attempt)', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { damage: 'fts' });
    // Premise: SQLite's integrity check on the file as it is does fail, on the index alone.
    const copy = join(dataDir(), 'premise.db');
    copyFileSync(snap, copy);
    const raw = new Database(copy);
    const rows = raw.prepare('PRAGMA integrity_check(5)').pluck().all();
    raw.close();
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every((r) => /^fts5: /.test(r)),
      rows.join('\n'),
    ).toBe(true);
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'ok', observations: 12 });
  });

  // r1 claims P2-1 of the second attempt: 269 of the 325 corpus snapshots it rejected passed
  // after a REINDEX.
  it('passes a snapshot whose only damage is an ordinary index, which REINDEX repairs', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { damage: 'index' });
    const rows = integrityRows(snap);
    expect(rows.length, 'premise: integrity_check fails').toBeGreaterThan(0);
    expect(
      rows.every((r) => /index idx_/.test(r)),
      rows.join('\n'),
    ).toBe(true);
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'ok', observations: 12 });
  });

  // D#558's "compare row counts": a snapshot whose indexes list more rows than its table holds.
  // REINDEX makes it consistent, and short; 73 of the 605 corpus snapshots that pass are this shape,
  // each listing exactly the damaged store's count. It still restores cleanly; the result says by
  // how much it is short of its own index.
  it('passes a snapshot that lost rows its indexes still list, and says how many it lists', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), {
      damage: 'lost-rows',
    });
    expect(integrityRows(snap), 'premise').toEqual([expect.stringMatching(/^wrong # of entries in index /)]);
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'ok', observations: 3, listed: 12 });
  });

  // A sound snapshot's index lists exactly what its table holds; a damaged index can list fewer.
  it.each([null, 'index'])(
    'lists nothing extra when its index lists no more than it holds (%s)',
    (damage) => {
      const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'), { damage });
      const r = du.checkSnapshot(snap);
      expect(r).toMatchObject({ verdict: 'ok', observations: 12 });
      expect(r).not.toHaveProperty('listed');
    },
  );

  // main21-112's shape (D#562b): FTS5 refuses the index's config, and no rebuild repairs it.
  it('fails a snapshot whose search index cannot be rebuilt, and names the rebuild', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), {
      damage: 'fts-config',
    });
    const r = du.checkSnapshot(snap);
    expect(r).toMatchObject({ verdict: 'bad', why: 'rebuild' });
    expect(r.reason).toMatch(/observations_fts: invalid fts5 file format/);
  });

  // The restore command ends with `fts-check rebuild`, which refuses on this snapshot, so the
  // check that vouches for the command refuses it too (D#593).
  it('fails a snapshot whose freelist lists a live page, through the real probe', async () => {
    const { writeCrossLinkedStore } = await import('./test-helpers.mjs');
    // The probe's opener writes first on its private copy (the first open of a store initSchema
    // built), so which line the page check meets first varies; the refusal does not.
    const { path } = writeCrossLinkedStore(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'), {
      vacuum: true,
    });
    const r = du.checkSnapshot(path);
    expect(r).toMatchObject({ verdict: 'bad', why: 'rebuild' });
    expect(r.reason).toMatch(/^not rebuilt: the database's pages are damaged/);
  });

  it('records the page check of the rebuild', async () => {
    const { probeOpenedStore } = await import('../lib/snapshot-probe.mjs');
    const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'), {
      damage: 'fts',
    });
    const db = new Database(snap);
    try {
      expect(probeOpenedStore(db).pages).toEqual({ state: 'ok', error: null, code: null });
    } finally {
      db.close();
    }
  });

  // r1 defects P1-1 of the second attempt, on a real rebuild: a page cap stands in for the disk
  // filling up while the rebuild writes.
  it('reports a full disk during the rebuild with its code', async () => {
    const { probeOpenedStore } = await import('../lib/snapshot-probe.mjs');
    const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'), {
      observations: 200,
      damage: 'fts',
    });
    const db = new Database(snap);
    try {
      db.pragma(`max_page_count = ${db.pragma('page_count', { simple: true })}`);
      const r = probeOpenedStore(db);
      expect(r.rebuildErrors).toContainEqual({
        code: 'SQLITE_FULL',
        message: 'observations_fts: database or disk is full',
      });
    } finally {
      db.close();
    }
  });

  // The rebuild's page check is the step that meets the damage first (D#593).
  it('fails a snapshot whose observations table is damaged', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { damage: 'page' });
    expect(du.checkSnapshot(snap)).toMatchObject({
      verdict: 'bad',
      why: 'rebuild',
      reason: expect.stringMatching(
        /^not rebuilt: the database's pages are damaged, .*\(Tree \d+ page \d+ cell/,
      ),
    });
  });

  it('fails a snapshot that is not a database', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { damage: 'header' });
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'bad', why: 'open' });
  });

  it('calls a snapshot with no observations empty', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { observations: 0 });
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'empty', observations: 0 });
  });

  // Round-2 P2-2 of the first attempt: a hand-made copy taken after the store's first checkpoint
  // holds part of its rows in its own -wal, and a restore of the main file alone drops them.
  it('restores a hand-made copy together with its own -wal', () => {
    const dir = dataDir();
    const live = join(dataDir(), 'live.db');
    const src = writeStoreSnapshot(join(dataDir(), 'src.db'), { observations: 10 });
    copyFileSync(src, live);
    const db = new Database(live);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    const insert = db.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
       VALUES ('s1', 'p', 'discovery', ?, 'n', datetime('now'), ?)`,
    );
    for (let i = 0; i < 50; i++) insert.run(`late ${i}`, 1_800_000_000_000 + i);
    const snap = join(dir, 'claude-mem-lite.db.before-upgrade.bak');
    copyFileSync(live, snap);
    copyFileSync(`${live}-wal`, `${snap}-wal`);
    db.close();
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'ok', observations: 60, withLog: true });
    // Premise: the main file alone holds only the checkpointed rows.
    const alone = join(dataDir(), 'claude-mem-lite.db.alone.bak');
    copyFileSync(snap, alone);
    expect(du.checkSnapshot(alone)).toMatchObject({ verdict: 'ok', observations: 10, withLog: false });
  });

  it.skipIf(isRoot)('cannot check a snapshot it cannot read, and says why', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    chmodSync(snap, 0o000);
    try {
      expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'unchecked', reason: 'EACCES' });
    } finally {
      chmodSync(snap, 0o600);
    }
    expect(listing(dir).filter((n) => n.startsWith('.snapshot-check-'))).toEqual([]);
  });

  it('cannot check when the probe does not run, and says why', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'probe.mjs');
    writeFileSync(probe, "process.stderr.write('boom\\n'); process.exit(3);\n");
    const r = du.checkSnapshot(snap, { probe });
    expect(r.verdict).toBe('unchecked');
    expect(r.reason).toMatch(/exited 3/);
    expect(r.reason).toContain('boom');
  });

  // r1 P3-3 / P3-5: the first stderr line of an import-time failure is a source location.
  it('names the error, not the source location, when the probe throws while loading', () => {
    const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'probe.mjs');
    writeFileSync(probe, "throw new Error('the probe could not load');\n");
    const r = du.checkSnapshot(snap, { probe });
    expect(r.verdict).toBe('unchecked');
    expect(r.reason).toMatch(/^probe exited 1: Error: the probe could not load$/);
  });

  // r1 defects P3-1: the product opener creates a fresh store where none is, so a copy that went
  // away (a second doctor's sweep, say) read as an empty snapshot.
  it('cannot check a copy that is gone, rather than calling it empty', () => {
    const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'vanish.mjs');
    const real = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'snapshot-probe.mjs');
    writeFileSync(
      probe,
      [
        "import { rmSync } from 'node:fs';",
        "rmSync(process.env.CLAUDE_MEM_DIR + '/claude-mem-lite.db');",
        `process.argv[1] = ${JSON.stringify(real)};`,
        `await import(${JSON.stringify(pathToFileURL(real).href)});`,
      ].join('\n'),
    );
    const r = du.checkSnapshot(snap, { probe });
    expect(r.verdict).toBe('unchecked');
    expect(r.reason).toMatch(/the copy to check is gone/);
  });

  it.skipIf(isRoot)('cannot check when the data directory is not writable, and names the directory', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    chmodSync(dir, 0o555);
    try {
      expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'unchecked', reason: 'EACCES', where: dir });
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  // The probe's result line, as each branch of the verdict reads it.
  it.each([
    [
      'a full disk under the copy',
      { opened: false, error: { code: 'SQLITE_FULL', message: 'database or disk is full' } },
      { verdict: 'unchecked', reason: 'SQLITE_FULL' },
    ],
    [
      'an I/O error under the copy',
      { opened: true, error: { code: 'SQLITE_IOERR_READ', message: 'disk I/O error' } },
      { verdict: 'unchecked', reason: 'SQLITE_IOERR_READ' },
    ],
    // Deterministic for the same file: the product's open fails on it after a restore too.
    [
      'NOMEM from the opener',
      { opened: false, error: { code: 'SQLITE_NOMEM', message: 'out of memory' } },
      { verdict: 'bad', why: 'open', reason: 'SQLITE_NOMEM' },
    ],
    [
      'a throw after the open',
      { opened: true, error: { code: 'SQLITE_CORRUPT', message: 'database disk image is malformed' } },
      { verdict: 'bad', why: 'integrity', reason: 'SQLITE_CORRUPT' },
    ],
    [
      'a throw with no code',
      {
        opened: false,
        error: { code: null, message: 'DB schema is v99 but this binary supports up to v49' },
      },
      { verdict: 'bad', why: 'open', reason: 'DB schema is v99 but this binary supports up to v49' },
    ],
    [
      'integrity rows',
      { opened: true, rebuildErrors: [], integrity: 'Tree 5 page 5 cell 1: bad', observations: 3 },
      { verdict: 'bad', why: 'integrity', reason: 'Tree 5 page 5 cell 1: bad' },
    ],
    // The check's own disk, whichever step met it.
    [
      'a full disk during the rebuild',
      {
        opened: true,
        rebuildErrors: [{ code: 'SQLITE_FULL', message: 'observations_fts: database or disk is full' }],
        integrity: 'fts5: corruption found reading blob 1 from table "observations_fts"',
        observations: 5,
      },
      { verdict: 'unchecked', reason: 'SQLITE_FULL' },
    ],
    [
      'an I/O error during the rebuild, then a throw',
      {
        opened: true,
        rebuildErrors: [{ code: 'SQLITE_IOERR_WRITE', message: 'events_fts: disk I/O error' }],
        error: { code: 'SQLITE_CORRUPT_VTAB', message: 'database disk image is malformed' },
      },
      { verdict: 'unchecked', reason: 'SQLITE_IOERR_WRITE' },
    ],
    // A rebuild that failed leaves an index the command's own last step fails on too.
    [
      'a rebuild error with the integrity check passing',
      {
        opened: true,
        rebuildErrors: [{ code: null, message: 'observations_fts: not found' }],
        integrity: 'ok',
        observations: 3,
      },
      { verdict: 'bad', why: 'rebuild', reason: 'observations_fts: not found' },
    ],
    // The rebuild refused because its page check could not run: the check's failure, not the
    // snapshot's, whatever its code (D#593; the first attempt read a code-less one as bad).
    ...[null, 'SQLITE_NOMEM', 'SQLITE_BUSY'].map((code) => [
      `a rebuild whose page check could not run (code ${code})`,
      {
        opened: true,
        rebuildErrors: [
          { code, message: "not rebuilt: the database's pages could not be checked first (x)" },
        ],
        pages: { state: 'unchecked', error: 'x', code },
        integrity: 'ok',
        observations: 3,
      },
      { verdict: 'unchecked', reason: 'the pages could not be checked (x)' },
    ]),
    [
      'a rebuild its page check refused',
      {
        opened: true,
        rebuildErrors: [
          { code: 'SQLITE_CORRUPT', message: "not rebuilt: the database's pages are damaged (p)" },
        ],
        pages: { state: 'damaged', error: null, code: null },
        integrity: 'ok',
        observations: 3,
      },
      { verdict: 'bad', why: 'rebuild', reason: "not rebuilt: the database's pages are damaged (p)" },
    ],
    [
      'a rebuild error, then a throw',
      {
        opened: true,
        rebuildErrors: [{ code: 'SQLITE_ERROR', message: 'observations_fts: invalid fts5 file format' }],
        error: { code: 'SQLITE_ERROR', message: 'invalid fts5 file format' },
      },
      { verdict: 'bad', why: 'rebuild', reason: 'observations_fts: invalid fts5 file format' },
    ],
  ])('reads %s from the probe', (_label, line, expected) => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'probe.mjs');
    writeFileSync(probe, `process.stdout.write(${JSON.stringify(JSON.stringify(line) + '\n')});\n`);
    expect(du.checkSnapshot(snap, { probe })).toMatchObject(expected);
  });

  it('gives up on a probe that outlives its timeout', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'probe.mjs');
    writeFileSync(probe, 'setTimeout(() => {}, 60_000);\n');
    expect(du.checkSnapshot(snap, { probe, timeoutMs: 300 })).toMatchObject({
      verdict: 'unchecked',
      reason: 'ETIMEDOUT, over 300 ms',
    });
    expect(listing(dir).filter((n) => n.startsWith('.snapshot-check-'))).toEqual([]);
  });

  it('writes nothing outside its private directory: HOME and TMPDIR stay empty', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'), { damage: 'fts' });
    const home = dataDir();
    const tmp = dataDir();
    const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
    process.env.HOME = home;
    process.env.TMPDIR = tmp;
    let r;
    try {
      r = du.checkSnapshot(snap);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(r.verdict, 'premise: the check ran to its end').toBe('ok');
    expect(listing(home)).toEqual([]);
    expect(listing(tmp)).toEqual([]);
  });

  // v6.30.8 r1 defects F7 (D#583): the child kept the user's HOME, so an opener that found no copy
  // moved the store of a version before 2.0.0 out of ~/claude-mem-lite into the private directory,
  // which checkSnapshot then removes. The wrapper takes the copy away after the probe's own
  // existence check would have passed, and opens with the product opener.
  it('an opener that finds no copy leaves a store in the home directory where it is', () => {
    const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'));
    const home = dataDir();
    mkdirSync(join(home, 'claude-mem-lite'));
    const legacy = writeStoreSnapshot(join(home, 'claude-mem-lite', 'claude-mem-lite.db'));
    const probe = join(dataDir(), 'vanish-then-open.mjs');
    writeFileSync(
      probe,
      [
        "import { rmSync } from 'node:fs';",
        "rmSync(process.env.CLAUDE_MEM_DIR + '/claude-mem-lite.db');",
        `const { ensureDbWithWalRecovery } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'schema.mjs')).href)});`,
        'ensureDbWithWalRecovery().close();',
        "process.stdout.write(JSON.stringify({ opened: true, rebuildErrors: [], integrity: 'ok', observations: 0 }) + '\\n');",
      ].join('\n'),
    );
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      du.checkSnapshot(snap, { probe });
    } finally {
      process.env.HOME = saved;
    }
    expect(existsSync(legacy), 'the store in ~/claude-mem-lite stays').toBe(true);
  });

  it('cannot check when the probe exits non-zero, even after a result line', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'probe.mjs');
    const line = JSON.stringify({ opened: true, rebuildErrors: [], integrity: 'ok', observations: 3 });
    writeFileSync(probe, `process.stdout.write(${JSON.stringify(line + '\n')}); process.exit(3);\n`);
    expect(du.checkSnapshot(snap, { probe })).toMatchObject({
      verdict: 'unchecked',
      reason: 'probe exited 3',
    });
  });

  // The product opener, not a bare open: a snapshot written by a newer claude-mem-lite opens in
  // SQLite and passes its integrity check, and this version refuses it (its schema is too new).
  // That says nothing about the snapshot, so it is not counted as damage: the third attempt called
  // it bad and named an older, smaller snapshot past it (v6.30.6 r1 defects P2-1, D#570).
  it('cannot check a snapshot whose schema is newer than this version, and says to update', () => {
    const dir = dataDir();
    const snap = writeStoreSnapshot(join(dir, 'claude-mem-lite.db.pre-delete-x.bak'));
    const db = new Database(snap);
    db.prepare('UPDATE schema_version SET version = 999').run();
    expect(db.prepare('PRAGMA integrity_check(1)').pluck().get(), 'premise').toBe('ok');
    db.close();
    const r = du.checkSnapshot(snap);
    expect(r.verdict).toBe('unchecked');
    expect(r.reason).toMatch(/newer claude-mem-lite.*update/);
  });

  // r1 P2 of the second attempt: a directory a killed check left was removed only by a walk 20+
  // minutes later, which never comes once the store is restored.
  it('removes a private directory whose check has exited, and keeps a running one', () => {
    const dir = dataDir();
    const dead = join(dir, `.snapshot-check-${deadPid()}-abcdef`);
    const running = join(dir, `.snapshot-check-${process.pid}-ghijkl`);
    const runningButOld = join(dir, `.snapshot-check-${process.pid}-mnopqr`);
    const notOurs = [join(dir, 'snapshot-check-notours'), join(dir, '.snapshot-check-notapid-abcdef')];
    for (const d of [dead, running, runningButOld, ...notOurs]) {
      mkdirSync(d);
      writeFileSync(join(d, 'claude-mem-lite.db'), 'x');
    }
    const aFile = join(dir, `.snapshot-check-${deadPid()}-stuvwx`);
    writeFileSync(aFile, 'not a directory');
    const old = Date.now() / 1000 - 25 * 3600;
    for (const p of [runningButOld, ...notOurs, aFile]) utimesSync(p, old, old);
    du.sweepSnapshotChecks(dir);
    expect(existsSync(dead), 'its check has exited').toBe(false);
    expect(existsSync(running), 'a check that is still running keeps its directory').toBe(true);
    expect(existsSync(runningButOld), 'no check runs a day: its pid names another process now').toBe(false);
    for (const d of notOurs) expect(existsSync(d), d).toBe(true);
    expect(existsSync(aFile), 'only directories').toBe(true);
  });

  // pid 1 runs as root: signalling it from another user fails with EPERM, which is a live process.
  it.skipIf(isRoot)('keeps a directory whose process runs as another user', () => {
    const dir = dataDir();
    const theirs = join(dir, '.snapshot-check-1-abcdef');
    mkdirSync(theirs);
    du.sweepSnapshotChecks(dir);
    expect(existsSync(theirs)).toBe(true);
  });

  it('records a REINDEX that fails, with its code', async () => {
    const { rebuildIndexes } = await import('../schema.mjs');
    const path = join(dataDir(), 'dup.db');
    const db = new Database(path);
    db.exec('CREATE TABLE t (a); CREATE INDEX t_a ON t (a); INSERT INTO t VALUES (1), (1);');
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare("UPDATE sqlite_master SET sql = 'CREATE UNIQUE INDEX t_a ON t (a)' WHERE name = 't_a'").run();
    db.close();
    const h = new Database(path);
    try {
      const r = rebuildIndexes(h);
      expect(r.rebuilt).not.toContain('indexes');
      const at = r.errors.findIndex((e) => e.startsWith('indexes: '));
      expect(at, r.errors.join('\n')).toBeGreaterThan(-1);
      expect(r.codes[at]).toBe('SQLITE_CONSTRAINT_UNIQUE');
    } finally {
      h.close();
    }
  });
});

// The commands are run, not only read: each holds two `test` guards, a `touch` and two `mv`, and
// a wrong one destroys the file it exists to keep.
describe('the printed commands, run in a shell', () => {
  const shells = ['bash', 'sh'].filter((s) => spawnSync(s, ['-c', 'true']).status === 0);
  const NOW = Date.UTC(2026, 9, 23, 19, 30, 0, 0);
  const run = (shell, cmd) => spawnSync(shell, ['-c', cmd], { encoding: 'utf8' });
  const broken = (dir, { wal = true } = {}) => {
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'BROKEN MAIN FILE');
    if (wal) writeFileSync(`${db}-wal`, 'COMMITTED LOG FRAMES');
    writeFileSync(`${db}-shm`, 'SHM');
    return db;
  };

  it.each(shells)(
    '%s: set-aside keeps the broken file and its log, and a second run changes nothing',
    (shell) => {
      const dir = dataDir();
      const db = broken(dir);
      const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW });
      expect(r.kind).toBe('set-aside');
      expect(run(shell, r.command).status).toBe(0);
      expect(readFileSync(r.keptAs, 'utf8')).toBe('BROKEN MAIN FILE');
      expect(readFileSync(`${r.keptAs}-wal`, 'utf8')).toBe('COMMITTED LOG FRAMES');
      expect(existsSync(db) || existsSync(`${db}-wal`) || existsSync(`${db}-shm`)).toBe(false);
      // Again, after a fresh store was created in its place: the guard stops it.
      writeFileSync(db, 'FRESH STORE');
      const after = listing(dir);
      expect(run(shell, r.command).status).not.toBe(0);
      expect(listing(dir)).toEqual(after);
      expect(readFileSync(db, 'utf8')).toBe('FRESH STORE');
      expect(readFileSync(r.keptAs, 'utf8')).toBe('BROKEN MAIN FILE');
    },
  );

  it.each(shells)('%s: set-aside with no log leaves an empty log beside the kept file', (shell) => {
    const dir = dataDir();
    const db = broken(dir, { wal: false });
    const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW });
    expect(run(shell, r.command).status).toBe(0);
    expect(readFileSync(r.keptAs, 'utf8')).toBe('BROKEN MAIN FILE');
    expect(readFileSync(`${r.keptAs}-wal`).length).toBe(0);
    expect(existsSync(db)).toBe(false);
  });

  // The restore runs the CLI (`fts-check rebuild`): HOME sandboxed and the opt-outs set, as for
  // every spawn of this repo's entry points.
  const cliEnv = () => ({
    ...process.env,
    HOME: dataDir(),
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
  });
  const observations = (db) => {
    const copy = join(dataDir(), 'count.db');
    copyFileSync(db, copy);
    if (existsSync(`${db}-wal`)) copyFileSync(`${db}-wal`, `${copy}-wal`);
    const h = new Database(copy, { readonly: true });
    try {
      return h.prepare('SELECT count(*) FROM observations').pluck().get();
    } finally {
      h.close();
    }
  };

  it.each(shells)('%s: restore puts the snapshot in place, reindexed, and keeps the broken pair', (shell) => {
    const dir = dataDir();
    const db = broken(dir);
    const snap = writeStoreSnapshot(`${db}.pre-delete-x.bak`, { observations: 7, damage: 'fts' });
    const snapBytes = readFileSync(snap);
    const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW, check: du.checkSnapshot });
    expect(r.kind).toBe('restore');
    const ran = spawnSync(shell, ['-c', r.command], { encoding: 'utf8', env: cliEnv() });
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(observations(db)).toBe(7);
    // What the check vouched for: the restored store, reindexed, passes the integrity check.
    const h = new Database(db);
    expect(h.prepare('PRAGMA integrity_check(1)').pluck().get()).toBe('ok');
    h.close();
    expect(readFileSync(r.keptAs, 'utf8')).toBe('BROKEN MAIN FILE');
    expect(readFileSync(`${r.keptAs}-wal`, 'utf8')).toBe('COMMITTED LOG FRAMES');
    expect(readFileSync(snap).equals(snapBytes), 'the snapshot stays as it was').toBe(true);
    const after = listing(dir);
    expect(spawnSync(shell, ['-c', r.command], { env: cliEnv() }).status).not.toBe(0);
    expect(listing(dir)).toEqual(after);
  });

  it.each(shells)(
    '%s: restore of a snapshot whose only damage is an ordinary index leaves a clean store',
    (shell) => {
      const dir = dataDir();
      const db = broken(dir);
      writeStoreSnapshot(`${db}.pre-delete-x.bak`, { observations: 7, damage: 'index' });
      const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW, check: du.checkSnapshot });
      expect(r.kind).toBe('restore');
      const ran = spawnSync(shell, ['-c', r.command], { encoding: 'utf8', env: cliEnv() });
      expect(ran.status, ran.stdout + ran.stderr).toBe(0);
      const h = new Database(db);
      try {
        expect(h.prepare('PRAGMA integrity_check(1)').pluck().get()).toBe('ok');
        expect(h.prepare('SELECT count(*) FROM observations').pluck().get()).toBe(7);
      } finally {
        h.close();
      }
    },
  );

  // r1 defects P2-3 of the second attempt: the kept name comes from the broken file's mtime, which
  // `mv` keeps, so once the kept file was moved back every printed command stopped at its guard,
  // with exit 1 and no message.
  it.each(shells)(
    '%s: once the kept file is moved back, the next command keeps it under a new name',
    (shell) => {
      const dir = dataDir();
      const db = broken(dir);
      const first = du.dbUnusableRemedy(db, undefined, { stampMs: NOW });
      expect(run(shell, first.command).status).toBe(0);
      renameSync(first.keptAs, db);
      const second = du.dbUnusableRemedy(db, undefined, { stampMs: NOW });
      expect(second.keptAs).toBe(`${first.keptAs}-1`);
      expect(run(shell, second.command).status).toBe(0);
      expect(readFileSync(second.keptAs, 'utf8')).toBe('BROKEN MAIN FILE');
      expect(readFileSync(`${first.keptAs}-wal`, 'utf8'), 'the first kept log stays').toBe(
        'COMMITTED LOG FRAMES',
      );
    },
  );

  // The restore command's last step: what the check ran on its copy after the open.
  // The MCP face of the same command ("Equivalent CLI: fts-check <check|rebuild>") rebuilds what
  // the CLI rebuilds.
  it('mem_fts_check rebuild repairs an ordinary index too, as the CLI does', async () => {
    const { handleMemFtsCheck } = await import('../server/fts-check.mjs');
    const db = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db'), { damage: 'index' });
    expect(integrityRows(db).length, 'premise: integrity_check fails').toBeGreaterThan(0);
    const h = new Database(db);
    try {
      const text = handleMemFtsCheck(h, { action: 'rebuild' }).content[0].text;
      expect(text).toMatch(/^Successfully rebuilt: /);
      expect(h.prepare('PRAGMA integrity_check(1)').pluck().get()).toBe('ok');
    } finally {
      h.close();
    }
  });

  it('fts-check rebuild repairs an ordinary index as well as the search index', () => {
    const dir = dataDir();
    const db = writeStoreSnapshot(join(dir, 'claude-mem-lite.db'), { damage: 'index' });
    expect(integrityRows(db).length, 'premise: integrity_check fails').toBeGreaterThan(0);
    const r = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'fts-check', 'rebuild'], {
      encoding: 'utf8',
      env: { ...cliEnv(), CLAUDE_MEM_DIR: dir },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const h = new Database(db);
    try {
      expect(h.prepare('PRAGMA integrity_check(1)').pluck().get()).toBe('ok');
    } finally {
      h.close();
    }
  });

  it.each(shells)('%s: restore of a hand-made copy brings its own log along', (shell) => {
    const dir = dataDir();
    const db = broken(dir);
    const live = join(dataDir(), 'live.db');
    copyFileSync(writeStoreSnapshot(join(dataDir(), 'src.db'), { observations: 10 }), live);
    const h = new Database(live);
    h.pragma('journal_mode = WAL');
    h.pragma('wal_autocheckpoint = 0');
    const insert = h.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
       VALUES ('s1', 'p', 'discovery', ?, 'n', datetime('now'), ?)`,
    );
    for (let i = 0; i < 50; i++) insert.run(`late ${i}`, 1_800_000_000_000 + i);
    const snap = `${db}.before-upgrade.bak`;
    copyFileSync(live, snap);
    copyFileSync(`${live}-wal`, `${snap}-wal`);
    h.close();
    const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW, check: du.checkSnapshot });
    expect(r.kind).toBe('restore');
    const ran = spawnSync(shell, ['-c', r.command], { encoding: 'utf8', env: cliEnv() });
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(observations(db)).toBe(60);
  });
});

describe('doctor wires the real check', () => {
  it('names an older sound snapshot over a newer one that does not restore cleanly', async () => {
    const { dbCheckRemedy } = await import('../install.mjs');
    const dir = dataDir();
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'not actually sqlite');
    const older = writeStoreSnapshot(`${db}.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak`, {
      observations: 4,
    });
    const newer = writeStoreSnapshot(`${db}.pre-delete-2026-09-06T00-00-00-000Z-1-1.bak`, {
      damage: 'header',
    });
    const t = Date.now() / 1000;
    utimesSync(older, t - 3600, t - 3600);
    utimesSync(newer, t, t);
    const out = await dbCheckRemedy(
      db,
      Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' }),
    );
    expect(out).toContain(`cp ${shellWord(older)} ${shellWord(db)}`);
    expect(out).not.toContain(newer);
    expect(out).toContain('4 observation(s)');
    expect(out).toContain('1 does not open');
  });

  // r1 defects P3-7: a directory named like a snapshot stopped the walk with EISDIR.
  it('passes over a directory named like a snapshot', async () => {
    const { dbCheckRemedy } = await import('../install.mjs');
    const dir = dataDir();
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'not actually sqlite');
    const older = writeStoreSnapshot(`${db}.pre-maintain-2026-09-01T00-00-00-000Z-1-1.bak`, {
      observations: 4,
    });
    const notAFile = `${db}.pre-delete-2026-09-06T00-00-00-000Z-1-1.bak`;
    mkdirSync(notAFile);
    writeFileSync(join(notAFile, 'x'), 'x');
    const t = Date.now() / 1000;
    utimesSync(older, t - 3600, t - 3600);
    utimesSync(notAFile, t, t);
    const out = await dbCheckRemedy(
      db,
      Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' }),
    );
    expect(out).toContain(`cp ${shellWord(older)} ${shellWord(db)}`);
  });

  // r1 P2 of the second attempt: the sweep ran only on a broken store's walk, so a copy a killed
  // check left stayed once the store was restored.
  it('doctor sweeps a directory a killed check left, on a healthy store', () => {
    const root = dataDir();
    const data = join(root, 'data');
    mkdirSync(data);
    writeStoreSnapshot(join(data, 'claude-mem-lite.db'), { observations: 3 });
    const left = join(data, `.snapshot-check-${deadPid()}-abcdef`);
    mkdirSync(left);
    writeFileSync(join(left, 'claude-mem-lite.db'), 'a full copy of a snapshot');
    const home = join(root, 'home');
    mkdirSync(home);
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_MEM_DIR: data,
      PATH: pathWithClaudeStub(root),
      MEM_NO_AUTO_ADOPT: '1',
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
    };
    const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor'], {
      encoding: 'utf8',
      env,
      cwd: root,
    });
    expect(r.stdout, 'premise: doctor checked the store').toMatch(/FTS5 index: present/);
    expect(existsSync(left)).toBe(false);
  });
});

// The remedy's text, with the check stubbed.
describe('the remedy names the data directory and never stops silently', () => {
  const NOW = Date.UTC(2026, 9, 23, 19, 30, 0, 0);
  const brokenWith = (names) => {
    const dir = dataDir();
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    let t = 1_700_000_000;
    for (const n of names) {
      writeFileSync(join(dir, n), 'snapshot bytes');
      utimesSync(join(dir, n), t, t);
      t += 3600;
    }
    return { dir, db };
  };
  const doctor = (dir) => `CLAUDE_MEM_DIR=${shellWord(dir)} ${CLI_INVOKE} doctor`;

  // r1 defects P2-2 and P3-5: under a data dir relocated only in Claude Code's env, a bare
  // `doctor` checks another store; and 6.30.5's install.mjs, left beside a newer lib by a killed
  // swap, renders any kind it does not know as a restore with an empty command.
  it('without a check, points at doctor with the data directory, under a kind every version renders as a note', () => {
    const { dir, db } = brokenWith(['claude-mem-lite.db.pre-delete-a.bak']);
    const r = du.dbUnusableRemedy(db, new Error('file is not a database'));
    expect(r.kind).toBe('unknown');
    expect(r.command).toBe('');
    expect(r.note).toContain(`\`${doctor(dir)}\` checks which ones restore before it gives a command.`);
  });

  // r1 defects P3-4: doctor gives the schema family no command.
  it('without a check, promises the schema family no command', () => {
    const { db } = brokenWith(['claude-mem-lite.db.pre-delete-a.bak']);
    const r = du.dbUnusableRemedy(db, new Error('malformed database schema (x)'));
    expect(r.kind).toBe('schema');
    expect(r.note).not.toMatch(/command/);
    expect(r.note).toMatch(/ checks which ones restore\.$/);
  });

  it('names what could not be checked, and how to re-run doctor', () => {
    const { dir, db } = brokenWith(['claude-mem-lite.db.pre-delete-a.bak']);
    const r = du.dbUnusableRemedy(db, undefined, {
      check: () => ({ verdict: 'unchecked', withLog: false, reason: 'EACCES', where: dir }),
    });
    expect(r.kind).toBe('unknown');
    expect(r.note).toContain(`could not be checked (EACCES): ${dir}.`);
    expect(r.note).toContain(doctor(dir));
  });

  it('counts a snapshot whose indexes do not rebuild apart from one that fails the integrity check', () => {
    const { db } = brokenWith(['claude-mem-lite.db.pre-delete-a.bak', 'claude-mem-lite.db.pre-delete-b.bak']);
    const verdicts = [
      {
        verdict: 'bad',
        withLog: false,
        why: 'rebuild',
        reason: 'observations_fts: invalid fts5 file format',
      },
      { verdict: 'bad', withLog: false, why: 'integrity', reason: 'Tree 5 page 5' },
    ];
    const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW, check: () => verdicts.shift() });
    expect(r.kind).toBe('set-aside');
    expect(r.found).toContain('1 fails the index rebuild, 1 fails the integrity check');
  });

  it('says by how much a snapshot is short of its own index', () => {
    const { db } = brokenWith(['claude-mem-lite.db.pre-delete-a.bak']);
    const short = du.dbUnusableRemedy(db, undefined, {
      stampMs: NOW,
      check: () => ({ verdict: 'ok', withLog: false, observations: 3, listed: 12 }),
    });
    expect(short.found).toContain('holds 3 observation(s), 9 fewer than its own index lists.');
    // Two causes, and the file cannot tell them apart (v6.30.7 r1 claims P2-1).
    expect(short.found).toContain(
      'Short of its own index means its table lost those rows or its index still lists rows a delete removed.',
    );
    expect(short.found).not.toMatch(/rows its table lost/);
    const whole = du.dbUnusableRemedy(db, undefined, {
      stampMs: NOW,
      check: () => ({ verdict: 'ok', withLog: false, observations: 3 }),
    });
    expect(whole.found).toMatch(/holds 3 observation\(s\)\.$/);
  });

  it('keeps the broken file under a name nothing holds yet', () => {
    const { db } = brokenWith([]);
    const base = du.dbUnusableRemedy(db, undefined, { stampMs: NOW }).keptAs;
    writeFileSync(base, 'an earlier kept file');
    writeFileSync(`${base}-1-wal`, 'an earlier kept log');
    expect(du.dbUnusableRemedy(db, undefined, { stampMs: NOW }).keptAs).toBe(`${base}-2`);
  });

  it('both notices name doctor with the data directory', () => {
    const { dir, db } = brokenWith([]);
    const remedy = du.dbUnusableRemedy(db, undefined, { stampMs: NOW });
    expect(du.formatDbUnusableNotice({ dbPath: db, remedy })).toContain(`\`${doctor(dir)}\` re-checks.`);
    expect(du.formatDbUnusableModelNotice(db)).toContain(`\`${doctor(dir)}\``);
  });

  // An update killed between lib/db-unusable.mjs and hook.mjs leaves 6.30.5's hook, which passes
  // no path; a throw here would drop the model's notice.
  it('the model notice renders for a caller that passes no path', () => {
    expect(du.formatDbUnusableModelNotice()).toContain(`\`${CLI_INVOKE} doctor\``);
  });
});

// D#577, the fifth attempt. The third (withdrawn at v6.30.6's r1 review, defects P1-1) stopped at the
// first snapshot that passed, so doctor named one holding 3 observations of 410 and never mentioned an
// older intact one holding 400. The fourth (withdrawn at v6.30.7's r1 review) named the older one
// whenever the newest was short of its own index; but that shape also comes from a delete whose index
// page write was lost, the index still listing rows the user removed (claims P2-1), and there it gave
// the user's deleted rows back and dropped what was written since. Nothing in a snapshot tells the two
// apart, so the command restores the newest snapshot that passes, and every older one is checked:
// each that passes is listed with its counts, before the command, and given its own command.
describe('the command restores the newest snapshot that passes; every older one that passes is listed with its own command (D#577)', () => {
  const NOW = Date.UTC(2026, 9, 25, 12, 0, 0, 0);
  /** A broken store and snapshots named `names`, oldest first. */
  const brokenWith = (names) => {
    const dir = dataDir();
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'garbage');
    let t = 1_700_000_000;
    const paths = names.map((n) => {
      const p = join(dir, `claude-mem-lite.db.${n}.bak`);
      writeFileSync(p, 'snapshot bytes');
      utimesSync(p, t, t);
      t += 3600;
      return p;
    });
    return { dir, db, paths };
  };
  const ok = (observations, listed) => ({
    verdict: 'ok',
    withLog: false,
    observations,
    ...(listed ? { listed } : {}),
  });
  const walk = (db, verdicts) => {
    const asked = [];
    const r = du.dbUnusableRemedy(db, undefined, {
      stampMs: NOW,
      check: (p) => {
        asked.push(p);
        return verdicts[p];
      },
    });
    return { r, asked };
  };
  const restores = (db, path) => `cp ${shellWord(path)} ${shellWord(db)}`;
  const TWO_CAUSES =
    'Short of its own index means its table lost those rows or its index still lists rows a delete removed.';

  it('names the newest that passes though it is short of its own index, and lists an older complete one', () => {
    const { db, paths } = brokenWith(['pre-maintain-a', 'pre-delete-b']);
    const [older, newer] = paths;
    const { r, asked } = walk(db, { [newer]: ok(3, 410), [older]: ok(400) });
    expect(asked).toEqual([newer, older]);
    expect(r.kind).toBe('restore');
    expect(r.command).toContain(restores(db, newer));
    expect(r.command).not.toContain(older);
    expect(r.found).toContain('holds 3 observation(s), 407 fewer than its own index lists.');
    expect(r.found).toContain(TWO_CAUSES);
    expect(r.found).toContain(`An older snapshot also restores: ${older}, 400 observation(s).`);
    expect(r.found).toContain('It holds more observations than the one the command restores.');
    expect(r.alternatives.map((a) => a.path)).toEqual([older]);
    expect(r.alternatives[0].command).toContain(restores(db, older));
  });

  // v6.30.7 r1 defects P1-1 (S1): an older snapshot short of its own index but holding more was
  // checked and never mentioned.
  it('lists an older snapshot that is short of its own index too, with what its index lists', () => {
    const { db, paths } = brokenWith(['pre-maintain-a', 'pre-delete-b']);
    const [older, newer] = paths;
    const { r } = walk(db, { [newer]: ok(3, 410), [older]: ok(400, 405) });
    expect(r.command).toContain(restores(db, newer));
    expect(r.found).toContain(`${older}, 400 observation(s) (its index lists 405)`);
    expect(r.alternatives.map((a) => a.path)).toEqual([older]);
  });

  // S2: with an oldest complete one as well, both older ones are listed, newest first.
  it('lists every older snapshot that passes, newest first, each with its own command', () => {
    const { db, paths } = brokenWith(['pre-maintain-a', 'pre-maintain-b', 'pre-delete-c']);
    const [oldest, middle, newest] = paths;
    const { r, asked } = walk(db, { [newest]: ok(3, 410), [middle]: ok(400, 405), [oldest]: ok(100) });
    expect(asked).toEqual([newest, middle, oldest]);
    expect(r.command).toContain(restores(db, newest));
    expect(r.found).toContain(
      `2 older snapshots also restore: ${middle}, 400 observation(s) (its index lists 405); ${oldest}, 100 observation(s).`,
    );
    expect(r.found).toContain('One of them holds more observations than the one the command restores.');
    expect(r.alternatives.map((a) => a.path)).toEqual([middle, oldest]);
    expect(r.alternatives[1].command).toContain(restores(db, oldest));
  });

  // v6.30.7 r1 defects P1-2 (S3): an older snapshot the check cannot run on is named with its
  // reason, and the snapshots older than it are still checked; the command restores a snapshot
  // newer than it, so nothing newer is passed over.
  it('names an older snapshot it could not check and goes on to the ones older than it', () => {
    const { db, paths } = brokenWith(['pre-maintain-a', 'pre-maintain-b', 'pre-delete-c']);
    const [oldest, middle, newest] = paths;
    const { r, asked } = walk(db, {
      [newest]: ok(3, 410),
      [middle]: { verdict: 'unchecked', withLog: false, reason: 'EACCES' },
      [oldest]: ok(400),
    });
    expect(asked).toEqual([newest, middle, oldest]);
    expect(r.command).toContain(restores(db, newest));
    expect(r.found).toContain(`An older snapshot could not be checked: ${middle} (EACCES).`);
    expect(r.alternatives.map((a) => a.path)).toEqual([oldest]);
  });

  // v6.30.7 r1 claims P2-1: the user deleted 30 rows and an index page went back to before the
  // delete, so the newest is short of its index and an older one holds more. The newest is right.
  it('after a delete whose index write was lost, still names the newest', () => {
    const { db, paths } = brokenWith(['pre-maintain-a', 'pre-delete-b']);
    const [older, newer] = paths;
    const { r } = walk(db, { [newer]: ok(390, 420), [older]: ok(400) });
    expect(r.command).toContain(restores(db, newer));
    expect(r.found).toContain('holds 390 observation(s), 30 fewer than its own index lists.');
    expect(r.alternatives.map((a) => a.path)).toEqual([older]);
  });

  it('names a newest snapshot that is not short, and still checks and lists the older ones', () => {
    const { db, paths } = brokenWith(['pre-maintain-a', 'pre-delete-b']);
    const [older, newer] = paths;
    const { r, asked } = walk(db, { [newer]: ok(380), [older]: ok(370) });
    expect(asked).toEqual([newer, older]);
    expect(r.command).toContain(restores(db, newer));
    expect(r.found).not.toContain(TWO_CAUSES);
    expect(r.found).toContain(`An older snapshot also restores: ${older}, 370 observation(s).`);
    expect(r.found).not.toContain('more observations than the one the command restores');
    expect(r.found).toContain(
      'Restoring an older one instead loses what was written after it was taken and brings back what was deleted since.',
    );
    expect(r.alternatives.map((a) => a.path)).toEqual([older]);
  });

  it('counts the older snapshots that do not restore, and offers no command for them', () => {
    const { db, paths } = brokenWith(['pre-maintain-a', 'pre-maintain-b', 'pre-delete-c']);
    const [oldest, middle, newest] = paths;
    const { r } = walk(db, {
      [newest]: ok(5),
      [middle]: { verdict: 'bad', withLog: false, why: 'open', reason: 'SQLITE_NOTADB' },
      [oldest]: { verdict: 'empty', withLog: false, observations: 0 },
    });
    expect(r.command).toContain(restores(db, newest));
    expect(r.found).toMatch(/ Of the older ones, 1 does not open, 1 holds no rows\.$/);
    expect(r.alternatives).toEqual([]);
  });

  it('with no older snapshot, gives no alternative and says nothing about older ones', () => {
    const { db, paths } = brokenWith(['pre-delete-b']);
    const { r } = walk(db, { [paths[0]]: ok(3, 410) });
    expect(r.command).toContain(restores(db, paths[0]));
    expect(r.alternatives).toEqual([]);
    expect(r.found).not.toMatch(/older/);
  });

  // The r1 repro, with the real check: an older intact snapshot and a newer one whose table lost rows.
  it('doctor, with the real check: the list and its counts come before the command', async () => {
    const { dbCheckRemedy } = await import('../install.mjs');
    const dir = dataDir();
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'not actually sqlite');
    const older = writeStoreSnapshot(`${db}.pre-maintain-2026-10-20T00-00-00-000Z-1-1.bak`, {
      observations: 40,
    });
    const newer = writeStoreSnapshot(`${db}.pre-maintain-2026-10-21T00-00-00-000Z-1-2.bak`, {
      observations: 41,
      damage: 'lost-rows',
    });
    const t = Date.now() / 1000;
    utimesSync(older, t - 3600, t - 3600);
    utimesSync(newer, t, t);
    const out = await dbCheckRemedy(
      db,
      Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' }),
    );
    expect(out).toContain('holds 3 observation(s), 38 fewer than its own index lists.');
    const listed = out.indexOf(`An older snapshot also restores: ${older}, 40 observation(s).`);
    const command = out.indexOf(`restore it: test -s ${shellWord(newer)}`);
    expect(listed, out).toBeGreaterThan(-1);
    expect(command, out).toBeGreaterThan(listed);
    const alternative = out.indexOf(`To restore ${older} instead: test -s ${shellWord(older)}`);
    expect(alternative, out).toBeGreaterThan(command);
  });
});

describe("the fourth attempt also answers the rest of the third one's review (D#570)", () => {
  const NOW = Date.UTC(2026, 9, 24, 12, 0, 0, 0);
  const shells = ['bash', 'sh'].filter((s) => spawnSync(s, ['-c', 'true']).status === 0);
  const cliEnv = () => ({
    ...process.env,
    HOME: dataDir(),
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
  });
  const broken = (dir) => {
    const db = join(dir, 'claude-mem-lite.db');
    writeFileSync(db, 'BROKEN MAIN FILE');
    writeFileSync(`${db}-wal`, 'COMMITTED LOG FRAMES');
    return db;
  };

  // r1 defects P2-3: copyFileSync carries the 0444 mode to the copy, the product opens it read-only,
  // and the snapshot was called bad; `cp` gives the restored store the same mode.
  it.skipIf(isRoot)('passes a read-only snapshot', () => {
    const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'), {
      observations: 5,
    });
    chmodSync(snap, 0o444);
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'ok', observations: 5 });
  });

  it.skipIf(isRoot).each(shells)(
    '%s: restoring a read-only snapshot gives a store that opens for writing',
    (shell) => {
      const dir = dataDir();
      const db = broken(dir);
      const snap = writeStoreSnapshot(`${db}.pre-delete-x.bak`, { observations: 5 });
      chmodSync(snap, 0o444);
      const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW, check: du.checkSnapshot });
      expect(r.kind).toBe('restore');
      const ran = spawnSync(shell, ['-c', r.command], { encoding: 'utf8', env: cliEnv() });
      expect(ran.status, ran.stdout + ran.stderr).toBe(0);
      const h = new Database(db);
      try {
        h.prepare(
          "INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch) VALUES ('c-s1', 'p', 1, datetime('now'), 1)",
        ).run();
      } finally {
        h.close();
      }
    },
  );

  // r1 defects P3-5: with the snapshot gone, the command moved the broken pair aside and then
  // failed at `cp`, leaving no store and a doctor that no longer mentions either.
  it.each(shells)('%s: with the named snapshot gone, the restore changes nothing', (shell) => {
    const dir = dataDir();
    const db = broken(dir);
    const snap = writeStoreSnapshot(`${db}.pre-delete-x.bak`, { observations: 5 });
    const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW, check: du.checkSnapshot });
    expect(r.kind).toBe('restore');
    rmSync(snap);
    const before = listing(dir);
    expect(spawnSync(shell, ['-c', r.command], { env: cliEnv() }).status).not.toBe(0);
    expect(listing(dir)).toEqual(before);
    expect(readFileSync(db, 'utf8')).toBe('BROKEN MAIN FILE');
  });

  it.each(shells)(
    '%s: each command restores its own snapshot, and one run after another changes nothing',
    (shell) => {
      const dir = dataDir();
      const db = broken(dir);
      const older = writeStoreSnapshot(`${db}.pre-maintain-a.bak`, { observations: 40 });
      const newer = writeStoreSnapshot(`${db}.pre-delete-b.bak`, { observations: 41, damage: 'lost-rows' });
      const t = Date.now() / 1000;
      utimesSync(older, t - 3600, t - 3600);
      utimesSync(newer, t, t);
      const r = du.dbUnusableRemedy(db, undefined, { stampMs: NOW, check: du.checkSnapshot });
      expect(
        r.alternatives.map((a) => a.path),
        'premise: two candidates',
      ).toEqual([older]);
      const restored = () => {
        const h = new Database(db, { readonly: true });
        try {
          return [
            h.prepare('SELECT count(*) FROM observations').pluck().get(),
            h.prepare('PRAGMA integrity_check(1)').pluck().get(),
          ];
        } finally {
          h.close();
        }
      };
      // The alternative on a fresh copy of the broken pair, then the main command on another.
      const keep = { main: readFileSync(db), wal: readFileSync(`${db}-wal`) };
      const ran = spawnSync(shell, ['-c', r.alternatives[0].command], { encoding: 'utf8', env: cliEnv() });
      expect(ran.status, ran.stdout + ran.stderr).toBe(0);
      expect(restored()).toEqual([40, 'ok']);
      const after = listing(dir);
      expect(spawnSync(shell, ['-c', r.command], { env: cliEnv() }).status, 'stops at its guard').not.toBe(0);
      expect(listing(dir)).toEqual(after);
      expect(restored()).toEqual([40, 'ok']);
      for (const f of [db, `${db}-wal`, `${db}-shm`, r.keptAs, `${r.keptAs}-wal`]) rmSync(f, { force: true });
      writeFileSync(db, keep.main);
      writeFileSync(`${db}-wal`, keep.wal);
      const main = spawnSync(shell, ['-c', r.command], { encoding: 'utf8', env: cliEnv() });
      expect(main.status, main.stdout + main.stderr).toBe(0);
      expect(restored()).toEqual([3, 'ok']);
    },
  );

  // r1 defects P3-3: the private copy's path is longer than the store's, and SQLite's path limit
  // gave SQLITE_CANTOPEN on an intact snapshot, which was called damage.
  it('cannot check a copy SQLite cannot open, rather than calling the snapshot bad', () => {
    const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'probe.mjs');
    const line = JSON.stringify({
      opened: false,
      error: { code: 'SQLITE_CANTOPEN', message: 'unable to open database file' },
    });
    writeFileSync(probe, `process.stdout.write(${JSON.stringify(line + '\n')});\n`);
    expect(du.checkSnapshot(snap, { probe })).toMatchObject({
      verdict: 'unchecked',
      reason: 'SQLITE_CANTOPEN',
    });
  });

  // r1 defects P3-4: SQLite's sort files went to TMPDIR, so a full /tmp read as SQLITE_FULL
  // against the snapshot's path.
  it("points SQLite's and Node's temporary files at the private directory", () => {
    const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'));
    const probe = join(dataDir(), 'probe.mjs');
    writeFileSync(
      probe,
      [
        'const e = process.env;',
        'const here = e.SQLITE_TMPDIR === e.CLAUDE_MEM_DIR && e.TMPDIR === e.CLAUDE_MEM_DIR;',
        "const r = here ? { opened: true, rebuildErrors: [], integrity: 'ok', observations: 1, otherRows: 0 } : { opened: false, error: { code: 'SQLITE_ERROR', message: 'temp dirs elsewhere' } };",
        "process.stdout.write(JSON.stringify(r) + '\\n');",
      ].join('\n'),
    );
    expect(du.checkSnapshot(snap, { probe })).toMatchObject({ verdict: 'ok' });
  });

  // r1 defects P3-9: only observations were counted, so a snapshot holding prompts and summaries
  // but no observation was skipped as empty. One case per table the check counts.
  it.each([
    [
      'session_summaries',
      "INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch) VALUES ('s1', 'p', 'r', datetime('now'), 1)",
    ],
    [
      'user_prompts',
      "INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch) VALUES ('c-s1', 'a prompt', 1, datetime('now'), 1)",
    ],
    [
      'events',
      "INSERT INTO events (project, event_type, title, created_at_epoch) VALUES ('p', 'lesson', 't', 1)",
    ],
    ['deferred_work', "INSERT INTO deferred_work (project, title, created_at_epoch) VALUES ('p', 't', 1)"],
  ])('passes a snapshot with no observation that holds a row in %s', (_table, insert) => {
    const snap = writeStoreSnapshot(join(dataDir(), 'claude-mem-lite.db.pre-delete-x.bak'), {
      observations: 0,
    });
    const h = new Database(snap);
    h.prepare(insert).run();
    h.close();
    expect(du.checkSnapshot(snap)).toMatchObject({ verdict: 'ok', observations: 0, otherRows: 1 });
  });

  // r1 defects P3-7: PowerShell, cmd and csh cannot run a `VAR=value command` prefix; the default
  // data directory needs none.
  it('names doctor without the data directory prefix when the data directory is the default one', async () => {
    const { CODE_DIR } = await import('../lib/data-paths.mjs');
    expect(du.formatDbUnusableModelNotice(join(CODE_DIR, 'claude-mem-lite.db'))).toContain(
      `\`${CLI_INVOKE} doctor\``,
    );
    const elsewhere = join(dataDir(), 'claude-mem-lite.db');
    expect(du.formatDbUnusableModelNotice(elsewhere)).toContain(
      `\`CLAUDE_MEM_DIR=${shellWord(dirname(elsewhere))} ${CLI_INVOKE} doctor\``,
    );
  });

  // r1 defects P3-2: a 2.16 GB snapshot took 28 s with nothing printed.
  it('doctor says which snapshot it is checking, on stderr', () => {
    const root = dataDir();
    const data = join(root, 'data');
    mkdirSync(data);
    writeFileSync(join(data, 'claude-mem-lite.db'), 'not actually sqlite');
    writeStoreSnapshot(join(data, 'claude-mem-lite.db.pre-delete-x.bak'), { observations: 2 });
    const home = join(root, 'home');
    mkdirSync(home);
    const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor'], {
      encoding: 'utf8',
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: data,
        PATH: pathWithClaudeStub(root),
        MEM_NO_AUTO_ADOPT: '1',
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
      },
    });
    expect(r.stdout, 'premise: doctor named the snapshot').toContain('claude-mem-lite.db.pre-delete-x.bak');
    expect(r.stderr).toContain('Checking backup snapshot 1 of 1: claude-mem-lite.db.pre-delete-x.bak');
  });
});
