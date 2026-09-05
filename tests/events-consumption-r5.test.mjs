// R5 code-review follow-ups to v3.44.0 "events searchable via mem_search".
// Three consumption gaps the review found on the primary (MCP) surface:
//   D#74 — events (and sessions/prompts) were silently dropped when auto-deep escalated.
//   D#75 — E#N rows were advertised as mem_get/timeline-fetchable but the id parser rejected them,
//          and a stripped prefix mis-fetched the colliding observation id.
//   D#76 — obs_type='bugfix' forced observations-only, excluding the canonical bugfix store (events).
import { describe, it, expect } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { parseIdToken, bucketIdTokens, probeOtherSources } from '../lib/id-routing.mjs';
import { resolveAnchorToken } from '../lib/timeline-core.mjs';
import { coreRunSearchPipeline, searchEventsFts } from '../lib/search-core.mjs';
import { searchObservationsHybrid } from '../search-engine.mjs';
import { handleSearchForTest } from '../server.mjs';

function addEvent(
  db,
  {
    title,
    body = '',
    project = 'test',
    event_type = 'bugfix',
    importance = 2,
    epochOffset = 0,
    superseded = false,
  },
) {
  return Number(
    db
      .prepare(
        `
    INSERT INTO events (project, event_type, title, body, importance, created_at_epoch, superseded_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
      )
      .run(
        project,
        event_type,
        title,
        body,
        importance,
        Date.now() + epochOffset,
        superseded ? Date.now() : null,
      ).lastInsertRowid,
  );
}

// ─── D#75: E# id-routing ─────────────────────────────────────────────────────
describe('D#75 — E# tokens route to the events source', () => {
  it('parseIdToken accepts E#/e prefix without disturbing the existing ones', () => {
    expect(parseIdToken('E#5')).toEqual({ source: 'event', id: 5 });
    expect(parseIdToken('e5')).toEqual({ source: 'event', id: 5 });
    expect(parseIdToken('P#5')).toEqual({ source: 'prompt', id: 5 });
    expect(parseIdToken('S#5')).toEqual({ source: 'session', id: 5 });
    expect(parseIdToken('5')).toEqual({ source: null, id: 5 });
    expect(parseIdToken('X#5')).toBeNull();
  });

  it('bucketIdTokens groups E# into its own bucket', () => {
    const { bySrc, invalid } = bucketIdTokens(['1', 'E#2', 'P#3', 'S#4']);
    expect(bySrc.obs).toEqual([1]);
    expect(bySrc.event).toEqual([2]);
    expect(bySrc.prompt).toEqual([3]);
    expect(bySrc.session).toEqual([4]);
    expect(invalid).toEqual([]);
  });

  it('probeOtherSources surfaces an event id when a bare number was queried as obs', () => {
    const db = createTestDb();
    const eid = addEvent(db, { title: 'collision candidate' });
    const probe = probeOtherSources(db, [eid], new Set(['obs']));
    expect(probe.event).toContain(eid);
  });
});

// ─── D#75: timeline anchors events safely (no obs-id collision) ───────────────
describe('D#75 — mem_timeline anchors E# to the nearest observation', () => {
  it('resolves an event anchor to a real neighbouring obs, not the colliding obs id', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    const obsId = Number(insertObs(db, { title: 'near obs', text: 'x', epochOffset: -20 }).lastInsertRowid);
    const eid = addEvent(db, { title: 'event needing an anchor', epochOffset: 0 });
    const r = resolveAnchorToken(db, `E#${eid}`, { project: null });
    expect(r.ok).toBe(true);
    expect(r.anchorId).toBe(obsId);
    expect(r.anchorNote).toContain(`E#${eid}`);
  });

  it('a missing event anchor fails cleanly instead of silently hitting observation #id', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    // Seed observation #1 so a naive fall-through would resolve E#1 to it — the bug we guard.
    insertObs(db, { title: 'decoy obs', text: 'x' });
    const r = resolveAnchorToken(db, 'E#1', {});
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('source-not-found');
    expect(r.error.prefix).toBe('E#');
  });
});

// ─── D#74: events survive auto-deep escalation ───────────────────────────────
describe('D#74 — auto-escalation keeps the cross-source legs (events)', () => {
  it('runs the events leg after escalation replaces obs with a deep fuse', async () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertObs(db, { title: 'weak obs', text: 'weak', epochOffset: -100 });
    const eid = addEvent(db, { title: 'zanzibar cache corruption', body: 'zanzibar', epochOffset: -10 });

    const deepObs = [
      {
        source: 'obs',
        id: 9991,
        type: 'discovery',
        title: 'deep fused row',
        score: -5,
        created_at_epoch: Date.now() - 200,
        snippet: '',
      },
    ];
    const res = await coreRunSearchPipeline(
      {
        db,
        currentProject: 'test',
        env: { CLAUDE_MEM_AUTO_DEEP: '1' },
        searchObservationsHybrid,
        deepSearch: async () => ({ variants: ['zanzibar'], reranked: false, results: deepObs }),
        shouldEscalateToDeep: () => true, // force the weak-results verdict
        autoDeepLlmReady: () => true,
        reRankWithContext: () => {},
        llm: async () => '',
      },
      {
        query: 'zanzibar',
        ftsQuery: 'zanzibar',
        deepMode: 'auto',
        limit: 20,
        offset: 0,
        project: null,
        obsType: null,
        rerankPolicy: 'mcp',
        crossSourceEpochSortNoFts: true,
        recentListingNoFts: true,
      },
    );

    expect(res.escalated).toBe(true);
    expect(res.isDeep).toBe(true);
    expect(res.page.some((r) => r.source === 'event' && r.id === eid)).toBe(true); // D#74 fix
    expect(res.page.some((r) => r.source === 'obs' && r.id === 9991)).toBe(true); // deep fuse present
    expect(res.total).toBe(res.page.length); // deep-path count == shown
  });

  it('explicit deep=true still dives observations-only (events NOT re-added)', async () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    addEvent(db, { title: 'zanzibar event', body: 'zanzibar', epochOffset: -10 });
    const deepObs = [
      {
        source: 'obs',
        id: 9992,
        type: 'discovery',
        title: 'deep only',
        score: -5,
        created_at_epoch: Date.now(),
        snippet: '',
      },
    ];
    const res = await coreRunSearchPipeline(
      {
        db,
        currentProject: 'test',
        env: {},
        searchObservationsHybrid,
        deepSearch: async () => ({ variants: ['zanzibar'], reranked: false, results: deepObs }),
        shouldEscalateToDeep: () => false,
        autoDeepLlmReady: () => true,
        reRankWithContext: () => {},
        llm: async () => '',
      },
      {
        query: 'zanzibar',
        ftsQuery: 'zanzibar',
        deepMode: 'deep',
        limit: 20,
        offset: 0,
        rerankPolicy: 'mcp',
      },
    );
    expect(res.isDeep).toBe(true);
    expect(res.escalated).toBe(false);
    expect(res.page.some((r) => r.source === 'event')).toBe(false); // explicit deep = obs-only, unchanged
  });
});

// ─── D#76: obs_type reaches events; sessions/prompts stay excluded ───────────
describe('D#76 — obs_type filters observations AND events', () => {
  it('searchEventsFts honors event_type + importance filters', () => {
    const db = createTestDb();
    addEvent(db, { event_type: 'bugfix', title: 'cache bugfix', importance: 3 });
    addEvent(db, { event_type: 'decision', title: 'cache decision', importance: 3 });
    addEvent(db, { event_type: 'bugfix', title: 'cache minor bugfix', importance: 1 });
    const typed = searchEventsFts(db, { ftsQuery: 'cache', eventType: 'bugfix', perSourceLimit: 10 });
    expect(typed.every((r) => r.event_type === 'bugfix')).toBe(true);
    expect(typed).toHaveLength(2);
    const strong = searchEventsFts(db, {
      ftsQuery: 'cache',
      eventType: 'bugfix',
      importance: 2,
      perSourceLimit: 10,
    });
    expect(strong).toHaveLength(1); // the importance:1 bugfix filtered out
  });

  it('mem_search(obs_type="bugfix") includes bugfix events, excludes sessions/prompts, count stays consistent', async () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertObs(db, {
      type: 'bugfix',
      title: 'cache bugfix obs',
      text: 'cache',
      importance: 2,
      epochOffset: -100,
    });
    insertObs(db, { type: 'discovery', title: 'cache discovery obs', text: 'cache', epochOffset: -200 });
    addEvent(db, { event_type: 'bugfix', title: 'cache bugfix event', body: 'cache', epochOffset: -150 });
    addEvent(db, { event_type: 'decision', title: 'cache decision event', body: 'cache', epochOffset: -160 });
    // A session that matches 'cache' but must NOT surface under an obs_type filter.
    insertSession(db, { id: 'csess-1', memoryId: 'msess-1', project: 'test' });
    db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, request, completed, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('msess-1', 'test', 'cache session request', 'done', new Date().toISOString(), Date.now() - 300);

    const res = await handleSearchForTest(db, { query: 'cache', obs_type: 'bugfix', deep: false });
    const bySource = res.results.reduce((m, r) => {
      m[r.source] = (m[r.source] || 0) + 1;
      return m;
    }, {});
    expect(bySource.event).toBeGreaterThanOrEqual(1); // canonical bugfix store reached
    expect(bySource.obs).toBeGreaterThanOrEqual(1);
    expect(bySource.session).toBeUndefined(); // type-less source excluded
    expect(bySource.prompt).toBeUndefined();
    expect(res.results.every((r) => r.type === 'bugfix')).toBe(true); // only bugfix-typed rows
    expect(res.total).toBe(res.results.length); // "N of M" population matches shown rows
  });

  it('type="events" honors obs_type as the event_type filter (was silently ignored)', async () => {
    const db = createTestDb();
    addEvent(db, { event_type: 'bugfix', title: 'cache bugfix event', body: 'cache' });
    addEvent(db, { event_type: 'decision', title: 'cache decision event', body: 'cache' });
    const res = await handleSearchForTest(db, {
      query: 'cache',
      type: 'events',
      obs_type: 'bugfix',
      deep: false,
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].type).toBe('bugfix');
  });
});
