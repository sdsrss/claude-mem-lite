// Tests for lib/summary-extractor.mjs — deterministic Done/Not done extractor.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, openSync, writeSync, closeSync, ftruncateSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractTailAssistantText, extractStructuredSummary } from '../lib/summary-extractor.mjs';
import { readTranscriptEntries, _resetTranscriptCache } from '../lib/transcript-scan.mjs';

describe('extractStructuredSummary — EN markers', () => {
  it('extracts single-line Done', () => {
    const r = extractStructuredSummary('Done: fixed typo in README.md:42.');
    expect(r.done).toBe('fixed typo in README.md:42.');
    expect(r.notDone).toBe('');
  });

  it('extracts four-section block', () => {
    const text = [
      'Done: added pagination cursor on GET /orders.',
      '',
      'Not done:',
      '- schema migration not applied yet',
      '- docs not updated',
      '',
      'Failed: none',
      '',
      'Uncertain: whether cursor encoding collides with legacy clients',
    ].join('\n');
    const r = extractStructuredSummary(text);
    expect(r.done).toContain('pagination cursor');
    expect(r.notDone).toContain('schema migration not applied');
    expect(r.notDone).toContain('docs not updated');
    expect(r.failed).toBe('none');
    expect(r.uncertain).toContain('cursor encoding');
  });

  it('ignores case and whitespace variations in headers', () => {
    const r = extractStructuredSummary('NOT DONE: thing A\nFailed:  thing B');
    expect(r.notDone).toBe('thing A');
    expect(r.failed).toBe('thing B');
  });

  it('handles bullet markers before headers', () => {
    const r = extractStructuredSummary('● Done: shipped v2.46.0.\n- Not done: roll back plan untested');
    expect(r.done).toContain('shipped v2.46.0');
    expect(r.notDone).toContain('roll back plan untested');
  });
});

describe('extractStructuredSummary — 中文 markers', () => {
  it('extracts 剩下的 section', () => {
    const text = [
      '● 做完。',
      '  - v2.44.0: CI ✅',
      '  - v2.45.0: Release ✅',
      '',
      '剩下的 Gap #3 (4.2% noise floor) 和 Gap #2 数据回填属于下次要不要开干的独立决策。',
    ].join('\n');
    const r = extractStructuredSummary(text);
    expect(r.notDone).toContain('Gap #3');
    expect(r.notDone).toContain('数据回填');
  });

  it('extracts 未完成 + 下次 variants', () => {
    expect(extractStructuredSummary('未完成: schema migration\n下次继续: Haiku 稳定性').notDone).toContain(
      'schema migration',
    );
    const both = extractStructuredSummary('未完成: schema migration\n下次继续: Haiku 稳定性');
    expect(both.notDone).toContain('Haiku 稳定性');
  });

  it('does not misfire on unrelated 剩 occurrence mid-sentence', () => {
    const r = extractStructuredSummary('我们剩下一点时间就能做完。');
    // No line-start header → no notDone extraction
    expect(r.notDone).toBe('');
  });
});

describe('extractStructuredSummary — boundary handling', () => {
  it('returns empty object on null/empty input', () => {
    expect(extractStructuredSummary(null)).toEqual({ done: '', notDone: '', failed: '', uncertain: '' });
    expect(extractStructuredSummary('')).toEqual({ done: '', notDone: '', failed: '', uncertain: '' });
  });

  it('returns empty sections for prose without markers', () => {
    const r = extractStructuredSummary('I looked at the code and it seems fine.');
    expect(r).toEqual({ done: '', notDone: '', failed: '', uncertain: '' });
  });

  it('terminates a section on blank-line + non-bullet paragraph', () => {
    const text = [
      'Not done:',
      '- item A',
      '- item B',
      '',
      'And by the way, I also noticed the build time doubled.',
    ].join('\n');
    const r = extractStructuredSummary(text);
    expect(r.notDone).toContain('item A');
    expect(r.notDone).toContain('item B');
    expect(r.notDone).not.toContain('build time doubled');
  });

  it('continues a section across a blank-line if followed by a bullet', () => {
    const text = ['Not done:', '- first item', '', '- second item after blank'].join('\n');
    const r = extractStructuredSummary(text);
    expect(r.notDone).toContain('first item');
    expect(r.notDone).toContain('second item after blank');
  });

  it('a new section header ends the prior section', () => {
    const r = extractStructuredSummary('Done: A\nNot done: B\nFailed: C');
    expect(r.done).toBe('A');
    expect(r.notDone).toBe('B');
    expect(r.failed).toBe('C');
  });
});

// R6 (2026-09-26): 362 of 440 turn-final reports across this machine's transcripts used a
// markdown heading (`## Done` 202, `**Done**` 118, …) that the colon-only header missed, so
// the model's summary took Done / Not done even where the assistant had written its own.
describe('extractStructuredSummary — markdown heading reports', () => {
  it('reads `**Done**` / `**Not done**` / `**Uncertain**` block headings (v6.14.0 release report)', () => {
    const text = [
      'v6.14.0 已发布：CI 和 Release 都是绿的。',
      '',
      '**Done**',
      '- **Bash 读写文件的记忆与召回（N1 + R8）**：回放中比例从 3.3% 升到 87.3%。',
      '- **error-recall 不再回应刻意的 TDD 红（N2）**：触发次数从 1,107 降到 641。',
      '',
      '**Not done**',
      '- **D#69 的效果还需要发布后验证（D#101）**：等约 100 条新记录。',
      '- **P3 残留（D#100）**：',
      '  - 循环变量按名字匹配；',
      '  - 超过 64 个 helper 不再解析；',
      '',
      '**Uncertain**',
      '- 不确定新的 Bash 召回的引用率。',
      '',
      '**给另外两个仓库的提示词**',
      '',
      'code-graph-mcp：',
      '> PreToolUse:Bash hook sometimes emits invalid JSON.',
    ].join('\n');
    const r = extractStructuredSummary(text);
    expect(r.done).toContain('87.3%');
    expect(r.done).toContain('1,107');
    expect(r.notDone).toContain('D#101');
    expect(r.notDone).toContain('超过 64 个 helper');
    expect(r.uncertain).toBe('- 不确定新的 Bash 召回的引用率。');
    expect(r.failed).toBe('');
  });

  it('reads `## Done` sections whose body is a paragraph and a table, up to the next heading or rule', () => {
    const text = [
      '# Final report',
      '',
      '## Done',
      '',
      '**4 rounds, 3 defects fixed.**',
      '',
      '| # | sev |',
      '|---|---|',
      '| 1 | P1 |',
      '',
      '## Not done',
      '',
      '- the relabel waits for 100 events',
      '',
      '---',
      'Unrelated trailing note.',
    ].join('\n');
    const r = extractStructuredSummary(text);
    expect(r.done).toBe('**4 rounds, 3 defects fixed.**\n| # | sev |\n|---|---|\n| 1 | P1 |');
    expect(r.notDone).toBe('- the relabel waits for 100 events');
  });

  it('`**Done:**` / `**Not done.**` on their own line leave no stray markup', () => {
    const r = extractStructuredSummary('**Done:**\n- A\n\n**Not done.**\n- B');
    expect(r.done).toBe('- A');
    expect(r.notDone).toBe('- B');
  });

  it('an inline bold header after a block section starts its own section, without the markup', () => {
    const r = extractStructuredSummary('**Not done**\n- the relabel\n**Failed:** 无。');
    expect(r.notDone).toBe('- the relabel');
    expect(r.failed).toBe('无。');
  });

  it('after an inline header the paragraph-break rule applies again, not the block rule', () => {
    const r = extractStructuredSummary('**Done**\n- A\nNot done: B\n\nAn unrelated closing paragraph.');
    expect(r.notDone).toBe('B');
  });

  it('`**Not done** — text` / `**Failed** — 无。` are inline headers', () => {
    const r = extractStructuredSummary('**Done**\n- A\n\n**Not done** — 未提交。\n**Failed** - none');
    expect(r).toEqual({ done: '- A', notDone: '未提交。', failed: 'none', uncertain: '' });
  });

  // Pre-ship review P3-3: real headers carrying a parenthetical, and a combined header. Each
  // was misread (Not done filed under Done, or dropped), which then wiped remaining_items.
  it.each([
    ['**Done**\n- A\n**Not done**（未开始，非受阻）：D#21 等三项', '（未开始，非受阻） D#21 等三项'],
    [
      '## Done\n- A\n## Not done（报告已明确排除在前 5 之外）\n- D#21',
      '（报告已明确排除在前 5 之外）\n- D#21',
    ],
    ['**Done**\n- A\n**Not done（未开始）**\n- D#21', '（未开始）\n- D#21'],
    ['**Done**\n- A\n**Not done / Failed / Uncertain**：与上一条汇报相同', '与上一条汇报相同'],
    ['**Done**\n- A\n**Not done — 第二组，等你批**', '第二组，等你批'],
  ])('%j keeps its Not done', (text, notDone) => {
    const r = extractStructuredSummary(text);
    expect(r.done).toBe('- A');
    expect(r.notDone).toBe(notDone);
  });

  // Pre-ship review P3-2, delta review P3-1: header parsing must be linear in line length —
  // a quadratic parser still passes at 5000 characters (11 ms), so the lines here are 200k,
  // where quadratic reads seconds (the delta review measured 50k at 1 s).
  it.each([
    [' '.repeat(200_000) + 'x'],
    ['## Done' + ' '.repeat(200_000) + 'x'],
    ['## ' + ' '.repeat(200_000) + 'x'],
    ['**Done' + ' '.repeat(200_000) + 'x'],
    ['**Done' + ' '.repeat(200_000) + '.' + ' '.repeat(200_000) + 'x'],
    ['### Failed' + '\t'.repeat(200_000) + '.x'],
    ['**Not done**' + ' '.repeat(200_000) + '（' + 'x'.repeat(5000)],
  ])('a long whitespace run in a header-shaped line stays linear (%#)', (line) => {
    const t0 = performance.now();
    extractStructuredSummary('## Done\n- A\n' + line + '\n' + line);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  // Claims review of 44ad93e: three shapes the first cut got wrong or left unpinned.
  it('`**Failed.** Nothing.` is an inline header, not text of the section before it', () => {
    const r = extractStructuredSummary('**Not done**\n- the relabel\n**Failed.** Nothing.');
    expect(r).toEqual({ done: '', notDone: '- the relabel', failed: 'Nothing.', uncertain: '' });
  });

  it('a closing question after a blank line ends the last block section', () => {
    const r = extractStructuredSummary('## Uncertain\n- 无。\n\n要推送并发 v6.13.4 吗？');
    expect(r.uncertain).toBe('- 无。');
  });

  it('a long paragraph that ends in a question is still section content', () => {
    const para = `macOS 这一格我在本地无法验证：${'只有 CI 的 macOS leg 覆盖得到，'.repeat(6)}要我现在 push 吗？`;
    expect(extractStructuredSummary(`## Uncertain\n- 无。\n\n${para}`).uncertain).toBe(`- 无。\n${para}`);
  });

  it('a 剩下 / 未做 bullet inside a block section stays in that section', () => {
    const r = extractStructuredSummary(
      '**Uncertain**\n- 剩下的挂账里 D#37 是唯一的另一条 P2\n- 未做 Windows 验证',
    );
    expect(r.notDone).toBe('');
    expect(r.uncertain).toBe('- 剩下的挂账里 D#37 是唯一的另一条 P2\n- 未做 Windows 验证');
  });

  // Delta review P3-2 / P3-3 / P3-8.
  it('`* Done:` asterisk bullets are headers', () => {
    expect(extractStructuredSummary('* Done: shipped v2\n* Not done: tag')).toMatchObject({
      done: 'shipped v2',
      notDone: 'tag',
    });
  });

  it('a question-shaped heading still ends a block section', () => {
    const r = extractStructuredSummary(
      '## Done\n- shipped\n\n## Not done\n- tag\n\n## What should happen next?\nThe baseline expires on 2026-10-14.',
    );
    expect(r.notDone).toBe('- tag');
  });

  // Round-3 delta review P3-1 / P3-2.
  it('headers indented with a no-break or ideographic space, or after a BOM, still parse', () => {
    for (const lead of ['\u00a0', '\u3000', '\ufeff']) {
      expect(extractStructuredSummary(`${lead}**Done**\n- A`).done).toBe('- A');
    }
  });

  it('a closing question that starts with `#42` is still skipped (only a heading is kept)', () => {
    expect(extractStructuredSummary('## Uncertain\n- 无。\n\n#42 要一起关掉吗？').uncertain).toBe('- 无。');
  });

  it('bold inside an inline tail keeps its closing markup', () => {
    expect(extractStructuredSummary('**Done:** shipped **v2.1**').done).toBe('shipped **v2.1**');
  });

  it('a heading with more words, or a bare "Done." line, is not a section', () => {
    const r = extractStructuredSummary('## Done criteria\n- x\n\nDone.\n\nThe tests pass.');
    expect(r).toEqual({ done: '', notDone: '', failed: '', uncertain: '' });
  });
});

// The report shape the claudemd spec has required since at least 2026-10-24: `## 汇报` (or
// `## Report`) with 变更 / 验证 / 遗留 (Changes / Verification / Open items) parts. R4
// (docs/audits/20261124-r4-session-history-analysis.md §8.1) fed 162 such reports to this
// extractor: done 0/162, notDone 17/158.
describe('extractStructuredSummary — 汇报 / Report parts (变更 / 验证 / 遗留)', () => {
  const report = (changes, verify, open) =>
    [
      '## 汇报',
      '',
      '上一轮的三项都处理完了，本轮不发版。',
      '',
      ...changes,
      '- **D#101**（`a1b2c3d4`，已推送）：purge 在数据还在时不再说 Done!，改为退出码 1。',
      '  - 两种情况都加了回归测试。',
      '- **D#102**：README 的用法文字同步。',
      '',
      ...verify,
      '- `npx vitest run` → 通过（568 个文件）',
      '- 变异验证：去掉新分支，两个用例变红 → 通过',
      '',
      ...open,
      '1. D#103：发版说明要写进 CHANGELOG，下次发版时做。',
      '2. 基线 12-01 过期，要在那之前重采。',
    ].join('\n');

  it('reads `**变更**` / `**验证**` / `**遗留**` bold parts: 变更 → done, 遗留 → notDone, 验证 → neither', () => {
    const r = extractStructuredSummary(report(['**变更**'], ['**验证**'], ['**遗留**']));
    expect(r.done).toContain('D#101');
    expect(r.done).toContain('两种情况都加了回归测试');
    expect(r.done).toContain('D#102');
    expect(r.notDone).toContain('D#103');
    expect(r.notDone).toContain('基线 12-01 过期');
    expect(r.done).not.toContain('npx vitest');
    expect(r.notDone).not.toContain('npx vitest');
    expect(r.done).not.toContain('本轮不发版');
  });

  it('reads `### 变更` / `### 验证` / `### 遗留` heading parts', () => {
    const r = extractStructuredSummary(report(['### 变更'], ['### 验证'], ['### 遗留']));
    expect(r.done).toContain('D#101');
    expect(r.notDone).toContain('D#103');
    expect(r.notDone).not.toContain('变异验证');
  });

  it('a part with a parenthetical or a colon label still opens the part', () => {
    expect(
      extractStructuredSummary(
        report(['**变更**（本地 main，未推送）'], ['**验证**'], ['**遗留（需要你决定）**']),
      ).notDone,
    ).toContain('D#103');
    expect(
      extractStructuredSummary(report(['**变更**'], ['**验证**'], ['**遗留：需要你决定的事**'])).notDone,
    ).toContain('基线 12-01');
    expect(extractStructuredSummary('## 汇报\n\n**变更**：没有改任何文件。').done).toBe('没有改任何文件。');
  });

  it('a report with no 遗留 part has an empty notDone', () => {
    const r = extractStructuredSummary(report(['**变更**'], ['**验证**'], ['']));
    expect(r.done).toContain('D#101');
    expect(r.notDone).toBe('');
  });

  it('reads the English `## Report` parts: Changes / Verification / Open items', () => {
    const text = [
      '## Report',
      '',
      '**Changes**',
      '- `lib/x.mjs`: the cap is now per session (commit `a1b2c3d4`).',
      '',
      '**Verification**',
      '- `npx vitest run` → passed (568 files)',
      '',
      '**Open items**',
      '- D#103: write the release note at the next release.',
    ].join('\n');
    const r = extractStructuredSummary(text);
    expect(r.done).toContain('the cap is now per session');
    expect(r.notDone).toContain('D#103');
    expect(r.done).not.toContain('npx vitest');
  });

  // Pre-tag review of 6.35.6 (defects r1). F2: outside a `## 汇报` / `## Report` the part names are
  // ordinary words — a generic `### Changes` list must not lock Remaining to '' (v6.35.5 read none).
  it('without a 汇报 / Report heading, Changes / 变更 / Open items open nothing', () => {
    for (const t of [
      '### Changes\n- Moved the parser\n\n### Next steps\n- wire the flag',
      '**Changes:**\n- Moved the parser\n**Still to do:** wire the CLI flag',
      'Changes: moved the parser',
      '**变更**\n- 改了解析\n\n**遗留**\n- 接上参数',
      '## Changes\n1. Split the parser\n2. Add a cache\n\nShall I proceed?',
    ])
      expect(extractStructuredSummary(t), t).toEqual({ done: '', notDone: '', failed: '', uncertain: '' });
  });

  // F1: a part header carrying a label, then a blank line, then a bold lead line or a table.
  it('a labelled 遗留 part keeps what follows a blank line, a bold lead or a table', () => {
    const a = extractStructuredSummary(
      '## 汇报\n\n**变更**\n- a\n\n### 遗留（需要你决定）\n\n**评审的 MEDIUM 已复现。**\n1. 决定 X\n2. 决定 Y',
    );
    expect(a.notDone).toContain('决定 X');
    expect(a.notDone).toContain('决定 Y');
    const b = extractStructuredSummary(
      '## 汇报\n\n**变更**\n- a\n\n**遗留：需要你决定**\n\n| 项 | 选项 |\n|---|---|\n| X | a/b |',
    );
    expect(b.notDone).toContain('| X | a/b |');
  });

  // F3: a bold sub-heading inside a part does not end it; the next part header does.
  it('a bold sub-heading inside a part stays in the part', () => {
    const r = extractStructuredSummary(
      '## 汇报\n\n**变更**\n- a\n**发版。**\n- b\n\n**验证**\n- c → 通过\n\n**遗留**\n**需要你决定**\n1. X\n**需要你授权的**\n2. Y',
    );
    expect(r.done).toContain('- b');
    expect(r.notDone).toContain('2. Y');
    expect(r.done + r.notDone).not.toContain('通过');
  });

  // D#941 (decided 2026-11-24): a 剩下… / 剩余… line inside a 变更 or 验证 part stays in that part.
  // In 6 of 299 real reports, 53 of the 54 such lines were finished work, check results or analysis
  // (`剩余工作：D#… 核实后关闭` lists closed items), and the one real open item was also in 遗留.
  it('剩余… / 剩下… lines inside 变更 and 验证 stay there, and only 遗留 is Not done', () => {
    const r = extractStructuredSummary(
      [
        '## 汇报',
        '',
        '### 变更',
        '- **推送**：之前的三个本地提交已推送。',
        '- **剩余工作**：D#873、D#875、D#821 逐条在代码里核实后关闭，不改代码。',
        '  - D#873：标记文件在你自己的 700 权限目录里。',
        '',
        '### 验证',
        '- `npx vitest run` → 通过',
        '- 剩下的时间都是跑测试本身，CI 不再改。',
        '',
        '### 遗留',
        '- **D#880（P2）**：仓库里提交的目录链接仍能让 SessionStart 写到仓库外。',
      ].join('\n'),
    );
    expect(r.done).toContain('**剩余工作**：D#873');
    expect(r.done).toContain('D#873：标记文件');
    expect(r.notDone).toBe('- **D#880（P2）**：仓库里提交的目录链接仍能让 SessionStart 写到仓库外。');
    expect(r.done + r.notDone).not.toContain('剩下的时间');
  });

  // D#942 R2-A: the extra names of a multi-name header are read with the four old names only, so a
  // header outside a report extracts as v6.35.5 did (fuzz: 1548 of 199,612 inputs diverged).
  it('outside a report, a multi-name header naming a report part extracts as before', () => {
    for (const t of [
      '**Done / Changes**: shipped X',
      '**Uncertain / 验证**\n- flaky on CI\n- needs a rerun',
      'Failed / Verification: none',
      '**Not done / Open items**: wire the flag',
      '**Done、变更**：x',
      '- Done, Changes: x',
    ])
      expect(extractStructuredSummary(t), t).toEqual({ done: '', notDone: '', failed: '', uncertain: '' });
    expect(extractStructuredSummary('**Not done / Failed / Uncertain**：none').notDone).toBe('none');
  });

  // F4: a header the case-insensitive match accepts but no key names (`ſ` folds to `s`) is no header.
  it('a part name that only matches through case folding is not a header and does not throw', () => {
    expect(() => extractStructuredSummary('## Report\n\nChangeſ: fixed X\nOpen items: Y')).not.toThrow();
  });

  it('prose that merely starts with 变更 / 遗留 / 验证 is not a part', () => {
    const r = extractStructuredSummary(
      '遗留项都处理完了，没有需要你决定的事。\n变更了两处注释。\n验证过的结论不变。',
    );
    expect(r).toEqual({ done: '', notDone: '', failed: '', uncertain: '' });
  });
});

describe('extractTailAssistantText', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mem-txr-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null on missing path', () => {
    expect(extractTailAssistantText('/no/such/path.jsonl')).toBeNull();
    expect(extractTailAssistantText(null)).toBeNull();
    expect(extractTailAssistantText('')).toBeNull();
  });

  it('returns null when transcript has no assistant entries', () => {
    const p = join(dir, 't.jsonl');
    writeFileSync(p, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
    expect(extractTailAssistantText(p)).toBeNull();
  });

  it('returns concatenated text blocks of the LAST assistant entry', () => {
    const p = join(dir, 't.jsonl');
    const lines = [
      { type: 'user', message: { content: 'start' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'first assistant msg' }] } },
      { type: 'user', message: { content: 'more' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Done: shipped.' },
            { type: 'text', text: 'Not done: docs.' },
          ],
        },
      },
    ];
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
    const tail = extractTailAssistantText(p);
    expect(tail).toContain('Done: shipped.');
    expect(tail).toContain('Not done: docs.');
    expect(tail).not.toContain('first assistant msg');
  });

  it('skips malformed JSONL lines without aborting', () => {
    const p = join(dir, 't.jsonl');
    const good = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    writeFileSync(p, `garbage\n${good}\n{"broken"\n`);
    expect(extractTailAssistantText(p)).toBe('ok');
  });

  // Issue #53: the reader goes backwards from the end of the file. The oracle is the forward
  // parse it replaced (extractTailAssistantText before the change, verbatim).
  describe('reads backwards and answers what the forward parse answered', () => {
    const forward = (p) => {
      _resetTranscriptCache();
      let last = null;
      for (const entry of readTranscriptEntries(p)) {
        if (entry.type !== 'assistant' || !entry.message) continue;
        const content = entry.message.content;
        if (!Array.isArray(content)) continue;
        const texts = content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text);
        if (texts.length === 0) continue;
        last = texts.join('\n');
      }
      return last;
    };
    const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    const toolOnly = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    };
    const result = (n) => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'r'.repeat(n) }] },
    });
    const cases = {
      'last text far behind tool records, across many chunks': [
        say('the answer'),
        ...Array(60).fill(result(9000)),
        toolOnly,
      ],
      'a line longer than every chunk': [
        say('early'),
        say(`long ${'y'.repeat(9 * 1024 * 1024)} end`),
        result(10),
      ],
      'the text line straddles a chunk edge': [say('a'), result(65536 - 200), say('straddler'), result(150)],
      'an empty text block counts, as before': [say('earlier'), say('')],
      'no text anywhere': [toolOnly, result(70000), toolOnly],
      'garbage and blank lines around it': ['garbage', say('kept'), '', '{"broken"', '   '],
    };
    for (const [name, records] of Object.entries(cases)) {
      for (const ending of ['\n', '', '\n{"type":"assistant","mess']) {
        it(`${name} (file ends with ${JSON.stringify(ending)})`, () => {
          const p = join(dir, 't.jsonl');
          writeFileSync(
            p,
            records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + ending,
          );
          expect(extractTailAssistantText(p)).toBe(forward(p));
        });
      }
    }

    it('premise: the cases are not all one answer', () => {
      const answers = new Set();
      for (const records of Object.values(cases)) {
        const p = join(dir, 't.jsonl');
        writeFileSync(p, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
        answers.add(forward(p));
      }
      expect(answers.size).toBeGreaterThanOrEqual(5);
    });

    it('reads only the end: a sparse 600 MB file whose head the forward parse cannot hold', () => {
      // 600 MB of zero bytes, then the last turn. Only the last chunks are read; a forward read
      // would need a 600 MB string, past V8's string limit.
      const p = join(dir, 'sparse.jsonl');
      const tail = Buffer.from('\n' + JSON.stringify(say('the final reply')) + '\n');
      const fd = openSync(p, 'w');
      try {
        ftruncateSync(fd, 600 * 1024 * 1024);
        writeSync(fd, tail, 0, tail.length, 600 * 1024 * 1024);
      } finally {
        closeSync(fd);
      }
      expect(extractTailAssistantText(p)).toBe('the final reply');
    });
  });

  it('round-trips with extractStructuredSummary on a realistic tail', () => {
    const tail = '● 做完。\n  - v2.44.0: CI ✅\n\n剩下的 Gap #3 和 Gap #2 数据回填属于下次独立决策。';
    const p = join(dir, 't.jsonl');
    writeFileSync(
      p,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: tail }] } }),
    );
    const r = extractStructuredSummary(extractTailAssistantText(p));
    expect(r.notDone).toContain('Gap #3');
    expect(r.notDone).toContain('数据回填');
  });
});
