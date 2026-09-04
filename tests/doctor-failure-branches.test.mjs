// Audit 2026-09-02 P1-15, second half: `doctor` renders 26 distinct check lines and 15 of
// them appear NOWHERE under `tests/`. The ones with no coverage are exactly the ones that
// matter — a health check nobody has ever seen fire is a health check nobody knows can
// fire, and doctor's whole job is telling a user why their install is broken.
//
// Three failure branches are pinned here, each driven through the real `install.mjs doctor
// --json` in a subprocess against a fixture HOME. `--json` rather than the human output
// because the level (`fail`/`warn`) is the assertion — matching on the ✗ glyph or on prose
// pins the rendering instead of the verdict.
//
// Every case asserts a PREMISE first: that the same fixture reports the check as `ok` once
// the defect is removed. Without it, "the entry says fail" also passes when the fixture is
// so broken that doctor never reaches the check at all — and a check that never ran is the
// exact thing this file exists to catch.
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO } from './shipped-tree.mjs';
import { HOOK_SCRIPT_FILES } from '../source-files.mjs';
import { SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';

const INSTALLER = join(REPO, 'install.mjs');
const ENTRIES = ['cli.mjs', 'mem-cli.mjs', 'server.mjs', 'hook.mjs', 'install.mjs'];
const homes = [];

afterAll(() => {
  for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

/** A fixture install that doctor considers healthy, so each case can break exactly one thing. */
function healthyHome() {
  const home = mkdtempSync(join(tmpdir(), 'doctor-branches-'));
  homes.push(home);
  const installDir = join(home, '.claude-mem-lite');
  mkdirSync(join(installDir, 'lib'), { recursive: true });
  mkdirSync(join(installDir, 'runtime'), { recursive: true });
  for (const rel of ENTRIES) writeFileSync(join(installDir, rel), '// copy\n');
  const scripts = join(installDir, 'scripts');
  mkdirSync(scripts, { recursive: true });
  for (const name of HOOK_SCRIPT_FILES) {
    mkdirSync(dirname(join(scripts, name)), { recursive: true });
    writeFileSync(join(scripts, name), '// copy\n');
  }
  return { home, installDir };
}

/** Run `doctor --json` and return the parsed check list. doctor exits non-zero by design. */
function doctorChecks(home) {
  let out;
  try {
    out = execFileSync(process.execPath, [INSTALLER, 'doctor', '--json'], {
      env: {
        ...process.env, HOME: home, CLAUDE_MEM_DIR: join(home, 'data'),
        CLAUDE_MEM_SKIP_UPDATE: '1', MEM_QUIET_HOOKS: '1',
      },
      encoding: 'utf8',
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const from = out.indexOf('{');
  expect(from, `doctor emitted no JSON:\n${out.slice(0, 500)}`).toBeGreaterThanOrEqual(0);
  const parsed = JSON.parse(out.slice(from, out.lastIndexOf('}') + 1));
  // `doctor --json` emits `{issues, warnings, summary, checks: [...]}`. Reaching for
  // `Object.values(parsed)` — which a first cut did — yields `[4, 3, "4 issue(s)…", [...]]`
  // and every `find` over it returns undefined, so all three cases failed claiming the
  // branch never fired. The verdict lives in `checks`; assert it is there rather than
  // defaulting to `[]`, or a shape change turns these into three silent no-ops.
  expect(Array.isArray(parsed.checks),
    `doctor --json has no checks array; got keys ${Object.keys(parsed).join(', ')}`).toBe(true);
  return parsed.checks;
}

const find = (checks, re) => checks.find((c) => re.test(c.message || ''));

describe('doctor reports its failure branches', () => {
  it('server.mjs missing → fail', () => {
    const { home, installDir } = healthyHome();

    // Premise: with the file present the same fixture does NOT report it missing. Without
    // this, the assertion below passes on any fixture doctor cannot get through at all.
    const before = find(doctorChecks(home), /server\.mjs.*missing/i);
    expect(before, 'premise: healthy fixture must not already report server.mjs missing').toBeUndefined();

    unlinkSync(join(installDir, 'server.mjs'));
    const entry = find(doctorChecks(home), /server\.mjs.*missing/i);
    expect(entry, 'doctor did not report a missing server.mjs at all').toBeTruthy();
    expect(entry.level).toBe('fail');
  });

  it('hook.mjs missing → fail, and it is a SEPARATE check from server.mjs', () => {
    // The two are adjacent lines in the same branch. Asserting them separately is what
    // catches one being deleted or both collapsing onto one message — a loop over the pair
    // would stay green if the second stopped existing.
    const { home, installDir } = healthyHome();
    expect(find(doctorChecks(home), /hook\.mjs.*missing/i)).toBeUndefined();

    unlinkSync(join(installDir, 'hook.mjs'));
    const checks = doctorChecks(home);
    const hookEntry = find(checks, /hook\.mjs.*missing/i);
    expect(hookEntry, 'doctor did not report a missing hook.mjs').toBeTruthy();
    expect(hookEntry.level).toBe('fail');

    // AND server.mjs is reported missing too, although it is still on disk. That is not a
    // bug and not what a first draft of this case assumed (it asserted the opposite): the
    // two checks are not independent, because `detectInstallShape` calls a directory a
    // managed install only when server.mjs AND hook.mjs are both present. Remove one and
    // the shape flips, so doctor stops resolving EITHER path against that directory.
    //
    // Pinned as observed rather than as expected, because the alternative — quietly
    // dropping the assertion — would leave the coupling undocumented, and someone later
    // "fixing" server.mjs's report to be independent would be changing shape detection
    // without knowing it.
    const serverEntry = find(checks, /server\.mjs.*missing/i);
    expect(serverEntry, 'the two checks share install-shape detection — see comment').toBeTruthy();
    expect(serverEntry.level).toBe('fail');

    // …and they must be TWO entries. The comment above claims asserting them separately
    // catches "both collapsing onto one message"; the v3.93.0 pre-tag review showed it did
    // not — a single `fail('server.mjs and hook.mjs: missing')` satisfies both regexes, and
    // `find()` then returns the SAME object twice with level 'fail'. Two `find()` hits are
    // not two checks unless you say so.
    // `not.toBe` is the WHOLE of the catch. A `checks.filter(/missing/i).length >= 2`
    // companion was dropped rather than kept as reassurance: with the two calls merged the
    // fixture still yields two matching rows (the merged one plus an unrelated
    // `Managed files: N missing` warn), so it passes under the exact defect it was written
    // against — decoration that reads as coverage.
    expect(serverEntry, 'server.mjs and hook.mjs collapsed onto one check').not.toBe(hookEntry);
  });

  it('a hook script named by a command line is missing → the drift check fires', () => {
    // HOOK_SCRIPT_FILES is the manifest install.mjs writes; doctor cross-checks it against
    // what is on disk. This branch is what turns "my hooks silently stopped working" into
    // a named file.
    const { home, installDir } = healthyHome();
    const victim = HOOK_SCRIPT_FILES.find((f) => f.endsWith('user-prompt-search.js'))
      || HOOK_SCRIPT_FILES[0];
    expect(victim, 'premise: the manifest must be non-empty').toBeTruthy();

    const clean = doctorChecks(home);
    expect(find(clean, new RegExp(victim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
      'premise: healthy fixture must not already name this script').toBeUndefined();

    unlinkSync(join(installDir, 'scripts', victim));
    const entry = find(doctorChecks(home), new RegExp(victim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(entry, `doctor did not name the missing ${victim}`).toBeTruthy();
    // Pinned to the level this branch ACTUALLY emits, measured rather than assumed. The
    // first cut accepted `['fail', 'warn']`, which is not an assertion about the level at
    // all: the branch already emits 'warn', so the fail→warn downgrade the file header says
    // it guards against was the one thing it could not see.
    expect(entry.level).toBe('warn');
  });
});
