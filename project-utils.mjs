// claude-mem-lite shared project resolution
// Extracted from server.mjs and mem-cli.mjs to eliminate duplication

import { basename, dirname } from 'path';

// Leaf module: imports nothing from utils.mjs. utils.mjs re-exports this module's
// symbols as a backward-compat barrel, so importing the barrel back from here
// would close a cycle (v3.56 P2-9). Keep this file dependency-free of the barrel.

const _cache = new Map();

/**
 * Infer a sanitized project name from CLAUDE_PROJECT_DIR, PWD, or cwd.
 * Format: "parent--basename" with non-alphanumeric chars replaced by hyphens.
 *
 * Deliberately does NOT anchor on the git work-tree root. That was tried and reverted
 * before it shipped: it fixes `cd src/auth && claude-mem-lite recent` (session rooted at
 * the repo root, CLI run deeper) but BREAKS the mirror case, which is more common —
 * CLAUDE_PROJECT_DIR is the directory Claude Code was started in, not the repo root, so
 * `cd packages/api && claude` makes hooks write `packages--api` while a plain terminal in
 * the same directory would walk to the work-tree root and read `mono--monorepo`.
 * Reproduced pre-tag: hooks saved to `packages--api`, `recent` answered
 * `No recent observations (h1--mono)`. Splitting a monorepo user's namespace silently is
 * worse than the subdirectory case, and unlike it, cwd-derivation at least keeps the hook
 * and CLI faces agreeing whenever the session root and cwd match. A correct fix has to
 * consult the DB for which candidate actually holds rows; this module is DB-free and on
 * the hook hot path, so it is not the place. Tracked as deferred work.
 *
 * @returns {string} Sanitized project identifier safe for use in filenames
 */
export function inferProject() {
  return projectNameFromDir(inferProjectDir());
}

/**
 * The DIRECTORY `inferProject()` derives its name from — the session's project root.
 *
 * Callers that read the filesystem on behalf of the current project (git state, tasks,
 * adoption sentinel) must use THIS, not `process.cwd()`. The two diverge whenever the
 * process was not spawned with cwd == project root, and the result is a surface that
 * labels directory A's git/tasks with directory B's project name. That was live in the
 * startup dashboard: `buildDashboard({ project: inferProject(), projectPath: process.cwd() })`
 * — the identity came from the env, the filesystem root from the process. In production the
 * two happen to coincide, so only the test face showed it (a hook subprocess spawned with the
 * repo root as cwd read the REAL repo's git state, and the assertion pinning the dashboard
 * leg passed or failed on whether the host tree was dirty).
 *
 * @returns {string} Absolute project root directory.
 */
export function inferProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
}

/**
 * The naming rule alone, applied to an arbitrary directory: "parent--basename", sanitized.
 *
 * Split out of inferProject() so lib/cli-project.mjs can build its second candidate (the git
 * work-tree root) with THIS rule rather than a copy of it — two copies of the rule would let
 * the CLI face and the hook face drift apart on the next sanitization change, which is the
 * exact class of bug this module's candidate-selection exists to close. Still DB-free and
 * allocation-cheap, so the hook hot path is unaffected.
 *
 * @param {string} p Absolute directory path
 * @returns {string} Sanitized project identifier safe for use in filenames
 */
export function projectNameFromDir(p) {
  const base = basename(p);
  const parent = basename(dirname(p));
  const raw = parent && parent !== '.' && parent !== '/' ? `${parent}--${base}` : base;
  // Sanitize to prevent path traversal when used in filenames (ep-<project>.json)
  // Truncate to 100 chars to avoid exceeding filesystem name limits (255 bytes)
  return raw.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100);
}

/** Escape LIKE metacharacters so a caller-supplied name is matched literally.
 *  R10 P2-3: unescaped, `--project '%'` matched every project and ORDER BY COUNT(*)
 *  returned the biggest one; `_` matched any single character the same way. */
function likeLiteral(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}

/**
 * Resolve short project name to canonical "parent--base" form.
 * Uses DB suffix match with in-process cache.
 *
 * R10 P2-3 — `mode` is not cosmetic. The fuzzy steps 2 and 3 below are a deliberate READ
 * convenience: a wrong guess costs one query, and the user sees an empty result and tries
 * again. On a WRITE they cost the row's identity — `mem_save project:"api"` landed in
 * `mono--api-gateway`, and the caller's own next project-scoped read of "api" does not
 * find it. Write callers pass mode:'write' and get exact matching only: an already
 * canonical name, the exact `%--name` suffix completion users depend on (`mem` ->
 * `projects--mem`), an exactly existing bare name, or the caller's own string back.
 *
 * @param {import('better-sqlite3').Database} db Database instance
 * @param {string|null|undefined} name Project name to resolve
 * @param {{mode?: 'read'|'write'}} [opts]
 * @returns {string|null|undefined} Canonical project name
 */
export function resolveProject(db, name, { mode = 'read' } = {}) {
  if (!name) return name;
  // Defense-in-depth: a bare `--project` CLI flag parses to boolean `true` (and a
  // malformed MCP/hook caller could pass any non-string). `true.includes('--')` below
  // throws a raw TypeError that crashed search/recent/timeline/stats/export/defer-list.
  // Treat any non-string as "no project filter" (null) — the degradation every caller
  // already handles for an absent --project — instead of crashing at the root helper.
  if (typeof name !== 'string') return null;
  // Key on the MODE too: the same name legitimately resolves to two different answers,
  // and a name-only cache hands whichever call ran first to the other one.
  const ck = `${mode}:${name}`;
  if (_cache.has(ck)) return _cache.get(ck);
  // Already a canonical name (contains "--")? Use as-is.
  if (name.includes('--')) {
    _cache.set(ck, name);
    return name;
  }

  // Short name: prefer the canonical "parent--name" form (from inferProject())
  // which typically has far more data than manually-saved short names.
  // 1) Exact suffix match: "mem" → "projects--mem"
  const suffixed = db
    .prepare(
      "SELECT project FROM observations WHERE project LIKE ? ESCAPE '\\' GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1",
    )
    .get(`%--${likeLiteral(name)}`);
  if (suffixed) {
    _cache.set(ck, suffixed.project);
    return suffixed.project;
  }

  // 1.5) Exact-name match: a project literally named "p" (e.g. inferProject() at a
  // filesystem-root cwd yields no "--", or a manually-saved bare name). MUST beat the
  // fuzzy prefix/substring fallbacks below — otherwise `%p%` matches every "projects--*"
  // row and ORDER BY COUNT(*) returns the biggest UNRELATED project, making the exact
  // project permanently unreachable via --project. Ranks below step 1 only, preserving
  // the documented "prefer canonical parent--name over a stray short name" intent.
  const exact = db.prepare('SELECT project FROM observations WHERE project = ? LIMIT 1').get(name);
  if (exact) {
    _cache.set(ck, exact.project);
    return exact.project;
  }

  // R10 P2-3: a write stops here. Steps 2 and 3 below guess; step 4 synthesizes from the
  // process cwd, which for a write is worse still — an MCP call naming a project the
  // caller is not sitting in would land in the caller's own directory's project.
  if (mode === 'write') {
    _cache.set(ck, name);
    return name;
  }

  // 2) Prefix-in-suffix match: "code-graph" → "projects--code-graph-mcp"
  const prefixed = db
    .prepare(
      "SELECT project FROM observations WHERE project LIKE ? ESCAPE '\\' GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1",
    )
    .get(`%--${likeLiteral(name)}%`);
  if (prefixed) {
    _cache.set(ck, prefixed.project);
    return prefixed.project;
  }

  // 3) Whole-token match: the name is a complete hyphen-delimited component of the base
  // (e.g. "graph" → "projects--code-graph-mcp", "mcp" → "…-mcp"). Steps 1/2 already cover
  // the exact base and the base *prefix*; this adds interior/trailing whole tokens ONLY.
  // v3.42 F3: the old `%name%` substring fallback matched mid-token ("test" inside
  // "loop-testing") and returned the highest-COUNT unrelated project, so `--project test`
  // silently queried the wrong project. Require a hyphen boundary: an interior token
  // (`%-name-%`) or a trailing token (`%-name`) so "test" no longer matches "testing".
  const token = db
    .prepare(
      `SELECT project FROM observations
       WHERE (project LIKE '%-' || ? || '-%' ESCAPE '\\' OR project LIKE '%-' || ? ESCAPE '\\')
       GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1`,
    )
    .get(likeLiteral(name), likeLiteral(name));
  if (token) {
    _cache.set(ck, token.project);
    return token.project;
  }

  // 4) Fallback: synthesize canonical form from current directory
  const inferred = inferProject();
  if (inferred.endsWith(`--${name}`)) {
    _cache.set(ck, inferred);
    return inferred;
  }

  _cache.set(ck, name);
  return name;
}

/** Reset cache (for tests). */
export function _resetProjectCache() {
  _cache.clear();
}
