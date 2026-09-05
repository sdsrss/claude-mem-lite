import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { computeTier, ACTIVE_WINDOWS, TIER_CASE_SQL, tierSqlParams, relativeTime } from '../tier.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { DECAY_HALF_LIFE_BY_TYPE } from '../utils.mjs';

const NOW = Date.now();
const HOUR = 3600000;
const DAY = 86400000;

const baseCtx = { now: NOW, currentProject: 'test', currentSessionId: 'sess-current' };

describe('ACTIVE_WINDOWS', () => {
  it('equals 2x decay half-life for each type', () => {
    for (const [type, halfLife] of Object.entries(DECAY_HALF_LIFE_BY_TYPE)) {
      expect(ACTIVE_WINDOWS[type]).toBe(halfLife * 2);
    }
  });
});

describe('computeTier', () => {
  it('returns archive for compressed_into != 0', () => {
    expect(computeTier({ compressed_into: -1 }, baseCtx)).toBe('archive');
    expect(computeTier({ compressed_into: -2 }, baseCtx)).toBe('archive');
    expect(computeTier({ compressed_into: 42 }, baseCtx)).toBe('archive');
  });

  it('returns archive for superseded observations', () => {
    expect(computeTier({ superseded_at: NOW - DAY, compressed_into: null }, baseCtx)).toBe('archive');
  });

  it('archive wins over same-session (Rule 1 > Rule 2)', () => {
    expect(
      computeTier(
        {
          compressed_into: -1,
          memory_session_id: 'sess-current',
        },
        baseCtx,
      ),
    ).toBe('archive');
  });

  it('returns working for same session', () => {
    expect(
      computeTier(
        {
          memory_session_id: 'sess-current',
          project: 'test',
          compressed_into: null,
          superseded_at: null,
          created_at_epoch: NOW - 10 * DAY,
          importance: 1,
        },
        baseCtx,
      ),
    ).toBe('working');
  });

  it('returns working for recently accessed high-importance', () => {
    expect(
      computeTier(
        {
          project: 'test',
          importance: 2,
          last_accessed_at: NOW - HOUR,
          compressed_into: null,
          superseded_at: null,
          memory_session_id: 'other',
          created_at_epoch: NOW - 30 * DAY,
          type: 'decision',
        },
        baseCtx,
      ),
    ).toBe('working');
  });

  it('not working if importance < 2 even if recently accessed', () => {
    expect(
      computeTier(
        {
          project: 'test',
          importance: 1,
          last_accessed_at: NOW - HOUR,
          compressed_into: null,
          superseded_at: null,
          memory_session_id: 'other',
          created_at_epoch: NOW - 30 * DAY,
          type: 'decision',
        },
        baseCtx,
      ),
    ).not.toBe('working');
  });

  it('returns working for recently created same-project', () => {
    expect(
      computeTier(
        {
          project: 'test',
          created_at_epoch: NOW - HOUR,
          compressed_into: null,
          superseded_at: null,
          memory_session_id: 'other',
          importance: 1,
          type: 'change',
        },
        baseCtx,
      ),
    ).toBe('working');
  });

  it('returns active for observation within decay window', () => {
    expect(
      computeTier(
        {
          type: 'decision',
          created_at_epoch: NOW - 100 * DAY,
          compressed_into: null,
          superseded_at: null,
          memory_session_id: 'other',
          project: 'other-project',
          importance: 1,
        },
        baseCtx,
      ),
    ).toBe('active');
  });

  it('returns archive for observation beyond decay window', () => {
    expect(
      computeTier(
        {
          type: 'change',
          created_at_epoch: NOW - 20 * DAY,
          compressed_into: null,
          superseded_at: null,
          memory_session_id: 'other',
          project: 'other-project',
          importance: 1,
        },
        baseCtx,
      ),
    ).toBe('archive');
  });

  it('handles null fields gracefully', () => {
    expect(
      computeTier(
        {
          compressed_into: null,
          superseded_at: null,
          memory_session_id: null,
          project: null,
          importance: null,
          last_accessed_at: null,
          created_at_epoch: NOW - 5 * DAY,
          type: 'discovery',
        },
        baseCtx,
      ),
    ).toBe('active');
  });

  it('unknown type defaults to change active window (14d)', () => {
    expect(
      computeTier(
        {
          type: 'unknown',
          created_at_epoch: NOW - 10 * DAY,
          compressed_into: null,
          superseded_at: null,
          memory_session_id: 'other',
          project: 'other',
          importance: 1,
        },
        baseCtx,
      ),
    ).toBe('active');

    expect(
      computeTier(
        {
          type: 'unknown',
          created_at_epoch: NOW - 20 * DAY,
          compressed_into: null,
          superseded_at: null,
          memory_session_id: 'other',
          project: 'other',
          importance: 1,
        },
        baseCtx,
      ),
    ).toBe('archive');
  });
});

describe('TIER_CASE_SQL parity with computeTier', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-current' });
    insertSession(db, { id: 'other-sess' });
  });
  afterEach(() => {
    db.close();
  });

  it('SQL and JS produce identical results for sample observations', () => {
    insertObs(db, { sessionId: 'sess-current', title: 'same-session', type: 'change' });
    insertObs(db, { sessionId: 'other-sess', title: 'recent', type: 'bugfix', epochOffset: -HOUR });
    insertObs(db, {
      sessionId: 'other-sess',
      title: 'active-decision',
      type: 'decision',
      epochOffset: -100 * DAY,
      project: 'other',
    });
    insertObs(db, {
      sessionId: 'other-sess',
      title: 'expired-change',
      type: 'change',
      epochOffset: -20 * DAY,
      project: 'other',
    });
    insertObs(db, { sessionId: 'other-sess', title: 'compressed', type: 'change', compressedInto: -1 });
    insertObs(db, { sessionId: 'other-sess', title: 'superseded', type: 'bugfix', supersededAt: NOW });
    insertObs(db, {
      sessionId: 'other-sess',
      title: 'high-imp-accessed',
      type: 'feature',
      importance: 2,
      lastAccessedAt: NOW - HOUR,
      epochOffset: -30 * DAY,
    });

    const params = tierSqlParams(baseCtx);
    const rows = db
      .prepare(
        `
      SELECT *, ${TIER_CASE_SQL} as tier FROM observations
    `,
      )
      .all(...params);

    for (const row of rows) {
      const jsTier = computeTier(row, baseCtx);
      expect(row.tier).toBe(jsTier);
    }
  });

  // Config-drift guard: if a type's active window is ever set SHORTER than the
  // default (e.g. DECAY_HALF_LIFE_BY_TYPE.decision lowered below .change), the SQL
  // must NOT fall through to the default window for that known type — it must use
  // the type window only, matching computeTier (ACTIVE_WINDOWS[type] ?? DEFAULT,
  // where a KNOWN type never takes the ?? branch). Pre-guard, line-76's bare
  // `created_at_epoch >= ?` fired for any old known-type row within the default
  // window, classifying a past-its-window decision as 'active' while JS said 'archive'.
  it('does not fall through to the default window for a known type with a shortened window', () => {
    insertObs(db, {
      sessionId: 'other-sess',
      title: 'short-window-decision',
      type: 'decision',
      epochOffset: -5 * DAY,
      project: 'other',
    });
    // Custom params simulating decision-window=1d while default=14d (indices match tierSqlParams).
    const params = [
      'sess-current',
      'test',
      NOW - HOUR, // session / project+importance working
      'test',
      NOW - HOUR, // project+recent working
      NOW - 1 * DAY, // decision window = 1d (SHORTER than default)
      NOW - 120 * DAY, // discovery
      NOW - 60 * DAY, // feature
      NOW - 28 * DAY, // bugfix
      NOW - 28 * DAY, // refactor
      NOW - 14 * DAY, // change
      NOW - 14 * DAY, // default fallthrough
    ];
    const row = db
      .prepare(`SELECT *, ${TIER_CASE_SQL} as tier FROM observations WHERE title = ?`)
      .get(...params, 'short-window-decision');
    // 5-day-old decision: past its 1d window, still within the 14d default. Type-window
    // semantics → 'archive'. Pre-guard the default fallthrough wrongly returned 'active'.
    expect(row.tier).toBe('archive');
  });

  // Property test — drift guard for TIER_CASE_SQL ↔ computeTier duplication.
  // The two implementations must agree for ANY observation shape, not just the
  // hand-picked samples above. Generates random rows covering every branch of
  // the decision tree (compressed / superseded / session / project+importance
  // / project+recent / type-specific active windows / fallback archive).
  it('property: SQL and JS tiers agree for arbitrary rows', () => {
    const typeArb = fc.constantFrom('decision', 'discovery', 'feature', 'bugfix', 'refactor', 'change', null);
    const sessionArb = fc.constantFrom('sess-current', 'other-sess');
    const projectArb = fc.constantFrom('test', 'other');
    // Epoch offset spans past 180 days through a little future (clock skew edge)
    const epochOffsetArb = fc.integer({ min: -180 * DAY, max: HOUR });
    const importanceArb = fc.constantFrom(1, 2, 3);
    const compressedArb = fc.constantFrom(0, -1, -2, 42);
    const supersededArb = fc.option(fc.constantFrom(NOW - DAY, NOW), { nil: null });
    const lastAccessedArb = fc.option(fc.integer({ min: NOW - 30 * DAY, max: NOW }), { nil: null });

    const db = createTestDb();
    try {
      insertSession(db, { id: 'sess-current' });
      insertSession(db, { id: 'other-sess' });

      fc.assert(
        fc.property(
          fc.record({
            sessionId: sessionArb,
            project: projectArb,
            type: typeArb,
            importance: importanceArb,
            compressedInto: compressedArb,
            supersededAt: supersededArb,
            lastAccessedAt: lastAccessedArb,
            epochOffset: epochOffsetArb,
          }),
          (spec) => {
            // Insert one observation matching the generated spec; clear after
            // the check so each run measures one row in isolation.
            const typeForInsert = spec.type ?? 'change';
            const title = `prop-${Math.random().toString(36).slice(2, 8)}`;
            insertObs(db, {
              sessionId: spec.sessionId,
              project: spec.project,
              type: typeForInsert,
              title,
              importance: spec.importance,
              compressedInto: spec.compressedInto === 0 ? null : spec.compressedInto,
              supersededAt: spec.supersededAt,
              lastAccessedAt: spec.lastAccessedAt,
              epochOffset: spec.epochOffset,
            });
            try {
              const params = tierSqlParams(baseCtx);
              const row = db
                .prepare(
                  `
                SELECT *, ${TIER_CASE_SQL} as tier FROM observations WHERE title = ?
              `,
                )
                .get(...params, title);
              if (!row) return true; // insertObs may skip invalid combos
              const jsTier = computeTier(row, baseCtx);
              return row.tier === jsTier;
            } finally {
              db.prepare(`DELETE FROM observations WHERE title = ?`).run(title);
            }
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      db.close();
    }
  });
});

describe('relativeTime', () => {
  it('formats seconds', () => {
    expect(relativeTime(NOW - 30000, NOW)).toBe('30s ago');
  });
  it('formats minutes', () => {
    expect(relativeTime(NOW - 5 * 60000, NOW)).toBe('5min ago');
  });
  it('formats hours', () => {
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe('3h ago');
  });
  it('formats days', () => {
    expect(relativeTime(NOW - 5 * DAY, NOW)).toBe('5d ago');
  });
  it('formats months', () => {
    expect(relativeTime(NOW - 45 * DAY, NOW)).toBe('1mo ago');
  });
  // Future / clock-skew timestamps must not render a negative duration
  // ("-7200s ago"). Clamp to the present so display stays sensible.
  it('clamps future timestamps to now', () => {
    expect(relativeTime(NOW + 2 * HOUR, NOW)).toBe('0s ago');
  });
  it('clamps a few seconds in the future', () => {
    expect(relativeTime(NOW + 5000, NOW)).toBe('0s ago');
  });
});
