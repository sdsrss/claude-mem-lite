// lib/native-binding-hint.mjs — friendly, rate-limited hint for an unloadable
// native DB binding (better-sqlite3 ERR_DLOPEN_FAILED, e.g. a Node version
// upgrade leaves the prebuilt .node ABI-stale).
//
// This is the SIBLING of the missing-dependency case handled in
// scripts/hook-launcher.mjs. The two fail on different paths:
//   • MISSING dependency (ERR_MODULE_NOT_FOUND) throws at IMPORT time, before
//     hook.mjs runs — caught by the launcher.
//   • UNLOADABLE binding (ERR_DLOPEN_FAILED) imports fine (better-sqlite3 loads
//     its .node lazily at the first `new Database()`), then throws inside a hook
//     handler — caught by hook.mjs's top-level dispatch try/catch. Pre-this,
//     that catch logged the raw multi-line NODE_MODULE_VERSION message on EVERY
//     hook fire. Here we collapse it to one short, actionable line, rate-limited
//     per cooldown. The actual rebuild is the MCP server launch path's job
//     (lib/binding-probe.mjs::ensureBetterSqlite3Working) — a hook must never
//     run `npm rebuild` itself (2–5s timeout + concurrent-fire races).
//
// Pure node: imports + injectable now/runtimeDir so it unit-tests without the
// hook dependency graph (no schema.mjs / better-sqlite3 import). The one non-node:
// import — lib/binding-probe.mjs for the shared fault classifier — keeps that
// property: it only `createRequire`s better-sqlite3 lazily inside its functions,
// so importing it never dlopen's the very binding this module reports on.

import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isNativeBindingError, flattenBindingError } from './binding-probe.mjs';

export const NATIVE_BINDING_HINT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h
const MARKER_NAME = 'native-binding-hint-last';

// Breakage marker read by scripts/hook-launcher.mjs at session-start to trigger
// the unattended rebuild. The hint alone was NOT enough: it goes to hook stderr,
// is rate-limited to once per 6h, and in the field (2026-08-13) a Node 22 → 24
// upgrade left the binding stale for 4 days across 79 failed fires because the
// only healer was the MCP-server launch path, which those sessions never ran.
export const NATIVE_BINDING_BROKEN_MARKER = 'native-binding-broken';

// Resolvable invocation of the bundled CLI's LOCAL binding repair. Absolute via
// import.meta.url (cli.mjs is one dir up from lib/) so it works on a plugin-only
// install, where bare `claude-mem-lite` is not on PATH. `rebuild-binding`, not
// `repair`: repair re-downloads and Ed25519-verifies a whole GitHub release and
// fails closed offline — the wrong (often impossible) tool for recompiling one
// native module against the running Node. (review #3)
// D#207: join(), not `new URL('../cli.mjs', …)` — that form makes knip drop the named
// module out of its unused-export report. cli.mjs is a knip entry point so nothing was
// lost here, but the rule is enforced for the class rather than per-file.
const CLI_REBUILD_BINDING = `node ${join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')} rebuild-binding`;

// Stable-ish identity of a fault so DISTINCT failures get DISTINCT cooldown
// windows: the same fault → same key (suppressed within the window), a different
// fault → different key → surfaces even within the window. djb2 over the message
// keeps it dependency-free (no node:crypto). (review #8/#15)
function errKey(message = '') {
  const m = String(message);
  let h = 5381;
  for (let i = 0; i < m.length; i++) h = ((h * 33) ^ m.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * True at most once per cooldown window FOR A GIVEN `key`. Persists
 * "<epochMs>\t<key>" as file CONTENT (not mtime) under runtimeDir so callers can
 * inject `now` deterministically in tests. A different `key` (a distinct fault)
 * resets the window, so a new problem is never silenced by an earlier, unrelated
 * one. Best-effort: any fs error returns true — showing the hint beats silently
 * swallowing a real problem.
 *
 * @param {string} runtimeDir Directory for the marker file
 * @param {number} [now] Current epoch ms (injectable)
 * @param {number} [cooldownMs] Suppression window
 * @param {string} [key] Fault identity; same key within the window → suppressed
 * @returns {boolean}
 */
export function nativeBindingHintDue(runtimeDir, now = Date.now(), cooldownMs = NATIVE_BINDING_HINT_COOLDOWN_MS, key = '') {
  const marker = join(runtimeDir, MARKER_NAME);
  try {
    const raw = readFileSync(marker, 'utf8');
    // Format "<epochMs>\t<key>"; a legacy bare "<epochMs>" parses with key ''.
    const tab = raw.indexOf('\t');
    const last = Number(tab === -1 ? raw : raw.slice(0, tab));
    const lastKey = tab === -1 ? '' : raw.slice(tab + 1);
    if (Number.isFinite(last) && lastKey === key && now - last < cooldownMs) return false;
  } catch { /* no/invalid marker → due */ }
  try {
    mkdirSync(runtimeDir, { recursive: true });
    // Atomic write (tmp + rename) so a concurrent reader sees the old or the new
    // COMPLETE value, never a torn timestamp that parses NaN → spurious "due" →
    // duplicate hint. The residual read-then-decide race can still emit twice, but
    // the hint is cosmetic and 6h-rate-limited, so that is acceptable. (#7/#10)
    const tmp = `${marker}.tmp-${process.pid}`;
    writeFileSync(tmp, `${now}\t${key}`);
    renameSync(tmp, marker);
  } catch { /* best-effort */ }
  return true;
}

/**
 * Single stderr line hook.mjs should log for a caught dispatch error, or null
 * to stay silent (ERR_DLOPEN_FAILED still within cooldown). ERR_DLOPEN_FAILED →
 * short rate-limited rebuild hint; everything else → the existing ungated
 * structured ERROR line. Pass runtimeDir to enable rate-limiting (omit it to
 * always format, e.g. in tests).
 *
 * @param {Error & {code?: string}} err
 * @param {string} event Hook event name (stop / session-start / …)
 * @param {{now?: number, runtimeDir?: string}} [opts]
 * @returns {string | null}
 */
export function formatHookError(err, event, { now = Date.now(), runtimeDir } = {}) {
  const ts = new Date(now).toISOString();
  if (isNativeBindingError(err)) {
    // Record BEFORE the cooldown check: the hint is cosmetic and rate-limited,
    // the marker is the heal trigger. Gating the marker on the hint would mean a
    // silenced hint also silences the repair — exactly the 4-day outage shape.
    if (runtimeDir) recordNativeBindingBreakage(runtimeDir, { reason: err.message, event, now });
    // Key the cooldown on the fault identity so a DISTINCT native failure within
    // the window still surfaces (a second ABI mismatch after a partial rebuild, a
    // corrupt .node) instead of being silenced by a prior, different DLOPEN. (#8/#15)
    if (runtimeDir && !nativeBindingHintDue(runtimeDir, now, NATIVE_BINDING_HINT_COOLDOWN_MS, errKey(err.message))) return null;
    return `[claude-mem-lite] [${ts}] [WARN] ${event}: native DB binding can't load ` +
      `(likely a Node version change) — auto-heals at the next session start, or run now: ${CLI_REBUILD_BINDING}`;
  }
  return `[claude-mem-lite] [${ts}] [ERROR] ${event}: ${err && err.message}`;
}

/**
 * Record the "native binding is unusable" state for the launcher's session-start
 * heal. Overwrites: the newest fault is the one worth repairing. Best-effort —
 * a hook must never fail because a marker could not be written.
 *
 * @param {string} runtimeDir
 * @param {{reason?: string, event?: string, now?: number}} [opts]
 */
export function recordNativeBindingBreakage(runtimeDir, { reason = '', event = '', now = Date.now() } = {}) {
  try {
    mkdirSync(runtimeDir, { recursive: true });
    const marker = join(runtimeDir, NATIVE_BINDING_BROKEN_MARKER);
    const tmp = `${marker}.tmp-${process.pid}`;
    // First line only: the ABI error is multi-line and the marker is read by the
    // launcher (pure node:, no parser beyond JSON.parse) and by `doctor`.
    writeFileSync(tmp, JSON.stringify({ reason: flattenBindingError(reason), event, ts: now }));
    renameSync(tmp, marker);
  } catch { /* best-effort */ }
}

/**
 * @param {string} runtimeDir
 * @returns {{reason?: string, event?: string, ts?: number} | null} null when
 * absent, unreadable or torn — a garbage marker must never throw into a hook.
 */
export function readNativeBindingBreakage(runtimeDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(runtimeDir, NATIVE_BINDING_BROKEN_MARKER), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Idempotent. @param {string} runtimeDir */
export function clearNativeBindingBreakage(runtimeDir) {
  try { unlinkSync(join(runtimeDir, NATIVE_BINDING_BROKEN_MARKER)); } catch { /* already gone */ }
}
