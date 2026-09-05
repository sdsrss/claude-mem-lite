// The write-side 5-minute dedup window must only compare against LIVE rows.
//
// `saveObservation`'s near-duplicate check selected `WHERE project = ? AND
// created_at_epoch > ?` with no live-state predicate, while every read path in the
// tree goes through `liveObsFilterSql` (`COALESCE(compressed_into,0) = 0 AND
// superseded_at IS NULL`). So a save could be REFUSED as a duplicate of a row that
// had already been retired, and the caller was handed that tombstone's id as
// `existingId` — an id no injection face will ever return and no `get` will show as
// current. This is the superseded invariant's last uncovered corner: it has been
// broken ten times in this repo, and every previous one was on a read path.
//
// Population is small but real: measured on the live DB 2026-09-04 (3779 observations,
// 31 superseded), THREE rows were superseded 2.9 / 3.6 / 3.9 minutes after they were
// created — i.e. inside this exact window. That is the "save the wrong thing, correct
// it a minute later" workflow, which is precisely when the caller must not be told
// their correction duplicates the row they just retired.
//
// SCOPE, stated because the obvious sweep is the wrong move here: hook-llm.mjs runs a
// three-tier dedup over the same table with no live filter either, and its 7-day /
// 3-day low-signal tiers are deliberately allowed to match compressed rows — that is
// what stops "Modified package.json" re-accumulating after auto-compress retires it.
// Those are not twins of this defect. What is unique to `saveObservation` is that it
// RETURNS the matched id to a caller; hook-llm returns null and no id escapes.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { saveObservation } from '../lib/save-observation.mjs';

const PROJECT = 'x--dedup-live';
const TITLE = 'session token refresh fails after key rotation';
const BODY =
  'refreshSessionToken threw after every deploy because the rotated signing key ' +
  'was read once at module load instead of per call';

let db;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
              VALUES ('cc-dl','mem-dl', ?, datetime('now'), ?)`,
  ).run(PROJECT, Date.now());
});

/** Save one observation through the production pipeline. */
function save(overrides = {}) {
  return saveObservation(db, {
    content: BODY,
    title: TITLE,
    type: 'bugfix',
    importance: 2,
    project: PROJECT,
    ...overrides,
  });
}

describe('write-side dedup ignores retired rows', () => {
  it('a live near-duplicate inside the window IS still deduped', () => {
    // The counterweight. Without it, a fix that simply deleted the dedup query would
    // pass every other case in this file — "no false duplicates" is trivially
    // satisfiable by never reporting one.
    const first = save();
    expect(first.kind).toBe('saved');
    const second = save();
    expect(second.kind, 'live dedup stopped working').toBe('duplicate');
    expect(second.existingId).toBe(first.id);
  });

  it('a SUPERSEDED row inside the window is not a duplicate', () => {
    const first = save();
    // Retire it exactly as the supersession path does: epoch-ms integer, not ISO text.
    db.prepare('UPDATE observations SET superseded_at = ? WHERE id = ?').run(Date.now(), first.id);
    expect(
      db.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(first.id).superseded_at,
      'premise: the row under test is not actually retired',
    ).not.toBeNull();

    const correction = save();
    expect(correction.kind, `reported a duplicate of tombstone #${first.id}`).toBe('saved');
    expect(correction.id).not.toBe(first.id);
  });

  it('a COMPRESSED row inside the window is not a duplicate', () => {
    const parent = save({ title: 'weekly cluster parent', content: 'unrelated cluster parent body' });
    const first = save();
    db.prepare('UPDATE observations SET compressed_into = ? WHERE id = ?').run(parent.id, first.id);
    expect(
      db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(first.id).compressed_into,
    ).toBe(parent.id);

    const again = save();
    expect(again.kind, `reported a duplicate of compressed row #${first.id}`).toBe('saved');
    expect(again.id).not.toBe(first.id);
  });

  it('the supersession the correction requested actually happens', () => {
    // The consequence that makes this user-visible rather than cosmetic. Pre-fix the
    // dedup short-circuit returned before the supersession ran (D#201's shape), so the
    // caller was told "duplicate" AND the row they named stayed live. Here the target is
    // a DIFFERENT live row, so the only thing that could block the supersession is the
    // dedup firing against a tombstone.
    const stale = save();
    const target = save({ title: 'unrelated live row', content: 'a second live row to retire' });
    db.prepare('UPDATE observations SET superseded_at = ? WHERE id = ?').run(Date.now(), stale.id);

    const correction = save({ supersedes: [String(target.id)] });
    expect(correction.kind).toBe('saved');
    expect(correction.supersededIds, 'dedup against a tombstone swallowed the supersession').toContain(
      target.id,
    );
  });
});
