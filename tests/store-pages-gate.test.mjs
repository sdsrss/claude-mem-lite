// D#593: every index rebuild checks the store's pages first (lib/store-pages.mjs) and writes nothing
// when they are damaged or could not be checked. A rebuild frees pages and allocates new ones, so on a
// store whose freelist lists a page a table still uses it writes the new index over that table's rows:
// v6.30.8's doctor FTS step, `fts-check rebuild`, `mem_fts_check rebuild` and the opener's FTS branch
// did that on the D#546 regression set (docs/audits/20261025-v6.30.9-pretag-r1-defects.md).

import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import * as schema from '../schema.mjs';
import { handleMemFtsCheck } from '../server/fts-check.mjs';
import { dataDirCopyCommand } from '../lib/db-unusable.mjs';
import { pathWithClaudeStub } from './claude-stub.mjs';
import { intactObservations, makeFixtureTracker, writeCrossLinkedStore } from './test-helpers.mjs';

const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());
const dataDir = () => fixtures.track(mkdtempSync(join(tmpdir(), 'cml-pagegate-')));
const storeIn = (dir) => join(dir, 'claude-mem-lite.db');
/**
 * The product's opener, once, on the store at `path` (named claude-mem-lite.db), in a child. The
 * first open of a store initSchema built writes, and on cross-linked pages any write can overwrite
 * rows (the ordinary-write exposure, D#546's line): fixtures for the opener's faces run it first.
 */
const openedByProduct = (path) => {
  const schemaUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.mjs')).href;
  execFileSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(schemaUrl)}).then((m) => m.ensureDbWithWalRecovery().close())`],
    { env: { ...process.env, CLAUDE_MEM_DIR: dirname(path), MEM_NO_AUTO_ADOPT: '1' }, timeout: 60_000 },
  );
};
/** sha1 of the main file and its log together (a missing log reads as an empty one). */
const sha = (path) => {
  const h = createHash('sha1').update(readFileSync(path));
  if (existsSync(`${path}-wal`)) h.update(readFileSync(`${path}-wal`));
  return h.digest('hex');
};

describe('rebuildFTS and rebuildIndexes write nothing on page-level damage', () => {
  // Named, not schema[name]: a computed member makes knip count every export of schema.mjs as used.
  for (const [name, rebuild] of [
    ['rebuildFTS', schema.rebuildFTS],
    ['rebuildIndexes', schema.rebuildIndexes],
  ]) {
    for (const vacuum of [false, true]) {
      it(`${name}${vacuum ? ' on a VACUUMed store' : ''}`, () => {
        const { path, truth, linked } = writeCrossLinkedStore(storeIn(dataDir()), { vacuum });
        expect(intactObservations(path, truth), 'premise').toBe(truth.length);
        const db = new Database(path);
        let r;
        let before;
        try {
          // Taken on the open handle: what this handle's own rebuild would add to the log.
          before = sha(path);
          r = rebuild(db);
          expect(sha(path), 'the rebuild wrote to the store or its log').toBe(before);
        } finally {
          db.close();
        }
        expect(intactObservations(path, truth), 'rows the rebuild overwrote').toBe(truth.length);
        expect(r.rebuilt).toEqual([]);
        expect(r.pages).toMatchObject({ state: 'damaged' });
        expect(r.errors).toEqual([expect.stringMatching(/^not rebuilt: the database's pages are damaged/)]);
        expect(r.errors[0]).toContain(`page ${linked[0]}: in the freelist and in observations`);
        expect(r.codes).toEqual(['SQLITE_CORRUPT']);
      });
    }
  }

  it('still rebuilds a store whose only damage is the search index', () => {
    const { path, truth } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0 });
    const db = new Database(path);
    try {
      expect(schema.checkFTSIntegrity(db).healthy, 'premise').toBe(false);
      const r = schema.rebuildIndexes(db);
      expect(r.errors).toEqual([]);
      expect(r.rebuilt).toEqual([
        'observations_fts',
        'session_summaries_fts',
        'user_prompts_fts',
        'events_fts',
        'indexes',
      ]);
      expect(r.pages).toMatchObject({ state: 'ok' });
    } finally {
      db.close();
    }
    // A fresh handle: what the rebuild committed, not what its own transaction sees.
    const after = new Database(path);
    try {
      expect(schema.checkFTSIntegrity(after).healthy).toBe(true);
    } finally {
      after.close();
    }
    expect(intactObservations(path, truth)).toBe(truth.length);
  });

  // "Could not check" is not "sound": a rebuild is refused, with the reason the check gave.
  it('refuses when the pages could not be checked', () => {
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);
      const r = schema.rebuildFTS(db);
      expect(r.rebuilt).toEqual([]);
      expect(r.pages).toMatchObject({ state: 'unchecked' });
      expect(r.errors).toEqual([
        "not rebuilt: the database's pages could not be checked first (an in-memory database has no file to read)",
      ]);
      expect(r.codes).toEqual([null]);
    } finally {
      db.close();
    }
  });
});

describe('doctor checks the pages first, on a read-only handle (D#593)', () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
  const env = (dir, home) => ({
    ...process.env,
    HOME: home,
    CLAUDE_MEM_DIR: dir,
    CLAUDE_PROJECT_DIR: home,
    PATH: pathWithClaudeStub(home),
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    MEM_QUIET_HOOKS: '1',
  });
  /** doctor --json on the store in `dir`; its exit code says nothing here (the sandbox has other issues). */
  const doctor = (dir, home, { json = true } = {}) => {
    const r = spawnSync(
      process.execPath,
      [join(REPO, 'install.mjs'), 'doctor', ...(json ? ['--json'] : [])],
      {
        encoding: 'utf8',
        env: env(dir, home),
        timeout: 120_000,
      },
    );
    return json ? JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) : r.stdout;
  };
  const home = () => {
    const h = dataDir();
    mkdirSync(join(h, '.claude'), { recursive: true });
    return h;
  };
  const dbChecks = (report) => report.checks.filter((c) => /^(Database|FTS5)/.test(c.message));

  it('a sound store: one ok line for the pages, and the FTS-only damage rebuilt as before', () => {
    const h = home();
    const dir = dataDir();
    const { path, truth } = writeCrossLinkedStore(storeIn(dir), { links: 0, prepare: openedByProduct });
    const report = doctor(dir, h);
    expect(dbChecks(report).map((c) => `${c.level} ${c.message.split(':')[0]}`)).toEqual([
      'ok Database pages',
      'ok FTS5 index',
      'warn FTS5 integrity issues detected',
      'ok FTS5 rebuilt',
    ]);
    expect(intactObservations(path, truth)).toBe(truth.length);
  }, 150_000);

  for (const inLog of [false, true]) {
    it(`damaged pages${inLog ? ' only in the log' : ''}: one ✗ and one issue, the copy command, nothing written`, () => {
      const h = home();
      const baseline = doctor(
        writeCrossLinkedStore(storeIn(dataDir()), { links: 0, ftsDamage: false }).path.replace(
          /\/claude-mem-lite\.db$/,
          '',
        ),
        h,
      );
      const dir = dataDir();
      const { path, truth, linked } = writeCrossLinkedStore(storeIn(dir), {
        prepare: inLog ? undefined : openedByProduct,
        inLog,
      });
      const before = sha(path);
      const report = doctor(dir, h);
      expect(sha(path), 'doctor wrote to the store or its log').toBe(before);
      expect(intactObservations(path, truth)).toBe(truth.length);
      const checks = dbChecks(report);
      expect(checks.filter((c) => c.level === 'fail')).toEqual([
        {
          level: 'fail',
          message: expect.stringMatching(
            new RegExp(`^Database pages: damaged — page ${linked[0]}: in the freelist and in observations`),
          ),
          details: expect.arrayContaining([
            expect.stringMatching(/^With no Claude Code session running, copy the data directory/),
            expect.stringMatching(/^test ! -e .* && cp -aL /),
          ]),
        },
      ]);
      expect(checks.find((c) => /^FTS5 integrity/.test(c.message))).toEqual({
        level: 'warn',
        message: 'FTS5 integrity: not checked — the database pages are damaged (above)',
      });
      expect(report.issues - baseline.issues, 'one damage, one issue').toBe(1);
    }, 150_000);
  }

  it('the human face prints the same ✗ and the copy command', () => {
    const dir = dataDir();
    const { linked } = writeCrossLinkedStore(storeIn(dir), { prepare: openedByProduct });
    const out = doctor(dir, home(), { json: false });
    expect(out).toMatch(
      new RegExp(`✗ Database pages: damaged — page ${linked[0]}: in the freelist and in observations`),
    );
    expect(out).toMatch(/test ! -e .* && cp -aL /);
    expect(out).toContain('⚠ FTS5 integrity: not checked — the database pages are damaged (above)');
  }, 150_000);
});

describe('the copy command doctor and fts-check print', () => {
  const nowMs = Date.parse('2026-11-01T12:00:00Z');
  const run = (command) => spawnSync('sh', ['-c', command]).status;

  it('copies the data directory beside itself, and a second run takes a new name', () => {
    const dir = join(dataDir(), 'data dir');
    mkdirSync(dir);
    const { path } = writeCrossLinkedStore(storeIn(dir), { links: 0, ftsDamage: false });
    const first = dataDirCopyCommand(path, { nowMs });
    expect(run(first), first).toBe(0);
    expect(sha(storeIn(`${dir}.copy-2026-11-01`))).toBe(sha(path));
    const second = dataDirCopyCommand(path, { nowMs });
    expect(second).toContain(`${dir}.copy-2026-11-01-1'`);
    expect(run(second), second).toBe(0);
    expect(sha(storeIn(`${dir}.copy-2026-11-01-1`))).toBe(sha(path));
  });

  it('stops before copying into a copy made after it was printed', () => {
    const dir = join(dataDir(), 'data');
    mkdirSync(dir);
    const { path } = writeCrossLinkedStore(storeIn(dir), { links: 0, ftsDamage: false });
    const command = dataDirCopyCommand(path, { nowMs });
    mkdirSync(`${dir}.copy-2026-11-01`);
    expect(run(command)).not.toBe(0);
    expect(existsSync(join(`${dir}.copy-2026-11-01`, 'data'))).toBe(false);
  });

  // A data directory moved to another disk and linked back is copied as data, beside the real one
  // (v6.30.9 r1b claims P1-1: `cp -a` copied the link), and so is a store file that is a link.
  it('copies data, not links, when the directory or the store file is a symlink', () => {
    const real = join(dataDir(), 'bigdisk');
    mkdirSync(real);
    const elsewhere = join(dataDir(), 'store.db');
    const { path: target } = writeCrossLinkedStore(elsewhere, { links: 0, ftsDamage: false });
    symlinkSync(target, storeIn(real));
    const linkDir = join(dataDir(), '.claude-mem-lite');
    symlinkSync(real, linkDir);
    const command = dataDirCopyCommand(storeIn(linkDir), { nowMs });
    expect(command).toContain(`${real}.copy-2026-11-01`);
    expect(command, 'the command names the link').not.toContain(linkDir);
    expect(run(command), command).toBe(0);
    const copied = storeIn(`${real}.copy-2026-11-01`);
    expect(lstatSync(`${real}.copy-2026-11-01`).isSymbolicLink(), 'the copy is a link').toBe(false);
    expect(lstatSync(copied).isSymbolicLink(), 'the store in the copy is a link').toBe(false);
    expect(sha(copied)).toBe(sha(target));
  });
});

describe('fts-check rebuild checks the pages before the opener (D#593)', () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
  const cli = (dir, ...args) =>
    spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'fts-check', ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: dir,
        CLAUDE_MEM_DIR: dir,
        CLAUDE_PROJECT_DIR: dir,
        MEM_NO_AUTO_ADOPT: '1',
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        MEM_QUIET_HOOKS: '1',
      },
      timeout: 60_000,
    });

  // initSchema built it and the product never opened it: the opener's first open writes (r1b claims
  // P3-6 measured the main file change and a page of a table the opener made on a live leaf).
  for (const inLog of [false, true]) {
    it(`refuses with the copy command and writes nothing${inLog ? ', damage only in the log' : ', before the first open'}`, () => {
      const dir = dataDir();
      const { path, truth, linked } = writeCrossLinkedStore(storeIn(dir), { inLog });
      const before = sha(path);
      const r = cli(dir, 'rebuild');
      expect(sha(path), 'fts-check rebuild wrote to the store or its log').toBe(before);
      expect(intactObservations(path, truth)).toBe(truth.length);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toMatch(/^\[mem\] Not rebuilt: the database's pages are damaged/);
      expect(r.stdout).toContain(`  page ${linked[0]}: in the freelist and in observations`);
      expect(r.stdout).toMatch(/^ {2}test ! -e .* && cp -aL /m);
    });
  }

  // A read-only data directory: the read-only handle cannot make the log index, so the pages are not
  // checked, and "not checked" stops the rebuild before the opener as damage does.
  it('refuses when the pages could not be checked, before the opener', () => {
    const dir = dataDir();
    const { path } = writeCrossLinkedStore(storeIn(dir), { links: 0, ftsDamage: false });
    const before = sha(path);
    chmodSync(dir, 0o555);
    let r;
    try {
      r = cli(dir, 'rebuild');
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(r.stdout, r.stderr).toMatch(
      /^\[mem\] Not rebuilt: the database's pages could not be checked first \(.+\)\.$/m,
    );
    expect(r.status).toBe(1);
    expect(sha(path)).toBe(before);
  });

  it('still rebuilds a store whose only damage is the search index', () => {
    const dir = dataDir();
    const { path, truth } = writeCrossLinkedStore(storeIn(dir), { links: 0 });
    const r = cli(dir, 'rebuild');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^\[mem\] Successfully rebuilt: observations_fts/);
    expect(intactObservations(path, truth)).toBe(truth.length);
  });

  it('fts-check check is not stopped by the page check', () => {
    const dir = dataDir();
    writeCrossLinkedStore(storeIn(dir), { ftsDamage: false });
    const r = cli(dir, 'check');
    expect(r.stdout).not.toMatch(/Not rebuilt/);
    expect(r.stdout).toMatch(/FTS5/);
  });
});

describe('the other faces of a refused rebuild (D#593)', () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
  const BSQ_URL = pathToFileURL(createRequire(import.meta.url).resolve('better-sqlite3')).href;
  const SCHEMA_URL = pathToFileURL(join(REPO, 'schema.mjs')).href;

  it('mem_fts_check rebuild: says not rebuilt and why, gives the model no command, writes nothing', () => {
    const { path, truth, linked } = writeCrossLinkedStore(storeIn(dataDir()));
    const db = new Database(path);
    let text;
    try {
      const before = sha(path);
      text = handleMemFtsCheck(db, { action: 'rebuild' }).content[0].text;
      expect(sha(path), 'mem_fts_check wrote to the store or its log').toBe(before);
    } finally {
      db.close();
    }
    expect(intactObservations(path, truth)).toBe(truth.length);
    expect(text).toMatch(
      /^Not rebuilt: the database's pages are damaged, so a rebuild could overwrite rows on them \(/,
    );
    expect(text).toContain(`page ${linked[0]}: in the freelist and in observations`);
    expect(text).toContain('copy the data directory before anything writes to it again');
    expect(text).not.toMatch(/cp -a|test ! -e/);
  });

  // The opener every face uses rebuilds the FTS5 indexes when the open fails with
  // SQLITE_CORRUPT_VTAB; the fault is injected `times` times, as tests/wal-recovery.test.mjs does.
  const openWithInjectedVtabFault = (dir, times) => {
    const src = `
      Promise.all([import(${JSON.stringify(BSQ_URL)}), import(${JSON.stringify(SCHEMA_URL)})]).then(([{ default: Database }, m]) => {
        let thrown = 0;
        const orig = Database.prototype.pragma;
        Database.prototype.pragma = function (sql, ...rest) {
          if (thrown < ${times} && /^\\s*journal_mode\\s*=\\s*WAL/i.test(sql)) {
            thrown++;
            throw new Database.SqliteError('database disk image is malformed', 'SQLITE_CORRUPT_VTAB');
          }
          return orig.call(this, sql, ...rest);
        };
        const msgs = [];
        let attempted;
        try { m.ensureDbWithWalRecovery({ warn: (x) => msgs.push(x), info: (x) => msgs.push(x) }).close(); }
        catch (e) { attempted = e.ftsRebuildAttempted; }
        console.log(JSON.stringify({ thrown, msgs, attempted }));
      });`;
    const out = execFileSync(process.execPath, ['-e', src], {
      env: { ...process.env, CLAUDE_MEM_DIR: dir, MEM_NO_AUTO_ADOPT: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return JSON.parse(out.trim().split('\n').pop());
  };

  it('the opener: no rebuild over damaged pages, and it does not say it recovered by one', () => {
    const dir = dataDir();
    const { path, truth } = writeCrossLinkedStore(storeIn(dir), { inLog: true, prepare: openedByProduct });
    const r = openWithInjectedVtabFault(dir, 1);
    expect(r.thrown, 'the injected fault must have fired').toBe(1);
    expect(r.msgs.join('\n')).toContain('FTS index corruption detected');
    expect(r.msgs.join('\n')).toMatch(/FTS rebuild reported: not rebuilt: the database's pages are damaged/);
    expect(r.msgs).toContain('DB opened; the FTS indexes were not rebuilt');
    expect(r.msgs).not.toContain('DB recovered after FTS rebuild');
    expect(intactObservations(path, truth)).toBe(truth.length);
  });

  it('the opener: ftsRebuildAttempted says whether a rebuild ran when the retry fails too', () => {
    const damaged = dataDir();
    writeCrossLinkedStore(storeIn(damaged), { inLog: true });
    expect(openWithInjectedVtabFault(damaged, 2)).toMatchObject({ thrown: 2, attempted: false });
    const sound = dataDir();
    writeCrossLinkedStore(storeIn(sound), { links: 0, inLog: true });
    expect(openWithInjectedVtabFault(sound, 2)).toMatchObject({ thrown: 2, attempted: true });
  });

  it('the opener on sound pages still rebuilds and says so', () => {
    const dir = dataDir();
    writeCrossLinkedStore(storeIn(dir), { links: 0, inLog: true });
    const r = openWithInjectedVtabFault(dir, 1);
    expect(r.msgs).toContain('DB recovered after FTS rebuild');
  });
});
