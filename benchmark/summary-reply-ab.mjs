#!/usr/bin/env node
// Session summary A/B: does the summary model, shown the session's final reply, stop writing work
// the reply reports as done into remaining_items / next_steps (D19)? Built 2026-11-11.
//
// WHY THIS EXISTS. haiku-model-ab.mjs samples three haiku-tier sites and the session summary is
// not one of them, so a reading from it would be a reading from the wrong ruler (doctrine rule 9).
//
// ARMS, both through the shipped prompt builder, callLLM and parseJsonFromLLM:
//   A  buildSessionSummaryPrompt without the final reply — the prompt shipped before D19.
//   B  the same with `finalReply`: the reply's head + tail in the user part, one rule in the system.
// Each session runs both arms back to back, arm order alternating by item (doctrine rule 2).
// The leg is the CLI one default users run (`claude -p --model haiku`, isolated by the shipped
// flags); the report records `claude --version`.
//
// POPULATION. Sessions in the store whose summary row is newer than --days, whose worker would
// run (at least one observation past the low-signal filter, the worker's own query), whose
// transcript is still on disk (user_prompts.cc_session_id under ~/.claude/projects/*/) and whose
// final reply is non-empty; --n of them evenly spaced in time. Inputs are rebuilt from the store
// as it is NOW, so rows compressed or deleted since differ from what the worker saw — the same
// for both arms. The store is opened read-only and CLAUDE_MEM_DIR points at a private temp dir
// for the run, so nothing is written to the real one (doctrine rule 6).
//
// JUDGING is blind, by two independent judges (`prepare` → judges → `score`). A judge sees the
// whole final reply (scrubbed, uncut) and the model's completed / remaining_items / next_steps,
// and answers per item:
//   false_open   do remaining_items or next_steps present as not done work the reply reports done?
//   missed_open  does the reply list unfinished items that neither field mentions?
// The gate is the pre-registered one in tasks/specs/converge-r31-decisions.md (gateD19 below).
//
// WHAT IT CANNOT SEE. The fields judged are the model's raw output: the shipped merge keeps a
// parsed report's Done / Not done over them, which this does not model. Judges read the reply,
// not the repository: "done" means the reply says so. Same-family judges.
//
// Usage:
//   node benchmark/summary-reply-ab.mjs run --out rows.json [--n 30] [--days 45] [--db path]
//   node benchmark/summary-reply-ab.mjs prepare rows.json outdir [--seed 20261111] [--batches 2]
//   node benchmark/summary-reply-ab.mjs score outdir

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickEvenly, enterArm, CLI_ARM } from './haiku-model-ab.mjs';
import { seededShuffle } from './lesson-blind-read.mjs';
import { wilson95 } from './wilson.mjs';

const ARMS = ['A', 'B'];
const FO = ['YES', 'NO'];
const MO = ['YES', 'NO', 'NONE_STATED'];

/** The worker's text coercion for a prose field (hook-llm.mjs handleLLMSummary `asText`). */
export function asText(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).join('; ');
  return typeof v === 'string' ? v : '';
}

/** The worker's write gate (handleLLMSummary `hasSummaryContent`). */
export function summaryUsable(p) {
  if (!p || typeof p !== 'object') return false;
  const items = (v) => Array.isArray(v) && v.some((x) => typeof x === 'string' && x.trim());
  return Boolean(
    asText(p.request) ||
    asText(p.completed) ||
    asText(p.remaining_items) ||
    asText(p.next_steps) ||
    items(p.lessons) ||
    items(p.key_decisions),
  );
}

/**
 * The pre-registered gate (tasks/specs/converge-r31-decisions.md, written before the first run).
 * Counts are items BOTH judges answered YES. Returns {ship, reasons}.
 */
export function gateD19({ A, B, agreement }) {
  const reasons = [];
  if (agreement.false_open < 0.7)
    reasons.push(`false_open agreement ${agreement.false_open.toFixed(2)} < 0.70`);
  if (agreement.missed_open < 0.7)
    reasons.push(`missed_open agreement ${agreement.missed_open.toFixed(2)} < 0.70`);
  if (A.falseOpen < 4) reasons.push(`FO(A) = ${A.falseOpen} < 4: the defect does not reach this population`);
  if (B.falseOpen > A.falseOpen / 2) reasons.push(`FO(B) = ${B.falseOpen} > FO(A)/2 = ${A.falseOpen / 2}`);
  if (B.missedOpen > A.missedOpen + 1)
    reasons.push(`MO(B) = ${B.missedOpen} > MO(A)+1 = ${A.missedOpen + 1}`);
  if (B.usable < A.usable - 1) reasons.push(`usable(B) = ${B.usable} < usable(A)-1 = ${A.usable - 1}`);
  return { ship: reasons.length === 0, reasons };
}

/** Blind the rows: judge-facing batches in two orders each, and the key. */
export function buildBlind(dump, { seed = 20261111, batches = 2 } = {}) {
  const ids = seededShuffle(
    Array.from({ length: dump.rows.length }, (_, i) => `s${String(i + 1).padStart(3, '0')}`),
    seed,
  );
  const key = {};
  const entries = dump.rows.map((r, i) => {
    key[ids[i]] = { arm: r.arm, item: r.item };
    return {
      id: ids[i],
      final_reply: dump.items[r.item].finalReply,
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

/**
 * Unblind two judges. `a` / `b` map id → {false_open, missed_open}. Usable counts come from the
 * dump (an unusable reply is still judged: its empty fields cannot contradict, and miss what
 * the reply lists).
 */
export function scoreVerdicts(key, a, b, usableByArm) {
  const arms = Object.fromEntries(
    ARMS.map((arm) => [arm, { n: 0, judged: 0, falseOpen: 0, missedOpen: 0, usable: usableByArm[arm] ?? 0 }]),
  );
  const same = { false_open: 0, missed_open: 0 };
  let n = 0;
  for (const [id, { arm }] of Object.entries(key)) {
    const s = arms[arm];
    s.n++;
    const va = a[id];
    const vb = b[id];
    if (!va || !vb || !FO.includes(va.false_open) || !FO.includes(vb.false_open)) continue;
    if (!MO.includes(va.missed_open) || !MO.includes(vb.missed_open)) continue;
    s.judged++;
    n++;
    if (va.false_open === vb.false_open) same.false_open++;
    if (va.missed_open === vb.missed_open) same.missed_open++;
    if (va.false_open === 'YES' && vb.false_open === 'YES') s.falseOpen++;
    if (va.missed_open === 'YES' && vb.missed_open === 'YES') s.missedOpen++;
  }
  for (const s of Object.values(arms)) {
    s.falseOpenCI = wilson95(s.falseOpen, s.judged);
    s.missedOpenCI = wilson95(s.missedOpen, s.judged);
  }
  const agreement = {
    false_open: n ? same.false_open / n : 0,
    missed_open: n ? same.missed_open / n : 0,
    n,
  };
  return { arms, agreement };
}

export function findTranscript(cc, projectsDir) {
  if (!cc || !existsSync(projectsDir)) return null;
  for (const d of readdirSync(projectsDir)) {
    const p = join(projectsDir, d, `${cc}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** The population, oldest first. `db` is a read-only handle on the store. */
function collectSessions(db, { days, now, projectsDir, readReply, notLowSignalTitleClause }) {
  const summaries = db
    .prepare(
      `SELECT memory_session_id AS sid, project, MAX(created_at_epoch) AS e FROM session_summaries
       WHERE created_at_epoch > ? GROUP BY memory_session_id ORDER BY e ASC, sid ASC`,
    )
    .all(now - days * 86400e3);
  const obsQ = db.prepare(`SELECT id, type, title, narrative FROM observations
    WHERE memory_session_id = ? AND ${notLowSignalTitleClause('')}
    ORDER BY created_at_epoch DESC, id DESC LIMIT 30`);
  const promptsQ = db.prepare(
    'SELECT prompt_text FROM user_prompts WHERE content_session_id = ? ORDER BY prompt_number ASC LIMIT 10',
  );
  const ccQ = db.prepare(`SELECT cc_session_id AS cc FROM user_prompts
    WHERE content_session_id = ? AND cc_session_id IS NOT NULL ORDER BY prompt_number DESC LIMIT 1`);
  const out = [];
  for (const s of summaries) {
    const observations = obsQ.all(s.sid);
    if (observations.length === 0) continue;
    const transcript = findTranscript(ccQ.get(s.sid)?.cc, projectsDir);
    if (!transcript) continue;
    const reply = readReply(transcript);
    if (!reply || !reply.trim()) continue;
    out.push({
      sid: s.sid,
      project: s.project,
      observations,
      userPrompts: promptsQ.all(s.sid).map((p) => p.prompt_text),
      reply,
    });
  }
  return { windowed: summaries.length, items: out };
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
  const dbPath = arg('--db', join(homedir(), '.claude-mem-lite', 'claude-mem-lite.db'));
  // Before any shipped module loads: DB_DIR resolves from it at import time.
  const sandbox = mkdtempSync(join(tmpdir(), 'summary-reply-ab-'));
  process.env.CLAUDE_MEM_DIR = sandbox;
  process.env.CLAUDE_MEM_NO_DELAY = '1';
  try {
    const { default: Database } = await import('better-sqlite3');
    const hc = await import('../haiku-client.mjs');
    const { callLLM } = await import('../lib/llm-call.mjs');
    const { parseJsonFromLLM, scrubSecrets, notLowSignalTitleClause } = await import('../utils.mjs');
    const { buildSessionSummaryPrompt } = await import('../hook-llm.mjs');
    const { extractTailAssistantText } = await import('../lib/summary-extractor.mjs');

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
          readReply: extractTailAssistantText,
          notLowSignalTitleClause,
        });
      } finally {
        db.close();
      }
      const picked = pickEvenly(pop.items, n);
      const items = picked.map((s, i) => ({
        item: i,
        sid: s.sid,
        project: s.project,
        finalReply: scrubSecrets(s.reply).trim(),
      }));
      const rows = [];
      for (let i = 0; i < picked.length; i++) {
        const s = picked[i];
        for (const arm of i % 2 === 0 ? ARMS : [...ARMS].reverse()) {
          const prompt = buildSessionSummaryPrompt({
            project: s.project,
            observations: s.observations,
            userPrompts: s.userPrompts,
            ...(arm === 'B' ? { finalReply: s.reply } : {}),
          });
          const t0 = Date.now();
          let raw = null;
          try {
            raw = await callLLM(prompt, hc.BG_LLM_TIMEOUT_MS);
          } catch (e) {
            raw = null;
            console.error(`item ${i} arm ${arm}: ${e?.message || e}`);
          }
          const p = raw ? parseJsonFromLLM(raw) : null;
          rows.push({
            item: i,
            arm,
            ms: Date.now() - t0,
            promptChars: prompt.system.length + prompt.user.length,
            replied: raw != null,
            usable: summaryUsable(p),
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
        population: pop.items.length,
        n: picked.length,
      };
      writeFileSync(out, JSON.stringify({ meta, items, rows }, null, 2));
      const usable = Object.fromEntries(
        ARMS.map((a) => [a, rows.filter((r) => r.arm === a && r.usable).length]),
      );
      const chars = Object.fromEntries(
        ARMS.map((a) => {
          const xs = rows.filter((r) => r.arm === a).map((r) => r.promptChars);
          return [a, Math.round(xs.reduce((x, y) => x + y, 0) / (xs.length || 1))];
        }),
      );
      console.log(JSON.stringify({ meta, usable, meanPromptChars: chars }, null, 2));
    } finally {
      restore();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function prepare() {
  const [dumpPath, outdir] = process.argv.slice(3, 5);
  if (!dumpPath || !outdir) throw new Error('prepare <rows.json> <outdir>');
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  const { batches, key } = buildBlind(dump, {
    seed: Number(arg('--seed', '20261111')),
    batches: Number(arg('--batches', '2')),
  });
  mkdirSync(outdir, { recursive: true });
  batches.forEach((b, k) => {
    writeFileSync(join(outdir, `batch-${k + 1}-a.json`), JSON.stringify(b.a, null, 2));
    writeFileSync(join(outdir, `batch-${k + 1}-b.json`), JSON.stringify(b.b, null, 2));
  });
  const usable = Object.fromEntries(
    ARMS.map((a) => [a, dump.rows.filter((r) => r.arm === a && r.usable).length]),
  );
  writeFileSync(join(outdir, 'key.json'), JSON.stringify({ key, usable, meta: dump.meta }, null, 2));
  console.log(`${Object.keys(key).length} items in ${batches.length} batches → ${outdir}`);
}

function score() {
  const outdir = process.argv[3];
  if (!outdir) throw new Error('score <outdir>');
  const { key, usable } = JSON.parse(readFileSync(join(outdir, 'key.json'), 'utf8'));
  const merged = { a: {}, b: {} };
  for (const f of readdirSync(outdir)) {
    const m = /^verdicts-\d+-(a|b)\.json$/.exec(f);
    if (m) Object.assign(merged[m[1]], JSON.parse(readFileSync(join(outdir, f), 'utf8')));
  }
  const result = scoreVerdicts(key, merged.a, merged.b, usable);
  console.log(
    JSON.stringify({ ...result, gate: gateD19({ ...result.arms, agreement: result.agreement }) }, null, 2),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fn = { run, prepare, score }[process.argv[2]];
  if (!fn) {
    console.error('usage: summary-reply-ab.mjs run|prepare|score …');
    process.exit(2);
  }
  Promise.resolve(fn()).catch((e) => {
    console.error(e?.stack || e);
    process.exit(1);
  });
}
