// Single source of truth for LOW_SIGNAL title patterns.
//
// "LOW_SIGNAL" = hook-llm fallback titles written when Haiku summarization
// is unavailable or skipped ("Modified X", "Worked on X", "Reviewed N files:",
// raw "Error: ..." logs, bare "node/npm/npx <cmd>" etc.). Empirical data:
// ~544 such entries in production, 18 ever accessed (3.3% retrieval rate).
//
// Three consumers must stay in sync (pre-β: by hand-mirrored comments);
// post-β: all three derive from this module.
//   1. utils.mjs::LOW_SIGNAL_TITLE       — regex for write-side importance cap
//   2. scoring-sql.mjs::notLowSignalTitleClause — SQL NOT LIKE chain for read-side filter
//   3. scripts/pre-tool-recall.js         — inline SQL (standalone cold-start script)
//
// This module is intentionally dependency-free so scripts/pre-tool-recall.js can
// import it without inflating the ~30ms cold-start budget.

/**
 * Each entry has:
 *   - like:  SQLite LIKE pattern (anchored; % = any chars)
 *   - regex: JS regex source fragment (MUST match the same title set as `like`)
 *
 * Adding/removing entries requires updating the sync test (tests/low-signal-sync.test.mjs).
 */
export const LOW_SIGNAL_PATTERNS = [
  { like: 'Modified %', regex: '^Modified ' },
  { like: 'Worked on %', regex: '^Worked on ' },
  { like: 'Reviewed % files:%', regex: '^Reviewed \\d+ files:' },
  { like: 'Codebase exploration%', regex: '^Codebase exploration' },
  { like: 'Error while working%', regex: '^Error while working' },
  { like: 'Error in %', regex: '^Error in ' },
  { like: 'Error: %', regex: '^Error: ' },
  { like: '# %', regex: '^# ' },
  { like: 'node %', regex: '^node ' },
  { like: 'npm %', regex: '^npm ' },
  { like: 'npx %', regex: '^npx ' },
  { like: '(no description)%', regex: '^\\(no description\\)' },
  { like: '%(error)', regex: '\\(error\\)$' },
];

/**
 * Build the combined regex that matches ANY LOW_SIGNAL pattern.
 * Equivalent to the hand-written `LOW_SIGNAL_TITLE` before β refactor.
 */
export function buildLowSignalRegex() {
  const src = LOW_SIGNAL_PATTERNS.map((p) => `(?:${p.regex})`).join('|');
  return new RegExp(src);
}

/**
 * Build the SQL NOT LIKE clause chain, optionally prefixed with a table alias.
 * Output is a single parenthesized AND-chain — safe to combine with other AND/OR.
 *
 * `lessonEscape` (2026-07-24 audit P1, D#11): retrieval consumers on the
 * observations table pass `{ lessonEscape: true }` to admit rows whose title
 * matches a LOW_SIGNAL pattern but which carry a real lesson_learned — the
 * read-side counterpart of the isNoiseObservation/capNoiseImportance write-side
 * signal escapes. Without it, a substantive obs titled "npm pack drops …" is
 * unsearchable forever. Escape is lesson-only by design: an importance>=2
 * escape would resurrect pre-v2.47 Haiku-inflated noise on legacy DBs.
 * Default stays title-only because two consumers query the events table
 * (no lesson_learned column) and two are noise-title METRICS, not filters.
 *
 * @param {string} [alias=''] Table alias (e.g. 'o') — empty for unqualified.
 * @param {object} [opts]
 * @param {boolean} [opts.lessonEscape=false] Admit rows with non-empty, non-'none' lesson_learned.
 * @returns {string} SQL boolean expression
 */
export function buildNotLowSignalSql(alias = '', { lessonEscape = false } = {}) {
  const p = alias ? `${alias}.` : '';
  const clauses = LOW_SIGNAL_PATTERNS.map(({ like }) => `${p}title NOT LIKE '${like}'`);
  const chain = '(\n    ' + clauses.join('\n    AND ') + '\n  )';
  if (!lessonEscape) return chain;
  // Mirrors the write-side lesson test: String(lesson).trim().toLowerCase() not in ('', 'none').
  const escape = `(${p}lesson_learned IS NOT NULL AND LOWER(TRIM(${p}lesson_learned)) NOT IN ('', 'none'))`;
  return `(${chain} OR ${escape})`;
}

// Cached singleton — isNoiseObservation is called once per observation insert.
const _LOW_SIG_RE = buildLowSignalRegex();

/**
 * Detect narrative that is raw tool-output passthrough, not human/LLM prose (P2).
 *
 * `buildImmediateObservation` constructs narrative as
 * `episode.entries.map(e => e.desc).join('; ')` where each desc is
 * "cmd → stdout/stderr" from `scripts/post-tool-use.sh`. Such narratives
 * have characteristic fingerprints (arrows, stack traces, diffs, test
 * failure banners, absent sentence prose) that Haiku/user-written narratives
 * don't. This check treats passthrough narratives as zero-signal for the
 * purposes of isNoiseObservation.
 *
 * @param {string} narrative
 * @returns {boolean} true = raw tool output, not substantive narrative
 */
function _isLikelyToolOutputPassthrough(narrative) {
  if (!narrative || narrative.length < 80) return false;
  // post-tool-use.sh formats entries as "cmd → output"; presence of " → " in
  // a long narrative is near-diagnostic of raw entry-desc passthrough.
  if (/ → /.test(narrative)) return true;
  // Stack-trace fingerprints that never appear in curated narratives.
  if (/\n\s+at .+:\d+:\d+/.test(narrative)) return true;
  if (/node:internal\//.test(narrative)) return true;
  // Raw diff output.
  if (/(^|\n)diff --git |(^|\n)@@ -\d/.test(narrative)) return true;
  // Test-runner failure banners.
  if (/(^|\n)\s*FAIL\s+|AssertionError|TypeError: |SyntaxError: /.test(narrative)) return true;
  // Absent sentence prose + multi-"; " is the buildImmediateObservation join signature.
  const hasSentenceBreaks = /\. [A-Z]/.test(narrative);
  const semiJoins = (narrative.match(/; /g) || []).length;
  if (!hasSentenceBreaks && semiJoins >= 2) return true;
  return false;
}

/**
 * Write-side noise filter (P0/P2). Returns true when an observation has a
 * LOW_SIGNAL title AND no recoverable downstream signal — caller should skip
 * insertion.
 *
 * Contract: a low-signal title is kept if ANY of these carry signal:
 *   - lesson_learned set and not 'none'
 *   - importance >= 2
 *   - facts has >=1 non-empty string
 *   - narrative >= 40 chars AND not raw stderr / tool-output passthrough (P2)
 *
 * Opt-out: env `CLAUDE_MEM_KEEP_LOW_SIGNAL=1` disables filter (preserves
 * pre-v2.36 behavior — every observation is inserted regardless of signal).
 *
 * @param {object} obs Observation shape: { title, facts, narrative, lessonLearned|lesson_learned, importance }
 * @param {object} [env=process.env] Environment (injected for testability)
 * @returns {boolean} true = noise, caller should drop
 */
/**
 * v2.47 P0-3: Importance cap for LOW_SIGNAL titles that slipped through with
 * inflated importance. Complements isNoiseObservation — that one drops rows
 * entirely when narrative is also thin; this one keeps the row (useful for
 * session history) but demotes the importance so injection ranking and
 * auto-compress treat it as the noise it is.
 *
 * Production baseline (2026-04-24, projects--mem DB, 3789 obs):
 *   LOW_SIGNAL title + importance=3 → 341 rows; only 1 had lesson, 1 had facts
 *   LOW_SIGNAL title + importance=2 → 80 rows;  only 5 had lesson, 6 had facts
 * 99%+ of those were Haiku-inflated noise. Cap forces imp=1 and the 7-day
 * accelerated auto-compress in hook.mjs GCs them.
 *
 * Preserves importance when ANY real signal exists:
 *   - lesson_learned (or camelCase lessonLearned) set and not 'none'
 *   - facts array has >=1 non-empty string
 * Non-LOW_SIGNAL titles are never capped (substantive prose is trusted).
 *
 * @param {object} obs { title, facts, importance, lesson_learned|lessonLearned }
 * @returns {number} Capped importance (1 if LOW_SIGNAL+no-signal, else original)
 */
export function capNoiseImportance(obs) {
  const original = obs?.importance ?? 1;
  const title = (obs && obs.title) || '';
  if (!_LOW_SIG_RE.test(title)) return original;
  const lesson = obs.lessonLearned ?? obs.lesson_learned;
  if (lesson && String(lesson).trim() && String(lesson).trim().toLowerCase() !== 'none') return original;
  if (
    Array.isArray(obs.facts) &&
    obs.facts.filter((f) => typeof f === 'string' && f.trim().length > 0).length >= 1
  ) {
    return original;
  }
  return original > 1 ? 1 : original;
}

/**
 * v2.56.0 #1: paired-gate DROP for type=change + null/short lesson + low importance.
 *
 * Pairs with capNoiseImportance (DEMOTE) per #8152's paired-gate model. The
 * existing isNoiseObservation gate is title-pattern keyed (LOW_SIGNAL regex);
 * Haiku-titled `change` obs with substantive-looking titles but no extractable
 * lesson slip through it. This gate is type+lesson keyed and catches them.
 *
 * Empirical baseline (CLAUDE.md, projects--mem): type=change has 16.5% hit-rate
 * vs decision 72.7%. type=change is 67% of recent 30d obs, and Haiku writes
 * lesson_learned=null/'none' for ~70% of curated observations (per
 * hook-llm.mjs:639 lowSignalLesson set). When *all three* hold — change type +
 * no lesson + Haiku didn't flag importance>=2 — the obs is by definition
 * low-yield and adds noise to the corpus.
 *
 * Scope: ONLY type='change'. bugfix/decision get a lesson-retry pass already
 * (hook-llm.mjs:648); feature/refactor/discovery aren't dominated by null
 * lessons in the same way.
 *
 * Opt-out: env `CLAUDE_MEM_KEEP_LOW_SIGNAL=1` disables (parity with
 * isNoiseObservation).
 *
 * @param {object} obs { type, lessonLearned|lesson_learned, importance }
 * @param {object} [env=process.env] Environment (injected for testability)
 * @returns {boolean} true = drop, caller should skip insert
 */
export function isLowYieldChangeObs(obs, env = process.env) {
  if (env && env.CLAUDE_MEM_KEEP_LOW_SIGNAL === '1') return false;
  if (!obs || obs.type !== 'change') return false;
  if ((obs.importance ?? 1) >= 2) return false;
  const lesson = obs.lessonLearned ?? obs.lesson_learned;
  const trimmed = typeof lesson === 'string' ? lesson.trim() : '';
  if (!trimmed) return true; // null / undefined / whitespace
  if (trimmed.toLowerCase() === 'none') return true; // Haiku default
  if (trimmed.length < 12) return true; // "ok" / "fixed it" / "works"
  return false;
}

export function isNoiseObservation(obs, env = process.env) {
  if (env && env.CLAUDE_MEM_KEEP_LOW_SIGNAL === '1') return false;
  const title = (obs && obs.title) || '';
  if (!_LOW_SIG_RE.test(title)) return false;

  const lesson = obs.lessonLearned ?? obs.lesson_learned;
  if (lesson && String(lesson).trim() && String(lesson).trim().toLowerCase() !== 'none') return false;

  const hasFacts =
    Array.isArray(obs.facts) &&
    obs.facts.filter((f) => typeof f === 'string' && f.trim().length > 0).length >= 1;
  if (hasFacts) return false;

  const narrative = (obs.narrative || '').trim();
  const isPassthrough = _isLikelyToolOutputPassthrough(narrative);
  const isStderrShape = /^Error[: ]/i.test(narrative);

  // v2.54.0: raw tool-output passthrough is always noise regardless of importance.
  // Rule-based importance (computeRuleImportance) can hit 2-3 from filename
  // heuristics (test/schema/migration) even when narrative is just
  // "cmd → ERROR: stderr" — 30d audit found 64 'Error: X' titles surviving via
  // imp=2 escape with raw stderr narratives. Per #8152 paired-gate model: this
  // is the drop counterpart to capNoiseImportance's demote — both must check
  // the same passthrough signal.
  if (isPassthrough || isStderrShape) return true;

  if ((obs.importance ?? 1) >= 2) return false;

  if (narrative.length >= 40) return false;

  return true;
}
