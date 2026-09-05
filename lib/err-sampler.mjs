// lib/err-sampler.mjs — sampled append-only log of swallowed errors.
//
// Rationale: debugCatch previously only surfaced errors when CLAUDE_MEM_DEBUG
// was on. In production, silent catches have caused real bugs to slip by —
// e.g. rebuildVector writing to the wrong column name (`computed_at` vs
// `created_at_epoch`) was caught by the `catch` in optimize/vector and stayed
// invisible until R-7 surfaced it (see hook-optimize.mjs header comment and
// #7556 in project memory).
//
// Sampling is per-call Math.random() — no state, no rate limiter. At sample
// rate 0.01 each debugCatch has a 1% chance to append one JSONL line. Callers
// don't need to know about it; debugCatch imports this lazily so the fs-less
// hot path doesn't pay for the module.
//
// Gated entirely by CLAUDE_MEM_CATCH_SAMPLE env (0..1). Default off. All
// failures inside the sampler are swallowed — never crash the caller.

import { appendFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { scrubSecrets } from '../secret-scrub.mjs';

import { DAY_MS } from './time-constants.mjs';
function today() {
  // UTC date string; sharding daily keeps files bounded even at high sample rates.
  return new Date(Date.now()).toISOString().slice(0, 10);
}

function parseSampleRate(raw) {
  if (raw === undefined || raw === '') return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0;
}

// Delete daily shards older than the retention window. Mirrors
// lib/hook-telemetry.pruneOldShards (the sibling JSONL sink). Without this the
// retention constant was dead and errors/ grew one shard/day forever once
// CLAUDE_MEM_CATCH_SAMPLE was set — a slow unbounded leak in the user data dir.
function pruneOldShards(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - SAMPLE_LOG_RETENTION_MS;
  for (const f of entries) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
    try {
      if (statSync(join(dir, f)).mtimeMs < cutoff) unlinkSync(join(dir, f));
    } catch {
      /* gone or unreadable — skip */
    }
  }
}

/**
 * Sample one caught error into the daily JSONL log.
 * @param {Error|unknown} e    Caught error
 * @param {string}        ctx  Context label passed to debugCatch
 * @param {string}        dbDir ~/.claude-mem-lite (or CLAUDE_MEM_DIR)
 */
export function maybeSampleError(e, ctx, dbDir) {
  try {
    const rate = parseSampleRate(process.env.CLAUDE_MEM_CATCH_SAMPLE);
    if (rate <= 0) return;
    if (Math.random() >= rate) return;
    if (!dbDir) return;

    const errDir = join(dbDir, 'errors');
    if (!existsSync(errDir)) mkdirSync(errDir, { recursive: true, mode: 0o700 });

    // Scrub BEFORE truncating: a connection string / Authorization header / 401
    // body can ride along in an error message or stack frame. Scrub the full
    // string first so a secret straddling the slice boundary is still caught.
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        ctx: scrubSecrets(String(ctx || '')).slice(0, 120),
        msg: scrubSecrets(String(e?.message ?? e ?? '')).slice(0, 500),
        stack:
          typeof e?.stack === 'string' ? scrubSecrets(e.stack.split('\n').slice(0, 6).join('\n')) : undefined,
      }) + '\n';

    appendFileSync(join(errDir, `${today()}.jsonl`), line, { mode: 0o600 });
    pruneOldShards(errDir);
  } catch {
    /* sampler must never throw */
  }
}

/** Exposed for tests — returns the resolved sample rate in [0,1]. */
export function _sampleRate() {
  return parseSampleRate(process.env.CLAUDE_MEM_CATCH_SAMPLE);
}

/** Exposed for tests — return daily retention cutoff in ms (14 days). */
export const SAMPLE_LOG_RETENTION_MS = 14 * DAY_MS;
