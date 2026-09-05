// Tests for install.mjs::bumpJsonField — the pure JSON-version field bumper
// extracted to fix the pre-2.63.0 plugin.json log glitch ("X → X" instead
// of "prev → X" because the field was read after assignment) and to give
// syncVersions a single point of truth for the 3 JSON files it touches.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bumpJsonField, buildDoctorSummary, patchClaudeMdVersion } from '../install.mjs';

describe('patchClaudeMdVersion', () => {
  // v3.95.1: the pre-fix form replaced the WHOLE line, so the first release after
  // the "this exact string is a release guard" annotation was written silently
  // deleted it. No gate could catch that — publish.yml greps the line's semver
  // prefix and install-e2e asserts the same substring, and both survive a
  // truncated tail. This test is the only thing that can.
  const REAL_LINE = '- **Version**: 3.95.0 — **this exact string is a release guard.**';

  it('preserves the trailing annotation while bumping the version', () => {
    const md = `# CLAUDE.md\n\n${REAL_LINE}\n  next line untouched\n`;
    const out = patchClaudeMdVersion(md, '3.95.1');
    expect(out).toContain('- **Version**: 3.95.1 — **this exact string is a release guard.**');
    expect(out).toContain('next line untouched');
    expect(out).not.toContain('3.95.0');
  });

  it('handles a bare version line with no annotation', () => {
    const out = patchClaudeMdVersion('- **Version**: 1.0.0\n', '2.0.0');
    expect(out).toBe('- **Version**: 2.0.0\n');
  });

  it('returns null when the line is absent, so the caller can warn instead of writing', () => {
    expect(patchClaudeMdVersion('# CLAUDE.md\n\nno version here\n', '2.0.0')).toBeNull();
  });

  it('touches only the first version line and leaves prose versions alone', () => {
    const md = `${REAL_LINE}\n\nSee v3.95.0 in the changelog.\n`;
    const out = patchClaudeMdVersion(md, '3.95.1');
    expect(out).toContain('See v3.95.0 in the changelog.');
    expect(out).toContain('- **Version**: 3.95.1 —');
  });
});

describe('bumpJsonField', () => {
  let dir, file;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bumpfield-'));
    file = join(dir, 'thing.json');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('returns {changed:false} and does not rewrite when value unchanged', () => {
    writeFileSync(file, JSON.stringify({ version: '1.2.3' }, null, 2) + '\n');
    const before = readFileSync(file, 'utf8');
    const r = bumpJsonField(file, ['version'], '1.2.3');
    expect(r).toEqual({ changed: false, prev: '1.2.3' });
    // Content untouched
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('captures prev BEFORE mutation (the pre-fix bug)', () => {
    writeFileSync(file, JSON.stringify({ version: '1.2.3' }, null, 2) + '\n');
    const r = bumpJsonField(file, ['version'], '1.3.0');
    // The pre-fix code logged "1.3.0 → 1.3.0" because it read `pluginJson.version`
    // AFTER `pluginJson.version = version`. The helper guarantees prev is captured first.
    expect(r.prev).toBe('1.2.3');
    expect(r.changed).toBe(true);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.version).toBe('1.3.0');
  });

  it('walks nested keyPath (e.g., marketplace.json plugins[0].version)', () => {
    writeFileSync(file, JSON.stringify({ plugins: [{ name: 'p', version: '0.1.0' }] }, null, 2) + '\n');
    const r = bumpJsonField(file, ['plugins', 0, 'version'], '0.2.0');
    expect(r).toEqual({ changed: true, prev: '0.1.0' });
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.plugins[0].version).toBe('0.2.0');
    expect(after.plugins[0].name).toBe('p'); // siblings preserved
  });

  it('returns {changed:false, prev:undefined} when keyPath unreachable', () => {
    writeFileSync(file, JSON.stringify({ other: 'thing' }, null, 2) + '\n');
    const r = bumpJsonField(file, ['plugins', 0, 'version'], '1.0.0');
    expect(r.changed).toBe(false);
    expect(r.prev).toBeUndefined();
  });

  it('writes file with 2-space indent + trailing newline (matches existing convention)', () => {
    writeFileSync(file, JSON.stringify({ version: '1.0.0' }) + '\n'); // no indent
    bumpJsonField(file, ['version'], '1.0.1');
    const out = readFileSync(file, 'utf8');
    // Re-pretty-printed with 2-space indent + trailing newline
    expect(out).toBe('{\n  "version": "1.0.1"\n}\n');
  });
});

describe('package.json::packageManager pin', () => {
  it('declares npm@10.9.2 so corepack-aware tooling matches CI', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.packageManager).toBe('npm@10.9.2');
  });
});

// Belt-and-suspenders: the previously-shipped buildDoctorSummary helper still works
// after the install.mjs refactor (caught the case where reordering exports breaks something).
describe('buildDoctorSummary (regression after install.mjs refactor)', () => {
  it('still returns the all-passed string', () => {
    expect(buildDoctorSummary(0, 0)).toBe('All checks passed!');
  });
});

// Dogfood-6 regression: `node install.mjs frobnicate` previously fell through to the
// default-case usage dump with no indication that the user's command was unknown — the
// usage block looked the same as `node install.mjs` (no args). Now the dispatcher names
// the offending token + exits 1 before printing usage.
describe('install.mjs unknown-command handling', () => {
  it('names the unknown command and exits non-zero', async () => {
    const { execFileSync } = await import('child_process');
    const { resolve } = await import('path');
    let stderr = '', stdout = '', exitCode = 0;
    // npm_command=exec / npm_lifecycle_event leak in via `npx vitest run` — install.mjs's
    // IS_NPX detection (`process.env.npm_command === 'exec'`) would then enter the auto-install
    // branch instead of the unknown-command branch. Scrub them so the test exercises the
    // CLI-invocation path a human user would hit.
    const env = { ...process.env };
    delete env.npm_command;
    delete env.npm_lifecycle_event;
    delete env.npm_lifecycle_script;
    try {
      execFileSync(process.execPath, [resolve('install.mjs'), 'frobnicate'], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, env,
      });
    } catch (e) {
      stdout = e.stdout?.toString() || '';
      stderr = e.stderr?.toString() || '';
      exitCode = e.status ?? 1;
    }
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown command');
    expect(stderr).toContain('frobnicate');
    // Usage is still printed so the user sees their options inline with the rejection.
    expect(stdout).toContain('Usage');
  });
});

// Dogfood-7 regression: `install cleanup --dry-run` previously silently ignored the
// flag and ran the destructive default. Doctor reports stale-file counts and points
// users at cleanup; --dry-run lets them confirm the file list before committing.
describe('install.mjs cleanup --dry-run', () => {
  it('preview header advertises dry-run mode and does not delete files', async () => {
    const { execFileSync } = await import('child_process');
    const { resolve, join } = await import('path');
    const { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');

    // Sandboxed HOME so we don't touch the real ~/.claude-mem-lite/.
    const home = mkdtempSync(join(tmpdir(), 'cleanup-dryrun-'));
    const installDir = join(home, '.claude-mem-lite');
    const stale = join(installDir, '.update-staging-fake-dryrun');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'marker.txt'), 'placeholder');

    let stdout;
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, [resolve('install.mjs'), 'cleanup', '--dry-run'], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
        env: { ...process.env, HOME: home },
      });
    } catch (e) {
      stdout = e.stdout?.toString() || '';
      exitCode = e.status ?? 1;
    }

    expect(exitCode).toBe(0);
    expect(stdout).toContain('--dry-run');
    expect(stdout).toContain('Would remove');
    expect(stdout).toContain('.update-staging-fake-dryrun');
    // The stale dir must still exist after a dry-run pass.
    expect(existsSync(stale)).toBe(true);

    try { rmSync(home, { recursive: true, force: true }); } catch {}
  });
});
