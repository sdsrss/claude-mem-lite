// planRepoSparsePaths — decides what a registry repo clone must check out.
// Guards the partial+sparse clone optimization (install.mjs): we only ever copy
// the manifest's entry.path subdirs into managed/skills|agents, so a slim clone
// fetches just those subtrees instead of the whole repo (e.g. davila7 197MB → MBs).
// The risk is in the path-selection logic, not the network call, so that is what
// we unit-test.

import { describe, it, expect } from 'vitest';
import { planRepoSparsePaths } from '../install.mjs';

describe('planRepoSparsePaths', () => {
  it('returns the deduped subpaths for a normal multi-path repo', () => {
    const r = planRepoSparsePaths([
      { path: 'skills/foo' },
      { path: 'agents/bar' },
      { path: 'skills/foo' }, // dup
    ]);
    expect(r.full).toBe(false);
    expect(r.paths).toEqual(['skills/foo', 'agents/bar']);
  });

  it('forces a full checkout when any entry maps to the repo root', () => {
    expect(planRepoSparsePaths([{ path: 'skills/foo' }, { path: '.' }]).full).toBe(true);
    expect(planRepoSparsePaths([{ path: './' }]).full).toBe(true);
    expect(planRepoSparsePaths([{ path: '' }]).full).toBe(true);
    expect(planRepoSparsePaths([{}]).full).toBe(true); // missing path
  });

  it('drops unsafe paths (.. / absolute) without forcing a full clone', () => {
    const r = planRepoSparsePaths([{ path: 'skills/ok' }, { path: '../escape' }, { path: '/etc/passwd' }]);
    expect(r.full).toBe(false);
    expect(r.paths).toEqual(['skills/ok']); // unsafe ones excluded, never reach sparse-checkout
  });

  it('normalizes leading ./ and trailing slashes', () => {
    const r = planRepoSparsePaths([{ path: './skills/foo/' }, { path: 'agents/bar//' }]);
    expect(r.paths).toEqual(['skills/foo', 'agents/bar']);
  });

  it('falls back to full when no usable path survives (all unsafe)', () => {
    const r = planRepoSparsePaths([{ path: '../a' }, { path: '/b' }]);
    expect(r.full).toBe(true); // empty sparse set → full is the only thing that yields content
    expect(r.paths).toEqual([]);
  });

  it('handles empty / nullish input without throwing', () => {
    expect(planRepoSparsePaths([]).full).toBe(true);
    expect(planRepoSparsePaths(undefined).full).toBe(true);
  });
});
