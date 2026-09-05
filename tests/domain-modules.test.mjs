// Tests for domain module extraction from utils.mjs
// Verifies: 1) backward-compatible re-exports  2) direct imports  3) functional correctness

import { describe, it, expect } from 'vitest';

// Backward-compatible re-exports from utils.mjs
import {
  scrubSecrets,
  truncate,
  typeIcon,
  fmtDate,
  fmtTime,
  isoWeekKey,
  computeMinHash,
  estimateJaccardFromMinHash,
  jaccardSimilarity,
  detectBashSignificance,
  extractErrorKeywords,
  extractFilePaths,
  stripTestSuffix,
} from '../utils.mjs';

// Direct imports from new domain modules
import { scrubSecrets as directScrub, SECRET_PATTERNS as directPatterns } from '../secret-scrub.mjs';
import {
  truncate as directTrunc,
  typeIcon as directIcon,
  fmtDate as directFmtDate,
  fmtTime as directFmtTime,
  isoWeekKey as directIsoWeek,
} from '../format-utils.mjs';
import {
  computeMinHash as directMinHash,
  estimateJaccardFromMinHash as directEstJaccard,
  jaccardSimilarity as directJaccard,
} from '../hash-utils.mjs';
import {
  detectBashSignificance as directBash,
  extractErrorKeywords as directErrKw,
  extractFilePaths as directPaths,
  stripTestSuffix as directStrip,
} from '../bash-utils.mjs';

describe('domain module re-exports', () => {
  it('backward-compatible utils.mjs re-exports match direct imports', () => {
    expect(scrubSecrets).toBe(directScrub);
    expect(truncate).toBe(directTrunc);
    expect(typeIcon).toBe(directIcon);
    expect(fmtDate).toBe(directFmtDate);
    expect(fmtTime).toBe(directFmtTime);
    expect(isoWeekKey).toBe(directIsoWeek);
    expect(computeMinHash).toBe(directMinHash);
    expect(estimateJaccardFromMinHash).toBe(directEstJaccard);
    expect(jaccardSimilarity).toBe(directJaccard);
    expect(detectBashSignificance).toBe(directBash);
    expect(extractErrorKeywords).toBe(directErrKw);
    expect(extractFilePaths).toBe(directPaths);
    expect(stripTestSuffix).toBe(directStrip);
  });
});

describe('secret-scrub.mjs', () => {
  it('exports SECRET_PATTERNS array', () => {
    expect(Array.isArray(directPatterns)).toBe(true);
    expect(directPatterns.length).toBeGreaterThan(5);
  });

  it('scrubs AWS access keys', () => {
    expect(directScrub('key is AKIAIOSFODNN7EXAMPLE')).toBe('key is ***');
  });

  it('scrubs GitHub tokens', () => {
    expect(directScrub('token: ghp_' + 'a'.repeat(36))).toBe('token: ***');
  });

  it('returns empty string for null/undefined', () => {
    expect(directScrub(null)).toBe('');
    expect(directScrub(undefined)).toBe('');
  });

  it('scrubs JSON-quoted secrets (error payloads)', () => {
    const input = '{"api_key": "sk-very-long-secret-value", "user": "alice"}';
    const out = directScrub(input);
    expect(out).toContain('"api_key": "***"');
    expect(out).toContain('"user": "alice"'); // non-secret key untouched
  });

  it('scrubs JSON-quoted refresh tokens and bearer fields', () => {
    const input = '{"refresh_token": "abc123def456ghi789", "bearer": "longopaquetokenvalue"}';
    const out = directScrub(input);
    expect(out).toContain('"refresh_token": "***"');
    expect(out).toContain('"bearer": "***"');
  });

  it('scrubs sessionid cookies in URL-encoded form', () => {
    const out = directScrub('Cookie: sessionid=abcdef0123456789xyzwq; other=value');
    expect(out).toContain('sessionid=***');
    expect(out).toContain('other=value');
  });

  it('does not over-scrub short placeholder values', () => {
    expect(directScrub('{"api_key": "***"}')).toBe('{"api_key": "***"}');
    expect(directScrub('sessionid=abc')).toBe('sessionid=abc'); // below 16-char floor
  });
});

describe('format-utils.mjs', () => {
  it('truncate shortens long strings', () => {
    expect(directTrunc('hello world this is long', 10)).toBe('hello wor\u2026');
  });

  it('truncate returns empty for falsy input', () => {
    expect(directTrunc('')).toBe('');
    expect(directTrunc(null)).toBe('');
  });

  it('typeIcon returns correct icons', () => {
    expect(directIcon('decision')).toBe('\uD83D\uDFE1'); // yellow circle
    expect(directIcon('bugfix')).toBe('\uD83D\uDD34'); // red circle
    expect(directIcon('unknown')).toBe('\u26AA'); // white circle
  });

  it('fmtDate formats ISO dates', () => {
    const result = directFmtDate('2026-03-15T10:30:00Z');
    expect(result).toBe('Mar 15 10:30');
  });

  it('fmtTime formats ISO time only', () => {
    expect(directFmtTime('2026-03-15T10:30:00Z')).toBe('10:30');
  });

  it('isoWeekKey returns correct week', () => {
    // 2026-01-05 is Monday of W02
    const result = directIsoWeek(Date.UTC(2026, 0, 5));
    expect(result).toMatch(/^2026-W\d{2}$/);
  });
});

describe('hash-utils.mjs', () => {
  it('jaccardSimilarity computes set overlap', () => {
    expect(directJaccard('a b c', 'b c d')).toBeCloseTo(2 / 4);
  });

  it('jaccardSimilarity returns 0 for empty input', () => {
    expect(directJaccard('', 'test')).toBe(0);
    expect(directJaccard(null, 'test')).toBe(0);
  });

  it('computeMinHash returns hex string for sufficient text', () => {
    const sig = directMinHash('this is a test string with enough words');
    expect(sig).not.toBeNull();
    expect(typeof sig).toBe('string');
    expect(sig.length).toBe(64 * 8); // 64 hashes * 8 hex chars each
  });

  it('computeMinHash returns null for short text', () => {
    expect(directMinHash('hi')).toBeNull();
    expect(directMinHash('')).toBeNull();
  });

  it('estimateJaccardFromMinHash estimates similarity', () => {
    const sig1 = directMinHash('the quick brown fox jumps over');
    const sig2 = directMinHash('the quick brown fox jumps over');
    expect(directEstJaccard(sig1, sig2)).toBe(1);
  });
});

describe('bash-utils.mjs', () => {
  it('detectBashSignificance detects errors', () => {
    const result = directBash({ command: 'npm run build' }, 'Error: cannot find module x y z');
    expect(result.isError).toBe(true);
    expect(result.isBuild).toBe(true);
    expect(result.isSignificant).toBe(true);
  });

  it('detectBashSignificance ignores search commands', () => {
    const result = directBash({ command: 'grep error log.txt' }, 'error: something happened in the file');
    expect(result.isError).toBe(false);
  });

  it('extractErrorKeywords extracts meaningful keywords', () => {
    const kw = directErrKw('npm run build', 'Error: Cannot find module "lodash"');
    expect(kw).not.toBeNull();
    expect(kw.length).toBeGreaterThan(0);
  });

  it('extractFilePaths extracts paths from input', () => {
    const paths = directPaths({ file_path: '/src/index.ts', command: 'cat /etc/hosts' });
    expect(paths).toContain('/src/index.ts');
    expect(paths).toContain('/etc/hosts');
  });

  it('stripTestSuffix removes test suffixes', () => {
    expect(directStrip('/path/to/auth.test.ts')).toBe('auth.ts');
    expect(directStrip('/path/to/auth.spec.js')).toBe('auth.js');
    expect(directStrip('/path/to/auth.ts')).toBe('auth.ts');
  });
});
