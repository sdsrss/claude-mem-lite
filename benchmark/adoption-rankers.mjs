// Task 6 (offline benchmark, 2026-07-05): per-surface candidate replay.
//
// Given a replayed injection event (Task 4/5's extractInjectionEvents output) and a
// surface, re-run the ACTUAL production ranker under a virtual clock/snapshot (`nowT`/
// `epochTo` pinned to the event's own timestamp — see Task 1/2's offline-replay options
// on searchByFts / rankImperativeCandidates) and split the resulting candidates into
// `shown` (what the live hook would have injected) vs `nearMiss` (candidates ranked
// just below the cutoff — the counterfactual "almost shown" set an adoption estimator
// needs to separate injection-driven adoption from noise).
import { searchByFts } from '../scripts/user-prompt-search.js';
import { rankImperativeCandidates } from '../hook-memory.mjs';
import { envNumber } from '../lib/env-number.mjs';

// Mirror the ACTUAL live ranker's env-overridable cutoffs (scripts/user-prompt-search.js:27,86)
// so a benchmark run against a differently-tuned deployment replays under the same floor/cap
// it actually ran with. Unset → same defaults as before (3 / 50).
// Same parse as the live ranker's, through the same helper — a ruler that read a
// malformed knob as NaN would score `cand.filter(c => c.runningVar >= NaN)` = [] and
// report a face as producing nothing, which is a measurement, not a crash.
const MAX_RESULTS = envNumber(process.env.CLAUDE_MEM_UPS_MAX_RESULTS, {
  name: 'CLAUDE_MEM_UPS_MAX_RESULTS',
  defaultValue: 3,
  min: 0,
  integer: true,
});
const TOP_REL_FLOOR = envNumber(process.env.CLAUDE_MEM_UPS_TOP_MIN, {
  name: 'CLAUDE_MEM_UPS_TOP_MIN',
  defaultValue: 50,
  min: 0,
});

/**
 * Pure, DB-free split of already-scored candidates into `shown` (floor-crossing, capped at
 * `cap`) vs `nearMiss` (the next `m` candidates that didn't make the cut). Extracted out of
 * the ups-fts branch of replayCandidates so the floor/cap logic is unit-testable with
 * synthetic candidates, independent of the FTS/DB seam.
 * @param {Array<{id:string, text:string, runningVar:number}>} cand
 * @param {{ floor: number, cap: number, m: number }} opts
 * @returns {{ shown: Array<{id:string, text:string, runningVar:number}>, nearMiss: Array<{id:string, text:string, runningVar:number}> }}
 */
export function splitShownNearMiss(cand, { floor, cap, m }) {
  const passing = cand.filter((c) => c.runningVar >= floor);
  const shown = passing.slice(0, cap);
  const shownIds = new Set(shown.map((c) => c.id));
  const nearMiss = cand.filter((c) => !shownIds.has(c.id)).slice(0, m);
  return { shown, nearMiss };
}

/**
 * @param {'ups-fts'|'imperative'|'subagent'} surface
 * @param {import('better-sqlite3').Database} db
 * @param {{ ts: number, query: string }} event
 * @param {{ m?: number, project?: string }} [opts]
 * @returns {{ shown: Array<{id:string, text:string, runningVar:number}>, nearMiss: Array<{id:string, text:string, runningVar:number}> }}
 */
export function replayCandidates(surface, db, event, { m = 3, project } = {}) {
  if (surface === 'ups-fts') {
    const { rows } = searchByFts(db, event.query, project, MAX_RESULTS + m, null, {
      nowT: event.ts,
      epochTo: event.ts,
    });
    const cand = rows.map((r) => ({
      id: String(r.id),
      text: `${r.title || ''} ${r.lesson_learned || ''}`.trim(),
      runningVar: Math.abs(r.relevance),
    }));
    return splitShownNearMiss(cand, { floor: TOP_REL_FLOOR, cap: MAX_RESULTS, m });
  }
  if (surface === 'imperative' || surface === 'subagent') {
    // imperative + subagent share selectImperativeLesson's ranker (rankImperativeCandidates
    // returns {id, lesson_learned, importance, overlap, score} — no title column, so `text`
    // here is lesson_learned only; this is narrower than the generic "title + lesson_learned"
    // description above but matches what the seam actually returns).
    const ranked = rankImperativeCandidates(db, event.query, project, [], { epochTo: event.ts }).map((r) => ({
      id: String(r.id),
      text: `${r.lesson_learned || ''}`.trim(),
      runningVar: r.score,
    }));
    return { shown: ranked.slice(0, 1), nearMiss: ranked.slice(1, 1 + m) };
  }
  throw new Error(`replayCandidates: unknown surface ${surface}`);
}
