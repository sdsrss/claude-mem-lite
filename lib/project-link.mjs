// Leaf (node: imports only): whether the plugin may write a project file reached through a link.
//
// A cloned repository can commit links, and the plugin writes into the project it is opened in:
// with `.claude -> ../../somewhere` committed, adopt and the SessionStart sync wrote their two files
// into a directory the repository picked, unadopt deleted them there, and a CLAUDE.md committed as a
// link had its outside target rewritten (D#880; v6.35.3 pre-tag round 2, F1). A link the user made
// is theirs to point anywhere — a dotfiles-managed CLAUDE.md or `.claude`, a worktree sharing the
// main checkout's — and git tells the two apart: it lists the user's link as untracked (or tracked
// with another mode), and the repository's as a staged symlink (mode 120000).
import { lstatSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

/**
 * Why the plugin must not write `rel` under `root` through the links on its way, or null when it
 * may. Each link on the path, nearest the project first:
 * - git shows the user made it: the rest of the path is theirs, so null;
 * - it is the file itself and `whole` is set (the plugin replaces or deletes that file whole): refused
 *   wherever it points, since one inside the repository can name the user's own untracked file;
 * - otherwise it must resolve inside the project (the git top-level, else `root`) and not into a
 *   `.git` directory.
 * No link on the path costs one lstat per component and no git.
 * @param {string} root the project directory
 * @param {string} rel '/'-separated path below it
 * @param {{whole?: boolean}} [opts]
 * @returns {{link: string, why: string}|null}
 */
export function linkRefusal(root, rel, { whole = false } = {}) {
  const parts = rel.split('/');
  let top;
  for (let i = 0; i < parts.length; i++) {
    const lex = join(root, ...parts.slice(0, i + 1));
    let st;
    try {
      st = lstatSync(lex);
    } catch {
      return null; // absent: nothing below it exists to write through
    }
    if (!st.isSymbolicLink()) continue;
    const made = userMade(root, lex);
    if (made) return null;
    const notYours =
      made === false
        ? 'a link this repository commits'
        : 'a link git does not show as one you made (a cloned repository or an archive can carry one)';
    if (whole && i === parts.length - 1)
      return {
        link: lex,
        why: `${notYours}, and the plugin writes this file whole; not written through. Delete the link, then run adopt again.`,
      };
    let target = null;
    try {
      target = realpathSync(lex);
    } catch {
      /* dangling: where a write would land is unknown */
    }
    if (target !== null && within(root, target)) continue;
    if (target !== null && top === undefined) top = gitTop(root);
    if (target !== null && top && within(top, target)) continue;
    return {
      link: lex,
      why: `${notYours}, to ${target ?? 'a path that does not resolve'}, outside this project; not written through. Replace the link with what it points to, then run adopt again.`,
    };
  }
  return null;
}

/** `${link}: ${why}` — the refusal as one line. */
export function refusalText(r) {
  return `${r.link}: ${r.why}`;
}

// Inside `dir` by real path, and not inside a `.git` directory (a link into one reaches git's own
// config and hooks).
function within(dir, target) {
  let base;
  try {
    base = realpathSync(dir);
  } catch {
    return false;
  }
  const r = relative(base, target);
  if (r === '') return true;
  if (isAbsolute(r)) return false;
  const segs = r.split(sep);
  return segs[0] !== '..' && !segs.includes('.git');
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' },
  });
}

function gitTop(root) {
  try {
    return git(root, ['rev-parse', '--show-toplevel']).trim() || null;
  } catch {
    return null;
  }
}

// true: git lists the link as untracked, or as tracked with another mode (the user replaced a file);
// false: as a staged symlink, i.e. the repository's; null: git does not list it (not a work tree, no
// git, a path inside a submodule). Asked by its real directory, so a path below a link the
// repository put inside the project is still a path git knows.
function userMade(root, lex) {
  let here;
  try {
    here = join(realpathSync(dirname(lex)), basename(lex));
  } catch {
    return null;
  }
  let out;
  try {
    out = git(root, ['ls-files', '-z', '-s', '-o', '--', here]);
  } catch {
    return null;
  }
  let staged = null;
  for (const entry of out.split('\0')) {
    if (entry === '') continue;
    const m = /^(\d{6}) [0-9a-f]+ \d\t/.exec(entry);
    if (!m) return true;
    if (m[1] !== '120000') return true;
    staged = false;
  }
  return staged;
}
