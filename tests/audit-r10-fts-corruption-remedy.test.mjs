// R10 P3-9 — a corrupt FTS INDEX and a corrupt DATABASE FILE are different faults and the
// remedies do not overlap.
//
// isDbCorruptionError matched the whole SQLITE_CORRUPT family, including
// SQLITE_CORRUPT_VTAB, which SQLite raises for a damaged FTS5 index over an otherwise
// healthy file. The remedy behind that gate is "delete -wal and -shm and retry", which is
// wrong twice over: it discards every committed-but-uncheckpointed transaction (the
// docblock on isDbCorruptionError says so in as many words, about a different case), and
// it cannot repair an FTS index, which lives in the main database file. The correct action
// is rebuildFTS, which the module already exports.

import { describe, it, expect } from 'vitest';
import { isDbCorruptionError, isFtsCorruptionError, rebuildFTS } from '../schema.mjs';
import { createTestDb } from './test-helpers.mjs';

const err = (code, message = '') => Object.assign(new Error(message), { code });

describe('R10 P3-9 — FTS index corruption is classified apart from file corruption', () => {
  it('SQLITE_CORRUPT_VTAB is FTS corruption, not file corruption', () => {
    const e = err('SQLITE_CORRUPT_VTAB', 'database disk image is malformed');
    expect(isFtsCorruptionError(e), 'not recognised as an FTS fault').toBe(true);
    expect(
      isDbCorruptionError(e),
      'still routed to WAL deletion, which loses committed data and cannot fix an FTS index',
    ).toBe(false);
  });

  it('genuine file corruption still routes to WAL recovery', () => {
    for (const e of [
      err('SQLITE_CORRUPT', 'database disk image is malformed'),
      err('SQLITE_NOTADB', 'file is not a database'),
      err('', 'database disk image is malformed'),
      err('', 'file is encrypted or is not a database'),
    ]) {
      expect(isDbCorruptionError(e), `${e.code} ${e.message}`).toBe(true);
      expect(isFtsCorruptionError(e)).toBe(false);
    }
  });

  it('a transient or unrelated error is neither', () => {
    for (const e of [err('SQLITE_BUSY', 'database is locked'), err('ENOENT', 'no such file')]) {
      expect(isDbCorruptionError(e)).toBe(false);
      expect(isFtsCorruptionError(e)).toBe(false);
    }
  });

  it('rebuildFTS is a real remedy on a live DB — the action the new branch takes', () => {
    const db = createTestDb();
    try {
      const r = rebuildFTS(db);
      expect(r.errors).toEqual([]);
      expect(r.rebuilt).toContain('observations_fts');
    } finally {
      db.close();
    }
  });
});
