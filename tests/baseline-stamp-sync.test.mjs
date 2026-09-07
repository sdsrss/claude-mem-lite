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
//
// THE CLAUDE.md ASSERTION IS LINE-SCOPED, AND THAT IS THE WHOLE POINT. A first version
// asked only whether the derived strings appeared SOMEWHERE in the file, and pre-ship review
// drove it to a green false pass: corrupt the recapture row's sampled stamp, append
// `<!-- an earlier note mentioned <the real stamp> -->` at EOF, and all five cases stayed
// green while the document named a sample that does not exist. That is not a hypothetical
// shape — this ledger restates every superseded stamp verbatim in its "Previous row, …"
// chains, so a future round mentioning the new stamp in history prose while leaving the row
// header stale would pass. The row a release session actually reads is the one that must
// carry the stamp, so that is the line asserted.
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

// Derived per-test, NOT in the describe body. In the body a renamed BASELINE_STALE_AGE_DAYS
// makes `new Date(NaN).toISOString()` throw during COLLECTION, so the file reports "0 test"
// and the one case whose job is to catch that rename never runs. Pre-ship review found that
// too. Here the premise case gets to fail as an assertion, naming the constant.
function derive() {
  const baseline = JSON.parse(read('benchmark/baseline.json'));
  const gateSrc = read('benchmark/ci-gate.mjs');
  const ageMatch = gateSrc.match(/const BASELINE_STALE_AGE_DAYS\s*=\s*(\d+)/);
  const staleDays = ageMatch ? Number(ageMatch[1]) : NaN;
  const sampledMs = Date.parse(baseline.timestamp);
  const usable = Number.isFinite(staleDays) && staleDays > 0 && Number.isFinite(sampledMs);
  if (!usable) return { ageMatch, staleDays, sampledMs, sampledStamp: null, expiryStamp: null };
  const expiry = new Date(sampledMs + staleDays * DAY_MS).toISOString();
  return {
    ageMatch,
    staleDays,
    sampledMs,
    sampledStamp: new Date(sampledMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expiryStamp: `${expiry.slice(0, 10)} ${expiry.slice(11, 16)}`,
  };
}

/** The one CLAUDE.md line a release session reads to decide whether to recapture. */
function recaptureRow() {
  const line = read('CLAUDE.md')
    .split('\n')
    .find((l) => l.includes('Recapture the gate baseline'));
  return line === undefined ? null : unbold(line);
}

describe('the gate baseline expiry is stamped identically in all three places', () => {
  it('reads the stale-age window from the gate itself', () => {
    // Premise, asserted rather than remembered: the +N days below is the constant the
    // SHIPPED gate enforces. Retuning the window must move this test, not silently
    // invalidate three files pinned to stale arithmetic.
    const { ageMatch, staleDays } = derive();
    expect(ageMatch, 'BASELINE_STALE_AGE_DAYS not found in benchmark/ci-gate.mjs').not.toBeNull();
    expect(staleDays).toBeGreaterThan(0);
  });

  it('has a parseable timestamp in benchmark/baseline.json', () => {
    const { sampledMs, sampledStamp, expiryStamp } = derive();
    expect(Number.isFinite(sampledMs)).toBe(true);
    expect(sampledStamp).not.toBeNull();
    expect(expiryStamp).not.toBeNull();
  });

  it('ci.yml names the sampled stamp and the derived expiry', () => {
    // Whole-file is fine here: ci.yml carries the stamp once, in one comment block, and is
    // small enough that a failure diff stays readable.
    const { sampledStamp, expiryStamp } = derive();
    const ci = unbold(read('.github/workflows/ci.yml'));
    expect(ci).toContain(sampledStamp);
    expect(ci).toContain(expiryStamp);
  });

  it("CLAUDE.md's RECAPTURE ROW names the sampled stamp and the derived expiry", () => {
    const { sampledStamp, expiryStamp } = derive();
    const row = recaptureRow();
    // Premise first: if the row is renamed away, say so instead of passing vacuously.
    expect(row, 'no CLAUDE.md line matches "Recapture the gate baseline"').not.toBeNull();
    // Assert on the ROW, never the file — locality is the guard, and it also keeps a
    // failure diff to one line instead of dumping the whole ~60 KB ledger into the log.
    expect(row).toContain(sampledStamp);
    expect(row).toContain(expiryStamp);
  });

  it('leaves no OTHER expiry date in either prose surface', () => {
    // The failing shape is not a missing date, it is a SECOND one: a recapture that adds
    // the new stamp while the old sentence survives elsewhere in the file reads as two
    // deadlines, and a human picks the wrong one. Every `red from <date>` in either file
    // must name the current expiry.
    const { expiryStamp } = derive();
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
