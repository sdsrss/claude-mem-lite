# Contributing to claude-mem-lite

Thanks for taking the time. This file exists because the project got its first outside
contribution (PR #17) and discovered two things nobody had written down: how CI behaves
for forks, and what "verified" means here.

## Before anything: your CI run needs a maintainer click

If this is your first contribution, your pull request's CI run will sit at zero jobs
until a maintainer approves it. That is a GitHub setting on public repositories
("Fork pull request workflows from outside collaborators"), not a broken workflow.

Measured on PR #17: the run was created at `2026-09-01T01:29:25Z`, never started a
single job, and was marked `failure` **twelve hours later**. Every one of the ten
same-repo pull-request runs in the project's history, by contrast, actually started its
jobs and finished inside three minutes — the five that passed took 2m21s–2m34s and the
five that failed took 12s–1m51s. The distinguishing
symptom is therefore **zero jobs and a multi-hour wall-clock**, not the conclusion. So:

- **A stalled run with zero jobs is the approval gate, not your branch.** Ping the
  maintainer rather than force-pushing to "retrigger" it.
- Nothing is wrong with your PR while it waits.

The gate stays on deliberately: CI runs `npm ci` and executes the tree, so approving a
fork run executes that fork's code. Please run the checks locally and paste the output
in the PR — it is what unblocks review fastest.

## Local setup

```bash
node --version      # must be >= 20; the package is ESM ("type": "module")
npm install
```

## The checks

```bash
env -u CLAUDE_MEM_DIR npm test    # vitest run — the whole suite
npm run lint                      # eslint .
npm run dead-code                 # knip — see the caveat below
```

**That `env -u` is not decoration.** The suite provisions its own sandbox, and one case
(`tests/resolve-data-dir.test.mjs > follows a subprocess that inherited the ambient env`)
asserts what a subprocess does with an *unset* `CLAUDE_MEM_DIR`. If you have
claude-mem-lite installed and that variable exported, a plain `npm test` reports
`1 failed | 10 passed` on that file and it is not your change. Measured, not assumed.

Three things about those numbers that will otherwise cost you an afternoon:

- **The test count is partly generated.** `tests/obs-id-caliber-sync.test.mjs` emits one
  case per `.mjs`/`.js` file under `benchmark/`, `lib/`, `scripts/` and the repo root, so
  adding a source file moves the headline number — and so does an untracked scratch file
  at the repo root. Never compare a case count across trees; compare pass/fail.
- **`knip` is blind to some files.** A module named in a
  `new URL('../X.mjs', import.meta.url)` anywhere in the analysed tree drops out of its
  unused-export report entirely. `hook-context.mjs` and `hook-memory.mjs` are in that
  state today, because the pool-replay benchmarks and their tests patch them by text. A
  clean knip run is not evidence that a dead export in one of those was noticed.
- **`knip` reads differently per checkout context.** The same commit measures roughly 15
  fewer unused exports from a detached `git worktree` than from the primary working tree.
  Cause never established, tracked as D#161. Measure from the primary working tree, and
  attribute a change by diffing the NAME SET (park your new files, restore the modified
  ones from `git show HEAD:<f>`, re-measure, diff names) — never by subtracting two
  counts. There is a standing baseline of 46 unused exports, most of them intentional
  backward-compat re-exports in `utils.mjs`; adding to it is a review signal.

## What review will ask for

This project runs on measurement, and the bar is specific rather than ceremonial.

1. **A failing state before the fix.** For a bugfix, cite what was broken — the error
   text or the name of the test that went red — in the same breath as the fix. "Should
   work" is not evidence.
2. **A test that dies when the fix is reverted.** Write the test, then break the
   implementation on purpose and watch the test fail. A surprising share of plausible
   assertions pass against the reverted code; that is the single most common reason a
   change gets sent back here.
3. **Which population a number describes.** Ratios over this project's database must
   divide live rows by live rows — `lib/inject-search-core.mjs`'s `liveObsFilterSql`
   excludes compressed and superseded rows, and forgetting it has shipped a wrong figure
   more than once. If you quote a percentage, say what the denominator was.
4. **Both arms of a symmetric change.** If you fix one branch, one hook, one surface —
   check whether it has a sibling. Most defects here have turned out to live on more
   than one surface at once.

## Benchmarks are rulers, not decoration

`benchmark/` holds replays that drive the **shipped** modules against the real local
database or real transcripts. They are how a retrieval or injection change gets priced
before it ships, because none of them can see the others' surfaces:

| Ruler | The face it can price |
|---|---|
| `benchmark/denoise-ab.mjs` | query → document FTS search (precision/recall levers) |
| `benchmark/rerank-pool-replay.mjs` | the `fyi` prompt-injection candidate pool |
| `benchmark/imperative-pool-replay.mjs` | `task_imperative` / `subagent` identifier overlap |
| `benchmark/keyctx-pool-replay.mjs` | the SessionStart Key Context selection |
| `benchmark/error-recall-live-replay.mjs` | failed-command recall (real stderr) |
| `benchmark/citation-live-replay.mjs` | per-face citation rate from real transcripts |
| `benchmark/episode-flush-replay.mjs` | the episode batching / flush path |

A `NEUTRAL` verdict from the wrong ruler is not evidence of safety — `denoise-ab` is
structurally blind to every face below the first row, and will report Δ=0 for a change
that moves them a lot. Pick the ruler that imports the module you touched.

Two rules that apply to all of them:

- **Never diff two runs taken at different times.** The corpora grow every session, so a
  before/after subtraction across days measures growth. Run both arms back to back, or
  use a single walk with a split (`citation-live-replay --split`), or freeze the inputs
  (`error-recall-live-replay --shapes <file>` passed to *both* arms).
- **A/B by flipping the documented environment switch, not by editing the code.**

If you add a ruler, add its binding test under `tests/`. A self-check that no test
imports can be deleted with a green suite — that has happened here (D#190).

## House rules

- **Tests must not couple to this machine.** A budget assertion that measures a string
  containing an absolute install path is partly measuring how deep your home directory
  is; that is exactly what made PR #17's contributor see a failure the maintainer could
  not reproduce (D#185). Normalise machine-specific values out before asserting.
- **Comments carry the reasoning, not a summary of the code.** When a comment states a
  mechanism ("X happens because Y"), check Y is still true — a stale explanation next to
  correct code is worse than no comment.
- **Don't commit** `tasks/` (local working notes), `benchmark/results/` (frozen corpora
  containing real command output and session ids), or `.tmp-*` twin files.
- **Releases are maintainer-only.** A version bump must touch five files together
  (`package.json`, `package-lock.json`, `plugin.json`, `marketplace.json`, and the
  Version line in `CLAUDE.md`), and pushing a `v*` tag publishes to npm automatically.
  Please leave the version alone in a pull request.

## Reporting a bug

Include the install shape — plugin-only, `~/.claude-mem-lite` managed install, npm
global, or a combination. Several defects have existed on exactly one of those and been
invisible on the others, and the process environment differs between a hook, an MCP
server, and your terminal in ways that have hidden bugs before (D#187).
