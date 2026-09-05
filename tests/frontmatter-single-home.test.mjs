// Audit 2026-09-02 P1-16: three frontmatter parsers, and they were not the same.
//
//   registry-importer.mjs         the shipped one, full
//   scripts/index-managed.mjs     byte-identical apart from `export` — 30 lines, the
//                                 largest duplicate block in the tree
//   scripts/convert-commands.mjs  a SIMPLIFIED cut: no `|` / `>` block support, no
//                                 JSON-array handling
//
// The third is what makes this more than tidiness. `description:` in a Claude Code
// SKILL.md is routinely a `|` block, and the simplified parser returned the literal `|`
// for it — so two scripts reading the same file wrote different registry rows depending on
// which one ran last, and `description` is the field the recommendation gate reads.
//
// Same round, same file pair: scripts/index-managed.mjs also carried its own copy of
// registry.mjs's FTS5 table + trigger DDL, and that copy had already drifted in its
// DOCUMENTATION — its comment claimed `trigger_patterns(5)` while the shipped bm25() call
// has always been 3,3,3,2,2,1,1,1.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { parseFrontmatter as importerParseFrontmatter } from '../registry-importer.mjs';
import { walkShipped, sweepShipped } from './shipped-tree.mjs';

// D#207: join(), never new URL('../X.mjs', import.meta.url).
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

describe('parseFrontmatter — one implementation', () => {
  it('the shipped re-export IS the lib function, not a copy of it', () => {
    expect(importerParseFrontmatter).toBe(parseFrontmatter);
  });

  it('parses the `|` block that the simplified copy got wrong', () => {
    // The exact divergence. The dropped parser returned '|' here.
    const { frontmatter } = parseFrontmatter(
      '---\nname: probe-skill\ndescription: |\n  Use when the registry needs\n  a multi-line description\n---\n# Body\n',
    );
    expect(frontmatter.name).toBe('probe-skill');
    expect(frontmatter.description).toBe('Use when the registry needs a multi-line description');
    expect(frontmatter.description).not.toBe('|');
  });

  it('parses the `>` fold block, the other half of the same branch', () => {
    // `if (val === '|' || val === '>')` is ONE line with two arms, and only the `|` arm was
    // covered: the v3.92.0 review deleted the `>` arm alone and all seven cases stayed
    // green. Both this file's header and the module's docblock name `|` AND `>` as what the
    // simplified parser lacked, so a half-covered branch left half the stated claim unpinned.
    const { frontmatter } = parseFrontmatter(
      '---\nname: n\ndescription: >\n  folded across\n  two source lines\n---\nbody\n',
    );
    expect(frontmatter.description).toBe('folded across two source lines');
    expect(frontmatter.description).not.toBe('>');
  });

  it('continues an unmarked description onto its indented lines', () => {
    // Not a `|` block — a plain scalar CONTINUED on the next indented line, which is the
    // other shape real SKILL.md files use and the reason the `description` special case
    // exists at all. Losing the continuation truncates the field silently.
    const { frontmatter } = parseFrontmatter(
      '---\nname: n\ndescription: first half\n  and the second half\nmodel: haiku\n---\nbody\n',
    );
    expect(frontmatter.description).toBe('first half and the second half');
    expect(frontmatter.model, 'the next key must still be picked up').toBe('haiku');
  });

  it('handles JSON arrays, quotes, CRLF and a missing block', () => {
    const { frontmatter } = parseFrontmatter('---\r\ntags: ["a", "b"]\r\nname: "quoted"\r\n---\r\nbody');
    expect(frontmatter.tags).toEqual(['a', 'b']);
    expect(frontmatter.name).toBe('quoted');
    const none = parseFrontmatter('# Just a body');
    expect(none.frontmatter).toEqual({});
    expect(none.body).toBe('# Just a body');
  });

  // Tree sweep, not a name list. The first cut of this guard named the three files the
  // parser had lived in — while its own comment said "three copies existed because nothing
  // stopped the third". Nothing stopped a fourth either: the v3.92.0 review added one to
  // `scripts/prompt-search-utils.mjs` and all seven cases stayed green.
  const DEFINE_RE = /function\s+parseFrontmatter\s*\(/;
  const PARSER_ALLOWED = new Set(['lib/frontmatter.mjs']);

  it('the sweep walks a plausible number of shipped modules', () => {
    // A walk returning [] would make the rule below pass vacuously.
    expect(walkShipped().length).toBeGreaterThan(60);
  });

  it('no other shipped file defines its own parser', () => {
    expect(sweepShipped(DEFINE_RE, PARSER_ALLOWED)).toEqual([]);
  });

  it('the three known consumers import the shared one', () => {
    // The sweep above proves nobody DEFINES a second parser; this proves the three files
    // that used to carry one now take it from the shared module rather than having simply
    // dropped the feature.
    for (const rel of [
      'registry-importer.mjs',
      'scripts/index-managed.mjs',
      'scripts/convert-commands.mjs',
    ]) {
      expect(read(rel), `${rel} must import the shared one`).toMatch(/frontmatter\.mjs'/);
    }
  });

  it('the sweep can say NO, and the one allowlisted file really does define it', () => {
    // Without the first arm a regex matching nothing reports a clean tree; without the
    // second, the allowlist could rot into a name that defines nothing while the rule reads
    // as enforced.
    expect('function parseFrontmatter(content) {').toMatch(DEFINE_RE);
    for (const rel of PARSER_ALLOWED) {
      expect(read(rel), `${rel} is allowlisted but defines no parser`).toMatch(DEFINE_RE);
    }
  });
});

describe('registry FTS5 DDL — one definition', () => {
  it("index-managed uses registry.mjs's blocks instead of its own", () => {
    const src = read('scripts/index-managed.mjs')
      .split('\n')
      .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(src).toMatch(/FTS5_SCHEMA,\s*TRIGGERS_SCHEMA\s*\}\s*from\s*'\.\.\/registry\.mjs'/);
    expect(src, 'must not re-declare the virtual table').not.toMatch(
      /CREATE VIRTUAL TABLE[\s\S]{0,80}resources_fts/,
    );
    expect(src, 'must not re-declare the sync triggers').not.toMatch(/CREATE TRIGGER\s+res_fts_/);
  });

  it('the stale BM25 weight comment is gone from every copy', () => {
    // The drift was in the DOCUMENTATION before it was anywhere else: `trigger_patterns(5)`
    // against a shipped bm25(resources_fts, 3,3,3,2,2,1,1,1). A reader tuning against the
    // comment would have been tuning a weight that does not exist.
    for (const rel of ['registry.mjs', 'registry-retriever.mjs', 'scripts/index-managed.mjs']) {
      expect(read(rel), `${rel} still claims trigger_patterns(5)`).not.toMatch(/trigger_patterns\(5\)/);
    }
    // The sweep can fire, and the real weights are where the comment points.
    expect('// BM25 weights: trigger_patterns(5), keywords(3)').toMatch(/trigger_patterns\(5\)/);
    // The SQL writes them as floats (`3.0`) while every doc comment writes integers (`3`).
    // Match the SQL as it actually is — the first cut of this assertion required integers
    // and failed against the shipped call, which is the wrong direction for a guard whose
    // whole subject is documentation drifting away from code.
    //
    // Count and assert EVERY call, do not `toMatch` the file. `registry-retriever.mjs`
    // contains three identical `bm25(resources_fts, …)` calls and a whole-file `toMatch`
    // passes when any ONE of them matches — the v3.92.0 review changed only the third and
    // the case stayed green, so two of the three weights this test names could drift while
    // it read as enforced.
    const src = read('registry-retriever.mjs');
    const calls = src.match(/bm25\(resources_fts,[^)]*\)/g) || [];
    expect(calls.length, 'no bm25(resources_fts, …) call found — the anchor moved').toBeGreaterThan(0);
    const WEIGHTS =
      /^bm25\(resources_fts,\s*3(?:\.0)?,\s*3(?:\.0)?,\s*3(?:\.0)?,\s*2(?:\.0)?,\s*2(?:\.0)?,\s*1(?:\.0)?,\s*1(?:\.0)?,\s*1(?:\.0)?\)$/;
    calls.forEach((call, i) => {
      expect(call, `bm25 call #${i + 1} of ${calls.length} carries different weights`).toMatch(WEIGHTS);
    });
  });
});
