#!/usr/bin/env node
/**
 * citation LIVE REPLAY — every injection FACE's cite-rate, re-derived from real
 * transcripts through the SHIPPED extractors.
 *
 * WHY THIS EXISTS ALONGSIDE THE TWO THINGS THAT LOOK LIKE IT.
 *
 *   `claude-mem-lite citation-stats` reads `citation_surface_log`, a table written at
 *     Stop. That table is only as old as the METER, and the meter is routinely younger
 *     than the behaviour it measures. On 2026-08-25 it held n=8 over 2.1 days for
 *     `task_imperative` — which reads like "not enough data to decide" — while these
 *     same extractors run over the live corpus gave n=34, because the FLAG had been
 *     parked for weeks and the meter had only shipped in v3.76. A face is invisible
 *     there for as long as it predates its own accounting.
 *
 *   `benchmark/cite-recall.mjs` walks real transcripts, but routes ids into buckets
 *     with its OWN marker set (`[mem]`, `<memory-context`, a hand-copied imperative
 *     string) — a TWIN of lib/citation-tracker.mjs's SURFACE_MATCHERS, and the exact
 *     shape of duplication this project keeps paying for. Its buckets are hook-EVENT
 *     names rather than the `citation_surface_log.surface` labels every docblock and
 *     CLI quotes, so its rows cannot be compared to a published per-face number
 *     without a translation step; and its cited-side attribution is a per-session
 *     union, the caliber that credited `subagent` for cross-agent citations until
 *     v3.81.0. It stays for its per-hook baseline diff; new per-FACE questions belong
 *     here.
 *
 * WHAT IT MEASURES. For each session: which observation ids each face put in front of
 * the model, and which of those the model then cited back as `#NN`. Both halves come
 * from production — `extractInjectedBySurface`, `extractCitationsFromTranscript`,
 * `collectSubagentSurface` — so a face added to SURFACE_MATCHERS appears here without
 * this file being touched, and the coverage assertion below fails loudly if one is
 * added that this script cannot reach.
 *
 * CALIBER, stated because two rounds of this project's history turn on it:
 *   denominator = (session, id) PAIRS. One observation counts ONCE per session per
 *     face however many times it was injected — the house unit, and the one
 *     `citation_surface_log` keys on (project, session, surface).
 *   numerator   = that id appearing as `#NN` in that session's own assistant text.
 *     For the five attachment faces that means MAIN-THREAD text (`mainOnly`), matching
 *     the citation-decay loop. For `subagent` it means the RECEIVING agent's own text:
 *     an id handed to agent A and mentioned by agent B is NOT a hit.
 *
 *   NEVER COMPARE TWO RUNS TAKEN AT DIFFERENT TIMES. The corpus grows every session,
 *   so subtracting yesterday's rate from today's attributes corpus growth to whatever
 *   shipped in between — an error made and caught on 2026-08-25 (a denominator read
 *   +38 across a flip that a same-corpus one-pass A/B put at +22). Use `--split <ISO>`,
 *   which cuts ONE walk over ONE snapshot into a before/after arm, or freeze the corpus
 *   with `--dump` and re-score it with `--corpus`.
 *
 *   node benchmark/citation-live-replay.mjs                     # every face, whole corpus
 *   node benchmark/citation-live-replay.mjs --split 2026-08-24  # before/after, ONE walk
 *   node benchmark/citation-live-replay.mjs --since 2026-08-01 --project mem
 *   node benchmark/citation-live-replay.mjs --dump c.json       # freeze the corpus
 *   node benchmark/citation-live-replay.mjs --corpus c.json     # re-score a frozen one
 *   node benchmark/citation-live-replay.mjs --by-project --json
 *
 * `--split` cuts on the session START timestamp (the first parsable one in the
 * transcript), so a session that began before the boundary and ran for hours after it
 * lands entirely in the `before` arm. That matters precisely because the flag exists to
 * attribute a delta to something that shipped at a point in time. `--project` is an
 * unanchored substring over the encoded directory name, so `--project mem` would also
 * select a `memo` project if one existed.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import {
  CITATION_SURFACES,
  DECAY_DENOMINATOR_SURFACES,
  extractInjectedBySurface,
  extractCitationsFromTranscript,
  classifyCitationContext,
  collectSubagentSurface,
} from '../lib/citation-tracker.mjs';
import { readTranscriptEntries } from '../lib/transcript-scan.mjs';
import { wilson95 } from './wilson.mjs';
import Database from 'better-sqlite3';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};
const has = (flag) => argv.includes(flag);

// ─── 0. Which faces this ruler can and cannot reach ──────────────────────────

// Stamped into every `--dump` and required by `--corpus`.
//
// THE RULE, restated precisely after v3.86.0's pre-tag review found it stated in a form
// the same release then violated: bump this whenever a reader could MISREAD an older
// dump — that is, whenever a field a consumer treats as REQUIRED changes shape or
// meaning. Bumped to /2 by the FLOW-2 annotation, because records gained `citedTotal`
// and reading its absence as zero would report every frozen session as pollution-free.
//
// It was deliberately NOT bumped for D#179's `applied`, and the difference is the
// reader, not the record: `mentionVsApplication` returns `null` when no record carries
// the field, so an older dump comes back as "unavailable" rather than as 0% applied. An
// optional field whose own reader refuses to guess does not need a format bump; the
// earlier wording ("whenever a record's shape changes") did not admit that distinction
// and made this file state a rule and break it in one release.
const CORPUS_FORMAT = 'citation-live-replay/2';

// DERIVED from the production table, not a second list of face names: calling the
// extractor with no transcript returns one empty Set per attachment face, so a face
// added to SURFACE_MATCHERS shows up here on its own. Re-typing the names is how a
// surface goes unmetered for a whole minor version (v34.x, #10379).
const ATTACHMENT_FACES = Object.keys(extractInjectedBySurface(null));
const REPLAYABLE = [...ATTACHMENT_FACES, 'subagent'];
// `keyctx` leaves NO trace in a transcript — the SessionStart block is written straight
// to stdout and its ids live in a per-session runtime marker file that is deleted with
// the runtime dir. Naming it here rather than letting it be quietly absent: a face
// missing from a coverage table reads as "covered, scored zero".
const NOT_REPLAYABLE = { keyctx: 'SessionStart render leaves no transcript trace (ids live in a runtime marker; see extractInjectedFromKeyContext)' };

/**
 * Every face the product knows about must be either scored here or declared unreachable.
 * Exported (with the lists as parameters) so a test can hand it a face that is in
 * neither and see it throw — a guard that can only be exercised through the real
 * CITATION_SURFACES is a guard nobody has watched fail.
 */
export function assertFaceCoverage(replayable = REPLAYABLE, notReplayable = NOT_REPLAYABLE, allFaces = CITATION_SURFACES) {
  const claimed = new Set([...replayable, ...Object.keys(notReplayable)]);
  const missing = allFaces.filter((f) => !claimed.has(f));
  if (missing.length) {
    throw new Error(
      `face coverage: ${missing.join(', ')} is in CITATION_SURFACES but this replay neither scores it `
      + 'nor declares it unreachable. Add it to REPLAYABLE (with an extractor) or to NOT_REPLAYABLE '
      + '(with the reason) — a face silently absent from the table reads as a face scoring zero.');
  }
  const unknown = [...claimed].filter((f) => !allFaces.includes(f));
  if (unknown.length) {
    throw new Error(`face coverage: ${unknown.join(', ')} is scored here but is not a CITATION_SURFACES face.`);
  }
  // EXACTLY one list, not at-least-one. `claimed` is a union, so without this a face in
  // BOTH lists satisfies the missing-check and the unknown-check at once — and the run
  // then prints "not replayable here: ups" directly above a scored `ups` row. Caught by
  // the v3.82.0 pre-tag review, which also noted the case asserting this property was
  // asserting something else entirely.
  const both = allFaces.filter((f) => replayable.includes(f) && f in notReplayable);
  if (both.length) {
    throw new Error(`face coverage: ${both.join(', ')} is BOTH scored and declared unreachable — `
      + 'the two lists must partition CITATION_SURFACES, or the report contradicts itself.');
  }
}

// ─── 1. Corpus ───────────────────────────────────────────────────────────────

function projectDirs() {
  const root = process.env.CLAUDE_MEM_TRANSCRIPT_ROOT || join(homedir(), '.claude', 'projects');
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name));
  } catch { return []; }
  const filter = argOf('--project');
  return filter ? dirs.filter((d) => basename(d).includes(filter)) : dirs;
}

/**
 * Score ONE main transcript. Sidechain (`<session>/subagents/agent-*.jsonl`) files are
 * never listed here — they sit one level down and are reached only through
 * collectSubagentSurface, which pairs each injection with the citation of the agent
 * that received it.
 */
function scanSession(project, path) {
  // First, because it populates the single-slot parse memo the two extractors below
  // then hit — one parse per transcript rather than three.
  const entries = readTranscriptEntries(path);
  if (!entries.length) return null;
  let ts = NaN;
  for (const e of entries) {
    const t = Date.parse(e?.timestamp || '');
    if (Number.isFinite(t)) { ts = t; break; }
  }
  // A transcript with no parsable timestamp still has a file mtime; losing it from the
  // window would silently shrink the denominator.
  if (!Number.isFinite(ts)) { try { ts = statSync(path).mtimeMs; } catch { return null; } }

  const bySurface = extractInjectedBySurface(path, { mainOnly: true });
  const cited = extractCitationsFromTranscript(path, { mainOnly: true });
  // D#179: split each hit into "named while acting" and "named in prose only", keyed by
  // requestId. Must run BEFORE collectSubagentSurface, which parses the sidechain files
  // and evicts the single-slot entry memo the three extractors above share.
  const ctx = classifyCitationContext(path, { mainOnly: true });
  const faces = {};
  for (const face of ATTACHMENT_FACES) {
    const inj = [...bySurface[face]];
    if (!inj.length) continue;
    const hit = inj.filter((id) => cited.has(id));
    faces[face] = {
      inj,
      hit,
      // Optional field: a frozen corpus dumped before this existed simply lacks it, and
      // the --mentions mode says so rather than reporting the absence as zero.
      applied: hit.filter((id) => (ctx.get(id)?.withTool ?? 0) > 0).length,
    };
  }
  // Parses the sidechain files (evicting the memo), so it goes last.
  const sub = collectSubagentSurface(path);
  if (sub.injected.size) {
    faces.subagent = { inj: [...sub.injected], hit: [...sub.cited], dispatches: sub.files };
  }
  if (!Object.keys(faces).length) return null;
  // citedTotal is the session's WHOLE cited set, not just the part that matches an
  // injection. It is what makes the pollution below visible: a face's `hit` count can
  // only contain ids that face injected, so nothing already in this record could see a
  // session that names fifty ids none of which were ever injected.
  return {
    project, session: basename(path, '.jsonl'), ts,
    anyCite: cited.size > 0, citedTotal: cited.size, faces,
  };
}

function walk() {
  const records = [];
  let files = 0;
  for (const dir of projectDirs()) {
    let names;
    try { names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) {
      files++;
      if (files % 200 === 0) process.stderr.write(`  … ${files} transcripts\n`);
      const rec = scanSession(basename(dir), join(dir, n));
      if (rec) records.push(rec);
    }
  }
  return { records, files };
}

// ─── 2. Aggregation ──────────────────────────────────────────────────────────

export function aggregate(records) {
  const per = new Map();
  const row = (face) => {
    let r = per.get(face);
    if (!r) { r = { face, sessions: 0, pairs: 0, hits: 0, silentPairs: 0, sidechainFiles: 0, projects: new Set() }; per.set(face, r); }
    return r;
  };
  for (const rec of records) {
    for (const [face, v] of Object.entries(rec.faces)) {
      const r = row(face);
      r.sessions++;
      r.pairs += v.inj.length;
      r.hits += v.hit.length;
      // `subagent` only: how many sidechain transcripts this session contributed. Kept
      // as a raw count, never as a rate — see the sidechain_files note in the JSON shape.
      if (v.dispatches) r.sidechainFiles += v.dispatches;
      // Pairs that landed in a session where the model cited NOTHING from any face.
      // Separates "this face's picks were ignored" from "this transcript is a session
      // type that never cites" — without it a corpus of non-citing sessions reads as a
      // face-quality problem.
      if (!rec.anyCite) r.silentPairs += v.inj.length;
      r.projects.add(rec.project);
    }
  }
  return [...per.values()].sort((a, b) => b.pairs - a.pairs);
}

/**
 * Population at which "every pair cited" stops being a small-sample accident and becomes
 * evidence the membership test is broken. The best face on record is task_imperative at
 * 45.7%; 20 consecutive hits at that rate is ~1 in 10^7.
 */
const RULER_FACE_FLOOR = 20;

/**
 * The ruler must be able to return BOTH answers. An always-true membership test reports
 * 100% and an extractor whose numerator cannot see its denominator's ids reports 0%;
 * both have shipped in this repo (the FTS5 `rowid = ? AND fts MATCH ?` trap, and the
 * `{2,6}` numerator against a `{1,7}` denominator in cite-recall.mjs).
 *
 * BOTH GLOBAL AND PER-FACE, because the global sums alone cannot see a single broken
 * FACE. The v3.82.0 pre-tag review probed exactly that: rows of
 * `[{pretool, 10, 10}, {error_recall, 10, 0}]` — one face always-true, one face blind,
 * simultaneously — reduce to 20/10 and the guard stayed silent. Each face has its own
 * extractor in SURFACE_MATCHERS, so per-face is the unit a broken extractor shows up in.
 *
 * The two per-face conditions are deliberately ASYMMETRIC. `hits === pairs` above the
 * floor cannot be real and hard-fails. `hits === 0` CAN be real on a narrow slice
 * (`--project x --since yesterday` on a face that injects rarely), so it is reported as a
 * flag rather than thrown — turning a legitimate measurement into a crash would push
 * people off the tool, which is worse than a line they have to read.
 *
 * @returns {string[]} human-readable flags for faces sitting at exactly 0%.
 */
export function assertRulerCanSayNo(rows, { windowed = false, frozen = false } = {}) {
  const pairs = rows.reduce((a, r) => a + r.pairs, 0);
  const hits = rows.reduce((a, r) => a + r.hits, 0);
  if (!pairs) {
    // Name the likely cause rather than one fixed cause. The first version always said
    // "point CLAUDE_MEM_TRANSCRIPT_ROOT at a real transcript root", which is irrelevant
    // advice under `--corpus` (the root was never walked) and wrong advice under a
    // `--since` that excludes everything.
    const why = windowed
      ? 'the --since/--until window excludes every session'
      : frozen ? `the frozen corpus passed to --corpus holds no injections`
        : 'the shipped extractors matched nothing — point CLAUDE_MEM_TRANSCRIPT_ROOT at a real transcript root';
    throw new Error(`ruler check: no injections in scope — ${why}. No number below would mean anything.`);
  }
  if (hits === pairs) {
    throw new Error(`ruler check: all ${pairs} injected pairs count as cited — the membership test is `
      + 'ALWAYS-TRUE and every rate below would read 100% regardless of behaviour.');
  }
  if (hits === 0) {
    throw new Error(`ruler check: none of ${pairs} injected pairs counts as cited — the numerator cannot `
      + 'see the denominator\'s ids (the classic cause is a caliber mismatch between the injected and '
      + 'cited id patterns), so a 0% reading here is a defect in this script, not a finding.');
  }
  const saturated = rows.filter((r) => r.pairs >= RULER_FACE_FLOOR && r.hits === r.pairs);
  if (saturated.length) {
    throw new Error(`ruler check: face(s) ${saturated.map((r) => r.face).join(', ')} cite at 100% over `
      + `${RULER_FACE_FLOOR}+ pairs — that face's membership test is ALWAYS-TRUE. A global rate below `
      + '100% hid it, which is why this check is per-face.');
  }
  return rows.filter((r) => r.pairs >= RULER_FACE_FLOOR && r.hits === 0)
    .map((r) => `face ${r.face} cites at exactly 0% over ${r.pairs} pairs — check its extractor in `
      + 'SURFACE_MATCHERS before reading that as a finding.');
}

/**
 * The ONE wiring point for both self-checks.
 *
 * They used to be two separate calls in `main()`, and the v3.82.0 pre-tag review showed
 * that commenting BOTH out left all 17 tests green: every case drove the exported guards
 * directly with synthetic inputs, so the functions were proven and their attachment to
 * the running path was not. One call site means one thing to bind, and
 * `tests/citation-live-replay.test.mjs` binds it with a fixture root whose assistant
 * cites every injected id — the process must exit non-zero.
 *
 * Residual, stated rather than papered over: that case fires through the ruler half. A
 * mutation deleting only the `assertFaceCoverage()` line INSIDE this function would still
 * pass, because no fixture can make the real CITATION_SURFACES uncovered from outside.
 * That half is bound at unit level only.
 */
export function runSelfChecks(rows, opts = {}) {
  assertFaceCoverage();
  return assertRulerCanSayNo(rows, opts);
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');

/**
 * Sessions citing more ids than any injection surface could plausibly have supplied.
 *
 * These are document-shaped sessions — writing a CHANGELOG, a release note, or an audit
 * report in a repository whose subject matter IS the memory store, naming dozens of ids
 * in prose. The `#NN` extractor cannot tell that from a citation (D#179), so those
 * sessions inflate every cite-rate on this screen in one direction: up.
 *
 * Reported, not filtered. Which of those mentions is a real use is not decidable from the
 * text, so dropping the sessions would trade a known upward bias for an unknown one; a
 * reader who can see how much of the corpus is document-shaped can discount accordingly.
 * The same reasoning is why the ACCESS-count channel got a relevance gate instead of a
 * context regex (lib/citation-tracker.mjs bumpCitationAccess).
 */
const DOC_SESSION_CITED_IDS = 20;

export function pollutionSensitivity(records, rows) {
  const doc = records.filter((r) => (r.citedTotal ?? 0) > DOC_SESSION_CITED_IDS);
  if (!doc.length) return { docSessions: 0, docSessionIds: new Set(), rows: [] };
  const docIds = new Set(doc.map((r) => r.session));
  const clean = aggregate(records.filter((r) => !docIds.has(r.session)));
  const byFace = new Map(clean.map((r) => [r.face, r]));
  return {
    docSessions: doc.length,
    totalSessions: records.length,
    docSessionIds: docIds,
    rows: rows.map((r) => {
      const c = byFace.get(r.face);
      const full = r.pairs ? r.hits / r.pairs : 0;
      const excl = c && c.pairs ? c.hits / c.pairs : null;
      return {
        face: r.face,
        rate: pct(r.hits, r.pairs),
        pairsFromDocSessions: r.pairs - (c?.pairs ?? 0),
        rateExclDocSessions: excl === null ? 'n/a' : `${(excl * 100).toFixed(1)}%`,
        delta: excl === null ? 'n/a' : `${((excl - full) * 100).toFixed(1)}pp`,
      };
    }),
  };
}

function report(label, rows) {
  console.log(`\n─── ${label} ───`);
  console.table(rows.map((r) => ({
    face: r.face,
    inDecayDenominator: DECAY_DENOMINATOR_SURFACES.includes(r.face) ? 'yes' : 'no',
    sessions: r.sessions,
    projects: r.projects.size,
    pairs: r.pairs,
    cited: r.hits,
    rate: pct(r.hits, r.pairs),
    ci95: (() => { const [lo, hi] = wilson95(r.hits, r.pairs); return `[${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]%`; })(),
    inSilentSessions: r.silentPairs ? pct(r.silentPairs, r.pairs) : '—',
  })));
}

// ─── 3. Main ─────────────────────────────────────────────────────────────────

function parseWhen(flag) {
  const raw = argOf(flag);
  if (raw === null) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) {
    console.error(`${flag}: "${raw}" is not a parsable date.`);
    process.exit(2);
  }
  return t;
}

function main() {
  const frozen = argOf('--corpus');
  let records; let files;
  if (frozen) {
    const loaded = JSON.parse(readFileSync(frozen, 'utf8'));
    // A frozen corpus outlives the code that wrote it — that is the point of freezing
    // one. Refuse a shape this build cannot read rather than silently scoring a
    // partially-understood file and reporting the result as a measurement (#9332).
    if (loaded.format !== CORPUS_FORMAT) {
      console.error(`--corpus ${frozen}: format ${loaded.format ?? '(none)'} — this build reads ${CORPUS_FORMAT}. Re-dump it.`);
      process.exit(2);
    }
    records = loaded.records;
    files = loaded.files;
  } else {
    ({ records, files } = walk());
  }

  const dump = argOf('--dump');
  if (dump) writeFileSync(dump, JSON.stringify({ format: CORPUS_FORMAT, files, records }, null, 1));

  const since = parseWhen('--since');
  const until = parseWhen('--until');
  const inWindow = records.filter((r) => (since === null || r.ts >= since) && (until === null || r.ts < until));

  const all = aggregate(inWindow);
  const pollution = pollutionSensitivity(inWindow, all);
  const rulerFlags = runSelfChecks(all, {
    windowed: (since !== null || until !== null) && records.length > inWindow.length,
    frozen: frozen !== null,
  });

  const split = parseWhen('--split');

  if (has('--json')) {
    const shape = (rows) => rows.map((r) => ({
      face: r.face, sessions: r.sessions, projects: r.projects.size, pairs: r.pairs,
      cited: r.hits, rate: r.pairs ? r.hits / r.pairs : 0, ci95: wilson95(r.hits, r.pairs),
      in_silent_sessions: r.silentPairs,
      // `sidechain_files` is the number of subagent transcripts walked for this face —
      // NOT the per-dispatch denominator. `collectSubagentSurface` documents a
      // per-dispatch caliber of (dispatch, id) PAIRS, and it does not return that count;
      // dividing by files instead reads 8.6% against the documented 14.6%, which is the
      // "two counters that were never the same ruler" defect this project shipped in
      // v3.80.0. So the field is exposed under a name that says what it is and no rate is
      // computed from it. A real per-dispatch rate needs the pair count added to
      // collectSubagentSurface's return; deliberately out of scope at a release gate.
      ...(r.sidechainFiles ? { sidechain_files: r.sidechainFiles } : {}),
      in_decay_denominator: DECAY_DENOMINATOR_SURFACES.includes(r.face),
    }));
    console.log(JSON.stringify({
      transcripts_scanned: files,
      sessions_with_injection: inWindow.length,
      window: { since, until },
      not_replayable: NOT_REPLAYABLE,
      ruler_flags: rulerFlags,
      overall: shape(all),
      ...(split === null ? {} : {
        split_at: split,
        before: shape(aggregate(inWindow.filter((r) => r.ts < split))),
        after: shape(aggregate(inWindow.filter((r) => r.ts >= split))),
      }),
      pollution_sensitivity: {
        doc_session_threshold: DOC_SESSION_CITED_IDS,
        doc_sessions: pollution.docSessions,
        total_sessions: inWindow.length,
        by_face: pollution.rows,
      },
      ...(has('--by-project') ? { by_project: byProject(inWindow) } : {}),
      ...(has('--by-scope') ? { by_scope: byScope(inWindow, scopeLookup()) } : {}),
      // Review S2: the `applied` field is computed in scanSession from the transcript,
      // and until this was exposed nothing exercised that path — setting it to a
      // literal 0 left the suite green while the CHANGELOG headlined a figure derived
      // from it. `null` when no record carries the field, never 0.
      ...(has('--mentions') ? { mention_vs_application: mentionVsApplication(inWindow) } : {}),
    }, null, 2));
    return;
  }

  for (const flag of rulerFlags) console.log(`⚠ ruler flag: ${flag}`);

  console.log('─── citation live replay ───');
  console.log(`transcripts scanned ${files}  ·  sessions carrying an injection ${inWindow.length}`
    + `  ·  projects ${new Set(inWindow.map((r) => r.project)).size}`);
  console.log('caliber: denominator = (session, id) PAIRS; numerator = that id cited as #NN in the');
  console.log('         session\'s own assistant text (main thread; for `subagent`, the RECEIVING agent\'s).');
  for (const [face, why] of Object.entries(NOT_REPLAYABLE)) {
    console.log(`not replayable here: ${face} — ${why}`);
  }

  report('all sessions in window', all);

  // D#179 sensitivity. Printed unconditionally rather than behind a flag: a reader who
  // has to know to ask for the caveat will read the headline rate without it.
  console.log(`\n─── pollution sensitivity (D#179) ───`);
  if (pollution.docSessions === 0) {
    console.log(`no session in window cites more than ${DOC_SESSION_CITED_IDS} ids — no document-shaped`);
    console.log('sessions to discount. The rates above carry no measurable mention-inflation.');
  } else {
    console.log(`${pollution.docSessions} of ${inWindow.length} sessions cite more than `
      + `${DOC_SESSION_CITED_IDS} ids — the document-shaped ones (CHANGELOG / release notes /`);
    console.log('audit reports naming ids in prose). The `#NN` extractor cannot tell those from real');
    console.log('citations, so every rate above is biased UP. Below: the same faces with those sessions');
    console.log('excluded. Reported, not filtered — which mentions were real uses is not decidable from');
    console.log('the text, so dropping them would trade a known bias for an unknown one.');
    console.table(pollution.rows);
  }

  if (split !== null) {
    console.log(`\nsplit at ${new Date(split).toISOString()} — BOTH arms come from the one walk above,`);
    console.log('so nothing between them is corpus growth. Small arms move on single sessions; read the CIs.');
    report(`before ${new Date(split).toISOString().slice(0, 10)}`, aggregate(inWindow.filter((r) => r.ts < split)));
    report(`on/after ${new Date(split).toISOString().slice(0, 10)}`, aggregate(inWindow.filter((r) => r.ts >= split)));
  }

  if (has('--by-project')) {
    console.log('\n─── per project ───');
    console.table(byProject(inWindow));
  }

  if (has('--mentions')) {
    console.log('\n─── cited while ACTING vs cited in PROSE (D#179) ───');
    const rows = mentionVsApplication(inWindow);
    if (!rows) {
      console.log('unavailable: these records carry no `applied` field (frozen corpus dumped');
      console.log('before D#179). Re-walk live, or re-dump the corpus — an absent field is not a zero.');
    } else {
      console.log('Unit = one model RESPONSE (requestId). `applied` = the id was named in a response');
      console.log('that also called a tool; `mentionOnly` = every response naming it was prose.');
      console.log('NEITHER column is a bound: co-occurring with a tool call is not evidence the');
      console.log('lesson was followed, and acting in one response then citing in a later summary');
      console.log('lands in mentionOnly. This sizes the question; it does not settle it.');
      console.table(rows);
      console.log('`subagent` is unavailable here BY CONSTRUCTION — its hits come from the receiving');
      console.log('agent\'s transcript, which this classification does not walk. Not a zero.');
    }
  }

  if (has('--by-scope')) {
    console.log('\n─── per observations.scope (D#153) ───');
    console.log('`pretool` IS the file-triggered face CLAUDE_MEM_SCOPE_FILTER gates. `(gone)` = the row');
    console.log('left the table since injection; kept so the buckets still sum to the face\'s pair count.');
    console.table(byScope(inWindow, scopeLookup()));
  }
}

/**
 * D#179: of the hits that make up each face's numerator, how many were named in a
 * response that also DID something, and how many only in prose?
 *
 * This is the prerequisite the deferred item names — it sizes the contamination, it does
 * not fix it. `applyCitationDecay` promotes on any `#NN` in assistant text, so a release
 * note or an audit promotes every memory it discusses; the same signal feeds
 * citation_surface_log, citation-stats and this replay, so all three move together.
 *
 * NEITHER COLUMN IS A BOUND. `applied` over-counts, because naming an id in a response
 * that also calls a tool is co-occurrence and not evidence the lesson was followed.
 * `mentionOnly` also over-counts, because an agent that acts in one response and cites
 * the lesson in a later summary is classified pure-mention. The split sizes the
 * question; it does not settle it, and a first draft of this docblock called
 * `mentionOnly` a floor, which is wrong in the second direction.
 *
 * `subagent` is absent from the output BY CONSTRUCTION, not because it scored zero: its
 * hits come from the RECEIVING agent's own transcript via collectSubagentSurface, which
 * this classification does not walk. It is declared unavailable rather than omitted —
 * a missing row reads as "that face has no contamination", which is not what is known.
 *
 * Returns null when the records predate the `applied` field (a frozen corpus dumped
 * before this existed) — an absent field must not be reported as zero.
 */
export function mentionVsApplication(records) {
  const per = new Map();
  let sawField = false;
  for (const rec of records) {
    for (const [face, v] of Object.entries(rec.faces)) {
      if (!v.hit?.length) continue;
      if (typeof v.applied !== 'number') continue;
      sawField = true;
      let e = per.get(face);
      if (!e) { e = { face, hits: 0, applied: 0 }; per.set(face, e); }
      e.hits += v.hit.length;
      e.applied += v.applied;
    }
  }
  if (!sawField) return null;
  return [...per.values()]
    .map((e) => ({
      face: e.face,
      hits: e.hits,
      applied: e.applied,
      mentionOnly: e.hits - e.applied,
      mentionOnlyPct: e.hits ? `${((100 * (e.hits - e.applied)) / e.hits).toFixed(1)}%` : 'n/a',
    }))
    .sort((a, b) => b.hits - a.hits);
}

/**
 * D#153's ruler. Break a face's (session,id) pairs down by the row attribute the SCOPE
 * lever keys on — `observations.scope` — and give each bucket its own cite-rate.
 *
 * WHY HERE AND NOT IN denoise-ab. The scope lever lives in scripts/pre-tool-recall.js,
 * which denoise-ab does not execute at all (its own SCOPE docblock says so): editing a
 * scope filter and re-running that harness reports NEUTRAL Δ=0 by construction. A
 * scope-mixed FIXTURE suite there would have produced a number about a corpus somebody
 * authored, which on this surface has twice reported the opposite of the live DB. The
 * question D#153 actually asks — "are environment-scoped rows less relevant ON THE
 * FILE-TRIGGERED FACE" — has a direct answer in real data: that face is `pretool`, and
 * this walk already holds every id it injected and every id the model then cited.
 *
 * Two caliber notes that decide how to read the table:
 *   • an id whose row is gone from the DB (compressed, deleted, merged) buckets as
 *     `(gone)` rather than being dropped, because dropping it would shrink a denominator
 *     silently and the scope buckets would no longer sum to the face's own pair count.
 *   • `(null)` is legacy/manual rows that never went through enrich-time labelling. It is
 *     a real bucket with real behaviour, not missing data to be excluded.
 */
export function byScope(records, scopeOf) {
  const per = new Map();
  for (const rec of records) {
    for (const [face, v] of Object.entries(rec.faces)) {
      const hit = new Set(v.hit);
      for (const id of v.inj) {
        const scope = scopeOf(id);
        const k = `${face} ${scope}`;
        const r = per.get(k) || { face, scope, pairs: 0, cited: 0 };
        r.pairs++;
        if (hit.has(id)) r.cited++;
        per.set(k, r);
      }
    }
  }
  return [...per.values()].sort((a, b) => (a.face === b.face ? b.pairs - a.pairs : a.face.localeCompare(b.face)))
    .map((r) => {
      const [lo, hi] = wilson95(r.cited, r.pairs);
      return { ...r, rate: pct(r.cited, r.pairs), ci95: `[${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]%` };
    });
}

/** id → scope bucket, read once from the live DB. */
function scopeLookup() {
  const db = new Database(join(resolveDataDir(), 'claude-mem-lite.db'), { readonly: true });
  const map = new Map();
  try {
    for (const r of db.prepare('SELECT id, scope FROM observations').all()) {
      map.set(r.id, r.scope || '(null)');
    }
  } finally { db.close(); }
  return (id) => map.get(Number(id)) ?? '(gone)';
}

function byProject(records) {
  const per = new Map();
  for (const rec of records) {
    for (const [face, v] of Object.entries(rec.faces)) {
      const k = `${rec.project} ${face}`;
      const r = per.get(k) || { project: rec.project, face, pairs: 0, cited: 0 };
      r.pairs += v.inj.length;
      r.cited += v.hit.length;
      per.set(k, r);
    }
  }
  return [...per.values()].sort((a, b) => b.pairs - a.pairs)
    .map((r) => ({ ...r, rate: pct(r.cited, r.pairs) }));
}

// Run only when invoked as a script. Importing this file must stay side-effect-free so
// the two self-checks above can be unit-tested with synthetic inputs — a guard that has
// never been watched to fail is a guard nobody knows works.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
