> Copied verbatim from the session scratchpad on 2026-09-27 (runbook: reports go to docs/audits before scratch is removed). Scratch paths inside refer to that session. Repairs: 3baace6, ed04098.

# B1 — identifier-subword indexing: report (2026-09-27)

## Verdict: REVERTED (stop condition fired on the benchmark:gate caliber)

Branch: `worktree-agent-a6cc29ffb70f2428e` (fast-forwarded 7272c56 -> main 209a8bd first, so the proposal doc is in the tree). Not pushed, no tag, no version bump, CHANGELOG untouched.

| SHA | What |
|---|---|
| 64687af | bench(denoise-ab): `identifier_parts` suite (19 queries, `benchmark/fixtures/test-queries-identifier-parts.json`) — KEPT |
| ec19cd7 | feat(search): identifier parts on the write side + phrase OR on the query side, and `tests/identifier-subwords.test.mjs` — REVERTED |
| 6e35791 | revert of ec19cd7 (numbers in the message) |
| 38201c3 | docs(bench): the fixture's `_doc` records the reverted attempt, its cost and the rows responsible |

Final tree = 64687af plus the `_doc` text (the diff against 64687af was empty right after 6e35791).

## Backfill / events finding (checked BEFORE any backfill code)
- `fts-check rebuild` -> `rebuildFTS` (schema.mjs:1438, `INSERT INTO <fts>(<fts>) VALUES('rebuild')`) RE-INDEXES the stored columns. It does NOT recompute `observations.text`, where the CJK bigrams (and B1's parts) live (`lib/observation-write.mjs:157`). A backfill of existing rows would have to rewrite `text` on every row = a data migration. `DEFERRED_CLEANUPS` in schema.mjs (one-shot marker, no version bump) is a possible vehicle, but I did not write it. **[PARTIAL: backfill needs migration AUTH]**
- events: `events_fts` is external-content over `events.title/body`, filled by the `events_fts_*` triggers and by 'rebuild' (schema.mjs:811-815, tokenize at 814). Appending parts needs a new column or trigger DDL, so this is also a migration. Not done; **[PARTIAL: events parts need migration AUTH]**. The reverted commit held an `it.fails` tripwire for this.
- Both points no longer matter after the revert, but they will matter for any retry.

## What ec19cd7 did (for the record)
- `lib/lesson-idents.mjs`: `identifierParts(token)` (camelCase + PascalCase with >=2 humps; min length 5, max 64; up to 8 parts; rejects >=2 digit runs and >1 one-letter part; drops digit and 1-letter parts) and `identifierSubwords(text)`.
- `utils.mjs`: `ftsIndexExtras(text)` = cjkBigrams + identifierSubwords(scrubSecrets(text) with `scheme://` chunks removed). It replaced the bare `cjkBigrams` at every observation write site: observation-write derivedText, hook-llm buildFtsTextField, save-observation, save-enrich, 5 sites in hook-optimize, and the benchmark seeder. `looksAlreadyDerived` counts the parts as known tokens, so a derived blob with parts is not promoted into `narrative`.
- `nlp.mjs expandToken`: an identifier token becomes `(tok OR "p1 p2 ..")`. Queries with no identifier are byte-identical. Tokens join with AND when a group is present, so `relaxFtsQueryToOr` works unchanged: `(toolRecall OR "tool recall") AND ordering` becomes `... OR ordering`.
- Reading stated (subagent, no one to ask): only camel/Pascal is split. unicode61 already splits snake/kebab on observations_fts ('busy buffers size' hit before B1), and the events side is blocked by the migration.

## RED (pre-implementation tree, 2026-09-27: 64687af code + the new test file)
`npx vitest run tests/identifier-subwords.test.mjs` -> `Tests 11 failed | 2 passed | 1 expected fail (14)`. Examples:
- `a camelCase PART of an identifier finds the row (manual save)` -> `AssertionError: expected [] to include 1`
- `a split identifier is an OR group AND-joined ...` -> `expected 'toolRecall ordering' to be '(toolRecall OR "tool recall") AND ord…'`
- `recalls the row for identifier-part queries on the seeded fixture corpus` -> `expected 0 to be greater than or equal to 0.9`
- denoise-ab arm A: `identifier_parts R@10=0.000 P@10=0.000`.

GREEN on ec19cd7: that file had 13 passed + 1 expected fail. Full suite before commit: 444 files, 7196 passed + 1 expected fail.

## Measurements: both arms back-to-back, arm A = 64687af, arm B = ec19cd7 (archived trees in scratch)

### denoise-ab (union fixture corpus; 2026-09-27T08:28:15Z A, 08:28:16Z B)
| suite (n, 1/n) | A | B | Δ |
|---|---|---|---|
| precision_hard_negatives (30, 0.0333) | R 0.887 P 0.811 nDCG 0.923 MRR 0.906 | R 0.864 P 0.780 nDCG 0.902 MRR 0.906 | ΔR −0.022 ΔP **−0.031** ΔnDCG −0.021 |
| vocab_mismatch_paraphrase (12) | R 0.341 P 0.155 | same | 0 |
| cjk_mixed (15) | R 1.000 P 0.940 | same | 0 |
| identifier_parts (19, 0.0526) | R 0.000 | R 1.000 P 0.921 MRR 0.947 | +1.000 |

Probes: 8/8 scripts, cross-source 11/11, deferred 10/10, events 9/9 in both arms. Verdict printed: TRADEOFF.

### benchmark:gate (`node benchmark/ci-gate.mjs`, seed-data.json only, same 30 precision queries; 08:30:09Z A, 08:30:12Z B)
- A: R 0.8998 P 0.8497 nDCG 0.9712 MRR 0.9611 (matches the 2026-09-14 baseline exactly). Exit 0.
- B: R 0.8904 P **0.8112** nDCG 0.9532 MRR 0.9611. Exit 0 (PASS at 5% relative tolerance), but **ΔP@10 = −0.0385 > 1/30 = 0.0333**.
- Name set on the gate caliber: q19 "database" and q35 "DB" P 1->0.5, R 1->0.833 (new 32,57,33,121,112; lost 169); q6 "cache" 0.714->0.625 (new 130); q11 "notification" 1->0.833 (new 62); q7 "migration" 0.9->1.0 (+115, −193). Cause: suffix humps became standalone tokens. CockroachDB, WatermelonDB, DynamoDB -> `db`; ElastiCache -> `cache`; User*Service rows -> `notification`.

### error-recall
- `error-recall-suite.mjs --json` (08:29:55Z): A and B outputs are **byte-identical** (precision 0.346, hitRate 1, 9 cases). This ruler is **structurally blind** to B1 (doctrine rule 9). Its fixture raw-inserts `text`, so the write side never runs, and `errorRecallFtsQuery` quotes terms itself rather than calling sanitizeFtsQuery.
- The command-word metric lives in `error-recall-live-replay.mjs`, not in the suite. I ran it on a `.backup` copy of the live DB (taken read-only at 2026-09-27T08:27:54Z; 181 obs rows, 3 projects with >=20 rows). Arm A = the copy as-is. Arm B = the same copy with parts appended to `text` for every row (source: title+narrative+lesson+concepts+facts+aliases; 106/181 rows changed, +624 tokens). Shapes were extracted once (99 from 210 transcripts) and reused for B. Runs at 08:29:18Z A, 08:29:26Z B, 08:29:27Z A re-run.
  - top-1 command-word-only: **A 120/293 (41.0%) -> B 120/293 (41.0%)**. Per-case diff: 5 top-1 ids changed, 0 flips of the cmd-only flag. Did not rise.
  - cmd-only rows: 337/792 (42.6%) -> 331/792 (41.8%). The 6 rows (298, 109) now match an error term through their parts.

### IDF dilution (live copy, same 181 rows)
Indexed tokens 74,885 -> 75,509 (+0.83%). Terms 7,248 -> 7,288. df changed for 218 terms. Largest df gains: extract 5->15, hub 0->10 (GitHub), lite 14->22 and **sq 0->8** (SQLite splits as SQ+Lite, a junk part), file 53->60, use 17->23, git 24->30. Command words: run 61->63, build 11->13, npm/test/node/get/hook unchanged. On the fixture corpus, dilution showed up as the precision loss above: parts are appended to `text` (weight 3), so product-name rows gain a lower-weight match on generic words, and those matches outrank rows that match the word itself.

## Stop-condition verdict
- The designated ruler (denoise-ab precision_hard_negatives): ΔP@10 −0.0307 vs 1/n 0.0333. Does NOT fire, by a margin of 0.0026.
- The same 30 queries on the gate's corpus (seed-data.json, the corpus they were written for): ΔP@10 −0.0385. FIRES.
- error-recall top-1 cmd-only share: unchanged (120/293). Does not fire.
- The two readings disagree, so I took the stricter one (spec §3): fired -> reverted. ec19cd7 stays reachable in history if the reviewer reads the condition as denoise-ab only.

## Uncertain
- Uncertain whether the stop condition meant the denoise-ab caliber alone. If it did, the change would have passed, with a 0.0026 margin.
- Arm B of the live replay is a simulated steady state: parts computed over the union of fields. The real write sites each feed a different subset, and the replay is not those sites.
- The error-recall fixture suite reading NEUTRAL is a blind instrument, not evidence of safety. Only the live replay measured this face.

## NOT CHECKED
- UPS / PreToolUse injection faces (`ups-ab.mjs`, rerank/keyctx replays). denoise-ab cannot see them, and the query-side change reaches them through sanitizeFtsQuery.
- `benchmark:multipliers:gate`, `hook-latency.mjs` (utils.mjs gained an import of lib/lesson-idents.mjs), knip, coverage, `npm run test:ci-env`.
- Mutation verification of the new guards (looksAlreadyDerived / scrub-first / URL strip). Moot after the revert.
- Whether the rulers wrote to the real metrics shard. Every run set CLAUDE_MEM_DIR to scratch, and the scratch dirs stayed empty of metrics. The real `~/.claude-mem-lite/metrics/2026-09-27.jsonl` also grows from this session's own hooks, and the two sources were not separated.

## Retry notes (evidence-based, not built)
- Suffix humps that are generic words (`DB`, `Cache`, `Service`) cost precision when indexed as standalone tokens. One untested alternative: index adjacent-part COMPOUNDS (`preToolRecall` -> `pretool toolrecall`) instead of single parts. That would also cover the proposal's lowercase `toolrecall` probe, which this design did not. It would lose the spaced-words form ('tool recall'). Measure both arms again before choosing.
- The acronym-then-word split is ambiguous (`SQLite` -> `sq lite`).

## Housekeeping
- The worktree had a partial `node_modules` (created 08:16 by an npm install of unknown origin, which also added a `hasInstallScript` line to package-lock.json). With it, `coverage-scope` and `green-stamp` failed (6 tests). I replaced it with a symlink to the main checkout's node_modules (gitignored) and restored package-lock.json from HEAD.
- Scratch: deleted the arm trees, tars, live-DB copies and the extracted shapes (they held transcript stderr). Kept the small JSON outputs and scripts in the scratchpad.
- Lesson #48 n/a: no new column writer. Only the content of `text` changed, and no re-enrich pool keys on it.
- Final state: 443 files / 7183 tests passed (pre-commit on 38201c3), `npx eslint .` exit 0, `npm run format` ×2 then `format:check` clean, working tree clean. `df -h /tmp`: 9.5G free.
