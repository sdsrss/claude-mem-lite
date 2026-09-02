// P4 governance: explicit supersession. When a new observation overturns a prior
// conclusion, the caller can pass supersedes=[ids] so those rows are tombstoned
// (superseded_at set → drop out of live search) AND linked (superseded_by = the new
// id). Fixes finding #4: contradictory memories (#8754 old rerank verdict vs the
// later reversal) coexist in search results with no supersession link, so stale
// conclusions keep getting injected at full weight. The observations.superseded_by
// column already exists (schema.mjs) — no migration needed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// D#207: repo-source paths are built with join(), never `new URL('../…', import.meta.url)`
// — the URL form makes knip drop the named module from its unused-export report.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { saveObservation } from '../lib/save-observation.mjs';

describe('saveObservation supersedes', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-test', project: 'test' });
    insertSession(db, { id: 'manual-other', project: 'other' });
  });
  afterEach(() => { db.close(); });

  const seedOld = (over = {}) => insertObs(db, {
    sessionId: 'manual-test', project: 'test', type: 'discovery',
    title: 'Old rerank verdict', narrative: 'rerank is not the lever', text: 'rerank verdict', ...over,
  });

  it('tombstones and links a prior observation the new save overturns', () => {
    const oldId = Number(seedOld().lastInsertRowid);
    const r = saveObservation(db, {
      content: 'Fresh measurement overturns the old rerank verdict: paraphrase gap closed',
      title: 'Rerank verdict reversed', type: 'decision', project: 'test', supersedes: [oldId],
    });
    expect(r.kind).toBe('saved');
    expect(r.supersededIds).toEqual([oldId]);
    const old = db.prepare('SELECT superseded_at, superseded_by FROM observations WHERE id = ?').get(oldId);
    expect(old.superseded_at).toBeGreaterThan(0);
    expect(old.superseded_by).toBe(r.id); // links to the superseding row
  });

  it('never supersedes a row in a different project', () => {
    const otherId = Number(insertObs(db, { sessionId: 'manual-other', project: 'other', title: 'Other proj', narrative: 'x', text: 'x' }).lastInsertRowid);
    const r = saveObservation(db, {
      content: 'A brand new save in test project unrelated to other', title: 'New', project: 'test', supersedes: [otherId],
    });
    expect(r.supersededIds).toEqual([]);
    const other = db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(otherId);
    expect(other.superseded_at).toBeNull();
  });

  it('skips an already-superseded row (idempotent, no re-stamp)', () => {
    const oldId = Number(seedOld({ supersededAt: 111 }).lastInsertRowid);
    const r = saveObservation(db, {
      content: 'Another fresh conclusion about the ranking lever question entirely', title: 'Newer', project: 'test', supersedes: [oldId],
    });
    expect(r.supersededIds).toEqual([]);
    const old = db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(oldId);
    expect(old.superseded_at).toBe(111); // unchanged
  });

  it('ignores self-reference, non-existent, and malformed ids', () => {
    const r = saveObservation(db, {
      content: 'Standalone save that references junk supersede ids for safety', title: 'Standalone', project: 'test',
      supersedes: [999999, -1, 0, 'x', null],
    });
    expect(r.kind).toBe('saved');
    expect(r.supersededIds).toEqual([]);
  });

  // Atomicity: the tombstone UPDATE used to run AFTER the insert transaction
  // committed, so a failure (or a kill) between the two left the new correcting
  // row live while the rows it overturns stayed live too — both surface together
  // through the `superseded_at IS NULL` filter, which is exactly the contradiction
  // supersession exists to prevent. Insert + tombstone must commit as one unit.
  it('rolls the whole save back when the supersession UPDATE fails (atomicity)', () => {
    const oldId = Number(seedOld().lastInsertRowid);
    const before = db.prepare('SELECT COUNT(*) AS c FROM observations').get().c;

    // Fail only the tombstone UPDATE; every other statement runs for real.
    const failingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql) => {
            if (/UPDATE observations SET superseded_at/.test(sql)) {
              return { run: () => { throw new Error('simulated failure mid-supersession'); } };
            }
            return target.prepare(sql);
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

    expect(() => saveObservation(failingDb, {
      content: 'Fresh measurement overturns the old rerank verdict: paraphrase gap closed',
      title: 'Rerank verdict reversed', type: 'decision', project: 'test', supersedes: [oldId],
    })).toThrow(/simulated failure mid-supersession/);

    // Neither half may survive: no orphan new row, and the old row is untouched.
    expect(db.prepare('SELECT COUNT(*) AS c FROM observations').get().c).toBe(before);
    expect(db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(oldId).superseded_at).toBeNull();
  });

  // D#201. Every case above pins that an ineligible id is NOT superseded. None
  // pinned that the caller is told, and it was not: the eligible-filter dropped
  // the difference on the floor and `Superseded: …` prints only when the result
  // is non-empty — so "requested 1, superseded 0" and "requested nothing" were
  // the same output. Found by walking into it: `--supersedes 10524` exited 0
  // with no annotation, and 10524 turned out to be an `events` row, so a stale
  // conclusion stayed live with a silent success as the only trace.
  //
  // The three reasons are reported separately because they are not the same
  // event: two are bad input, one (already-superseded) is a benign idempotent
  // replay that must NOT be turned into an error.
  it('reports every requested id that was NOT superseded, with a reason (D#201)', () => {
    const gone = 999999;
    const otherId = Number(insertObs(db, {
      sessionId: 'manual-other', project: 'other', title: 'Other proj', narrative: 'x', text: 'x',
    }).lastInsertRowid);
    const already = Number(seedOld({ supersededAt: 111 }).lastInsertRowid);
    const good = Number(seedOld().lastInsertRowid);

    const r = saveObservation(db, {
      content: 'A correcting observation that names one good id and three bad ones',
      title: 'Correction', project: 'test',
      supersedes: [good, gone, otherId, already],
    });

    expect(r.supersededIds).toEqual([good]);
    // Sorted by id so the assertion does not depend on input order.
    const skipped = [...r.supersedeSkipped].sort((a, b) => a.id - b.id);
    expect(skipped).toEqual([
      { id: otherId, reason: 'other-project' },
      { id: already, reason: 'already-superseded' },
      { id: gone, reason: 'no-such-observation' },
    ].sort((a, b) => a.id - b.id));
  });

  it('supersedeSkipped is empty when every requested id lands (D#201)', () => {
    const a = Number(seedOld().lastInsertRowid);
    const b = Number(seedOld().lastInsertRowid);
    const r = saveObservation(db, {
      content: 'A correcting observation naming only ids that are all eligible',
      title: 'Correction', project: 'test', supersedes: [a, b],
    });
    expect(r.supersededIds.sort()).toEqual([a, b].sort());
    expect(r.supersedeSkipped).toEqual([]);
  });

  it('malformed tokens are reported too, not silently dropped before the query (D#201)', () => {
    // `-1`, `0`, `'x'`, `null` never reach the DB — the normalizer drops them.
    // They still came from the user, so they still have to surface.
    const r = saveObservation(db, {
      content: 'Standalone save that references junk supersede ids for safety',
      title: 'Standalone', project: 'test', supersedes: [-1, 0, 'x', null],
    });
    expect(r.supersededIds).toEqual([]);
    expect(r.supersedeSkipped.map((s) => s.reason)).toEqual(
      ['malformed-id', 'malformed-id', 'malformed-id', 'malformed-id']
    );
  });

  // The nastiest instance of the same sentence: the save never happens at all,
  // so the rows the correction was meant to retire stay live — and before D#201
  // the only output was "duplicate".
  it('a dedup short-circuit reports the swallowed supersession (D#201)', () => {
    const body = 'A correcting observation about the ranking lever that repeats itself';
    const oldId = Number(seedOld().lastInsertRowid);
    const first = saveObservation(db, { content: body, title: 'Correction', project: 'test' });
    expect(first.kind).toBe('saved');

    const second = saveObservation(db, {
      content: body, title: 'Correction', project: 'test', supersedes: [oldId],
    });
    expect(second.kind).toBe('duplicate');
    expect(second.supersedeSkipped).toEqual([{ id: oldId, reason: 'duplicate-save' }]);
    // …and the row really did stay live, which is what makes the report necessary.
    expect(db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(oldId).superseded_at).toBeNull();
  });

  // CLASS-LEVEL SWEEP. `supersedeSkipped` is only worth anything if a face
  // actually renders it, and both faces have TWO return paths that need it —
  // the saved path and the dedup short-circuit, which returns before the saved
  // path's note is ever reached. Four sites, and a per-face behavioural test
  // would happily pass with three of them wired.
  it('SWEEP: both faces render formatSupersedeSkipped on BOTH of their return paths (D#201)', () => {
    const faces = ['mem-cli.mjs', 'server.mjs'];
    const problems = [];
    for (const face of faces) {
      const src = readFileSync(join(REPO, face), 'utf8');
      if (!/import\s*\{[^}]*\bformatSupersedeSkipped\b[^}]*\}\s*from\s*['"][^'"]*save-observation\.mjs['"]/.test(src)) {
        problems.push(`${face}: does not import formatSupersedeSkipped`);
        continue;
      }
      // Call sites, not the import.
      const calls = [...src.matchAll(/formatSupersedeSkipped\(/g)].length;
      if (calls < 2) problems.push(`${face}: ${calls} call site(s) — needs one for the saved path and one for the dedup short-circuit`);
      // The dedup branch must consult it BEFORE it returns, or the swallowed
      // supersession stays silent on exactly the path that swallows it.
      //
      // Anchored on the user-visible duplicate MESSAGE, not on `kind ===
      // 'duplicate'`: cmd Save tests that same expression once inside the
      // transaction (to skip deferred closure on a replay) and again to render,
      // and the first match is the in-transaction one, which needs no note. The
      // first draft of this sweep anchored there and reported a false positive
      // against correctly-wired code.
      const dupIdx = src.search(/Skipped: similar to existing/);
      if (dupIdx === -1) { problems.push(`${face}: no user-facing duplicate message found — sweep would pass vacuously`); continue; }
      const dupBlock = src.slice(Math.max(0, dupIdx - 400), dupIdx + 600);
      if (!dupBlock.includes('formatSupersedeSkipped')) {
        problems.push(`${face}: the duplicate branch returns without consulting formatSupersedeSkipped`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('is a no-op when supersedes is omitted (back-compat)', () => {
    const oldId = Number(seedOld().lastInsertRowid);
    const r = saveObservation(db, { content: 'Plain save with no supersedes field at all here', title: 'Plain', project: 'test' });
    expect(r.supersededIds).toEqual([]);
    expect(db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(oldId).superseded_at).toBeNull();
  });
});
