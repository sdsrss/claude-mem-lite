// lib/release-digest.mjs — shared release-signing core (P1 supply-chain hardening).
//
// One source of truth for BOTH sides of the auto-update authenticity check so the
// CI signer and the runtime verifier can never drift:
//   * scripts/sign-release.mjs (CI) — builds the manifest, serializes it, signs
//     the EXACT serialized bytes with an Ed25519 private key (a GitHub secret),
//     and uploads release-manifest.json (+ .sig) as GitHub Release assets.
//   * hook-update.mjs (client) — downloads those assets, verifies the signature
//     over the downloaded manifest bytes with an EMBEDDED public key, then checks
//     each extracted file's sha256 against the signed manifest.
//
// Why content hashes, not a tarball-byte hash: GitHub's on-the-fly git-archive
// tarballs are not guaranteed byte-stable over time, but the FILE CONTENTS at a
// tag are (they are the git blobs). Hashing the extracted files sidesteps the
// archive-byte-stability problem entirely.
//
// Why verify over the downloaded file bytes (not a re-serialization): the client
// verifies the signature against the manifest bytes exactly as downloaded and
// only THEN parses it — so there is no canonical-JSON drift between signer and
// verifier. serializeManifest() exists so CI writes precisely what it signs.
//
// Pure Node built-ins (node:crypto Ed25519) — zero dependencies, no `gh`/cosign
// needed on the user's machine, works in the silent SessionStart hook.

import { createHash, verify as cryptoVerify } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_NAME = 'claude-mem-lite';

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(absPath) {
  return sha256Hex(readFileSync(absPath));
}

/**
 * Build a release manifest: { name, version, algo, files: { <relPath>: <sha256> } }.
 * Only files that exist under rootDir are listed; keys are sorted so the
 * serialization is deterministic regardless of fileList order.
 *
 * @param {string} rootDir   Extracted release root (or CI checkout root)
 * @param {string[]} fileList Relative paths to hash (typically SOURCE_FILES)
 * @param {string} version   Release version (for the manifest body)
 */
export function buildReleaseManifest(rootDir, fileList, version) {
  const files = {};
  for (const rel of [...fileList].sort()) {
    const abs = join(rootDir, rel);
    if (existsSync(abs)) files[rel] = sha256File(abs);
  }
  return { name: PACKAGE_NAME, version, algo: 'sha256', files };
}

/**
 * Deterministic byte serialization. CI writes EXACTLY this to
 * release-manifest.json and signs these bytes; the client verifies the signature
 * against the downloaded file bytes (it does not re-serialize), so signer and
 * verifier cannot disagree on canonical form.
 */
export function serializeManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * Verify every file the manifest lists matches its signed sha256 on disk.
 * Returns { ok, mismatches: string[], missing: string[] }.
 * A content change → mismatches; a manifest-listed file absent → missing.
 * Both are failures (ok=false).
 */
export function verifyReleaseFiles(rootDir, manifest) {
  const mismatches = [];
  const missing = [];
  const files = (manifest && manifest.files) || {};
  for (const [rel, expected] of Object.entries(files)) {
    const abs = join(rootDir, rel);
    if (!existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    if (sha256File(abs) !== expected) mismatches.push(rel);
  }
  return { ok: mismatches.length === 0 && missing.length === 0, mismatches, missing };
}

/**
 * Verify an Ed25519 signature over the manifest bytes. Never throws — a malformed
 * key/signature/algorithm returns false so callers can treat "can't verify" the
 * same as "invalid" without a try/catch at every call site.
 *
 * @param {Buffer|string} manifestBytes The EXACT manifest bytes that were signed
 * @param {string} signatureB64         Base64-encoded Ed25519 signature
 * @param {string} publicKeyPem         SPKI PEM public key
 * @returns {boolean}
 */
export function verifyManifestSignature(manifestBytes, signatureB64, publicKeyPem) {
  try {
    if (!publicKeyPem || !signatureB64) return false;
    const data = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes);
    const sig = Buffer.from(signatureB64, 'base64');
    if (sig.length === 0) return false;
    // `null` algorithm = Ed25519 (the key type carries the algorithm in Node).
    return cryptoVerify(null, data, publicKeyPem, sig);
  } catch {
    return false;
  }
}
