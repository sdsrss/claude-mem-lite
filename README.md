[English](README.md) | [中文](README.zh-CN.md)

# claude-mem-lite

`claude-mem-lite` is a **persistent memory** (also called *long-term memory* or *cross-session context*) system for **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** — Anthropic's CLI coding agent. It runs as an **[MCP](https://modelcontextprotocol.io/) server** plus a set of Claude Code hooks, automatically capturing coding observations, decisions, and bug fixes during sessions, then providing hybrid full-text + semantic search to recall them later.

Compared to general-purpose LLM memory frameworks like [`mem0`](https://github.com/mem0ai/mem0) or the MCP reference [`memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) server, claude-mem-lite is purpose-built for Claude Code's hook lifecycle: episode batching cuts LLM calls 7–10× vs the original [claude-mem](https://github.com/thedotmack/claude-mem) (an estimated ~600× lower total cost — see the cost model below; this is an architecture estimate, not a measured benchmark), while the hybrid FTS5 + TF-IDF retriever benchmarks at 0.90 Recall@10 / 0.85 Precision@10
(see [Search Quality](#search-quality) for the reproduction command).

> 中文简介：claude-mem-lite 是 Claude Code 的轻量级**持久化记忆 / 长期记忆 / 跨会话上下文**插件，基于 MCP 协议 + 钩子机制，自动捕获编码会话中的决策、修复和上下文，并通过 FTS5 + TF-IDF 混合检索召回。详见 [中文 README](README.zh-CN.md)。

Zero external services. Single SQLite database. Minimal overhead.

## Why claude-mem-lite?

A ground-up redesign of [claude-mem](https://github.com/thedotmack/claude-mem), replacing its heavyweight architecture with a smarter, leaner approach.

### Architecture comparison

| | claude-mem (original) | claude-mem-lite |
|---|---|---|
| **LLM calls** | Every tool use triggers a Sonnet call | Only on episode flush (5-10 ops batched) |
| **LLM input** | Raw `tool_input` + `tool_output` JSON | Pre-processed action summaries |
| **Conversation** | Multi-turn, accumulates full history | Stateless single-turn extraction |
| **Noise filtering** | LLM decides via "WHEN TO SKIP" prompt | Deterministic code-level Tier 1 filter |
| **Runtime** | Long-running worker process (1.8MB .cjs) | On-demand spawn, exits immediately |
| **Dependencies** | Bun + Python/uv + Chroma vector DB | Node.js only (3 npm packages) |
| **Source size** | ~2.3MB compiled bundles | ~50KB readable source |
| **Data directory** | `~/.claude-mem/` | `~/.claude-mem-lite/` (hidden, auto-migrates) |

### Token & cost efficiency

For a typical 50-tool-call session (illustrative cost model — the ratios below are
architecture estimates derived from batch size, token counts, and model pricing, **not**
a measured end-to-end benchmark):

| | claude-mem | claude-mem-lite | Ratio (estimated) |
|---|---|---|---|
| LLM calls | ~50 (every tool use) | ~5-8 (per episode) | **~7-10x fewer** |
| Tokens per call | 1,000-5,000 (raw JSON + history) | 200-500 (summaries only) | **~5-10x smaller** |
| Total tokens | ~100K-250K | ~1K-4K | **~50-100x less** |
| Model cost | Sonnet ($3/$15 per M) | Haiku ($0.25/$1.25 per M) | **~12x cheaper** |
| Combined savings | | | **~600x lower cost (estimated)** |

### Quality comparison

| Dimension | Winner | Why |
|---|---|---|
| **Classification accuracy** | Tie | Both produce correct type/title/narrative |
| **Noise filtering** | **lite** | Code-level filtering is deterministic; LLM "WHEN TO SKIP" is unreliable |
| **Observation coherence** | **lite** | Episode batching groups related edits into one coherent observation |
| **Code-level detail** | original | Sees full diffs, but rarely useful for memory search |
| **Search recall** | Tie | Users search semantic concepts ("auth bug"), not code lines |
| **Hook latency** | **lite** | Async background workers; original blocks 2-5s per hook |

### Design philosophy

The original sends **everything to the LLM and hopes it filters well**. claude-mem-lite **filters first with code, then sends only what matters** to a smaller model. This is not a downgrade; it's a smarter architecture that produces equivalent search quality at a fraction of the cost.

### Comparison: memory systems for AI coding agents

How claude-mem-lite differs from the major neighbors in the LLM-memory space (verified May 2026):

| | **claude-mem-lite** | [`mem0`](https://github.com/mem0ai/mem0) | MCP reference [`memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) | [claude-mem](https://github.com/thedotmack/claude-mem) (original) |
|---|---|---|---|---|
| **Target client** | Claude Code only | Any LLM app via SDK | Any MCP client | Claude Code only |
| **Capture model** | Auto via hooks | Manual `memory.add()` | Manual tool calls (`create_entities`, `add_observations`) | Auto via hooks |
| **Code-aware retrieval** | FTS5 + 100+ synonym pairs (incl. CJK↔EN) | General-purpose | Generic graph nodes | Code-aware |
| **Search** | Hybrid: FTS5 BM25 + TF-IDF cosine via RRF | Hybrid: semantic + BM25 + entity linking | Knowledge-graph traversal | FTS5 + Chroma vector |
| **Storage** | Single local SQLite | Pluggable; Qdrant or configurable vector store | Single JSONL file (knowledge graph) | SQLite + Chroma |
| **LLM dependency** | Haiku per episode (5–10 ops batched) | LLM per add/search op | None (graph CRUD only) | Sonnet per tool call |
| **Setup** | One command (`/plugin install` or `npx`) | SDK integration + vector store config | MCP install (per-client) | Bun + Python + Chroma |

**When to pick which**: pick `mem0` if you need a memory layer for a non-Claude-Code app (your own agent, multiple LLM providers). Pick the MCP reference `memory` server if you specifically want a knowledge-graph data model and don't mind invoking memory tools by hand. Pick claude-mem-lite if you want zero-touch automatic capture purpose-built for Claude Code's hook lifecycle, with code-domain retrieval and no external services.

## Features

- **Automatic capture** -- Hooks into Claude Code lifecycle (PostToolUse, SessionStart, Stop, UserPromptSubmit) to record observations without manual effort
- **Hybrid search** -- FTS5 BM25 + TF-IDF vector cosine similarity, merged via Reciprocal Rank Fusion (RRF). FTS5 handles keyword matching; 512-dim TF-IDF vectors capture semantic similarity for recall beyond exact terms
- **Timeline browsing** -- Navigate observations chronologically with anchor-based context windows
- **Episode batching** -- Groups related file operations into coherent episodes before LLM encoding
- **Error-triggered recall** -- Automatically searches memory when Bash errors occur, surfacing relevant past fixes
- **Proactive file history** -- When editing a file, automatically shows relevant past observations for that file
- **Session summaries** -- LLM-generated summaries at session end (via background workers using `claude -p`)
- **Project-scoped context** -- Injects recent memory into `CLAUDE.md` and session startup for immediate context
- **Observation types** -- Categorized as `decision`, `bugfix`, `feature`, `refactor`, `discovery`, or `change`
- **Importance grading** -- LLM assigns 1-3 importance levels (routine / notable / critical) to each observation
- **Observation relations** -- Bidirectional links between related observations based on file overlap
- **User prompt capture** -- Records user prompts via UserPromptSubmit hook for intent tracking
- **Read file tracking** -- Tracks files read during sessions for richer episode context
- **Zero data loss** -- If LLM fails, observations are saved with degraded (inferred) metadata instead of being discarded
- **Two-tier dedup** -- Jaccard similarity (5-minute window) + MinHash signatures (7-day cross-session window) prevent duplicates
- **Synonym expansion** -- Abbreviations like `K8s`, `DB`, `auth` automatically expand to full forms in FTS5 search (100+ pairs including CJK↔EN cross-language mappings)
- **CJK synonym extraction** -- Unsegmented Chinese text is scanned for known vocabulary words (数据库→database, 搜索→search, etc.) enabling cross-language memory recall
- **Stop-word filtering** -- English stop words filtered from both TF-IDF vocabulary (reclaiming ~18% of vector dimensions) and FTS queries (preventing false negatives from noise terms like "how", "the", "does")
- **Persisted vocabulary** -- TF-IDF vocabulary persisted to `vocab_state` table, preventing vector staleness when document frequencies shift. Vectors stay valid until explicit rebuild
- **Pseudo-relevance feedback (PRF)** -- Top results seed expansion queries for broader recall
- **Concept co-occurrence** -- Shared concepts across observations expand search to related topics
- **Context-aware re-ranking** -- Active file overlap boosts relevance (exact match + directory-level half-weight)
- **Superseded detection** -- Marks older observations as outdated when newer ones cover the same files with higher importance
- **Adaptive time windows** -- Session startup recall uses velocity-based time windows (high/medium/low activity tiers)
- **Token-budgeted context** -- Greedy knapsack algorithm selects session-start context within a 2,000-token budget, prioritizing by recency and importance
- **Observation compression** -- Old low-value observations can be compressed into weekly summaries to reduce noise
- **Secret scrubbing** -- Automatic redaction of API keys, tokens, PEM blocks, connection strings, and 15+ credential patterns
- **Atomic writes** -- All file writes (episodes, CLAUDE.md) use write-to-tmp + rename to prevent corruption on crash
- **Robust locking** -- PID-aware lock files with automatic stale/orphan cleanup (>30s timeout or dead PID)
- **Stale session cleanup** -- Sessions active for >24h are automatically marked as abandoned on next start
- **Resource registry** -- Indexes installed skills and agents with FTS5 search, composite scoring, and invocation tracking; searchable via `mem_registry` MCP tool
- **Unified resource discovery** -- Shared filesystem traversal layer (`resource-discovery.mjs`) used by both runtime scanner and offline indexer, supporting flat directories, plugin nesting, and loose `.md` files
- **Domain synonym expansion** -- Registry search queries expand to domain synonyms (e.g., "fix" → debug, bugfix, troubleshoot, diagnose, repair)
- **Multi-provider LLM mode** -- Provider priority `ANTHROPIC_API_KEY` (direct Anthropic API) → `OPENROUTER_API_KEY` (OpenRouter, OpenAI-compatible — point it at any model via `OPENROUTER_MODEL`) → `claude -p` CLI fallback when no key is set
- **Lesson-learned indexing** -- `lesson_learned` field indexed in FTS5 with weight 8, making past debugging insights directly searchable
- **Cross-source normalization** -- `mem_search` normalizes scores across observations, sessions, and prompts before merging, preventing any source from dominating results
- **Exponential recency decay** -- Type-differentiated half-lives (decisions: 90d, discoveries: 60d, bugfixes: 14d, changes: 7d) consistently applied in all ranking paths
- **Prompt-time memory injection** -- UserPromptSubmit hook automatically searches and injects relevant past observations with recency and importance weighting
- **Smart skill invocation** -- Auto-loaded and searched managed skills/agents include portable `~` paths with `Read()` guidance; native plugin skills recommend `Skill("full:name")`; prevents `Skill()` misuse for managed resources that aren't registered with Claude Code's native handler
- **Dual injection dedup** -- `user-prompt-search.js` and `handleUserPrompt` coordinate via temp file to prevent duplicate memory injection
- **Plugin cache hook self-heal** -- Claude Code runtime reads plugin hooks from `~/.claude/plugins/cache/<mp>/<plugin>/<ver>/hooks/hooks.json`, not from the marketplace source. When `install.mjs`-managed `settings.json` hooks coexist with a stale cache `hooks.json` (e.g. from a previous marketplace install or a plugin auto-update), the runtime registers hooks twice → every session start / user prompt fires twice. `install.mjs` and `hook-update.mjs` now clear cache `hooks.json` in every version dir, and `hook.mjs session-start` self-heals on every session (gated by `hasInstallManagedHooks` so plugin-only users are not affected). `install.mjs status` reports cache pollution state (since v2.31.1/2.31.2).
- **Result-dedup cooldown** -- User-prompt memory injection uses result-overlap detection (>80% ID overlap → skip) instead of time-based cooldown, allowing topic switches within seconds while preventing redundant injections
- **OR query fallback** -- When AND-joined FTS5 queries return zero results, automatically relaxes to OR-joined queries for broader recall (applied in both user-prompt-search and hook-memory paths)
- **Configurable LLM model** -- Switch between Haiku (fast/cheap) and Sonnet (deeper analysis) via `CLAUDE_MEM_MODEL` env var
- **DB auto-recovery** -- Detects and cleans corrupted WAL/SHM files on startup; periodic WAL checkpoints prevent unbounded growth
- **Schema auto-migration** -- Idempotent `ALTER TABLE` migrations run on every startup, safely adding new columns and indexes without data loss
- **Exploration bonus** -- New resources in the registry get a fair chance in composite ranking; zombie resources (high recommend, zero adopt) are penalized in scoring
- **LLM concurrency control** -- File-based semaphore limits background workers to 2 concurrent LLM calls, preventing resource contention
- **stdin overflow protection** -- Hook input truncated at 256KB with regex-based action salvage for oversized tool outputs
- **Cross-session handoff** -- Captures session state (request, completed work, next steps, key files) on `/clear` or `/exit`, then injects context when the next session detects continuation intent via explicit keywords or FTS5 term overlap
- **Git-SHA continuation anchor** (v2.31.0) -- Handoff rows include `git_sha_at_handoff`; any handoff matching the current `HEAD` counts as continuation regardless of TTL. Code state is a stronger continuation signal than wall-clock time
- **Startup dashboard** (v2.31.0) -- SessionStart hook aggregates `git status` + `~/.claude/tasks/*.json` + `~/.claude/plans/*.md` + most-recent exit handoff + recent event count into a single structured block injected via `hookSpecificOutput.additionalContext`
- **Activity namespace** (v2.31.0) -- Dedicated `events` table + FTS5 for non-memdir types (`bugfix`, `lesson`, `bug`, `discovery`, `refactor`, `feature`, `observation`, `decision`) that don't compete with `WHAT_NOT_TO_SAVE` semantics on the observations table. CLI: `claude-mem-lite activity save|search|recent|show`. `hook-llm` routes non-memdir summary types through `persistHaikuSummary` so upgrades from observations→events are atomic. (v3.39: the `/lesson` and `/bug` slash commands were redirected from this events table to searchable **observations** — `mem_search` never read the events table, so explicit saves were unfindable; the events table remains the auto-capture activity log.)
- **In-place observation updates** -- `mem_update` tool modifies existing observations atomically (field update + FTS text rebuild + vector re-computation in one transaction), preserving original IDs and references
- **Bulk export** -- `mem_export` tool exports observations as JSON or JSONL, with project/type/date filtering and 1000-row pagination cap with batch guidance
- **FTS integrity management** -- `mem_fts_check` tool verifies FTS5 index health or rebuilds indexes on demand, useful after database recovery or when search results seem wrong
- **Atomic multi-table writes** -- `saveObservation` wraps observations + observation_files + observation_vectors INSERTs in a single `db.transaction()`, preventing orphaned rows on crash
- **Modular NLP pipeline** -- Synonym maps, stop words, scoring constants, and query building extracted into focused modules (`synonyms.mjs`, `stop-words.mjs`, `scoring-sql.mjs`, `nlp.mjs`) for independent testing and maintenance
- **Porter-aligned PRF** -- Pseudo-relevance feedback terms are now stemmed with the same Porter algorithm used by FTS5, ensuring PRF expansion terms match the search index

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| **Linux** | Supported | Primary development and testing platform |
| **macOS** | Supported | Fully compatible (Intel and Apple Silicon) |
| **Windows** | Not supported | Uses POSIX shell scripts (`post-tool-use.sh`, `setup.sh`) and Unix file locking; WSL2 may work but is untested |

## Requirements

- **Node.js** >= 20
- **Claude Code** CLI installed and configured (`claude` command available)
- **SQLite3** support (provided by `better-sqlite3`, compiled on install)
- **Platform**: Linux or macOS (see [Platform Support](#platform-support))

## Installation

### Method 1: Plugin Marketplace (recommended)

```bash
/plugin marketplace add sdsrss/claude-mem-lite
/plugin install claude-mem-lite
```

Plugin mode manages its own hooks/runtime. On session start it only **checks and reports** new claude-mem-lite versions; it does **not** self-overwrite plugin files in place. Update plugin-mode installs through Claude's plugin workflow.

> **The plugin install is complete on its own** — hooks, MCP tools, and the bundled slash commands (`/mem`, `/lesson`, `/bug`, `/adopt`) all run from the plugin with no second step. The slash commands invoke the bundled CLI by an absolute path resolved from the plugin directory (`${CLAUDE_PLUGIN_ROOT}/cli.mjs <cmd>`), so they work without anything on your `PATH`. A global `claude-mem-lite` **shell** command (for running queries yourself in a terminal) is **optional** — `npm i -g claude-mem-lite` — and is a *separate* npm install: the plugin's auto-update does **not** refresh it, so re-run `npm i -g claude-mem-lite@latest` if you want that shell command kept in sync. You do **not** need it for the plugin to be fully functional.

> **Auto-adopt writes into your project, on every SessionStart (v3.13+).** The plugin adds a slug-scoped **managed block** to your project's own **`<cwd>/CLAUDE.md`** — a file that is normally committed to git — plus a `<cwd>/.claude/plugin_claude_mem_lite.md` detail file. The block is a system-authority pointer that boosts Claude's proactive use of `mem_recall` / `mem_save`. Everything outside the block is preserved verbatim, and it coexists with other plugins' blocks in the same file ([details](#invited-memory-v232)). This happens on **every** SessionStart, not just the first: the sync is idempotent and re-applies the block if it is edited away, and refreshes it when the shipped template changes. It applies regardless of install path (npm, npx, `/plugin`, manual), so **no manual `/adopt` is needed**.
>
> Opt out per project with `claude-mem-lite adopt --disable` (`--enable` to re-arm), globally with `export MEM_NO_AUTO_ADOPT=1`, or freeze an already-adopted block against template refreshes with `CLAUDE_MEM_NO_TEMPLATE_REFRESH=1`. `claude-mem-lite unadopt` removes the block and the detail file. Manual `/adopt` remains available for re-applying after edits and for the `--all` batch path.

### Method 2: npx (one-liner)

```bash
npx github:sdsrss/claude-mem-lite
```

Source files are automatically copied to `~/.claude-mem-lite/` for persistence.

> **Note:** `npx github:…` installs from the repo's **default branch (HEAD)**, which can be ahead of the latest published release. For the stable released version use the npm package (`npx claude-mem-lite`), or pin a release tag: `npx github:sdsrss/claude-mem-lite#vX.Y.Z`.

### Method 3: git clone

```bash
git clone https://github.com/sdsrss/claude-mem-lite.git
cd claude-mem-lite
node install.mjs install
```

Source files stay in the cloned repo. Update via `git pull && node install.mjs install`.

### What happens during installation

1. **Install dependencies** -- `npm install --omit=dev` (compiles native `better-sqlite3`)
2. **Register MCP server** -- `mem-lite` server with 20 tools (9 core exposed via `tools/list` + 11 hidden-but-callable; see the Usage section for the full table). The pre-v2.78 generic server name `mem` is renamed to `mem-lite` for namespace hygiene; the tool names themselves (`mem_search`, `mem_recall`, ...) are unchanged.
3. **Configure hooks** -- `PostToolUse`, `SessionStart`, `Stop`, `UserPromptSubmit` lifecycle hooks
4. **Create data directory** -- `~/.claude-mem-lite/` (hidden) for database, runtime, and managed resource files
5. **Auto-migrate** -- If `~/.claude-mem/` (original claude-mem) or `~/claude-mem-lite/` (pre-v0.5 unhidden) exists, migrates database and runtime files to `~/.claude-mem-lite/`, preserving the original untouched
6. **Initialize database** -- SQLite with WAL mode, FTS5 indexes created on first server start

Restart Claude Code after installation to activate.

### Migration

All installation methods auto-detect and migrate from previous versions:

**From claude-mem (original `~/.claude-mem/`):**
- Copy `claude-mem.db` → `~/.claude-mem-lite/claude-mem-lite.db` (renamed)
- Copy the `runtime/` directory
- **Original `~/.claude-mem/` is preserved** (no deletion, no overwrite)

**From pre-v0.5 unhidden directory (`~/claude-mem-lite/`):**
- Entire directory is moved to `~/.claude-mem-lite/` (hidden)

**In-place rename:**
- Existing `claude-mem.db` in `~/.claude-mem-lite/` is automatically renamed to `claude-mem-lite.db`

Remove old directories manually after confirming:
```bash
rm -rf ~/.claude-mem/       # original claude-mem
rm -rf ~/claude-mem-lite/   # pre-v0.5 unhidden (if not auto-moved)
```

### Directory Structure

```
~/.claude-mem-lite/
  claude-mem-lite.db       # SQLite database — memory (WAL mode)
  resource-registry.db     # SQLite database — skill/agent registry
  runtime/
    session-<project>    # Active session state
    ep-<project>.json    # Episode buffer
    ep-flush-*.json      # Flushed episodes awaiting processing
    reads-<project>.txt  # Read file paths (collected on flush)
  managed/
    skills/              # Standalone skills: {name}/SKILL.md
    agents/              # Agent plugins: {group}/agents/{name}.md + skills/*/SKILL.md
    repos/               # Shallow-cloned source repos
```

## Usage

### MCP Tools (used automatically by Claude)

As of v2.70.0, the server registers 20 tools in total but only the 9 **core**
tools appear in `tools/list`. The 11 **hidden** tools remain callable at the
protocol layer (`tools/call` by exact name still routes normally); they're
omitted from the list response so Claude Code sessions don't load 11 extra
tool schemas at startup. Hidden tools are the maintenance / admin / browser
surface — reach them through the CLI column in the second table.

**Core (9, exposed to Claude Code)**

| Tool | Description |
|------|-------------|
| `mem_search` | FTS5 full-text search with BM25 ranking. Filters by type, project, date range, importance level. |
| `mem_recent` | Show most recent observations, ordered by time. Quick snapshot of latest activity. |
| `mem_recall` | Recall observations related to a file. Use before editing to surface past bugfixes and context. |
| `mem_timeline` | Browse observations chronologically around an anchor point. |
| `mem_get` | Retrieve full details for specific observation IDs (includes importance and related_ids). |
| `mem_save` | Manually save a memory/observation. Accepts `closes_deferred` array for transactional closure of deferred work. |
| `mem_defer` | Mark work for a future session (v2.70+). First-class carry-forward signal, surfaced in SessionStart `### Deferred Work` block. |
| `mem_defer_list` | List open deferred items for the current project. |
| `mem_defer_drop` | Drop a deferred item without fixing it; requires a `reason` for the audit trail. |

**Hidden-but-callable (11, CLI-routed)**

| Tool | CLI equivalent | Notes |
|------|----------------|-------|
| `mem_update` | `claude-mem-lite update <id>` | Edit an observation in place. |
| `mem_stats` | `claude-mem-lite stats` | Counts, type distribution, daily activity. |
| `mem_delete` | `claude-mem-lite delete <id>` | Preview / confirm workflow, FTS5 cleanup. |
| `mem_compress` | `claude-mem-lite compress` | Roll up old low-value observations (preview default; `--execute` to apply). |
| `mem_maintain` | `claude-mem-lite maintain scan --ops dedup,decay` | dedup / decay / cleanup / rebuild_vectors (`scan` previews, `execute` applies). |
| `mem_optimize` | `claude-mem-lite optimize` | LLM-powered re-enrich / normalize / cluster-merge (preview default; `--run` to apply). |
| `mem_export` | `claude-mem-lite export` | JSON / JSONL dump, filters by project, type, date. |
| `mem_fts_check` | `claude-mem-lite fts-check <check\|rebuild>` | FTS5 integrity + rebuild. |
| `mem_browse` | `claude-mem-lite browse` | Tier-grouped dashboard (working / active / archive). |
| `mem_registry` | `claude-mem-lite registry <action>` | List / search / import / remove skills + agents. |
| `mem_use` | _MCP only_ | Load a skill / agent from the registry by name. |

### Skill Commands (in Claude Code chat)

```
/mem search <query>        # Full-text search across all memories
/mem recent [n]            # Show recent N observations (default 10)
/mem recall <file>         # Show past observations for a file
/mem save <text>           # Save a manual memory/note
/mem stats                 # Show memory statistics
/mem timeline <query>      # Browse timeline around a match
/mem browse                # Tier-grouped memory dashboard
/mem <query>               # Shorthand for search
/lesson <text>             # Save a non-obvious lesson to the events table (v2.31.0)
/bug <text>                # Log a known bug + repro steps to the events table (v2.31.0)
```

### Efficient Search Workflow

```
1. mem_search(query="auth bug")     -> compact ID index
2. mem_timeline(anchor=12345)       -> surrounding context
3. mem_get(ids=[12345, 12346])      -> full details
```

### Invited Memory (v2.32+)

Opt-in mechanism that installs a slug-scoped managed block into the project's
own `CLAUDE.md` (plus an on-demand detail doc under `.claude/`) so Claude Code
loads the plugin's MCP-tool triggers as **project instructions** — a higher
instruction-following authority than MCP server instructions (which are framed
as tool metadata). Claude Code loads `CLAUDE.md` and the memdir `MEMORY.md` at
equal weight, so steering lives in `CLAUDE.md` (the canonical home for project
instructions) rather than polluting `MEMORY.md`, which is reserved for the user's
own memories. The pre-v3.13 scheme wrote into `MEMORY.md`; it is migrated away
automatically on the next SessionStart.

```bash
claude-mem-lite adopt              # install for current project
claude-mem-lite adopt --all        # install for every project under ~/.claude/projects/
claude-mem-lite adopt --status     # list adopted/disabled projects + current gating snapshot
claude-mem-lite adopt --dry-run    # preview without writing
claude-mem-lite adopt --disable    # opt out of auto-adopt for current project (writes .mem-no-auto-adopt sentinel)
claude-mem-lite adopt --enable     # re-arm auto-adopt for current project (deletes the sentinel)
claude-mem-lite unadopt            # remove sentinel + doc (runtime marker stays to honor the explicit removal)
```

Slash commands `/adopt` and `/unadopt` wrap the same CLI.

**What adoption changes:**
- A `<!-- claude-mem-lite:begin v1 -->…<!-- claude-mem-lite:end -->` managed
  block is added to `<cwd>/CLAUDE.md` under its own
  `## claude-mem-lite — persistent memory` header, containing a compact trigger
  table pointing at `mem_recall` / `mem_save` / `mem_defer` with their key
  arguments. The block is slug-scoped: only this region is managed; the rest of
  your `CLAUDE.md` is preserved verbatim, and it coexists with other plugins'
  blocks (e.g. `code-graph-mcp`) in the same file.
- A `<cwd>/.claude/plugin_claude_mem_lite.md` detail file is written (not
  auto-loaded; read on demand when the `CLAUDE.md` block points to it). The
  block auto-refreshes when the shipped content drifts (version bump or template
  change), unless `CLAUDE_MEM_NO_TEMPLATE_REFRESH=1`.
- Post-adopt the conservative hook layer auto-trims: MCP server instructions
  drop the `WHEN TO USE` section, SessionStart injection drops the `File Lessons`
  / `Key Context` sections. `#ID` references and the `Recent` table still fire
  so `mem_get` remains reachable.

**When does it take effect?**
- The `CLAUDE.md` managed block and the hook-layer trim (`File Lessons` /
  `Key Context` / lesson suffix) apply on the **next SessionStart** (any new
  Claude Code session in the adopted project).
- The MCP server instructions are built once at server boot and MCP has no
  "push" protocol — the `WHEN TO USE` / `Decision rules` trim only applies
  after Claude Code restarts and re-spawns the mem-lite MCP server. A single
  `/exit` + fresh session is enough. Same caveat applies to `unadopt`.

**Safety:**
- Hash-guarded: editing the managed-block body yourself blocks automatic
  rewrites unless you pass `--force`.
- Slug-scoped & dedup-guarded: only the `claude-mem-lite:begin…end` region is
  ever rewritten, and duplicate / CRLF-orphaned copies are collapsed to one.
  Unlike the legacy `MEMORY.md` scheme there is no line-budget gate — `CLAUDE.md`
  has no truncation cap.
- **Auto-adopt runs on EVERY SessionStart, for any install path (v2.82.1+;
  target moved from the memdir to `<cwd>/CLAUDE.md` in v3.13).** The sync is
  idempotent — it re-applies the managed block if it was edited away and
  refreshes it when the shipped template changes (freeze with
  `CLAUDE_MEM_NO_TEMPLATE_REFRESH=1`). Per-project opt-out: `claude-mem-lite adopt --disable`
  (writes a durable `<memdir>/.mem-no-auto-adopt` sentinel that survives marker
  deletion / plugin reinstalls). Global opt-out: `MEM_NO_AUTO_ADOPT=1`.
  Pre-v2.82.1 the `CLAUDE_PLUGIN_ROOT` gate left auto-adopt unreachable for
  every `install.mjs`-written hook (the common path) — see CHANGELOG v2.82.1.
- The fallback hook layer is never removed from source — conditional trim is
  runtime-gated on sentinel presence, so projects without adoption get the
  full verbose output.

See `docs/plans/2026-04-16-invited-memory-pattern.md` for the full design
(including the reusable template other plugins can follow).

## Database Schema

Five core tables with FTS5 virtual tables for search:

**observations** -- Individual coding observations (decisions, bugfixes, features, etc.)
```
id, memory_session_id, project, type, title, subtitle,
text, narrative, concepts, facts, files_read, files_modified,
importance, related_ids, created_at, created_at_epoch,
lesson_learned, minhash_sig, access_count, compressed_into, search_aliases,
branch, superseded_at, superseded_by, last_accessed_at
```

**session_summaries** -- LLM-generated session summaries
```
id, memory_session_id, project, request, investigated,
learned, completed, next_steps, files_read, files_edited, notes,
remaining_items, lessons, key_decisions
```

**sdk_sessions** -- Session tracking
```
id, content_session_id, memory_session_id, project,
started_at, completed_at, status, prompt_counter
```

**user_prompts** -- User prompts captured via UserPromptSubmit hook
```
id, content_session_id, prompt_text, prompt_number
```

**session_handoffs** -- Cross-session handoff snapshots (UPSERT, max 2 per project)
```
project, type, session_id, working_on, completed, unfinished,
key_files, key_decisions, match_keywords, created_at_epoch
```

**observation_files** -- Normalized file membership for efficient file-based recall
```
obs_id, filename
```

**observation_vectors** -- TF-IDF vector embeddings for hybrid search
```
observation_id, vector (BLOB Float32Array), vocab_version, created_at_epoch
```

**vocab_state** -- Persisted TF-IDF vocabulary for stable vector indexing
```
term, term_index, idf, version, created_at_epoch
```

FTS5 indexes: `observations_fts` (title, subtitle, narrative, text, facts, concepts, lesson_learned), `session_summaries_fts`, `user_prompts_fts`

## How It Works

### Hook Pipeline

```
SessionStart
  -> Generate session ID (or save handoff snapshot on /clear)
  -> Mark stale sessions (>24h active) as abandoned
  -> Clean orphaned/stale lock files
  -> Query recent observations (24h)
  -> Inject context into CLAUDE.md + stdout

PostToolUse (every tool execution)
  -> Bash pre-filter skips noise in ~5ms (Read paths tracked to reads file)
  -> Detect Bash significance (errors, tests, builds, git, deploys)
  -> Accumulate into episode buffer
  -> Proactive file history: show past observations for edited files
  -> Flush when: buffer full (10 entries) | 5min gap | context change
  -> Collect Read file paths into episode on flush
  -> Spawn LLM episode worker for significant episodes
  -> Error-triggered recall: search memory for related past fixes

UserPromptSubmit (two parallel paths)
  -> [user-prompt-search.js] Auto-search memory via FTS5 + active file context
  -> [user-prompt-search.js] Inject relevant past observations with recency/importance weighting
  -> [user-prompt-search.js] Write injected IDs to temp file for dedup
  -> [user-prompt-search.js] L1 skill auto-load: match managed skill names in prompt
     -> Load content with portable ~ path + Read() guidance
     -> source="managed-skill|managed-agent", path="~/.claude-mem-lite/managed/..."
  -> [hook.mjs handleUserPrompt] Capture user prompt text to user_prompts table
  -> [hook.mjs handleUserPrompt] Increment session prompt counter
  -> [hook.mjs handleUserPrompt] Handoff: detect continuation intent → inject previous session context
  -> [hook.mjs handleUserPrompt] Semantic memory injection (hook-memory.mjs), deduped via temp file

Stop
  -> Flush final episode buffer
  -> Save handoff snapshot (on /exit)
  -> Mark session completed
  -> Spawn LLM summary worker (poll-based wait)
```

### Resource Registry

The resource registry (`registry.mjs`, `registry-retriever.mjs`) indexes installed skills and agents into a searchable FTS5 database. Unlike the previous proactive dispatch system, the registry is now on-demand — it's reachable via the `claude-mem-lite registry` CLI (primary path for Claude Code since v2.34.0 hides the `mem_registry` MCP tool from `tools/list`) or by direct `tools/call mem_registry` for MCP clients that know the name.

```
Registry pipeline:
  -> registry-scanner.mjs discovers skills/agents on filesystem
  -> resource-discovery.mjs handles flat dirs, plugin nesting, loose .md files
  -> registry-indexer.mjs indexes content into FTS5 with metadata
  -> registry-retriever.mjs provides BM25-ranked search with synonym expansion
  -> mem_registry MCP tool exposes search/list/stats/import/remove/reindex actions

Smart invocation (three layers):
  L1 auto-load: UserPromptSubmit matches managed skill name in prompt
     -> Loads content with path="~/.claude-mem-lite/managed/.../SKILL.md"
     -> Guides: Read("path") or mem_use(name="..."), never Skill()
  L2 bridge: PreToolUse hook intercepts Skill("name") for managed resources
     -> Outputs content, prevents native handler failure
  L3 explicit: mem_use(name="...") loads full content with reload path
  Search: managed resources → Read(path), native plugins → Skill("full:name")
```

Composite scoring for search results: BM25 relevance (40%) + repo stars (15%) + success rate (15%) + adoption rate (10%) + freshness (10%) + exploration bonus (10%). Domain filtering ensures platform-specific resources (iOS, Go, Rust) only surface for matching projects.

### Episode Encoding

Episodes are batched related operations (edits to the same file group) that get processed by a background LLM worker:

```
Episode buffer -> Flush to JSON -> claude -p --model haiku -> Structured observation -> SQLite
```

Each observation includes type, title, narrative, concepts, facts, importance (1-3), and is automatically deduplicated via two tiers: Jaccard similarity (>70% within 5 minutes) and MinHash signatures (>80% within 7 days across sessions). If the LLM call fails, a degraded observation is saved with inferred metadata (zero data loss). Related observations are linked via `related_ids` based on FTS5 title similarity and file overlap.

## Management Commands

```bash
# Plugin install:
/plugin install claude-mem-lite       # Install / update
/plugin uninstall claude-mem-lite     # Uninstall

# git clone install:
node install.mjs install              # Install and configure
node install.mjs uninstall            # Remove (keep data)
node install.mjs uninstall --purge    # Remove and delete all data
node install.mjs status               # Show current status
node install.mjs doctor               # Diagnose issues
node install.mjs cleanup-hooks        # Remove only stale claude-mem-lite hooks from settings.json
node install.mjs update               # Force-check for updates and install them (direct install / npx mode)

# npx install:
npx claude-mem-lite                   # Install / reinstall
npx claude-mem-lite uninstall         # Remove (keep data)
npx claude-mem-lite doctor            # Diagnose issues
```

Notes:
- Plugin mode only reports available updates; it does not self-update plugin files.
  To upgrade an installed plugin to the latest published version, run **inside Claude Code**:
  ```
  /plugin marketplace update sdsrss
  /plugin install claude-mem-lite@sdsrss
  ```
  (The first command refreshes the local marketplace clone; the second reinstalls from it. Without the first command, `/plugin install` reuses the stale local clone and you stay on whichever version you originally pulled.)
- Direct install / npx mode keeps auto-update enabled and uses staged replacement with rollback on install failure.
- If you disabled the plugin but still have old mem hooks in `~/.claude/settings.json`, run `node install.mjs cleanup-hooks`.

#### Trust model per install path

The three install paths do **not** carry the same supply-chain guarantees — pick the one that matches your threat model:

| Path | Update mechanism | Ed25519 release-signature verification |
|------|------------------|----------------------------------------|
| npm / npx / git-clone direct install | auto-update from GitHub Releases | **Yes** — every runtime file (140 entries incl. hook scripts, MCP launcher, plugin declaration files) is hash-pinned in a signed manifest; verification is fail-closed |
| `/plugin install` (marketplace) | manual `/plugin marketplace update` + reinstall | **No** — Claude Code installs from a git clone of the marketplace repo; the plugin's own signature chain is not consulted on this path. You are trusting GitHub + the repo's branch protection, not the release signing key |

**Rollback recipe (plugin path).** If an update misbehaves, pin the marketplace clone to the previous release tag and reinstall from it:

```bash
# 1. Find the local marketplace clone
ls ~/.claude/plugins/marketplaces/          # e.g. sdsrss

# 2. Pin it to the previous good tag (tags mirror npm versions, e.g. v3.62.0)
cd ~/.claude/plugins/marketplaces/sdsrss
git fetch --tags && git checkout v3.62.0

# 3. Reinstall from the pinned clone — inside Claude Code:
#    /plugin install claude-mem-lite@sdsrss
# 4. To leave the pin later: git checkout main, then the normal update flow.
```

Your data directory (`~/.claude-mem-lite/`) is untouched by install/rollback; schema migrations are forward-only, so after rolling back more than one minor version check `node install.mjs doctor` before trusting search results.

### doctor

Checks Node.js version, dependencies, server/hook files, database integrity, FTS5 indexes, and stale processes.

### status

Shows MCP registration, hook configuration, plugin disabled state, and database stats (observation/session counts).

### Recovery (stuck install / hook errors)

If you see `ERR_MODULE_NOT_FOUND` on PreToolUse:Read/Edit/Skill hooks, or `claude-mem-lite` commands crash with import errors, you're likely hit by a partial auto-update — the updater copied new scripts but missed a sibling `lib/*` file, breaking the hook chain (and the next auto-update that would have healed it).

**v2.84.0+** ships a `repair` subcommand that re-syncs from the latest GitHub release:

```bash
claude-mem-lite repair
```

**If `repair` itself fails** (the bin is older than v2.84.0, or the bin is also broken), run this one-liner — it pulls a fresh tarball into a temp dir and runs *that* tarball's `install.mjs`, bypassing every file on your disk:

```bash
T=$(mktemp -d) && curl -sL https://api.github.com/repos/sdsrss/claude-mem-lite/tarball | tar xz -C "$T" --strip-components=1 && node "$T/install.mjs" install
```

After it finishes, `~/.claude-mem-lite/` is back in sync with the latest release and `claude-mem-lite repair` is available for next time.

## Uninstall

```bash
# Plugin:
/plugin uninstall claude-mem-lite

# git clone:
cd claude-mem-lite
node install.mjs uninstall            # Keeps ~/.claude-mem-lite/ data
node install.mjs uninstall --purge    # Deletes ~/.claude-mem-lite/ and all data

# npx:
npx claude-mem-lite uninstall
npx claude-mem-lite uninstall --purge
```

Data in `~/.claude-mem-lite/` is preserved by default. Delete manually if needed:
```bash
rm -rf ~/.claude-mem-lite/
```

### Mixed-install residue (read this if you've used multiple install methods)

`/plugin uninstall` only removes the plugin manifest — it **does not touch `~/.claude/settings.json`**. If you've ever run `claude-mem-lite install` (npx or git-clone path), hook entries pointing at `~/.claude-mem-lite/hook.mjs` were written into your user-global settings, and they keep firing after `/plugin uninstall`. If `~/.claude-mem-lite/hook.mjs` still exists they double-fire alongside the plugin; if you also ran `rm -rf ~/.claude-mem-lite/` they error every session.

**The safe sequence is**: run `claude-mem-lite uninstall` first (which cleans the settings.json hooks plus the global MCP registration), then `/plugin uninstall claude-mem-lite`, then optionally `rm -rf ~/.claude-mem-lite/`.

If you already uninstalled in the wrong order, `claude-mem-lite doctor` flags orphan hooks under `Orphan hooks:` with the exact cleanup command.

## Project Structure

```
claude-mem-lite/
  .claude-plugin/
    plugin.json      # Plugin manifest
    marketplace.json # Marketplace catalog
  .mcp.json          # MCP server definition (plugin root)
  hooks/
    hooks.json       # Hook definitions (plugin mode)
  commands/
    mem.md           # /mem command definition
  server.mjs           # MCP server: tool definitions, FTS5 search, database init
  search-scoring.mjs # Extracted search helpers: re-ranking, PRF, concept expansion
  hook.mjs             # Claude Code hooks: episode capture, error recall, session management
  hook-llm.mjs         # Background LLM workers: episode extraction, session summaries
  hook-shared.mjs      # Shared hook infrastructure: session management, DB access, LLM calls
  hook-handoff.mjs     # Cross-session handoff: state extraction, intent detection, injection
  hook-context.mjs     # CLAUDE.md context injection and token budgeting
  hook-episode.mjs     # Episode buffer management: atomic writes, pending entry merging
  hook-memory.mjs      # Semantic memory injection on user prompt
  hook-semaphore.mjs   # LLM concurrency control: file-based semaphore for background workers
  schema.mjs           # Database schema: single source of truth for tables, migrations, FTS5
  tool-schemas.mjs     # Shared Zod schemas for MCP tool validation
  tfidf.mjs            # TF-IDF vector engine: tokenization, vocabulary building, vector computation, cosine similarity, RRF merge
  tier.mjs             # Temporal tier system: activity-based time window classification
  utils.mjs            # Re-export hub: backward-compatible surface for all utility modules
  nlp.mjs              # FTS5 query building: synonym expansion, CJK bigrams, sanitization
  scoring-sql.mjs      # BM25 weight constants and type-differentiated decay half-lives
  stop-words.mjs       # Shared base stop-word set for all NLP/search modules
  synonyms.mjs         # Unified synonym source: SYNONYM_MAP (bidirectional) + DISPATCH_SYNONYMS
  project-utils.mjs    # Shared project name resolution with in-process cache
  secret-scrub.mjs     # API key, token, PEM, and credential pattern redaction
  format-utils.mjs     # String formatting: truncate, typeIcon, date/time/week formatting
  hash-utils.mjs       # MinHash signatures, Jaccard similarity for dedup
  bash-utils.mjs       # Bash output significance detection: errors, tests, builds, deploys
  # Resource registry
  registry.mjs         # Resource registry DB: schema, CRUD, FTS5, invocation tracking
  registry-retriever.mjs # FTS5 retrieval with synonym expansion and composite scoring
  registry-indexer.mjs # Resource indexing pipeline
  registry-scanner.mjs # Filesystem scanner: reads content + hashes, delegates discovery
  resource-discovery.mjs # Shared discovery layer: flat dirs, plugin nesting, loose .md files
  haiku-client.mjs     # Unified Haiku LLM wrapper: direct API or CLI fallback
  # Install & config
  install.mjs          # CLI installer: setup, uninstall, status, doctor (npx/git clone mode)
  skill.md             # MCP skill definition (npx/git clone mode)
  package.json         # Dependencies and metadata
  scripts/
    setup.sh           # Setup hook: npm install + migration (hidden dir + old dir)
    post-tool-use.sh   # Bash pre-filter: skips noise in ~5ms, tracks Read paths
    user-prompt-search.js # UserPromptSubmit hook: auto-search memory + L1 skill auto-load
    pre-skill-bridge.js  # PreToolUse hook: L2 skill bridge for managed resources
    pre-tool-recall.js   # PreToolUse hook: file lesson recall before Edit/Write
    prompt-search-utils.mjs # Shared logic: skip patterns, intent detection, name matching
    convert-commands.mjs # Converts command .md → SKILL.md in managed plugins
    index-managed.mjs  # Offline indexer for managed resources
  # Test & benchmark (dev only)
  tests/               # Unit, property, integration, contract, E2E, pipeline tests
  benchmark/           # BM25 search quality benchmarks + CI gate
```

## Search Quality

Benchmarked on 200 observations across 30 queries (standard + hard-negative categories),
measuring the **production-hybrid** retriever (FTS5 BM25 + TF-IDF vector + RRF) — the path
`mem_search` / `recall` actually use. The CI gate (`npm run benchmark:gate`) runs this same
path and fails on regression.

| Metric | Score (production-hybrid) |
|--------|---------------------------|
| Recall@10 | 0.90 |
| Precision@10 | 0.85 |
| nDCG@10 | 0.97 |
| MRR@10 | 0.96 |
| P95 search latency | ~1.8ms |

> **Where these numbers come from.** Reproduce with
> `node benchmark/benchmark.mjs --production-hybrid` (deterministic — same fixture corpus,
> same query set, no sampling). The CI reference capture is `benchmark/baseline.json`, and
> `npm run benchmark:gate` fails the build when a run drifts more than 5% from it. This is
> the single source for every retrieval figure quoted in this README.

> **Note on the path measured.** Earlier versions of this table reported the *lexical*
> FTS-only path (Precision@10 0.96, P95 0.15ms). The hybrid vector arm trades raw
> precision@10 for higher recall / nDCG / MRR by surfacing semantically-related candidates
> beyond exact lexical matches; the gate now measures the hybrid path so these numbers
> reflect real `mem_search` behavior. For field-comparable recall, see the LongMemEval
> section below.

### Recall on LongMemEval (standard benchmark)

Beyond the in-repo micro-benchmark above, claude-mem-lite is measured on
[LongMemEval](https://github.com/xiaowu0162/LongMemEval) (Wu et al.) — a
500-question long-term-memory benchmark — so its recall is comparable to the
field, not just to itself. Metric is **recall_any@k**: does *any* gold evidence session appear in the
top *k* retrieved? This is the same session-level definition the systems we
compare against report on this split — [agentmemory](https://github.com/rohitg00/agentmemory)
(BM25 + vector + graph) and dense-embedding systems like MemPalace — so the rows
below sit on one axis, not metric-shopped. (Note: 65% of the 500 questions have
multiple gold sessions, so `recall_any@k` is looser than fractional recall there;
all systems in this comparison report the any-hit form.) Corpus is user-turns-only
(the standard raw-baseline rule). Runners: `benchmark/longmemeval.mjs` (lexical)
and `benchmark/longmemeval-rerank.mjs` (rerank).

| Retriever (zero embeddings) | @1 | @5 | @10 |
|---|---|---|---|
| Lexical hybrid — FTS5 + TF-IDF + RRF | **83.4%** | **95.2%** | **96.0%** |
| + one top-20 LLM rerank pass † | 92.8% | 96.8% | 97.4% |

*n = 500 questions.* The lexical row was re-measured 2026-07-18: the v3.39–v3.45
alias/synonym-pipeline work lifted it from the previously published 76.8/90.6/95.2
on the **same harness and dataset** (both unchanged since that run — the gain is
engine-side, not metric drift). † The rerank row is the 2026-06 measurement taken
against the *older* lexical baseline; with lexical now at 95.2 @5 its remaining
headroom is ~1.6pt and a re-measurement is pending. The rerank pass hands the top
20 lexical candidates to a single Haiku call (~1.4 s/query) that reorders them; it
is **never worse than the lexical baseline by construction** — any LLM or parse
failure falls back to the original candidate order.

**Stricter metric, for the record.** The rows above are `recall_any@k` — does *any*
gold session reach the top *k* — the metric agentmemory and MemPalace publish, so the
comparison is like-for-like. Under the stricter **standard recall@k** (`|gold ∩ top-k| /
|gold|`, the *fraction* of all gold sessions retrieved), the lexical stack scores
@1 = 52.9% / @5 = 87.8% / @10 = 91.0%. The whole gap is the 65% of questions with
multiple gold sessions — any-hit needs one, fractional needs them all, and @1 is capped
at 1/|gold| there; single-gold question types score identically under both.
`benchmark/longmemeval.mjs` reports both columns (the rerank row's fractional is not yet
measured).

**On embeddings, honestly.** With no LLM in the loop, our zero-embedding lexical
stack now **ties** the BM25 + vector + graph hybrid (agentmemory, 95.2% @5) at the
same retrieval stage; a dense-embedding baseline (MemPalace, ~96.6% @5) still leads
by ~1.4pt. The remaining gap concentrates in paraphrase (single-session-preference
is our lowest category at 80.0% @5). The rerank row's point stands: a *single cheap
LLM call* reorders the top-20 lexical candidates because the candidate set is
already rich enough that ranking, not recall, is the bottleneck. An
embedding-plus-rerank stack still leads when both sides spend an LLM call; the
takeaway is that claude-mem-lite reaches embedding-competitive recall with **no
vector model, no knowledge graph, no Python, and no external service**.

Per-category any@5, lexical (2026-07-18 run): knowledge-update 100.0 ·
single-session-user 100.0 · multi-session 94.7 · single-session-assistant 94.6 ·
temporal-reasoning 94.0 · single-session-preference 80.0.

## Development

```bash
npm run lint              # ESLint static analysis
npm test                  # Run full test suite (vitest)
npm run test:smoke        # Run 5 core smoke tests
npm run test:coverage     # Run tests with V8 coverage (≥75% lines/functions, ≥65% branches)
npm run benchmark         # Run full search quality benchmark
npm run benchmark:gate    # CI gate: fails if metrics regress beyond 5% tolerance
```

## Environment Variables

Every environment variable the shipped code reads is listed below, grouped by what it
controls. Booleans accept `1` unless noted. Anything not listed here is not read by
claude-mem-lite.

### Core

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_MEM_DIR` | Custom data directory. All databases, runtime files, and managed resources are stored here. | `~/.claude-mem-lite/` |
| `CLAUDE_MEM_MODEL` | LLM model for background calls (episode extraction, session summaries). Accepts `haiku` or `sonnet`. | `haiku` |
| `ANTHROPIC_API_KEY` | Anthropic API key. When set, all background LLM calls go directly to the Anthropic Messages API (with prompt caching). Highest priority. | _(unset → CLI)_ |
| `OPENROUTER_API_KEY` | OpenRouter API key (OpenAI-compatible). Used for background LLM calls when `ANTHROPIC_API_KEY` is **not** set. If neither key is set, calls fall back to the `claude -p` CLI. | _(unset)_ |
| `OPENROUTER_MODEL` | Overrides the OpenRouter model slug for **all** background calls (e.g. `openai/gpt-4o-mini`, `qwen/qwen-2.5-72b-instruct`). When unset, the `CLAUDE_MEM_MODEL` tier maps to `anthropic/claude-haiku-4.5` (haiku) or `anthropic/claude-sonnet-4.5` (sonnet). | _(tier default)_ |
| `CLAUDE_MEM_DEBUG` | Enable debug logging (`1` to enable). | _(disabled)_ |
| `MEM_QUIET_HOOKS` | Low-noise hooks. `1` drops the `File Lessons` / `Key Context` sections from SessionStart injection, the lesson suffix from `[mem] Related memories`, and the `WHEN TO USE` / `Decision rules` blocks from MCP server instructions. IDs and the `Recent` table still surface so `mem_get(ids=[…])` remains reachable. Intended for users running the invited-memory adopt path or who otherwise want minimal auto-injection. **Since v2.82.0 this env no longer gates auto-adopt — use `MEM_NO_AUTO_ADOPT=1` for that.** | _(disabled)_ |
| `MEM_NO_AUTO_ADOPT` | Global opt-out for auto-adopt (v2.82.0+). `1` prevents the per-SessionStart auto-write of the `CLAUDE.md` managed block across **all** projects. For per-project opt-out use `claude-mem-lite adopt --disable` instead (writes a durable `<memdir>/.mem-no-auto-adopt` sentinel that survives marker deletion). | _(disabled)_ |
| `MEM_NO_ADOPT_HINT` | Silences the one-line "Invited-memory 未启用：`claude-mem-lite adopt`…" hint that SessionStart appends when the current project hasn't been adopted. Since v2.82.1 auto-adopt runs on every SessionStart for any install path, so this hint typically surfaces only when you've explicitly opted out (`MEM_NO_AUTO_ADOPT=1` or `claude-mem-lite adopt --disable`). | _(disabled)_ |

### What gets injected into your context

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_MEM_ALL_TOOLS` | `1` exposes all 20 MCP tools in `tools/list` instead of the 9 core ones (pre-v2.34.0 behavior). The 11 hidden tools stay callable by exact name either way. | _(9 core)_ |
| `CLAUDE_MEM_FILE_INTEL` | `0` disables the file-intel block injected before `Read` (past observations about the file you are about to open). | _(on)_ |
| `CLAUDE_MEM_FILE_INTEL_MIN_TOKENS` | Files smaller than this stay silent — file-intel only pays for itself on large files. | `800` |
| `CLAUDE_MEM_REREAD_GUARD` | `0` disables the warning when the same file is read twice in a session. Never fires on `offset`/`limit` paging. | _(on)_ |
| `CLAUDE_MEM_REREAD_MIN_TOKENS` | Token floor below which the re-read guard stays silent. | `600` |
| `CLAUDE_MEM_PRETOOL_NUDGE` | `1` extends the pre-tool recall nudge from `Read` to other tools. | _(Read only)_ |
| `CLAUDE_MEM_KEEP_LOW_SIGNAL` | `1` keeps low-signal observations that the deterministic filter would otherwise drop before dedup/vector work. | _(filtered)_ |
| `CLAUDE_MEM_NO_TEMPLATE_REFRESH` | `1` stops SessionStart from refreshing the adopted `CLAUDE.md` managed block when the shipped template changes. | _(refreshes)_ |
| `MEM_QUIET_HOOKS` | See Core above — the broadest injection-volume switch. | _(disabled)_ |

### Retrieval tuning

Prompt-time search (`UPS_*` = the UserPromptSubmit surface). Defaults are the values the
benchmark and A/B harness are calibrated against — changing them invalidates the numbers in
[Search Quality](#search-quality).

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_MEM_UPS_MAX_RESULTS` | Max memories injected per prompt. | `3` |
| `CLAUDE_MEM_UPS_REQUIRE_SIGNAL` | `0` restores always-search; by default the prompt must carry an explicit retrieval signal. | _(signal required)_ |
| `CLAUDE_MEM_UPS_BM25_MIN` | BM25 relevance floor for a result to be injected. | `1e-5` |
| `CLAUDE_MEM_UPS_BM25_MIN_FOLLOWUP` | Looser floor for follow-up prompts inside an already-injected session. | `5e-6` |
| `CLAUDE_MEM_UPS_OR_BM25_MIN` | Floor applied to the OR-fallback arm (looser query, needs a stricter floor). | `30` |
| `CLAUDE_MEM_UPS_TOP_MIN` | Minimum score for the top hit; `0` disables (useful on tiny test corpora). | `50` |
| `CLAUDE_MEM_UPS_FLOOR_REF_CORPUS` | Reference corpus size the score floors are normalized against, so a fresh install with few rows is not silently gated to zero injections. Shared by every floor-bearing surface, including error-recall below. | `584` |
| `CLAUDE_MEM_ERROR_RECALL_BM25_MIN` | Relevance floor for the error-recall surface (memories injected after a failed Bash command). **Off by default.** Setting it to `10.5` (the calibrated value) makes the surface stay silent when its best-matching memory is not actually about the failure — the whole set is dropped, never trimmed row-by-row. **It is a real trade, not a free win:** measured on a live database at that threshold, injections fall ~37% and ~39% of firings go silent, concentrated in projects with few memories. Off by default because nothing shows the dropped rows were noise. Explore with `node benchmark/error-recall-suite.mjs --sweep`. | `0` (off) |
| `CLAUDE_MEM_ERROR_RECALL_RERANK` | `off` restores the flat keyword ordering of the error-recall surface. **On by default**, and unlike the floor above it removes nothing: memories that share only the failed command's vocabulary are demoted below memories that mention the failure itself, and when a project has none of the latter the result is unchanged. Measured on a live database over 52 real failing commands × 15 projects: the lead memory matched no error term in 42.3% of firings before, 21.5% after, with the injected row count identical. | _(on)_ |
| `CLAUDE_MEM_ERROR_RECALL_ON_FAILURE` | `off` stops the plugin from recalling memories when a Bash command **fails at the host level**. On by default. Claude Code delivers failed tool calls to a separate `PostToolUseFailure` hook event, so before this the surface only ever saw commands that exited `0` while printing error-ish text — a genuinely failing build recalled nothing. Denials from your own guardrails (sandbox, policy hooks, declined permission prompts) and commands you interrupted are never recalled for. | _(on)_ |
| `CLAUDE_MEM_REGISTRY_CONFINE` | `off` lets registry enrichment read a resource whose `local_path` lies outside the managed data directory. **On by default.** Enrichment reads the file at `resources.local_path` and sends it to an LLM; the confinement check used to guard one of the four code paths that do this (`mem_registry(action="enrich")`) and not the other three, so `enrich <name>`, `enrich --all` and `import --enrich` read any path the row happened to hold. All four are gated now. Turn it off only if you deliberately registered resources outside `CLAUDE_MEM_DIR` and want them enriched; only the exact value `off` disables it, so a typo leaves the guard on. | _(on)_ |
| `CLAUDE_MEM_UPS_IDENTIFIER_BYPASS` | `0` disables the bypass that lets an exact identifier match skip the score floors. | _(on)_ |
| `CLAUDE_MEM_UPS_PROMPT_FALLBACK_LIMIT` | How many past-prompt rows the fallback arm may return. | `1` |
| `MEM_COVERAGE_THRESHOLD` | Fraction of query terms a memory must cover to qualify (∈ [0,1]). | `0.4` |
| `MEM_CROSS_PROJECT_BOOST` | Multiplier for matches from other projects (∈ [0,1]); raise it for installs that want more cross-project sharing. | `0.4` |
| `MEM_OR_FALLBACK_MAX_TOKENS` | Max query tokens allowed into the OR fallback (∈ [0,50]). | `8` |
| `CLAUDE_MEM_CJK_PREC_MIN` | Precision floor for CJK segmentation candidates. | `0.2` |
| `CLAUDE_MEM_AUTO_DEEP` | `0` disables automatic deep-search escalation (one Haiku call rewriting a weak query into keyword/concept/HyDE variants). Explicit `deep: true` still works. | _(auto)_ |
| `CLAUDE_MEM_AUTO_DEEP_CLI` | `0` disables the same auto-escalation on the CLI path only. | _(auto)_ |
| `CLAUDE_MEM_VECTORS` | `1` re-enables the persisted TF-IDF vector arm (off by default; also needs a vector rebuild via `maintain`). | _(off)_ |
| `CLAUDE_MEM_SCOPE_FILTER` | `1` stops environment-scoped observations from firing on file-triggered recall. They stay reachable via search. **Leave it off**: on the face it gates, `environment` is not the low-relevance class its premise assumes — it cites at least as well as `project` (47.5% vs 44.3%, intervals overlapping), and an earlier measurement left 173 recall groups empty with it on. | _(off)_ |
| `CLAUDE_MEM_READS_CARRY` | An episode flush collects `reads-<project>.txt` only when it will actually save an observation, so a flush that records nothing no longer discards the Read paths it swept up (42.2% of the paths a flush consumed, measured over 1122 transcripts). `0` restores the pre-v3.83.0 behaviour. | _(on)_ |

### Citation tracking and feedback

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_MEM_NO_CITATION_TRACK` | `1` disables both the access-count bump and the decay loop — no citation bookkeeping at all. | _(enabled)_ |
| `MEM_DISABLE_CITATION_DECAY` | `1` disables only the decay writes, keeping access-count bumps. | _(enabled)_ |
| `CLAUDE_MEM_CITATION_ADOPTION_THRESHOLD` | **Removed — inert.** Tuned the per-project adoption gate, which is gone (D#204). Setting it warns on stderr and changes nothing. | _(n/a)_ |
| `CLAUDE_MEM_NO_CITE_NUDGE` | `1` fully silences the cite-back nudge. | _(enabled)_ |
| `CLAUDE_MEM_CITE_NUDGE_THRESHOLD` | Cite-rate below which the nudge fires. | `0.6` |
| `CLAUDE_MEM_CITE_NUDGE_MIN_INJECTED` | Minimum injection volume before the ratio gate is judged at all. | `5` |
| `CLAUDE_MEM_CITE_NUDGE_SILENCE_AFTER` | Consecutive low-cite sessions before the nudge goes quiet; `0` = never silence. | `3` |
| `CLAUDE_MEM_CITATION_RELEVANCE_GATE` | Stop credits an `access_count` to a memory the session cited only when something made that memory relevant to the session — it was injected, or you typed its `#NN` yourself. `off` restores the pre-v3.84.0 behaviour of crediting every `#NN` the assistant wrote, which over-counts sessions that discuss memories in prose (release notes, audit reports): measured on real transcripts, 267 of 859 credited (id, session) pairs — 31.1% — were mentions nothing had put in front of the model. Superseded citations are redirected to their keeper on both settings. | _(on)_ |
| `CLAUDE_MEM_SUBAGENT_DECAY` | The `subagent` injection face feeds the decay loop: memories handed to a dispatched agent enter the denominator, and the citation that agent makes in its own transcript counts as the numerator. `0` returns the face to metered-but-never-decaying (v3.77–v3.82). | _(on)_ |
| `CLAUDE_MEM_METRICS` | `1` records feature-injection counters surfaced by `claude-mem-lite stats`. | _(off)_ |

### Background work

All of these turn *off* work that normally happens in the background. Nothing here changes
what is already stored — only whether new work runs.

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_MEM_SKIP_SUMMARY` | Skip the LLM session summary at Stop. | _(runs)_ |
| `CLAUDE_MEM_SKIP_EPISODE_LLM` | Skip LLM extraction on episode flush — observations are still batched, just not summarized. | _(runs)_ |
| `CLAUDE_MEM_SKIP_SAVE_ENRICH` | Skip the background Haiku call that backfills `lesson_learned` / search aliases after a save. | _(runs)_ |
| `CLAUDE_MEM_SKIP_COMPRESS` | Skip auto-compression of old observations. | _(runs)_ |
| `CLAUDE_MEM_SKIP_MAINTAIN` | Skip the 24h auto-maintain pass (decay, purge, backup). | _(runs)_ |
| `CLAUDE_MEM_SKIP_OPTIMIZE` | Skip the LLM optimization pass (re-enrich, normalize, cluster-merge). | _(runs)_ |
| `CLAUDE_MEM_SKIP_AUTO_DEDUP_FUZZY` | Skip the MinHash near-duplicate pass, keeping exact dedup. | _(runs)_ |
| `CLAUDE_MEM_SKIP_MARKER_GC` | Skip the runtime-marker sweep. | _(runs)_ |
| `CLAUDE_MEM_SKIP_UPDATE` | Skip the 24h auto-update check against GitHub Releases. | _(runs)_ |
| `CLAUDE_MEM_SKIP_SIG_VERIFY` | Skip Ed25519 signature verification of a downloaded update. **Escape hatch — leaves updates unauthenticated.** | _(verifies)_ |
| `CLAUDE_MEM_SKIP_REPOS` | Skip skill/agent registry seeding during install. | _(seeds)_ |
| `CLAUDE_MEM_NO_LESSON_RETRY` | `1` disables the one-shot retry that re-asks for a missing `lesson_learned`. | _(retries)_ |
| `CLAUDE_MEM_FLUSH_TIMEOUT` | Seconds the Stop hook waits for pending episode flushes. | `15` |
| `CLAUDE_MEM_BACKUP_BUDGET_MB` | Disk budget for backup snapshots; the next maintain/save evicts oldest snapshots past the 7-day undo grace. | `256` |

### Experimental

Off or shadow-mode by default. These are measurement arms, not finished features — behavior
and names can change between releases.

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_MEM_RECOMMEND_MODE` | Skill-recommendation engine: `shadow` (log would-be recommendations, inject nothing) or `off`. **`live` is parsed but not implemented** — live injection is Phase 2. Setting it runs shadow and prints one warning to stderr per process; `claude-mem-lite doctor` also reports it as an inert flag. | `shadow` |
| `CLAUDE_MEM_TASK_IMPERATIVE` | `on`/`1` injects the single most relevant lesson at prompt position under an imperative template. | _(off)_ |
| `CLAUDE_MEM_SUBAGENT_INJECT` | Dispatch-time memory injection for subagents. | _(off)_ |
| `CLAUDE_MEM_SALIENCE` | Selects a comprehension-bridge arm (`bridge`, `bind`); unset = current default behavior. | _(unset)_ |
| `CLAUDE_MEM_EDGE_DECAY` | Enables decay of file↔observation edges. | _(off)_ |
| `CLAUDE_MEM_EDGE_DECAY_K` | Edge-decay threshold when the flag above is on (clamped to ≥1). | `3` |

### Internal and test-only

Set by the tool or by the test harness. Setting these by hand is not supported:
`CLAUDE_MEM_HOOK_RUNNING`, `CLAUDE_MEM_BINDING_HEALED`, `CLAUDE_MEM_BRIDGE_FAKE`,
`CLAUDE_MEM_NO_DELAY`, `CLAUDE_MEM_CATCH_SAMPLE`, `CLAUDE_MEM_QUIET_TRACE`,
`CLAUDE_MEM_DB_PATH`, `CLAUDE_MEM_RUNTIME_DIR`, `MEM_DISABLE_SPAWN_LOG`.
`CLAUDE_PLUGIN_ROOT` is set by Claude Code itself.

Three more are set by `vitest.config.mjs` / `tests/global-setup.mjs` and exist only to
keep a test run off the live database: `CLAUDE_MEM_TEST_GUARD` (`1` arms the guard, `off`
opts a test out), `CLAUDE_MEM_TEST_REALDIR` (the live data dir, captured before the suite
relocates anything) and `CLAUDE_MEM_TEST_SANDBOX` (this run's throwaway dir). With the
guard armed, any resolution that lands on the live data dir is redirected to the sandbox
instead — including from a subprocess that inherited the ambient environment. Unset in
normal use, and inert when unset.

## FAQ

### What is a memory system for Claude Code?

A memory system lets Claude Code remember context — coding decisions, bug fixes, file history — across sessions. By default Claude Code's context resets each session; claude-mem-lite persists observations to a local SQLite database and re-injects them at session start and on relevant prompts.

### Does Claude Code have built-in long-term memory?

No. Claude Code's `CLAUDE.md` and `MEMORY.md` files act as static instruction memory, but there is no native dynamic recall of past sessions, bug fixes, or decisions. claude-mem-lite adds that layer via MCP and hooks, with no manual note-taking required.

### How is claude-mem-lite different from mem0 or MCP's reference memory server?

`mem0` and the MCP `memory` server are general-purpose LLM memory frameworks designed for any client. claude-mem-lite is purpose-built for Claude Code's hook lifecycle: it captures *episodes* (batched tool calls), uses domain-specific synonym expansion for code terms (`K8s`, `DB`, `数据库`, ...), and surfaces past observations proactively before file edits via the `PreToolUse:Edit` hook.

### Why "lite"? What did the original claude-mem do differently?

The original called an LLM on every tool use with raw JSON inputs. claude-mem-lite batches 5–10 operations per LLM call, uses a smaller model (Haiku), and runs a deterministic code-level filter before sending anything to the model. Net result: an estimated ~600× lower cost (an architecture estimate from the cost model above, not a measured benchmark) with equivalent search quality. See the [Architecture comparison](#architecture-comparison) above.

### Does this work cross-project? Cross-machine?

Project-scoped by default — each project has its own memory namespace. Single-machine only (SQLite, not networked). Use `mem_export` (JSON / JSONL) to back up or migrate between machines.

### What about privacy? Does it call external APIs?

Only the Haiku summarization step calls Anthropic's API (or the local `claude -p` CLI if no API key is set). All search, storage, and retrieval is local SQLite — no telemetry, no third-party services.

### 中文常见问题

**Claude Code 怎么跨会话记住内容？** 默认不能。claude-mem-lite 通过 MCP 协议和钩子自动把决策、bug 修复、文件历史持久化到本地 SQLite，下次会话开始时再注入。

**和 mem0、官方 MCP memory server 有什么区别？** 那两个是通用 LLM 记忆框架；claude-mem-lite 是为 Claude Code 钩子生命周期定制的：批量 episode 处理、代码领域同义词扩展（K8s/DB/数据库等）、文件编辑前主动召回相关历史。

**支持中文吗？** 完整支持。FTS5 + 中英文同义词扩展（100+ 对，含 CJK ↔ EN 跨语言映射），中文记忆也可用英文关键词召回，反之亦然。

## License

MIT
