// A remedy doctor prints has to be a command the reader can actually run.
//
// On a HOME with no claude-mem-lite deployed, doctor said:
//
//   Hook scripts: <home>/.claude-mem-lite/scripts is absent — ... Fix: claude-mem-lite
//   self-update (or: node <home>/.claude-mem-lite/cli.mjs repair)
//
// `cli.mjs` is one of the files whose absence produced that verdict, so the alternative it
// offers cannot start. The managed-files check carries the same remedy and reaches the same
// state as soon as anything creates the data dir.
//
// The root of it is that `!shape.managed` conflates two populations with OPPOSITE remedies:
// an install that was DAMAGED (some entry points survive — `repair` is exactly right) and
// one that was never deployed here at all (`repair` has nothing to run from; the user needs
// `install`). install.mjs:2367 records the same conflation being fixed once already, for
// plugin-only installs — a third state was still missing.
//
// The first case below is deliberately a general invariant rather than a wording check:
// ANY remedy naming `node <path> repair` must name a path that exists. It therefore covers
// checks not written yet, and does not have to be edited when the prose changes.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';

const REPO = resolve(import.meta.dirname, '..');
const INSTALLER = join(REPO, 'install.mjs');
const homes = [];

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** Run `doctor --json` under a throwaway HOME and return its parsed report. */
function doctorIn(home) {
  let out;
  try {
    out = execFileSync(process.execPath, [INSTALLER, 'doctor', '--json'], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, HOME: home, CLAUDE_MEM_DIR: '', MEM_NO_AUTO_ADOPT: '1' },
    });
  } catch (e) {
    // doctor exits non-zero when it finds issues, and a HOME with no install certainly will.
    out = (e.stdout || '') + (e.stderr || '');
  }
  const start = out.indexOf('{');
  expect(start, `doctor emitted no JSON:\n${out.slice(0, 400)}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(out.slice(start));
}

function messages(report) {
  return (report.checks || []).flatMap((c) => [c.message, ...(c.details || [])]).filter(Boolean);
}

describe('doctor remedies name commands that can run', () => {
  it('never offers `node <path> repair` when that path does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-remedy-'));
    homes.push(home);

    const report = doctorIn(home);
    const lines = messages(report);
    // Guard the guard: a report with no checks would satisfy every assertion below.
    expect(lines.length).toBeGreaterThan(5);

    const unrunnable = [];
    for (const line of lines) {
      // Either spelling: shellWord prints a plain path bare and any other one single-quoted (D#61).
      for (const m of line.matchAll(/node (?:'([^']+?\.mjs)'|"?(\S+?\.mjs)"?) repair/g)) {
        const p = m[1] ?? m[2];
        if (!existsSync(p)) unrunnable.push(`${p}  ← from: ${line.slice(0, 120)}`);
      }
    }
    expect(unrunnable, `doctor prescribed a repair binary that is absent:\n${unrunnable.join('\n')}`).toEqual(
      [],
    );
  });

  it('tells a never-deployed HOME to install, and says nothing is deployed', () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-remedy-'));
    homes.push(home);
    // The data dir exists (anything that opens the DB creates it) while no code was ever
    // deployed into it — the shape a `git clone` user who has not run install yet is in, and
    // the one where BOTH drift checks fire.
    mkdirSync(join(home, '.claude-mem-lite'), { recursive: true });
    writeFileSync(join(home, '.claude-mem-lite', 'claude-mem-lite.db'), '');

    const lines = messages(doctorIn(home)).join('\n');

    expect(lines).toMatch(/install\.mjs"? install/);
    expect(lines).toMatch(/no (claude-mem-lite )?(code|install)/i);
  });

  it('still prescribes repair when the install is DAMAGED rather than absent', () => {
    // The population `repair` exists for: code WAS deployed, cli.mjs survives so the binary
    // can run, and it re-syncs the rest. Over-narrowing the fix above would take this away.
    //
    // The shape has to be SOME-but-not-all of install-shape's MANAGED_ENTRY_POINTS
    // (`server.mjs`, `hook.mjs`) — a first draft wrote all five of doctor-drift's wider entry
    // list, which made `hasManagedCodeInstall` true, `noCodeInstall` false in both arms, and
    // the case structurally unable to see the discriminator: dropping `hasAnyManagedCode`
    // from the gate left it green. Two different entry lists, and only one of them decides
    // `shape.managed`.
    const home = mkdtempSync(join(tmpdir(), 'doctor-remedy-'));
    homes.push(home);
    const dir = join(home, '.claude-mem-lite');
    mkdirSync(dir, { recursive: true });
    for (const f of ['cli.mjs', 'server.mjs', 'mem-cli.mjs']) {
      writeFileSync(join(dir, f), '// stub\n');
    }
    // hook.mjs deliberately absent: deployed, then damaged.
    expect(existsSync(join(dir, 'hook.mjs'))).toBe(false);

    const lines = messages(doctorIn(home)).join('\n');

    expect(lines).toMatch(/repair/);
    expect(lines).not.toMatch(/no claude-mem-lite code is deployed/);
  });

  it('does not call an install "never deployed" while forty of its files are present', async () => {
    // The case above keeps `server.mjs`, so it exercises the discriminator from the side
    // where it works. The neighbouring population is the one it cannot reach: BOTH entry
    // points gone and everything else still there. `hasAnyManagedCode` asked only about
    // MANAGED_ENTRY_POINTS — two files — while the message it gates claims "none present"
    // about the whole managed list, and withdraws `repair`, which is runnable here because
    // cli.mjs is sitting right there.
    //
    // Single-shape fixtures are structurally blind to the shape next door; that is what the
    // pre-ship review used to find this.
    const { SOURCE_FILES } = await import('../source-files.mjs');
    const home = mkdtempSync(join(tmpdir(), 'doctor-remedy-'));
    homes.push(home);
    const dir = join(home, '.claude-mem-lite');
    const present = SOURCE_FILES.filter((f) => f !== 'server.mjs' && f !== 'hook.mjs');
    for (const f of present) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), '// stub\n');
    }
    // Premise: the fixture really is the shape under test — lots present, both entries gone.
    expect(present.length).toBeGreaterThan(40);
    expect(existsSync(join(dir, 'cli.mjs'))).toBe(true);
    expect(existsSync(join(dir, 'server.mjs'))).toBe(false);
    expect(existsSync(join(dir, 'hook.mjs'))).toBe(false);

    const lines = messages(doctorIn(home)).join('\n');

    expect(lines, `doctor called this a data-only directory:\n${lines}`).not.toMatch(
      /no claude-mem-lite code is deployed/,
    );
    expect(lines).toMatch(/repair/);
  });
});
