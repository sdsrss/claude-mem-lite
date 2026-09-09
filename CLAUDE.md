# CLAUDE.md

Lightweight persistent memory for Claude Code. MCP server + hooks plugin.

- **Version**: 6.5.0 — **this exact string is a release guard.**
  `tests/install-e2e.test.mjs` asserts CLAUDE.md contains `**Version**: <v>` matching
  `package.json`, `plugin.json` and `marketplace.json`. Do not reformat this line.
- **Runtime**: Node >=22 (20 dropped in v4.0.0), ESM · npm · better-sqlite3 + FTS5

**Capped at 20 KB: RULES ONLY.** Each rule was expensive to establish and several shipped as
a WRONG draft first, so **these one-liners are TRIGGERS, not the argument.** The evidence is
**verbatim** in the tracked appendix a fresh clone gets — `docs/measurement/findings.md`
(invariants, doctrine, calibers), `baselines.md`, `rulers.md`, `docs/audit*/`. **Read it
before retrieval, measurement, release, migration or schema work.**

## Commands

| Task | Command |
|------|---------|
| Setup · tests | `npm install` (Node >=22 toolchain) · `npx vitest run` · one file `npx vitest run tests/foo.test.mjs` · one case `-t 'case name'` |
| Coverage | `npm run test:coverage` (gate: statements 81 / branches 75 / functions 87 / lines 83) |
| Lint · shell | `npx eslint .` · `shellcheck scripts/*.sh` |
| Format | `npm run format` — **run it twice**, `tests/hook-update.test.mjs` needs a second pass to reach a fixed point. `format:check` is gated in CI and pre-commit |
| Dead code | `npm run dead-code` (knip — measure from the **primary working tree**; the NAME SET is the evidence, not the count) |
| **Plugin manifests** | `npm run validate:manifests` — **`claude plugin validate . --strict` is NOT equivalent**: `.` resolves to the marketplace manifest alone, and `.claude-plugin/plugin.json` is the one that exits 1 |
| Bench · multipliers | `npm run benchmark:gate` · `benchmark:multipliers:gate` — **run the second after touching any constant in `scoring-sql.mjs` or `MULT_EXPR`; the first is structurally blind to those** |
| **Recapture the gate baseline** | `node benchmark/benchmark.mjs --production-hybrid > benchmark/baseline.json` — **expires 30 days after its own `timestamp`**, and CI + publish pass `--strict`. Sampled **2026-09-07T08:00:55Z** → red from **2026-10-07 08:00 UTC**. The stamp lives in THREE places (`baseline.json`, `ci.yml`, this row); `tests/baseline-stamp-sync.test.mjs` fails if they disagree. **Recapture BEFORE tagging, in its own commit** — otherwise it goes red after the tag is pushed |
| Audit metrics | `npm run audit:metrics` · `audit:baseline` · `audit:selfcheck` |

Two CLI families, both canonical in `cli.mjs` (`claude-mem-lite help` for flags):
**`CLI_COMMANDS`** = `search recent recall get timeline browse context save update delete
defer compress maintain optimize fts-check restore export import-jsonl stats citation-stats
activity memdir-audit adopt unadopt help`; **`INSTALL_COMMANDS`** = `install uninstall status
doctor cleanup cleanup-hooks self-update repair rebuild-binding release`.

**`rebuild-binding` heals a missing native binding; `npm rebuild better-sqlite3` does not** —
it exits 0 printing "rebuilt dependencies successfully" while compiling nothing. **Never hand
a human `NATIVE_BINDING_REBUILD_CMD` alone**: hints go through `nativeBindingRepairHint()`,
which sequences with `&&`, never `||`. `doctor --metrics` is the only reader for the `inject`
series. Sandbox harness `tests/sandbox/` (`SBX_BASE` mandatory) after any dependency major.
→ `findings.md § Commands`.

## Architecture

Seven hook events in `hooks/hooks.json`: `SessionStart`, `PreCompact`, `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `Stop`, `UserPromptSubmit`. **`PreToolUse` has TWO
matchers, not three**; `install.mjs`'s settings.json twin must stay equal to it.

`code-graph-mcp overview .` maps the tree; the modules whose ROLE the filename does not give
away are: **`tfidf.mjs` — the name is historical**, it is tokenizing + Porter stemming only
since the vector engine was removed; `lib/tool-refusal.mjs` gates PostToolUseFailure,
separating a program failing from the agent's own chain refusing; `hook-optimize.mjs` is
re-enrich + normalize + cluster-merge + smart-compress; `server.mjs` exposes 18 tools, 9 in
`tools/list` and 9 hidden-but-callable by exact name; `schema.mjs` is schema + migrations
(v49 drops the vector tables); `scripts/post-tool-use.sh` is a ~5ms bash pre-filter; and
`hook.mjs` is the single entry for session-start / stop / post-tool-use / failure /
user-prompt.

Retrieval path: `sanitizeFtsQuery` → BM25 → OR fallback → concept co-occurrence. SessionStart
emits `<claude-mem-context>` on stdout fresh from the DB.

**Where new code goes — the trigger is a SHARED code path, never line count.** Logic two
faces share (CLI + MCP, or two hook events) goes to `lib/*-core.mjs`. **Register every new
`lib/` module in BOTH `source-files.mjs` and `package.json#files`** — a missed registration
has shipped a broken tarball three times.

## Measurement doctrine

Most expensive mistakes here have been *measurement* mistakes; **violating one silently
produces a number that looks measured and is not.** → `findings.md § Measurement`.

1. **Stamp every number** with its date AND tree/corpus; an unstamped figure cannot be superseded.
2. **Never diff two runs taken at different times** — every corpus grows every session, including the one writing the note. Run both arms back-to-back.
3. **State the population.** "Which rows" is a required field, not a caveat.
4. **A count is a smoke alarm; the NAME SET is the evidence.** Never attribute a delta by subtracting two counts.
5. **A ruler must be able to say NO** — mutation-verify. A check nothing can break is not a check.
6. **A ruler must not pollute what it measures** — `{ counterfactual: true }`; a readonly handle shuts only one of two sinks.
7. **Measure the RELEASE tree, and measure it last.**
8. **Absolutes from a recency-weighted selector are snapshots, not properties.**
9. **A NEUTRAL from a structurally blind ruler says nothing, and a reading from the WRONG ruler says less** — two different failures. Check which arms a ruler actually executes before quoting it: `hybrid` names the eight multipliers in one place and FTS+vector in another, and that collision retired a subsystem on a number that never ran it.
10. **Correct the premise before quoting it.**

## Rulers

**Read a ruler's entry in `rulers.md` before quoting or re-measuring it** — each records its
caliber, population, self-checks and wrong drafts.

`denoise-ab.mjs` any precision/recall lever, BEFORE shipping · `error-recall-live-replay.mjs`
+ `error-recall-suite.mjs` command-vocabulary admits, and the bm25 floor denoise-ab is blind
to · `citation-live-replay.mjs` per-face cite-rate from transcripts (prefer over
`citation-stats`) · `episode-flush-replay.mjs` flush decisions through the shipped batcher ·
`{rerank,keyctx,imperative}-pool-replay.mjs` candidate-pool bounds, Key Context's unit being
a PROJECT · `patha-exclude-report.mjs` D#216, deciding column `refilled` ·
`deep-search-holdout.mjs` deep search's PRECISION arm (mean FP@10 = 10.00, 12/12) ·
`compress-veto-rate.mjs` whether D#10's veto FIRES, three arms · `multiplier-discrimination.mjs`
whether each of the 8 multipliers is WIRED at its magnitude · `longmemeval.mjs` standard
recall, lexical baseline.

## Baselines

**Current reading only** — re-measure rather than carry. The test count is partly generated:
`tests/obs-id-caliber-sync.test.mjs` emits one case per `.mjs`/`.js` under `benchmark/`,
`lib/`, `scripts/` and the repo root, so adding a source file — or leaving an untracked
scratch file there — moves the headline.

| Baseline | Value | Tree / date |
|----------|-------|-------------|
| Tests | **382 files / 6097**, 0 skipped | `main` @ 2026-09-09, v6.6.0 release tree |
| Knip | **43** unused exports, **0** unused files, **3** unlisted binaries | same tree, primary working tree |
| Coverage | **85.36** stmts · **79.61** branches · **91.05** funcs · **86.51** lines | same tree, vitest 5.0.0 |

Coverage `include` is a **denylist** — staying out costs a named `exclude`. Outside by
design: `install.mjs`, `server.mjs`, `hook.mjs`, `cli.mjs`, `benchmark/**`, `scripts/**`
(subprocess E2E, invisible to v8 coverage of the parent). Quote the v8 **text reporter**,
never `coverage/clover.xml`. **Three caliber breaks — do NOT diff across them**: the
2026-09-05 reformat (`36f8c0f`), vitest 5.0.0 (coverage), and the 2026-09-07 `include`
inversion (83 → 130 files). → `baselines.md`, `findings.md § Baselines`.

## Invariants that bite

**Full text, measured evidence and the wrong drafts: `findings.md § Invariants`.**

### Hooks and session lifecycle

- **`PostToolUse` does NOT fire for a host-flagged failure** — those go to `PostToolUseFailure` (text in `error`, no `tool_response`; `additionalContext` is the channel). **Do not widen `HARD_ERROR_RE`** — every anchor measured zero gain. Gated on `lib/tool-refusal.mjs`: most such failures are the agent's own guardrails refusing.
- **`Stop` fires once per assistant TURN, and `/clear` ROTATES the host session id.** The session file survives Stop, so **its presence no longer tells you why a session started** — ask stdin's `source` (`startup|clear|compact|resume`).
- **Every Stop-side writer needs a per-session idempotency key**, since Stop rescans the whole transcript; `access_count` written before v5.6.0 is an upper bound, not a count.
- **`hooks/hooks.json` and `install.mjs`'s `settings.json` entries are two hook sets and must change together** (`tests/audit-silent-20260814.test.mjs` diffs them) — **but the diff ignores `timeout`**. Adding a field? Ask whether the guard reads it.
- **The SessionStart "### Recent" table is a SELECTION, sorted for DISPLAY only** — both sites copy before sorting, so injected rows and the token budget are untouched.
- **`spawnBackground` children have no stderr** (`stdio: 'ignore'`), so "warn the user" there is dead on arrival — route it to `doctor`. An in-process spy on a logger is not evidence the log is delivered.

### Retrieval and ranking

- **Search's reported `total` is NOT the number of rows you can page to** — `reachable` is `preFinalizeCount`, never a re-derived `max(limit*3,60)`. The disclosure goes **SILENT** under a post-filter rather than guess; do not "improve" it with `total - postFilterDropped`.
- **A SQL `LIMIT` upstream of a JS-side relevance filter is a REACHABILITY bound, not a ranking bound** — an importance demotion becomes an *eviction*. Found on five faces. Count such populations with the pool's own `liveObsFilterSql`, not a bare `WHERE importance = 3`.
- **`ORDER BY created_at_epoch DESC` without an id tiebreaker INVERTS on a tie** — SQLite returns ascending rowid, i.e. oldest first, and two inserts share a millisecond **90.67%** — one population's rate, not a property (UPS/pretool: **0.00%**). 24 sites fixed; the rest **unjudged, not cleared**. Spelling: `importance DESC, created_at_epoch DESC, id DESC`.
- **Deep search floods on questions the corpus cannot answer** — holdout reads **FP@10 = 10.00, 12/12**. The flood is the **AND→OR fallback**, which is also the vocab-mismatch recall win, so three gates were tested against both arms and **rejected**.
- **That same OR fallback DISARMS auto-escalation**, so both deep rulers describe EXPLICIT deep only and an escalation A/B reading Δ=0 is a blind instrument (rule 9).
- **`benchmark:gate` CANNOT say NO about the eight scoring multipliers** — saturated corpus, ablations gated by nothing. Use `multiplier-discrimination.mjs`; all eight are wired at their declared magnitude, but whether they *help a real user* is not answerable on this corpus.

### Writes, liveness and concurrency

- **`COALESCE(compressed_into,0)=0` alone is NOT the liveness predicate** — `liveObsFilterSql` also needs `superseded_at IS NULL`. **Which sites need the full one is settled; do not re-derive it** — the per-site reasons differ and are not interchangeable.
- **A long LLM round-trip needs `liveObsFilterSql` in the UPDATE's WHERE, not just the SELECT** — a concurrent hook can supersede the row mid-call. Treat `changes === 0` as a skip; when one write of a pair is guarded, check the other.
- **Every re-enrich pool's predicate is another pass's OUTPUT column, so filling a column EVICTS the row from whatever pool keyed on its emptiness.** Found three times, the third created by the second's fix. Before adding a writer, ask which pool's WHERE clause that column is. `optimized_at` is the re-enrich pools' flag and nothing else's.
- **A `project` column is not a substitute for a project CHECK on a write** — pass `{ mode: 'write' }`; cross-project ops must compare both rows' projects first.
- **`writeFileSync(path, data, { flag: 'wx' })` is TWO syscalls**, so the file is briefly visible EMPTY — fill a private temp and `linkSync` it into place.
- **The injected-ids marker is a union across TABLES**, so ids need namespacing (`injectedIdKey`): most observation ids are also event ids.
- **`importance` is rewritten by five writers** — do not treat it as stable.

### Unattended LLM paths

- **The daily unattended `normalize` fans out to one scoped pass per project** — a union pass let ONE observation's content rewrite every project. **A corpus-derived whitelist cannot fix that**: if the attacker can write to the corpus they can write to the whitelist, which is what the first fix did. Layer 1 is `isConceptShaped`, a Unicode **property**, never a hand-drawn class (three hand-drawn versions each rejected real orthography); the guard is `lib/memory-input-guard.mjs`, kept separate from `deep-search.mjs`'s `INJECTION_GUARD`. The 8-project cap **ROTATES** via a cursor the escape hatch must not reset.
- **An `if (x)` guard whose else-branch is a LOOSER RULE is a second policy nobody reviewed, and deleting the `if` promotes it** — `clusterForCompression` grouped on a 14-day window with no similarity check. Smart-compress fails **CLOSED** on a missing `should_compress`; the measured veto argues **against** disabling the branch outright.
- **Repetition must vary something** — `DEFAULT_LLM_TEMPERATURE` is 0, so re-asking an identical prompt measures nothing. Rotate member order.

### Install, platform and recovery

- **`package.json`'s `os` is an npm INSTALL gate sitting on every MCP launch after an update** (the plugin cache ships without `node_modules`), so `["darwin","linux"]` did not warn Windows users — it killed the stdio server. **A gate is not a message.** `doctor` keys on whether **bash runs** and returns **three** outcomes: "I could not look" gets its own warning, because a green "nothing to check" ends the search.
- **A recovery path must not import the thing it recovers** — one import edge, for two path constants, put the signature-verified repair out of reach on the broken install it exists to repair. They live in `lib/data-paths.mjs` (a leaf): importing a constant drags in its module's whole load graph.
- **A prebuilt addon that is PRESENT and will not load cannot be healed by compiling one** — better-sqlite3 picks `prebuilds/` on existence alone. Quarantine the dead prebuild **only inside the source-build branch**, and **never name the addon's path — ask `getPrebuildPath()`**.
- **A DB written by a NEWER claude-mem-lite locks every older code home out, permanently.** `lib/schema-skew.mjs` computes the remedy from the ROOT that is behind, not the machine's global shape — **grep its importers rather than enumerating surfaces here.** The dedup marker must be per PROJECT; nothing called from `openDb`'s catch may throw (`getSessionId()` MINTS and writes).
- **A database file SQLite will not open is that shape with a DESTRUCTIVE remedy.** `SQLITE_CORRUPT_VTAB` (a damaged FTS index) carries the **same message text** as a damaged file — classify on `err.code` via `isFtsCorruptionError`, or you offer to overwrite a database whose rows are intact. The two channels carry **different strings**: the human gets the shell command, the model none. Register new per-project markers in `GC_PROJECT_MARKER_PREFIXES`.
- **`claude mcp remove -s project` edits the repository you are standing in** — it once emptied this repo's tracked `.mcp.json`. Install warns instead, on both branches.

### Testing this repo

- **Tests use a `:memory:` DB**; schema changes must sync to test files.
- **A test that reads repo source as TEXT must use `dirname(fileURLToPath(...))` + `join()`, never `new URL('../x.mjs', import.meta.url)`** — the URL form drops that module out of knip's report entirely. Guarded by `tests/no-url-module-paths.test.mjs`.
- **`MEM_NO_AUTO_ADOPT=1` is a GLOBAL opt-out every auto-adopt caller must honour** — any test spawning `install` or `repair` must set it, or the suite rewrites this repo's own CLAUDE.md and sidecar.
- **`effectiveQuiet()` drops both Key Context sections under this repo's own cwd** (it is adopted), so a test asserting on them passes vacuously — point `CLAUDE_PROJECT_DIR` at an unadopted temp dir and assert a premise first.
- **An MCP tool's advertised JSON Schema is not its enforced schema, and `.pipe()` is where they part** — zod 4 renders the ZodPipe's INPUT side. Put the constraint INSIDE the `z.preprocess`.
- **Tool name mapping**: Claude Code's Agent tool is `'Agent'`, not `'Task'`; Skill via `event.tool_input?.skill`. Skill commands (`/search`, `/recall`, `/recent`, `/timeline`) use `!` preprocessing for CLI injection.
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

Not on PATH? A plugin-only install keeps its own copy — same commands, run
`~/.cache/code-graph/bin/code-graph-mcp` (or `npm i -g @sdsrs/code-graph` once).

Still use Grep for literal strings/regex in non-code files; still Read files you'll edit.
Full command + MCP-tool table: `.claude/plugin_code_graph_mcp.md`
<!-- code-graph-mcp:end -->
