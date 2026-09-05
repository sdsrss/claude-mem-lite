import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { computeTier, TIER_CASE_SQL, tierSqlParams } from '../tier.mjs';

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
