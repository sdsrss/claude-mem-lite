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
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// D#55: every vitest run leaves one `<TMPDIR>/<id>/ssr` cache (45 MB for a full-suite run,
// 610 files; single-file runs 44 K-5.4 MB), and /tmp here is a 12 GB tmpfs. 627 of them
// filled it and the Bash tool died with no output. 6e5439c moved `npm test` / `test:coverage`
// to an on-disk TMPDIR, but the pre-commit hook still ran bare `npx vitest run`, so each
// commit wrote one full-suite cache to /tmp. One home for the TMPDIR choice: the package.json scripts. The population
// below is the git hook, the CI workflows, and `npm run audit:baseline`, which spawns the suite
// from scripts/audit-metrics.mjs (D#60 — it used to run `node_modules/.bin/vitest` with the
// inherited environment, so every baseline wrote its cache to /tmp).
describe('suite runs keep vitest caches off the RAM-backed /tmp (D#55)', () => {
  const callers = [
    'scripts/pre-commit.sh',
    '.githooks/pre-commit',
    ...readdirSync(join(REPO, '.github', 'workflows')).map((f) => `.github/workflows/${f}`),
  ];

  it('no automated caller runs vitest directly', () => {
    const bare = [];
    for (const rel of callers) {
      readFileSync(join(REPO, rel), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*#/.test(line)) return;
          // `npx vitest` with no `run` also runs the suite once outside a TTY (pre-ship review P3-7).
          // Exempt only prose that names the command in backticks (sandbox-install.yml:81); a
          // quoted YAML `run: 'npx vitest run'` is still an invocation (pre-ship claims review).
          if (/\b(npx\s+vitest|vitest\s+run)\b/.test(line) && !/`[^`]*vitest[^`]*`/.test(line))
            bare.push(`${rel}:${i + 1}`);
        });
    }
    expect(bare).toEqual([]);
  });

  it('the pre-commit hook runs the suite through npm test, whose script sets an on-disk TMPDIR', () => {
    // Indented since the suite call moved under the green-stamp reuse branch; a command, not
    // prose: the line must START with it, so an `echo "… npm test …"` cannot satisfy this.
    expect(readFileSync(join(REPO, CANONICAL), 'utf8')).toMatch(/^\s*npm test\b/m);
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    for (const script of ['test', 'test:coverage']) {
      expect(pkg.scripts[script], script).toMatch(/TMPDIR="\$HOME\/\.cache\/tmp" vitest run/);
    }
  });

  it("audit:baseline runs the suite through the repo's test:coverage script (D#60)", () => {
    // Behavioural rather than a scan of audit-metrics.mjs: point it at a fixture repo whose
    // `test:coverage` records the arguments it was handed. Spawning vitest any other way
    // finds no `node_modules/.bin/vitest` here and parses nothing.
    const fx = mkdtempSync(join(tmpdir(), 'mem-d60-'));
    try {
      writeFileSync(
        join(fx, 'package.json'),
        JSON.stringify({ name: 'fx', version: '0.0.0', scripts: { 'test:coverage': 'node rec.mjs' } }),
      );
      writeFileSync(
        join(fx, 'rec.mjs'),
        "import { writeFileSync } from 'node:fs';\n" +
          "writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\n" +
          "console.log(' Test Files  1 passed (1)\\n      Tests  2 passed (2)');\n",
      );
      const out = execFileSync(
        process.execPath,
        [join(REPO, 'scripts', 'audit-metrics.mjs'), '--run-tests'],
        {
          env: { ...process.env, AUDIT_METRICS_REPO: fx },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const { vitest } = JSON.parse(out);
      expect(vitest.status).toBe(0);
      expect(vitest.tests).toBe('Tests 2 passed');
      // The reporters coverageSummary() reads must still be requested.
      expect(JSON.parse(readFileSync(join(fx, 'argv.json'), 'utf8'))).toEqual(
        expect.arrayContaining(['--coverage.reporter=json-summary']),
      );
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });
});
