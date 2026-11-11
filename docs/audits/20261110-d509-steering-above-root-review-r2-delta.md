# Delta review: 32e8176c (parent e95f16c0)

HEAD = 32e8176c4cb6… (checked). Tree: `git archive 32e8176c` + copied node_modules, sandboxed HOME/CLAUDE_CONFIG_DIR/CLAUDE_MEM_DIR, keys and proxies unset.

**Verdict.** C1 is false: F1 is a state where Claude Code skips the block and the plugin relies on it anyway. The state predates this commit. C2 is false: 2 changed sites have no test that fails when only that site breaks (F4). C3 is false: F5. The delta has no P0 or P1. It only narrows what the plugin relies on, and that adds one state where the block loads twice (F2).

## Findings

**F1 [P2] Bare repository with worktrees nested inside it: the plugin relies on `<bare>/CLAUDE.md`, Claude Code skips it, and the session gets no steering.** adopt-cli.mjs:567 (the regex needs a common dir named `.git`), feeding :622/:624. This is in e95f16c0 too (same result there), so this commit did not introduce it.
- Repro: `git clone --bare src proj.git; git -C proj.git worktree add main`; a session in `proj.git/main` creates its local copy; `adopt` in `proj.git`; the next session prints `{"action":"already-adopted","reason":"above-root"}` and the worktree's CLAUDE.local.md is gone. `--status` says `— none: …/proj.git/CLAUDE.md carries the block`.
- Real 2.1.322 run from `proj.git/main`: InstructionsLoaded lists only `…/A/CLAUDE.md` (the control one level up). `proj.git/CLAUDE.md` is not listed.
- Source: findCanonicalGitRoot ends `if(Ze(u)!==".git"){if(et(j(u,".git"),u))return e;return pn(u)}`. So the canonical root is the bare dir, `XJt`'s `tu(worktreeRoot, mainRepoRoot)` is true, and `JJt` skips it.
- Fix direction: when the common dir is not named `.git` (and has no `.git` inside), use the common dir itself as `main`. The `proj/.bare` sibling layout stays unskipped, as in Claude Code.

**F2 [P3] New in this commit: a manually moved, unrepaired nested worktree now loads the block twice.** adopt-cli.mjs:622-624.
- Claude Code checks the backlink (`<gitdir>/gitdir` must equal `<worktree>/.git`). When it does not match, Claude Code skips nothing. The plugin's regex still finds `main`, and the skip range now covers the in-between directories.
- Repro: `git worktree add ../elsewhere/feature; mv` it to `main/wts/feature`; `adopt` in `main/wts`. Session: 32e8176c returns `{"action":"local","written":"created"}`; e95f16c0 returns `{"action":"already-adopted","reason":"above-root"}`.
- Real run 4 loaded `main/CLAUDE.md`, `main/wts/CLAUDE.md` and `feature/CLAUDE.local.md`.
- The error goes the safe way: the block loads twice, never zero times.

**F3 [P3] The `--status` stale-file hint still promises a refresh the session never makes.** adopt-cli.mjs:806-807. The text predates this commit; the commit narrowed it without fixing it. Probe output from the worktree status: `⚠ …/R/CLAUDE.local.md holds an out-of-date copy …; the next session started in …/R (with auto-adopt on there) brings it up to date`. What the next session in R actually does:
- S1, R/CLAUDE.md carries the block (arrived by pull/checkout): it removes the file (`already-adopted`; file exists afterwards: false).
- S2, the stale copy is tracked: `already-adopted`, `local-tracked`, file unchanged. The hint is printed again unchanged after every session.
- S3, an AGENTS.md beside it: the file is gone.

This commit adds no new status mismatch. The removal promise (:788-794) matches the session in every state I built, including a damaged line in a subdirectory's CLAUDE.md (S4).

**F4 [P3] Two changed sites survive per-site mutation (C2; the commit says 29/29).**
- M11 (:792), `claudeMdPath(cwd)` → `claudeMdPath(root)`: all 323 tests pass. In S4 (session in `R/src` whose CLAUDE.md has a damaged sentinel), the mutant prints `— none: …work/CLAUDE.md carries the block (the local copy in …R/CLAUDE.local.md is removed at the next session start)`. The session returns `damaged` and keeps the file.
- M14 (:805), the `` `adopt` there brings it up to date `` text → `''`: all tests pass. No test asserts the remedy for a stale CLAUDE.md.

**F5 [P3] Edited doc sentences that the code contradicts (C3).**
- commands/adopt.md:17: "no local copy is kept and nothing is added".
- README.md:170: "a copy the plugin wrote before is taken out". README.zh-CN.md:157: "插件之前写的副本会被移除".
- Both are false when the copy is tracked or behind a symlink. The commit's own test `a tracked local copy is left as it is` (tests/local-steering.test.mjs:3047) asserts the file is unchanged, and `--status` there prints "(tracked by git; the plugin leaves it as it is): sessions here load it twice".
- README:170: "where `CLAUDE.local.md` is tracked … nothing is written and, unless a current block above already loads (see above), the text is **injected**". In S2 (a tracked copy carrying the block, nothing above), the session returns `already-adopted`/`local-tracked` and injects nothing. This clause is old, but it sits in a sentence this commit edited.
- README/adopt.md "Where Claude Code already loads the current block from … above" is not the condition the code checks. F1 is a state where the code acts although Claude Code loads nothing from there; F2 is the reverse. The commit message says it "reworded to the condition the code checks".

**F6 [P3, not run; read from code only] `CLAUDE_CODE_DISABLE_CLAUDE_MDS`.** In the bundle, `async function V(e,r,s){if(i.CLAUDE_CODE_DISABLE_CLAUDE_MDS)return"";…}` builds the CLAUDE.md context. The plugin never reads this variable (0 grep hits). So outside git, below a current block, the session gets `already-adopted` and nothing is injected. This comes from D#760 and is not one of the four deferred shapes.

## Answers

1. **The walk matches 2.1.322 in these cases:**
   - `/` excluded: loop `yo!==osr(yo).root`, `osr`=`path.parse`; M02 reds both fs-root tests.
   - In-between directories of a nested worktree: real run 2 loaded `B/CLAUDE.md`, `main/CLAUDE.local.md`, `wts/CLAUDE.local.md` and `feature/CLAUDE.local.md`, and neither `main/CLAUDE.md` nor `wts/CLAUDE.md`.
   - Symlinked session directory: physical parents on both sides. Run 3 loaded `phys/parent/CLAUDE.md`, not `logical/CLAUDE.md`, and the hook got the physical `CLAUDE_PROJECT_DIR`.
   - Sibling worktrees and submodules: neither side skips (read from code).
   - Win32 and UNC roots: `path.win32` gives identical dirs for both loops.

   Divergences: F1 (relies on a file that does not load) and F2 (stops relying on a file that does load).
2. Status: the removal promise matches the session. The stale hint has the old mismatches in F3; nothing new.
3. Mutations and the fs mock: see the table below. The fs mock is sound for CLAUDE.local.md: every module imports `fs`, both files go through one parser, and the control proves the mocked read path is used. It never serves `/CLAUDE.md` (with its detail doc), which is the "adopt at /" scenario the commit names. A root check confined to the CLAUDE.md arm would pass.
4. Docs: see F5.

## Mutations

Harness: one `from` match asserted, file differs; restored from the original bytes after each run (Buffer.equals); at the end, `cmp` against `git show 32e8176c:adopt-cli.mjs` is identical. 17 mutants, 12 killed.

| Mutant | Line | Result |
|---|---|---|
| M02 walk includes `/` | 621 | killed (2) |
| M03 no skip; M04 skip only main; M05 main counted; M06 default 0 | 622/624 | killed (3/1/2/6) |
| M09 final `return` empty | 635 | killed (2) |
| M10 stray check dropped | 792 | killed (1) |
| M12, M13, M15, M16, M17 stale-hint branches | 802-808 | killed (1 each) |
| **M11 stray on root** | 792 | **survived** (F4) |
| **M14 adopt-hint dropped** | 805 | **survived** (F4) |
| M01 `[\\/]?` re-added; M08 no early return | 567/633 | survived, equivalent (`resolve` drops the trailing `/`; `??=` keeps the nearest) |
| M07 `samePath` → `===` | 622 | survived, near-equivalent (both sides are real paths from git) |

## Verification

- 3 named test files at 32e8176c → passed (323/323).
- Full suite at 32e8176c → failed, 3 of 9989 (9984 passed, 2 skipped). The 3 come from my environment, not this commit:
  - 2 run `git ls-files` and the archive tree is not a git checkout;
  - 1 resolve-data-dir case fails under my HOME/data-dir override.
- Real `claude -p` runs: 4 of 4 allowed. They were network-less (proxies unset), killed by `timeout` after InstructionsLoaded fired, with no model call. The credentials file mtime is unchanged.

## NOT CHECKED

- `/` at runtime (it cannot be written without root).
- Submodules and sibling worktrees in a real run.
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS` at runtime.
- Claude Code's case-folding `tu` on Linux (two directories differing only in case).
- macOS `/private` aliases.
- The four deferred shapes.
- eslint/prettier/coverage, and the full suite in a real git checkout.
- Whether `resume` runs the sync, which bears on the wording "removed at the next session start".
- `/run/user/1000/agent-tmp-d509-e2e` (the author's e2e sandbox from the spec) still exists; not mine, left untouched.
