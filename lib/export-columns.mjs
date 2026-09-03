// Single source of truth for the observation columns that `export` emits and `restore`
// reads back. Both the CLI (`cmdExport` in mem-cli.mjs) and the MCP `mem_export` tool
// (server.mjs) build their SELECT from this list so the two surfaces can never drift.
//
// v3.42 audit HIGH-2: the MCP export handler had its own narrower 16-column SELECT while
// the CLI export carried 24 — missing exactly the columns cmdRestore reads back
// (text / files_read / search_aliases / cited_count / uncited_streak / injection_count /
// decay_seen_count / last_accessed_at). A backup taken via MCP export then restored via CLI
// silently collapsed every empty-`narrative` row (import-jsonl / cold-start bodies live in
// `text`) to its bare title — unrecoverable AND unsearchable. Sharing one list closes that
// twin-drift class permanently.
//
// Full round-trippable set: content + value-signals (access/cited/uncited/injection/decay)
// + branch + timing. `id` + `memory_session_id` are informational (restore remaps id and
// buckets under a synthetic restore session). Session-idempotency keys (last_decided/
// last_cited_session_id, demoted_at, optimized_at) are intentionally NOT exported — they are
// meaningless after a row is re-bucketed under a restore session. Also intentionally NOT
// exported: `related_ids` (holds observation ids, stale/dangling after restore remaps ids)
// and `discovery_tokens` (a derived retrieval metric, rebuilt by the live system; exporting
// it would freeze a stale value into backups).
// `compressed_into` (audit 2026-08-14 M-8): only ever non-null in an export taken
// with --include-compressed / include_compressed — the default WHERE excludes those
// rows. Without the column, a compressed member round-tripped through restore as a
// LIVE row and turned up in search results next to the weekly-summary keeper that
// already absorbed it. Restore does not remap it (the keeper's id is meaningless in
// the target store); it REJECTS marked rows instead — see cmdRestore.
import { liveObsFilterSql } from './inject-search-core.mjs';

export const EXPORT_COLUMNS = [
  'id', 'memory_session_id', 'project', 'type', 'title', 'subtitle', 'narrative', 'text',
  'concepts', 'facts', 'files_read', 'files_modified', 'lesson_learned', 'search_aliases',
  'scope', 'compressed_into',
  'importance', 'branch', 'access_count', 'cited_count', 'uncited_streak', 'injection_count',
  'decay_seen_count', 'last_accessed_at', 'created_at', 'created_at_epoch',
];

// The SELECT column fragment (comma-joined) — drop into `SELECT ${EXPORT_COLUMNS_SQL} FROM …`.
export const EXPORT_COLUMNS_SQL = EXPORT_COLUMNS.join(', ');

/**
 * Assemble the `WHERE` predicate both export faces share.
 *
 * Audit 2026-09-02 P2-5. The COLUMN set above has been shared since v3.42 (HIGH-2, when the
 * MCP handler was found carrying a narrower 16-column SELECT and silently dropping
 * text/aliases/citation-signals from the advertised backup→restore flow). The PREDICATE was
 * still typed out twice — `mem-cli.mjs cmdExport` and `server.mjs runExport` — which is the
 * half-collapsed shape that lets a `WHERE` drift while the columns stay in step, on the one
 * command whose output people restore from.
 *
 * Only the SQL is shared. Everything the two faces genuinely disagree about stays with them,
 * because each disagreement is a decision rather than an accident:
 *   - PARSING and validation: the CLI `fail()`s with a usage message on a bad date and
 *     rejects an unknown `--type`; the MCP tool throws, and its type arrives through a
 *     schema enum. Callers pass epochs, already parsed.
 *   - The LIMIT: the CLI defaults to the complete matching set (it is the documented backup
 *     half of backup/restore); MCP defaults to 200 and probes limit+1, because an MCP result
 *     is model context and a bare exploratory call must not dump a store into a transcript.
 *   - The inverted-range note, which only the CLI has a stderr channel for.
 *
 * @param {object} o
 * @param {boolean} [o.includeCompressed]  Include compressed rows. Superseded rows are
 *   excluded EITHER WAY — exporting tombstones is opt-in, exporting retractions never is.
 * @param {string|null} [o.project]        Already resolved to a canonical project name.
 * @param {string|null} [o.type]           Already validated by the caller.
 * @param {number|null} [o.fromEpoch]      Inclusive lower bound, ms.
 * @param {number|null} [o.toEpoch]        Inclusive upper bound, ms (callers push it to
 *   end-of-day themselves when the user gave a bare date).
 * @returns {{wheres: string[], params: Array<string|number>, where: string}}
 *   `wheres`/`params` for a caller that composes its own clause; `where` is the ready
 *   `WHERE …` string (never empty — the live-row predicate is always present).
 */
export function buildExportWhere({ includeCompressed = false, project = null, type = null, fromEpoch = null, toEpoch = null } = {}) {
  const wheres = [];
  const params = [];
  wheres.push(includeCompressed ? 'superseded_at IS NULL' : liveObsFilterSql(''));
  if (project) { wheres.push('project = ?'); params.push(project); }
  if (type) { wheres.push('type = ?'); params.push(type); }
  if (fromEpoch !== null && fromEpoch !== undefined) { wheres.push('created_at_epoch >= ?'); params.push(fromEpoch); }
  if (toEpoch !== null && toEpoch !== undefined) { wheres.push('created_at_epoch <= ?'); params.push(toEpoch); }
  return { wheres, params, where: 'WHERE ' + wheres.join(' AND ') };
}
