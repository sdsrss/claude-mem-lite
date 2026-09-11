// R12 A3 — `keyObs` was the only model-facing observations retrieval without
// `notLowSignalTitleClause`, so hook-llm's fallback titles ("Modified X",
// "Worked on X", a raw error line) could occupy the `### Key Context` section
// while the sibling Recent table, drawing on a pool that DOES carry the clause,
// excluded them in the same call.
//
// Reachability, which is what made it a live defect rather than a theoretical
// one: scoring-sql.mjs argues low-signal rows are pinned to importance=1 at
// write time, but two writers raise importance WITHOUT looking at the title —
// maintain-core's boostAccessed (predicate: access_count > 3) and
// search-scoring's autoBoostIfNeeded (access_count >= 2). Opening one row twice
// is enough to put "Modified webpack.config.js" into this pool permanently.
//
// PREMISE: effectiveQuiet() drops BOTH sections, and it is true under this
// repo's own cwd because the repo is adopted — so every assertion here would
// pass vacuously without an unadopted sandbox. The first case asserts that.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { effectiveQuiet } from '../lib/quiet-scope.mjs';
import { buildSessionContextLines } from '../hook-context.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

const REAL = 'Chose RRF over union-by-max for hybrid merge';
const NOISE = [
  'Modified webpack.config.js',
  'Worked on hook-context.mjs',
  'Error: ENOENT no such file build/out.js',
];

/**
 * Lines of one `### <name>` section, up to the next heading.
 *
 * The Recent heading carries a date (`### Recent (2026-09-11)`), so exact
 * equality silently returns '' and every `not.toContain` below would pass on an
 * empty string — the control arm caught that on its first run. Anchored so
 * `Recent` cannot also match the `Recent Activity` fallback heading.
 */
function section(out, name) {
  const re = new RegExp(`^### ${name}(\\s*\\(.*\\))?$`);
  const lines = out.split('\n');
  const start = lines.findIndex((l) => re.test(l.trim()));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('###'));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('Key Context excludes low-signal titles (R12 A3)', () => {
  let tmpHome, fakeCwd, origHome, origCwd, origQuiet, db;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'keyctx-lowsig-'));
    fakeCwd = join(tmpHome, 'myproj');
    mkdirSync(fakeCwd, { recursive: true });
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    origQuiet = process.env.MEM_QUIET_HOOKS;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
    delete process.env.MEM_QUIET_HOOKS;

    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
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

  /** The audit's fixture: three boosted fallback titles, one real row. */
  function seedFourRows() {
    NOISE.forEach((title, i) => {
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'test',
        type: 'change',
        title,
        importance: 2, // boostAccessed / autoBoostIfNeeded get here without reading the title
        epochOffset: -(i + 2) * 1000,
      });
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'discovery',
      title: REAL,
      importance: 3,
      epochOffset: -1000,
    });
  }

  it('premise: the sections render at all (unadopted sandbox, quiet off)', () => {
    seedFourRows();
    expect(effectiveQuiet(), 'quiet is on — every assertion below would be vacuous').toBe(false);
    const out = buildSessionContextLines(db, 'test', new Date());
    expect(out, 'Key Context section absent — nothing to assert on').toContain('### Key Context');
  });

  it('renders the real observation and none of the fallback titles', () => {
    seedFourRows();
    const keyCtx = section(buildSessionContextLines(db, 'test', new Date()), 'Key Context');
    expect(keyCtx).toContain(REAL);
    for (const title of NOISE) {
      expect(keyCtx, `low-signal title reached Key Context: ${title}`).not.toContain(title);
    }
  });

  it('control: the Recent table in the SAME call agrees with Key Context', () => {
    // Without this arm, changing keyObs to some OTHER inconsistent filter would
    // still pass the case above. The two sections must agree, not merely differ
    // from the old behaviour.
    seedFourRows();
    const out = buildSessionContextLines(db, 'test', new Date());
    const recent = section(out, 'Recent');
    expect(recent, 'the control arm lost its own fixture').toContain(REAL);
    for (const title of NOISE) {
      expect(recent, `Recent and Key Context disagree on: ${title}`).not.toContain(title);
    }
  });

  it('still renders a low-signal title that carries a real lesson (lessonEscape)', () => {
    // notLowSignalTitleClause is built WITH lessonEscape: a degraded title that
    // still carries a lesson is content, not noise. Swapping the clause for a
    // bare buildNotLowSignalSql would hide this row — and no other case here
    // would notice, which is why this arm exists.
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'change',
      title: 'Modified webpack.config.js',
      importance: 2,
      lessonLearned: 'the resolve.alias order decides which copy of react loads',
      filesModified: '[]', // no files -> lands in Key Context, not File Lessons
      epochOffset: -1000,
    });
    const keyCtx = section(buildSessionContextLines(db, 'test', new Date()), 'Key Context');
    expect(keyCtx, 'lessonEscape dropped — a lesson-bearing row was filtered as noise').toContain(
      'Modified webpack.config.js',
    );
  });
});
