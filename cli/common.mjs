// cli/common.mjs — shared helpers used by every per-command file under cli/.
// Extracted from mem-cli.mjs (v2.41) as first step in the god-module split.
//
// Scope: pure utilities only. No DB, no imports from other cli/ files; only
// leaf utilities from `lib/` and the repo root may be pulled in (currently:
// parseIdToken, neutralizeContextDelimiters). This module is the single source
// of truth for stdout/stderr framing, arg parsing, ID-token parsing, and
// relative-time formatting — every command imports from here so the CLI stays
// consistent.

import { neutralizeContextDelimiters, neutralizeSkillDelimiters } from '../format-utils.mjs';

// ─── Argument Parsing ────────────────────────────────────────────────────────

/**
 * Parse argv-style array into { positional, flags }.
 * `--key value` → flags.key = value; `--flag` (no value) → flags.key = true.
 * `-h` → flags.help = true.
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  // Canonical flag name for a raw `--key`. Two normalizations, both aimed at the
  // same failure: a flag nobody reads is DROPPED, and the command then answers the
  // unfiltered question with no signal.
  //   1. `_` → `-`: every reader in the codebase spells multi-word flags with a
  //      hyphen (`flags['include-noise']`), so `--include_noise` was inert.
  //   2. MCP field name → CLI flag: v3.59.0 taught the CLI to accept MCP names for
  //      the required values (--content/--query/--ids) so a model can map a tool
  //      schema onto flags; the FILTER fields were left out, so `--obs_type bugfix`
  //      returned rows of every type (verified: `search redis --obs_type bugfix`
  //      surfaced the decision row that `--type bugfix` correctly excluded).
  // An explicitly-passed canonical flag always wins over its alias.
  const FLAG_ALIASES = {
    'obs-type': 'type',
    'date-from': 'from',
    'date-to': 'to',
    'date-since': 'since',
    'file-path': 'file',
  };
  const canonicalFlag = (raw) => {
    const hyphenated = raw.replace(/_/g, '-');
    return FLAG_ALIASES[hyphenated] || hyphenated;
  };
  const setFlag = (raw, value) => {
    const key = canonicalFlag(raw);
    // Alias must not clobber an explicit canonical flag; a repeated canonical flag
    // keeps last-wins (pre-existing behavior).
    if (key !== raw.replace(/_/g, '-') && flags[key] !== undefined) return;
    flags[key] = value;
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      // `--key=value` (GNU long-option form). Split on the FIRST '=' so values that
      // themselves contain '=' (e.g. `--from=2026-01-01`, a token with '=') stay intact.
      // Without this, `--type=feature` parsed as a boolean flag literally named
      // "type=feature"; the real `--type` stayed undefined and the default silently
      // applied — a save landed in the wrong project / type with no error.
      const eq = body.indexOf('=');
      if (eq >= 0) {
        setFlag(body.slice(0, eq), body.slice(eq + 1));
        i++;
        continue;
      }
      const key = body;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && (!next.startsWith('-') || /^-\d/.test(next))) {
        setFlag(key, next);
        i += 2;
      } else {
        setFlag(key, true);
        i++;
      }
    } else if (arg === '-h') {
      flags.help = true;
      i++;
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags: trackFlagReads(flags) };
}

// ─── Inert selection flags ───────────────────────────────────────────────────
//
// The third cause of the harm parseArgs' docblock names twice. `--include_noise` (underscore
// spelling) and `--obs_type` (an MCP field name) both parsed, matched no reader, and let the
// command answer the unfiltered question; both are fixed above. `suggestUnknownFlags` fixes a
// third case, flags unknown to the whole CLI. What is left is the case where NOTHING is
// misspelled: `--type` is canonical and real — on `search`, `save` and `export` — so it clears
// the global known-flag set, and `browse` simply never reads it. Measured before the fix:
// `browse --type bugfix` printed rows of every type, exit 0, not a word.
//
// The check is read-tracking, not a per-command flag manifest, and that is the whole design.
// A manifest rots, and worse, it cannot see a flag that a command forwards wholesale into a
// core helper (`cmdSearch` hands the object to the pipeline, `cmdExport` to the writer) —
// deriving "which flags does this command read" from its own body would fire on every one of
// those. Watching what the object is actually ASKED for is exact in both directions.
//
// Scope is SELECTION-shaped flags only. Those are the ones whose silent drop hands back a
// wider set that reads as the answer, which is the harm. A `--confirm` that a short-circuited
// branch never reached is deliberately out of scope: nothing there is wrong, and a warning on
// correct usage is worse than the silence it replaces.
//
// `prompts-limit` is NOT here, and the reason generalises: `doctor --benchmark --prompts-limit`
// is read off raw `process.argv` in cli/doctor.mjs and never touches a flags object, so
// read-tracking would call a working flag inert. Anything read off argv must stay out.
export const FILTER_FLAGS = new Set([
  'type',
  'source',
  'project',
  'tier',
  'since',
  'from',
  'to',
  'branch',
  'scope',
  'importance',
  'limit',
  'offset',
  'sort',
  'days',
  'age-days',
  // Inclusion toggles, added after the same correct-usage sweep the first batch passed. They
  // widen or narrow the SET rather than filter within it, and the harm runs the other way:
  // an ignored `--include-noise` hands back FEWER rows than asked for, and "I searched and it
  // was not there" is the worst answer a memory tool can give. Held back at first only
  // because booleans are read inside branches and were the likelier false-alarm shape; the
  // exit-code gate below turned out to cover that class, and the sweep reads zero.
  'all',
  'include-noise',
  'include-compressed',
  'deep',
  'no-deep',
  'or',
  'rerank',
]);

let suppliedFlags = new Set();
let readFlags = new Set();

/**
 * Wrap a parsed flags object so every lookup is recorded.
 *
 * `get` and `has` are both trapped: a reader spelled `if ('tier' in flags)` must count as a
 * read exactly like `flags.tier`. `ownKeys` deliberately is NOT — `Object.keys(flags)` is
 * enumeration, not consumption, and `suggestUnknownFlags` does exactly that on its own parse.
 */
function trackFlagReads(flags) {
  for (const k of Object.keys(flags)) suppliedFlags.add(k);
  return new Proxy(flags, {
    get(target, prop, recv) {
      if (typeof prop === 'string') readFlags.add(prop);
      return Reflect.get(target, prop, recv);
    },
    has(target, prop) {
      if (typeof prop === 'string') readFlags.add(prop);
      return Reflect.has(target, prop);
    },
  });
}

/** Start a fresh recording. `run()` calls this per invocation so tests can drive it in a loop. */
export function resetFlagTracking() {
  suppliedFlags = new Set();
  readFlags = new Set();
}

/**
 * Selection flags the user supplied that nothing looked at, sorted.
 *
 * Read AFTER the command has finished — a flag consumed late (inside a branch, or by a helper
 * the command awaits) has still been read, and reporting it early would be a false alarm.
 * @returns {string[]}
 */
export function inertFilterFlags() {
  return [...suppliedFlags].filter((f) => FILTER_FLAGS.has(f) && !readFlags.has(f)).sort();
}

/**
 * The sentence the user gets. Says what happened to their results, not what the parser did:
 * "ignored" alone leaves them to work out whether the output is still the answer they asked
 * for. It is not.
 * @param {string} cmd
 * @param {string[]} inert
 * @returns {string}
 */
export function inertFilterFlagNotice(cmd, inert) {
  const names = inert.map((f) => `--${f}`).join(' and ');
  const verb = inert.length > 1 ? 'were' : 'was';
  return (
    `[mem] ${names} ${verb} ignored — \`${cmd}\` does not filter on ${inert.length > 1 ? 'them' : 'it'}, ` +
    `so the results above are UNFILTERED. Run "claude-mem-lite help" for the flags this command reads.`
  );
}

// ─── Output Helpers ──────────────────────────────────────────────────────────

/**
 * Write a line to stdout, with structural context delimiters neutralized.
 *
 * CLI stdout IS model context, not just a human channel: commands/mem.md routes
 * `/mem search|get|recall|timeline` to `node cli.mjs … via Bash`, and
 * buildServerInstructions actively tells the agent the Bash CLI is the CHEAPER path
 * than the MCP tool. The MCP read family has been defanged since v3.61 at its own
 * chokepoint (server.mjs safeHandler), but the CLI twins printed stored text raw —
 * so the exact indirect-prompt-injection channel the MCP defang closes stayed open on
 * the surface the instructions recommend (audit 2026-08-14 A1). Observations are
 * stored raw on purpose (defense lives at the injection boundary, not at save), so it
 * has to happen here, at the write.
 *
 * `out` is the single stdout writer for every command in mem-cli.mjs and cli/*.mjs,
 * so a NEW read command is covered by construction (§9 parallel-path completeness).
 * Payloads that must round-trip byte-exact use `outVerbatim` instead — see below.
 * The transform is idempotent (it strips brackets, it does not re-add them), so a
 * path that already defanged upstream — `context` → buildSessionContextLines — is
 * unaffected.
 *
 * `<skill-loaded>` is neutralized here too (audit 2026-09-05 R6 P1-2). It is deliberately
 * OFF CONTEXT_DELIMITER_RE so the MCP `mem_use` load path can emit a real wrapper — but no
 * CLI command emits one, while `registry search|list` DOES print third-party registry names
 * (a GitHub frontmatter name, or `import --name`, which applies no charset filter). A crafted
 * name therefore forged a complete skill block out of nothing in ordinary CLI output. The MCP
 * twin closes the same hole at its own chokepoint (server.mjs defangResult); doing it on one
 * face only is this repo's first-listed defect class.
 */
export function out(text) {
  // String() first: the neutralizers coerce nullish to '', which would turn a pre-existing
  // `out(undefined)` line from "undefined" into an empty line.
  outVerbatim(neutralizeSkillDelimiters(neutralizeContextDelimiters(String(text))));
}

/**
 * Write a line to stdout with NO defang. The CLI mirror of
 * `safeHandler(fn, { verbatim: true })` on the MCP side, and for the same single
 * reason: `export` is the backup half of backup/restore, so neutralizing its payload
 * would silently rewrite every backed-up row whose text legitimately contains these
 * tags — and `restore` would write the rewritten text back. Only use this for bytes
 * that must survive a round trip; anything a model reads goes through `out`.
 */
export function outVerbatim(text) {
  process.stdout.write(text + '\n');
}

/** Write a line to stderr and mark process for non-zero exit. */
export function fail(text) {
  process.stderr.write(text + '\n');
  process.exitCode = 1;
}

/**
 * Reject value-less `--flag` for string-valued flags. A bare trailing flag (or one
 * immediately followed by another `--flag`) parses to boolean `true` (parseArgs above);
 * that `true` then slips into code expecting a string and surfaces a raw
 * `flags.x.split is not a function` / `SQLite3 can only bind ...` stacktrace (#8470).
 * Returns true (and emits a clean `fail()`) when any listed key is a bare flag — the
 * caller should `return` on true. Single source of the guard the update/registry paths
 * previously inlined, so new string-flag commands stay consistent.
 *
 * @param {object} flags Parsed flags from parseArgs.
 * @param {string[]} keys String-valued flag names to guard (without leading dashes).
 * @returns {boolean} true if a bare flag was found and rejected.
 */
export function rejectBareStringFlags(flags, keys) {
  for (const key of keys) {
    if (flags[key] === true) {
      fail(`[mem] --${key} requires a value (received a bare flag with no value).`);
      return true;
    }
  }
  return false;
}

/**
 * Resolve a required value that may arrive positionally or via an MCP-field flag alias.
 * LLM callers map the MCP tool schema onto flags (#233): mem_save.content → `--content`,
 * mem_defer.title → `defer add --title`, mem_search.query → `--query`, mem_get.ids →
 * `--ids` — each previously fell to a stderr-only usage line that a `2>/dev/null`
 * caller reads as "CLI doesn't support this".
 *
 * Returns the resolved string ('' when neither shape is present — caller emits its own
 * usage). On ambiguity (positional AND an alias, or two aliases at once) emits fail()
 * and returns null — caller must `return` on null. Bare alias flags (boolean true) are
 * ignored here; guard them with rejectBareStringFlags BEFORE calling.
 *
 * @param {string} positionalStr Joined positional tokens (caller picks the separator).
 * @param {object} flags Parsed flags from parseArgs.
 * @param {string[]} aliasKeys Alias flag names, first match wins (without dashes).
 * @returns {string|null} Resolved value, or null after a conflict fail().
 */
export function resolvePositionalAlias(positionalStr, flags, aliasKeys) {
  const given = aliasKeys.filter((k) => typeof flags[k] === 'string' && flags[k].trim() !== '');
  if (given.length > 1) {
    fail(`[mem] Both --${given[0]} and --${given[1]} provided — pass the value once.`);
    return null;
  }
  const flagVal = given.length === 1 ? flags[given[0]] : '';
  if (positionalStr.trim() !== '' && flagVal.trim() !== '') {
    fail(`[mem] Value given both positionally and via --${given[0]} — pass it once.`);
    return null;
  }
  return positionalStr.trim() !== '' ? positionalStr : flagVal;
}

// ─── Unknown-flag typo guard ─────────────────────────────────────────────────

/**
 * Union of every flag name any CLI command reads (parseArgs silently drops the rest).
 * Over-inclusive BY DESIGN: a flag listed here that a given command ignores just means
 * "no typo warning for it" — harmless. The only real risk is OMITTING a valid flag, and
 * the edit-distance gate in suggestUnknownFlags() makes even that non-fatal (a distinct
 * real flag rarely lands within distance 2 of another). Add new flags here when adding
 * them to a command — same maintenance contract as JSON_SUPPORTED_CMDS in mem-cli.
 */
export const KNOWN_CLI_FLAGS = new Set([
  'after',
  'age-days',
  'all',
  'anchor',
  'before',
  'benchmark',
  'body',
  'branch',
  'chars',
  'closes-deferred',
  'concepts',
  'confirm',
  'days',
  'deep',
  'detail',
  'dry-run',
  'execute',
  'fields',
  'file',
  'files',
  'force',
  'format',
  'from',
  'help',
  'id',
  'ids',
  'content',
  'importance',
  'include-compressed',
  'include-noise',
  'json',
  'key',
  'lesson',
  'lesson-learned',
  'limit',
  'max',
  'memdir',
  'merge-ids',
  'metrics',
  'name',
  'narrative',
  'no-deep',
  'offset',
  'ops',
  'or',
  'priority',
  'project',
  'quality',
  'query',
  'reason',
  'rerank',
  'retain-days',
  'retry',
  'run',
  'run-all',
  'scope',
  'search-telemetry',
  'session-audit',
  'sidechain',
  'since',
  'sort',
  'source',
  'status',
  'task',
  'text',
  'tier',
  'title',
  'to',
  'type',
  'verbose',
  // Catalogued 2026-08-13 when suggestUnknownFlags started reporting EVERY unknown
  // flag: these are real, code-read flags that the old edit-distance gate happened to
  // stay silent about (`adopt --disable/--enable`, `activity --min-importance`,
  // `save --supersedes`). Verified by running each command and checking for a warning.
  'disable',
  'enable',
  'min-importance',
  'supersedes',
  // `doctor --benchmark --prompts-limit N` — read off raw argv in cli/doctor.mjs, so
  // it never appeared in a `flags.x` grep. Caught by independent review after the
  // warn-on-every-unknown-flag flip turned the omission into a false warning on a
  // documented, working command.
  'prompts-limit',
  // `verify-apply --apply --digest <d>` / `--undo <backup>` — read as flags.apply / .digest / .undo in
  // cli/verify-apply.mjs. Missing here, a working apply printed "Unknown flag --apply — ignored,
  // it had no effect" beside its own read-back. Pinned by tests/verify-apply-cli.test.mjs.
  'apply',
  'digest',
  'print-project',
  'undo',
  // Entries here MUST be read by a `claude-mem-lite` subcommand. A flag that no
  // command reads is worse than an absent one: it converts the "ignored, it had no
  // effect" warning into silence, so the user's dropped flag reads as accepted.
  // `out` sat here until the 2026-08-17 e2e round for that exact reason: `--out` is a
  // benchmark-script flag (benchmark/longmemeval-rerank.mjs), never a CLI one, so
  // `export --out backup.json` printed the whole export to stdout and said nothing
  // about the file it did not write. `has` went the same round: no reader, no help
  // entry, and (per the v3.34.0 notes) the source of the misleading "did you mean
  // --has?" suggestion. Locked by tests/cli-flag-allowlist.test.mjs.
]);

/**
 * Flags exactly ONE subcommand reads, mapped to that command. KNOWN_CLI_FLAGS is a union, so
 * without this `recent --apply` was accepted in silence while `--apply` did nothing there.
 * Every other command mem-cli dispatches now reports such a flag, and the typo suggester stops
 * offering it there. Install-family commands (doctor, status, …) route to install.mjs and are
 * not covered. Only flags with a single reader
 * belong here; tests/cli-flag-allowlist.test.mjs derives that from the sources.
 */
export const COMMAND_SCOPED_FLAGS = new Map([
  ['apply', 'verify-apply'],
  ['chars', 'context'],
  ['digest', 'verify-apply'],
  ['print-project', 'verify-apply'],
  ['search-telemetry', 'stats'],
  ['undo', 'verify-apply'],
]);

/** Levenshtein distance, early-exit past `max` (cheap enough for a handful of flags). */
function editDistance(a, b, max = 2) {
  const m = a.length,
    n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1; // whole row already past budget → give up
    prev = cur;
  }
  return prev[n];
}

/**
 * Detect likely-typo flags: names NOT in KNOWN_CLI_FLAGS but within edit distance 2 of
 * a known flag. parseArgs silently drops unknown flags, so `save --improtance 3` used to
 * persist the DEFAULT importance and `recent --projcte X` silently queried the inferred
 * project — a typo produced a wrong result with zero signal. Returns [{flag, suggestion}].
 * Unknown flags with NO close match are omitted: they may be a valid flag we didn't
 * catalog, so silence beats a false alarm. Warning-only by contract — never fails.
 * A flag in COMMAND_SCOPED_FLAGS given to any other `cmd` is reported too, with `owner` set.
 * @param {object} flags Parsed flags from parseArgs.
 * @param {string} [cmd] The subcommand being run; without it scoped flags are not checked.
 * @returns {Array<{flag: string, suggestion: string|null, owner?: string}>}
 */
export function suggestUnknownFlags(flags, cmd) {
  const result = [];
  for (const key of Object.keys(flags)) {
    const owner = COMMAND_SCOPED_FLAGS.get(key);
    if (cmd && owner && owner !== cmd) {
      result.push({ flag: key, suggestion: null, owner });
      continue;
    }
    if (!key || KNOWN_CLI_FLAGS.has(key)) continue;
    let best = null,
      bestDist = 3;
    for (const known of KNOWN_CLI_FLAGS) {
      const knownOwner = COMMAND_SCOPED_FLAGS.get(known);
      if (cmd && knownOwner && knownOwner !== cmd) continue;
      const d = editDistance(key, known);
      if (d < bestDist) {
        bestDist = d;
        best = known;
      }
    }
    // Report EVERY unknown flag; the suggestion is a bonus when a near-miss exists.
    // Previously an unknown flag with no neighbour within distance 2 produced no
    // output at all — the silent case, and the dangerous one: `--obs_type bugfix`
    // (distance 4 from `type`) parsed, matched no reader, and the command answered
    // the unfiltered question. A dropped filter that looks applied is worse than a
    // typo, because the wider result set reads as the answer.
    result.push({ flag: key, suggestion: best && bestDist <= 2 ? best : null });
  }
  return result;
}

// ─── Time Formatting ─────────────────────────────────────────────────────────

/** "just now" / "5m ago" / "3h ago" / "2d ago" relative to now. */
export function relativeTime(epochMs) {
  const diff = Date.now() - epochMs;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** ISO date string → "YYYY-MM-DD" prefix. */
export function fmtDateShort(iso) {
  if (!iso) return '';
  return iso.slice(0, 10);
}

// Integer epoch-ms time fields on the observations table that `get`/`mem_get`
// render. Shared by the CLI (mem-cli.mjs) and the MCP server (server.mjs) so the
// two `get` paths can't drift — pre-2.97 the MCP path printed bare ms
// (`last_accessed_at: 1781024049720`) while the CLI showed `<ms> (<relative>)`,
// because the formatter lived only in mem-cli.mjs.
export const OBS_TIME_FIELDS = ['superseded_at', 'last_accessed_at'];

// Display labels for observation columns whose NAME misdescribes their contents.
// `files_modified` holds whatever file list the writer attached: hook-captured rows fill
// it from Edit/Write, but an explicit mem_save / `save --files` puts any associated path
// there — including a file that was only read. Rendering the raw column name told the
// reader those files were modified (audit 2026-08-14 F3). The label is `files` — the name
// of the input parameter that fills it. The COLUMN is untouched, so `--fields
// files_modified` / `fields:["files_modified"]` still select it. Shared by the CLI `get`
// and MCP `mem_get` renderers so the two cannot drift.
const OBS_FIELD_LABELS = { files_modified: 'files' };

/** Reader-facing label for an observation column (identity for everything unmapped). */
export function obsFieldLabel(field) {
  return OBS_FIELD_LABELS[field] || field;
}

/**
 * The `maintain scan` pending-purge line, shared by the CLI (mem-cli.mjs cmdMaintain) and
 * the MCP mem_maintain handler (server.mjs) so the two cannot drift — same reason
 * obsFieldLabel lives here.
 *
 * The count is `compressed_into = COMPRESSED_PENDING_PURGE` (lib/maintain-core.mjs:443),
 * and the ONLY writers of that sentinel are the two idle/decay passes — decayAndMarkIdle
 * (maintain-core.mjs:201) and runIdleCleanup (search-scoring.mjs:303). Compression writes
 * COMPRESSED_AUTO (-1) or a positive parent id, and those rows are NOT counted. The CLI
 * used to render this as "compressed originals awaiting cleanup", which told an operator
 * about to run `maintain execute --ops purge_stale --confirm` that they were deleting
 * compression leftovers when they were deleting decay-marked live originals (audit
 * 2026-08-14 A4). Say what the rows are and what deletes them — and say nothing about
 * compression, which is a different sentinel with a different lifecycle.
 *
 * @param {number} n stats.pendingPurge
 * @returns {string} the full indented line, identical on both surfaces.
 */
export function formatPendingPurgeLine(n) {
  return `  Pending purge (idle-marked): ${n} (rows maintenance queued: hidden and still idle 7 days later, or queued by an earlier version — purge_stale deletes them)`;
}

/**
 * D12: the step before pending-purge. Maintenance HIDES an idle row first (kept, reachable by
 * id) and queues it for purge only once it stays idle through the grace.
 * @param {number} n stats.hidden
 * @returns {string} the full indented line, identical on both surfaces.
 */
export function formatHiddenLine(n) {
  return `  Hidden by maintenance: ${n} (idle rows kept for 7 days; still idle then → pending purge)`;
}

// Pure formatter — null/undefined/non-time pass through; integer time fields
// render as `<raw> (<relative>)` so callers get both an audit value and a
// human/LLM-scannable hint, mirroring `recent`/`timeline`/`recall`.
export function formatObsFieldValue(field, val) {
  if (val === null || val === undefined) return val;
  if (OBS_TIME_FIELDS.includes(field) && typeof val === 'number') {
    return `${val} (${relativeTime(val)})`;
  }
  return val;
}

// ─── ID Token Parsing ────────────────────────────────────────────────────────
// Re-exported from lib/id-routing.mjs so CLI and MCP (server.mjs) share a single
// parser — parity per #8050. Keep this re-export for back-compat with the
// 5 CLI call sites that already import parseIdToken from cli/common.mjs.
export { parseIdToken } from '../lib/id-routing.mjs';

/**
 * Format the shared `probeIdSources` output as CLI hint strings.
 * Example: ["#5419 (obs)", "P#5417 (prompt)"] — callers join with "; ".
 */
export function formatProbeHints(probe) {
  const hints = [];
  if (probe.obs.length > 0) hints.push(`#${probe.obs.join(', #')} (obs)`);
  if (probe.session.length > 0) hints.push(`S#${probe.session.join(', S#')} (session)`);
  if (probe.prompt.length > 0) hints.push(`P#${probe.prompt.join(', P#')} (prompt)`);
  if (probe.event?.length > 0) hints.push(`E#${probe.event.join(', E#')} (event)`);
  return hints;
}
