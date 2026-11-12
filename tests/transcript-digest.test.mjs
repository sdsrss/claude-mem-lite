// Issue #53: Stop's transcript questions answered from the appended bytes only
// (lib/transcript-digest.mjs). The path scanners are the oracle: at every point a Stop could
// run, the digest's answers must equal theirs on the same file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  renameSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { digestTranscript, digestFileName, DIGEST_FILE_PREFIX } from '../lib/transcript-digest.mjs';
import {
  extractCitationsFromTranscript,
  extractInjectedBySurface,
  extractUserTypedIds,
  computeCiteRecall,
  citeRecallStats,
  hasMainThreadAssistantText,
  collectSubagentSurface,
  subagentSurfaceFrom,
} from '../lib/citation-tracker.mjs';
import { extractCiteBackSignals, countUnsavedBugfixShape, bugfixShapeStats } from '../lib/cite-back-hint.mjs';
import { countDeliberatePersistence } from '../lib/persist-reminder.mjs';
import { _resetTranscriptCache } from '../lib/transcript-scan.mjs';

const att = (command, stdout, extra = {}) => ({
  type: 'attachment',
  attachment: { type: 'hook_success', command, stdout },
  ...extra,
});
const say = (text, extra = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  ...extra,
});
const tool = (name, input) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
});
const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });

// Every accumulator gets something to count; the premise test below holds each to that.
const MAIN_RECORDS = [
  user('look at #111 first'),
  att('node "/x/scripts/pre-tool-recall.js"', '[mem] Lessons for a.mjs:\n  #101 [bugfix] boundary\n'),
  att(
    'node "/x/hook.mjs" user-prompt',
    '<memory-context relevance="high">\n- [decision] X | Lesson: Y (#202)\n</memory-context>\n',
  ),
  att(
    'bash "/x/scripts/post-tool-use.sh"',
    '[claude-mem-lite] Related memories found for this error:\n  #303 [bugfix] EPIPE\n',
  ),
  att(
    'node "/x/scripts/user-prompt-search.js"',
    '[mem] FYI — Related memories (continue):\n#404 🔴 reopened\n',
  ),
  att('node "/x/scripts/pre-tool-recall.js"', '  #505 [lesson] sidechain only\n', { isSidechain: true }),
  att('bash "/x/scripts/post-tool-use.sh"', '[mem] ⚠ Cite-back: you edited a.mjs — #606 warned about it'),
  att('bash "/x/scripts/post-tool-use.sh"', '[mem] ⚠ Unsaved bugfix-shape: error+edit across 1 file(s)'),
  user([{ type: 'tool_result', content: 'output names #707 here' }]),
  say('applying #101, and #202 n/a — not this path'),
  say('a subagent wrote #303', { isSidechain: true }),
  tool('mcp__plugin_claude-mem-lite_mem-lite__mem_save', { type: 'bugfix', title: 't' }),
  tool('Bash', { command: 'node cli.mjs defer add "x"' }),
  say('Done: shipped #404.'),
];

const SUB_RECORDS = [
  user(
    "Context surfaced by your operator's claude-mem-lite:\n  #801 — lesson one\n  #802 — lesson two\ndo the task",
    { isSidechain: true },
  ),
  say('used #801', { isSidechain: true }),
];

const lines = (records) => records.map((r) => JSON.stringify(r) + '\n').join('');

/** Every Stop question, asked the old way: one path scan each. */
function oracle(path) {
  _resetTranscriptCache();
  return {
    cited: extractCitationsFromTranscript(path),
    citedMain: extractCitationsFromTranscript(path, { mainOnly: true }),
    citedMainAnswered: extractCitationsFromTranscript(path, { mainOnly: true, includeDismissed: true }),
    injected: extractInjectedBySurface(path),
    injectedMain: extractInjectedBySurface(path, { mainOnly: true }),
    userTyped: extractUserTypedIds(path),
    citeBack: extractCiteBackSignals(path),
    citeRecall: computeCiteRecall(path),
    bugfixShape: countUnsavedBugfixShape(path),
    mainText: hasMainThreadAssistantText(path),
    persistence: countDeliberatePersistence(path),
    subagent: collectSubagentSurface(path),
  };
}

/** The same questions, asked of a digest. */
function answers(digest) {
  const d = digest.main;
  return {
    cited: d.cited,
    citedMain: d.citedMain,
    citedMainAnswered: d.citedMainAnswered,
    injected: d.injected,
    injectedMain: d.injectedMain,
    userTyped: d.userTyped,
    citeBack: d.citeBack,
    citeRecall: citeRecallStats(d.citeRecall),
    bugfixShape: bugfixShapeStats(d.bugfixShape),
    mainText: d.mainText.seen,
    persistence: d.persistence.count,
    subagent: subagentSurfaceFrom(digest.subagents),
  };
}

describe('digestTranscript', () => {
  let dir;
  let runtimeDir;
  let path;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mem-digest-'));
    runtimeDir = join(dir, 'runtime');
    mkdirSync(runtimeDir);
    path = join(dir, 'sess.jsonl');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('premise: the fixture gives every question a non-empty answer', () => {
    writeFileSync(path, lines(MAIN_RECORDS));
    mkdirSync(join(dir, 'sess', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'sess', 'subagents', 'agent-a.jsonl'), lines(SUB_RECORDS));
    const o = oracle(path);
    for (const k of ['cited', 'citedMain', 'citedMainAnswered', 'userTyped', 'citeBack']) {
      expect(o[k].size, k).toBeGreaterThan(0);
    }
    for (const k of ['injected', 'injectedMain']) {
      for (const face of ['pretool', 'ups', 'error_recall', 'fyi'])
        expect(o[k][face].size, `${k}.${face}`).toBeGreaterThan(0);
    }
    expect(o.injected.pretool).not.toEqual(o.injectedMain.pretool); // the sidechain record splits them
    expect(o.cited).not.toEqual(o.citedMain);
    expect(o.citedMain).not.toEqual(o.citedMainAnswered);
    expect(o.citeRecall.injected).toBeGreaterThan(0);
    expect(o.citeRecall.cited).toBeGreaterThan(0);
    expect(o.bugfixShape).toEqual({ nudged: 1, saved: 1, unsaved: 0 });
    expect(o.mainText).toBe(true);
    expect(o.persistence).toBe(2);
    expect(o.subagent).toEqual({ injected: new Set([801, 802]), cited: new Set([801]), files: 1 });
  });

  it('equals the path scans after every append, at every byte a Stop could see', () => {
    const text = lines(MAIN_RECORDS);
    const subDir = join(dir, 'sess', 'subagents');
    mkdirSync(subDir, { recursive: true });
    const subPath = join(subDir, 'agent-a.jsonl');
    const subText = lines(SUB_RECORDS);
    writeFileSync(path, '');
    writeFileSync(subPath, '');
    // Cut points inside lines as well as at their ends: a Stop can run while a record is half written.
    let prev = 0;
    let subPrev = 0;
    let stops = 0;
    for (let cut = 1; cut <= text.length; cut += 37) {
      appendFileSync(path, text.slice(prev, cut));
      prev = cut;
      const subCut = Math.min(subText.length, Math.round((cut / text.length) * subText.length));
      appendFileSync(subPath, subText.slice(subPrev, subCut));
      subPrev = subCut;
      const digest = digestTranscript(path, { runtimeDir });
      expect(digest.complete).toBe(true);
      expect(answers(digest), `cut ${cut}`).toEqual(oracle(path));
      stops++;
    }
    appendFileSync(path, text.slice(prev));
    appendFileSync(subPath, subText.slice(subPrev));
    expect(answers(digestTranscript(path, { runtimeDir }))).toEqual(oracle(path));
    expect(stops, 'premise: many Stops over one growing file').toBeGreaterThan(20);
  });

  it('reads only what was appended: a state file whose answers were planted is extended, not re-read', () => {
    writeFileSync(path, lines([say('first #11')]));
    digestTranscript(path, { runtimeDir });
    const statePath = join(runtimeDir, digestFileName(path));
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.files.main.acc.cited = { $set: [11, 999] }; // 999 is in no record: only the state carries it
    writeFileSync(statePath, JSON.stringify(state));
    appendFileSync(path, lines([say('second #22')]));
    expect([...digestTranscript(path, { runtimeDir }).main.cited].sort()).toEqual([11, 22, 999]);
  });

  it('a transcript larger than the budget is caught up over several calls, complete only at the end', () => {
    const records = [];
    for (let i = 1; i <= 40; i++) records.push(say(`turn ${i} cites #${i}`));
    writeFileSync(path, lines(records));
    const size = statSync(path).size;
    const maxBytes = 300;
    let calls = 0;
    let digest;
    do {
      digest = digestTranscript(path, { runtimeDir, maxBytes });
      calls++;
      expect(calls).toBeLessThan(100);
    } while (!digest.complete);
    expect(calls, 'premise: the budget split the read').toBeGreaterThanOrEqual(
      Math.floor(size / (maxBytes + 60)),
    );
    expect(answers(digest)).toEqual(oracle(path));
  });

  it('an incomplete call reports complete: false', () => {
    writeFileSync(path, lines([say('a #1'), say('b #2'), say('c #3')]));
    const first = digestTranscript(path, { runtimeDir, maxBytes: 10 });
    expect(first.complete).toBe(false);
    expect([...first.main.cited]).toEqual([1]); // one whole line, never a part of one
  });

  it('a budget spent on the main file leaves a subagent file for the next call', () => {
    writeFileSync(path, lines([say('main #1')]));
    mkdirSync(join(dir, 'sess', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'sess', 'subagents', 'agent-a.jsonl'), lines(SUB_RECORDS));
    const first = digestTranscript(path, { runtimeDir, maxBytes: 10 });
    expect(first.complete).toBe(false);
    const second = digestTranscript(path, { runtimeDir });
    expect(second.complete).toBe(true);
    expect(answers(second)).toEqual(oracle(path));
  });

  it('a half-written last line is read once, when whole', () => {
    const bug = JSON.stringify(att('bash "/x/p.sh"', '[mem] ⚠ Unsaved bugfix-shape: 1'));
    writeFileSync(path, bug.slice(0, 20));
    expect(digestTranscript(path, { runtimeDir }).main.bugfixShape.nudged).toBe(0);
    appendFileSync(path, bug.slice(20) + '\n');
    expect(digestTranscript(path, { runtimeDir }).main.bugfixShape.nudged).toBe(1);
    expect(digestTranscript(path, { runtimeDir }).main.bugfixShape.nudged).toBe(1);
  });

  it('a whole last line without its newline is counted once, and not again when the newline comes', () => {
    const bug = JSON.stringify(att('bash "/x/p.sh"', '[mem] ⚠ Unsaved bugfix-shape: 1'));
    writeFileSync(path, bug);
    expect(digestTranscript(path, { runtimeDir }).main.bugfixShape.nudged).toBe(1);
    appendFileSync(path, '\n' + bug + '\n');
    expect(digestTranscript(path, { runtimeDir }).main.bugfixShape.nudged).toBe(2);
    expect(oracle(path).bugfixShape.nudged).toBe(2);
  });

  it('a line longer than one read chunk is read whole', () => {
    const big = say(`${'x'.repeat(5 * 1024 * 1024)} cites #77`);
    writeFileSync(path, lines([say('a #1'), big, say('b #2')]));
    expect([...digestTranscript(path, { runtimeDir }).main.cited].sort((a, b) => a - b)).toEqual([1, 2, 77]);
  });

  describe('a state that no longer describes the file is dropped and the file read again', () => {
    beforeEach(() => {
      writeFileSync(path, lines([say('old #1'), say('old #2'), say('old #3')]));
      digestTranscript(path, { runtimeDir });
    });

    it('the file was truncated', () => {
      writeFileSync(path, lines([say('new #4')]));
      expect(answers(digestTranscript(path, { runtimeDir }))).toEqual(oracle(path));
    });

    it('the file was rewritten in place to a longer one with a different head', () => {
      writeFileSync(path, lines([say('NEW #5'), say('old #2'), say('old #3'), say('more #6')]));
      expect(answers(digestTranscript(path, { runtimeDir }))).toEqual(oracle(path));
    });

    it('the bytes before the saved offset changed', () => {
      writeFileSync(path, lines([say('old #1'), say('old #2'), say('OLD #7'), say('more #8')]));
      expect(answers(digestTranscript(path, { runtimeDir }))).toEqual(oracle(path));
    });

    it('another file was renamed over the path', () => {
      const other = join(dir, 'other.jsonl');
      writeFileSync(other, lines([say('old #1'), say('old #2'), say('old #3'), say('more #9')]));
      renameSync(other, path);
      const digest = digestTranscript(path, { runtimeDir });
      expect(answers(digest)).toEqual(oracle(path));
    });

    it('the state was written by other code', () => {
      const statePath = join(runtimeDir, digestFileName(path));
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state.code = 'other';
      state.files.main.acc.cited = { $set: [999] };
      writeFileSync(statePath, JSON.stringify(state));
      appendFileSync(path, lines([say('more #10')]));
      expect([...digestTranscript(path, { runtimeDir }).main.cited].sort((a, b) => a - b)).toEqual([
        1, 2, 3, 10,
      ]);
    });

    it('the state file does not parse', () => {
      writeFileSync(join(runtimeDir, digestFileName(path)), '{not json');
      appendFileSync(path, lines([say('more #11')]));
      expect(answers(digestTranscript(path, { runtimeDir }))).toEqual(oracle(path));
    });
  });

  // Files past both 4 KiB probe windows, so each check is the only one that can see the change.
  describe('on a file longer than the two probe windows', () => {
    const pad = (c) => say(c.repeat(5000));

    it('a head rewritten in place is seen by the head probe alone', () => {
      writeFileSync(path, lines([say(`#1 ${'h'.repeat(5000)}`), pad('m'), pad('t')]));
      digestTranscript(path, { runtimeDir });
      writeFileSync(path, lines([say(`#3 ${'h'.repeat(5000)}`), pad('m'), pad('t'), say('more #4')]));
      expect([...digestTranscript(path, { runtimeDir }).main.cited].sort()).toEqual([3, 4]);
    });

    it('the bytes before the saved offset rewritten in place are seen by the tail probe alone', () => {
      writeFileSync(path, lines([pad('h'), pad('m'), say('end #1')]));
      digestTranscript(path, { runtimeDir });
      writeFileSync(path, lines([pad('h'), pad('m'), say('end #6'), say('more #7')]));
      expect([...digestTranscript(path, { runtimeDir }).main.cited].sort()).toEqual([6, 7]);
    });

    it('a file renamed over the path with the same head and tail is seen by the inode', () => {
      writeFileSync(path, lines([pad('h'), say('mid #1'), pad('t')]));
      digestTranscript(path, { runtimeDir });
      const other = join(dir, 'other.jsonl');
      writeFileSync(other, lines([pad('h'), say('mid #2'), pad('t'), say('more #5')]));
      renameSync(other, path);
      expect([...digestTranscript(path, { runtimeDir }).main.cited].sort()).toEqual([2, 5]);
    });
  });

  it('a missing transcript has empty answers, as the path scans do', () => {
    const digest = digestTranscript(join(dir, 'none.jsonl'), { runtimeDir });
    expect(digest.complete).toBe(true);
    expect(answers(digest)).toEqual(oracle(join(dir, 'none.jsonl')));
  });

  it('a directory at the path has empty answers', () => {
    mkdirSync(join(dir, 'd.jsonl'));
    expect(answers(digestTranscript(join(dir, 'd.jsonl'), { runtimeDir }))).toEqual(
      oracle(join(dir, 'd.jsonl')),
    );
  });

  it('keeps one owner-only state file per transcript in the runtime dir, under its prefix', () => {
    writeFileSync(path, lines([say('a #1')]));
    digestTranscript(path, { runtimeDir });
    digestTranscript(path, { runtimeDir });
    const names = readdirSync(runtimeDir);
    expect(names).toEqual([digestFileName(path)]);
    expect(names[0].startsWith(DIGEST_FILE_PREFIX)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(runtimeDir, names[0])).mode & 0o777).toBe(0o600);
  });

  it('without a runtime dir it reads the whole file every time and keeps nothing', () => {
    writeFileSync(path, lines([say('a #1')]));
    expect([...digestTranscript(path).main.cited]).toEqual([1]);
    expect(readdirSync(runtimeDir)).toEqual([]);
  });
});
