// verify-apply — the deterministic write half of /verify (contract: commands/verify.md).
// The agent decides WHAT is stale;
// this module is the only thing that writes, so every property the spec promises about a
// write is pinned here: validation before any write, one transaction, a read-back that can
// say NO, and an undo that restores the backed-up row (its text re-scrubbed for secrets, since
// 690d53f — so byte-for-byte only for a row that carried none).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseProposals,
  planVerifyApply,
  planDigest,
  applyVerifyPlan,
  runVerifyApply,
  readBackVerifyPlan,
  undoVerifyBackup,
  markUndone,
  VERIFY_RETIRED_MARKER,
} from '../lib/verify-apply-core.mjs';

const P = 'dev--proj';

/** Every row of both tables the writes touch, in a stable order — the "nothing changed" ruler. */
function snapshot(db) {
  const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();
  const files = db.prepare('SELECT obs_id, filename FROM observation_files ORDER BY obs_id, filename').all();
  return JSON.stringify({ obs, files });
}

function seed(db, over = {}) {
  const r = insertObs(db, {
    sessionId: 'manual-p',
    project: P,
    type: 'bugfix',
    title: 'Old title',
    narrative: 'The bug in foo.mjs is still open.',
    text: 'The bug in foo.mjs is still open.',
    importance: 2,
    lessonLearned: 'Old lesson',
    filesModified: '["lib/foo.mjs","lib/bar.mjs"]',
    ...over,
  });
  return Number(r.lastInsertRowid);
}

describe('parseProposals — schema validation happens before anything reads the DB', () => {
  it('accepts the three actions in their documented shapes', () => {
    const { entries, errors } = parseProposals([
      { id: 1, action: 'replace', verdict: 'STALE', narrative: 'n', title: 't', evidence: 'abc123' },
      { id: 2, action: 'edit', verdict: 'PARTIAL', set: { narrative: 'n2' }, evidence: 'foo.mjs:3' },
      { id: 3, action: 'retire', verdict: 'STALE', evidence: 'def456' },
    ]);
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.action)).toEqual(['replace', 'edit', 'retire']);
  });

  it.each([
    ['not an array', { id: 1 }, /array/],
    ['empty array', [], /empty/],
    ['unknown action', [{ id: 1, action: 'delete', verdict: 'STALE', evidence: 'x' }], /action/],
    ['unknown key', [{ id: 1, action: 'retire', verdict: 'STALE', evidence: 'x', note: 'y' }], /unknown key/],
    ['non-integer id', [{ id: '7', action: 'retire', verdict: 'STALE', evidence: 'x' }], /id/],
    [
      'duplicate id',
      [
        { id: 1, action: 'retire', verdict: 'STALE', evidence: 'x' },
        { id: 1, action: 'retire', verdict: 'STALE', evidence: 'x' },
      ],
      /duplicate/,
    ],
    ['VALID verdict', [{ id: 1, action: 'retire', verdict: 'VALID', evidence: 'x' }], /verdict/],
    ['empty evidence', [{ id: 1, action: 'retire', verdict: 'STALE', evidence: '  ' }], /evidence/],
    [
      'lesson over 500',
      [
        {
          id: 1,
          action: 'replace',
          verdict: 'STALE',
          narrative: 'n',
          lesson_learned: 'x'.repeat(501),
          evidence: 'e',
        },
      ],
      /500/,
    ],
    [
      'importance 4',
      [{ id: 1, action: 'replace', verdict: 'STALE', narrative: 'n', importance: 4, evidence: 'e' }],
      /importance/,
    ],
    ['edit with empty set', [{ id: 1, action: 'edit', verdict: 'PARTIAL', set: {}, evidence: 'e' }], /set/],
    [
      'edit of a non-editable column',
      [{ id: 1, action: 'edit', verdict: 'PARTIAL', set: { project: 'x' }, evidence: 'e' }],
      /project/,
    ],
    [
      'edit to an empty narrative',
      [{ id: 1, action: 'edit', verdict: 'PARTIAL', set: { narrative: ' ' }, evidence: 'e' }],
      /narrative/,
    ],
  ])('rejects %s', (_label, input, re) => {
    const { entries, errors } = parseProposals(input);
    expect(errors.join('\n')).toMatch(re);
    expect(entries).toEqual([]);
  });
});

describe('planVerifyApply — every target is checked against the DB before a write', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: P });
    insertSession(db, { id: 'manual-o', project: 'dev--other' });
  });
  afterEach(() => db.close());

  const retire = (id) => ({ id, action: 'retire', verdict: 'STALE', evidence: 'e' });

  it('rejects an unknown id, a foreign project, a superseded row and a compressed row — and names each', () => {
    const foreign = seed(db, { sessionId: 'manual-o', project: 'dev--other' });
    const gone = seed(db, { supersededAt: Date.now(), supersededBy: 1 });
    const compressed = seed(db, { compressedInto: -1 });
    const { plan, errors } = planVerifyApply(
      db,
      [retire(99999), retire(foreign), retire(gone), retire(compressed)],
      {
        project: P,
      },
    );
    expect(plan).toEqual([]);
    const text = errors.join('\n');
    expect(text).toMatch(/#99999.*no such/);
    expect(text).toMatch(new RegExp(`#${foreign}.*project`));
    expect(text).toMatch(new RegExp(`#${gone}.*not live`));
    expect(text).toMatch(new RegExp(`#${compressed}.*not live`));
  });

  it('rejects a replace that would have no body (no narrative given, original narrative empty)', () => {
    const id = seed(db, { narrative: '' });
    const { errors } = planVerifyApply(
      db,
      [{ id, action: 'replace', verdict: 'STALE', title: 't', evidence: 'e' }],
      {
        project: P,
      },
    );
    expect(errors.join('\n')).toMatch(/narrative/);
  });

  it('parse + plan write nothing (the dry-run path)', () => {
    const a = seed(db);
    const b = seed(db, { title: 'second' });
    const before = snapshot(db);
    const { entries } = parseProposals([
      { id: a, action: 'edit', verdict: 'PARTIAL', set: { narrative: 'fixed' }, evidence: 'e' },
      retire(b),
    ]);
    const { errors } = planVerifyApply(db, entries, { project: P });
    expect(errors).toEqual([]);
    expect(snapshot(db)).toBe(before);
  });
});

describe('applyVerifyPlan + readBackVerifyPlan', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: P });
  });
  afterEach(() => db.close());

  function planOf(input) {
    const { entries, errors } = parseProposals(input);
    expect(errors).toEqual([]);
    const planned = planVerifyApply(db, entries, { project: P });
    expect(planned.errors).toEqual([]);
    return planned.plan;
  }

  it('lands all three actions and the read-back reports every entry ok', () => {
    const r = seed(db);
    const e = seed(db, { title: 'edit me', narrative: 'line 10 moved', text: 'line 10 moved' });
    const t = seed(db, { title: 'retire me' });
    const plan = planOf([
      {
        id: r,
        action: 'replace',
        verdict: 'STALE',
        title: 'Bug in foo.mjs (fixed in abc123)',
        narrative: 'The bug was fixed in abc123.',
        evidence: 'abc123',
      },
      {
        id: e,
        action: 'edit',
        verdict: 'PARTIAL',
        set: { narrative: 'line 12 moved' },
        evidence: 'foo.mjs:12',
      },
      { id: t, action: 'retire', verdict: 'STALE', evidence: 'def456' },
    ]);
    const results = applyVerifyPlan(db, plan);

    const rep = results.find((x) => x.id === r);
    const oldRow = db.prepare('SELECT * FROM observations WHERE id = ?').get(r);
    const newRow = db.prepare('SELECT * FROM observations WHERE id = ?').get(rep.newId);
    expect(oldRow.superseded_at).not.toBeNull();
    expect(Number(oldRow.superseded_by)).toBe(rep.newId);
    expect(newRow.superseded_at).toBeNull();
    expect(newRow.project).toBe(P);
    expect(newRow.type).toBe('bugfix');
    expect(newRow.importance).toBe(2);
    expect(newRow.title).toBe('Bug in foo.mjs (fixed in abc123)');
    expect(newRow.narrative).toBe('The bug was fixed in abc123.');
    expect(newRow.lesson_learned).toBe('Old lesson'); // not in the entry -> copied from the original
    const newFiles = db
      .prepare('SELECT filename FROM observation_files WHERE obs_id = ? ORDER BY filename')
      .all(rep.newId);
    expect(newFiles.map((f) => f.filename)).toEqual(['lib/bar.mjs', 'lib/foo.mjs']);

    const edited = db.prepare('SELECT * FROM observations WHERE id = ?').get(e);
    expect(edited.narrative).toBe('line 12 moved');
    expect(edited.title).toBe('edit me');
    expect(edited.superseded_at).toBeNull();
    expect(edited.text).toContain('line 12 moved'); // derived FTS text rebuilt through applyObsUpdate

    const retired = db.prepare('SELECT * FROM observations WHERE id = ?').get(t);
    expect(retired.superseded_at).not.toBeNull();
    expect(retired.superseded_by).toBe(VERIFY_RETIRED_MARKER);

    const check = readBackVerifyPlan(db, plan, results);
    expect(check.map((c) => [c.id, c.ok])).toEqual([
      [r, true],
      [e, true],
      [t, true],
    ]);
  });

  it('read-back says NO when a row does not hold what the plan wrote', () => {
    const e = seed(db);
    const plan = planOf([
      { id: e, action: 'edit', verdict: 'PARTIAL', set: { narrative: 'new body' }, evidence: 'x' },
    ]);
    const results = applyVerifyPlan(db, plan);
    db.prepare('UPDATE observations SET narrative = ? WHERE id = ?').run('someone else wrote this', e);
    const [c] = readBackVerifyPlan(db, plan, results);
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toMatch(/narrative/);
  });

  // One case per action, the superseded target placed LAST so the entries before it have
  // already written when the check fires — a rollback, not a refusal up front. Per action
  // because the re-check guards three different write paths: applyObsUpdate has no liveness
  // predicate of its own, so a single retire-shaped case (whose UPDATE carries one) passed
  // with the re-check deleted.
  it.each(['edit', 'replace', 'retire'])(
    'is all-or-nothing: a %s target superseded after planning aborts the whole run',
    (victimAction) => {
      const others = ['edit', 'replace', 'retire'].filter((a) => a !== victimAction);
      const ids = [
        seed(db, { title: 'first' }),
        seed(db, { title: 'second' }),
        seed(db, { title: 'victim' }),
      ];
      const actions = [...others, victimAction];
      const entry = (id, action) =>
        action === 'edit'
          ? { id, action, verdict: 'PARTIAL', set: { narrative: `edited ${id}` }, evidence: 'x' }
          : action === 'replace'
            ? { id, action, verdict: 'STALE', narrative: `replaced ${id}`, evidence: 'x' }
            : { id, action, verdict: 'STALE', evidence: 'x' };
      const plan = planOf(ids.map((id, i) => entry(id, actions[i])));
      // A concurrent hook retires the LAST target between the plan and the write.
      db.prepare('UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id = ?').run(
        Date.now(),
        'auto-dedup',
        ids[2],
      );
      const before = snapshot(db);
      expect(() => applyVerifyPlan(db, plan)).toThrow(new RegExp(`#${ids[2]}: no longer live`));
      expect(snapshot(db)).toBe(before);
    },
  );
});

/** Run a proposals document end to end (parse -> plan -> run) and return what undo needs. */
function applyAll(db, input, backupDir, { project = P } = {}) {
  const { entries, errors } = parseProposals(input);
  expect(errors).toEqual([]);
  const planned = planVerifyApply(db, entries, { project });
  expect(planned.errors).toEqual([]);
  const run = runVerifyApply(db, planned.plan, { backupDir });
  return { plan: planned.plan, ...run, backup: JSON.parse(readFileSync(run.backupPath, 'utf8')) };
}

describe('replace carries what the original had, and approved text is out of the rewrite pool', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: P });
  });
  afterEach(() => db.close());

  function enrich(id) {
    db.prepare(
      `UPDATE observations SET subtitle = 'sub', concepts = 'alpha beta', facts = 'The table has 893 rows',
         search_aliases = 'gamma', scope = 'module', branch = 'feat/x' WHERE id = ?`,
    ).run(id);
  }

  it('copies subtitle, concepts, facts, aliases, scope and branch; an explicit facts overrides', () => {
    const a = seed(db);
    const b = seed(db, { title: 'b' });
    enrich(a);
    enrich(b);
    const { entries } = parseProposals([
      { id: a, action: 'replace', verdict: 'STALE', narrative: 'Fixed in abc123.', evidence: 'abc123' },
      {
        id: b,
        action: 'replace',
        verdict: 'STALE',
        narrative: 'Now 813 rows.',
        facts: 'The table has 813 rows',
        evidence: '4d505b4',
      },
    ]);
    const { plan } = planVerifyApply(db, entries, { project: P });
    const results = applyVerifyPlan(db, plan);
    const na = db.prepare('SELECT * FROM observations WHERE id = ?').get(results[0].newId);
    const nb = db.prepare('SELECT * FROM observations WHERE id = ?').get(results[1].newId);
    expect(na).toMatchObject({
      subtitle: 'sub',
      concepts: 'alpha beta',
      facts: 'The table has 893 rows',
      search_aliases: 'gamma',
      scope: 'module',
      branch: 'feat/x',
    });
    expect(nb.facts).toBe('The table has 813 rows');
    expect(nb.text).toContain('813'); // derived FTS text rebuilt with the override, not the stale 893
    expect(nb.text).not.toContain('893');
    expect(readBackVerifyPlan(db, plan, results).every((c) => c.ok)).toBe(true);
  });

  it('stamps optimized_at on a replacement and on an edited row, so the narrow re-enrich pass cannot rewrite approved text', () => {
    const r = seed(db, { lessonLearned: null });
    const e = seed(db, { title: 'e', lessonLearned: null });
    const { entries } = parseProposals([
      { id: r, action: 'replace', verdict: 'STALE', narrative: 'x'.repeat(150), evidence: 'x' },
      { id: e, action: 'edit', verdict: 'PARTIAL', set: { narrative: 'y'.repeat(150) }, evidence: 'x' },
    ]);
    const { plan } = planVerifyApply(db, entries, { project: P });
    const results = applyVerifyPlan(db, plan);
    for (const id of [results[0].newId, e]) {
      expect(
        db.prepare('SELECT optimized_at FROM observations WHERE id = ?').get(id).optimized_at,
      ).not.toBeNull();
    }
  });

  it('reads back ok when the original had an empty lesson and an empty title (saveObservation normalises both)', () => {
    const a = seed(db, { lessonLearned: '' });
    const b = seed(db, { title: '' });
    const { entries } = parseProposals([
      { id: a, action: 'replace', verdict: 'STALE', narrative: 'corrected a', evidence: 'x' },
      { id: b, action: 'replace', verdict: 'STALE', narrative: 'corrected b', evidence: 'x' },
    ]);
    const { plan } = planVerifyApply(db, entries, { project: P });
    const results = applyVerifyPlan(db, plan);
    const checks = readBackVerifyPlan(db, plan, results);
    expect(checks.map((c) => [c.ok, c.problems])).toEqual([
      [true, []],
      [true, []],
    ]);
  });
});

describe('read-back catches each kind of drift', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: P });
  });
  afterEach(() => db.close());

  it('a replacement whose file edges differ', () => {
    const r = seed(db);
    const { entries } = parseProposals([
      { id: r, action: 'replace', verdict: 'STALE', narrative: 'c', evidence: 'x' },
    ]);
    const { plan } = planVerifyApply(db, entries, { project: P });
    const results = applyVerifyPlan(db, plan);
    db.prepare('DELETE FROM observation_files WHERE obs_id = ?').run(results[0].newId);
    expect(readBackVerifyPlan(db, plan, results)[0].problems.join(' ')).toMatch(/files/);
  });

  it('a retired row whose marker is not ours', () => {
    const t = seed(db);
    const { entries } = parseProposals([{ id: t, action: 'retire', verdict: 'STALE', evidence: 'x' }]);
    const { plan } = planVerifyApply(db, entries, { project: P });
    const results = applyVerifyPlan(db, plan);
    db.prepare("UPDATE observations SET superseded_by = 'auto-dedup' WHERE id = ?").run(t);
    expect(readBackVerifyPlan(db, plan, results)[0].problems.join(' ')).toMatch(/superseded_by/);
  });

  it('a target compressed between planning and applying aborts the run', () => {
    const a = seed(db);
    const { entries } = parseProposals([{ id: a, action: 'retire', verdict: 'STALE', evidence: 'x' }]);
    const { plan } = planVerifyApply(db, entries, { project: P });
    db.prepare('UPDATE observations SET compressed_into = -1 WHERE id = ?').run(a);
    const before = snapshot(db);
    expect(() => applyVerifyPlan(db, plan)).toThrow(new RegExp(`#${a}: no longer live`));
    expect(snapshot(db)).toBe(before);
  });
});

describe('planDigest binds an approval to both the proposals and the rows they were checked against', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: P });
  });
  afterEach(() => db.close());

  const planFor = (input) => planVerifyApply(db, parseProposals(input).entries, { project: P }).plan;

  it('is stable for the same input and changes when the proposed text or the target row changes', () => {
    const a = seed(db);
    const doc = [{ id: a, action: 'edit', verdict: 'PARTIAL', set: { narrative: 'one' }, evidence: 'x' }];
    const d1 = planDigest(planFor(doc), P);
    expect(planDigest(planFor(doc), P)).toBe(d1);
    expect(planDigest(planFor([{ ...doc[0], set: { narrative: 'two' } }]), P)).not.toBe(d1);
    db.prepare("UPDATE observations SET title = 'changed by a hook' WHERE id = ?").run(a);
    expect(planDigest(planFor(doc), P)).not.toBe(d1);
  });
});

describe('runVerifyApply — backup, apply, record', () => {
  let db;
  let dir;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: P });
    dir = mkdtempSync(join(tmpdir(), 'mem-verify-core-'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one backup carrying the pre-apply rows, the evidence, and what the apply created', () => {
    const r = seed(db);
    const { results, backup } = applyAll(
      db,
      [{ id: r, action: 'replace', verdict: 'STALE', narrative: 'fixed', evidence: 'abc123' }],
      dir,
    );
    expect(backup.rows[0].row.narrative).toBe('The bug in foo.mjs is still open.');
    expect(backup.applied).toEqual([
      expect.objectContaining({
        id: r,
        action: 'replace',
        verdict: 'STALE',
        evidence: 'abc123',
        newId: results[0].newId,
      }),
    ]);
    expect(backup.undone_at).toBeNull();
  });

  it('removes its own backup when the apply aborts, so "nothing written" is true on disk too', () => {
    const a = seed(db);
    const b = seed(db, { title: 'b' });
    const { entries } = parseProposals([
      { id: a, action: 'retire', verdict: 'STALE', evidence: 'x' },
      { id: b, action: 'replace', verdict: 'STALE', narrative: 'ok', evidence: 'x' },
    ]);
    const { plan } = planVerifyApply(db, entries, { project: P });
    // A failure INSIDE the transaction, after the backup is on disk: saveObservation refuses a
    // whitespace-only body (parse would have refused it; the plan is tampered with here only to
    // reach that throw). The retire before it must roll back with it.
    plan[1].narrative = '   ';
    const before = snapshot(db);
    expect(() => runVerifyApply(db, plan, { backupDir: dir })).toThrow(/empty/);
    expect(readdirSync(dir)).toEqual([]);
    expect(snapshot(db)).toBe(before);
  });

  it('gives two runs in the same millisecond two different backup files', () => {
    const a = seed(db);
    const b = seed(db, { title: 'b' });
    const now = new Date('2026-09-25T10:00:00.000Z');
    const run = (id) =>
      runVerifyApply(
        db,
        planVerifyApply(
          db,
          parseProposals([{ id, action: 'retire', verdict: 'STALE', evidence: 'x' }]).entries,
          { project: P },
        ).plan,
        { backupDir: dir, now },
      );
    expect(run(a).backupPath).not.toBe(run(b).backupPath);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('refuses to apply when a target changed after the backup snapshot was taken', () => {
    const a = seed(db);
    const { plan } = planVerifyApply(
      db,
      parseProposals([{ id: a, action: 'edit', verdict: 'PARTIAL', set: { narrative: 'n' }, evidence: 'x' }])
        .entries,
      { project: P },
    );
    const staleRows = [
      { ...db.prepare('SELECT * FROM observations WHERE id = ?').get(a), title: 'what the backup saw' },
    ];
    const before = snapshot(db);
    expect(() => applyVerifyPlan(db, plan, { expectRows: staleRows })).toThrow(
      new RegExp(`#${a}: changed since`),
    );
    expect(snapshot(db)).toBe(before);
  });
});

describe('undoVerifyBackup — only undoes what the apply left untouched', () => {
  let db;
  let dir;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: P });
    insertSession(db, { id: 'manual-o', project: 'dev--other' });
    dir = mkdtempSync(join(tmpdir(), 'mem-verify-undo-'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function threeActions() {
    const r = seed(db);
    const e = seed(db, { title: 'e', narrative: 'old body', text: 'old body' });
    const t = seed(db, { title: 't' });
    const original = new Map(
      [r, e, t].map((id) => [id, db.prepare('SELECT * FROM observations WHERE id = ?').get(id)]),
    );
    const run = applyAll(
      db,
      [
        { id: r, action: 'replace', verdict: 'STALE', narrative: 'corrected', evidence: 'x' },
        {
          id: e,
          action: 'edit',
          verdict: 'PARTIAL',
          set: { narrative: 'new body', importance: 3 },
          evidence: 'x',
        },
        { id: t, action: 'retire', verdict: 'STALE', evidence: 'x' },
      ],
      dir,
    );
    return { r, e, t, original, run, newId: run.results.find((x) => x.id === r).newId };
  }

  it('restores every row byte-for-byte and retires the replacement', () => {
    const { original, run, newId } = threeActions();
    const undone = undoVerifyBackup(db, run.backup);
    expect(undone.errors).toEqual([]);
    for (const [id, row] of original)
      expect(db.prepare('SELECT * FROM observations WHERE id = ?').get(id)).toEqual(row);
    expect(
      db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(newId).superseded_at,
    ).not.toBeNull();
  });

  it('refuses — writing nothing — when a row was edited after the apply', () => {
    const { e, run } = threeActions();
    db.prepare("UPDATE observations SET title = 'user retitled after verify' WHERE id = ?").run(e);
    const before = snapshot(db);
    const res = undoVerifyBackup(db, run.backup);
    expect(res.errors.join(' ')).toMatch(new RegExp(`#${e}: changed since the apply`));
    expect(snapshot(db)).toBe(before);
  });

  it('refuses when the replacement was itself superseded later (the user corrected the correction)', () => {
    const { run, newId } = threeActions();
    db.prepare('UPDATE observations SET superseded_at = ?, superseded_by = 999 WHERE id = ?').run(
      Date.now(),
      newId,
    );
    const before = snapshot(db);
    const res = undoVerifyBackup(db, run.backup);
    expect(res.errors.join(' ')).toMatch(new RegExp(`#${newId}`));
    expect(snapshot(db)).toBe(before);
  });

  it('refuses a backup that was already undone', () => {
    const { run } = threeActions();
    expect(undoVerifyBackup(db, run.backup).errors).toEqual([]);
    const before = snapshot(db);
    const res = undoVerifyBackup(db, markUndone(run.backup));
    expect(res.errors.join(' ')).toMatch(/already undone/);
    expect(snapshot(db)).toBe(before);
  });

  it('refuses a backup whose rows are not these rows (another project, another DB)', () => {
    const { run } = threeActions();
    const forged = JSON.parse(JSON.stringify(run.backup));
    forged.rows[1].row.memory_session_id = 'somebody-else';
    const before = snapshot(db);
    expect(undoVerifyBackup(db, forged).errors.join(' ')).toMatch(/not the row this backup was taken from/);
    const foreign = JSON.parse(JSON.stringify(run.backup));
    foreign.project = 'dev--other';
    expect(undoVerifyBackup(db, foreign).errors.join(' ')).toMatch(/project/);
    expect(snapshot(db)).toBe(before);
  });

  it('refuses a document that is not one of ours, or has no record of what was applied — writing nothing', () => {
    const { r, run } = threeActions();
    const before = snapshot(db);
    expect(
      undoVerifyBackup(db, { kind: 'something-else', rows: [{ row: { id: r } }] }).errors.join(' '),
    ).toMatch(/backup/);
    expect(undoVerifyBackup(db, { ...run.backup, applied: null }).errors.join(' ')).toMatch(/applied/);
    expect(snapshot(db)).toBe(before);
    expect(existsSync(run.backupPath)).toBe(true);
  });
});

describe('re-review of dcc8f72 — the remaining gaps', () => {
  let db;
  let dir;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: P });
    dir = mkdtempSync(join(tmpdir(), 'mem-verify-rr-'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to apply — no backup, no write — when a target changed after the dry run the digest describes', () => {
    const a = seed(db);
    const { plan } = planVerifyApply(
      db,
      parseProposals([{ id: a, action: 'edit', verdict: 'PARTIAL', set: { narrative: 'n' }, evidence: 'x' }])
        .entries,
      { project: P },
    );
    db.prepare("UPDATE observations SET title = 'a hook wrote this after the dry run' WHERE id = ?").run(a);
    const before = snapshot(db);
    expect(() => runVerifyApply(db, plan, { backupDir: dir })).toThrow(
      new RegExp(`#${a}: changed since the dry run`),
    );
    expect(snapshot(db)).toBe(before);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reads back ok when saveObservation scrubs an original file edge that carried a credential', () => {
    const url = 'https://deploy:' + 'hunter2'.repeat(3) + '@git.example.com/repo.git';
    const r = seed(db, { filesModified: JSON.stringify(['lib/foo.mjs', url]) });
    const { plan } = planVerifyApply(
      db,
      parseProposals([{ id: r, action: 'replace', verdict: 'STALE', narrative: 'c', evidence: 'x' }]).entries,
      { project: P },
    );
    const results = applyVerifyPlan(db, plan);
    const [check] = readBackVerifyPlan(db, plan, results);
    expect(check.problems).toEqual([]);
  });

  it('the digest also covers the type and branch a replacement copies', () => {
    const a = seed(db);
    const doc = [{ id: a, action: 'replace', verdict: 'STALE', narrative: 'c', evidence: 'x' }];
    const planFor = () => planVerifyApply(db, parseProposals(doc).entries, { project: P }).plan;
    const d1 = planDigest(planFor(), P);
    db.prepare("UPDATE observations SET branch = 'other-branch' WHERE id = ?").run(a);
    const d2 = planDigest(planFor(), P);
    expect(d2).not.toBe(d1);
    db.prepare("UPDATE observations SET type = 'decision' WHERE id = ?").run(a);
    expect(planDigest(planFor(), P)).not.toBe(d2);
  });

  it('get names the cause of a /verify retirement instead of "auto-dedup or merge"', async () => {
    const { supersededNotice } = await import('../lib/get-core.mjs');
    const notice = (by) => supersededNotice({ superseded_at: 1, superseded_by: by, compressed_into: 0 });
    expect(notice(VERIFY_RETIRED_MARKER)).toMatch(/\/verify/);
    expect(notice('verify-undone')).toMatch(/undo/);
    expect(notice('auto-dedup')).toMatch(/auto-dedup or merge/);
  });
});

describe('pre-ship review of 9786874', () => {
  let db;
  let dir;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: P });
    dir = mkdtempSync(join(tmpdir(), 'mem-verify-psr-'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the undo record is what the apply transaction committed, not what the row holds after it', () => {
    // A write committed by another process just after the apply's COMMIT, before the record is
    // read, used to be recorded as the apply's own result — and --undo then restored over it.
    // A Proxy runs that write the moment the IMMEDIATE transaction returns.
    const id = seed(db);
    let hook = () => db.prepare('UPDATE observations SET importance = 3 WHERE id = ?').run(id);
    const proxy = new Proxy(db, {
      get(t, k) {
        if (k === 'transaction')
          return (fn) => {
            const tx = t.transaction(fn);
            const w = (...a) => tx(...a);
            w.immediate = (...a) => {
              const r = tx.immediate(...a);
              if (hook) {
                const h = hook;
                hook = null;
                h();
              }
              return r;
            };
            return w;
          };
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const { plan } = planVerifyApply(
      proxy,
      parseProposals([{ id, action: 'edit', verdict: 'STALE', set: { narrative: 'fixed' }, evidence: 'x' }])
        .entries,
      { project: P },
    );
    const { backupPath } = runVerifyApply(proxy, plan, { backupDir: dir });
    expect(hook).toBeNull(); // premise: the other write ran, after the commit
    const res = undoVerifyBackup(db, JSON.parse(readFileSync(backupPath, 'utf8')));
    expect(res.restored).toEqual([]);
    expect(res.errors.join('\n')).toMatch(/changed since the apply \(importance\)/);
    expect(db.prepare('SELECT importance FROM observations WHERE id = ?').get(id).importance).toBe(3);
  });

  it("refuses an edit that would copy a row's stored text into its empty narrative", () => {
    // rebuildObservationDerived promotes the body of an import-shaped row (empty narrative, the
    // payload in `text`) into `narrative` on ANY update — a write the dry run never showed.
    const id = seed(db, { narrative: '', text: 'IMPORTBODY raw payload that is not in the title' });
    const { plan, errors } = planVerifyApply(
      db,
      parseProposals([{ id, action: 'edit', verdict: 'PARTIAL', set: { title: 't2' }, evidence: 'x' }])
        .entries,
      { project: P },
    );
    expect(plan).toEqual([]);
    expect(errors.join('\n')).toMatch(new RegExp(`#${id}: .*no narrative`));
    // With the narrative in the set, the edit writes exactly what it shows.
    const ok = planVerifyApply(
      db,
      parseProposals([
        { id, action: 'edit', verdict: 'PARTIAL', set: { title: 't2', narrative: 'body' }, evidence: 'x' },
      ]).entries,
      { project: P },
    );
    expect(ok.errors).toEqual([]);
  });

  it('allows an edit on a narrative-less row whose text is a derived blob, where nothing is filled', () => {
    // hook-llm rows carry narrative '' and a text made only of their own concepts/aliases; the
    // repair does not promote those, so refusing them blocked a legitimate lesson edit.
    const id = seed(db, { narrative: '', text: 'cache lru', lessonLearned: null });
    db.prepare("UPDATE observations SET concepts = 'cache lru' WHERE id = ?").run(id);
    const { plan, errors } = planVerifyApply(
      db,
      parseProposals([
        { id, action: 'edit', verdict: 'PARTIAL', set: { lesson_learned: 'l' }, evidence: 'x' },
      ]).entries,
      { project: P },
    );
    expect(errors).toEqual([]);
    runVerifyApply(db, plan, { backupDir: dir });
    expect(db.prepare('SELECT narrative FROM observations WHERE id = ?').get(id).narrative).toBe('');
  });

  it('refuses when the edit itself would make such a row promotable (it changes the known words)', () => {
    const id = seed(db, { title: 'cache', narrative: '', text: 'cache lru', lessonLearned: null });
    db.prepare("UPDATE observations SET concepts = 'lru' WHERE id = ?").run(id);
    const { errors } = planVerifyApply(
      db,
      parseProposals([{ id, action: 'edit', verdict: 'PARTIAL', set: { title: 'other' }, evidence: 'x' }])
        .entries,
      { project: P },
    );
    expect(errors.join('\n')).toMatch(/no narrative/);
  });

  it('judges that refusal on the values the edit STORES, which are scrubbed', () => {
    // applyObsUpdate scrubs the set values before the rebuild runs, so a raw token the proposal
    // repeats is not "known" to the rebuild, and a legacy row's unscrubbed text gets promoted.
    const token = 'AKIA' + 'Q'.repeat(16); // assembled: a whole literal trips push protection
    const id = seed(db, { narrative: '', text: `cache ${token}`, lessonLearned: null });
    db.prepare("UPDATE observations SET concepts = 'cache' WHERE id = ?").run(id);
    const { errors } = planVerifyApply(
      db,
      parseProposals([
        { id, action: 'edit', verdict: 'PARTIAL', set: { concepts: `cache ${token}` }, evidence: 'x' },
      ]).entries,
      { project: P },
    );
    expect(errors.join('\n')).toMatch(/no narrative/);
  });

  it('writes the backup readable by its owner only, like the database', () => {
    const id = seed(db);
    const { plan } = planVerifyApply(
      db,
      parseProposals([{ id, action: 'retire', verdict: 'STALE', evidence: 'x' }]).entries,
      { project: P },
    );
    const backupDir = join(dir, 'backups');
    const { backupPath } = runVerifyApply(db, plan, { backupDir });
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(statSync(backupDir).mode & 0o777).toBe(0o700);
  });
});
