// E2E tests for `claude-mem-lite defer add | list | drop` and the
// `claude-mem-lite save --closes-deferred` round-trip.
//
// Mirrors tests/cli-e2e.test.mjs idioms: subprocess via execFileSync,
// CLAUDE_MEM_DIR isolation, project pinned via CLAUDE_PROJECT_DIR.
//
// Test coverage (5 tests):
//   1. defer add → D#N + ordinal in stdout
//   2. defer list → priority-sorted ordinal/title rendering
//   3. defer drop → status flips, list goes empty, reason echoed
//   4. save --closes-deferred 1 → roundtrip closes the item (folded from Task 4 review)
//   5. duplicate save with --closes-deferred → second call MUST NOT re-close (Task 5 review)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';

const CLI_PATH = resolve('cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-cli-defer-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initTestDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  return db;
}

let tmpHome;
let dataDir;
let projectDir;
let db;

function runCli(args, { env = {} } = {}) {
  const mergedEnv = {
    ...process.env,
    CLAUDE_MEM_DIR: dataDir,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_MEM_HOOK_RUNNING: undefined,
    ...env,
  };
  for (const k of Object.keys(mergedEnv)) {
    if (mergedEnv[k] === undefined) delete mergedEnv[k];
  }
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      timeout: 10000,
      encoding: 'utf8',
      env: mergedEnv,
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

beforeEach(() => {
  tmpHome = makeTmpDir();
  dataDir = join(tmpHome, '.claude-mem-lite');
  // CLAUDE_PROJECT_DIR drives inferProject() → "parent--testproj"
  projectDir = join(tmpHome, 'parent', 'testproj');
  mkdirSync(projectDir, { recursive: true });
  db = initTestDb(dataDir);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('claude-mem-lite defer CLI', () => {
  it('defer add prints D#N + ordinal', () => {
    const { stdout, exitCode } = runCli(['defer', 'add', 'test item one', '--priority', '3']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/D#\d+/);
    // Ordinal "(item 1)" — first open item in this fresh project.
    expect(stdout).toMatch(/item 1/);
  });

  it('defer list shows ordinal + priority + title', () => {
    runCli(['defer', 'add', 'item A', '--priority', '2']);
    runCli(['defer', 'add', 'item B', '--priority', '3']);
    const { stdout, exitCode } = runCli(['defer', 'list']);
    expect(exitCode).toBe(0);
    // listOpenWithOrdinal sorts (priority DESC, created_at_epoch ASC) →
    // priority-3 "item B" is item 1, priority-2 "item A" is item 2.
    expect(stdout).toMatch(/1\..*item B/);
    expect(stdout).toMatch(/2\..*item A/);
  });

  it('defer drop sets status with reason', () => {
    runCli(['defer', 'add', 'item A', '--priority', '2']);
    const { stdout, exitCode } = runCli(['defer', 'drop', '1', '--reason', 'no longer needed']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Dropped D#\d+/);
    expect(stdout).toMatch(/no longer needed/);
    // After drop, list MUST be empty (only one item existed and we dropped it).
    const list = runCli(['defer', 'list']);
    expect(list.stdout).toMatch(/No open deferred items/);
  });

  // ── MCP-field flag aliases (#233 family): mem_defer.title → --title,
  // mem_defer_drop.id → --id. Flags-only invocations previously fell to a
  // stderr-only usage line (same shape as the save --text incident).
  it('defer add accepts --title as alias for the positional title', () => {
    const { stdout, exitCode } = runCli(['defer', 'add', '--title', 'alias-shaped item', '--detail', 'came in MCP field shape']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/D#\d+/);
    const list = runCli(['defer', 'list']);
    expect(list.stdout).toMatch(/alias-shaped item/);
  });

  it('defer add rejects title given both positionally and via --title', () => {
    const { stderr, exitCode } = runCli(['defer', 'add', 'positional title', '--title', 'flag title']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/once/);
  });

  it('defer drop accepts --id as alias for the positional id', () => {
    runCli(['defer', 'add', 'drop me', '--priority', '2']);
    const { stdout, exitCode } = runCli(['defer', 'drop', '--id', '1', '--reason', 'obsolete']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Dropped D#\d+/);
    expect(runCli(['defer', 'list']).stdout).toMatch(/No open deferred items/);
  });

  // ── Folded from Task 4 review (M-1): save --closes-deferred roundtrip ──────
  it('save --closes-deferred 1 closes the deferred item', () => {
    runCli(['defer', 'add', 'fix the FTS leak', '--priority', '2']);

    // Save a real bugfix observation that closes the deferred item via ordinal.
    const save = runCli([
      'save', 'Fixed FTS leak by holding a connection-scoped statement cache',
      '--type', 'bugfix',
      '--lesson', 'better-sqlite3 statements are per-connection; cache by session',
      '--importance', '2',
      '--closes-deferred', '1',
    ]);
    expect(save.exitCode).toBe(0);
    expect(save.stdout).toMatch(/Saved #\d+/);
    // Closure annotation must echo the resolved D#N (not the ordinal).
    expect(save.stdout).toMatch(/Closed: D#\d+/);

    // List must now be empty — the only deferred item transitioned to 'done'.
    const list = runCli(['defer', 'list']);
    expect(list.stdout).toMatch(/No open deferred items/);
  });

  // ── D#195: mis-drop recovery, end-to-end through the real CLI ─────────────
  // `defer drop` used on an item that was in fact FIXED used to be a one-way
  // gate: the row became indistinguishable from a genuinely rejected one and
  // lost the closed_by_obs_id link the ledger convention depends on.
  it('save --closes-deferred D#N re-closes a mis-DROPPED item into done (D#195)', () => {
    const add = runCli(['defer', 'add', 'fix the FTS leak', '--priority', '2']);
    const dId = /D#(\d+)/.exec(add.stdout)[1];

    // Drop it "by mistake" — reason worded as a completion, so the advisory
    // hint must fire on this very call.
    const drop = runCli(['defer', 'drop', '1', '--reason', 'already fixed in this round']);
    expect(drop.exitCode).toBe(0);
    expect(drop.stdout).toMatch(/closes-deferred/);

    // The ordinal is gone with the row — ordinals are defined over OPEN rows
    // only, so recovery MUST go through the explicit D#N form.
    const byOrdinal = runCli(['save', 'x', '--type', 'bugfix', '--closes-deferred', '1']);
    expect(byOrdinal.exitCode).not.toBe(0);

    const save = runCli([
      'save', 'Fixed FTS leak by holding a connection-scoped statement cache',
      '--type', 'bugfix', '--importance', '2',
      '--closes-deferred', `D#${dId}`,
    ]);
    expect(save.exitCode).toBe(0);
    expect(save.stdout).toMatch(new RegExp(`Closed: D#${dId}`));

    const row = db.prepare(`SELECT status, closed_by_obs_id, drop_reason FROM deferred_work WHERE id=?`).get(Number(dId));
    expect(row.status).toBe('done');
    expect(row.closed_by_obs_id).toBeGreaterThan(0);
    // The mis-drop stays on the record rather than being erased.
    expect(row.drop_reason).toBe('already fixed in this round');
    const detail = runCli(['get', `D#${dId}`]);
    expect(detail.stdout).toMatch(/previously_dropped: already fixed in this round/);
  });

  it('defer drop stays quiet when the reason is a genuine rejection (D#195)', () => {
    runCli(['defer', 'add', 'some item', '--priority', '2']);
    const drop = runCli(['defer', 'drop', '1', '--reason', 'no longer relevant']);
    expect(drop.exitCode).toBe(0);
    expect(drop.stdout).not.toMatch(/closes-deferred/);
  });

  // ── Folded from Task 5 review (M-1): duplicate path skips closure ──────────
  // Dogfood-4 regression: `defer add` with > 200-char titles silently accepted them,
  // wrapping into multi-line garbage in `defer list`. CLI now matches MCP memDeferSchema
  // (z.string().min(1).max(200)).
  it('defer add rejects titles longer than 200 chars (parity with MCP schema)', () => {
    const longTitle = 'Z'.repeat(250);
    // `fail()` writes to stderr — check there, not stdout.
    const { stderr, exitCode } = runCli(['defer', 'add', longTitle]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/title too long/);
    expect(stderr).toMatch(/max 200/);
  });

  // Dogfood-4 regression: `save --closes-deferred` accepted comma-separated batches but
  // `defer drop` only took a single token, forcing N shell invocations for N items.
  // Sibling-command symmetry — drop now mirrors closes-deferred's batch form.
  it('defer drop accepts comma-separated batch ordinals', () => {
    runCli(['defer', 'add', 'batch-A', '--priority', '2']);
    runCli(['defer', 'add', 'batch-B', '--priority', '2']);
    const { stdout, exitCode } = runCli(['defer', 'drop', '1,2', '--reason', 'batch test']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Dropped D#\d+, D#\d+/);
    const list = runCli(['defer', 'list']);
    expect(list.stdout).toMatch(/No open deferred items/);
  });

  // Atomicity: an unresolvable token in the batch fails the entire call. No partial
  // drops, no orphan rows. Mirrors the resolveDeferredIds throw-on-bad-token contract.
  it('defer drop with one bogus ordinal fails atomically (keeps all rows open)', () => {
    runCli(['defer', 'add', 'still-open', '--priority', '2']);
    const drop = runCli(['defer', 'drop', '1,99', '--reason', 'mixed batch']);
    expect(drop.exitCode).not.toBe(0);
    const list = runCli(['defer', 'list']);
    expect(list.stdout).toMatch(/still-open/);
  });

  it('duplicate save with --closes-deferred does NOT close the deferred item', () => {
    runCli(['defer', 'add', 'fix dedup leak', '--priority', '2']);

    const content = 'Dedup-path test: this content is sufficiently long to compute a minhash signature for dedup purposes';
    const args = [
      'save', content,
      '--type', 'bugfix',
      '--lesson', 'dedup short-circuit must skip deferred closure',
      '--importance', '2',
      '--closes-deferred', '1',
    ];

    // First save: creates obs + closes the deferred item.
    const first = runCli(args);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toMatch(/Saved #\d+/);
    expect(first.stdout).toMatch(/Closed: D#\d+/);

    // Second save: dedup short-circuit — the duplicate path MUST NOT mention
    // a "Closed: D#" suffix because closeDeferredItems is gated on
    // result.kind !== 'duplicate' (mirrors server.mjs:934).
    const second = runCli(args);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/Skipped: similar to existing #\d+/);
    expect(second.stdout).not.toMatch(/Closed: D#/);

    // Sanity-check via DB: closed_by_obs_id should still equal the FIRST obs id,
    // proving the duplicate path didn't touch the deferred row.
    const firstObsId = parseInt(/Saved #(\d+)/.exec(first.stdout)[1], 10);
    const row = db.prepare(
      `SELECT status, closed_by_obs_id FROM deferred_work WHERE project = ? ORDER BY id DESC LIMIT 1`
    ).get('parent--testproj');
    expect(row.status).toBe('done');
    expect(row.closed_by_obs_id).toBe(firstObsId);
  });

  // Round2-P2: bare parseInt coerced "3xyz"→3 / "2abc"→2 past the [1,2,3] guard and
  // silently set/escalated a deferred item's urgency. Strict-token gate rejects garbage;
  // float literals still truncate (#8277).
  it('defer add rejects garbage-token --priority instead of coercing via parseInt', () => {
    for (const bad of ['2abc', '3xyz', '1e2']) {
      const { stderr, exitCode } = runCli(['defer', 'add', `prio ${bad}`, '--priority', bad]);
      expect(exitCode, `--priority "${bad}" should exit 1`).not.toBe(0);
      expect(stderr).toMatch(/Invalid --priority/);
    }
    // none of the garbage attempts persisted
    expect(runCli(['defer', 'list']).stdout).toMatch(/No open deferred items/);
    // float literal still truncates + adds (deliberate #8277 parity)
    const ok = runCli(['defer', 'add', 'prio float', '--priority', '2.9']);
    expect(ok.exitCode).toBe(0);
    const prio = db.prepare(`SELECT priority FROM deferred_work ORDER BY id DESC LIMIT 1`).get().priority;
    expect(prio).toBe(2);
  });
});

// ─── get D#N — deferred detail read surface (2026-07-18) ─────────────────────
// RED-first: `defer list` is title-only by design (dashboard noise budget);
// `get D#N` is the full-detail reader. Locks CLI routing + render + hint line.
describe('get D#N — deferred detail read surface', () => {
  const DETAIL = 'design doc: docs/specs/precheck.md; exit codes 0/5/6 baked into gen_script';

  it('get D#N prints full detail + status', () => {
    runCli(['defer', 'add', 'env precheck design', '--priority', '2', '--detail', DETAIL]);
    const { stdout, exitCode } = runCli(['get', 'D#1']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('D#1');
    expect(stdout).toContain('env precheck design');
    expect(stdout).toContain(DETAIL);
    expect(stdout).toMatch(/open/);
  });

  it('lowercase d#N routes the same', () => {
    runCli(['defer', 'add', 'env precheck design', '--detail', DETAIL]);
    const { stdout, exitCode } = runCli(['get', 'd#1']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(DETAIL);
  });

  it('get D#999 reports not-found instead of silence', () => {
    const { stdout, stderr } = runCli(['get', 'D#999']);
    expect(stdout + stderr).toMatch(/not found|no deferred/i);
  });

  it('mixed get D#1,#77 renders the deferred section and still exits 0', () => {
    // Partial-missing obs ids are silently absent by pre-existing design (the
    // probe hint only fires when ALL sources come back empty) — this test locks
    // only the new contract: D# and obs buckets coexist in one call.
    runCli(['defer', 'add', 'env precheck design', '--detail', DETAIL]);
    const { stdout, exitCode } = runCli(['get', 'D#1,#77']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(DETAIL);
  });

  it('defer list ends with a detail-hint line pointing at get D#N', () => {
    runCli(['defer', 'add', 'item A']);
    const { stdout } = runCli(['defer', 'list']);
    expect(stdout).toMatch(/get D#/);
  });
});

// ─── P2: search surfaces open deferred items (trailer) ───────────────────────
describe('search — deferred trailer (P2)', () => {
  const TITLE = '实施环境自检步设计定稿';
  const DET = '设计文档 docs/specs/env-precheck-design.md';

  beforeEach(() => {
    runCli(['defer', 'add', TITLE, '--priority', '2', '--detail', DET]);
  });

  it('keyword search shows the trailer even when the main search has no results', async () => {
    const { stdout } = runCli(['search', '环境自检']);
    expect(stdout).toContain('D#1');
    expect(stdout).toContain(TITLE);
    expect(stdout).toMatch(/get D#/);
    // Main population is empty (no obs seeded) — the trailer must not be
    // counted as a search result.
    expect(stdout).toMatch(/No results/);
  });

  it('explicit D#N query hits via direct ref', () => {
    const { stdout } = runCli(['search', 'D#1']);
    expect(stdout).toContain(TITLE);
  });

  it('obs-filtered searches skip the trailer', () => {
    const { stdout, stderr } = runCli(['search', '环境自检', '--type', 'bugfix']);
    expect(stdout + stderr).not.toContain(TITLE);
  });

  it('--json output stays trailer-free (documented asymmetry)', () => {
    const { stdout } = runCli(['search', '环境自检', '--json']);
    const parsed = JSON.parse(stdout.trim().split('\n').pop());
    expect(parsed.deferred).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain(TITLE);
  });
});

// ─── G11 (roadmap 2026-07-18): list age tag + >30d stale refresh hint ─────────

describe('defer list age + stale hint (CLI)', () => {
  const DAY = 86_400_000;

  it('list rows carry an age tag and stale items trigger the refresh hint', () => {
    runCli(['defer', 'add', 'fresh item', '--priority', '3']);
    runCli(['defer', 'add', 'stale item', '--priority', '2']);
    // Backdate the second row 40 days via direct DB write (subprocess CLI has
    // no backdate flag by design).
    db.prepare(`UPDATE deferred_work SET created_at_epoch = ? WHERE title = 'stale item'`)
      .run(Date.now() - 40 * DAY);
    const { stdout, exitCode } = runCli(['defer', 'list']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/fresh item \(D#\d+, 0d\)/);
    expect(stdout).toMatch(/stale item \(D#\d+, 40d\)/);
    expect(stdout).toMatch(/1 .*30 days/);
  });

  it('no stale hint when all items are fresh', () => {
    runCli(['defer', 'add', 'fresh only', '--priority', '2']);
    const { stdout } = runCli(['defer', 'list']);
    expect(stdout).not.toMatch(/30 days/);
    // Detail affordance line must survive the G11 change.
    expect(stdout).toContain('Full detail:');
  });
});
