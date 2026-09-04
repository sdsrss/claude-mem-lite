// Audit 2026-09-02 P1-9. Six hook processes read the host payload off stdin, six ways.
// Three were bounded at three different calibers; three were an unbounded
// `for await (const chunk of process.stdin) input += chunk` with no cap and no timeout.
//
// The unbounded three are the ones with a cost. `PreToolUse:Write` carries the ENTIRE file
// being written in `tool_input.content`, so `pre-tool-recall.js` buffered and `JSON.parse`d
// multiple megabytes in order to read `file_path`. The only bound was the host's own ~3 s
// fail-open, which from the outside is indistinguishable from the hook having nothing to say.
//
// Two things are asserted here and they are different claims:
//   1. the shared reader BEHAVES (cap, timeout, settle-once);
//   2. the five entry points that should use it DO, and the sixth deliberately does not.
// A behavioural test alone stays green while a caller keeps its private copy, which is the
// state this consolidation exists to end.
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'fs';
import { join } from 'path';
import { readHookStdin, DEFAULT_STDIN_MAX_BYTES, DEFAULT_STDIN_TIMEOUT_MS, TOOL_INPUT_FILE_MAX_BYTES, salvageTruncatedHookEvent } from '../lib/hook-stdin.mjs';
import { REPO, sourceWithoutComments } from './shipped-tree.mjs';

/** A stream that emits `chunks` then ends. */
const streamOf = (...chunks) => Readable.from(chunks);
/** A stream that emits nothing and never ends — the timeout case. */
const silentStream = () => new Readable({ read() { /* never pushes, never ends */ } });

describe('readHookStdin', () => {
  it('reads a whole payload', async () => {
    const r = await readHookStdin({ stream: streamOf('{"a":', '1}') });
    expect(r).toEqual({ text: '{"a":1}', truncated: false, timedOut: false });
  });

  it('truncates at maxBytes and says so', async () => {
    const r = await readHookStdin({ stream: streamOf('x'.repeat(50)), maxBytes: 10 });
    expect(r.text).toBe('x'.repeat(10));
    expect(r.truncated).toBe(true);
    // Premise: the input really was longer, so `truncated` is not true by default.
    expect(r.text.length).toBeLessThan(50);
  });

  it('does not mark an exactly-maxBytes payload as truncated', async () => {
    // Boundary. `>` vs `>=` here decides whether a payload that exactly fills the cap is
    // reported as clipped — and a caller that JSON.parses a "truncated" payload behaves
    // differently from one parsing a complete one.
    const r = await readHookStdin({ stream: streamOf('y'.repeat(10)), maxBytes: 10 });
    expect(r).toEqual({ text: 'y'.repeat(10), truncated: false, timedOut: false });
  });

  it('resolves with timedOut on timeout by default', async () => {
    const r = await readHookStdin({ stream: silentStream(), timeoutMs: 60 });
    expect(r).toEqual({ text: '', truncated: false, timedOut: true });
  });

  it('rejects on timeout when the caller asks for it', async () => {
    // hook.mjs's contract: a timeout drops the event rather than writing a partial tool
    // response into memory as if it were whole.
    await expect(readHookStdin({ stream: silentStream(), timeoutMs: 60, rejectOnTimeout: true }))
      .rejects.toThrow('timeout');
  });

  it('keeps what arrived before a timeout', async () => {
    const s = new Readable({ read() { /* pushed manually below */ } });
    setTimeout(() => s.push('partial'), 10);
    const r = await readHookStdin({ stream: s, timeoutMs: 80 });
    expect(r.text).toBe('partial');
    expect(r.timedOut).toBe(true);
  });

  it('settles exactly once when the cap is hit and the stream then errors', async () => {
    // The shape the six hand-written copies each had to get right on four separate paths
    // (cap, end, error, timer) — and `.destroy()` in the cap branch can itself emit
    // 'error', so settle() really is entered twice here.
    //
    // What this case asserts, and why it is NOT the promise: the v3.93.0 pre-tag review
    // deleted the `if (done) return; done = true;` guard and all 17 cases stayed green. A
    // native promise silently IGNORES a reject after it has resolved, so the resolved value
    // is identical with and without the guard — the old rationale ("an unhandled rejection
    // would crash a hook process") is factually wrong and the assertion it justified proved
    // nothing. The guard's observable effect is that TEARDOWN runs once, so that is what is
    // asserted: a spy on destroy.
    const s = new Readable({ read() { /* pushed below */ } });
    let destroys = 0;
    const realDestroy = s.destroy.bind(s);
    s.destroy = (...args) => { destroys++; return realDestroy(...args); };
    const p = readHookStdin({ stream: s, maxBytes: 4, timeoutMs: 500 });
    s.push('abcdefgh');
    setTimeout(() => s.emit('error', new Error('post-destroy noise')), 20);
    await expect(p).resolves.toEqual({ text: 'abcd', truncated: true, timedOut: false });
    await new Promise((r) => setTimeout(r, 60)); // let the late error fire into the void
    expect(destroys, 'settle() ran its teardown twice — the done guard is gone').toBe(1);
  });

  it('rejects on a stream error before anything settled', async () => {
    const s = new Readable({ read() { /* nothing */ } });
    setTimeout(() => s.emit('error', new Error('EPIPE')), 10);
    await expect(readHookStdin({ stream: s, timeoutMs: 500 })).rejects.toThrow('EPIPE');
  });

  it('the whole-file payload cap is sized to a file, not to a tool response', () => {
    // v3.93.0. The default 256 KB was applied to `PreToolUse:Write`, whose payload carries
    // the ENTIRE file in `tool_input.content` — this repo's own CHANGELOG.md is 1 MB, so a
    // Write to it truncated, failed to parse, and silently lost the recall on `pretool`.
    expect(TOOL_INPUT_FILE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(TOOL_INPUT_FILE_MAX_BYTES).toBeGreaterThan(DEFAULT_STDIN_MAX_BYTES);
  });


  describe('salvageTruncatedHookEvent', () => {
    // The other half of the fix: past the cap, recover rather than drop. Asserted on the
    // helper because it is where the rule lives. An earlier version of this comment said the
    // caller's use was "pinned by the source case above" — it was not; that case only pinned
    // `maxBytes`, and the review that found it deleted the salvage branch with every case
    // still green. The source case now asserts the call as well.
    const prefix = (obj, cut) => JSON.stringify(obj).slice(0, cut);

    it('recovers file_path, session_id and tool_name from a cut-off payload', () => {
      const full = { session_id: 's1', tool_name: 'Write', tool_input: { file_path: '/a/b.mjs', content: 'x'.repeat(5000) } };
      const got = salvageTruncatedHookEvent(prefix(full, 140));
      expect(got).toEqual({ filePath: '/a/b.mjs', sessionId: 's1', toolName: 'Write' });
    });

    it('un-escapes a JSON-escaped path rather than handing back the raw capture', () => {
      const got = salvageTruncatedHookEvent('{"tool_input":{"file_path":"C:\\\\x\\\\y.mjs","content":"zz');
      expect(got.filePath).toBe('C:\\x\\y.mjs');
    });

    it('returns null when the prefix stops before file_path — the caller then behaves as before', () => {
      // The bound on the whole change: salvage can only ADD recalls. If it cannot find the
      // field, the caller takes exactly the path it took when there was no salvage at all.
      const full = { tool_input: { content: 'x'.repeat(5000), file_path: '/a/b.mjs' } };
      expect(salvageTruncatedHookEvent(prefix(full, 60))).toBeNull();
      expect(salvageTruncatedHookEvent('')).toBeNull();
      expect(salvageTruncatedHookEvent('{"tool_input":{"file_path":""')).toBeNull();
    });

    it('reports the two optional scalars as null rather than inventing them', () => {
      const got = salvageTruncatedHookEvent('{"tool_input":{"file_path":"/a/b.mjs","content":"zz');
      expect(got).toEqual({ filePath: '/a/b.mjs', sessionId: null, toolName: null });
    });
  });

  it('defaults match the host tier they are documented against', () => {
    expect(DEFAULT_STDIN_MAX_BYTES).toBe(256 * 1024);
    expect(DEFAULT_STDIN_TIMEOUT_MS).toBe(3000);
  });
});

describe('every hook entry point reads stdin through the shared module', () => {
  // Comment-stripped, per tests/shipped-tree.mjs. Reading raw source here was a live
  // false-alarm: `lib/hook-stdin.mjs`'s own docblock quotes the banned unbounded idiom, and
  // this file's own fix note quotes `readHookStdin()` — a guard that fires on prose about
  // the rule instead of on the rule is worse than no guard, because the next person deletes
  // the prose to make it green.
  const read = (rel) => sourceWithoutComments(join(REPO, rel));
  // …and the raw text, for the ONE assertion whose subject IS a comment: the exemption has
  // to state its reason, so stripping comments there would assert the opposite of the point.
  const readRaw = (rel) => readFileSync(join(REPO, rel), 'utf8');

  // The three that were unbounded, plus the two that were bounded at their own calibers.
  const SHARED = [
    'hook.mjs',
    'scripts/user-prompt-search.js',
    'scripts/pre-tool-recall.js',
    'scripts/pre-skill-bridge.js',
    'scripts/post-tool-recall.js',
  ];

  it.each(['scripts/pre-tool-recall.js', 'scripts/post-tool-recall.js'])(
    '%s passes the whole-file cap rather than taking the default', (rel) => {
      // Both see the same payload class. A call with NO options takes 256 KB, which is the
      // regression this pins — and the shared constant is what stops the two drifting.
      const src = read(rel);
      expect(src).toMatch(/readHookStdin\(\{[^}]*maxBytes:\s*TOOL_INPUT_FILE_MAX_BYTES/);
      expect(src, 'a bare readHookStdin() here silently takes the 256 KB default')
        .not.toMatch(/readHookStdin\(\s*\)/);
      // And the OTHER half of the cap fix. Deleting the salvage branch at the caller left
      // 107 cases green across this file and pre-tool-recall's own (v3.93.0 post-release
      // review, C1) — the helper was well pinned and its wiring was not.
      if (rel === 'scripts/pre-tool-recall.js') {
        expect(src, 'the truncation salvage branch is gone from the caller')
          .toMatch(/salvageTruncatedHookEvent\(/);
      }
    });

  it.each(SHARED)('%s imports readHookStdin AND calls it, with no second reader', (rel) => {
    const src = read(rel);
    // The import alone is not the property. The v3.93.0 pre-tag review kept the import and
    // bypassed the call with an unbounded `process.stdin.on('data', …)` accumulator, and
    // every case in this file stayed green — the "rule bypassed by an alias" direction the
    // header names. The old assertion also never mentioned the symbol, so importing only
    // DEFAULT_STDIN_MAX_BYTES satisfied it.
    expect(src).toMatch(/from\s+'\.{1,2}\/lib\/hook-stdin\.mjs'/);
    // Keyed to the import STATEMENT, not to an 80-character budget. The budget version went
    // red on correct code: `scripts/pre-tool-recall.js` used 57 of its 80 characters, so
    // adding one more symbol to that import turned the guard red for a valid change — the
    // false-alarm direction this same batch fixed in workflow-hardening.
    expect(src).toMatch(/import\s*\{[^}]*\breadHookStdin\b[^}]*\}\s*from\s+'\.{1,2}\/lib\/hook-stdin\.mjs'/);
    expect(src).toMatch(/readHookStdin\(/);
    expect(src).not.toMatch(/process\.stdin\.on\s*\(/);
  });

  it('no entry point still accumulates stdin unbounded', () => {
    // The exact idiom that shipped three times. Checked across all six, including
    // pre-agent-inject.js, which keeps a hand-written reader but a BOUNDED one.
    const offenders = [...SHARED, 'scripts/pre-agent-inject.js'].filter(
      (rel) => /for\s+await\s*\([^)]*\bprocess\.stdin\b/.test(read(rel)),
    );
    expect(offenders).toEqual([]);
  });

  it('the bypass scans can say NO', () => {
    // Each new assertion above must be able to fire, or it is decoration.
    expect("  process.stdin.on('data', (c) => { input += c; });").toMatch(/process\.stdin\.on\s*\(/);
    expect("import { DEFAULT_STDIN_MAX_BYTES } from '../lib/hook-stdin.mjs';")
      .not.toMatch(/import\s*\{[^}]*\breadHookStdin\b[^}]*\}\s*from\s+'\.{1,2}\/lib\/hook-stdin\.mjs'/);
    // …and a long-but-correct import must still pass, which the 80-char version did not.
    expect("import { readHookStdin, TOOL_INPUT_FILE_MAX_BYTES, salvageTruncatedHookEvent, DEFAULT_STDIN_TIMEOUT_MS } from '../lib/hook-stdin.mjs';")
      .toMatch(/import\s*\{[^}]*\breadHookStdin\b[^}]*\}\s*from\s+'\.{1,2}\/lib\/hook-stdin\.mjs'/);
    expect('const x = 1;').not.toMatch(/salvageTruncatedHookEvent\(/);
    expect('const x = 1;').not.toMatch(/readHookStdin\(/);
  });

  it('the scan can say NO', () => {
    // `not.toMatch`-style assertions pass against a pattern that matches nothing. This is
    // the line that actually shipped in three files.
    expect('  for await (const chunk of process.stdin) input += chunk;')
      .toMatch(/for\s+await\s*\([^)]*\bprocess\.stdin\b/);
  });

  it('pre-agent-inject keeps its own reader, bounded, and says why', () => {
    // The one deliberate exception: it is the default-OFF path and reaches its stdin read
    // before importing anything, so even an import-free module is a cost it declines. The
    // exemption is only defensible while the reader is BOUNDED and the reason is written
    // down — both are asserted, so silently dropping either goes red.
    const src = readRaw('scripts/pre-agent-inject.js');
    expect(src).not.toMatch(/from\s+'\.{1,2}\/lib\/hook-stdin\.mjs'/);
    expect(src, 'the exempt copy must still cap').toMatch(/data\.length\s*>\s*262144/);
    expect(src, 'the exempt copy must still time out').toMatch(/\}, 1500\)/);
    expect(src, 'the exemption must state its reason').toMatch(/default-OFF path/);
  });
});
