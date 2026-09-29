// An approved /verify correction must not be rewritten by a model pass — including one that
// was already in flight when the user approved it (re-review of dcc8f72, P2-1).
//
// verify-apply stamps optimized_at on every row it approves, and the passes that rewrite
// title/narrative with model output (re-enrich narrow/wide, cluster-merge) select only rows
// with optimized_at NULL. But they select, then wait on a model call of up to
// BG_LLM_TIMEOUT_MS, then write — and the write re-checked liveness only. An edit approved
// inside that window was overwritten: narrow wrote the model's title/narrative over it, wide
// wrote back the PRE-edit narrative it had read before the call. The mocked model call below
// runs the approval inside that window.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));
vi.mock('../haiku-client.mjs', () => ({
  callModelJSONAsync: vi.fn(),
  BG_LLM_TIMEOUT_MS: 45000,
}));
import { callModelJSONAsync } from '../haiku-client.mjs';
import {
  parseProposals,
  planVerifyApply,
  runVerifyApply,
  undoVerifyBackup,
} from '../lib/verify-apply-core.mjs';

const P = 'test';
const LONG =
  'A concurrent-deduction race let two requests read the same balance and both deduct, double-spending; the fix serializes with SELECT ... FOR UPDATE row locking so the second waits.';
const APPROVED =
  'APPROVED: the double-spend was fixed in abc1234 by serialising deductions with row locking; the race no longer reproduces.';

let db;
let dir;
beforeEach(() => {
  db = createTestDb();
  insertSession(db, { id: 'sess-1', project: P });
  dir = mkdtempSync(join(tmpdir(), 'mem-verify-race-'));
  callModelJSONAsync.mockReset();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(over = {}) {
  return Number(
    insertObs(db, {
      type: 'bugfix',
      importance: 2,
      title: 'Race in balance deduction',
      narrative: LONG,
      ...over,
    }).lastInsertRowid,
  );
}

function approveWith(entry) {
  const { entries } = parseProposals([entry]);
  const { plan, errors } = planVerifyApply(db, entries, { project: P });
  expect(errors).toEqual([]);
  runVerifyApply(db, plan, { backupDir: dir });
}

function approveEdit(id) {
  const { entries } = parseProposals([
    { id, action: 'edit', verdict: 'STALE', set: { narrative: APPROVED }, evidence: 'abc1234' },
  ]);
  const { plan, errors } = planVerifyApply(db, entries, { project: P });
  expect(errors).toEqual([]);
  runVerifyApply(db, plan, { backupDir: dir });
}

describe('re-enrich does not overwrite an approval that landed during its model call', () => {
  it.each(['narrow', 'wide'])('%s', async (scope) => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    const id = seed();
    callModelJSONAsync.mockImplementation(async () => {
      approveEdit(id); // the user approves while the model is thinking
      return {
        type: 'bugfix',
        importance: 2,
        title: 'MODEL title',
        narrative: 'MODEL narrative',
        lesson_learned: 'MODEL lesson',
      };
    });
    const res = await executeReenrich(db, 10, { scope });
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1); // premise: the row WAS a candidate
    expect(res.processed).toBe(0);
    const row = db.prepare('SELECT title, narrative, lesson_learned FROM observations WHERE id = ?').get(id);
    expect(row).toEqual({ title: 'Race in balance deduction', narrative: APPROVED, lesson_learned: null });
  });

  it('narrow auto-hide (model says importance 0) does not hide a row approved during the call', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    const id = seed();
    callModelJSONAsync.mockImplementation(async () => {
      approveEdit(id);
      return { type: 'bugfix', importance: 0, title: 'MODEL title', narrative: 'MODEL narrative' };
    });
    await executeReenrich(db, 10, { scope: 'narrow' });
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1);
    const row = db
      .prepare('SELECT narrative, COALESCE(compressed_into, 0) AS c FROM observations WHERE id = ?')
      .get(id);
    expect(row).toEqual({ narrative: APPROVED, c: 0 });
  });

  it('and an approved row is not a candidate at all afterwards', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    const id = seed();
    expect(findReenrichCandidates(db, 10, { scope: 'narrow' }).map((c) => c.id)).toContain(id); // premise
    approveEdit(id);
    for (const scope of ['narrow', 'wide']) {
      expect(findReenrichCandidates(db, 10, { scope }).map((c) => c.id)).not.toContain(id);
    }
  });
});

describe('cluster-merge does not fold away an approval that landed during its model call', () => {
  it('aborts the merge and leaves both rows as they are', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    const a = seed();
    const b = seed({ title: 'Race in balance deduction (dup)', importance: 1 });
    const cluster = db
      .prepare(
        'SELECT id, title, narrative, project, type, access_count, importance, created_at_epoch, minhash_sig, lesson_learned, concepts, facts FROM observations WHERE id IN (?, ?)',
      )
      .all(a, b);
    callModelJSONAsync.mockImplementation(async () => {
      approveEdit(a);
      return {
        should_merge: true,
        merged_title: 'MODEL merged title',
        merged_narrative: 'MODEL merged narrative',
        merged_concepts: [],
        merged_facts: [],
        merged_lesson: null,
        importance: 2,
      };
    });
    const res = await executeMergeCluster(db, cluster);
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1);
    expect(res.merged).toBe(false);
    const rows = db
      .prepare(
        'SELECT id, narrative, COALESCE(compressed_into, 0) AS compressed_into, superseded_at FROM observations WHERE id IN (?, ?) ORDER BY id',
      )
      .all(a, b);
    expect(rows).toEqual([
      { id: a, narrative: APPROVED, compressed_into: 0, superseded_at: null },
      { id: b, narrative: LONG, compressed_into: 0, superseded_at: null },
    ]);
  });
});

// Pre-ship review of 9786874: the passes above were covered, and four more model passes were
// not. The concepts and aliases backfills are deliberately NOT gated on optimized_at (see
// findReenrichCandidates), so they still reach an approved row: the concepts pass replaced a
// replacement's approved facts with model facts, and both passes wrote back a `text` they had
// read before their model call. Smart-compress hid a row approved during its call, behind a
// summary built from the pre-approval text.
describe('backfills and smart-compress do not undo an approval', () => {
  it('the concepts backfill adds concepts to an approved replacement but leaves its facts alone', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    const id = seed();
    const { entries } = parseProposals([
      {
        id,
        action: 'replace',
        verdict: 'STALE',
        narrative: APPROVED,
        facts: 'USERFACT bounded',
        evidence: 'x',
      },
    ]);
    const { plan } = planVerifyApply(db, entries, { project: P });
    const newId = runVerifyApply(db, plan, { backupDir: dir }).results[0].newId;
    callModelJSONAsync.mockImplementation(async () => ({
      concepts: ['locking'],
      facts: ['MODELFACT unbounded'],
    }));
    await executeReenrich(db, 10, { scope: 'concepts' });
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1); // premise: the replacement WAS a candidate
    const row = db.prepare('SELECT facts, concepts, text FROM observations WHERE id = ?').get(newId);
    expect(row.concepts).toBe('locking');
    expect(row.facts).toBe('USERFACT bounded');
    expect(row.text).not.toContain('MODELFACT');
  });

  it('control: a row nobody approved still gets the model facts', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    const id = seed();
    callModelJSONAsync.mockImplementation(async () => ({
      concepts: ['locking'],
      facts: ['MODELFACT unbounded'],
    }));
    await executeReenrich(db, 10, { scope: 'concepts' });
    expect(db.prepare('SELECT facts FROM observations WHERE id = ?').get(id).facts).toBe(
      'MODELFACT unbounded',
    );
  });

  it.each([
    ['concepts', { concepts: ['locking'], facts: ['MODELFACT from the stale text'] }],
    ['aliases', { search_aliases: ['stalealias'] }],
    ['scopes', { scope: 'environment' }],
  ])('the %s backfill skips a row approved during its model call', async (scope, answer) => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    const id = seed();
    let approvedRow = null;
    callModelJSONAsync.mockImplementation(async () => {
      approveEdit(id);
      approvedRow = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
      return answer;
    });
    const res = await executeReenrich(db, 10, { scope });
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1);
    expect(approvedRow.narrative).toBe(APPROVED); // premise: the approval landed mid-call
    expect(res.processed).toBe(0);
    expect(db.prepare('SELECT * FROM observations WHERE id = ?').get(id)).toEqual(approvedRow);
  });

  // Delta review of the first repair (74a54ec): an edit stamps the row it approves, but a retire or a replace
  // supersedes the original without stamping it, so a stamp check alone saw neither.
  const approve = {
    edit: (id) => approveEdit(id),
    retire: (id) => approveWith({ id, action: 'retire', verdict: 'STALE', evidence: 'x' }),
    replace: (id) =>
      approveWith({ id, action: 'replace', verdict: 'STALE', narrative: APPROVED, evidence: 'x' }),
  };

  it.each(['retire', 'replace'])(
    'the scopes backfill writes nothing on a row approved (%s) during its model call, so --undo still works',
    async (action) => {
      // Neither action changes the original's text or stamp; only the live guard stops the
      // write, and without it the undo of that approval is refused on `scope`.
      const { executeReenrich } = await import('../hook-optimize.mjs');
      const id = seed();
      let backup = null;
      callModelJSONAsync.mockImplementation(async () => {
        const entry =
          action === 'retire'
            ? { id, action, verdict: 'STALE', evidence: 'x' }
            : { id, action, verdict: 'STALE', narrative: APPROVED, evidence: 'x' };
        const { plan } = planVerifyApply(db, parseProposals([entry]).entries, { project: P });
        backup = JSON.parse(readFileSync(runVerifyApply(db, plan, { backupDir: dir }).backupPath, 'utf8'));
        return { scope: 'environment' };
      });
      const res = await executeReenrich(db, 10, { scope: 'scopes' });
      expect(callModelJSONAsync).toHaveBeenCalledTimes(1);
      expect(res.processed).toBe(0);
      expect(db.prepare('SELECT scope FROM observations WHERE id = ?').get(id).scope).toBeNull();
      expect(undoVerifyBackup(db, backup).errors).toEqual([]);
    },
  );

  it.each(['edit', 'retire', 'replace'])(
    'smart-compress lands no summary when a member is approved (%s) during its model call',
    async (action) => {
      const { executeSmartCompress } = await import('../hook-optimize.mjs');
      const DAY = 86400000;
      const ids = [0, 1, 2].map((i) =>
        seed({ importance: 1, title: `Race in balance deduction ${i}`, epochOffset: -40 * DAY + i * 1000 }),
      );
      let maxAfterApproval = null;
      callModelJSONAsync.mockImplementation(async () => {
        approve[action](ids[0]);
        maxAfterApproval = db.prepare('SELECT MAX(id) AS m FROM observations').get().m;
        return {
          should_compress: true,
          title: 'MODEL summary',
          narrative: 'MODEL summary of the stale text',
        };
      });
      const res = await executeSmartCompress(db, 5, {});
      expect(callModelJSONAsync).toHaveBeenCalledTimes(1); // premise: the three rows formed a cluster
      expect(res.compressed).toBe(0);
      const rows = db
        .prepare('SELECT id, COALESCE(compressed_into, 0) AS c FROM observations WHERE id IN (?, ?, ?)')
        .all(...ids);
      expect(rows.map((r) => r.c)).toEqual([0, 0, 0]);
      expect(db.prepare('SELECT MAX(id) AS m FROM observations').get().m).toBe(maxAfterApproval); // no summary
    },
  );

  it.each(['retire', 'replace'])(
    'cluster-merge does not fold in a member approved (%s) during its model call',
    async (action) => {
      const { executeMergeCluster } = await import('../hook-optimize.mjs');
      const a = seed();
      const b = seed({ title: 'Race in balance deduction (dup)', importance: 1 });
      const cluster = db
        .prepare(
          'SELECT id, title, narrative, project, type, access_count, importance, created_at_epoch, minhash_sig, lesson_learned, concepts, facts FROM observations WHERE id IN (?, ?)',
        )
        .all(a, b);
      callModelJSONAsync.mockImplementation(async () => {
        approve[action](b);
        return {
          should_merge: true,
          merged_title: 'MODEL merged title',
          merged_narrative: 'MODEL merged narrative with the stale claim of b',
          merged_concepts: [],
          merged_facts: [],
          merged_lesson: null,
          importance: 2,
        };
      });
      const res = await executeMergeCluster(db, cluster);
      expect(callModelJSONAsync).toHaveBeenCalledTimes(1);
      expect(res.merged).toBe(false);
      expect(db.prepare('SELECT title, narrative FROM observations WHERE id = ?').get(a)).toEqual({
        title: 'Race in balance deduction',
        narrative: LONG,
      });
    },
  );
});
