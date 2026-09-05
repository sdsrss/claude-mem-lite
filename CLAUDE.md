# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

- **Version**: 3.96.1 — **this exact string is a release guard.**
  `tests/install-e2e.test.mjs` asserts CLAUDE.md contains `**Version**: <v>` matching
  `package.json`, `plugin.json` and `marketplace.json`. Do not reformat this line.
- **Runtime**: Node >=20, ESM (`"type": "module"`) · npm · better-sqlite3 + FTS5

## Commands

| Task | Command |
|------|---------|
| Setup | `npm install` (needs a Node >=20 toolchain; native `better-sqlite3` binding must build) |
| All tests | `npx vitest run` — or `npm test` |
| **One file** | `npx vitest run tests/foo.test.mjs` |
| **One case** | `npx vitest run -t 'case name'` |
| Smoke only | `npm run test:smoke` |
| Coverage | `npm run test:coverage` (gate: statements 80 / branches 74 / functions 84 / lines 83) |
| Lint | `npx eslint .` — or `npm run lint` |
| Format | `npm run format` (prettier — **run it twice**, `tests/hook-update.test.mjs` needs a second pass to reach a fixed point) · `npm run format:check` — **gated** in `ci.yml` and `scripts/pre-commit.sh` since the 2026-09-05 reformat |
| Dead code | `npm run dead-code` (knip — **read the measurement contract below first**) |
| Shell | `shellcheck scripts/post-tool-use.sh scripts/pre-agent-inject.sh scripts/pre-commit.sh scripts/setup.sh` |
| Micro-bench | `npm run benchmark` (`node benchmark/benchmark.mjs`) · CI gate: `npm run benchmark:gate` (`benchmark/ci-gate.mjs`) |
| Audit metrics | `npm run audit:metrics` · `npm run audit:baseline` |

Two CLI families, both canonical in `cli.mjs`:

- **`CLI_COMMANDS`** — `search recent recall get timeline browse context save update delete defer compress maintain optimize enrich fts-check restore export import import-jsonl stats citation-stats activity registry memdir-audit adopt unadopt help`
- **`INSTALL_COMMANDS`** — `install uninstall status doctor cleanup cleanup-hooks self-update repair rebuild-binding release`

`claude-mem-lite help` for flags. **`rebuild-binding` is the fix for a missing native
binding** — npm 12 blocks install scripts by default, which leaves `better-sqlite3` with no
`.node` at all while a plain `npm rebuild` prints success without compiling anything.
`doctor --metrics` is the only reader for the `inject` metric series (plain `doctor` omits it).

**Sandbox install harness** (not in `vitest run`; real `npm i -g` + real MCP stdio, minutes +
network): `SBX_BASE=/tmp/claude/sbx node tests/sandbox/phaseA-plugin.mjs` / `phaseB-npm.mjs` /
`phaseC-update.mjs`, one at a time — see `tests/sandbox/README.md`. **`SBX_BASE` is not
optional**: the fallback `$TMPDIR` lands under `$HOME`, and Node resolves `node_modules` up
the tree, so on a machine whose `~/node_modules` holds `better-sqlite3` the run silently
measures the home tree and passes anyway. The harness now refuses such a base.

## Architecture

Seven hook events are registered in `hooks/hooks.json`: `SessionStart`, `PreCompact`,
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `UserPromptSubmit`.

| Module | Role |
|--------|------|
| `cli.mjs` | CLI entry point — routes subcommands to mem-cli.mjs or install.mjs |
| `mem-cli.mjs` | CLI subcommand dispatch: retrieval / write / maintenance / data / insight / adopt families |
| `hook.mjs` | Main hook entry — session-start / stop / post-tool-use / **post-tool-failure** / user-prompt |
| `hook-precompact.mjs` | PreCompact event handler |
| `lib/tool-refusal.mjs` | Gate on the PostToolUseFailure path — separates a program failing from the agent's own tool chain refusing (sandbox / policy hook / declined permission), plus the interrupt and empty-text gates |
| `hook-context.mjs` | SessionStart context injection, adaptive time windows, token budgeting |
| `hook-llm.mjs` | Haiku-based summarization and title generation |
| `hook-memory.mjs` | Semantic memory injection on user prompt |
| `hook-episode.mjs` | Episode batching for observations |
| `hook-handoff.mjs` | Cross-session handoff state (/clear, /exit continuity) |
| `hook-shared.mjs` | Shared constants/utilities (RUNTIME_DIR, session mgmt) |
| `hook-semaphore.mjs` | Concurrency control for hook execution |
| `hook-update.mjs` | Auto-update via GitHub Releases (24h check, dev-mode skip) |
| `hook-optimize.mjs` | LLM-powered optimization: re-enrich, normalize, cluster-merge, smart-compress |
| `server.mjs` | MCP server — 20 tools: 9 core exposed via `tools/list` (mem_search/mem_recent/mem_recall/mem_get/mem_save/mem_timeline + mem_defer/mem_defer_list/mem_defer_drop) + 11 hidden-but-callable by exact name. Split flag in `tool-schemas.mjs`; agents reach hidden ones via the `claude-mem-lite <cmd>` CLI |
| `registry.mjs` | Resource registry DB schema + CRUD |
| `registry-retriever.mjs` | FTS5 search + BM25 composite scoring + domain filtering |
| `registry-scanner.mjs` / `-importer.mjs` / `-github.mjs` / `-enricher.mjs` | Resource discovery, import, GitHub fetch, enrichment |
| `registry-recommend.mjs` | Intent-based skill recommendation, shadow-first — see `docs/measurement/findings.md` |
| `tfidf.mjs` | TF-IDF vector engine — tokenization, vocabulary, vectors, cosine similarity, RRF merge |
| `tier.mjs` | Temporal tier system — activity-based time window classification |
| `schema.mjs` | DB schema definitions and migrations (incl. vocab_state, observation_vectors) |
| `utils.mjs` | FTS query sanitization, synonym expansion, CJK extraction, token estimation |
| `scripts/post-tool-use.sh` | Bash fast pre-filter (~5ms, skips low-value tools) |
| `scripts/user-prompt-search.js` | UserPromptSubmit hook — auto-search memory on user prompts |

Retrieval path: `sanitizeFtsQuery` (synonym expansion) → BM25 scoring → OR fallback →
concept co-occurrence. SessionStart emits the `<claude-mem-context>` block on stdout fresh
from the DB — CLAUDE.md is no longer auto-updated (pre-v2.30 left a stale snapshot here).

### Where new code goes

The four big files — `mem-cli.mjs` 4156, `install.mjs` 3203, `hook.mjs` 3187, `server.mjs`
2413 (measured 2026-09-05 at `a8d7dd1`, **after** the `36f8c0f` reformat; they were 3300 /
2697 / 2615 / 1982 before it, same code) — are **routers and faces, not a split left
half-finished**.
v2.41 moved four handlers into `cli/` and stopped; the direction that took hold since has
produced **87 modules under `lib/`**: logic two faces share (CLI and MCP, or two hook
events) gets extracted into a `lib/*-core.mjs`, and the big file keeps only argument
parsing, rendering, and wiring.

- **Shared by two or more faces → `lib/`.** This kills the twin-drift defect class this
  project keeps paying for. Register every new module in BOTH `source-files.mjs` and
  `package.json#files` — a missed registration has shipped a broken tarball three times.
- **Owned by exactly one face → it stays in that face's file.** Moving it buys a file and
  an import, not a guarantee.
- **No standalone split project.** `cli/common.mjs` is a shared render layer `server.mjs`
  also imports, so the directory name is already wrong; a further split spreads that.

Line count is not the trigger — a shared code path is.

## Measurement doctrine

This repo measures its own retrieval quality, and most of its expensive mistakes have been
*measurement* mistakes, not code mistakes. These ten rules are the distilled result; the
evidence for each is in `docs/measurement/`. **Violating one silently produces a number
that looks measured and is not.**

> **`docs/measurement/` IS tracked — it is this file's appendix, not internal notes.**
> So are `docs/audit/` (the audit ledger — each round marks the previous round's items
> 已解决/未解决/复发, which is impossible against a report nobody can read) and
> `docs/ARCHITECTURE.md`. The rest of `docs/` (design specs, plans, templates) is
> developer-local and ignored, so a fresh clone gets those three and nothing else from
> `docs/`. Even so, **the ten rules
> and every invariant in this file are self-contained**: the appendix carries the evidence
> (calibers, populations, superseded drafts, the reasoning behind each rule), never a rule
> you need and cannot find here. Keep it that way when you add to either — a rule that
> only exists in the appendix is a rule most sessions will never load.

1. **Stamp every number** with its date AND the tree/corpus it came from. A figure without
   a stamp cannot be superseded by a later reader.
2. **Never diff two runs taken at different times.** Every corpus here grows every session
   — including the session writing the note that quotes it. Run both arms back-to-back, or
   use a `--split` that cuts one walk into two arms.
3. **State the population.** "Which rows" is a required field, not a caveat. Filtered vs
   raw observation counts have shipped wrong drafts at least twice (`liveObsFilterSql`).
4. **A count is a smoke alarm; the name set is the evidence.** Never attribute a delta by
   subtracting two counts — do a same-tree A/B and diff names.
5. **A ruler must be able to say NO.** Every self-check gets driven to failure; a check
   nothing can break is not a check. Mutation-verify.
6. **A ruler must not pollute what it measures.** `searchRelevantMemories` writes
   (`injection_count`) *and* emits a metric row — pass `{ counterfactual: true }`. A
   readonly DB handle shuts only one of the two sinks. This rule was violated in the same
   release that cited it as precedent.
7. **Measure the RELEASE tree, and measure it last** — the tag names that tree, including
   its pre-tag review repairs.
8. **Absolutes from a recency-weighted selector are snapshots, not properties.** A
   named-row list is an instant; re-running quickly does not make it reproducible.
9. **A NEUTRAL from a structurally blind ruler says nothing.** `denoise-ab` drives
   `search-engine.mjs` only — it cannot see the `fyi`, `task_imperative`, `error_recall` or
   Key Context faces. Check what a ruler imports before trusting its Δ=0.
10. **Correct the premise before quoting it.** Several ledger entries were filed against
    the wrong culprit or with the ratio inverted; the fix was measuring, not arguing.

## Rulers

One per face. **Read the full entry in `docs/measurement/rulers.md` before quoting or
re-measuring any of these** — each records its caliber, population, self-checks, and the
drafts that were wrong.

| Ruler | Command | Answers |
|-------|---------|---------|
| Denoising A/B | `node benchmark/denoise-ab.mjs --save before.json` → `--compare before.json` | Any precision/recall lever, BEFORE shipping. Verdict REJECT / TRADEOFF / NET-POSITIVE / NEUTRAL / PROBE-FAIL |
| error-recall live | `node benchmark/error-recall-live-replay.mjs` | Rows admitted on command vocabulary alone. Closed D#167; reach for this first on that face |
| error-recall calibration | `node benchmark/error-recall-suite.mjs [--scores\|--sweep\|--compare]` | The \|bm25\| floor. denoise-ab is structurally blind here |
| citation per-face | `node benchmark/citation-live-replay.mjs [--split ISO] [--by-scope] [--mentions]` | Every injection face's cite-rate from real transcripts. Prefer over `citation-stats` |
| episode-flush | `node benchmark/episode-flush-replay.mjs` | Flush decisions through the shipped batcher (D#178) |
| rerank-pool | `node benchmark/rerank-pool-replay.mjs [--cost]` | `fyi` candidate-pool bounds (ALGO-3). Default is the WHOLE corpus, deliberately |
| Key Context pool | `node benchmark/keyctx-pool-replay.mjs [--population] [--why-displaced] [--cost]` | SessionStart Key Context pool bounds (D#192). Unit is a PROJECT, not a prompt |
| imperative pool | `node benchmark/imperative-pool-replay.mjs [--population]` | `task_imperative` reachability under `IMPERATIVE_POOL_BACKSTOP` |
| path-A exclude | `lib/patha-exclude-meter.mjs` (needs `CLAUDE_MEM_METRICS=1`) → `node benchmark/patha-exclude-report.mjs` | D#216. The deciding column is `refilled`, not `suppressed` |
| LongMemEval | `node benchmark/longmemeval.mjs <dataset>` | Standard recall, lexical baseline — `benchmark/datasets/README.md` |

## Baselines

Re-measure rather than carry — **the test-case count is partly generated**
(`tests/obs-id-caliber-sync.test.mjs` emits one case per `.mjs`/`.js` under `benchmark/`,
`lib/`, `scripts/` and the repo root, so adding a source file — or leaving an untracked
scratch file at the repo root — moves the headline number).

| Baseline | Value | Tree / date |
|----------|-------|-------------|
| Tests | **351 files / 5844** (5843 passed, 1 skipped) | `audit/2026-09-05-round4` @ `a8d7dd1`, 2026-09-05 |
| Knip | **50** unused exports, **0** unused files | same tree, primary working tree (was 52 at v3.96.0; −1 `install-metadata.mjs:MARKETING_ON_REQUEST` now imported by a test, −1 `_extractResponseFromError` deleted as dead) |
| Coverage | statements **84.34%** · branches **78.88%** · functions **89.26%** · lines **85.44%** | same tree. Gate (80 / 74 / 84 / 83) passes. |

**The 2026-09-05 whole-tree reformat (`36f8c0f`) changed the CALIBER of four
line-denominated metrics. Do not diff any of them across it** — prettier split one-line
statements, so the denominators grew while no code was added or removed:

| Metric | before `36f8c0f` | at `a8d7dd1` | why it is not a regression |
|---|---|---|---|
| Source lines | 52,356 | **61,311** | same 167 files |
| Functions > 50 lines | 140 | **179** | same ~2,045 functions; the threshold is in LINES |
| Duplicate rate any / cross-file | 1.88% / 0.29% | **5.15% / 2.35%** | uniform formatting makes far more 6-line windows compare equal |
| Coverage **lines** | 87.67% | **85.44%** | statements (84.34) and functions (89.26) did not move — only the line denominator did |

Re-stamp from `a8d7dd1`, never from an earlier figure.

**Knip measurement contract** (full version + name-set history in
`docs/measurement/baselines.md`):

1. **Command + context are part of the number.** Measure from the **primary working tree**.
   A `git worktree --detach` checkout reads ~15 LOWER on the same commit — reproduced,
   cause never established. Never mix the two contexts. A fresh **CI** clone lands on the
   working-tree side (n=2, name sets identical both rounds) — still not enough for a
   name-set guard; see `docs/measurement/baselines.md`.
2. **Never attribute a round's delta by subtracting two counts** (doctrine rule 4).
3. **A count is a smoke alarm; the name set is the evidence.**
4. **In `--reporter json`, every issue object carries a `files` key that is ALWAYS an
   array, empty or not** — `.filter(i => i.files)` counts every issue and reads as 18
   unused files against a text report showing none. Count elements, cross-check the text
   reporter.

Two categories of baseline entry: **(a) intentional** — v2.21 `utils.mjs` backward-compat
re-exports + test-only exports; do NOT remove without audit. **(b) NOT intentional** — the
v3 dispatch/invocation CRUD was confirmed dead and deleted in 2026-06; if invocation-stats
names reappear they are rot from a reverted feature. Treat the baseline as a floor; flag
NEW unused exports as PR review signal.

Coverage is measured over `lib/**/*.mjs` plus hand-picked root modules. Deliberately
**outside** the gate: `install.mjs`, `server.mjs`, `hook.mjs`, `registry*.mjs` (minus
`registry.mjs`) and `scripts/**` — exercised through subprocess E2E, which v8 coverage of
the parent process cannot observe. **Quote the v8 text reporter, not `coverage/clover.xml`**
(different caliber, will not reconcile).

## Invariants that bite

Full evidence for the first three in `docs/measurement/findings.md`.

- **`PostToolUse` does NOT fire for a tool call the host marks as failed.** Those go to
  `PostToolUseFailure` (registered since v3.79.0, D#170), where the failure text is in
  `error` — there is no `tool_response` — and `additionalContext` is the injection channel.
  Before that, `error_recall` was blind to every host-flagged failure. **Do not try to fix
  this class by widening `HARD_ERROR_RE`** — every anchor D#151 named measured zero gain
  over 1110 real transcripts. The failure path deliberately does not feed the episode
  buffer, and gates on `lib/tool-refusal.mjs` because **68.9% of host-flagged Bash failures
  are the agent's own guardrails refusing**, not programs failing.
  Off switch: `CLAUDE_MEM_ERROR_RECALL_ON_FAILURE=off`.
- **`hooks/hooks.json` and `install.mjs`'s direct `settings.json` entries are two separate
  hook sets and must be changed together** — `tests/audit-silent-20260814.test.mjs` diffs
  them and is verified binding.
- **A SQL `LIMIT` upstream of a JS-side relevance filter is a REACHABILITY bound, not a
  ranking bound.** It silently makes well-matching rows unpickable, and an importance
  demotion across the pool's `WHERE` becomes an *eviction* rather than a down-rank. This
  shape has been found on five faces. Count such populations with the pool's OWN
  `liveObsFilterSql`, never a bare `WHERE importance = 3`.
- **The cross-hook injected-ids marker is a union across TABLES**, so ids need namespacing
  (`injectedIdKey` in `lib/injected-ids.mjs`: `P` prompts, `D` deferred, `E` events,
  observations bare). 91.6% of observation ids also exist as an event id.
- **`importance` is rewritten automatically by five writers** (`decayAndMarkIdle`,
  `demotePinned`, `recoverBuriedLessons`, `autoBoostIfNeeded`, and the `boost` maintain op
  via `access_count`). Citation decay no longer writes it (D#179/D#198) — do not read that
  as "importance is now stable".
- **Tool name mapping**: Claude Code Agent tool = `'Agent'` (not `'Task'`); Skill via
  `event.tool_input?.skill`.
- **Tests use `:memory:` DB** — schema changes must sync to test files.
- **Writing a test that reads repo source as TEXT: use `dirname(fileURLToPath(...))` +
  `join()`, never `new URL('../x.mjs', import.meta.url)`.** The URL form drops the named
  module out of knip's report entirely — one unrelated test file once blinded knip to a
  whole module. Guarded by `tests/no-url-module-paths.test.mjs`.
- **`effectiveQuiet()` drops both Key Context sections under this repo's own cwd** (it is
  adopted), so a test asserting on them passes vacuously — point `CLAUDE_PROJECT_DIR` at an
  unadopted temp dir and assert a premise first.
- Skill commands (`/search`, `/recall`, `/recent`, `/timeline`) use `!` preprocessing for
  CLI injection.

<!-- claude-mem-lite:begin v1 -->
## claude-mem-lite — persistent memory

PreToolUse hooks already run `mem_recall` for past lessons before Read/Edit/Write. The calls worth making proactively:

| When | Call |
|------|------|
| Before Edit/Write | hook already recalled; if a `#NN` lesson was injected, cite `#NN` next time you produce user-visible text (citing = adopting the feedback; uncited lessons decay) |
| After fixing a non-trivial bug | `mem_save(type="bugfix", lesson_learned="<root cause + fix>", importance=2)` |
| After a non-obvious architecture decision | `mem_save(type="decision", lesson_learned="<constraint + tradeoff>")` |
| Deferring to a future session | `mem_defer({title, priority:1|2|3, detail})`; when fixed, add `closes_deferred=[N]` to `mem_save` |
| Looking up past work / history | `mem_search "keywords"` · `mem_recent` · `mem_timeline` |

Path cost is round-trips, not milliseconds: the PreToolUse hook above already recalls (0 calls) — prefer it. For an explicit query, if these `mem_*` tools are deferred behind ToolSearch this session, the Bash CLI (exact path in the detail doc) is one call vs two (ToolSearch + call).

Full tool + CLI tables, citation/decay rules, and save discipline → `.claude/plugin_claude_mem_lite.md`
<!-- claude-mem-lite:end -->

<!-- code-graph-mcp:begin v2 -->
## Code Graph (repo-wide AST index)

AST + FTS + vector index of the whole repo — prefer over multi-round Grep/Read for
structural queries (LSP only sees open files; this sees everything). Fastest path = Bash CLI:

| Intent | Command |
|--------|---------|
| Who calls X / what X calls | `code-graph-mcp callgraph X` |
| Impact before editing a fn | `code-graph-mcp impact X` |
| Unfamiliar dir / module | `code-graph-mcp overview <dir>` |
| Symbol source / signature | `code-graph-mcp show X` |
| Concept search (no exact name) | `code-graph-mcp search "…"` (vector: MCP `semantic_code_search`) |
| grep + AST context | `code-graph-mcp grep "pat" [paths] [-t lang] [-g glob] [-c]` |

Still use Grep for literal strings/regex in non-code files; still Read files you'll edit.
Full command + MCP-tool table: `.claude/plugin_code_graph_mcp.md`
<!-- code-graph-mcp:end -->
