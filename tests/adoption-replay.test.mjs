import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractInjectionEvents } from '../benchmark/adoption-replay.mjs';

function fixture(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-'));
  const f = join(dir, 's.jsonl');
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n'));
  return f;
}

describe('extractInjectionEvents', () => {
  it('captures an imperative event with query + dual-channel output window', () => {
    const ts = '2026-07-01T00:00:00.000Z';
    const f = fixture([
      {
        type: 'user',
        sessionId: 's1',
        timestamp: ts,
        message: { role: 'user', content: 'fix the rrfAccumulate merge' },
      },
      {
        sessionId: 's1',
        timestamp: ts,
        attachment: {
          hookName: 'UserPromptSubmit',
          content: 'Memory — a past lesson applies to THIS task. You must: call rrfAccumulate (#8042)',
        },
      },
      {
        type: 'assistant',
        sessionId: 's1',
        timestamp: ts,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Updating the merge now.' },
            { type: 'tool_use', name: 'Edit', input: { new_string: 'const r = rrfAccumulate(a, b);' } },
          ],
        },
      },
      { type: 'user', sessionId: 's1', timestamp: ts, message: { role: 'user', content: 'thanks' } },
    ]);
    const events = extractInjectionEvents(f, { start: 0, end: Date.now() + 1e12 });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.surface).toBe('imperative');
    expect(e.injectedIds).toContain('8042');
    expect(e.query).toMatch(/rrfAccumulate merge/);
    expect(e.outputWindow.actions).toMatch(/rrfAccumulate\(a, b\)/);
    expect(e.outputWindow.prose).toMatch(/Updating the merge/);
  });

  it('captures output-window actions across a tool_result relay (real transcript shape) — Fix 1a', () => {
    const ts = '2026-07-01T00:00:00.000Z';
    const f = fixture([
      {
        type: 'user',
        sessionId: 's4',
        timestamp: ts,
        message: { role: 'user', content: 'fix the rrfAccumulate merge' },
      },
      {
        sessionId: 's4',
        timestamp: ts,
        attachment: {
          hookName: 'UserPromptSubmit',
          content: 'Memory — a past lesson applies to THIS task. You must: call rrfAccumulate (#9001)',
        },
      },
      {
        type: 'assistant',
        sessionId: 's4',
        timestamp: ts,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Updating the merge now.' },
            { type: 'tool_use', name: 'Edit', input: { new_string: 'const r = rrfAccumulate(a, b);' } },
          ],
        },
      },
      // Tool result relay: a REAL Claude Code transcript records a tool's
      // result as a type:'user' entry whose content is a tool_result part —
      // the same outer shape as a genuine human message. This must NOT act
      // as a boundary (no intervening tool_result is unrealistic).
      {
        type: 'user',
        sessionId: 's4',
        timestamp: ts,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'edit applied' }],
        },
      },
      {
        type: 'assistant',
        sessionId: 's4',
        timestamp: ts,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Now updating the caller too.' },
            { type: 'tool_use', name: 'Edit', input: { new_string: 'const s = rrfAccumulate(c, d);' } },
          ],
        },
      },
      { type: 'user', sessionId: 's4', timestamp: ts, message: { role: 'user', content: 'thanks' } },
    ]);
    const events = extractInjectionEvents(f, { start: 0, end: Date.now() + 1e12 });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.surface).toBe('imperative');
    // Pre-fix the window loop breaks at the tool_result relay (mistaken for a
    // real user message) and never sees the later action/prose.
    expect(e.outputWindow.actions).toMatch(/rrfAccumulate\(a, b\)/);
    expect(e.outputWindow.actions).toMatch(/rrfAccumulate\(c, d\)/);
    expect(e.outputWindow.prose).toMatch(/Now updating the caller too/);
  });

  it('does not let a tool_result relay clobber lastUserPrompt — Fix 1b', () => {
    const ts = '2026-07-01T00:00:00.000Z';
    const f = fixture([
      {
        type: 'user',
        sessionId: 's5',
        timestamp: ts,
        message: { role: 'user', content: 'fix the rrfAccumulate merge' },
      },
      {
        sessionId: 's5',
        timestamp: ts,
        attachment: {
          hookName: 'UserPromptSubmit',
          content: 'Memory — a past lesson applies to THIS task. You must: call rrfAccumulate (#9101)',
        },
      },
      {
        type: 'assistant',
        sessionId: 's5',
        timestamp: ts,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Edit', input: { new_string: 'const r = rrfAccumulate(a, b);' } },
          ],
        },
      },
      // Tool result relay BEFORE a second injection in the same (still-open)
      // turn — no real user prompt has occurred since "fix the rrfAccumulate
      // merge", so the second injection's query must still reflect it.
      {
        type: 'user',
        sessionId: 's5',
        timestamp: ts,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'edit applied' }],
        },
      },
      {
        sessionId: 's5',
        timestamp: ts,
        attachment: {
          hookName: 'UserPromptSubmit',
          content: 'Memory — a past lesson applies to THIS task. You must: also call rrfAccumulate (#9102)',
        },
      },
      {
        type: 'assistant',
        sessionId: 's5',
        timestamp: ts,
        message: { role: 'assistant', content: [{ type: 'text', text: 'ack' }] },
      },
      { type: 'user', sessionId: 's5', timestamp: ts, message: { role: 'user', content: 'thanks' } },
    ]);
    const events = extractInjectionEvents(f, { start: 0, end: Date.now() + 1e12 });
    expect(events).toHaveLength(2);
    const second = events.find((e) => e.injectedIds.includes('9102'));
    // Pre-fix, the tool_result relay clears lastUserPrompt to '' before the
    // second injection is processed.
    expect(second.query).toBe('fix the rrfAccumulate merge');
  });

  it('gates ups-fts to UserPromptSubmit — a PostToolUse [mem] recall card must not surface as ups-fts — Fix 2', () => {
    const ts = '2026-07-01T00:00:00.000Z';
    const f = fixture([
      {
        type: 'user',
        sessionId: 's6',
        timestamp: ts,
        message: { role: 'user', content: 'what changed recently' },
      },
      // PreToolUse recall cards carry the same generic `[mem]` prefix as the
      // UserPromptSubmit FYI surface but come from a different hook entirely.
      {
        sessionId: 's6',
        timestamp: ts,
        attachment: {
          hookName: 'PreToolUse:Read',
          content: '[mem] PreToolUse recall — system-injected context: adoption-replay.mjs #1234',
        },
      },
      {
        type: 'assistant',
        sessionId: 's6',
        timestamp: ts,
        message: { role: 'assistant', content: [{ type: 'text', text: 'ack' }] },
      },
      { type: 'user', sessionId: 's6', timestamp: ts, message: { role: 'user', content: 'thanks' } },
    ]);
    const events = extractInjectionEvents(f, { start: 0, end: Date.now() + 1e12 });
    expect(events).toHaveLength(0);
  });

  it('emits one subagent event per parallel Agent tool_use instead of collapsing to the last — Fix 4', () => {
    const ts = '2026-07-01T00:00:00.000Z';
    const marker = "surfaced by your operator's claude-mem-lite";
    const f = fixture([
      {
        type: 'user',
        sessionId: 's7',
        timestamp: ts,
        message: { role: 'user', content: 'run two audits in parallel' },
      },
      {
        type: 'assistant',
        sessionId: 's7',
        timestamp: ts,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Agent',
              input: { prompt: `${marker} — past lesson #111 applies to this subtask` },
            },
            {
              type: 'tool_use',
              name: 'Agent',
              input: { prompt: `${marker} — past lesson #222 applies to this subtask` },
            },
          ],
        },
      },
      { type: 'user', sessionId: 's7', timestamp: ts, message: { role: 'user', content: 'thanks' } },
    ]);
    const events = extractInjectionEvents(f, { start: 0, end: Date.now() + 1e12 });
    const subagentEvents = events.filter((e) => e.surface === 'subagent');
    // Pre-fix the loop overwrites shared surface/query/injected per
    // iteration, so only the second (#222) tool_use survives into one event.
    expect(subagentEvents).toHaveLength(2);
    const byId = Object.fromEntries(subagentEvents.map((e) => [e.injectedIds[0], e]));
    expect(byId['111']).toBeDefined();
    expect(byId['222']).toBeDefined();
    expect(byId['111'].query).toMatch(/#111/);
    expect(byId['222'].query).toMatch(/#222/);
  });
});
