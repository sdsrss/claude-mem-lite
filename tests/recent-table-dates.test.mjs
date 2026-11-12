// The SessionStart "### Recent (<today>)" table printed a bare HH:MM per row, so rows days old
// read as today's and looked out of order (E2E 2026-10-16, hooks F7 / cli F4). A row from another
// day now carries its MM-DD; today's rows keep the bare time. Days are local since D18, so the
// expectations use the same localYmd (the UTC ones failed whenever the local and UTC dates differ).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSessionContextLines } from '../hook-context.mjs';
import { localYmd } from '../format-utils.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

let orig;
beforeEach(() => {
  orig = process.env.MEM_NO_AUTO_ADOPT;
  process.env.MEM_NO_AUTO_ADOPT = '1';
});
afterEach(() => {
  if (orig === undefined) delete process.env.MEM_NO_AUTO_ADOPT;
  else process.env.MEM_NO_AUTO_ADOPT = orig;
});

describe('Recent table time column', () => {
  it("dates a row from another day and leaves today's bare", () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    const now = new Date();
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'bugfix',
      title: 'Stripe webhook retries double-charge',
      importance: 2,
      epochOffset: -3 * 86400000,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'bugfix',
      title: 'CSV export drops UTF-8 BOM',
      importance: 2,
      epochOffset: -1000,
    });
    const out = buildSessionContextLines(db, 'test', now);
    const rows = out.split('\n').filter((l) => /^\| #\d+ \|/.test(l));
    const old = rows.find((l) => l.includes('Stripe webhook'));
    const fresh = rows.find((l) => l.includes('CSV export'));
    expect(old, out).toBeTruthy();
    const oldDay = localYmd(new Date(now.getTime() - 3 * 86400000)).slice(5);
    expect(old).toMatch(new RegExp(`\\| ${oldDay} \\d{2}:\\d{2} \\|`));
    if (localYmd(new Date(now.getTime() - 1000)) === localYmd(now)) {
      expect(fresh).toMatch(/\| \d{2}:\d{2} \|/);
    }
    db.close();
  });
});
