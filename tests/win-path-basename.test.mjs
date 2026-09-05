// Cross-platform basename derivation (audit P2-3).
//
// Hook payloads originate on the CLIENT machine, so `tool_input.file_path` can
// carry a Windows path (`C:\proj\src\file.mjs`) while the code deriving its
// basename may run anywhere. POSIX `path.basename` does NOT treat '\' as a
// separator, so neither `split('/').pop()` nor plain `basename()` is enough for
// data that crosses OS boundaries — see lib/file-edge-match.mjs:10-21, which
// documents observation_files.filename as heterogeneous with EITHER separator.
//
// These tests assert separator-handling logic only; they never branch on
// process.platform, so they are meaningful on the Linux CI host.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { basename, win32, posix } from 'path';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestDb, insertSession, insertObs, fileEdgeMatchOnly } from './test-helpers.mjs';
import { fileMatchParams } from '../lib/file-edge-match.mjs';

// ─── Separator semantics, asserted on the SHIPPED derivation ────────────────
//
// These cases used to call `basenameAnySep` (utils.mjs). That export existed
// only for `recallForFile`, a twin with no production caller; both were deleted
// 2026-08-22 and the split now lives inside lib/file-edge-match.mjs. Rather
// than re-export a name nothing ships in order to keep a unit test alive, the
// cases read the basename straight out of `fileMatchParams` — bind value [1] IS
// the derived basename (arm 2 of the four-arm match), so this asserts the
// derivation the injection path actually uses.
const derivedBasename = (p) => fileMatchParams(p)[1];

describe('fileMatchParams derives basenames on either separator', () => {
  it('splits Windows backslash paths regardless of host OS', () => {
    expect(derivedBasename('C:\\proj\\src\\hook-memory.mjs')).toBe('hook-memory.mjs');
    expect(derivedBasename('\\\\server\\share\\utils.mjs')).toBe('utils.mjs');
  });

  it('splits POSIX forward-slash paths', () => {
    expect(derivedBasename('/mnt/Sda2/dev/claude-mem-lite/utils.mjs')).toBe('utils.mjs');
  });

  it('splits mixed-separator paths on the last separator of either kind', () => {
    expect(derivedBasename('C:/proj/src\\hook.mjs')).toBe('hook.mjs');
    expect(derivedBasename('C:\\proj\\src/hook.mjs')).toBe('hook.mjs');
  });

  it('returns a bare filename unchanged', () => {
    expect(derivedBasename('hook.mjs')).toBe('hook.mjs');
  });

  it('ignores trailing separators, matching path.basename', () => {
    expect(derivedBasename('/a/b/')).toBe('b');
    expect(derivedBasename('C:\\a\\b\\')).toBe('b');
  });

  it('returns empty string for empty / nullish input', () => {
    expect(derivedBasename('')).toBe('');
    expect(derivedBasename(undefined)).toBe('');
    expect(derivedBasename(null)).toBe('');
  });

  it('escapes LIKE wildcards in the derived basename, not the raw path', () => {
    // Arm 2 is an '=' comparison so it keeps the literal name; arms 3/4 are
    // LIKE patterns and must carry the escaped form.
    const [full, base, slashPat, backslashPat] = fileMatchParams('C:\\proj\\test_100%.mjs');
    expect(full).toBe('C:\\proj\\test_100%.mjs');
    expect(base).toBe('test_100%.mjs');
    expect(slashPat).toBe('%/test\\_100\\%.mjs');
    expect(backslashPat).toBe('%\\\\test\\_100\\%.mjs');
  });
});

// ─── The SHIPPED trigger-edge predicate (lib/file-edge-match.mjs) ────────────
//
// These cases used to run against `recallForFile` (hook-memory.mjs), an
// in-process twin with no production caller — it was deleted in this round.
// The code that actually decides whether an edited file recalls a lesson is
// `fileMatchClause` + `fileMatchParams`, shared byte-identically by
// scripts/pre-tool-recall.js (injection) and lib/edge-attribution.mjs
// (Stop-side attribution). Pointing the suite at the dead twin is why the
// backslash gap below survived: the twin used `basenameAnySep`, the shipped
// pair used node:path `basename`, and only the twin was ever asserted.
//
// FAILS IF: fileMatchParams reverts to a separator-specific basename. On a
// POSIX host `basename('C:\\proj\\src\\x.mjs')` returns the WHOLE string, so
// arms 2-4 degrade to garbage and a Windows-shaped payload recalls nothing.

describe('the shipped file-match predicate handles Windows-style paths', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => {
    db?.close();
  });

  // Shared helper -> the shipped predicate (lib/file-edge-match.mjs), the same
  // one scripts/pre-tool-recall.js injects on.
  const match = (filePath) => fileEdgeMatchOnly(db, filePath, 'test');

  it('matches history stored under a bare basename when given a backslash path', () => {
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix null deref in hook-memory.mjs',
      text: 'hook-memory.mjs null deref fix',
      importance: 2,
      filesModified: '["hook-memory.mjs"]',
      epochOffset: -3 * 86400000,
    });
    const results = match('C:\\proj\\src\\hook-memory.mjs');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toMatch(/hook-memory\.mjs/);
  });

  it('matches history stored under a different Windows path with the same basename', () => {
    // observation_files.filename is heterogeneous: an earlier session may have
    // recorded the file under another absolute Windows path.
    insertObs(db, {
      type: 'decision',
      title: 'Chose FTS5 over LIKE in parser.mjs',
      text: 'parser.mjs FTS5 decision',
      importance: 3,
      filesModified: '["C:\\\\old\\\\checkout\\\\parser.mjs"]',
      epochOffset: -2 * 86400000,
    });
    const results = match('C:\\proj\\src\\parser.mjs');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toMatch(/parser\.mjs/);
  });

  it('still escapes LIKE wildcards when the path is backslash-separated', () => {
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix in test_100%.mjs',
      text: 'test_100%.mjs fix',
      importance: 2,
      filesModified: '["test_100%.mjs"]',
      epochOffset: -2 * 86400000,
    });
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix in testX100Y.mjs',
      text: 'testX100Y.mjs fix',
      importance: 2,
      filesModified: '["testX100Y.mjs"]',
      epochOffset: -2 * 86400000,
    });
    const results = match('C:\\proj\\test_100%.mjs');
    expect(results.length).toBe(1);
    expect(results[0].title).toContain('test_100%.mjs');
  });

  it('does not over-match: a backslash path with no history returns empty', () => {
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix in hook-memory.mjs',
      text: 'hook-memory.mjs fix',
      importance: 2,
      filesModified: '["hook-memory.mjs"]',
      epochOffset: -2 * 86400000,
    });
    expect(match('C:\\proj\\src\\brand-new.mjs')).toEqual([]);
  });

  it('does not collide across the path boundary (bash-utils.mjs vs utils.mjs)', () => {
    // Arm 3/4 exist to block this suffix collision; a backslash payload must
    // not weaken it back into a bare '%<basename>' LIKE.
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix in bash-utils.mjs',
      text: 'bash-utils.mjs fix',
      importance: 2,
      filesModified: '["C:\\\\proj\\\\src\\\\bash-utils.mjs"]',
      epochOffset: -2 * 86400000,
    });
    expect(match('C:\\proj\\src\\utils.mjs')).toEqual([]);
  });

  it('keeps working for POSIX absolute paths (regression)', () => {
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix race in hook.mjs',
      text: 'hook.mjs race fix',
      importance: 2,
      filesModified: '["hook.mjs"]',
      epochOffset: -2 * 86400000,
    });
    expect(match('/mnt/data/projects/mem/hook.mjs').length).toBeGreaterThanOrEqual(1);
  });
});

// ─── install.mjs prune log line ─────────────────────────────────────────────

describe('install prune log derives basenames with node:path', () => {
  // pruneStaleInstallFiles returns host-`join`ed absolute paths, so the display
  // mapping at install.mjs:436 only needs the host-native separator — but it
  // must be `basename`, whose Windows implementation accepts BOTH separators,
  // not a hardcoded '/' split. On a POSIX host these two agree, so this suite
  // locks the invariant rather than reproducing a Linux-visible failure.
  it('basename resolves both separator styles per host implementation', () => {
    expect(win32.basename('C:\\Users\\me\\.claude-mem-lite\\dispatch.mjs')).toBe('dispatch.mjs');
    expect(win32.basename('C:/Users/me/.claude-mem-lite/dispatch.mjs')).toBe('dispatch.mjs');
    expect(posix.basename('/home/me/.claude-mem-lite/dispatch.mjs')).toBe('dispatch.mjs');
  });

  it('maps real pruneStaleInstallFiles output to bare filenames', async () => {
    const { pruneStaleInstallFiles } = await import('../install.mjs');
    const { SOURCE_FILES } = await import('../source-files.mjs');
    const tmpDir = mkdtempSync(join(tmpdir(), 'cml-prune-basename-'));
    try {
      writeFileSync(join(tmpDir, 'server.mjs'), 'real');
      writeFileSync(join(tmpDir, 'dispatch.mjs'), 'stale');
      const removed = pruneStaleInstallFiles(tmpDir, SOURCE_FILES);
      expect(removed.map((p) => basename(p))).toEqual(['dispatch.mjs']);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── Sweep guard: no shipped file may hand-roll the file-recall key ─────────
//
// v3.76.2 fixed lib/file-edge-match.mjs, and a pre-tag review found the SAME two
// defects still live on three other shipped faces (SF-1): the events leg of
// scripts/pre-tool-recall.js (120 lines below the fix, same file), the
// UserPromptSubmit file-reference leg in scripts/user-prompt-search.js, and
// lib/recall-core.mjs — which is BOTH mem_recall (MCP) and the CLI `recall`.
// All four are fixed now. This suite exists so the fifth one cannot be added
// silently: "fix applied to N-1 of N faces" is the defect class this repo has
// paid for repeatedly, and the per-face tests never catch it because each face
// only tests itself.
//
// FAILS IF: a file joins observation_files with a hand-written match instead of
// fileMatchClause, or derives a lookup key with host-native basename / split('/').

describe('every shipped observation_files consumer uses the shared predicate', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

  // Files that JOIN observation_files to answer "what do we know about this file?".
  // Write paths (save-observation, observation-write) insert rows and are not
  // lookups, so they are out of scope.
  const READ_FACES = [
    'lib/recall-core.mjs',
    'lib/edge-attribution.mjs',
    'scripts/pre-tool-recall.js',
    'scripts/user-prompt-search.js',
  ];

  // Comments must not count. The first cut of this suite went red on its own
  // explanatory comment quoting the banned `split('/').pop()` shape — the same
  // "a comment matched the substring scan" trap v3.76.1 recorded. Strip block
  // comments and whole-line `//` comments; a trailing comment carrying the shape
  // is rare enough that a false positive there is the safe direction.
  const code = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');

  for (const rel of READ_FACES) {
    const src = code(readFileSync(join(ROOT, rel), 'utf8'));

    it(`${rel} matches through fileMatchClause, not a hand-written arm`, () => {
      expect(src, 'must import the shared predicate').toMatch(/fileMatchClause/);
      // The two-arm shape every one of these faces used to carry. It matches on a
      // bare '%<basename>' suffix, which cannot tell utils.mjs from bash-utils.mjs.
      expect(src, 'hand-rolled two-arm match found').not.toMatch(
        /filename\s*=\s*\?\s*OR\s*of2?\.?filename\s+LIKE/i,
      );
    });

    it(`${rel} derives its lookup key with basenameAnySep, not a host-native split`, () => {
      // Display text may still use node:path basename; a LOOKUP KEY may not.
      // Narrow the search to assignment sites so a `basename(filePath)` inside an
      // injected message string does not trip this.
      const hostNative = [...src.matchAll(/const\s+(\w*[Nn]ame\w*)\s*=\s*basename\(/g)].map((m) => m[0]);
      const naiveSplit = [...src.matchAll(/\.split\(['"]\/['"]\)\s*\.pop\(\)/g)].map((m) => m[0]);
      expect(hostNative, `host-native basename assigned to a key: ${hostNative.join(', ')}`).toEqual([]);
      expect(naiveSplit, `split('/').pop() used as a key: ${naiveSplit.join(', ')}`).toEqual([]);
    });
  }
});
