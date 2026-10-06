// lib/local-steering.mjs — the steering block in <git top-level>/CLAUDE.local.md.
//
// Why this file exists (docs/audits/20260929-sandbox-usage-eval.md §8.5, tasks/specs/
// sandbox-eval-l3.md r3): auto-adopt used to write the block into CLAUDE.md, which swept the
// plugin's files into the user's next commit (4/4 sandbox repos). Injecting the same text as
// SessionStart context instead left the repository alone but lost most of what the block
// was for — proactive memory writes fell from 5.25 to 1.5 per trajectory (exact p=0.029) and
// subagents, which do not receive SessionStart context, saw it 0/12 times. CLAUDE.local.md
// is loaded by Claude Code with the same standing as CLAUDE.md, and listed in the
// repository's info/exclude it never enters a commit or `git status`. It reaches the
// subagents that load project instructions (12/12 in the eval's delegated read-and-edit
// tasks); the built-in Explore and Plan agents load no CLAUDE.md-family file at all.
//
// Where it refuses to write, the caller falls back to injection:
//   - outside a git work tree (nothing can keep the file out of a commit, and a shared
//     directory such as /var/tmp would steer every project below it);
//   - a work tree whose top-level is $HOME or `/` (same ancestor problem, larger);
//   - a TRACKED CLAUDE.local.md (writing it would change the user's repository).
// Every git failure reads as "refuse": a missing file is the safe mistake here.
//
// D#212 (tasks/specs/d212-rules-steering.md): a CLAUDE.local.md switches off an AGENTS.md Claude
// Code reads as the project's instructions (shadowedAgentsMd). There the block goes to
// <top-level>/.claude/rules/claude-mem-lite.md instead, excluded from git the same way: a rules
// file leaves AGENTS.md loading, and it reaches the main session and delegated subagents as
// project instructions (probe 2026-10-06, Claude Code 2.1.291; rules load since 2.0.64, AGENTS.md
// is read since 2.1.277). Once written it stays the channel. Its own refusals are below
// (writeRulesSteering); where it is refused too, the steering is injected.

import { execFileSync } from 'child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'path';
import {
  readBlockAt,
  writeBlockAt,
  removeBlockAt,
  orphanResidueNote,
  holdsOnlyOwnLines,
} from '../claudemd.mjs';
import { getDetailDoc } from '../adopt-content.mjs';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { claudeConfigDir } from './data-paths.mjs';
import { resolveDataDir } from './resolve-data-dir.mjs';

export const LOCAL_MD = 'CLAUDE.local.md';
/** The rules file used where CLAUDE.local.md would switch AGENTS.md off, relative to the top-level. */
export const RULES_MD = '.claude/rules/claude-mem-lite.md';

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

/**
 * Whether two paths name the same directory: git reports the top-level by its real path while the
 * session's directory may reach it through a symlink (pre-tag delta review of the D#212 repairs,
 * D1), or by another spelling on a case-insensitive disk, where realpath keeps the spelling it is
 * given (round-3 review, R3-11). Compared by device and inode; a path that cannot be stat'ed, by
 * its real path.
 * @returns {boolean}
 */
export function samePath(a, b) {
  try {
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    if (x.ino !== 0n) return x.dev === y.dev && x.ino === y.ino;
  } catch {
    /* compared by spelling below */
  }
  return realOrResolved(a) === realOrResolved(b);
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

/**
 * Whether `npm pack` / `npm publish` at the root would ship RULES_MD. Measured with
 * `npm pack --dry-run` (npm 11.19.0, 2026-10-06): a `files` entry takes it in when its first
 * segment is `.claude` or a wildcard (`*`, or `**` then a path); entries are anchored at the
 * root, so `rules`, `*.md` and a glob under `src/` did not. Without `files`, npm reads .npmignore, or .gitignore
 * when there is no .npmignore, never info/exclude. Only a literal line naming `.claude`,
 * `.claude/rules` or the file counts as ignoring it, and any negation mentioning `.claude` undoes
 * that (npm shipped the file for `.claude/` + `!.claude/rules/claude-mem-lite.md`, which git keeps
 * ignored); anything unreadable counts as shipping, like npmPublishable.
 * @param {string} root
 * @returns {boolean}
 */
function npmShipsRules(root) {
  const pj = join(root, 'package.json');
  if (!existsSync(pj)) return false;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pj, 'utf8'));
  } catch {
    return true;
  }
  if (pkg && pkg.private === true) return false;
  if (Array.isArray(pkg?.files)) return pkg.files.some(filesEntryCouldShipRules);
  // npm reads ignore files in subdirectories too: one under .claude/ can re-include the file
  // (pre-tag delta review of the D#212 repairs, D4). Not parsed — present means "could ship".
  for (const nested of [
    '.claude/.npmignore',
    '.claude/.gitignore',
    '.claude/rules/.npmignore',
    '.claude/rules/.gitignore',
  ])
    if (existsSync(join(root, nested))) return true;
  const ignoreFile = existsSync(join(root, '.npmignore')) ? '.npmignore' : '.gitignore';
  let lines;
  try {
    lines = readFileSync(join(root, ignoreFile), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim());
  } catch {
    return true;
  }
  if (lines.some((l) => l.startsWith('!') && negationCouldMatchRules(l.slice(1)))) return true;
  return !lines.some((l) => {
    const path = l.replace(/^\/+/, '');
    return path === RULES_MD || ['.claude', '.claude/rules'].includes(path.replace(/\/$/, ''));
  });
}

// npm does not follow git's "a file under an excluded directory cannot be re-included" (it shipped
// the file for `.claude/` + `!.claude/rules/claude-mem-lite.md`), and it compares names without
// regard to case. A negation is harmless only when it is a literal naming none of the file's path
// parts (`!.env.example`); a pattern, or a name like `rules` or `.Claude`, may re-include it (pre-tag
// defect review of D#212, P1-3: `!**/*.md`, `!**`, `!*.md`, `!.Claude/...` all shipped it).
function negationCouldMatchRules(pattern) {
  const p = pattern.trim();
  // npm's matcher has extglob on: `@(…)`, `+(…)`, `!(…)` are patterns too (delta D4).
  if (/[*?[{\\()@+!]/.test(p)) return true;
  const parts = RULES_MD.toLowerCase().split('/');
  return p
    .toLowerCase()
    .split('/')
    .filter(Boolean)
    .some((seg) => parts.includes(seg));
}

function filesEntryCouldShipRules(f) {
  const e = String(f).trim();
  if (e.startsWith('!')) return false;
  const rel = e.replace(/^(\.?\/)+/, '');
  const segs = rel.split('/');
  if (rel === '' || rel === '.' || segs.includes('..')) return true;
  return segs[0] === '.claude' || /[*?[{\\()@+!]/.test(segs[0]);
}

// code.claude.com/docs/en/memory#agents-md (Claude Code v2.1.277+): with the default
// `instructionFiles` value, AGENTS.md is read only while no CLAUDE.md, .claude/CLAUDE.md or
// CLAUDE.local.md exists in the session's directory or above it, so a CLAUDE.local.md at the
// root switches off every AGENTS.md a session in the tree would read — unseen, from the second
// session on (reproduced on 2.1.291, tests/local-steering.test.mjs). The other three values
// read AGENTS.md beside CLAUDE.local.md, or never. The entry is honoured in the user settings
// only, under either id (`agents-md@builtin` before v2.1.285).
const AGENTS_MD_PLUGIN_IDS = ['cc-plugin-agents-md@builtin', 'agents-md@builtin'];
const AGENTS_MD_UNAFFECTED = new Set(['claude-md-and-agents-md', 'claude-md', 'managed-only']);

/**
 * The AGENTS.md a CLAUDE.local.md at `root` would switch off, or null. Looks in `cwd` and every
 * directory above it for AGENTS.md and .claude/AGENTS.md (what Claude Code reads at startup),
 * then among the AGENTS.md files git tracks anywhere in the tree (read as Claude works in that
 * subdirectory, or at the start of a session there). None counts when the root holds the user's
 * own CLAUDE.md or .claude/CLAUDE.md, which switched them off for every session in the tree
 * already, or when the user settings pick a value that reads AGENTS.md anyway. An untracked
 * AGENTS.md in a subdirectory is seen only from a session started at or below it.
 * @param {string} root from localSteeringRoot
 * @param {string} [cwd] the session's directory, at or below `root`
 * @returns {string|null}
 */
export function shadowedAgentsMd(root, cwd = root) {
  if (existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, '.claude', 'CLAUDE.md'))) return null;
  const found = agentsMdAtOrAbove(cwd) ?? trackedAgentsMd(root);
  if (!found) return null;
  return AGENTS_MD_UNAFFECTED.has(userInstructionFiles()) ? null : found;
}

function agentsMdAtOrAbove(cwd) {
  return agentsMdFilesAtOrAbove(cwd)[0] ?? null;
}

function agentsMdFilesAtOrAbove(start) {
  const found = [];
  for (let d = resolve(start); ;) {
    for (const p of [join(d, 'AGENTS.md'), join(d, '.claude', 'AGENTS.md')]) if (existsSync(p)) found.push(p);
    const up = dirname(d);
    if (up === d) return found;
    d = up;
  }
}

function trackedAgentsMd(root) {
  return trackedAgentsMdFiles(root)[0] ?? null;
}

// The AGENTS.md files git tracks in `dir` and below that are on disk, absolute. A git failure
// reads as "none found": the next session looks again.
function trackedAgentsMdFiles(dir) {
  const out = git(dir, ['ls-files', '-z', '--', ':(glob)**/AGENTS.md']);
  if (!out) return [];
  return out
    .split('\0')
    .filter((rel) => rel && existsSync(join(dir, rel)))
    .map((rel) => join(dir, rel));
}

/**
 * What a CLAUDE.md adopt writes in `dir` would switch off, or null when it switches nothing off:
 * a CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md of the user's is in `dir` or above it already
 * (`~/.claude/CLAUDE.md`, user memory, does not count), the user settings pick a value that
 * reads AGENTS.md anyway or never, or no AGENTS.md is read here. A CLAUDE.md or CLAUDE.local.md
 * holding nothing but this plugin's lines is not the user's: adopt rewrites the one and removes
 * the other. `imports`: the AGENTS.md files in `dir` itself, as the `@` paths the new file
 * imports to keep them loading. `elsewhere`: the ones it cannot import that way — above `dir`
 * (outside the working directory, so Claude Code would ask to approve the import) or tracked
 * below it (read only when Claude works there; an import would load it in every session).
 * @param {string} dir where CLAUDE.md is written
 * @param {string} slug
 * @returns {{imports: string[], elsewhere: string[]}|null}
 */
export function agentsMdForNewClaudeMd(dir, slug) {
  const d = resolve(dir);
  if (instructionFileAtOrAbove(d, slug)) return null;
  const beside = ['AGENTS.md', '.claude/AGENTS.md'].filter((rel) => existsSync(join(d, rel)));
  // At $HOME or `/` an import would reach every project below, each asking to approve an import from
  // outside its directory (pre-tag delta review of the D#212 repairs, D8): named, not imported.
  const shared = isSharedAncestor(d);
  const imports = shared ? [] : beside;
  const below = trackedAgentsMdFiles(d).filter((p) => !imports.some((rel) => p === join(d, rel)));
  // A $HOME that git tracks AGENTS.md in lists it as beside and as tracked: named once (R3-15).
  const elsewhere = [
    ...new Set([
      ...(shared ? beside.map((rel) => join(d, rel)) : []),
      ...(dirname(d) === d ? [] : agentsMdFilesAtOrAbove(dirname(d))),
      ...below,
    ]),
  ];
  if (imports.length === 0 && elsewhere.length === 0) return null;
  return AGENTS_MD_UNAFFECTED.has(userInstructionFiles()) ? null : { imports, elsewhere };
}

function instructionFileAtOrAbove(start, slug) {
  const home = realOrResolved(homedir());
  const usersFile = (p) => existsSync(p) && !holdsOnlyOwnLines(p, slug);
  for (let d = start; ;) {
    if (usersFile(join(d, 'CLAUDE.md')) || usersFile(join(d, LOCAL_MD))) return true;
    if (realOrResolved(d) !== home && existsSync(join(d, '.claude', 'CLAUDE.md'))) return true;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
}

// Absent or unparseable settings, or no entry, read as the default (null).
function userInstructionFiles() {
  try {
    const s = JSON.parse(readFileSync(join(claudeConfigDir(), 'settings.json'), 'utf8'));
    for (const id of AGENTS_MD_PLUGIN_IDS) {
      const v = s?.pluginConfigs?.[id]?.options?.instructionFiles;
      if (typeof v === 'string') return v;
    }
  } catch {
    /* the default */
  }
  return null;
}

/** @returns {string} */
export function localMdPath(root) {
  return join(root, LOCAL_MD);
}

/** @returns {string} */
export function rulesMdPath(root) {
  return join(root, RULES_MD);
}

// readBlockAt for a path that may be a directory or unreadable (pre-tag defect review of D#212,
// P3-8): there is no block of ours there, and the rules file is refused as foreign rather than the
// read throwing out of the sync and leaving the session with no guidance at all.
function readBlockSafe(p, slug) {
  try {
    return readBlockAt(p, slug);
  } catch (e) {
    return { exists: true, version: null, body: null, raw: '', unreadable: true, code: e?.code };
  }
}

/**
 * The block of whichever local file carries it (the rules file first: only one should), and that
 * file's path; with neither, CLAUDE.local.md's reading.
 * @returns {{ exists: boolean, version: string|null, body: string|null, raw: string, path: string }}
 */
export function readLocalSteering(root, slug) {
  const rules = readBlockSafe(rulesMdPath(root), slug);
  if (rules.body !== null) return { ...rules, path: rulesMdPath(root) };
  // Safe: `adopt --status`, `unadopt --dry-run` and the `--all` sweep crashed on a directory there
  // (round-3 review, R3-7).
  return { ...readBlockSafe(localMdPath(root), slug), path: localMdPath(root) };
}

/**
 * Whether the rules file, `.claude/rules` or `.claude` is a symbolic link. Writing through one
 * would put the block wherever it points — a dotfiles checkout shared by every project, or another
 * repository — and Claude Code treats a link out of the project as an external import.
 * @param {string} root
 * @returns {boolean}
 */
function symlinkOnRulesPath(root) {
  for (const rel of ['.claude', '.claude/rules', RULES_MD]) {
    try {
      if (lstatSync(join(root, rel)).isSymbolicLink()) return true;
    } catch {
      /* absent: nothing below it exists either */
      return false;
    }
  }
  return false;
}

function excludePath(root) {
  const p = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!p) return null;
  return isAbsolute(p) ? p : join(root, p);
}

// Our two exclude lines for `rel`, as a pattern that also matches them saved with CRLF endings.
function ownExcludeRe(rel) {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${esc(EXCLUDE_OWNER_LINE)}\\r?\\n${esc(rel)}\\r?\\n`, 'g');
}

// CLAUDE.local.md: no entry where the user's own rules already ignore it (6.20.0 behaviour). The
// rules file always gets its own (pre-tag defect review of D#212, P2-4): written under a
// `.gitignore` that covered `.claude/`, it showed up in `git status` the moment the user narrowed
// that rule to share the rest of `.claude/`.
function ensureExcluded(root, rel = LOCAL_MD) {
  const p = excludePath(root);
  if (rel === RULES_MD) {
    let have = false;
    try {
      have = p !== null && existsSync(p) && ownExcludeRe(rel).test(readFileSync(p, 'latin1'));
    } catch {
      /* unreadable: append below, or fail there */
    }
    if (have) return gitOk(root, ['check-ignore', '-q', '--', rel]) ? 'already' : 'failed';
  } else if (gitOk(root, ['check-ignore', '-q', '--', rel])) return 'already';
  if (!p) return 'failed';
  let cur;
  try {
    cur = existsSync(p) ? readFileSync(p, 'latin1') : null;
    const text = cur ?? '';
    const sep = text === '' || text.endsWith('\n') ? '' : '\n';
    // A repository made without the template (`git init --template=`) has no info/ (delta D3).
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${sep}${EXCLUDE_OWNER_LINE}\n${rel}\n`);
  } catch {
    return 'failed';
  }
  if (gitOk(root, ['check-ignore', '-q', '--', rel])) return 'added';
  // A rule elsewhere (a `!CLAUDE.local.md` in .gitignore) wins over info/exclude: the entry
  // did nothing, so put the file back as it was rather than leave a useless line behind.
  try {
    if (cur === null) rmSync(p, { force: true });
    else writeFileSync(p, cur, 'latin1');
  } catch {
    /* best-effort */
  }
  return 'failed';
}

// Other work trees of the same repository share one info/exclude (it lives in the common git
// dir), so an entry is only ours to remove when no other work tree still has the block.
function otherWorktreeHasBlock(root, slug, rel) {
  const out = git(root, ['worktree', 'list', '--porcelain']);
  if (!out) return false;
  const self = resolve(root);
  for (const line of out.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const wt = resolve(line.slice('worktree '.length));
    if (wt === self) continue;
    if (readBlockSafe(join(wt, rel), slug).body !== null) return true;
  }
  return false;
}

function removeExcluded(root, slug, rel = LOCAL_MD) {
  if (otherWorktreeHasBlock(root, slug, rel)) return 'shared';
  const p = excludePath(root);
  if (!p || !existsSync(p)) return 'absent';
  try {
    // Latin-1 both ways, so bytes that are not UTF-8 (a Latin-1 file name) come back as they were
    // instead of as U+FFFD, which matches nothing (round-3 review, R3-8).
    const cur = readFileSync(p, 'latin1');
    const next = cur.replace(ownExcludeRe(rel), '');
    if (next === cur) return 'absent';
    writeFileSync(p, next, 'latin1');
    return 'removed';
  } catch {
    return 'failed';
  }
}

/**
 * Whether an info/exclude entry for `rel` would leave git still seeing it, read without writing:
 * the last pattern that matches it is a negation in a .gitignore, which outranks info/exclude
 * (pre-tag delta review of the D#212 repairs, D3). `adopt --status` and the notes use it so they
 * do not promise a file the next session cannot keep out of git. A git failure reads as "would
 * fail": promising nothing is the safe mistake.
 * @returns {boolean}
 */
export function excludeWouldFail(root, rel) {
  if (!excludePath(root)) return true;
  // `-n` prints a line for an unmatched path too, and exits 1 when nothing is ignored: that is the
  // ordinary answer here, not a failure (git() would read it as one).
  let out;
  try {
    out = execFileSync('git', ['check-ignore', '-v', '-n', '--no-index', '--', rel], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch (e) {
    if (e?.status !== 1 || typeof e.stdout !== 'string') return true;
    out = e.stdout;
  }
  const m = /^(.*?):\d*:(.*)\t/.exec(out);
  if (!m) return false;
  const [, source, pattern] = m;
  // git names a .gitignore of the work tree relative to it, and core.excludesFile — which ranks
  // below info/exclude whatever it is called, `~/.gitignore` included — by its absolute path
  // (round-3 review, R3-5).
  return pattern.startsWith('!') && !isAbsolute(source) && /(^|[\\/])\.gitignore$/.test(source);
}

// The bytes of info/exclude before a write, to put back if the write fails (delta D7).
function excludeSnapshot(root) {
  const p = excludePath(root);
  if (!p) return null;
  try {
    return { p, bytes: existsSync(p) ? readFileSync(p) : null };
  } catch {
    return null;
  }
}

function restoreExclude(snap) {
  if (!snap) return;
  try {
    if (snap.bytes === null) rmSync(snap.p, { force: true });
    else writeFileSync(snap.p, snap.bytes);
  } catch {
    /* best-effort */
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
 * Whether this plugin created the block here before. With the block gone that means the user or
 * `unadopt` removed it, and it is not written back until `adopt --enable` (writeLocalSteering).
 * @returns {boolean}
 */
export function localSteeringRemembered(root) {
  return readState(root) !== null;
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

// Record that the plugin created a local block here (see readState). `file` names which one, so
// removal can tell what `createdFile` is about.
function rememberCreated(root, fields) {
  try {
    const sp = stateFile(root);
    if (sp) {
      mkdirSync(dirname(sp), { recursive: true });
      writeFileSync(sp, JSON.stringify({ created: new Date().toISOString(), ...fields }) + '\n');
    }
  } catch {
    /* best-effort: without it a removal is not remembered, which is the old behaviour */
  }
}

/**
 * Insert or refresh the block in CLAUDE.local.md — or, where that file would switch off an
 * AGENTS.md or the block is there already, in RULES_MD (writeRulesSteering) — and keep the file
 * out of commits. `file` in the result names which one was written. `refused` means nothing was
 * written; the caller injects the steering instead, unless `present` says the file it refused to
 * write already carries the block (a tracked file, or one behind a link), which the host loads
 * anyway. A block this plugin created before and that is gone now was removed by the user or by
 * `unadopt`: it is not written back (reason `removed`) until `adopt --enable` forgets it.
 * `frozen` (CLAUDE_MEM_NO_TEMPLATE_REFRESH=1) leaves a block that is there as it is — after the
 * same refusals, so a root that has since become an npm package still loses it.
 * @param {string} root from localSteeringRoot
 * @param {{slug: string, version: string, block: string, frozen?: boolean, cwd?: string}} opts
 *   `cwd`: the session's directory, where shadowedAgentsMd starts looking (default `root`)
 * @returns {{action: 'created'|'updated'|'unchanged'|'refused', reason?: string, detail?: string,
 *   present?: boolean, file?: string}}
 */
export function writeLocalSteering(root, { slug, version, block, frozen = false, cwd = root }) {
  const p = localMdPath(root);
  // Read through a link on purpose: this is what the host loads.
  const local = readBlockSafe(p, slug);
  const present = local.body !== null;
  const rulesPresent = readBlockSafe(rulesMdPath(root), slug).body !== null;
  // The rules file carries the block and CLAUDE.local.md does not: what CLAUDE.local.md is — a
  // directory, a file the team tracks, a link — changes nothing about the channel. Refused for
  // that, the session injected on top of the rules file it had loaded (round-3 review, R3-3).
  if (rulesPresent && !present)
    return writeRulesSteering(root, { slug, version, block, frozen, cwd, local, rulesPresent });
  // A directory or an unreadable file: inject rather than give up the session (delta D9).
  if (local.unreadable) return { action: 'refused', reason: 'unreadable' };
  if (gitOk(root, ['ls-files', '--error-unmatch', '--', LOCAL_MD]))
    return { action: 'refused', reason: 'tracked', present };
  // A link would carry the block into whatever file it points at — possibly one another
  // repository tracks (pre-tag defect review P2-2).
  try {
    if (lstatSync(p).isSymbolicLink()) return { action: 'refused', reason: 'symlink', present };
  } catch {
    /* absent */
  }
  // D#212: the rules file once it carries the block (it switches nothing off, so it stays the
  // channel even from a session that sees no AGENTS.md), or wherever CLAUDE.local.md would switch
  // an AGENTS.md off.
  if (rulesPresent || shadowedAgentsMd(root, cwd))
    return writeRulesSteering(root, { slug, version, block, frozen, cwd, local, rulesPresent });
  if (npmPublishable(root)) {
    // The root became a package after the block was written (`git init`, a session, then
    // `npm init`): npm would ship it (delta review P1-1). Take it out, and forget having
    // created it — the user did not remove it, so it comes back if the package goes private.
    if (present) {
      removeLocalSteering(root, slug);
      forgetLocalSteering(root);
    }
    // `present`: this session loaded the file at startup; injecting too would load it twice. The
    // next session finds it gone and gets the injected copy (delta D6).
    return { action: 'refused', reason: 'npm-publishable', present };
  }
  if (!present && readState(root)) return { action: 'refused', reason: 'removed' };
  // Exclude first: a file that cannot be kept out of `git status` is not written at all. Also with
  // the template frozen: nothing else would re-add an entry the user or another worktree's removal
  // took out.
  const snap = excludeSnapshot(root);
  const excluded = ensureExcluded(root);
  if (excluded === 'failed') {
    // A `.gitignore` rule makes git see the file it wrote before: the block comes out, as from the
    // rules file (round-3 review, R3-1; P1-2 there), and that session, which loaded it, gets no
    // injected copy.
    if (present) {
      removeTarget(root, slug, LOCAL_MD);
      forgetLocalSteering(root);
    }
    return { action: 'refused', reason: 'exclude-failed', present };
  }
  if (present && frozen) return { action: 'unchanged', file: LOCAL_MD };
  const fileExisted = existsSync(p);
  let r;
  try {
    r = writeBlockAt(p, { slug, version, block });
  } catch {
    // The entry this call added goes too, byte for byte, as for the rules file (R3-9).
    if (excluded === 'added') restoreExclude(snap);
    return { action: 'refused', reason: 'write-failed' };
  }
  if (r.action === 'created') rememberCreated(root, { createdFile: !fileExisted, file: LOCAL_MD });
  return { ...r, file: LOCAL_MD };
}

/** Why RULES_MD is not written, in words, for the notes that say so. */
export const RULES_REFUSAL_TEXT = Object.freeze({
  symlink: '.claude, .claude/rules or the file is a symbolic link',
  tracked: 'git tracks a file of that name',
  foreign: 'a file of that name, without the block, is already there',
  'npm-publishable': 'npm publish could ship it from this package root',
  'exclude-failed': 'git would not ignore it',
  'write-failed': 'it could not be written',
  removed: 'you or unadopt removed it, and `claude-mem-lite adopt --enable` lets it be written again',
});

/**
 * Whether git tracks `rel` (relative to the top-level) — for `adopt --status`, which must not call
 * a tracked file "excluded from git".
 * @returns {boolean}
 */
export function trackedByGit(root, rel) {
  return gitOk(root, ['ls-files', '--error-unmatch', '--', rel]);
}

/**
 * Whether git ignores `rel` (relative to the top-level) — for `adopt --status`, which must not call
 * a file git sees "excluded from git" (round-3 review, R3-1).
 * @returns {boolean}
 */
export function ignoredByGit(root, rel) {
  return gitOk(root, ['check-ignore', '-q', '--', rel]);
}

/** Why CLAUDE.local.md is not written, in words, for `adopt --status`. */
export const LOCAL_REFUSAL_TEXT = Object.freeze({
  tracked: 'is tracked by git',
  symlink: 'is a symbolic link',
  'npm-publishable': 'could be shipped by npm publish from this package root',
  'exclude-failed': 'would not be ignored by git',
  unreadable: 'is a directory or cannot be read',
});

/**
 * Whether the local file `path` (CLAUDE.local.md or RULES_MD under `root`) is reached through a
 * symbolic link — for `adopt --status`, which must not call such a file "auto-written, excluded
 * from git" (delta D11).
 * @returns {boolean}
 */
export function localFileLinked(root, path) {
  return path === rulesMdPath(root) ? symlinkOnRulesPath(root) : isSymlink(path);
}

/**
 * What the next session would do here, read without writing anything — for `adopt --status`. The
 * file writeLocalSteering would pick, the AGENTS.md that made it pick the rules file, and the
 * refusal it would meet, if one can be read in advance (a remembered removal and a failing exclude
 * entry are left to the caller and to the write). Mirrors writeLocalSteering's order.
 * @returns {{ file: string, agentsMd: string|null, refusal: string|null }}
 */
export function planLocalSteering(root, slug, cwd = root) {
  const local = readBlockSafe(localMdPath(root), slug);
  const rulesPresent = readBlockSafe(rulesMdPath(root), slug).body !== null;
  if (!rulesPresent || local.body !== null) {
    if (gitOk(root, ['ls-files', '--error-unmatch', '--', LOCAL_MD]))
      return { file: LOCAL_MD, agentsMd: null, refusal: 'tracked' };
    if (isSymlink(localMdPath(root))) return { file: LOCAL_MD, agentsMd: null, refusal: 'symlink' };
    if (local.unreadable) return { file: LOCAL_MD, agentsMd: null, refusal: 'unreadable' };
  }
  const agentsMd = shadowedAgentsMd(root, cwd);
  if (agentsMd || rulesPresent) {
    const refusal = rulesRefusal(root, slug) ?? (excludeWouldFail(root, RULES_MD) ? 'exclude-failed' : null);
    return { file: RULES_MD, agentsMd, refusal };
  }
  const refusal = npmPublishable(root)
    ? 'npm-publishable'
    : excludeWouldFail(root, LOCAL_MD) && !gitOk(root, ['check-ignore', '-q', '--', LOCAL_MD])
      ? 'exclude-failed'
      : null;
  return { file: LOCAL_MD, agentsMd: null, refusal };
}

/**
 * Whether CLAUDE.local.md would be refused here even where no AGENTS.md is in the way: the root is
 * a package npm would ship it from, or the plugin remembers a removal. The notes use it to say
 * whether the setting that reads AGENTS.md beside CLAUDE.local.md leads to a file.
 * @returns {boolean}
 */
export function localMdRefused(root) {
  return (
    npmPublishable(root) ||
    readState(root) !== null ||
    (excludeWouldFail(root, LOCAL_MD) && !gitOk(root, ['check-ignore', '-q', '--', LOCAL_MD]))
  );
}

/**
 * The refusal of RULES_MD that can be read without writing anything (a link, a tracked or foreign
 * file, an npm package root that would ship it), or null. writeRulesSteering and `adopt --status`.
 * @param {string} root
 * @param {string} slug
 * @returns {'symlink'|'tracked'|'foreign'|'npm-publishable'|null}
 */
export function rulesRefusal(root, slug) {
  const p = rulesMdPath(root);
  if (symlinkOnRulesPath(root)) return 'symlink';
  if (gitOk(root, ['ls-files', '--error-unmatch', '--', RULES_MD])) return 'tracked';
  if (existsSync(p) && readBlockSafe(p, slug).body === null) return 'foreign';
  if (npmShipsRules(root)) return 'npm-publishable';
  return null;
}

/**
 * The RULES_MD half of writeLocalSteering. Refused — the steering is then injected — where the
 * file, `.claude/rules` or `.claude` is a symbolic link, git tracks the file, a file of that name
 * without the block is there already (the user's: excluding it would hide it from git), npm would
 * ship it (npmShipsRules), it was created here before and removed since (until `adopt --enable`),
 * or git still sees it after the exclude entry. In a repository whose AGENTS.md CLAUDE.local.md
 * would switch off, a refusal reads `reason: 'agents-md'` with the refusal in `detail`. A block an
 * earlier version wrote into CLAUDE.local.md comes out either way, and is not remembered as the
 * user's removal; with the template frozen its text moves into the rules file as it is.
 */
function writeRulesSteering(root, { slug, version, block, frozen, cwd, local, rulesPresent }) {
  const p = rulesMdPath(root);
  const localPresent = local.body !== null;
  // `present` is also true when this call takes out a block the session loaded at startup (the
  // CLAUDE.local.md one, or the rules file below): that session needs no injected copy (delta D6).
  const refuse = (detail, present = false) => {
    if (localPresent) {
      removeTarget(root, slug, LOCAL_MD);
      forgetLocalSteering(root);
    }
    const loaded = present || localPresent;
    const agentsMd = shadowedAgentsMd(root, cwd);
    return agentsMd
      ? { action: 'refused', reason: 'agents-md', detail, present: loaded, agentsMd }
      : { action: 'refused', reason: detail, present: loaded };
  };
  const why = rulesRefusal(root, slug);
  if (why === 'npm-publishable') {
    // As for CLAUDE.local.md: a block written before the root became a package comes out, and
    // is written again once the package stops shipping it.
    if (rulesPresent) {
      removeTarget(root, slug, RULES_MD);
      forgetLocalSteering(root);
    }
    return refuse(why, rulesPresent);
  }
  // A link or a tracked file that carries the block is loaded by the host anyway (`present`).
  if (why) return refuse(why, rulesPresent);
  if (!rulesPresent && !localPresent && readState(root)) return refuse('removed');
  const snap = excludeSnapshot(root);
  const excluded = ensureExcluded(root, RULES_MD);
  if (excluded === 'failed') {
    // Git sees the file (a negation in .gitignore outranks info/exclude). One already written
    // comes out, as for a package root, instead of sitting in `git status` and loading beside the
    // injected copy (pre-tag defect review of D#212, P1-2).
    if (rulesPresent) {
      removeTarget(root, slug, RULES_MD);
      forgetLocalSteering(root);
    }
    return refuse('exclude-failed', rulesPresent);
  }
  if (rulesPresent && frozen) return { action: 'unchanged', file: RULES_MD };
  const text = frozen && localPresent ? { version: local.version, block: local.body } : { version, block };
  let r;
  try {
    mkdirSync(dirname(p), { recursive: true });
    r = writeBlockAt(p, { slug, ...text });
  } catch {
    // An entry this call added goes too, byte for byte: left behind, every later session fails
    // the same way (delta D7).
    if (excluded === 'added') restoreExclude(snap);
    return refuse('write-failed');
  }
  // Before the state is rewritten: removing CLAUDE.local.md reads `createdFile` from it.
  if (localPresent) removeTarget(root, slug, LOCAL_MD);
  if (r.action === 'created') rememberCreated(root, { createdFile: true, file: RULES_MD });
  // `moved`: the session that moves the block loaded CLAUDE.local.md at startup, so it needs no
  // injected copy (pre-tag defect review of D#212, P3-1).
  return localPresent && r.action === 'created'
    ? { ...r, file: RULES_MD, moved: true }
    : { ...r, file: RULES_MD };
}

/**
 * Remove the block from CLAUDE.local.md and from RULES_MD (deleting a file left empty, and the
 * `.claude/rules` and `.claude` directories that leaves empty) and the exclude lines this module
 * added. Neither is edited through a symbolic link (`skipped-symlink`). `path` names the file the
 * block came out of.
 * @returns {{action: 'removed'|'absent'|'skipped-symlink'|'failed', residue?: string, path?: string}}
 */
export function removeLocalSteering(root, slug, { keepTracked = false } = {}) {
  const results = [
    removeTarget(root, slug, RULES_MD, keepTracked),
    removeTarget(root, slug, LOCAL_MD, keepTracked),
  ];
  const failed = results.find((r) => r.action === 'failed');
  if (failed) return failed;
  const removed = results.filter((r) => r.action === 'removed');
  if (removed.length > 0) {
    const residue = removed
      .map((r) => r.residue)
      .filter(Boolean)
      .join(' ');
    return {
      action: 'removed',
      path: removed.map((r) => r.path).join(' and '),
      ...(residue ? { residue } : {}),
    };
  }
  return results.find((r) => r.action === 'skipped-symlink') ?? { action: 'absent' };
}

function removeTarget(root, slug, rel, keepTracked = false) {
  const p = join(root, rel);
  // Never through a link (delta review P2-4): the plugin never writes through one, and the
  // file at the other end can be another repository's, tracked there. A linked `.claude` with
  // nothing of ours behind it is not worth a line on every unadopt.
  if (rel === RULES_MD ? symlinkOnRulesPath(root) : isSymlink(p)) {
    if (rel === RULES_MD && readBlockSafe(p, slug).body === null) return { action: 'absent' };
    return { action: 'skipped-symlink', path: p };
  }
  // A tracked file is the repository's: the session-start sync leaves it, as the write side refuses
  // it (pre-tag defect review of D#212, P2-3). unadopt, which the user runs, still removes the block.
  if (keepTracked && gitOk(root, ['ls-files', '--error-unmatch', '--', rel])) return { action: 'absent' };
  // `createdFile: false` = the block went into a file the user already had. Unknown (a state
  // written before the field existed, or unreadable) counts as the plugin's file: keeping notes
  // out of `git status` is the safe side. The rules file is always the plugin's (a file of that
  // name without the block is refused).
  const state = readState(root);
  const ownFile =
    rel === RULES_MD ||
    (state !== null && ((state.file ?? LOCAL_MD) !== LOCAL_MD || state.createdFile !== false));
  // A directory there holds nothing of ours. A file that cannot be read, or read but not edited, is
  // a failure, said as one (delta D5, round-3 review R3-10): "nothing there" would end the user's
  // search.
  const cur = readBlockSafe(p, slug);
  if (cur.unreadable && cur.code === 'EISDIR') return { action: 'absent' };
  if (cur.unreadable)
    return {
      action: 'failed',
      path: p,
      residue: `could not read ${p} (${cur.code}); if it holds the claude-mem-lite block, remove the block by hand.`,
    };
  let action, orphans;
  try {
    ({ action, orphans } = removeBlockAt(p, slug));
  } catch (e) {
    return {
      action: 'failed',
      path: p,
      residue: `could not edit ${p} (${e?.code ?? e?.message}); remove the claude-mem-lite block from it by hand.`,
    };
  }
  // The exclude entry goes with the file. A file the plugin created that outlives its block
  // holds the user's own notes, and dropping the entry would put them in `git status` (delta
  // review P2-5); a file the user had before goes back to how git saw it.
  if (!existsSync(p) || (action === 'removed' && !ownFile)) removeExcluded(root, slug, rel);
  if (rel === RULES_MD && action === 'removed' && !existsSync(p)) {
    for (const dir of ['.claude/rules', '.claude']) {
      try {
        rmdirSync(join(root, dir));
      } catch {
        break; /* not empty (or gone): leave it and what is above it */
      }
    }
  }
  if (orphans > 0 && action === 'removed')
    return { action, residue: orphanResidueNote(orphans, slug, p), path: p };
  return { action, path: p };
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
