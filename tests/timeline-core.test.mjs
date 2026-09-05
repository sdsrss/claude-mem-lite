import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs, insertPrompt } from './test-helpers.mjs';
import {
  resolveAnchorToken,
  formatAnchorError,
  resolveQueryAnchor,
  fetchRecentTimeline,
  fetchTimelineWindow,
} from '../lib/timeline-core.mjs';

// Single-source timeline core (D#33): cmdTimeline (CLI) and mem_timeline (MCP)
// hand-copied the anchor-resolution ladder, the findFtsAnchor query wrapper,
// and the before/after window queries — synced only by "aligned with" comments,
// the same drift class compress-core (ARCH-1) and recall-core were extracted to
// close. These tests pin the shared contract; renderers stay per-surface.
describe('timeline-core', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-tc', project: 'test' });
  });
  afterEach(() => db.close());

  const addObs = (over = {}) =>
    Number(
      insertObs(db, {
        sessionId: 'sess-tc',
        title: 'obs',
        text: 'obs body',
        ...over,
      }).lastInsertRowid,
    );

  const addSummary = (epochOffset = 0) =>
    Number(
      db
        .prepare(
          `
    INSERT INTO session_summaries (memory_session_id, project, request, completed, created_at, created_at_epoch)
    VALUES ('sess-tc', 'test', 'a request', 'a completion', ?, ?)
  `,
        )
        .run(new Date(Date.now() + epochOffset).toISOString(), Date.now() + epochOffset).lastInsertRowid,
    );

  describe('resolveAnchorToken', () => {
    it('resolves a live bare-int observation with no note', () => {
      const id = addObs();
      const r = resolveAnchorToken(db, String(id), {});
      expect(r).toEqual({ ok: true, anchorId: id, anchorNote: null });
    });

    it('resolves P#N to the nearest observation with a conversion note', () => {
      const obsId = addObs();
      const pid = Number(insertPrompt(db, { contentSessionId: 'sess-tc', text: 'hello' }).lastInsertRowid);
      const r = resolveAnchorToken(db, `P#${pid}`, {});
      expect(r.ok).toBe(true);
      expect(r.anchorId).toBe(obsId);
      expect(r.anchorNote).toBe(`(anchored to #${obsId}, closest obs to P#${pid})`);
    });

    it('resolves S#N to the nearest observation with a conversion note', () => {
      const obsId = addObs();
      const sid = addSummary();
      const r = resolveAnchorToken(db, `S#${sid}`, {});
      expect(r.ok).toBe(true);
      expect(r.anchorId).toBe(obsId);
      expect(r.anchorNote).toBe(`(anchored to #${obsId}, closest obs to S#${sid})`);
    });

    it('re-anchors a compressed observation to its live parent', () => {
      const parent = addObs({ title: 'parent' });
      const child = addObs({ title: 'child', compressedInto: parent });
      const r = resolveAnchorToken(db, `#${child}`, {});
      expect(r.ok).toBe(true);
      expect(r.anchorId).toBe(parent);
      expect(r.anchorNote).toBe(`(anchored to #${parent}, #${child} was compressed into it)`);
    });

    it('errors on negative compressed sentinel (pruned, no canonical parent)', () => {
      const pruned = addObs({ title: 'pruned', compressedInto: -1 });
      const r = resolveAnchorToken(db, String(pruned), {});
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('compressed-pruned');
      expect(r.error.id).toBe(pruned);
    });

    it('re-anchors a superseded observation to its live successor', () => {
      // A superseded row is dropped from every other read path; anchoring ON it would
      // surface a dead record, so mirror the compressed→parent redirect: hop to the
      // numeric successor recorded in superseded_by.
      const successor = addObs({ title: 'new decision' });
      const old = addObs({ title: 'old decision', supersededAt: Date.now(), supersededBy: successor });
      const r = resolveAnchorToken(db, `#${old}`, {});
      expect(r.ok).toBe(true);
      expect(r.anchorId).toBe(successor);
      expect(r.anchorNote).toBe(`(anchored to #${successor}, #${old} was superseded by it)`);
    });

    it('does NOT re-anchor when superseded_by is a string sentinel (auto-dedup)', () => {
      // hook.mjs auto-dedup writes superseded_by='auto-dedup' (a marker, not a numeric
      // id) — there is no successor to redirect to, so the token must resolve to the row
      // itself without throwing on a non-numeric hop target.
      const dup = addObs({ title: 'dedup dup', supersededAt: Date.now(), supersededBy: 'auto-dedup' });
      const r = resolveAnchorToken(db, `#${dup}`, {});
      expect(r.ok).toBe(true);
      expect(r.anchorId).toBe(dup);
      expect(r.anchorNote).toBeNull();
    });

    it('falls back from bare int to prompt when no such observation exists', () => {
      const obsId = addObs(); // obs #1
      insertPrompt(db, { contentSessionId: 'sess-tc', text: 'p1' });
      const p2 = Number(
        insertPrompt(db, { contentSessionId: 'sess-tc', text: 'p2', promptNumber: 2 }).lastInsertRowid,
      );
      expect(db.prepare('SELECT 1 FROM observations WHERE id = ?').get(p2)).toBeUndefined();
      const r = resolveAnchorToken(db, String(p2), {});
      expect(r.ok).toBe(true);
      expect(r.anchorId).toBe(obsId);
      expect(r.anchorNote).toBe(`(anchored to #${obsId}, closest obs to P#${p2})`);
    });

    it('errors id-not-found when no table has the id', () => {
      const r = resolveAnchorToken(db, '99999', {});
      expect(r).toEqual({ ok: false, error: { code: 'id-not-found', id: 99999 } });
    });

    it('errors invalid-token on garbage', () => {
      const r = resolveAnchorToken(db, 'abc', {});
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('invalid-token');
    });

    it('errors source-not-found for a missing prompt id', () => {
      const r = resolveAnchorToken(db, 'P#9999', {});
      expect(r).toEqual({
        ok: false,
        error: { code: 'source-not-found', name: 'Prompt', prefix: 'P#', id: 9999 },
      });
    });

    it('respects project scope when picking the nearest observation', () => {
      addObs({ project: 'other', title: 'other-proj obs' });
      const pid = Number(insertPrompt(db, { contentSessionId: 'sess-tc', text: 'scoped' }).lastInsertRowid);
      const r = resolveAnchorToken(db, `P#${pid}`, { project: 'test' });
      expect(r.ok).toBe(false); // only obs is in 'other'
      expect(r.error.code).toBe('no-obs-near');
    });
  });

  describe('formatAnchorError dialects', () => {
    // These strings are regression-anchored in tests/cli.test.mjs and the MCP
    // tool output — the dialect table is the single place they may diverge.
    it.each([
      [
        { code: 'invalid-token', raw: 'xx' },
        '[mem] Invalid --anchor "xx". Expected N, #N, P#N, or S#N.',
        'Invalid anchor "xx". Expected N, #N, P#N, or S#N.',
      ],
      [
        { code: 'source-not-found', name: 'Prompt', prefix: 'P#', id: 7 },
        '[mem] Prompt P#7 not found',
        'Prompt P#7 not found.',
      ],
      [
        { code: 'no-obs-near', prefix: 'S#', id: 3 },
        '[mem] No observations near S#3',
        'No observations near S#3.',
      ],
      [
        { code: 'no-obs-near', prefix: 'P#', id: 4, srcName: 'prompt' },
        '[mem] No observations near P#4 (prompt)',
        'No observations near P#4 (prompt).',
      ],
      [
        { code: 'compressed-pruned', id: 9 },
        '[mem] Observation #9 was compressed and pruned; no canonical anchor available',
        'Observation #9 was compressed and pruned; no canonical anchor available.',
      ],
      [
        { code: 'id-not-found', id: 12 },
        '[mem] Observation, prompt, or session with id 12 not found',
        'Observation, prompt, or session with id 12 not found.',
      ],
    ])('renders %o in both dialects', (error, cliMsg, mcpMsg) => {
      expect(formatAnchorError(error, 'cli')).toBe(cliMsg);
      expect(formatAnchorError(error, 'mcp')).toBe(mcpMsg);
    });
  });

  describe('resolveQueryAnchor', () => {
    it('finds an anchor by FTS query', () => {
      const id = addObs({ title: 'unique zanzibar anchor', text: 'zanzibar content' });
      const r = resolveQueryAnchor(db, 'zanzibar', {});
      expect(r).toEqual({ anchorId: id, anchorNote: null });
    });

    it('sets the relaxed note when AND→OR fallback fired', () => {
      addObs({ title: 'alpha only row', text: 'alpha content' });
      const r = resolveQueryAnchor(db, 'alpha nonexistentterm', {});
      expect(r).not.toBeNull();
      expect(r.anchorNote).toBe('(query "alpha nonexistentterm" relaxed AND→OR — no row matched all terms)');
    });

    it('returns null when nothing matches', () => {
      expect(resolveQueryAnchor(db, 'qqqqzzzz', {})).toBeNull();
    });
  });

  describe('fetchRecentTimeline', () => {
    it('returns newest-first, excludes compressed, respects project + limit', () => {
      const a = addObs({ title: 'a', epochOffset: -3000 });
      addObs({ title: 'compressed', epochOffset: -2000, compressedInto: a });
      addObs({ title: 'other-proj', project: 'other', epochOffset: -1500 });
      const c = addObs({ title: 'c', epochOffset: -1000 });
      const rows = fetchRecentTimeline(db, { project: 'test', limit: 2 });
      expect(rows.map((r) => r.id)).toEqual([c, a]);
      // Superset column contract: both renderers need their fields.
      expect(rows[0]).toHaveProperty('project');
      expect(rows[0]).toHaveProperty('created_at_epoch');
    });

    it('excludes superseded observations (parity with the before/after window)', () => {
      // The no-anchor fallback must drop superseded rows like every other read path
      // (search/recent/browse) and like fetchTimelineWindow's own before/after legs —
      // otherwise a stale, overturned memory leads the "most recent" timeline.
      const live = addObs({ title: 'live', epochOffset: -1000 });
      addObs({ title: 'stale', epochOffset: -500, supersededAt: Date.now(), supersededBy: live });
      const titles = fetchRecentTimeline(db, { project: 'test', limit: 10 }).map((r) => r.title);
      expect(titles).toContain('live');
      expect(titles).not.toContain('stale');
    });
  });

  describe('fetchTimelineWindow', () => {
    it('returns chronological beforeRows, ascending afterRows, and the anchor', () => {
      const o1 = addObs({ title: 'o1', epochOffset: -4000 });
      const o2 = addObs({ title: 'o2', epochOffset: -3000 });
      const anchor = addObs({ title: 'mid', epochOffset: -2000 });
      const o4 = addObs({ title: 'o4', epochOffset: -1000 });
      const win = fetchTimelineWindow(db, anchor, { before: 2, after: 2 });
      expect(win.anchor.id).toBe(anchor);
      expect(win.beforeRows.map((r) => r.id)).toEqual([o1, o2]); // oldest→newest
      expect(win.afterRows.map((r) => r.id)).toEqual([o4]);
    });

    it('auto-scopes to the anchor project when none passed, keeps explicit project', () => {
      addObs({ title: 'noise', project: 'other', epochOffset: -1500 });
      const anchor = addObs({ title: 'anchor', epochOffset: -1000 });
      const win = fetchTimelineWindow(db, anchor, { before: 5, after: 5 });
      expect(win.effectiveProject).toBe('test');
      expect(win.beforeRows.find((r) => r.title === 'noise')).toBeUndefined();
    });

    it('bumps access_count on the anchor', () => {
      const anchor = addObs({ title: 'bumped' });
      fetchTimelineWindow(db, anchor, { before: 1, after: 1 });
      const row = db.prepare('SELECT access_count FROM observations WHERE id = ?').get(anchor);
      expect(row.access_count).toBe(1);
    });

    it('returns null when the anchor row does not exist', () => {
      expect(fetchTimelineWindow(db, 424242, { before: 1, after: 1 })).toBeNull();
    });
  });
});
