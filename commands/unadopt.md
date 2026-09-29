---
name: unadopt
description: "Use when: user wants to remove the claude-mem-lite steering block from the current project (or from every project Claude Code knows about with --all). Removes the <cwd>/CLAUDE.md managed block + <cwd>/.claude/plugin_claude_mem_lite.md, the auto-written CLAUDE.local.md block and its .git/info/exclude entry, and cleans any legacy memory-dir residue. User content outside the sentinel is preserved. Benign no-op when not adopted."
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
4. The block auto-adopt keeps in `CLAUDE.local.md` at the git repository root (the
   file too, when nothing else is in it) and the lines it added to
   `.git/info/exclude`. Those lines stay while another worktree of the repository
   still has the block, or while a file the plugin created still holds your own
   notes. A `CLAUDE.local.md` that is a symbolic link is left alone.

It also cleans any leftover **legacy** memory-dir sentinel + detail doc for this
project (slug-scoped — other plugins' blocks survive).

## Flags

- `--force` — also remove a legacy memory-dir block lacking a state sidecar
- `--dry-run` — preview what would be removed; no writes
- `--all` — remove the CLAUDE.md managed block and the auto-written
  `CLAUDE.local.md` block from every project in Claude Code's known-project list
  (`projects` in `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`), plus sweep
  any legacy memory-dir sentinels. Slug-scoped, so user content and other plugins' blocks
  survive. A project Claude Code never opened isn't listed — `cd` into it and run
  `/unadopt` there. Pair with `--dry-run` to preview.
- `--status` — read-only adoption probe (mirrors `/adopt --status`)

## Note: the steering itself continues

`/unadopt` removes files, not the steering. A `CLAUDE.local.md` block the plugin
created is not written back; the text is added to each session's context instead
(`claude-mem-lite adopt --enable` lets it write the file again). A project whose
`CLAUDE.md` block you removed gets `CLAUDE.local.md` on the next session, unless the
plugin created one there before. To stop the steering: `claude-mem-lite adopt --disable`
(per project) or `MEM_NO_AUTO_ADOPT=1` (global).

## Aftermath

While the steering is still delivered, the conservative hook layer stays trimmed.
It returns to verbose mode (SessionStart `File Lessons` / `Key Context`, MCP
instructions `WHEN TO USE`) once steering is off — `adopt --disable` or
`MEM_NO_AUTO_ADOPT=1` — on the next session start.

!node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" unadopt $ARGUMENTS
