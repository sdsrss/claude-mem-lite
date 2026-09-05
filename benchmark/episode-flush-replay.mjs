#!/usr/bin/env node
/**
 * EPISODE-FLUSH LIVE REPLAY — the ruler for D#178.
 *
 * THE CLAIM UNDER TEST. `flushEpisodeWithDb` consumes `reads-<project>.txt`
 * unconditionally (rename → read → unlink) while `flushEpisodeGroup` persists only
 * when `explainSignificance` says the episode is significant. So every insignificant
 * flush destroys whatever Read paths accumulated since the last flush, and the next
 * observation that IS saved carries `files_read: []`. D#174 confirmed the mechanism
 * with a probe; what nobody had was the MAGNITUDE, and the forward meter added in the
 * same round (`episode_reads`) only starts accruing from the day it ships.
 *
 * This script gets the number today, from data that already exists. There is no
 * fixture: the input is every real tool call in `~/.claude/projects/**.jsonl`, and the
 * batching is the SHIPPED batching — `isRelatedToEpisode`, `EPISODE_BUFFER_SIZE`,
 * `EPISODE_TIME_GAP_MS`, `planEpisodeFlush`, `explainSignificance` are imported, never
 * re-implemented. A copy of the flush rule here would be a twin of production and the
 * first thing to drift; this project has paid for that shape enough times.
 *
 *   node benchmark/episode-flush-replay.mjs                  # replay + report
 *   node benchmark/episode-flush-replay.mjs --since 2026-08-22
 *   node benchmark/episode-flush-replay.mjs --project projects--mem
 *   node benchmark/episode-flush-replay.mjs --json
 *
 * WHAT IT REPORTS. Per flush: how many distinct Read paths it consumed and whether any
 * of its sub-episodes was significant. Headline = the share of consumed reads destroyed
 * by insignificant flushes. Counterfactual = what the carry-forward fix (D#178 (b), and
 * (a) resolves to the same attachment) would put back, plus the AGE of the reads it
 * would carry — because "is a 40-minute-old Read still about this edit" is the open
 * question in that fix, and an unmeasured answer to it is how a fix ships worse than
 * the defect.
 *
 * THREE SELF-CHECKS, and the middle one is the only one with teeth against the model
 * itself:
 *   1. can-say-no — re-run the accounting with significance forced all-true and
 *      all-false; destroyed must be 0 and 100%. A ruler whose headline cannot reach
 *      either end is measuring its own constant.
 *   2. meter agreement — the live `episode_significance` rows are a DIRECT measurement
 *      of the quantity this replay models (share of flushes that are insignificant).
 *      Over the days both cover they must agree within MODEL_TOLERANCE_PP; they do not
 *      have to agree exactly (this walk skips `subagents/*.jsonl`, so it sees fewer
 *      tool calls than the hook did), but a structural break in the flush model shows
 *      up here and exits 1.
 *   3. corpus reachability — a project with transcripts but zero replayed flushes means
 *      the event extraction broke, not that the project was idle.
 *
 * KNOWN UNDER-COUNT, stated rather than silently absorbed: subagent transcripts live in
 * `<session>/subagents/agent-*.jsonl` and this walk is one level deep, so tool calls made
 * inside a dispatched agent — which DO fire PostToolUse and DO append to the same
 * project's reads file — are missing from the input. That biases both the flush count
 * and the reads count DOWN, in the same direction, and is the main reason check 2 is a
 * band rather than an equality.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SKIP_TOOLS, SKIP_PREFIXES } from '../skip-tools.mjs';
import { isRelatedToEpisode, extractFilePaths, makeEntryDesc } from '../utils.mjs';
import { buildImmediateObservation } from '../hook-llm.mjs';
import { isNoiseObservation, isLowYieldChangeObs } from '../lib/low-signal-patterns.mjs';
import { detectBashSignificance } from '../bash-utils.mjs';
import { projectNameFromDir } from '../project-utils.mjs';
import { createEpisode, planEpisodeFlush, explainSignificance } from '../hook-episode.mjs';
import { EPISODE_BUFFER_SIZE, EPISODE_TIME_GAP_MS } from '../hook-shared.mjs';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

/** Check 2's band. Wide on purpose — see KNOWN UNDER-COUNT above. */
const MODEL_TOLERANCE_PP = 15;

// ─── 1. Real tool streams out of the transcripts ─────────────────────────────

function transcriptDirs() {
  const root = process.env.CLAUDE_MEM_TRANSCRIPT_ROOT || join(homedir(), '.claude', 'projects');
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));
  } catch {
    return [];
  }
}

const textOf = (c) => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n');
  return '';
};

/** The hook's own skip decision, from the hook's own list. */
function isSkipped(tool) {
  return SKIP_TOOLS.has(tool) || SKIP_PREFIXES.some((p) => tool.startsWith(p));
}

/**
 * Turn one transcript file into the ordered event stream the hooks would have seen:
 * `read` (post-tool-use.sh's bash fast path), `tool` (handlePostToolUse), `stop`
 * (handleStop, which flushes the whole project buffer).
 *
 * Stop placement: Claude Code fires Stop when a turn ends, i.e. immediately before the
 * next HUMAN user message and once at end of file. A `user` record carrying a
 * tool_result is the tool loop, not a turn boundary — counting those as Stops would
 * flush after every single tool call and turn the whole corpus into 1-entry episodes.
 */
function eventsFromTranscript(path) {
  let lines = [];
  try {
    lines = readFileSync(path, 'utf8').split('\n');
  } catch {
    return [];
  }
  const out = [];
  const pending = new Map(); // tool_use_id -> {tool, input, ts}
  let cwd = null;
  let session = null;
  let lastTs = null;
  let sawTurnContent = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof ev?.cwd === 'string') cwd = ev.cwd;
    if (typeof ev?.sessionId === 'string') session = ev.sessionId;
    const ts = ev?.timestamp ? Date.parse(ev.timestamp) : null;
    if (Number.isFinite(ts)) lastTs = ts;
    const content = ev?.message?.content;
    // Turn boundary: a human user message. `isMeta` records and tool_result carriers
    // are not turns.
    if (ev?.type === 'user' && !ev?.isMeta) {
      const isToolLoop = Array.isArray(content) && content.some((p) => p?.type === 'tool_result');
      if (!isToolLoop && sawTurnContent && Number.isFinite(lastTs)) {
        out.push({ kind: 'stop', ts: lastTs, session, cwd });
        sawTurnContent = false;
      }
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'tool_use' && typeof part?.name === 'string') {
        pending.set(part.id, { tool: part.name, input: part.input || {}, ts: lastTs });
      } else if (part?.type === 'tool_result' && pending.has(part.tool_use_id)) {
        const call = pending.get(part.tool_use_id);
        pending.delete(part.tool_use_id);
        const response = textOf(part.content);
        const ts = Number.isFinite(lastTs) ? lastTs : call.ts;
        if (!Number.isFinite(ts)) continue;
        sawTurnContent = true;
        if (call.tool === 'Read') {
          // post-tool-use.sh appends on the PostToolUse fast path only. A Read the host
          // marked failed goes to PostToolUseFailure, which is registered for Bash
          // alone — so a failed Read appends nothing.
          if (part.is_error === true) continue;
          const p = call.input?.file_path;
          if (typeof p === 'string' && p) out.push({ kind: 'read', ts, path: p, cwd, session });
          continue;
        }
        if (isSkipped(call.tool)) continue;
        // handlePostToolUse's own floor: `!resp || resp.length < 10`.
        if (response.length < 10) continue;
        out.push({
          kind: 'tool',
          ts,
          session,
          cwd,
          tool: call.tool,
          input: call.input,
          response,
        });
      }
    }
  }
  if (sawTurnContent && Number.isFinite(lastTs)) out.push({ kind: 'stop', ts: lastTs, session, cwd });
  return out;
}

/** Every event in the corpus, bucketed by the project name the hooks would compute. */
export function collectEvents({ since = null, projectFilter = null } = {}) {
  const byProject = new Map();
  let files = 0;
  for (const dir of transcriptDirs()) {
    let entries = [];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of entries) {
      files++;
      for (const ev of eventsFromTranscript(join(dir, f))) {
        if (!ev.cwd) continue;
        if (since && ev.ts < since) continue;
        const project = projectNameFromDir(ev.cwd);
        if (projectFilter && project !== projectFilter) continue;
        if (!byProject.has(project)) byProject.set(project, []);
        byProject.get(project).push(ev);
      }
    }
  }
  for (const list of byProject.values()) list.sort((a, b) => a.ts - b.ts);
  return { byProject, files };
}

// ─── 2. Replay the shipped batcher ───────────────────────────────────────────

/**
 * Replay one project's event stream through the real episode batching and record one
 * row per flush. `forceSignificance` is check 1's lever: null = ask the shipped
 * predicate, true/false = pin it.
 *
 * @param {object[]} events chronological, one project
 * @param {string} project
 * @param {null|boolean} forceSignificance
 * @returns {{flushes: object[], readsSeen: number}}
 */
export function replayProject(events, project, { forceSignificance = null } = {}) {
  const flushes = [];
  // path -> first ts it was appended at, so the counterfactual can price staleness.
  let readsPending = new Map();
  // The counterfactual arm's pending set. Simulated in the SAME pass rather than
  // reconstructed afterwards, because both fixes on the table (a: consume only when
  // significant, b: carry forward) change WHO the reads attach to and nothing else —
  // same episodes, same flush instants, so one walk can carry both arms honestly.
  let cfPending = new Map();
  let episode = null;
  let readsSeen = 0;

  /**
   * Does this sub-episode's immediate observation actually reach the DB, and with how
   * many reads on it? Both gates are the SHIPPED ones; the two DB-dependent dedup tiers
   * (5-min Jaccard, 7-day MinHash) are NOT modelled, so `lands` is an upper bound and
   * is labelled as such in the report.
   */
  const landing = (sub, filesRead) => {
    const obs = buildImmediateObservation({ ...sub, filesRead });
    const lands = !isNoiseObservation(obs) && !isLowYieldChangeObs(obs);
    return { lands, reads: obs.filesRead.length };
  };

  const doFlush = (ts, reason) => {
    // No buffered episode → no flush at all: handleStop and handleSessionStart both
    // guard on `readEpisode()` being non-null, so the reads file is never touched.
    // Consuming here would invent losses production does not have.
    if (!episode) return;
    // flushEpisodeWithDb consumes the reads file BEFORE it knows anything about
    // significance — that ordering IS the defect, so the replay must keep it.
    const consumed = readsPending;
    readsPending = new Map();
    for (const [k, v] of consumed) if (!cfPending.has(k)) cfPending.set(k, v);
    episode.filesRead = [...consumed.keys()];
    const subs = planEpisodeFlush(episode);
    const significant =
      forceSignificance === null ? subs.some((s) => explainSignificance(s).significant) : forceSignificance;
    const ages = [...consumed.values()].map((t) => ts - t);

    // Landing arms. Only a significant flush saves anything at all.
    let lands = false,
      landedReads = 0,
      landsCf = false,
      landedReadsCf = 0;
    let cfAgeMs = 0;
    // Distinct paths the counterfactual hands to THIS flush. Production collects with
    // `[...new Set(...)]`, so a path read once in each of two carried-over windows is
    // delivered ONCE — summing per-flush `readsConsumed` across a streak counts it twice.
    // The first draft did exactly that and published a delivery multiple 2.9% too high;
    // both pre-tag reviewers found it independently. The union has always been sitting in
    // `cfPending`; the headline just was not reading it.
    let cfDelivered = 0;
    if (significant) {
      const cfPaths = [...cfPending.keys()];
      cfDelivered = cfPending.size;
      cfAgeMs = cfPending.size ? ts - Math.min(...cfPending.values()) : 0;
      for (const sub of subs) {
        const now = landing(sub, episode.filesRead);
        if (now.lands) {
          lands = true;
          landedReads = Math.max(landedReads, now.reads);
        }
        const cf = landing(sub, cfPaths);
        if (cf.lands) {
          landsCf = true;
          landedReadsCf = Math.max(landedReadsCf, cf.reads);
        }
      }
      cfPending = new Map();
    }

    flushes.push({
      ts,
      reason,
      project,
      significant,
      entries: episode.entries.length,
      subs: subs.length,
      readsConsumed: consumed.size,
      maxReadAgeMs: ages.length ? Math.max(...ages) : 0,
      lands,
      landedReads,
      landsCf,
      landedReadsCf,
      cfAgeMs,
      cfDelivered,
    });
    episode = null;
  };

  for (const ev of events) {
    if (ev.kind === 'read') {
      readsSeen++;
      if (!readsPending.has(ev.path)) readsPending.set(ev.path, ev.ts);
      continue;
    }
    if (ev.kind === 'stop') {
      doFlush(ev.ts, 'stop');
      continue;
    }

    const files = extractFilePaths(ev.input || {});
    if (episode) {
      const timeGap = ev.ts - episode.lastAt > EPISODE_TIME_GAP_MS;
      const bufferFull = episode.entries.length >= EPISODE_BUFFER_SIZE;
      const fileRelated = isRelatedToEpisode(episode, files);
      if (bufferFull || timeGap || (!fileRelated && episode.entries.length >= 2)) {
        doFlush(ev.ts, bufferFull ? 'buffer-full' : timeGap ? 'time-gap' : 'unrelated');
      }
    }
    if (!episode) {
      episode = createEpisode('replay', project);
      episode.startedAt = ev.ts;
    }
    const bashSig = ev.tool === 'Bash' ? detectBashSignificance(ev.input || {}, ev.response) : null;
    episode.entries.push({
      tool: ev.tool,
      // The narrative buildImmediateObservation joins, and it is load-bearing for the
      // landing gates: isNoiseObservation reads the narrative's shape (tool-output
      // passthrough / `Error:` prefix) and its length. Entries without `desc` would
      // make every episode look like an empty narrative and over-report drops.
      desc: makeEntryDesc(ev.tool, ev.input || {}, ev.response, bashSig),
      files,
      ts: ev.ts,
      isError: bashSig?.isError || false,
      isHardError: bashSig?.isHardError || false,
      bashSig: bashSig || null,
      ccSession: ev.session || null,
    });
    episode.lastAt = ev.ts;
    for (const f of files) if (!episode.files.includes(f)) episode.files.push(f);
  }
  // The trailing buffer is flushed by the next session's SessionStart, which is a real
  // flush with real consumption — not counting it would drop the tail of every project.
  if (episode) doFlush(episode.lastAt, 'trailing');
  return { flushes, readsSeen };
}

// ─── 3. Accounting ───────────────────────────────────────────────────────────

export function aggregate(flushes) {
  const t = {
    flushes: flushes.length,
    insignificant: 0,
    readsConsumed: 0,
    readsDestroyed: 0,
    readsDelivered: 0,
    flushesWithReads: 0,
    significantWithZeroReads: 0,
    significant: 0,
    // Observation level — the one that decides whether the fix is worth a default change.
    landed: 0,
    landedWithReads: 0,
    landedCf: 0,
    landedWithReadsCf: 0,
  };
  for (const f of flushes) {
    if (f.significant) t.significant++;
    else t.insignificant++;
    t.readsConsumed += f.readsConsumed;
    if (f.readsConsumed > 0) t.flushesWithReads++;
    if (f.significant) {
      t.readsDelivered += f.readsConsumed;
      if (f.readsConsumed === 0) t.significantWithZeroReads++;
      if (f.lands) {
        t.landed++;
        if (f.landedReads > 0) t.landedWithReads++;
      }
      if (f.landsCf) {
        t.landedCf++;
        if (f.landedReadsCf > 0) t.landedWithReadsCf++;
      }
    } else {
      t.readsDestroyed += f.readsConsumed;
    }
  }
  t.destroyedShare = t.readsConsumed ? t.readsDestroyed / t.readsConsumed : 0;
  t.insignificantShare = t.flushes ? t.insignificant / t.flushes : 0;
  return t;
}

/**
 * The counterfactual: insignificant flushes do NOT consume the reads file, so the
 * pending set survives to the next flush. Replaying the accounting rather than the
 * batcher is exact here — the fix changes only WHO the reads attach to, never which
 * episodes exist or when they flush (both fixes leave the buffer logic alone).
 */
export function carryForward(flushesByProject) {
  let delivered = 0;
  let deliveredFlushes = 0;
  let stillZero = 0;
  const carriedAges = [];
  // Per project, because `reads-<project>.txt` is per project: carrying one project's
  // reads across another project's flush would be a fiction. An early draft summed over
  // the global flush list and inflated the carried ages by exactly that mixing.
  for (const flushes of flushesByProject) {
    let pending = 0;
    for (const f of flushes) {
      pending += f.readsConsumed;
      if (!f.significant) continue;
      if (pending > 0) {
        // `f.cfDelivered` is the DISTINCT count the replay's own counterfactual pending set
        // holds at this flush — the quantity production would write into `files_read`.
        // `pending` is the occurrence count and is kept only to decide whether anything is
        // owed, because a path read twice across two windows is still one delivery.
        delivered += f.cfDelivered;
        deliveredFlushes++;
        // Age of the oldest carried read at the instant it finally attaches, taken from
        // the replay's own counterfactual pending set rather than recomputed here — one
        // definition, so the two cannot drift.
        carriedAges.push(f.cfAgeMs);
      } else {
        stillZero++;
      }
      pending = 0;
    }
  }
  carriedAges.sort((a, b) => a - b);
  return {
    delivered,
    deliveredFlushes,
    stillZero,
    medianCarriedAgeMs: carriedAges.length ? carriedAges[Math.floor(carriedAges.length / 2)] : 0,
    p90CarriedAgeMs: carriedAges.length ? carriedAges[Math.floor(carriedAges.length * 0.9)] : 0,
  };
}

// ─── 4. Self-checks ──────────────────────────────────────────────────────────

/** Check 1: the headline must be able to reach both ends. */
export function assertRulerCanSayNo(byProject) {
  const run = (force) => {
    const all = [];
    for (const [project, events] of byProject) {
      all.push(...replayProject(events, project, { forceSignificance: force }).flushes);
    }
    return aggregate(all);
  };
  const allSig = run(true);
  const noneSig = run(false);
  const problems = [];
  if (allSig.readsConsumed > 0 && allSig.destroyedShare !== 0) {
    problems.push(`forced-significant destroyed ${allSig.readsDestroyed} reads (must be 0)`);
  }
  if (noneSig.readsConsumed > 0 && noneSig.destroyedShare !== 1) {
    problems.push(`forced-insignificant delivered ${noneSig.readsDelivered} reads (must be 0)`);
  }
  if (allSig.readsConsumed === 0) problems.push('no reads in corpus — the headline is vacuous');
  return { problems, allSig, noneSig };
}

/**
 * Check 2: the live `episode_significance` meter measures the same share this replay
 * models.
 *
 * The window is the days THE METER covers — the replay side is filtered to them, the meter
 * side is not. A meter day the replay has no flushes for therefore still counts on the
 * meter side and widens the gap; that is the conservative direction (it can only make the
 * check fire, never silence it), but the docblock said "days both cover" and that was
 * wrong. Both sides currently span the same three days.
 *
 * Returns null when the sink holds no `episode_significance` rows AT ALL, which the caller
 * renders as SKIP. That is a real state on a machine that never set CLAUDE_MEM_METRICS=1 —
 * but it means the check has no teeth there, so the SKIP line says so rather than reading
 * like a pass.
 */
export function meterAgreement(flushes, { dataDir } = {}) {
  const dir = join(dataDir || resolveDataDir(), 'metrics');
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  const byDay = new Map();
  for (const f of files) {
    let lines = [];
    try {
      lines = readFileSync(join(dir, f), 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.includes('episode_significance')) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.event !== 'episode_significance') continue;
      const day = String(row.ts).slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, { n: 0, insig: 0 });
      const d = byDay.get(day);
      d.n++;
      if (!row.significant) d.insig++;
    }
  }
  if (byDay.size === 0) return null;
  const days = new Set(byDay.keys());
  let meterN = 0,
    meterInsig = 0,
    replayN = 0,
    replayInsig = 0;
  for (const day of days) {
    const d = byDay.get(day);
    meterN += d.n;
    meterInsig += d.insig;
  }
  for (const f of flushes) {
    const day = new Date(f.ts).toISOString().slice(0, 10);
    if (!days.has(day)) continue;
    replayN++;
    if (!f.significant) replayInsig++;
  }
  if (replayN === 0) return { days: [...days].sort(), meterN, replayN, agree: false, gapPp: null };
  const meterShare = meterInsig / meterN;
  const replayShare = replayInsig / replayN;
  const gapPp = Math.abs(meterShare - replayShare) * 100;
  return {
    days: [...days].sort(),
    meterN,
    replayN,
    meterShare,
    replayShare,
    gapPp,
    agree: gapPp <= MODEL_TOLERANCE_PP,
  };
}

// ─── 5. Report ───────────────────────────────────────────────────────────────

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const mins = (ms) => `${(ms / 60000).toFixed(1)}m`;

function main() {
  const sinceRaw = argOf('--since');
  const since = sinceRaw ? Date.parse(sinceRaw) : null;
  if (sinceRaw && !Number.isFinite(since)) {
    console.error(`--since: not an ISO date: ${sinceRaw}`);
    process.exit(2);
  }
  const projectFilter = argOf('--project');
  const { byProject, files } = collectEvents({ since, projectFilter });

  const allFlushes = [];
  const flushesByProject = [];
  const perProject = [];
  let readsSeen = 0;
  const emptyProjects = [];
  for (const [project, events] of byProject) {
    const r = replayProject(events, project);
    readsSeen += r.readsSeen;
    allFlushes.push(...r.flushes);
    flushesByProject.push(r.flushes);
    if (r.flushes.length === 0 && events.some((e) => e.kind === 'tool')) emptyProjects.push(project);
    perProject.push({ project, ...aggregate(r.flushes) });
  }
  const total = aggregate(allFlushes);
  const cf = carryForward(flushesByProject);
  const canSayNo = assertRulerCanSayNo(byProject);
  const meter = meterAgreement(allFlushes);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ total, carryForward: cf, perProject, meter, files }, null, 2));
  } else {
    console.error(
      `\n─── Episode-flush replay (${files} transcripts, ${byProject.size} projects${sinceRaw ? `, since ${sinceRaw}` : ''}) ───`,
    );
    console.error(
      `  flushes            ${total.flushes}  (insignificant ${total.insignificant} = ${pct(total.insignificantShare)})`,
    );
    console.error(`  Read paths seen    ${readsSeen}  → ${total.readsConsumed} distinct consumed by a flush`);
    console.error(
      `  DESTROYED          ${total.readsDestroyed}  = ${pct(total.destroyedShare)} of consumed reads (insignificant flush ate them)`,
    );
    console.error(
      `  delivered today    ${total.readsDelivered}  to ${total.significant} significant flushes`,
    );
    console.error(
      `  significant flushes with files_read = []: ${total.significantWithZeroReads}/${total.significant} = ${pct(total.significant ? total.significantWithZeroReads / total.significant : 0)}`,
    );
    console.error(`\n─── Counterfactual: insignificant flush does NOT consume (D#178 fix a/b) ───`);
    console.error(
      `  reads delivered    ${total.readsDelivered} → ${cf.delivered}  (×${total.readsDelivered ? (cf.delivered / total.readsDelivered).toFixed(2) : '∞'})`,
    );
    console.error(`  significant flushes still empty: ${cf.stillZero}/${total.significant}`);
    // Per DELIVERY, and of the OLDEST read in each — so this overstates the typical read's
    // staleness and understates nothing. Quoting it as "the median read waits N" would be
    // the wrong unit.
    console.error(
      `  age of the oldest carried read, per delivering flush: median ${mins(cf.medianCarriedAgeMs)}, p90 ${mins(cf.p90CarriedAgeMs)}`,
    );
    console.error(
      `\n─── Observation level (past the two write-side noise gates; DB dedup NOT modelled, so these are upper bounds) ───`,
    );
    console.error(`  observations landed          ${total.landed}  (now)   ${total.landedCf}  (fixed)`);
    console.error(
      `  …of them carrying ≥1 read    ${total.landedWithReads} = ${pct(total.landed ? total.landedWithReads / total.landed : 0)}   →   ${total.landedWithReadsCf} = ${pct(total.landedCf ? total.landedWithReadsCf / total.landedCf : 0)}`,
    );
    console.error(`\n─── Self-checks ───`);
    console.error(
      `  1 can-say-no      ${canSayNo.problems.length === 0 ? 'PASS' : 'FAIL — ' + canSayNo.problems.join('; ')}`,
    );
    if (meter) {
      console.error(
        `  2 meter agreement ${meter.agree ? 'PASS' : 'FAIL'} — live episode_significance ${pct(meter.meterShare ?? 0)} insignificant (n=${meter.meterN}) vs replay ${pct(meter.replayShare ?? 0)} (n=${meter.replayN}) over ${meter.days.length} metered day(s), gap ${meter.gapPp === null ? 'n/a' : meter.gapPp.toFixed(1) + 'pp'} (tolerance ${MODEL_TOLERANCE_PP}pp)`,
      );
    } else {
      console.error(`  2 meter agreement SKIP — no episode_significance rows in the metrics sink, so the`);
      console.error(`                          flush MODEL is unchecked here. Set CLAUDE_MEM_METRICS=1 and`);
      console.error(`                          re-run after some real sessions to give this check teeth.`);
    }
    console.error(
      `  3 reachability    ${emptyProjects.length === 0 ? 'PASS' : 'FAIL — projects with events but zero flushes: ' + emptyProjects.join(', ')}`,
    );
    console.error('\n  Top projects by reads destroyed:');
    for (const p of perProject.sort((a, b) => b.readsDestroyed - a.readsDestroyed).slice(0, 8)) {
      console.error(
        `    ${p.project.padEnd(32)} destroyed ${String(p.readsDestroyed).padStart(5)} / ${String(p.readsConsumed).padStart(5)} = ${pct(p.destroyedShare)}   flushes ${p.flushes}`,
      );
    }
    console.error('');
  }

  const failed = canSayNo.problems.length > 0 || (meter && !meter.agree) || emptyProjects.length > 0;
  if (failed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('episode-flush-replay.mjs')) main();
