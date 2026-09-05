#!/usr/bin/env node
/**
 * error-recall LIVE REPLAY — the ruler behind D#167.
 *
 * WHY THIS EXISTS ALONGSIDE error-recall-suite.mjs. That suite scores a hand-built
 * fixture, and on this surface a fixture has now twice reported the opposite of the
 * live database (v3.78.0's floor: fixture said "free", the live DB said −37% of
 * injections and 39% of firings silenced). Its cases are also authored, so they cannot
 * answer "what do REAL failures look like" — which is the question D#167 turned out to
 * be about. This script has no fixture at all:
 *
 *   inputs  = real failing commands with their real stderr, read out of Claude Code
 *             transcripts and filtered through the surface's OWN trigger
 *             (detectBashSignificance → isHardError). A case that cannot fire is a
 *             case that measures a path which does not exist.
 *   corpus  = the live observations database, every project with enough rows to rank.
 *
 * WHAT IT MEASURES. For each (failure × project) it runs the shipped selection and asks
 * of every injected row: did this row match anything from the FAILURE, or only from the
 * COMMAND? A row in the second class was admitted because the memory happens to talk
 * about `npm` or `python3`. The headline is the share of such rows, and the share of
 * cases where one of them is the TOP row — the row whose lesson_learned is inlined
 * verbatim into the model's context.
 *
 *   node benchmark/error-recall-live-replay.mjs                 # replay + report
 *   node benchmark/error-recall-live-replay.mjs --shapes f.json # reuse an extraction
 *   node benchmark/error-recall-live-replay.mjs --dump f.json   # save the extraction
 *   node benchmark/error-recall-live-replay.mjs --host-failures # the D#151 population
 *   CLAUDE_MEM_ERROR_RECALL_RERANK=off node …                   # the pre-D#167 ordering
 *
 * A/B IT BY FLIPPING THE SWITCH, not by editing this file: run once with the rerank on
 * and once with `CLAUDE_MEM_ERROR_RECALL_RERANK=off`, and diff the two headlines.
 *
 * THE TWO POPULATIONS ARE DISJOINT AND BOTH SHIP. Claude Code splits tool outcomes
 * across two hook events, and this surface is now registered on both:
 *
 *   default          PostToolUse — commands that exited 0 while printing error-ish
 *                    text. Until D#170 this was the ONLY thing the surface ever saw,
 *                    which is why the classic `cmd 2>&1 | tail` (a pipe laundering a
 *                    failure into a success) was over-represented in it.
 *   --host-failures  PostToolUseFailure — calls the HOST marked `is_error`. Tool-chain
 *                    refusals are excluded through lib/tool-refusal.mjs, the same
 *                    predicate the hook consults, so the count here is the population
 *                    the hook actually admits rather than an optimistic upper bound.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import { detectBashSignificance, planErrorRecall } from '../bash-utils.mjs';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';
import { selectErrorRecall } from '../lib/error-recall-core.mjs';
// The SHIPPED gate, not a copy of it. `--host-failures` measures the population the
// PostToolUseFailure hook actually admits, so it has to consult the same predicate the
// hook does — a second regex list here would drift from production and report a
// coverage number no user ever gets.
import { shouldRecallOnFailure } from '../lib/tool-refusal.mjs';

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};
const MIN_PROJECT_ROWS = Number(argOf('--min-rows') || 20);

// ─── 1. Real failures out of the transcripts ─────────────────────────────────

/** Transcript roots. One level of project dirs, each holding *.jsonl — no deeper walk. */
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

function extractShapes() {
  const hostFailures = argv.includes('--host-failures');
  // Bucketed by the gate's OWN reason rather than lumped into one "refusals" tally.
  // Pre-release review caught the lump: `shouldRecallOnFailure` also rejects text under
  // 10 characters, so a single counter labelled "tool-chain refusals excluded" was
  // reporting refusals + empties, and the inflated number then got quoted as the
  // refusal rate in two source files.
  const stats = {
    files: 0,
    bashResults: 0,
    failures: 0,
    hardErrors: 0,
    excluded: { refusal: 0, empty: 0, interrupt: 0 },
  };
  const pairs = [];
  for (const dir of transcriptDirs()) {
    let entries = [];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of entries) {
      stats.files++;
      let lines = [];
      try {
        lines = readFileSync(join(dir, f), 'utf8').split('\n');
      } catch {
        continue;
      }
      const pending = new Map(); // tool_use_id -> command
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const content = ev?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part?.type === 'tool_use' && part?.name === 'Bash' && typeof part.input?.command === 'string') {
            pending.set(part.id, part.input.command);
          } else if (part?.type === 'tool_result' && pending.has(part.tool_use_id)) {
            const cmd = pending.get(part.tool_use_id);
            pending.delete(part.tool_use_id);
            stats.bashResults++;
            const response = textOf(part.content);
            if (hostFailures) {
              // `is_error` is the HOST's own verdict and the only authoritative one.
              // Accepting a text match for "Error:"/"Exit code N" anywhere instead
              // sweeps in harness scripts echoing their own exit codes.
              if (part.is_error !== true) continue;
              stats.failures++;
              // `error` is the field name the hook payload uses; feeding the transcript
              // text through the same key keeps this measuring the shipped gate.
              const verdict = shouldRecallOnFailure({ error: response });
              if (!verdict.ok) {
                if (verdict.reason in stats.excluded) stats.excluded[verdict.reason]++;
                continue;
              }
              pairs.push({ cmd, response: response.slice(0, 4000) });
              continue;
            }
            if (!(part.is_error === true || /^Error:|Exit code [1-9]/m.test(response))) continue;
            stats.failures++;
            // THE TRIGGER, not a lookalike. Cases that cannot fire measure nothing.
            if (!detectBashSignificance({ command: cmd }, response)?.isHardError) continue;
            stats.hardErrors++;
            pairs.push({ cmd, response: response.slice(0, 4000) });
          }
        }
      }
    }
  }
  // One command re-run five times is one shape, keyed on the command plus its first
  // error-ish line — otherwise a loop in one session dominates the sample.
  const seen = new Set();
  const shapes = [];
  for (const p of pairs) {
    const head = (p.response.match(/.*(?:error|fail|ERR!|panic|not found).*/i) || [''])[0].slice(0, 120);
    const k = `${p.cmd} ${head}`;
    if (seen.has(k)) continue;
    seen.add(k);
    shapes.push(p);
  }
  return { shapes, stats };
}

// ─── 2. Corpus ───────────────────────────────────────────────────────────────

const dbPath = join(resolveDataDir(process.env.CLAUDE_MEM_DIR), 'claude-mem-lite.db');
let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`no live database at ${dbPath} — this script measures a real corpus, not a fixture.`);
  console.error(String(e.message || e));
  process.exit(2);
}

const quote = (t) => `"${String(t).replace(/"/g, '""')}"`;

/**
 * Membership of row `id` in term `t`'s match set, per the index that produced the score.
 *
 * NOT `WHERE rowid = ? AND fts MATCH ?`. That form silently DROPS the rowid constraint
 * (SQLite 3.53.1): it returns a row whenever the term matches anywhere in the table, so
 * it is an always-true test for any term the corpus contains. The first version of this
 * measurement used it and reported 0.0% command-only rows — the number an always-true
 * predicate always reports — against a real 39.2%. The self-check below is what stops
 * that from silently recurring.
 */
const termRowsStmt = db.prepare('SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?');
const termSets = new Map();
function rowsFor(term) {
  if (termSets.has(term)) return termSets.get(term);
  let s = new Set();
  try {
    s = new Set(termRowsStmt.all(quote(term)).map((r) => r.rowid));
  } catch {
    s = new Set();
  }
  termSets.set(term, s);
  return s;
}
const matches = (id, term) => rowsFor(term).has(id);

function assertRulerCanSayNo() {
  const probe = db
    .prepare('SELECT title FROM observations WHERE title IS NOT NULL AND length(title) > 12 LIMIT 1')
    .get();
  if (!probe) throw new Error('ruler check: corpus has no titled row to probe with');
  const word = (probe.title.match(/[a-zA-Z]{5,}/) || [])[0];
  if (!word) throw new Error('ruler check: could not derive a probe term from the corpus');
  const hits = rowsFor(word.toLowerCase());
  if (!hits.size) throw new Error(`ruler check: probe term "${word}" matches nothing`);
  const outside = db
    .prepare('SELECT id FROM observations LIMIT 2000')
    .all()
    .map((r) => r.id)
    .find((id) => !hits.has(id));
  if (outside === undefined) throw new Error('ruler check: every row matches the probe term');
  if (matches(outside, word.toLowerCase())) {
    throw new Error(
      'ruler check: the membership predicate is ALWAYS-TRUE — every number below would be meaningless',
    );
  }
}

/**
 * planErrorRecall returns the two term classes alongside the merged list. Cross-check
 * the invariant it documents (command words first, so they are a PREFIX of the merged
 * list) rather than trusting it: if that ever stops holding, every row below is
 * classified against the wrong partition.
 */
function classesFor(shape) {
  const plan = planErrorRecall(shape.cmd, shape.response);
  if (!plan) return null;
  if (plan.terms.slice(0, plan.cmdWords.length).join(' ') !== plan.cmdWords.join(' ')) {
    throw new Error(
      `term-class invariant broken: ${JSON.stringify(plan.terms)} / ${JSON.stringify(plan.cmdWords)}`,
    );
  }
  return plan;
}

// ─── 3. Replay ───────────────────────────────────────────────────────────────

function main() {
  const cached = argOf('--shapes');
  let shapes;
  let stats = null;
  if (cached) {
    shapes = JSON.parse(readFileSync(cached, 'utf8'));
  } else {
    ({ shapes, stats } = extractShapes());
  }
  const dump = argOf('--dump');
  if (dump) writeFileSync(dump, JSON.stringify(shapes, null, 1));

  if (!shapes.length) {
    console.error('no real failures found — point CLAUDE_MEM_TRANSCRIPT_ROOT at a transcript dir.');
    process.exit(2);
  }
  assertRulerCanSayNo();

  const projects = db
    .prepare('SELECT project, COUNT(*) n FROM observations GROUP BY project HAVING n >= ? ORDER BY n DESC')
    .all(MIN_PROJECT_ROWS);
  const now = Date.now();

  let fired = 0;
  let gated = 0;
  let named = 0;
  let cases = 0;
  let rows = 0;
  let cmdOnly = 0;
  let top1CmdOnly = 0;
  const perProject = new Map();

  for (const shape of shapes) {
    const plan = classesFor(shape);
    if (!plan) {
      gated++;
      continue;
    }
    fired++;
    // How often the FAILURE's own name is in the query at all — the term-side half of
    // D#167, which no injection count can distinguish from a ranking problem.
    if (plan.errWords.some((t) => /(?:error|exception)$/.test(t) || /^e[a-z]{3,}$/.test(t))) named++;

    for (const { project } of projects) {
      const out = selectErrorRecall(db, {
        cmd: shape.cmd,
        response: shape.response,
        project,
        now,
        floor: 0,
      });
      if (!out || !out.rows.length) continue;
      const pp = perProject.get(project) || { cases: 0, rows: 0, cmdOnly: 0, top1: 0 };
      cases++;
      pp.cases++;
      rows += out.rows.length;
      pp.rows += out.rows.length;
      const bad = out.rows.filter((r) => !plan.errWords.some((t) => matches(r.id, t)));
      cmdOnly += bad.length;
      pp.cmdOnly += bad.length;
      if (!plan.errWords.some((t) => matches(out.rows[0].id, t))) {
        top1CmdOnly++;
        pp.top1++;
      }
      perProject.set(project, pp);
    }
  }

  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
  console.log('─── error-recall live replay ───');
  if (stats && argv.includes('--host-failures')) {
    console.log('POPULATION: host-flagged failures — what the PostToolUseFailure hook admits (D#170)');
    const ex = stats.excluded;
    console.log(
      `transcripts ${stats.files}  ·  Bash results ${stats.bashResults}  ·  is_error ${stats.failures}`,
    );
    console.log(
      `excluded by the gate: tool-chain refusal ${ex.refusal} (${pct(ex.refusal, stats.failures)})` +
        `  ·  too little text ${ex.empty}  ·  interrupt ${ex.interrupt}`,
    );
  } else if (stats) {
    console.log(
      `transcripts ${stats.files}  ·  Bash results ${stats.bashResults}  ·  failures ${stats.failures}  ·  reach this surface ${stats.hardErrors} (${pct(stats.hardErrors, stats.failures)})`,
    );
  }
  console.log(
    `shapes ${shapes.length} (fired ${fired}, gated silent ${gated})  ·  projects ${projects.length}`,
  );
  console.log(
    `rerank: ${process.env.CLAUDE_MEM_ERROR_RECALL_RERANK === 'off' ? 'OFF (pre-D#167 flat OR)' : 'on (default)'}`,
  );
  console.log('');
  console.log(`firing cases : ${cases}`);
  console.log(`injected rows: ${rows}`);
  console.log(`  matched NO error term (command vocabulary only): ${cmdOnly}  ${pct(cmdOnly, rows)}`);
  console.log(
    `  cases whose TOP-1 row is one of those          : ${top1CmdOnly}  ${pct(top1CmdOnly, cases)}`,
  );
  console.log('');
  console.log('per project (the small ones are where a removal-based gate collapses):');
  console.table(
    [...perProject.entries()].map(([p, v]) => ({
      project: p,
      obs: projects.find((x) => x.project === p).n,
      cases: v.cases,
      rows: v.rows,
      cmdOnly: v.cmdOnly,
      cmdOnlyPct: pct(v.cmdOnly, v.rows),
      top1CmdOnlyPct: pct(v.top1, v.cases),
    })),
  );
}

main();
