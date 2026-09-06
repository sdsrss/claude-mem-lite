// P2-15 — the runtime dir had no age gate for per-project markers.
//
// RUNTIME_DIR already sweeps three shapes: per-SESSION files at 24h
// (pre-recall cooldowns, injected-ids and keyctx markers — hook.mjs) and
// orphaned episode/read trackers at 1h/24h (sweepOrphanEpisodeFiles). What had
// no gate at all was the per-PROJECT family: one file per project, written once
// and never revisited. Live install 2026-08-16: 253 files, 152 older than 30
// days, including whole families for test sandboxes deleted months ago
// (session-tmp--sdscc-e2e-*, cite-recall-scratchpad--fixture-*), and
// .skill-reco-cooldown-* with no reclamation path whatsoever.
//
// The gate is a 30-day mtime sweep over a NAMED family list, not a wildcard —
// because several same-shaped markers must survive at any age: deleting them
// re-triggers a side effect rather than just re-deriving state. Both directions
// are pinned here; the exclusion half is the one that matters, since a "sweep
// everything stale" rewrite would silently re-arm those side effects.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { readdirSync as _rd } from 'fs';
import {
  sweepStaleProjectMarkers,
  sentinelPrefixesFromShell,
  STALE_PROJECT_MARKER_AGE_MS,
  GC_PROJECT_MARKER_PREFIXES,
  GC_PRESERVED_MARKER_PREFIXES,
} from '../hook-shared.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rt-gc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function put(name, ageDays) {
  const p = join(dir, name);
  writeFileSync(p, '{}');
  if (ageDays) {
    const t = (Date.now() - ageDays * DAY) / 1000;
    utimesSync(p, t, t);
  }
  return p;
}

describe('sweepStaleProjectMarkers — the age gate', () => {
  it('removes every GC-able family once past the age gate', () => {
    const stale = GC_PROJECT_MARKER_PREFIXES.map((p, i) => put(`${p}projects--gone-${i}`, 45));
    const n = sweepStaleProjectMarkers(dir);
    expect(n).toBe(stale.length);
    for (const p of stale) expect(existsSync(p), `${p} should be swept`).toBe(false);
  });

  it('leaves the same families alone while they are fresh', () => {
    const fresh = GC_PROJECT_MARKER_PREFIXES.map((p, i) => put(`${p}projects--live-${i}`, 3));
    expect(sweepStaleProjectMarkers(dir)).toBe(0);
    for (const p of fresh) expect(existsSync(p), `${p} should survive`).toBe(true);
  });

  it('NEVER removes a preserved marker, however old', () => {
    // These are not caches: .auto-adopt-* removal re-attempts a write into the
    // user's project CLAUDE.md, and the migration sentinels re-run their
    // one-time work. Saving 13-45 bytes is not worth re-arming either.
    const kept = GC_PRESERVED_MARKER_PREFIXES.map((p, i) => put(`${p}projects--ancient-${i}`, 400));
    expect(sweepStaleProjectMarkers(dir)).toBe(0);
    for (const p of kept) expect(existsSync(p), `${p} must be preserved`).toBe(true);
  });

  it('preserved beats GC-able when one prefix nests inside the other', () => {
    // With the shipped lists this cannot happen — which is exactly why it needs
    // injected lists to test. Without the precedence check, a future family
    // nested inside a GC-able one would be deleted the day it lands, and the
    // only symptom would be a side effect quietly re-firing.
    const doomed = put('x-stale-marker', 400);
    const kept = put('x-keep-me-marker', 400);
    const n = sweepStaleProjectMarkers(dir, {
      gcPrefixes: ['x-'],
      preservedPrefixes: ['x-keep-'],
    });
    expect(n).toBe(1);
    expect(existsSync(doomed)).toBe(false);
    expect(existsSync(kept), 'the nested preserved prefix must win').toBe(true);
  });

  it('ignores files belonging to no known family', () => {
    const other = put('some-unrelated-file.json', 400);
    const dbLike = put('mcp-server-state', 400);
    expect(sweepStaleProjectMarkers(dir)).toBe(0);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(dbLike)).toBe(true);
  });

  it('honours an explicit ageMs and a injected clock', () => {
    put('session-projects--x', 10);
    expect(sweepStaleProjectMarkers(dir, { ageMs: 30 * DAY })).toBe(0);
    expect(sweepStaleProjectMarkers(dir, { ageMs: 5 * DAY })).toBe(1);
  });

  it('CLAUDE_MEM_SKIP_MARKER_GC=1 disables the sweep entirely', () => {
    // Released-artifact requirement: a new default that DELETES user files ships
    // with a documented way back out.
    const p = put('session-projects--x', 400);
    expect(sweepStaleProjectMarkers(dir, { env: { CLAUDE_MEM_SKIP_MARKER_GC: '1' } })).toBe(0);
    expect(existsSync(p)).toBe(true);
    expect(sweepStaleProjectMarkers(dir, { env: {} })).toBe(1);
  });

  it('returns 0 rather than throwing on a missing runtime dir', () => {
    expect(sweepStaleProjectMarkers(join(dir, 'nope'))).toBe(0);
  });

  it('defaults to a 30-day gate', () => {
    expect(STALE_PROJECT_MARKER_AGE_MS).toBe(30 * DAY);
  });

  it('keeps the two family lists disjoint', () => {
    // A prefix in both lists would make the outcome depend on iteration order.
    for (const g of GC_PROJECT_MARKER_PREFIXES) {
      for (const k of GC_PRESERVED_MARKER_PREFIXES) {
        expect(g === k, `${g} appears in both lists`).toBe(false);
      }
    }
  });

  it('does not claim families another sweeper already owns', () => {
    // reads-*.txt / ep-flush-* / pending-* belong to sweepOrphanEpisodeFiles at
    // 1h/24h; ep-<project>.json holds UNFLUSHED observations and is nobody's to
    // delete on an age gate. Double ownership would mean two different cutoffs
    // racing over the same file.
    for (const p of ['reads-', 'ep-flush-', 'pending-', 'ep-']) {
      expect(GC_PROJECT_MARKER_PREFIXES).not.toContain(p);
    }
  });
});

describe('shell-written one-shot sentinels are never GC-able (v3.66.1 HIGH-1)', () => {
  // The regression this replaces: `.mcp-dedup-` was put in the GC list because a
  // grep for its writer used `--include=*.mjs --include=*.js`, and the writer is
  // scripts/setup.sh. Deleting it re-ran a migration that strips
  // mcpServers.mem / mcpServers["mem-lite"] from the user's ~/.claude.json with a
  // raw writeFileSync — a config file this project does not own. Its mtime never
  // refreshes (the gate skips the block once the file exists), so every install
  // older than 30 days would lose it on the first SessionStart after upgrading.
  //
  // Deriving the list FROM the shell source is the point: a new sentinel added to
  // setup.sh tomorrow is covered without anyone remembering to update a list.
  const shell = _rd(join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.sh'))
    .map((f) => readFileSync(join(ROOT, 'scripts', f), 'utf8'))
    .join('\n');

  const prefixes = sentinelPrefixesFromShell(shell);

  it('finds the sentinels it is supposed to guard', () => {
    // Anti-vacuity: an extractor that returns [] would make the guard below pass
    // no matter what the GC list contains.
    expect(prefixes.length).toBeGreaterThanOrEqual(2);
    expect(prefixes).toContain('.mcp-dedup-');
    expect(prefixes).toContain('.residue-warned-');
  });

  it('none of them is in the GC list', () => {
    const leaked = prefixes.filter((p) => GC_PROJECT_MARKER_PREFIXES.includes(p));
    expect(leaked).toEqual([]);
  });

  it('each is explicitly preserved', () => {
    const unprotected = prefixes.filter((p) => !GC_PRESERVED_MARKER_PREFIXES.includes(p));
    expect(unprotected).toEqual([]);
  });

  it('a sentinel survives the sweep at any age', () => {
    for (const pre of prefixes) put(`${pre}v9.9.9`, 400);
    expect(sweepStaleProjectMarkers(dir)).toBe(0);
    expect(_rd(dir).length).toBe(prefixes.length);
  });
});

describe('wiring', () => {
  it('SessionStart runs the sweep', () => {
    const src = readFileSync(join(ROOT, 'hook.mjs'), 'utf8');
    expect(src).toMatch(/\bsweepStaleProjectMarkers\(/);
  });

  it('the GC list carries no prefix nothing writes any more', () => {
    // R10 P3-5. `.skill-cooldown-` / `.skill-reco-cooldown-` outlived the skill registry
    // that wrote them (removed in v5.0.0) and sat in the sweep list for a round, matching
    // nothing on every SessionStart. Pinning their ABSENCE is the check the suite could not
    // make for itself: a dead prefix costs nothing visible, so nothing ever goes red for it.
    for (const dead of ['.skill-cooldown-', '.skill-reco-cooldown-']) {
      expect(GC_PROJECT_MARKER_PREFIXES).not.toContain(dead);
      expect(GC_PRESERVED_MARKER_PREFIXES).not.toContain(dead);
    }
    // And the gate that WAS missing from both lists is now in the reclaimable one.
    expect(GC_PROJECT_MARKER_PREFIXES).toContain('last-mark-compressible-');
  });

  it('the preserved list still covers every side-effecting sentinel', () => {
    // Named explicitly so adding a new "adopt once" / "migrate once" marker
    // without classifying it shows up here rather than as silent data loss.
    for (const p of ['.auto-adopt-', '.deferred-block-migrated-', '.legacy-claude-md-cleaned-']) {
      expect(GC_PRESERVED_MARKER_PREFIXES).toContain(p);
    }
  });

  it('sweeps a realistic mixed directory to exactly the intended set', () => {
    put('session-tmp--sdscc-e2e-abc', 90); // deleted test sandbox
    put('cite-recall-scratchpad--fixture-1.json', 90);
    put('last-mark-compressible-projects--moa.json', 90); // per-project auto-compress gate
    put('.auto-adopt-projects--moa', 90); // preserved
    put('.deferred-block-migrated-projects--moa', 90); // preserved
    put('ep-projects--moa.json', 90); // not ours
    put('session-projects--mem', 1); // active project
    expect(sweepStaleProjectMarkers(dir)).toBe(3);
    expect(readdirSync(dir).sort()).toEqual([
      '.auto-adopt-projects--moa',
      '.deferred-block-migrated-projects--moa',
      'ep-projects--moa.json',
      'session-projects--mem',
    ]);
  });
});
