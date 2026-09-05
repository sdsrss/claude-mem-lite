// v46 / D#159 — observations.decay_seen_at_first_cite.
//
// The column exists to make ONE future decision computable: "if a memory has been
// injected K times without ever being cited, is it safe to stop injecting it?"
// Measured 2026-08-22 on the live DB, the lifetime counters cannot answer that. A
// candidate gate of `decay_seen >= 20 AND cited_count = 0` matched 631 rows, but 331
// of the 510 rows that HAVE been cited also carry lifetime decay_seen >= 20 — and
// whether they crossed 20 before or after their first citation is unrecoverable from
// cumulative counters. So the gate's false-kill rate is unmeasurable today. This
// column records the crossing point going forward.
//
// Every test here drives the REAL applyCitationDecay. A hand-written UPDATE would
// prove the column accepts writes and nothing about whether the production path
// performs them — and it is the wiring, not the DDL, that this is about.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyCitationDecay } from '../lib/citation-tracker.mjs';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

// The migration machinery itself, not the column's semantics.
//
// This exists because it is the ONE mutation a pre-release review could not kill:
// deleting the v46 entry from LATEST_MIGRATION_COLUMNS left the whole suite green.
// That list is what stops initSchema's fast path from returning early on a database
// whose schema_version already says "current" but whose tables are one migration
// behind — the exact hole that let v45 stamp its version with citation_surface_log
// never created, while every reader silently read "no such table" as "no rows yet".
// Guarding it by name would only re-cover v46, so this drives the real fast path.
describe('schema v46 migration reachability', () => {
  it('initSchema still adds the column when the version row already claims v46', () => {
    const db = new Database(':memory:');
    initSchema(db);
    // Simulate the half-applied state: version says current, table is behind.
    db.exec('ALTER TABLE observations DROP COLUMN decay_seen_at_first_cite');
    db.exec('DELETE FROM schema_version');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
    const cols = () =>
      db
        .prepare('PRAGMA table_info(observations)')
        .all()
        .map((c) => c.name);
    expect(cols(), 'precondition: the column is really gone').not.toContain('decay_seen_at_first_cite');

    initSchema(db);
    expect(cols(), 'the fast path must not skip a table that is behind its version stamp').toContain(
      'decay_seen_at_first_cite',
    );
    db.close();
  });

  it('a fresh database gets the column too', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(
      db
        .prepare('PRAGMA table_info(observations)')
        .all()
        .map((c) => c.name),
    ).toContain('decay_seen_at_first_cite');
    db.close();
  });
});

describe('decay_seen_at_first_cite (v46 / D#159)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    for (const id of ['s1', 's2', 's3', 's4', 's5']) insertSession(db, { id, project: 'p' });
  });
  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  const mk = (title = 't') =>
    insertObs(db, {
      sessionId: 's1',
      project: 'p',
      type: 'bugfix',
      title,
      importance: 2,
    }).lastInsertRowid;
  const read = (id) =>
    db
      .prepare(
        'SELECT decay_seen_count, cited_count, decay_seen_at_first_cite AS firstCite FROM observations WHERE id = ?',
      )
      .get(id);

  it('stamps the decay_seen_count in force at the first citation, counting that resolution', () => {
    const id = mk();
    // Injected and ignored in three separate sessions (separate ids: the promote path
    // is idempotent per session, so reusing one would be a no-op rather than a bump).
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 's1');
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 's2');
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 's3');
    expect(read(id)).toMatchObject({ decay_seen_count: 3, cited_count: 0, firstCite: null });

    applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 's4');
    const after = read(id);
    expect(after.decay_seen_count, 'the citing resolution counts into the denominator').toBe(4);
    expect(after.cited_count).toBe(1);
    // 4, not 3: the value answers "cited on the Nth time the loop saw it".
    expect(after.firstCite).toBe(4);
  });

  it('is 1 — not 0 — when a memory is cited on its very first resolution', () => {
    const id = mk();
    applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 's1');
    expect(read(id).firstCite).toBe(1);
  });

  it('stays NULL while a memory has never been cited, and NULL never means zero', () => {
    const id = mk();
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 's1');
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 's2');
    const row = read(id);
    expect(row.decay_seen_count).toBe(2);
    expect(row.firstCite, 'never-cited must be distinguishable from cited-at-0').toBeNull();
  });

  it('does not move on later citations — it is a first-cite stamp, not a last-cite one', () => {
    const id = mk();
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 's1');
    applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 's2');
    expect(read(id).firstCite).toBe(2);

    applyCitationDecay(db, 'p', new Set([id]), new Set(), 's3');
    applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 's4');
    applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 's5');
    const after = read(id);
    expect(after.cited_count, 'later citations did land').toBeGreaterThan(1);
    expect(after.decay_seen_count, 'and the denominator kept moving').toBeGreaterThan(2);
    expect(after.firstCite, 'but the stamp is frozen at the first one').toBe(2);
  });

  it('a same-session late citation stamps the resolution already counted, not one more', () => {
    // The cross-turn upgrade path: resolved uncited earlier in the session, cited in a
    // later turn of the SAME session. seenInc is 0 there, so the stamp must equal the
    // decay_seen_count that the earlier uncited resolution already produced.
    const id = mk();
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 's1'); // uncited, seen → 1
    expect(read(id)).toMatchObject({ decay_seen_count: 1, firstCite: null });

    applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 's1'); // same session, late cite
    const after = read(id);
    expect(after.decay_seen_count, 'must NOT double-count one injection').toBe(1);
    expect(after.firstCite, 'stamp matches the denominator, not denominator+1').toBe(1);
  });

  it('the stamp is queryable as the gate would use it', () => {
    // The shape D#159 needs in 4-6 weeks: among rows that WERE eventually cited, how
    // many had already been seen K+ times when it happened? Answering it must not
    // require joining anything else.
    const quick = mk('quick');
    const slow = mk('slow');
    applyCitationDecay(db, 'p', new Set([quick]), new Set([quick]), 's1');
    for (const s of ['s1', 's2', 's3']) applyCitationDecay(db, 'p', new Set([slow]), new Set(), s);
    applyCitationDecay(db, 'p', new Set([slow]), new Set([slow]), 's4');

    const lateCites = db
      .prepare('SELECT COUNT(*) AS n FROM observations WHERE decay_seen_at_first_cite >= 3')
      .get().n;
    expect(lateCites, 'a memory ignored 3× then cited would have been killed by a K=3 gate').toBe(1);
    // The never-cited half needs `cited_count = 0`, and this is not pedantry: NULL in
    // this column means "never cited OR first cited before v46". Every row already
    // cited when the migration ran stays NULL forever, because the stamp only fires
    // when cited_count is 0 pre-update — 518 such rows exist on the maintainer's DB
    // today. Without the extra predicate this query counts them as never-cited, and it
    // passes here only because the fixture has no pre-v46 rows. The D#159 analysis will
    // be written from a query shaped like this one, so it has to be the right shape.
    const legacy = mk('legacy-cited-before-v46');
    applyCitationDecay(db, 'p', new Set([legacy]), new Set(), 's2');
    db.prepare('UPDATE observations SET cited_count = 2, decay_seen_at_first_cite = NULL WHERE id = ?').run(
      legacy,
    );

    const neverCited = db
      .prepare(
        'SELECT COUNT(*) AS n FROM observations WHERE decay_seen_at_first_cite IS NULL AND cited_count = 0 AND decay_seen_count > 0',
      )
      .get().n;
    expect(neverCited, 'no fixture row is genuinely never-cited-but-seen').toBe(0);

    const naive = db
      .prepare(
        'SELECT COUNT(*) AS n FROM observations WHERE decay_seen_at_first_cite IS NULL AND decay_seen_count > 0',
      )
      .get().n;
    expect(naive, 'the predicate without cited_count miscounts the legacy row as never-cited').toBe(1);
  });
});
