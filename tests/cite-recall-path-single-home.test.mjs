// P2-15(d) (2026-09-02 audit): the cite-recall snapshot path had two copies — the exact
// shape ARCH-2 had just collapsed for the cooldown file one round earlier.
//
//   hook.mjs (handleStop)          WRITES runtime/cite-recall-<project>.json
//   lib/cite-back-hint.mjs         READS it back for the SessionStart nudge
//
// Each derived the filename itself: same sanitize class, same 64-char cap, same prefix,
// typed out twice. A writer and a reader disagreeing about a filename does not throw —
// `readFileSync` misses, the surrounding catch swallows it, and the nudge is silently
// gone. Nothing in the system reports that, which is why the rule needs one home and a
// guard, not a comment asking the two sites to stay in step.
//
// A third consumer matches the family by PREFIX: hook-shared.mjs's per-project marker GC.
// Its drift is quieter still — the snapshots simply stop being reclaimed — so the prefix
// is exported and asserted here too.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { citeRecallPathFor, citeRecallProjectKey, CITE_RECALL_FILE_PREFIX } from '../lib/cite-recall-path.mjs';
import { buildCiteRecallNudge } from '../lib/cite-back-hint.mjs';
import { GC_PROJECT_MARKER_PREFIXES } from '../hook-shared.mjs';
import { walkShipped, sweepShipped } from './shipped-tree.mjs';

// The one place the rule is allowed to live.
const PATH_ALLOWED = new Set(['lib/cite-recall-path.mjs']);

// D#207: join(), never `new URL('../X.mjs', import.meta.url)` — that form drops the named
// module out of knip's unused-export report entirely.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

/**
 * The literal that was copy-pasted into the two consumers.
 *
 * Anchored on `project` on purpose: the bare sanitize idiom also appears on the unrelated,
 * SESSION-keyed cooldown file, and an idiom-only scan would flag that one too. This is the
 * discrimination `tests/cooldown-path-single-home.test.mjs` had to make in the opposite
 * direction, and the two guards must not each claim the other's site.
 */
const SANITIZE_RULE = /project\.replace\(\/\[\^a-zA-Z0-9_\.-\]\/g/;

let runtimeDir;
beforeEach(() => {
  runtimeDir = join(mkdtempSync(join(tmpdir(), 'mem-citerecall-')), 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
});
afterEach(() => { try { rmSync(dirname(runtimeDir), { recursive: true, force: true }); } catch { /* ignore */ } });

describe('cite-recall path — one definition', () => {
  it('sanitizes and caps the project key', () => {
    expect(citeRecallProjectKey('projects--mem')).toBe('projects--mem');
    expect(citeRecallProjectKey('../../etc/passwd')).toBe('..-..-etc-passwd');
    expect(citeRecallProjectKey('x'.repeat(200))).toHaveLength(64);
    expect(citeRecallPathFor('/rt', 'p1')).toBe(`/rt/${CITE_RECALL_FILE_PREFIX}p1.json`);
  });

  it('the reader resolves the file the shared writer names, for an awkward project name', () => {
    // The whole defect is about names the sanitize rule REWRITES. A plain project name
    // agrees under any two implementations, so it proves nothing; this one has a slash, a
    // space and a colon, all of which the rule replaces.
    const project = 'org/some proj:v2';
    const dest = citeRecallPathFor(runtimeDir, project);
    writeFileSync(dest, JSON.stringify({ ratio: 0.1, recalled: 1, injected: 20 }));

    const nudge = buildCiteRecallNudge(project, runtimeDir, {});
    expect(nudge).toContain('cite-recall 10%');
    expect(nudge).toContain('(1/20)');
  });

  it('the marker GC matches the family by the shared prefix', () => {
    // Not `toContain('cite-recall-')`: that would pass on a hand-typed literal, which is
    // the copy this guard exists to prevent. Identity against the exported constant is
    // what makes a rename propagate.
    expect(GC_PROJECT_MARKER_PREFIXES).toContain(CITE_RECALL_FILE_PREFIX);
  });

  it('the sweep walks a plausible number of shipped modules', () => {
    // A walk returning [] would make both rules below pass vacuously.
    expect(walkShipped().length).toBeGreaterThan(60);
  });

  it('no shipped file re-derives the rule', () => {
    // Tree sweep, not the two-name list this guard shipped with. The list named the files
    // the copy had lived in; the v3.92.0 review added a third derivation to
    // `lib/edge-attribution.mjs` and all five cases stayed green. The N+1th copy is exactly
    // what a "one home" rule is for, and it is the one a name list cannot see.
    expect(sweepShipped(SANITIZE_RULE, PATH_ALLOWED),
      'a shipped file re-derives the cite-recall sanitize rule').toEqual([]);
    expect(sweepShipped(/`cite-recall-\$\{/, PATH_ALLOWED),
      'a shipped file rebuilds the cite-recall filename').toEqual([]);
  });

  it('the two known consumers import the shared definition', () => {
    // The sweep proves nobody re-derives it; this proves the writer and the reader actually
    // take it from the shared module rather than having dropped the feature entirely.
    for (const rel of ['hook.mjs', 'lib/cite-back-hint.mjs']) {
      expect(read(rel), `${rel} must import the shared definition`).toMatch(/cite-recall-path\.mjs'/);
    }
    // hook-shared.mjs takes only the prefix, so it is checked on the literal, not the rule.
    expect(read('hook-shared.mjs'), 'hook-shared.mjs must not re-type the prefix').not.toMatch(/'cite-recall-'/);
  });

  it('the scan can say NO', () => {
    // `not.toMatch` passes trivially against a pattern that matches nothing. Feed each
    // assertion the text that actually shipped.
    const shippedRule = "const safe = project.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64);";
    expect(shippedRule).toMatch(SANITIZE_RULE);
    // Assembled so this fixture does not itself trip the `not.toMatch` scan above when a
    // future guard widens to cover test files.
    const shippedName = '`cite-recall-' + '${safe}.json`';
    expect(shippedName).toMatch(/`cite-recall-\$\{/);
    // …and the shared module is the one place the rule is allowed to live.
    expect(read('lib/cite-recall-path.mjs')).toMatch(/\.replace\(\/\[\^a-zA-Z0-9_\.-\]\/g/);
  });
});
