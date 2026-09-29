// The episode buffer file has exactly ONE spelling: `episodeFile()`.
//
// Four paths flush the buffer — PostToolUse's phase transition, Stop (both the locked and
// the lock-contended arm), SessionStart's leftover sweep, and the signal handler's
// dying-process salvage. Three of them read and unlink through `episodeFile()`. The salvage
// path did neither: `readEpisodeRaw` re-assembled the name from RUNTIME_DIR and the project
// in its own body, and the handler's `unlinkSync` re-assembled it a third time. All three
// spellings were byte-identical, so nothing was broken — which is exactly why it survived:
// no behavioural test can distinguish two identical spellings, and the cost only appears
// the day one of them is changed and the others are not.
//
// That cost is not symmetric. The salvage path is the one that runs while the process is
// dying, is the hardest to exercise, and ENDS in a destructive unlink on the buffer it has
// just persisted. A stale path there deletes nothing, reports success, and the next fire
// salvages the same entries again as a second observation.
//
// The instrument is therefore a source sweep, and deliberately so: the invariant is textual
// ("one spelling"), and the counter-example is a real revert rather than a synthetic
// mutation — `git show HEAD~1:hook.mjs` and `HEAD~1:hook-episode.mjs` at the commit that
// introduced this file are the exact shape it must reject.
//
// POPULATION, stated before the criteria (the walkShipped lesson, CLAUDE.md § Testing this
// repo): `walkShipped` is every shipped `.mjs`/`.js` and is blind to the four shipped bash
// hooks. Measured 2026-09-14: none of them names the episode buffer, and the second describe
// below keeps it that way instead of leaving it as a fact someone has to remember.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO, walkShipped, relShipped, sweepShipped, sourceWithoutComments } from './shipped-tree.mjs';

/** Any template-literal spelling of `ep-<something>.json` — the buffer's name, whatever
 *  expression fills the hole. `ep-flush-${…}.json` (a different file, one per flush) does
 *  not match: `${` must follow `ep-` immediately. */
const BUFFER_NAME = /`ep-\$\{[^`]*\}\.json`/g;

/** The accessor's own home, and the only file allowed to spell the name. */
const ACCESSOR = 'hook-episode.mjs';

function countMatches(text, re) {
  return (text.match(new RegExp(re.source, 'g')) || []).length;
}

describe('the episode buffer path is spelled once, in episodeFile()', () => {
  it('sees both files the defect lived in', () => {
    // Premise. A sweep is only as wide as its population; assert the two files that carried
    // the duplicate spellings are actually in it before reading the sweep's verdict.
    const pop = walkShipped().map(relShipped);
    expect(pop).toContain('hook.mjs');
    expect(pop).toContain(ACCESSOR);
    expect(pop.length).toBeGreaterThan(100);
  });

  it('matches the accessor, so a clean sweep elsewhere is not a regex that matches nothing', () => {
    // Control only — "at least one", never "exactly one". Without it the sweep below passes
    // just as well when BUFFER_NAME has been broken into something unmatchable, which is a
    // green meaning "the ruler is dead". The count itself belongs to the last case.
    const accessorSrc = sourceWithoutComments(join(REPO, ACCESSOR));
    expect(countMatches(accessorSrc, BUFFER_NAME)).toBeGreaterThan(0);
  });

  it('is spelled nowhere else in the shipped tree', () => {
    const offenders = sweepShipped(BUFFER_NAME, new Set([ACCESSOR]));
    expect(
      offenders,
      `these modules build the episode buffer's name themselves instead of calling ` +
        `episodeFile(); a path that drifts from the accessor reads and deletes the wrong file:\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('is spelled exactly once even inside its own home, and that once is episodeFile()', () => {
    // The sweep above allowlists the whole accessor file, so a sibling in THIS module that
    // re-assembles the name — which is what readEpisodeRaw did — is invisible to it. This
    // case owns that half: one occurrence in the file, and it is the accessor's return.
    const src = sourceWithoutComments(join(REPO, ACCESSOR));
    expect(
      countMatches(src, BUFFER_NAME),
      `${ACCESSOR} spells the episode buffer's name more than once; every reader and every ` +
        `unlink must go through episodeFile() so the name has a single home`,
    ).toBe(1);
    const start = src.indexOf('export function episodeFile()');
    expect(start, 'episodeFile() is gone — this guard now describes nothing').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(countMatches(body, BUFFER_NAME)).toBe(1);
  });
});

describe('the shipped bash hooks do not name the episode buffer either', () => {
  // The population above cannot see these three files, and that blind spot is what hid two
  // runtime-dir splits in scripts/setup.sh for twelve audit rounds. Take the list from
  // package.json#files rather than a glob: a new bash hook is unshipped until it is
  // registered there, so this sweep grows with the tree instead of with a hand-kept list.
  const shippedSh = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).files.filter((f) =>
    f.endsWith('.sh'),
  );

  it('has bash hooks to sweep', () => {
    expect(shippedSh.length).toBeGreaterThan(0);
  });

  it('rejects a bash spelling of the buffer name', () => {
    // Control for the criterion below, which is a NEGATIVE over files that are clean today.
    expect(/\bep-/.test('rm -f "$RUNTIME_DIR/ep-$project.json"')).toBe(true);
    // …and does not fire on ordinary words that merely contain the letters.
    expect(/\bep-/.test('# deep-search, step-by-step, keep-alive')).toBe(false);
  });

  it('names no episode buffer', () => {
    const offenders = shippedSh.filter((f) => /\bep-/.test(readFileSync(join(REPO, f), 'utf8')));
    expect(
      offenders,
      `a shipped bash hook now names the episode buffer. It cannot call episodeFile(), so ` +
        `either route the work through Node or give the name a home both languages read:\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
