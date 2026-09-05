// tests/session-invariant.test.mjs — v29 sdk_sessions id-mix invariant + audit.
//
// Covers (B1):
//   1. SQL trigger: rejects INSERT/UPDATE where memory_session_id == content_session_id
//   2. NULL memory_session_id is allowed (legacy + in-flight rows)
//   3. Distinct values are allowed (the normal write path)
//   4. auditSessionConsistency returns correct counts on a contaminated DB
//
// The v2.33.1 bug surfaced because callers silently passed content_session_id
// where memory_session_id was expected; the schema didn't enforce the two
// columns hold different ID schemes. This trigger converts the silent bug
// into a hard ABORT at write time.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { auditSessionConsistency } from '../schema.mjs';

describe('sdk_sessions id-mix invariant trigger (v29)', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // The v2.33.1 fingerprint is specifically a CC UUID written into both
  // columns. Trigger only fires when both values match UUID shape (length=36,
  // 8-4-4-4-12 LIKE pattern). Test fixtures using short literals like
  // 'sess-1' are intentionally NOT caught — they're test scaffold conventions,
  // not the production bug. Audit function below reports them for diagnostic
  // completeness without enforcing.
  const PROD_UUID = '550e8400-e29b-41d4-a716-446655440000';
  const TEST_LITERAL = 'sess-1';

  it('blocks INSERT where both columns hold the same UUID (production v2.33.1 fingerprint)', () => {
    const insert = db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    expect(() =>
      insert.run(PROD_UUID, PROD_UUID, 'p', new Date().toISOString(), Date.now(), 'active'),
    ).toThrow(/v2\.33\.1 mix pattern/);
  });

  it('does NOT block test fixtures using short literal IDs (sess-1 style)', () => {
    // Test scaffold convention — `insertSession({id:'sess-1'})` writes the
    // same string to both columns. Trigger requires UUID shape, so this is
    // allowed. 60+ existing tests rely on this carve-out.
    const insert = db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    expect(() =>
      insert.run(TEST_LITERAL, TEST_LITERAL, 'p', new Date().toISOString(), Date.now(), 'active'),
    ).not.toThrow();
  });

  it('allows INSERT where memory_session_id is NULL (legacy / in-flight)', () => {
    const insert = db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    expect(() =>
      insert.run(PROD_UUID, null, 'p', new Date().toISOString(), Date.now(), 'active'),
    ).not.toThrow();
  });

  it('allows INSERT with distinct UUID and mem-internal ID (normal write path)', () => {
    const insert = db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    expect(() =>
      insert.run(PROD_UUID, 'hook-projects--mem-abc123', 'p', new Date().toISOString(), Date.now(), 'active'),
    ).not.toThrow();
  });

  it('blocks UPDATE that would create the production mix pattern', () => {
    db.prepare(
      `
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, 'hook-proj-abc', 'p', '2026-05-09', ?, 'active')
    `,
    ).run(PROD_UUID, Date.now());
    expect(() =>
      db
        .prepare(
          `UPDATE sdk_sessions SET memory_session_id = content_session_id WHERE content_session_id = ?`,
        )
        .run(PROD_UUID),
    ).toThrow(/v2\.33\.1 mix pattern/);
  });
});

describe('auditSessionConsistency (v29)', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns healthy=true on a clean DB', () => {
    const result = auditSessionConsistency(db);
    // Exact shape on purpose — a new field cannot be added to this report without a
    // deliberate edit here. `obs_importance_null` is audit P3-14's backstop; its own
    // cases (including the one proving it can be non-zero) live in
    // tests/importance-never-null.test.mjs.
    expect(result).toEqual({
      id_mix_uuid_shape: 0,
      id_mix_other: 0,
      missing_mem_id: 0,
      orphan_obs: 0,
      obs_importance_null: 0,
      healthy: true,
    });
  });

  it('counts UUID-shape mix as alarming (drives healthy=false)', () => {
    // Pre-trigger v29 row would have allowed this; we insert by inserting
    // distinct values then UPDATE — but the UPDATE trigger would block.
    // Use raw transient INSERT bypass: drop the trigger, insert, recreate.
    // Captures the historical-data scenario the audit is meant to surface.
    db.exec(`DROP TRIGGER IF EXISTS sdk_sessions_id_mix_check_ai`);
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    db.prepare(
      `
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'p', '2026-05-09', ?, 'active')
    `,
    ).run(uuid, uuid, Date.now());
    const result = auditSessionConsistency(db);
    expect(result.id_mix_uuid_shape).toBe(1);
    expect(result.id_mix_other).toBe(0);
    expect(result.healthy).toBe(false);
  });

  it('counts non-UUID-shape mix as informational (does NOT drive healthy=false)', () => {
    // Test fixture using insertSession({id:'sess-1'}) writes the same literal
    // 'sess-1' to both columns — by helper convention. Audit reports it for
    // diagnostic transparency but does NOT fail healthy.
    db.prepare(
      `
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('sess-1', 'sess-1', 'p', '2026-05-09', ?, 'active')
    `,
    ).run(Date.now());
    const result = auditSessionConsistency(db);
    expect(result.id_mix_uuid_shape).toBe(0);
    expect(result.id_mix_other).toBe(1);
    expect(result.healthy).toBe(true);
  });

  it('detects missing_mem_id beyond the grace window', () => {
    // Old session with NULL memory_session_id — v2.33.1 fingerprint of a
    // SessionStart write that never reached Stop.
    const oldEpoch = Date.now() - 10 * 60_000; // 10 min ago, past 5-min grace
    db.prepare(
      `
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('cc-old', NULL, 'p', '2026-05-09', ?, 'active')
    `,
    ).run(oldEpoch);
    const result = auditSessionConsistency(db);
    expect(result.missing_mem_id).toBe(1);
    expect(result.healthy).toBe(false);
  });

  it('does not flag in-flight sessions inside the grace window', () => {
    // Recent session with NULL memory_session_id — handoff write hasn't
    // populated it yet; legitimate transient state.
    db.prepare(
      `
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('cc-fresh', NULL, 'p', '2026-05-09', ?, 'active')
    `,
    ).run(Date.now());
    const result = auditSessionConsistency(db);
    expect(result.missing_mem_id).toBe(0);
  });
});

// ── B2: lesson_retry_stats counters ────────────────────────────────────────

describe('lesson_retry_stats (v29 / B2)', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('recordRetryAttempt UPSERTs a fresh date bucket', async () => {
    const { recordRetryAttempt, readRetryStats } = await import('../hook-llm.mjs');
    recordRetryAttempt(db, true, '2026-05-09');
    const rows = readRetryStats(db, 365);
    expect(rows).toEqual([{ date_bucket: '2026-05-09', attempts: 1, recovered: 1 }]);
  });

  it('recordRetryAttempt accumulates within the same bucket', async () => {
    const { recordRetryAttempt } = await import('../hook-llm.mjs');
    recordRetryAttempt(db, true, '2026-05-09');
    recordRetryAttempt(db, false, '2026-05-09');
    recordRetryAttempt(db, true, '2026-05-09');
    const row = db.prepare(`SELECT * FROM lesson_retry_stats WHERE date_bucket = ?`).get('2026-05-09');
    expect(row.attempts).toBe(3);
    expect(row.recovered).toBe(2);
  });

  it('readRetryStats orders DESC and respects the days window', async () => {
    const { recordRetryAttempt, readRetryStats } = await import('../hook-llm.mjs');
    // Calendar-independent: buckets relative to now, so the 30-day window
    // assertion doesn't rot as real time advances past hardcoded dates (the
    // previous fixed 2026-05-0x dates silently fell outside the window).
    const bucket = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
    recordRetryAttempt(db, true, bucket(40)); // outside the 30-day window → excluded
    recordRetryAttempt(db, false, bucket(8));
    recordRetryAttempt(db, true, bucket(1));
    const rows = readRetryStats(db, 30);
    // DESC order, and the 40-days-ago bucket is filtered out by the window.
    expect(rows.map((r) => r.date_bucket)).toEqual([bucket(1), bucket(8)]);
  });
});
