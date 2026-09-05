// R4 E2E audit (LOW, citation loop) — two promote/demote defects:
//   fix 12 — updatePromote never cleared demoted_at, so a demote-then-late-cite row
//     stayed flagged "recently demoted" in citation-stats telemetry despite being restored.
//   fix 13 — promote/demote used bare `importance ± 1`; a NULL-importance row wrote NULL
//     (below floor, invisible to injection). Every other importance-write COALESCEs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyCitationDecay } from '../lib/citation-tracker.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

describe('R4 citation promote/demote hardening', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'p' });
  });
  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  function makeObs(overrides = {}) {
    const id = insertObs(db, {
      sessionId: 'sess-1',
      project: 'p',
      type: 'bugfix',
      title: 't',
      importance: 2,
      ...overrides,
    }).lastInsertRowid;
    if (overrides.uncited_streak !== undefined) {
      db.prepare('UPDATE observations SET uncited_streak = ? WHERE id = ?').run(overrides.uncited_streak, id);
    }
    return id;
  }

  it('fix 12: a late citation that undoes a demotion also clears demoted_at', () => {
    const id = makeObs({ importance: 2, uncited_streak: 2 });
    const r1 = applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1'); // uncited → demote
    expect(r1.demoted).toBe(1);
    expect(db.prepare('SELECT demoted_at FROM observations WHERE id=?').get(id).demoted_at).not.toBeNull(); // stamped

    applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 'sess-1'); // late cite → re-promote
    const row = db.prepare('SELECT importance, demoted_at FROM observations WHERE id=?').get(id);
    expect(row.importance).toBe(2); // D#179: never moved in either direction
    expect(row.demoted_at).toBeNull(); // no longer misreported as "recently demoted"
  });

  // fix 13 guarded the COALESCE on the promote's `importance` write: without it a
  // NULL-importance row was written back as NULL, below the floor and invisible to
  // injection. D#179 removed that write entirely, so the defect is gone by
  // construction and the case is re-pointed at the property that replaced it.
  //
  // Which re-introduction each half catches, since neither covers both:
  //   - a COALESCE'd re-add (`MIN(3, COALESCE(importance,1)+1)`) turns this NULL
  //     into 2 → caught HERE;
  //   - a bare re-add (`importance + 1`) leaves NULL as NULL → invisible here,
  //     caught by the non-NULL rows in citation-decay.test.mjs's D#179 sweep.
  it('D#179: a citation leaves even a NULL-importance row exactly as it found it', () => {
    const id = makeObs({ importance: 2, uncited_streak: 0 });
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1'); // inject (uncited, streak→1)
    db.prepare('UPDATE observations SET importance = NULL WHERE id = ?').run(id);
    const r = applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 'sess-1'); // late cite → promote
    expect(r.promoted).toBe(1); // the promote branch really ran…
    const after = db.prepare('SELECT importance, cited_count FROM observations WHERE id=?').get(id);
    expect(after.cited_count).toBe(1); // …and did its actual job…
    expect(after.importance).toBeNull(); // …without touching importance
  });
});
