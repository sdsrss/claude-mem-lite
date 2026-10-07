// D#239 (g): the swap marker (runtime/swap-in-progress) makes scripts/hook-launcher.mjs skip a
// hook fire while installExtractedRelease renames a release into place, so no hook imports a
// half-swapped module graph. The two rollbacks — the MED-5 smoke gate and the recovery of a
// hard-killed swap at the next entry — rename files back in the same way, but ran with the
// marker already cleared. Every rename out of a backup dir must happen under the marker.
//
// node:fs is wrapped, not replaced: renameSync records whether the marker exists at the moment
// a backup is restored, then performs the real rename.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const restores = [];
// Ordered log: 'clear' (the marker removed), 'restore' (a backup renamed back), 'delete' (an
// installed path removed by the rollback), each with whether the marker existed at that moment.
const events = [];
let marker = null;
let failSwapInto = null; // a target path whose forward rename throws once

vi.mock('node:child_process', () => ({ execSync: vi.fn(), execFileSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    renameSync(from, to) {
      if (marker && String(from).includes('.update-backup-')) {
        restores.push({ from: String(from), marked: real.existsSync(marker) });
        events.push({ kind: 'restore', marked: real.existsSync(marker) });
      }
      if (failSwapInto && String(to) === failSwapInto && String(from).includes('.update-staging-')) {
        failSwapInto = null;
        events.push({ kind: 'throw', marked: real.existsSync(marker) });
        throw Object.assign(new Error('EIO: simulated swap failure'), { code: 'EIO' });
      }
      return real.renameSync(from, to);
    },
    rmSync(path, opts) {
      const p = String(path);
      if (marker && p === marker) events.push({ kind: 'clear', marked: real.existsSync(marker) });
      else if (
        marker &&
        !p.includes('.update-') &&
        events.recordDeletesUnder &&
        p.startsWith(events.recordDeletesUnder)
      ) {
        events.push({ kind: 'delete', marked: real.existsSync(marker) });
      }
      return real.rmSync(path, opts);
    },
  };
});

const mockedExecSync = vi.mocked(execSync);
const originalHome = process.env.HOME;
const dirs = [];

function makeDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

function makeDataDir() {
  const dir = makeDir('mem-rollback-data');
  mkdirSync(join(dir, 'runtime'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(dir, 'server.mjs'), '// server');
  writeFileSync(join(dir, 'hook.mjs'), '// old hook');
  return dir;
}

function makeReleaseDir() {
  const dir = makeDir('mem-rollback-release');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.1.0' }));
  writeFileSync(join(dir, 'hook.mjs'), '// new hook');
  writeFileSync(join(dir, 'server.mjs'), '// new server');
  writeFileSync(join(dir, 'cli.mjs'), '#!/usr/bin/env node\n');
  return dir;
}

async function loadModule(dataDir) {
  vi.resetModules();
  for (const v of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'CLAUDE_PLUGIN_ROOT'])
    delete process.env[v];
  process.env.CLAUDE_MEM_DIR = dataDir;
  process.env.HOME = makeDir('mem-rollback-home');
  marker = join(dataDir, 'runtime', 'swap-in-progress');
  return await import('../hook-update.mjs');
}

afterEach(() => {
  mockedExecSync.mockReset();
  restores.length = 0;
  events.length = 0;
  delete events.recordDeletesUnder;
  marker = null;
  failSwapInto = null;
  delete process.env.CLAUDE_MEM_DIR;
  process.env.HOME = originalHome;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('rollbacks restore files under the swap marker (D#239 g)', () => {
  it('the MED-5 smoke rollback', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install')) {
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
        return '';
      }
      if (String(cmd).includes('cli.mjs') || String(cmd).includes('--check')) throw new Error('broken');
      return '';
    });
    const { installExtractedRelease } = await loadModule(dataDir);
    events.recordDeletesUnder = dataDir + '/';

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(false);
    expect(readFileSync(join(dataDir, 'hook.mjs'), 'utf8')).toBe('// old hook'); // premise: it rolled back
    expect(restores.length).toBeGreaterThan(0);
    expect(restores.filter((r) => !r.marked)).toEqual([]);
    // The new files are deleted before the old ones come back: that is a window too.
    const deletes = events.filter((e) => e.kind === 'delete');
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.filter((e) => !e.marked)).toEqual([]);
    expect(existsSync(marker)).toBe(false); // and released afterwards
  });

  it('a swap that throws halfway keeps the marker until its rollback is done', async () => {
    const dataDir = makeDataDir();
    const releaseDir = makeReleaseDir();
    mockedExecSync.mockImplementation((cmd, opts = {}) => {
      if (String(cmd).startsWith('npm install'))
        mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true });
      return '';
    });
    const { installExtractedRelease } = await loadModule(dataDir);
    failSwapInto = join(dataDir, 'server.mjs');

    expect(await installExtractedRelease(releaseDir, dataDir)).toBe(false);
    expect(readFileSync(join(dataDir, 'server.mjs'), 'utf8')).toBe('// server'); // premise: rolled back
    // The forward swap itself ran under the marker, and nothing cleared it before the rollback.
    expect(events.find((e) => e.kind === 'throw')).toEqual({ kind: 'throw', marked: true });
    const lastRestore = events.map((e) => e.kind).lastIndexOf('restore');
    const firstClear = events.findIndex((e) => e.kind === 'clear');
    expect(lastRestore).toBeGreaterThanOrEqual(0);
    expect(firstClear).toBeGreaterThan(lastRestore);
    expect(existsSync(marker)).toBe(false);
  });

  it('the recovery of a swap a killed updater left behind', async () => {
    const dataDir = makeDataDir();
    const backup = join(dataDir, '.update-backup-1-1');
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, 'hook.mjs'), '// pre-swap hook');
    writeFileSync(
      join(backup, '.swap-journal.json'),
      JSON.stringify({ backedUp: ['hook.mjs'], installed: ['hook.mjs'] }),
    );
    mockedExecSync.mockImplementation((cmd) => {
      if (String(cmd).startsWith('npm install')) throw new Error('offline'); // stop after recovery
      return '';
    });
    const { installExtractedRelease } = await loadModule(dataDir);

    expect(await installExtractedRelease(makeReleaseDir(), dataDir)).toBe(false);
    expect(readFileSync(join(dataDir, 'hook.mjs'), 'utf8')).toBe('// pre-swap hook'); // premise: recovered
    expect(restores.length).toBe(1);
    expect(restores[0].marked).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});
