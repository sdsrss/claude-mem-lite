// 3-way equivalence sync test for LOW_SIGNAL patterns.
//
// Before method β: utils.mjs regex / scoring-sql.mjs NOT LIKE / pre-tool-recall.js
// inline SQL were hand-mirrored via "keep in sync" comments. This test gives CI
// teeth to catch drift by running the same 40+ title samples through all three
// paths and asserting they agree on every sample.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import {
  LOW_SIGNAL_PATTERNS,
  buildLowSignalRegex,
  buildNotLowSignalSql,
} from '../lib/low-signal-patterns.mjs';
import { LOW_SIGNAL_TITLE } from '../utils.mjs';
import { notLowSignalTitleClause } from '../scoring-sql.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { searchObservationsHybrid } from '../search-engine.mjs';

// Sample titles that cover every pattern + a set of legitimate titles that
// must NOT be flagged. Seeded to make the test deterministic and exhaustive
// w.r.t. the 12 patterns.
const SAMPLES = [
  // Should match (LOW_SIGNAL = true)
  { t: 'Modified install.mjs', low: true },
  { t: 'Modified hook-llm.mjs, utils.mjs +3 more', low: true },
  { t: 'Worked on schema.mjs', low: true },
  { t: 'Reviewed 7 files: a.mjs, b.mjs', low: true },
  { t: 'Reviewed 12 files: x.mjs', low: true },
  { t: 'Codebase exploration: projects--mem schema, FTS5', low: true },
  { t: 'Codebase exploration of session hook generation', low: true },
  { t: 'Error while working on tests/foo.test.mjs', low: true },
  { t: 'Error in tests/bar.test.mjs:42', low: true },
  { t: 'Error: hook.mjs, hook-episode.mjs: 145|proj|raw', low: true },
  { t: '# This is a raw shell stdout dump', low: true },
  { t: 'node cli.mjs doctor', low: true },
  { t: 'npm install --save', low: true },
  { t: 'npx some-tool run', low: true },
  { t: '(no description) — fallback', low: true },
  { t: 'gh release list ... (error)', low: true },
  { t: 'bash command failed (error)', low: true },

  // Should NOT match (legitimate titles — real lessons/bugfixes/decisions)
  { t: 'doctor dep checks: use import probe not path check', low: false },
  { t: 'title dedup must happen at basename layer', low: false },
  { t: 'hook-update SOURCE_FILES drift', low: false },
  { t: 'FTS5 external-content delete trigger needs orig values', low: false },
  { t: 'handoff injection misread as user message', low: false },
  { t: 'rebuildVector wrote vectors to wrong table/column', low: false },
  { t: 'Heterogeneous hook events get heterogeneous context budgets', low: false },
  { t: 'pre-tool-recall Edit fallback must stack filters', low: false },
  { t: 'Batch A: CLI↔MCP parity fields', low: false },
  { t: 'dev-drift detection: symlink/plain mix', low: false },
  { t: 'Fix weak regex in makeEntryDesc', low: false },
  { t: 'v2.34.1 UX audit — 4 fixes', low: false },
  { t: 'Version bump 2.34.5 → 2.34.6', low: false },
  { t: 'measure signal-content of blocked set', low: false },

  // Edge cases
  { t: '', low: false }, // empty should be benign
  { t: 'Error out of memory — genuine crash report', low: true }, // "Error: " prefix catches this
  // wait, "Error out" doesn't match any pattern (no colon). Let me re-check.
];

// Fix: "Error out of memory" — no pattern matches (no colon or 'in '/'while working').
// Correct the edge case.
SAMPLES[SAMPLES.length - 1] = { t: 'Error out of memory — genuine crash report', low: false };

describe('LOW_SIGNAL patterns — 3-way equivalence', () => {
  let db;

  // Build an in-memory DB with a `titles(title)` table seeded with SAMPLES,
  // then run the SQL NOT LIKE clause against it to check equivalence.
  // lesson_learned column: notLowSignalTitleClause now carries the read-side
  // lesson escape, so the fixture table must expose the column it references.
  // Rows are inserted with lesson NULL — with no lesson, escaped SQL must be
  // equivalent to the pure title chain, which is what the sync tests assert.
  function sqlSignalsMatch(title, lesson = null) {
    if (!db) {
      db = new Database(':memory:');
      db.exec('CREATE TABLE t (title TEXT, lesson_learned TEXT)');
    }
    db.prepare('DELETE FROM t').run();
    db.prepare('INSERT INTO t(title, lesson_learned) VALUES (?, ?)').run(title, lesson);
    // title is LOW_SIGNAL iff NOT (notLowSignalTitleClause) evaluates true
    const row = db.prepare(`SELECT NOT ${notLowSignalTitleClause('t')} AS is_low FROM t`).get();
    return row.is_low === 1;
  }

  function moduleSqlMatches(title, lesson = null, opts = undefined) {
    if (!db) {
      db = new Database(':memory:');
      db.exec('CREATE TABLE t (title TEXT, lesson_learned TEXT)');
    }
    db.prepare('DELETE FROM t').run();
    db.prepare('INSERT INTO t(title, lesson_learned) VALUES (?, ?)').run(title, lesson);
    const row = db.prepare(`SELECT NOT ${buildNotLowSignalSql('t', opts)} AS is_low FROM t`).get();
    return row.is_low === 1;
  }

  it('utils.mjs regex agrees with ground-truth labels on all samples', () => {
    for (const { t, low } of SAMPLES) {
      const matched = LOW_SIGNAL_TITLE.test(t);
      expect(matched).toBe(low);
    }
  });

  it('scoring-sql.mjs NOT LIKE agrees with ground-truth labels on all samples', () => {
    for (const { t, low } of SAMPLES) {
      expect(sqlSignalsMatch(t)).toBe(low);
    }
  });

  it('low-signal-patterns.mjs buildNotLowSignalSql agrees with ground-truth labels', () => {
    for (const { t, low } of SAMPLES) {
      expect(moduleSqlMatches(t)).toBe(low);
    }
  });

  it('low-signal-patterns.mjs buildLowSignalRegex agrees with utils.mjs regex', () => {
    const modRegex = buildLowSignalRegex();
    for (const { t } of SAMPLES) {
      expect(modRegex.test(t)).toBe(LOW_SIGNAL_TITLE.test(t));
    }
  });

  it('utils.mjs regex ↔ scoring-sql.mjs SQL give identical verdicts (symmetry guard)', () => {
    for (const { t } of SAMPLES) {
      const regexSaysLow = LOW_SIGNAL_TITLE.test(t);
      const sqlSaysLow = sqlSignalsMatch(t);
      expect(sqlSaysLow).toBe(regexSaysLow);
    }
  });

  it('scripts/pre-tool-recall.js derives from lib/low-signal-patterns.mjs (no inline SQL)', () => {
    // β refactor: pre-tool-recall should import buildNotLowSignalSql, NOT
    // maintain its own hardcoded NOT LIKE list. This guards against regression
    // back to the drift-prone inline pattern.
    const src = readFileSync('scripts/pre-tool-recall.js', 'utf8');
    expect(src).toContain('import { buildNotLowSignalSql }');
    expect(src).toContain("from '../lib/low-signal-patterns.mjs'");

    // Verify NO stray "o.title NOT LIKE 'Xxx %'" hardcoded patterns remain.
    // (A single call site using buildNotLowSignalSql('o') is allowed — that
    // produces runtime SQL, not a source-file literal.)
    const inlineHits = src.match(/o\.title NOT LIKE '[^']+'/g);
    expect(inlineHits).toBeNull();
  });

  it('all 12 patterns from LOW_SIGNAL_PATTERNS are covered by at least one sample', () => {
    // Coverage guard — if we add a pattern, ensure a sample exercises it
    const coverage = new Set();
    for (const { t, low } of SAMPLES) {
      if (!low) continue;
      for (const { regex } of LOW_SIGNAL_PATTERNS) {
        if (new RegExp(regex).test(t)) coverage.add(regex);
      }
    }
    expect(coverage.size).toBe(LOW_SIGNAL_PATTERNS.length);
  });

  // ── Read-side lesson escape (2026-07-24 audit P1, D#11) ────────────────────
  //
  // The write-side gates (isNoiseObservation / capNoiseImportance) keep a
  // LOW_SIGNAL-titled row when it carries real signal (lesson_learned), but the
  // read-side SQL chain hid it unconditionally — a substantive "npm pack drops
  // npm-shrinkwrap.json …" bugfix was invisible to search/recall/injection
  // because its title starts with 'npm '. The escape restores symmetry: a
  // low-signal TITLE no longer hides a row whose lesson_learned is set.
  const LESSON = 'verify the published tarball contents, not just the step ran';

  it('lessonEscape option: low-signal title + real lesson is NOT hidden', () => {
    expect(
      moduleSqlMatches('npm pack drops npm-shrinkwrap.json on files[] whitelist', LESSON, {
        lessonEscape: true,
      }),
    ).toBe(false);
    expect(moduleSqlMatches('Error: FTS5 column mismatch', LESSON, { lessonEscape: true })).toBe(false);
  });

  it('lessonEscape option: low-signal title without real lesson stays hidden', () => {
    for (const lesson of [null, '', 'none', ' None ', '  ']) {
      expect(moduleSqlMatches('npm install --save', lesson, { lessonEscape: true })).toBe(true);
    }
  });

  it('lessonEscape option: legitimate titles are unaffected either way', () => {
    expect(moduleSqlMatches('Fix weak regex in makeEntryDesc', null, { lessonEscape: true })).toBe(false);
    expect(moduleSqlMatches('Fix weak regex in makeEntryDesc', LESSON, { lessonEscape: true })).toBe(false);
  });

  it('default (no option) stays title-only — events/stats consumers unchanged', () => {
    // events table has no lesson_learned column; the pure builder must not
    // reference it. Guard: SQL contains no lesson_learned identifier.
    expect(buildNotLowSignalSql('o')).not.toContain('lesson_learned');
    expect(moduleSqlMatches('npm install --save', LESSON)).toBe(true);
  });

  it('scoring-sql notLowSignalTitleClause carries the lesson escape', () => {
    expect(sqlSignalsMatch('npm pack drops npm-shrinkwrap.json on files[] whitelist', LESSON)).toBe(false);
    expect(sqlSignalsMatch('npm pack drops npm-shrinkwrap.json on files[] whitelist', null)).toBe(true);
  });
});

describe('read-side lesson escape — end-to-end search regression (obs #229 shape)', () => {
  it('finds a lesson-bearing obs whose title starts with a LOW_SIGNAL prefix', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1' });
    insertObs(db, {
      project: 'test',
      type: 'bugfix',
      title: 'npm pack drops npm-shrinkwrap.json when package.json has a files[] whitelist',
      narrative: 'npm packlist always-include set covers package.json but not the shrinkwrap',
      lessonLearned:
        'verify the PUBLISHED tarball contents (npm pack + tar -tzf), not just that the generating step ran',
      importance: 2,
    });
    // Same low-signal title shape, no lesson → must stay hidden from search.
    insertObs(db, {
      project: 'test',
      type: 'change',
      title: 'npm pack drops warnings on stale shrinkwrap fixture',
      narrative: '',
      importance: 1,
    });

    const rows = searchObservationsHybrid(db, {
      ftsQuery: 'shrinkwrap',
      args: {},
      epochFrom: null,
      epochTo: null,
      perSourceLimit: 10,
      perSourceOffset: 0,
      currentProject: 'test',
      limit: 10,
    });
    const titles = rows.map((r) => r.title);
    expect(titles).toContain('npm pack drops npm-shrinkwrap.json when package.json has a files[] whitelist');
    expect(titles).not.toContain('npm pack drops warnings on stale shrinkwrap fixture');
    db.close();
  });
});
