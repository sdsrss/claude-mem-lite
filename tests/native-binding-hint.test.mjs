// Tests for lib/native-binding-hint.mjs — the rate-limited friendly hint for an
// unloadable native DB binding (better-sqlite3 ERR_DLOPEN_FAILED). Pure-fn unit
// tests with injected now + tmp runtimeDir; no schema.mjs/better-sqlite3 import.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  nativeBindingHintDue,
  formatHookError,
  NATIVE_BINDING_HINT_COOLDOWN_MS,
} from '../lib/native-binding-hint.mjs';

describe('nativeBindingHintDue', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cml-nbh-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is due on first call and records a marker', () => {
    expect(nativeBindingHintDue(dir, 1_000_000)).toBe(true);
    expect(existsSync(join(dir, 'native-binding-hint-last'))).toBe(true);
  });

  it('suppresses within the cooldown window', () => {
    const t0 = 1_000_000;
    expect(nativeBindingHintDue(dir, t0)).toBe(true);
    expect(nativeBindingHintDue(dir, t0 + NATIVE_BINDING_HINT_COOLDOWN_MS - 1)).toBe(false);
  });

  it('is due again once the cooldown elapses', () => {
    const t0 = 1_000_000;
    expect(nativeBindingHintDue(dir, t0)).toBe(true);
    expect(nativeBindingHintDue(dir, t0 + NATIVE_BINDING_HINT_COOLDOWN_MS + 1)).toBe(true);
  });

  it('is due when the marker content is garbage (best-effort)', () => {
    writeFileSync(join(dir, 'native-binding-hint-last'), 'not-a-number');
    expect(nativeBindingHintDue(dir, 1_000_000)).toBe(true);
  });

  it('writes the marker atomically — no leftover tmp file (#7/#10)', () => {
    nativeBindingHintDue(dir, 1_000_000);
    expect(existsSync(join(dir, 'native-binding-hint-last'))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('suppresses the SAME key but is due again for a DIFFERENT key in-window (#8/#15)', () => {
    const t0 = 1_000_000;
    expect(nativeBindingHintDue(dir, t0, NATIVE_BINDING_HINT_COOLDOWN_MS, 'fault-A')).toBe(true);
    expect(nativeBindingHintDue(dir, t0 + 1000, NATIVE_BINDING_HINT_COOLDOWN_MS, 'fault-A')).toBe(false);
    expect(nativeBindingHintDue(dir, t0 + 2000, NATIVE_BINDING_HINT_COOLDOWN_MS, 'fault-B')).toBe(true);
  });
});

describe('formatHookError', () => {
  const NOW = 1_700_000_000_000; // fixed → deterministic ISO timestamp

  it('formats a non-DLOPEN error as the structured ERROR line', () => {
    const line = formatHookError(new Error('boom'), 'stop', { now: NOW });
    expect(line).toContain('[claude-mem-lite]');
    expect(line).toContain('[ERROR] stop: boom');
  });

  it('collapses ERR_DLOPEN_FAILED to a short WARN rebuild hint', () => {
    const err = Object.assign(
      new Error(
        'The module ... was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version requires 137.',
      ),
      { code: 'ERR_DLOPEN_FAILED' },
    );
    const line = formatHookError(err, 'stop', { now: NOW });
    expect(line).toContain('[WARN] stop:');
    expect(line).toContain('native DB binding');
    // resolvable absolute path, not bare `claude-mem-lite` (off-PATH on plugin
    // installs); `rebuild-binding`, not `repair` — see the rationale on
    // CLI_REBUILD_BINDING in lib/native-binding-hint.mjs
    expect(line).toContain('cli.mjs rebuild-binding');
    expect(line).not.toContain('claude-mem-lite repair');
    // the verbose original message must NOT leak through
    expect(line).not.toContain('NODE_MODULE_VERSION');
  });

  it('rate-limits the DLOPEN hint when a runtimeDir is provided', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cml-nbh-fmt-'));
    try {
      const err = Object.assign(new Error('x'), { code: 'ERR_DLOPEN_FAILED' });
      expect(formatHookError(err, 'stop', { now: NOW, runtimeDir: dir })).not.toBeNull();
      expect(formatHookError(err, 'stop', { now: NOW + 1000, runtimeDir: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT silence a DISTINCT native fault within the cooldown window (#8/#15)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cml-nbh-distinct-'));
    try {
      const errA = Object.assign(new Error('ABI 127 vs 137'), { code: 'ERR_DLOPEN_FAILED' });
      const errB = Object.assign(new Error('corrupt .node at /x/y.node'), { code: 'ERR_DLOPEN_FAILED' });
      // Fault A surfaces, then is suppressed within its window…
      expect(formatHookError(errA, 'stop', { now: NOW, runtimeDir: dir })).not.toBeNull();
      expect(formatHookError(errA, 'stop', { now: NOW + 1000, runtimeDir: dir })).toBeNull();
      // …but a DIFFERENT fault B within the same window must still surface,
      expect(formatHookError(errB, 'stop', { now: NOW + 2000, runtimeDir: dir })).not.toBeNull();
      // and B is then itself suppressed within its window.
      expect(formatHookError(errB, 'stop', { now: NOW + 3000, runtimeDir: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
