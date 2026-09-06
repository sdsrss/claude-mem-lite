// The `COALESCE(compressed_into,0)=0` vs `liveObsFilterSql` decision, made enforceable.
//
// liveObsFilterSql is `COALESCE(compressed_into,0)=0 AND superseded_at IS NULL`. A site using
// the first half alone treats a superseded row as live. Whether that matters depends entirely
// on what the site DOES with the row, so the answer is per-site, and it has now been made for
// all 11 shipped sites (R8 §6-a, carried as open in R10 §7, judged 2026-09-06 — zero changes
// warranted). CLAUDE.md's "Invariants that bite" carries the reasoning.
//
// A decision recorded only in prose drifts. This file pins the POPULATION: which functions
// hold a bare predicate, and how many each holds. A new bare predicate in a new function reds
// here, which is the point — the author has to judge it and extend the map, rather than
// inheriting an exemption that was reasoned about someone else's code.
//
// It also pins the other direction: the writers that MUST carry the full predicate still do.
// A guard that only forbids is half a guard — removing liveObsFilterSql from the PENDING_PURGE
// writer is the data-loss shape the invariant exists to prevent, so it gets its own case.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// dirname(fileURLToPath(...)) + join, never new URL(): the URL form drops the named module
// out of knip's report entirely (tests/no-url-module-paths.test.mjs pins this repo-wide).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Bare-predicate sites, by enclosing function. Every entry is adjudicated in CLAUDE.md:
//   markAutoCompressible      writes -1, which purgeStale (-2) and recoverOrphanedChildren
//                             (> 0) both skip — cannot delete or resurface anything
//   cleanupBroken             ) move only importance, inert on a row every read path
//   decayAndMarkIdle          ) already hides (its OTHER arm, the PENDING_PURGE writer,
//   boostAccessed             ) does carry the full predicate — see the case below)
//   demotePinned              )
//   hardDeleteCandidateCount  cleanup arm mirrors cleanupBroken, so forecast == action
//   maintenanceStats          superseded_at IS NULL sits inside the *stale* CASE only, so
//                             each forecast matches the op it predicts
//   computeStatsFeed          one predicate on both halves of a ratio; superseded rows are
//                             reported on their own line
const ADJUDICATED = {
  'lib/maintain-core.mjs': {
    markAutoCompressible: 2,
    cleanupBroken: 1,
    decayAndMarkIdle: 1,
    boostAccessed: 1,
    demotePinned: 1,
    hardDeleteCandidateCount: 1,
    maintenanceStats: 1,
  },
  'lib/stats-core.mjs': {
    computeStatsFeed: 3,
  },
};

// A comment quoting the predicate is not a use of it. Both files discuss it at length, and a
// scan that counts prose is the same failure mode as counting a commented-out import as a
// dependency edge (hit for real in tests/bg-spawn-skip-flag-invariant.test.mjs's first draft).
function isComment(text) {
  const t = text.trim();
  return t.startsWith('//') || t.startsWith('--') || t.startsWith('*') || t.startsWith('/*');
}

const BARE_PREDICATE = /COALESCE\(\s*(?:\w+\.)?compressed_into\s*,\s*0\s*\)\s*=\s*0/;
const FN_DECL = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;

function bareSitesByFunction(relPath) {
  const lines = readFileSync(join(ROOT, relPath), 'utf8').split('\n');
  const counts = {};
  let fn = '<module scope>';
  for (const text of lines) {
    const decl = text.match(FN_DECL);
    if (decl) fn = decl[1];
    if (isComment(text)) continue;
    if (!BARE_PREDICATE.test(text)) continue;
    // A line carrying the full predicate is not a bare site.
    if (text.includes('superseded_at') || text.includes('liveObsFilterSql')) continue;
    counts[fn] = (counts[fn] || 0) + 1;
  }
  return counts;
}

describe('live-row predicate adjudication', () => {
  it('matches the recorded population exactly, file by file', () => {
    for (const [relPath, expected] of Object.entries(ADJUDICATED)) {
      expect(bareSitesByFunction(relPath), relPath).toEqual(expected);
    }
  });

  it('found sites at all — the scan itself can go blind', () => {
    // Premise assertion. If the regex or the function-name matcher breaks, every count drops
    // to zero and `toEqual` above would red loudly — but only because the numbers are pinned.
    // Asserting a non-empty total keeps that true if the map is ever loosened.
    const total = Object.keys(ADJUDICATED)
      .map((p) => Object.values(bareSitesByFunction(p)).reduce((a, b) => a + b, 0))
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(11);
  });

  it('still requires the full predicate where deleting a row destroys superseded_by', () => {
    // The other direction. decayAndMarkIdle's mark-idle arm writes COMPRESSED_PENDING_PURGE,
    // which purgeStale hard-deletes; mergeDuplicates points a row at a keeper. Both must
    // exclude tombstones, and both regressions are silent data loss rather than a wrong count.
    const src = readFileSync(join(ROOT, 'lib/maintain-core.mjs'), 'utf8');
    const pendingPurgeWrite = src.slice(src.indexOf('export function decayAndMarkIdle'));
    expect(pendingPurgeWrite).toMatch(/SET compressed_into = \$\{COMPRESSED_PENDING_PURGE\}/);
    expect(pendingPurgeWrite.slice(0, 2000)).toContain("liveObsFilterSql('')");
    expect(src).toContain(
      "`UPDATE observations SET compressed_into = ? WHERE id = ? AND ${liveObsFilterSql('')}`",
    );
  });
});
