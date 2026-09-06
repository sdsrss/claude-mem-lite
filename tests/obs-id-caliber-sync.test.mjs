// One caliber for `#NN`, across production AND the offline benchmarks.
//
// The benchmarks re-derive production's cite-rate from the same transcripts, so a
// benchmark whose id pattern differs from the extractor's measures a different
// population than the thing it is auditing. Four calibers were live at once:
//
//   lib/citation-tracker.mjs            {1,7}   (production, 5 regexes)
//   benchmark/cite-recall.mjs           {2,6}   numerator
//   benchmark/cite-recall.mjs           {1,7}   denominator   ← disagreed with its OWN numerator
//   benchmark/efficacy-observational.mjs {2,6}
//   benchmark/adoption-replay.mjs       {2,7}
//
// A denominator wider than its numerator counts ids as injected-never-cited that the
// numerator structurally cannot see, biasing measured cite-rate DOWN — and nothing
// errors when it happens, which is what makes it worth a guard rather than a fix.
//
// Honest scope note: the live impact when this was unified (2026-08-24, 3692 rows,
// ids 1..10834) was ZERO — the only ids outside {2,6} are four 1-digit rows, all with
// injection_count = 0, and there are no 7-digit ids. This guard exists to keep the
// class closed, not because it corrected a published number.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { OBS_ID_DIGITS, citationIdRe } from '../lib/citation-tracker.mjs';

const REPO = resolve(import.meta.dirname, '..');
const OWNER = 'lib/citation-tracker.mjs';

/** Any hand-written digit-count caliber: `\d{n,m}` inside a `#`-anchored id pattern. */
const HAND_CALIBER = /#\\?\(?\\d\{\d+,\d+\}/;

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Every repo module that could plausibly scan transcripts for observation ids.
 *
 * The first version walked only `benchmark/` and `lib/`, and both v3.80.0 pre-tag
 * reviewers independently found the same consequence: `scripts/p0-forward-probe.mjs`
 * carried a SEVENTH caliber (`{3,6}` — narrower than every other copy at both ends) doing
 * exactly this job, and the sweep was not looking at it. A guard whose directory list is
 * what hides the violation reports a closed class that is not closed. Now covers the repo
 * root and `scripts/` too, and `.js` as well as `.mjs`.
 *
 * (p0-forward-probe.mjs itself was deleted in R10 P3-24 — no consumer, and it hardcoded a
 * transcript path from a machine that no longer exists. The directory list stays wide: the
 * point was never that one file, it was that a narrow list hides the violation.)
 */
function scanTargets() {
  const out = [];
  for (const dir of ['benchmark', 'lib', 'scripts', '.']) {
    for (const f of readdirSync(join(REPO, dir))) {
      if (!/\.(mjs|js)$/.test(f)) continue;
      const rel = dir === '.' ? f : `${dir}/${f}`;
      if (rel === OWNER) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

describe('observation-id caliber — one owner', () => {
  it('the owner exports the caliber and a fresh matcher', () => {
    expect(OBS_ID_DIGITS).toBe('\\d{1,7}');
    expect(citationIdRe().source).toBe('#(\\d{1,7})\\b');
    expect(citationIdRe().flags).toContain('g');
  });

  // One OWNER does not mean one SHAPE. citationIdRe() is a numerator caliber; applying it
  // to an unanchored INJECTED set pulled two prose ids ("with `#1` superseded by `#2`")
  // into adoption-replay's denominator on a real transcript — caught by the v3.80.0
  // pre-tag review after the author had asserted the change was a no-op everywhere.
  it('exposes a SEPARATE, narrower caliber for unanchored injected text', async () => {
    const { unanchoredInjectedIdRe } = await import('../lib/citation-tracker.mjs');
    const prose = 'with `#1` superseded by `#2`, see #8847 and #10834';
    expect([...prose.matchAll(citationIdRe())].map((m) => m[1])).toEqual(['1', '2', '8847', '10834']);
    expect([...prose.matchAll(unanchoredInjectedIdRe())].map((m) => m[1])).toEqual(['8847', '10834']);
    expect(unanchoredInjectedIdRe()).not.toBe(unanchoredInjectedIdRe());
  });

  it('adoption-replay builds its INJECTED set with the unanchored caliber, not the numerator one', () => {
    // Pins the actual defect, not just the export's existence: this file's `ids()` feeds
    // injectedIds from a whole prompt, so pointing it back at citationIdRe() re-opens it.
    const src = readFileSync(join(REPO, 'benchmark/adoption-replay.mjs'), 'utf8');
    expect(src).toMatch(/const ID_RE = unanchoredInjectedIdRe\(\)/);
    expect(stripComments(src)).not.toMatch(/const ID_RE = citationIdRe\(\)/);
  });

  // A shared /g regex carries lastIndex, so one exported instance reused by two
  // scanners silently starts mid-string in whichever runs second. Two calls must not
  // be the same object, and a consumed matcher must not poison the next caller.
  it('hands out a FRESH matcher, so one scanner cannot poison the next', () => {
    const a = citationIdRe();
    expect(citationIdRe()).not.toBe(a);
    a.exec('cited #4242 here');
    expect(a.lastIndex).toBeGreaterThan(0);
    expect(citationIdRe().lastIndex).toBe(0);
    // The decisive behavioural form: a second scan over the SAME text still finds it.
    expect([...'cited #4242 here'.matchAll(citationIdRe())].map((m) => m[1])).toEqual(['4242']);
  });

  it('matches a 1-digit and a 7-digit id, which the {2,6} copies could not', () => {
    const found = [...'see #7 and #1234567 and #10834'.matchAll(citationIdRe())].map((m) => m[1]);
    expect(found).toEqual(['7', '1234567', '10834']);
    // The caliber the benchmarks used to carry, for contrast — this is the bias.
    const old = [...'see #7 and #1234567 and #10834'.matchAll(/#(\d{2,6})\b/g)].map((m) => m[1]);
    expect(old).toEqual(['10834']);
  });

  it.each(scanTargets())('%s writes no caliber of its own', (rel) => {
    const src = stripComments(readFileSync(join(REPO, rel), 'utf8'));
    expect(
      HAND_CALIBER.test(src),
      `${rel} hand-writes an observation-id digit caliber. Import OBS_ID_DIGITS / ` +
        `citationIdRe() from ${OWNER} instead — a benchmark whose caliber differs from ` +
        `the extractor's measures a different population than the one it audits.`,
    ).toBe(false);
  });

  it('the caliber matcher fires on a hand-written pattern and spares a comment', () => {
    // Without this the sweep above proves nothing: a regex that can never match would
    // report every file clean.
    expect(HAND_CALIBER.test(stripComments('const R = /#(\\d{2,6})\\b/g;'))).toBe(true);
    expect(HAND_CALIBER.test(stripComments('const R = /^\\s{0,6}#(\\d{1,7})\\s/;'))).toBe(true);
    expect(HAND_CALIBER.test(stripComments('// used to be /#(\\d{2,6})\\b/g\n const x = 1;'))).toBe(false);
  });

  it('sweeps a non-trivial number of files (a zero-target scan would pass vacuously)', () => {
    expect(scanTargets().length).toBeGreaterThanOrEqual(100);
    expect(scanTargets()).toContain('benchmark/cite-recall.mjs');
    expect(scanTargets()).toContain('benchmark/adoption-replay.mjs');
    expect(scanTargets()).toContain('benchmark/efficacy-observational.mjs');
    // The three directories added after the pre-tag review, each pinned by a real file
    // that scans transcripts for ids — narrowing the list back would go red here rather
    // than silently shrinking the class the sweep claims to close. scripts/ used to be
    // pinned twice, by user-prompt-search.js and by p0-forward-probe.mjs; the latter was
    // deleted in R10 P3-24 (no consumer, and it hardcoded a machine-specific transcript
    // path that no longer exists), so the directory keeps exactly one live pin.
    expect(scanTargets()).toContain('scripts/user-prompt-search.js');
    expect(scanTargets()).toContain('hook.mjs');
  });
});
