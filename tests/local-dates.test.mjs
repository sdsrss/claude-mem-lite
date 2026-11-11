// D18 (converge R31, user-chosen 2026-11-11; E2E 2026-11-10 CLI P2-1, MCP F3, hooks F13): dates
// were displayed in UTC while `--from/--to` / `date_from/date_to` read a bare date as the LOCAL day.
// West of Greenwich an evening save showed as tomorrow, and filtering by the date on screen missed
// it; SessionStart's "Recent (<date>)" disagreed with the model's own date. Display is local now.
// The instant used: 2026-11-11T05:52Z = 2026-11-10 21:52 in Los Angeles.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fmtDate, fmtTime, localYmd } from '../format-utils.mjs';
import { fmtDateShort, formatReviewSide } from '../cli/common.mjs';
import { parseDateBounds } from '../lib/search-core.mjs';
import { supersededEventNotice } from '../lib/get-core.mjs';
import { computeStatsFeed } from '../lib/stats-core.mjs';
import { buildSessionContextLines } from '../hook-context.mjs';
import { createTestDb, insertSession } from './test-helpers.mjs';

const ISO = '2026-11-11T05:52:00.000Z';
const EPOCH = Date.parse(ISO);

describe('dates are shown in local time (D18)', () => {
  let savedTz;
  beforeAll(() => {
    savedTz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
  });
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it('premise: the zone took effect', () => {
    expect(new Date(EPOCH).getHours()).toBe(21);
  });

  it('the formatters print the local day and clock', () => {
    expect(localYmd(new Date(EPOCH))).toBe('2026-11-10');
    expect(localYmd(ISO)).toBe('2026-11-10');
    expect(fmtDateShort(ISO)).toBe('2026-11-10');
    expect(fmtDate(ISO)).toBe('Nov 10 21:52');
    expect(fmtTime(ISO)).toBe('21:52');
  });

  it('the date shown is a date the filter finds', () => {
    const shown = fmtDateShort(ISO);
    const b = parseDateBounds(shown, shown);
    expect(b.ok).toBe(true);
    expect(EPOCH).toBeGreaterThanOrEqual(b.epochFrom);
    expect(EPOCH).toBeLessThanOrEqual(b.epochTo);
  });

  it("maintain scan's review line dates the row locally", () => {
    const line = formatReviewSide({
      id: 7,
      type: 'bugfix',
      importance: 2,
      project: 'p',
      created_at_epoch: EPOCH,
    });
    expect(line).toContain('· 2026-11-10 ·');
  });

  it('a retraction notice dates the retraction locally', () => {
    expect(supersededEventNotice({ superseded_at_epoch: EPOCH })).toContain('SUPERSEDED 2026-11-10');
  });

  it("stats' daily activity buckets by the local day", () => {
    const db = createTestDb();
    try {
      insertSession(db, { id: 'sess-1', project: 'p' });
      db.prepare(
        `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, importance, created_at, created_at_epoch)
         VALUES ('sess-1', 'p', 'x', 'discovery', 'evening note', 'x', 2, ?, ?)`,
      ).run(ISO, EPOCH);
      const feed = computeStatsFeed(db, { now: EPOCH + 60_000, days: 7 });
      expect(feed.daily.map((d) => d.day)).toEqual(['2026-11-10']);
    } finally {
      db.close();
    }
  });

  it("SessionStart's Recent heading and row time use the local day", () => {
    const db = createTestDb();
    try {
      insertSession(db, { id: 'sess-1', project: 'p' });
      db.prepare(
        `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, importance, created_at, created_at_epoch)
         VALUES ('sess-1', 'p', 'x', 'decision', 'Chose local dates for display', 'x', 2, ?, ?)`,
      ).run(ISO, EPOCH);
      const out = buildSessionContextLines(db, 'p', new Date(EPOCH + 60_000));
      expect(out).toContain('### Recent (2026-11-10)');
      expect(out).toMatch(/\| 21:52 \|/);
    } finally {
      db.close();
    }
  });
});
