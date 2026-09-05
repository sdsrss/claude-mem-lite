// Tests for lib/summary-extractor.mjs — deterministic Done/Not done extractor.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractTailAssistantText, extractStructuredSummary } from '../lib/summary-extractor.mjs';

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
