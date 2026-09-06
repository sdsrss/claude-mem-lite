// The LLM timeout budget is calibrated per-leg, not per-caller.
//
// Every dispatcher in haiku-client.mjs degrades to `claude -p` when the keyed
// provider fails, and hands the CLI leg the SAME timeout the caller sized for
// the API leg. Measured on an idle machine (2026-08-16, 4 samples, 400-token
// JSON reply): the CLI leg costs 8.1s / 9.2s / 11.7s / 13.4s, because it pays a
// full Claude Code boot before inference. Against save-enrich's 15s budget the
// worst sample is 89% of the allowance, so under any load execFileSync kills
// the fallback mid-flight and the outage surfaces as reason:'llm-null' — 6/57
// (10.5%) of the instrumented save-enrich runs, and every manual save since.
//
// The fix cannot be a blanket floor inside callModelCLI/callHaikuCLI: those are
// also reached from latency-bound paths (lesson-bridge's 2.5s fail-open budget
// on the PreToolUse hook, deep-search's rerank on the MCP request path), where
// blocking a user for 45s is worse than failing fast. So the allowance belongs
// to the BACKGROUND callers, which have no latency budget at all — hence a
// single named constant applied at those sites, pinned in both directions here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BG_LLM_TIMEOUT_MS } from '../haiku-client.mjs';
import { executeSaveEnrich } from '../lib/save-enrich.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { createTestDb } from './test-helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Worst CLI-leg sample measured at the time of writing. The floor must clear it
// with real headroom, or the fix is decorative.
const OBSERVED_CLI_LEG_MAX_MS = 13_400;

describe('BG_LLM_TIMEOUT_MS (background LLM budget)', () => {
  it('clears the measured CLI-leg cost with at least 2x headroom', () => {
    expect(BG_LLM_TIMEOUT_MS).toBeGreaterThanOrEqual(OBSERVED_CLI_LEG_MAX_MS * 2);
  });
});

describe('save-enrich asks for a CLI-aware budget', () => {
  it('passes at least BG_LLM_TIMEOUT_MS to the LLM call', async () => {
    const db = createTestDb();
    const { id } = saveObservation(db, {
      project: 'timeout--test',
      type: 'bugfix',
      content: 'Fixed the FTS trigger not firing after a schema rebuild',
    });
    let seen = null;
    await executeSaveEnrich(db, id, {
      callJson: async (_prompt, _model, opts) => {
        seen = opts;
        return null;
      },
    });
    db.close();
    expect(seen).not.toBeNull();
    // RED before the fix: save-enrich hard-coded 15000, below the CLI-leg cost.
    expect(seen.timeout).toBeGreaterThanOrEqual(BG_LLM_TIMEOUT_MS);
  });
});

describe('background LLM call sites use the shared constant, not a bare literal', () => {
  // FAILS-IF a background site is reverted to a hard-coded sub-floor timeout, or
  // a NEW background site lands with one. Scanning source (rather than calling
  // each site) is what makes a re-introduction visible without a live LLM.
  // `lib/llm-call.mjs` is where callLLM's `timeoutMs = BG_LLM_TIMEOUT_MS` default lives
  // since audit 2026-09-05 P1-2 moved it out of hook-shared.mjs, which now only
  // re-exports the name and therefore has no call site left to guard.
  const BACKGROUND_SITES = ['lib/save-enrich.mjs', 'hook-optimize.mjs', 'hook-llm.mjs', 'lib/llm-call.mjs'];

  // Per-file floor on how many LLM calls must carry the constant. Raise when a
  // file gains a call; never lower without saying why.
  const BG_TIMEOUT_USE_COUNTS = {
    'lib/save-enrich.mjs': 1,
    'hook-optimize.mjs': 5,
    'hook-llm.mjs': 2,
    'lib/llm-call.mjs': 1,
  };

  for (const file of BACKGROUND_SITES) {
    it(`${file} passes BG_LLM_TIMEOUT_MS at every LLM call it makes`, () => {
      const src = read(file);
      // A bare `toContain('BG_LLM_TIMEOUT_MS')` was satisfied by the IMPORT line:
      // deleting `timeout: BG_LLM_TIMEOUT_MS` from a call site or from all
      // five hook-optimize sites left the suite green while each call silently
      // fell back to its dispatcher default (10s / 15s) — the exact regression
      // this release exists to fix, and no numeric literal appears so the
      // sub-floor scan below cannot see it either.
      // Two call shapes carry it: an options object (`timeout: BG_...`) and
      // callLLM's own positional default / `callLLM(prompt, BG_...)`.
      const uses =
        (src.match(/timeout(?:Ms)?\s*[:=]\s*BG_LLM_TIMEOUT_MS/g) || []).length +
        (src.match(/\bcallLLM\([^)]*?,\s*BG_LLM_TIMEOUT_MS\s*\)/g) || []).length;
      expect(uses, `${file} has ${uses} timeout:BG_LLM_TIMEOUT_MS uses`).toBeGreaterThanOrEqual(
        BG_TIMEOUT_USE_COUNTS[file],
      );
    });

    it(`${file} hands no sub-floor literal to an LLM call`, () => {
      // Without this guard the comparisons below go vacuous the moment the
      // export is renamed away (`n < undefined` is false for every n).
      expect(typeof BG_LLM_TIMEOUT_MS).toBe('number');
      const src = read(file);
      // `timeout: 15000` / `callLLM(prompt, 20000)` shapes — any numeric literal
      // in the 1_000..29_999 band sitting in an LLM-call argument position.
      const offenders = [];
      for (const m of src.matchAll(/timeout(?:Ms)?\s*[:=]\s*(\d{4,5})\b/g)) {
        if (Number(m[1]) >= 1000 && Number(m[1]) < BG_LLM_TIMEOUT_MS) offenders.push(m[0]);
      }
      for (const m of src.matchAll(/\bcallLLM\([^)]*?,\s*(\d{4,5})\s*\)/g)) {
        if (Number(m[1]) >= 1000 && Number(m[1]) < BG_LLM_TIMEOUT_MS) offenders.push(m[0]);
      }
      expect(offenders).toEqual([]);
    });
  }
});

describe('latency-bound sites keep their tight budgets', () => {
  // The opposite-direction pin. A future "just floor everything" change would
  // turn lesson-bridge's fail-open into a 45s block on every PreToolUse Edit,
  // and make a deep-search rerank hold the MCP request open. Both must stay put.
  it('lesson-bridge keeps its 2.5s fail-open budget on the PreToolUse path', () => {
    expect(read('lib/lesson-bridge.mjs')).toMatch(/timeoutMs\s*=\s*2500\b/);
  });

  it('deep-search rerank keeps a request-sized budget, not the background one', () => {
    const src = read('rerank.mjs');
    expect(src).toMatch(/timeout:\s*20000\b/);
    expect(src).not.toContain('BG_LLM_TIMEOUT_MS');
  });

  it('the CLI helpers themselves stay budget-neutral (no blanket floor)', () => {
    const src = read('haiku-client.mjs');
    // callModelCLI / callHaikuCLI / callModelCLIAsync must forward the caller's
    // timeout untouched — the constant is a caller-side policy, not a clamp.
    expect(src).not.toMatch(/Math\.max\([^)]*BG_LLM_TIMEOUT_MS/);
  });
});
