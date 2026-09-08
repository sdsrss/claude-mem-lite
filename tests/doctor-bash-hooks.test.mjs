// Three of the hook commands are `bash "<script>"`, and nothing told the user when bash
// was missing — the hooks simply did not fire.
//
// This is the other half of issue #28. package.json's `os` list blocked Windows outright,
// and the commit that added it (b6a2579, R10 P3-19) said why: "a Windows user should be
// told rather than handed a string of silent catch blocks". Unblocking the install without
// building the telling channel would just move the silence — a Windows user with no Git
// Bash would get a working MCP server and three dead hooks, with nothing anywhere saying so.
//
// The check is keyed on the REAL condition (can bash run?) rather than on the proxy
// (process.platform === 'win32'), which matters in both directions: a Windows user WITH Git
// Bash on PATH — the normal case, since Claude Code shells out to bash for its own Bash tool
// — is told nothing, correctly; and a stripped Linux container with no bash IS told, which a
// platform check would have missed. It is also why this suite can drive it on Linux at all:
// emptying PATH is a real reproduction of the condition, where faking process.platform in a
// spawned process would only be a reproduction of the proxy.
//
// dwarn, not fail: a diagnostic that exits 1 on a configuration the user chose is one they
// stop running. Pinned by the issue-count case below.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO = resolve(import.meta.dirname, '..');
const INSTALLER = join(REPO, 'install.mjs');
const homes = [];

afterEach(() => {
  for (const h of homes.splice(0)) {
    try {
      rmSync(h, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

/** Run `doctor --json` under a throwaway HOME. `path` replaces PATH when given. */
function doctorWith({ path } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'doctor-bash-'));
  homes.push(home);
  mkdirSync(join(home, '.claude-mem-lite'), { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_MEM_DIR: join(home, 'data'),
    CLAUDE_MEM_SKIP_UPDATE: '1',
    MEM_QUIET_HOOKS: '1',
    MEM_NO_AUTO_ADOPT: '1',
  };
  if (path !== undefined) env.PATH = path;
  let out;
  try {
    out = execFileSync(process.execPath, [INSTALLER, 'doctor', '--json'], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
  } catch (e) {
    // doctor exits non-zero when it finds issues, which a fixture HOME with no install in
    // it always does. Its report is on stdout either way.
    out = e.stdout || '';
  }
  const start = out.indexOf('{');
  expect(start, `doctor emitted no JSON:\n${out.slice(0, 400)}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(out.slice(start));
}

const bashLines = (report) => (report.checks || []).filter((c) => /Hook interpreter/.test(c.message || ''));

describe('doctor: bash-invoking hooks (issue #28)', () => {
  it('says nothing is wrong when bash is on PATH', () => {
    const lines = bashLines(doctorWith());
    // Reported either way — a check that only speaks up on failure gives the reader no way
    // to tell "looked and it is fine" from "never looked".
    expect(lines.length, 'doctor never checked the hook interpreter').toBeGreaterThan(0);
    expect(lines.every((c) => c.level === 'ok')).toBe(true);
  });

  it('warns, naming the Windows remedy, when bash cannot be run', () => {
    // An empty directory as the whole PATH: `bash` is unresolvable, exactly as on a Windows
    // box without Git for Windows. node itself is unaffected — execFileSync spawns it by
    // absolute path.
    const empty = mkdtempSync(join(tmpdir(), 'doctor-bash-nopath-'));
    homes.push(empty);
    const report = doctorWith({ path: empty });
    const lines = bashLines(report);
    expect(
      lines.length,
      `doctor said nothing about a missing bash:\n${JSON.stringify(report.checks, null, 1)}`,
    ).toBeGreaterThan(0);
    expect(lines.every((c) => c.level === 'warn')).toBe(true);
    const text = lines.map((c) => c.message).join(' ');
    // The remedy, not just the fact. Git Bash is what Claude Code on Windows already needs.
    expect(text).toMatch(/Git for Windows|Git Bash|WSL/);
    // The bound, so the reader does not conclude the whole plugin is dead: the MCP server
    // and the node hooks do not go through bash.
    expect(text).toMatch(/MCP server/);
  });

  it('is advisory — a missing bash must not push doctor to exit 1', () => {
    const empty = mkdtempSync(join(tmpdir(), 'doctor-bash-nopath2-'));
    homes.push(empty);
    const withBash = doctorWith();
    const withoutBash = doctorWith({ path: empty });
    expect(
      withoutBash.issues,
      `the notice added ${withoutBash.issues - withBash.issues} issue(s) — it must be advisory`,
    ).toBe(withBash.issues);
  });

  it('TRIPWIRE: the hook manifest still invokes bash, which is why this check exists', () => {
    // If every hook command becomes `node`, this check is measuring a dependency the
    // product no longer has — delete it rather than leaving it to pass vacuously.
    const manifest = JSON.parse(readFileSync(join(REPO, 'hooks', 'hooks.json'), 'utf8'));
    const commands = Object.values(manifest.hooks || {})
      .flat()
      .flatMap((m) => m?.hooks || [])
      .map((h) => String(h?.command || ''));
    expect(commands.length, 'no hook commands found — the manifest shape changed').toBeGreaterThan(0);
    expect(commands.filter((c) => c.startsWith('bash ')).length).toBeGreaterThan(0);
  });
});
