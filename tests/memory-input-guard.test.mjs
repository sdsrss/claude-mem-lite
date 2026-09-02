// Regression lock for the memory-input injection guard (MEMORY_INPUT_GUARD).
//
// These are STATIC SOURCE assertions: we deliberately do NOT import hook-llm.mjs
// because it transitively pulls in better-sqlite3 (a native addon), which can
// hang vitest collection (see the vitest-hang-traps skill). The guard is a
// shipped-prompt security control, so what we must prevent is a future prompt
// edit silently deleting or weakening it — that is exactly what source-level
// assertions catch. They do NOT (and cannot cheaply) prove Haiku's runtime
// behavior; per lesson #8605 prompt wording barely moves Haiku anyway, so the
// value here is defense-in-depth wiring, not a behavioral guarantee.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const src = readFileSync(
  // D#207: join(), not new URL('../X.mjs', …) — that form blinds knip to hook-llm.mjs.
  join(dirname(fileURLToPath(import.meta.url)), '..', 'hook-llm.mjs'),
  'utf8',
);

describe('MEMORY_INPUT_GUARD', () => {
  it('is declared and keeps its load-bearing security semantics', () => {
    // `export` optional: the constant went module-private in D#207 (nothing imported it,
    // and being exported put a permanently-unused name in knip's report the moment that
    // change made hook-llm.mjs visible). This test never imported it either — it reads
    // the source — so the pattern is widened rather than the visibility kept for its sake.
    const m = src.match(/(?:export\s+)?const MEMORY_INPUT_GUARD\s*=\s*'([^']*)'/);
    expect(m, 'MEMORY_INPUT_GUARD declaration must exist').toBeTruthy();
    const guard = m[1];
    expect(guard).toMatch(/untrusted/i);
    expect(guard).toMatch(/DATA only/i);
    expect(guard).toMatch(/never obey/i);
  });

  it('is wired into every prompt path that ingests untrusted content', () => {
    // >=2 interpolations: SHARED_OBS_SCHEMA_TAIL (covers single- + multi-entry
    // episode extraction) and the session-summary system prompt. If a prompt
    // edit drops one injection point this count regresses and the test fails.
    const interpolations = src.match(/\$\{MEMORY_INPUT_GUARD\}/g) || [];
    expect(interpolations.length).toBeGreaterThanOrEqual(2);
  });

  it('leads the shared episode schema tail with the guard', () => {
    expect(src).toMatch(/SHARED_OBS_SCHEMA_TAIL\s*=\s*`\$\{MEMORY_INPUT_GUARD\}/);
  });
});
