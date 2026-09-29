> Commits reviewed were rewritten (message-only, trees identical) before push; old -> shipped SHAs are listed in the v6.12.2 release commit db34f01.

# Pre-ship DEFECT review — claude-mem-lite 13c0664..0fac948 (v6.12.2 candidate)

Reviewer: defect lens. Date 2026-09-25. Tree: private extract at scratchpad/tree-defect,
verified byte-identical to `git archive 0fac948` (file set + `diff -rq`) after every probe.
Precondition: HEAD = 0fac948 and `git log 13c0664..HEAD` is exactly 10 commits (d5d579f … 0fac948). Confirmed.

Counts: P1 0 · P2 1 · P3 5

---------------------------------------------------------------------------------------------
## P2-1  The D#47 P3-8 defect (cut before scrub) is still live at three more cuts in the same file
lib/import-jsonl.mjs:157-158 (inputJson `.slice(0, 4000)`), :162 (non-string tool_result
`JSON.stringify(...).slice(0, 4000)`), :122 (`scrubSecrets(text.slice(0, 10000))` in importPrompt)

55a61b7 reorders the TITLE to scrub-then-cut. The body that goes into `text` AND `narrative`
(both FTS-indexed) is still built from `inputJson` and `resultText` that are cut to 4000 chars
first, then handed to scrubRecord. importPrompt cuts the prompt to 10000 and then scrubs. Same
mechanism, same function, so a token straddling the cut is stored as a plaintext prefix.

The non-string tool_result arm is the COMMON shape: real transcripts embed tool_result parts
whose `content` is an array of blocks, so they take `JSON.stringify(...).slice(0, 4000)`.

The live prompt writer already does the safe order (hook.mjs:2869
`scrubSecrets(promptText).slice(0, 10000)`), and utils.mjs:251-256 (SEC-3) records this exact
defect class on the episode path. The import boundary is the one that was left behind.

Reproduction (a 40-char assembled `ghp_` token, space-separated, swept across 41 cut positions,
end-to-end through importJsonl on an in-memory DB):
  scratchpad/defect-probes/body-straddle.mjs  ->
    input-json cut: 24/41 positions store a ghp_ prefix in text, longest 29 of 36 secret chars
    result-json cut: 24/41 positions store a ghp_ prefix in text, longest 29 of 36
  scratchpad/defect-probes/prompt-straddle.mjs ->
    prompt 10000 cut: 24/41 positions store a ghp_ prefix in user_prompts.prompt_text, longest 29 of 36
(run: `cd scratchpad/defect-probes && PROBE_TMP=$PWD node body-straddle.mjs`)

These are the same numbers the 55a61b7 body reports for the title before the fix ("29 leaked,
the longest 29 of its 36"). The commit fixes the title, and its scope line says title, but a
CHANGELOG line reading "a token straddling the cut is no longer stored" would be false for the
body and for prompts. Fix shape: scrub first, then cut, at all three (bounding the scrub input
the way DESC_SCRUB_WINDOW does if cost matters). Upgrade cost for importPrompt: its dedup key is
`scrubSecrets(text.slice…)`, so a prompt longer than 10000 whose cut area the scrubber rewrites
re-imports once, the same cost 55a61b7 declares for titles.

---------------------------------------------------------------------------------------------
## P3-1  importedObsTitle's docblock says "the tool name is never scrubbed". False.
lib/import-jsonl.mjs:58 vs :63-65

`scrubRecord('observations', { title: `${prefix}${detail}` })` scrubs the name as well. The cut
length is computed from the RAW `prefix.length`, so if the scrubber ever rewrites the name, the
detail window shifts. That takes a credential-shaped tool name, so there's no practical
exposure, but the sentence is a checkable claim and it's wrong. Suggest: "the cut is measured
from the raw prefix; the name is scrubbed with the rest".

## P3-2  The stored imported title is no longer a scrubSecrets fixed point
lib/import-jsonl.mjs:65 (`scrubbed.slice(...)`)

Cutting after the scrub can split a replacement marker. Measured (scratchpad probes/cut.mjs,
14 credential shapes x 91 offsets): 4 stored titles re-scrub to something different, e.g.
  stored  "Bash: echo xxx…xxx Authorization: Bearer **"
  rescrub "Bash: echo xxx…xxx Authorization: Bearer ***"
(same for `postgres://**`). No secret leaks. New-code leak max over the grid was 1-2 chars
(coincidental), against old-code maxima of 14-40. Before the fix every stored title was
scrubSecrets output, so it was idempotent (D#52). Now any future path that re-scrubs the title
(restore re-scrubs other columns, and hook-optimize rewrites titles) changes the dedup key and
re-imports the row once. I found no CURRENT re-scrubber of this title that also keeps
memory_session_id + created_at, so this is latent.

## P3-3  0ac7f04 fixed the tie on one of the three observations reads in buildAndSaveHandoff
hook-handoff.mjs:251 (`completed`, `ORDER BY created_at_epoch DESC LIMIT 15`),
hook-handoff.mjs:356 (`obsFiles`, `ORDER BY created_at_epoch DESC LIMIT 10`),
hook-handoff.mjs:168 (carry-forward fallback, `LIMIT 1`)

The commit body says the other reads in the file keep their spelling because session_handoffs
has no id column. That covers only the two session_handoffs reads. These three read
`observations`, which has an id. Each is a LIMIT selection with no tiebreaker, so on a tie at
the boundary it keeps the oldest rows (CLAUDE.md: a shared millisecond is 90.67% on one
population). Pre-existing, not a regression. It's the same shape the commit fixed, and the
commit body's survey misses it.

## P3-4  hook-handoff.mjs:352-358 is D#40's own shape, one query above the D#40 fix
`obsFiles` is `files_modified IS NOT NULL … LIMIT 10`, and the JS then drops `[]` and paths that
fail isValidFile. So rows with no usable edits can use up the LIMIT and evict older real edits
from key_files. That's a reachability bound upstream of a JS filter, which is exactly what
aa2df33 removed for Key Decisions. A read-only count of the live DB (2026-09-25) shows 30 of
151 non-NULL files_modified values are literally '[]' (dev--claude-mem-lite 11/62,
dev--code-graph-mcp 12/27). Pre-existing, not touched by the diff. Listed because the D#40
commit reasons about this function's pool and doesn't mention its sibling.

## P3-5  D#61 changes Windows remedy text from cmd-valid to cmd-invalid
cli-path.mjs:33 `shellWord` (used by all 22 sites in 22211d8)

Every Windows path contains `\`, which is outside `[\w@%+=:,./-]`, so it's never "plain" and
always comes out single-quoted:
  node -e … shellWord('C:\\Users\\ann\\.claude-mem-lite\\cli.mjs') -> 'C:\Users\ann\.claude-mem-lite\cli.mjs'
`node 'C:\…\cli.mjs' repair` fails in cmd.exe (cmd doesn't strip single quotes). The old
`node "C:\…" repair` worked in cmd, PowerShell and Git Bash. The README says Windows "Installs,
not CI-covered". CLI_INVOKE already used shellWord before this range, so this extends an
existing choice rather than creating it, but the commit claim "byte-identical output for a
plain path" is never true on Windows. The POSIX-only remedies (rm/mv/cp) were never cmd-valid
anyway.

(Pre-existing and outside the D#55/D#60 population, not counted: benchmark/efficacy-harness.mjs:226
still spawns `./node_modules/.bin/vitest` directly, with the inherited TMPDIR.)

---------------------------------------------------------------------------------------------
## Per-commit verdicts (Q1) and can-each-test-fail (Q3), counter-examples from the real revert

All runs are targeted vitest files in the private tree, with TMPDIR=~/.cache/tmp. Each
revert/mutation was checked as landed (sha1 changed + `node --check`) and restored (sha1 equal
to `git show 0fac948:<file>`).

- d5d579f (flush-wait test). No product change. Mutating the product to the dir-wide predicate
  (`pending = readdirSync(RUNTIME_DIR).filter(ep-flush-)`) fails only "ignores a flush file
  that appears AFTER…" (`expected 8035 to be less than 5000`). HEAD passed 3/3 back-to-back
  runs. Verified the "snapshot before first await" premise: no `await` precedes the readdirSync
  in handleLLMSummary (hook-llm.mjs:1319-1346).
- 4314b1c (audit:baseline via test:coverage). Revert of scripts/audit-metrics.mjs -> the D#60
  case goes red (`expected null to be +0`); HEAD green. The other red in that file, "tracked
  shim is EXECUTABLE in the index", is red on HEAD too. It's an artefact of the extract's empty
  .git, not the diff.
- 22211d8 (shellWord). Revert of all 8 product files -> 5 of 27 red (3 behavioural remedy
  cases, the sweep with 22 hits, launcher-copy sync). Matches the body. cli-path.mjs is a leaf
  (imports node:url, node:path only), so the new lib/ imports add no load-graph edge to the
  recovery paths. Consumers of the changed strings (hook.mjs:2317 parsed.repair, doctor, launch)
  only print them; none parse the quoting. The hook REGISTRATION strings are unchanged. My own
  sweep for remaining `verb "${` sites in shipped .mjs/.js and scripts/*.sh found only the three
  exempted registrations plus benchmark/efficacy-harness.mjs (not shipped as a remedy).
- aa2df33 (Key Decisions cap after filter). Revert -> "keeps five real decisions…" red
  (length 2, not 5). `.iterate()` + `break` closes the statement. The loop body does no DB
  work, so there's no busy-connection risk. The filter is the same regex as before. Output order
  is unchanged.
- 46c48d1 (stats enrich-save). Mutations "count every enrich_save as ok" and "drop the event
  filter" -> both red (`to contain '✚ enrich-save 2/3 ok'`). The premise assertion
  (spy called) holds.
- 0ac7f04 (id DESC tiebreak). Revert to 0ac7f04^ -> tie case red (read 0..4, expected 6..2).
  See P3-3 for the siblings.
- ae02287 (trailing-separator guard). Both revert shapes, `name !== raw` and the unstripped
  `/[/\\]/.test(raw)`, -> the new assertion is red (`['foo.mjs/','bare.mjs']`), 1 failed / 12.
- cce9c4c. Comment-only (7+/2-, all `//` lines). Spot-checked its claim:
  launcherEntryPath (lib/hook-prune.mjs:61-80) splits on `hook-launcher.mjs"?`, so a
  single-quoted registration would parse the entry as `'` and prune a live hook. The claim holds.
- 55a61b7 (import title scrub-then-cut). Revert to 55a61b7^ -> the straddle case is red, and
  the count case and control stay GREEN. Expected: the pre-fix code also scrubbed once per side,
  so the count case guards double-scrub, not cut order. Mutations: preview wrapped in a second
  scrubRecord -> count case red (3 calls). Helper scrub removed -> count case + straddle red.
  Neighbours (import-jsonl, secret-scrub-coverage, cli, handoff-payload-reach,
  audit-silent-20260814, recall-core): 367/367 green on HEAD.
- 0fac948 (backfill default arm). Mutation adding `{like:'Edit: %'}` to LOW_SIGNAL_PATTERNS ->
  the backfill case is red (`expected [1] to include 13`). The includeNoise:true arm of
  recallByFile is still exercised elsewhere (recall-core.test.mjs:103, audit-silent:224). Note:
  import-jsonl.test.mjs:412/418/451/461 still pass `includeNoise: true`, the same P3-7 shape in
  the sibling suite. The install.mjs comment claim ("unreachable today") is true:
  doctor() calls ok()/fail() for Node version (install.mjs:1811-1816) before any log().

## Q2 — lib/import-jsonl.mjs specifics
- Exactly-once: both sites call importedObsTitle, which scrubs once. Storage puts `title`
  OUTSIDE the scrubRecord spread (:192-216), so no second scrub. Confirmed by the count case and
  by mutation.
- Stored title == cross-run key on every path: pair path, embedded tool_result path and orphan
  fallback (:423-436) all go through tryImportToolPair -> importedObsTitle.
- Surrogate/multi-byte cut: an emoji straddling the cut is stored as U+FFFD (SQLite UTF-8
  conversion). Dedup still holds, 1,1,1 rows over three runs, because
  `createHash().update(string)` applies the same lone-surrogate -> U+FFFD conversion to the
  preview. Identical before and after the fix (probe: defect-probes/surrogate.mjs, run against
  both the HEAD and the 55a61b7^ copy). CJK: no issue.
- Cut through a `***` marker: yields `**`. No leak, but not a fixed point (P3-2).
- Nothing in the stored row lost its scrub. subtitle/text/narrative/concepts/facts/
  lesson_learned/search_aliases still go through scrubRecord. files_read/files_modified still
  go through scrubFilePaths. Only `title` moved, and it is scrubbed in the helper.
- Cost: the title scrub now runs over the FULL command (previously ~86 chars), twice per pair.
  Measured scrubSecrets at 100 KB over 8 shapes (plain, heredoc, 'a'*n, `key=`*n, `token: `*n,
  base64, url-ish, `<private>`*n): max 4.5 ms. Linear, no blow-up. The string tool_result is
  already scrubbed uncapped, so this is not a new exposure class.

## Q4 — touched but not stated in the bodies
- 0fac948 also edits install.mjs (comment-only, :1758-1760). The body mentions it as P3-3.
- 22211d8 changes seven existing test expectations. doctor-remedy-runnable's parser now
  accepts `'…'`, which is correct for shellWord output except for a path that itself contains
  `'`. No fixture has one.
- Nothing else found outside what the bodies state.

## NOT CHECKED
- Whole-suite run, coverage, knip, eslint and format:check. I ran targeted files only
  (≈530 tests across the files above).
- The doctor-install-shape-e2e `not.toContain(cd <REPO> )` liveness claim. I didn't construct a
  counter-example that makes doctor print `cd <REPO>`.
- The D#61 bash-evaluation harness on macOS bash 3.2 and on Windows Git Bash / PowerShell. The
  cmd.exe claim in P3-5 is from quoting semantics, not executed.
- sandbox harness tests/sandbox/phase{A,B,C} (not needed by this diff: no dependency change).
- Whether any restore/re-enrich path in practice re-scrubs an imported title (P3-2 stays
  latent).
- P3-3/P3-4 were not reproduced end-to-end through buildAndSaveHandoff. They're based on the
  quoted SQL plus the live-DB '[]' count.
