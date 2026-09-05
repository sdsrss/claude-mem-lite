// Tests for cross-session handoff: schema, utils, extraction, intent detection, injection
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { extractMatchKeywords, tokenizeHandoff, isSpecificTerm } from '../utils.mjs';
import {
  buildAndSaveHandoff,
  detectContinuationIntent,
  renderHandoffInjection,
  pickHandoffToInject,
} from '../hook-handoff.mjs';
import * as gitStateModule from '../lib/git-state.mjs';
import * as taskReaderModule from '../lib/task-reader.mjs';

function seedSession(db, sessionId, project) {
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status) VALUES (?, ?, ?, datetime('now'), ?, 'active')`,
  ).run(sessionId, sessionId, project, Date.now());
}

function seedPrompt(db, sessionId, text, num) {
  db.prepare(
    `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch) VALUES (?, ?, ?, datetime('now'), ?)`,
  ).run(sessionId, text, num, Date.now());
}

let _seedObsEpochOffset = 0;
function seedObservation(db, sessionId, project, title, type, importance, filesModified, narrative) {
  const epoch = Date.now() + _seedObsEpochOffset++;
  db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, importance, files_modified, narrative, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
  ).run(sessionId, project, type, title, importance, filesModified, narrative || null, epoch);
}

// ─── Schema Tests ───────────────────────────────────────────────────────────

describe('session_handoffs schema', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    _seedObsEpochOffset = 0;
  });
  afterEach(() => {
    db.close();
  });

  it('creates session_handoffs table with correct columns', () => {
    const cols = db.prepare(`PRAGMA table_info(session_handoffs)`).all();
    const names = cols.map((c) => c.name);
    expect(names).toContain('project');
    expect(names).toContain('type');
    expect(names).toContain('session_id');
    expect(names).toContain('working_on');
    expect(names).toContain('completed');
    expect(names).toContain('unfinished');
    expect(names).toContain('key_files');
    expect(names).toContain('key_decisions');
    expect(names).toContain('match_keywords');
    expect(names).toContain('created_at_epoch');
  });

  it('PRIMARY KEY (project, type, session_id) allows parallel sessions to coexist', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, created_at_epoch) VALUES ('p1', 'clear', 's1', 1000)`,
    ).run();
    // Different session_id for same (project, type) must NOT collide — parallel sessions
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, created_at_epoch) VALUES ('p1', 'clear', 's2', 2000)`,
    ).run();
    const rows = db
      .prepare(`SELECT * FROM session_handoffs WHERE project = 'p1' AND type = 'clear' ORDER BY session_id`)
      .all();
    expect(rows.length).toBe(2);
    expect(rows[0].session_id).toBe('s1');
    expect(rows[1].session_id).toBe('s2');
  });

  it('rejects duplicate (project, type, session_id)', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, created_at_epoch) VALUES ('p1', 'clear', 's1', 1000)`,
    ).run();
    expect(() => {
      db.prepare(
        `INSERT INTO session_handoffs (project, type, session_id, created_at_epoch) VALUES ('p1', 'clear', 's1', 2000)`,
      ).run();
    }).toThrow(/UNIQUE/);
  });

  it('allows UPSERT via ON CONFLICT(project, type, session_id)', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch) VALUES ('p1', 'clear', 's1', 'old', 1000)`,
    ).run();
    db.prepare(
      `
      INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p1', 'clear', 's1', 'new', 2000)
      ON CONFLICT(project, type, session_id) DO UPDATE SET
        working_on = excluded.working_on,
        created_at_epoch = excluded.created_at_epoch
    `,
    ).run();
    const row = db
      .prepare(`SELECT * FROM session_handoffs WHERE project = 'p1' AND type = 'clear' AND session_id = 's1'`)
      .get();
    expect(row.working_on).toBe('new');
    expect(row.created_at_epoch).toBe(2000);
  });
});

// ─── Utility Tests ──────────────────────────────────────────────────────────

describe('handoff utility functions', () => {
  describe('tokenizeHandoff', () => {
    it('splits text into lowercase tokens', () => {
      expect(tokenizeHandoff('Hello World Foo')).toEqual(['hello', 'world', 'foo']);
    });

    it('filters tokens shorter than 3 chars', () => {
      expect(tokenizeHandoff('a ab abc abcd')).toEqual(['abc', 'abcd']);
    });

    it('splits on punctuation and whitespace', () => {
      const tokens = tokenizeHandoff('hook.mjs:123 (test)');
      expect(tokens).toContain('hook');
      expect(tokens).toContain('mjs');
      expect(tokens).toContain('123');
      expect(tokens).toContain('test');
    });

    it('returns empty array for empty input', () => {
      expect(tokenizeHandoff('')).toEqual([]);
      expect(tokenizeHandoff(null)).toEqual([]);
    });
  });

  describe('isSpecificTerm', () => {
    it('returns true for identifiers with underscores/hyphens', () => {
      expect(isSpecificTerm('session_handoffs')).toBe(true);
      expect(isSpecificTerm('hook-shared')).toBe(true);
    });

    it('returns true for 4+ char non-stop-words', () => {
      expect(isSpecificTerm('hook')).toBe(true);
      expect(isSpecificTerm('schema')).toBe(true);
      expect(isSpecificTerm('dispatch')).toBe(true);
    });

    it('returns false for stop words', () => {
      expect(isSpecificTerm('with')).toBe(false);
      expect(isSpecificTerm('from')).toBe(false);
      expect(isSpecificTerm('function')).toBe(false);
    });

    it('returns false for short tokens', () => {
      expect(isSpecificTerm('ab')).toBe(false);
      expect(isSpecificTerm('')).toBe(false);
    });

    it('returns false for purely numeric tokens', () => {
      expect(isSpecificTerm('1234')).toBe(false);
    });
  });

  describe('extractMatchKeywords', () => {
    it('extracts file basenames without extensions', () => {
      const kw = extractMatchKeywords('some text', ['/path/to/hook.mjs', '/path/to/schema.mjs']);
      expect(kw).toContain('hook');
      expect(kw).toContain('schema');
    });

    it('extracts technical terms from text, skipping stop words', () => {
      const kw = extractMatchKeywords('implement handoff detection for session', []);
      expect(kw).toContain('handoff');
      expect(kw).toContain('detection');
      expect(kw).toContain('session');
      expect(kw).not.toContain('for');
    });

    it('deduplicates terms', () => {
      const kw = extractMatchKeywords('hook hook hook', ['/a/hook.mjs']);
      const tokens = kw.split(' ').filter((t) => t === 'hook');
      expect(tokens.length).toBe(1);
    });

    it('returns empty string for empty input', () => {
      expect(extractMatchKeywords('', [])).toBe('');
    });
  });
});

// ─── buildAndSaveHandoff Tests ──────────────────────────────────────────────

describe('buildAndSaveHandoff', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    _seedObsEpochOffset = 0;
  });
  afterEach(() => {
    db.close();
  });

  it('saves handoff with working_on from prompts', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'implement handoff feature', 1);
    seedPrompt(db, 's1', 'add intent detection', 2);

    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', null);

    const row = db
      .prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj' AND type = 'clear'`)
      .get();
    expect(row).toBeTruthy();
    expect(row.working_on).toContain('handoff');
    expect(row.working_on).toContain('intent');
    expect(row.session_id).toBe('s1');
  });

  it('skips saving when no prompts exist', () => {
    seedSession(db, 's1', 'test-proj');
    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', null);
    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    expect(row).toBeUndefined();
  });

  it('extracts completed from observations', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'fix the bug', 1);
    seedObservation(db, 's1', 'test-proj', 'Fixed null pointer in handler', 'bugfix', 2, null);
    seedObservation(db, 's1', 'test-proj', 'Added error logging', 'change', 1, null);

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db
      .prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj' AND type = 'exit'`)
      .get();
    expect(row.completed).toContain('Fixed null pointer');
    expect(row.completed).toContain('Added error logging');
  });

  it('extracts unfinished from episode snapshot (edits + errors only)', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'refactor dispatch system', 1);

    const snapshot = {
      entries: [
        { tool: 'Edit', desc: 'Edit hook.mjs: add handoff logic', isSignificant: true, isError: false },
        { tool: 'Read', desc: 'Read schema.mjs', isSignificant: false, isError: false },
        { tool: 'Bash', desc: 'Bash error: test failed', isSignificant: false, isError: true },
      ],
      files: ['/proj/hook.mjs', '/proj/schema.mjs'],
    };

    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', snapshot);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    expect(row.unfinished).toContain('handoff logic');
    expect(row.unfinished).toContain('test failed');
    expect(row.unfinished).not.toContain('Read schema');
  });

  it('successful bash commands (git push, test, build) are NOT pending activity', () => {
    // Regression: v2.39.x surfaced successful `git push` / `git tag` as "Unfinished"
    // because buildAndSaveHandoff filtered on isSignificant, which bash-utils sets to
    // true for git/test/build/deploy commands regardless of success. Resume sessions
    // saw completed work labelled as pending. Fix: pending = errors + edit tools only.
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'ship v0.15.1', 1);

    const snapshot = {
      entries: [
        { tool: 'Bash', desc: 'git add package.json', isSignificant: true, isError: false },
        { tool: 'Bash', desc: 'git push origin main', isSignificant: true, isError: false },
        { tool: 'Bash', desc: 'git tag v0.15.1', isSignificant: true, isError: false },
        { tool: 'Bash', desc: 'npx vitest run (12 passed)', isSignificant: true, isError: false },
      ],
      files: [],
    };

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', snapshot);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    const pending = row.unfinished ? row.unfinished.split('\n---\n')[0] : '';
    expect(pending).not.toContain('git push');
    expect(pending).not.toContain('git tag');
    expect(pending).not.toContain('git add');
    expect(pending).not.toContain('vitest run');
  });

  it('collects key_files from episode + observations', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'edit files', 1);
    seedObservation(db, 's1', 'test-proj', 'Changed utils', 'change', 1, JSON.stringify(['/proj/utils.mjs']));

    const snapshot = { entries: [], files: ['/proj/hook.mjs'] };
    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', snapshot);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    const files = JSON.parse(row.key_files);
    expect(files).toContain('/proj/hook.mjs');
    expect(files).toContain('/proj/utils.mjs');
  });

  it('extracts key_decisions from high-importance observations', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'design decisions', 1);
    seedObservation(db, 's1', 'test-proj', 'Chose UPSERT over INSERT', 'decision', 2, null);
    seedObservation(db, 's1', 'test-proj', 'Minor log fix', 'change', 1, null);

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    expect(row.key_decisions).toContain('UPSERT');
    expect(row.key_decisions).not.toContain('Minor log fix');
  });

  it('parallel sessions keep separate handoffs (no cross-session overwrite)', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'session A work', 1);
    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', null);

    seedSession(db, 's2', 'test-proj');
    seedPrompt(db, 's2', 'session B work', 1);
    buildAndSaveHandoff(db, 's2', 'test-proj', 'clear', null);

    const rows = db
      .prepare(
        `SELECT * FROM session_handoffs WHERE project = 'test-proj' AND type = 'clear' ORDER BY session_id`,
      )
      .all();
    expect(rows.length).toBe(2);
    expect(rows[0].session_id).toBe('s1');
    expect(rows[0].working_on).toContain('session A work');
    expect(rows[1].session_id).toBe('s2');
    expect(rows[1].working_on).toContain('session B work');
  });

  it('UPSERT: same session re-writing its own handoff updates in place', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'initial work', 1);
    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', null);

    // Same session writes again (e.g. another /clear) — should update, not duplicate
    seedPrompt(db, 's1', 'updated work', 2);
    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', null);

    const rows = db
      .prepare(
        `SELECT * FROM session_handoffs WHERE project = 'test-proj' AND type = 'clear' AND session_id = 's1'`,
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].working_on).toContain('updated work');
  });

  it('populates match_keywords for intent matching', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'implement handoff for dispatch system', 1);
    seedObservation(
      db,
      's1',
      'test-proj',
      'Added buildAndSaveHandoff',
      'change',
      1,
      JSON.stringify(['/proj/hook.mjs']),
    );

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    expect(row.match_keywords).toContain('handoff');
    expect(row.match_keywords).toContain('dispatch');
    expect(row.match_keywords).toContain('hook');
  });

  // Regression: handleStop receives CC UUID from stdin but user_prompts was keyed
  // by mem-internal id in handleUserPrompt. Before the fix, passing a single
  // sessionId that mismatched user_prompts → prompts.length === 0 → early return
  // → no handoff row. Fix splits into query key (mem-internal) + scope key (CC UUID).
  it('scopeSessionId tags the handoff row while querySessionId drives user_prompts lookup', () => {
    const memInternalId = 'hook-projects--mem-abc123';
    const ccUuid = '669a3b98-5baf-4c2e-9e50-7d1bef8ddafd';
    seedSession(db, memInternalId, 'test-proj');
    seedPrompt(db, memInternalId, 'continue refactor after /exit', 1);
    seedObservation(db, memInternalId, 'test-proj', 'Edited hook.mjs', 'change', 2, null);

    buildAndSaveHandoff(db, memInternalId, 'test-proj', 'exit', null, ccUuid);

    // Row tagged by scope id (CC UUID) so renderHandoffInjection can scope by it
    const scoped = db
      .prepare(
        `SELECT * FROM session_handoffs WHERE project = 'test-proj' AND type = 'exit' AND session_id = ?`,
      )
      .get(ccUuid);
    expect(scoped).toBeTruthy();
    expect(scoped.working_on).toContain('continue refactor');
    expect(scoped.completed).toContain('Edited hook.mjs');

    // And NOT tagged by the query id (would break CC-UUID-scoped reads)
    const wrongScope = db.prepare(`SELECT * FROM session_handoffs WHERE session_id = ?`).get(memInternalId);
    expect(wrongScope).toBeUndefined();
  });

  it('scopeSessionId defaults to sessionId (backward compat)', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'legacy call without scope arg', 1);

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE session_id = 's1'`).get();
    expect(row).toBeTruthy();
    expect(row.working_on).toContain('legacy');
  });

  it('does not treat completed bugfixes as unfinished', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'fix bugs', 1);
    seedObservation(db, 's1', 'test-proj', 'Fixed null pointer earlier', 'bugfix', 1, null);
    seedObservation(db, 's1', 'test-proj', 'TypeError in dispatch', 'bugfix', 2, null);

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    // Bugfixes in completed list should NOT appear as the pending portion of unfinished
    const pending = row.unfinished ? row.unfinished.split('\n---\n')[0] : '';
    expect(pending).not.toContain('TypeError in dispatch');
    expect(pending).not.toContain('Fixed null pointer');
  });

  it('enriches unfinished with observation narratives (full edit history)', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'code review and fix issues', 1);
    seedObservation(
      db,
      's1',
      'test-proj',
      'Modified hook.mjs',
      'change',
      1,
      null,
      'hook.mjs: "scrubSecrets" → "scrubSecrets, EDIT_TOOLS"',
    );
    seedObservation(
      db,
      's1',
      'test-proj',
      'Modified dispatch.mjs',
      'change',
      1,
      null,
      'dispatch.mjs: "score * decay" → "score * -decay"',
    );

    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', null);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    // Unfinished should contain the full narrative details
    expect(row.unfinished).toContain('scrubSecrets');
    expect(row.unfinished).toContain('EDIT_TOOLS');
    expect(row.unfinished).toContain('score * -decay');
  });

  it('unfinished preserves up to 3000 chars of narrative detail', () => {
    seedSession(db, 's1', 'test-proj');
    seedPrompt(db, 's1', 'fix everything', 1);
    // Create observations with long narratives that together exceed old 300 limit
    seedObservation(db, 's1', 'test-proj', 'Change 1', 'change', 1, null, 'detail-'.repeat(100));
    seedObservation(db, 's1', 'test-proj', 'Change 2', 'change', 1, null, 'info-'.repeat(100));

    buildAndSaveHandoff(db, 's1', 'test-proj', 'clear', null);

    const row = db.prepare(`SELECT * FROM session_handoffs WHERE project = 'test-proj'`).get();
    // unfinished should exceed old 300 limit, capped at 3000
    expect(row.unfinished.length).toBeGreaterThan(300);
    expect(row.unfinished.length).toBeLessThanOrEqual(3000);
  });
});

// ─── meta-trigger filter (working_on) ───────────────────────────────────────

describe('buildAndSaveHandoff: meta-trigger filter for working_on', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedSession(db, 's1', 'test-proj');
  });
  afterEach(() => {
    db.close();
  });

  it('filters meta-trigger-only prompts when subject prompts coexist', () => {
    seedPrompt(db, 's1', '继续', 1);
    seedPrompt(db, 's1', '改 mem-cli.mjs 里 cmdRecent 加 --json', 2);
    seedPrompt(db, 's1', '/exit', 3);

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db.prepare(`SELECT working_on FROM session_handoffs WHERE project = 'test-proj'`).get();
    expect(row.working_on).toContain('mem-cli.mjs');
    expect(row.working_on).not.toMatch(/^继续 →/);
    expect(row.working_on).not.toContain('/exit');
  });

  it('falls back to project-level importance≥3 obs when ALL prompts are meta', () => {
    seedSession(db, 's2-other-session', 'test-proj');
    seedPrompt(db, 's1', '继续前面的工作', 1);
    seedPrompt(db, 's1', '提交代码', 2);
    seedObservation(
      db,
      's2-other-session',
      'test-proj',
      'v2.66 carry-forward: Tier 2 --json + Tier 3 activity delete CLI',
      'decision',
      3,
      '[]',
      null,
    );

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db.prepare(`SELECT working_on FROM session_handoffs WHERE project = 'test-proj'`).get();
    expect(row.working_on).toContain('carry-forward subject');
    expect(row.working_on).toContain('v2.66 carry-forward');
  });

  it('preserves verbatim prompts when meta-only AND no fallback exists', () => {
    seedPrompt(db, 's1', '继续', 1);

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db.prepare(`SELECT working_on FROM session_handoffs WHERE project = 'test-proj'`).get();
    expect(row.working_on).toBe('继续');
  });

  it('skips low-signal-titled obs in fallback (no "Modified X" pollution)', () => {
    seedSession(db, 's2', 'test-proj');
    seedPrompt(db, 's1', '继续', 1);
    seedObservation(db, 's2', 'test-proj', 'Modified some-file.mjs', 'change', 3, '[]', null);
    seedObservation(
      db,
      's2',
      'test-proj',
      'Adopt 5-tier scoring weights for hybrid search',
      'decision',
      3,
      '[]',
      null,
    );

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db.prepare(`SELECT working_on FROM session_handoffs WHERE project = 'test-proj'`).get();
    expect(row.working_on).toContain('5-tier scoring');
    expect(row.working_on).not.toContain('Modified some-file');
  });

  it('cross-project obs are NOT used as fallback', () => {
    seedSession(db, 's2', 'OTHER-proj');
    seedPrompt(db, 's1', '继续', 1);
    seedObservation(
      db,
      's2',
      'OTHER-proj',
      'wrong-project decision should not leak',
      'decision',
      3,
      '[]',
      null,
    );

    buildAndSaveHandoff(db, 's1', 'test-proj', 'exit', null);

    const row = db.prepare(`SELECT working_on FROM session_handoffs WHERE project = 'test-proj'`).get();
    expect(row.working_on).toBe('继续');
  });
});

// ─── detectContinuationIntent Tests ─────────────────────────────────────────

describe('detectContinuationIntent', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    // Use 'exit' type for FTS/keyword tests — Stage 0 auto-match only applies to 'clear'
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, match_keywords, created_at_epoch)
      VALUES ('test-proj', 'exit', 's1', 'implement handoff', 'handoff dispatch hook schema intent detection', ?)`,
    ).run(Date.now());
  });

  it('Stage 0: returns true for session-scoped short prompts with fresh clear handoff', () => {
    db.prepare(
      `INSERT OR REPLACE INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
      VALUES ('test-proj', 'clear', 's2', 'handoff dispatch work', ?)`,
    ).run(Date.now());
    // Session-scoped path (currentCcSessionId given) = same user continuing → auto-continue.
    expect(detectContinuationIntent(db, 'hello how are you', 'test-proj', 's2')).toBe(true);
    expect(detectContinuationIntent(db, 'build a new REST API', 'test-proj', 's2')).toBe(true);
  });

  it('Stage 0: unscoped short prompt requires continuation keyword or keyword overlap', () => {
    db.prepare(
      `INSERT OR REPLACE INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
      VALUES ('test-proj', 'clear', 's2', 'handoff dispatch work', ?)`,
    ).run(Date.now());
    // Unscoped: unrelated short prompt no longer auto-triggers (prevents cross-session noise)
    expect(detectContinuationIntent(db, 'hello how are you', 'test-proj')).toBe(false);
    expect(detectContinuationIntent(db, 'build a new REST API', 'test-proj')).toBe(false);
    // Unscoped + continuation keyword = true (Stage 1)
    expect(detectContinuationIntent(db, '继续', 'test-proj')).toBe(true);
    // Unscoped + keyword overlap with handoff = true
    expect(detectContinuationIntent(db, 'dispatch update', 'test-proj')).toBe(true);
  });

  it('Stage 0: returns false for long unrelated prompt with clear handoff', () => {
    db.prepare(
      `INSERT OR REPLACE INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
      VALUES ('test-proj', 'clear', 's2', 'handoff dispatch hook schema', ?)`,
    ).run(Date.now());
    // Long prompt with zero keyword overlap → new task, don't inject stale context
    expect(
      detectContinuationIntent(
        db,
        'I want to build a completely new REST API for the customer management system from scratch',
        'test-proj',
      ),
    ).toBe(false);
  });

  it('Stage 0: returns true for long prompt with keyword overlap and clear handoff', () => {
    db.prepare(
      `INSERT OR REPLACE INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
      VALUES ('test-proj', 'clear', 's2', 'handoff dispatch hook schema', ?)`,
    ).run(Date.now());
    // Long prompt that mentions handoff-related terms → same task
    expect(
      detectContinuationIntent(
        db,
        'Now lets fix the schema validation issue in the handoff system that was causing problems',
        'test-proj',
      ),
    ).toBe(true);
  });

  it('Stage 0: expired clear handoff does not auto-match', () => {
    db.prepare(
      `INSERT OR REPLACE INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
      VALUES ('test-proj', 'clear', 's2', 'handoff work', ?)`,
    ).run(Date.now() - 25000000); // > 6h
    expect(detectContinuationIntent(db, 'build a new REST API', 'test-proj')).toBe(false);
  });

  it('detects explicit Chinese keywords', () => {
    expect(detectContinuationIntent(db, '继续前面的工作', 'test-proj')).toBe(true);
    expect(detectContinuationIntent(db, '接着干', 'test-proj')).toBe(true);
    expect(detectContinuationIntent(db, '上次的任务', 'test-proj')).toBe(true);
  });

  it('detects explicit English keywords', () => {
    expect(detectContinuationIntent(db, 'continue where we left off', 'test-proj')).toBe(true);
    expect(detectContinuationIntent(db, 'resume the work', 'test-proj')).toBe(true);
  });

  it('detects implicit continuation via FTS term overlap', () => {
    expect(detectContinuationIntent(db, 'how is the handoff dispatch hook going?', 'test-proj')).toBe(true);
  });

  it('rejects unrelated prompts with no overlap', () => {
    expect(detectContinuationIntent(db, 'hello how are you', 'test-proj')).toBe(false);
    expect(detectContinuationIntent(db, 'build a new REST API', 'test-proj')).toBe(false);
  });

  it('rejects prompts with insufficient overlap (score < 3)', () => {
    // Only "handoff" matches = score 2 (specific term) → below threshold
    expect(detectContinuationIntent(db, 'what is a handoff?', 'test-proj')).toBe(false);
  });

  it('does not match "continue" as substring (e.g. "discontinued")', () => {
    expect(detectContinuationIntent(db, 'the feature was discontinued', 'test-proj')).toBe(false);
    expect(detectContinuationIntent(db, 'presumed to be working', 'test-proj')).toBe(false);
  });

  it('returns true for keyword match even without handoff in DB', () => {
    const emptyDb = createTestDb();
    expect(detectContinuationIntent(emptyDb, '继续', 'no-such-proj')).toBe(true);
  });

  it('returns false for FTS match without handoff in DB', () => {
    const emptyDb = createTestDb();
    expect(detectContinuationIntent(emptyDb, 'handoff dispatch hook', 'no-such-proj')).toBe(false);
  });

  it('respects expiry — expired clear handoff is skipped for FTS and Stage 0', () => {
    const oldDb = createTestDb();
    oldDb
      .prepare(
        `INSERT INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
      VALUES ('p', 'clear', 's', 'handoff dispatch hook schema', ?)`,
      )
      .run(Date.now() - 25000000); // > 6 hours ago
    expect(detectContinuationIntent(oldDb, 'handoff dispatch hook schema', 'p')).toBe(false);
    expect(detectContinuationIntent(oldDb, '继续', 'p')).toBe(true); // keyword always works
  });

  it('exit handoff stays valid for 7 days', () => {
    const recentDb = createTestDb();
    recentDb
      .prepare(
        `INSERT INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
      VALUES ('p', 'exit', 's', 'handoff dispatch hook schema', ?)`,
      )
      .run(Date.now() - 3 * 86400000); // 3 days ago
    expect(detectContinuationIntent(recentDb, 'handoff dispatch hook schema', 'p')).toBe(true);
  });

  it('exit handoff expires after 7 days', () => {
    const oldDb = createTestDb();
    oldDb
      .prepare(
        `INSERT INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
      VALUES ('p', 'exit', 's', 'handoff dispatch hook schema', ?)`,
      )
      .run(Date.now() - 8 * 86400000); // 8 days ago
    expect(detectContinuationIntent(oldDb, 'handoff dispatch hook schema', 'p')).toBe(false);
  });

  // ─── Input validation: tiny / blank prompts must never trigger Stage 0 ────
  describe('tiny prompt guards (single-char / whitespace)', () => {
    let tinyDb;
    beforeEach(() => {
      tinyDb = createTestDb();
      tinyDb
        .prepare(
          `INSERT INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
        VALUES ('p', 'clear', 's-fresh', 'handoff dispatch hook schema', ?)`,
        )
        .run(Date.now());
    });
    afterEach(() => {
      tinyDb.close();
    });

    it('returns false for empty prompt even with fresh clear handoff', () => {
      expect(detectContinuationIntent(tinyDb, '', 'p')).toBe(false);
    });

    it('returns false for whitespace-only prompt even with fresh clear handoff', () => {
      expect(detectContinuationIntent(tinyDb, '   ', 'p')).toBe(false);
      expect(detectContinuationIntent(tinyDb, '\t\n', 'p')).toBe(false);
    });

    it('returns false for single-character prompt even with fresh clear handoff (bug.txt case)', () => {
      // The bug: user types 'a' → Stage 0 auto-injects cross-session handoff
      expect(detectContinuationIntent(tinyDb, 'a', 'p')).toBe(false);
      expect(detectContinuationIntent(tinyDb, '1', 'p')).toBe(false);
      expect(detectContinuationIntent(tinyDb, '好', 'p')).toBe(false);
    });

    it('session-scoped 2-char prompts still auto-continue ("ok", "好的")', () => {
      expect(detectContinuationIntent(tinyDb, 'ok', 'p', 's-fresh')).toBe(true);
      expect(detectContinuationIntent(tinyDb, '好的', 'p', 's-fresh')).toBe(true);
    });

    it('unscoped 2-char prompts without keyword do NOT auto-continue', () => {
      // Tightened in v2.32.7: unscoped path needs CONTINUE_KEYWORDS or overlap
      expect(detectContinuationIntent(tinyDb, 'ok', 'p')).toBe(false);
      expect(detectContinuationIntent(tinyDb, '好的', 'p')).toBe(false);
      // Explicit CONTINUE_KEYWORDS still work unscoped
      expect(detectContinuationIntent(tinyDb, '继续', 'p')).toBe(true);
    });
  });

  // ─── Session scoping: clear handoffs must not cross sessions ──────────────
  describe('session-scoped Stage 0 (currentCcSessionId filter)', () => {
    let scopedDb;
    beforeEach(() => {
      scopedDb = createTestDb();
      // Session A's clear handoff, still fresh
      scopedDb
        .prepare(
          `INSERT INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
        VALUES ('p', 'clear', 'cc-A', 'dispatch hook schema intent', ?)`,
        )
        .run(Date.now());
    });
    afterEach(() => {
      scopedDb.close();
    });

    it('short prompt from SAME session passes Stage 0', () => {
      // Current session = cc-A, handoff also = cc-A → your own /clear, continue
      expect(detectContinuationIntent(scopedDb, 'ok lets go', 'p', 'cc-A')).toBe(true);
    });

    it('short prompt from DIFFERENT session does NOT pass Stage 0 (prevents cross-session bleed)', () => {
      // Current session = cc-B, handoff from cc-A → must not auto-inject A's context into B
      expect(detectContinuationIntent(scopedDb, 'ok lets go', 'p', 'cc-B')).toBe(false);
    });

    it('short prompt from different session still passes Stage 1 via explicit keyword', () => {
      // Explicit "继续" keyword should always work, regardless of session
      expect(detectContinuationIntent(scopedDb, '继续', 'p', 'cc-B')).toBe(true);
    });

    it('cross-session FTS Stage 2 only works for exit handoffs, not clear', () => {
      // Clear handoff from cc-A (the beforeEach) is intentionally ignored for cc-B:
      // clear handoffs are inherently "continue my own /clear flow" — never cross-session.
      // Even with strong keyword overlap.
      expect(detectContinuationIntent(scopedDb, 'dispatch hook schema intent overlap', 'p', 'cc-B')).toBe(
        false,
      );

      // But if cc-A had /exit'd (not /clear), cc-B CAN resume via Stage 2 FTS match.
      scopedDb
        .prepare(
          `INSERT INTO session_handoffs (project, type, session_id, match_keywords, created_at_epoch)
        VALUES ('p', 'exit', 'cc-A', 'dispatch hook schema intent', ?)`,
        )
        .run(Date.now() - 1000);
      expect(detectContinuationIntent(scopedDb, 'dispatch hook schema intent overlap', 'p', 'cc-B')).toBe(
        true,
      );
    });

    it('null currentCcSessionId requires keyword or overlap (tightened in v2.32.7)', () => {
      // Unscoped callers no longer auto-continue on unrelated short prompts —
      // requires CONTINUE_KEYWORDS match or keyword overlap with handoff.
      expect(detectContinuationIntent(scopedDb, 'ok lets go', 'p')).toBe(false);
      expect(detectContinuationIntent(scopedDb, 'ok lets go', 'p', null)).toBe(false);
      // But explicit continuation keyword still passes via Stage 1
      expect(detectContinuationIntent(scopedDb, '继续', 'p')).toBe(true);
      // And keyword overlap with the handoff still passes Stage 0 long-prompt branch
      expect(detectContinuationIntent(scopedDb, 'dispatch intent', 'p')).toBe(true);
    });
  });
});

// ─── renderHandoffInjection Tests ───────────────────────────────────────────

describe('renderHandoffInjection', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    _seedObsEpochOffset = 0;
  });
  afterEach(() => {
    db.close();
  });

  it('renders handoff with all sections', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, completed, unfinished, key_files, key_decisions, match_keywords, created_at_epoch)
      VALUES ('p', 'clear', 's1', 'implement feature X', '[change] Did thing A', 'Still need B', '["hook.mjs"]', 'Chose approach Y', 'feature hook', ?)`,
    ).run(Date.now() - 60000);

    const result = renderHandoffInjection(db, 'p');
    expect(result).toContain('<session-handoff');
    expect(result).toContain('source="clear"');
    expect(result).toContain('implement feature X');
    expect(result).toContain('Did thing A');
    expect(result).toContain('Still need B');
    expect(result).toContain('hook.mjs');
    expect(result).toContain('Chose approach Y');
    expect(result).toContain('</session-handoff>');
  });

  it('leads with a framing line that marks the injection as system-provided, not a new user message', () => {
    // Regression: prior renderings opened directly with `<session-handoff …>` +
    // `## Working On <text>`. When Claude Code surfaced that via the
    // UserPromptSubmit hook, models sometimes misread the `<text>` as a fresh
    // user prompt and ended the turn or answered the handoff content instead
    // of the actual new prompt. Fix: always prepend a `[mem]` framing line that
    // explicitly labels the block as previous-session context.
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', 's1', '先前怎么没有这个问题？', ?)`,
    ).run(Date.now() - 60000);

    const result = renderHandoffInjection(db, 'p');
    const firstLine = result.split('\n', 1)[0];
    expect(firstLine).toMatch(/^\[mem\]/);
    expect(firstLine.toLowerCase()).toContain('previous');
    expect(firstLine.toLowerCase()).toContain('not');
    // Opening tag should also carry a machine-parseable `origin` attribute so
    // downstream tooling can distinguish hook-injected handoffs from anything
    // else that might happen to wrap content in <session-handoff>.
    expect(result).toMatch(/<session-handoff [^>]*origin="hook-injected"/);
  });

  it('appends session summary when available', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', 's1', 'work', ?)`,
    ).run(Date.now());
    seedSession(db, 's1', 'p');
    db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES ('s1', 'p', 'original request', 'finished stuff', 'do next thing', datetime('now'), ?)`,
    ).run(Date.now());

    const result = renderHandoffInjection(db, 'p');
    expect(result).toContain('<session-summary');
    expect(result).toContain('finished stuff');
    expect(result).toContain('do next thing');
    expect(result).toContain('</session-summary>');
  });

  it('enriches with the project summary even when handoff.session_id is a CC-UUID (prod id mismatch)', () => {
    // Regression: in production session_handoffs.session_id is the Claude Code UUID, but
    // session_summaries is keyed by the mem-internal memory_session_id — the exact match
    // failed and the <session-summary> block was always dropped on real resumes. The fallback
    // attaches the most-recent project summary instead.
    const ccUuid = '550e8400-e29b-41d4-a716-446655440000';
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', ?, 'budget refactor', ?)`,
    ).run(ccUuid, Date.now());
    seedSession(db, 'hook-p-abc12345', 'p'); // mem-internal id, different namespace
    db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES ('hook-p-abc12345', 'p', 'req', 'completed the budget refactor', 'wire up the UI', datetime('now'), ?)`,
    ).run(Date.now());

    const result = renderHandoffInjection(db, 'p', 'some-other-cc-session');
    expect(result).toContain('<session-summary');
    expect(result).toContain('completed the budget refactor');
    expect(result).toContain('wire up the UI');
  });

  it('renders remaining_items from session summary', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', 's1', 'code review', ?)`,
    ).run(Date.now());
    seedSession(db, 's1', 'p');
    db.prepare(
      `INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, remaining_items, created_at, created_at_epoch)
      VALUES ('s1', 'p', 'full code review', 'fixed dispatch scoring', 'run tests', 'hook.mjs: missing EDIT_TOOLS import; schema.mjs: remaining_items column needed', datetime('now'), ?)`,
    ).run(Date.now());

    const result = renderHandoffInjection(db, 'p');
    expect(result).toContain('Remaining: hook.mjs: missing EDIT_TOOLS import');
    expect(result).toContain('schema.mjs: remaining_items column needed');
  });

  it('renders only pending portion of unfinished, not narrative history', () => {
    const unfinished =
      'Edit hook.mjs: add logic; Test failed\n---\nhook.mjs: changed import order\ndispatch.mjs: fixed scoring';
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, unfinished, created_at_epoch)
      VALUES ('p', 'clear', 's1', 'refactor', ?, ?)`,
    ).run(unfinished, Date.now());

    const result = renderHandoffInjection(db, 'p');
    // Should show pending entries
    expect(result).toContain('add logic');
    expect(result).toContain('Test failed');
    // Should NOT show narrative history (after ---separator)
    expect(result).not.toContain('changed import order');
    expect(result).not.toContain('fixed scoring');
  });

  it('omits Unfinished section when only narrative history exists (no pending)', () => {
    // When no episode pending entries exist, unfinished starts with separator:
    // '\n---\nnarrative...' — extractUnfinishedSummary gets empty pending portion
    const unfinished = '\n---\nhook.mjs: changed imports\ndispatch.mjs: fixed scoring';
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, unfinished, created_at_epoch)
      VALUES ('p', 'clear', 's1', 'work', ?, ?)`,
    ).run(unfinished, Date.now());

    const result = renderHandoffInjection(db, 'p');
    expect(result).not.toContain('## Unfinished');
    // Narrative history should also not leak into rendering
    expect(result).not.toContain('changed imports');
  });

  it('returns null when no handoff exists', () => {
    expect(renderHandoffInjection(db, 'no-project')).toBeNull();
  });

  it('shows human-readable age', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'clear', 's1', 'work', ?)`,
    ).run(Date.now() - 120000); // 2 minutes ago

    const result = renderHandoffInjection(db, 'p');
    expect(result).toContain('age="2m"');
  });

  it('returns null for expired handoff', () => {
    // clear handoff expired (> 6 hours)
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'clear', 's1', 'old work', ?)`,
    ).run(Date.now() - 25000000);
    expect(renderHandoffInjection(db, 'p')).toBeNull();
  });

  it('returns null for expired exit handoff (> 7 days)', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', 's1', 'old work', ?)`,
    ).run(Date.now() - 8 * 86400000);
    expect(renderHandoffInjection(db, 'p')).toBeNull();
  });

  it('renders non-expired exit handoff', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', 's1', 'recent work', ?)`,
    ).run(Date.now() - 3 * 86400000);
    const result = renderHandoffInjection(db, 'p');
    expect(result).toContain('recent work');
  });

  // ─── Session scoping for injection ────────────────────────────────────────
  describe('session-scoped injection (currentCcSessionId filter)', () => {
    it('returns clear handoff only when it matches currentCcSessionId', () => {
      db.prepare(
        `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
        VALUES ('p', 'clear', 'cc-A', 'session A work', ?)`,
      ).run(Date.now());
      // Same session → inject
      const sameResult = renderHandoffInjection(db, 'p', 'cc-A');
      expect(sameResult).toContain('session A work');
      // Different session → do NOT inject A's clear handoff into B
      const crossResult = renderHandoffInjection(db, 'p', 'cc-B');
      expect(crossResult).toBeNull();
    });

    it('exit handoff from DIFFERENT session IS rendered (new session resumes old one)', () => {
      db.prepare(
        `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
        VALUES ('p', 'exit', 'cc-old', 'old session work', ?)`,
      ).run(Date.now() - 3600000);
      // New session picking up an exit handoff from a previous (different) session — allowed
      const result = renderHandoffInjection(db, 'p', 'cc-new');
      expect(result).toContain('old session work');
    });

    it('exit handoff from SAME session is NOT rendered (you exited, you are not yourself)', () => {
      // If currentCcSessionId equals the handoff's session, that session already consumed it
      db.prepare(
        `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
        VALUES ('p', 'exit', 'cc-A', 'own exit work', ?)`,
      ).run(Date.now() - 3600000);
      const result = renderHandoffInjection(db, 'p', 'cc-A');
      expect(result).toBeNull();
    });

    it('picks same-session clear over different-session clear', () => {
      // Parallel sessions: B's clear is newer, but A should still see A's own
      db.prepare(
        `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
        VALUES ('p', 'clear', 'cc-A', 'A own work', ?)`,
      ).run(Date.now() - 300000);
      db.prepare(
        `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
        VALUES ('p', 'clear', 'cc-B', 'B work', ?)`,
      ).run(Date.now() - 60000);
      const result = renderHandoffInjection(db, 'p', 'cc-A');
      expect(result).toContain('A own work');
      expect(result).not.toContain('B work');
    });

    it('null currentCcSessionId preserves legacy behavior', () => {
      db.prepare(
        `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
        VALUES ('p', 'clear', 's1', 'legacy behavior', ?)`,
      ).run(Date.now());
      expect(renderHandoffInjection(db, 'p')).toContain('legacy behavior');
      expect(renderHandoffInjection(db, 'p', null)).toContain('legacy behavior');
    });
  });
});

// ─── pickHandoffToInject: enables targeted-consume DELETE in handleUserPrompt ──

describe('pickHandoffToInject', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    _seedObsEpochOffset = 0;
  });
  afterEach(() => {
    db.close();
  });

  it('returns the same row that renderHandoffInjection would render', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', 'cc-old', 'old session work', ?)`,
    ).run(Date.now() - 3600000);
    const picked = pickHandoffToInject(db, 'p', 'cc-new');
    expect(picked).not.toBeNull();
    expect(picked.session_id).toBe('cc-old');
    expect(picked.type).toBe('exit');
    const rendered = renderHandoffInjection(db, 'p', 'cc-new');
    expect(rendered).toContain('old session work');
  });

  it('returns null when no valid handoff exists (parity with render)', () => {
    expect(pickHandoffToInject(db, 'p', 'cc-X')).toBeNull();
    expect(renderHandoffInjection(db, 'p', 'cc-X')).toBeNull();
  });

  it('regression: targeted DELETE on (type, session_id) preserves other exits', () => {
    // Three separate prior exit sessions all still within the 7d window.
    // Pre-fix: any continuation-intent in a new session wiped ALL three.
    // Post-fix: only the picked row gets deleted, other rows remain for later resumes.
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', 'cc-A', 'A work', ?)`,
    ).run(Date.now() - 3 * 86400000);
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', 'cc-B', 'B work', ?)`,
    ).run(Date.now() - 2 * 86400000);
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch)
      VALUES ('p', 'exit', 'cc-C', 'C work (most recent)', ?)`,
    ).run(Date.now() - 3600000);

    const picked = pickHandoffToInject(db, 'p', 'cc-new');
    expect(picked.session_id).toBe('cc-C'); // most recent non-expired

    // Simulate the targeted DELETE from hook.mjs handleUserPrompt
    db.prepare('DELETE FROM session_handoffs WHERE project = ? AND type = ? AND session_id = ?').run(
      'p',
      picked.type,
      picked.session_id,
    );

    const remaining = db
      .prepare(
        `SELECT session_id FROM session_handoffs WHERE project = 'p' AND type = 'exit' ORDER BY session_id`,
      )
      .all()
      .map((r) => r.session_id);
    expect(remaining).toEqual(['cc-A', 'cc-B']);
  });
});

// ─── T10d: TaskList-sourced Unfinished + git-commit anchoring ─────────────

describe('T10d: TaskList-sourced Unfinished in buildAndSaveHandoff', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    _seedObsEpochOffset = 0;
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('uses TaskList entries when no episode snapshot and no pending work', () => {
    seedSession(db, 's1', 'mem');
    seedPrompt(db, 's1', 'do the thing', 1);

    vi.spyOn(taskReaderModule, 'readProjectTasks').mockReturnValue([
      { id: 't1', title: 'Implement Task 1', status: 'in_progress', taskListId: 'L', mtime: 0 },
      { id: 't2', title: 'Implement Task 2', status: 'pending', taskListId: 'L', mtime: 0 },
    ]);

    buildAndSaveHandoff(db, 's1', 'mem', 'exit', null);

    const row = db
      .prepare(`SELECT unfinished FROM session_handoffs WHERE project='mem' AND type='exit'`)
      .get();
    // TaskList entries land in the pending portion (before the \n---\n narrative sep)
    const pending = row.unfinished.split('\n---\n')[0];
    expect(pending).toMatch(/Implement Task 1/);
    expect(pending).toMatch(/Implement Task 2/);
    expect(pending).toMatch(/\[in_progress\]/);
    expect(pending).toMatch(/\[pending\]/);
  });

  it('episode pending entries take precedence over TaskList signal', () => {
    seedSession(db, 's1', 'mem');
    seedPrompt(db, 's1', 'fix dispatch', 1);

    const taskSpy = vi
      .spyOn(taskReaderModule, 'readProjectTasks')
      .mockReturnValue([
        { id: 't1', title: 'Task file entry', status: 'pending', taskListId: 'L', mtime: 0 },
      ]);

    buildAndSaveHandoff(db, 's1', 'mem', 'exit', {
      entries: [
        { tool: 'Edit', desc: 'Edit hook.mjs: add dispatch logic', isSignificant: true, isError: false },
      ],
      files: [],
    });

    const row = db
      .prepare(`SELECT unfinished FROM session_handoffs WHERE project='mem' AND type='exit'`)
      .get();
    const pending = row.unfinished.split('\n---\n')[0];
    expect(pending).toMatch(/add dispatch logic/);
    expect(pending).not.toMatch(/Task file entry/);
    // The task reader should not have been consulted when the episode had pending entries
    expect(taskSpy).not.toHaveBeenCalled();
  });

  it('empty TaskList does not clobber the narrative-only fallback', () => {
    seedSession(db, 's1', 'mem');
    seedPrompt(db, 's1', 'code review', 1);
    seedObservation(db, 's1', 'mem', 'Modified hook.mjs', 'change', 1, null, 'hook.mjs: add dashboard');

    vi.spyOn(taskReaderModule, 'readProjectTasks').mockReturnValue([]);

    buildAndSaveHandoff(db, 's1', 'mem', 'exit', null);

    const row = db
      .prepare(`SELECT unfinished FROM session_handoffs WHERE project='mem' AND type='exit'`)
      .get();
    // Pending portion is empty (no episode, no tasks); narrative history remains
    expect(row.unfinished).toContain('add dashboard');
  });
});

describe('T10d: git_sha_at_handoff capture in buildAndSaveHandoff', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    _seedObsEpochOffset = 0;
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('stores current HEAD sha in git_sha_at_handoff column', () => {
    seedSession(db, 's1', 'mem');
    seedPrompt(db, 's1', 'work on refactor', 1);

    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      changed: [],
      stashes: [],
      branch: 'main',
      headSha: 'deadbeef1234',
    });

    buildAndSaveHandoff(db, 's1', 'mem', 'exit', null);

    const row = db
      .prepare(`SELECT git_sha_at_handoff FROM session_handoffs WHERE project='mem' AND type='exit'`)
      .get();
    expect(row.git_sha_at_handoff).toBe('deadbeef1234');
  });

  it('stores NULL git_sha_at_handoff on non-git cwd', () => {
    seedSession(db, 's1', 'mem');
    seedPrompt(db, 's1', 'work anywhere', 1);

    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      changed: [],
      stashes: [],
      branch: null,
      headSha: null,
    });

    buildAndSaveHandoff(db, 's1', 'mem', 'exit', null);

    const row = db
      .prepare(`SELECT git_sha_at_handoff FROM session_handoffs WHERE project='mem' AND type='exit'`)
      .get();
    expect(row.git_sha_at_handoff).toBeNull();
  });
});

describe('T10d: git-commit anchor in detectContinuationIntent', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('returns true when current HEAD matches a stored git_sha_at_handoff', () => {
    // Insert an old exit handoff (24h ago) with a known sha.
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch, match_keywords, git_sha_at_handoff)
                VALUES (?, 'exit', ?, ?, ?, ?, ?)`,
    ).run('mem', 'sX', 'refactor auth', Date.now() - 24 * 3600000, 'auth refactor', 'abc123');

    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      changed: [],
      stashes: [],
      branch: 'main',
      headSha: 'abc123',
    });

    // Prompt alone would NOT match (no overlap, long, no keyword) — anchor decides.
    const result = detectContinuationIntent(db, 'what time is it in Tokyo', 'mem', 'sX');
    expect(result).toBe(true);
  });

  it('returns true even with a tiny prompt when sha matches (anchor beats tiny-prompt guard)', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, created_at_epoch, git_sha_at_handoff)
                VALUES (?, 'exit', ?, ?, ?)`,
    ).run('mem', 'sX', Date.now(), 'abc123');

    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      changed: [],
      stashes: [],
      branch: 'main',
      headSha: 'abc123',
    });

    // Actually tiny-prompt guard runs FIRST — verify it still rejects < 2 chars.
    expect(detectContinuationIntent(db, 'a', 'mem')).toBe(false);
    // Longer prompt, but would fail Stage 0/1/2 on its own — anchor rescues it.
    expect(detectContinuationIntent(db, 'hi there', 'mem')).toBe(true);
  });

  it('does NOT match when HEAD sha differs from stored git_sha_at_handoff', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch, match_keywords, git_sha_at_handoff)
                VALUES (?, 'exit', ?, ?, ?, ?, ?)`,
    ).run('mem', 'sX', 'refactor auth', Date.now() - 24 * 3600000, 'auth refactor', 'abc123');

    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      changed: [],
      stashes: [],
      branch: 'main',
      headSha: 'ffff9999', // different sha
    });

    // Long unrelated prompt — no anchor, no Stage 0, no keyword, no FTS overlap
    const result = detectContinuationIntent(db, 'what time is it in Tokyo please tell me now', 'mem', 'sX');
    expect(result).toBe(false);
  });

  it('does NOT match when git_sha_at_handoff is NULL', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, working_on, created_at_epoch, match_keywords, git_sha_at_handoff)
                VALUES (?, 'exit', ?, ?, ?, ?, NULL)`,
    ).run('mem', 'sX', 'refactor auth', Date.now() - 24 * 3600000, 'auth refactor');

    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      changed: [],
      stashes: [],
      branch: 'main',
      headSha: '', // empty/null
    });

    const result = detectContinuationIntent(db, 'what time is it in Tokyo please tell me now', 'mem', 'sX');
    expect(result).toBe(false);
  });

  it('anchor is project-scoped: handoff from other project with same sha does NOT match', () => {
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, created_at_epoch, git_sha_at_handoff)
                VALUES (?, 'exit', ?, ?, ?)`,
    ).run('other-proj', 'sX', Date.now(), 'abc123');

    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      changed: [],
      stashes: [],
      branch: 'main',
      headSha: 'abc123',
    });

    const result = detectContinuationIntent(db, 'what time is it in Tokyo please tell me now', 'mem');
    expect(result).toBe(false);
  });

  it('anchor within 72h age cap still matches (v2.32.7)', () => {
    // 60h old handoff with matching sha — under 72h cap, should anchor
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, created_at_epoch, git_sha_at_handoff)
                VALUES (?, 'exit', ?, ?, ?)`,
    ).run('mem', 'sX', Date.now() - 60 * 3600000, 'abc123');

    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      changed: [],
      stashes: [],
      branch: 'main',
      headSha: 'abc123',
    });

    // Long unrelated prompt — anchor still rescues it within 72h
    expect(detectContinuationIntent(db, 'what time is it in Tokyo please tell me', 'mem')).toBe(true);
  });

  it('anchor older than 72h does NOT match — rest of pipeline decides (v2.32.7)', () => {
    // 80h old handoff with matching sha — over 72h cap, anchor is stale
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, created_at_epoch, git_sha_at_handoff, match_keywords)
                VALUES (?, 'exit', ?, ?, ?, ?)`,
    ).run('mem', 'sX', Date.now() - 80 * 3600000, 'abc123', 'auth refactor');

    vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({
      changed: [],
      stashes: [],
      branch: 'main',
      headSha: 'abc123',
    });

    // Long unrelated prompt + stale anchor → falls through Stage 0/1/2, no match
    expect(detectContinuationIntent(db, 'what time is it in Tokyo please tell me', 'mem')).toBe(false);
    // Explicit continuation keyword still wins via Stage 1 regardless of anchor age
    expect(detectContinuationIntent(db, '继续 please', 'mem')).toBe(true);
  });
});
