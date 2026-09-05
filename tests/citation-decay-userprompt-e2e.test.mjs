// v34.x end-to-end: UserPromptSubmit injections enter the decay loop via
// extractAllInjected. Before this change, hook.mjs Stop handler called
// extractInjectedFromPreToolUse only, so the entire <memory-context> surface
// (formatMemoryLine emissions) bypassed applyCitationDecay. Decisions —
// almost exclusively injected via that surface — never reached promote/demote.
//
// The integration contract is `extractAllInjected` (unions PTR + UPS); these
// tests pin promote-path + 3-strike demote-path through that function so the
// Stop handler can wire to it with a one-line change.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractAllInjected,
  extractCitationsFromTranscript,
  applyCitationDecay,
} from '../lib/citation-tracker.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

describe('citation-decay loop: UserPromptSubmit injections (via extractAllInjected)', () => {
  let db, tmp;
  beforeEach(() => {
    db = createTestDb();
    tmp = mkdtempSync(join(tmpdir(), 'cite-e2e-'));
  });
  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  function writeTranscript(entries) {
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));
    return path;
  }

  function upsAttachment(stdout) {
    return {
      type: 'attachment',
      attachment: {
        type: 'hook_success',
        command: 'node /opt/hook.mjs user-prompt',
        stdout,
      },
    };
  }

  it('promotes a UserPromptSubmit-injected obs when cited in assistant text', () => {
    insertSession(db, { id: 'sess-1', project: 'p' });
    const r = insertObs(db, {
      sessionId: 'sess-1',
      project: 'p',
      type: 'decision',
      title: 'pick X over Y',
      importance: 1,
      lessonLearned: 'X has stable invariants',
    });
    const obsId = Number(r.lastInsertRowid);

    const path = writeTranscript([
      upsAttachment(
        '<memory-context relevance="high">\n' +
          `- [decision] pick X over Y | Lesson: X has stable invariants (#${obsId})\n` +
          '</memory-context>\n',
      ),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: `Per #${obsId} we already decided this.` }] },
      },
    ]);

    const injected = extractAllInjected(path);
    const cited = extractCitationsFromTranscript(path);
    expect(injected.has(obsId)).toBe(true);
    expect(cited.has(obsId)).toBe(true);

    const result = applyCitationDecay(db, 'p', injected, cited, 'sess-1');
    expect(result.promoted).toBe(1);
    expect(result.demoted).toBe(0);

    const row = db
      .prepare(
        'SELECT importance, cited_count, decay_seen_count, uncited_streak FROM observations WHERE id = ?',
      )
      .get(obsId);
    expect(row.importance).toBe(1); // D#179: untouched (seeded at 1)
    expect(row.cited_count).toBe(1);
    expect(row.decay_seen_count).toBe(1);
    expect(row.uncited_streak).toBe(0);
  });

  it('rolls the uncited streak over for a UserPromptSubmit-injected obs after 3 uncited sessions', () => {
    insertSession(db, { id: 'seed', project: 'p' });
    const r = insertObs(db, {
      sessionId: 'seed',
      project: 'p',
      type: 'decision',
      title: 'bench-warmer decision',
      importance: 3,
      lessonLearned: 'never cited',
    });
    const obsId = Number(r.lastInsertRowid);

    const stdout =
      '<memory-context relevance="high">\n' +
      `- [decision] bench-warmer decision (#${obsId})\n` +
      '</memory-context>\n';

    for (const sess of ['s1', 's2', 's3']) {
      insertSession(db, { id: sess, project: 'p' });
      const path = writeTranscript([upsAttachment(stdout)]);
      const injected = extractAllInjected(path);
      const cited = extractCitationsFromTranscript(path);
      applyCitationDecay(db, 'p', injected, cited, sess);
    }

    const row = db
      .prepare(
        'SELECT importance, uncited_streak, decay_seen_count, demoted_at FROM observations WHERE id = ?',
      )
      .get(obsId);
    expect(row.decay_seen_count).toBe(3);
    // D#179/D#198: importance stays 3. This row is exactly the case the change
    // exists for — a decision at importance 3 that goes three sessions uncited
    // used to drop to 2, which on the Key Context pool's `>= 3` tier arm is an
    // eviction from the candidate population, not a down-rank.
    expect(row.importance).toBe(3);
    expect(row.uncited_streak).toBe(0); // reset after the rollover
    expect(row.demoted_at).not.toBeNull();
  });

  it('counts a UPS injection only once per session even if formatMemoryLine repeats', () => {
    // Defensive: if formatMemoryLine ever emits the same obs twice in one
    // <memory-context> block (e.g. via dedup bug upstream), the injected Set
    // dedupes by construction.
    insertSession(db, { id: 'sess-dup', project: 'p' });
    const r = insertObs(db, {
      sessionId: 'sess-dup',
      project: 'p',
      type: 'decision',
      title: 't',
      importance: 2,
      lessonLearned: 'l',
    });
    const obsId = Number(r.lastInsertRowid);

    const path = writeTranscript([
      upsAttachment(
        '<memory-context relevance="high">\n' +
          `- [decision] t (#${obsId})\n` +
          `- [decision] t (#${obsId})\n` +
          '</memory-context>\n',
      ),
    ]);
    const injected = extractAllInjected(path);
    expect(injected.size).toBe(1);
    const result = applyCitationDecay(db, 'p', injected, new Set(), 'sess-dup');
    expect(result.touched).toBe(1);
  });

  it('mixed transcript: PTR-injected bugfix + UPS-injected decision both reach decay', () => {
    insertSession(db, { id: 'sess-mix', project: 'p' });
    const bugfixId = Number(
      insertObs(db, {
        sessionId: 'sess-mix',
        project: 'p',
        type: 'bugfix',
        title: 'fix Q',
        importance: 2,
        lessonLearned: 'Q-fix',
      }).lastInsertRowid,
    );
    const decisionId = Number(
      insertObs(db, {
        sessionId: 'sess-mix',
        project: 'p',
        type: 'decision',
        title: 'arch choice',
        importance: 2,
        lessonLearned: 'arch',
      }).lastInsertRowid,
    );

    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node /opt/scripts/pre-tool-recall.js',
          stdout: JSON.stringify({
            hookSpecificOutput: {
              additionalContext: `[mem] Lessons:\n  #${bugfixId} [bugfix] Q-fix`,
            },
          }),
        },
      },
      upsAttachment(
        '<memory-context relevance="high">\n' +
          `- [decision] arch choice | Lesson: arch (#${decisionId})\n` +
          '</memory-context>\n',
      ),
      // No citations in assistant text → both should streak (not promote/demote yet).
    ]);

    const injected = extractAllInjected(path);
    expect(injected.has(bugfixId)).toBe(true);
    expect(injected.has(decisionId)).toBe(true);

    const cited = extractCitationsFromTranscript(path);
    const result = applyCitationDecay(db, 'p', injected, cited, 'sess-mix');
    expect(result.touched).toBe(2);
    expect(result.promoted).toBe(0);
    expect(result.demoted).toBe(0); // streak hasn't hit threshold yet

    const bug = db
      .prepare('SELECT uncited_streak, decay_seen_count FROM observations WHERE id = ?')
      .get(bugfixId);
    const dec = db
      .prepare('SELECT uncited_streak, decay_seen_count FROM observations WHERE id = ?')
      .get(decisionId);
    expect(bug.uncited_streak).toBe(1);
    expect(bug.decay_seen_count).toBe(1);
    expect(dec.uncited_streak).toBe(1);
    expect(dec.decay_seen_count).toBe(1);
  });
});
