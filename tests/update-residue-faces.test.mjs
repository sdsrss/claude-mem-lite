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
import { execFileSync, spawnSync } from 'node:child_process';
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
  copyFileSync,
  cpSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SOURCE_FILES } from '../source-files.mjs';

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
// so a relocated data dir can still hold residue from then. 6.25.0's doctor and cleanup scanned it.
// It is stale and never replayed. A real one holds no journal (journals came in v3.57.0); the fixture
// gives it one, to show that even a journal there is not replayed.
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

// v6.25.1 pre-tag defect review.
/** A copy of this checkout whose hook-update.mjs throws on import (node_modules linked back). */
function checkoutWithBrokenHookUpdate(box) {
  const checkout = join(box.home, 'checkout');
  for (const rel of [...SOURCE_FILES, 'package.json']) {
    if (!existsSync(join(REPO, rel))) continue;
    mkdirSync(dirname(join(checkout, rel)), { recursive: true });
    copyFileSync(join(REPO, rel), join(checkout, rel));
  }
  cpSync(join(REPO, 'scripts'), join(checkout, 'scripts'), { recursive: true });
  symlinkSync(join(REPO, 'node_modules'), join(checkout, 'node_modules'));
  writeFileSync(
    join(checkout, 'hook-update.mjs'),
    "throw new Error('simulated: hook-update cannot load');\n",
  );
  return checkout;
}

describe('update residue the replay cannot handle (v6.25.1 review)', () => {
  const skipRoot = process.getuid?.() === 0; // root ignores the mode bits a case relies on

  /** A backup dir whose journal an in-place write of 6.25.0 or older tore: it parses to nothing. */
  function seedUnreadableJournal(codeDir) {
    writeFileSync(join(codeDir, 'server.mjs'), '// from the interrupted swap');
    const backup = join(codeDir, JOURNALED);
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, 'server.mjs'), '// before the interrupted swap');
    writeFileSync(join(backup, '.swap-journal.json'), '');
  }

  // P2-2: recovery read such a journal as "nothing moved" and deleted the only copy of the files it
  // had moved, and cleanup reported that as "Finished an interrupted update".
  it('cleanup leaves it in place and says why; doctor names it', () => {
    const box = sandbox();
    seedUnreadableJournal(box.codeDir);
    const out = run(box, ['cleanup']);
    expect(read(join(box.codeDir, JOURNALED, 'server.mjs')), out).toBe('// before the interrupted swap');
    expect(out).not.toMatch(/Finished an interrupted update/);
    expect(out).toContain(`Left in place: ${JOURNALED}`);
    const checks = doctorChecks(run(box, ['doctor', '--json']));
    const line = checks.find((c) => /^Unfinished update/.test(c.message || ''));
    expect(line?.message, JSON.stringify(checks.map((c) => c.message))).toMatch(/journal cannot be read/);
  });

  // P2-3: with hook-update unable to load, install could not replay the swap, wrote the tree anyway,
  // and the next update entry replayed the old journal over it.
  it('an install that cannot replay a swap retires its journal after writing the tree', () => {
    const box = sandbox();
    seedUnfinishedSwap(box.codeDir, { relPath: 'hook.mjs', added: 'cli.mjs' });
    const checkout = checkoutWithBrokenHookUpdate(box);
    const out = execFileSync(
      process.execPath,
      [join(checkout, 'install.mjs'), 'install', '--dev', '--skip-repos'],
      {
        env: env(box, { PATH: `${fakeClaudeBin(box.home)}:${process.env.PATH}` }),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
      },
    );
    expect(lstatSync(join(box.codeDir, 'cli.mjs')).isSymbolicLink(), out).toBe(true); // premise: deployed
    expect(out).not.toMatch(/Could not remove/); // it is retired below, not a removal that failed

    nextUpdateEntry(box); // the real hook-update, as the next update would run it
    expect(lstatSync(join(box.codeDir, 'hook.mjs')).isSymbolicLink(), 'the old hook.mjs came back').toBe(
      true,
    );
    expect(existsSync(join(box.codeDir, 'cli.mjs')), 'the installed cli.mjs was deleted').toBe(true);
  });

  // P3-1: the scan read a runtime dir inside an unreadable data dir as absent and printed ✓ none.
  it.skipIf(skipRoot)('doctor does not call a data dir it cannot read free of stale files', () => {
    const box = sandbox({ relocate: true });
    chmodSync(box.dataDir, 0o000);
    try {
      const checks = doctorChecks(run(box, ['doctor', '--json']));
      const line = checks.find((c) => /^Stale temp files/.test(c.message || ''));
      expect(line?.level, line?.message).not.toBe('ok');
      expect(line.message).toMatch(/not checked — .* is not accessible \(EACCES\)/);
    } finally {
      chmodSync(box.dataDir, 0o755);
    }
  });

  // P3-10: the remedy named `node install.mjs cleanup`, which resolves against the shell's cwd.
  it('the unfinished-update remedy names the installer by its absolute path', () => {
    const box = sandbox();
    seedUnfinishedSwap(box.codeDir);
    const line = doctorChecks(run(box, ['doctor', '--json'])).find((c) =>
      /^Unfinished update/.test(c.message || ''),
    );
    expect(line.message).toContain(INSTALLER);
  });
});

// v6.25.1 round-2 delta review.
describe('update residue, second pass (v6.25.1 delta review)', () => {
  const skipRoot = process.getuid?.() === 0;

  // P3-2: one directory the scan could not read aborted the whole scan, so a readable code dir's
  // unfinished swap went unreported beside "not checked".
  it.skipIf(skipRoot)('an unreadable data dir does not hide an unfinished swap in the code dir', () => {
    const box = sandbox({ relocate: true });
    seedUnfinishedSwap(box.codeDir);
    chmodSync(box.dataDir, 0o000);
    try {
      const checks = doctorChecks(run(box, ['doctor', '--json']));
      expect(checks.find((c) => /^Unfinished update/.test(c.message || ''))).toBeDefined();
      expect(checks.find((c) => /^Stale temp files/.test(c.message || '')).message).toMatch(/not checked/);
    } finally {
      chmodSync(box.dataDir, 0o755);
    }
  });

  // P3-3 and the review's I8: with hook-update unable to load, cleanup must keep an unfinished swap
  // whole (it holds the only copy of what moved), and say so once.
  it('cleanup that cannot load hook-update keeps an unfinished swap whole and says why once', () => {
    const box = sandbox();
    seedUnfinishedSwap(box.codeDir);
    seedFinishedResidue(box.codeDir);
    const checkout = checkoutWithBrokenHookUpdate(box);
    const out = execFileSync(process.execPath, [join(checkout, 'install.mjs'), 'cleanup'], {
      env: env(box),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    expect(read(join(box.codeDir, JOURNALED, 'server.mjs')), out).toBe('// before the interrupted swap');
    expect(existsSync(join(box.codeDir, JOURNALED, '.swap-journal.json'))).toBe(true);
    expect(residue(box.codeDir)).toEqual([JOURNALED]); // the finished residue still goes
    expect(out).not.toMatch(/Failed to remove/);
  });

  // The review's gap: install retires a dir whose journal cannot be read, which is what doctor's
  // "repair reinstalls over them; cleanup then removes them" depends on.
  it('install retires a dir whose journal cannot be read, and cleanup then removes it', () => {
    const box = sandbox();
    writeFileSync(join(box.codeDir, 'server.mjs'), '// from the interrupted swap');
    mkdirSync(join(box.codeDir, JOURNALED), { recursive: true });
    writeFileSync(join(box.codeDir, JOURNALED, 'server.mjs'), '// before the interrupted swap');
    writeFileSync(join(box.codeDir, JOURNALED, '.swap-journal.json'), '');
    const out = run(box, ['install', '--dev', '--skip-repos'], {
      PATH: `${fakeClaudeBin(box.home)}:${process.env.PATH}`,
    });
    expect(existsSync(join(box.codeDir, JOURNALED, '.swap-resolved')), out).toBe(true);
    expect(out).toContain(`Retired ${JOURNALED}`);
    run(box, ['cleanup']);
    expect(residue(box.codeDir)).toEqual([]);
  });

  // P3-7: a `.update-backup-*` that is not a real directory (a file, a symlink) is skipped by
  // recovery, so the classifier must not call it an unfinished swap; cleanup removes it as leftover.
  it('a file or a symlink named like a backup dir is stale, and cleanup removes only the name', () => {
    const box = sandbox();
    writeFileSync(join(box.codeDir, '.update-backup-9'), 'not a dir');
    const target = join(box.home, 'elsewhere');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, '.swap-journal.json'), JSON.stringify({ backedUp: [], installed: [] }));
    symlinkSync(target, join(box.codeDir, '.update-backup-8'));
    const checks = doctorChecks(run(box, ['doctor', '--json']));
    expect(checks.find((c) => /^Unfinished update/.test(c.message || ''))).toBeUndefined();
    expect(checks.find((c) => /^Stale temp files/.test(c.message || '')).message).toMatch(
      /Stale temp files: 2 found/,
    );
    const out = run(box, ['cleanup']);
    expect(residue(box.codeDir), out).toEqual([]);
    expect(existsSync(join(target, '.swap-journal.json'))).toBe(true); // the link went, not its target
  });
});

// D#293: a replay that cannot put every file back leaves its backup dir, the only copy of what it
// could not restore. The new node_modules holds a dir the replay cannot empty, so removing it
// stops partway and the old one cannot be renamed back (ENOTEMPTY), on Linux with no fault mock.
describe('a swap whose replay cannot put a file back (D#293)', () => {
  const skipRoot = process.getuid?.() === 0;

  function seedStuckSwap(codeDir) {
    mkdirSync(join(codeDir, 'node_modules', 'stuck'), { recursive: true });
    writeFileSync(join(codeDir, 'node_modules', 'dep.js'), 'new-dep');
    writeFileSync(join(codeDir, 'node_modules', 'stuck', 'held.js'), 'held');
    chmodSync(join(codeDir, 'node_modules', 'stuck'), 0o555);
    mkdirSync(join(codeDir, JOURNALED, 'node_modules'), { recursive: true });
    writeFileSync(join(codeDir, JOURNALED, 'node_modules', 'dep.js'), 'old-dep');
    writeFileSync(
      join(codeDir, JOURNALED, '.swap-journal.json'),
      JSON.stringify({ seq: 1, backedUp: ['node_modules'], installed: ['node_modules'] }),
    );
  }

  it.skipIf(skipRoot)('cleanup keeps it, says it could not finish, and finishes it once it can', () => {
    const box = sandbox();
    seedStuckSwap(box.codeDir);
    const stuck = join(box.codeDir, 'node_modules', 'stuck');
    try {
      const out = run(box, ['cleanup']);
      expect(read(join(box.codeDir, JOURNALED, 'node_modules', 'dep.js')), out).toBe('old-dep');
      expect(existsSync(join(box.codeDir, JOURNALED, '.swap-journal.json'))).toBe(true);
      expect(out).toMatch(new RegExp(`Could not finish the interrupted update ${JOURNALED}`));
      expect(out).not.toMatch(/Finished an interrupted update|Failed to remove/);
    } finally {
      chmodSync(stuck, 0o755);
    }
    const out = run(box, ['cleanup']);
    expect(read(join(box.codeDir, 'node_modules', 'dep.js')), out).toBe('old-dep');
    expect(residue(box.codeDir)).toEqual([]);
    expect(out).toMatch(new RegExp(`Finished an interrupted update: ${JOURNALED}`));
  });

  // install writes the whole tree, so it goes ahead and retires the dir afterwards. The journal
  // names a dir install itself does not write, so the write is not the thing that fails.
  it.skipIf(skipRoot)('install says it could not finish it, writes the tree and retires it', () => {
    const box = sandbox();
    mkdirSync(join(box.codeDir, 'extra', 'stuck'), { recursive: true });
    writeFileSync(join(box.codeDir, 'extra', 'stuck', 'held.js'), 'held');
    chmodSync(join(box.codeDir, 'extra', 'stuck'), 0o555);
    mkdirSync(join(box.codeDir, JOURNALED, 'extra'), { recursive: true });
    writeFileSync(join(box.codeDir, JOURNALED, 'extra', 'kept.js'), 'old');
    writeFileSync(
      join(box.codeDir, JOURNALED, '.swap-journal.json'),
      JSON.stringify({ seq: 1, backedUp: ['extra'], installed: ['extra'] }),
    );
    let out;
    try {
      out = run(box, ['install', '--dev', '--skip-repos'], {
        PATH: `${fakeClaudeBin(box.home)}:${process.env.PATH}`,
      });
    } finally {
      chmodSync(join(box.codeDir, 'extra', 'stuck'), 0o755);
    }
    expect(out).toMatch(new RegExp(`Could not finish the interrupted update ${JOURNALED}`));
    expect(out).not.toMatch(/Could not remove/);
    expect(lstatSync(join(box.codeDir, 'cli.mjs')).isSymbolicLink(), out).toBe(true); // premise: deployed
    expect(existsSync(join(box.codeDir, JOURNALED, '.swap-resolved'))).toBe(true);
  });
});

// D#297 (v6.25.1 defect review P3-8, P3-9): doctor counted a running update's own staging dir as
// stale temp while cleanup skipped it, and `cleanup --dry-run` took install.lock, creating the
// data dir, its runtime dir and the lock on a machine with nothing installed.
describe('a running update and a dry run (D#297)', () => {
  for (const relocate of [false, true])
    it(`doctor does not count a running update’s residue as stale; cleanup skips it too (${relocate ? 'relocated' : 'default shape'})`, () => {
      const box = sandbox({ relocate });
      mkdirSync(join(box.codeDir, STAGING), { recursive: true });
      // Under relocation, residue an updater older than v2.90.0 left in the data dir: cleanup skips
      // that too while the lock is held.
      if (relocate) mkdirSync(join(box.dataDir, FINISHED), { recursive: true });
      const lock = join(box.dataDir, 'runtime', 'install.lock');
      writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() })); // a live holder
      const checks = doctorChecks(run(box, ['doctor', '--json']));
      const line = checks.find((c) => /^Stale temp files/.test(c.message || ''));
      expect(line?.message).not.toMatch(/found/);
      // Not a ✓: the residue was not looked at, and the holder may be any installer, not an update.
      expect(line?.level, line?.message).not.toBe('ok');
      expect(line?.message).toMatch(
        /update residue not checked — install\.lock is held \(by a running install, update, repair or binding rebuild, or as a lock file this user cannot read\)/,
      );
      expect(run(box, ['cleanup'])).toMatch(/Update residue skipped: install in progress/);
      expect(existsSync(join(box.codeDir, STAGING))).toBe(true);
    });

  // Review P3-1: a lock this user cannot read stops acquireLock (cleanup skipped the residue), but
  // lockHeld read it as stale, so doctor and the dry run counted what cleanup would not touch.
  it.skipIf(process.getuid?.() === 0)(
    'a lock that cannot be read is held for doctor and the dry run too',
    () => {
      const box = sandbox();
      mkdirSync(join(box.codeDir, STAGING), { recursive: true });
      const lock = join(box.dataDir, 'runtime', 'install.lock');
      writeFileSync(lock, JSON.stringify({ pid: 0x7ffffffe, ts: 1 }));
      chmodSync(lock, 0o000);
      try {
        expect(run(box, ['cleanup', '--dry-run'])).toMatch(/Update residue skipped: install in progress/);
        const line = doctorChecks(run(box, ['doctor', '--json'])).find((c) =>
          /^Stale temp files/.test(c.message || ''),
        );
        expect(line?.message).not.toMatch(/found/);
        expect(run(box, ['cleanup'])).toMatch(/Update residue skipped: install in progress/); // premise
      } finally {
        chmodSync(lock, 0o644);
      }
    },
  );

  it('doctor still counts that staging dir once no update holds the lock', () => {
    const box = sandbox();
    mkdirSync(join(box.codeDir, STAGING), { recursive: true });
    const line = doctorChecks(run(box, ['doctor', '--json'])).find((c) =>
      /^Stale temp files/.test(c.message || ''),
    );
    expect(line?.message).toMatch(/Stale temp files: 1 found/);
  });

  it('cleanup --dry-run writes nothing on a machine with nothing installed', () => {
    const home = mkdtempSync(join(tmpdir(), 'upd-residue-'));
    homes.push(home);
    const box = { home, codeDir: join(home, '.claude-mem-lite'), dataDir: join(home, '.claude-mem-lite') };
    const out = run(box, ['cleanup', '--dry-run']);
    expect(readdirSync(home), out).toEqual([]);
  });

  it('cleanup --dry-run still names update residue, and skips it while an update holds the lock', () => {
    const box = sandbox();
    mkdirSync(join(box.codeDir, STAGING), { recursive: true });
    expect(run(box, ['cleanup', '--dry-run'])).toContain(`Would remove: ${STAGING}`);
    const lock = join(box.dataDir, 'runtime', 'install.lock');
    const holder = JSON.stringify({ pid: process.pid, ts: Date.now() });
    writeFileSync(lock, holder);
    const out = run(box, ['cleanup', '--dry-run']);
    expect(out).toMatch(/Update residue skipped: install in progress/);
    expect(out).not.toContain(`Would remove: ${STAGING}`);
    expect(readFileSync(lock, 'utf8')).toBe(holder);
  });
});

// D#304, D#307. A runtime dir install.lock cannot be created in: a `sudo` run left it root-owned
// (0555 to this user), or it cannot even be listed (0000). acquireLock answers null for that as for a
// live holder, and every face read null as "an install is in progress": the real cleanup named a
// lock that did not exist while its dry run promised to remove the residue, both then died on an
// uncaught EACCES listing the runtime dir (0000), install exited 0 having done nothing, and doctor
// sent the user to a cleanup that would not touch the residue. Every update entry skipped the same
// way, silently, so nothing ever said why updates stopped.
function runFull(box, args, extra = {}) {
  const r = spawnSync(process.execPath, [INSTALLER, ...args], {
    env: env(box, extra),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('a runtime dir install.lock cannot be taken in (D#304, D#307)', () => {
  for (const mode of [0o555, 0o000])
    it.skipIf(process.getuid?.() === 0)(
      `every face names it, and none claims a lock is held (runtime ${mode.toString(8).padStart(3, '0')})`,
      () => {
        const box = sandbox();
        mkdirSync(join(box.codeDir, STAGING), { recursive: true });
        const runtime = join(box.dataDir, 'runtime');
        chmodSync(runtime, mode);
        try {
          const blocked = new RegExp(
            `install\\.lock cannot be taken — ${runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} cannot be written \\(EACCES\\)`,
          );
          for (const args of [['cleanup', '--dry-run'], ['cleanup']]) {
            const r = runFull(box, args);
            expect(r.out, args.join(' ')).not.toMatch(/install in progress|install\.lock held/);
            expect(r.out, args.join(' ')).toMatch(new RegExp(`Update residue skipped: ${blocked.source}`));
            expect(r.out, args.join(' ')).not.toContain(`Would remove: ${STAGING}`);
            expect(r.out, args.join(' ')).not.toMatch(/Error: EACCES/); // no uncaught crash
            // Review P3-4: residue it knows is there and could not touch is not "nothing found".
            expect(r.out, args.join(' ')).not.toMatch(/No stale files found/);
            expect(r.status, `${args.join(' ')}\n${r.out}`).toBe(1);
          }
          expect(existsSync(join(box.codeDir, STAGING))).toBe(true);

          const inst = runFull(box, ['install']);
          expect(inst.out).not.toMatch(/in progress/);
          expect(inst.out).toMatch(blocked);
          expect(inst.status).toBe(1);

          const rb = runFull(box, ['rebuild-binding']);
          expect(rb.out).not.toMatch(/in progress/);
          expect(rb.out).toMatch(blocked);
          expect(rb.status).toBe(1);

          const checks = doctorChecks(run(box, ['doctor', '--json']));
          const lockLine = checks.find((c) => /^Install lock/.test(c.message || ''));
          expect(lockLine?.level, JSON.stringify(checks.map((c) => c.message))).toBe('fail');
          expect(lockLine?.message).toMatch(blocked);
          // The residue is real (no installer of this user can be running), so it is counted; the
          // cleanup it names waits on the lock line's fix instead of being offered as the repair.
          const stale = checks.find((c) => /^Stale temp files/.test(c.message || ''));
          expect(stale?.message).toMatch(
            /1 found (elsewhere )?\(run: .*cleanup once install\.lock can be taken \(see Install lock\)\)/,
          );
        } finally {
          chmodSync(runtime, 0o755);
        }
      },
    );

  it('a runtime dir that can be written is not named', () => {
    const box = sandbox();
    const checks = doctorChecks(run(box, ['doctor', '--json']));
    expect(checks.find((c) => /^Install lock/.test(c.message || ''))).toBeUndefined();
  });
});

// D#307 F3. Recovery undoes unresolved backup dirs like a stack, newest first, and stops at one
// whose journal cannot be read: everything older stays. The dry run decided per dir and promised to
// finish an older one the real run leaves.
describe('cleanup --dry-run walks the swap stack the way recovery does (D#307 F3)', () => {
  it('does not promise to finish a swap that a newer unreadable one blocks', () => {
    const box = sandbox();
    const older = '.update-backup-s1-1700000000000-4242';
    const newer = '.update-backup-s2-1700000000001-4243';
    writeFileSync(join(box.codeDir, 'server.mjs'), '// from the older interrupted swap');
    mkdirSync(join(box.codeDir, older), { recursive: true });
    writeFileSync(join(box.codeDir, older, 'server.mjs'), '// before the older swap');
    writeFileSync(
      join(box.codeDir, older, '.swap-journal.json'),
      JSON.stringify({ backedUp: ['server.mjs'], installed: ['server.mjs'] }),
    );
    mkdirSync(join(box.codeDir, newer), { recursive: true });
    writeFileSync(join(box.codeDir, newer, '.swap-journal.json'), '{torn');
    const dry = run(box, ['cleanup', '--dry-run']);
    expect(dry).toContain(`Would leave in place: ${newer} (its journal cannot be read)`);
    expect(dry).not.toContain(`Would finish an interrupted update: ${older}`);
    expect(dry).toMatch(new RegExp(`Would leave in place: ${older.replace(/\./g, '\\.')} \\(a newer one`));
    const real = run(box, ['cleanup']);
    expect(real).toContain(`Could not finish the interrupted update ${older}`); // premise: the real run leaves it
    expect(readFileSync(join(box.codeDir, 'server.mjs'), 'utf8')).toBe('// from the older interrupted swap');
  });

  it('still promises to finish a readable swap with nothing newer blocking it', () => {
    const box = sandbox();
    seedUnfinishedSwap(box.codeDir);
    expect(run(box, ['cleanup', '--dry-run'])).toContain(`Would finish an interrupted update: ${JOURNALED}`);
  });
});

// Pre-ship review of the above (defect lens P2-1, P3-2..P3-6, P3-10; claims lens 7 and 10).
describe('install.lock that cannot be taken: the review repairs', () => {
  const skipRoot = process.getuid?.() === 0;
  const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // No network in either arm: an update check or a repair download fails at once through a dead proxy.
  const offline = { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' };

  // P2-1: a create that fails for a reason access() does not predict. A runtime dir that is a link to
  // nowhere (a tmpfs target gone after a reboot) read as "held" on every face.
  it('a runtime link to nowhere is named on every face, not read as a held lock', () => {
    const box = sandbox();
    mkdirSync(join(box.codeDir, STAGING), { recursive: true });
    const runtime = join(box.dataDir, 'runtime');
    rmSync(runtime, { recursive: true, force: true });
    symlinkSync(join(box.home, 'gone', 'runtime'), runtime);
    const named = new RegExp(`install\\.lock cannot be taken — ${esc(runtime)} .*\\(ENOENT\\)`);
    for (const args of [['cleanup', '--dry-run'], ['cleanup']]) {
      const r = runFull(box, args);
      expect(r.out, args.join(' ')).toMatch(named);
      expect(r.out, args.join(' ')).not.toMatch(/install in progress|Would remove: \.update-staging/);
    }
    const inst = runFull(box, ['install']);
    expect(inst.out).toMatch(named);
    expect(inst.status).toBe(1);
    const lockLine = doctorChecks(run(box, ['doctor', '--json'])).find((c) =>
      /^Install lock/.test(c.message || ''),
    );
    expect(lockLine?.level).toBe('fail');
  });

  // Claims 7: a lock that is held AND sits in a dir this user cannot write (a sudo-run installer still
  // running in the root-owned runtime dir it made). The running update's residue is not stale.
  it.skipIf(skipRoot)(
    'a held lock in a dir that cannot be written: residue is not counted, the lock line still shows',
    () => {
      const box = sandbox();
      mkdirSync(join(box.codeDir, STAGING), { recursive: true });
      const runtime = join(box.dataDir, 'runtime');
      writeFileSync(join(runtime, 'install.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
      chmodSync(runtime, 0o555);
      try {
        const checks = doctorChecks(run(box, ['doctor', '--json']));
        expect(checks.find((c) => /^Install lock/.test(c.message || ''))?.level).toBe('fail');
        const stale = checks.find((c) => /^Stale temp files/.test(c.message || ''));
        expect(stale?.message).not.toMatch(/found/);
        expect(stale?.message).toMatch(/update residue not checked — install\.lock is held/);
      } finally {
        chmodSync(runtime, 0o755);
      }
    },
  );

  // Claims 10 / P3-9: the lock line is a ⚠ only when the Data directory line counts the SAME dir.
  it.skipIf(skipRoot)(
    'the lock line is counted when the data dir and its runtime dir both need fixing',
    () => {
      const box = sandbox();
      const runtime = join(box.dataDir, 'runtime');
      chmodSync(runtime, 0o555);
      chmodSync(box.dataDir, 0o555);
      try {
        const checks = doctorChecks(run(box, ['doctor', '--json']));
        expect(checks.find((c) => /^Data directory/.test(c.message || ''))?.level).toBe('fail'); // premise
        const lockLine = checks.find((c) => /^Install lock/.test(c.message || ''));
        expect(lockLine?.message).toContain(runtime);
        expect(lockLine?.level).toBe('fail');
      } finally {
        chmodSync(box.dataDir, 0o755);
        chmodSync(runtime, 0o755);
      }
    },
  );

  it.skipIf(skipRoot)(
    'the lock line is a ⚠ when it names the dir the Data directory line already counts',
    () => {
      const box = sandbox();
      rmSync(join(box.dataDir, 'runtime'), { recursive: true, force: true });
      chmodSync(box.dataDir, 0o555);
      try {
        const checks = doctorChecks(run(box, ['doctor', '--json']));
        expect(checks.find((c) => /^Data directory/.test(c.message || ''))?.level).toBe('fail'); // premise
        const lockLine = checks.find((c) => /^Install lock/.test(c.message || ''));
        expect(lockLine?.message).toMatch(new RegExp(`— ${esc(box.dataDir)} cannot be written`));
        expect(lockLine?.level).toBe('warn');
      } finally {
        chmodSync(box.dataDir, 0o755);
      }
    },
  );

  // P3-2: a data dir that cannot be entered made the runtime dir under it the one named, and the
  // chmod offered for it fails.
  it.skipIf(skipRoot)('names the data dir that cannot be entered, not the runtime dir under it', () => {
    const box = sandbox({ relocate: true });
    chmodSync(box.dataDir, 0o000);
    try {
      const out = runFull(box, ['cleanup']).out;
      expect(out).toMatch(
        new RegExp(`install\\.lock cannot be taken — ${esc(box.dataDir)} cannot be written`),
      );
      expect(out).not.toMatch(/chmod u\+rwx [^ ]*runtime/);
    } finally {
      chmodSync(box.dataDir, 0o755);
    }
  });

  // P3-3: a data dir that does not exist yet under one this user cannot write. The fix is to make the
  // data dir, or point CLAUDE_MEM_DIR elsewhere; never to chmod or chown a parent such as /opt.
  it.skipIf(skipRoot)('a data dir that cannot be created is not fixed by chmod/chown on its parent', () => {
    const box = sandbox();
    const ro = join(box.home, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o555);
    const mem = join(ro, 'sub', 'mem');
    try {
      const inst = runFull(box, ['install'], { CLAUDE_MEM_DIR: mem });
      expect(inst.status).toBe(1);
      expect(inst.out).toMatch(/install\.lock cannot be taken/);
      expect(inst.out).not.toMatch(new RegExp(`(chmod|chown)[^\n]*${esc(ro)}(?!/)`));
      expect(inst.out).toContain(mem);
      expect(inst.out).toMatch(/CLAUDE_MEM_DIR/);
    } finally {
      chmodSync(ro, 0o755);
    }
  });

  // P3-5: repair downloaded a whole release before its install found the lock, then recommended a
  // manual fallback that fails the same way; self-update said only "install failed".
  for (const cmd of ['repair', 'self-update'])
    it.skipIf(skipRoot)(`${cmd} names the dir before it goes to the network`, () => {
      const box = sandbox();
      const runtime = join(box.dataDir, 'runtime');
      chmodSync(runtime, 0o555);
      try {
        const r = runFull(box, [cmd], { ...offline, CLAUDE_MEM_SKIP_UPDATE: '' });
        expect(r.out).toMatch(
          new RegExp(`install\\.lock cannot be taken — ${esc(runtime)} cannot be written \\(EACCES\\)`),
        );
        expect(r.out).not.toMatch(/Downloading|Checking for updates|Manual fallback/);
        expect(r.status).toBe(1);
      } finally {
        chmodSync(runtime, 0o755);
      }
    });

  // P3-6: the legacy data-dir residue sweep, one block above the runtime listing D#304 fixed.
  it.skipIf(skipRoot)('cleanup survives a relocated data dir it can enter but not list', () => {
    const box = sandbox({ relocate: true });
    chmodSync(box.dataDir, 0o300);
    try {
      const r = runFull(box, ['cleanup']);
      expect(r.out).not.toMatch(/Error: EACCES/);
      expect(r.out).toMatch(new RegExp(`could not list ${esc(box.dataDir)} \\(EACCES\\)`));
    } finally {
      chmodSync(box.dataDir, 0o755);
    }
  });
});

// Review P3-9: the e2e case above reads the stack order through readdir in a child, so a file system
// that lists the dirs newest first lets an unsorted walk pass. The walk itself, both input orders.
describe('swapsBlockedByUnreadable: the order recovery walks, whatever order the dirs are listed in', () => {
  const s1 = '.update-backup-s1-1700000000000-1';
  const s2 = '.update-backup-s2-1700000000001-2';
  const legacyOld = '.update-backup-1600000000000-1';
  const legacyNew = '.update-backup-1600000000001-2';
  for (const reversed of [false, true]) {
    const ord = (xs) => (reversed ? [...xs].reverse() : xs);
    it(`an unreadable newer dir blocks the older ones (${reversed ? 'listed newest first' : 'listed oldest first'})`, async () => {
      const { swapsBlockedByUnreadable } = await import(pathToFileURL(HOOK_UPDATE).href);
      expect(
        swapsBlockedByUnreadable(
          ord([
            { name: legacyOld, readable: true },
            { name: s1, readable: true },
            { name: s2, readable: false },
          ]),
        ),
      ).toEqual(
        new Map([
          [s1, s2],
          [legacyOld, s2],
        ]),
      );
      // An unreadable OLDER dir blocks nothing newer; seq-less names order by their clock.
      expect(
        swapsBlockedByUnreadable(
          ord([
            { name: legacyOld, readable: false },
            { name: legacyNew, readable: true },
          ]),
        ),
      ).toEqual(new Map());
    });
  }
});
