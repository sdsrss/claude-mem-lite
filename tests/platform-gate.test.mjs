// The `os` field in package.json is an npm INSTALL GATE, not a runtime check, and
// scripts/launch.mjs runs `npm install --omit=dev` on every first launch after a plugin
// update (Claude Code materializes each new cache version WITHOUT node_modules). So a
// platform missing from that list does not get a warning — it gets EBADPLATFORM, exit 1,
// a dead stdio server and `CONNECTION_CLOSED` in /mcp, with the launcher's catch block
// asserting three causes ("read-only directory, disk full, or network blocked") none of
// which is the real one. That is issue #28.
//
// The field was added in b6a2579 (R10 P3-19, first shipped v5.1.0) with the stated intent
// that "a Windows user should be told rather than handed a string of silent catch blocks".
// Blocking the install is the opposite of telling: the user learns nothing and loses the
// MCP server, which is Node-only and runs fine (better-sqlite3 13 ships win32-x64 and
// win32-arm64 prebuilds).
//
// Two things are pinned here. (1) `platformAllowed` reproduces npm's OWN checkList
// semantics, negation included — a hand-rolled `list.includes(platform)` disagrees with
// npm on `["!win32"]` and would make the launcher's diagnosis wrong in the one direction
// that matters. (2) The gate runs BEFORE npm, proven behaviourally: the blocked run must
// leave no node_modules behind.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { platformAllowed, readDeclaredPlatforms, platformGate } from '../lib/platform-gate.mjs';

const REPO = resolve(import.meta.dirname, '..');
const fixtures = [];

afterEach(() => {
  for (const d of fixtures.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

/**
 * A launcher-shaped fixture: a real package.json with the given `os`, the real
 * scripts/launch.mjs, and the real lib/platform-gate.mjs it imports. Deliberately NO
 * node_modules — that is what makes launch.mjs take the install branch.
 */
function launcherFixture(osField) {
  const root = mkdtempSync(join(tmpdir(), 'platform-gate-'));
  fixtures.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'lib'));
  const pkg = { name: 'claude-mem-lite', version: '0.0.0-fixture', type: 'module' };
  if (osField !== undefined) pkg.os = osField;
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  copyFileSync(join(REPO, 'scripts', 'launch.mjs'), join(root, 'scripts', 'launch.mjs'));
  copyFileSync(join(REPO, 'lib', 'platform-gate.mjs'), join(root, 'lib', 'platform-gate.mjs'));
  return root;
}

/** Run the fixture's launcher. Returns { status, stderr }. Never throws on non-zero. */
function runLauncher(root) {
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'launch.mjs')], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: root,
        // The outer session may have either of these pointing at a real install; the
        // blocked path must not depend on them, and the control path must not reach them.
        CLAUDE_MEM_DIR: join(root, 'data'),
      },
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stderr: '' };
  } catch (e) {
    return { status: e.status ?? null, stderr: e.stderr || '' };
  }
}

describe('platformAllowed — npm checkList semantics', () => {
  it('accepts a platform named in a plain list, rejects one that is absent', () => {
    expect(platformAllowed(['darwin', 'linux', 'win32'], 'win32')).toBe(true);
    expect(platformAllowed(['darwin', 'linux'], 'win32')).toBe(false);
    expect(platformAllowed(['darwin', 'linux'], 'linux')).toBe(true);
  });

  it('honours negation, which a bare includes() gets backwards', () => {
    // `["!win32"]` means "everything except win32". An includes() check would reject
    // linux here and accept nothing at all — the launcher would then tell a linux user
    // their platform is unsupported while npm installs happily.
    expect(platformAllowed(['!win32'], 'linux')).toBe(true);
    expect(platformAllowed(['!win32'], 'win32')).toBe(false);
    // A negation mixed with an allowlist: the negation still vetoes.
    expect(platformAllowed(['linux', '!win32'], 'win32')).toBe(false);
    expect(platformAllowed(['linux', '!darwin'], 'linux')).toBe(true);
    // Present in neither the allowlist nor the blocklist → the allowlist governs.
    expect(platformAllowed(['linux', '!darwin'], 'freebsd')).toBe(false);
  });

  it('treats ["any"], an empty list and a bare string the way npm does', () => {
    expect(platformAllowed(['any'], 'win32')).toBe(true);
    expect(platformAllowed([], 'win32')).toBe(true);
    expect(platformAllowed('linux', 'linux')).toBe(true);
    expect(platformAllowed('linux', 'win32')).toBe(false);
  });
});

describe('readDeclaredPlatforms / platformGate', () => {
  it('reads the os field, and reports no gate when the field is absent', () => {
    const withOs = launcherFixture(['darwin']);
    const without = launcherFixture(undefined);
    expect(readDeclaredPlatforms(withOs)).toEqual(['darwin']);
    expect(readDeclaredPlatforms(without)).toBeNull();
    // No declaration means npm gates nothing — the launcher must not invent a block.
    expect(platformGate({ root: without, platform: 'win32' }).blocked).toBe(false);
  });

  it('reports blocked with both sides of the mismatch, so the message can name them', () => {
    const root = launcherFixture(['darwin', 'linux']);
    const g = platformGate({ root, platform: 'win32' });
    expect(g.blocked).toBe(true);
    expect(g.declared).toEqual(['darwin', 'linux']);
    expect(g.platform).toBe('win32');
    expect(platformGate({ root, platform: 'linux' }).blocked).toBe(false);
  });

  it('fails OPEN on an unreadable or malformed package.json', () => {
    // The launcher must never turn its own diagnostic into a new failure mode: a torn
    // package.json is the install-incomplete case, which launch-preflight already owns.
    const root = launcherFixture(['darwin']);
    writeFileSync(join(root, 'package.json'), '{ not json');
    expect(readDeclaredPlatforms(root)).toBeNull();
    expect(platformGate({ root, platform: 'win32' }).blocked).toBe(false);
  });
});

describe('scripts/launch.mjs platform gate (issue #28)', () => {
  it('names the real cause, and does so BEFORE running npm', () => {
    // Mirrors the reported failure on this host: declare a list this platform is not in.
    const root = launcherFixture(['sunos']);
    const { status, stderr } = runLauncher(root);

    expect(status, `launcher should refuse, got exit ${status}:\n${stderr}`).toBe(1);
    // Both sides of the mismatch, so the reader does not have to guess which is which.
    expect(stderr).toContain('sunos');
    expect(stderr).toContain(process.platform);
    // The npm error code, so a search for the code users actually see lands here.
    expect(stderr).toContain('EBADPLATFORM');
    // The escape hatch, because for a user who wants to try anyway this is the only way
    // through and it is what the issue reporter had to find for themselves.
    expect(stderr).toContain('--force');
    // The line this replaces asserted three causes, none of which can be this one.
    expect(stderr).not.toContain('read-only directory, disk full, or network blocked');

    // The gate is only worth anything if it PRECEDES the install — npm fails with the same
    // information, and the catch block then mis-attributes it, which is the whole bug.
    //
    // The first version of this assertion checked that no node_modules was created, and a
    // mutation run showed it was vacuous: npm's own EBADPLATFORM exit creates no
    // node_modules either, so deleting the gate's `process.exit(1)` left all nine cases
    // green. What separates the two orderings is what reaches stderr — the launcher's own
    // pre-install marker, and npm's own error prefix, neither of which appears if the gate
    // short-circuited. (Note `npm error` rather than EBADPLATFORM: this launcher's message
    // names that code on purpose, so the code alone cannot tell the two sources apart.)
    expect(stderr, 'npm ran anyway — the gate is placed after the install, not before it').not.toContain(
      'Installing dependencies',
    );
    expect(stderr, 'npm itself reported — the gate did not short-circuit').not.toContain('npm error');
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
  });

  it('the shipped package.json declares win32, so this install path is not blocked', () => {
    // The regression pin. b6a2579 added ["darwin","linux"]; on win32 that turned every
    // post-update MCP launch into CONNECTION_CLOSED.
    const declared = readDeclaredPlatforms(REPO);
    expect(declared, 'package.json#os disappeared — if that is deliberate, delete this case').not.toBeNull();
    expect(platformAllowed(declared, 'win32')).toBe(true);
    expect(platformAllowed(declared, 'linux')).toBe(true);
    expect(platformAllowed(declared, 'darwin')).toBe(true);
  });

  it('package-lock.json carries the same os list as package.json', () => {
    // npm mirrors the root manifest's `os` into the lockfile's root entry, and the release
    // path regenerates the lockfile with npm@10.9.2. A hand-edited package.json with a
    // stale lockfile root is a diff that reads as done and is not.
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
    expect(lock.packages?.['']?.os).toEqual(pkg.os);
  });
});
