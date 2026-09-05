// G3 (roadmap 2026-07-18): unpersisted-decision reminder — the write-side other
// half of the D#92 incident. A session where the user finalizes something
// (定稿/拍板/approved/…) but the agent makes NO deliberate persistence call
// (mem_save / mem_defer / CLI save / defer add) loses the decision at /clear:
// tasks/ and docs/ are gitignored local files with no cross-session search face.
// Detection at Stop → payload rides cite-recall-<project>.json → the NEXT
// SessionStart surfaces one reminder line. Remind-only: never auto-writes.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectFinalization,
  countDeliberatePersistence,
  detectUnpersistedDecision,
} from '../lib/persist-reminder.mjs';
import { buildCiteRecallNudge } from '../lib/cite-back-hint.mjs';

function writeTranscript(dir, entries) {
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

function assistantToolUse(name, input) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } };
}

describe('detectFinalization', () => {
  it('matches CJK and EN finalization word forms', () => {
    expect(detectFinalization(['方案就按这个来，拍板了'])).toBe('拍板');
    expect(detectFinalization(['设计定稿，进 writing-plans'])).toBeTruthy();
    expect(detectFinalization(['ok this design is approved, ship it'])).toBeTruthy();
    expect(detectFinalization(['敲定用 sqlite'])).toBe('敲定');
  });

  it('stays silent on ordinary prompts', () => {
    expect(detectFinalization(['修一下这个 bug', 'run the tests', '继续'])).toBeNull();
    expect(detectFinalization([])).toBeNull();
  });
});

describe('countDeliberatePersistence (transcript scan)', () => {
  it('counts mem_save / mem_defer tool_use and CLI save / defer add', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persist-rem-'));
    const p = writeTranscript(dir, [
      assistantToolUse('mcp__plugin_claude-mem-lite_mem-lite__mem_save', { type: 'decision', content: 'x' }),
      assistantToolUse('mcp__plugin_claude-mem-lite_mem-lite__mem_defer', { title: 'y' }),
      assistantToolUse('Bash', { command: 'node cli.mjs save "z" --type decision' }),
      assistantToolUse('Bash', { command: 'node cli.mjs defer add "w" --priority 2' }),
      assistantToolUse('Bash', { command: 'ls -la' }),
      assistantToolUse('Read', { file_path: '/tmp/x' }),
    ]);
    expect(countDeliberatePersistence(p)).toBe(4);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns 0 for a write-free transcript and missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persist-rem-'));
    const p = writeTranscript(dir, [assistantToolUse('Bash', { command: 'npx vitest run' })]);
    expect(countDeliberatePersistence(p)).toBe(0);
    expect(countDeliberatePersistence(join(dir, 'nope.jsonl'))).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts Skill lesson/memory/bug and memdir Write/Edit paths (G18)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persist-rem-'));
    const p = writeTranscript(dir, [
      assistantToolUse('Skill', { skill: 'claude-mem-lite:lesson', args: 'x' }),
      assistantToolUse('Skill', { skill: 'memory' }),
      assistantToolUse('Skill', { skill: 'claude-mem-lite:bug' }),
      assistantToolUse('Write', {
        file_path: '/home/u/.claude/projects/-x-y/memory/project_foo.md',
        content: 'f',
      }),
      assistantToolUse('Edit', {
        file_path: '/home/u/.claude/projects/-x-y/memory/MEMORY.md',
        old_string: 'a',
        new_string: 'b',
      }),
      // NOT persistence: unrelated skill, non-memdir write, memdir-adjacent path
      assistantToolUse('Skill', { skill: 'claude-mem-lite:mem' }),
      assistantToolUse('Write', { file_path: '/home/u/project/notes.md', content: 'n' }),
      assistantToolUse('Write', { file_path: '/home/u/.claude/projects/-x-y/tasks/t.md', content: 't' }),
    ]);
    expect(countDeliberatePersistence(p)).toBe(5);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not count a search command that merely mentions save', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persist-rem-'));
    const p = writeTranscript(dir, [
      assistantToolUse('Bash', { command: 'node cli.mjs search "save enrichment"' }),
      assistantToolUse('mcp__plugin_claude-mem-lite_mem-lite__mem_search', { query: 'defer add' }),
    ]);
    expect(countDeliberatePersistence(p)).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('detectUnpersistedDecision', () => {
  it('fires on finalization signal + zero persistence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persist-rem-'));
    const p = writeTranscript(dir, [assistantToolUse('Bash', { command: 'npx vitest run' })]);
    const r = detectUnpersistedDecision({ prompts: ['方案 B 拍板，开工'], transcriptPath: p });
    expect(r.fire).toBe(true);
    expect(r.signal).toBe('拍板');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT fire when the session persisted something', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persist-rem-'));
    const p = writeTranscript(dir, [
      assistantToolUse('mcp__plugin_claude-mem-lite_mem-lite__mem_defer', { title: 'the decision' }),
    ]);
    const r = detectUnpersistedDecision({ prompts: ['方案 B 拍板，开工'], transcriptPath: p });
    expect(r.fire).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT fire without a finalization signal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persist-rem-'));
    const p = writeTranscript(dir, [assistantToolUse('Bash', { command: 'ls' })]);
    const r = detectUnpersistedDecision({ prompts: ['继续修 bug'], transcriptPath: p });
    expect(r.fire).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('SessionStart surface (buildCiteRecallNudge third gate)', () => {
  it('emits the reminder line when the payload carries decisionSignal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persist-rem-'));
    writeFileSync(
      join(dir, 'cite-recall-projx.json'),
      JSON.stringify({
        injected: 0,
        recalled: 0,
        ratio: 1,
        unsaved: 0,
        lowStreak: 0,
        decisionSignal: '拍板',
        project: 'projx',
        savedAt: Date.now(),
      }),
    );
    const out = buildCiteRecallNudge('projx', dir, {});
    expect(out).toContain('拍板');
    expect(out).toMatch(/mem_save|mem_defer/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('stays silent without decisionSignal and under the global opt-out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persist-rem-'));
    writeFileSync(
      join(dir, 'cite-recall-projx.json'),
      JSON.stringify({
        injected: 0,
        recalled: 0,
        ratio: 1,
        unsaved: 0,
        lowStreak: 0,
        decisionSignal: null,
        project: 'projx',
        savedAt: Date.now(),
      }),
    );
    expect(buildCiteRecallNudge('projx', dir, {})).toBe('');
    writeFileSync(
      join(dir, 'cite-recall-projx.json'),
      JSON.stringify({
        injected: 0,
        recalled: 0,
        ratio: 1,
        unsaved: 0,
        lowStreak: 0,
        decisionSignal: '拍板',
        project: 'projx',
        savedAt: Date.now(),
      }),
    );
    expect(buildCiteRecallNudge('projx', dir, { CLAUDE_MEM_NO_CITE_NUDGE: '1' })).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });
});
