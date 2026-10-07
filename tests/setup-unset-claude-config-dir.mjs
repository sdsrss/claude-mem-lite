// Vitest setupFiles (every worker, before each test file): unset CLAUDE_CONFIG_DIR.
//
// Fixtures relocate HOME and expect Claude Code's config home to follow it. With the variable
// set in a developer's shell, the installer, hook-update, setup.sh and the disabled-plugin check
// follow it instead (D#173 / D#176), and a test would read or write the developer's real config.
//
// UNSET, not blanked in vitest.config.mjs `env`: this repo's resolver treats '' as unset, but
// the real `claude` CLI, which some tests spawn, took '' as a relative config dir and wrote
// `backups/.claude.json.backup.*` into the repository (observed 2026-10-07, Claude Code 2.1.292).
// Tests of the variable set it explicitly.
delete process.env.CLAUDE_CONFIG_DIR;
