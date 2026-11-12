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
//
// WHICH REPLIES (D#825). The worker reads what Stop recorded under the session (lib/turn-replies.mjs);
// stopReplies rebuilds that from the transcript. Reading 3 (D22's gate) took the replies from a
// time window instead, and that window carried the defect the 6.33.0 reviews found in the wiring:
// on 13 of its 30 sessions it differs from the record, among them a next session's report taken
// as the final reply (tasks/d825/equiv.out).
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
//   node benchmark/summary-events-ab.mjs prepare rows.json outdir [--seed 20261111] [--batches 2]
//     (judge files in outdir/judge/, key.json in outdir; verdicts-<k>-<a|b>.json go back into outdir)
//   node benchmark/summary-events-ab.mjs score outdir

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
import { parseSummaryNotes } from '../lib/fast-summary.mjs';

// A and B are D21's arms; C is D22's (every turn's last reply). `run --arms` picks which run.
const ALL_ARMS = ['A', 'B', 'C'];
const QUESTIONS = ['missed_done', 'false_open', 'unsupported'];
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
 * session, rebuilt from its transcript. A Stop is the end of a host turn: before the next user
 * record that starts one (a typed prompt, a notice, a command record; not a tool result, a meta
 * record or a compaction summary), before a compaction, or at the end of the file. A turn the
 * host ends on an API error fires StopFailure, not Stop, and records nothing. A Stop's last
 * assistant text goes under the number of the session's prompts stored by then (0 before the
 * first), replacing an earlier one; a Stop outside [start, end) is another session's.
 * @param {object[]} entries transcript records, in file order
 * @param {{start: number, end: number, prompts: number[]}} session epoch ms; stored prompt epochs
 * @returns {string[]} in prompt order
 */
export function stopReplies(entries, { start, end, prompts }) {
  const groups = new Map();
  let last = null;
  let lastAt = null;
  const stop = () => {
    if (last !== null && lastAt >= start && lastAt < end)
      groups.set(prompts.filter((p) => p <= lastAt).length, last);
    last = null;
    lastAt = null;
  };
  for (const e of entries) {
    if (!e || typeof e !== 'object' || e.isSidechain) continue;
    if (e.type === 'assistant') {
      if (e.isApiErrorMessage) {
        last = null;
        lastAt = null;
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
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      stop();
      continue;
    }
    if (e.type !== 'user' || e.isMeta || e.isCompactSummary) continue;
    const c = e.message?.content;
    if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) continue;
    stop();
  }
  stop();
  return [...groups].sort((a, b) => a[0] - b[0]).map((g) => g[1]);
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

/** Unblind two judges' verdicts (id → {missed_done, false_open, unsupported}). */
export function scoreVerdicts(key, a, b, usableByArm) {
  const present = ALL_ARMS.filter((x) => x in usableByArm || Object.values(key).some((k) => k.arm === x));
  const arms = Object.fromEntries(
    present.map((arm) => [
      arm,
      { n: 0, judged: 0, usable: usableByArm[arm] ?? 0, ...Object.fromEntries(QUESTIONS.map((q) => [q, 0])) },
    ]),
  );
  const same = Object.fromEntries(QUESTIONS.map((q) => [q, 0]));
  let judged = 0;
  for (const [id, { arm }] of Object.entries(key)) {
    const s = arms[arm];
    s.n++;
    const va = a[id];
    const vb = b[id];
    if (!va || !vb || QUESTIONS.some((q) => !YN.includes(va[q]) || !YN.includes(vb[q]))) continue;
    s.judged++;
    judged++;
    for (const q of QUESTIONS) {
      if (va[q] === vb[q]) same[q]++;
      if (va[q] === 'YES' && vb[q] === 'YES') s[q]++;
    }
  }
  for (const s of Object.values(arms)) {
    for (const q of QUESTIONS) s[`${q}CI`] = wilson95(s[q], s.judged);
  }
  const agreement = Object.fromEntries(QUESTIONS.map((q) => [q, judged ? same[q] / judged : 0]));
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
  // The Stop record's owner bounds (stopReplies): the session's own start, up to the next memory
  // session of the same transcript (a resume, or a rotation that stored a prompt) or the first
  // compaction after it began (SessionStart rotates there, prompt or not). Another terminal's
  // session in the project does not end it.
  const startQ = db.prepare('SELECT started_at_epoch AS e FROM sdk_sessions WHERE content_session_id = ?');
  const promptEpochsQ = db.prepare(
    'SELECT created_at_epoch AS e FROM user_prompts WHERE content_session_id = ? ORDER BY created_at_epoch',
  );
  const nextInTranscriptQ = db.prepare(`SELECT MIN(k.started_at_epoch) AS e FROM sdk_sessions k
    WHERE k.started_at_epoch > ? AND k.content_session_id != ?
      AND EXISTS (SELECT 1 FROM user_prompts u WHERE u.content_session_id = k.content_session_id AND u.cc_session_id = ?)`);
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
    const entries = readEntries(transcript);
    const start = startQ.get(s.sid)?.e ?? first;
    let stopEnd = nextInTranscriptQ.get(start, s.sid, cc)?.e ?? Infinity;
    for (const e of entries) {
      if (e?.type !== 'system' || e.subtype !== 'compact_boundary') continue;
      const at = Date.parse(e.timestamp || '');
      // A session /compact opened starts 49-259 ms before its boundary (manual, 52 of 52 here).
      if (at > start + 5000 && at < stopEnd) stopEnd = at;
    }
    const replies = stopReplies(entries, {
      start,
      end: stopEnd,
      prompts: promptEpochsQ.all(s.sid).map((p) => p.e),
    });
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
  if (arms.length < 2 || arms.some((x) => !ALL_ARMS.includes(x)) || new Set(arms).size !== arms.length)
    throw new Error(`--arms takes two or more of ${ALL_ARMS.join(',')}`);
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
      const picked = pickEvenly(pop.items, n);
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
        for (const arm of i % 2 === 0 ? arms : [...arms].reverse()) {
          const prompt = buildSessionSummaryPrompt({
            project: s.project,
            observations: arm === 'B' ? mergeSummaryRows(s.observations, s.events) : s.observations,
            userPrompts: s.userPrompts,
            finalReply: s.replies.at(-1),
            ...(arm === 'C' ? { turnReplies: s.replies } : {}),
          });
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
        n: picked.length,
        arms,
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
export function splitBothYes(key, a, b, items) {
  const out = {};
  for (const [id, { arm, item }] of Object.entries(key)) {
    const meta = items[item] ?? {};
    const groups = [meta.turns > 1 ? 'multi' : 'single', `provenance:${meta.provenance ?? 'unknown'}`];
    for (const g of groups) {
      const cell = ((out[g] ??= {})[arm] ??= { n: 0, ...Object.fromEntries(QUESTIONS.map((q) => [q, 0])) });
      cell.n++;
      for (const q of QUESTIONS) if (a[id]?.[q] === 'YES' && b[id]?.[q] === 'YES') cell[q]++;
    }
  }
  return out;
}

/** Blind the rows: judge-facing batches in two orders each, and the key. */
export function buildBlind(dump, { seed = 20261111, batches = 2 } = {}) {
  const ids = seededShuffle(
    Array.from({ length: dump.rows.length }, (_, i) => `e${String(i + 1).padStart(3, '0')}`),
    seed,
  );
  const key = {};
  const entries = dump.rows.map((r, i) => {
    key[ids[i]] = { arm: r.arm, item: r.item };
    return {
      id: ids[i],
      replies: dump.items[r.item].replies,
      summary: { completed: r.completed, remaining_items: r.remaining_items, next_steps: r.next_steps },
    };
  });
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
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  const { batches, key } = buildBlind(dump, {
    seed: Number(arg('--seed', '20261111')),
    batches: Number(arg('--batches', '2')),
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
    JSON.stringify({ key, usable, n: dump.items.length, items, meta: dump.meta }, null, 2),
  );
  console.log(`${Object.keys(key).length} items in ${batches.length} batches → ${outdir}`);
}

function score() {
  const outdir = process.argv[3];
  if (!outdir) throw new Error('score <outdir>');
  const { key, usable, n, items } = JSON.parse(readFileSync(join(outdir, 'key.json'), 'utf8'));
  const merged = { a: {}, b: {} };
  for (const f of readdirSync(outdir)) {
    const m = /^verdicts-\d+-(a|b)\.json$/.exec(f);
    if (m) Object.assign(merged[m[1]], JSON.parse(readFileSync(join(outdir, f), 'utf8')));
  }
  const result = scoreVerdicts(key, merged.a, merged.b, usable);
  // D22 is registered as the D21 gate with arm C in B's place (tasks/specs/d22-summary-turn-replies.md).
  const gate = result.arms.C
    ? { gateD22: gateD21({ A: result.arms.A, B: result.arms.C, agreement: result.agreement, n }) }
    : { gateD21: gateD21({ ...result.arms, agreement: result.agreement, n }) };
  const split = items ? splitBothYes(key, merged.a, merged.b, items) : undefined;
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
