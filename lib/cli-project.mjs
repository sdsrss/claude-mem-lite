// lib/cli-project.mjs — which project a terminal-invoked CLI command should read.
//
// `inferProject()` names the directory the process stands in (CLAUDE_PROJECT_DIR || PWD ||
// cwd). Inside a hook that is always the session root, because Claude Code sets
// CLAUDE_PROJECT_DIR. In a bare terminal it is not set, so the name follows the user:
// `cd src/auth && claude-mem-lite recent` asks for `src--auth`, which holds nothing, while
// the session's hooks have been writing `projects--mem`. The command answers "No recent
// observations" about a project full of them.
//
// Anchoring on the git work-tree root instead was tried and reverted before shipping (see
// project-utils.mjs): Claude Code started in `mono/packages/api` sets CLAUDE_PROJECT_DIR to
// the PACKAGE dir, so hooks write `packages--api` while a git anchor sends the CLI to
// `mono--monorepo` — the same split, mirrored. No purely path-derived rule separates the two
// cases, because the difference is which name the hooks actually chose. The DB knows.
//
// So: compute both candidates, prefer whichever already holds rows, cwd winning ties.
//
// READ COMMANDS ONLY. The tie rule ("can only redirect when the cwd-derived name holds
// NOTHING") reads like a universal safety argument, and pre-tag review reproduced why it is
// not: for a read, "cwd holds nothing" means there is nothing to lose; for a WRITE it is the
// normal precondition of a project about to be born. Applying the fallback to save /
// defer add / restore / import-jsonl absorbed a fresh package dir's first rows into the
// enclosing repo, and once the session's hooks later wrote `packages--api`, those rows were
// unreachable from the directory they were written in. Write paths keep plain
// inferProject(); callers in mem-cli.mjs and cli/activity.mjs mark which is which.
//
// Lives here, not in project-utils.mjs: that module is DB-free and on the hook hot path, and
// hook-side resolution must stay byte-identical (hooks already have the right answer).

import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { claudeConfigDir } from './data-paths.mjs';
// inferProject through the utils.mjs barrel ON PURPOSE, not projectNameFromDir directly:
// "what does this process call its project" must keep exactly ONE definition, so anything
// that later changes it (a config file, a new env var) moves both faces together instead of
// letting this module drift into a second answer. It is also the seam mem-cli's own tests
// stub, and a resolver that bypassed it would quietly stop resolving what they exercise.
import { inferProject } from '../utils.mjs';
import { inferProjectDir, projectNameFromDir } from '../project-utils.mjs';

// Bounded so a pathological path (symlink loop, very deep tree) cannot spin. 64 levels is
// far past any real repo checkout; the loop also stops when dirname() reaches a fixed point.
const MAX_WALK_DEPTH = 64;

/**
 * Nearest enclosing git work-tree root, or null.
 *
 * Checks for a `.git` ENTRY, not a directory: a linked worktree and a submodule both put a
 * `.git` FILE at their root, and both are work-tree roots for this purpose.
 *
 * @param {string} startDir
 * @returns {string|null}
 */
export function findGitRoot(startDir) {
  let dir = resolve(startDir);
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
  return null;
}

// Memoized per process: every CLI command resolves once, but a single command can ask
// several times (search resolves for the query, the reranker and the tier window).
let _cache = new Map();

/** Reset the per-process memo (for tests). */
export function _resetCliProjectCache() {
  _cache = new Map();
}

// Ordered cheapest-signal-last. Each is a distinct way a directory can already BE a project:
//   sdk_sessions   — hook.mjs inserts a row on the first SessionStart, long before any
//                    observation exists. Without it, a package dir Claude Code had been
//                    running in all morning still read as "holds nothing" and the fallback
//                    fired on a directory that was already its own project (pre-tag review).
//   deferred_work  — `defer add` in a fresh repo writes no observation either.
//   observations   — the common case.
const ROW_PROBES = [
  'SELECT 1 FROM observations WHERE project = ? LIMIT 1',
  'SELECT 1 FROM sdk_sessions WHERE project = ? LIMIT 1',
  'SELECT 1 FROM deferred_work WHERE project = ? LIMIT 1',
];

function hasRows(db, project) {
  for (const sql of ROW_PROBES) {
    if (db.prepare(sql).get(project)) return true;
  }
  return false;
}

/**
 * The project a CLI command should target when the user gave no --project.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{dir?: string}} [opts] `dir` overrides the directory to resolve from (tests).
 * @returns {string} Canonical project name
 */
export function resolveCliProject(db, { dir, homeDir = homedir() } = {}) {
  const base = dir || process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
  // `dir` is a test seam for pointing the walk at a fixture; the real path asks inferProject.
  const cwdName = dir ? projectNameFromDir(dir) : inferProject();
  if (_cache.has(base)) return _cache.get(base);
  let chosen = cwdName;
  try {
    const root = findGitRoot(base);
    // A dotfiles repo at ~/.git puts EVERY directory under home in one work tree, which
    // would make an unrelated scratch dir resolve to the home project. Home is a container,
    // not a project — unless the user is standing in it, in which case it is the ordinary
    // case and the candidates coincide anyway.
    const rootName =
      root && !(root === resolve(homeDir) && resolve(base) !== resolve(homeDir))
        ? projectNameFromDir(root)
        : null;
    // Only the case where cwd holds nothing can move the answer — see the tie rule above.
    if (rootName && rootName !== cwdName && !hasRows(db, cwdName) && hasRows(db, rootName)) {
      chosen = rootName;
    }
  } catch {
    // Resolution runs before every command; a probe that throws (locked DB, a table an older
    // schema lacks) must degrade to today's behaviour, never take the command down.
    chosen = cwdName;
  }
  _cache.set(base, chosen);
  return chosen;
}

/**
 * The project a WRITE command takes when no --project was given: plain inferProject() (no DB
 * fallback — see the header), refused when the directory it comes from is Claude Code's own
 * per-project state, `<config home>/projects/<dir>/…` (its `memory/`, its transcripts). No
 * user project lives there. An agent's Bash command that `cd`s into the memory directory to edit
 * `MEMORY.md` and runs `save` in the same command has no CLAUDE_PROJECT_DIR to fall back on, so
 * the row took its project from PWD: 4 lessons and a deferred item landed under
 * `-home-ai-dev-daagu--memory`, which no session's recall reads (R4,
 * docs/audits/20261124-r4-session-history-analysis.md §8.2). The config home itself is not
 * refused: a user can keep it in a repository and work there.
 *
 * @returns {{ok: true, project: string} | {ok: false, message: string}}
 */
export function cliWriteProject() {
  const dir = resolve(inferProjectDir());
  const state = resolve(claudeConfigDir(), 'projects');
  const rel = relative(state, dir);
  const inside = rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  if (!inside) return { ok: true, project: inferProject() };
  return {
    ok: false,
    message:
      `Not written: ${dir} is Claude Code's own per-project state (under ${state}), not a ` +
      `project, so the row would be filed under "${inferProject()}", where no session's recall ` +
      'reads it. Run the command from the project directory, or pass --project <name>.',
  };
}
