// tasks/<slug>-paused.md is the one place a session writes down, by hand, what is left and
// how to verify it — the spec that governs this repo makes writing one mandatory on a
// mid-task exit. Nothing read it. Measured 2026-09-21: 27 such files across 7 projects on
// this machine, zero readers.
//
// This is also the answer to "the next step must be written down, not inferred":
// session_summaries.next_steps is unreliable rather than dead, and both numbers belong here
// because the lifetime average hides a trend: 15 of 318 rows non-empty (4.7%) over the
// corpus lifetime, 4 of the newest 20 (20%). The reason to read a FILE is that a paused note
// is written by a human on purpose and names its own verify command.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readPausedNote } from '../lib/paused-reader.mjs';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'paused-reader-'));
  mkdirSync(join(root, 'tasks'), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function writePaused(name, body, mtimeSec = null) {
  const p = join(root, 'tasks', name);
  writeFileSync(p, body);
  if (mtimeSec !== null) utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

describe('readPausedNote', () => {
  it('returns null when the project has no tasks dir', () => {
    const bare = mkdtempSync(join(tmpdir(), 'paused-none-'));
    expect(readPausedNote({ projectPath: bare })).toBeNull();
    rmSync(bare, { recursive: true, force: true });
  });

  it('returns null when tasks/ holds no paused file', () => {
    writeFileSync(join(root, 'tasks', 'some-spec.md'), '# not a paused note');
    expect(readPausedNote({ projectPath: root })).toBeNull();
  });

  it('extracts the title and the remaining items from a hand-written note', () => {
    writePaused(
      'ship-0.15.0-paused.md',
      [
        '# 暂停 — v0.15.0 发版，卡在合并前的独立评审',
        '',
        '## 已完成且已验证',
        '',
        '- PR #28 已开',
        '',
        '## 未完成',
        '',
        '1. **两个独立评审的结论**（合并前的硬门）',
        '2. 合并：`gh pr merge 28 --rebase`',
        '3. 发版分支，只带 CHANGELOG',
        '',
      ].join('\n'),
    );

    const note = readPausedNote({ projectPath: root });

    expect(note.file).toBe('tasks/ship-0.15.0-paused.md');
    expect(note.title).toBe('v0.15.0 发版，卡在合并前的独立评审');
    expect(note.items).toHaveLength(3);
    expect(note.items[0]).toMatch(/两个独立评审的结论/);
    expect(note.items[1]).toMatch(/gh pr merge 28/);
    // Items come from "未完成" and NOT from the completed section above it.
    expect(note.items.join(' ')).not.toMatch(/PR #28 已开/);
  });

  it('reads the English heading spellings too', () => {
    writePaused(
      'refactor-paused.md',
      ['# Paused — the ranker refactor', '', '## Not done', '', '- rerun the A/B', '- close D#14', ''].join(
        '\n',
      ),
    );

    const note = readPausedNote({ projectPath: root });

    expect(note.title).toBe('the ranker refactor');
    expect(note.items).toEqual(['rerun the A/B', 'close D#14']);
  });

  it('falls back to a Resume section when there is no remaining-work heading', () => {
    // The shape claudemd's session-end-check.sh generates.
    writePaused(
      'session-end-abc123-paused.md',
      [
        '# Paused — mid-SPINE session exit detected',
        '',
        '## Last mutation tool call(s)',
        '',
        '- Edit: /home/ai/dev/x/a.mjs',
        '',
        '## Resume',
        '',
        // Hard-wrapped prose, exactly as the generator emits it. One sentence, four lines.
        "Run the project's verify command (e.g. `bash tests/run-all.sh`,",
        '`pytest`, `cargo test`, etc.), then either delete this file (verified',
        'green) or convert it to a real `tasks/<slug>-paused.md` with the',
        'specific verify command and remaining work.',
        '',
      ].join('\n'),
    );

    const note = readPausedNote({ projectPath: root });

    // ONE item, not four fragments each starting mid-clause.
    expect(note.items).toHaveLength(1);
    expect(note.items[0]).toMatch(/^Run the project's verify command/);
    // The mutation-call list is not remaining work and must not be mistaken for it.
    expect(note.items.join(' ')).not.toMatch(/Edit:/);
  });

  it('picks the NEWEST paused file when several exist', () => {
    // Both inside the staleness bound — mtimes now carry meaning beyond ordering, so epoch
    // 1000 vs 9000 (1970) would just be two stale notes.
    const nowSec = Math.floor(Date.now() / 1000);
    writePaused('old-paused.md', '# Paused — older\n\n## Not done\n\n- stale item\n', nowSec - 3 * 86400);
    writePaused('new-paused.md', '# Paused — newer\n\n## Not done\n\n- fresh item\n', nowSec - 60);

    const note = readPausedNote({ projectPath: root });

    expect(note.title).toBe('newer');
    expect(note.items).toEqual(['fresh item']);
  });

  it('marks a truncated item and never splits a surrogate pair', () => {
    // Found by reading a real rendered block: the generated notes' Resume paragraph came
    // out cut mid-word with nothing marking it, so it read as corrupt text rather than as
    // a summary. The raw slice also had the hazard format-utils' own truncate documents —
    // cutting between the halves of a surrogate pair emits a lone surrogate.
    writePaused(
      'long-paused.md',
      `# Paused — long\n\n## Not done\n\n- ${'x'.repeat(199)}😀 and more text after it\n`,
    );

    const note = readPausedNote({ projectPath: root });

    expect(note.items[0]).toMatch(/…$/); // visibly truncated
    expect(note.items[0].length).toBeLessThanOrEqual(200);
    // No unpaired surrogate anywhere in the result.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(note.items[0])).toBe(false);
  });

  it('caps the item count and the item length', () => {
    const many = Array.from({ length: 12 }, (_, i) => `- item ${i} ${'x'.repeat(400)}`).join('\n');
    writePaused('big-paused.md', `# Paused — big\n\n## Not done\n\n${many}\n`);

    const note = readPausedNote({ projectPath: root, maxItems: 5 });

    expect(note.items).toHaveLength(5);
    for (const item of note.items) expect(item.length).toBeLessThanOrEqual(200);
  });

  it('survives an unreadable or malformed file without throwing', () => {
    writePaused('weird-paused.md', '\u0000\u0000 not markdown at all');
    expect(() => readPausedNote({ projectPath: root })).not.toThrow();
  });

  it('neutralises its own DEFAULT under the test guard, but not an explicit path', () => {
    // Containment, on the same channel lib/resolve-data-dir.mjs uses. Without it every
    // suite that builds a handoff writes THIS repo's paused note into the row under test —
    // measured, not hypothetical: an unstubbed probe came back carrying
    // tasks/session-end-b3c0c20d-paused.md. Per-file vi.spyOn stubs fix the same leak but
    // nothing goes red when a new suite forgets one.
    writePaused('guarded-paused.md', '# Paused — guarded\n\n## Not done\n\n- an item\n');
    // The default is the project root (inferProjectDir), so point that at the fixture.
    const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = root;

    try {
      expect(process.env.CLAUDE_MEM_TEST_GUARD).toBe('1'); // premise: the guard is actually on

      expect(readPausedNote()).toBeNull(); // default path is neutralised
      expect(readPausedNote({ projectPath: root })?.items).toEqual(['an item']); // explicit is not

      // ...and the default reads normally once the guard is off, so this is containment and
      // not a reader that simply never returns anything.
      process.env.CLAUDE_MEM_TEST_GUARD = 'off';
      try {
        expect(readPausedNote()?.items).toEqual(['an item']);
      } finally {
        process.env.CLAUDE_MEM_TEST_GUARD = '1';
      }
    } finally {
      if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    }
  });

  it('returns null when the note has a title but nothing left to do', () => {
    writePaused('empty-paused.md', '# Paused — everything landed\n\n## Not done\n\n');
    expect(readPausedNote({ projectPath: root })).toBeNull();
  });
});
