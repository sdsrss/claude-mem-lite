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
//     what this home supports" must never print in the same voice. v6.2.0 shipped a doctor
//     check that answered "no hook command needs bash" on the one install shape where they
//     are live, because a missing file read as a zero count. `status: 'unknown'` exists so
//     that cannot happen here.
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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Machine-readable marker set by schema.mjs on the forward-incompat throw. */
export const SCHEMA_SKEW_CODE = 'CLAUDE_MEM_SCHEMA_TOO_NEW';

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

/**
 * Which command actually repairs this machine.
 *
 * @param {{managed?: boolean, activePluginVersion?: {version: string}|null, dev?: boolean, marketplace?: string, plugin?: string}} shape
 * @returns {{kind: 'dev'|'plugin'|'managed'|'unknown', commands: string[], note: string}}
 */
export function schemaSkewRemedy({
  managed = false,
  activePluginVersion = null,
  dev = false,
  marketplace = 'sdsrss',
  plugin = 'claude-mem-lite',
} = {}) {
  // Dev first and unconditionally: a checkout's files are symlinked or git-managed, so
  // every other remedy would overwrite the user's working tree.
  if (dev) {
    return {
      kind: 'dev',
      commands: ['git pull'],
      note: 'This is a development checkout — something newer than this working tree opened the DB.',
    };
  }
  if (activePluginVersion && !managed) {
    return {
      kind: 'plugin',
      // Both halves are needed and the order matters: the local marketplace clone is what
      // Claude Code compares against, so an outdated clone makes `/plugin update` a no-op
      // that reports success. Measured 2026-09-08: the clone sat 22 commits behind while
      // npm and GitHub already carried the version that owned the DB.
      commands: [`/plugin marketplace update ${marketplace}`, `/plugin update ${plugin}@${marketplace}`],
      note: `Run both in Claude Code, then restart it. Plugin cache is at v${activePluginVersion.version}.`,
    };
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
 * @param {string} root
 * @param {string} dbPath
 * @returns {string}
 */
export function schemaCompatProbeSource(root, dbPath) {
  const pkg = JSON.stringify(join(root, 'package.json'));
  const schemaUrl = JSON.stringify(pathToFileURL(join(root, 'schema.mjs')).href);
  const db = JSON.stringify(dbPath);
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
    'process.stdout.write(JSON.stringify(out)); })()'
  );
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
 * @param {{timeoutMs?: number}} [opts]
 * @returns {{status: 'ok'|'skew'|'unknown', supported?: number|null, dbVersion?: number|null, error?: string}}
 */
export function probeSchemaCompatInFreshProcess(root, dbPath, { timeoutMs = 15_000 } = {}) {
  const r = spawnSync(process.execPath, ['-e', schemaCompatProbeSource(root, dbPath)], {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  // Before the status check: spawnSync's `timeout` is SIGTERM-then-wait, so a child that
  // survives the signal can still exit 0 while r.error is ETIMEDOUT.
  if (r.error) return { status: 'unknown', error: r.error.message };
  let out;
  try {
    out = JSON.parse(String(r.stdout || ''));
  } catch {
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
