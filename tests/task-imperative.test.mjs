// tests/task-imperative.test.mjs
import { describe, it, expect } from 'vitest';
import { formatTaskImperative } from '../lib/task-imperative.mjs';

describe('formatTaskImperative', () => {
  it('wraps a lesson as an imperative, task-bound line (no id → no #NN tag)', () => {
    expect(formatTaskImperative('use union-by-max not naive union')).toBe(
      'Memory — a past lesson applies to THIS task. You must: use union-by-max not naive union.',
    );
  });
  it('appends the #NN cite tag when an id is given, normalizing one trailing period', () => {
    expect(formatTaskImperative('keep the `superseded_at IS NULL` filter.', 8820)).toBe(
      'Memory — a past lesson applies to THIS task. You must: keep the `superseded_at IS NULL` filter. (#8820)',
    );
  });
  it('trims surrounding whitespace before formatting', () => {
    expect(formatTaskImperative('  spaced lesson  ')).toBe(
      'Memory — a past lesson applies to THIS task. You must: spaced lesson.',
    );
  });
  it('returns empty string for empty/nullish lessons (the gate excludes these upstream)', () => {
    expect(formatTaskImperative('')).toBe('');
    expect(formatTaskImperative(null)).toBe('');
    expect(formatTaskImperative(undefined)).toBe('');
  });
});
