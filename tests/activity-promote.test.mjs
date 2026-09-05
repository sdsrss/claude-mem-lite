// P2(b): promote lesson-bearing existing events into searchable observations.
// The events table holds 2000+ high-value rows (bugfix/lesson/decision) that
// mem_search / passive injection never read (finding #1). This one-time backfill
// copies the insight-bearing subset (body present, importance>=2) into observations
// and marks the source event promoted with superseded_at_epoch ONLY (superseded_by_id
// is a self-FK → events(id), deliberately left NULL) so re-runs skip it. No schema
// change — the column exists.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { saveEvent, promoteInsightEvents } from '../lib/activity.mjs';

describe('promoteInsightEvents', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    // Mirror the real DB connection: FK enforcement ON. Without this the events
    // superseded_by_id self-FK is not enforced, which masked a FOREIGN KEY
    // violation when promotion tried to store an observation id there.
    db.pragma('foreign_keys = ON');
  });
  afterEach(() => {
    db.close();
  });

  const seedEvent = (over = {}) =>
    saveEvent(db, {
      project: 'sp',
      event_type: 'lesson',
      title: 'httpOnly cookies e2e',
      body: 'session cookies must be httpOnly or the e2e tests bleed across browsers',
      importance: 2,
      created_at_epoch: 1_600_000_000_000,
      ...over,
    });

  it('preview (execute=false) counts eligible events but promotes nothing', () => {
    seedEvent();
    const r = promoteInsightEvents(db, { execute: false });
    expect(r.eligible).toBe(1);
    expect(r.promoted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM observations').get().n).toBe(0);
  });

  it('promotes a lesson-bearing event into an observation and marks the source', () => {
    const evId = seedEvent();
    const r = promoteInsightEvents(db, { execute: true });
    expect(r.promoted).toBe(1);

    const obs = db.prepare("SELECT * FROM observations WHERE project = 'sp'").get();
    expect(obs).toBeDefined();
    expect(obs.narrative).toContain('httpOnly');
    expect(obs.lesson_learned).toContain('httpOnly'); // insight lands in the high-weight field
    expect(obs.created_at_epoch).toBe(1_600_000_000_000); // original timestamp preserved

    const ev = db.prepare('SELECT superseded_at_epoch, superseded_by_id FROM events WHERE id = ?').get(evId);
    expect(ev.superseded_at_epoch).toBeGreaterThan(0); // marked promoted (idempotency)
    // superseded_by_id is a self-FK (REFERENCES events(id)) — deliberately left NULL,
    // NOT set to the observation id (that would fail the FK on the real DB).
    expect(ev.superseded_by_id).toBeNull();
  });

  it('skips low-importance and empty-body events', () => {
    seedEvent({ importance: 1 }); // too low
    seedEvent({ body: '', importance: 3 }); // no insight body
    seedEvent({ body: null, importance: 3 }); // no insight body
    const r = promoteInsightEvents(db, { execute: true });
    expect(r.eligible).toBe(0);
    expect(r.promoted).toBe(0);
  });

  it('is idempotent — a second run promotes nothing', () => {
    seedEvent();
    promoteInsightEvents(db, { execute: true });
    const r2 = promoteInsightEvents(db, { execute: true });
    expect(r2.eligible).toBe(0);
    expect(r2.promoted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM observations').get().n).toBe(1); // not duplicated
  });

  it('excludes low-signal-titled events (activity-log noise, not lessons)', () => {
    // Real-DB sampling found ~6.5% of body+imp>=2 events carry low-signal titles
    // (Modified X / Error while … / Worked on X / raw tool logs). Those are the
    // activity-log noise the events split was meant to contain — promoting them
    // would re-introduce noise into search. "lesson-bearing" must exclude them.
    // Uses the project's canonical low-signal-title definition (same as re-enrich).
    seedEvent({ title: 'Modified schema.mjs', body: 'ran a grep over the file', importance: 2 });
    seedEvent({
      title: 'Worked on prompt_mgr.py, migrations',
      body: 'grep -A 50 def get → stdout empty',
      importance: 3,
    });
    const r = promoteInsightEvents(db, { execute: true });
    expect(r.eligible).toBe(0);
    expect(r.promoted).toBe(0);
  });

  it('maps non-observation event types to a valid obs type (bug → bugfix, observation → discovery)', () => {
    seedEvent({ event_type: 'bug', title: 'b1', body: 'a known race in the pool' });
    seedEvent({ event_type: 'observation', title: 'o1', body: 'noticed the cache warms lazily' });
    promoteInsightEvents(db, { execute: true });
    const types = db
      .prepare('SELECT type FROM observations ORDER BY title')
      .all()
      .map((r) => r.type);
    expect(types).toContain('bugfix'); // bug → bugfix
    expect(types).toContain('discovery'); // observation → discovery
  });
});
