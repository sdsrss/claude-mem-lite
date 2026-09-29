// Recalled memories are notes about the code AS IT WAS, and some are wrong: in the 2026-09-29
// sandbox evaluation 6 of 43 automatic events stated something false and 13 more were partly
// wrong, and an agent-saved lesson claimed a behaviour its own diff did not contain
// (docs/audits/20260929-sandbox-usage-eval.md §4 A-7, §8.4). The model caught such errors
// only when a question forced it to read the code, and even then left the wrong note in
// place to be recalled again. Nothing told it that `E#NN` rows are automatic summaries, that
// a memory should be checked before it drives an answer, or that mem_save's `supersedes`
// retires a note the code contradicts (D#205 made that work for events too).
//
// The steering now says all three, plus the write-side half: a saved lesson states only what
// the change's diff shows.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { buildClaudeMdBlock, getDetailDoc } from '../adopt-content.mjs';
import { memSaveSchema } from '../tool-schemas.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the steering tells the agent to check a recalled memory and correct it', () => {
  const block = buildClaudeMdBlock();

  // Pre-tag claims review P2-4: `#NN` is not only what an agent saved — background summaries of
  // type `change` and the rule-based episode pre-save are observations too.
  it('the managed block says #NN and E#NN rows can be automatic and wrong', () => {
    expect(block).toMatch(
      /`#NN` and `E#NN` rows are notes from past sessions, many written automatically[^|]*can be wrong/,
    );
    expect(block).not.toMatch(/`#NN` rows are saved notes/);
  });

  it('the managed block asks for a check against the code before a memory drives an answer', () => {
    expect(block).toMatch(
      /A recalled memory drives an answer or a design choice \| check its claim in the code/,
    );
  });

  it('the managed block says to trust the code and replace the note with supersedes', () => {
    expect(block).toMatch(/trust the code and replace the note/);
    expect(block).toContain('supersedes=[NN]');
    expect(block).toContain('supersedes=["E#NN"]');
  });

  it('the bugfix row limits a saved lesson to what the diff shows', () => {
    expect(block).toMatch(/lesson_learned="<root cause \+ fix, only what this change's diff shows>"/);
  });

  it('the detail doc carries the same rules in full', () => {
    const doc = getDetailDoc();
    expect(doc).toMatch(/## 记忆是旧笔记，不是现在的代码/);
    expect(doc).toMatch(/`#NN` 也可能是后台自动整理的/);
    expect(doc).not.toMatch(/`#NN` 是 agent 主动保存的笔记/);
    expect(doc).toContain('supersedes=["E#NN"]');
    expect(doc).toMatch(/只写这次 diff 能证明的内容/);
  });
});

describe('an agent on the CLI path can find the correction flag', () => {
  // Most sandbox agents reached memory through the Bash CLI (the mem_* tools are deferred
  // behind ToolSearch), and `save --supersedes` worked but appeared in neither `help` nor
  // the detail doc's CLI table.
  it('`help` lists save --supersedes', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'cli.mjs'), 'help'], { encoding: 'utf8' });
    const saveSection = /\n {2}save "<text>"[\s\S]*?\n {2}\S/.exec(r.stdout)?.[0] ?? '';
    expect(saveSection).toMatch(/--supersedes 12,E#34/);
  });

  it('the detail doc CLI row for save carries --supersedes', () => {
    expect(getDetailDoc()).toMatch(/save "<text>"[^\n]*\[--supersedes 12,E#34\]/);
  });
});

describe('the supersedes shapes the steering advertises are the ones mem_save accepts', () => {
  const supersedes = z.object({ supersedes: memSaveSchema.supersedes });
  it('an observation id and an event id both parse', () => {
    expect(supersedes.parse({ supersedes: [12] }).supersedes).toEqual([12]);
    expect(supersedes.parse({ supersedes: ['E#12'] }).supersedes).toEqual(['E#12']);
  });
});
