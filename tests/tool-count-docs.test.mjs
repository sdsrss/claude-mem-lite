// R10 P2-19 — the tool counts in the docs are DERIVED, so derive them.
//
// Five places stated a tool count and three different answers were in circulation:
// README.md said 20 total / 11 hidden, README.zh-CN.md said 17 total / 6 core / 11 hidden,
// llms.txt said 20 / 11, docs/ARCHITECTURE.md said 9 listed + 11 hidden — while
// tool-schemas.mjs has said 18 = 9 + 9 since v5.0.0 removed mem_use and mem_registry.
// README's own hidden-tool table had nine rows the whole time, under a heading saying
// eleven, which is what makes a hand-maintained count worth replacing rather than
// re-correcting: it had already disagreed with the table directly beneath it.
//
// tests/tool-schemas.test.mjs carries a comment asking that CLAUDE.md be updated in the
// same PR as a tool-count change. This is that request, enforced, and widened to the four
// user-facing docs.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tools as TOOL_DEFS } from '../tool-schemas.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

const defs = Array.isArray(TOOL_DEFS) ? TOOL_DEFS : Object.values(TOOL_DEFS);
const hidden = defs.filter((d) => d.hidden === true);
const listed = defs.filter((d) => d.hidden !== true);
const TOTAL = defs.length;

describe('R10 P2-19 — every doc tool count matches tool-schemas.mjs', () => {
  it('the source of truth is readable and plausible', () => {
    expect(TOTAL, 'TOOL_DEFS did not enumerate; this whole file would pass vacuously').toBeGreaterThan(10);
    expect(listed.length + hidden.length).toBe(TOTAL);
    expect(listed.length).toBeGreaterThan(0);
    expect(hidden.length).toBeGreaterThan(0);
  });

  // Each entry: file, and the numbers that must appear near the word "tools" in it.
  for (const rel of ['README.md', 'README.zh-CN.md', 'llms.txt', 'docs/ARCHITECTURE.md']) {
    it(`${rel} states no tool count that contradicts the schema`, () => {
      const src = read(rel);
      // Any "<n> tools" / "<n> 个工具" / "<n> listed" / "<n> hidden" claim must be one of
      // the three true numbers. This catches a stale count without demanding a fixed
      // sentence shape, which is what let five prose variants drift apart.
      const claims = [
        // Number BEFORE the keyword: "18 tools", "9 hidden", "18 个工具".
        ...src.matchAll(/(\d+)\s*(?:tools\b|个工具|listed\b|hidden\b|个\s*\*\*隐藏|个\s*\*\*核心)/g),
        // Number AFTER it: "Hidden-but-callable (9, CLI-routed)", "核心（9 个…）". This form
        // walked straight past the first version of this guard — README.md kept
        // "Hidden-but-callable (11, CLI-routed)" through a pass that corrected every other
        // count in the same file, four lines above a table with nine rows in it.
        // Scoped to a **bold** heading run, which is where the tool tables put theirs. An
        // unscoped version matched `lib/*-core.mjs` (87 modules under lib/) in
        // docs/ARCHITECTURE.md — a module count, not a tool count. `[^*\n]` also means the
        // run cannot cross a `*`, which is what excludes that path glob.
        ...src.matchAll(/\*\*[^*\n]*?(?:hidden|core|隐藏|核心)[^*\n]*?[(（]\s*(\d+)/gi),
      ].map((m) => Number(m[1]));
      const allowed = new Set([TOTAL, listed.length, hidden.length]);
      const bad = claims.filter((n) => !allowed.has(n));
      expect(
        bad,
        `${rel} states tool counts ${JSON.stringify(bad)}; schema says total=${TOTAL}, listed=${listed.length}, hidden=${hidden.length}`,
      ).toEqual([]);
      expect(claims.length, `${rel} states no tool count at all — did the section move?`).toBeGreaterThan(0);
    });
  }

  it('the README hidden-tool table has one row per hidden tool', () => {
    // The count and the table drifted apart before; pin them to each other.
    const src = read('README.md');
    for (const d of hidden) {
      expect(src, `README does not document hidden tool ${d.name}`).toContain(`\`${d.name}\``);
    }
    for (const d of listed) {
      expect(src, `README does not document core tool ${d.name}`).toContain(`\`${d.name}\``);
    }
  });

  it('no doc still advertises a tool that no longer exists', () => {
    const live = new Set(defs.map((d) => d.name));
    for (const rel of ['README.md', 'README.zh-CN.md', 'llms.txt', 'docs/ARCHITECTURE.md']) {
      const src = read(rel);
      // Strict on purpose: a backticked `mem_*` in a doc reads as a tool you can call. If
      // you need to name a REMOVED tool as history, write it without backticks — that is
      // what the tool-count paragraph in README.md does, and the distinction is the whole
      // point (prose about the past vs. a name the reader will try to use).
      for (const name of [...src.matchAll(/`(mem_[a-z_]+)`/g)].map((m) => m[1])) {
        expect(live.has(name), `${rel} documents \`${name}\`, which tool-schemas.mjs does not define`).toBe(
          true,
        );
      }
    }
  });
});
