// Single source of truth for the (obs,file) trigger-edge match predicate.
//
// Two consumers MUST stay in byte-identical agreement or injection and
// attribution diverge (a lesson injected via an edge the resolver can't find
// never resolves, and vice versa): scripts/pre-tool-recall.js (injection
// trigger) and lib/edge-attribution.mjs (Stop-side hit/miss resolution).
// Review 2026-07-14 found the pair enforced only by comments — this module
// makes the parity mechanical.
//
// Semantics (P0 D#78, plus the review's case/backslash recall fix):
// observation_files.filename is heterogeneous (bare basename, relative path,
// absolute path, either separator, historical case variants). An edited file
// matches an edge when the stored value is:
//   1. the exact full path            (= COLLATE NOCASE — old LIKE was
//   2. the exact bare basename         ASCII-case-insensitive; '=' alone is
//                                      BINARY and silently dropped 'Utils.mjs')
//   3. a path ending in '/<basename>' (LIKE, path boundary — blocks the
//   4. a path ending in '\<basename>'  bash-utils.mjs-vs-utils.mjs suffix
//                                      collision while keeping both separators)
// LIKE wildcards in the basename are escaped (sqlite gotcha #9); LIKE itself
// is ASCII-case-insensitive, matching arm 1/2's NOCASE.
//
// The basename split accepts EITHER separator regardless of host OS. node:path
// `basename` is host-native: on a POSIX host it does not treat '\' as a
// separator, so `basename('C:\\proj\\src\\x.mjs')` returns the WHOLE path and
// arms 2-4 degrade to garbage — a Windows-shaped payload then recalls nothing.
// That mattered because the header above declares filename heterogeneous with
// EITHER separator, and hook payloads carry the CLIENT machine's path shape.
// The correct split existed only in `recallForFile` (hook-memory.mjs), a twin
// with no production caller, and the Windows tests asserted against the twin —
// so the shipped half carried the gap unobserved until 2026-08-22.
//
// Accepting both separators WIDENS matching for one exotic case, on the record as a
// decision rather than a side effect: '\' is a legal POSIX filename character, so a
// file literally named `b\c.mjs` now derives to `c.mjs` and can match observations
// recorded against `c.mjs`. Arm 4 (`%\<basename>`) still catches the old spelling, so
// a pre-tag review measured zero lost matches across 9 probes × 15 stored filename
// shapes — the change is purely additive. Real exposure is nil: 0 of 6406
// observation_files rows on the maintainer's DB contain a backslash. A recall system
// over-recalling a hypothetical file is the right side to err on.
//
// Dependency-free on purpose: pre-tool-recall.js is a ~30ms cold-start script and
// imports nothing from utils.mjs (which pulls in child_process and five modules),
// so the split is inlined below rather than imported. utils.mjs used to export the
// same two lines as `basenameAnySep`; that copy was deleted in the same round once
// its only consumer went, so this file is now the sole home.

/**
 * SQL boolean expression for the four-arm match. Placeholder order matches
 * fileMatchParams. @param {string} [alias=''] table alias (e.g. 'of2').
 */
export function fileMatchClause(alias = '') {
  const p = alias ? `${alias}.` : '';
  return (
    `(${p}filename = ? COLLATE NOCASE OR ${p}filename = ? COLLATE NOCASE ` +
    `OR ${p}filename LIKE ? ESCAPE '\\' OR ${p}filename LIKE ? ESCAPE '\\')`
  );
}

/**
 * Last path segment, splitting on '/' OR '\' whatever the host OS is.
 * THE only copy in the repo — keep it that way, and import it rather than
 * re-deriving. A second copy is what produced the gap this replaced: the
 * derivation existed twice and the tests asserted the one that did not ship.
 * Exported for the one caller that needs the key without the SQL
 * (scripts/pre-tool-recall.js's events leg, which matches a JSON array in a
 * TEXT column rather than the observation_files junction).
 * Not for filesystem access — '\' is a legal POSIX filename character.
 */
export function basenameAnySep(p) {
  const s = String(p ?? '').replace(/[/\\]+$/, '');
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
}

/** Bind values for fileMatchClause, in placeholder order. */
export function fileMatchParams(filePath) {
  const fname = basenameAnySep(filePath);
  const escaped = fname.replace(/%/g, '\\%').replace(/_/g, '\\_');
  // `%\\` before the basename: under ESCAPE '\', a literal backslash is
  // written '\\' — so the JS string carries two backslash characters.
  return [filePath, fname, `%/${escaped}`, `%\\\\${escaped}`];
}
