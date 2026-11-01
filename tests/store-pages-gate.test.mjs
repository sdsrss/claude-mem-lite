// D#593: every index rebuild checks the store's pages first (lib/store-pages.mjs) and writes nothing
// when they are damaged or could not be checked. A rebuild frees pages and allocates new ones, so on a
// store whose freelist lists a page a table still uses it writes the new index over that table's rows:
// v6.30.8's doctor FTS step, `fts-check rebuild`, `mem_fts_check rebuild` and the opener's FTS branch
// did that on the D#546 regression set (docs/audits/20261025-v6.30.9-pretag-r1-defects.md).

import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../schema.mjs';
import { intactObservations, makeFixtureTracker, writeCrossLinkedStore } from './test-helpers.mjs';

const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());
const dataDir = () => fixtures.track(mkdtempSync(join(tmpdir(), 'cml-pagegate-')));
const storeIn = (dir) => join(dir, 'claude-mem-lite.db');
/** sha1 of the main file and its log together (a missing log reads as an empty one). */
const sha = (path) => {
  const h = createHash('sha1').update(readFileSync(path));
  if (existsSync(`${path}-wal`)) h.update(readFileSync(`${path}-wal`));
  return h.digest('hex');
};

describe('rebuildFTS and rebuildIndexes write nothing on page-level damage', () => {
  for (const name of ['rebuildFTS', 'rebuildIndexes']) {
    for (const vacuum of [false, true]) {
      it(`${name}${vacuum ? ' on a VACUUMed store' : ''}`, () => {
        const { path, truth, linked } = writeCrossLinkedStore(storeIn(dataDir()), { vacuum });
        expect(intactObservations(path, truth), 'premise').toBe(truth.length);
        const db = new Database(path);
        let r;
        let before;
        try {
          // Taken on the open handle: what this handle's own rebuild would add to the log.
          before = sha(path);
          r = schema[name](db);
          expect(sha(path), 'the rebuild wrote to the store or its log').toBe(before);
        } finally {
          db.close();
        }
        expect(intactObservations(path, truth), 'rows the rebuild overwrote').toBe(truth.length);
        expect(r.rebuilt).toEqual([]);
        expect(r.pages).toMatchObject({ state: 'damaged' });
        expect(r.errors).toEqual([expect.stringMatching(/^not rebuilt: the database's pages are damaged/)]);
        expect(r.errors[0]).toContain(`page ${linked[0]}: in the freelist and in observations`);
        expect(r.codes).toEqual(['SQLITE_CORRUPT']);
      });
    }
  }

  it('still rebuilds a store whose only damage is the search index', () => {
    const { path, truth } = writeCrossLinkedStore(storeIn(dataDir()), { links: 0 });
    const db = new Database(path);
    try {
      expect(schema.checkFTSIntegrity(db).healthy, 'premise').toBe(false);
      const r = schema.rebuildIndexes(db);
      expect(r.errors).toEqual([]);
      expect(r.rebuilt).toEqual([
        'observations_fts',
        'session_summaries_fts',
        'user_prompts_fts',
        'events_fts',
        'indexes',
      ]);
      expect(r.pages).toMatchObject({ state: 'ok' });
    } finally {
      db.close();
    }
    // A fresh handle: what the rebuild committed, not what its own transaction sees.
    const after = new Database(path);
    try {
      expect(schema.checkFTSIntegrity(after).healthy).toBe(true);
    } finally {
      after.close();
    }
    expect(intactObservations(path, truth)).toBe(truth.length);
  });

  // "Could not check" is not "sound": a rebuild is refused, with the reason the check gave.
  it('refuses when the pages could not be checked', () => {
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);
      const r = schema.rebuildFTS(db);
      expect(r.rebuilt).toEqual([]);
      expect(r.pages).toMatchObject({ state: 'unchecked' });
      expect(r.errors).toEqual([
        "not rebuilt: the database's pages could not be checked first (an in-memory database has no file to read)",
      ]);
      expect(r.codes).toEqual([null]);
    } finally {
      db.close();
    }
  });
});
