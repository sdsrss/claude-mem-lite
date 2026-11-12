#!/usr/bin/env node
// Session summary A/B for D21: does the summary model, also shown the session's EVENTS (the
// episodes the model typed bugfix / discovery / feature / refactor / decision, which the summary
// worker never read), stop leaving the session's main finished work out of `completed`, without
// writing done work as open or claiming work the session did not do? Built 2026-11-11 (R34).
//
// WHY A SIBLING OF summary-reply-ab.mjs. That ruler's judges see only the FINAL reply, and D21's
// defect is work reported in an EARLIER turn that later turns no longer mention — a ruler blind
// to earlier turns cannot say NO here (doctrine rule 9). Judges here see every turn's reply.
//
// ARMS, both through the shipped buildSessionSummaryPrompt (with a final reply, the D19 form: the
// last reply the session's Stop record holds), callLLM and parseJsonFromLLM, back to back, order
// alternating by item:
//   A  observations only — the input shipped before D21.
//   B  observations + the session's events, merged by the shipped mergeSummaryRows (≤ 30 events).
//   C  D22: observations + every turn's last reply as the Stop record holds them
//      (buildSessionSummaryPrompt's turnReplies), in place of the final reply alone.
//      `run --arms A,C` (default A,B).
//   S, M, S2  D23 (`run --arms S,M`), on its own population: sessions the worker skips because
//      no observation passes its filter (collectNoObsSessions). S = the row 6.34.0's Stop leaves,
//      replayed Stop by Stop into a private in-memory store (replayStopRow); M = one model call
//      over every recorded reply, merged onto S's row as the worker merges (mergeModelRow);
//      S2 = S verbatim, the A/A copy, judged in a batch apart from its session's S and M.
//      Gate: gateD23 (docs/audits/20261112-d23-preregistration.md).
//   C, C2, P  D25 (`run --arms C,C2,P`): C as above, C2 = C called again (the A/A arm), P = C's
//      prompt with COMPLETED_LEAD (completed opens with the main outcome). `--exclude rows.json`
//      leaves out the sessions an earlier reading drew. Judged on both views; gate: gateD25
//      (docs/audits/20261112-d25-preregistration.md).
//   C, C2, Q, Q2  D26 (`run --arms C,C2,Q,Q2`): Q = C's prompt with COMPLETED_ORDER (order by
//      importance, change nothing else), and every arm called twice, so the gate reads pooled
//      counts against the noise of a fresh call; gate: gateD26
//      (docs/audits/20261112-d26-preregistration.md).
//
// WHICH REPLIES (D#825). The worker reads what Stop recorded under the session (lib/turn-replies.mjs);
// stopReplies rebuilds that from the transcript. Reading 3 (D22's gate) took the replies from a
// time window instead, and that window carried the defect the 6.33.0 reviews found in the wiring:
// on 14 of its 30 sessions it differs from the record as stopReplies rebuilds it, among them a next
// session's report taken as the final reply (docs/measurement/rulers.md, reading 3).
// Per item it also records, outside the gate, the turn count, whether the final reply carries a
// Done / Not done report, and who wrote the stored row's `completed`; `score` splits by them.
//
// WHICH EVENTS. Rows written before D21 carry no session id, so "the session's events" is a
// time-window proxy over the same project. It starts at the session's first prompt or observation
// (earlier rows are the previous session's late episodes: R34 measured 29/253 sessions with some).
// It ends WINDOW_GRACE_MS after the session's last own activity (a prompt, an observation or its
// summary row), for the last turn's episode flush (the R34 review measured 1.4-244.5 s), and never
// after another real session in the project begins. NOT at the summary row: a session has ONE
// row, stamped by its FIRST Stop and never moved (lib/fast-summary.mjs), so the first cut of this
// ruler judged every multi-turn session on its first turn only (R34 review H1; that reading is
// void). A session another real session (not the `manual-<project>` save bucket) was active
// inside is left out of the population.
//
// POPULATION. Summary row newer than --days; ≥ 1 observation past the low-signal filter (the
// worker's own query); transcript on disk; ≥ 1 turn reply inside the window; ≥ 1 proxy event;
// no overlapping session. --n evenly spaced. Inputs are rebuilt from the store as it is now. The
// store is opened read-only and CLAUDE_MEM_DIR points at a private temp dir (doctrine rule 6).
//
// JUDGING (prepare → two blind judges per item → score). A judge sees every turn's reply in the
// window (scrubbed; each cut to head 700 + tail 300 chars, at most the first 4 and last 8 turns)
// and the arm's completed / remaining_items / next_steps, and answers YES / NO:
//   missed_done   the replies report a main piece of work finished that `completed` leaves out
//   false_open    remaining_items or next_steps present as not done work the replies report done
//   unsupported   `completed` claims finished work no reply mentions or implies
// Only items both judges answer YES count. Gate: gateD21 below, registered in
// tasks/specs/converge-r34-decisions.md before the first call.
//
// WHAT IT CANNOT SEE. Sessions with no observation at all (only events) — the worker skips them
// today, so arm A has nothing to compare; the wiring lets them through unmeasured. The shipped
// merge of a parsed Done / Not done report over the model's fields is not modelled. "Finished"
// means a reply says so. Same-family judges.
//
// Usage:
//   node benchmark/summary-events-ab.mjs run --out rows.json [--n 30] [--days 45] [--db path]
//     [--arms A,B | A,C | S,M | C,C2,P | C,C2,Q,Q2] [--exclude earlier-rows.json[,…]]
//   node benchmark/summary-events-ab.mjs prepare rows.json outdir [--seed 20261111] [--batches 2]
//     (judge files in outdir/judge/, key.json in outdir; verdicts-<k>-<a|b>.json go back into outdir)
//   node benchmark/summary-events-ab.mjs score outdir
//   node benchmark/summary-events-ab.mjs score line-outdir fields-outdir   (D25: both views)

import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickEvenly, enterArm, CLI_ARM } from './haiku-model-ab.mjs';
import { seededShuffle } from './lesson-blind-read.mjs';
import { wilson95 } from './wilson.mjs';
import { asText, summaryUsable, findTranscript } from './summary-reply-ab.mjs';
import { extractStructuredSummary } from '../lib/summary-extractor.mjs';
import {
  parseSummaryNotes,
  writeStopSummary,
  readFastSummarySource,
  mergeModelSummary,
  modelSummaryFields,
  FAST_SUMMARY_LIMITS,
} from '../lib/fast-summary.mjs';
import { buildSummaryLines } from '../hook-context.mjs';

// A and B are D21's arms; C is D22's (every turn's last reply). `run --arms` picks which run.
// S, M and S2 are D23's: `run --arms S,M` runs its own population and adds S2, the A/A copy.
// A2 is D24's A/A copy of arm A (`prepare --aa A`).
// C2 and P are D25's (`run --arms C,C2,P`): C2 is arm C called again, the A/A arm; P is arm C's
// prompt with COMPLETED_LEAD.
// Q and Q2 are D26's (`run --arms C,C2,Q,Q2`): Q is arm C's prompt with COMPLETED_ORDER, Q2 is Q
// called again; C2 and Q2 together are judged apart from their session's C and Q.
const ALL_ARMS = ['A', 'B', 'C', 'S', 'M', 'S2', 'A2', 'C2', 'P', 'Q', 'Q2'];
// An A/A copy is judged in a batch apart from its own session's other arms (buildBlind).
const COPY_ARMS = new Set(['S2', 'A2', 'C2', 'Q2']);

/**
 * D25's candidate (docs/audits/20261112-d25-preregistration.md): D24 found the 120-character
 * `Completed:` line missing the session's main finished work in 13 of 30 sessions while the
 * full field held it, listed after the details.
 */
export const COMPLETED_LEAD =
  "completed starts with the session's most important finished outcome, the one a person picking this work up next most needs to know (such as a release published, a deploy live, a fix merged or a measurement's verdict), in one short clause of at most 100 characters; the other finished items follow it.";

/**
 * D26's candidate (docs/audits/20261112-d26-preregistration.md). D25's COMPLETED_LEAD put the
 * main outcome on the line but halved `completed` and wrote done work as open more often; this
 * one asks for the order alone, with no length, and restates that the latest reply sets a state.
 */
export const COMPLETED_ORDER =
  "Order completed by importance: begin with the session's most important finished outcome, the one a person picking this work up next most needs to know (such as a release published, a deploy live, a fix merged or a measurement's verdict), then list every other finished item. This changes only the order: keep every item and detail you would otherwise include, and an item's state is still the one given by the latest reply that mentions it.";

/** The sentence each candidate arm adds to arm C's prompt. */
const CANDIDATE = { P: COMPLETED_LEAD, Q: COMPLETED_ORDER, Q2: COMPLETED_ORDER };

/**
 * Arm P: arm C's prompt with COMPLETED_LEAD closing the system part, where the paragraph on the
 * replies ends. Every session in the population has a reply, so that paragraph is always there.
 */
export function armPPrompt(prompt, sentence = COMPLETED_LEAD) {
  return { system: `${prompt.system} ${sentence}`, user: prompt.user };
}

/**
 * One arm's prompt for session `s`, through the shipped builder (passed in: run() loads it only
 * after pointing CLAUDE_MEM_DIR at its sandbox). A: observations + final reply; B: + events;
 * C and C2: every turn's reply; P: C's prompt with COMPLETED_LEAD; Q and Q2: with COMPLETED_ORDER.
 */
export function armPrompt(arm, s, { buildSessionSummaryPrompt, mergeSummaryRows }) {
  const shipped = buildSessionSummaryPrompt({
    project: s.project,
    observations: arm === 'B' ? mergeSummaryRows(s.observations, s.events) : s.observations,
    userPrompts: s.userPrompts,
    finalReply: s.replies.at(-1),
    ...(['C', 'C2', 'P', 'Q', 'Q2'].includes(arm) ? { turnReplies: s.replies } : {}),
  });
  return CANDIDATE[arm] ? armPPrompt(shipped, CANDIDATE[arm]) : shipped;
}

/** The order the arms are called in for item i: rotated by one per item. */
export function armOrder(arms, i) {
  return arms.map((_, k) => arms[(k + i) % arms.length]);
}

/** The population minus the sessions earlier readings drew (`run --exclude <rows.json>[,…]`). */
export function holdout(items, ...drawn) {
  const seen = new Set(drawn.flatMap((d) => d.items.map((it) => it.sid)));
  return items.filter((s) => !seen.has(s.sid));
}
const QUESTIONS = ['missed_done', 'false_open', 'unsupported'];
// D24's questions, asked of the lines a new session is shown (`prepare --view line`).
export const LINE_QUESTIONS = ['line_misses_main', 'false_open', 'unsupported'];
const YN = ['YES', 'NO'];
const TURN_HEAD = 700;
const TURN_TAIL = 300;
const TURNS_FIRST = 4;
const TURNS_LAST = 8;
const WINDOW_GRACE_MS = 10 * 60 * 1000;

/** The replies as judges see them: each cut to head + tail, at most first 4 + last 8 turns. */
export function judgeReplies(replies) {
  const cut = (r) =>
    r.length <= TURN_HEAD + TURN_TAIL
      ? r
      : `${r.slice(0, TURN_HEAD)}\n[… ${r.length - TURN_HEAD - TURN_TAIL} chars omitted …]\n${r.slice(-TURN_TAIL)}`;
  const shown =
    replies.length <= TURNS_FIRST + TURNS_LAST
      ? replies.map((r, i) => ({ turn: i + 1, reply: cut(r) }))
      : [
          ...replies.slice(0, TURNS_FIRST).map((r, i) => ({ turn: i + 1, reply: cut(r) })),
          ...replies.slice(-TURNS_LAST).map((r, i) => ({
            turn: replies.length - TURNS_LAST + i + 1,
            reply: cut(r),
          })),
        ];
  return { turns: replies.length, shown };
}

/**
 * The pre-registered gate (tasks/specs/converge-r34-decisions.md, written before the first
 * call). Counts are items BOTH judges answered YES; `n` is the number of sessions.
 */
/**
 * D#825: the replies the shipped Stop record (lib/turn-replies.mjs) would hold for one memory
 * session, rebuilt from its transcript. Where the host left Stop records (stop_hook_summary, 181
 * of 183 transcripts here, 2026-11-12) they are the Stops: each takes the last assistant text since
 * the previous one. Text not followed by one before the next prompt, interrupt, compaction,
 * synthetic record (a cut turn) or API error (StopFailure) was never a Stop's and is dropped; a
 * meta record (a skill's body, a /loop prompt) changes nothing. In a transcript with no Stop record
 * at all, a Stop is the end of a host turn: before the next prompt, notice or command record, or
 * at the end of the file, a compaction not ending it. A Stop's text goes under the number of the
 * session's prompts stored by then (0 before the first), replacing an earlier one; a Stop outside
 * [start, end) is another session's (pre-ship reviews of abeac529 F4 and of e77aba2d).
 * @param {object[]} entries transcript records, in file order
 * @param {{start: number, end: number, prompts: number[]}} session epoch ms; stored prompt epochs
 * @returns {string[]} in prompt order
 */
export function stopReplies(entries, { start, end, prompts }) {
  return groupStops(stopEvents(entries, { start, end }), prompts);
}

/** Each Stop's text under the number of prompts stored by then, a later one replacing an earlier. */
function groupStops(stops, prompts) {
  const groups = new Map();
  for (const s of stops) groups.set(prompts.filter((p) => p <= s.at).length, s.text);
  return [...groups].sort((a, b) => a[0] - b[0]).map((g) => g[1]);
}

/**
 * Every Stop of one memory session in [start, end), in file order, as `{at, text}`: the rule
 * stopReplies documents, before grouping. D23's arm S replays each one, as Stop writes the
 * summary row on every turn.
 */
export function stopEvents(entries, { start, end }) {
  const out = [];
  const hostStops = entries.some((e) => e?.type === 'system' && e.subtype === 'stop_hook_summary');
  let last = null;
  let lastAt = null;
  const stop = () => {
    if (last !== null && lastAt >= start && lastAt < end) out.push({ at: lastAt, text: last });
    last = null;
  };
  for (const e of entries) {
    if (!e || typeof e !== 'object' || e.isSidechain) continue;
    if (e.type === 'assistant') {
      if (e.isApiErrorMessage || e.message?.model === '<synthetic>') {
        last = null;
        continue;
      }
      if (!Array.isArray(e.message?.content)) continue;
      const text = e.message.content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      if (text) {
        last = text;
        lastAt = Date.parse(e.timestamp || '');
      }
      continue;
    }
    if (e.type === 'system' && e.subtype === 'stop_hook_summary') {
      if (hostStops) stop();
      continue;
    }
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      last = null;
      continue;
    }
    if (e.type !== 'user' || e.isMeta || e.isCompactSummary) continue;
    const c = e.message?.content;
    if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) continue;
    const t =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((b) => (b?.type === 'text' ? b.text : '')).join('')
          : '';
    if (hostStops || /^\s*\[Request interrupted/.test(t)) last = null;
    else stop();
  }
  if (!hostStops) stop();
  return out;
}

export function gateD21({ A, B, agreement, n }) {
  const reasons = [];
  // An item without two valid verdicts counts as NO in every question, which favours an arm
  // only by missing data (R34 review L7): the reading is incomplete, so it cannot ship.
  for (const [arm, s] of [
    ['A', A],
    ['B', B],
  ]) {
    if (s.judged !== undefined && s.judged < n) reasons.push(`judged(${arm}) = ${s.judged} < ${n}`);
  }
  for (const q of QUESTIONS) {
    if (!(agreement[q] >= 0.7)) reasons.push(`${q} agreement ${agreement[q]} < 0.70`);
  }
  for (const [arm, s] of [
    ['A', A],
    ['B', B],
  ]) {
    if (s.usable < n - 2) reasons.push(`usable(${arm}) = ${s.usable} < ${n - 2}`);
  }
  if (B.missed_done > A.missed_done - 3)
    reasons.push(`missed_done(B) = ${B.missed_done} > missed_done(A)-3 = ${A.missed_done - 3}`);
  if (B.false_open > A.false_open + 1)
    reasons.push(`false_open(B) = ${B.false_open} > false_open(A)+1 = ${A.false_open + 1}`);
  if (B.unsupported > A.unsupported + 1)
    reasons.push(`unsupported(B) = ${B.unsupported} > unsupported(A)+1 = ${A.unsupported + 1}`);
  return { ship: reasons.length === 0, reasons };
}

/**
 * D23's registered rule (docs/audits/20261112-d23-preregistration.md §3, §4, §7). Fewer than 20
 * sessions, an A/A copy not judged in full, or an A/A gap in missed_done above 1 decides nothing
 * ('none'); otherwise gateD21 with S as A and M as B decides 'ship' or 'no'.
 */
export function gateD23({ S, M, S2, agreement, n }) {
  if (n < 20) return { decision: 'none', reasons: [`n = ${n} < 20`] };
  if (!S2 || S2.judged < n)
    return { decision: 'none', reasons: [`A/A: judged(S2) = ${S2?.judged ?? 0} < ${n}`] };
  const gap = Math.abs(S2.missed_done - S.missed_done);
  if (gap > 1) return { decision: 'none', reasons: [`A/A: |missed_done(S2) - missed_done(S)| = ${gap} > 1`] };
  const g = gateD21({ A: S, B: M, agreement, n });
  return { decision: g.ship ? 'ship' : 'no', reasons: g.reasons };
}

/**
 * D24's registered rule (docs/audits/20261112-d24-preregistration.md §4), on the line view.
 * Invalid ('none'): an arm of A, C, A2 not judged in full, usable(A or C) below n - 2,
 * line_misses_main agreement below 0.70, or an A/A gap above 2. Otherwise 'open' when
 * C >= A + 3 (d1) or C >= a third of n (d2), else 'record'.
 */
export function gateD24({ A, C, A2, agreement, n }) {
  const reasons = [];
  for (const [arm, s] of [
    ['A', A],
    ['C', C],
    ['A2', A2],
  ]) {
    if (!s || !(s.judged >= n)) reasons.push(`judged(${arm}) = ${s?.judged ?? 0} < ${n}`);
  }
  for (const [arm, s] of [
    ['A', A],
    ['C', C],
  ]) {
    if (s && s.usable < n - 2) reasons.push(`usable(${arm}) = ${s.usable} < ${n - 2}`);
  }
  if (!(agreement.line_misses_main >= 0.7))
    reasons.push(`line_misses_main agreement ${agreement.line_misses_main} < 0.70`);
  if (A && A2) {
    const gap = Math.abs(A2.line_misses_main - A.line_misses_main);
    if (gap > 2) reasons.push(`A/A: |line_misses_main(A2) - line_misses_main(A)| = ${gap} > 2`);
  }
  if (reasons.length > 0) return { decision: 'none', d1: false, d2: false, reasons };
  const d1 = C.line_misses_main >= A.line_misses_main + 3;
  const d2 = C.line_misses_main >= Math.ceil(n / 3);
  return { decision: d1 || d2 ? 'open' : 'record', d1, d2, reasons };
}

/**
 * D25's registered rule (docs/audits/20261112-d25-preregistration.md §4). `line` and `fields` are
 * scoreVerdicts results over the same rows, judged on the line view and on the full fields.
 * 'none' when a reading is incomplete, usable(C or P) is below n - 2, an agreement is below 0.70,
 * or the A/A arm C2 is off C by more than 2 on line_misses_main or 1 on missed_done. Otherwise
 * 'ship' when P misses the main work on the line at least 3 fewer times than C and adds at most
 * 1 to every other count in either view, else 'no'.
 */
export function gateD25({ line, fields, n }) {
  const reasons = [];
  for (const [view, r, questions] of [
    ['line', line, LINE_QUESTIONS],
    ['fields', fields, QUESTIONS],
  ]) {
    for (const arm of ['C', 'C2', 'P']) {
      const s = r?.arms?.[arm];
      if (!s || !(s.judged >= n)) reasons.push(`${view}: judged(${arm}) = ${s?.judged ?? 0} < ${n}`);
    }
    for (const q of questions) {
      if (!(r?.agreement?.[q] >= 0.7)) reasons.push(`${view}: ${q} agreement ${r?.agreement?.[q]} < 0.70`);
    }
  }
  for (const arm of ['C', 'P']) {
    const s = line?.arms?.[arm];
    if (s && s.usable < n - 2) reasons.push(`usable(${arm}) = ${s.usable} < ${n - 2}`);
  }
  if (reasons.length > 0) return { decision: 'none', reasons };
  const L = line.arms;
  const F = fields.arms;
  const lineGap = Math.abs(L.C2.line_misses_main - L.C.line_misses_main);
  if (lineGap > 2) reasons.push(`A/A: |line_misses_main(C2) - line_misses_main(C)| = ${lineGap} > 2`);
  const fieldsGap = Math.abs(F.C2.missed_done - F.C.missed_done);
  if (fieldsGap > 1) reasons.push(`A/A: |missed_done(C2) - missed_done(C)| = ${fieldsGap} > 1`);
  if (reasons.length > 0) return { decision: 'none', reasons };
  if (L.P.line_misses_main > L.C.line_misses_main - 3)
    reasons.push(
      `line: line_misses_main(P) = ${L.P.line_misses_main} > line_misses_main(C)-3 = ${L.C.line_misses_main - 3}`,
    );
  for (const [view, A, q] of [
    ['line', L, 'false_open'],
    ['line', L, 'unsupported'],
    ['fields', F, 'missed_done'],
    ['fields', F, 'false_open'],
    ['fields', F, 'unsupported'],
  ]) {
    if (A.P[q] > A.C[q] + 1) reasons.push(`${view}: ${q}(P) = ${A.P[q]} > ${q}(C)+1 = ${A.C[q] + 1}`);
  }
  return { decision: reasons.length === 0 ? 'ship' : 'no', reasons };
}

/**
 * D26's registered rule (docs/audits/20261112-d26-preregistration.md §4). Every arm is called
 * twice (C, C2; Q, Q2) and counts are pooled over the two calls (out of 2n).
 * 'none' when a reading is incomplete, an arm's usable is below n - 2, an agreement is below 0.70,
 * or a second call is off its first by more than 8 on line_misses_main or 2 on missed_done.
 * Otherwise 'ship' when Q + Q2 miss the main work on the line at least 10 fewer times than
 * C + C2, each call of Q at least 3 fewer than its batch-mate call of C (Q vs C, Q2 vs C2), and
 * every other pooled count in either view rises by at most 2; else 'no'.
 */
export function gateD26({ line, fields, n }) {
  const reasons = [];
  const arms = ['C', 'C2', 'Q', 'Q2'];
  for (const [view, r, questions] of [
    ['line', line, LINE_QUESTIONS],
    ['fields', fields, QUESTIONS],
  ]) {
    for (const arm of arms) {
      const s = r?.arms?.[arm];
      if (!s || !(s.judged >= n)) reasons.push(`${view}: judged(${arm}) = ${s?.judged ?? 0} < ${n}`);
    }
    for (const q of questions) {
      if (!(r?.agreement?.[q] >= 0.7)) reasons.push(`${view}: ${q} agreement ${r?.agreement?.[q]} < 0.70`);
    }
  }
  for (const arm of arms) {
    const s = line?.arms?.[arm];
    if (s && s.usable < n - 2) reasons.push(`usable(${arm}) = ${s.usable} < ${n - 2}`);
  }
  if (reasons.length > 0) return { decision: 'none', reasons };
  const L = line.arms;
  const F = fields.arms;
  for (const [x, y] of [
    ['C', 'C2'],
    ['Q', 'Q2'],
  ]) {
    const lineGap = Math.abs(L[y].line_misses_main - L[x].line_misses_main);
    if (lineGap > 8) reasons.push(`A/A: |line_misses_main(${y}) - line_misses_main(${x})| = ${lineGap} > 8`);
    const fieldsGap = Math.abs(F[y].missed_done - F[x].missed_done);
    if (fieldsGap > 2) reasons.push(`A/A: |missed_done(${y}) - missed_done(${x})| = ${fieldsGap} > 2`);
  }
  if (reasons.length > 0) return { decision: 'none', reasons };
  const pooled = (A, arm, q) => A[arm][q] + A[`${arm}2`][q];
  const cLine = pooled(L, 'C', 'line_misses_main');
  const qLine = pooled(L, 'Q', 'line_misses_main');
  if (qLine > cLine - 10) reasons.push(`line: line_misses_main(Q+Q2) = ${qLine} > (C+C2)-10 = ${cLine - 10}`);
  for (const [q, c] of [
    ['Q', 'C'],
    ['Q2', 'C2'],
  ]) {
    if (L[q].line_misses_main > L[c].line_misses_main - 3)
      reasons.push(
        `line: line_misses_main(${q}) = ${L[q].line_misses_main} > line_misses_main(${c})-3 = ${L[c].line_misses_main - 3}`,
      );
  }
  for (const [view, A, q] of [
    ['line', L, 'false_open'],
    ['line', L, 'unsupported'],
    ['fields', F, 'missed_done'],
    ['fields', F, 'false_open'],
    ['fields', F, 'unsupported'],
  ]) {
    const cq = pooled(A, 'C', q);
    const qq = pooled(A, 'Q', q);
    if (qq > cq + 2) reasons.push(`${view}: ${q}(Q+Q2) = ${qq} > (C+C2)+2 = ${cq + 2}`);
  }
  return { decision: reasons.length === 0 ? 'ship' : 'no', reasons };
}

/** Unblind two judges' verdicts (id → {question: 'YES' | 'NO'}), over `questions`. */
export function scoreVerdicts(key, a, b, usableByArm, questions = QUESTIONS) {
  const present = ALL_ARMS.filter((x) => x in usableByArm || Object.values(key).some((k) => k.arm === x));
  const arms = Object.fromEntries(
    present.map((arm) => [
      arm,
      { n: 0, judged: 0, usable: usableByArm[arm] ?? 0, ...Object.fromEntries(questions.map((q) => [q, 0])) },
    ]),
  );
  const same = Object.fromEntries(questions.map((q) => [q, 0]));
  let judged = 0;
  for (const [id, { arm }] of Object.entries(key)) {
    const s = arms[arm];
    s.n++;
    const va = a[id];
    const vb = b[id];
    if (!va || !vb || questions.some((q) => !YN.includes(va[q]) || !YN.includes(vb[q]))) continue;
    s.judged++;
    judged++;
    for (const q of questions) {
      if (va[q] === vb[q]) same[q]++;
      if (va[q] === 'YES' && vb[q] === 'YES') s[q]++;
    }
  }
  for (const s of Object.values(arms)) {
    for (const q of questions) s[`${q}CI`] = wilson95(s[q], s.judged);
  }
  const agreement = Object.fromEntries(questions.map((q) => [q, judged ? same[q] / judged : 0]));
  return { arms, agreement: { ...agreement, n: judged } };
}

/** The population, oldest first. `db` is a read-only handle on the store. */
export function collectSessions(db, { days, now, projectsDir, notLowSignalTitleClause, readEntries }) {
  const sessions = db
    .prepare(
      `SELECT memory_session_id AS sid, project, MAX(created_at_epoch) AS e FROM session_summaries
       WHERE created_at_epoch > ? GROUP BY memory_session_id ORDER BY e ASC, sid ASC`,
    )
    .all(now - days * 86400e3);
  const obsQ = db.prepare(`SELECT id, type, title, narrative, created_at_epoch FROM observations
    WHERE memory_session_id = ? AND ${notLowSignalTitleClause('')}
    ORDER BY created_at_epoch DESC, id DESC LIMIT 30`);
  const promptsQ = db.prepare(
    'SELECT prompt_text, created_at_epoch FROM user_prompts WHERE content_session_id = ? ORDER BY prompt_number ASC LIMIT 10',
  );
  const firstQ = db.prepare(`SELECT MIN(e) AS e FROM (
      SELECT MIN(created_at_epoch) AS e FROM user_prompts WHERE content_session_id = ?
      UNION ALL SELECT MIN(created_at_epoch) FROM observations WHERE memory_session_id = ?)`);
  const lastQ = db.prepare(`SELECT MAX(e) AS e FROM (
      SELECT MAX(created_at_epoch) AS e FROM user_prompts WHERE content_session_id = ?
      UNION ALL SELECT MAX(created_at_epoch) FROM observations WHERE memory_session_id = ?
      UNION ALL SELECT MAX(created_at_epoch) FROM session_summaries WHERE memory_session_id = ?)`);
  // The first activity of another real session in the project after `at`: the window ends before it.
  const nextQ = db.prepare(`SELECT MIN(e) AS e FROM (
      SELECT memory_session_id AS sid, created_at_epoch AS e FROM observations WHERE project = ? AND created_at_epoch > ?
      UNION ALL SELECT u.content_session_id, u.created_at_epoch FROM user_prompts u JOIN sdk_sessions k ON k.content_session_id = u.content_session_id
        WHERE k.project = ? AND u.created_at_epoch > ?)
    WHERE sid != ? AND sid NOT LIKE 'manual-%'`);
  const otherQ = db.prepare(`SELECT COUNT(*) AS n FROM (
      SELECT memory_session_id AS sid FROM observations WHERE project = ? AND created_at_epoch BETWEEN ? AND ?
      UNION ALL SELECT u.content_session_id FROM user_prompts u JOIN sdk_sessions k ON k.content_session_id = u.content_session_id
        WHERE k.project = ? AND u.created_at_epoch BETWEEN ? AND ?)
    WHERE sid != ? AND sid NOT LIKE 'manual-%'`);
  const eventsQ = db.prepare(`SELECT id, event_type, title, body, created_at_epoch FROM events
    WHERE project = ? AND superseded_at_epoch IS NULL AND created_at_epoch BETWEEN ? AND ?
    ORDER BY created_at_epoch DESC, id DESC LIMIT ?`);
  const notesQ = db.prepare(`SELECT notes FROM session_summaries WHERE memory_session_id = ?
    ORDER BY created_at_epoch DESC, id DESC LIMIT 1`);
  const stopsOf = sessionStopReader(db);
  const ccQ = db.prepare(`SELECT cc_session_id AS cc FROM user_prompts
    WHERE content_session_id = ? AND cc_session_id IS NOT NULL ORDER BY prompt_number DESC LIMIT 1`);
  const out = [];
  const drop = { noObs: 0, noFirst: 0, overlap: 0, noEvents: 0, noTranscript: 0, noTurns: 0 };
  for (const s of sessions) {
    const observations = obsQ.all(s.sid);
    if (observations.length === 0) {
      drop.noObs++;
      continue;
    }
    const first = firstQ.get(s.sid, s.sid).e;
    if (first == null) {
      drop.noFirst++;
      continue;
    }
    const last = lastQ.get(s.sid, s.sid, s.sid).e;
    if (otherQ.get(s.project, first, last, s.project, first, last, s.sid).n > 0) {
      drop.overlap++;
      continue;
    }
    const next = nextQ.get(s.project, last, s.project, last, s.sid).e;
    const end = Math.min(last + WINDOW_GRACE_MS, next == null ? Infinity : next - 1);
    const events = eventsQ.all(s.project, first, end, 30);
    if (events.length === 0) {
      drop.noEvents++;
      continue;
    }
    const cc = ccQ.get(s.sid)?.cc;
    const transcript = findTranscript(cc, projectsDir);
    if (!transcript) {
      drop.noTranscript++;
      continue;
    }
    const { replies } = stopsOf(s.sid, cc, first, readEntries(transcript));
    if (replies.length === 0) {
      drop.noTurns++;
      continue;
    }
    out.push({
      sid: s.sid,
      project: s.project,
      observations,
      events,
      userPrompts: promptsQ.all(s.sid).map((p) => p.prompt_text),
      replies,
      // Who wrote the stored row's `completed` (lib/fast-summary.mjs): descriptive only, since a
      // `report` Done is kept over the model's in production and the arms do not model that.
      provenance: parseSummaryNotes(notesQ.get(s.sid)?.notes).done,
    });
  }
  return { windowed: sessions.length, drop, items: out };
}

/**
 * One memory session's Stops (stopEvents) and replies (stopReplies) from its transcript. The
 * Stop record's owner bounds: the session's own start, up to the next memory session of the same
 * transcript (a resume, or a rotation that stored a prompt) or the first compaction after it
 * began (SessionStart rotates there, prompt or not). Another terminal's session in the project
 * does not end it.
 */
function sessionStopReader(db) {
  const startQ = db.prepare('SELECT started_at_epoch AS e FROM sdk_sessions WHERE content_session_id = ?');
  const promptEpochsQ = db.prepare(
    'SELECT created_at_epoch AS e FROM user_prompts WHERE content_session_id = ? ORDER BY created_at_epoch',
  );
  const nextInTranscriptQ = db.prepare(`SELECT MIN(k.started_at_epoch) AS e FROM sdk_sessions k
    WHERE k.started_at_epoch > ? AND k.content_session_id != ?
      AND EXISTS (SELECT 1 FROM user_prompts u WHERE u.content_session_id = k.content_session_id AND u.cc_session_id = ?)`);
  return (sid, cc, first, entries) => {
    const start = startQ.get(sid)?.e ?? first;
    let end = nextInTranscriptQ.get(start, sid, cc)?.e ?? Infinity;
    for (const e of entries) {
      if (e?.type !== 'system' || e.subtype !== 'compact_boundary') continue;
      const at = Date.parse(e.timestamp || '');
      // A session /compact opened starts 49-259 ms before its boundary (manual, 52 of 52 here).
      if (at > start + 5000 && at < end) end = at;
    }
    const stops = stopEvents(entries, { start, end });
    return {
      stops,
      replies: groupStops(
        stops,
        promptEpochsQ.all(sid).map((p) => p.e),
      ),
    };
  };
}

/**
 * D23's population (docs/audits/20261112-d23-preregistration.md §3), oldest first: a summary row
 * newer than `days`, no observation past the low-signal filter (the worker's own query, so it
 * returns no-obs), the transcript on disk, at least two recorded replies. Each item carries what
 * arm S replays: every Stop, and the session's prompts and observations with their stamps.
 * `db` is a read-only handle on the store.
 */
export function collectNoObsSessions(db, { days, now, projectsDir, notLowSignalTitleClause, readEntries }) {
  const sessions = db
    .prepare(
      `SELECT memory_session_id AS sid, project, MAX(created_at_epoch) AS e FROM session_summaries
       WHERE created_at_epoch > ? GROUP BY memory_session_id ORDER BY e ASC, sid ASC`,
    )
    .all(now - days * 86400e3);
  const filteredQ = db.prepare(`SELECT COUNT(*) AS n FROM observations
    WHERE memory_session_id = ? AND ${notLowSignalTitleClause('')}`);
  const firstQ = db.prepare(`SELECT MIN(e) AS e FROM (
      SELECT MIN(created_at_epoch) AS e FROM user_prompts WHERE content_session_id = ?
      UNION ALL SELECT MIN(created_at_epoch) FROM observations WHERE memory_session_id = ?)`);
  const promptRowsQ = db.prepare(`SELECT prompt_text, prompt_number, created_at_epoch FROM user_prompts
    WHERE content_session_id = ? ORDER BY prompt_number ASC`);
  const obsRowsQ = db.prepare(`SELECT type, title, compressed_into, created_at_epoch FROM observations
    WHERE memory_session_id = ? ORDER BY created_at_epoch ASC, id ASC`);
  const ccQ = db.prepare(`SELECT cc_session_id AS cc FROM user_prompts
    WHERE content_session_id = ? AND cc_session_id IS NOT NULL ORDER BY prompt_number DESC LIMIT 1`);
  const stopsOf = sessionStopReader(db);
  const out = [];
  const drop = { hasObs: 0, noFirst: 0, noTranscript: 0, fewReplies: 0 };
  for (const s of sessions) {
    if (filteredQ.get(s.sid).n > 0) {
      drop.hasObs++;
      continue;
    }
    const first = firstQ.get(s.sid, s.sid).e;
    if (first == null) {
      drop.noFirst++;
      continue;
    }
    const cc = ccQ.get(s.sid)?.cc;
    const transcript = findTranscript(cc, projectsDir);
    if (!transcript) {
      drop.noTranscript++;
      continue;
    }
    const { stops, replies } = stopsOf(s.sid, cc, first, readEntries(transcript));
    if (replies.length < 2) {
      drop.fewReplies++;
      continue;
    }
    const prompts = promptRowsQ.all(s.sid);
    out.push({
      sid: s.sid,
      project: s.project,
      prompts,
      observations: obsRowsQ.all(s.sid),
      stops,
      replies,
      // The worker's own read: the first 10 by prompt_number.
      userPrompts: prompts.slice(0, 10).map((p) => p.prompt_text),
    });
  }
  return { windowed: sessions.length, drop, items: out };
}

const SUMMARY_ROW_SQL = `SELECT completed, remaining_items, next_steps, notes FROM session_summaries
  WHERE memory_session_id = ? ORDER BY created_at_epoch DESC, id DESC LIMIT 1`;

/**
 * Arm S (D23): the row 6.34.0's Stop leaves for the session. Each Stop in turn sees the prompts
 * and observations stamped by then, extracts its reply's report and writes through the shipped
 * writeStopSummary, as hook.mjs's writeFastSummaryBaseline does on every turn. `db` is an empty
 * store with the schema. Returns the session's row, or null.
 */
export function replayStopRow(db, { sid, project, prompts, observations, stops }) {
  const begin = Math.min(
    ...[...prompts, ...observations].map((r) => r.created_at_epoch),
    ...stops.map((s) => s.at),
  );
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sid, sid, project, new Date(begin).toISOString(), begin);
  const insPrompt = db.prepare(`INSERT INTO user_prompts
    (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?)`);
  const insObs = db.prepare(`INSERT INTO observations
    (memory_session_id, project, type, title, compressed_into, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let p = 0;
  let o = 0;
  for (const s of stops) {
    for (; p < prompts.length && prompts[p].created_at_epoch <= s.at; p++) {
      const r = prompts[p];
      const at = r.created_at_epoch;
      insPrompt.run(sid, r.prompt_text, r.prompt_number, new Date(at).toISOString(), at);
    }
    for (; o < observations.length && observations[o].created_at_epoch <= s.at; o++) {
      const r = observations[o];
      const at = r.created_at_epoch;
      insObs.run(sid, project, r.type, r.title, r.compressed_into, new Date(at).toISOString(), at);
    }
    const r = extractStructuredSummary(s.text);
    const lines = [r.failed && `Failed: ${r.failed}`, r.uncertain && `Uncertain: ${r.uncertain}`]
      .filter(Boolean)
      .join('\n');
    writeStopSummary(db, {
      sessionId: sid,
      project,
      report: { done: r.done, notDone: r.notDone, lines, tail: s.text },
      source: readFastSummarySource(db, sid),
      now: new Date(s.at),
      limits: FAST_SUMMARY_LIMITS.stop,
    });
  }
  return db.prepare(SUMMARY_ROW_SQL).get(sid) ?? null;
}

/** Arm M's prompt input (§1's candidate): no observations, every recorded reply, the worker's prompts. */
export function armMPromptInput(s) {
  return {
    project: s.project,
    observations: [],
    userPrompts: s.userPrompts,
    finalReply: s.replies.at(-1),
    turnReplies: s.replies,
  };
}

/**
 * Arm M (D23): the model's parsed reply merged onto arm S's row in the same store, through the
 * worker's own cleaning (modelSummaryFields) and write (mergeModelSummary). A reply with nothing
 * to write leaves the row as it was, as in the worker.
 */
export function mergeModelRow(db, { sid, project, parsed, now }) {
  const fields = modelSummaryFields(parsed);
  if (fields) mergeModelSummary(db, { sessionId: sid, project, fields, now });
  return db.prepare(SUMMARY_ROW_SQL).get(sid) ?? null;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function run() {
  const out = arg('--out', null);
  if (!out) throw new Error('run needs --out <rows.json>');
  const n = Number(arg('--n', '30'));
  const days = Number(arg('--days', '45'));
  const arms = arg('--arms', 'A,B').split(',');
  const d23 = arms.join(',') === 'S,M';
  const d25 = arms.join(',') === 'C,C2,P';
  const d26 = arms.join(',') === 'C,C2,Q,Q2';
  if (
    !d23 &&
    !d25 &&
    !d26 &&
    (arms.length < 2 || arms.some((x) => !['A', 'B', 'C'].includes(x)) || new Set(arms).size !== arms.length)
  )
    throw new Error(
      '--arms takes two or more of A,B,C, or exactly S,M (D23), or exactly C,C2,P (D25), or exactly C,C2,Q,Q2 (D26)',
    );
  const exclude = arg('--exclude', null);
  const dbPath = arg('--db', join(homedir(), '.claude-mem-lite', 'claude-mem-lite.db'));
  // Before any shipped module loads: DB_DIR resolves from it at import time.
  const sandbox = mkdtempSync(join(tmpdir(), 'summary-events-ab-'));
  process.env.CLAUDE_MEM_DIR = sandbox;
  process.env.CLAUDE_MEM_NO_DELAY = '1';
  try {
    const { default: Database } = await import('better-sqlite3');
    const hc = await import('../haiku-client.mjs');
    const { callLLM } = await import('../lib/llm-call.mjs');
    const { parseJsonFromLLM, scrubSecrets, notLowSignalTitleClause } = await import('../utils.mjs');
    const { buildSessionSummaryPrompt, mergeSummaryRows } = await import('../hook-llm.mjs');
    const { readTranscriptEntries } = await import('../lib/transcript-scan.mjs');

    const restore = enterArm(CLI_ARM, process.env, hc._resetMode);
    try {
      if (hc.detectMode() !== 'cli') throw new Error(`provider mode is ${hc.detectMode()}, not cli`);
      const cliVersion = execFileSync(hc.getClaudePath(), ['--version'], {
        encoding: 'utf8',
        timeout: 30000,
      }).trim();
      if (d23) {
        const { initSchema } = await import('../schema.mjs');
        await runNoObs({
          dbPath,
          n,
          days,
          out,
          cliVersion,
          deps: {
            Database,
            initSchema,
            hc,
            callLLM,
            parseJsonFromLLM,
            scrubSecrets,
            notLowSignalTitleClause,
          },
          buildSessionSummaryPrompt,
          readTranscriptEntries,
        });
        return;
      }
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      let pop;
      try {
        pop = collectSessions(db, {
          days,
          now: Date.now(),
          projectsDir: join(homedir(), '.claude', 'projects'),
          notLowSignalTitleClause,
          readEntries: readTranscriptEntries,
        });
      } finally {
        db.close();
      }
      const drawn = exclude ? exclude.split(',').map((f) => JSON.parse(readFileSync(f, 'utf8'))) : null;
      const eligible = drawn ? holdout(pop.items, ...drawn) : pop.items;
      const picked = pickEvenly(eligible, n);
      const items = picked.map((s, i) => ({
        item: i,
        sid: s.sid,
        project: s.project,
        events: s.events.length,
        turns: s.replies.length,
        provenance: s.provenance,
        finalReport: (() => {
          const r = extractStructuredSummary(s.replies.at(-1));
          return Boolean(r.done || r.notDone);
        })(),
        replies: judgeReplies(s.replies.map((r) => scrubSecrets(r).trim())),
      }));
      const rows = [];
      for (let i = 0; i < picked.length; i++) {
        const s = picked[i];
        for (const arm of armOrder(arms, i)) {
          const prompt = armPrompt(arm, s, { buildSessionSummaryPrompt, mergeSummaryRows });
          const t0 = Date.now();
          let raw = null;
          try {
            raw = await callLLM(prompt, hc.BG_LLM_TIMEOUT_MS);
          } catch (e) {
            console.error(`item ${i} arm ${arm}: ${e?.message || e}`);
          }
          const p = raw ? parseJsonFromLLM(raw) : null;
          rows.push({
            item: i,
            arm,
            ms: Date.now() - t0,
            promptChars: prompt.system.length + prompt.user.length,
            usable: summaryUsable(p),
            completedChars: asText(p?.completed).length,
            completed: asText(p?.completed),
            remaining_items: asText(p?.remaining_items),
            next_steps: asText(p?.next_steps),
          });
          console.error(
            `item ${i + 1}/${picked.length} arm ${arm}: ${rows.at(-1).usable ? 'usable' : 'NOT usable'}`,
          );
        }
      }
      const meta = {
        at: new Date().toISOString(),
        cliVersion,
        days,
        windowed: pop.windowed,
        drop: pop.drop,
        population: pop.items.length,
        ...(drawn ? { excluded: pop.items.length - eligible.length, eligible: eligible.length } : {}),
        n: picked.length,
        arms,
        // D25's A/A premise: a second call that returned C's fields verbatim measures judges only.
        ...(d25 || d26 ? { c2SameAsC: sameFields(rows, 'C', 'C2') } : {}),
        ...(d26 ? { q2SameAsQ: sameFields(rows, 'Q', 'Q2') } : {}),
      };
      writeFileSync(out, JSON.stringify({ meta, items, rows }, null, 2));
      console.log(JSON.stringify({ meta, ...describeRows(rows, arms) }, null, 2));
    } finally {
      restore();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/**
 * D23's run: per session, arm S replayed into a private in-memory store, one model call for arm
 * M merged onto that row, and S2 = S verbatim (the A/A copy). Only M calls the model.
 */
async function runNoObs({
  dbPath,
  n,
  days,
  out,
  cliVersion,
  deps,
  buildSessionSummaryPrompt,
  readTranscriptEntries,
}) {
  const { Database, initSchema, hc, callLLM, parseJsonFromLLM, scrubSecrets, notLowSignalTitleClause } = deps;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let pop;
  try {
    pop = collectNoObsSessions(db, {
      days,
      now: Date.now(),
      projectsDir: join(homedir(), '.claude', 'projects'),
      notLowSignalTitleClause,
      readEntries: readTranscriptEntries,
    });
  } finally {
    db.close();
  }
  const picked = pickEvenly(pop.items, n);
  const items = [];
  const rows = [];
  for (let i = 0; i < picked.length; i++) {
    const s = picked[i];
    const mem = new Database(':memory:');
    try {
      initSchema(mem);
      const sRow = replayStopRow(mem, s);
      const prompt = buildSessionSummaryPrompt(armMPromptInput(s));
      const t0 = Date.now();
      let raw = null;
      try {
        raw = await callLLM(prompt, hc.BG_LLM_TIMEOUT_MS);
      } catch (e) {
        console.error(`item ${i}: ${e?.message || e}`);
      }
      const ms = Date.now() - t0;
      const parsed = raw ? parseJsonFromLLM(raw) : null;
      const mRow = mergeModelRow(mem, {
        sid: s.sid,
        project: s.project,
        parsed,
        now: new Date(s.stops.at(-1).at),
      });
      const r = extractStructuredSummary(s.replies.at(-1));
      items.push({
        item: i,
        sid: s.sid,
        project: s.project,
        turns: s.replies.length,
        stops: s.stops.length,
        provenance: parseSummaryNotes(sRow?.notes).done,
        finalReport: Boolean(r.done || r.notDone),
        replies: judgeReplies(s.replies.map((x) => scrubSecrets(x).trim())),
      });
      const fields = (row) => ({
        completed: row?.completed ?? '',
        remaining_items: row?.remaining_items ?? '',
        next_steps: row?.next_steps ?? '',
        completedChars: (row?.completed ?? '').length,
      });
      rows.push({ item: i, arm: 'S', usable: sRow !== null, ms: 0, promptChars: 0, ...fields(sRow) });
      rows.push({
        item: i,
        arm: 'M',
        usable: summaryUsable(parsed),
        ms,
        promptChars: prompt.system.length + prompt.user.length,
        // Not shown to judges: what the model wrote for `completed`, and whose Done the row kept.
        modelCompleted: asText(parsed?.completed),
        doneSource: parseSummaryNotes(mRow?.notes).done,
        ...fields(mRow),
      });
      rows.push({ item: i, arm: 'S2', usable: sRow !== null, ms: 0, promptChars: 0, ...fields(sRow) });
      console.error(`item ${i + 1}/${picked.length}: M ${summaryUsable(parsed) ? 'usable' : 'NOT usable'}`);
    } finally {
      mem.close();
    }
  }
  const arms = ['S', 'M', 'S2'];
  const meta = {
    at: new Date().toISOString(),
    cliVersion,
    days,
    windowed: pop.windowed,
    drop: pop.drop,
    population: pop.items.length,
    n: picked.length,
    arms,
  };
  writeFileSync(out, JSON.stringify({ meta, items, rows }, null, 2));
  console.log(JSON.stringify({ meta, ...describeRows(rows, arms) }, null, 2));
}

/** How many items have the same completed / remaining_items / next_steps in arms x and y. */
export function sameFields(rows, x, y) {
  const key = (r) => JSON.stringify([r.completed, r.remaining_items, r.next_steps]);
  const ys = new Map(rows.filter((r) => r.arm === y).map((r) => [r.item, key(r)]));
  return rows.filter((r) => r.arm === x && ys.get(r.item) === key(r)).length;
}

/** Per arm: usable count, mean / max prompt chars, mean `completed` chars, median call ms. */
export function describeRows(rows, arms) {
  const per = (f) => Object.fromEntries(arms.map((a) => [a, f(rows.filter((r) => r.arm === a))]));
  const mean = (xs) => Math.round(xs.reduce((x, y) => x + y, 0) / (xs.length || 1));
  const median = (xs) => {
    const v = [...xs].sort((x, y) => x - y);
    return v.length ? v[Math.floor((v.length - 1) / 2)] : 0;
  };
  return {
    usable: per((rs) => rs.filter((r) => r.usable).length),
    meanPromptChars: per((rs) => mean(rs.map((r) => r.promptChars))),
    maxPromptChars: per((rs) => Math.max(0, ...rs.map((r) => r.promptChars))),
    meanCompletedChars: per((rs) => mean(rs.map((r) => r.completedChars ?? 0))),
    medianMs: per((rs) => median(rs.map((r) => r.ms))),
  };
}

/**
 * Descriptive, outside the gate: both-YES counts per arm and question within groups of items —
 * single vs multi-turn, and the stored row's `completed` source.
 */
export function splitBothYes(key, a, b, items, questions = QUESTIONS) {
  const out = {};
  for (const [id, { arm, item }] of Object.entries(key)) {
    const meta = items[item] ?? {};
    const groups = [meta.turns > 1 ? 'multi' : 'single', `provenance:${meta.provenance ?? 'unknown'}`];
    for (const g of groups) {
      const cell = ((out[g] ??= {})[arm] ??= { n: 0, ...Object.fromEntries(questions.map((q) => [q, 0])) });
      cell.n++;
      for (const q of questions) if (a[id]?.[q] === 'YES' && b[id]?.[q] === 'YES') cell[q]++;
    }
  }
  return out;
}

/**
 * The lines a new session is shown about a summary row: the Completed / Remaining / Next lines
 * of the shipped SessionStart renderer (hook-context.mjs buildSummaryLines), cut there.
 */
export function lastSessionLines(row) {
  return buildSummaryLines({
    completed: row.completed,
    remaining_items: row.remaining_items,
    next_steps: row.next_steps,
  }).filter((l) => /^(Completed|Remaining|Next): /.test(l));
}

/** D24's A/A copy: every row of `arm` again, verbatim, as `<arm>2`. */
export function addCopyArm(dump, arm) {
  const copy = `${arm}2`;
  return {
    ...dump,
    meta: { ...dump.meta, arms: [...(dump.meta?.arms ?? []), copy] },
    rows: [...dump.rows, ...dump.rows.filter((r) => r.arm === arm).map((r) => ({ ...r, arm: copy }))],
  };
}

/**
 * Blind the rows: judge-facing batches in two orders each, and the key. `view` 'line' shows
 * judges the lines a new session is shown (lastSessionLines) instead of the full fields (D24).
 */
export function buildBlind(dump, { seed = 20261111, batches = 2, view = 'fields' } = {}) {
  const ids = seededShuffle(
    Array.from({ length: dump.rows.length }, (_, i) => `e${String(i + 1).padStart(3, '0')}`),
    seed,
  );
  const key = {};
  const entries = dump.rows.map((r, i) => {
    key[ids[i]] = { arm: r.arm, item: r.item };
    const shown =
      view === 'line'
        ? { lines: lastSessionLines(r) }
        : {
            summary: { completed: r.completed, remaining_items: r.remaining_items, next_steps: r.next_steps },
          };
    return { id: ids[i], replies: dump.items[r.item].replies, ...shown };
  });
  if (dump.rows.some((r) => COPY_ARMS.has(r.arm))) {
    // D23's A/A copy goes to a batch other than its own session's S and M: a judge shown the
    // same item twice agrees with itself, which hides the noise the copy is there to measure
    // (docs/audits/20261112-d23-preregistration.md §7). Sessions are split evenly by a shuffle.
    const sessions = seededShuffle([...new Set(dump.rows.map((r) => r.item))], seed + 1);
    const batchOf = new Map(sessions.map((it, i) => [it, Math.floor((i * batches) / sessions.length)]));
    const parts = Array.from({ length: batches }, () => []);
    dump.rows.forEach((r, i) => {
      const b = batchOf.get(r.item);
      parts[COPY_ARMS.has(r.arm) ? (b + 1) % batches : b].push(entries[i]);
    });
    return {
      batches: parts.map((part, k) => ({
        a: seededShuffle(part, seed + 100 + k),
        b: seededShuffle(part, seed + 2 + k),
      })),
      key,
    };
  }
  const shuffled = seededShuffle(entries, seed + 1);
  const size = Math.ceil(shuffled.length / batches);
  const out = [];
  for (let k = 0; k < batches; k++) {
    const part = shuffled.slice(k * size, (k + 1) * size);
    out.push({ a: part, b: seededShuffle(part, seed + 2 + k) });
  }
  return { batches: out, key };
}

function prepare() {
  const [dumpPath, outdir] = process.argv.slice(3, 5);
  if (!dumpPath || !outdir) throw new Error('prepare <rows.json> <outdir>');
  const aa = arg('--aa', null);
  const view = arg('--view', 'fields');
  if (view !== 'fields' && view !== 'line') throw new Error(`--view ${view}: fields | line`);
  const read = JSON.parse(readFileSync(dumpPath, 'utf8'));
  const dump = aa ? addCopyArm(read, aa) : read;
  const { batches, key } = buildBlind(dump, {
    seed: Number(arg('--seed', '20261111')),
    batches: Number(arg('--batches', '2')),
    view,
  });
  // Judges get `<outdir>/judge/` and nothing else; key.json stays one level up, out of the
  // directory they are pointed at (R34 review L6). Copy judge/ elsewhere to keep it out of reach.
  const judgeDir = join(outdir, 'judge');
  mkdirSync(judgeDir, { recursive: true });
  batches.forEach((b, k) => {
    writeFileSync(join(judgeDir, `batch-${k + 1}-a.json`), JSON.stringify(b.a, null, 2));
    writeFileSync(join(judgeDir, `batch-${k + 1}-b.json`), JSON.stringify(b.b, null, 2));
  });
  const arms = dump.meta.arms ?? ['A', 'B'];
  const usable = Object.fromEntries(
    arms.map((a) => [a, dump.rows.filter((r) => r.arm === a && r.usable).length]),
  );
  // Per-item facts for the descriptive split; judges never see this file.
  const items = dump.items.map((it) => ({
    turns: it.turns ?? it.replies.turns,
    provenance: it.provenance ?? null,
    finalReport: it.finalReport ?? null,
  }));
  writeFileSync(
    join(outdir, 'key.json'),
    JSON.stringify({ key, usable, n: dump.items.length, items, meta: dump.meta, view }, null, 2),
  );
  console.log(`${Object.keys(key).length} items in ${batches.length} batches → ${outdir}`);
}

function scoreDir(outdir) {
  const { key, usable, n, items, view } = JSON.parse(readFileSync(join(outdir, 'key.json'), 'utf8'));
  const questions = view === 'line' ? LINE_QUESTIONS : QUESTIONS;
  const merged = { a: {}, b: {} };
  for (const f of readdirSync(outdir)) {
    const m = /^verdicts-\d+-(a|b)\.json$/.exec(f);
    if (m) Object.assign(merged[m[1]], JSON.parse(readFileSync(join(outdir, f), 'utf8')));
  }
  const result = scoreVerdicts(key, merged.a, merged.b, usable, questions);
  const split = items ? splitBothYes(key, merged.a, merged.b, items, questions) : undefined;
  return { view: view ?? 'fields', n, result, split };
}

/**
 * `score <outdir>`, or D25's / D26's `score <line outdir> <fields outdir>`: the same rows judged
 * on both views, decided together by gateD25 (arm P) or gateD26 (arm Q).
 */
function score() {
  const dirs = process.argv.slice(3);
  if (dirs.length === 0) throw new Error('score <outdir> [<outdir>]');
  const scored = dirs.map(scoreDir);
  if (scored.some((s) => s.result.arms.Q)) {
    const line = scored.find((s) => s.view === 'line');
    const fields = scored.find((s) => s.view === 'fields');
    const gate = gateD26({ line: line?.result, fields: fields?.result, n: scored[0].n });
    console.log(JSON.stringify({ views: scored, gateD26: gate }, null, 2));
    return;
  }
  if (scored.some((s) => s.result.arms.P)) {
    const line = scored.find((s) => s.view === 'line');
    const fields = scored.find((s) => s.view === 'fields');
    const gate = gateD25({ line: line?.result, fields: fields?.result, n: scored[0].n });
    console.log(JSON.stringify({ views: scored, gateD25: gate }, null, 2));
    return;
  }
  if (dirs.length > 1) throw new Error('two outdirs are D25 or D26 only (arm P or Q)');
  const [{ view, n, result, split }] = scored;
  // D22 is registered as the D21 gate with arm C in B's place (tasks/specs/d22-summary-turn-replies.md).
  const gate =
    view === 'line'
      ? { gateD24: gateD24({ ...result.arms, agreement: result.agreement, n }) }
      : result.arms.M
        ? { gateD23: gateD23({ ...result.arms, agreement: result.agreement, n }) }
        : result.arms.C
          ? { gateD22: gateD21({ A: result.arms.A, B: result.arms.C, agreement: result.agreement, n }) }
          : { gateD21: gateD21({ ...result.arms, agreement: result.agreement, n }) };
  console.log(JSON.stringify({ ...result, ...gate, split }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fn = { run, prepare, score }[process.argv[2]];
  if (!fn) {
    console.error('usage: summary-events-ab.mjs run|prepare|score …');
    process.exit(2);
  }
  Promise.resolve(fn()).catch((e) => {
    console.error(e?.stack || e);
    process.exit(1);
  });
}
