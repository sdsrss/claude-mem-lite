// The adopted detail doc (<cwd>/.claude/plugin_claude_mem_lite.md) tells the model what
// citing does. Until v6.13.0 it said an uncited lesson loses 1 importance after three
// sessions and a cited one gains 1 — true as shipped in v2.73.2, false since D#179/D#198
// removed both importance writes from applyCitationDecay. The copy the MODEL reads was
// the one copy the retraction never reached (docs/audits/20260925-200912-session-history-
// analysis.md §4.3). These cases pin the claim to the code rather than to the prose.
import { describe, it, expect } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { applyCitationDecay } from '../lib/citation-tracker.mjs';
import { getDetailDoc } from '../adopt-content.mjs';

describe('adopt detail doc — citation feedback claim matches the decay loop', () => {
  it('no longer promises an importance change per cited / uncited session', () => {
    const doc = getDetailDoc();
    expect(doc).toContain('系统按会话追踪引用');
    expect(doc).not.toMatch(/importance\s*[−-]1/);
    expect(doc).not.toMatch(/封顶\s*3/);
    // The dismissal marker is described as an answer, not an adoption (B2, 00effdc).
    expect(doc).toMatch(/'#NN n\/a'`?\s*算作已回应，但不算采纳：排序上与未引用相同/);
  });

  it('the loop it describes leaves importance alone on both branches', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'p' });
    const seed = (title) =>
      Number(
        insertObs(db, { project: 'p', type: 'bugfix', title, lessonLearned: 'a lesson', importance: 2 })
          .lastInsertRowid,
      );
    const cited = seed('cited row');
    const uncited = seed('uncited row');
    for (let i = 0; i < 3; i++) {
      applyCitationDecay(db, 'p', new Set([cited, uncited]), new Set([cited]), `decay-sess-${i}`);
    }
    const imp = (id) =>
      db.prepare('SELECT importance, cited_count, demoted_at FROM observations WHERE id = ?').get(id);
    // Premise: the loop ran — the cited row was credited and the uncited row rolled over.
    expect(imp(cited).cited_count).toBe(3);
    expect(imp(uncited).demoted_at).not.toBeNull();
    expect(imp(cited).importance).toBe(2);
    expect(imp(uncited).importance).toBe(2);
    db.close();
  });
});
