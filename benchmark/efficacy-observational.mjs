#!/usr/bin/env node
// efficacy-observational.mjs — STEP 1 of the efficacy-validation design.
// Spec: docs/superpowers/specs/2026-06-05-memory-efficacy-validation-design.md §7
//
// PURPOSE: a near-zero-cost, READ-ONLY go/no-go gate before spending real
// Claude sessions on the A/B pilot. It mines existing transcripts + git history
// for a *directional* hint: are file-edits that received a lesson injection
// followed by FEWER subsequent fix: commits than edits that did not?
//
// THIS IS NOT A CAUSAL ESTIMATE. Treated edits are systematically on hotter /
// buggier files (the system injects more where there's more history) — a
// selection bias that pushes the naive contrast AGAINST the system. We report
// the naive cross-edit contrast AND a within-file before/after-first-injection
// contrast (which partly controls file-hotness). Verdict logic only reads the
// SIGN, never the magnitude. Sample sizes are printed loudly; if N is too small
// to give a sign, the script says so rather than inventing a conclusion.
//
// Outcome = "F received a fix: commit in (t+GAP, t+W]". GAP skips same-work-unit
// fixes (an edit and its own follow-up fix in the same burst aren't a
// memory-prevention failure). W is swept.
//
// Usage:  node benchmark/efficacy-observational.mjs            # human report
//         node benchmark/efficacy-observational.mjs --json     # machine output
//         node benchmark/efficacy-observational.mjs --dir=PATH

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
// One caliber for `#NN`, owned by the production extractor (was a hand-copied `{2,6}`).
import { citationIdRe } from '../lib/citation-tracker.mjs';
import { wilson95 } from './wilson.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const DIR = args.dir || join(homedir(), '.claude/projects/-mnt-data-ssd-dev-projects-mem');
const JSON_MODE = !!args.json;

const DAY = 86400000;
const GAP_MS = 1 * DAY; // skip same-work-unit follow-up fixes
const WINDOWS = [7 * DAY, 14 * DAY, 30 * DAY];

const ID_RE = citationIdRe();
const INJECT_MARKER = /\[mem\]/;
// pre-tool-recall.js injects "[mem] Lessons for <file>:" — the file the lesson
// pool was keyed to. This ties an injection to a concrete file deterministically.
const LESSON_FILE_RE = /Lessons for ([^\s:]+)/i;

function* lines(file) {
  const buf = readFileSync(file, 'utf8');
  for (const line of buf.split('\n')) if (line) yield line;
}
function basename(p) {
  return String(p).split('/').pop();
}
function extractIds(text) {
  const ids = new Set();
  if (typeof text === 'string') for (const m of text.matchAll(ID_RE)) ids.add(m[1]);
  return ids;
}

// ── git: basename -> sorted[] of fix: commit epochs (ms) ─────────────────────
function buildFixIndex() {
  const repo = process.cwd();
  const out = execSync("git -C '" + repo + "' log --extended-regexp --grep='^fix' --format='%H %ct'", {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  const idx = new Map(); // basename -> number[]
  for (const row of out) {
    const sp = row.indexOf(' ');
    const hash = row.slice(0, sp);
    const epoch = parseInt(row.slice(sp + 1), 10) * 1000;
    let files = '';
    try {
      files = execSync("git -C '" + repo + "' show --name-only --format= " + hash, {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    for (const f of files.split('\n')) {
      if (!f.trim()) continue;
      const b = basename(f.trim());
      if (!idx.has(b)) idx.set(b, []);
      idx.get(b).push(epoch);
    }
  }
  for (const arr of idx.values()) arr.sort((a, b) => a - b);
  return idx;
}

function fixInWindow(fixIdx, file, t, w) {
  const arr = fixIdx.get(basename(file));
  if (!arr) return false;
  const lo = t + GAP_MS,
    hi = t + w;
  for (const e of arr) {
    if (e > lo && e <= hi) return true;
    if (e > hi) break;
  }
  return false;
}

// ── transcripts: ordered edit events + their injection-treatment ─────────────
// An Edit/Write on file F at time t is "treated" if a "Lessons for F" injection
// fired earlier in the same session (PreToolUse recall fires immediately before
// the edit it guards).
function collectEditEvents() {
  const files = readdirSync(DIR)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => join(DIR, n));
  const edits = []; // {file, ts, treated, sid}
  let sessionsSeen = 0,
    injCount = 0,
    editTotal = 0;

  for (const file of files) {
    sessionsSeen++;
    // injectedFiles: basename -> earliest injection epoch in this session
    const injected = new Map();
    const evs = [];
    for (const line of lines(file)) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
      if (!Number.isFinite(ts)) continue;
      const sid = e.sessionId || file;
      if (e.attachment) {
        const text = (e.attachment.stdout || '') + '\n' + (e.attachment.content || '');
        if (INJECT_MARKER.test(text) && extractIds(text).size > 0) {
          const m = text.match(LESSON_FILE_RE);
          if (m) {
            const b = basename(m[1]);
            if (!injected.has(b)) injected.set(b, ts);
            injCount++;
          }
        }
      }
      if (e.message?.role === 'assistant' || e.type === 'assistant') {
        const content = e.message?.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === 'tool_use' && (c.name === 'Edit' || c.name === 'Write')) {
              const fp = c.input?.file_path;
              if (fp) evs.push({ file: basename(fp), ts, sid });
            }
          }
        }
      }
    }
    for (const ev of evs) {
      editTotal++;
      const injTs = injected.get(ev.file);
      const treated = injTs != null && injTs <= ev.ts;
      edits.push({ ...ev, treated });
    }
  }
  return { edits, sessionsSeen, injCount, editTotal };
}

function rate(events, fixIdx, w, pred) {
  let n = 0,
    s = 0;
  for (const ev of events) {
    if (!pred(ev)) continue;
    n++;
    if (fixInWindow(fixIdx, ev.file, ev.ts, w)) s++;
  }
  return { n, s, p: n ? s / n : null, ci: wilson95(s, n) };
}

// ── run ──────────────────────────────────────────────────────────────────────
const fixIdx = buildFixIndex();
const { edits, sessionsSeen, injCount, editTotal } = collectEditEvents();

// dataEnd = end of OUTCOME availability (HEAD/now). Edits with t+w > dataEnd have
// a truncated outcome window → right-censored. The censored-safe rows only count
// edits whose full window fits before dataEnd, removing that artifact.
const dataEnd = Date.now();

// file-level injection facts (whole dataset, not per-window)
const firstInj = new Map(); // injected file -> earliest treated edit ts
for (const e of edits) if (e.treated && !firstInj.has(e.file)) firstInj.set(e.file, e.ts);
const injectedFiles = new Set(firstInj.keys());
// never-injected files: appear as edits but never received any injection
const neverInjFiles = new Set();
for (const e of edits) if (!injectedFiles.has(e.file)) neverInjFiles.add(e.file);
// per never-injected file: median edit ts (for the maturation placebo split)
const medianTs = new Map();
for (const f of neverInjFiles) {
  const ts = edits
    .filter((e) => e.file === f)
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  medianTs.set(f, ts[Math.floor(ts.length / 2)]);
}

const fits = (e, w) => e.ts + w <= dataEnd; // censored-safe predicate

const result = {
  meta: { dir: DIR, sessionsSeen, injCount, editTotal, gapDays: GAP_MS / DAY, dataEnd },
  windows: {},
};

for (const w of WINDOWS) {
  const treated = rate(edits, fixIdx, w, (e) => e.treated);
  const untreated = rate(edits, fixIdx, w, (e) => !e.treated);
  // within-file before/after first injection, CENSORED-SAFE (hotness-controlled)
  const before = rate(
    edits,
    fixIdx,
    w,
    (e) => injectedFiles.has(e.file) && e.ts < firstInj.get(e.file) && fits(e, w),
  );
  const after = rate(
    edits,
    fixIdx,
    w,
    (e) => injectedFiles.has(e.file) && e.ts >= firstInj.get(e.file) && fits(e, w),
  );
  // MATURATION PLACEBO: never-injected files, split at each file's own median ts,
  // same censored-safe guard. If these ALSO show before>after, the within-file
  // drop is maturation/recency, NOT memory efficacy.
  const plBefore = rate(
    edits,
    fixIdx,
    w,
    (e) => neverInjFiles.has(e.file) && e.ts < medianTs.get(e.file) && fits(e, w),
  );
  const plAfter = rate(
    edits,
    fixIdx,
    w,
    (e) => neverInjFiles.has(e.file) && e.ts >= medianTs.get(e.file) && fits(e, w),
  );
  result.windows[w / DAY] = {
    treated,
    untreated,
    withinFile: { before, after },
    placebo: { before: plBefore, after: plAfter },
  };
}

if (JSON_MODE) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const pct = (x) => (x == null ? '  n/a' : (100 * x).toFixed(1).padStart(5) + '%');
const ci = (c) => `[${(100 * c[0]).toFixed(0)}–${(100 * c[1]).toFixed(0)}%]`;
console.log('STEP 1 — observational efficacy pre-check (READ-ONLY, directional only)');
console.log(`dir: ${DIR}`);
console.log(
  `sessions=${sessionsSeen}  file-keyed injections=${injCount}  edit/write events=${editTotal}  gap=${GAP_MS / DAY}d\n`,
);

const didDeltas = []; // difference-in-differences per window (memory-specific drop)
for (const w of WINDOWS) {
  const r = result.windows[w / DAY];
  const wfDrop =
    r.withinFile.before.p != null && r.withinFile.after.p != null
      ? r.withinFile.before.p - r.withinFile.after.p
      : null;
  const plDrop =
    r.placebo.before.p != null && r.placebo.after.p != null ? r.placebo.before.p - r.placebo.after.p : null;
  const did = wfDrop != null && plDrop != null ? wfDrop - plDrop : null;
  const enoughWf = r.withinFile.before.n >= 10 && r.withinFile.after.n >= 10;
  const enoughPl = r.placebo.before.n >= 10 && r.placebo.after.n >= 10;
  console.log(
    `── window ${w / DAY}d — outcome = file gets a fix: commit in (t+${GAP_MS / DAY}d, t+${w / DAY}d], censored-safe ──`,
  );
  console.log(`  cross-edit (CONFOUNDED by hotness, ignore for verdict):`);
  console.log(
    `     treated   ${pct(r.treated.p)} ${ci(r.treated.ci)} (n=${r.treated.n})   untreated ${pct(r.untreated.p)} ${ci(r.untreated.ci)} (n=${r.untreated.n})`,
  );
  console.log(
    `  within-file (hotness-controlled): before ${pct(r.withinFile.before.p)} (n=${r.withinFile.before.n}) → after ${pct(r.withinFile.after.p)} (n=${r.withinFile.after.n})  drop=${wfDrop == null ? 'n/a' : pct(wfDrop)}`,
  );
  console.log(
    `  placebo  (never-injected, maturation): before ${pct(r.placebo.before.p)} (n=${r.placebo.before.n}) → after ${pct(r.placebo.after.p)} (n=${r.placebo.after.n})  drop=${plDrop == null ? 'n/a' : pct(plDrop)}`,
  );
  if (enoughWf && enoughPl && did != null) {
    didDeltas.push(did);
    console.log(
      `  → DiD (memory-specific drop = within-file drop − placebo drop) = ${pct(did)}  ${did > 0.03 ? '[+ memory hint]' : did < -0.03 ? '[− against]' : '[≈ explained by maturation]'}`,
    );
  } else {
    console.log(
      `  → DiD: N too small in within-file and/or placebo arm (need ≥10 each) — no read at this window`,
    );
  }
  console.log('');
}

console.log(
  'VERDICT (reads ONLY the difference-in-differences; cross-edit & raw within-file are confounded):',
);
if (didDeltas.length === 0) {
  console.log('  INCONCLUSIVE — after censoring + maturation control, sample is too thin for a DiD read.');
  console.log(
    '  The observational gate cannot resolve this — by design it only ever offered a hint. Decide the',
  );
  console.log(
    '  pilot on its own merits: it is the instrument built precisely because observation is this confounded.',
  );
} else {
  const pos = didDeltas.filter((d) => d > 0.03).length;
  const neg = didDeltas.filter((d) => d < -0.03).length;
  const all = didDeltas.length;
  if (pos === all) {
    console.log(
      '  HINT +  EVERY valid window shows injected files dropping post-edit fix-rate MORE than maturation',
    );
    console.log(
      '          predicts (positive DiD throughout). Weak/confounded/observational, but does not contradict',
    );
    console.log('          the efficacy hypothesis. → Pilot justified.');
  } else if (neg === all) {
    console.log(
      '  HINT −  Every valid window: within-file drop fully explained by maturation. No observational support.',
    );
  } else {
    console.log(
      '  WEAK/MIXED  DiD inconsistent across windows (some +, some ≈0). At least one positive window also',
    );
    console.log(
      '          carries a base-rate-asymmetry artifact (placebo = cold files, no room to drop). Net: the',
    );
    console.log(
      '          observational gate is essentially SILENT — it neither supports nor refutes efficacy.',
    );
  }
  console.log(
    '  STRUCTURAL LIMIT: in a fully-dogfooded system, injection is applied to ~every high-risk (hot) file,',
  );
  console.log(
    '  so no comparable UNEXPOSED hot-file control exists. Treatment is confounded with the risk factor by',
  );
  console.log(
    '  construction → observation cannot identify the effect. This is the textbook reason an RCT is required,',
  );
  console.log(
    '  not a defect of this script. Sign-of-DiD only; N small; calendar-time leaks into both arms.',
  );
}
