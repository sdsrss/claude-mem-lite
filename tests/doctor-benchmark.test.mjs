import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertObs, insertSession } from './test-helpers.mjs';
import { runBenchmark } from '../lib/doctor-benchmark.mjs';

describe('doctor --benchmark', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  test('reports L2 MCP instructions byte count', () => {
    const result = runBenchmark(db, { skipHookLatency: true });
    expect(result.mcp_instructions_bytes).toBeGreaterThan(0);
    expect(typeof result.mcp_tool_count).toBe('number');
  });

  test('reports hook injection rate across prompt fixture', () => {
    insertSession(db, { id: 'sess-bench', project: 'test' });
    // Seed with literal tokens matching the prompt fixture below.
    // sanitizeFtsQuery rewrites 'what did we decide about auth' to
    // 'decide AND (auth OR ...)' — the default FTS5 tokenizer does NOT stem,
    // so fixture text must contain the bare tokens 'decide' and 'auth' (not
    // 'decided' / 'decision'). Likewise 'refactor the logger' needs 'refactor'
    // and 'logger' as bare tokens.
    for (let i = 0; i < 20; i++) {
      insertObs(db, {
        sessionId: 'sess-bench',
        type: 'decision',
        title: `decide on auth policy ${i}`,
        text: 'we decide to use auth tokens and refactor the logger module',
        importance: 3,
        project: 'test',
      });
    }
    const prompts = ['what did we decide about auth', 'a', '继续', 'refactor the logger'];
    const result = runBenchmark(db, { prompts, project: 'test', skipHookLatency: true });
    expect(result.prompt_count).toBe(4);
    expect(result.injection_rate).toBeGreaterThanOrEqual(0);
    expect(result.injection_rate).toBeLessThanOrEqual(1);
    // Behavioral check: "what did we decide about auth" must match the seeded
    // 'decision N' rows via FTS, so at least one prompt injects. Catches
    // silent-false regressions (sanitize eating the query, FTS index missing,
    // project filter broken, etc.).
    expect(result.injection_rate).toBeGreaterThan(0);
  });

  test('JSON output shape is stable', () => {
    const result = runBenchmark(db, { skipHookLatency: true });
    expect(result).toMatchObject({
      version: expect.any(String),
      mcp_tool_count: expect.any(Number),
      mcp_instructions_bytes: expect.any(Number),
      prompt_count: expect.any(Number),
      injection_rate: expect.any(Number),
    });
    // Latency keys must be present (nullable number). `expect.anything()`
    // from the original spec rejects null, so check key presence + type.
    expect(result).toHaveProperty('hook_p50_ms');
    expect(result).toHaveProperty('hook_p99_ms');
    expect(result.hook_p50_ms === null || typeof result.hook_p50_ms === 'number').toBe(true);
    expect(result.hook_p99_ms === null || typeof result.hook_p99_ms === 'number').toBe(true);
  });
});
