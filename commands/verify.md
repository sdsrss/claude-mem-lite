---
name: verify
description: "Use when: the user explicitly asks to verify, audit or correct their stored memories against the current code (e.g. \"check my memories for stale ones\", /verify). You check each memory with read-only repo tools and propose corrections; nothing is written until the user approves the exact plan. Not for routine recall or saving."
---

# /verify — check memories against the code, then correct the stale ones

Memories go stale: a bug recorded as open gets fixed, a measurement gets retracted, a
mechanism is replaced. Measured on 118 live memories across 7 repos, ~10% were STALE and
~14% PARTIAL, and most went stale within a day of being saved. No automatic pass catches
this — cheap single-shot models misjudged it (precision 0.36) and model-written corrections
were false in 28 of 72 cases. What works is YOU reading the code: you propose, the user
approves the exact plan, and `verify-apply` is the only thing that writes.

(If another plugin also defines `/verify`, this one is `/claude-mem-lite:verify`.)

## Arguments

- `--from <YYYY-MM-DD>`: only memories saved on or after this date (default: all live).
- `--ids 12,34`: only these memories.
- `--project <name>`: a project other than the current one.

## Step 1 — Select

Get the exact project name first. For the current project (the usual case), run from the
project's directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" verify-apply --print-project
```

It prints the canonical name (e.g. `dev--my-app`) that verify-apply itself will target. For
another project, use the name the user gave only if it already has the `parent--name` shape;
otherwise ask. Always pass that exact name — `export --project` matches loosely and can pick a
neighbouring project from a short name.

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" export --project <project> [--from <date>] > <scratch>/memories.json
```

Every row carries `id`, `project`, `type`, `title`, `narrative`, `facts`, `lesson_learned`,
`files_modified`, `created_at`. Check that every row's `project` is the name you passed. With
`--ids`, filter the file to those ids. The repository to check them against is the current
directory for the current project; for another project, ask the user where it lives.
`files_modified` holds both absolute and repo-relative paths. Tell the user how many memories
you are about to check.

## Step 2 — Verify (read-only)

For EACH memory, answer: *if this memory were shown to an agent working in this repo today,
would anything it asserts mislead that agent?*

1. List its concrete, checkable claims: identifiers, file paths, `file:line` references,
   constants, counts, behaviours, "X is still broken", "Y was measured at Z".
2. Check each against the current tree (Grep, Read) and, where useful, the history since
   `created_at` (`git log --since=<created_at> -- <files>`, `git log -S<token>`, `git show`).
3. Pick one verdict:
   - **VALID** — every checkable claim still holds.
   - **STALE** — at least one specific claim is contradicted by the tree or history: a
     renamed/removed symbol, a changed value or default, a changed behaviour, a bug presented
     as open that has since been fixed, a count that moved, a measurement later retracted.
   - **PARTIAL** — the main point holds; a secondary detail (a line number, a count, a minor
     mechanism) is out of date.
   - **UNVERIFIABLE** / **NO_CODE_CLAIM** — leave these alone.

Rules that the measurement showed matter:
- A file having changed is NOT a contradiction. You need a line, a diff hunk, a commit, or a
  command's output that contradicts a specific claim.
- Output you did not see is not a contradiction. A grep that printed nothing, or output cut
  off by `head` or a size limit, proves nothing — re-run it untruncated before calling a claim
  stale.
- A number only a test run could confirm (a test count, a coverage figure) is a dated
  measurement: stale only if a later commit or document reports a different value, not
  because you cannot re-run it here.
- A record of what happened (what was measured then, what a review found) stays true as
  history. It is stale only if it would mislead about the PRESENT.
- A note that already records its own fix is not stale because the fix commit landed later.
- Do not write, stash, check out or run tests while verifying.

More than ~25 memories: split them into batches and give each batch to a read-only subagent
with the rubric above; have each subagent write its results to a file with a bash heredoc and
reply with only the path. Treat a subagent's verdict as a lead: before proposing anything,
re-open every cited `file:line`, commit or command yourself.

## Step 3 — Draft proposals (STALE and PARTIAL only)

If every memory is VALID (or UNVERIFIABLE / NO_CODE_CLAIM), stop here: report the counts to
the user and say nothing needs changing. Do not run Step 4 with an empty proposals file.

Write `<scratch>/proposals.json` — a JSON array, one entry per memory to change:

```json
[
  { "id": 52, "action": "replace", "verdict": "STALE",
    "title": "...", "narrative": "...", "lesson_learned": "...",
    "evidence": "7bc8ba9; hook-optimize.mjs:1371-1383" },
  { "id": 64, "action": "edit", "verdict": "PARTIAL",
    "set": { "narrative": "..." }, "evidence": "hook-llm.mjs:1359-1361" },
  { "id": 201, "action": "retire", "verdict": "STALE", "evidence": "600c744" }
]
```

- **edit** — the stale part is one detail in `title`, `narrative`, `lesson_learned`,
  `importance` or `concepts`. Copy the original text into `set` and change only the stale words.
- **replace** — the memory's claim is wrong but its lesson is still worth keeping, OR the
  stale detail sits in `facts` (edit cannot change `facts`). Write the corrected memory; give
  `facts` (an empty string drops them) or `concepts` when those are what is stale. Omitted
  fields are copied from the original, which stays as history.
- **retire** — nothing in it is worth keeping (e.g. a mid-debug note about a failure fixed
  minutes later).
- `evidence` is required: the commit, the `file:line`, or the command and its output (for
  something outside the repo, e.g. a tool version) that shows the memory is out of date.
- `lesson_learned` is at most 500 characters. Keep the memory's language.

## Step 4 — Show the plan and get approval

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" verify-apply <scratch>/proposals.json --project <project>
```

This is a dry run: it validates every entry against the database, writes nothing, prints each
change as `-` old / `+` new text (the changed text in full), and ends with a **plan digest**
and the exact apply command.
Show the user that output as it is (do not summarise the changes away), plus your counts of
VALID / STALE / PARTIAL, and ask for approval. If the dry run refuses an entry, fix the
proposal — never work around it with `update`, `save` or `delete`. If you change the proposals
after the user saw them, run the dry run again and show the new plan: the digest changes, and
the old one will be refused.

## Step 5 — Apply, only after the user approves that plan

Run exactly the command the dry run printed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" verify-apply <scratch>/proposals.json --project <project> --apply --digest <digest>
```

It refuses if the proposals or the memories changed since the dry run. Otherwise it backs up
every target row, applies all entries in one transaction (all or nothing), reads each row back
and prints `ok` or `MISMATCH`, then prints the backup path and the undo command. Report the
result and the undo command to the user. Reading the exit status:
- exit 0 — applied, every row read back `ok`.
- exit 1 with `MISMATCH` lines — applied, but a row did not read back as planned. Show those
  lines; do not re-run the apply.
- exit 1 with a message starting `APPLIED` — the changes are in the database, but no undo
  record could be written. Say exactly that.
- any other exit 1 — nothing was written. Say why.

Undo (`verify-apply --undo <backup>`) only works while the changed rows' content and state are
as the apply left them (usage counters such as access counts do not count): it refuses once any
of them changes again — an edit, a supersede, or a routine background pass (importance decay,
alias or concept backfill) — and it runs at most once. It then prints `Undo complete`; a `Warning: … could not be marked as undone` line means
the undo still happened. After an undo, the earlier apply command is refused: applying the
same changes again needs a new dry run and the user's approval of its new digest. That refusal
rests on the backup file: once it is deleted, the earlier command would match again, so never
re-run an apply command from an earlier approval.
