// D#194 — a hand-rolled unused-export check for the two modules knip cannot see.
//
// knip drops a module out of its unused-export report entirely once ANY file in
// the analysed tree names it in `new URL('../X.mjs', import.meta.url)`. Both
// pool-replay benchmarks and their tests reference hook-context.mjs and
// hook-memory.mjs that way (they read the file's TEXT and regex-rewrite the pool
// constants), so both modules are invisible: a dead export added to either is
// not reported, and CLAUDE.md's "46 unused exports / byte-identical name set"
// baseline carries zero information about them.
//
// Re-verified 2026-09-02 with the probe from D#194: appending
// `export const __KNIP_PROBE__ = 1;` to hook-context.mjs leaves knip's list
// unchanged (0 hits), while the same append to tier.mjs appears (1 hit).
//
// Why this is stricter than a text search: KEYCTX_POOL_OBS / KEYCTX_POOL_SESS
// DO appear in benchmark/keyctx-pool-replay.mjs — as a regex over the file's
// source text, not as an import. A grep-based guard would count that as a
// consumer and pass. This resolves real import edges instead, so those two land
// in the allowlist where they belong, explicitly, with a reason.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, basename, dirname } from 'path';

// Built with dirname()+join() rather than `new URL('..', import.meta.url)`:
// the URL form is itself what blinds knip to a module (this file's whole
// subject), so a guard for that blind spot must not widen it. Measured on the
// sibling D#202 test: the URL form removed
// `lib/citation-tracker.mjs:extractInjectedFromSubagentPrompt` from knip's name
// set; switching to join() put it back. No change is visible for the two
// modules below — the pool-replay benchmarks still name them the URL way — but
// this file stops being a second cause, so parking those benchmarks would now
// actually restore visibility.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Modules knip is structurally blind to (D#194). */
const BLIND_MODULES = ['hook-context.mjs', 'hook-memory.mjs'];

/**
 * Exports with no import edge that are kept anyway. Every entry needs a reason,
 * and the test fails if one of them GAINS a consumer — an allowlist that cannot
 * shrink is just a raised baseline.
 */
const INTENTIONAL_UNCONSUMED = {
  KEYCTX_POOL_OBS: 'Key Context pool bound. benchmark/keyctx-pool-replay.mjs varies it by '
    + 'rewriting the declaration in the file TEXT, so there is no import edge to find. '
    + 'Exported so the constant is addressable and documented at one site.',
  KEYCTX_POOL_SESS: 'Same as KEYCTX_POOL_OBS — twin-patched by regex, never imported.',
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', '.claude']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

/** Top-level export NAMES declared in a module (declarations + `export { … }`). */
function declaredExports(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const token = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (token) names.add(token);
    }
  }
  return names;
}

/**
 * Names of `mod` actually imported by `src` — named imports plus, when `src`
 * takes a namespace import, every `ns.NAME` member it reads.
 */
function importedNames(src, mod) {
  const found = new Set();
  const modRe = new RegExp(`['"\`][^'"\`]*${mod.replace('.', '\\.')}['"\`]`);
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+(['"][^'"]+['"])/g)) {
    if (!modRe.test(m[2])) continue;
    const clause = m[1];
    const named = /\{([\s\S]*?)\}/.exec(clause);
    if (named) {
      for (const part of named[1].split(',')) {
        const token = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (token) found.add(token);
      }
    }
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) {
      for (const use of src.matchAll(new RegExp(`\\b${ns[1]}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
        found.add(use[1]);
      }
    }
  }
  return found;
}

describe('knip blind-spot guard (D#194)', () => {
  const files = walk(ROOT);

  it.each(BLIND_MODULES)('%s has no unreviewed dead exports', (mod) => {
    const src = readFileSync(join(ROOT, mod), 'utf8');
    const declared = declaredExports(src);
    expect(declared.size).toBeGreaterThan(0);

    const consumed = new Set();
    for (const f of files) {
      if (basename(f) === mod) continue;
      for (const n of importedNames(readFileSync(f, 'utf8'), mod)) consumed.add(n);
    }

    const unconsumed = [...declared].filter((n) => !consumed.has(n));
    const unexplained = unconsumed.filter((n) => !(n in INTENTIONAL_UNCONSUMED));
    expect(unexplained, `${mod}: exported but never imported, and not in INTENTIONAL_UNCONSUMED`).toEqual([]);

    // The allowlist must not rot: an entry that GAINED a consumer should be
    // removed, not left standing as a permanent exemption.
    const stale = Object.keys(INTENTIONAL_UNCONSUMED).filter((n) => declared.has(n) && consumed.has(n));
    expect(stale, `${mod}: these now have real importers — drop them from INTENTIONAL_UNCONSUMED`).toEqual([]);
  });

  // Self-check. The guard's whole value is that it can say no; a resolver bug
  // that returns "everything is consumed" would make both assertions above pass
  // vacuously on any input, which is exactly how the blind spot went unnoticed.
  it('SELF-CHECK: the resolver reports a fabricated export as unconsumed', () => {
    const src = `${readFileSync(join(ROOT, 'hook-context.mjs'), 'utf8')}\nexport const __FAKE_DEAD_EXPORT__ = 1;\n`;
    const declared = declaredExports(src);
    expect(declared.has('__FAKE_DEAD_EXPORT__')).toBe(true);

    const consumed = new Set();
    for (const f of files) {
      if (basename(f) === 'hook-context.mjs') continue;
      for (const n of importedNames(readFileSync(f, 'utf8'), 'hook-context.mjs')) consumed.add(n);
    }
    expect(consumed.has('__FAKE_DEAD_EXPORT__')).toBe(false);
    // …and a real one IS resolved, so the resolver is not simply returning empty.
    expect(consumed.has('selectWithTokenBudget')).toBe(true);
  });
});
