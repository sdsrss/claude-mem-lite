// R3 H-M1 (MED): detectContinuationIntent Stage -1 (git-commit anchor) returned true for
// ANY ≥2-char prompt whenever HEAD matched a stored git_sha_at_handoff within 72h — no
// session scoping, no prompt-content gate. A new task typed at the same commit (or a parallel
// same-project session) would inherit AND delete another session's handoff. Fix: mirror Stage 2
// scoping (exit = cross-session, clear = same-session) + Stage 0's long-unrelated-prompt gate.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { detectContinuationIntent } from '../hook-handoff.mjs';
import * as gitStateModule from '../lib/git-state.mjs';

const SHA = 'deadbeefcafe1234deadbeefcafe1234deadbeef';

describe('Stage -1 git-anchor gates on prompt + session (R3 H-M1)', () => {
  let db, spy;
  beforeEach(() => {
    db = createTestDb();
    spy = vi.spyOn(gitStateModule, 'readGitState').mockReturnValue({ headSha: SHA });
    // an EXIT handoff from session A at the current HEAD; keywords describe the ORIGINAL work
    db.prepare(
      `INSERT INTO session_handoffs (project, type, session_id, git_sha_at_handoff, match_keywords, working_on, created_at_epoch)
      VALUES ('p', 'exit', 'sess-A', ?, 'authentication login oauth token refresh', 'auth work', ?)`,
    ).run(SHA, Date.now());
  });
  afterEach(() => {
    spy.mockRestore();
    db.close();
  });

  it('does NOT auto-continue a long, unrelated new task at the same commit', () => {
    expect(
      detectContinuationIntent(
        db,
        'please add a completely different CSV export feature to the reports grid',
        'p',
        'sess-B',
      ),
    ).toBe(false);
  });

  it('still auto-continues a short resume nudge (cross-session exit-resume preserved)', () => {
    // "ok thanks": <40 chars, no continue keyword, no keyword overlap → only Stage -1 can pass it
    expect(detectContinuationIntent(db, 'ok thanks', 'p', 'sess-B')).toBe(true);
  });

  it('auto-continues a long prompt that overlaps the anchored work', () => {
    expect(
      detectContinuationIntent(
        db,
        'keep working on the oauth token refresh login flow we started',
        'p',
        'sess-B',
      ),
    ).toBe(true);
  });

  it("does NOT let another session's clear-anchor hijack via the git anchor (parallel bleed)", () => {
    const db2 = createTestDb();
    db2
      .prepare(
        `INSERT INTO session_handoffs (project, type, session_id, git_sha_at_handoff, match_keywords, created_at_epoch)
      VALUES ('p', 'clear', 'sess-A', ?, 'authentication login', ?)`,
      )
      .run(SHA, Date.now());
    // clear is same-session only; session B must not inherit sess-A's clear via the anchor
    expect(detectContinuationIntent(db2, 'ok thanks', 'p', 'sess-B')).toBe(false);
    db2.close();
  });
});
