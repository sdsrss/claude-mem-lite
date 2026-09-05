// Tests for lib/delete-core.mjs — the shared hard-delete orchestration behind the
// CLI `delete` command and the MCP mem_delete tool. Before extraction each surface
// inlined a byte-for-byte copy kept in sync by parity comments (the project's #1
// drift risk); these lock the behavior both surfaces depend on into one place.
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { initSchema } from '../schema.mjs';
import { deleteObservations } from '../lib/delete-core.mjs';

// observations.memory_session_id is an FK to sdk_sessions; seed the default session
// so insertObs (which defaults sessionId → 'sess-1') satisfies it under FK-ON tests.
function freshDb() {
  const db = createTestDb();
  insertSession(db, { id: 'sess-1' });
  return db;
}

describe('deleteObservations (shared delete-core)', () => {
  it("strips the deleted id out of other rows' related_ids", () => {
    const db = freshDb();
    insertObs(db, { title: 'First', text: 'first' }); // #1
    insertObs(db, { title: 'Second', text: 'second', relatedIds: '[1]' }); // #2 references #1
    insertObs(db, { title: 'Third', text: 'third', relatedIds: '[1,3]' }); // #3 references #1 + itself

    const result = deleteObservations(db, [1]);

    expect(result.deleted).toBe(1);
    expect(
      JSON.parse(db.prepare('SELECT related_ids FROM observations WHERE id = 2').get().related_ids),
    ).toEqual([]);
    expect(
      JSON.parse(db.prepare('SELECT related_ids FROM observations WHERE id = 3').get().related_ids),
    ).toEqual([3]);
  });

  it('recovers rows merged/compressed INTO a deleted keeper (compressed_into → NULL)', () => {
    const db = freshDb();
    insertObs(db, { title: 'Keeper', text: 'keeper', importance: 3 }); // #1
    insertObs(db, { title: 'Child', text: 'child', compressedInto: 1 }); // #2 merged into #1

    const result = deleteObservations(db, [1]);

    expect(result.deleted).toBe(1);
    expect(result.recoveredChildren).toBe(1);
    const child = db.prepare('SELECT compressed_into FROM observations WHERE id = 2').get();
    expect(child).toBeDefined(); // child survived the keeper's deletion
    expect(child.compressed_into).toBeNull(); // and was resurfaced as live
  });

  it('does not count a child that is itself being deleted in the same call as recovered', () => {
    const db = freshDb();
    insertObs(db, { title: 'Keeper', text: 'keeper' }); // #1
    insertObs(db, { title: 'Child', text: 'child', compressedInto: 1 }); // #2 merged into #1

    const result = deleteObservations(db, [1, 2]); // delete keeper AND its child together

    expect(result.deleted).toBe(2);
    expect(result.recoveredChildren).toBe(0); // #2 did not survive, so it is not a recovery
    expect(db.prepare('SELECT id FROM observations WHERE id IN (1,2)').all()).toEqual([]);
  });

  it('leaves a malformed related_ids value untouched (stricter of the two originals)', () => {
    const db = freshDb();
    insertObs(db, { title: 'First', text: 'first' }); // #1
    insertObs(db, { title: 'Bad', text: 'bad', relatedIds: '[1,"x"]' }); // non-integer array

    deleteObservations(db, [1]);

    // Not a well-formed integer array → not rewritten (kept verbatim, not reshaped).
    expect(db.prepare('SELECT related_ids FROM observations WHERE id = 2').get().related_ids).toBe('[1,"x"]');
  });

  it('returns the exact deleted count for the ids that actually existed', () => {
    const db = freshDb();
    insertObs(db, { title: 'Present', text: 'present' }); // #1

    const result = deleteObservations(db, [1, 9999]); // 9999 does not exist

    expect(result.deleted).toBe(1); // only the existing row is counted
    expect(result.recoveredChildren).toBe(0);
  });

  it('returns null snapshotPath on a :memory: DB (snapshot step is a safe no-op)', () => {
    const db = freshDb();
    insertObs(db, { title: 'X', text: 'x' });
    const result = deleteObservations(db, [1]);
    expect(result.snapshotPath).toBeNull(); // snapshotDb ran and no-oped for :memory:
  });

  describe('file-backed DB — snapshot is actually taken', () => {
    let tmp;
    afterEach(() => {
      if (tmp) {
        rmSync(tmp, { recursive: true, force: true });
        tmp = null;
      }
    });

    it('writes a pre-delete .bak snapshot before the delete', () => {
      tmp = mkdtempSync(join(tmpdir(), 'delete-core-'));
      const dbPath = join(tmp, 'mem.db');
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-1' });
      insertObs(db, { title: 'Doomed', text: 'doomed' }); // #1

      const result = deleteObservations(db, [1]);

      expect(result.deleted).toBe(1);
      expect(result.snapshotPath).toMatch(/\.pre-delete-.*\.bak$/);
      expect(existsSync(result.snapshotPath)).toBe(true); // real pre-image on disk
      db.close();
    });
  });
});
