# 00 — Baseline (2026-09-05)

Tree: **v3.96.0 @ `d0045b2`** (release tree, clean at session start) plus the three
baseline-round additions below, all uncommitted at measurement time. Every number in this
file was produced on this machine, on this date, by the command next to it. Re-measure
rather than carry (doctrine rule 1/2 in `CLAUDE.md`).

> `docs/` is gitignored in this repo except `docs/measurement/`, so this file and
> `docs/ARCHITECTURE.md` are **local** until that policy changes — see audit item P1-1 in
> `2026-09-05-audit.md`. The previous audit rounds (2026-07-17 … 2026-09-02) are known only
> from CHANGELOG and code comments because their reports lived here and are gone.

## 1. One-command entry points

| Purpose | Command | Status today |
|---|---|---|
| Tests | `npm test` (`vitest run`) | 351 files / 5831 passed / 1 skipped, 30 s |
| One file / one case | `npx vitest run tests/x.test.mjs` · `npx vitest run -t 'name'` | — |
| Coverage (gated) | `npm run test:coverage` | thresholds 80 / 74 / 84 / 83 (stmts / branches / fns / lines) in `vitest.config.mjs` |
| Lint | `npm run lint` (`eslint .`) | 0 errors / 0 warnings, 527 files |
| Format | `npm run format` · `npm run format:check` | **`format:check` fails: 521 of 527 files unformatted** (config added 2026-09-03, never applied, not gated) |
| Dead code | `npm run dead-code` (knip) | 51 unused exports / 0 unused files |
| Shell | `shellcheck scripts/post-tool-use.sh scripts/pre-agent-inject.sh scripts/pre-commit.sh scripts/setup.sh` | gated in CI |
| Metrics snapshot | `npm run audit:metrics` (reuses `coverage/`) · `npm run audit:baseline` (runs the suite first) | this file |
| Metrics ruler self-check | `npm run audit:selfcheck` **(new)** | `tests/audit-metrics-selfcheck.test.mjs` 5/5 |
| Module inventory | `npm run audit:inventory` **(new)** | → `docs/ARCHITECTURE.md §4` |
| Dependency graph | `npm run audit:deps` **(new)** | → `docs/ARCHITECTURE.md §3` |
| Pre-commit | `scripts/pre-commit.sh` | runs `eslint .` + full `vitest run`; does **not** run prettier |
| CI | `.github/workflows/ci.yml` | lint · shellcheck · `npm audit --omit=dev` · test matrix Node 20/22/24 · benchmark gate; knip informational; no format check |

## 2. Baseline-round changes (the only edits this round)

1. **`tests/install-metadata.test.mjs`** (new, 7 cases). `install-metadata.mjs` (2072
   lines, seeds the resource registry from three sites in `install.mjs`) was the one shipped
   module whose basename appeared nowhere under `tests/`. Contract pinned: `type:name` keys
   with type ∈ {skill, agent}; four required string fields, three of them non-empty
   (`domain_tags` may be `''` — four entries do that on purpose and every consumer reads
   `meta.domain_tags || ''`); optional fields typed; `recommendation_mode` ∈ {on_request,
   proactive}; `MARKETING_ON_REQUEST` ⊆ keys and every member flipped to `on_request` at
   load. **Mutation-verified**: blanking one `capability_summary` turns the suite red
   (1 failed / 6 passed), restored via `git checkout`.
2. **`scripts/audit-metrics.mjs --deps`** — dependency section for `ARCHITECTURE.md`
   (layer matrix, upward edges, hubs, mermaid). Same edge extractor as `cycles()`, so the
   two numbers cannot disagree.
3. **`package.json` scripts** — `audit:inventory`, `audit:deps`, `audit:selfcheck`.

Not done on purpose: `stop-words.mjs` (35-line data module, exercised through
`nlp.mjs`/`utils.mjs` tests) and `lib/mem-override.mjs` (tested through the
`scripts/prompt-search-utils.mjs` re-export, `tests/user-prompt-search.test.mjs:150`) got no
new file — the "not mentioned" signal is reachability, not absence of tests.

## 3. Metrics

Command: `npm run audit:baseline` (2026-09-05, after the changes in §2). Method notes for
each row are in the header of `scripts/audit-metrics.mjs`.

| Metric | Value | Same tree BEFORE §2 changes (run A) |
|---|---|---|
| Source files / lines (root + lib + cli + server + scripts; `.mjs .js .sh`) | **163 / 52,182** | 163 / 52,095 |
| Test files on disk / lines (`tests/**`, incl. helpers + sandbox) | 360 / 93,137 | 359 / 93,051 |
| Test files run / cases | **351 / 5,831 passed + 1 skipped** | 350 / 5,824 + 1 |
| Benchmark files / lines | 29 / 8,757 | same |
| Functions > 50 lines (acorn, all function kinds) | **138 of 2,034 (6.8%)** | 137 of 2,019 |
| Duplicate rate, 6-line normalised window — any / cross-file | **1.96% (576 / 29,381) / 0.37% (108 lines)** | 1.97% / 0.37% |
| Import cycles static / incl. lazy (159 modules, 473 static + 49 lazy edges) | **0 / 0** | 0 / 0 |
| Coverage stmts / branches / functions / lines (v8 text reporter, `vitest.config.mjs` scope) | **84.34 / 78.87 / 89.25 / 87.67** (unchanged — `install-metadata.mjs` is outside the gate's `include` list) | 84.34 / 78.87 / 89.25 / 87.67 |
| eslint errors / warnings | **0 / 0** (527 files) | 0 / 0 (526) |
| knip unused exports / unused files | **51 / 0** (name set: `tmp` scratch `knip.json`; Δ = `install-metadata.mjs:MARKETING_ON_REQUEST`, now imported by the new test) | 52 / 0 |
| prettier `--check` unformatted files | **521** | 520 |
| Source modules not directly imported by any test / basename never mentioned | **24 / 3** of 159 | 25 / 4 |

Three-way note on the test count: CLAUDE.md's baseline says 350 files / 5,825 for the
v3.96.0 tag; run A read 350 / 5,824 + 1 skipped (same number, the skip counted
separately); this round adds 1 file / 7 cases.

### Largest 10 source files

| File | Lines |
|---|---|
| `mem-cli.mjs` | 3,348 |
| `install.mjs` | 2,793 |
| `hook.mjs` | 2,624 |
| `install-metadata.mjs` | 2,072 (data) |
| `server.mjs` | 1,982 |
| `lib/citation-tracker.mjs` | 1,737 |
| `hook-llm.mjs` | 1,380 |
| `schema.mjs` | 1,347 |
| `hook-update.mjs` | 1,167 |
| `hook-optimize.mjs` | 1,160 |

### Longest 10 functions

| Function | Lines |
|---|---|
| `install.mjs:1601 doctor` | 547 |
| `schema.mjs:410 initSchema` | 475 |
| `hook.mjs:814 handleStop` | 470 |
| `scripts/user-prompt-search.js:630 main` | 392 |
| `hook-llm.mjs:757 handleLLMEpisode` | 387 |
| `hook.mjs:2119 handleUserPrompt` | 326 |
| `mem-cli.mjs:122 cmdSearch` | 299 |
| `install.mjs:959 installPreinstalledResources` | 270 |
| `lib/save-observation.mjs:160 saveObservation` | 254 |
| `hook.mjs:1841 handleSessionStart` | 253 |

### Source modules not directly imported by any test (24)

`cli.mjs`, `hook.mjs`, `scripts/*.js` hooks, `scripts/hook-launcher.mjs`, `scripts/launch.mjs`,
`cli/activity.mjs`, `cli/doctor.mjs`, `cli/fts-check.mjs`, `server/fts-check.mjs` — all
reached as subprocesses by the feature sweeps (`tests/feature-sweep-{cli,mcp,hooks}.test.mjs`)
or by `tests/cli.test.mjs`; `scripts/audit-metrics.mjs` (driven by its self-check test);
dev-only `scripts/{convert-commands,extract-repos,index-managed,mock-claude,p0-forward-probe,
sign-release,smoke-tarball,binding-probe-cli}.mjs`; `lib/mem-override.mjs` (via re-export);
`stop-words.mjs`; `eslint.config.mjs`.

### Supplementary scans (scratch scripts, acorn over the same source scope; not in the ruler)

| Scan | Result |
|---|---|
| `db.prepare(` lexically inside a loop body (no function boundary between) | 29 sites; hot ones `search-engine.mjs:510,530` (per vector hit, ≤ `VECTOR_SCAN_LIMIT` = 500), `scripts/user-prompt-search.js:421` (per file named in the prompt), `hook-llm.mjs:490,497` (≤5) |
| Functions with > 5 parameters | 6 (`hook-handoff.mjs:35`, `lib/edge-attribution.mjs:88`, `scripts/user-prompt-search.js:348`, `search-engine.mjs:295,313`, `server.mjs:249`) |
| `catch` blocks in shipped source | 724 total; **127 textually empty `{}`** (`install.mjs` 26, `hook.mjs` 20, `hook-episode.mjs` 9, `scripts/user-prompt-search.js` 8, `hook-semaphore.mjs` 7, `hook-llm.mjs` 7); 363 more are `{ /* comment */ }` |
| Cross-file duplicate groups (6-line window, merged) | 7; the two real twins: `lib/metrics.mjs:81-96 gcOldMetricShards` ≡ `registry-recommend.mjs:163-178 gcOldShadowShards` (12 lines) and `lib/file-intel.mjs:23` ≡ `utils.mjs:72 estimateTokens` (14 lines, **intentional mirror, guarded by a mirror test**) |
| Modules without a header comment | 0 of 157 |
| `npm outdated` | `better-sqlite3` 12.11.1 → 13.0.3 (major), `vitest` + `@vitest/coverage-v8` 4.1.11 → 5.0.0 (major), `eslint` 10.9.1 → 10.10.0 |
| Local Node vs CI matrix | v26.8.1 locally; CI runs 20 / 22 / 24; `engines.node >= 20` |

## 4. Run log for this baseline

- Run A `audit-metrics --run-tests` (before §2 changes): 350 / 5,824 green, coverage 84.34 / 78.87 / 89.25 / 87.67.
- New test: 7/7 green; mutation → 1 failed / 6 passed; restored clean.
- Run B `npm run audit:baseline` (after §2 changes): **reported `Tests 1 failed | 5830 passed`, exit 1**,
  and therefore no coverage summary. The ruler discards vitest's output, so the failing
  test's name was lost (filed as P2-8 in the audit).
- Run C `npx vitest run` immediately after: 351 / 5,831 + 1 skipped, exit 0.
- Run D `npx vitest run --coverage --coverage.reporter=json-summary --coverage.reporter=text`: 351 / 5,831 + 1 skipped, exit 0, coverage 84.34 / 78.87 / 89.25 / 87.67 — the coverage row above comes from this run (`npm run audit:metrics` then reads the same `coverage/coverage-summary.json`).
- Verdict on run B's single failure: **not reproduced in two consecutive full runs (C, D)**; name unknown because the ruler drops vitest output. Recorded as Uncertain, not as a regression.
