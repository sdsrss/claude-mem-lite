// cli/activity.mjs — `claude-mem-lite activity <save|search|recent|show>`.
// Extracted from mem-cli.mjs (v2.41, god-module split). Thin wrapper over
// lib/activity.mjs pure functions.
//
// Events namespace is separate from observations (schema.mjs v2.31 T6): the
// activity table stores bugfix/lesson/bug/discovery/refactor/feature/observation/
// decision events with their own FTS5 index. All mutations go through
// lib/activity.mjs::saveEvent, which enforces the type CHECK and populates
// events_fts via triggers.

import { inferProject } from '../utils.mjs';
import { resolveProject, checkWriteProject } from '../project-utils.mjs';
import { resolveCliProject as cliProject } from '../lib/cli-project.mjs';
import { parseArgs, out, fail, rejectBareStringFlags } from './common.mjs';
import { parseIntFlag, isNumericToken } from '../lib/cli-flags.mjs';
import { snapshotDb } from '../lib/db-backup.mjs';
import { isBlankText } from '../lib/blank-text.mjs';
import { CLI_INVOKE } from '../cli-path.mjs';

// E#N, the form search, get and --supersedes use for an event: a bare #N names an observation
// everywhere else, so an id copied from this list into `delete` hit an unrelated row (converge R30).
function formatActivityResults(rows) {
  if (!rows || rows.length === 0) return '(no events)';
  return rows.map((r) => `E#${r.id} [${r.event_type}] ${r.title}`).join('\n');
}

/** An event id as typed: N, #N or E#N (the form search and get print), else null. */
function eventIdOf(token) {
  const m = /^(?:[Ee]#?|#)?(\d+)$/.exec(String(token).trim());
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function cmdActivity(db, args) {
  const sub = args[0];
  if (!sub) {
    fail(`[mem] Usage: ${CLI_INVOKE} activity <save|search|recent|show|delete|promote> ...`);
    return;
  }

  const { positional, flags } = parseArgs(args.slice(1));
  const { saveEvent, searchEvents, recentEvents, getEvent, EVENT_TYPES, promoteInsightEvents } =
    await import('../lib/activity.mjs');
  const VALID_EVENT_TYPES = new Set(EVENT_TYPES);
  // `save` CREATES a row, so it keeps plain inferProject(): the DB-aware fallback is a read
  // affordance, and applying it to a write absorbs a not-yet-born subproject's first event
  // into the enclosing repo (pre-tag review, reproduced). Every other subcommand reads or
  // operates on rows that already exist, where falling back is what finds them. A named
  // project is resolved for `save` the way `save` and `defer add` resolve theirs: exact
  // matching only, then checkWriteProject below.
  const project = flags.project
    ? resolveProject(db, flags.project, sub === 'save' ? { mode: 'write' } : undefined)
    : sub === 'save'
      ? inferProject()
      : cliProject(db);

  if (sub === 'save') {
    // Reject value-less string flags before they reach saveEvent as a boolean `true`
    // (#8470): bare --body / --title crashed with a raw "SQLite3 can only bind ..." error.
    if (rejectBareStringFlags(flags, ['type', 'title', 'body', 'files', 'file', 'project'])) return;
    const type = flags.type || 'observation';
    if (!VALID_EVENT_TYPES.has(type)) {
      fail(`[mem] activity save: invalid --type "${type}". Valid: ${[...VALID_EVENT_TYPES].join(', ')}`);
      return;
    }
    const title = flags.title || positional.join(' ').trim();
    if (isBlankText(title)) {
      fail('[mem] activity save: --title or positional text required');
      return;
    }
    const body = flags.body || null;
    // Accept both --file (singular, backward compat) and --files (plural,
    // comma-split, preferred — matches cmdSave). Merge both sources.
    const filesFromPlural =
      flags.files && typeof flags.files === 'string'
        ? flags.files
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    const filesFromSingular = flags.file && typeof flags.file === 'string' ? [flags.file] : [];
    const file_paths_merged = [...filesFromSingular, ...filesFromPlural];
    const file_paths = file_paths_merged.length > 0 ? file_paths_merged : null;
    const rawImp = flags.importance !== undefined ? parseInt(flags.importance, 10) : 2;
    // isNumericToken first (mirrors cmdSave): bare parseInt coerces "3xyz"→3 and would
    // persist a wrong importance that silently skews ranking. Float literals truncate (#8277).
    if (
      flags.importance !== undefined &&
      (!isNumericToken(flags.importance) || isNaN(rawImp) || rawImp < 1 || rawImp > 3)
    ) {
      fail(`[mem] Invalid importance "${flags.importance}". Must be 1, 2, or 3.`);
      return;
    }
    // A near miss of an existing project is refused, a new name is noted: the check `save` and
    // `defer add` make (pre-tag review 2026-10-16 P3-4). stdout stays the JSON line.
    const projectCheck = flags.project ? checkWriteProject(db, project) : { ok: true, note: '' };
    if (!projectCheck.ok) {
      fail(`[mem] ${projectCheck.message}`);
      return;
    }
    const id = saveEvent(db, {
      project,
      event_type: type,
      title,
      body,
      importance: rawImp,
      file_paths,
    });
    out(JSON.stringify({ ok: true, id }));
    if (projectCheck.note) process.stderr.write(`[mem] Saved event E#${id}${projectCheck.note}\n`);
    return;
  }

  if (sub === 'search') {
    const q = positional.join(' ');
    if (!q) {
      fail('[mem] activity search: query required');
      return;
    }
    const type = flags.type || null;
    if (type !== null && !VALID_EVENT_TYPES.has(type)) {
      fail(`[mem] activity search: invalid --type "${type}". Valid: ${[...VALID_EVENT_TYPES].join(', ')}`);
      return;
    }
    const limit = parseIntFlag(flags.limit, { name: '--limit', defaultValue: 10, max: 1000 });
    const rows = searchEvents(db, q, { project, type, limit });
    out(formatActivityResults(rows));
    return;
  }

  if (sub === 'recent') {
    // Accept either `activity recent 5` or `activity recent --limit 5`. Both routed
    // through parseIntFlag so garbage ("2abc"), negatives (SQLite LIMIT -1 = UNLIMITED
    // full-table dump), and uncapped huge values warn + clamp to default/max, matching
    // the search/recent/browse siblings.
    const limit =
      positional.length > 0
        ? parseIntFlag(positional[0], { name: 'count', defaultValue: 20, max: 1000 })
        : parseIntFlag(flags.limit, { name: '--limit', defaultValue: 20, max: 1000 });
    const type = flags.type || null;
    if (type !== null && !VALID_EVENT_TYPES.has(type)) {
      fail(`[mem] activity recent: invalid --type "${type}". Valid: ${[...VALID_EVENT_TYPES].join(', ')}`);
      return;
    }
    const rows = recentEvents(db, { project, type, limit });
    out(formatActivityResults(rows));
    return;
  }

  if (sub === 'show') {
    const id = positional.length > 0 ? eventIdOf(positional[0]) : null;
    if (id === null) {
      fail(
        `[mem] activity show: an event id is required (N, #N or E#N)${positional[0] ? `, got "${positional[0]}"` : ''}`,
      );
      return;
    }
    const row = getEvent(db, id);
    if (row) {
      out(JSON.stringify(row, null, 2));
    } else {
      // fail() (stderr + exit 1), matching the not-found contract of sibling commands
      // (`get`, `activity delete`, `update`); previously stdout + exit 0, so scripts
      // couldn't detect a missing event from the exit code.
      fail(`[mem] activity show: event #${id} not found`);
    }
    return;
  }

  if (sub === 'delete') {
    // Mirrors cmdDelete (mem-cli.mjs:1316): preview by default, --confirm
    // executes. Per Tier 3b in tasks/v2.66-carry-forward.md the events table
    // accumulates corrupted titles from old hook-llm fallback bugs (#8158).
    // This command lets users prune them by ID without dropping to raw SQL.
    const idStr = positional.join(',').trim();
    if (!idStr) {
      fail(`[mem] Usage: ${CLI_INVOKE} activity delete <id1,id2,...> [--confirm]`);
      return;
    }
    const tokens = idStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Every token must be an id, or nothing is deleted: `2x` used to parseInt to 2 and delete
    // a row the caller never named (E2E 2026-10-16).
    const bad = tokens.filter((t) => eventIdOf(t) === null);
    if (bad.length > 0) {
      fail(
        `[mem] activity delete: not an event id: ${bad.join(', ')} (use N, #N or E#N) — nothing was deleted`,
      );
      return;
    }
    const ids = [...new Set(tokens.map(eventIdOf))];
    if (ids.length === 0) {
      fail('[mem] activity delete: no valid IDs provided (must be positive integers)');
      return;
    }

    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, event_type, title FROM events WHERE id IN (${placeholders})`)
      .all(...ids);
    if (rows.length === 0) {
      fail(`[mem] activity delete: no events found for ID(s) ${ids.join(', ')}`);
      return;
    }

    const confirm = flags.confirm === true || flags.confirm === 'true';
    if (!confirm) {
      out(`[mem] Preview: ${rows.length} event(s) will be deleted:`);
      for (const r of rows) {
        const titleStr = (r.title || '').slice(0, 100);
        out(`  #${r.id} [${r.event_type}] ${titleStr}`);
      }
      const missingIds = ids.filter((i) => !rows.some((r) => r.id === i));
      if (missingIds.length > 0) {
        out(`[mem] Note: ${missingIds.length} ID(s) not found and will be skipped: ${missingIds.join(', ')}`);
      }
      out('[mem] Run with --confirm to execute deletion.');
      return;
    }

    // A pre-image first, as deleteObservations takes for observations (E2E 2026-10-16 round 2:
    // this hard delete had none). Best-effort; outside the transaction (VACUUM INTO).
    snapshotDb(db, { tag: 'pre-delete' });
    // The opt-in search telemetry keeps a title per returned result; an explicit delete drops the
    // deleted events' titles, as lib/delete-core.mjs does for observations (D#245 N6).
    const result = db
      .transaction(() => {
        if (
          db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_results'").get()
        ) {
          db.prepare(
            `UPDATE search_results SET snapshot_label = NULL WHERE source = 'event' AND result_id IN (${placeholders})`,
          ).run(...ids);
        }
        return db.prepare(`DELETE FROM events WHERE id IN (${placeholders})`).run(...ids);
      })
      .immediate(); // IMMEDIATE: it starts with a read (E2E 2026-10-16 round 3; see delete-core)
    out(`[mem] Deleted ${result.changes} event(s).`);
    return;
  }

  if (sub === 'promote') {
    // P2(b): promote insight-bearing events (body present, importance>=N) into
    // searchable observations. Preview by default; --execute applies. One-time
    // backfill — the source events are marked promoted (idempotent re-runs).
    // Whole digits only: a bare parseInt read `2x` as 2.
    const rawMin = flags['min-importance'];
    const minImp = rawMin === undefined ? 2 : /^\d+$/.test(String(rawMin)) ? Number(rawMin) : NaN;
    if (isNaN(minImp) || minImp < 1 || minImp > 3) {
      fail('[mem] activity promote: --min-importance must be 1, 2, or 3.');
      return;
    }
    const projectFilter = flags.project ? project : null;
    const execute = flags.execute === true || flags.execute === 'true';
    const r = promoteInsightEvents(db, { project: projectFilter, minImportance: minImp, execute });
    if (!execute) {
      out(
        `[mem] Preview: ${r.eligible} insight-bearing event(s) (body + importance>=${minImp})${projectFilter ? ` in ${projectFilter}` : ' across all projects'} would be promoted to searchable observations.`,
      );
      out('[mem] Run with --execute to apply. Source events are kept (marked promoted).');
      return;
    }
    out(
      `[mem] Promoted ${r.promoted} event(s) to observations${r.deduped ? ` (${r.deduped} already had an equivalent observation)` : ''}.`,
    );
    return;
  }

  fail(`[mem] Unknown activity subcommand: ${sub}`);
}
