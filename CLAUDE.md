# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Lightweight persistent memory system for Claude Code. MCP server + hooks plugin.

- **Version**: 5.1.1 — **this exact string is a release guard.**
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
`phaseC-update.mjs`, one at a time — see `tests/sandbox/README.md`. **Run it after any
dependency major**: from v4.0.0 to v5.1.0 both self-heal sections corrupted
`build/Release/better_sqlite3.node`, a better-sqlite3 **12** path, so they measured nothing —
phase B's eight self-heal checks sat behind an `if (existsSync(…))` and silently stopped
running. Each phase now asserts its own check count (`EXPECTED_CHECKS`, 47 / 45 / 15), and
`tests/sandbox/lib.mjs::loadedBindingPath` asks better-sqlite3 which addon it would load
instead of naming one. **`SBX_BASE` is not
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

> **R10 (`docs/audits/20260906-173816.md`) landed as `efdf505..f1dde1a`, 16 commits.**
> Eight of its nine P1s and most P2/P3s are fixed, each with a RED-first test and, where a
> guard could be walked past, a mutation run against the real revert. Four items are
> deliberately open and the report below says why: P1-1 (session lifecycle — needs a real
> `/clear` stdin capture first, and the two possible host semantics need opposite fixes),
> P2-11 / P2-12 (install-path rewrites — mechanism proven, runtime symptom not, and R10 §8
> says do not touch `install()` without reproducing in `tests/sandbox/phaseB-npm.mjs`),
> P3-11 (FTS double-count — the fix collides with `looksAlreadyDerived`, which closes a
> data-loss bug) and P3-24's second half (deleting `scripts/convert-commands.mjs` would
> strand `lib/frontmatter.mjs` and make its guard vacuous).
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
| LongMemEval | `node benchmark/longmemeval.mjs <dataset>` | Standard recall, lexical baseline — `benchmark/datasets/README.md` |

## Baselines

Re-measure rather than carry — **the test-case count is partly generated**
(`tests/obs-id-caliber-sync.test.mjs` emits one case per `.mjs`/`.js` under `benchmark/`,
`lib/`, `scripts/` and the repo root, so adding a source file — or leaving an untracked
scratch file at the repo root — moves the headline number).

| Baseline | Value | Tree / date |
|----------|-------|-------------|
| Tests | **356 files / 5693** (5693 passed, **0 skipped**) | `main` @ `c9c1acb`, 2026-09-06, after the prebuild-shadowing fix (`d846279..c9c1acb`). **+6 cases, 0 new files** — the six are appended to two existing files, and the generated term did not move because no source file was added. Was **356 / 5687** at `cc4fc5e`, after the R10 audit-fix series (`efdf505..cc4fc5e`, 15 commits). Was **343 / 5578** (5577 + 1 skipped) at `efdf505`. **The 1 skipped became 0 for a reason worth knowing**: `tests/pre-commit-hook-sync.test.mjs` skips when no git hook is installed, and this clone had none — `git config core.hooksPath .githooks` (R10 P2-20, now also `npm run hooks:install`) un-skipped it. A skip that permanent is a check that is off. **Watch the generated term**: `obs-id-caliber-sync` emits one case per `.mjs`/`.js` under `benchmark/`, `lib/`, `scripts/` and the repo root, so deleting `scripts/p0-forward-probe.mjs` (R10 P3-24) took one case with it — which is why the R10 batch that removed it netted +0 cases despite adding one. Pre-R10 history: the skill-registry removal took 359/5936 → 343/5578 in three attributed steps; v4.0.4 added 2 over v4.0.3's 359 / 5934; the `v4.0.0` figure was 357 / 5911 and was **byte-identical under vitest 4 and vitest 5 on the same tree**. |
| Knip | **45** unused exports, **0** unused files, **0** duplicate exports, **3** unlisted binaries (`du`, `pgrep`, `claude-mem-lite`, all from `install.mjs`) | `main` @ `c9c1acb`, primary working tree — unchanged across the prebuild-shadowing fix, and **no entry names any file that change touched** (the new sandbox helpers are all imported by the phases; the new `lib/binding-probe.mjs` helper is module-local on purpose). Same figure at `cc4fc5e`. Was **48** at `efdf505`. **Attributed by NAME SET, not by subtracting counts** (doctrine rule 4): exactly three names left the list — `lib/scrub-record.mjs:TEXT_FIELDS_BY_TABLE`, `hook-optimize.mjs:executeSmartCompress` and `schema.mjs:isDbCorruptionError` — each because an R10 test now imports it. **Zero new unused exports across 15 commits.** The 3 unlisted binaries were present at `efdf505` too and are not new; the earlier rows simply never recorded that line. **The worktree-offset rule got a second data point**: this `efdf505` reading was taken in a `git worktree --detach` whose `node_modules` was SYMLINKED to the primary tree's, and it read 48 — matching the primary-tree figure, as the R9 reviewer also found (n=2 now). The discriminating arm — a detached worktree with its OWN `npm ci` — is still unrun, so keep measuring from the primary tree, but the rule is more likely about `node_modules` than about the checkout. |
| Coverage | statements **85.72%** · branches **80.16%** · functions **90.44%** · lines **86.88%** | `main` @ `c9c1acb`, **vitest 5.0.0**, 2026-09-06, gate exit 0. Same caliber as the row it replaces (no `include` change), so this one IS comparable: 85.68 → 85.72, 80.09 → 80.16, 90.42 → 90.44, 86.82 → 86.88 — the prebuild-quarantine tests cover the lines they added. Previous row, `cc4fc5e`: **85.68 / 80.09 / 90.42 / 86.82**. Same caliber as the previous row (the `include` allowlist did not change in R10), so this one IS comparable: 85.87 → 85.68 stmts, 80.15 → 80.09 branches, 90.28 → 90.42 functions, 87.05 → 86.82 lines. The movement is denominator, not regression — R10 added code to `lib/` (`proc-lock` steal protocol, `atomic-write` mode preservation, `deferred-work` scrub, `get-core` notices) faster than it added `lib/` tests, since several R10 guards drive root-level faces that are outside the gate. Gate (80 / 74 / 84 / 83) passes, `test:coverage` exit 0. **RE-MEASURE, NEVER CARRY — this row has been wrong three times**, twice by carrying and once by mis-attributing which files left the `include` list. **UNATTRIBUTED, open since v3.99.0, do not guess a fourth time**: `lib/git-state.mjs` (100 / 90.9 / 100 / 100) is absent from `e694259`'s report and present afterwards. Caliber note: the v8 text reporter truncates names past ~19 chars (`...n-tracker.mjs`), so a full-name grep returns nothing and reads as "not measured". |

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
  them and is verified binding. **That diff does not compare `timeout`**, which is how
  SessionStart ran with 15 s under the plugin shape and 10 s under the settings.json shape
  for several releases (R10 P2-16, now both 15). If you add a field to either set, ask
  whether the guard actually reads it.
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
- **A long LLM round-trip needs `liveObsFilterSql` in the UPDATE's WHERE, not just in the
  SELECT that chose the row.** 45 seconds is long enough for a concurrent hook to supersede
  or compress it, and an unguarded write resurrects a dead row AND stamps it processed
  (R10 P3-3). Treat `changes === 0` as a skip, not a success.

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
