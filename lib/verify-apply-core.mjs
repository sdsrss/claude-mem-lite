// lib/verify-apply-core.mjs — the deterministic write half of /verify.
//
// Design notes live outside the repository; commands/verify.md is the shipped contract. The judgement ("is this memory
// still true?") belongs to an agent with repository tools; that division is measured, not
// taste — a cheap single-shot model reached STALE precision 0.36, and model-written addenda
// were false 28 times in 72 (one more unsupported), while agent raters agreed at kappa 0.84
// on a 58-memory sample (memories #202-#204).
// So the agent PROPOSES and this module is the only thing that WRITES: every write goes
// through the existing choke points (saveObservation's supersede path, applyObsUpdate), in
// one IMMEDIATE transaction, after a validation pass that has already refused anything it
// cannot stand behind.

import { createHash, randomBytes } from 'crypto';
import { unlinkSync, readdirSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { saveObservation } from './save-observation.mjs';
import { applyObsUpdate, looksAlreadyDerived } from './observation-write.mjs';
import { liveObsFilterSql } from './inject-search-core.mjs';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';
import { scrubFilePaths } from './scrub-record.mjs';

/** `superseded_by` marker for a memory retired with no replacement. */
export const VERIFY_RETIRED_MARKER = 'verify-retired';
/** `superseded_by` marker for a replacement row retired by --undo. */
const VERIFY_UNDONE_MARKER = 'verify-undone';

const BACKUP_KIND = 'claude-mem-lite/verify-backup';
// v2 carries the post-apply record (`applied`) that makes --undo refuse drifted rows; a v1
// file has none, and an undo without it is exactly the unsafe restore review P1-1 reproduced.
const BACKUP_VERSION = 2;
const LESSON_MAX = 500;

const ACTIONS = new Set(['replace', 'edit', 'retire']);
const VERDICTS = new Set(['STALE', 'PARTIAL']);
const KEYS_BY_ACTION = {
  replace: new Set([
    'id',
    'action',
    'verdict',
    'evidence',
    'title',
    'narrative',
    'lesson_learned',
    'importance',
    'facts',
    'concepts',
  ]),
  edit: new Set(['id', 'action', 'verdict', 'evidence', 'set']),
  retire: new Set(['id', 'action', 'verdict', 'evidence']),
};
// The columns applyObsUpdate accepts, minus `type`: a verification corrects what a memory
// SAYS, and re-typing it is a classification change nobody verified. `facts` is not here
// because applyObsUpdate (the shared CLI/MCP update choke point) does not take it; a stale
// claim in `facts` goes through `replace`, which does.
const EDITABLE = new Set(['title', 'narrative', 'lesson_learned', 'importance', 'concepts']);
// Fields that may legitimately be set to the empty string (to drop a stale value).
const MAY_BE_EMPTY = new Set(['facts', 'concepts']);

// What an apply can change on a row it targets, in two groups, because --undo restores them
// separately: an `edit` changes CONTENT and never supersession; a `replace`/`retire` changes
// SUPERSESSION and never content. `optimized_at` is content here: the apply stamps it (below).
const CONTENT_COLUMNS = [
  'title',
  'subtitle',
  'narrative',
  'text',
  'facts',
  'concepts',
  'lesson_learned',
  'importance',
  'search_aliases',
  'scope',
  'optimized_at',
];
const SUPERSESSION_COLUMNS = ['superseded_at', 'superseded_by'];
// Everything --undo compares before it restores: a row whose tracked state differs from what
// the apply left has been touched since, and restoring over it would destroy that write.
const TRACKED_COLUMNS = [...CONTENT_COLUMNS, ...SUPERSESSION_COLUMNS, 'compressed_into'];
// What makes a row THE row a backup was taken from. Ids alone are not enough: a backup from
// another database (or a hand-edited one) names ids that exist here and belong to someone else.
const IDENTITY_COLUMNS = ['project', 'memory_session_id', 'created_at_epoch'];
// What an approval covers on each target row: everything tracked, plus what a replacement copies.
const APPROVED_STATE_COLUMNS = [...TRACKED_COLUMNS, 'type', 'branch', 'project'];
const SCRUBBED_ON_RESTORE = new Set([
  'title',
  'subtitle',
  'narrative',
  'text',
  'facts',
  'concepts',
  'lesson_learned',
  'search_aliases',
]);

const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c] === undefined ? null : row[c]]));
const scrubMaybe = (v) => (typeof v === 'string' ? scrubSecrets(v) : v);
/** Columns (of `cols`) whose values differ between two rows. */
const differing = (cur, want, cols) => cols.filter((c) => JSON.stringify(cur[c]) !== JSON.stringify(want[c]));

function checkField(where, key, value, errors) {
  if (key === 'importance') {
    if (!Number.isInteger(value) || value < 1 || value > 3)
      errors.push(`${where}: importance must be 1, 2 or 3`);
    return;
  }
  if (typeof value !== 'string' || (!MAY_BE_EMPTY.has(key) && value.trim().length === 0)) {
    errors.push(`${where}: ${key} must be a ${MAY_BE_EMPTY.has(key) ? '' : 'non-empty '}string`);
    return;
  }
  if (key === 'lesson_learned' && value.length > LESSON_MAX) {
    errors.push(`${where}: lesson_learned is ${value.length} chars (max ${LESSON_MAX})`);
  }
}

/**
 * Validate a proposals document's SHAPE. Pure — no DB. Any error empties `entries`, so a
 * caller cannot apply the valid half of a document that was partly wrong.
 * @param {unknown} input parsed JSON
 * @returns {{entries: object[], errors: string[]}}
 */
export function parseProposals(input) {
  const errors = [];
  if (!Array.isArray(input)) return { entries: [], errors: ['proposals must be a JSON array'] };
  if (input.length === 0) return { entries: [], errors: ['proposals array is empty'] };
  const seen = new Set();
  const entries = [];
  input.forEach((e, i) => {
    const where = `entry ${i + 1}${e && Number.isInteger(e.id) ? ` (#${e.id})` : ''}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    if (!Number.isInteger(e.id) || e.id <= 0) errors.push(`${where}: id must be a positive integer`);
    else if (seen.has(e.id)) errors.push(`${where}: duplicate id #${e.id}`);
    else seen.add(e.id);
    if (!ACTIONS.has(e.action)) {
      errors.push(`${where}: action must be one of replace, edit, retire`);
      return;
    }
    for (const k of Object.keys(e))
      if (!KEYS_BY_ACTION[e.action].has(k)) errors.push(`${where}: unknown key "${k}"`);
    if (!VERDICTS.has(e.verdict)) errors.push(`${where}: verdict must be STALE or PARTIAL`);
    if (typeof e.evidence !== 'string' || e.evidence.trim().length === 0) {
      errors.push(`${where}: evidence is required (a commit, a file:line, or a command and its output)`);
    }
    if (e.action === 'replace') {
      for (const k of ['title', 'narrative', 'lesson_learned', 'importance', 'facts', 'concepts']) {
        if (e[k] !== undefined) checkField(where, k, e[k], errors);
      }
    } else if (e.action === 'edit') {
      const set = e.set;
      if (!set || typeof set !== 'object' || Array.isArray(set) || Object.keys(set).length === 0) {
        errors.push(`${where}: edit needs a non-empty "set" object`);
      } else {
        for (const [k, v] of Object.entries(set)) {
          if (!EDITABLE.has(k))
            errors.push(`${where}: "${k}" is not editable (allowed: ${[...EDITABLE].join(', ')})`);
          else checkField(where, k, v, errors);
        }
      }
    }
    entries.push(e);
  });
  return errors.length ? { entries: [], errors } : { entries, errors };
}

function filesOf(db, id) {
  return db
    .prepare('SELECT filename FROM observation_files WHERE obs_id = ? ORDER BY filename')
    .all(id)
    .map((r) => r.filename);
}

function isLive(row) {
  return row.superseded_at === null && (row.compressed_into === null || row.compressed_into === 0);
}

const getRow = (db, id) => db.prepare('SELECT * FROM observations WHERE id = ?').get(id);

/**
 * Check every entry against the DB: the row exists, is live, and belongs to `project`.
 * Read-only. Any error empties `plan`.
 * @returns {{plan: object[], errors: string[]}}
 */
export function planVerifyApply(db, entries, { project }) {
  const errors = [];
  const plan = [];
  for (const e of entries) {
    const row = getRow(db, e.id);
    if (!row) {
      errors.push(`#${e.id}: no such observation`);
      continue;
    }
    if (row.project !== project) {
      errors.push(`#${e.id}: belongs to project ${row.project}, not ${project}`);
      continue;
    }
    if (!isLive(row)) {
      errors.push(`#${e.id}: not live (already superseded or compressed)`);
      continue;
    }
    if (e.action === 'replace' && !String(e.narrative ?? row.narrative ?? '').trim()) {
      errors.push(`#${e.id}: replace needs a narrative (the original has none to copy)`);
      continue;
    }
    // On a row with no narrative, an update can move the row's stored text into `narrative`
    // (rebuildObservationDerived's repair for import-shaped rows) — a write the dry run would
    // not show. It does so when the text does not look derived from the row's own fields,
    // judged on the row AS THE EDIT LEAVES IT: the set values as applyObsUpdate stores them
    // (scrubbed), since the rebuild runs after the set is written and a new title or concepts
    // changes which words count as the row's own. Require the
    // narrative in the set then, so what is shown is what is written.
    if (
      e.action === 'edit' &&
      e.set.narrative === undefined &&
      !String(row.narrative ?? '').trim() &&
      !looksAlreadyDerived({
        ...row,
        ...Object.fromEntries(Object.entries(e.set).map(([k, v]) => [k, scrubMaybe(v)])),
      })
    ) {
      errors.push(
        `#${e.id}: has no narrative — include "narrative" in set (an edit would otherwise fill it from the stored text)`,
      );
      continue;
    }
    plan.push({ ...e, before: row, files: filesOf(db, e.id) });
  }
  return errors.length ? { plan: [], errors } : { plan, errors };
}

/**
 * The verify backups in `backupDir` that name any of `ids` (file names, sorted). Every apply
 * leaves one, and --undo marks it rather than deleting it, so this is the trace an apply
 * leaves that an undo does not take back. An unreadable directory or file counts as absent.
 * @returns {string[]}
 */
export function priorVerifyApplies(backupDir, ids) {
  let names;
  try {
    names = readdirSync(backupDir);
  } catch {
    return [];
  }
  const want = new Set(ids);
  const hits = [];
  for (const name of names.filter((n) => /^verify-.*\.json$/.test(n)).sort()) {
    try {
      const b = JSON.parse(readFileSync(join(backupDir, name), 'utf8'));
      // `applied` is null only on a file an aborted apply could not remove (or one whose
      // post-commit record failed, where the rows no longer match the plan anyway).
      if (
        b?.kind === BACKUP_KIND &&
        Array.isArray(b.applied) &&
        Array.isArray(b.rows) &&
        b.rows.some((r) => want.has(r?.row?.id))
      )
        hits.push(name);
    } catch {
      /* unreadable: not a trace */
    }
  }
  return hits;
}

/**
 * A short digest of what an approval covers: the proposed changes, the state of every row
 * they were checked against, and the earlier verify applies to those rows (`prior`, from
 * priorVerifyApplies). The dry run prints it; --apply refuses without it. A proposals file
 * edited after the user approved, or a row a hook rewrote in between, changes the digest — and
 * so does an apply in between: --undo restores the rows exactly, and without `prior` the old
 * approval would come back true and re-apply what the user had just taken back.
 * @returns {string} 16 hex chars
 */
export function planDigest(plan, project, prior = []) {
  const payload = {
    project,
    prior,
    entries: plan.map(({ before, files, ...entry }) => ({
      entry,
      before: pick(before, APPROVED_STATE_COLUMNS),
      files,
    })),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

/**
 * Apply a validated plan in ONE immediate transaction. Throws — and writes nothing — if any
 * target stopped being live (or changed project) since it was planned, or (with `expectRows`)
 * if it no longer matches the backup snapshot taken just before: a hook can write between the
 * dry run the user approved and this write, and applying the other N-1 entries of an approved
 * set — or restoring over that hook's write on --undo — is not what was approved.
 * @returns {Array<{id: number, action: string, newId?: number}>}
 */
export function applyVerifyPlan(db, plan, { now = new Date(), expectRows = null } = {}) {
  const expected = expectRows ? new Map(expectRows.map((r) => [r.id, r])) : null;
  const tx = db.transaction(() => {
    const results = [];
    for (const p of plan) {
      const cur = getRow(db, p.id);
      if (!cur || !isLive(cur) || cur.project !== p.before.project) {
        throw new Error(`#${p.id}: no longer live in ${p.before.project} — aborted, nothing written`);
      }
      if (expected && JSON.stringify(cur) !== JSON.stringify(expected.get(p.id))) {
        throw new Error(`#${p.id}: changed since the backup was taken — aborted, nothing written`);
      }
      if (p.action === 'retire') {
        const res = db
          .prepare(
            `UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id = ? AND ${liveObsFilterSql('')}`,
          )
          .run(now.getTime(), VERIFY_RETIRED_MARKER, p.id);
        if (res.changes !== 1) throw new Error(`#${p.id}: retire did not land — aborted, nothing written`);
        results.push({ id: p.id, action: p.action });
        continue;
      }
      let target = p.id;
      if (p.action === 'edit') {
        applyObsUpdate(db, p.id, p.set);
      } else {
        // `force`: the user approved this correction explicitly, and the original it replaces
        // is by construction a near-duplicate of it — the 5-minute dedup window would refuse
        // exactly the save that was asked for.
        const r = saveObservation(db, {
          content: p.narrative ?? p.before.narrative,
          title: p.title ?? p.before.title,
          type: p.before.type,
          importance: p.importance ?? p.before.importance,
          project: p.before.project,
          files: p.files,
          lesson_learned: p.lesson_learned ?? p.before.lesson_learned,
          supersedes: [p.id],
          force: true,
          now,
        });
        if (r.kind !== 'saved' || !r.supersededIds.includes(p.id)) {
          throw new Error(`#${p.id}: replacement did not supersede the original — aborted, nothing written`);
        }
        target = r.id;
        // saveObservation writes the manual-save shape (no subtitle / facts / aliases / scope,
        // today's branch). Carry the original's, so a correction is not LESS findable than the
        // stale row it replaces; `facts` / `concepts` from the entry override, since a stale
        // claim can live there. The concepts write goes through applyObsUpdate so the derived
        // FTS text is rebuilt from the final columns, facts included.
        db.prepare(
          'UPDATE observations SET subtitle = ?, facts = ?, search_aliases = ?, scope = ?, branch = ? WHERE id = ?',
        ).run(
          scrubMaybe(p.before.subtitle),
          scrubMaybe(p.facts !== undefined ? p.facts : p.before.facts),
          scrubMaybe(p.before.search_aliases),
          p.before.scope,
          p.before.branch,
          target,
        );
        applyObsUpdate(db, target, { concepts: p.concepts ?? p.before.concepts ?? '' });
      }
      // Approved text must not be rewritten by a model later. The narrow re-enrich pass
      // overwrites title and narrative of rows with no lesson/concepts/facts/aliases and a NULL
      // optimized_at (hook-optimize.mjs findReenrichCandidates); optimized_at is exactly the
      // flag those pools key on. The aliases / concepts / scopes backfills are not gated on it
      // and still reach the row, but only to fill search aliases, concepts and scope: on a
      // stamped row the concepts pass writes no facts, and all three skip a row whose text or
      // stamp changed during their model call.
      db.prepare('UPDATE observations SET optimized_at = ? WHERE id = ?').run(now.getTime(), target);
      results.push({ id: p.id, action: p.action, ...(target !== p.id ? { newId: target } : {}) });
    }
    // What --undo will compare against, read INSIDE the transaction: read after the COMMIT, a
    // write another process lands in between is recorded as the apply's own, and --undo then
    // restores over it (pre-ship review of 9786874, P2-3).
    for (const r of results) {
      r.after = pick(getRow(db, r.id), TRACKED_COLUMNS);
      r.replacementAfter = r.newId ? pick(getRow(db, r.newId), TRACKED_COLUMNS) : null;
    }
    return results;
  });
  return tx.immediate();
}

/** What saveObservation will store for a replacement's title (mirrors save-observation.mjs). */
function expectedReplacementTitle(p) {
  const content = scrubSecrets(p.narrative ?? p.before.narrative);
  return scrubSecrets((p.title ?? p.before.title) || content.slice(0, 100));
}

/**
 * Read every touched row back and compare it with what the plan wrote. The comparison is
 * against the SCRUBBED expectation, because both write paths scrub on the way in, and it
 * mirrors saveObservation's own normalisation (empty lesson -> NULL, empty title -> derived).
 * @returns {Array<{id: number, action: string, ok: boolean, problems: string[], newId?: number}>}
 */
export function readBackVerifyPlan(db, plan, results) {
  const byId = new Map(results.map((r) => [r.id, r]));
  return plan.map((p) => {
    const problems = [];
    const row = getRow(db, p.id);
    const res = byId.get(p.id);
    if (!row || !res) problems.push('row or result missing');
    else if (p.action === 'retire') {
      if (row.superseded_at === null) problems.push('not superseded');
      if (row.superseded_by !== VERIFY_RETIRED_MARKER) problems.push(`superseded_by is ${row.superseded_by}`);
    } else if (p.action === 'edit') {
      if (!isLive(row)) problems.push('no longer live');
      if (row.optimized_at === null) problems.push('optimized_at not stamped');
      for (const [k, v] of Object.entries(p.set)) if (row[k] !== scrubMaybe(v)) problems.push(`${k} differs`);
    } else {
      if (Number(row.superseded_by) !== res.newId || row.superseded_at === null) {
        problems.push(`original not superseded by #${res.newId}`);
      }
      const nw = getRow(db, res.newId);
      if (!nw) problems.push(`replacement #${res.newId} missing`);
      else {
        if (!isLive(nw)) problems.push('replacement not live');
        if (nw.optimized_at === null) problems.push('replacement optimized_at not stamped');
        const lesson = p.lesson_learned ?? p.before.lesson_learned;
        const want = {
          project: p.before.project,
          type: p.before.type,
          title: expectedReplacementTitle(p),
          narrative: scrubSecrets(p.narrative ?? p.before.narrative),
          lesson_learned: lesson ? scrubSecrets(lesson) : null,
          importance: p.importance ?? p.before.importance ?? 2,
          subtitle: scrubMaybe(p.before.subtitle),
          facts: scrubMaybe(p.facts !== undefined ? p.facts : p.before.facts),
          concepts: scrubSecrets(p.concepts ?? p.before.concepts ?? ''),
          search_aliases: scrubMaybe(p.before.search_aliases),
          scope: p.before.scope,
          branch: p.before.branch,
        };
        for (const [k, v] of Object.entries(want)) if (nw[k] !== v) problems.push(`replacement ${k} differs`);
        // saveObservation re-scrubs the file list (a credential-bearing URL edge stored before
        // v6.10.1 comes back scrubbed), so compare against what it will have stored.
        const wantFiles = [...new Set(scrubFilePaths(p.files))].sort();
        if (JSON.stringify(filesOf(db, res.newId)) !== JSON.stringify(wantFiles))
          problems.push('replacement files differ');
      }
    }
    return {
      id: p.id,
      action: p.action,
      ok: problems.length === 0,
      problems,
      ...(res?.newId ? { newId: res.newId } : {}),
    };
  });
}

/**
 * The whole --apply: write a backup of every target row, apply in one transaction that also
 * checks each row still equals its backup, then record what the apply created and left (the
 * record --undo checks against), and read everything back. If the apply aborts, the backup it
 * wrote is removed, so "nothing written" holds on disk as well as in the DB.
 * @returns {{results: object[], checks: object[], backupPath: string}}
 */
export function runVerifyApply(db, plan, { backupDir, now = new Date() }) {
  const project = plan[0]?.before.project ?? null;
  const rows = plan.map((p) => ({ action: p.action, row: getRow(db, p.id), files: filesOf(db, p.id) }));
  // The digest the user approved describes plan.before. A write that landed since (a hook, a
  // background pass) must be refused here, before the backup: comparing only against a
  // snapshot taken now would let it through while the approval described the earlier state.
  for (const [i, p] of plan.entries()) {
    const drift = rows[i].row ? differing(rows[i].row, p.before, APPROVED_STATE_COLUMNS) : ['row'];
    if (drift.length) {
      throw new Error(
        `#${p.id}: changed since the dry run (${drift.join(', ')}) — nothing written; re-run the dry run`,
      );
    }
  }
  const backup = {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    created_at: now.toISOString(),
    project,
    digest: planDigest(
      plan,
      project,
      priorVerifyApplies(
        backupDir,
        plan.map((p) => p.id),
      ),
    ),
    rows,
    applied: null,
    undone_at: null,
  };
  // A random suffix: two runs in the same millisecond must not share (and so overwrite) a file.
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDir, `verify-${stamp}-${randomBytes(3).toString('hex')}.json`);
  // The backup holds full memory rows: owner-only, like the database file (schema.mjs chmods
  // that to 0600). atomicWriteFileSync carries an existing file's mode on later rewrites.
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(backupPath, JSON.stringify(backup, null, 1), { mode: 0o600 });

  let results;
  try {
    results = applyVerifyPlan(db, plan, { now, expectRows: rows.map((r) => r.row) });
  } catch (e) {
    try {
      unlinkSync(backupPath);
    } catch (u) {
      if (u.code !== 'ENOENT') {
        throw new Error(
          `${e.message} — nothing written to the database, but the backup file ${backupPath} could not be removed (${u.message}); it records no apply and can be deleted`,
          { cause: u },
        );
      }
    }
    throw e;
  }

  backup.applied = plan.map((p) => {
    const res = results.find((r) => r.id === p.id);
    return {
      id: p.id,
      action: p.action,
      verdict: p.verdict,
      evidence: p.evidence,
      newId: res.newId ?? null,
      after: res.after,
      replacementAfter: res.replacementAfter,
    };
  });
  try {
    atomicWriteFileSync(backupPath, JSON.stringify(backup, null, 1));
  } catch (e) {
    throw new Error(
      `applied, but the undo record could not be written (${e.message}); the pre-apply rows are in ${backupPath}`,
      { cause: e },
    );
  }
  return { results, checks: readBackVerifyPlan(db, plan, results), backupPath };
}

/** The same backup, marked as undone — written back by the CLI so the undo cannot run twice. */
export function markUndone(backup, now = new Date()) {
  return { ...backup, undone_at: now.toISOString() };
}

/**
 * Undo an apply from its backup. Refuses — writing nothing — unless every row is still exactly
 * as the apply left it: same identity, same project, tracked columns equal to the recorded
 * post-apply state, and every replacement still live and untouched. Then, in one immediate
 * transaction: an `edit` gets its content columns back, a `replace` / `retire` gets its
 * supersession back, and each recorded replacement (and only that row) is retired.
 * @returns {{errors: string[], restored: Array<{id: number, replacementRetired: number|null}>}}
 */
export function undoVerifyBackup(db, backup, { now = new Date() } = {}) {
  if (!backup || backup.kind !== BACKUP_KIND || !Array.isArray(backup.rows)) {
    return { errors: ['not a verify-apply backup file'], restored: [] };
  }
  if (backup.version !== BACKUP_VERSION || !Array.isArray(backup.applied)) {
    return { errors: ['backup has no record of what was applied — cannot undo safely'], restored: [] };
  }
  if (backup.undone_at) return { errors: [`backup already undone at ${backup.undone_at}`], restored: [] };

  const applied = new Map(backup.applied.map((a) => [a?.id, a]));
  // Read-only checks. They run INSIDE the immediate transaction below: run before it, a write
  // committed by another process between the check and the restore would be overwritten.
  const check = () => {
    const errors = [];
    for (const [i, b] of backup.rows.entries()) {
      const id = b?.row?.id;
      const rec = applied.get(id);
      if (!Number.isInteger(id) || !rec || rec.action !== b.action) {
        errors.push(`backup row ${i + 1}: malformed`);
        continue;
      }
      if (b.row.project !== backup.project) {
        errors.push(`#${id}: backup row belongs to project ${b.row.project}, not ${backup.project}`);
        continue;
      }
      const cur = getRow(db, id);
      if (!cur) {
        errors.push(`#${id}: no longer exists`);
        continue;
      }
      if (differing(cur, b.row, IDENTITY_COLUMNS).length) {
        errors.push(
          `#${id}: not the row this backup was taken from (${differing(cur, b.row, IDENTITY_COLUMNS).join(', ')})`,
        );
        continue;
      }
      const drift = differing(cur, rec.after, TRACKED_COLUMNS);
      if (drift.length) errors.push(`#${id}: changed since the apply (${drift.join(', ')}) — undo refused`);
      if (rec.action === 'replace') {
        const repl = Number.isInteger(rec.newId) ? getRow(db, rec.newId) : null;
        if (!repl || repl.project !== backup.project)
          errors.push(`#${id}: replacement #${rec.newId} is missing`);
        else {
          const rDrift = differing(repl, rec.replacementAfter || {}, TRACKED_COLUMNS);
          if (rDrift.length)
            errors.push(
              `#${rec.newId}: replacement changed since the apply (${rDrift.join(', ')}) — undo refused`,
            );
        }
      }
    }
    return errors;
  };

  const writes = [];
  const tx = db.transaction(() => {
    const refused = check();
    if (refused.length) return { refused, restored: [] };
    const restored = [];
    for (const b of backup.rows) {
      const id = b.row.id;
      const rec = applied.get(id);
      let replacementRetired = null;
      if (rec.action === 'replace') {
        const res = db
          .prepare(
            `UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id = ? AND ${liveObsFilterSql('')}`,
          )
          .run(now.getTime(), VERIFY_UNDONE_MARKER, rec.newId);
        if (res.changes !== 1)
          throw new Error(`#${rec.newId}: replacement could not be retired — nothing undone`);
        replacementRetired = rec.newId;
      }
      const cols = rec.action === 'edit' ? CONTENT_COLUMNS : SUPERSESSION_COLUMNS;
      const values = cols.map((c) => (SCRUBBED_ON_RESTORE.has(c) ? scrubMaybe(b.row[c]) : b.row[c]));
      db.prepare(`UPDATE observations SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
        ...values,
        id,
      );
      writes.push({ id, cols, values });
      restored.push({ id, replacementRetired });
    }
    return { refused: [], restored };
  });
  const { refused, restored } = tx.immediate();
  if (refused.length) return { errors: refused, restored: [] };
  const errors = [];
  for (const w of writes) {
    const cur = getRow(db, w.id);
    const bad = w.cols.filter((c, i) => cur[c] !== w.values[i]);
    if (bad.length) errors.push(`#${w.id}: restore mismatch on ${bad.join(', ')}`);
  }
  return { errors, restored };
}
