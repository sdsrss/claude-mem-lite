// v45 perf contract: extractInjectedBySurface walks the transcript ONCE for all
// four faces. Pre-v45 each face was its own `eachHookAttachment` call and the
// union therefore re-read and re-parsed the whole file 4x per Stop.
//
// This lives in its own file because the only honest way to assert it is to
// count real `readFileSync` calls, which needs `vi.mock('fs')` at module scope
// — ESM module namespaces are not configurable, so `vi.spyOn(fs, 'readFileSync')`
// throws, and a file-scoped fs mock would break sibling tests that write
// fixtures with the real fs.
//
// Pre-tag review a2: the guard this replaces counted textual occurrences of
// `eachHookAttachment(` inside the function body, which a mutation defeats
// trivially — wrapping that single call in `for (const face of
// ATTACHMENT_SURFACES) { ... }` restores all four reads and leaves the textual
// count at one. Verified: that mutation left the old assertion green.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync as realWriteFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let readCounts = [];

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: actual.default,
    readFileSync: (...args) => {
      readCounts.push(String(args[0]));
      return actual.readFileSync(...args);
    },
  };
});

const { extractInjectedBySurface, extractAllInjected } = await import('../lib/citation-tracker.mjs');

const att = (command, stdout) => ({
  type: 'attachment',
  attachment: { type: 'hook_success', command, stdout },
});
const ALL_FOUR = [
  att('node /x/scripts/pre-tool-recall.js', '  #101 [bugfix] a\n'),
  att('node /x/hook.mjs user-prompt', '<memory-context>\n- [decision] b (#202)\n</memory-context>\n'),
  att('bash /x/scripts/post-tool-use.sh', 'Related memories found for this error:\n  #303 [bugfix] c\n'),
  att('node /x/scripts/user-prompt-search.js', '[mem] FYI — Related memories\n#404 🔴 d\n'),
];

describe('extractInjectedBySurface reads the transcript once', () => {
  let tmp, path;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'single-walk-'));
    path = join(tmp, 't.jsonl');
    realWriteFileSync(path, ALL_FOUR.map((e) => JSON.stringify(e)).join('\n'));
    readCounts = [];
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  const readsOfTranscript = () => readCounts.filter((p) => p === path).length;

  it('reads once for a transcript carrying all four faces', () => {
    const bySurface = extractInjectedBySurface(path);
    // Sanity: all four faces really did match, so the count is not 1 merely
    // because the walk bailed out early.
    expect([...bySurface.pretool]).toEqual([101]);
    expect([...bySurface.ups]).toEqual([202]);
    expect([...bySurface.error_recall]).toEqual([303]);
    expect([...bySurface.fyi]).toEqual([404]);
    expect(readsOfTranscript(), 'one walk, not one per face').toBe(1);
  });

  it('reads once for a transcript carrying a single face', () => {
    realWriteFileSync(path, JSON.stringify(ALL_FOUR[0]));
    readCounts = [];
    extractInjectedBySurface(path);
    expect(readsOfTranscript()).toBe(1);
  });

  it('extractAllInjected inherits the single walk (it is the union, not a 5th pass)', () => {
    const ids = extractAllInjected(path);
    expect([...ids].sort((a, b) => a - b)).toEqual([101, 202, 303, 404]);
    expect(readsOfTranscript(), 'the union must not re-read').toBe(1);
  });
});
