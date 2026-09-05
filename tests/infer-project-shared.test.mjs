// scripts/pre-tool-recall.js must derive the SAME project string as the save path.
//
// Recall queries the project that observations were SAVED under, so the two derivations
// have to agree byte-for-byte. pre-tool-recall.js used to carry a hand-kept copy of the
// six lines, and that copy had already drifted once — it omitted the process.env.PWD
// fallback, so under a symlinked project dir (PWD = logical path, cwd = resolved) with
// CLAUDE_PROJECT_DIR unset it computed a DIFFERENT project than the save path and
// silently recalled nothing. It now imports the shared implementation; this pins that
// the two stay one implementation rather than two that happen to match today.
//
// Context: a git-work-tree anchoring change was written and REVERTED before shipping (it
// split the namespace for sessions rooted below the repo root — see the inferProject
// doc comment). The revert is why this file tests the invariant rather than the walk.

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { inferProject } from '../project-utils.mjs';

const RECALL_SRC = resolve(import.meta.dirname, '../scripts/pre-tool-recall.js');

describe('pre-tool-recall project derivation', () => {
  it('imports the shared inferProject instead of redefining it', () => {
    const src = readFileSync(RECALL_SRC, 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*\binferProject\b[^}]*\}\s*from\s*'\.\.\/project-utils\.mjs'/);
    // A local redefinition is what drifted before; reject its reappearance.
    expect(src).not.toMatch(/function\s+inferProject\s*\(/);
  });

  it('resolves CLAUDE_PROJECT_DIR ahead of PWD, and PWD ahead of cwd', () => {
    const saved = { p: process.env.CLAUDE_PROJECT_DIR, w: process.env.PWD };
    try {
      process.env.CLAUDE_PROJECT_DIR = '/srv/acme/web';
      process.env.PWD = '/somewhere/else';
      expect(inferProject()).toBe('acme--web');
      delete process.env.CLAUDE_PROJECT_DIR;
      expect(inferProject()).toBe('somewhere--else');
    } finally {
      if (saved.p === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved.p;
      if (saved.w === undefined) delete process.env.PWD;
      else process.env.PWD = saved.w;
    }
  });

  it('does not walk up to a git work-tree root (reverted pre-tag — see the doc comment)', () => {
    // Guards the revert: re-introducing the walk would make a session rooted below the
    // repo root read a different project than its own hooks write.
    //
    // Uses a purpose-built repo under tmp rather than this checkout. An earlier version
    // asserted 'mem--lib' against ../lib and went red on CI, where the checkout is named
    // claude-mem-lite — the expectation was a property of the directory name, not of the
    // behaviour. Here both the repo name and the subdirectory are fixed by the fixture.
    const saved = { p: process.env.CLAUDE_PROJECT_DIR, w: process.env.PWD };
    const root = mkdtempSync(join(tmpdir(), 'infer-shared-'));
    try {
      mkdirSync(join(root, 'myrepo', 'sub'), { recursive: true });
      mkdirSync(join(root, 'myrepo', '.git'), { recursive: true });
      writeFileSync(join(root, 'myrepo', '.git', 'HEAD'), 'ref: refs/heads/main\n');
      delete process.env.CLAUDE_PROJECT_DIR;
      process.env.PWD = join(root, 'myrepo', 'sub');
      // A walk would resolve to the work-tree root and yield '<tmpname>--myrepo'.
      expect(inferProject()).toBe('myrepo--sub');
    } finally {
      if (saved.p === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved.p;
      if (saved.w === undefined) delete process.env.PWD;
      else process.env.PWD = saved.w;
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* gone */
      }
    }
  });
});
