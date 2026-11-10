> 归档：D#593 第 3 次尝试 r1 说法视角报告原文（子代理，审 e215aba4..52f4979c）。脚本留在 /home/ai/.cache/tmp/rv-d593c-claims/scripts。

# D#593 attempt 3 (e215aba4..52f4979c) blind review: claims lens

- **Reviewed**: commit messages b9706a55, 5b772004, 52f4979c; code comments, JSDoc, test names and test comments in `git diff e215aba4..52f4979c`.
- **Tree**: `tree/` = `git archive 52f4979c` (`.tree-sha` reads `52f4979c`), its own node_modules (better-sqlite3 13.0.3, `sqlite_version()` = 3.53.4). The repository and its working tree were only read (`git log/diff/show/archive/check-ignore`).
- **Sandbox**: TMPDIR, HOME and CLAUDE_MEM_DIR under `~/.cache/tmp/rv-d593c-claims/tmp`; `*_API_KEY`, `*AUTH_TOKEN`, `CLAUDE_CONFIG_DIR` removed from child envs; heavy probes through `tasks/d593/capped.sh` (4–8G caps), one at a time. Mutation runs restored every file from `orig/` and were checked byte-equal with `cmp` after each batch (all equal).
- **Baseline before mutations**: `npx vitest run` of checked-write, rebuild-checked, rebuild-refusal-faces, snapshot-check, wal-recovery → 5 files, 133/133 passed.
- **Scripts and raw outputs**: `scripts/` (p1…p14, `mutate.mjs` + `mutations.json`, `mutate*.out`). p7-F7 ran on a temporary tree copy with the doctor pre-read removed (since deleted). Its output is `scripts/p7-F7-inlog-server.out`.

## Findings, ranked by how much a reader would be misled about data safety

### 1. VACUOUS TEST: the optimize tests pass with an unchecked optimize

- **Claims**: `tests/rebuild-refusal-faces.test.mjs:244` "optimizeFts commits on a sound store and writes nothing on a cross-linked one"; `:264` "maintain says the index was not optimized" (asserts `intactObservations(...) === 300`); commit 5b772004: "maintain's FTS optimize and the MCP idle pass's: both through optimizeFts"; "each turn red when their refusal branch or holder is removed".
- **What the fixture does**: both tests use `crossLinked(..., { vacuum: true })`, whose default `ftsDamage: true` deletes `observations_fts_data` leaf rows. On that store FTS5 `optimize` throws `SQLITE_CORRUPT_VTAB` before it writes, so even the old, unchecked optimize writes nothing and loses no row.
- **Probe p11** (direct optimize vs `optimizeFts`, intact rows of 300):

  | vacuum | ftsDamage | direct optimize | optimizeFts |
  |---|---|---|---|
  | false | true | throws CORRUPT_VTAB, 300 | damaged, 300 |
  | false | **false** | runs, **288** | damaged, 300 |
  | true | true (the tests' shape) | throws CORRUPT_VTAB, **300** | damaged, 300 |
  | true | false | runs, 300 | ok (committed), 300 |

- **Mutations**:
  - F14b: `optimizeFts` replaced by a direct optimize with no transaction and no check, its error classified by code. Result: **all 3 optimize tests GREEN**.
  - CW1: in-transaction `quick_check` removed from `checkedWrite`, run over the whole refusal-faces file. Result: 6 red, and 5 survive. Both optimize tests are among the survivors.
- **Product behaviour is right**: on the shape where an optimize does overwrite rows (non-VACUUM, sound FTS), `optimizeFts` refuses and all 300 rows stay. No test exercises that shape, and the idle pass that runs this unattended (D#595/D#761) is the reason the helper exists.
- **Correction**: plant the optimize fixtures with `ftsDamage: false` (non-VACUUM), and assert the premise that a direct optimize leaves fewer than 300 rows. Until then, drop "writes nothing on a cross-linked one" from the test name.

### 2. FALSE (fixture doc) + VACUOUS TEST arms: the VACUUM shapes cannot tell the rejected pre-write design from the shipped one

- **Claims**:
  - `tests/test-helpers.mjs:542-543`: "`vacuum` VACUUMs the store before the freelist is made; SQLite 3.53.4's integrity check then starts at a virtual table, skips the freelist and reads 'ok' on this store."
  - Commit b9706a55: "Why after the write, not before it: a pre-write quick_check skips the freelist on every VACUUMed or restored store".
  - Test headers `tests/checked-write.test.mjs:1-5` and `tests/rebuild-checked.test.mjs:1-3`: "...even on a VACUUMed store whose check skips the freelist".
- **Readings (p1, all 8 shapes, default `ftsDamage: true`)**:
  - Pre-write `quick_check` on the 4 VACUUM shapes: `fts5: corruption found reading blob 2473901162497 from table "observations_fts"`, not `ok`. `integrity_check` reads the same.
  - The 4 non-VACUUM shapes: `Tree 5 page 5 cell 4: 2nd reference to page 66`.
  - So on every fixture the suite uses, a pre-write check already refuses.
- **The fixture doc holds only with `ftsDamage: false`** (p4/p12: pre-write `quick_check(1)` = `ok` on VACUUM shapes).
- **CW11 mutation** (a pre-write `quick_check` gate, the in-transaction check removed):
  - Survives all of `rebuild-checked` (8/8), all of `rebuild-refusal-faces` (11/11) and `wal-recovery` (11/11).
  - In `checked-write` it survives all 8 cross-link shapes plus both holder tests. It dies there only on "reads a step that fails with corruption as damaged" (because `failedStep` is no longer `'indexes'`).
  - In `snapshot-check` it dies on 17 tests. These die because a pre-write gate refuses snapshots that REINDEX would repair (an unrelated property).
  - No cross-link test can say NO to the design the commit argues against.
- **The design argument itself holds, shown by this review's probe p12, not by the change** (VACUUM, `ftsDamage: false`):
  - The pre-write check reads `ok`.
  - A direct rebuild leaves 288 rows (links 1) or 276 (links 3).
  - `rebuildFTS`/`rebuildIndexes` refuse with 300/300.
  - The in-transaction lines include `Tree 20 page 20 cell 0: 2nd reference to page 65`.
- **Correction**:
  - Delete "and reads 'ok' on this store" from the fixture doc, or make it true with `ftsDamage: false`.
  - Add VACUUM arms with `ftsDamage: false` that assert the premise: pre-write `quick_check` = `ok`, and a direct write loses rows.

### 3. OVERSTATED (user-facing): "Nothing was written." is true of the rebuild, not of the command that prints it

- **Claims**:
  - `lib/db-unusable.mjs:150-151` (CLI and MCP refusal text): "...a rebuild on a damaged store can overwrite rows. Nothing was written."
  - Test "fts-check rebuild (CLI): exits 1 with the refusal, keeps every row…".
- **Mechanism**:
  - `cli.mjs fts-check rebuild` opens the store through the product opener before the checked rebuild runs.
  - On the first open of a store by this code, the opener writes. p14 counted 7 writing statements on the first open and 0 on the second: `INSERT OR IGNORE INTO migration_cleanups…` and `INSERT INTO migration_cursors…`.
  - The test avoids this with `prepare` (`tests/rebuild-refusal-faces.test.mjs:50-51`: "The product's opener writes on its first open of a store initSchema built; on these pages any write can overwrite rows, so it runs once before the damage is planted").
- **Probe p13** (`cli.mjs fts-check rebuild`, rows of 300):

  | fixture | exit | printed | intact (with log / main only) |
  |---|---|---|---|
  | inLog, prepared | 1 | "Not rebuilt: the store is damaged … Nothing was written." | 300 / 300 |
  | inLog, **not prepared** | 1 | same sentence | **288** / 300 |
  | vacuum, prepared | 1 | same | 300 / 300 |
  | vacuum, **not prepared** | 1 | same | **288** / 300 |

- **Population**: a store whose first open by this code version still has a deferred cleanup or migration cursor to write. In practice that is the first open after an upgrade that adds one.
- **Disclosure**: the commit's "Not in this change: ordinary hook writes…" covers the mechanism. The sentence the user reads does not.
- **Correction**: "The rebuild wrote nothing." (or drop the sentence).

### 4. OVERSTATED (user-facing): the refusal text promises a restore command; doctor may instead give "set the store aside, start fresh" on a store whose rows all read

- **Claims**:
  - `lib/db-unusable.mjs:160`: "Run `doctor`: it checks the backup snapshots and prints the command that restores the newest one that passes."
  - Commit 5b772004: "on damage the restore remedy the open-failure path gives (it checks the snapshots)".
- **Reading (p7, in-log fixture, no snapshots)**:
  - Doctor prints "✗ FTS5 not rebuilt: the store is damaged (quick_check: Tree 5 page 66 cell 262: Rowid 263 out of order)…".
  - It follows with "No backup snapshot exists beside the database. Once every Claude Code session is closed, set the broken file aside so a fresh store is created on the next session: … mv …".
  - That store reads 300/300 intact rows.
- **What `dbCheckRemedy` does**: it returns `set-aside` when no snapshot exists (`lib/db-unusable.mjs:493-498`, `install.mjs:550-554`).
- **Correction**: "Run doctor: it checks the backup snapshots and prints what to do next." The remedy itself, reused from the "store will not open" path for a store that opens and reads, is a defects-lens question.

### 5. FALSE: "Five guard tests … restated, verdicts unchanged"

- **Claim**: commit 5b772004: "Five guard tests pinned the old shape and are restated, verdicts unchanged: snapshot-check's rebuild error text…, a failing REINDEX now rolls the FTS rebuilds back…, and the opener's busy-deadline line…".
- **Diff**:
  - Pre-existing tests changed in 5b772004 are snapshot-check ×3 (`tests/snapshot-check.test.mjs:136`, `:159`, `:480`), wal-recovery ×1 and checked-write ×1. The message describes 4.
  - The fifth, `checked-write.test.mjs` "stops at the first failing step and writes nothing", **flips its verdict** from `check: 'unchecked'` to `check: 'damaged'` (`git diff b9706a55 5b772004 -- tests/checked-write.test.mjs`).
  - That flip comes with an unmentioned change to `lib/checked-write.mjs`. Commit 1 read only CORRUPT/NOTADB as damaged. Commit 2 reads every code outside `BUSY|LOCKED|FULL|IOERR|NOMEM|CANTOPEN|READONLY|INTERRUPT|PERM` as damaged. The spec counts "snapshot-check 4", but the diff shows 3.
- **Data-safety effect**: on such a refusal the user is told "the store is damaged … restore", not "run it again".
- **Correction**: "Four guard tests are restated, verdicts unchanged; checkedWrite now reads a step failure with a non-environment code (SQLITE_ERROR, CONSTRAINT…) as damaged, and its test changes verdict accordingly."

### 6. VACUOUS TEST (partly): "changes no byte of the store" asserts the main file only

- **Claim**: `tests/rebuild-refusal-faces.test.mjs:116` "reports one ✗ for a rebuild it did not commit, and changes no byte of the store".
- **Assertions**: `sha(p)` of the main file, plus observation rows.
- **Mutation F16**: doctor runs `PRAGMA user_version = 7` on `rwDb` after the refused rebuild, which commits a frame to the log. The holder keeps the checkpoint out of the main file. Result: **GREEN**.
- **Today's behaviour is right**: p7 shows main and log sha1 unchanged (`c7e10e458fca` / `5fa7ab2ed884` before and after).
- **Correction**: also compare `sha(p + '-wal')`, or rename to "…and changes no byte of the main file".

### 7. OVERSTATED: "each face turns red when its refusal branch or holder is removed", and the per-face bullets

- **Claim**: commit 5b772004: "the opener, doctor, CLI, MCP, snapshot, maintain and idle faces each turn red when their refusal branch or holder is removed". The bullets list "the error carries ftsRebuildRefused" and doctor's "restore remedy".
- **Survivors among this review's mutations**:
  - F3: `ftsRebuildRefused` never set → GREEN. `git grep ftsRebuildRefused` at 52f4979c finds only the setter (`schema.mjs:1913`): nothing reads it and no test asserts it.
  - F6: doctor's restore remedy not printed → GREEN.
  - F15b: the idle pass's refusal branch (`else debugLog('WARN', …)`) removed → GREEN.
  - F15c: the idle pass falls back to `VALUES(" + "'optimize')` on refusal → GREEN. That one is contrived: the idle test is a source-text scan, as its own comment says.
  - F12: probe's `rebuildCheck` dropped → GREEN in refusal-faces. It is killed in `snapshot-check.test.mjs` "reports a full disk during the rebuild with its code" (F12b), so it is covered across files.
- **Killed** (each by the named test): F1, F2 (opener), F4, F5, F7, F7b (doctor), F8, F8b, F9 (CLI, holder ordering included), F10 (MCP), F11 (snapshot), F13, F14 (maintain), F15 (idle reverted to a direct statement), F17 (pre-read without the binding gate → `doctor-install-shape-e2e` red).
- **Correction**: name what is pinned:
  - holders, refusal text, exit code and verdict on six faces;
  - the idle pass only by a text scan;
  - `ftsRebuildRefused` and doctor's remedy line untested.
  - Or drop `ftsRebuildRefused`, which nothing reads.

### 8. OVERSTATED / UNVERIFIABLE: the regression set R

- **Claim**: commit 5b772004: "Regression set R (2,969 planted stores, pre-registered in tasks/specs/d593-attempt3.md), prototype arms: every arm where the old direct rebuild lost or changed rows rolled back (R2); the one R1 reading against the new arm is a byte-identical file the reader reads as 3848/3850/3851 rows across ten runs."
- **Unverifiable from the repository**: `git check-ignore -v tasks/specs/d593-attempt3.md` → `.gitignore:47:tasks/`. A clone gets neither the pre-registration nor the scripts, and CLAUDE.md asks for evidence in the tracked appendix. Locally the spec has the numbers: 2,969 samples, 2,953 open.
- **Population left out**:
  - R2's positive set is **67 arms**: doctor log 11, main 21, vac:main 1; reindex log 11, main 21, two 1, vac:main 1.
  - The same spec reports **2,322 arms where the new code refused while the old rebuild lost nothing**: doctor 965, reindex 1,357. That is about 35 refusals per harmful case.
  - The commit gives neither number. That is the cost side: on those stores search stays broken until a restore or set-aside.
- **Framing**: the spec records R1 as "failed by the letter, passed on attribution". The commit only gives the attribution.
- Not re-measured. The spec's later A3 rerun on 5b772004 reads R1/R2 pass, bytes-differ 0.
- **Correction**: give the population ("67 arms on which the old rebuild lost or changed rows; all rolled back; 2,322 further arms refused where the old rebuild lost nothing") and move the pre-registration into a tracked file, or cite it as untracked.

### 9. FALSE (test comment) / OVERSTATED (JSDoc): the lost-transaction stop and "FULL / IOERR / BUSY / NOMEM"

- **Claims**:
  - `lib/checked-write.mjs:25-27`: "Stops at the first step that throws, and at a step after which the transaction is gone (SQLITE_FULL / IOERR / BUSY / NOMEM can roll it back by themselves; the next statement would then commit on its own, unchecked)". Commit b9706a55 says the same.
  - `tests/checked-write.test.mjs:153-154`: "SQLITE_FULL / IOERR / BUSY / NOMEM can roll the whole transaction back by themselves; a step that does it on purpose stands in for them."
- **What the code does**: a step that fails with one of those codes **throws**, so `checkedWrite` returns from the catch before it reaches `if (!db.inTransaction)`. The stop fires only for a step that ends the transaction **without** an error (a literal `ROLLBACK`).
- **Probe p9** (a real automatic rollback): `ulimit -f` with SIGXFSZ ignored, `cache_size = 10`, a 2,000-row insert step. Result: `{"threw":"SQLITE_IOERR_WRITE","inTxnAfter":false}`, `check: 'unchecked'`, `failedStep: 'big'`, 0 rows after. The transaction was gone, and the throw branch handled it.
- **The behaviour is safe**:
  - The rationale points at a branch the named errors never reach.
  - The stand-in test does not stand in for them.
  - The real protection is pinned by "stops at the first failing step" (CW3 killed).
- **Correction**: drop the parenthesis, or say "a step whose SQL ends the transaction". Delete "stands in for them".

### 10. OVERSTATED: "a `claude` stand-in that really starts the server for 2 s"

- **Claims**: commit 52f4979c: "a `claude` stand-in that really starts the server for 2 s ends at 300/300 (was 288)". `tests/rebuild-refusal-faces.test.mjs:137`: "A stand-in that really starts it for two seconds".
- **Reading**:
  - The stand-in runs `server.mjs < /dev/null`, and the server exits on stdin EOF by itself. p2 with stdin `ignore` (= /dev/null) gives `selfExitMs=134` and `149`.
  - `kill -TERM` after `sleep 2` hits an exited pid.
  - The startup write still happens within that window: 288/300 without the pre-read (p7-F7) and 300/300 with it (p7).
- **Correction**: "a stand-in that really starts the server (it exits on stdin EOF after ~0.15 s)", or keep stdin open.

### 11. FALSE (JSDoc): "its code SQLITE_CORRUPT when the store read damaged"

- **Claim**: `schema.mjs:1998-1999`.
- **Code**: `codes.push(r.code ?? (r.check === 'damaged' ? 'SQLITE_CORRUPT' : null))` keeps the failing step's own code. The restated `snapshot-check.test.mjs:480` test asserts `SQLITE_CONSTRAINT_UNIQUE` on a damaged refusal, and a fts-config store gives `SQLITE_ERROR`.
- **Correction**: "its code the failing step's, or SQLITE_CORRUPT when the check reported the damage".

### 12. Stale or contradicted prose in the changed region (FALSE / OVERSTATED, low)

- **`lib/db-unusable.mjs:143-144`** (`notRebuiltReason`): "otherwise the write could not be made or checked (busy, a failing step)". A failing step with a store-own code is `'damaged'` (finding 5).
- **`tests/checked-write.test.mjs:122`**: "A failure of the store's own (here SQLITE_ERROR) is damage". The SQLITE_ERROR is "no such table" from the test's own SQL. The module confines damage to failures "on tables that exist" (`lib/checked-write.mjs:17-18`).
- **`lib/checked-write.mjs:17-19`**: "Any other failure … is the store's own". Environmental codes not listed, such as SQLITE_PROTOCOL and SQLITE_ABORT, would read as damaged. This is from source only, not reproduced.
- **`install.mjs:481-490`**: the new `readOnlyStoreDamage` docblock (starts at 484) was inserted between `dbCheckRemedy`'s docblock (ends at 483) and `dbCheckRemedy`. "Exported for tests/doctor-db-remedy.test.mjs…" now sits above the unexported `readOnlyStoreDamage`, and `dbCheckRemedy` has none.
- **`schema.mjs:1969`, `:1973`, `:2041`**: the `rebuildFTS`/`rebuildIndexes` `@returns` lack `check` and `lines`. "Safe to call at any time — rebuilds are idempotent" was left on the function this change exists to gate.
- **`tests/test-helpers.mjs:538-540`**: the `writeCrossLinkedStore` docblock lost two lines in the copy ("still uses: the page-level damage on which an index rebuild overwrites rows, because the rebuild"). Line 539 is blank, and the sentence now reads "the observations table / frees and allocates pages". The commit says the fixtures "come from attempt 2's branch unchanged". The four functions are byte-identical to `archive/d593-page-check` (sha1 of each function body equal); the docblock is not.
- **`lib/checked-write.mjs:108`** (`holdOpen`): "null when the store cannot be opened read-only". It also returns null when it opens but the read fails. `closeWithoutCheckpoint` (schema.mjs) keeps such a handle on purpose ("takes the lock all the same").
- **CW9**: "Runs `steps` in one IMMEDIATE transaction". `BEGIN` instead of `BEGIN IMMEDIATE` survives "writes nothing when another connection holds the write lock". IMMEDIATE is not pinned. The test name holds either way.

### Notes (true, with a qualifier the text drops)

- **Doctor gate** (52f4979c): "the fresh-process binding probe passed". It is `!bindingBrokenHere`, i.e. no probe of PROJECT_DIR failed. It is the same gate as the database checks (`install.mjs:2628`, `:3188-3190`), so "behind the database checks' own gate" is exact.
- **Idle pass**: "D#761 keeps the idle pass: it saves about 5 ms per search at p50" and `lib/maintain-core.mjs:1276` "worth keeping (3.4 vs 8.0 ms)". This matches `docs/measurement/findings.md:1686-1712` (1,211-observation copy, 300 prompts, ABBA×6: 3.380 vs 8.026 ms p50). That measurement predates the added in-transaction check. The spec's A4 records optimize 1,039 → 3,226 ms on 577 MiB, i.e. a write lock held about 3× longer, once per MCP process. No commit message mentions it.
- **Cost of doctor's read**: "2.06 s (median of 3, hot cache, measured beside another ruler's run)" on 577 MiB is stated with its population and caveat, and matches the spec (2,056 ms). Not re-measured. "O(store size)" agrees with SQLite's documented O(N) for quick_check.

## Claims checked and found true

| Claim (where) | Check | Reading |
|---|---|---|
| Probe P: direct rebuild left 288 or 276 of 300 on all 8 shapes; checked rolled back on all 8 with 300/300, main unchanged (b9706a55) | p1, tree's `rebuildIndexes` + `holdOpen`, and `rebuildFTS` | links 1 → 288/288, links 3 → 276/276 (with log / main only), 8/8. Checked: `damaged` 8/8, 300/300 both readings, main sha1 unchanged 8/8 |
| A reused cross-linked page sits in two trees and the in-transaction check reports it, VACUUMed or not | p1 full lines | VACUUM links 1: `Tree 20 page 20 cell 0: 2nd reference to page 65`; non-VACUUM: `Tree 33 page 33 cell 0: 2nd reference to page 66` |
| SQLite 3.53.4's integrity check skips the freelist when a virtual table sorts first | bundled `sqlite3.c:146568` (`if( HasRowid(pTab) ) aRoot[++cnt] = pTab->tnum;` puts a vtab's tnum 0 into `aRoot[1]`), `:103891` (`&aRoot[1]` passed), `:84392-84396` (`aRoot[0]==0` → partial; `bCkFreelist = 0` unless next root is 1); `:84487`/`:84495` never-used check also skipped | Source confirms |
| …as on every VACUUMed or restored store | p10, product schema, freelist leaked | fresh: `Page 64: never used…`; after VACUUM: `ok`; after VACUUM INTO (the snapshot path, `lib/db-backup.mjs:154`): `ok`. One schema tested |
| A read-only connection's close never checkpoints | p4: in-log fixture, the RO handle the only connection, `quick_check(1)`, close | main and log sha1 unchanged (log 103,032 B kept). Control RW close: main changed, log deleted |
| holdOpen across a RW close prevents the checkpoint | p1 (8/8 main unchanged); CW4 (no read in holdOpen) → red | killed |
| `claude mcp list` starts the server | sandbox HOME, `claude mcp add -s user markersrv -- marker.sh`, `claude mcp list` (2.1.322) | marker logged one start. `--help`: "approved servers are health-checked" |
| The server writes on start; 288 of 300; SIGKILL too → a committed startup write (52f4979c) | p2, prepared in-log fixture, stdin kept open | SIGTERM: 288/288, log gone; SIGKILL: 288 with log / 300 main only, main sha1 unchanged, log 144,232 B. `server.mjs:273` runs `PRAGMA optimize=0x10002` at start |
| Doctor left 288 before; 300/300 now; removing the read turns the test red | p7 with the server-starting stand-in; p7-F7 (read removed); F7 | now 300/300, `mcp list` not run, line "MCP registration: not checked — the store reads damaged (Tree 5 page 5 cell 4: 2nd reference to page 66)…"; without the read 288/288; F7 killed |
| A sound store still gets its registration line | F7b (sound store read as damaged) | killed |
| "Not closed: a VACUUMed store's check skips its freelist … cannot see every damaged store" | p4 + p7 on VACUUM + `ftsDamage: false` | pre-read `ok`; doctor ran `mcp list`; rows 300 → 288. The disclosure is accurate |
| The read sits behind the database checks' gate; doctor-install-shape-e2e catches an ungated read | F17 | killed (1 failed, the truncated-addon case) |
| One ✗ "FTS5 not rebuilt: the store is damaged (…)" | p7 output | exactly one FTS ✗; main and log unchanged |
| Rebuild + REINDEX + quick_check in one transaction, all or nothing; a missing table listed and skipped | RB1, RB2 killed; rebuild-checked missing-table test | as stated |
| "a full disk may now meet REINDEX first inside the one transaction" | p8, 5 runs | new: `not rebuilt: indexes: database or disk is full` 5/5; old: `observations_fts:SQLITE_FULL` 5/5 |
| ROLLBACK discards every page the write touched (spilled frames included) | p9 (`cache_size = 10`, a spill that fails) | 0 rows after; transaction gone |
| Opener: holder; no "DB recovered" after a refusal | F1, F2 | killed |
| CLI: holder closed at exit after mem-cli closes `db`; exit 1 | F8 (no holder), F8b (holder closed before mem-cli's close), F9 | all killed: the ordering is pinned |
| MCP text; snapshot "unchecked whatever its code" | F10, F11, F12b | killed |
| checkedWrite tests 1–8 (b9706a55: no check, no lost-transaction stop, continue after failure, no read in holdOpen, corruption as unchecked, failed COMMIT as committed; plus FULL as damaged, BEGIN failure ignored) | CW1–CW8, each asserted to land | all killed by the named test; CW10 (no ROLLBACK in finally) also killed |
| "Tests: 18" (b9706a55) | `git show b9706a55:tests/checked-write.test.mjs` | 15 + 3 = 18 |
| Fixture functions "unchanged" from attempt 2 | per-function sha1 vs `archive/d593-page-check` | `walChecksum`, `editLogPage`, `writeCrossLinkedStore`, `intactObservations` identical (docblock: finding 12) |
| "D#595: one optimize, 12 of 300" | p11 non-VACUUM, `ftsDamage: false` | direct optimize 288 |
| Every rebuild/optimize caller handled (seven faces) | `git grep rebuildFTS\|rebuildIndexes\|optimizeFts 52f4979c` (shipped) | 7 call sites: opener, doctor, CLI, MCP, snapshot probe, maintain, idle. The migration rebuilds (`schema.mjs:797`, `:2176`, `:2220`) are named as not in this change |
| Idle-pass numbers (≈5 ms p50; 3.4 vs 8.0) | `docs/measurement/findings.md:1686-1712` | 4.890 ms; 3.380 / 8.026 ms |
| SQLITE_FULL/IOERR/BUSY/NOMEM can roll a transaction back automatically | SQLite "Response To Errors Within A Transaction"; p9 (IOERR_WRITE → `inTransaction` false) | true of SQLite (which branch handles it: finding 9) |
| Closing any fd on a file drops the process's POSIX locks on it (attempt 2's P0) | SQLite "How To Corrupt", §2.2 (POSIX advisory locks cancelled by close) | true |

## Not re-measured

- The 577 MiB cost numbers.
- R and A3 (2,969 plants).
- The author's own 12 + 8 mutation runs. Their scripts are in gitignored `tasks/`; this review ran its own mutations, listed in `scripts/mutations.json`.
