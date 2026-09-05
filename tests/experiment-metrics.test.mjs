// Unit tests for experiment/lib/metrics.mjs — pure extraction of the three
// outcome signals from a claude -p run: tokens, tool-call count, and whether
// the previously-captured bug recurred (the regression check failed).

import { describe, test, expect } from 'vitest';
import { extractTokens, countToolUses, recurredFromCheck } from '../experiment/lib/metrics.mjs';

describe('extractTokens', () => {
  test('sums input/output/cache token fields from a claude json result', () => {
    expect(
      extractTokens({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 200,
        },
      }),
    ).toBe(360);
  });

  test('tolerates missing or partial usage', () => {
    expect(extractTokens({})).toBe(0);
    expect(extractTokens({ usage: {} })).toBe(0);
    expect(extractTokens({ usage: { input_tokens: 5 } })).toBe(5);
  });
});

describe('countToolUses', () => {
  test('counts tool_use blocks across assistant stream-json events', () => {
    const events = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', name: 'Edit' },
          ],
        },
      },
      { type: 'user', message: { content: [{ type: 'tool_result' }] } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash' },
            { type: 'tool_use', name: 'Read' },
          ],
        },
      },
      { type: 'result' },
    ];
    expect(countToolUses(events)).toBe(3);
  });

  test('returns 0 for an empty or text-only transcript', () => {
    expect(countToolUses([])).toBe(0);
    expect(
      countToolUses([{ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }]),
    ).toBe(0);
  });
});

describe('recurredFromCheck', () => {
  test('non-zero regression exit means the captured bug recurred', () => {
    expect(recurredFromCheck({ exitCode: 1 })).toBe(true);
  });

  test('zero regression exit means the bug stayed fixed', () => {
    expect(recurredFromCheck({ exitCode: 0 })).toBe(false);
  });
});
