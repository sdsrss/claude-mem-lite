# Post-release review — v6.24.0 batch D#266–D#270, defects lens (blind)

- Range: `f09a9419..a41d9963`. 7 commits (the brief said 8; the brief was wrong). Reviewer: fresh `reviewer` subagent, blind brief (artifact + contract + questions; no author rationale). Delivered 2026-10-07 by heredoc file.
- Disposition: P3-2 (rateLimited cleared by a repair lookup) fixed in 0d1ae7b5; P3-5 (SKIP_UPDATE only in Claude Code settings env) answered with a doctor detail line in 0d1ae7b5, host settings not read; P3-1 (stamp-only UPDATE guards) pinned in 9f91f846; P3-3 (path text keys) fixed in a21669cc with -ef + physical-path keys, completed for the residue key in 6ea6f1f4 (delta review P3-1); P3-4 (non-default profiles re-run once) stated in the CHANGELOG in a21669cc; P3-6 (2914930c message) left in history, the missing behavioural cases added in a21669cc. Q3 weak spot (posix arm with no absolute value) fixed in 6ea6f1f4; Q4: pack.status check added; the D#267/D#268 cases stay in their describe block (placement only).
- Archived verbatim below.

---

# Blind defect review: f09a9419..HEAD (7 commits, a41d9963 at HEAD), 2026-10-07

Note on scope: the brief says 8 commits. `git log --oneline f09a9419..HEAD` lists 7:
888bad9b (D#266), 0d86fe96 (D#267), a250d56c (D#268), 71741063 (D#270), 2914930c (D#269),
ae1b4252 (review P3, deployLockfile), a41d9963 (CHANGELOG measurement).

Method: read every diff and the code around it in the primary tree (read only). Ran mutations in a
detached worktree at $HOME/.cache/tmp/wt-defects (HEAD a41d9963, node_modules symlinked,
TMPDIR=$HOME/.cache/tmp/vt). Each mutation was applied with perl, checked with an md5 change plus a
multi-line grep for the mutated text, and reverted with `git checkout` after the run. The worktree
and scratch dirs are now removed (`git worktree list` shows only main and someone else's wt-claims).

Baselines (HEAD, in the worktree):
- The 10 touched or adjacent test files: 294/294 passed.
- Full suite: 485 files / 8299 tests passed, 58.5 s, exit 0.
- eslint on the 12 changed .mjs files: exit 0. shellcheck on setup.sh and post-tool-use.sh: exit 0.
  `npm run format:check`: "All matched files use Prettier code style!", exit 0.
- With CLAUDE_MEM_SKIP_UPDATE=1 exported, the 35 doctor*/install-*/claude-config-dir files:
  379/379 passed. The new doctor branch does not make other suites depend on the environment.

## Findings

No P1. No P2. Six P3.

### P3-1: the new D#268 write has two WHERE guards that no test pins (the D#267 defect again)
hook-optimize.mjs:536, the stamp-only UPDATE added by a250d56c:
`WHERE id = ? AND ${liveObsFilterSql('')} AND optimized_at IS NULL`.
Removing either predicate leaves the whole suite green. This is the gap D#267 was opened for,
reintroduced in the same batch that closes D#267. The code is correct today, but a later edit can
drop either guard without anything turning red. CLAUDE.md requires the live-row guard on a write
that follows an LLM round-trip, and the optimized_at re-check protects a /verify approval made
during the call (see the main UPDATE's comment).
Evidence (worktree, each mutation confirmed by diff):
- M6, liveObsFilterSql removed from line 536: the 27 re-enrich files passed 426/426; full suite
  485 files / 8299 tests passed.
- M7, `AND optimized_at IS NULL` removed from line 536: the 27 files passed 426/426; full suite
  485 / 8299 passed.
Fix: two more cases with the `writeAfterRead` helper from 0d86fe96 on the stamp-only branch
(supersede the row, or stamp optimized_at, right after the humanSet SELECT). The helper is already
in tests/hook-optimize.test.mjs.

### P3-2: clearing `rateLimited` on a repair lookup moves the next background check from 6 h to 24 h
hook-update.mjs:333 writes `rateLimited: false` and leaves `lastCheck` alone. But `rateLimited`
is also an input to the throttle: shouldCheck picks its interval from it (hook-update.mjs:314), and
the SessionStart spawn gate calls shouldCheck (hook-update.mjs:216). So after a successful repair
lookup, the background check that would have run at lastCheck+6h waits until lastCheck+24h, and
the cached `latestVersion` (shown by doctor and used by the banner) stays stale for up to 18 h
longer. The comment at hook-update.mjs:328 says lastCheck is the throttle and is left to the
background check. It does not mention that clearing rateLimited changes that throttle.
Evidence: scratchpad probe, proxies unset, mocked fetch, sandboxed HOME and CLAUDE_MEM_DIR. Seed
state: lastCheck 7 h ago, rateLimited true, lookupError set. Then `checkForUpdate({allowInstall:false})`:
- no repair first: rateLimitedBeforeCheck true, backgroundCheckFetches 1, latestVersionAfter "1.0.1"
- fetchLatestRelease() first: rateLimitedBeforeCheck false, backgroundCheckFetches 0,
  latestVersionAfter "1.0.0"
Impact: small. A repair that completes installs the latest release anyway. It matters when repair
fails after the lookup (signature, downgrade guard, download).
Fix: either clear only lookupError and lookupFailingSince (the doctor warning keys on lookupError
alone, install.mjs:2550), or also write lastCheck and latestVersion. The new test at
tests/hook-update.test.mjs:848 asserts `rateLimited: false` and would need to change with it.

### P3-3: the D#270 marker key compares path TEXT, so a second spelling of one file re-runs both one-shots
scripts/setup.sh:68: `[[ "$1" == "$2" ]] || printf -- '-%s' "$(printf '%s' "$1" | cksum ...)"`.
CLAUDE_CONFIG_DIR="$HOME/.claude/" (trailing slash) names the same settings.json as the default,
but it does not equal "$HOME/.claude". So the residue warning fires again despite the bare marker,
and the MCP dedup gets a second marker for the same .claude.json ("$HOME/.claude/.claude.json" vs
"$HOME/.claude//.claude.json"). Node's claudeStatePath normalizes through join(); bash does not.
Evidence: sandbox HOME holding both bare markers and a settings.json with legacy hooks, setup.sh
from the worktree, count of "Legacy direct-install hooks detected":
- CLAUDE_CONFIG_DIR unset: 0
- CLAUDE_CONFIG_DIR=$HOME/.claude: 0
- CLAUDE_CONFIG_DIR=$HOME/.claude/: 1
- the same again: 0

Markers left: .mcp-dedup-v2.78, .mcp-dedup-v2.78-597523649, .mcp-dedup-v2.78-966870323,
.residue-warned-v2.55, .residue-warned-v2.55-322284990.
Fix: strip trailing slashes from CLAUDE_CONFIG_DIR before the comparison and the hash. The `-ef`
idiom from step 8 also works for the dir case.

### P3-4: existing non-default-profile installs re-run both one-shots once on upgrade; the CHANGELOG does not say so
scripts/setup.sh:338 and :422. A user whose only profile is an absolute non-default
CLAUDE_CONFIG_DIR already holds the BARE markers, set by 6.24.0 after the dedup ran on
$CLAUDE_CONFIG_DIR/.claude.json. After the upgrade their marker name carries a suffix, so both steps
run again. The dedup deletes `mcpServers["mem-lite"]` without any condition (the node script inside
setup.sh, step 7). The GC comment at hook-shared.mjs:280-297 says the one-shot is intentional: a
user's later re-add must be left alone. Nothing can tell this user apart from a "second profile that
never ran", so this follows from the design. The tests pin it: "a second profile gets its own MCP
dedup" passes with a bare marker present. But the CHANGELOG entry ("the default ... keep the records
existing installs already have") reads as if nothing re-runs for existing users.
Fix: one CHANGELOG sentence. No code change is needed unless the lead wants the bare marker to also
cover the profile that set it, which is not knowable.

### P3-5: D#266(b) still holds when CLAUDE_MEM_SKIP_UPDATE is set only in Claude Code's settings.json env
install.mjs:2522 asks updateCheckDisabledReason(), which reads doctor's own process.env
(hook-update.mjs:283). Nothing reads a settings.json `env` block
(`git grep -n 'settings\.env\|"env"' -- install.mjs hook-update.mjs lib/*.mjs` returns nothing).
If the variable is set only there, the hooks honour it and the background lookup never runs. A
`doctor` started from a terminal does not see it and keeps printing the old lookup-failure warning
indefinitely, which is the same symptom D#266(b) describes. A doctor run through Claude Code's Bash
tool would see the variable.
Evidence: code reading only. `doctor --json` with the variable set and with it empty:
level "ok" "Update state: not checked — CLAUDE_MEM_SKIP_UPDATE is set" vs level "warn" "... the
last release lookup failed (HTTP 400, failing since ...)".
Fix (optional): have doctor name the possibility in the warning's detail line, or read the host
settings' env block. Or declare this out of scope.

### P3-6: one claim in commit 2914930c's message is wrong (no defect escapes)
The message says "Each arm of the rule mutated alone in either script reds a behavioural case, not
only the text check." Removing the drive-letter arm from setup.sh's Windows branch (setup.sh:51,
leaving `\\*`) reds only the text-equality case "setup.sh carries the same _mem_is_abs body"
(tests/post-tool-use-disabled.test.mjs:300). setup.sh's behavioural case drives only `\\srv\cfg`
under msys (tests/install-lifecycle.test.mjs:974).
Evidence: M14 reds 1 of 44, and that one is the text check.
The equality check still pins setup.sh to post-tool-use.sh, whose arms are behaviourally pinned
(M11, M19). So nothing escapes; only the sentence is wrong.

## Q1: does each change fix its contract item on every parallel path? (paths checked)

- D#266 (888bad9b): fixed.
  - fetchLatestRelease's only production caller is repair (install.mjs:3360, `git grep`).
  - self-update goes through checkForUpdate({force}), whose success arm already clears.
  - doctor's human face and `--json` both carry the new line (doctor --json probe above).
  - `status` has no update-state output.
  - The banner (getCachedUpdateBanner) and the spawn gate already return early when checks are off.
  - Dev installs: checksOff 'dev-install' is the same predicate checkForUpdate uses, so the old
    isDevInstall() arm is now reached only when hook-update fails to import.
  - INSTALL_DIR in the dev-install message is homedir/.claude-mem-lite in both files
    (install.mjs:34/63, hook-update.mjs:56).
  - Residuals: P3-2 and P3-5.
- D#267 (0d86fe96): fixed.
  - Both hide-branch predicates are now behaviourally pinned (M4, M5 below).
  - The helper fails loudly, not quietly, if the SELECT text changes: the `reads` premise asserts 1.
- D#268 (a250d56c): fixed for narrow, the only scope that can hide.
  - concepts/aliases/scopes return earlier; wide keeps the normal path, as decided and
    premise-tested.
  - All callers go through executeReenrich (hook-optimize.mjs:1979-2014, the unattended path, and
    the CLI).
  - Residual: P3-1 (test gap).
- D#270 (71741063): fixed, with marker prefixes unchanged.
  - sentinelPrefixesFromShell's regex still matches `runtime/.mcp-dedup-v2.78$(...)`, and
    runtime-marker-gc passes.
  - GC_PRESERVED_MARKER_PREFIXES matches by startsWith, so suffixed names are preserved.
  - No other reader of the exact marker names in shipped code (`grep` for mcp-dedup|residue-warned).
  - Plugin mode only: both steps sit behind CLAUDE_PLUGIN_ROOT, and setup.sh is not in the
    settings.json hook set.
  - Residuals: P3-3 and P3-4.
- D#269 (2914930c): fixed in both bash copies.
  - The other two shipped hooks (pre-agent-inject.sh, pre-tool-recall-bash.sh) do not read
    CLAUDE_CONFIG_DIR (`git grep`).
  - Node sites all use isAbsolute: data-paths.mjs's 3 helpers and lib/bash-file-targets.mjs:42.
  - The extracted `_mem_is_abs` gives identical output under dash and bash 5.3.9 over 9 values x 3
    OSTYPEs (md5 ac1cb683...). That output matches path.win32 for msys/cygwin and path.posix for
    linux-gnu.
  - `OSTYPE=msys bash -c 'echo $OSTYPE'` prints msys, so the test premise holds.
- Review P3 (ae1b4252): fixed. The test runs the real deployCodeTree(false) from an npm-pack file
  list (M17 below).

## Q2: can any change break existing users?

- One-shot re-runs: only P3-3 and P3-4. Default-path users keep their bare names. M20 (exemption
  dropped) reds 4 cases, including 3 older ones, so that holds.
- Which file a hook reads: post-tool-use.sh now reads $CLAUDE_CONFIG_DIR/settings.json for
  backslash values under msys/cygwin, and ~/.claude/settings.json for a drive-letter value on
  POSIX. Both moves are toward Node. The old POSIX behaviour also pointed setup.sh's step-8
  `rm -rf "${CACHE_DIR:?}/$ver"` at a cwd-relative `C:/...` tree; that is gone now.
- Unattended LLM writes: narrower than before for narrow protected 0 replies, and unchanged
  elsewhere. One consequence the CHANGELOG does not state: the protected row now keeps
  aliases/concepts/scope empty. If its narrative is over 100 chars it stays in those three backfill
  pools (findReenrichCandidates, hook-optimize.mjs:90), and the same unattended run fills them right
  after the main pass (hook-optimize.mjs:1979-1993). Lesson and type stay unwritten. This is not a
  defect, but "the row is left as it was" would be an over-reading.
- post-tool-use.sh hot path: one shell function, no fork. My 200-call x 3 rounds on a skipped tool
  (old f09a9419 vs new, including env+bash spawn): old 5777/4858/4807 us, new 4929/5097/4710 us.
  That is noise, with no direction.
- setup.sh (SessionStart, not the hot path): two new `$(marker_suffix ...)` substitutions on every
  start. Measured on Linux at 353 us per call on the default path and 3707 us per call for a
  non-default dir (cksum + cut forks).
- GC lists: no new prefix, and the preserved prefixes cover the suffixed names.

## Q3: can the new tests say NO? (mutations, each confirmed landed, then reverted)

| # | Mutation | Result |
|---|----------|--------|
| M1 | hook-update.mjs:322 clear call removed | red: "a successful lookup through fetchLatestRelease clears..." (1/94) |
| M2 | early return in clearRecordedLookupFailure removed | red: "...writes no state file" (1/94) |
| M3 | install.mjs:2522 `if (false && checksOff)` | red: 2 D#266 doctor cases (2/8) |
| M4 | `AND importance_set_at IS NULL` removed from the hide UPDATE | red: the person-set race case (1/92) |
| M5 | NOT_COMPRESSION_KEEPER_SQL removed from the hide UPDATE | red: the keeper race case (1/92) |
| M18 | D#268 branch `if (false)` | red: 5/92, both new cases among them |
| M6 | liveObsFilterSql removed from the stamp-only UPDATE | GREEN, full suite 8299/8299 (P3-1) |
| M7 | optimized_at IS NULL removed from the stamp-only UPDATE | GREEN, full suite 8299/8299 (P3-1) |
| M9 | residue marker unkeyed | red: "a second profile gets its own..." (1/56) |
| M10 | dedup marker unkeyed | red: 2/56 |
| M20 | marker_suffix default exemption removed | red: 4/34 |
| M11 | post-tool-use.sh msys `\\*` arm removed | red: msys behavioural case + text check |
| M12 | post-tool-use.sh `/*` arm removed | red: 2 parity cases + text check |
| M19 | post-tool-use.sh Windows arm on every OS | red: drive-letter parity, linux-gnu case, text check |
| M13 | setup.sh msys `\\*` arm removed | red: install-lifecycle D#269 case + text check |
| M14 | setup.sh msys drive-letter arm removed | red: text check ONLY (P3-6) |
| M16 | doctor relative-value warning off | red: "doctor warns about a relative value..." |
| M17 | deployLockfile call removed from deployCodeTree | red: the new tarball-shaped case |

Weak spot that does not matter today: the "elsewhere (OSTYPE=linux-gnu)" case
(tests/post-tool-use-disabled.test.mjs:293) has no value starting with "/", so on its own it cannot
catch a bash that calls everything relative. M12 shows the older parity cases catch that.

## Q4: anything else

- The CHANGELOG "Unreleased" wording matches the code for all four fixes. The 6.24.0 edit's "same
  size to within 0.1%" is consistent with the bytes in a41d9963's message
  (48,554,342 - 48,508,780 = 45,562 B = 0.094%).
- The new write-shrinkwrap case calls `JSON.parse(pack.stdout)` without checking `pack.status`. If
  npm is missing or fails, it dies with a TypeError instead of an npm error. Cosmetic.
- The D#267/D#268 cases sit inside describe('re-enrich --scope wide (R-7)') but drive narrow scope.
  Cosmetic.

## Checked, no finding (with evidence)

- D#266 clear writes nothing when nothing failed: M2 red, plus the "writes no state file" case.
- tests/update-proxy-wiring.test.mjs stays sandboxed: hoisted CLAUDE_MEM_DIR, so the new
  successful-lookup write cannot reach the real ~/.claude-mem-lite. The real
  update-state.json mtime is 2026-10-07 17:03:22, unchanged by this review.
- An empty CLAUDE_MEM_SKIP_UPDATE ("") counts as unset in doctor (doctor --json probe: level
  "warn"), the same as checkForUpdate.
- marker_suffix under `set -euo pipefail`: `[[ ]] || printf` always exits 0. A missing cksum would
  yield the name ".mcp-dedup-v2.78-", not an abort.
- bash 3.2 syntax: the nested one-line `case` parses under dash (POSIX), and dash and bash output
  match. `printf --` and `[[ == "quoted" ]]` are bash 3.2 builtins semantics.
- doctor's relative-value warning is quiet for '/srv/cc', '' and unset (new case, M16 red when off).
- deployCodeTree test: the child's HOME is sandboxed, CLAUDE_MEM_DIR and CLAUDE_MEM_RUNTIME_DIR are
  deleted, MEM_NO_AUTO_ADOPT=1, and deployCodeTree only copies SOURCE_FILES (install.mjs:526-600,
  no npm or network). It runs on ubuntu only (ci.yml has no Windows or macOS job), so
  spawnSync('npm') is fine there.

## Disclosure

The first run of the throttle probe inherited this shell's HTTPS_PROXY. hook-update tunnels through
it, so it made real read-only GETs to api.github.com/repos/sdsrss/claude-mem-lite (releases/latest),
up to 2 lookups across the 2 arms, with allowInstall:false and sandboxed HOME and CLAUDE_MEM_DIR.
Nothing was installed and the sandbox was removed (residue count 0). The numbers cited in P3-2
come from a second run with all proxy variables unset (mocked fetch only).

## NOT CHECKED

- Real Git Bash / MSYS2 / Cygwin runs. The Windows arm was driven only with an emulated OSTYPE on
  Linux bash 5.3.9. Whether MSYS `[[ -r "\\srv\cfg/settings.json" ]]` and `\cfg/...` resolve the way
  Node's win32 resolution does is unmeasured, as is the fork cost of marker_suffix on Git Bash.
- Real macOS bash 3.2 (POSIX parse via dash only).
- Claude Code 2.1.293 resolving a relative CLAUDE_CONFIG_DIR against its cwd (claim taken from the
  commit, not re-measured).
- The a41d9963 npm -g / npx registry measurement (needs registry installs).
- The race between clearRecordedLookupFailure and a concurrent background check: unlocked
  read-modify-write, the same pattern as the pre-existing fetchJson 403 writer. Not probed.
- An MSYS-style CLAUDE_CONFIG_DIR (/c/Users/...) is absolute to bash, but Node on Windows reads it
  as root-of-drive. This existed before the range and was not probed.
