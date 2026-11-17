// D#859. ensureBetterSqlite3Working's default exec capped EVERY step at 240 s, the source
// build included. execSync's timeout signals only its direct child, the shell it starts, so a
// compile that ran past the cap kept running while the heal reported failure, put the
// shadowing prebuild back and released install.lock (measured with stand-ins: execSync of an
// `npm run` script that sleeps returned ETIMEDOUT at 2006 ms with the script's `sleep` still
// running). The platforms that need the compile are the ones 13 ships no prebuild for; how
// long it takes there was never measured. The design already said the compile belongs on a
// path with no time budget (the sourceBuild comment in lib/binding-probe.mjs); the default
// exec did not follow it.
//
// Asserted at the execSync call, through the module's own default exec: an injected `exec`
// would show what the call sites pass, not what reaches the OS.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { calls, failCmd } = vi.hoisted(() => ({ calls: [], failCmd: { value: null } }));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execSync: vi.fn((cmd, opts) => {
      calls.push({ cmd, opts });
      if (cmd === failCmd.value) throw new Error(`stub: ${cmd} failed`);
      return '';
    }),
  };
});

const { ensureBetterSqlite3Working, NATIVE_BINDING_REBUILD_CMD, NATIVE_BINDING_SOURCE_BUILD_CMD } =
  await import('../lib/binding-probe.mjs');

/** Probe fails, the npm-step verify fails, the post-compile verify passes. */
function stubs() {
  let verifies = 0;
  return {
    probe: () => ({ ok: false, error: 'stale binding' }),
    verify: () => (++verifies < 2 ? { ok: false, error: 'still stale' } : { ok: true }),
  };
}

// No node_modules under this root, so resolvedPrebuildPath finds no prebuild to quarantine
// without spawning anything.
const ROOT = '/nonexistent-cml-d859-root';

beforeEach(() => {
  calls.length = 0;
  failCmd.value = null;
});

describe('ensureBetterSqlite3Working default exec (D#859)', () => {
  it('runs the source build with no time cap', async () => {
    const r = await ensureBetterSqlite3Working(ROOT, stubs());
    expect(r).toEqual({ ok: true, action: 'compiled' });
    const compile = calls.find((c) => c.cmd === NATIVE_BINDING_SOURCE_BUILD_CMD);
    expect(compile, 'the compile step must have run through execSync').toBeDefined();
    expect(compile.opts.timeout).toBeUndefined();
  });

  it('still caps the npm step at 240 s', async () => {
    await ensureBetterSqlite3Working(ROOT, stubs());
    const npmStep = calls.find((c) => c.cmd === NATIVE_BINDING_REBUILD_CMD);
    expect(npmStep.opts.timeout).toBe(240_000);
  });

  it('still caps the plain npm rebuild it falls back to at 240 s', async () => {
    failCmd.value = NATIVE_BINDING_REBUILD_CMD;
    await ensureBetterSqlite3Working(ROOT, stubs());
    const fallback = calls.find((c) => c.cmd === 'npm rebuild better-sqlite3');
    expect(fallback, 'the fallback must have run').toBeDefined();
    expect(fallback.opts.timeout).toBe(240_000);
  });
});
