// A Bash edit is an edit (N1, docs/audits/20260926-154904-session-history-analysis-r2.md).
//
// Nine consumers decided "did this episode edit a file" with EDIT_TOOLS.has(e.tool). On
// Opus 5.5 82% of file edits went through Bash, so a session of `sed -i` / python patches
// looked edit-free to all of them: not significant (the episode was dropped), no cite-back,
// no bugfix-shape nudge, every edited file filed under files_read. Each case below pairs
// the Bash entry with the Edit entry it must behave like.
import { describe, it, expect } from 'vitest';
import { extractFilePaths, extractFileTargets, isTransientPath } from '../bash-utils.mjs';
import { entryEditedFiles, isEditEntry, computeRuleImportance } from '../utils.mjs';
import { explainSignificance } from '../hook-episode.mjs';
import { buildCiteBackHint, buildUnsavedBugfixHint } from '../lib/cite-back-hint.mjs';
import { buildImmediateObservation, buildDegradedTitle } from '../hook-llm.mjs';

const F = '/work/proj/lib/a.mjs';
const bashEdit = (files = [F], writes = [F]) => ({ tool: 'Bash', desc: 'sed -i', files, bashWrites: writes });
const bashRead = (files = [F]) => ({ tool: 'Bash', desc: 'cat', files });
const toolEdit = (files = [F]) => ({ tool: 'Edit', desc: 'edit', files });
const episode = (entries) => ({ entries, files: [...new Set(entries.flatMap((e) => e.files || []))] });

describe('extractFilePaths / extractFileTargets', () => {
  it('resolves relative Bash paths against the hook cwd', () => {
    expect(extractFilePaths({ command: 'sed -i "s/a/b/" lib/a.mjs' }, { cwd: '/work/proj' })).toEqual([F]);
  });

  it('a cd prefix contributes its files, never the directory itself', () => {
    expect(extractFilePaths({ command: 'cd /work/proj && sed -i "s/a/b/" lib/a.mjs' })).toEqual([F]);
  });

  it('quoted absolute paths are recovered', () => {
    expect(extractFilePaths({ command: `sed -i 's/a/b/' "${F}"` })).toEqual([F]);
  });

  it('splits writes from reads', () => {
    expect(extractFileTargets({ command: 'cp lib/b.mjs lib/a.mjs' }, { cwd: '/work/proj' })).toEqual({
      files: [F, '/work/proj/lib/b.mjs'],
      writes: [F],
    });
  });

  it('drops session-scoped paths even from the direct field (R8)', () => {
    for (const p of [
      '/tmp/claude-1000/-home-u-proj/5b7c/scratchpad/review.md',
      '/home/u/.claude/projects/-home-u-proj/5b7c/tool-results/abc.txt',
      '/work/proj/node_modules/vitest/index.js',
    ]) {
      expect(isTransientPath(p)).toBe(true);
      expect(extractFilePaths({ file_path: p })).toEqual([]);
    }
    // A user's own /tmp edit is still real work (the direct-field rule this narrows).
    expect(extractFilePaths({ file_path: '/tmp/src/index.js' })).toEqual(['/tmp/src/index.js']);
  });

  it("drops the host's per-project state: built-in auto-memory and transcripts", () => {
    const mem = '/home/u/.claude/projects/-home-u-proj/memory/MEMORY.md';
    const note = '/home/u/.claude/projects/-home-u-proj/memory/project_discount_plan.md';
    const transcript = '/home/u/.claude/projects/-home-u-proj/1f2e.jsonl';
    for (const p of [mem, note, transcript]) {
      expect(isTransientPath(p)).toBe(true);
      expect(extractFilePaths({ file_path: p })).toEqual([]);
    }
    // The same write through Bash leaves no edge and no write either.
    expect(
      extractFileTargets({ command: `echo '- [Plan](p.md)' >> "${mem}"` }, { cwd: '/work/proj' }),
    ).toEqual({
      files: [],
      writes: [],
    });
    // A project that merely has a `projects/` or `memory/` directory is untouched.
    expect(isTransientPath('/work/app/projects/memory/store.mjs')).toBe(false);
    expect(isTransientPath('/work/app/.claude/settings.json')).toBe(false);
  });

  it('follows CLAUDE_CONFIG_DIR for the same host state', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/srv/cc-config';
    try {
      expect(isTransientPath('/srv/cc-config/projects/-work-app/memory/MEMORY.md')).toBe(true);
      expect(isTransientPath('/srv/cc-config/settings.json')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe('entryEditedFiles / isEditEntry', () => {
  it('a Bash entry edits exactly its bashWrites', () => {
    expect(entryEditedFiles(bashEdit([F, '/work/proj/lib/b.mjs'], [F]))).toEqual([F]);
    expect(isEditEntry(bashEdit())).toBe(true);
    expect(isEditEntry(bashRead())).toBe(false);
    expect(entryEditedFiles(bashRead())).toEqual([]);
    expect(isEditEntry(toolEdit())).toBe(true);
  });
});

describe('consumers treat a Bash edit like an Edit', () => {
  it('significance rule 1', () => {
    expect(explainSignificance(episode([bashEdit()]))).toMatchObject({ significant: true, rule: 1 });
    expect(explainSignificance(episode([toolEdit()]))).toMatchObject({ significant: true, rule: 1 });
    expect(explainSignificance(episode([bashRead()])).significant).toBe(false);
  });

  it('rule importance: error→edit and sensitive-file edits', () => {
    const err = { tool: 'Bash', desc: 'npm test', files: [], isError: true, bashSig: { isError: true } };
    const schemaEdit = (mk) => mk(['/work/proj/schema.mjs'], ['/work/proj/schema.mjs']);
    expect(
      computeRuleImportance(episode([bashEdit(...[['/work/proj/schema.mjs'], ['/work/proj/schema.mjs']])])),
    ).toBe(computeRuleImportance(episode([toolEdit(['/work/proj/schema.mjs'])])));
    expect(computeRuleImportance(episode([schemaEdit(bashEdit)]))).toBe(3);
    // Reading schema.mjs is not editing it (finding #7's rule, kept for Bash).
    expect(computeRuleImportance(episode([bashRead(['/work/proj/schema.mjs'])]))).toBeLessThan(3);
    expect(computeRuleImportance(episode([err, bashEdit()]))).toBe(
      computeRuleImportance(episode([err, toolEdit()])),
    );
  });

  it('an error followed by a Bash edit is a debug cycle', () => {
    const err = { tool: 'Bash', desc: 'node x.mjs', files: [], isError: true }; // no bashSig
    expect(computeRuleImportance(episode([err, bashEdit()]))).toBe(2);
    expect(computeRuleImportance(episode([err, bashRead()]))).toBe(1);
  });

  it('degraded title says Modified for a Bash edit, Worked on for a Bash read', () => {
    expect(buildDegradedTitle(episode([bashEdit()]))).toBe('Modified a.mjs');
    expect(buildDegradedTitle(episode([bashRead()]))).toBe('Worked on a.mjs');
  });

  it('cite-back hint fires for a Bash edit of a nudged file, not for a Bash read', () => {
    const cooldown = { [F]: { ts: 1, lessonIds: [42], obsIds: [42], mode: 'read' } };
    expect(buildCiteBackHint(episode([bashEdit()]), cooldown)).toContain('#42');
    expect(buildCiteBackHint(episode([bashRead()]), cooldown)).toBeNull();
  });

  it('unsaved-bugfix nudge counts Bash edits', () => {
    const err = { tool: 'Bash', desc: 'npm test', files: [], isError: true, isHardError: true };
    const hint = buildUnsavedBugfixHint(episode([err, bashRead(), bashEdit()]));
    expect(hint).toContain('a.mjs');
    expect(buildUnsavedBugfixHint(episode([err, bashRead(), bashRead()]))).toBeNull();
  });

  it('immediate observation files the written file as modified, the rest as read', () => {
    const obs = buildImmediateObservation(episode([bashEdit([F, '/work/proj/lib/b.mjs'], [F])]));
    expect(obs.type).toBe('change');
    expect(obs.files).toEqual([F]);
    expect(obs.filesRead).toEqual(['/work/proj/lib/b.mjs']);
  });
});
