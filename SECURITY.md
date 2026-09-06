# Security Policy

## Supported versions

Only the latest released version receives security fixes. The auto-update
mechanism (SessionStart hook, 24h check against GitHub Releases) moves
installations forward automatically, so older versions are not patched
retroactively.

| Version | Supported |
| ------- | --------- |
| latest release | ✅ |
| anything older | ❌ (update: `claude-mem-lite update` or reinstall) |

## Reporting a vulnerability

Please use **GitHub private vulnerability reporting** on this repository
(Security tab → "Report a vulnerability"). Do not open a public issue for
anything exploitable.

<!-- R10 P1-9: this pointed at a feature that was switched OFF for the repository —
     `gh api repos/sdsrss/claude-mem-lite/private-vulnerability-reporting` returned
     {"enabled":false} — so the only route left to a reporter was the public issue this
     paragraph tells them not to open. Enabled 2026-09-06; the same call now returns
     {"enabled":true}. If it is ever turned off again, replace this section with a real
     address rather than leaving a promise nothing can honour. -->

Include if you can:

- the attack surface (CLI command, MCP tool, hook script, install/update path,
  release artifact),
- a minimal reproduction,
- the version (`claude-mem-lite --version` / `npm ls claude-mem-lite`).

You can expect an acknowledgement within a few days. Fixes ship as a normal
signed release; credit is given in the CHANGELOG unless you ask otherwise.

## Scope notes

Areas we consider security-relevant (all have shipped hardening and regression
pins; new findings here are high-priority):

- **Release integrity**: releases are Ed25519-signed (`RELEASE_SIGNED_FILES`
  manifest covers every runtime-executed file, including hook scripts, the MCP
  launcher, and plugin declaration files); install/update verifies fail-closed.
- **Prompt-injection surfaces**: everything injected into model context from
  stored or third-party data (memory rows, registry skill bodies, handoffs) is
  delimiter-neutralized ("defang"). A bypass that renders a live
  `<system-reminder>`/tool tag from stored data is a vulnerability.
- **Secret handling**: transcripts and observations pass through the secret
  scrubber before storage; a class of credential that survives scrubbing into
  the DB or logs is a vulnerability.
- **Local data boundaries**: hooks and CLI must stay inside the data dir
  (`~/.claude-mem-lite` or `CLAUDE_MEM_DIR`); path-traversal out of it via
  crafted registry rows, project names, or import files is a vulnerability.

Out of scope: issues requiring an already-compromised local account, and the
inherent trust a user places in skills/agents they explicitly import.
