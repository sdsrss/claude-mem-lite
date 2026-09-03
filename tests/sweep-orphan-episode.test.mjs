// Tests for sweepOrphanEpisodeFiles — the SessionStart auto-maintain helper
// that removes crashed `ep-flush-*` / `pending-*` runtime files (1h floor),
// abandoned `reads-*.txt` Read trackers (24h floor) and abandoned per-project
// episode buffers `ep-<project>.json` (7d floor). Locks the age-gated
// contract: in-flight episode files AND active read sessions (mtime newer than
// their respective cutoff) are NEVER touched, only orphans are reaped.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sweepOrphanEpisodeFiles } from '../hook-shared.mjs';

describe('sweepOrphanEpisodeFiles', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-orphan-'));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function writeWithMtime(name, ageMs) {
    const full = join(dir, name);
    writeFileSync(full, '{}');
    if (ageMs > 0) {
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(full, t, t);
    }
    return full;
  }

  it('returns 0 when the directory does not exist', () => {
    expect(sweepOrphanEpisodeFiles(join(dir, 'missing'))).toBe(0);
  });

  it('returns 0 when no sweep-eligible files exist (unrelated file + fresh reads survive)', () => {
    writeWithMtime('not-an-episode.json', 99 * 3600 * 1000); // never a sweep target
    writeWithMtime('reads-foo.txt', 2 * 3600 * 1000);        // reads tracker, but < 24h → active
    expect(sweepOrphanEpisodeFiles(dir)).toBe(0);
    expect(existsSync(join(dir, 'not-an-episode.json'))).toBe(true);
    expect(existsSync(join(dir, 'reads-foo.txt'))).toBe(true);
  });

  it('sweeps reads-*.txt older than the 24h floor but keeps active (< 24h) ones', () => {
    const abandoned = writeWithMtime('reads-old.txt', 25 * 3600 * 1000); // 25h → abandoned
    const active = writeWithMtime('reads-active.txt', 12 * 3600 * 1000);  // 12h → long read session
    expect(sweepOrphanEpisodeFiles(dir)).toBe(1);
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(active)).toBe(true);
  });

  it('sweeps ep-flush-* files older than ageMs', () => {
    const stale = writeWithMtime('ep-flush-1234-aaaa.json', 2 * 3600 * 1000); // 2h old
    expect(sweepOrphanEpisodeFiles(dir, { ageMs: 60 * 60 * 1000 })).toBe(1);
    expect(existsSync(stale)).toBe(false);
  });

  it('sweeps pending-* files older than ageMs', () => {
    const stale = writeWithMtime('pending-xyz.json', 2 * 3600 * 1000);
    expect(sweepOrphanEpisodeFiles(dir, { ageMs: 60 * 60 * 1000 })).toBe(1);
    expect(existsSync(stale)).toBe(false);
  });

  it('sweeps a leaked lock-contended claim file (.claim-) older than ageMs, keeps fresh (R3 H-L1)', () => {
    const stale = writeWithMtime('ep-myproj.json.claim-1234-9999', 2 * 3600 * 1000);
    const fresh = writeWithMtime('ep-myproj.json.claim-5678-1111', 5 * 60 * 1000);
    expect(sweepOrphanEpisodeFiles(dir, { ageMs: 60 * 60 * 1000 })).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('does NOT touch in-flight files (mtime newer than cutoff)', () => {
    const fresh = writeWithMtime('ep-flush-fresh.json', 5 * 60 * 1000); // 5 min old
    const stale = writeWithMtime('ep-flush-stale.json', 2 * 3600 * 1000); // 2h old
    expect(sweepOrphanEpisodeFiles(dir, { ageMs: 60 * 60 * 1000 })).toBe(1);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it('only matches known prefixes (ep-flush/pending/reads) — no over-broad sweep', () => {
    writeWithMtime('ep-flush-orphan.json', 99 * 3600 * 1000);
    writeWithMtime('pending-orphan.json', 99 * 3600 * 1000);
    writeWithMtime('reads-baz.txt', 99 * 3600 * 1000);       // abandoned tracker → swept (>24h)
    writeWithMtime('cite-recall-foo.json', 99 * 3600 * 1000); // cite-recall lives forever
    writeWithMtime('session-bar', 99 * 3600 * 1000);

    expect(sweepOrphanEpisodeFiles(dir)).toBe(3);
    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual(['cite-recall-foo.json', 'session-bar']);
  });

  // ── FLOW-3 (2026-08-29 audit): three of the four crash-residue families were unreachable ──
  //
  // This runtime dir writes four temp-name families, each the middle of a rename-or-unlink
  // pair that leaks if the process dies between the steps. The predicate covered only
  // `.claim-`, whose own comment states exactly that reason. Neither of the other clauses
  // could reach the rest: `reads-<p>.txt.collect-<ts>` does not end in `.txt`, and
  // `ep-<p>.json.tmp-<pid>` does not start with `ep-flush-`.
  describe('crash residue from the rename/unlink window', () => {
    it('sweeps all four families on the SHORT clock, not just .claim-', () => {
      // 2h old: past the 1h residue cutoff, well inside the 24h reads cutoff — so this
      // also pins that residue is clocked as residue, not as a reads tracker.
      const age = 2 * 3600 * 1000;
      writeWithMtime('ep-projects--mem.json.claim-123-999', age);
      writeWithMtime('reads-projects--mem.txt.collect-1699999999', age);
      writeWithMtime('reads-projects--mem.txt.trim-4242', age);
      writeWithMtime('ep-projects--mem.json.tmp-4242', age);

      expect(sweepOrphanEpisodeFiles(dir)).toBe(4);
      expect(readdirSync(dir)).toEqual([]);
    });

    it('leaves residue younger than the 1h cutoff alone', () => {
      // An in-flight rename must never be raced — the reason every clause here is age-gated.
      writeWithMtime('reads-projects--mem.txt.collect-1699999999', 10 * 60 * 1000);
      expect(sweepOrphanEpisodeFiles(dir)).toBe(0);
      expect(readdirSync(dir)).toEqual(['reads-projects--mem.txt.collect-1699999999']);
    });

    it('does not sweep the LIVE episode buffer of a project whose name contains .tmp-', () => {
      // What the end-anchor actually protects. `ep-x.tmp-y.json` is the episode file of a
      // project whose sanitized name contains the token — an UNANCHORED pattern matches it
      // and sweeps it as residue one hour into a session still writing to it.
      //
      // The first version of this case used `reads-x.tmp-y.txt` and proved nothing: that
      // name ends in `.txt`, so `isReads` selects the 24h cutoff whether or not the anchor
      // is there. Dropping the anchor killed no test, and a pre-tag reviewer caught it.
      writeWithMtime('ep-x.tmp-y.json', 2 * 3600 * 1000);
      expect(sweepOrphanEpisodeFiles(dir)).toBe(0);
      expect(readdirSync(dir)).toEqual(['ep-x.tmp-y.json']);
    });

    it('a reads tracker for such a project keeps the 24h clock', () => {
      writeWithMtime('reads-x.tmp-y.txt', 2 * 3600 * 1000);
      expect(sweepOrphanEpisodeFiles(dir)).toBe(0);
      // …and is still swept once it really is abandoned.
      expect(sweepOrphanEpisodeFiles(dir, { readsAgeMs: 3600 * 1000 })).toBe(1);
    });
  });

  // Audit 2026-09-02 P1-12. `ep-<project>.json` is the live per-project episode buffer and
  // had NO reclamation path: not in either marker-GC list, and this sweep only ever matched
  // `ep-flush-`. A real install held four of them for deleted projects, the oldest 53 days.
  // Leaving them is not neutral — readEpisode has no staleness gate, so handleSessionStart
  // flushes whatever it finds, stamping months-old activity with today's date on revisit.
  describe('abandoned per-project episode buffers (7d)', () => {
    it('sweeps a buffer past 7d', () => {
      writeWithMtime('ep-tmp--loop-testing-e2e.ykdcfH.json', 53 * 24 * 3600 * 1000);
      expect(sweepOrphanEpisodeFiles(dir)).toBe(1);
      expect(readdirSync(dir)).toEqual([]);
    });

    it('leaves a buffer inside 7d alone, including one older than every OTHER cutoff', () => {
      // 48h: past the 1h residue cutoff AND past the 24h reads cutoff. If the buffer were
      // clocked by either of those — the mistake a three-way cutoff invites — this is the
      // case that catches it, and a live project idle over a weekend is the real victim.
      writeWithMtime('ep-projects--mem.json', 48 * 3600 * 1000);
      expect(sweepOrphanEpisodeFiles(dir)).toBe(0);
      expect(readdirSync(dir)).toEqual(['ep-projects--mem.json']);
    });

    it('does NOT promote a queued ep-flush-* file to the 7d clock', () => {
      // `ep-flush-<ts>-<uuid>.json` is both `ep-`-prefixed and `.json`-suffixed, so the
      // exclusion in `isStaleBuffer` decides which of two cutoffs it gets. Without it this
      // 2h-old flush file — a crashed worker's leftovers — would survive for a week.
      writeWithMtime('ep-flush-1699999999-abcd1234.json', 2 * 3600 * 1000);
      expect(sweepOrphanEpisodeFiles(dir)).toBe(1);
    });

    it('reports the buffer to onSweep as a distinct kind, before it is unlinked', () => {
      // The one deletion here that discards content rather than residue must be nameable by
      // the caller; everything else is re-derivable. Asserting the file still exists at
      // callback time pins the ordering the log line depends on.
      writeWithMtime('ep-dead-project.json', 8 * 24 * 3600 * 1000);
      writeWithMtime('ep-flush-old.json', 2 * 3600 * 1000);
      const seen = [];
      sweepOrphanEpisodeFiles(dir, { onSweep: (name, kind) => seen.push([name, kind, existsSync(join(dir, name))]) });
      expect(seen).toContainEqual(['ep-dead-project.json', 'buffer', true]);
      expect(seen).toContainEqual(['ep-flush-old.json', 'episode', true]);
    });

    it('a throwing onSweep does not abort the sweep', () => {
      writeWithMtime('ep-dead-project.json', 8 * 24 * 3600 * 1000);
      expect(sweepOrphanEpisodeFiles(dir, { onSweep: () => { throw new Error('logger down'); } })).toBe(1);
      expect(readdirSync(dir)).toEqual([]);
    });

    it('bufferAgeMs is honored so the threshold is not baked into the caller', () => {
      writeWithMtime('ep-dead-project.json', 2 * 24 * 3600 * 1000);
      expect(sweepOrphanEpisodeFiles(dir)).toBe(0);
      expect(sweepOrphanEpisodeFiles(dir, { bufferAgeMs: 24 * 3600 * 1000 })).toBe(1);
    });
  });

  it('honors a custom `now` so callers can pin time for deterministic assertions', () => {
    const t0 = 1_000_000_000_000;
    const stale = writeWithMtime('ep-flush-stale.json', 0);
    utimesSync(stale, (t0 - 2 * 3600 * 1000) / 1000, (t0 - 2 * 3600 * 1000) / 1000);
    expect(sweepOrphanEpisodeFiles(dir, { ageMs: 3600 * 1000, now: t0 })).toBe(1);
  });
});
