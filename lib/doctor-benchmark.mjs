// Baseline benchmark capture for v2.31 MVP.
// Measures (bounded scope):
//   - L2 MCP instructions byte count (cost-per-turn source).
//   - Count of registered MCP tool schemas.
//   - Hook execution latency p50/p99 by replaying a prompt fixture.
//   - Hook injection rate (fraction of prompts that would inject non-empty output).
//
// This is a *static* analyzer plus a DB-driven simulator — it does not spawn
// the MCP server or the hook process. See docs/plans/2026-04-14-mem-v2.31-mvp.md
// (Task 1). Out of scope: prompt cache hit/miss.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { sanitizeFtsQuery, OBS_BM25 } from '../utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'server.mjs');
const SEARCH_SCORING_PATH = join(__dirname, '..', 'search-scoring.mjs');
const BENCHMARK_VERSION = '1';

function extractStringArrayBody(body) {
  const parts = [];
  const re = /(['"])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const unescaped = m[2]
      .replace(/\\n/g, '\n')
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    parts.push(unescaped);
  }
  return parts;
}

/**
 * Extract the string body of the MCP `instructions:` field.
 * Supports three forms:
 *   1. template literal in server.mjs:  instructions: `...`
 *   2. array-join in server.mjs:        instructions: [ '...', '...' ].join('\n')
 *   3. (v2.31.3+) builder call in server.mjs referencing INSTRUCTIONS_BASE +
 *      INSTRUCTIONS_VERBOSE arrays in search-scoring.mjs. Measured at the
 *      verbose form — this is the cost-per-turn baseline the benchmark tracks.
 * Returns '' if no shape matches (caller treats byte count as 0).
 */
function readMcpInstructions() {
  const src = readFileSync(SERVER_PATH, 'utf8');

  // Form 1: template literal
  const tmpl = src.match(/instructions:\s*`([\s\S]*?)`/);
  if (tmpl) return tmpl[1];

  // Form 2: string array + .join(...)
  const arr = src.match(/instructions:\s*\[([\s\S]*?)\]\s*\.join\(/);
  if (arr) return extractStringArrayBody(arr[1]).join('\n');

  // Form 3: buildServerInstructions() — reconstruct verbose form from
  // search-scoring.mjs INSTRUCTIONS_BASE + INSTRUCTIONS_VERBOSE arrays.
  if (/instructions:\s*buildServerInstructions\(/.test(src)) {
    let internals;
    try {
      internals = readFileSync(SEARCH_SCORING_PATH, 'utf8');
    } catch {
      return '';
    }
    const base = internals.match(/INSTRUCTIONS_BASE\s*=\s*\[([\s\S]*?)\];/);
    const verbose = internals.match(/INSTRUCTIONS_VERBOSE\s*=\s*\[([\s\S]*?)\];/);
    const parts = [];
    if (base) parts.push(...extractStringArrayBody(base[1]));
    if (verbose) parts.push(...extractStringArrayBody(verbose[1]));
    return parts.join('\n');
  }

  return '';
}

function countMcpTools() {
  const src = readFileSync(SERVER_PATH, 'utf8');
  return (src.match(/server\.registerTool\(/g) || []).length;
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p));
  return sortedAsc[idx];
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{prompts?: string[], project?: string, skipHookLatency?: boolean}} options
 */
export function runBenchmark(db, { prompts = [], project = 'mem', skipHookLatency = false } = {}) {
  const instructions = readMcpInstructions();
  const mcp_instructions_bytes = Buffer.byteLength(instructions, 'utf8');
  const mcp_tool_count = countMcpTools();

  // Prepare the injection probe once; reused across the rate loop and the
  // latency loop. Re-preparing per iteration would inflate p50/p99 by the
  // prepare-overhead, masking real hook latency.
  const injectionStmt = db.prepare(`
    SELECT ${OBS_BM25} AS score
    FROM observations_fts
    JOIN observations o ON o.id = observations_fts.rowid
    WHERE observations_fts MATCH ? AND o.project = ?
    ORDER BY score LIMIT 1
  `);

  /**
   * Simulate the memory-inject hook for one prompt:
   *   - trim-and-length guard (mirrors hook-memory.mjs minimum-length heuristic)
   *   - sanitize as FTS query
   *   - BM25-ranked lookup over observations_fts, filtered by project
   * Returns true iff the simulator would produce a non-empty injection.
   */
  const runInjection = (promptText) => {
    // Mirror the real hook's min-length gate (hook-memory.mjs searchRelevantMemories):
    // 5-char floor for non-CJK, 2 for CJK. The old flat 15 was 3x stricter and dropped
    // every 5-14-char prompt (and all 2-14-char CJK) the live hook processes, so the
    // simulated injection_rate systematically under-counted "how often memory fires".
    const cjk = /[一-鿿㐀-䶿]/.test(promptText || '');
    if (!promptText || promptText.length < (cjk ? 2 : 5)) return false;
    const q = sanitizeFtsQuery(promptText);
    if (!q) return false;
    try {
      return !!injectionStmt.get(q, project);
    } catch {
      // Malformed query slipped past sanitize → treat as no injection.
      return false;
    }
  };

  let injected = 0;
  for (const p of prompts) {
    if (runInjection(p)) injected++;
  }
  const injection_rate = prompts.length > 0 ? injected / prompts.length : 0;

  let hook_p50_ms = null;
  let hook_p99_ms = null;
  if (!skipHookLatency && prompts.length > 0) {
    const latencies = [];
    for (const p of prompts) {
      const t0 = performance.now();
      runInjection(p);
      latencies.push(performance.now() - t0);
    }
    latencies.sort((a, b) => a - b);
    hook_p50_ms = percentile(latencies, 0.5);
    hook_p99_ms = percentile(latencies, 0.99);
  }

  return {
    version: BENCHMARK_VERSION,
    mcp_tool_count,
    mcp_instructions_bytes,
    prompt_count: prompts.length,
    injection_rate,
    hook_p50_ms,
    hook_p99_ms,
  };
}
