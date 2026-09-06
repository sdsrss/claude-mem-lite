// The maintain op NAME SET has three hand-maintained homes and they must not drift:
//
//   1. lib/maintain-core.mjs  ALL_MAINTAIN_OPS   — canonical; the CLI validates against it
//   2. tool-schemas.mjs       memMaintainSchema.operations (Zod z.enum) — what the model reads
//   3. lib/maintain-core.mjs  runMaintainOps      — what actually dispatches
//
// (2) stays hand-written rather than derived from (1) on purpose: an MCP tool schema is
// LLM-visible metadata, so rewriting that enum to import a constant is a change to agent
// routing, not a refactor. So this file diffs the SETS instead — the same shape as
// tests/audit-silent-20260814.test.mjs, which diffs the two hook sets for the same reason.
//
// The failure this prevents is concrete: add a ninth op to the CLI and forget the enum and
// `mem_maintain` rejects a documented operation; add it to the enum only and the CLI
// answers "Unknown operation(s)". Set equality is asserted, not counts — a count match
// with a renamed member is exactly the drift that gets shipped.
import { describe, it, expect } from 'vitest';
import { ALL_MAINTAIN_OPS, DEFAULT_MAINTAIN_OPS, runMaintainOps } from '../lib/maintain-core.mjs';
import { memMaintainSchema } from '../tool-schemas.mjs';

// Pull the literal members out of the Zod enum without depending on Zod internals
// beyond the documented `.options` accessor that z.enum exposes.
function zodEnumMembers(schema) {
  // memMaintainSchema.operations is `z.array(z.enum([...])).optional().describe(...)`.
  // Unwrap optional -> array -> element enum, tolerating wrapper nesting.
  let node = schema.operations;
  const seen = new Set();
  while (node && !seen.has(node)) {
    seen.add(node);
    if (Array.isArray(node.options)) return [...node.options];
    if (node.element) node = node.element;
    else if (node.unwrap && typeof node.unwrap === 'function') node = node.unwrap();
    else if (node._def?.innerType) node = node._def.innerType;
    else if (node._def?.type) node = node._def.type;
    else break;
  }
  return null;
}

describe('maintain op set — one set, three homes', () => {
  it('the Zod enum the model reads carries exactly the canonical set', () => {
    const members = zodEnumMembers(memMaintainSchema);
    // Premise: the extractor actually found the enum. Without this a broken unwrap
    // would return null/[] and the comparison below could pass vacuously.
    expect(Array.isArray(members), 'could not read memMaintainSchema.operations enum members').toBe(true);
    expect(members.length).toBeGreaterThan(0);

    // Set equality, order-insensitive: the enum's ORDER is deliberately not pinned
    // (it is LLM-visible text, free to be tuned), only its membership.
    expect([...members].sort()).toEqual([...ALL_MAINTAIN_OPS].sort());
  });

  it('the default run set is a subset of the valid set', () => {
    for (const op of DEFAULT_MAINTAIN_OPS) {
      expect(ALL_MAINTAIN_OPS, `default op "${op}" is not a valid op`).toContain(op);
    }
  });

  it('runMaintainOps dispatches on every op in the set (none is a dead name)', () => {
    // A name can sit in both lists and mean nothing — the validator would accept it and
    // the run would silently do nothing, which is the failure mode this whole area keeps
    // producing. Read the dispatcher's source and require each op name to appear in it.
    const src = runMaintainOps.toString();
    for (const op of ALL_MAINTAIN_OPS) {
      expect(
        src.includes(`'${op}'`) || src.includes(`"${op}"`),
        `runMaintainOps never mentions "${op}"`,
      ).toBe(true);
    }
  });

  it('the canonical set is frozen (a caller cannot mutate the shared list)', () => {
    expect(Object.isFrozen(ALL_MAINTAIN_OPS)).toBe(true);
  });
});
