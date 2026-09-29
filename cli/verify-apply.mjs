// cli/verify-apply.mjs — `claude-mem-lite verify-apply <proposals.json> [--project P]`
// (dry run), `... --apply --digest <d>`, and `claude-mem-lite verify-apply --undo <backup.json>`.
//
// The write step of /verify (commands/verify.md). The agent proposes; this command is the only
// thing that writes. It defaults to a dry run that prints the new text itself and a digest, and
// --apply refuses unless it is handed that digest back: what the user approved is what lands,
// and a proposals file or a row that changed in between is refused rather than applied. All
// policy lives in lib/verify-apply-core.mjs; this file is I/O, formatting and exit codes.

import { readFileSync } from 'fs';
import { join } from 'path';
import { DB_DIR } from '../lib/data-paths.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';
import { inferProject } from '../utils.mjs';
import { resolveProject } from '../project-utils.mjs';
import {
  parseProposals,
  planVerifyApply,
  planDigest,
  priorVerifyApplies,
  runVerifyApply,
  undoVerifyBackup,
  markUndone,
} from '../lib/verify-apply-core.mjs';
import { parseArgs, out, fail, rejectBareStringFlags } from './common.mjs';
import { shellWord } from '../cli-path.mjs';

const USAGE =
  '[mem] Usage: claude-mem-lite verify-apply <proposals.json> [--project P]          (dry run)\n' +
  '       claude-mem-lite verify-apply <proposals.json> [--project P] --apply --digest <d>\n' +
  '       claude-mem-lite verify-apply --undo <backup.json>';

const SNIPPET_CONTEXT = 60;
const BACKUP_DIR = join(DB_DIR, 'backups');
// The commands this prints must run as printed. `claude-mem-lite` is on PATH only after an
// optional global npm install (which may also be a different, stale code home), so name the
// node binary and THIS cli.mjs — the one that produced the plan.
const SELF = process.argv[1] ? `node ${shellWord(process.argv[1])}` : 'claude-mem-lite';

function readJson(path, what) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    return { error: `[mem] Cannot read ${what} ${path}: ${e.message}` };
  }
}

/**
 * The changed region of a field, with context. The changed part is printed IN FULL, never
 * clipped: the digest covers the whole text, so any cap here would let the user approve text
 * they were never shown (re-review of dcc8f72, P2-2). Only unchanged context is elided.
 */
function snippet(before, after) {
  const a = before === null || before === undefined ? '' : String(before);
  const b = String(after);
  if (a === b) return ['    (unchanged)'];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - SNIPPET_CONTEXT);
  const lead = from > 0 ? '…' : '';
  const tail = (s, end) => (end + SNIPPET_CONTEXT < s.length ? '…' : '');
  return [
    `    - ${lead}${a.slice(from, Math.min(a.length, endA + SNIPPET_CONTEXT))}${tail(a, endA)}`,
    `    + ${lead}${b.slice(from, Math.min(b.length, endB + SNIPPET_CONTEXT))}${tail(b, endB)}`,
  ];
}

function describe(p) {
  const head = `  #${p.id} [${p.verdict}] ${p.action} — evidence: ${p.evidence}`;
  if (p.action === 'retire') return [head, '    retired with no replacement (kept as history)'];
  const fields =
    p.action === 'edit'
      ? Object.entries(p.set)
      : ['title', 'narrative', 'lesson_learned', 'importance', 'facts', 'concepts']
          .filter((k) => p[k] !== undefined)
          .map((k) => [k, p[k]]);
  const lines = [head];
  if (p.action === 'replace') lines.push('    new memory supersedes this one; unlisted fields are copied');
  for (const [k, v] of fields) lines.push(`   ${k}:`, ...snippet(p.before[k], v));
  return lines;
}

function undo(db, path) {
  const { value, error } = readJson(path, 'backup');
  if (error) return fail(error);
  const { errors, restored } = undoVerifyBackup(db, value);
  if (restored.length === 0 && errors.length)
    return fail(`[mem] Undo refused, nothing written:\n  ${errors.join('\n  ')}`);
  for (const r of restored) {
    out(
      `  #${r.id} restored${r.replacementRetired ? ` (replacement #${r.replacementRetired} retired)` : ''}`,
    );
  }
  if (errors.length) return fail(`[mem] Undo read-back found problems:\n  ${errors.join('\n  ')}`);
  out(`[mem] Undo complete: ${restored.length} row(s) restored.`);
  // The restore is committed; marking the file only stops a second run early. If the mark
  // cannot be written, a second undo is still refused (the rows no longer match the apply's
  // record), so this is a warning, not a failure of the undo that already happened.
  try {
    atomicWriteFileSync(path, JSON.stringify(markUndone(value), null, 1));
  } catch (e) {
    process.stderr.write(
      `[mem] Warning: undo is done, but ${path} could not be marked as undone: ${e.message}\n`,
    );
  }
}

export function cmdVerifyApply(db, args) {
  const { positional, flags } = parseArgs(args);
  if (rejectBareStringFlags(flags, ['project', 'undo', 'digest'])) return;
  // The project verify-apply targets when --project is omitted, printed so /verify can export
  // exactly that project (export's --project matching is fuzzy; this is not).
  if (flags['print-project'] === true) return out(inferProject());
  // Boolean means boolean: `--apply=false` / `--apply no` must not apply.
  if (flags.apply !== undefined && flags.apply !== true)
    return fail(`[mem] --apply takes no value.\n${USAGE}`);

  if (flags.undo !== undefined) {
    if (positional.length || flags.apply || flags.digest) return fail(USAGE);
    return undo(db, flags.undo);
  }

  const file = positional[0];
  if (!file || positional.length > 1) return fail(USAGE);
  const { value, error } = readJson(file, 'proposals');
  if (error) return fail(error);

  const parsed = parseProposals(value);
  if (parsed.errors.length)
    return fail(`[mem] Invalid proposals, nothing written:\n  ${parsed.errors.join('\n  ')}`);

  const project = flags.project ? resolveProject(db, flags.project, { mode: 'write' }) : inferProject();
  const { plan, errors } = planVerifyApply(db, parsed.entries, { project });
  if (errors.length) return fail(`[mem] Refused, nothing written:\n  ${errors.join('\n  ')}`);
  const digest = planDigest(
    plan,
    project,
    priorVerifyApplies(
      BACKUP_DIR,
      plan.map((p) => p.id),
    ),
  );

  if (!flags.apply) {
    out(`[mem] verify-apply plan — project ${project}, ${plan.length} change(s):`);
    for (const p of plan) for (const line of describe(p)) out(line);
    out(`[mem] Plan digest: ${digest}`);
    out('[mem] Dry run — nothing written. After the user approves exactly this plan, run:');
    out(
      `  ${SELF} verify-apply ${shellWord(file)} --project ${shellWord(project)} --apply --digest ${digest}`,
    );
    return;
  }

  if (!flags.digest) {
    return fail('[mem] --apply requires --digest <d> from the dry run the user approved. Nothing written.');
  }
  if (flags.digest !== digest) {
    return fail(
      '[mem] Plan digest mismatch: the proposals file or the memories changed since the dry run. ' +
        'Nothing written — re-run the dry run and get the new plan approved.',
    );
  }

  let run;
  try {
    run = runVerifyApply(db, plan, { backupDir: BACKUP_DIR });
  } catch (e) {
    // One failure happens AFTER the commit: the undo record could not be written. The changes
    // are in the database then, and saying "nothing written" would be false.
    if (e.message.startsWith('applied, but')) {
      return fail(
        `[mem] APPLIED — the changes are in the database, but ${e.message.slice('applied, but '.length)}`,
      );
    }
    return fail(`[mem] ${e.message}`);
  }
  for (const c of run.checks) {
    out(
      `  #${c.id} ${c.action}${c.newId ? ` → #${c.newId}` : ''}: ${c.ok ? 'ok' : `MISMATCH (${c.problems.join('; ')})`}`,
    );
  }
  out(`[mem] Backup: ${run.backupPath}`);
  out(
    `[mem] To undo (only while these rows are untouched): ${SELF} verify-apply --undo ${shellWord(run.backupPath)}`,
  );
  if (run.checks.some((c) => !c.ok)) {
    fail('[mem] Applied, but read-back found mismatches — show the MISMATCH lines above to the user.');
  }
}
