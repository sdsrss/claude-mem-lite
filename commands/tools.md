---
description: "Import skills and agents from GitHub repositories into the tool resource registry. Use when: looking for a skill to solve a problem, importing tools from a repo, or managing installed tools"
---

# Tool Import

Import skills and agents from GitHub repositories into the resource registry for intelligent dispatch.

## Commands

- `/mem:tools <github-url>` — Import all skills/agents from a GitHub repo
- `/mem:tools <github-url> <instructions>` — Import with specific instructions (add/remove specific items)
- `/mem:tools <instructions>` — Directly add/remove/modify tools by prompt (no URL needed)
- `/mem:tools` (no args) — Show current registry stats and import help

## Instructions

When the user invokes `/mem:tools`:

### With GitHub URL

1. Use WebFetch to fetch the repository README and skill/agent files:
   - Try `https://raw.githubusercontent.com/{owner}/{repo}/main/README.md`
   - Look for skill definitions (`.md` files with frontmatter), agent definitions, plugin.json
   - If the repo has a `commands/` directory, fetch skill files from there
2. Identify all skills and agents in the repository
3. For each tool found, extract metadata using your understanding of the content:
   - `name`: tool name (lowercase, hyphenated)
   - `resource_type`: "skill" or "agent"
   - `repo_url`: the GitHub URL
   - `intent_tags`: comma-separated intent keywords (what the tool helps with)
   - `domain_tags`: comma-separated technology/domain tags
   - `capability_summary`: one-line description of what the tool does
   - `trigger_patterns`: when to recommend this tool (natural language)
   - `keywords`: additional search terms
   - `tech_stack`: technology stack tags
   - `use_cases`: usage scenarios
4. Call `mem_registry(action="import", ...)` for each tool with extracted metadata
5. Call `mem_registry(action="reindex")` to update FTS5 index
6. Report imported tools in a table format

### With GitHub URL + instructions

If the user provides instructions after the URL:
- "only add the TDD skill" → import only matching tools from that repo
- "remove the old testing tool" → call `mem_registry(action="remove", ...)`
- Follow user instructions for selective add/remove/modify operations

### With instructions only (no URL)

If the user provides a prompt without a GitHub URL, parse the intent:

**Adding a tool:**
- "添加一个叫 my-linter 的 skill" or "add a skill called my-linter"
- → Ask for metadata (or infer from context): capability_summary, intent_tags, domain_tags, trigger_patterns
- → Call `mem_registry(action="import", name="my-linter", resource_type="skill", ...)`

**Removing a tool:**
- "删除 old-testing skill" or "remove the old-testing agent"
- → Call `mem_registry(action="remove", name="old-testing", resource_type="skill")`

**Listing/searching:**
- "有哪些 testing 相关的工具" or "list all agents"
- → Call `mem_registry(action="list", type="agent")` or search by keywords

**Modifying a tool:**
- "更新 my-linter 的描述" or "update tags for my-tool"
- → Call `mem_registry(action="import", ...)` with updated metadata (upsert)

Always call `mem_registry(action="reindex")` after any add/remove/modify operations.

### Without URL or instructions

If no arguments provided:
1. Call `mem_registry(action="stats")` to show current registry state
2. Call `mem_registry(action="list")` to show all registered tools
3. Explain usage examples
