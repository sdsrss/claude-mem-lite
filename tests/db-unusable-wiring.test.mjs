// WIRING, not units. tests/db-unusable.test.mjs proves lib/db-unusable.mjs behaves; this
// file proves anything CALLS it.
//
// Same shape, and the same reason, as tests/schema-skew-wiring.test.mjs: a corrupt database
// takes the identical path a version-skewed one takes — `openDb()` returns null and
// `hook.mjs`'s `const db = openDb(); if (!db) return;` ends SessionStart in silence. Measured
// 2026-09-08 in a sandboxed HOME: 20 hook fires produced 10 identical ~1.5 KB stack traces in
// runtime/hook-errors/ and ZERO user-visible output, while the CLI, `status` and `doctor` all
// reported the failure correctly with an exact repair command. So the user whose memory has
// stopped working learns nothing until they happen to run doctor.
//
// The fixture is a file that is not a SQLite database at all — the shape a truncated write, a
// half-synced backup or a filesystem fault produces, and the one SQLite answers with
// "file is not a database".

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
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

/** A data dir whose database file is not a database. */
function corruptDataDir({ withSnapshot = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dbbad-'));
  fixtures.push(dir);
  const dbPath = join(dir, 'claude-mem-lite.db');
  if (withSnapshot) {
    // A real snapshot beside it, so the remedy is "restore" rather than "set aside".
    const db = new Database(`${dbPath}.v1.bak`);
    db.exec('CREATE TABLE t (a)');
    db.close();
  }
  writeFileSync(dbPath, 'GARBAGE not a sqlite file at all');
  return dir;
}

/** HOME is sandboxed for every case — see the note in tests/schema-skew-wiring.test.mjs. */
function run(args, dataDir, { stdin = '{}', ...extraEnv } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dbbad-home-'));
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

describe('SessionStart speaks when the database cannot be opened at all', () => {
  it('emits an actionable notice instead of exiting silently', () => {
    const dataDir = corruptDataDir();
    const r = run([join(REPO, 'hook.mjs'), 'session-start'], dataDir);

    // Premise first: without it a passing test could mean the DB opened fine.
    expect(hookErrorLines(dataDir).some((e) => /not a database/i.test(e.msg))).toBe(true);

    expect(r.stdout).toMatch(/Memory is OFF/);
    expect(r.stdout, 'must name the file the user has to act on').toContain('claude-mem-lite.db');
    // A hook must never take the host session down with it.
    expect(r.status).toBe(0);
  });

  it('puts the notice on the HUMAN channel, not only the model one', () => {
    const dataDir = corruptDataDir();
    const r = run([join(REPO, 'hook.mjs'), 'session-start'], dataDir);
    const envelope = JSON.parse(
      r.stdout
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .pop(),
    );
    expect(envelope.systemMessage, 'the user-visible channel must carry it').toMatch(/Memory is OFF/);
    expect(envelope.hookSpecificOutput?.additionalContext).toMatch(/Memory is OFF/);
  });

  // …but the two channels do NOT carry the same string here, unlike the schema-skew twin.
  // That remedy is `git pull` / `plugin update`; this one is
  // `rm -f …-wal …-shm && cp "<snapshot>" "<db>"`, which OVERWRITES the database. Handing a
  // ready-to-run irreversible command to an agent holding Bash is not the same act as
  // printing it for a human, and the restore arm defeats its own "keep the broken file for
  // inspection" advice if acted on.
  it('keeps the destructive repair command OUT of the model channel', () => {
    const dataDir = corruptDataDir({ withSnapshot: true });
    const r = run([join(REPO, 'hook.mjs'), 'session-start'], dataDir);
    const envelope = JSON.parse(
      r.stdout
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .pop(),
    );
    const model = envelope.hookSpecificOutput.additionalContext;
    expect(model, 'no shell command reaches the model').not.toMatch(/rm -f|\bcp\b|\bmv\b/);
    expect(model, 'it still learns memory is off').toMatch(/Memory is OFF/);
    expect(model).toMatch(/claude-mem-lite doctor/);
    // The premise: the human channel really does carry the command the model must not get.
    expect(envelope.systemMessage).toMatch(/rm -f/);
    expect(envelope.systemMessage).toContain('.v1.bak');
  });

  it('offers the RESTORE remedy when a snapshot exists, not the set-aside one', () => {
    // The two remedies are not interchangeable: telling a user to move the file aside when a
    // backup is sitting next to it throws away recoverable memories.
    const dataDir = corruptDataDir({ withSnapshot: true });
    const r = run([join(REPO, 'hook.mjs'), 'session-start'], dataDir);
    expect(r.stdout).toMatch(/backup snapshot/i);
    expect(r.stdout).toContain('.v1.bak');
    expect(r.stdout).not.toMatch(/No backup snapshot exists/);
  });

  it('says nothing on a healthy database', () => {
    // The control. Without it the assertions above pass on a build that prints the notice
    // unconditionally.
    const dir = mkdtempSync(join(tmpdir(), 'dbok-'));
    fixtures.push(dir);
    const r = run([join(REPO, 'hook.mjs'), 'session-start'], dir);
    expect(r.stdout).not.toMatch(/Memory is OFF/);
    expect(r.status).toBe(0);
  });
});

describe('an unopenable database is logged once, not once per hook fire', () => {
  it('records one line across repeated SessionStart fires in one project', () => {
    // Measured before the fix: 10 fires → 10 records, each a ~1.5 KB stack trace, forever,
    // because the condition never heals on its own. Same flood shape the schema-skew round
    // measured at >=648 lines in one day.
    const dataDir = corruptDataDir();
    for (let i = 0; i < 4; i++) run([join(REPO, 'hook.mjs'), 'session-start'], dataDir);
    const lines = hookErrorLines(dataDir).filter((e) => /not a database/i.test(e.msg));
    expect(lines.length).toBe(1);
  });

  it('still records for a SECOND project on the same shared database', () => {
    // The marker is per project for the reason the skew round paid a review round to learn:
    // one shared marker keyed on a per-project value let two projects silence each other.
    const dataDir = corruptDataDir();
    run([join(REPO, 'hook.mjs'), 'session-start'], dataDir, { CLAUDE_PROJECT_DIR: join(REPO, '..') });
    const first = hookErrorLines(dataDir).filter((e) => /not a database/i.test(e.msg)).length;
    run([join(REPO, 'hook.mjs'), 'session-start'], dataDir, { CLAUDE_PROJECT_DIR: tmpdir() });
    const second = hookErrorLines(dataDir).filter((e) => /not a database/i.test(e.msg)).length;
    expect(first).toBe(1);
    expect(second).toBe(2);
  });
});
