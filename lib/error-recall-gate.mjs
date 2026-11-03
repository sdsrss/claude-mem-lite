// Error-triggered recall — the SUPPRESSION half: firings that are real failures of nothing
// the memory corpus could explain (session-history analysis r2, finding N2).
//
// The trigger (detectBashSignificance / the host's is_error) judges "did it fail" and was
// right; what it injected was still mostly irrelevant, because two populations are not
// failures a memory can help with:
//
//   tdd-red     the agent has just written the test and runs it to WATCH it fail.
//   data-print  an exit-0 inline script or `gh … --log-failed` whose OUTPUT is somebody
//               else's error text (a transcript line, a CI log, the script's own assert).
//   own-script  (R3 O2) the only failure in the output is an exception raised inside the
//               agent's OWN throwaway code — a heredoc/-c/-e program or a script under /tmp —
//               typically a patch script whose anchor did not match, at any exit code.
//
// Reach, measured before this shipped (2026-09-26, tree fa66e5d, 196 session transcripts,
// pre-DB firings through the shipped trigger): tdd-red 229 of 858 PostToolUse firings and
// 1 of 243 PostToolUseFailure firings; data-print 41 of the 858. Re-measured once edits
// were keyed on entryEditedFiles and this call's own writes (2026-09-26T17:15Z, 199
// transcripts, one walk): 1107 firings -> 641; tdd-red 417 + 6, data-print 43.
//
// Pure: the hook hands in the episode entries it already keeps, so the decision is
// testable without spawning a hook, and coverage reaches it (hook.mjs is outside it).

import { detectBashSignificance, isDataPrintingCommand } from '../bash-utils.mjs';
import { entryEditedFiles } from '../utils.mjs';

// Test-file names as runners print them: `tests/x.test.mjs`, `src/a.spec.ts`,
// `test_x.py`, `x_test.go`. Path-qualified when the output qualifies them.
const TEST_FILE_RE =
  /(?:[\w.@-]+\/)*(?:[\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?|test_\w+\.py|\w+_test\.(?:py|go))(?![\w.])/g;

/** Test files named in a command line or its output, `./` stripped, deduped. */
function namedTestFiles(...texts) {
  const out = new Set();
  for (const t of texts)
    for (const m of String(t || '').matchAll(TEST_FILE_RE)) out.add(m[0].replace(/^(?:\.\/)+/, ''));
  return [...out];
}

/**
 * Same file, written two ways: the episode keeps what extractFilePaths captured (absolute
 * for a tool edit, possibly relative for a Bash write) while runners print cwd-relative
 * paths. Matched on a PATH-SEGMENT boundary, so `tests/bred.test.mjs` is not `red.test.mjs`.
 */
function samePath(a, b) {
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

// A test runner was invoked. detectBashSignificance's isTest plus `node --test`, which it
// does not know and which the claudemd project runs its whole suite through.
function runsTests(cmd) {
  return detectBashSignificance({ command: cmd }, '').isTest || /\bnode\b[^\n|;&]*\s--test\b/.test(cmd);
}

/**
 * tdd-red: a test runner ran, the output (or the command) names test files, and EVERY one
 * of them was edited — earlier in this episode by this session, or by this very call
 * (`cat >> t.test.mjs <<EOF … EOF` then the run, one Bash call). "Every", not "any": a
 * full-suite run that also fails in an unedited file is a real failure and keeps firing.
 *
 * "Edited" is entryEditedFiles: an edit tool's `files`, a Bash entry's `bashWrites` — never
 * a Bash entry's `files`, which also holds what it only READ. Measured before this shipped,
 * 106 of 1101 firings name a test a prior Bash call only read or grepped, and reading a test
 * before running it is how a real failure is investigated.
 */
function isDeliberateRed({ cmd, response, entries, ccSession, currentWrites }) {
  if (!runsTests(cmd)) return false;
  const edited = Array.isArray(currentWrites) ? [...currentWrites] : [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (ccSession && e?.ccSession && e.ccSession !== ccSession) continue;
    edited.push(...entryEditedFiles(e));
  }
  if (edited.length === 0) return false;
  const tests = namedTestFiles(response, cmd);
  if (tests.length === 0) return false;
  return tests.every((t) => edited.some((f) => typeof f === 'string' && samePath(f, t)));
}

// A stack frame: V8's `at fn (path:L:C)` / `at path:L:C` (file:// URL or bare path), and
// CPython's `File "path", line N`. Only ABSOLUTE paths are read — V8 always prints them,
// CPython does for imported modules — and `[eval]`/`<stdin>` pseudo-files never qualify.
const FRAME_RE =
  /^[ \t]*(?:at\s+(?:[^\n(]*\()?(?:file:\/\/)?(\/[^\s():]+):\d+(?::\d+)?\)?[ \t]*\{?$|File "(\/[^"]+)", line \d+)/gm;

/**
 * The failure is in THIS repo's source: a stack frame whose file sits under the project
 * directory and outside node_modules. Frame-shaped, not "a repo path:line anywhere": a
 * printed review note quoting `scripts/lib/x.js:45` is prose, and the measured population
 * had exactly that case.
 */
function hasRepoSourceFrame(response, projectDir) {
  if (!projectDir) return false;
  const root = projectDir.endsWith('/') ? projectDir : projectDir + '/';
  for (const m of String(response || '').matchAll(FRAME_RE)) {
    const p = m[1] || m[2];
    if (p.startsWith(root) && !p.includes('/node_modules/') && !p.includes('[eval')) return true;
  }
  return false;
}

// ── own-script (R3 O2, docs/audits/20261103-r3-optimization-plan.md) ─────────────────────────
//
// data-print covers an inline script whose output is DATA, and only at exit 0, on purpose: a
// program that exits non-zero failed. What it leaves firing is the agent's own throwaway code
// FAILING — a `python3 - <<EOF` patch script whose `assert s.count(old) == 1` missed, a scratch
// `node "$SP/x.mjs"` that cannot import its dependency — usually chained with other commands
// (`… && npx vitest …`), so the command as a whole is not a printer. Measured on 194 transcripts
// (2026-10-06..11-03): 95 of 622 firings had that as their only failure; the memory a failed
// patch anchor or a scratch import calls up was unrelated in every one of a 42-case sample.
//
// The rule: every exception block in the output was raised entirely in code the agent wrote for
// this call — pseudo-files (`<stdin>`, `<string>`, `[stdin]`, `[eval1]`), interpreter internals
// (`node:…`, `<frozen …>`) and files under /tmp or /var/tmp outside the project — and with those
// blocks removed the output is no longer a hard error. One frame in the project, in
// node_modules or in an installed library, and the firing stands: that is code the corpus can
// know about. "No longer a failure" is detectBashSignificance's isError, not its narrower
// isHardError: a `Tests 1 failed` summary left beside the patch script's traceback keeps the
// firing even though that summary alone would not have started one.
// Off switch: CLAUDE_MEM_ERROR_RECALL_OWN_SCRIPT=off.

/** Output larger than this is not judged (a cut-off block could hide a real failure). */
const OWN_SCRIPT_MAX_CHARS = 200_000;

const NODE_ERROR_HEAD_RE = /^(?:\[stdin\]|\[eval\d*\]|(?:file:\/\/)?\/[^\s:]+|node:[\w/.-]+):\d+$/;
const NODE_ERROR_LINE_RE = /^(?:[A-Z]\w*)?(?:Error|Exception)\b|^\w+ \[ERR_[A-Z_]+\]/;
const NODE_FRAME_RE =
  /^\s+at (?:.*?\()?(?:file:\/\/)?(\[stdin\]|\[eval\d*\]|node:[^\s():]+|\/[^\s():]+?)(?::\d+)+\)?\s*\{?$/;
const PY_FRAME_RE = /^\s+File "([^"]+)", line \d+/;
const HOST_EXIT_BANNER_RE = /^(?:Error: )?Exit code \d+\s*$/;

/** Throwaway or interpreter-internal: never a file the memory corpus can describe. */
function isOwnCodeFrame(file, projectDir) {
  if (/^(?:<stdin>|<string>|<frozen [^>]+>|\[stdin\]|\[eval\d*\])$/.test(file)) return true;
  if (/^node:/.test(file)) return true;
  if (/\/\[eval\d*\]$/.test(file)) return true; // `file:///proj/[eval1]` — node -e's pseudo-file
  if (!/^\/(?:var\/)?tmp\//.test(file)) return false;
  const root = typeof projectDir === 'string' && projectDir ? projectDir.replace(/\/+$/, '') : null;
  return !(root && file.startsWith(root + '/'));
}

/**
 * Exception blocks: CPython tracebacks and Node's uncaught-error report, each with the files of
 * its frames and its line span. A block with no frame at all is returned with none, which the
 * caller reads as "cannot tell", i.e. not own code.
 */
function exceptionBlocks(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^Traceback \(most recent call last\):/.test(lines[i])) {
      let j = i + 1;
      const files = [];
      while (j < lines.length && /^\s/.test(lines[j])) {
        const m = PY_FRAME_RE.exec(lines[j]);
        if (m) files.push(m[1]);
        j++;
      }
      // lines[j] is the exception line (`AssertionError: …`); keep it in the block.
      out.push({ start: i, end: Math.min(j, lines.length - 1), files });
      i = j;
      continue;
    }
    if (NODE_ERROR_HEAD_RE.test(lines[i])) {
      const head = lines[i].replace(/^file:\/\//, '').replace(/:\d+$/, '');
      const files = [head];
      let sawError = false;
      let j = i + 1;
      for (; j < lines.length && j - i < 80; j++) {
        if (/^Node\.js v\d/.test(lines[j])) break;
        if (NODE_ERROR_LINE_RE.test(lines[j])) sawError = true;
        const m = NODE_FRAME_RE.exec(lines[j]);
        if (m) files.push(m[1]);
      }
      if (sawError && j < lines.length) {
        out.push({ start: i, end: j, files });
        i = j;
      }
    }
  }
  return out;
}

/**
 * own-script: see the section comment above.
 * @returns {boolean}
 */
function isOwnScriptFailure({ cmd, response, projectDir }, env = process.env) {
  if (String(env.CLAUDE_MEM_ERROR_RECALL_OWN_SCRIPT || '').toLowerCase() === 'off') return false;
  const text = typeof response === 'string' ? response : '';
  if (!text || text.length > OWN_SCRIPT_MAX_CHARS) return false;
  const lines = text.split('\n');
  const blocks = exceptionBlocks(lines);
  if (blocks.length === 0) return false;
  if (!blocks.every((b) => b.files.length > 0 && b.files.every((f) => isOwnCodeFrame(f, projectDir))))
    return false;
  // The host prefixes a failed call's text with `Error: Exit code N` (all 208 recorded
  // PostToolUseFailure firings, 2026-10-06..11-03); that banner restates the exit, it is not
  // another failure, and leaving it in made this rule unreachable on the failure path.
  const rest = lines
    .filter(
      (l, k) => !blocks.some((b) => k >= b.start && k <= b.end) && !(k === 0 && HOST_EXIT_BANNER_RE.test(l)),
    )
    .join('\n');
  return !detectBashSignificance({ command: cmd }, rest).isError;
}

/**
 * Should this error-recall firing stay silent?
 *
 * @param {{cmd: string, response: string, entries?: object[], ccSession?: string|null,
 *          currentWrites?: string[], exitZero: boolean, projectDir?: string}} opts
 *   `entries` are the current episode buffer's entries (they carry `tool`, `files`,
 *   `ccSession` and, for Bash, `bashWrites`); `currentWrites` is what THIS call wrote
 *   (extractFileTargets' `writes`), since the call is appended to the buffer only after
 *   recall ran; `exitZero` is true on the PostToolUse path, where the host has routed every
 *   non-zero exit elsewhere.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{reason: 'tdd-red'|'data-print'|'own-script'}|null} null ⇒ fire as before.
 */
export function errorRecallSuppression(
  { cmd, response, entries, ccSession, currentWrites, exitZero, projectDir },
  env = process.env,
) {
  const command = typeof cmd === 'string' ? cmd : '';
  if (!command) return null;
  if (isDeliberateRed({ cmd: command, response, entries, ccSession, currentWrites }))
    return { reason: 'tdd-red' };
  // Exit 0 only: an inline script that exits non-zero is a program that failed, and the
  // failure path (PostToolUseFailure) keeps it.
  if (exitZero && isDataPrintingCommand(command) && !hasRepoSourceFrame(response, projectDir))
    return { reason: 'data-print' };
  if (isOwnScriptFailure({ cmd: command, response, projectDir }, env)) return { reason: 'own-script' };
  return null;
}
