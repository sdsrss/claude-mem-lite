// Option C: opt-in LLM rerank stage on deepSearch (deep-search.mjs).
//
// After rewrite → per-variant hybrid → RRF fusion, an OPT-IN stage reranks the
// fused top-K via an injected LLM. "Never worse than the fused order" by
// construction: any LLM/parse failure leaves the fused order untouched. The
// rerank core is the same module the LongMemEval benchmark measures (rerank.mjs),
// so the shipped algorithm == the measured one. The LLM and the candidate-text
// fetch are dependency-injected, so these tests touch no provider and no db.
import { describe, it, expect } from 'vitest';
import { deepSearch } from '../deep-search.mjs';

// rewrite stub: no usable rewrites → variants collapse to [original] → fusion over
// a single list preserves searchFn's order, so each test controls the fused order.
const noRewrite = async () => ({ variants: [] });
// fixed candidate rows (obs shape) in a known order (score strictly decreasing).
const rows = (ids) =>
  ids.map((id, i) => ({
    id,
    source: 'obs',
    title: `t${id}`,
    subtitle: '',
    snippet: `snip ${id}`,
    lesson_learned: '',
    score: -1 / (i + 1),
  }));
// inject candidate text so no db is needed; map id → narrative-ish text.
const textOf = (map) => (_db, rs) => new Map(rs.map((r) => [r.id, map[r.id] ?? `x${r.id}`]));

describe('deepSearch rerank stage (option C, opt-in)', () => {
  it('default off: rerankLlm is never called and fused order is preserved', async () => {
    let calls = 0;
    const rerankLlm = async () => {
      calls++;
      return { ranked: [3, 2, 1] };
    };
    const { results, reranked } = await deepSearch(
      null,
      { query: 'q', limit: 10 },
      { llm: noRewrite, searchFn: () => rows([1, 2, 3]), rerankLlm, rerankTextFn: textOf({}) },
    );
    expect(calls).toBe(0);
    expect(reranked).toBeFalsy();
    expect(results.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('rerank:true reorders the fused candidates per the LLM 1-based permutation', async () => {
    const rerankLlm = async () => ({ ranked: [3, 1, 2] });
    const { results, reranked } = await deepSearch(
      null,
      { query: 'q', limit: 10 },
      {
        llm: noRewrite,
        searchFn: () => rows([10, 20, 30]),
        rerank: true,
        rerankLlm,
        rerankTextFn: textOf({}),
      },
    );
    expect(reranked).toBe(true);
    expect(results.map((r) => r.id)).toEqual([30, 10, 20]);
  });

  it('never worse than baseline: a null rerank → fused order, reranked=false', async () => {
    const { results, reranked } = await deepSearch(
      null,
      { query: 'q', limit: 10 },
      {
        llm: noRewrite,
        searchFn: () => rows([1, 2, 3]),
        rerank: true,
        rerankLlm: async () => null,
        rerankTextFn: textOf({}),
      },
    );
    expect(results.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(reranked).toBe(false);
  });

  it('reranks only the top-K, appending the tail in fused order', async () => {
    const rerankLlm = async () => ({ ranked: [2, 1] }); // over the 2 candidates seen
    const { results } = await deepSearch(
      null,
      { query: 'q', limit: 10 },
      {
        llm: noRewrite,
        searchFn: () => rows([1, 2, 3, 4]),
        rerank: true,
        rerankTopK: 2,
        rerankLlm,
        rerankTextFn: textOf({}),
      },
    );
    expect(results.map((r) => r.id)).toEqual([2, 1, 3, 4]);
  });

  it('feeds each candidate its narrative text (+ the query) to the reranker', async () => {
    let prompt = null;
    const rerankLlm = async (p) => {
      prompt = p;
      return { ranked: [1, 2] };
    };
    await deepSearch(
      null,
      { query: 'find the auth bug', limit: 10 },
      {
        llm: noRewrite,
        searchFn: () => rows([1, 2]),
        rerank: true,
        rerankLlm,
        rerankTextFn: textOf({ 1: 'narrative about the auth token', 2: 'about caching' }),
      },
    );
    expect(prompt.user).toContain('narrative about the auth token');
    expect(prompt.user).toContain('find the auth bug');
  });

  it('re-stamps scores in rerank order so a downstream score-sort preserves it (§9 paired-path)', async () => {
    const rerankLlm = async () => ({ ranked: [3, 1, 2] });
    const { results } = await deepSearch(
      null,
      { query: 'q', limit: 10 },
      {
        llm: noRewrite,
        searchFn: () => rows([10, 20, 30]),
        rerank: true,
        rerankLlm,
        rerankTextFn: textOf({}),
      },
    );
    // rerank order is [30,10,20]; scores must ascend in that order so a consumer that
    // re-sorts by score (server.mjs reRankWithContext + sort) reproduces the rerank
    // order instead of restoring the RRF order off the original scores.
    expect(results.map((r) => r.id)).toEqual([30, 10, 20]);
    const scores = results.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => a - b)); // non-decreasing in array order
    // Simulate the MCP consumer's sort-by-score: order must be unchanged.
    const resorted = [...results].sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    expect(resorted.map((r) => r.id)).toEqual([30, 10, 20]);
  });

  it('passes only the top-K candidates to rerankTextFn (not the whole fused list)', async () => {
    let seenIds = null;
    const rerankTextFn = (_db, rs) => {
      seenIds = rs.map((r) => r.id);
      return new Map(rs.map((r) => [r.id, `x${r.id}`]));
    };
    await deepSearch(
      null,
      { query: 'q', limit: 10 },
      {
        llm: noRewrite,
        searchFn: () => rows([1, 2, 3, 4, 5]),
        rerank: true,
        rerankTopK: 3,
        rerankLlm: async () => ({ ranked: [1, 2, 3] }),
        rerankTextFn,
      },
    );
    expect(seenIds).toEqual([1, 2, 3]);
  });
});
