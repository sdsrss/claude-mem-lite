// P1 (D#78): per-(obs,file) edge attribution for pre-tool-recall injections.
//
// citation_log / applyCitationDecay are per-obs GLOBAL policies; this is a
// SEPARATE per-edge policy (#8641: don't unify counters that encode different
// policies). An edge = one observation_files row; when pre-tool-recall injects
// obs #N because file F matched, the Stop handler resolves that edge as
// hit (cited) or miss (uncited). P2 uses miss_streak to stop firing noisy
// edges while the lesson body stays alive for every other surface.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { resolveEdgeAttribution, readPreRecallFileEdges } from '../lib/edge-attribution.mjs';

const EDGE_COLS = 'inject_count, miss_streak, last_resolved_session_id, last_cited_session_id';

function edgeRow(db, obsId, filename) {
  return db
    .prepare(`SELECT ${EDGE_COLS} FROM observation_files WHERE obs_id = ? AND filename = ?`)
    .get(obsId, filename);
}

describe('edge-attribution schema (v43)', () => {
  it('fresh initSchema creates observation_files with the 4 edge columns', () => {
    const db = createTestDb();
    const cols = db
      .prepare(`SELECT name FROM pragma_table_info('observation_files')`)
      .all()
      .map((r) => r.name);
    expect(cols).toContain('inject_count');
    expect(cols).toContain('miss_streak');
    expect(cols).toContain('last_resolved_session_id');
    expect(cols).toContain('last_cited_session_id');
    db.close();
  });

  it('columns default to 0 / NULL on plain inserts (existing write paths unaffected)', () => {
    const db = createTestDb();
    insertSession(db, { id: 's1', project: 'p' });
    const r = insertObs(db, {
      sessionId: 's1',
      project: 'p',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'L',
      filesModified: '["a.mjs"]',
    });
    const row = edgeRow(db, Number(r.lastInsertRowid), 'a.mjs');
    expect(row.inject_count).toBe(0);
    expect(row.miss_streak).toBe(0);
    expect(row.last_resolved_session_id).toBeNull();
    expect(row.last_cited_session_id).toBeNull();
    db.close();
  });
});

describe('resolveEdgeAttribution', () => {
  let db;
  const PROJECT = 'parent--edgetest';

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'seed', project: PROJECT });
  });
  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  function seed(filesModified, project = PROJECT) {
    const r = insertObs(db, {
      sessionId: 'seed',
      project,
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'edge lesson',
      filesModified: JSON.stringify(filesModified),
    });
    return Number(r.lastInsertRowid);
  }

  it('uncited injection increments miss_streak + inject_count on the matched edge', () => {
    const obsId = seed(['utils.mjs']);
    const r = resolveEdgeAttribution(
      db,
      PROJECT,
      [{ filePath: '/proj/utils.mjs', obsIds: [obsId] }],
      new Set(),
      'sessA',
    );
    expect(r.misses).toBe(1);
    const row = edgeRow(db, obsId, 'utils.mjs');
    expect(row.miss_streak).toBe(1);
    expect(row.inject_count).toBe(1);
    expect(row.last_resolved_session_id).toBe('sessA');
  });

  it('cited injection records hit: miss_streak stays 0, last_cited stamped', () => {
    const obsId = seed(['utils.mjs']);
    const r = resolveEdgeAttribution(
      db,
      PROJECT,
      [{ filePath: '/proj/utils.mjs', obsIds: [obsId] }],
      new Set([obsId]),
      'sessA',
    );
    expect(r.hits).toBe(1);
    const row = edgeRow(db, obsId, 'utils.mjs');
    expect(row.miss_streak).toBe(0);
    expect(row.inject_count).toBe(1);
    expect(row.last_cited_session_id).toBe('sessA');
  });

  it('is idempotent within a session (Stop multi-fire does not double-count)', () => {
    const obsId = seed(['utils.mjs']);
    const edges = [{ filePath: '/proj/utils.mjs', obsIds: [obsId] }];
    resolveEdgeAttribution(db, PROJECT, edges, new Set(), 'sessA');
    resolveEdgeAttribution(db, PROJECT, edges, new Set(), 'sessA');
    const row = edgeRow(db, obsId, 'utils.mjs');
    expect(row.miss_streak).toBe(1);
    expect(row.inject_count).toBe(1);
  });

  it('cross-turn late citation undoes the same-session miss (streak back to 0, no recount)', () => {
    const obsId = seed(['utils.mjs']);
    const edges = [{ filePath: '/proj/utils.mjs', obsIds: [obsId] }];
    resolveEdgeAttribution(db, PROJECT, edges, new Set(), 'sessA'); // turn 1: miss
    resolveEdgeAttribution(db, PROJECT, edges, new Set([obsId]), 'sessA'); // turn 2: late cite
    const row = edgeRow(db, obsId, 'utils.mjs');
    expect(row.miss_streak).toBe(0);
    expect(row.inject_count).toBe(1);
    expect(row.last_cited_session_id).toBe('sessA');
  });

  it('miss streak accumulates across sessions; a hit resets it', () => {
    const obsId = seed(['utils.mjs']);
    const edges = [{ filePath: '/proj/utils.mjs', obsIds: [obsId] }];
    resolveEdgeAttribution(db, PROJECT, edges, new Set(), 'sessA');
    resolveEdgeAttribution(db, PROJECT, edges, new Set(), 'sessB');
    expect(edgeRow(db, obsId, 'utils.mjs').miss_streak).toBe(2);
    resolveEdgeAttribution(db, PROJECT, edges, new Set([obsId]), 'sessC');
    const row = edgeRow(db, obsId, 'utils.mjs');
    expect(row.miss_streak).toBe(0);
    expect(row.inject_count).toBe(3);
  });

  it('matches edges stored as relative path via the /basename boundary', () => {
    const obsId = seed(['scripts/utils.mjs']);
    resolveEdgeAttribution(
      db,
      PROJECT,
      [{ filePath: '/proj/scripts/utils.mjs', obsIds: [obsId] }],
      new Set(),
      'sessA',
    );
    expect(edgeRow(db, obsId, 'scripts/utils.mjs').miss_streak).toBe(1);
  });

  it('matches a case-variant stored basename (parity with the NOCASE trigger arms)', () => {
    const obsId = seed(['Utils.mjs']);
    resolveEdgeAttribution(
      db,
      PROJECT,
      [{ filePath: '/proj/utils.mjs', obsIds: [obsId] }],
      new Set(),
      'sessA',
    );
    expect(edgeRow(db, obsId, 'Utils.mjs').miss_streak).toBe(1);
  });

  // Review D#78: the cooldown file has no sidechain marker, so subagent-
  // triggered injections land in it too. With mainInjectedIds given, an obs
  // the main thread never saw injected (and never cited) must not accrue a
  // miss it can never repay; a cited obs is still credited.
  it('mainInjectedIds gate: skips obs absent from the main-thread injected set', () => {
    const obsId = seed(['utils.mjs']);
    const r = resolveEdgeAttribution(
      db,
      PROJECT,
      [{ filePath: '/proj/utils.mjs', obsIds: [obsId] }],
      new Set(),
      'sessA',
      { mainInjectedIds: new Set([999999]) },
    );
    expect(r).toEqual({ hits: 0, misses: 0, touchedEdges: 0 });
    expect(edgeRow(db, obsId, 'utils.mjs').miss_streak).toBe(0);
  });

  it('mainInjectedIds gate: cited obs is credited even when outside the injected set', () => {
    const obsId = seed(['utils.mjs']);
    const r = resolveEdgeAttribution(
      db,
      PROJECT,
      [{ filePath: '/proj/utils.mjs', obsIds: [obsId] }],
      new Set([obsId]),
      'sessA',
      { mainInjectedIds: new Set() },
    );
    expect(r.hits).toBe(1);
    expect(edgeRow(db, obsId, 'utils.mjs').last_cited_session_id).toBe('sessA');
  });

  it('does NOT touch a different-basename suffix edge (bash-utils.mjs vs utils.mjs)', () => {
    const obsId = seed(['bash-utils.mjs']);
    resolveEdgeAttribution(
      db,
      PROJECT,
      [{ filePath: '/proj/utils.mjs', obsIds: [obsId] }],
      new Set(),
      'sessA',
    );
    const row = edgeRow(db, obsId, 'bash-utils.mjs');
    expect(row.miss_streak).toBe(0);
    expect(row.inject_count).toBe(0);
  });

  it('ignores obs belonging to another project', () => {
    insertSession(db, { id: 'seed-other', project: 'other--proj' });
    const r = insertObs(db, {
      sessionId: 'seed-other',
      project: 'other--proj',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'foreign',
      filesModified: '["utils.mjs"]',
    });
    const obsId = Number(r.lastInsertRowid);
    const res = resolveEdgeAttribution(
      db,
      PROJECT,
      [{ filePath: '/proj/utils.mjs', obsIds: [obsId] }],
      new Set(),
      'sessA',
    );
    expect(res.misses).toBe(0);
    expect(edgeRow(db, obsId, 'utils.mjs').miss_streak).toBe(0);
  });

  it('returns zeros and writes nothing under MEM_DISABLE_CITATION_DECAY=1', () => {
    const obsId = seed(['utils.mjs']);
    process.env.MEM_DISABLE_CITATION_DECAY = '1';
    try {
      const r = resolveEdgeAttribution(
        db,
        PROJECT,
        [{ filePath: '/proj/utils.mjs', obsIds: [obsId] }],
        new Set(),
        'sessA',
      );
      expect(r).toEqual({ hits: 0, misses: 0, touchedEdges: 0 });
      expect(edgeRow(db, obsId, 'utils.mjs').inject_count).toBe(0);
    } finally {
      delete process.env.MEM_DISABLE_CITATION_DECAY;
    }
  });
});

describe('readPreRecallFileEdges', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'edge-cooldown-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  function writeCooldown(sessionId, data) {
    mkdirSync(tmp, { recursive: true });
    const safe = String(sessionId)
      .replace(/[^a-zA-Z0-9_.-]/g, '-')
      .slice(0, 64);
    writeFileSync(join(tmp, `pre-recall-cooldown-${safe}.json`), JSON.stringify(data));
  }

  it('returns filePath→obsIds pairs for entries carrying obsIds', () => {
    writeCooldown('sess-1', {
      '/proj/a.mjs': { ts: 1, lessonIds: [7, 900], obsIds: [7], mode: 'edit' },
      '/proj/b.mjs': { ts: 2, lessonIds: [], obsIds: [], mode: 'read' },
      '/proj/c.mjs': 12345, // legacy bare-number entry
    });
    const edges = readPreRecallFileEdges(tmp, 'sess-1');
    expect(edges).toEqual([{ filePath: '/proj/a.mjs', obsIds: [7] }]);
  });

  it('returns [] on missing session id or absent cooldown file', () => {
    expect(readPreRecallFileEdges(tmp, null)).toEqual([]);
    expect(readPreRecallFileEdges(tmp, 'no-such-session')).toEqual([]);
  });

  it('returns [] on corrupt JSON', () => {
    writeFileSync(join(tmp, 'pre-recall-cooldown-bad.json'), 'not json');
    expect(readPreRecallFileEdges(tmp, 'bad')).toEqual([]);
  });
});
