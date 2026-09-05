// Tests for findFtsAnchor — the shared helper backing both
// CLI `timeline --query` and MCP mem_timeline auto-anchor.
//
// Locks the contract that triggered this fix: when AND-by-default match
// returns 0, the helper MUST relax to OR so a query like "ep-flush leak"
// can still anchor onto a row whose title contains "ep-flush" + "leaked"
// (the latter token mismatching as AND but matching as OR). Without the
// fallback, `search` finds the row but `timeline --query` does not, which
// is a paired-path divergence (#8217).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { findFtsAnchor } from '../search-engine.mjs';
import { sanitizeFtsQuery } from '../utils.mjs';

describe('findFtsAnchor', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  it('returns null when ftsQuery is empty', () => {
    expect(findFtsAnchor(db, { ftsQuery: '' })).toBeNull();
    expect(findFtsAnchor(db, { ftsQuery: null })).toBeNull();
  });

  it('returns null when no observations match (and no OR-relaxable terms)', () => {
    insertObs(db, { title: 'completely unrelated row', type: 'discovery' });
    const fts = sanitizeFtsQuery('zzz-no-match-token');
    expect(findFtsAnchor(db, { ftsQuery: fts })).toBeNull();
  });

  it('finds anchor via direct AND match — relaxed:false', () => {
    const r = insertObs(db, { title: 'ep-flush orphan files cleanup', type: 'bugfix' });
    const fts = sanitizeFtsQuery('ep-flush orphan');
    const found = findFtsAnchor(db, { ftsQuery: fts });
    expect(found).toEqual({ id: Number(r.lastInsertRowid), relaxed: false });
  });

  // The bug: this test fails before the fix because timeline-anchor used
  // bare MATCH (AND-by-default), so "ep-flush leak" missed a row whose
  // title is "ep-flush ... leaked" — the second term needs OR-relaxation.
  // Post-2.63.0 the relaxed flag also propagates so callers can surface the
  // "(relaxed AND→OR)" hint to mirror search transparency.
  it('falls back to OR when AND returns 0 results — relaxed:true', () => {
    const r = insertObs(db, { title: 'ep-flush orphan files leaked on worker crash', type: 'bugfix' });
    insertObs(db, { title: 'unrelated discovery about caching', type: 'discovery' });
    const fts = sanitizeFtsQuery('ep-flush leak');
    const found = findFtsAnchor(db, { ftsQuery: fts });
    expect(found).toEqual({ id: Number(r.lastInsertRowid), relaxed: true });
  });

  it('respects project filter (excludes rows from other projects)', () => {
    insertSession(db, { id: 'sess-2', project: 'other' });
    insertObs(db, {
      sessionId: 'sess-2',
      project: 'other',
      title: 'ep-flush leak in other project',
      type: 'bugfix',
    });
    const own = insertObs(db, {
      sessionId: 'sess-1',
      project: 'mine',
      title: 'ep-flush leak in my project',
      type: 'bugfix',
    });
    insertSession(db, { id: 'sess-mine', project: 'mine' });
    const fts = sanitizeFtsQuery('ep-flush leak');
    expect(findFtsAnchor(db, { ftsQuery: fts, project: 'mine' })?.id).toBe(Number(own.lastInsertRowid));
  });

  it('skips compressed observations (compressed_into > 0)', () => {
    const live = insertObs(db, { title: 'ep-flush live row', type: 'bugfix' });
    insertObs(db, { title: 'ep-flush superseded row', type: 'bugfix', compressedInto: 999 });
    const fts = sanitizeFtsQuery('ep-flush');
    expect(findFtsAnchor(db, { ftsQuery: fts })?.id).toBe(Number(live.lastInsertRowid));
  });

  it('prefers more recent row when BM25 is roughly equal (recency-weighted)', () => {
    insertObs(db, { title: 'ep-flush old row', type: 'bugfix', epochOffset: -90 * 24 * 3600 * 1000 });
    const recent = insertObs(db, {
      title: 'ep-flush recent row',
      type: 'bugfix',
      epochOffset: -1 * 60 * 1000,
    });
    const fts = sanitizeFtsQuery('ep-flush');
    expect(findFtsAnchor(db, { ftsQuery: fts })?.id).toBe(Number(recent.lastInsertRowid));
  });

  it('AND-direct match keeps relaxed:false even when the OR-form would also match', () => {
    // Both "ep-flush AND orphan" and "ep-flush OR orphan" hit this row;
    // the AND path takes priority so relaxed must stay false.
    const r = insertObs(db, { title: 'ep-flush orphan worker crash', type: 'bugfix' });
    const fts = sanitizeFtsQuery('ep-flush orphan');
    expect(findFtsAnchor(db, { ftsQuery: fts })).toEqual({ id: Number(r.lastInsertRowid), relaxed: false });
  });
});
