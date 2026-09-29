---
name: bug
description: "Use when: logging a known bug + repro steps you can't fix right now. Writes a searchable observation (findable via mem_search + surfaced by recall hooks; still NOT memdir). Skip for bugs you're actively fixing in the current turn — just fix them."
---

# /bug

Record a known bug + reproduction steps. Writes a searchable **observation**
(`type=bugfix`, description in `lesson_learned`) so future sessions can find it
via `mem_search` and the PreToolUse recall hooks warn when the affected files
are edited. Does NOT touch memdir. Useful for bugs you can't fix immediately
but want future sessions (or yourself after `/clear`) to know about and avoid
re-investigating. (Redirected v3.39: was the `events` table, which `mem_search`
never read.)

## When to use

- Bug is known but fix is blocked (waiting on upstream, needs discussion).
- Bug is intermittent / race condition; you want a repro recipe recorded.
- Edge case affecting only part of users; not priority now but must not
  be silently re-discovered.

Don't use for bugs you're actively fixing in the current turn — just fix
them. Use `/lesson` afterward if there's a non-obvious root cause worth
recording.

## Arguments

- Positional text: short bug description.
- `--file <path>` or `--files f1,f2,...`: affected files. Triggers
  pre-tool-recall warning when these files are edited later.
- `--repro "step1; step2; step3"`: reproduction steps, semicolon-separated.
- `--severity low|med|high`: maps to importance `1|2|3`. Default `med`.

## Execution

Map severity to importance:

- `low` → importance 1
- `med` → importance 2 (default)
- `high` → importance 3

Build the body as `<description>\n\nRepro:\n<repro-steps>` (or just
`<description>` if `--repro` is absent).

Run via Bash — the full body is the positional content; a distilled description
goes in `--lesson` so it lands in the high-weight `lesson_learned` field.
`--lesson` is capped at 500 chars (longer values are rejected), so keep the full
body in the positional content and trim `--lesson` to the core description if
longer:

    node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" save "<body>" \
      --type bugfix \
      --title "<first 60 chars of description>" \
      --lesson "<description, ≤500 chars>" \
      [--files f1,f2,...] \
      --importance <1|2|3>

Confirm to user with: `Bug logged: #<id>`.

## Examples

- `/bug intermittent test flake when DB is under load --repro "run pnpm test -- --retry=0; fails ~1 in 20 runs when CPU is busy"`.
- `/bug --file src/auth.mjs --severity high "session refresh drops the X-Forwarded-For header"` — no repro steps, just a high-severity note.
