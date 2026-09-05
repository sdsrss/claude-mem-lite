// Instrumenting significance rule 4 before changing it (audit 2026-08-22 P2-14).
//
// The report proposed moving Grep into the bash prefilter's skip list: Grep pays a full
// node handoff (measured 91.2ms, against 6.1ms for the already-skipped Read) and the
// report believed its only downstream value was this rule's counter. The 2026-08-22 data
// check said cost was real but the premise was not — there are three consumers — and it
// ruled that the decision needs a number nobody has: how many episodes reach significance
// ONLY because of Grep entries. Read is already in the skip list and therefore never
// reaches episode.entries, so rule 4 is in practice "8+ Greps" — but "in practice" is a
// deduction, and demoting what the product remembers on a deduction is how work
// disappears silently.
//
// explainSignificance is that number's source: which rule decided, and whether rule 4
// would still have fired without the Grep entries. episodeHasSignificantContent stays a
// pure boolean over the same body, so the meter cannot disagree with the decision.
import { describe, it, expect } from 'vitest';
import { episodeHasSignificantContent, explainSignificance } from '../hook-episode.mjs';
import { buildImmediateObservation } from '../hook-llm.mjs';
import { LOW_SIGNAL_TITLE } from '../utils.mjs';

const entries = (spec) =>
  spec.flatMap(([tool, n, extra = {}]) => Array.from({ length: n }, () => ({ tool, ...extra })));

const ep = (spec, files = []) => ({ entries: entries(spec), files });

describe('explainSignificance', () => {
  it('agrees with the boolean face on every shape', () => {
    const shapes = [
      ep([['Edit', 1]]),
      ep([['Bash', 1, { isError: true, bashSig: { isTest: true } }]]),
      ep([['Read', 1]], ['src/schema.sql']),
      ep([['Grep', 8]]),
      ep([['Grep', 7]]),
      ep([['Bash', 3]]),
      ep([]),
    ];
    for (const e of shapes) {
      expect(explainSignificance(e).significant).toBe(episodeHasSignificantContent(e));
    }
  });

  it('names the rule that decided, in precedence order', () => {
    // An episode that satisfies several rules must report the FIRST one, or the counts
    // attribute an edit-driven episode to research.
    expect(
      explainSignificance(
        ep([
          ['Edit', 1],
          ['Grep', 20],
        ]),
      ).rule,
    ).toBe(1);
    expect(
      explainSignificance(
        ep([
          ['Bash', 1, { isError: true, bashSig: { isBuild: true } }],
          ['Grep', 20],
        ]),
      ).rule,
    ).toBe(2);
    expect(explainSignificance(ep([['Grep', 20]], ['app/config.yml'])).rule).toBe(3);
    expect(explainSignificance(ep([['Grep', 8]])).rule).toBe(4);
    expect(explainSignificance(ep([['Grep', 7]])).rule).toBe(null);
  });

  it('reports whether rule 4 needed the Greps — the number the decision is blocked on', () => {
    // Grep-only: drop the Greps and the rule no longer fires. This is the episode that
    // would be LOST if Grep moved into the skip list.
    const grepOnly = explainSignificance(ep([['Grep', 8]]));
    expect(grepOnly).toMatchObject({ rule: 4, readCount: 8, grepCount: 8, grepDecisive: true });

    // Would have fired anyway on Reads alone — moving Grep out costs nothing here.
    const readsCarry = explainSignificance(
      ep([
        ['Read', 8],
        ['Grep', 4],
      ]),
    );
    expect(readsCarry).toMatchObject({ rule: 4, readCount: 12, grepCount: 4, grepDecisive: false });

    // Mixed, and the Greps are what crosses the threshold.
    const mixed = explainSignificance(
      ep([
        ['Read', 5],
        ['Grep', 3],
      ]),
    );
    expect(mixed).toMatchObject({ rule: 4, readCount: 8, grepCount: 3, grepDecisive: true });
  });

  it('leaves grepDecisive false when rule 4 was not the decider', () => {
    // Otherwise an edit episode that happens to contain Greps would be counted as
    // evidence that Grep carries research episodes.
    expect(
      explainSignificance(
        ep([
          ['Edit', 1],
          ['Grep', 20],
        ]),
      ).grepDecisive,
    ).toBe(false);
    expect(explainSignificance(ep([['Grep', 2]])).grepDecisive).toBe(false);
  });
});

// The same audit item proposed deleting buildImmediateObservation's isReviewPattern
// title branch as proven-dead: 112 rows in the live store, 1 lifetime injection, 0
// citations, nothing new since 2026-04-14. The rows are dead. The BRANCH is not — it is
// what keeps these episodes inside LOW_SIGNAL_TITLE, and deleting it does not delete the
// observations, it renames them.
//
// With files, the fallback title ("Worked on a.mjs …") is still excluded, so the change
// looks harmless. With NO captured file paths — a pure-Grep episode, exactly the shape
// rule 4 selects — the fallback drops to entries[0].desc, i.e. `Search "x" → N matches`,
// which LOW_SIGNAL_TITLE does not match. Removing the branch would therefore turn a class
// of never-injected rows into injectable ones, on the noisiest possible title.
//
// So: do not delete it without also widening LOW_SIGNAL_TITLE. These cases fail if
// someone does.
describe('the review-pattern title branch is a low-signal guard, not dead code', () => {
  const grepEpisode = (files) => ({
    entries: Array.from({ length: 6 }, () => ({
      tool: 'Grep',
      desc: 'Search "handleStop" → 12 matches in 4 files',
      files: [],
    })),
    files,
    filesRead: [],
  });

  it('keeps a pure-Grep episode with no captured files out of the injectable set', () => {
    const title = buildImmediateObservation(grepEpisode([])).title;
    expect(title).toMatch(/^Reviewed \d+ files/);
    expect(LOW_SIGNAL_TITLE.test(title)).toBe(true);
  });

  it('and the fallback it would drop to is NOT excluded — which is why it stays', () => {
    // Pinning the hazard itself: if LOW_SIGNAL_TITLE ever learns this shape, this case
    // flips and the branch becomes genuinely removable. Until then it is load-bearing.
    expect(LOW_SIGNAL_TITLE.test('Search "handleStop" → 12 matches in 4 files')).toBe(false);
  });

  it('with files present the fallback would have been safe (why the hazard is easy to miss)', () => {
    expect(LOW_SIGNAL_TITLE.test('Worked on a.mjs, b.mjs +3 more')).toBe(true);
  });
});
