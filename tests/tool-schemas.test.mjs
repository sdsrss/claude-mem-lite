// Task 5: Discouragement-style MCP tool descriptions
// Every tool in `tool-schemas.mjs` must carry both "DO NOT use when" and
// "USE when" markers, and keep authored prose under 760 chars (the CLI path is
// excluded — it is environment-dependent; see D#38). This test is the contract
// that blocks encouragement-style descriptions from slipping back in.

import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import { tools } from '../tool-schemas.mjs';
import { CLI_INVOKE } from '../cli-path.mjs';

// Bound the AUTHORED description, not the rendered string. Every "Equivalent
// CLI:" line embeds CLI_INVOKE = `node <abs path to cli.mjs>` (resolved from
// import.meta.url), so description.length is environment-dependent: identical
// source measured 778 locally vs 797 in CI, and at v3.1.2 that ~19-char swing
// pushed the longest tool to 802 and red-ed the release (D#38). Strip the
// volatile invoke string before measuring so local-green == CI-green. 760 ≈ the
// budget the old <800 check already enforced on the canonical dev path
// (800 − the 43-char local "node <path>"), keeping the longest current
// description (mem_save, 735 authored) at ~25 chars headroom.
const MAX_AUTHORED_DESCRIPTION = 760;
const authoredLength = (desc) => desc.split(CLI_INVOKE).join('').length;

describe('MCP tool descriptions use discouragement style', () => {
  test('there are exactly 18 tools (9 core + 9 hidden)', () => {
    expect(tools).toHaveLength(18);
    const core = tools.filter((t) => !t.hidden);
    const hidden = tools.filter((t) => t.hidden === true);
    expect(core, 'core count').toHaveLength(9);
    expect(hidden, 'hidden count').toHaveLength(9);
  });

  test('core (unhidden) names are the contract-critical nine', () => {
    const coreNames = tools
      .filter((t) => !t.hidden)
      .map((t) => t.name)
      .sort();
    // The original six back the claude-mem-lite invited-memory contract; the
    // three mem_defer_* tools (v2.70) are first-class carry-forward primitives.
    // Changing this list is an MCP surface-area change — update adopt-content.mjs
    // and CLAUDE.md in the same PR.
    expect(coreNames).toEqual([
      'mem_defer',
      'mem_defer_drop',
      'mem_defer_list',
      'mem_get',
      'mem_recall',
      'mem_recent',
      'mem_save',
      'mem_search',
      'mem_timeline',
    ]);
  });

  test('hidden names are the maintenance/admin/specialized nine', () => {
    const hiddenNames = tools
      .filter((t) => t.hidden === true)
      .map((t) => t.name)
      .sort();
    expect(hiddenNames).toEqual([
      'mem_browse',
      'mem_compress',
      'mem_delete',
      'mem_export',
      'mem_fts_check',
      'mem_maintain',
      'mem_optimize',
      'mem_stats',
      'mem_update',
    ]);
  });

  test('hidden flag is boolean-true (not truthy-string) when set', () => {
    for (const tool of tools) {
      if ('hidden' in tool) {
        expect(tool.hidden, `${tool.name} hidden must be true`).toBe(true);
      }
    }
  });

  test('every tool has name, description, inputSchema', () => {
    for (const tool of tools) {
      expect(tool, 'tool object').toBeTruthy();
      expect(typeof tool.name, `${tool && tool.name} name is string`).toBe('string');
      expect(tool.name, 'name non-empty').toMatch(/^mem_/);
      expect(typeof tool.description, `${tool.name} description is string`).toBe('string');
      expect(tool.inputSchema, `${tool.name} has inputSchema`).toBeTruthy();
    }
  });

  test.each(
    // vitest .each wants an array; map to [name, tool] pairs for nicer labels
    [
      'mem_search',
      'mem_recent',
      'mem_timeline',
      'mem_get',
      'mem_delete',
      'mem_save',
      'mem_stats',
      'mem_compress',
      'mem_maintain',
      'mem_optimize',
      'mem_update',
      'mem_export',
      'mem_recall',
      'mem_fts_check',
      'mem_browse',
      'mem_defer',
      'mem_defer_list',
      'mem_defer_drop',
    ].map((n) => [n]),
  )('%s description has DO NOT / USE when markers and <760 authored chars', (name) => {
    const tool = tools.find((t) => t.name === name);
    expect(tool, `${name} not found in tools export`).toBeTruthy();
    expect(tool.description, `${name} missing "DO NOT use when"`).toMatch(/DO NOT use when/);
    expect(tool.description, `${name} missing "USE when"`).toMatch(/USE when/);
    expect(
      authoredLength(tool.description),
      `${name} authored description too long (CLI path excluded — see D#38)`,
    ).toBeLessThan(MAX_AUTHORED_DESCRIPTION);
  });

  test('every tool lists an Equivalent CLI line (or explicit "MCP only")', () => {
    for (const tool of tools) {
      expect(
        /Equivalent CLI:|MCP only/.test(tool.description),
        `${tool.name} should document its CLI equivalent (or mark MCP only)`,
      ).toBe(true);
    }
  });

  // The CLI uses positional subcommands for its dual-mode commands, not flags.
  // mem_fts_check's Equivalent CLI once read `fts-check [--rebuild]`, which the CLI
  // rejects (it expects `fts-check <check|rebuild>`) — so the documented LLM/Bash
  // fallback silently printed usage instead of rebuilding. Guard the subcommand form.
  test('mem_fts_check documents the subcommand form, not a --rebuild flag', () => {
    const tool = tools.find((t) => t.name === 'mem_fts_check');
    expect(tool).toBeTruthy();
    expect(tool.description).toMatch(/fts-check <check\|rebuild>/);
    expect(tool.description).not.toMatch(/fts-check\s+\[?--rebuild/);
  });
});

// ─── The advertised schema must agree with what the runtime enforces ────────────────────
//
// The MCP SDK publishes each tool's inputSchema as JSON Schema, and an agent plans its call
// from THAT — not from the zod shape. They disagreed on three tools, always in the same
// direction: a field the runtime rejects when omitted was advertised as optional, so the
// model omits it, the server answers `-32602 Invalid arguments`, and a round trip is spent
// discovering a requirement the schema was supposed to state. `mem_defer_drop.id` is the one
// that matters most — it is a CORE tool, listed in tools/list, so every agent sees it.
//
// The cause is `.pipe()`, not `z.preprocess()`, and the distinction is what makes this
// testable rather than guessable: zod 4's toJSONSchema({io:'input'}) treats a ZodPipe's input
// side as accepting `undefined` and drops the key from `required`. Isolated with a 5-arm
// probe — `preprocess` alone keeps the key (which is why mem_get.ids was always correct),
// `union(plain, string)` keeps it, and every shape wrapping a `.pipe()` loses it. So this is
// a property of the `coerceInt.pipe(...)` idiom, and the optional fields that use it are
// unaffected by construction. State the caliber rather than a bare "~20": the source carries
// 20 `coerceInt` mentions, while 34 optional fields have a ZodPipe anywhere in their chain —
// two different populations, and only the required ones could ever have been wrong. The
// 5-arm probe that isolated the cause was a scratch script and is not in the repo; what
// replaces it is the ground-truth sweep below, which re-derives the answer on every run.
//
// The assertion is written against GROUND TRUTH rather than a hand-maintained list of field
// names: for every tool and every field, omit the field and ask zod whether it complains.
// A list would have to be updated by whoever adds the next piped required field, which is
// exactly the person who will not know to.
describe('advertised JSON Schema `required` matches runtime enforcement', () => {
  test('no tool advertises a field as optional that the runtime rejects when omitted', () => {
    const mismatches = [];
    for (const tool of tools) {
      const obj = z.object(tool.inputSchema);
      const advertised = new Set(z.toJSONSchema(obj, { io: 'input', unrepresentable: 'any' }).required ?? []);
      const omittedAll = obj.safeParse({});
      for (const field of Object.keys(tool.inputSchema)) {
        const enforced =
          !omittedAll.success &&
          omittedAll.error.issues.some((i) => i.path.length > 0 && i.path[0] === field);
        if (enforced !== advertised.has(field)) {
          mismatches.push(
            `${tool.name}.${field}: advertised_required=${advertised.has(field)} runtime_enforced=${enforced}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  // The premise, asserted rather than assumed: if this ever reads 0 the test above has no
  // population and would pass on an empty tool list. Three tools carry a required piped
  // field today (mem_delete.ids, mem_update.id, mem_defer_drop.id).
  test('the required-field population it grades is non-empty', () => {
    const required = tools.flatMap((tool) => {
      const obj = z.object(tool.inputSchema);
      const bad = obj.safeParse({});
      if (bad.success) return [];
      return [...new Set(bad.error.issues.map((i) => i.path[0]))].map((f) => `${tool.name}.${f}`);
    });
    expect(required.length).toBeGreaterThanOrEqual(5);
  });
});

// ─── The advertised BOUNDS must agree with what the runtime enforces ────────────────────
//
// Same `.pipe()` blind spot as the `required` sweep above, one layer down: zod 4 renders a
// ZodPipe's INPUT side, so `coerceInt.pipe(z.number().int().min(1).max(100))` published the
// bare `z.number().int()` — i.e. the safe-integer range — and the real 1..100 never reached
// the model. Measured before the fix: 20 of 36 constrained fields disagreed, every one of
// them in the direction that invites a rejected call. `mem_compress.age_days` advertised
// ±9007199254740991 while the runtime demands >= 30, and `mem_delete.ids` — a DESTRUCTIVE
// tool — advertised no array bounds at all against an enforced 1..50.
//
// Graded against ground truth, not a hand-kept list: the io:'output' rendering is what the
// runtime actually validates, so any field where the two renderings differ is a field whose
// published contract is false. Same reason as above — a list would have to be updated by
// whoever adds the next piped bound, which is exactly the person who will not know to.
describe('advertised JSON Schema bounds match runtime enforcement', () => {
  const BOUND_KEYS = [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
  ];

  /** Collect every constrained node of a JSON Schema, keyed by its path. */
  const boundsByPath = (schema) => {
    const out = {};
    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return;
      if (BOUND_KEYS.some((k) => node[k] !== undefined)) {
        out[path] = JSON.stringify(Object.fromEntries(BOUND_KEYS.map((k) => [k, node[k]])));
      }
      if (node.properties) for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`);
      if (node.items) walk(node.items, `${path}[]`);
      if (Array.isArray(node.anyOf)) node.anyOf.forEach((v, i) => walk(v, `${path}|${i}`));
    };
    walk(schema, '');
    return out;
  };

  const renderings = () =>
    tools.map((tool) => {
      const obj = z.object(tool.inputSchema);
      return {
        name: tool.name,
        advertised: boundsByPath(z.toJSONSchema(obj, { io: 'input', unrepresentable: 'any' })),
        enforced: boundsByPath(z.toJSONSchema(obj, { io: 'output', unrepresentable: 'any' })),
      };
    });

  test('no tool advertises a bound the runtime does not enforce', () => {
    const mismatches = [];
    for (const { name, advertised, enforced } of renderings()) {
      for (const path of new Set([...Object.keys(advertised), ...Object.keys(enforced)])) {
        if (advertised[path] !== enforced[path]) {
          mismatches.push(`${name}${path}: advertised=${advertised[path]} enforced=${enforced[path]}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  // The premise, asserted rather than assumed: the sweep above passes vacuously on a tool
  // set with no bounded field at all. 36 constrained fields exist today.
  test('the bounded-field population it grades is non-empty', () => {
    const count = renderings().reduce((n, r) => n + Object.keys(r.enforced).length, 0);
    expect(count).toBeGreaterThanOrEqual(30);
  });

  // The bounds a caller most likely trips, pinned by value so a future refactor that
  // publishes the safe-integer range again fails with a readable name rather than a diff.
  test('the narrow bounds a caller would otherwise guess wrong are published', () => {
    const published = Object.fromEntries(
      tools.map((t) => [
        t.name,
        z.toJSONSchema(z.object(t.inputSchema), { io: 'input', unrepresentable: 'any' }),
      ]),
    );
    expect(published.mem_recent.properties.limit).toMatchObject({ minimum: 1, maximum: 100 });
    expect(published.mem_compress.properties.age_days).toMatchObject({ minimum: 30, maximum: 365 });
    expect(published.mem_maintain.properties.retain_days).toMatchObject({ minimum: 7, maximum: 365 });
    expect(published.mem_defer.properties.priority).toMatchObject({ minimum: 1, maximum: 3 });
    expect(published.mem_delete.properties.ids).toMatchObject({ minItems: 1, maxItems: 50 });
  });
});
