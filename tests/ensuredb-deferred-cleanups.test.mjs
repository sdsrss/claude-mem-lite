// Regression: ensureDb() must run the sentinel-gated deferred data cleanups on
// every open (audit P1-5 wiring).
//
// Bug (pre-fix): the orphan-observation-{files,vectors} + project-name cleanups
// were extracted from initSchema into runDeferredCleanups() — gated per-step by a
// migration_cleanups row so a transient failure retries instead of being stamped
// past forever (see lesson #8769). But the runner was never wired into any
// production opener: ensureDb() called only initSchema(), so the cleanups ran
// NOWHERE outside tests, even though schema.mjs:766 claims they run "on EVERY
// ensureDb". Net effect of the half-fix: cleanups silently stopped executing.
//
// This file MUST set CLAUDE_MEM_DIR and dynamic-import schema.mjs BEFORE any
// static import binds DB_DIR — otherwise ensureDb() would open the real user DB
// at ~/.claude-mem-lite (a destructive-path violation).

import { describe, test, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'mem-ensuredb-p15-'));
process.env.CLAUDE_MEM_DIR = tmp;

// env is set above → schema.mjs binds DB_DIR/DB_PATH to our sandbox tmpdir.
const { ensureDb } = await import('../schema.mjs');

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('ensureDb deferred-cleanup wiring (audit P1-5)', () => {
  test('a fresh ensureDb() open marks every deferred cleanup done', () => {
    const db = ensureDb();
    try {
      const marks = db
        .prepare('SELECT name FROM migration_cleanups')
        .all()
        .map((r) => r.name);
      expect(marks).toEqual(
        expect.arrayContaining([
          'orphan-observation-files',
          'orphan-observation-vectors',
          'normalize-project-names',
        ]),
      );
    } finally {
      db.close();
    }
  });

  test('ensureDb() re-runs an unmarked cleanup on the next open (orphan scrubbed)', () => {
    // First open marks all cleanups done. Simulate a prior transient failure by
    // clearing one sentinel and seeding an orphan, then reopen via ensureDb().
    const db1 = ensureDb();
    db1.pragma('foreign_keys = OFF');
    db1
      .prepare(
        'INSERT INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)',
      )
      .run(424242, Buffer.alloc(8), 'v1', Date.now());
    db1.prepare("DELETE FROM migration_cleanups WHERE name = 'orphan-observation-vectors'").run();
    db1.close();

    const db2 = ensureDb(); // must re-run the unmarked cleanup
    try {
      expect(
        db2.prepare('SELECT COUNT(*) AS c FROM observation_vectors WHERE observation_id = 424242').get().c,
      ).toBe(0);
      expect(
        db2
          .prepare("SELECT COUNT(*) AS c FROM migration_cleanups WHERE name = 'orphan-observation-vectors'")
          .get().c,
      ).toBe(1);
    } finally {
      db2.close();
    }
  });
});
