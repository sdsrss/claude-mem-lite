// Guard for the CLAUDE_MEM_DIR resolver: a JS `undefined`/`null` stringified
// into the env (or a relative path) must NOT silently become a data directory.
// Regression: benchmark/efficacy-harness.mjs shell-interpolated an undefined
// sandbox → child saw CLAUDE_MEM_DIR='undefined' → the resolver created a
// relative `undefined/` dir at cwd (observed residue at repo root, 2026-06-25).
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';

describe('resolveDataDir', () => {
  const DEFAULT = join(homedir(), '.claude-mem-lite');

  // This suite is the one legitimate user of the P2-4 escape hatch: default resolution
  // IS its subject, and the containment guard exists precisely to stop that default from
  // being handed to anything else in a test run. Turning it off here keeps these cases
  // measuring the resolver rather than the guard — and the guard gets its own cases below.
  beforeEach(() => {
    vi.stubEnv('CLAUDE_MEM_TEST_GUARD', 'off');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('unset (undefined arg) falls back to the homedir default', () => {
    expect(resolveDataDir(undefined)).toBe(DEFAULT);
  });

  test('empty string falls back to the homedir default', () => {
    expect(resolveDataDir('')).toBe(DEFAULT);
  });

  test('a valid absolute path passes through unchanged', () => {
    expect(resolveDataDir('/tmp/mem-sandbox')).toBe('/tmp/mem-sandbox');
  });

  test('the literal string "undefined" throws instead of creating undefined/', () => {
    expect(() => resolveDataDir('undefined')).toThrow(/absolute path/);
  });

  test('the literal string "null" throws', () => {
    expect(() => resolveDataDir('null')).toThrow(/absolute path/);
  });

  test('a relative path throws instead of scattering data under cwd', () => {
    expect(() => resolveDataDir('relative/mem')).toThrow(/absolute path/);
  });
});

// Audit 2026-08-22 P2-4. The v3.73.0 release wrote a rateLimited marker into the live
// data dir from a test, because the module resolved its path at import time and the
// test's env stub landed after. Clearing CLAUDE_MEM_DIR (which vitest.config.mjs does)
// cannot prevent that: the leaking test never reads the var, it takes the default.
describe('resolveDataDir — test-run containment (CLAUDE_MEM_TEST_GUARD)', () => {
  const SANDBOX = '/tmp/mem-test-sandbox-fixture';
  const REAL = '/home/somebody/.claude-mem-lite';

  beforeEach(() => {
    vi.stubEnv('CLAUDE_MEM_TEST_GUARD', '1');
    vi.stubEnv('CLAUDE_MEM_TEST_SANDBOX', SANDBOX);
    vi.stubEnv('CLAUDE_MEM_TEST_REALDIR', REAL);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('redirects the live data dir to the run sandbox', () => {
    expect(resolveDataDir(REAL)).toBe(SANDBOX);
  });

  test('redirects it however it was reached — explicit value or default', () => {
    // Same directory, two spellings. The v3.73 leak arrived by the default path.
    vi.stubEnv('CLAUDE_MEM_TEST_REALDIR', DEFAULT_FOR_GUARD());
    expect(resolveDataDir(undefined)).toBe(SANDBOX);
    expect(resolveDataDir(DEFAULT_FOR_GUARD())).toBe(SANDBOX);
  });

  test('leaves every OTHER absolute dir alone', () => {
    // Isolated fixtures live in three shapes across this suite — os.tmpdir(), a
    // hardcoded /tmp, and tests/.tmp-* inside the repo. An earlier version of the
    // guard redirected anything outside os.tmpdir() and broke all three.
    for (const dir of [
      '/tmp/cjk-prec-test-123',
      '/var/folders/xx/T/vitest-1',
      '/repo/tests/.tmp-prompt-search-dir',
    ]) {
      expect(resolveDataDir(dir)).toBe(dir);
    }
  });

  test('is inert when the guard is not set — production resolves normally', () => {
    vi.stubEnv('CLAUDE_MEM_TEST_GUARD', '');
    expect(resolveDataDir(REAL)).toBe(REAL);
  });

  // Wiring, not seam: the v3.73 leak happened in a SUBPROCESS that inherited the ambient
  // env and never set CLAUDE_MEM_DIR. Everything above would pass with the run-level env
  // never reaching a child. This spawns one the way the e2e suites do.
  test('follows a subprocess that inherited the ambient env', () => {
    vi.unstubAllEnvs(); // use the real run-level env, not fixtures
    const childEnv = { ...process.env };
    delete childEnv.CLAUDE_MEM_DIR; // the mistake being guarded against
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {resolveDataDir} from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../lib/resolve-data-dir.mjs')).href)};` +
          'process.stdout.write(resolveDataDir(process.env.CLAUDE_MEM_DIR));',
      ],
      { env: childEnv, encoding: 'utf8' },
    );
    expect(process.env.CLAUDE_MEM_TEST_SANDBOX, 'global-setup did not export a sandbox').toBeTruthy();
    expect(out).toBe(process.env.CLAUDE_MEM_TEST_SANDBOX);
    expect(out).not.toBe(process.env.CLAUDE_MEM_TEST_REALDIR);
  });
});

function DEFAULT_FOR_GUARD() {
  return join(homedir(), '.claude-mem-lite');
}
