// Audit 2026-08-22 P2-2: the coverage gate used to measure 22 hand-picked root
// modules while lib/'s ~70 shipped modules — every shared core extracted since
// v3.4x — were outside `include` entirely, so "77.47% covered" described a curated
// subset. lib/** is now in scope. These cases pin the SCOPE, not the percentage:
// a percentage drifts every release, but a shipped module silently leaving the
// measured set is the failure this file exists to catch.
//
// 2026-09-07: the allowlist was found hiding code a THIRD time (24 shipped modules /
// 10,137 lines, including search-engine.mjs, hook-optimize.mjs, scoring-sql.mjs and
// all of cli/**), so vitest.config.mjs inverted `include` to a denylist. Two of the
// cases below changed shape with it, and two are new — see each one's own comment.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import picomatch from 'picomatch';
import config from '../vitest.config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const coverage = config.test.coverage;
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const vitestPkg = JSON.parse(readFileSync(join(ROOT, 'node_modules/vitest/package.json'), 'utf8'));

// The major this file's matcher model was read from and verified against.
const MODELLED_VITEST_MAJOR = 5;

/**
 * Is `file` (repo-relative) inside the measured set?
 *
 * This MUST mirror vitest's own matcher rather than approximate it, and the matcher
 * is VERSION-COUPLED — read it, do not remember it. On vitest 5.0.0 the real call is
 * `BaseCoverageProvider.isIncluded` (vitest/dist/chunks/index.*.js:14911-14932):
 *
 *     relativeFilename = relative(root, filename)      // RELATIVE, not absolute
 *     if (matchExclude(relativeFilename)) return false // exclude wins, checked first
 *     return matchInclude(relativeFilename)
 *
 * with `matchExclude = pm(exclude, { dot: true })` and
 * `matchInclude = pm(include, { dot: true, ignore: exclude })` (:14939-14952).
 * Note what is NOT there: `contains: true`.
 *
 * This model was WRONG here for a whole major and nothing went red. It described
 * vitest 4's matcher — absolute path with `{ contains: true }` — and survived the
 * 2026-09-06 upgrade to 5.0.0 because the old hand-picked `include` was simple
 * enough that both semantics returned the same answer for every case in this file.
 * The disagreement only surfaced when the config changed. Under the stale v4 model
 * `contains: true` makes an exclude entry a SUBSTRING test, so `'cli.mjs'` also
 * excluded `mem-cli.mjs` (3827 lines, the largest module in the gate) and
 * `adopt-cli.mjs`, and a bare `'*.mjs'` include swallowed `tests/**` and
 * `node_modules/**`. Both are pinned below so the model cannot rot back.
 */
function inCoverageScope(file) {
  const matchExclude = coverage.exclude.length ? picomatch(coverage.exclude, { dot: true }) : () => false;
  const matchInclude = coverage.include
    ? picomatch(coverage.include, { dot: true, ignore: coverage.exclude })
    : () => true;
  if (matchExclude(file)) return false;
  return matchInclude(file);
}

const isExcluded = (file) => picomatch.isMatch(file, coverage.exclude, { dot: true });

describe('coverage scope (audit P2-2)', () => {
  // The tripwire the vitest 5 upgrade needed and did not have. A major bump can
  // change isIncluded's path form or picomatch options, and the failure mode is
  // silent agreement rather than a red test — so demand a human re-read instead of
  // trusting that this file still models reality.
  it('is still modelling the vitest major it was read from', () => {
    const major = Number(vitestPkg.version.split('.')[0]);
    expect(
      major,
      `vitest is ${vitestPkg.version} but inCoverageScope() models v${MODELLED_VITEST_MAJOR}. ` +
        'Re-read BaseCoverageProvider.isIncluded + getGlobMatchers in ' +
        'node_modules/vitest/dist/chunks/index.*.js, update the model AND this constant.',
    ).toBe(MODELLED_VITEST_MAJOR);
  });

  it('measures every shipped lib/ module', () => {
    const shippedLib = pkg.files.filter((f) => f.startsWith('lib/') && f.endsWith('.mjs'));
    expect(shippedLib.length).toBeGreaterThan(50); // sanity: the list is really there
    const missing = shippedLib.filter((f) => !inCoverageScope(f));
    expect(missing).toEqual([]);
  });

  // The generalised form of this file's whole purpose, and the case that would have
  // caught the 2026-09-07 finding on the day it was introduced rather than three
  // audits later. NOT tautological: a file that is excluded is out on purpose, but a
  // shipped file that matches no exclude pattern and is still unmeasured is out by
  // OMISSION — which is precisely how 24 modules went missing while this file's
  // comments named three exclusions.
  it('leaves no shipped module unmeasured by omission', () => {
    const shipped = pkg.files.filter((f) => f.endsWith('.mjs'));
    const orphans = shipped.filter((f) => !isExcluded(f) && !inCoverageScope(f));
    expect(orphans).toEqual([]);
  });

  it('measures the shipped cli/ and server/ modules', () => {
    // cli/common.mjs is the shared render layer server.mjs also imports — CLAUDE.md's
    // "shared by two or more faces" rule is the reason it must be guarded, and it sat
    // outside the gate from the day it was extracted until 2026-09-07.
    for (const f of ['cli/common.mjs', 'cli/doctor.mjs', 'server/fts-check.mjs']) {
      expect(pkg.files).toContain(f); // premise: these really are shipped
      expect(inCoverageScope(f)).toBe(true);
    }
  });

  it('keeps the unshipped experiment/ scratch dir out of the gate', () => {
    // Historically this was load-bearing: under vitest 4's `contains: true`,
    // `lib/**/*.mjs` also matched experiment/lib/*.mjs. On v5's relative matching it
    // no longer can, so the `experiment/**` exclude is now belt-and-braces — kept
    // because nothing ships from there and the next matcher change is free to
    // reintroduce the leak.
    expect(inCoverageScope('experiment/lib/arms.mjs')).toBe(false);
    expect(inCoverageScope('experiment/lib/runner.mjs')).toBe(false);
  });

  it('excludes the four entry files deliberately, not by omission', () => {
    // These are exercised through subprocess E2E, which v8 coverage of the parent
    // process cannot observe — including them would measure the harness, not the
    // code. Listing them in `exclude` (rather than just leaving them out of
    // `include`) is what makes that a decision someone has to edit on purpose —
    // and since `include` is a denylist, it is now the ONLY way out.
    //
    // Was four, then three, now four again. `registry.mjs` left in v3.92.0 after audit
    // P1-15 asked whether the rationale had expired, answered per file rather than
    // argued: install.mjs 11.67% / server.mjs 25.89% (holds — importing a module is not
    // exercising it) against registry.mjs 86.78% (expired). `cli.mjs` joined on the same
    // caliber of evidence, 2026-09-07: zero test files import it in-process, >= 5 spawn
    // it, and inside `include` it reads 0.0% over 63 statements. hook-precompact.mjs was
    // measured the same way and went IN at 58.3% — three suites import handlePreCompact
    // directly. See vitest.config.mjs.
    for (const f of ['install.mjs', 'server.mjs', 'hook.mjs', 'cli.mjs']) {
      expect(coverage.exclude).toContain(f);
      expect(inCoverageScope(f)).toBe(false);
    }
  });

  // Regression pin for the v4-model bug this round exposed. Under `contains: true` an
  // exclude entry is a SUBSTRING test, so 'cli.mjs' silently took mem-cli.mjs and
  // adopt-cli.mjs out of the gate with it — the largest measured module leaving while
  // the aggregate went UP. Exact-name exclusion is load-bearing, not incidental.
  it('does not let an exclude entry swallow modules whose names end with it', () => {
    for (const f of ['mem-cli.mjs', 'adopt-cli.mjs', 'cli-path.mjs']) {
      expect(inCoverageScope(f)).toBe(true);
    }
  });

  // The denylist's own risk, pinned. `include: ['*.mjs', ...]` is only root-anchored
  // because v5 matches the RELATIVE path; the moment that stops being true the gate
  // silently starts measuring the test suite and node_modules.
  it('does not pull tests, benchmarks, scripts or node_modules into the gate', () => {
    for (const f of [
      'tests/e2e.test.mjs',
      'tests/test-helpers.mjs',
      'benchmark/benchmark.mjs',
      'scripts/launch.mjs',
      'node_modules/picomatch/index.js',
      'eslint.config.mjs',
      'vitest.config.mjs',
    ]) {
      expect(inCoverageScope(f)).toBe(false);
    }
  });

  // CLAUDE.md's Commands table prints the four floors, and nothing checked it against
  // the config — the same "a doc states a number the code owns" shape the `**Version**:`
  // release guard exists for. It is how the population sentence three sections down went
  // three audits without anyone noticing it named 3 of 24 exclusions.
  it('keeps the gate numbers in CLAUDE.md equal to the config', () => {
    const doc = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    const m = doc.match(/gate: statements (\d+) \/ branches (\d+) \/ functions (\d+) \/ lines (\d+)\)/);
    expect(m, 'CLAUDE.md no longer prints the coverage gate in the expected shape').not.toBeNull();
    const [, statements, branches, functions, lines] = m.map(Number);
    expect({ statements, branches, functions, lines }).toEqual({
      statements: coverage.thresholds.statements,
      branches: coverage.thresholds.branches,
      functions: coverage.thresholds.functions,
      lines: coverage.thresholds.lines,
    });
  });

  it('measures the retrieval core the measurement doctrine is about', () => {
    // CLAUDE.md's whole "Measurement doctrine" section is about retrieval quality,
    // and every one of these was outside the gate until 2026-09-07.
    for (const f of ['search-engine.mjs', 'scoring-sql.mjs', 'rerank.mjs', 'deep-search.mjs']) {
      expect(inCoverageScope(f)).toBe(true);
    }
  });
});
