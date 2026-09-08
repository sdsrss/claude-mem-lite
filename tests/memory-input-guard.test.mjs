// Regression lock for the memory-input injection guard (MEMORY_INPUT_GUARD).
//
// The guard is a shipped-prompt security control, so what must be prevented is a future
// prompt edit silently deleting or weakening it. These assertions do NOT (and cannot
// cheaply) prove the model's runtime behaviour; per lesson #8605 prompt wording barely
// moves Haiku anyway, so the value here is defense-in-depth wiring, not a behavioural
// guarantee.
//
// RESTATED 2026-09-08 (R10-P3-21). This file used to read hook-llm.mjs as TEXT and regex
// out `const MEMORY_INPUT_GUARD = '...'`, deliberately avoiding an import because
// hook-llm.mjs transitively pulls in better-sqlite3, a native addon that can hang vitest
// collection. That constraint is gone: the guard now lives in lib/memory-input-guard.mjs
// as a bare string with no imports, because normalization became its second consumer and a
// hand-copied security control is the twin-drift class this repo keeps paying for.
//
// So case 1 now asserts on the VALUE rather than on a regex match of one file's source,
// which is strictly stronger — the old form passed if the declaration existed anywhere in
// that file, including in a comment. The wiring cases still read source, because counting
// interpolation SITES is a question about the prompt text, not about the value.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { MEMORY_INPUT_GUARD } from '../lib/memory-input-guard.mjs';

// D#207: join(), not new URL('../X.mjs', …) — that form blinds knip to the named module.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

// Every module that interpolates the guard into a prompt. A new consumer belongs here, and
// the count assertion below is what makes forgetting it fail rather than pass quietly.
const CONSUMERS = ['hook-llm.mjs', 'hook-optimize.mjs'];

describe('MEMORY_INPUT_GUARD', () => {
  it('keeps its load-bearing security semantics', () => {
    expect(typeof MEMORY_INPUT_GUARD).toBe('string');
    expect(MEMORY_INPUT_GUARD).toMatch(/untrusted/i);
    expect(MEMORY_INPUT_GUARD).toMatch(/DATA only/i);
    expect(MEMORY_INPUT_GUARD).toMatch(/never obey/i);
  });

  it('has exactly one home, which every consumer imports', () => {
    // The point of the move. A consumer that re-declares its own copy is the failure this
    // catches — it would still read as guarded while drifting from the real one.
    for (const f of CONSUMERS) {
      const src = read(f);
      expect(src, `${f} must import the shared guard`).toMatch(
        /import \{ MEMORY_INPUT_GUARD \} from '\.\/lib\/memory-input-guard\.mjs'/,
      );
      expect(src, `${f} must not re-declare it`).not.toMatch(/const MEMORY_INPUT_GUARD\s*=/);
    }
  });

  it('is wired into every prompt path that ingests already-stored content', () => {
    // hook-llm.mjs: SHARED_OBS_SCHEMA_TAIL (covers single- and multi-entry episode
    // extraction) and the session-summary system prompt = 2.
    // hook-optimize.mjs: identifySynonymGroups, the normalize path R10-P3-21 was about = 1.
    // A prompt edit that drops one injection point regresses this count.
    const counts = Object.fromEntries(
      CONSUMERS.map((f) => [f, (read(f).match(/\$\{MEMORY_INPUT_GUARD\}/g) || []).length]),
    );
    expect(counts['hook-llm.mjs']).toBeGreaterThanOrEqual(2);
    expect(counts['hook-optimize.mjs']).toBeGreaterThanOrEqual(1);
  });

  it('leads the shared episode schema tail with the guard', () => {
    expect(read('hook-llm.mjs')).toMatch(/SHARED_OBS_SCHEMA_TAIL\s*=\s*`\$\{MEMORY_INPUT_GUARD\}/);
  });

  it('is NOT merged with deep-search.mjs INJECTION_GUARD, which covers a different input', () => {
    // Both are injection guards, so a future tidy-up will be tempted. They are not the same
    // control: this one says captured content is data, deep-search's says the live QUERY is
    // data to reformulate. deep-search also keeps its copy inline to stay off hook-llm's
    // native-heavy import chain (#8729). Pinned so the distinction is a decision, not an
    // accident somebody silently reverses.
    const ds = read('deep-search.mjs');
    expect(ds).toMatch(/const INJECTION_GUARD\s*=/);
    expect(ds).not.toContain(MEMORY_INPUT_GUARD);
  });
});
