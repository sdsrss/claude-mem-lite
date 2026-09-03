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
  // `hook-launcher.mjs` is the single declared exception: it runs before the native binding
  // is known to work and imports only `node:` builtins on purpose, so it keeps an inline
  // copy with a comment pointing here. Everything else must go through the resolver, or the
  // next module added is free to be the third that never heard of the variable.
  const INLINE_RE = /process\.env\.CLAUDE_MEM_RUNTIME_DIR\s*\|\|/;
  const ALLOWED = new Set(['scripts/hook-launcher.mjs']);

  it('the sweep walks a plausible number of shipped modules', () => {
    expect(walkShipped().length).toBeGreaterThan(60);
  });

  it('no shipped module re-derives the rule inline', () => {
    expect(sweepShipped(INLINE_RE, ALLOWED)).toEqual([]);
  });

  it('the sweep can say NO, and the one exception really does carry the inline copy', () => {
    expect("const d = process.env.CLAUDE_MEM_RUNTIME_DIR || join(x, 'runtime');").toMatch(INLINE_RE);
    for (const rel of ALLOWED) {
      expect(readFileSync(join(process.cwd(), rel), 'utf8'),
        `${rel} is allowlisted but no longer carries the inline rule`).toMatch(INLINE_RE);
    }
  });
});
