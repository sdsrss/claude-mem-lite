// Which files does a Bash command read or write?
//
// Leaf module (path + os only): scripts/pre-tool-recall.js imports it on the PreToolUse
// fast path, so nothing here may pull in the DB stack or the utils barrel.
//
// Why this exists (docs/audits/20260926-154904-session-history-analysis-r2.md, N1): on
// Opus 5.5 only 18.0% of file edits went through Edit/Write and 14.7% of reads through
// Read — the rest were `sed -i`, `cat >> f <<EOF`, `python3 - <<'EOF'` patches and
// `sed -n`/`cat` reads. The old extractor matched `(?:^|\s)(\/[\w./-]+\w)` over the raw
// command, so a quoted path, a relative path, or any path after `cd <repo> &&` yielded
// either nothing or the repo root, and 5 of 6 real edit shapes produced no file edge.
//
// This is a shell-aware HEURISTIC, not a shell: it tokenises quotes, heredocs,
// redirections and command separators, tracks `cd`, and classifies each literal path
// argument by the verb that consumes it. Anything carrying an expansion (`$VAR`, `$(…)`,
// globs) is skipped rather than guessed.

import { resolve, isAbsolute, basename } from 'path';
import { homedir } from 'os';

/**
 * Session-scoped paths that are real on disk but never recur: the harness scratchpad
 * (`/tmp/claude-<uid>/<project>/<session>/…`), spilled tool output (`…/tool-results/…`)
 * and installed dependencies (`…/node_modules/…`). An edge to one can never be matched by
 * a later session, and 10.2% + 4.1% of this project's events carried one
 * (docs/audits/20260926-154904-session-history-analysis-r2.md, N5). Excluded even from the
 * direct `file_path` field, which otherwise keeps /tmp paths on purpose (see below).
 *
 * Claude Code's own per-project state is excluded too: `~/.claude/projects/<dir>/` holds
 * the session transcripts and the host's built-in auto-memory (`memory/MEMORY.md` + one
 * file per memory). Those are the HOST's notes, not the user's project. In the sandbox
 * usage evaluation (docs/audits/20260929-sandbox-usage-eval.md) the agent wrote its plan to
 * that memory in half the sessions, the episode then carried the memory files as its only
 * edges, and the handoff listed `MEMORY.md` under Key Files. `CLAUDE_CONFIG_DIR` moves the
 * same tree, so its `projects/` is matched as well.
 * @param {string} p absolute path
 * @returns {boolean}
 */
export function isTransientPath(p) {
  if (/^\/tmp\/claude-\d+\//.test(p) || /[\\/](?:tool-results|node_modules)[\\/]/.test(p)) return true;
  if (/[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]/.test(p)) return true;
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (typeof configDir === 'string' && isAbsolute(configDir)) {
    const root = `${configDir.replace(/[\\/]+$/, '')}/projects/`;
    if (p.startsWith(root) && p.indexOf('/', root.length) !== -1) return true;
  }
  return false;
}

/**
 * Paths that are never a file edge when they appear inside a Bash COMMAND: device and
 * process files, and /tmp in general (a transient argument, unlike an explicit Edit to a
 * /tmp file, which the direct-field rule keeps). A /tmp path INSIDE the project directory
 * is the project's own file — a checkout under /tmp is still a checkout.
 * @param {string} p absolute path
 * @param {string|null} [projectDir] the session's project root
 * @returns {boolean}
 */
export function isScratchCommandPath(p, projectDir = null) {
  if (p.startsWith('/dev/') || p.startsWith('/proc/')) return true;
  if (!p.startsWith('/tmp/')) return false;
  const root = typeof projectDir === 'string' && projectDir ? projectDir.replace(/\/+$/, '') : null;
  return !(root && p.startsWith(root + '/'));
}

const WORD_BREAK = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);

// Minimal shell lexer. Tokens: { w, quoted, expand } for words, { op } for operators,
// { op: '<<', delim, body } for heredocs (body filled in when the delimiter line is met).
function lex(src) {
  const toks = [];
  const pending = [];
  const n = src.length;
  let i = 0;
  const push = (t) => toks.push(t);
  const atCmdStart = () => {
    const last = toks[toks.length - 1];
    return !last || (last.op && last.op !== '<<');
  };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n') {
      push({ op: '\n' });
      i++;
      for (const h of pending) {
        const lines = [];
        while (i < n) {
          let j = src.indexOf('\n', i);
          if (j === -1) j = n;
          const line = src.slice(i, j);
          i = j + 1;
          const cmp = (h.strip ? line.replace(/^\t+/, '') : line).trimEnd();
          if (cmp === h.delim) break;
          lines.push(line);
        }
        h.body = lines.join('\n');
      }
      pending.length = 0;
      continue;
    }
    if (c === '#' && atCmdStart()) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === ';;' || two === '|&') {
      push({ op: two === ';;' ? ';' : two === '|&' ? '|' : two });
      i += 2;
      continue;
    }
    if (c === ';' || c === '|' || c === '(' || c === ')') {
      push({ op: c });
      i++;
      continue;
    }
    // Redirections, including fd-prefixed (`2>`, `2>&1`) and `&>`.
    const redir = /^(\d*)(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)/.exec(src.slice(i, i + 5));
    if (redir && (redir[1] === '' || /\d/.test(c))) {
      const op = redir[2];
      i += redir[0].length;
      if (op === '<<' || op === '<<-') {
        while (src[i] === ' ' || src[i] === '\t') i++;
        const d = readWord(src, i);
        i = d.end;
        const tok = { op: '<<', delim: d.w, strip: op === '<<-', body: '' };
        push(tok);
        pending.push(tok);
        continue;
      }
      if (op === '>&' || op === '<&') {
        // `2>&1` / `>&2`: an fd duplication, never a file.
        while (src[i] === ' ') i++;
        const d = readWord(src, i);
        i = d.end;
        continue;
      }
      push({ op: op === '>|' ? '>' : op === '&>>' ? '>>' : op === '&>' ? '>' : op });
      continue;
    }
    if (c === '&') {
      push({ op: '&' });
      i++;
      continue;
    }
    const wtok = readWord(src, i);
    if (wtok.end === i) {
      i++; // unlexable character — skip it rather than loop
      continue;
    }
    i = wtok.end;
    push({ w: wtok.w, quoted: wtok.quoted, expand: wtok.expand });
  }
  return toks;
}

// One shell word starting at `i`: concatenated quoted/unquoted runs. Tracks whether any
// unquoted/double-quoted expansion or glob occurred — such words are never paths here.
function readWord(src, i) {
  let w = '';
  let quoted = false;
  let expand = false;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (WORD_BREAK.has(c)) break;
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j === -1 ? n : j;
      w += src.slice(i + 1, end);
      quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          s += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '$' || src[j] === '`') expand = true;
        s += src[j];
        j++;
      }
      w += s;
      quoted = true;
      i = j + 1;
      continue;
    }
    if (c === '\\' && i + 1 < n) {
      w += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '$' || c === '`') {
      expand = true;
      // Swallow a `$( … )` / `` `…` `` span whole so its spaces do not split the word.
      if (src[i + 1] === '(' || c === '`') {
        const close = c === '`' ? '`' : ')';
        let depth = 0;
        let j = c === '`' ? i + 1 : i + 2;
        while (j < n) {
          if (close === ')' && src[j] === '(') depth++;
          else if (src[j] === close) {
            if (depth === 0) break;
            depth--;
          }
          j++;
        }
        w += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
    }
    if (c === '*' || c === '?' || c === '[' || c === '{') expand = true;
    w += c;
    i++;
  }
  return { w, quoted, expand, end: i };
}

const EXT_RE = /\.[A-Za-z][A-Za-z0-9_-]{0,9}$/;
const EXTENSIONLESS_FILES = new Set([
  'Makefile',
  'Dockerfile',
  'Gemfile',
  'Rakefile',
  'Procfile',
  'LICENSE',
  'Justfile',
]);
const PATH_CHARS_RE = /^[A-Za-z0-9_./@+~%,-]+$/;

// A literal word that names a file. Absolute paths keep the old extractor's rule (two
// components or an extension — `/exit` is a slash command, not a file); relative ones need
// a file-shaped basename, because `lib` or `main` is far more often a dir, a branch or a
// subcommand than a file.
function asPathWord(tok, { allowDir = false } = {}) {
  if (!tok || tok.w === undefined || tok.expand) return null;
  const w = tok.w;
  if (!w || w.startsWith('-') || !PATH_CHARS_RE.test(w)) return null;
  if (w.endsWith('/') && !allowDir) return null;
  if (w.startsWith('/')) {
    if (w.indexOf('/', 1) === -1 && !EXT_RE.test(w)) return null;
    return w;
  }
  if (w.startsWith('~/')) return w;
  if (allowDir) return w;
  const base = basename(w);
  if (EXT_RE.test(base) && !/^\.+$/.test(base)) return w;
  if (EXTENSIONLESS_FILES.has(base)) return w;
  return null;
}

function resolvePath(p, cwd) {
  if (p.startsWith('~/')) {
    let home;
    try {
      home = homedir();
    } catch {
      return null;
    }
    return resolve(home, p.slice(2));
  }
  if (isAbsolute(p)) return resolve(p);
  if (!cwd) return null;
  return resolve(cwd, p);
}

// Verbs whose file operands are READ.
const READ_VERBS = new Set([
  'cat',
  'head',
  'tail',
  'nl',
  'less',
  'more',
  'wc',
  'diff',
  'cmp',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'awk',
  'gawk',
  'jq',
  'bat',
  'file',
  'stat',
  'md5sum',
  'sha256sum',
  'shasum',
]);
// READ_VERBS that VIEW a file's content (the Bash counterpart of the Read tool), as opposed
// to searching, counting or hashing it. PreToolUse recall fires on these only: a
// `grep -rn` sweep is exploration, not the agent about to work on one file.
const VIEW_VERBS = new Set(['cat', 'head', 'tail', 'nl', 'less', 'more', 'bat']);
// Verbs whose first non-option operand is a pattern/program, not a file.
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'awk', 'gawk', 'jq']);
// Options of PATTERN_FIRST verbs that supply the pattern themselves (so the first operand
// IS a file) and consume the next word.
const PATTERN_OPTS = new Set(['-e', '-f', '--regexp', '--file', '--pattern']);
// Options (per verb) that consume the next word as their value.
const VALUE_OPTS = {
  head: new Set(['-n', '-c']),
  tail: new Set(['-n', '-c']),
  grep: new Set(['-A', '-B', '-C', '-m', '--include', '--exclude', '--exclude-dir']),
  rg: new Set(['-A', '-B', '-C', '-m', '-g', '-t', '-T', '--glob', '--type']),
  sed: new Set(['-l']),
  awk: new Set(['-F', '-v']),
  jq: new Set(['--indent']),
};
// Options (per verb) that consume the next TWO words (`jq --arg name value`).
const VALUE_OPTS2 = { jq: new Set(['--arg', '--argjson', '--slurpfile', '--rawfile']) };
// Shell keywords that start a command without being its verb (pre-ship review P3-2).
// (`time` is a wrapper in PREFIX_WORDS, so its own options are skipped too: `time -p`.)
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '{', '}', '!']);
// Wrapper verbs and the options of theirs that take a value.
const WRAPPER_VALUE_OPTS = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  nice: new Set(['-n']),
  env: new Set(['-u', '-C', '-S']),
};
// Commands whose operands are CONTENT, not file references.
const CONTENT_VERBS = new Set(['echo', 'printf', 'export', 'alias', 'read', 'test', '[', 'true', 'false']);
const INTERPRETERS = new Set([
  'python',
  'python3',
  'node',
  'perl',
  'ruby',
  'bun',
  'deno',
  'bash',
  'sh',
  'zsh',
]);
const PREFIX_WORDS = new Set([
  'sudo',
  'env',
  'time',
  'nohup',
  'command',
  'builtin',
  'exec',
  'nice',
  'stdbuf',
]);
// Write calls in an inline / heredoc program, each with a group for its TARGET argument:
// a quoted literal (group 2) or a bare identifier (group 3), optionally wrapped in
// \`Path(…)\` / \`pathlib.Path(…)\` / \`path.resolve|join(…)\`. A whole-program "does it write"
// test used to send EVERY literal to writes, so \`sys.stdout.write(open('t.test.mjs').read())\`
// — a read that prints — counted as editing the test (pre-ship defect review P2-1).
const TARGET = String.raw`(?:(?:(?:pathlib\.)?Path|path\.(?:resolve|join))\(\s*)?(?:(['"])([^'"\n]+)\1|([A-Za-z_$][\w$]*))`;
const WRITE_CALL_SRC = [
  // python open(x, 'w' | 'a' | 'x' | 'r+' …); ruby File.open(x, 'w')
  String.raw`\b(?:File\.)?open\(\s*${TARGET}\s*,\s*(?:mode\s*=\s*)?['"](?:[wax]|r\+)`,
  // node fs writes and ruby File.write (first argument is the target)
  String.raw`\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|truncateSync|File\.write)\(\s*${TARGET}`,
  // pathlib: Path(x).write_text(…)
  String.raw`\b(?:pathlib\.)?Path\(\s*${TARGET}\s*\)\s*\.\s*write_(?:text|bytes)\(`,
  // copy / move / rename: the DESTINATION is written
  String.raw`\b(?:shutil\.(?:copy2?|copyfile|move)|os\.(?:rename|replace)|renameSync|rename|copyFileSync|copyFile)\(\s*[^,()]+,\s*${TARGET}`,
];
// \`p.write_text(…)\` — its one group is the receiver identifier.
const RECEIVER_WRITE_SRC = String.raw`\b([A-Za-z_][\w]*)\s*\.\s*write_(?:text|bytes)\(`;
// \`name = 'lit'\`, \`name = Path('lit')\`, \`name = ROOT / 'lit'\`, \`name = path.join('lit')\`
const BINDING_RE =
  /(?<![\w$])([A-Za-z_$][\w$]*)\s*=\s*(?:[\w.]{1,80}\s*\/\s*)?(?:(?:(?:pathlib\.)?Path|path\.(?:resolve|join))\(\s*)?(['"])([^'"\n]+)\2/g;
// A list, tuple or dict literal bound to a name (a dict's keys are its rows' heads).
const LIST_BINDING_RE = /(?<![\w$])([A-Za-z_$][\w$]*)\s*=\s*[[({]/g;
const SCRIPT_LITERAL_RE = /(['"])((?:~\/|\.{0,2}\/)?[A-Za-z0-9_@+%,.-]+(?:\/[A-Za-z0-9_@+%,.-]+)*)\1/g;

/** Index just past the bracket that closes the one at \`open\` (quote-aware), or -1. */
// Bounded: a bracket not closed within MAX_SCAN chars counts as unclosed. Unbounded, N
// unclosed `x = [` cost O(N x program) — 71.8 s at 200 KB (pre-ship round-3 review P2-1).
const MAX_SCAN = 4096;
// Indirect resolution (lists, loops, forEach, helpers) is skipped above this program size,
// and each kind handles at most MAX_INDIRECT sites: the hook runs on every tool call.
const MAX_INDIRECT_PROGRAM = 65536;
const MAX_INDIRECT = 64;

function closeBracket(text, open) {
  const pairs = { '[': ']', '(': ')', '{': '}' };
  const stack = [];
  const limit = Math.min(text.length, open + MAX_SCAN);
  for (let i = open; i < limit; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const j = text.indexOf(c, i + 1);
      if (j === -1 || j >= limit) return -1;
      i = j;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ']' || c === ')' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

/** Head literal of each top-level element of a list body: 'a' → a, ('a', x) / ['a', x] → a. */
function elementHeads(body) {
  const heads = [];
  let depth = 0;
  let start = 0;
  const flush = (end) => {
    const el = body.slice(start, end).trim();
    const m = /^[[(]?\s*(['"])([^'"\n]+)\1/.exec(el);
    if (m) heads.push(m[2]);
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" || c === '"') {
      const j = body.indexOf(c, i + 1);
      if (j === -1) break;
      i = j;
    } else if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(body.length);
  return heads;
}

/**
 * The body of a helper defined at \`at\`: python by indentation, JS by brackets (a block
 * \`{…}\`, or an expression up to the first \`;\` / newline at bracket depth 0).
 */
function helperBody(text, at, isPython, headerAt = at) {
  if (isPython) {
    // `at` sits just past the `:`, often ON the newline that ends the def line. The suite's
    // indent is the HEADER's, which starts on an earlier line when a loop's list wraps.
    const lineStart = text.lastIndexOf('\n', headerAt - 1) + 1;
    const indent = /^[ \t]*/.exec(text.slice(lineStart))[0].length;
    const bodyStart = text.indexOf('\n', at);
    if (bodyStart === -1) return text.slice(at);
    // Line by line from the def, stopping at the first dedent — never splitting the whole
    // remainder, which made N helpers cost O(N x program) (4.5 s for 200 KB of defs).
    let pos = bodyStart + 1;
    while (pos < text.length) {
      let eol = text.indexOf('\n', pos);
      if (eol === -1) eol = text.length;
      const line = text.slice(pos, eol);
      // A comment at any indent does not end a python suite.
      const t = line.trim();
      if (t && !t.startsWith('#') && /^[ \t]*/.exec(line)[0].length <= indent) break;
      pos = eol + 1;
    }
    return text.slice(bodyStart + 1, pos);
  }
  let i = at;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === '{') {
    const end = closeBracket(text, i);
    return text.slice(i, end === -1 ? undefined : end);
  }
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "'" || c === '"' || c === '`') {
      const k = text.indexOf(c, j + 1);
      if (k === -1) break;
      j = k;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth < 0) return text.slice(i, j);
    } else if ((c === ';' || c === '\n') && depth === 0) return text.slice(i, j);
  }
  return text.slice(i);
}

/**
 * The body of a loop whose header starts at \`start\` and whose iterated token sits at
 * \`tokAt\` — a python suite (the rest of the header line, then the indented block) or a
 * JS statement / block after \`for (…)\`. Null when the header does not close.
 */
function loopBody(text, start, tokAt, tok, pythonish) {
  let after = tokAt + 1;
  if (tok === '[' || tok === '(' || tok === '{') {
    after = closeBracket(text, tokAt);
    if (after === -1) return null;
  }
  let eol = text.indexOf('\n', after);
  if (eol === -1) eol = text.length;
  const colon = pythonish ? text.slice(after, eol).search(/:(?!\w)/) : -1;
  if (colon !== -1) {
    const at = after + colon + 1;
    return text.slice(at, eol) + helperBody(text, at, true, start);
  }
  // A python comprehension (\`[open(f, 'w') for f in files]\`) has no suite: its body is the
  // line around it.
  if (pythonish && !/^for\s*\(/.test(text.slice(start, start + 8))) {
    return text.slice(text.lastIndexOf('\n', start) + 1, eol);
  }
  const open = text.indexOf('(', start);
  if (open === -1 || open > tokAt) return null;
  const close = closeBracket(text, open);
  return close === -1 ? null : helperBody(text, close, false);
}

/** Identifiers (resolved or not) that a write call in \`text\` targets, plus literal targets. */
function writeTargetsIn(text) {
  const idents = new Set();
  const literals = [];
  let m;
  for (const src of WRITE_CALL_SRC) {
    const re = new RegExp(src, 'g');
    while ((m = re.exec(text))) {
      if (m[2] !== undefined) literals.push(m[2]);
      else if (m[3] !== undefined) idents.add(m[3]);
    }
  }
  const rr = new RegExp(RECEIVER_WRITE_SRC, 'g');
  while ((m = rr.exec(text))) idents.add(m[1]);
  return { idents, literals };
}

/**
 * Split an inline program's path literals into the ones it writes and the rest.
 * @returns {{writes: string[], reads: string[]}} absolute paths
 */
function scriptTargets(text, cwd) {
  const literals = scriptLiterals(text, cwd);
  if (!literals.length) return { writes: [], reads: [] };
  let m;
  const bindings = new Map();
  BINDING_RE.lastIndex = 0;
  while ((m = BINDING_RE.exec(text))) bindings.set(m[1], m[3]);
  const lists = new Map();
  LIST_BINDING_RE.lastIndex = 0;
  let listSites = 0;
  const indirect = text.length <= MAX_INDIRECT_PROGRAM;
  while (indirect && listSites++ < MAX_INDIRECT && (m = LIST_BINDING_RE.exec(text))) {
    const open = m.index + m[0].length - 1;
    const end = closeBracket(text, open);
    if (end !== -1) lists.set(m[1], text.slice(open + 1, end - 1));
  }
  const written = new Set();
  const addLit = (lit) => {
    if (!lit || (!lit.includes('/') && !EXT_RE.test(lit))) return;
    const p = asPathWord({ w: lit });
    const abs = p && resolvePath(p, cwd);
    if (abs) written.add(abs);
  };
  const top = writeTargetsIn(text);
  for (const lit of top.literals) addLit(lit);
  const unresolved = new Set();
  for (const id of top.idents) {
    if (bindings.has(id)) addLit(bindings.get(id));
    else unresolved.add(id);
  }
  if (unresolved.size && indirect) {
    // Indirect targets, each resolved only where the write provably flows (delta review
    // P2-A / P3-4 — an earlier cut matched helpers by parameter NAME and any table's rows,
    // and made read-only helpers and tables into writes):
    // (1) a helper whose body writes its FIRST parameter — \`def edit(path, pairs): …
    //     open(path, 'w')\`, \`const rep = (p, a, b) => fs.writeFileSync(p, …)\`,
    //     \`const w = f => …\` — makes the first literal of each call to it a write;
    const helperRe =
      /\bdef\s+([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)[^)\n]{0,200}\)\s*:|\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)\n]{0,200}\)\s*|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(\s*([A-Za-z_$][\w$]*)[^)\n]{0,200}\)|([A-Za-z_$][\w$]*))\s*=>\s*/g;
    // Bounded: a real patch script defines a handful of helpers; a pathological program
    // defining thousands must not hold the hook past its timeout. The price is deliberate:
    // writes through a 65th distinct helper are dropped (round-3 P3-2: 200 KB of distinct
    // defs records 64 writes, not 2710). The most any of 10,389 distinct Bash commands in
    // this repo's transcripts defines is 12 (2026-09-26, upper bound: every def counted).
    const seenHelpers = new Set();
    const writers = [];
    while ((m = helperRe.exec(text)) && seenHelpers.size < 64) {
      const name = m[1] || m[3] || m[5];
      const param = m[2] || m[4] || m[6] || m[7];
      if (!unresolved.has(param) || seenHelpers.has(name)) continue;
      seenHelpers.add(name);
      const body = helperBody(text, m.index + m[0].length, Boolean(m[1]));
      if (!writeTargetsIn(body).idents.has(param)) continue;
      writers.push(name.replace(/\$/g, '\\$'));
      const callRe = new RegExp(
        String.raw`(?<![\w$.])${name.replace(/\$/g, '\\$')}\(\s*(['"])([^'"\n]+)\1`,
        'g',
      );
      let c;
      while ((c = callRe.exec(text))) addLit(c[2]);
    }
    // (2) a loop whose (first) variable is the target, over a literal list or a list
    //     bound to a name: \`for f, old, new in edits:\` (python tuple edit table — this
    //     repo's most common multi-file patch), \`for p in ['a', 'b']:\`,
    //     \`for (const [f, a, b] of edits)\`, \`[…].forEach(f => …)\` / \`edits.forEach(([f]) =>\`.
    const loopRes = [
      /\bfor\s+\(?\s*([A-Za-z_]\w*)[^:\n]{0,200}?\s+in\s+([A-Za-z_]\w*|[[({])(?:\.(?:items|keys)\(\))?/g,
      /\bfor\s*\(\s*(?:const|let|var)\s+\[?\s*([A-Za-z_$][\w$]*)[^\n]{0,200}?\s+of\s+([A-Za-z_$][\w$]*|\[)/g,
    ];
    const listBodyAt = (tok, pos) => {
      if (tok === '[' || tok === '(' || tok === '{') {
        const end = closeBracket(text, pos);
        return end === -1 ? null : text.slice(pos + 1, end - 1);
      }
      return lists.get(tok) ?? null;
    };
    // The variable must be written inside the loop's OWN body — matching it by name alone
    // made a read-only loop reusing a written variable's name a write (round-3 P3-1) — by a
    // write call, or by a call to a helper found above to write its first parameter
    // (\`for p, a, b in edits: patch(p, a, b)\`; pre-ship review P3-4).
    const writerCallRe = writers.length
      ? new RegExp(String.raw`(?<![\w$.])(?:${writers.join('|')})\(\s*([A-Za-z_$][\w$]*)`, 'g')
      : null;
    const writesVar = (body, v) => {
      if (body === null) return false;
      if (writeTargetsIn(body).idents.has(v)) return true;
      if (!writerCallRe) return false;
      writerCallRe.lastIndex = 0;
      let c;
      while ((c = writerCallRe.exec(body))) if (c[1] === v) return true;
      return false;
    };
    const candidate = (v) => unresolved.has(v) || writers.length > 0;
    for (const [k, re] of loopRes.entries()) {
      re.lastIndex = 0;
      let sites = 0;
      while (sites++ < MAX_INDIRECT && (m = re.exec(text))) {
        if (!candidate(m[1])) continue;
        const tokAt = m.index + m[0].length - 1;
        const list = listBodyAt(m[2], tokAt);
        if (!list || !writesVar(loopBody(text, m.index, tokAt, m[2], k === 0), m[1])) continue;
        for (const h of elementHeads(list)) addLit(h);
      }
    }
    const forEachRe = /([A-Za-z_$][\w$]*|\])\s*\.forEach\(\s*(?:async\s*)?\(?\s*\[?\s*([A-Za-z_$][\w$]*)/g;
    let forEachSites = 0;
    while (forEachSites++ < MAX_INDIRECT && (m = forEachRe.exec(text))) {
      if (!candidate(m[2])) continue;
      let body = null;
      if (m[1] === ']') {
        // walk back to the matching '[' of the literal array
        let depth = 0;
        for (let i = m.index; i >= Math.max(0, m.index - MAX_SCAN); i--) {
          if (text[i] === ']') depth++;
          else if (text[i] === '[' && --depth === 0) {
            body = text.slice(i + 1, m.index);
            break;
          }
        }
      } else body = lists.get(m[1]) ?? null;
      const call = m.index + m[0].indexOf('.forEach(') + '.forEach'.length;
      const callEnd = closeBracket(text, call);
      if (!body || callEnd === -1 || !writesVar(text.slice(call, callEnd), m[2])) continue;
      for (const h of elementHeads(body)) addLit(h);
    }
  }
  return { writes: [...written], reads: literals.filter((p) => !written.has(p)) };
}

function scriptLiterals(text, cwd) {
  const out = [];
  if (!text) return out;
  SCRIPT_LITERAL_RE.lastIndex = 0;
  let m;
  while ((m = SCRIPT_LITERAL_RE.exec(text))) {
    const lit = m[2];
    // A bare word like 'utf8' or 'w' is never a path; demand a slash or a file extension.
    if (!lit.includes('/') && !EXT_RE.test(lit)) continue;
    const p = asPathWord({ w: lit });
    if (!p) continue;
    const abs = resolvePath(p, cwd);
    if (abs) out.push(abs);
  }
  return out;
}

/**
 * Classify the files a Bash command reads and writes.
 * @param {string} command raw Bash command text
 * @param {{cwd?: string|null}} [opts] directory the command starts in (hook stdin `cwd`)
 * @returns {{reads: string[], views: string[], writes: string[], mentions: string[]}} absolute
 *   paths, deduplicated; `views` ⊆ `reads` = files whose content is displayed (cat, sed -n,
 *   head…); `mentions` = file-shaped operands of other commands (e.g. the test file a
 *   runner is given).
 */
export function bashFileTargets(command, opts = {}) {
  const reads = new Set();
  const views = new Set();
  const writes = new Set();
  const mentions = new Set();
  const EMPTY = { reads: [], views: [], writes: [], mentions: [] };
  if (typeof command !== 'string' || !command) return EMPTY;
  let toks;
  try {
    toks = lex(command.length > 200_000 ? command.slice(0, 200_000) : command);
  } catch {
    return EMPTY;
  }
  let cwd = opts.cwd ? resolve(opts.cwd) : null;

  // Split into simple commands.
  const cmds = [];
  let cur = [];
  for (const t of toks) {
    if (t.op && t.op !== '<<' && !['>', '>>', '<', '<<<', '<>'].includes(t.op)) {
      if (cur.length) cmds.push(cur);
      cur = [];
      // A subshell's `cd` ends with it: remember the cwd at `(`, restore it at `)`.
      if (t.op === '(' || t.op === ')') cmds.push(t.op);
      continue;
    }
    cur.push(t);
  }
  if (cur.length) cmds.push(cur);

  const cwdStack = [];
  for (const items of cmds) {
    if (items === '(') {
      cwdStack.push(cwd);
      continue;
    }
    if (items === ')') {
      if (cwdStack.length) cwd = cwdStack.pop();
      continue;
    }
    // Pull redirections and heredocs out; what remains is argv.
    const argv = [];
    const heredocs = [];
    let localCwd = cwd;
    for (let k = 0; k < items.length; k++) {
      const t = items[k];
      if (t.op === '<<') {
        heredocs.push(t);
        continue;
      }
      if (t.op === '>' || t.op === '>>' || t.op === '<' || t.op === '<>') {
        const target = items[k + 1];
        k++;
        const p = asPathWord(target, {});
        const abs = p && resolvePath(p, cwd);
        if (abs) (t.op === '<' ? reads : writes).add(abs);
        continue;
      }
      if (t.op === '<<<') {
        k++; // here-string operand is content
        continue;
      }
      if (t.w !== undefined) argv.push(t);
    }
    // Leading env assignments, shell keywords and wrapper words (with their options).
    while (argv.length) {
      const w = argv[0].w;
      if (/^[A-Za-z_]\w*=/.test(w) || KEYWORDS.has(w)) {
        argv.shift();
        continue;
      }
      if (!PREFIX_WORDS.has(w) && w !== 'timeout') break;
      argv.shift();
      const valueOpts = WRAPPER_VALUE_OPTS[w];
      while (argv.length && argv[0].w.startsWith('-') && argv[0].w !== '-') {
        const opt = argv.shift().w;
        if (valueOpts?.has(opt) && argv.length) argv.shift();
      }
      if (w === 'timeout' && argv.length) argv.shift(); // the duration
    }
    if (!argv.length) continue;
    const verb = basename(argv[0].w);
    const args = argv.slice(1);

    if (verb === 'cd' || verb === 'pushd') {
      const target = args.find((a) => !a.w.startsWith('-'));
      if (!target || target.expand || target.w === '-' || target.w === '~') cwd = null;
      else {
        const p = target.w.startsWith('~/') ? resolvePath(target.w, cwd) : resolvePath(target.w, cwd);
        cwd = p || null;
      }
      continue;
    }
    if (CONTENT_VERBS.has(verb)) continue;

    if (verb === 'git') {
      // `git -C <dir> …` resolves its pathspecs against <dir>.
      const rest = [];
      for (let k = 0; k < args.length; k++) {
        if (args[k].w === '-C' && args[k + 1]) {
          const d = args[k + 1].expand ? null : resolvePath(args[k + 1].w, cwd);
          localCwd = d;
          k++;
          continue;
        }
        rest.push(args[k]);
      }
      for (const a of rest) {
        const p = asPathWord(a);
        const abs = p && resolvePath(p, localCwd);
        if (abs) mentions.add(abs);
      }
      continue;
    }

    if (verb === 'sed' || verb === 'perl') {
      let inPlace = false;
      let scriptGiven = false;
      const operands = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k].w;
        if (a === '--') continue;
        if (a.startsWith('--')) {
          if (a.startsWith('--in-place')) inPlace = true;
          if (a === '--expression' || a === '--file') {
            scriptGiven = true;
            k++;
          } else if (a.startsWith('--expression=') || a.startsWith('--file=')) scriptGiven = true;
          continue;
        }
        if (a.startsWith('-') && a.length > 1) {
          if (VALUE_OPTS[verb]?.has(a)) {
            k++;
            continue;
          }
          // Clustered short flags, read left to right the way both tools do: `i` takes the
          // REST of the cluster as its backup suffix (`-i.bak`, and the classic `-pie`
          // = `-p -i` with suffix "e"); `e` (and sed's `f`, perl's `E`) takes the rest as
          // its value, or the next word when it ends the cluster.
          const flags = a.slice(1);
          for (let j = 0; j < flags.length; j++) {
            const ch = flags[j];
            if (ch === 'i') {
              inPlace = true;
              break;
            }
            if (ch === 'e' || (verb === 'sed' && ch === 'f') || (verb === 'perl' && ch === 'E')) {
              scriptGiven = true;
              if (j === flags.length - 1) k++;
              break;
            }
          }
          continue;
        }
        operands.push(args[k]);
      }
      const files = scriptGiven ? operands : operands.slice(1);
      for (const a of files) {
        const p = asPathWord(a);
        const abs = p && resolvePath(p, cwd);
        if (!abs) continue;
        if (inPlace) writes.add(abs);
        else {
          reads.add(abs);
          if (verb === 'sed') views.add(abs); // `sed -n '1,50p' f` is how Bash pages a file
        }
      }
      // `perl -e '…'` doubles as an interpreter: fall through to literal scanning only
      // when it is not an in-place filter (whose script is a substitution, not paths).
      if (verb === 'perl' && !inPlace) {
        const lits = scriptLiterals(heredocs.map((h) => h.body).join('\n'), cwd);
        for (const abs of lits) reads.add(abs);
      }
      continue;
    }

    if (verb === 'tee') {
      for (const a of args) {
        const p = asPathWord(a);
        const abs = p && resolvePath(p, cwd);
        if (abs) writes.add(abs);
      }
      continue;
    }

    if (verb === 'cp' || verb === 'mv' || verb === 'install' || verb === 'ln') {
      const ops = args.filter((a) => !a.w.startsWith('-'));
      ops.forEach((a, idx) => {
        const p = asPathWord(a);
        const abs = p && resolvePath(p, cwd);
        if (!abs) return;
        if (idx === ops.length - 1) writes.add(abs);
        else reads.add(abs);
      });
      continue;
    }

    if (verb === 'touch' || verb === 'truncate') {
      for (const a of args) {
        const p = asPathWord(a);
        const abs = p && resolvePath(p, cwd);
        if (abs) writes.add(abs);
      }
      continue;
    }

    if (INTERPRETERS.has(verb) || /^python[0-9.]+$/.test(verb)) {
      // Inline program (`-c`/`-e`/`-p`) or a heredoc/stdin program: scan its string literals.
      let program = '';
      let scriptFile = null;
      for (let k = 0; k < args.length; k++) {
        const a = args[k].w;
        if (a === '-c' || a === '-e' || a === '-p' || a === '--eval' || a === '--print') {
          program = args[k + 1]?.w || '';
          k++;
          continue;
        }
        if (a.startsWith('-')) continue;
        if (!program && scriptFile === null && a !== '-') {
          scriptFile = args[k];
          continue;
        }
      }
      if (!program && heredocs.length) program = heredocs.map((h) => h.body).join('\n');
      if (scriptFile) {
        const p = asPathWord(scriptFile);
        const abs = p && resolvePath(p, cwd);
        if (abs) mentions.add(abs);
      }
      if (program) {
        const st = scriptTargets(program, cwd);
        for (const abs of st.writes) writes.add(abs);
        for (const abs of st.reads) reads.add(abs);
      }
      continue;
    }

    if (READ_VERBS.has(verb)) {
      let patternSupplied = !PATTERN_FIRST.has(verb);
      let skippedPattern = false;
      for (let k = 0; k < args.length; k++) {
        const a = args[k].w;
        if (a.startsWith('-') && a !== '-') {
          if (PATTERN_OPTS.has(a) || (verb === 'awk' && a === '-f')) {
            patternSupplied = true;
            k++;
          } else if (VALUE_OPTS2[verb]?.has(a)) k += 2;
          else if (VALUE_OPTS[verb]?.has(a)) k++;
          continue;
        }
        if (!patternSupplied && !skippedPattern) {
          skippedPattern = true;
          continue;
        }
        const p = asPathWord(args[k]);
        const abs = p && resolvePath(p, cwd);
        if (!abs) continue;
        reads.add(abs);
        if (VIEW_VERBS.has(verb)) views.add(abs);
      }
      continue;
    }

    // Any other command: file-shaped operands are mentions (a test file handed to a
    // runner, a script handed to node, a path handed to git).
    for (const a of args) {
      const p = asPathWord(a);
      const abs = p && resolvePath(p, cwd);
      if (abs) mentions.add(abs);
    }
  }
  const w = [...writes];
  const r = [...reads].filter((p) => !writes.has(p));
  const v = [...views].filter((p) => !writes.has(p));
  const m = [...mentions].filter((p) => !writes.has(p) && !reads.has(p));
  return { reads: r, views: v, writes: w, mentions: m };
}
