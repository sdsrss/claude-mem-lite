// D#293: a restore that fails inside rollbackInstall lost the only copy of that file.
//
// A rollback renames each moved-aside file back from the backup dir. When one rename failed (on
// Windows a scanner or a process holding the file; on Linux a target dir it cannot empty), the
// error was logged, and the caller then deleted the backup dir, the only copy of that file left.
// Now a rollback that could not put every file back keeps its backup dir and journal, unresolved,
// and the next entry replays it. There is no gate: an update that commits retires such a dir, so a
// restore that keeps failing never blocks later updates (a2cf96a1's gate did, review r2 F2).
//
// node:fs is wrapped, not replaced: a fault makes ONE matching call throw (or every one, `sticky`),
// and everything else reaches the real file system.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const ctl = { renameFaults: [], rmFaults: [], readFaults: [], readdirOrder: null, fired: [] };
globalThis.__restoreFailCtl = ctl;

vi.mock('node:child_process', () => ({ execSync: vi.fn(), execFileSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal();
  const c = () => globalThis.__restoreFailCtl;
  const take = (list, ...args) => {
    const f = list.find((x) => x.match(...args));
    if (!f) return null;
    if (!f.sticky) list.splice(list.indexOf(f), 1);
    c().fired.push(f.name || 'fault');
    return f;
  };
  return {
    ...real,
    renameSync(from, to) {
      const f = take(c().renameFaults, String(from), String(to));
      if (f) throw Object.assign(new Error(`${f.code}: simulated rename failure`), { code: f.code });
      return real.renameSync(from, to);
    },
    rmSync(p, o) {
      const f = take(c().rmFaults, String(p));
      if (f) {
        f.before?.();
        throw Object.assign(new Error(`${f.code}: simulated rm failure`), { code: f.code });
      }
      return real.rmSync(p, o);
    },
    readFileSync(p, o) {
      const f = take(c().readFaults, String(p));
      if (f) throw Object.assign(new Error(`${f.code}: simulated read failure`), { code: f.code });
      return real.readFileSync(p, o);
    },
    readdirSync(p, o) {
      const out = real.readdirSync(p, o);
      const order = c().readdirOrder;
      if (!order) return out;
      const name = (e) => (typeof e === 'string' ? e : e.name);
      return [...out].sort((a, b) => (order === 'asc' ? 1 : -1) * name(a).localeCompare(name(b)));
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
  const dir = makeDir('restore-fail-data');
  fs.mkdirSync(join(dir, 'runtime'), { recursive: true });
  for (const [k, v] of Object.entries(OLD)) {
    fs.mkdirSync(join(dir, k, '..'), { recursive: true });
    fs.writeFileSync(join(dir, k), v);
  }
  return dir;
}

function makeReleaseDir() {
  const dir = makeDir('restore-fail-release');
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

// Files by content; a symlink as `-> <target>`.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (rel === 'runtime' || rel.startsWith('.update-')) continue;
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[rel] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
const residue = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('.update-'));
const backups = (dir) => residue(dir).filter((n) => n.startsWith('.update-backup-'));
const resolved = (dir, name) => fs.existsSync(join(dir, name, '.swap-resolved'));

async function loadModule(dataDir) {
  vi.resetModules();
  for (const v of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'CLAUDE_PLUGIN_ROOT'])
    delete process.env[v];
  process.env.CLAUDE_MEM_DIR = dataDir;
  process.env.HOME = makeDir('restore-fail-home');
  return await import('../hook-update.mjs');
}

async function runInstall(mod, dataDir, releaseDir) {
  try {
    return await mod.installExtractedRelease(releaseDir, dataDir);
  } catch (e) {
    return `threw:${e.code || e.message}`;
  }
}

// The swap moves `server.mjs` from the tree into the backup dir, and back on a rollback.
const restoreOf = (dataDir, relPath) => (from, to) =>
  from.includes('.update-backup-') && to === join(dataDir, relPath);

afterEach(() => {
  mockedExecSync.mockReset();
  Object.assign(ctl, { renameFaults: [], rmFaults: [], readFaults: [], readdirOrder: null, fired: [] });
  delete process.env.CLAUDE_MEM_DIR;
  process.env.HOME = originalHome;
  for (const d of dirs.splice(0)) {
    try {
      fs.chmodSync(d, 0o755);
    } catch {
      /* gone */
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('a rollback that cannot put a file back keeps the backup dir for the next entry (D#293)', () => {
  it('thrown mid-swap, the restore of server.mjs fails once: the next entry puts it back', async () => {
    const dataDir = makeDataDir();
    mockedExecSync.mockImplementation(smoke(true));
    const mod = await loadModule(dataDir);
    ctl.renameFaults.push(
      {
        name: 'forward',
        code: 'EIO',
        match: (from, to) => from.includes('.update-staging-') && to === join(dataDir, 'server.mjs'),
      },
      { name: 'restore', code: 'EPERM', match: restoreOf(dataDir, 'server.mjs') },
    );
    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
    expect(ctl.fired).toEqual(['forward', 'restore']); // premise: both faults fired

    const [kept] = backups(dataDir);
    expect(kept, 'the backup dir holding the only copy of server.mjs was deleted').toBeDefined();
    expect(fs.readFileSync(join(dataDir, kept, 'server.mjs'), 'utf8')).toBe('// old server');
    expect(resolved(dataDir, kept)).toBe(false);

    mod.recoverInterruptedSwaps(dataDir);
    expect(snapshot(dataDir)).toEqual(OLD);
    expect(residue(dataDir)).toEqual([]);
  });

  it('smoke fails, removing the new node_modules stops halfway: the next entry puts the old one back', async () => {
    const dataDir = makeDataDir();
    mockedExecSync.mockImplementation(smoke(false));
    const mod = await loadModule(dataDir);
    // The new node_modules loses `sub` and then the rm throws, as a held .node makes it on
    // Windows; the rename of the old one back then fails ENOTEMPTY on its own.
    ctl.rmFaults.push({
      name: 'rm-new-node_modules',
      code: 'EBUSY',
      match: (p) => p === join(dataDir, 'node_modules'),
      before: () => fs.rmSync(join(dataDir, 'node_modules', 'sub'), { recursive: true }),
    });
    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
    expect(ctl.fired).toEqual(['rm-new-node_modules']);

    const [kept] = backups(dataDir);
    expect(kept, 'the backup dir holding the old node_modules was deleted').toBeDefined();
    expect(fs.readFileSync(join(dataDir, kept, 'node_modules', 'dep.js'), 'utf8')).toBe('old-dep');

    mod.recoverInterruptedSwaps(dataDir);
    expect(snapshot(dataDir)).toEqual(OLD);
    expect(residue(dataDir)).toEqual([]);
  });

  it('a restore that keeps failing does not block a later update, which retires the kept dir when it commits', async () => {
    const dataDir = makeDataDir();
    mockedExecSync.mockImplementation(smoke(false));
    const mod = await loadModule(dataDir);
    ctl.renameFaults.push({
      name: 'restore',
      code: 'EACCES',
      sticky: true,
      match: restoreOf(dataDir, 'server.mjs'),
    });
    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
    const [kept] = backups(dataDir);
    expect(kept).toBeDefined();

    // The fault is still there when the next update replays the kept dir; that update goes ahead.
    mockedExecSync.mockImplementation(smoke(true));
    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(true);
    expect(snapshot(dataDir)).toEqual(NEW);
    expect(resolved(dataDir, kept) || !fs.existsSync(join(dataDir, kept))).toBe(true);

    ctl.renameFaults = [];
    mod.recoverInterruptedSwaps(dataDir);
    expect(snapshot(dataDir), 'a retired dir was replayed over the committed release').toEqual(NEW);
    expect(residue(dataDir)).toEqual([]);
  });

  // Two kept dirs: the first swap could not put server.mjs back, and neither could the replay at
  // the start of the second swap, which then could not put hook.mjs back. Replayed oldest first,
  // the older journal puts server.mjs back and the newer one, which installed server.mjs, deletes
  // it again. Newest first is the only order that restores the old release, whatever order the
  // directory lists them in and whatever the clock said when each was named.
  for (const order of ['asc', 'desc']) {
    for (const clock of ['forward', 'backward']) {
      it(`two kept dirs are replayed newest first (readdir ${order}, clock ${clock})`, async () => {
        const dataDir = makeDataDir();
        mockedExecSync.mockImplementation(smoke(false));
        const mod = await loadModule(dataDir);
        ctl.renameFaults.push({
          name: 'restore-server',
          code: 'EPERM',
          sticky: true,
          match: restoreOf(dataDir, 'server.mjs'),
        });
        expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
        const [first] = backups(dataDir);

        ctl.renameFaults.push({ name: 'restore-hook', code: 'EPERM', match: restoreOf(dataDir, 'hook.mjs') });
        await new Promise((r) => setTimeout(r, 5)); // a later name for the second dir
        expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
        expect(ctl.fired).toContain('restore-hook');
        const second = backups(dataDir).find((n) => n !== first);
        expect(second, 'the second swap kept no backup dir').toBeDefined();

        if (clock === 'backward') {
          // The second dir's name carries an older timestamp, as after the clock was set back.
          const earlier = second.replace(/\d{13}/, '1000000000000');
          expect(earlier).not.toBe(second);
          fs.renameSync(join(dataDir, second), join(dataDir, earlier));
        }

        ctl.renameFaults = [];
        ctl.readdirOrder = order;
        mod.recoverInterruptedSwaps(dataDir);
        expect(snapshot(dataDir)).toEqual(OLD);
        expect(residue(dataDir)).toEqual([]);
      });
    }
  }

  it('while the newer kept dir still cannot be finished, the older one is not replayed', async () => {
    const dataDir = makeDataDir();
    mockedExecSync.mockImplementation(smoke(false));
    const mod = await loadModule(dataDir);
    ctl.renameFaults.push({
      name: 'restore-server',
      code: 'EPERM',
      sticky: true,
      match: restoreOf(dataDir, 'server.mjs'),
    });
    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
    ctl.renameFaults.push({ name: 'restore-hook', code: 'EPERM', match: restoreOf(dataDir, 'hook.mjs') });
    await new Promise((r) => setTimeout(r, 5));
    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
    expect(backups(dataDir)).toHaveLength(2);

    // server.mjs could be put back now, hook.mjs still cannot.
    ctl.renameFaults = [
      { name: 'restore-hook-again', code: 'EPERM', sticky: true, match: restoreOf(dataDir, 'hook.mjs') },
    ];
    mod.recoverInterruptedSwaps(dataDir);
    expect(ctl.fired).toContain('restore-hook-again');
    expect(backups(dataDir), 'the older dir was replayed under a newer unfinished one').toHaveLength(2);

    ctl.renameFaults = [];
    mod.recoverInterruptedSwaps(dataDir);
    expect(snapshot(dataDir)).toEqual(OLD);
    expect(residue(dataDir)).toEqual([]);
  });

  // Review P2-1: the order was read from the journals, so a journal that could not be read at the
  // wrong moment (a scanner holding it on Windows, EACCES) broke it, and a replay lost a file.
  for (const order of ['asc', 'desc']) {
    it(`a kept dir whose journal cannot be read when the next swap starts still replays last (readdir ${order})`, async () => {
      const dataDir = makeDataDir();
      mockedExecSync.mockImplementation(smoke(false));
      const mod = await loadModule(dataDir);
      ctl.renameFaults.push({
        name: 'restore-server',
        code: 'EPERM',
        match: restoreOf(dataDir, 'server.mjs'),
      });
      expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
      const [first] = backups(dataDir);

      const firstJournal = join(dataDir, first, '.swap-journal.json');
      ctl.readFaults.push({
        name: 'read-first',
        code: 'EBUSY',
        sticky: true,
        match: (p) => p === firstJournal,
      });
      ctl.renameFaults.push({ name: 'restore-hook', code: 'EPERM', match: restoreOf(dataDir, 'hook.mjs') });
      await new Promise((r) => setTimeout(r, 5));
      expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
      expect(ctl.fired).toEqual(expect.arrayContaining(['read-first', 'restore-hook']));
      expect(backups(dataDir)).toHaveLength(2);

      ctl.readFaults = [];
      ctl.readdirOrder = order;
      mod.recoverInterruptedSwaps(dataDir);
      expect(snapshot(dataDir)).toEqual(OLD);
      expect(residue(dataDir)).toEqual([]);
    });
  }

  it('an older kept dir is not replayed while a newer one’s journal cannot be read', async () => {
    const dataDir = makeDataDir();
    mockedExecSync.mockImplementation(smoke(false));
    const mod = await loadModule(dataDir);
    ctl.renameFaults.push({
      name: 'restore-server',
      code: 'EPERM',
      sticky: true,
      match: restoreOf(dataDir, 'server.mjs'),
    });
    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
    const [first] = backups(dataDir);
    ctl.renameFaults.push({ name: 'restore-hook', code: 'EPERM', match: restoreOf(dataDir, 'hook.mjs') });
    await new Promise((r) => setTimeout(r, 5));
    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
    const second = backups(dataDir).find((n) => n !== first);
    expect(second).toBeDefined();

    ctl.renameFaults = [];
    const secondJournal = join(dataDir, second, '.swap-journal.json');
    ctl.readFaults.push({
      name: 'read-second',
      code: 'EBUSY',
      sticky: true,
      match: (p) => p === secondJournal,
    });
    mod.recoverInterruptedSwaps(dataDir);
    expect(ctl.fired).toContain('read-second');
    expect(backups(dataDir), 'the older dir was replayed under a newer one it could not read').toHaveLength(
      2,
    );

    ctl.readFaults = [];
    mod.recoverInterruptedSwaps(dataDir);
    expect(snapshot(dataDir)).toEqual(OLD);
    expect(residue(dataDir)).toEqual([]);
  });

  it('the cleanup of the staging dir failing does not make a rolled-back update throw', async () => {
    const dataDir = makeDataDir();
    mockedExecSync.mockImplementation(smoke(false));
    const mod = await loadModule(dataDir);
    ctl.rmFaults.push({
      name: 'rm-staging',
      code: 'EBUSY',
      sticky: true,
      match: (p) => p.includes('.update-staging-'),
    });
    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
    expect(ctl.fired).toContain('rm-staging');
    expect(snapshot(dataDir)).toEqual(OLD);
  });
});

describe('the rollback reads a moved-aside path by lstat, not by what it points to (D#293, review r2 F11)', () => {
  it('a relative symlink that dangles once it is in the backup dir is still put back', async () => {
    const dataDir = makeDataDir();
    // hook.mjs -> real-hook.mjs resolves in the tree; moved into the backup dir it dangles.
    fs.writeFileSync(join(dataDir, 'real-hook.mjs'), '// real hook');
    fs.rmSync(join(dataDir, 'hook.mjs'));
    fs.symlinkSync('real-hook.mjs', join(dataDir, 'hook.mjs'));
    const before = snapshot(dataDir);
    mockedExecSync.mockImplementation(smoke(false));
    const mod = await loadModule(dataDir);
    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
    expect(snapshot(dataDir)).toEqual(before);
    expect(residue(dataDir)).toEqual([]);
  });

  // Over a file the rename back replaces what the swap installed anyway. Over the new
  // node_modules DIRECTORY it cannot, so the rollback has to delete that first, and it skipped the
  // delete when the dangling link read as already put back.
  it('a relative symlink in place of node_modules is put back over the new directory', async () => {
    const dataDir = makeDataDir();
    fs.renameSync(join(dataDir, 'node_modules'), join(dataDir, 'nm-real'));
    fs.symlinkSync('nm-real', join(dataDir, 'node_modules'));
    const before = snapshot(dataDir);
    mockedExecSync.mockImplementation(smoke(false));
    const mod = await loadModule(dataDir);
    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
    expect(snapshot(dataDir)).toEqual(before);
    expect(residue(dataDir)).toEqual([]);
  });

  it('a dangling link the rollback cannot put back keeps its backup dir like a file would', async () => {
    const dataDir = makeDataDir();
    fs.renameSync(join(dataDir, 'node_modules'), join(dataDir, 'nm-real'));
    fs.symlinkSync('nm-real', join(dataDir, 'node_modules'));
    const before = snapshot(dataDir);
    mockedExecSync.mockImplementation(smoke(false));
    const mod = await loadModule(dataDir);
    ctl.renameFaults.push({ name: 'restore-link', code: 'EPERM', match: restoreOf(dataDir, 'node_modules') });
    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
    expect(ctl.fired).toEqual(['restore-link']);
    expect(backups(dataDir), 'the dir holding the only copy of the link was deleted').toHaveLength(1);

    mod.recoverInterruptedSwaps(dataDir);
    expect(snapshot(dataDir)).toEqual(before);
    expect(residue(dataDir)).toEqual([]);
  });

  it('a symlink that already dangles in the tree is moved aside and put back like a file', async () => {
    const dataDir = makeDataDir();
    fs.symlinkSync('nowhere.mjs', join(dataDir, 'cli.mjs'));
    const before = snapshot(dataDir);
    mockedExecSync.mockImplementation(smoke(false));
    const mod = await loadModule(dataDir);
    expect(await runInstall(mod, dataDir, makeReleaseDir())).toBe(false);
    expect(snapshot(dataDir)).toEqual(before);
    expect(residue(dataDir)).toEqual([]);
  });
});
