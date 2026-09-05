// `unadopt --all` must strip the CLAUDE.md managed block from every project
// Claude Code knows about (~/.claude.json `projects`), not just legacy memdir
// residue. Isolated HOME + subprocess CLI so detectCwd()/homedir() can never
// escape to the real machine. afterAll asserts the real repo CLAUDE.md is
// byte-identical — a regression net for the cwd-leak class of bug.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_CLAUDE_MD = join(REPO, 'CLAUDE.md');
const USER_MD = '# proj\n\nMy notes.\n\n## Conventions\n- spaces\n';

let HOME, projA, projB, projC, projGone, BASE_ENV, repoSnapshot;

function run(args, { cwd, allowFail = false } = {}) {
  try {
    const out = execFileSync('node', [join(REPO, 'cli.mjs'), ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...BASE_ENV, PWD: cwd, CLAUDE_PROJECT_DIR: cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    });
    return { ok: true, out };
  } catch (e) {
    const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
    if (!allowFail) throw new Error(`cli ${args.join(' ')} exited ${e.status}:\n${out}`, { cause: e });
    return { ok: false, out, code: e.status };
  }
}

function hasBlock(dir) {
  const p = join(dir, 'CLAUDE.md');
  if (!existsSync(p)) return false;
  return /<!-- claude-mem-lite:begin/.test(readFileSync(p, 'utf8'));
}

describe('unadopt --all scans known projects (~/.claude.json)', () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), 'mem-unadopt-all-'));
    projA = join(HOME, 'a');
    projB = join(HOME, 'b');
    projC = join(HOME, 'c');
    projGone = join(HOME, 'gone-deleted');
    repoSnapshot = existsSync(REPO_CLAUDE_MD) ? readFileSync(REPO_CLAUDE_MD, 'utf8') : null;

    BASE_ENV = { ...process.env, HOME, CLAUDE_MEM_SKIP_REPOS: '1' };
    delete BASE_ENV.CLAUDE_MEM_DIR;
    delete BASE_ENV.CLAUDE_PROJECT_DIR;
    delete BASE_ENV.PWD;

    mkdirSync(join(HOME, '.claude'), { recursive: true });
    for (const d of [projA, projB, projC]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'CLAUDE.md'), USER_MD);
    }
    // ~/.claude.json lists A, B, C, and a now-deleted path (must be filtered out).
    writeFileSync(
      join(HOME, '.claude.json'),
      JSON.stringify(
        {
          projects: { [projA]: {}, [projB]: {}, [projC]: {}, [projGone]: {} },
        },
        null,
        2,
      ),
    );

    run(['adopt'], { cwd: projA });
    run(['adopt'], { cwd: projB });
    // C = PARTIAL residue: adopted, then the user deleted the detail doc while
    // the CLAUDE.md block remains. The old isAdopted (block AND doc) gate made
    // `unadopt --all` skip this project forever — regression case for the
    // hasResidue fix.
    run(['adopt'], { cwd: projC });
    rmSync(join(projC, '.claude', 'plugin_claude_mem_lite.md'));
  }, 60000);

  afterAll(() => {
    if (repoSnapshot !== null) expect(readFileSync(REPO_CLAUDE_MD, 'utf8')).toBe(repoSnapshot);
    try {
      execFileSync('rm', ['-rf', HOME]);
    } catch {
      /* best-effort */
    }
  });

  it('adopt wrote a managed block into all known projects (C kept block-only)', () => {
    expect(hasBlock(projA)).toBe(true);
    expect(hasBlock(projB)).toBe(true);
    expect(hasBlock(projC)).toBe(true);
    expect(existsSync(join(projC, '.claude', 'plugin_claude_mem_lite.md'))).toBe(false);
  });

  it('--all --dry-run reports all three (incl. partial-residue C) but removes nothing', () => {
    const r = run(['unadopt', '--all', '--dry-run'], { cwd: HOME });
    expect(r.out).toMatch(/would-remove/);
    expect(r.out).toContain(projA);
    expect(r.out).toContain(projB);
    expect(r.out).toContain(projC);
    expect(hasBlock(projA)).toBe(true);
    expect(hasBlock(projB)).toBe(true);
    expect(hasBlock(projC)).toBe(true);
  });

  it('--all removes the block from every known project, preserving user content', () => {
    const r = run(['unadopt', '--all'], { cwd: HOME });
    expect(r.out).toMatch(/removed 3 CLAUDE\.md block/);
    expect(hasBlock(projA)).toBe(false);
    expect(hasBlock(projB)).toBe(false);
    // C had block-but-no-doc — the pre-hasResidue gate skipped it forever.
    expect(hasBlock(projC)).toBe(false);
    // User content survives the slug-scoped removal.
    for (const d of [projA, projB, projC]) {
      const md = readFileSync(join(d, 'CLAUDE.md'), 'utf8');
      expect(md).toContain('My notes.');
      expect(md).toContain('- spaces');
      expect(existsSync(join(d, '.claude', 'plugin_claude_mem_lite.md'))).toBe(false);
    }
  });

  it('--all is idempotent (second run removes zero)', () => {
    const r = run(['unadopt', '--all'], { cwd: HOME });
    expect(r.out).toMatch(/removed 0 CLAUDE\.md block/);
  });
});
