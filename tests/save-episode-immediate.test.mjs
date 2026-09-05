// Regression test for audit P1 #6: the SIGTERM/SIGINT shutdown handler wrote an
// ep-flush-* file that no worker consumes, so the in-flight episode was silently
// lost on abnormal termination. saveEpisodeImmediate — now also called from that
// handler before the flush-file write — persists a rule-based observation
// synchronously. Tested via the importable hook-llm seam (hook.mjs itself
// process.exit()s at import, so the handler can't be unit-imported directly).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { saveEpisodeImmediate } from '../hook-llm.mjs';

describe('saveEpisodeImmediate (audit #6 — shutdown durability)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 's1', project: 'p1', memoryId: 's1' });
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it('persists a rule-based observation for a significant (file-edit) episode', () => {
    // saveObservation deliberately drops LOW_SIGNAL synthetic titles in BOTH the
    // normal and shutdown paths (the normal path relies on the LLM worker to upgrade
    // them later). That noise gate is orthogonal to #6 — the opt-out isolates the
    // assertion under test: the SHUTDOWN path now actually persists the episode.
    process.env.CLAUDE_MEM_KEEP_LOW_SIGNAL = '1';
    try {
      const episode = {
        project: 'p1',
        sessionId: 's1',
        entries: [{ tool: 'Edit', isError: false, file: 'src/auth.mjs' }],
        files: ['src/auth.mjs'],
        filesRead: [],
      };
      const id = saveEpisodeImmediate(episode, db);
      expect(id).toBeTruthy();
      const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
      expect(row).toBeTruthy();
      expect(row.memory_session_id).toBe('s1');
    } finally {
      delete process.env.CLAUDE_MEM_KEEP_LOW_SIGNAL;
    }
  });

  it('returns null and saves nothing for an insignificant episode (single read)', () => {
    const episode = {
      project: 'p1',
      sessionId: 's1',
      entries: [{ tool: 'Read', isError: false, file: 'README.md' }],
      files: ['README.md'],
      filesRead: ['README.md'],
    };
    const before = db.prepare('SELECT COUNT(*) c FROM observations').get().c;
    expect(saveEpisodeImmediate(episode, db)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM observations').get().c).toBe(before);
  });

  it('never throws on a null / empty / malformed episode', () => {
    expect(saveEpisodeImmediate(null, db)).toBeNull();
    expect(saveEpisodeImmediate({ entries: [] }, db)).toBeNull();
    expect(() => saveEpisodeImmediate({ entries: [{ tool: 'Edit' }] }, db)).not.toThrow();
  });
});
