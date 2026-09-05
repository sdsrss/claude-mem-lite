// Tests for lib/file-intel.mjs — pure builder for the PreToolUse:Read "file
// intelligence" injection (feature ①): before Claude reads a file, surface its
// approximate token size + a one-line "what's in it" so the agent can decide to
// read fully, read a slice, or grep instead.
//
// Behavior contract:
//   - estimateContentTokens MUST agree with utils.estimateTokens (pure mirror —
//     the hot standalone hook can't import heavy utils.mjs; this test pins the
//     mirror so the two never drift).
//   - extractFileSummary returns a single capped line, '' when nothing useful.
//   - fileIntelFor returns the formatted line, or null when below the size
//     threshold / file unreadable (never throws — it runs inside a hook).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  estimateContentTokens,
  humanTokens,
  extractFileSummary,
  formatFileIntelLine,
  fileIntelFor,
} from '../lib/file-intel.mjs';
import { estimateTokens } from '../utils.mjs';

describe('estimateContentTokens', () => {
  it('mirrors utils.estimateTokens on ASCII and CJK samples', () => {
    for (const s of [
      '',
      'hello world',
      'const x = 1;\nexport default x;',
      '你好世界，这是中文',
      'mixed 中文 and ascii text here',
    ]) {
      expect(estimateContentTokens(s)).toBe(estimateTokens(s));
    }
  });

  it('returns 1 for empty input (matches utils floor)', () => {
    expect(estimateContentTokens('')).toBe(1);
  });
});

describe('humanTokens', () => {
  it('prints raw count below 1k', () => {
    expect(humanTokens(850)).toBe('850');
    expect(humanTokens(999)).toBe('999');
  });
  it('prints one decimal between 1k and 10k', () => {
    expect(humanTokens(1000)).toBe('1.0k');
    expect(humanTokens(6100)).toBe('6.1k');
  });
  it('rounds to whole k at 10k+', () => {
    expect(humanTokens(12000)).toBe('12k');
  });
});

describe('extractFileSummary', () => {
  it('uses the first markdown heading for .md', () => {
    expect(extractFileSummary('# OpenWolf Operating Protocol\n\nbody', 'OPENWOLF.md')).toBe(
      'OpenWolf Operating Protocol',
    );
  });

  it('uses a meaningful leading comment for code', () => {
    expect(extractFileSummary('// Estimate token count for a file\nexport const x = 1;', 'a.mjs')).toBe(
      'Estimate token count for a file',
    );
  });

  it('skips generic eslint/use-strict comments and falls back to exports', () => {
    const src = '// eslint-disable-next-line\n"use strict";\nexport const foo = 1;\nexport function bar() {}';
    expect(extractFileSummary(src, 'a.mjs')).toBe('Exports foo, bar');
  });

  it('summarizes exports when there is no header comment', () => {
    const src = 'export function alpha() {}\nexport const beta = 2;\nexport class Gamma {}';
    expect(extractFileSummary(src, 'a.mjs')).toBe('Exports alpha, beta, Gamma');
  });

  it('uses description from a JSON manifest', () => {
    expect(extractFileSummary('{"name":"x","description":"My package"}', 'package.json')).toBe('My package');
  });

  it('returns empty string when nothing useful is found', () => {
    expect(extractFileSummary('', 'a.mjs')).toBe('');
    expect(extractFileSummary('   \n  \n', 'a.mjs')).toBe('');
  });

  it('caps the summary length', () => {
    const long = '# ' + 'word '.repeat(60);
    expect(extractFileSummary(long, 'a.md').length).toBeLessThanOrEqual(80);
  });
});

describe('formatFileIntelLine', () => {
  it('includes basename, human token size, and summary', () => {
    expect(
      formatFileIntelLine({ basename: 'server.mjs', tokens: 6100, summary: 'Exports createServer' }),
    ).toBe('[mem] 📄 server.mjs ~6.1k tok · Exports createServer');
  });
  it('omits the summary separator when there is no summary', () => {
    expect(formatFileIntelLine({ basename: 'data.json', tokens: 12000, summary: '' })).toBe(
      '[mem] 📄 data.json ~12k tok',
    );
  });
});

describe('fileIntelFor', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'file-intel-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('returns an intel line for a file above the token threshold', () => {
    const p = join(tmp, 'big.mjs');
    writeFileSync(p, '// Big module that does things\n' + 'export const x = 1;\n'.repeat(400));
    const line = fileIntelFor(p, { minTokens: 100 });
    expect(line).toContain('big.mjs');
    expect(line).toContain('tok');
    expect(line).toContain('Big module that does things');
  });

  it('returns null for a file below the token threshold', () => {
    const p = join(tmp, 'small.mjs');
    writeFileSync(p, 'export const x = 1;\n');
    expect(fileIntelFor(p, { minTokens: 800 })).toBeNull();
  });

  it('returns null (never throws) for a nonexistent path', () => {
    expect(fileIntelFor(join(tmp, 'nope.mjs'), { minTokens: 100 })).toBeNull();
  });
});
