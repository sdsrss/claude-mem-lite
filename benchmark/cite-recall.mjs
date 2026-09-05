#!/usr/bin/env node
// Cite-recall benchmark: replays Claude Code transcripts and measures, per
// injection hook, what fraction of injected #NN observation IDs the assistant
// ever cites in the same session within a time window.
//
// Why this exists: system-wide cite-recall is a misleading aggregate — it
// hides which hook is actually working. The architectural fact this metric
// surfaces is that file-keyed injection (PreToolUse:Read/Edit) gets ~94%
// recall while semantic-keyed (UserPromptSubmit) gets ~26%. See
// observation #8255 for the full pre/post-v2.34.6 baseline.
//
// Usage:
//   node benchmark/cite-recall.mjs                    # last 30d, this project
//   node benchmark/cite-recall.mjs --start=ISO --end=ISO
//   node benchmark/cite-recall.mjs --json > out.json
//   node benchmark/cite-recall.mjs --dir=/path/to/transcripts
//   node benchmark/cite-recall.mjs --vs-baseline      # diff vs baseline.json
//   node benchmark/cite-recall.mjs --vs-baseline --fail-on-regression
//
// Defaults: dir = ~/.claude/projects/-mnt-data-ssd-dev-projects-mem
//           end = now, start = end - 30d.
//
// --vs-baseline reads benchmark/cite-recall-baseline.json (per-hook recall
// frozen at v2.56.0) and prints Δ for each hook + 95% CI overlap analysis.
// Used after deploying P0 fixes to quantify cite-recall improvements: e.g.
// after the v2.57.x prompt fix + UPS gate, UserPromptSubmit recall is
// expected to climb from 25.8% (baseline) toward 50%+. Without this flag,
// the operator has to eyeball two JSON dumps side-by-side.
//
// --fail-on-regression exits non-zero if any per-hook recall is materially
// below baseline (recall drop > 0.05 absolute outside CI overlap). Used in
// post-deploy CI to catch silent recall regressions.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
// One caliber for `#NN`, owned by the production extractor this benchmark re-derives.
import { OBS_ID_DIGITS, citationIdRe } from '../lib/citation-tracker.mjs';
import { wilson95 } from './wilson.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const DIR = args.dir || join(homedir(), '.claude/projects/-mnt-data-ssd-dev-projects-mem');
const END = args.end ? new Date(args.end).getTime() : Date.now();
const START = args.start ? new Date(args.start).getTime() : END - 30 * 86400000;
const JSON_MODE = !!args.json;

if (!Number.isFinite(START) || !Number.isFinite(END) || START >= END) {
  console.error(`Bad window: start=${args.start} end=${args.end}`);
  process.exit(2);
}

// Imported, not re-typed: this file's numerator was `{2,6}` while its OWN denominator
// (INJECTED_ROW_RE below) was `{1,7}`, so any id the denominator admitted and the
// numerator could not see counted as injected-never-cited and biased cite-rate DOWN.
const ID_RE = citationIdRe();
const INJECT_MARKER = /\[mem\]/;
// Path B (hook.mjs <memory-context> semantic injection) carries NO [mem] marker —
// its lines are `- [type] title (#id)`. Pre-2026-06-29 this tool's [mem]-only gate
// counted ONLY path A ([mem] FYI, user-prompt-search.js) under "UserPromptSubmit"
// and left path B invisible. Recognise it and bucket it as a distinct pseudo-hook
// so the two sibling UserPromptSubmit injectors get separate cite-recall. They are
// always separate attachments (never co-located), so per-attachment marker routing
// cleanly splits them.
const MEMCTX_MARKER = /<memory-context/;
// Task-imperative line (CLAUDE_MEM_TASK_IMPERATIVE, default off): `Memory — a past
// lesson applies to THIS task. You must: … (#NN)`. It is co-located with the
// <memory-context> block in the SAME UserPromptSubmit attachment, so per-attachment
// routing would fold its #NN into :memory-context. Per-line routing (below) credits
// it to a distinct :imperative bucket so its cite-recall is measurable on its own.
const IMP_MARKER = /Memory — a past lesson applies to THIS task\. You must:/;
// PostToolUse error-recall hint (hook.mjs triggerErrorRecall → post-tool-use.sh):
// `[claude-mem-lite] Related memories found for this error:` then `  #NN [type] body`
// rows. Routed to its own :error-recall bucket with row-anchored extraction — mirroring
// production lib/citation-tracker.mjs INJECTED_ROW_RE — so the benchmark's injected
// denominator matches the runtime's channel definition. Before D#51 the error-recall
// #NN were mislabeled under the generic PostToolUse:Bash bucket and only counted
// INCIDENTALLY when a co-located `[mem] episode flushed` line tripped the loose [mem]
// marker; the broad ID_RE also swallowed a foreign plugin's code-comment #NN (e.g. a
// code-graph grep echoing `// #123`), a lesson body quoting another obs, and the
// trailing `mem_get(ids=[…])` bare numbers — never-cited ids that deflate the channel's
// true recall by padding its denominator.
const ERR_RECALL_MARKER = /Related memories found for this error/;
// A genuine injected lesson row starts (after ≤6 spaces of indent) with `#NN [type]`.
// Bounded type list mirrors observations.type CHECK; `.exec` (non-global) returns the
// FIRST match, so a `#NN` quoted later in the same row's body is not captured.
const INJECTED_ROW_RE = new RegExp(
  `^\\s{0,6}#(${OBS_ID_DIGITS})\\s+\\[(?:bugfix|decision|change|discovery|feature|refactor|lesson)\\]`,
);

function extractIds(text) {
  const ids = new Set();
  if (!text || typeof text !== 'string') return ids;
  for (const m of text.matchAll(ID_RE)) ids.add(m[1]);
  return ids;
}

// Row-anchored id extraction for recall-style blocks: only lines that ARE an injected
// lesson row (`#NN [type] …`) contribute, not every #NN token in the surrounding text.
function extractRowIds(textLines) {
  const ids = new Set();
  for (const line of textLines) {
    const m = INJECTED_ROW_RE.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function* lines(file) {
  const buf = readFileSync(file, 'utf8');
  for (const line of buf.split('\n')) if (line) yield line;
}

const candidateFiles = readdirSync(DIR)
  .filter((n) => n.endsWith('.jsonl'))
  .map((n) => join(DIR, n))
  .filter((p) => {
    try {
      return statSync(p).mtimeMs >= START;
    } catch {
      return false;
    }
  });

const hookInject = new Map(); // hookName -> Set<NN>
const hookOcc = new Map(); // hookName -> total occurrences
const hookCitedFromInjection = new Map(); // hookName -> Set<NN> (cited IDs that this hook injected)

const sessionStats = new Map(); // sid -> stats
function getStats(sid) {
  let s = sessionStats.get(sid);
  if (!s) {
    s = { reads: 0, edits: 0, writes: 0, bashes: 0, assistantTurns: 0, hadCite: false, hadInjection: false };
    sessionStats.set(sid, s);
  }
  return s;
}

// Route a set of injected ids into a (per-session + global) hook bucket. Factored so
// path-A/B and the co-located :imperative line share one accounting path.
function routeIds(sessionInjectionsByHook, hookName, ids, stats) {
  let bucket = sessionInjectionsByHook.get(hookName);
  if (!bucket) {
    bucket = new Set();
    sessionInjectionsByHook.set(hookName, bucket);
  }
  for (const id of ids) bucket.add(id);
  if (!hookInject.has(hookName)) {
    hookInject.set(hookName, new Set());
    hookOcc.set(hookName, 0);
    hookCitedFromInjection.set(hookName, new Set());
  }
  for (const id of ids) hookInject.get(hookName).add(id);
  hookOcc.set(hookName, hookOcc.get(hookName) + ids.size);
  stats.hadInjection = true;
}

for (const file of candidateFiles) {
  const sessionInjectionsByHook = new Map();
  let firstSid = null;

  // Pass 1: collect injections + tool counts
  for (const line of lines(file)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < START || ts >= END) continue;
    const sid = entry.sessionId || file;
    if (!firstSid) firstSid = sid;
    const stats = getStats(sid);

    if (entry.attachment) {
      const text = (entry.attachment.stdout || '') + '\n' + (entry.attachment.content || '');
      if (
        INJECT_MARKER.test(text) ||
        MEMCTX_MARKER.test(text) ||
        IMP_MARKER.test(text) ||
        ERR_RECALL_MARKER.test(text)
      ) {
        const baseHook = entry.attachment.hookName || entry.attachment.hookEvent || 'unknown';
        const allLines = text.split('\n');

        // Task-imperative line is co-located with <memory-context> in the same
        // attachment — split it out per-line so its #NN credits a distinct bucket.
        const impIds = extractIds(allLines.filter((l) => IMP_MARKER.test(l)).join('\n'));
        if (impIds.size > 0) routeIds(sessionInjectionsByHook, `${baseHook}:imperative`, impIds, stats);

        // PostToolUse error-recall hint → :error-recall, row-anchored (see ERR_RECALL_MARKER).
        // Detected by its own marker (not the incidental [mem] one) so a block with no
        // co-located flush line is still counted, and row-anchored so foreign/quoted/bare
        // #NN never enter the injected denominator.
        if (ERR_RECALL_MARKER.test(text)) {
          const errIds = extractRowIds(allLines);
          if (errIds.size > 0) routeIds(sessionInjectionsByHook, `${baseHook}:error-recall`, errIds, stats);
        }

        // Split path B (<memory-context>) from path A ([mem] FYI) — both are
        // UserPromptSubmit / SessionStart surfaces. PostToolUse mem #NN are error-recall
        // ONLY (handled above), so exclude PostToolUse from this generic broad-extract
        // path: otherwise it both double-counts the error-recall rows AND lets a foreign
        // plugin's PostToolUse:Bash output (e.g. a code-graph grep echoing `// #123` or a
        // `<memory-context` source literal) pollute a generic bucket via the loose text
        // markers.
        if (!baseHook.startsWith('PostToolUse')) {
          const restText = allLines.filter((l) => !IMP_MARKER.test(l)).join('\n');
          if (INJECT_MARKER.test(restText) || MEMCTX_MARKER.test(restText)) {
            const ids = extractIds(restText);
            if (ids.size > 0) {
              const hookName = MEMCTX_MARKER.test(restText) ? `${baseHook}:memory-context` : baseHook;
              routeIds(sessionInjectionsByHook, hookName, ids, stats);
            }
          }
        }
      }
    }

    if (entry.message?.role === 'assistant' || entry.type === 'assistant') {
      stats.assistantTurns++;
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === 'tool_use') {
            const name = c.name;
            if (name === 'Read') stats.reads++;
            else if (name === 'Edit') stats.edits++;
            else if (name === 'Write') stats.writes++;
            else if (name === 'Bash') stats.bashes++;
          }
        }
      }
    }
  }

  // Pass 2: collect citations and credit hooks that injected the cited ID in this session
  for (const line of lines(file)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < START || ts >= END) continue;
    const sid = entry.sessionId || file;
    const stats = getStats(sid);

    if (entry.message?.role === 'assistant' || entry.type === 'assistant') {
      const content = entry.message?.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === 'text' && c.text) text += c.text + '\n';
        }
      }
      const ids = extractIds(text);
      if (ids.size > 0) {
        stats.hadCite = true;
        for (const id of ids) {
          for (const [hookName, injectedSet] of sessionInjectionsByHook) {
            if (injectedSet.has(id)) {
              hookCitedFromInjection.get(hookName).add(id);
            }
          }
        }
      }
    }
  }
}

const activeSessions = [...sessionStats.values()].filter(
  (s) => s.hadInjection || s.hadCite || s.reads || s.edits || s.writes || s.bashes || s.assistantTurns,
);
const n = activeSessions.length;
const days = (END - START) / 86400000;

const perHook = [...hookInject.entries()]
  .map(([h, injSet]) => {
    const cited = hookCitedFromInjection.get(h);
    const recall = injSet.size === 0 ? 0 : cited.size / injSet.size;
    const [lo, hi] = wilson95(cited.size, injSet.size);
    return {
      hook: h,
      inject_unique: injSet.size,
      occurrences: hookOcc.get(h),
      cited_unique: cited.size,
      recall,
      recall_ci95: [Number(lo.toFixed(3)), Number(hi.toFixed(3))],
    };
  })
  .sort((a, b) => b.occurrences - a.occurrences);

const totals = activeSessions.reduce(
  (a, s) => ({
    reads: a.reads + s.reads,
    edits: a.edits + s.edits,
    writes: a.writes + s.writes,
    bashes: a.bashes + s.bashes,
    turns: a.turns + s.assistantTurns,
  }),
  { reads: 0, edits: 0, writes: 0, bashes: 0, turns: 0 },
);

const withCite = activeSessions.filter((s) => s.hadCite).length;
const sessionCiteCi = wilson95(withCite, n);

const result = {
  window: {
    start: new Date(START).toISOString(),
    end: new Date(END).toISOString(),
    days: Number(days.toFixed(1)),
  },
  dir: DIR,
  sessions: n,
  selection_bias: {
    read_edit_write_per_session: n
      ? Number(((totals.reads + totals.edits + totals.writes) / n).toFixed(1))
      : 0,
    read_per_session: n ? Number((totals.reads / n).toFixed(1)) : 0,
    edit_per_session: n ? Number((totals.edits / n).toFixed(1)) : 0,
    write_per_session: n ? Number((totals.writes / n).toFixed(1)) : 0,
    bash_per_session: n ? Number((totals.bashes / n).toFixed(1)) : 0,
    asst_turns_per_session: n ? Number((totals.turns / n).toFixed(1)) : 0,
  },
  session_cite_rate: {
    rate: n ? Number((withCite / n).toFixed(3)) : 0,
    ci95: [Number(sessionCiteCi[0].toFixed(3)), Number(sessionCiteCi[1].toFixed(3))],
    sessions_with_cite: withCite,
    total_sessions: n,
  },
  per_hook: perHook,
};

if (JSON_MODE) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// ── Optional baseline diff ─────────────────────────────────────────────────
if (args['vs-baseline']) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const baselinePath = join(__dirname, 'cite-recall-baseline.json');
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (err) {
    console.error(`\nCannot read baseline ${baselinePath}: ${err.message}`);
    process.exit(2);
  }

  // Map hook name → baseline entry (use the "current" baseline window, not
  // the comparison_reference older window — that one is kept for a different
  // pre/post comparison).
  const baseHooks = new Map();
  for (const h of baseline.per_hook || []) baseHooks.set(h.hook, h);

  const REGRESSION_FLOOR = 0.05; // absolute recall drop to count as regression
  const diffRows = [];
  let anyRegression = false;

  for (const cur of perHook) {
    const base = baseHooks.get(cur.hook);
    if (!base) {
      diffRows.push({ hook: cur.hook, status: 'new', curRecall: cur.recall });
      continue;
    }
    const delta = cur.recall - base.recall;
    // Regression test: not just |delta| < 0, but also outside CI overlap.
    // If [cur_lo, cur_hi] and [base_lo, base_hi] overlap, the change isn't
    // statistically distinguishable — don't fail on noise.
    const [curLo, curHi] = cur.recall_ci95;
    const [baseLo, baseHi] = base.recall_ci95 || [0, 1];
    const ciOverlap = !(curHi < baseLo || curLo > baseHi);
    const regressed = delta < -REGRESSION_FLOOR && !ciOverlap;
    if (regressed) anyRegression = true;
    diffRows.push({
      hook: cur.hook,
      curRecall: cur.recall,
      baseRecall: base.recall,
      delta,
      ciOverlap,
      regressed,
      status: regressed ? 'REGRESSION' : delta > REGRESSION_FLOOR && !ciOverlap ? 'IMPROVEMENT' : 'flat',
    });
  }

  console.log('\n## Cite-recall Δ vs baseline');
  console.log(`Baseline version: ${baseline.version || 'n/a'}  scanned: ${baseline.scanned_at || 'n/a'}`);
  console.log('   hook                                  curRecall  baseRecall   delta   status');
  for (const d of diffRows) {
    const cap = d.hook.length > 36 ? d.hook.slice(0, 36) : d.hook.padEnd(36);
    if (d.status === 'new') {
      console.log(`  ${cap} ${(d.curRecall * 100).toFixed(1).padStart(8)}%       (new)        —    new-hook`);
      continue;
    }
    const cur = (d.curRecall * 100).toFixed(1).padStart(8) + '%';
    const baseStr = (d.baseRecall * 100).toFixed(1).padStart(7) + '%';
    const ds = (d.delta >= 0 ? '+' : '') + (d.delta * 100).toFixed(1) + '%';
    const dsPad = ds.padStart(7);
    console.log(`  ${cap} ${cur}    ${baseStr}  ${dsPad}   ${d.status}`);
  }

  if (args['fail-on-regression'] && anyRegression) {
    console.error('\n  ⚠ Regression detected (recall drop > 5% absolute, CI non-overlapping).');
    process.exit(1);
  }
  process.exit(0);
}

console.log(`# cite-recall window=[${result.window.start} → ${result.window.end}) (${result.window.days}d)`);
console.log(`# dir=${DIR}`);
console.log(`# active_sessions=${n}`);
console.log('');
console.log('## Per-hook recall (within-session attribution)');
console.log('   hook                                   inject_unique  occurrences  cited  recall   95% CI');
for (const r of perHook) {
  const cap = r.hook.length > 36 ? r.hook.slice(0, 36) : r.hook.padEnd(36);
  const ciStr = `[${(r.recall_ci95[0] * 100).toFixed(1)}, ${(r.recall_ci95[1] * 100).toFixed(1)}]%`;
  console.log(
    `  ${cap} ${String(r.inject_unique).padStart(5)} ${String(r.occurrences).padStart(11)} ${String(r.cited_unique).padStart(7)} ${(r.recall * 100).toFixed(1).padStart(6)}%  ${ciStr}`,
  );
}
console.log('');
console.log('## Selection-bias check (compare across release windows)');
console.log(`  Read+Edit+Write per session: ${result.selection_bias.read_edit_write_per_session}`);
console.log(
  `    Read=${result.selection_bias.read_per_session}  Edit=${result.selection_bias.edit_per_session}  Write=${result.selection_bias.write_per_session}`,
);
console.log(`  Bash per session:            ${result.selection_bias.bash_per_session}`);
console.log(`  asst-turns per session:      ${result.selection_bias.asst_turns_per_session}`);
console.log('');
console.log('## Session-level cite rate');
const sc = result.session_cite_rate;
console.log(
  `  ${(sc.rate * 100).toFixed(1)}% (${sc.sessions_with_cite}/${sc.total_sessions})  95% CI [${(sc.ci95[0] * 100).toFixed(1)}%, ${(sc.ci95[1] * 100).toFixed(1)}%]`,
);
