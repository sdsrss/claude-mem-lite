// The pre-commit gate may skip `npm test` for a tree whose full suite just passed. Every
// case here drives one of the conditions that must make it RUN the suite instead, because
// a wrong "reuse" is the only failure this feature can add. Contract: scripts/green-stamp.mjs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, copyFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
import { disposeFixtureDir } from './test-helpers.mjs';
import { computeTreeKey, checkStamp, recordStamp, stampPath } from '../scripts/green-stamp.mjs';
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

  it('PRE_COMMIT_FULL_TEST=1 forces the run', () => {
    recordStamp(repo, computeTreeKey(repo));
    expect(checkStamp(repo, { env: { PRE_COMMIT_FULL_TEST: '1' } }).reuse).toBe(false);
  });
});

describe('refusalReason — only a full, passing, unfiltered run over an unchanged tree certifies', () => {
  const ok = {
    reason: 'passed',
    unhandledErrors: [],
    config: {},
    ranIds: ['/r/a.test.mjs', '/r/b.test.mjs'],
    allIds: ['/r/b.test.mjs', '/r/a.test.mjs'],
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
