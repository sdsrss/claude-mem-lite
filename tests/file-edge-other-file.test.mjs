// R3 O1 (docs/audits/20261103-r3-optimization-plan.md): fileMatchClause's `%/<basename>` arm makes
// every same-named file a match, so editing src/snapshot/mod.rs pulled the lessons of
// src/mcp/server/mod.rs. On 194 transcripts (2026-10-06..11-03) 210 of 4,037 injected PreToolUse
// rows were such a different file of the same project (143 in one Rust repo). The decision is a pure
// function so the hook and a replay ruler can drive the same code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edgesNameOtherFile } from '../lib/file-edge-match.mjs';

// The cases below are about placing a path, so they hold the filesystem fixed: every path exists.
// What a missing file changes is its own describe at the end, on a real directory.
const ALL_EXIST = { exists: () => true };
const judge = (edges, target, root) => edgesNameOtherFile(edges, target, root, ALL_EXIST);

const ROOT = '/home/u/dev/app';
const T = `${ROOT}/src/snapshot/mod.rs`;

describe('edgesNameOtherFile', () => {
  it('a project path with another directory is another file (absolute and root-relative edges)', () => {
    expect(judge([`${ROOT}/src/mcp/server/mod.rs`], T, ROOT)).toBe(true);
    expect(judge(['src/mcp/server/mod.rs'], T, ROOT)).toBe(true);
    expect(judge([`${ROOT}/README.md`], `${ROOT}/tasks/d614/README.md`, ROOT)).toBe(true);
  });

  it('the same file is not another file: absolute, root-relative, case-folded', () => {
    expect(judge([T], T, ROOT)).toBe(false);
    expect(judge(['src/snapshot/mod.rs'], T, ROOT)).toBe(false);
    expect(judge([`${ROOT}/SRC/Snapshot/MOD.rs`], T, ROOT)).toBe(false);
  });

  it('a relative edge recorded from a subdirectory still names the file it ends', () => {
    expect(judge(['snapshot/mod.rs'], T, ROOT)).toBe(false);
  });

  it('a worktree copy of the same file is the same file, in either direction', () => {
    expect(judge([`${ROOT}/.claude/worktrees/agent-a1/src/snapshot/mod.rs`], T, ROOT)).toBe(false);
    expect(judge([T], `${ROOT}/.claude/worktrees/agent-a1/src/snapshot/mod.rs`, ROOT)).toBe(false);
    expect(judge([`${ROOT}/.claude/worktrees/agent-a1/src/x/mod.rs`], T, ROOT)).toBe(true);
  });

  it('what cannot be placed is kept: bare names, paths outside the project, no project root', () => {
    expect(judge(['mod.rs'], T, ROOT)).toBe(false);
    expect(judge(['/home/u/.cache/tmp/copy/src/snapshot/mod.rs'], T, ROOT)).toBe(false);
    expect(judge([`${ROOT}/src/x/mod.rs`], '/tmp/copy/src/snapshot/mod.rs', ROOT)).toBe(false);
    expect(judge([`${ROOT}/src/x/mod.rs`], T, null)).toBe(false);
  });

  it('every same-named edge must name another file; edges with other names do not count', () => {
    expect(judge([`${ROOT}/src/x/mod.rs`, 'src/snapshot/mod.rs'], T, ROOT)).toBe(false);
    expect(judge([`${ROOT}/src/x/mod.rs`, `${ROOT}/src/lib.rs`], T, ROOT)).toBe(true);
    expect(judge([`${ROOT}/src/lib.rs`], T, ROOT)).toBe(false); // matched on no name
    expect(judge([], T, ROOT)).toBe(false);
  });

  // Pre-ship review M1: an edge recorded relative to a directory ABOVE the session root (the
  // `cd packages/api && claude` monorepo shape; #1240 in the maintainer's store) names this file.
  it('a relative edge recorded from above the session root still names this file', () => {
    const sub = `${ROOT}/backend`;
    expect(judge(['backend/app/judge.py'], `${sub}/app/judge.py`, sub)).toBe(false);
    expect(judge(['backend/app/other/judge.py'], `${sub}/app/judge.py`, sub)).toBe(true);
  });

  it('spellings that cannot be placed are kept: `..`, `~`, a drive letter, a URL', () => {
    for (const e of [
      '../a/mod.rs',
      '~/dev/app/src/a/mod.rs',
      'C:\\work\\app\\src\\a\\mod.rs',
      'file:///x/src/a/mod.rs',
    ])
      expect(judge([e], T, ROOT), e).toBe(false);
  });

  it('`.` segments and doubled separators are normalised on both sides', () => {
    expect(judge([`${ROOT}/src/./snapshot//mod.rs`], T, ROOT)).toBe(false);
    expect(judge(['./src/snapshot/mod.rs'], T, ROOT)).toBe(false);
    expect(judge([T], `${ROOT}/src/x/../snapshot/mod.rs`, ROOT)).toBe(false);
    expect(judge([`${ROOT}/src/./x//mod.rs`], T, ROOT)).toBe(true);
  });

  // Delta review F1: a RELATIVE edge spelled through the worktree directory is the same file too.
  it('a relative worktree edge names the same file, and the worktree file itself', () => {
    const wt = '.claude/worktrees/agent-a1/src/snapshot/mod.rs';
    expect(judge([wt], T, ROOT)).toBe(false);
    expect(judge([wt], `${ROOT}/${wt}`, ROOT)).toBe(false);
    expect(judge(['.claude/worktrees/agent-a1/src/x/mod.rs'], T, ROOT)).toBe(true);
  });

  // Delta review F3: the relative side of the normalisation was untested.
  it('a relative edge is cleaned of `//` and `./` before it is compared', () => {
    expect(judge(['src//snapshot/mod.rs'], T, ROOT)).toBe(false);
    expect(judge(['src/./snapshot/mod.rs'], T, ROOT)).toBe(false);
    expect(judge(['src//x/mod.rs'], T, ROOT)).toBe(true);
  });

  it('Windows separators in a stored edge are read as separators', () => {
    expect(judge(['src\\mcp\\server\\mod.rs'], T, ROOT)).toBe(true);
    expect(judge(['src\\snapshot\\mod.rs'], T, ROOT)).toBe(false);
  });
});

// v6.31.0 review r1: a file that moved inside the project left its lessons on the OLD path, and
// with no file there any more the rule read that path as another file and dropped them; v6.30.15
// injected them. A path that names no file now cannot be called another file.
describe('edgesNameOtherFile — a path that names no file now', () => {
  let root;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mem-edge-moved-'));
    for (const d of ['src/new', 'src/other']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'src/new/mod.rs'), '');
    writeFileSync(join(root, 'src/other/mod.rs'), '');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('keeps the lessons of a moved file, absolute and root-relative', () => {
    const target = join(root, 'src/new/mod.rs');
    expect(edgesNameOtherFile([join(root, 'src/old/mod.rs')], target, root)).toBe(false);
    expect(edgesNameOtherFile(['src/old/mod.rs'], target, root)).toBe(false);
  });

  it('CONTROL: a same-named file that exists elsewhere is still another file', () => {
    const target = join(root, 'src/new/mod.rs');
    expect(edgesNameOtherFile([join(root, 'src/other/mod.rs')], target, root)).toBe(true);
    expect(edgesNameOtherFile(['src/other/mod.rs'], target, root)).toBe(true);
  });

  it('a removed worktree is read on the main tree: its copy of an existing file is still another file', () => {
    const target = join(root, 'src/new/mod.rs');
    const wt = join(root, '.claude/worktrees/agent-a1/src/other/mod.rs');
    expect(edgesNameOtherFile([wt], target, root)).toBe(true);
    expect(edgesNameOtherFile(['.claude/worktrees/agent-a1/src/other/mod.rs'], target, root)).toBe(true);
  });
});
