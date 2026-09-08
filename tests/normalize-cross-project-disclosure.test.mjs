// The CLAUDE_MEM_NORMALIZE_CROSS_PROJECT escape hatch must be DISCOVERABLE on the path
// where it actually changes behaviour — and stderr is not that path.
//
// History, because this is the second repair of the same defect and the first one looked
// exactly like a fix. R10-P3-21's second review found the hatch's warning going through
// `debugLog`, which returns early unless CLAUDE_MEM_DEBUG is set — so it fired zero times
// in the detached worker that is the only place the hatch is used unattended. The repair
// swapped it for a bare `console.error`, and the test that certified the repair spied on
// `console.error` IN PROCESS. That proves the function emits. It does not prove anyone
// receives.
//
// It does not: `hook.mjs` reaches this path via `spawnBackground('llm-optimize')`, and
// `hook-shared.mjs` spawns with `stdio: 'ignore'`, i.e. the child's fd 2 IS /dev/null.
// Removing the CLAUDE_MEM_DEBUG gate removed one of two blockers; the remaining one is
// sufficient on its own, so the warning still reached nobody on the unattended path.
//
// So the channel had to become one the detached worker does not own: `doctor`, which the
// USER runs in their own terminal. Same shape as install.mjs's CLAUDE_MEM_SKIP_SIG_VERIFY
// precedent — tell the operator a protection is switched off, on a surface they look at.
// The `console.error` stays and is still correct for the foreground CLI path
// (`claude-mem-lite optimize --run --task normalize`), which is why it is not removed here.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const INSTALLER = resolve(import.meta.dirname, '../install.mjs');
const HOOK_SHARED = resolve(import.meta.dirname, '../hook-shared.mjs');
const homes = [];

/** Run `doctor --json` under a throwaway HOME, with `env` merged over the base. */
function doctorWith(env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'normalize-disclosure-'));
  homes.push(home);
  mkdirSync(join(home, '.claude-mem-lite'), { recursive: true });
  let out;
  try {
    out = execFileSync(process.execPath, [INSTALLER, 'doctor', '--json'], {
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: join(home, 'data'),
        CLAUDE_MEM_SKIP_UPDATE: '1',
        MEM_QUIET_HOOKS: '1',
        MEM_NO_AUTO_ADOPT: '1',
        // Explicitly cleared in the base so a maintainer who has the hatch set in their own
        // shell does not turn the control arm into a second positive arm.
        CLAUDE_MEM_NORMALIZE_CROSS_PROJECT: '',
        ...env,
      },
      encoding: 'utf8',
    });
  } catch (e) {
    // doctor exits non-zero when it finds issues — that is its contract on a fixture HOME
    // with no install in it, so read stdout off the thrown error.
    out = e.stdout || '';
  }
  const start = out.indexOf('{');
  expect(start, `doctor emitted no JSON:\n${out.slice(0, 400)}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(out.slice(start));
}

const hatchLines = (report) =>
  (report.checks || []).filter((c) => /CLAUDE_MEM_NORMALIZE_CROSS_PROJECT/.test(c.message || ''));

describe('CLAUDE_MEM_NORMALIZE_CROSS_PROJECT disclosure', () => {
  afterEach(() => {
    for (const h of homes.splice(0)) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        /* gone */
      }
    }
  });

  it('doctor tells the operator when cross-project normalize is switched ON', () => {
    const report = doctorWith({ CLAUDE_MEM_NORMALIZE_CROSS_PROJECT: '1' });
    const lines = hatchLines(report);
    expect(
      lines.length,
      `doctor said nothing about the hatch:\n${JSON.stringify(report.checks, null, 1)}`,
    ).toBeGreaterThan(0);
    // ⚠, not ✗: the flag is set deliberately. It must be visible without failing the
    // diagnostic exit code that CI wrappers gate deploys on.
    expect(lines.every((c) => c.level === 'warn')).toBe(true);
    const text = lines.map((c) => c.message).join(' ');
    // The finding id, so a reader can reach the reasoning rather than just the fact.
    expect(text).toContain('R10-P3-21');
  });

  it('says nothing, and costs no issue, when the hatch is off', () => {
    const off = doctorWith();
    const on = doctorWith({ CLAUDE_MEM_NORMALIZE_CROSS_PROJECT: '1' });
    expect(hatchLines(off).length, 'warned about a hatch nobody set').toBe(0);
    // Judged by COUNT rather than by wording: the disclosure must not push doctor to
    // exit 1, or it becomes a reason to stop running doctor.
    expect(on.issues, `the disclosure added ${on.issues - off.issues} issue(s) — it must be advisory`).toBe(
      off.issues,
    );
  });

  it('only the documented value discloses — a typo must not read as opted-in', () => {
    // Pins doctor to the SAME `=== '1'` comparison executeNormalize makes. A doctor that
    // warned on `true` would describe a machine that is in fact still fanning out, which is
    // the mirror image of the defect this whole round is about.
    for (const v of ['true', 'on', 'yes', '0']) {
      const report = doctorWith({ CLAUDE_MEM_NORMALIZE_CROSS_PROJECT: v });
      expect(hatchLines(report).length, `"${v}" is not the opt-in value`).toBe(0);
    }
  });

  it('TRIPWIRE: the unattended worker still has no stderr, which is why doctor carries this', () => {
    // The premise the doctor check exists for. If someone gives the detached spawner a real
    // stderr (a log file, `inherit`), this goes red — at which point re-judge whether the
    // console.error alone is enough and whether this disclosure is still the only channel.
    // Read as source rather than executed because `spawnBackground` hands back no handle:
    // with stdio:'ignore' there is, by construction, nothing to capture.
    const src = readFileSync(HOOK_SHARED, 'utf8');
    const at = src.indexOf('export function spawnBackground');
    expect(at, 'spawnBackground moved — re-point this tripwire').toBeGreaterThanOrEqual(0);
    // Bounded by the function's OWN closing brace rather than a fixed byte count (pre-tag
    // review, P3): a fixed slice drifts into whatever follows as the file grows, and then a
    // `stdio` belonging to some other spawner can satisfy this guard while this one changed.
    const end = src.indexOf('\n}', at);
    expect(end, 'no closing brace found for spawnBackground').toBeGreaterThan(at);
    const body = src
      .slice(at, end)
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(body.match(/stdio:/g) || [], 'exactly one stdio key in this function').toHaveLength(1);
    expect(body).toMatch(/stdio:\s*'ignore'/);
  });
});
