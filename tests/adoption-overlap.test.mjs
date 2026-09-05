// Task 7 (offline benchmark, 2026-07-05): end-to-end wiring test for
// computeAdoption — replay (T4) -> rankers (T6) -> dual-channel cosine (T3)
// -> cluster-bootstrap/RDD estimator (T5), aggregated per `surface:channel`
// bucket.
//
// NOTE: observations.memory_session_id is NOT NULL with an FK to sdk_sessions
// (schema.mjs) — insertSession() must run first (known gotcha, carried from
// Tasks 1-2/6's own tests: tests/adoption-imperative-rank.test.mjs,
// tests/adoption-searchbyfts-snapshot.test.mjs, tests/adoption-rankers.test.mjs).
// The plan's original seed() snippet omits this and fails the NOT NULL
// constraint.
//
// NOTE 2: adoption-replay.mjs's ID_RE is 2-7 digits — a single-digit id like `(#1)` (as
// in the plan's illustrative fixture) extracts ZERO ids, so extractInjectionEvents
// silently drops the event (surface is set internally but injected.length === 0 fails the
// push guard). Every fixture below uses a realistic multi-digit observation id.
// The caliber is no longer a literal in that file: as of v3.80.0 it comes from
// `unanchoredInjectedIdRe()` in lib/citation-tracker.mjs, and it is 2-7 rather than the
// numerator's 1-7 ON PURPOSE — `ids()` there feeds an INJECTED set from unanchored prose,
// where a `#1` is a false positive by construction. Read that docblock before widening it;
// this round already widened it once and a pre-tag review caught two prose ids entering
// the denominator on a real transcript.
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { computeAdoption, floorCheck, emitLabels, scoreLabels } from '../benchmark/adoption-overlap.mjs';

// Sandbox-artifact disposal: this file is the creating task for every
// mkdtempSync'd fixture dir below, so it deletes them on exit too (own
// responsibility regardless of what sibling adoption-*.test.mjs fixtures do).
const createdDirs = [];
function tmpFixtureDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (createdDirs.length) rmSync(createdDirs.pop(), { recursive: true, force: true });
});

function seed(db, rows) {
  insertSession(db, { id: 'mem-s1', project: 'p' });
  const ins = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, lesson_learned, importance, created_at, created_at_epoch)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows)
    ins.run(
      'mem-s1',
      'p',
      'bugfix',
      r.title,
      r.lesson,
      r.importance ?? 2,
      new Date(r.epoch).toISOString(),
      r.epoch,
    );
}

// promptText/actionText default to the original hardcoded literals -- existing
// call sites (5-arg) are byte-identical; Task 8's placebo-cutoff test is the
// only caller that overrides them (needs per-session prompt/action content to
// control which observations each session's ranker matches). Task 9's cite-
// check fix adds an optional 8th `citedProse` param -- when set, prepends a
// `type: 'text'` content block to the assistant's turn so its OWN prose (not
// just the tool_use action) carries the given string; existing 5/6/7-arg call
// sites are unaffected (defaults to null -- no text block, byte-identical
// assistant-content array to before).
function writeTranscript(
  dir,
  name,
  sessionId,
  ts,
  injectedMarkerLine,
  promptText = 'fix rrfAccumulate merge dedup',
  actionText = 'const r = rrfAccumulate(a, b); // merge dedup',
  citedProse = null,
) {
  const assistantContent = [{ type: 'tool_use', name: 'Edit', input: { new_string: actionText } }];
  if (citedProse) assistantContent.unshift({ type: 'text', text: citedProse });
  writeFileSync(
    join(dir, name),
    [
      { type: 'user', sessionId, timestamp: ts, message: { role: 'user', content: promptText } },
      { sessionId, timestamp: ts, attachment: { hookName: 'UserPromptSubmit', content: injectedMarkerLine } },
      {
        type: 'assistant',
        sessionId,
        timestamp: ts,
        message: { role: 'assistant', content: assistantContent },
      },
      { type: 'user', sessionId, timestamp: ts, message: { role: 'user', content: 'ok' } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  );
}

// Task 8: factored out of the first e2e test so the placebo-random null-control
// test (below) can reuse the EXACT same fixture -- same DB pool ('rrfAccumulate'
// the real match + 'unrelated' filler), same single-session transcript. Reusing
// it (rather than a fresh one) is what makes the placebo-random test a genuine
// regression check: this fixture is proven (by the first test) to produce a
// strictly-positive real effect, so if the placebo swap were ever a no-op, this
// same fixture would reproduce that positive effect under `placebo: 'random'`
// and fail the CI-brackets-0 assertion.
function makeE2EFixture() {
  const db = createTestDb();
  seed(db, [
    {
      title: 'rrfAccumulate',
      lesson: 'call rrfAccumulate for merge dedup',
      importance: 3,
      epoch: 1_700_000_000_000,
    },
    {
      title: 'unrelated',
      lesson: 'validate VAR before rm in shell scripts',
      importance: 2,
      epoch: 1_700_000_100_000,
    },
  ]);
  const ts = '2026-07-01T00:00:00.000Z';
  const dir = tmpFixtureDir('adopt-e2e-');
  writeTranscript(
    dir,
    's1.jsonl',
    's1',
    ts,
    'Memory — a past lesson applies to THIS task. You must: call rrfAccumulate for merge dedup (#42)',
  );
  return { db, dir };
}

describe('computeAdoption end-to-end', () => {
  it('produces a per-bucket effect (cluster-bootstrap mean) + ci95 + rdd_jump, keyed consistently', () => {
    const { db, dir } = makeE2EFixture();
    const res = computeAdoption(dir, db, { start: 0, end: Date.now() + 1e12, project: 'p', m: 3 });
    const actionBucket = res.perBucket.find((b) => b.surface === 'imperative' && b.channel === 'action');
    expect(actionBucket).toBeTruthy();
    expect(actionBucket.nEvents).toBeGreaterThanOrEqual(1);
    expect(actionBucket.nSessions).toBe(1);
    expect(Array.isArray(actionBucket.ci95)).toBe(true);
    expect(actionBucket.ci95).toHaveLength(2);

    // Design refinement (supersedes the plan's `effect: jump`): effect is the
    // cluster-bootstrap MEAN of the per-event control-subtracted deltas
    // (cosShown - mean(cosNearMiss)) -- consistent with ci95, which comes from
    // the SAME clusterBootstrap call. rdd_jump is the secondary,
    // gradient-corrected RDD view, reported separately.
    expect(typeof actionBucket.effect).toBe('number');
    expect(typeof actionBucket.rdd_jump).toBe('number');
    expect(typeof actionBucket.mde).toBe('number');
    // sd is RMS-around-the-bucket's-OWN-mean (not raw RMS-around-zero), so it
    // can never be negative/NaN -- but for a single-event bucket (this
    // fixture) it IS exactly 0 (one point has zero deviation from its own
    // mean), so mde is 0 too. Assert finite + non-negative, not positive.
    expect(Number.isFinite(actionBucket.mde)).toBe(true);
    expect(actionBucket.mde).toBeGreaterThanOrEqual(0);

    // Realistic-signal check, not just a type check: the shown candidate's
    // lesson text ("merge dedup") overlaps the action window's code comment
    // ("// merge dedup"), so the action-channel effect must be strictly
    // positive -- a 0 or NaN "number" would pass a bare typeof check but
    // would mean the dual-channel wiring is broken.
    expect(actionBucket.effect).toBeGreaterThan(0);
  });

  it('emits a separate prose-channel bucket for the same event (dual-channel, not merged)', () => {
    const db = createTestDb();
    seed(db, [
      {
        title: 'rrfAccumulate',
        lesson: 'call rrfAccumulate for merge dedup',
        importance: 3,
        epoch: 1_700_000_000_000,
      },
    ]);
    const ts = '2026-07-01T00:00:00.000Z';
    const dir = tmpFixtureDir('adopt-e2e-');
    writeTranscript(
      dir,
      's1.jsonl',
      's1',
      ts,
      'Memory — a past lesson applies to THIS task. You must: call rrfAccumulate for merge dedup (#77)',
    );

    const res = computeAdoption(dir, db, { start: 0, end: Date.now() + 1e12, project: 'p', m: 3 });
    const proseBucket = res.perBucket.find((b) => b.surface === 'imperative' && b.channel === 'prose');
    const actionBucket = res.perBucket.find((b) => b.surface === 'imperative' && b.channel === 'action');
    expect(proseBucket).toBeTruthy();
    expect(actionBucket).toBeTruthy();
    // This fixture's output window has no assistant prose (Edit-only turn) --
    // the prose channel's bag is empty, so its cosine (and therefore effect)
    // is 0, distinct from the action channel's positive signal.
    expect(proseBucket.effect).toBe(0);
    expect(actionBucket.effect).toBeGreaterThan(0);
  });

  it('skips coverage-loss events (no shown candidate) instead of crashing on an empty shown[]', () => {
    const db = createTestDb();
    insertSession(db, { id: 'mem-s2', project: 'p' }); // no observations seeded
    const ts = '2026-07-01T00:00:00.000Z';
    const dir = tmpFixtureDir('adopt-e2e-');
    writeTranscript(
      dir,
      's2.jsonl',
      's2',
      ts,
      'Memory — a past lesson applies to THIS task. You must: call zzqqNoMatch (#99)',
    );

    const res = computeAdoption(dir, db, { start: 0, end: Date.now() + 1e12, project: 'p', m: 3 });
    expect(res.perBucket).toEqual([]);
  });
});

// Task 8 (2026-07-05): null controls. Both placebos target the PRIMARY
// `effect`/`ci95` and SECONDARY `rdd_jump` fields differently -- see
// adoption-overlap.mjs's DESIGN REFINEMENT comment for why the two fields
// exist. A real signal that survives a placebo would mean the estimator is
// picking up noise/leakage, not genuine adoption.
describe('computeAdoption null controls (placebo)', () => {
  it('placebo-random (null control): swapping candidate text for a random DB lesson collapses the PRIMARY effect to a CI that brackets 0', () => {
    // Reuses test 1's exact fixture (proven above to produce a strictly-positive
    // real effect) -- see makeE2EFixture's comment for why this specific reuse
    // makes the test a genuine regression check rather than a vacuous one.
    //
    // Empirically verified (not just asserted on faith): this fixture has one
    // session (K=1 cluster), so clusterBootstrap's resampled mean is a single
    // point [v, v] -- every bootstrap draw resamples the same lone cluster, so
    // there is no spread. For the CI to bracket 0 here, v itself must be
    // exactly 0. It is: the seeded lcg(sessionId+':'+ts) pick lands on the
    // 'unrelated' filler lesson (zero token overlap with the action window's
    // "// merge dedup" comment) rather than the real 'rrfAccumulate' match, so
    // cosShown collapses to 0 for both channels. This is deterministic (seeded,
    // no Math.random) -- reproducible every run, not a flaky coin flip.
    const { db, dir } = makeE2EFixture();
    const res = computeAdoption(dir, db, {
      start: 0,
      end: Date.now() + 1e12,
      project: 'p',
      m: 3,
      placebo: 'random',
    });
    expect(res.perBucket.length).toBeGreaterThan(0); // guard: a vacuous empty loop would trivially satisfy the assertions below
    for (const b of res.perBucket) {
      expect(b.ci95[0]).toBeLessThanOrEqual(0);
      expect(b.ci95[1]).toBeGreaterThanOrEqual(0);
    }
  });

  it('placebo-cutoff (null control): relabeling shown/near-miss at the median running-var weakens rdd_jump while leaving effect/ci95 untouched', () => {
    const db = createTestDb();
    seed(db, [
      // Session sA's pair: LOW absolute score magnitude (importance*overlap = 3 vs 1).
      {
        title: 'rrfAccumulateAlphaX',
        lesson: 'rrfAccumulateAlphaX rrfAccumulateAlphaX is the strong primary path always',
        importance: 3,
        epoch: 1_700_000_000_000,
      },
      {
        title: 'helperBetaGammaX',
        lesson: 'helperBetaGammaX is a rarely used fallback',
        importance: 1,
        epoch: 1_700_000_000_000,
      },
      // Session sB's pair: HIGH absolute score magnitude (5 vs 4), both well above
      // sA's pair -- so the GLOBAL median (across both sessions) falls BETWEEN
      // sA's and sB's own pairs, misgrouping relative to the true (session-local)
      // shown/near-miss boundary instead of just reproducing it.
      {
        title: 'widgetDeltaOneX',
        lesson: 'widgetDeltaOneX widgetDeltaOneX is the strong primary path always',
        importance: 5,
        epoch: 1_700_000_000_000,
      },
      {
        title: 'widgetDeltaTwoX',
        lesson: 'widgetDeltaTwoX is a rarely used fallback',
        importance: 4,
        epoch: 1_700_000_000_000,
      },
    ]);
    const dir = tmpFixtureDir('adopt-e2e-');
    writeTranscript(
      dir,
      'sA.jsonl',
      'sA',
      '2026-07-01T00:00:00.000Z',
      'Memory — a past lesson applies to THIS task. You must: rrfAccumulateAlphaX rrfAccumulateAlphaX is the strong primary path always (#101)',
      'fix rrfAccumulateAlphaX and helperBetaGammaX now',
      'Applied rrfAccumulateAlphaX rrfAccumulateAlphaX is the strong primary path always as guidance.',
    );
    writeTranscript(
      dir,
      'sB.jsonl',
      'sB',
      '2026-07-01T01:00:00.000Z',
      'Memory — a past lesson applies to THIS task. You must: widgetDeltaOneX widgetDeltaOneX is the strong primary path always (#202)',
      'fix widgetDeltaOneX and widgetDeltaTwoX now',
      'Applied widgetDeltaOneX widgetDeltaOneX is the strong primary path always as guidance.',
    );

    const opts = { start: 0, end: Date.now() + 1e12, project: 'p', m: 3 };
    const real = computeAdoption(dir, db, opts);
    const placebo = computeAdoption(dir, db, { ...opts, placebo: 'cutoff' });
    const realBucket = real.perBucket.find((b) => b.surface === 'imperative' && b.channel === 'action');
    const placeboBucket = placebo.perBucket.find((b) => b.surface === 'imperative' && b.channel === 'action');
    expect(realBucket).toBeTruthy();
    expect(placeboBucket).toBeTruthy();

    // The real (session-local) shown/near-miss boundary finds a genuine jump.
    expect(Math.abs(realBucket.rdd_jump)).toBeGreaterThan(0.5);
    // Falsification: relabeling at the (session-blind) global median weakens
    // the detected jump relative to the real, causally-grounded boundary --
    // exactly what "a sound estimator finds a smaller/decorrelated jump at a
    // non-treatment boundary" means. This is a relative (not absolute-near-0)
    // assertion: `localLinearRdd`'s 2-point-per-side OLS extrapolates to
    // x=cutoff=0, which is outside this fixture's data range, so the residual
    // magnitude after relabeling is not itself pinned to 0 -- but it is
    // reliably SMALLER than the real jump (verified empirically, deterministic
    // since no randomness is involved in the cutoff placebo).
    expect(Math.abs(placeboBucket.rdd_jump)).toBeLessThan(Math.abs(realBucket.rdd_jump));

    // PRIMARY effect/ci95 come from `perEvent` (the actual shown/near-miss
    // cosine delta), independent of the points'/cutoff's shown-relabeling --
    // must be byte-identical between the real and placebo-cutoff runs.
    expect(placeboBucket.effect).toBe(realBucket.effect);
    expect(placeboBucket.ci95).toEqual(realBucket.ci95);
  });
});

// Task 9 (2026-07-05): cite-recall floor check + hand-label harness.
//
// DESIGN RESOLUTION (supersedes the task-9 brief's `perEventDeltas` helper):
// the brief built a PER-EVENT IDF (`buildIdf([outputWindow.actions, ...shown,
// ...nearMiss])`) for floorCheck/emitLabels. That IDF is NOT the one
// computeAdoption's perBucket effects are built from -- computeAdoption
// builds ONE run-wide IDF over the whole corpus (see its own file-header
// comment: "per-event IDF would make cosine scores incomparable across
// events"). A floor/label harness scored against a per-event IDF would
// validate a DIFFERENT number than the metric actually reported. So
// computeAdoption gained a `collectEvents` option that reuses its existing
// per-event loop (and its existing run-wide `idf`) to also emit per-event
// records -- floorCheck/emitLabels/scoreLabels consume THAT, never building
// their own IDF.
describe('computeAdoption collectEvents (Task 9 extension)', () => {
  it('defaults to false -- default return is byte-identical to pre-Task-9 shape (no `events` key)', () => {
    const { db, dir } = makeE2EFixture();
    const res = computeAdoption(dir, db, { start: 0, end: Date.now() + 1e12, project: 'p', m: 3 });
    expect(res.events).toBeUndefined();
    expect(Object.keys(res)).toEqual(['perBucket']);
  });

  it('collectEvents:true exposes the SAME run-wide-IDF action-channel delta the action bucket reports -- not a per-event-IDF recompute', () => {
    const { db, dir } = makeE2EFixture();
    const res = computeAdoption(dir, db, {
      start: 0,
      end: Date.now() + 1e12,
      project: 'p',
      m: 3,
      collectEvents: true,
    });
    const actionBucket = res.perBucket.find((b) => b.surface === 'imperative' && b.channel === 'action');
    expect(Array.isArray(res.events)).toBe(true);
    expect(res.events).toHaveLength(1);
    const row = res.events[0];
    expect(row.surface).toBe('imperative');
    // This fixture has exactly ONE event in the imperative:action bucket, so
    // the bucket's cluster-bootstrap `effect` (a mean) reduces to that one
    // event's own value -- if collectEvents built a per-event IDF instead of
    // reusing the run-wide one, this cosine would differ numerically from
    // the bucket's, and this equality would fail.
    expect(row.actionDelta).toBe(actionBucket.effect);
    expect(row.actionDelta).toBeGreaterThan(0); // sanity: not a degenerate 0/NaN
    expect(row).toHaveProperty('cited');
    expect(row).toHaveProperty('spec');
    expect(['low', 'high']).toContain(row.spec);
    expect(row).toHaveProperty('query');
    expect(row).toHaveProperty('lessonText');
    expect(row).toHaveProperty('outputActions');
    expect(row).toHaveProperty('outputProse');
  });
});

describe('floorCheck / emitLabels / scoreLabels (Task 9)', () => {
  it('floorCheck partitions events by cite status, each with numeric effect + n', () => {
    const { db, dir } = makeE2EFixture();
    const result = floorCheck(dir, db, { start: 0, end: Date.now() + 1e12, project: 'p', m: 3 });
    expect(typeof result.citePositive.effect).toBe('number');
    expect(typeof result.citePositive.n).toBe('number');
    expect(typeof result.citeSilent.effect).toBe('number');
    expect(typeof result.citeSilent.n).toBe('number');
    // Partition is exhaustive over the run's events (1 event in this fixture).
    expect(result.citePositive.n + result.citeSilent.n).toBe(1);
    // Fixed cite check (see benchmark/adoption-overlap.mjs's Task 9 fix
    // comment): tests the id against the SESSION's assistant-PROSE-ONLY
    // corpus, never the raw file/attachment. makeE2EFixture's assistant turn
    // is Edit-only (no `text` block), so "#42" never appears in assistant
    // prose here -- correctly citeSilent now. (Pre-fix, the whole-file check
    // matched the injection attachment's own "(#42)" text and mislabeled
    // this citePositive -- exactly the tautology the fix corrects; see the
    // next test for the non-vacuous contrast proof.)
    expect(result.citePositive).toEqual({ effect: 0, n: 0 });
    expect(result.citeSilent).toEqual({ effect: expect.any(Number), n: 1 });
  });

  it('floorCheck contrast is non-vacuous: a session whose assistant later writes the injected id in its own prose is citePositive, a session that never does is citeSilent', () => {
    // Regression guard for the Task 9 tautology: under the OLD whole-raw-file
    // check, BOTH sessions below would be citePositive (each session's own
    // injection attachment always contains its own "(#NN)" verbatim), so
    // citeSilent.n would be 0 no matter what fixture was used -- the exact
    // vacuity this test proves is gone.
    const db = createTestDb();
    seed(db, [
      {
        title: 'rrfAccumulate',
        lesson: 'call rrfAccumulate for merge dedup',
        importance: 3,
        epoch: 1_700_000_000_000,
      },
    ]);
    const dir = tmpFixtureDir('adopt-floor-');
    // s1: assistant's own `text` block later writes "#42" -- cite-positive
    // under the fixed (assistant-prose-only) check.
    writeTranscript(
      dir,
      's1.jsonl',
      's1',
      '2026-07-01T00:00:00.000Z',
      'Memory — a past lesson applies to THIS task. You must: call rrfAccumulate for merge dedup (#42)',
      'fix rrfAccumulate merge dedup',
      'const r = rrfAccumulate(a, b); // merge dedup',
      'Applied the past lesson (#42) as guidance.',
    );
    // s2: assistant turn is Edit-only, no `text` block -- "#77" never appears
    // in ANY assistant prose in this session -- cite-silent.
    writeTranscript(
      dir,
      's2.jsonl',
      's2',
      '2026-07-01T01:00:00.000Z',
      'Memory — a past lesson applies to THIS task. You must: call rrfAccumulate for merge dedup (#77)',
    );

    const result = floorCheck(dir, db, { start: 0, end: Date.now() + 1e12, project: 'p', m: 3 });
    expect(result.citePositive.n).toBeGreaterThanOrEqual(1);
    expect(result.citeSilent.n).toBeGreaterThanOrEqual(1);
    expect(result.citePositive.n + result.citeSilent.n).toBe(2);
  });

  it('emitLabels writes N stratified rows with null labels', () => {
    const { db, dir } = makeE2EFixture();
    const outDir = tmpFixtureDir('adopt-labels-');
    const out = join(outDir, 'l.jsonl');
    const n = emitLabels(dir, db, { N: 1, out, start: 0, end: Date.now() + 1e12, project: 'p', m: 3 });
    expect(n).toBe(1);
    const rows = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty('label', null);
    expect(rows[0]).toHaveProperty('lessonText');
    expect(rows[0].surface).toBe('imperative');
    expect(typeof rows[0].delta).toBe('number');
  });

  it('emitLabels caps at the number of available events when N exceeds the corpus', () => {
    const { db, dir } = makeE2EFixture();
    const outDir = tmpFixtureDir('adopt-labels-');
    const out = join(outDir, 'l.jsonl');
    const n = emitLabels(dir, db, { N: 50, out, start: 0, end: Date.now() + 1e12, project: 'p', m: 3 });
    expect(n).toBe(1); // only 1 event exists in this fixture's corpus
  });

  it('scoreLabels: auc === 1 when every positive delta exceeds every negative delta', () => {
    const outDir = tmpFixtureDir('adopt-score-');
    const p = join(outDir, 'labels.jsonl');
    writeFileSync(
      p,
      [
        { delta: 0.9, label: 1 },
        { delta: 0.8, label: 1 },
        { delta: 0.2, label: 0 },
        { delta: 0.1, label: 0 },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    expect(scoreLabels(p)).toEqual({ auc: 1, nPos: 2, nNeg: 2 });
  });

  it('scoreLabels: auc === 0.5 when positive/negative deltas are symmetric (no separation)', () => {
    const outDir = tmpFixtureDir('adopt-score-');
    const p = join(outDir, 'labels.jsonl');
    writeFileSync(
      p,
      [
        { delta: 0.1, label: 1 },
        { delta: 0.5, label: 1 },
        { delta: 0.1, label: 0 },
        { delta: 0.5, label: 0 },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    expect(scoreLabels(p)).toEqual({ auc: 0.5, nPos: 2, nNeg: 2 });
  });

  it('scoreLabels excludes rows still carrying a null (un-hand-labeled) label', () => {
    const outDir = tmpFixtureDir('adopt-score-');
    const p = join(outDir, 'labels.jsonl');
    writeFileSync(
      p,
      [
        { delta: 0.9, label: 1 },
        { delta: 0.1, label: 0 },
        { delta: 0.5, label: null },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    expect(scoreLabels(p)).toEqual({ auc: 1, nPos: 1, nNeg: 1 });
  });
});
