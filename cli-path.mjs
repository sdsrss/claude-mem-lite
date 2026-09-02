// cli-path.mjs — single source of truth for invoking the bundled CLI by an
// absolute, install-shape-independent path.
//
// cli.mjs is a sibling of this module at the package root, so import.meta.url
// resolves it correctly on EVERY install shape: plugin cache, `npm i -g`
// symlink farm, and manual/dev checkout. The pre-v3.1.1 hardcoded
// `~/.claude-mem-lite/cli.mjs` only existed on direct-install symlink farms —
// on a plugin-only install setup.sh provisions the data dir but never
// materializes source there, so that path is a module-not-found. See the
// 2026-06-20 code review, findings #1/#2/#3/#13.
//
// Use this for JS-emitted, runtime-resolved surfaces (MCP `instructions`, the
// per-tool "Equivalent CLI" hints, hook recovery lines, the generated adopt
// doc). Plugin MANIFEST files (commands/*.md, .mcp.json) must instead use the
// literal `${CLAUDE_PLUGIN_ROOT}` token, which Claude Code — not the shell —
// substitutes at execution time (the env var is absent from a plain Bash env).

import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// D#207: join(), not `new URL('./cli.mjs', …)` — that form makes knip drop the named
// module from its unused-export report entirely. Enforced by
// tests/no-url-module-paths.test.mjs.
export const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
export const CLI_INVOKE = `node ${CLI_PATH}`;
