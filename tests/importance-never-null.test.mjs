// `observations.importance` is `INTEGER DEFAULT 1` but NULLABLE, and two maintenance
// faces read it differently — audit P3-14.
//
//   search-scoring.runIdleCleanup   `importance <= 1`             NULL <= 1 is NULL → SKIP
//   maintain-core.decayAndMarkIdle  `COALESCE(importance,1) = 1`  → 1 = 1        → MARK
//
// So a NULL-importance row is protected on the MCP idle face and queued for purge on the
// CLI/hook face. The audit deliberately did not "fix" this by adding COALESCE: that makes
// the MCP face START destroying those rows, i.e. it closes a divergence by widening the
// damage. And it did not migrate the column to NOT NULL either, because that means
// rebuilding `observations` — a table carrying FTS5 triggers and several indexes — for a
// population measured at ZERO rows on the live DB (2026-09-04, 3779 observations).
//
// The route taken instead: make NULL unwritable at the two shared write cores, so the
// divergence becomes unreachable by construction rather than by luck, and report any row
// that arrived by another route (a hand-edited DB, an old version, a restored dump)
// through `doctor --session-audit`.
//
// Worth pinning because the shape is not obvious: better-sqlite3 binds BOTH `null` and
// `undefined` as SQL NULL and throws on neither, so "the caller would have crashed first"
// was never true.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { auditSessionConsistency } from '../schema.mjs';
import { insertObservationRow, applyObsUpdate } from '../lib/observation-write.mjs';
import { decayAndMarkIdle } from '../lib/maintain-core.mjs';
import { runIdleCleanup } from '../search-scoring.mjs';
import { COMPRESSED_PENDING_PURGE } from '../utils.mjs';

const PROJECT = 'proj-imp';
const DAY = 86400000;
let db;

beforeEach(() => {
  db = createTestDb();
  insertSession(db, { id: 'sess-1', project: PROJECT });
});

const base = (extra = {}) => ({
  memory_session_id: 'sess-1',
  project: PROJECT,
  text: 'body',
  type: 'change',
  title: 'a row',
  narrative: 'body',
  created_at: new Date().toISOString(),
  created_at_epoch: Date.now(),
  ...extra,
});
const impOf = (id) => db.prepare('SELECT importance AS v FROM observations WHERE id = ?').get(id).v;

describe('better-sqlite3 binds nullish as NULL — the premise', () => {
  it('binds both null and undefined to SQL NULL without throwing', () => {
    // If this ever changes, the coercion below stops being load-bearing and the
    // reasoning in this file needs revisiting rather than the code.
    const t = new Database(':memory:');
    t.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, importance INTEGER DEFAULT 1)');
    t.prepare('INSERT INTO t (importance) VALUES (?)').run(null);
    t.prepare('INSERT INTO t (importance) VALUES (?)').run(undefined);
    expect(t.prepare('SELECT COUNT(*) c FROM t WHERE importance IS NULL').get().c).toBe(2);
    t.close();
  });
});

describe('insertObservationRow never writes a NULL importance', () => {
  it('coerces an explicit null', () => {
    expect(impOf(insertObservationRow(db, base({ importance: null })))).toBe(1);
  });

  it('coerces an explicit undefined — an own property, so the default lookup is skipped', () => {
    // This is the shape that made the trap reachable: OBS_DEFAULTS is consulted only when
    // the key is ABSENT, so `{importance: undefined}` bound undefined → NULL.
    expect(impOf(insertObservationRow(db, base({ importance: undefined })))).toBe(1);
  });

  it('still defaults an absent key to 1', () => {
    expect(impOf(insertObservationRow(db, base()))).toBe(1);
  });

  it('leaves a real value alone', () => {
    // Counterweight: a coercion that clamped everything to 1 would satisfy every case above.
    expect(impOf(insertObservationRow(db, base({ importance: 3 })))).toBe(3);
    expect(impOf(insertObservationRow(db, base({ importance: 2 })))).toBe(2);
  });
});

describe('applyObsUpdate never writes a NULL importance', () => {
  it('coerces an explicit null while still reporting the column as updated', () => {
    const id = insertObservationRow(db, base({ importance: 3 }));
    const cols = applyObsUpdate(db, id, { importance: null });
    expect(cols).toContain('importance');
    expect(impOf(id)).toBe(1);
  });

  it('leaves a real value alone, and an absent key untouched', () => {
    const id = insertObservationRow(db, base({ importance: 3 }));
    expect(applyObsUpdate(db, id, { importance: 2 })).toContain('importance');
    expect(impOf(id)).toBe(2);
    applyObsUpdate(db, id, { title: 'renamed' });
    expect(impOf(id)).toBe(2);
  });
});

describe('doctor --session-audit reports rows that arrived NULL by another route', () => {
  it('counts them and fails the audit', () => {
    const id = insertObservationRow(db, base({ importance: 2 }));
    expect(
      auditSessionConsistency(db).obs_importance_null,
      'the counter is non-zero on a clean DB — it is measuring something else',
    ).toBe(0);

    // Only reachable by writing around the cores — which is exactly the population this
    // backstop exists for. Doubles as the ruler self-check: the count CAN be non-zero.
    db.prepare('UPDATE observations SET importance = NULL WHERE id = ?').run(id);
    const audit = auditSessionConsistency(db);
    expect(audit.obs_importance_null).toBe(1);
    expect(audit.healthy, 'a NULL importance passed the audit as healthy').toBe(false);
  });
});

describe('the divergence this closes, pinned as it stands today', () => {
  it('a NULL-importance row is skipped by the MCP face and marked by the CLI/hook face', () => {
    // Deliberately NOT fixed by aligning the two predicates: adding COALESCE to
    // runIdleCleanup makes it START marking these rows for purge. This case documents
    // why the write-side fix was chosen instead, and will red if someone aligns them —
    // at which point the choice is being revisited on purpose rather than by accident.
    const old = Date.now() - 40 * DAY;
    const mk = () => {
      const id = insertObservationRow(db, base({ importance: 1, created_at_epoch: old }));
      db.prepare('UPDATE observations SET importance = NULL WHERE id = ?').run(id);
      return id;
    };
    const forMcp = mk();
    const forCli = mk();

    runIdleCleanup(db);
    expect(
      db.prepare('SELECT compressed_into v FROM observations WHERE id = ?').get(forMcp).v,
      'runIdleCleanup started marking NULL-importance rows',
    ).not.toBe(COMPRESSED_PENDING_PURGE);

    decayAndMarkIdle(db, { projectFilter: '', baseParams: [], staleAge: Date.now() - 30 * DAY, opCap: 1000 });
    expect(
      db.prepare('SELECT compressed_into v FROM observations WHERE id = ?').get(forCli).v,
      'decayAndMarkIdle stopped treating NULL as importance 1',
    ).toBe(COMPRESSED_PENDING_PURGE);
  });
});
