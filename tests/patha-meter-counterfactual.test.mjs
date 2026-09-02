// The D#214 meter's arm B must leave NO trace — this file is the regression test for the
// defect the v3.90.0 pre-tag correctness review reproduced.
//
// `searchRelevantMemories` is not a read. Every successful call ends with
// `UPDATE observations SET injection_count = injection_count + 1, last_injected_at = ?`,
// and it emits its own `event: 'inject'` metric row. The first version of the meter handed
// that function the live writable handle for its counterfactual arm, which did three
// things, all confirmed by the reviewer with probes:
//
//   1. rows that were NEVER shown to the model reached `injection_count = 1`. That column
//      is read by `noisePenaltyClause` (×0.5 at >=4, ×0.2 at >=8), by `demotePinned`'s
//      `injection_count >= N AND cited_count = 0` predicate, and as the `= 0` GC-eligibility
//      gate — so the meter down-ranked, demoted and GC-protected rows on the strength of a
//      measurement nobody saw;
//   2. the ruler manufactured its own delta: arm A's bump could push a row across the >= 4
//      noise gate before arm B scored the corpus, so a prompt whose honest answer was
//      `suppressed 0 / refilled 0` reported `refilled: 1, setChanged: true`;
//   3. the sibling `inject` meter counted two calls per prompt — on exactly the installs
//      where the D#214 corpus gets gathered, since it is the same env flag.
//
// CLAUDE.md already carried this rule, for `rerank-pool-replay`: "the handle must reject a
// write (`searchRelevantMemories` bumps `injection_count` on every row it returns, so a
// writable handle would move the very noise signal being measured **and** let arm A's
// writes change arm B's scores)". The new ruler quoted that sentence in its own release
// note and then broke it.
//
// Two halves are pinned here, because the flag alone is not the fix:
//   - BEHAVIOUR: `counterfactual: true` writes nothing and emits nothing.
//   - WIRING: `hook.mjs` passes it, AND computes arm B BEFORE the delivered search. The
//     flag with the wrong order still yields defect (2) — arm A's bump would precede arm
//     B's read — so order is asserted by source position, not assumed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { searchRelevantMemories } from '../hook-memory.mjs';
import { DB_DIR } from '../schema.mjs';

// D#207: join(), never `new URL('../X.mjs', import.meta.url)` — the URL form makes knip
// drop the named module from its unused-export report entirely.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function seed() {
  const db = createTestDb();
  insertSession(db, { id: 's1', project: 'p1' });
  const ids = [];
  for (const [title, text] of [
    ['sqlite fts5 rowid match trap', 'the rowid constraint is silently dropped by fts5 match'],
    ['sqlite fts5 tokenizer notes', 'fts5 rowid match tokenizer behaviour on constraint'],
  ]) {
    const r = insertObs(db, {
      sessionId: 's1', project: 'p1', type: 'bugfix', importance: 3,
      title, narrative: text, text, lessonLearned: 'lesson ' + title,
    });
    ids.push(Number(r.lastInsertRowid));
  }
  return { db, ids };
}

const countsOf = (db, ids) => ids.map(id =>
  db.prepare('SELECT COALESCE(injection_count, 0) c FROM observations WHERE id = ?').get(id).c);

describe('counterfactual: true — arm B leaves no trace in the store', () => {
  it('a NORMAL call bumps injection_count (the premise; without it the next case is vacuous)', () => {
    const { db, ids } = seed();
    expect(countsOf(db, ids), 'premise: nothing injected yet').toEqual([0, 0]);
    const got = searchRelevantMemories(db, 'sqlite fts5 rowid match trap', 'p1', []);
    expect(got.length, 'premise: the query must actually return rows').toBeGreaterThan(0);
    const after = countsOf(db, ids);
    expect(after.some(c => c > 0), 'a delivered call MUST record the delivery').toBe(true);
    db.close();
  });

  it('a COUNTERFACTUAL call returns the same rows and bumps nothing', () => {
    const { db, ids } = seed();
    const q = 'sqlite fts5 rowid match trap';
    const cf = searchRelevantMemories(db, q, 'p1', [], { counterfactual: true });
    expect(cf.length, 'the measurement must still measure something').toBeGreaterThan(0);
    expect(countsOf(db, ids), 'no row may be credited for a set nobody saw').toEqual([0, 0]);

    // And it is the same answer a delivered call would have given — a flag that changed
    // the result would make the two arms incomparable, which is worse than the bump.
    const real = searchRelevantMemories(db, q, 'p1', [], { counterfactual: true });
    expect(real.map(r => r.id)).toEqual(cf.map(r => r.id));
    db.close();
  });

  it('does not touch last_injected_at either', () => {
    const { db, ids } = seed();
    searchRelevantMemories(db, 'sqlite fts5 rowid match trap', 'p1', [], { counterfactual: true });
    const stamps = ids.map(id =>
      db.prepare('SELECT last_injected_at FROM observations WHERE id = ?').get(id).last_injected_at);
    expect(stamps.every(s => s === null || s === undefined)).toBe(true);
    db.close();
  });
});

describe('counterfactual: true — arm B emits no `inject` metric row', () => {
  let dir;
  const prev = process.env.CLAUDE_MEM_METRICS;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'patha-cf-')); });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_MEM_METRICS;
    else process.env.CLAUDE_MEM_METRICS = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  // hook-memory.mjs resolves DB_DIR at import time, so the metric file cannot be
  // redirected here. Assert the gate at its own level instead: with metrics ENABLED, a
  // counterfactual call must add no row to whatever sink is configured. Counting the
  // sink's rows before and after keeps this independent of where that sink is.
  it('adds no metric row where a delivered call adds one', () => {
    process.env.CLAUDE_MEM_METRICS = '1';
    const { db } = seed();
    const q = 'sqlite fts5 rowid match trap';

    // The SAME DB_DIR `hook-memory.mjs` binds at import, not a guess from the env — a
    // first version guessed `CLAUDE_MEM_DIR`, found nothing, and passed vacuously with
    // 0 === 0. The premise assertion below is what exposed that.
    const sink = join(DB_DIR, 'metrics');
    const linesIn = () => {
      if (!sink || !existsSync(sink)) return 0;
      return readdirSync(sink).filter(f => f.endsWith('.jsonl'))
        .reduce((n, f) => n + readFileSync(join(sink, f), 'utf8').split('\n').filter(Boolean).length, 0);
    };

    // PREMISE FIRST, or this case passes vacuously whenever the sink is unresolvable —
    // and it is unresolvable by default, because hook-memory.mjs binds DB_DIR at import
    // time. A guard that cannot observe its own subject is worse than no guard.
    const start = linesIn();
    const delivered = searchRelevantMemories(db, q, 'p1', []);
    expect(delivered.length, 'premise: the query returns rows').toBeGreaterThan(0);
    const afterDelivered = linesIn();
    expect(
      afterDelivered,
      'premise: a delivered call writes an `inject` row to an observable sink — without ' +
      'this the counterfactual assertion below proves nothing',
    ).toBeGreaterThan(start);

    searchRelevantMemories(db, q, 'p1', [], { counterfactual: true });
    expect(linesIn(), 'a counterfactual must not appear in any meter').toBe(afterDelivered);
    db.close();
  });
});

describe('the WIRING: hook.mjs must use the flag, and must run arm B FIRST', () => {
  const src = readFileSync(join(REPO, 'hook.mjs'), 'utf8');

  it('passes counterfactual: true on the arm-B search', () => {
    expect(src).toMatch(/searchRelevantMemories\([^;]*\{\s*counterfactual:\s*true\s*\}\)/);
  });

  it('computes arm B BEFORE the delivered search, not after it', () => {
    // Order is not a stylistic detail: with the flag but the wrong order, arm A's own
    // injection_count bump still moves the corpus arm B scores, which is how the review
    // got `refilled: 1` on a prompt where the repair does nothing.
    const armB = src.indexOf('counterfactual: true');
    const delivered = src.indexOf('const memories = searchRelevantMemories(');
    expect(armB, 'arm-B call not found — the anchor moved').toBeGreaterThan(-1);
    expect(delivered, 'delivered call not found — the anchor moved').toBeGreaterThan(-1);
    expect(armB, 'arm B must precede the delivered search').toBeLessThan(delivered);
  });

  it('gates the counterfactual on the metrics flag, not on the marker alone', () => {
    // The gate the review deleted with a fully green suite. It is what keeps a second
    // search and a second lesson selection off an install that never asked to measure.
    expect(src).toMatch(/pathAMeterEnabled\(\)\s*&&\s*pathAInjectedIds\.length\s*>\s*0/);
  });

  it('adds the coerced ids to the Key Context exclude rather than replacing it', () => {
    // The arm-isolation property. Replacing it with `[...meterCoerced]` was invisible to
    // the suite before this case existed.
    expect(src).toMatch(/\[\.\.\.excludeB,\s*\.\.\.meterCoerced\]/);
  });
});
