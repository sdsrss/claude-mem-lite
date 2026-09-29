// The one verify-apply failure that happens AFTER the transaction commits: the backup is
// rewritten with the post-apply record, and if that write fails the changes are already in
// the database. The error must say so ("applied, but …") — the CLI and commands/verify.md key
// on that prefix to avoid telling the user "nothing was written" (re-review of dcc8f72, P3-3).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

let writes = 0;
let unlinkFails = false;
vi.mock('fs', async (orig) => {
  const real = await orig();
  const unlinkSync = (...args) => {
    if (unlinkFails) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return real.unlinkSync(...args);
  };
  return { ...real, default: { ...real, unlinkSync }, unlinkSync };
});
vi.mock('../lib/atomic-write.mjs', async (orig) => {
  const real = await orig();
  return {
    ...real,
    atomicWriteFileSync: (...args) => {
      writes++;
      if (writes === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return real.atomicWriteFileSync(...args);
    },
  };
});
import {
  parseProposals,
  planVerifyApply,
  runVerifyApply,
  priorVerifyApplies,
  VERIFY_RETIRED_MARKER,
} from '../lib/verify-apply-core.mjs';

describe('runVerifyApply when the post-apply record cannot be written', () => {
  let db;
  let dir;
  beforeEach(() => {
    writes = 0;
    unlinkFails = false;
    db = createTestDb();
    insertSession(db, { id: 'manual-p', project: 'p' });
    dir = mkdtempSync(join(tmpdir(), 'mem-verify-io-'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws "applied, but …" — the change IS committed and the pre-apply backup is kept', () => {
    const id = Number(
      insertObs(db, { sessionId: 'manual-p', project: 'p', title: 't', narrative: 'n' }).lastInsertRowid,
    );
    const { plan } = planVerifyApply(
      db,
      parseProposals([{ id, action: 'retire', verdict: 'STALE', evidence: 'x' }]).entries,
      { project: 'p' },
    );
    expect(() => runVerifyApply(db, plan, { backupDir: dir })).toThrow(
      /^applied, but the undo record could not be written/,
    );
    expect(writes).toBe(2); // premise: the failure was the SECOND write, after the commit
    expect(db.prepare('SELECT superseded_by FROM observations WHERE id = ?').get(id).superseded_by).toBe(
      VERIFY_RETIRED_MARKER,
    );
    const [file] = readdirSync(dir);
    expect(JSON.parse(readFileSync(join(dir, file), 'utf8')).applied).toBeNull();
  });

  it('an abort whose backup cannot be removed names the leftover file, which does not count as an apply', () => {
    const [a, b] = ['t1', 't2'].map((title) =>
      Number(insertObs(db, { sessionId: 'manual-p', project: 'p', title, narrative: 'n' }).lastInsertRowid),
    );
    const { plan } = planVerifyApply(
      db,
      parseProposals([
        { id: a, action: 'retire', verdict: 'STALE', evidence: 'x' },
        { id: b, action: 'replace', verdict: 'STALE', narrative: 'ok', evidence: 'x' },
      ]).entries,
      { project: 'p' },
    );
    plan[1].narrative = '   '; // saveObservation throws inside the transaction (see the core test)
    unlinkFails = true;
    let err = null;
    try {
      runVerifyApply(db, plan, { backupDir: dir });
    } catch (e) {
      err = e;
    }
    const [left] = readdirSync(dir);
    expect(left).toMatch(/^verify-.*\.json$/); // premise: the removal really failed
    expect(err.message).toMatch(/nothing written to the database/);
    expect(err.message).toContain(join(dir, left));
    expect(err.message).toMatch(/could not be removed/);
    expect(priorVerifyApplies(dir, [a, b])).toEqual([]);
  });
});
