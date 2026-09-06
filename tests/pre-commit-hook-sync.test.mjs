// The pre-commit hook git will ACTUALLY run must be scripts/pre-commit.sh — audit
// 2026-09-02 P1-11.
//
// `.git/hooks/` is untracked, so a clone starts with no hook and a copy made once goes
// stale in silence. Measured on the maintainer's machine: `.git/hooks/pre-commit` was a
// 2050 B copy from 2026-03-27 against a 6290 B `scripts/pre-commit.sh` — 72 lines of
// divergence, meaning the `@emnapi` lockfile-pruning guard and the frozen-corpus commit
// gate had never once run locally. Nothing in the repo installed or checked the hook:
// no `prepare` script, no `hooksPath` mention anywhere, no `.githooks/`.
//
// The fix is `core.hooksPath = .githooks` plus a tracked one-line exec shim, and this
// pins it. Two cases, and they cover different machines on purpose: the MODE case runs
// everywhere including CI (it reads the git index), the WIRING case can only run where a
// hook is actually installed and skips loudly elsewhere rather than asserting something
// vacuously true (#10831 — `expect(list).toContain('x')` passes on a walker that ignores
// the list entirely).

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// D#207: join(), never `new URL('../x', import.meta.url)` — the URL form silently drops
// whatever module it names out of knip's unused-export report.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// cwd pinned to the repo: an unpinned `git` subprocess reads whatever repo the runner
// happens to sit in, which is the 2026-08-29 audit's own P1 finding.
const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const CANONICAL = 'scripts/pre-commit.sh';

describe('pre-commit hook sync (P1-11)', () => {
  it('the tracked shim is recorded EXECUTABLE in the index', () => {
    // Not a style point. This repo has `core.fileMode = false`, so the on-disk +x bit is
    // not what a clone receives — the index mode is. Git skips a non-executable hook
    // SILENTLY, so a 100644 here reproduces the exact defect (gate present, never runs)
    // in a shape that looks fixed.
    const entry = git('ls-files', '-s', '.githooks/pre-commit');
    expect(entry, '.githooks/pre-commit is not tracked — the shim must be committed').not.toBe('');
    expect(entry.split(/\s/)[0], 'shim is not mode 100755; git will skip it silently').toBe('100755');

    // R10 P2-20, found by wiring core.hooksPath and watching the very next commit fail
    // with "Permission denied": the shim's whole body is `exec .../scripts/pre-commit.sh`,
    // and that file was tracked 100644. The shim could never have worked as committed, on
    // any clone. Only the SHIM's mode was pinned here, so nothing said so.
    const canonicalEntry = git('ls-files', '-s', CANONICAL);
    expect(canonicalEntry, `${CANONICAL} is not tracked`).not.toBe('');
    expect(
      canonicalEntry.split(/\s/)[0],
      `${CANONICAL} is not mode 100755, so the exec shim cannot run it`,
    ).toBe('100755');
  });

  it('the escape hatch out of the skip below is discoverable', () => {
    // R10 P2-20. The case after this one SKIPS when no hook is installed, which is correct
    // for a fresh CI clone — but it means a contributor whose clone was never wired sees a
    // green suite with the local gate switched off, indefinitely. That was the state of the
    // maintainer's own machine when R10 measured it: no core.hooksPath, no .git/hooks/
    // pre-commit, `1 passed | 1 skipped`. Nothing can make the skip an error without
    // breaking CI, so pin the next best thing: the one-line fix exists and is written down.
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    expect(pkg.scripts['hooks:install'], 'no npm script wires core.hooksPath').toMatch(/core\.hooksPath/);
    // Explicitly NOT `prepare` / `postinstall`: wiring git config as a side effect of
    // `npm install` is user-global-ish state written without asking.
    expect(pkg.scripts.prepare, 'hooks must not be wired by a lifecycle script').toBeUndefined();
    expect(pkg.scripts.postinstall).toBeUndefined();
    const contributing = readFileSync(join(REPO, 'CONTRIBUTING.md'), 'utf8');
    expect(contributing, 'CONTRIBUTING does not tell anyone to run it').toContain('npm run hooks:install');
  });

  it('whatever hook git will run is the canonical script (or an exec shim to it)', (ctx) => {
    const configured = git('config', 'core.hooksPath');
    const hooksDir = configured
      ? isAbsolute(configured)
        ? configured
        : join(REPO, configured)
      : join(REPO, '.git', 'hooks');
    const hookPath = join(hooksDir, 'pre-commit');

    if (!existsSync(hookPath)) {
      // A fresh CI clone has no hooks; that is not a failure, and pretending to assert
      // something here would be the always-true guard this file's header warns about.
      ctx.skip(`no pre-commit hook installed at ${hookPath} (fresh clone / CI) — nothing to compare`);
      return;
    }

    const body = readFileSync(hookPath, 'utf8');
    const canonical = readFileSync(join(REPO, CANONICAL), 'utf8');
    const isShim = body.includes(CANONICAL);
    const isCopy = body === canonical;

    expect(
      isShim || isCopy,
      `${hookPath} is neither ${CANONICAL} nor an exec shim naming it. This is the P1-11 ` +
        `defect: an untracked stale copy. Fix with:\n` +
        `  git config core.hooksPath .githooks`,
    ).toBe(true);

    // A byte copy is accepted (it is correct today) but it is the shape that rots — it was
    // correct on 2026-03-27 too. Reported through ctx.annotate, not an assertion: the
    // version that shipped here was `expect(body.length).toBe(canonical.length)` guarded by
    // `isCopy`, and `isCopy` already means the two strings are identical, so the comparison
    // was a tautology presented as a warning. A note is what this actually is; the binding
    // rule is the assertion above.
    if (isCopy && !isShim) {
      ctx.annotate?.(
        `${hookPath} is a byte copy of ${CANONICAL}, not a shim. It is correct now and will ` +
          `silently go stale on the next edit to ${CANONICAL}. Prefer:\n` +
          `  git config core.hooksPath .githooks`,
        'warning',
      );
    }
  });
});
