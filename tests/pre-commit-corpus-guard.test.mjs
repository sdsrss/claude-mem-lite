// SEC-5 (2026-08-29 audit): the frozen benchmark corpora had one door.
//
// The LIVE replay benchmarks dump frozen corpora so a later A/B runs over the same
// denominator. `benchmark/results/` is gitignored — and that was the whole protection,
// while `--dump` / `--shapes` / `--corpus` take an arbitrary path. One of the two families
// is genuinely sensitive: `*-shapes-*.json` carries real failing commands and their real
// stderr, read out of live transcripts. The citation corpus holds no transcript text (its
// longest string is a project path) but does carry session UUIDs and absolute paths.
//
// The guard runs the SHIPPED script's own bytes, sliced out of scripts/pre-commit.sh, not
// a copy of the rule — a copy would drift from the file that actually gates commits, and
// invoking the whole script would run eslint plus the entire suite.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'pre-commit.sh');

/** The guard section, verbatim from the shipped hook. */
function guardSection() {
  const src = readFileSync(SCRIPT, 'utf8');
  const start = src.indexOf('# ── Frozen-corpus guard');
  const end = src.indexOf('# ── Lint ', start);
  expect(start, 'guard section not found in scripts/pre-commit.sh').toBeGreaterThan(-1);
  expect(end, 'could not find the end of the guard section').toBeGreaterThan(start);
  const section = src.slice(start, end);
  // Anti-vacuity: a slice that lost the exit path would let every case below "pass".
  expect(section).toContain('exit 1');
  return section;
}

let repo;
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'mem-corpusguard-'));
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git('add', 'README.md');
  git('commit', '-qm', 'base');
});
afterEach(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Run the shipped guard against the fixture repo's index. @returns {{code:number,out:string}} */
function runGuard(env = {}) {
  try {
    const out = execFileSync('bash', ['-c', guardSection()], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const stage = (rel, body = '{}') => {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), body);
  git('add', '-f', rel);
};

describe('pre-commit frozen-corpus guard', () => {
  it('CONTROL: an ordinary staged file passes', () => {
    // Without this, every rejection below is equally consistent with a guard that
    // rejects everything.
    stage('lib/thing.mjs', 'export const x = 1;\n');
    expect(runGuard().code).toBe(0);
  });

  it('blocks a corpus under benchmark/results/', () => {
    stage('benchmark/results/citation-corpus-2026-08-31.json');
    const r = runGuard();
    expect(r.code).toBe(1);
    expect(r.out).toContain('benchmark/results/citation-corpus-2026-08-31.json');
  });

  it('blocks a shapes dump saved OUTSIDE benchmark/results/', () => {
    // The reason the guard matches names and not just the directory: --dump and --shapes
    // take an arbitrary path, and .gitignore only ever covered the one directory.
    stage('error-recall-shapes-2026-08-31.json');
    expect(runGuard().code).toBe(1);
  });

  it('blocks a corpus dump saved outside the directory too', () => {
    stage('tmp/citation-corpus-2026-08-31.json');
    expect(runGuard().code).toBe(1);
  });

  it('leaves similarly-named source files alone', () => {
    // `-shapes-`/`-corpus-` followed by a DATE is the dump convention; a module that
    // merely has one of those words in its name is not a dump.
    stage('lib/corpus-stats.mjs', 'export const n = 1;\n');
    stage('benchmark/shapes-helper.mjs', 'export const s = 1;\n');
    expect(runGuard().code).toBe(0);
  });

  it('honours the documented override', () => {
    stage('error-recall-shapes-2026-08-31.json');
    const r = runGuard({ DISABLE_CORPUS_GUARD: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('DISABLE_CORPUS_GUARD=1');
  });
});
