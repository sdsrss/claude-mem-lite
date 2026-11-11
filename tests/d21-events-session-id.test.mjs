// D21 (2026-11-11, option A'): an episode the model types as an event (bugfix / discovery /
// feature / refactor / decision) lands in `events`, which had no session column, so the session
// summary — it reads `observations WHERE memory_session_id = ?` — never saw it (R32: ~86% of
// episodes in the maintainer's store). events gets a nullable memory_session_id, added WITHOUT a
// CURRENT_SCHEMA_VERSION bump (an older build opening the store ignores the column, as with
// importance_set_at and hidden_at), and the episode write fills it.
import { describe, it, expect } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../schema.mjs';
import { saveEvent } from '../lib/activity.mjs';
import { persistHaikuSummary } from '../hook-llm.mjs';

const cols = (db) =>
  db
    .prepare('PRAGMA table_info(events)')
    .all()
    .map((c) => c.name);

describe('D21: events carry the session that wrote them', () => {
  it('a fresh store has a nullable events.memory_session_id', () => {
    const db = createTestDb();
    const col = db
      .prepare('PRAGMA table_info(events)')
      .all()
      .find((c) => c.name === 'memory_session_id');
    expect(col).toBeDefined();
    expect(col.notnull).toBe(0);
    db.close();
  });

  it('a store from the previous release gets the column without a version bump', () => {
    const db = createTestDb();
    db.exec('ALTER TABLE events DROP COLUMN memory_session_id');
    expect(cols(db)).not.toContain('memory_session_id'); // premise: the previous-release shape
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(CURRENT_SCHEMA_VERSION);
    initSchema(db);
    expect(cols(db)).toContain('memory_session_id');
    db.close();
  });

  it('an episode stored as an event records its session', () => {
    const db = createTestDb();
    const r = persistHaikuSummary(
      db,
      { type: 'bugfix', title: 'Fixed the flush race', lesson_learned: 'wait for the buffer', importance: 2 },
      { project: 'p', session_id: 'hook-p@h4242-abc' },
    );
    expect(r.table).toBe('events'); // premise: the event branch ran
    const row = db.prepare('SELECT memory_session_id FROM events WHERE id = ?').get(r.id);
    expect(row.memory_session_id).toBe('hook-p@h4242-abc');
    db.close();
  });

  it('a writer with no session (the CLI `activity` command) stores NULL', () => {
    const db = createTestDb();
    const id = saveEvent(db, { project: 'p', event_type: 'lesson', title: 'a manual note' });
    expect(
      db.prepare('SELECT memory_session_id FROM events WHERE id = ?').get(id).memory_session_id,
    ).toBeNull();
    db.close();
  });
});
