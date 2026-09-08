/**
 * The two location constants, in a leaf module.
 *
 * They lived in `schema.mjs`, which statically imports `better-sqlite3`. That made the
 * native driver a LOAD-TIME dependency of anything that wanted a path — including
 * `hook-update.mjs`, which `install.mjs::repair()` imports to reach the Ed25519-verified
 * release path. Measured 2026-09-08: on a tree with no `node_modules`, that import threw
 * `ERR_MODULE_NOT_FOUND` from `schema.mjs`, repair() caught it, refused to auto-install
 * unverified code, and printed the unverified default-branch tarball instead. So the
 * signature check was unreachable on the one install state the self-heal exists to fix.
 *
 * Keep this module free of package imports — `node:` builtins and `lib/resolve-data-dir.mjs`
 * only. `tests/repair-path-no-native-dep.test.mjs` walks the static import graph from
 * `hook-update.mjs` and fails on ANY package edge, so a future import here has to argue
 * with a test rather than silently disarm the repair path.
 *
 * `schema.mjs` re-exports all three names, so every existing importer keeps working and
 * this is not a contract change.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveDataDir } from './resolve-data-dir.mjs';

// DATA location — DB, managed resources, registry DB, runtime/. Honors
// CLAUDE_MEM_DIR so users can relocate state to a larger/faster volume.
export const DB_DIR = resolveDataDir(process.env.CLAUDE_MEM_DIR);
export const DB_PATH = join(DB_DIR, 'claude-mem-lite.db');
// CODE / install location — server.mjs, hook.mjs, cli.mjs, package.json live
// here. ALWAYS homedir-rooted: Claude Code's settings.json + MCP registration
// bake ABSOLUTE paths to server.mjs/hooks, so the code must NOT follow the
// CLAUDE_MEM_DIR relocation env var (mirrors install.mjs INSTALL_DIR). Equals
// DB_DIR when CLAUDE_MEM_DIR is unset — the common, non-relocated case.
export const CODE_DIR = join(homedir(), '.claude-mem-lite');
