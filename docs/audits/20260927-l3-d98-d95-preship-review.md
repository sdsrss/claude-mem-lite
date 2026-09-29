> Copied verbatim from the session scratchpad on 2026-09-27. Repairs: 13f822c (all but P3-9).

# Pre-ship review — 396ae10, 70f8bbd, dfd79b4, 34a65cd (range 0bcf947..34a65cd)

Reviewer: independent, read-only. Date 2026-09-27. HEAD = 34a65cd on main (v6.16.0-10-g34a65cd).
Method: read the three specs + diffs; differential probes on `git archive` copies of 0bcf947 and
34a65cd (node_modules symlinked); per-site mutations on the 34a65cd copy (reverted with
`git checkout` inside the copy, not the repo); full suite on the repo.

## Verdict

No P1. Code does what each spec's success criteria say on every emission / spawn / consumer
path I enumerated. Two P2s (one incomplete doc correction that ships in the tarball, one
undeclared behaviour change in an opt-in arm) and 11 P3s. The release itself is NOT ready: no
version bump, no CHANGELOG entry, no "Upgrading to 6.17.0" in either README (section 5).

Counts: P1 0 · P2 2 · P3 11.

Fresh evidence:
- Full suite on the repo at 34a65cd: `Test Files 448 passed (448)`, `Tests 7243 passed (7243)`,
  exit 0 (matches the 34a65cd commit body). `git status --short` empty afterwards.
- `npx eslint` on the 10 changed source/test files: exit 0. `npm run format:check`: exit 0.
- `wc -c CLAUDE.md` = 20467 (≤ 20480; 0bcf947 = 20450). Managed block == `buildClaudeMdBlock()`.

## 1. Correctness per spec, parallel paths enumerated

### D#98 (396ae10)
Emission sites of the pre-edit directive — exactly two, both read `ACTIVE_DIRECTIVE`:
- scripts/pre-tool-recall.js:545 (Read→Edit ack line)
- scripts/pre-tool-recall.js:910 (Edit/Write lesson block, bridge fallback)
No other shipped module emits a per-lesson ask (grep over scripts/, lib/, hook*.mjs,
tool-schemas.mjs, search-scoring.mjs buildServerInstructions, lib/cite-back-hint.mjs; the
SessionStart cite-recall nudge at lib/cite-back-hint.mjs:380 already says "cite #NN
explicitly" only when a lesson informs the action — consistent).
Differential probe (same fixture, `CLAUDE_MEM_RECALL_FRAMING=legacy`, Edit + Read→Edit), old tree
vs new tree:
- old default vs new `verdict`: IDENTICAL at both sites.
- `bind` old vs new: IDENTICAL. `legacy` old vs new: IDENTICAL.
- `bridge` old vs new: DIFFERENT at both sites (see P2-2).
Criteria 1–4 met; criterion 5 is filed as deferred item D#111 ("D#98 readout …").

### Deferred "+N more" (dfd79b4)
hook-context.mjs:865 adds `COUNT(*) OVER () AS open_total` to the LIMIT 5 statement;
hook-context.mjs:884-885 emits the line only when `hidden > 0`. Consumers of
buildSessionContextLines: hook.mjs:2805 (SessionStart), hook-precompact.mjs:28 (PreCompact),
mem-cli.mjs:1793 (`context`) — all get the line from the one builder. Probe (15 open items,
sandbox): `context` prints 5 rows + `+10 more open — mem_defer_list / \`defer list\` shows all`.
Mutations: `hidden > 99` reds "caps display at 5 items"; `hidden >= 0` reds "a list that fits
prints no more line". Criteria 1–3 met.

### D#95 (34a65cd)
Spawn sites of `llm-summary` — exactly two (grep `spawnBackground('llm-summary'`):
- hook.mjs:1755 (Stop) — `!process.env.CLAUDE_MEM_SKIP_SUMMARY && modelSummaryOptedIn()`
- hook.mjs:2294 (SessionStart /clear) — same guard.
Dispatcher `case 'llm-summary'` (hook.mjs:3518) unchanged; hook-llm.mjs untouched in range.
Mutations: dropping the predicate at :1755 reds 2 cases (default arm + structural); at :2294
reds 1 (structural only). Probe: opted-in Stop → one `summary_worker` row `no-obs` at ~220 ms;
default Stop → 0 rows after 10 s. Criteria 1–2 met; criterion 3 partially (P2-1).

## 2. Regressions

- Stop cite-recall gate (hook.mjs:1570-1583) still counts dismissals as answers; under the new
  directive silence on a non-applied lesson is the compliant behaviour and counts as a miss.
  Spec-accepted (non-goal) → P3-6 for the stale comment only.
- Citation extractors: pretool face collects ids via `INJECTED_ROW_RE` on `#NN [type]` rows
  (lib/citation-tracker.mjs:713-721), not the directive text; the directive contains no digit
  ids. No parser keyed on the old wording in shipped code; only
  tests/efficacy-bridge-select.test.mjs:24 quotes a truncated `apply each lesson...`, still valid.
- session_summaries readers expecting model fields: hook-context.mjs:620/946 (Lessons: /
  Decisions: lines), hook-handoff.mjs:1038-1066 (`<session-summary source="haiku">`). Default
  now never fills lessons/key_decisions/investigated/learned; readers already tolerate empties
  (no crash). The provenance label becomes wrong by default (P3-7).
- Tests that relied on the worker: tests/e2e.test.mjs P3-6 case now opts in; every other test
  referencing the worker invokes `hook.mjs llm-summary` directly (feature-sweep-hooks:1266,
  e2e:1138, hook-llm) — unaffected. Stale comments remain (P3-10).
- 10,000-char cap: the pretool directive grows by ~70 chars on a ≤3-lesson/240-char block; the
  deferred line is ~60 chars and carries no id, so dropped-id footers/booking are unaffected in
  principle (not run at the cap — see NOT CHECKED).
- Auto-adopt: silentAutoAdopt (adopt-cli.mjs:222-250) refreshes a drifted managed block, so
  every adopted project's CLAUDE.md row and detail doc are rewritten on the next SessionStart
  (a user-visible diff in users' repos; `CLAUDE_MEM_NO_TEMPLATE_REFRESH=1` opts out). Not a
  defect; belongs in the upgrade note (section 5).

## 3. Findings

### P2-1 — D#95 doc correction incomplete; the stale copies ship in the tarball
- README.md:647 "How It Works" Stop flow: `-> Spawn LLM summary worker (poll-based wait)` —
  unconditional, now false by default.
- README.zh-CN.md:63 `会话摘要 -- 会话结束时通过后台 worker（使用 \`claude -p\`）生成 LLM 摘要`
  and README.zh-CN.md:473 `session_summaries -- LLM 生成的会话摘要` — unchanged by 34a65cd.
  The release runbook records that README.zh-CN.md is packed by npm (README* rule) although it
  is not in package.json#files, so zh npm users get the old claim.
- Spec d95 criterion 3 ("README feature text corrected") is met only for README.md:84/578.
Repro: `grep -n "Spawn LLM summary worker" README.md; grep -n "会话摘要" README.zh-CN.md`.

### P2-2 — `CLAUDE_MEM_SALIENCE=bridge` changed silently
`ACTIVE_DIRECTIVE` (scripts/pre-tool-recall.js:167-171) resolves to the NEW `ACK_DIRECTIVE`
under `bridge`, and bridge uses it as its fallback at :910 (bridge returned null) and at the
Read→Edit line :545. Probe (old tree vs new, `CLAUDE_MEM_BRIDGE_FAKE=n/a`):
```
< [mem] ⚠ Before this edit: apply each lesson … — state '#NN applied' or '#NN n/a — <reason>' in your next user-facing message.
> [mem] ⚠ Before this edit: apply each lesson … a lesson that did not apply needs no mention.
```
(same diff on the Read→Edit line). The commit says "`bind` and `legacy` are unchanged" (true)
and is silent on bridge; README:1076 lists `bind` / `bridge` together as "comprehension-bridge
arms". benchmark/efficacy-harness.mjs runs a bridge arm, so a bridge reading before/after this
commit is not comparable. Fix = either route bridge's fallback to VERDICT_DIRECTIVE or state the
change in CHANGELOG + README row.

### P3-1 — "+N more open — mem_defer_list / `defer list` shows all" is false above 10 items
Both listing surfaces page at 10 (lib/deferred-work.mjs:73 `limit = 10`; 08ccec3 body: "defer
list (page 10) and mem_defer_list (page 10)"). Probe, 15 open: SessionStart says "+10 more
open … shows all"; `defer list` prints 10 rows then "5 more open items not shown — raise
--limit (max 100)". LLM-visible in every session; costs an extra round trip. Suggest "lists them"
or name `--limit`.

### P3-2 — d98 guard allowlist admits a reverted default directive
tests/d98-no-dismissal-ask.test.mjs:22-27 allowlists any line in pre-tool-recall.js matching
`^\s*"(?:apply each lesson|For each lesson)` — i.e. by the line's SHAPE, not by which constant it
belongs to. Mutation: set `ACK_DIRECTIVE`'s body back to the 0bcf947 double-quoted verdict
string → d98 file 4/4 green (pre-tool-recall.test.mjs 2 red + bind 1 red catch it, so not
unguarded overall — but this guard is blind to its own headline regression).

### P3-3 — d98 guard pattern catches one spelling only
`DISMISSAL_ASK = /n\/a — </` (tests/d98-no-dismissal-ask.test.mjs:21). Mutation: change the
adoption row's tail to "answer each with \`#NN applied\` or \`#NN n/a\`" → d98 4/4 and
adopt-content-decay-claim 2/2 green. The commit's "guards every shipped module and Markdown
file against the dismissal ask" holds for the `n/a — <reason>` template only.

### P3-4 — d95 test's quiesce() is vacuous
tests/d95-model-summary-opt-in.test.mjs:32-43 waits on `pgrep -f <root>`. The worker's argv is
`node <REPO>/hook.mjs llm-summary hook-mem-d95-XXXX--proj-<hash> mem-d95-XXXX--proj <epoch>` —
the sandbox root appears only in env (HOME, CLAUDE_MEM_DIR), which `pgrep -f` does not match.
Probe while the worker was alive: `ps` showed the line above; `pgrep -f <root>` exited 1. So
quiesce never waits; the only wait is the 6 s row poll (line 94). Consequences: the comment
"the detached worker included" is false; if the arm order flips (premise last), afterAll's rmSync
can race a worker still inside db.close(). No residue observed (0 `mem-d95-*` in /tmp after the
file run and after the full suite). Also the default arm always costs 6.1 s.

### P3-5 — /clear spawn site has structural coverage only
Mutation dropping the predicate at hook.mjs:2294 reds only the structural case. The structural
check is `window.includes('modelSummaryOptedIn()')`, so `!SKIP || modelSummaryOptedIn()` at the
/clear site would pass everything (at the Stop site the behavioural arm would catch it).

### P3-6 — Stale rationale on the Stop cite-recall gate
hook.mjs:1573-1576: "`#NN n/a — <reason>` is a complete answer: counting it as silence would nag
an agent for following the convention to the letter." After D#98 the default convention IS
silence for non-applied lessons, and the gate counts that as a miss (baseline doc: crediting-only
ratio fires 87/95 vs 78/95). Spec accepted the gate as-is; the comment now argues the opposite
policy.

### P3-7 — `<session-summary source="haiku">` now mislabels provenance by default
hook-handoff.mjs:1061. With the worker off, every row it wraps is the Stop report extract or
the /clear fast summary. LLM-visible.

### P3-8 — Under the `verdict` opt-out, shipped guidance contradicts the directive
The adoption row (adopt-content.mjs:53) and detail doc (adopt-content.mjs:90-95, "所以不必写")
are not selectable by env, so a `verdict` user is told per edit to write `#NN n/a — <reason>`
and by the doc that it need not be written. README:1076 does not mention this.

### P3-9 — readme-env-flags cannot detect the omission the claim credits it with
tests/readme-env-flags.test.mjs:54 checks `readme.includes(name)` anywhere. Mutation: delete the
`CLAUDE_MEM_LLM_SUMMARY` env-table row (README.md:1050) and strip the `verdict` clause from the
SALIENCE row → 2/2 green (README.md:84 and :578 still name the var). Sanity arm (rename every
mention) → 2/2 red. Values are never checked.

### P3-10 — Stale comments claiming the worker runs every Stop
hook-llm.mjs:1631 ("This worker runs after EVERY Stop …"), tests/feature-sweep-hooks.test.mjs:74
and :412 ("the detached llm-summary worker Stop spawns").

### P3-11 — Weakened absence assertions in pre-tool-recall.test.mjs
The legacy and Read cases now assert only `not.toContain(ACK_MARK)` (tests/pre-tool-recall.test.mjs
~1472, ~1486); before they asserted `not.toContain("'#NN applied'")`. Emitting VERDICT text on
those paths would now pass this file (bind file's legacy case still has `#NN applied` in its
regex; the Read path has no such backstop).

## 4. Claims

a. "CLAUDE_MEM_SALIENCE=verdict restores the old directive byte-for-byte." — TRUE for the
   directive: `diff` of 0bcf947 ACK_DIRECTIVE vs 34a65cd VERDICT_DIRECTIVE = identical, and the
   end-to-end probe of both emission sites (old default vs new verdict) is identical. Caveat:
   the old adoption row / detail doc are not restored (P3-8).
b. "`bind` and `legacy` are unchanged." — TRUE as stated (probe identical), MISLEADING by
   omission: `bridge` changed at both sites (P2-2).
c. "The total is COUNT(*) OVER () on the same statement, so it cannot disagree with the rows
   shown." — TRUE (window computed over the full filtered set before LIMIT, one statement; 7 → "+2",
   15 → "+10" observed). The adjacent line text "shows all" is FALSE above 10 (P3-1).
d. "handleLLMSummary is unchanged and runs when opted in." — TRUE: hook-llm.mjs not in
   `git diff 0bcf947..34a65cd --stat`; opted-in Stop probe produced a `summary_worker` `no-obs` row.
e. "Both spawn sites now require modelSummaryOptedIn() and still honour CLAUDE_MEM_SKIP_SUMMARY
   first." — TRUE (hook.mjs:1755, :2294; short-circuit AND so SKIP wins; bg-spawn-skip-flag-invariant
   green). "first" is order-only; semantics are an AND.
f. README env table documents every new/changed env var — TRUE (CLAUDE_MEM_LLM_SUMMARY row
   added at :1050; SALIENCE row names `verdict` at :1076). "tests/readme-env-flags.test.mjs would
   catch an omission" — MISLEADING: it catches only removal of every mention of the NAME; row
   deletion and value omissions pass (P3-9).
Also verified: "restoring the old default reds 3 cases" TRUE (bind 1 + pre-tool-recall 2);
"restoring the old doc sentence reds 1" TRUE for the restated guard (adopt-content-decay-claim
1 red; d98 adds 2 more); D#95 per-site mutation counts 2 / 1 TRUE; "Full suite 448 files / 7243"
TRUE on re-run.

## 5. Released-artifact readiness (not written — what the release still owes)

1. Version bump 6.16.0 → 6.17.0 via `node cli.mjs release` (package.json, plugin.json,
   marketplace.json, CLAUDE.md `**Version**` guard line, lockfile). README already says "since
   6.17.0" (:1050) and "pre-6.17" (:1076) — a patch-number release would make both wrong.
2. CHANGELOG `## v6.17.0` with an upgrade table, one row per default change and its switch:
   - PreToolUse directive asks for `#NN` only where a lesson changed the edit → `CLAUDE_MEM_SALIENCE=verdict`
   - background model session summary off → `CLAUDE_MEM_LLM_SUMMARY=1`
   - SessionStart Deferred Work "+N more open" line → pin 6.16.0 (no switch, per spec)
   - `bridge` arm fallback wording changed (P2-2) unless fixed.
   Plus caliber notes: dismissal share / cite-rate readings and the D#104 framing readout must not
   mix sessions from before and after; the Stop cite-recall nudge is expected to fire more
   (78/95 → up to 87/95 by the baseline doc); `summary_worker` metric rows drop to zero by default;
   adopted projects' CLAUDE.md managed row + detail doc get rewritten on next SessionStart
   (`CLAUDE_MEM_NO_TEMPLATE_REFRESH=1` to keep the old text).
   Also owed: CHANGELOG lines for the 6 unreleased commits before this range (08ccec3 defer-list
   hint, 3c60192 D#108 booking fix, 6494d48 update fix, f9c9c00 dev-deps bump, 0d858d8, 0bcf947).
3. "## Upgrading to 6.17.0" in BOTH README.md and README.zh-CN.md (CHANGELOG does not ship; zh
   README does), plus P2-1's zh text.
4. Hand-set the GitHub Release body from the CHANGELOG extract (generate_release_notes yields one
   compare link on this repo).
5. Pre-run publish gates before tagging: `npm audit --omit=dev`, `node benchmark/ci-gate.mjs --strict`
   (baseline stamped 2026-09-14T16:06:53Z, valid to 2026-10-14 — no recapture needed),
   `node scripts/smoke-tarball.mjs`, `npm run test:ci-env`.
6. D#98 readout already filed (D#111); D#95 follow-up D#107 exists.

## NOT CHECKED

- SessionStart output at or near the 10,000-char cap with a capped Deferred block (whether the
  "+N more" line is trimmed first/last and how the dropped-ids footer reads).
- `npm run test:ci-env`, coverage gate, knip, `benchmark:gate`, `validate:manifests`, smoke-tarball.
- The d95 test on macOS / a runner without `pgrep` (code path returns immediately; not run).
- Whether other users' installs keep observations (the D#95 evidence population is the maintainer
  machine; I checked the mechanism only: every EVENT_TYPES type is upgrade-deleted to events,
  lib/activity.mjs:26-35, so only `change` episodes survive in observations).
- The 70f8bbd baseline numbers (2007 / 335 / 1890 / 98 / 78 / 87 of 95) were not re-run against
  the transcript corpus; the script in the doc was read, not executed.
- README.md prose outside the lines cited; the MCP `mem_defer_list` description text vs the new line.

## Hygiene

Scratch trees (`git archive` copies), probes and sandboxes under the review scratchpad were
deleted; 25 vitest `/tmp/<nanoid>/ssr` cache dirs created by this review's vitest runs were
removed (each contained only `ssr`, mtimes inside this review's run windows). Repo `git status`
clean. Kept: this report and fullsuite.log.
