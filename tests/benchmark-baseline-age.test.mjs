// benchmark-baseline-age.test.mjs — v2.41 stale-baseline warning guard.
// Directly parses the ci-gate source to verify the age-check constants and
// logic shape are present. A full integration test would need to spawn the
// benchmark (slow + flaky on CI); the constants check catches regressions
// without requiring a real run.

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CI_GATE_PATH = join(__dirname, '..', 'benchmark', 'ci-gate.mjs');
const REPO_ROOT = join(__dirname, '..');
const BASELINE_STALE_DAYS = 30; // mirrors BASELINE_STALE_AGE_DAYS in ci-gate.mjs

describe('benchmark/ci-gate.mjs — stale baseline warning', () => {
  const source = readFileSync(CI_GATE_PATH, 'utf8');

  it('declares BASELINE_STALE_AGE_DAYS constant', () => {
    expect(source).toMatch(/BASELINE_STALE_AGE_DAYS\s*=\s*30/);
  });

  it('computes baselineAgeDays from timestamp or mtime', () => {
    expect(source).toMatch(/baselineAgeDays/);
    expect(source).toMatch(/Date\.parse\(baseline\.timestamp\)/);
    expect(source).toMatch(/statSync\(baselinePath\)\.mtimeMs/);
  });

  it('emits STALE BASELINE warning on stderr (advisory, does not fail gate)', () => {
    expect(source).toMatch(/STALE BASELINE/);
    expect(source).toMatch(/node benchmark\/benchmark\.mjs/);
    expect(source).toMatch(/advisory, not a failure/i);
  });

  it('stale-check happens before the benchmark run, so warning is visible even on failure', () => {
    const staleIdx = source.indexOf('STALE BASELINE');
    const benchmarkExecIdx = source.indexOf("execSync('node benchmark/benchmark.mjs");
    expect(staleIdx).toBeGreaterThan(0);
    expect(benchmarkExecIdx).toBeGreaterThan(0);
    expect(staleIdx).toBeLessThan(benchmarkExecIdx);
  });
});

// FIX 3a: the absolute-metric check must run the PRODUCTION-HYBRID path
// (searchObservationsHybrid via --production-hybrid), the path users hit — not
// the lexical FTS-only default that left vector drift invisible.
describe('benchmark/ci-gate.mjs — absolute metric check uses production-hybrid (FIX 3a)', () => {
  const source = readFileSync(CI_GATE_PATH, 'utf8');
  const baseline = JSON.parse(readFileSync(join(__dirname, '..', 'benchmark', 'baseline.json'), 'utf8'));

  it('runs benchmark with --production-hybrid for the absolute-metric pass', () => {
    expect(source).toMatch(/execSync\('node benchmark\/benchmark\.mjs --production-hybrid'/);
  });

  it('baseline.json was captured from the production_hybrid path (so baseline == gate)', () => {
    expect(baseline.mode).toBe('production_hybrid');
  });
});

// FIX 3c: a stale baseline must FAIL the gate in strict mode (--strict /
// CI_GATE_STRICT=1) while staying advisory-only by default (backward-compatible).
describe('benchmark/ci-gate.mjs — strict stale-baseline failure (FIX 3c)', () => {
  const source = readFileSync(CI_GATE_PATH, 'utf8');

  it('declares a STRICT flag from --strict or CI_GATE_STRICT', () => {
    expect(source).toMatch(/const STRICT\s*=/);
    expect(source).toMatch(/--strict/);
    expect(source).toMatch(/CI_GATE_STRICT/);
  });

  it('records a staleFailure and folds it into the final non-zero exit', () => {
    expect(source).toMatch(/staleFailure\s*=\s*true/);
    // Final exit must consider staleFailure (so strict stale → exit 1).
    expect(source).toMatch(/totalFailures\s*>\s*0\s*\|\|\s*staleFailure/);
  });

  it('keeps the advisory (non-strict) branch — default runs do NOT fail on stale', () => {
    // The advisory wording must remain for the default path so local iteration
    // is unaffected and the v2.41 contract holds.
    expect(source).toMatch(/advisory, not a failure/i);
  });

  // Behavioral guard, both directions. Runs against a FIXTURE baseline (--baseline)
  // whose timestamp we set, not the committed one: keying the assertion off the real
  // baseline's age made the suite go red on the calendar (32d old on 2026-07-24)
  // instead of on a regression, which trains people to ignore a red suite. Recapture
  // pressure belongs to the gate itself (advisory warning + --strict in CI), not here.
  const withBaselineFixture = (ageDays, run) => {
    const dir = mkdtempSync(join(tmpdir(), 'cml-gate-baseline-'));
    const fixture = join(dir, 'baseline.json');
    try {
      const base = JSON.parse(readFileSync(join(REPO_ROOT, 'benchmark', 'baseline.json'), 'utf8'));
      base.timestamp = new Date(Date.now() - ageDays * 86400000).toISOString();
      writeFileSync(fixture, JSON.stringify(base));
      return run(fixture);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const gateExitCode = (fixture) => {
    try {
      execFileSync('node', ['benchmark/ci-gate.mjs', '--strict', '--skip-matrix', '--baseline', fixture], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return 0;
    } catch (err) {
      return err.status ?? 1;
    }
  };

  it('strict mode with a fresh baseline PASSES (exit 0)', () => {
    expect(withBaselineFixture(1, gateExitCode)).toBe(0);
  }, 60000);

  it('strict mode with a stale baseline FAILS (exit 1) even when every metric passes', () => {
    expect(withBaselineFixture(BASELINE_STALE_DAYS + 2, gateExitCode)).toBe(1);
  }, 60000);
});
