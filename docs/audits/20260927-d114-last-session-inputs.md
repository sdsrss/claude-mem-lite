> Copied verbatim from the session scratchpad on 2026-09-27 (read-only investigation of D#114 by a fresh subagent; live DB opened readonly). Spot-checked by the author after delivery: `events` has no session column (schema.mjs:788); the no-obs exit is hook-llm.mjs:1540 (cited below as :1538); a recount of DISTINCT non-`manual-*` memory_session_ids holding an observation since 2026-09-13T13:54Z gives **6**. The 11/203 below includes 5 `manual-*` sessions (mem_save rows); without them `sdk_sessions` also gives 6 (of 198) — corrected by the v6.17.1 claims review. Scratch scripts were not kept.

# D#114 — Last Session for a user who writes no Done/Not done report

Measured 2026-09-27 ~13:54Z, repo `main` @ 66679f7 (v6.17.0 tree), live DB
`~/.claude-mem-lite/claude-mem-lite.db` opened `{ readonly: true }`. Scripts and raw
outputs: this directory (`measure.mjs`→`measure.out`, `obs.mjs`, `events.mjs`,
`replay.mjs`→`replay.out`, `tails.mjs`). SD = scratchpad/d114.

## 1. Data path (Stop → row → SessionStart)

### Stop (fires once per assistant TURN)
- `hook.mjs:1714` handleStop → `:1729` flushEpisodeAtStop (foreground pre-save of the
  episode as an `observations` row via `saveEpisodeImmediate` `hook-llm.mjs:752`, plus a
  detached `llm-episode` worker) → `:1736` markSessionCompletedAndSaveHandoff (sets
  `sdk_sessions.completed_at_epoch` = this Stop, `hook.mjs:1225-1232`; writes the `exit`
  handoff) → `:1742` writeFastSummaryBaseline.
- `hook.mjs:1245-1292` writeFastSummaryBaseline: `extractTailAssistantText`
  (`lib/summary-extractor.mjs:113`, text of the LAST assistant entry) →
  `extractStructuredSummary` (`:139`) → report `{done, notDone, lines=Failed/Uncertain}`;
  `source = readFastSummarySource(db, sessionId)` (`lib/fast-summary.mjs:69-95`):
  `request` = first `user_prompts.prompt_text` (prompt_number ASC), `completed` = last 5
  `observations.title` for this session, `COALESCE(compressed_into,0)=0`, joined `; `.
- `lib/fast-summary.mjs:214-268` writeStopSummary, one row per session:
  - **report found (Done or Not done)**: `completed` = report Done (tag `donereport`),
    `remaining_items` = report Not done ('' = nothing left, `leftreport`), Failed/Uncertain
    lines appended to `notes` after the tag head.
  - **no report found**: first write INSERTs only if `request || titles` (`:224`);
    `completed` = titles (tag `donetitles`), `remaining_items` = '' (`leftother`),
    `next_steps`/`lessons`/`key_decisions` empty. Later turns: a `titles` row follows the
    current titles, but only `if (titles && …)` (`:249`) — so when the titles list becomes
    empty (observations deleted) the OLD titles stay. A later turn's report replaces
    Done/Not done; a later non-report turn never clears a report Done.
  - Truncation `FAST_SUMMARY_LIMITS.stop` (`:48`): request 200, completed 600, remaining 600.
- `hook.mjs:1762-1763` then spawns `llm-summary` (default ON again; D#95 opt-in reverted in
  ea4d795; `CLAUDE_MEM_SKIP_SUMMARY` disables).

### Model worker `handleLLMSummary` (`hook-llm.mjs:1440`)
- Waits up to CLAUDE_MEM_FLUSH_TIMEOUT (15 s) for pre-existing `ep-flush-*` files
  (`:1461-1494`), then `SELECT … FROM observations WHERE memory_session_id = ? AND
  notLowSignalTitle … LIMIT 30` (`:1523-1536`).
- **worker no-obs**: `recentObs.length < 1` → metric `no-obs`, nothing written (`:1538`).
  Prompts are read only AFTER this gate (`:1545-1555`), so a session with prompts but no
  observations gets no model call.
- **worker ran**: model sees user prompts (≤10, 300 chars each) + observation list;
  `mergeModelSummary` (`lib/fast-summary.mjs:363-432`): report Done/Not done kept; otherwise
  model's `completed` replaces titles (`donemodel`); model fills request/next_steps/
  lessons/key_decisions. Outcomes also `slot-timeout`, `superseded-before-call`,
  `superseded-at-write`, `no-content`, `error` (`:1504-1512`, `:1573-1663`).

### SessionStart
- **/clear or /compact** (`startSource` not startup/resume, `hook.mjs:2753-2764`):
  `saveHandoffAndFastSummary` (`hook.mjs:2254`) spawns `llm-summary` for the previous session
  WITHOUT a stopEpoch (`:2300-2302`), then `writeClearSummary` (`lib/fast-summary.mjs:281-322`)
  with request + titles + `remaining` = clear-handoff `unfinished` or, failing that,
  episode-snapshot error descs (`hook.mjs:2313-2323`); gate `fastRequestRaw || fastCompletedRaw`
  (`:2329`). It moves the row's timestamp to now.
- **startup/resume after /exit within 2 min, no row yet**: `buildFallbackFastSummary`
  (`hook.mjs:2400-2440`) INSERTs request + titles (limits exitRestart), legacy notes `fast`.
- Render: `buildSessionContextLines` (`hook-context.mjs:576`) reads the project's newest
  row (`:618-628`, `ORDER BY created_at_epoch DESC, id DESC`) → `buildSummaryLines`
  (`hook-context.mjs:935-958`): `Request:` / `Completed:` / `Remaining:` / `Next:` (120 chars
  each), `Lessons:` / `Decisions:` (first 3). Empty fields are omitted.
- The UserPromptSubmit continuation handoff (`hook.mjs:3044-3060` →
  `renderHandoffInjection` `hook-handoff.mjs:867`) embeds the same row as
  `<session-summary source="haiku|report|titles">` (`hook-handoff.mjs:1036-1072`, label from
  `summarySourceLabel` `lib/fast-summary.mjs:161`); legacy `fast`/NULL notes parse as
  titles/model (`:145-152`).

**Net, no report + worker no-obs**: Last Session = `Request: <first prompt, 120 chars>` and
nothing else (Completed only if a hook `change` observation survived, see §2).

## 2. The "episode upgrade-delete"
- `persistHaikuSummary` `hook-llm.mjs:513-545`: when the episode model classes the window as
  one of `EVENT_TYPES` (bugfix/lesson/bug/discovery/refactor/feature/observation/decision,
  `lib/activity.mjs:26`), it calls `retractPreSavedObs` (`hook-llm.mjs:84-102`, the `DELETE
  FROM observations` at `:100`) on the foreground pre-save and `saveEvent`s instead. Call site
  `hook-llm.mjs:1323-1334` ("upgrade-delete: obs → event").
- Second deleter: a `change` classified low-yield is dropped and its pre-save retracted
  (`hook-llm.mjs:1276-1291`, `isLowYieldChangeObs`).
- Only a non-low-yield `change` stays in `observations`. `events` has NO session column
  (`schema.mjs:788-803`; `saveEvent` `lib/activity.mjs:52-82` takes project/type/title/body/
  files/importance/time only).
- `mem_save` rows use a `manual-*` session id, never the hook session's id.
- Measured (obs.mjs): observations created in the last 14 days by session-id prefix:
  `hook-` 9, `manual-` 126; the 9 hook rows are all type `change`, across 6 sessions.

## 3. Measurements (live DB, readonly, window = created/started ≥ 2026-09-13T13:54Z)

(a) newest `session_summaries` row per session created in window (`node SD/measure.mjs`,
`node SD/obs.mjs`): **190 sessions: done-source titles 171, haiku 11, report 8**.
source × completed: titles-with-empty-completed **159**, titles-with-text 12, haiku 11,
report 8. Notes heads: legacy `fast` 151, `llm` 3, NULL 5, new-format 30.
By day: 09-13..09-25 report 0; 09-26 report 4/33; 09-27 report 4/11 (haiku 1, titles 6).
Caveat: the widened header parser shipped in v6.15.0 (2026-09-27T04:58Z, commits
44ad93e..a21bdf2); rows before that were written by a colon-only parser, so the DB report
share UNDER-states the current code. Population includes probe/sandbox projects
(projects--demo 16, scratchpad--* 17 rows, etc.).

(b) `sdk_sessions` started in window: **203**. ≥1 observation row: **11** (5.4%). ≥1 event
in same project within [start, lastStop+5 min]: **115** (56.7%; strict [start,lastStop]
95). Neither: 85. ≥1 user_prompt: 189. Summary row: 187. Sessions whose window overlaps
another same-project session: **55** (27%) — time-window event attribution is ambiguous
for them. Events in window by type: bugfix 1549, discovery 816, feature 478, refactor 185,
decision 20.

(c) `summary_worker` metric (`recordMetric` `lib/metrics.mjs:37` → `$DB_DIR/metrics/
YYYY-MM-DD.jsonl`, only with CLAUDE_MEM_METRICS=1). Command: `grep -c
'"event":"summary_worker"' ~/.claude-mem-lite/metrics/*.jsonl` + node tally. Only
**2026-09-27** has rows: **34 rows / 7 sessions, no-obs 28, written 6**. All 6 `written`
are ONE session (`hook-dev--claude-mem-lite-041bc5b2`, 12:xx–13:49Z), which holds the one
surviving hook `change` observation (`D#98 dismissal baseline…`). Per hour: 06-11Z
no-obs 24/24; 12Z written 3; 13Z written 3, no-obs 4. No earlier day recorded any row, so
there is no multi-day series.

(d) 20 most recent sessions (measure.mjs, tail of measure.out): simulated no-report fallback
= **Request only in 19/20**, Request + titles 1/20 (S#495, via that single `change` obs).
Current rows among the 20: report 6, haiku 2, titles 12 (the titles 12 already render
Request-only except where old titles or a model row filled Completed).
Simulation reads CURRENT observations; at Stop time a pre-save that was later deleted can
have been visible, and writeStopSummary keeps stale titles when the list empties (S#486
shows `Completed: SP=/tmp/… → ERROR: …`, a titles value from a since-deleted row). So the
real fallback is sometimes Request + a stale/raw pre-save title, never better.

Five examples verbatim (NOW → FALLBACK):
1. S#493 dev--claude-mem-lite, source=report
   NOW: Request: 处理一下github上的这些问题：https://github.com/sdsrss/claude-mem-lite/issues/35 …
        Completed: - **#35（更新后横幅仍提示有新版本）**：修复提交 `6494d48`，已 push …
        Remaining: - 还没发版，#35 的修复要等下一个版本才到用户手上。…
   FALLBACK: Request: 处理一下github上的这些问题：https://github.com/…/issues/35 …   (nothing else)
2. S#491 dev--claude-mem-lite, source=report
   NOW: Request: 按文档中的建议进行修复和优化docs/audits/20260927-oss-landscape-optimization-proposal.md
        Completed: - **发布方式**：这次走的是手动流程（manual ship because：…
        Remaining: - **"合并"没有对象**：这次的提交都直接在 main 上 …
   FALLBACK: Request: 按文档中的建议进行修复和优化docs/audits/20260927-oss-landscape-optimization-proposal.md
3. S#497 dev--claudemd, source=report
   NOW: Request: 我已经重启了会话 / Completed: - **T0 已记录**：… / Remaining: - 本地 `main` 比 `origin/main` 多 2 个提交 …
   FALLBACK: Request: 我已经重启了会话
4. S#492 dev--claudemd, source=titles (already the fallback today)
   NOW = FALLBACK: Request: B7 的离线对照还在后台跑，80 次大约 90 分钟，跑完会自动通知我。 已完成（全部是本地提交，没推送）：- B0：v0.100.0 已发版。…
5. S#477 dev--claude-mem-lite, source=haiku
   NOW: Request: Implement R1 recommendations …; Completed: Three of four R1 recommendations
        implemented …; Remaining: MEMORY.md:size-reduction …; Next: …; Lessons: …; Decisions: …
   FALLBACK: Request: R1 建议的落实情况 - 已修复并部署，效果符合预期：- error-recall 的 cd 前缀误判 …
Side finding: `request` = FIRST prompt, which in continuation sessions is a pasted previous
report or a no-content line ("我已经重启了会话", "Not done - D#71 …", "B7 的离线对照…"). 5 of the
20 show this. For a user with no report, that first prompt is the whole block.

Events available to those sessions (`node SD/events.mjs`, same 20): per-session event counts
24,5,2,7,6,36,0,4,11,4,10,4,5,0,1,46,1,0,0,1; 16/20 have ≥1. E.g. S#496 (titles, Request =
pasted report) has 5 events: "Cross-file call noise filter missing Rust drop() pattern",
"Fixed Rust use-record extraction in index pipeline", …

## 4. Transcript replay (current extractor, `node SD/replay.mjs ~/.claude/projects/*/*.jsonl
~/.claude/projects/*/*/subagents/*.jsonl`; listed by explicit globs; files Sep 5–27)
Turn = user prompt (string or text block, no tool_result, not isMeta/compact summary) up to
the next; tail = last assistant text in it (what Stop reads at that turn's end).

| project (main) | sessions | turns | report turns | sess ≥1 report | sess last-turn report |
|---|---|---|---|---|---|
| dev-claude-mem-lite | 63 | 373 | 132 | 56 | 46 |
| dev-claudemd | 48 | 449 | 74 | 38 | 22 |
| dev-code-graph-mcp | 38 | 289 | 92 | 35 | 26 |
| dev-daagu | 10 | 54 | 29 | 10 | 9 |
| dev-gsd-lite | 11 | 119 | 35 | 10 | 3 |
| dev-loop-eng | 22 | 264 | 49 | 15 | 13 |
| dev-loop-testing | 14 | 257 | 35 | 13 | 9 |
| dev-moa-skill | 3 | 33 | 11 | 3 | 2 |
| tmp probe | 2 | 2 | 0 | 0 | 0 |
| **main total** | **211** | **1840** | **457 (24.8%)** | **180 (85.3%)** | **130 (61.6%)** |
| subagent total | 755 | 1185 | 13 (1.1%) | — | 6 |

Because a report Done sticks once written, "≥1 report turn" (85.3%) is the share whose row
ends as `report` under the current code (per transcript; /clear rotates mem sessions, so
per-mem-session it differs somewhat).

Non-convention sub-populations:
- Pre-convention transcripts: NONE. The four-section rule predates April 2026
  (`~/.claude/CLAUDE-changelog.md:411,416` already relaxes it in the 2026-05-24 series); transcripts start Sep 5.
- Main sessions with no report turn: **31/211 (14.7%)**; turns 1:12, 2:2, 3:6, 5+:11. They are
  Q&A/clarification turns, `ok` probes, skill-shaped reports (`/polish` run reports, release
  announcements "v0.156.0 已发布…"), mid-work stops. Last-tail length for these 31: ≥600
  chars 20, 200-599 2, 40-199 6, <40 3 (`node SD/tails.mjs`). All no-report turn tails:
  600+ 714, 200-599 374, 40-199 278, <40 17 of 1383; 33 end in a question.
- Subagent transcripts: 755 files, 1.1% report turns — a large non-four-section text corpus,
  but Stop does not fire for subagents and they have no sdk_sessions/user_prompts rows, so
  they cannot stand in for a Last Session user; usable only for offline text-quality work.
- Conclusion: a usable non-convention USER population does not exist locally. The 31
  no-report sessions are the closest proxy (same user, same spec-shaped prose).

## 5. Recommendation

Recommended: **(D) = C + a new input: the session's own transcript tail**, with events as an
optional secondary input — not (A) alone, not (B).

(A) events instead of observations.
 For: 115/203 sessions (56.7%) have ≥1 event in-window vs 11/203 with an observation; on the
 20-session sample 16/20 have events; titles are concrete ("Fixed Rust use-record
 extraction…").
 Against: no session column → attribution by project+time window; 55/203 (27%) of sessions
 overlap another same-project session, so their summary would mix sessions (fix = schema
 migration adding a session id to `events` = hard AUTH). Quality: the only label is
 30 random events labelled 2026-09-25 (`docs/audits/20260925-200912-session-history-analysis.md:212-220`):
 ACCURATE 2 / PARTLY 11 (title true, lesson overclaimed) / WRONG 16 / GENERIC 1 — i.e.
 ≤13/30 titles verified true; the model would summarise a summary of 40-60-char `desc` lines.
 The D#69 relabel (D#101) is still owed. Per-turn model calls: the worker would go from
 ~always no-obs to one call per turn (1840 turns / 211 sessions ≈ 8.7 per session locally),
 with only the superseded check to shed them.
(B) keep observations.
 Against: reverses the obs→events split every read face was re-wired for
 (`lib/events-injection.mjs:1-14`); double storage; the row it would keep is the rule-based
 pre-save whose title is the raw tool line (S#486's `SP=/tmp/… → ERROR:`). No evidence for.
(C) run the worker only when no report was found.
 For: for the 85.3% report sessions the model's Done/Not done never wins anyway
 (`mergeModelSummary` keeps report fields); it only adds Next/Lessons/Decisions. Saves spawns.
 Against: alone it fixes nothing for the target user — the gate would admit exactly the
 sessions that then exit no-obs. It also drops Next/Lessons/Decisions for report users
 (measured: 15/190 rows carry next_steps / lessons at all).
(D, recommended) When the tail has no report: (1) deterministic floor at Stop — store the
 scrubbed, truncated final assistant text as `completed` with a new provenance tag (e.g.
 `donetail`), ranked below report/model, above titles; 20/31 local no-report sessions end
 with a ≥600-char tail, 3/31 with <40 chars ("ok"). (2) Pass the transcript path (or the
 tail text) to the worker and let it summarise prompts + final assistant text (+ events as
 context if (A)'s attribution is accepted), gated by (C) so convention users pay nothing.
 (3) Separately: `request` = first prompt is weak for continuation sessions (5/20 samples);
 consider the last substantive prompt or the model's `request`.
 Against: the tail can be a question / mid-work narration (33/1383 no-report tails end in
 '?'); the tail is attacker-influenceable text (defang already applied at render,
 `hook-handoff.mjs:1066`; scrub at write); an LLM-visible change (SessionStart text) → L3.

What local data can and cannot support:
- CAN: the mechanism (no-obs is structural: only non-low-yield `change` survives, 9 hook obs
  in 14 days); the fallback's content (Request-only 19/20); event coverage and attribution
  ambiguity; that tails exist and are long in the no-report sessions.
- CANNOT: how often a non-convention user's final message is a usable summary, how their
  tails read, their report-false-positive rate (a non-convention user writing "Done." prose
  lines), or whether any Last Session variant changes behaviour in the next session.

Still needed:
1. A non-convention corpus: transcripts from a user without the global spec (a second
   machine/profile, or a sandbox HOME with no ~/.claude/CLAUDE.md running real tasks), then
   the replay.mjs rates + tail-length and "tail is a wrap-up" labels on ≥30 sessions.
2. A blind A/B label of Last Session text (Request-only vs tail-floor vs model-on-tail vs
   model-on-events) on the 31 no-report sessions + that corpus, judged against the transcript.
3. The D#101 relabel of post-D#69 events before events feed any summary.
4. `summary_worker` metric across ≥7 days and ≥1 non-maintainer install before quoting a rate
   (today: 1 day, 7 sessions, 1 session with `written`).

Process note: one command ran `du -sh ~/.claude/projects` (a recursive size walk under
~/.claude, one output line, did not touch tmp/). All other listing used explicit depth globs.
