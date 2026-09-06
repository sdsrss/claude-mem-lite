#!/usr/bin/env node
// claude-mem-lite: Auto-search memory on user prompt
// Runs as UserPromptSubmit hook — injects relevant memories before Claude sees the prompt
// Lightweight: only imports schema.mjs and utils.mjs, no MCP SDK

import { ensureDb, DB_DIR } from '../schema.mjs';
import {
  relaxFtsQueryToOr,
  truncate,
  typeIcon,
  inferProject,
  OBS_BM25,
  notLowSignalTitleClause,
  stripPrivate,
  neutralizeContextDelimiters,
  MAX_UPS_PROMPT_BYTES,
} from '../utils.mjs';
import { readHookStdin } from '../lib/hook-stdin.mjs';
import { resolveRuntimeDir } from '../lib/resolve-data-dir.mjs';
import { liveObsFilterSql, injectionRelevanceSql } from '../lib/inject-search-core.mjs';
import { fileMatchClause, fileMatchParams, basenameAnySep } from '../lib/file-edge-match.mjs';
import { cjkPrecisionOk } from '../nlp.mjs';
import { upsFtsQuery } from '../lib/ups-query.mjs';
import { corpusFloorScale } from '../lib/relevance-floor.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import {
  shouldSkip,
  computeEffectiveLen,
  detectIntent,
  shouldSkipByDedup,
  extractFiles,
  extractErrorSignature,
  extractDeferredRefs,
  DEDUP_STALE_MS,
  detectMemOverride,
} from './prompt-search-utils.mjs';
import { injectedIdsFileName, mergeInjectedMarker } from '../lib/injected-ids.mjs';
import { getDeferredByIds } from '../lib/deferred-work.mjs';
import { recordHookError } from '../lib/hook-telemetry.mjs';

import { DAY_MS } from '../lib/time-constants.mjs';
import { envNumber } from '../lib/env-number.mjs';
// ─── Constants ──────────────────────────────────────────────────────────────

// Telemetry sink (lib/hook-telemetry.mjs contract): env override for tests, else
// <data-dir>/runtime — the same dir the sibling hook scripts + `stats` read.
// EVERY runtime path in this file goes through this constant, including the two
// below. They used to be `join(DB_DIR, 'runtime', …)`, which reproduced the exact
// defect P1-14 closed one seam over: this file's RUNTIME_DIR honoured the override
// while its MARKER did not, so under `CLAUDE_MEM_RUNTIME_DIR` the `fyi` face wrote
// the shared cross-hook marker to <data>/runtime while `pre-tool-recall` (`pretool`)
// wrote it to the override and `hook.mjs` (`ups`) read the override. Caught by the
// v3.93.0 pre-tag test-effectiveness review, from a surviving mutation.
const RUNTIME_DIR = resolveRuntimeDir(DB_DIR);
// D#120: one marker file per CC session — payload-only session keying (M-6) let
// two concurrent windows full-replace each other's marker, killing dedup between
// them and resetting `count` on every alternation. Derived per invocation once
// the session id is parsed from stdin; no session id → legacy project-keyed file.
const injectedIdsFileFor = (sessionId) => join(RUNTIME_DIR, injectedIdsFileName(inferProject(), sessionId));
// Per-prompt UPS cap. Cut from 5 → 3 after the 2026-05-09 per-hook recall
// scan (#8255): UPS contributed 74% of silent injected IDs (131/177) at 26%
// recall, vs PreToolUse:Read at 94% recall on a tighter file-keyed set.
// Hypothesis: fewer candidates → each one more relevant → cite-rate up.
// useRecent intent path is unaffected (it uses intent.limit=5 directly,
// gated by explicit "before/previously/记得" prompts where breadth is the
// point). Env override for projects that want broader recall or to A/B.
// Integer, min 0. This value reaches `rows.slice(0, MAX_RESULTS)`, and 0 there means
// "inject nothing" — a legitimate way to turn this face off, so it is accepted rather
// than warned back up to 3 (falling back would INJECT for a user who asked for silence).
// What is screened is NaN, which produced the same silence from a typo, unasked.
const MAX_RESULTS = envNumber(process.env.CLAUDE_MEM_UPS_MAX_RESULTS, {
  name: 'CLAUDE_MEM_UPS_MAX_RESULTS',
  defaultValue: 3,
  min: 0,
  integer: true,
});
const LOOKBACK_MS = 60 * DAY_MS; // 60 days

// v2.56.x: Past-similar-questions fallback row cap. Cut from 3 → 1 after
// 30d transcript scan (#8062 follow-up, 2026-05-09) showed UPS prompt-fallback
// path contributing ~24% of session injection budget with near-zero cite-recall.
// Unlike the obs FTS path (TOP_REL_FLOOR + BM25 gates), prompt-fallback has no
// quality gate — only BM25 ordering — so additional rows inflate noise without
// improving signal. Env-overridable for projects that want broader prompt recall.
// Integer, min 0: bound directly into a SQL `LIMIT ?`, where better-sqlite3 rejects a
// non-integer outright (`SqliteError: datatype mismatch`). `LIMIT 0` is valid and means
// "disable the prompt-fallback path", so 0 stays a usable setting.
const PROMPT_FALLBACK_LIMIT = envNumber(process.env.CLAUDE_MEM_UPS_PROMPT_FALLBACK_LIMIT, {
  name: 'CLAUDE_MEM_UPS_PROMPT_FALLBACK_LIMIT',
  defaultValue: 1,
  min: 0,
  integer: true,
});
// Over-fetch factor for that cap. searchByUserPrompts filters rows in JS (cjkPrecisionOk)
// AFTER the SQL LIMIT, so the LIMIT bounds reachability, not just output width — see the
// comment at the query. These size the pool only; the function still returns at most
// PROMPT_FALLBACK_LIMIT rows, so widening them cannot inflate the injection budget.
const PROMPT_FALLBACK_POOL_FACTOR = 5;
const PROMPT_FALLBACK_POOL_MAX = 25;

// T3 (v2.31): per-row BM25 magnitude floor. OBS_BM25 (in scoring-sql.mjs)
// returns the raw bm25() value — negative, smaller = better. Multiplied by
// decay × type-quality × (0.5+0.5·importance), sign stays negative. We
// compare against Math.abs(relevance).
//
// v2.34.3 note: the historic comment claimed |rel| falls in 3e-6..5e-5 range.
// Re-measured against real data (see v2.34.3 CHANGELOG probe), actual scores
// span ~6..133 across SIGNAL / META / NOISE prompts — the scoring expression
// was revised in later versions and this constant was never retuned. 1e-5 now
// acts as a NULL-rel guard, not a real noise filter. The primary noise gate
// is TOP_REL_FLOOR below, which drops the whole FTS set when the best match
// is weak.
// min 0, non-integer: a magnitude floor compared with `Math.abs(relevance) >= …`.
// NaN here makes that comparison always false, i.e. it drops every row.
const BM25_MIN_SCORE = envNumber(process.env.CLAUDE_MEM_UPS_BM25_MIN, {
  name: 'CLAUDE_MEM_UPS_BM25_MIN',
  defaultValue: 1e-5,
  min: 0,
});
// CJK-weighted minimum length for the prompt. Catches medium-short Latin
// prompts ("run tests", "fix bug now") that survive `shouldSkip`'s weaker 8-unit
// floor but carry too few tokens to justify an FTS lookup.
// v2.34.4: applied to `computeEffectiveLen(prompt)`, not raw char count — a
// 14-char CJK prompt ("优化 hook 性能降低延迟") scores 30 effective units and
// now reaches FTS, matching shouldSkip's CJK-weighted gate rather than silently
// failing the raw-char one.
const PROMPT_MIN_LENGTH = 15;

// v2.33.1: follow-up prompts ("前面那个", "继续 X", "再看看 Y") are short by
// nature but semantically depend on prior turns. Once a session has injected
// memory at least once, relax gates so short follow-ups still get recall.
// Detection: injected-ids marker count > 0 within DEDUP_STALE_MS window.
const FOLLOWUP_PROMPT_MIN_LENGTH = 8;
const FOLLOWUP_BM25_MIN_SCORE = envNumber(process.env.CLAUDE_MEM_UPS_BM25_MIN_FOLLOWUP, {
  name: 'CLAUDE_MEM_UPS_BM25_MIN_FOLLOWUP',
  defaultValue: 5e-6,
  min: 0,
});

// v2.34.3: top-|rel| sanity gate. BM25_MIN_SCORE filters per-row; this floor
// gates the entire FTS set. Noise prompts ("today's date", "current time")
// produce OR-fallback leakage where every hit shares one tangential stem and
// per-row filtering leaves all of them through. When the best match scores
// below this floor, the whole FTS result set is dropped.
//
// Empirical distribution (v2.34.3 probe, 12 prompts):
//   SIGNAL top-|rel|   60..133
//   NOISE  top-|rel|   25..48
//   WEAK-META          6.86..33
// Default 50 sits in the clean 48→60 gap. Env override for project tuning.
// Error-signature hits (sigRows) and file-recall (fileRows) bypass this gate —
// both are precision passes with independent relevance signal.
//
// Note: no follow-up halving (unlike PROMPT_MIN_LENGTH / BM25_MIN_SCORE).
// Those lower the length/per-row bar to let short context-dependent prompts
// through, but the top-|rel| gap is an absolute distribution separator —
// lowering it in follow-up mode re-admits the 37..48 noise band that the
// gate exists to drop.
// min 0, because 0 is a REAL value here: the documented seed-mode switch that kills both
// absolute floors (see OR_TOP_BM25_FLOOR below).
//
// It has ALWAYS worked, and a first draft of this comment claimed otherwise on a false
// premise worth recording: `process.env.X` is always a STRING, and `'0'` is truthy — only
// `''` is falsy. So `Number(env || 50)` with `CLAUDE_MEM_UPS_TOP_MIN='0'` was already 0,
// which is why `tests/user-prompt-search.test.mjs` has been green with `'0'` as runScript's
// default. The idiom that genuinely swallows a 0 is the OTHER one — `Number(env.X) || D`,
// parse first then fall back — which is what lib/cite-back-hint.mjs used. Caught by the
// v3.94.0 pre-tag correctness review. What changed here is NaN screening, nothing else.
const TOP_REL_FLOOR = envNumber(process.env.CLAUDE_MEM_UPS_TOP_MIN, {
  name: 'CLAUDE_MEM_UPS_TOP_MIN',
  defaultValue: 50,
  min: 0,
});

// v2.43.x: OR-fallback raw BM25 magnitude floor. The composite TOP_REL_FLOOR
// above gates on `bm25 × importance × type_quality × decay × noise_penalty`.
// For importance=3 bugfix obs, those multipliers compound to ~6×, so a modest
// BM25 of -17..-22 can clear a composite floor of 50 via inflation alone.
// When the FTS query relaxes to OR (AND returned 0), a single strongly-
// matching stem on a big multi-topic prompt leaks through — observed
// failure mode: broad Chinese prompts surfacing unrelated importance=3
// bugfix obs whose concepts share exactly one stem with the prompt.
//
// Empirical OR-mode distribution (11-prompt probe, 2026-04-23):
//   real signal      top-|bm25_raw| ≥ 41
//   broad/meta noise top-|bm25_raw| ≤ 22
//   below threshold  top-|bm25_raw| < 12
// Default 30 sits in the clean 22→41 gap. AND mode bypasses this gate —
// AND's all-stems-must-match constraint is already a precision signal,
// and there are legitimate AND hits (GOOD-narrow probe: bm25_raw=19.3,
// rel=81) that we must not drop.
//
// CLAUDE_MEM_UPS_TOP_MIN=0 disables this too: on small test corpora (1–2
// seeded obs) absolute BM25 magnitudes collapse to near-zero (observed
// |bm25|≈4e-6) because FTS5 IDF normalization needs a real document
// distribution. The existing TOP_REL_FLOOR knob already encodes the
// "seed-mode: kill absolute floors" semantic for integration tests, so
// we piggy-back on it rather than introducing a second override env.
const OR_TOP_BM25_FLOOR =
  TOP_REL_FLOOR === 0
    ? 0
    : envNumber(process.env.CLAUDE_MEM_UPS_OR_BM25_MIN, {
        name: 'CLAUDE_MEM_UPS_OR_BM25_MIN',
        defaultValue: 30,
        min: 0,
      });

// ─── Corpus-size normalization of the absolute floors (v3.61.0) ─────────────
//
// Moved to lib/relevance-floor.mjs when error-recall became the second injection
// face needing the same ramp — one body rather than two hand-mirrored copies, the
// drift class this project keeps paying for. The calibration history that explains
// the ramp SHAPE (the 0/8 fresh-install measurement, the ln-vs-idf re-measure)
// moved with the code; read it there before changing a floor.
//
// Re-exported so callers here and tests/ups-corpus-floor-scale.test.mjs keep the
// existing import path.
export { corpusFloorScale };

function isFollowUpSession(injectedIdsFile) {
  try {
    const raw = readFileSync(injectedIdsFile, 'utf8');
    const { ts, count = 0 } = JSON.parse(raw);
    if (!ts || Date.now() - ts > DEDUP_STALE_MS) return false;
    return count > 0;
  } catch {
    return false;
  }
}

// ─── Explicit-signal gate (v2.57.x) ─────────────────────────────────────────
//
// Upstream gate that decides whether the FTS / prompt-fallback paths run at
// all. Per cite-recall baseline 2026-04-22 → 2026-05-09 (29 sessions),
// UserPromptSubmit injection cite-recall = 25.8% (132/178 silent injections)
// vs PreToolUse:Read/Edit at 94.1/94.2%. The gap is the always-search policy
// burning tokens on prompts the model never refers back to.
//
// Retreat: only inject when the prompt carries a signal that names something
// concrete. Four orthogonal channels:
//   (1) error-signature  — extractErrorSignature() typed exception match
//   (2) file-reference   — extractFiles() basename.ext or path separator
//   (3) detected intent  — detectIntent() catches recall words ("记得", "之前",
//                          "previously") + actionable keywords (bugfix/test/
//                          decision/refactor/perf/schema/implement/...)
//   (4) tech identifier  — CamelCase / snake_case / ALL_CAPS_CONST /
//                          kebab-case (≥3 segments). Conservative — drops
//                          single-lowercase-word identifiers ("mem", "fix")
//                          since those are 99% prose noise.
//
// "No signal" prompts ("does this work?", "how is it going") return no
// injection. PreToolUse file-keyed hook is independent (94% recall track,
// fires on Edit/Read/Write file paths) — not affected.
//
// Env override: CLAUDE_MEM_UPS_REQUIRE_SIGNAL=0 restores always-search.
// Default ON.
//
// Note for OR-fallback gate (#8144) interaction: this gate is upstream of
// score-quality gates (OR_TOP_BM25_FLOOR / TOP_REL_FLOOR). They compose:
// presence-gate decides whether to search at all; score-gate trims the
// returned set. Orthogonal layers — turning REQUIRE_SIGNAL off restores
// the previous behavior where score-gates alone control noise.
//
// Regex post-review (Important #1): bare-acronym ALL_CAPS arm `[A-Z]{2,}…`
// false-positived on common English prose (IBM, NPM, THE, BSD, ASCII).
// camelCase arm `[a-z][a-z0-9]*[A-Z]…` false-positived on iOS, eBay.
// Five-arm tightening:
//   • snake_case      — requires `_` between lowercase tokens
//   • CONST_CASE      — requires `_` between uppercase tokens (catches
//                       MAX_RESULTS, CLAUDE_MEM_DIR, OBS_BM25)
//   • ACRONYM_w_digit — bare 2+-cap run with at least one digit (catches
//                       FTS5, MD5, HTML5, OAUTH2, HTTP2; rejects IBM/NPM/
//                       THE/BSD/ASCII which never carry digits in prose)
//   • camelCase       — requires ≥2 lowercase before the first cap
//                       (excludes iOS, eBay; allows getUserById, parseJsonFromLLM)
//   • kebab-case      — ≥3 segments (pre-tool-use; excludes "easy-to-use")
// Bare digitless acronyms (URL, JWT, JSON, HTTP) no longer match — they
// typically appear alongside intent keywords or files anyway, so the gate
// catches the prompt via those channels rather than the identifier itself.
const TECH_IDENTIFIER_RE =
  /\b(?:[a-z][a-z0-9]*_[a-z0-9_]+|[A-Z][A-Z0-9]*_[A-Z0-9_]+|[A-Z]{2,}[0-9][A-Z0-9_]*|[a-z]{2,}[A-Z][a-zA-Z0-9]+|[a-z]+(?:-[a-z]+){2,})\b/;

// Reviewer #2 (v3.25.0): the kebab (≥3-seg) and camelCase arms above structurally
// match a handful of ordinary English phrases / product names that are NOT code
// identifiers — `up-to-date`, `state-of-the-art`, `macOS`, etc. Left unfiltered they
// (a) widen the default-ON hasExplicitSignal gate on prose-only prompts and (b) let
// such a token drive the opt-in identifier bypass. Stop-list them (lowercased). Real
// 3-segment kebab identifiers (`pre-tool-use`, `user-prompt-search`) are deliberately
// NOT here — only attested non-identifier prose.
const IDENTIFIER_STOPWORDS = new Set([
  'up-to-date',
  'out-of-date',
  'up-to-speed',
  'out-of-the-box',
  'state-of-the-art',
  'end-to-end',
  'off-by-one',
  'easy-to-use',
  'day-to-day',
  'step-by-step',
  'face-to-face',
  'one-to-one',
  'one-on-one',
  'back-to-back',
  'side-by-side',
  'apples-to-apples',
  'macos',
]);

// CJK presence channel (Important #2): bilingual users (project memory
// `feedback_*` calls this out explicitly) ask CJK questions that may carry
// genuine debug intent without containing an English identifier. CJK is
// information-dense — an 8-effective-unit prompt rarely encodes "how is it
// going"-style noise. Threshold mirrors shouldSkip's CJK floor.
const CJK_CHAR_RE = /[一-鿿぀-ヿ]/;
const CJK_MIN_EFFECTIVE_LEN = 8;

const REQUIRE_EXPLICIT_SIGNAL = process.env.CLAUDE_MEM_UPS_REQUIRE_SIGNAL !== '0';

export function hasExplicitSignal(text, { errSig, files, intent } = {}) {
  if (!text) return false;
  if (errSig) return true;
  if (Array.isArray(files) && files.length > 0) return true;
  if (intent) return true;
  // Recompute path — fires only when the caller passes `text` alone (test
  // entry point); production caller in main() always pre-computes all three.
  if (errSig === undefined && extractErrorSignature(text)) return true;
  if (files === undefined && extractFiles(text).length > 0) return true;
  if (intent === undefined && detectIntent(text)) return true;
  if (extractTechIdentifiers(text).length > 0) return true;
  if (CJK_CHAR_RE.test(text) && computeEffectiveLen(text) >= CJK_MIN_EFFECTIVE_LEN) return true;
  return false;
}

// ─── Identifier-exact-match precision bypass (default ON since v3.26.0) ──────
//
// Set CLAUDE_MEM_UPS_IDENTIFIER_BYPASS=0 to disable. Rationale: the score-floors below
// (OR_TOP_BM25_FLOOR / TOP_REL_FLOOR) drop the WHOLE FTS set when the top row's
// magnitude is weak. But a rare code identifier (camelCase / snake_case / CONST_CASE
// / kebab≥3) match has high *semantic* precision even at modest BM25 — a df=1 term
// like `sanitizeFtsQuery` scores only ~23 raw yet is an unambiguous hit. So an obs
// whose title/lesson EXACT-matches an identifier the prompt names is a precision pass
// — the same independent-signal rationale that already exempts sigRows (error
// signatures) and fileRows (file names) from these floors. Such rows are restored
// after the floors run.
//
// Default ON — flipped in v3.26.0 after a corrected benchmark/ups-ab.mjs re-measurement
// (#8858 two-bucket: TRUE off-topic FP isolated from on-topic eagerness). Over 12
// positives / 7 true-precision hard-negatives: recall up, TRUE off-topic FP = 0 (stable
// ×3 runs) → VERDICT NET-POSITIVE. The only behavior delta is on-topic eagerness (naming
// an identifier surfaces its obs) — the highest-precision injection trigger there is. The
// prose stop-list (IDENTIFIER_STOPWORDS) keeps the extractor off ordinary English.
// Query caps live in lib/ups-query.mjs — shared with `hook.mjs user-prompt`, the OTHER
// hook this same event fires. v3.75.0 capped this face only; a second copy of the
// constants here is what would let them drift apart again.

export const IDENTIFIER_BYPASS = process.env.CLAUDE_MEM_UPS_IDENTIFIER_BYPASS !== '0';
// How far past the main LIMIT the bypass may look, and how many rows it may pull from
// there (ALGO-2). These size the CANDIDATE POOL only — the injected set is still capped
// by MAX_RESULTS downstream, so neither widens the injection budget. Kept small on
// purpose: rows this deep matched the prompt weakly overall, and the identifier hit is
// the only reason they are admitted at all.
const IDENTIFIER_BYPASS_POOL_EXTRA = 7;
const IDENTIFIER_BYPASS_DEEP_MAX = 2;
const TECH_IDENTIFIER_RE_G = new RegExp(TECH_IDENTIFIER_RE.source, 'g');

// All tech-identifier tokens in `text`, lowercased + de-duped (for case-insensitive
// row matching). Empty array when none — callers treat that as "no bypass candidates".
export function extractTechIdentifiers(text) {
  return [
    ...new Set((String(text || '').match(TECH_IDENTIFIER_RE_G) || []).map((s) => s.toLowerCase())),
  ].filter((s) => !IDENTIFIER_STOPWORDS.has(s));
}

// True when the obs row's title or lesson contains any of `idsLower` as a standalone
// token (not embedded in a longer identifier). Title/lesson only — the searchByFts
// SELECT carries no narrative, and requiring the hit in the title/lesson is the
// stricter, higher-precision condition (intentional).
export function rowMatchesIdentifier(row, idsLower) {
  if (!idsLower || idsLower.length === 0) return false;
  const hay = `${row.title || ''} ${row.lesson_learned || ''}`.toLowerCase();
  const isWordChar = (c) => c !== undefined && /[a-z0-9_]/.test(c);
  return idsLower.some((id) => {
    let from = 0,
      i;
    while ((i = hay.indexOf(id, from)) >= 0) {
      if (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + id.length])) return true;
      from = i + 1;
    }
    return false;
  });
}

// ─── DB Query Functions ─────────────────────────────────────────────────────

// Returns { rows, mode } where mode is 'AND' (initial pass), 'OR' (fallback
// after AND returned 0), or null (no FTS query / sanitize rejected). Callers
// use `mode` to apply OR-specific gates — see OR_TOP_BM25_FLOOR rationale.
// Each row includes `bm25_raw` (pre-multiplier bm25 magnitude) alongside the
// composite `relevance`, so callers can distinguish raw-match strength from
// importance/type/decay inflation.
export function searchByFts(
  db,
  queryText,
  project,
  limit,
  typeFilter,
  { nowT = Date.now(), epochTo = null } = {},
) {
  const ftsQuery = upsFtsQuery(queryText);
  if (!ftsQuery) return { rows: [], mode: null };

  const cutoff = nowT - LOOKBACK_MS;

  const typeClause = typeFilter ? 'AND o.type = ?' : '';
  const now = nowT;
  // R1: notLowSignalTitleClause() excludes hook-llm degraded titles
  // ("Modified X", "Worked on X", "Reviewed N files:", raw error logs).
  // v26 P0: noise penalty shrinks relevance magnitude for obs with high
  // inject:access ratio (auto-injected often, never cited/opened). See
  // docs/p0-injection-noise-baseline.txt.
  // A1 (v2.83): cite_factor closes the citation-decay → ranking loop. Obs the
  // assistant cited in past sessions (cited_count > 0) get boosted; obs with
  // accumulating uncited_streak get dampened upstream of importance-decay.
  // Disjoint signal from noise_penalty (which uses injection_count vs
  // access_count) — see scoring-sql.mjs::citeFactorClause for the math.
  const sql = `
    SELECT o.id, o.type, o.title, o.lesson_learned,
           ${OBS_BM25} as bm25_raw,
           ${injectionRelevanceSql('o')} as relevance
    FROM observations_fts
    JOIN observations o ON o.id = observations_fts.rowid
    WHERE observations_fts MATCH ?
      AND o.project = ?
      AND o.importance >= 1
      AND o.created_at_epoch > ?
      AND (? IS NULL OR o.created_at_epoch <= ?)
      AND ${liveObsFilterSql('o')}
      AND ${notLowSignalTitleClause('o')}
      ${typeClause}
    ORDER BY relevance
    LIMIT ?
  `;

  const params = [now, ftsQuery, project, cutoff, epochTo, epochTo];
  if (typeFilter) params.push(typeFilter);
  params.push(limit);

  let rows = db.prepare(sql).all(...params);
  let mode = 'AND';

  // OR fallback if AND query returned nothing
  if (rows.length === 0) {
    const orQuery = relaxFtsQueryToOr(ftsQuery);
    if (orQuery) {
      params[1] = orQuery;
      rows = db.prepare(sql).all(...params);
      mode = 'OR';
    }
  }

  return { rows, mode };
}

function searchByFile(db, files, project, limit) {
  if (files.length === 0) return [];

  const cutoff = Date.now() - LOOKBACK_MS;
  const results = [];

  // Loop-invariant: every clause helper below renders SQL TEXT from a table alias, and
  // the per-file part is `fileMatchParams(file)` — bound values, not SQL. Prepared once
  // (better-sqlite3 recompiles on every `prepare`), on the UserPromptSubmit hot path.
  const byFile = db.prepare(`
    SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
    FROM observations o
    JOIN observation_files of2 ON of2.obs_id = o.id
    WHERE o.project = ?
      AND o.importance >= 1
      AND ${liveObsFilterSql('o')}
      AND o.created_at_epoch > ?
      AND ${fileMatchClause('of2')}
      AND ${notLowSignalTitleClause('o')}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `);

  for (const file of files.slice(0, 3)) {
    // Shared predicate (pre-tag review of v3.76.2, SF-1/S2). This leg used
    // `file.split('/').pop()` — weaker than node:path `basename`, since it misses '\'
    // even ON a Windows host — plus a bare `%<basename>` suffix LIKE with no path
    // boundary, so a prompt mentioning `utils.mjs` recalled `bash-utils.mjs` lessons.
    // fileMatchClause's four arms and fileMatchParams' escaping are the single home.
    const basename = basenameAnySep(file);
    if (!basename || basename.length < 2) continue;

    // R1: exclude LOW_SIGNAL degraded titles from file-level recall (in `byFile` above).
    const rows = byFile.all(project, cutoff, ...fileMatchParams(file), limit);

    results.push(...rows);
  }

  // Deduplicate by id
  const seen = new Set();
  return results.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

// v2.34.5 Gap 1: prompts-table fallback. When observations-based paths
// (FTS / file-recall / sigRows / recent) all return empty, scan the user's
// own past prompts — meta/UX/"did we discuss this" questions often match
// prior prompts even when no observation was saved. Uses a simpler BM25
// ranking with no scoring multipliers and no top-|rel| gate (prompts are
// sparser and more surface-form than observations; the gate would rarely
// fire and mostly kill real hits).
function searchByUserPrompts(db, queryText, project, limit) {
  const ftsQuery = upsFtsQuery(queryText);
  if (!ftsQuery) return [];

  const cutoff = Date.now() - LOOKBACK_MS;
  // Exclude <task-notification> internal protocol messages — parity with
  // server.mjs mem_search + mem-cli.mjs search (see lesson #8139: read-path
  // parity across paths querying the same table).
  const sql = `
    SELECT up.id, up.prompt_text, up.created_at_epoch,
           bm25(user_prompts_fts) as relevance
    FROM user_prompts_fts
    JOIN user_prompts up ON up.id = user_prompts_fts.rowid
    JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
    WHERE user_prompts_fts MATCH ?
      AND s.project = ?
      AND up.created_at_epoch > ?
      AND up.prompt_text NOT LIKE '<task-notification>%'
    ORDER BY relevance
    LIMIT ?
  `;

  // Over-fetch, because the cjkPrecisionOk filter below runs in JS (audit 2026-08-29
  // ALGO-5, the D#172 shape). At the shipped PROMPT_FALLBACK_LIMIT of 1 the SQL LIMIT
  // was a REACHABILITY bound sitting upstream of a relevance filter: dropping one row
  // dropped the whole face, so a CJK prompt whose best BM25 match happened to be a
  // false bigram hit injected NOTHING even when rank 2 was a real match. Fetch a pool,
  // filter, then take `limit` — same ORDER BY, so the old result is a prefix of this
  // one and a row can only be added, never displaced by something worse.
  const poolLimit = Math.min(limit * PROMPT_FALLBACK_POOL_FACTOR, PROMPT_FALLBACK_POOL_MAX);
  let rows = db.prepare(sql).all(ftsQuery, project, cutoff, poolLimit);

  if (rows.length === 0) {
    const orQuery = relaxFtsQueryToOr(ftsQuery);
    if (orQuery) {
      try {
        rows = db.prepare(sql).all(orQuery, project, cutoff, poolLimit);
      } catch {}
    }
  }

  // CJK precision filter (parity with server.mjs + mem-cli.mjs): unicode61
  // FTS degrades CJK bigram queries to single-char AND, letting any prose
  // sharing common chars leak through. Drop rows that miss < 20% of query
  // bigrams/keywords as contiguous substrings. Non-CJK queries bypass.
  return rows.filter((r) => cjkPrecisionOk(queryText, r.prompt_text)).slice(0, limit);
}

function searchRecent(db, project, limit) {
  const cutoff = Date.now() - LOOKBACK_MS;
  // R1: exclude LOW_SIGNAL degraded titles from "recent" recall intent
  // (e.g. when user asks "what did I do earlier"). Unqualified alias because
  // this query selects directly from observations with no join.
  return db
    .prepare(
      `
    SELECT id, type, title, lesson_learned
    FROM observations
    WHERE project = ?
      AND importance >= 1
      AND ${liveObsFilterSql('')}
      AND created_at_epoch > ?
      AND ${notLowSignalTitleClause('')}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `,
    )
    .all(project, cutoff, limit);
}

// ─── stdin Reader ───────────────────────────────────────────────────────────

// P1-9: shared mechanism (lib/hook-stdin.mjs), this entry point's own caliber. 2 s and
// MAX_UPS_PROMPT_BYTES (64 KB, #9494's huge-prompt guard) are deliberately tighter than the
// 256 KB full-payload tier hook.mjs uses — both tiers live in utils.mjs (G19) — because the
// payload here is a user PROMPT, not a tool response. `rejectOnTimeout` matches the previous
// behaviour: the caller treats a timeout as "skip the injection".
// Returns a bare string, as this script's callers expect.
async function readStdin() {
  const { text } = await readHookStdin({
    timeoutMs: 2000,
    maxBytes: MAX_UPS_PROMPT_BYTES,
    rejectOnTimeout: true,
  });
  return text;
}

// ─── Format Output ──────────────────────────────────────────────────────────

// Phase A (v2.31.3+): drop lesson suffix when MEM_QUIET_HOOKS=1; users on invited-memory
// path can mem_get the ID for full detail.
const QUIET_HOOKS = process.env.MEM_QUIET_HOOKS === '1';

function formatResults(rows) {
  if (!rows || rows.length === 0) return null;

  const lines = ['[mem] FYI — Related memories (continue your task):'];
  for (const r of rows) {
    const icon = typeIcon(r.type);
    // Defang replayed obs text before truncation: a poisoned title/lesson carrying tool-XML
    // or a forged authority tag must not render as a live delimiter in this injected block.
    const title = truncate(neutralizeContextDelimiters(r.title || ''), 70);
    const lesson =
      !QUIET_HOOKS && r.lesson_learned
        ? ` — ${truncate(neutralizeContextDelimiters(r.lesson_learned), 50)}`
        : '';
    lines.push(`#${r.id} ${icon} ${title}${lesson}`);
  }
  return lines.join('\n');
}

// v2.34.5 Gap 1: distinct header signals to Claude that these are prior
// *user questions*, not codebase lessons — helps the reader interpret the
// row correctly (surface-form match, not a saved insight). Truncate to 80
// chars (slightly longer than obs titles because prompts carry more context).
function formatPromptResults(rows) {
  if (!rows || rows.length === 0) return null;
  const lines = ['[mem] FYI — Past similar questions (continue your task):'];
  for (const r of rows) {
    // prompt_text is a raw prior USER prompt — the highest-risk replayed class (this is
    // exactly the column that carried malformed tool-XML into the handoff bug). Defang the
    // delimiters, then collapse whitespace + truncate.
    const text = truncate(neutralizeContextDelimiters(r.prompt_text || '').replace(/\s+/g, ' '), 80);
    lines.push(`P#${r.id} 💬 ${text}`);
  }
  return lines.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Prevent recursion from background claude -p calls
  if (process.env.CLAUDE_MEM_HOOK_RUNNING) return;

  let raw;
  try {
    raw = await readStdin();
  } catch {
    return;
  }

  let hookData;
  try {
    hookData = JSON.parse(raw);
  } catch {
    return;
  }
  // JSON.parse('null'/'42'/'"x"') succeeds with a non-object; dereferencing .prompt on
  // it threw a raw TypeError → unhandled rejection → exit 1 (this was the lone hook
  // script without an exit-0 safety net, violating the "hooks never exit non-zero"
  // invariant — exit 2 on UserPromptSubmit would even block the user's prompt).
  if (!hookData || typeof hookData !== 'object') return;

  const rawPrompt = hookData.prompt || hookData.user_prompt;
  if (!rawPrompt || typeof rawPrompt !== 'string') return;

  // Skip internal protocol messages (check on raw text — protocol sentinel
  // would never legitimately be wrapped in <private>).
  if (rawPrompt.startsWith('<task-notification>')) return;

  // D#120: session-keyed dedup marker — every read/write below uses this path.
  const injectedIdsFile = injectedIdsFileFor(hookData.session_id);

  // Strip <private>...</private> blocks before length gates and FTS query
  // construction — private content must not pad effective length nor leak
  // into the FTS MATCH query terms. Mirrors hook.mjs handleUserPrompt.
  const promptText = stripPrivate(rawPrompt);

  // P0: User-explicit "ignore memory" override (mirrors CC built-in
  // memoryTypes.ts:215). Moved ABOVE the deterministic D# path so it
  // short-circuits ALL injection surfaces (previously ran after shouldSkip —
  // same outcome there, both return without output).
  if (detectMemOverride(promptText)) return;

  // ─── Deterministic D#N deferred-detail injection (v3.50) ──────────────────
  // A prompt naming D#N ("D#92 批准，进 writing-plans") is the highest-precision
  // trigger this hook has: the user is resuming a deferred item whose FULL
  // detail no list surface renders (defer list / dashboard are title-only —
  // the 2026-07-18 D#92 post-/clear failure chain). Runs BEFORE shouldSkip /
  // length gates: short approval prompts are the common case here, and the
  // trigger is exact-reference, not relevance-scored.
  let db = null;
  try {
    const deferredRefs = extractDeferredRefs(promptText);
    if (deferredRefs.length > 0) {
      db = ensureDb();
      const project = inferProject();
      const openRows = getDeferredByIds(db, deferredRefs).filter(
        (r) => r.status === 'open' && r.project === project,
      );
      // Namespace dedup ids as "D<id>" (parity with the "P<id>" prompt-corpus
      // convention) so obs ids can't collide in the shared injected-ids file.
      const dedupIds = openRows.map((r) => `D${r.id}`);
      if (openRows.length > 0 && !shouldSkipByDedup(dedupIds, injectedIdsFile, hookData.session_id)) {
        const lines = ['[mem] Deferred work referenced in prompt (open items, full detail):'];
        for (const r of openRows) {
          const pTag = r.priority === 3 ? '🔴' : r.priority === 1 ? '⚪' : '🟡';
          lines.push(`D#${r.id} ${pTag} [P${r.priority}] ${neutralizeContextDelimiters(r.title || '')}`);
          if (r.detail) {
            // Full detail, defanged, never truncated — the point of this surface.
            for (const dl of neutralizeContextDelimiters(r.detail).split('\n')) lines.push(`  ${dl}`);
          }
        }
        process.stdout.write(lines.join('\n') + '\n');
        // Merge into the dedup file so a re-referencing prompt within the stale
        // window skips re-injection. A later FTS-path write replaces ids wholesale
        // (accepted: worst case is one cheap re-injection after an obs-emitting
        // prompt inside the same 5-min window).
        // union: the M-6 same-session/staleness gate + the atomic write live in
        // lib/injected-ids.mjs (audit 2026-09-02 P1-2). `dedupIds` are `D<id>` strings, so
        // the lib's union-side String() is the identity here — same bytes as before.
        try {
          mergeInjectedMarker(injectedIdsFile, dedupIds, {
            sessionId: hookData.session_id,
            maxAgeMs: DEDUP_STALE_MS,
            mode: 'union',
          });
        } catch {}
      }
    }
  } catch {
    /* deterministic path must never block the main flow */
  }

  // Skip short/confirmation/slash-command/simple-op prompts
  if (shouldSkip(promptText)) {
    try {
      db?.close();
    } catch {}
    return;
  }

  // T3 (v2.31): additional raw-length gate on top of shouldSkip's CJK-weighted
  // effective-length check. Suppresses medium-short Latin prompts ("run tests",
  // "fix bug now") that carry too few content tokens for a meaningful FTS lookup.
  // v2.33.1: follow-up prompts in an already-active session get a lower gate —
  // short continuations ("前面那个?", "does it work?") depend on prior context.
  const followUp = isFollowUpSession(injectedIdsFile);
  const promptMinLen = followUp ? FOLLOWUP_PROMPT_MIN_LENGTH : PROMPT_MIN_LENGTH;
  if (computeEffectiveLen(promptText.trim()) < promptMinLen) {
    try {
      db?.close();
    } catch {}
    return;
  }
  const bm25Floor = followUp ? FOLLOWUP_BM25_MIN_SCORE : BM25_MIN_SCORE;

  // db may already be open from the deterministic D# path above.
  if (!db) {
    try {
      db = ensureDb();
    } catch (e) {
      // A failed DB open silently kills EVERY prompt-time injection while `stats`
      // reads zero errors (audit 2026-08-14 M-5) — record before the mandatory
      // swallow. Exact blindness class of the 2026-08-13 pre-recall:db-open outage.
      recordHookError('ups:db-open', e, RUNTIME_DIR);
      return;
    }
  }

  try {
    const project = inferProject();
    const intent = detectIntent(promptText);
    let rows = [];

    // A (v2.32.8): precision pass for named errors. When the prompt contains
    // a typed exception signature (TypeError/ValueError/ReferenceError/...),
    // seed results with exact-match bugfix observations before the intent-
    // based FTS flow runs. These hits are the most directly relevant and
    // take priority slots in the merged output.
    const errSig = extractErrorSignature(promptText);
    const sigRows = errSig
      ? searchByFts(db, errSig.signature, project, 2, 'bugfix').rows.filter(
          (r) => typeof r.relevance === 'number' && Math.abs(r.relevance) >= bm25Floor,
        )
      : [];

    // v2.57.x explicit-signal gate. Compute files once for both the gate and
    // the file-recall path below — extractFiles is regex over the prompt,
    // safe to call eagerly. errSig + intent already computed above.
    const filesForGate = extractFiles(promptText);
    const signalPresent = hasExplicitSignal(promptText, {
      errSig,
      files: filesForGate,
      intent,
    });
    // Identifier tokens the prompt names (for the precision bypass below). Empty only
    // when CLAUDE_MEM_UPS_IDENTIFIER_BYPASS=0 (bypass is default-on), then it is a no-op.
    const promptIdentifiers = IDENTIFIER_BYPASS ? extractTechIdentifiers(promptText) : [];

    // Recall intent ("之前 / previously / 记得 …") used to short-circuit straight to
    // searchRecent, discarding the prompt text — so the most explicit memory request a
    // user can make was the one answered without reading what they asked about. Measured
    // on a 600-row corpus, two prompts one word apart: "分页接口又报 500 了，边界问题怎么处理"
    // put the right row at rank 1, while "…之前那个边界问题是怎么处理的" surfaced NEITHER it
    // nor anything related — 5 unrelated recency rows instead. Adding the recall keyword
    // removed the answer and spent the injection budget on noise.
    //
    // Recency is still the right answer for a CONTENTLESS recall prompt ("之前我们在做什么"),
    // which has no topic to match — so it becomes a FALLBACK (below) rather than a
    // short-circuit. The explicit-signal gate needs no recall-intent carve-out:
    // hasExplicitSignal already returns true whenever `intent` is truthy, and recall intent
    // implies that, so a recall prompt cannot reach the no-signal branch. (An earlier draft
    // added `!recentFallback &&` here; review showed the condition was dead.)
    const recentFallback = Boolean(intent?.useRecent);
    if (REQUIRE_EXPLICIT_SIGNAL && !signalPresent) {
      // No explicit signal — skip FTS pipeline + prompt-fallback. sigRows
      // is already empty (errSig was null else signalPresent would be true).
      // Registry skill pointer below remains unaffected (its own name match).
      rows = [];
    } else {
      // FTS search: use the prompt as query, optionally type-filtered
      const files = filesForGate;
      const mainLimit = intent?.limit || MAX_RESULTS;
      // Over-fetch ONLY to feed the identifier bypass below (audit 2026-08-29 ALGO-2,
      // the D#172 shape). The bypass used to select from `ftsRows`, i.e. from the same
      // LIMIT-`mainLimit` window it exists to rescue rows into — so it could only ever
      // recover a row the composite sort had ALREADY ranked top-3, and the df=1
      // identifier row its own docblock argues for (rare token, so BM25-strong on the
      // term but easily out-ranked by rows matching more of the prompt) was unreachable.
      // `ftsRows` stays the exact old head slice, so the main path is byte-identical;
      // only the bypass sees deeper. Pool sizing is bypass-only: with the bypass off
      // this is the old query verbatim.
      const poolLimit = IDENTIFIER_BYPASS ? mainLimit + IDENTIFIER_BYPASS_POOL_EXTRA : mainLimit;
      let ftsResult = searchByFts(db, promptText, project, poolLimit, intent?.type || null);
      // Fallback: if typed search returned nothing, retry without type filter
      if (ftsResult.rows.length === 0 && intent?.type) {
        ftsResult = searchByFts(db, promptText, project, poolLimit, null);
      }
      const ftsPool = ftsResult.rows;
      let ftsRows = ftsPool.slice(0, mainLimit);
      const ftsMode = ftsResult.mode;
      const fileRows = files.length > 0 ? searchByFile(db, files, project, 2) : [];

      // T3 (v2.31): BM25 magnitude threshold — drop FTS hits whose relevance
      // magnitude doesn't clear the floor. This targets OR-fallback leakage
      // where a single-stem match surfaces tangential observations. Only FTS
      // rows carry a `relevance` column; file-recall rows (searchByFile) have
      // no relevance and are always kept — file-scoped recall is presumed
      // intentional and has its own relevance signal (the file name match).
      ftsRows = ftsRows.filter((r) => typeof r.relevance === 'number' && Math.abs(r.relevance) >= bm25Floor);

      // Identifier-exact-match precision bypass (default on — see IDENTIFIER_BYPASS).
      // Capture rows that exact-match a prompt identifier BEFORE the set-floors below;
      // they carry independent precision signal (sigRows/fileRows rationale) and are
      // restored after the floors so a low top-score can't drop a named-identifier hit.
      // STRICTLY ADDITIVE to the pre-ALGO-2 behaviour: `head` is what this expression
      // used to return (the post-floor rows of the old LIMIT window that match an
      // identifier), and `deep` adds at most IDENTIFIER_BYPASS_DEEP_MAX rows from
      // beyond that window. The audit prescribed a standalone LIMIT-2 SELECT; a capped
      // tail of the SAME query is the same reach with one fewer FTS scan, and it cannot
      // regress the head — a flat cap of 2 over the merged set could have, by evicting
      // a third head row that ships today.
      //
      // "Additive" scopes to THIS SET, not to what finally ships. Downstream the merge
      // appends `fileRows` after `ftsRows` (dedup by id) and then slices to MAX_RESULTS, and
      // `deep` rows sort LAST within `ftsRows` (weaker |bm25|, ascending sort) — so a deep
      // row takes a slot ahead of a file-recall row whenever `|head| < MAX_RESULTS` AND
      // `|head| + |deep| + |fileRows| > MAX_RESULTS`, with at least one deep row and one
      // fileRow present. The first condition is not redundant: `mainLimit` is
      // `intent?.limit || MAX_RESULTS`, so head can already be 3 — and at head=3 the fileRow
      // never boarded in the first place, so nothing is displaced. At head=2/deep=1/
      // fileRows=1 the output is [h1, h2, d1] where it was [h1, h2, f1]; at
      // head=1/deep=1/fileRows=1 nothing is displaced. The trade is one
      // "filename matched, presumed deliberate" row for one "weak overall bm25, admitted
      // only on an identifier hit" row. It is a real quality judgement and it is UNMEASURED
      // — denoise-ab is structurally blind to this face. v3.85.0's release note called the
      // whole change "strictly additive"; true of the bypass set, false of the output.
      const bypassFloorOk = (r) => typeof r.relevance === 'number' && Math.abs(r.relevance) >= bm25Floor;
      let bypassRows = [];
      if (IDENTIFIER_BYPASS && promptIdentifiers.length > 0) {
        const head = ftsPool
          .slice(0, mainLimit)
          .filter(bypassFloorOk)
          .filter((r) => rowMatchesIdentifier(r, promptIdentifiers));
        const headIds = new Set(head.map((r) => r.id));
        const deep = ftsPool
          .slice(mainLimit)
          .filter(bypassFloorOk)
          .filter((r) => !headIds.has(r.id) && rowMatchesIdentifier(r, promptIdentifiers))
          .slice(0, IDENTIFIER_BYPASS_DEEP_MAX);
        bypassRows = [...head, ...deep];
      }

      // v2.43.x: OR-mode raw-BM25 floor. In OR-fallback mode the composite
      // TOP_REL_FLOOR below is inflated by importance × type_quality × decay
      // multipliers — a weak single-stem hit on an importance=3 bugfix obs
      // can reach composite rel=66 while raw |bm25|=19. Gate on raw bm25
      // magnitude for OR mode only; AND mode's all-stems-match constraint
      // is a precision signal and routinely produces legitimate AND hits
      // below raw |bm25|=20 that we do not want to drop (see GOOD-narrow
      // probe). Skip gate when OR_TOP_BM25_FLOOR is set to 0 (test hook).
      // Both absolute floors are normalized by corpus size (corpusFloorScale) —
      // factor 1.0 for any install at/above the calibration corpus, so this is a
      // no-op for established users and a proportional relaxation for new ones.
      const floorScale = corpusFloorScale(db);
      const orFloor = OR_TOP_BM25_FLOOR * floorScale;
      if (ftsMode === 'OR' && orFloor > 0 && ftsRows.length > 0) {
        const topBm25 = Math.abs(ftsRows[0].bm25_raw || 0);
        if (topBm25 < orFloor) ftsRows = [];
      }

      // v2.34.3: top-|rel| sanity gate. Per-row filtering above leaves noise
      // prompts intact when many rows share a weak stem (all in 25..48 range).
      // If the best remaining FTS match is below the top floor, drop the
      // whole FTS set — noise prompts should produce no FTS injection.
      // Query orders by `relevance` ASC; negative values → ftsRows[0] has the
      // largest magnitude (strongest match) in this scoring expression.
      if (ftsRows.length > 0 && Math.abs(ftsRows[0].relevance) < TOP_REL_FLOOR * floorScale) {
        ftsRows = [];
      }

      // Restore identifier-matched precision rows the set-floors above dropped.
      // No-op when the bypass is off (bypassRows is []) or when the floors kept the
      // rows anyway (dedup by id). Re-sort so the merged set stays relevance-ordered.
      if (bypassRows.length > 0) {
        const kept = new Set(ftsRows.map((r) => r.id));
        for (const r of bypassRows) if (!kept.has(r.id)) ftsRows.push(r);
        ftsRows.sort((a, b) => (a.relevance ?? 0) - (b.relevance ?? 0));
      }

      // Merge: FTS results first, then file results, deduplicated
      const seen = new Set(ftsRows.map((r) => r.id));
      rows = [...ftsRows];
      for (const r of fileRows) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          rows.push(r);
        }
      }
      rows = rows.slice(0, MAX_RESULTS);
    }

    // Recall-intent fallback (see the `recentFallback` rationale above): only when the
    // prompt named nothing the corpus matches. A contentless "之前我们在做什么" lands here
    // and behaves exactly as it did before; a topical recall prompt no longer does.
    if (rows.length === 0 && recentFallback) {
      rows = searchRecent(db, project, intent.limit);
    }

    // A (v2.32.8): prepend error-signature hits (higher precision), dedup, cap.
    if (sigRows.length > 0) {
      const sigIds = new Set(sigRows.map((r) => r.id));
      rows = [...sigRows, ...rows.filter((r) => !sigIds.has(r.id))].slice(0, MAX_RESULTS);
    }

    // v2.34.5 Gap 1: if observations-based search drew a blank, try the
    // user_prompts corpus. Only fires when `rows` is empty (obs hits
    // suppress the fallback to avoid noise). Namespace prompt IDs with
    // a "P" prefix so shouldSkipByDedup's Set comparison doesn't collide
    // with future observation IDs.
    //
    // v2.57.x: also gated by signalPresent. The prompt-fallback path has
    // no quality gate (only BM25 ordering — see PROMPT_FALLBACK_LIMIT
    // rationale at top), so injecting it on no-signal prompts is the
    // single highest-noise UPS path. Restored when REQUIRE_SIGNAL=0.
    let promptRows = [];
    if (rows.length === 0 && (!REQUIRE_EXPLICIT_SIGNAL || signalPresent)) {
      promptRows = searchByUserPrompts(db, promptText, project, PROMPT_FALLBACK_LIMIT);
    }

    const candidateIds = rows.length > 0 ? rows.map((r) => r.id) : promptRows.map((r) => `P${r.id}`);
    const dedupSkip = shouldSkipByDedup(candidateIds, injectedIdsFile, hookData.session_id);

    const output = !dedupSkip
      ? rows.length > 0
        ? formatResults(rows)
        : formatPromptResults(promptRows)
      : null;
    if (output) {
      process.stdout.write(output + '\n');
      // Write injected IDs for dedup with hook.mjs handleUserPrompt + self-dedup
      // replace, NOT union: this leg writes the prompt's own result set wholesale, and it
      // is the ONE writer that puts raw observation numbers (mixed with `P<id>` strings)
      // into the marker. `mode:'replace'` writes `candidateIds` verbatim for exactly that
      // reason — stringifying here would flip the D#213 exclude from inert to live, which
      // is a behaviour change with its own ruler and its own decision to make.
      try {
        mergeInjectedMarker(injectedIdsFile, candidateIds, {
          sessionId: hookData.session_id,
          maxAgeMs: DEDUP_STALE_MS,
          mode: 'replace',
        });
      } catch {}
      // v26 P0: bump injection_count for obs-based emits only (prompt-corpus
      // rows have "P<id>" string IDs; skip those — they live in user_prompts).
      // Per-row try/catch: observations_au trigger reinserts FTS on any UPDATE
      // (project_non_obvious.md); an FTS corruption on one row must not abort
      // counter bumps for other rows.
      if (rows.length > 0) {
        try {
          const now = Date.now();
          const bumpStmt = db.prepare(
            'UPDATE observations SET injection_count = COALESCE(injection_count, 0) + 1, last_injected_at = ? WHERE id = ?',
          );
          for (const r of rows) {
            try {
              bumpStmt.run(now, r.id);
            } catch {}
          }
        } catch {}
      }
    }
  } catch (e) {
    // Hooks must never break Claude Code — swallow, but RECORD: this catch wraps
    // every FTS query on the surface, so a schema/FTS drift here would zero out
    // prompt-time injection with no trace anywhere (audit 2026-08-14 M-5).
    recordHookError('ups:search', e, RUNTIME_DIR);
  } finally {
    try {
      db.close();
    } catch {}
  }
}

// Swallow any rejection so the hook can never surface a non-zero exit (the invariant
// every sibling hook script upholds). Deliberately NOT `.finally(process.exit(0))` —
// this hook detaches a background `claude -p` search and a forced exit would kill it;
// letting the loop drain naturally exits 0 once the detached child is unref'd.
// Import guard (mirrors benchmark/longmemeval.mjs): only auto-run when this file is
// executed directly as the UserPromptSubmit hook, not when a benchmark/test harness
// imports it to call searchByFts() offline (see tests/adoption-searchbyfts-snapshot.test.mjs).
//
// Exported as a pure predicate (side-effect-free) so a regression test can
// exercise it directly without triggering main(). hook-launcher.mjs's
// self-heal retry (runEntry({ bustCache: true })) re-imports this entry with
// a cache-buster query appended (`?t=<ts>`) so Node's ESM cache doesn't
// return the earlier ERR_MODULE_NOT_FOUND rejection, while process.argv[1]
// stays query-less — a strict `===` here evaluated false on that retry,
// silently skipping main() so the healed hook fire did no memory search.
// Stripping the query before comparing fixes that without weakening the
// normal-launcher / execFileSync direct-invocation checks (both still match
// exactly, query or no query).
export function isDirectInvocation(metaUrl, argv1) {
  if (!argv1) return false;
  return metaUrl.split('?')[0] === pathToFileURL(argv1).href;
}
if (isDirectInvocation(import.meta.url, process.argv[1])) {
  // Last-resort telemetry for anything that escapes main()'s own catches (e.g. a
  // throw between the entry and the guarded body). Recorder never throws; the
  // outer catch keeps the never-non-zero-exit invariant regardless.
  main().catch((e) => {
    try {
      recordHookError('ups:main', e, RUNTIME_DIR);
    } catch {
      /* never */
    }
  });
}
