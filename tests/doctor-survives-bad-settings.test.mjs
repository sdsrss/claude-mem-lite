// A settings.json the user is midway through hand-editing must not silence doctor.
//
// Audit 2026-09-08 (P1-2). `readSettings()` throws on a file that exists and does not
// parse — correct for install / uninstall, whose every write path merges into its return
// value (R10 P1-8), and inherited by doctor, which never writes it. One trailing comma
// therefore aborted the run at the Plugin-lifecycle check: nine later checks never ran and
// `--json` emitted zero bytes. That is the state a user is in when they run doctor.
//
// Three cases, and the third is load-bearing: the obvious way to "fix" this is to soften
// readSettings() itself, which would silently restore the wholesale-overwrite bug R10 P1-8
// was filed for. The install/uninstall refusal is pinned here so that repair cannot pass.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const INSTALL_PATH = resolve(import.meta.dirname, '../install.mjs');
let home;

const BAD_SETTINGS = '{\n  "model": "opus",\n}\n'; // trailing comma
const GOOD_SETTINGS = '{}\n';

function writeSettings(body) {
  const dir = join(home, '.claude');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'settings.json');
  writeFileSync(p, body);
  return p;
}

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [INSTALL_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, MEM_NO_AUTO_ADOPT: '1', CLAUDE_MEM_DIR: join(home, 'data') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', code: e.status };
  }
}

describe('doctor survives an unparseable settings.json', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'doctor-badsettings-'));
  });
  afterEach(() => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  });

  it('emits valid JSON and keeps the checks that do not read settings.json', () => {
    // Premise first: how many checks does this same fixture produce when settings parse?
    writeSettings(GOOD_SETTINGS);
    const baseline = JSON.parse(run(['doctor', '--json']).stdout);
    expect(baseline.checks.length, 'premise: the good-settings run must produce checks').toBeGreaterThan(10);

    writeSettings(BAD_SETTINGS);
    const out = run(['doctor', '--json']).stdout;
    expect(out.length, 'doctor emitted zero bytes — it aborted before the reporter ran').toBeGreaterThan(0);
    const bad = JSON.parse(out); // FAILS IF: the throw is inherited again
    // Four checks read settings.json and degrade to "not checked"; nothing else may vanish.
    expect(bad.checks.length).toBeGreaterThanOrEqual(baseline.checks.length - 4);
    // It must SAY the file is broken, at fail level...
    expect(bad.checks.some((c) => c.level === 'fail' && /settings\.json/.test(c.message))).toBe(true);
    // ...and the checks that never needed settings.json must still be there. Naming them
    // rather than counting: a count passes if four unrelated checks were substituted.
    const messages = bad.checks.map((c) => c.message).join('\n');
    expect(messages).toMatch(/Node\.js/);
    expect(messages).toMatch(/Hook interpreter|Stale temp|Entry points/);
    // And "I could not look" must not be reported as "there is nothing configured".
    expect(messages).not.toMatch(/Plugin lifecycle: hooks not configured/);
  });

  it('install and uninstall still refuse, leaving the file byte-identical', () => {
    const p = writeSettings(BAD_SETTINGS);
    for (const cmd of ['install', 'uninstall']) {
      const before = readFileSync(p, 'utf8');
      const { code, stdout, stderr } = run([cmd]);
      expect(code, `${cmd} must not exit 0 on an unparseable settings.json`).not.toBe(0);
      expect(`${stdout}${stderr}`).toMatch(/not valid JSON/);
      expect(readFileSync(p, 'utf8'), `${cmd} rewrote the file it could not parse`).toBe(before);
    }
  });
});
