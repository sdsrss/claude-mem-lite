// The gate baseline's expiry date is written down in THREE places and only one of them is
// machine-readable. `benchmark/baseline.json` carries the real `timestamp`; `ci.yml` and
// `CLAUDE.md` each restate the derived expiry in prose, for a human deciding whether to
// recapture before tagging. CLAUDE.md states the rule itself: "they must be changed
// together".
//
// They were not. `203a426` recaptured the baseline and moved ci.yml's comment — its own
// message even cites R10 P3-23, "a hand-copied stamp goes stale silently" — and left
// CLAUDE.md naming the PREVIOUS sample (2026-09-06T19:48:29Z, expiring 2026-10-06). So the
// same defect the commit was guarding against happened in the third surface, which nobody
// had enumerated. That is what this file pins.
//
// Why it is worth a test rather than a habit: the failure it prevents lands AFTER the tag
// is pushed (publish.yml's gate is strict and runs inside `validate`), and CLAUDE.md is the
// document a release session actually reads to decide "is the baseline still fresh?". A
// stamp that is 31 days optimistic reads as "plenty of time" on the day it goes red.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// dirname+join, never new URL(...) — the URL form drops the named module out of knip's
// report entirely (see tests/no-url-module-paths.test.mjs).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// Both prose surfaces bold parts of the stamp in markdown. Strip the emphasis characters
// so the assertion is about the DATE, not about where the asterisks fell.
const unbold = (s) => s.replace(/[*`]/g, '');

const DAY_MS = 86_400_000;

describe('the gate baseline expiry is stamped identically in all three places', () => {
  const baseline = JSON.parse(read('benchmark/baseline.json'));
  const gateSrc = read('benchmark/ci-gate.mjs');

  // Premise, asserted rather than remembered: the +N days below is the constant the SHIPPED
  // gate actually enforces. If someone retunes the window, this test must move with it
  // instead of pinning three files to a stale arithmetic.
  const ageMatch = gateSrc.match(/const BASELINE_STALE_AGE_DAYS\s*=\s*(\d+)/);
  const staleDays = ageMatch ? Number(ageMatch[1]) : NaN;

  const sampledMs = Date.parse(baseline.timestamp);
  const sampledStamp = new Date(sampledMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expiry = new Date(sampledMs + staleDays * DAY_MS).toISOString();
  const expiryStamp = `${expiry.slice(0, 10)} ${expiry.slice(11, 16)}`;

  it('reads the stale-age window from the gate itself', () => {
    expect(ageMatch).not.toBeNull();
    expect(staleDays).toBeGreaterThan(0);
    // The gate's own test is `floor((now - timestamp) / DAY) >= N`, so expiry is
    // timestamp + N days exactly. Both comments below state that instant.
    expect(gateSrc).toContain('BASELINE_STALE_AGE_DAYS');
  });

  it('has a parseable timestamp in benchmark/baseline.json', () => {
    expect(Number.isFinite(sampledMs)).toBe(true);
  });

  it('ci.yml names the sampled stamp and the derived expiry', () => {
    const ci = unbold(read('.github/workflows/ci.yml'));
    expect(ci).toContain(sampledStamp);
    expect(ci).toContain(expiryStamp);
  });

  it('CLAUDE.md names the sampled stamp and the derived expiry', () => {
    const md = unbold(read('CLAUDE.md'));
    expect(md).toContain(sampledStamp);
    expect(md).toContain(expiryStamp);
  });

  it('leaves no OTHER expiry date in either prose surface', () => {
    // The failing shape is not a missing date, it is a SECOND one: a recapture that adds
    // the new stamp while the old sentence survives elsewhere in the file reads as two
    // deadlines, and a human picks the wrong one. Every `red from <date>` in either file
    // must name the current expiry.
    const surfaces = [
      ['.github/workflows/ci.yml', unbold(read('.github/workflows/ci.yml'))],
      ['CLAUDE.md', unbold(read('CLAUDE.md'))],
    ];
    for (const [name, text] of surfaces) {
      const claimed = [...text.matchAll(/red from (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/g)].map((m) => m[1]);
      expect(claimed.length, `${name} states no expiry at all`).toBeGreaterThan(0);
      for (const c of claimed) expect(c, `${name} names a stale expiry`).toBe(expiryStamp);
    }
  });
});
