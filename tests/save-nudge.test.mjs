// Minimal regression coverage for lib/save-nudge.mjs (baseline round 2026-09-02).
// The module had no direct test importer; it is the ONE gate behind both the MCP
// mem_save and CLI `save` "saved without a lesson" nudges, so a regression here
// changes user-visible save output on two faces at once.

import { describe, it, expect } from 'vitest';
import { buildLessonNudge } from '../lib/save-nudge.mjs';

describe('buildLessonNudge', () => {
  it('nudges a lessonless bugfix on the MCP face and names the follow-up call with the id', () => {
    const out = buildLessonNudge({ type: 'bugfix', id: 42, lessonCaptured: false, surface: 'mcp' });
    expect(out).toContain('mem_update(id=42');
    expect(out).toContain('bugfix');
  });

  it('nudges a lessonless decision on the CLI face with the CLI update command', () => {
    const out = buildLessonNudge({ type: 'decision', id: 7, lessonCaptured: false, surface: 'cli' });
    expect(out).toContain('claude-mem-lite update 7 --lesson');
    expect(out).toContain('decision #7');
  });

  it('stays silent once the lesson is captured', () => {
    expect(buildLessonNudge({ type: 'bugfix', id: 1, lessonCaptured: true, surface: 'mcp' })).toBe('');
  });

  it('stays silent for types whose value is not the lesson', () => {
    for (const type of ['feature', 'refactor', 'discovery', 'test']) {
      expect(buildLessonNudge({ type, id: 1, lessonCaptured: false, surface: 'cli' })).toBe('');
    }
  });

  it('the two faces differ only in phrasing, never in the gate', () => {
    for (const type of ['bugfix', 'decision']) {
      const mcp = buildLessonNudge({ type, id: 3, lessonCaptured: false, surface: 'mcp' });
      const cli = buildLessonNudge({ type, id: 3, lessonCaptured: false, surface: 'cli' });
      expect(mcp).not.toBe('');
      expect(cli).not.toBe('');
      expect(mcp).not.toBe(cli);
    }
  });
});
