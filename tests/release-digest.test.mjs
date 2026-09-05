// Tests for lib/release-digest.mjs — the shared release-signing core used by
// scripts/sign-release.mjs (CI, signs) and hook-update.mjs (client, verifies).
//
// Security properties asserted:
//   1. A valid Ed25519 signature over the manifest bytes verifies true.
//   2. A tampered manifest byte stream fails signature verification.
//   3. A wrong/foreign public key fails verification.
//   4. File-hash verification flags any extracted file whose bytes differ from
//      the signed manifest, and any manifest-listed file missing on disk.
//   5. A clean round-trip (build → serialize → sign → verify files + sig) passes.

import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sha256Hex,
  sha256File,
  buildReleaseManifest,
  serializeManifest,
  verifyReleaseFiles,
  verifyManifestSignature,
} from '../lib/release-digest.mjs';
import { RELEASE_SIGNED_FILES, HOOK_SCRIPT_FILES } from '../source-files.mjs';
import { readFileSync } from 'node:fs';

const dirs = [];
function makeReleaseTree() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-reldigest-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'cli.mjs'), '#!/usr/bin/env node\n// cli\n');
  writeFileSync(join(dir, 'server.mjs'), '// server\n');
  writeFileSync(join(dir, 'lib', 'x.mjs'), '// x\n');
  return dir;
}
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('lib/release-digest', () => {
  const FILES = ['cli.mjs', 'server.mjs', 'lib/x.mjs'];

  it('sha256Hex / sha256File agree and are stable', () => {
    const dir = makeReleaseTree();
    expect(sha256File(join(dir, 'cli.mjs'))).toBe(sha256Hex('#!/usr/bin/env node\n// cli\n'));
  });

  it('buildReleaseManifest lists only existing files with their sha256, sorted', () => {
    const dir = makeReleaseTree();
    const m = buildReleaseManifest(dir, [...FILES, 'does-not-exist.mjs'], '3.7.1');
    expect(m.name).toBe('claude-mem-lite');
    expect(m.version).toBe('3.7.1');
    expect(m.algo).toBe('sha256');
    expect(Object.keys(m.files)).toEqual(['cli.mjs', 'lib/x.mjs', 'server.mjs']); // sorted, missing dropped
    expect(m.files['cli.mjs']).toBe(sha256File(join(dir, 'cli.mjs')));
  });

  it('clean round-trip: build → serialize → sign → verify (files + signature)', () => {
    const dir = makeReleaseTree();
    const { privateKey, publicKeyPem } = keypair();
    const manifest = buildReleaseManifest(dir, FILES, '3.7.1');
    const bytes = serializeManifest(manifest);
    const sigB64 = cryptoSign(null, Buffer.from(bytes), privateKey).toString('base64');

    expect(verifyManifestSignature(bytes, sigB64, publicKeyPem)).toBe(true);
    expect(verifyReleaseFiles(dir, JSON.parse(bytes))).toEqual({ ok: true, mismatches: [], missing: [] });
  });

  it('rejects a tampered manifest byte stream (signature no longer matches)', () => {
    const dir = makeReleaseTree();
    const { privateKey, publicKeyPem } = keypair();
    const bytes = serializeManifest(buildReleaseManifest(dir, FILES, '3.7.1'));
    const sigB64 = cryptoSign(null, Buffer.from(bytes), privateKey).toString('base64');
    const tampered = bytes.replace('3.7.1', '9.9.9');
    expect(verifyManifestSignature(tampered, sigB64, publicKeyPem)).toBe(false);
  });

  it('rejects a foreign public key', () => {
    const dir = makeReleaseTree();
    const { privateKey } = keypair();
    const { publicKeyPem: otherPub } = keypair();
    const bytes = serializeManifest(buildReleaseManifest(dir, FILES, '3.7.1'));
    const sigB64 = cryptoSign(null, Buffer.from(bytes), privateKey).toString('base64');
    expect(verifyManifestSignature(bytes, sigB64, otherPub)).toBe(false);
  });

  it('verifyManifestSignature returns false on empty key/sig instead of throwing', () => {
    expect(verifyManifestSignature('x', 'y', '')).toBe(false);
    expect(verifyManifestSignature('x', '', 'PEM')).toBe(false);
  });

  it('verifyReleaseFiles flags a content mismatch', () => {
    const dir = makeReleaseTree();
    const manifest = buildReleaseManifest(dir, FILES, '3.7.1');
    writeFileSync(join(dir, 'server.mjs'), '// TAMPERED\n');
    const r = verifyReleaseFiles(dir, manifest);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toContain('server.mjs');
  });

  it('verifyReleaseFiles flags a manifest-listed file missing on disk', () => {
    const dir = makeReleaseTree();
    const manifest = buildReleaseManifest(dir, FILES, '3.7.1');
    rmSync(join(dir, 'lib', 'x.mjs'), { force: true });
    const r = verifyReleaseFiles(dir, manifest);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('lib/x.mjs');
  });
});

describe('release signature covers the executable hook scripts (supply-chain gap)', () => {
  it('signs every HOOK_SCRIPT_FILE — copyReleaseIntoStaging installs them + they run on every hook', () => {
    // Regression: buildReleaseManifest was fed SOURCE_FILES only, so the 8 hook scripts
    // (post-tool-use.sh / hook-launcher.mjs / …) that install into the live dir were NEVER
    // in the signed set — an attacker who could publish a release (no signing key) could
    // swap one while every SOURCE_FILES hash still matched → fail-closed verify still passed.
    const manifest = buildReleaseManifest(process.cwd(), RELEASE_SIGNED_FILES, 'test');
    for (const name of HOOK_SCRIPT_FILES) {
      const key = `scripts/${name}`;
      expect(manifest.files[key], `${key} missing from the signed manifest`).toBeTruthy();
      expect(manifest.files[key]).toMatch(/^[a-f0-9]{64}$/); // a real sha256, not a placeholder
    }
    // The signed set must still be a SUPERSET of the runtime .mjs (no accidental narrowing).
    expect(RELEASE_SIGNED_FILES).toContain('server.mjs');
    expect(RELEASE_SIGNED_FILES).toContain('hook.mjs');
  });

  // v3.42 audit HIGH-1: the manifest signed the 8 HOOK_SCRIPT_FILES but NOT the MCP
  // launcher (scripts/launch.mjs — run as the server via .mcp.json) nor setup.sh (run on
  // plugin SessionStart via hooks.json). install.mjs::dedupePluginCacheAndHooks copies
  // launch.mjs/launch-preflight.mjs from the tarball into the plugin cache during repair(),
  // so an attacker who could publish a release without the signing key could swap launch.mjs
  // while every signed hash still matched → RCE as the MCP server. This generalized invariant
  // asserts every scripts/* path EXECUTED by .mcp.json or hooks.json is in the signed set.
  it('signs every scripts/* executed by .mcp.json or hooks.json (launcher RCE gap)', () => {
    const root = process.cwd();
    // Manifests declare the FIRST-order entry points; the scripts they spawn are
    // second-order and invisible to a manifest-only scan. scripts/setup.sh
    // spawning scripts/binding-probe-cli.mjs (which runs `npm rebuild`) is
    // exactly that shape — signed by hand in v3.60.1 with nothing enforcing it.
    // Scanning the executed scripts themselves makes the invariant transitive.
    const raw = [
      join(root, '.mcp.json'),
      join(root, 'hooks', 'hooks.json'),
      join(root, 'scripts', 'setup.sh'),
      join(root, 'scripts', 'launch.mjs'),
    ]
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
    // Extract every scripts/<file>.(mjs|js|sh) token referenced as an executed command.
    const executed = [...new Set([...raw.matchAll(/scripts\/[\w.-]+\.(?:mjs|js|sh)/g)].map((m) => m[0]))];
    expect(executed.length, 'expected to find executed scripts/* references').toBeGreaterThan(0);
    const manifest = buildReleaseManifest(root, RELEASE_SIGNED_FILES, 'test');
    const unsigned = executed.filter((rel) => !manifest.files[rel]);
    expect(unsigned, `\nexecuted but UNSIGNED scripts:\n  ${unsigned.join('\n  ')}\n`).toEqual([]);
  });

  // launch-preflight.mjs is imported+executed by launch.mjs (the MCP server) but is not
  // itself referenced in .mcp.json, so the token scan above can't see it. Assert explicitly.
  it('signs scripts/launch-preflight.mjs (imported+executed by the MCP launcher)', () => {
    const manifest = buildReleaseManifest(process.cwd(), RELEASE_SIGNED_FILES, 'test');
    expect(
      manifest.files['scripts/launch-preflight.mjs'],
      'launch-preflight.mjs missing from signed manifest',
    ).toMatch(/^[a-f0-9]{64}$/);
  });
});
