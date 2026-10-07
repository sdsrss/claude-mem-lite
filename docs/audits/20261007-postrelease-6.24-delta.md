# Post-release review — v6.24.0 batch D#266–D#270, delta round (blind)

- Range: `a41d9963..43a6acab`. 4 commits (the repairs of the two reports above). Reviewer: fresh `reviewer` subagent, blind brief (artifact + the two reports as contract + questions). Delivered 2026-10-07 by heredoc file. Second and last review round for this batch.
- Disposition: P3-1 (residue key by dir) and P3-7 (posix arm) fixed in 6ea6f1f4; P3-6 (CHANGELOG population) in 6ea6f1f4; P3-2 (SKIP_UPDATE wording), P3-3 (test title), P3-4 (doctor detail line), P3-5 (rateLimited comments) and P3-8 (README count) in the commit archiving this report; P3-9 and the P3-5 0d1ae7b5-message part left in history. Harness note (db-unusable-wiring red when the worktree sits directly in TMPDIR) is a pre-existing test-layout fragility, not addressed.
- Archived verbatim below.

---

# Blind delta review: a41d9963..HEAD (4 commits, 43a6acab at HEAD), 2026-10-07

Commits: 0d1ae7b5 (update: narrower clear, SKIP_UPDATE wording, doctor detail line), 9f91f846 (optimize:
stamp-only guards and race premises), a21669cc (setup: -ef, physical-path keys, slash strip, Windows-arm cases),
43a6acab (archives, README/CHANGELOG 57 MB caliber, pack.status).

Method: read every diff and the code around it in the primary tree (read only). Probes and mutations ran in a
detached worktree at $HOME/.cache/tmp/wt-delta (HEAD 43a6acab, node_modules symlinked). Proxy vars,
CLAUDE_MEM_SKIP_UPDATE and (after the disclosure below) OPENROUTER_API_KEY unset. Each mutation was an
exact-substring replace that refuses to run unless the old text occurs exactly once, then an md5 change check and
`git diff --stat` (1 line each), and `git checkout` to revert, with `git status --porcelain` empty afterwards. The
worktree and every sandbox are removed: `git worktree list` shows only main, and the residue count is 0.

Fresh baselines (worktree, TMPDIR=$HOME/.cache/tmp/vt-delta):
- Full suite: 485 files / 8302 tests passed, exit 0, 41.5 s. a41d9963 read 8299 in the archived report; +3 = the two
  stamp-only cases and "another spelling".
- The 6 touched test files: 252/252.
- eslint on the 10 changed .mjs files: exit 0. shellcheck setup.sh post-tool-use.sh: exit 0. `npm run format:check`:
  exit 0. Its glob is **/*.{mjs,js}; a direct `prettier --check README.md` does flag README, which lies outside
  that gate.

Harness note for the lead: with the brief's layout (worktree in $HOME/.cache/tmp, TMPDIR=$HOME/.cache/tmp),
tests/db-unusable-wiring.test.mjs "still records for a SECOND project on the same shared database" goes red
3/3 (expected 2, got 1). The cause is that join(REPO,'..') equals tmpdir(), so the test's two "projects" are one
directory. With TMPDIR=$HOME/.cache/tmp/vt-delta the file passes 7/7. This comes from where the worktree sits, not
from the range.

## Findings

No P1. No P2. Nine P3.

### P3-1: residue marker keys a symlinked non-default config dir (and `dir/.`, and MSYS backslash forms) apart, contrary to the new comment
scripts/setup.sh:70: "Another spelling of a path (`cfg/`, `~/./.claude`, a symlinked dir) must key the same file".
The residue call (setup.sh:431) passes the config DIR, and marker_suffix (setup.sh:76) resolves only `${1%/*}`, its
parent, then appends `${1##*/}` as text. So a symlink to a non-default dir keys by the link's name. -ef rescues the
link only when it points at the default ~/.claude. The dedup key is fine, because its `${1%/*}` is the config dir
itself.
Evidence (real setup.sh from the worktree, sandbox HOME with node_modules linked, CLAUDE_PLUGIN_ROOT under each
spelling, legacy hooks in work/settings.json, `work-link -> work`):
  work warnings=1, work 0, work-link 1, work-link 0, work/. 1
  markers left: .mcp-dedup-v2.78-3089350294 (one), .residue-warned-v2.55-{1108842616,3569404237,692862113} (three)
Function-level probe (the shipped block 43-78 sourced under set -euo pipefail): ~/work and ~/work/ give residue
-3326124894; ~/work-link gives -1485149260; ~/work/. gives -3597349626; the dedup key is -3680310509 for all four.
Windows shells: `${1%/*}`, `${1##*/}` and the setup.sh:59 strip loop split only on `/`. Pure-bash split of the
values: `C:\Users\x\cfg` has dir-part = leaf = the whole value. So its residue key is "<pwd -P of cfg>/C:\Users\x\cfg",
while `C:/Users/x/cfg` and `/c/Users/x/cfg` key "<...>/x" + "cfg". A trailing `\` is not stripped either. The
real MSYS cd/pwd behaviour is NOT CHECKED.
Impact: a one-time warning repeats once per extra spelling of the same settings.json. Nothing destructive: the MCP
cleanup's key stays unified. This leaves the defects archive's "P3-3 ... fixed in a21669cc" partial, and the
CHANGELOG's "kept per file it checks" holds only for the dedup record.
Fix: key the residue marker by the file it gates, `marker_suffix "$CC_CONFIG_DIR/settings.json"
"$CC_DEFAULT_CONFIG_DIR/settings.json"`, so that `${1%/*}` is the config dir and gets `pwd -P`. Alternatively,
resolve "$1" itself when it is a directory. Add a symlink spelling to "another spelling of the same path reuses
its marker".

### P3-2: CHANGELOG.md:11 and install.mjs:2520-2521, "the warning stayed until a repair happened to [look up]", describe a state no release had
CHANGELOG.md:9 says, in the same bullet, that before the fix "repair's lookup recorded nothing on success". At
v6.24.0 (f09a9419), `fetchLatestRelease` is `return (await lookupLatestRelease()).release;` and repair() has no
saveState. The only clearers are checkForUpdate's success arms, which return early under CLAUDE_MEM_SKIP_UPDATE
(`git show f09a9419:hook-update.mjs` writers: lines 113, 139, 152, 167, 416, none reachable from repair on
success). So under SKIP_UPDATE a recorded failure stayed until the variable was unset. "Until a repair happened
to" holds only for the code with fix (a) and without fix (b), which never shipped. The pre-0d1ae7b5 wording
("stayed forever") was right on this point; it was wrong only in "no lookup runs at all".
Fix: "...(a `repair` still does, but recorded nothing on success), so the warning stayed until the variable was
unset...". In the install.mjs comment, say that without this branch a repair lookup would be the only thing to
clear it.

### P3-3: a fourth copy of the retracted P2-1 claim was not swept
tests/doctor-update-pending.test.mjs:126: `it('says the checks are off instead of warning about a failure nothing
will clear', ...)`. Since 888bad9b, a successful repair lookup clears the failure even under SKIP_UPDATE
(hook-update.mjs:320-323 is not gated). 0d1ae7b5 reworded the comment above it (lines 105-107) but not the case
title. `git grep -n "nothing will clear"` returns only this line.

### P3-4: install.mjs:2563, doctor's new detail "this record dates from before that" is not guaranteed
If the variable is set only in Claude Code's settings, a terminal `self-update` runs without it. install.mjs:3303
calls `checkForUpdate({ force: true, ... })`, and its failure arm writes `lookupError: lookup.error` with a fresh
lastCheck (hook-update.mjs:111-117), so the record can postdate the setting. A variable set in a project-scope
settings file also leaves background checks running in other projects, which share the same data-dir
update-state.json. The rest of the line holds: under `doctor --json` it attaches to the warn check
(details[1] in a sandbox run), and on the human face it prints beneath the ⚠ line.
Fix: "...background checks are off there, so this record may predate that, or come from a run that did not see
it (a terminal self-update)".

### P3-5: hook-update.mjs:340, "only a successful background check clears it", and :328 plus 0d1ae7b5, "Only the two fields doctor's warning reads"
- self-update's forced checkForUpdate also writes `rateLimited: false` on success (hook-update.mjs:137 and :157;
  install.mjs:3303). It is not the background check.
- doctor's warning line also prints the background-check fields. install.mjs:2547 pushes 'rate-limited', and
  :2555 interpolates parts into the ⚠ message. Sandbox `doctor --json`: "Update state: last check: ..., latest:
  v6.24.0, rate-limited — the last release lookup failed (...)". lookupError and lookupFailingSince are what
  decide WHETHER it warns, which is what the justification needs. The sentence says more than that.
- After a successful repair lookup under a persisted rateLimited:true, doctor now prints a green line that still
  says "rate-limited". That matches the pre-888bad9b behaviour, so it is no regression; I mention it only because
  the comment says the fields are not doctor's.

### P3-6: CHANGELOG.md:25-26, "both checks run once more after this update: that profile's first check of its own files"
- For a profile whose first install was 6.24.0 itself, this is a second check, not the first. f09a9419's setup.sh
  ran the dedup on `$CC_STATE_FILE` (line 322) and the residue check on `$CC_CONFIG_DIR/settings.json` (line 405)
  under the BARE markers (lines 319, 403). 6.23.3 used ~/.claude.json and ~/.claude/settings.json (lines 309,
  392). This is the archived P3-4's own population: "nothing can tell this user apart" is in a21669cc's message,
  but the CHANGELOG states "first". The population is small (the v6.24.0 commit is dated 2026-10-07 19:03Z).
- CLAUDE_CONFIG_DIR=~/.claude is not "another directory", yet the MCP cleanup runs once more for it, on
  ~/.claude/.claude.json (probe: residue bare, dedup -258067689). Lines 23-24 imply this; line 25 does not name it.

### P3-7: a finding neither fixed nor listed as left
The defects report's Q3 weak spot and the claims report's P3-2 sub-point name the same gap. The "elsewhere
(OSTYPE=linux-gnu)" case (tests/post-tool-use-disabled.test.mjs:295-298) still has no value that path.posix calls
absolute, and no "split both ways" premise. VALUES (line 256) are all relative under posix, so the case cannot
catch a bash that calls everything relative; other parity cases do (archived M12). Neither Disposition line
mentions it. The claims line files P3-2 under "(setup.sh arms) ... in a21669cc".
Fix: add '/srv/cfg' to VALUES (win32 also calls it absolute, so the msys premise still splits), or add the premise
assertion to the posix case. Otherwise list it as left.

### P3-8: README.md:256, "96 packages instead of 298" is attached to `-g`/`npx`, but 298 was never measured for them
The parenthetical now qualifies the MB pair ("57 MB instead of 541 MB, measured as a dependency install"). The
package-count pair sits outside it. The before-count for -g/npx is an inference from "npm installs a package's
shrinkwrap whole" (CHANGELOG 6.24.0), not a reading: a41d9963 says -g/npx "were not measured separately" before,
and its own run measured only the after state (96 each). This is the same reading the claims P3-8 flagged, now on
the count instead of the size.

### P3-9: a21669cc message, "a non-default `work/` vs `work/` + slash"
The case compares `work` with `${work}/` (tests/install-lifecycle.test.mjs, the "another spelling" case). The
message names the same spelling twice. History only.

## Q1: correctness on every path, and one-shot re-runs or skips (checked)

- No wrong SKIP found. -ef returns true only for the same inode, and the bare markers were set on the default
  files (6.23.x) or on the D#270 shape already accepted. No new key can collide two distinct files except by a
  32-bit cksum collision or a cd failing on an existing directory, and that second case is unreachable because
  Claude Code must traverse the directory.
- Re-runs: (i) P3-1, a warning per extra spelling; (ii) P3-6, the documented population.
  (iii) Unreachable in practice: the dedup key moves from text to physical when the config dir first comes into
  existence, and only when its text is not physical. Probe with HOME spelled through a symlink: ~/newcfg missing
  -4062362788, then created -3572945275. With a marketplace plugin the dir already holds plugins/, so it exists;
  `--plugin-dir` is NOT CHECKED.
- Strip loop (setup.sh:59): terminates (one character per pass); "/" is kept, "//" becomes "/", and "~/work/"
  keys as "~/work". Both / and // give residue -1713039686 and dedup -152495549. A value with a space works
  ("~/my cfg" keys computed). All ran under set -euo pipefail with exit 0.
- set -e: the two `[[ ]] && ...` lists are exempt. The function's last command is printf, so the outer assignment
  at :347/:431 cannot fail. The only abort path is `key="$(cd ... && pwd -P)"` failing while errexit is inherited
  into $(...), which needs cd to fail on a directory that exists.
- bash 3.2 constructs used: [[ -ef ]], local, ${%}, ${##}, pwd -P, while [[ == */ ]]. All are 3.2 builtins and
  syntax; not run on 3.2 (NOT CHECKED).
- Default spellings now reuse the bare residue marker: ~/.claude/, ~/./.claude, and a symlink to ~/.claude all give
  <bare>. For the dedup marker, ~/.claude, ~/.claude/, ~/./.claude and the symlink all give -258067689.
- clearRecordedLookupFailure (hook-update.mjs:332-336): it returns with no write when neither field is set. A
  rateLimited-only state no longer writes. fetchLatestRelease has one production caller (install.mjs:3367).
  Throttle probe (mocked fetch, sandboxed HOME, proxies unset): seed lastCheck 7 h ago, rateLimited, lookupError.
  "none" arm: 1 background fetch. "repair-first" arm: rateLimited stays true and 1 background fetch. The archived
  reading before this fix was 1 vs 0.
- doctor detail line: `--json` puts it in the warn check's details (2 entries), and the human face prints it
  indented under the ⚠.

## Q2: can the new or changed tests say NO? (11 code and 2 test-side mutations, each confirmed landed, then reverted)

| # | Mutation | Result |
|---|----------|--------|
| M1 | hook-update.mjs: clear writes `rateLimited: false` again | red 1/94: "...clears the recorded failure, and only that" |
| M2 | setup.sh:74 drop `|| "$1" -ef "$2"` | red 1/30: "another spelling" (~/./.claude: warning repeated) |
| M3 | setup.sh:76 deleted (text key) | red 1/30: "a second marker for the same .claude.json" |
| M4 | setup.sh:59 strip loop deleted | red 1/30: "the trailing slash re-ran the warning" |
| M5 | stamp-only UPDATE: liveObsFilterSql dropped | red 1/94: "...skips a protected row superseded..." |
| M6 | stamp-only UPDATE: `optimized_at IS NULL` dropped | red 1/94: "...stamped by another pass (a /verify approval)..." |
| M7 | test: person-set race write aimed at id+999 | red: "premise: the write landed: expected null not to be null" |
| M8 | test: member inserted under id+999 | red: "premise: the member landed: expected +0 to be 1" |
| M9 | setup.sh:51 drive-letter arm removed | red 2/45: D#269 behavioural case + text check |
| M10 | setup.sh:51 `msys* | cygwin*` narrowed to `msys*` | red 2/45: D#269 behavioural case + text check |
| M11 | post-tool-use.sh:37 the same narrowing | red 2/45: "a Windows shell (OSTYPE=msys, cygwin)..." + text check |

The claims "94 cases, 1 red each" (9f91f846), "no -ef, text key, no strip: each reds that case" and "each of those
mutations now reds a behavioural case" (a21669cc), and "Restoring the rateLimited clear reds it" (0d1ae7b5) all
match these readings. No test pins the doctor detail line (`git grep` in tests/ finds none), as 0d1ae7b5 says.

## Q3: claims (held, with evidence)

- 0d1ae7b5: 6 h / 24 h from rateLimited (hook-update.mjs:314); "up to 18 h"; "repair, manual or launched by
  hook-launcher, looks up regardless, as the README says" (README.md:1223); "wrote no state" holds only on
  success (fetchJson 403 write at :430). The three rewordings are present, except P3-2 and P3-3 above.
- 9f91f846: the session-id rewrite is unreachable for a narrow 0 reply. The stamp-only branch `continue`s at
  hook-optimize.mjs:529-545, before keepStoredText at :587. "/verify approval" stamps optimized_at
  (lib/verify-apply-core.mjs:371). The D#268 headline and the backfill sentence hold.
- a21669cc: "warnings 0/0/1/0" matches the archived P3-3. "71741063's ... was 2" matches the claims archive. The
  cleanup removes `mem-lite` unconditionally and `mem` only when OURS matches (setup.sh:354-366). The stale-comment
  fixes are present (setup.sh:424, 469; hook-shared.mjs:284-285). data-paths now says "can then".
- 43a6acab: the counts (6 / 1+11) match the archives. "Archived verbatim": `tail -n +9` of each archive diffs
  byte-identical against the delivered scratchpad/review-{defects,claims}.md. The 0.1% claim holds for each arm
  against the dependency install: -g 45,450 B = 0.094%, npx 112 B. pack.status is asserted
  (tests/write-shrinkwrap.test.mjs:170).
- Claims archive disposition, P3-3 restatement ("no shipped writer can store a person-set importance 0"):
  spot-checked. Every importance writer floors at 1 (lib/maintain-core.mjs:344, 505 MAX(1,...), 527 MIN(3,...);
  search-scoring.mjs:377 = 2), and restore clamps to 1..3 (mem-cli.mjs `imp >= 1 && imp <= 3 ? imp : 1`).

## Q4: findings left unaddressed

- P3-7 above (posix-branch weak spot / claims P3-2 sub-point).
- P2-1 is partly unswept (P3-3 above).
- Defects P3-3 is "fixed" only for the dedup record and for default spellings (P3-1 above).
- Everything else in both reports is fixed or listed as left in history, and verified above.

## Checked, no finding (with evidence)

- hook-update clear, all paths: M1, the throttle probe (1/1), and the no-write early return (the "writes no state
  file" case is green; the archived M2 still applies).
- Default-path users keep their bare names: unset → <bare>/<bare> in the probe; the full suite is green,
  including the older D#270 cases.
- doctor --json and text faces of the new line: sandbox run, details[1] present.
- The CHANGELOG 6.24.0 rewrap, and the README MB pair now qualified as a dependency install.
- The race premises now assert landing: M7, M8.
- Format, lint and shellcheck gates: exit 0 (above).

## Disclosure

The first sandboxed `doctor --json` run inherited OPENROUTER_API_KEY from this shell, so doctor's LLM-provider check
made an outbound TCP-connect probe to the provider host. It timed out ("unreachable direct (timeout)"). Per
lib/llm-provider-probe.mjs:13-14 the probe is transport-only, so no key or request body was sent. Proxies were
unset. Later runs unset the key. The first full-suite run used TMPDIR=$HOME/.cache/tmp; it left no entries at
depth 1 (`find -newer`, count 0 besides my own dirs, now removed).

## NOT CHECKED

- Real Git Bash / MSYS2 / Cygwin: whether `cd 'C:\cfg'` and `pwd -P` resolve as assumed in P3-1, and CDPATH's
  effect on a `cd` whose argument does not start with `/` (only Windows values reach that).
- Real bash 3.2 on macOS, including whether errexit is inherited into $(...).
- Whether Claude Code creates CLAUDE_CONFIG_DIR before SessionStart for a `--plugin-dir` plugin (Q1 (iii)).
- Whether Claude Code's settings `env` reaches hooks and the Bash tool (taken from the brief and the commit).
- The concurrent read-modify-write between clearRecordedLookupFailure and a background check.
- The registry byte figures themselves (taken from a41d9963's message), and coverage.
- The pack.status assertion was read, not mutated.
