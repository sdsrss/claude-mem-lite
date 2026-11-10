// D#593 attempt 3, S3: every face that rebuilds or optimizes an index handles a checked write that
// committed nothing, on a store whose freelist lists a live page (D#591). One test per face:
// the opener's FTS-corruption branch, doctor, `fts-check rebuild` (CLI), `mem_fts_check rebuild`
// (MCP), the snapshot check's verdict, `maintain`'s optimize and the MCP idle pass's optimize.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initSchema } from '../schema.mjs';
import { intactObservations, writeCrossLinkedStore } from './test-helpers.mjs';

const REPO = resolve(import.meta.dirname, '..');
const SCHEMA_URL = pathToFileURL(join(REPO, 'schema.mjs')).href;
const BSQ_URL = pathToFileURL(createRequire(import.meta.url).resolve('better-sqlite3')).href;
const DB = 'claude-mem-lite.db';
const sha = (p) => createHash('sha1').update(readFileSync(p)).digest('hex');

let root;
let home;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cml-refusal-faces-'));
  home = join(root, 'home');
  mkdirSync(join(home, 'bin'), { recursive: true });
  // doctor asks `claude mcp list`; a no-op stand-in keeps it inside the sandbox.
  writeFileSync(join(home, 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const env = (dataDir) => ({
  ...process.env,
  HOME: home,
  PATH: `${join(home, 'bin')}:${process.env.PATH}`,
  CLAUDE_MEM_DIR: dataDir,
  CLAUDE_PROJECT_DIR: root,
  MEM_NO_AUTO_ADOPT: '1',
});
const child = (dataDir, src) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    env: env(dataDir),
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });

/** The product's opener writes on its first open of a store initSchema built; on these pages any
 *  write can overwrite rows, so it runs once before the damage is planted. */
function prepare(p) {
  const r = child(
    dirname(p),
    `const m = await import(${JSON.stringify(SCHEMA_URL)}); m.ensureDbWithWalRecovery().close();`,
  );
  if (r.status !== 0) throw new Error(`prepare: ${r.stderr}`);
}
function crossLinked(name, opts = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, DB);
  const { truth } = writeCrossLinkedStore(p, { prepare, ...opts });
  return { dir, p, truth };
}

/** ensureDbWithWalRecovery in a child where FTS5 reports corruption from the opener's first
 *  statement (once, or on every open), so the branch rebuilds. */
function openWithFtsFault(dir, { persistent }) {
  const r = child(
    dir,
    `const [{ default: Database }, m] = await Promise.all([import(${JSON.stringify(BSQ_URL)}), import(${JSON.stringify(SCHEMA_URL)})]);
      let thrown = 0;
      const orig = Database.prototype.pragma;
      Database.prototype.pragma = function (sql, ...rest) {
        if ((${persistent} || thrown === 0) && /^\\s*journal_mode\\s*=\\s*WAL/i.test(sql)) {
          thrown++;
          throw new Database.SqliteError('database disk image is malformed', 'SQLITE_CORRUPT_VTAB');
        }
        return orig.call(this, sql, ...rest);
      };
      const msgs = [];
      try {
        m.ensureDbWithWalRecovery({ warn: (x) => msgs.push(x), info: (x) => msgs.push(x) }).close();
      } catch (e) {
        msgs.push('THREW ' + (e.code || e.message));
      }
      process.stdout.write(JSON.stringify({ thrown, msgs }));`,
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe('the opener’s FTS-corruption branch', () => {
  it('does not claim a recovery when the checked rebuild wrote nothing, and keeps every row', () => {
    const { dir, p, truth } = crossLinked('opener', { vacuum: true });
    const out = openWithFtsFault(dir, { persistent: false });
    expect(out.thrown, 'the injected fault must have fired').toBe(1);
    expect(out.msgs.join('\n')).toMatch(/FTS rebuild not committed, nothing written: quick_check: /);
    expect(out.msgs).not.toContain('DB recovered after FTS rebuild');
    expect(intactObservations(p, truth)).toBe(truth.length);
  });

  it('when the store stays unopenable, its raw handle’s close does not checkpoint a log-only damage', () => {
    const { dir, p, truth } = crossLinked('opener-log', { inLog: true });
    const before = sha(p);
    const out = openWithFtsFault(dir, { persistent: true });
    expect(out.msgs.join('\n')).toMatch(/FTS rebuild not committed, nothing written: /);
    expect(out.msgs.at(-1)).toMatch(/^THREW SQLITE_CORRUPT_VTAB/);
    expect(sha(p)).toBe(before);
    expect(intactObservations(p, truth, { mainOnly: true })).toBe(truth.length);
  });
});

describe('doctor', () => {
  it('reports one ✗ for a rebuild it did not commit, and changes no byte of the store', () => {
    const { dir, p, truth } = crossLinked('doctor', { inLog: true });
    const before = sha(p);
    const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor', '--json'], {
      env: env(dir),
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    const lines = report.checks.filter((c) => /^FTS5 (not )?rebuilt/.test(c.message));
    expect(lines, JSON.stringify(report.checks.map((c) => c.message))).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'fail' });
    expect(lines[0].message).toMatch(/^FTS5 not rebuilt: the store is damaged \(quick_check: .+\)/);
    expect(intactObservations(p, truth)).toBe(truth.length);
    expect(sha(p)).toBe(before);
  });
});

describe('doctor’s MCP registration check', () => {
  // `claude mcp list` starts the MCP server, which writes as it opens; on this fixture that start
  // alone left 288 of 300 rows. A stand-in that really starts it for two seconds, as a health check.
  function serverStartingClaude() {
    writeFileSync(
      join(home, 'bin', 'claude'),
      `#!/bin/sh
if [ "$1" = mcp ] && [ "$2" = list ]; then
  "${process.execPath}" "${join(REPO, 'server.mjs')}" < /dev/null > /dev/null 2>&1 &
  pid=$!; sleep 2; kill -TERM $pid; wait $pid
  echo "mem-lite: node server.mjs - ✓ Connected"
fi
exit 0
`,
      { mode: 0o755 },
    );
  }
  const doctor = (dir) => {
    const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor', '--json'], {
      env: env(dir),
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
    return JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).checks.map((c) => c.message);
  };

  it('does not start the server on a store that reads damaged, and every row stays', () => {
    serverStartingClaude();
    const { dir, p, truth } = crossLinked('doctor-mcp', { inLog: true });
    const messages = doctor(dir);
    expect(messages.find((m) => /^MCP registration/.test(m))).toMatch(
      /^MCP registration: not checked — the store reads damaged \(.+\), and checking starts the MCP server/,
    );
    expect(intactObservations(p, truth)).toBe(truth.length);
  }, 60_000);

  it('still checks the registration on a sound store', () => {
    serverStartingClaude();
    const dir = join(root, 'sound');
    mkdirSync(dir);
    const db = new Database(join(dir, DB));
    initSchema(db);
    db.close();
    const line = doctor(dir).find((m) => /^MCP registration/.test(m));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/not checked/);
  }, 60_000);
});

describe('fts-check rebuild (CLI)', () => {
  it('exits 1 with the refusal, keeps every row, and its close does not checkpoint a log-only damage', () => {
    const { dir, p, truth } = crossLinked('cli', { inLog: true });
    const before = sha(p);
    const r = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'fts-check', 'rebuild'], {
      env: env(dir),
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^\[mem\] Not rebuilt: the store is damaged \(quick_check: /m);
    expect(r.stdout).toMatch(/doctor`: it checks the backup snapshots/);
    expect(intactObservations(p, truth)).toBe(truth.length);
    expect(sha(p)).toBe(before);
  });
});

describe('mem_fts_check rebuild (MCP)', () => {
  it('answers with the refusal and keeps every row', async () => {
    const { handleMemFtsCheck } = await import('../server/fts-check.mjs');
    const { p, truth } = crossLinked('mcp');
    const db = new Database(p);
    let text;
    try {
      text = handleMemFtsCheck(db, { action: 'rebuild' }).content[0].text;
    } finally {
      db.close();
    }
    expect(text).toMatch(/^Not rebuilt: the store is damaged \(quick_check: /);
    expect(text).toMatch(/doctor`: it checks the backup snapshots/);
    expect(intactObservations(p, truth)).toBe(truth.length);
  });
});

describe('the snapshot check', () => {
  it('leaves a snapshot unchecked when its rebuild could not be checked, whatever the code', async () => {
    // Condition 3 of the first attempt: a code the check did not list (here SQLITE_NOMEM) read as
    // a bad snapshot. The rebuild's own state decides.
    const du = await import('../lib/db-unusable.mjs');
    const dir = join(root, 'snap');
    mkdirSync(dir);
    const snap = join(dir, `${DB}.pre-delete-x.bak`);
    const db = new Database(snap);
    initSchema(db);
    db.close();
    const probe = join(root, 'fake-probe.mjs');
    writeFileSync(
      probe,
      `process.stdout.write(JSON.stringify({ opened: true, listed: 1, rebuildErrors: [{ code: 'SQLITE_NOMEM', message: 'not rebuilt: out of memory' }], rebuildCheck: 'unchecked', integrity: 'ok', observations: 1, otherRows: 0 }) + '\\n');`,
    );
    expect(du.checkSnapshot(snap, { probe })).toMatchObject({
      verdict: 'unchecked',
      reason: 'not rebuilt: out of memory',
    });
  });
});

describe('FTS5 optimize (maintain and the MCP idle pass)', () => {
  it('optimizeFts commits on a sound store and writes nothing on a cross-linked one', async () => {
    const { optimizeFts } = await import('../lib/maintain-core.mjs');
    const sound = join(root, 'sound.db');
    const s = new Database(sound);
    initSchema(s);
    try {
      expect(optimizeFts(s)).toMatchObject({ committed: true, check: 'ok' });
    } finally {
      s.close();
    }
    const { p, truth } = crossLinked('optimize', { vacuum: true });
    const db = new Database(p);
    try {
      expect(optimizeFts(db)).toMatchObject({ committed: false, check: 'damaged' });
    } finally {
      db.close();
    }
    expect(intactObservations(p, truth)).toBe(truth.length);
  });

  it('maintain says the index was not optimized', async () => {
    const { runMaintainOps } = await import('../lib/maintain-core.mjs');
    const { p, truth } = crossLinked('maintain', { vacuum: true });
    const db = new Database(p);
    let lines;
    try {
      lines = runMaintainOps(db, { projectFilter: '', baseParams: [], staleAge: 0, opCap: 100 }, []);
    } finally {
      db.close();
    }
    expect(lines).toContain('FTS5 index not optimized, nothing written: the store is damaged');
    expect(lines).not.toContain('FTS5 index optimized');
    expect(intactObservations(p, truth)).toBe(truth.length);
  });

  it('the idle pass goes through optimizeFts: no other optimize statement in the server or maintain', () => {
    // server.mjs runs as a process (outside unit coverage); its idle pass must call the checked helper.
    const code = (f) =>
      readFileSync(join(REPO, f), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');
    const server = code('server.mjs');
    const maintain = code('lib/maintain-core.mjs');
    expect(server).toMatch(/const opt = optimizeFts\(db\);/);
    expect(server).not.toMatch(/VALUES\('optimize'\)/);
    expect(maintain.match(/VALUES\('optimize'\)/g)).toHaveLength(1);
  });
});
