// docs/measurement/baselines.md has promised since e1824ffd (2026-09-08) that every row
// CLAUDE.md's Baselines table replaces is moved there verbatim. Nothing enforced it: of the
// 14 commits after the promise that changed the rows, 9 overwrote the old row instead, and
// the rows were recovered from git on 2026-11-09. The guard in scripts/pre-commit.sh now
// refuses such a commit.
//
// Same approach as pre-commit-corpus-guard.test.mjs: the guard runs the SHIPPED script's
// own bytes, sliced out of scripts/pre-commit.sh, in a throwaway repo.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'pre-commit.sh');

/** The guard section, verbatim from the shipped hook. */
function guardSection() {
  const src = readFileSync(SCRIPT, 'utf8');
  const start = src.indexOf('# ── Baselines move guard');
  const end = src.indexOf('# ── Frozen-corpus guard', start);
  expect(start, 'guard section not found in scripts/pre-commit.sh').toBeGreaterThan(-1);
  expect(end, 'could not find the end of the guard section').toBeGreaterThan(start);
  const section = src.slice(start, end);
  // Anti-vacuity: a slice that lost the exit path would let every refusal below "pass".
  expect(section).toContain('exit 1');
  return section;
}

// The real pair from 96d274d1 (2026-11-03), the most recent commit that overwrote a row:
// OUTGOING is the table at 96d274d1^, INCOMING the table it wrote.
const OUTGOING = [
  '| Tests | **428 files / 6628**, 0 skipped (1 skips without git hooks) | `main` @ `c8cfab5`, 2026-09-25, v6.12.1 tree |',
  '| Knip | **32** unused exports, **0** unused files, **3** unlisted binaries | same tree, primary working tree, knip 6.35.1 |',
  '| Coverage | **85.34** stmts · **79.75** branches · **90.72** funcs · **86.58** lines | same tree, vitest 5.0.0 |',
];
const INCOMING = [
  '| Tests | **553 files / 9937**, 0 skipped | `main` @ `ec3510eb`, 2026-11-03, v6.30.15 + R3 (unreleased) |',
  '| Knip | **36** unused exports, **0** unused files, **7** unlisted binaries | same tree, primary working tree, knip 6.43.0 |',
  '| Coverage | **87.87** stmts · **82.97** branches · **92.51** funcs · **89.16** lines | same tree, vitest 5.0.5 |',
];
// An older block already in the record. Its Knip line is byte-identical to OUTGOING's, so a
// guard that checks lines one by one, instead of the block, finds 1 of 3 and can be fooled
// by a partial move.
const EARLIER_BLOCK = [
  '> | Tests | **427 files / 6613**, 0 skipped (1 skips without git hooks) | `feat/mem-verify` @ `404941b`, 2026-09-25, v6.12.0 tree |',
  '> | Knip | **32** unused exports, **0** unused files, **3** unlisted binaries | same tree, primary working tree, knip 6.35.1 |',
  '> | Coverage | **85.33** stmts · **79.74** branches · **90.72** funcs · **86.57** lines | same tree, vitest 5.0.0 |',
].join('\n');

const quote = (rows) => rows.map((r) => `> ${r}`).join('\n');
const claudeMd = (rows, version = '1.0.0') =>
  `# CLAUDE.md\n\n- **Version**: ${version}\n\n| Baseline | Value | Tree / date |\n|----------|-------|-------------|\n${rows.join('\n')}\n\nCoverage \`include\` is a denylist.\n`;
const record = (...blocks) => `# Baselines — full record\n\n${blocks.map((b) => `${b}\n`).join('\n')}`;

const RECORD_REL = join('docs', 'measurement', 'baselines.md');

let repo;
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
const write = (rel, body) => {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), body);
};
const stage = (rel, body) => {
  write(rel, body);
  git('add', rel);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'mem-baselinesguard-'));
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  stage('CLAUDE.md', claudeMd(OUTGOING));
  stage(RECORD_REL, record(EARLIER_BLOCK));
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

describe('pre-commit Baselines move guard', () => {
  it('CONTROL: a commit that edits CLAUDE.md outside the table passes', () => {
    // Without this, every refusal below is equally consistent with a guard that refuses
    // any change to CLAUDE.md.
    stage('CLAUDE.md', claudeMd(OUTGOING, '1.0.1'));
    expect(git('diff', '--cached', '--name-only').trim()).toBe('CLAUDE.md');
    expect(runGuard().code).toBe(0);
  });

  it("refuses 96d274d1's shape: the rows are replaced and the outgoing rows are not moved", () => {
    stage('CLAUDE.md', claudeMd(INCOMING));
    const r = runGuard();
    expect(r.code).toBe(1);
    expect(r.out).toContain('docs/measurement/baselines.md');
    // The refusal names the row that has to move, so the fix is a copy, not a search.
    expect(r.out).toContain('428 files / 6628');
  });

  it('passes when the outgoing rows are staged as one quoted block', () => {
    stage('CLAUDE.md', claudeMd(INCOMING));
    stage(RECORD_REL, record(quote(OUTGOING), EARLIER_BLOCK));
    expect(runGuard().code).toBe(0);
  });

  it('reads the staged record, not the working tree', () => {
    stage('CLAUDE.md', claudeMd(INCOMING));
    write(RECORD_REL, record(quote(OUTGOING), EARLIER_BLOCK));
    expect(git('diff', '--name-only').trim()).toBe(RECORD_REL);
    expect(runGuard().code).toBe(1);
  });

  it('does not count a partial move, even with the missing line elsewhere in the record', () => {
    // Tests and Coverage moved, Knip left out. The record still holds OUTGOING's Knip line
    // byte for byte inside EARLIER_BLOCK, so every line is "present" and only the block
    // is missing.
    stage('CLAUDE.md', claudeMd(INCOMING));
    stage(RECORD_REL, record(quote([OUTGOING[0], OUTGOING[2]]), EARLIER_BLOCK));
    expect(record(EARLIER_BLOCK)).toContain(`> ${OUTGOING[1]}`);
    expect(runGuard().code).toBe(1);
  });

  it('checks nothing when HEAD has no Baselines table', () => {
    stage('CLAUDE.md', '# CLAUDE.md\n');
    git('commit', '-qm', 'no table');
    stage('CLAUDE.md', claudeMd(INCOMING));
    expect(runGuard().code).toBe(0);
  });

  it('honours the documented override', () => {
    stage('CLAUDE.md', claudeMd(INCOMING));
    const r = runGuard({ DISABLE_BASELINES_GUARD: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('DISABLE_BASELINES_GUARD=1');
  });
});
