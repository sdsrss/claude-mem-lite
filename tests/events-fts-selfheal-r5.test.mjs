// P2-4 / v42: events_fts is the one FTS table outside the generic ensureFTS() self-heal
// (its DDL is non-standard — UNINDEXED cols + custom tokenizer + events_fts_* triggers).
// ensureEventsFTS is the dedicated column-aware guard: it recreates a drifted (older, narrower)
// events_fts and repopulates it, while never installing the wrong-named events_* trigger set
// the generic ensureFTS would (which would double-write the index).

import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { ensureEventsFTS } from '../schema.mjs';

let db;
afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
});

const addEvent = (d, { title, body = '', project = 'p', event_type = 'bugfix' }) =>
  d
    .prepare(
      `INSERT INTO events (project, event_type, title, body, importance, created_at_epoch) VALUES (?, ?, ?, ?, 2, ?)`,
    )
    .run(project, event_type, title, body, Date.now());

const ftsCols = (d) =>
  d
    .prepare(`PRAGMA table_info(events_fts)`)
    .all()
    .map((c) => c.name);
const triggerNames = (d) =>
  d
    .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'events%'`)
    .all()
    .map((r) => r.name);
const ftsHits = (d, q) =>
  d
    .prepare(
      `SELECT e.title FROM events_fts JOIN events e ON e.id = events_fts.rowid WHERE events_fts MATCH ?`,
    )
    .all(q);

describe('ensureEventsFTS (P2-4 / v42 events_fts self-heal)', () => {
  it('is a no-op on a healthy DB — 4 columns, canonical triggers only, no wrong-named events_* set', () => {
    db = createTestDb();
    insertSession(db, { id: 's', project: 'p' });
    addEvent(db, { title: 'zebracrossing healthy' });

    ensureEventsFTS(db); // second pass over an already-correct schema
    ensureEventsFTS(db); // idempotent

    expect(ftsCols(db)).toEqual(['title', 'body', 'event_type', 'project']);
    const trigs = triggerNames(db).sort();
    expect(trigs).toEqual(['events_fts_ad', 'events_fts_ai', 'events_fts_au']);
    // The generic ensureFTS would have added events_ai/events_ad/events_au (double-write). Assert absent.
    expect(trigs).not.toContain('events_ai');
    expect(ftsHits(db, 'zebracrossing')).toHaveLength(1);
  });

  it('recreates a drifted (narrow) events_fts and repopulates it from the events table', () => {
    db = createTestDb();
    insertSession(db, { id: 's', project: 'p' });
    addEvent(db, { title: 'preexisting zebracrossing event', body: 'body text' });

    // Simulate an OLD narrow DB: drop the wide index + triggers, recreate a 2-column events_fts
    // (the pre-UNINDEXED-cols shape). The events ROWS survive (content table untouched).
    db.exec(`DROP TRIGGER IF EXISTS events_fts_ai`);
    db.exec(`DROP TRIGGER IF EXISTS events_fts_ad`);
    db.exec(`DROP TRIGGER IF EXISTS events_fts_au`);
    db.exec(`DROP TABLE IF EXISTS events_fts`);
    db.exec(`CREATE VIRTUAL TABLE events_fts USING fts5(title, body, content='events', content_rowid='id')`);
    expect(ftsCols(db)).toEqual(['title', 'body']); // drifted narrow

    ensureEventsFTS(db);

    // Healed: full 4-column set restored, and the pre-existing event is searchable again
    // (repopulated via the 'rebuild' command — an empty recreated index would return 0).
    expect(ftsCols(db)).toEqual(['title', 'body', 'event_type', 'project']);
    expect(ftsHits(db, 'zebracrossing')).toHaveLength(1);

    // Triggers restored under the canonical names → a NEW event indexes correctly.
    addEvent(db, { title: 'freshpostheal zebracrossing' });
    expect(ftsHits(db, 'zebracrossing')).toHaveLength(2);
  });
});
