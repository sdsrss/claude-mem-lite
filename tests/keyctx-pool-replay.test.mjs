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
import {
  patchConst,
  writeTwin,
  assertCannotWrite,
  assertRulerCanSayNo,
  assertCanSeeDisplacement,
  compare,
} from '../benchmark/keyctx-pool-replay.mjs';

const projects = [{ project: 'p' }];
// compare() only hands `db` through to the two arms, so the arms are canned answers.
const arm = (obsIds, sessIds = [], tokens = 0) => () => ({
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
    expect(() => patchConst('export const OTHER = 50;\n', 'KEYCTX_POOL_OBS', 200))
      .toThrow(/not found in hook-context\.mjs/);
    expect(() => patchConst('export const KEYCTX_POOL_OBS = 50;\n', 'KEYCTX_POOL_OBS', 50))
      .not.toThrow();
  });

  it('THROWS when the twin would be identical to shipped in BOTH bounds', () => {
    // Values read from hook-context.mjs itself, so this survives a re-tune.
    const src = readFileSync(new URL('../hook-context.mjs', import.meta.url), 'utf8');
    const obs = Number(/export const KEYCTX_POOL_OBS = (\d+);/.exec(src)[1]);
    const sess = Number(/export const KEYCTX_POOL_SESS = (\d+);/.exec(src)[1]);
    expect(() => writeTwin(obs, sess)).toThrow(/twin is identical to shipped/);
    expect(() => writeTwin(obs + 1, sess)).not.toThrow();
    rmSync(new URL('../.tmp-keyctx-pool-twin.mjs', import.meta.url), { force: true });
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
      observations: [{ id: call++ % 2 === 0 ? 1 : 2 }], summaries: [], totalTokens: 0,
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
    expect(() => assertCanSeeDisplacement(() => ({ gained: 0, displaced: 0 })))
      .toThrow(/cannot be trusted to appear/);
    expect(() => assertCanSeeDisplacement(() => ({ gained: 1, displaced: 0 })))
      .toThrow(/displaced=0/);
  });

  it('counts displacement caused by the non-monotone stages', () => {
    // Selection here is genuinely NOT monotone: the token budget, the 3-per-type cap
    // and the file-overlap penalty can each evict a row a narrower pool kept. A ruler
    // that gated this to zero (as rerank-pool-replay's face correctly does) would be
    // asserting a property this face does not have.
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
