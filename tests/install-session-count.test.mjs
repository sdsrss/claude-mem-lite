// `status` and `doctor` print "N sessions" from session_summaries, and a session can own
// several summary rows (legacy ones from before one row per session: 458 rows for 312
// sessions on the live DB before a one-off dedup, 2026-09-26). doctor's count says "Align
// with stats", status prints the same number, and stats now counts
// DISTINCT sessions, so both faces are driven here against a seeded DB with that shape.
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), '..', 'install.mjs');
const homes = [];
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function seededHome() {
  const home = mkdtempSync(join(tmpdir(), 'install-sess-count-'));
  homes.push(home);
  const data = join(home, 'data');
  mkdirSync(data, { recursive: true });
  const db = new Database(join(data, 'claude-mem-lite.db'));
  try {
    initSchema(db);
    const sess = db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES (?, ?, 'p', datetime('now'), ?, 'active')`,
    );
    const sum = db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
       VALUES (?, 'p', 'r', datetime('now'), ?)`,
    );
    const now = Date.now();
    for (const id of ['a', 'b']) sess.run(id, id, now);
    sum.run('a', now - 3);
    sum.run('a', now - 2);
    sum.run('b', now - 1);
    expect(db.prepare('SELECT COUNT(*) c FROM session_summaries').get().c, 'premise: 3 rows').toBe(3);
  } finally {
    db.close();
  }
  return home;
}

function run(home, args) {
  try {
    return execFileSync(process.execPath, [INSTALLER, ...args], {
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: join(home, 'data'),
        CLAUDE_MEM_SKIP_UPDATE: '1',
        MEM_QUIET_HOOKS: '1',
        MEM_NO_AUTO_ADOPT: '1',
      },
      encoding: 'utf8',
    });
  } catch (e) {
    // doctor exits non-zero on an un-installed HOME (status --json exits 0); the report is on stdout.
    return e.stdout || '';
  }
}

describe('install status / doctor count sessions, not summary rows', () => {
  it('status --json reports 2 sessions for 3 rows over 2 sessions', () => {
    const out = run(seededHome(), ['status', '--json']);
    const report = JSON.parse(out.slice(out.indexOf('{')));
    expect(report.database?.exists, `premise: status found the DB:\n${out.slice(0, 400)}`).toBe(true);
    expect(report.database.sessions).toBe(2);
  });

  it('doctor prints 2 sessions for the same DB', () => {
    const out = run(seededHome(), ['doctor']);
    expect(out, 'premise: the DB stats line was printed').toMatch(/DB stats: .* observations, \d+ sessions/);
    expect(out).toMatch(/observations, 2 sessions/);
  });
});
