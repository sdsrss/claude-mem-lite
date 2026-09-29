---
name: adopt
description: "Use when: user asks to increase claude-mem-lite's tool-invocation rate in the current project, or to (re)install the steering block. Writes a sentinel-wrapped managed block into <cwd>/CLAUDE.md plus a <cwd>/.claude/plugin_claude_mem_lite.md detail doc, and migrates away any legacy memory-dir sentinel. Runs automatically on SessionStart; use this to force it now. Run /unadopt to remove."
---

# /adopt

Install the claude-mem-lite **steering block** into the current project's
`CLAUDE.md` (the canonical home for project instructions — loaded by Claude Code
at system-prompt authority). This replaces the pre-v3.13 scheme that seeded the
project's memory-dir `MEMORY.md`; that polluted an index meant for the user's own
memories, and `MEMORY.md` carries no more weight than `CLAUDE.md` anyway.

This normally runs automatically on every SessionStart — invoke `/adopt` only to
force it immediately (e.g. after editing the block out by hand).

## What it writes

1. **`<cwd>/CLAUDE.md`** — a concise `<!-- claude-mem-lite:begin v1 -->…<!-- :end -->`
   managed block (trigger table → `mem_recall` / `mem_save` / `mem_defer`).
   Slug-scoped: only this block is managed; the rest of your `CLAUDE.md` is
   preserved verbatim. Auto-refreshes when the shipped content drifts.
2. **`<cwd>/.claude/plugin_claude_mem_lite.md`** — the full contract (tool tables,
   CLI cheatsheet, citation/decay + save discipline). First line is a
   `<!-- managed-by: claude-mem-lite -->` marker. Not auto-loaded; the CLAUDE.md
   block points to it and Claude reads it on demand.
3. **`<cwd>/.claude/.plugin_claude_mem_lite_state.json`** — drift-tracking sidecar.

It also **migrates** this project's legacy memory-dir sentinel away (strips the
`claude-mem-lite:*` block from `MEMORY.md` and deletes the old memory-dir detail
doc). Other plugins' blocks (e.g. `code-graph-mcp:*`) and your own prose survive.

## Flags

- `--force` — also force-clean a legacy memory-dir block lacking a state sidecar
- `--dry-run` — print intended writes without touching disk
- `--all` — legacy-cleanup sweep: strip the old memory-dir sentinel across **every**
  project at once. (It does NOT write CLAUDE.md blocks for other projects — their
  real paths can't be recovered from the encoded memdir slug; those adopt
  per-project on each one's next SessionStart.)
- `--status` — show this project's adoption + count of memdirs awaiting migration
- `--disable` / `--enable` — per-project opt-out of automatic SessionStart adopt

## Removal & opt-out

- `/unadopt` removes the CLAUDE.md block + `.claude/` detail doc (your prose stays).
- `claude-mem-lite adopt --disable` permanently stops auto-adopt for this project.
- `MEM_NO_AUTO_ADOPT=1` disables auto-adopt globally.
- `CLAUDE_MEM_NO_TEMPLATE_REFRESH=1` freezes the block against drift-refresh
  (keeps your hand-edits to the managed block).

## Conservative layer still active

Adoption does NOT remove the hook-based injection (SessionStart context,
UserPromptSubmit related-memory). Those remain as fallback. Post-adopt the MCP
`WHEN TO USE` section + the `File Lessons` / `Key Context` sections auto-trim,
since the CLAUDE.md block already carries the triggers at higher authority.

## Restart caveat for the MCP-instructions trim

The CLAUDE.md block + hook-layer trim apply on the **next SessionStart**. The MCP
server builds its instructions once at boot, so the MCP-instructions trim
(`WHEN TO USE` / `Decision rules`) only takes effect after Claude Code restarts
(or re-attaches the mem-lite MCP server). A `/exit` + fresh session is enough.
Same caveat applies in reverse for `/unadopt`.

!node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" adopt $ARGUMENTS
