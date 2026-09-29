> Claims review of docs/audits/20260926-154904-session-history-analysis-r2.md, written by an independent reviewer subagent in the analysing session (a14ae020) and copied here verbatim on 2026-09-26.

Tally: TRUE 63 · FALSE 6 · MISLEADING 3 · UNVERIFIABLE 2   (74 rows)

# Claims review: docs/audits/20260926-154904-session-history-analysis-r2.md

Reviewer: independent claims lens, read-only. Reviewed 2026-09-26 ~16:10Z against `main` @ 042aea0.
Population: main transcripts in ~/.claude/projects/-home-ai-dev-claude-mem-lite/*.jsonl excluding a14ae020-* (60 files),
subagents <sid>/subagents/*.jsonl excluding a14ae020 (108), DB = scratchpad snap.db (read-only), git/gh read-only.
Independent scripts (not the author's analyze.mjs): scratchpad/cr-an.mjs (main transcripts), cr-sub.mjs (subagents),
cr-bash.mjs (Bash read/write heuristic variants), cr-probe.mjs (extractFilePaths), plus inline node/sqlite queries.
Re-derived independently (not read from metrics.json): file/session counts, active hours, tool counts, tool errors,
context percentiles, cost sum/median/max, pretool injections, error-recall pre/post/post-fix + cd split, git-commit timing
and pre-commit verdicts, hook latencies, language split, subagent counts/English/worktree rejections, DB events stats,
the extractFilePaths probe, the tiebreak site scan, CI conclusions, and the citation replay (re-run).

## FALSE

| # | Section | Claim | Verdict | Evidence | Corrected statement |
|---|---|---|---|---|---|
| F1 | §2.2 | "每个版本都派出 3 个评审子代理 … 后段共 15 个" | FALSE | cr-sub.mjs lists every subagent whose first record is after the split: 19, all reviews. v6.13.0 3 (claims/defect/delta-lens-v6130), v6.13.1 0, v6.13.2 3, v6.13.3 3, v6.13.4 3, v6.13.5 **4** (general-purpose: "Claims review of c12cf88", "Defect review of c12cf88", "Delta review of 9ee49d3", "Third review of d4b3d73" in 72b4504d), v6.13.6 3. 19 = all post-split Agent calls (tool count Agent post = 19). | "后段共 19 个评审子代理：v6.13.1 没有评审，v6.13.5 派了 4 个（general-purpose，未用 *-lens 命名），其余每版 3 个。15 只是以 *-lens-* 命名的那部分。" |
| F2 | §2.2 | "此前每个版本都有对应的 `docs(audits)` 提交，这两个版本的审计轨迹中断了" | FALSE (first half) | `ls docs/audits` has no report for v6.10.3, v6.12.0, v6.12.1, v6.13.1. `git log -- docs/audits` since 09-20: v6.13.3/v6.13.4 reports landed in `54aee99`/`dfabb14`/`033bea2`/`2b9c55d` ("fix: repair …"), not `docs(audits)` commits. The v6.13.5/v6.13.6 absence itself is TRUE (grep count 0 for both). | "v6.13.5、v6.13.6 的评审报告没有落进 docs/audits/；在此之前也有未落盘的版本（v6.12.0、v6.12.1、v6.13.1），并且 v6.13.3/4 的报告是随 repair 提交一起落盘的。" |
| F3 | §3 row "等 CI 改为后台监视" | "后段 `sleep` 只用了 2 次" | FALSE | Scan of post-split Bash tool_use for `(^|&&|;)\s*sleep\s+\d`: **15 calls, all foreground** — e.g. c3c64219 05:21 `sleep 20; SHA=…; gh api …`, a28e223e 08:34/09:27 `… sleep 30; done` polling loops, 72b4504d 10:25 `sleep 200; grep …`, 13:41 `sleep 120; …`, 8b475d66 15:29 `sleep 20; … gh api`, 15:35 `sleep 60; npm view …`. The "2" is the author's bashCat bucket (regex `^\s*sleep\s|&&\s*sleep\s\d`, applied after the gh/vitest buckets), which misses the `; sleep` form. | "后段仍有 15 次前台 `sleep`（20–200 s，多数是等 CI/Release 或 npm 可见性的轮询），外加一次前台 `gh run watch` 4.3 分钟；该建议基本未落实。" |
| F4 | §4.2 (and §0 N2 "这 5 次全是 TDD 刻意制造的 RED"; §7 R5 "修复后 5/5 都是刻意 RED") | "修复部署后 5 次触发 (`8b475d66`, 14:04–15:02)：都是 `npx vitest run … -t 'P3-6' \| grep …` … 5 次全是刚写好测试、故意先看到 RED 的 TDD 步骤。注入的记忆是 #64/#246/#45 等" | FALSE | Post-FIX (≥13:51:03Z) error-recall injections, with toolUseID → command: (1) **13:54:26 PostToolUseFailure:Bash**, `echo "API=…"; cd … && cat > …/scratchpad/llm-lat.mjs <<EOF … node` → `Exit code 1 … SyntaxError: … does not provide an export named 'callLLM'` (a scratch latency probe, not a test, not TDD; injected #77/#112); (2) 14:04:13 `cat >> tests/fast-summary.test.mjs <<'EOF' …` chained to a vitest run, 3× failed (injected #225/#279/#218); (3) 14:04:43 `vitest … hook-llm.test.mjs -t 'P3-6' \| grep`; (4) 14:04:56 `vitest … e2e.test.mjs -t 'P3-6' \| grep`; (5) 15:02:29 `vitest … e2e.test.mjs -t 'exit-restart fallback' \| grep`. #64/#246/#45 were injected only on (3)(4)(5). All 5 are real failures (TRUE part). | "修复部署后 5 次触发（13:54–15:02）都是真实失败：4 次是新写测试的 RED（其中 2 次是 `-t 'P3-6' \| grep`），1 次是 scratchpad 探针脚本的 SyntaxError（exit 1，经 PostToolUseFailure）。注入的记忆与当下失败都无关（3 次为 #64/#246/#45）。" |
| F5 | §4.6 | "列出的'最后修改'其实是按字母排序后的结果，这正是 claudemd 自己的 D#96 L1" | FALSE | tasks/session-end-8b475d66-paused.md lists, in order: `Bash: …/package-lock.json`, `Bash: …/CHANGELOG.md`, `Edit: …/memory/project-claude-mem-lite-release-runbook.md`. That is not sorted under any usual collation (CHANGELOG < package-lock; /home/ai/.claude < /home/ai/dev). It **is** the chronological order in the 8b475d66 transcript: 15:26:13 `sed -i … package.json && node cli.mjs release …` (rewrites package-lock), 15:26:42 `python3 - … CHANGELOG.md`, 15:37:13 Edit of the runbook memory. The rest of §4.6 holds (release commit 15:27:54, CI+Release success, HEAD = origin/main = 042aea0 tagged v6.13.6; only post-release mutation is the memory Edit). D#96 L1 text is quoted correctly from snap.db. | "列出的三项是按时间顺序的最后三次修改，前两项被 15:27 的 vitest 与 release 提交覆盖；检查点真正的误报原因是把发版后对记忆文件的一次 Edit 当成了需要 VALIDATE 的 mutation。本例与 D#96 L1（字母序）无关。" |
| F6 | §5.5 | "code-graph 的 PreToolUse:Bash hook 输出了非法 JSON，共 5 次（前段 4 次，后段 1 次）" | FALSE | `hook_non_blocking_error` attachments containing "not valid JSON" (excl. a14ae020): 27243972 09-08, 34baa617 09-06, 89f39afa 09-25 14:23, e30aad1b 09-26 06:46 — all `code-graph-mcp/…/scripts/pre-grep-guide.js`. The author's metrics.json hookNB key (not split by period) also reads 4. | "共 4 次（前段 3 次，后段 1 次）。" |

## TRUE-BUT-MISLEADING

| # | Section | Claim | Verdict | Evidence | Corrected statement |
|---|---|---|---|---|---|
| M1 | §0 N1 and §7 R2 | "分界点前 168 对（51 个会话），之后只有 5 对（4 个会话）" / "pretool 对数从 168 降到 5" | MISLEADING | Re-run replay: pretool before = 168 pairs / 51 sessions, after = 5 / 4 (numbers exact). But the arms cover **~13.8 days** (09-12T00:00 → 09-25T20:09) vs **~19.5 h**, so 168→5 (34×) overstates the drop. §4.1 does normalise it (error_recall 105 pairs / 13 sessions in the same arm); §0 and R2 quote the raw pair counts without the window. Normalised: pretool/error_recall pairs 168/384 = 0.44 → 5/105 = 0.048 (≈9×); main-session pretool injections per active hour 8.8 → 1.75 (5×). | "按同臂 error_recall 对数归一，pretool 占比从 0.44 降到 0.05（约 9 倍）；主会话每活跃小时注入从 8.8 次降到 1.75 次。" |
| M2 | §3 row B1 | "逐条读输出，5/5 都是真实的测试失败" | MISLEADING | See F4: 5/5 are real failures, 4/5 are test failures; one is a scratch-script SyntaxError (exit 1). | "5/5 都是真实失败（4 次测试失败、1 次探针脚本报错）" |
| M3 | §3 row "上下文约 30 万时主动 /clear" | "后段会话 1.3–4.3 h" | MISLEADING | Per post session, wall-clock span / active (<30 min gaps): c3c64219 10.2 / 2.8 h (7.4 h idle gap after 21:50), 72b4504d 4.3 / 3.7, a28e223e 2.0 / 2.0, 8b475d66 1.8 / 1.8, e30aad1b 1.3 / 1.3. The quoted range mixes span (4.3) with a range that silently drops c3c64219's 10.2 h span. | "后段会话跨度 1.3–10.2 h、活跃时长 1.3–3.7 h" |

## UNVERIFIABLE

| # | Section | Claim | Verdict | Evidence |
|---|---|---|---|---|
| U1 | §0 N1, §4.1 table | Opus 5: Edit/Write 1,970 vs Bash-write 1,271 (60.8%), Read 852 vs Bash-read 842 (50.3%); Opus 5.5: 114 vs 520 (18.0%), 67 vs 389 (14.7%) | UNVERIFIABLE (exact counts); magnitude TRUE | The heuristic's code is not in scratchpad analyze.mjs/survey.mjs, so the exact counts cannot be re-run. Tool-side counts reproduce exactly (Edit+Write 1,970 / 114; Read 852 / 67). My implementation of the §1 regex list (cr-bash.mjs) gives Bash-write 884–1,481 (Opus 5) / 298–585 (Opus 5.5) depending on how the /tmp-scratchpad exclusion is applied, and Bash-read 756 / 381 (command-start caliber with `cd …&&|;` prefix). With write "exclude if /tmp or scratchpad on line 1" + read-start: Opus 5 60.4% / 53.0%, Opus 5.5 23.6% / 15.0%. The doc's numbers fall inside my ranges and the 3×–4× contrast holds under every variant. The arithmetic in the table is internally consistent. The table omits claude-fable-5-1 (11 Edit/Write, 7 Read), which is immaterial. |
| U2 | §0 N1, §4.1 events table, §7 R1 | "只有仓库根" column 13/26/65/29 and "无真实文件边" 31.0% (09-21/22) → 62.4% (09-25/26) | UNVERIFIABLE (caliber undefined); direction TRUE | snap.db, project dev--claude-mem-lite, UTC dates: events 74/81/117/85 and "无文件" 3/6/5/27 reproduce exactly. "只有仓库根" is not defined and not in the saved scripts: strict "every path == repo root" gives 8/15/49/27 → 20.6% → 53.5%; "root present and no real repo file" gives 10/22/64/32 → 26.5% → 47.5%; "no real repo file at all" gives 49.7% → 74.8%. The rise holds under every caliber, but its size ranges from 1.5× to 2.6×; 31.0/62.4 is one caliber among these. |

## TRUE

| # | Section | Claim (brief) | Evidence |
|---|---|---|---|
| T1 | header | plugin 6.13.5 installed 13:51:03Z | installed_plugins.json: version 6.13.5, lastUpdated 2026-09-26T13:51:03.834Z; cache dir 6.13.5 mtime 13:51:03.89 |
| T2 | §1 | 61 files, 60 after excluding a14ae020, 55 non-empty; 108 subagent transcripts | readdirSync: 61 / 60; 55 with ≥1 usage-bearing assistant record; 108 subagent jsonl in 35 sessions |
| T3 | §2.1 | active 85.0 h / 11.4 h | cr-an.mjs (gaps <30 min): 85.0 / 11.4 |
| T4 | §2.1 | API requests 11,594 / 991 | mine 11,590 / 990 excluding `<synthetic>` records; author's caliber includes the 5 synthetic API-error records |
| T5 | §2.1 | tool calls pre Bash 9,158 · Edit 1,798 · Read 909 · Write 273 · Agent 86 · AUQ 40 · SendMessage 35; post Bash 922 · Agent 19 · Edit 19 · Read 17 · Write 5 · AUQ 3 | exact (unique tool_use ids) |
| T6 | §2.1 | tool errors 275 (Bash 255, Edit 17) / 12 (all Bash) | exact (255+17+1+1+1; 12) |
| T7 | §2.1 | context P50/P90/max 295k/525k/692k vs 272k/397k/500k; >300k 48.8% / 41.2% | 295,336/525,163/691,560; 272,156/396,691/500,007; 0.488/0.412 |
| T8 | §2.1 | manual compacts 4 / 1 (c3c64219, 420k) | compact_boundary: 4894b5a2 ×2, 89f39afa, cac51b05; c3c64219 20:38 manual preTokens 420,572 |
| T9 | §2.1 | output 11.65M, cache read 3.88B; subagents cache read 1.02B, output 0.58M | 11,650,217 / 3.88B; subagents 1.02B / 0.58M |
| T10 | §2.1 | cost $3,048.32, median $42.72, max $192.62 (4894b5a2, 5.4 h) | exact |
| T11 | §2.1 | post 5 sessions $176.5 | 42.72+24.70+28.17+54.54+26.35 = 176.49 (c3c64219 includes its 14 pre-split minutes) |
| T12 | §2.2 | 09-06 10 releases (period max), 09-26 7 (v6.13.0–v6.13.6) | tag creatordate ≥09-05 per UTC day: 09-06 10, 09-26 7 |
| T13 | §0/§2.2 | 45 post-split commits, 19 titles with review/correct | `git log --since=2026-09-25T20:09:12Z` → 45; grep -Eic 'review\|correct' → 19 |
| T14 | §2.2 | claims-lens tallies 6/53, 9/52, 3/25, 0, 1/20 (+3 MISLEADING) | Tally lines in the five reports: 45T/6F/2U; 38T/9F/5U; 21T/3F/1U; "FALSE: 0"; 16T/1F/3M/0U |
| T15 | §2.2 | reviewer runtime medians ~14–17 min | per lens over the 15 *-lens agents: claims 15.3, defect 14.7, delta 14.5 min (one delta 450.8 min outlier) |
| T16 | §2.2 | v6.13.5/v6.13.6 reports absent from docs/audits | `ls docs/audits \| grep -c v6.13.5` = 0, v6.13.6 = 0 |
| T17 | §2.3 | 214 user messages; 继续 50, ship 56, 剩余/有价值 43, 按建议 18, Not-done pastes 10 | mine (200-char truncation, slightly different filter): 224 real; 44 / 55 / 42 / 18 / 10 — within filter caliber |
| T18 | §2.3 | 14 post-split user messages, mostly 继续/推送发版/Not done | listed all 14 (incl. `/compact`, one API-error recovery "前面api出错了") |
| T19 | §0/§3 | R1 had 4 P1s (B1, B2, Key Events, pre-commit reuse) | R1 §6 table rows 267–270 |
| T20 | §3 | B1 = 68b44cd (+c25e376 heredoc/comments/writing verbs) | git log titles; tags v6.13.0 / v6.13.2 |
| T21 | §3 | post-fix error-recall 5, cd-prefixed 0; pre 167/262 | cr-an.mjs: pre 262 (cd 167), post-fix 5 (cd 0) |
| T22 | §3 | B2 = 00effdc then e7c064e, 7c0d6f7, a04f292 | git log titles (dismissal/applied; adjective-before-noun) |
| T23 | §3 | B4: 4 of 5 post SessionStarts still had Key Events; 8b475d66 did not; D#69 open | c3c64219 20:38, e30aad1b 06:10, a28e223e 07:29, 72b4504d 09:34 → KE true; 8b475d66 13:51:14 → false; snap.db D#69 status open |
| T24 | §3 | B3 = a6a28c0 | git log |
| T25 | §3 | pre-commit: 42 commits after 8d374b1 (1 error), 25 readable: REUSE 8, tree differs 8, no green stamp 8, unstaged 1; 16 unreadable; reuse ≈12 s | exact; reuse durations 11.8–16.9 s |
| T26 | §3/§5.4 | git commit n=50, median 52.2 s, P90 71.8 s, 0.67 h | 50 / 52.21 / 71.80 / 0.67 |
| T27 | §3/§5.2 | MEMORY.md 28,753 B (R1 28,635); ~/.claude/CLAUDE.md 24,994; CLAUDE.md 20,404; first-request context 75–77k | wc -c; R1 line 83; first request: e30aad1b 75k, a28e223e 75k, 72b4504d 77k, 8b475d66 77k |
| T28 | §3 | `[mem] episode flushed` injected 7× after fix | 7 |
| T29 | §3/§6 | ssr dirs 0 now (R1: 60 / 156 MB) | `ls -d /tmp/*/ssr \| wc -l` = 0; R1 line 150 |
| T30 | §3 | foreground `gh run watch` 15:29:57 → ~15:34 in 8b475d66 | tool_use 15:29:57.154, tool_result 15:34:14.780 (4.3 min) |
| T31 | §3/§6 | §8 rm -rf denies 72 / 2; code-graph denies 53 / 0; 0.85 → 0.18 /h | §8 denies mentioning `rm`: 72 pre / 2 post; code-graph 53 / 0; 72/85.0, 2/11.4 |
| T32 | §3/§5.3 | subagent final reports 96/108 English | cr-sub.mjs: en 96, zh 12 |
| T33 | §4.1 | post sessions all Opus 5.5; 72b4504d 1 Edit, ~69 Bash writes; a28e223e, e30aad1b 0 Edit/Write | models: all claude-opus-5-5; 72b4504d Edit 1 Write 0, Bash-write 58–72 by caliber; a28e223e/e30aad1b Edit 0 Write 0 |
| T34 | §4.1 | PreToolUse matchers `Edit\|Write\|NotebookEdit\|Read` and `Agent\|Task`, no Bash | hooks/hooks.json |
| T35 | §4.1 | pretool injections 745 / 20; 8.8 / 1.75 per active hour | exact |
| T36 | §4.1 | replay pretool 168 pairs/51 sessions → 5/4; error_recall post arm 105 / 13 | re-run: 168/51 → 5/4; error_recall post 113 / 13 (+8 pairs = corpus growth, incl. the analysis session and this review) |
| T37 | §4.1 | pretool pre-arm 41.7% [34.5, 49.2], highest; others 9.1–15.5% | re-run pre arm: pretool 41.7% [34.5, 49.2]; error_recall 15.1, fyi 15.5, ups 9.1 |
| T38 | §4.1 | extractFilePaths probe: 5 of 6 shapes yield no target file; cd-prefix yields repo root only; perl -0pi absolute path works; regex `(?:^\|\s)(\/[\w./-]+\w)`; bash-utils.mjs:895 | cr-probe.mjs on HEAD: [] [] [] [] ["/home/ai/dev/claude-mem-lite"] ["…/cli.mjs"]; line 895 is `export function extractFilePaths` |
| T39 | §4.2 | analysis session: 3 exit-0 false triggers (#239/#112/#109, #109/#66/#228, #234/#225/#219) + 1 real (ruler self-check via `\| tail`) | a14ae020 attachments at 15:46:47, 15:47:18, 15:49:14 (is_error false); 15:44:35 = citation-live-replay `--project` self-check throw piped to `tail -40` |
| T40 | §4.2 | hook.mjs:715 comment records the self-recursion (hint contains 'error') | hook.mjs:714–719 |
| T41 | §0/§4.2 | error_recall 12.5% [9.8, 15.7] (61/489); post 2.9% [1.0, 8.1] (3/105) | re-run: 12.3% [9.7, 15.5] 61/497; post 2.7% [0.9, 7.5] 3/113 — drift = new pairs from the still-running analysis session, not material |
| T42 | §4.3 | d06dc32 (D#67) in v6.13.2; 8876cc4 in v6.13.3 (release title "the resume summary picks the newest row"); 43571e3 (D#75, "six … reads") in v6.13.4 | `git tag --contains` first tag; bb47bbf release title |
| T43 | §4.3 | CLAUDE.md: "26 sites fixed; the rest unjudged, not cleared" | CLAUDE.md Retrieval bullet |
| T44 | §4.3 | ~24 production sites, distribution hook-handoff 8; timeline-core, activity, hook-context 2 each; 10 files ×1 | single-line grep over tracked .mjs/.js outside tests/benchmark/docs: 27 raw; 3 are SQL `--` comments (hook-optimize.mjs:205, :216; schema.mjs:807); remaining 24 match the stated distribution exactly |
| T45 | §4.3 | search-order-tiebreak quote; pre-tool-recall-tiebreak exists; no population-wide guard | tests/search-order-tiebreak.test.mjs:125 verbatim; no test combines walkShipped/readdirSync with `id DESC` |
| T46 | §4.4 | c12cf88, 9ee49d3, d4b3d73, 4106601 in v6.13.5; ee731ea, f92a656, eee0304 in v6.13.6; "7 修补提交" | tags confirmed; the 7 are the fix/docs(summary) commits (2 are primary fixes, 5 are review repairs) |
| T47 | §4.4 | memory #270 "writers built for one Stop per session"; D#95 open, 4 of 157; D#92 dropped with "premise overstated … no-obs" | snap.db observations 270 title; deferred_work 95 open, 92 dropped + drop_reason |
| T48 | §4.5 | 1,045 events; 107 scratchpad (10.2%); 43 node_modules (4.1%); 8 .claude/worktrees | sqlite: 1045 / 107 / 43 / 8 |
| T49 | §4.5 | bash-utils.mjs:897-899 "kept unconditionally" comment | exact lines |
| T50 | §4.6 | paused file content; release commit 15:27:54; CI+Release success; HEAD = origin, tagged | file read; `git log -1 origin/main` 042aea0 15:27:54Z; `git tag --points-at HEAD` v6.13.6; gh run list success ×2 |
| T51 | §4.6 | D#96 L1 = alphabetical `unique` in paused.md list (as a description of D#96) | snap.db D#96 detail (project dev--claudemd) |
| T52 | §0/§5.1/§6 | v6.13.0 CI and Release failed; v6.13.1 re-release; other 6 releases success | gh run list: 24162d6 CI failure, Release v6.13.0 failure (validate failure, publish skipped); ff62955 onward all success; npm has no 6.13.0 |
| T53 | §5.1 | failing case + assertion text (ANSI) | `gh run view --log-failed`: "FAIL tests/green-stamp.test.mjs > green-stamp reporter under a real vitest run > a full run stamps; an --exclude run does not"; "expected '\n\u001b[1m\u001b[30m\u001b[46m RUN \…' to match /Test Files\s+1 passed \(1\)/" |
| T54 | §5.1 | fix 57c5b08 at 05:27 "read the child vitest's output without colour"; v6.13.1 at 05:30 | commit 05:27:05Z; tag 05:30:04Z; body confirms CI forces colour, reproduced with FORCE_COLOR=1 |
| T55 | §5.1 | 2de4849 "interrupt the SIGINT case once the test body runs, not after 4 s" | git log (in v6.13.3) |
| T56 | §5.3 | last >200-char text English: opus-5 12/179, opus-5-5 13/51; post 12/12 Chinese | independent: exact same counts; post langFinal zh 12 |
| T57 | §5.3 | reply-language-check Stop hook blocked 5× in 72b4504d | hook_blocking_error attachments: 72b4504d reply-language-check.sh ×5, none elsewhere |
| T58 | §5.4 | vitest full 33 / 28.1 s / 65.7 s / 0.26 h; gh 30 / 21.4 / 262.9 / 0.61 h; lint/format 21 / 21.7 s | matches author's metrics.json bashCat under the §A.3 regex; not independently re-bucketed |
| T59 | §5.4 | 8 "tree differs" re-runs | = T25 |
| T60 | §5.5 | worktree-isolated agent rejections 15, quoted message | cr-sub.mjs: 15 tool_results containing "a worktree-isolated agent's git operations must target its own worktree" |
| T61 | §5.5 | API interruptions 3 / 1; user typed "前面api出错了，继续" | author's errCat: 2× "Connection lost" + 1× "stopped arriving" pre; 1 post; 72b4504d 12:31 message |
| T62 | §5.5 | Edit `old_string not found` 13 / 0 | author's precedence: 13; plain substring gives 15 pre (2 of them also hook-denied) / 0 post |
| T63 | §6 | hook latency table (Stop 326/155/215/763, P99 399; Read 493/61/77; Edit 272/55/67; UPS search 119/82; UPS user-prompt 74/129; SessionStart:startup 19/211); Stop P50 sum ≈0.44 s; PostToolUse:Bash 838 records, 4 empty, 114 ms | independent hook_success/stop_hook_summary grouping: identical n/P50/P90/max. Stop P50 sum 0.44 s without reply-language-check (ran 34 of 326 turns), 0.47 s with it. PostToolUse:Bash: 834 records (772 post-tool-use.sh + 62 code-graph post-grep-inject), 4 empty, post-tool-use.sh P50 114 ms — 834 vs 838 immaterial |

(T-rows count 63 because T59 re-uses T25's evidence as a separate claim.)

## Notes (context, not scored)

- R4 / §5.1 lesson: 8b475d66 already ran `CI=true FORCE_COLOR=3 npx vitest run tests/e2e.test.mjs tests/hook-llm.test.mjs tests/fast-summary.test.mjs …` at 15:27:17, before the v6.13.6 release commit at 15:27:54. So the "本地 CI 环境一臂" is already partly practised (targeted files, not the full suite). §3/§7 do not mention this.
- N2 corroboration: during this review the PostToolUse:Bash error-recall fired three times on my own exit-0, read-only commands: `gh run view --log-failed | grep` (#228/#64/#219), a `node -e` that printed transcript text containing "AssertionError" (#230), and another `node -e` printing tool results (#239/#45/#112). This is the same shape §4.2 describes.
- The citation replay scans all projects' transcripts, including the running analysis session (a14ae020) and its subagents. That is why error_recall pairs moved 489→497 and 105→113 between the author's run and mine.
