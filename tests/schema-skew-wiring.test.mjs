// WIRING, not units. tests/schema-skew.test.mjs proves lib/schema-skew.mjs behaves; this
// file proves anything CALLS it.
//
// The distinction is not academic here. v6.2.0 shipped a doctor check whose unit tests all
// passed while the shipped doctor never reached the code — flipping the fixed arm back to a
// green `ok` killed nothing. So each case below drives a REAL entry point in a subprocess
// (hook.mjs session-start, cli.mjs doctor) against a real database, and asserts on what the
// user would actually see.
//
// The fixture is a DB carrying schema_version = 999 and nothing else. initSchema reads that
// row before it touches anything, so it is a complete reproduction of the forward-incompat
// state without needing a future build to create one.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';

const REPO = resolve(import.meta.dirname, '..');
const fixtures = [];

afterEach(() => {
  for (const d of fixtures.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

/** A data dir whose DB claims a schema version far beyond anything this build supports. */
function skewedDataDir(version = 999) {
  const dir = mkdtempSync(join(tmpdir(), 'skew-wire-'));
  fixtures.push(dir);
  const db = new Database(join(dir, 'claude-mem-lite.db'));
  db.exec('CREATE TABLE schema_version (version INTEGER)');
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  db.close();
  return dir;
}

/**
 * HOME is sandboxed for every case. Without it these assertions are graded against whatever
 * plugin cache the developer's machine happens to hold — which is not hypothetical: the
 * first run of this file failed its own control because the real cache here (v5.6.0,
 * supporting v48) genuinely cannot open the repo's v49 database, so doctor was right and the
 * test was wrong. A machine-dependent control is not a control.
 */
function run(args, dataDir, { stdin = '{}', ...extraEnv } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'skew-home-'));
  fixtures.push(home);
  return spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
    input: stdin,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_MEM_DIR: dataDir,
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_COMPRESS: '1',
      CLAUDE_MEM_SKIP_OPTIMIZE: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
      MEM_NO_AUTO_ADOPT: '1',
      ANTHROPIC_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      CLAUDE_MEM_HOOK_RUNNING: undefined,
      ...extraEnv,
    },
  });
}

function hookErrorLines(dataDir) {
  const dir = join(dataDir, 'runtime', 'hook-errors');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe('SessionStart speaks instead of returning silently', () => {
  it('emits an actionable notice naming both versions', () => {
    const dataDir = skewedDataDir();
    const r = run([join(REPO, 'hook.mjs'), 'session-start'], dataDir);

    // The premise, asserted first: without it a passing test could mean the DB opened fine.
    const errs = hookErrorLines(dataDir);
    expect(errs.some((e) => /DB schema is v999/.test(e.msg))).toBe(true);

    expect(r.stdout).toContain('999');
    expect(r.stdout).toMatch(/Memory is OFF|newer version/i);
    // A hook must never take the host session down with it.
    expect(r.status).toBe(0);
  });

  it('says nothing about skew on a healthy database', () => {
    // The control. Without it the assertion above passes on any build that prints the
    // notice unconditionally.
    const dir = mkdtempSync(join(tmpdir(), 'skew-ok-'));
    fixtures.push(dir);
    const r = run([join(REPO, 'hook.mjs'), 'session-start'], dir);
    expect(r.stdout).not.toMatch(/Memory is OFF/);
    expect(r.status).toBe(0);
  });
});

describe('the hook-error log stops repeating one persistent fault', () => {
  it('records the skew once across repeated hook fires in one session', () => {
    const dataDir = skewedDataDir();
    // Four separate processes, as production has: every hook event is its own node run,
    // which is why a per-process guard would not have stopped the 648/day flood. The four
    // share one session because getSessionId() persists the id under the data dir — which
    // is exactly the scope the dedup key claims.
    for (let i = 0; i < 4; i++) {
      run([join(REPO, 'hook.mjs'), 'user-prompt'], dataDir, {
        stdin: JSON.stringify({ prompt: 'hello', session_id: 'cc-fixed' }),
      });
    }

    const skewLines = hookErrorLines(dataDir).filter((e) => /DB schema is v999/.test(e.msg));
    expect(skewLines.length).toBeGreaterThan(0); // premise: the fault really fired
    expect(skewLines.length).toBe(1);
  });
});

describe('doctor reports which code home cannot open the DB', () => {
  it('fails, names the version pair, and prints a repair command', () => {
    const dataDir = skewedDataDir();
    const r = run([join(REPO, 'cli.mjs'), 'doctor'], dataDir);
    const out = `${r.stdout}${r.stderr}`;

    expect(out).toMatch(/DB schema v999 is newer than/);
    expect(out).toMatch(/supports up to v\d+/);
    // A diagnosis with no next step is half a diagnosis.
    expect(out).toMatch(/\/plugin update|self-update|git pull/);
    expect(r.status).not.toBe(0);
  });

  it('reports a readable database as readable, with the version it read', () => {
    // The control that keeps the check from being a permanent red, and proves the ok arm
    // is reached rather than skipped.
    const dir = mkdtempSync(join(tmpdir(), 'skew-doctorok-'));
    fixtures.push(dir);
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    // Let the real schema create itself at the current version.
    run([join(REPO, 'cli.mjs'), 'stats'], dir);
    const r = run([join(REPO, 'cli.mjs'), 'doctor'], dir);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toMatch(/DB schema: v\d+ — readable by all/);
    expect(out).not.toMatch(/is newer than/);
  });
});
