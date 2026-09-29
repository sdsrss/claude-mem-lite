# D#47 — adjudication of v6.8.0 review P3-2/3/6/7/8/9 against main @ 46c48d1 (2026-09-25)

Read-only. Probe scripts are in this scratchpad (bench-backfill.mjs, race-backfill.mjs, p37.mjs, p37-mut.mjs,
p38.mjs, p39.mjs); every DB probe ran on :memory: or a mkdtemp file DB, which was removed afterwards.
Fresh check: `npx vitest run tests/observation-files.test.mjs tests/schema-backfill-observation-files.test.mjs
tests/import-jsonl-dedup-scrub.test.mjs` → 3 files / 25 tests passed.

| Item | Verdict | Fix changes shipped behaviour? |
|------|---------|--------------------------------|
| P3-2 | LIVE (test name only) | no |
| P3-3 | LIVE (comment only; the branch is still unreachable) | no |
| P3-6 | PARTLY LIVE: cost confirmed and one-time; the race reproduces but clears on the next open; there is no known persistent every-open loop | yes, slightly (lock scope) |
| P3-7 | LIVE (a strengthening that was never made) | no |
| P3-8 | LIVE: the credential leak reproduces (29/41 cut points) | yes (the title and its dedup key) |
| P3-9 | LIVE: all three tripwires still there, plus one silent-green gap the finding did not name | no |

None of the six has been fixed. `git log` shows no commit touching the relevant lines since the audit
(tests/observation-files.test.mjs was last changed in 36f8c0f, the prettier pass; the schema.mjs backfill is
unchanged since 0dc0a92, which introduced it; install.mjs `if (!last)` has been unchanged since 90ce347;
the import-jsonl-dedup-scrub guard's last touch was 4d8393c, which did not change the guard block).

---

## P3-2 — LIVE

tests/observation-files.test.mjs:59 and :68
```
describe('observation_files data migration', () => {
  ...
  it('insertObs populates observation_files from filesModified JSON', () => {
```
The body calls only the test helper `insertObs` (tests/test-helpers.mjs:111-118 writes
`INSERT OR IGNORE INTO observation_files` itself). `grep -c runDeferredCleanups tests/observation-files.test.mjs`
→ 0, so the block never reaches the backfill. The real coverage is tests/schema-backfill-observation-files.test.mjs.

Fix: a one-line rename. `describe('observation_files data migration'` → `describe('insertObs test helper populates the junction'`.
You could also delete the block, but other suites rely on the helper's side effect, so a helper self-test
is still worth keeping under an honest name. Test-only, so no shipped behaviour changes. There is nothing
to mutation-prove because the change is a label; the claim it rests on is the 0 count above.

## P3-3 — LIVE (the comment overstates; the code is harmless)

install.mjs:1757-1761
```
    const last = checks[checks.length - 1];
    // A detail before any check has nothing to attach to — same as today's drop, but the
    // human face would show it, so this is the one line the two faces cannot share.
    if (!last) return;
```
install.mjs:1810-1815 is the first check. It unconditionally calls `ok(...)` or `fail(...)`, and both push
onto `checks`. The first `log(` call site after the definition is at :1846, which follows `fail(...)` at
:1845. Nowhere in doctor() is `log` passed as a callback: grepping for `(log`, `, log)`, `log: log` and
`{ log }` between :1762 and :2698 finds nothing. So `!last` cannot be true today.

Fix: comment only. Keep the guard and reword the comment, for example
`// Unreachable today — the Node-version check at the top of doctor() always pushes first. Kept as a guard: a detail with no check to attach to is dropped under --json.`
No behaviour change, so nothing to prove beyond the reachability argument above.

## P3-6 — partly LIVE; the headline "retries on every ensureDb" holds only for a persistent failure

Code (unchanged since 0dc0a92), schema.mjs:1106-1117 and 1236-1244:
```
      const rows = db
        .prepare(
          `SELECT o.id, o.files_modified FROM observations o
            WHERE o.files_modified IS NOT NULL AND o.files_modified != '[]'
              AND NOT EXISTS (SELECT 1 FROM observation_files f WHERE f.obs_id = o.id)`,
        )
        .all();
      if (rows.length === 0) return;
      ...
      db.transaction(() => {
...
    try {
      run(db);
      mark.run(name, Date.now());
    } catch (e) {
      // Leave the marker unset → retried next open.
      debugCatch(e, `deferred-cleanup:${name}`);
```
The pass is marker-gated through `migration_cleanups`. It is called from ensureDb at schema.mjs:1300
(`runDeferredCleanups(ready)`) on every open. An exception leaves the marker unset, so the pass retries on
the next open. That is by design (P1-5).

Measured with scratchpad/bench-backfill.mjs: 100,000 observations × 2 paths each, foreign_keys = 1 after
initSchema (confirmed), same process, 2026-09-25.
- File-backed WAL: first pass **433.1 ms** → 200,000 edges. The next open, with the marker set, costs
  **0.090 ms**. If the marker is unset but every edge already exists (the NOT EXISTS scan returns nothing), a
  pass costs **25.5 ms**.
- :memory:: 727.6 ms. That arm ran first, so it carries JIT and page-cache warm-up. Quote the file-backed
  number; it matches the review's 462.6 ms.
So the roughly 0.45 s one-time cost is real on the current code.

Retry loop, reproduced with scratchpad/race-backfill.mjs on a mkdtemp file DB. After the SELECT returns, a
second connection deletes one of the returned observations before the transaction starts. Result:
`deferred-cleanup:backfill-observation-files: SqliteError: FOREIGN KEY constraint failed`, pass 1 ended
`{marked:0, edges:0}`, and pass 2 (the next open) ended `{marked:1, edges:4}`. This confirms two of the
review's claims: `INSERT OR IGNORE` does not suppress the FK error, and a SELECT outside the transaction is
racy. The race **converges in one retry** because the deleted row drops out of the next SELECT. A "half-second
tax on every hook" needs a failure that recurs deterministically, such as a read-only or full disk. On those
stores every other write already fails too, and I found no deterministic in-pass failure: JSON errors are
caught per row and non-strings are skipped. So the every-open loop is theoretical today. This last part is
reasoned from code, not reproduced.

Smallest fix, if taken. Put the read inside an IMMEDIATE transaction so the snapshot and the write lock are
the same:
```diff
-      const rows = db.prepare(`SELECT ...`).all();
-      if (rows.length === 0) return;
-      const insertFile = db.prepare('INSERT OR IGNORE ...');
-      db.transaction(() => {
+      const select = db.prepare(`SELECT ...`);
+      const insertFile = db.prepare('INSERT OR IGNORE ...');
+      db.transaction(() => {
+        const rows = select.all();
         for (const row of rows) { ... }
-      })();
+      }).immediate();
```
Behaviour change: the write lock is held for the whole scan (about 25 ms longer at 100k rows), not just the
insert phase. Concurrent writers wait on busy_timeout = 5000, which is far above the 433 ms pass. Batching
(LIMIT 5000, with the marker set on an empty pass) is not justified: the pass is one-time and converges.

Proof: turn race-backfill.mjs into a test under tests/. Today the delete lands and the pass-1 marker is 0. With
`.immediate()` the second connection's DELETE hits SQLITE_BUSY, which the probe must catch and count, and the
pass-1 marker is 1. Assert both that the interposed delete was *attempted* and that the marker was set on the
first pass. Reverting to the old shape should turn it red.
Recommendation: low priority. Either apply the three-line move, or record the one-retry convergence and close
the item.

## P3-7 — LIVE (a strengthening, not a bug)

tests/schema-backfill-observation-files.test.mjs:157
```
    const { rows } = recallByFile(db, FILE, { limit: 10, includeNoise: true });
```
lib/recall-core.mjs:34 `const noiseClause = includeNoise ? '' : \`AND ${notLowSignalTitleClause('o')}\`;` is
the default arm, and it is what mem_recall and the CLI actually run. scratchpad/p37.mjs replays the case: both
arms return `1,13,12,11,10,9,8,7,6,5`, so dropping the flag keeps the test green today. Neither the fixture's
`Edit: obs N` titles nor real import titles (`importedObsTitle` → `Bash: …`/`Edit: …`) match any anchored
LOW_SIGNAL pattern.

Fix: `recallByFile(db, FILE, { limit: 10 })`. Test-only.

Proof (p37-mut.mjs): add `{like:'Edit: %', regex:'^Edit: '}` to LOW_SIGNAL_PATTERNS. With includeNoise:true
the result stays `1,13,…,5`, so the current test is **GREEN under the mutation**. With the default arm the
result is just `1`, so the fixed test's `toContain(imported[last])` goes **RED**. The mutation stands for a
real regression: backfilled imports becoming unreachable through the product's default recall.

## P3-8 — LIVE; the reorder is safe from the lookbehind hazard, but not free

lib/import-jsonl.mjs:57-60
```
function importedObsTitle(toolUse) {
  const detail = toolUse?.input?.command || toolEditPath(toolUse?.input) || '';
  return `${toolUse?.name || 'unknown'}: ${String(detail).slice(0, 80)}`;
}
```
Both consumers scrub after the cut: storage `title: importedObsTitle(toolUse),` inside `scrubRecord('observations', {…})`
at :198, and preview `scrubRecord('observations', { title: importedObsTitle(useEv) }).title` at :331.
secret-scrub.mjs:138 `/\b(?:ghp_|gho_|ghs_|ghr_|ghu_)[a-zA-Z0-9_]{30,}\b/g`.

Reproduced with scratchpad/p38.mjs, using a token assembled from parts. A 40-char `ghp_` token was placed at
41 cut positions across the 80-char boundary. **29/41** stored a partial token with no `***`; the longest
leak is `ghp_` plus 29 of the 36 secret characters. Scrubbing first and cutting afterwards leaks at 0/41.

Relation to "A reorder deletes the precondition": **a different site**. The memory concerns
hook-handoff.mjs:138 (`working_on`), where `truncate()` runs `normalizeInline` and so silently gave
scrubSecrets one line. Here the cut is a bare `.slice(0, 80)` with no newline normalization, so scrubSecrets
already receives raw newlines inside the first 80 chars today. The lookbehind `(?<![A-Za-z][ \t])` reads only
the characters *before* a match, and those are the same in both orders. What the cut removes is the match's
*extent*, and that removal is the leak. So the reorder does not move the prose/config axis for anything inside
the window it keeps.

The reorder is still not free, for two reasons:
1. **Double-scrub trap.** Do NOT reorder inside `importedObsTitle` (scrub, then slice). Both sites wrap it in
   scrubRecord, so every title would be scrubbed twice. That is the exact shape D#46 removed, and the P3-9
   guard's `scrubSecrets(` check would (correctly) go red. The cut has to move *after* scrubRecord at both
   sites.
2. **Dedup-key migration.** The title is the cross-run dedup key. Any stored import row whose first 80
   characters contained something the scrubber rewrites changes title under the new order: a `***` replacement
   shortens the text, so the window pulls later characters in. Each such row re-imports **once** on the next
   import-jsonl run, then matches forever. This is the same bounded cost the NotebookEdit note at :190-196
   already accepts, and it must be stated in the CHANGELOG. How many rows are affected is not measured.

Smallest fix sketch:
```diff
 function importedObsTitle(toolUse) {
   const detail = toolUse?.input?.command || toolEditPath(toolUse?.input) || '';
-  return `${toolUse?.name || 'unknown'}: ${String(detail).slice(0, 80)}`;
+  return `${toolUse?.name || 'unknown'}: ${String(detail)}`;   // RAW, uncut — cut AFTER the single scrub
 }
+const IMPORTED_TITLE_DETAIL_MAX = 80;
+/** Applied to the ALREADY-SCRUBBED title at both sites; the tool-name prefix is never scrubbed. */
+function cutImportedTitle(t) { const i = t.indexOf(': '); return i < 0 ? t : t.slice(0, i + 2 + IMPORTED_TITLE_DETAIL_MAX); }
 ...
   const safe = scrubRecord('observations', { title: importedObsTitle(toolUse), ... });
+  safe.title = cutImportedTitle(safe.title);
 ...
-    const titlePreview = scrubRecord('observations', { title: importedObsTitle(useEv) }).title;
+    const titlePreview = cutImportedTitle(scrubRecord('observations', { title: importedObsTitle(useEv) }).title);
```
Both sides still scrub exactly once, so the P3-9 guard's invariants hold, and its literal pins (b)/(c) would
need restating along with the P3-9 fix. Shipped behaviour changes in two ways: stored titles for secret-bearing
commands change, and those rows re-import once.

Proof:
(a) A behavioural case: a Bash command with an assembled `ghp_` token that straddles position 80, imported
once. Assert the stored title contains no `/gh[p]_[A-Za-z0-9]{8,}/`. This is RED on the current tree
(29/41 positions), and the case must assert its own premise, that the raw 80-char slice contains ≥8 token
characters.
(b) The existing `a scrubbed title still deduplicates across runs` case must stay green, since the two sites
still agree.
(c) A mutation that drops `cutImportedTitle` from only one site must turn the dedup case red.
Per the memory, also add an over-redaction control on the axis the change moves: a multi-line command whose
line 2 (past char 80) starts `password: …`. Its stored title must equal the current title. It will, because
only the first 80 post-scrub characters survive and nothing is redacted before them, but the control
documents that.

## P3-9 — LIVE (all three tripwires present, plus one silent-green gap)

tests/import-jsonl-dedup-scrub.test.mjs:77-85
```
    const fn = src.slice(src.indexOf('function importedObsTitle'), src.indexOf('function dedupKey'));
    expect(fn, 'premise: importedObsTitle must be findable').toContain('toolEditPath');
    expect(fn, 'importedObsTitle scrubs, so the storage path scrubs twice').not.toMatch(
      /(^|[^a-zA-Z_.])scrubSecrets\(/,
    );
    // Both consumers hand the raw title to scrubRecord, which is the single scrub.
    expect(src).toContain("scrubRecord('observations', { title: importedObsTitle(useEv) }).title");
    expect(src).toMatch(/title: importedObsTitle\(toolUse\),/);
```
(a) The raw slice has no comment filter. (b) :84 is a literal `toContain`, and that line of the test file is
99 characters long. (c) It pins `useEv` and `toolUse`.

scratchpad/p39.mjs runs the current guard and a proposed replacement against in-memory mutations of
lib/import-jsonl.mjs. Every mutation was checked as applied (the text differs from the source).

| mutation | current guard | proposed |
|---|---|---|
| baseline | GREEN | GREEN |
| comment `// never scrubSecrets(detail) here` in the body | **RED (false)** | GREEN |
| prettier re-wrap of the preview call onto 3 lines | **RED (false)** | GREEN |
| rename `useEv`→`ev` at the preview | **RED (false)** | GREEN |
| rename `toolUse`→`use` at the storage site | **RED (false)** | GREEN |
| helper calls `scrubSecrets(...)` | RED | RED |
| **helper scrubs via `scrubRecord(...)`** (double scrub on both sides) | **GREEN (missed)** | RED |
| preview drops `scrubRecord` | RED | RED |
| storage title moved out of `scrubRecord` | RED | RED |
| a third, unscrubbed `importedObsTitle(` call site | GREEN (missed) | RED |

On the new gap: the current check forbids only `scrubSecrets(`, so a helper that scrubs through `scrubRecord`
(or any other `scrub*` wrapper) passes. With both sides wrapped, that double scrub is symmetric, so it does not
break dedup. It does break the stated invariant "scrubbed exactly once" and stores double-scrubbed content.
This gap is in addition to the finding.

Proposed replacement, tested in p39.mjs:
```js
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const c = code(src);
const fn = c.slice(c.indexOf('function importedObsTitle'), c.indexOf('function dedupKey'));
expect(fn, 'premise: importedObsTitle must be findable').toContain('toolEditPath');
expect(fn, 'importedObsTitle scrubs, so each side scrubs twice').not.toMatch(/(^|[^\w.])scrub\w*\(/);
const calls = [...c.matchAll(/\bimportedObsTitle\(/g)].length - 1; // minus the definition
const wrapped = [...c.matchAll(/scrubRecord\(\s*'observations',\s*\{[^}]*?\btitle:\s*importedObsTitle\(\s*\w+\s*\)/g)].length;
expect(calls, 'a new importedObsTitle call site must be wrapped in scrubRecord too').toBe(2);
expect(wrapped, 'both call sites hand the raw title to scrubRecord').toBe(2);
```
The comment filter is line-level, so a trailing `// scrubSecrets(` after code on the same line would still
false-red. That is acceptable because it fails noisy, not silent. The `[^}]*?` stays valid only while nothing
with a `}` sits between `scrubRecord('observations', {` and `title:`. Today only comment lines sit there, and
they are filtered. If the P3-8 fix lands, `cutImportedTitle(scrubRecord(...))` still matches `wrapped`.

Test-only, so no shipped behaviour changes. Proof: the table above is the mutation matrix. When writing the
real test, run each row as a real file mutation in the vitest harness (per memory: a mutation must be shown to
have landed, and the red arm must be run in the final harness).
