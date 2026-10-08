// Kill-point sweeps over installExtractedRelease (D#283 review round 1, D#289). node:fs is wrapped,
// not replaced: a "kill" at op k makes the k-th mutating fs call and every later one throw, so what
// is left on disk is what a SIGKILL there leaves. The test then runs the recovery the next install
// entry would run and requires ONE whole release: the old one or the new one, never a mix.
//
// "Torn" kills model a write cut short between its truncate and its data (a kill, or ENOSPC): the
// file the write was aimed at is left empty. A journal written in place was left empty that way,
// recovery read it as "nothing moved" and deleted the backups — the only copy of every file already
// moved out (8 of 47 and 8 of 63 kill points, measured 2026-10-08 on 3af1a0c7).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const ctl = {
  counting: false,
  dead: false,
  killAt: -1,
  throwAt: -1,
  ops: 0,
  torn: false,
  log: [],
  writeFaults: [],
};
globalThis.__swapKillCtl = ctl;

vi.mock('node:child_process', () => ({ execSync: vi.fn(), execFileSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal();
  const c = () => globalThis.__swapKillCtl;
  const tick = (kind, p) => {
    const ctl = c();
    if (!ctl.counting) return;
    if (ctl.dead) throw Object.assign(new Error('process is dead'), { code: 'EDEAD' });
    ctl.log.push(`${kind} ${p}`);
    if (ctl.throwAt === ctl.ops && kind === 'rename') {
      ctl.ops++;
      throw Object.assign(new Error('EIO: simulated rename failure'), { code: 'EIO' });
    }
    if (ctl.ops++ === ctl.killAt) {
      ctl.dead = true;
      if (ctl.torn && kind === 'write' && p.includes('.swap-journal.json')) real.writeFileSync(p, '');
      throw Object.assign(new Error('killed'), { code: 'EDEAD' });
    }
  };
  return {
    ...real,
    renameSync(from, to) {
      tick('rename', `${from} -> ${to}`);
      return real.renameSync(from, to);
    },
    rmSync(p, o) {
      tick('rm', String(p));
      return real.rmSync(p, o);
    },
    unlinkSync(p) {
      tick('unlink', String(p));
      return real.unlinkSync(p);
    },
    writeFileSync(p, d, o) {
      tick('write', String(p));
      const ctl = c();
      const f = ctl.counting && ctl.writeFaults.find((x) => x.match(String(p)));
      if (f) {
        ctl.writeFaults = ctl.writeFaults.filter((x) => x !== f);
        throw Object.assign(new Error(`ENOSPC: no space left on device, write '${p}'`), { code: 'ENOSPC' });
      }
      return real.writeFileSync(p, d, o);
    },
    mkdirSync(p, o) {
      tick('mkdir', String(p));
      return real.mkdirSync(p, o);
    },
  };
});

const mockedExecSync = vi.mocked(execSync);
const originalHome = process.env.HOME;
const dirs = [];
const makeDir = (prefix) => {
  const dir = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
};

const OLD = {
  'package.json': '{"version":"1.0.0"}',
  'server.mjs': '// old server',
  'hook.mjs': '// old hook',
  'node_modules/dep.js': 'old-dep',
  'node_modules/sub/x.js': 'old-x',
};
const NEW = {
  'package.json': '{"version":"1.1.0"}',
  'server.mjs': '// new server',
  'hook.mjs': '// new hook',
  'cli.mjs': '// new cli',
  'node_modules/dep.js': 'new-dep',
  'node_modules/sub/x.js': 'new-x',
};

function makeDataDir() {
  const dir = makeDir('swap-kill-data');
  fs.mkdirSync(join(dir, 'runtime'), { recursive: true });
  for (const [k, v] of Object.entries(OLD)) {
    fs.mkdirSync(join(dir, k, '..'), { recursive: true });
    fs.writeFileSync(join(dir, k), v);
  }
  return dir;
}

function makeReleaseDir() {
  const dir = makeDir('swap-kill-release');
  for (const [k, v] of Object.entries(NEW)) {
    if (!k.startsWith('node_modules/')) fs.writeFileSync(join(dir, k), v);
  }
  return dir;
}

const smoke =
  (pass) =>
  (cmd, opts = {}) => {
    if (String(cmd).startsWith('npm install')) {
      fs.mkdirSync(join(opts.cwd, 'node_modules', 'sub'), { recursive: true });
      fs.writeFileSync(join(opts.cwd, 'node_modules', 'dep.js'), 'new-dep');
      fs.writeFileSync(join(opts.cwd, 'node_modules', 'sub', 'x.js'), 'new-x');
      return '';
    }
    if (!pass && (String(cmd).includes('cli.mjs') || String(cmd).includes('--check')))
      throw new Error('broken');
    return '';
  };

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (rel === 'runtime' || rel.startsWith('.update-')) continue;
      if (e.isDirectory()) walk(p);
      else out[rel] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
const residue = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('.update-'));
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const kindOf = (t) => (same(t, OLD) ? 'OLD' : same(t, NEW) ? 'NEW' : 'MIXED');

async function loadModule(dataDir) {
  vi.resetModules();
  for (const v of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'CLAUDE_PLUGIN_ROOT'])
    delete process.env[v];
  process.env.CLAUDE_MEM_DIR = dataDir;
  process.env.HOME = makeDir('swap-kill-home');
  return await import('../hook-update.mjs');
}

async function runInstall(mod, dataDir, releaseDir, { killAt = -1, torn = false, throwAt = -1 } = {}) {
  Object.assign(ctl, { counting: true, dead: false, killAt, ops: 0, torn, log: [], throwAt });
  let ret;
  try {
    ret = await mod.installExtractedRelease(releaseDir, dataDir);
  } catch (e) {
    ret = `threw:${e.code || e.message}`;
  }
  ctl.counting = false;
  ctl.dead = false;
  return ret;
}

afterEach(() => {
  mockedExecSync.mockReset();
  Object.assign(ctl, {
    counting: false,
    dead: false,
    killAt: -1,
    throwAt: -1,
    ops: 0,
    torn: false,
    log: [],
    writeFaults: [],
  });
  delete process.env.CLAUDE_MEM_DIR;
  process.env.HOME = originalHome;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('every kill point inside a swap recovers to one whole release', () => {
  for (const pass of [true, false]) {
    for (const torn of [false, true]) {
      it(`smoke ${pass ? 'passes' : 'fails'}${torn ? ', with torn journal writes' : ''}`, async () => {
        let dataDir = makeDataDir();
        mockedExecSync.mockImplementation(smoke(pass));
        let mod = await loadModule(dataDir);
        expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(pass);
        expect(kindOf(snapshot(dataDir))).toBe(pass ? 'NEW' : 'OLD'); // premise: the clean run
        const total = ctl.ops;
        const fullLog = [...ctl.log];
        const journalWrites = fullLog.filter(
          (l) => l.startsWith('write ') && l.includes('.swap-journal.json'),
        );
        expect(journalWrites.length, 'premise: the swap journals its renames').toBeGreaterThan(4);

        // A passed swap is committed from the first cleanup step on: it marks its backup dir resolved
        // and removes the staging dir only after its check passed. A kill from there on must recover
        // to the NEW release, never replay the journal back to the old one (D#292 C).
        const resolvedAt = fullLog.findIndex((l) => l.startsWith('write ') && l.endsWith('.swap-resolved'));
        const stagingRmAt = fullLog.findIndex((l) => /^rm .*\.update-staging-[^/]*$/.test(l));
        if (pass) {
          expect(resolvedAt, 'premise: a passed swap marks itself resolved').toBeGreaterThan(-1);
          expect(stagingRmAt, 'premise: a passed swap removes its staging dir').toBeGreaterThan(-1);
        }
        const committedFrom = Math.min(resolvedAt + 1, stagingRmAt);

        const bad = [];
        for (let k = 0; k < total; k++) {
          dataDir = makeDataDir();
          mockedExecSync.mockImplementation(smoke(pass));
          mod = await loadModule(dataDir);
          await runInstall(mod, dataDir, makeReleaseDir(), { killAt: k, torn });
          mod.recoverInterruptedSwaps(dataDir);
          const kind = kindOf(snapshot(dataDir));
          const step = `${k} ${fullLog[k].replaceAll(dataDir, '')}`;
          if (kind === 'MIXED') bad.push(step);
          else if (pass && k >= committedFrom && kind !== 'NEW')
            bad.push(`${step} -> ${kind} after the commit`);
        }
        expect(bad).toEqual([]);
      }, 120000);
    }
  }
});

describe('a forward rename throws, then a kill lands inside the rollback or its cleanup', () => {
  it('every (throw, kill) pair recovers to the old release', async () => {
    let dataDir = makeDataDir();
    mockedExecSync.mockImplementation(smoke(true));
    let mod = await loadModule(dataDir);
    await runInstall(mod, dataDir, makeReleaseDir());
    const renames = ctl.log
      .map((l, i) => [l, i])
      .filter(([l]) => l.startsWith('rename '))
      .map(([, i]) => i);
    let pairs = 0;
    const bad = [];
    for (const j of renames) {
      dataDir = makeDataDir();
      mockedExecSync.mockImplementation(smoke(true));
      mod = await loadModule(dataDir);
      expect(await runInstall(mod, dataDir, makeReleaseDir(), { throwAt: j })).toBe(false);
      const n = ctl.ops;
      for (let k = j + 1; k < n; k++) {
        dataDir = makeDataDir();
        mockedExecSync.mockImplementation(smoke(true));
        mod = await loadModule(dataDir);
        await runInstall(mod, dataDir, makeReleaseDir(), { throwAt: j, killAt: k });
        mod.recoverInterruptedSwaps(dataDir);
        pairs++;
        if (kindOf(snapshot(dataDir)) !== 'OLD') bad.push({ j, k });
      }
    }
    expect(pairs, 'premise: the sweep reached the rollback').toBeGreaterThan(20);
    expect(bad).toEqual([]);
  }, 300000);
});

// doctor and cleanup recognise an unfinished swap by its journal's name, which they spell apart
// from hook-update (lib/doctor-stale-temp.mjs). Read the name off a journal the swap really wrote.
describe('the journal a killed swap leaves is the one doctor and cleanup look for', () => {
  it('classifies as an unfinished swap', async () => {
    const { classifyUpdateResidue } = await import('../lib/doctor-stale-temp.mjs');
    const dataDir = makeDataDir();
    mockedExecSync.mockImplementation(smoke(true));
    const mod = await loadModule(dataDir);
    await runInstall(mod, dataDir, makeReleaseDir()); // count the ops of a clean run
    const firstRename = ctl.log.findIndex((l) => l.startsWith('rename ') && l.includes('.update-backup-'));
    const fresh = makeDataDir();
    mockedExecSync.mockImplementation(smoke(true));
    const mod2 = await loadModule(fresh);
    await runInstall(mod2, fresh, makeReleaseDir(), { killAt: firstRename + 1 });
    const left = residue(fresh).filter((n) => n.startsWith('.update-backup-'));
    expect(left.length, 'premise: the kill left a backup dir').toBe(1);
    expect(classifyUpdateResidue(fresh, left[0])).toBe('unfinished-swap');
  });
});

// D#289 (B): journalSwap swallowed its own write error, so the rename it was meant to record went
// ahead unrecorded, and a kill after that left a file in the backup dir that no journal named.
describe('a journal that cannot be written stops the swap', () => {
  it('before the rename it would have recorded, and the old release stays whole', async () => {
    const dataDir = makeDataDir();
    mockedExecSync.mockImplementation(smoke(true));
    const mod = await loadModule(dataDir);
    let journalWrites = 0;
    ctl.writeFaults.push({ match: (p) => p.includes('.swap-journal.json') && ++journalWrites === 3 });

    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
    expect(ctl.writeFaults, 'premise: the fault fired').toEqual([]);
    expect(kindOf(snapshot(dataDir))).toBe('OLD');
    expect(residue(dataDir)).toEqual([]);
  });
});
