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

  it('no other file defines its own parser', () => {
    // Class sweep. Three copies existed because nothing stopped the third.
    const DEFINE_RE = /function\s+parseFrontmatter\s*\(/;
    for (const rel of ['registry-importer.mjs', 'scripts/index-managed.mjs', 'scripts/convert-commands.mjs']) {
      const src = read(rel).split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(src, `${rel} defines its own parseFrontmatter`).not.toMatch(DEFINE_RE);
      expect(src, `${rel} must import the shared one`).toMatch(/frontmatter\.mjs'/);
    }
    // …and the sweep can fire: this is the line that shipped in all three.
    expect('function parseFrontmatter(content) {').toMatch(DEFINE_RE);
  });
});

describe('registry FTS5 DDL — one definition', () => {
  it('index-managed uses registry.mjs\'s blocks instead of its own', () => {
    const src = read('scripts/index-managed.mjs').split('\n')
      .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(src).toMatch(/FTS5_SCHEMA,\s*TRIGGERS_SCHEMA\s*\}\s*from\s*'\.\.\/registry\.mjs'/);
    expect(src, 'must not re-declare the virtual table').not.toMatch(/CREATE VIRTUAL TABLE[\s\S]{0,80}resources_fts/);
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
    expect(read('registry-retriever.mjs'))
      .toMatch(/bm25\(resources_fts,\s*3(?:\.0)?,\s*3(?:\.0)?,\s*3(?:\.0)?,\s*2(?:\.0)?,\s*2(?:\.0)?,\s*1(?:\.0)?,\s*1(?:\.0)?,\s*1(?:\.0)?\)/);
  });
});
