// Citation-decay text-floor — Stop hook must not lock obs as uncited when the
// current transcript has no main-thread assistant text. Per CLAUDE.md contract
// the model cites "NEXT time you produce user-facing text" — so a tool-only
// Stop is unfair to decay against. This test pins both halves: empty → skip,
// text-bearing → decay normally.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hasMainThreadAssistantText } from '../lib/citation-tracker.mjs';

describe('hasMainThreadAssistantText', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'text-floor-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  function writeTranscript(entries) {
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));
    return path;
  }

  it('returns false for missing transcript', () => {
    expect(hasMainThreadAssistantText('/no/such/file.jsonl')).toBe(false);
  });

  it('returns false for empty transcript', () => {
    expect(hasMainThreadAssistantText(writeTranscript([]))).toBe(false);
  });

  it('returns false when assistant turn is tool-only', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'x' } }] },
      },
    ]);
    expect(hasMainThreadAssistantText(path)).toBe(false);
  });

  it('returns false when only whitespace text', () => {
    const path = writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'text', text: '   \n  \t ' }] } },
    ]);
    expect(hasMainThreadAssistantText(path)).toBe(false);
  });

  it('returns true on any non-whitespace assistant text', () => {
    const path = writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]);
    expect(hasMainThreadAssistantText(path)).toBe(true);
  });

  it('ignores sidechain (subagent) text', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        isSidechain: true,
        message: { content: [{ type: 'text', text: 'subagent reply' }] },
      },
    ]);
    expect(hasMainThreadAssistantText(path)).toBe(false);
  });

  it('returns true when main+sidechain mixed (main wins)', () => {
    const path = writeTranscript([
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'main' }] } },
    ]);
    expect(hasMainThreadAssistantText(path)).toBe(true);
  });

  it('ignores user messages even if they carry text', () => {
    const path = writeTranscript([{ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } }]);
    expect(hasMainThreadAssistantText(path)).toBe(false);
  });

  it('ignores thinking/tool_use blocks within an assistant turn', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'considering options' },
            { type: 'tool_use', name: 'Read', input: { file_path: 'x' } },
          ],
        },
      },
    ]);
    expect(hasMainThreadAssistantText(path)).toBe(false);
  });

  it('returns true when only one of many assistant turns has text', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'x' } }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'y' } }] },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    ]);
    expect(hasMainThreadAssistantText(path)).toBe(true);
  });
});
