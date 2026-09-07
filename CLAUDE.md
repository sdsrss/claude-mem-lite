# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

- **Version**: 5.6.0 — **this exact string is a release guard.**
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
| Coverage | `npm run test:coverage` (gate: statements 81 / branches 75 / functions 87 / lines 83) |
| Lint | `npx eslint .` — or `npm run lint` |
| Format | `npm run format` (prettier — **run it twice**, `tests/hook-update.test.mjs` needs a second pass to reach a fixed point) · `npm run format:check` — **gated** in `ci.yml` and `scripts/pre-commit.sh` since the 2026-09-05 reformat |
| Dead code | `npm run dead-code` (knip — **read the measurement contract below first**) |
| Shell | `shellcheck scripts/post-tool-use.sh scripts/pre-agent-inject.sh scripts/pre-commit.sh scripts/setup.sh` |
| Micro-bench | `npm run benchmark` (`node benchmark/benchmark.mjs`) · CI gate: `npm run benchmark:gate` (`benchmark/ci-gate.mjs`) |
| **Multiplier wiring** | `npm run benchmark:multipliers` · `npm run benchmark:multipliers:gate` (`--self-check`, exits 1). **Run this after touching any constant in `scoring-sql.mjs` or `MULT_EXPR` — `benchmark:gate` is structurally blind to those**, see the invariant below |
| **Recapture the gate baseline** | `node benchmark/benchmark.mjs --production-hybrid > benchmark/baseline.json` — **`benchmark/baseline.json` EXPIRES 30 days after its own `timestamp`**, and both `ci.yml` (on push) and `publish.yml` pass `--strict`, which turns that into a hard failure. Sampled **2026-09-07T08:00:55Z** (`f89520c`, recaptured at `203a426`) → red from **2026-10-07 08:00 UTC**. **The stamp lives in THREE places, not two** — `benchmark/baseline.json`'s own `timestamp`, `ci.yml:132`, and this line — and they must be changed together. `203a426` moved the first two and left this one naming the previous sample, in a commit whose own message cites R10 P3-23's "a hand-copied stamp goes stale silently"; the third surface was simply never enumerated. `tests/baseline-stamp-sync.test.mjs` now derives the expiry from `baseline.json` + the gate's own `BASELINE_STALE_AGE_DAYS` and fails if either prose surface disagrees, so this is enforced rather than remembered. In the release path the failure lands *after* the tag is pushed (v3.69.0/v3.69.1 stalled on exactly this), so recapture BEFORE tagging, in its own commit, naming the sampled tree. |
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
`phaseC-update.mjs`, one at a time — see `tests/sandbox/README.md`. **Run it after any
dependency major**: from v4.0.0 to v5.1.0 both self-heal sections corrupted
`build/Release/better_sqlite3.node`, a better-sqlite3 **12** path, so they measured nothing —
phase B's eight self-heal checks sat behind an `if (existsSync(…))` and silently stopped
running. Each phase now asserts its own check count (`EXPECTED_CHECKS`, 47 / 56 / 15), and
`tests/sandbox/lib.mjs::loadedBindingPath` asks better-sqlite3 which addon it would load
instead of naming one. **`SBX_BASE` is not
optional**: the fallback `$TMPDIR` lands under `$HOME`, and Node resolves `node_modules` up
the tree, so on a machine whose `~/node_modules` holds `better-sqlite3` the run silently
measures the home tree and passes anyway. The harness now refuses such a base.

**Last run: 2026-09-07, `fix/r10-p1-1-session-lifecycle` @ 5.3.1, Node v26.8.1 / npm
11.19.0 — 47/47, 56/56, 15/15, all three exit 0, each phase's tally matching its own
`EXPECTED_CHECKS`.** Phase B grew two sections and **both were written to fail first**:

- **B9 reproduced R10-P2-11 and it is now fixed.** With a marketplace clone AND a populated
  plugin cache present, `install` came back having overwritten the `3.95.0` cache dir's
  `scripts/launch.mjs` with the installer's own (9802 B), leaving that version calling
  `nativeBindingRepairHint` — an export its own `lib/binding-probe.mjs` does not have. The
  sync is now gated on `isDev || ver === selfVersion` and writes atomically; three of the
  checks are CI-side too, in `tests/install-e2e.test.mjs`, mutation-verified against the
  real revert.
- **B10 did NOT reproduce R10-P2-12, at 229 overlapping fires.** Four parallel launcher
  loops against five back-to-back in-place installs put **229 of 480 fires inside the
  2524 ms window**, with no `ERR_MODULE_NOT_FOUND`, no non-zero exit and no new
  `runtime/hook-errors/` bytes. The mechanism R10 describes is unchanged — `install()`
  still copies in place with no swap barrier, while `hook-update.mjs` takes one — so read
  this as a bounded negative, not an acquittal, and note the bound: an idempotent
  re-install deploys the SAME module set, so it cannot produce the version-transition
  shape (`ERR_MODULE_NOT_FOUND`) the report names. Producing that needs an install whose
  tree differs from the one on disk. `install()` was left alone per R10 §8.

The previous row: **2026-09-07, `main` @ v5.3.0 — 47/47, 45/45, 15/15**, the run the two
dependency majors (better-sqlite3 13, vitest 5) had been owed since v4.0.0; no regression
surfaced, and it was the first run in which the **self-heal sections measured something**
(A10 and B8 both logged `the shipped prebuild would not load — moved aside to
…/prebuilds/linux-x64.node.unusable`, so `c9c1acb`'s quarantine is exercised in the real
plugin cache AND the real managed install, not just asserted).

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
| `tfidf.mjs` | **Name is historical** — tokenization + Porter stemming only. The vector engine (vocabulary, vectors, cosine, vector search, RRF merge) was removed in Phase-2; `porterStem` survives because `search-scoring.mjs` uses it on the default path, and `RRF_K` moved to `lib/rrf.mjs` |
| `tier.mjs` | Temporal tier system — activity-based time window classification |
| `schema.mjs` | DB schema definitions and migrations (v49 DROPs `vocab_state` + `observation_vectors`) |
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

> **R10 (`docs/audits/20260906-173816.md`) landed as `efdf505..f1dde1a`, 16 commits.**
> All nine P1s and most P2/P3s are fixed, each with a RED-first test and, where a
> guard could be walked past, a mutation run against the real revert. **P1-1 closed
> 2026-09-07**: its blocking prerequisite ("capture a real `/clear` first — the two host
> semantics need opposite fixes") was settled without a capture switch, by reading the 21
> transcripts already on disk; see the session-lifecycle invariant below. **P2-11 closed the
> same day**, the other way round: R10 §8's "reproduce in `tests/sandbox/phaseB-npm.mjs`
> first" was taken literally, the repro landed as phase B §B9, and the fix followed it.
> Three items are deliberately open and the report below says why:
> P2-12 (install's missing swap barrier — mechanism unchanged, and the §B10 stress probe
> did not reproduce the symptom at 229 overlapping hook fires; see the sandbox row),
> P3-11 (FTS double-count — **R11 judged it and the verdict is "do not fix yet, and the
> report's stated DIRECTION is backwards"**: measured, an unrelated `update --importance 3`
> makes the row rank BELOW its byte-identical twin, not above it, because bm25 length-
> normalises the duplicated content. The defect that stands is "a content-unrelated write
> moves ranking". Both exits are blocked on one prior question: exit A needs `text` to be a
> SUBSET of the other FTS columns, exit B needs it to be a SUPERSET, and `text` currently has
> four incompatible meanings — ingest keyword blob, manual-save body, `derivedText` superset,
> import-jsonl payload. Decide what `text` is before touching either) and P3-24's second half (deleting `scripts/convert-commands.mjs` would
> strand `lib/frontmatter.mjs` and make its guard vacuous).
>
> **R11 (`docs/audits/20260907-113002.md`) audited the three areas R10 §9 named as never
> read**: the retrieval core (`lib/search-core.mjs` / `search-engine.mjs` / `deep-search.mjs`
> / `rerank.mjs`), `lib/citation-tracker.mjs` (1865 lines), and the unattended LLM write
> paths in `hook-llm.mjs` / `hook-optimize.mjs` — 13,647 lines, three read-only partitions,
> every P1 line re-opened and every P1 repro re-run by the lead. **No P0. Three P1s, all
> fixed**; the ORDER BY name set for those three partitions is in its §5, and its §6 records
> four subagent conclusions that did NOT survive checking. Deliberately open, each with its
> reason in the report: A-P2-1 (concept-expansion seed — one line, but it moves the candidate
> set, so it owes a denoise-ab A/B), A-P2-2 (`reachabilityNote` mis-attributes tier drops as a
> pagination bound), B-P2-4 (`ups` is a cross-project face judged by session project), C-P1-1
> (normalize fills `search_aliases`, evicting rows from the alias pool — real-corpus
> population 0), C-P2-1 (`optimized_at` evicts from the merge pool — real-corpus population 0),
> and the cite-recall THRESHOLD (see the invariant below).
>
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
| deep-search holdout | `node benchmark/deep-search-holdout.mjs [--json]` | Deep search's PRECISION arm. `tests/benchmark-deep-search.test.mjs` measures only recall, so it is blind to the flood below. Reads **mean FP@10 = 10.00, 12/12 queries** today. Since 2026-09-07 it also prints the `plain` / `auto?` columns and an **auto-escalation reach** line — **0/12 on both corpora**, so neither arm can judge the `auto` policy (see the invariant below) |
| compress veto | `node benchmark/compress-veto-rate.mjs` · `--reps N` · `--no-ambiguous` · `--self-check` · `--json` | Whether D#10's `should_compress` veto FIRES, not just whether it exists. Sends the SHIPPED prompt via `buildCompressPrompt`; classifies THREE ways so a dead key can never read as a perfect veto. **Three arms, and the third answers a different question on purpose** (D#13): unrelated → veto rate, related → false-refusal rate (both required, one alone is not a verdict), ambiguous → **no rate at all**, because a partly-one-story cluster has no ground truth. The ambiguous arm reports per-cluster verdict STABILITY across reps that **rotate member order** — temperature is pinned to 0, so repeating an identical prompt would measure nothing. A default run is 30 model calls, not 12 |
| multiplier discrimination | `node benchmark/multiplier-discrimination.mjs [--json]` · `--self-check` | Whether each of the 8 scoring multipliers is WIRED UP and still carries its declared magnitude. **`benchmark:gate` cannot say NO here** — see the note below the Baselines table |
| LongMemEval | `node benchmark/longmemeval.mjs <dataset>` | Standard recall, lexical baseline — `benchmark/datasets/README.md` |

## Baselines

Re-measure rather than carry — **the test-case count is partly generated**
(`tests/obs-id-caliber-sync.test.mjs` emits one case per `.mjs`/`.js` under `benchmark/`,
`lib/`, `scripts/` and the repo root, so adding a source file — or leaving an untracked
scratch file at the repo root — moves the headline number).

| Baseline | Value | Tree / date |
|----------|-------|-------------|
| Tests | **363 files / 5780** (5780 passed, **0 skipped**) | `refactor/vector-arm-phase2-removal` @ 2026-09-07, post vector-arm removal. **−70 cases, −3 files** (four deleted, one added) over the row below, attributed by NAME with the arithmetic closing exactly and no residual, measured per-file on both trees via one verified `git stash` round-trip rather than by subtracting totals. **Deleted files −27**: `hybrid-search` 11, `observation-vector-single-writer` 10, `vector-fieldset-r3` 5, `save-observation-vector` 1 — all four had the vector arm as their SUBJECT. **Edited files −48**: `tfidf` 27, `cli` 3, `hook-optimize` 3, `benchmark-production-hybrid` 2, `hook-llm` 2, `restore-cli` 2, `search-core` 2, `server` 2, `compress-core` 1, `inject-search-core` 1, `rrf` 1, `schema-fk-warmstart` 1, `schema` 1. **New file +5**: `tests/vector-arm-removed.test.mjs`, the removal contract. **Both generated terms were MEASURED unchanged, not assumed** (`obs-id-caliber-sync` 185, `benchmark-selfcheck-wiring` 17, each run on its own file): no source `.mjs` was deleted — `tfidf.mjs` only SHRANK, 597 → 225 lines — and no benchmark ruler was added or removed, so neither sweep's population moved. Note the shape, because it is the counter-case to every row below: a round can delete 372 lines of a swept file and still leave the generated terms flat. Previous row, **366 files / 5850** (5850 passed, **0 skipped**), `audit/r11-retrieval-citation-writes` @ 2026-09-07, post-R11 fixes + pre-ship review repairs. **+5 cases, +1 file** over the reading two sentences down, all of it `tests/schema-migration-v48.test.mjs` — the migration test the pre-ship review found missing, which is why the count moved twice in one round. Neither generated term moved (no `.mjs` added under `benchmark/`, `lib/`, `scripts/` or the repo root). The intermediate reading was **365 files / 5845**, and its own attribution stands: **+21 cases, +1 file** over the row below, attributed by NAME with every file re-measured individually and the arithmetic closing with no residual: **+2** `tests/citation-tracker.test.mjs` (43 → 45 — three added, and one REPLACED: `accumulates across multiple citation rounds` asserted `toBe(3)`, which encoded the defect), **+2** `tests/search-fallback-r4.test.mjs` (4 → 6, branch leak + its over-narrowing control), **+4** `tests/search-order-tiebreak.test.mjs` (new file), **+6** `tests/cite-back-hint.test.mjs` (69 → 75), **+6** `tests/pretool-event-id-namespace.test.mjs` (6 → 12), **+1** `tests/obs-id-caliber-sync.test.mjs` (184 → 185). **That last +1 is HAND-WRITTEN, not generated, and the distinction was checked rather than assumed**: the generated sweep counts `.mjs`/`.js` under `benchmark/`, `lib/`, `scripts/` and the repo root, and this round added none — every change was an EDIT to an existing module. `benchmark-selfcheck-wiring` re-measured at 17, unchanged, because no benchmark ruler was added or given a new self-check. Previous row, **364 files / 5824** (5824 passed, **0 skipped**), `main` @ 2026-09-07, post-v5.5.0. **+6 cases, 0 new files** over the row below, attributed by NAME with the arithmetic closing exactly: **5** are appended to `tests/deep-search.test.mjs` (79 → 84 — two D#8 reach tripwires and three holdout-ruler self-check cases) and **1 is GENERATED** — `benchmark/deep-search-holdout.mjs` now declares `runSelfChecks`, so `benchmark-selfcheck-wiring`'s per-ruler `it.each` emits a case for it (16 → 17, measured on that file directly). **This is the second generator that fires without a hand-written test**, and unlike the multiplier-ruler round it fired on an EDIT, not an added file: `obs-id-caliber-sync` stays at 184 because no `.mjs` was added under `benchmark/`, `lib/`, `scripts/` or the repo root, while the selfcheck-wiring sweep counts any `benchmark/*.mjs` that DECLARES a self-check. Adding a self-check to an existing ruler moves the headline by 1. Previous row, **364 files / 5818**, `main` @ 2026-09-07, post-v5.5.0. **+7 cases, +1 file** over the row below, attributed by NAME and the arithmetic closes with no residual: **5** are `tests/baseline-stamp-sync.test.mjs` (new file — the three-surface baseline-stamp guard) and **2** are the `wide` pool cases appended to `tests/hook-optimize.test.mjs` (68 → 70, measured on that file directly). **Neither generated term moved, and both were CHECKED not assumed**: `obs-id-caliber-sync` reads 184 and `benchmark-selfcheck-wiring` 16, run individually — this round added no `.mjs` under `benchmark/`, `lib/`, `scripts/` or the repo root (`hook-optimize.mjs` was EDITED, not added), and a new file under `tests/` is outside both sweeps. Of the 2 hook-optimize cases, **1 was RED against the real defect** (returned ids `[1,2,3]`, the three OLDEST, where the clause states newest-first `[3,4,5]`) **and 1 is a control that passes before and after** (the `CASE type` head must still outrank the new id tiebreaker). Previous row, **363 files / 5811**, `main` @ 2026-09-07, post-v5.5.0. **+16 cases, 0 new files** over the row below, attributed by NAME across three commits: **8** are the `compress-veto-rate ambiguous arm (D#13)` block appended to `tests/benchmark-compress-veto-rate.test.mjs` (7 → 15), **3** more are that same file's permutation cases (15 → 18), and **5** are the `pool ordering is total under exact ties (D#9)` block appended to `tests/hook-optimize.test.mjs` (63 → 68). **Neither generated term moved, and this round is a good example of why to check rather than assume**: `benchmark/compress-veto-rate.mjs` gained a whole new arm and `hook-optimize.mjs` gained SQL, but both were EDITED not added, so `obs-id-caliber-sync` emits no new case; and `compress-veto-rate.mjs` already declared `runSelfChecks`, so `benchmark-selfcheck-wiring`'s per-ruler `it.each` population is unchanged too. Of the 5 D#9 cases, **4 were RED against the real defect and 1 is a control that passes before and after** (importance must still outrank the new id tiebreaker) — counted here, but it is a guard against the fix over-reaching, not evidence for it. Previous row, **363 files / 5795**, `fix/coverage-scope-denylist` @ 2026-09-07. **+9 cases, +1 file** over the row below, attributed by NAME: **7** are `tests/benchmark-compress-veto-rate.test.mjs` (new file) and **2 are GENERATED by the new ruler before it contains a test of its own** — `benchmark/compress-veto-rate.mjs` is a new `.mjs` under `benchmark/`, so `obs-id-caliber-sync` emits one case, and it declares `runSelfChecks`, so `benchmark-selfcheck-wiring`'s per-ruler `it.each` emits another. Both generators were verified by running those two suites directly rather than inferred from the total. Previous row, same branch, **362 files / 5786**. **+5 cases, 0 new files** over the row below, attributed by NAME: **2** are the `executeReenrich post-LLM writes are live-guarded (D#12)` block and **3** the D#10 veto cases, all appended to `tests/hook-optimize.test.mjs`. **Two EXISTING mocks were edited, not added** — `creates smart summary from a cluster` here and the helper in `tests/audit-r10-compress-row-parity.test.mjs` both now pass `should_compress: true`, because smart-compress fails closed on a missing verdict and those mocks encoded the pre-veto contract. The generated terms did not move. Previous row, same branch, **362 files / 5781**. **+10 cases, 0 new files** over the row below, attributed by NAME: all ten are the `re-enrich scope='concepts' (D#6 concepts backfill)` block appended to `tests/hook-optimize.test.mjs`. **THREE OF THE NINE WRITTEN FIRST PASSED BEFORE THE FIX** and were rewritten rather than counted — an unknown scope falls through to `narrow`, whose pool is also empty on those fixtures, so every "did not write" assertion held vacuously; each now asserts a premise (a NAME instead of an empty count, `processed === 1` before checking `optimized_at`, the model actually having been called). The generated terms did not move: `hook-optimize.mjs` and `mem-cli.mjs` were EDITED, not added. Previous row, same branch, **362 files / 5771**. **+7 cases, 0 new files** over the row below, attributed by NAME not subtraction — and the +7 is a NET of **eight added and one removed**, which a subtraction would have reported as "+7 added" and got the population wrong. One is `tests/vitest-config-exclude.test.mjs::gives setup/teardown the same budget as the tests they serve` (D#7). The other seven, net six, are `tests/coverage-scope.test.mjs` (4 cases → 10). Added: the vitest-major tripwire, `leaves no shipped module unmeasured by omission`, `measures the shipped cli/ and server/ modules`, the substring-exclusion pin, the tests/node_modules leak pin, `keeps the gate numbers in CLAUDE.md equal to the config`, and `measures the retrieval core the measurement doctrine is about`. Removed: `still measures the 22 hand-picked root modules`, which encoded the allowlist this round deleted. **Neither generated term moved** — no `.mjs` was added under `benchmark/`, `lib/`, `scripts/` or the repo root (`vitest.config.mjs` was EDITED, not added), and a new case inside an existing file under `tests/` is outside both sweeps. Previous row, `feat/multiplier-discrimination-ruler` @ 2026-09-07, **362 files / 5764**. **+9 cases, +1 file** over the row below, attributed by NAME: all nine are `tests/search-reachability-note.test.mjs` (D#5). **Neither generated term moved** — the round added no `.mjs` under `benchmark/`, `lib/`, `scripts/` or the repo root (`lib/search-core.mjs` was EDITED, not added), and `benchmark-selfcheck-wiring`'s per-ruler `it.each` only sweeps `benchmark/`. Previous row, same branch, **361 files / 5755**. **+11 cases, +1 file** over v5.4.0, attributed by NAME not subtraction, and the pristine arm was MEASURED rather than assumed (`git stash -u`, whole suite, checksums verified identical on pop): `main` @ f25e8ae reads exactly **360 / 5744**, matching the row below. The eleven: **9** are `tests/benchmark-multiplier-discrimination.test.mjs` (new file); **1 is generated** — `benchmark/multiplier-discrimination.mjs` is a new `.mjs` under `benchmark/`, so `obs-id-caliber-sync` emits a case for it (measured directly, 182 → 183 on that file alone); and **1 is also generated, by a different sweep** — `tests/benchmark-selfcheck-wiring.test.mjs` runs one `it.each` case per `benchmark/*.mjs` that declares a self-check, so the new ruler's `runSelfChecks` puts it in that population too. **That second generator is not recorded anywhere above and is easy to miss**: a new benchmark ruler moves the headline by 2 before it contains a single test of its own. Previous row, `fix/r10-p1-1-session-lifecycle` @ 2026-09-07, **360 files / 5744**. **+8 cases, 0 new files** over v5.3.1, attributed by NAME not subtraction: three are the `E2E: plugin-cache launch.mjs sync is version-gated (R10-P2-11)` block appended to `tests/install-e2e.test.mjs` (non-dev gate, dev-mode control, and the behavioural "no version dir calls an export its own lib lacks"), and five are the `Suite: R10-P1-1` block appended to `tests/e2e.test.mjs` (rotated-id arm, kept-id arm, the plain-`startup` counter-case, one-mem-session-per-host-session, and the `CLAUDE_MEM_LEGACY_STOP_UNLINK` revert path). **The generated term did not move** — no `.mjs` was added under `benchmark/`, `lib/`, `scripts/` or the repo root. One existing assertion was RESTATED rather than added: `Suite 1`'s `expect(getSessionFile(tmpHome)).toBeNull()` became `not.toBeNull()` plus an id check, because it encoded the shape the fix removes. Previous row, **360 files / 5736** at v5.3.1, 2026-09-07: **+6 cases, 0 new files** over v5.3.0, attributed by NAME not subtraction: 4 appended to `tests/tmp-fixture-dispose.test.mjs` (the `makeFixtureTracker` block — a 5th was written and **deleted**, because mutation M5 showed `track`'s nullish guard is unobservable through `disposeAll`, so the case could only ever pass) and 2 to `tests/superseded-write-guards.test.mjs` (D#4). **The generated term did not move** — no `.mjs` was added under `benchmark/`, `lib/`, `scripts/` or the repo root, and the nine suites that gained an `afterAll` gained no cases. Previous row, **360 files / 5730** at v5.3.0, 2026-09-06: **+19 cases, +3 files** over v5.2.0, attributed by NAME not subtraction: `tests/tmp-fixture-dispose.test.mjs` (+1 file, 4 cases), `tests/bg-spawn-skip-flag-invariant.test.mjs` (+1 file, 5 cases), `tests/live-predicate-adjudication.test.mjs` (+1 file, 3 cases), and 7 appended to the existing `tests/deep-search.test.mjs` — the 7th being the zero-result disclosure case pre-ship review asked for. **The generated term did not move** — no `.mjs` was added under `benchmark/`, `lib/`, `scripts/` or the repo root, and a new file under `tests/` is outside that sweep. Previous row, **357 files / 5711** at v5.2.0: **+18 cases, +1 file** over `c9c1acb`, attributed by NAME not subtraction. The +1 file and 4 of the cases are `tests/maintain-ops-invariant.test.mjs`; 4 more are the `maintain scan --ops` block, 4 the `fts-check` exit-code block and 1 the delete-preview missing-id case, all in `tests/cli.test.mjs`; 2 are the cleanup age-gate cases in `tests/audit-r10-installer-global-writes.test.mjs`; 1 is the delete-core missing-id case in `tests/twin-cores.test.mjs`; 1 is the deep-search baseline-untouchable guard in `tests/deep-search.test.mjs`; and **1 is generated** — `benchmark/deep-search-holdout.mjs` is a new `.mjs` under `benchmark/`, so `obs-id-caliber-sync` emits a case for it. **A new file under `tests/` does NOT move the generated term** — that sweep counts `benchmark/`, `lib/`, `scripts/` and the repo root only. Was **356 / 5693** at `c9c1acb`, after the prebuild-shadowing fix (`d846279..c9c1acb`). **+6 cases, 0 new files** — the six are appended to two existing files, and the generated term did not move because no source file was added. Was **356 / 5687** at `cc4fc5e`, after the R10 audit-fix series (`efdf505..cc4fc5e`, 15 commits). Was **343 / 5578** (5577 + 1 skipped) at `efdf505`. **The 1 skipped became 0 for a reason worth knowing**: `tests/pre-commit-hook-sync.test.mjs` skips when no git hook is installed, and this clone had none — `git config core.hooksPath .githooks` (R10 P2-20, now also `npm run hooks:install`) un-skipped it. A skip that permanent is a check that is off. **Watch the generated term**: `obs-id-caliber-sync` emits one case per `.mjs`/`.js` under `benchmark/`, `lib/`, `scripts/` and the repo root, so deleting `scripts/p0-forward-probe.mjs` (R10 P3-24) took one case with it — which is why the R10 batch that removed it netted +0 cases despite adding one. Pre-R10 history: the skill-registry removal took 359/5936 → 343/5578 in three attributed steps; v4.0.4 added 2 over v4.0.3's 359 / 5934; the `v4.0.0` figure was 357 / 5911 and was **byte-identical under vitest 4 and vitest 5 on the same tree**. |
| Knip | **44** unused exports, **0** unused files, **0** duplicate exports, **3** unlisted binaries (`du`, `pgrep`, `claude-mem-lite`, all from `install.mjs`) | `refactor/vector-arm-phase2-removal` @ 2026-09-07, post vector-arm removal, primary tree. **Unmoved — and this is the row where an unmoved COUNT most needed the name diff, so it got one** (doctrine rule 4): the round deleted ~19 exports (`vectorsEnabled`, `buildVocabulary`, `rebuildVocabulary`, `getVocabulary`, `computeVector`, `cosineSimilarity`, `vectorSearch`, `rrfMerge`, `vecTextForRow`, `_resetVocabCache`, `buildVecText`, `upsertObservationVector`, `insertObservationVector`, `rebuildVector`, `rebuildVectors`, `VEC_HIT_OBS_COLS`, `seedVectors`, `runVectorSweep`, plus three constants) and added one (`RRF_K` in `lib/rrf.mjs`), so 44 → 44 is exactly the shape that can hide names crossing in both directions. Same-tree A/B (`git stash push -u` / measure / `git stash pop`, worktree verified intact): name sets extracted identically in both arms and diffed — **zero entered, zero left, byte-identical**. Expected, once stated: every removed export had a live consumer, so none was ever ON the list, and `RRF_K` is consumed by `deep-search.mjs`. Previous row, `audit/r11-retrieval-citation-writes` @ 2026-09-07, post-R11 fixes, primary tree. **Unmoved in every category, and the one new export was checked BY NAME rather than inferred from the unchanged total** (doctrine rule 4): `lib/cite-back-hint.mjs:nextCiteStreakState` is absent from the listing because `hook.mjs` and `tests/cite-back-hint.test.mjs` both import it. Previous row, `main` @ 2026-09-07, post-v5.5.0 working tree, primary tree, **44**. **Unmoved, and verified by a same-tree A/B rather than by the total agreeing** (doctrine rule 4): `git stash` / `npm run dead-code` / `git stash pop`, name sets extracted identically in both arms and diffed — **zero names entered, zero left**. That check was worth running because the round added four exports to `benchmark/deep-search-holdout.mjs` (`runSelfChecks`, `assertHoldoutRemovedRows`, `assertRewritesUsable`, `assertEscalationColumnIsTheShippedPredicate`) and made `runHoldout` imported for the first time — an unchanged 44 could have hidden one name leaving and another arriving. None of the five appears in the listing. Previous row, `main` @ 2026-09-07, post-v5.4.0 working tree, primary tree, **44**. **45 → 44, attributed by NAME (doctrine rule 4): exactly one name left the list — `scoring-sql.mjs:CITE_FACTOR_PER_CITE`.** Before this round its only references were inside `scoring-sql.mjs` itself (`citeFactorClause`, `citeFactorJs`), with no cross-module import, so knip counted it unused; `benchmark/multiplier-discrimination.mjs` now imports it to derive the cite arm's expected ratio instead of copying the 0.2. **Zero new unused exports**: the round added six (`searchObservations` in `benchmark.mjs`, plus `ARMS` / `seedArm` / `measureArm` / `runDiscrimination` / `runSelfChecks` in the new ruler) and none is listed, checked by name rather than inferred from the total. `TYPE_QUALITY` was never in the list — `hook-context.mjs`, `hook-memory.mjs`, `hook-optimize.mjs` and `benchmark/longmemeval.mjs` already imported it. Previous row, `fix/r10-p1-1-session-lifecycle` @ 2026-09-07, primary tree, **45**. **Unmoved from v5.3.1 in every category.** This round added one export — `dedupePluginCacheAndHooks` in `install.mjs`, made public so a CI test can drive the version gate directly — and it is absent from the listing because `tests/install-e2e.test.mjs` imports it (checked by name, not inferred from the unchanged total). Previous row, `main` @ v5.3.1, 2026-09-07, primary tree. **Unmoved from v5.3.0 in every category.** The round added one export — `makeFixtureTracker` in `tests/test-helpers.mjs` — and it is absent from the list because nine suites import it. Previous row, `main` @ v5.3.0: **Name set identical to the `c9c1acb` baseline**; the only diff in the whole listing is two line numbers in `deep-search.mjs` (`REWRITE_SYSTEM` 195→246, `AUTO_DEEP_THROTTLE_MS` 253→304) pushed down by inserting `deepDisclosureNote` above them — which is itself absent from the list because both faces consume it. **Zero new unused exports across the six commits.** **Both arms of the worktree probe are stamped to THIS commit** (contract rule 1, doctrine rule 1): primary tree at `61a6f66` = 45, detached worktree with its own `npm ci` at `61a6f66` = 45, name sets diffed and byte-identical. Neither arm is comparable to the `2ebc159` pair that produced the ~15 gap — different tree, and `registry-retriever.mjs` no longer exists. Same figure at `c9c1acb` and `cc4fc5e`. Was **48** at `efdf505`. **Attributed by NAME SET, not by subtracting counts** (doctrine rule 4): exactly three names left the list — `lib/scrub-record.mjs:TEXT_FIELDS_BY_TABLE`, `hook-optimize.mjs:executeSmartCompress` and `schema.mjs:isDbCorruptionError` — each because an R10 test now imports it. **Zero new unused exports across 15 commits.** The 3 unlisted binaries were present at `efdf505` too and are not new; the earlier rows simply never recorded that line. **The worktree-offset rule got a second data point**: this `efdf505` reading was taken in a `git worktree --detach` whose `node_modules` was SYMLINKED to the primary tree's, and it read 48 — matching the primary-tree figure, as the R9 reviewer also found (n=2 now). The discriminating arm — a detached worktree with its OWN `npm ci` — is still unrun, so keep measuring from the primary tree, but the rule is more likely about `node_modules` than about the checkout. |
| Coverage | statements **84.96%** · branches **79.38%** · functions **90.72%** · lines **86.14%** | `refactor/vector-arm-phase2-removal`, **vitest 5.0.0**, 2026-09-07, post vector-arm removal, gate exit 0 at floors **81 / 75 / 87 / 83**. Same `include` as the row below, but **DO NOT read the rise as improvement — it is the denominator**, and this row exists to say so. Statements **11614 → 11321 (−293)**, branches **~9398 → 9222**, file count 130 unchanged; `tfidf.mjs` alone went 597 → 225 lines and now carries 100 statements. Removing code that was covered BELOW the tree average raises the aggregate while nothing gets better, which is why all four columns moved up in a round whose only new test is a 5-case structural guard. The honest statement of this round's coverage effect is: no line that was covered stopped being covered, and no line that was uncovered became covered. Previous row, statements **84.71%** · branches **78.92%** · functions **90.68%** · lines **86.05%**, `audit/r11-retrieval-citation-writes`, **vitest 5.0.0**, 2026-09-07, post-R11 fixes, gate exit 0 at floors **81 / 75 / 87 / 83**. Same caliber as the row below (no `include` change), so comparable — and three of four columns move by MORE than the ±0.01 noise floor that row measured, so they are attributed rather than shrugged at: statements 84.55 → **84.71**, branches 78.75 → **78.92**, lines 85.88 → **86.05**. All three come from the same place: R11 added branches to files that ARE in scope (`lib/citation-tracker.mjs` scoped/unscoped bump, `lib/cite-back-hint.mjs` `nextCiteStreakState`'s three-way base, `lib/search-core.mjs` branch filter) and the new cases cover both arms of each. **Functions 90.68 → 90.68 is NOT "unchanged code"** — one function was added (`nextCiteStreakState`) and is covered, so numerator and denominator moved together; do not read the flat digit as evidence that nothing landed. Previous row, statements **84.55%** · branches **78.75%** · functions **90.68%** · lines **85.88%**, `main`, **vitest 5.0.0**, 2026-09-07, post-v5.5.0 + the `wide`-pool tiebreaker + the D#8 escalation instrumentation, gate exit 0 at floors **81 / 75 / 87 / 83**. Same caliber as the row below, and **again identical to it in all four columns, RE-MEASURED not carried**. Expected shape: `benchmark/**` is in `exclude`, so the ruler's new code contributes nothing, and the new cases in `tests/deep-search.test.mjs` drive `searchObservationsHybrid` / `computePerSourceWindow` — in-scope but already covered, so exercising them more adds no newly-covered line. Anything smaller than that is under the ±0.01 floor this row measured. Previous row, statements **84.55%** · branches **78.75%** · functions **90.68%** · lines **85.88%**, `main`, **vitest 5.0.0**, 2026-09-07, post-v5.5.0 + the `wide`-pool tiebreaker, gate exit 0 at floors **81 / 75 / 87 / 83**. Same caliber as the row below, and **all four columns are identical to it to the digit — RE-MEASURED, not carried** (this row's own rule). That is the expected shape rather than a coincidence: the round's only in-scope source change is two SQL tokens (`, id DESC`) plus comments inside an existing template literal in `hook-optimize.mjs`, which adds no JS branch, statement or function for v8 to count; the new `tests/baseline-stamp-sync.test.mjs` is under `tests/`, which `exclude` covers. Previous row, statements **84.55%** · branches **78.75%** · functions **90.68%** · lines **85.88%**, `main`, **vitest 5.0.0**, 2026-09-07, post-v5.5.0, gate exit 0 at floors **81 / 75 / 87 / 83**. Same caliber as the row below (no `include` change), so comparable — and **every column moves by at most the ±0.01 noise floor that row measured, so do NOT attribute any of them**: statements 84.55 → 84.55, branches 78.76 → **78.75**, functions 90.68 → 90.68, lines 85.87 → **85.88**. The D#9 tests add branch arms and cover both sides of them, so a reader expecting branches to RISE is reading a real change that is smaller than the instrument. **The lead the row below filed is now CLOSED, and that is the finding worth carrying**: `hook-optimize.mjs` was the one file whose per-run hit map moved across identical whole-suite runs (368/368/367 statements over nine runs), and it moved because `findMergeCandidates`' untiebroken `ORDER BY` let the clustering loop take a different path depending on whether two fixture inserts landed in the same millisecond. After the D#9 tiebreaker, **five back-to-back whole-suite coverage runs on one unchanged tree read 408 statements / 361 branch arms for that file, identical every time.** Bound it honestly: at the pre-fix rate (~3 of 7 runs differing) five identical runs would happen about 8% of the time by chance, so five runs is *consistent with* the fix rather than proof of it — the argument that carries is that a total order is deterministic by construction. Previous row, statements **84.55%** · branches **78.76%** · functions **90.68%** · lines **85.87%**, `fix/coverage-scope-denylist`, **vitest 5.0.0**, 2026-09-07, gate exit 0 at floors **81 / 75 / 87 / 83**. Same caliber as the row below, and EVERY column moves by less than the ±0.01 noise floor except functions (90.67 → 90.68, one function: `buildCompressPrompt` extracted from `executeSmartCompressCluster` and now covered by both the shipped path and the ruler). Do not attribute the other three. `benchmark/**` stays in `exclude`, so the new ruler contributes nothing to these numbers. Previous row, statements **84.54%** · branches **78.75%** · functions **90.67%** · lines **85.87%**, same branch. Same caliber as the row below, so comparable — but only ONE column moves by more than the ±0.01 noise floor recorded two rows down, and it is the only one worth attributing: branches 78.71 → **78.75** (7393/9392 → 7401/9398), from the D#12 guards and the D#10 veto, each a new branch with cases covering both arms. Statements 84.54 → 84.54 and lines 85.86 → 85.87 are inside the floor; do not attribute them. Previous row, statements **84.54%** · branches **78.71%** · functions **90.67%** · lines **85.86%**, same branch, gate exit 0 at floors **81 / 75 / 87 / 83**. Same caliber as the row below (no `include` change), so comparable: 84.49–84.50 → 84.54, 78.66–78.68 → 78.71, 90.66 → 90.67, 85.82 → 85.86. Attributed, and the attribution is only legitimate because the move CLEARS the noise floor measured on the row below: D#6 added the `concepts` pool and its write branch to `hook-optimize.mjs`, which ten new cases cover — that file alone reads 76.14 → **77.64** statements. Denominators 11586 → 11614 statements, 10034 → 10061 lines. Previous row, statements **84.49–84.50%** · branches **78.66–78.68%** · functions **90.66%** · lines **85.82%**, same branch, gate exit 0 at the re-derived floors **81 / 75 / 87 / 83**. **THIS READING HAS A ±0.01 NOISE FLOOR AND IT IS NOT A ROUNDING ARTEFACT — do not attribute a movement that small to a code change.** Nine whole-suite runs on ONE unchanged tree: statements 9790 ×4 / 9791 ×5 of 11586, branches 7362 ×3 / 7363 ×5 / 7364 ×1 of 9359; functions 1301/1435 and lines 8612/10034 identical in all nine. Localised by diffing per-file hit counts rather than by subtracting totals (doctrine rule 4): **exactly one file moves — `hook-optimize.mjs`, 368/368/367 statements and 318/318/317 branch arms** — and it accounts for the whole aggregate spread. That module is unattended, LLM-driven and writes, it was invisible to the gate until this round, and it is the top item on the open audit list; the instability is a LEAD there, not a coverage-config problem. **This does NOT retro-explain the unattributed −0.01 in the v5.3.1 row** — `hook-optimize.mjs` was outside the gate on that tree, so that row's "recorded as observed, do not invent one" stands as written. **CALIBER BREAK — do NOT diff this row against anything below it.** `include` was inverted from an allowlist to a denylist, so the population went **83 → 130 files** (38 root + 87 lib + 4 cli + 1 server) and statements **8579 → 11586**, lines **7426 → 10034**, branches 7033 → 9359, functions 1060 → 1435. The aggregate fell (85.83 → 84.49 stmts) **because the denominator grew by a third, not because anything regressed** — every file measured before is measured identically now, and the newly-visible modules simply carry their real numbers (`search-engine.mjs` 72.4, `hook-optimize.mjs` 76.1, `adopt-cli.mjs` 78.6, `hook-update.mjs` 85.0). Both arms are same-tree back-to-back, whole suite, name sets read from `coverage/coverage-final.json` rather than the text reporter — **whose ~19-char truncation reads as "not measured" and produced a false negative in this very round** (`...ch-engine.mjs`). Leak check on the new broad `include`: 0 files from `tests/`, 0 from `node_modules/`, 0 `*.config.mjs`. Floors re-derived by the same ~3-point rule the old ones were set by, not re-judged; verified able to say NO (`--coverage.thresholds.functions=91` → exit 1). Previous row, statements **85.83%** · branches **80.22%** · functions **90.47%** · lines **87.00%**, `feat/multiplier-discrimination-ruler`, **vitest 5.0.0**, 2026-09-07, gate exit 0 at the old floors 80 / 74 / 84 / 83 — re-measured on `main` this round and reproduced to the digit before the inversion. Same caliber as the row below (no `include` change), so comparable: 85.81 → 85.83, 80.19 → 80.22, 90.46 → 90.47, 86.97 → 87.00. All four move for one reason and it is attributed, not inferred: D#5 added `reachabilityNote` to `lib/search-core.mjs`, which IS in the `lib/**` allowlist, and its nine cases cover every branch of it. Previous row, statements **85.81%** · branches **80.19%** · functions **90.46%** · lines **86.97%**, `main`, post-v5.4.0 working tree, gate exit 0. **All four columns identical to the v5.4.0 row, and RE-MEASURED rather than carried** — this row's own rule. It could not have moved, for a reason worth stating instead of a coincidence to shrug at: nothing this round touched is in the coverage `include` allowlist. `benchmark/**` is in `exclude`, `scoring-sql.mjs` has never been in `include` (the allowlist is `lib/**` plus 20 named root modules), and the only other edits were `package.json` and a new file under `tests/`. Previous row, `fix/r10-p1-1-session-lifecycle`, 2026-09-07, gate exit 0. **All four columns identical to the v5.3.1 row**, same caliber (no `include` change) — and that is the expected shape, not a stale carry: this round's code changes are in `hook.mjs`, `install.mjs` and `hook-handoff.mjs`, and the first two are deliberately outside the gate's allowlist. Re-measured, not copied. Previous row, `main` @ v5.3.1, gate exit 0. Same caliber as the row it replaced, so comparable: 85.81 → 85.81, 80.20 → **80.19**, 90.46 → 90.46, 86.97 → 86.97. **The −0.01 on branches is NOT attributed** — the only in-scope change is `lib/maintain-core.mjs`, where this round added SQL text (`AND superseded_by IS NULL`) and no JS branch, so the mechanism a subtraction would suggest is not there. Recorded as observed rather than explained; do not invent one. Previous row, v5.3.0, gate exit 0: Same caliber as the row it replaces (no `include` change), so comparable: 85.80 → 85.81, 80.21 → 80.20, 90.46 → 90.46, 86.97 → 86.97 — flat, and that is the expected shape. `deep-search.mjs` (where `deepDisclosureNote` landed) is NOT in the `include` allowlist, so the only in-scope code this round added is the ~10-line `if (isDeep)` disclosure block in `mem-cli.mjs`, which the suite cannot reach (a multi-variant deep result needs a real LLM, and vitest.config.mjs blanks both API keys globally) — hence branches −0.01 and nothing else moving. Previous row, v5.2.0: **85.80 / 80.21 / 90.46 / 86.97**. Same caliber as the row it replaced (no `include` change), so comparable: 85.72 → 85.80, 80.16 → 80.21, 90.44 → 90.46, 86.88 → 86.97 — the only `lib/` lines added that round are the delete-core missing-id branch and `ALL_MAINTAIN_OPS`, both covered. Previous row, `c9c1acb`: **85.72 / 80.16 / 90.44 / 86.88**, gate exit 0. Same caliber as the row it replaces (no `include` change), so this one IS comparable: 85.68 → 85.72, 80.09 → 80.16, 90.42 → 90.44, 86.82 → 86.88 — the prebuild-quarantine tests cover the lines they added. Previous row, `cc4fc5e`: **85.68 / 80.09 / 90.42 / 86.82**. Same caliber as the previous row (the `include` allowlist did not change in R10), so this one IS comparable: 85.87 → 85.68 stmts, 80.15 → 80.09 branches, 90.28 → 90.42 functions, 87.05 → 86.82 lines. The movement is denominator, not regression — R10 added code to `lib/` (`proc-lock` steal protocol, `atomic-write` mode preservation, `deferred-work` scrub, `get-core` notices) faster than it added `lib/` tests, since several R10 guards drive root-level faces that are outside the gate. Gate (80 / 74 / 84 / 83) passes, `test:coverage` exit 0. **RE-MEASURE, NEVER CARRY — this row has been wrong three times**, twice by carrying and once by mis-attributing which files left the `include` list. **`lib/git-state.mjs` — CLOSED 2026-09-06, and it was never a caliber change.** Open since v3.99.0 on the grounds that its row (100 / 90.9 / 100 / 100) is absent from `e694259`'s report and present afterwards. Three facts settle it without a fourth guess and without re-running coverage: at `e694259` the file already existed (added `026508c`, 2026-04-15, untouched since `97c5cab`, 2026-05-10), `lib/**/*.mjs` was already in the coverage `include`, and all four tests that exercise it (`tests/git-state.test.mjs`, `tests/handoff.test.mjs`, `tests/handoff-simulation.test.mjs`, `tests/handoff-git-anchor-r3.test.mjs`) all existed there too — `git cat-file -e` on each. A file in scope and exercised was measured, so the row was in that report and the RECORDING dropped it. Treat the two rows as one population, not two calibers. Caliber note that probably caused it: the v8 text reporter truncates names past ~19 chars (`...n-tracker.mjs`), so a full-name grep returns nothing and reads as "not measured". |

**`scripts/audit-metrics.mjs` module counts changed CALIBER in the R5 batch — do not diff
across it.** `cycles()` and `untestedModules()` used to count `*.config.mjs` as source
modules while `depsMd()` did not, so `--md` printed 163 and `--deps` printed 161 for what
reads as one set, and `eslint.config.mjs` was listed as a source module with no test. All
four reporters now share one predicate (`isGraphModule`), and `--self-check` fails if they
ever disagree again. Modules **163 → 161**, untested **24 / 163 → 23 / 161**. Edges are
unchanged (481 static + 48 lazy, 0 cycles) — both config files have zero local imports, so
only the node count moved.

Re-stamped at `cc4fc5e` (2026-09-06, post-R10): **148 modules, 444 static + 44 lazy edges,
0 cycles**, 171 functions over 50 lines of 1855, duplicate rate 5.15% any / 2.26%
cross-file. `npm run audit:selfcheck` exits 0, so all four reporters still agree. Do not
read 161 → 148 as deletion — the two readings come from different rounds and this row's own
lesson is that the population moved underneath the number.

**`--self-check` also stopped leaking** (R10 P2-18): its `fail()` called `process.exit(1)`,
which skips the `finally` that removes its probe directory, so every failing self-check left
an `audit-metrics-selfcheck-` directory in `/tmp`. It throws now, and the exit is deferred
past the `finally` — moving the exit into the `catch` skips it just the same, which a
forced-failure probe caught.

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
   A `git worktree --detach` checkout once read ~15 LOWER on the same commit — reproduced
   then, **cause still not established**. Never mix contexts. A fresh **CI** clone lands on
   the working-tree side (n=2, identical name sets both rounds).
   **2026-09-06: the discriminating arm ran and did NOT reproduce the offset, but it does
   not settle the cause — do not read it as a retirement.** A `git worktree --detach` at
   `61a6f66` with its **OWN `npm ci`** (a real directory, not a symlink — verified) read
   **45** with a name set byte-identical to the primary tree's reading of the same commit
   (sets diffed, not counts, one fixed commit in both arms). With R9's symlinked-`node_modules`
   arm (48 = 48) that is two worktree arms and no offset, so the offset is **not** a property
   of the checkout alone. Two reasons that is still not a cause:
   (a) **The historical gap's population is largely gone.** `docs/measurement/baselines.md`
   enumerated it as `utils.mjs:12-15`'s backward-compat re-exports **plus their `nlp.mjs` /
   `registry-retriever.mjs` sources** — and `registry-retriever.mjs` was deleted with the
   skill registry in v5.0.0. A non-reproduction against a different population is weak
   evidence about the mechanism.
   (b) **An earlier draft of this rule named the wrong mechanism, in the wrong direction.**
   It said a partial `node_modules` makes imports unresolvable "which reads as unused" —
   that would push the count **UP**, and the observed offset was **DOWN** (31 worktree vs 46
   primary at `2ebc159`). Doctrine rule 10. The mechanisms that could lower a count are the
   documented ones: knip dropping whole modules from the report (the `new URL(...)` blind
   spot), gitignore evaluation, and `knip.json` listing `tests/**/*.test.mjs` as `entry`
   while `project` excludes `tests/**`.
   **Practical rule, unchanged: measure from the primary tree, and never mix a reading from
   another context into the baseline.** What the new arm buys is that a worktree reading is
   no longer presumed 15 low — it is worth diffing name sets against the primary tree rather
   than discarding.
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

**Coverage `include` is a DENYLIST since 2026-09-07 — everything shipped is measured, and
staying out costs a named `exclude` entry.** It reads `lib/**/*.mjs`, `cli/**/*.mjs`,
`server/**/*.mjs`, `*.mjs`; `*.mjs` is root-only because vitest 5 matches the RELATIVE
path. Deliberately **outside**: `install.mjs`, `server.mjs`, `hook.mjs`, `cli.mjs`,
`*.config.mjs`, `benchmark/**`, `scripts/**`, `experiment/**` — the four entry files are
exercised through subprocess E2E, which v8 coverage of the parent process cannot observe.
**Quote the v8 text reporter, not `coverage/clover.xml`** (different caliber, will not
reconcile).

**The sentence this replaces was wrong in the way doctrine rule 3 exists to prevent**: it
said "`lib/**` plus hand-picked root modules" and named three exclusions, while the
allowlist actually left **24 shipped modules — 10,137 lines against 30,305 — outside with
no stated reason**, so 85.83% described 62.5% of the shipped tree. Among the invisible:
`search-engine.mjs`, `scoring-sql.mjs`, `rerank.mjs`, `deep-search.mjs` — the retrieval
core this whole doctrine is about — plus all of `cli/**` (including `cli/common.mjs`, the
shared render layer `server.mjs` imports) and `server/fts-check.mjs`. This was the THIRD
round to find code hiding in that allowlist (P2-2 2026-08-22, P1-15 2026-09-02), and the
first to remove the mechanism rather than the instance.

`tests/coverage-scope.test.mjs` pins the scope, and **its matcher model is
version-coupled — read `BaseCoverageProvider.isIncluded`, do not remember it.** It
modelled vitest **4** (absolute path, `{ contains: true }`) for the whole of vitest 5 and
nothing went red, because the old simple `include` made both semantics agree. It now
models v5 (relative path, no `contains`) behind a tripwire that fails on the next major.
Under the stale model an `exclude` entry was a SUBSTRING test, so `'cli.mjs'` also
excluded `mem-cli.mjs` and `adopt-cli.mjs`.

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
- **`Stop` fires once per assistant TURN, and `/clear` ROTATES the host session id.** Both
  were measured 2026-09-07, and the code had modelled both backwards since long before R10.
  Stop deleted the session file on the "Stop = /exit" model, so `getSessionId()` minted a
  fresh mem session on the next event (58 prompts / 16 host sessions → **56** mem sessions
  and 56 `session_summaries` rows, 0 of which carried the LLM-only fields) **and**
  `handleSessionStart`'s mid-restart probe — which reads that same file — never fired, so
  the `/clear` handoff branch was unreachable in production (**0** `clear` rows against 21
  sessions). The rotation half is the discriminator R10 §8 said not to guess at: of 21 real
  transcripts under `~/.claude/projects/<slug>/`, 12 carry a `<command-name>/clear` record
  and in **12/12** its timestamp precedes its own file's first record by ~0.1s (−0.08…−0.19s)
  — the command is issued in the OLD session and replayed into a NEW file under a NEW id.
  Consequences that outlive the fix: (a) the session file now survives Stop, so **the file's
  presence no longer tells you why a session started** — ask the host's stdin `source`
  (`startup|clear|compact|resume`), which is why SessionStart reads it; (b) under rotation a
  `/clear` handoff is written under the NEW cc id while the prompts it summarises carry the
  OLD one, so `buildAndSaveHandoff` falls back to the unscoped prompt query when the scoped
  one is empty — D#26's scoping is there to stop two live sessions MERGING, and an empty
  scope has nothing to merge with. Revert: `CLAUDE_MEM_LEGACY_STOP_UNLINK=1` (re-breaks the
  clear path by design). **`tests/handoff-simulation.test.mjs` asserts on its own local
  re-implementation of the SessionStart output, not on the hook's** — it is why "Working
  State (from /clear)" had passing tests for a block no user had ever seen.
- **`hooks/hooks.json` and `install.mjs`'s direct `settings.json` entries are two separate
  hook sets and must be changed together** — `tests/audit-silent-20260814.test.mjs` diffs
  them and is verified binding. **That diff does not compare `timeout`**, which is how
  SessionStart ran with 15 s under the plugin shape and 10 s under the settings.json shape
  for several releases (R10 P2-16, now both 15). If you add a field to either set, ask
  whether the guard actually reads it.
- **Search's reported `total` is NOT the number of rows you can page to, and since D#5 the
  surfaces say so.** `computePerSourceWindow` is offset-independent by design (D#30: an
  offset-scaled pool re-ranks its own prefix under RRF, so pages overlapped and gapped on a
  vector-populated DB) — that bound is correct and stays. `countSearchTotal` meanwhile
  re-derives the FULL match+filter population, so the two numbers answer different
  questions. Measured 2026-09-07 on a 128-row sandbox corpus: last non-empty offset
  **59 / 59 / 89** for limits **10 / 20 / 30**, i.e. at the default `mem_search` limit of 20,
  **60 of 128 rows (46.9%) are unreachable at ANY offset**. `reachabilityNote`
  (`lib/search-core.mjs`) now discloses it on both faces; off switch
  `CLAUDE_MEM_REACH_DISCLOSURE=off`. **The reachable count is `preFinalizeCount`
  (`results.length` pre-slice), never a re-derived `max(limit*3, 60)`** — `perSourceLimit`
  is PER SOURCE, so a cross-source query fuses up to four such pools and the formula would
  understate its reach. Guarded by `tests/search-reachability-note.test.mjs`, including
  that BOTH faces call the shared helper and read `reachable` from the same source; four
  mutations, four kills.
- **A SQL `LIMIT` upstream of a JS-side relevance filter is a REACHABILITY bound, not a
  ranking bound.** It silently makes well-matching rows unpickable, and an importance
  demotion across the pool's `WHERE` becomes an *eviction* rather than a down-rank. This
  shape has been found on five faces. Count such populations with the pool's OWN
  `liveObsFilterSql`, never a bare `WHERE importance = 3`.
- **`ORDER BY created_at_epoch DESC` without an id tiebreaker INVERTS itself on a tie, and the
  ties are common.** Measured 2026-09-07, both arms, because two mechanisms fitted the
  observation and they need different fixes. **Not** SQLite's plan varying: 8 rows forced onto
  one epoch, 200 queries over 20 fresh DBs, exactly **one** returned order. It is that the ties
  themselves differ per run — two inserts reading `Date.now()` each (the
  `tests/test-helpers.mjs:75` shape, and the shape production writes take) land in the **same
  millisecond 272/300 = 90.67%** and straddle 28/300. The damage is in the DIRECTION, which
  neither the audit nor I predicted: **on a tie SQLite returns ASCENDING rowid — oldest first —
  while an untied pool returns newest first**, so the stated "newest first" silently flips
  whenever the clock has not ticked. Two harm classes follow, and they are not the same:
  (1) `ORDER BY … LIMIT n` feeding JS-side work makes pool MEMBERSHIP arbitrary at the boundary
  (reproduced: five eligible rows on one epoch, limit 3, returned the three **oldest**); (2)
  anything treating the first row as privileged picks arbitrary CONTENT — `executeMergeCluster`'s
  keeper reduce fell through to `cluster[0]` on a full tie, and same-episode duplicates ARE a
  full tie, so which duplicate survived depended on a millisecond boundary. Fixed in
  `hook-optimize.mjs` only — **all SEVEN `ORDER BY … created_at_epoch DESC` sites in the file,
  and the first pass shipped six.** **Two different counts live here and a draft of this bullet
  conflated them, which pre-ship review caught**: `findReenrichCandidates` holds **five** pools
  (five `db.prepare` blocks — `scopes`, `aliases`, `concepts`, `wide`, `narrow`); the **file**
  holds seven such sites, those five plus `extractUniqueConcepts` and `findMergeCandidates`. So
  "count the `db.prepare` blocks" answers *how many pools*, not *how many sites* — an earlier
  draft handed the reader that method for the seven and it returns five. The count has now been
  wrong twice in the same direction, both times because a `grep` for the one-line
  `created_at_epoch DESC, id DESC` spelling cannot see an `ORDER BY` that leads with a
  multi-line `CASE …` term. Two do: `scopes` (found in the first pass) and **`wide` (missed —
  fixed 2026-09-07)**. `wide` was the costly one to miss: it is the scope the DAILY unattended
  path passes explicitly (`handleLLMOptimize` via auto-maintain, `reenrich` budget 6), so a
  boundary tie decided **which rows reach the LLM on a given run** — not which rows are ever
  reached, because `executeReenrich` stamps `optimized_at` in the same UPDATE as the enrichment
  and a processed row leaves the pool. Permanent starvation needs the pass to keep *skipping*
  the same rows (no LLM slot, or unparseable JSON — both `continue` without stamping), which is
  reachable but conditional. It went unnoticed because the original boundary test drove
  `scope: 'narrow'` only. Plus the keeper reduce, made total on its own because it is exported
  and callers build their own clusters.
  **An EIGHTH ordering in the same file is deliberately NOT fixed, and naming it is what makes
  the completeness claim true**: `findSmartCompressCandidates` (`hook-optimize.mjs:1102`) runs
  `ORDER BY project, created_at_epoch` — ascending, no `id`, no `LIMIT` — so it falls outside
  the seven by construction and outside the 52 below (which excludes this file). It feeds
  `clusterForCompression`, and a tie can move cluster MEMBERSHIP on the path that hides rows.
  **Its excuse expired on 2026-09-07 and the priority went UP, not down.** The excuse was that
  the damage needed the TF-IDF cosine branch, which required a default-off env flag; Phase-2
  deleted that branch, so what remains is a 14-day window whose sub-cluster anchor is
  `sorted[0]` after a STABLE JS sort — which preserves SQL order as the tiebreak. The hazard is
  therefore unconditional now, on the default path. Still left alone under Iron Law #1 because
  no failing case has been built. **Unjudged, not cleared — and no longer gated.**
  **The other 52 sites in other files are NOT cleared, just unjudged** (D#15 — 52 is a re-count
  by name on 2026-09-07, excluding `CREATE INDEX` definitions and comments; the earlier "~42"
  was an undercount). Most are display order, where an arbitrary tie is cosmetic, and **the tie
  itself is not currently firing on this corpus**: a read-only probe of the real DB found
  **0 tie-groups across all four relevant tables, under TWO groupings** — the pool's own key
  plus `created_at_epoch`, and the strictly looser `created_at_epoch` alone, which is the
  actual tie condition for an untiebroken `ORDER BY created_at_epoch DESC`. Row counts at the
  second probe: observations 25, session_handoffs 3, session_summaries 133, events 771. **The
  first stamp of this bullet said 21 / 3 / 128 / 717 and was stale within the same day** —
  this session's own writes moved three of the four, which is doctrine rule 2 happening to the
  rule that states it. The counts are a snapshot; the 0 is the finding.
  Read that as "has not happened here yet", not "cannot": the 272/300 same-millisecond rate D#9
  measured is the shape of a tight insert LOOP (fixtures, batch writes), and purge/compress
  removes rows, so history is not fully represented. **The 52 is also a count without a
  recorded name set** — reproducible under the caliber stated here (`.mjs`/`.js` outside
  `tests/` and `benchmark/`, `DESC` orderings only, comments and `CREATE INDEX` excluded; the
  same sweep including ASC reads 65), but doctrine rule 4 wants the names, and nobody can
  supersede a count they cannot diff. **R11 §5 records the name set for three partitions** —
  the retrieval core, the citation chain and the LLM write paths — judged one by one:
  **19 harmful, 15 clean**. Four of the harmful are now total (`search-engine.mjs`
  `findFtsAnchor` and the no-query recent listing; `lib/search-core.mjs` type-list fallback
  and prompts CJK LIKE fallback); the rest are named and left, most because they move
  candidate-pool membership and therefore owe a denoise-ab first. **Do not subtract 19/15
  from the 52** — different caliber: R11 counted ASC orderings and `hook-optimize.mjs`, both
  of which the 52 excludes by construction. `findFtsAnchor` is the one worth remembering:
  with `LIMIT 1` the tie decided the timeline ANCHOR, so the whole navigation window moved,
  which is the CONTENT harm class rather than the pool-boundary one. Re-probe with
  `SELECT project||'/'||type k, created_at_epoch e, COUNT(*) c FROM session_handoffs GROUP BY k, e
  HAVING c > 1` before spending a round on the remaining sites. Match `hook-memory.mjs:683`'s
  spelling (`importance DESC, created_at_epoch DESC, id DESC`) — it is the one face that already
  got this right.
- **`COALESCE(compressed_into,0)=0` alone is NOT the liveness predicate** — `liveObsFilterSql`
  also requires `superseded_at IS NULL`. **Which sites need the full one is settled; do not
  re-derive it.** Carrying it: the two `COMPRESSED_PENDING_PURGE` writers
  (`decayAndMarkIdle`'s mark-idle arm, `search-scoring.runIdleCleanup`) and
  `mergeDuplicates`' keeper write — because `purgeStale` hard-deletes that sentinel, and
  deleting a retired row destroys the `superseded_by` that the Stop citation loop follows to
  credit a `#NN` to its successor (27 of 31 superseded rows carry one). Deliberately NOT
  carrying it, each for its OWN stated reason:
  - `decayAndMarkIdle`'s **decay arm**, `boostAccessed`, `demotePinned` — move only
    `importance`, inert on a row every read path already hides. (`lib/maintain-core.mjs:436-441`
    says "**the first three**" for exactly this reason; a draft of this bullet flattened that
    into all four and handed `cleanupBroken` an inertness claim that is false.)
  - `markAutoCompressible` — writes `-1`, which both `purgeStale` (`-2`) and
    `recoverOrphanedChildren` (`> 0`) skip, so it cannot delete or resurface anything.
  - **`cleanupBroken` is the one HARD-DELETE site in this set**, and since 2026-09-07 it is
    the one site carrying a NARROWER guard rather than none: `AND superseded_by IS NULL`.
    **This bullet used to say "left bare" — that is no longer true, and D#4 is closed.** It
    was the only place the harm above was reachable at all (deleting a supersede tombstone
    takes `superseded_by` with it), and the only exemption resting on a **likelihood**
    judgement rather than an inertness proof: its rows have no title, narrative or lesson,
    so they are absent from every injection surface, so an id never injected is not one a
    `#NN` cites. Narrow but not impossible — a hand-typed `#NN`, or a numeric
    `save --supersedes` chain later blanked by a degenerate cluster-merge — so it was fixed
    rather than re-argued. **Not the full `liveObsFilterSql`, deliberately**: a retired row
    whose `superseded_by` is null hands `redirectSupersededIds` nothing (it falls through to
    `out.add(id)`, the same answer a missing row gives), so it stays reclaimable; filtering
    on `superseded_at` would strand every empty retired row here forever. Guarded by two
    cases in `tests/superseded-write-guards.test.mjs`, the first verified RED against the
    real pre-fix predicate.
  - `maintenanceStats` — puts `superseded_at IS NULL` inside the **stale** CASE only, so each
    forecast matches the op it predicts rather than one outer predicate that would be wrong
    for `boostable` and `pinned`.
  - `hardDeleteCandidateCount`'s cleanup arm — `cleanupBroken`'s predicate **minus** its
    `lesson_learned` guard, so it deliberately OVER-counts by every lesson-bearing
    empty-content row (`:635-637`: over-counting costs one extra bounded backup). Do not call
    it a mirror; it is directionally-safe on purpose.
  - `stats-core.computeStatsFeed` — one predicate on both halves of a ratio, with superseded
    rows reported on their own line.
  Judged point by point 2026-09-06 across all 11 shipped sites (R8 §6-a, carried as open in
  R10 §7) — **zero code changes warranted at the time**, but read each reason as written:
  they are not the same reason. **The one that was a probability argument is now a guard**
  (`cleanupBroken`, 2026-09-07, D#4 closed); the other ten still stand on the reasons given
  above, and re-deriving them is what that judgement round already paid for.
- **The cross-hook injected-ids marker is a union across TABLES**, so ids need namespacing
  (`injectedIdKey` in `lib/injected-ids.mjs`: `P` prompts, `D` deferred, `E` events,
  observations bare). 91.6% of observation ids also exist as an event id.
- **`Stop` fires once per assistant TURN and rescans the WHOLE transcript, so every Stop-side
  writer needs a per-session idempotency key — and `access_count` values written before
  v5.6.0 are an upper bound, not a count.** Four of the five writers had one
  (`applyCitationDecay` has two: `last_cited_session_id` for promote, `last_decided_session_id`
  for uncited; `recordCitationSurfaces` and `recordCitationFunnel` are idempotent by
  construction). `bumpCitationAccess` had none, and its only multi-call test asserted the
  accumulation as if it were the contract. Measured over 51 real transcripts replayed at true
  turn boundaries: **338 credits across 43 distinct (session, id) pairs = 7.86×**, worst
  single session 18.75×. It feeds `boostAccessed` (`access_count > 3` → `importance + 1`,
  unattended daily) and suppresses `noisePenaltyClause`, whose predicate reads
  `injection_count > access_count * 3`. Fixed by `observations.last_access_session_id` (v48,
  the table's THIRD per-row session key) — deliberately separate from the decay pair, because
  decay resolves a mainOnly set behind `hasMainThreadAssistantText` while this channel
  resolves the whole transcript including sidechains, so one shared key would let either
  channel silence the other. **Existing rows are NOT back-corrected** (the true count is not
  recoverable), and D#206's "at most 3 rows could have crossed the threshold on citations" is
  retracted — it was computed on the premise this fixes, and no replacement bound is measured.
  **Scope the guarantee**: the column holds the LAST crediting session, not a set, so two
  same-project sessions interleaving their turns flip the stamp between them and the key
  degrades toward per-turn counting for that pair — the same bound `last_cited_session_id`
  and `lib/edge-attribution.mjs` already accept. Exact for one session at a time.
- **The cite-recall nudge's `lowStreak` counts SESSIONS, and the saturated knob is the
  THRESHOLD, not the denominator.** The writer sat in `trackCitationsAtStop` and incremented
  per fire, so with ~6 turns per session the silence-after-3 default was reached inside the
  first session: this machine read `lowStreak = 58` for a project with 26 transcripts on
  disk, and 2 of 3 projects had the cite-`#NN` nudge permanently silenced. Fixed via
  `nextCiteStreakState` (payloads with no `lastStreakSession` are pre-fix and discarded once,
  so no file surgery). **The denominator swap R11 proposed was measured and NOT taken**: over
  the same 51 transcripts, using `extractAllInjected` cuts the QUALIFYING population 37 → 7
  but the gate still fires on 100% of qualifying sessions under BOTH denominators, because
  real cite-recall never exceeds 0.5 here (min 0, p25 0, median 0.375, p75 0.5, max 0.5)
  while `CLAUDE_MEM_CITE_NUDGE_THRESHOLD` defaults to 0.6. A threshold no session can satisfy
  guarantees the silence regardless of what the denominator is.
- **The `#NN` numerator caliber excludes the other tables' namespaces, and that changed the
  caliber of three rulers.** This product renders and teaches `E#N` / `P#N` / `D#N` / `S#N`;
  every injected-side extractor drops them by construction, and the cited side did not, so
  `E#501` read as observation 501 — on this machine 26/26 live observation ids are also event
  ids AND prompt ids. The old docblock argument ("a loose numerator is free, because a cited
  id only counts once it intersects an ANCHORED injected set") has one measured exception:
  `extractUserTypedIds` runs the same regex over the user's own message, so both sides of the
  intersection were unanchored. Same-tree A/B: **9 of 44 credited (session, id) pairs — 20.5%
  — came in through a namespace token.** `citationIdRe()` now carries `(?<![A-Za-z0-9])`.
  **Do not diff citation numbers across this change**: `benchmark/cite-recall.mjs` and
  `benchmark/efficacy-observational.mjs` import it directly and
  `benchmark/citation-live-replay.mjs` reaches it through `extractCitationsFromTranscript`.
  It deliberately does NOT catch `issue #1234` or `[link](#42)` — a digit after a space or
  `(` is indistinguishable from a citation at this layer.
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
- **`MEM_NO_AUTO_ADOPT=1` is a GLOBAL opt-out and every auto-adopt caller must honour it.**
  `install.mjs`'s dogfood branch respected only `--no-adopt`, and because it detects this
  repo by its git REMOTE while adopt-cli resolves its TARGET from `CLAUDE_PROJECT_DIR ‖ PWD`,
  the unit suite rewrote this repository's own CLAUDE.md managed block and `.claude/`
  sidecar on every run (R9's "fourth trap"; R10 P2-17 found the writer). Any test that
  spawns `install.mjs install` or `repair` must set it —
  `tests/suite-touches-no-repo-files.test.mjs` scans for that and skips `doctor` / `status`
  / `uninstall` spawners, which cannot reach the adopt path.
- **`writeFileSync(path, data, { flag: 'wx' })` is TWO syscalls**, so the file is briefly
  visible EMPTY. Anything that treats an unparseable file as reclaimable — `proc-lock`'s
  `isStale` did — will steal a lock its owner is mid-way through creating. Fill a private
  temp and `linkSync` it into place instead; `link` is atomic, fails EEXIST exactly like
  O_EXCL, and never exposes the name without its contents (R10 P1-7).
- **A `project` column is not a substitute for a project CHECK on a write.** `resolveProject`
  is fuzzy by design for reads, where a wrong guess costs a query; write callers must pass
  `{ mode: 'write' }`, and cross-project operations (`mergeDuplicates`, the
  `normalize-project-names` cleanup) must compare the two rows' projects before acting.
  Both faces silently relocated user data before R10 P2-3 / P2-7 / P1-2.
- **`optimized_at` is the re-enrich pools' "seen it" flag and nothing else's.** Normalize
  used to stamp it as a side effect of replacing one concept term, evicting rows from a
  lesson backfill they had never visited (R10 P2-2). Before writing it, check you are the
  pass it belongs to.
- **Every re-enrich pool's predicate is some other pass's OUTPUT column, so filling a
  column EVICTS the row from whatever pool keyed on its emptiness.** This has now been
  found three times and the third one was created by the second one's fix, so treat it as
  a class, not an incident: `optimized_at` (R10 P2-2, above), `search_aliases` (P1-2), and
  `concepts` (D#6). `save-enrich` fires on every successful manual save and writes
  `search_aliases` + `lesson_learned` + `scope` — which are exactly narrow's, wide's,
  aliases' and scopes' predicates — so a save-enriched row matched **none of the four** and
  never received concepts. Measured on the real DB 2026-09-07: 16 live rows, 15
  conceptless, 16 with aliases, all four pools **0**. Its docblock's "the daily wide
  re-enrich stays the safety net" was true of `optimized_at` and false in effect.
  **Before adding a writer, ask which pool's WHERE clause that column is**; before adding a
  pool, key it on the column it fills and nothing else, so idempotency is "the thing I
  write becomes non-empty" (`aliases`, `scopes` and now `concepts` all do this, and all
  three are deliberately un-gated on `optimized_at`). Fixed by a pool, not by widening
  save-enrich's contract — a source-side fix cannot reach rows already on disk. Pool 0 → 14
  on the real corpus; the 15th is named, not subtracted (#44, 79-char narrative, below the
  substantive gate). Concepts are worth **+0.0846 R@10 / +0.0579 nDCG** where they exist
  (benchmark fixture, same-tree A/B) — against **+0.0002 R@10** for all eight scoring
  multipliers combined — but that is *what they are worth*, NOT what backfilling recovers
  in production, which is still unmeasured.
- **A prebuilt addon that is PRESENT and will not load cannot be healed by compiling one.**
  better-sqlite3 13's `lib/binding.js` picks `prebuilds/<target>.node` on **existence alone**
  and prefers it over `build/`, so whatever `npm run --prefix node_modules/better-sqlite3
  build-release` produces stays shadowed. Measured 2026-09-06 with a control: corrupt prebuild
  + healthy `build/Release` → `wrong ELF class`; prebuild moved aside → opens; neither → fails.
  Real triggers are a glibc too old for the shipped binary, a truncated download, the wrong
  arch baked into an image. Before the fix `rebuild-binding` exited 1 on that shape and printed
  a manual command with the same dead end, so `doctor` stayed red forever.
  `ensureBetterSqlite3Working` now renames the dead prebuild to `<name>.node.unusable` before
  the source build and puts it back if the compile did not help. **Only inside the source-build
  branch** — quarantining with no compile to follow turns "broken addon" into "no addon", and
  that branch is exactly what the 20 s SessionStart path opts out of (`sourceBuild: false`).
- **Never name the native addon's path — ask `lib/binding.js`'s `getPrebuildPath()`.** The
  literal has now gone stale twice on one dependency bump: `tests/install-bsqlite-probe.test.mjs`
  (caught by its control) and both sandbox phases (caught by nothing for four minor versions).
- **Deep search answers questions the corpus cannot answer, and the recall ruler cannot
  see it.** Measured 2026-09-06 with `benchmark/deep-search-holdout.mjs` (the suite's own
  queries asked of a corpus with their `relevant_ids` deleted): **mean FP@10 = 10.00,
  12/12 queries flooded** — every slot filled, every time. **The flood is NOT the paraphrase
  union.** This bullet used to say the single-query baseline returns 1-2 rows on the same
  negatives and that the union fills the page; measured 2026-09-07 on the same fixture, the
  single-variant baseline already returns **mean 9.42 of 10** (min 5, max 10, n=12), so
  fusion adds about half a slot to a page that was full. A counterfactual names the real
  source: disabling the AND→OR fallback in `search-engine.mjs` takes **mean FP@10 from 10.00
  to 0.08**, 0/12 queries flooded instead of 12/12 (mutation applied and reverted, checksums
  both ways). That is a MECHANISM PROBE, not a candidate fix — the same fallback is the
  vocab-mismatch recall win, per the rejected gate #1 below. `rrfFuseN` fuses by RANK, so no
  magnitude signal survives into the merge for a downstream floor to act on. The user-visible shape: `search "kubernetes
  helm chart"` correctly says *No results*, and `--deep` on the same query returns 8 of 13
  webshop memories. **`mem_search`'s `deep` is AUTO by default** (`resolveDeepMode`,
  surface `mcp`), and auto-escalation fires exactly when the normal search was weak — i.e.
  precisely when the honest answer is "nothing". **Three gates were tested against BOTH
  arms and rejected** — do not re-propose one without running the holdout ruler AND
  `tests/benchmark-deep-search.test.mjs`; the ruler's docblock names all three and why,
  the headline being that suppressing OR-fallback on rewrites takes deep R@10 from 0.7383
  to 0.3962 because **the vocab-mismatch win IS OR-fallback on rewrites**. The signal
  analysis says the discrimination is not available at this layer: with the right rows
  deleted the engine returns the next-most-adjacent rows, and on vm-7/vm-8/vm-12 the
  holdout arm scores at or ABOVE the positive arm on every quantity `deepSearch` can see.
- **The AND→OR fallback DISARMS auto-escalation, so both deep-search rulers are blind to
  the `auto` policy and every number they report describes EXPLICIT deep** (D#8, measured
  2026-09-07, `main`, `seed-data.json` + the 12 vocab-mismatch queries). Auto fires when the
  plain observation search returns fewer than `AUTO_DEEP_MIN_RESULTS` (3) rows — a COUNT —
  while the OR fallback exists precisely to make that count non-zero. It fires on **12/12
  queries in both populations** — one fixture, `seed-data.json`, read two ways: the holdout
  population with each query's `relevant_ids` deleted, and the full population with nothing
  deleted. They are two derived populations, not two independent datasets (doctrine rule 3).
  The plain count at the pipeline's own window
  (`computePerSourceWindow` = `max(limit*3, 60)`, NOT `deepSearch`'s internal
  `max(limit, 20)`) reads **min 5 / mean 21.42 on the holdout arm**, with the full corpus
  the same shape. `shouldEscalateToDeep` is therefore **false on 12/12, both arms**.
  **Consequence for anyone planning an escalation-policy A/B**: D#8's two arms (escalate at
  `hits < 3` vs at `1 <= hits < 3`) would read IDENTICALLY here, and that Δ=0 is a blind
  instrument, not a verdict — doctrine rule 9, the same trap D#14 closed on. The reach is
  now printed by the ruler and pinned by `tests/deep-search.test.mjs`, so a fixture that
  gains an escalating query goes red instead of being silently absent. **Also corrected
  here**: the holdout ruler's docblock claimed "the single-query baseline returns 1-2 rows
  on the same negatives". It does not reproduce — the single-variant baseline reads
  **mean 9.42 of 10** (min 5, max 10, n=12) against deep's 10.00, so paraphrase union adds
  about half a slot to a page that was already full. Provenance of the 1-2 figure could not
  be established; recorded as not reproducing rather than explained (doctrine rule 10).
- **A metric named after the thing is not a measurement of the thing — the TF-IDF vector arm
  was retired in v3.17.0 on a number that never touched it.** That release cited
  `benchmark/ci-gate.mjs: hybrid_over_bm25 = 0` as "~0 lift" for the vector arm. Checked
  2026-09-07: `benchmark/benchmark.mjs:300` defines `hybrid` as the eight SCORING MULTIPLIERS
  over BM25, `:676` computes the delta against `bm25_only`, and `:611` shows
  `production_hybrid` — the only mode that runs the real `searchObservationsHybrid` — is not
  in the matrix at all. Neither term of that delta executes a vector path, so the citation
  could not have said yes OR no. **The word "hybrid" means two different things in this repo**
  (multiplier-hybrid in the matrix, FTS+vector-hybrid in the function name), and that collision
  is what made a wrong citation read as a right one for 2.5 months.
  The verdict survived re-measurement — the same release ALSO ran the correct instrument, and
  a same-tree A/B reproduces it to the digit (`--production-hybrid` R@10 0.8998 off / 0.8980
  on) with two columns v3.17.0 never reported (P@10 0.8497 → 0.7819, P95 2.7158 → 3.8716ms),
  while the vocabulary-mismatch fixture, where the ruler is far from saturated and CAN say no,
  reads negative on every column (R@10 0.3407 → 0.3018, −11.4%). **So the lesson is not "the
  decision was wrong" — it is that a decision can be right and its stated evidence still be
  incapable of supporting it.** Before quoting a gate number as evidence about a subsystem,
  open the ruler and check which arms it actually executes (doctrine rules 9 and 10).
- **`benchmark:gate` CANNOT say NO about the eight scoring multipliers, and its zeros are
  a blind instrument, not dead weight.** Both halves measured 2026-09-07 at `main` @
  f25e8ae. The gate's only multiplier check is `hybrid_over_bm25` with floor **−0.05**,
  and the reading is **+0.0002 R@10 / +0.0055 nDCG** — so the entire chain can degrade to
  pure BM25 and stay 0.05 above the floor. The eight per-term ablation deltas `--matrix`
  prints are gated by **nothing**. Proven by mutating the real tree and reverting it
  (checksums verified both ways): neutering `MULT_EXPR.importance` to a constant left the
  gate at **exit 0, all four checks PASS**, with `hybrid_over_bm25` going **UP** (R 0.0002
  → 0.0019) because importance is a NEGATIVE contributor on this fixture; changing
  `MULT_EXPR.lesson`'s 0.3 to 0.5 left the gate's output **byte-identical, every digit**.
  The cause is a saturated corpus — `bm25_only` alone reads R@10 0.8996 / P@10 0.9731 —
  plus axes the fixture cannot vary: `seed-data.json` carries **no** `access_count`,
  `lesson_learned`, or cite/noise counters, and 29 of 30 queries set no project while the
  one that does also FILTERS on it, which makes the boost rank-invariant. **Do not read
  `drop X → Δ=0` as "X is dead weight"** — `scoring-sql.mjs`'s old note blamed a
  "single-project fixture", which is false (5 projects × 40 rows). Use
  `benchmark/multiplier-discrimination.mjs`: tied-BM25 pairs recover each multiplier's own
  ratio, and **all eight are alive with their declared magnitude** (decay 1.9770, type
  1.8333, project 2.0000, importance 2.0000, access 1.5004, lesson 1.3000, noise 5.0000,
  cite 2.0000). Retuning a constant in `scoring-sql.mjs` or `MULT_EXPR` requires re-running
  that ruler; the aggregate gate will not notice. **Still open, and a different question:
  whether these priors help a real user** — "wired up" is not "calibrated". **What is now
  settled is that this question is NOT answerable on this machine, and the blocker is the
  corpus, not the instrument** (D#14, measured 2026-09-07, read-only). Do not re-derive it, and
  do not start building an eval before re-running its two denominators. The whole real corpus
  is **21 live observations** (code-graph-mcp 10 / claude-mem-lite 6 / claudemd 5). The only
  real relevance labels available are citations, and `citation-live-replay` over all 47
  transcripts yields **59 (session, id) pairs, 23 cited** — which sounds workable and is not,
  because a pairwise ranking metric can only score a **cited × uncited pair inside one session
  and one face**, and that product is **25**, from 6 mixed sessions. Then the decisive cut:
  **24 of those 25 come from `error_recall`, which ranks by `bm25 × decay`** (see
  `lib/error-recall-core.mjs`'s own comment that `rows[0]` is the bm25×decay RANK-top) **and
  never touches the eight-multiplier chain**; the multiplier-bearing faces contribute **1**, and
  the only query-bearing face, `ups`, contributes **0**. LongMemEval is not the substitute it
  looks like: `benchmark/datasets/README.md` states the adapter holds decay / project-boost /
  importance CONSTANT on purpose, and the dataset carries none of the columns the other five
  multipliers read — that makes it **BLIND, not a source of DEAD verdicts**, the exact misreading
  the tied-pair ruler exists to prevent. Reopen when the corpus reaches ~500 live observations
  **and** the mixed-session contrast pairs reach ~200; at 25 pairs the 95% CI on pairwise
  accuracy is about ±20 points, which cannot separate 0.5 from 0.6.
- **A long LLM round-trip needs `liveObsFilterSql` in the UPDATE's WHERE, not just in the
  SELECT that chose the row.** 45 seconds is long enough for a concurrent hook to supersede
  or compress it, and an unguarded write resurrects a dead row AND stamps it processed
  (R10 P3-3). Treat `changes === 0` as a skip, not a success. **R10 fixed the general
  branch and stopped there; a 2026-09-07 sweep of all 11 observation writes in
  `hook-optimize.mjs` found two siblings still bare (D#12), and one of them is worse than a
  stale write.** The importance:0 auto-hide sets `compressed_into = COMPRESSED_AUTO (-1)`,
  and `compressed_into` is the child → keeper POINTER: if a concurrent merge/compress adopts
  the row mid-call it holds a POSITIVE keeper id, and −1 over that destroys the link, since
  `lib/maintain-core.mjs:316` recovers orphans with `compressed_into > 0` and
  `recoverChildrenOf` follows the same id. The sibling write at `lib/maintain-core.mjs:631`
  already carried the predicate, so **when one write of a pair is guarded, check the other
  before assuming it is a design choice.** Two of the eleven looked bare and were not
  (`:941/:947` sit inside a transaction that re-checks keeper liveness first) — read the
  surrounding block, do not grep for the predicate.
- **An `if (x)` guard whose else-branch is a LOOSER RULE is not a fallback, it is a second
  policy nobody reviewed — and deleting the `if` does not delete the problem, it promotes
  it.** `clusterForCompression` was the one site where a null TF-IDF vocabulary, instead of
  making the vector path *skip*, fell through to grouping by a **14-day window alone, with no
  similarity check**. Because the arm was default-off, that looser branch was ALREADY the only
  reachable path, running unattended (`hook.mjs:1940` → `handleLLMOptimize` passes no `tasks`).
  Measured 2026-09-07 with a control arm, three observations sharing only project and era, 12
  days apart: **arm on → 0 clusters, arm off → 1 cluster of all three.** Not observed in
  production here (0 eligible rows on this corpus), so it is a demonstrated mechanism, not an
  incident. **Phase-2 then removed the vector arm, which makes the loose branch the only
  branch by construction — production behaviour unchanged, review surface reduced to one
  path, and the control arm above no longer re-runnable.** Read the reading with that
  expiry: it is the last measurement of a comparison that no longer exists. **And the two LLM cluster
  paths disagreed about whether the model may refuse**: `executeMergeCluster` has always had
  `should_merge`; `executeSmartCompressCluster` had no veto and a prompt that *asserted*
  relatedness — on the path that HIDES its inputs. It now fails CLOSED on a missing verdict
  (D#10 option b), because refusing wrongly costs a skipped compression while proceeding
  wrongly hides real rows. **Option (a) — make the null-vocabulary branch skip outright — is
  OPEN and deliberately not taken**: it would disable smart-compress on the default config,
  a released-artifact user-visible default behaviour change. **The condition for revisiting
  (a) was to measure the veto first, and that measurement now exists**
  (`benchmark/compress-veto-rate.mjs`, 2026-09-07, openrouter-routed sonnet, run twice
  back-to-back with identical results): **veto rate 6/6 = 100% on the unrelated arm,
  false-refusal 0/6 = 0% on the related arm, 0 errors.** Read the bound with the number:
  n=6 per arm, a HAND-BUILT fixture (the real corpus has zero eligible rows, so there is
  nothing to sample), and the two arms are separated by design — lexical cohesion 0.1124 vs
  0.0051, which a self-check asserts. So this says the veto handles the CLEAR case, which is
  exactly the D#10 shape. **The ruler classifies THREE ways on purpose** — a refusal, a
  compression, and an *error* — because the shipped function returns `{compressed:false}` for
  a refusal and for a dead key alike, so a two-way ruler would have scored a broken API key
  as a perfect veto.
  **The ambiguous arm that was "the named next step" now exists and has been read** (D#13,
  2026-09-07): 6 partly-one-story clusters, cohesion asserted STRICTLY between the other two
  arms' (0.0051 < 0.0333 < 0.1124, mutation-verified by aliasing the fixture to UNRELATED —
  reads FAIL, exit 1), and **the veto is DECISIVE on them: 6/6 clusters gave the same verdict
  every time, 0 flipped, splitting 3 refuse / 3 compress, 0 errors.** Read that with its
  caliber, because the arm's FIRST version was withdrawn over exactly this:
  **`DEFAULT_LLM_TEMPERATURE` is pinned to 0** (`haiku-client.mjs:57`) and the shipped path
  takes that default, so asking an identical prompt three times is close to asking it once,
  and the 1.000 it produced was near-tautological — the header's own blind-instrument hazard,
  reintroduced one layer above the three-way classification that exists to stop it. The reps
  therefore **rotate member order**, a variation production actually exhibits (untiebroken
  pools, D#9 — since fixed in `hook-optimize.mjs`), so the arm answers *is the verdict
  invariant to presentation order* rather than *does a temperature-0 model repeat itself*.
  Premise carried, not assumed: `distinctOrders` per cluster, `minDistinctOrders` per arm, a
  self-check requiring it to equal reps, and a deliberately reachable `permute: false` mode
  asserted to read 1 so that check can be shown to fail. **This evidence argues AGAINST taking
  option (a), which is now a DECISION rather than a measurement gap** (D#16): on exactly the
  population the 14-day fallback produces, the veto refuses half and allows half, decisively
  and order-independently, so (a) would throw away three correct compressions to prevent a
  hiding the veto is already preventing. Stability is not correctness — that arm has no ground
  truth — so it says *repeatable and order-invariant*, never *right*.

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
