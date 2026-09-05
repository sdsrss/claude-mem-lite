// Activity namespace data-layer tests (T7 v2.31).
// Verifies saveEvent/getEvent/searchEvents/recentEvents over the events table
// (added in T6). Activity events are intentionally separate from observations
// so they don't pollute the L1 system-prompt memory section.

import { describe, test, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { createTestDb } from './test-helpers.mjs';
import { initSchema } from '../schema.mjs';
import { saveEvent, searchEvents, recentEvents, getEvent, EVENT_TYPES } from '../lib/activity.mjs';

describe('activity store', () => {
  test('saveEvent returns id and persists', () => {
    const db = createTestDb();
    const id = saveEvent(db, {
      project: 'mem',
      event_type: 'bugfix',
      title: 'fix x',
      body: 'root cause y',
      importance: 2,
    });
    expect(id).toBeGreaterThan(0);
    const row = getEvent(db, id);
    expect(row.title).toBe('fix x');
  });

  test('saveEvent scrubs secrets in title and body (HIGH-2: events at-rest leak)', () => {
    const db = createTestDb();
    const id = saveEvent(db, {
      project: 'mem',
      event_type: 'bug',
      title: 'repro: export GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      body: 'connect with postgres://user:hunter2pw@db.internal:5432/app and api_key=sk-abcdefghij1234567890',
      importance: 2,
    });
    const row = getEvent(db, id);
    expect(row.title).not.toMatch(/ghp_abcdefghij/);
    expect(row.title).toContain('***');
    expect(row.body).not.toMatch(/hunter2pw/);
    expect(row.body).not.toMatch(/sk-abcdefghij/);
    expect(row.body).toContain('***');
  });

  test('searchEvents uses FTS and filters by type', () => {
    const db = createTestDb();
    saveEvent(db, { project: 'mem', event_type: 'bugfix', title: 'auth null deref', importance: 2 });
    saveEvent(db, { project: 'mem', event_type: 'lesson', title: 'auth caching trap', importance: 2 });
    const hits = searchEvents(db, 'auth', { project: 'mem', type: 'bugfix' });
    expect(hits).toHaveLength(1);
    expect(hits[0].event_type).toBe('bugfix');
  });

  test('recentEvents sorts DESC by created', () => {
    const db = createTestDb();
    const t0 = Date.now();
    saveEvent(db, {
      project: 'mem',
      event_type: 'observation',
      title: 'old',
      importance: 1,
      created_at_epoch: t0 - 1000,
    });
    saveEvent(db, {
      project: 'mem',
      event_type: 'observation',
      title: 'new',
      importance: 1,
      created_at_epoch: t0,
    });
    const hits = recentEvents(db, { project: 'mem', limit: 2 });
    expect(hits[0].title).toBe('new');
  });

  test('saveEvent stores file_paths as JSON array', () => {
    const db = createTestDb();
    const id = saveEvent(db, {
      project: 'mem',
      event_type: 'lesson',
      title: 't',
      file_paths: ['src/foo.mjs', 'src/bar.mjs'],
      importance: 1,
    });
    const row = getEvent(db, id);
    expect(JSON.parse(row.file_paths)).toEqual(['src/foo.mjs', 'src/bar.mjs']);
  });

  test('getEvent increments accessed_count', () => {
    const db = createTestDb();
    const id = saveEvent(db, { project: 'mem', event_type: 'bug', title: 't', importance: 1 });
    getEvent(db, id);
    getEvent(db, id);
    const row = db.prepare(`SELECT accessed_count FROM events WHERE id=?`).get(id);
    expect(row.accessed_count).toBe(2);
  });

  test('searchEvents excludes superseded events', () => {
    const db = createTestDb();
    const id = saveEvent(db, { project: 'mem', event_type: 'lesson', title: 'old approach', importance: 2 });
    db.prepare(`UPDATE events SET superseded_at_epoch = ? WHERE id = ?`).run(Date.now(), id);
    const hits = searchEvents(db, 'old', { project: 'mem' });
    expect(hits).toHaveLength(0);
  });
});

describe('EVENT_TYPES export', () => {
  test('is a frozen 8-member list matching the CHECK constraint', () => {
    expect(Array.isArray(EVENT_TYPES)).toBe(true);
    expect(EVENT_TYPES).toHaveLength(8);
    expect(EVENT_TYPES).toEqual([
      'bugfix',
      'lesson',
      'bug',
      'discovery',
      'refactor',
      'feature',
      'observation',
      'decision',
    ]);
    // Frozen: mutation attempts throw in strict mode (ESM is strict-by-default).
    expect(() => EVENT_TYPES.push('xxx')).toThrow();
    expect(Object.isFrozen(EVENT_TYPES)).toBe(true);
  });
});

// ─── CLI subprocess tests for cmdActivity (T7 follow-ups) ────────────────────

describe('cmdActivity CLI: --type validation', () => {
  const CLI_PATH = resolve('cli.mjs');
  let tmpHome;
  let dataDir;
  let projectDir;

  function runCli(args) {
    const env = {
      ...process.env,
      CLAUDE_MEM_DIR: dataDir,
      CLAUDE_PROJECT_DIR: projectDir,
    };
    delete env.CLAUDE_MEM_HOOK_RUNNING;
    try {
      const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
        timeout: 10000,
        encoding: 'utf8',
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { stdout, stderr: '', exitCode: 0 };
    } catch (e) {
      return {
        stdout: e.stdout?.toString() || '',
        stderr: e.stderr?.toString() || '',
        exitCode: e.status ?? 1,
      };
    }
  }

  function setupDir() {
    tmpHome = join(tmpdir(), `mem-activity-cli-${randomUUID().slice(0, 8)}`);
    dataDir = join(tmpHome, '.claude-mem-lite');
    projectDir = join(tmpHome, 'parent', 'testproj');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, 'claude-mem-lite.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    db.close();
  }

  function teardownDir() {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  test('activity save --type bogus rejects with non-zero exit', () => {
    setupDir();
    try {
      const { stderr, exitCode } = runCli(['activity', 'save', '--type', 'bogus', 'should fail']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('invalid --type');
      expect(stderr).toContain('bogus');
    } finally {
      teardownDir();
    }
  });

  test('activity save --type lesson --files a,b stores array and round-trips via show', () => {
    setupDir();
    try {
      const save = runCli([
        'activity',
        'save',
        '--type',
        'lesson',
        'ci unit test title',
        '--files',
        'a.mjs,b.mjs',
        '--importance',
        '2',
      ]);
      expect(save.exitCode).toBe(0);
      const parsed = JSON.parse(save.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(typeof parsed.id).toBe('number');

      const show = runCli(['activity', 'show', String(parsed.id)]);
      expect(show.exitCode).toBe(0);
      const row = JSON.parse(show.stdout.trim());
      // file_paths column stores the JSON array as a string
      expect(JSON.parse(row.file_paths)).toEqual(['a.mjs', 'b.mjs']);
      expect(row.event_type).toBe('lesson');
      expect(row.importance).toBe(2);
    } finally {
      teardownDir();
    }
  });

  // Round3-P1/P2: activity --limit used bare parseInt — "2abc" coerced to 2, "-1"
  // became SQLite LIMIT -1 (unlimited full-table dump), huge values uncapped. Now
  // routed through parseIntFlag (default 20, max 1000). Behavioral assertion because
  // the runCli harness drops stderr on exit 0.
  test('activity recent --limit routes through parseIntFlag (garbage → default, not coerced)', () => {
    setupDir();
    try {
      for (let i = 0; i < 3; i++) runCli(['activity', 'save', '--type', 'discovery', `evt ${i}`]);
      const valid = runCli(['activity', 'recent', '--limit', '1']);
      expect(valid.stdout.match(/#\d+/g)?.length).toBe(1); // valid limit respected
      // pre-fix "2abc" coerced to 2 (→2 rows); post-fix garbage → default 20 → all 3 rows
      const garbage = runCli(['activity', 'recent', '--limit', '2abc']);
      expect(garbage.exitCode).toBe(0);
      expect(garbage.stdout.match(/#\d+/g)?.length).toBe(3);
    } finally {
      teardownDir();
    }
  });

  test('activity search --type bogus rejects before DB access', () => {
    setupDir();
    try {
      const { stderr, exitCode } = runCli(['activity', 'search', 'anything', '--type', 'nonsense']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('invalid --type');
    } finally {
      teardownDir();
    }
  });

  test('activity delete previews by default and refuses to delete without --confirm', () => {
    setupDir();
    try {
      const save = runCli(['activity', 'save', '--type', 'bugfix', 'about to be deleted']);
      const { id } = JSON.parse(save.stdout.trim());

      // preview path
      const preview = runCli(['activity', 'delete', String(id)]);
      expect(preview.exitCode).toBe(0);
      expect(preview.stdout).toContain('Preview');
      expect(preview.stdout).toContain(`#${id}`);
      expect(preview.stdout).toContain('Run with --confirm');

      // row is still there
      const show1 = runCli(['activity', 'show', String(id)]);
      expect(show1.exitCode).toBe(0);
      expect(show1.stdout).toContain('about to be deleted');
    } finally {
      teardownDir();
    }
  });

  test('activity delete --confirm executes and removes the row', () => {
    setupDir();
    try {
      const save = runCli(['activity', 'save', '--type', 'bugfix', 'will be deleted']);
      const { id } = JSON.parse(save.stdout.trim());

      const del = runCli(['activity', 'delete', String(id), '--confirm']);
      expect(del.exitCode).toBe(0);
      expect(del.stdout).toContain('Deleted 1 event');

      const show = runCli(['activity', 'show', String(id)]);
      // Deleted row is gone → not-found contract: stderr + non-zero exit (see the
      // dedicated 'activity show <missing-id>' test for the rationale).
      expect(show.exitCode).not.toBe(0);
      expect(show.stderr).toContain('not found');
    } finally {
      teardownDir();
    }
  });

  test('activity delete supports comma-separated batch IDs', () => {
    setupDir();
    try {
      const a = JSON.parse(runCli(['activity', 'save', '--type', 'bugfix', 'batch a']).stdout.trim()).id;
      const b = JSON.parse(runCli(['activity', 'save', '--type', 'bugfix', 'batch b']).stdout.trim()).id;
      const c = JSON.parse(runCli(['activity', 'save', '--type', 'bugfix', 'batch c']).stdout.trim()).id;

      const del = runCli(['activity', 'delete', `${a},${b},${c}`, '--confirm']);
      expect(del.exitCode).toBe(0);
      expect(del.stdout).toContain('Deleted 3 event');
    } finally {
      teardownDir();
    }
  });

  test('activity delete: missing IDs in mixed list are listed in preview but skipped on execute', () => {
    setupDir();
    try {
      const a = JSON.parse(runCli(['activity', 'save', '--type', 'bugfix', 'mixed valid']).stdout.trim()).id;
      const bogusId = 999999;

      const preview = runCli(['activity', 'delete', `${a},${bogusId}`]);
      expect(preview.exitCode).toBe(0);
      expect(preview.stdout).toContain(`#${a}`);
      expect(preview.stdout).toContain(`not found and will be skipped: ${bogusId}`);

      const del = runCli(['activity', 'delete', `${a},${bogusId}`, '--confirm']);
      expect(del.exitCode).toBe(0);
      expect(del.stdout).toContain('Deleted 1 event');
    } finally {
      teardownDir();
    }
  });

  test('activity delete: all missing IDs fails with EXIT=1', () => {
    setupDir();
    try {
      const { stderr, exitCode } = runCli(['activity', 'delete', '111111,222222', '--confirm']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('no events found');
    } finally {
      teardownDir();
    }
  });

  test('activity delete: rejects non-positive / non-integer IDs', () => {
    setupDir();
    try {
      const r = runCli(['activity', 'delete', 'abc,-5,0']);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('no valid IDs');
    } finally {
      teardownDir();
    }
  });

  test('activity (no subcommand) usage lists every subcommand including delete', () => {
    setupDir();
    try {
      const r = runCli(['activity']);
      expect(r.exitCode).not.toBe(0);
      // All five subcommands must appear so users know `delete` exists from the
      // usage line alone (without re-running `--help`).
      for (const sub of ['save', 'search', 'recent', 'show', 'delete']) {
        expect(r.stderr).toContain(sub);
      }
    } finally {
      teardownDir();
    }
  });

  test('activity show <missing-id> fails (stderr + non-zero exit) and names the id', () => {
    setupDir();
    try {
      const r = runCli(['activity', 'show', '99999']);
      // Not-found must use the fail() contract (stderr + exit 1) like sibling commands
      // (`get`, `activity delete`, `update`) — previously stdout + exit 0, so scripts
      // couldn't detect a missing event from the exit code. Message keeps the [mem] prefix.
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('[mem]');
      expect(r.stderr).toContain('99999');
      expect(r.stderr).toContain('not found');
    } finally {
      teardownDir();
    }
  });
});
