#!/usr/bin/env node
/**
 * imperative-pool LIVE REPLAY — what the candidate-pool bound costs, on real prompts.
 *
 * WHY IT IS IN THE TREE. v3.82.0 widened `rankImperativeCandidates`'s pool from `LIMIT 50`
 * to `LIMIT IMPERATIVE_POOL_BACKSTOP` and published numbers for what that recovered. The
 * pre-tag review's fair objection was that nothing in the repo could reproduce any of them:
 * the error-recall face got `benchmark/error-recall-live-replay.mjs` committed as a
 * permanent ruler for exactly this reason. This is that ruler for the imperative face.
 *
 * `benchmark/denoise-ab.mjs` is STRUCTURALLY BLIND here and always reports NEUTRAL: its
 * suites are query→document FTS, while this face is prompt→lesson identifier overlap. A
 * NEUTRAL there says nothing about a change to this pool.
 *
 *   inputs  = real typed user prompts read out of Claude Code transcripts, each paired to
 *             the project whose corpus it would actually have hit (derived from the
 *             transcript's own `cwd`, never from the encoded directory name, which is
 *             lossy — `_` and `/` both become `-`).
 *   corpus  = the live observations DB.
 *
 * WHAT IT CHECKS, beyond reporting rates: the monotonicity argument the release rests on.
 * The wide pool is a SUPERSET of the narrow one, so its top-1 score must be >= the narrow
 * one's and a pick may only change when the score strictly improves. That is an argument,
 * not a measurement, so the harness tries to FALSIFY it on every prompt and exits non-zero
 * if it ever finds a counterexample.
 *
 *   node benchmark/imperative-pool-replay.mjs              # replay + report
 *   node benchmark/imperative-pool-replay.mjs --narrow 50  # the pre-v3.82.0 bound
 *   node benchmark/imperative-pool-replay.mjs --json
 *   node benchmark/imperative-pool-replay.mjs --population # just the per-project pool sizes
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';
import { rankImperativeCandidates, IMPERATIVE_POOL_BACKSTOP } from '../hook-memory.mjs';
import { extractIdents } from '../lib/lesson-idents.mjs';
import { liveObsFilterSql } from '../lib/inject-search-core.mjs';

const argv = process.argv.slice(2);
const argOf = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};
const NARROW = Number(argOf('--narrow') || 50);

const dbPath = join(resolveDataDir(process.env.CLAUDE_MEM_DIR), 'claude-mem-lite.db');
let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`no live database at ${dbPath} — this script measures a real corpus, not a fixture.`);
  console.error(String(e.message || e));
  process.exit(2);
}

/**
 * The pool query with a parameterised LIMIT.
 *
 * This IS a partial twin of the shipped query, which is only acceptable because
 * `assertAgreesWithShipped` below refuses to report anything until it has confirmed that
 * at the shipped bound it returns exactly what `rankImperativeCandidates` returns. The
 * filters are imported (`liveObsFilterSql`, `extractIdents`), not retyped — the
 * `importance = 3` populations published for v3.82.0 were first measured WITHOUT
 * `liveObsFilterSql`, which counted superseded and compressed rows the pool can never
 * return and overstated one project by 33%.
 */
function rankAt(limit, userPrompt, project) {
  const promptIdents = new Set(extractIdents(userPrompt));
  if (promptIdents.size === 0) return [];
  const rows = db
    .prepare(
      `
    SELECT id, title, lesson_learned, importance
    FROM observations
    WHERE project = ?
      AND ${liveObsFilterSql('')}
      AND COALESCE(importance, 1) >= 2
      AND lesson_learned IS NOT NULL
      AND TRIM(lesson_learned) != ''
      AND LOWER(TRIM(lesson_learned)) != 'none'
    ORDER BY importance DESC, created_at_epoch DESC, id DESC
    LIMIT ${limit}
  `,
    )
    .all(project);
  const out = [];
  for (const r of rows) {
    const overlap = extractIdents(`${r.lesson_learned} ${r.title || ''}`).filter((i) =>
      promptIdents.has(i),
    ).length;
    if (overlap === 0) continue;
    out.push({ id: r.id, importance: r.importance || 2, overlap, score: (r.importance || 2) * overlap });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Per-project pool sizes under the SHIPPED predicate, split by importance. */
function populations() {
  return db
    .prepare(
      `
    SELECT project,
           COUNT(*) eligible,
           SUM(COALESCE(importance, 1) >= 3) imp3,
           SUM(COALESCE(importance, 1) = 2) imp2
    FROM observations
    WHERE ${liveObsFilterSql('')}
      AND COALESCE(importance, 1) >= 2
      AND lesson_learned IS NOT NULL
      AND TRIM(lesson_learned) != ''
      AND LOWER(TRIM(lesson_learned)) != 'none'
    GROUP BY project HAVING eligible > 0 ORDER BY eligible DESC
  `,
    )
    .all();
}

// ─── real prompts, paired to their own project ───────────────────────────────

function realPrompts() {
  const root = process.env.CLAUDE_MEM_TRANSCRIPT_ROOT || join(homedir(), '.claude', 'projects');
  const seen = new Set();
  const out = [];
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = join(root, d.name);
    let names;
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const n of names) {
      let lines;
      try {
        lines = readFileSync(join(dir, n), 'utf8').split('\n');
      } catch {
        continue;
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e?.type !== 'user' || e?.isSidechain === true) continue;
        // A TYPED prompt is a plain string; arrays are tool_result payloads.
        const c = e.message?.content;
        if (typeof c !== 'string') continue;
        const t = c.trim();
        if (!t || t.length < 12 || t.length > 4000) continue;
        if (t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[mem]')) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        const cwd = typeof e.cwd === 'string' ? e.cwd : '';
        const parts = cwd.split('/').filter(Boolean);
        out.push({ text: t, project: parts.length >= 2 ? `${parts.at(-2)}--${parts.at(-1)}` : null });
      }
    }
  }
  return out;
}

/**
 * The twin above may not report a number until it has been shown to equal production at
 * production's own setting. A ruler that has drifted from the thing it measures reports
 * confidently about a program that does not exist.
 */
function assertAgreesWithShipped(prompts, projects) {
  let checked = 0;
  for (const p of prompts.slice(0, 400)) {
    for (const { project } of projects.slice(0, 4)) {
      const mine = rankAt(IMPERATIVE_POOL_BACKSTOP, p.text, project).map((r) => [r.id, r.score]);
      const theirs = rankImperativeCandidates(db, p.text, project).map((r) => [r.id, r.score]);
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
        throw new Error(
          `ruler check: this file's pool query disagrees with the shipped ` +
            `rankImperativeCandidates on project ${project} — every number below would describe ` +
            'a program that is not the one that ships.',
        );
      }
      checked++;
    }
  }
  if (!checked) throw new Error('ruler check: nothing to compare — no prompts or no projects.');
  return checked;
}

function main() {
  const pops = populations();
  if (argv.includes('--population')) {
    console.table(
      pops.map((r) => ({ ...r, overBackstop: r.eligible > IMPERATIVE_POOL_BACKSTOP ? 'YES' : '' })),
    );
    return;
  }

  const prompts = realPrompts();
  const projects = db
    .prepare('SELECT project, COUNT(*) n FROM observations GROUP BY project HAVING n >= 20 ORDER BY n DESC')
    .all();
  const known = new Map(pops.map((r) => [r.project, r.eligible]));
  const checked = assertAgreesWithShipped(prompts, projects);

  // PRODUCTION PAIRING: a prompt only ever meets its OWN project's corpus. Crossing every
  // prompt with every project inflates the per-project column with pairs that cannot occur.
  const paired = prompts.filter((p) => p.project && known.has(p.project));

  let cases = 0;
  let bothPick = 0;
  let destroyed = 0;
  let changed = 0;
  let supersetViolations = 0;
  let monotonicityViolations = 0;
  let changedWithoutGain = 0;
  const per = new Map();
  for (const { text, project } of paired) {
    const narrow = rankAt(NARROW, text, project);
    const wide = rankImperativeCandidates(db, text, project);
    if (!narrow.length && !wide.length) continue;
    cases++;
    const r = per.get(project) || {
      project,
      eligible: known.get(project),
      cases: 0,
      destroyed: 0,
      changed: 0,
    };
    r.cases++;
    // The argument the release rests on, attacked on every prompt rather than asserted.
    const wideIds = new Set(wide.map((x) => x.id));
    if (narrow.some((x) => !wideIds.has(x.id))) supersetViolations++;
    if (narrow.length && wide.length) {
      bothPick++;
      if (wide[0].score < narrow[0].score) monotonicityViolations++;
      if (wide[0].id !== narrow[0].id) {
        changed++;
        r.changed++;
        if (!(wide[0].score > narrow[0].score)) changedWithoutGain++;
      }
    } else if (wide.length) {
      destroyed++;
      r.destroyed++;
    }
    per.set(project, r);
  }

  const bench = paired.filter((p) => p.project === pops[0]?.project).slice(0, 200);
  const timed = {};
  for (const [label, limit] of [
    ['narrow', NARROW],
    ['shipped', IMPERATIVE_POOL_BACKSTOP],
  ]) {
    const t0 = process.hrtime.bigint();
    for (const p of bench) rankAt(limit, p.text, p.project);
    timed[label] = Number(process.hrtime.bigint() - t0) / 1e6 / (bench.length || 1);
  }

  const violations = supersetViolations + monotonicityViolations + changedWithoutGain;
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
  const result = {
    narrow: NARROW,
    shipped: IMPERATIVE_POOL_BACKSTOP,
    prompts_scanned: prompts.length,
    prompts_with_own_project: paired.length,
    ruler_check_pairs: checked,
    cases_with_a_candidate: cases,
    picks_destroyed_by_narrow: destroyed,
    top1_changed: changed,
    both_picked: bothPick,
    superset_violations: supersetViolations,
    monotonicity_violations: monotonicityViolations,
    changed_without_score_gain: changedWithoutGain,
    ms_per_prompt: timed,
    populations: pops,
  };

  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('─── imperative-pool live replay ───');
    console.log(`narrow LIMIT ${NARROW}  vs  shipped IMPERATIVE_POOL_BACKSTOP ${IMPERATIVE_POOL_BACKSTOP}`);
    console.log(
      `ruler check: this file's pool query == shipped rankImperativeCandidates on ${checked} (prompt, project) pairs`,
    );
    console.log(
      `prompts ${prompts.length}  ·  with a resolvable own-project corpus ${paired.length}  ·  producing a candidate ${cases}`,
    );
    console.log('');
    console.log(`picks the narrow bound destroys outright: ${destroyed}  ${pct(destroyed, cases)}`);
    console.log(`top-1 changed (of ${bothPick} where both picked) : ${changed}  ${pct(changed, bothPick)}`);
    console.log(`ms/prompt: narrow ${timed.narrow.toFixed(2)}  ·  shipped ${timed.shipped.toFixed(2)}`);
    console.log('');
    console.log('superset/monotonicity attack — the release argument, tried against every prompt:');
    console.log(`  narrow pick absent from wide pool : ${supersetViolations}`);
    console.log(`  wide top-1 scores LOWER than narrow: ${monotonicityViolations}`);
    console.log(`  pick changed without a strict gain : ${changedWithoutGain}`);
    console.log('');
    console.table(
      per.size ? [...per.values()].sort((a, b) => b.cases - a.cases) : [{ note: 'no paired prompts' }],
    );
    console.log('eligible pool per project (SHIPPED predicate — live filter included):');
    console.table(pops.slice(0, 10));
  }

  if (violations) {
    console.error(
      `\nFALSIFIED: ${violations} counterexample(s) to the superset/monotonicity argument. ` +
        "The claim that widening the pool cannot lower this face's objective does NOT hold on this corpus.",
    );
    process.exit(1);
  }
}

main();
