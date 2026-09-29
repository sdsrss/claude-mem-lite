// lib/git-state.mjs — thin wrapper around git status/stash/HEAD sha (T10b).
// Used by startup-dashboard (T10c) and continuation-anchor detection (T10d).
// All calls are timeout-bounded; any failure yields empty fields, never throws.

import { execFileSync } from 'child_process';
import { isOwnAdoptionArtifact } from '../claudemd.mjs';
import { PLUGIN_SLUG } from '../adopt-content.mjs';

const GIT_TIMEOUT_MS = 1500;

// Strip inherited GIT_* env so child `git` operates on the requested `cwd`
// rather than a parent process's repo. Required when readGitState is called
// from contexts where GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/GIT_PREFIX leak in:
// pre-commit hooks running tests, hooks invoked under `git commit`, etc.
// Without this, headSha and `changed` reflect the parent's repo, not cwd's.
function buildCleanEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_PREFIX;
  return env;
}

function run(cmd, args, { cwd } = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      env: buildCleanEnv(),
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      // Suppress git's own stderr noise (e.g. "fatal: not a git repository").
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Return a compact snapshot of git state. Safe on non-git directories.
 *
 * @param {object} [options]
 * @param {string} [options.cwd=process.cwd()]
 * @returns {{changed: string[], stashes: string[], branch: string|null, headSha: string|null}}
 */
export function readGitState({ cwd = process.cwd() } = {}) {
  const statusOut = run('git', ['status', '--porcelain'], { cwd });
  // The plugin's own untracked adoption files (CLAUDE.md holding only the managed block, the
  // `.claude/` detail doc) are not the user's uncommitted work — see isOwnAdoptionArtifact.
  const changed = statusOut
    ? statusOut
        .split('\n')
        .filter(Boolean)
        .filter((l) => !(l.startsWith('?? ') && isOwnAdoptionArtifact(cwd, l.slice(3), PLUGIN_SLUG)))
    : [];
  const stashOut = run('git', ['stash', 'list'], { cwd });
  const stashes = stashOut ? stashOut.split('\n').filter(Boolean) : [];
  // `symbolic-ref`, not `rev-parse --abbrev-ref`: the latter returns the literal string
  // "HEAD" on a detached head, which the handoff's tree-state line then rendered as
  // `branch HEAD`. Failing to null is the honest answer — there is no branch.
  const branch = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd }) || null;
  const headSha = run('git', ['rev-parse', 'HEAD'], { cwd }) || null;
  return { changed, stashes, branch, headSha };
}
