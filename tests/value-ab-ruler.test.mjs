// benchmark/value-ab/ — the plugin-vs-host-memory continuity A/B (docs/audits/20261124-plugin-value-assessment.md).
// The live arms need `claude -p` and are not run here; these cases pin the deterministic ruler: the seed it
// builds, the hidden acceptance (it must be able to say both NO and YES), and the exact test the report quotes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { buildSeed, applyReference } from '../benchmark/value-ab/seed.mjs';
import { evaluate } from '../benchmark/value-ab/eval.mjs';
import { fisherTwoSided } from '../benchmark/value-ab/analyze.mjs';

let root;
let scratch;
const fresh = (name) => {
  const dir = join(root, name);
  buildSeed(dir);
  return dir;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cml-valueab-'));
  scratch = join(root, 'scratch');
  mkdirSync(scratch);
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('value-ab seed', () => {
  it('builds a two-commit repo whose own tests pass and whose planted allocate bug is still there', async () => {
    const dir = fresh('seed');
    const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n');
    expect(log).toHaveLength(2);
    expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    const { allocate } = await import(pathToFileURL(join(dir, 'src', 'money.mjs')).href);
    const shares = allocate(10000, [1, 1, 1]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(9999);
  }, 60000);
});

describe('value-ab hidden acceptance', () => {
  it('says NO on the untouched seed: E1 false, E2 0/4, suite and noDeps true', async () => {
    const r = await evaluate(fresh('ruler-seed'), scratch);
    expect(r.suite).toBe(true);
    expect(r.noDeps).toBe(true);
    expect(r.E1).toBe(false);
    expect(r.E2pass).toBe(0);
    expect(r.E2all).toBe(false);
  }, 60000);

  it('says YES on the S1+S2 reference solution: E1 true, E2 4/4', async () => {
    const dir = fresh('ruler-ref');
    applyReference(dir);
    const r = await evaluate(dir, scratch);
    expect(r).toMatchObject({ suite: true, noDeps: true, E1: true, E2pass: 4, E2all: true });
  }, 60000);

  it('catches a wrong SAVE10 (10% -> 1%) as 3/4, with the mutation asserted applied', async () => {
    const dir = fresh('ruler-mut');
    applyReference(dir);
    const file = join(dir, 'src', 'invoice.mjs');
    const before = readFileSync(file, 'utf8');
    const after = before.replace('Math.round(subtotal * 0.1)', 'Math.round(subtotal * 0.01)');
    expect(after).not.toBe(before);
    writeFileSync(file, after);
    const r = await evaluate(dir, scratch);
    expect(r.E2).toMatchObject({ save10: false, flat5: true, lineDiscount: true, bogusRejected: true });
    expect(r.E2pass).toBe(3);
  }, 60000);

  it('catches an added dependency as noDeps false', async () => {
    const dir = fresh('ruler-dep');
    const pkgFile = join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    pkg.dependencies = { commander: '^12.0.0' };
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
    const r = await evaluate(dir, scratch);
    expect(r.noDeps).toBe(false);
  }, 60000);
});

describe('value-ab analysis', () => {
  it('reproduces the Fisher p-values the 2026-11-24 report quotes', () => {
    expect(fisherTwoSided(8, 8, 1, 8)).toBeCloseTo(0.0014, 4);
    expect(fisherTwoSided(4, 4, 0, 4)).toBeCloseTo(0.0286, 4);
    expect(fisherTwoSided(8, 8, 3, 8)).toBeCloseTo(0.0256, 4);
    expect(fisherTwoSided(4, 8, 4, 8)).toBeCloseTo(1, 6);
  });
});
