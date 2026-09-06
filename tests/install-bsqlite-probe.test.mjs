// install-bsqlite-probe.test.mjs — Bug 3 regression
// install.mjs must verify better-sqlite3 native binding is loadable AFTER
// `npm install` runs. Pre-built binaries can mismatch the user's Node ABI
// (e.g. Node v24 NODE_MODULE_VERSION 137) and `npm install` exits 0 even when
// the .node binary is unusable. Without a verify step, install completes
// "successfully" and the next launch FATALs with "Could not locate the
// bindings file". The probe exists so we can detect this and auto-rebuild
// before declaring install done.

import { describe, it, expect } from 'vitest';
import { resolve, join } from 'path';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { probeBetterSqlite3Binding, ensureBetterSqlite3Working } from '../install.mjs';
import { probeBindingInFreshProcess } from '../lib/binding-probe.mjs';
import { RELEASE_SIGNED_FILES } from '../source-files.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
// D#207: the module path is built with join() and only then turned into a URL. Naming it
// directly in `new URL('../lib/binding-probe.mjs', …)` made knip drop binding-probe.mjs
// out of its unused-export report entirely. The spawned child still needs an href, so the
// conversion is pathToFileURL, not a bare path. Enforced by tests/no-url-module-paths.test.mjs.
const PROBE_MOD = JSON.stringify(pathToFileURL(join(REPO_ROOT, 'lib', 'binding-probe.mjs')).href);
const PKG_JSON = JSON.stringify(join(REPO_ROOT, 'package.json'));

// Run `body` in a pristine child and report whether better-sqlite3's .node ended
// up dlopen'd in THAT child. Has to be a child: this vitest worker may already
// have loaded the addon for unrelated reasons, which would make the assertion
// vacuous.
//
// The detector matches ANY `.node` under the better-sqlite3 package, not the literal
// filename `better_sqlite3.node` (v4.0.0). better-sqlite3 13 ships prebuilt binaries as
// `prebuilds/<platform>.node` — `prebuilds/linux-x64.node` here — where 12 built
// `build/Release/better_sqlite3.node`. Under the old substring the addon still got
// dlopen'd but went unseen, which did NOT merely break the control below: it made the
// real assertion (`probeBindingInFreshProcess` must load nothing here) VACUOUSLY TRUE, so
// the guard would have passed even if the fresh-process probe had started poisoning the
// caller. The control is what caught it — that is what a control is for. Both layouts are
// matched so the pattern survives a future move back or a platform that builds from source.
const ADDON_IN_BSQLITE3 = /better[-_]sqlite3[\\/].*\.node$/;

function loadedAfter(body) {
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { probeBindingInFreshProcess, probeBetterSqlite3Binding } = await import(${PROBE_MOD});
    const result = await (${body});
    const { createRequire } = await import('node:module');
    const req = createRequire(${PKG_JSON});
    const loaded = Object.keys(req.cache).some((k) => ${ADDON_IN_BSQLITE3.toString()}.test(k));
    console.log(JSON.stringify({ ok: result.ok, loaded }));
  `,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  return JSON.parse(r.stdout.trim());
}

describe('Bug 3: better-sqlite3 binding probe', () => {
  it('returns {ok:true} when binding is loadable in the given installDir', async () => {
    const result = await probeBetterSqlite3Binding(resolve('.'));
    expect(result.ok).toBe(true);
  });

  it('returns {ok:false, error} when installDir has no node_modules/better-sqlite3', async () => {
    const result = await probeBetterSqlite3Binding('/tmp/does-not-exist-' + Date.now());
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });
});

// A probe must not poison the process that acts on its answer. Loading a STALE
// .node caches a dead module handle process-wide, so the post-rebuild re-probe
// could only ever answer "Module did not self-register" — turning a SUCCESSFUL
// rebuild into a reported failure (measured 2026-08-13 on a real ABI 127-under-137
// tree: scripts/setup.sh wrote .deps-broken over a freshly healed install and
// segfaulted on the way out; install.mjs::rebuildBinding never cleared the
// breakage marker, so the launcher re-spawned npm every 6h indefinitely).
// The injected-stub tests below cannot see this — they never dlopen anything —
// so the invariant is asserted structurally instead.
describe('native binding probe must not dlopen into the calling process', () => {
  it('probeBindingInFreshProcess verifies the binding without loading it here', () => {
    expect(loadedAfter(`probeBindingInFreshProcess(${JSON.stringify(REPO_ROOT)})`)).toEqual({
      ok: true,
      loaded: false,
    });
  });

  // Control: proves the assertion above is not vacuously true. The in-process
  // variant DOES load the addon — that is exactly why it is unfit for the
  // probe→rebuild→verify cycle.
  it('probeBetterSqlite3Binding (in-process variant) does load it — control', () => {
    expect(loadedAfter(`probeBetterSqlite3Binding(${JSON.stringify(REPO_ROOT)})`)).toEqual({
      ok: true,
      loaded: true,
    });
  });

  it('ensureBetterSqlite3Working leaves the caller clean on the healthy path', () => {
    // scripts/launch.mjs imports the MCP server into this same process right
    // after this call returns.
    expect(
      loadedAfter(`(await import(${PROBE_MOD})).ensureBetterSqlite3Working(${JSON.stringify(REPO_ROOT)})`),
    ).toEqual({ ok: true, loaded: false });
  });

  it('reports a real error string for a directory with no binding', () => {
    const r = probeBindingInFreshProcess('/tmp/does-not-exist-' + process.pid);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.error.length).toBeGreaterThan(0);
  });
});

// scripts/binding-probe-cli.mjs is what scripts/setup.sh runs on every
// SessionStart that misses the ABI marker. It used to be an inline
// `node --input-type=module -e '…'` string inside setup.sh, which (a) SIGSEGV'd
// during exit after a verified-good rebuild, turning a successful heal into
// exit 139 → false .deps-broken, and (b) could not contain an apostrophe
// without truncating the shell command.
describe('scripts/binding-probe-cli.mjs — the SessionStart probe entry point', () => {
  const CLI = join(REPO_ROOT, 'scripts', 'binding-probe-cli.mjs');
  const run = (root) =>
    spawnSync(process.execPath, [CLI], {
      env: { ...process.env, PROBE_ROOT: root },
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('exits 0 on a healthy tree', () => {
    const r = run(REPO_ROOT);
    expect(r.status).toBe(0);
  });

  it('never writes to stdout — SessionStart stdout is a JSON envelope', () => {
    // Both the healthy path and the helperless-tree path must stay silent there.
    expect(run(REPO_ROOT).stdout).toBe('');
    expect(run('/tmp/no-such-install-' + process.pid).stdout).toBe('');
  });

  it('exits non-zero when the tree has no usable binding', () => {
    const r = run('/tmp/no-such-install-' + process.pid);
    expect(r.status).not.toBe(0);
  });

  it('setup.sh delegates to it instead of embedding an inline node -e probe', () => {
    const setup = readFileSync(join(REPO_ROOT, 'scripts', 'setup.sh'), 'utf8');
    expect(setup).toContain('scripts/binding-probe-cli.mjs');
    // The inline form is the regression: an apostrophe-hostile heredoc-in-quotes
    // whose exit code was corrupted by a native teardown crash.
    expect(setup).not.toMatch(/node\s+--input-type=module\s+-e/);
  });

  it('is registered for release signing (unsigned = arbitrary code at SessionStart)', () => {
    expect(RELEASE_SIGNED_FILES).toContain('scripts/binding-probe-cli.mjs');
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('scripts/binding-probe-cli.mjs');
  });
});

describe('Bug 3: ensureBetterSqlite3Working — probe → rebuild → re-probe', () => {
  it('uses the injected verify (not probe) for the POST-rebuild check', async () => {
    const seen = [];
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => {
        seen.push('probe');
        return { ok: false, error: 'stale abi' };
      },
      verify: async () => {
        seen.push('verify');
        return { ok: true };
      },
      rebuild: async () => {
        seen.push('rebuild');
      },
    });
    expect(result).toEqual({ ok: true, action: 'rebuilt' });
    expect(seen).toEqual(['probe', 'rebuild', 'verify']);
  });

  it('falls back to the injected probe for both checks when verify is absent', async () => {
    // Back-compat: every pre-existing caller/test injects `probe` alone.
    let n = 0;
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => {
        n++;
        return n === 1 ? { ok: false, error: 'x' } : { ok: true };
      },
      rebuild: async () => {},
    });
    expect(result).toEqual({ ok: true, action: 'rebuilt' });
    expect(n).toBe(2);
  });

  it('returns {ok:true, action:"verified"} and skips rebuild when first probe passes', async () => {
    const calls = { probe: 0, rebuild: 0 };
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => {
        calls.probe++;
        return { ok: true };
      },
      rebuild: async () => {
        calls.rebuild++;
      },
    });
    expect(result).toEqual({ ok: true, action: 'verified' });
    expect(calls.probe).toBe(1);
    expect(calls.rebuild).toBe(0);
  });

  it('runs rebuild and re-probes when first probe fails, returns action:"rebuilt" on success', async () => {
    let probeCount = 0;
    const calls = { rebuild: 0 };
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => {
        probeCount++;
        return probeCount === 1 ? { ok: false, error: 'bindings missing' } : { ok: true };
      },
      rebuild: async () => {
        calls.rebuild++;
      },
    });
    expect(result).toEqual({ ok: true, action: 'rebuilt' });
    expect(probeCount).toBe(2);
    expect(calls.rebuild).toBe(1);
  });

  it('returns {ok:false, error} when rebuild does not fix the binding', async () => {
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => ({ ok: false, error: 'bindings still missing' }),
      rebuild: async () => {
        /* noop */
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('bindings still missing');
  });

  it('reports rebuild error when the rebuild step itself throws', async () => {
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => ({ ok: false, error: 'first probe fail' }),
      rebuild: async () => {
        throw new Error('npm rebuild crashed');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('npm rebuild crashed');
  });
});

// npm >= 12 blocks lifecycle scripts by default, so a plain
// `npm rebuild better-sqlite3` exits 0 without compiling the native binding and
// the launcher's self-heal silently no-ops (server then dies pre-handshake →
// MCP -32000). The default rebuild must re-enable scripts for this one vetted
// dep, and fall back to a plain rebuild if an older npm rejects the flag.
describe('Bug: npm 12 allow-scripts block defeats the self-heal rebuild', () => {
  it('default rebuild re-enables install scripts (--dangerously-allow-all-scripts)', async () => {
    const cmds = [];
    let probeCount = 0;
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => {
        probeCount++;
        return probeCount === 1 ? { ok: false, error: 'bindings missing' } : { ok: true };
      },
      exec: (cmd) => {
        cmds.push(cmd);
      }, // capture; simulate a successful build
    });
    expect(result).toEqual({ ok: true, action: 'rebuilt' });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('npm rebuild better-sqlite3');
    expect(cmds[0]).toContain('--dangerously-allow-all-scripts');
  });

  it('falls back to a plain rebuild when the bypass flag errors (older npm)', async () => {
    const cmds = [];
    let probeCount = 0;
    const result = await ensureBetterSqlite3Working('/some/dir', {
      probe: async () => {
        probeCount++;
        return probeCount === 1 ? { ok: false, error: 'x' } : { ok: true };
      },
      exec: (cmd) => {
        cmds.push(cmd);
        if (cmd.includes('--dangerously-allow-all-scripts')) throw new Error('unknown flag');
      },
    });
    expect(result).toEqual({ ok: true, action: 'rebuilt' });
    expect(cmds).toEqual([
      'npm rebuild better-sqlite3 --dangerously-allow-all-scripts',
      'npm rebuild better-sqlite3',
    ]);
  });
});
