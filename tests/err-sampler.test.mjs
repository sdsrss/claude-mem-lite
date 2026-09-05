// err-sampler.test.mjs — debugCatch sampled-to-disk behavior.
// Regression guard for the #6 audit recommendation: silent-swallowed errors
// can hide column-name drift bugs for a release cycle (see #7556 / optimize
// rebuildVector). Sampler gates via CLAUDE_MEM_CATCH_SAMPLE env; must never
// throw and must not interfere with hook hot path when disabled.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { maybeSampleError, _sampleRate, SAMPLE_LOG_RETENTION_MS } from '../lib/err-sampler.mjs';

describe('err-sampler — maybeSampleError', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'err-sampler-'));
    delete process.env.CLAUDE_MEM_CATCH_SAMPLE;
  });
  afterEach(() => {
    delete process.env.CLAUDE_MEM_CATCH_SAMPLE;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('does nothing when env is unset (hot-path zero cost)', () => {
    maybeSampleError(new Error('boom'), 'ctx', tmp);
    expect(existsSync(join(tmp, 'errors'))).toBe(false);
  });

  it('does nothing when env is 0', () => {
    process.env.CLAUDE_MEM_CATCH_SAMPLE = '0';
    maybeSampleError(new Error('boom'), 'ctx', tmp);
    expect(existsSync(join(tmp, 'errors'))).toBe(false);
  });

  it('writes a JSONL line at rate=1 (always samples)', () => {
    process.env.CLAUDE_MEM_CATCH_SAMPLE = '1';
    maybeSampleError(new Error('integration race'), 'rebuildVector', tmp);
    const errDir = join(tmp, 'errors');
    expect(existsSync(errDir)).toBe(true);
    const files = readdirSync(errDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const body = readFileSync(join(errDir, files[0]), 'utf8').trim();
    const parsed = JSON.parse(body);
    expect(parsed.ctx).toBe('rebuildVector');
    expect(parsed.msg).toBe('integration race');
    expect(typeof parsed.ts).toBe('string');
    expect(parsed.stack).toMatch(/err-sampler\.test\.mjs/);
  });

  it('truncates msg to 500 chars', () => {
    process.env.CLAUDE_MEM_CATCH_SAMPLE = '1';
    const huge = 'x'.repeat(10000);
    maybeSampleError(new Error(huge), 'ctx', tmp);
    const errDir = join(tmp, 'errors');
    const files = readdirSync(errDir);
    const parsed = JSON.parse(readFileSync(join(errDir, files[0]), 'utf8').trim());
    expect(parsed.msg.length).toBeLessThanOrEqual(500);
  });

  it('truncates ctx to 120 chars', () => {
    process.env.CLAUDE_MEM_CATCH_SAMPLE = '1';
    const longCtx = 'x'.repeat(1000);
    maybeSampleError(new Error('e'), longCtx, tmp);
    const errDir = join(tmp, 'errors');
    const files = readdirSync(errDir);
    const parsed = JSON.parse(readFileSync(join(errDir, files[0]), 'utf8').trim());
    expect(parsed.ctx.length).toBeLessThanOrEqual(120);
  });

  it('handles non-Error thrown values gracefully (string, null, undefined)', () => {
    process.env.CLAUDE_MEM_CATCH_SAMPLE = '1';
    expect(() => maybeSampleError('string-error', 'ctx', tmp)).not.toThrow();
    expect(() => maybeSampleError(null, 'ctx', tmp)).not.toThrow();
    expect(() => maybeSampleError(undefined, 'ctx', tmp)).not.toThrow();
  });

  it('never throws when dbDir is missing or invalid', () => {
    process.env.CLAUDE_MEM_CATCH_SAMPLE = '1';
    expect(() => maybeSampleError(new Error('e'), 'ctx', '')).not.toThrow();
    expect(() => maybeSampleError(new Error('e'), 'ctx', null)).not.toThrow();
  });

  it('invalid env (NaN / out-of-range) treated as 0', () => {
    process.env.CLAUDE_MEM_CATCH_SAMPLE = 'not-a-number';
    expect(_sampleRate()).toBe(0);
    process.env.CLAUDE_MEM_CATCH_SAMPLE = '2';
    expect(_sampleRate()).toBe(0);
    process.env.CLAUDE_MEM_CATCH_SAMPLE = '-1';
    expect(_sampleRate()).toBe(0);
  });

  // Audit 2026-06-22 P2 #7: the retention constant existed but nothing pruned, so
  // errors/ grew one shard/day forever once CLAUDE_MEM_CATCH_SAMPLE was set.
  it('prunes daily shards older than the retention window on write', () => {
    process.env.CLAUDE_MEM_CATCH_SAMPLE = '1';
    const errDir = join(tmp, 'errors');
    mkdirSync(errDir, { recursive: true });
    const oldShard = join(errDir, '2000-01-01.jsonl');
    writeFileSync(oldShard, '{"old":true}\n');
    const wellPast = (Date.now() - SAMPLE_LOG_RETENTION_MS - 86400000) / 1000; // seconds
    utimesSync(oldShard, wellPast, wellPast);
    const freshShard = join(errDir, '2099-01-01.jsonl'); // mtime = now → kept
    writeFileSync(freshShard, '{"fresh":true}\n');

    maybeSampleError(new Error('trigger a write'), 'ctx', tmp);

    expect(existsSync(oldShard)).toBe(false); // pruned
    expect(existsSync(freshShard)).toBe(true); // within window → kept
  });

  it('appends to same daily file on multiple calls', () => {
    process.env.CLAUDE_MEM_CATCH_SAMPLE = '1';
    maybeSampleError(new Error('first'), 'ctx1', tmp);
    maybeSampleError(new Error('second'), 'ctx2', tmp);
    const errDir = join(tmp, 'errors');
    const files = readdirSync(errDir);
    expect(files.length).toBe(1);
    const lines = readFileSync(join(errDir, files[0]), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).ctx).toBe('ctx1');
    expect(JSON.parse(lines[1]).ctx).toBe('ctx2');
  });
});
