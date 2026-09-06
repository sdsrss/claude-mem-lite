// native-binding-selfheal.test.mjs — the ABI-stale binding must self-heal from
// EVERY entry point, not just an MCP server start.
//
// Field failure this guards (2026-08-13): a Node 22 → 24 upgrade (ABI 127 → 137)
// left better_sqlite3.node stale. lib/binding-probe.mjs's rebuild was wired ONLY
// into scripts/launch.mjs (MCP start) and install.mjs. The user's sessions ran
// hooks + CLI without ever starting the MCP server, so nothing healed: the DB
// went 4 days without a write and one day's hook-errors log held 79 consecutive
// ERR_DLOPEN_FAILED entries, while the only user-visible signal was a 6h
// rate-limited stderr WARN. The three contracts below close that:
//   1. one shared classifier for the fault family (no per-call-site regex),
//   2. the CLI heals itself and RE-EXECS (an in-process retry after a rebuild
//      dies with "Module did not self-register" — the .node is already dlopen'd),
//   3. a breakage marker is recorded on EVERY failing fire (even when the hint
//      is rate-limited) so the next session-start can heal unattended.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { acquireLock } from '../lib/proc-lock.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  isNativeBindingError,
  healAndReexec,
  ensureBetterSqlite3Working,
  NATIVE_BINDING_REBUILD_CMD,
  NATIVE_BINDING_SOURCE_BUILD_CMD,
  BINDING_HEAL_GUARD_ENV,
} from '../lib/binding-probe.mjs';
import {
  formatHookError,
  recordNativeBindingBreakage,
  readNativeBindingBreakage,
  clearNativeBindingBreakage,
  NATIVE_BINDING_BROKEN_MARKER,
} from '../lib/native-binding-hint.mjs';
import { recordHookError } from '../lib/hook-telemetry.mjs';

describe('isNativeBindingError — one classifier for the whole fault family', () => {
  it('classifies ERR_DLOPEN_FAILED by code', () => {
    expect(isNativeBindingError(Object.assign(new Error('x'), { code: 'ERR_DLOPEN_FAILED' }))).toBe(true);
  });

  it('classifies the ABI-mismatch message (the field failure)', () => {
    expect(
      isNativeBindingError(
        new Error(
          "The module '/x/better_sqlite3.node'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 127. This version of Node.js requires\nNODE_MODULE_VERSION 137.",
        ),
      ),
    ).toBe(true);
  });

  it('classifies the bindings-not-found message (stale/absent build dir)', () => {
    expect(isNativeBindingError(new Error('Could not locate the bindings file. Tried: ...'))).toBe(true);
  });

  it('classifies "did not self-register" (rebuild landed under an already-dlopen\'d module)', () => {
    expect(isNativeBindingError(new Error("Module did not self-register: '/x/better_sqlite3.node'."))).toBe(
      true,
    );
  });

  it('does NOT classify a corrupt-DB error — a rebuild cannot fix data corruption', () => {
    expect(
      isNativeBindingError(
        Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }),
      ),
    ).toBe(false);
  });

  it('does NOT classify unrelated errors, null, or undefined', () => {
    expect(isNativeBindingError(new Error('boom'))).toBe(false);
    expect(isNativeBindingError(null)).toBe(false);
    expect(isNativeBindingError(undefined)).toBe(false);
  });

  it('exports the exact rebuild command (npm >= 12 needs the allow-scripts bypass)', () => {
    expect(NATIVE_BINDING_REBUILD_CMD).toContain('npm rebuild better-sqlite3');
    expect(NATIVE_BINDING_REBUILD_CMD).toContain('--dangerously-allow-all-scripts');
  });
});

// v4.0.0. better-sqlite3 13 carries NO install script — it ships prebuilds instead — so
// `npm rebuild better-sqlite3` has nothing to run and exits 0 printing "rebuilt dependencies
// successfully" while producing no `.node`. On a platform 13 ships no prebuild for, the heal
// chain therefore reported success over a still-broken install. These pin the source-compile
// fallback that closes it, and pin that it does NOT fire when the npm path already worked.
describe('ensureBetterSqlite3Working — source-compile fallback when npm rebuild heals nothing', () => {
  it('falls through to the source build when rebuild exits 0 but the binding is still dead', async () => {
    const cmds = [];
    let verifyCalls = 0;
    const r = await ensureBetterSqlite3Working('/inst', {
      probe: () => ({ ok: false, error: 'Could not locate the bindings file' }),
      // Dead after the npm rebuild (call 1), alive after the source build (call 2).
      verify: () => ({ ok: ++verifyCalls >= 2, error: 'still dead' }),
      exec: (cmd) => cmds.push(cmd),
    });
    expect(r).toEqual({ ok: true, action: 'compiled' });
    expect(cmds).toEqual([NATIVE_BINDING_REBUILD_CMD, NATIVE_BINDING_SOURCE_BUILD_CMD]);
  });

  it('does NOT run the source build when npm rebuild already fixed it', async () => {
    const cmds = [];
    const r = await ensureBetterSqlite3Working('/inst', {
      probe: () => ({ ok: false, error: 'dead' }),
      verify: () => ({ ok: true }),
      exec: (cmd) => cmds.push(cmd),
    });
    expect(r).toEqual({ ok: true, action: 'rebuilt' });
    expect(cmds).toEqual([NATIVE_BINDING_REBUILD_CMD]);
  });

  it('reports the source build failing instead of claiming a heal', async () => {
    const r = await ensureBetterSqlite3Working('/inst', {
      probe: () => ({ ok: false, error: 'dead' }),
      verify: () => ({ ok: false, error: 'still dead' }),
      exec: (cmd) => {
        if (cmd === NATIVE_BINDING_SOURCE_BUILD_CMD) throw new Error('no compiler');
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('source build failed');
    expect(r.error).toContain('no compiler');
  });

  it('the source-build command targets the package, not the project', () => {
    // A bare `npm run build-release` in the project would run OUR script of that name (or
    // none); it has to be --prefix'd into node_modules/better-sqlite3.
    expect(NATIVE_BINDING_SOURCE_BUILD_CMD).toContain('--prefix node_modules/better-sqlite3');
    expect(NATIVE_BINDING_SOURCE_BUILD_CMD).toContain('build-release');
  });
});

describe('healAndReexec — CLI-side heal must re-exec, never retry in-process', () => {
  const baseDeps = () => ({
    calls: { ensure: 0, reexec: 0, logs: [] },
  });

  it('rebuilds and RE-EXECS with the original argv, returning the child exit code', async () => {
    const c = baseDeps().calls;
    let reexecArgs = null;
    const r = await healAndReexec({
      installDir: '/some/dir',
      argv: ['/usr/bin/node', '/x/cli.mjs', 'save', 'hello'],
      env: {},
      ensure: async () => {
        c.ensure++;
        return { ok: true, action: 'rebuilt' };
      },
      reexec: (argv, env) => {
        c.reexec++;
        reexecArgs = { argv, env };
        return 0;
      },
      log: (m) => c.logs.push(m),
    });
    expect(r).toEqual({ healed: true, exitCode: 0 });
    expect(c.ensure).toBe(1);
    expect(c.reexec).toBe(1);
    expect(reexecArgs.argv).toEqual(['/usr/bin/node', '/x/cli.mjs', 'save', 'hello']);
    // The guard must ride along, or a still-broken binding re-execs forever.
    expect(reexecArgs.env[BINDING_HEAL_GUARD_ENV]).toBe('1');
  });

  it('propagates a non-zero child exit code instead of masking it as success', async () => {
    const r = await healAndReexec({
      installDir: '/some/dir',
      argv: ['node', 'cli.mjs', 'search', 'x'],
      env: {},
      ensure: async () => ({ ok: true, action: 'rebuilt' }),
      reexec: () => 3,
      log: () => {},
    });
    expect(r).toEqual({ healed: true, exitCode: 3 });
  });

  it('refuses to loop: with the guard env already set it neither rebuilds nor re-execs', async () => {
    const c = baseDeps().calls;
    const r = await healAndReexec({
      installDir: '/some/dir',
      argv: ['node', 'cli.mjs', 'stats'],
      env: { [BINDING_HEAL_GUARD_ENV]: '1' },
      ensure: async () => {
        c.ensure++;
        return { ok: true, action: 'rebuilt' };
      },
      reexec: () => {
        c.reexec++;
        return 0;
      },
      log: (m) => c.logs.push(m),
    });
    expect(r.healed).toBe(false);
    expect(r.reason).toBe('already-attempted');
    expect(c.ensure).toBe(0);
    expect(c.reexec).toBe(0);
  });

  it('does NOT re-exec when the rebuild fails, and surfaces the reason', async () => {
    const c = baseDeps().calls;
    const r = await healAndReexec({
      installDir: '/some/dir',
      argv: ['node', 'cli.mjs', 'stats'],
      env: {},
      ensure: async () => {
        c.ensure++;
        return { ok: false, error: 'no prebuild, no compiler' };
      },
      reexec: () => {
        c.reexec++;
        return 0;
      },
      log: (m) => c.logs.push(m),
    });
    expect(r.healed).toBe(false);
    expect(r.reason).toBe('rebuild-failed');
    expect(r.error).toContain('no prebuild');
    expect(c.reexec).toBe(0);
  });

  it('treats a throwing rebuild as a failed heal rather than crashing the CLI', async () => {
    const r = await healAndReexec({
      installDir: '/some/dir',
      argv: ['node', 'cli.mjs', 'stats'],
      env: {},
      ensure: async () => {
        throw new Error('npm missing');
      },
      reexec: () => 0,
      log: () => {},
    });
    expect(r.healed).toBe(false);
    expect(r.error).toContain('npm missing');
  });
});

describe('native-binding breakage marker — the unattended-heal trigger', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cml-nbb-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records reason + event + ts, and reads back', () => {
    recordNativeBindingBreakage(dir, {
      reason: 'ABI 127 vs 137',
      event: 'user-prompt',
      now: 1_700_000_000_000,
    });
    expect(existsSync(join(dir, NATIVE_BINDING_BROKEN_MARKER))).toBe(true);
    const b = readNativeBindingBreakage(dir);
    expect(b.reason).toContain('127');
    expect(b.event).toBe('user-prompt');
    expect(b.ts).toBe(1_700_000_000_000);
  });

  it('reads null when absent, and clear() is idempotent', () => {
    expect(readNativeBindingBreakage(dir)).toBeNull();
    clearNativeBindingBreakage(dir);
    recordNativeBindingBreakage(dir, { reason: 'x', event: 'stop', now: 1 });
    clearNativeBindingBreakage(dir);
    clearNativeBindingBreakage(dir);
    expect(readNativeBindingBreakage(dir)).toBeNull();
  });

  it('reads null on a torn/garbage marker instead of throwing', () => {
    writeFileSync(join(dir, NATIVE_BINDING_BROKEN_MARKER), '{not json');
    expect(readNativeBindingBreakage(dir)).toBeNull();
  });

  it('is written on EVERY failing fire, including ones whose hint is rate-limited', () => {
    const err = Object.assign(new Error('ABI 127 vs 137'), { code: 'ERR_DLOPEN_FAILED' });
    const NOW = 1_700_000_000_000;
    // First fire: hint due, marker written.
    expect(formatHookError(err, 'session-start', { now: NOW, runtimeDir: dir })).not.toBeNull();
    clearNativeBindingBreakage(dir);
    // Second fire: hint suppressed (same fault, inside cooldown) — the marker
    // must STILL be recorded, else a silenced hint also silences the heal.
    expect(formatHookError(err, 'stop', { now: NOW + 1000, runtimeDir: dir })).toBeNull();
    expect(readNativeBindingBreakage(dir)).not.toBeNull();
  });

  it('does not record a marker for unrelated hook errors', () => {
    formatHookError(new Error('boom'), 'stop', { now: 1_700_000_000_000, runtimeDir: dir });
    expect(readNativeBindingBreakage(dir)).toBeNull();
  });
});

// The field outage's 79 log entries came from scripts/pre-tool-recall.js and
// scripts/pre-skill-bridge.js — STANDALONE hook scripts that never import
// hook.mjs, so hook.mjs's dispatch catch (and its marker) could not see them.
// recordHookError is the one choke point every hook script funnels through, so
// the flag lives there and covers scripts written later for free.
describe('recordHookError — the standalone hook scripts must arm the heal too', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cml-nbt-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags a native-binding db-open failure from a standalone script', () => {
    const err = Object.assign(new Error('NODE_MODULE_VERSION 127 vs 137'), { code: 'ERR_DLOPEN_FAILED' });
    recordHookError('pre-recall:db-open', err, dir);
    const b = readNativeBindingBreakage(dir);
    expect(b).not.toBeNull();
    expect(b.event).toBe('pre-recall:db-open');
  });

  it('leaves ordinary hook errors unflagged — no npm run for a query bug', () => {
    recordHookError('pre-recall:query', new Error('no such column: foo'), dir);
    expect(readNativeBindingBreakage(dir)).toBeNull();
  });

  it('still writes its JSONL shard (the flag is additive, not a replacement)', () => {
    recordHookError(
      'skill-bridge:db-open',
      Object.assign(new Error('x'), { code: 'ERR_DLOPEN_FAILED' }),
      dir,
    );
    expect(existsSync(join(dir, 'hook-errors'))).toBe(true);
  });
});

// The repair the hint names must EXIST and be cheap: `repair` re-downloads a
// signed release over the network, which is the wrong tool (and unavailable
// offline) for a local ABI rebuild.
describe('cli.mjs rebuild-binding — the local, network-free repair command', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

  it('is routed by cli.mjs and reports a healthy binding without rebuilding', () => {
    // Isolated data dir: the command takes runtime/install.lock and clears the
    // breakage marker, so the default (~/.claude-mem-lite) would contend with a
    // live session's lock — flaky here, and mutating real state from a test.
    const dataDir = mkdtempSync(join(tmpdir(), 'cml-rb-'));
    // Isolated HOME too, since v3.70.0: rebuild-binding now repairs EVERY code home
    // it can find, and with the real HOME that includes ~/.claude/plugins/cache/…,
    // where a freshly-installed plugin version ships node_modules with no compiled
    // binding (#10631). This test would then run a real
    // `npm rebuild better-sqlite3 --dangerously-allow-all-scripts` inside ~/.claude
    // and could fail its own exit-0 assertion — a unit test mutating user state
    // (§8.V3). An empty HOME keeps the repo the only discoverable root, which is what
    // the test's name promises.
    const fakeHome = mkdtempSync(join(tmpdir(), 'cml-rb-home-'));
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'cli.mjs'), 'rebuild-binding'], {
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, CLAUDE_MEM_DIR: dataDir, HOME: fakeHome },
    });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toMatch(/Unknown command/);
    expect(r.status).toBe(0);
    expect(out).toMatch(/better-sqlite3/);
    // This repo's binding is healthy in CI → the probe short-circuits.
    expect(out).toMatch(/verified|rebuilt/);
  });

  it('exits NON-zero when another install holds the lock — skipping is not healing', () => {
    // Callers key their state on this exit code: a false 0 would let the launcher
    // drop its cooldown (npm re-spawned every session) and let the CLI re-exec
    // straight back into the same broken binding.
    const dataDir = mkdtempSync(join(tmpdir(), 'cml-rb-lock-'));
    try {
      mkdirSync(join(dataDir, 'runtime'), { recursive: true });
      const release = acquireLock(join(dataDir, 'runtime', 'install.lock'));
      expect(release).toBeTruthy();
      try {
        const r = spawnSync(process.execPath, [join(REPO_ROOT, 'cli.mjs'), 'rebuild-binding'], {
          encoding: 'utf8',
          timeout: 300_000,
          env: { ...process.env, CLAUDE_MEM_DIR: dataDir },
        });
        expect(r.status).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toMatch(/in progress/i);
      } finally {
        release();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('formatHookError — the hint must name a repair that actually applies', () => {
  const NOW = 1_700_000_000_000;
  const err = () => Object.assign(new Error('NODE_MODULE_VERSION 127 vs 137'), { code: 'ERR_DLOPEN_FAILED' });

  it('promises the session-start heal, not an MCP server start the user may never do', () => {
    const line = formatHookError(err(), 'stop', { now: NOW });
    expect(line).toContain('session start');
    expect(line).not.toContain('MCP server start');
  });

  it('points at rebuild-binding, not the network-dependent full repair', () => {
    const line = formatHookError(err(), 'stop', { now: NOW });
    expect(line).toContain('rebuild-binding');
    // `repair` re-downloads + signature-verifies a whole release and fails closed
    // offline — wrong-sized (and often impossible) for a local ABI rebuild.
    expect(line).not.toMatch(/cli\.mjs repair/);
  });
});
