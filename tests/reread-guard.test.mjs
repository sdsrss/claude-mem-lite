// Tests for lib/reread-guard.mjs — pure logic for feature ② (repeated-read
// guard). When the agent does a full Read of a file it already read this session
// and the file hasn't changed since, the hook nudges it to reuse what it has.
//
// Design guards against false positives (the part OpenWolf's equivalent skips):
//   - only full-vs-full re-reads warn (paging with offset/limit never does)
//   - a file modified since the prior read never warns (mtime check)
//   - below a token floor never warns (re-reading a tiny file is cheap)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { shouldWarnReread, buildRereadWarning, readFileMeta } from '../lib/reread-guard.mjs';

const rec = (over = {}) => ({ mtimeMs: 1000, tokens: 1000, full: true, ...over });

describe('shouldWarnReread', () => {
  it('warns on a full re-read of an unchanged, sizable file', () => {
    expect(shouldWarnReread(rec(), 1000, true, 600)).toBe(true);
  });

  it('does not warn when the file changed since (mtime newer)', () => {
    expect(shouldWarnReread(rec({ mtimeMs: 1000 }), 2000, true, 600)).toBe(false);
  });

  it('does not warn when the current read is partial (offset/limit paging)', () => {
    expect(shouldWarnReread(rec(), 1000, false, 600)).toBe(false);
  });

  it('does not warn when the recorded read was partial', () => {
    expect(shouldWarnReread(rec({ full: false }), 1000, true, 600)).toBe(false);
  });

  it('does not warn below the token floor', () => {
    expect(shouldWarnReread(rec({ tokens: 100 }), 1000, true, 600)).toBe(false);
  });

  it('does not warn without a recorded entry or current mtime', () => {
    expect(shouldWarnReread(null, 1000, true, 600)).toBe(false);
    expect(shouldWarnReread(rec(), null, true, 600)).toBe(false);
  });
});

describe('buildRereadWarning', () => {
  it('names the file, marks it, and shows the wasted size', () => {
    const w = buildRereadWarning('server.mjs', 6100);
    expect(w).toContain('🔁');
    expect(w).toContain('server.mjs');
    expect(w).toMatch(/already read/i);
    expect(w).toContain('6.1k');
  });
});

describe('readFileMeta', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'reread-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('returns mtimeMs and a token estimate for a real file', () => {
    const p = join(tmp, 'a.mjs');
    writeFileSync(p, 'export const x = 1;\n'.repeat(100));
    const meta = readFileMeta(p);
    expect(meta).not.toBeNull();
    expect(typeof meta.mtimeMs).toBe('number');
    expect(meta.tokens).toBeGreaterThan(100);
  });

  it('returns null (never throws) for a missing file', () => {
    expect(readFileMeta(join(tmp, 'nope.mjs'))).toBeNull();
  });
});
