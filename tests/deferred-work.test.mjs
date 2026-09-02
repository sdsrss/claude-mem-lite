import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { createTestDb } from './test-helpers.mjs';
import {
  insertDeferred, listOpenWithOrdinal, dropDeferred,
  resolveDeferredIds, closeDeferredItems,
} from '../lib/deferred-work.mjs';

describe('deferred_work schema (v31)', () => {
  it('creates deferred_work table with required columns', () => {
    const db = createTestDb();
    const cols = db.prepare(`PRAGMA table_info(deferred_work)`).all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'project', 'title', 'detail', 'priority', 'status',
      'created_at_epoch', 'closed_at_epoch', 'closed_by_obs_id',
      'drop_reason', 'source_session_id', 'source_prompt_id', 'files',
    ]));
    db.close();
  });

  it('creates partial index on open items', () => {
    const db = createTestDb();
    const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_deferred_open'`).get();
    expect(idx).toBeTruthy();
    expect(idx.sql).toMatch(/WHERE\s+status\s*=\s*'open'/i);
    db.close();
  });
});

describe('deferred_work CRUD', () => {
  it('insertDeferred returns id and inserts open row', () => {
    const db = createTestDb();
    const r = insertDeferred(db, {
      project: 'proj-a',
      title: 'Round 2 zero-byte index.db',
      priority: 3,
      detail: 'exit code 不稳定',
    });
    expect(r.id).toBeGreaterThan(0);
    const row = db.prepare(`SELECT * FROM deferred_work WHERE id=?`).get(r.id);
    expect(row.status).toBe('open');
    expect(row.title).toBe('Round 2 zero-byte index.db');
    expect(row.priority).toBe(3);
    db.close();
  });

  it('listOpenWithOrdinal returns priority DESC, created_at ASC with sequential ordinal', () => {
    const db = createTestDb();
    const _a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    const b = insertDeferred(db, { project: 'p', title: 'B', priority: 3 });
    const _c = insertDeferred(db, { project: 'p', title: 'C', priority: 2 });
    const list = listOpenWithOrdinal(db, 'p');
    expect(list.map(r => r.title)).toEqual(['B', 'A', 'C']);
    expect(list.map(r => r.ordinal)).toEqual([1, 2, 3]);
    expect(list.find(r => r.title === 'B').id).toBe(b.id);
    db.close();
  });

  it('listOpenWithOrdinal filters by project', () => {
    const db = createTestDb();
    insertDeferred(db, { project: 'p1', title: 'A', priority: 2 });
    insertDeferred(db, { project: 'p2', title: 'B', priority: 2 });
    expect(listOpenWithOrdinal(db, 'p1').map(r => r.title)).toEqual(['A']);
    expect(listOpenWithOrdinal(db, 'p2').map(r => r.title)).toEqual(['B']);
    db.close();
  });

  it('listOpenWithOrdinal excludes done and dropped', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    const b = insertDeferred(db, { project: 'p', title: 'B', priority: 2 });
    db.prepare(`UPDATE deferred_work SET status='done' WHERE id=?`).run(a.id);
    db.prepare(`UPDATE deferred_work SET status='dropped' WHERE id=?`).run(b.id);
    expect(listOpenWithOrdinal(db, 'p')).toEqual([]);
    db.close();
  });

  it('listOpenWithOrdinal recomputes ordinal after close', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    insertDeferred(db, { project: 'p', title: 'B', priority: 2 });
    insertDeferred(db, { project: 'p', title: 'C', priority: 2 });
    db.prepare(`UPDATE deferred_work SET status='done' WHERE id=?`).run(a.id);
    const list = listOpenWithOrdinal(db, 'p');
    expect(list.map(r => r.title)).toEqual(['B', 'C']);
    expect(list.map(r => r.ordinal)).toEqual([1, 2]);
    db.close();
  });

  it('dropDeferred sets status=dropped with reason and refuses non-open', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    const r = dropDeferred(db, a.id, 'no longer relevant');
    expect(r.changed).toBe(1);
    const row = db.prepare(`SELECT * FROM deferred_work WHERE id=?`).get(a.id);
    expect(row.status).toBe('dropped');
    expect(row.drop_reason).toBe('no longer relevant');
    expect(row.closed_at_epoch).toBeGreaterThan(0);
    // second drop should be no-op (status no longer 'open')
    const r2 = dropDeferred(db, a.id, 'again');
    expect(r2.changed).toBe(0);
    db.close();
  });

  // D#195 (c): the mis-drop is cheap to prevent at the moment it happens. The
  // hint is advisory text only — drop still succeeds, so a false positive costs
  // one line of output and never blocks.
  it('formatDropReasonHint fires on fixed-shaped reasons and stays quiet otherwise', () => {
    const fires = ['已在 v3.86.0 修复', 'fixed in this round', 'implemented', 'shipped in v3.9',
      'done — closed by the batch', 'resolved upstream',
      // The REAL reason on the six v3.86.0 mis-drops that motivated this hint.
      // An earlier draft of the pattern missed exactly this string.
      'closed this round; fix + mutation-verified binding test landed'];
    for (const r of fires) {
      expect(dw.formatDropReasonHint(r), `expected a hint for: ${r}`).toMatch(/closes-deferred/);
    }
    const quiet = ['no longer relevant', 'superseded by D#42', 'refuted by measurement',
      'obsolete', 'out of scope', '',
      // The negative CJK senses must NOT fire — they say the opposite.
      '等待上游修复', '尚未修复', '需修复但优先级太低',
      // Widening the positive arm to `closed` made these reachable; the veto
      // has to hold them back or the hint fires on ordinary rejections.
      'closed as obsolete', 'closed — superseded by D#42', 'waiting for an upstream fix'];
    for (const r of quiet) {
      expect(dw.formatDropReasonHint(r), `expected NO hint for: ${r}`).toBeNull();
    }
  });

  it('dropDeferred requires non-empty reason', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    expect(() => dropDeferred(db, a.id, '')).toThrow(/reason/i);
    expect(() => dropDeferred(db, a.id, '   ')).toThrow(/reason/i);
    db.close();
  });
});

describe('deferred_work closure', () => {
  it('resolveDeferredIds maps ordinal int → real id within project', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    const b = insertDeferred(db, { project: 'p', title: 'B', priority: 3 });
    // Ordinal 1 should be B (priority 3 wins). Ordinal 2 should be A.
    expect(resolveDeferredIds(db, 'p', [1, 2])).toEqual([b.id, a.id]);
    db.close();
  });

  it('resolveDeferredIds maps "D#N" string → raw id (project-scoped)', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    expect(resolveDeferredIds(db, 'p', [`D#${a.id}`])).toEqual([a.id]);
    db.close();
  });

  it('resolveDeferredIds rejects unknown string shape', () => {
    const db = createTestDb();
    expect(() => resolveDeferredIds(db, 'p', ['#42'])).toThrow(/D#N or integer ordinal/);
    expect(() => resolveDeferredIds(db, 'p', ['foo'])).toThrow(/D#N or integer ordinal/);
    db.close();
  });

  it('resolveDeferredIds rejects ordinal out of range', () => {
    const db = createTestDb();
    insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    expect(() => resolveDeferredIds(db, 'p', [5])).toThrow(/ordinal 5/);
    db.close();
  });

  it('resolveDeferredIds rejects D#N from foreign project', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p1', title: 'A', priority: 2 });
    expect(() => resolveDeferredIds(db, 'p2', [`D#${a.id}`])).toThrow(
      new RegExp(`D#${a.id}.*project.*p1`)
    );
    db.close();
  });

  // Was named "rejects done/dropped items" while only exercising 'done'. Split,
  // because D#195 makes the two statuses behave DIFFERENTLY under the close verb.
  it('resolveDeferredIds rejects done items', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    db.prepare(`UPDATE deferred_work SET status='done' WHERE id=?`).run(a.id);
    expect(() => resolveDeferredIds(db, 'p', [`D#${a.id}`])).toThrow(/status.*done/);
    // 'done' stays rejected even under the permissive close policy — re-closing an
    // already-closed item would overwrite a real closed_by_obs_id link.
    expect(() => resolveDeferredIds(db, 'p', [`D#${a.id}`], { allowStatuses: ['open', 'dropped'] }))
      .toThrow(/status.*done/);
    db.close();
  });

  it('resolveDeferredIds rejects dropped items BY DEFAULT (drop verb keeps open-only)', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    dropDeferred(db, a.id, 'dropped by mistake');
    expect(() => resolveDeferredIds(db, 'p', [`D#${a.id}`])).toThrow(/status.*dropped/);
    db.close();
  });

  // D#195: `defer drop` used on an item that was actually FIXED was a one-way
  // gate — the row became indistinguishable from a genuinely rejected item and
  // lost the closed_by_obs_id link that the repo's convention relies on. The
  // real invariant is "a fixed item must carry an obs link", not "dropped is
  // immutable", so the close verb may re-open a dropped row into 'done'.
  it('resolveDeferredIds accepts a dropped item under the close policy (D#195)', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    dropDeferred(db, a.id, 'dropped by mistake');
    expect(resolveDeferredIds(db, 'p', [`D#${a.id}`], { allowStatuses: ['open', 'dropped'] }))
      .toEqual([a.id]);
    db.close();
  });

  it('closeDeferredItems converts a dropped row to done and attaches the obs link (D#195)', () => {
    const db = createTestDb();
    db.pragma('foreign_keys = OFF'); // see note in atomicity test below
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    dropDeferred(db, a.id, 'dropped by mistake');
    closeDeferredItems(db, [a.id], 4242);
    const ra = db.prepare(`SELECT * FROM deferred_work WHERE id=?`).get(a.id);
    expect(ra.status).toBe('done');
    expect(ra.closed_by_obs_id).toBe(4242);
    // The drop reason is KEPT, not erased — the row's history is what makes the
    // mis-drop auditable afterwards.
    expect(ra.drop_reason).toBe('dropped by mistake');
    db.close();
  });

  it('closeDeferredItems still refuses a done row (no silent obs-link overwrite)', () => {
    const db = createTestDb();
    db.pragma('foreign_keys = OFF');
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    closeDeferredItems(db, [a.id], 111);
    expect(() => closeDeferredItems(db, [a.id], 222)).toThrow(/not in a closable status/);
    expect(db.prepare(`SELECT closed_by_obs_id FROM deferred_work WHERE id=?`).get(a.id).closed_by_obs_id).toBe(111);
    db.close();
  });

  it('formatDeferredDetail surfaces the prior drop reason on a re-closed row (D#195)', () => {
    const db = createTestDb();
    db.pragma('foreign_keys = OFF');
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    dropDeferred(db, a.id, 'dropped by mistake');
    closeDeferredItems(db, [a.id], 4242);
    const [row] = dw.getDeferredByIds(db, [a.id]);
    const out = dw.formatDeferredDetail(row);
    expect(out).toContain('closed_by: #4242');
    expect(out).toContain('previously_dropped: dropped by mistake');
    db.close();
  });

  it('closeDeferredItems updates status + closed_by_obs_id atomically', () => {
    const db = createTestDb();
    // initSchema enables FKs at end of migration; disable here so we can pass
    // a fabricated obs id without setting up an observations row. The unit
    // under test is the UPDATE semantics, not FK enforcement.
    db.pragma('foreign_keys = OFF');
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    const b = insertDeferred(db, { project: 'p', title: 'B', priority: 2 });
    closeDeferredItems(db, [a.id, b.id], 999);
    const ra = db.prepare(`SELECT * FROM deferred_work WHERE id=?`).get(a.id);
    const rb = db.prepare(`SELECT * FROM deferred_work WHERE id=?`).get(b.id);
    expect(ra.status).toBe('done');
    expect(ra.closed_by_obs_id).toBe(999);
    expect(ra.closed_at_epoch).toBeGreaterThan(0);
    expect(rb.status).toBe('done');
    db.close();
  });

  // CLASS-LEVEL SWEEP, not a per-face test. This repo's recurring defect is
  // "the copy I fixed was not the only copy" — a guard wired on the CLI face
  // while the MCP twin keeps the old policy passes every per-face test. So:
  // find EVERY closeDeferredItems() call site in the shipped faces and require
  // the resolveDeferredIds() immediately above it to carry the close policy.
  // Reverting either face turns this red.
  it('SWEEP: every close-verb call site passes the dropped-allowing policy (D#195)', () => {
    const faces = ['mem-cli.mjs', 'server.mjs'];
    const offenders = [];
    let sites = 0;
    for (const face of faces) {
      const src = readFileSync(new URL(`../${face}`, import.meta.url), 'utf8');
      // Call sites only — skip the import statement, which also names the symbol.
      const re = /closeDeferredItems\(/g;
      for (const m of src.matchAll(re)) {
        sites++;
        const window = src.slice(Math.max(0, m.index - 500), m.index);
        const resolved = window.lastIndexOf('resolveDeferredIds(');
        if (resolved === -1) { offenders.push(`${face}: no resolveDeferredIds above call at ${m.index}`); continue; }
        if (!window.slice(resolved).includes('allowStatuses')) {
          offenders.push(`${face}: close call at ${m.index} resolves with the default open-only policy`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Denominator guard: if a face stops calling closeDeferredItems the sweep
    // above passes vacuously, which is the shape that lets a face go dark.
    expect(sites).toBe(2);
  });

  // Same sweep for the OTHER half of D#195. The CLI drop face has a behavioural
  // E2E in cli-defer.test.mjs; the MCP one does not (it needs real stdio), so
  // this is the only thing standing between the MCP twin and a silent revert.
  it('SWEEP: every drop-verb face consults formatDropReasonHint (D#195)', () => {
    const faces = ['mem-cli.mjs', 'server.mjs'];
    const missing = [];
    for (const face of faces) {
      const src = readFileSync(new URL(`../${face}`, import.meta.url), 'utf8');
      const drops = [...src.matchAll(/dropDeferred\(/g)].length;
      const hints = [...src.matchAll(/formatDropReasonHint\(/g)].length;
      if (drops === 0) missing.push(`${face}: no dropDeferred call site — sweep would pass vacuously`);
      else if (hints === 0) missing.push(`${face}: drops without consulting formatDropReasonHint`);
    }
    expect(missing).toEqual([]);
  });

  it('closeDeferredItems rolls back when one id is invalid', () => {
    const db = createTestDb();
    db.pragma('foreign_keys = OFF'); // see note in atomicity test above
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    // 999 is a non-existent deferred id
    expect(() => closeDeferredItems(db, [a.id, 999], 1234)).toThrow();
    const ra = db.prepare(`SELECT status FROM deferred_work WHERE id=?`).get(a.id);
    expect(ra.status).toBe('open'); // unchanged
    db.close();
  });

  it('resolveDeferredIds rejects duplicate tokens that resolve to the same id', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'A', priority: 2 });
    // ordinal 1 and "D#<a.id>" both resolve to a.id — must reject as duplicate.
    expect(() => resolveDeferredIds(db, 'p', [1, `D#${a.id}`])).toThrow(/duplicate.*id/i);
    // also bare-int duplicate
    expect(() => resolveDeferredIds(db, 'p', [1, 1])).toThrow(/duplicate.*id/i);
    db.close();
  });
});

// ─── D# read surface (get D#N) — RED-first for the deferred-detail gap ───────
// Motivation (2026-07-18): D#92 detail held the design-doc pointer, but every
// surface (defer list / mem_defer_list / dashboard) rendered title-only and no
// `get D#N` existed — a write-only field. These lock the data-layer half.
import * as dw from '../lib/deferred-work.mjs';

describe('getDeferredByIds + formatDeferredDetail (D# read surface)', () => {
  it('getDeferredByIds returns full rows incl detail/files for any status, input order, missing omitted', () => {
    const db = createTestDb();
    const a = insertDeferred(db, {
      project: 'p', title: 'env precheck design', priority: 2,
      detail: 'design doc: docs/specs/env-precheck.md\nexit codes 0/5/6',
      files: ['scripts/osn_precheck.py'],
    });
    const b = insertDeferred(db, { project: 'p', title: 'other item', priority: 1 });
    dropDeferred(db, b.id, 'obsolete');
    expect(typeof dw.getDeferredByIds).toBe('function');
    const rows = dw.getDeferredByIds(db, [a.id, b.id, 99999]);
    expect(rows.map(r => r.id)).toEqual([a.id, b.id]);
    expect(rows[0].detail).toContain('exit codes 0/5/6');
    expect(JSON.parse(rows[0].files)).toEqual(['scripts/osn_precheck.py']);
    expect(rows[1].status).toBe('dropped');
    db.close();
  });

  it('formatDeferredDetail renders FULL untruncated detail + status + priority', () => {
    const db = createTestDb();
    const longDetail = 'design pointer: docs/specs/env-precheck-design.md — ' + 'x'.repeat(400);
    const a = insertDeferred(db, { project: 'p', title: 'env precheck step', detail: longDetail, priority: 2 });
    const rows = dw.getDeferredByIds(db, [a.id]);
    expect(typeof dw.formatDeferredDetail).toBe('function');
    const text = dw.formatDeferredDetail(rows[0]);
    expect(text).toContain(`D#${a.id}`);
    expect(text).toContain('env precheck step');
    // The whole point of this surface: detail must NOT be truncated.
    expect(text).toContain(longDetail);
    expect(text).toMatch(/open/);
    expect(text).toMatch(/P2/);
    db.close();
  });

  it('formatDeferredDetail on a detail-less row degrades gracefully', () => {
    const db = createTestDb();
    const a = insertDeferred(db, { project: 'p', title: 'bare item', priority: 3 });
    const text = dw.formatDeferredDetail(dw.getDeferredByIds(db, [a.id])[0]);
    expect(text).toContain('bare item');
    expect(text).not.toMatch(/undefined|null/);
    db.close();
  });
});

// ─── P2: searchDeferredWork — deferred items reachable from search ───────────
// The D#92 failure's last gap: keyword searches ("环境自检") surfaced obs/prompts
// but never the deferred row that held the answer. Matching is JS-substring
// (no SQL LIKE → wildcard injection is structurally impossible), open-only for
// keywords, any-status for explicit D#N refs, project-scoped, capped.
describe('searchDeferredWork (P2 search leg)', () => {
  function seed(db) {
    const a = insertDeferred(db, {
      project: 'p', title: '实施环境自检步（设计已定稿，待批准）', priority: 2,
      detail: '设计文档：docs/specs/env-precheck-design.md，exit codes 0/5/6',
    });
    const b = insertDeferred(db, { project: 'p', title: 'progress 50%_done marker', priority: 1, detail: 'literal wildcard chars' });
    const c = insertDeferred(db, { project: 'other', title: '环境自检 foreign twin', priority: 2 });
    return { a, b, c };
  }

  it('CJK substring match on title hits the open item', () => {
    const db = createTestDb();
    const { a } = seed(db);
    expect(typeof dw.searchDeferredWork).toBe('function');
    const rows = dw.searchDeferredWork(db, '环境自检', 'p');
    expect(rows.map(r => r.id)).toContain(a.id);
    db.close();
  });

  it('detail text is searchable too', () => {
    const db = createTestDb();
    const { a } = seed(db);
    const rows = dw.searchDeferredWork(db, 'env-precheck-design.md', 'p');
    expect(rows.map(r => r.id)).toContain(a.id);
    db.close();
  });

  it('multi-token query needs ceil(n/2) matches — one generic hit is excluded', () => {
    const db = createTestDb();
    seed(db);
    // 4 tokens, only "marker" appears in item b → 1/4 < need(2) → no hit
    const rows = dw.searchDeferredWork(db, 'totally unrelated ranking marker', 'p');
    expect(rows.length).toBe(0);
    db.close();
  });

  it('keyword match is open-only; explicit D#N ref reaches any status', () => {
    const db = createTestDb();
    const { a } = seed(db);
    dropDeferred(db, a.id, 'testing closed reachability');
    expect(dw.searchDeferredWork(db, '环境自检', 'p').map(r => r.id)).not.toContain(a.id);
    const byRef = dw.searchDeferredWork(db, `D#${a.id} 相关背景`, 'p');
    expect(byRef.map(r => r.id)).toContain(a.id);
    expect(byRef.find(r => r.id === a.id).status).toBe('dropped');
    db.close();
  });

  it('is project-scoped for both refs and keywords', () => {
    const db = createTestDb();
    const { c } = seed(db);
    expect(dw.searchDeferredWork(db, '环境自检', 'p').map(r => r.id)).not.toContain(c.id);
    expect(dw.searchDeferredWork(db, `D#${c.id}`, 'p').length).toBe(0);
    db.close();
  });

  it('treats %/_ as literal characters (no wildcard semantics)', () => {
    const db = createTestDb();
    const { a, b } = seed(db);
    const rows = dw.searchDeferredWork(db, '50%_done', 'p');
    expect(rows.map(r => r.id)).toEqual([b.id]);
    expect(rows.map(r => r.id)).not.toContain(a.id);
    db.close();
  });

  it('caps at the limit', () => {
    const db = createTestDb();
    for (let i = 0; i < 5; i++) {
      insertDeferred(db, { project: 'p', title: `shared keyword alpha item ${i}`, priority: 2 });
    }
    expect(dw.searchDeferredWork(db, 'alpha', 'p', { limit: 3 }).length).toBe(3);
    db.close();
  });
});

// ─── G11 (roadmap 2026-07-18): list age tag + >30d stale refresh hint ─────────

describe('defer list age + stale hint (G11)', () => {
  const DAY = 86_400_000;

  it('formatDeferListRow appends age in days to the id tag', () => {
    const db = createTestDb();
    const { id } = insertDeferred(db, { project: 'p', title: 'aged item', priority: 2 });
    db.prepare(`UPDATE deferred_work SET created_at_epoch = ? WHERE id = ?`)
      .run(Date.now() - 12 * DAY, id);
    const [row] = listOpenWithOrdinal(db, 'p');
    const line = dw.formatDeferListRow(row);
    expect(line).toContain(`(D#${id}, 12d)`);
    expect(line).toContain('🟡 [P2] aged item');
    expect(line).toMatch(/^1\. /);
    db.close();
  });

  it('formatDeferListRow shows 0d for a row created today', () => {
    const db = createTestDb();
    const { id } = insertDeferred(db, { project: 'p', title: 'fresh item', priority: 3 });
    const [row] = listOpenWithOrdinal(db, 'p');
    expect(dw.formatDeferListRow(row)).toContain(`(D#${id}, 0d)`);
    db.close();
  });

  it('countStaleOpen counts only open rows older than 30d in the project', () => {
    const db = createTestDb();
    const now = Date.now();
    const stale1 = insertDeferred(db, { project: 'p', title: 'stale open', priority: 1 });
    const stale2 = insertDeferred(db, { project: 'p', title: 'stale dropped', priority: 2 });
    const staleOther = insertDeferred(db, { project: 'q', title: 'stale other project', priority: 2 });
    insertDeferred(db, { project: 'p', title: 'fresh open', priority: 2 });
    for (const { id } of [stale1, stale2, staleOther]) {
      db.prepare(`UPDATE deferred_work SET created_at_epoch = ? WHERE id = ?`).run(now - 45 * DAY, id);
    }
    dropDeferred(db, stale2.id, 'closing for stale-count test');
    expect(dw.countStaleOpen(db, 'p')).toBe(1);
    expect(dw.countStaleOpen(db, 'q')).toBe(1);
    db.close();
  });

  it('countStaleOpen sees stale rows beyond the list LIMIT (P1 sink case)', () => {
    const db = createTestDb();
    const now = Date.now();
    // 3 fresh P3 rows fill a limit-3 list; the stale P1 row sorts last and is
    // cut from display — the hint must still count it.
    for (let i = 0; i < 3; i++) insertDeferred(db, { project: 'p', title: `fresh urgent ${i}`, priority: 3 });
    const sunk = insertDeferred(db, { project: 'p', title: 'sunk low-priority item', priority: 1 });
    db.prepare(`UPDATE deferred_work SET created_at_epoch = ? WHERE id = ?`).run(now - 60 * DAY, sunk.id);
    const list = listOpenWithOrdinal(db, 'p', 3);
    expect(list.map(r => r.id)).not.toContain(sunk.id);
    expect(dw.countStaleOpen(db, 'p')).toBe(1);
    db.close();
  });

  it('formatDeferStaleHint renders for n>0 and is null at 0', () => {
    expect(dw.formatDeferStaleHint(0)).toBeNull();
    const hint = dw.formatDeferStaleHint(2);
    expect(hint).toContain('2');
    expect(hint).toMatch(/30/);
    expect(hint.toLowerCase()).toMatch(/refresh|drop/);
  });
});
