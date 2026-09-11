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
//
// The one import below does not cost that: project-utils.mjs is a leaf over
// `node:path`, and pre-tool-recall.js already imports it for inferProject.
import { likeLiteral } from '../project-utils.mjs';

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

/**
 * This module had its own `likeLiteral` for one commit, and the comment justifying
 * the duplication was wrong twice running — first "THE only copy in the repo" (it
 * was not; project-utils.mjs has had one since R10 P2-3), then "project-utils.mjs
 * pulls a DB handle's worth of graph behind it" (it does not: it imports
 * `node:path` and nothing else, its own header calls it a leaf, and
 * scripts/pre-tool-recall.js — the cold-start script the excuse was built around —
 * already imports it). Both were caught in review rather than by measuring first.
 *
 * So it is imported, per this file's own rule about basenameAnySep one docblock up:
 * a second copy is exactly what produced R12 B-1.
 */

/**
 * LIKE needle for one element of a JSON-array TEXT column (`events.file_paths`),
 * to be wrapped as `%"<needle>"%` and run under `ESCAPE '\'`.
 *
 * TWO escapes compose here and the order is not interchangeable. The column holds
 * `JSON.stringify(paths)`, so a win32 separator is already TWO characters on disk
 * (`C:\\proj`); the LIKE escape then has to double each of those again to mean two
 * literal backslashes. Skipping the JSON step is the trap: it looks fixed, because
 * on POSIX `JSON.stringify` of a path is the identity, so every non-Windows test
 * stays green either way. Measured on `:memory:` against a real stored row —
 * shipped = 0 rows, LIKE-escape alone = 0 rows, JSON-then-LIKE = 1 row.
 */
export function jsonArrayLikeNeedle(s) {
  return likeLiteral(JSON.stringify(String(s ?? '')).slice(1, -1));
}

/**
 * How much a token LOOKS like a file path, from its shape alone. Higher wins.
 *
 * Only ever used to ORDER candidates, never to drop one — see rankFileCandidates.
 * Every term below is a character-class property of the token, not a list of
 * known-bad spellings: a blacklist is what the next unusual version string walks
 * around, and this repo has thrown three hand-drawn classes away already.
 */
function fileShapeScore(token) {
  const raw = String(token ?? '');
  const name = basenameAnySep(raw);
  const dot = name.lastIndexOf('.');
  // `dot === 0` is a DOTFILE (`.env`, `.gitignore`, `.npmrc`), not an
  // extensionless token — score `env` as the extension. The first cut rejected
  // it with `dot <= 0`, which scored every dotfile 0, i.e. BELOW the version
  // numbers this function exists to demote. Not theoretical: `extractFiles`
  // emits `src/.env`, and six version tokens then evicted it from a window the
  // pre-ranking code reached (pre-ship review, 2026-09-11).
  if (dot < 0 || dot === name.length - 1) return 0;
  const ext = name.slice(dot + 1);
  let score = 0;
  // A real extension starts with a LETTER. Version numbers ('v4.0.1' -> '1'),
  // decimals and timestamp fragments ('…39.602Z' -> '602Z') do not — and those
  // three are what `extractFiles`' regex actually emits on this corpus.
  if (/^[A-Za-z]/.test(ext)) score += 2;
  // Real extensions are short. A member expression borrows the letter-initial
  // shape but not the length ('JSON.stringify', 'e.target_id').
  if (ext.length <= 5) score += 1;
  // A separator is the strongest evidence available without touching disk.
  // Ask the token, and strip TRAILING separators first: comparing against the
  // basename says yes for `foo.mjs/` too, because basenameAnySep strips those,
  // so a token with no internal separator collected the bonus.
  if (/[/\\]/.test(raw.replace(/[/\\]+$/, ''))) score += 2;
  return score;
}

/**
 * Order file candidates most-path-like first and drop exact repeats, for the
 * callers that can only afford to probe the first few.
 *
 * `searchByFile` runs one prepared-statement execution per candidate on the
 * UserPromptSubmit hot path, so it caps at FILE_PROBE_CAP — and it used to take
 * the ones `extractFiles` happened to match FIRST, which is text order.
 *
 * Measured in one run over 216 live user_prompts (2026-09-11), denominator = the
 * 50 prompts naming at least one file the corpus can reach, each lever isolated
 * at the cap that ships:
 *
 *                                 all reachable lost   >=1 lost
 *   text order, cap 3 (pre-fix)     14 (28.0%)          34 (68.0%)
 *   text order, cap 6                7 (14.0%)          30 (60.0%)
 *   ranked,     cap 6 (shipped)      2 ( 4.0%)          25 (50.0%)
 *
 * Neither lever alone gets there, and at cap 6 the ORDERING is the larger of
 * the two. An earlier revision quoted "ranking alone 28.0% -> 24.0%", which was
 * measured at cap 3 with a scorer that ranked dotfiles last: the wrong ablation
 * on a window too small for ordering to matter.
 *
 * Oracle: a candidate counts as reachable when its basename matches one in
 * `observation_files`. That is a strict SUPERSET of what the shipped query can
 * return — it ignores the project, lookback, importance and low-signal
 * predicates — measured at 26 of 152 candidates over-counted, with no false
 * negatives (pre-ship review). Applied identically to every arm, so the
 * direction holds; the exact percentages are not properties of the shipped
 * query, and "flat beyond 6" is true of this oracle only (under the strict one
 * the reviewer measured, the curve drops again at 10).
 *
 * The noise was never buying precision either: only 1 prompt reached
 * `hasExplicitSignal` via extractFiles alone — that figure is from the audit's
 * separate 533-prompt transcript corpus, NOT from the 216 rows above.
 *
 * SORT, not filter, and that is the safety property — with one caveat the
 * caller owns: downstream of a `.slice(cap)` a position IS a candidate, so a
 * wrong score can still evict. That is why fileShapeScore leans on structural
 * properties and never on a list of known-bad spellings.
 *
 * Dedup folds ASCII A-Z ONLY, because that is the alphabet the SQL folds:
 * SQLite's `COLLATE NOCASE` and `LIKE` are ASCII-case-insensitive (this file's
 * own header, arm 1/2). JS `toLowerCase()` folds the whole Unicode table, so it
 * collapsed `Ä.mjs` and `ä.mjs` into one probe while SQLite returns distinct
 * rows for each — a DROP, which this function contractually never does.
 * Unreachable through today's only caller (`extractFiles`' class is `[\w./-]`
 * and `\w` is ASCII without the `u` flag), fixed because the exported contract
 * is what the next caller reads.
 *
 * The index tiebreak keeps text order inside a tier explicitly rather than
 * leaning on sort stability.
 */
export function rankFileCandidates(files) {
  // A non-array would be iterated by character (`'a.mjs'` -> five candidates)
  // or throw. One caller exists and it passes an array; fail closed for the next.
  if (!Array.isArray(files)) return [];
  const seen = new Set();
  const uniq = [];
  for (const f of files) {
    const s = String(f ?? '');
    if (!s) continue;
    const key = s.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(s);
  }
  return uniq
    .map((f, i) => ({ f, i, score: fileShapeScore(f) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.f);
}

/**
 * The path a tool-use touched, whichever key the tool spells it with.
 *
 * `Edit` / `Write` / `Read` carry `file_path`; `NotebookEdit` carries
 * `notebook_path` and NEVER `file_path`. That one rule had three separate
 * spellings in this repo (an inline `??` in each recall script, a regex
 * alternation in lib/hook-stdin.mjs) and a FOURTH site that simply did not know
 * it — lib/import-jsonl.mjs gated its file edges on `file_path` alone, so every
 * imported notebook edit built no (obs,file) edge at all and was unreachable
 * through the recall path this module exists to serve. A second copy is exactly
 * what produced R12 B-1; this is the home.
 *
 * @param {object|null|undefined} input a tool-use `input` / `tool_input` object
 * @returns {string|undefined} the path, or undefined when the shape carries none
 */
export function toolEditPath(input) {
  if (!input || typeof input !== 'object') return undefined;
  return input.file_path ?? input.notebook_path;
}

/** Bind values for fileMatchClause, in placeholder order. */
export function fileMatchParams(filePath) {
  const fname = basenameAnySep(filePath);
  const escaped = likeLiteral(fname);
  // `%\\` before the basename: under ESCAPE '\', a literal backslash is
  // written '\\' — so the JS string carries two backslash characters.
  return [filePath, fname, `%/${escaped}`, `%\\\\${escaped}`];
}
