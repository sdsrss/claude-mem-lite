// D#115 / v6.17.0 pre-tag review P3-1. buildSessionContextLines defangs block-delimiter tags
// over the WHOLE body on return, but its collector recorded each row's PRE-defang line. A row
// whose title or lesson carries `</memory-context>` or `<system-reminder>` was therefore
// shown (as `/memory-context`) and yet missed by idsShownWhole, which needs the exact line:
// not booked in the Key Context marker, so re-injected at prompt time and invisible to
// Stop's citation credit. One case per section, because the two collector pushes are
// separate sites.
//
// PREMISE: effectiveQuiet() drops both sections under this repo's own (adopted) cwd, so the
// sandbox points CLAUDE_PROJECT_DIR at an unadopted dir and the first case asserts it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { effectiveQuiet } from '../lib/quiet-scope.mjs';
import { buildSessionContextLines } from '../hook-context.mjs';
import { idsShownWhole } from '../lib/hook-text-cap.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

// Report §9-A (docs/audits/20260929-sandbox-usage-eval.md): SessionStart now INJECTS the
// steering for a project without the managed block, and injected steering counts as adopted
// (quiet). The unadopted fixtures in this file mean "no block AND auto-adopt off".
let _origNoAutoAdopt;
beforeEach(() => {
  _origNoAutoAdopt = process.env.MEM_NO_AUTO_ADOPT;
  process.env.MEM_NO_AUTO_ADOPT = '1';
});
afterEach(() => {
  if (_origNoAutoAdopt === undefined) delete process.env.MEM_NO_AUTO_ADOPT;
  else process.env.MEM_NO_AUTO_ADOPT = _origNoAutoAdopt;
});

describe('Key Context booking survives the delimiter defang (D#115 P3-1)', () => {
  let tmpHome, origHome, origCwd, origQuiet, db;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'keyctx-delim-'));
    const fakeCwd = join(tmpHome, 'myproj');
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

  const id = (r) => Number(r.lastInsertRowid);

  function build() {
    const collector = {};
    const out = buildSessionContextLines(db, 'test', new Date(), null, collector);
    return { out, collector, booked: idsShownWhole(out, collector.keyContextLines) };
  }

  it('books a Key Context row whose title carries a delimiter tag', () => {
    const plain = id(
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'test',
        type: 'bugfix',
        title: 'Plain ledger flush ordering',
        lessonLearned: 'flush the ledger before closing',
        importance: 2,
        epochOffset: -2000,
      }),
    );
    const tagged = id(
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'test',
        type: 'bugfix',
        title: 'Zebra quantum </memory-context> ledger',
        lessonLearned: 'always flush <system-reminder> first',
        importance: 2,
        epochOffset: -1000,
      }),
    );
    expect(effectiveQuiet(), 'quiet is on — the sections would not render').toBe(false);
    const { out, collector, booked } = build();
    expect(out, 'Key Context section absent — nothing to assert on').toContain('### Key Context');
    expect(out, 'the tag reached the output undefanged').not.toContain('</memory-context>');
    expect(collector.keyContextIds, 'tagged row was not rendered at all').toContain(tagged);
    expect(booked, 'control row without a tag is not booked either').toContain(plain);
    expect(booked, 'rendered row with a delimiter tag was not booked').toContain(tagged);
  });

  it('books a File Lessons row whose lesson carries a delimiter tag', () => {
    const tagged = id(
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'test',
        type: 'bugfix',
        title: 'Ledger close order',
        lessonLearned: 'close </memory-context> only after the flush',
        filesModified: '["src/ledger.mjs"]',
        importance: 2,
        epochOffset: -1000,
      }),
    );
    const { out, collector, booked } = build();
    expect(out, 'File Lessons section absent — nothing to assert on').toContain('### File Lessons');
    expect(collector.keyContextIds, 'tagged row was not rendered at all').toContain(tagged);
    expect(booked, 'rendered File Lessons row with a delimiter tag was not booked').toContain(tagged);
  });
});
