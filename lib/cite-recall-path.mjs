// lib/cite-recall-path.mjs — the ONE definition of the cite-recall snapshot file's path.
//
// Same shape, same failure mode and same fix as lib/cooldown-path.mjs (audit 2026-08-29
// ARCH-2). `handleStop` writes `runtime/cite-recall-<project>.json` and
// `buildCiteRecallNudge` reads it back, and each derived the name itself:
//
//   hook.mjs:1163            join(RUNTIME_DIR, `cite-recall-${project.replace(…).slice(0,64)}.json`)
//   lib/cite-back-hint.mjs   const safe = project.replace(…).slice(0,64); join(runtimeDir, `cite-recall-${safe}.json`)
//
// A writer and a reader disagreeing about a filename does not throw — the reader opens a
// file nobody wrote, `readFileSync` misses, the catch swallows it, and the SessionStart
// nudge is silently gone. That is the whole reason this class keeps getting collapsed:
// nothing in the system reports it, so the only defence is that the rule has one home.
// This is the third instance found (cooldown, injected-ids, cite-recall); the sanitize
// literal is deliberately NOT shared across the three, because they key on different
// things (session id vs project) and a single "sanitize" helper would invite exactly the
// cross-family coupling that makes one of them impossible to change later.
//
// `hook-shared.mjs`'s marker-GC list is the third consumer: it matches this family by
// prefix, so the prefix is exported rather than re-typed there.

import { join } from 'path';

/** Filename prefix. Exported so the marker GC can match the family without re-deriving it. */
export const CITE_RECALL_FILE_PREFIX = 'cite-recall-';

/**
 * Project name → filesystem-safe key. The 64-char cap and the character class are part of
 * the contract, not defensive hygiene: writer and reader must derive the same name from the
 * same project, so a change here is a change to both at once.
 *
 * Note the cap differs from `project-utils.mjs:sanitizeProject` (100) — these are different
 * keys for different files, and silently unifying them would rename every existing snapshot
 * on upgrade, i.e. drop one nudge per project. Kept separate on purpose.
 *
 * @param {unknown} project
 * @returns {string}
 */
export function citeRecallProjectKey(project) {
  return String(project)
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 64);
}

/**
 * Absolute path to a project's cite-recall snapshot.
 *
 * @param {string} runtimeDir Absolute RUNTIME_DIR.
 * @param {unknown} project   Project name as `inferProject` returns it.
 * @returns {string}
 */
export function citeRecallPathFor(runtimeDir, project) {
  return join(runtimeDir, `${CITE_RECALL_FILE_PREFIX}${citeRecallProjectKey(project)}.json`);
}
