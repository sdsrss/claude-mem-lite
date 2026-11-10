// D#593 attempt 3, S2: rebuildFTS and rebuildIndexes write through checkedWrite, so on a store whose
// freelist lists a live page they roll back instead of overwriting rows (D#591), on a VACUUMed store
// too, whose pre-write integrity check skips the freelist (lesson #1051).
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, rebuildFTS, rebuildIndexes } from '../schema.mjs';
import { intactObservations, writeCrossLinkedStore } from './test-helpers.mjs';

const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'cml-rebuild-checked-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});
const FTS = ['observations_fts', 'session_summaries_fts', 'user_prompts_fts', 'events_fts'];

function soundStore() {
  const p = join(tempDir(), 'claude-mem-lite.db');
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  db.close();
  return p;
}

describe.each([
  ['rebuildFTS', rebuildFTS, FTS],
  ['rebuildIndexes', rebuildIndexes, [...FTS, 'indexes']],
])('%s', (name, rebuild, all) => {
  it('rebuilds everything on a sound store and says it was checked', () => {
    const db = new Database(soundStore());
    try {
      const r = rebuild(db);
      expect(r).toMatchObject({ rebuilt: all, errors: [], codes: [], check: 'ok' });
    } finally {
      db.close();
    }
  });

  for (const vacuum of [false, true]) {
    it(`writes nothing on a cross-linked store (vacuum ${vacuum})`, () => {
      const p = join(tempDir(), 'claude-mem-lite.db');
      const { truth } = writeCrossLinkedStore(p, { vacuum });
      const db = new Database(p);
      let r;
      try {
        r = rebuild(db);
      } finally {
        db.close();
      }
      expect(r.check).toBe('damaged');
      expect(r.rebuilt).toEqual([]);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/^not rebuilt: /);
      expect(r.codes[0]).toMatch(/^SQLITE_CORRUPT/);
      expect(r.lines.length).toBeGreaterThan(0);
      expect(intactObservations(p, truth)).toBe(truth.length);
    });
  }

  it('still rebuilds the tables that exist when one is missing, and lists the missing one', () => {
    const p = soundStore();
    const db = new Database(p);
    try {
      db.exec('DROP TABLE events_fts');
      const r = rebuild(db);
      expect(r.check).toBe('ok');
      expect(r.rebuilt).toEqual(all.filter((t) => t !== 'events_fts'));
      expect(r.errors).toEqual(['events_fts: not found']);
      expect(r.codes).toEqual([null]);
    } finally {
      db.close();
    }
  });
});
