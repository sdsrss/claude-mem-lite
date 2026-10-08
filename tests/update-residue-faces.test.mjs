// D#289 (D, E): what install, cleanup and doctor do with a swap an updater left unfinished.
//
// installExtractedRelease stages and backs up beside the tree it swaps, the CODE dir
// (~/.claude-mem-lite), which CLAUDE_MEM_DIR does not move. A `.update-backup-*` dir that still
// holds its `.swap-journal.json` is a swap that did not finish (the updater was killed), and it
// holds the only copy of every file the swap had moved out. The next update entry replays it.
//
// Three faces got it wrong:
//   - install / repair wrote a newer tree without replaying it first, so the next update entry
//     replayed the old journal over that tree: it deleted the paths the killed swap had added and
//     put the older files back.
//   - cleanup deleted it as stale temp (the only copy of the old files), and under relocation it
//     scanned the data dir, where nothing writes these.
//   - doctor counted it as stale temp and sent the user to that cleanup; under relocation it did
//     not see it at all.
//
// Every run uses a sandbox HOME; each child gets an env without CLAUDE_MEM_DIR,
// CLAUDE_MEM_RUNTIME_DIR or CLAUDE_CONFIG_DIR unless the case sets one.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = join(REPO, 'install.mjs');
const HOOK_UPDATE = join(REPO, 'hook-update.mjs');
const homes = [];

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const JOURNALED = '.update-backup-1700000000000-4242';
const FINISHED = '.update-backup-1600000000000-1';
const STAGING = '.update-staging-1600000000000-1';

function sandbox({ relocate = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'upd-residue-'));
  homes.push(home);
  const codeDir = join(home, '.claude-mem-lite');
  const dataDir = relocate ? join(home, 'data') : codeDir;
  mkdirSync(join(dataDir, 'runtime'), { recursive: true });
  mkdirSync(codeDir, { recursive: true });
  return { home, codeDir, dataDir, relocate };
}

/** A swap killed after it had moved server.mjs out and put the new one (and cli.mjs) in. */
function seedUnfinishedSwap(codeDir, { relPath = 'server.mjs', added = 'cli.mjs' } = {}) {
  writeFileSync(join(codeDir, relPath), '// from the interrupted swap');
  writeFileSync(join(codeDir, added), '// added by the interrupted swap');
  const backup = join(codeDir, JOURNALED);
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, relPath), '// before the interrupted swap');
  writeFileSync(
    join(backup, '.swap-journal.json'),
    JSON.stringify({ backedUp: [relPath], installed: [relPath, added] }),
  );
}

/** Residue of swaps that are over: a backup dir whose journal was removed, and a staging dir. */
function seedFinishedResidue(codeDir) {
  mkdirSync(join(codeDir, FINISHED, 'node_modules'), { recursive: true });
  writeFileSync(join(codeDir, FINISHED, 'node_modules', 'x.js'), 'x');
  mkdirSync(join(codeDir, STAGING), { recursive: true });
}

function env(box, extra = {}) {
  const e = { ...process.env };
  for (const k of ['CLAUDE_MEM_DIR', 'CLAUDE_MEM_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR']) delete e[k];
  return {
    ...e,
    HOME: box.home,
    ...(box.relocate && { CLAUDE_MEM_DIR: box.dataDir }),
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    MEM_QUIET_HOOKS: '1',
    MEM_NO_AUTO_ADOPT: '1',
    ...extra,
  };
}

function run(box, args, extra = {}) {
  try {
    return execFileSync(process.execPath, [INSTALLER, ...args], {
      env: env(box, extra),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`; // doctor exits 1 when it finds issues
  }
}

/** What the next update entry runs first, in a child whose HOME is the sandbox. */
function nextUpdateEntry(box) {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(pathToFileURL(HOOK_UPDATE).href)});` +
        ` m.recoverInterruptedSwaps(${JSON.stringify(box.codeDir)});`,
    ],
    { env: env(box), stdio: 'pipe', timeout: 30_000 },
  );
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const residue = (dir) => readdirSync(dir).filter((n) => n.startsWith('.update-'));

function fakeClaudeBin(home) {
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'claude'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(binDir, 'claude'), 0o755);
  return binDir;
}

function doctorChecks(out) {
  const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  return json.checks || [];
}

describe('install finishes an unfinished swap before it writes the tree (D#289 E)', () => {
  it('so the next update entry does not replay the old journal over the new install', () => {
    const box = sandbox();
    seedUnfinishedSwap(box.codeDir, { relPath: 'hook.mjs', added: 'cli.mjs' });
    const out = run(box, ['install', '--dev', '--skip-repos'], {
      PATH: `${fakeClaudeBin(box.home)}:${process.env.PATH}`,
    });
    expect(lstatSync(join(box.codeDir, 'hook.mjs')).isSymbolicLink(), out).toBe(true); // premise: deployed

    nextUpdateEntry(box);
    expect(lstatSync(join(box.codeDir, 'hook.mjs')).isSymbolicLink(), 'the old hook.mjs came back').toBe(
      true,
    );
    expect(existsSync(join(box.codeDir, 'cli.mjs')), 'the installed cli.mjs was deleted').toBe(true);
    expect(residue(box.codeDir)).toEqual([]);
    expect(out).toMatch(/interrupted update/i);
  });
});

for (const relocate of [false, true]) {
  const shape = relocate ? 'CLAUDE_MEM_DIR relocated' : 'default shape';

  describe(`cleanup over update residue in the code dir (D#289 D, ${shape})`, () => {
    it('puts back the files an unfinished swap moved out, and removes the finished residue', () => {
      const box = sandbox({ relocate });
      seedUnfinishedSwap(box.codeDir);
      seedFinishedResidue(box.codeDir);
      const out = run(box, ['cleanup']);

      expect(read(join(box.codeDir, 'server.mjs')), out).toBe('// before the interrupted swap');
      expect(existsSync(join(box.codeDir, 'cli.mjs'))).toBe(false);
      expect(residue(box.codeDir)).toEqual([]);
      expect(out).toMatch(new RegExp(`Finished an interrupted update: ${JOURNALED}`));
      expect(out).toContain(`Removed: ${FINISHED}`);
      expect(out).toContain(`Removed: ${STAGING}`);
    });

    it('--dry-run names what it would finish apart from what it would remove, and changes nothing', () => {
      const box = sandbox({ relocate });
      seedUnfinishedSwap(box.codeDir);
      seedFinishedResidue(box.codeDir);
      const out = run(box, ['cleanup', '--dry-run']);

      expect(out).toContain(`Would finish an interrupted update: ${JOURNALED}`);
      expect((out.match(/Would remove:/g) || []).length, out).toBe(2);
      expect(read(join(box.codeDir, 'server.mjs'))).toBe('// from the interrupted swap');
      expect(residue(box.codeDir).sort()).toEqual([FINISHED, JOURNALED, STAGING].sort());
    });
  });

  describe(`doctor over update residue in the code dir (D#289 D, ${shape})`, () => {
    it('names an unfinished swap apart from stale temp, and counts only the stale residue', () => {
      const box = sandbox({ relocate });
      seedUnfinishedSwap(box.codeDir);
      seedFinishedResidue(box.codeDir);
      const checks = doctorChecks(run(box, ['doctor', '--json']));

      const unfinished = checks.find((c) => /^Unfinished update/.test(c.message || ''));
      expect(unfinished, JSON.stringify(checks.map((c) => c.message))).toBeDefined();
      expect(unfinished.level).toBe('warn');
      expect(unfinished.message).toContain('cleanup');
      const stale = checks.find((c) => /^Stale temp files/.test(c.message || ''));
      expect(stale.message).toMatch(/Stale temp files: 2 found/);
    });
  });
}

// D#292 (C): a backup dir whose swap is over but whose journal could not be removed is marked
// `.swap-resolved`. It is leftover, not an unfinished update: replaying it would undo the release
// that finished.
describe('a resolved swap whose journal stayed (D#292 C)', () => {
  function seedResolved(codeDir) {
    writeFileSync(join(codeDir, 'server.mjs'), '// the release that finished');
    const backup = join(codeDir, JOURNALED);
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, 'server.mjs'), '// the release before it');
    writeFileSync(
      join(backup, '.swap-journal.json'),
      JSON.stringify({ backedUp: ['server.mjs'], installed: ['server.mjs'] }),
    );
    writeFileSync(join(backup, '.swap-resolved'), '');
  }

  it('cleanup removes it without replaying it', () => {
    const box = sandbox();
    seedResolved(box.codeDir);
    const out = run(box, ['cleanup']);
    expect(read(join(box.codeDir, 'server.mjs')), out).toBe('// the release that finished');
    expect(residue(box.codeDir)).toEqual([]);
    expect(out).toContain(`Removed: ${JOURNALED}`);
  });

  it('doctor counts it as stale temp, not as an unfinished update', () => {
    const box = sandbox();
    seedResolved(box.codeDir);
    const checks = doctorChecks(run(box, ['doctor', '--json']));
    expect(checks.find((c) => /^Unfinished update/.test(c.message || ''))).toBeUndefined();
    expect(checks.find((c) => /^Stale temp files/.test(c.message || '')).message).toMatch(
      /Stale temp files: 1 found/,
    );
  });

  it('install does not replay it over the tree it writes', () => {
    const box = sandbox();
    seedResolved(box.codeDir);
    const out = run(box, ['install', '--dev', '--skip-repos'], {
      PATH: `${fakeClaudeBin(box.home)}:${process.env.PATH}`,
    });
    expect(lstatSync(join(box.codeDir, 'server.mjs')).isSymbolicLink(), out).toBe(true); // premise: deployed
    // The deploy overwrites what a replay would restore, so what tells the two apart is the replay itself.
    expect(out).not.toMatch(/interrupted update/i);
  });
});

// Before v2.90.0 the updater swapped into the data dir itself, which CLAUDE_MEM_DIR could relocate,
// so a relocated data dir can still hold residue from then. 6.25.0's doctor and cleanup scanned it;
// whatever such a backup holds, its journal names a tree no current code lives in, so it is stale and
// is never replayed.
describe('residue an updater older than v2.90.0 left in a relocated data dir', () => {
  function seedLegacy(dataDir) {
    mkdirSync(join(dataDir, STAGING), { recursive: true });
    const backup = join(dataDir, JOURNALED);
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, 'server.mjs'), '// an old release');
    writeFileSync(
      join(backup, '.swap-journal.json'),
      JSON.stringify({ backedUp: ['server.mjs'], installed: [] }),
    );
  }

  it('doctor counts it as stale temp', () => {
    const box = sandbox({ relocate: true });
    seedLegacy(box.dataDir);
    const checks = doctorChecks(run(box, ['doctor', '--json']));
    expect(checks.find((c) => /^Unfinished update/.test(c.message || ''))).toBeUndefined();
    expect(checks.find((c) => /^Stale temp files/.test(c.message || '')).message).toMatch(
      /Stale temp files: 2 found/,
    );
  });

  it('cleanup removes it and replays nothing into the data dir', () => {
    const box = sandbox({ relocate: true });
    seedLegacy(box.dataDir);
    expect((run(box, ['cleanup', '--dry-run']).match(/Would remove:/g) || []).length).toBe(2);
    const out = run(box, ['cleanup']);
    expect(residue(box.dataDir), out).toEqual([]);
    expect(existsSync(join(box.dataDir, 'server.mjs'))).toBe(false);
    expect(out).not.toMatch(/interrupted update/i);
  });
});
