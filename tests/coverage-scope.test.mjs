// Audit 2026-08-22 P2-2: the coverage gate used to measure 22 hand-picked root
// modules while lib/'s ~70 shipped modules — every shared core extracted since
// v3.4x — were outside `include` entirely, so "77.47% covered" described a curated
// subset. lib/** is now in scope. These cases pin the SCOPE, not the percentage:
// a percentage drifts every release, but a shipped module silently leaving the
// measured set is the failure this file exists to catch.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import picomatch from 'picomatch';
import config from '../vitest.config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const coverage = config.test.coverage;
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/**
 * Is `file` (repo-relative) inside the measured set?
 *
 * This MUST mirror vitest's own matcher rather than approximate it. The real call
 * is `BaseCoverageProvider.isIncluded` (vitest/dist/chunks/coverage.*.js): picomatch
 * against the ABSOLUTE path with `{ contains: true, dot: true, ignore: exclude }`.
 * A plain relative `picomatch.isMatch(file, pattern)` looks equivalent and is not —
 * `contains: true` is exactly why `lib/**\/*.mjs` also swallowed `experiment/lib/*.mjs`
 * in the real run. Modelled the naive way, the experiment/ case below passed while
 * the exclude that makes it true was deleted.
 */
function inCoverageScope(file) {
  return picomatch.isMatch(join(ROOT, file), coverage.include, {
    contains: true,
    dot: true,
    ignore: coverage.exclude,
  });
}

describe('coverage scope (audit P2-2)', () => {
  it('measures every shipped lib/ module', () => {
    const shippedLib = pkg.files.filter((f) => f.startsWith('lib/') && f.endsWith('.mjs'));
    expect(shippedLib.length).toBeGreaterThan(50); // sanity: the list is really there
    const missing = shippedLib.filter((f) => !inCoverageScope(f));
    expect(missing).toEqual([]);
  });

  it('keeps the unshipped experiment/ scratch dir out of the gate', () => {
    // `lib/**/*.mjs` is not anchored to the repo root — it also matches
    // experiment/lib/*.mjs, which nothing ships and nobody has touched in months.
    // Without the explicit exclude those files drag the gate down.
    expect(inCoverageScope('experiment/lib/arms.mjs')).toBe(false);
    expect(inCoverageScope('experiment/lib/runner.mjs')).toBe(false);
  });

  it('excludes the three entry files deliberately, not by omission', () => {
    // These are exercised through subprocess E2E, which v8 coverage of the parent
    // process cannot observe — including them would measure the harness, not the
    // code. Listing them in `exclude` (rather than just leaving them out of
    // `include`) is what makes that a decision someone has to edit on purpose.
    //
    // Was four. `registry.mjs` left this list in v3.92.0 after audit P1-15 asked whether
    // the rationale had expired, and the answer was measured per file rather than argued:
    // install.mjs 11.67% / server.mjs 25.89% (rationale holds — importing a module is not
    // exercising it) against registry.mjs 86.78% (expired). See vitest.config.mjs.
    for (const f of ['install.mjs', 'server.mjs', 'hook.mjs']) {
      expect(coverage.exclude).toContain(f);
      expect(inCoverageScope(f)).toBe(false);
    }
  });

  it('measures registry.mjs, which was well covered and invisible', () => {
    // The other half, asserted separately so a revert of the scope change goes red rather
    // than merely shrinking a loop above. Moving it IN raised the totals (84.32% → 84.38%
    // statements), which is the tell that it was never harness-only.
    expect(coverage.include).toContain('registry.mjs');
    expect(coverage.exclude).not.toContain('registry.mjs');
    expect(inCoverageScope('registry.mjs')).toBe(true);
  });

  it('still measures the 22 hand-picked root modules', () => {
    for (const f of ['utils.mjs', 'schema.mjs', 'mem-cli.mjs', 'tfidf.mjs']) {
      expect(inCoverageScope(f)).toBe(true);
    }
  });
});
