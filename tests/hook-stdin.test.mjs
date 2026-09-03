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
import { readHookStdin, DEFAULT_STDIN_MAX_BYTES, DEFAULT_STDIN_TIMEOUT_MS } from '../lib/hook-stdin.mjs';
import { REPO } from './shipped-tree.mjs';

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
    // 'error', so "resolve then reject" was reachable. An unhandled rejection here would
    // crash a hook process the host is waiting on.
    const s = new Readable({ read() { /* pushed below */ } });
    const p = readHookStdin({ stream: s, maxBytes: 4, timeoutMs: 500 });
    s.push('abcdefgh');
    setTimeout(() => s.emit('error', new Error('post-destroy noise')), 20);
    await expect(p).resolves.toEqual({ text: 'abcd', truncated: true, timedOut: false });
    await new Promise((r) => setTimeout(r, 60)); // let the late error fire into the void
  });

  it('rejects on a stream error before anything settled', async () => {
    const s = new Readable({ read() { /* nothing */ } });
    setTimeout(() => s.emit('error', new Error('EPIPE')), 10);
    await expect(readHookStdin({ stream: s, timeoutMs: 500 })).rejects.toThrow('EPIPE');
  });

  it('defaults match the host tier they are documented against', () => {
    expect(DEFAULT_STDIN_MAX_BYTES).toBe(256 * 1024);
    expect(DEFAULT_STDIN_TIMEOUT_MS).toBe(3000);
  });
});

describe('every hook entry point reads stdin through the shared module', () => {
  const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

  // The three that were unbounded, plus the two that were bounded at their own calibers.
  const SHARED = [
    'hook.mjs',
    'scripts/user-prompt-search.js',
    'scripts/pre-tool-recall.js',
    'scripts/pre-skill-bridge.js',
    'scripts/post-tool-recall.js',
  ];

  it.each(SHARED)('%s imports readHookStdin', (rel) => {
    expect(read(rel)).toMatch(/from\s+'\.{1,2}\/lib\/hook-stdin\.mjs'/);
  });

  it('no entry point still accumulates stdin unbounded', () => {
    // The exact idiom that shipped three times. Checked across all six, including
    // pre-agent-inject.js, which keeps a hand-written reader but a BOUNDED one.
    const offenders = [...SHARED, 'scripts/pre-agent-inject.js'].filter(
      (rel) => /for\s+await\s*\([^)]*\bprocess\.stdin\b/.test(read(rel)),
    );
    expect(offenders).toEqual([]);
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
    const src = read('scripts/pre-agent-inject.js');
    expect(src).not.toMatch(/from\s+'\.{1,2}\/lib\/hook-stdin\.mjs'/);
    expect(src, 'the exempt copy must still cap').toMatch(/data\.length\s*>\s*262144/);
    expect(src, 'the exempt copy must still time out').toMatch(/\}, 1500\)/);
    expect(src, 'the exemption must state its reason').toMatch(/default-OFF path/);
  });
});
