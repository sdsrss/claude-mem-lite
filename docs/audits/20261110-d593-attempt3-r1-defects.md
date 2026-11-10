> 归档：D#593 第 3 次尝试 r1 缺陷视角报告原文（子代理，审 e215aba4..52f4979c；评审自述读过规格，非完全盲审）。脚本留在 /home/ai/.cache/tmp/rv-d593c-defects/scripts（重建树：git archive 52f4979c / e215aba4）。

# Blind defects review — D#593 attempt 3, `e215aba4..52f4979c` (branch `feat/d593-checked-rebuild`)

Reviewer: defects lens, fresh agent. Trees: `tree/` = `git archive 52f4979c` (given), `old/` = `git archive e215aba4`
with a copy of the same node_modules (better-sqlite3 13; `SELECT sqlite_version()` = 3.53.4). Probes are in
`/home/ai/.cache/tmp/rv-d593c-defects/scripts/`; every product run used a sandbox HOME / CLAUDE_MEM_DIR under `work/`,
LLM keys stripped, heavy runs under `tasks/d593/capped.sh`. The live repository was only read.

Disclosure: before probing I read `tasks/specs/d593-attempt3.md` (it is in the repo and holds the author's own
readings). Every number below comes from my own runs on the two trees above.

Shape labels: REAL SHAPE = a store a user can have; here mostly the D#546 damage generator
(`tasks/d546/ruler/plants.mjs`, `richPlants`: random bytes on one main-file page or one log frame — the same model of
real page damage the change's own acceptance set R uses). CONSTRUCTED = only from adversarial input.

**No P0 found:** in every probe below the checked rebuild / REINDEX / optimize paths never committed a write that lost or changed a row (F7's loss is the CLI's opener, before the checked rebuild, and the same on e215aba4).

---

## F1 — P1, REAL SHAPE: doctor now prints "restore a snapshot" / "set the broken file aside so a fresh store is created" for stores whose every row is intact, including stores e215aba4's doctor repaired

**Where:** `install.mjs:3256-3276` sends every `check === 'damaged'` refusal to `dbCheckRemedy(DB_PATH, SQLITE_CORRUPT)`,
the remedy for an unopenable store (restore the newest passing snapshot; with none, move the store aside so the next
session starts empty). Fed by `lib/checked-write.mjs:20-21,86` and `schema.mjs:2001-2032`: any quick_check line other
than `ok`, and any step error whose code is outside BUSY/LOCKED/FULL/IOERR/NOMEM/CANTOPEN/READONLY/INTERRUPT/PERM, is
`damaged`.

**What happens:** damage confined to an FTS5 shadow table (`*_fts_data`, `*_fts_docsize`, `*_fts_idx`, `*_fts_config`),
or leftovers that cannot reach a row (`Page N: never used` — a leaked page is never allocated; `Fragmentation of N bytes
reported as M`), makes the checked rebuild refuse as `damaged`. Doctor then prints the restore command, or with no
snapshot the set-aside command. Every user row is intact; running the printed command takes rows out of the live store
(back to the snapshot, or to empty). e215aba4 printed a plain ✗ "FTS5 rebuild errors" with no remedy on some of these,
and on others rebuilt the index (✓).

**Repro / readings** — `D546_WORK=<work>/d546 node scripts/pJ-main21-112.mjs <ids> <variant> <seed>` (doctor on a
copy per tree, no snapshot):

| plant | damaged page | observations readable (before = after, both trees) | e215aba4 doctor | 52f4979c doctor |
|---|---|---|---|---|
| main21-15 | observations_fts_data, right-child ptr | 1195 | `✓ FTS5 rebuilt: observations_fts, session_summaries_fts, user_prompts_fts, events_fts` | `✗ FTS5 not rebuilt: the store is damaged (quick_check: Page 408: never used) …` then `No backup snapshot exists beside the database. Once every Claude Code session is closed, set the broken file aside so a fresh store is created on the next session: test ! -e …` |
| log23-26 | observations_fts_data, ncell | 1495 | `✓ FTS5 rebuilt:` all four | ✗ `(quick_check: Page 640: never used)` + set-aside command |
| log23-78 | observations_fts_data, ncell | 1495 | `✓ FTS5 rebuilt:` all four | ✗ `(quick_check: Freelist: 2nd reference to page 639)` + set-aside command |
| main21-14 | observations_fts_data, header | 1195 | ✓ three tables rebuilt, `✗ FTS5 rebuild errors: observations_fts: database disk image is malformed` | ✗ `the store is damaged (observations_fts: database disk image is malformed)` + set-aside command |
| main21-13 | user_prompts_fts_docsize | 1195 | three rebuilt, ✗ user_prompts_fts | ✗ + set-aside command |
| main21-112 | observations_fts_config | 1195 | three rebuilt, ✗ `invalid fts5 file format (found 0, expected 4 or 5)` | ✗ `the store is damaged (observations_fts: invalid fts5 file format …)` + set-aside command |
| log23-170 | observations_fts_data, header | 1495 | three rebuilt, ✗ observations_fts | ✗ + set-aside command |

With a snapshot present (`scripts/pR-restore.mjs`: main21-15 plus a snapshot dated 2026-11-09 holding 100 fewer
observations): e215aba4 `✓ FTS5 rebuilt: observations_fts, session_summaries_fts, user_prompts_fts, events_fts`;
52f4979c `✗ FTS5 not rebuilt: the store is damaged (quick_check: Page 408: never used) …` then `The newest of the 1
backup snapshot(s) … holds 1095 observation(s). Once every Claude Code session is closed, restore it: test -s …` —
over a live store whose 1,195 observations all read.

**How often** — `scripts/pK3.mjs <variant> <seed> 200` (doctor's step emulated as checkFTSIntegrity, then rebuildFTS
when unhealthy; oracle = `plants.record` of the template vs `plants.readable` of the copy, every ordinary table, every
row):

| population | plants whose every truth row reads intact | new step refuses `damaged`, old step kept every row | …and the old step finished with no error |
|---|---|---|---|
| main:21 (200) | 96 | 25 | 4 (main21-15, -92, -96, -174) |
| log:23 (200) | 123 | 25 | 4 (log23-26, -41, -78, -102) |
| two:22 (200) | 46 | 1 (two22-118: real doctor never reaches its FTS step — schema page damaged, it prints "FTS5 index: missing") | 0 |

Spot-checked with the real doctor: main21-13, -14, -15, -112, log23-26, -78, -170 all print the set-aside command.
Also lost to the all-or-nothing transaction: e215aba4 rebuilt the three healthy FTS tables when one failed; the new
step rebuilds none (main21-13, -14, -112, log23-170 above).

**Cause:** "quick_check read anything but `ok`" is treated as "a rebuild here can overwrite rows" and routed to the
remedy for an unopenable store, with no distinction for damage that cannot reach a row (FTS shadow tables, leaked
pages, fragmentation counts) and no remedy that keeps the rows the store still reads.

---

## F2 — P2, REAL SHAPE: `fts-check rebuild` / `mem_fts_check rebuild` refuse repairs e215aba4 completed, and send the user to a doctor run that prints no remedy

**Where:** `cli/fts-check.mjs:61-65`, `server/fts-check.mjs:30-37`, text `lib/db-unusable.mjs:156-161`; classification
as in F1 (`lib/checked-write.mjs:86`).

**Repro:** `D546_WORK=<work>/d546N node scripts/pN-indexflow.mjs log 23 22` (plant log23-22: one page of
`idx_obsfiles_filename` damaged; quick_check before: `Fragmentation of 49 bytes reported as 1 on page 57 / Page 483:
never used / Page 486: never used`):
- e215aba4 `fts-check rebuild`: exit 0, `Successfully rebuilt: …, indexes`; quick_check after: only the two leaked pages.
- 52f4979c `fts-check rebuild`: exit 1, `Not rebuilt: the store is damaged (quick_check: Page 483: never used) … Run
  \`…cli.mjs doctor\`: it checks the backup snapshots and prints the command that restores the newest one that
  passes.` The damaged index stays as it was (quick_check after = before).
- 52f4979c doctor on the same store: `✓ FTS5 integrity: all indexes healthy`, no ✗, no restore command (doctor's FTS
  step runs only when FTS5 is unhealthy), so the pointer leads nowhere.

Counts (`pK3`, CLI face = rebuildIndexes): refused `damaged` on all-rows-intact plants while the old run kept every
row: main21 38, log23 51, two22 28; of those the old run finished with no error: 4, 5 (log23-22, -26, -41, -78, -102),
1 (two22-73). The over-refusal itself is the trade-off the spec pre-registered (u4); the defect reported is the wrong
next step. If refusing a repair the old code completed is judged a regression ("exits wrong"), this is P1.

---

## F3 — P2, REAL SHAPE: doctor's read-only pre-read says "the store reads damaged" for FTS-index-only and index-only damage, and points at database checks that say ✓

**Where:** `install.mjs:491-514` (`readOnlyStoreDamage`: any non-`ok` `quick_check(1)` line), `install.mjs:3083-3087`.

`PRAGMA quick_check` runs FTS5's xIntegrity (bundled `sqlite3.c` `fts5IntegrityMethod`, line 264162:
`UNUSED_PARAM(isQuick)`), so index-only FTS damage is a quick_check line. Readings (`scripts/pA-doctor-fts-only.mjs`,
`scripts/pB-doctor-crosslink.mjs`, `scripts/pN-indexflow.mjs main 21 51`):
- FTS-only damage (`DELETE FROM observations_fts_data WHERE id > 10`, pages sound, 300 rows): e215aba4
  `✓ MCP registration: "mem-lite" registered`; 52f4979c `⚠ MCP registration: not checked — the store reads damaged
  (fts5: corruption found reading blob 2336462209025 from table "observations_fts"), and checking starts the MCP
  server, which writes to it. See the database checks below.` — and the checks below then print `✓ FTS5 rebuilt:
  observations_fts, session_summaries_fts, user_prompts_fts, events_fts`. Same with only events_fts damaged.
  Warnings 2 → 3. The duplicate-registration check is skipped on a store it could check safely (the server's own
  FTS rebuild is now the checked one).
- One ordinary index page damaged (main21-51): `⚠ … the store reads damaged (Multiple uses for byte 3286 of page
  195) … See the database checks below`, then `✓ FTS5 integrity: all indexes healthy`; the repair (`fts-check rebuild`,
  which succeeds there on both trees: quick_check after = ok) is named nowhere.
- Cross-linked freelist, FTS healthy (`writeCrossLinkedStore`, `ftsDamage:false`, not VACUUMed): the only mention of
  the page damage is that ⚠ on the MCP line; the database section is all ✓, no ✗, no remedy.

**Cause:** one read decides two things — whether starting the server is safe (it is, for FTS/index-only damage, now
that the server's rebuild is checked) and whether the user hears about damage — and the second has no line of its own.

---

## F4 — P2, REAL SHAPE (large stores): the in-transaction check holds the write lock past a hook's 3.5 s budget; a writer with that budget gets SQLITE_BUSY where e215aba4 let it through

**Where:** `lib/checked-write.mjs:76` runs a whole-store `quick_check` while BEGIN IMMEDIATE holds the write lock;
`lib/maintain-core.mjs:1281` (maintain + the MCP idle pass, `server.mjs:2324`). Hooks wait at most HOOK_DB_DEADLINE_MS
= 3500 ms and then drop the write (`lib/time-constants.mjs:57-72`); user-prompt-search waits 500 ms (`:96`).

**Repro:** `node scripts/pP-cost.mjs 150000` — 363 MiB synthetic store (150,000 observations, 120 random words each),
a second process inserting one row every 50 ms with `busy_timeout = 3500` (a hook's budget), 3 runs per arm, run
sequentially old×3 then new×3 (not ABBA; CPU otherwise idle):

| arm | lock-holding call, ms (3 runs) | median | writer: longest successful wait per run | writer SQLITE_BUSY (write dropped), 3 runs |
|---|---|---|---|---|
| e215aba4 direct FTS5 optimize | 1726 / 1711 / 1739 | 1726 | 1632 / 1531 / 1631 ms | 0 |
| 52f4979c optimizeFts | 3749 / 4537 / 4325 | 4325 | 184 / 830 / 631 ms | 3 |
| e215aba4 rebuildFTS | 9815 / 9951 / 9297 | 9815 | 2434 / 2631 / 1933 ms | 6 |
| 52f4979c rebuildFTS | 11599 / 11371 / 11350 | 11371 | 831 / 630 / 529 ms | 9 |

The optimize the MCP server runs unattended (once per server life, after 5 min without MCP calls — hooks keep writing
meanwhile) went from under the budget to over it on this store: 0 → 3 writes refused with SQLITE_BUSY (a hook drops such a write and exits, `lib/time-constants.mjs:57-71`). The rebuild faces were already
over it. Below a few tens of MiB the check costs tens of ms and nothing changes. Severity is P2 because it needs a store
of a few hundred MiB; if such stores count as the supported population this is a P1 ("rows e215aba4 kept").

---

## F5 — P3, REAL SHAPE: FTS5 optimize (maintain, MCP idle pass) refused by damage it does not touch; on a leaked-page store refused on every run

**Where:** `lib/maintain-core.mjs:1155-1160,1281-1288`, `server.mjs:2324-2331`. optimizeFts writes observations_fts only,
but its in-transaction quick_check reads every FTS table and every page.

Repro (`node scripts/arm.mjs <tree> opt <db>` on a store with only `events_fts_data` leaf rows deleted): e215aba4
`{"check":"direct","committed":true}`; 52f4979c `{"check":"damaged","committed":false,"lines":["fts5: corruption found
reading blob 137438953473 from table \"events_fts\""]}` → maintain prints `FTS5 index not optimized, nothing written:
the store is damaged`. On a store with a leaked page (any F1 "never used" plant) the idle optimize is refused on every
server start. Search latency only; no row effect.

---

## F6 — P3, REAL SHAPE (uncommon): a read-only store file gets "run doctor again when no session is writing"

`install.mjs:3274-3276`, `lib/db-unusable.mjs:161`. Repro `scripts/pH-readonly.mjs` (FTS-damaged store, mode 0444):
e215aba4 `✗ FTS5 rebuild errors: observations_fts: attempt to write a readonly database, …`; 52f4979c `✗ FTS5 not
rebuilt: observations_fts: attempt to write a readonly database. Nothing was written.` then `Run doctor again when no
session is writing to the store.` Repeating never helps. BEGIN IMMEDIATE succeeded on the 0444 file; the first step
failed with SQLITE_READONLY (`unchecked`), and `unchecked` always gets the busy hint.

---

## F7 — P3, CONSTRUCTED: `fts-check rebuild` prints "Nothing was written" after its own opener committed row-overwriting writes

`cli/fts-check.mjs:59-64` runs after mem-cli's opener has written. Repro `scripts/pF-symlink.mjs` (fixture without
`prepare`: a store initSchema built that the product opener never opened — the same shape as the first open after an
upgrade that migrates): 52f4979c CLI exit 1, `Not rebuilt: the store is damaged … Nothing was written.`; main file
unchanged, but rows readable through the log 288/300 (the opener's first-open writes, committed to the log). With
`prepare` (`scripts/pG-opener-writes.mjs`): 300/300, log unchanged. Migration writes are outside the change's stated
scope; listed because the sentence is printed by the new code.

---

## Pre-existing or acknowledged (same on e215aba4; not regressions)

- VACUUMed store: the pre-read's quick_check is partial (lesson #1051), misses the freelist cross-link, and `claude mcp
  list` still starts the server. `scripts/pO-vacuum-mcp.mjs` (stand-in that starts server.mjs for 2 s): VACUUMed
  cross-link e215aba4 288/300, 52f4979c 288/300; not VACUUMed e215aba4 288/300, 52f4979c 300/300. Stated in the commit.
- Every other CLI command still checkpoints a log-only damage into the main file on close: `recent 3` and `fts-check
  check` on the inLog fixture changed the main file on both trees (`scripts/pG-opener-writes.mjs`, mainSame=false
  for both; rows 300/300 because nothing allocated). The holder covers only the rebuild faces.
- After a refused rebuild the opener still calls `ensureDb()` (`schema.mjs:1907`), whose initSchema / cleanups write on
  a store the check just called damaged; hooks write. Out of scope per the commit.
- Unchecked FTS rebuilds remain in migrations: `schema.mjs:797`, `:2176`, `:2220`. Out of scope per the commit.
- The restore / set-aside command `mv`s a symlinked store path (the link, not its target) and writes a regular file in
  its place (`lib/db-unusable.mjs:451-457,591-605`); read, not run. Pre-existing, now also reached from F1.

## Checked and found sound (readings)

- **Core claim, cross-linked freelist** (`scripts/pC-core.mjs` + own builder `scripts/xlink.mjs`; old = e215aba4
  functions / direct optimize, new = shipped functions; rows by `intactObservations`): 14 shapes — 300 / 6,000 / 20,000
  observations, diverse words (FTS segment flushes), links 1/3/4/8, planted at the first or last trunk slot or at the
  table's last leaves, VACUUMed or not, 4 KiB and 64 KiB pages, and a 282,090-page store (1.1 GiB, past the lock-byte
  page). Wherever the old rebuild / REINDEX / optimize lost rows (288, 276, 5994, 5995, 5957, 19972 of N) the new one
  refused and kept N/N; where the old one lost nothing the new one committed `ok` or refused; never a loss.
- **Generator plants:** 596 openable plants (main:21, two:22, log:23 × 200): the new rebuildFTS left every truth row of
  every ordinary table as it found it in all 596 (`scripts/pK2.mjs`, `newKept=true` in every bucket).
- **Writer in another process** (`scripts/pD-race.mjs`): 60 s, checked optimize/rebuildFTS looping in one process,
  two "hook" processes each open RW → insert → close, one process cycling PASSIVE/FULL/RESTART/TRUNCATE
  checkpoints: 9,031 checked writes all `ok` (0 `damaged` on a sound store), 109 hook rows all present, integrity ok,
  hook waits up to 3,435 ms (overlap shown; 27 hook BUSY because the checked loop never yields). Holder pattern
  (holdOpen + RW rebuildIndexes + close, two processes) against the same hooks, 45 s: 1,813 cycles all `ok`, 3,609 hook
  rows all present, 455 hook waits > 5 ms, integrity ok. No own-fd reads of store files anywhere in the change.
- **Log-only damage + holder:** inLog fixture through a symlinked store file (`scripts/pF-symlink.mjs`; prepared
  variant in `pG`): new CLI and doctor left the real main file byte-identical (old changed it, 288/300).
- **Auto-rollback:** SQLITE_FULL at optimize (`max_page_count = page_count`) → `unchecked`, store fingerprint unchanged
  (`scripts/pE-autorollback.mjs`). NOMEM could not be injected (`hard_heap_limit` had no effect here) — not verified.
- **FTS5 xIntegrity** failures other than CORRUPT abort the statement (OP_VCheck) rather than appear as a line, so they
  are classified by code (read in the bundled `sqlite3.c`, line 264162).
- **External-content drift** (a content row with no index entry) reads `ok` in quick_check (iArg 0), so ordinary
  trigger drift does not refuse a rebuild (`scripts/p1-fts-quickcheck.mjs`).
- **Sound stores:** doctor's MCP line unchanged (`✓ MCP registration: "mem-lite" registered` on both trees, pA); a
  FTS-only-damaged store is repaired by both trees' doctor with 300/300 rows.
- **Tests:** `npx vitest run tests/checked-write.test.mjs tests/rebuild-checked.test.mjs
  tests/rebuild-refusal-faces.test.mjs tests/snapshot-check.test.mjs tests/wal-recovery.test.mjs` in `tree/`: 5 files,
  133/133 passed. Full suite not run.

## Not checked

auto_vacuum=FULL stores (page moves at COMMIT happen after the check; I could not plant a lasting freelist in FULL
mode); NOMEM / IOERR inside a step; a holder whose read fails (`holdOpen` returns null where `closeWithoutCheckpoint`
keeps a guard whose read failed — code reading only, `lib/checked-write.mjs:113-127` vs `schema.mjs:1761-1776`; no face
I could build reaches it); the holder at `install.mjs:3223-3224` is not closed if `new Database(DB_PATH)` throws (code
reading only).

## Cost readings

In F4. Disk/CPU: one machine, `capped.sh 6G`; timings are single-host and not ABBA-ordered.
