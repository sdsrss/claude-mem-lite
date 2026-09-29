// bash-utils-signif.test.mjs — detectBashSignificance regression fixtures.
//
// History: bun/jest/vitest green test summaries contain "0 fail" / "0 failed"
// / "0 failures", and the prior regex `fail(ed|ure)?` matched the bare "fail"
// token in "0 fail", driving episode.isError=true and polluting memory with
// "Error: <file>.ts: bun test ... N pass 0 fail" titles for passing runs
// (5 such observations were found in a live cluster-merge audit). The
// green-test-summary exemption requires an `\b0\s+(fail|failed|failures)\b`
// marker AND no hard-error signal to flip isError back to false.

import { describe, it, expect } from 'vitest';
import { detectBashSignificance } from '../bash-utils.mjs';

describe('detectBashSignificance — green test summary exemption', () => {
  it('does NOT mark "0 fail" bun-test output as error', () => {
    const sig = detectBashSignificance(
      { command: 'bun test logger.test.ts' },
      'bun test v1.3.5\n logger.test.ts:\n  ✓ logs info\n  ✓ logs warn\n 5 pass\n 0 fail\n ran 5 tests across 1 file',
    );
    expect(sig.isError).toBe(false);
    expect(sig.isTest).toBe(true);
  });

  it('does NOT mark "0 failed" jest-style output as error', () => {
    const sig = detectBashSignificance(
      { command: 'npm test' },
      'Tests:       0 failed, 12 passed, 12 total\nSuites:      0 failed, 3 passed, 3 total\nTime:        2.5s',
    );
    expect(sig.isError).toBe(false);
  });

  it('does NOT mark "0 failures" pytest-style output as error', () => {
    const sig = detectBashSignificance(
      { command: 'pytest tests/' },
      'collected 12 items\n\n12 passed in 0.34s\nresult: 0 failures, 0 errors',
    );
    expect(sig.isError).toBe(false);
  });

  it('DOES mark "5 fail" bun-test output as error (red run)', () => {
    const sig = detectBashSignificance(
      { command: 'bun test logger.test.ts' },
      'bun test v1.3.5\n logger.test.ts:\n  ✓ logs info\n  ✗ logs warn\n 3 pass\n 5 fail\n ran 8 tests',
    );
    expect(sig.isError).toBe(true);
  });

  it('DOES mark "0 fail" plus hard error signal as error (test crashed)', () => {
    const sig = detectBashSignificance(
      { command: 'bun test logger.test.ts' },
      'TypeError: cannot read property of undefined\n  at logger.ts:42\n 0 pass\n 0 fail\n ran 0 tests (process crashed)',
    );
    expect(sig.isError).toBe(true);
  });

  it('DOES mark "AssertionError" as error even when output mentions 0 fail elsewhere', () => {
    const sig = detectBashSignificance(
      { command: 'npm test' },
      'AssertionError: expected 5 got 3\n  at logger.test.ts:12\nsuites: 0 failed (crashed before run)',
    );
    expect(sig.isError).toBe(true);
  });

  it('DOES mark traditional "failed" prose as error', () => {
    const sig = detectBashSignificance(
      { command: 'npm install' },
      'npm ERR! code ENOENT\nnpm ERR! Install failed: package not found',
    );
    expect(sig.isError).toBe(true);
  });

  it('does NOT mark grep output containing "error" as error', () => {
    const sig = detectBashSignificance(
      { command: 'grep -r error src/' },
      'src/foo.ts:42: throw new Error("oh no")\nsrc/bar.ts:10: // error handler',
    );
    expect(sig.isError).toBe(false);
  });

  it('DOES flag a real failure piped to a pager (search verb after a pipe must not exempt)', () => {
    // Regression: the exemption matched a search verb ANYWHERE in the command, so
    // `... | tail` / `... | grep` suppressed error detection on real build/test failures.
    const out = 'src/index.ts:42 - error TS2322\nnpm ERR! code 1\nnpm ERR! build failed';
    expect(detectBashSignificance({ command: 'npm run build 2>&1 | tail -n 30' }, out).isError).toBe(true);
    expect(detectBashSignificance({ command: 'make 2>&1 | grep -i error' }, out).isError).toBe(true);
    // A hyphenated token must not trip \bcat\b / \btype\b as a primary search verb.
    expect(detectBashSignificance({ command: 'node run-cat-tests.js' }, out).isError).toBe(true);
  });

  it('keeps the search-exemption for wrapped read commands (sudo/env/time + git read subcommands)', () => {
    // The primary-command anchor must still exempt a search verb behind a wrapper or
    // env-assignment, and git read subcommands (grep/log) whose output contains "error".
    const readOut = 'config.log:42: throw new Error(x)\n  // error handler here too';
    expect(detectBashSignificance({ command: 'sudo grep -i error /var/log/syslog' }, readOut).isError).toBe(
      false,
    );
    expect(detectBashSignificance({ command: 'git grep error src/' }, readOut).isError).toBe(false);
    expect(detectBashSignificance({ command: 'git log --grep=fix' }, readOut).isError).toBe(false);
    expect(detectBashSignificance({ command: 'time tail -n 5 build.log' }, readOut).isError).toBe(false);
    expect(detectBashSignificance({ command: 'cat config.json | head' }, readOut).isError).toBe(false);
  });

  it('recognizes git subcommands behind global flags (-C, -c, --no-pager)', () => {
    const out = 'x'.repeat(20);
    expect(detectBashSignificance({ command: 'git -C /repo push origin main' }, out).isGit).toBe(true);
    expect(detectBashSignificance({ command: 'git --no-pager commit -m x' }, out).isGit).toBe(true);
    expect(detectBashSignificance({ command: 'git -c user.name=x commit -m y' }, out).isGit).toBe(true);
    expect(detectBashSignificance({ command: 'git commit -m x' }, out).isGit).toBe(true);
    // Must not false-positive on a read command that merely contains "commit" as an arg.
    expect(detectBashSignificance({ command: 'git log --grep=commit' }, out).isGit).toBe(false);
  });
});

describe('detectBashSignificance — isHardError (bugfix-nudge gate)', () => {
  it('isHardError=false when output only MENTIONS error words (no failure fingerprint)', () => {
    // The audit false-positive: `node cli.mjs search "error"` returns memory rows that
    // mention "error" → isError=true (node is not a search verb), but it is NOT a fix.
    const out = 'Found 3 results for "error":\n#42 Error handling in auth\n#88 retry on error path';
    const sig = detectBashSignificance({ command: 'node cli.mjs search "error"' }, out);
    expect(sig.isError).toBe(true);
    expect(sig.isHardError).toBe(false);
  });

  it('isHardError=true on a real test failure / thrown exception with a stack', () => {
    // Representative real bugfix episode: a test fails, then you edit to fix it.
    const out = '1 failed\nAssertionError: expected 1 to be 2\n    at /p/app.test.mjs:10:3';
    const sig = detectBashSignificance({ command: 'node app.mjs' }, out);
    expect(sig.isError).toBe(true); // "failed" word trips isError (not a green "0 fail" summary)
    expect(sig.isHardError).toBe(true); // AssertionError + stack frame → real failure fingerprint
  });

  it('isHardError=true on npm ERR! / build-failure fingerprints', () => {
    const out = 'src/index.ts:42 - error TS2322\nnpm ERR! code 1\nnpm ERR! build failed';
    expect(detectBashSignificance({ command: 'npm run build 2>&1 | tail' }, out).isHardError).toBe(true);
  });

  it('isHardError is a strict subset of isError — search commands never hard-error', () => {
    const readOut = 'config.log:42: throw new Error(x)\n  // error handler here too';
    const sig = detectBashSignificance({ command: 'git grep error src/' }, readOut);
    expect(sig.isError).toBe(false);
    expect(sig.isHardError).toBe(false);
  });
});

// The read-only exemption used to look at ONE word: the first token left of the first
// pipe. The host resets the cwd between Bash calls, so agents write `cd <repo> && …` on
// over half their commands, and `cd` is not a read verb — every grep/sed of source that
// quoted `TypeError:` fired error-recall on a command that had not failed. The same
// one-word rule also exempted `grep x f; npx vitest run | tail` because it started with
// grep. Replayed over 26,406 real exit-0 Bash results (2026-09-25): 151 reads went
// silent, 23 compound commands that really ran a program started firing. Shapes below
// are taken from that replay.
describe('detectBashSignificance — read-only exemption checks every statement', () => {
  const SOURCE_QUOTE =
    'bash-utils.mjs:56: // a named error class (TypeError:/ReferenceError:/…) is a hard error\n' +
    'bash-utils.mjs:58:   /\\bERR!|traceback|(?:type|reference)error:/i;\n';
  const RED_RUN =
    ' FAIL  tests/x.test.mjs > case\nAssertionError: expected 1 to be 2 // Object.is equality\n' +
    '      Tests  1 failed | 7 passed (8)\n';
  const hard = (command, out) => detectBashSignificance({ command }, out).isHardError;

  it('treats `cd <dir> &&` / `;` / `|| exit` as set-up, not as the command', () => {
    expect(hard("cd /home/ai/dev/claude-mem-lite && sed -n '56,75p' bash-utils.mjs", SOURCE_QUOTE)).toBe(
      false,
    );
    expect(
      hard('cd /home/ai/dev/claude-mem-lite; grep -n "HARD_ERROR_RE" bash-utils.mjs | head', SOURCE_QUOTE),
    ).toBe(false);
    expect(hard('cd /repo || exit 1; git log --oneline -3', SOURCE_QUOTE)).toBe(false);
    expect(hard('SP=/tmp/x; cd /repo && awk "NR>=50" f | sort | uniq -c', SOURCE_QUOTE)).toBe(false);
  });

  it('does not split on a quoted `;` or on the `&` of a redirection', () => {
    expect(hard('cd /repo && grep -nE "a;b|TypeError" f 2>&1 | head -20', SOURCE_QUOTE)).toBe(false);
    expect(hard('grep -n x f &> /tmp/o.txt; cat /tmp/o.txt |& head', SOURCE_QUOTE)).toBe(false);
  });

  it('still fires when a later statement runs a program', () => {
    expect(hard('cd /repo && npx vitest run tests/x.test.mjs 2>&1 | tail -30', RED_RUN)).toBe(true);
    // Exempted by the one-word rule because it started with grep.
    expect(hard('grep -n "x" tests/x.test.mjs; npx vitest run tests/x.test.mjs 2>&1 | tail', RED_RUN)).toBe(
      true,
    );
    // Heredoc that writes a test, then runs it: the leading `cat` is not the command.
    expect(
      hard(
        "cat > tests/x.test.mjs <<'EOF'\nit('a', () => {})\nEOF\nnpx vitest run tests/x.test.mjs",
        RED_RUN,
      ),
    ).toBe(true);
  });

  it('still fires when a pipe feeds a program, whatever the first element is', () => {
    expect(hard("printf '%s\\n' '{\"id\":1}' | timeout 25 node server.mjs", RED_RUN)).toBe(true);
    expect(hard('cat input.json | node script.mjs', RED_RUN)).toBe(true);
  });

  // v6.13.0 defect review P3-4: an apostrophe in a heredoc body or a `#` comment unbalanced
  // the quotes, and the fallback then judged the whole line by its first word, so a
  // heredoc that writes a test and then runs it was silenced whenever the body said "don't".
  it('reads past heredoc bodies and comments, which are not commands', () => {
    expect(
      hard(
        "cat > tests/x.test.mjs <<'EOF'\n// don't regress\nit('a', () => {})\nEOF\nnpx vitest run tests/x.test.mjs",
        RED_RUN,
      ),
    ).toBe(true);
    expect(hard("cat <<-EOF > f\n\tit's data; npm test\n\tEOF\nnpx vitest run", RED_RUN)).toBe(true);
    expect(hard("sed -n 1,5p f # it's here\nnpm test", RED_RUN)).toBe(true);
    // ...and a body or comment full of program names does not make a read into a run.
    expect(hard("grep -n x f # don't run npm test here", SOURCE_QUOTE)).toBe(false);
    expect(hard("cat <<'EOF' | grep TypeError\nit's npm test; node x\nEOF", SOURCE_QUOTE)).toBe(false);
    expect(hard('cd /repo && grep -n "a#b" f', SOURCE_QUOTE)).toBe(false);
  });

  it('is not read-only when the quotes still do not balance', () => {
    expect(hard('grep -n "unterminated f', SOURCE_QUOTE)).toBe(true);
    expect(hard('npx vitest run "unterminated', RED_RUN)).toBe(true);
  });

  // v6.13.0 defect review P3-5: some read verbs write files or run programs.
  it.each([
    ["sed -i 's/a/b/' f", true],
    ['sed -i.bak -e s/a/b/ f', true],
    ['sed --in-place s/a/b/ f', true],
    ["sed -n '40,80p' f", false],
    ['sed -E -n s/x/y/p f', false],
    ['sort -o f f', true],
    ['sort --output=f f', true],
    ['sort -u f | uniq -c', false],
    ['awk \'BEGIN{system("npm test")}\'', true],
    ['awk \'{ "npm test" | getline r }\'', true],
    ['awk \'{ print | "sh" }\' f', true],
    ["awk '{print $1}' f", false],
    ['find . -name x -exec npm test \\;', true],
    ['find . -name "*.tmp" -delete', true],
    ['find . -name "*.mjs"', false],
    ['find . | xargs sed -i s/a/b/', true],
    ['code-graph-mcp reindex', true],
    ['code-graph-mcp rebuild-index --confirm', true],
    ['code-graph-mcp', true],
    ['code-graph-mcp grep "x" lib', false],
    ['code-graph-mcp impact detectBashSignificance', false],
  ])('%s → hard error %s', (command, expected) => {
    expect(hard(command, RED_RUN)).toBe(expected);
  });

  // v6.13.2 pre-ship defect review: shapes the heredoc/comment stripper and the
  // substitution splitter got wrong, each against the rule above.
  it('runs the substitutions of an UNQUOTED heredoc body, which bash expands', () => {
    expect(hard('cat > notes.md <<EOF\n$(npm test)\nEOF', RED_RUN)).toBe(true);
    expect(hard('cat > notes.md <<EOF\nrun `npm test` first\nEOF', RED_RUN)).toBe(true);
    expect(hard('cat > notes.md <<-EOF\n\t$(npm test)\n\tEOF', RED_RUN)).toBe(true);
    expect(hard('cat <<EOF | grep x\nit\'s "fine" at $(pwd)\nEOF', SOURCE_QUOTE)).toBe(false);
    // A quoted delimiter, in any spelling, keeps the body literal.
    expect(hard("cat <<'EOF' | grep x\n$(npm test)\nEOF", SOURCE_QUOTE)).toBe(false);
    expect(hard('cat <<\\EOF | grep x\n$(npm test)\nEOF', SOURCE_QUOTE)).toBe(false);
    expect(hard('cat <<E"OF" | grep x\n$(npm test)\nEOF', SOURCE_QUOTE)).toBe(false);
  });

  it('finds the end of a heredoc whose delimiter is escaped or partly quoted', () => {
    expect(hard('cat <<\\EOF > f\nbody\nEOF\nnpm test', RED_RUN)).toBe(true);
    expect(hard('cat <<E"OF" > f\nbody\nEOF\nnpm test', RED_RUN)).toBe(true);
  });

  it('does not read a here-string, an arithmetic shift or a mid-word # as a heredoc or comment', () => {
    expect(hard("grep x <<< 'abc'\nnpm test", RED_RUN)).toBe(true);
    expect(hard('grep -c x $((1<<2)) f\nnpm test', RED_RUN)).toBe(true);
    expect(hard('(( x <<= 2 ))\nnpm test', RED_RUN)).toBe(true);
    expect(hard('grep x a#b\nnpm test', RED_RUN)).toBe(true);
    expect(hard('grep ${x#p} f; npm test', RED_RUN)).toBe(true);
    expect(hard('grep -c x $((1<<2)) f', SOURCE_QUOTE)).toBe(false);
  });

  it('keeps an assignment from a read-only substitution read-only', () => {
    expect(hard('f=$(git ls-files lib | head -1); grep -n TypeError $f', SOURCE_QUOTE)).toBe(false);
    expect(hard('x="$(git grep -l y)"; grep -n TypeError $x', SOURCE_QUOTE)).toBe(false);
    expect(hard('f=$(npm test); grep x $f', RED_RUN)).toBe(true);
    expect(hard('$(npm test)', RED_RUN)).toBe(true);
    expect(hard('cd "$(git rev-parse --show-toplevel)" && grep -n TypeError f', SOURCE_QUOTE)).toBe(false);
    expect(hard('grep -n TypeError "$(date +%F)".log', SOURCE_QUOTE)).toBe(false);
    expect(hard('code-graph-mcp outcome', SOURCE_QUOTE)).toBe(false);
    expect(hard('code-graph-mcp snapshot inspect f.db', SOURCE_QUOTE)).toBe(false);
    expect(hard('code-graph-mcp snapshot create --out f.db', RED_RUN)).toBe(true);
    expect(hard("grep $'a\\'b' f", SOURCE_QUOTE)).toBe(false);
    expect(hard("grep $'a\\'b' f; npm test", RED_RUN)).toBe(true);
  });

  it('judges a substitution inside arithmetic, and an awk program it cannot see', () => {
    expect(hard('grep x $(( $(npm test) + 1 )) f', RED_RUN)).toBe(true);
    expect(hard('awk -f /dev/stdin f <<\'EOF\'\nBEGIN{system("npm test")}\nEOF', RED_RUN)).toBe(true);
    expect(hard('awk -f prog.awk f', RED_RUN)).toBe(true);
  });

  it('counts nested parentheses when closing a substitution', () => {
    expect(hard('grep x $(echo $( (npm test) ) )', RED_RUN)).toBe(true);
    expect(hard('grep x $(git log --format=%s | sed "s/(x)//") f', SOURCE_QUOTE)).toBe(false);
  });

  // v6.13.2 delta review: shapes the repair itself got wrong or left unpinned.
  it('tokenises a command with quotes intact, so a quoted space does not split a word', () => {
    expect(hard('x="a\\ b" grep TypeError f', SOURCE_QUOTE)).toBe(false);
    expect(hard('x="a b" grep -n TypeError f', SOURCE_QUOTE)).toBe(false);
    expect(hard("LC_ALL='C x' grep -n TypeError f", SOURCE_QUOTE)).toBe(false);
    expect(hard('x="a b" npm test', RED_RUN)).toBe(true);
  });

  it('keeps an unquoted heredoc line ending in a backslash, and its quotes, inside the wrapper', () => {
    expect(hard('cat <<EOF | grep x\nfoo \\\nbar\nEOF', SOURCE_QUOTE)).toBe(false);
    expect(hard("cat <<EOF | grep x\na\\\nit's\n$(npm test)\nit's\na\\\nEOF", RED_RUN)).toBe(true);
    expect(hard('cat <<EOF | grep x\na"b\'c\n$(npm test)\nd\'e"f\nEOF', RED_RUN)).toBe(true);
  });

  it("reads $'...' with escapes in every scanner", () => {
    expect(hard("grep $'\\'<<EOF' f \\'\nnpm test", RED_RUN)).toBe(true);
    expect(hard("x=$(grep $'a\\'b' f); grep TypeError $x", SOURCE_QUOTE)).toBe(false);
  });

  it('tells $((arithmetic)) from $( (subshell) ... ) the way bash does', () => {
    expect(hard('grep x $((npm test) | head) f', RED_RUN)).toBe(true);
    expect(hard('grep x $((npm test) ) f', RED_RUN)).toBe(true);
    expect(hard('grep x $(( (1+2) * 3 )) f', SOURCE_QUOTE)).toBe(false);
    expect(hard('grep x $(echo $((1+2))) f', SOURCE_QUOTE)).toBe(false);
  });

  it('treats the path helpers as neutral inside a substitution', () => {
    expect(
      hard('grep -n TypeError "$(basename x)" "$(dirname y)" "$(realpath z)" "$(readlink w)"', SOURCE_QUOTE),
    ).toBe(false);
  });

  it('stays linear on unclosed parentheses', () => {
    const cmd = 'grep x ' + '(('.repeat(50_000);
    const t = Date.now();
    hard(cmd, RED_RUN);
    expect(Date.now() - t).toBeLessThan(1500);
  });

  it('does not throw on deeply nested substitutions', () => {
    const deep = 'grep x ' + '$('.repeat(5000) + 'git log' + ')'.repeat(5000);
    expect(() => hard(deep, RED_RUN)).not.toThrow();
    expect(hard(deep, RED_RUN)).toBe(true);
  });

  it('judges command and process substitutions by what they run', () => {
    expect(hard('grep x $(npm test)', RED_RUN)).toBe(true);
    expect(hard('grep x "$(npm test)"', RED_RUN)).toBe(true);
    expect(hard('diff <(npm test) expected.txt', RED_RUN)).toBe(true);
    expect(hard('grep x `npm test`', RED_RUN)).toBe(true);
    expect(hard('grep x $(cd /r && npm test | tail)', RED_RUN)).toBe(true);
    expect(hard('grep -n TypeError $(git ls-files lib)', SOURCE_QUOTE)).toBe(false);
    expect(hard('diff <(sort a) <(sort b)', SOURCE_QUOTE)).toBe(false);
    expect(hard('grep -c x f | head -$((1 + 2))', SOURCE_QUOTE)).toBe(false);
    expect(hard('grep x $(npm test', RED_RUN)).toBe(true); // unbalanced
  });
});
