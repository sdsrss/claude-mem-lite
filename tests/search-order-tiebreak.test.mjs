// R11-A-P2-3 batch 1 — the retrieval core's untiebroken ORDER BYs.
//
// D#9 established the mechanism in hook-optimize.mjs and CLAUDE.md recorded that "the
// other 52 sites in other files are NOT cleared, just unjudged, and nobody recorded the
// name set". R11 partition A read every `.prepare(` block in the retrieval core and
// judged 12 of its 15 SQL sorts harmful; this file pins the four that can be asserted
// behaviourally without moving candidate-pool membership into RRF.
//
// The damage is in the DIRECTION and it is counter-intuitive: on a tie SQLite returns
// ASCENDING rowid — oldest first — while an untied pool returns newest first, so a
// statement that says `created_at_epoch DESC` silently inverts whenever the clock has
// not ticked between two inserts. Measured at 272/300 = 90.67% same-millisecond for the
// two-Date.now() insert shape these fixtures reproduce.
//
// Every fixture forces ONE epoch across all rows with an explicit UPDATE rather than
// relying on inserts landing in the same millisecond, so the tie is a premise, not a
// race. Each case asserts a PREMISE (the rows really are tied) before asserting order.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findFtsAnchor, searchObservationsHybrid } from '../search-engine.mjs';
import { searchPromptsFts } from '../lib/search-core.mjs';
import { handleSearchForTest } from '../server.mjs';
import { createTestDb, insertSession, insertObs, insertPrompt } from './test-helpers.mjs';

const TIED_EPOCH = 1_700_000_000_000;

function tieAllObs(db) {
  db.prepare('UPDATE observations SET created_at_epoch = ?').run(TIED_EPOCH);
  const distinct = db.prepare('SELECT COUNT(DISTINCT created_at_epoch) AS c FROM observations').get().c;
  expect(distinct).toBe(1); // premise: every row really is on one epoch
}

describe('R11-A-P2-3 — retrieval-core ORDER BY is total under exact ties', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 's', project: 'p', memoryId: 's' });
  });
  afterEach(() => db.close());

  const seedObs = (n) => {
    const ids = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        Number(
          insertObs(db, {
            sessionId: 's',
            project: 'p',
            type: 'bugfix',
            title: `retry backoff variant ${i}`,
            narrative: 'a substantive body so the low-signal filter keeps it',
          }).lastInsertRowid,
        ),
      );
    }
    tieAllObs(db);
    return ids;
  };

  it('findFtsAnchor picks the NEWEST of a tied group, not the oldest (LIMIT 1)', () => {
    // The second harm class D#9 names: with LIMIT 1 the tie decides CONTENT, not just
    // pool membership. This anchor drives `timeline --query` / mem_timeline, so an
    // arbitrary pick shifts the whole navigation window.
    const ids = seedObs(5);
    const anchor = findFtsAnchor(db, { ftsQuery: 'retry', project: 'p' });
    expect(anchor?.id).toBe(ids[ids.length - 1]);
  });

  it('the no-query recent listing returns newest first under a tie', () => {
    const ids = seedObs(5);
    const res = searchObservationsHybrid(db, {
      ftsQuery: null,
      args: { project: 'p' },
      epochFrom: null,
      epochTo: null,
      perSourceLimit: 3,
      perSourceOffset: 0,
      currentProject: 'p',
      limit: 3,
    });
    // Both halves matter: the DIRECTION (newest first, as the statement claims) and the
    // MEMBERSHIP (a LIMIT below the tie size must take the newest three, not the oldest).
    expect(res.map((r) => r.id)).toEqual([ids[4], ids[3], ids[2]]);
  });

  it('the MCP type-list fallback returns newest first under a tie', async () => {
    const ids = seedObs(5);
    const res = await handleSearchForTest(
      db,
      { query: 'zzznomatchqqqxyz', obs_type: 'bugfix', deep: false, limit: 3 },
      {},
    );
    expect((res.results || []).map((r) => r.id)).toEqual([ids[4], ids[3], ids[2]]);
  });

  it('the prompts CJK LIKE fallback returns newest first under a tie', () => {
    // FTS5 unicode61 cannot tokenize CJK substrings, so this LIKE path is the ONLY way
    // these rows are reachable — and it carried the same inverted order.
    const ids = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        Number(
          insertPrompt(db, { contentSessionId: 's', text: `请修复重试退避 ${i}`, promptNumber: i + 1 })
            .lastInsertRowid,
        ),
      );
    }
    db.prepare('UPDATE user_prompts SET created_at_epoch = ?').run(TIED_EPOCH);
    expect(db.prepare('SELECT COUNT(DISTINCT created_at_epoch) AS c FROM user_prompts').get().c).toBe(1);

    const rows = searchPromptsFts(db, {
      query: '重试退避',
      ftsQuery: '重试退避',
      project: 'p',
      epochFrom: null,
      epochTo: null,
      perSourceLimit: 10,
      perSourceOffset: 0,
    });
    expect(rows.length).toBeGreaterThan(1); // premise: the LIKE fallback actually fired
    expect(rows.map((r) => r.id)).toEqual([...ids].reverse());
  });
});
