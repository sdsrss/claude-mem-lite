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
import { walkShipped, sweepShipped } from './shipped-tree.mjs';

// D#207: join(), never new URL('../X.mjs', import.meta.url).
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

describe('parseFrontmatter — one implementation', () => {
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

  it('the known consumer imports the shared one', () => {
    // The sweep above proves nobody DEFINES a second parser; this proves the file that
    // used to carry one now takes it from the shared module rather than having simply
    // dropped the feature. Two of the original three consumers (registry-importer.mjs,
    // scripts/index-managed.mjs) went with the skill-registry removal in 2026-09.
    for (const rel of ['scripts/convert-commands.mjs']) {
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
