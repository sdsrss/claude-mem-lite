// Shared LLM-rerank core: reorder a top-K candidate list by an LLM relevance read.
//
// Used by BOTH the production deep-search rerank stage (deep-search.mjs) and the
// LongMemEval rerank benchmark (benchmark/longmemeval-rerank.mjs), so the measured
// lift number reflects the EXACT algorithm that ships. "Never worse than the input
// candidate order" by construction: any LLM/parse failure returns the original order.
//
// The LLM is dependency-injected by every caller, so this module is unit-tested with
// deterministic stubs and never statically imports the native-heavy LLM client (the
// default provider is pulled in lazily on first real call).
import { parseJsonFromLLM } from './utils.mjs';

// Module-internal: only buildRerankPrompt (below) consumes these. Kept un-exported
// so the module's public surface is just the three functions callers actually import.
const RERANK_SYSTEM =
  'You rerank search results. Given a QUERY and numbered candidate session snippets, ' +
  'decide which sessions most likely contain the answer to the query. ' +
  'Return ONLY JSON {"ranked":[<candidate numbers, most relevant first, each number once>]}. No prose, no markdown.';

function buildRerankPrompt(query, snippets) {
  const lines = snippets.map((s, i) => `${i + 1}. ${String(s).replace(/\s+/g, ' ').slice(0, 400)}`);
  return {
    system: RERANK_SYSTEM,
    user: `QUERY: ${query}\n\nCANDIDATES:\n${lines.join('\n')}\n\nReturn {"ranked":[...]} over 1..${snippets.length}, best first.`,
  };
}

// Extract a 1-based ranking array from whatever the LLM returned: a {ranked:[...]}
// object (stub / clean JSON), a bare array (clean OR prose-wrapped [..]), or a
// {text} envelope from callLLMWithModel. The bare-array path is what lifts the
// real parse-rate: claude-haiku often answers "[3,1,5]" instead of {"ranked":..},
// and parseJsonFromLLM's leading JSON.parse returns that as an array (no .ranked),
// which the old object-only check silently dropped. null → nothing recoverable.
export function extractRanked(raw) {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object' && Array.isArray(raw.ranked)) return raw.ranked;
  const text = typeof raw === 'string' ? raw : typeof raw.text === 'string' ? raw.text : '';
  if (!text) return null;
  const obj = parseJsonFromLLM(text);
  if (Array.isArray(obj)) return obj; // bare array [3,1,5]
  if (obj && Array.isArray(obj.ranked)) return obj.ranked; // {"ranked":[...]}
  const m = text.match(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/); // prose-wrapped [..]
  if (m) {
    try {
      const a = JSON.parse(m[0]);
      if (Array.isArray(a)) return a;
    } catch {
      /* fall through */
    }
  }
  return null;
}

// Reorder candidate session ids per the LLM's chosen 1-based order; any failure →
// original order ("never worse than baseline"). { order: sid[], parsed: bool }.
export async function llmRerankOrder(query, cand /* [{sid,text}] */, llm) {
  const prompt = buildRerankPrompt(
    query,
    cand.map((c) => c.text),
  );
  let raw;
  try {
    raw = await llm(prompt);
  } catch {
    raw = null;
  }
  const order = extractRanked(raw);
  if (!order) return { order: cand.map((c) => c.sid), parsed: false };
  const seen = new Set();
  const out = [];
  for (const n of order) {
    const idx = Number(n) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < cand.length && !seen.has(idx)) {
      seen.add(idx);
      out.push(cand[idx].sid);
    }
  }
  cand.forEach((c, i) => {
    if (!seen.has(i)) out.push(c.sid);
  }); // append omitted, original order
  return { order: out, parsed: true };
}

// Default provider — lazy import so stub-injected callers never load the client.
// Uses the {text}-envelope dispatcher rather than callModelJSONAsync (which
// JSON-parses internally and nulls on any non-{...} output) so extractRanked can
// recover bare-array answers the strict JSON parse drops. The Async variant is
// load-bearing: rerank runs inside the mem_search MCP handler (deep + rerank), so
// the blocking callLLMWithModel froze the server event loop whenever a keyed
// provider was down and the call degraded to the CLI (D#138 MEDIUM-3).
export async function defaultRerankLLM(prompt) {
  const { callLLMWithModelAsync } = await import('./haiku-client.mjs');
  return callLLMWithModelAsync(prompt, 'haiku', { timeout: 20000, maxTokens: 300 });
}
