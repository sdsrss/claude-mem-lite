// Audit 2026-09-02 P2-11 + the previous round's ALGO-7, shipped as one additive v47
// migration: an index on `session_summaries.memory_session_id` and a partial index on
// `observations(project, created_at_epoch DESC)` over live rows only.
//
// The interesting assertion is NOT "the index exists on a fresh DB" — `initSchema` runs the
// whole DDL block for a brand-new file, so that passes whether or not the version was
// bumped. What this file pins is the UPGRADE: the fast path in `initSchema` returns before
// the `CREATE INDEX IF NOT EXISTS` block, so on an existing install still reporting v46 a
// new index there is simply never created. A version-only-vs-version-plus-index diff looks
// identical on a fresh DB and differs entirely on a real user's.
import { describe, it, expect } from 'vitest';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';
import { createTestDb } from './test-helpers.mjs';

const P2_11 = 'idx_sess_sum_memory_session';
const ALGO_7 = 'idx_obs_project_live';

const indexSql = (db, name) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?").get(name)?.sql ?? null;

describe('v47 additive indexes', () => {
  it('both exist on a freshly initialised DB', () => {
    const db = createTestDb();
    expect(indexSql(db, P2_11), `${P2_11} missing`).toBeTruthy();
    expect(indexSql(db, ALGO_7), `${ALGO_7} missing`).toBeTruthy();
    db.close();
  });

  it('the live-row index is PARTIAL on the same predicate the read paths use', () => {
    // A full index on (project, created_at_epoch) would also "exist" and would not answer
    // the question the injection faces ask. Assert the WHERE clause, not the name.
    const db = createTestDb();
    const sql = indexSql(db, ALGO_7).replace(/\s+/g, ' ');
    expect(sql).toMatch(/WHERE superseded_at IS NULL AND COALESCE\(compressed_into, 0\) = 0/i);
    db.close();
  });

  it('a DB stamped at v46 — the version v3.91.0 shipped — gets them on the next open', () => {
    // The regression this file exists for, and the literal 46 is the whole point.
    //
    // The first cut stamped `CURRENT_SCHEMA_VERSION - 1`, which is a RELATIVE anchor: it
    // moves with the constant, so it is one behind by construction and the migration path
    // always runs. Reverting the bump to 46 left this case GREEN — it could not detect the
    // very omission it was written for. An absolute version is what makes it discriminate:
    // at CURRENT=47 the stamped 46 is stale and migrates; at CURRENT=46 the fast path
    // returns and both indexes stay missing.
    const PREVIOUS_RELEASED_VERSION = 46;
    const db = createTestDb();
    db.exec(`DROP INDEX IF EXISTS ${P2_11}`);
    db.exec(`DROP INDEX IF EXISTS ${ALGO_7}`);
    // Premise: the drop really took, so the assertion after the upgrade is not passing
    // against an index that was simply never removed.
    expect(indexSql(db, P2_11), 'premise: index should be gone before the upgrade').toBeNull();
    expect(indexSql(db, ALGO_7), 'premise: index should be gone before the upgrade').toBeNull();

    expect(
      CURRENT_SCHEMA_VERSION,
      "the DDL for these indexes sits below initSchema's fast path, so shipping it without " +
        'bumping past 46 is a no-op on every existing install',
    ).toBeGreaterThan(PREVIOUS_RELEASED_VERSION);

    db.prepare('UPDATE schema_version SET version = ?').run(PREVIOUS_RELEASED_VERSION);
    initSchema(db);

    expect(indexSql(db, P2_11), `${P2_11} was not created by the upgrade path`).toBeTruthy();
    expect(indexSql(db, ALGO_7), `${ALGO_7} was not created by the upgrade path`).toBeTruthy();
    expect(db.prepare('SELECT version FROM schema_version LIMIT 1').get().version).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    db.close();
  });

  it('SQLite actually uses the memory_session_id index for the existence probe', () => {
    // The whole point of P2-11: this probe was the only genuine full scan among the 30
    // statements the audit ran through EXPLAIN QUERY PLAN. Asserting the PLAN, not just the
    // index's existence, because an index the planner declines to use buys nothing.
    const db = createTestDb();
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT 1 FROM session_summaries WHERE memory_session_id = ?')
      .all('probe')
      .map((r) => r.detail)
      .join(' ');
    expect(plan).toContain(P2_11);
    expect(plan).not.toMatch(/SCAN session_summaries(?!\S)/);
    db.close();
  });
});
