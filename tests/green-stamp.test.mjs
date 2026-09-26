// The pre-commit gate may skip `npm test` for a tree whose full suite just passed. Every
// case here drives one of the conditions that must make it RUN the suite instead, because
// a wrong "reuse" is the only failure this feature can add. Contract: scripts/green-stamp.mjs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  copyFileSync,
  chmodSync,
  symlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
import { disposeFixtureDir } from './test-helpers.mjs';
import {
  computeTreeKey,
  checkStamp,
  recordStamp,
  stampPath,
  loadsStampReporter,
  STAMP_MAX_AGE_MS,
} from '../scripts/green-stamp.mjs';
import vitestConfig from '../vitest.config.mjs';
import { refusalReason } from '../scripts/green-stamp-reporter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env0 = {}; // no PRE_COMMIT_FULL_TEST

let repo;
const git = (...args) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'pipe' });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'green-stamp-'));
  git('init', '-q');
  writeFileSync(join(repo, '.gitignore'), 'ignored/\n');
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
});
afterEach(() => {
  disposeFixtureDir(repo);
});

describe('computeTreeKey', () => {
  it('is stable for an unchanged tree and ignores ignored files', () => {
    const k = computeTreeKey(repo);
    mkdirSync(join(repo, 'ignored'));
    writeFileSync(join(repo, 'ignored', 'x.test.mjs'), 'x');
    expect(computeTreeKey(repo)).toBe(k);
  });

  it('changes on a tracked edit, a new untracked file, a deletion and a node version', () => {
    const k = computeTreeKey(repo);
    writeFileSync(join(repo, 'a.mjs'), 'export const a = 2;\n');
    const edited = computeTreeKey(repo);
    expect(edited).not.toBe(k);
    git('checkout', '--', 'a.mjs');
    expect(computeTreeKey(repo)).toBe(k);
    writeFileSync(join(repo, 'scratch.mjs'), '');
    expect(computeTreeKey(repo)).not.toBe(k);
    execFileSync('rm', ['-f', join(repo, 'scratch.mjs'), join(repo, 'a.mjs')]);
    expect(computeTreeKey(repo)).not.toBe(k);
    git('checkout', '--', 'a.mjs');
    expect(computeTreeKey(repo, { nodeVersion: 'v0.0.0' })).not.toBe(k);
  });
});

describe('computeTreeKey — entries that are not regular files (v6.13.0 defect review P3-2)', () => {
  it('changes when a symlink is added or retargeted', () => {
    writeFileSync(join(repo, 'b.mjs'), 'export const b = 1;\n');
    const k = computeTreeKey(repo);
    symlinkSync('a.mjs', join(repo, 'link.mjs'));
    const linked = computeTreeKey(repo);
    expect(linked).not.toBe(k); // untracked, not ignored: vitest would see it
    git('add', 'link.mjs');
    execFileSync('ln', ['-sfn', 'b.mjs', join(repo, 'link.mjs')]);
    git('add', 'link.mjs');
    expect(computeTreeKey(repo)).not.toBe(linked);
  });

  it('changes when a gitlink is re-pointed in the index', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    git('update-index', '--add', '--cacheinfo', `160000,${head},sub`);
    const k = computeTreeKey(repo);
    git('update-index', '--cacheinfo', `160000,${'1'.repeat(40)},sub`);
    expect(computeTreeKey(repo)).not.toBe(k);
  });
});

describe('checkStamp', () => {
  it('reuses a stamp recorded on this exact tree', () => {
    expect(checkStamp(repo, { env: env0 })).toMatchObject({ reuse: false, reason: 'no green stamp' });
    recordStamp(repo, computeTreeKey(repo));
    expect(existsSync(stampPath(repo))).toBe(true);
    expect(stampPath(repo).startsWith(join(repo, '.git'))).toBe(true); // per-repo, never global
    expect(checkStamp(repo, { env: env0 }).reuse).toBe(true);
  });

  it('refuses when a staged change moved the tree after the stamp', () => {
    recordStamp(repo, computeTreeKey(repo));
    writeFileSync(join(repo, 'a.mjs'), 'export const a = 3;\n');
    git('add', 'a.mjs');
    expect(checkStamp(repo, { env: env0 })).toMatchObject({ reuse: false });
    expect(checkStamp(repo, { env: env0 }).reason).toMatch(/tree differs/);
  });

  it('refuses with unstaged changes even when the stamp matches the working tree', () => {
    // The stamp certifies the working tree; the commit is the index. With an unstaged edit
    // the two differ, so the tested bytes are not the committed bytes.
    writeFileSync(join(repo, 'a.mjs'), 'export const a = 4;\n');
    recordStamp(repo, computeTreeKey(repo));
    expect(checkStamp(repo, { env: env0 })).toMatchObject({
      reuse: false,
      reason: 'unstaged changes to tracked files',
    });
  });

  it('refuses a stamp older than the age cap (defect review P3-1)', () => {
    // A time-dependent test (the benchmark baseline expires by date) can go red on a tree
    // whose bytes never changed, so a content key alone cannot certify it forever.
    const now = Date.now();
    recordStamp(repo, computeTreeKey(repo), { now: now - STAMP_MAX_AGE_MS - 1000 });
    expect(checkStamp(repo, { env: env0 })).toMatchObject({
      reuse: false,
      reason: expect.stringMatching(/older than/),
    });
    recordStamp(repo, computeTreeKey(repo), { now: now - 1000 });
    expect(checkStamp(repo, { env: env0 }).reuse).toBe(true);
    // A stamp dated in the future (clock skew) is not trusted either.
    recordStamp(repo, computeTreeKey(repo), { now: now + 3_600_000 });
    expect(checkStamp(repo, { env: env0 }).reuse).toBe(false);
  });

  it('PRE_COMMIT_FULL_TEST=1 forces the run', () => {
    recordStamp(repo, computeTreeKey(repo));
    expect(checkStamp(repo, { env: { PRE_COMMIT_FULL_TEST: '1' } }).reuse).toBe(false);
  });
});

describe('refusalReason — only a full, passing, unfiltered run over an unchanged tree certifies', () => {
  const ok = {
    configFile: '/r/vitest.config.mjs',
    reason: 'passed',
    unhandledErrors: [],
    config: {},
    ranIds: ['/r/a.test.mjs', '/r/b.test.mjs'],
    allIds: ['/r/b.test.mjs', '/r/a.test.mjs'],
    root: '/r',
    startKey: 'k',
    endKey: 'k',
  };
  it('accepts the full run', () => {
    expect(refusalReason(ok)).toBeNull();
  });
  it.each([
    ['a failed run', { reason: 'failed' }, /failed/],
    ['an interrupted run', { reason: 'interrupted' }, /interrupted/],
    ['unhandled errors', { unhandledErrors: [{}] }, /unhandled/],
    ['a -t filter', { config: { testNamePattern: /x/ } }, /name filter/],
    ['a shard', { config: { shard: { index: 1, count: 2 } } }, /shard/],
    ['--changed', { config: { changed: true } }, /changed/],
    ['--related', { config: { related: ['a.mjs'] } }, /related/],
    ['--exclude', { config: { cliExclude: ['t/b.test.mjs'] } }, /--exclude/],
    ['--dir', { config: { root: '/r', dir: '/r/sub' } }, /--dir/],
    ['--project', { config: { project: ['x'] } }, /--project/],
    ['another config file (delta review P3-3)', { configFile: '/r/alt.config.mjs' }, /--config/],
    ['no config file', { configFile: undefined }, /--config/],
    ['a file filter', { ranIds: ['/r/a.test.mjs'] }, /every test file/],
    ['an empty collection', { ranIds: [], allIds: [] }, /no test files/],
    ['an edit during the run', { endKey: 'k2' }, /changed while/],
    ['no start key', { startKey: null, endKey: null }, /changed while/],
  ])('refuses %s', (_name, over, re) => {
    expect(refusalReason({ ...ok, ...over })).toMatch(re);
  });
});

describe('scripts/pre-commit.sh tests block — wiring', () => {
  // green-stamp.mjs plus its one repo import; the fixture is a separate repo.
  function copyStampFiles() {
    for (const rel of [
      ['scripts', 'green-stamp.mjs'],
      ['lib', 'atomic-write.mjs'],
    ]) {
      mkdirSync(join(repo, rel[0]), { recursive: true });
      copyFileSync(join(ROOT, ...rel), join(repo, ...rel));
    }
  }

  // Executes the script's own bytes from the `# ── Tests` anchor to the end in the fixture
  // repo, with a fake `npm` that records it was called. Behavioural, so deleting the reuse
  // branch or inverting its condition turns a case red.
  function runTestsBlock(extraEnv = {}) {
    const script = readFileSync(join(ROOT, 'scripts', 'pre-commit.sh'), 'utf8');
    const start = script.indexOf('# ── Tests');
    expect(start).toBeGreaterThan(-1);
    copyStampFiles();
    const bin = join(repo, 'ignored', 'bin');
    mkdirSync(bin, { recursive: true });
    const log = join(repo, 'ignored', 'npm-calls');
    writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\necho "$@" >> "${log}"\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    writeFileSync(join(repo, 'ignored', 'block.sh'), `set -e\n${script.slice(start)}`);
    const r = spawnSync('bash', [join(repo, 'ignored', 'block.sh')], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PRE_COMMIT_FULL_TEST: '', ...extraEnv },
    });
    return { status: r.status, stdout: r.stdout, npmCalled: existsSync(log) };
  }

  it('skips npm test on a stamped tree and runs it otherwise', () => {
    // The copied script is itself a new untracked file, so commit it before stamping.
    copyStampFiles();
    git('add', '-A');
    git('commit', '-qm', 'script');

    const unstamped = runTestsBlock();
    expect(unstamped.status).toBe(0);
    expect(unstamped.npmCalled).toBe(true);
    expect(unstamped.stdout).toMatch(/Running tests \(no green stamp\)/);

    execFileSync('rm', ['-f', join(repo, 'ignored', 'npm-calls')]);
    recordStamp(repo, computeTreeKey(repo));
    const stamped = runTestsBlock();
    expect(stamped.status).toBe(0);
    expect(stamped.npmCalled).toBe(false);
    expect(stamped.stdout).toMatch(/reusing green run/);

    const forced = runTestsBlock({ PRE_COMMIT_FULL_TEST: '1' });
    expect(forced.npmCalled).toBe(true);
  });
});

// refusalReason is fed a hand-built config above, which is exactly why it could not see this:
// vitest 5 appends CLI `--exclude` to the resolved exclude list, so globTestSpecifications()
// shrinks to match the run and "every collected file ran" held for a 1-of-431 run (pre-ship
// defect review, P2-1). This case runs the real reporter inside a real vitest child.
describe('green-stamp reporter under a real vitest run', () => {
  // eslint-disable-next-line no-control-regex
  const plain = (t) => t.replace(/\x1b\[[0-9;]*m/g, '');
  function setupVitestFixture() {
    for (const rel of [
      ['scripts', 'green-stamp.mjs'],
      ['scripts', 'green-stamp-reporter.mjs'],
      ['lib', 'atomic-write.mjs'],
    ]) {
      mkdirSync(join(repo, rel[0]), { recursive: true });
      copyFileSync(join(ROOT, ...rel), join(repo, ...rel));
    }
    execFileSync('ln', ['-s', join(ROOT, 'node_modules'), join(repo, 'node_modules')]);
    writeFileSync(join(repo, '.gitignore'), 'ignored/\nnode_modules\n');
    writeFileSync(
      join(repo, 'vitest.config.mjs'),
      "export default { test: { include: ['t/**/*.test.mjs'], globalSetup: ['./scripts/green-stamp.mjs'], reporters: ['default', './scripts/green-stamp-reporter.mjs'] } };\n",
    );
    mkdirSync(join(repo, 't'));
    for (const n of ['a', 'b']) {
      writeFileSync(join(repo, 't', `${n}.test.mjs`), "import { it } from 'vitest';\nit('ok', () => {});\n");
    }
    git('add', '-A');
    git('commit', '-qm', 'fixture');
  }
  function vitest(...args) {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('VITEST') || k === 'FORCE_COLOR') delete env[k];
    env.NO_COLOR = '1'; // CI forces colour, and ANSI codes split "Test Files" from its count
    return spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env,
    });
  }

  it('a full run stamps; an --exclude run does not', () => {
    setupVitestFixture();
    const partial = vitest('--exclude', 't/b.test.mjs');
    expect(partial.status, partial.stderr).toBe(0);
    expect(plain(partial.stdout)).toMatch(/Test Files\s+1 passed \(1\)/); // premise: the run WAS partial
    expect(existsSync(stampPath(repo))).toBe(false);

    const full = vitest();
    expect(full.status, full.stderr).toBe(0);
    expect(plain(full.stdout)).toMatch(/Test Files\s+2 passed \(2\)/);
    expect(existsSync(stampPath(repo))).toBe(true);
    expect(checkStamp(repo, { env: env0 }).reuse).toBe(true);
  }, 60000);

  it('a failing full run on the stamped tree removes the stamp', () => {
    setupVitestFixture();
    expect(vitest().status).toBe(0);
    expect(existsSync(stampPath(repo))).toBe(true);
    // Same tree, red run (an env-dependent failure): the old green must not outlive it.
    writeFileSync(
      join(repo, 't', 'a.test.mjs'),
      "import { it, expect } from 'vitest';\nit('env', () => { expect(process.env.GS_FAIL).toBeUndefined(); });\n",
    );
    git('commit', '-qam', 'env test');
    expect(vitest().status).toBe(0);
    expect(existsSync(stampPath(repo))).toBe(true);
    const env = { ...process.env, GS_FAIL: '1' };
    for (const k of Object.keys(env)) if (k.startsWith('VITEST') || k === 'FORCE_COLOR') delete env[k];
    env.NO_COLOR = '1'; // CI forces colour, and ANSI codes split "Test Files" from its count
    const red = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run'], {
      cwd: repo,
      encoding: 'utf8',
      env,
    });
    expect(red.status).not.toBe(0);
    expect(existsSync(stampPath(repo))).toBe(false);
    // A red run cut short by --bail ends as 'interrupted', not 'failed' (pre-ship defect
    // review v6.13.2 P3-1); it is still evidence against the stamp.
    expect(vitest().status).toBe(0);
    expect(existsSync(stampPath(repo))).toBe(true);
    const bail = spawnSync(
      process.execPath,
      [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--bail=1'],
      { cwd: repo, encoding: 'utf8', env },
    );
    expect(bail.status).not.toBe(0);
    expect(existsSync(stampPath(repo))).toBe(false);
  }, 60000);

  it('a run killed by SIGINT before it ends removes the stamp', async () => {
    // vitest run exits on SIGINT without calling onTestRunEnd (v6.13.2 delta review FALSE-1).
    setupVitestFixture();
    writeFileSync(
      join(repo, 't', 'a.test.mjs'),
      "import { it } from 'vitest';\nimport { writeFileSync } from 'node:fs';\nit('slow', async () => { if (process.env.GS_SLOW) { writeFileSync(process.env.GS_READY, ''); await new Promise((r) => setTimeout(r, 20000)); } });\n",
    );
    git('commit', '-qam', 'slow test');
    expect(vitest().status).toBe(0);
    expect(existsSync(stampPath(repo))).toBe(true);
    // Signal only once the test body runs: a SIGINT that lands before the reporter has
    // registered its exit hook leaves the stamp in place, whether node's default action kills
    // the process (seen at 100 ms, 3/3) or vitest handles the signal and exits 130 (seen at
    // 180-210 ms by the v6.13.3 claims review). The old fixed 4 s sleep only made that window
    // unlikely; the marker rules it out.
    const ready = join(repo, 'ready.marker');
    const env = { ...process.env, GS_SLOW: '1', GS_READY: ready, NO_COLOR: '1' };
    for (const k of Object.keys(env)) if (k.startsWith('VITEST') || k === 'FORCE_COLOR') delete env[k];
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run'], {
      cwd: repo,
      env,
      stdio: 'ignore',
    });
    // A signal-killed child has exitCode null and signalCode set, so liveness reads both, and
    // the exit listener is attached before any wait so it cannot miss an early exit (v6.13.3
    // defect review P3-3: a dead child passed the premise and hung the case to its timeout).
    const exited = new Promise((r) => child.once('exit', r));
    const alive = () => child.exitCode === null && child.signalCode === null;
    try {
      for (let t = 0; t < 400 && !existsSync(ready) && alive(); t++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(existsSync(ready), 'premise: the slow test body started').toBe(true);
      expect(alive(), 'premise: the run was still going when interrupted').toBe(true);
      child.kill('SIGINT'); // this child only
      await exited;
    } finally {
      if (alive()) {
        child.kill('SIGKILL'); // a failed premise must not leave it running past the fixture
        await exited;
      }
    }
    expect(existsSync(stampPath(repo))).toBe(false);
  }, 60000);

  it('a partial run that loads the reporter keeps the stamp', () => {
    setupVitestFixture();
    expect(vitest().status).toBe(0);
    expect(existsSync(stampPath(repo))).toBe(true);
    const one = vitest('t/a.test.mjs');
    expect(one.status, one.stderr).toBe(0);
    expect(plain(one.stdout)).toMatch(/Test Files\s+1 passed \(1\)/);
    expect(existsSync(stampPath(repo))).toBe(true);
  }, 60000);

  it('a --reporter run, which never loads the stamp reporter, removes the stamp (delta review P3-1)', () => {
    setupVitestFixture();
    expect(vitest().status).toBe(0);
    expect(existsSync(stampPath(repo))).toBe(true);
    const dot = vitest('--reporter=dot');
    expect(dot.status, dot.stderr).toBe(0);
    expect(existsSync(stampPath(repo))).toBe(false);
    // Loading it explicitly beside another reporter keeps the full-run contract.
    expect(vitest('--reporter=dot', '--reporter=./scripts/green-stamp-reporter.mjs').status).toBe(0);
    expect(existsSync(stampPath(repo))).toBe(true);
  }, 60000);
});

describe('green-stamp wiring in this repo', () => {
  it('vitest.config.mjs loads both the reporter and the setup that clears for runs without it', () => {
    const { reporters, globalSetup } = vitestConfig.test;
    expect(loadsStampReporter(reporters)).toBe(true);
    expect(globalSetup).toContain('./scripts/green-stamp.mjs');
  });

  it('loadsStampReporter recognises the reporter by file name in any entry shape', () => {
    expect(
      loadsStampReporter([
        ['default', {}],
        ['./scripts/green-stamp-reporter.mjs', {}],
      ]),
    ).toBe(true);
    expect(loadsStampReporter(['/abs/scripts/green-stamp-reporter.mjs'])).toBe(true);
    expect(loadsStampReporter([['dot', {}]])).toBe(false);
    expect(loadsStampReporter(undefined)).toBe(false);
  });
});
