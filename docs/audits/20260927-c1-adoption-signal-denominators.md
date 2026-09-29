> Copied verbatim from the session scratchpad on 2026-09-27 (runbook: reports go to docs/audits before scratch is removed). Scratch paths inside refer to that session. Repairs: 3baace6, ed04098.

# C1 adoption-signal denominators — measurement report

Stamp: run 2026-09-27T08:15:00Z (ruler) → 08:15:10Z (walk), back-to-back in one process.
Tree: claude-mem-lite main @ 209a8bd (I edited no tracked file; the shared working tree carries OTHER agents' uncommitted edits to hook.mjs, hook-precompact.mjs, lib/hook-stdout.mjs, package.json, scripts/user-prompt-search.js, source-files.mjs — none of the files cited below except hook.mjs, cited at HEAD). DB: `.backup` copy taken 2026-09-27T08:11Z.
Scripts / raw output: `scratchpad/c1/c1.mjs`, `c1/c1-out.json` (full session ids + every name list), `c1/ruler-dump.json`, `c1/spot.mjs`.

## Population
- All 9 project dirs under `~/.claude/projects/`, session-level `*.jsonl` only (the ruler's walk; sidechains excluded, `mainOnly`).
- Window requested: session start >= 2026-08-28T08:10Z (30 days). **Effective**: 211 transcripts on disk, ALL inside the window; 153 injection-bearing sessions, starts 2026-09-05T19:30Z → 2026-09-27T08:05Z. So "last 30 days" = "every retained transcript", ~22 days wide. Nothing was cut by the window.
- Unit A = (injection event, id): one id in one hook attachment. Unit B = (session, id): the ruler's caliber (one id counts once per session per face).

## Premise assertion vs the ruler (`benchmark/citation-live-replay.mjs --since 2026-08-28T08:10:00Z --by-project --json --dump`)
- Loader = shipped `extractInjectedBySurface(path,{mainOnly:true})` + per-attachment attribution by running the SAME shipped extractor on a one-entry copy of each hook attachment (no re-typed matcher).
- Premise A: per-attachment union == shipped per-session set, every session x face: **0 mismatches**.
- Premise B: shipped per-session sets == ruler `--dump` records, every session x face: **0 mismatches**.
- Totals equal the ruler's printed per-face pairs: error_recall **693**, pretool **259**, fyi 237, ups 68 (ruler: 211 transcripts, 153 injection-bearing sessions). This project (ruler `by_project`): error_recall 318, pretool 120.

### Premise DISAGREEMENT found (stop-and-explain): the error_recall matcher is blind to PostToolUseFailure
- `lib/citation-tracker.mjs:746-747`: `accepts: ({command,text}) => command.includes('post-tool-use') && text.includes('Related memories found for this error')`.
- PostToolUseFailure's command is `hook.mjs post-tool-failure` (`hooks/hooks.json:93`), which does not contain `post-tool-use`. Wired in v3.79.0 (ca3973c).
- Measured: 158 attachments / 389 (injection,id) events delivered as `PostToolUseFailure:Bash` with the error-recall header are invisible to the shipped extractor; 665 attachments / 1699 events via `PostToolUse:Bash` are seen.
- `hook.mjs:1064` (at HEAD 209a8bd; the working tree has uncommitted edits to hook.mjs by another agent, shifting it +1) states the intent is ONE error_recall surface covering both ("these are the same injections to the model"). So the ruler (and, by the same extractor, Stop-side citation decay / citation_surface_log, since `DECAY_EXCLUDED_SURFACES` is empty at :1047) undercounts error_recall. Not fixed (read-only task; adjacent defect, needs its own AUTH).
- I therefore report error_recall at TWO calibers: **shipped** (= ruler, 693 pairs) and **wide** (same shipped collector, only the command gate relaxed to admit `post-tool-failure`: 813 pairs). Wide adds 120 (session,id) pairs / 10 sessions. The downstream impact (decay, the 2026-09-01 error-recall A/B after-arm) was NOT measured.

## Step 1 — denominators (decidable = a later action exists in the same session)
"Later" = a main-thread tool_use after the CARRIER tool call (the attachment's `toolUseID`), excluding calls in the same assistant message as the carrier (issued before the hook output could be seen). Carrier found for 100% of attachments.

| Surface | Scope | (inj,id) events | decidable events | (session,id) pairs | **decidable pairs** | sessions |
|---|---|---|---|---|---|---|
| error_recall shipped | all | 1699 | 1699 | 693 | **693** | 113 |
| error_recall shipped | claude-mem-lite | 800 | 800 | 318 | **318** | 34 |
| error_recall wide | all | 2088 | 2088 | 813 | **813** | 123 |
| error_recall wide | claude-mem-lite | 905 | 905 | 362 | **362** | 35 |
| pretool | all | 308 | 197 | 259 | **173** | 91 (74 decidable) |
| pretool | claude-mem-lite | 129 | 76 | 120 | **71** | 33 (26 decidable) |

- error_recall decidability (>=1 later Bash call) is 100%: minimum later-Bash count per event is 2 (wide) / 3 (shipped). The step-1 definition is therefore non-binding on this surface; what binds is below.
- pretool carriers (by (inj,id) events): Read 154, Edit 149, Bash 5 (Bash carriers have no file F -> never decidable). Decidable events by carrier: Read 105, Edit 92.
- pretool: of 173 decidable pairs, **127 have a lesson with ZERO identifiers** under `extractIdents(lesson_learned + ' ' + title)` (the text `scripts/pre-tool-recall.js` hands `presentIdents` at :939), so the signal can never fire on them. Effective denominator **46** (this project: 20 of 71). 0 ids gone from the DB. Zero-ident ids (all projects): 14,16,17,26,53,54,56,62,64,65,68,69,71,73,76,77,86,87,91,94,100,108,126,127,128,130,131,132,134,135,136,137,146,147,153,157,159,161,164,167,171,175,185,208,289.

## Step 2 — error_recall (the only surface over ~200)
Signal as specified (per injection event, rolled up to (session,id) = positive if ANY decidable event is positive):
- sig = `extractErrorSignature(carrier tool_result text)`; no-recur = sig != null AND none of the next N later Bash results has the same `.signature`;
- laterOk = a later Bash call with the exact same trimmed command whose result is not `is_error` and not `Exit code [1-9]`;
- new = no-recur AND laterOk. #NN = id in `extractCitationsFromTranscript(path,{mainOnly:true})` (the ruler's hit set).

Contingency, (session,id), N=5 (N=3 and N=10 give the identical table):

| caliber / scope | both | only new | only #NN | neither | total |
|---|---|---|---|---|---|
| wide / all | 3 | 8 | 91 | 711 | 813 |
| shipped / all | 3 | 8 | 85 | 597 | 693 |
| wide / claude-mem-lite | 3 | 8 | 32 | 319 | 362 |
| shipped / claude-mem-lite | 3 | 8 | 29 | 278 | 318 |

Why the new signal almost never fires (event level, wide/all, 2088 events):
- **1699/2088 (81.4%) carriers are PostToolUse = the host judged the command SUCCESSFUL** (`carrierIsError` 0/1699); the "error" is output vocabulary (typically `cmd 2>&1 | tail`). "Same command later exits 0" is not a fix signal there — a piped command exits 0 both times.
- On the 389 genuine-failure events (PostToolUseFailure, is_error 389/389): `extractErrorSignature` returns null on **317/389 (81.5%)**, laterOk **0/389**. The recurrence clause is undecidable on most real failures.
- laterOk overall: 23/2088 events. Signature present: 1190/2088.
- Can the ruler say NO: yes on both clauses — recurrence within N fired on 41/45/48 sig events (N=3/5/10); laterOk true 23 / false 2065.

Name list — **only new (8)**, all this repo, 3 sessions (full ids in c1-out.json):
claude-mem-lite/4894b5a2 #54 (events=15); claude-mem-lite/4894b5a2 #86 (events=8); claude-mem-lite/4894b5a2 #78 (events=8); claude-mem-lite/5c215fa5 #64 (events=3); claude-mem-lite/5c215fa5 #246 (events=3); claude-mem-lite/5c215fa5 #297 (events=4); claude-mem-lite/7df8e501 #45 (events=11); claude-mem-lite/7df8e501 #54 (events=10)
Spot-checked every one (`c1/spot.mjs`): each is a TDD RED->GREEN re-run of a vitest command (carrier exited 0, printed an AssertionError, same command later green). All 2-3 ids of the same block get credit for one event, and the credited lessons are unrelated to the test fixed: e.g. 4894b5a2 #54 "branch -d refuses when the release commit reached origin only via main" credited for a `cli-inert-filter-flag.test.mjs` AssertionError; 7df8e501 #45 "Search's reported total…" credited for `doctor-skew-does-not-write.test.mjs`; 5c215fa5 #297 "Inherited GIT_DIR from pre-commit…" credited for `bash-file-targets.test.mjs`. This is the RoMeRL memory-reward trap the proposal itself cites, observed 8/8.

Name list — **only #NN (91, wide; [F] = reachable only at the wide caliber, i.e. injected via PostToolUseFailure)**:
claude-mem-lite/009f7c5f #87; claude-mem-lite/009f7c5f #86 [F]; claude-mem-lite/009f7c5f #77 [F]; claude-mem-lite/009f7c5f #91; claude-mem-lite/1de4d7bd #56; claude-mem-lite/1de4d7bd #62; claude-mem-lite/2374d9cc #62; claude-mem-lite/2b8c95d0 #86; claude-mem-lite/4894b5a2 #56; claude-mem-lite/4894b5a2 #62; claude-mem-lite/567e5e92 #48; claude-mem-lite/672427d4 #64; claude-mem-lite/672427d4 #100; claude-mem-lite/72b4504d #270; claude-mem-lite/7df8e501 #62; claude-mem-lite/89f39afa #202 [F]; claude-mem-lite/89f39afa #204; claude-mem-lite/89f39afa #109; claude-mem-lite/89f39afa #185; claude-mem-lite/89f39afa #219; claude-mem-lite/9bc9a9aa #204; claude-mem-lite/c1d0431d #297; claude-mem-lite/c3c64219 #54; claude-mem-lite/c3c64219 #230; claude-mem-lite/c3c64219 #83; claude-mem-lite/c3c64219 #239; claude-mem-lite/cac51b05 #190; claude-mem-lite/cac51b05 #189; claude-mem-lite/cbe1121a #54; claude-mem-lite/ddf6e5a5 #228; claude-mem-lite/e30aad1b #247; claude-mem-lite/f5631b1b #98; claudemd/65386fc7 #17; claudemd/65386fc7 #16; claudemd/76c0dd09 #108; claudemd/9ad4f38d #191; claudemd/a5da7a96 #258; claudemd/d297f55e #229; claudemd/e0c872b6 #17; code-graph-mcp/25aa7dbe #33; code-graph-mcp/2600b2b7 #68; code-graph-mcp/31be98e6 #14; code-graph-mcp/3f95a4b8 #5; code-graph-mcp/4d46ebcb #27; code-graph-mcp/4d46ebcb #14; code-graph-mcp/4d46ebcb #47; code-graph-mcp/6f8ffc74 #68; code-graph-mcp/6f8ffc74 #7; code-graph-mcp/81ca9f9d #71; code-graph-mcp/84e689ab #47; code-graph-mcp/996f139e #68; code-graph-mcp/a2dd1df6 #47; code-graph-mcp/a5ac828f #27; code-graph-mcp/c8de22cc #14; code-graph-mcp/f4e6573a #27; code-graph-mcp/fd12bba0 #27; code-graph-mcp/fd12bba0 #28; code-graph-mcp/fd12bba0 #33; daagu/0e8b7d6f #180; daagu/698bf7f6 #158; gsd-lite/102e156a #128; gsd-lite/21a08cd8 #128; gsd-lite/21a08cd8 #161; gsd-lite/7e1c22aa #155; gsd-lite/7e1c22aa #167; gsd-lite/7e1c22aa #171; gsd-lite/7e1c22aa #176; gsd-lite/8c507c28 #128; gsd-lite/8c507c28 #159; gsd-lite/8c507c28 #155; gsd-lite/8c507c28 #157; gsd-lite/8c507c28 #153; gsd-lite/993f4ca4 #167; gsd-lite/993f4ca4 #157; gsd-lite/b88a17e3 #128; gsd-lite/c2cf166e #128; gsd-lite/f69589ec #128; loop-eng/06267a8a #134; loop-eng/8a51eeb4 #134; loop-eng/8a51eeb4 #135; loop-eng/8a51eeb4 #137; loop-eng/a51e73d1 #132 [F]; loop-eng/a51e73d1 #134 [F]; loop-eng/e0172ef5 #134 [F]; loop-testing/02de1c34 #146; loop-testing/4760861b #162; loop-testing/4760861b #131; loop-testing/4760861b #129; loop-testing/4760861b #160; loop-testing/4760861b #136; loop-testing/ff040444 #146

Variant (NOT the proposal's definition, for diagnosis): no-recur alone, N=5, wide/all: both 61 / only-new 427 / only-#NN 33 / neither 292 — fires on 488/813 (60%), the "crediting success reinforces whatever surfaced" failure tool-engrams warns about.

## Step 2 — pretool (informational only; below threshold, not a verdict input)
Any lesson identifier present in the next Edit/Write's new text: both 4 / only new **0** / only #NN 89 / neither 80 (173 decidable pairs). "Introduced" variant (in new_string, not in old_string): both 3 / only new 0 / only #NN 90 / neither 80.

## Ranking path per surface (does a new multiplier reach it?)
- The eight-factor chain in production is `FULL_SCORE`, `search-engine.mjs:43` (bm25 x decay x type x project x importance x access x lesson x noise x cite). `MULT_EXPR` is its benchmark twin, `benchmark/benchmark.mjs:217` — not a production identifier.
- **error_recall: its own `OBS_BM25 x recencyDecay` with a fixed 14-day half-life**, `ORDER BY` at `lib/error-recall-core.mjs:173` (half-life rationale :116-118), then the error-first rerank inside `selectErrorRecall` (:242). Reads no cite / importance / noise / access column. A multiplier added to FULL_SCORE / MULT_EXPR does NOT reach this surface.
- **pretool: lexicographic sort, not a product**: lesson-present first, then `citeFactorClause('o') DESC`, `created_at_epoch DESC`, `id DESC` (`scripts/pre-tool-recall.js:704-708`; `citeFactorClause` imported at :23). A FULL_SCORE multiplier does NOT reach it; a new factor would have to be added to that ORDER BY explicitly, where it acts as a tiebreak-order key, not a bounded multiplier.
- Consequence for C1's design ("juxtapose with the cite coefficient in MULT_EXPR"): neither of the two surfaces whose signals it proposes would have its own ranking changed by that edit.

## Verdict per surface (threshold ~200 decidable pairs)
- **error_recall: denominator PASSES** (693 shipped / 813 wide, all projects; 318 / 362 this repo). **Signal as specified: do not build** — it fires on 11/813 pairs (1.4%), agrees with #NN on 3, and its 8 off-diagonal positives are 8/8 multi-id credit for unrelated lessons. Separately, the surface's ranking does not read MULT_EXPR/FULL_SCORE.
- **pretool: do not build** — 173 decidable pairs (197 events) all projects, 71 (76) this repo, under ~200; effective denominator 46 because 127/173 lessons carry no extractable identifier; the signal produced 0 only-new pairs.
- Adjacent defect for the lead: error_recall matcher misses PostToolUseFailure (lib/citation-tracker.mjs:747 vs hooks/hooks.json:93) — 389 events / 120 extra pairs in this window.

## NOT CHECKED
- Edits made through Bash (sed/heredoc/python) are invisible to the pretool decidability test; so are edits to F under a different path spelling (exact `file_path` string match).
- Sidechain (subagent) transcripts: excluded, same as the ruler's attachment faces.
- The 8-char session prefixes in this report are not asserted unique; c1-out.json carries full ids.
- "Same command" is exact trimmed-string equality; a looser match (normalised flags, same test file) was not tried.
- #NN is session-level (cited anywhere in the main thread, before or after the injection), as the ruler defines it; a positional "cited after injection" caliber was not computed.
- Downstream effect of the PostToolUseFailure blindness on citation decay, citation_surface_log and the settled 2026-09-01 error-recall A/B.
- Causality: all of this is correlation; no counterfactual arm.
- ups / fyi / task_imperative / keyctx / subagent faces: out of scope.
