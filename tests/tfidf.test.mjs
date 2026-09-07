// tests/tfidf.test.mjs — tokenization + Porter stemming.
//
// The vocabulary / vector / cosine / vectorSearch / vectorsEnabled blocks that used to
// make up most of this file are GONE with the TF-IDF vector arm (Phase-2). They are
// deleted rather than edited: their subject no longer exists, and a guard over a deleted
// subject is worse than no guard. What remains is what tfidf.mjs still exports and what
// the default retrieval path still consumes.
import { describe, it, expect } from 'vitest';
import { tokenize, porterStem } from '../tfidf.mjs';

describe('tokenize', () => {
  it('lowercases and splits ASCII', () => {
    const tokens = tokenize('Hello World');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
  });

  it('filters tokens shorter than 2 chars', () => {
    const tokens = tokenize('I am a test');
    expect(tokens).not.toContain('i');
    expect(tokens).not.toContain('a');
    expect(tokens).toContain('am');
    expect(tokens).toContain('test');
  });

  it('handles special characters', () => {
    const tokens = tokenize('file.mjs server-config auth_token');
    expect(tokens).toContain('file');
    // 'mjs' → stemmed to 'mj' (Porter strips trailing s)
    expect(tokens).toContain('mj');
    expect(tokens).toContain('server');
    expect(tokens).toContain('config');
  });

  it('handles CJK text via bigrams', () => {
    const tokens = tokenize('修复数据库崩溃');
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('handles mixed ASCII and CJK', () => {
    const tokens = tokenize('Fix the 数据库 bug');
    expect(tokens).toContain('fix');
    expect(tokens).toContain('the');
    expect(tokens).toContain('bug');
    expect(tokens.length).toBeGreaterThan(3); // CJK tokens too
  });

  it('returns empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });
});

describe('porterStem', () => {
  it('stems common English suffixes', () => {
    expect(porterStem('running')).toBe('run');
    expect(porterStem('connected')).toBe('connect');
    expect(porterStem('connections')).toBe('connect');
    expect(porterStem('caresses')).toBe('caress');
  });

  it('handles -ational → -ate → step5a', () => {
    // relational → relate (step2) → relat (step5a removes e since m>1)
    expect(porterStem('relational')).toBe('relat');
  });

  it('handles -izer → -ize → step4', () => {
    // digitizer → digitize (step2) → digit (step4 removes -ize since m>1)
    expect(porterStem('digitizer')).toBe('digit');
  });

  it('leaves short words unchanged', () => {
    expect(porterStem('db')).toBe('db');
    expect(porterStem('go')).toBe('go');
    expect(porterStem('a')).toBe('a');
  });

  it('stems programming-relevant terms', () => {
    // authentication should stem consistently
    const stem = porterStem('authentication');
    expect(porterStem('authenticate')).toBe(stem);
  });

  it('handles -ness, -ful, -ive', () => {
    expect(porterStem('effectiveness')).toBe('effect');
    expect(porterStem('hopeful')).toBe('hope');
  });
});

describe('tokenize with stemming', () => {
  it('stems ASCII tokens', () => {
    const tokens = tokenize('authenticating connections');
    // Should produce stemmed forms, not raw words
    expect(tokens).not.toContain('authenticating');
    expect(tokens).not.toContain('connections');
    // Stemmed forms should be present
    expect(tokens.length).toBe(2);
  });

  it('does not stem CJK tokens', () => {
    const tokens = tokenize('数据库');
    // CJK bigrams are unchanged by stemming
    expect(tokens.length).toBeGreaterThan(0);
  });
});
