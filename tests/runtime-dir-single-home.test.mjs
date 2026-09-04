// Audit 2026-09-02 P1-14: `CLAUDE_MEM_RUNTIME_DIR` did not relocate the runtime directory,
// it SPLIT it.
//
// Six places honoured it (the five standalone hook scripts + hook-launcher) and two did
// not: `hook-shared.mjs` — which `hook.mjs`, `server.mjs`, `hook-context.mjs` and
// `hook-episode.mjs` all take `RUNTIME_DIR` from — and `hook-optimize.mjs`. So a harness
// that set the variable got the `fyi`/`pretool` faces writing markers into the override
// while `ups`/`keyctx` read them from the real directory. No error, no empty directory, no
// way to notice; `experiment/lib/arms.mjs` uses exactly this variable to keep an arm off
// real state.
//
// The whole suite passed before the fix AND after it, which is the reason this file exists:
// nothing anywhere asserted the variable did what its name says. A guard nobody would miss
// is a guard nobody is keeping.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import { tmpdir } from 'os';
import { resolveRuntimeDir } from '../lib/resolve-data-dir.mjs';
import { walkShipped, sweepShipped } from './shipped-tree.mjs';

let sandbox;
let override;

beforeEach(() => {
  vi.resetModules();
  sandbox = mkdtempSync(join(tmpdir(), 'mem-runtimedir-'));
  override = join(sandbox, 'elsewhere-runtime');
});

afterEach(() => {
  delete process.env.CLAUDE_MEM_RUNTIME_DIR;
  delete process.env.CLAUDE_MEM_DIR;
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('resolveRuntimeDir', () => {
  it('defaults to <dataDir>/runtime when the override is unset', () => {
    expect(resolveRuntimeDir('/data', {})).toBe(join('/data', 'runtime'));
  });

  it('treats empty and undefined as unset, not as a relocation to ""', () => {
    // `env || join(...)` handled this by accident; an `in`-style check would not, and a
    // runtime dir of '' resolves to cwd — state scattered across whatever directory the
    // hook happened to start in.
    expect(resolveRuntimeDir('/data', { CLAUDE_MEM_RUNTIME_DIR: '' })).toBe(join('/data', 'runtime'));
    expect(resolveRuntimeDir('/data', { CLAUDE_MEM_RUNTIME_DIR: undefined })).toBe(join('/data', 'runtime'));
  });

  it('honours an absolute override', () => {
    expect(resolveRuntimeDir('/data', { CLAUDE_MEM_RUNTIME_DIR: '/tmp/rt' })).toBe('/tmp/rt');
  });

  it('makes a relative override absolute rather than rejecting it', () => {
    // Deliberately unlike CLAUDE_MEM_DIR, which throws. This variable is set by test
    // harnesses that predate that check, and turning a previously-working relative path
    // into a throw would break isolation setups to enforce tidiness. Resolving keeps the
    // value usable AND absolute by the time anything writes to it.
    const got = resolveRuntimeDir('/data', { CLAUDE_MEM_RUNTIME_DIR: 'rel/rt' });
    expect(isAbsolute(got)).toBe(true);
    expect(got.endsWith(join('rel', 'rt'))).toBe(true);
  });
});

describe('the override reaches the modules that ignored it', () => {
  it('hook-shared.mjs RUNTIME_DIR follows CLAUDE_MEM_RUNTIME_DIR', async () => {
    // The defect itself. hook.mjs / server.mjs / hook-context.mjs / hook-episode.mjs all
    // read RUNTIME_DIR from here, so this one module is most of the split.
    process.env.CLAUDE_MEM_DIR = sandbox;
    process.env.CLAUDE_MEM_RUNTIME_DIR = override;
    const { RUNTIME_DIR } = await import('../hook-shared.mjs');
    expect(RUNTIME_DIR).toBe(override);
  });

  it('hook-shared.mjs still defaults under the data dir when the override is absent', async () => {
    // Premise for the case above: it must be following the OVERRIDE, not merely reporting
    // a path that happens to sit inside the sandbox either way.
    process.env.CLAUDE_MEM_DIR = sandbox;
    const { RUNTIME_DIR } = await import('../hook-shared.mjs');
    expect(RUNTIME_DIR).toBe(join(sandbox, 'runtime'));
    expect(RUNTIME_DIR).not.toBe(override);
  });
});

describe('the rule has one home', () => {
  // TWO sweeps, because the first cut of this file only had the second one and the v3.93.0
  // pre-tag test-effectiveness review showed it could not see the live defect.
  //
  // `INLINE_RE` catches a module that DID hear of the variable and wrote its own copy of the
  // rule. No module in the tree has that shape except the one declared exception.
  //
  // `CONSTRUCT_RE` catches the shape both defective modules ACTUALLY had — building
  // `join(x, 'runtime')` and never mentioning the variable at all. That form is invisible to
  // INLINE_RE, which is why `scripts/user-prompt-search.js` could resolve its RUNTIME_DIR
  // here and still build its cross-hook marker from the data dir: with the override set, the
  // `fyi` face wrote the SHARED marker to one directory while `pretool` wrote it to another.
  // The suite was fully green with that live.
  const INLINE_RE = /process\.env\.CLAUDE_MEM_RUNTIME_DIR\s*\|\|/;
  // One level of nesting is allowed inside the first argument on purpose: the real sites are
  // `join(resolveDataDir(process.env.CLAUDE_MEM_DIR), 'runtime', …)`, and a `[^)]*` first
  // argument cannot cross that inner `)`. The first draft of this regex used `[^)]*` and was
  // blind to exactly the two files it was allowlisting — caught by the reverse-guard below,
  // which is the whole reason that assertion exists.
  const CONSTRUCT_RE = /join\((?:[^()]|\([^()]*\))*,\s*['"]runtime['"]/;

  // `hook-launcher.mjs` runs before the native binding is known to work and imports only
  // `node:` builtins on purpose, so it keeps an inline copy with a comment pointing here.
  const INLINE_ALLOWED = new Set(['scripts/hook-launcher.mjs']);

  // Files that legitimately build `<dataDir>/runtime` themselves, each for a stated reason.
  // The distinction is documented at `resolveRuntimeDir`: hook-WRITTEN state that another
  // component reads back moves with the override; state about the ONE REAL INSTALLATION does
  // not, because two installers pointed at different override directories would each take
  // their own `install.lock` and both proceed.
  const CONSTRUCT_ALLOWED = new Map([
    ['lib/resolve-data-dir.mjs', 'the definition itself'],
    ['scripts/hook-launcher.mjs', 'pre-binding path, see INLINE_ALLOWED'],
    ['install.mjs', 'install.lock / update-state.json / update residue — installation identity'],
    ['hook-update.mjs', 'update-state.json / swap marker / install.lock — installation identity'],
    ['scripts/launch.mjs', 'install.lock'],
    ['scripts/binding-probe-cli.mjs', 'install.lock'],
  ]);

  it('the sweep walks a plausible number of shipped modules', () => {
    expect(walkShipped().length).toBeGreaterThan(60);
  });

  it('no shipped module re-derives the rule inline', () => {
    expect(sweepShipped(INLINE_RE, INLINE_ALLOWED)).toEqual([]);
  });

  it('no shipped module builds <dataDir>/runtime itself', () => {
    // The live-defect guard. A new hook path that hardcodes the join is caught here even
    // though it never mentions CLAUDE_MEM_RUNTIME_DIR — which is precisely how both original
    // offenders looked.
    expect(sweepShipped(CONSTRUCT_RE, new Set(CONSTRUCT_ALLOWED.keys()))).toEqual([]);
  });

  it('both sweeps can say NO, and every allowlisted file still earns its entry', () => {
    // A sweep that cannot fire is indistinguishable from a clean tree.
    expect("const d = process.env.CLAUDE_MEM_RUNTIME_DIR || join(x, 'runtime');").toMatch(INLINE_RE);
    expect("const d = join(DATA_DIR, 'runtime', 'marker');").toMatch(CONSTRUCT_RE);
    expect("const d = join(resolveDataDir(process.env.CLAUDE_MEM_DIR), 'runtime');").toMatch(CONSTRUCT_RE);
    // …and must NOT fire on the resolved form, or the guard would forbid the fix.
    expect('const d = resolveRuntimeDir(DATA_DIR);').not.toMatch(CONSTRUCT_RE);

    for (const rel of INLINE_ALLOWED) {
      expect(readFileSync(join(process.cwd(), rel), 'utf8'),
        `${rel} is allowlisted but no longer carries the inline rule`).toMatch(INLINE_RE);
    }
    // Reverse-guard the second allowlist too: an entry whose file stopped constructing the
    // path is a stale exemption, and a stale exemption is how an allowlist becomes a raised
    // baseline that quietly re-admits the defect.
    for (const [rel, why] of CONSTRUCT_ALLOWED) {
      expect(readFileSync(join(process.cwd(), rel), 'utf8'),
        `${rel} is allowlisted (${why}) but no longer builds the path — drop the entry`)
        .toMatch(CONSTRUCT_RE);
    }
  });
});
