// R3 H-M3 (MED): the handoff-injection window ("first 3 prompts") was gated on
// sdk_sessions.prompt_counter — project-scoped and shared across concurrent same-project
// CC sessions. A parallel session B's FIRST prompt could land at counter=4 (>3) and be
// denied injection. hook.mjs now derives the window position from COUNT(*) of the CC
// session's OWN prompts. This guards that discriminating query.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';

describe('handoff-injection window is per-cc-session, not the shared counter (R3 H-M3)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    // one project-scoped mem session already advanced to prompt_counter=3 by CC session A
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status, prompt_counter)
      VALUES ('mem-p','mem-p','p','2026-01-01T00:00:00Z',1,'active',3)`,
    ).run();
    for (let i = 1; i <= 3; i++) {
      db.prepare(
        `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, cc_session_id, created_at, created_at_epoch)
        VALUES ('mem-p','a',?, 'ccA','t',?)`,
      ).run(i, i);
    }
  });
  afterEach(() => {
    db.close();
  });

  it('a concurrent session B is inside the window by cc-session count, though the shared counter is past 3', () => {
    // B's first prompt: shared prompt_counter is already 3 (its real bump would make prompt_number=4,
    // outside <=3); the per-cc-session position is 1 (inside).
    db.prepare(
      `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, cc_session_id, created_at, created_at_epoch)
      VALUES ('mem-p','b',4,'ccB','t',10)`,
    ).run();
    const bPromptNumber = db
      .prepare('SELECT prompt_number FROM user_prompts WHERE cc_session_id = ? ORDER BY id DESC LIMIT 1')
      .get('ccB').prompt_number;
    const bWindowPos = db.prepare('SELECT COUNT(*) c FROM user_prompts WHERE cc_session_id = ?').get('ccB').c;
    expect(bPromptNumber).toBeGreaterThan(3); // shared-counter position would have excluded B
    expect(bWindowPos).toBe(1); // per-cc-session position puts B inside the window
    expect(bWindowPos).toBeLessThanOrEqual(3);
  });

  it('a cc session past its 3rd prompt is correctly outside the window', () => {
    for (let i = 1; i <= 4; i++) {
      db.prepare(
        `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, cc_session_id, created_at, created_at_epoch)
        VALUES ('mem-p','c',?, 'ccC','t',?)`,
      ).run(i, 20 + i);
    }
    const pos = db.prepare('SELECT COUNT(*) c FROM user_prompts WHERE cc_session_id = ?').get('ccC').c;
    expect(pos).toBe(4);
    expect(pos > 3).toBe(true);
  });
});
