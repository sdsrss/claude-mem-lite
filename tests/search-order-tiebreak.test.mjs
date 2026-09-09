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

// ─── batch 2 (2026-09-08) ─────────────────────────────────────────────────────
// Seventeen sites gained `, id DESC` this round. TWO are pinned below — the ones whose tie
// is observable end to end. The other FIFTEEN are changed and NOT pinned, and the whole
// list is written out because a pre-ship review caught this note enumerating ten and
// implying that was all of them:
//
//   pool membership, not readable order — search-engine's PRF seed (LIMIT 8),
//   search-scoring's concept seed (LIMIT 20), hook-llm's three dedup windows (10 / 60 /
//   200), hook-llm's 30-row session-summary window, lib/save-observation's dedup window;
//   readable but only through a surface with its own ordering — lib/search-core's three
//   cross-source `ORDER BY score` pools (sessions / prompts / events) and two of its three
//   recent listings (prompts, events); display order only — mem-cli's three
//   citation-stats listings.
//
// Pinning the first group would mean asserting on an internal population; the rest are
// reachable but would need a fixture per surface. Stated rather than papered over — and
// counted, because "the remaining N" with the wrong N is how a note stops being checkable.

describe('R11-A-P2-3 batch 2 — the main pool and the cross-source recent listings', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 's', project: 'p', memoryId: 's' });
  });
  afterEach(() => db.close());

  it('the main observation pool takes the NEWEST rows of a fully-tied group', () => {
    // buildObsFtsQuery's ORDER BY is reused by four call sites, so this is the widest
    // of the 17. Identical title+narrative gives identical BM25; one forced epoch gives
    // identical decay; same type/importance/project gives identical multipliers — so
    // every row's score is byte-identical and the tiebreak is the ONLY discriminator.
    // FAILS IF: `, o.id DESC` is dropped — SQLite then returns ascending rowid and the
    // LIMIT takes the three OLDEST, which is both the wrong direction and the wrong set.
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        Number(
          insertObs(db, {
            sessionId: 's',
            project: 'p',
            type: 'bugfix',
            title: 'retry backoff timeout',
            narrative: 'a substantive body so the low-signal filter keeps it',
          }).lastInsertRowid,
        ),
      );
    }
    db.prepare('UPDATE observations SET created_at_epoch = ?').run(TIED_EPOCH);
    expect(db.prepare('SELECT COUNT(DISTINCT created_at_epoch) AS c FROM observations').get().c).toBe(1);

    const res = searchObservationsHybrid(db, {
      ftsQuery: 'retry',
      args: { project: 'p' },
      epochFrom: null,
      epochTo: null,
      perSourceLimit: 3,
      perSourceOffset: 0,
      currentProject: 'p',
      limit: 3, // ceil(3/2)=2 <= 3 results, so the expansion stages stay out of this probe
    });
    const scores = res.map((r) => r.score);
    expect(new Set(scores).size, 'premise: the scores must really be tied').toBe(1);
    expect(res.map((r) => r.id)).toEqual([ids[4], ids[3], ids[2]]);
  });

  it('the cross-source recent listing of session summaries returns newest first', async () => {
    // coreRunSearchPipeline's recentListingNoFts branch — one of the three lists that
    // declared newest-first and delivered oldest-first on a tie.
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const r = db
        .prepare(
          `INSERT INTO session_summaries (memory_session_id, project, request, completed, created_at, created_at_epoch)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('s', 'p', `request ${i}`, `completed ${i}`, new Date(TIED_EPOCH).toISOString(), TIED_EPOCH);
      ids.push(Number(r.lastInsertRowid));
    }
    expect(db.prepare('SELECT COUNT(DISTINCT created_at_epoch) AS c FROM session_summaries').get().c).toBe(1);

    const res = await handleSearchForTest(db, { source: 'sessions', project: 'p', limit: 3 }, {});
    expect(res.results?.length, 'premise: the recent listing must have returned rows').toBe(3);
    expect(res.results.map((r) => r.id)).toEqual([ids[3], ids[2], ids[1]]);
  });
});
