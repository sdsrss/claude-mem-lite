// `scripts/audit-metrics.mjs` is a RULER: `docs/audit/*.md` quotes its duplicate rate, its
// long-function counts and its cycle counts as measurements, and `npm run audit:baseline`
// is what a round compares itself against. It shipped with 530 lines and zero guards.
//
// The risk is not a crash — it is a plausible WRONG NUMBER. A detector that silently returns
// empty reports a clean, well-factored tree, and 0% duplication is the answer that gets
// believed rather than questioned. This repo has the shape on record already (the `grep`
// that returned EMPTY rather than erroring and produced a self-check undercount).
//
// So the checks live inside the tool, in the same shape as `benchmark/*.mjs`'s self-checks,
// and this file is the WIRING half: it proves the mode is reachable, that it passes on the
// real tree, and — the part that matters — that it is able to FAIL. A self-check that cannot
// go non-zero is decoration, and asserting only "exit 0" would not tell the two apart.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './shipped-tree.mjs';
import { SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';

const SCRIPT = join(REPO, 'scripts', 'audit-metrics.mjs');

/**
 * Run `--self-check` from a MUTATED copy of the script, placed in a temp dir and pointed
 * back at the real tree with AUDIT_METRICS_REPO.
 *
 * A copy rather than an in-place edit because a concurrent agent restoring the wrong
 * snapshot of a working-tree file is a failure mode this repo has already paid for.
 *
 * The copy lives under `node_modules/.cache/`, which is neither of the two obvious choices
 * and for a reason each: NOT `scripts/`, because an extra source file there moves the
 * per-file case count `tests/obs-id-caliber-sync.test.mjs` generates; NOT `os.tmpdir()`,
 * because Node resolves `node_modules` UP the tree and the script imports `acorn` — a copy
 * outside the repo dies with ERR_MODULE_NOT_FOUND, which is a non-zero exit for the wrong
 * reason and would have made all three mutation cases pass vacuously. The `unmutated copy
 * still passes` case above is what catches that, and it is why it is there.
 */
function runMutated(find, replace) {
  mkdirSync(join(REPO, 'node_modules', '.cache'), { recursive: true });
  const dir = mkdtempSync(join(REPO, 'node_modules', '.cache', 'audit-metrics-mut-'));
  try {
    const src = readFileSync(SCRIPT, 'utf8');
    const broken = src.replace(find, replace);
    // Premise. `String.replace` with a non-matching needle returns the input unchanged and
    // the run would then simply pass, "proving" a guard that was never exercised.
    expect(broken, `mutation anchor did not match: ${find}`).not.toBe(src);
    const copy = join(dir, 'audit-metrics.mjs');
    writeFileSync(copy, broken);
    return spawnSync(process.execPath, [copy, '--self-check'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: SUBPROCESS_TIMEOUT_MS,
      env: { ...process.env, AUDIT_METRICS_REPO: REPO },
    });
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

describe('audit-metrics --self-check', () => {
  it('passes on the real tree', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--self-check'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('audit-metrics self-check: OK');
  });

  it('an unmutated copy run through AUDIT_METRICS_REPO still passes', () => {
    // Premise for the two mutation cases: they run a copy from a temp dir, so a copy that
    // failed for its LOCATION rather than for its mutation would make both of them pass for
    // the wrong reason. `x` → `x` is a no-op replace, so this is the same harness minus the
    // mutation.
    const r = runMutated('const REPO =', 'const REPO  =');
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
  });

  it('goes non-zero when the duplicate detector stops detecting', () => {
    // Break the cross-file duplicate accounting only: windows seen in two files stop being
    // marked, which is exactly the "reports a clean tree" failure.
    const r = runMutated(
      'if (fileSet.size > 1) dupCross[o.idx][o.start + k] = 1;',
      'if (fileSet.size > 99) dupCross[o.idx][o.start + k] = 1;',
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('duplicateRate reported 0 cross-file lines');
  });

  it('goes non-zero when the file walk returns nothing', () => {
    // The other direction: every figure the tool prints sits downstream of the walk, so a
    // walk that finds nothing makes the whole report read as a tiny, clean repo rather than
    // as a broken measurement.
    const r = runMutated('function walk(dir, out = []) {', 'function walk(dir, out = []) {\n  return out;');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/walk found 0 files/);
  });

  it('goes non-zero when the long-function detector stops flagging', () => {
    const r = runMutated(
      'const over = all.filter((x) => x.lines > LONG_FN_LINES);',
      'const over = all.filter((x) => x.lines > 100000);',
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('longFunctions did not flag');
  });
});
