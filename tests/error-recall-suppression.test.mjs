// N2 (session-history analysis r2, 2026-09-26): error-recall judged "did it fail" correctly
// and still injected mostly irrelevant memories, because two populations of firings are
// not failures the corpus can explain:
//
//   1. A deliberate TDD RED — the agent has just written the test and runs it to watch it
//      fail. 4 of the 5 post-deploy firings were this shape.
//   2. An exit-0 command that PRINTS someone else's error text — `node -e` over a
//      transcript, `gh run view --log-failed | grep`, a `python3 - <<PY` script. 3 more
//      firings in the analysing session itself.
//
// Measured before coding (2026-09-26, tree fa66e5d, 196 session transcripts, pre-DB
// firings through the shipped trigger): the episode-keyed RED gate reaches 229 of 858
// PostToolUse firings and 1 of 243 PostToolUseFailure firings; the data-print gate
// reaches 41 of the 858. Neither is a zero-reach gate.
//
// Every suppressing case below has a CONTROL that differs in the one fact the gate keys
// on and still fires — a gate that silenced everything would pass the suppressing half.
import { describe, it, expect } from 'vitest';
import { errorRecallSuppression } from '../lib/error-recall-gate.mjs';
import { extractFileTargets, isDataPrintingCommand, detectBashSignificance } from '../bash-utils.mjs';

const REPO = '/home/u/proj';
const SESSION = 'cc-1';

// vitest's RED output after a `| grep` — exit 0, so it arrives on PostToolUse.
const VITEST_RED =
  ' FAIL  tests/red.test.mjs > the new case > rejects the stale row\n' +
  'AssertionError: expected undefined to be false // Object.is equality\n' +
  ' ❯ tests/red.test.mjs:42:5\n' +
  '      Tests  1 failed | 3 passed (4)';
const RED_CMD = 'npx vitest run tests/red.test.mjs -t "stale row" 2>&1 | grep -E "✓|×|FAIL|AssertionError"';

const editEntry = (file, over = {}) => ({ tool: 'Edit', files: [file], ccSession: SESSION, ...over });
// A Bash entry exactly as hook.mjs captures it: `files` and `bashWrites` both come from the
// shipped extractFileTargets, resolved against the project, so these cases exercise the
// real read/write split rather than a hand-written one.
const bashEntry = (command, over = {}) => {
  const { files, writes } = extractFileTargets({ command }, { cwd: REPO, projectDir: REPO });
  return {
    tool: 'Bash',
    files,
    ...(writes.length ? { bashWrites: writes } : {}),
    ccSession: SESSION,
    ...over,
  };
};
const APPEND = "cat >> tests/red.test.mjs <<'EOF'\nit('rejects the stale row', () => {});\nEOF";

const red = (entries, over = {}) =>
  errorRecallSuppression({
    cmd: RED_CMD,
    response: VITEST_RED,
    entries,
    ccSession: SESSION,
    exitZero: true,
    projectDir: REPO,
    ...over,
  });

describe('precondition: every fixture here reaches the surface', () => {
  // A case the trigger cannot fire on measures a path that does not exist.
  it('the RED output and the printed-transcript output are hard errors to the trigger', () => {
    expect(detectBashSignificance({ command: RED_CMD }, VITEST_RED).isHardError).toBe(true);
    expect(detectBashSignificance({ command: PRINT_CMD }, PRINTED).isHardError).toBe(true);
    expect(detectBashSignificance({ command: GH_CMD }, GH_LOG).isHardError).toBe(true);
  });
});

describe('TDD RED — the failing test file was edited in this episode', () => {
  it('suppresses when the named test was edited with the Edit tool (absolute path vs relative output)', () => {
    expect(red([editEntry(`${REPO}/tests/red.test.mjs`)])).toMatchObject({ reason: 'tdd-red' });
  });

  it('suppresses when an earlier Bash call WROTE it (relative heredoc append → bashWrites)', () => {
    // Opus 5.5 writes most files through Bash; `bashWrites` is what says the call was an edit.
    expect(bashEntry(APPEND).bashWrites, 'premise: the append is captured as a write').toEqual([
      `${REPO}/tests/red.test.mjs`,
    ]);
    expect(red([bashEntry(APPEND)])).toMatchObject({ reason: 'tdd-red' });
  });

  it('suppresses when THIS call wrote the test and then ran it (write-and-run in one Bash call)', () => {
    // The call joins the buffer only after recall ran, so its own writes arrive separately.
    const cmd = `${APPEND}\n${RED_CMD}`;
    const { writes } = extractFileTargets({ command: cmd }, { cwd: REPO, projectDir: REPO });
    expect(red([], { cmd, currentWrites: writes })).toMatchObject({ reason: 'tdd-red' });
  });

  it('CONTROL: a call that writes some OTHER file and runs the test still fires', () => {
    const cmd = `${RED_CMD} > out.txt`;
    const { writes } = extractFileTargets({ command: cmd }, { cwd: REPO, projectDir: REPO });
    expect(writes, 'premise: the call does write a file').toEqual([`${REPO}/out.txt`]);
    expect(red([], { cmd, currentWrites: writes })).toBeNull();
  });

  it('suppresses on the host-flagged failure path too (an unpiped RED exits 1)', () => {
    expect(red([editEntry(`${REPO}/tests/red.test.mjs`)], { exitZero: false })).toMatchObject({
      reason: 'tdd-red',
    });
  });

  it('CONTROL: the same RED with no edit in the episode still fires', () => {
    expect(red([])).toBeNull();
    expect(red(undefined)).toBeNull();
  });

  it('CONTROL: a Bash call that only READ the test is not an edit, though its `files` names it', () => {
    // 106 of the 1101 measured firings name a test that a prior Bash call only read or
    // grepped. Reading a test before running it is how a real failure is investigated.
    const read = bashEntry('sed -n 1,50p tests/red.test.mjs');
    expect(read.files, 'premise: the read IS in files').toEqual([`${REPO}/tests/red.test.mjs`]);
    expect(red([read])).toBeNull();
  });

  it('CONTROL: an earlier RUN of the same test is not an edit', () => {
    // So a real failure re-run after reading the test keeps firing on every run.
    const run = bashEntry(`cd ${REPO} && npx vitest run tests/red.test.mjs 2>&1 | tail`);
    expect(run.files, 'premise: the run IS in files').toContain(`${REPO}/tests/red.test.mjs`);
    expect(red([run])).toBeNull();
  });

  it('CONTROL: fires when the output names an UNEDITED test file too (full-suite run)', () => {
    const out = VITEST_RED + '\n FAIL  tests/other.test.mjs > unrelated\nAssertionError: expected 1 to be 2';
    expect(
      red([editEntry(`${REPO}/tests/red.test.mjs`)], { cmd: 'npm test 2>&1 | tail -40', response: out }),
    ).toBeNull();
  });

  it('CONTROL: an edit by ANOTHER concurrent session does not make this RED deliberate', () => {
    expect(red([editEntry(`${REPO}/tests/red.test.mjs`, { ccSession: 'cc-other' })])).toBeNull();
  });

  it('CONTROL: a non-test command naming the edited test (a failing pre-commit) still fires', () => {
    expect(
      red([editEntry(`${REPO}/tests/red.test.mjs`)], { cmd: 'git commit -q -m wip 2>&1 | tail' }),
    ).toBeNull();
  });

  it('CONTROL: a different file that merely shares the basename suffix does not match', () => {
    // The output names a BARE basename (as `node --test` and pytest often do), so only the
    // segment boundary keeps `bred.test.mjs` from matching `red.test.mjs`.
    const bare = 'FAIL red.test.mjs > case\nAssertionError: expected 1 to be 2';
    expect(
      red([editEntry(`${REPO}/tests/bred.test.mjs`)], { cmd: 'npx vitest run red.test.mjs', response: bare }),
    ).toBeNull();
    // Positive half: the same bare name DOES match its own file across the boundary.
    expect(
      red([editEntry(`${REPO}/tests/red.test.mjs`)], { cmd: 'npx vitest run red.test.mjs', response: bare }),
    ).toMatchObject({ reason: 'tdd-red' });
  });

  it('`node --test` is a test runner (the claudemd project runs its suite that way)', () => {
    const out =
      '✖ spec pin: core §2 LEVEL (0.7ms)\n  AssertionError [ERR_ASSERTION]: heading missing\n  tests/scripts/spec.test.js:12';
    expect(
      red([editEntry(`${REPO}/tests/scripts/spec.test.js`)], {
        cmd: 'node --test tests/scripts/spec.test.js 2>&1 | grep -E "✖|AssertionError"',
        response: out,
      }),
    ).toMatchObject({ reason: 'tdd-red' });
  });
});

// `node -e` over a transcript: exit 0, and the output is somebody else's failure.
const PRINT_CMD =
  'cd /home/u/.claude/projects/x && node -e \'for (const l of require("fs").readFileSync("s.jsonl","utf8").split("\\n")) console.log(l.slice(0,200))\'';
const PRINTED =
  '14:04:43 is_error=false | npx vitest run tests/hook-llm.test.mjs\n' +
  'AssertionError: expected undefined to be false // Object.is equality\n' +
  '      Tests  1 failed | 32 skipped (33)';
const GH_CMD = 'gh run view 35637662440 --job 106458961943 --log-failed 2>&1 | grep -E "not ok|Error"';
const GH_LOG =
  'test (24)\tRun tests\t2026-09-21T18:20:29Z not ok 12 - pins the heading\n' +
  'test (24)\tRun tests\t2026-09-21T18:20:29Z AssertionError [ERR_ASSERTION]: expected 3 to equal 4\n' +
  'test (24)\tRun tests\t2026-09-21T18:20:31Z ##[error]Process completed with exit code 1.';

const print = (over = {}) =>
  errorRecallSuppression({
    cmd: PRINT_CMD,
    response: PRINTED,
    entries: [],
    ccSession: SESSION,
    exitZero: true,
    projectDir: REPO,
    ...over,
  });

describe('data-printing command at exit 0', () => {
  it('suppresses `node -e` printing transcript text', () => {
    expect(print()).toMatchObject({ reason: 'data-print' });
  });

  it('suppresses `gh run view --log-failed | grep`', () => {
    expect(print({ cmd: GH_CMD, response: GH_LOG })).toMatchObject({ reason: 'data-print' });
  });

  it('suppresses a `python3 - <<PY` script whose own assertion fails (<stdin> frame)', () => {
    const cmd =
      "python3 - <<'PY'\np='CLAUDE.md'; s=open(p).read()\nassert s.count('x')==1\nPY\ngrep -c '' CLAUDE.md";
    const out =
      'Traceback (most recent call last):\n  File "<stdin>", line 3, in <module>\nAssertionError\n364';
    expect(detectBashSignificance({ command: cmd }, out).isHardError).toBe(true);
    expect(print({ cmd, response: out })).toMatchObject({ reason: 'data-print' });
  });

  it("suppresses an inline script's own crash — `[eval1]` is not a repo file", () => {
    const out =
      'SqliteError: FOREIGN KEY constraint failed\n    at file:///home/u/proj/[eval1]:6:4 {\n' +
      "  code: 'SQLITE_CONSTRAINT_FOREIGNKEY'\n}";
    expect(print({ cmd: 'node --input-type=module -e "x"', response: out })).toMatchObject({
      reason: 'data-print',
    });
  });

  it("CONTROL: a stack frame in THIS repo's source means the inline script ran repo code that broke", () => {
    const out =
      'TypeError: liveObsFilterSql is not a function\n' +
      '    at buildPool (file:///home/u/proj/lib/inject-search-core.mjs:88:12)\n' +
      '    at [eval1]:6:4';
    expect(print({ cmd: 'node --input-type=module -e "x"', response: out })).toBeNull();
    const py =
      'Traceback (most recent call last):\n  File "/home/u/proj/scripts/audit.py", line 42, in main\nKeyError: \'t\'';
    expect(print({ cmd: 'python3 -c "import scripts.audit as a; a.main()"', response: py })).toBeNull();
  });

  it('CONTROL: a repo path merely QUOTED in printed prose is not a frame (the review-doc shape)', () => {
    const out = '**File:** `/home/u/proj/scripts/lib/spec-hash.js:45-46`\nTypeError: x is not a function';
    expect(print({ response: out })).toMatchObject({ reason: 'data-print' });
  });

  it('CONTROL: a node_modules frame does not count as repo source', () => {
    const out = 'TypeError: bad\n    at run (/home/u/proj/node_modules/dep/index.js:3:1)';
    expect(print({ response: out })).toMatchObject({ reason: 'data-print' });
  });

  it('CONTROL: the same output at NON-zero exit (the failure path) still fires', () => {
    expect(print({ exitZero: false })).toBeNull();
  });

  it('CONTROL: the same output from a script FILE still fires', () => {
    expect(print({ cmd: 'node scripts/replay.mjs 2>&1 | tail' })).toBeNull();
  });
});

describe('isDataPrintingCommand', () => {
  it.each([
    ['node -e', "node -e 'console.log(1)'"],
    ['node -p', 'node -p "require(\\"./package.json\\").version"'],
    ['node --input-type=module -e', "cd /r && node --input-type=module -e 'x' | head"],
    ['node heredoc', "node --input-type=module <<'EOF'\nconsole.log(1)\nEOF"],
    ['python3 -c', 'python3 -c "print(1)"'],
    ['python3 - heredoc', "cd /r; python3 - <<'PY'\nprint(1)\nPY"],
    ['gh --log-failed piped', GH_CMD],
    ['gh --log', 'gh run view 1 --log | grep -n "not ok" | head -6'],
    // The analysing session's third misfire: the run id comes from a `--json` query in a
    // substitution, so the substitution must count as a printer too.
    [
      'gh --json in a substitution, then --log-failed',
      `ID=$(gh run list --workflow CI --limit 20 --json databaseId,conclusion -q '.[0].databaseId'); echo $ID; gh run view $ID --log-failed 2>/dev/null | grep -E "FAIL|×" | head -6`,
    ],
    ['gh --json=field', 'gh pr view 12 --json=body | jq -r .body'],
  ])('prints: %s', (_n, cmd) => {
    expect(isDataPrintingCommand(cmd)).toBe(true);
  });

  it.each([
    ['a script file', 'node scripts/x.mjs'],
    ['node --test', 'node --test tests/a.test.js'],
    ['python -m', 'python3 -m pytest -q'],
    ['python script', 'python3 train.py'],
    ['a script file fed by a heredoc', "python3 tools/fix.py <<'EOF'\nx\nEOF"],
    ['python -m fed by a heredoc', "python3 -m json.tool <<'EOF'\n{}\nEOF"],
    ['gh without --log', 'gh run view 123'],
    ['gh run rerun', 'gh run rerun 123 --failed'],
    ['a pure read', 'grep -n x f | head'],
    ['a build piped', 'npm run build 2>&1 | tail'],
    ['printer then a real run', "node -e 'x'; npm test"],
    ['heredoc script then vitest', "python3 - <<'PY'\nprint(1)\nPY\nnpx vitest run tests/a.test.mjs"],
    ['a real run inside a substitution', 'node -e "$(npm test)"'],
  ])('does not: %s', (_n, cmd) => {
    expect(isDataPrintingCommand(cmd)).toBe(false);
  });
});
