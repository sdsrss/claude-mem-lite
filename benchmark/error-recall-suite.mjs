#!/usr/bin/env node
// Offline calibration suite for the error-recall injection surface.
//
// WHY THIS EXISTS
// The per-face citation funnel (whole of citation_surface_log, 2026-08-24) reads:
//   pretool  432 inj / 151 cited = 35.0%      error_recall 345 inj / 20 cited = 5.8%
// and the ratio error_recall÷pretool held at 0.13–0.17 across the v3.74.0 gate, so the
// low rate is a property of the surface, not of one week's sessions. (That table is
// overwritten in place per resolution, so re-reading it later gives different absolute
// numbers; the ratio is the durable part.) Every other
// injection face carries a relevance floor (user-prompt-search.js: BM25_MIN_SCORE /
// OR_TOP_BM25_FLOOR; hook-memory.mjs: noisePenaltyClause). This one has none — it runs
// an OR query and takes the top ERROR_RECALL_LIMIT rows unconditionally, so it always
// injects a full complement no matter how weakly the rows match. This suite is the
// ruler for changing that; denoise-ab.mjs cannot see this face at all (its suites are
// query→doc, this face's input is a command plus its stderr).
//
// TWO RULES THIS SUITE OBEYS, BOTH LEARNED THE HARD WAY
//
// 1. EVERY CASE MUST CLEAR THE REAL TRIGGER GATE. #10731 records a whole diagnosis
//    built on `apply-seccomp: unshare(CLONE_NEWUSER)`, which has isHardError=false —
//    the scenario was reachable only because the diagnostic script ran the SQL
//    directly, bypassing detectBashSignificance. assertReachable() below refuses to
//    score any case that a real PostToolUse would never deliver. Verified 2026-08-24:
//    SqliteError CANTOPEN, eslint `error`, and `go test FAIL` all fail this check and
//    are therefore NOT in CASES — they belong to D#151 (trigger-面 coverage), a
//    separate lever from precision.
//
// 2. THE CORPUS MUST BE BIG ENOUGH TO HAVE REAL IDF. FTS5 bm25 carries ln(N/df);
//    on a 30-row fixture absolute magnitudes collapse toward zero (v3.61.0 shipped an
//    absolute floor calibrated this way and injected 0/8 on fresh installs). Filler
//    below takes the corpus past FLOOR_REF_CORPUS so a floor calibrated here means
//    the same thing on a real database.
//
// GROUND TRUTH is structural, not a judgement call: for each case the fixture contains
// rows written to explain that failure (relevant) and rows that share the command's
// generic words but not the failure (hard negatives). The hard-negative shape is taken
// from the real misfire #10730 measured: `npm run build` failing on a missing module
// returned two v3.66.0 RELEASE records ahead of the row that explained it, because
// `npm`/`run`/`build` are high-frequency project words that dominate BM25.
//
// SHAPE OF THE FIXTURE: 9 cases over 620 rows — 7 SERVABLE (the corpus can explain the
// failure) and 2 UNSERVABLE (it cannot, which is the common case in production). The
// two populations are scored separately, because averaging them hides both effects:
// servable cases are judged on hit-rate, unservable ones on whether the surface stayed
// quiet. The unservable cases were added after a pre-release review showed a set-level
// floor scoring identically at every threshold — with only well-served cases present,
// a gate whose purpose is "say nothing when the best match is not about the failure"
// has nothing to act on and reads as a no-op lever.
//
// Usage:
//   node benchmark/error-recall-suite.mjs            per-case table
//   node benchmark/error-recall-suite.mjs --scores   |bm25| distribution by class
//   node benchmark/error-recall-suite.mjs --sweep    effect of each floor on injections
//   node benchmark/error-recall-suite.mjs --compare  floor off vs on
//   node benchmark/error-recall-suite.mjs --json

import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { detectBashSignificance } from '../bash-utils.mjs';
import {
  selectErrorRecall,
  ERROR_RECALL_LIMIT,
  CALIBRATED_ERROR_RECALL_BM25_FLOOR,
} from '../lib/error-recall-core.mjs';

const PROJECT = 'bench-proj';
const DAY = 86400000;

// ─── Real failure shapes (each verified isHardError=true; see assertReachable) ───

const OUT = {
  npmEnoent: [
    'npm ERR! code ENOENT',
    'npm ERR! syscall open',
    'npm ERR! path /repo/package.json',
    'npm ERR! errno -2',
    "npm ERR! enoent ENOENT: no such file or directory, open '/repo/package.json'",
  ].join('\n'),
  pyTraceback: [
    'Traceback (most recent call last):',
    '  File "train.py", line 42, in <module>',
    '    main()',
    'ValueError: shape mismatch for tensor',
  ].join('\n'),
  cannotFindModule: [
    "Error: Cannot find module './lib/observation-write.mjs'",
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)',
  ].join('\n'),
  vitestAssertion: [
    ' FAIL  tests/scope-filter.test.mjs > excludes environment scope',
    'AssertionError: expected 3 to be 0',
  ].join('\n'),
  typeError: [
    "TypeError: Cannot read properties of undefined (reading 'rows')",
    '    at selectErrorRecall (/repo/lib/error-recall-core.mjs:88:20)',
  ].join('\n'),
  commandNotFound: 'bash: line 1: shellcheck: command not found',
  goPanic: ['panic: assignment to entry in nil map', '', 'goroutine 1 [running]:'].join('\n'),
  segfault: 'Segmentation fault (core dumped)',
};

/**
 * Cases. `relevant` / `negative` are corpus rows; ids are assigned at seed time.
 * A row's membership is decided by CONSTRUCTION (was it written to explain this
 * failure?), never by eyeballing a ranking — otherwise the ruler is scored against
 * the thing it is measuring.
 */
const CASES = [
  {
    name: 'npm-enoent',
    cmd: 'npm run build',
    output: OUT.npmEnoent,
    relevant: [
      [
        'ENOENT on package.json means the cwd is wrong',
        'enoent package.json open syscall wrong working directory npm',
      ],
      ['npm ERR! enoent after a plugin relocation', 'enoent errno npm install path moved plugin cache'],
    ],
    negative: [
      [
        'v3.66.0 released: npm publish and signed release green',
        'npm run build release publish version bump tag ci green',
      ],
      ['npm run build now emits the bundled manifest', 'npm run build manifest bundle output artifacts'],
    ],
  },
  {
    name: 'py-traceback',
    cmd: 'python train.py --epochs 3',
    output: OUT.pyTraceback,
    relevant: [
      [
        'ValueError shape mismatch comes from the unbatched tensor',
        'traceback valueerror shape mismatch tensor batch dimension train',
      ],
    ],
    negative: [
      ['train.py gained a --epochs flag', 'python train.py epochs flag argument parser added'],
      ['python environment pinned to 3.12', 'python version pin environment virtualenv requirements'],
    ],
  },
  {
    name: 'cannot-find-module',
    cmd: 'npm run build',
    output: OUT.cannotFindModule,
    relevant: [
      [
        'A new lib module must be registered in SOURCE_FILES and package.json#files',
        'cannot find module observation-write source_files package.json files manifest missing registration',
      ],
      [
        'ERR_MODULE_NOT_FOUND after auto-update means a missing manifest entry',
        'module not found resolve filename auto-update manifest tarball',
      ],
    ],
    negative: [
      [
        'v3.66.0 released: npm publish and signed release green (dup topic)',
        'npm run build release publish signed tag',
      ],
    ],
  },
  {
    name: 'vitest-assertion',
    cmd: 'npx vitest run tests/scope-filter.test.mjs',
    output: OUT.vitestAssertion,
    relevant: [
      [
        'Tests that assert an empty result need a decoy row',
        'assertionerror expected received empty result decoy vacuous assertion test',
      ],
    ],
    negative: [['vitest upgraded to 4.1.6', 'vitest run upgrade version dependency bump']],
  },
  {
    name: 'type-error',
    cmd: 'node hook.mjs post-tool-use',
    output: OUT.typeError,
    relevant: [
      [
        'selectErrorRecall returns null when the gate closes — callers must check',
        'typeerror cannot read properties undefined rows null gate caller check',
      ],
    ],
    negative: [
      [
        'hook.mjs post-tool-use fast path skips low-value tools',
        'node hook post-tool-use prefilter skip tools bash',
      ],
    ],
  },
  {
    name: 'command-not-found',
    cmd: 'shellcheck scripts/setup.sh',
    output: OUT.commandNotFound,
    relevant: [
      [
        'shellcheck is not installed by default; doctor should report it',
        'command not found shellcheck install missing binary doctor check',
      ],
    ],
    negative: [['scripts/setup.sh gained a self-heal branch', 'scripts setup.sh self heal branch install']],
  },
  {
    name: 'go-panic',
    cmd: 'go run ./cmd/server',
    output: OUT.goPanic,
    relevant: [
      [
        'nil map assignment panics — initialise before write',
        'panic assignment entry nil map initialise make goroutine',
      ],
    ],
    negative: [['go run wrapper added to the Makefile', 'go run cmd server makefile wrapper target']],
  },
  // ── NO-GOOD-MATCH cases ──────────────────────────────────────────────────
  // Real failures for which the corpus holds NOTHING that explains them. This is the
  // common case in production — most failures have no matching memory — and the
  // fixture was blind to it until pre-release review showed a set-level floor scoring
  // identically at every threshold. With only well-served cases present, a gate whose
  // whole purpose is "stay silent when the best match is not about the failure" has
  // nothing to act on, and the suite reports it as a no-op lever.
  //
  // These cases still MATCH things — the command words pull in `negative` rows and the
  // OR query reaches filler — so at floor 0 the surface injects a full complement of
  // noise. Getting them to inject nothing is the win being measured.
  {
    name: 'no-match-cuda',
    cmd: 'python train.py --device cuda',
    output: [
      'Traceback (most recent call last):',
      '  File "train.py", line 88, in <module>',
      '    torch.cuda.init()',
      'RuntimeError: CUDA driver initialization failed',
    ].join('\n'),
    relevant: [],
    negative: [['train.py gained a --device flag', 'python train.py device flag argument parser']],
  },
  {
    name: 'no-match-registry-401',
    cmd: 'npm publish --access public',
    output: [
      'npm ERR! code E401',
      'npm ERR! 401 Unauthorized - PUT https://registry.npmjs.org/some-pkg',
    ].join('\n'),
    relevant: [],
    negative: [['npm publish runs from CI on tag push', 'npm publish access public release ci tag workflow']],
  },
];

// NOT in CASES, and each verified rather than assumed (2026-08-24):
//   Segmentation fault (core dumped)  isHardError=false
//   SqliteError: unable to open …     isHardError=false
//   npx eslint … `error` lines        isHardError=false
//   go test FAIL                      isHardError=false
// The first was written INTO the case list from memory and assertReachable threw on
// it — `core dumped` is in HARD_ERROR_RE's alternation, but the surrounding
// detectBashSignificance conditions still decline the shape, exactly as the 24-shape
// battery in #10737 recorded. Real failures the surface never sees are D#151's
// subject (trigger coverage), not this suite's (precision among what it does see).

/**
 * Refuse to score a case a real PostToolUse would never deliver (#10731).
 * @throws when the shape does not clear detectBashSignificance's isHardError.
 */
function assertReachable(c) {
  const sig = detectBashSignificance(c.cmd, c.output);
  if (!sig.isHardError) {
    throw new Error(
      `case "${c.name}" has isHardError=false — triggerErrorRecall is never called for it. ` +
        'Scoring it would measure a path that does not exist (see #10731). ' +
        'Trigger-面 coverage is D#151, a different lever.',
    );
  }
}

let seq = 0;
function insert(db, title, text, { ageDays = 3, project = PROJECT } = {}) {
  const ts = Date.now() - ageDays * DAY;
  return db
    .prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, text, narrative,
       created_at, created_at_epoch, lesson_learned, importance)
     VALUES ('m1', ?, 'bugfix', ?, ?, ?, ?, ?, ?, 2)`,
    )
    .run(project, title, text, text, new Date(ts).toISOString(), ts, `lesson ${++seq}`).lastInsertRowid;
}

/**
 * Filler so bm25's IDF term is not degenerate. Vocabulary is deliberately unrelated
 * to any case so filler rows cannot become accidental hits — they exist to raise N.
 */
function seedFiller(db, n) {
  const words = [
    'ledger',
    'quasar',
    'meridian',
    'basalt',
    'kestrel',
    'lumen',
    'tundra',
    'obsidian',
    'cadence',
    'zephyr',
    'granite',
    'harbor',
    'ivory',
    'juniper',
  ];
  const insertMany = db.transaction((count) => {
    for (let i = 0; i < count; i++) {
      const w = words[i % words.length];
      insert(db, `${w} note ${i}`, `${w} ${words[(i + 3) % words.length]} routine maintenance note ${i}`, {
        ageDays: 5 + (i % 60),
      });
    }
  });
  insertMany(n);
}

/** Build the fixture DB and record which ids are relevant / negative per case. */
export function seedSuite({ filler = 600 } = {}) {
  const db = new Database(':memory:');
  initSchema(db);
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
              VALUES ('s1','m1',?,datetime('now'),?,'active')`,
  ).run(PROJECT, Date.now());

  seedFiller(db, filler);

  const truth = new Map();
  for (const c of CASES) {
    assertReachable(c);
    const relevant = new Set(c.relevant.map(([t, x]) => insert(db, t, x)));
    const negative = new Set(c.negative.map(([t, x]) => insert(db, t, x)));
    truth.set(c.name, { relevant, negative });
  }
  return { db, truth };
}

/**
 * Score every case against the live selection core.
 * @param {object} opts forwarded to selectErrorRecall (e.g. a floor), so the same
 *   ruler measures before and after a lever without re-typing the query.
 */
export function runErrorRecallSuite({ filler = 600, selectOpts = {} } = {}) {
  const { db, truth } = seedSuite({ filler });
  const now = Date.now();
  const rows = [];
  let injTotal = 0;
  let relTotal = 0;
  let negTotal = 0;
  let injectingCases = 0;

  for (const c of CASES) {
    const sel = selectErrorRecall(db, {
      cmd: c.cmd,
      response: c.output,
      project: PROJECT,
      now,
      ...selectOpts,
    });
    const got = sel ? sel.rows.map((r) => r.id) : [];
    const t = truth.get(c.name);
    const rel = got.filter((id) => t.relevant.has(id)).length;
    const neg = got.filter((id) => t.negative.has(id)).length;
    const filler_ = got.length - rel - neg;
    // Count cases that actually INJECTED, which is what every downstream column is
    // about. The per-case `fired` field below records whether the GATE opened, and the
    // two diverge exactly when a floor suppresses a set — so they are named apart and
    // the summary column is labelled `inj-cases`, not `fired`.
    if (got.length) injectingCases++;
    injTotal += got.length;
    relTotal += rel;
    negTotal += neg;
    rows.push({
      case: c.name,
      fired: sel !== null,
      injected: got.length,
      relevant: rel,
      negative: neg,
      filler: filler_,
      relevantAvailable: t.relevant.size,
      precision: got.length ? rel / got.length : null,
      // Did the surface surface at least one row that explains the failure?
      hit: rel > 0,
    });
  }
  db.close();

  // Two populations, scored separately — averaging them hides both effects.
  //   servable   : the corpus contains a row that explains the failure. The question
  //                is "did we surface it?" → hit-rate. A floor must not move this.
  //   unservable : it does not. The question is "did we stay quiet?" → correct
  //                silence. A floor exists to move THIS number, and it is the number
  //                the fixture could not see before the no-match cases were added.
  const servable = rows.filter((r) => r.relevantAvailable > 0);
  const unservable = rows.filter((r) => r.relevantAvailable === 0);
  const hits = servable.filter((r) => r.hit).length;
  const silent = unservable.filter((r) => r.injected === 0).length;
  return {
    cases: rows,
    totals: {
      cases: CASES.length,
      injectingCases,
      gateOpenCases: rows.filter((r) => r.fired).length,
      injected: injTotal,
      relevant: relTotal,
      negative: negTotal,
      filler: injTotal - relTotal - negTotal,
      precision: injTotal ? relTotal / injTotal : 0,
      servable: servable.length,
      hitRate: servable.length ? hits / servable.length : 0,
      unservable: unservable.length,
      correctSilence: unservable.length ? silent / unservable.length : 0,
      // Rows injected into cases where nothing could have been relevant — pure waste,
      // and the quantity a set-level gate is supposed to drive to zero.
      wastedRows: unservable.reduce((a, r) => a + r.injected, 0),
      limit: ERROR_RECALL_LIMIT,
    },
  };
}

function pct(x) {
  return x === null ? '   —  ' : `${(x * 100).toFixed(1)}%`.padStart(6);
}

/**
 * Score-distribution probe for calibrating a floor — the same shape of measurement
 * that set the UPS face's OR_TOP_BM25_FLOOR (an 11-prompt probe found real signal at
 * |bm25| ≥ 41 and broad noise ≤ 22, and 30 was chosen in the gap). Runs with a WIDE
 * limit so the distribution is visible rather than truncated at the injection cap.
 */
export function probeScores({ filler = 600, limit = 12 } = {}) {
  const { db, truth } = seedSuite({ filler });
  const now = Date.now();
  const byClass = { relevant: [], negative: [], filler: [] };
  let appliedFloor = null;
  for (const c of CASES) {
    const sel = selectErrorRecall(db, {
      // floor: 0 is REQUIRED, not incidental. This is a distribution probe of the
      // quantity the floor gates; inheriting the shipped default would measure only
      // the rows that already survived the gate being calibrated, and the filler
      // class — the one the floor exists to remove — would report its post-filter
      // remnant (n=4, min 10.69) as if it were the population (n=19, min 8.33).
      // Caught in pre-release review; the calibration table in error-recall-core's
      // docblock was, for a while, not reproducible from the shipped tool.
      cmd: c.cmd,
      response: c.output,
      project: PROJECT,
      now,
      limit,
      floor: 0,
    });
    if (!sel) continue;
    // Record what the gate actually used, so the caller can assert it structurally
    // rather than inferring contamination from the shape of the distribution.
    appliedFloor = sel.floor;
    const t = truth.get(c.name);
    for (const r of sel.rows) {
      const cls = t.relevant.has(r.id) ? 'relevant' : t.negative.has(r.id) ? 'negative' : 'filler';
      byClass[cls].push(Math.abs(r.bm25_raw));
    }
  }
  db.close();
  const stat = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, min: s[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: s[s.length - 1] };
  };
  return {
    relevant: stat(byClass.relevant),
    negative: stat(byClass.negative),
    filler: stat(byClass.filler),
    appliedFloor,
  };
}

function main() {
  const json = process.argv.includes('--json');

  if (process.argv.includes('--scores')) {
    const d = probeScores();
    // STRUCTURAL self-check, not a statistical one. The first version tested whether the
    // lowest observed |bm25| fell below the calibrated floor — sound reasoning for a
    // PER-ROW gate, useless for the SET-LEVEL gate that shipped: a set-level drop removes
    // whole cases and never raises a surviving class's minimum, so a contaminated probe
    // can mangle every class (measured: filler n 30→21, negative n 11→6 with min 10.59→
    // 23.11) while that check stays silent. Asserting the floor the probe ACTUALLY
    // applied cannot be fooled that way.
    if (d.appliedFloor !== 0) {
      console.error(
        `\n  ✗ PROBE CONTAMINATED: probeScores ran with floor=${d.appliedFloor}, not 0.` +
          '\n    It is characterising rows that already survived the gate being calibrated.\n',
      );
      process.exitCode = 1;
    }
    console.log('\n─── |bm25_raw| distribution by ground-truth class (limit 12) ───');
    console.log('class       n    min    p25    med    p75    max');
    for (const [k, s] of Object.entries(d)) {
      if (k === 'appliedFloor') continue;
      if (!s) {
        console.log(k.padEnd(10), '   0      —');
        continue;
      }
      console.log(
        k.padEnd(10),
        String(s.n).padStart(3),
        ...[s.min, s.p25, s.median, s.p75, s.max].map((x) => x.toFixed(2).padStart(6)),
      );
    }
    console.log('\n  A floor is worth having only if relevant sits ABOVE negative/filler.');
    console.log('  Overlapping ranges ⇒ this quantity does not separate them; say so rather');
    console.log('  than picking a number that splits the difference.\n');
    return;
  }

  if (process.argv.includes('--sweep')) {
    // Calibration must look at the floor's effect ON WHAT IS ACTUALLY INJECTED (top
    // ERROR_RECALL_LIMIT rows), not on the wider score distribution: the weak rows a
    // floor is aimed at mostly fail to reach the cap anyway, so the distribution
    // overstates the achievable gain. This sweep measures the real curve.
    console.log('\n─── floor sweep (effect on injected rows, not on the distribution) ───');
    console.log(' floor   inj   rel   neg  filler   P@inj  hit-rate  silence  waste');
    for (const f of [0, 5, 8, 9, 10, 10.5, 11, 11.2, 12, 15, 20, 25]) {
      const t = runErrorRecallSuite({ selectOpts: { floor: f } }).totals;
      console.log(
        String(f).padStart(6),
        String(t.injected).padStart(5),
        String(t.relevant).padStart(5),
        String(t.negative).padStart(5),
        String(t.filler).padStart(6),
        pct(t.precision),
        pct(t.hitRate),
        pct(t.correctSilence),
        String(t.wastedRows).padStart(6),
      );
    }
    console.log('\n  Pick the largest floor that holds hit-rate; report the recall cost if any.\n');
    return;
  }

  if (process.argv.includes('--compare')) {
    // floor 0 is the exact pre-floor statement (pinned by tests/error-recall-core),
    // so this is a true before/after on one fixture rather than two code paths.
    // Compare OFF against the CALIBRATED value, not against the shipped default —
    // the default is 0, so comparing against it would print two identical rows.
    const before = runErrorRecallSuite({ selectOpts: { floor: 0 } });
    const after = runErrorRecallSuite({ selectOpts: { floor: CALIBRATED_ERROR_RECALL_BM25_FLOOR } });
    const row = (label, t) =>
      console.log(
        label.padEnd(10),
        String(t.injectingCases).padStart(5),
        String(t.injected).padStart(5),
        String(t.relevant).padStart(5),
        String(t.negative).padStart(5),
        String(t.filler).padStart(6),
        pct(t.precision),
        pct(t.hitRate),
      );
    console.log(
      `\n─── error-recall: floor OFF vs ${CALIBRATED_ERROR_RECALL_BM25_FLOOR} (calibrated; shipped default is OFF) ───`,
    );
    console.log('       inj-cases   inj   rel   neg  filler  P@inj hit-rate');
    row('before', before.totals);
    row('after', after.totals);
    const b = before.totals;
    const a = after.totals;
    console.log(`\n  injected  ${b.injected} → ${a.injected} (${a.injected - b.injected})`);
    console.log(
      `  filler    ${b.filler} → ${a.filler} (${a.filler - b.filler})  ← true off-topic false positives`,
    );
    console.log(
      `  negative  ${b.negative} → ${a.negative} (${a.negative - b.negative})  ← topical-but-unrequested (#8858: NOT this lever's target)`,
    );
    console.log(
      `  relevant  ${b.relevant} → ${a.relevant} (${a.relevant - b.relevant})  ← recall cost, must be reported even at 0`,
    );
    console.log(`  precision ${(b.precision * 100).toFixed(1)}% → ${(a.precision * 100).toFixed(1)}%`);
    console.log(`  hit-rate  ${(b.hitRate * 100).toFixed(1)}% → ${(a.hitRate * 100).toFixed(1)}%`);
    if (a.injected === b.injected) {
      // Do not let "no change here" be read as "no cost anywhere". Measured on the
      // maintainer's live DB at this same threshold: 201 → 126 injected rows (−37%)
      // and 27 of 69 firing cases silenced (39%). The fixture cannot show that — its
      // hard negatives are constructed to score above the floor, so every case has a
      // qualifying top row, while real small projects often have none.
      console.log('\n  ⚠ No fixture movement at this floor. That is a property of THIS');
      console.log('    fixture, not of the lever: its hard negatives all score above the');
      console.log('    floor. On the live DB the same threshold cuts injections ~37% and');
      console.log('    silences ~39% of firings. Do not read a flat row here as "free".');
    }
    console.log('');
    return;
  }

  const res = runErrorRecallSuite();
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  console.log('\n─── error-recall calibration suite ───');
  console.log('case                 fired  inj  rel  neg  fill   P@inj');
  for (const r of res.cases) {
    console.log(
      r.case.padEnd(20),
      String(r.fired).padStart(5),
      String(r.injected).padStart(4),
      String(r.relevant).padStart(4),
      String(r.negative).padStart(4),
      String(r.filler).padStart(5),
      pct(r.precision),
    );
  }
  const t = res.totals;
  console.log('─'.repeat(58));
  console.log(
    'TOTAL'.padEnd(20),
    String(t.injectingCases).padStart(5),
    String(t.injected).padStart(4),
    String(t.relevant).padStart(4),
    String(t.negative).padStart(4),
    String(t.filler).padStart(5),
    pct(t.precision),
  );
  console.log(
    `\n  precision = relevant ÷ injected = ${t.relevant}/${t.injected} = ${(t.precision * 100).toFixed(1)}%`,
  );
  console.log(`  hit-rate  = cases with ≥1 explaining row = ${(t.hitRate * 100).toFixed(1)}%`);
  console.log('  A lever that raises precision while holding hit-rate is a win; one that');
  console.log('  raises precision by dropping hit-rate is trading recall for it — say so.\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
