// The CLI and the session's hooks must name the SAME project, or work saved by one is
// invisible to the other.
//
// `inferProject()` derives the name from CLAUDE_PROJECT_DIR || PWD || cwd. In a hook
// CLAUDE_PROJECT_DIR is set, so hooks always name the session root. In a bare terminal it is
// not, so the name follows wherever the user happens to stand:
//
//   • `cd src/auth && claude-mem-lite recent` → reads `src--auth`, which has no rows, while
//     the session's hooks wrote `projects--mem`. The user sees "No recent observations".
//
// The obvious fix — anchor on the git work-tree root — was tried and REVERTED before it
// shipped (project-utils.mjs), because it breaks the mirror case: Claude Code started in
// `mono/packages/api` sets CLAUDE_PROJECT_DIR to that package dir, so hooks write
// `packages--api` while a git anchor would send the CLI to `mono--monorepo`. Both cases are
// real, and no purely path-derived rule can tell them apart — the DB can. So the CLI layer
// computes BOTH candidates and prefers whichever already holds rows, cwd winning ties.
//
// That ordering is what makes this safe: it can never move a working setup off the project
// it is already using. It only ever redirects when the cwd-derived name holds nothing at
// all, which is exactly the broken case. project-utils.mjs stays DB-free and byte-identical
// on the hook hot path.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, basename } from 'path';
import { initSchema } from '../schema.mjs';
import { projectNameFromDir } from '../project-utils.mjs';
import { findGitRoot, resolveCliProject, _resetCliProjectCache } from '../lib/cli-project.mjs';

const CLI = resolve(import.meta.dirname, '../cli.mjs');
const tmps = [];
function mktmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmps.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

let db;
beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  _resetCliProjectCache();
});

let seq = 0;
function seedObs(project) {
  // FK: observations.memory_session_id references sdk_sessions. `:memory:` test DBs enforce
  // it once PRAGMA foreign_keys is on, so seed the parent row rather than only the child.
  const sid = `sess-${++seq}`;
  const now = Date.now();
  db.prepare(
    'INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch) VALUES (?, ?, ?, ?, ?)',
  ).run(sid, sid, project, new Date(now).toISOString(), now);
  db.prepare(
    "INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch) VALUES (?, ?, 'discovery', 'seed', 'seed', ?, ?)",
  ).run(sid, project, new Date(now).toISOString(), now);
}

describe('projectNameFromDir — one naming rule, not two', () => {
  it('produces the same name inferProject() would for the same directory', async () => {
    // The CLI-layer candidate must be built with the SAME rule as the hook-side name, or the
    // two faces disagree by construction. Asserted against inferProject() itself rather than
    // a copied literal, so a change to sanitization or the parent--base shape cannot drift
    // one face away from the other.
    const { inferProject } = await import('../project-utils.mjs');
    const dir = '/tmp/some parent/my.repo';
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = dir;
    try {
      expect(projectNameFromDir(dir)).toBe(inferProject());
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
    }
  });
});

describe('findGitRoot', () => {
  it('walks up to the work-tree root from a nested directory', () => {
    const root = mktmp('cliproj-git-');
    mkdirSync(join(root, '.git'));
    const deep = join(root, 'src', 'auth');
    mkdirSync(deep, { recursive: true });
    expect(findGitRoot(deep)).toBe(root);
  });

  it('returns null when no work tree encloses the directory', () => {
    const plain = mktmp('cliproj-plain-');
    // A tmpdir has no .git anywhere up to /, so this also proves the walk terminates
    // at the filesystem root instead of spinning.
    expect(findGitRoot(plain)).toBe(null);
  });
});

describe('resolveCliProject', () => {
  it('keeps the cwd-derived name when it holds rows, even inside a git work tree', () => {
    // The monorepo mirror case that reverted the git anchor: hooks wrote the package dir's
    // name, and the CLI standing in that same dir must agree with them — not walk to the
    // repo root. cwd wins ties, so rows under BOTH names still resolve to cwd.
    const root = mktmp('cliproj-mono-');
    mkdirSync(join(root, '.git'));
    const pkg = join(root, 'packages', 'api');
    mkdirSync(pkg, { recursive: true });
    seedObs(projectNameFromDir(pkg));
    seedObs(projectNameFromDir(root));
    expect(resolveCliProject(db, { dir: pkg })).toBe(projectNameFromDir(pkg));
  });

  it('falls back to the work-tree root when the cwd-derived name holds nothing', () => {
    // The reported bug: `cd src/auth && claude-mem-lite recent` read an empty `src--auth`.
    const root = mktmp('cliproj-sub-');
    mkdirSync(join(root, '.git'));
    const deep = join(root, 'src', 'auth');
    mkdirSync(deep, { recursive: true });
    seedObs(projectNameFromDir(root));
    expect(resolveCliProject(db, { dir: deep })).toBe(projectNameFromDir(root));
  });

  it('counts sdk_sessions rows — a directory Claude Code has run in is not empty', () => {
    // hook.mjs inserts an sdk_sessions row on the first SessionStart, long before any
    // observation exists. Probing observations/deferred_work alone made a package dir where
    // CC had been running all morning still read as "holds nothing", so the fallback fired
    // on a directory that already WAS its own project.
    const root = mktmp('cliproj-sess-');
    mkdirSync(join(root, '.git'));
    const pkg = join(root, 'packages', 'api');
    mkdirSync(pkg, { recursive: true });
    seedObs(projectNameFromDir(root));
    const now = Date.now();
    db.prepare(
      'INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch) VALUES (?, ?, ?, ?, ?)',
    ).run('cc-1', 'cc-1', projectNameFromDir(pkg), new Date(now).toISOString(), now);
    expect(resolveCliProject(db, { dir: pkg })).toBe(projectNameFromDir(pkg));
  });

  it('stops the work-tree walk at $HOME', () => {
    // A dotfiles repo at ~/.git makes every directory under home look like it sits in one
    // work tree, so an unrelated scratch dir would resolve to the home project.
    const home = mktmp('cliproj-home-');
    mkdirSync(join(home, '.git'));
    const scratch = join(home, 'scratch', 'thing');
    mkdirSync(scratch, { recursive: true });
    seedObs(projectNameFromDir(home));
    expect(resolveCliProject(db, { dir: scratch, homeDir: home })).toBe(projectNameFromDir(scratch));
    // The walk itself still reports the root when asked without the boundary.
    expect(findGitRoot(scratch)).toBe(home);
  });

  it('never invents a project when neither candidate holds rows', () => {
    // A brand-new subdirectory must keep naming itself, so the first save lands where the
    // user stands rather than being silently absorbed into the enclosing repo.
    const root = mktmp('cliproj-empty-');
    mkdirSync(join(root, '.git'));
    const deep = join(root, 'src', 'auth');
    mkdirSync(deep, { recursive: true });
    expect(resolveCliProject(db, { dir: deep })).toBe(projectNameFromDir(deep));
  });

  it('counts deferred_work rows, not only observations', () => {
    // `defer add` in a fresh repo writes no observation. If the probe looked at observations
    // alone, `defer add` at the root followed by `defer list` from a subdir would report an
    // empty list — the same silent split, one table over.
    const root = mktmp('cliproj-defer-');
    mkdirSync(join(root, '.git'));
    const deep = join(root, 'src');
    mkdirSync(deep, { recursive: true });
    db.prepare(
      "INSERT INTO deferred_work (project, title, priority, status, created_at_epoch) VALUES (?, 'x', 2, 'open', ?)",
    ).run(projectNameFromDir(root), Date.now());
    expect(resolveCliProject(db, { dir: deep })).toBe(projectNameFromDir(root));
  });

  it('memoizes per directory, not once per process', () => {
    // One CLI process is one command, but the suite resets between tests and each test used
    // a single dir — so a memo that ignored its key and returned the first cached value for
    // everything stayed green. A subagent or a long-lived harness resolving two directories
    // in one process would silently get the first one's answer for both.
    const a = mktmp('cliproj-memoA-');
    const b = mktmp('cliproj-memoB-');
    mkdirSync(join(a, '.git'));
    mkdirSync(join(b, '.git'));
    seedObs(projectNameFromDir(a));
    seedObs(projectNameFromDir(b));
    expect(resolveCliProject(db, { dir: a })).toBe(projectNameFromDir(a));
    expect(resolveCliProject(db, { dir: b }), "the second directory got the first one's cached answer").toBe(
      projectNameFromDir(b),
    );
    expect(projectNameFromDir(a)).not.toBe(projectNameFromDir(b));
  });

  it('resolves a linked worktree, whose .git is a FILE and not a directory', () => {
    // `git worktree add` and submodules write a `.git` FILE holding `gitdir: …`. Requiring a
    // DIRECTORY would silently walk past such a root to the enclosing tree — or to nothing —
    // and the fallback would stop working for every worktree user. Nothing pinned the choice.
    const root = mktmp('cliproj-worktree-');
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    const deep = join(root, 'src');
    mkdirSync(deep, { recursive: true });
    seedObs(projectNameFromDir(root));
    expect(findGitRoot(deep), 'a .git FILE was not accepted as a work-tree root').toBe(root);
    expect(resolveCliProject(db, { dir: deep })).toBe(projectNameFromDir(root));
  });

  it('falls back to the cwd-derived name instead of throwing when the probe fails', () => {
    // Resolution runs before every CLI command. A probe that throws (locked DB, a table an
    // older schema lacks) must degrade to today's behaviour, never take the command down.
    const root = mktmp('cliproj-fail-');
    mkdirSync(join(root, '.git'));
    const deep = join(root, 'src');
    mkdirSync(deep, { recursive: true });
    seedObs(projectNameFromDir(root));
    const broken = {
      prepare() {
        throw new Error('database is locked');
      },
    };
    expect(resolveCliProject(broken, { dir: deep })).toBe(projectNameFromDir(deep));
  });
});

describe('CLI end to end — a subdirectory reads what the repo root saved', () => {
  it('finds a repo-root observation when run from a nested directory', () => {
    const box = mktmp('cliproj-e2e-');
    const repo = join(box, 'myrepo');
    const deep = join(repo, 'src', 'auth');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(deep, { recursive: true });
    const dataDir = join(box, 'data');
    mkdirSync(dataDir, { recursive: true });

    // PWD must be set explicitly: inferProject() prefers process.env.PWD over cwd, and
    // execFileSync's `cwd` option does NOT update the inherited PWD — without this the
    // child would derive its name from the test runner's directory, not the fixture.
    const run = (cwd, args) =>
      execFileSync(process.execPath, [CLI, ...args], {
        cwd,
        env: {
          ...process.env,
          PWD: cwd,
          CLAUDE_PROJECT_DIR: undefined,
          CLAUDE_MEM_DIR: dataDir,
          CLAUDE_MEM_SKIP_UPDATE: '1',
          MEM_QUIET_HOOKS: '1',
        },
        encoding: 'utf8',
      });

    run(repo, ['save', 'root-level marker observation', '--type', 'discovery']);
    const out = run(deep, ['recent', '5']);
    expect(out, `a nested cwd could not see what the repo root saved:\n${out}`).toContain(
      'root-level marker observation',
    );
    // And the row really is stored under the repo-root name, not re-homed under the subdir.
    expect(basename(repo)).toBe('myrepo');
  });

  it('does NOT absorb a subdirectory save into the enclosing repo', () => {
    // Pre-tag review, CONFIRMED: applying the fallback to WRITE paths too made a fresh
    // subdirectory unable to become its own project. The tie rule's safety argument is a
    // READ argument — for a read, "cwd holds nothing" means there is nothing to lose; for a
    // write it is the normal precondition of a project about to be born. Absorbing there
    // strands the note: once the session's hooks later write `packages--api`, the row saved
    // from that very directory is unreachable from it.
    const box = mktmp('cliproj-absorb-');
    const repo = join(box, 'monorepo');
    const pkg = join(repo, 'packages', 'api');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(pkg, { recursive: true });
    const dataDir = join(box, 'data');
    mkdirSync(dataDir, { recursive: true });
    const run = (cwd, args) =>
      execFileSync(process.execPath, [CLI, ...args], {
        cwd,
        env: {
          ...process.env,
          PWD: cwd,
          CLAUDE_PROJECT_DIR: undefined,
          CLAUDE_MEM_DIR: dataDir,
          CLAUDE_MEM_SKIP_UPDATE: '1',
          MEM_QUIET_HOOKS: '1',
        },
        encoding: 'utf8',
      });

    run(repo, ['save', 'root level note alpha', '--type', 'discovery']);
    const saved = run(pkg, ['save', 'package level note beta', '--type', 'discovery']);
    expect(saved, `the package-level save was absorbed into the enclosing repo:\n${saved}`).toContain(
      'packages--api',
    );
    expect(saved).not.toContain('monorepo');
  });
});
