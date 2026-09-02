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
import {
  saveObservation, formatSupersedeSkipped, formatSupersededNote, splitSupersedeTokens,
} from '../lib/save-observation.mjs';

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
    // `kind` is asserted, not tolerated: D#205 made the same three reasons reachable for
    // EVENT ids, so a skip entry that does not say which table it came from would name an
    // id that exists in both.
    expect(skipped).toEqual([
      { id: otherId, reason: 'other-project', kind: 'obs' },
      { id: already, reason: 'already-superseded', kind: 'obs' },
      { id: gone, reason: 'no-such-observation', kind: 'obs' },
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
    expect(second.supersedeSkipped).toEqual([{ id: oldId, reason: 'duplicate-save', kind: 'obs' }]);
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
    expect(r.supersededEventIds).toEqual([]);
    expect(db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(oldId).superseded_at).toBeNull();
  });

  // ─── D#205: events are supersedable through the same verb ──────────────────
  describe('E# addresses the events table (D#205)', () => {
    // Tested directly, not only through saveObservation: this split is the whole
    // namespace decision, and a bare number silently landing in `events` would retire a
    // row the caller never named — the two tables share an id space.
    it('splitSupersedeTokens routes each token to exactly one table', () => {
      const r = splitSupersedeTokens([7, '8', 'E#9', 'e10', ' E#11 ', 'E#0', 'abc', '1abc', -3, null, '']);
      expect(r.obs).toEqual([7, 8]);
      // `E9`/`E#9`, upper or lower, with or without surrounding space — all the shapes a
      // reader might type back from an injected `E#9` line.
      expect(r.events).toEqual([9, 10, 11]);
      // Everything else is REPORTED with the caller's original token, not dropped: that
      // is D#201's rule, and `E#0` is in here because a zero id is not a row.
      expect(r.malformed.map((m) => m.id)).toEqual(['E#0', 'abc', '1abc', -3, null, '']);
      expect(r.malformed.every((m) => m.reason === 'malformed-id')).toBe(true);
    });

    it('a bare number is never routed to events, and E# is never routed to observations', () => {
      // The one-line statement of the invariant, asserted rather than described.
      expect(splitSupersedeTokens([42]).events).toEqual([]);
      expect(splitSupersedeTokens(['E#42']).obs).toEqual([]);
      expect(splitSupersedeTokens([]).obs).toEqual([]);
      expect(splitSupersedeTokens(undefined).events).toEqual([]);
    });

    function seedEvent({ project = 'test', title = 'Hook context cost scales 2.1-3.8x per call' } = {}) {
      return Number(db.prepare(`
        INSERT INTO events (project, event_type, title, body, importance, created_at_epoch)
        VALUES (?, 'discovery', ?, 'body', 3, ?)
      `).run(project, title, Date.now() - 60_000).lastInsertRowid);
    }

    it('retires the event and reports it separately from observations', () => {
      const evId = seedEvent();
      const obsId = Number(seedOld().lastInsertRowid);
      const r = saveObservation(db, {
        content: 'The 2.1-3.8x range was never produced by any measurement and is withdrawn',
        title: 'Cost range withdrawn', project: 'test', supersedes: [obsId, `E#${evId}`],
      });
      expect(r.supersedeSkipped).toEqual([]);
      // Separate arrays, because the two tables share an id space: a merged list of bare
      // `#N` could not say which table each retired row came from.
      expect(r.supersededIds).toEqual([obsId]);
      expect(r.supersededEventIds).toEqual([evId]);
      const ev = db.prepare('SELECT superseded_at_epoch, superseded_by_id FROM events WHERE id = ?').get(evId);
      expect(ev.superseded_at_epoch, 'event must be tombstoned').toBeGreaterThan(0);
      // superseded_by_id REFERENCES events(id) and the retiring row is an OBSERVATION, so
      // writing savedId there would point at whatever event happens to share the number —
      // the cross-table collision D#202 closed. A missing link beats a wrong one.
      expect(ev.superseded_by_id, 'must not fabricate an event->event link').toBeNull();
    });

    it('a bare number still means an observation, never an event with the same id', () => {
      // The two tables share an id space; this is the case that would silently retire the
      // wrong row if the prefix were treated as optional decoration.
      const evId = seedEvent();
      const sameNumbered = Number(seedOld({ title: 'same-id decoy' }).lastInsertRowid);
      const r = saveObservation(db, {
        content: 'Bare numbers address observations only, one more sentence for length',
        title: 'Namespace check', project: 'test', supersedes: [sameNumbered],
      });
      expect(r.supersededIds).toEqual([sameNumbered]);
      expect(r.supersededEventIds).toEqual([]);
      expect(db.prepare('SELECT superseded_at_epoch FROM events WHERE id = ?').get(evId).superseded_at_epoch).toBeNull();
    });

    it('classifies an unusable E# id instead of dropping it', () => {
      const foreign = seedEvent({ project: 'other-project' });
      const already = seedEvent();
      db.prepare('UPDATE events SET superseded_at_epoch = ? WHERE id = ?').run(Date.now(), already);
      const r = saveObservation(db, {
        content: 'Three unusable event ids must each come back with their own reason here',
        title: 'Classification', project: 'test',
        supersedes: ['E#99999', `E#${foreign}`, `E#${already}`],
      });
      expect(r.supersededEventIds).toEqual([]);
      expect(r.supersedeSkipped.map((s) => [s.kind, s.reason])).toEqual([
        ['event', 'no-such-event'],
        ['event', 'other-project'],
        ['event', 'already-superseded'],
      ]);
      // And the reasons must reach the user with the prefix they typed, not as bare `#N`
      // — which would name a DIFFERENT row in the other table.
      const msg = formatSupersedeSkipped(r.supersedeSkipped);
      expect(msg).toContain('E#99999');
      expect(msg).not.toMatch(/(?<!E)#99999/);
    });

    it('the dedup short-circuit reports swallowed EVENT ids too', () => {
      // The path D#201 exists for, on the namespace D#205 just added: a correction written
      // within the dedup window never happens, and the event it meant to retire stays live.
      const evId = seedEvent();
      const text = 'A correction that will read as a near duplicate of itself shortly';
      saveObservation(db, { content: text, title: 'Dup base', project: 'test' });
      const r = saveObservation(db, { content: text, title: 'Dup base', project: 'test', supersedes: [`E#${evId}`] });
      expect(r.kind).toBe('duplicate');
      expect(r.supersedeSkipped).toEqual([{ id: evId, reason: 'duplicate-save', kind: 'event' }]);
      expect(db.prepare('SELECT superseded_at_epoch FROM events WHERE id = ?').get(evId).superseded_at_epoch).toBeNull();
    });

    it('formatSupersededNote renders both tables, and neither face rebuilds the string', () => {
      expect(formatSupersededNote({ supersededIds: [7], supersededEventIds: [9] }))
        .toBe(' Superseded: #7, E#9.');
      expect(formatSupersededNote({ supersededIds: [], supersededEventIds: [] })).toBe('');
      expect(formatSupersededNote(undefined)).toBe('');

      // CLASS-LEVEL SWEEP, same reasoning as the D#201 one above: both faces hand-built
      // this note, so adding events to one and not the other was the default outcome.
      // Requires the shared renderer AND the absence of a local rebuild.
      const problems = [];
      for (const face of ['mem-cli.mjs', 'server.mjs']) {
        const src = readFileSync(join(REPO, face), 'utf8');
        if (!/import\s*\{[^}]*\bformatSupersededNote\b[^}]*\}\s*from\s*['"][^'"]*save-observation\.mjs['"]/.test(src)) {
          problems.push(`${face}: does not import formatSupersededNote`);
          continue;
        }
        if (![...src.matchAll(/formatSupersededNote\(/g)].length) {
          problems.push(`${face}: imports formatSupersededNote but never calls it`);
        }
        if (/Superseded: \$\{/.test(src)) {
          problems.push(`${face}: rebuilds the Superseded note locally instead of using the shared renderer`);
        }
      }
      expect(problems).toEqual([]);
    });
  });
});
