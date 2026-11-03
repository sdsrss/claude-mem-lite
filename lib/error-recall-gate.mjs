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
//   git-record  an exit-0 git command whose only "failure" is a commit SUBJECT that names one
//               (D#717; see withoutGitRecords).
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

// ─── git-record (D#717) ──────────────────────────────────────────────────────
//
// `git commit -m "fix: a traceback on …" && git log --oneline` succeeded, and its output is the
// record of commits whose subjects name failures. The R3 session fired three times on exactly that;
// over every transcript on the maintainer's machine (2026-11-03) 6 of 422 exit-0 firings turned on
// such records alone (docs/audits/20261103-r3-optimization-plan.md §9.3). Only git's own record
// shapes are removed, and only when the command runs a subcommand that prints them; whatever else
// the output says is judged again by the shipped trigger, so a failed pre-commit run whose exit an
// `; echo` masked, or a real failure printed next to the records, still fires.
// CLAUDE_MEM_ERROR_RECALL_GIT_RECORD=off restores the firing.

const GIT_RECORD_CMD_RE =
  /\bgit\s+(?:(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?)\s+)*(?:log|show|commit|cherry-pick|revert|merge|rebase|reflog)\b/;
// `[main 1a2b3c4] subject`, `[main (root-commit) 1a2b3c4] …`, `[detached HEAD 1a2b3c4] …`
const COMMIT_RESULT_LINE_RE = /^\[[^\]\n]* [0-9a-f]{7,40}\] /;
// `1a2b3c4 subject`, `1a2b3c4 (HEAD -> main) subject`, behind `--graph`'s `* | / \` columns.
// No bare leading spaces: an indented hex run is not a record git prints. At least one letter:
// an all-digit run is a log line's epoch timestamp far more often than an abbreviated sha, and
// a sha that happens to be all digits only keeps the old firing.
const ONELINE_RECORD_RE = /^(?:[*|\\/][*|\\/ ]*)?(?=\d*[a-f])[0-9a-f]{7,40}(?: \([^)\n]*\))? \S/;
// `commit <sha>` opens the default format: header fields, then the message indented by 4 spaces.
const COMMIT_HEADER_RE = /^commit [0-9a-f]{40}\b/;
const COMMIT_FIELD_RE = /^(?:Merge|Author|AuthorDate|Commit|CommitDate|Date):/;

/** The output without the commit records git printed: result lines, one-line logs, full headers. */
function withoutGitRecords(text) {
  const kept = [];
  let inRecord = false;
  for (const line of String(text || '').split('\n')) {
    if (COMMIT_HEADER_RE.test(line)) {
      inRecord = true;
      continue;
    }
    if (inRecord) {
      if (line === '' || line.startsWith('    ') || COMMIT_FIELD_RE.test(line)) continue;
      inRecord = false;
    }
    if (COMMIT_RESULT_LINE_RE.test(line) || ONELINE_RECORD_RE.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

function gitRecordGateOn() {
  return !['0', 'off', 'false', 'no'].includes(
    String(process.env.CLAUDE_MEM_ERROR_RECALL_GIT_RECORD ?? '').toLowerCase(),
  );
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
 * @returns {{reason: 'tdd-red'|'data-print'|'git-record'}|null} null ⇒ fire as before.
 */
export function errorRecallSuppression({
  cmd,
  response,
  entries,
  ccSession,
  currentWrites,
  exitZero,
  projectDir,
}) {
  const command = typeof cmd === 'string' ? cmd : '';
  if (!command) return null;
  if (isDeliberateRed({ cmd: command, response, entries, ccSession, currentWrites }))
    return { reason: 'tdd-red' };
  // Exit 0 only: an inline script that exits non-zero is a program that failed, and the
  // failure path (PostToolUseFailure) keeps it.
  if (exitZero && isDataPrintingCommand(command) && !hasRepoSourceFrame(response, projectDir))
    return { reason: 'data-print' };
  if (
    exitZero &&
    GIT_RECORD_CMD_RE.test(command) &&
    gitRecordGateOn() &&
    !detectBashSignificance({ command }, withoutGitRecords(response)).isHardError
  )
    return { reason: 'git-record' };
  return null;
}
