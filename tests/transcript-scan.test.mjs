// Audit 2026-08-22 P2-8: handleStop scanned one transcript eight times, each scan doing
// its own read + JSON.parse per line (~25ms per pass on a real 5.7MB transcript; 166ms
// for the eight, against a 5s budget, growing with the session). They now share one
// parse: 30ms for the same eight, measured on the same file.
//
// Caching a file that another process is still appending to is where this goes wrong, so
// the cases below are about freshness and about the retention cap — not about speed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readTranscriptEntries, _resetTranscriptCache, TRANSCRIPT_CACHE_MAX_BYTES, transcriptCacheBudgetBytes, TRANSCRIPT_ENTRY_HEAP_FACTOR } from '../lib/transcript-scan.mjs';

let dir, tx;

// Whole seconds only. The two cache-HIT cases below need a size+mtime pair that survives
// a rewrite unchanged, and utimes cannot portably round-trip an arbitrary sub-millisecond
// mtime — see the comment in the first of them.
const PINNED_MTIME_SEC = 1_700_000_000;

const line = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tx-scan-'));
  tx = join(dir, 'session.jsonl');
  _resetTranscriptCache();
});
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });

describe('readTranscriptEntries', () => {
  it('parses one record per non-empty line and drops the unparsable ones', () => {
    // A transcript being appended to right now can end in half a line.
    writeFileSync(tx, `${line('one')}\n\n${line('two')}\n{"type":"assistant","mess`);
    const entries = readTranscriptEntries(tx);
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.message.content[0].text)).toEqual(['one', 'two']);
  });

  it('returns an empty array for a missing path rather than throwing', () => {
    expect(readTranscriptEntries(join(dir, 'nope.jsonl'))).toEqual([]);
    expect(readTranscriptEntries(null)).toEqual([]);
    expect(readTranscriptEntries(undefined)).toEqual([]);
  });

  it('re-reads when the file grows — Claude Code is still writing during Stop', () => {
    writeFileSync(tx, `${line('first')}\n`);
    expect(readTranscriptEntries(tx).length).toBe(1);
    writeFileSync(tx, `${line('first')}\n${line('second')}\n`);
    const after = readTranscriptEntries(tx);
    expect(after.length, 'a later scanner in the same Stop saw stale content').toBe(2);
    expect(after[1].message.content[0].text).toBe('second');
  });

  it('re-reads when the content changed but the size did not', () => {
    // Growth alone is caught by size, so a key of path+size looks sufficient — and it
    // passes the growth case above while silently serving stale entries for an in-place
    // rewrite (a truncation or compaction that lands on the same byte count). mtime is
    // what separates those, so it has to be in the key and has to be exercised.
    writeFileSync(tx, `${line('before')}\n`);
    const first = readTranscriptEntries(tx);
    expect(first[0].message.content[0].text).toBe('before');
    const sizeBefore = statSync(tx).size;
    writeFileSync(tx, `${line('affter')}\n`);   // same length, different bytes
    expect(statSync(tx).size).toBe(sizeBefore);
    expect(readTranscriptEntries(tx)[0].message.content[0].text).toBe('affter');
  });

  it('serves the same parse to repeated callers — that is the whole point', () => {
    writeFileSync(tx, `${line('cached')}\n`);
    // Pin the mtime to a WHOLE SECOND before taking the baseline, rather than capturing
    // whatever the write produced and restoring it after. The key holds mtimeMs, and a
    // captured sub-millisecond value does not round-trip through utimes portably: CI
    // returned 1787406755453.47 for a value written as 1787406755453.4705, so the key
    // changed and this case failed on a filesystem difference rather than on the cache.
    // A whole second is exactly representable everywhere.
    utimesSync(tx, PINNED_MTIME_SEC, PINNED_MTIME_SEC);
    const first = readTranscriptEntries(tx);
    // Rewrite the CONTENT while pinning size and mtime, so nothing in the cache key
    // changes. Only a real cache can return the old parse here; a re-reader returns the
    // new text and this case fails.
    const st = statSync(tx);
    writeFileSync(tx, `${line('rewrit')}\n`);
    utimesSync(tx, PINNED_MTIME_SEC, PINNED_MTIME_SEC);
    expect(statSync(tx).size, 'the rewrite must keep the size identical').toBe(st.size);
    expect(statSync(tx).mtimeMs, 'the pinned mtime must survive the rewrite').toBe(st.mtimeMs);
    const second = readTranscriptEntries(tx);
    expect(second).toBe(first);
    expect(second[0].message.content[0].text).toBe('cached');
  });

  it('does not retain a transcript larger than the budget', () => {
    // Parsed entries cost ~3.45× the file in heap; holding that for a very large
    // transcript risks the hook being OOM-killed, which loses the session's work. Over
    // the budget each caller parses for itself, exactly as before this change.
    //
    // The budget is passed explicitly. It used to be the bare 24MB constant, and this case
    // wrote a 25MB fixture to clear it; P2-12 made the budget heap-derived (~256MB on an
    // ordinary Node), so a fixture that clears it for real is no longer writable. The seam
    // keeps the DECLINE branch exercised — the alternative was to assert the budget's value
    // and leave the branch it feeds untested.
    const CAP = 64 * 1024;
    const padding = 'x'.repeat(4096);
    const one = `${line(padding)}\n`;
    const repeats = Math.ceil((CAP + 4096) / one.length);
    writeFileSync(tx, one.repeat(repeats));
    expect(statSync(tx).size).toBeGreaterThan(CAP);

    utimesSync(tx, PINNED_MTIME_SEC, PINNED_MTIME_SEC);
    const first = readTranscriptEntries(tx, { maxBytes: CAP });
    const st = statSync(tx);
    // Same pinned-key rewrite as above: an oversized file must come back FRESH.
    writeFileSync(tx, `${line('x'.repeat(padding.length - 6) + 'CHANGED')}\n`.padEnd(st.size, ' '));
    utimesSync(tx, PINNED_MTIME_SEC, PINNED_MTIME_SEC);
    const second = readTranscriptEntries(tx, { maxBytes: CAP });
    expect(second).not.toBe(first);
    expect(JSON.stringify(second).includes('CHANGED')).toBe(true);
  });

  it('two callers with different budgets do not read each other cached entries', () => {
    // The budget is in the cache KEY, not only in the decision. Without that, a caller
    // passing a small budget would be served the array a default-budget caller retained —
    // the decline it asked for would silently not happen.
    writeFileSync(tx, `${line('shared')}\n`);
    utimesSync(tx, PINNED_MTIME_SEC, PINNED_MTIME_SEC);
    const wide = readTranscriptEntries(tx);
    const narrow = readTranscriptEntries(tx, { maxBytes: 1 });
    expect(narrow).not.toBe(wide);
    expect(narrow[0].message.content[0].text).toBe('shared');
  });
});

// P2-12. The cap used to be a bare 24MB constant, so above it `handleStop` — which asks
// this module twelve questions — degraded to twelve full parses at exactly the size where
// one parse is already expensive. What the constant is protecting is the heap, so it is now
// derived from the heap.
describe('transcriptCacheBudgetBytes', () => {
  it('scales with the heap limit and applies the measured 3.45x entry cost', () => {
    // 4GB is the ordinary 64-bit Node limit: a quarter of it, divided by the entry factor,
    // lands above the 256MB ceiling, so the ceiling is what binds.
    expect(transcriptCacheBudgetBytes(4 * 1024 ** 3)).toBe(256 * 1024 * 1024);
    // 1GB limit: 256MB of heap / 3.45 ≈ 74MB of transcript — under the ceiling, so the
    // heap share is what binds, and the number is a computation rather than a constant.
    const oneGb = transcriptCacheBudgetBytes(1024 ** 3);
    expect(oneGb).toBe(Math.floor((1024 ** 3 * 0.25) / TRANSCRIPT_ENTRY_HEAP_FACTOR));
    expect(oneGb).toBeLessThan(256 * 1024 * 1024);
  });

  it('goes BELOW the old fixed cap on a small heap — the direction a constant could not', () => {
    // A 256MB container. The point of the change is not "cache more": it is that 24MB was
    // simultaneously too small on a large heap and too large on a small one.
    expect(transcriptCacheBudgetBytes(256 * 1024 * 1024)).toBeLessThan(TRANSCRIPT_CACHE_MAX_BYTES);
  });

  it('falls back to the old constant when the heap limit is unreadable', () => {
    // Fail SAFE, not open: an unusable limit must not widen the budget.
    //
    // `undefined` is deliberately NOT in this list — it means "not supplied", which is the
    // production call and must read v8. The first draft lumped the two together and the
    // code did too, so a bad explicit argument silently fell through to the real heap.
    for (const bad of [0, -1, NaN, null, 'lots', Infinity]) {
      expect(transcriptCacheBudgetBytes(bad), `bad limit ${String(bad)}`).toBe(TRANSCRIPT_CACHE_MAX_BYTES);
    }
  });

  it('the real process budget is a positive number, so the default path is exercised', () => {
    // Called with no argument it reads v8.getHeapStatistics(). Every case above passes an
    // explicit limit, so without this one the production call path is never run.
    const actual = transcriptCacheBudgetBytes();
    expect(actual).toBeGreaterThan(0);
    expect(actual).toBeLessThanOrEqual(256 * 1024 * 1024);
  });
});
