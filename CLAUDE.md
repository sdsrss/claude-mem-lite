# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

- **Version**: 4.0.4 — **this exact string is a release guard.**
  `tests/install-e2e.test.mjs` asserts CLAUDE.md contains `**Version**: <v>` matching
  `package.json`, `plugin.json` and `marketplace.json`. Do not reformat this line.
- **Runtime**: Node >=22 (20 dropped in v4.0.0; EOL 2026-04 and better-sqlite3 13 requires >=22), ESM (`"type": "module"`) · npm · better-sqlite3 + FTS5

## Commands

| Task | Command |
|------|---------|
| Setup | `npm install` (needs a Node >=22 toolchain; native `better-sqlite3` binding must build) |
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
| **Recapture the gate baseline** | `node benchmark/benchmark.mjs --production-hybrid > benchmark/baseline.json` — **`benchmark/baseline.json` EXPIRES 30 days after its own `timestamp`**, and both `ci.yml` (on push) and `publish.yml` pass `--strict`, which turns that into a hard failure. Sampled 2026-09-05 → red from **2026-10-05**. In the release path the failure lands *after* the tag is pushed (v3.69.0/v3.69.1 stalled on exactly this), so recapture BEFORE tagging, in its own commit, naming the sampled tree. |
| Audit metrics | `npm run audit:metrics` · `npm run audit:baseline` |

Two CLI families, both canonical in `cli.mjs`:

- **`CLI_COMMANDS`** — `search recent recall get timeline browse context save update delete defer compress maintain optimize fts-check restore export import-jsonl stats citation-stats activity memdir-audit adopt unadopt help`
- **`INSTALL_COMMANDS`** — `install uninstall status doctor cleanup cleanup-hooks self-update repair rebuild-binding release`

`claude-mem-lite help` for flags. **`rebuild-binding` is the fix for a missing native
binding**, and **v4.0.0 changed what it is fixing** — do not carry the old paragraph forward.
better-sqlite3 12 shipped `"install": "prebuild-install || node-gyp rebuild --release"`, so
npm 12's default script block left it with no `.node` at all; that was the whole -32000 class.
**13 has NO install script** and ships `prebuilds/<platform>.node` instead, for 8 platforms
(linux / linuxmusl / darwin / win32 × x64 / arm64). Measured: `npm install --ignore-scripts
better-sqlite3@13` lands 8 prebuilds and opens a DB; the same install of 12 lands none and
cannot. So on any covered platform the script block no longer reaches users at all.

The trap moved rather than vanished. **`npm rebuild better-sqlite3` exits 0 printing
"rebuilt dependencies successfully" while compiling nothing — and
`--dangerously-allow-all-scripts` does not change that.** Re-measured 2026-09-06 in a
`mktemp` sandbox on npm 12.0.2, both prebuild states: present → both forms leave
`build/Release/*.node` empty; deleted → both forms leave `new Database(':memory:')` throwing.
On a platform 13 ships no prebuild for, that makes the whole heal chain a silent no-op.

**Do not restate the reason as "there is no script to allow" — that was the v4.0.0 wording
and it is wrong.** `npm install-scripts ls` reports `better-sqlite3@13.0.3 (install: node-gyp
rebuild)` **blocked because not covered by allowScripts**, on npm 11.19.0 *and* 12.0.2, for a
package that declares no install script in its tarball `package.json`, the registry packument,
or the lockfile entry — npm synthesizes one. So npm's script block does still reach this
dependency; what saves a covered platform is the shipped prebuild, not a missing script. Two
things are measured and unexplained, so do not invent a mechanism for either: that report
flips to "No packages with unreviewed install scripts" when `prebuilds/` alone is deleted
(same tree, same lockfile, `binding.gyp` present both ways), and `npm rebuild` compiles
nothing even in the state where npm says the script exists and is blocked.

`ensureBetterSqlite3Working` therefore has a third step since v4.0.0: when the npm path exits
clean but the binding is still dead, it runs the package's own
`npm run --prefix node_modules/better-sqlite3 build-release` (13 still ships `src/`, `deps/`
and `binding.gyp`), and reports `action: 'compiled'`. Both halves are pinned in CI by the two
legs of `smoke-npm12`.

**Never hand a human `NATIVE_BINDING_REBUILD_CMD` on its own** — that is step 1 of the heal
chain, not a repair. Since v4.0.1 every user-facing hint goes through
`nativeBindingRepairHint()`, which sequences both commands with `&&` and **never `||`**:
step 1 exits 0 whether or not it compiled, so an `||` fallback can never fire. Two surfaces
duplicate the string because they may not import `lib/` (`scripts/hook-launcher.mjs`'s
pure-`node:` charter, `scripts/setup.sh`); both are pinned to the constants by
`tests/audit-r8-binding-repair-hint.test.mjs`, which also fails if a fourth surface starts
hardcoding it.

`doctor --metrics` is the only reader for the `inject` metric series (plain `doctor` omits it).

**Sandbox install harness** (not in `vitest run`; real `npm i -g` + real MCP stdio, minutes +
network): `SBX_BASE=/tmp/claude/sbx node tests/sandbox/phaseA-plugin.mjs` / `phaseB-npm.mjs` /
`phaseC-update.mjs`, one at a time — see `tests/sandbox/README.md`. **`SBX_BASE` is not
optional**: the fallback `$TMPDIR` lands under `$HOME`, and Node resolves `node_modules` up
the tree, so on a machine whose `~/node_modules` holds `better-sqlite3` the run silently
measures the home tree and passes anyway. The harness now refuses such a base.

## Architecture

Seven hook events are registered in `hooks/hooks.json`: `SessionStart`, `PreCompact`,
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `UserPromptSubmit`. **`PreToolUse`
has TWO matchers, not three** — the `Skill` one went with the skill registry
(`docs/audits/20260906-145304.md`); `install.mjs`'s settings.json twin must stay equal to it.

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
| `server.mjs` | MCP server — 18 tools: 9 core exposed via `tools/list` (mem_search/mem_recent/mem_recall/mem_get/mem_save/mem_timeline + mem_defer/mem_defer_list/mem_defer_drop) + 9 hidden-but-callable by exact name. Split flag in `tool-schemas.mjs`; agents reach hidden ones via the `claude-mem-lite <cmd>` CLI |
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
> So are `docs/audit/` and `docs/audits/` (the audit ledger — each round marks the previous
> round's items 已解决/未解决/复发, which is impossible against a report nobody can read) and
> `docs/ARCHITECTURE.md`. The rest of `docs/` (design specs, plans, templates) is
> developer-local and ignored, so a fresh clone gets those four and nothing else from
> `docs/`. **The plural `docs/audits/` is a second ledger directory, not a typo** — the two
> audit prompt templates in use write to different paths, and the plural one was ignored
> until 2026-09-05, which cost the R5 report its readability for exactly one round. Even so, **the ten rules
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
| Tests | **343 files / 5578** (5577 passed, 1 skipped) | branch `refactor/2026-09-06-drop-skill-registry`, 2026-09-06, post-removal working tree (re-stamp with the release sha at ship). The skill-registry removal (R9, `docs/audits/20260906-145304.md`) took this from v4.0.4's **359 / 5936** in three steps, each attributed by a same-tree A/B NAME-SET diff rather than by subtracting counts: step 1 (recommendation engine) 359/5936 → 357/5884; step 2 (Skill bridge) → 356/5870, 14 names out + 1 renamed in; step 3 (registry) → 340/5556, 318 out + 4 renamed in; then +1 file / +5 cases for the removed-command discoverability signal (§EXT §2-EXT item 4), which is additive and was written RED-first. The R9 REVIEW rounds then added three files and 23 cases, every one RED-first and each count read back from the runner rather than hand-added (the first attempt at this breakdown was arithmetic that did not sum): `removed-registry-commands` 5, `dangling-hook-prune` 14, `suite-touches-no-user-config` 2, plus 2 in `hook-update` for the loadModule HOME guard. Against that, `coverage-scope` lost its `registry.mjs` case. **Watch the generated term**: `obs-id-caliber-sync` emits one case per `.mjs`/`.js` under `benchmark/`, `lib/`, `scripts/` and the repo root, and contributed −1, −1 and −10 across the three steps — exactly the count of deleted source files in those directories each time. Pre-removal history: v4.0.4 added 2 cases over v4.0.3's 359 / 5934; v4.0.2 added 3 over v4.0.1's 359 / 5929; the `v4.0.0` figure was 357 / 5911 and was **byte-identical under vitest 4 and vitest 5 on the same tree**. |
| Knip | **48** unused exports, **0** unused files, **0** duplicate exports | branch `refactor/2026-09-06-drop-skill-registry`, primary working tree. **The count is the least interesting part of this row.** Mid-removal it read 49 — numerically identical to v4.0.4 — while the NAME SET had changed on both sides: `registry-retriever.mjs:DISPATCH_SYNONYMS` left with its module, and `utils.mjs:isPathConfined` newly appeared because `server.mjs` had been its last consumer. A count-only comparison would have reported "unmoved" (doctrine rule 4, caught by the same-tree name-set diff). `isPathConfined` was then deleted — dead security code that nothing calls invites false confidence — on the precedent its own neighbouring comment records for `basenameAnySep`, giving 48. Unmoved-and-verified across v4.0.0 through v4.0.4 before that. `lib/hook-prune.mjs` adds no entry — all three of its exports are imported by product code and tests. |
| Coverage | statements **85.87%** · branches **80.15%** · functions **90.28%** · lines **87.05%** | branch `refactor/2026-09-06-drop-skill-registry`, **vitest 5.0.0**, 2026-09-06, post-removal tree. **THIRD CALIBER BREAK — do not diff against v4.0.4's 84.18 / 78.82 / 89.28 / 85.30**: the `include` allowlist lost three entries, so the denominator is a different set of files. **The first stamp of this row named the wrong three** (caught by independent review): it credited `registry-retriever.mjs`, which was in **`exclude`**, never `include` — and `vitest.config.mjs`'s own comment says removing such an entry changes nothing. The three that actually left `include` are `registry-scanner.mjs`, `resource-discovery.mjs` and **`registry.mjs`**, the last being the one that mattered: audit 2026-09-02 P1-15 had deliberately moved it IN because at 86.78% stmts it was a well-covered file sitting invisible, and `tests/coverage-scope.test.mjs` pinned it there. Both went with the module. Measured, not assumed: removing the now-dangling `'registry.mjs'` include entry moved **no column** — vitest ignores an include entry with no file — so the deltas here are the +9 hook-prune cases and `lib/hook-prune.mjs` entering the `lib/**` denominator. Gate (80 / 74 / 84 / 83) passes, `test:coverage` exit 0. **RE-MEASURE, NEVER CARRY — this row has now been wrong three times**, twice by carrying and once by mis-attributing. **UNATTRIBUTED, open since v3.99.0, do not guess a third time**: `lib/git-state.mjs` (100 / 90.9 / 100 / 100) is absent from `e694259`'s report and present afterwards. Caliber note: the v8 text reporter truncates names past ~19 chars (`...n-tracker.mjs`), so a full-name grep returns nothing and reads as "not measured". |

**`scripts/audit-metrics.mjs` module counts changed CALIBER in the R5 batch — do not diff
across it.** `cycles()` and `untestedModules()` used to count `*.config.mjs` as source
modules while `depsMd()` did not, so `--md` printed 163 and `--deps` printed 161 for what
reads as one set, and `eslint.config.mjs` was listed as a source module with no test. All
four reporters now share one predicate (`isGraphModule`), and `--self-check` fails if they
ever disagree again. Modules **163 → 161**, untested **24 / 163 → 23 / 161**. Edges are
unchanged (481 static + 48 lazy, 0 cycles) — both config files have zero local imports, so
only the node count moved.

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

**vitest 5.0.0 (2026-09-06) is a second caliber break, on coverage only. Do not diff coverage
across it.** Same-tree back-to-back A/B, whole suite both arms: pass/fail set byte-identical
(357 files / 5910 passed + 1 skipped), branches and functions columns unmoved on every row,
and exactly three files plus the root aggregate changed — `registry.mjs` 86.78 → **81.60**
stmts / 89.50 → **85.18** lines with an **identical uncovered-line list**, `env-number.mjs`
100 → **95.83** stmts with lines still 100 and the same uncovered line 102, and
`timeline-core.mjs` 97.26 → **95.89** stmts whose uncovered list **grew**, 185 → 139,185.
Same code, same uncovered lines, different denominator. Aggregate 84.30 / 85.40 →
**84.18 / 85.30**; the gate's `lines: 83` floor is 2.3 points below the new reading.

**Knip measurement contract** (full version + name-set history in
`docs/measurement/baselines.md`):

1. **Command + context are part of the number.** Measure from the **primary working tree**.
   A `git worktree --detach` checkout reads ~15 LOWER on the same commit — reproduced,
   cause never established. Never mix the two contexts. A fresh **CI** clone lands on the
   working-tree side (n=2, name sets identical both rounds) — still not enough for a
   name-set guard; see `docs/measurement/baselines.md`.
   **2026-09-06, R9: the offset did NOT appear, and the likely reason is that the rule is
   misnamed.** An independent reviewer measured the branch in a detached worktree whose
   `node_modules` was **symlinked to the primary tree's**, and got a name set
   byte-identical to the primary-tree reading (48 = 48, sets diffed, not counts). So
   "primary working tree" may really mean "against a fully installed `node_modules`", with
   the offset a module-resolution artifact rather than a property of the checkout. **Not
   settled**: the discriminating arm was not run — a detached worktree with its OWN `npm ci`
   tree. If that also matches, the warning can be retired with evidence; if it reads ~15
   lower, reword this rule in terms of `node_modules`, not the checkout. Until then keep
   measuring from the primary tree — the advice is safe under either explanation.
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
**outside** the gate: `install.mjs`, `server.mjs`, `hook.mjs` and `scripts/**` — exercised
through subprocess E2E, which v8 coverage of
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

Path cost is round-trips, not milliseconds: the PreToolUse hook above already recalls (0 calls) — prefer it. For an explicit query, if these `mem_*` tools are deferred behind ToolSearch this session, the Bash CLI `claude-mem-lite` is one call vs two (ToolSearch + call); the MCP server instructions carry the absolute path to use when it is not on PATH.

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
