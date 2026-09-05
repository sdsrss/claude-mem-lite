// lib/metrics.mjs — optional time-series metric sink.
//
// Rationale: mem_stats --quality gives a snapshot, not a trend. If search
// latency degrades or the coverage filter's pass-rate shifts over time, there
// is no record. Users operating claude-mem-lite in earnest need to see trends.
//
// Design:
//   • CLAUDE_MEM_METRICS=1 enables; default OFF (no fs writes, no overhead).
//   • Per-event JSONL rows appended to `$DB_DIR/metrics/YYYY-MM-DD.jsonl`.
//   • Schema is open-ended: { ts, event, durationMs?, ...payload } — each
//     call-site picks its own payload keys. Readers filter by `event`.
//   • Read path walks last N days (default 7), parses per-line, aggregates
//     p50/p95/p99 latencies and count-only metrics per event.
//
// All writes best-effort (mkdirSync + appendFileSync wrapped in try). Reads
// skip malformed lines silently. The module imports nothing heavy so hook
// cold-start pays near-zero when metrics are disabled.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { DAY_MS } from './time-constants.mjs';
import { gcDailyShards } from './shard-gc.mjs';
function today() {
  return new Date(Date.now()).toISOString().slice(0, 10);
}

function metricsEnabled() {
  return process.env.CLAUDE_MEM_METRICS === '1';
}

/**
 * Append one metric row to the daily JSONL. No-op when env disabled.
 * @param {string} dbDir       Claude-mem data dir (DB_DIR).
 * @param {object} payload     { event: 'inject'|'search'|'save'|..., durationMs?, ...custom }
 */
export function recordMetric(dbDir, payload) {
  if (!metricsEnabled()) return;
  if (!dbDir || !payload || !payload.event) return;
  try {
    const dir = join(dbDir, 'metrics');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const row = { ts: new Date().toISOString(), ...payload };
    appendFileSync(join(dir, `${today()}.jsonl`), JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch {
    /* metrics sink must never crash the caller */
  }
}

/**
 * Helper: time a synchronous function and record the duration.
 * Returns the function's return value; on throw, still records durationMs
 * + error key, then re-throws.
 *
 * @template T
 * @param {string} dbDir
 * @param {string} event
 * @param {() => T} fn
 * @param {object} [extra] Extra keys merged into the metric row
 * @returns {T}
 */
export function timed(dbDir, event, fn, extra = {}) {
  if (!metricsEnabled()) return fn();
  const t0 = Date.now();
  try {
    const out = fn();
    recordMetric(dbDir, { event, durationMs: Date.now() - t0, ...extra });
    return out;
  } catch (e) {
    recordMetric(dbDir, {
      event,
      durationMs: Date.now() - t0,
      error: String(e?.message || 'unknown'),
      ...extra,
    });
    throw e;
  }
}

/**
 * Prune metric daily shards older than `retainDays`. recordMetric writes one
 * YYYY-MM-DD.jsonl per day with no GC, so a long-lived CLAUDE_MEM_METRICS=1 install
 * grows the dir unbounded. 90d keeps a full quarter for aggregate windows while
 * bounding the dir. Runs regardless of the enable flag so a user who toggles metrics
 * OFF still gets old shards cleaned. Best-effort, never throws — called from the
 * SessionStart GC sweep. The sweep itself is `lib/shard-gc.mjs`, shared with
 * registry-recommend's shadow log; this function is the metrics dir resolution.
 * @returns {number} shards removed
 */
export function gcOldMetricShards(dbDir, retainDays = 90) {
  if (!dbDir) return 0;
  return gcDailyShards(join(dbDir, 'metrics'), retainDays);
}

/** Count of days to aggregate by default in readMetrics / aggregate. */
export const DEFAULT_WINDOW_DAYS = 7;

function* iterDailyFiles(dbDir, days) {
  const dir = join(dbDir, 'metrics');
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - days * DAY_MS;
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  for (const f of files) {
    const ymd = f.slice(0, 10);
    const fileMs = Date.parse(ymd + 'T00:00:00Z');
    if (!Number.isFinite(fileMs) || fileMs < cutoff) continue;
    yield join(dir, f);
  }
}

/**
 * Stream-read metric rows from the last `days` days.
 * @yields {object}
 */
export function* readMetrics(dbDir, days = DEFAULT_WINDOW_DAYS) {
  for (const path of iterDailyFiles(dbDir, days)) {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* skip malformed */
      }
    }
  }
}

function percentile(sorted, q) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

/**
 * Aggregate metrics into per-event summaries.
 * Output shape: { [event]: { count, p50, p95, p99, errors, firstTs, lastTs } }
 */
export function aggregateMetrics(dbDir, days = DEFAULT_WINDOW_DAYS) {
  const byEvent = new Map();
  for (const row of readMetrics(dbDir, days)) {
    const ev = row.event;
    if (!ev) continue;
    let bucket = byEvent.get(ev);
    if (!bucket) {
      bucket = { count: 0, durations: [], errors: 0, firstTs: row.ts, lastTs: row.ts };
      byEvent.set(ev, bucket);
    }
    bucket.count++;
    if (typeof row.durationMs === 'number' && Number.isFinite(row.durationMs)) {
      bucket.durations.push(row.durationMs);
    }
    if (row.error) bucket.errors++;
    if (row.ts && row.ts < bucket.firstTs) bucket.firstTs = row.ts;
    if (row.ts && row.ts > bucket.lastTs) bucket.lastTs = row.ts;
  }
  const out = {};
  for (const [ev, b] of byEvent) {
    b.durations.sort((a, z) => a - z);
    out[ev] = {
      count: b.count,
      errors: b.errors,
      p50: percentile(b.durations, 0.5),
      p95: percentile(b.durations, 0.95),
      p99: percentile(b.durations, 0.99),
      firstTs: b.firstTs,
      lastTs: b.lastTs,
    };
  }
  return out;
}

/**
 * Human-readable summary table for `doctor` / `stats` output.
 * Returns a string block with one line per event.
 */
export function formatSummary(aggregated, days = DEFAULT_WINDOW_DAYS) {
  const events = Object.keys(aggregated).sort();
  if (events.length === 0) return `[metrics] no data in the last ${days}d (is CLAUDE_MEM_METRICS=1 set?)`;
  const header = `[metrics] last ${days}d — event · count · p50 / p95 / p99 (ms) · errors`;
  const lines = [header];
  for (const ev of events) {
    const s = aggregated[ev];
    const lat = s.p50 !== null ? `${s.p50} / ${s.p95} / ${s.p99}` : '(no latency)';
    lines.push(`  ${ev.padEnd(16)} · n=${String(s.count).padStart(5)} · ${lat} · err=${s.errors}`);
  }
  return lines.join('\n');
}
