// metrics.test.mjs — lib/metrics.mjs sink + aggregation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordMetric, readMetrics, aggregateMetrics, formatSummary, timed, DEFAULT_WINDOW_DAYS, gcOldMetricShards,
} from '../lib/metrics.mjs';
import { gcDailyShards } from '../lib/shard-gc.mjs';

// The sweep `gcOldMetricShards` and `registry-recommend.gcOldShadowShards` now share
// (audit 2026-09-05 P2-3). Both callers exercise it through their own directory
// resolution; these cases pin the parts neither caller's test reaches — what counts as a
// shard name, and that a caller may hand it a path that does not exist.
describe('gcDailyShards (the shared sweep)', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'shard-gc-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('deletes by the DATE IN THE FILENAME, not by mtime', () => {
    // A shard rewritten today is still that day's shard. Both files are created now, so
    // an mtime-based sweep would keep both and this case would read 0.
    const old1 = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
    const old2 = new Date(Date.now() - 91 * 86400000).toISOString().slice(0, 10);
    const keep = new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
    for (const d of [old1, old2, keep]) writeFileSync(join(tmp, `${d}.jsonl`), '{}\n');
    expect(gcDailyShards(tmp, 90)).toBe(2);
    expect(existsSync(join(tmp, `${keep}.jsonl`))).toBe(true);
  });

  it('only treats YYYY-MM-DD.jsonl as a shard', () => {
    const old = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
    writeFileSync(join(tmp, `${old}.jsonl`), '{}\n');
    for (const name of [`${old}.json`, `${old}.jsonl.bak`, `x-${old}.jsonl`, '2026-1-2.jsonl', 'latest.jsonl']) {
      writeFileSync(join(tmp, name), 'keep');
    }
    expect(gcDailyShards(tmp, 90)).toBe(1);
    expect(readdirSync(tmp).sort()).toEqual(
      [`${old}.json`, `${old}.jsonl.bak`, `x-${old}.jsonl`, '2026-1-2.jsonl', 'latest.jsonl'].sort(),
    );
  });

  it('is a no-op on a missing or empty path rather than throwing', () => {
    expect(gcDailyShards(join(tmp, 'nope'), 90)).toBe(0);
    expect(gcDailyShards('', 90)).toBe(0);
    expect(gcDailyShards(tmp, 90)).toBe(0);
  });
});

describe('gcOldMetricShards', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'metrics-gc-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('prunes shards older than retainDays, keeps recent + non-shard files', () => {
    const dir = join(tmp, 'metrics');
    mkdirSync(dir, { recursive: true });
    const oldDate = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
    const recentDate = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    writeFileSync(join(dir, `${oldDate}.jsonl`), '{}\n');
    writeFileSync(join(dir, `${recentDate}.jsonl`), '{}\n');
    writeFileSync(join(dir, 'not-a-shard.txt'), 'keep'); // non-shard untouched

    const removed = gcOldMetricShards(tmp, 90);
    expect(removed).toBe(1);
    expect(existsSync(join(dir, `${oldDate}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, `${recentDate}.jsonl`))).toBe(true);
    expect(existsSync(join(dir, 'not-a-shard.txt'))).toBe(true);
  });

  it('returns 0 when the metrics dir does not exist (no-op, no throw)', () => {
    expect(gcOldMetricShards(tmp, 90)).toBe(0);
  });
});

describe('metrics sink', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'metrics-'));
    delete process.env.CLAUDE_MEM_METRICS;
  });
  afterEach(() => {
    delete process.env.CLAUDE_MEM_METRICS;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes nothing when disabled (default)', () => {
    recordMetric(tmp, { event: 'inject', durationMs: 12 });
    expect(existsSync(join(tmp, 'metrics'))).toBe(false);
  });

  it('writes a JSONL row when CLAUDE_MEM_METRICS=1', () => {
    process.env.CLAUDE_MEM_METRICS = '1';
    recordMetric(tmp, { event: 'inject', durationMs: 12, candidates: 7, returned: 3 });
    const files = readdirSync(join(tmp, 'metrics'));
    expect(files.length).toBe(1);
    const line = readFileSync(join(tmp, 'metrics', files[0]), 'utf8').trim();
    const row = JSON.parse(line);
    expect(row.event).toBe('inject');
    expect(row.durationMs).toBe(12);
    expect(row.candidates).toBe(7);
    expect(row.returned).toBe(3);
    expect(typeof row.ts).toBe('string');
  });

  it('skips rows with missing event field', () => {
    process.env.CLAUDE_MEM_METRICS = '1';
    recordMetric(tmp, { durationMs: 10 });
    expect(existsSync(join(tmp, 'metrics'))).toBe(false);
  });

  it('never throws when given bad dbDir', () => {
    process.env.CLAUDE_MEM_METRICS = '1';
    expect(() => recordMetric('', { event: 'inject' })).not.toThrow();
    expect(() => recordMetric(null, { event: 'inject' })).not.toThrow();
  });
});

describe('timed() wrapper', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'metrics-t-'));
    process.env.CLAUDE_MEM_METRICS = '1';
  });
  afterEach(() => {
    delete process.env.CLAUDE_MEM_METRICS;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns function result and records duration', () => {
    const result = timed(tmp, 'search', () => 42);
    expect(result).toBe(42);
    const rows = [...readMetrics(tmp)];
    expect(rows.length).toBe(1);
    expect(rows[0].event).toBe('search');
    expect(typeof rows[0].durationMs).toBe('number');
  });

  it('re-throws and records error on exception', () => {
    expect(() => timed(tmp, 'save', () => { throw new Error('boom'); })).toThrow('boom');
    const rows = [...readMetrics(tmp)];
    expect(rows[0].error).toBe('boom');
  });

  it('is a direct call-through when metrics disabled', () => {
    delete process.env.CLAUDE_MEM_METRICS;
    const result = timed(tmp, 'search', () => 'x');
    expect(result).toBe('x');
    expect(existsSync(join(tmp, 'metrics'))).toBe(false);
  });
});

describe('aggregateMetrics', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'metrics-agg-'));
    process.env.CLAUDE_MEM_METRICS = '1';
  });
  afterEach(() => {
    delete process.env.CLAUDE_MEM_METRICS;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns empty object when no data', () => {
    expect(aggregateMetrics(tmp)).toEqual({});
  });

  it('computes p50/p95/p99 per event', () => {
    for (let i = 1; i <= 100; i++) recordMetric(tmp, { event: 'inject', durationMs: i });
    const agg = aggregateMetrics(tmp);
    expect(agg.inject.count).toBe(100);
    expect(agg.inject.p50).toBeGreaterThanOrEqual(49);
    expect(agg.inject.p50).toBeLessThanOrEqual(51);
    expect(agg.inject.p95).toBeGreaterThanOrEqual(94);
    expect(agg.inject.p99).toBeGreaterThanOrEqual(98);
  });

  it('counts errors separately', () => {
    recordMetric(tmp, { event: 'save', durationMs: 5, error: 'x' });
    recordMetric(tmp, { event: 'save', durationMs: 5 });
    const agg = aggregateMetrics(tmp);
    expect(agg.save.count).toBe(2);
    expect(agg.save.errors).toBe(1);
  });

  it('skips malformed JSONL lines silently', () => {
    recordMetric(tmp, { event: 'inject', durationMs: 5 });
    const files = readdirSync(join(tmp, 'metrics'));
    const path = join(tmp, 'metrics', files[0]);
    writeFileSync(path, readFileSync(path, 'utf8') + 'this-is-not-json\n{"valid":true,"event":"save","durationMs":7}\n');
    const agg = aggregateMetrics(tmp);
    expect(agg.inject.count).toBe(1);
    expect(agg.save.count).toBe(1);
  });

  it('honors days window (rejects rows older than N days)', () => {
    const metricsDir = join(tmp, 'metrics');
    mkdirSync(metricsDir, { recursive: true });
    // Write a 30-day-old file
    const oldDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    writeFileSync(join(metricsDir, `${oldDate}.jsonl`), JSON.stringify({ event: 'old', durationMs: 1 }) + '\n');
    // And a recent one via recordMetric
    recordMetric(tmp, { event: 'recent', durationMs: 2 });
    const agg = aggregateMetrics(tmp, 7);
    expect(agg.old).toBeUndefined();
    expect(agg.recent).toBeDefined();
  });

  it('default window is 7 days', () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(7);
  });
});

describe('formatSummary', () => {
  it('returns empty-state line when no events', () => {
    expect(formatSummary({})).toMatch(/no data/);
  });

  it('renders one line per event sorted alphabetically', () => {
    const agg = {
      save:   { count: 10, errors: 0, p50: 5, p95: 8, p99: 9, firstTs: 'a', lastTs: 'b' },
      inject: { count: 50, errors: 2, p50: 1, p95: 3, p99: 4, firstTs: 'a', lastTs: 'b' },
    };
    const text = formatSummary(agg);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/last 7d/);
    expect(lines[1]).toMatch(/^\s+inject\s+/);
    expect(lines[2]).toMatch(/^\s+save\s+/);
  });
});
