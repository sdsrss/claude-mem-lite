// Tests for the LLM-rerank experiment harness (benchmark/longmemeval-rerank.mjs).
// Verifies the reorder/fallback/parse logic deterministically with stub LLMs, so
// the real (slow) provider only ever runs to PRODUCE the lift number, never to
// debug the harness. Stub returns: object | fenced JSON string | null.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { llmRerankOrder, rerankEval, extractRanked } from '../benchmark/longmemeval-rerank.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE = JSON.parse(
  readFileSync(join(__dirname, '../benchmark/fixtures/longmemeval-sample.json'), 'utf8'),
);
const byId = (id) => SAMPLE.find((e) => e.question_id === id);
const cand = [
  { sid: 'a', text: 'alpha' },
  { sid: 'b', text: 'bravo' },
  { sid: 'c', text: 'charlie' },
];

describe('llmRerankOrder', () => {
  it('reorders to the LLM 1-based permutation', async () => {
    const r = await llmRerankOrder('q', cand, () => ({ ranked: [3, 1, 2] }));
    expect(r.parsed).toBe(true);
    expect(r.order).toEqual(['c', 'a', 'b']);
  });
  it('appends omitted candidates in original order', async () => {
    const r = await llmRerankOrder('q', cand, () => ({ ranked: [2] }));
    expect(r.order).toEqual(['b', 'a', 'c']);
  });
  it('parses fenced JSON string output', async () => {
    const r = await llmRerankOrder('q', cand, () => '```json\n{"ranked":[2,3,1]}\n```');
    expect(r.parsed).toBe(true);
    expect(r.order).toEqual(['b', 'c', 'a']);
  });
  it('falls back to baseline order on null / parse failure', async () => {
    const r = await llmRerankOrder('q', cand, () => null);
    expect(r.parsed).toBe(false);
    expect(r.order).toEqual(['a', 'b', 'c']);
  });
  it('ignores out-of-range / duplicate indices', async () => {
    const r = await llmRerankOrder('q', cand, () => ({ ranked: [9, 2, 2, 0, 1] }));
    expect(r.order).toEqual(['b', 'a', 'c']);
  });
});

describe('extractRanked — robust to bare arrays and {text} envelopes', () => {
  it('accepts a {ranked:[...]} object', () => expect(extractRanked({ ranked: [2, 1] })).toEqual([2, 1]));
  it('accepts a direct array', () => expect(extractRanked([3, 1, 2])).toEqual([3, 1, 2]));
  it('parses {text} with {"ranked":[...]}', () =>
    expect(extractRanked({ text: '{"ranked":[2,1,3]}' })).toEqual([2, 1, 3]));
  it('parses {text} with a BARE array (the real claude-haiku shape that the old code dropped)', () =>
    expect(extractRanked({ text: '[2,1,3]' })).toEqual([2, 1, 3]));
  it('parses {text} with a fenced bare array', () =>
    expect(extractRanked({ text: '```json\n[3,2,1]\n```' })).toEqual([3, 2, 1]));
  it('extracts a prose-wrapped array', () =>
    expect(extractRanked({ text: 'Best order: [3,1,2] by relevance.' })).toEqual([3, 1, 2]));
  it('returns null when nothing is recoverable', () => {
    expect(extractRanked(null)).toBeNull();
    expect(extractRanked({ text: '' })).toBeNull();
    expect(extractRanked({ text: 'no ranking here' })).toBeNull();
  });
});

describe('rerankEval (end-to-end with stub LLM)', () => {
  // identity stub: keep candidate order → rerank must equal baseline (no-op safety)
  const identity = (prompt) => {
    const n = (prompt.user.match(/over 1\.\.(\d+)/) || [])[1];
    return { ranked: Array.from({ length: Number(n) }, (_, i) => i + 1) };
  };
  // oracle stub: read the candidate snippets, promote the one containing the answer token
  const promote = (token) => (prompt) => {
    const lines = prompt.user.split('\n').filter((l) => /^\d+\.\s/.test(l));
    const idx = lines.findIndex((l) => l.toLowerCase().includes(token.toLowerCase()));
    return { ranked: idx >= 0 ? [idx + 1] : [] };
  };

  it('identity rerank equals the lexical baseline', async () => {
    const r = await rerankEval(byId('q-lexical-db'), { turns: 'user', topK: 10, ks: [1, 5], llm: identity });
    expect(r.rerank).toEqual(r.base);
    expect(r.parsed).toBe(true);
  });

  it('an oracle stub promotes the gold session to rank 1 (reaches the ceiling)', async () => {
    const r = await rerankEval(byId('q-lexical-db'), {
      turns: 'user',
      topK: 10,
      ks: [1, 5],
      llm: promote('ClickHouse'),
    });
    expect(r.rerank['1']).toBe(1);
    expect(r.gold).toEqual(['s-analytics']);
  });

  it('works through a {text} envelope returning a bare array (real provider shape)', async () => {
    const promoteText = (prompt) => {
      const lines = prompt.user.split('\n').filter((l) => /^\d+\.\s/.test(l));
      const idx = lines.findIndex((l) => l.toLowerCase().includes('clickhouse'));
      return { text: `[${idx + 1}]` };
    };
    const r = await rerankEval(byId('q-lexical-db'), {
      turns: 'user',
      topK: 10,
      ks: [1, 5],
      llm: promoteText,
    });
    expect(r.rerank['1']).toBe(1);
    expect(r.parsed).toBe(true);
  });

  it('never worse than baseline when the LLM fails (null → fallback)', async () => {
    const r = await rerankEval(byId('q-lexical-migration'), {
      turns: 'user',
      topK: 10,
      ks: [1, 5],
      llm: () => null,
    });
    expect(r.rerank).toEqual(r.base);
    expect(r.parsed).toBe(false);
  });
});
