// ④ instrument: subagent (sidechain) cite-recall — making the subagent memory
// channel observable.
//
// VERIFIED REALITY (drove this design): Claude Code writes each subagent's turns
// to a SEPARATE file — <session>/subagents/agent-*.jsonl — NOT inline in the parent
// transcript. Across 60 real parent transcripts there were 0 isSidechain records;
// the 158 subagent files carry isSidechain=true but — critically — contained ZERO
// claude-mem-lite hook injections (no pre-tool-recall / error-recall / memory-context).
// So thread is keyed by FILE LOCATION, and the live reading is "subagents get no
// memory injection at all." These tests cover the mechanism (so it lights up IF a
// future surface injects into subagents) + model the real all-zero case.
//
// Also locks the #8584 emit↔extractor coupling for the ② error-recall change.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  computeThreadCiteRecall,
  aggregateProjectCiteRecall,
  extractInjectedFromErrorRecall,
  extractInjectedFromPreToolUse,
} from '../lib/citation-tracker.mjs';
import { formatErrorRecallHints } from '../format-utils.mjs';
import { formatSubagentContext } from '../lib/task-imperative.mjs';

// pre-tool-recall injects `#NN [type]` lines via a hook_success attachment.
const inject = (...idTypes) => ({
  type: 'attachment',
  attachment: {
    type: 'hook_success',
    command: 'node /abs/scripts/pre-tool-recall.js',
    stdout: idTypes.map(([id, t]) => `  #${id} [${t}] title`).join('\n'),
  },
});
const cite = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const writeJsonl = (path, entries) => writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));

describe('computeThreadCiteRecall (per-file, precise hook-injection methodology)', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'thread-cite-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('counts injected ∩ cited over the whole file', () => {
    const p = join(tmp, 't.jsonl');
    writeJsonl(p, [inject([10, 'bugfix'], [20, 'decision']), cite('applied #10')]);
    const r = computeThreadCiteRecall(p);
    expect(r.injected).toBe(2);
    expect(r.recalled).toBe(1); // only 10 cited
    expect(r.ratio).toBe(0.5);
  });

  it('returns zeros for a missing transcript', () => {
    expect(computeThreadCiteRecall(join(tmp, 'nope.jsonl'))).toEqual({
      injected: 0,
      cited: 0,
      recalled: 0,
      ratio: 0,
    });
  });
});

describe('aggregateProjectCiteRecall — splits main vs sidechain by FILE LOCATION', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'agg-cite-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('top-level *.jsonl = main; <session>/subagents/agent-*.jsonl = sidechain', () => {
    writeJsonl(join(tmp, 'sessMain.jsonl'), [inject([10, 'bugfix']), cite('used #10')]);
    const subDir = join(tmp, 'sessX', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeJsonl(join(subDir, 'agent-abc.jsonl'), [inject([30, 'bugfix'], [40, 'decision']), cite('per #30')]);

    const { main, sidechain } = aggregateProjectCiteRecall(tmp, { cutoff: 0 });
    expect(main).toEqual({ injected: 1, recalled: 1, files: 1 });
    expect(sidechain.injected).toBe(2); // 30 + 40, the subagent file's injections
    expect(sidechain.recalled).toBe(1); // only 30 cited
    expect(sidechain.files).toBe(1);
    expect(sidechain.withInjections).toBe(1);
  });

  it('models the verified reality: subagent file with NO hook injection → sidechain injected 0', () => {
    const subDir = join(tmp, 'sessY', 'subagents');
    mkdirSync(subDir, { recursive: true });
    // subagent did work and even mentions a #NN, but received NO hook injection
    writeJsonl(join(subDir, 'agent-xyz.jsonl'), [cite('I think #99 is relevant')]);
    const { sidechain } = aggregateProjectCiteRecall(tmp, { cutoff: 0 });
    expect(sidechain.files).toBe(1);
    expect(sidechain.injected).toBe(0); // nothing was injected → nothing to recall
    expect(sidechain.withInjections).toBe(0);
  });

  it('returns an empty aggregate for a missing dir', () => {
    expect(aggregateProjectCiteRecall(join(tmp, 'nope'), { cutoff: 0 })).toEqual({
      main: { injected: 0, recalled: 0, files: 0 },
      sidechain: { injected: 0, recalled: 0, files: 0, withInjections: 0 },
    });
  });
});

// D#57: pre-agent-inject.js APPENDS formatSubagentContext to a dispatched subagent's
// task prompt (updatedInput) — NOT a hook attachment, so extractAllInjected (the
// attachment path) reads 0 and the sidechain instrument was falsely blind ("subagents
// memory-blind"). computeThreadCiteRecall must also detect the prompt-embedded marker.
// Uses the real formatSubagentContext so the extractor can't drift from the emitter.
describe('subagent prompt-embedded injection (D#57)', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'subagent-inj-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  const userPrompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });

  it('computeThreadCiteRecall counts the prompt-embedded formatSubagentContext #NN as injected', () => {
    const p = join(tmp, 'agent-x.jsonl');
    writeJsonl(p, [
      userPrompt('Do the task above.' + formatSubagentContext('recover children before delete', 8802)),
      cite('per #8802 I recovered referencing rows first'),
    ]);
    const r = computeThreadCiteRecall(p);
    expect(r.injected).toBe(1); // #8802 from the appended marker (was 0 before D#57)
    expect(r.recalled).toBe(1); // subagent cited it
  });

  it('anchors to the "#NN —" tag: a #NN quoted in the lesson body is NOT injected', () => {
    const p = join(tmp, 'agent-y.jsonl');
    writeJsonl(p, [
      userPrompt('Task.' + formatSubagentContext('same root cause as #9999 over there', 8802)),
      cite('done — see #9999'),
    ]);
    const r = computeThreadCiteRecall(p);
    expect(r.injected).toBe(1); // only #8802 (the tag), NOT #9999 (quoted in body)
    expect(r.recalled).toBe(0); // #8802 uncited; #9999 was never injected
  });

  it('aggregateProjectCiteRecall surfaces subagent injection instead of a false 0', () => {
    const subDir = join(tmp, 'sess1', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeJsonl(join(subDir, 'agent-z.jsonl'), [
      userPrompt('Review this.' + formatSubagentContext('use rrfMerge not naive union', 8703)),
      cite('applied #8703'),
    ]);
    const { sidechain } = aggregateProjectCiteRecall(tmp, { cutoff: 0 });
    expect(sidechain.injected).toBe(1);
    expect(sidechain.recalled).toBe(1);
    expect(sidechain.withInjections).toBe(1);
  });
});

describe('#8584 emit↔extractor coupling (② error-recall lesson inline)', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'coupling-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('extractInjectedFromErrorRecall recovers ids from the lesson-inlined emit', () => {
    const stdout = formatErrorRecallHints([
      { id: 4242, type: 'bugfix', title: 'Fixed X', lesson_learned: 'do the thing first' },
      { id: 4343, type: 'decision', title: 'Chose Y', lesson_learned: null },
    ]);
    const p = join(tmp, 't.jsonl');
    writeJsonl(p, [
      {
        type: 'attachment',
        attachment: { type: 'hook_success', command: 'bash /abs/scripts/post-tool-use.sh', stdout },
      },
    ]);
    const ids = extractInjectedFromErrorRecall(p);
    expect(ids.has(4242)).toBe(true); // top-1, lesson inlined
    expect(ids.has(4343)).toBe(true); // pointer row
  });
});

// Code-review (Important #1): once a lesson body is inlined into the emit, an obs
// cross-reference quoted inside that body must NOT be parsed as an injected row —
// else it enters the citation-decay denominator and falsely streak-demotes.
describe('anchored extraction — embedded #NN [type] in a lesson body is NOT injected', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'anchor-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('error-recall: a lesson body quoting #NN [type] does not pollute the injected set', () => {
    const stdout = formatErrorRecallHints([
      {
        id: 42,
        type: 'bugfix',
        title: 'Real row',
        lesson_learned: 'root cause was the same as #999 [decision]; see #888 [bugfix]',
      },
    ]);
    const p = join(tmp, 'e.jsonl');
    writeJsonl(p, [
      {
        type: 'attachment',
        attachment: { type: 'hook_success', command: 'bash /x/post-tool-use.sh', stdout },
      },
    ]);
    const ids = extractInjectedFromErrorRecall(p);
    expect(ids.has(42)).toBe(true); // the genuine injected row
    expect(ids.has(999)).toBe(false); // cross-ref embedded mid-line in the lesson body
    expect(ids.has(888)).toBe(false);
  });

  it('pre-tool-recall: same line-anchoring (lesson-body cross-ref excluded)', () => {
    const rows = ['Lessons for foo.mjs:', '  #7 [bugfix] title — body cites #1234 [decision]'].join('\n');
    const stdout = JSON.stringify({ hookSpecificOutput: { additionalContext: rows } });
    const p = join(tmp, 'p.jsonl');
    writeJsonl(p, [
      {
        type: 'attachment',
        attachment: { type: 'hook_success', command: 'node /x/scripts/pre-tool-recall.js', stdout },
      },
    ]);
    const ids = extractInjectedFromPreToolUse(p);
    expect(ids.has(7)).toBe(true);
    expect(ids.has(1234)).toBe(false);
  });
});
