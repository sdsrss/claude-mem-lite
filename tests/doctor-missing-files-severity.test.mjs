// `doctor` must grade a missing SOURCE_FILES entry by INSTALL SHAPE, because the same
// fact means opposite things in the two shapes — and it had the severity backwards.
//
// Node resolves ESM specifiers against a module's REALPATH (no --preserve-symlinks). So in
// a dev install every entry point is a symlink into the repo, and its `../lib/x.mjs`
// imports resolve inside the REPO — an absent `~/.claude-mem-lite/lib/x.mjs` changes
// nothing. Verified on the maintainer's own machine: doctor reported
//
//   ⚠ Dev drift: 6 missing: lib/injected-ids.mjs, lib/time-constants.mjs, …
//     (re-run: node …/install.mjs install --dev)
//
// while every hook that imports those exact modules was demonstrably working, because
// readlink -f ~/.claude-mem-lite/scripts/pre-tool-recall.js → the repo. A remedy was
// prescribed for a healthy install.
//
// In a COPY install (npm / plugin / `install` without --dev) the entry points are real
// files, so `../lib/x.mjs` resolves against the INSTALL DIR and a missing module is a hard
// ERR_MODULE_NOT_FOUND on every hook fire. That case produced NO doctor output at all:
// checkDevDrift returns devMode=false (devMode is "≥1 symlink"), and install.mjs gated
// both the warning AND the all-clear on devMode — so the shape where missing files are
// FATAL was the silent one. Same "gate the all-green string on every counter" rule (#8268)
// failing in the other direction.
//
// A hybrid install (symlinks + copied entry points) keeps the hard warning: a copied entry
// point does resolve against the install dir, so there the missing module can still bite.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { SOURCE_FILES } from '../source-files.mjs';

const INSTALLER = resolve(import.meta.dirname, '../install.mjs');
const REPO_FILE = resolve(import.meta.dirname, '../utils.mjs');
const homes = [];

// Every path something EXECUTES directly AND that install.mjs actually classifies —
// checkDevDrift iterates the caller's list, and install.mjs passes SOURCE_FILES, which
// holds no `scripts/` entries (hook scripts ship from the separate HOOK_SCRIPT_FILES
// manifest, which doctor does not yet check). An earlier version of this fixture listed
// all 13 hook-script paths, which read as coverage while only these 5 participated.
const ENTRIES = ['cli.mjs', 'mem-cli.mjs', 'server.mjs', 'hook.mjs', 'install.mjs'];

/** Build a fake INSTALL_DIR under a fake HOME in the given shape, then run `doctor --json`. */
function doctorOn({
  symlinkEntries = false,
  copyEntries = false,
  extraSymlinks = [],
  extraCopies = [],
  omitEntries = [],
}) {
  // Fresh HOME per call so two shapes can be compared in one test.
  const home = mkdtempSync(join(tmpdir(), 'doctor-shape-'));
  homes.push(home);
  const installDir = join(home, '.claude-mem-lite');
  mkdirSync(join(installDir, 'lib'), { recursive: true });
  mkdirSync(join(installDir, 'scripts'), { recursive: true });
  mkdirSync(join(installDir, 'runtime'), { recursive: true });
  // Entry points present in the shape under test; every lib/* module deliberately absent —
  // that is the fact whose SEVERITY differs between the shapes.
  for (const rel of ENTRIES) {
    if (omitEntries.includes(rel)) continue;
    if (symlinkEntries) symlinkSync(REPO_FILE, join(installDir, rel));
    else if (copyEntries) writeFileSync(join(installDir, rel), '// copy\n');
  }
  for (const rel of extraSymlinks) {
    mkdirSync(dirname(join(installDir, rel)), { recursive: true });
    symlinkSync(REPO_FILE, join(installDir, rel));
  }
  for (const rel of extraCopies) writeFileSync(join(installDir, rel), '// copy\n');
  // doctor exits non-zero when it finds issues — that is its contract, so read stdout
  // off the thrown error rather than treating the exit code as a harness failure.
  let out;
  try {
    out = execFileSync(process.execPath, [INSTALLER, 'doctor', '--json'], {
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: join(home, 'data'),
        CLAUDE_MEM_SKIP_UPDATE: '1',
        MEM_QUIET_HOOKS: '1',
      },
      encoding: 'utf8',
    });
  } catch (e) {
    out = e.stdout || '';
  }
  const start = out.indexOf('{');
  expect(start, `doctor emitted no JSON:\n${out.slice(0, 400)}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(out.slice(start));
}

// Label-scoped: the fake install dir deliberately holds only a couple of files, so
// unrelated doctor checks ("hook.mjs: missing", "Orphan hooks") also mention "missing".
// Only the managed-files check is under test here.
const MANAGED_LABEL = /^(Dev drift|Managed files):/;
function driftLines(report) {
  return (report.checks || []).filter((c) => MANAGED_LABEL.test(c.message || ''));
}

describe('doctor — missing-file severity by install shape', () => {
  afterEach(() => {
    for (const h of homes.splice(0)) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        /* gone */
      }
    }
  });

  it('a COPY install with missing managed files is reported, not silent', () => {
    // The shape where a missing module is fatal at runtime. It must not be the quiet one.
    const report = doctorOn({ copyEntries: true });
    const lines = driftLines(report);
    expect(
      lines.length,
      `copy install with missing files said nothing:\n${JSON.stringify(report.checks, null, 1)}`,
    ).toBeGreaterThan(0);
    expect(lines.some((c) => c.level === 'warn' || c.level === 'fail')).toBe(true);
    // And it must NOT prescribe the dev remedy to a non-dev install.
    expect(lines.some((c) => /install --dev/.test(c.message))).toBe(false);
  });

  it('a pure-symlink dev install does not COUNT reachable modules as an issue', () => {
    // Wording-independent judgement: compare `issues` against an otherwise identical
    // install that also links every import-only module. Unlinked-but-reachable modules
    // must add exactly zero issues, or doctor is prescribing a fix for a healthy install
    // (and exiting 1, which is what `1 issue(s) found` on the maintainer's machine was).
    const entrySet = new Set(ENTRIES);
    const modules = SOURCE_FILES.filter((f) => !entrySet.has(f));
    const withMissing = doctorOn({ symlinkEntries: true });
    const complete = doctorOn({ symlinkEntries: true, extraSymlinks: modules });
    expect(driftLines(withMissing).length, 'no managed-files line at all').toBeGreaterThan(0);
    expect(
      withMissing.issues,
      `${modules.length} unlinked-but-reachable modules were counted as issues ` +
        `(${withMissing.issues} vs ${complete.issues} for a fully linked install)`,
    ).toBe(complete.issues);
    // …and it must SAY why it is benign, so the reader does not run the remedy anyway.
    expect(
      driftLines(withMissing)
        .map((c) => c.message)
        .join(' '),
    ).toMatch(/realpath|resolve|repo|harmless|benign/i);
  });

  it('a MISSING entry point is an issue even in a pure-symlink install', () => {
    // Makes the entry-point classification observable in the DEMOTE direction. The other
    // cases create every entry point, so removing one from lib/doctor-drift.mjs's
    // ENTRY_POINTS set changed nothing they assert — only additions were caught. Here
    // hook.mjs is absent: an entry point is fatal in every install shape (the hook command
    // names that path directly), so the benign "reachable via realpath" branch must not
    // claim it.
    const withAll = doctorOn({ symlinkEntries: true });
    const missingEntry = doctorOn({ symlinkEntries: true, omitEntries: ['hook.mjs'] });
    expect(driftLines(missingEntry).length, 'no managed-files line at all').toBeGreaterThan(0);
    expect(
      missingEntry.issues,
      `an absent entry point added no issue (${missingEntry.issues} vs ${withAll.issues})`,
    ).toBeGreaterThan(withAll.issues);
    expect(
      driftLines(missingEntry)
        .map((c) => c.message)
        .join(' '),
    ).toMatch(/ENTRY POINT/);
  });

  it('a HYBRID install (a copied managed file among symlinks) still counts as an issue', () => {
    // A copied file resolves its imports against the install dir, so the
    // "reachable via realpath" argument does not extend to this shape — and a copy among
    // symlinks also means repo edits stopped propagating to it. Judged by issue COUNT
    // against the otherwise identical pure-symlink install, so no wording is load-bearing.
    const pure = doctorOn({ symlinkEntries: true });
    const hybrid = doctorOn({ symlinkEntries: true, extraCopies: ['utils.mjs'] });
    expect(driftLines(hybrid).length, 'no managed-files line at all').toBeGreaterThan(0);
    expect(
      hybrid.issues,
      `a copied managed file added no issue (${hybrid.issues} vs pure ${pure.issues})`,
    ).toBeGreaterThan(pure.issues);
  });
});
