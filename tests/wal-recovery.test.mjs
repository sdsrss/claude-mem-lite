// Audit P3-13: coverage for server.mjs's DB-open recovery branch (server.mjs:71-98).
//
// That branch is the highest-risk startup path in the repo and had no test. It deletes
// `-wal`/`-shm` and retries ONLY when the open error carries a corruption signature
// (/SQLITE_CORRUPT|SQLITE_NOTADB|malformed|not a database|disk image/), and deliberately
// fails fast with the WAL intact on anything else (SQLITE_BUSY, the schema.mjs forward-
// version guard) — deleting a WAL on a transient error would discard committed-but-
// uncheckpointed transactions.
//
// Why FILE-BACKED: every schema/migration unit test uses `new Database(':memory:')`, and
// SQLite silently IGNORES `journal_mode = WAL` for in-memory DBs — schema.mjs:981 asks
// for WAL, an in-memory handle answers `memory`. So no unit test in this repo exercises
// real WAL semantics at all; the first test below pins that contrast explicitly.
//
// server.mjs opens its DB at module scope (import = execute), so every case here drives
// it as a spawned process against a real on-disk CLAUDE_MEM_DIR, like tests/mcp-protocol.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';

const SERVER_PATH = resolve(import.meta.dirname, '../server.mjs');
const DB_NAME = 'claude-mem-lite.db';

// schema.mjs resolves DB_DIR from CLAUDE_MEM_DIR at import time, so point it at a
// throwaway sandbox BEFORE the dynamic import (vitest.config forces CLAUDE_MEM_DIR='').
const SANDBOX = mkdtempSync(join(tmpdir(), 'mem-wal-sandbox-'));
process.env.CLAUDE_MEM_DIR = SANDBOX;
const { ensureDb, DB_PATH, CURRENT_SCHEMA_VERSION } = await import('../schema.mjs');

const fixtures = [];
function fixtureDir(tag) {
  const d = mkdtempSync(join(tmpdir(), `mem-wal-${tag}-`));
  fixtures.push(d);
  return d;
}

/** Bytes of a fully checkpointed, schema-current DB — the "main file is fine" baseline. */
let PRISTINE_DB;

beforeAll(() => {
  const db = ensureDb();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  PRISTINE_DB = readFileSync(DB_PATH);
});

afterAll(() => {
  while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true });
  rmSync(SANDBOX, { recursive: true, force: true });
});

// ─── WAL checksum arithmetic (SQLite fileformat2 §4.1, "Checksum Algorithm") ──
// Needed because SQLite SILENTLY DISCARDS a WAL whose frame checksums don't verify —
// splattering random bytes over a `-wal` produces a clean open, not a corruption error.
// The only way to reach the recovery branch through the WAL is a checksum-VALID frame
// carrying a corrupt page image, which is exactly what a torn write / bad sector yields.
function walChecksum(buf, s0, s1, bigEndian) {
  for (let i = 0; i + 7 < buf.length; i += 8) {
    const a = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
    const b = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
    s0 = (s0 + a + s1) >>> 0;
    s1 = (s1 + b + s0) >>> 0;
  }
  return [s0, s1];
}

/**
 * Build `<dir>/claude-mem-lite.db` + a `-wal` whose page-1 frame is checksum-valid but
 * carries a corrupt page image. Main DB file is byte-identical to the pristine baseline,
 * so deleting the WAL is genuinely the right repair — the case the branch exists for.
 */
function plantCorruptWal(dir) {
  const dbPath = join(dir, DB_NAME);
  writeFileSync(dbPath, PRISTINE_DB);

  // Produce a real uncheckpointed WAL: CREATE TABLE dirties page 1 (sqlite_master).
  const live = new Database(dbPath);
  live.pragma('journal_mode = WAL');
  live.pragma('wal_checkpoint(TRUNCATE)');
  live.exec('CREATE TABLE _wal_probe_marker(x TEXT)');
  const wal = readFileSync(dbPath + '-wal'); // snapshot while the handle is still open
  live.close(); // close checkpoints — main file is rewritten
  writeFileSync(dbPath, PRISTINE_DB); // …so restore the pre-CREATE baseline
  rmSync(dbPath + '-shm', { force: true });

  const bigEndian = wal.readUInt32BE(0) === 0x377f0683;
  const pageSize = wal.readUInt32BE(8);
  const frames = [];
  for (let off = 32; off + 24 + pageSize <= wal.length; off += 24 + pageSize) {
    frames.push({ off, pgno: wal.readUInt32BE(off) });
  }
  const target = frames.find((f) => f.pgno === 1);
  expect(target, 'fixture must contain a page-1 WAL frame').toBeTruthy();

  const bad = Buffer.from(wal);
  bad.fill(0xff, target.off + 24 + 100, target.off + 24 + 300);
  // Re-sign every frame: the checksum chain is cumulative from the WAL header.
  let [s0, s1] = walChecksum(wal.subarray(0, 24), 0, 0, bigEndian);
  for (const f of frames) {
    [s0, s1] = walChecksum(bad.subarray(f.off, f.off + 8), s0, s1, bigEndian);
    [s0, s1] = walChecksum(bad.subarray(f.off + 24, f.off + 24 + pageSize), s0, s1, bigEndian);
    bad.writeUInt32BE(s0, f.off + 16);
    bad.writeUInt32BE(s1, f.off + 20);
  }
  writeFileSync(dbPath + '-wal', bad);
  writeFileSync(dbPath + '-shm', Buffer.alloc(32768)); // a crash leaves one behind too
  return dbPath;
}

/**
 * Spawn server.mjs against `dir` and drive one MCP `initialize` over stdio.
 * Resolves { exitCode, stderr, served } — `served` is true only if the process answered
 * the JSON-RPC handshake, i.e. it really came up rather than merely not crashing yet.
 */
function runServer(dir, { timeoutMs = 20000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        CLAUDE_MEM_DIR: dir,
        CLAUDE_PROJECT_DIR: '/test/wal-project',
        PWD: '/test/wal-project',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        CLAUDE_MEM_AUTO_DEEP: '0',
        // Un-gate the recovery-arm debugLog lines (server.mjs:86,91) so the stderr
        // markers below deterministically distinguish which arm ran.
        CLAUDE_MEM_DEBUG: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '',
      stdout = '',
      settled = false;
    const finish = (exitCode, served) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolvePromise({ exitCode, stderr, stdout, served });
    };
    const timer = setTimeout(() => finish(null, false), timeoutMs);
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.stdout.on('data', (d) => {
      stdout += d;
      if (/"serverInfo"|"protocolVersion"/.test(stdout)) finish(null, true);
    });
    child.on('exit', (code) => finish(code, /"serverInfo"|"protocolVersion"/.test(stdout)));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'wal-test', version: '0.0.0' },
        },
      }) + '\n',
    );
  });
}

// ─── 1. WAL is real on disk, and cannot be on :memory: ───────────────────────

describe('file-backed WAL semantics', () => {
  it('ensureDb() on a real file yields journal_mode=wal', () => {
    const dir = fixtureDir('jm');
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        `import('${resolve(import.meta.dirname, '../schema.mjs')}').then(m => {
         const db = m.ensureDb();
         process.stdout.write(String(db.pragma('journal_mode', { simple: true })));
         db.close();
       })`,
      ],
      { env: { ...process.env, CLAUDE_MEM_DIR: dir }, encoding: 'utf8' },
    );
    expect(out.trim()).toBe('wal');
    expect(existsSync(join(dir, DB_NAME))).toBe(true);
  });

  it(':memory: silently downgrades the same pragma to "memory"', () => {
    // This is why no in-memory unit test can cover the recovery branch: the pragma at
    // schema.mjs:981 is accepted and ignored, so a `:memory:` DB has no -wal/-shm at all.
    const mem = new Database(':memory:');
    mem.pragma('journal_mode = WAL');
    expect(mem.pragma('journal_mode', { simple: true })).toBe('memory');
    mem.close();
  });
});

// ─── 2. Corruption signature → recovery arm is entered ───────────────────────

describe('corruption recovery branch', () => {
  it('the fixture really is corrupt (guard: a pristine copy opens fine)', () => {
    const control = fixtureDir('control');
    const dbPath = join(control, DB_NAME);
    writeFileSync(dbPath, PRISTINE_DB);
    const db = new Database(dbPath);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='observations'").get()).toBeTruthy();
    db.close();

    const corrupt = fixtureDir('sig');
    const badPath = plantCorruptWal(corrupt);
    let err = null;
    try {
      new Database(badPath).prepare('SELECT name FROM sqlite_master').all();
    } catch (e) {
      err = e;
    }
    expect(err, 'planted WAL must make the open fail').toBeTruthy();
    // Same regex server.mjs:79 gates the rm on.
    expect(`${err.code || ''} ${err.message || ''}`).toMatch(
      /SQLITE_CORRUPT|SQLITE_NOTADB|malformed|not a database|disk image/i,
    );
  });

  // This asserts the BRANCH was entered — not any filesystem byte-state, which is SQLite
  // internals rather than server.mjs behavior. The guard test above proved this exact
  // fixture makes a plain open throw a corruption error; the two stderr markers below then
  // prove server.mjs matched the signature and ran the recovery arm (deleted -wal/-shm,
  // retried ensureDb) rather than the transient fail-fast arm:
  //   present: "DB corruption detected, attempting WAL recovery" (the recovery-arm log,
  //            surfaced by the CLAUDE_MEM_DEBUG=1 that runServer sets)
  //   absent:  "Left WAL/SHM intact" (the fail-fast arm's banner)
  // Deliberately NOT asserted: the post-run -wal/-shm existence (a failed retry reopens in
  // WAL mode and recreates a 0-byte -wal), and whether the server ultimately serves —
  // with this fixture the retry does not complete a recovery, so it exits 1 without
  // serving. exitCode===1 is the agreed, deterministic outcome and is pinned here.
  it('enters the WAL-delete recovery arm on a corruption signature', async () => {
    const dir = fixtureDir('recover');
    const dbPath = plantCorruptWal(dir);
    expect(existsSync(dbPath + '-wal')).toBe(true);

    const { stderr, exitCode } = await runServer(dir);

    expect(stderr, 'server must enter the corruption-recovery arm').toContain(
      'DB corruption detected, attempting WAL recovery',
    );
    expect(stderr, 'must NOT take the transient fail-fast arm that preserves the WAL').not.toContain(
      'Left WAL/SHM intact',
    );
    expect(exitCode).toBe(1);
  }, 30000);
});

// ─── 3. Non-corruption failure → recovery arm is NOT entered ─────────────────

describe('non-corruption open failure', () => {
  it('fails fast on the forward-version guard without entering the WAL-delete arm', async () => {
    const dir = fixtureDir('forward');
    const dbPath = join(dir, DB_NAME);
    writeFileSync(dbPath, PRISTINE_DB);

    // Leave a real, checksum-valid uncheckpointed WAL present at open (child dies via
    // SIGKILL after a committed write, so no clean-close checkpoint runs). A bogus byte
    // string can't be used: SQLite discards a WAL whose header/checksums don't verify
    // during the open itself. The committed write is the schema_version bump to a future
    // version, which trips schema.mjs's forward-version guard — a throw with NO corruption
    // signature, exactly the class the fail-fast arm exists for.
    const kid = join(dir, 'seed-forward.mjs');
    writeFileSync(
      kid,
      [
        `import Database from ${JSON.stringify(resolve(import.meta.dirname, '../node_modules/better-sqlite3/lib/index.js'))};`,
        `const d = new Database(${JSON.stringify(dbPath)});`,
        `d.pragma('journal_mode = WAL');`,
        `d.pragma('wal_checkpoint(TRUNCATE)');`,
        `d.prepare('UPDATE schema_version SET version = ?').run(${CURRENT_SCHEMA_VERSION + 5});`,
        `process.kill(process.pid, 'SIGKILL');`,
      ].join('\n'),
    );
    try {
      execFileSync(process.execPath, [kid]);
    } catch {
      /* SIGKILL is expected */
    }

    const { exitCode, stderr, served } = await runServer(dir);

    // The forward-version guard carries no corruption signature, so server.mjs must take
    // the fail-fast arm and MUST NOT run its rmSync recovery. Assert the BRANCH only:
    // it fails fast (no serve, exit 1) with the intact banner and the version-guard
    // message, and the recovery-arm DEBUG marker is absent.
    // NOT asserted: any -wal byte-survival / existence — a WAL-mode open checkpoints
    // pending frames into the main file and truncates the -wal BEFORE schema.mjs's guard
    // throws, so SQLite (not server.mjs) empties it. That is orthogonal to the rm this
    // branch guards against; the branch choice above is the real contract.
    expect(served, 'server must not come up on a forward-version DB').toBe(false);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Left WAL/SHM intact');
    expect(stderr, 'the WAL-delete recovery arm must NOT run for a non-corruption error').not.toContain(
      'DB corruption detected',
    );
    expect(stderr).toMatch(/DB schema is v\d+/);
  }, 30000);
});

// ─── 4. Recovery is SHARED, not server.mjs-only (audit P3 fix) ────────────────
// Pre-fix, the corruption-gated recovery was inlined in server.mjs: hooks
// (openDb → silent null) and the CLI (raw throw) left a corrupt WAL in place
// until the next MCP server start. Now schema.mjs owns ensureDbWithWalRecovery
// and all three openers route through it. Child processes because schema.mjs
// freezes DB_PATH from CLAUDE_MEM_DIR at import time.

describe('shared WAL recovery (schema.ensureDbWithWalRecovery / hook openDb)', () => {
  it('ensureDbWithWalRecovery enters the recovery arm and tags a failed retry', () => {
    const dir = fixtureDir('shared-fn');
    plantCorruptWal(dir);
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        `import('${resolve(import.meta.dirname, '../schema.mjs')}').then((m) => {
         const msgs = [];
         try {
           const db = m.ensureDbWithWalRecovery({ warn: (x) => msgs.push(x) });
           db.close();
           console.log(JSON.stringify({ opened: true, msgs }));
         } catch (e) {
           console.log(JSON.stringify({ opened: false, attempted: !!e.walRecoveryAttempted, msgs }));
         }
       })`,
      ],
      { env: { ...process.env, CLAUDE_MEM_DIR: dir }, encoding: 'utf8' },
    );
    const r = JSON.parse(out.trim());
    expect(r.msgs.some((m) => m.includes('DB corruption detected, attempting WAL recovery'))).toBe(true);
    // Same pinned outcome as the server-process test above: this fixture's
    // retry does not complete a recovery — the throw must carry the marker so
    // callers word their fatal hint accurately.
    expect(r.opened).toBe(false);
    expect(r.attempted).toBe(true);
  }, 30000);

  it('hook openDb() attempts WAL recovery instead of blind-nulling on a corrupt WAL', () => {
    const dir = fixtureDir('hook-open');
    const dbPath = plantCorruptWal(dir);
    const plantedWalSize = readFileSync(dbPath + '-wal').length;
    expect(plantedWalSize).toBeGreaterThan(1000); // real frames on disk

    const out = execFileSync(
      process.execPath,
      [
        '-e',
        `Promise.all([import('${resolve(import.meta.dirname, '../hook-shared.mjs')}'), import('node:fs')]).then(([m, fs]) => {
         const db = m.openDb();
         if (db) { try { db.close(); } catch {} }
         const p = ${JSON.stringify(dbPath + '-wal')};
         console.log(JSON.stringify({
           isNull: db === null,
           walSize: fs.existsSync(p) ? fs.statSync(p).size : -1,
         }));
       })`,
      ],
      { env: { ...process.env, CLAUDE_MEM_DIR: dir }, encoding: 'utf8' },
    );
    const r = JSON.parse(out.trim());
    // Contract unchanged for callers: unrecoverable → null, hooks degrade.
    expect(r.isNull).toBe(true);
    // But the corrupt WAL must be GONE (or a fresh ~0-byte one recreated by the
    // retry's reopen) — pre-fix openDb left the planted frames untouched, so
    // every subsequent hook fire hit the same corruption until MCP restarted.
    expect(r.walSize).toBeLessThan(100);
  }, 30000);
});
