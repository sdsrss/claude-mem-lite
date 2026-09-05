// Audit 2026-08-22 P2-5: `CLAUDE_MEM_RECOMMEND_MODE=live` was accepted by the parser
// and implemented nowhere — Phase 2 (live injection) was never built. A user who set it
// got shadow mode, silently, and every doctor check stayed green because the install was
// in fact perfectly healthy. Nothing in the product could tell them their flag was inert.
//
// This runs the REAL `doctor --json` as a subprocess, because the failure being guarded
// is a wiring failure: the module-level unit test proves the mode resolves, and proves
// nothing about whether any user-visible surface says so.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const INSTALLER = resolve(import.meta.dirname, '../install.mjs');
const homes = [];

function doctorWith(env) {
  const home = mkdtempSync(join(tmpdir(), 'doctor-flags-'));
  homes.push(home);
  let out;
  try {
    out = execFileSync(process.execPath, [INSTALLER, 'doctor', '--json'], {
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: join(home, 'data'),
        CLAUDE_MEM_SKIP_UPDATE: '1',
        MEM_QUIET_HOOKS: '1',
        ...env,
      },
      encoding: 'utf8',
    });
  } catch (e) {
    // doctor exits non-zero whenever it finds ✗-level issues — expected here, since
    // the fake HOME holds no install at all. Its report is still on stdout.
    out = e.stdout || '';
  }
  const start = out.indexOf('{');
  expect(start, `doctor emitted no JSON:\n${out.slice(0, 400)}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(out.slice(start));
}

const flagLines = (report) => (report.checks || []).filter((c) => /RECOMMEND_MODE/.test(c.message || ''));

describe('doctor — parked env flags', () => {
  afterEach(() => {
    for (const h of homes.splice(0)) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        /* gone */
      }
    }
  });

  it('names CLAUDE_MEM_RECOMMEND_MODE=live as accepted-but-not-implemented', () => {
    const report = doctorWith({ CLAUDE_MEM_RECOMMEND_MODE: 'live' });
    const lines = flagLines(report);
    expect(
      lines.length,
      `doctor said nothing about an inert flag:\n${JSON.stringify(report.checks, null, 1)}`,
    ).toBe(1);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].message).toMatch(/not implemented/i);
    expect(lines[0].message).toMatch(/shadow/);
  });

  it('says nothing when the flag is unset or set to a mode that works', () => {
    // A check that fires on a healthy configuration is noise, and noise is how the
    // real findings in this report stop being read.
    expect(flagLines(doctorWith({ CLAUDE_MEM_RECOMMEND_MODE: '' }))).toEqual([]);
    expect(flagLines(doctorWith({ CLAUDE_MEM_RECOMMEND_MODE: 'shadow' }))).toEqual([]);
    expect(flagLines(doctorWith({ CLAUDE_MEM_RECOMMEND_MODE: 'off' }))).toEqual([]);
  });

  it('is a warning, not a counted issue — the install is healthy, the config is not', () => {
    const withFlag = doctorWith({ CLAUDE_MEM_RECOMMEND_MODE: 'live' });
    const without = doctorWith({ CLAUDE_MEM_RECOMMEND_MODE: 'shadow' });
    expect(withFlag.issues).toBe(without.issues);
    expect(withFlag.warnings).toBe(without.warnings + 1);
  });
});
