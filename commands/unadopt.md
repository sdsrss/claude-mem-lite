---
name: unadopt
description: "Use when: user wants to remove the claude-mem-lite steering block from the current project (or from every project Claude Code knows about with --all). Removes the <cwd>/CLAUDE.md managed block + <cwd>/.claude/plugin_claude_mem_lite.md and cleans any legacy memory-dir residue. User content outside the sentinel is preserved. Benign no-op when not adopted."
---

# /unadopt

Remove the claude-mem-lite steering block from the current project. Opposite of
`/adopt`.

## What it removes

1. The `<!-- claude-mem-lite:begin vN --> … <!-- claude-mem-lite:end -->` managed
   block from `<cwd>/CLAUDE.md`. Everything else in the file is preserved
   byte-for-byte.
2. `<cwd>/.claude/plugin_claude_mem_lite.md` detail doc.
3. `<cwd>/.claude/.plugin_claude_mem_lite_state.json` sidecar (and an emptied
   `.claude/` dir).

It also cleans any leftover **legacy** memory-dir sentinel + detail doc for this
project (slug-scoped — other plugins' blocks survive).

## Flags

- `--force` — also remove a legacy memory-dir block lacking a state sidecar
- `--dry-run` — preview what would be removed; no writes
- `--all` — remove the CLAUDE.md managed block from every project in Claude
  Code's known-project list (`~/.claude.json` `projects`), plus sweep any legacy
  memory-dir sentinels. Slug-scoped, so user content and other plugins' blocks
  survive. A project Claude Code never opened isn't listed — `cd` into it and run
  `/unadopt` there. Pair with `--dry-run` to preview.
- `--status` — read-only adoption probe (mirrors `/adopt --status`)

## Note: this does not stop auto-adopt

`/unadopt` removes the block now, but the next SessionStart re-adopts unless you
also disable it: `claude-mem-lite adopt --disable` (per-project) or
`MEM_NO_AUTO_ADOPT=1` (global).

## Aftermath

Once unadopted, the conservative hook layer (SessionStart `File Lessons` /
`Key Context`, MCP instructions `WHEN TO USE`) returns to verbose mode on the
next session start.

!node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" unadopt $ARGUMENTS
