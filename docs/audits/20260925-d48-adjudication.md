# D#48 — adjudication of the six v6.7.1 P3s against main @ 46c48d1 (2026-09-25)

Context that decides most of these: the report reviewed range 495edaa..6e946c7 (both still
resolvable). Those commits were rewritten onto main as 1bf34c3 / 5ed90df / 78425cf, and the
rewrite folded the P3 fixes in. So "ALREADY-FIXED" below means the fix is inside the landed
commit itself; `git log -S` names that commit, not a later follow-up. Pre-fix shapes were
checked with `git show 6e946c7:<file>`.

Probe method (read-only): `git archive HEAD` into the scratchpad (plus copies of
lib/file-edge-match.mjs with rewritten imports); mutations applied there; vitest v5.0.0 run
there. Nothing in the repo was edited. Each mutation diff was checked before its run.

---

## 1. Trailing separator earns the separator bonus: code ALREADY-FIXED, guard LIVE (vacuous)

- Code, fixed in 1bf34c3: `lib/file-edge-match.mjs:145`
  `if (/[/\\]/.test(raw.replace(/[/\\]+$/, ''))) score += 2;`
  (pre-fix at 6e946c7:130: `if (name !== String(token ?? '')) score += 2;`)
- Guard, `tests/file-edge-rank.test.mjs:73-77`:
  `expect(rankFileCandidates(['src/real.mjs', 'foo.mjs/'])[0]).toBe('src/real.mjs');`
  **It cannot say NO.** Under the reverted code both tokens score 5 (src/real.mjs: letter 2 +
  short 1 + sep 2; foo.mjs/: the same because of the bonus). The index tiebreak keeps
  src/real.mjs first either way.
  Mutation (line 145 -> `if (name !== raw) score += 2;`): the test file stays **13/13 green**
  on both the original and the mutant.
- User-visible consequence of the bonus: none today. The bonus only affects the probe ORDER in
  `rankFileCandidates`, which feeds `searchByFile`'s `.slice(0, FILE_PROBE_CAP=6)` on the
  UserPromptSubmit file leg (scripts/user-prompt-search.js:536). A trailing-separator token
  scores +2 (3 -> 5), which lifts it over every bare filename and ties it with real paths.
  With more than 6 candidates, that can evict a real file from the probe window. But the only
  producer, `extractFiles` (scripts/prompt-search-utils.mjs:268,
  `/[\w./-]+\.\w{1,10}/g`), cannot emit a token that ends in a separator. So this was a
  contract bug in an exported helper with no reachable effect.
- Smallest fix (test only, no shipped-behaviour change):
  ```diff
       expect(rankFileCandidates(['src/real.mjs', 'foo.mjs/'])[0]).toBe('src/real.mjs');
  +    // Must tie on the fixed scorer (3 vs 3, text order wins) and flip on the old one (3 vs 5).
  +    expect(rankFileCandidates(['bare.mjs', 'foo.mjs/'])).toEqual(['bare.mjs', 'foo.mjs/']);
  ```
  The order matters: `['foo.mjs/','bare.mjs']` is vacuous for the same tie reason.
  Proven in the scratch harness: fixed code 13/13 green; the mutant is red on "gives no
  separator bonus to a token whose only separator is trailing" (1 failed | 12 passed).
  The existing src/real.mjs line can be dropped or kept; it binds nothing.

## 2. Ledger lessonEscape arm does not bind keyObs: ALREADY-FIXED (78425cf)

- `tests/lowsig-surface-ledger.test.mjs:93-102` splits the SessionStart face into
  "File Lessons + Key Context (keyObs)" and "Recent table (selectWithTokenBudget)".
  `:160-171` does `UPDATE observations SET files_modified = '[]' WHERE id = ?` on the lesson
  row, so it renders through Key Context (title), not File Lessons (basename + lesson).
- Re-ran the report's exact mutation on the tree copy: hook-context.mjs:630
  `notLowSignalTitleClause('o')` -> `buildNotLowSignalSql('o')`. Result: 2 failed | 20 passed
  (22), with **both** `keyctx-low-signal ... (lessonEscape)` and
  `lowsig-surface-ledger > SessionStart — File Lessons + Key Context (keyObs) > still renders
  a degraded title that carries a lesson (lessonEscape)` red. Unmutated: 22/22 green.
- `git log -S"SET files_modified = '[]' WHERE id"` -> 78425cf.

## 3. "never drops" heading over a dropping case: ALREADY-FIXED (1bf34c3)

- `tests/file-edge-rank.test.mjs:13`:
  `describe('rankFileCandidates — sorts and de-duplicates; never drops a non-empty candidate', …`
  (this is the report's suggested wording verbatim). `:30` has the comment
  `// Empty-string members ARE dropped, which is why the heading says non-empty.`
  Pre-fix at 6e946c7: `describe('rankFileCandidates — never drops', …`.

## 4. file-edge-rank :43-49 asserts less than its title: ALREADY-FIXED (1bf34c3)

- `tests/file-edge-rank.test.mjs:51-63` now asserts the full order
  `['schema.mjs','JSON.stringify','v4.0.1','39.602Z']`, with a per-row score comment.
  Pre-fix at 6e946c7: `out[0]` plus `out.slice(1)).toHaveLength(3)`.
- Mutation-verified per term:
  - drop `ext.length <= 5` (+1): that case goes red (1 failed | 12 passed).
  - drop the letter-initial term (+2): that case goes red, along with 2 others
    (3 failed | 10 passed).
  - Not covered: the relative order of v4.0.1 vs 39.602Z is a 1-vs-1 tie decided by text
    order, so no score term separates them. That is by design; the comment says so.

## 5. ORDER BY created_at_epoch DESC without id tiebreak at the round's sites: ALREADY-FIXED

- `hook-context.mjs:631` (keyObs):
  `ORDER BY o.created_at_epoch DESC, o.id DESC LIMIT ${KEY_CONTEXT_LIMIT}`. Found by
  `git log -S"o.created_at_epoch DESC, o.id DESC LIMIT"` -> 5ed90df. Pre-fix at 6e946c7:584
  had no `o.id DESC`.
- `scripts/user-prompt-search.js:527` (searchByFile):
  `ORDER BY o.importance DESC, o.created_at_epoch DESC, o.id DESC`. Found by `git log -S` ->
  1bf34c3. Pre-fix at 6e946c7:515 was `ORDER BY o.created_at_epoch DESC`.
- Out of scope (not edited by that round, part of CLAUDE.md's "unjudged, not cleared" set):
  - `scripts/user-prompt-search.js:630`, `searchRecent`: `ORDER BY created_at_epoch DESC`,
    no id. Unchanged since daaea01.
  - `hook-context.mjs:216,228,600,614,771,781`: the same spelling.
  - Not judged here. The rule says to measure each population's same-millisecond rate before
    touching it (UPS/pretool read 0.00%).

## 6. rankFileCandidates on a non-array: ALREADY-FIXED (1bf34c3); was hardening, not a defect

- `lib/file-edge-match.mjs:204`: `if (!Array.isArray(files)) return [];`
  - Test `tests/file-edge-rank.test.mjs:34-39` expects `'a.mjs'` -> `[]` and `7` -> `[]`.
  - Removing the guard turns 2 cases red (2 failed | 11 passed).
- Callers: exactly one in shipped code, scripts/user-prompt-search.js:536
  `rankFileCandidates(files)` inside `searchByFile`.
  - `searchByFile` is reached only from :942 with `files = filesForGate = extractFiles(promptText)`
    (:890).
  - `extractFiles` returns `(text.match(...) || []).filter(...)`, which is always an array,
    and `searchByFile` already dereferences `files.length` first.
  - So no caller can pass a non-array. This was hardening for the exported surface.
- Note: the fix fails CLOSED and SILENT (`[]`), not loud as the title suggested. That
  matches the file's never-throw style and has no caller to mislead. Throwing a TypeError
  instead is a style choice, not a correctness fix.

---

## Net
- 5 of 6 were fixed inside the landed commits 1bf34c3 / 5ed90df / 78425cf.
- 1 residual: item 1's guard is vacuous. It is a test-only fix (one line, above) with no
  shipped-behaviour change, mutation-proven to go red on the reverted scorer.
- After that one-line test, D#48 can close.
