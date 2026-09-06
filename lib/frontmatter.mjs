// lib/frontmatter.mjs — the ONE YAML-frontmatter parser for skill/agent markdown.
//
// Audit 2026-09-02 P1-16. There were three, and they were not all the same:
//
//   scripts/index-managed.mjs  byte-identical to it apart from the `export` keyword —
//                              30 lines, the largest duplicate block in the tree
//   scripts/convert-commands.mjs  a SIMPLIFIED cut with no `|` / `>` block support and no
//                              JSON-array handling, i.e. already diverged
//
// The divergence is the part that matters: `description:` in a Claude Code SKILL.md is
// routinely a `|` block, and the simplified parser returned the literal `|` for it. Two
// scripts reading the same files with different parsers produce different registry rows
// depending on which one last ran.
//
// Zero dependencies on purpose — it is imported by a shipped module
// and by two dev scripts, so it must not drag anything into either.

/**
 * Split `---`-delimited YAML frontmatter from a markdown body.
 *
 * Not a YAML parser, and deliberately so: it handles the subset Claude Code skill and
 * agent files actually use — scalars, quoted scalars, JSON-ish arrays, and `|` / `>`
 * blocks — and leaves anything else as the raw string rather than guessing.
 *
 * The `description` special case is load-bearing rather than defensive: a description
 * written as a plain scalar is very often CONTINUED on the following indented lines
 * without a block marker, and dropping the continuation silently truncates the one field
 * the recommendation gate reads.
 *
 * @param {string} content full file text
 * @returns {{frontmatter: Record<string, unknown>, body: string}}
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { frontmatter: {}, body: content };

  const raw = match[1];
  const body = content.slice(match[0].length).trim();
  const fm = {};
  let currentKey = null,
    currentValue = '',
    inMultiline = false;

  for (const line of raw.split('\n')) {
    if (inMultiline && (line.startsWith('  ') || line.startsWith('\t') || line.trim() === '')) {
      currentValue += ' ' + line.trim();
      continue;
    }
    if (inMultiline && currentKey) {
      fm[currentKey] = currentValue.trim();
      inMultiline = false;
    }

    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)/);
    if (kv) {
      currentKey = kv[1];
      let val = kv[2].trim();
      if (val === '|' || val === '>') {
        inMultiline = true;
        currentValue = '';
        continue;
      }
      if (val.startsWith('[') && val.endsWith(']')) {
        try {
          fm[currentKey] = JSON.parse(val);
        } catch {
          fm[currentKey] = val;
        }
        continue;
      }
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (currentKey === 'description' && val) {
        inMultiline = true;
        currentValue = val;
        continue;
      }
      fm[currentKey] = val;
    }
  }
  if (inMultiline && currentKey) fm[currentKey] = currentValue.trim();
  return { frontmatter: fm, body };
}
