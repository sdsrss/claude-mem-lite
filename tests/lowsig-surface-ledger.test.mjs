// The low-signal ledger: every model-facing retrieval face, driven for real.
//
// R12 A3 found `keyObs` as the one face missing `notLowSignalTitleClause`, and
// the audit prescribed a ledger shaped like tests/inject-search-core.test.mjs'
// liveObsFilterSql one — a source-text scan over a list of files. Measured
// before writing this: that shape does not work for THIS clause. Of five
// non-compliant-looking sites read by hand, two were false positives —
// lib/recall-core.mjs composes it through a `${noiseClause}` variable, and
// hook-handoff.mjs enforces it in JS (`.filter(d => !LOW_SIGNAL_TITLE.test(...))`)
// rather than in SQL. The constraint has at least three spellings and a text
// scan sees one of them.
//
// So the ledger asserts on OUTPUT. Each face below gets the same fixture and
// must (a) render the real row, (b) render none of the degraded hook-llm
// fallback titles, and (c) still render a degraded title that carries a real
// lesson, because notLowSignalTitleClause is built with `lessonEscape: true`
// and a face that drops those is filtering content, not noise.
//
// Adding a new query inside an already-listed file cannot walk past this: the
// assertion is on what the face emits, not on what its source contains.
//
// NOT COVERED here, named rather than silently omitted: the UserPromptSubmit
// injection face (subprocess-only, asserted in tests/user-prompt-search.test.mjs),
// pre-tool-recall, and the hook-handoff "## Key Decisions" block, whose builder
// needs a session-summary fixture this file does not construct.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { effectiveQuiet } from '../lib/quiet-scope.mjs';
import { buildSessionContextLines } from '../hook-context.mjs';
import { recallByFile } from '../lib/recall-core.mjs';
import { collectBrowseTiers } from '../lib/browse-core.mjs';
import { searchRelevantMemories } from '../hook-memory.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

const PROJECT = 'test';
const FILE = 'zqxwidget.mjs';
const BODY = 'zqxwidget cache invalidation race on concurrent writes';

const REAL = 'Chose RRF over union-by-max for the zqxwidget merge';
const DEGRADED = ['Modified zqxwidget.mjs', 'Worked on zqxwidget cache'];
const DEGRADED_WITH_LESSON = 'Modified zqxwidget-config.mjs';

/**
 * The named `### <name>` sections of a rendered block, and nothing else.
 *
 * Anchored so `Recent` does not also swallow the `Recent Activity` fallback
 * heading, and tolerant of the date the Recent heading carries.
 */
function sections(out, names) {
  const lines = String(out).split('\n');
  const wanted = names.map((n) => new RegExp(`^### ${n}(\\s*\\(.*\\))?$`));
  const kept = [];
  let on = false;
  for (const line of lines) {
    if (line.startsWith('###')) on = wanted.some((re) => re.test(line.trim()));
    if (on) kept.push(line);
  }
  return kept.join('\n');
}

/** Flatten whatever a face returns into one text blob to assert against. */
function blob(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(blob).join('\n');
  if (typeof value === 'object') {
    // Rows carry the title under `title`; injection helpers return shaped objects.
    return Object.values(value).map(blob).join(' ');
  }
  return String(value);
}

// `policy` is the declared verdict for each face, and it is the reviewable part
// of this ledger:
//   'selects'    — the face CHOOSES a few rows to put in front of the model, so a
//                  degraded title there displaces a real one. Must filter.
//   'enumerates' — the face pages through what the store holds because a user
//                  asked it to. Hiding rows would be the defect. Exempt from the
//                  degraded-title rule, still bound by the other two.
// An exemption written here is visible in review; one expressed by leaving a
// face out of the list is not, which is why every face gets an entry. A face
// added WITHOUT a policy reds the ledger-wide `every face declares a policy`
// case below — not its own generated cases, which would take the `enumerates`
// branch by default and pass. Verified by mutation in pre-ship review.
const SURFACES = [
  // The SessionStart block is TWO faces with two different queries, and folding
  // them into one blob made the lessonEscape arm unfalsifiable: a title missing
  // from Key Context still reached the blob through the Recent table, so the arm
  // passed with `keyObs` escape-free. Pre-ship review caught it; splitting is the
  // fix, because each entry now asserts against the query that feeds it.
  {
    name: 'SessionStart — File Lessons + Key Context (keyObs)',
    policy: 'selects',
    run: (db) => sections(buildSessionContextLines(db, PROJECT, new Date()), ['File Lessons', 'Key Context']),
  },
  {
    name: 'SessionStart — Recent table (selectWithTokenBudget)',
    policy: 'selects',
    run: (db) => sections(buildSessionContextLines(db, PROJECT, new Date()), ['Recent']),
  },
  {
    name: 'recall by file (CLI + MCP share this)',
    policy: 'selects',
    run: (db) => recallByFile(db, FILE, { limit: 20 }),
  },
  {
    name: 'hook-memory prompt injection',
    policy: 'selects',
    // counterfactual: a ruler must not pollute what it measures (doctrine rule 6)
    // — this face records injections on the live path. MEM_COVERAGE_THRESHOLD is
    // relaxed for the same reason the UPS subprocess harness relaxes its floor:
    // a 4-row fixture cannot clear a production-calibrated gate, and the gate is
    // not what this ledger is measuring.
    env: { MEM_COVERAGE_THRESHOLD: '0' },
    run: (db) => searchRelevantMemories(db, BODY, PROJECT, [], { counterfactual: true }),
  },
  {
    name: 'browse tiers',
    policy: 'enumerates',
    why: 'browse is the user-invoked pager over working/active/archive; a row it hides is a row the user asked to see and did not get.',
    run: (db) => collectBrowseTiers(db, { project: PROJECT, limit: 20, now: Date.now() }),
  },
];

describe('low-signal ledger — every model-facing face, asserted on output', () => {
  let tmpHome, fakeCwd, origHome, origCwd, origQuiet, db;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'lowsig-ledger-'));
    fakeCwd = join(tmpHome, 'myproj');
    mkdirSync(fakeCwd, { recursive: true });
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    origQuiet = process.env.MEM_QUIET_HOOKS;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
    delete process.env.MEM_QUIET_HOOKS;

    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: PROJECT });

    const common = {
      sessionId: 'sess-1',
      project: PROJECT,
      text: BODY,
      filesModified: JSON.stringify([FILE]),
      importance: 2,
    };
    DEGRADED.forEach((title, i) =>
      insertObs(db, { ...common, type: 'change', title, epochOffset: -(i + 3) * 1000 }),
    );
    insertObs(db, { ...common, type: 'discovery', title: REAL, importance: 3, epochOffset: -1000 });
    const lesson = insertObs(db, {
      ...common,
      type: 'change',
      title: DEGRADED_WITH_LESSON,
      lessonLearned: 'the resolve.alias order decides which copy of react loads',
      epochOffset: -2000,
    });
    // Decouple the RENDER branch from the file EDGE. hook-context routes a row
    // with lesson AND files into `### File Lessons`, which prints
    // `basename: lesson` and never the title — so this row's title reached the
    // blob only through the Recent table, and the lessonEscape arm below passed
    // without binding `keyObs` at all (pre-ship review proved it with a
    // mutation: the arm stayed green while the sibling file went red).
    // Clearing the column leaves the observation_files edge intact, so the
    // recall face still reaches this row.
    db.prepare("UPDATE observations SET files_modified = '[]' WHERE id = ?").run(
      Number(lesson.lastInsertRowid),
    );
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origCwd;
    if (origQuiet === undefined) delete process.env.MEM_QUIET_HOOKS;
    else process.env.MEM_QUIET_HOOKS = origQuiet;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('premise: the sandbox is unadopted, so nothing here is trimmed away', () => {
    expect(effectiveQuiet(), 'quiet is on — the SessionStart face would render nothing').toBe(false);
  });

  it('premise: the ledger is non-empty', () => {
    expect(SURFACES.length).toBeGreaterThan(3);
  });

  /** Run one face under its declared env, restoring whatever was there. */
  function drive(surface) {
    const saved = new Map();
    for (const [k, v] of Object.entries(surface.env ?? {})) {
      saved.set(k, process.env[k]);
      process.env[k] = v;
    }
    try {
      return blob(surface.run(db));
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('every face declares a policy', () => {
    // A face added without a verdict is the hole this ledger exists to close.
    for (const s of SURFACES) {
      expect(['selects', 'enumerates'], `${s.name} has no policy`).toContain(s.policy);
      if (s.policy === 'enumerates') {
        expect(s.why, `${s.name} is exempt but states no reason`).toBeTruthy();
      }
    }
  });

  for (const surface of SURFACES) {
    describe(surface.name, () => {
      it('premise: reaches the fixture at all', () => {
        // Without this, every not.toContain below passes on an empty string —
        // the exact vacuous-guard shape this repo keeps rediscovering.
        expect(drive(surface), 'face returned nothing for the fixture').toContain(REAL);
      });

      const degradedCase =
        surface.policy === 'selects'
          ? 'renders no degraded hook-llm fallback title'
          : 'enumerates degraded titles on purpose (declared exemption)';

      it(degradedCase, () => {
        const out = drive(surface);
        for (const title of DEGRADED) {
          if (surface.policy === 'selects') {
            expect(out, `degraded title reached a SELECTING face: ${title}`).not.toContain(title);
          } else {
            // Asserted, not skipped: if an enumerating face starts filtering, the
            // exemption above has gone stale and someone must re-read it.
            expect(out, `${surface.name} began filtering — re-examine its policy`).toContain(title);
          }
        }
      });

      it('still renders a degraded title that carries a lesson (lessonEscape)', () => {
        expect(drive(surface), 'lessonEscape dropped — this face is filtering content, not noise').toContain(
          DEGRADED_WITH_LESSON,
        );
      });
    });
  }
});
