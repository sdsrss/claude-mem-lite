import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { computeTier, TIER_CASE_SQL, tierSqlParams } from '../tier.mjs';
import { getActiveMemorySessionId, collectBrowseTiers } from '../lib/browse-core.mjs';
import { saveObservation } from '../lib/save-observation.mjs';

const NOW = Date.now();
const HOUR = 3600000;
const DAY = 86400000;

describe('browse tier grouping', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1' });
  });
  afterEach(() => {
    db.close();
  });

  it('groups observations by tier', () => {
    insertSession(db, { id: 'sess-old', project: 'test' });
    insertObs(db, { title: 'recent work', type: 'change', epochOffset: -HOUR });
    insertObs(db, {
      title: 'active decision',
      type: 'decision',
      epochOffset: -30 * DAY,
      sessionId: 'sess-old',
    });
    insertObs(db, { title: 'old compressed', type: 'change', compressedInto: -1 });

    const ctx = { now: NOW, currentProject: 'test', currentSessionId: 'sess-1' };
    const params = tierSqlParams(ctx);

    const rows = db
      .prepare(
        `
      SELECT *, ${TIER_CASE_SQL} as tier FROM observations
    `,
      )
      .all(...params);

    const tiers = { working: [], active: [], archive: [] };
    for (const r of rows) tiers[r.tier].push(r);

    expect(tiers.working.length).toBeGreaterThanOrEqual(1);
    expect(tiers.active.length).toBeGreaterThanOrEqual(1);
    expect(tiers.archive.length).toBeGreaterThanOrEqual(1);
  });

  it('archive count query works', () => {
    insertObs(db, { title: 'compressed', compressedInto: -1 });
    insertObs(db, { title: 'auto-compressed', compressedInto: -2 });
    insertObs(db, { title: 'superseded', supersededAt: NOW, supersededBy: 1 });
    insertObs(db, { title: 'expired', type: 'change', epochOffset: -30 * DAY });

    const ctx = { now: NOW, currentProject: 'test', currentSessionId: 'sess-1' };
    const params = tierSqlParams(ctx);

    const archiveCount = db
      .prepare(
        `
      SELECT COUNT(*) as c FROM (
        SELECT ${TIER_CASE_SQL} as tier FROM observations
      ) WHERE tier = 'archive'
    `,
      )
      .get(...params);

    expect(archiveCount.c).toBeGreaterThanOrEqual(3);
  });

  it('tier filter returns only specified tier', () => {
    insertSession(db, { id: 'sess-old', project: 'test' });
    insertObs(db, { title: 'working obs', type: 'change', epochOffset: -HOUR });
    insertObs(db, { title: 'active obs', type: 'decision', epochOffset: -30 * DAY, sessionId: 'sess-old' });

    const ctx = { now: NOW, currentProject: 'test', currentSessionId: 'sess-1' };
    const params = tierSqlParams(ctx);

    const workingOnly = db
      .prepare(
        `
      SELECT * FROM (
        SELECT *, ${TIER_CASE_SQL} as tier FROM observations
      ) WHERE tier = 'working'
    `,
      )
      .all(...params);

    for (const r of workingOnly) {
      expect(r.tier).toBe('working');
    }
  });

  it('empty database produces no rows', () => {
    const ctx = { now: NOW, currentProject: 'test', currentSessionId: 'sess-1' };
    const params = tierSqlParams(ctx);
    const rows = db
      .prepare(
        `
      SELECT *, ${TIER_CASE_SQL} as tier FROM observations
    `,
      )
      .all(...params);
    expect(rows).toHaveLength(0);
  });
});

describe('mem_search tier filtering (computeTier post-filter)', () => {
  let db;
  const HOUR = 3600000;
  const DAY = 86400000;
  const NOW = Date.now();

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    insertSession(db, { id: 'sess-old' });
    insertObs(db, { title: 'recent bugfix', type: 'bugfix', text: 'auth token error', epochOffset: -HOUR });
    insertObs(db, {
      title: 'old decision',
      type: 'decision',
      text: 'auth token architecture',
      epochOffset: -60 * DAY,
      sessionId: 'sess-old',
    });
    insertObs(db, {
      title: 'ancient change',
      type: 'change',
      text: 'auth token refactor',
      epochOffset: -30 * DAY,
      sessionId: 'sess-old',
    });
  });
  afterEach(() => {
    db.close();
  });

  it('computeTier correctly classifies test data', () => {
    const ctx = { now: NOW, currentProject: 'test', currentSessionId: 'sess-1' };
    const rows = db.prepare('SELECT * FROM observations ORDER BY created_at_epoch DESC').all();

    const classified = rows.map((r) => ({ title: r.title, tier: computeTier(r, ctx) }));
    expect(classified.find((r) => r.title === 'recent bugfix').tier).toBe('working');
    expect(classified.find((r) => r.title === 'old decision').tier).toBe('active');
    expect(classified.find((r) => r.title === 'ancient change').tier).toBe('archive');
  });
});

describe('mem_stats tier distribution query', () => {
  let db;
  const HOUR = 3600000;
  const DAY = 86400000;
  const NOW = Date.now();

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    insertSession(db, { id: 'sess-old' });
    insertObs(db, { title: 'working', type: 'change', epochOffset: -HOUR });
    insertObs(db, { title: 'active', type: 'decision', epochOffset: -30 * DAY, sessionId: 'sess-old' });
    insertObs(db, { title: 'archive', type: 'change', compressedInto: -1, sessionId: 'sess-old' });
  });
  afterEach(() => {
    db.close();
  });

  it('CTE tier distribution returns correct counts', () => {
    const ctx = { now: NOW, currentProject: 'test', currentSessionId: 'sess-1' };
    const params = tierSqlParams(ctx);
    const rows = db
      .prepare(
        `
      SELECT tier, COUNT(*) as c FROM (
        SELECT ${TIER_CASE_SQL} as tier FROM observations
      ) GROUP BY tier ORDER BY tier
    `,
      )
      .all(...params);

    const dist = Object.fromEntries(rows.map((r) => [r.tier, r.c]));
    expect(dist.working).toBeGreaterThanOrEqual(1);
    expect(dist.active).toBeGreaterThanOrEqual(1);
    expect(dist.archive).toBeGreaterThanOrEqual(1);
  });
});

// D#153: the tier classifier's "current session" was the project's newest ACTIVE session row of
// any writer. A project's first mem_save inserts `manual-<project>` as an active row (a first
// merge, promote or narrow re-enrich inserts `compress-`/`promote-`/`enrich-` the same way). It is
// newer than the hook's session, and after the first Stop the hook's row is `completed` in any
// case, so browse's working tier listed that writer's rows, of any age, until a SessionStart 24h
// later marked the row abandoned.
describe('browse current session (D#153)', () => {
  const HOOK = 'hook-test-1a2b3c4d';
  const OLD_SAVE = 'an explicit save from last month';
  let db;
  const setup = () => {
    db = createTestDb();
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES (?, ?, 'test', ?, ?, 'active')`,
    ).run(HOOK, HOOK, new Date(NOW - HOUR).toISOString(), NOW - HOUR);
    saveObservation(db, { content: 'the widget cache keys on the tenant id', project: 'test' });
    insertObs(db, { sessionId: 'manual-test', title: OLD_SAVE, type: 'change', epochOffset: -30 * DAY });
  };
  afterEach(() => db.close());
  const workingTitles = () =>
    collectBrowseTiers(db, {
      project: 'test',
      tierFilter: 'working',
      limit: 50,
      now: Date.now(),
      currentSessionId: getActiveMemorySessionId(db, 'test'),
    }).tierData.working.rows.map((r) => r.title);

  it('is the hook session, not the writer row inserted after it', () => {
    setup();
    // Premise: the writer row is the project's newest active session.
    const newest = db
      .prepare(
        "SELECT memory_session_id FROM sdk_sessions WHERE project = 'test' AND status = 'active' ORDER BY started_at_epoch DESC LIMIT 1",
      )
      .get();
    expect(newest.memory_session_id).toBe('manual-test');
    expect(getActiveMemorySessionId(db, 'test')).toBe(HOOK);
    expect(workingTitles()).not.toContain(OLD_SAVE);
  });

  it('is no session once Stop has marked the hook row completed', () => {
    setup();
    db.prepare("UPDATE sdk_sessions SET status = 'completed' WHERE memory_session_id = ?").run(HOOK);
    expect(getActiveMemorySessionId(db, 'test')).toBe('');
    expect(workingTitles()).not.toContain(OLD_SAVE);
  });
});
