// ARCH-2 (2026-08-29 audit): the pre-recall cooldown path rule had three copies.
//
// scripts/pre-tool-recall.js WRITES the file; lib/cite-back-hint.mjs and
// lib/edge-attribution.mjs READ it. Each derived the name itself — same sanitize regex,
// same 64-char cap, same prefix, written out three times. Two of the three carried a
// comment saying the copies must agree and that drift silently zeros the surface, which
// is the tell: a writer and a reader disagreeing does not throw, it reads a file nobody
// wrote. Only the pre-tool-recall/cite-back pair had a test; the edge-attribution copy —
// whose drift zeros Stop-side attribution — did not.
//
// The stated reason for copying (#8447: keep the standalone hook fast path import-free)
// was retired by v3.80.0, which already imports lib modules into that script.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { cooldownPathFor, cooldownSessionKey, COOLDOWN_FILE_PREFIX } from '../lib/cooldown-path.mjs';
import { readPreRecallFileEdges } from '../lib/edge-attribution.mjs';
import { loadCiteBackForEpisode } from '../lib/cite-back-hint.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/**
 * The literal that used to be copy-pasted into all three consumers.
 *
 * Anchored on the SESSION id on purpose. The bare sanitize idiom also appears on an
 * unrelated, project-keyed file (`cite-recall-<project>.json` in cite-back-hint.mjs), and
 * a scan for the idiom alone flagged it — one site with no second copy to drift against
 * is not this defect, and a guard that cries about it would be turned off.
 */
// `\s*` before `.replace`: a formatter breaks the method chain across lines, and this
// rule is about the IDIOM having one home, not about it fitting on one line (P1-3).
const SANITIZE_RULE = /String\((sessionId|ccSessionId)\)\s*\.replace\(\/\[\^a-zA-Z0-9_\.-\]\/g/;

let runtimeDir;
beforeEach(() => {
  runtimeDir = join(mkdtempSync(join(tmpdir(), 'mem-cooldown-')), 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
});
afterEach(() => {
  try {
    rmSync(runtimeDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('cooldown path — one definition', () => {
  it('sanitizes and caps the session key', () => {
    expect(cooldownSessionKey('abc-123_x.y')).toBe('abc-123_x.y');
    expect(cooldownSessionKey('../../etc/passwd')).toBe('.._.._etc_passwd'.replace(/_/g, '-'));
    expect(cooldownSessionKey('x'.repeat(200))).toHaveLength(64);
    expect(cooldownPathFor('/rt', 'sess1')).toBe(`/rt/${COOLDOWN_FILE_PREFIX}sess1.json`);
  });

  it('both readers resolve the file the shared writer names', () => {
    // Behavioural, not a name comparison: write at the shared path, then require each
    // reader to find it through its OWN resolution. A reader that kept a private copy of
    // the rule and drifted would return empty here — which is exactly how the defect
    // presents in production, silently.
    const sessionId = 'cc/session:99'; // needs sanitizing, so a naive join would differ
    writeFileSync(
      cooldownPathFor(runtimeDir, sessionId),
      JSON.stringify({
        '/p/scoring-sql.mjs': { ts: Date.now(), obsIds: [4242], lessonIds: [4242] },
      }),
    );

    const edges = readPreRecallFileEdges(runtimeDir, sessionId);
    expect(edges, 'edge-attribution must resolve the same path').toEqual([
      { filePath: '/p/scoring-sql.mjs', obsIds: [4242] },
    ]);

    const hint = loadCiteBackForEpisode(
      { sessionId, entries: [{ tool: 'Edit', files: ['/p/scoring-sql.mjs'], isError: false }] },
      runtimeDir,
    );
    expect(hint, 'cite-back must resolve the same path').toBeTruthy();
    expect(hint).toContain('#4242');
  });

  it('DISCRIMINATOR: a reader using a different key finds nothing', () => {
    // Anti-vacuity for the case above. If the sanitized and unsanitized names happened to
    // coincide, that test would pass with the readers still drifting.
    const sessionId = 'cc/session:99';
    writeFileSync(
      cooldownPathFor(runtimeDir, sessionId),
      JSON.stringify({
        '/p/a.mjs': { ts: Date.now(), obsIds: [1] },
      }),
    );
    expect(basename(cooldownPathFor(runtimeDir, sessionId))).not.toContain('/'); // the id really was rewritten
    expect(readPreRecallFileEdges(runtimeDir, 'cc-session-98')).toEqual([]);
  });

  it('no consumer re-derives the rule', () => {
    // The class guard. Three copies existed because nothing stopped the third; nothing
    // would stop a fourth.
    for (const rel of [
      '../scripts/pre-tool-recall.js',
      '../lib/cite-back-hint.mjs',
      '../lib/edge-attribution.mjs',
    ]) {
      const src = read(rel);
      expect(src, `${rel} must not re-derive the sanitize rule`).not.toMatch(SANITIZE_RULE);
      expect(src, `${rel} must import the shared definition`).toMatch(/cooldown-path\.mjs'/);
      expect(src, `${rel} must not rebuild the filename`).not.toMatch(/pre-recall-cooldown-\$\{/);
    }
  });

  it('the scan can say NO', () => {
    // `not.toMatch` passes trivially on a pattern that matches nothing. Feed it the line
    // that actually shipped in all three files.
    const shipped = "const safe = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64);";
    expect(shipped).toMatch(SANITIZE_RULE);
    // …and the shared module is where it is allowed to live.
    expect(read('../lib/cooldown-path.mjs')).toMatch(SANITIZE_RULE);
  });
});
