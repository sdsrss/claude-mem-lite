// Report §9-C (docs/audits/20260929-sandbox-usage-eval.md).
//
// In the sandbox evaluation 4 of 32 plugin sessions (8 of 32 in the re-run) ended with the
// agent talking to the USER about the memory store: "和记忆库里 #1 的记录一致", "已记进项目
// 记忆，编号 #1", "第 2、3 步已经记成下次会话的待办（D#1）". Citation decay and the cite-recall
// faces read `#NN` in assistant TEXT (lib/citation-tracker.mjs), so the citation itself has to
// stay in the reply; what goes is everything else. The steering texts now ask for a bare
// `(#NN)` tag and forbid the rest.
//
// The second half: the episode summarizer's `bugfix` definition ("prior-failing path fixed")
// took a TDD red → green for a fixed bug — 17 of 43 events were typed bugfix in a scenario
// with one bugfix session.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildClaudeMdBlock, getDetailDoc } from '../adopt-content.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(join(REPO, rel), 'utf8');

describe('steering asks for a bare (#NN) tag and nothing else about memory', () => {
  it('the managed block', () => {
    const block = buildClaudeMdBlock();
    expect(block).toMatch(/bare tag `\(#NN\)`/);
    expect(block).toMatch(/no other mention of memory ids, saves or the memory store/i);
    expect(block).not.toMatch(/name `#NN` once where you say so/);
  });

  it('the detail doc', () => {
    const doc = getDetailDoc();
    expect(doc).toContain('`(#NN)`');
    expect(doc).toMatch(/不要.*报告.*保存/);
  });

  it('the default PreToolUse ack directive', () => {
    const m = /const ACK_DIRECTIVE =\s*\n?\s*'([^']+)'/.exec(src('scripts/pre-tool-recall.js'));
    expect(m, 'premise: ACK_DIRECTIVE is a single-quoted literal').not.toBeNull();
    expect(m[1]).toMatch(/bare tag \(#NN\)/);
    expect(m[1]).not.toMatch(/name its #NN once/);
  });
});

describe('the episode summarizer does not call a TDD red a bugfix', () => {
  it('the shared schema tail carries the TDD rule next to the bugfix definition', () => {
    const text = src('hook-llm.mjs');
    expect(text).toMatch(/bugfix = prior-failing path fixed with a named root cause/);
    expect(text).toMatch(/failed only until this episode's implementation[^\n]*is TDD, not a bugfix/);
  });
});
