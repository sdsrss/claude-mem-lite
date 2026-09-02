import { DAY_MS } from './time-constants.mjs';
// claude-mem-lite — deferred_work data layer
// Pure-data CRUD + ordinal resolver + transactional closure helper.
// Decoupled from observations table: different lifecycle, different scoring.

/**
 * Insert a new open deferred_work row.
 * @param {Database} db Opened DB
 * @param {object} args
 * @param {string} args.project Required project name
 * @param {string} args.title Required one-line subject
 * @param {number} [args.priority=2] 1=low, 2=normal, 3=urgent
 * @param {string} [args.detail] Optional longer description
 * @param {string[]} [args.files] Optional file paths
 * @param {string} [args.source_session_id] Mem session id
 * @param {number} [args.source_prompt_id] user_prompts.id
 * @returns {{id: number}} Inserted row id
 */
export function insertDeferred(db, args) {
  const { project, title, priority = 2, detail = null, files = null,
          source_session_id = null, source_prompt_id = null } = args;
  // source_session_id / source_prompt_id: forward-compat for v2.71+ defer-detector
  // hook (anchor a deferred item to the originating prompt). v1 inserts NULL.
  if (!project || typeof project !== 'string') throw new Error('project required');
  if (!title || typeof title !== 'string') throw new Error('title required');
  if (![1, 2, 3].includes(priority)) throw new Error('priority must be 1, 2, or 3');
  const stmt = db.prepare(`
    INSERT INTO deferred_work
      (project, title, detail, priority, status, created_at_epoch,
       source_session_id, source_prompt_id, files)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)
  `);
  const r = stmt.run(
    project, title, detail, priority, Date.now(),
    source_session_id, source_prompt_id,
    files ? JSON.stringify(files) : null,
  );
  return { id: Number(r.lastInsertRowid) };
}

/**
 * List open items in a project with computed per-project ordinal.
 * Ordinal is dynamic — recomputed each call by ROW_NUMBER over open rows
 * sorted (priority DESC, created_at_epoch ASC). When item-1 closes, item-2
 * becomes the new item-1.
 * @param {Database} db
 * @param {string} project
 * @param {number} [limit=10]
 * @returns {Array<{id, project, title, detail, priority, status, created_at_epoch, ordinal}>}
 */
export function listOpenWithOrdinal(db, project, limit = 10) {
  return db.prepare(`
    SELECT id, project, title, detail, priority, status, created_at_epoch,
           ROW_NUMBER() OVER (ORDER BY priority DESC, created_at_epoch ASC) AS ordinal
    FROM deferred_work
    WHERE project = ? AND status = 'open'
    ORDER BY priority DESC, created_at_epoch ASC
    LIMIT ?
  `).all(project, limit);
}

// ─── G11: list age + stale refresh hint (roadmap 2026-07-18) ─────────────────

// Internal const (was exported at v3.51.0 birth with zero external importers —
// knip-baseline discipline: un-export rather than grow the unused-exports list).
const DEFER_STALE_DAYS = 30;

/**
 * Render one `defer list` row (shared by CLI cmdDeferList and MCP
 * mem_defer_list — no hand-synced twins). Age rides inside the id tag:
 * `1. 🟡 [P2] title (D#5, 12d)`.
 * @param {{ordinal, priority, title, id, created_at_epoch}} r
 * @param {number} [now]
 */
export function formatDeferListRow(r, now = Date.now()) {
  const pTag = r.priority === 3 ? '🔴' : r.priority === 1 ? '⚪' : '🟡';
  const days = Math.max(0, Math.floor((now - r.created_at_epoch) / DAY_MS));
  return `${r.ordinal}. ${pTag} [P${r.priority}] ${r.title} (D#${r.id}, ${days}d)`;
}

/**
 * Count ALL open rows older than DEFER_STALE_DAYS in the project — deliberately
 * not derived from the displayed list: (priority DESC, created_at ASC) ordering
 * sinks old P1 rows past the LIMIT, and those are exactly the ones the hint
 * exists for.
 */
export function countStaleOpen(db, project, now = Date.now()) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM deferred_work
    WHERE project = ? AND status = 'open' AND created_at_epoch < ?
  `).get(project, now - DEFER_STALE_DAYS * DAY_MS).n;
}

/**
 * Tail hint for stale open items. Null when none — callers print nothing.
 * Nudge-only by design: no auto-demote / auto-drop (defer is a commitment
 * surface; silent cleanup would break it).
 * @param {number} staleCount
 * @returns {string|null}
 */
export function formatDeferStaleHint(staleCount) {
  if (!staleCount || staleCount <= 0) return null;
  return `⚠ ${staleCount} item(s) open >${DEFER_STALE_DAYS} days — refresh (still relevant?) or drop with a reason.`;
}

/**
 * Set status='dropped' with a non-empty reason. No-op when status is not 'open'.
 * @returns {{changed: number}} 1 if updated, 0 if not found or not open.
 */
export function dropDeferred(db, id, reason) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('drop reason required (non-empty string)');
  }
  const r = db.prepare(`
    UPDATE deferred_work
    SET status='dropped', closed_at_epoch=?, drop_reason=?
    WHERE id=? AND status='open'
  `).run(Date.now(), reason.trim(), id);
  return { changed: r.changes };
}

/**
 * Reasons that mean "this item was FIXED", for which `defer drop` is the wrong
 * verb — dropping loses the closed_by_obs_id link that `save --closes-deferred`
 * would have written, and leaves the row indistinguishable from a genuinely
 * rejected one (D#195; v3.86.0 dropped six fixed items this way).
 *
 * Deliberately a POSITIVE pattern for the fixed-shape, not a stop-list of
 * rejection wordings: the set of ways to say "no longer relevant" is open-ended,
 * the set of ways to say "done" is small. Advisory only — the drop still
 * succeeds, so a false positive costs one line of output.
 */
const DROP_REASON_FIXED_RE = /\b(fixed|implemented|shipped|resolved|done|closed by)\b|修复|已实现|已完成|完成了|已发布|已解决/i;

/**
 * Negative-sense veto, applied to the WHOLE reason before the positive pattern.
 *
 * A lookbehind cannot do this job: the sense-carrying word is not adjacent to the
 * keyword. "等待上游修复" (waiting for an upstream fix) puts 游 immediately before
 * 修复, so `(?<![待未需])修复` still fires on it — measured, which is why the
 * predicate is two-stage rather than one clever pattern. Suppression is the safe
 * direction here: a missed hint costs nothing, a wrong hint trains the reader to
 * ignore the line.
 */
const DROP_REASON_NOT_YET_RE = /\b(not|won'?t|cannot|can'?t|unable|pending|todo|blocked)\b|待|未|尚|需|无法|暂不/i;

/**
 * @param {string} reason The drop reason about to be recorded.
 * @returns {string|null} Advisory hint, or null when the reason does not look
 *          like a completion.
 */
export function formatDropReasonHint(reason) {
  if (typeof reason !== 'string') return null;
  if (DROP_REASON_NOT_YET_RE.test(reason)) return null;
  if (!DROP_REASON_FIXED_RE.test(reason)) return null;
  return '⚠ that reason reads like the item was FIXED — prefer `save --closes-deferred D#<id>`, '
    + 'which records status=done plus the closing observation id. `drop` records a rejection.';
}

/**
 * Fetch full deferred_work rows by raw id — ANY status, input order preserved,
 * missing ids omitted. This is the read half of the D# surface: `defer list`
 * stays title-only by design (dashboard noise budget), so `get D#N` is where
 * the detail field becomes readable at all.
 * @param {Database} db
 * @param {number[]} ids Raw deferred_work ids
 * @returns {Array<object>} Full rows
 */
export function getDeferredByIds(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const stmt = db.prepare(`SELECT * FROM deferred_work WHERE id = ?`);
  const rows = [];
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) continue;
    const r = stmt.get(id);
    if (r) rows.push(r);
  }
  return rows;
}

/**
 * Render one deferred_work row with FULL detail (never truncated) — shared by
 * CLI cmdGet and MCP mem_get so the two surfaces cannot drift.
 * @param {object} row Full deferred_work row (from getDeferredByIds)
 * @returns {string}
 */
export function formatDeferredDetail(row) {
  const pTag = row.priority === 3 ? '🔴' : row.priority === 1 ? '⚪' : '🟡';
  const lines = [`── D#${row.id} ── deferred (${row.status}) ${pTag} [P${row.priority}]`];
  lines.push(`project: ${row.project}`);
  lines.push(`title: ${row.title}`);
  if (row.detail) lines.push(`detail: ${row.detail}`);
  if (row.files) {
    try {
      const f = JSON.parse(row.files);
      if (Array.isArray(f) && f.length > 0) lines.push(`files: ${f.join(', ')}`);
    } catch { /* legacy non-JSON files value — skip rather than render garbage */ }
  }
  if (row.created_at_epoch) lines.push(`created: ${new Date(row.created_at_epoch).toISOString()}`);
  if (row.status === 'dropped' && row.drop_reason) lines.push(`drop_reason: ${row.drop_reason}`);
  if (row.status === 'done' && row.closed_by_obs_id) lines.push(`closed_by: #${row.closed_by_obs_id}`);
  // D#195: a row re-closed out of 'dropped' keeps its drop_reason. Render it under
  // a distinct label rather than dropping it from the view — the mis-drop is the
  // part a later reader needs, and a `drop_reason:` line on a done row would read
  // as a contradiction.
  if (row.status === 'done' && row.drop_reason) lines.push(`previously_dropped: ${row.drop_reason}`);
  return lines.join('\n');
}

/**
 * P2 search leg: make deferred items reachable from mem_search / CLI search.
 *
 * Two channels, merged direct-first and deduped:
 *   1. Explicit "D#N" refs in the query → direct id lookup, ANY status
 *      (an explicit reference deserves the row even if closed), project-scoped.
 *   2. Keyword match over OPEN items' title+detail — JS substring matching
 *      (never SQL LIKE, so %/_ are literals and wildcard injection is
 *      structurally impossible; corpus is ≤50 open rows per project).
 *      Multi-token queries need ceil(n/2) token hits so one generic token
 *      ("test", "lesson") can't drag the trailer into every search.
 *
 * Date bounds are deliberately NOT applied — open items are few, current by
 * definition, and the trailer is labeled as deferred work, not search results.
 *
 * @param {Database} db
 * @param {string} query Raw user query
 * @param {string} project Project scope (required — trailer is project-local)
 * @param {{limit?: number}} [opts]
 * @returns {Array<object>} Full rows, direct refs first, capped at limit
 */
export function searchDeferredWork(db, query, project, { limit = 3 } = {}) {
  if (!query || typeof query !== 'string' || !project) return [];

  const refIds = [];
  const refRe = /\bD#(\d+)\b/gi;
  let m;
  while ((m = refRe.exec(query)) !== null) {
    const id = parseInt(m[1], 10);
    if (id > 0 && !refIds.includes(id)) refIds.push(id);
  }
  const direct = refIds.length > 0
    ? getDeferredByIds(db, refIds).filter(r => r.project === project)
    : [];

  const tokens = query
    .replace(/\bD#\d+\b/gi, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length >= 2)
    .slice(0, 8);

  let keyword = [];
  if (tokens.length > 0) {
    const open = db.prepare(`
      SELECT * FROM deferred_work
      WHERE project = ? AND status = 'open'
      ORDER BY priority DESC, created_at_epoch ASC
      LIMIT 50
    `).all(project);
    const need = Math.max(1, Math.ceil(tokens.length / 2));
    keyword = open
      .map(r => {
        const hay = `${r.title || ''} ${r.detail || ''}`.toLowerCase();
        return { r, matched: tokens.filter(t => hay.includes(t)).length };
      })
      .filter(x => x.matched >= need)
      .sort((a, b) => b.matched - a.matched)
      .map(x => x.r);
  }

  const seen = new Set();
  const out = [];
  for (const r of [...direct, ...keyword]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Render the deferred search trailer — appended AFTER (and never counted in)
 * the main result set. Title-only lines; `invokeHint` names the surface's
 * full-detail reader (CLI `get D#N` / MCP mem_get).
 * @param {Array<object>} rows From searchDeferredWork
 * @param {string} invokeHint e.g. 'claude-mem-lite get D#<id>'
 * @returns {string[]} Lines (empty array when rows is empty)
 */
export function formatDeferredSearchTrailer(rows, invokeHint) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const lines = [`[mem] Deferred work matches — full detail: ${invokeHint}`];
  for (const r of rows) {
    const pTag = r.priority === 3 ? '🔴' : r.priority === 1 ? '⚪' : '🟡';
    const statusTag = r.status === 'open' ? '' : ` [${r.status}]`;
    const title = (r.title || '(untitled)').length > 80 ? `${r.title.slice(0, 80)}…` : (r.title || '(untitled)');
    lines.push(`  D#${r.id} ${pTag} [P${r.priority}]${statusTag} ${title}`);
  }
  return lines;
}

/**
 * Resolve mixed ordinal (int) + raw-id ("D#<n>") tokens to real deferred_work
 * ids, validated against caller project + an allowed status set.
 *
 * - bare integer N → ordinal-within-project (uses same ROW_NUMBER as listOpenWithOrdinal)
 * - "D#<n>" string → raw deferred_work.id; must belong to caller project AND
 *   carry an allowed status
 *
 * `allowStatuses` defaults to open-only, which is the DROP verb's policy and the
 * historical behaviour of every caller. The CLOSE verb (`save --closes-deferred`)
 * passes `['open', 'dropped']` per D#195: dropping an item that was actually
 * fixed used to be a one-way gate, permanently losing the closed_by_obs_id link.
 * 'done' is never allowed under either policy — re-closing would overwrite an
 * existing obs link with a different one.
 *
 * Ordinals stay open-only under every policy: the ROW_NUMBER that defines them
 * is computed over open rows, so a dropped row simply has no ordinal to name.
 * Reaching one requires the explicit `D#<n>` form.
 *
 * @param {Database} db
 * @param {string} project Caller project (FK guard)
 * @param {Array<number|string>} tokens Mixed input
 * @param {{allowStatuses?: string[]}} [opts]
 * @returns {number[]} Real deferred_work ids in input order
 * @throws {Error} On unresolvable input — error message names the offending token
 */
export function resolveDeferredIds(db, project, tokens, { allowStatuses = ['open'] } = {}) {
  if (!Array.isArray(tokens)) throw new Error('tokens must be an array');
  // Pre-load open list once for ordinal resolution (ROW_NUMBER snapshot stable
  // within this call so [1, 2] resolves consistently).
  const open = db.prepare(`
    SELECT id, ROW_NUMBER() OVER (ORDER BY priority DESC, created_at_epoch ASC) AS ordinal
    FROM deferred_work
    WHERE project = ? AND status = 'open'
  `).all(project);
  const ordinalToId = new Map(open.map(r => [r.ordinal, r.id]));

  const getRow = db.prepare(`SELECT id, project, status FROM deferred_work WHERE id = ?`);
  const seen = new Set();
  const resolved = [];

  for (const t of tokens) {
    let id;
    if (Number.isInteger(t)) {
      id = ordinalToId.get(t);
      if (id === undefined) {
        throw new Error(`ordinal ${t} has no corresponding open deferred item in project "${project}" (open count: ${open.length})`);
      }
    } else if (typeof t === 'string') {
      const m = /^D#(\d+)$/.exec(t.trim());
      if (!m) throw new Error(`invalid token "${t}" — expected D#N or integer ordinal`);
      id = parseInt(m[1], 10);
      const row = getRow.get(id);
      if (!row) throw new Error(`D#${id} not found`);
      if (row.project !== project) {
        throw new Error(`D#${id} belongs to project "${row.project}", not "${project}"`);
      }
      if (!allowStatuses.includes(row.status)) {
        // Verb-neutral: resolveDeferredIds is shared by close (save --closes-deferred)
        // AND drop (mem_defer_drop), so "cannot close" mis-described the drop path.
        const allowed = allowStatuses.map(s => `'${s}'`).join(' or ');
        throw new Error(`D#${id} status is "${row.status}" — only ${allowed} items are accepted here`);
      }
    } else {
      throw new Error(`invalid token type ${typeof t} — expected D#N or integer ordinal`);
    }
    if (seen.has(id)) throw new Error(`duplicate token resolves to id ${id}`);
    seen.add(id);
    resolved.push(id);
  }
  return resolved;
}

/**
 * Close a set of deferred items by id, all-or-nothing.
 *
 * Wraps the UPDATE loop in an internal transaction so that any per-row failure
 * rolls back prior rows. better-sqlite3's `.transaction()` composes with an
 * outer caller-managed transaction via SAVEPOINT — Task 5's wider closure flow
 * (obs INSERT + closeDeferredItems) wraps both calls in one outer transaction
 * to guarantee atomicity across the obs row and the deferred-work UPDATEs.
 *
 * @param {Database} db
 * @param {number[]} ids Already-resolved real ids (use resolveDeferredIds first)
 * @param {number} closingObsId observations.id that proves closure
 * @throws {Error} If any id is neither 'open' nor 'dropped' (lookup-based safety net)
 */
export function closeDeferredItems(db, ids, closingObsId) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  if (!Number.isInteger(closingObsId) || closingObsId <= 0) {
    throw new Error('closingObsId must be a positive integer');
  }
  // Defense-in-depth: even if caller already validated via resolveDeferredIds,
  // re-check status here (caller may have done resolution earlier in the same
  // transaction without holding a lock).
  //
  // D#195: 'dropped' is closable. drop_reason is intentionally NOT cleared — the
  // row's history is what makes a mis-drop auditable, and formatDeferredDetail
  // renders it as `previously_dropped:` once the status is 'done'. 'done' stays
  // excluded so a second close cannot overwrite an existing closed_by_obs_id.
  const stmt = db.prepare(`
    UPDATE deferred_work
    SET status='done', closed_at_epoch=?, closed_by_obs_id=?
    WHERE id=? AND status IN ('open', 'dropped')
  `);
  const now = Date.now();
  const tx = db.transaction((idList) => {
    for (const id of idList) {
      const r = stmt.run(now, closingObsId, id);
      if (r.changes !== 1) {
        throw new Error(`closeDeferredItems: id ${id} was not in a closable status ('open' or 'dropped') (changes=${r.changes})`);
      }
    }
  });
  tx(ids);
}
