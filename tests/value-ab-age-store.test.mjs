// benchmark/value-ab/age-store.mjs — the long-gap arm of the value A/B moves a trajectory's private store back in
// time between S1 and S2, so S2 starts as if S1 were N days old. The premise that matters is behavioural: the
// shipped handoff picker must stop choosing the exit handoff once it is older than HANDOFF_EXPIRY_EXIT.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { initSchema } from '../schema.mjs';
import { pickHandoffToInject } from '../hook-handoff.mjs';
import { HANDOFF_EXPIRY_EXIT } from '../lib/handoff-constants.mjs';
import { shiftStore } from '../benchmark/value-ab/age-store.mjs';

const DAY = 86400000;
let dir;
let file;
let runtime;
const t0 = Date.now() - 60000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cml-valueab-age-'));
  file = join(dir, 'claude-mem-lite.db');
  runtime = join(dir, 'runtime');
  mkdirSync(runtime);
  writeFileSync(join(runtime, 'session-marker'), 'x');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  db.prepare(
    `INSERT INTO session_handoffs (project, type, session_id, working_on, match_keywords, git_sha_at_handoff, created_at_epoch, consumed_at)
     VALUES ('p', 'exit', 's1', 'add coupons', 'coupon', 'abc', ?, NULL)`,
  ).run(t0);
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
     VALUES ('c1', 'm1', 'p', ?, ?)`,
  ).run(new Date(t0).toISOString(), t0);
  db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
     VALUES ('m1', 'p', 'change', 'line discount', ?, ?)`,
  ).run(new Date(t0).toISOString(), t0);
  db.close();
});
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('value-ab age-store', () => {
  it('moves every epoch and ISO time back by N days, and the shipped picker stops choosing the handoff', () => {
    const before = new Database(file, { readonly: true });
    expect(pickHandoffToInject(before, 'p', 'cc-s2')).not.toBeNull(); // premise: fresh handoff is chosen
    before.close();
    expect(8 * DAY).toBeGreaterThan(HANDOFF_EXPIRY_EXIT); // premise: 8 days is past the exit window

    const report = shiftStore(file, 8, { runtimeDir: runtime });
    expect(report.rows).toBeGreaterThan(0);

    const db = new Database(file, { readonly: true });
    const h = db.prepare('SELECT created_at_epoch FROM session_handoffs').get();
    expect(h.created_at_epoch).toBe(t0 - 8 * DAY);
    const o = db.prepare('SELECT created_at, created_at_epoch FROM observations').get();
    expect(o.created_at_epoch).toBe(t0 - 8 * DAY);
    expect(o.created_at).toBe(new Date(t0 - 8 * DAY).toISOString());
    expect(pickHandoffToInject(db, 'p', 'cc-s2')).toBeNull();
    db.close();

    const age = Date.now() - statSync(join(runtime, 'session-marker')).mtimeMs;
    expect(age).toBeGreaterThan(8 * DAY - 120000);
  });

  it('refuses the real store before opening anything', () => {
    const real = join(homedir(), '.claude-mem-lite', 'value-ab-guard-probe.db');
    expect(() => shiftStore(real, 8)).toThrow(/real store/);
    expect(existsSync(real)).toBe(false);
  });
});
