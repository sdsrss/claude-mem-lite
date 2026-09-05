// Phase D (Invited-Memory plan, T16): conditional trim based on sentinel.
// Verifies effectiveQuiet() flips to true under either env or adoption,
// and that buildSessionContextLines / buildServerInstructions follow suit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { tmpdir } from 'os';
import { join } from 'path';
// Imported from their real home (audit 2026-09-05 P1-2 moved them out of the hook layer);
// the re-export identity guard at the bottom is what keeps `hook-shared.mjs` honest.
import { effectiveQuiet, isAdoptedHere, isQuietHooks } from '../lib/quiet-scope.mjs';
import * as hookShared from '../hook-shared.mjs';
import { callLLM } from '../lib/llm-call.mjs';
import {
  HANDOFF_EXPIRY_CLEAR,
  HANDOFF_EXPIRY_EXIT,
  HANDOFF_ANCHOR_MAX_AGE,
  HANDOFF_MATCH_THRESHOLD,
  CONTINUE_KEYWORDS,
} from '../lib/handoff-constants.mjs';
import { writePluginSection, removePluginSection, memdirPath } from '../memdir.mjs';
import { writeManaged, removeManaged } from '../claudemd.mjs';
import {
  PLUGIN_SLUG,
  CURRENT_SENTINEL_VERSION,
  buildClaudeMdBlock,
  getDetailDoc,
} from '../adopt-content.mjs';
import { buildServerInstructions } from '../search-scoring.mjs';
import { buildSessionContextLines } from '../hook-context.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

function setupSandbox() {
  const tmpHome = mkdtempSync(join(tmpdir(), 'adopt-detect-'));
  const fakeCwd = join(tmpHome, 'myproj');
  mkdirSync(fakeCwd, { recursive: true });
  return { tmpHome, fakeCwd };
}

describe('isAdoptedHere / effectiveQuiet', () => {
  let tmpHome, fakeCwd, origHome, origCwd, origQuiet;

  beforeEach(() => {
    ({ tmpHome, fakeCwd } = setupSandbox());
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    origQuiet = process.env.MEM_QUIET_HOOKS;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
    delete process.env.MEM_QUIET_HOOKS;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origCwd;
    if (origQuiet === undefined) delete process.env.MEM_QUIET_HOOKS;
    else process.env.MEM_QUIET_HOOKS = origQuiet;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('isAdoptedHere reflects the new CLAUDE.md managed block', () => {
    expect(isAdoptedHere()).toBe(false);
    writeManaged(fakeCwd, {
      slug: PLUGIN_SLUG,
      version: CURRENT_SENTINEL_VERSION,
      block: buildClaudeMdBlock(),
      doc: getDetailDoc(),
    });
    expect(isAdoptedHere()).toBe(true);
    removeManaged(fakeCwd, PLUGIN_SLUG);
    expect(isAdoptedHere()).toBe(false);
  });

  it('isAdoptedHere still recognises a legacy memory-dir sentinel (transition fallback)', () => {
    expect(isAdoptedHere()).toBe(false);
    const memdir = memdirPath(fakeCwd);
    writePluginSection(memdir, {
      slug: PLUGIN_SLUG,
      version: CURRENT_SENTINEL_VERSION,
      contentLine: 'x',
    });
    expect(isAdoptedHere()).toBe(true);
    removePluginSection(memdir, PLUGIN_SLUG);
    expect(isAdoptedHere()).toBe(false);
  });

  it('effectiveQuiet = false when neither env nor adoption', () => {
    expect(isQuietHooks()).toBe(false);
    expect(isAdoptedHere()).toBe(false);
    expect(effectiveQuiet()).toBe(false);
  });

  it('effectiveQuiet = true when adopted (no env)', () => {
    writePluginSection(memdirPath(fakeCwd), {
      slug: PLUGIN_SLUG,
      version: CURRENT_SENTINEL_VERSION,
      contentLine: 'x',
    });
    expect(effectiveQuiet()).toBe(true);
  });

  it('effectiveQuiet = true when env set (no adoption)', () => {
    process.env.MEM_QUIET_HOOKS = '1';
    expect(effectiveQuiet()).toBe(true);
  });

  it('env and adoption combine OR — either path works independently', () => {
    process.env.MEM_QUIET_HOOKS = '1';
    writePluginSection(memdirPath(fakeCwd), {
      slug: PLUGIN_SLUG,
      version: CURRENT_SENTINEL_VERSION,
      contentLine: 'x',
    });
    expect(effectiveQuiet()).toBe(true);
  });
});

describe('Phase D conditional trim — buildServerInstructions via effectiveQuiet', () => {
  let tmpHome, fakeCwd, origHome, origCwd, origQuiet;

  beforeEach(() => {
    ({ tmpHome, fakeCwd } = setupSandbox());
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    origQuiet = process.env.MEM_QUIET_HOOKS;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
    delete process.env.MEM_QUIET_HOOKS;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origCwd;
    if (origQuiet === undefined) delete process.env.MEM_QUIET_HOOKS;
    else process.env.MEM_QUIET_HOOKS = origQuiet;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('produces verbose instructions when NOT adopted and env unset', () => {
    const instr = buildServerInstructions(effectiveQuiet());
    expect(instr).toContain('WHEN TO USE');
  });

  it('produces slim instructions when adopted (no env)', () => {
    writePluginSection(memdirPath(fakeCwd), {
      slug: PLUGIN_SLUG,
      version: CURRENT_SENTINEL_VERSION,
      contentLine: 'x',
    });
    const instr = buildServerInstructions(effectiveQuiet());
    expect(instr).not.toContain('WHEN TO USE');
    expect(instr).toContain('cli.mjs search'); // base CLI help still present (resolvable path form)
  });
});

describe('Phase D conditional trim — buildSessionContextLines via effectiveQuiet', () => {
  let tmpHome, fakeCwd, origHome, origCwd, origQuiet, db;

  beforeEach(() => {
    ({ tmpHome, fakeCwd } = setupSandbox());
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    origQuiet = process.env.MEM_QUIET_HOOKS;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
    delete process.env.MEM_QUIET_HOOKS;

    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'bugfix',
      title: 'Fix pagination boundary',
      importance: 3,
      lessonLearned: 'always pin cursor',
      filesModified: JSON.stringify(['pagination.mjs']),
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'decision',
      title: 'Adopt pattern',
      importance: 3,
      lessonLearned: 'sentinel + hash',
      filesModified: '[]',
    });
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

  it('emits verbose (File Lessons + Key Context) when NOT adopted', () => {
    const out = buildSessionContextLines(db, 'test', new Date());
    expect(out).toContain('### File Lessons');
    expect(out).toContain('### Key Context');
  });

  it('drops File Lessons + Key Context once adopted (sentinel present)', () => {
    writePluginSection(memdirPath(fakeCwd), {
      slug: PLUGIN_SLUG,
      version: CURRENT_SENTINEL_VERSION,
      contentLine: 'x',
    });
    const out = buildSessionContextLines(db, 'test', new Date());
    expect(out).not.toContain('### File Lessons');
    expect(out).not.toContain('### Key Context');
    expect(out).toContain('### Recent'); // #IDs still reachable
  });

  it('unadopt restores verbose output', () => {
    const memdir = memdirPath(fakeCwd);
    writePluginSection(memdir, { slug: PLUGIN_SLUG, version: 'v1', contentLine: 'x' });
    const quietOut = buildSessionContextLines(db, 'test', new Date());
    expect(quietOut).not.toContain('### File Lessons');

    removePluginSection(memdir, PLUGIN_SLUG);
    const verboseOut = buildSessionContextLines(db, 'test', new Date());
    expect(verboseOut).toContain('### File Lessons');
  });
});

// P1-2 left `hook-shared.mjs` re-exporting nine symbols that now live under `lib/`, so that
// server.mjs, hook-context.mjs and the rest of its callers did not have to change. A
// re-export is only free while it stays a re-export: the failure this guards is someone
// "fixing" an import by pasting a second copy of the constant or the function back into
// hook-shared, which is the twin-drift class this repo keeps paying for and which no
// behavioural test would notice — both copies would work, and then one would be edited.
// `toBe` splits into two different checks here, and the difference is the whole point.
// For the functions and the regex it is real object identity, so a pasted duplicate fails.
// For the four handoff NUMBERS it is value equality — the first cut of this guard claimed
// identity for those too, and a mutation that replaced the re-export with
// `export const HANDOFF_EXPIRY_EXIT = 7 * 24 * 60 * 60 * 1000;` passed it, because the two
// copies agree on the day they are written. That is the state a drift guard must reject,
// so the numbers are pinned at the SOURCE level instead: hook-shared must not declare them.
describe('hook-shared re-exports the lib originals, not copies of them', () => {
  it('exposes the same function objects as lib/quiet-scope.mjs and lib/llm-call.mjs', () => {
    expect(hookShared.isQuietHooks).toBe(isQuietHooks);
    expect(hookShared.isAdoptedHere).toBe(isAdoptedHere);
    expect(hookShared.effectiveQuiet).toBe(effectiveQuiet);
    expect(hookShared.callLLM).toBe(callLLM);
  });

  it('exposes the same regex object as lib/handoff-constants.mjs', () => {
    expect(hookShared.CONTINUE_KEYWORDS).toBe(CONTINUE_KEYWORDS);
  });

  it('agrees with lib/handoff-constants.mjs on every value it forwards', () => {
    expect(hookShared.HANDOFF_EXPIRY_CLEAR).toBe(HANDOFF_EXPIRY_CLEAR);
    expect(hookShared.HANDOFF_EXPIRY_EXIT).toBe(HANDOFF_EXPIRY_EXIT);
    expect(hookShared.HANDOFF_ANCHOR_MAX_AGE).toBe(HANDOFF_ANCHOR_MAX_AGE);
    expect(hookShared.HANDOFF_MATCH_THRESHOLD).toBe(HANDOFF_MATCH_THRESHOLD);
  });

  it('declares none of the relocated names itself — it may only re-export them', () => {
    // D#207: join(), not new URL('../x.mjs', …) — that form blinds knip to the module.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'hook-shared.mjs'), 'utf8');
    const RELOCATED = [
      'HANDOFF_EXPIRY_CLEAR',
      'HANDOFF_EXPIRY_EXIT',
      'HANDOFF_ANCHOR_MAX_AGE',
      'HANDOFF_MATCH_THRESHOLD',
      'CONTINUE_KEYWORDS',
      'isQuietHooks',
      'isAdoptedHere',
      'effectiveQuiet',
      'callLLM',
    ];
    const declared = RELOCATED.filter((n) =>
      new RegExp(`^\\s*(?:export\\s+)?(?:const|let|function|async function)\\s+${n}\\b`, 'm').test(src),
    );
    expect(declared, 'these are declared in hook-shared.mjs instead of re-exported from lib/').toEqual([]);
    // The sweep must be able to fire, or an empty result means nothing.
    expect(
      /^\s*(?:export\s+)?const\s+RUNTIME_DIR\b/m.test(src),
      'detector fires on a name hook-shared really does declare',
    ).toBe(true);
  });
});
