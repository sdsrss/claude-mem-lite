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
