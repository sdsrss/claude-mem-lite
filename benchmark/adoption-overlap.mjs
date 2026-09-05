#!/usr/bin/env node
// Task 7 (offline benchmark, 2026-07-05): adoption-overlap main — wires
// replay (T4) -> per-surface rankers (T6) -> dual-channel TF-IDF cosine (T3)
// -> RDD/cluster-bootstrap estimator (T5) into a per-bucket adoption report.
//
// For every replayed injection event, this re-scores the event's `shown` vs
// `nearMiss` candidates (T6's counterfactual "almost shown" set) against the
// assistant's post-injection output window, split into an `action` channel
// (Edit/Write/Bash tool_use payloads) and a `prose` channel (assistant text).
// Per event, per channel: cosShown = max cosine(output, shown-candidate);
// cosNearMiss = mean cosine(output, near-miss-candidate); the control-
// subtracted delta (cosShown - cosNearMiss) is the per-event adoption signal,
// aggregated per `${surface}:${channel}` bucket with a session-cluster
// bootstrap CI (events from the same session are NOT independent draws).
//
// DESIGN REFINEMENT (2026-07-05, supersedes the original plan's `effect: jump`):
// ci95 comes from cluster-bootstrapping the per-event control-subtracted
// deltas -- using the RDD jump as `effect` while `ci95` is bootstrapped over a
// DIFFERENT statistic is an effect/CI mismatch. Also, the RDD running
// variable is a real score with a fixed cutoff (50) only for `ups-fts`; for
// `imperative`/`subagent` (top-1 selection, running var = score) the "jump at
// x=0" extrapolation is rough. So:
//   - `effect` = clusterBootstrap(perEvent).mean -- PRIMARY, consistent with ci95.
//   - `rdd_jump` = localLinearRdd(points, cutoff).jump -- SECONDARY, the
//     gradient-corrected view (meaningful for ups-fts; informational for
//     imperative/subagent).
//
// IDF corpus is built ONCE over the whole run (every candidate text union
// every output window), not per-event -- per-event IDF would make cosine
// scores incomparable across events (different vocabulary universe each
// time).
//
// Usage:
//   node benchmark/adoption-overlap.mjs                    # last 30d, this project
//   node benchmark/adoption-overlap.mjs --start=ISO --end=ISO
//   node benchmark/adoption-overlap.mjs --json > out.json
//   node benchmark/adoption-overlap.mjs --dir=/path/to/transcripts
//   node benchmark/adoption-overlap.mjs --floor-check               # cite-recall sensitivity floor (necessary condition)
//   node benchmark/adoption-overlap.mjs --emit-labels=80 [--out=path]  # hand-label harness, stratified by surface x spec
//   node benchmark/adoption-overlap.mjs --score-labels=path          # AUC of delta vs hand-authored label
//
// Defaults: dir = ~/.claude/projects/-mnt-data-ssd-dev-projects-mem
//           db  = schema.mjs's DB_PATH (honors CLAUDE_MEM_DIR)
//           end = now, start = end - 30d.
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { extractInjectionEvents } from './adoption-replay.mjs';
import { replayCandidates } from './adoption-rankers.mjs';
import { buildIdf, textToBag, cosine, dualChannelBags } from './adoption-cosine.mjs';
import { localLinearRdd, clusterBootstrap, mde, lcg } from './adoption-estimator.mjs';
import { DB_PATH } from '../schema.mjs';
// Task 9: the brief claimed extractTechIdentifiers lives in utils.mjs
// (re-exported from nlp.mjs) -- verified FALSE (grepped both files, 0 hits).
// It is exported from scripts/user-prompt-search.js, the same module
// adoption-rankers.mjs already imports searchByFts from.
import { extractTechIdentifiers } from '../scripts/user-prompt-search.js';

// Running-var cutoff per surface: ups-fts's running var is |bm25 composite
// relevance| with a real production floor (TOP_REL_FLOOR, scripts/user-
// prompt-search.js); imperative/subagent's running var is the ranker score
// with no natural cutoff other than "top-1 wins", so 0 is a placeholder --
// rdd_jump for those two surfaces is informational, not a calibrated effect.
//
// DISCLOSURE: subagent:* is a PARENT-WINDOW PROXY, not valid subagent
// adoption -- the injection is baked into the CHILD's tool_input.prompt
// (see adoption-replay.mjs's subagent event construction), but the
// outputWindow scored here is the PARENT transcript's continuation after
// the tool_use; the child transcript is never scored. Do NOT use these
// buckets for the subagent default-flip decision until a child-transcript
// join is added (v2).
const CUTOFF = { 'ups-fts': 50, imperative: 0, subagent: 0 };

// Task 9 correctness fix (2026-07-05, flagged by the implementer): the cite
// check below must test whether the ASSISTANT wrote the injected `#id` in
// its own output -- never whether `#id` merely appears somewhere in the raw
// transcript file. The injection attachment line `injectedIds` is parsed
// FROM always contains `#<id>` verbatim, so a whole-file substring test made
// `cited` tautologically true for nearly every event (254/254 on the live
// 30d corpus), leaving floorCheck's citePositive-vs-citeSilent contrast
// vacuous (citeSilent.n was always 0). Fixed by mirroring cite-recall.mjs's
// Pass-2 citation-detection loop: only `entry.message.role === 'assistant'`
// (or `entry.type === 'assistant'`) entries' `type === 'text'` content
// blocks are scanned -- this structurally excludes `entry.attachment`
// (the injection itself), tool_use action payloads, and tool_result relays.
function assistantProseText(entry) {
  if (entry.message?.role !== 'assistant' && entry.type !== 'assistant') return '';
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  let text = '';
  if (Array.isArray(content)) {
    for (const c of content) if (c?.type === 'text' && c.text) text += c.text + '\n';
  }
  return text;
}

// Builds a per-SESSION corpus of assistant-authored prose for one transcript
// file, read once (not per event). Keyed the SAME way extractInjectionEvents
// keys ev.sessionId (`entry.sessionId || file`), so a lookup by ev.sessionId
// always lands on the matching bucket. `wholeFile` (concatenation of every
// session's prose in this file) is the fallback for a session with no
// assistant-text entries of its own -- matches how cite-recall.mjs scopes
// within-session attribution per file. Never includes attachment/tool_use
// content, so the fallback still can't match the injection itself.
function buildAssistantCorpus(file) {
  const bySession = new Map();
  let wholeFile = '';
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = assistantProseText(entry);
    if (!text) continue;
    const sid = entry.sessionId || file;
    bySession.set(sid, (bySession.get(sid) || '') + text);
    wholeFile += text;
  }
  return { bySession, wholeFile };
}

/**
 * @param {string} transcriptDir - directory of *.jsonl Claude Code transcripts
 * @param {import('better-sqlite3').Database} db
 * @param {{ start: number, end: number, project?: string, m?: number, placebo?: 'random'|'cutoff', collectEvents?: boolean }} opts
 * @returns {{ perBucket: Array<{ surface: string, channel: 'action'|'prose', nEvents: number, nSessions: number, effect: number, ci95: [number, number], rdd_jump: number, mde: number }>, events?: Array<{ sessionId: string, surface: string, actionDelta: number, cited: boolean, spec: 'low'|'high', query: string, lessonText: string, outputActions: string, outputProse: string }> }}
 */
export function computeAdoption(
  transcriptDir,
  db,
  { start, end, project = 'projects--mem', m = 3, placebo, collectEvents = false } = {},
) {
  const files = readdirSync(transcriptDir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => join(transcriptDir, n));
  const events = [];
  // Task 9: when collectEvents, build each file's per-session assistant-prose
  // corpus ONCE (not per event) for the cite check below. Keyed by
  // event-object identity (not a mutated field on `e`) so the default
  // (non-collect) path allocates nothing extra and stays a byte-identical
  // passthrough.
  const sessionCorpusByEvent = collectEvents ? new Map() : null;
  for (const f of files) {
    const assistantCorpus = collectEvents ? buildAssistantCorpus(f) : null;
    for (const e of extractInjectionEvents(f, { start, end })) {
      if (collectEvents)
        sessionCorpusByEvent.set(e, assistantCorpus.bySession.get(e.sessionId) ?? assistantCorpus.wholeFile);
      events.push(e);
    }
  }

  // Resolve shown/near-miss candidates once per event; also collect the
  // run-wide IDF corpus. Events with an empty `shown` are a coverage loss (no
  // observation crossed the ranker's floor at replay time) -- there is no
  // shown/near-miss control split to measure adoption against, so they are
  // excluded from both the corpus and the bucket aggregation, not counted as
  // a zero-effect event.
  const corpus = [];
  const resolved = [];
  for (const ev of events) {
    let { shown, nearMiss } = replayCandidates(ev.surface, db, ev, { m, project });
    if (shown.length === 0) continue; // coverage loss -- no control/shown split
    // Null control (placebo-random): swap each candidate's text for a
    // deterministically-picked DB lesson (as-of ev.ts, seeded by
    // sessionId+ts -- no Math.random) so any real shown/near-miss overlap
    // collapses to chance. This targets the PRIMARY `effect`/`ci95` below
    // (computed from perEvent, which is built from cosOf() over these
    // swapped .text values) -- a sound estimator's ci95 must bracket 0.
    if (placebo === 'random') {
      const pool = db
        .prepare(
          `SELECT title, lesson_learned FROM observations
         WHERE lesson_learned IS NOT NULL AND created_at_epoch <= ? ORDER BY id`,
        )
        .all(ev.ts);
      if (pool.length) {
        const rnd = lcg(ev.sessionId + ':' + ev.ts);
        const pickText = () => {
          const p = pool[Math.floor(rnd() * pool.length)];
          return `${p.title || ''} ${p.lesson_learned || ''}`.trim();
        };
        shown = shown.map((c) => ({ ...c, text: pickText() }));
        nearMiss = nearMiss.map((c) => ({ ...c, text: pickText() }));
      }
    }
    const { proseBag, actionBag } = dualChannelBags(ev.outputWindow);
    corpus.push(
      ev.outputWindow.prose,
      ev.outputWindow.actions,
      ...shown.map((c) => c.text),
      ...nearMiss.map((c) => c.text),
    );
    resolved.push({ ev, shown, nearMiss, proseBag, actionBag });
  }
  const idf = buildIdf(corpus);

  // bucket key `${surface}:${channel}` -> { points: RDD input, perEvent: cluster-bootstrap input }
  const buckets = new Map();
  const bk = (surface, channel) => `${surface}:${channel}`;
  const get = (k) => {
    if (!buckets.has(k)) buckets.set(k, { points: [], perEvent: [] });
    return buckets.get(k);
  };

  // Task 9: collectEvents output, one row per EVENT (not per channel) --
  // populated from the SAME `idf` (built once, above, over the whole run's
  // corpus) as the bucket loop below. Never build a second, per-event IDF
  // here -- that would make this row's actionDelta numerically incomparable
  // to the `imperative:action`/`subagent:action`/`ups-fts:action` bucket
  // effect computeAdoption itself reports, defeating the point of a
  // hand-label harness that's supposed to validate the real metric.
  const outEvents = collectEvents ? [] : null;
  for (const { ev, shown, nearMiss, proseBag, actionBag } of resolved) {
    let actionDelta; // captured from the 'action' channel iteration below
    for (const [channel, outBag] of [
      ['action', actionBag],
      ['prose', proseBag],
    ]) {
      const cosOf = (c) => cosine(outBag, textToBag(c.text), idf);
      const cosShown = Math.max(...shown.map(cosOf));
      const nmCos = nearMiss.map(cosOf);
      // no near-miss counterfactual -> no base-rate to subtract (don't penalize)
      const cosNear = nmCos.length ? nmCos.reduce((s, v) => s + v, 0) / nmCos.length : 0;
      const b = get(bk(ev.surface, channel));
      // One point per candidate, each paired with its OWN cosine -- pairing
      // shown[0]'s x with cosShown's y (the MAX over all shown) mismatches
      // x/y whenever shown.length > 1 (possible for ups-fts). This only
      // taints the secondary RDD `points`; the per-event PRIMARY delta below
      // is untouched.
      for (const c of shown) b.points.push({ x: c.runningVar, y: cosOf(c), shown: true });
      for (const c of nearMiss) b.points.push({ x: c.runningVar, y: cosOf(c), shown: false });
      // DISCLOSURE: effect = cosShown - cosNear with shown = the ranker's
      // argmax (systematically more query-overlapping than nearMiss), so
      // under the null E[effect] > 0 for the top-1 surfaces (imperative/
      // subagent) where rdd_jump's gradient-correction is uncalibrated
      // (CUTOFF=0). A GO decision must therefore rest on the floorCheck
      // contrast (citePositive vs citeSilent) and the hand-label AUC -- NOT
      // on effect+CI alone.
      const value = cosShown - cosNear; // control-subtracted per-event delta
      b.perEvent.push({ sessionId: ev.sessionId, value });
      if (channel === 'action') actionDelta = value;
    }
    if (collectEvents) {
      outEvents.push({
        sessionId: ev.sessionId,
        surface: ev.surface,
        actionDelta,
        // Fixed (see header comment above + task report): tests the id
        // against this event's SESSION-scoped assistant-PROSE-ONLY corpus,
        // never the raw file/attachment -- `cited` now means "the assistant
        // wrote #<id> in its own text", not "the id appears anywhere in the
        // file (including the injection that put it there)".
        cited: ev.injectedIds.some((id) => new RegExp(`#${id}\\b`).test(sessionCorpusByEvent.get(ev) || '')),
        spec: extractTechIdentifiers(shown[0].text).length >= 2 ? 'high' : 'low',
        query: ev.query,
        lessonText: shown[0].text,
        outputActions: ev.outputWindow.actions,
        outputProse: ev.outputWindow.prose,
      });
    }
  }

  const perBucket = [];
  for (const [key, b] of buckets) {
    const [surface, channel] = key.split(':');
    let cutoff = CUTOFF[surface] ?? 0;
    let points = b.points;
    // Null control (placebo-cutoff): falsify the RDD by relabeling `shown`
    // at the MEDIAN running-var instead of the real cutoff -- a sound
    // estimator finds ~0 jump at a non-treatment boundary. This retargets
    // the SECONDARY `rdd_jump` only; `effect`/`ci95` below come from
    // `b.perEvent` (the per-event cosShown-cosNear delta, computed from the
    // actual shown/near-miss split), untouched by this relabeling.
    if (placebo === 'cutoff') {
      const xs = points.map((p) => p.x).sort((a, z) => a - z);
      cutoff = xs[Math.floor(xs.length / 2)] ?? 0;
      points = points.map((p) => ({ ...p, shown: p.x >= cutoff }));
    }
    const { jump } = localLinearRdd(points, cutoff);
    const { mean, ci95 } = clusterBootstrap(b.perEvent, { seedTerms: key });
    // RMS around the bucket's OWN mean, not around zero -- centering on raw
    // zero folds a non-zero adoption signal's magnitude into the "noise" term,
    // inflating sd (and therefore mde, the pre-registered power-gate field).
    const sd = Math.sqrt(
      b.perEvent.reduce((s, r) => s + (r.value - mean) ** 2, 0) / Math.max(1, b.perEvent.length),
    );
    const nSessions = new Set(b.perEvent.map((r) => r.sessionId)).size;
    perBucket.push({
      surface,
      channel,
      nEvents: b.perEvent.length,
      nSessions,
      effect: mean, // PRIMARY: cluster-bootstrap mean of control-subtracted deltas (consistent with ci95)
      ci95,
      rdd_jump: jump, // SECONDARY: RDD local-linear jump (calibrated cutoff for ups-fts only)
      mde: mde(nSessions, sd, {}), // nSessions (not nEvents) to match the session-clustered CI -- conservative effective-n
    });
  }
  perBucket.sort((a, b) => (a.surface + a.channel).localeCompare(b.surface + b.channel));
  // Default (collectEvents=false) return is UNCHANGED from pre-Task-9 shape
  // -- `events` key only appears when explicitly requested.
  return collectEvents ? { perBucket, events: outEvents } : { perBucket };
}

// Task 9: cite-recall floor check + hand-label harness. All three functions
// below consume computeAdoption's `collectEvents:true` events -- the SAME
// run-wide-IDF action-channel per-event deltas the `*:action` perBucket rows
// are built from (see the collectEvents block above) -- so a hand-label AUC
// validates the actual reported metric, not a differently-scaled stand-in.

/**
 * Sensitivity floor: events whose injected id is (per the cite check above)
 * "cited" should show a bigger control-subtracted action delta than events
 * that aren't. This is a NECESSARY condition for the estimator to be
 * measuring something real (citePositive.effect > citeSilent.effect) -- not
 * by itself sufficient; see Task 8's placebo-random/placebo-cutoff nulls for
 * the falsification side of that argument.
 * @param {string} dir
 * @param {import('better-sqlite3').Database} db
 * @param {{ start: number, end: number, project?: string, m?: number }} opts
 * @returns {{ citePositive: { effect: number, n: number }, citeSilent: { effect: number, n: number } }}
 */
export function floorCheck(dir, db, opts) {
  const { events } = computeAdoption(dir, db, { ...opts, collectEvents: true });
  const mean = (rows) => (rows.length ? rows.reduce((s, r) => s + r.actionDelta, 0) / rows.length : 0);
  const citePositive = events.filter((r) => r.cited);
  const citeSilent = events.filter((r) => !r.cited);
  return {
    citePositive: { effect: mean(citePositive), n: citePositive.length },
    citeSilent: { effect: mean(citeSilent), n: citeSilent.length },
  };
}

/**
 * Emits N events for human hand-labeling ("did the model actually use this
 * lesson"), stratified by surface x lesson-specificity (round-robin across
 * strata so a small N doesn't get swallowed by whichever stratum happens to
 * be largest) -- for a later scoreLabels() AUC check of whether the
 * automated delta agrees with human judgment.
 * @param {string} dir
 * @param {import('better-sqlite3').Database} db
 * @param {{ N: number, out?: string, start: number, end: number, project?: string, m?: number }} args
 * @returns {number} count of rows written
 */
export function emitLabels(dir, db, { N, out = 'tasks/adoption-handlabel.jsonl', ...opts }) {
  const { events } = computeAdoption(dir, db, { ...opts, collectEvents: true });
  const strata = new Map();
  for (const r of events) {
    const k = `${r.surface}:${r.spec}`;
    if (!strata.has(k)) strata.set(k, []);
    strata.get(k).push(r);
  }
  const keys = [...strata.keys()];
  const picked = [];
  let i = 0;
  while (picked.length < N && keys.some((k) => strata.get(k).length)) {
    const bucket = strata.get(keys[i % keys.length]);
    i++;
    if (bucket.length) picked.push(bucket.shift());
  }
  const lines = picked.map((r, idx) =>
    JSON.stringify({
      id: `${r.sessionId}:${r.surface}:${idx}`,
      surface: r.surface,
      query: r.query,
      lessonText: r.lessonText,
      outputActions: r.outputActions,
      outputProse: r.outputProse,
      delta: r.actionDelta,
      label: null,
    }),
  );
  writeFileSync(out, lines.join('\n'));
  return picked.length;
}

/**
 * AUC of the automated per-event action delta vs a human label (0|1), via
 * the rank-sum (Mann-Whitney U) formulation -- no external stats dependency,
 * consistent with the rest of this benchmark suite (adoption-estimator.mjs's
 * seeded `lcg`, no Math.random).
 * @param {string} path - a file previously written by emitLabels, hand-edited
 *   to fill in `label: 0|1` (rows still `label: null` are excluded)
 * @returns {{ auc: number, nPos: number, nNeg: number }}
 */
export function scoreLabels(path) {
  const rows = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.label === 0 || r.label === 1);
  const pos = rows.filter((r) => r.label === 1).map((r) => r.delta);
  const neg = rows.filter((r) => r.label === 0).map((r) => r.delta);
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  const auc = pos.length && neg.length ? wins / (pos.length * neg.length) : NaN;
  return { auc, nPos: pos.length, nNeg: neg.length };
}

function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] ?? true] : [a, true];
    }),
  );
  const dir = args.dir || join(homedir(), '.claude/projects/-mnt-data-ssd-dev-projects-mem');
  const end = args.end ? new Date(args.end).getTime() : Date.now();
  const start = args.start ? new Date(args.start).getTime() : end - 30 * 86400000;
  const dbPath = args.db || DB_PATH;
  const db = new Database(dbPath, { readonly: true });

  // Task 9: floor-check/emit-labels/score-labels are validation-harness
  // entry points, not the main report -- each early-returns before the
  // placebo/computeAdoption report path below (no reason to pay for a
  // second, non-collectEvents computeAdoption run when one of these fires).
  if (args['floor-check']) {
    console.log(JSON.stringify(floorCheck(dir, db, { start, end, project: args.project }), null, 2));
    return;
  }
  if (args['emit-labels']) {
    const k = emitLabels(dir, db, {
      N: Number(args['emit-labels']),
      out: args.out,
      start,
      end,
      project: args.project,
    });
    console.log(`wrote ${k} label rows to ${args.out || 'tasks/adoption-handlabel.jsonl'}`);
    return;
  }
  if (args['score-labels']) {
    console.log(JSON.stringify(scoreLabels(args['score-labels']), null, 2));
    return;
  }

  // Null controls (falsification tests, not a normal run mode): --placebo-random
  // neutralizes the PRIMARY effect (swaps candidate text for a random DB
  // lesson -- ci95 should bracket 0); --placebo-cutoff falsifies the
  // SECONDARY rdd_jump (relabels shown/near-miss at the median running-var
  // instead of the real cutoff -- jump should be ~0). Mutually exclusive;
  // --placebo-random wins if both are passed.
  const placebo = args['placebo-random'] ? 'random' : args['placebo-cutoff'] ? 'cutoff' : undefined;
  const res = computeAdoption(dir, db, { start, end, project: args.project, placebo });
  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (placebo)
    console.log(
      `# NULL CONTROL: placebo-${placebo} active -- this run is a falsification test, not a real measurement`,
    );
  console.log(
    '# adoption-overlap (effect = cluster-bootstrap mean of control-subtracted cosine deltas; rdd_jump = RDD gradient-corrected view, informational for imperative/subagent)',
  );
  console.log(
    '# NOTE: effect is selection-confounded for top-1 surfaces (imperative/subagent) -- trust floorCheck + hand-label AUC for a GO decision, not effect+CI alone. subagent:* is also a parent-window proxy (see CUTOFF comment above) -- exclude from the subagent default-flip decision.',
  );
  console.log('  surface:channel        nEv  nSess    effect     95% CI              rdd_jump    MDE');
  for (const r of res.perBucket) {
    console.log(
      `  ${`${r.surface}:${r.channel}`.padEnd(22)} ${String(r.nEvents).padStart(4)} ${String(r.nSessions).padStart(5)}   ${r.effect.toFixed(4).padStart(8)}  [${r.ci95[0].toFixed(4)}, ${r.ci95[1].toFixed(4)}]  ${r.rdd_jump.toFixed(4).padStart(8)}  ${r.mde.toFixed(4)}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
