// Regression: `--from`/`--to` (and MCP date_from/date_to) date-only bounds must be the
// user's LOCAL calendar day. Observations store created_at_epoch = Date.now() (local
// wall-clock), but `new Date('YYYY-MM-DD')` parses as UTC midnight — so for any non-UTC
// user (the UTC+8 core base) a same-day window was shifted by the tz offset, silently
// dropping early-morning rows and leaking the next calendar day's early hours.
import { describe, it, expect, afterEach } from 'vitest';
import { parseDateBounds } from '../lib/search-core.mjs';

describe('parseDateBounds — date-only bounds are LOCAL calendar days', () => {
  const savedTz = process.env.TZ;
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it('parses date-only --from as local midnight (not UTC midnight)', () => {
    process.env.TZ = 'Asia/Shanghai'; // UTC+8
    const { epochFrom } = parseDateBounds('2026-06-12', null);
    expect(epochFrom).toBe(new Date(2026, 5, 12, 0, 0, 0, 0).getTime());
  });

  it('parses date-only --to as local end-of-day (23:59:59.999 local)', () => {
    process.env.TZ = 'Asia/Shanghai';
    const { epochTo } = parseDateBounds(null, '2026-06-12');
    expect(epochTo).toBe(new Date(2026, 5, 12, 23, 59, 59, 999).getTime());
  });

  it('a same-day window includes a 00:30-local row and excludes the next day', () => {
    process.env.TZ = 'Asia/Shanghai';
    const { epochFrom, epochTo } = parseDateBounds('2026-06-12', '2026-06-12');
    const rowAt0030Local = new Date(2026, 5, 12, 0, 30, 0, 0).getTime();
    const rowNextDay0300 = new Date(2026, 5, 13, 3, 0, 0, 0).getTime();
    expect(rowAt0030Local).toBeGreaterThanOrEqual(epochFrom);
    expect(rowAt0030Local).toBeLessThanOrEqual(epochTo);
    expect(rowNextDay0300).toBeGreaterThan(epochTo);
  });

  it('still honors an explicit ISO 8601 timestamp with zone (unchanged)', () => {
    process.env.TZ = 'Asia/Shanghai';
    const { epochFrom } = parseDateBounds('2026-06-12T10:00:00Z', null);
    expect(epochFrom).toBe(Date.parse('2026-06-12T10:00:00Z'));
  });

  it('rejects an out-of-range calendar date (parity with the old strict NaN)', () => {
    const r = parseDateBounds('2026-13-45', null);
    expect(r.ok).toBe(false);
    expect(r.bad).toBe('from');
  });
});
