// Numeric environment overrides with an explicit failure mode.
//
// The idiom this replaces — `Number(process.env.X || DEFAULT)` — has no failure
// mode at all: `Number('abc')` is NaN, and NaN then propagates into whatever the
// constant feeds. Nothing throws and nothing is logged, so the surface degrades
// SILENTLY and in a direction that depends on the consumer. Measured on the six
// UPS knobs (2026-09-04, node probe against the shipped consumers):
//
//   CLAUDE_MEM_UPS_MAX_RESULTS=abc          rows.slice(0, NaN) === []
//                                           → the whole FTS injection face goes dark
//   CLAUDE_MEM_UPS_PROMPT_FALLBACK_LIMIT=abc  `LIMIT ?` bound with NaN
//                                           → SqliteError: datatype mismatch
//   CLAUDE_MEM_UPS_TOP_MIN=abc              `Math.abs(rel) < NaN` is false
//                                           → the set-level noise floor stops firing
//   CLAUDE_MEM_UPS_OR_BM25_MIN=abc          `orFloor > 0` is false
//                                           → the OR-fallback floor stops firing
//
// So one typo either silences the face or disables the gates that keep it quiet,
// and the two are indistinguishable from outside. `lib/cli-flags.mjs` already
// solved the same problem for CLI flags (warn once on stderr, fall back to the
// documented default); this is that contract for the env side.
//
// `Number`, not `parseInt`: the floors here are written in scientific notation
// (1e-5, 5e-6) and `parseInt('1e-5')` is 1 — a 100000x silent misparse, i.e. the
// exact class of defect this module exists to remove.

const DEFAULT_WARN = (msg) => {
  // stderr is safe from every hook face: the host reads a command hook's stdout as
  // its envelope and only surfaces stderr on a failure/blocked path, so a warning
  // here can never corrupt an injection (lib/hook-stdout.mjs).
  try { process.stderr.write(msg); } catch { /* never block on a warning */ }
};

/**
 * Parse a numeric env override, falling back to `defaultValue` with a stderr
 * warning on anything that is not a finite in-range number.
 *
 * Unset and empty-string both mean "not configured" and fall back SILENTLY —
 * `CLAUDE_MEM_X=` is how a shell unsets a value it inherited, not a mistake.
 *
 * An explicit `0` is honoured whenever the range admits it. Which idiom swallowed a 0 is
 * worth stating precisely, because a v3.94.0 draft got it backwards in two places:
 *
 *   Number(env.X || D)   with X='0'  ->  0   — SAFE. `process.env.X` is a STRING and
 *                                             `'0'` is truthy; only `''` is falsy.
 *   Number(env.X) || D   with X='0'  ->  D   — BROKEN. Parse first, then fall back.
 *
 * So the knobs that were unreachable at 0 are the parse-then-fallback ones,
 * `CLAUDE_MEM_CITE_NUDGE_THRESHOLD` and `CLAUDE_MEM_CITE_NUDGE_MIN_INJECTED`
 * (lib/cite-back-hint.mjs), NOT the folded UPS floors.
 *
 * Shape is decided by `Number` + `Number.isFinite` rather than a regex: that
 * rejects trailing garbage ('2abc'), whitespace-only, and Infinity, while
 * accepting the scientific-notation form the callers' own defaults use.
 *
 * @param {string|number|undefined|null} raw Raw env value (pass `env.NAME`, not the name).
 * @param {object} opts
 * @param {string} opts.name Env var name, for the warning text.
 * @param {number} opts.defaultValue Value used when unset or invalid.
 * @param {number} [opts.min=-Infinity] Inclusive lower bound.
 * @param {number} [opts.max=Infinity] Inclusive upper bound.
 * @param {boolean} [opts.integer=false] Reject non-integers (e.g. row caps, SQL LIMITs).
 * @param {(msg: string) => void} [opts.warn] Test seam — defaults to process.stderr.write.
 * @returns {number} A finite number in [min, max], or `defaultValue`.
 */
export function envNumber(raw, opts) {
  const {
    name, defaultValue, min = -Infinity, max = Infinity, integer = false,
    warn = DEFAULT_WARN,
  } = opts;

  if (raw === undefined || raw === null) return defaultValue;
  const str = String(raw).trim();
  if (str === '') return defaultValue;

  const n = Number(str);
  const ok = Number.isFinite(n)
    && (!integer || Number.isInteger(n))
    && n >= min && n <= max;

  if (!ok) {
    const bound = describeRange(min, max, integer);
    warn(`[mem] Invalid ${name}="${raw}" (${bound}); using default ${defaultValue}\n`);
    return defaultValue;
  }
  return n;
}

/**
 * Human-readable statement of what the value had to be. Split out so the warning
 * text is derived from the SAME bounds the check used — a hand-written message
 * drifts from its predicate on the first bound change.
 *
 * @param {number} min
 * @param {number} max
 * @param {boolean} integer
 * @returns {string}
 */
function describeRange(min, max, integer) {
  const kind = integer ? 'an integer' : 'a number';
  if (min === -Infinity && max === Infinity) return `must be ${kind}`;
  if (max === Infinity) return `must be ${kind} >= ${min}`;
  if (min === -Infinity) return `must be ${kind} <= ${max}`;
  return `must be ${kind} between ${min} and ${max}`;
}
