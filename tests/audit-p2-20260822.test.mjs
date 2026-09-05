// Regression pins for the 2026-08-22 audit, P2 batch.
//
// P2-1: the fuzzy auto-dedup UPDATE (hook.mjs:1136) had no `AND superseded_at IS NULL`
// guard while its exact twin (hook.mjs:1103) grew one in v3.63. Both channels now stamp
// through lib/maintain-core.mjs stampDedupSuperseded, so the guard has one home.
//
// Why the invariant is tested at the stamp seam rather than end-to-end: BOTH channels
// select live rows only, so within a single pass no superseded row can reach the UPDATE.
// The guard exists purely for the window between SELECT and UPDATE, when a concurrent
// writer supersedes a selected row. That window cannot be opened on demand from a hook
// subprocess, so the seam is where the invariant is observable — and the seam is the
// real statement both callers now run, not a copy of it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { stampDedupSuperseded } from '../lib/maintain-core.mjs';

describe('P2-1 — auto-dedup stamping never re-stamps an already-superseded row', () => {
  let dir, dbPath, db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mem-p2-dedup-'));
    dbPath = join(dir, 'p2.db');
    db = new Database(dbPath);
    initSchema(db);
    // observations.memory_session_id is a real FK — seed the session or every INSERT below
    // fails with "FOREIGN KEY constraint failed" rather than exercising the guard.
    const now = Date.now();
    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('p2-sess', 'p2-mem', 'p2--proj', ?, ?, 'active')
    `,
    ).run(new Date(now).toISOString(), now);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function seed({ title, supersededAt = null, supersededBy = null }) {
    return Number(
      db
        .prepare(
          `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative,
        concepts, facts, files_read, files_modified, importance, compressed_into, access_count,
        superseded_at, superseded_by, created_at, created_at_epoch)
      VALUES ('p2-mem', 'p2--proj', ?, 'bugfix', ?, '', '', '', '', '[]', '[]', 2, NULL, 0, ?, ?, ?, ?)
    `,
        )
        .run(`${title} body`, title, supersededAt, supersededBy, new Date().toISOString(), Date.now())
        .lastInsertRowid,
    );
  }

  const readRow = (id) =>
    db.prepare('SELECT superseded_at, superseded_by FROM observations WHERE id = ?').get(id);

  // FAILS IF: the `AND superseded_at IS NULL` guard is dropped — the numeric chain
  // A.superseded_by = <correction id> is overwritten with the string marker, and the
  // hand-off that citation-tracker decay and timeline re-anchoring follow dead-ends.
  it('a numeric supersession chain survives a concurrent dedup stamp', () => {
    const correctionId = seed({ title: 'Vector rebuild drops the alias column' });
    const oldId = seed({
      title: 'Vector rebuild drops the alias column',
      supersededAt: Date.now() - 1000,
      supersededBy: String(correctionId), // mirrors lib/save-observation.mjs supersedes write
    });

    // The pass selected `oldId` while it was still live; by the time it stamps, the user's
    // correction has landed. The guard is what makes this a no-op instead of a clobber.
    const changed = stampDedupSuperseded(db, [oldId], 'auto-dedup-fuzzy');

    expect(changed, 'guard let the stamp through').toBe(0);
    expect(String(readRow(oldId).superseded_by), 'numeric supersession chain was clobbered').toBe(
      String(correctionId),
    );
  });

  // Positive control: the guard must not break the feature it protects.
  it('a live row is still stamped with the channel marker', () => {
    const liveId = seed({ title: 'Episode flush groups by content session' });

    const changed = stampDedupSuperseded(db, [liveId], 'auto-dedup-fuzzy');

    expect(changed).toBe(1);
    const row = readRow(liveId);
    expect(row.superseded_at).toBeTruthy();
    expect(row.superseded_by).toBe('auto-dedup-fuzzy');
  });

  // A mixed batch is the realistic shape: one id raced, the rest did not. The guard must
  // skip only the raced row — an all-or-nothing statement would lose the whole pass.
  it('skips only the raced row in a mixed batch', () => {
    const keeperId = seed({ title: 'Registry cache warms twice' });
    const racedId = seed({
      title: 'Registry cache warms twice',
      supersededAt: Date.now() - 1000,
      supersededBy: String(keeperId),
    });
    const liveA = seed({ title: 'Handoff state survives a clear' });
    const liveB = seed({ title: 'Handoff state survives a clear' });

    const changed = stampDedupSuperseded(db, [racedId, liveA, liveB], 'auto-dedup');

    expect(changed).toBe(2);
    expect(String(readRow(racedId).superseded_by)).toBe(String(keeperId));
    expect(readRow(liveA).superseded_by).toBe('auto-dedup');
    expect(readRow(liveB).superseded_by).toBe('auto-dedup');
  });

  it('is a no-op on an empty selection', () => {
    expect(stampDedupSuperseded(db, [], 'auto-dedup')).toBe(0);
    expect(stampDedupSuperseded(db, null, 'auto-dedup')).toBe(0);
  });

  // Both channels must reach the guard through this one function. If a caller ever
  // re-inlines its own UPDATE, the asymmetry that caused P2-1 is back — and the seam test
  // above would still pass while the real path regressed.
  it('hook.mjs stamps through the shared helper in both dedup channels', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname } = await import('path');
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
    const src = readFileSync(join(repo, 'hook.mjs'), 'utf8');

    const inlineStamps = [
      ...src.matchAll(/UPDATE observations SET superseded_at[^`]*superseded_by\s*=\s*'auto-dedup/g),
    ];
    expect(
      inlineStamps.map((m) => m[0]),
      'hook.mjs re-inlined a dedup UPDATE instead of calling stampDedupSuperseded',
    ).toEqual([]);

    expect(src).toContain("stampDedupSuperseded(db, removeIds, 'auto-dedup')");
    expect(src).toContain("stampDedupSuperseded(db, fuzzyRemoveIds, 'auto-dedup-fuzzy')");
  });
});

// P2-10: the type-quality table existed three times — scoring-sql.mjs (as a SQL CASE),
// hook-context.mjs and hook-memory.mjs (as JS objects) — with "aligned with (R2)" comments
// as the only thing keeping them equal. The SQL form is now generated from the JS table.
// What must be proven is that generating it did not change what SQLite computes.

describe('P2-10 — the type-quality table has one source', () => {
  let dir, db;

  // The literal that shipped before the generator. Kept verbatim so the test compares
  // against what production actually evaluated, not against the generator's own output.
  const PRE_GENERATOR_CASE = `(
  CASE o.type
    WHEN 'decision'  THEN 1.5
    WHEN 'discovery' THEN 1.3
    WHEN 'bugfix'    THEN 1.1
    WHEN 'feature'   THEN 1.0
    WHEN 'refactor'  THEN 0.6
    WHEN 'change'    THEN 0.5
    ELSE 1.0
  END
)`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mem-p2-tq-'));
    db = new Database(join(dir, 'tq.db'));
    db.exec('CREATE TABLE o (type TEXT)');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  // FAILS IF: the generator emits a different weight, drops a type, or changes the ELSE —
  // evaluated by SQLite, so whitespace differences are correctly ignored and value
  // differences are not.
  it('the generated CASE evaluates identically to the literal it replaced', async () => {
    const { TYPE_QUALITY_CASE } = await import('../scoring-sql.mjs');
    const types = ['decision', 'discovery', 'bugfix', 'feature', 'refactor', 'change', 'note', '', null];

    for (const t of types) {
      db.prepare('DELETE FROM o').run();
      db.prepare('INSERT INTO o (type) VALUES (?)').run(t);
      const now = db.prepare(`SELECT ${TYPE_QUALITY_CASE} AS w FROM o`).get().w;
      const before = db.prepare(`SELECT ${PRE_GENERATOR_CASE} AS w FROM o`).get().w;
      expect(now, `weight changed for type ${JSON.stringify(t)}`).toBe(before);
    }
  });

  it('the JS table and the SQL form agree on every type', async () => {
    const { TYPE_QUALITY, TYPE_QUALITY_DEFAULT, TYPE_QUALITY_CASE } = await import('../scoring-sql.mjs');

    for (const [type, weight] of Object.entries(TYPE_QUALITY)) {
      db.prepare('DELETE FROM o').run();
      db.prepare('INSERT INTO o (type) VALUES (?)').run(type);
      expect(db.prepare(`SELECT ${TYPE_QUALITY_CASE} AS w FROM o`).get().w).toBe(weight);
    }

    db.prepare('DELETE FROM o').run();
    db.prepare('INSERT INTO o (type) VALUES (?)').run('not-a-known-type');
    expect(db.prepare(`SELECT ${TYPE_QUALITY_CASE} AS w FROM o`).get().w).toBe(TYPE_QUALITY_DEFAULT);
  });

  // The point of the round: no consumer may re-declare the table locally. A literal copy
  // would pass every assertion above while re-opening the drift.
  it('no consumer re-declares the weights locally', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname } = await import('path');
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

    for (const f of ['hook-context.mjs', 'hook-memory.mjs']) {
      const src = readFileSync(join(repo, f), 'utf8');
      const localTable = src.match(/(?:const|let)\s+\w+\s*=\s*\{[^}]*decision\s*:\s*1\.5[^}]*\}/);
      expect(localTable?.[0], `${f} re-declares the type-quality table locally`).toBeUndefined();
      expect(src, `${f} does not import the shared table`).toMatch(
        /TYPE_QUALITY.*from '\.\/scoring-sql\.mjs'/s,
      );
    }
  });
});

// P2-11: SessionStart ran two full-table conditional UPDATEs on every boot to mark
// auto-compressible rows, outside the 24h auto-maintain gate that already guarded decay,
// purge and backup. Nothing about starting a session makes a 30-day-old row newly
// compressible — the work is maintenance, and every boot paid for it. It now runs on the
// maintain cadence. The predicates and the project scope are unchanged: the cadence moved,
// not what gets marked.

describe('P2-11 — auto-compress marking runs on the maintain cadence, not every boot', () => {
  let dir, db;
  const PROJECT = 'p2--markproj';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mem-p2-mark-'));
    db = new Database(join(dir, 'mark.db'));
    initSchema(db);
    const now = Date.now();
    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('mk-sess', 'mk-mem', ?, ?, ?, 'active')
    `,
    ).run(PROJECT, new Date(now).toISOString(), now);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function seedObs({
    title,
    ageDays,
    importance = 1,
    lesson = null,
    facts = '[]',
    injectionCount = 0,
    project = PROJECT,
  }) {
    const epoch = Date.now() - ageDays * 86400000;
    return Number(
      db
        .prepare(
          `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative,
        concepts, facts, files_read, files_modified, importance, compressed_into, access_count,
        injection_count, lesson_learned, created_at, created_at_epoch)
      VALUES ('mk-mem', ?, ?, 'change', ?, '', '', '', ?, '[]', '[]', ?, NULL, 0, ?, ?, ?, ?)
    `,
        )
        .run(
          project,
          `${title} body`,
          title,
          facts,
          importance,
          injectionCount,
          lesson,
          new Date(epoch).toISOString(),
          epoch,
        ).lastInsertRowid,
    );
  }

  const compressedInto = (id) =>
    db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(id).compressed_into;

  it('marks the aged low-importance rows the 30d pass always marked', async () => {
    const { markAutoCompressible } = await import('../lib/maintain-core.mjs');
    const old = seedObs({ title: 'Worked on the parser', ageDays: 45 });
    const recent = seedObs({ title: 'Worked on the lexer', ageDays: 3 });

    const res = markAutoCompressible(db, PROJECT);

    expect(res.aged).toBe(1);
    expect(compressedInto(old)).toBe(-1); // COMPRESSED_AUTO
    expect(compressedInto(recent)).toBeNull();
  });

  // The protections the 30d predicate carries are the reason the pass is safe to run at
  // all; a move that silently dropped one would be invisible until rows went missing.
  //
  // The titles here deliberately avoid the LOW_SIGNAL shapes ('Modified '/'Worked on '/
  // 'Reviewed '/'Error…'). The accelerated 7d pass does NOT carry the injection_count
  // guard — that asymmetry is pre-existing, and a 'Worked on …' title would be swept by
  // the noise pass before the 30d protections were ever exercised.
  it('the 30d pass still protects lessons, injected rows, and high importance', async () => {
    const { markAutoCompressible } = await import('../lib/maintain-core.mjs');
    const withLesson = seedObs({ title: 'Investigated auth', ageDays: 45, lesson: 'real takeaway' });
    const injected = seedObs({ title: 'Investigated cache', ageDays: 45, injectionCount: 3 });
    const important = seedObs({ title: 'Investigated schema', ageDays: 45, importance: 3 });
    const otherProject = seedObs({ title: 'Investigated other', ageDays: 45, project: 'p2--elsewhere' });

    markAutoCompressible(db, PROJECT);

    expect(compressedInto(withLesson), 'a lesson-bearing row was auto-hidden').toBeNull();
    expect(compressedInto(injected), 'an injected row was auto-hidden').toBeNull();
    expect(compressedInto(important), 'an importance>1 row was auto-hidden').toBeNull();
    expect(compressedInto(otherProject), 'marking escaped its project scope').toBeNull();
  });

  // The accelerated 7d pass has different protections (no injection_count guard, requires
  // empty facts and a LOW_SIGNAL title shape) — it is a separate predicate, tested apart.
  it('marks LOW_SIGNAL noise on the accelerated 7d window', async () => {
    const { markAutoCompressible } = await import('../lib/maintain-core.mjs');
    const noise = seedObs({ title: 'Modified a.mjs, b.mjs', ageDays: 10 });
    const withFacts = seedObs({ title: 'Modified c.mjs', ageDays: 10, facts: '["a fact"]' });
    const notNoiseShape = seedObs({ title: 'Investigated the flush race', ageDays: 10 });

    const res = markAutoCompressible(db, PROJECT);

    expect(res.noise).toBe(1);
    expect(compressedInto(noise)).toBe(-1);
    expect(compressedInto(withFacts), 'a fact-bearing row was swept as noise').toBeNull();
    expect(compressedInto(notNoiseShape), 'a non-LOW_SIGNAL title was swept as noise').toBeNull();
  });

  it('is a no-op without a project scope', async () => {
    const { markAutoCompressible } = await import('../lib/maintain-core.mjs');
    seedObs({ title: 'Worked on the parser', ageDays: 45 });
    expect(markAutoCompressible(db, undefined)).toEqual({ aged: 0, noise: 0 });
  });

  // The point of the move: SessionStart's transaction must no longer carry these UPDATEs,
  // and the maintain worker must. Predicates alone can't show that — only the call sites.
  it('the marking call sites moved from SessionStart to auto-maintain', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname } = await import('path');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'hook.mjs'), 'utf8');

    const dbMutations = src.slice(
      src.indexOf('function runSessionStartDbMutations'),
      src.indexOf('function runSessionStartAutoMaintain'),
    );
    expect(dbMutations, 'SessionStart still runs a compress-marking UPDATE every boot').not.toMatch(
      /UPDATE observations SET compressed_into/,
    );

    const autoMaintain = src.slice(src.indexOf('function runSessionStartAutoMaintain'));
    expect(autoMaintain, 'auto-maintain does not run the marking').toMatch(
      /markAutoCompressibleIfDue\(db, project\)/,
    );

    // v3.75.1: the marking must sit BEFORE the global `shouldMaintain` block, on its own
    // per-project gate. Inside it — where v3.75.0 put it — one global 24h stamp meant
    // only the first project of the day ever got marked.
    const markAt = autoMaintain.indexOf('markAutoCompressibleIfDue(db, project)');
    const gateAt = autoMaintain.indexOf('let shouldMaintain');
    expect(markAt, 'marking call not found in auto-maintain').toBeGreaterThan(-1);
    expect(gateAt, 'global gate not found in auto-maintain').toBeGreaterThan(-1);
    expect(
      markAt,
      'the marking is back inside the GLOBAL 24h gate — that is the v3.75.0 regression',
    ).toBeLessThan(gateAt);
  });
});
