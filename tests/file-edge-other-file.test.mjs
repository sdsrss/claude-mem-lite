// R3 O1 (docs/audits/20261103-r3-optimization-plan.md): fileMatchClause's `%/<basename>` arm makes
// every same-named file a match, so editing src/snapshot/mod.rs pulled the lessons of
// src/mcp/server/mod.rs. On 194 transcripts (2026-10-06..11-03) 210 of 4,037 injected PreToolUse
// rows were such a different file of the same project (143 in one Rust repo). The decision is a pure
// function so the hook and a replay ruler can drive the same code.
import { describe, it, expect } from 'vitest';
import { edgesNameOtherFile } from '../lib/file-edge-match.mjs';

const ROOT = '/home/u/dev/app';
const T = `${ROOT}/src/snapshot/mod.rs`;

describe('edgesNameOtherFile', () => {
  it('a project path with another directory is another file (absolute and root-relative edges)', () => {
    expect(edgesNameOtherFile([`${ROOT}/src/mcp/server/mod.rs`], T, ROOT)).toBe(true);
    expect(edgesNameOtherFile(['src/mcp/server/mod.rs'], T, ROOT)).toBe(true);
    expect(edgesNameOtherFile([`${ROOT}/README.md`], `${ROOT}/tasks/d614/README.md`, ROOT)).toBe(true);
  });

  it('the same file is not another file: absolute, root-relative, case-folded', () => {
    expect(edgesNameOtherFile([T], T, ROOT)).toBe(false);
    expect(edgesNameOtherFile(['src/snapshot/mod.rs'], T, ROOT)).toBe(false);
    expect(edgesNameOtherFile([`${ROOT}/SRC/Snapshot/MOD.rs`], T, ROOT)).toBe(false);
  });

  it('a relative edge recorded from a subdirectory still names the file it ends', () => {
    expect(edgesNameOtherFile(['snapshot/mod.rs'], T, ROOT)).toBe(false);
  });

  it('a worktree copy of the same file is the same file, in either direction', () => {
    expect(edgesNameOtherFile([`${ROOT}/.claude/worktrees/agent-a1/src/snapshot/mod.rs`], T, ROOT)).toBe(
      false,
    );
    expect(edgesNameOtherFile([T], `${ROOT}/.claude/worktrees/agent-a1/src/snapshot/mod.rs`, ROOT)).toBe(
      false,
    );
    expect(edgesNameOtherFile([`${ROOT}/.claude/worktrees/agent-a1/src/x/mod.rs`], T, ROOT)).toBe(true);
  });

  it('what cannot be placed is kept: bare names, paths outside the project, no project root', () => {
    expect(edgesNameOtherFile(['mod.rs'], T, ROOT)).toBe(false);
    expect(edgesNameOtherFile(['/home/u/.cache/tmp/copy/src/snapshot/mod.rs'], T, ROOT)).toBe(false);
    expect(edgesNameOtherFile([`${ROOT}/src/x/mod.rs`], '/tmp/copy/src/snapshot/mod.rs', ROOT)).toBe(false);
    expect(edgesNameOtherFile([`${ROOT}/src/x/mod.rs`], T, null)).toBe(false);
  });

  it('every same-named edge must name another file; edges with other names do not count', () => {
    expect(edgesNameOtherFile([`${ROOT}/src/x/mod.rs`, 'src/snapshot/mod.rs'], T, ROOT)).toBe(false);
    expect(edgesNameOtherFile([`${ROOT}/src/x/mod.rs`, `${ROOT}/src/lib.rs`], T, ROOT)).toBe(true);
    expect(edgesNameOtherFile([`${ROOT}/src/lib.rs`], T, ROOT)).toBe(false); // matched on no name
    expect(edgesNameOtherFile([], T, ROOT)).toBe(false);
  });

  // Pre-ship review M1: an edge recorded relative to a directory ABOVE the session root (the
  // `cd packages/api && claude` monorepo shape; #1240 in the maintainer's store) names this file.
  it('a relative edge recorded from above the session root still names this file', () => {
    const sub = `${ROOT}/backend`;
    expect(edgesNameOtherFile(['backend/app/judge.py'], `${sub}/app/judge.py`, sub)).toBe(false);
    expect(edgesNameOtherFile(['backend/app/other/judge.py'], `${sub}/app/judge.py`, sub)).toBe(true);
  });

  it('spellings that cannot be placed are kept: `..`, `~`, a drive letter, a URL', () => {
    for (const e of [
      '../a/mod.rs',
      '~/dev/app/src/a/mod.rs',
      'C:\\work\\app\\src\\a\\mod.rs',
      'file:///x/src/a/mod.rs',
    ])
      expect(edgesNameOtherFile([e], T, ROOT), e).toBe(false);
  });

  it('`.` segments and doubled separators are normalised on both sides', () => {
    expect(edgesNameOtherFile([`${ROOT}/src/./snapshot//mod.rs`], T, ROOT)).toBe(false);
    expect(edgesNameOtherFile(['./src/snapshot/mod.rs'], T, ROOT)).toBe(false);
    expect(edgesNameOtherFile([T], `${ROOT}/src/x/../snapshot/mod.rs`, ROOT)).toBe(false);
    expect(edgesNameOtherFile([`${ROOT}/src/./x//mod.rs`], T, ROOT)).toBe(true);
  });

  it('Windows separators in a stored edge are read as separators', () => {
    expect(edgesNameOtherFile(['src\\mcp\\server\\mod.rs'], T, ROOT)).toBe(true);
    expect(edgesNameOtherFile(['src\\snapshot\\mod.rs'], T, ROOT)).toBe(false);
  });
});
