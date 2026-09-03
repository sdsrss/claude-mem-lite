// Shared body for the registry write actions — import / remove / reindex / enrich.
//
// These were the last un-collapsed CLI/MCP twin (audit 2026-08-22 P1-3): mem-cli.mjs and
// server.mjs each wrote their own SQL for the same three actions, and had already drifted —
// the CLI granted a user-initiated import `quality_tier = 'installed'` and the MCP twin did
// not, so the same intent produced differently-ranked rows depending on which surface the
// user reached for. That is this project's first-listed病类 ("a guard wired into one face,
// missing on the other"), so the fix is a single body both faces call, not a second patch.
//
// Contract: these functions decide and write. They return structured results and never
// format output or touch process state — rendering (and CLI-only concerns like bare-flag
// rejection or the "add --capability-summary" tip) stays in the surface.

import { readFileSync } from 'fs';

import { upsertResource } from '../registry.mjs';
import { isPathConfined } from '../utils.mjs';

/**
 * String columns an import may set, in canonical snake_case. Single source: the CLI derives
 * its kebab-case flag names from this list, the MCP tool reads its args by these keys, so a
 * new column is added once and both surfaces pick it up.
 */
export const IMPORT_STRING_FIELDS = [
  'repo_url',
  'local_path',
  'invocation_name',
  'intent_tags',
  'domain_tags',
  'trigger_patterns',
  'capability_summary',
  'keywords',
  'tech_stack',
  'use_cases',
];

/**
 * Resolve the `source` column for an import.
 *
 * Preserve provenance on a metadata-only re-import: default to 'user' only for a genuinely
 * NEW resource. Re-importing an existing github/preinstalled row without an explicit source
 * must not flip it to 'user' (which also mis-grants the user-source rank boost).
 */
function resolveSource(db, { type, name, source }) {
  if (source) return source;
  const existing = db.prepare('SELECT source FROM resources WHERE type = ? AND name = ?').get(type, name);
  return existing ? existing.source : 'user';
}

/**
 * Upsert one resource.
 *
 * @param {object} db  open resource-registry.db handle
 * @param {object} params
 * @param {string} params.name
 * @param {string} params.type              'skill' | 'agent'
 * @param {string} [params.source]          explicit provenance; absent = user-initiated
 * @param {object} [params.fields]          IMPORT_STRING_FIELDS values (snake_case keys)
 * @returns {{id: number, source: string, installedTierGranted: boolean}}
 */
export function importResource(db, { name, type, source, fields = {} }) {
  const resolvedSource = resolveSource(db, { type, name, source });

  const row = { name, type, status: 'active', source: resolvedSource };
  for (const f of IMPORT_STRING_FIELDS) row[f] = fields[f] || '';

  const id = upsertResource(db, row);

  // A user-initiated import (no explicit --source/source arg) means the user deliberately
  // added this resource — it gets the 'installed' quality tier, which the retriever reads as
  // a ranking bonus and the recommendation gate reads as a precision signal.
  const installedTierGranted = Boolean(id) && !source;
  if (installedTierGranted) {
    db.prepare("UPDATE resources SET quality_tier = 'installed' WHERE id = ?").run(id);
  }

  return { id, source: resolvedSource, installedTierGranted };
}

/**
 * Delete one resource.
 * @returns {{removed: boolean}} removed=false means nothing matched (not an error).
 */
export function removeResource(db, { name, type }) {
  const result = db.prepare('DELETE FROM resources WHERE type = ? AND name = ?').run(type, name);
  return { removed: result.changes > 0 };
}

/**
 * Rebuild the FTS5 index over the resources table.
 * @returns {{activeCount: number}}
 */
export function reindexResources(db) {
  db.exec("INSERT INTO resources_fts(resources_fts) VALUES('rebuild')");
  const row = db.prepare('SELECT COUNT(*) as c FROM resources WHERE status = ?').get('active');
  return { activeCount: row.c };
}

// ─── Enrichment (four legs, one gate) ───────────────────────────────────────
//
// `resources.local_path` is a filesystem path stored in a DB row, and every enrichment leg
// ends in `readFileSync(local_path)`. Before audit 2026-09-02 P1-3 the confinement check
// guarded exactly ONE of the four legs — the MCP `enrich` action — while the MCP
// `import_url --enrich` leg, the CLI `enrich <name>` leg and the CLI `enrich --all` leg read
// the path bare. That is this repo's first-listed 病类 in its narrowest form: not "CLI vs
// MCP" but "one branch of one face". Counting the legs is what showed the MCP side was
// itself half-guarded, so a CLI-only patch would have left the shape alive on both faces.
//
// Every leg now funnels through `enrichResourceRow`, so a new leg cannot be written without
// passing `confineTo` — and omitting it is a visible `undefined`, not a silently absent `if`.

/** Env var that disables the confinement gate (escape hatch for relocated managed dirs). */
export const REGISTRY_CONFINE_ENV = 'CLAUDE_MEM_REGISTRY_CONFINE';

/**
 * Whether the confinement gate is active. Only `off` disables it — case-insensitively and
 * ignoring surrounding whitespace, so `OFF` and ` off\n` also open the gate. Every OTHER
 * value, including an unset one and every near-miss (`of`, `0`, `false`, `disable`), keeps
 * the gate ON, because the failure mode of a typo must be "refuses a path it could have
 * read", never "reads a path it should have refused". Said precisely because the first
 * version of this sentence claimed "the exact string `off`" in three places, which is the
 * wrong description of a `.trim().toLowerCase()` — the safety property held, the wording
 * did not.
 */
export function registryConfineEnabled(env = process.env) {
  return String(env[REGISTRY_CONFINE_ENV] ?? '').trim().toLowerCase() !== 'off';
}

/**
 * Enrich one already-resolved resource row.
 *
 * @param {object} db                       open resource-registry.db handle
 * @param {object} row                      must carry {name, type, local_path}
 * @param {object} opts
 * @param {string} opts.confineTo           base dir `local_path` must stay within
 * @param {Function} opts.enrichResource    injected `(db,name,type,content) => Promise<boolean>`;
 *                                          injected rather than imported so this module stays a
 *                                          leaf and the Anthropic SDK stays off the CLI's
 *                                          cold-start path (both faces already lazy-import it)
 * @param {object} [opts.env]               env source for the escape hatch (tests pass their own)
 * @returns {Promise<{status:'enriched'|'failed'|'no-path'|'denied'|'unreadable', error?:Error}>}
 *          `error` is carried on 'unreadable' only: a stale local_path (the file was moved or
 *          deleted after import) is the common case, and the errno is the whole diagnosis —
 *          collapsing it into a bare status would make this refactor a diagnosability
 *          regression on the one leg that already surfaced the message.
 */
export async function enrichResourceRow(db, row, { confineTo, enrichResource, env } = {}) {
  // `confineTo` is REQUIRED, and a missing one throws rather than defaulting to "no gate".
  // The defect this replaces was three call sites that simply had no `if` — invisible in
  // review because absence has no syntax. A fifth leg written without the gate now fails
  // loudly on its first call instead of shipping as a silent hole; the static sweep in
  // tests/registry-enrich-confinement.test.mjs catches it earlier still.
  if (!confineTo) throw new TypeError('enrichResourceRow: confineTo is required');
  if (!row?.local_path) return { status: 'no-path' };
  if (registryConfineEnabled(env) && !isPathConfined(row.local_path, confineTo)) {
    return { status: 'denied' };
  }
  let content;
  try {
    content = readFileSync(row.local_path, 'utf8');
  } catch (e) {
    return { status: 'unreadable', error: e };
  }
  // Enrichment itself is an LLM round-trip; a throw here is a failed enrichment, not a
  // refused read, and the two must stay distinguishable in the counts the surfaces render.
  try {
    return { status: (await enrichResource(db, row.name, row.type, content)) ? 'enriched' : 'failed' };
  } catch (e) {
    return { status: 'failed', error: e };
  }
}

/**
 * Enrich the rows an import just produced (MCP `import_url --enrich` + CLI `import --enrich`).
 *
 * `results` carries only {id, name, type}; local_path is read back per row because
 * importFromGitHub writes it during the import.
 *
 * @returns {Promise<{ok:number, denied:number, total:number}>}
 */
export async function enrichImportedResources(db, results, { confineTo, enrichResource, env } = {}) {
  // Checked here too, not only in the delegate: an empty `results` never reaches
  // enrichResourceRow, so an ungated caller would otherwise pass on the empty input a test
  // is most likely to use and throw only in production.
  if (!confineTo) throw new TypeError('enrichImportedResources: confineTo is required');
  let ok = 0, denied = 0;
  for (const r of results) {
    const row = db.prepare('SELECT name, type, local_path FROM resources WHERE id = ?').get(r.id);
    const { status } = await enrichResourceRow(db, row, { confineTo, enrichResource, env });
    if (status === 'enriched') ok++;
    else if (status === 'denied') denied++;
  }
  return { ok, denied, total: results.length };
}

/**
 * Resolve one active resource by name and enrich it (MCP `enrich` + CLI `enrich <name>`).
 * @returns {Promise<{status:'not-found'|'enriched'|'failed'|'no-path'|'denied'|'unreadable', name:string, error?:Error}>}
 */
export async function enrichNamedResource(db, name, { confineTo, enrichResource, env } = {}) {
  // Same reason as enrichImportedResources: the 'not-found' return short-circuits above the
  // delegate, so the gate check cannot be left to it.
  if (!confineTo) throw new TypeError('enrichNamedResource: confineTo is required');
  const row = db
    .prepare("SELECT name, type, local_path FROM resources WHERE name = ? AND status = 'active'")
    .get(name);
  if (!row) return { status: 'not-found', name };
  const { status, error } = await enrichResourceRow(db, row, { confineTo, enrichResource, env });
  return { status, name: row.name, error };
}

/**
 * How a registry search hit should be invoked, and the path worth showing for it.
 *
 * Audit 2026-09-02 P2-6: this ran to ~15 lines in `mem-cli.mjs cmdRegistry` and again in
 * `server.mjs mem_registry`, and the copies had already diverged on `portablePath`:
 *
 *   MCP   `isManaged ? toPortable(local_path) : ''`
 *   CLI   `isManaged && local_path.startsWith(home) ? '~'+… : (local_path || '')`
 *
 * For a NON-managed resource the CLI therefore printed `Path: /home/<user>/…` — an absolute
 * path, un-tilde'd, for a row whose `Use:` line is `Skill("x")` or `mem_use(name=…)` and
 * never mentions the path at all. MCP printed nothing. The MCP behaviour is the one kept:
 * the line carried no action for the reader and spelled out a home directory to do it.
 *
 * Returns DATA, not a rendered line. The two faces genuinely differ in dialect — the CLI
 * indents four spaces and prints through `out()`, MCP indents two and emits Markdown bold —
 * and collapsing that would replace a real duplicate with a formatting flag.
 *
 * @param {{name:string,type:string,local_path?:string,invocation_name?:string}} r
 * @param {{home:string, managedPrefix:string}} ctx  `managedPrefix` is `<dataDir>/managed/`,
 *   already including the trailing separator, so the caller owns CLAUDE_MEM_DIR resolution.
 * @returns {{isManaged:boolean, portablePath:string, howToUse:string}}
 */
export function resourceUseHint(r, { home, managedPrefix }) {
  const isManaged = Boolean(r.local_path && r.local_path.includes(managedPrefix));
  const portablePath = isManaged
    ? (r.local_path.startsWith(home) ? '~' + r.local_path.slice(home.length) : r.local_path)
    : '';
  const agentArg = r.type === 'agent' ? ', type="agent"' : '';

  let howToUse;
  if (isManaged) {
    // Managed: Read(path) or mem_use — Skill() does not resolve managed resources.
    // Agents always carry a complete .md path; only skills can be a directory, which
    // resolves to its SKILL.md.
    const resolvedPath = portablePath.endsWith('.md') ? portablePath : `${portablePath}/SKILL.md`;
    howToUse = `Read("${resolvedPath}") or mem_use(name="${r.name}"${agentArg})`;
  } else if (r.invocation_name) {
    // Native plugin/user resource: invoke by its full invocation name.
    howToUse = r.type === 'skill'
      ? `Skill("${r.invocation_name}")`
      : `Agent(subagent_type="${r.invocation_name}")`;
  } else {
    howToUse = `mem_use(name="${r.name}"${agentArg})`;
  }
  return { isManaged, portablePath, howToUse };
}
