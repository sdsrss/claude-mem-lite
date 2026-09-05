// lib/error-recall-core.mjs — extraction of the error-recall SELECT out of hook.mjs.
//
// This is a REFACTOR, so the evidence owed is "behaviour did not move". The first
// test proves it the way P2-10 proved the TYPE_QUALITY extraction: run the
// pre-extraction SQL, kept here verbatim, and the extracted builder side by side on
// ONE database and assert the same rows come back in the same order. A prose claim
// that the string "looks the same" is not that proof.
//
// The fixture is built out of DECOYS on purpose. Every guard clause in the statement
// (live-row filter, low-signal title filter, project scoping) gets a row that it and
// only it excludes, and `guards are not vacuous` asserts each decoy is actually
// missing from the result. Without those rows the clauses are unreachable and the
// equivalence assertion would still pass after they were deleted — the vacuous-guard
// shape this project has shipped more than once.
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initSchema } from '../schema.mjs';
import { planErrorRecall } from '../bash-utils.mjs';
import { OBS_BM25, notLowSignalTitleClause } from '../scoring-sql.mjs';
import { liveObsFilterSql, recencyDecaySql } from '../lib/inject-search-core.mjs';
import { corpusFloorScale } from '../lib/relevance-floor.mjs';
import {
  selectErrorRecall,
  errorRecallSql,
  errorRecallFtsQuery,
  ERROR_RECALL_LIMIT,
  errorRecallBm25Floor,
  DEFAULT_ERROR_RECALL_BM25_FLOOR,
  CALIBRATED_ERROR_RECALL_BM25_FLOOR,
} from '../lib/error-recall-core.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'p-main';

/** Run `fn` with the D#167 rerank kill-switch set (and restored afterwards). */
function withRerank(value, fn) {
  const KEY = 'CLAUDE_MEM_ERROR_RECALL_RERANK';
  const saved = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  }
}

// npm's real ENOENT output — the shape D#136 was built around, reused here so the
// query under test is the one a real failure produces, not a hand-written MATCH.
const NPM_ENOENT_OUT = [
  'npm ERR! code ENOENT',
  'npm ERR! syscall open',
  'npm ERR! path /x/package.json',
  'npm ERR! errno -2',
  "npm ERR! enoent ENOENT: no such file or directory, open '/x/package.json'",
].join('\n');

// The statement exactly as it read inside hook.mjs::triggerErrorRecall before the
// extraction. Kept verbatim — this is the control, so it must NOT be refactored to
// share anything with the builder it is checking.
const PRE_EXTRACTION_SQL = `
      SELECT o.id, o.type, o.title, o.lesson_learned
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.project = ?
        AND ${liveObsFilterSql('o')}
        AND ${notLowSignalTitleClause('o')}
      ORDER BY ${OBS_BM25}
        * ${recencyDecaySql({ tsExpr: 'o.created_at_epoch', halfLifeSql: '1209600000.0' })}
      LIMIT 3
    `;

const DAY = 86400000;

const SESSION_INSERT_SQL = `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
              VALUES ('s1','m1',?,datetime('now'),?,'active')`;

function insertObs(db, { title, text, project = PROJECT, ageDays = 1, type = 'bugfix', extra = {} }) {
  const ts = Date.now() - ageDays * DAY;
  const cols = {
    memory_session_id: 'm1',
    project,
    type,
    title,
    text,
    created_at: new Date(ts).toISOString(),
    created_at_epoch: ts,
    lesson_learned: `lesson for ${title}`,
    importance: 2,
    ...extra,
  };
  const keys = Object.keys(cols);
  const stmt = db.prepare(
    `INSERT INTO observations (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
  );
  return stmt.run(...keys.map((k) => cols[k])).lastInsertRowid;
}

/**
 * Seed one DB with real hits plus one decoy per guard clause.
 * @returns {{db: object, decoys: Record<string, number>}}
 */
function seed() {
  const db = new Database(':memory:');
  initSchema(db);
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
              VALUES ('s1','m1',?,datetime('now'),?,'active')`,
  ).run(PROJECT, Date.now());

  // Background rows with DISJOINT vocabulary. Without them every row in the fixture
  // shares the query's terms, so df = N, FTS5's IDF collapses to 0 and EVERY row
  // scores exactly 0.00 — a fixture on which any floor above zero removes everything
  // and any floor test is measuring degeneracy rather than ranking. Real corpora are
  // not this shape; a 5-row all-same-topic fixture is.
  for (let i = 0; i < 40; i++) {
    insertObs(db, {
      title: `quasar ledger note ${i}`,
      text: `quasar meridian basalt kestrel routine ${i}`,
      ageDays: 5 + i,
    });
  }

  // Real, live, in-project hits at different ages so BM25 × decay has to order them.
  for (let i = 0; i < 5; i++) {
    insertObs(db, {
      title: `ENOENT on package.json open ${i}`,
      text: `enoent module resolution failed npm build path ${i}`,
      ageDays: 1 + i * 7,
    });
  }

  // A near-tie pair, so the ORDER depends on the DECAY HALF-LIFE and not only on bm25.
  // Without it the equivalence control cannot see the half-life at all: review showed
  // that collapsing ERROR_RECALL_HALF_LIFE_MS from 14 days to 1 millisecond — i.e.
  // deleting recency ranking outright — left the whole suite green, because every
  // fixture row happened to rank the same way under any shorter half-life. These two
  // carry identical text (identical bm25) and differ only in age, so any change to the
  // half-life that reorders 3-day-old against 40-day-old flips their order here.
  insertObs(db, {
    title: 'ENOENT tie-break recent',
    text: 'enoent module resolution failed npm build path tie',
    ageDays: 3,
  });
  insertObs(db, {
    title: 'ENOENT tie-break older',
    text: 'enoent module resolution failed npm build path tie',
    ageDays: 40,
  });

  const decoys = {
    // D#167: a row that shares ONLY the COMMAND's vocabulary (npm / run / build) and
    // says nothing about the failure — no enoent, no code, no syscall. Recent enough
    // that recency decay floats it to the top of the flat OR, which is precisely the
    // shape measured on the live DB: 39.2% of injected rows and 42.3% of TOP-1 rows
    // matched no error term at all.
    //
    // Its presence is what makes the rerank VISIBLE here. Without it every fixture row
    // matched an error term, the reranked and flat orders coincided, and the suite
    // reported the shipped default as a no-op — the same "fixture cannot see the lever"
    // failure that let a floor be calibrated against a ruler it had already contaminated.
    cmdOnly: insertObs(db, {
      title: 'npm build pipeline retuned for the run step',
      text: 'npm run build npm build run npm build pipeline cadence notes',
      ageDays: 0.05,
    }),
    // liveObsFilterSql: superseded row
    superseded: insertObs(db, {
      title: 'ENOENT superseded decoy',
      text: 'enoent module npm build',
      extra: { superseded_at: Date.now(), superseded_by: 1 },
    }),
    // liveObsFilterSql: compressed row
    compressed: insertObs(db, {
      title: 'ENOENT compressed decoy',
      text: 'enoent module npm build',
      extra: { compressed_into: 1 },
    }),
    // notLowSignalTitleClause: degraded title AND no lesson. The lesson matters:
    // this surface uses the lessonEscape:true variant, so a LOW_SIGNAL title that
    // carries a real lesson_learned is admitted BY DESIGN. A decoy with a lesson
    // would be excluded by nothing and this assertion would fail against correct
    // code — as the first version of this fixture did.
    lowSignal: insertObs(db, {
      title: 'Modified package.json',
      text: 'enoent module npm build',
      extra: { lesson_learned: null },
    }),
    // The escape itself, asserted below so the clause is pinned in BOTH directions.
    lowSignalWithLesson: insertObs(db, {
      title: 'Modified lockfile after enoent',
      text: 'enoent module npm build',
    }),
    // project scoping
    otherProject: insertObs(db, {
      title: 'ENOENT in another project',
      text: 'enoent module npm build',
      project: 'p-other',
    }),
  };
  return { db, decoys };
}

describe('error-recall core — extraction equivalence', () => {
  it('extracted builder returns the same rows, in the same order, as the pre-extraction SQL', () => {
    const { db } = seed();
    const plan = planErrorRecall('npm run build', NPM_ENOENT_OUT);
    expect(plan, 'the npm ENOENT shape must clear the gate — otherwise this test is vacuous').toBeTruthy();

    const fts = errorRecallFtsQuery(plan.terms);
    const now = Date.now();
    const control = db.prepare(PRE_EXTRACTION_SQL).all(fts, PROJECT, now);
    // floor 0 = the pre-floor statement, which is what makes this a fair control.
    const extracted = db.prepare(errorRecallSql()).all({ q: fts, project: PROJECT, now });

    expect(control.length, 'control must return rows, else equivalence is trivially true').toBeGreaterThan(0);

    // ROW SELECTION AND ORDER are the behaviour, and they must be identical.
    expect(extracted.map((r) => r.id)).toEqual(control.map((r) => r.id));
    // Every column the pre-extraction statement returned must still carry the same
    // value — compared field-by-field rather than by deep-equal on the whole row,
    // because the builder additionally exposes bm25_raw (added for the relevance
    // floor). A deep-equal here would fail on the extra key and say nothing about
    // whether the shared columns drifted.
    for (const key of Object.keys(control[0])) {
      expect(
        extracted.map((r) => r[key]),
        `column ${key} drifted`,
      ).toEqual(control.map((r) => r[key]));
    }
  });

  it('exposes undecayed bm25_raw for the relevance floor to gate on', () => {
    const { db } = seed();
    const plan = planErrorRecall('npm run build', NPM_ENOENT_OUT);
    const rows = db
      .prepare(errorRecallSql())
      .all({ q: errorRecallFtsQuery(plan.terms), project: PROJECT, now: Date.now() });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Number.isFinite(r.bm25_raw), `bm25_raw=${r.bm25_raw}`).toBe(true);
    // FTS5 bm25() is negative-better; the floor compares magnitudes, so a sign flip
    // here would invert every floor comparison downstream.
    expect(
      rows.every((r) => r.bm25_raw <= 0),
      'bm25 is expected negative-better',
    ).toBe(true);
  });

  it('guards are not vacuous — every decoy class is actually excluded', () => {
    const { db, decoys } = seed();
    const plan = planErrorRecall('npm run build', NPM_ENOENT_OUT);
    const rows = db
      .prepare(errorRecallSql(50))
      .all({ q: errorRecallFtsQuery(plan.terms), project: PROJECT, now: Date.now() });
    const ids = new Set(rows.map((r) => r.id));

    // Each decoy shares the query terms, so its absence can only come from its guard.
    expect(ids.has(decoys.superseded), 'superseded row leaked into an injection surface').toBe(false);
    expect(ids.has(decoys.compressed), 'compressed row leaked — its mem_get pointer would dangle').toBe(
      false,
    );
    expect(ids.has(decoys.lowSignal), 'low-signal title without a lesson leaked').toBe(false);
    expect(ids.has(decoys.otherProject), 'cross-project row leaked').toBe(false);
    // Opposite direction: the lessonEscape is real, not an accident of the fixture.
    // Without this, tightening the clause to title-only would pass unnoticed.
    expect(
      ids.has(decoys.lowSignalWithLesson),
      'lessonEscape must admit a LOW_SIGNAL title that carries a real lesson',
    ).toBe(true);
    expect(rows.length, 'the live in-project rows must still be reachable').toBeGreaterThan(0);
  });

  it('honours the row cap and defaults it to the historical LIMIT 3', () => {
    const { db } = seed();
    const plan = planErrorRecall('npm run build', NPM_ENOENT_OUT);
    const fts = errorRecallFtsQuery(plan.terms);
    expect(ERROR_RECALL_LIMIT).toBe(3);
    expect(
      db.prepare(errorRecallSql()).all({ q: fts, project: PROJECT, now: Date.now() }).length,
    ).toBeLessThanOrEqual(3);
    expect(db.prepare(errorRecallSql(1)).all({ q: fts, project: PROJECT, now: Date.now() }).length).toBe(1);
  });

  it('no non-numeric or non-finite limit can reach the SQL text', () => {
    // The cap is interpolated, not bound, so coercion is the guard.
    expect(errorRecallSql('3; DROP TABLE observations')).toContain('LIMIT 3');
    expect(errorRecallSql('3; DROP TABLE observations')).not.toContain('DROP');
    // Everything unusable falls back to the default rather than producing an empty
    // result or an unpreparable statement. Infinity is the one a review found: it is
    // a NUMBER, truncates to itself, and `LIMIT Infinity` throws at prepare().
    for (const bad of [0, NaN, Infinity, -Infinity, '1e400', null, undefined, {}, '']) {
      expect(errorRecallSql(bad), `limit=${String(bad)}`).toContain(`LIMIT ${ERROR_RECALL_LIMIT}`);
    }
    expect(errorRecallSql(-5)).toContain(`LIMIT ${ERROR_RECALL_LIMIT}`);
    // And every one of them must still PREPARE — the point of the fallback.
    const { db } = seed();
    for (const bad of [Infinity, '1e400', NaN]) {
      expect(() => db.prepare(errorRecallSql(bad)), `limit=${String(bad)}`).not.toThrow();
    }
  });
});

describe('error-recall core — gate', () => {
  it('returns null (do not inject) when no error term survives', () => {
    const { db } = seed();
    // Output whose only error-ish tokens are stop words → planErrorRecall gates.
    const out = selectErrorRecall(db, {
      cmd: 'npm run build',
      response: 'Error: it failed',
      project: PROJECT,
    });
    expect(planErrorRecall('npm run build', 'Error: it failed')).toBeNull();
    expect(out).toBeNull();
  });

  it('selects rows through the same statement when the gate opens', () => {
    const { db } = seed();
    const out = selectErrorRecall(db, { cmd: 'npm run build', response: NPM_ENOENT_OUT, project: PROJECT });
    expect(out).toBeTruthy();
    expect(out.rows.length).toBeGreaterThan(0);
    expect(out.terms).toEqual(planErrorRecall('npm run build', NPM_ENOENT_OUT).terms);
  });
});

describe('error-recall core — relevance floor (SET-LEVEL, default OFF)', () => {
  const FLOOR_ENV = 'CLAUDE_MEM_ERROR_RECALL_BM25_MIN';
  const withEnv = (v, fn) => {
    const saved = process.env[FLOOR_ENV];
    if (v === undefined) delete process.env[FLOOR_ENV];
    else process.env[FLOOR_ENV] = v;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env[FLOOR_ENV];
      else process.env[FLOOR_ENV] = saved;
    }
  };
  const select = (db, extra = {}) =>
    selectErrorRecall(db, {
      cmd: 'npm run build',
      response: NPM_ENOENT_OUT,
      project: PROJECT,
      ...extra,
    });
  const controlRows = (db, now) =>
    db
      .prepare(PRE_EXTRACTION_SQL)
      .all(errorRecallFtsQuery(planErrorRecall('npm run build', NPM_ENOENT_OUT).terms), PROJECT, now);

  it('is OFF by default — nothing is suppressed, and with the rerank off the statement is the pre-floor one', () => {
    // 0 is a measured decision, not an oversight (see the core docblock: the per-row
    // form cost 49% of injections on the live DB for a fixture gain of +3.3pp, and the
    // set-level form is a no-op at any safe threshold). This case pins the decision, so
    // a future edit that quietly enables the floor has to change it deliberately.
    expect(DEFAULT_ERROR_RECALL_BM25_FLOOR).toBe(0);
    const { db } = seed();
    const now = Date.now();
    const out = withEnv(undefined, () => select(db, { now }));
    expect(out.floor, 'default must reach the gate as 0').toBe(0);
    expect(out.suppressed).toBe(0);
    // The control is the FLAT-OR statement, so the comparison has to hold the OTHER
    // lever still. The shipped default also reranks (D#167), which reorders this
    // fixture on purpose — comparing the reranked output to a flat-OR control would
    // make this case fail for a reason that has nothing to do with the floor.
    const flat = withRerank('off', () => withEnv(undefined, () => select(db, { now })));
    expect(flat.rows.map((r) => r.id)).toEqual(controlRows(db, now).map((r) => r.id));
  });

  it('when enabled, drops the WHOLE set if the best row is below the floor', () => {
    const { db } = seed();
    const now = Date.now();
    const all = select(db, { now, floor: 0 });
    expect(all.rows.length, 'need rows for this to mean anything').toBeGreaterThan(0);
    const topMag = Math.abs(all.rows[0].bm25_raw);

    // The configured value is scaled by corpus size before it is applied, and this
    // fixture sits below FLOOR_REF_CORPUS — so a floor of topMag+1 would arrive
    // SMALLER than topMag and the gate would not fire. Undo the ramp when choosing the
    // input, or the case silently tests nothing (it did, on the first attempt).
    const scale = corpusFloorScale(db);
    expect(scale, 'ramp must be active here, else this case is not exercising it').toBeLessThan(1);
    const out = select(db, { now, floor: (topMag + 1) / scale });
    expect(out.floor, 'the applied floor must exceed the best row').toBeGreaterThan(topMag);
    expect(out.rows, 'set-level: no partial result').toEqual([]);
    expect(out.suppressed, 'and it reports how many rows it suppressed').toBe(all.rows.length);
  });

  it('when enabled and the best row clears the floor, it keeps the WEAKER rows too', () => {
    // This is the whole difference from a per-row floor, and the reason for this shape:
    // rows 2..n are never judged on their own. Measured on the live DB, a per-row floor
    // cut injections 49% and silenced 31% of firings, concentrated in small projects;
    // this form only ever removes a set whose BEST row is off-topic.
    const { db } = seed();
    const now = Date.now();
    const all = select(db, { now, floor: 0 });
    const mags = all.rows.map((r) => Math.abs(r.bm25_raw));
    const top = mags[0];
    const weakest = Math.min(...mags);
    expect(weakest, 'fixture must contain a row weaker than the top one, else this is vacuous').toBeLessThan(
      top,
    );

    // A floor between the weakest and the top row: per-row would drop the weak rows,
    // set-level keeps every one of them.
    //
    // DESCALE THE INPUT. selectErrorRecall multiplies the argument by
    // corpusFloorScale(db), and this fixture sits far below FLOOR_REF_CORPUS (scale
    // ~0.59), so passing the raw midpoint applies a floor BELOW even the weakest row —
    // at which point per-row and set-level behave identically and the case proves
    // nothing. Round 2 of review caught exactly that: both a per-row revert and a
    // read-the-last-row mutation survived the entire 4929-case suite. The sibling case
    // above already compensated for this ramp; this one did not.
    const scale = corpusFloorScale(db);
    expect(scale, 'ramp must be active here, else the descaling below is untested').toBeLessThan(1);
    const between = (weakest + top) / 2 / scale;
    const out = select(db, { now, floor: between });
    expect(out.floor, 'applied floor must land between the weakest and the top row').toBeGreaterThan(weakest);
    expect(out.floor).toBeLessThan(top);

    expect(out.rows.map((r) => r.id)).toEqual(all.rows.map((r) => r.id));
    // Compare against the APPLIED floor, not the argument — the argument is pre-ramp.
    expect(
      out.rows.some((r) => Math.abs(r.bm25_raw) < out.floor),
      'a sub-floor row must have survived, or this does not distinguish the two shapes',
    ).toBe(true);
  });

  it('floor 0 is an EXACT revert to the pre-floor statement, not an approximate one', () => {
    const { db } = seed();
    const now = Date.now();
    // Rerank held off for the same reason as the case above: this asserts what the FLOOR
    // does, and the control it compares against is the pre-floor FLAT statement.
    const reverted = withRerank('off', () => withEnv('0', () => select(db, { now })));
    expect(reverted.floor).toBe(0);
    expect(reverted.rows.map((r) => r.id)).toEqual(controlRows(db, now).map((r) => r.id));
  });

  it('reads the env at call time, and junk does not silently change the setting', () => {
    expect(withEnv(undefined, () => errorRecallBm25Floor())).toBe(DEFAULT_ERROR_RECALL_BM25_FLOOR);
    expect(withEnv('', () => errorRecallBm25Floor())).toBe(DEFAULT_ERROR_RECALL_BM25_FLOOR);
    expect(withEnv('0', () => errorRecallBm25Floor())).toBe(0);
    expect(withEnv('10.5', () => errorRecallBm25Floor())).toBe(CALIBRATED_ERROR_RECALL_BM25_FLOOR);
    expect(withEnv('7.25', () => errorRecallBm25Floor())).toBe(7.25);
    expect(withEnv('abc', () => errorRecallBm25Floor())).toBe(DEFAULT_ERROR_RECALL_BM25_FLOOR);
    expect(withEnv('-3', () => errorRecallBm25Floor())).toBe(DEFAULT_ERROR_RECALL_BM25_FLOOR);
  });

  it('a null/NaN floor argument means "unspecified", not "disabled"', () => {
    // The env reader rejects junk; the programmatic path must agree, or a caller
    // passing a stray null silently turns the gate off while looking enabled.
    const { db } = seed();
    const now = Date.now();
    for (const junk of [null, NaN, '', 'abc', -1]) {
      const out = withEnv('10.5', () => select(db, { now, floor: junk }));
      expect(
        out.floor,
        'junk floor must fall back to the configured value, got ' + out.floor,
      ).toBeGreaterThan(0);
    }
    // An explicit 0 IS honoured — that is the documented off switch.
    expect(withEnv('10.5', () => select(db, { now, floor: 0 })).floor).toBe(0);
  });

  it('scales an enabled floor down on a small corpus so a fresh install is not silenced', () => {
    // v3.61.0's failure mode: an unscaled absolute floor injected 0/8 on a first-day
    // corpus. Reachable only when the floor is switched on.
    const db = new Database(':memory:');
    initSchema(db);
    db.prepare(SESSION_INSERT_SQL).run(PROJECT, Date.now());
    insertObs(db, {
      title: 'ENOENT on package.json means the cwd is wrong',
      text: 'enoent package.json open syscall npm build wrong directory',
    });
    const out = withEnv('10.5', () => select(db));
    expect(out, 'gate must open').toBeTruthy();
    expect(out.floor, 'floor must be scaled below its configured value on a tiny corpus').toBeLessThan(
      CALIBRATED_ERROR_RECALL_BM25_FLOOR,
    );
    expect(out.rows.length, 'a fresh install must not be silenced by the floor').toBeGreaterThan(0);
  });
});

describe('error-recall core — wiring', () => {
  it('hook.mjs injects from the core instead of re-inlining the SELECT', () => {
    const src = readFileSync(join(REPO, 'hook.mjs'), 'utf8');
    expect(src, 'hook.mjs must import the shared core').toMatch(/error-recall-core\.mjs/);
    expect(src, 'hook.mjs must call it').toMatch(/selectErrorRecall\(/);

    // ARGUMENTS, not just the call. A source-grep for the call name is blind to every
    // argument regression — review demonstrated that adding `floor: 0` at this call
    // site left the entire 4900-case suite green while making the feature inert. The
    // hook must pass NEITHER floor nor limit, so both stay governed by the module
    // default and the env var rather than by a literal frozen into the caller.
    const call = src.match(/selectErrorRecall\(db,\s*\{[\s\S]*?\}\);/);
    expect(call, 'could not locate the call site to inspect its arguments').toBeTruthy();
    expect(call[0], 'hook must not pin a floor — that would bypass the env switch').not.toMatch(
      /\bfloor\s*:/,
    );
    expect(call[0], 'hook must not pin a limit — ERROR_RECALL_LIMIT is the contract').not.toMatch(
      /\blimit\s*:/,
    );
    // The re-inlining regression this guard exists to catch: the FROM/JOIN pair of
    // this surface's statement reappearing inside hook.mjs.
    expect(src).not.toMatch(
      /FROM\s+observations_fts\s*\n\s*JOIN\s+observations\s+o\s+ON\s+observations_fts\.rowid/,
    );
  });
});

// D#167. The flat OR admits a row on ANY term, so a memory that shares only the
// COMMAND's words competes for the three slots with one that names the failure. On the
// live DB — 52 real failing commands from 1110 transcripts x 15 projects, ~715 firing
// cases — 39.2% of injected rows and 42.3% of TOP-1 rows matched no error term at all;
// with the rerank on, 22.4% and 21.5%.
//
// Every case below is written against `decoys.cmdOnly`, the fixture row that carries
// npm/run/build and nothing from the failure. That row is the reason this block can see
// anything: before it existed, the reranked and flat orders coincided on this fixture
// and the whole feature measured as a no-op.
describe('error-recall core — error-first rerank (D#167, default ON)', () => {
  const select = (db, extra = {}) =>
    selectErrorRecall(db, {
      cmd: 'npm run build',
      response: NPM_ENOENT_OUT,
      project: PROJECT,
      floor: 0,
      ...extra,
    });
  const matchesAnErrorTerm = (db, id) => {
    const plan = planErrorRecall('npm run build', NPM_ENOENT_OUT);
    return plan.errWords.some((t) =>
      db
        .prepare('SELECT 1 ok FROM observations WHERE id = ? AND (lower(title) LIKE ? OR lower(text) LIKE ?)')
        .get(id, `%${t}%`, `%${t}%`),
    );
  };

  it('the fixture can SEE the rerank — flat OR puts a command-only row first', () => {
    // Precondition, not decoration. If the flat order already led with an
    // error-matching row, every assertion below would pass against a rerank that does
    // nothing at all.
    const { db, decoys } = seed();
    const now = Date.now();
    const flat = withRerank('off', () => select(db, { now }));
    expect(flat.rows[0].id, 'flat OR must lead with the command-only decoy').toBe(decoys.cmdOnly);
    expect(
      matchesAnErrorTerm(db, decoys.cmdOnly),
      'the decoy must genuinely carry no error term, or it is not a decoy',
    ).toBeFalsy();
  });

  it('demotes the command-only row out of the lead', () => {
    const { db, decoys } = seed();
    const now = Date.now();
    const out = select(db, { now });
    expect(out.rows[0].id, 'command-only row must not lead once the rerank is on').not.toBe(decoys.cmdOnly);
    expect(
      matchesAnErrorTerm(db, out.rows[0].id),
      'the new lead must actually mention the failure',
    ).toBeTruthy();
  });

  it('tops up a SHORT primary without duplicating it', () => {
    // The branch the case below cannot see. Measured during review: across the whole
    // fixture, 21 of 23 selections have `primary.length === limit`, so the top-up never
    // runs and a length assertion holds with or without it. This shape forces
    // `0 < primary < limit`: exactly ONE row mentions the failure, the rest share only
    // the command's words.
    //
    // The id-uniqueness assertion is the point. The error-first match set is a SUBSET of
    // the flat one, so every primary row appears AGAIN in the fallback; dropping the
    // dedup injects the top row twice and wastes a slot. Review's mutant produced
    // ids 1,1,2 where the fix gives 1,2,3 — a length check cannot tell them apart.
    const db = new Database(':memory:');
    initSchema(db);
    db.prepare(SESSION_INSERT_SQL).run(PROJECT, Date.now());
    for (let i = 0; i < 30; i++) {
      insertObs(db, { title: `quasar ledger ${i}`, text: `meridian basalt kestrel ${i}`, ageDays: 9 + i });
    }
    const only = insertObs(db, {
      title: 'ENOENT on package.json means the cwd is wrong',
      text: 'enoent syscall open package.json npm build path',
      ageDays: 6,
    });
    for (let i = 0; i < 3; i++) {
      insertObs(db, {
        title: `npm build pipeline note ${i}`,
        text: 'npm run build npm build run pipeline cadence',
        ageDays: 0.1 + i,
      });
    }
    const now = Date.now();
    const out = select(db, { now });
    const flat = withRerank('off', () => select(db, { now }));

    const ids = out.rows.map((r) => r.id);
    expect(ids.length, 'precondition: the cap must actually bite here').toBe(ERROR_RECALL_LIMIT);
    expect(new Set(ids).size, `a row was injected twice: ${ids}`).toBe(ids.length);
    expect(ids[0], 'the single error-matching row must lead').toBe(only);
    expect(ids.length).toBe(flat.rows.length);
    // And the top-up really did run — i.e. this case exercises the branch it names.
    expect(ids.slice(1).length, 'fallback must have contributed rows').toBeGreaterThan(0);
    expect(ids.slice(1)).not.toContain(only);
  });

  it('REORDERS, never removes — the row count is identical to the flat OR', () => {
    // This is the whole difference from the mandatory-error-term form, which was
    // measured on the live DB at −22.4% rows and 21.5% of cases injecting nothing,
    // concentrated in small projects. A future edit that turns the primary query into a
    // filter breaks this case rather than shipping that silently.
    const { db } = seed();
    const now = Date.now();
    const flat = withRerank('off', () => select(db, { now }));
    const out = select(db, { now });
    expect(out.rows.length).toBe(flat.rows.length);
    expect(out.rows.length).toBeGreaterThan(1);
  });

  it('falls back to the flat order when NOTHING in the project mentions the failure', () => {
    // The residual case, and the reason the rerank cannot silence a project the way a
    // floor can: with no error-matching row anywhere, the primary is empty and the
    // fallback returns the flat result byte for byte.
    const db = new Database(':memory:');
    initSchema(db);
    db.prepare(SESSION_INSERT_SQL).run(PROJECT, Date.now());
    for (let i = 0; i < 3; i++) {
      insertObs(db, { title: `npm build note ${i}`, text: `npm run build cadence ${i}`, ageDays: 1 + i });
    }
    const now = Date.now();
    const on = select(db, { now });
    const off = withRerank('off', () => select(db, { now }));
    expect(on.rows.length, 'must not silence a project that has no error-matching row').toBeGreaterThan(0);
    expect(on.rows.map((r) => r.id)).toEqual(off.rows.map((r) => r.id));
  });

  it('a pathological limit cannot turn the rerank into a filter', () => {
    // The rerank's control flow and the SQL's `LIMIT` must agree about the cap. They read
    // the same argument, and the SQL sanitizes it — so comparing against the RAW value
    // made `limit: 0` short-circuit the fallback, i.e. the rerank became the filter this
    // face rejected, while the SQL had already fallen back to 3. Found by fuzzing in
    // review; unreachable from the hook (it passes no limit), which is exactly why it
    // needs a test rather than a reader.
    const { db } = seed();
    const now = Date.now();
    for (const bad of [0, -1, null, 0.5, NaN, Infinity]) {
      const on = select(db, { now, limit: bad });
      const off = withRerank('off', () => select(db, { now, limit: bad }));
      expect(on.rows.length, `limit=${String(bad)}: rerank changed the row count`).toBe(off.rows.length);
      expect(on.rows.length, `limit=${String(bad)}: must fall back to the default cap`).toBe(
        ERROR_RECALL_LIMIT,
      );
    }
  });

  it('the kill-switch is honoured and only "off" disables it', () => {
    const { db, decoys } = seed();
    const now = Date.now();
    expect(withRerank('off', () => select(db, { now })).rows[0].id).toBe(decoys.cmdOnly);
    expect(withRerank('OFF', () => select(db, { now })).rows[0].id, 'case-insensitive').toBe(decoys.cmdOnly);
    // Anything else — including junk — leaves the measured default in place, rather
    // than a typo silently reverting the surface.
    for (const v of [undefined, '', 'on', 'yes', 'false', '0']) {
      expect(withRerank(v, () => select(db, { now })).rows[0].id, `value=${String(v)}`).not.toBe(
        decoys.cmdOnly,
      );
    }
  });

  it('reports the expression that actually ranked the set', () => {
    const { db } = seed();
    const out = select(db);
    expect(out.errorFirstQuery, 'the error-first expression must be reported when it ran').toBeTruthy();
    // Command words stay in the expression so bm25 keeps summing them — dropping them
    // was measured in D#136 and regressed two of five live replays.
    expect(out.errorFirstQuery).toContain('"npm"');
    expect(out.errorFirstQuery).toContain('"enoent"');
    expect(out.errorFirstQuery).toMatch(/\)\s*AND\s*\(/);
    expect(
      withRerank('off', () => select(db)).errorFirstQuery,
      'and it must be null when the rerank did not run',
    ).toBeNull();
  });
});
