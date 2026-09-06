// lib/delete-core.mjs — shared hard-delete orchestration for the CLI `delete`
// command (mem-cli.mjs cmdDelete) and the MCP `mem_delete` tool (server.mjs).
// Both surfaces previously inlined a byte-for-byte-equivalent copy of this logic,
// kept in sync by "aligned with MCP mem_delete" / "matching the CLI delete" parity
// comments — the project's documented #1 drift risk. Consolidated here so there is
// one implementation: pre-delete snapshot, stale related_ids cleanup,
// merged/compressed-child recovery, and the delete transaction.
import { snapshotDb } from './db-backup.mjs';
import { recoverChildrenOf } from './maintain-core.mjs';
import { debugCatch, truncate } from '../utils.mjs';

/**
 * Hard-delete the given observation ids with full orchestration. The CALLER owns
 * the confirm/preview gating and fetches whatever rows it needs to render (existence
 * check, preview list, missing-id note); this performs only the irreversible mutation
 * once the caller has decided to proceed.
 *
 * Order (preserved from the pre-extraction inline paths):
 *   1. snapshotDb OUTSIDE any transaction (VACUUM INTO cannot run inside one). Best-
 *      effort: no-op on :memory:, never throws.
 *   2. In ONE transaction: strip the deleted ids out of other rows' related_ids
 *      (coarse LIKE pre-filter → JSON-parse precise filter), recover children
 *      merged/compressed INTO the doomed rows (compressed_into has no FK), then DELETE.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} ids  observation ids to delete
 * @param {{ snapshotTag?: string }} [opts]
 * @returns {{ deleted: number, recoveredChildren: number, snapshotPath: string|null }}
 */
export function deleteObservations(db, ids, { snapshotTag = 'pre-delete' } = {}) {
  const placeholders = ids.map(() => '?').join(',');

  // Snapshot before the irreversible hard-delete so a wrong-id delete has a pre-image,
  // matching the maintain purge/cleanup hard-delete paths (audit MED-2). Best-effort
  // (never throws, skips :memory:). Must run OUTSIDE the transaction below (VACUUM INTO).
  const snapshotPath = snapshotDb(db, { tag: snapshotTag });

  const deletedIds = new Set(ids);
  const deleteTx = db.transaction(() => {
    // Clean up stale references in other observations' related_ids.
    // LIKE %id% is a coarse pre-filter (false positives: %1% matches [10], [21]) — it only
    // narrows which rows to fetch; the JSON parse + Set.has below is the precise filter.
    // Acceptable because observation count per user is typically <10K.
    const likeConditions = ids.map(() => `related_ids LIKE ?`).join(' OR ');
    const likeParams = ids.map((id) => `%${id}%`);
    const referencing = db
      .prepare(
        `
      SELECT id, related_ids FROM observations
      WHERE related_ids IS NOT NULL AND related_ids != '[]' AND (${likeConditions})
    `,
      )
      .all(...likeParams);
    for (const r of referencing) {
      let refIds;
      try {
        refIds = JSON.parse(r.related_ids);
      } catch (e) {
        debugCatch(e, 'deleteRelatedIds');
        continue;
      }
      // Only rewrite a well-formed integer array; a malformed related_ids value is left
      // untouched rather than reshaped by the filter (the stricter of the two originals).
      if (!Array.isArray(refIds) || !refIds.every((id) => Number.isInteger(id))) continue;
      const filtered = refIds.filter((id) => !deletedIds.has(id));
      if (filtered.length !== refIds.length) {
        db.prepare('UPDATE observations SET related_ids = ? WHERE id = ?').run(
          JSON.stringify(filtered),
          r.id,
        );
      }
    }
    // Resurface rows merged/compressed INTO the doomed keepers before deleting, else they
    // dangle behind a now-missing parent (compressed_into has no FK) — invisible to every
    // COALESCE(compressed_into,0)=0 view and unrecoverable. Same guard the maintain
    // hard-delete paths use (recoverChildrenOf).
    const recovered = recoverChildrenOf(db, ids);
    // Execute deletion (FTS5 cleanup handled by the observations_ad trigger).
    const deleted = db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`).run(...ids);
    return { changes: deleted.changes, recovered };
  });
  const result = deleteTx();
  return { deleted: result.changes, recoveredChildren: result.recovered, snapshotPath };
}

/**
 * Shared delete-preview body (P2-12): fetch the doomed rows and format the
 * per-row lines both faces print between their own header ("Preview: N …")
 * and footer (--confirm vs confirm=true remedy). The SELECT and the row shape
 * were duplicated in mem-cli.mjs + server.mjs and are the exact place a
 * preview/execute drift would hide.
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} ids
 * @returns {{rows: Array<{id:number,type:string,title:string,project:string}>, lines: string[]}}
 */
export function previewDeleteRows(db, ids) {
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, type, title, project FROM observations WHERE id IN (${ph})`)
    .all(...ids);
  const lines = rows.map(
    (r) => `  #${r.id} [${r.type}] ${truncate(r.title || '(untitled)', 80)} | ${r.project}`,
  );
  // Requested ids with no row. Both faces used to derive this themselves and only
  // in their CONFIRM branch, so the PREVIEW — whose entire job is to show what is
  // about to happen — silently omitted them: `delete 42,43,44` listed two rows and
  // the user learned 43 never existed only after confirming. Computed here so the
  // CLI and mem_delete report the same set from one place. Order follows the
  // caller's id order, which is the order they typed.
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  return { rows, lines, missing };
}
