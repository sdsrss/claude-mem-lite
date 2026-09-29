// A1: the PreToolUse / PostToolUse recall framing line runs in two arms, assigned per session.
// lib/recall-framing.mjs carries the why; this pins the assignment, the wording contract of
// each arm, and that the A/B ruler reads the arm back from a real transcript shape.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recallFramingArm, recallFramingLine, classifyRecallFraming } from '../lib/recall-framing.mjs';
import { pretoolFramingOf } from '../lib/citation-tracker.mjs';

const AB = { CLAUDE_MEM_RECALL_FRAMING: 'ab' };

describe('recallFramingArm', () => {
  it('is stable for one session id', () => {
    for (const id of ['a', 'cc-123', '00893aaf-19fa-41d2-8238-13269b9b3ca0']) {
      expect(recallFramingArm(id, AB)).toBe(recallFramingArm(id, AB));
    }
  });

  it('splits sessions roughly in half', () => {
    let factual = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) if (recallFramingArm(`session-${i}-x`, AB) === 'factual') factual++;
    // Binomial(2000, 0.5): 3 sd ≈ 67. A constant arm (0 or 2000) is what this must catch.
    expect(factual).toBeGreaterThan(N / 2 - 150);
    expect(factual).toBeLessThan(N / 2 + 150);
  });

  it('defaults to ab when the variable is unset', () => {
    const arms = new Set();
    for (let i = 0; i < 50; i++) arms.add(recallFramingArm(`s${i}`, {}));
    expect(arms).toEqual(new Set(['legacy', 'factual']));
  });

  it('honours the legacy / factual overrides for every session', () => {
    for (let i = 0; i < 20; i++) {
      expect(recallFramingArm(`s${i}`, { CLAUDE_MEM_RECALL_FRAMING: 'legacy' })).toBe('legacy');
      expect(recallFramingArm(`s${i}`, { CLAUDE_MEM_RECALL_FRAMING: ' Factual ' })).toBe('factual');
    }
  });

  it('a block with no session id gets legacy — its arm could not be attributed', () => {
    expect(recallFramingArm(null, AB)).toBe('legacy');
    expect(recallFramingArm('', AB)).toBe('legacy');
  });
});

describe('recallFramingLine — the two wordings', () => {
  const legacy = { CLAUDE_MEM_RECALL_FRAMING: 'legacy' };
  const factual = { CLAUDE_MEM_RECALL_FRAMING: 'factual' };

  it('legacy is byte-identical to the pre-A/B line', () => {
    expect(recallFramingLine('PreToolUse', { sessionId: 's', fname: 'x.mjs', env: legacy })).toBe(
      '[mem] PreToolUse recall — system-injected context, continue your planned action:',
    );
    expect(recallFramingLine('PostToolUse', { env: legacy })).toBe(
      '[mem] PostToolUse recall — system-injected context, continue your planned action:',
    );
  });

  it('factual states its source and that the call continues, with no system claim or command', () => {
    const line = recallFramingLine('PreToolUse', { sessionId: 's', fname: 'utils.mjs', env: factual });
    expect(line).toBe(
      '[mem] PreToolUse recall — notes recorded by claude-mem-lite about utils.mjs; the tool call proceeds as planned:',
    );
    expect(line).not.toMatch(/system/i);
    expect(line).not.toMatch(/\bcontinue your\b/i);
  });

  it('each arm classifies back to itself, and unrelated text to null', () => {
    for (const env of [legacy, factual]) {
      const line = recallFramingLine('PreToolUse', { sessionId: 's', fname: 'a.js', env });
      expect(classifyRecallFraming(`${line}\n[mem] Lessons for a.js:`)).toBe(env.CLAUDE_MEM_RECALL_FRAMING);
    }
    expect(classifyRecallFraming('[mem] Lessons for a.js:\n  #12 [bugfix] x')).toBeNull();
  });

  it('a lesson body quoting the other wording does not relabel the block (review P3-8)', () => {
    const line = recallFramingLine('PreToolUse', { sessionId: 's', fname: 'a.js', env: factual });
    const block = `${line}\n[mem] Lessons for a.js:\n  #7 [bugfix] the old line read "system-injected context, continue your planned action:"`;
    expect(classifyRecallFraming(block)).toBe('factual');
  });
});

describe('pretoolFramingOf — the A/B ruler reads the arm from the transcript', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'framing-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const attachment = (command, additionalContext) => ({
    type: 'attachment',
    attachment: {
      type: 'hook_success',
      command,
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } }),
    },
  });
  const PTR = 'node ${CLAUDE_PLUGIN_ROOT}/scripts/hook-launcher.mjs scripts/pre-tool-recall.js';
  const write = (entries) => {
    const p = join(tmp, 't.jsonl');
    writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n'));
    return p;
  };
  const line = (arm) =>
    recallFramingLine('PreToolUse', {
      sessionId: 's',
      fname: 'a.js',
      env: { CLAUDE_MEM_RECALL_FRAMING: arm },
    });

  it('legacy, factual, mixed and none', () => {
    expect(pretoolFramingOf(write([attachment(PTR, `${line('legacy')}\n  #1 [bugfix] a`)]))).toBe('legacy');
    expect(pretoolFramingOf(write([attachment(PTR, `${line('factual')}\n  #1 [bugfix] a`)]))).toBe('factual');
    expect(pretoolFramingOf(write([attachment(PTR, line('legacy')), attachment(PTR, line('factual'))]))).toBe(
      'mixed',
    );
    expect(pretoolFramingOf(write([{ type: 'user', message: { content: 'hi' } }]))).toBeNull();
  });

  it('only PreToolUse recall attachments count — the same text from another hook does not', () => {
    const other = 'node ${CLAUDE_PLUGIN_ROOT}/scripts/hook-launcher.mjs scripts/user-prompt-search.js';
    expect(pretoolFramingOf(write([attachment(other, line('factual'))]))).toBeNull();
  });
});
