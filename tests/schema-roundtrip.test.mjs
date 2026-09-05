// Round-trip parity harness (Level 2 invariant from #8127 retro).
//
// Rule: every token format the CLI/MCP *render* must be *accepted* back through
// the matching MCP schema. "Be liberal in what you accept, conservative in what
// you send" (Postel's Law) — applied to LLM-mediated typed RPC where a zod
// reject becomes a silent LLM retry rather than a loud error. See #8126 / #8127.
//
// The harness enumerates canonical render shapes (#N / P#N / S#N / comma-list /
// JSON-array) and asserts each MCP schema that consumes ID tokens accepts every
// shape. When a new rendering site is added, extend RENDERED_TOKEN_FORMS here
// instead of hand-writing per-schema tests.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { memGetSchema, memTimelineSchema, memDeleteSchema } from '../tool-schemas.mjs';

const parse = (def, data) => z.object(def).safeParse(data);

// Shapes that any token-accepting schema must tolerate. Sourced from the render
// paths in mem-cli.mjs (renderObsRows / renderSessionRows / renderPromptRows)
// and server.mjs (mem_search / mem_get / mem_timeline content templates).
const SCALAR_FORMS = [
  { label: 'bare int', value: 42 },
  { label: 'bare string', value: '42' },
  { label: '#N string', value: '#42' },
  { label: 'P#N string', value: 'P#42' },
  { label: 'S#N string', value: 'S#42' },
  { label: 'lowercase p#N', value: 'p#42' },
  { label: 'lowercase s#N', value: 's#42' },
];

const ARRAY_FORMS = [
  { label: 'array mixed', value: [1, '#2', 'P#3', 'S#4'] },
  { label: 'comma-string mixed', value: '1,#2,P#3,S#4' },
  { label: 'JSON-array string', value: '[1,"P#2","S#3"]' },
  { label: 'single bare int', value: 1 },
  { label: 'single P#N string', value: 'P#1' },
];

describe('schema round-trip parity (#8127)', () => {
  describe('mem_get.ids accepts every rendered token shape', () => {
    for (const f of ARRAY_FORMS) {
      it(`accepts ${f.label}: ${JSON.stringify(f.value)}`, () => {
        const r = parse(memGetSchema, { ids: f.value });
        expect(r.success, r.success ? '' : JSON.stringify(r.error?.issues)).toBe(true);
      });
    }

    it('rejects malformed tokens at regex layer (loud failure, not silent strip)', () => {
      // Postel's Law boundary — we accept any rendered form but REJECT non-renderable
      // junk so callers get a clear error instead of silently losing a token.
      expect(parse(memGetSchema, { ids: ['garbage'] }).success).toBe(false);
      expect(parse(memGetSchema, { ids: ['42abc'] }).success).toBe(false);
      expect(parse(memGetSchema, { ids: ['#'] }).success).toBe(false);
    });
  });

  describe('mem_timeline.anchor accepts every rendered scalar shape', () => {
    for (const f of SCALAR_FORMS) {
      it(`accepts ${f.label}: ${JSON.stringify(f.value)}`, () => {
        const r = parse(memTimelineSchema, { anchor: f.value });
        expect(r.success, r.success ? '' : JSON.stringify(r.error?.issues)).toBe(true);
      });
    }

    it('rejects malformed anchor at regex layer', () => {
      expect(parse(memTimelineSchema, { anchor: 'junk' }).success).toBe(false);
      expect(parse(memTimelineSchema, { anchor: '##1' }).success).toBe(false);
    });
  });

  // mem_delete stays int-only by design (tests/cli.test.mjs:1795-1806 locks the
  // "delete rejects P#/S# with source-specific message" contract). This test
  // documents the intentional asymmetry so future drifts surface loudly.
  describe('mem_delete.ids intentionally stays int-only (non-destructive-on-prompt/session invariant)', () => {
    it('accepts bare ints', () => {
      expect(parse(memDeleteSchema, { ids: [1, 2], confirm: false }).success).toBe(true);
    });
    it('accepts comma-string of ints', () => {
      expect(parse(memDeleteSchema, { ids: '1,2,3', confirm: false }).success).toBe(true);
    });
    it('rejects P# prefix (by design — CLI cmdDelete test line ~1795 locks this)', () => {
      // memDeleteSchema uses coerceIntArray which drops non-numeric tokens during split.
      // "P#1" → NaN → filtered → empty array → min(1) fails.
      expect(parse(memDeleteSchema, { ids: 'P#1', confirm: false }).success).toBe(false);
    });
  });
});

// ─── D#N deferred tokens: get-only read surface (2026-07-18) ─────────────────
// defer list has always rendered "(D#92)"; mem_get must accept it back
// (round-trip rule above). Destructive/timeline schemas intentionally reject.
describe('D#N deferred tokens (get-only read surface)', () => {
  it('mem_get.ids accepts D#N / d#N / mixed arrays / comma-strings', () => {
    expect(parse(memGetSchema, { ids: ['D#92'] }).success).toBe(true);
    expect(parse(memGetSchema, { ids: ['d#92'] }).success).toBe(true);
    expect(parse(memGetSchema, { ids: [1, '#2', 'D#3'] }).success).toBe(true);
    expect(parse(memGetSchema, { ids: '1,D#2,P#3' }).success).toBe(true);
  });

  it('mem_delete.ids still rejects D#N (destructive stays int-only)', () => {
    expect(parse(memDeleteSchema, { ids: ['D#1'], confirm: false }).success).toBe(false);
  });

  it('mem_timeline.anchor rejects D#N loudly (deferred rows are not on the obs timeline)', () => {
    expect(parse(memTimelineSchema, { anchor: 'D#1' }).success).toBe(false);
  });
});
