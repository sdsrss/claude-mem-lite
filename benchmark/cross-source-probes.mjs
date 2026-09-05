#!/usr/bin/env node
// Cross-source ranking direction probes — G5 ② (roadmap 2026-07-18).
//
// The denoise A/B metric suites run searchObservationsHybrid: OBS-ONLY. Every
// regression in the cross-source merge — the single-hit clamp saga (v3.48 MED-5
// constant −0.5 → v3.49 magnitude bands → 07-17 audit MED-1) and the 0-score
// promotion (v3.49 audit L3) — was invisible to them and read NEUTRAL. These
// probes execute the REAL normalizeCrossSourceScores (lib/search-core.mjs) on
// constructed row sets and assert the DIRECTION invariants each historical fix
// established. `normalize` is injectable so tests can replay the old behaviors
// and prove the probes have teeth (multiscript-guard pattern).
//
// Score convention: BM25-negative, merged ascending — more negative ranks first.
//
// Dev tooling only — not shipped in SOURCE_FILES. Run standalone:
//   node benchmark/cross-source-probes.mjs   (exit 1 on any probe failure)

import { fileURLToPath } from 'url';
import { normalizeCrossSourceScores } from '../lib/search-core.mjs';

function rows(spec) {
  // spec: { obs: [-8,-4], event: [-12], ... } → flat result rows with `source`.
  const out = [];
  let id = 1;
  for (const [source, scores] of Object.entries(spec)) {
    for (const score of scores) out.push({ source, id: id++, score });
  }
  return out;
}

function ranked(results) {
  return [...results].sort((a, b) => a.score - b.score);
}

/**
 * Run all direction probes through the (injectable) normalizer.
 * @returns {Array<{name:string, pass:boolean, detail:string}>}
 */
export function runCrossSourceProbes({ normalize = normalizeCrossSourceScores } = {}) {
  const probes = [];
  const probe = (name, spec, check) => {
    const r = rows(spec);
    let pass = false,
      detail = '';
    try {
      normalize(r, 'source');
      ({ pass, detail } = check(r));
    } catch (e) {
      detail = `threw: ${e.message}`;
    }
    probes.push({ name, pass, detail });
  };

  // ① 07-17 MED-1 / v3.49 band fix: the lone hit that IS the globally strongest
  // raw match (events = canonical store for promoted memories, low cardinality)
  // must rank STRICTLY first — band −1.05 beats every normalized −1.
  probe('lone-strongest-ranks-first', { obs: [-8, -4], event: [-12] }, (r) => {
    const first = ranked(r)[0];
    return {
      pass: first.source === 'event' && first.score < -1,
      detail: `first=${first.source}@${first.score}`,
    };
  });

  // ② ratio ≥ 0.5 band: comparable-to-best lands at −0.75 — above the neutral
  // mid, below the leaders.
  probe('lone-comparable-between-leaders-and-mid', { obs: [-10, -5], event: [-6] }, (r) => {
    const e = r.find((x) => x.source === 'event');
    return { pass: e.score === -0.75, detail: `event=${e.score}` };
  });

  // ③ ratio ≥ 0.1 band: the MED-5 neutral mid.
  probe('lone-mid-band', { obs: [-10, -5], event: [-2] }, (r) => {
    const e = r.find((x) => x.source === 'event');
    return { pass: e.score === -0.5, detail: `event=${e.score}` };
  });

  // ④ ratio < 0.1: a grazing lone hit sinks below every normalized row (the
  // pre-MED-5 behavior pinned it to −1 = tied with the best).
  probe('lone-grazing-sinks', { obs: [-10, -5], event: [-0.5] }, (r) => {
    const order = ranked(r);
    return {
      pass: order[order.length - 1].source === 'event',
      detail: order.map((x) => `${x.source}@${x.score}`).join(' '),
    };
  });

  // ⑤ v3.49 audit L3: a lone score=0 row (prompts CJK LIKE fallback — zero
  // confidence) keeps 0 and sorts LAST; the old clamp promoted it to the mid.
  probe('zero-score-stays-zero-and-last', { obs: [-10, -5], prompt: [0] }, (r) => {
    const p = r.find((x) => x.source === 'prompt');
    const order = ranked(r);
    return {
      pass: p.score === 0 && order[order.length - 1].source === 'prompt',
      detail: `prompt=${p.score}`,
    };
  });

  // ⑥ Multi-hit source: best pins to −1 (the [-1, 0] normalization contract).
  probe('multi-hit-best-pins-to-minus1', { obs: [-10, -5] }, (r) => {
    const scores = r.map((x) => x.score).sort((a, b) => a - b);
    return { pass: scores[0] === -1 && scores[1] === -0.5, detail: scores.join(',') };
  });

  // ⑦ Within-source relative order survives normalization.
  probe('within-source-order-preserved', { obs: [-9, -3, -6] }, (r) => {
    const order = ranked(r).map((x) => x.id);
    return { pass: order.join(',') === '1,3,2', detail: order.join(',') };
  });

  // ⑧ Small-scale sources (prompts, bm25 ≈ −1) can only be PENALIZED by the
  // global comparison, never inflated into the upper bands.
  probe('lone-prompt-never-inflated', { obs: [-40, -20], prompt: [-1] }, (r) => {
    const p = r.find((x) => x.source === 'prompt');
    return { pass: p.score === -0.25, detail: `prompt=${p.score}` };
  });

  // ⑨⑩ Band boundaries are floors (first-match-wins ≥ semantics).
  probe('band-boundary-0.5-is-0.75', { obs: [-10, -4], event: [-5] }, (r) => {
    const e = r.find((x) => x.source === 'event');
    return { pass: e.score === -0.75, detail: `event=${e.score}` };
  });
  probe('band-boundary-0.1-is-mid', { obs: [-10, -4], event: [-1] }, (r) => {
    const e = r.find((x) => x.source === 'event');
    return { pass: e.score === -0.5, detail: `event=${e.score}` };
  });

  // ⑪ Degenerate all-zero row set: no throw, scores untouched.
  probe('all-zero-no-throw', { obs: [0, 0], prompt: [0] }, (r) => {
    return { pass: r.every((x) => x.score === 0), detail: r.map((x) => x.score).join(',') };
  });

  return probes;
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url).includes(process.argv[1].replace(/\.mjs$/, ''));
if (isMain) {
  const results = runCrossSourceProbes();
  for (const p of results)
    console.error(`  ${p.pass ? '✓' : '✗'} ${p.name}${p.pass ? '' : ` — ${p.detail}`}`);
  const failed = results.filter((p) => !p.pass);
  if (failed.length) {
    console.error(`\n${failed.length} probe(s) FAILED`);
    process.exit(1);
  }
  console.error(`\nall ${results.length} probes pass`);
}
