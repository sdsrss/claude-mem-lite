> Commits reviewed were rewritten (message-only, trees identical) before push; old -> shipped SHAs are listed in the v6.12.2 release commit db34f01.

# Pre-ship claims review — 13c0664..0fac948 (v6.12.2 candidate)

Precondition: `git rev-parse --short HEAD` = 0fac948; `git log --oneline 13c0664..HEAD` = 10 commits. OK.
Private tree `scratchpad/tree-claims` verified byte-identical to 0fac948 (every tracked file cmp'd, no strays) at start and at end.
Every mutation below: applied via node string replace that exits 3 if nothing changed, "mutation applied" + sha check printed,
restored from a file copy, restore cmp'd against `git show 0fac948:<file>`. vitest runs after 19:24 used TMPDIR=scratchpad/probes/tmp.

Tally: **45 TRUE · 6 FALSE · 2 UNVERIFIABLE** (53 rows).

## 55a61b7 fix(import): scrub before cut

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | 40-char assembled token, 41 cut positions: 29 leaked, longest 29 of 36 secret chars; scrub-then-cut leaks 0 | TRUE | probe `leak.mjs` (parent's `slice(0,80)`-then-`scrubRecord` vs shipped helper, real `lib/scrub-record.mjs`): `old positions=41 leaked 29 max secret chars 29 k range 5 - 33` / `new ... leaked 0 max 0`. Same with the test's `echo ` shape: 29 / 29. |
| 2 | `ghp_` needs 30+ | TRUE | same probe: leaks at k=33 (ghp_+29), scrubbed at k=34 (ghp_+30). |
| 3 | Mutations: storage / preview / helper double-scrub → count case red; cut-first → straddle case red; no scrub → both red | TRUE | vitest, test file 9/9 baseline. storage-double, preview-double, helper-double: each `1 failed | 8 passed`, failing = "the title is scrubbed exactly once on each side". cut-first: `1 failed`, failing = "a token straddling the 80-character title cut…". no-scrub: `2 failed | 7 passed` = both. |
| 4 | Retired source-text guard false-redded on a comment, a Prettier re-wrap, a variable rename; stayed green when the helper double-scrubbed through scrubRecord | TRUE | parent lib + parent test put in tree, 7/7 baseline. comment `// never call scrubSecrets(x) here` in helper → 1 failed; preview line re-wrapped over 3 lines → 1 failed; `useEv`→`useEvent` → 1 failed; helper returning `scrubRecord('observations',{title:…}).title` → **7 passed**. |
| 5 | Read-only count of this machine's DB found 0 imported rows | TRUE | `~/.claude-mem-lite/claude-mem-lite.db` opened `{readonly:true}` (CLAUDE_MEM_DIR unset): `observations WHERE memory_session_id LIKE 'import-%'` = 0; `sdk_sessions` import-% = 0 (151 observations total). |
| 6 | Test comment: straddle fixture stores `ghp_` + 14 secret chars | TRUE | `echo `(5)+56+space = 62 chars before token, cut 80 → 18 token chars = ghp_+14. |
| 7 | Docblock (lib/import-jsonl.mjs:58): "The cut applies to the detail only; the tool name is never scrubbed." | **FALSE** | `importedObsTitle` passes `${prefix}${detail}` — tool name included — through `scrubRecord`. Probe: name `AKIA…EXAMPLE` or a `ghp_…` name → title `"***: echo hello world"` (prefix rewritten); real names (Bash, Edit, mcp__github__create_token, mcp__vault__get_api_key, mcp__srv__password) intact. The slice length is then taken from the UNSCRUBBED prefix. **Corrected:** "The cut applies to the detail only (its length is counted from the unscrubbed `name: ` prefix); the tool name goes through the scrubber with the detail, and no real tool name is shaped like a secret." Impact: none on real data. |
| 8 | Docblock: scrubSecrets not idempotent until D#52 (the `deploy --token ghp_… secret: v` case) | TRUE (current half only) | cited inputs now idempotent over 3 applications: `Bash: deploy --token *** secret: v` ×3, `Bash: AccountKey=***` ×3. D#52 fix commit exists (4d8393c). Pre-D#52 drift not re-measured. |

## 0ac7f04 fix(handoff): id DESC tiebreaker

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 9 | Pre-fix read `0,1,2,3,4`, expected 6..2 | TRUE | `, id DESC` removed from hook-handoff.mjs:403, final test file: `1 failed | 2 passed`; diff shows `real decision 0, 1, 2, 3, 4` vs expected `6,5,4,3,2`. |
| 10 | "The two session_handoffs reads in the same file (pickHandoffToInject's twin queries) keep their spelling" | **FALSE** (population) | hook-handoff.mjs has **8** `session_handoffs` reads ordered `created_at_epoch DESC` with no tiebreaker: 646, 655, 681, 690, 731, 739 (all in `detectContinuationIntent`, 3 twin pairs, 4 of them `LIMIT 1`) and 795, 803 (`pickHandoffToInject`). **Corrected:** "The eight session_handoffs reads in this file (detectContinuationIntent's three twin pairs and pickHandoffToInject's pair) keep their spelling: …". The stated reason applies equally to all eight, so the decision stands; only the count is wrong. |
| 11 | A tie there needs two sessions' handoff writes inside one millisecond | TRUE (with a wording nuance) | PK is `(project, type, session_id)` and `created_at_epoch = Date.now()` at the UPSERT (hook-handoff.mjs:568-590), so a tie needs two distinct rows written in one ms. Nuance: in the null-ccSession arm (803) one session's `clear` and `exit` rows are both visible, so "two rows" is exact and "two sessions'" is slightly narrow; those two rows come from different hook events (Stop vs SessionStart). Live DB: 38 rows, 38 distinct epochs, 0 same-project ties. |
| 12 | The table has no id column | TRUE | schema.mjs:281-293 and live `sqlite_master`: no `id` column. It is a rowid table, but the UPSERT (`ON CONFLICT … DO UPDATE`) keeps the old rowid, so rowid would not order by write time either — the conclusion holds. |

## ae02287 test(file-edge): trailing-separator guard

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 13 | Old case (`src/real.mjs` vs `foo.mjs/`) stayed 13/13 on the reverted scorer | TRUE | parent test file + scorer line 145 reverted to D#48 P3-1's `if (name !== String(token ?? '')) score += 2;` → `13 passed (13)`. |
| 14 | Reverted scorer reads 1 failed / 12, shipped 13/13 | TRUE | final test file: shipped `13 passed`; reverted `1 failed | 12 passed`, failing = "gives no separator bonus to a token whose only separator is trailing". |
| 15 | D#48's other five P3s already fixed inside 1bf34c3 / 5ed90df / 78425cf | TRUE | D#48 detail (live DB, read-only) lists 6 P3s; report docs/audits/20260911-v6.7.1-defect-review.md. P3-3: 1bf34c3 test describe = "sorts and de-duplicates; never drops a non-empty candidate". P3-4: 1bf34c3 asserts full order `JSON.stringify, v4.0.1, 39.602Z`. P3-5: 5ed90df hook-context.mjs:584 and 1bf34c3 user-prompt-search.js:527 both `…, o.id DESC`. P3-6: 1bf34c3 file-edge-match.mjs:199 `if (!Array.isArray(files)) return [];`. P3-2: 78425cf clears `files_modified` on the lesson row; re-ran the report's own mutation at HEAD (Key Context clause → escape-free `buildNotLowSignalSql('o')`) → ledger `1 failed | 17 passed`, failing = "SessionStart — File Lessons + Key Context (keyObs) > still renders a degraded title that carries a lesson (lessonEscape)". |

## cce9c4c + tests/cli-path-invocation.test.mjs:442-448 comment

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 16 | citation-tracker strips both quote kinds; isMemHook is a substring test | TRUE | lib/citation-tracker.mjs:533-534 `replace(/["']/g, '')`; lib/hook-prune.mjs:31-43 `cmd.includes(...)` ×4. |
| 17 | The readers that pin `"…"` are launcherEntryPath and collectOrphanHookPaths | TRUE | hook-prune.mjs:65 `split(/hook-launcher\.mjs"?\s*/)`, :77 `/"([^"]*hook-launcher\.mjs)"/`; install.mjs:2769 `matchAll(/"([^"]+)"/g)`. |
| 18 | A desync makes launcherEntryPath resolve a live hook as missing and pruneDanglingMemHooks delete it | TRUE | probe with real launcher + entry files present: `node "<L>" hook.mjs …` → removed `[]`; `node ${shellWord(L)} …` (single-quoted, path has a space) → entry resolves to `<install>/'`, **removed `["'"]`**. A bare-path form with a matching installDir is not removed, so "a desync" means a quote-kind change like this one. |
| 19 | Paths are `<homedir>/.claude-mem-lite/scripts/*` | TRUE | install.mjs:32 `DATA_DIR = join(homedir(), '.claude-mem-lite')`, :61 `INSTALL_DIR = DATA_DIR`, :911-919 scripts paths (not CLAUDE_MEM_DIR). |
| 20 | Double quotes keep a space, an apostrophe, a trailing `$`, a Windows backslash intact | TRUE | `reach.mjs`: bash -c with `node` shadowed, printf of $1 == path: space / `o'brien` / `a$` / `C:\Users\x` all INTACT. |
| 21 | "**only** a home containing `$name`, `${`, a backtick or `"` breaks them" (also in the commit body) | **FALSE** | same harness, BROKEN also for: `$(id)` (command substitution — same power as a backtick), `$1x`, `a$$b`, `a$?b`, `a$@b`, `a$*b`, `a$#b`, `a$!b`, `a$-b`, `a$0b` (special/positional params), and a backslash before `$`/`` ` ``/`"`/`\`: `a\$b` → `a$b`, UNC-style `C:\\srv\x` → `C:\srv\x`. D#61's own title names "a UNC backslash" as breaking. **Corrected:** "only a home containing a `$` that starts an expansion (`$name`, `${`, `$(`, `$1`, `$$`, `$?` …), a backtick, a `"`, or a backslash before `$`, `` ` ``, `"` or `\` (e.g. a UNC `\\server` home) breaks them." |

## 0fac948 test/doctor labels

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 22 | With imported `Edit: ` titles made low-signal: old case 9/9 green, default-arm case 1 failed / 8 | TRUE | mutation adds `{ like: 'Edit: %', regex: '^Edit: ' }` to LOW_SIGNAL_PATTERNS. Final file: `1 failed | 8 passed` ("a backfilled row is recallable by file…"). Parent file (includeNoise:true): `9 passed (9)`. |
| 23 | Unmutated, both arms return the same rows | TRUE | temporary assert in the case `expect(includeNoise:true ids).toEqual(default ids)` → 9/9 passed; file restored. |
| 24 | The "observation_files data migration" block never calls runDeferredCleanups; it tests insertObs | TRUE | parent file: 0 occurrences of `runDeferredCleanups` in the whole file; the block's only case is "insertObs populates observation_files…". |
| 25 | `if (!last) return` unreachable: no log() precedes the Node-version check, which always records a check | TRUE | install.mjs:1717-1800: only `console.log` header, helper definitions, then the Node check's `ok()` or `fail()` — both branches push to `checks`. No `log(` call between. |
| 26 | mem_recall and the CLI apply the low-signal filter by default | TRUE | lib/recall-core.mjs:25 `includeNoise = false`; server.mjs:1814 `args.include_noise === true`; mem-cli.mjs:738 passes the flag. |

## 46c48d1 test(stats) D#30

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 27 | Five coverage readings 29/0/65/77/33 | UNVERIFIABLE | historical; matches D#22's recorded detail verbatim. Not re-measurable (order-dependent by the commit's own account). |
| 28 | Same tree back to back under coverage: loop body 0 with cli.test.mjs alone, 55 with metric writers; header 28 both | TRUE | parent cli.test.mjs, `--coverage.include=mem-cli.mjs`, json reporter: alone → line 1758 = 28, 1759 = 0. With pathA-exclude-inert, patha-exclude-meter, patha-meter-counterfactual, rerank-pool-replay, patha-exclude-report added → 1758 = 28, **1759 = 55**. (A different writer set — pre-tool-recall-metrics, metrics, pre-tool-recall-file-intel/reread — gave 0, so "which files" matters; the commit does not name them.) Note: D#22's drop_reason says e2e.test.mjs is the only driver; this commit correctly supersedes that for the in-process reader. |
| 29 | New case: counting every row as ok fails it | TRUE | mem-cli.mjs `if (r.enriched) esOk++;` → `esOk++;` → `1 failed` "counts enrich-save ok/total…" (`to contain '✚ enrich-save 2/3 ok'`); unmutated 1 passed. |

## aa2df33 fix(handoff) D#40

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 30 | New fixture read 2 of 5 on the old code | TRUE | hook-handoff.mjs from aa2df33^ + aa2df33 test: `expected [ '[decision] real decision 4', …(1) ] to have a length of 5 but got 2`. |
| 31 | Two writers raise importance without reading the title | TRUE | lib/maintain-core.mjs:493-498 (`access_count > 3`), search-scoring.mjs:377-380 (`access_count >= 2`); neither WHERE reads `title`. |
| 32 | SQLite LIKE ASCII-case-insensitive, LOW_SIGNAL_TITLE not | TRUE | utils.mjs:161 `buildLowSignalRegex()` → `new RegExp(src)` no `i` flag; no `PRAGMA case_sensitive_like` in shipped code. |
| 33 | Control with seven real decisions still reads newest five in order | TRUE | control case passed on both old code (`1 failed | 1 passed`, the passing one) and aa2df33 code (2/2). |

## 22211d8 fix: shellWord remedies (D#61)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 34 | The deferral named nine node remedy lines | TRUE | D#61 title: "Nine doctor/repair remedy lines…". |
| 35 | Sweep found 22 sites | TRUE | product diff: install.mjs 10, binding-probe 2, db-unusable 3, install-shape 1, native-binding-hint 1, hook-launcher 2, launch.mjs 2, server.mjs 1 = 22 changed remedy lines. |
| 36 | Destructive ones: db-unusable rm -f/mv/cp, server.mjs rm of the WAL | TRUE | diff hunks in lib/db-unusable.mjs and server.mjs. |
| 37 | hook-launcher.mjs and launch.mjs import only node: builtins | TRUE | their `^import` lines: node:fs/child_process/path/url/os/crypto only. |
| 38 | Sweep pins the registration strings as its only three exemptions | TRUE | `REGISTRATION` array has 3 entries (cli-path-invocation.test.mjs:450-454). |
| 39 | Registration strings are "parsed back quote-wrapped by hook-prune and citation-tracker" | **FALSE** (already corrected in-range) | citation-tracker strips both quote kinds (row 16). **Corrected** by cce9c4c's comment: parsed by `"…"` regexes in launcherEntryPath and collectOrphanHookPaths. The wrong wording survives only in the 22211d8 commit body; repo-wide `grep -rna` finds no other copy. |
| 40 | Harness dir name `sp ace$HOME\`echo INJECTED\`"dq'sq\bs` | TRUE | cli-path-invocation.test.mjs:367. |
| 41 | "a sweep fails on **any** shell verb followed by "${…}" or "' +"" | **FALSE** (scope) | `VERB_THEN_DQ` lists 7 verbs: node, cd, rm, mv, cp, bash, PATH=. Probe: `npm --prefix "${dir}" install`, `git -C "${dir}" pull`, `ln -s "${a}" b`, `sqlite3 "${db}" .dump` → false; `cd "${root}"` → true. No shipped path remedy with those other verbs found today (only hit: mem-cli.mjs:204 `recall "${queryLabel(q)}"`, a query, not a path). **Corrected:** "a sweep fails on node/cd/rm/mv/cp/bash/PATH= followed by "${…}" or "' +"". |
| 42 | Restoring the eight product files to HEAD fails 5 of the 7 new cases (other two = harness + detector) | TRUE | 8 files from 22211d8^ (8/8 differed): `5 failed | 22 passed (27)` — nativeBindingRepairHint, dbUnusableRemedy, hookManifestRepairHint, sweep, launcher-sync; harness + detector passed. Restored 8/8. |
| 43 | Editing one launcher copy fails the sync case | TRUE | scripts/launch.mjs regex class `+~` → `1 failed`: "the launchers' inline shellWord copies match cli-path.mjs". |
| 44 | "Seven existing expectations pinned the old spelling and now derive from shellWord" | **FALSE** (mechanism for 1 of 7) | 7 old-spelling expects: audit-r8 ×3, db-unusable ×1, doctor-install-shape-e2e ×1, install-ergonomics ×1 → these 6 now use `shellWord(...)`; native-binding-hint's became `toMatch(/cli\.mjs'? rebuild-binding/)` — a spelling-tolerant regex, not derived from shellWord. Also unmentioned: doctor-remedy-runnable's path-scan regex was widened to read either spelling. **Corrected:** "Seven existing expectations pinned the old spelling: six now derive from shellWord and native-binding-hint's accepts either spelling; doctor-remedy-runnable's path scan now reads both." |
| 45 | doctor-install-shape-e2e's `not.toMatch(cd <REPO>)` could never match the old `cd "<REPO>"` output and is live again | TRUE (structural) | old regex `cd ${REPO}\b` vs product `cd "${root}"`: the `"` stops it matching. New `not.toContain(\`cd ${shellWord(REPO)} \`)` uses the product's own spelling. Not mutation-verified (see NOT CHECKED). |

## 4314b1c fix(audit) D#60

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 46 | Red on HEAD's (parent's) audit-metrics.mjs with `expected null to be +0`, green with fix | TRUE | `-t "D#60"`: fixed `1 passed`; parent scripts/audit-metrics.mjs → `AssertionError: expected null to be +0`. |
| 47 | The D#55 guard named this caller as uncovered | TRUE | parent tests/pre-commit-hook-sync.test.mjs:129-130 "`npm run audit:baseline` spawns vitest … and is not covered". |
| 48 | Real run parsed "Test Files 428 passed; Tests 6629 passed" | TRUE (derived, not re-run) | CLAUDE.md baseline 428 files / 6628 at c8cfab5; c8cfab5..13c0664 = release commit only, no test change; 13c0664..4314b1c adds exactly one `it(` (the D#60 case) and no test file → 428 / 6629. |
| 49 | That run left 0 new ssr caches in /tmp and 1 under ~/.cache/tmp | UNVERIFIABLE | past-run observation; not repeated (a full-suite coverage run). |

## d5d579f test(flush-wait) D#50

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 50 | Pre-fix: wait start pinned 125 ms after the timers → `expected false to be true`; 0 and 200 ms passed | TRUE | parent test, warm import first, sync busy-pin after the timers: PIN=0 1 passed; **PIN=125 `AssertionError: expected false to be true`**; PIN=200 1 passed. |
| 51 | Post-fix: 5/5 at pinned starts 0/125/200/400 ms, 5/5 under 600/1600 ms loop stalls, 3/3 under coverage | TRUE | delay inserted after `arrange()`: await-sleep 0/125/200/400 → 5/5 each; sync stall 600/1600 → 5/5 each; coverage ×3 → `5 passed (5)` ×3. (Outside the claim: an ASYNC 600 ms gap between arrange() and the wait reads 0/5 because the latecomer then enters the snapshot. The shipped helper has no gap, so the claim holds.) |
| 52 | Reverting to the dir-wide predicate fails only this case (8022 >= 5000) | TRUE | loop filter → `readdirSync(RUNTIME_DIR).filter(ep-flush-)`: `1 failed | 4 passed`, failing case took **8022ms**. |
| 53 | handleLLMSummary snapshots its set synchronously before its first await | TRUE | hook-llm.mjs:1343-1360: `readdirSync`/`statSync` before the first `await sleep(1000)`. |

## FALSE — corrected statements (summary)

- #7  lib/import-jsonl.mjs:58 "the tool name is never scrubbed" → it IS passed through the scrubber (a key-shaped name is rewritten); only the cut excludes it.
- #10 0ac7f04 body: "The two session_handoffs reads … (pickHandoffToInject's twin queries)" → eight reads (detectContinuationIntent ×6, pickHandoffToInject ×2); same reasoning covers all.
- #21 cce9c4c body + tests/cli-path-invocation.test.mjs:447-448 "only `$name`, `${`, a backtick or `"`" → also `$(`, special/positional `$` params, and a backslash before `$`/`` ` ``/`"`/`\` (UNC homes).
- #39 22211d8 body "parsed back quote-wrapped by hook-prune and citation-tracker" → already corrected in code by cce9c4c; body only.
- #41 22211d8 body "any shell verb" → the seven listed verbs.
- #44 22211d8 body "Seven … now derive from shellWord" → six derive; native-binding-hint became a spelling-tolerant regex (and doctor-remedy-runnable's scan was widened).

Only #7 and #21 live in shipped/tracked files (a docblock and a test comment); the rest are commit-body text.

## NOT CHECKED

- d5d579f docblock "~5 ms warm to ~260 ms cold" import timing.
- #45 not mutation-verified (would need doctor to print `cd <REPO>`).
- 46c48d1 "Nothing in mem-cli races" — reasoned only (the loop is a synchronous read), not stress-probed.
- 22211d8 "shellWord exact for every byte" — not fuzzed; checked only via the hostile-name harness passing.
- 55a61b7 upgrade cost "re-imports ONCE on the next import-jsonl run" — not measured.
- 0ac7f04 test comment "the tie is the common case for a batch of saves" — unquantified; not measured.
- 4314b1c real `npm run audit:baseline` run (row 49).
- Pre-D#52 non-idempotence of scrubSecrets (row 8, historical half).

## Residue

Probe files (leak.mjs, mut.sh, prune.mjs, reach.mjs, save/, tmp/ 52 ssr dirs 222M, cov1/, list.json/err, claims-diff.txt) deleted after writing this report.
`cut.mjs` / `perf.mjs` in scratchpad/probes are NOT mine (mtimes 19:16:27 / 19:19:56, before/between my writes) and were left.
About 14 vitest runs before 19:24 used the inherited TMPDIR and left `/tmp/<id>/ssr` caches (~13MB each). They cannot be told apart
from other agents' caches (content-hashed, no tree path inside), so none were deleted. /tmp was at 12% (1.4G/12G).

## Note: main moved during the review

At the end of the review, main's HEAD is **d228426** ("fix(import): the body and prompt caps also scrub before they cut (pre-ship
review P2-1)"), one commit past the reviewed 0fac948 (lib/import-jsonl.mjs + its test). This review covers 0fac948 only.
In d228426 the FALSE docblock sentence from row #7 is already gone: it now reads "The whole title goes through the scrubber; the cap counts
from the end of the `<tool>: ` prefix." d228426's own claims were NOT reviewed.
