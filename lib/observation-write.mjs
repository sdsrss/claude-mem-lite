// Single source of truth for the observations-table write surface. Two ingest
// paths previously hand-wrote divergent INSERTs — lib/save-observation.mjs (manual
// mem_save, 16 cols, omitted subtitle/search_aliases) and hook-llm.mjs (LLM
// auto-ingest, 18 cols) — the exact column-drift hazard the compress/maintain
// single-source cores were extracted to eliminate (see #8614). Add a column HERE
// and both ingest paths pick it up; neither can silently fall out of sync again.
//
// Statement-only: callers own the transaction boundary (both wrap the row + files
// writes in one db.transaction so a failure can't leave a partial row).

import { cjkBigrams, scrubSecrets } from '../utils.mjs';

// Canonical column order — must mirror the observations schema (schema.mjs).
const OBS_COLUMNS = [
  'memory_session_id',
  'project',
  'text',
  'type',
  'title',
  'subtitle',
  'narrative',
  'concepts',
  'facts',
  'files_read',
  'files_modified',
  'importance',
  'minhash_sig',
  'lesson_learned',
  'search_aliases',
  'branch',
  'created_at',
  'created_at_epoch',
  'scope',
];

// P3 (D#78): lesson applicability scope. Hard whitelist — Haiku output is
// untrusted; anything outside the enum (including case variants) becomes NULL,
// which every scope-aware read path treats as "unclassified, do not filter".
const VALID_SCOPES = new Set(['file', 'module', 'project', 'environment']);

/** Validate an LLM-emitted scope value against the enum; invalid → null. */
export function normalizeScope(value) {
  return typeof value === 'string' && VALID_SCOPES.has(value) ? value : null;
}

// Single source for the scope-classification legend (D#135 P3). THREE write
// faces classify scope — the episode summarizer (hook-llm), save-time enrichment
// (lib/save-enrich) and the re-enrich passes (hook-optimize). Hand-copied
// definitions would drift, and a column whose `environment` means something
// different per face makes the CLAUDE_MEM_SCOPE_FILTER read lever incoherent —
// the same OBS_TYPE_ENUM hard-copy problem the 2026-07-17 audit flagged.
// Rendered as `scope: ${SCOPE_PROMPT_LEGEND}` in every prompt.
export const SCOPE_PROMPT_LEGEND =
  "where does the lesson APPLY (not where it was learned)? file = specific to the touched file(s)' own code. module = a directory/subsystem of this project. project = a project-wide convention, architecture, or workflow. environment = a tooling/OS/CI/network/registry/service quirk (proxy, npm, git, GitHub, shell, runner, editor) that would hold in ANY project — even though some project files were touched when it surfaced. When lesson_learned is null, still classify the episode's dominant subject.";
// Defaults for columns a caller omits. NULL-default columns (subtitle,
// search_aliases) match the schema DEFAULT, so omitting == the old short INSERT.
// concepts/facts/files_read default to the empty literals the manual path used.
const OBS_DEFAULTS = {
  subtitle: null,
  narrative: '',
  concepts: '',
  facts: '',
  files_read: '[]',
  files_modified: '[]',
  search_aliases: null,
  importance: 1,
};

/**
 * Column-level value normalization applied by BOTH write cores (insert and update).
 *
 * Today it holds exactly one rule, and it is a real one (audit P3-14). `importance` is
 * `INTEGER DEFAULT 1` but NULLABLE, and the DEFAULT only applies when the column is
 * OMITTED from the INSERT — it never is here, because the column list is fixed. So a
 * caller passing `importance: null`, or `importance: undefined` as an OWN property (which
 * skips the OBS_DEFAULTS lookup above), wrote a NULL. better-sqlite3 binds both to SQL
 * NULL and throws on neither, so nothing upstream would have caught it.
 *
 * A NULL there is not cosmetic: the two maintenance faces disagree about what it means.
 * `maintain-core.decayAndMarkIdle` reads `COALESCE(importance,1) = 1` and queues the row
 * for purge; `search-scoring.runIdleCleanup` reads a bare `importance <= 1`, which is NULL
 * (falsy) and skips it. Aligning those two predicates was rejected — the alignment that
 * closes the gap is the one that makes the MCP face START purging — and a NOT NULL
 * migration means rebuilding a table that carries FTS5 triggers, for a population measured
 * at 0 rows. Making NULL unwritable at the two shared cores costs one function and leaves
 * both read faces exactly as they are. `doctor --session-audit` reports any row that got
 * in by another route.
 *
 * @param {string} col Column name.
 * @param {*} value Value the caller supplied (or the default).
 * @returns {*} Value to bind.
 */
function normalizeObsValue(col, value) {
  if (col === 'importance' && (value === null || value === undefined)) return OBS_DEFAULTS.importance;
  return value;
}

/**
 * Insert one observations row from a {column: value} map and return its id.
 * Omitted columns fall back to OBS_DEFAULTS (or NULL). The column list lives only
 * here, so a schema column can never drift between the two ingest paths again.
 */
export function insertObservationRow(db, fields) {
  const values = OBS_COLUMNS.map((c) =>
    normalizeObsValue(
      c,
      Object.prototype.hasOwnProperty.call(fields, c)
        ? fields[c]
        : c in OBS_DEFAULTS
          ? OBS_DEFAULTS[c]
          : null,
    ),
  );
  const placeholders = OBS_COLUMNS.map(() => '?').join(', ');
  const result = db
    .prepare(`INSERT INTO observations (${OBS_COLUMNS.join(', ')}) VALUES (${placeholders})`)
    .run(...values);
  return Number(result.lastInsertRowid);
}

/** Populate the observation_files junction (skips non-string / empty entries). */
export function insertObservationFiles(db, obsId, files) {
  if (!obsId || !Array.isArray(files) || files.length === 0) return;
  const stmt = db.prepare('INSERT OR IGNORE INTO observation_files (obs_id, filename) VALUES (?, ?)');
  for (const f of files) if (typeof f === 'string' && f.length > 0) stmt.run(obsId, f);
}

/**
 * Rebuild an observation's derived columns after a field UPDATE: the FTS `text`
 * column, incl. CJK bigrams + search_aliases, matching the ingest paths. It also
 * rebuilt the TF-IDF vector until Phase-2 removed that arm. cmdUpdate (CLI) and
 * mem_update (MCP) previously hand-copied this block — the same drift class
 * #8614/#8639 closed for compress/maintain. Caller owns the transaction.
 */
// P2-12: internal-only since applyObsUpdate became the single update choke point
// (both faces previously imported this directly; un-exported per knip discipline).
/**
 * The `text` search blob a row's columns imply, for a given narrative. Factored out so the
 * rebuild can ask "is `text` already what I would derive?" with the exact same expression
 * it writes — a second, drifting copy of the concatenation would defeat the check.
 * @param {object} row observations row (title/subtitle/concepts/facts/lesson_learned/search_aliases)
 * @param {string} narrative narrative to derive with ('' probes the already-derived shape)
 * @returns {string}
 */
function derivedText(row, narrative) {
  const base = [
    row.title,
    row.subtitle,
    narrative,
    row.concepts,
    row.facts,
    row.lesson_learned,
    row.search_aliases,
  ]
    .filter(Boolean)
    .join(' ');
  const bigrams = cjkBigrams((row.title || '') + ' ' + (narrative || ''));
  return bigrams ? base + ' ' + bigrams : base;
}

/**
 * Does `text` look like an already-derived search blob rather than an orphaned body?
 *
 * Byte-equality against derivedText() cannot answer this: the OTHER producer of these rows
 * (hook-llm.mjs buildFtsTextField) joins concepts + facts + aliases + bigrams and omits
 * title and narrative entirely, so its output never equals this module's concatenation.
 * What both derived shapes DO share is that every token comes from the row's own
 * enrichment fields. A real body — an import-jsonl tool payload, a user's prose — carries
 * tokens found nowhere else on the row. So: all-known ⇒ derived ⇒ do not promote.
 * The title-only case falls out of the same test.
 * @param {object} row observations row
 * @returns {boolean}
 */
function looksAlreadyDerived(row) {
  const text = String(row.text || '').trim();
  if (!text) return true;
  const known = new Set(
    (
      [row.title, row.subtitle, row.concepts, row.facts, row.lesson_learned, row.search_aliases]
        .filter(Boolean)
        .join(' ') +
      ' ' +
      cjkBigrams(String(row.title || ''))
    )
      .split(/\s+/)
      .filter(Boolean),
  );
  const tokens = text.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => known.has(t));
}

function rebuildObservationDerived(db, obsId) {
  const row = db
    .prepare(
      'SELECT title, subtitle, narrative, concepts, facts, lesson_learned, search_aliases, text FROM observations WHERE id = ?',
    )
    .get(obsId);
  if (!row) return;
  // Deriving `text` from these columns is sound ONLY while `narrative` holds the body.
  // Two ingest shapes break that: import-jsonl writes `narrative: ''` with the whole
  // payload in `text`, and OBS_DEFAULTS defaults `narrative` to '' for any caller that
  // omits it. On such a row the rebuild used to derive from a base with no body in it, so
  // `update <id> --importance 3` — a field unrelated to content — replaced the payload
  // with nothing but the row's own title. Unrecoverable: update takes no snapshot (only
  // `delete` does), and the row also stopped matching searches for its own contents.
  //
  // Repair in place instead of guessing: promote the orphaned body into `narrative`, then
  // derive. Content-preserving, and idempotent because the next rebuild sees a non-empty
  // narrative.
  //
  // "Empty narrative" alone is NOT enough to conclude that `text` holds a body. A second
  // production shape has an empty narrative legitimately: hook-llm.mjs (`narrative:
  // obs.narrative || ''`), persistHaikuSummary and hook-optimize.mjs all write rows whose
  // `text` is ALREADY the derived FTS blob — concepts + facts + aliases + CJK bigrams,
  // which never contains a narrative. Promoting that blob would write bigram fragments
  // ("构认", "证模") into a user-visible field rendered by both get faces, injected into
  // context and fed to compress — irreversibly, since update takes no snapshot. Caught
  // pre-tag by review; reproduced, then closed with looksAlreadyDerived() — see there for
  // why byte-equality against derivedText() is the wrong test.
  let narrative = row.narrative;
  if ((!narrative || !narrative.trim()) && !looksAlreadyDerived(row)) {
    narrative = row.text;
    db.prepare('UPDATE observations SET narrative = ? WHERE id = ?').run(narrative, obsId);
  }
  const textField = derivedText(row, narrative);
  db.prepare('UPDATE observations SET text = ? WHERE id = ?').run(textField, obsId);
}

// P2-12 (audit 2026-08-14): shared update mutation for the CLI `update` / MCP
// `mem_update` twin. Both faces previously built the SET list + ran the
// transaction + rebuild inline (byte-equivalent copies); each keeps its own
// validation front-end (CLI flag guards / MCP zod) and passes only the fields
// it accepted. String values are secret-scrubbed here — the single choke point,
// so a new face can't forget it (concepts had already slipped through once).
const UPDATABLE_OBS_COLS = ['title', 'narrative', 'type', 'importance', 'lesson_learned', 'concepts'];

/**
 * Apply a validated field patch to one observation: UPDATE + derived-column
 * rebuild (FTS text) in one transaction.
 * @param {import('better-sqlite3').Database} db
 * @param {number} id - observation id (caller has verified existence)
 * @param {object} fields - subset of {title, narrative, type, importance, lesson_learned, concepts}
 * @returns {string[]} column names actually updated ([] = nothing to do, no write)
 */
export function applyObsUpdate(db, id, fields) {
  const updates = [];
  const params = [];
  for (const col of UPDATABLE_OBS_COLS) {
    if (fields[col] !== undefined) {
      updates.push(`${col} = ?`);
      // Same normalization as the insert core — an update is the OTHER way a NULL
      // importance gets into the table, and a rule applied on one write path only is the
      // shape this repo keeps paying for. `!== undefined` above lets an explicit null
      // through, which is exactly the case normalizeObsValue catches.
      const v = normalizeObsValue(col, fields[col]);
      params.push(typeof v === 'string' ? scrubSecrets(v) : v);
    }
  }
  if (updates.length === 0) return [];
  params.push(id);
  db.transaction(() => {
    db.prepare(`UPDATE observations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    rebuildObservationDerived(db, id);
  })();
  return updates.map((u) => u.split(' =')[0]);
}
