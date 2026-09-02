// lib/events-injection.mjs — surface `events` into the passive injection surfaces.
//
// HIGH-1 (full audit 2026-07-16): persistHaikuSummary upgrade-deletes every
// event-typed memory (bugfix/decision/lesson/discovery/…) out of `observations`
// and into the `events` table, so after Haiku enrichment the high-value history
// lives ONLY in events. v3.44 wired events into mem_search + PreToolUse recall,
// but the passive injection surfaces still read only observations — so the promoted
// memories were unreachable at prompt/session time.
//
// Wiring (v3.48.0): SessionStart context (hook-context.mjs, recency) + UserPromptSubmit
// path B (hook.mjs memory-context, FTS). Path A (user-prompt-search.js) is INTENTIONALLY
// not wired: both UserPromptSubmit hooks fire on every prompt and there is no cross-hook
// events dedup, so wiring path A too would double-inject the same event. Do NOT "complete"
// the wiring by adding events here to path A.
//
// id-space discipline: events share the numeric id space with observations but are a
// separate table, so injected events are rendered with an `E#` prefix. The
// citation-tracker injected-id extractors all anchor on a BARE `#`
// (FYI `/^#\d/`, memory-context `/\(#\d/`, error-recall row-anchored), so an `E#`
// row is never mis-attributed to an observation id (which would let citation decay
// mutate an unrelated observation sharing that id). Events carry no citation columns,
// so they inject as reference-only — reachability, not decay bookkeeping.
//
// D#202: that paragraph was true of the faces it names and FALSE of the one it does
// not. `scripts/pre-tool-recall.js` renders its own merged obs+event rows and used a
// bare `#` for both, so nearly half of that channel's injected rows (44.9%, measured
// over 4227 firings) were event ids entering the observation decay denominator —
// exactly the mis-attribution this prefix exists to prevent. The invariant was stated
// here while the face that broke it lived elsewhere and was not enumerated. The prefix
// is now a shared constant (lib/injected-ids.mjs, a leaf so the hot PreToolUse path
// need not pull this file's search-core chain) and
// tests/pretool-event-id-namespace.test.mjs sweeps both renderers.

import { searchEventsFts } from './search-core.mjs';
import { neutralizeContextDelimiters } from '../format-utils.mjs';
import { EVENT_ID_PREFIX } from './injected-ids.mjs';

const DEFAULT_LIMIT = 3;
const DEFAULT_MIN_IMPORTANCE = 2;
const TITLE_MAX = 80;
const LESSON_MAX = 160;

function normalizeRow(r) {
  return {
    id: r.id,
    type: r.event_type || r.type || 'event',
    title: r.title || '',
    lesson_learned: (r.body ?? r.lesson_learned) || null,
    importance: r.importance,
    created_at_epoch: r.created_at_epoch,
  };
}

/**
 * FTS-matched events for a prompt (UserPromptSubmit surfaces). Superseded events are
 * excluded by searchEventsFts; importance floor drops low-value rows. Never throws.
 *
 * Takes a BUILT query, never raw prompt text (audit ALGO-1). The old `prompt` option ran
 * the uncapped sanitizeFtsQuery, and the one caller used it — so this leg of
 * UserPromptSubmit paid 356ms on a 250KB CJK prompt while the event's other two legs
 * went through lib/ups-query.mjs's cap. Removing the option rather than capping it here
 * is what stops the next caller walking back in: prompt-time callers must name the cap
 * they are using, and `claude-mem-lite search` stays deliberately uncapped.
 *
 * @returns {Array<{id,type,title,lesson_learned,importance,created_at_epoch}>}
 */
export function searchInjectableEvents(db, { ftsQuery, project, limit = DEFAULT_LIMIT, minImportance = DEFAULT_MIN_IMPORTANCE } = {}) {
  if (!db || !project) return [];
  const q = ftsQuery || null;
  if (!q) return [];
  try {
    const rows = searchEventsFts(db, {
      ftsQuery: q, project, projectBoost: project,
      importance: minImportance, perSourceLimit: limit,
    });
    return rows.map(normalizeRow);
  } catch { return []; }
}

/**
 * Recency + importance events (SessionStart context — no FTS query available).
 * Excludes superseded events. Never throws.
 * @returns {Array<{id,type,title,lesson_learned,importance,created_at_epoch}>}
 */
export function recentInjectableEvents(db, { project, limit = DEFAULT_LIMIT, minImportance = DEFAULT_MIN_IMPORTANCE } = {}) {
  if (!db || !project) return [];
  try {
    const rows = db.prepare(`
      SELECT id, event_type, title, body, importance, created_at_epoch
      FROM events
      WHERE project = ?
        AND superseded_at_epoch IS NULL
        AND COALESCE(importance, 1) >= ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(project, minImportance, limit);
    return rows.map(normalizeRow);
  } catch { return []; }
}

/**
 * Render one injectable event as a defanged `E#<id> [<type>] <title> — <lesson>` line.
 * The E# prefix keeps citation-tracker extractors (which anchor on a bare `#`) from
 * mis-reading the event id as an observation id.
 */
export function renderInjectableEvent(row) {
  const title = neutralizeContextDelimiters((row.title || '').slice(0, TITLE_MAX));
  // row.type is a frozen event_type enum (saveEvent is reached only via
  // hook-llm.mjs behind `if (EVENT_TYPE_SET.has(summary.type))`), so it carries no
  // injection markers and is intentionally NOT defanged — mirrors the un-defanged
  // `[type]` for observations. If an unvalidated event writer is ever added, defang it.
  const head = `${EVENT_ID_PREFIX}${row.id} [${row.type}] ${title}`;
  if (row.lesson_learned) {
    const lesson = neutralizeContextDelimiters(row.lesson_learned.trim().slice(0, LESSON_MAX));
    if (lesson) return `${head} — ${lesson}`;
  }
  return head;
}
