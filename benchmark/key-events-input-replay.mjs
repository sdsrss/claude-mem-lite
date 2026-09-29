#!/usr/bin/env node
/**
 * KEY-EVENTS INPUT REPLAY — the ruler for D#69's summarizer-input filters.
 *
 * THE QUESTION. The llm-episode worker writes `events` rows (title + lesson) from windows
 * of tool calls. A 30-row audit (docs/audits/20260925-200912-session-history-analysis.md
 * §4.4.1, seed 20260925) read 2 ACCURATE / 11 PARTLY / 16 WRONG / 1 GENERIC. D#69 filters
 * the window (subagent calls, mutation probes, the agent's own tool slips) and drops an
 * event lesson that does not quote the window's diagnosis. What would those gates have
 * done to the windows that produced the historical events?
 *
 * NO LLM. The replay rebuilds each historical window from the transcripts through the
 * SHIPPED batcher (isRelatedToEpisode / EPISODE_BUFFER_SIZE / EPISODE_TIME_GAP_MS /
 * planEpisodeFlush / explainSignificance) and the SHIPPED gates (entryInputTags,
 * filterSummaryInput, extractDiagnosisLines, isLessonGrounded) — imported, never copied.
 * It then matches each `events` row to the window that produced it (same file set, row
 * created 0-600 s after the flush) and reports the row's fate under the new gates:
 *   no-event:subagent-only   every call in the window came from a subagent
 *   no-event:<gate>          what is left is no longer significant → nothing is saved
 *   demoted:no-diagnosis     saved, but the window has no diagnosis line to quote
 *   demoted:ungrounded       saved; the STORED lesson quotes none of the diagnosis lines
 *   kept:grounded            the stored lesson already shares a 4-word run with one
 *
 * READ THE LAST TWO COLUMNS FOR WHAT THEY ARE. The stored lessons were written by a
 * prompt that never asked for a quote, so "ungrounded" here says the OLD lesson would be
 * dropped, not that the NEW prompt's lesson will be. It is a statement about the check's
 * reach on historical text; the new pipeline's accuracy needs the post-deploy relabel
 * (see the report procedure in D#69).
 *
 *   node benchmark/key-events-input-replay.mjs --transcripts ~/.claude/projects/<dir> \
 *        --db <copy of claude-mem-lite.db> --project dev--claude-mem-lite \
 *        [--labels docs/audits/20260925-200912-session-history-analysis.md] \
 *        [--sample 30 --seed 20260926] [--names probe|slip|subagent] [--json]
 *
 * SELF-CHECKS (exit 1 on failure):
 *   1. can-say-no — with every gate forced off the replay must report 0 dropped entries
 *      and 0 filtered events; with them on, the filtered count must be > 0 on a corpus that
 *      has subagent transcripts. A ruler that reads the same number in both arms is blind.
 *   2. reachability — at least 80% of events must match a replayed window; a lower rate
 *      means the window rebuild drifted from the hook, and every fate below is suspect.
 *
 * KNOWN MODEL GAPS, stated rather than absorbed: (a) the historical windows are the OLD
 * batching — with subagent calls kept out of the buffer, main-thread windows re-form
 * slightly differently, which this replay approximates by deleting those calls from the
 * old window; (b) host-flagged failures are excluded (PostToolUseFailure never fed the
 * buffer), matching production; (c) the transcript does not record `agent_id`, so a call
 * is "subagent" when it comes from `<session>/subagents/*.jsonl`; (d) this replay drops
 * EVERY subagent call, while the shipped hook (ea8b61d) keeps a subagent call that edits a
 * file inside the project — so its subagent counts are an upper bound on what ships.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SKIP_TOOLS, SKIP_PREFIXES } from '../skip-tools.mjs';
import { isRelatedToEpisode, makeEntryDesc } from '../utils.mjs';
import { extractFileTargets, detectBashSignificance } from '../bash-utils.mjs';
import { toolEditPath } from '../lib/file-edge-match.mjs';
import { createEpisode, planEpisodeFlush, explainSignificance } from '../hook-episode.mjs';
import { EPISODE_BUFFER_SIZE, EPISODE_TIME_GAP_MS } from '../hook-shared.mjs';
import {
  entryInputTags,
  extractDiagnosisLines,
  filterSummaryInput,
  isLessonGrounded,
} from '../lib/episode-input-filter.mjs';

const argv = process.argv.slice(2);
const argOf = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};

const textOf = (c) =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
      : '';
const skipped = (t) => SKIP_TOOLS.has(t) || SKIP_PREFIXES.some((p) => t.startsWith(p));

/**
 * The file extractor the STORED rows were written with — bash-utils.mjs before 5081d35
 * (2026-09-26), verbatim in behaviour. Deliberately a copy: the windows being rebuilt
 * are historical, their batching (isRelatedToEpisode) and the `file_paths` this ruler
 * matches events on were both computed by this rule, and the shipped extractor now
 * resolves relative and quoted Bash paths, so it would rebuild windows that never
 * existed. The NEW pipeline's view (bashWrites → significance, heredoc diagnosis) uses
 * the shipped extractFileTargets below.
 */
function legacyFilePaths(input) {
  const paths = [];
  const edited = toolEditPath(input);
  if (edited) paths.push(edited);
  if (input.path) paths.push(input.path);
  if (input.filePath) paths.push(input.filePath);
  if (typeof input.command === 'string') {
    for (const m of input.command.match(/(?:^|\s)(\/[\w./-]+\w)/g) || []) {
      const p = m.trim();
      const excluded = p.startsWith('/dev/') || p.startsWith('/proc/') || p.startsWith('/tmp/');
      if (!excluded && (p.indexOf('/', 1) !== -1 || /\.\w+$/.test(p))) paths.push(p);
    }
  }
  return [...new Set(paths)];
}

/** Tool calls (and, for the main thread, Stop points) from one transcript file. */
function parseTranscript(path, agentId) {
  let lines = [];
  try {
    lines = readFileSync(path, 'utf8').split('\n');
  } catch {
    return [];
  }
  const out = [];
  const pending = new Map();
  let session = null;
  let cwd = null;
  let lastTs = null;
  let saw = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof ev?.sessionId === 'string') session = ev.sessionId;
    if (typeof ev?.cwd === 'string') cwd = ev.cwd;
    const ts = ev?.timestamp ? Date.parse(ev.timestamp) : null;
    if (Number.isFinite(ts)) lastTs = ts;
    const content = ev?.message?.content;
    // Stop fires on the MAIN thread when a turn ends: just before the next human message.
    if (!agentId && ev?.type === 'user' && !ev?.isMeta) {
      const loop = Array.isArray(content) && content.some((p) => p?.type === 'tool_result');
      if (!loop && saw && Number.isFinite(lastTs)) {
        out.push({ kind: 'stop', ts: lastTs, session });
        saw = false;
      }
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'tool_use' && typeof part?.name === 'string') {
        pending.set(part.id, { tool: part.name, input: part.input || {}, ts: lastTs });
      } else if (part?.type === 'tool_result' && pending.has(part.tool_use_id)) {
        const call = pending.get(part.tool_use_id);
        pending.delete(part.tool_use_id);
        saw = true;
        // PostToolUseFailure never fed the buffer; Read and the skip list never reach Node.
        if (part.is_error === true || call.tool === 'Read' || skipped(call.tool)) continue;
        const response = textOf(part.content);
        if (response.length < 10) continue;
        const t = Number.isFinite(lastTs) ? lastTs : call.ts;
        if (!Number.isFinite(t)) continue;
        out.push({
          kind: 'tool',
          ts: t,
          session,
          cwd,
          agentId,
          tool: call.tool,
          input: call.input,
          response,
        });
      }
    }
  }
  if (!agentId && saw && Number.isFinite(lastTs)) out.push({ kind: 'stop', ts: lastTs, session });
  return out;
}

export function collectStream(dir) {
  const all = [];
  let subagentFiles = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    all.push(...parseTranscript(join(dir, f), null));
    const sub = join(dir, f.replace(/\.jsonl$/, ''), 'subagents');
    if (!existsSync(sub)) continue;
    for (const s of readdirSync(sub)) {
      if (!s.endsWith('.jsonl')) continue;
      subagentFiles++;
      all.push(...parseTranscript(join(sub, s), s.replace(/\.jsonl$/, '')));
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  return { stream: all, subagentFiles };
}

/** The OLD windows (subagent calls included), one record per significant sub-episode. */
export function replayWindows(stream, project) {
  const windows = [];
  let episode = null;
  const flush = (ts) => {
    if (!episode) return;
    for (const sub of planEpisodeFlush(episode)) {
      if (explainSignificance(sub).significant) windows.push({ ts, entries: sub.entries, files: sub.files });
    }
    episode = null;
  };
  for (const ev of stream) {
    if (ev.kind === 'stop') {
      flush(ev.ts);
      continue;
    }
    const files = legacyFilePaths(ev.input || {});
    if (episode) {
      const gap = ev.ts - episode.lastAt > EPISODE_TIME_GAP_MS;
      const full = episode.entries.length >= EPISODE_BUFFER_SIZE;
      if (full || gap || (!isRelatedToEpisode(episode, files) && episode.entries.length >= 2)) flush(ev.ts);
    }
    if (!episode) episode = createEpisode('replay', project);
    const bashSig = ev.tool === 'Bash' ? detectBashSignificance(ev.input || {}, ev.response) : null;
    // What the CURRENT hook would record for this call (hook.mjs handlePostToolUse).
    const bashWrites =
      ev.tool === 'Bash' ? extractFileTargets(ev.input || {}, { cwd: ev.cwd || null }).writes : [];
    episode.entries.push({
      tool: ev.tool,
      desc: makeEntryDesc(ev.tool, ev.input || {}, ev.response, bashSig),
      files,
      ts: ev.ts,
      isError: bashSig?.isError || false,
      bashSig,
      ccSession: ev.session,
      agentId: ev.agentId,
      inputTags: entryInputTags(ev.tool, ev.input || {}, ev.response),
      ...(bashWrites.length ? { bashWrites } : {}),
      diag: extractDiagnosisLines(ev.tool, ev.input || {}, ev.response, {
        isError: bashSig?.isError || false,
        writesFiles: bashWrites.length > 0,
      }),
      command: ev.tool === 'Bash' ? String(ev.input?.command || '') : '',
    });
    episode.lastAt = ev.ts;
    for (const f of files) if (!episode.files.includes(f)) episode.files.push(f);
  }
  flush(episode?.lastAt);
  return windows;
}

/** What the NEW pipeline does with one old window, and with the lesson stored from it. */
export function fateOf(window, lesson, { gates = true, projectDir = null } = {}) {
  const main = gates ? window.entries.filter((e) => !e.agentId) : window.entries;
  if (main.length === 0) return { fate: 'no-event:subagent-only', dropped: { probe: 0, slip: 0 } };
  const ep = { entries: main, files: [...new Set(main.flatMap((e) => e.files))] };
  if (!explainSignificance(ep).significant)
    return { fate: 'no-event:subagent', dropped: { probe: 0, slip: 0 } };
  if (!gates) return { fate: 'kept:ungated', dropped: { probe: 0, slip: 0 } };
  const { episode, dropped } = filterSummaryInput(ep, { projectDir });
  if (!explainSignificance(episode).significant) {
    return { fate: `no-event:${dropped.probe ? 'probe' : 'slip'}`, dropped };
  }
  const diag = episode.entries.flatMap((e) => e.diag);
  if (diag.length === 0) return { fate: 'demoted:no-diagnosis', dropped };
  return { fate: isLessonGrounded(lesson, diag) ? 'kept:grounded' : 'demoted:ungrounded', dropped };
}

export function matchEvents(rows, windows) {
  const key = (arr) => JSON.stringify([...(arr || [])].sort());
  const out = new Map();
  for (const r of rows) {
    const k = key(r.file_paths ? JSON.parse(r.file_paths) : []);
    let best = null;
    for (const w of windows) {
      const dt = r.created_at_epoch - w.ts;
      if (dt < -5000 || dt > 600000) continue;
      const score = (key(w.files) === k ? 0 : 1e9) + Math.abs(dt);
      if (!best || score < best.score) best = { w, score, same: score < 1e9 };
    }
    out.set(r.id, best);
  }
  return out;
}

/** mulberry32 — a seeded draw, so "the same kind of random sample" is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main() {
  const dir = argOf('--transcripts');
  const dbPath = argOf('--db');
  const project = argOf('--project');
  if (!dir || !dbPath || !project) {
    console.error(
      'usage: --transcripts <dir> --db <sqlite copy> --project <name> [--labels md] [--sample N --seed S]',
    );
    process.exit(2);
  }
  const { stream, subagentFiles } = collectStream(dir);
  // The hook passes its project dir to filterSummaryInput (only writes under it are
  // protected by the unrestored-write rule). Default: the main thread's most common cwd.
  const cwdCount = new Map();
  for (const e of stream)
    if (e.kind === 'tool' && !e.agentId && e.cwd) cwdCount.set(e.cwd, (cwdCount.get(e.cwd) || 0) + 1);
  const projectDir =
    argOf('--project-dir') || [...cwdCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const windows = replayWindows(stream, project);
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT id, event_type, title, body, file_paths, created_at_epoch FROM events
       WHERE project = ? AND superseded_at_epoch IS NULL ORDER BY id`,
    )
    .all(project);
  db.close();
  const matches = matchEvents(rows, windows);
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Reach over every significant window: dropped entries per gate, with the name set.
  const reach = {
    windows: windows.length,
    subagentOnly: 0,
    subagentEntries: 0,
    probe: 0,
    slip: 0,
    noEvent: 0,
  };
  const names = { probe: [], slip: [], subagent: [] };
  for (const w of windows) {
    const { fate, dropped } = fateOf(w, null, { projectDir });
    const subs = w.entries.filter((e) => e.agentId);
    reach.subagentEntries += subs.length;
    if (fate === 'no-event:subagent-only') reach.subagentOnly++;
    if (fate.startsWith('no-event')) reach.noEvent++;
    reach.probe += dropped.probe;
    reach.slip += dropped.slip;
    names.subagent.push(...subs.map((e) => `${e.agentId.slice(0, 40)}  ${e.desc.slice(0, 80)}`));
    for (const e of w.entries)
      if (!e.agentId) {
        if (e.inputTags.includes('slip')) names.slip.push(e.command.replace(/\s+/g, ' ').slice(0, 110));
        else if (e.inputTags.includes('probe'))
          names.probe.push(e.command.replace(/\s+/g, ' ').slice(0, 110));
      }
  }
  // Check 1: can-say-no.
  const offNoEvent = windows.filter((w) =>
    fateOf(w, null, { gates: false }).fate.startsWith('no-event'),
  ).length;

  const fates = (ids) =>
    ids.map((id) => {
      const m = matches.get(id);
      const r = byId.get(id);
      if (!r) return { id, fate: 'not-in-db' };
      if (!m) return { id, type: r.event_type, fate: 'unmatched' };
      return { id, type: r.event_type, sameFiles: m.same, ...fateOf(m.w, r.body, { projectDir }) };
    });

  const report = {
    stamp: new Date().toISOString(),
    corpus: { stream: stream.length, subagentFiles, events: rows.length, projectDir },
    reach,
    matched: [...matches.values()].filter(Boolean).length,
  };

  const labelsPath = argOf('--labels');
  if (labelsPath) {
    const doc = readFileSync(labelsPath, 'utf8');
    const labels = new Map(
      [...doc.matchAll(/^\| (\d+) \| \w+ \| (ACCURATE|PARTLY|WRONG|GENERIC) \|/gm)].map((m) => [
        Number(m[1]),
        m[2],
      ]),
    );
    const rowsL = fates([...labels.keys()]).map((f) => ({ ...f, label: labels.get(f.id) }));
    const table = {};
    for (const f of rowsL) {
      table[f.label] ??= {};
      table[f.label][f.fate] = (table[f.label][f.fate] || 0) + 1;
    }
    report.labeled = { rows: rowsL, table };
  }
  const sampleN = Number(argOf('--sample') || 0);
  if (sampleN > 0) {
    const seed = Number(argOf('--seed') || 20260926);
    const draw = rng(seed);
    const pool = rows.map((r) => r.id);
    const picked = [];
    while (picked.length < Math.min(sampleN, pool.length)) {
      const i = Math.floor(draw() * pool.length);
      picked.push(pool.splice(i, 1)[0]);
    }
    const rowsS = fates(picked.sort((a, b) => a - b));
    const table = {};
    for (const f of rowsS) table[f.fate] = (table[f.fate] || 0) + 1;
    report.sample = { seed, population: rows.length, rows: rowsS, table };
  }

  const failures = [];
  if (offNoEvent !== 0)
    failures.push(`can-say-no: gates-off arm filtered ${offNoEvent} windows (expected 0)`);
  if (subagentFiles > 0 && reach.noEvent === 0) failures.push('can-say-no: gates-on arm filtered 0 windows');
  if (rows.length && report.matched / rows.length < 0.8)
    failures.push(`reachability: ${report.matched}/${rows.length} events matched a window (< 80%)`);
  report.selfChecks = failures.length ? failures : ['PASS'];

  const which = argOf('--names');
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(JSON.stringify({ ...report, labeled: undefined, sample: undefined }, null, 2));
    if (report.labeled) {
      console.table(report.labeled.rows);
      console.log(report.labeled.table);
    }
    if (report.sample) {
      console.table(report.sample.rows);
      console.log(report.sample.table);
    }
    if (which && names[which]) for (const n of names[which]) console.log(n);
  }
  if (failures.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
