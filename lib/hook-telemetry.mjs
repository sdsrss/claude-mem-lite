// lib/hook-telemetry.mjs — unsampled hook-error log.
//
// Distinct from lib/err-sampler.mjs: that one writes 1% of swallowed debugCatch
// errors into ${dbDir}/errors/ for *production diagnostics* — high cardinality,
// must be cheap. This one writes 100% of hook script failures into
// ${runtimeDir}/hook-errors/ for *self-observation* — low cardinality (hooks
// fail rarely), every event matters because it's the only window into
// PreToolUse / Skill-bridge / UPS failure modes (DB corruption, schema drift,
// upstream field rename). Both follow the same JSONL daily-shard layout to
// keep tooling consistent; the directory split is the contract that says
// "no sampling here, this is full fidelity".
//
// Hook scripts catch *all* errors and exit 0 (must never block Edit/Write).
// Calling this from inside each catch turns the silent path into a recorded
// path without changing behavior. All failures inside the recorder itself
// are swallowed — telemetry must never crash the host hook.
//
// Retention: 14 days. GC is lazy on append (cheap stat+unlink loop, only
// reads the dir, no parse).

import { appendFileSync, mkdirSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
// Both are pure-`node:`-static modules (better-sqlite3 is only createRequire'd
// lazily inside binding-probe's functions), so this keeps the "usable from the
// lightweight standalone scripts" property stated above.
import { isNativeBindingError } from './binding-probe.mjs';
import { recordNativeBindingBreakage } from './native-binding-hint.mjs';
// secret-scrub.mjs is pure regex over one pure-`node:` import (lib/private-strip.mjs),
// so it preserves the "usable from the lightweight standalone scripts" property above.
// lib/err-sampler.mjs — the sibling sink — already depends on it for the same reason.
import { scrubSecrets } from '../secret-scrub.mjs';

import { DAY_MS } from './time-constants.mjs';
const RETENTION_MS = 14 * DAY_MS;
const HOOK_ERRORS_SUBDIR = 'hook-errors';

function today() {
  return new Date(Date.now()).toISOString().slice(0, 10);
}

function hookErrorsDir(runtimeDir) {
  return join(runtimeDir, HOOK_ERRORS_SUBDIR);
}

// Lazy GC: scan the dir, unlink shards older than RETENTION_MS. Cheap because
// it never opens files — just statSync + unlinkSync. Called from recordHookError
// after a successful write, so it amortizes over the failure cadence.
function pruneOldShards(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - RETENTION_MS;
  for (const f of entries) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
    const full = join(dir, f);
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) unlinkSync(full);
    } catch {
      /* gone or unreadable — skip */
    }
  }
}

/**
 * Record one hook-script failure to the unsampled JSONL log.
 *
 * @param {string}  scope       Short label naming the hook script + failure point.
 *                              Convention: '<script>:<step>' e.g. 'pre-recall:db-open',
 *                              'skill-bridge:registry-query'. Truncated to 80 chars.
 * @param {unknown} err         Thrown value (Error, string, undefined — all ok).
 * @param {string}  runtimeDir  Absolute path to ${CLAUDE_MEM_DIR}/runtime/. Caller
 *                              must resolve this — module avoids importing
 *                              hook-shared.mjs so it stays usable from the
 *                              lightweight standalone scripts.
 * @param {object}  [ctx]       Optional small JSON-safe context (filePath, toolName,
 *                              sessionId fragment). Stringified + truncated to 240
 *                              chars to keep shard lines bounded.
 */
export function recordHookError(scope, err, runtimeDir, ctx) {
  try {
    if (!runtimeDir || typeof runtimeDir !== 'string') return;
    const dir = hookErrorsDir(runtimeDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Scrub BEFORE truncating, on every field — same caliber as lib/err-sampler.mjs, which
    // is the twin of this sink and has carried the scrub since it was written. This one had
    // not: an error message is a documented carrier for the input that provoked it, and the
    // hook scripts hand it exactly that. `scripts/pre-tool-recall.js:319` records
    // `pre-recall:json` from a JSON.parse of raw hook stdin, and Node >= 20 quotes the
    // offending text back inside the SyntaxError message ("Unexpected token 's',
    // \"{\"a\": sk-proj-AB\"... is not valid JSON") — that stdin is the user's prompt and
    // the tool output around it. Truncating first would also let a secret straddling the
    // slice boundary survive as a fragment. `scope` is an in-code literal today; scrubbing
    // it costs nothing and removes the exception that would otherwise need re-arguing.
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        scope: scrubSecrets(String(scope || '')).slice(0, 80),
        msg: scrubSecrets(String(err?.message ?? err ?? '')).slice(0, 500),
        stack:
          typeof err?.stack === 'string'
            ? scrubSecrets(err.stack.split('\n').slice(0, 6).join('\n'))
            : undefined,
        ctx: ctx === undefined ? undefined : scrubSecrets(JSON.stringify(ctx)).slice(0, 240),
      }) + '\n';

    appendFileSync(join(dir, `${today()}.jsonl`), line, { mode: 0o600 });
    // Amortized retention sweep: 14-day window kept clean without a cron.
    pruneOldShards(dir);

    // Every hook script funnels its failures through here — including the
    // STANDALONE ones (scripts/pre-tool-recall.js, scripts/post-tool-recall.js)
    // that never import hook.mjs and so never reach its dispatch catch. That gap
    // is why the 2026-08-13 outage stayed invisible: 78 of that day's 79 entries
    // were `pre-recall:db-open`, i.e. the ONE path whose errors nothing but this
    // log could see. Flagging the native-binding family here — rather than at
    // each call site — is what makes the session-start heal fire no matter which
    // script hits the stale binding first.
    if (isNativeBindingError(err)) {
      recordNativeBindingBreakage(runtimeDir, {
        reason: String(err?.message ?? err ?? ''),
        event: String(scope || ''),
      });
    }
  } catch {
    /* recorder must never throw */
  }
}

/**
 * Count hook errors with timestamp >= sinceMs. Used by `mem-cli stats` to
 * surface a single self-observation line.
 *
 * Reads every shard (capped at 14 by retention). Each shard is JSONL — parse
 * line-by-line and tolerate malformed lines (treat as zero contribution).
 * Returns a plain count; per-scope breakdown is a follow-up if cardinality
 * grows.
 */
export function countRecentHookErrors(runtimeDir, sinceMs) {
  try {
    if (!runtimeDir || typeof runtimeDir !== 'string') return 0;
    const dir = hookErrorsDir(runtimeDir);
    if (!existsSync(dir)) return 0;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return 0;
    }
    const cutoffIso = new Date(sinceMs).toISOString();
    let count = 0;
    for (const f of entries) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      let body;
      try {
        body = readFileSync(join(dir, f), 'utf8');
      } catch {
        continue;
      }
      for (const line of body.split('\n')) {
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        // ISO 8601 lexical ordering matches chronological ordering — no Date parse.
        if (typeof parsed.ts === 'string' && parsed.ts >= cutoffIso) count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/** Test hook — current retention window (14 days, in ms). */
export const HOOK_ERROR_RETENTION_MS = RETENTION_MS;
