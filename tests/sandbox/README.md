# Sandbox install harness

Plays a **real user** through both documented install paths, end to end, against a
throwaway `$HOME`. Not part of `vitest run`: these drive real `npm pack` / `npm i -g`,
real `npm install` inside a fake plugin cache, and a real MCP server over stdio, so a
full pass takes minutes and needs network.

```bash
SBX_BASE=/tmp/claude/sbx node tests/sandbox/phaseA-plugin.mjs   # /plugin install …    43 checks
SBX_BASE=/tmp/claude/sbx node tests/sandbox/phaseB-npm.mjs      # npm i -g + install   45 checks
SBX_BASE=/tmp/claude/sbx node tests/sandbox/phaseC-update.mjs   # version swap         15 checks
```

Each exits non-zero if any check fails and prints a `PASS`/`FAIL` line per check.
Sandboxes are created under `SBX_BASE`, falling back to `$TMPDIR`, and are **left on
disk** so a failure can be inspected — delete them when you are done. Phase B alone
leaves ~50 MB (a real `npm i -g` tree).

**`SBX_BASE` is in every command above on purpose.** `os.tmpdir()` reads `$TMPDIR`, and
in a Claude Code session `$TMPDIR` is `~/.claude/tmp/claude-<uid>` — under `$HOME`,
which is exactly what the "Do not put the sandbox under `$HOME`" convention below
forbids, for the reason given there. That is not a hypothetical: on a machine where
`~/node_modules` holds `better-sqlite3` and `claude-mem-lite`, the run measures the home
tree and passes. `tests/sandbox/sbx-base.mjs` now refuses such a base outright rather
than leaving the rule to a reader — `tests/sandbox-base-guard.test.mjs` drives the
refusal, and it is in `vitest run` even though the harness itself is not.

**Run them one at a time.** Chaining `phaseA … ; phaseB …` in a single shell crashed
phase B once, while phase B on its own passed 45/45 immediately after. Not attributed —
recorded here rather than left for the next person to rediscover.

## Why it exists

The v3.70.0 round found five defects that the 4500-test suite could not see, because
every one of them lived in the difference between install *shapes* rather than in a
function:

- a healthy plugin-only install reporting `3 issue(s) found` and exiting 1
- a stale `~/.claude-mem-lite` binding reported as `✓ verified` while the registered
  MCP server FATAL'd and every hook silently no-op'd
- `SessionStart` emitting three separate writes on one stdout, so Claude Code parsed
  none of them as an envelope
- `PostToolUse` dropping both of its receipts when two co-fired
- `doctor` prescribing `claude-mem-lite update`, which is the observation editor

The unit suite was green through all of it. What these scripts add is the *shape*: a
fake `$HOME`, a fake `claude` binary recording `claude mcp add/remove/list`, a plugin
cache populated the way Claude Code populates one (a git checkout, **no**
`node_modules`), and hooks fired with the real stdin payloads.

## What each phase covers

| Phase | Covers |
|---|---|
| A | marketplace add → cold `setup.sh` (real `npm install`) → all six hook events → MCP `initialize`/`tools/list`/`tools/call` → bundled CLI → auto-update in plugin mode → stale-ABI self-heal → uninstall residue |
| B | `npm pack` → `npm i -g` → `claude-mem-lite install` → settings.json hooks actually firing → MCP from the managed install → `self-update` → self-heal with the CLI's own tree healthy and the managed one broken → `uninstall` and `--purge` |
| C | a new cache version dir arriving without `node_modules`, a hook firing from it before its deps exist, `setup.sh` provisioning it, memory surviving the version swap, cache pruning to the latest 3 |

## Conventions worth keeping

- **Inherit the ambient environment.** An early version used `env -i`, which dropped
  the proxy vars and made `npm install` fail with DNS errors — a harness failure that
  reads exactly like a product failure. `sandboxEnv()` clones `process.env` and strips
  only `CLAUDE_*` / `MEM_*`.
- **Do not put the sandbox under `$HOME`.** Node resolves `better-sqlite3` up the
  directory tree, so a sandbox nested under a home that owns `node_modules` silently
  resolves to it and the isolation is fake.
- **Give each fake root its own dependency tree.** Symlinking every root at the repo's
  `node_modules` collapses them under realpath dedup, and multi-root assertions then
  pass or fail for the wrong reason.
- **A control per destructive check.** Before asserting "doctor goes red", assert the
  thing is genuinely broken (the MCP server really fails to start) and that the tree
  doctor runs from is genuinely healthy — otherwise a red verdict proves nothing.
