// benchmark/keyctx-pool-replay.mjs — the ruler for the SessionStart Key Context face.
//
// Written at the same time as the ruler, because D#190 was the receipt for what happens
// otherwise: rerank-pool-replay.mjs shipped with four self-checks, a CHANGELOG sentence
// vouching for them, and nothing under tests/ importing the file — so all four could be
// deleted with a green suite. A new ruler with the same shape and no binding test would
// be that defect committed knowingly.
//
// Every check is driven with synthetic inputs and watched to FAIL.
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  patchConst,
  writeTwin,
  assertCannotWrite,
  assertRulerCanSayNo,
  assertCanSeeDisplacement,
  compare,
  patchDropPoints,
  DROP_POINTS,
  inertNotice,
  summarizeCost,
  assertInertConsistent,
  assertTraceWellFormed,
} from '../benchmark/keyctx-pool-replay.mjs';

// D#207: built with join(), never `new URL('../X.mjs', import.meta.url)` — the URL form
// makes knip drop the named module out of its unused-export report entirely, and this
// file naming hook-context.mjs that way was one half of that blind spot.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const projects = [{ project: 'p' }];
// compare() only hands `db` through to the two arms, so the arms are canned answers.
const arm =
  (obsIds, sessIds = [], tokens = 0) =>
  () => ({
    observations: obsIds.map((id) => ({ id })),
    summaries: sessIds.map((id) => ({ id })),
    totalTokens: tokens,
  });

describe('twin patch', () => {
  it('rewrites the exported declaration it was pointed at', () => {
    const { out, previous } = patchConst('export const KEYCTX_POOL_OBS = 50;\n', 'KEYCTX_POOL_OBS', 200);
    expect(previous).toBe(50);
    expect(out).toContain('export const KEYCTX_POOL_OBS = 200;');
  });

  it('THROWS when the anchor is gone, but NOT when the edit is a no-op', () => {
    expect(() => patchConst('export const OTHER = 50;\n', 'KEYCTX_POOL_OBS', 200)).toThrow(
      /not found in hook-context\.mjs/,
    );
    expect(() => patchConst('export const KEYCTX_POOL_OBS = 50;\n', 'KEYCTX_POOL_OBS', 50)).not.toThrow();
  });

  it('THROWS when the twin would be identical to shipped in BOTH bounds', () => {
    // Values read from hook-context.mjs itself, so this survives a re-tune. `export` is
    // optional in the pattern: the bounds went module-private in D#207 and this pattern,
    // being a second hand-written copy of `patchConst`'s, silently stopped matching and
    // threw on `null[1]` rather than reporting a missing anchor.
    const src = readFileSync(join(REPO, 'hook-context.mjs'), 'utf8');
    const read = (name) => {
      const m = new RegExp(`(?:export\\s+)?const ${name} = (\\d+);`).exec(src);
      expect(m, `${name} declaration not found in hook-context.mjs`).toBeTruthy();
      return Number(m[1]);
    };
    const obs = read('KEYCTX_POOL_OBS');
    const sess = read('KEYCTX_POOL_SESS');
    expect(() => writeTwin(obs, sess)).toThrow(/twin is identical to shipped/);
    expect(() => writeTwin(obs + 1, sess)).not.toThrow();
    rmSync(join(REPO, '.tmp-keyctx-pool-twin.mjs'), { force: true });
  });
});

describe('the handle must reject a write', () => {
  it('THROWS on a writable handle', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, injection_count INTEGER)');
    expect(() => assertCannotWrite(db)).toThrow(/accepted a write/);
    db.close();
  });
});

describe('shipped-vs-shipped must report zero', () => {
  it('passes for a deterministic arm', () => {
    expect(() => assertRulerCanSayNo(null, projects, arm([1, 2], [9]), 0)).not.toThrow();
  });

  it('THROWS for a non-deterministic arm', () => {
    let call = 0;
    const flaky = () => ({
      observations: [{ id: call++ % 2 === 0 ? 1 : 2 }],
      summaries: [],
      totalTokens: 0,
    });
    expect(() => assertRulerCanSayNo(null, projects, flaky, 0)).toThrow(/not deterministic/);
  });
});

describe('the displacement counter — the number that argues AGAINST widening', () => {
  it('passes on the constructed 1-gained / 1-displaced case', () => {
    expect(() => assertCanSeeDisplacement()).not.toThrow();
  });

  it('THROWS when the counter it guards has stopped counting', () => {
    // The case that was missing: with only the positive assertion above, gutting this
    // guard's throw left all 10 cases green (mutation M5). Its sibling
    // assertRulerCanSayNo already had its negative arm — this is the asymmetry.
    expect(() => assertCanSeeDisplacement(() => ({ gained: 0, displaced: 0 }))).toThrow(
      /cannot be trusted to appear/,
    );
    expect(() => assertCanSeeDisplacement(() => ({ gained: 1, displaced: 0 }))).toThrow(/displaced=0/);
  });

  it('counts displacement caused by the non-monotone stages', () => {
    // Selection here is genuinely NOT monotone: the token budget and the 3-per-type
    // cap can each evict a row a narrower pool kept. A ruler that gated this to zero
    // (as rerank-pool-replay's face correctly does) would be asserting a property this
    // face does not have. (A third stage, the file-overlap penalty, was named here
    // until D#197 established it could never fire and deleted it.)
    const r = compare(null, projects, arm([1, 2, 3]), arm([2, 3, 4]), 0);
    expect(r.gained).toBe(1);
    expect(r.displaced).toBe(1);
  });
});

describe('summaries are injected content, not a side channel', () => {
  it('a summaries-only difference still counts as a changed block', () => {
    // The caliber defect this ruler shipped with for one measurement round: scoring
    // only `observations` printed "selection differs 0/11" for an arm that added 130
    // session summaries and more than doubled the emitted token count.
    const r = compare(null, projects, arm([1], [7]), arm([1], [7, 8, 9]), 0);
    expect(r.changedObs).toBe(0);
    expect(r.changedBlock).toBe(1);
    expect(r.sessGained).toBe(2);
  });

  it('still reports observation-only changes separately', () => {
    const r = compare(null, projects, arm([1], [7]), arm([1, 2], [7]), 0);
    expect(r.changedObs).toBe(1);
    expect(r.changedBlock).toBe(1);
    expect(r.sessGained).toBe(0);
  });
});

describe('drop-point instrumentation — the attribution must not silently lose a gate', () => {
  it('instruments every drop point AND the selection commit', () => {
    const src = readFileSync(join(REPO, 'hook-context.mjs'), 'utf8');
    const out = patchDropPoints(src);
    for (const [, label] of DROP_POINTS) {
      expect(out).toContain(`__KEYCTX_TRACE.push([c._kind, c.id, '${label}'])`);
    }
    expect(out).toContain("__KEYCTX_TRACE.push([c._kind, c.id, 'SELECTED'])");
  });

  it('THROWS when a gate anchor is gone, naming which one', () => {
    // The failure that matters: a silently-missed drop point yields a complete-looking
    // report in which one gate never fires — indistinguishable from that gate being
    // inactive, which is the exact reading this mode exists to support.
    const src = readFileSync(join(REPO, 'hook-context.mjs'), 'utf8');
    for (const [anchor, label] of DROP_POINTS) {
      const broken = src.replace(anchor, '/* moved */');
      expect(() => patchDropPoints(broken)).toThrow(new RegExp(`drop-point anchor gone: ${label}`));
    }
    expect(() => patchDropPoints(src.replace('totalTokens += c.cost;', '/* moved */'))).toThrow(
      /the selection commit/,
    );
  });
});

describe('an arm can be inert without being equal', () => {
  it('flags an arm whose twin bound equals shipped', () => {
    expect(inertNotice(200, 200, 107)).toMatch(/equals shipped/);
  });

  it('flags an arm where BOTH bounds clear the largest pool — the 200-vs-500 case', () => {
    // The one that is not visible as equality: 200 and 500 are different integers and the
    // same arm, because the pool is 107. Reporting that as "0 newly reachable" would read
    // as a null result about widening.
    expect(inertNotice(200, 500, 107)).toMatch(/at or above the largest pool/);
  });

  it('stays SILENT when the comparison could genuinely have moved', () => {
    // Without this arm the notice could be hard-wired to always fire and every test above
    // would still pass.
    expect(inertNotice(50, 200, 107)).toBeNull();
    expect(inertNotice(200, 50, 107)).toBeNull();
  });
});

describe('the INERT notice must be falsifiable, not just present', () => {
  it('THROWS when a notice is printed over a run that found real differences', () => {
    // The defect this exists for: mutating largestObsPool to return 0 made every run print
    // "both bounds are above the largest pool (0)" directly above a report showing 2 of 11
    // projects changing — and the whole suite stayed green, because maxPool's wiring is not
    // reachable from a unit test. An annotation nothing can contradict is worse than none.
    expect(() => assertInertConsistent('obs arm is INERT: ...', 2)).toThrow(/Both cannot be true/);
  });

  it('stays quiet for the two consistent combinations', () => {
    expect(() => assertInertConsistent('obs arm is INERT: ...', 0)).not.toThrow();
    expect(() => assertInertConsistent(null, 2)).not.toThrow();
  });
});

describe('the drop-reason trace must account for every candidate exactly once', () => {
  it('accepts a well-formed trace and returns the count', () => {
    expect(
      assertTraceWellFormed([
        ['obs', 1, 'SELECTED'],
        ['obs', 2, 'typecap'],
      ]),
    ).toBe(2);
  });

  it('THROWS on an empty trace — instrumentation that did not run', () => {
    // Without this, a failed patch degrades every row to the "not-in-pool" default and the
    // mode prints a complete-looking attribution in which no gate ever fired.
    expect(() => assertTraceWellFormed([], 'wide arm')).toThrow(/wide arm produced no records/);
  });

  it('THROWS on a duplicate candidate and on an unknown label', () => {
    expect(() =>
      assertTraceWellFormed([
        ['obs', 1, 'SELECTED'],
        ['obs', 1, 'budget'],
      ]),
    ).toThrow(/recorded obs:1 twice/);
    expect(() => assertTraceWellFormed([['obs', 1, 'made-up']])).toThrow(/unknown label "made-up"/);
  });

  it('accepts every label the instrumentation can actually emit', () => {
    // Binds the label set to DROP_POINTS: renaming a gate without updating TRACE_LABELS
    // would make real traces throw.
    for (const [, label] of DROP_POINTS) {
      expect(() => assertTraceWellFormed([['obs', 1, label]])).not.toThrow();
    }
  });
});

describe('cost summary reports a ratio RANGE, not a point', () => {
  it('spans the extremes of the passes', () => {
    const s = summarizeCost([
      { narrow: 1, wide: 2 },
      { narrow: 1, wide: 3 },
    ]);
    expect(s.passes).toBe(2);
    expect(s.ratioMin).toBe(2);
    expect(s.ratioMax).toBe(3);
  });

  it('does not collapse a spread to its mean', () => {
    // The defect this exists to prevent is publishing 2.65x as a point estimate when the
    // same harness on the same machine spans 2.1x-3.8x.
    const s = summarizeCost([
      { narrow: 1, wide: 2 },
      { narrow: 1, wide: 4 },
    ]);
    expect(s.ratioMax - s.ratioMin).toBe(2);
    expect(s.ratioMin).not.toBe(3);
  });
});
