// doctor renders the SAME diagnosis onto two faces, and the machine-readable one was the
// poorer of the two in two independent ways (R12 audit, partition C).
//
//   P2-3 — every remedy line goes through `log()`, and `log()` was a no-op under `--json`.
//          A `--json` consumer got `{level:'fail', message:'Database: file is not a database'}`
//          and nothing else, while the same run told a human to
//          `mv "…db" "…db.corrupt"`. Measured pre-fix: 12 of doctor's 14 `log(` sites carry
//          repair instructions; zero of them reached the JSON.
//   P2-4 — four checks call `warn()` (pushing `level:'warn'`) and then `issues++`. So
//          `issues` counted rows that report themselves as warnings, and
//          `buildDoctorSummary`'s documented contract ("`issues` are ✗-level") was false in
//          shipped code. Measured pre-fix on the corrupt-DB fixture below:
//          issues=4 / fail-level=3, warnings=6 / warn-level=7. A CI wrapper doing
//          `checks.filter(c => c.level === 'fail')` — the stated reason `--json` exists —
//          under-reported by exactly the four escalated-warning checks.
//
// Both are asserted against the JSON face by comparing it to the human face of the SAME
// run-shape, so neither assertion pins doctor's wording.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HOOK_SCRIPT_FILES } from '../source-files.mjs';

const INSTALLER = resolve(import.meta.dirname, '../install.mjs');
const homes = [];

afterAll(() => {
  for (const h of homes.splice(0)) {
    try {
      rmSync(h, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
});

// Entry points checkDevDrift actually grades (SOURCE_FILES holds no `scripts/` entries).
const ENTRIES = ['cli.mjs', 'mem-cli.mjs', 'server.mjs', 'hook.mjs', 'install.mjs'];
const REPO_FILE = resolve(import.meta.dirname, '../utils.mjs');

function makeHome({ corruptDb = false, install = null, omitEntries = [], partialScripts = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'doctor-parity-'));
  homes.push(home);
  const data = join(home, 'data');
  mkdirSync(data, { recursive: true });
  if (corruptDb) {
    // Not SQLite, so `new Database()` throws SQLITE_NOTADB — the one failure that
    // carries a multi-command remedy, and the audit's own repro.
    writeFileSync(join(data, 'claude-mem-lite.db'), Buffer.alloc(4096, 7));
  }
  if (install) {
    const dir = join(home, '.claude-mem-lite');
    mkdirSync(dir, { recursive: true });
    // Every lib/* module deliberately absent — that is what the drift checks grade.
    for (const rel of ENTRIES) {
      if (omitEntries.includes(rel)) continue;
      if (install === 'symlink') symlinkSync(REPO_FILE, join(dir, rel));
      else writeFileSync(join(dir, rel), '// copy\n');
    }
    if (partialScripts) {
      // Present but incomplete: `h.present && h.missingCount > 0`, a different branch from
      // the absent-directory one a bare HOME reaches.
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      for (const name of HOOK_SCRIPT_FILES.slice(0, 3)) {
        writeFileSync(join(dir, 'scripts', name), '// copy\n');
      }
    }
  }
  return home;
}

/** Run doctor in one HOME. `json` picks the face. doctor exits 1 when it finds issues. */
function runDoctor(home, { json }) {
  const args = [INSTALLER, 'doctor'];
  if (json) args.push('--json');
  try {
    return execFileSync(process.execPath, args, {
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: join(home, 'data'),
        CLAUDE_MEM_SKIP_UPDATE: '1',
        MEM_QUIET_HOOKS: '1',
        MEM_NO_AUTO_ADOPT: '1',
      },
      encoding: 'utf8',
    });
  } catch (e) {
    // Non-zero exit IS the contract when issues are found; the report is on stdout.
    return e.stdout || '';
  }
}

function parseJson(out) {
  const start = out.indexOf('{');
  expect(start, `doctor emitted no JSON:\n${out.slice(0, 400)}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(out.slice(start));
}

/**
 * Human-face lines that are NOT check headlines: `ok/warn/fail` print `  <glyph> msg`,
 * while `log()` prints `  ${msg}` and every call site indents its own message by at least
 * two more spaces. So four-or-more leading spaces selects detail lines and cannot catch the
 * summary line (two spaces, no glyph) or the banner (none). `{4,}` and not `{4}`: the
 * remedy lines indent by six, and the exact-width form quietly matched only the
 * continuation lines of multi-line check messages — which are already in the JSON, so the
 * parity assertion passed while the case it was written for went untested.
 */
function detailLines(humanOut) {
  return humanOut
    .split('\n')
    .filter((l) => /^ {4,}\S/.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
}

describe('doctor --json carries the repair instructions the human face prints', () => {
  it('every detail line on the human face is reachable in the JSON face', () => {
    const home = makeHome({ corruptDb: true });
    const human = runDoctor(home, { json: false });
    const report = parseJson(runDoctor(home, { json: true }));

    const details = detailLines(human);
    // Premise. The audit's alternative was to write this as a pure implication so that a
    // mutation killing `dbCheckRemedy` stays green — but a guard that goes green the moment
    // its fixture stops reproducing is the vacuous shape this repo has been bitten by.
    // Assert the premise instead: if the corrupt DB stops producing a remedy, this test
    // says so rather than passing on an empty set.
    expect(details.length, `fixture produced no detail lines:\n${human}`).toBeGreaterThan(0);
    expect(
      details.some((d) => d.includes('.db.corrupt')),
      `the corrupt-DB fixture no longer prints a restore remedy:\n${human}`,
    ).toBe(true);

    // Compare against the PARSED fields, not `JSON.stringify(report)`: every remedy here
    // quotes its paths, and stringify escapes those quotes, so a blob comparison reports a
    // remedy that is present as missing.
    const carried = report.checks.flatMap((c) => [c.message || '', ...(c.details || [])]).join('\n');
    const missing = details.filter((d) => !carried.includes(d));
    expect(missing, `the human face printed lines the --json face drops:\n  ${missing.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('the dropped lines are attached to the check they belong to, not to the report', () => {
    // Parity alone would be satisfied by dumping every detail into one top-level array.
    // A consumer acting on ONE check needs its own remedy, which is the stated purpose of
    // `--json` (install.mjs, doctor()'s header comment).
    const home = makeHome({ corruptDb: true });
    const report = parseJson(runDoctor(home, { json: true }));
    const dbCheck = report.checks.find((c) => /^Database:/.test(c.message || ''));
    expect(dbCheck, `no Database check in:\n${JSON.stringify(report.checks, null, 1)}`).toBeTruthy();
    expect(dbCheck.details?.join('\n') || '').toContain('.db.corrupt');
  });
});

describe('doctor counters agree with the levels it reports', () => {
  // The contract stated at buildDoctorSummary: `issues` are ✗-level, `warnings` are ⚠-level.
  // Both directions matter and the existing source-scan guard (doctor-summary.test.mjs) can
  // only see one of them: it asks whether every ✗ bumped the counter, never whether the
  // counter was bumped without a ✗. That reverse direction is exactly P2-4.
  // One shape per escalated-warning site. Four sites exist and a single fixture reaches
  // exactly one of them: the first cut of this file used two fixtures, and reverting the
  // `h.missingCount > 0` site to `warn(...) + issues++` left the suite GREEN — the mutation
  // was written to disk and the branch was never executed. `reaches` is the premise that
  // keeps each row honest; without it a fixture that stops entering its branch passes.
  const SHAPES = [
    { label: 'a corrupt database', opts: { corruptDb: true }, reaches: null },
    { label: 'a bare HOME (hook scripts absent)', opts: {}, reaches: /^Hook scripts: .*(absent|dangling)/ },
    {
      label: 'a dev install missing an entry point (dev drift)',
      opts: { install: 'symlink', omitEntries: ['hook.mjs'] },
      reaches: /^Dev drift:/,
    },
    {
      label: 'a copy install missing its modules (managed files)',
      opts: { install: 'copy' },
      reaches: /^Managed files:/,
    },
    {
      label: 'a partial hook-script dir',
      opts: { install: 'copy', partialScripts: true },
      reaches: /^Hook scripts: \d+ missing/,
    },
  ];

  for (const { label, opts, reaches } of SHAPES) {
    it(`counters equal the level tallies — ${label}`, () => {
      const home = makeHome(opts);
      const report = parseJson(runDoctor(home, { json: true }));
      const byLevel = (lvl) => report.checks.filter((c) => c.level === lvl);
      const fails = byLevel('fail');
      const warns = byLevel('warn');
      expect(
        report.issues,
        `issues=${report.issues} but ${fails.length} check(s) report level 'fail':\n  ` +
          fails.map((c) => c.message).join('\n  '),
      ).toBe(fails.length);
      expect(
        report.warnings,
        `warnings=${report.warnings} but ${warns.length} check(s) report level 'warn':\n  ` +
          warns.map((c) => c.message).join('\n  '),
      ).toBe(warns.length);

      if (!reaches) return;
      const hit = report.checks.find((c) => reaches.test(c.message || ''));
      expect(
        hit,
        `fixture no longer reaches ${reaches}:\n${report.checks.map((c) => c.message).join('\n')}`,
      ).toBeTruthy();
      // The fix must not be "promote these four to fail()": two guard files
      // (doctor-missing-files-severity, doctor-hook-script-manifest) exist because these
      // findings must not be rendered at ✗ severity. level and glyph are separate facts —
      // level is what the counter and the exit code read, glyph is how loud the screen is.
      expect(hit.level).toBe('fail');
      expect(hit.glyph).toBe('warn');
      const onScreen = runDoctor(home, { json: false })
        .split('\n')
        .find((l) => reaches.test(l.replace(/^\s*[⚠✗✓]\s*/, '')));
      expect(onScreen, `not on the human face at all`).toBeTruthy();
      expect(onScreen.trimStart().startsWith('⚠'), `rendered as: ${onScreen.trim().slice(0, 40)}`).toBe(true);
    });
  }
});
