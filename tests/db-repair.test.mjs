// D#541: `repair-db` reads what SQLite still can into a fresh file, checks it, and writes it back
// into the store when no other process holds it. Most plants below are page damage in the main
// file at offsets calibrated on 2026-10-21 (SQLite 3.53.4): a table leaf's header stops a rowid
// scan part-way, an index leaf's body and an FTS5 data leaf's header leave every row readable, a
// leaf's cell count drops rows from a scan without an error, and page 1's header makes the file
// "not a database". The log plants damage the newest frame of a page in a valid log, re-signed,
// as the v6.30.3 sweep did (docs/audits/20261021-v6.30.3-pretag-defects.md, Appendix A).
import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { initSchema } from '../schema.mjs';
import { ensureSearchTelemetrySchema } from '../lib/search-telemetry.mjs';
import { insertObs, insertPrompt, insertSession, makeFixtureTracker } from './test-helpers.mjs';
import { readIntegrity, checkIntegrity, probeExclusive, repairDb } from '../lib/db-repair.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'claude-mem-lite.db';
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

const sha = (p) => createHash('sha1').update(readFileSync(p)).digest('hex');
const newDir = () => fixtures.track(mkdtempSync(join(tmpdir(), 'cml-db-repair-')));

/**
 * A store with `rows` observations (several leaf pages), one session and one prompt. `interleave`
 * writes a prompt after each observation, so the two tables' pages alternate in the file and a
 * fresh copy, which writes one table after the other, lays them out differently.
 */
function buildStore(dir, { rows = 300, interleave = false, pageSize = 4096 } = {}) {
  const p = join(dir, DB);
  const db = new Database(p);
  db.pragma(`page_size = ${pageSize}`);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  insertSession(db, { id: 'sess-1' });
  for (let i = 0; i < rows; i++) {
    insertObs(db, {
      title: `obs ${i} alpha`,
      narrative: `${'n'.repeat(300)} word${i}`,
      project: `p${i % 3}`,
      epochOffset: i,
    });
    if (interleave) insertPrompt(db, { text: `${'p'.repeat(200)} ${i}`, promptNumber: 1000 + i });
  }
  insertPrompt(db, { text: 'a prompt to keep' });
  db.close();
  return p;
}

/**
 * The v6.30.3 sweep's fixture: 200 observations checkpointed into the main file, then a log of 40
 * more, a VACUUM and one more, so every page has a frame in the log. Returns the main file alone's
 * record too.
 */
function walStore(dir) {
  const p = join(dir, DB);
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  for (const s of ['s1', 's2']) {
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch) VALUES (?, ?, 'p', datetime('now'), 1)`,
    ).run(`c-${s}`, s);
  }
  const ins = (s) =>
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch) VALUES ('${s}', 'p', 'discovery', ?, ?, datetime('now'), ?)`,
    );
  for (let i = 0; i < 200; i++)
    ins('s1').run(`title ${i} alpha`, `narrative ${i} gamma ${'x'.repeat(i % 50)}`, 1e12 + i);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const pristine = readFileSync(p);
  const raw = new Database(p);
  const late = raw.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch) VALUES ('s2', 'p', 'discovery', ?, ?, datetime('now'), ?)`,
  );
  for (let i = 0; i < 40; i++) late.run(`late ${i} zeta`, `late narrative ${i}`, 2e12 + i);
  raw.exec('VACUUM');
  late.run('last one', 'final narrative', 3e12);
  const wal = readFileSync(`${p}-wal`);
  raw.close();
  writeFileSync(p, pristine);
  writeFileSync(`${p}-wal`, wal);
  rmSync(`${p}-shm`, { force: true });
  const alone = join(dir, 'main-alone.db');
  writeFileSync(alone, pristine);
  const mainAlone = record(alone);
  for (const ext of ['', '-wal', '-shm']) rmSync(alone + ext, { force: true });
  return { p, mainAlone };
}

function walChecksum(buf, s0, s1, be) {
  for (let i = 0; i + 7 < buf.length; i += 8) {
    const a = be ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
    const b = be ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
    s0 = (s0 + a + s1) >>> 0;
    s1 = (s1 + b + s0) >>> 0;
  }
  return [s0, s1];
}

/** Fill bytes of the newest log frame of page `pg` and re-sign the frame chain. */
function plantWal(p, pg, offset, length, fill) {
  const wal = Buffer.from(readFileSync(`${p}-wal`));
  const be = wal.readUInt32BE(0) === 0x377f0683;
  const ps = wal.readUInt32BE(8);
  const frames = [];
  for (let o = 32; o + 24 + ps <= wal.length; o += 24 + ps) frames.push({ o, pg: wal.readUInt32BE(o) });
  const target = frames.filter((f) => f.pg === pg).at(-1);
  wal.fill(fill, target.o + 24 + offset, target.o + 24 + offset + length);
  let [s0, s1] = walChecksum(wal.subarray(0, 24), 0, 0, be);
  for (const f of frames) {
    [s0, s1] = walChecksum(wal.subarray(f.o, f.o + 8), s0, s1, be);
    [s0, s1] = walChecksum(wal.subarray(f.o + 24, f.o + 24 + ps), s0, s1, be);
    wal.writeUInt32BE(s0, f.o + 16);
    wal.writeUInt32BE(s1, f.o + 20);
  }
  writeFileSync(`${p}-wal`, wal);
  rmSync(`${p}-shm`, { force: true });
}

/** Ordinary tables (no FTS virtual or shadow table) and their rows, JSON per row, by rowid. */
function record(p) {
  const db = new Database(p, { readonly: true });
  try {
    const virtual = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`)
      .pluck()
      .all();
    const shadow = (n) => virtual.some((v) => n.startsWith(`${v}_`));
    const out = {};
    for (const t of db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).pluck().all()) {
      if (virtual.includes(t) || shadow(t)) continue;
      const stmt = db.prepare(`SELECT rowid AS __rowid, * FROM "${t}" ORDER BY rowid`).safeIntegers(true);
      out[t] = stmt.all().map((r) => JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? `${v}` : v)));
    }
    return out;
  } finally {
    db.close();
  }
}

const sameExceptVersion = (after, before) => {
  for (const t of Object.keys(before)) expect(after[t], t).toEqual(before[t]);
};

function pages(p, name, type = 'leaf') {
  const db = new Database(p, { readonly: true });
  try {
    return db
      .prepare(`SELECT pageno FROM dbstat WHERE name = ? AND pagetype = ? ORDER BY pageno`)
      .pluck()
      .all(name, type);
  } finally {
    db.close();
  }
}

function plant(p, pageno, offset, bytes, pageSize = 4096) {
  const fd = openSync(p, 'r+');
  try {
    writeSync(fd, Buffer.from(bytes), 0, bytes.length, (pageno - 1) * pageSize + offset);
  } finally {
    closeSync(fd);
  }
}

const tmpLeft = (dir) => readdirSync(dir).filter((n) => /\.repair-/.test(n));
const asides = (dir) => readdirSync(dir).filter((n) => /\.damaged-/.test(n) && !/-(wal|shm)$/.test(n));
const text = (r) => r.lines.map((l) => l.text).join('\n');
const run = (p, opts = {}) => repairDb(p, { lockPath: join(dirname(p), 'install.lock'), ...opts });
const premise = (p) => expect(checkIntegrity(p).ok, 'premise: the plant fails integrity_check').toBe(false);
const ids = (rows) => rows.map((row) => Number(JSON.parse(row).id));

/**
 * A store whose log holds a damaged index frame: a checkpoint, which a read-write close does, would
 * change the main file's bytes, so a test on it can see one (round-2 defects F16).
 */
function damagedLog() {
  const dir = newDir();
  const { p } = walStore(dir);
  plantWal(p, pages(p, 'idx_obs_project_live')[0], 1000, 64, 0x41);
  premise(p);
  return { dir, p };
}

function indexDamaged() {
  const dir = newDir();
  const p = buildStore(dir);
  const before = record(p);
  plant(p, pages(p, 'idx_obs_project_live')[0], 1000, Array(64).fill(0x41));
  premise(p);
  return { dir, p, before };
}

/**
 * A child process with a read-write connection open on `p`; `read` decides whether it has read.
 * `write()` inserts 20 prompts and keeps the connection open; `close()` closes it.
 */
function holdInChild(p, { read = true } = {}) {
  const code = `
    const D = require('better-sqlite3');
    const db = new D(process.argv[1]);
    if (process.argv[2] === 'read') db.prepare('SELECT count(*) FROM sqlite_master').get();
    process.stdout.write('held\\n');
    process.stdin.on('data', (d) => {
      if (String(d).trim() === 'close') {
        db.close();
        process.exit(0);
      }
      try {
        db.pragma('journal_mode = WAL');
        const ins = db.prepare("INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch) VALUES ('sess-1', 'written by the holder', ?, 'x', 1)");
        for (let i = 0; i < 20; i++) ins.run(5000 + i);
        process.stdout.write('wrote\\n');
      } catch (e) {
        process.stdout.write('ERR ' + e.code + '\\n');
      }
    });
  `;
  const child = spawn(process.execPath, ['-e', code, p, read ? 'read' : 'open'], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const next = () => new Promise((done) => child.stdout.once('data', (d) => done(String(d).trim())));
  return new Promise((ok, fail) => {
    child.on('error', fail);
    next().then(() =>
      ok({
        write: () => {
          const out = next();
          child.stdin.write('write\n');
          return out;
        },
        close: () =>
          new Promise((done) => {
            child.on('exit', done);
            child.stdin.write('close\n');
          }),
      }),
    );
  });
}

describe('readIntegrity', () => {
  it('keeps the rows integrity_check yields before it throws', () => {
    const dir = newDir();
    const p = buildStore(dir);
    const leaf = pages(p, 'observations');
    plant(p, leaf[Math.floor(leaf.length / 2)], 0, Array(8).fill(0x41));
    const db = new Database(p, { readonly: true });
    try {
      const r = readIntegrity(db);
      expect(r.ok).toBe(false);
      // Measured: two problem rows, then SQLITE_CORRUPT from the iterator. `.all()` loses the rows.
      expect(r.problems.length).toBeGreaterThan(1);
      expect(r.problems.some((x) => /btreeInitPage|Tree \d+ page/.test(x))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('reads a sound store as ok with no problems', () => {
    const p = buildStore(newDir(), { rows: 3 });
    expect(checkIntegrity(p)).toEqual({ ok: true, problems: [] });
  });

  it('reports a file that is not a database as damage rather than throwing', () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 3 });
    plant(p, 1, 0, Array(16).fill(0x41));
    const r = checkIntegrity(p);
    expect(r.ok).toBe(false);
    expect(r.notChecked).toBeUndefined();
    expect(r.problems.join(' ')).toMatch(/not a database/);
  });

  // An FTS5 table whose stored options are damaged fails to connect with SQLITE_ERROR, which the
  // first narrowing of this classifier read as "could not check" (pre-tag review, plant p78-v8).
  it('reads an FTS5 table that will not connect as damage', () => {
    const p = buildStore(newDir(), { rows: 3 });
    const db = new Database(p);
    db.unsafeMode(true);
    db.exec("UPDATE observations_fts_config SET v = 99 WHERE k = 'version'");
    db.close();
    const r = checkIntegrity(p);
    expect(r.ok).toBe(false);
    expect(r.notChecked).toBeUndefined();
    expect(r.problems.join(' ')).toMatch(/fts5/i);
  });
});

describe('probeExclusive', () => {
  it('takes the lock on a store nothing else holds', () => {
    expect(probeExclusive(buildStore(newDir(), { rows: 3 }))).toMatchObject({ acquired: true });
  });

  it('reads another process holding the store as busy', async () => {
    const p = buildStore(newDir(), { rows: 3 });
    const holder = await holdInChild(p);
    try {
      expect(probeExclusive(p)).toMatchObject({ acquired: false, busy: true });
    } finally {
      await holder.close();
    }
    expect(probeExclusive(p)).toMatchObject({ acquired: true });
  });
});

describe('repairDb', () => {
  it('leaves a sound store alone', async () => {
    const dir = newDir();
    const p = buildStore(dir);
    const before = sha(p);
    const r = await run(p);
    expect(r.outcome).toBe('healthy');
    expect(r.exitCode).toBe(0);
    expect(text(r)).toMatch(/nothing to repair/i);
    expect(sha(p)).toBe(before);
    expect(asides(dir)).toEqual([]);
  });

  it('repairs a damaged index: every row kept, the store sound, the store as found kept', async () => {
    const { dir, p, before } = indexDamaged();
    const original = sha(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(r.exitCode).toBe(0);
    sameExceptVersion(record(p), before);
    expect(checkIntegrity(p)).toEqual({ ok: true, problems: [] });
    const [aside] = asides(dir);
    expect(aside).toBeDefined();
    expect(sha(join(dir, aside)), 'the store as found, byte for byte').toBe(original);
    expect(text(r)).toContain(join(dir, aside));
    expect(tmpLeft(dir)).toEqual([]);
  });

  it('reads the rows still in the log, and keeps the main file and log as found', async () => {
    const dir = newDir();
    const src = buildStore(newDir());
    // A second connection keeps the log from being checkpointed when the writer closes, so the
    // copied pair holds committed rows only in its log.
    const holder = new Database(src);
    holder.prepare('SELECT count(*) FROM sqlite_master').get();
    const writer = new Database(src);
    for (let i = 0; i < 40; i++) insertObs(writer, { title: `in the log ${i}`, narrative: 'wal row' });
    writer.close();
    const p = join(dir, DB);
    copyFileSync(src, p);
    copyFileSync(`${src}-wal`, `${p}-wal`);
    holder.close();
    const before = record(p);
    expect(before.observations.length).toBe(340);
    plant(p, pages(p, 'idx_obs_project_live')[0], 1000, Array(64).fill(0x41));
    premise(p);
    const [mainSha, walSha] = [sha(p), sha(`${p}-wal`)];
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(record(p).observations).toEqual(before.observations);
    const [aside] = asides(dir);
    expect(sha(join(dir, aside))).toBe(mainSha);
    expect(sha(join(dir, `${aside}-wal`))).toBe(walSha);
  });

  it('copies the rows around an unreadable leaf and names the ones it lost by id', async () => {
    const dir = newDir();
    const p = buildStore(dir);
    const before = record(p).observations.map((row) => JSON.parse(row));
    const leaf = pages(p, 'observations');
    plant(p, leaf[Math.floor(leaf.length / 2)], 0, Array(8).fill(0x41));
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    const after = record(p).observations.map((row) => JSON.parse(row));
    const byId = new Map(before.map((row) => [row.id, row]));
    for (const row of after) expect(row).toEqual(byId.get(row.id));
    const lost = before.filter((row) => !after.some((a) => a.id === row.id)).map((row) => Number(row.id));
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.length).toBeLessThan(20);
    expect(r.tables.observations.missing.map(Number)).toEqual(lost);
    expect(text(r)).toMatch(
      new RegExp(
        `observations: ${lost.length} row\\(s\\) an index lists could not be read \\(ids ${lost[0]}, `,
      ),
    );
    expect(checkIntegrity(p).ok).toBe(true);
  });

  // First pre-tag review: forward until the first damaged leaf and backward until the last one
  // dropped every readable row between two damaged leaves (288 of 306 in its repro).
  it('copies the readable rows between two unreadable leaves', async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 600 });
    const before = ids(record(p).observations);
    const leaf = pages(p, 'observations');
    plant(p, leaf[Math.floor(leaf.length / 4)], 0, Array(8).fill(0x41));
    plant(p, leaf[Math.floor((3 * leaf.length) / 4)], 0, Array(8).fill(0x41));
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    const after = ids(record(p).observations);
    const lost = before.filter((id) => !after.includes(id));
    // Two leaves of ~9 rows each, nothing between them.
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.length).toBeLessThan(40);
    expect(r.tables.observations.missing.map(Number)).toEqual(lost);
  });

  it('names the rows a damaged cell count drops from the scan without an error', async () => {
    const dir = newDir();
    const p = buildStore(dir);
    const before = ids(record(p).observations);
    const leaf = pages(p, 'observations')[5];
    plant(p, leaf, 3, [0, 1]);
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    const lost = before.filter((id) => !ids(record(p).observations).includes(id));
    expect(lost.length).toBeGreaterThan(0);
    expect(r.tables.observations.missing.map(Number)).toEqual(lost);
    expect(text(r)).toMatch(/observations: \d+ row\(s\) an index lists could not be read/);
  });

  it('rebuilds a damaged FTS5 index in the fresh file', async () => {
    const dir = newDir();
    const p = buildStore(dir);
    plant(p, pages(p, 'observations_fts_data')[0], 0, Array(8).fill(0x41));
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    const db = new Database(p, { readonly: true });
    try {
      expect(
        db
          .prepare(`SELECT count(*) FROM observations_fts WHERE observations_fts MATCH 'word123'`)
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      db.close();
    }
    expect(checkIntegrity(p).ok).toBe(true);
  });

  it('repairs a store whose FTS5 table will not connect', async () => {
    const dir = newDir();
    const p = buildStore(dir);
    const before = record(p);
    const db = new Database(p);
    db.unsafeMode(true);
    db.exec("UPDATE observations_fts_config SET v = 99 WHERE k = 'version'");
    db.close();
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    const after = record(p);
    for (const t of Object.keys(before).filter((t) => !t.endsWith('_config')))
      expect(after[t], t).toEqual(before[t]);
  });

  it('reads past a schema row SQLite cannot parse', async () => {
    const dir = newDir();
    const p = buildStore(dir);
    const before = record(p);
    const db = new Database(p);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare(
      `INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES ('table', 'zz', 'zz', 0, 'CREATE TABLE zz (')`,
    ).run();
    db.close();
    // Premise. The handle is closed: one left open is a holder, and the repair rightly refuses.
    const reader = new Database(p, { readonly: true });
    try {
      expect(() => reader.prepare('SELECT 1 FROM observations').get()).toThrow(/malformed database schema/);
    } finally {
      reader.close();
    }
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    sameExceptVersion(record(p), before);
    expect(text(r)).toMatch(/zz: could not be read \(its definition does not parse\)/);
  });

  // The 869-plant sweep of the second round (p61-v1): with the FTS table's definition damaged,
  // its shadow tables read as tables of their own, and making one in the fresh file failed.
  it('repairs a store whose FTS5 table definition does not parse', async () => {
    const dir = newDir();
    const p = buildStore(dir);
    const before = record(p);
    const db = new Database(p);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare(
      `UPDATE sqlite_master SET sql = replace(sql, 'VIRTUAL', 'VIRTAAL') WHERE name = 'observations_fts'`,
    ).run();
    db.close();
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    const after = record(p);
    for (const t of Object.keys(before).filter((t) => !t.startsWith('observations_fts')))
      expect(after[t], t).toEqual(before[t]);
    const ro = new Database(p, { readonly: true });
    try {
      expect(
        ro
          .prepare(`SELECT count(*) FROM observations_fts WHERE observations_fts MATCH 'word123'`)
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      ro.close();
    }
  });

  // First pre-tag review: tables the product makes on first use (search telemetry, the CJK walk's
  // cursor) were dropped with exit 0 and no line.
  it('keeps a table this version does not create, with its index', async () => {
    const dir = newDir();
    const p = buildStore(dir);
    const db = new Database(p);
    db.exec(
      'CREATE TABLE made_later (id INTEGER PRIMARY KEY, v TEXT NOT NULL); CREATE INDEX idx_made_later_v ON made_later(v)',
    );
    for (let i = 0; i < 50; i++) db.prepare('INSERT INTO made_later (v) VALUES (?)').run(`value ${i}`);
    db.close();
    const before = record(p);
    plant(p, pages(p, 'idx_obs_project_live')[0], 1000, Array(64).fill(0x41));
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    sameExceptVersion(record(p), before);
    const ro = new Database(p, { readonly: true });
    try {
      expect(
        ro.prepare(`SELECT count(*) FROM sqlite_master WHERE name = 'idx_made_later_v'`).pluck().get(),
      ).toBe(1);
    } finally {
      ro.close();
    }
  });

  // The P1 of the first pre-tag review: a read-write close before the refusal wrote a damaged log
  // frame into a main file that alone still read, and starting a session would have kept it.
  it('reads the main file alone when the log makes the store unreadable, writing nothing first', async () => {
    const dir = newDir();
    const { p, mainAlone } = walStore(dir);
    const schemaLeaves = pages(p, 'sqlite_schema').filter((pg) => pg !== 1);
    plantWal(p, schemaLeaves[0], 0, 64, 0xff);
    const reader = new Database(p, { readonly: true });
    try {
      expect(
        () => reader.prepare('SELECT count(*) FROM observations').get(),
        'premise: the store does not read',
      ).toThrow();
    } finally {
      reader.close();
    }
    const [mainSha, walSha] = [sha(p), sha(`${p}-wal`)];
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(text(r)).toMatch(/read from the database file alone/);
    sameExceptVersion(record(p), mainAlone);
    const [aside] = asides(dir);
    expect(sha(join(dir, aside))).toBe(mainSha);
    expect(sha(join(dir, `${aside}-wal`))).toBe(walSha);
  });

  // The 869-plant sweep of the second round (p1-v0, p1-v1): the lock probe's read-write close
  // wrote the damaged first-page frame into a main file that alone read, before this refusal.
  it('leaves the checked copy to put in place, writing nothing, when the store is not a database', async () => {
    const dir = newDir();
    const { p, mainAlone } = walStore(dir);
    plantWal(p, 1, 0, 64, 0xff);
    premise(p);
    const [mainSha, walSha] = [sha(p), sha(`${p}-wal`)];
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('refused');
    expect(text(r)).toMatch(/not a database/);
    expect(text(r)).toMatch(/the database is as it was/);
    expect(text(r)).toMatch(/read from the database file without its log/);
    expect([sha(p), sha(`${p}-wal`)]).toEqual([mainSha, walSha]);
    const cmd = r.lines.at(-1).text;
    expect(cmd).toMatch(/^rm -f .* && mv .*\.repaired-.* /);
    const [aside] = asides(dir);
    expect(aside).toBeDefined();
    expect(spawnSync('sh', ['-c', cmd]).status).toBe(0);
    sameExceptVersion(record(p), mainAlone);
    expect(checkIntegrity(p).ok).toBe(true);
  });

  it('leaves the file as the product builds it: triggers, ids, mode', async () => {
    const dir = newDir();
    const p = buildStore(dir);
    // The last five rows deleted: sqlite_sequence stays at 300 while max(id) is 295, and an id
    // handed out again would collide with references to the deleted rows.
    const w = new Database(p);
    w.prepare('DELETE FROM observations WHERE id > 295').run();
    const triggersBefore = w
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
      .all();
    w.close();
    plant(p, pages(p, 'idx_obs_project_live')[0], 1000, Array(64).fill(0x41));
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    const db = new Database(p);
    try {
      expect(
        db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`).all(),
      ).toEqual(triggersBefore);
      const id = Number(insertObs(db, { title: 'after the repair', narrative: 'zebracorn' }).lastInsertRowid);
      expect(id).toBe(301);
      // The FTS sync trigger fires again.
      expect(
        db
          .prepare(`SELECT count(*) FROM observations_fts WHERE observations_fts MATCH 'zebracorn'`)
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  // The backup API cannot write a WAL database of another page size into this one.
  it('repairs a store whose page size is not the default', async () => {
    const dir = newDir();
    const p = buildStore(dir, { pageSize: 8192 });
    const before = record(p);
    plant(p, pages(p, 'idx_obs_project_live')[0], 0, Array(8).fill(0x41), 8192);
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    sameExceptVersion(record(p), before);
    const ro = new Database(p, { readonly: true });
    try {
      expect(ro.pragma('page_size', { simple: true })).toBe(8192);
    } finally {
      ro.close();
    }
  });

  it('repairs the target of a symlinked path and leaves the link a link', async () => {
    const dir = newDir();
    mkdirSync(join(dir, 'real'));
    mkdirSync(join(dir, 'data'));
    const target = buildStore(join(dir, 'real'));
    const link = join(dir, 'data', DB);
    symlinkSync(target, link);
    const before = record(target);
    plant(target, pages(target, 'idx_obs_project_live')[0], 1000, Array(64).fill(0x41));
    premise(target);
    const r = await run(link);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    sameExceptVersion(record(target), before);
    expect(asides(join(dir, 'real')).length).toBe(1);
  });

  it('refuses when not one observation can be read, writing nothing, and prints the set-aside instead', async () => {
    const dir = newDir();
    const p = buildStore(dir);
    const ro = new Database(p, { readonly: true });
    const root = ro.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'observations'`).pluck().get();
    ro.close();
    plant(p, root, 0, Array(8).fill(0x41));
    premise(p);
    const original = sha(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('refused');
    expect(text(r)).toMatch(/no observation could be read/);
    expect(text(r)).toMatch(/touch .* && ln /);
    expect(sha(p)).toBe(original);
    expect(asides(dir)).toEqual([]);
    expect(tmpLeft(dir)).toEqual([]);
  });

  // p10-v5 in the 869-plant sweep: every observation read NULL in a column the fresh schema
  // declares NOT NULL, all inserts failed, and a copy that did not count them came out sound,
  // empty, and read as healthy by doctor.
  /** A store whose observations allow NULL in decay_seen_count, which this version declares NOT NULL. */
  function nullable(where) {
    const dir = newDir();
    const p = buildStore(dir);
    const db = new Database(p);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare(
      `UPDATE sqlite_master SET sql = replace(sql, 'decay_seen_count INTEGER NOT NULL DEFAULT 0', 'decay_seen_count INTEGER') WHERE name = 'observations'`,
    ).run();
    db.close();
    const db2 = new Database(p);
    db2.prepare(`UPDATE observations SET decay_seen_count = NULL WHERE ${where}`).run();
    db2.close();
    plant(p, pages(p, 'idx_obs_project_live')[0], 1000, Array(64).fill(0x41));
    premise(p);
    return { dir, p };
  }

  // A row a damaged page garbles reads with NULLs or values the schema forbids; one row is not a
  // reason to keep the whole store damaged (round-2 defects F6: 56 of 530 plants ended in a
  // refusal with no next step).
  it('repairs around a row that cannot be written, and names it by id', async () => {
    const { p } = nullable('id = 7');
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(text(r)).toMatch(
      /observations: 1 row\(s\) could not be written to the fresh file \(NOT NULL[^)]*\): ids 7\./,
    );
    expect(r.tables.observations.written).toBe(299);
    expect(checkIntegrity(p).ok).toBe(true);
  });

  // No row of a table written is a schema read wrong, not damaged rows: refuse, write nothing, and
  // give the fallback rather than a dead end.
  it('refuses, writing nothing, when no row of a table can be written, and prints the fallback', async () => {
    const { dir, p } = nullable('1');
    const original = sha(p);
    const r = await run(p);
    expect(r.outcome).toBe('refused');
    expect(r.exitCode).toBe(1);
    expect(text(r)).toMatch(
      /observations: none of its 300 rows could be written to the fresh file \(NOT NULL/,
    );
    expect(text(r)).toMatch(/Once every Claude Code session is closed, run:/);
    expect(sha(p)).toBe(original);
    expect(asides(dir)).toEqual([]);
    expect(tmpLeft(dir)).toEqual([]);
  });

  it('refuses while another process holds the store, and leaves its files as they were', async () => {
    const { dir, p } = damagedLog();
    const holder = await holdInChild(p);
    const state = () => [sha(p), existsSync(`${p}-wal`) ? sha(`${p}-wal`) : null];
    const found = state();
    let r;
    try {
      r = await run(p);
      // Checked before the holder's own close: a busy probe is not the last connection, so it
      // checkpoints nothing, and everything before it only read.
      expect(state()).toEqual(found);
    } finally {
      await holder.close();
    }
    expect(r.outcome).toBe('refused');
    expect(r.exitCode).toBe(1);
    expect(text(r)).toMatch(/every Claude Code session/);
    expect(asides(dir)).toEqual([]);
    expect(tmpLeft(dir)).toEqual([]);
  });

  // First pre-tag review: a handle opened before the repair and used after it corrupted a store
  // that had been renamed in: it kept the old inode and named its log after the path. On a store
  // whose layout differs from the fresh copy's, that read SQLITE_CORRUPT while the handle was
  // open (measured on b337fe8a). Written into place, the store is one database for every handle.
  it('keeps the store sound for a connection opened before the repair and used after it', async () => {
    const dir = newDir();
    const p = buildStore(dir, { interleave: true });
    plant(p, pages(p, 'idx_obs_project_live')[0], 1000, Array(64).fill(0x41));
    premise(p);
    const holder = await holdInChild(p, { read: false });
    try {
      const r = await run(p);
      expect(r.outcome, text(r)).toBe('repaired');
      expect(await holder.write()).toBe('wrote');
      expect(checkIntegrity(p), 'while the handle is open').toEqual({ ok: true, problems: [] });
      const other = new Database(p);
      other.prepare('SELECT count(*) FROM observations').get();
      other.close();
      expect(checkIntegrity(p), 'after another connection opened and closed').toEqual({
        ok: true,
        problems: [],
      });
    } finally {
      await holder.close();
    }
    expect(checkIntegrity(p)).toEqual({ ok: true, problems: [] });
    const ro = new Database(p, { readonly: true });
    try {
      expect(
        ro
          .prepare(`SELECT count(*) FROM user_prompts WHERE prompt_text = 'written by the holder'`)
          .pluck()
          .get(),
      ).toBe(20);
      expect(ro.prepare('SELECT count(*) FROM observations').pluck().get()).toBe(300);
    } finally {
      ro.close();
    }
  });

  it('refuses when the store is written between the read and the write-back', async () => {
    const { dir, p } = indexDamaged();
    const r = await run(p, {
      afterCopy: () => {
        const w = new Database(p);
        try {
          insertObs(w, { title: 'written during the repair' });
        } finally {
          w.close();
        }
      },
    });
    expect(r.outcome).toBe('refused');
    expect(text(r)).toMatch(/changed while it was being read/);
    expect(asides(dir)).toEqual([]);
    expect(tmpLeft(dir)).toEqual([]);
    const db = new Database(p, { readonly: true });
    try {
      expect(
        db
          .prepare(`SELECT count(*) FROM observations WHERE title = 'written during the repair'`)
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  // "unable to open database file" is a permission or path fault, not damage: no set-aside.
  it('refuses a store it cannot open, without offering to move it', async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 3 });
    mkdirSync(`${p}-wal`);
    const integrity = checkIntegrity(p);
    expect(integrity.ok).toBe(false);
    expect(integrity.notChecked).toMatch(/unable to open/);
    const original = sha(p);
    const r = await run(p);
    expect(r.outcome).toBe('refused');
    expect(text(r)).toMatch(/Could not open .*unable to open database file/);
    // A check that did not run is not reported as one that failed.
    expect(text(r)).not.toMatch(/integrity check fails/);
    expect(text(r)).not.toMatch(/\bmv\b|\bln\b|touch |cp /);
    expect(sha(p)).toBe(original);
    expect(tmpLeft(dir)).toEqual([]);
  });

  // The read-only check fails on the damage; the read-write probe then fails on the file's mode
  // (SQLITE_IOERR_LOCK, measured), which is not damage.
  it('refuses a damaged store it cannot open read-write, without offering to move it', async () => {
    const { dir, p } = indexDamaged();
    chmodSync(p, 0o444);
    try {
      expect(probeExclusive(p).acquired, 'premise: the probe cannot write').toBe(false);
      const r = await run(p);
      expect(r.outcome).toBe('refused');
      expect(text(r)).toMatch(/is read-only, so the checked copy was not written into it/);
      expect(text(r)).not.toMatch(/\bmv\b|\bln\b|touch |cp /);
      expect(asides(dir)).toEqual([]);
      expect(tmpLeft(dir)).toEqual([]);
    } finally {
      chmodSync(p, 0o644);
    }
  });

  it('reports a failure it did not expect instead of throwing, and leaves the store', async () => {
    const { dir, p } = indexDamaged();
    const original = sha(p);
    const r = await run(p, {
      swapGuard: () => {
        throw new Error('the file system said no');
      },
    });
    expect(r.outcome).toBe('refused');
    expect(text(r)).toMatch(/repair-db stopped: the file system said no/);
    expect(sha(p)).toBe(original);
    expect(asides(dir)).toEqual([]);
    expect(tmpLeft(dir)).toEqual([]);
  });

  it('removes the temporary files of an interrupted repair', async () => {
    const { dir, p } = indexDamaged();
    writeFileSync(`${p}.repair-2026-01-01T00-00-00-000Z.tmp`, 'x');
    writeFileSync(`${p}.repair-2026-01-01T00-00-00-000Z.tmp-wal`, 'x');
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(text(r)).toMatch(/left by an interrupted repair/);
    expect(tmpLeft(dir)).toEqual([]);
  });

  it('refuses while install.lock is held', async () => {
    const { dir, p } = indexDamaged();
    const { takeLock } = await import('../lib/proc-lock.mjs');
    const { release } = takeLock(join(dir, 'install.lock'));
    let r;
    try {
      r = await run(p);
    } finally {
      release();
    }
    expect(r.outcome).toBe('refused');
    expect(text(r)).toMatch(/install\.lock/);
    expect(asides(dir)).toEqual([]);
  });

  it('refuses a store from another schema version', async () => {
    const { dir, p } = indexDamaged();
    const db = new Database(p);
    db.prepare('UPDATE schema_version SET version = 48').run();
    db.close();
    const r = await run(p);
    expect(r.outcome).toBe('refused');
    expect(text(r)).toMatch(/schema v48/);
    // No version before this one has a repair-db: an older store gets the fallback (r1 claims H7).
    expect(text(r)).not.toMatch(/claude-mem-lite that wrote it/);
    expect(text(r)).toMatch(/Once every Claude Code session is closed, run:|No backup snapshot/);
    expect(asides(dir)).toEqual([]);
    expect(tmpLeft(dir)).toEqual([]);
  });

  // D#539 and the first pre-tag review: the restore and set-aside keep the damaged file and its
  // log before anything else, say so before the command, and a second run stops instead of
  // moving a newer store over the kept one.
  it('prints the snapshot restore when it cannot read the file at all; the line keeps, and stops when re-run', async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 3 });
    copyFileSync(p, join(dir, `${DB}.pre-maintain-2026-09-06T00-00-00-000Z-1-1.bak`));
    plant(p, 1, 0, Array(16).fill(0x41));
    premise(p);
    const original = sha(p);
    const r = await run(p);
    expect(r.outcome).toBe('refused');
    const out = text(r);
    expect(out).toMatch(/not a database/);
    const cmd = out.split('\n').find((l) => l.includes(' && '));
    const steps = cmd.trim().split(' && ');
    expect(steps[0]).toBe(`touch ${p}-wal`);
    expect(steps[1]).toMatch(new RegExp(`^ln ${p} ${p}\\.damaged-`));
    expect(steps[2]).toMatch(new RegExp(`^ln ${p}-wal ${p}\\.damaged-.*-wal$`));
    expect(steps[3]).toBe(`rm ${p} ${p}-wal`);
    expect(steps.at(-1)).toMatch(/^cp .*pre-maintain-2026-09-06T00-00-00-000Z.* /);
    expect(out.indexOf('second name')).toBeGreaterThan(-1);
    expect(out.indexOf('second name')).toBeLessThan(out.indexOf(cmd));
    expect(sha(p)).toBe(original);
    expect(tmpLeft(dir)).toEqual([]);
    // Run it, let the next session's store appear, and run it again.
    expect(spawnSync('sh', ['-c', cmd]).status).toBe(0);
    const [aside] = asides(dir);
    expect(sha(join(dir, aside))).toBe(original);
    writeFileSync(p, 'a newer store');
    expect(spawnSync('sh', ['-c', cmd]).status).not.toBe(0);
    expect(sha(join(dir, aside))).toBe(original);
  });

  it('serialises concurrent runs: one repair, a sound store, one kept file', async () => {
    const { dir, p, before } = indexDamaged();
    const mod = join(REPO, 'lib', 'db-repair.mjs');
    const code = `
      const { repairDb } = await import(${JSON.stringify(mod)});
      const r = await repairDb(process.argv[1], { lockPath: process.argv[2] });
      process.stdout.write(r.outcome);
    `;
    const runs = await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise((done) => {
            const child = spawn(
              process.execPath,
              ['--input-type=module', '-e', code, p, join(dir, 'install.lock')],
              {
                cwd: REPO,
                env: { ...process.env, CLAUDE_MEM_DIR: dir },
              },
            );
            let out = '';
            child.stdout.on('data', (d) => (out += d));
            child.on('exit', () => done(out));
          }),
      ),
    );
    expect(runs.filter((o) => o === 'repaired').length, runs.join(',')).toBe(1);
    expect(
      runs.every((o) => ['repaired', 'healthy', 'refused'].includes(o)),
      runs.join(','),
    ).toBe(true);
    expect(checkIntegrity(p).ok).toBe(true);
    sameExceptVersion(record(p), before);
    expect(asides(dir).length).toBe(1);
    expect(tmpLeft(dir)).toEqual([]);
  });
});

// D#546: the round-2 reviews of D#541 (docs/audits/20261021-v6.31.0-d541-r2-{defects,claims}.md).
describe('repairDb: what it reads (D#546)', () => {
  const masterLeaves = (p) => pages(p, 'sqlite_schema');
  const rootOf = (p, name) => {
    const db = new Database(p, { readonly: true });
    try {
      return db.prepare(`SELECT pageno FROM dbstat WHERE name = ? AND path = '/'`).pluck().get(name);
    } finally {
      db.close();
    }
  };
  const count = (p, t) => {
    const db = new Database(p, { readonly: true });
    try {
      return db.prepare(`SELECT count(*) FROM "${t}"`).pluck().get();
    } finally {
      db.close();
    }
  };
  const files = (p) => ({ main: sha(p), wal: existsSync(`${p}-wal`) ? sha(`${p}-wal`) : null });

  // Claims F1: under writable_schema a full scan of sqlite_master threw, the read fell back to the
  // main file alone, and the 41 observations the log holds were left in the kept files.
  it('reads every table SQLite parsed when sqlite_master will not scan', async () => {
    const dir = newDir();
    const { p } = walStore(dir);
    // The page header: deterministic. Damaged cell pointers read past the page, and vary by run.
    plantWal(p, masterLeaves(p)[2], 0, 8, 0x41);
    const ws = new Database(p, { readonly: true });
    ws.unsafeMode(true);
    ws.pragma('writable_schema = ON');
    try {
      expect(
        () => ws.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`).all(),
        'premise',
      ).toThrow();
      expect(ws.prepare('SELECT count(*) FROM (SELECT * FROM observations)').pluck().get(), 'premise').toBe(
        241,
      );
    } finally {
      ws.close();
    }
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(count(p, 'observations')).toBe(241);
    expect(text(r)).not.toMatch(/database file alone/);
  });

  // Defects F2: a log frame that hides most of a table the main file still holds.
  it('takes the rows the log hides from the main file alone, and says so', async () => {
    const dir = newDir();
    const { p, mainAlone } = walStore(dir);
    plantWal(p, rootOf(p, 'observations'), 3, 2, 0); // the root's cell count read as 0
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    const after = record(p).observations;
    for (const row of mainAlone.observations)
      expect(after, 'every row the main file alone holds').toContain(row);
    expect(text(r)).toMatch(
      /observations: \d+ row\(s\) SQLite could not read with the log were taken from the database file without it/,
    );
    expect(text(r)).toMatch(/observations: some of its pages are damaged/);
  });

  // Claims F4: no observation reads with the log, and the main file alone has none: an empty
  // observations table is not a repair.
  it('refuses when no source gives back an observation, even when the main file alone reads an empty table', async () => {
    const dir = newDir();
    const p = join(dir, DB);
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    insertSession(db, { id: 'sess-1' });
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const keep = readFileSync(p);
    const raw = new Database(p);
    // Every frame stays in the log: an automatic checkpoint would restart it under the main file
    // written back below.
    raw.pragma('wal_autocheckpoint = 0');
    for (let i = 0; i < 120; i++)
      insertObs(raw, { title: `only in the log ${i}`, narrative: 'n'.repeat(400) });
    const wal = readFileSync(`${p}-wal`);
    raw.close();
    writeFileSync(p, keep);
    writeFileSync(`${p}-wal`, wal);
    rmSync(`${p}-shm`, { force: true });
    plantWal(p, rootOf(p, 'observations'), 0, 4096, 0xff);
    premise(p);
    const withLog = new Database(p, { readonly: true });
    try {
      expect(
        () => withLog.prepare('SELECT * FROM observations').all(),
        'premise: no observation reads with the log',
      ).toThrow();
    } finally {
      withLog.close();
    }
    const before = files(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('refused');
    expect(text(r)).toMatch(/no observation could be read/);
    expect(files(p)).toEqual(before);
    expect(asides(dir)).toEqual([]);
  });

  // p10-v5 of the 869: damage took two column definitions out of the log's copy of the
  // observations statement, and every later column read shifted. Here the statement is rewritten
  // in the log the same way: the table is read from the main file alone, and the line says so.
  it('reads a table whose definition the log garbled from the main file alone, and says so', async () => {
    const dir = newDir();
    const { p } = walStore(dir);
    const db = new Database(p);
    const keep = readFileSync(p);
    const alone = join(dir, 'alone.db');
    writeFileSync(alone, keep);
    const mainAlone = record(alone).observations;
    for (const ext of ['', '-wal', '-shm']) rmSync(alone + ext, { force: true });
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare(
      `UPDATE sqlite_master SET sql = replace(replace(sql, ', last_decided_session_id TEXT DEFAULT NULL', ''), ', demoted_at INTEGER DEFAULT NULL', '') WHERE name = 'observations'`,
    ).run();
    const wal = readFileSync(`${p}-wal`);
    db.close();
    writeFileSync(p, keep);
    writeFileSync(`${p}-wal`, wal);
    rmSync(`${p}-shm`, { force: true });
    const columns = (db) =>
      db.prepare(`SELECT count(*) FROM pragma_table_info('observations')`).pluck().get();
    const mem = new Database(':memory:');
    initSchema(mem);
    const want = columns(mem);
    mem.close();
    const shifted = new Database(p, { readonly: true });
    try {
      expect(columns(shifted), 'premise: two columns gone').toBe(want - 2);
    } finally {
      shifted.close();
    }
    plant(p, pages(p, 'idx_obs_project_live')[0], 1000, Array(64).fill(0x41)); // so integrity_check fails
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(record(p).observations).toEqual(mainAlone);
    expect(text(r)).toMatch(
      /could not read this table with the log.*observations \(\d+ rows; its definition reads differently from this version's\)/,
    );
  });

  // Defects F1: a page whose cell count is damaged drops rows from every read with no error, and
  // deferred_work has no index that lists every row.
  it('names a table whose damaged page dropped rows no read returns', async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 3 });
    const db = new Database(p);
    const ins = db.prepare(
      `INSERT INTO deferred_work (project, title, detail, created_at_epoch) VALUES ('p', ?, ?, ?)`,
    );
    for (let i = 1; i <= 40; i++) ins.run(`TODO ${i}`, 'd'.repeat(150), 1e12 + i);
    db.close();
    plant(p, pages(p, 'deferred_work')[0], 3, [0, 1]);
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(count(p, 'deferred_work')).toBeLessThan(40);
    expect(text(r)).toMatch(
      /deferred_work: some of its pages are damaged \([^)]+\), so rows on them may be missing/,
    );
  });

  // Claims F5: rows between two damaged leaves of a table no index lists were lost (578 of 600
  // read by rowid, 292 kept).
  it('reads the rows between two damaged leaves of a table with no index', async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 3 });
    const db = new Database(p);
    db.exec('CREATE TABLE zz_noindex (a TEXT, b INTEGER)');
    const ins = db.prepare('INSERT INTO zz_noindex (a, b) VALUES (?, ?)');
    for (let i = 0; i < 400; i++) ins.run(`row ${i} ${'q'.repeat(150)}`, i);
    db.close();
    const leaves = pages(p, 'zz_noindex');
    expect(leaves.length, 'premise: enough leaves').toBeGreaterThan(8);
    const onLeaf = (pg) => {
      const d = new Database(p, { readonly: true });
      try {
        return d.prepare(`SELECT ncell FROM dbstat WHERE name = 'zz_noindex' AND pageno = ?`).pluck().get(pg);
      } finally {
        d.close();
      }
    };
    const damaged = [leaves[2], leaves[6]];
    const lostAtMost = damaged.reduce((n, pg) => n + onLeaf(pg), 0);
    for (const pg of damaged) plant(p, pg, 0, Array(8).fill(0x41));
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(count(p, 'zz_noindex')).toBe(400 - lostAtMost);
    expect(text(r)).toMatch(/zz_noindex: some of its pages are damaged/);
  });

  // Defects F3: a newer store whose schema_version page is damaged was "repaired" to v49 with its
  // newer column dropped.
  it("refuses a store whose version cannot be read and whose columns are not this version's", async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 20 });
    const db = new Database(p);
    db.exec('ALTER TABLE observations ADD COLUMN v50_payload TEXT');
    db.exec(`UPDATE observations SET v50_payload = 'only-in-v50-' || id`);
    db.exec('UPDATE schema_version SET version = 50');
    db.close();
    plant(p, pages(p, 'schema_version')[0], 0, Array(8).fill(0x41));
    premise(p);
    const before = files(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('refused');
    expect(text(r)).toMatch(
      /schema version cannot be read, and observations has v50_payload, which this version does not/,
    );
    expect(text(r)).toMatch(/Once every Claude Code session is closed, run:|No backup snapshot/);
    expect(files(p)).toEqual(before);
  });

  // p61-v10 of the 869: damage in an FTS5 table's stored definition passes integrity_check and
  // fails every rebuild; repair-db called the store sound.
  it('repairs a store whose FTS5 definition names a column its content table lacks', async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 20 });
    const db = new Database(p);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare(
      `UPDATE sqlite_master SET sql = replace(sql, 'learned,', 'AAAAAAAAed,') WHERE name = 'session_summaries_fts'`,
    ).run();
    db.close();
    const ro = new Database(p, { readonly: true });
    try {
      expect(ro.pragma('integrity_check', { simple: true }), 'premise: integrity_check passes').toBe('ok');
    } finally {
      ro.close();
    }
    expect(checkIntegrity(p)).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/session_summaries_fts: no such column/)],
    });
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(checkIntegrity(p).ok).toBe(true);
  });

  // Claims F6: SQLITE_NOMEM from damaged FTS5 data is damage, not a failure to open.
  it('reads SQLITE_NOMEM from integrity_check as damage, and repairs the store', async () => {
    const dir = newDir();
    const { p } = walStore(dir);
    const fts = pages(p, 'observations_fts_data');
    let planted = false;
    for (const pg of fts) {
      const keep = readFileSync(`${p}-wal`);
      plantWal(p, pg, 3000, 64, 0xff);
      const db = new Database(p, { readonly: true });
      let code = null;
      try {
        db.prepare('PRAGMA integrity_check').all();
      } catch (e) {
        code = e.code;
      } finally {
        db.close();
      }
      if (code === 'SQLITE_NOMEM') {
        planted = true;
        break;
      }
      writeFileSync(`${p}-wal`, keep);
      rmSync(`${p}-shm`, { force: true });
    }
    expect(planted, 'premise: a plant on which integrity_check raises SQLITE_NOMEM').toBe(true);
    expect(checkIntegrity(p).notChecked).toBeUndefined();
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(count(p, 'observations')).toBe(241);
  });

  // Defects F8: damage in a full index listed rowids "an index lists" that never existed.
  it('names no row lost when only an index is damaged', async () => {
    const dir = newDir();
    const p = buildStore(dir);
    const before = record(p);
    // Into its cells: the page header's bytes 5-6 give where the cell content starts.
    const leaf = pages(p, 'idx_obs_epoch_project')[1];
    const head = Buffer.alloc(8);
    const fd = openSync(p, 'r');
    readSync(fd, head, 0, 8, (leaf - 1) * 4096);
    closeSync(fd);
    plant(p, leaf, head.readUInt16BE(5) + 8, Array(64).fill(0x41));
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    sameExceptVersion(record(p), before);
    expect(text(r)).not.toMatch(/could not be read|may be missing/);
  });
});

// Round-3 claims review: a definition the log garbles while SQLite still parses it is not read
// through: the table comes from the main file alone, whatever the table, when the names changed or
// only their order did while the main file's matches this version's.
describe('repairDb: a definition the log garbled (D#546 r1)', () => {
  /**
   * 200 observations and 50 search runs checkpointed; in the log, 40 more observations and `edit`
   * applied to one table's statement in sqlite_master; an index leaf outside the log damaged, so
   * integrity_check fails. Returns the truth (every row as the store with its log holds it) and the
   * rows of the main file alone.
   */
  function garbledInLog(table, edit) {
    const dir = newDir();
    const p = join(dir, DB);
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    ensureSearchTelemetrySchema(db);
    insertSession(db, { id: 'sess-1' });
    const ins = db.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, subtitle, narrative, created_at, created_at_epoch) VALUES ('sess-1', 'p', 'discovery', ?, ?, ?, 'x', ?)`,
    );
    for (let i = 0; i < 200; i++) ins.run(`title ${i}`, `subtitle ${i}`, `narrative ${i}`, 1e12 + i);
    const sr = db.prepare(
      `INSERT INTO search_runs (project, query, surface, search_mode, client, created_at, created_at_epoch) VALUES ('p', ?, 'mcp_search', 'fts', 'test', 'x', ?)`,
    );
    for (let i = 0; i < 50; i++) sr.run(`query ${i}`, 1e12 + i);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const keep = readFileSync(p);
    db.pragma('wal_autocheckpoint = 0');
    for (let i = 200; i < 240; i++) ins.run(`title ${i}`, `subtitle ${i}`, `narrative ${i}`, 1e12 + i);
    const truth = record(p);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).pluck().get(table);
    const garbled = edit(sql);
    expect(garbled, 'premise: the edit applies').not.toBe(sql);
    db.prepare(`UPDATE sqlite_master SET sql = ? WHERE name = ?`).run(garbled, table);
    const wal = readFileSync(`${p}-wal`);
    db.close();
    writeFileSync(p, keep);
    writeFileSync(`${p}-wal`, wal);
    rmSync(`${p}-shm`, { force: true });
    const alone = join(dir, 'alone.db');
    writeFileSync(alone, keep);
    const mainAlone = record(alone);
    for (const ext of ['', '-wal', '-shm']) rmSync(alone + ext, { force: true });
    const inLog = new Set();
    for (let o = 32; o + 24 + 4096 <= wal.length; o += 24 + 4096) inLog.add(wal.readUInt32BE(o));
    const ro = new Database(p, { readonly: true });
    const leaf = ro
      .prepare(`SELECT pageno FROM dbstat WHERE name LIKE 'idx_obs%' AND pagetype = 'leaf' ORDER BY pageno`)
      .pluck()
      .all()
      .find((pg) => !inLog.has(pg));
    ro.close();
    expect(leaf, 'premise: an index leaf the log does not hold').toBeDefined();
    plant(p, leaf, 0, Array(8).fill(0x41));
    premise(p);
    return { p, truth, mainAlone };
  }

  it('reads a table this version does not create from the main file alone (a column renamed)', async () => {
    const { p, truth } = garbledInLog('search_runs', (sql) => sql.replace(/\bquery\b/, 'qAAry'));
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    sameExceptVersion(record(p), truth);
    expect(text(r)).toMatch(/search_runs \(50 rows; its definition reads differently from this version's\)/);
  });

  it('reads a table this version does not create from the main file alone (two columns gone)', async () => {
    const { p, truth } = garbledInLog('search_runs', (sql) =>
      sql.replace(/,\s*query TEXT[^,]*/, '').replace(/,\s*surface TEXT[^,]*/, ''),
    );
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    sameExceptVersion(record(p), truth);
  });

  it('reads a table whose column definitions the log swapped from the main file alone', async () => {
    const { p, truth, mainAlone } = garbledInLog('observations', (sql) =>
      sql
        .replace(/\btitle TEXT/, 'TMPCOL TEXT')
        .replace(/\bsubtitle TEXT/, 'title TEXT')
        .replace(/\bTMPCOL TEXT/, 'subtitle TEXT'),
    );
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    sameExceptVersion(record(p), { ...truth, observations: mainAlone.observations });
    expect(text(r)).toMatch(
      /observations \(200 rows; its definition reads differently from this version's\)/,
    );
  });
});

// Round-3 claims review H5: a sqlite_sequence page that reads one row twice stopped the whole
// repair ("UNIQUE constraint failed: sqlite_sequence.rowid"), and doctor sent the user back to it.
it('repairs a store whose sqlite_sequence page reads one row twice', async () => {
  const dir = newDir();
  const p = buildStore(dir, { rows: 20 });
  const pg = pages(p, 'sqlite_sequence')[0];
  const head = Buffer.alloc(12);
  const fd = openSync(p, 'r+');
  readSync(fd, head, 0, 12, (pg - 1) * 4096);
  expect(head.readUInt16BE(3), 'premise: two counters').toBeGreaterThan(1);
  const first = Buffer.alloc(2);
  readSync(fd, first, 0, 2, (pg - 1) * 4096 + 8);
  writeSync(fd, first, 0, 2, (pg - 1) * 4096 + 10); // the second cell pointer := the first
  closeSync(fd);
  premise(p);
  const r = await run(p);
  expect(r.outcome, text(r)).toBe('repaired');
  expect(checkIntegrity(p).ok).toBe(true);
});

// Round-3 defects review (r1).
describe('repairDb: r1 defects (D#546)', () => {
  const count = (p, t) => {
    const db = new Database(p, { readonly: true });
    try {
      return db.prepare(`SELECT count(*) FROM "${t}"`).pluck().get();
    } finally {
      db.close();
    }
  };
  /** The newest log frame of page `pg` replaced by the main file's older version of that page. */
  function staleWal(p, pg) {
    const main = readFileSync(p);
    const older = main.subarray((pg - 1) * 4096, pg * 4096);
    const wal = Buffer.from(readFileSync(`${p}-wal`));
    const be = wal.readUInt32BE(0) === 0x377f0683;
    const frames = [];
    for (let o = 32; o + 24 + 4096 <= wal.length; o += 24 + 4096) frames.push({ o, pg: wal.readUInt32BE(o) });
    const target = frames.filter((f) => f.pg === pg).at(-1);
    older.copy(wal, target.o + 24);
    let [s0, s1] = walChecksum(wal.subarray(0, 24), 0, 0, be);
    for (const f of frames) {
      [s0, s1] = walChecksum(wal.subarray(f.o, f.o + 8), s0, s1, be);
      [s0, s1] = walChecksum(wal.subarray(f.o + 24, f.o + 24 + 4096), s0, s1, be);
      wal.writeUInt32BE(s0, f.o + 16);
      wal.writeUInt32BE(s1, f.o + 20);
    }
    writeFileSync(`${p}-wal`, wal);
    rmSync(`${p}-shm`, { force: true });
  }

  // Round-3 claims review H1: a damaged page garbled a row's values and kept its rowid (25 of
  // 2,769 plants). The row is kept as read; its table is named.
  it('names the table of a row whose values disagree with its indexes', async () => {
    // The 869-plant fixture (docs/audits/20261021-v6.31.0-d541-sweep.md), plant p63-v6.
    const dir = newDir();
    const p = join(dir, DB);
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    for (const s of ['s1', 's2']) {
      db.prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch) VALUES (?, ?, 'p', datetime('now'), 1)`,
      ).run(`c-${s}`, s);
    }
    const ins = (s) =>
      db.prepare(
        `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch) VALUES ('${s}', 'p', 'discovery', ?, ?, datetime('now'), ?)`,
      );
    for (let i = 0; i < 200; i++)
      ins('s1').run(
        `title ${i} alpha beta`,
        `narrative ${i} gamma delta epsilon ` + 'x'.repeat(i % 50),
        1700000000000 + i,
      );
    db.pragma('wal_checkpoint(TRUNCATE)');
    const pristine = readFileSync(p);
    for (let i = 0; i < 40; i++)
      ins('s2').run(`late ${i} zeta`, `late narrative ${i} eta theta`, 1800000000000 + i);
    db.exec('VACUUM');
    ins('s2').run('last one', 'final narrative', 1900000000000);
    const wal = readFileSync(`${p}-wal`);
    db.close();
    writeFileSync(p, pristine);
    writeFileSync(`${p}-wal`, wal);
    rmSync(`${p}-shm`, { force: true });
    const alone = join(dir, 'alone.db');
    writeFileSync(alone, pristine);
    const intact = record(alone).observations.find((r) => JSON.parse(r).id === '1');
    for (const ext of ['', '-wal', '-shm']) rmSync(alone + ext, { force: true });
    expect(pages(p, 'observations'), 'premise: page 63 is an observations leaf').toContain(63);
    plantWal(p, 63, 4032, 64, 0xff);
    const ro = new Database(p, { readonly: true });
    let garbled;
    let mismatch;
    try {
      const row = ro
        .prepare('SELECT rowid AS __rowid, * FROM observations WHERE rowid = 1')
        .safeIntegers(true)
        .get();
      garbled = JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? `${v}` : v));
      mismatch = ro
        .prepare('PRAGMA integrity_check(observations)')
        .pluck()
        .all()
        .some((x) => /row 1 missing from index/.test(x));
    } finally {
      ro.close();
    }
    expect(garbled, 'premise: row 1 reads garbled with the log').not.toBe(intact);
    expect(mismatch, 'premise: integrity_check names row 1').toBe(true);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(text(r)).toMatch(/observations: some of its pages are damaged .*hold damaged values/);
  });

  // P1-1: a stale table page (a lost write: valid, older) shows only as a row/index mismatch, and a
  // structural problem on one of the table's indexes silenced that, so the rows were lost unnamed.
  it('names a table whose page lost a write when one of its indexes is damaged too', async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 3 });
    const db = new Database(p);
    const ev = db.prepare(
      `INSERT INTO events (project, event_type, title, body, created_at_epoch) VALUES ('p', 'bugfix', ?, ?, ?)`,
    );
    for (let i = 0; i < 400; i++) ev.run(`event ${i}`, 'b'.repeat(120), 1e12 + i);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const keep = readFileSync(p);
    db.pragma('wal_autocheckpoint = 0');
    for (let i = 400; i < 430; i++) ev.run(`event ${i}`, 'b'.repeat(120), 1e12 + i);
    const wal = readFileSync(`${p}-wal`);
    db.close();
    writeFileSync(p, keep);
    writeFileSync(`${p}-wal`, wal);
    rmSync(`${p}-shm`, { force: true });
    const inLog = new Set();
    for (let o = 32; o + 24 + 4096 <= wal.length; o += 24 + 4096) inLog.add(wal.readUInt32BE(o));
    // The main file's rightmost events leaf: the log filled it with more rows before it split.
    const alone = join(dir, 'main-alone.db');
    writeFileSync(alone, keep);
    const tree = new Database(alone, { readonly: true });
    const lastLeaf = tree
      .prepare(
        `SELECT pageno FROM dbstat WHERE name = 'events' AND pagetype = 'leaf' ORDER BY path DESC LIMIT 1`,
      )
      .pluck()
      .get();
    tree.close();
    for (const ext of ['', '-wal', '-shm']) rmSync(alone + ext, { force: true });
    expect(inLog.has(lastLeaf), 'premise: the rightmost events leaf is in the log').toBe(true);
    staleWal(p, lastLeaf);
    const lost = new Database(p, { readonly: true });
    try {
      expect(
        lost.prepare('SELECT count(*) FROM events NOT INDEXED').pluck().get(),
        'premise: the stale page lost rows',
      ).toBeLessThan(430);
    } finally {
      lost.close();
    }
    const ro = new Database(p, { readonly: true });
    const ixLeaf = ro
      .prepare(
        `SELECT pageno FROM dbstat WHERE name LIKE 'idx_events%' AND pagetype = 'leaf' ORDER BY pageno`,
      )
      .pluck()
      .all()
      .find((pg) => !inLog.has(pg));
    ro.close();
    expect(ixLeaf, 'premise: an events index leaf outside the log').toBeDefined();
    plant(p, ixLeaf, 0, Array(8).fill(0));
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(count(p, 'events')).toBeLessThan(430);
    expect(text(r)).toMatch(
      /events: (some of its pages are damaged|\d+ row\(s\) an index lists could not be read)/,
    );
  });

  // P1-2: with both the first and the last path of a table damaged, the search for the next
  // readable rowid doubled its step from far below zero straight past every real rowid.
  it('reads the middle leaves of a table whose first and last paths are damaged', async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 3 });
    const db = new Database(p);
    // No index lists its rows: only the read itself can reach the middle leaves.
    db.exec('CREATE TABLE zz_noindex (a TEXT, b INTEGER)');
    const ins = db.prepare('INSERT INTO zz_noindex (a, b) VALUES (?, ?)');
    for (let i = 0; i < 410; i++) ins.run(`row ${i} ${'q'.repeat(150)}`, i);
    const root = db
      .prepare(`SELECT pageno FROM dbstat WHERE name = 'zz_noindex' AND path = '/'`)
      .pluck()
      .get();
    const leaves = db
      .prepare(
        `SELECT pageno, ncell FROM dbstat WHERE name = 'zz_noindex' AND pagetype = 'leaf' ORDER BY path`,
      )
      .all();
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    expect(leaves.length, 'premise: an interior root over several leaves').toBeGreaterThan(4);
    // The root's right-child pointer and its first cell's child pointer, to a page that does not exist.
    const fd = openSync(p, 'r+');
    const page = Buffer.alloc(4096);
    readSync(fd, page, 0, 4096, (root - 1) * 4096);
    page.writeUInt32BE(0x41414141, 8);
    page.writeUInt32BE(0x41414141, page.readUInt16BE(12));
    writeSync(fd, page, 0, 4096, (root - 1) * 4096);
    closeSync(fd);
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    const middle = leaves.slice(1, -1).reduce((n, l) => n + l.ncell, 0);
    expect(count(p, 'zz_noindex')).toBeGreaterThanOrEqual(middle);
  });

  // P1-3: one garbled column name in one table's definition refused the whole store and printed
  // the set-aside, although every other table read.
  it('repairs the store around a table whose definition is garbled, and names that table', async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 30 });
    const db = new Database(p);
    const ev = db.prepare(
      `INSERT INTO events (project, event_type, title, created_at_epoch) VALUES ('p', 'bugfix', ?, 1)`,
    );
    for (let i = 0; i < 5; i++) ev.run(`event ${i}`);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare(
      `UPDATE sqlite_master SET sql = replace(sql, 'event_type', 'evAAt_type') WHERE name = 'events'`,
    ).run();
    db.pragma('writable_schema = OFF');
    db.close();
    // The garbled definition in the main file, and a log that holds other rows, so that the main
    // file alone is read too and holds the same garbled definition.
    const keep = readFileSync(p);
    const w = new Database(p);
    w.unsafeMode(true);
    w.pragma('writable_schema = ON');
    w.pragma('wal_autocheckpoint = 0');
    for (let i = 0; i < 10; i++) insertObs(w, { title: `in the log ${i}`, narrative: 'n' });
    const wal = readFileSync(`${p}-wal`);
    w.close();
    writeFileSync(p, keep);
    writeFileSync(`${p}-wal`, wal);
    rmSync(`${p}-shm`, { force: true });
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(count(p, 'observations')).toBe(40);
    expect(text(r)).toMatch(/events: could not be read \(its definition reads differently/);
  });

  /**
   * A store with no log whose events definition `edit` garbled, events whose later columns hold
   * values, and an index page damaged elsewhere so that integrity_check fails.
   */
  function garbledEvents(edit) {
    const dir = newDir();
    const p = buildStore(dir, { rows: 30 });
    const db = new Database(p);
    const ev = db.prepare(
      `INSERT INTO events (project, event_type, title, created_at_epoch, last_accessed_epoch, search_terms) VALUES ('p', 'bugfix', ?, 1, 1234, 'terms')`,
    );
    for (let i = 0; i < 5; i++) ev.run(`event ${i}`);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'events'`).pluck().get();
    expect(edit(sql), 'premise: the edit applies').not.toBe(sql);
    db.prepare(`UPDATE sqlite_master SET sql = ? WHERE name = 'events'`).run(edit(sql));
    db.pragma('writable_schema = OFF');
    db.close();
    plant(p, pages(p, 'idx_sess_memory_sid')[0], 0, Array(8).fill(0x41));
    premise(p);
    return p;
  }

  // A definition that lost a column before its last reads every later column one place off.
  it('does not read a table through a definition that lost a column before its last', async () => {
    const p = garbledEvents((sql) => sql.replace(/\s*last_accessed_epoch\s+INTEGER,/, ''));
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(count(p, 'events')).toBe(0);
    expect(text(r)).toMatch(/events: could not be read \(its definition reads differently/);
  });

  // A definition with a column this version does not have reads every later column one place off,
  // though it lacks none of this version's.
  it('does not read a table through a definition with a column this version does not have', async () => {
    const p = garbledEvents((sql) => sql.replace(/\blast_accessed_epoch\s+INTEGER,/, 'zz_extra INTEGER, $&'));
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(count(p, 'events')).toBe(0);
    expect(text(r)).toMatch(/events: could not be read \(its definition reads differently/);
  });

  // F6 when the log cannot be read: the rows come from the database file alone, whose list of
  // tables lost cells.
  it('says so when the database file alone, read without its log, lost part of its list of tables', async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 20 });
    const db = new Database(p);
    db.exec('CREATE TABLE zz_user (a TEXT)');
    db.prepare(`INSERT INTO zz_user VALUES ('kept')`).run();
    for (let i = 0; i < 30; i++) db.exec(`CREATE TABLE zz_pad_${i} (a TEXT)`);
    const last = db
      .prepare(
        `SELECT pageno, ncell FROM dbstat WHERE name = 'sqlite_schema' AND pagetype = 'leaf' ORDER BY path`,
      )
      .all()
      .at(-1);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const keep = readFileSync(p);
    db.pragma('wal_autocheckpoint = 0');
    db.pragma('user_version = 7'); // page 1 into the log
    for (let i = 0; i < 5; i++) insertObs(db, { title: `in the log ${i}`, narrative: 'n' });
    const wal = readFileSync(`${p}-wal`);
    db.close();
    writeFileSync(p, keep);
    writeFileSync(`${p}-wal`, wal);
    rmSync(`${p}-shm`, { force: true });
    expect(last.ncell, 'premise: the last sqlite_master leaf holds several rows').toBeGreaterThan(3);
    plant(p, last.pageno, 3, [0, 1]);
    plantWal(p, 1, 100, 8, 0x41);
    const ro = new Database(p, { readonly: true });
    try {
      expect(
        () => ro.prepare('SELECT count(*) FROM pragma_table_list').get(),
        'premise: the log reads no schema',
      ).toThrow();
    } finally {
      ro.close();
    }
    rmSync(`${p}-shm`, { force: true });
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(text(r)).toMatch(/could not read the database together with its log/);
    expect(text(r)).toMatch(/Part of its list of tables could not be read/);
  });

  // P2-9: one damaged page brings back, from the database file alone, every row the log had
  // deleted anywhere in the table (limiting the fill to the damaged stretch lost rows a page dropped
  // silently: the round-2 delta review, F2). The line says so.
  it('says a row the log deleted may be back when the database file alone fills a table', async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 300 });
    const keep = readFileSync(p);
    const db = new Database(p);
    db.pragma('wal_autocheckpoint = 0');
    db.prepare('DELETE FROM observations WHERE id % 97 = 0').run();
    const leaves = db
      .prepare(`SELECT pageno FROM dbstat WHERE name = 'observations' AND pagetype = 'leaf' ORDER BY path`)
      .pluck()
      .all();
    const wal = readFileSync(`${p}-wal`);
    db.close();
    writeFileSync(p, keep);
    writeFileSync(`${p}-wal`, wal);
    rmSync(`${p}-shm`, { force: true });
    const inLog = new Set();
    for (let o = 32; o + 24 + 4096 <= wal.length; o += 24 + 4096) inLog.add(wal.readUInt32BE(o));
    const target = leaves.slice(1, -1).find((pg) => inLog.has(pg));
    expect(target, 'premise: a middle leaf the log rewrote').toBeDefined();
    plantWal(p, target, 0, 8, 0x41);
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    const ids = new Set(record(p).observations.map((row) => Number(JSON.parse(row).id)));
    expect(
      [97, 194, 291].some((id) => ids.has(id)),
      'premise: a deleted row is back',
    ).toBe(true);
    expect(text(r)).toMatch(/observations: \d+ row\(s\) .*a row the log deleted may be back/);
  });

  // P2-6: a backup that failed after writing spilled frames into the log deleted the byte copy of
  // the store as found, the only copy that matches it byte for byte.
  it('keeps the store as found beside it when the write-back fails', async () => {
    const dir = newDir();
    const { p } = walStore(dir);
    plantWal(p, pages(p, 'idx_obs_project_live')[0], 1000, 64, 0x41);
    premise(p);
    const original = Database.prototype.backup;
    Database.prototype.backup = async function (dest, opts) {
      return original.call(this, dest, {
        ...opts,
        progress: (x) => {
          opts.progress(x);
          throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
        },
      });
    };
    let r;
    try {
      r = await run(p);
    } finally {
      Database.prototype.backup = original;
    }
    expect(r.outcome, text(r)).toBe('refused');
    expect(asides(dir).length).toBe(1);
    expect(text(r)).toMatch(/kept byte for byte as/);
  });

  // P3-10: SQLite deletes the log of an empty database file on any open, read-only included; the
  // first integrity check deleted it and called the store healthy.
  it('keeps the log of an empty database file instead of letting SQLite delete it', async () => {
    const dir = newDir();
    const { p } = walStore(dir);
    writeFileSync(p, Buffer.alloc(0));
    const wal = sha(`${p}-wal`);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('refused');
    expect(existsSync(`${p}-wal`) && sha(`${p}-wal`)).toBe(wal);
    const kept = readdirSync(dir).filter((n) => /\.damaged-.*-wal$/.test(n));
    expect(kept.length).toBe(1);
  });

  // P3-11: a run killed after it kept the store as found left a store-sized copy no later run named.
  it('names the copies an interrupted run kept', async () => {
    const { dir, p } = indexDamaged();
    writeFileSync(`${p}.damaged-2026-01-01T00-00-00-000Z`, 'x');
    const r = await run(p);
    expect(text(r)).toMatch(/claude-mem-lite\.db\.damaged-2026-01-01T00-00-00-000Z/);
    expect(existsSync(join(dir, `${DB}.damaged-2026-01-01T00-00-00-000Z`))).toBe(true);
  });

  // P2-5: a shadow table of a search index whose name damage garbled outside \w was copied in as
  // a table of its own, or refused the whole repair.
  it('leaves out a search index shadow table whose name is garbled', async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 20 });
    const db = new Database(p);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare(
      `UPDATE sqlite_master SET name = 'observations_f' || char(28) || '~_data', tbl_name = 'observations_f' || char(28) || '~_data', sql = replace(sql, 'observations_fts_data', 'observations_f' || char(28) || '~_data') WHERE name = 'observations_fts_data'`,
    ).run();
    db.close();
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    const after = new Database(p, { readonly: true });
    try {
      expect(
        after
          .prepare(`SELECT count(*) FROM sqlite_master WHERE name LIKE 'observations_f%~_data'`)
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      after.close();
    }
    expect(checkIntegrity(p).ok).toBe(true);
  });

  // ---- Round-2 delta review (1e0649eb) ----

  /** A log store: rows checkpointed, then `log(db)` run with every frame kept in the log. */
  function logStore(dir, setup, log) {
    const p = join(dir, DB);
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    db.pragma('foreign_keys = OFF');
    insertSession(db, { id: 'sess-1' });
    setup(db);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const keep = readFileSync(p);
    db.pragma('wal_autocheckpoint = 0');
    log(db);
    const truth = record(p);
    const wal = readFileSync(`${p}-wal`);
    db.close();
    writeFileSync(p, keep);
    writeFileSync(`${p}-wal`, wal);
    rmSync(`${p}-shm`, { force: true });
    const alone = join(dir, 'alone.db');
    writeFileSync(alone, keep);
    const mainAlone = record(alone);
    for (const ext of ['', '-wal', '-shm']) rmSync(alone + ext, { force: true });
    return { p, truth, mainAlone, keep, wal };
  }
  const rowsById = (rows) => new Map(rows.map((r) => [JSON.parse(r).__rowid, r]));

  // F1: integrity_check's "row N missing from index" counts rows in scan order; read as a rowid,
  // it replaced an intact row (one the log had edited) with its older copy.
  it('never puts an older copy over a row the log changed, when a row below it was deleted', async () => {
    const dir = newDir();
    const { p, truth } = logStore(
      dir,
      (db) => {
        for (let i = 0; i < 340; i++)
          insertObs(db, {
            title: `title ${i} alpha`,
            narrative: 'n'.repeat(200),
            project: `p${i % 3}`,
            epochOffset: i,
          });
      },
      (db) => {
        db.prepare('DELETE FROM observations WHERE id % 23 = 0').run();
        db.prepare(`UPDATE observations SET title = title || ' edited' WHERE id % 17 = 0`).run();
      },
    );
    // Row 248's project garbled in place in its newest log frame, the page's structure intact.
    const target = JSON.parse(rowsById(truth.observations).get('248'));
    const needle = Buffer.from(`${target.project}discovery${target.title}`);
    const wal = Buffer.from(readFileSync(`${p}-wal`));
    let at = -1;
    for (let o = 32; o + 24 + 4096 <= wal.length; o += 24 + 4096) {
      const i = wal.subarray(o + 24, o + 24 + 4096).indexOf(needle);
      if (i >= 0) at = o + 24 + i;
    }
    expect(at, 'premise: row 248 is in the log').toBeGreaterThan(0);
    wal[at + 1] = '9'.charCodeAt(0);
    const be = wal.readUInt32BE(0) === 0x377f0683;
    let [s0, s1] = walChecksum(wal.subarray(0, 24), 0, 0, be);
    for (let o = 32; o + 24 + 4096 <= wal.length; o += 24 + 4096) {
      [s0, s1] = walChecksum(wal.subarray(o, o + 8), s0, s1, be);
      [s0, s1] = walChecksum(wal.subarray(o + 24, o + 24 + 4096), s0, s1, be);
      wal.writeUInt32BE(s0, o + 16);
      wal.writeUInt32BE(s1, o + 20);
    }
    writeFileSync(`${p}-wal`, wal);
    rmSync(`${p}-shm`, { force: true });
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    const after = rowsById(record(p).observations);
    // Every row the log edited and the damage did not touch is as the log left it.
    for (const [id, row] of rowsById(truth.observations)) {
      if (id !== '248' && JSON.parse(row).title.endsWith(' edited'))
        expect(after.get(id), `row ${id}`).toBe(row);
    }
    expect(text(r)).toMatch(/observations: some of its pages are damaged/);
  });

  // F2: a page that drops rows silently, in a table no full index lists, lost the rows the main
  // file alone holds intact once the main-file fill was limited to the stretches and listed ids.
  it('takes from the database file alone the rows a damaged page dropped silently', async () => {
    const dir = newDir();
    const { p, mainAlone } = logStore(
      dir,
      (db) => {
        const ins = db.prepare(
          `INSERT INTO deferred_work (project, title, detail, status, created_at_epoch) VALUES ('p', ?, ?, ?, ?)`,
        );
        for (let i = 0; i < 120; i++)
          ins.run(`todo ${i}`, 'd'.repeat(120), ['open', 'done', 'dropped'][i % 3], 1e12 + i);
      },
      (db) => {
        db.prepare(`UPDATE deferred_work SET detail = detail || ' x' WHERE id % 7 = 0`).run();
      },
    );
    const inLog = new Set();
    const wal = readFileSync(`${p}-wal`);
    for (let o = 32; o + 24 + 4096 <= wal.length; o += 24 + 4096) inLog.add(wal.readUInt32BE(o));
    const leaf = pages(p, 'deferred_work').find((pg) => inLog.has(pg));
    expect(leaf, 'premise: a deferred_work leaf in the log').toBeDefined();
    // Its cell count halved in the newest frame: rows dropped from every read, without an error.
    const buf = Buffer.from(wal);
    let at = -1;
    for (let o = 32; o + 24 + 4096 <= buf.length; o += 24 + 4096)
      if (buf.readUInt32BE(o) === leaf) at = o + 24;
    buf.writeUInt16BE(Math.floor(buf.readUInt16BE(at + 3) / 2), at + 3);
    const be = buf.readUInt32BE(0) === 0x377f0683;
    let [s0, s1] = walChecksum(buf.subarray(0, 24), 0, 0, be);
    for (let o = 32; o + 24 + 4096 <= buf.length; o += 24 + 4096) {
      [s0, s1] = walChecksum(buf.subarray(o, o + 8), s0, s1, be);
      [s0, s1] = walChecksum(buf.subarray(o + 24, o + 24 + 4096), s0, s1, be);
      buf.writeUInt32BE(s0, o + 16);
      buf.writeUInt32BE(s1, o + 20);
    }
    writeFileSync(`${p}-wal`, buf);
    rmSync(`${p}-shm`, { force: true });
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    const ids = new Set(record(p).deferred_work.map((row) => JSON.parse(row).__rowid));
    for (const row of mainAlone.deferred_work)
      expect(ids, `id ${JSON.parse(row).__rowid}`).toContain(JSON.parse(row).__rowid);
  });

  // F3: a definition that lost its last columns (a prefix of this version's) in both the main file
  // and the log was refused everywhere; read by name it shifts nothing.
  it('reads a table whose definition lost its last columns in both files', async () => {
    const dir = newDir();
    const p = join(dir, DB);
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    db.pragma('foreign_keys = OFF');
    insertSession(db, { id: 'sess-1' });
    for (let i = 0; i < 200; i++) insertObs(db, { title: `t${i}`, narrative: 'n'.repeat(200) });
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'observations'`).pluck().get();
    const cols = db.prepare(`SELECT name FROM pragma_table_info('observations')`).pluck().all();
    db.prepare(`UPDATE sqlite_master SET sql = ? WHERE name = 'observations'`).run(
      sql.slice(0, sql.lastIndexOf(cols.at(-3))).replace(/,\s*$/, '') + ')',
    );
    db.pragma('writable_schema = OFF');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const keep = readFileSync(p);
    db.pragma('wal_autocheckpoint = 0');
    for (let i = 0; i < 10; i++)
      db.prepare(
        `INSERT INTO events (project, event_type, title, created_at_epoch) VALUES ('p', 'bugfix', ?, 1)`,
      ).run(`e${i}`);
    const wal = readFileSync(`${p}-wal`);
    db.close();
    writeFileSync(p, keep);
    writeFileSync(`${p}-wal`, wal);
    rmSync(`${p}-shm`, { force: true });
    plant(p, pages(p, 'idx_sess_memory_sid')[0], 0, Array(8).fill(0x41));
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(count(p, 'observations')).toBe(200);
    expect(text(r)).toMatch(
      new RegExp(`observations: column\\(s\\) ${cols.slice(-3).join(', ')} are missing from its definition`),
    );
  });

  // F4: a stale table page beside a damaged index page that makes the check stop: the check never
  // compared the table with its sound indexes, and the rows the stale page lost went unnamed.
  it('names a table whose page lost a write when the check stops on a damaged index', async () => {
    const dir = newDir();
    const { p, truth } = logStore(
      dir,
      (db) => {
        for (let i = 0; i < 300; i++)
          insertObs(db, {
            title: `title ${i}`,
            narrative: 'n'.repeat(200),
            project: `p${i % 3}`,
            epochOffset: i,
          });
      },
      (db) => {
        db.prepare(
          `UPDATE observations SET title = title || ' edited', superseded_at = 9 WHERE id % 17 = 0`,
        ).run();
      },
    );
    // A leaf the log rewrote for an edit, its newest frame replaced by the main file's version (a
    // lost write: the edit is undone, the page valid), and the root of the one full index damaged.
    const inLog = new Set();
    const wal = readFileSync(`${p}-wal`);
    for (let o = 32; o + 24 + 4096 <= wal.length; o += 24 + 4096) inLog.add(wal.readUInt32BE(o));
    const ro0 = new Database(p, { readonly: true });
    const leaf = ro0
      .prepare(`SELECT pageno FROM dbstat WHERE name = 'observations' AND pagetype = 'leaf' ORDER BY path`)
      .pluck()
      .all()
      .find((pg) => inLog.has(pg));
    const ixRoot = ro0
      .prepare(`SELECT pageno FROM dbstat WHERE name = 'idx_obs_epoch_project' AND path = '/'`)
      .pluck()
      .get();
    ro0.close();
    rmSync(`${p}-shm`, { force: true });
    staleWal(p, leaf);
    if (inLog.has(ixRoot)) plantWal(p, ixRoot, 0, 8, 0x41);
    else plant(p, ixRoot, 0, Array(8).fill(0x41));
    const ro = new Database(p, { readonly: true });
    try {
      const now = rowsById(record(p).observations);
      const reverted = [...rowsById(truth.observations)].filter(([id, row]) => now.get(id) !== row);
      expect(reverted.length, 'premise: the stale page undid an edit').toBeGreaterThan(0);
      expect(
        () => ro.prepare('PRAGMA integrity_check(observations)').all(),
        'premise: the check stops',
      ).toThrow();
    } finally {
      ro.close();
    }
    rmSync(`${p}-shm`, { force: true });
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(text(r)).toMatch(/observations: (some of its pages are damaged|\d+ row\(s\))/);
  });

  // F5: SQLite does not count the entries of a partial index, so a table whose only index is
  // partial passed its own check while a stale page had lost its rows.
  it('names a table with only a partial index whose page lost a write', async () => {
    const dir = newDir();
    const { p } = logStore(
      dir,
      (db) => {
        db.exec(
          'CREATE TABLE zz_user (a TEXT, b INTEGER); CREATE INDEX zz_user_b ON zz_user(b) WHERE b % 2 = 0',
        );
        const ins = db.prepare('INSERT INTO zz_user (a, b) VALUES (?, ?)');
        for (let i = 0; i < 300; i++) ins.run(`row ${i} ${'q'.repeat(120)}`, i);
      },
      (db) => {
        const ins = db.prepare('INSERT INTO zz_user (a, b) VALUES (?, ?)');
        for (let i = 300; i < 330; i++) ins.run(`row ${i} ${'q'.repeat(120)}`, i);
      },
    );
    const root = (() => {
      const ro = new Database(p, { readonly: true });
      try {
        return ro.prepare(`SELECT pageno FROM dbstat WHERE name = 'zz_user' AND path = '/'`).pluck().get();
      } finally {
        ro.close();
      }
    })();
    rmSync(`${p}-shm`, { force: true });
    staleWal(p, root);
    const ro = new Database(p, { readonly: true });
    try {
      expect(
        ro.prepare('SELECT count(*) FROM zz_user NOT INDEXED').pluck().get(),
        'premise: rows lost',
      ).toBeLessThan(330);
      expect(
        ro.prepare('PRAGMA integrity_check(zz_user)').pluck().get(),
        'premise: its own check passes',
      ).toBe('ok');
    } finally {
      ro.close();
    }
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(text(r)).toMatch(/zz_user: /);
  });

  // F6: a sqlite_master page that lost cells hides tables without an error; this version's own
  // tables were named, the others vanished with no line.
  it('says so when part of the list of tables is lost and tables this version does not create vanish', async () => {
    const dir = newDir();
    const p = buildStore(dir, { rows: 20 });
    const db = new Database(p);
    ensureSearchTelemetrySchema(db);
    db.exec('CREATE TABLE zz_user (a TEXT)');
    db.prepare(`INSERT INTO zz_user VALUES ('kept')`).run();
    for (let i = 0; i < 30; i++) db.exec(`CREATE TABLE zz_pad_${i} (a TEXT)`);
    const leaves = db
      .prepare(
        `SELECT pageno, ncell FROM dbstat WHERE name = 'sqlite_schema' AND pagetype = 'leaf' ORDER BY path`,
      )
      .all();
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const last = leaves.at(-1);
    expect(last.ncell, 'premise: the last sqlite_master leaf holds several rows').toBeGreaterThan(3);
    plant(p, last.pageno, 3, [0, 1]);
    const ro = new Database(p, { readonly: true });
    try {
      expect(
        ro.prepare(`SELECT count(*) FROM pragma_table_list WHERE name = 'zz_user'`).pluck().get(),
        'premise: zz_user unlisted',
      ).toBe(0);
    } finally {
      ro.close();
    }
    premise(p);
    const r = await run(p);
    expect(r.outcome, text(r)).toBe('repaired');
    expect(text(r)).toMatch(/Part of its list of tables could not be read/);
  });
});

describe('repairDb: what it writes (D#546)', () => {
  const files = (p) => ({ main: sha(p), wal: existsSync(`${p}-wal`) ? sha(`${p}-wal`) : null });
  const patchBackup = (wrap) => {
    const original = Database.prototype.backup;
    Database.prototype.backup = function (...args) {
      return wrap.call(this, original, ...args);
    };
    return () => {
      Database.prototype.backup = original;
    };
  };

  it('the lock probe leaves the main file and its log byte for byte', () => {
    const { p } = damagedLog();
    const before = files(p);
    expect(probeExclusive(p)).toMatchObject({ acquired: true });
    expect(files(p)).toEqual(before);
  });

  // Defects F4: a backup that failed after the probe left the store checkpointed.
  it('leaves the store as found when the write-back fails', async () => {
    const { dir, p } = damagedLog();
    const before = files(p);
    const restore = patchBackup(async function (original, dest, opts) {
      await original.call(this, dest, {
        ...opts,
        progress: (x) => {
          opts.progress(x);
          throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR_WRITE' });
        },
      });
    });
    let r;
    try {
      r = await run(p);
    } finally {
      restore();
    }
    expect(r.outcome, text(r)).toBe('refused');
    expect(files(p)).toEqual(before);
    // The backup started: the byte copy of the store as found stays (the round-3 defects review).
    expect(asides(dir).length).toBe(1);
    expect(tmpLeft(dir)).toEqual([]);
  });

  // Defects F5: a save committed between the lock probe and the backup's first step was lost
  // from both the store and the kept file.
  it('refuses, keeping the save, when the store is written after the lock probe', async () => {
    const { p } = damagedLog();
    const restore = patchBackup(async function (original, dest, opts) {
      const w = new Database(dest);
      w.prepare(
        `INSERT INTO deferred_work (project, title, created_at_epoch) VALUES ('p', 'saved in the window', 1)`,
      ).run();
      w.close();
      return original.call(this, dest, opts);
    });
    let r;
    try {
      r = await run(p);
    } finally {
      restore();
    }
    expect(r.outcome, text(r)).toBe('refused');
    expect(text(r)).toMatch(/changed while it was being read/);
    const db = new Database(p, { readonly: true });
    try {
      expect(
        db.prepare(`SELECT count(*) FROM deferred_work WHERE title = 'saved in the window'`).pluck().get(),
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  // better-sqlite3's backup resolves at once, having copied nothing, when its first step meets
  // another writer (totalPages 0).
  it('refuses, writing nothing, when another writer holds the store at the first step', async () => {
    const { p } = damagedLog();
    let holder;
    const restore = patchBackup(async function (original, dest, opts) {
      holder = new Database(dest);
      holder.exec('BEGIN IMMEDIATE');
      try {
        return await original.call(this, dest, opts);
      } finally {
        holder.exec('ROLLBACK');
        holder.close();
      }
    });
    const before = files(p);
    let r;
    try {
      r = await run(p);
    } finally {
      restore();
    }
    expect(r.outcome, text(r)).toBe('refused');
    expect(text(r)).toMatch(/Another process has .* open/);
    expect(files(p).main).toBe(before.main);
  });
});

describe('install.mjs repair-db (the shipped command)', () => {
  function cli(dataDir, args) {
    const home = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-db-repair-home-')));
    return spawnSync(process.execPath, [join(REPO, 'install.mjs'), ...args], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        MEM_NO_AUTO_ADOPT: '1',
      },
    });
  }

  it('repairs, then finds nothing to repair', () => {
    const { dir, before } = indexDamaged();
    const first = cli(dir, ['repair-db']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toMatch(/wrote it into/);
    sameExceptVersion(record(join(dir, DB)), before);
    const second = cli(dir, ['repair-db']);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/nothing to repair/i);
  });

  it('doctor names repair-db under a failed integrity check, and passes the repaired store', () => {
    const { dir } = indexDamaged();
    const bad = cli(dir, ['doctor']).stdout;
    expect(bad).toMatch(/✗ Database integrity: /);
    expect(bad).toMatch(/repair-db/);
    cli(dir, ['repair-db']);
    const good = cli(dir, ['doctor']).stdout;
    expect(good).toMatch(/✓ Database integrity: ok/);
    expect(good).not.toMatch(/✗ Database/);
  });

  // Round-2 claims F2: doctor's read-write FTS check ran first and its close folded the damaged
  // log frame into the main file, so repair-db, run next as doctor says, found no observation the
  // main file alone could give back (p5-v0/v1: 200 lost).
  it('doctor leaves a damaged log where it is, so repair-db still reads the main file alone', () => {
    const dir = newDir();
    const { p, mainAlone } = walStore(dir);
    const db = new Database(p, { readonly: true });
    const root = db
      .prepare(`SELECT pageno FROM dbstat WHERE name = 'observations' AND path = '/'`)
      .pluck()
      .get();
    db.close();
    plantWal(p, root, 0, 64, 0xff);
    premise(p);
    const before = { main: sha(p), wal: sha(`${p}-wal`) };
    const out = cli(dir, ['doctor']).stdout;
    expect(out).toMatch(/✗ Database integrity: /);
    expect(out).toMatch(/FTS5 integrity: not checked — it writes to the database/);
    expect({ main: sha(p), wal: sha(`${p}-wal`) }, 'doctor wrote nothing').toEqual(before);
    const r = cli(dir, ['repair-db']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const after = record(p).observations;
    for (const row of mainAlone.observations) expect(after).toContain(row);
  });

  // Round-3 defects review P2-8: page 1's schema format number damaged reads "unsupported file
  // format"; doctor printed ✗ with no step, while repair-db repairs the store.
  it('doctor names repair-db for a store SQLite calls an unsupported file format', () => {
    const dir = newDir();
    const { p } = walStore(dir);
    plantWal(p, 1, 44, 4, 0xff);
    const ro = new Database(p, { readonly: true });
    try {
      expect(() => ro.prepare('PRAGMA integrity_check').all(), 'premise').toThrow(/unsupported file format/);
    } finally {
      ro.close();
    }
    const out = cli(dir, ['doctor']).stdout;
    expect(out).toMatch(/✗ Database.*unsupported file format/);
    expect(out).toMatch(/repair-db/);
    const r = cli(dir, ['repair-db']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('rejects a flag rather than repairing', () => {
    const { dir, p } = indexDamaged();
    const original = sha(p);
    const r = cli(dir, ['repair-db', '--force']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown flag --force/);
    expect(sha(p)).toBe(original);
  });

  // After its own WAL delete the server used to say "Try: rm <wal> <shm>", naming files it had
  // just deleted, or "reinstall", which does not touch the data.
  it('the MCP server, failing on a damaged file, names repair-db rather than the deleted log', () => {
    const dir = newDir();
    writeFileSync(join(dir, DB), Buffer.alloc(4096, 7));
    const home = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-db-repair-home-')));
    const r = spawnSync(process.execPath, [join(REPO, 'server.mjs')], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 60_000,
      input: '',
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: dir,
        CLAUDE_MEM_SKIP_UPDATE: '1',
        MEM_NO_AUTO_ADOPT: '1',
      },
    });
    expect(r.stderr).toMatch(/FATAL: Database cannot be opened/);
    expect(r.stderr).toContain('repair-db');
    expect(r.stderr).not.toMatch(/Try: rm/);
    expect(r.status).toBe(1);
  });

  it('a sound store is reported sound (control for the cases above)', () => {
    const dir = newDir();
    buildStore(dir, { rows: 5 });
    expect(existsSync(join(dir, DB))).toBe(true);
    const r = cli(dir, ['repair-db']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/nothing to repair/i);
    expect(statSync(join(dir, DB)).size).toBeGreaterThan(0);
  });
});
