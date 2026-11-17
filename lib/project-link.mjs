// Leaf (node: imports only): whether the plugin may write a project file reached through a link.
//
// A cloned repository can commit links, and the plugin writes into the project it is opened in:
// with `.claude -> ../../somewhere` committed, adopt and the SessionStart sync wrote their two files
// into a directory the repository picked, unadopt deleted them there, and a CLAUDE.md committed as a
// link had its outside target rewritten (D#880; v6.35.3 pre-tag round 2, F1). A link the user made
// at `.claude` or CLAUDE.md — a dotfiles-managed one, a worktree sharing the main checkout's — is
// theirs to point anywhere, and git lists it as untracked where it lists a committed one as a staged
// symlink. git cannot tell the user's from one an unpacked archive left in a work tree (untracked
// too): a link at either file the plugin rewrites whole is never written through, as before
// (v6.35.4 pre-tag round 1, F1).
import { lstatSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

/**
 * Why the plugin must not write `rel` under `root` through the links on its way, or null when it
 * may. Each link on the path, nearest the project first:
 * - the file itself, when `whole` is set (the plugin replaces or deletes that file whole): refused,
 *   whoever made it;
 * - git lists it as untracked: written through;
 * - otherwise it must resolve inside the project (the git top-level, else `root`) and not into a
 *   `.git` directory, in any letter case.
 * No link on the path costs one lstat per component and no git.
 * `kind`: 'whole', 'committed' (git lists the path as tracked: a committed link, or a committed file
 * the link replaced) or 'unknown' (git does not list it: no work tree, git missing or refusing, a path
 * git tracks only under another letter case).
 * @param {string} root the project directory
 * @param {string} rel '/'-separated path below it
 * @param {{whole?: boolean}} [opts]
 * @returns {{link: string, why: string, kind: 'whole'|'committed'|'unknown'}|null}
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
    if (whole && i === parts.length - 1)
      return {
        link: lex,
        kind: 'whole',
        why: 'a link, and the plugin rewrites this file whole: git cannot tell a link you made here from one a repository or an unpacked archive put there',
      };
    const made = userMade(root, lex);
    if (made) continue;
    let target = null;
    try {
      target = realpathSync(lex);
    } catch {
      /* dangling: where a write would land is unknown */
    }
    let where = target === null ? 'out' : place(root, target);
    if (where === 'out' && target !== null) {
      if (top === undefined) top = gitTop(root);
      if (top) where = place(top, target);
    }
    if (where === 'in') continue;
    const who =
      made === false
        ? 'a link this repository commits'
        : 'a link git does not list as one you made (outside a git work tree, or git did not answer)';
    const to =
      target === null
        ? 'to a path that does not resolve'
        : `to ${target}, ${where === 'git' ? 'inside a .git directory' : 'outside this project'}`;
    return { link: lex, kind: made === false ? 'committed' : 'unknown', why: `${who}, ${to}` };
  }
  return null;
}

/** The refusal as adopt reports it: what the link is, then what to do. */
export function refusalText(r) {
  const next =
    r.kind === 'unknown'
      ? 'if you made the link, adopt in a git work tree, where git lists it as untracked; otherwise delete it, then run adopt again'
      : 'delete the link, then run adopt again';
  return `${r.link}: ${r.why}. Not written through; ${next}.`;
}

// 'in': inside `dir` by real path; 'git': inside a `.git` directory below it (a link into one
// reaches git's own config and hooks; any letter case, for case-insensitive file systems); 'out'.
function place(dir, target) {
  let base;
  try {
    base = realpathSync(dir);
  } catch {
    return 'out';
  }
  const r = relative(base, target);
  if (r === '') return 'in';
  if (isAbsolute(r)) return 'out';
  const segs = r.split(sep);
  if (segs[0] === '..') return 'out';
  return segs.some((s) => s.toLowerCase() === '.git') ? 'git' : 'in';
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

// true: git lists the link as untracked; false: as a tracked path (a committed link, or a committed
// file the link replaced, which is also what a case-insensitive checkout of `CLAUDE.md` beside a
// committed `claude.md` link leaves — v6.35.4 pre-tag round 1, F3); null: git does not list it (not a
// work tree, no git or git refusing, a path git tracks only under another letter case).
// Asked by its real directory, so a path below a link inside the project is still one git knows.
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
  let made = null;
  for (const entry of out.split('\0')) {
    if (entry === '') continue;
    if (!/^\d{6} [0-9a-f]+ \d\t/.test(entry)) return true;
    made = false;
  }
  return made;
}
