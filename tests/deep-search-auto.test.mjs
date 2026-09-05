// D#40 auto-escalation path, end-to-end through deepSearch({ auto: true }).
//
// haiku-client is mocked so the auto path NEVER spawns a real `claude`
// subprocess (the deferred note's "destabilizes the live suite" hazard).
// callRewriteLLM routes through the fully-async dispatcher callModelJSONAsync
// (D#40 F4 — no blocking execFileSync fallback), so that is what we mock. These
// pin: the fail-fast timeout is passed, rewrites are cached, bursts are
// throttled, and every failure mode degrades to baseline (never worse).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../haiku-client.mjs', () => ({
  callModelJSONAsync: vi.fn(),
}));

import { callModelJSONAsync } from '../haiku-client.mjs';
import { deepSearch, _resetAutoDeepState, AUTO_DEEP_TIMEOUT_MS } from '../deep-search.mjs';

// Trivial search: each variant returns one row keyed by the query text, so
// rrfFuseN has lists to fuse and deepSearch never touches a real db.
const searchFn = (_db, q) => [{ id: q }];

describe('deepSearch auto path — non-blocking dispatch + fail-fast + throttle + cache (D#40)', () => {
  beforeEach(() => {
    _resetAutoDeepState();
    vi.mocked(callModelJSONAsync)
      .mockReset()
      .mockResolvedValue({ variants: ['kw form', 'concept exp', 'hyde'] });
  });

  it('routes the auto rewrite to the async dispatcher with the fail-fast timeout', async () => {
    const { variants } = await deepSearch(null, { query: 'orchestration' }, { auto: true, searchFn });
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1);
    expect(callModelJSONAsync).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'orchestration' }),
      'haiku',
      { timeout: AUTO_DEEP_TIMEOUT_MS, maxTokens: 400 },
    );
    expect(variants[0]).toBe('orchestration'); // original always first
    expect(variants.length).toBeGreaterThan(1); // rewrite applied
  });

  it('caches successful rewrites — a repeat query does not re-call the LLM', async () => {
    await deepSearch(null, { query: 'same query' }, { auto: true, searchFn });
    await deepSearch(null, { query: 'same query' }, { auto: true, searchFn });
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1);
  });

  it('throttles bursts — a second distinct query within the window degrades to baseline', async () => {
    await deepSearch(null, { query: 'first q' }, { auto: true, searchFn });
    const { variants } = await deepSearch(null, { query: 'second q' }, { auto: true, searchFn });
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1); // second throttled
    expect(variants).toEqual(['second q']); // never worse than baseline
  });

  it('does not retry on the auto path (fail-fast) — an empty rewrite calls the LLM once', async () => {
    vi.mocked(callModelJSONAsync).mockResolvedValue({ variants: [] });
    const { variants } = await deepSearch(null, { query: 'lonely q' }, { auto: true, searchFn });
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1); // retries=0
    expect(variants).toEqual(['lonely q']);
  });

  it('degrades to baseline when the dispatcher returns null (no rewrite, no throw)', async () => {
    vi.mocked(callModelJSONAsync).mockResolvedValue(null);
    const { variants } = await deepSearch(null, { query: 'nullq' }, { auto: true, searchFn });
    expect(variants).toEqual(['nullq']);
  });

  it('explicit (non-auto) deep with no injected llm uses the patient 12s timeout', async () => {
    await deepSearch(null, { query: 'explicit q' }, { searchFn }); // auto defaults false
    expect(callModelJSONAsync).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'explicit q' }),
      'haiku',
      { timeout: 12000, maxTokens: 400 },
    );
  });
});
