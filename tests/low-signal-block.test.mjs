// P0 write-side noise filter — isNoiseObservation()
//
// Contract: low-signal-titled observations are blocked at insert time when they
// carry NO downstream signal (no lesson, importance<2, empty facts, thin narrative).
// Substantive titles pass unchanged. Env CLAUDE_MEM_KEEP_LOW_SIGNAL=1 opts out.

import { describe, it, expect } from 'vitest';
import { isNoiseObservation, capNoiseImportance, isLowYieldChangeObs } from '../lib/low-signal-patterns.mjs';

const EMPTY_ENV = {};

describe('isNoiseObservation — P0 write-side filter', () => {
  it('blocks LOW_SIGNAL title with empty facts, null lesson, thin narrative', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Modified install.mjs, source-files.mjs',
          facts: [],
          narrative: '',
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(true);
  });

  it('blocks Error: title with stderr-looking narrative', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Error: hook.mjs, schema.mjs',
          narrative: 'Error: Cannot find module better-sqlite3',
          facts: [],
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(true);
  });

  it('blocks Worked on X with no signal', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Worked on schema.mjs',
          facts: [],
          narrative: '',
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(true);
  });

  it('blocks Codebase exploration without facts', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Codebase exploration: projects--mem schema',
          facts: [],
          narrative: '',
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(true);
  });

  it('keeps LOW_SIGNAL title when facts has >=1 non-empty string', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Modified hook-llm.mjs',
          facts: ['added saveObservation guard for null lesson'],
          narrative: '',
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(false);
  });

  it('keeps LOW_SIGNAL title when lesson_learned is substantive', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Error: schema.mjs',
          lessonLearned: 'FTS5 trigger fires on any column UPDATE — wrap access_count in try/catch',
          facts: [],
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(false);
  });

  it('treats lesson_learned="none" as no signal (Haiku fallback)', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Modified schema.mjs',
          lessonLearned: 'none',
          facts: [],
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(true);
  });

  it('accepts snake_case lesson_learned field', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Modified schema.mjs',
          lesson_learned: 'Real lesson: observations_au trigger corrupts FTS on partial updates',
          facts: [],
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(false);
  });

  it('keeps LOW_SIGNAL title when importance >= 2', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Modified schema.mjs',
          facts: [],
          importance: 2,
        },
        EMPTY_ENV,
      ),
    ).toBe(false);
  });

  it('keeps LOW_SIGNAL title when narrative is substantive (>=40 chars, not stderr)', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Modified hook-llm.mjs',
          facts: [],
          narrative:
            'Wrapped saveObservation vector write in try-catch to prevent FTS corruption from propagating during multi-session flushes.',
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(false);
  });

  it('blocks when narrative is substantive but looks like raw stderr', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Error: hook.mjs',
          facts: [],
          narrative:
            'Error: Cannot find module better-sqlite3 at require (node:internal/modules/cjs/loader.js:123)',
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(true);
  });

  it('keeps substantive title regardless of other fields being empty', () => {
    expect(
      isNoiseObservation(
        {
          title: 'FTS5 external-content trigger needs orig values on UPDATE',
          facts: [],
          narrative: '',
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(false);
  });

  it('respects CLAUDE_MEM_KEEP_LOW_SIGNAL=1 opt-out (pre-P0 behavior)', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Modified install.mjs',
          facts: [],
          narrative: '',
          importance: 1,
        },
        { CLAUDE_MEM_KEEP_LOW_SIGNAL: '1' },
      ),
    ).toBe(false);
  });

  it('treats empty/missing facts array consistently with no-facts case', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Modified a.mjs',
          narrative: '',
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(true);
    expect(
      isNoiseObservation(
        {
          title: 'Modified a.mjs',
          facts: ['', '  '],
          narrative: '',
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(true);
  });

  it('empty title is not low-signal (substantive fallthrough)', () => {
    expect(
      isNoiseObservation(
        {
          title: '',
          facts: [],
          narrative: '',
          importance: 1,
        },
        EMPTY_ENV,
      ),
    ).toBe(false);
  });
});

describe('isNoiseObservation — P2 tool-output passthrough detection', () => {
  // buildImmediateObservation joins entry descs with "; ", each desc is "cmd → output"
  // from post-tool-use.sh. Such narratives are raw tool output, not curated prose.
  const longStderr =
    'git diff 7caa0dc~1..a01ab45 -- schema.mjs tests/schema.test.mjs → diff --git a/schema.mjs b/schema.mjs\nindex abc..def 100644\n@@ -1,5 +1,7 @@';

  it('blocks narrative with " → " passthrough (buildImmediateObservation format)', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Error: schema.mjs',
          narrative: longStderr,
          facts: [],
          importance: 1,
        },
        {},
      ),
    ).toBe(true);
  });

  it('blocks narrative with stack trace fragments', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Error: app.mjs',
          narrative:
            'ReferenceError: foo is not defined\n    at bar (/app/src/lib.js:42:10)\n    at baz (/app/src/main.js:7:3)',
          facts: [],
          importance: 1,
        },
        {},
      ),
    ).toBe(true);
  });

  it('blocks narrative with node:internal/ references', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Error: index.mjs',
          narrative:
            'Uncaught TypeError at something in node:internal/process/task_queues:95:5 — process exited with code 1',
          facts: [],
          importance: 1,
        },
        {},
      ),
    ).toBe(true);
  });

  it('blocks narrative with test-runner failure banner', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Error: tests/foo.test.mjs',
          narrative:
            ' FAIL  tests/foo.test.mjs > suite > it works\nAssertionError: expected 1 to equal 2 at assertEqual\n  +expected -actual',
          facts: [],
          importance: 1,
        },
        {},
      ),
    ).toBe(true);
  });

  it('blocks narrative with raw diff output', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Modified schema.mjs',
          narrative:
            'diff --git a/schema.mjs b/schema.mjs\n@@ -10,5 +10,7 @@ export function\n-  old line\n+  new line 1\n+  new line 2',
          facts: [],
          importance: 1,
        },
        {},
      ),
    ).toBe(true);
  });

  it('blocks narrative with multi-"; " join and no sentence prose', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Modified app.mjs',
          narrative: 'Created app.mjs (1234 chars); Created helper.mjs (432 chars); Modified index.mjs',
          facts: [],
          importance: 1,
        },
        {},
      ),
    ).toBe(true);
  });

  it('keeps narrative that is curated prose (Haiku-generated)', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Modified schema.mjs',
          narrative:
            'Refactored schema guard so the migration-check hook runs before DB open. Eliminates race with module-level init that created DB_DIR early. No behavior change for users.',
          facts: [],
          importance: 1,
        },
        {},
      ),
    ).toBe(false);
  });

  it('keeps narrative with single "; " and sentence prose', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Modified hook.mjs',
          narrative:
            'Wrapped vector write in try-catch; ensures FTS trigger corruption does not cascade. Prior code could throw during multi-session flushes.',
          facts: [],
          importance: 1,
        },
        {},
      ),
    ).toBe(false);
  });

  // v2.54.0 regression: rule-based importance can be inflated to 2-3 by filename
  // heuristics (computeRuleImportance fires on test/schema/migration paths).
  // Prior behavior: imp>=2 short-circuited and kept the row, letting raw stderr
  // narratives slip through. 30d audit (2026-04-30) found 64 such 'Error: X'
  // entries in projects--mem alone. Fix: passthrough check now overrides imp escape.
  it('blocks Error: X with imp=2 when narrative is raw passthrough (rule-inflated escape)', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Error: tests/foo.test.mjs, schema.mjs',
          narrative:
            'npx vitest run tests/foo.test.mjs → ERROR: SqliteError: no such column: foo at Database.prepare',
          facts: [],
          importance: 2,
        },
        {},
      ),
    ).toBe(true);
  });

  it('blocks Modified X with imp=3 when narrative is "; "-joined entry passthrough', () => {
    expect(
      isNoiseObservation(
        {
          title: 'Modified migration/0042_users.sql',
          narrative:
            'Edit /a/foo.mjs; Bash npm test → FAIL; Bash git diff → diff --git a/foo b/foo @@ -1 +1 @@',
          facts: [],
          importance: 3,
        },
        {},
      ),
    ).toBe(true);
  });

  it('still keeps imp=2 LOW_SIGNAL when narrative is empty (no passthrough signal)', () => {
    // imp>=2 escape still applies when narrative does NOT look like raw output.
    expect(
      isNoiseObservation(
        {
          title: 'Modified schema.mjs',
          narrative: '',
          facts: [],
          importance: 2,
        },
        {},
      ),
    ).toBe(false);
  });
});

describe('capNoiseImportance — v2.47 P0-3 write-side importance cap', () => {
  // Live DB diagnosed: 341 LOW_SIGNAL+imp=3 obs where only 1 had a lesson and
  // 1 had facts (99.4% noise at importance=3). isNoiseObservation does not drop
  // those because its importance>=2 short-circuit treats the Haiku-assigned
  // importance as trust. capNoiseImportance keeps the row but forces imp=1,
  // so auto-compress can GC them on the 7-day accelerated window.

  it('caps LOW_SIGNAL + no lesson + no facts at importance=1 regardless of input', () => {
    expect(capNoiseImportance({ title: 'Modified install.mjs', facts: [], importance: 3 })).toBe(1);
    expect(capNoiseImportance({ title: 'Modified install.mjs', facts: [], importance: 2 })).toBe(1);
    expect(capNoiseImportance({ title: 'Error: hook.mjs', facts: [], importance: 3 })).toBe(1);
    expect(capNoiseImportance({ title: 'Reviewed 8 files: a.mjs, b.mjs', facts: [], importance: 3 })).toBe(1);
    expect(capNoiseImportance({ title: 'Worked on schema.mjs', facts: [], importance: 2 })).toBe(1);
  });

  it('preserves LOW_SIGNAL importance when lesson_learned is substantive', () => {
    expect(
      capNoiseImportance({
        title: 'Modified hook.mjs',
        facts: [],
        importance: 3,
        lesson_learned: 'FTS5 trigger fires on any UPDATE — wrap access_count writes in try/catch',
      }),
    ).toBe(3);
    // camelCase variant
    expect(
      capNoiseImportance({
        title: 'Modified hook.mjs',
        facts: [],
        importance: 2,
        lessonLearned: 'FTS5 trigger fires on any UPDATE — wrap access_count writes in try/catch',
      }),
    ).toBe(2);
  });

  it('preserves LOW_SIGNAL importance when facts has >=1 non-empty string', () => {
    expect(
      capNoiseImportance({
        title: 'Modified schema.mjs',
        facts: ['schema_version bumped 27→28'],
        importance: 3,
      }),
    ).toBe(3);
  });

  it('ignores lesson_learned="none" (Haiku default when nothing to learn)', () => {
    expect(
      capNoiseImportance({
        title: 'Modified hook.mjs',
        facts: [],
        importance: 3,
        lesson_learned: 'none',
      }),
    ).toBe(1);
  });

  it('does not cap substantive titles (non-LOW_SIGNAL) regardless of importance', () => {
    expect(
      capNoiseImportance({
        title: 'FTS5 corruption on concurrent access_count UPDATE',
        facts: [],
        importance: 3,
      }),
    ).toBe(3);
    expect(
      capNoiseImportance({
        title: 'Decision: use injection_count separate from access_count',
        facts: [],
        importance: 2,
      }),
    ).toBe(2);
  });

  it('passes through importance=1 and 0 unchanged', () => {
    expect(capNoiseImportance({ title: 'Modified app.mjs', facts: [], importance: 1 })).toBe(1);
    expect(capNoiseImportance({ title: 'Modified app.mjs', facts: [], importance: 0 })).toBe(0);
  });
});

// v2.56.0 #1: paired-gate DROP for type=change + null-lesson + low-importance.
// Pairs with capNoiseImportance (DEMOTE) per #8152. Existing isNoiseObservation
// is title-pattern keyed; this gate is type+lesson keyed and catches Haiku-titled
// `change` obs with substantive-looking titles but no extractable lesson.
// Empirical baseline: type=change has 16.5% hit-rate vs decision 72.7%; null-lesson
// `change` is the dominant noise band (67% of recent obs).
describe('isLowYieldChangeObs — v2.56.0 #1 paired DROP', () => {
  it('drops type=change with null lesson and importance=1', () => {
    expect(
      isLowYieldChangeObs({
        type: 'change',
        title: 'Updated FTS5 query in scoring-sql',
        lessonLearned: null,
        importance: 1,
      }),
    ).toBe(true);
  });

  it('drops type=change with lesson="none" and importance=1', () => {
    expect(
      isLowYieldChangeObs({
        type: 'change',
        title: 'Refactored cmdSearch helper',
        lessonLearned: 'none',
        importance: 1,
      }),
    ).toBe(true);
  });

  it('drops type=change with lesson<12 chars (short noise like "ok"/"works")', () => {
    expect(
      isLowYieldChangeObs({
        type: 'change',
        title: 'Edited schema.mjs',
        lessonLearned: 'fixed it',
        importance: 1,
      }),
    ).toBe(true);
  });

  it('drops type=change with lesson="" (empty after trim)', () => {
    expect(
      isLowYieldChangeObs({
        type: 'change',
        title: 'Updated cmdSearch',
        lessonLearned: '   ',
        importance: 1,
      }),
    ).toBe(true);
  });

  it('keeps type=change when lesson_learned is substantive (>=12 chars, not "none")', () => {
    expect(
      isLowYieldChangeObs({
        type: 'change',
        title: 'Updated FTS5 query in scoring-sql',
        lessonLearned: 'BM25 score sign flipped — lower is better in SQLite FTS5',
        importance: 1,
      }),
    ).toBe(false);
  });

  it('keeps type=change when importance >= 2 (Haiku flagged as notable)', () => {
    expect(
      isLowYieldChangeObs({
        type: 'change',
        title: 'Updated FTS5 query',
        lessonLearned: null,
        importance: 2,
      }),
    ).toBe(false);
  });

  it('keeps type=bugfix even with null lesson (only `change` is gated; bugfix retry path handles its own null)', () => {
    expect(
      isLowYieldChangeObs({
        type: 'bugfix',
        title: 'Fixed FTS5 trigger crash',
        lessonLearned: null,
        importance: 1,
      }),
    ).toBe(false);
  });

  it('keeps type=decision regardless (decision is high-yield, gate never fires)', () => {
    expect(
      isLowYieldChangeObs({
        type: 'decision',
        title: 'Use single source-of-truth module',
        lessonLearned: null,
        importance: 1,
      }),
    ).toBe(false);
  });

  it('keeps type=feature/refactor/discovery (not in gate scope)', () => {
    for (const type of ['feature', 'refactor', 'discovery']) {
      expect(
        isLowYieldChangeObs({
          type,
          title: 'Some title',
          lessonLearned: null,
          importance: 1,
        }),
      ).toBe(false);
    }
  });

  it('accepts snake_case lesson_learned field (parity with isNoiseObservation)', () => {
    expect(
      isLowYieldChangeObs({
        type: 'change',
        title: 'Refactored helper',
        lesson_learned: null,
        importance: 1,
      }),
    ).toBe(true);
    expect(
      isLowYieldChangeObs({
        type: 'change',
        title: 'Refactored helper',
        lesson_learned: 'BM25 score sign flipped — lower is better in SQLite FTS5',
        importance: 1,
      }),
    ).toBe(false);
  });

  it('respects CLAUDE_MEM_KEEP_LOW_SIGNAL=1 opt-out (parity with isNoiseObservation)', () => {
    expect(
      isLowYieldChangeObs(
        {
          type: 'change',
          title: 'Updated cmdSearch',
          lessonLearned: null,
          importance: 1,
        },
        { CLAUDE_MEM_KEEP_LOW_SIGNAL: '1' },
      ),
    ).toBe(false);
  });

  it('treats missing importance as 1 (default)', () => {
    expect(
      isLowYieldChangeObs({
        type: 'change',
        title: 'Updated cmdSearch',
        lessonLearned: null,
      }),
    ).toBe(true);
  });
});
