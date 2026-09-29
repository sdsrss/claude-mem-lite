// lib/local-steering.mjs — the steering block in <git top-level>/CLAUDE.local.md.
//
// Why this file exists (docs/audits/20260929-sandbox-usage-eval.md §8.5, tasks/specs/
// sandbox-eval-l3.md r3): auto-adopt used to write the block into CLAUDE.md, which swept the
// plugin's files into the user's next commit (4/4 sandbox repos). Injecting the same text as
// SessionStart context instead left the repository alone but lost most of what the block
// was for — proactive memory writes fell from 5.25 to 1.5 per trajectory (exact p=0.029) and
// subagents, which do not receive SessionStart context, saw it 0/12 times. CLAUDE.local.md
// is loaded by Claude Code with the same standing as CLAUDE.md (and reaches subagents: 12/12),
// and listed in the repository's info/exclude it never enters a commit or `git status`.
//
// Where it refuses to write, the caller falls back to injection:
//   - outside a git work tree (nothing can keep the file out of a commit, and a shared
//     directory such as /var/tmp would steer every project below it);
//   - a work tree whose top-level is $HOME or `/` (same ancestor problem, larger);
//   - a TRACKED CLAUDE.local.md (writing it would change the user's repository).
// Every git failure reads as "refuse": a missing file is the safe mistake here.

import { execFileSync } from 'child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'path';
import { readBlockAt, writeBlockAt, removeBlockAt, orphanResidueNote } from '../claudemd.mjs';
import { getDetailDoc } from '../adopt-content.mjs';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { resolveDataDir } from './resolve-data-dir.mjs';

export const LOCAL_MD = 'CLAUDE.local.md';

/**
 * The detail doc the block points at, kept in the plugin's data dir (never in the project:
 * both the injected and the CLAUDE.local.md block carry its absolute path). Rewritten only
 * when its text changed. Resolved at call time, not import time, so a caller that set
 * CLAUDE_MEM_DIR or HOME after loading this module still gets its own data dir.
 * @returns {string} absolute path
 */
export function ensureSteeringDetailDoc() {
  const p = join(resolveDataDir(process.env.CLAUDE_MEM_DIR), 'plugin_claude_mem_lite.md');
  const doc = getDetailDoc();
  let current = null;
  try {
    current = readFileSync(p, 'utf8');
  } catch {
    /* first run */
  }
  if (current !== doc) {
    mkdirSync(dirname(p), { recursive: true });
    atomicWriteFileSync(p, doc);
  }
  return p;
}
// The exclude entry is two lines — a comment naming its owner, then the pattern — because
// git ignore syntax has no trailing comments, and removal must touch only what we added.
const EXCLUDE_OWNER_LINE = '# claude-mem-lite: memory guidance for Claude Code, kept out of commits';

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
  } catch {
    return null;
  }
}

function gitOk(cwd, args) {
  try {
    execFileSync('git', args, {
      cwd,
      stdio: 'ignore',
      timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the local steering file belongs for `cwd`: its git top-level, or null when there is
 * none or it is $HOME or a filesystem root.
 * @param {string} cwd
 * @returns {string|null}
 */
export function localSteeringRoot(cwd) {
  if (!cwd || !existsSync(cwd)) return null;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const root = resolve(top);
  return isSharedAncestor(root) ? null : root;
}

/**
 * $HOME or a filesystem root: a CLAUDE.local.md there would steer every project below it.
 * @param {string} dir
 * @returns {boolean}
 */
export function isSharedAncestor(dir) {
  const d = realOrResolved(dir);
  return d === realOrResolved(homedir()) || d === parse(d).root;
}

// git reports the top-level by its real path, and $HOME may reach it through a symlink
// (`/home` -> `/var/home` layouts, a linked home): compare real paths (delta review P2-3).
function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Whether `npm pack` / `npm publish` at the root would ship CLAUDE.local.md: npm reads
 * .npmignore (or .gitignore) and the `files` list, never .git/info/exclude (pre-tag defect
 * review P1-1). Publishable = a root package.json without `"private": true`, whose `files`
 * list (if any) could include the file, and — without a `files` list — whose .npmignore does
 * not name it: a root .npmignore does not override `files` (npm docs; delta review P2-1).
 * Anything unreadable counts as publishable: writing into a package is the mistake to avoid.
 * @param {string} root
 * @returns {boolean}
 */
function npmPublishable(root) {
  const pj = join(root, 'package.json');
  if (!existsSync(pj)) return false;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pj, 'utf8'));
  } catch {
    return true;
  }
  if (pkg && pkg.private === true) return false;
  if (Array.isArray(pkg?.files)) return pkg.files.some(filesEntryCouldShipRootFile);
  try {
    const ignore = readFileSync(join(root, '.npmignore'), 'utf8');
    if (/^\s*\/?CLAUDE\.local\.md\s*$/m.test(ignore)) return false;
  } catch {
    /* no .npmignore */
  }
  return true;
}

// Could this `files` entry take in a file at the package root? Literal entries match by name;
// any glob whose FIRST path segment is a pattern can reach the root (`**/*.md`, `*.*`, `C*`,
// `{lib,*.md}`, `/*`), while `dist/**/*.js` stays under dist/. Anything naming CLAUDE, a `..`
// segment, or the package itself (``, `.`, `/`, `./`) counts. Checked against `npm pack
// --dry-run` (npm 11.19.0): every entry that shipped the file is caught here. A negation never
// adds a file; it is not trusted to remove one either (the other entries decide).
function filesEntryCouldShipRootFile(f) {
  const e = String(f).trim();
  if (e.startsWith('!')) return false;
  const rel = e.replace(/^(\.?\/)+/, '');
  if (rel === '' || rel === '.' || /claude/i.test(rel) || rel.split('/').includes('..')) return true;
  return /[*?[{]/.test(rel.split('/')[0]);
}

/** @returns {string} */
export function localMdPath(root) {
  return join(root, LOCAL_MD);
}

/**
 * @returns {{ exists: boolean, version: string|null, body: string|null, raw: string }}
 */
export function readLocalSteering(root, slug) {
  return readBlockAt(localMdPath(root), slug);
}

function excludePath(root) {
  const p = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!p) return null;
  return isAbsolute(p) ? p : join(root, p);
}

function ensureExcluded(root) {
  if (gitOk(root, ['check-ignore', '-q', '--', LOCAL_MD])) return 'already';
  const p = excludePath(root);
  if (!p) return 'failed';
  let cur;
  try {
    cur = existsSync(p) ? readFileSync(p, 'utf8') : null;
    const text = cur ?? '';
    const sep = text === '' || text.endsWith('\n') ? '' : '\n';
    appendFileSync(p, `${sep}${EXCLUDE_OWNER_LINE}\n${LOCAL_MD}\n`);
  } catch {
    return 'failed';
  }
  if (gitOk(root, ['check-ignore', '-q', '--', LOCAL_MD])) return 'added';
  // A rule elsewhere (a `!CLAUDE.local.md` in .gitignore) wins over info/exclude: the entry
  // did nothing, so put the file back as it was rather than leave a useless line behind.
  try {
    if (cur === null) rmSync(p, { force: true });
    else writeFileSync(p, cur);
  } catch {
    /* best-effort */
  }
  return 'failed';
}

// Other work trees of the same repository share one info/exclude (it lives in the common git
// dir), so an entry is only ours to remove when no other work tree still has the block.
function otherWorktreeHasBlock(root, slug) {
  const out = git(root, ['worktree', 'list', '--porcelain']);
  if (!out) return false;
  const self = resolve(root);
  for (const line of out.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const wt = resolve(line.slice('worktree '.length));
    if (wt === self) continue;
    if (readBlockAt(join(wt, LOCAL_MD), slug).body !== null) return true;
  }
  return false;
}

function removeExcluded(root, slug) {
  if (otherWorktreeHasBlock(root, slug)) return 'shared';
  const p = excludePath(root);
  if (!p || !existsSync(p)) return 'absent';
  try {
    const cur = readFileSync(p, 'utf8');
    const next = cur.split(`${EXCLUDE_OWNER_LINE}\n${LOCAL_MD}\n`).join('');
    if (next === cur) return 'absent';
    writeFileSync(p, next);
    return 'removed';
  } catch {
    return 'failed';
  }
}

/**
 * `p` with the home directory written as `~`. The block lands in a file on disk that
 * packagers which ignore info/exclude (`npm pack`, a docker build context) can pick up, so it
 * must not carry the user's home path.
 * @param {string} p
 * @returns {string}
 */
export function tildePath(p) {
  const h = resolve(homedir());
  return p === h ? '~' : p.startsWith(h + sep) ? `~${p.slice(h.length)}` : p;
}

// Per-repository memory of "this plugin created CLAUDE.local.md here", kept in the
// repository's own git dir (invisible to git, gone with the clone). Without it the plugin
// cannot tell a file it never wrote from one the user deleted or `unadopt` removed, and wrote
// the file straight back on the next session (pre-tag claims review P1-2/P1-3).
function stateFile(root) {
  const p = git(root, ['rev-parse', '--git-path', 'claude-mem-lite-local-steering.json']);
  if (!p) return null;
  return isAbsolute(p) ? p : join(root, p);
}

function readState(root) {
  const p = stateFile(root);
  if (!p || !existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { created: 'unknown' };
  }
}

/**
 * Forget that the block was created here, so the next session writes it again
 * (`adopt --enable`).
 * @returns {boolean} whether there was anything to forget
 */
export function forgetLocalSteering(root) {
  const p = stateFile(root);
  if (!p || !existsSync(p)) return false;
  try {
    rmSync(p, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Insert or refresh the block in CLAUDE.local.md and keep the file out of commits.
 * `refused` means nothing was written; the caller injects the steering instead, unless
 * `present` says the file it refused to write already carries the block (a tracked file, or
 * one behind a link), which the host loads anyway. A block this plugin created before and
 * that is gone now was removed by the user or by `unadopt`: it is not written back (reason
 * `removed`) until `adopt --enable` forgets it. `frozen` (CLAUDE_MEM_NO_TEMPLATE_REFRESH=1)
 * leaves a block that is there as it is — after the same refusals, so a root that has since
 * become an npm package still loses it.
 * @param {string} root from localSteeringRoot
 * @returns {{action: 'created'|'updated'|'unchanged'|'refused', reason?: string, present?: boolean}}
 */
export function writeLocalSteering(root, { slug, version, block, frozen = false }) {
  const p = localMdPath(root);
  // Read through a link on purpose: this is what the host loads.
  const present = readBlockAt(p, slug).body !== null;
  if (gitOk(root, ['ls-files', '--error-unmatch', '--', LOCAL_MD]))
    return { action: 'refused', reason: 'tracked', present };
  // A link would carry the block into whatever file it points at — possibly one another
  // repository tracks (pre-tag defect review P2-2).
  try {
    if (lstatSync(p).isSymbolicLink()) return { action: 'refused', reason: 'symlink', present };
  } catch {
    /* absent */
  }
  if (npmPublishable(root)) {
    // The root became a package after the block was written (`git init`, a session, then
    // `npm init`): npm would ship it (delta review P1-1). Take it out, and forget having
    // created it — the user did not remove it, so it comes back if the package goes private.
    if (present) {
      removeLocalSteering(root, slug);
      forgetLocalSteering(root);
    }
    return { action: 'refused', reason: 'npm-publishable' };
  }
  if (!present && readState(root)) return { action: 'refused', reason: 'removed' };
  if (present && frozen) {
    // Nothing else would re-add an entry the user or another worktree's removal took out.
    ensureExcluded(root);
    return { action: 'unchanged' };
  }
  // Exclude first: a file that cannot be kept out of `git status` is not written at all.
  const excluded = ensureExcluded(root);
  if (excluded === 'failed') return { action: 'refused', reason: 'exclude-failed' };
  const fileExisted = existsSync(p);
  let r;
  try {
    r = writeBlockAt(p, { slug, version, block });
  } catch {
    return { action: 'refused', reason: 'write-failed' };
  }
  if (r.action === 'created') {
    try {
      const sp = stateFile(root);
      if (sp) {
        mkdirSync(dirname(sp), { recursive: true });
        writeFileSync(
          sp,
          JSON.stringify({ created: new Date().toISOString(), createdFile: !fileExisted }) + '\n',
        );
      }
    } catch {
      /* best-effort: without it a removal is not remembered, which is the old behaviour */
    }
  }
  return r;
}

/**
 * Remove the block (deleting a file left empty) and the exclude lines this module added.
 * A symlinked CLAUDE.local.md is left alone (`skipped-symlink`).
 * @returns {{action: 'removed'|'absent'|'skipped-symlink', residue?: string}}
 */
export function removeLocalSteering(root, slug) {
  const p = localMdPath(root);
  // Never through a link (delta review P2-4): the plugin never writes through one, and the
  // file at the other end can be another repository's, tracked there.
  try {
    if (lstatSync(p).isSymbolicLink()) return { action: 'skipped-symlink' };
  } catch {
    /* absent */
  }
  // `createdFile: false` = the block went into a file the user already had. Unknown (a state
  // written before the field existed, or unreadable) counts as the plugin's file: keeping notes
  // out of `git status` is the safe side.
  const state = readState(root);
  const ownFile = state !== null && state.createdFile !== false;
  const { action, orphans } = removeBlockAt(p, slug);
  // The exclude entry goes with the file. A file the plugin created that outlives its block
  // holds the user's own notes, and dropping the entry would put them in `git status` (delta
  // review P2-5); a file the user had before goes back to how git saw it.
  if (!existsSync(p) || (action === 'removed' && !ownFile)) removeExcluded(root, slug);
  if (orphans > 0 && action === 'removed') return { action, residue: orphanResidueNote(orphans, slug, p) };
  return { action };
}
