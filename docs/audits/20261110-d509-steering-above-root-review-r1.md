# Pre-ship review: e95f16c0 (D#509(4)) — `git diff ae83c0a9 e95f16c0`

Reviewer: subagent, 2026-11-10. Nothing in /home/ai/dev/claude-mem-lite was edited (git status clean before and after).
Probe scripts: /tmp/claude-1000/-home-ai-dev-claude-mem-lite/f59b4686-886c-46fd-9a0e-ddd444b78abf/scratchpad/probes/*.mjs
(they import a tree given by TREE / TREE_NEW / TREE_OLD; recreate the trees with
`git archive e95f16c0 | tar -x -C <dir>` and `git archive ae83c0a9 | tar -x -C <dir>` plus a node_modules link;
env used: `env -u CLAUDE_CONFIG_DIR -u MEM_NO_AUTO_ADOPT -u CLAUDE_MEM_RULES_STEERING -u CLAUDE_PROJECT_DIR HOME=<scratch>/home CLAUDE_MEM_DIR=<scratch>/data PBASE=<scratch>`).
Real Claude Code calls: 2 of the allowed 6 (2.1.322, isolated CLAUDE_CONFIG_DIR, InstructionsLoaded log).

## Checks run

- `npx vitest run tests/local-steering.test.mjs` at e95f16c0 → passed, 253/253.
- Same 12 adopt/steering test files (local-steering, adopt-cli, adopted-detection, local-steering-samepath, audit-r7-adopt-boundary,
  steering-injection, quiet-hooks, lifecycle-e2e, feature-sweep-cli, unadopt-all-e2e, e2e, claudemd-orphan-sentinel) in a scratch copy → passed, 528/528.
- `npx eslint adopt-cli.mjs lib/local-steering.mjs tests/local-steering.test.mjs` → passed (exit 0).
- `prettier --check` on the changed .mjs → clean; README.md / README.zh-CN.md warn, but they warn at ae83c0a9 too and format:check covers only *.{mjs,js}.
- Per-site mutation run (17 mutations, each asserted applied, reverted from a committed baseline) — see P3-8.
- Steady-state cost, silentAutoAdopt on a repo 9 levels deep (tmpfs), 8 ABBA samples x 60 calls:
  median 7.65 ms/call (e95f16c0) vs 7.64 ms/call (ae83c0a9). The extra walk does not show against the git spawns.

## Findings

### P2-1 adopt-cli.mjs:619-630 (also :468 outside git, status :773/:791) — the walk counts the filesystem root, which Claude Code never loads

steeringAbove reads `/CLAUDE.md` and `/CLAUDE.local.md` (the stop test `dirname(d) === d` at :630 runs AFTER d='/' is read).
Claude Code 2.1.322 stops BEFORE the filesystem root. Bundle source (versions/2.1.322):
`for(let yo=st;yo!==void 0&&yo!==osr(yo).root;yo=hM(yo))Tt.unshift(yo);` with `parse as osr`, `dirname as hM` from "path".
Real run (bwrap, `/` a tmpfs holding CLAUDE.md "ROOTMARK-7731" and CLAUDE.local.md "ROOTLOCALMARK-2219", `/x/CLAUDE.md` "XMARK-5150",
session in git repo /x/app): InstructionsLoaded logged only `/x/CLAUDE.md Project session_start`; the model listed only XMARK-5150.
Failing scenario: `adopt` run at `/` (allowed; adoptOne only adds the D#225 note there — a container as root is the plausible case).
Plugin probe in the same kind of sandbox (scratchpad/probes/rootprobe.mjs):
```
old git repo under /: {"action":"local","written":"created"} local copy: true
new git repo under /: {"action":"already-adopted","reason":"above-root"} local copy: false
old/new outside git under /: {"action":"already-adopted","reason":"ancestor-claude-md"}   (D#760, also unreleased: v6.31.0 injected)
```
So every git repo below `/` loses its local copy (an existing plugin copy is deleted and forgotten) and gets no injection:
no steering at all. Falsifies Claim 2. lib/quiet-scope.mjs then still reports the session as steered (root === cwd → true), so
the verbose sections are dropped too. The `--status` stale line (":791") would also tell the user `/CLAUDE.md` "sessions here load as well".
Fix direction (not applied): stop the walk before the root, e.g. `for (let d = dirname(top); dirname(d) !== d; d = dirname(d))`.

### P3-1 adopt-cli.mjs:620 — in a nested worktree Claude Code skips CLAUDE.md in every directory from the main checkout down, not only the checkout's own

CC source: `function JJt(e,n){return n!==null&&tu(e,n.mainRepoRoot)&&!tu(e,n.worktreeRoot)}`; project files load only when `!JJt(dir)`
(`Bo=Ve&&!Fo`), while `localFile` is not gated. Real run 2 (manual nested worktree M/wts/feature, not .claude/worktrees):
loaded `v/CLAUDE.md` (above the checkout) and `v/main/CLAUDE.local.md`; NOT `v/main/CLAUDE.md` and NOT `v/main/wts/CLAUDE.md`.
Plugin (probes/probe5.mjs, `adopt` run in M/wts): `W session: {"action":"already-adopted","reason":"above-root"} | W copy: false`
→ the worktree session has no steering. The same applies to `<main>/.claude/CLAUDE.md`, which the walk reads as `blockIn(<main>/.claude)`;
it counts as stale by default (no `.claude/.claude/` doc) but as current under CLAUDE_MEM_NO_TEMPLATE_REFRESH=1.
Claim 1 holds otherwise: any nested worktree (not only `claude --worktree`) skips the checkout's CLAUDE.md, files above the checkout load,
the checkout's CLAUDE.local.md loads. Skip condition should be "d is inside main and not inside top", not `samePath(d, main)`.

### P3-2 adopt-cli.mjs:577-585 — claudeMdExcludes is read from user + project scopes only; CC also takes it from policy (and flag) settings

pluginSettingsScopes gives `<config>/settings.json`, `<d>/.claude/settings.json`, `<d>/.claude/settings.local.json` only.
CC reads the merged value (`function Xin(){let e=bt().claudeMdExcludes; …}`) and keys `e?.claudeMdExcludes` from
`Se("policySettings")`. A managed-settings file (/etc/claude-code/managed-settings.json, readable from a hook) whose glob excludes the
enclosing CLAUDE.md leaves the plugin relying on a file that does not load → no steering. AC5 says "any readable settings layer".
(Not reproduced with real CC: no managed settings on this host.)

### P3-3 adopt-cli.mjs:405 vs :783 — `adopt --status` promises a removal the session does not make (AC6, Claim 3)

Repo with the plugin copy, current block in the parent's CLAUDE.md, a damaged sentinel line in the repo-root CLAUDE.md (probes/probe2.mjs P2b):
```
status: — none: …/q1-*/CLAUDE.md carries the block (the local copy in …/repo/CLAUDE.local.md is removed at the next session start)
next session: {"action":"damaged","reason":"stray-sentinel"}   root copy still there: true
```
At ae83c0a9 the status line for this state was the plain "✓ … (auto-written, excluded from git)", which matched.

### P3-4 adopt-cli.mjs:790-793 — the stale-file hint is false for a CLAUDE.local.md outside a git top-level

Stale CLAUDE.local.md in the non-git parent of a repo (probe2 P2a): status prints
"⚠ …/q0-*/CLAUDE.local.md holds an out-of-date copy … the next session started in …/q0-* (with auto-adopt on there) brings it up to date",
but a session there returns `{"action":"inject"}` and the file stays stale (`stale file still stale: true`). Same for `$HOME`.
The hint is right only where that directory is a git top-level the plugin writes to.

### P3-5 adopt-cli.mjs:428-431 with :1107 — an explicit `unadopt` in a deferring repo is not remembered

The plugin removes and FORGETS the repo copy when a block above is current; a later `unadopt` in the repo finds nothing, prints
`[unadopt] <repo> → absent`, and records nothing. When the block above goes (or falls behind on the next template change), the next
session writes CLAUDE.local.md again (probes/probe4.mjs, old vs new tree):
```
old | after adopt above: local | unadopt in repo … | after above removed: inject local-removed | copy: false
new | after adopt above: already-adopted above-root | unadopt in repo … | after above removed: local created | copy: true
```
The outcome now depends on the order of the user's unadopt and the plugin's removal. (Claim 4 holds for a deleted FILE; not for unadopt.)

### P3-6 Docs — two claims the code does not back

- README.md:170, README.zh-CN.md:157: "an out-of-date block there does not count" — under CLAUDE_MEM_NO_TEMPLATE_REFRESH=1 it counts
  (adopt-cli.mjs:621/:629; the new test 'an out-of-date block above keeps the local copy' asserts exactly that).
- README.md:170 ("Outside git … the text is injected"), README.md:783 ("or in SessionStart context … outside git"),
  commands/adopt.md:18 ("where it cannot be written (outside git, for example), it adds the text to each session's context") —
  below a current block (D#760, kept by this commit at :468) nothing is injected. The sentences this commit added cover only
  "above the repository root". commands/adopt.md is a shipped prompt template (LLM-visible).
- The added "Claude Code loads that one" is also false for `/` (P2-1) and intermediate worktree dirs (P3-1).

### P3-7 adopt-cli.mjs:621 / adopt-content.mjs:42,62 — deferring to a CLAUDE.md above swaps the detail-doc pointer for one that does not resolve from the session

The local copy names the detail doc by an absolute `~/…/plugin_claude_mem_lite.md`; a CLAUDE.md block names it as the relative
`.claude/plugin_claude_mem_lite.md` (default `detailDocRef`). From a session in `<parent>/repo` that relative path names
`<parent>/repo/.claude/plugin_claude_mem_lite.md`, which does not exist. "Current" compares the CLAUDE.md to buildClaudeMdBlock(),
so this swap is treated as no change. (Same pre-existing shape for subdirectory sessions under a root CLAUDE.md.)

### P3-8 tests/local-steering.test.mjs:2835-3006 — Claim 5 is false: 11 changed sites have no test that fails when only that site breaks

Each mutation applied alone (asserted applied), run against local-steering.test.mjs (253) and then the 12-file set (528): all green.
| id | mutation | site |
|----|----------|------|
| M3 | `keepTracked: true` → `false` (SessionStart would edit a tracked CLAUDE.local.md) | adopt-cli.mjs:429 |
| M9 | drop `local.version === version &&` | :629 |
| M8b | drop `frozen ||` for CLAUDE.local.md above | :629 |
| M12a/b | drop `cwd` / drop `main` from claudeMdExcludesSet dirs | :610 |
| M13 | empty `claudeMdExcludes: []` counts as set | :582 |
| M19a | gitdir not resolved against top (`m[1]`): a relative gitdir (git ≥2.48 `--relative-paths`, which probe1 showed works today) would mis-name main and rely on the checkout's CLAUDE.md → no steering | :567 |
| M19b | drop the trailing-slash `[\\/]?` | :567 |
| M15a/b | status "removed at the next session start" condition → always false / always true | :783 |
| M16 | stale hint: CLAUDE.local.md branch never taken | :791 |
Killed (discriminating): stale-line removal (M22), counting the checkout's CLAUDE.local.md in a worktree (M23).
Equivalent survivors, not counted: `!samePath(top, cwd)` in the adopt warning (adopt at the root drops the root copy first), the
`found.current ||` early stop. No test pins the walk's stop before `/` (P2-1).

### P3-9 adopt-cli.mjs:620 — `--setting-sources` without `project` (source-read only, not run)

CC gates CLAUDE.md on `pL("projectSettings")` and CLAUDE.local.md on `pL("localSettings")` separately. A session launched with
`--setting-sources user,local` loads the repo's CLAUDE.local.md but no CLAUDE.md, so a repo that deferred to a CLAUDE.md above has
no steering there; the hook cannot see the flag. Rare; listed because Claim 2 says "in no state".

## Claims and questions — results

- Claim 1: confirmed for ancestors across repo boundaries (run 1: /x/CLAUDE.md loaded from git repo /x/app; run 2: CLAUDE.md above the
  main checkout and the checkout's CLAUDE.local.md loaded from a worktree). Not exact: the root is excluded (P2-1), and the worktree skip
  covers every dir from the checkout down and applies to any nested worktree, not only `.claude/worktrees` (P3-1).
- Claim 2: false — P2-1 (repro), P3-1 (repro), P3-2, P3-9.
- Claim 3: false in the stray-sentinel state (P3-3); stale-hint text wrong outside git (P3-4). Checked consistent: root opt-out,
  MEM_NO_AUTO_ADOPT, managed-only, frozen+stale (probe2 P2d), subdirectory claudeMdExcludes (P2c), worktree W-first ordering.
- Claim 4: holds for a deleted file (test + probe3 step 4); not for `unadopt` after the plugin's removal (P3-5).
- Claim 5: false (P3-8).
- worktreeMainCheckout: absolute, relative (`--relative-paths`), CRLF, trailing slash → correct (probe1 A: worktree writes its own copy).
  Backslash gitdir on Linux: git itself rejects the worktree (outside-git path). Bare repo named `.git` with sibling worktrees: main =
  the bare repo's parent, matching CC's canonical root (`dr()`: basename(commondir)==='.git' → dirname). Submodule worktree
  (`.git/modules/x/worktrees/w`): null, and CC's `dr()` also returns the common dir there, so the checkout's CLAUDE.md counts in both.
  Sibling (non-ancestor) worktree: parent's CLAUDE.md counts (CC loads it), main only feeds the excludes read (conservative).
  A moved worktree (stale back-pointer) is a worktree to the plugin but not to CC (`dr()` checks `<gitdir>/gitdir`): conservative.
- Ordering: hasBlock, stray, within-root walk, root opt-out and managed-only all return before steeringAbove; AGENTS.md / rules refusals
  come after it (a current block above makes them moot — it already switches AGENTS.md off). Symlinked local file → skipped-symlink,
  kept, no inject (loaded twice, as status says). Exclude line shared between worktrees: kept while the checkout has the block, git
  status clean in both (probe3).
- Throws: worktreeMainCheckout, claudeMdExcludesSet and the CLAUDE.local.md read are wrapped; needsRefresh can only throw on a TOCTOU
  between blockIn and its own read; all inside silentAutoAdopt's try.
- hook.mjs: 'already-adopted' with reason 'above-root' needs nothing (no inject, no offer). lib/quiet-scope.mjs needs no change except
  that it reports "steered" in the P2-1 / P3-1 states.
- Pre-existing, outside this diff: the within-root walk (adopt-cli.mjs:413) and quiet-scope's walk still rely on a stale or
  claudeMdExcludes-excluded CLAUDE.md; the plugin never read claudeMdExcludes before this commit.

## NOT CHECKED

- Node 22 runtime (no Node 22 on this host; static read only: `??=`, no lookbehind). Tests ran on Node 26.8.1.
- Windows (drive roots, case-insensitive paths, `\` gitdirs) beyond reading the regex; macOS.
- The full suite (553 files); only the 12 adopt/steering files.
- Spawned hook.mjs end to end in the deferring states; subagent loading of ancestor files; claudeMdExcludes / managed settings and
  `--setting-sources` with real Claude Code (source-read only); Claude Code versions other than 2.1.322.
- Two sessions starting at once in the main checkout and a worktree.
