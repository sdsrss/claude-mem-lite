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
      expect(text(r)).toMatch(/Could not open/);
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
    plantWal(p, masterLeaves(p)[2], 8, 64, 0xff);
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
  // in the log the same way, so the rows only the log holds can be checked value by value.
  it('reads a table whose definition the log garbled through the one the main file holds', async () => {
    const dir = newDir();
    const { p } = walStore(dir);
    const truth = record(p).observations;
    const db = new Database(p);
    const keep = readFileSync(p);
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
    expect(record(p).observations).toEqual(truth);
    expect(text(r)).toMatch(
      /observations: its definition reads differently from this version's in the database with its log/,
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
    expect(asides(dir)).toEqual([]);
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
