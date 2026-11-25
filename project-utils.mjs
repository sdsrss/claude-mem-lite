// claude-mem-lite shared project resolution
// Extracted from server.mjs and mem-cli.mjs to eliminate duplication

import { basename, dirname } from 'path';
import { editDistance } from './lib/edit-distance.mjs';

// Leaf module: imports nothing from utils.mjs. utils.mjs re-exports this module's
// symbols as a backward-compat barrel, so importing the barrel back from here
// would close a cycle (v3.56 P2-9). Keep this file dependency-free of the barrel.

const _cache = new Map();

/**
 * Infer a sanitized project name from CLAUDE_PROJECT_DIR, PWD, or cwd.
 * Format: "parent--basename"; letters, marks and digits of any script and `_.-` kept, every other
 * character replaced by a hyphen (projectNameFromDir).
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
 * — the identity came from the env, the filesystem root from the process. The test face showed
 * it first (a hook subprocess spawned with the repo root as cwd read the REAL repo's git state,
 * and the assertion pinning the dashboard leg passed or failed on whether the host tree was
 * dirty). Production diverges too: a session that has `cd`'d elsewhere fires its hooks from
 * there, so cwd is that directory while CLAUDE_PROJECT_DIR still names the project.
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
  // Sanitize to prevent path traversal when used in filenames (ep-<project>.json).
  //
  // D9: letters, combining marks and digits of ANY script survive. The rule used to keep
  // ASCII alone, so ~/projects/博客 and ~/projects/商城 were both `projects----` and shared
  // one memory. ASCII input comes out byte for byte as before (\p{L}/\p{N} restricted to
  // ASCII are exactly a-zA-Z/0-9, and ASCII has no marks), so no ASCII project moves. NFC
  // first: macOS can hand the same directory over decomposed. Separators, punctuation,
  // symbols, emoji and invisible format characters (bidi overrides) are still replaced.
  // scripts/post-tool-use.sh does not reimplement this for non-ASCII names; it hands them
  // to Node.
  const safe = raw.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}_.-]/gu, '-');
  // At most 100 UTF-8 BYTES, cut at a character boundary: filesystem name limits count
  // bytes (255), and 100 CJK characters are 300. For ASCII this is the old 100-char cut.
  if (Buffer.byteLength(safe) <= 100) return safe;
  let out = '';
  let bytes = 0;
  for (const ch of safe) {
    bytes += Buffer.byteLength(ch);
    if (bytes > 100) break;
    out += ch;
  }
  return out;
}

/** Escape LIKE metacharacters so a caller-supplied value is matched literally.
 *  R10 P2-3: unescaped, `--project '%'` matched every project and ORDER BY COUNT(*)
 *  returned the biggest one; `_` matched any single character the same way.
 *
 *  THE only copy in the repo, and it lives here because this module is a leaf over
 *  `node:path` alone — the ~30 ms cold-start hook scripts already import it, so the
 *  shared home costs them nothing. `lib/file-edge-match.mjs` imports it rather than
 *  keeping the second copy it had: that second copy escaped `%` and `_` and not the
 *  escape character, which is the whole of R12 B-1. Backslash first is not optional —
 *  under `ESCAPE '\'` SQLite reads `\` + any character as that character taken
 *  literally, so an un-doubled backslash is consumed and the pattern silently stops
 *  matching the string it was built from. */
export function likeLiteral(s) {
  return String(s ?? '').replace(/[\\%_]/g, '\\$&');
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
  // The one cwd answer that is not a guess: the caller's own directory IS "<parent>--<name>".
  // Without it, a short name saved there before the project had rows became a bare-name
  // project that the full id shadowed once it existed (E2E 2026-10-16, data S9).
  if (mode === 'write') {
    const own = inferProject();
    const answer = own.endsWith(`--${name}`) ? own : name;
    _cache.set(ck, answer);
    return answer;
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

/** Whether any table that carries a project holds rows for this exact id. */
function projectHasRows(db, project) {
  return !!db
    .prepare(
      `SELECT 1 FROM observations WHERE project = @p
       UNION ALL SELECT 1 FROM sdk_sessions WHERE project = @p
       UNION ALL SELECT 1 FROM deferred_work WHERE project = @p
       UNION ALL SELECT 1 FROM events WHERE project = @p
       LIMIT 1`,
    )
    .get({ p: project });
}

/** Every project id a table that carries one holds, except `name` itself. */
function otherProjectIds(db, name) {
  return db
    .prepare(
      `SELECT project FROM observations UNION SELECT project FROM sdk_sessions
       UNION SELECT project FROM deferred_work UNION SELECT project FROM events`,
    )
    .all()
    .map((r) => r.project)
    .filter((p) => typeof p === 'string' && p && p !== name);
}

/** Existing project ids equal to `id` except for case. */
function caseVariants(db, id) {
  const want = id.toLowerCase();
  return otherProjectIds(db, id)
    .filter((p) => p.toLowerCase() === want)
    .sort();
}

/**
 * Up to three existing project ids a caller who typed `name` may have meant: the whole id or its
 * last "--" segment within a small edit distance, case-insensitive. Short names need a closer
 * match (3 letters or fewer: none; under 8: one edit; else two), so "api" never means "app".
 */
function similarProjects(db, name) {
  const want = String(name).toLowerCase();
  const max = want.length <= 3 ? 0 : want.length < 8 ? 1 : 2;
  const ids = otherProjectIds(db, name);
  const scored = [];
  for (const id of ids) {
    const lower = id.toLowerCase();
    const tail = lower.includes('--') ? lower.slice(lower.lastIndexOf('--') + 2) : lower;
    const d = Math.min(editDistance(want, lower, max), editDistance(want, tail, max));
    if (d <= max) scored.push({ id, d });
  }
  return scored
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((s) => s.id);
}

/**
 * The write-side check both save faces make once resolveProject(…, { mode: 'write' }) has
 * answered. A short name that matches no project but sits one or two edits from one is a typo,
 * and the write would have created a stray project the caller never finds again: refused, with
 * the near names. A new name nothing resembles, or a full "<parent>--<name>" id, is a deliberate
 * new project: written, with a note saying so (E2E 2026-10-16, cli F14). A full id that differs
 * from an existing one only in case is refused like a near name: it was written as a new project
 * the existing id's reads never find (pre-tag review 2026-10-16 P3-6).
 *
 * @returns {{ok: true, note: string} | {ok: false, message: string}}
 */
export function checkWriteProject(db, project) {
  if (!project || projectHasRows(db, project)) return { ok: true, note: '' };
  const fullId = project.includes('--');
  const near = fullId ? caseVariants(db, project) : similarProjects(db, project);
  if (near.length > 0) {
    return {
      ok: false,
      message:
        `No project "${project}" — did you mean ${near.map((p) => `"${p}"`).join(', ')}? Nothing was saved. ` +
        (fullId
          ? `Project ids are case-sensitive, and "${project}" differs from ${near.length > 1 ? 'them' : 'it'} only in case.`
          : `To start a new project under this name, pass its full id ("<parent>--${project}") or save from inside its directory.`),
    };
  }
  return { ok: true, note: ` (new project "${project}")` };
}

/**
 * For a READ: the note when `name` resolves to a project with no rows anywhere, else ''. Such a
 * read answered "No results" exactly like a real project with nothing matching (E2E 2026-10-16,
 * cli F14).
 */
export function unknownProjectNote(db, name) {
  const resolved = resolveProject(db, name);
  if (!resolved || projectHasRows(db, resolved)) return '';
  const near = similarProjects(db, name);
  return `No project "${name}" has any rows${near.length ? ` — did you mean ${near.map((p) => `"${p}"`).join(', ')}?` : '.'}`;
}

/** Reset cache (for tests). */
export function _resetProjectCache() {
  _cache.clear();
}
