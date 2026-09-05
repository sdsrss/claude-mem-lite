// Regression pin for audit 2026-09-05 R7 P1-1 (docs/audits/20260905-225651.md).
//
// `extractInjectedFromSubagentPrompt` walked EVERY transcript entry, filtering only on the
// marker text + a row anchor — no `entry.type` gate. So a subagent that merely QUOTED the
// injection block in its own assistant text had those `#NN` counted as injected; and because
// `collectSubagentSurface` takes a per-file `seen ∩ said` intersection, the same quotation
// landed in the cited set too. The id then reads 100% cite-rate off one self-reference.
//
// The sibling face defends the identical shape deliberately: SURFACE_MATCHERS.task_imperative
// gates on the COMMAND as well as the framing, with the reason spelled out in its docblock —
// "a transcript that merely quotes the framing — a review of this code, say — is not counted
// as an injection". This face had no equivalent.
//
// Three downstream consumers made it more than a metering error:
//   1. hook.mjs:1250 uses `sub.injected.size > 0` as a citation-decay ENTRY gate (with
//      CLAUDE_MEM_SUBAGENT_DECAY defaulting on), so a phantom id starts a decay pass that
//      writes cited_count / uncited_streak / demoted_at on a session with no real injection.
//   2. hook.mjs:1184 feeds `sub.injected` into buildCitationRelevanceSet, which is the
//      allow-list for bumpCitationAccess → access_count → the `boost` maintain op → importance.
//   3. citation_surface_log's `subagent` face rate is the number D#164/D#177 were decided on.
//
// Aggravating, and the reason the gate value had to be MEASURED rather than assumed: the
// reader runs unconditionally (hook.mjs:1166) while the writer is default-off
// (CLAUDE_MEM_SUBAGENT_INJECT, scripts/pre-agent-inject.js:16), so on a default install every
// id this extractor finds is a false positive by construction.
//
// GATE VALUE, MEASURED (2026-09-05, 11 real subagent transcripts under ~/.claude/projects):
// the dispatched task prompt — the thing pre-agent-inject.js appends to — is the FIRST entry
// of each subagent file and carries `type='user'`, `role='user'`, `isSidechain=true`. Entry
// types present across the corpus: assistant ×1036, attachment ×973, user ×668. Gating on
// 'user' therefore keeps the real injection and excludes the 2009 entries that could quote it.
// Guessing here would have been a coin flip between 100% false positives and 100% false
// negatives, which is why the report blocked the fix on this measurement.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractInjectedFromSubagentPrompt,
  collectSubagentSurface,
  computeThreadCiteRecall,
} from '../lib/citation-tracker.mjs';

// Verbatim shape emitted by scripts/pre-agent-inject.js (formatSubagentContext): a header
// line carrying the marker, then one `  #NN — <lesson>` row per surfaced observation.
const BLOCK = [
  "[Project memory — surfaced by your operator's claude-mem-lite plugin]",
  '  #9001 — SQL LIMIT upstream of a JS filter is a reachability bound.',
].join('\n');

let ROOT;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-audit-r7-cite-'));
});

afterAll(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

/** Write a subagent transcript from raw entry objects; returns the MAIN transcript path. */
function makeSession(name, entries) {
  const main = join(ROOT, `${name}.jsonl`);
  writeFileSync(main, '');
  const subDir = join(ROOT, name, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(
    join(subDir, 'agent-x-0000000000000000.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  return { main, sub: join(subDir, 'agent-x-0000000000000000.jsonl') };
}

const userEntry = (text) => ({
  type: 'user',
  isSidechain: true,
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const assistantEntry = (text) => ({
  type: 'assistant',
  isSidechain: true,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

describe('R7 P1-1 — subagent injection extractor gates on entry type', () => {
  it('PREMISE: a real injection (task prompt, type=user) is still extracted', () => {
    const { sub } = makeSession('premise', [userEntry(`Do the thing.\n\n${BLOCK}`)]);
    expect([...extractInjectedFromSubagentPrompt(sub)]).toEqual([9001]);
  });

  it('an assistant turn that QUOTES the block is not an injection', () => {
    const { sub } = makeSession('quote', [
      assistantEntry(`I reviewed the injector. It emits:\n\n${BLOCK}\n\nThat is the shape.`),
    ]);
    expect([...extractInjectedFromSubagentPrompt(sub)]).toEqual([]);
  });

  it('a quoting assistant turn cannot self-credit through collectSubagentSurface', () => {
    // Same text in one entry is both "seen" and "said" under the old code, so the per-file
    // seen ∩ said intersection promoted the id to cited on zero real evidence.
    const { main } = makeSession('selfcite', [
      assistantEntry(`Here is what gets injected:\n\n${BLOCK}\n\nNote #9001 above.`),
    ]);
    const s = collectSubagentSurface(main);
    expect([...s.injected]).toEqual([]);
    expect([...s.cited]).toEqual([]);
    expect(s.files).toBe(1);
  });

  it('PREMISE: a genuinely injected id the subagent cites is still credited', () => {
    const { main } = makeSession('credited', [
      userEntry(`Do the thing.\n\n${BLOCK}`),
      assistantEntry('Applying #9001 — the limit is a reachability bound, so I widened it.'),
    ]);
    const s = collectSubagentSurface(main);
    expect([...s.injected]).toEqual([9001]);
    expect([...s.cited]).toEqual([9001]);
  });

  // computeThreadCiteRecall folds this extractor over the MAIN transcript too, on the
  // stated assumption that "on a main transcript this marker is absent → no-op". That is an
  // assumption about content, not a guarantee — a main-thread turn discussing the injector
  // (this session, for one) carries the marker. The gate has to hold on that path as well,
  // or the ruler's own denominator inflates whenever someone reviews this code.
  it('the main-transcript fold is gated too (computeThreadCiteRecall)', () => {
    const main = join(ROOT, 'mainquote.jsonl');
    writeFileSync(
      main,
      JSON.stringify(assistantEntry(`The injector emits:\n\n${BLOCK}\n\nSee #9001.`)) + '\n',
    );
    // Nothing was injected on this thread, so nothing may enter the denominator.
    expect(computeThreadCiteRecall(main).injected).toBe(0);
  });

  it('COUNTER-CASE: tool output echoed inside a user turn is not an injection', () => {
    // A subagent that cats a file containing the marker produces a tool_result block. Those
    // carry `content`, not `text`, so they must contribute nothing even though the entry
    // type is 'user' — the same reasoning extractUserTypedIds states for its own scan.
    const { sub } = makeSession('toolout', [
      {
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: [{ type: 'tool_result', content: BLOCK }] },
      },
    ]);
    expect([...extractInjectedFromSubagentPrompt(sub)]).toEqual([]);
  });
});
