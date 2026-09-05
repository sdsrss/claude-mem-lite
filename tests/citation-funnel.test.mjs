// R1: per-session invocation→cite funnel telemetry. recordCitationFunnel persists
// one accumulating row per resolved session (citation_log); computeCitationFunnelTrend
// reads it back as a windowed trend. Both live in lib/citation-tracker.mjs alongside
// the citation-decay loop that feeds them (applyCitationDecay's touched/promoted).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { recordCitationFunnel, computeCitationFunnelTrend } from '../lib/citation-tracker.mjs';

describe('recordCitationFunnel', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  const get = (project, session) =>
    db.prepare('SELECT * FROM citation_log WHERE project=? AND memory_session_id=?').get(project, session);

  it('inserts a row with injected/cited counts on first call', () => {
    recordCitationFunnel(db, 'p1', 's1', 5, 3);
    const row = get('p1', 's1');
    expect(row.injected_n).toBe(5);
    expect(row.cited_n).toBe(3);
    expect(row.resolved_at).toBeGreaterThan(0);
  });

  it('accumulates counts across calls for the same session (UPSERT add)', () => {
    recordCitationFunnel(db, 'p1', 's1', 5, 3);
    recordCitationFunnel(db, 'p1', 's1', 2, 1);
    const row = get('p1', 's1');
    expect(row.injected_n).toBe(7);
    expect(row.cited_n).toBe(4);
  });

  it('keeps separate rows per session', () => {
    recordCitationFunnel(db, 'p1', 's1', 5, 3);
    recordCitationFunnel(db, 'p1', 's2', 4, 0);
    expect(get('p1', 's1').injected_n).toBe(5);
    expect(get('p1', 's2').injected_n).toBe(4);
    expect(get('p1', 's2').cited_n).toBe(0);
  });

  it('keeps separate rows per project for the same session id', () => {
    recordCitationFunnel(db, 'p1', 's1', 5, 3);
    recordCitationFunnel(db, 'p2', 's1', 1, 1);
    expect(get('p1', 's1').injected_n).toBe(5);
    expect(get('p2', 's1').injected_n).toBe(1);
  });

  it('writes no row when both deltas are 0 (nothing resolved, no noise)', () => {
    recordCitationFunnel(db, 'p1', 's1', 0, 0);
    expect(get('p1', 's1')).toBeUndefined();
  });

  it('records a cited-only delta from a cross-turn late upgrade (injected=0, cited>0)', () => {
    // Turn 1 resolved 3 obs uncited → the session row exists with cited_n=0.
    recordCitationFunnel(db, 'p1', 's1', 3, 0);
    // Turn 3: one of those obs is cited late. applyCitationDecay returns touched=0
    // (already in the denominator) but promoted=1. The numerator must still bump —
    // the pre-fix `if (inj <= 0) return` dropped this, silently under-counting cites.
    recordCitationFunnel(db, 'p1', 's1', 0, 1);
    const row = get('p1', 's1');
    expect(row.injected_n).toBe(3); // denominator unchanged — no double-count
    expect(row.cited_n).toBe(1); // numerator credited the late citation
  });

  it('does not throw on null db / empty args', () => {
    expect(() => recordCitationFunnel(null, 'p', 's', 1, 1)).not.toThrow();
    expect(() => recordCitationFunnel(db, '', 's', 1, 1)).not.toThrow();
    expect(() => recordCitationFunnel(db, 'p', '', 1, 1)).not.toThrow();
  });
});

describe('computeCitationFunnelTrend', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  // Insert a citation_log row at a controlled resolved_at (N days ago) so window
  // math is deterministic without depending on recordCitationFunnel's clock.
  function logAt(project, session, injected, cited, daysAgo) {
    db.prepare(
      'INSERT INTO citation_log (project, memory_session_id, resolved_at, injected_n, cited_n) VALUES (?,?,?,?,?)',
    ).run(project, session, Date.now() - daysAgo * 86400000, injected, cited);
  }

  it('returns recent sessions most-recent-first with per-session rate', () => {
    logAt('p1', 's_old', 10, 2, 3);
    logAt('p1', 's_new', 8, 6, 0);
    const t = computeCitationFunnelTrend(db, { days: 7 });
    expect(t.sessions[0].memory_session_id).toBe('s_new');
    expect(t.sessions[0].rate).toBeCloseTo(0.75, 5);
    expect(t.sessions[1].memory_session_id).toBe('s_old');
    expect(t.sessions[1].rate).toBeCloseTo(0.2, 5);
  });

  it('window aggregate = sum(cited)/sum(injected) within last `days`', () => {
    logAt('p1', 'a', 10, 5, 1);
    logAt('p1', 'b', 10, 3, 2);
    const t = computeCitationFunnelTrend(db, { days: 7 });
    expect(t.window.injected).toBe(20);
    expect(t.window.cited).toBe(8);
    expect(t.window.rate).toBeCloseTo(0.4, 5);
  });

  it('prior window covers [2*days, days) ago and yields delta_pt', () => {
    logAt('p1', 'w', 10, 5, 1); // last 7d → 0.5
    logAt('p1', 'p', 8, 2, 10); // 7–14d ago → 0.25
    const t = computeCitationFunnelTrend(db, { days: 7 });
    expect(t.window.rate).toBeCloseTo(0.5, 5);
    expect(t.prior.rate).toBeCloseTo(0.25, 5);
    expect(t.delta_pt).toBeCloseTo(25.0, 1);
  });

  it('delta_pt is null when prior window has no data', () => {
    logAt('p1', 'w', 10, 5, 1);
    const t = computeCitationFunnelTrend(db, { days: 7 });
    expect(t.prior.injected).toBe(0);
    expect(t.delta_pt).toBeNull();
  });

  it('respects limit on the session list', () => {
    for (let i = 0; i < 5; i++) logAt('p1', `s${i}`, 4, 1, i);
    const t = computeCitationFunnelTrend(db, { days: 30, limit: 3 });
    expect(t.sessions.length).toBe(3);
  });

  it('returns zeros and empty list when no data', () => {
    const t = computeCitationFunnelTrend(db, { days: 7 });
    expect(t.sessions).toEqual([]);
    expect(t.window.rate).toBe(0);
    expect(t.delta_pt).toBeNull();
  });

  it('filters by project when provided', () => {
    logAt('p1', 's1', 10, 5, 1);
    logAt('p2', 's2', 10, 0, 1);
    const t = computeCitationFunnelTrend(db, { days: 7, project: 'p1' });
    expect(t.window.injected).toBe(10);
    expect(t.sessions.every((s) => s.project === 'p1')).toBe(true);
  });
});
