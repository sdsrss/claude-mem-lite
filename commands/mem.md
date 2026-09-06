---
name: mem
description: "Use when: querying past work, managing memories, or checking project history"
---

# Memory

Search and browse your project memory efficiently.

## Quick Commands

- `/mem search <query>` — Search all memories (FTS5 full-text search)
- `/mem recent [n]` — Show recent N observations (default 5)
- `/mem recall <file>` — History for a file before editing
- `/mem timeline <id>` — Browse timeline around an observation
- `/mem save <text>` — Save a manual memory/note
- `/mem stats` — Show memory statistics
- `/mem cleanup` — Scan and interactively purge stale data
- `/mem cleanup [N]d` — Purge stale data older than N days (e.g. `cleanup 60d`)
- `/mem cleanup keep [N]d` — Purge stale data but retain last N days (e.g. `cleanup keep 14d`)

## Instructions

When the user invokes `/mem`, parse their intent:

- `/mem search <query>` → run `node ${CLAUDE_PLUGIN_ROOT}/cli.mjs search <query>` via Bash
- `/mem recent` or `/mem recent 20` → run `node ${CLAUDE_PLUGIN_ROOT}/cli.mjs recent [N]` via Bash
- `/mem recall <file>` → run `node ${CLAUDE_PLUGIN_ROOT}/cli.mjs recall <file>` via Bash
- `/mem timeline <id>` → run `node ${CLAUDE_PLUGIN_ROOT}/cli.mjs timeline --anchor <id>` via Bash
- `/mem save <text>` → call `mem_save` MCP tool with the text as content
- `/mem stats` → run `node ${CLAUDE_PLUGIN_ROOT}/cli.mjs stats` via Bash
- `/mem get <ids>` → run `node ${CLAUDE_PLUGIN_ROOT}/cli.mjs get <ids>` via Bash
- `/mem cleanup` → run `mem_maintain(action="scan")`, report pending purge count and stale items to user, ask for confirmation, then run `mem_maintain(action="execute", operations=["purge_stale"], confirm=true)` if confirmed. **`confirm=true` is required and is not optional politeness:** without it the call returns a dry-run PREVIEW and deletes nothing, while still succeeding — so you would report a cleanup that never happened.
- `/mem cleanup Nd` (e.g. `60d`) → same as above but add `retain_days=N` to only purge items older than N days. **`retain_days` must be between 7 and 365**; anything outside that range is rejected by the schema, so `/mem cleanup 3d` cannot be honoured — say so rather than silently substituting the default.
- `/mem cleanup keep Nd` (e.g. `keep 14d`) → same as above with `retain_days=N`, same 7–365 range.
- `/mem <query>` (no subcommand) → treat as search, run `node ${CLAUDE_PLUGIN_ROOT}/cli.mjs search <query>` via Bash

Use Bash commands first. For detailed data, use `node ${CLAUDE_PLUGIN_ROOT}/cli.mjs get <id>` via Bash.
