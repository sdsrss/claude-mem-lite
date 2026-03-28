---
description: "Save content to memory — with explicit content, instructions, or auto-summarize current session. Use when: the user asks to remember something, after solving a non-obvious problem, or to capture key session findings"
---

# Memory Save

Save important content to your long-term memory database.

## Commands

- `/mem:memory <content>` — Save the given content directly to memory
- `/mem:memory` (no args) — Auto-summarize recent session highlights and save key findings

## Instructions

When the user invokes `/mem:memory`, determine the intent:

### With explicit content

If the user provides content after the command:

1. Analyze the content to determine appropriate type (decision, bugfix, feature, refactor, discovery, change)
2. Generate a concise title from the content
3. Call `mem_save` with:
   - `content`: the provided text
   - `title`: auto-generated title
   - `type`: inferred type (default: "discovery")
   - `importance`: 2 (notable — user explicitly requested save)

### With instructions/prompt

If the user provides instructions like "save the database schema we discussed" or "remember the fix for the auth bug":

1. Review recent conversation context
2. Extract the relevant information per the user's instruction
3. Call `mem_save` with extracted content, appropriate title and type, importance=2

### No arguments (auto-save)

If no content is provided:

1. Review the current session's recent key findings
2. Identify: decisions made, bugs fixed, patterns discovered, important code changes
3. For each significant finding (max 5), call `mem_save` with:
   - Clear title and structured content
   - Appropriate type and importance level (1=routine, 2=notable)
4. Skip trivial or already-saved items
5. Report what was saved in a concise summary

Always set importance=2 for explicit saves (user chose to save), importance=1 for auto-saves of routine items, importance=2 for auto-saves of notable discoveries.
