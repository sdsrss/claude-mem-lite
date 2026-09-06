// Integration tests for scripts/hook-launcher.mjs — the self-heal wrapper
// that detects ERR_MODULE_NOT_FOUND under the install dir and runs
// install.mjs repair before retrying. Spawned-process tests (vs unit tests)
// because the launcher derives its install dir from __dirname and the whole
// point of the wrapper is what happens at process boundaries.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SRC_LAUNCHER = join(REPO_ROOT, 'scripts', 'hook-launcher.mjs');

const tracked = new Set();
function makeInstall(prefix) {
  const root = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(SRC_LAUNCHER, join(root, 'scripts', 'hook-launcher.mjs'));
  tracked.add(root);
  return root;
}

afterEach(() => {
  for (const d of tracked) rmSync(d, { recursive: true, force: true });
  tracked.clear();
});

function runLauncher(root, args, env = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'hook-launcher.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_MEM_DIR: root, ...env },
  });
}

// A20260905-R5-Q2: the module-missing repair is SESSION-START ONLY. `install.mjs repair`
// is a synchronous spawn with a 300s timeout, and hooks/hooks.json gives the hot-path events
// 2-5s — and because the 6h cooldown is armed BEFORE the spawn (concurrent-fire rate
// limiting), a repair the host killed at 2s used to buy six hours of "Self-heal skipped",
// including for the SessionStart fire that could have finished it. Every case below that
// asserts a heal therefore passes `session-start` as the event; the two cases at the end of
// this block assert the hot path declines, and the breakage-marker case deliberately does
// NOT pass it — recording breakage is common to both paths.
describe('hook-launcher self-heal', () => {
  it('passes through when the target entry imports cleanly', () => {
    const root = makeInstall('cml-launcher-pass');
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-OK\\n");\n');
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ENTRY-OK');
  });

  it('forwards positional argv to the entry as process.argv[2..]', () => {
    const root = makeInstall('cml-launcher-argv');
    writeFileSync(
      join(root, 'entry.mjs'),
      'process.stdout.write("ARGV=" + JSON.stringify(process.argv.slice(2)) + "\\n");\n',
    );
    const r = runLauncher(root, ['entry.mjs', 'session-start', '--flag', 'value']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ARGV=["session-start","--flag","value"]');
  });

  it('exits 1 with usage error when no entry is provided', () => {
    const root = makeInstall('cml-launcher-noarg');
    const r = runLauncher(root, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing entry argument/);
  });

  it('does NOT self-heal on errors other than ERR_MODULE_NOT_FOUND', () => {
    const root = makeInstall('cml-launcher-other');
    writeFileSync(join(root, 'install.mjs'), 'console.error("SHOULD-NOT-RUN");process.exit(1);\n');
    writeFileSync(join(root, 'entry.mjs'), 'throw new Error("plain runtime error");\n');
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toMatch(/SHOULD-NOT-RUN/);
    expect(r.stderr).not.toMatch(/Detected broken install/);
    expect(r.stderr).toMatch(/plain runtime error/);
  });

  it('runs install.mjs repair on local ERR_MODULE_NOT_FOUND and records cooldown', () => {
    const root = makeInstall('cml-launcher-heal');
    // Stub install.mjs simulating a failed repair (no network in tests).
    // attemptHeal returns false; the launcher then degrades quietly (exit 0)
    // instead of re-throwing the original import error as a stack trace.
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-ATTEMPTED");process.exit(1);\n');
    writeFileSync(join(root, 'entry.mjs'), "import './missing-local.mjs';\n");

    const first = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(first.stderr).toMatch(/Detected broken install/);
    expect(first.stderr).toMatch(/REPAIR-ATTEMPTED/);
    expect(first.status).toBe(0);
    expect(first.stderr).not.toMatch(/node:internal|ERR_MODULE_NOT_FOUND/);
    expect(existsSync(join(root, 'runtime', 'hook-launcher-lastheal'))).toBe(true);

    // Second invocation within cooldown skips repair and still degrades quietly
    // (clean guidance, exit 0, no stack trace) rather than failing every fire.
    const second = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(second.stderr).not.toMatch(/REPAIR-ATTEMPTED/);
    expect(second.stderr).toMatch(/Self-heal skipped/);
    expect(second.status).toBe(0);
    expect(second.stderr).not.toMatch(/node:internal|ERR_MODULE_NOT_FOUND/);
  });

  it('treats a missing bare dependency (e.g. better-sqlite3) as a broken install, not a foreign error', () => {
    // Root-cause regression: a half-installed/missing npm dependency throws
    // ERR_MODULE_NOT_FOUND with e.url UNDEFINED and message "Cannot find
    // package '<name>' imported from <importer>". The pre-fix classifier keyed
    // off file://INSTALL_DIR and misread this as a foreign error → re-threw a
    // Node stack trace on every hook fire (the Stop-hook noise users saw).
    const root = makeInstall('cml-launcher-baredep');
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-ATTEMPTED");process.exit(1);\n');
    // entry imports a bare package that does not exist — mirrors schema.mjs →
    // better-sqlite3 during a half-finished npm install.
    writeFileSync(join(root, 'entry.mjs'), "import x from 'better-sqlite3-nope-xyz';\n");

    const r = runLauncher(root, ['entry.mjs', 'session-start']);
    // Recognized as ours → self-heal attempted (vs silently re-thrown).
    expect(r.stderr).toMatch(/Detected broken install/);
    expect(r.stderr).toMatch(/REPAIR-ATTEMPTED/);
    // Best-effort hook: degrades to exit 0 with no raw Node stack trace.
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/node:internal/);
  });

  it('re-runs the entry after a successful self-heal', () => {
    const root = makeInstall('cml-launcher-heal-retry');
    // install.mjs stub writes the missing module then exits 0 (simulates a
    // successful repair). Launcher should then re-import the entry and succeed.
    writeFileSync(
      join(root, 'install.mjs'),
      `import { writeFileSync, mkdirSync } from 'fs';\n` +
        `import { join, dirname } from 'path';\n` +
        `import { fileURLToPath } from 'url';\n` +
        `const __dirname = dirname(fileURLToPath(import.meta.url));\n` +
        `const target = join(__dirname, 'missing-local.mjs');\n` +
        `mkdirSync(dirname(target), { recursive: true });\n` +
        `writeFileSync(target, 'process.stdout.write("HEALED-OK\\\\n");\\n');\n` +
        `process.exit(0);\n`,
    );
    writeFileSync(join(root, 'entry.mjs'), "import './missing-local.mjs';\n");

    const r = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(r.stderr).toMatch(/Detected broken install/);
    expect(r.stdout).toContain('HEALED-OK');
    expect(r.status).toBe(0);
  });

  it('re-throws a foreign/typo bare dependency NOT in package.json (surfaces the packaging bug)', () => {
    // #5/#7: a missing bare package imported from an install-dir file was
    // blanket-classified as ours → self-healed → swallowed at exit 0, hiding a
    // genuine packaging bug. With package.json readable, an UNDECLARED package
    // re-throws Node's default error instead of being silently degraded.
    const root = makeInstall('cml-launcher-foreign');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'better-sqlite3': '^12' } }));
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-ATTEMPTED");process.exit(1);\n');
    writeFileSync(join(root, 'entry.mjs'), "import x from 'totally-foreign-not-ours';\n");
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toMatch(/Detected broken install/);
    expect(r.stderr).not.toMatch(/REPAIR-ATTEMPTED/);
    expect(r.stderr).toMatch(/totally-foreign-not-ours/);
  });

  it('still self-heals a missing dependency that IS declared in package.json (#5/#7)', () => {
    const root = makeInstall('cml-launcher-owndep');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'declared-dep-xyz': '^1' } }));
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-ATTEMPTED");process.exit(1);\n');
    writeFileSync(join(root, 'entry.mjs'), "import x from 'declared-dep-xyz';\n");
    const r = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(r.stderr).toMatch(/Detected broken install/);
    expect(r.stderr).toMatch(/REPAIR-ATTEMPTED/);
    expect(r.status).toBe(0);
  });

  it('records an observable breakage marker when degrading to exit 0 (#4/#8)', () => {
    const root = makeInstall('cml-launcher-broken-marker');
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-ATTEMPTED");process.exit(1);\n');
    writeFileSync(join(root, 'entry.mjs'), "import './missing-local.mjs';\n");
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.status).toBe(0);
    const marker = join(root, 'runtime', 'hook-launcher-broken');
    expect(existsSync(marker)).toBe(true);
    const rec = JSON.parse(readFileSync(marker, 'utf8'));
    expect(rec.reason).toBeTruthy();
    expect(typeof rec.ts).toBe('number');
  });

  it('degrades to exit 0 (no stack trace) when the entry still fails after a "successful" repair (#14)', () => {
    // The retry-fail branch (exit code 1→0 in v3.1.0, previously untested):
    // install.mjs reports success (exit 0) but does NOT fix the import, so the
    // cache-busted retry throws again. Must degrade to exit 0 + record breakage.
    const root = makeInstall('cml-launcher-retry-fail');
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-DONE");process.exit(0);\n');
    writeFileSync(join(root, 'entry.mjs'), "import './still-missing.mjs';\n");
    const r = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/Detected broken install/);
    expect(r.stderr).toMatch(/Hook still failing after self-heal/);
    expect(r.stderr).not.toMatch(/node:internal/);
    expect(existsSync(join(root, 'runtime', 'hook-launcher-broken'))).toBe(true);
  });

  it('clears the heal cooldown + breakage markers after a fully successful self-heal (#6/#9)', () => {
    const root = makeInstall('cml-launcher-heal-clears');
    writeFileSync(
      join(root, 'install.mjs'),
      `import { writeFileSync, mkdirSync } from 'fs';\n` +
        `import { join, dirname } from 'path';\n` +
        `import { fileURLToPath } from 'url';\n` +
        `const __dirname = dirname(fileURLToPath(import.meta.url));\n` +
        `const target = join(__dirname, 'missing-local.mjs');\n` +
        `mkdirSync(dirname(target), { recursive: true });\n` +
        `writeFileSync(target, 'process.stdout.write("HEALED-OK\\\\n");\\n');\n` +
        `process.exit(0);\n`,
    );
    writeFileSync(join(root, 'entry.mjs'), "import './missing-local.mjs';\n");
    const r = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('HEALED-OK');
    // cooldown cleared so an unrelated later breakage can heal immediately
    expect(existsSync(join(root, 'runtime', 'hook-launcher-lastheal'))).toBe(false);
    expect(existsSync(join(root, 'runtime', 'hook-launcher-broken'))).toBe(false);
  });

  // ── A20260905-R5-Q2: the hot path records and defers, it does not repair ──

  it('does NOT run install.mjs repair on the per-tool hot path — only session-start pays', () => {
    const root = makeInstall('cml-launcher-hotpath-defer');
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-ATTEMPTED");process.exit(1);\n');
    writeFileSync(join(root, 'entry.mjs'), "import './missing-local.mjs';\n");

    // No event argument = a PreToolUse/PostToolUse-shaped fire (2-3s host cap).
    const hot = runLauncher(root, ['entry.mjs']);
    expect(hot.status).toBe(0);
    expect(hot.stderr).not.toMatch(/REPAIR-ATTEMPTED/);
    expect(hot.stderr).toMatch(/deferred to the next SessionStart/);
    expect(hot.stderr).not.toMatch(/node:internal|ERR_MODULE_NOT_FOUND/);
    // The breakage stays observable to `doctor` — deferring is not hiding.
    expect(existsSync(join(root, 'runtime', 'hook-launcher-broken'))).toBe(true);

    // CONTROL, same fixture: with the event argument the repair does run. Without this the
    // assertions above are equally consistent with a launcher that stopped healing at all.
    const cold = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(cold.stderr).toMatch(/REPAIR-ATTEMPTED/);
  });

  it('a killed hot-path fire cannot arm the 6h cooldown against the SessionStart that follows', () => {
    // The actual damage in A20260905-R5-Q2. recordHealAttempt() writes the cooldown marker
    // BEFORE spawning (deliberately — it is the mutual exclusion between concurrent fires),
    // so a hot-path repair the host kills still bought six hours of "Self-heal skipped" for
    // every later fire, SessionStart included. Assert the sequence, not the internals: a hot
    // fire must leave no cooldown marker, and the SessionStart right after it must still be
    // able to attempt the repair.
    const root = makeInstall('cml-launcher-hotpath-cooldown');
    writeFileSync(join(root, 'install.mjs'), 'console.error("REPAIR-ATTEMPTED");process.exit(1);\n');
    writeFileSync(join(root, 'entry.mjs'), "import './missing-local.mjs';\n");

    runLauncher(root, ['entry.mjs']);
    expect(existsSync(join(root, 'runtime', 'hook-launcher-lastheal'))).toBe(false);

    const ss = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(ss.stderr).toMatch(/REPAIR-ATTEMPTED/);
    expect(ss.stderr).not.toMatch(/Self-heal skipped/);
    expect(existsSync(join(root, 'runtime', 'hook-launcher-lastheal'))).toBe(true);
  });
});

// A20260905-R5-Q2, second half. Gating the heal to session-start left one route open and
// one closed: a hot-path fire now records the breakage and defers, but if the missing module
// sits on ANOTHER entry's import chain (this launcher fronts hook.mjs plus four standalone
// hook scripts), session-start's own entry imports cleanly, the catch never fires, and the
// clean fire used to simply clear the marker — so nothing ever repaired it.
//
// The repair here is DETACHED with stdio ignored: the fire is capped at 15s while
// `install.mjs repair` takes minutes, and install.mjs logs to stdout while SessionStart
// stdout is the JSON envelope Claude Code parses. So it cannot be observed through the
// launcher's streams — the stub records itself on disk and these cases wait for that.
describe('hook-launcher marker-driven self-heal (session-start)', () => {
  const BROKEN = (root) => join(root, 'runtime', 'hook-launcher-broken');
  const COOLDOWN = (root) => join(root, 'runtime', 'hook-launcher-lastheal');
  const RAN = (root) => join(root, 'repair-ran');
  const sleepSync = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  const waitFor = (pred, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return true;
      sleepSync(25);
    }
    return pred();
  };
  const writeBroken = (root, reason = 'lib/cite-back-hint.mjs') => {
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(BROKEN(root), JSON.stringify({ reason, ts: Date.now() }));
  };
  const stubInstaller = (root) =>
    writeFileSync(
      join(root, 'install.mjs'),
      `import { writeFileSync } from 'fs';\n` +
        `writeFileSync(${JSON.stringify(RAN(root))}, process.argv[2] || '');\n` +
        `process.exit(0);\n`,
    );
  const cleanEntry = (root) =>
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-OK\\n");\n');

  it('repairs in the background when a PREVIOUS fire recorded a breakage this entry cannot see', () => {
    const root = makeInstall('cml-launcher-marker-heal');
    stubInstaller(root);
    cleanEntry(root); // this entry is fine — the broken module is on another one's chain
    writeBroken(root);

    const r = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ENTRY-OK'); // the fire is never blocked on the repair
    expect(waitFor(() => existsSync(RAN(root)))).toBe(true);
    expect(readFileSync(RAN(root), 'utf8')).toBe('repair');
    // Marker cleared (doctor must not keep reporting a breakage we acted on) and the 6h
    // cooldown armed (it, not the marker, is what bounds repair spawns).
    expect(waitFor(() => !existsSync(BROKEN(root)))).toBe(true);
    expect(existsSync(COOLDOWN(root))).toBe(true);
  });

  it('CONTROL: a healthy install spawns nothing at session-start', () => {
    // Without this the case above is equally consistent with a launcher that repairs on
    // every session-start regardless of state.
    const root = makeInstall('cml-launcher-marker-healthy');
    stubInstaller(root);
    cleanEntry(root);

    const r = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(r.status).toBe(0);
    sleepSync(300);
    expect(existsSync(RAN(root))).toBe(false);
    expect(existsSync(COOLDOWN(root))).toBe(false);
  });

  it('drops a stale cooldown once no fire is recording breakage any more (#6/#9)', () => {
    const root = makeInstall('cml-launcher-marker-cooldown-drop');
    stubInstaller(root);
    cleanEntry(root);
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(COOLDOWN(root), String(Date.now()));

    runLauncher(root, ['entry.mjs', 'session-start']);
    // No marker → the install is as healthy as this launcher can tell → an old window must
    // not keep blocking an unrelated future break.
    expect(existsSync(COOLDOWN(root))).toBe(false);
  });

  it('honors the cooldown, and KEEPS the marker while it does so', () => {
    const root = makeInstall('cml-launcher-marker-cooldown-honored');
    stubInstaller(root);
    cleanEntry(root);
    writeBroken(root);
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(COOLDOWN(root), String(Date.now())); // fresh window

    const r = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(r.status).toBe(0);
    sleepSync(300);
    expect(existsSync(RAN(root))).toBe(false);
    // Not clearing here is the point: within the window nothing repaired it, so `doctor`
    // must still be able to see the degraded state.
    expect(existsSync(BROKEN(root))).toBe(true);
  });

  it('does nothing on the per-tool hot path — the marker survives for session-start', () => {
    const root = makeInstall('cml-launcher-marker-hotpath');
    stubInstaller(root);
    cleanEntry(root);
    writeBroken(root);

    const hot = runLauncher(root, ['entry.mjs']); // no event arg = hot path
    expect(hot.status).toBe(0);
    sleepSync(300);
    expect(existsSync(RAN(root))).toBe(false);
    expect(existsSync(BROKEN(root))).toBe(true);

    // CONTROL, same fixture: session-start does act on it.
    runLauncher(root, ['entry.mjs', 'session-start']);
    expect(waitFor(() => existsSync(RAN(root)))).toBe(true);
  });
});

// An ABI-stale better-sqlite3 (Node upgrade) does NOT throw at import time — the
// .node is dlopen'd lazily at the first `new Database()`, deep inside hook.mjs,
// which catches it. So the ERR_MODULE_NOT_FOUND path above never sees it and, in
// the field, nothing healed for 4 days (79 failed fires in one day). hook.mjs now
// records a breakage marker on every such fire; the launcher heals from it at
// session-start — off the per-tool hot path, in a process that has not yet
// dlopen'd the stale binary.
describe('hook-launcher native-binding self-heal (session-start)', () => {
  const BROKEN = (root) => join(root, 'runtime', 'native-binding-broken');
  const COOLDOWN = (root) => join(root, 'runtime', 'native-binding-lastheal');
  const RAN = (root) => join(root, 'rebuild-ran');
  const writeBroken = (root, reason = 'NODE_MODULE_VERSION 127 vs 137') => {
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(BROKEN(root), JSON.stringify({ reason, event: 'user-prompt', ts: Date.now() }));
  };
  // The rebuild is spawned DETACHED with stdio ignored (it must not block a
  // 15s-capped hook, and its stdout would corrupt the SessionStart JSON
  // envelope), so it cannot be observed through the launcher's own streams —
  // the stub records itself on disk and the test waits for that.
  const stubInstaller = (root, { exitCode = 0, clearsMarker = true } = {}) =>
    writeFileSync(
      join(root, 'install.mjs'),
      `import { writeFileSync, unlinkSync } from 'fs';\n` +
        `writeFileSync(${JSON.stringify(RAN(root))}, process.argv[2] || '');\n` +
        (clearsMarker && exitCode === 0
          ? `try { unlinkSync(${JSON.stringify(BROKEN(root))}); } catch {}\n`
          : '') +
        `process.exit(${exitCode});\n`,
    );
  // Synchronous poll — the assertions are about a DETACHED child, so the test
  // has to wait for the filesystem rather than for the launcher's exit.
  const sleepSync = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  const waitFor = (pred, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return true;
      sleepSync(25);
    }
    return pred();
  };

  it('spawns install.mjs rebuild-binding in the background; the child clears the marker', () => {
    const root = makeInstall('cml-launcher-nb-heal');
    stubInstaller(root);
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-OK\\n");\n');
    writeBroken(root);

    const r = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ENTRY-OK');
    expect(waitFor(() => existsSync(RAN(root)))).toBe(true);
    expect(readFileSync(RAN(root), 'utf8')).toBe('rebuild-binding');
    expect(waitFor(() => !existsSync(BROKEN(root)))).toBe(true);
  });

  it('never blocks the fire on the rebuild — the entry runs regardless of the child', () => {
    // Under the 15s SessionStart cap, waiting on npm would trade a stale binding
    // for a SIGKILL'd fire (no memory context at all) plus a half-written .node.
    const root = makeInstall('cml-launcher-nb-nonblocking');
    writeFileSync(
      join(root, 'install.mjs'),
      `import { writeFileSync } from 'fs';\n` +
        `writeFileSync(${JSON.stringify(RAN(root))}, 'slow');\n` +
        `setTimeout(() => process.exit(0), 8000);\n`, // outlives the 15s cap's useful budget
    );
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-OK\\n");\n');
    writeBroken(root);

    const t0 = Date.now();
    const r = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ENTRY-OK');
    // A synchronous wait would have cost the full 8s here.
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('keeps the SessionStart stdout envelope clean — installer output must not leak into it', () => {
    // hook.mjs session-start writes a JSON envelope Claude Code parses; install.mjs
    // logs to STDOUT, so an inherited child stdout corrupts the fire.
    const root = makeInstall('cml-launcher-nb-stdout');
    writeFileSync(
      join(root, 'install.mjs'),
      `import { writeFileSync } from 'fs';\n` +
        `console.log('  ✓ better-sqlite3 binding rebuilt');\n` +
        `writeFileSync(${JSON.stringify(RAN(root))}, 'x');\n` +
        `process.exit(0);\n`,
    );
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write(JSON.stringify({ok:true}) + "\\n");\n');
    writeBroken(root);

    const r = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(waitFor(() => existsSync(RAN(root)))).toBe(true);
    expect(r.stdout.trim()).toBe('{"ok":true}');
    expect(r.stdout).not.toMatch(/better-sqlite3 binding rebuilt/);
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true });
  });

  it('does NOT rebuild on the per-tool hot path — only session-start pays anything', () => {
    const root = makeInstall('cml-launcher-nb-hotpath');
    stubInstaller(root);
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-OK\\n");\n');
    writeBroken(root);

    const r = runLauncher(root, ['entry.mjs', 'post-tool-use']);
    expect(r.status).toBe(0);
    expect(existsSync(RAN(root))).toBe(false);
    expect(existsSync(BROKEN(root))).toBe(true);
  });

  it('honors a cooldown when the child does not resolve the fault', () => {
    // A rebuild that cannot succeed (no prebuild, no compiler, offline) must not
    // re-spawn npm on every session start.
    const root = makeInstall('cml-launcher-nb-fail');
    stubInstaller(root, { exitCode: 1, clearsMarker: false });
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-OK\\n");\n');
    writeBroken(root);

    const first = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(first.status).toBe(0);
    expect(waitFor(() => existsSync(RAN(root)))).toBe(true);
    expect(existsSync(BROKEN(root))).toBe(true); // unresolved → next session retries
    expect(existsSync(COOLDOWN(root))).toBe(true);
    rmSync(RAN(root), { force: true });

    const second = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(second.status).toBe(0);
    expect(existsSync(RAN(root))).toBe(false); // suppressed by the cooldown
  });

  it('drops a stale cooldown once the binding is healthy again', () => {
    // Otherwise a heal at T+0 would block an UNRELATED break at T+1h for 6h.
    const root = makeInstall('cml-launcher-nb-cooldown-reset');
    stubInstaller(root);
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-OK\\n");\n');
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(COOLDOWN(root), String(Date.now())); // recent heal, no breakage

    runLauncher(root, ['entry.mjs', 'session-start']);
    expect(existsSync(COOLDOWN(root))).toBe(false);

    // …so a fresh breakage heals immediately instead of waiting out the window.
    writeBroken(root);
    runLauncher(root, ['entry.mjs', 'session-start']);
    expect(waitFor(() => existsSync(RAN(root)))).toBe(true);
  });

  it('heals AFTER the entry too — the fire that first breaks also writes the marker', () => {
    // Without the post-entry check the session that DISCOVERS the breakage would
    // end without healing, and every later fire in it stays dead.
    const root = makeInstall('cml-launcher-nb-postentry');
    stubInstaller(root);
    writeFileSync(
      join(root, 'entry.mjs'),
      `import { writeFileSync, mkdirSync } from 'fs';\n` +
        `import { join } from 'path';\n` +
        `mkdirSync(join(process.env.CLAUDE_MEM_DIR, 'runtime'), { recursive: true });\n` +
        `writeFileSync(join(process.env.CLAUDE_MEM_DIR, 'runtime', 'native-binding-broken'), JSON.stringify({ reason: 'abi', ts: Date.now() }));\n` +
        `process.stdout.write("ENTRY-OK\\n");\n`,
    );

    const r = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ENTRY-OK');
    expect(waitFor(() => existsSync(RAN(root)))).toBe(true);
  });

  it('is a no-op with no marker — a healthy install pays nothing at session-start', () => {
    const root = makeInstall('cml-launcher-nb-noop');
    stubInstaller(root);
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-OK\\n");\n');
    const r = runLauncher(root, ['entry.mjs', 'session-start']);
    expect(r.status).toBe(0);
    expect(existsSync(RAN(root))).toBe(false);
  });

  it('reads the marker dir the standalone hook scripts write to (CLAUDE_MEM_RUNTIME_DIR)', () => {
    // pre-tool-recall.js / post-tool-recall.js honor CLAUDE_MEM_RUNTIME_DIR and
    // wrote 78 of the 79 field markers; a launcher reading only CLAUDE_MEM_DIR
    // would look in the wrong place and never heal.
    const root = makeInstall('cml-launcher-nb-runtimedir');
    stubInstaller(root);
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-OK\\n");\n');
    const altRuntime = join(root, 'alt-runtime');
    mkdirSync(altRuntime, { recursive: true });
    writeFileSync(
      join(altRuntime, 'native-binding-broken'),
      JSON.stringify({ reason: 'abi', ts: Date.now() }),
    );

    const r = runLauncher(root, ['entry.mjs', 'session-start'], { CLAUDE_MEM_RUNTIME_DIR: altRuntime });
    expect(r.status).toBe(0);
    expect(waitFor(() => existsSync(RAN(root)))).toBe(true);
  });
});

// The updater renames files into the install dir one at a time — atomic per file,
// not per file SET. A hook process that starts mid-loop can resolve hook.mjs from
// the old version and one of its imports from the new one. The updater marks that
// window; the launcher skips the fire rather than import a mixed module graph.
describe('hook-launcher swap barrier (audit P2-4)', () => {
  const writeMarker = (root, payload) => {
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(join(root, 'runtime', 'swap-in-progress'), JSON.stringify(payload));
  };

  it('skips the fire (exit 0, entry never imported) while a swap is in progress', () => {
    const root = makeInstall('cml-launcher-swap');
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-RAN\\n");\n');
    writeMarker(root, { pid: process.pid, ts: Date.now() }); // live holder
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('ENTRY-RAN');
  });

  it('runs normally when the marker is stale — a killed updater cannot mute hooks forever', () => {
    const root = makeInstall('cml-launcher-swap-stale');
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-RAN\\n");\n');
    writeMarker(root, { pid: process.pid, ts: Date.now() - 10 * 60 * 1000 });
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ENTRY-RAN');
  });

  it('runs normally when the marker names a dead pid', () => {
    const root = makeInstall('cml-launcher-swap-dead');
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-RAN\\n");\n');
    writeMarker(root, { pid: 0x7ffffffe, ts: Date.now() }); // not a live process
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ENTRY-RAN');
  });

  it('runs normally when the marker is truncated or unparseable', () => {
    const root = makeInstall('cml-launcher-swap-torn');
    writeFileSync(join(root, 'entry.mjs'), 'process.stdout.write("ENTRY-RAN\\n");\n');
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(join(root, 'runtime', 'swap-in-progress'), '{"pid":12');
    const r = runLauncher(root, ['entry.mjs']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ENTRY-RAN');
  });
});
