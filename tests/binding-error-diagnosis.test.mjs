// The ABI diagnosis must reach the user, not just the path it happened in.
//
// `probeBindingInFreshProcess`'s error for a stale binding is five lines, and line 0
// is only a filename:
//
//   [0] The module '/…/better_sqlite3.node'
//   [1] was compiled against a different Node.js version using
//   [2] NODE_MODULE_VERSION 127. This version of Node.js requires   ← the diagnosis
//   [3] NODE_MODULE_VERSION 137. Please try re-compiling or re-installing
//   [4] the module (for instance, using `npm rebuild` or `npm install`).
//
// Four surfaces rendered it with `.split('\n')[0]`, so for the one fault family this
// whole subsystem exists to detect, every one of them showed a bare path and dropped
// the ABI numbers. `lib/binding-probe.mjs` even asserts in a comment that this string
// is "the highest-value line doctor prints" — for this family it carried no diagnosis
// at all. Worse on an unowned root, where doctor rendered a path from the ANCESTOR
// tree immediately followed by "this install owns no node_modules": two halves naming
// different trees.
//
// Reproduced live, not from a fixture: on a machine with a stale ~/node_modules
// better-sqlite3, `probeBindingInFreshProcess('/nonexistent-root')` resolves up the
// directory tree and returns exactly the five lines above.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  cpSync,
  existsSync,
} from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { RELEASE_SIGNED_FILES } from '../source-files.mjs';

import { flattenBindingError } from '../lib/binding-probe.mjs';
import { recordNativeBindingBreakage, readNativeBindingBreakage } from '../lib/native-binding-hint.mjs';

const REPO = resolve(import.meta.dirname, '..');

// The real shape, copied from a live probe against a genuinely ABI-127 tree.
const ABI_ERROR = [
  "The module '/home/u/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
  'was compiled against a different Node.js version using',
  'NODE_MODULE_VERSION 127. This version of Node.js requires',
  'NODE_MODULE_VERSION 137. Please try re-compiling or re-installing',
  'the module (for instance, using `npm rebuild` or `npm install`).',
].join('\n');

describe('flattenBindingError', () => {
  it('keeps the ABI numbers — the only part that identifies the fault', () => {
    const out = flattenBindingError(ABI_ERROR);
    expect(out).toContain('NODE_MODULE_VERSION 127');
    expect(out).toContain('NODE_MODULE_VERSION 137');
  });

  it('collapses to a single line, so it cannot split a JSON envelope or a log record', () => {
    const out = flattenBindingError(ABI_ERROR);
    expect(out).not.toContain('\n');
    expect(out.split('\n')).toHaveLength(1);
  });

  it('keeps the offending path too — which tree failed still matters', () => {
    expect(flattenBindingError(ABI_ERROR)).toContain('better_sqlite3.node');
  });

  it('bounds the length so one probe cannot flood a hook receipt', () => {
    const out = flattenBindingError('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(240);
  });

  it('marks truncation rather than ending mid-word with no signal', () => {
    expect(flattenBindingError('y'.repeat(5000))).toMatch(/…$/);
  });

  it('passes a short single-line error through untouched', () => {
    expect(flattenBindingError('Could not locate the bindings file. Tried: x')).toBe(
      'Could not locate the bindings file. Tried: x',
    );
  });

  it('survives null / undefined / a thrown non-Error', () => {
    expect(flattenBindingError(null)).toBe('unknown');
    expect(flattenBindingError(undefined)).toBe('unknown');
    expect(flattenBindingError({ toString: () => 'weird' })).toBe('weird');
  });
});

describe('the diagnosis reaches every surface that renders it', () => {
  let runtimeDir;
  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'mem-abidiag-'));
  });
  afterEach(() => {
    try {
      rmSync(runtimeDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('the persisted breakage marker keeps the ABI numbers', () => {
    // doctor reads this back hours later as "a fire failed ~Nh ago (<reason>)". A bare
    // path there tells the user nothing about what to do.
    recordNativeBindingBreakage(runtimeDir, { reason: ABI_ERROR, event: 'PreToolUse' });
    const back = readNativeBindingBreakage(runtimeDir);
    expect(back.reason).toContain('NODE_MODULE_VERSION 127');
    expect(back.reason).not.toContain('\n');
  });

  it("doctor's per-root message keeps the ABI numbers", async () => {
    const { probeRuntimeRoots } = await import('../lib/install-shape.mjs');
    const [r] = probeRuntimeRoots([{ label: 'managed install', root: '/nowhere', ownDeps: true }], {
      probe: () => ({ ok: false, error: ABI_ERROR }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('NODE_MODULE_VERSION 127');
    expect(r.error).toContain('NODE_MODULE_VERSION 137');
    expect(r.error).not.toContain('\n');
  });

  // The lib/-less fallback in scripts/binding-probe-cli.mjs carries a hand-copied
  // twin of flattenBindingError, because it runs precisely when lib/ could not be
  // imported. A comment said "keep the two in step" and they were already out of step
  // by the ellipsis. Driven as a subprocess in a tree with NO lib/, which is the only
  // way to reach that branch (importing the script would run its top-level exit).
  it("bareProbe's inlined flattener matches the shared helper, in a tree with no lib/", () => {
    const root = mkdtempSync(join(tmpdir(), 'mem-bareprobe-'));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      copyFileSync(
        join(REPO, 'scripts', 'binding-probe-cli.mjs'),
        join(root, 'scripts', 'binding-probe-cli.mjs'),
      );
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'claude-mem-lite', version: '9.9.9' }),
      );
      // No lib/ at all → the helper import throws → bareProbe is the only path left.
      const pkgDir = join(root, 'node_modules', 'better-sqlite3');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'better-sqlite3', version: '0.0.0', main: 'index.js' }),
      );
      // Throw the real five-line ABI shape.
      writeFileSync(join(pkgDir, 'index.js'), `throw new Error(${JSON.stringify(ABI_ERROR)});\n`);

      const r = spawnSync(process.execPath, [join(root, 'scripts', 'binding-probe-cli.mjs')], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, PROBE_ROOT: root, CLAUDE_MEM_DIR: root },
      });
      const err = r.stderr || '';
      expect(err, `bareProbe printed nothing usable:\n${err}`).toMatch(/binding probe:/);
      // The diagnosis must survive here too — this is the half-installed tree, the
      // case where the user most needs to know what went wrong.
      expect(err).toContain('NODE_MODULE_VERSION 127');
      expect(err).toContain('NODE_MODULE_VERSION 137');
      // Parity with the shared helper on the same input.
      const shared = flattenBindingError(ABI_ERROR);
      expect(err).toContain(shared);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('an unowned root still names its own tree alongside the ancestor path it failed in', async () => {
    const { probeRuntimeRoots } = await import('../lib/install-shape.mjs');
    const [r] = probeRuntimeRoots([{ label: 'managed install', root: '/opt/app', ownDeps: false }], {
      probe: () => ({ ok: false, error: ABI_ERROR }),
    });
    // Both facts have to be legible together: where it failed, and that this install
    // has nothing of its own to rebuild.
    expect(r.error).toContain('better_sqlite3.node');
    expect(r.error).toContain('owns no node_modules');
    expect(r.repair).toContain('npm install');
  });
});

// scripts/launch.mjs provisions a plugin-cache version dir on the first MCP launch
// after every plugin update (Claude Code materializes those dirs WITHOUT
// node_modules), so its npm-install catch is a normal failure surface.
//
// This suite exists to PIN a negative result, because a pre-tag review concluded that
// `e.message.split('\n')[0]` there loses npm's diagnosis the same way the four
// binding-error sites did. Measured, it does not: launch.mjs runs npm with stderr
// **inherit**, so npm's own `npm error code …` lines reach the user's terminal
// directly and `e.message` legitimately holds only "Command failed: <cmd>". The review
// measured `e.message` under `stdio: 'pipe'`, where stderr IS folded into the message.
//
// Pinned so the next reader does not "fix" it by piping stderr — piping is what made
// a compiling better-sqlite3 look hung under the 5-min bash timeout (bug audit
// 2026-05), which is why stderr is inherited in the first place.
describe('launch.mjs npm-install failure: npm speaks for itself on inherited stderr', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mem-launchfail-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    copyFileSync(join(REPO, 'scripts', 'launch.mjs'), join(root, 'scripts', 'launch.mjs'));
  });
  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // `npm` here is a STUB first on PATH, not the real one. Audit 2026-09-05 P2-11: this
  // case used to run a genuine `npm install` and wait up to 180 s for npm's own stderr,
  // which made it the suite's one randomly-red case — it is the failure that sat as P2-8
  // "Uncertain, could not be reproduced" for two audit rounds until the ruler learned to
  // print the failing test's name. Under a full parallel run npm had not written its
  // diagnosis before the timeout, so stderr held only our own "Installing
  // dependencies…" line.
  //
  // The stub keeps the whole property, rather than trading it away: `launch.mjs` runs
  // `execSync('npm install --omit=dev')`, which resolves `npm` through PATH, so the stub
  // IS npm as far as launch.mjs is concerned. It writes an `npm error code …` line to
  // stderr and exits 1 — instantly, with no network and no package.json trickery. If
  // someone switches that `stdio` to 'pipe' to "capture" the diagnosis, execSync folds
  // the stub's stderr into `e.message` instead, `.split('\n')[0]` yields "Command
  // failed: …", and the first assertion below goes red exactly as it did with real npm.
  //
  // The code is EFAKESTUB rather than a generic pattern so the substitution is
  // observable: if PATH shadowing ever stopped working and the real npm ran, this
  // assertion fails by name instead of silently restoring the flake.
  function fakeNpmBin(dir) {
    const binDir = join(dir, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    const script = join(binDir, 'npm');
    writeFileSync(
      script,
      [
        '#!/usr/bin/env bash',
        'echo "npm error code EFAKESTUB" >&2',
        'echo "npm error stub refused to install" >&2',
        'exit 1',
      ].join('\n') + '\n',
    );
    chmodSync(script, 0o755);
    return binDir;
  }

  it.skipIf(process.platform === 'win32')(
    "delivers npm's own diagnosis plus an actionable repair",
    () => {
      // The guard opens on missing node_modules/better-sqlite3 alone (launch.mjs:13), so
      // npm runs — and the stub is what answers.
      const binDir = fakeNpmBin(root);
      const r = spawnSync(process.execPath, [join(root, 'scripts', 'launch.mjs')], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          CLAUDE_PLUGIN_ROOT: root,
          CLAUDE_MEM_DIR: root,
        },
      });
      const err = r.stderr || '';
      // npm's diagnosis arrives on inherited stderr — this is the assertion that would
      // break if someone switched stdio to 'pipe' to "capture" it.
      expect(err, `npm's own diagnosis did not reach stderr:\n${err}`).toMatch(/npm error code EFAKESTUB/);
      // …and our own framing still names the directory and the repair.
      expect(err).toMatch(/npm install failed in/);
      expect(err).toMatch(/Repair: cd /);
      expect(r.status).toBe(1);
    },
    60_000,
  );
});

// D#307. A runtime dir install.lock cannot be created in (a sudo run left it root-owned): the MCP
// launcher retried acquireLock 20 x 500 ms on EVERY launch before its probe-only pass, and both it
// and the SessionStart probe then said another install/repair held the lock, which none did. The
// binding here is better-sqlite3 13's own loader with no addon, so the probe fails fast and neither
// arm can reach a rebuild.
describe('a runtime dir install.lock cannot be taken in: the launcher and the session probe say so', () => {
  let root;
  let runtime;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mem-lockblocked-'));
    for (const rel of [...RELEASE_SIGNED_FILES, 'package.json']) {
      if (!existsSync(join(REPO, rel))) continue;
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      copyFileSync(join(REPO, rel), join(root, rel));
    }
    const pkg = join(root, 'node_modules', 'better-sqlite3');
    mkdirSync(pkg, { recursive: true });
    cpSync(join(REPO, 'node_modules', 'better-sqlite3', 'lib'), join(pkg, 'lib'), { recursive: true });
    copyFileSync(join(REPO, 'node_modules', 'better-sqlite3', 'package.json'), join(pkg, 'package.json'));
    runtime = join(root, 'data', 'runtime');
    mkdirSync(runtime, { recursive: true });
    chmodSync(runtime, 0o555);
  });
  afterEach(() => {
    chmodSync(runtime, 0o755);
    rmSync(root, { recursive: true, force: true });
  });
  const env = () => ({
    ...process.env,
    CLAUDE_PLUGIN_ROOT: root,
    PROBE_ROOT: root,
    CLAUDE_MEM_DIR: join(root, 'data'),
  });
  const blocked = () =>
    new RegExp(
      `install\\.lock cannot be taken — ${runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} cannot be written \\(EACCES\\)`,
    );

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'launch.mjs does not wait 10 s for a lock nothing holds, and names the directory',
    () => {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [join(root, 'scripts', 'launch.mjs')], {
        encoding: 'utf8',
        timeout: 60_000,
        env: env(),
      });
      const elapsed = Date.now() - t0;
      const err = r.stderr || '';
      expect(err).toMatch(/better-sqlite3 binding unusable: Cannot find module/); // premise: probe-only pass
      expect(err).not.toMatch(/another install\/repair holds the lock/);
      expect(err).toMatch(blocked());
      expect(r.status).toBe(1);
      expect(elapsed, err).toBeLessThan(8000); // the retry loop alone was 20 x 500 ms
    },
    90_000,
  );

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'the SessionStart binding probe does not blame an install in flight',
    () => {
      const r = spawnSync(process.execPath, [join(root, 'scripts', 'binding-probe-cli.mjs')], {
        encoding: 'utf8',
        timeout: 60_000,
        env: env(),
      });
      const err = r.stderr || '';
      expect(err).toMatch(/binding probe: .*Cannot find module/); // premise
      expect(err).not.toMatch(/another install\/repair in flight/);
      expect(err).toMatch(blocked());
      expect(r.status).toBe(1);
    },
    90_000,
  );
});
