// mem_export's `project` argument: refuse a non-string rather than widen or crash.
//
// runExport used to write `_resolveProjectShared(db, args.project) || args.project`,
// with a comment saying the fallback stopped a falsy resolution from dropping the
// project filter and exporting the whole store. `resolveProject` returns falsy on
// exactly one input a truthy `args.project` can be — a NON-STRING, which it maps to
// null on purpose so `true.includes('--')` stops crashing every project-filtered
// command at the root helper. So the fallback handed that non-string straight back,
// undoing the guard, and `buildExportWhere` then bound it (`TypeError: Invalid value`).
// It could never fire on the case its comment described.
//
// Three cases, and the third is the one that makes the other two mean anything: the
// deletion is only safe while `resolveProject` returns a truthy string for every
// truthy string. If that stops holding, the export filter silently disappears and the
// tool dumps the store — so the invariant is asserted here rather than assumed.

import { describe, it, expect } from 'vitest';
import { handleExportForTest } from '../server.mjs';
import { createTestDb } from './test-helpers.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { resolveProject, _resetProjectCache } from '../project-utils.mjs';

const MINE = 'export--arg-mine';
const OTHER = 'export--arg-other';

function seed() {
  const db = createTestDb();
  const mine = saveObservation(db, {
    project: MINE, type: 'bugfix', title: 'MINE marker',
    content: 'a row belonging to the project under test',
  }).id;
  const other = saveObservation(db, {
    project: OTHER, type: 'bugfix', title: 'OTHER marker',
    content: 'a row belonging to a different project entirely',
  }).id;
  return { db, mine, other };
}

async function idsOf(db, args) {
  const res = await handleExportForTest(db, { format: 'jsonl', limit: 100, ...args });
  return res.content.map((c) => c.text).join('\n').split('\n')
    .filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l).id);
}

describe('mem_export project argument', () => {
  it('filters to the named project — the behaviour the guard must not break', async () => {
    const { db, mine, other } = seed();
    const ids = await idsOf(db, { project: MINE });
    expect(ids).toContain(mine);
    expect(ids, 'project filter stopped working').not.toContain(other);
    db.close();
  });

  it('exports every project when no project is named', async () => {
    const { db, mine, other } = seed();
    const ids = await idsOf(db, {});
    expect(ids).toEqual(expect.arrayContaining([mine, other]));
    db.close();
  });

  for (const bad of [42, true, {}, ['a']]) {
    it(`rejects a non-string project (${JSON.stringify(bad)}) instead of widening or crashing`, async () => {
      // Unreachable over MCP — memExportSchema types it `z.string().optional()` and the
      // SDK validates before the handler — but handleExportForTest is an exported seam
      // that bypasses that, which is the only path the old fallback could ever take.
      const { db } = seed();
      await expect(idsOf(db, { project: bad })).rejects.toThrow(/Invalid project/);
      db.close();
    });
  }

  it('resolveProject never returns a falsy value for a truthy string', async () => {
    // The invariant the deletion rests on. A falsy resolution reaches buildExportWhere,
    // which gates `project = ?` on TRUTHINESS — so it would not narrow to nothing, it
    // would drop the predicate and export the whole store.
    const { db } = seed();
    _resetProjectCache();
    for (const name of [MINE, 'arg-mine', 'no-such-project-anywhere', 'x', '--', 'has spaces']) {
      const got = resolveProject(db, name);
      expect(typeof got, `resolveProject(${JSON.stringify(name)}) returned ${typeof got}`).toBe('string');
      expect(got, `resolveProject(${JSON.stringify(name)}) returned an empty string`).toBeTruthy();
    }
    // ...and the non-string case IS the falsy one, which is why runExport screens it
    // before ever getting here. Pins the reason, not just the outcome.
    expect(resolveProject(db, 42)).toBeNull();
    _resetProjectCache();
    db.close();
  });
});
