// lib/schema-skew.mjs — the DB is NEWER than the code trying to open it.
//
// schema.mjs's forward-incompat guard has thrown on this for a long time and the throw is
// correct: an old binary that re-applied old migrations over a newer layout would corrupt
// the store. What was missing is everything downstream of the throw.
//
// Measured 2026-09-08 on a plugin-mode machine: DB v49, live plugin cache 5.6.0 (supports
// v48). Every `openDb()` threw, `hook-shared` logged each one, and the day's
// runtime/hook-errors/*.jsonl held >=648 copies of one sentence and was still growing. The
// MCP server died before its handshake, so the host showed `-32000 Connection closed`. And
// hook.mjs's `const db = openDb(); if (!db) return;` made SessionStart return in silence.
// Nothing the user could see said "your memory is version-skewed".
//
// Two design points that are easy to get wrong, both of which this repo has paid for before:
//
//   • THE REMEDY IS SHAPE-DEPENDENT. The thrown message says
//     `npm i -g claude-mem-lite@latest`. That is right for a managed/npm install and inert
//     for a plugin-cache install — which is the shape that actually hits this, because the
//     cache only advances when Claude Code's marketplace updater advances it, so it lags
//     anything else that opened the DB. A repair that cannot work is worse than silence:
//     the user runs it, sees success, and stops looking.
//
//   • THREE OUTCOMES, NEVER TWO. "this home can open the DB" and "I could not determine
//     what this home supports" must never print in the same voice. The v6.2.0 round WROTE a
//     doctor check that answered "no hook command needs bash" on the one install shape where
//     they are live, because a missing file read as a zero count — and its pre-ship review
//     caught it before the tag (`f5e1786`), so it never shipped. Read that as the precedent
//     it is: the defect is easy to write and invisible to unit tests. `status: 'unknown'`
//     exists so it cannot be written here.
//
// This module is shared by hook-shared.mjs, hook.mjs, install.mjs (doctor) and
// scripts/launch.mjs, so per the project's own rule it lives in lib/ and is registered in
// BOTH source-files.mjs and package.json#files.
//
// It deliberately does NOT import better-sqlite3 at module scope: two of its consumers run
// on paths where the native binding may be the thing that is broken, and a classifier that
// cannot load is a classifier that cannot report. The only DB access here happens inside a
// child process (probeSchemaCompatInFreshProcess).

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { shouldRecordOnce } from './record-once.mjs';

/** Machine-readable marker set by schema.mjs on the forward-incompat throw. */
export const SCHEMA_SKEW_CODE = 'CLAUDE_MEM_SCHEMA_TOO_NEW';

// PER PROJECT. The first version of this dedup used one marker file for the whole data dir,
// keyed on a per-project session id — so two projects sharing ~/.claude-mem-lite overwrote
// each other's key and every fire recorded again. Measured by review: 8 fires across 2
// projects → 8 records; the same 8 fires in 1 project → 1. The flood this exists to stop was
// therefore unfixed for exactly the multi-project machine that produced it.
export const SKEW_MARKER_PREFIX = '.schema-skew-logged-';

// Skew persists until the user installs newer code, so "record it once" would be defensible.
// An hour is the compromise: the log's remaining job is forensic ("when did this start, is it
// still happening"), and ≤24 lines/day/project answers that at a cost the 727-in-one-day
// measurement makes look free.
export const SKEW_RELOG_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Should this skew be written to the hook-error log, or has it been recorded recently?
 *
 * TOTAL — every path returns a boolean, nothing escapes. That is a hard requirement, not
 * defensiveness: callers invoke this from inside a DB-open failure handler, and `openDb()`'s
 * contract is to return null and never throw. The first version called `getSessionId()` here,
 * which is not a read — it MINTS and writes a session id — so an unwritable runtime dir
 * (EROFS, ENOSPC, a dismounted CLAUDE_MEM_DIR) made the catch block itself throw. Two-arm
 * proof at the time: HEAD threw ENOTDIR where the previous build returned null.
 *
 * Fails toward RECORDING: an unreadable or unwritable marker must never silence the log.
 *
 * @param {string} runtimeDir
 * @param {string} project Marker scope; anything falsy collapses to one shared file.
 * @param {{dbVersion?: number|null, binaryVersion?: number|null}|null} info
 * @param {{now?: number, intervalMs?: number}} [opts]
 * @returns {boolean}
 */
export function shouldRecordSkew(runtimeDir, project, info, opts = {}) {
  // The body moved to lib/record-once.mjs when a second unhealable DB-open family needed the
  // same dedup; this signature and its key derivation stay here because they are skew's, not
  // the generic helper's. A changed version pair always re-records: a PARTIAL upgrade (the
  // binary moves v48→v49 while the DB moves to v50) is new information, not the fault already
  // logged.
  // The key derivation is INSIDE a try because this function's contract is TOTAL and the
  // extraction briefly lost that: `info` reaches here from a catch block, and a property
  // getter or `toString` that throws would have propagated out of `openDb()`'s catch — the
  // same shape as the `getSessionId()` incident this module's header cites. Unreachable from
  // today's two callers (both pass a plain object or null); restored anyway, because the
  // sentence at hook-shared.mjs's call site asserts the property, not the reachability.
  let key;
  try {
    key = `${info?.dbVersion ?? '?'}:${info?.binaryVersion ?? '?'}`;
  } catch {
    key = '?:?';
  }
  return shouldRecordOnce(runtimeDir, SKEW_MARKER_PREFIX, project, key, {
    intervalMs: SKEW_RELOG_INTERVAL_MS,
    ...opts,
  });
}

// The shipped message, which older builds throw with no code field at all. Kept as a
// fallback classifier so this module can still recognise a skew raised by code that
// predates SCHEMA_SKEW_CODE — the interesting direction, since skew means old code.
const SKEW_MESSAGE_RE = /DB schema is v(\d+) but this claude-mem-lite binary supports up to v(\d+)/;
const SKEW_MESSAGE_LOOSE_RE = /DB schema is v\d+/;

/**
 * True when `err` means "this DB was written by a newer claude-mem-lite".
 *
 * Accepts anything thrown (Error, string, null) because recordHookError does.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isSchemaSkewError(err) {
  if (!err) return false;
  if (err.code === SCHEMA_SKEW_CODE) return true;
  return SKEW_MESSAGE_LOOSE_RE.test(String(err.message ?? err ?? ''));
}

/**
 * The two version numbers, from the error's own fields when present and from its message
 * otherwise. Null when this is not a skew error, or when neither source carries numbers.
 *
 * @param {unknown} err
 * @returns {{dbVersion: number, binaryVersion: number}|null}
 */
export function schemaSkewFromError(err) {
  if (!err) return null;
  if (typeof err.dbVersion === 'number' && typeof err.binaryVersion === 'number') {
    return { dbVersion: err.dbVersion, binaryVersion: err.binaryVersion };
  }
  const m = SKEW_MESSAGE_RE.exec(String(err.message ?? err ?? ''));
  if (!m) return null;
  return { dbVersion: Number(m[1]), binaryVersion: Number(m[2]) };
}

/** Same directory, tolerating symlinks — a plugin cache root reaches callers both ways. */
function samePath(a, b) {
  if (!a || !b) return false;
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Both halves are needed and the order matters: the local marketplace clone is what Claude
 * Code compares against, so an outdated clone makes `/plugin update` a no-op that reports
 * success. Measured 2026-09-08: the clone sat 22 commits behind while npm and GitHub already
 * carried the version that owned the DB.
 */
function pluginRemedy(activePluginVersion, marketplace, plugin) {
  return {
    kind: 'plugin',
    commands: [`/plugin marketplace update ${marketplace}`, `/plugin update ${plugin}@${marketplace}`],
    note: `Run both in Claude Code, then restart it. Plugin cache is at v${activePluginVersion.version}.`,
  };
}

/**
 * Which command actually repairs this machine — or, when `root` is given, the tree that is
 * actually behind. Pass `root` whenever you know it; the machine's global shape is the
 * fallback, and on a mixed install it is the wrong answer.
 *
 * @param {{managed?: boolean, activePluginVersion?: {version: string}|null, dev?: boolean, marketplace?: string, plugin?: string}} shape
 * @returns {{kind: 'dev'|'plugin'|'managed'|'unknown', commands: string[], note: string}}
 */
export function schemaSkewRemedy({
  managed = false,
  activePluginVersion = null,
  dev = false,
  root = null,
  marketplace = 'sdsrss',
  plugin = 'claude-mem-lite',
} = {}) {
  // THE ROOT WINS when the caller knows which tree is behind. A machine can hold a managed
  // install AND a plugin cache at once, and `hasManagedCodeInstall` is true for a dev
  // checkout too (existsSync follows symlinks). Deciding from the machine's global shape
  // then printed `claude-mem-lite self-update` under a line reading "the code running here
  // (plugin cache v5.6.0)" — neither command advances a plugin cache. That is verbatim the
  // failure this module's header calls its reason to exist, reproduced end to end by review
  // on the exact version pair from the motivating measurement.
  if (root && activePluginVersion?.root && samePath(root, activePluginVersion.root)) {
    return pluginRemedy(activePluginVersion, marketplace, plugin);
  }
  // Dev next: a checkout's files are symlinked or git-managed, so every other remedy would
  // overwrite the user's working tree.
  if (dev) {
    return {
      kind: 'dev',
      commands: ['git pull'],
      note: 'This is a development checkout — something newer than this working tree opened the DB.',
    };
  }
  if (activePluginVersion && !managed) {
    return pluginRemedy(activePluginVersion, marketplace, plugin);
  }
  if (managed) {
    return {
      kind: 'managed',
      commands: ['claude-mem-lite self-update'],
      note: 'Or reinstall with: npm i -g claude-mem-lite@latest',
    };
  }
  // Not "nothing to do" — "I could not tell". Name both places that were consulted so the
  // reader knows where to look rather than assuming the check found nothing wrong.
  return {
    kind: 'unknown',
    commands: [],
    note: 'Could not identify this install: no managed code install in ~/.claude-mem-lite and no active plugin cache version. Run `claude-mem-lite doctor` from the install you actually use.',
  };
}

/**
 * The user-facing block. Kept short on purpose — at SessionStart it shares one stdout
 * envelope with the startup dashboard and the `<claude-mem-context>` block.
 *
 * @param {{dbVersion: number|null, binaryVersion: number|null, remedy: ReturnType<typeof schemaSkewRemedy>, codeHome?: string}} info
 * @returns {string}
 */
export function formatSchemaSkewNotice({ dbVersion, binaryVersion, remedy, codeHome }) {
  const where = codeHome ? ` (${codeHome})` : '';
  const lines = [
    '⚠️ [claude-mem-lite] Memory is OFF: this database was written by a newer version.',
    `   DB schema v${dbVersion ?? '?'}; the code running here${where} supports up to v${binaryVersion ?? '?'}.`,
  ];
  for (const c of remedy.commands) lines.push(`   ${c}`);
  if (remedy.note) lines.push(`   ${remedy.note}`);
  lines.push('   Until then, saves and recall are disabled. Your stored memories are intact.');
  return lines.join('\n');
}

/**
 * The child-process source for one code home. Exported so a test can pin the contract
 * without spawning, and so the string is reviewable in isolation.
 *
 * Both paths are ASKED, never derived: the supported version comes from importing that
 * home's own schema.mjs, and the DB version from opening the DB with that home's own
 * better-sqlite3. Parsing `export const CURRENT_SCHEMA_VERSION = \d+` out of the file
 * would be the same mistake as naming the native addon's path instead of asking
 * lib/binding.js for it — a literal that goes stale silently.
 *
 * The payload is BRACKETED. Importing another tree's schema.mjs runs that tree's module
 * scope, and anything it prints lands on the same stdout — so a bare `JSON.parse(stdout)`
 * turned "this home is fine" into "could not determine" for any code home that logs on
 * import. Review demonstrated it with a one-line `console.log`. Sentinels cost nothing and
 * make the channel robust to a co-tenant instead of assuming it is empty.
 *
 * @param {string} root
 * @param {string} dbPath
 * @returns {string}
 */
export function schemaCompatProbeSource(root, dbPath) {
  const pkg = JSON.stringify(join(root, 'package.json'));
  const schemaUrl = JSON.stringify(pathToFileURL(join(root, 'schema.mjs')).href);
  const db = JSON.stringify(dbPath);
  const open = JSON.stringify(PROBE_BEGIN);
  const close = JSON.stringify(PROBE_END);
  return (
    '(async () => { const out = {};' +
    `try { const m = await import(${schemaUrl});` +
    ' out.supported = typeof m.CURRENT_SCHEMA_VERSION === "number" ? m.CURRENT_SCHEMA_VERSION : null; }' +
    ' catch (e) { out.supportedError = String((e && e.message) || e); }' +
    'try { const { createRequire } = require("node:module");' +
    ` const D = createRequire(${pkg})("better-sqlite3");` +
    ` const d = new D(${db}, { readonly: true, fileMustExist: true });` +
    ' const r = d.prepare("SELECT version FROM schema_version LIMIT 1").get();' +
    ' d.close();' +
    ' out.dbVersion = r && typeof r.version === "number" ? r.version : null; }' +
    ' catch (e) { out.dbError = String((e && e.message) || e); }' +
    `process.stdout.write(${open} + JSON.stringify(out) + ${close}); })()`
  );
}

// Deliberately unlikely to appear in a module's own logging, and matched with lastIndexOf so
// a tree that echoes the sentinel itself still loses to the real payload written last.
const PROBE_BEGIN = '<<claude-mem-schema-probe>>';
const PROBE_END = '<</claude-mem-schema-probe>>';

/** The bracketed payload, or null when the child never got as far as writing one. */
function extractProbePayload(stdout) {
  const s = String(stdout || '');
  const a = s.lastIndexOf(PROBE_BEGIN);
  if (a < 0) return null;
  const b = s.indexOf(PROBE_END, a);
  if (b < 0) return null;
  try {
    return JSON.parse(s.slice(a + PROBE_BEGIN.length, b));
  } catch {
    return null;
  }
}

/**
 * Can THIS code home open THIS database?
 *
 * Out of process for the same reason every other probe here is: importing another tree's
 * schema.mjs and dlopen'ing its better-sqlite3 would poison the calling process, and doctor
 * has to survive answering the question.
 *
 * @param {string} root Code home (holds schema.mjs and node_modules)
 * @param {string} dbPath
 * `spawn` is injectable so the "child produced no parseable stdout" branch can be driven at
 * all. THE ORIGINAL REASON GIVEN HERE WAS WRONG and is corrected rather than quietly
 * dropped: it claimed the branch was reachable only from a native crash and could not be
 * provoked from a test. Review falsified that in one step — a code home whose schema.mjs
 * writes anything to stdout at module scope (a `console.log`, or any import that logs)
 * pollutes the JSON payload and lands here through the real function, exit 0. So the branch
 * is ORDINARY, not exotic: any tree that logs on import degrades a correct verdict into a
 * doctor ⚠. That is why the child now brackets its payload with a sentinel and this function
 * reads only what is inside it — the seam remains for the genuinely unreachable shapes
 * (a native crash leaving both streams empty, a spawn that never starts).
 *
 * @param {{timeoutMs?: number, spawn?: (cmd: string, args: string[], opts: object) => object}} [opts]
 * @returns {{status: 'ok'|'skew'|'unknown', supported?: number|null, dbVersion?: number|null, error?: string}}
 */
export function probeSchemaCompatInFreshProcess(
  root,
  dbPath,
  { timeoutMs = 15_000, spawn = spawnSync } = {},
) {
  const r = spawn(process.execPath, ['-e', schemaCompatProbeSource(root, dbPath)], {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  // Before the status check: spawnSync's `timeout` is SIGTERM-then-wait, so a child that
  // survives the signal can still exit 0 while r.error is ETIMEDOUT.
  if (r.error) return { status: 'unknown', error: r.error.message };
  const out = extractProbePayload(r.stdout);
  if (!out) {
    const stderrLine = String(r.stderr || '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean);
    return { status: 'unknown', error: stderrLine || `probe exited ${r.status ?? `on signal ${r.signal}`}` };
  }
  const { supported, dbVersion } = out;
  // Either number missing = unknown. Not 'ok': a home whose schema.mjs would not load is
  // not a home we just certified, and a DB we could not read is not a DB we compared against.
  if (typeof supported !== 'number' || typeof dbVersion !== 'number') {
    return {
      status: 'unknown',
      supported: supported ?? null,
      dbVersion: dbVersion ?? null,
      error: out.supportedError || out.dbError || 'probe returned no version',
    };
  }
  return { status: supported < dbVersion ? 'skew' : 'ok', supported, dbVersion };
}

/**
 * Probe every code home against one DB, so a report can NAME the one that is behind
 * instead of asserting something global about "the install".
 *
 * @param {Array<{label: string, root: string}>} roots
 * @param {string} dbPath
 * @param {{probe?: (root: string, dbPath: string) => object}} [deps]
 * @returns {Array<{label: string, root: string, status: string, supported?: number|null, dbVersion?: number|null, error?: string}>}
 */
export function probeSchemaCompat(roots, dbPath, deps = {}) {
  const probe = deps.probe || ((root, p) => probeSchemaCompatInFreshProcess(root, p));
  return (roots || []).map(({ label, root }) => ({ label, root, ...probe(root, dbPath) }));
}
