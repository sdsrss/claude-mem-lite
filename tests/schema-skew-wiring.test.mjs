// WIRING, not units. tests/schema-skew.test.mjs proves lib/schema-skew.mjs behaves; this
// file proves anything CALLS it.
//
// The distinction is not academic here. The v6.2.0 round produced a doctor check whose unit
// tests all passed while nothing proved the shipped doctor reached the code — flipping the
// fixed arm back to a green `ok` killed none of them, and only a post-repair mutation probe
// found it. So each case below drives a REAL entry point in a subprocess (hook.mjs
// session-start, cli.mjs doctor, scripts/user-prompt-search.js) against a real database, and
// asserts on what the user would actually see.
//
// This file earned that discipline twice over: its own first version had a VACUOUS assertion
// (a repair-command regex satisfied by an unrelated doctor line) and a control that graded
// against the developer machine's real plugin cache instead of a sandboxed HOME.
//
// The fixture is a DB carrying schema_version = 999 and nothing else. initSchema reads that
// row before it touches anything, so it is a complete reproduction of the forward-incompat
// state without needing a future build to create one.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
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

  it('puts the notice on the HUMAN channel, not only the model one', () => {
    // queueHookContext reaches the model; systemMessage is what Claude Code renders to the
    // user. The first cut used only the former — which is verbatim what lib/hook-stdout.mjs
    // documents v3.70.0 for ("kept its content and lost its audience"), on a notice whose
    // entire job is handing the user a command to run.
    const dataDir = skewedDataDir();
    const r = run([join(REPO, 'hook.mjs'), 'session-start'], dataDir);
    const envelope = JSON.parse(
      r.stdout
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .pop(),
    );
    expect(envelope.systemMessage, 'the user-visible channel must carry it').toMatch(/Memory is OFF/);
    // Additive, not a move: the model still learns memory is unavailable.
    expect(envelope.hookSpecificOutput?.additionalContext).toMatch(/Memory is OFF/);
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

describe('openDb keeps its contract: returns null, never throws', () => {
  it('survives a runtime dir that cannot be written', () => {
    // The first cut of the dedup called getSessionId() from inside openDb's catch. That is
    // not a read — it MINTS and writes a session id — so an unwritable runtime dir made the
    // catch block itself throw, and openDb() threw where every one of its 13 call sites
    // expects null. Reproduced as ENOTDIR against a `main` arm returning null. Real triggers:
    // EROFS, ENOSPC, EACCES, a relocated CLAUDE_MEM_DIR on a dismounted volume.
    const dataDir = skewedDataDir();
    const blocker = join(dataDir, 'blocked');
    writeFileSync(blocker, 'a regular file where a directory must go');

    const src = `
      process.env.CLAUDE_MEM_RUNTIME_DIR = ${JSON.stringify(join(blocker, 'runtime'))};
      process.env.CLAUDE_MEM_DIR = ${JSON.stringify(dataDir)};
      const { openDb } = await import(${JSON.stringify(join(REPO, 'hook-shared.mjs'))});
      try { console.log('OUT:' + (openDb() === null ? 'null' : 'db')); }
      catch (e) { console.log('OUT:threw ' + (e.code || e.message)); }
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, CLAUDE_MEM_SKIP_UPDATE: '1', MEM_NO_AUTO_ADOPT: '1' },
    });
    expect(`${r.stdout}`).toContain('OUT:null');
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

  it('still records once per project when two projects share one data dir', () => {
    // The first cut used ONE marker file for the whole data dir, keyed on a session id that
    // is per PROJECT — so two projects overwrote each other's key and every fire recorded
    // again. Review measured it: 8 fires across 2 projects gave 8 records where the same 8
    // fires in one project gave 1. That is the 648/day flood, unfixed for exactly the
    // multi-project machine that produced it.
    const dataDir = skewedDataDir();
    const projA = mkdtempSync(join(tmpdir(), 'skew-projA-'));
    const projB = mkdtempSync(join(tmpdir(), 'skew-projB-'));
    fixtures.push(projA, projB);

    for (let i = 0; i < 8; i++) {
      run([join(REPO, 'hook.mjs'), 'user-prompt'], dataDir, {
        stdin: JSON.stringify({ prompt: 'hello', session_id: 'cc-fixed' }),
        CLAUDE_PROJECT_DIR: i % 2 === 0 ? projA : projB,
      });
    }

    const skewLines = hookErrorLines(dataDir).filter((e) => /DB schema is v999/.test(e.msg));
    expect(skewLines.length).toBeGreaterThan(0); // premise
    // One per project, not one per fire.
    expect(skewLines.length).toBe(2);
  });

  it('deduplicates the ups face too, which opens the DB itself', () => {
    // scripts/user-prompt-search.js does not go through hook-shared's openDb — it calls
    // ensureDb() directly and logs its own `ups:db-open`. It contributed 15 of one measured
    // day's 727 lines, so leaving it out closed ~98% of the flood and called it closed.
    const dataDir = skewedDataDir();
    for (let i = 0; i < 4; i++) {
      run([join(REPO, 'scripts', 'user-prompt-search.js')], dataDir, {
        stdin: JSON.stringify({ prompt: 'how do I fix the retrieval bug', session_id: 'cc-ups' }),
      });
    }
    const ups = hookErrorLines(dataDir).filter((e) => e.scope === 'ups:db-open');
    expect(ups.length).toBeGreaterThan(0); // premise: the ups path really opened the DB
    expect(ups.length).toBe(1);
  });
});

describe('doctor reports which code home cannot open the DB', () => {
  it('fails, names the version pair, and prints a repair command', () => {
    const dataDir = skewedDataDir();
    const r = run([join(REPO, 'cli.mjs'), 'doctor'], dataDir);
    const out = `${r.stdout}${r.stderr}`;

    expect(out).toMatch(/DB schema v999 is newer than/);
    expect(out).toMatch(/supports up to v\d+/);

    // POSITIONAL, deliberately. The first version of this assertion was
    // `expect(out).toMatch(/\/plugin update|self-update|git pull/)` and was VACUOUS: under
    // this fixture's sandboxed HOME the remedy resolves to kind 'unknown', which emits no
    // command at all, and an unrelated `⚠ Hook scripts: … Fix: claude-mem-lite self-update`
    // line elsewhere in doctor satisfied the regex. Review proved it by deleting both remedy
    // `log()` calls from install.mjs — all five cases stayed green. Anchoring to the line
    // that FOLLOWS the skew failure is what makes it load-bearing.
    const lines = out.split('\n');
    const idx = lines.findIndex((l) => /DB schema v999 is newer than/.test(l));
    expect(idx).toBeGreaterThanOrEqual(0);
    const following = lines
      .slice(idx + 1)
      .map((l) => l.trim())
      .filter(Boolean);
    expect(following[0]).toMatch(
      /\/plugin marketplace update|self-update|git pull|Could not identify this install/,
    );
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
